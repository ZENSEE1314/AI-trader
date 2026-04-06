// ============================================================
// Refined Rule-Based SMC Trading Engine
//
// Checklist (ALL must pass):
//   1. Daily Bias    — Previous day candle direction
//   2. HTF Structure — 4H + 1H must align with daily bias
//   3. Key Levels    — Price at PDH/PDL or VWAP bands
//   4. Setup (15M)   — HL formed (bullish) or LH formed (bearish)
//   5. Entry (1M)    — HL confirmed → LONG, LH confirmed → SHORT
//   6. Risk          — 1% SL, trailing SL +1.2% on each gain
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');
const { confirmSignal } = require('./scalper-ai');

const REQUEST_TIMEOUT = 15000;
const TOP_N_COINS = 100;
const MIN_24H_VOLUME = 10_000_000;

const SL_PCT = 0.03;           // 3% initial SL (overridden by strategyConfig)
const TRAILING_STEP = 0.012;   // trail SL by 1.2% (overridden by strategyConfig)

// Swing lengths per timeframe (defaults, overridden by strategyConfig)
let SWING_LENGTHS = { '4h': 10, '1h': 10, '15m': 10, '1m': 5 };

// Strategy config loaded from DB (ai_versions best params)
let strategyConfig = null;
let strategyConfigLoadedAt = 0;
const STRATEGY_CONFIG_TTL = 120000; // 2 min cache

async function getStrategyConfig() {
  if (strategyConfig && Date.now() - strategyConfigLoadedAt < STRATEGY_CONFIG_TTL) return strategyConfig;
  try {
    const db = require('./db');
    const rows = await db.query('SELECT params FROM ai_versions ORDER BY id DESC LIMIT 1');
    if (rows.length && rows[0].params) {
      const p = typeof rows[0].params === 'string' ? JSON.parse(rows[0].params) : rows[0].params;
      strategyConfig = p;
      strategyConfigLoadedAt = Date.now();
      // Update swing lengths if provided
      if (p.swingLen4h) SWING_LENGTHS['4h'] = p.swingLen4h;
      if (p.swingLen1h) SWING_LENGTHS['1h'] = p.swingLen1h;
      if (p.swingLen15m) SWING_LENGTHS['15m'] = p.swingLen15m;
      if (p.swingLen1m) SWING_LENGTHS['1m'] = p.swingLen1m;
      bLog.ai(`Strategy config loaded: sw=${p.swingLen4h||10}/${p.swingLen1h||10}/${p.swingLen15m||10}/${p.swingLen1m||5} HTF:${p.requireBothHTF?'both':'either'} KL:${p.requireKeyLevel?'Y':'N'} 1m:${p.require1m?'Y':'N'}`);
      return p;
    }
  } catch (err) { bLog.error(`Failed to load strategy config: ${err.message}`); }
  return null;
}

// ── Fetch Helpers ────────────────────────────────────────────

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (res.ok) return res;
    } catch (_) {}
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

async function fetchKlines(symbol, interval, limit = 100) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;
  return res.json();
}

async function fetchTickers() {
  const res = await fetchWithRetry('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (!res) return [];
  return res.json();
}

// ── Swing Detection ─────────────────────────────────────────

function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const swings = [];
  let lastType = null;

  for (let i = len; i < klines.length - len; i++) {
    let isHigh = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) { isHigh = false; break; }
    }

    let isLow = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (lows[i] >= lows[i + j]) { isLow = false; break; }
    }

    if (isHigh && isLow) {
      const highDist = highs[i] - Math.max(highs[i - 1], highs[i + 1]);
      const lowDist = Math.min(lows[i - 1], lows[i + 1]) - lows[i];
      if (highDist > lowDist) isLow = false;
      else isHigh = false;
    }

    if (isHigh) {
      if (lastType === 'high') {
        const prev = swings[swings.length - 1];
        if (highs[i] > prev.price) {
          swings[swings.length - 1] = { type: 'high', index: i, price: highs[i], candle: klines[i] };
        }
      } else {
        swings.push({ type: 'high', index: i, price: highs[i], candle: klines[i] });
        lastType = 'high';
      }
    }

    if (isLow) {
      if (lastType === 'low') {
        const prev = swings[swings.length - 1];
        if (lows[i] < prev.price) {
          swings[swings.length - 1] = { type: 'low', index: i, price: lows[i], candle: klines[i] };
        }
      } else {
        swings.push({ type: 'low', index: i, price: lows[i], candle: klines[i] });
        lastType = 'low';
      }
    }
  }

  return swings;
}

