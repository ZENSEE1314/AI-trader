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

const REQUEST_TIMEOUT = 15000;
const TOP_N_COINS = 100;
const MIN_24H_VOLUME = 10_000_000;

const SL_PCT = 0.03;           // 3% initial SL
const TRAILING_STEP = 0.012;   // trail SL by 1.2% when price moves in favor

// Swing lengths per timeframe
const SWING_LENGTHS = { '4h': 10, '1h': 10, '15m': 10, '1m': 5 };

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

function isAtKeyLevel(price, pdh, pdl, vwapBands, direction) {
  const PROXIMITY_PCT = 0.003; // within 0.3% of level

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

// ── Analyze Single Coin (Full Checklist) ────────────────────

async function analyzeLHHL(ticker, params, dailyBiasCache) {
  const symbol = ticker.symbol;
  const price = parseFloat(ticker.lastPrice);

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 1: Daily Bias                                      │
  // └─────────────────────────────────────────────────────────┘
  let dailyInfo = dailyBiasCache.get(symbol);
  if (!dailyInfo) {
    const dailyKlines = await fetchKlines(symbol, '1d', 3);
    dailyInfo = getDailyBias(dailyKlines);
    if (dailyInfo) dailyBiasCache.set(symbol, dailyInfo);
  }

  if (!dailyInfo || dailyInfo.bias === 'indecisive') {
    return null; // no clear bias — skip
  }

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

  // HTF must align with daily bias
  const isBullishHTF = (struct4h.trend === 'bullish' || struct4h.trend === 'bullish_lean') &&
                       (struct1h.trend === 'bullish' || struct1h.trend === 'bullish_lean');
  const isBearishHTF = (struct4h.trend === 'bearish' || struct4h.trend === 'bearish_lean') &&
                       (struct1h.trend === 'bearish' || struct1h.trend === 'bearish_lean');

  let direction = null;
  if (bias === 'bullish' && isBullishHTF) direction = 'LONG';
  else if (bias === 'bearish' && isBearishHTF) direction = 'SHORT';

  if (!direction) {
    bLog.scan(`${symbol}: bias=${bias} 4H=${struct4h.trend} 1H=${struct1h.trend} — HTF not aligned`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 3: Key Levels & VWAP Bands                        │
  // └─────────────────────────────────────────────────────────┘
  const vwapBands = calcVWAPBands(klines15m);
  const levelCheck = isAtKeyLevel(price, pdh, pdl, vwapBands, direction);

  if (!levelCheck.isAtLevel) {
    bLog.scan(`${symbol}: ${direction} bias OK but price not at key level (PDH/PDL/VWAP) — skipping`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 4: Setup TF (15M) — swing point formed            │
  // └─────────────────────────────────────────────────────────┘
  const has15mSetup = (direction === 'LONG' && struct15m.hasHL) ||
                      (direction === 'SHORT' && struct15m.hasLH);

  if (!has15mSetup) {
    bLog.scan(`${symbol}: ${direction} at ${levelCheck.level} but no 15M ${direction === 'LONG' ? 'HL' : 'LH'} — no setup`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 5: Entry TF (1M) — HL or LH confirmed             │
  // └─────────────────────────────────────────────────────────┘
  const has1mEntry = (direction === 'LONG' && struct1m.hasHL) ||
                     (direction === 'SHORT' && struct1m.hasLH);

  if (!has1mEntry) {
    bLog.scan(`${symbol}: ${direction} setup on 15M but no 1M ${direction === 'LONG' ? 'HL' : 'LH'} entry — waiting`);
    return null;
  }

  // Recency: 1M confirming swing must be fresh
  const MAX_CANDLE_AGE = SWING_LENGTHS['1m'] + 20;
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
  // │ Score                                                    │
  // └─────────────────────────────────────────────────────────┘
  let score = 10;

  // Bonus: full HTF alignment
  if (struct4h.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 3;
  if (struct1h.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 2;

  // Bonus: at PDH/PDL (stronger than VWAP)
  if (levelCheck.level === 'PDH' || levelCheck.level === 'PDL') score += 2;

  // AI modifier
  const setup = direction === 'LONG' ? 'REFINED_LONG' : 'REFINED_SHORT';
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, setup, direction);
  score = score * aiModifier;

  bLog.scan(
    `✅ ${symbol} ${direction} | bias=${bias} 4H=${struct4h.label} 1H=${struct1h.label} ` +
    `15M=${struct15m.label} 1M=${struct1m.label} | at=${levelCheck.level} | score=${Math.round(score)}`
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

  if (!isGoodTradingSession()) {
    const sessionW = await aiLearner.getSessionWeight();
    if (sessionW < 1.2) {
      log('Refined: Dead zone (UTC 4-5). Skipping.');
      bLog.scan('Dead zone hours. Waiting for volume.');
      return [];
    }
    bLog.ai(`AI override: session weight ${sessionW.toFixed(2)} > 1.2 — scanning in dead zone`);
  }

  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('Failed to fetch tickers'); return []; }

  const BLACKLIST = new Set([
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ]);

  const topCoins = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !BLACKLIST.has(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, opts.topNCoins || TOP_N_COINS);

  const params = await aiLearner.getOptimalParams();
  const minScore = params.MIN_SCORE || 8;
  const dailyBiasCache = new Map();

  bLog.scan(`Refined scan: ${topCoins.length} coins | RR=1:${RR_RATIO} MaxRisk=${MAX_RISK_PCT * 100}%`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      continue;
    }

    const signal = await analyzeLHHL(ticker, params, dailyBiasCache);
    analyzed++;

    if (signal && signal.score >= minScore) {
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