// ── Market Structure Labels ─────────────────────────────────

function getStructure(klines, len) {
  const swings = detectSwings(klines, len);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');

  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const label = swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH';
    highLabels.push({ ...swingHighs[i], label });
  }

  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    const label = swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL';
    lowLabels.push({ ...swingLows[i], label });
  }

  const lastHigh = highLabels.length ? highLabels[highLabels.length - 1] : null;
  const lastLow = lowLabels.length ? lowLabels[lowLabels.length - 1] : null;

  let trend = 'neutral';
  if (lastHigh && lastLow) {
    const isBearish = lastHigh.label === 'LH' && lastLow.label === 'LL';
    const isBullish = lastHigh.label === 'HH' && lastLow.label === 'HL';
    if (isBearish) trend = 'bearish';
    else if (isBullish) trend = 'bullish';
    else if (lastHigh.label === 'LH') trend = 'bearish_lean';
    else if (lastLow.label === 'HL') trend = 'bullish_lean';
  }

  return {
    swings, swingHighs, swingLows, highLabels, lowLabels, lastHigh, lastLow, trend,
    hasLH: lastHigh?.label === 'LH',
    hasHL: lastLow?.label === 'HL',
    hasHH: lastHigh?.label === 'HH',
    hasLL: lastLow?.label === 'LL',
    label: `${lastHigh?.label || '--'}/${lastLow?.label || '--'}`,
  };
}

// ── Step 1: Daily Bias ──────────────────────────────────────
// Previous day candle: green = bullish, red = bearish

function getDailyBias(dailyKlines) {
  if (!dailyKlines || dailyKlines.length < 2) return null;
  // Previous completed day is second-to-last (last candle is today, still open)
  const prevDay = dailyKlines[dailyKlines.length - 2];
  const open = parseFloat(prevDay[1]);
  const close = parseFloat(prevDay[4]);
  const high = parseFloat(prevDay[2]);
  const low = parseFloat(prevDay[3]);
  const bodySize = Math.abs(close - open);
  const range = high - low;

  // Indecisive: body < 30% of total range (doji-like)
  const isIndecisive = range > 0 && (bodySize / range) < 0.3;

  if (isIndecisive) return { bias: 'indecisive', pdh: high, pdl: low };
  if (close > open) return { bias: 'bullish', pdh: high, pdl: low };
  return { bias: 'bearish', pdh: high, pdl: low };
}

// ── Step 3: VWAP with Standard Deviation Bands ──────────────

function calcVWAPBands(klines) {
  let cumVolume = 0;
  let cumTPV = 0;
  let cumTPV2 = 0;
  let currentDay = '';

  const values = [];

  for (let i = 0; i < klines.length; i++) {
    const ts = parseInt(klines[i][0]);
    const day = new Date(ts).toISOString().slice(0, 10);
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const close = parseFloat(klines[i][4]);
    const volume = parseFloat(klines[i][5]);

    if (day !== currentDay) {
      cumVolume = 0;
      cumTPV = 0;
      cumTPV2 = 0;
      currentDay = day;
    }

    const tp = (high + low + close) / 3;
    cumTPV += tp * volume;
    cumTPV2 += tp * tp * volume;
    cumVolume += volume;

    if (cumVolume > 0) {
      const vwap = cumTPV / cumVolume;
      const variance = (cumTPV2 / cumVolume) - (vwap * vwap);
      const sd = Math.sqrt(Math.max(0, variance));
      values.push({ vwap, upper: vwap + sd, lower: vwap - sd });
    } else {
      values.push({ vwap: close, upper: close, lower: close });
    }
  }

  return values;
}

// ── Step 3: Check if price is at key level ──────────────────

function isAtKeyLevel(price, pdh, pdl, vwapBands, direction, proximityOverride) {
  const PROXIMITY_PCT = proximityOverride || 0.003; // configurable proximity

  const nearPDH = Math.abs(price - pdh) / pdh < PROXIMITY_PCT;
  const nearPDL = Math.abs(price - pdl) / pdl < PROXIMITY_PCT;

  // Current VWAP bands (last value)
  const lastBand = vwapBands[vwapBands.length - 1];
  const nearUpperVWAP = Math.abs(price - lastBand.upper) / lastBand.upper < PROXIMITY_PCT;
  const nearLowerVWAP = Math.abs(price - lastBand.lower) / lastBand.lower < PROXIMITY_PCT;
  const nearVWAP = Math.abs(price - lastBand.vwap) / lastBand.vwap < PROXIMITY_PCT;

  // For LONG: price should be at lower VWAP band, PDL, or VWAP
  // For SHORT: price should be at upper VWAP band, PDH, or VWAP
  if (direction === 'LONG') {
    return { isAtLevel: nearLowerVWAP || nearPDL || nearVWAP,
             level: nearPDL ? 'PDL' : nearLowerVWAP ? 'VWAP-Lower' : nearVWAP ? 'VWAP' : 'none' };
  }
  return { isAtLevel: nearUpperVWAP || nearPDH || nearVWAP,
           level: nearPDH ? 'PDH' : nearUpperVWAP ? 'VWAP-Upper' : nearVWAP ? 'VWAP' : 'none' };
}

// ── Daily Stats ─────────────────────────────────────────────

// Daily stats tracked at engine level, but per-user loss limits are in cycle.js
const dailyStats = { date: '', trades: 0, consecutiveLosses: 0 };

function getTradingDay() {
  const now = new Date();
  const h = now.getHours();
  const d = new Date(now);
  if (h < 7) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function recordDailyTrade(isWin) {
  const tradingDay = getTradingDay();
  if (dailyStats.date !== tradingDay) {
    dailyStats.date = tradingDay;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }
  dailyStats.trades++;
  if (isWin) dailyStats.consecutiveLosses = 0;
  else dailyStats.consecutiveLosses++;
}

function checkDailyLimits() {
  // Per-user loss limits handled in cycle.js via key.max_consec_loss
  // Engine always scans — individual users get stopped by their own setting
  return { canTrade: true };
}

function isGoodTradingSession() {
  const utcH = new Date().getUTCHours();
  return !(utcH >= 4 && utcH <= 5);
}

// ── Analyze Single Coin (Full Checklist — config-driven) ───

async function analyzeLHHL(ticker, params, dailyBiasCache) {
  const symbol = ticker.symbol;
  const price = parseFloat(ticker.lastPrice);

  // Load optimized strategy params from DB
  const sc = await getStrategyConfig() || {};
  const INDECISIVE_THRESH = sc.indecisiveThresh || 0.3;
  const NEED_BOTH_HTF = sc.requireBothHTF !== undefined ? !!sc.requireBothHTF : false;
  const NEED_KL = sc.requireKeyLevel !== undefined ? !!sc.requireKeyLevel : false;
  const NEED_15M = sc.require15m !== undefined ? !!sc.require15m : true;
  const NEED_1M = sc.require1m !== undefined ? !!sc.require1m : true;
  const NEED_VOL = sc.requireVolSpike !== undefined ? !!sc.requireVolSpike : false;
  const VOL_MULT = sc.volSpikeMultiplier || 1.5;
  const KL_PROX = sc.keyLevelProximity || 0.005;
  const MAX_ENTRY_AGE = sc.maxEntryAge || 30;

  // Step 1: Daily Bias
  let dailyInfo = dailyBiasCache.get(symbol);
  if (!dailyInfo) {
    const dailyKlines = await fetchKlines(symbol, '1d', 3);
    if (!dailyKlines || dailyKlines.length < 2) return null;
    const prevDay = dailyKlines[dailyKlines.length - 2];
    const dOpen = parseFloat(prevDay[1]), dClose = parseFloat(prevDay[4]);
    const dHigh = parseFloat(prevDay[2]), dLow = parseFloat(prevDay[3]);
    const bodySize = Math.abs(dClose - dOpen), range = dHigh - dLow;
    const isIndecisive = range > 0 && (bodySize / range) < INDECISIVE_THRESH;
    dailyInfo = isIndecisive ? { bias: 'indecisive', pdh: dHigh, pdl: dLow }
      : dClose > dOpen ? { bias: 'bullish', pdh: dHigh, pdl: dLow }
      : { bias: 'bearish', pdh: dHigh, pdl: dLow };
    dailyBiasCache.set(symbol, dailyInfo);
  }

  if (!dailyInfo || dailyInfo.bias === 'indecisive') return null;

  const { bias, pdh, pdl } = dailyInfo;

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 2: HTF Structure (4H + 1H)                        │
  // └─────────────────────────────────────────────────────────┘
  const [klines4h, klines1h, klines15m, klines1m] = await Promise.all([
    fetchKlines(symbol, '4h', 100),
    fetchKlines(symbol, '1h', 100),
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '1m', 100),
  ]);

  if (!klines4h || !klines1h || !klines15m || !klines1m) return null;
  if (klines4h.length < 30 || klines1h.length < 30 || klines15m.length < 30 || klines1m.length < 15) return null;

  const struct4h = getStructure(klines4h, SWING_LENGTHS['4h']);
  const struct1h = getStructure(klines1h, SWING_LENGTHS['1h']);
  const struct15m = getStructure(klines15m, SWING_LENGTHS['15m']);
  const struct1m = getStructure(klines1m, SWING_LENGTHS['1m']);

  // HTF alignment: both or either based on optimized config
  const b4 = struct4h.trend === 'bullish' || struct4h.trend === 'bullish_lean';
  const b1 = struct1h.trend === 'bullish' || struct1h.trend === 'bullish_lean';
  const r4 = struct4h.trend === 'bearish' || struct4h.trend === 'bearish_lean';
  const r1 = struct1h.trend === 'bearish' || struct1h.trend === 'bearish_lean';

  // NOTE: Hard SMC rule — 4H structure blocks counter-trend trades regardless of settings.
  // LH on 4H blocks longs (bearish structure), HL on 4H blocks shorts (bullish structure).
  // This prevents counter-trend entries like longing into a downtrend bounce.
  if (bias === 'bullish' && struct4h.hasLH && !struct4h.hasHL) {
    bLog.scan(`${symbol}: 4H has LH (bearish) — blocks LONG even though daily bias is bullish`);
    return null;
  }
  if (bias === 'bearish' && struct4h.hasHL && !struct4h.hasLH) {
    bLog.scan(`${symbol}: 4H has HL (bullish) — blocks SHORT even though daily bias is bearish`);
    return null;
  }

  let direction = null;
  if (NEED_BOTH_HTF) {
    if (bias === 'bullish' && b4 && b1) direction = 'LONG';
    else if (bias === 'bearish' && r4 && r1) direction = 'SHORT';
  } else {
    if (bias === 'bullish' && (b4 || b1)) direction = 'LONG';
    else if (bias === 'bearish' && (r4 || r1)) direction = 'SHORT';
  }

  if (!direction) {
    bLog.scan(`${symbol}: bias=${bias} 4H=${struct4h.trend} 1H=${struct1h.trend} — HTF not aligned`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 3: Key Levels & VWAP Bands                        │
  // └─────────────────────────────────────────────────────────┘
  // Step 3: Key Levels (conditional based on config)
  let levelCheck = { isAtLevel: true, level: 'none' };
  if (NEED_KL) {
    const vwapBands = calcVWAPBands(klines15m);
    levelCheck = isAtKeyLevel(price, pdh, pdl, vwapBands, direction);
  }

  // Step 3b: Volume Spike (conditional)
  if (NEED_VOL) {
    const vols = klines15m.slice(-20).map(k => parseFloat(k[5]));
    const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
    if (avg > 0 && (vols.slice(-5).reduce((a, b) => a + b, 0) / 5) / avg < VOL_MULT) {
      bLog.scan(`${symbol}: ${direction} no volume spike`);
      return null;
    }
  }

  if (NEED_KL && !levelCheck.isAtLevel) {
    bLog.scan(`${symbol}: ${direction} bias OK but price not at key level (PDH/PDL/VWAP) — skipping`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 4: Setup TF (15M) — swing point formed            │
  // └─────────────────────────────────────────────────────────┘
  const has15mSetup = !NEED_15M || (direction === 'LONG' && struct15m.hasHL) ||
                      (direction === 'SHORT' && struct15m.hasLH);

  if (!has15mSetup) {
    bLog.scan(`${symbol}: ${direction} at ${levelCheck.level} but no 15M ${direction === 'LONG' ? 'HL' : 'LH'} — no setup`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 5: Entry TF (1M) — HL or LH confirmed             │
  // └─────────────────────────────────────────────────────────┘
  const has1mEntry = !NEED_1M || (direction === 'LONG' && struct1m.hasHL) ||
                     (direction === 'SHORT' && struct1m.hasLH);

  if (!has1mEntry) {
    bLog.scan(`${symbol}: ${direction} setup on 15M but no 1M ${direction === 'LONG' ? 'HL' : 'LH'} entry — waiting`);
    return null;
  }

  // Recency: 1M confirming swing must be fresh (config-driven)
  const MAX_CANDLE_AGE = NEED_1M ? MAX_ENTRY_AGE : 999;
  const lastCandleIdx = klines1m.length - 1;
  const entrySwing = direction === 'LONG' ? struct1m.lastLow : struct1m.lastHigh;
  if (!entrySwing) return null;

  if ((lastCandleIdx - entrySwing.index) > MAX_CANDLE_AGE) {
    bLog.scan(`${symbol}: 1M swing too old (${lastCandleIdx - entrySwing.index} candles) — stale`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 6: Risk Management                                 │
  // │ 1% SL, trailing SL moves +1.2% each time price gains   │
  // └─────────────────────────────────────────────────────────┘
  const BTC_ETH = new Set(['BTCUSDT', 'ETHUSDT']);
  const leverage = BTC_ETH.has(symbol) ? (params.LEV_BTC_ETH || 100) : (params.LEV_ALT || 20);

  const sl = direction === 'LONG' ? price * (1 - SL_PCT) : price * (1 + SL_PCT);
  const slDist = SL_PCT;
  // No fixed TP — trailing SL handles exit. Set tp far away so it never hits.
  const tp = direction === 'LONG' ? price * 1.50 : price * 0.50;

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 7: Pro Scalper AI Confirmation                     │
  // │ Composite oscillator (ADX+Momentum+Vol+Volume) + HMA    │
  // │ Strong signal in same direction = +3, conflicting = block│
  // └─────────────────────────────────────────────────────────┘
  const scalperResult = confirmSignal(klines15m, direction);
  if (!scalperResult.confirmed) {
    bLog.scan(`${symbol}: ${direction} blocked by Scalper AI — ${scalperResult.signal} (osc=${scalperResult.details?.oscillator})`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Score                                                    │
  // └─────────────────────────────────────────────────────────┘
  let score = 10;

  // Bonus: full HTF alignment
  if (struct4h.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 3;
  if (struct1h.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 2;

  // Bonus: at PDH/PDL (stronger than VWAP)
  if (levelCheck.level === 'PDH' || levelCheck.level === 'PDL') score += 2;

  // Bonus: Scalper AI confirmation (Strong Buy/Sell = +3, Early = +1)
  score += scalperResult.score;

  // AI modifier
  const setup = direction === 'LONG' ? 'REFINED_LONG' : 'REFINED_SHORT';
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, setup, direction);
  score = score * aiModifier;

  const scalperTag = scalperResult.signal !== 'No Signal' ? ` | Scalper=${scalperResult.signal}` : '';
  bLog.scan(
    `✅ ${symbol} ${direction} | bias=${bias} 4H=${struct4h.label} 1H=${struct1h.label} ` +
    `15M=${struct15m.label} 1M=${struct1m.label} | at=${levelCheck.level} | score=${Math.round(score)}${scalperTag}`
  );

  return {
    symbol,
    direction,
    price,
    lastPrice: price,
    sl,
    tp1: tp,
    tp2: tp,
    tp3: tp,
    trailingStep: TRAILING_STEP,
    slDist,
    leverage,
    score: Math.round(score * 10) / 10,
    setup,
    setupName: `${direction}-REFINED`,
    aiModifier: Math.round(aiModifier * 100) / 100,
    structure: {
      bias,
      tf4h: struct4h.label,
      tf1h: struct1h.label,
      tf15: struct15m.label,
      tf1: struct1m.label,
      trend4h: struct4h.trend,
      trend1h: struct1h.trend,
      level: levelCheck.level,
    },
    scalperAI: scalperResult.details ? {
      signal: scalperResult.signal,
      oscillator: scalperResult.details.oscillator,
      adx: scalperResult.details.adx,
      trendHMA: scalperResult.details.trendHMA,
      momentum: scalperResult.details.momentum,
    } : null,
  };
}

// ── Main Scan ────────────────────────────────────────────────

async function scanSMC(log, opts = {}) {
  const limits = checkDailyLimits();
  if (!limits.canTrade) {
    log(`Refined: ${limits.reason}. Stopped trading.`);
    bLog.scan(limits.reason);
    return [];
  }

  // Dead zone removed — trade 24/7

  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('Failed to fetch tickers'); return []; }

  const BLACKLIST = new Set([
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ]);

  // Only scan admin-approved tokens
  let approvedTokens = null;
  try {
    const db = require('./db');
    const rows = await db.query('SELECT symbol FROM global_token_settings WHERE enabled = true AND banned = false');
    if (rows.length > 0) {
      approvedTokens = new Set(rows.map(r => r.symbol));
      bLog.scan(`Admin approved tokens: ${approvedTokens.size}`);
    }
  } catch (err) {
    bLog.error(`Failed to load approved tokens: ${err.message}`);
  }

  const topCoins = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !BLACKLIST.has(t.symbol))
    .filter(t => approvedTokens ? approvedTokens.has(t.symbol) : true)
    .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, opts.topNCoins || TOP_N_COINS);

  const params = await aiLearner.getOptimalParams();
  const minScore = params.MIN_SCORE || 8;
  const dailyBiasCache = new Map();

  // BTC market filter: fetch BTC daily bias to block counter-trend alt trades
  let btcBias = null;
  try {
    const btcDaily = await fetchKlines('BTCUSDT', '1d', 3);
    if (btcDaily && btcDaily.length >= 2) {
      const prevDay = btcDaily[btcDaily.length - 2];
      const dOpen = parseFloat(prevDay[1]), dClose = parseFloat(prevDay[4]);
      btcBias = dClose > dOpen ? 'bullish' : dClose < dOpen ? 'bearish' : null;
      bLog.scan(`BTC market bias: ${btcBias || 'neutral'}`);
    }
  } catch (e) {
    bLog.error(`BTC bias fetch failed: ${e.message}`);
  }

  bLog.scan(`Refined scan: ${topCoins.length} coins | minScore=${minScore} | BTC=${btcBias || 'unknown'}`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;
  let skippedBtcFilter = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      continue;
    }

    const signal = await analyzeLHHL(ticker, params, dailyBiasCache);
    analyzed++;

    if (signal && signal.score >= minScore) {
      // BTC filter: block alt shorts when BTC is bull, block alt longs when BTC is bear
      const isAlt = signal.symbol !== 'BTCUSDT' && signal.symbol !== 'ETHUSDT';
      if (isAlt && btcBias) {
        if (btcBias === 'bullish' && signal.direction === 'SHORT') {
          bLog.scan(`${signal.symbol}: SHORT blocked — BTC is bullish, alts follow BTC`);
          skippedBtcFilter++;
          continue;
        }
        if (btcBias === 'bearish' && signal.direction === 'LONG') {
          bLog.scan(`${signal.symbol}: LONG blocked — BTC is bearish, alts follow BTC`);
          skippedBtcFilter++;
          continue;
        }
      }

      results.push(signal);
      bLog.scan(
        `SIGNAL: ${signal.symbol} ${signal.direction} | score=${signal.score} ` +
        `setup=${signal.setupName} at=${signal.structure.level} | ` +
        `SL=$${signal.sl.toFixed(4)} TP=$${signal.tp1.toFixed(4)} lev=${signal.leverage}x`
      );
    }

    await new Promise(r => setTimeout(r, 200));
  }

  if (skippedAI > 0) bLog.ai(`AI avoided ${skippedAI} coins`);
  if (skippedBtcFilter > 0) bLog.scan(`BTC filter blocked ${skippedBtcFilter} counter-trend alt signals`);
  bLog.scan(`Scan complete: ${analyzed} analyzed, ${results.length} signals`);

  if (!results.length) {
    bLog.scan('No signals — checklist not met on any coin.');
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3);
}

module.exports = {
  scanSMC,
  analyzeLHHL,
  recordDailyTrade,
  checkDailyLimits,
  isGoodTradingSession,
  detectSwings,
  SWING_LENGTHS,
};
