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

const SL_PCT = 0.005;          // 0.5% price = 10% capital at 20x
const TP_PCT = 0.01;           // 1% price = 20% capital at 20x (RR 1:2)
const TRAILING_STEP = 0.012;   // trail SL by 1.2% after TP reached

// Swing lengths per timeframe (defaults, overridden by strategyConfig)
// Defaults match Quantum Optimizer v3.46 winning strategy (sw:6/7/14/4)
let SWING_LENGTHS = { '4h': 6, '1h': 7, '15m': 14, '3m': 5, '1m': 4 };

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

  // Minimum swing size: HL/LH must differ by at least 0.15% from previous swing
  // to filter out noise bounces in strong trends
  const MIN_SWING_PCT = 0.0015;

  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const diff = Math.abs(swingHighs[i].price - swingHighs[i - 1].price) / swingHighs[i - 1].price;
    const label = swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH';
    highLabels.push({ ...swingHighs[i], label, significant: diff >= MIN_SWING_PCT });
  }

  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    const diff = Math.abs(swingLows[i].price - swingLows[i - 1].price) / swingLows[i - 1].price;
    const label = swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL';
    lowLabels.push({ ...swingLows[i], label, significant: diff >= MIN_SWING_PCT });
  }

  // Only consider significant swings for direction decisions
  const sigHighs = highLabels.filter(h => h.significant);
  const sigLows = lowLabels.filter(l => l.significant);
  const lastHigh = sigHighs.length ? sigHighs[sigHighs.length - 1] : (highLabels.length ? highLabels[highLabels.length - 1] : null);
  const lastLow = sigLows.length ? sigLows[sigLows.length - 1] : (lowLabels.length ? lowLabels[lowLabels.length - 1] : null);

  let trend = 'neutral';
  if (lastHigh && lastLow) {
    const isBearish = lastHigh.label === 'LH' && lastLow.label === 'LL';
    const isBullish = lastHigh.label === 'HH' && lastLow.label === 'HL';
    if (isBearish) trend = 'bearish';
    else if (isBullish) trend = 'bullish';
    // NOTE: Mixed structures (LH+HL or HH+LL) stay 'neutral' — no trade.
    // Per SMC rules: HL blocks shorts, LH blocks longs. Mixed = indecisive.
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

async function analyzeLHHL(ticker, params, dailyBiasCache, kronosPredictions = null) {
  const symbol = ticker.symbol;
  const price = parseFloat(ticker.lastPrice);

  // Load AI-optimized strategy params from DB (set by Quantum Optimizer)
  const sc = await getStrategyConfig() || {};
  const NEED_DAILY = sc.requireDailyBias !== undefined ? !!sc.requireDailyBias : false;
  const NEED_BOTH_HTF = sc.requireBothHTF !== undefined ? !!sc.requireBothHTF : true;
  const NEED_KL = sc.requireKeyLevel !== undefined ? !!sc.requireKeyLevel : false;
  const NEED_15M = sc.require15m !== undefined ? !!sc.require15m : false;
  const NEED_1M = sc.require1m !== undefined ? !!sc.require1m : false;
  const NEED_VOL = sc.requireVolSpike !== undefined ? !!sc.requireVolSpike : false;
  const VOL_MULT = sc.volSpikeMultiplier || 1.5;
  const INDECISIVE_THRESH = sc.indecisiveThresh || 0.3;
  const KEY_LEVEL_PROX = sc.keyLevelProximity || 0.003;

  // ┌─────────────────────────────────────────────────────────┐
  // │ AI-Optimized Strategy: Daily → 4H+1H HTF → 15m → 1m    │
  // │ Direction from HTF structure (4H + 1H swing alignment)  │
  // │ Filters enabled/disabled by Quantum Optimizer results   │
  // │ SL/trailing unchanged — risk is user-configured         │
  // └─────────────────────────────────────────────────────────┘

  const [klinesDaily, klines4h, klines1h, klines15m, klines1m] = await Promise.all([
    fetchKlines(symbol, '1d', 10),
    fetchKlines(symbol, '4h', 60),
    fetchKlines(symbol, '1h', 60),
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '1m', 100),
  ]);

  if (!klines4h || !klines1h || !klines15m) return null;
  if (klines4h.length < 10 || klines1h.length < 10 || klines15m.length < 30) return null;

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 1: Daily Bias (optional — AI decides)              │
  // └─────────────────────────────────────────────────────────┘
  let dailyBias = null;
  let pdh = 0, pdl = 0;
  if (klinesDaily && klinesDaily.length >= 2) {
    const cached = dailyBiasCache.get(symbol);
    if (cached) {
      dailyBias = cached.bias;
      pdh = cached.pdh;
      pdl = cached.pdl;
    } else {
      const db = getDailyBias(klinesDaily);
      if (db) {
        dailyBias = db.bias === 'indecisive' ? null : db.bias;
        pdh = db.pdh;
        pdl = db.pdl;
        dailyBiasCache.set(symbol, { bias: dailyBias, pdh, pdl });
      }
    }
  }
  if (NEED_DAILY && !dailyBias) {
    bLog.scan(`${symbol}: no daily bias (indecisive) — skipped`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 2: HTF Structure — 4H + 1H swing alignment         │
  // │ This is the core direction engine (proven by optimizer)  │
  // └─────────────────────────────────────────────────────────┘
  const struct4h = getStructure(klines4h, SWING_LENGTHS['4h']);
  const struct1h = getStructure(klines1h, SWING_LENGTHS['1h']);

  const bull4h = struct4h.trend === 'bullish';
  const bull1h = struct1h.trend === 'bullish';
  const bear4h = struct4h.trend === 'bearish';
  const bear1h = struct1h.trend === 'bearish';

  let direction = null;
  if (NEED_DAILY && dailyBias) {
    if (NEED_BOTH_HTF) {
      if (dailyBias === 'bullish' && bull4h && bull1h) direction = 'LONG';
      else if (dailyBias === 'bearish' && bear4h && bear1h) direction = 'SHORT';
    } else {
      if (dailyBias === 'bullish' && (bull4h || bull1h)) direction = 'LONG';
      else if (dailyBias === 'bearish' && (bear4h || bear1h)) direction = 'SHORT';
    }
  } else {
    if (NEED_BOTH_HTF) {
      if (bull4h && bull1h) direction = 'LONG';
      else if (bear4h && bear1h) direction = 'SHORT';
    } else {
      if ((bull4h || bull1h) && !bear4h && !bear1h) direction = 'LONG';
      else if ((bear4h || bear1h) && !bull4h && !bull1h) direction = 'SHORT';
    }
  }

  if (!direction) {
    bLog.scan(`${symbol}: 4h=${struct4h.trend} 1h=${struct1h.trend} daily=${dailyBias || 'N/A'} — no HTF alignment`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 3: Key Level Filter (optional — AI decides)        │
  // └─────────────────────────────────────────────────────────┘
  if (NEED_KL && pdh > 0 && pdl > 0) {
    const vwapBands = calcVWAPBands(klines15m);
    const { isAtLevel, level } = isAtKeyLevel(price, pdh, pdl, vwapBands, direction, KEY_LEVEL_PROX);
    if (!isAtLevel) {
      bLog.scan(`${symbol}: ${direction} blocked — not at key level`);
      return null;
    }
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 4: 15m Structure Confirmation (optional — AI)       │
  // └─────────────────────────────────────────────────────────┘
  const struct15m = getStructure(klines15m, SWING_LENGTHS['15m']);
  if (NEED_15M) {
    if (direction === 'LONG' && !struct15m.hasHL) {
      bLog.scan(`${symbol}: LONG blocked — 15m has no HL confirmation`);
      return null;
    }
    if (direction === 'SHORT' && !struct15m.hasLH) {
      bLog.scan(`${symbol}: SHORT blocked — 15m has no LH confirmation`);
      return null;
    }
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 5: 1m Structure Confirmation (optional — AI)        │
  // └─────────────────────────────────────────────────────────┘
  let struct1m = null;
  if (klines1m && klines1m.length >= 15) {
    struct1m = getStructure(klines1m, SWING_LENGTHS['1m']);
    if (NEED_1M) {
      if (direction === 'LONG' && !struct1m.hasHL) {
        bLog.scan(`${symbol}: LONG blocked — 1m has no HL confirmation`);
        return null;
      }
      if (direction === 'SHORT' && !struct1m.hasLH) {
        bLog.scan(`${symbol}: SHORT blocked — 1m has no LH confirmation`);
        return null;
      }
    }
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 6: Volume Spike (optional — AI decides)            │
  // └─────────────────────────────────────────────────────────┘
  if (NEED_VOL) {
    const vols15 = klines15m.slice(-20).map(k => parseFloat(k[5]));
    const avgVol = vols15.reduce((a, b) => a + b, 0) / vols15.length;
    const recentAvg = vols15.slice(-5).reduce((a, b) => a + b, 0) / 5;
    if (avgVol > 0 && recentAvg / avgVol < VOL_MULT) {
      bLog.scan(`${symbol}: ${direction} no volume spike — ${(recentAvg/avgVol).toFixed(1)}x (need ${VOL_MULT}x)`);
      return null;
    }
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Safety Guards (always on — protect against bad entries)  │
  // └─────────────────────────────────────────────────────────┘

  // RSI Overbought/Oversold — don't chase extended moves
  {
    const closes15 = klines15m.slice(-15).map(k => parseFloat(k[4]));
    if (closes15.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = 1; i < closes15.length; i++) {
        const diff = closes15[i] - closes15[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const period = closes15.length - 1;
      const rs = (losses / period) > 0 ? (gains / period) / (losses / period) : 100;
      const rsi = 100 - (100 / (1 + rs));
      if (direction === 'LONG' && rsi > 78) {
        bLog.scan(`${symbol}: LONG blocked — 15m RSI ${rsi.toFixed(0)} overbought`);
        return null;
      }
      if (direction === 'SHORT' && rsi < 22) {
        bLog.scan(`${symbol}: SHORT blocked — 15m RSI ${rsi.toFixed(0)} oversold`);
        return null;
      }
    }
  }

  // Momentum Exhaustion — don't chase >1.5% moves in last 15 min
  if (klines1m && klines1m.length >= 10) {
    const recent = klines1m.slice(-15);
    const startPrice = parseFloat(recent[0][1]);
    const movePct = (price - startPrice) / startPrice;
    if (direction === 'LONG' && movePct > 0.025) {
      bLog.scan(`${symbol}: LONG blocked — already +${(movePct * 100).toFixed(1)}% in 15min (chasing)`);
      return null;
    }
    if (direction === 'SHORT' && movePct < -0.025) {
      bLog.scan(`${symbol}: SHORT blocked — already ${(movePct * 100).toFixed(1)}% in 15min (chasing)`);
      return null;
    }
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Risk Management: SL/TP scaled by leverage               │
  // │ Always risk 10% capital, target 20% capital (RR 1:2)    │
  // │ SL/trailing stay the same — user-configured             │
  // └─────────────────────────────────────────────────────────┘
  const BTC_ETH = new Set(['BTCUSDT', 'ETHUSDT']);
  const leverage = BTC_ETH.has(symbol) ? (params.LEV_BTC_ETH || 100) : (params.LEV_ALT || 20);

  const CAPITAL_SL = 0.10;
  const CAPITAL_TP = 0.20;
  const slPct = CAPITAL_SL / leverage;
  const tpPct = CAPITAL_TP / leverage;

  const sl = direction === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);
  const slDist = slPct;
  const tp = direction === 'LONG' ? price * (1 + tpPct) : price * (1 - tpPct);

  // ┌─────────────────────────────────────────────────────────┐
  // │ Pro Scalper AI — score modifier (not a gate)            │
  // └─────────────────────────────────────────────────────────┘
  const scalperResult = confirmSignal(klines15m, direction);
  // NOTE: Scalper AI no longer blocks trades outright — it adjusts score instead

  // ┌─────────────────────────────────────────────────────────┐
  // │ Score                                                    │
  // └─────────────────────────────────────────────────────────┘
  let score = 15; // Base score for HTF alignment

  // Bonus: strong trend confirmation on each TF
  if (struct4h.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 4;
  if (struct1h.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 3;
  if (struct15m.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 2;
  if (struct1m && struct1m.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 1;

  // Daily bias agreement bonus
  if (dailyBias === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 3;

  // Scalper AI bonus
  score += scalperResult.score;

  // Kronos AI prediction bonus/penalty
  let kronosData = null;
  if (kronosPredictions && kronosPredictions.has(symbol)) {
    kronosData = kronosPredictions.get(symbol);
    if (!kronosData.error) {
      if (kronosData.direction === direction) {
        const boost = kronosData.confidence === 'high' ? 5 : kronosData.confidence === 'medium' ? 3 : 1;
        score += boost;
        bLog.scan(`${symbol}: Kronos AGREES ${direction} (+${boost}) conf=${kronosData.confidence} ${kronosData.change_pct}%`);
      } else if (kronosData.direction !== 'NEUTRAL') {
        const penalty = kronosData.confidence === 'high' ? 6 : kronosData.confidence === 'medium' ? 3 : 1;
        score -= penalty;
        bLog.scan(`${symbol}: Kronos DISAGREES (${kronosData.direction} vs ${direction}) (-${penalty}) conf=${kronosData.confidence}`);
      }
    }
  }

  // AI modifier from learning history
  const setup = direction === 'LONG' ? 'HTF_LONG' : 'HTF_SHORT';
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, setup, direction);
  score = score * aiModifier;

  bLog.scan(
    `SIGNAL: ${symbol} ${direction} | 4h=${struct4h.trend} 1h=${struct1h.trend} 15m=${struct15m.label} ` +
    `| score=${Math.round(score)} | Scalper=${scalperResult.signal}` +
    (kronosData ? ` | Kronos=${kronosData.direction}(${kronosData.change_pct}%)` : '')
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
    setupName: `${direction}-HTF`,
    aiModifier: Math.round(aiModifier * 100) / 100,
    structure: {
      tf4h: struct4h.trend,
      tf1h: struct1h.trend,
      tf15: struct15m.label,
      tf1: struct1m ? struct1m.label : 'N/A',
    },
    scalperAI: scalperResult.details ? {
      signal: scalperResult.signal,
      oscillator: scalperResult.details.oscillator,
    } : null,
    kronos: kronosData ? {
      direction: kronosData.direction,
      change_pct: kronosData.change_pct,
      confidence: kronosData.confidence,
      trend: kronosData.trend,
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

  // Only skip banned tokens (no whitelist — trade everything)
  let bannedTokens = new Set();
  try {
    const db = require('./db');
    const rows = await db.query('SELECT symbol FROM global_token_settings WHERE banned = true');
    if (rows.length > 0) {
      bannedTokens = new Set(rows.map(r => r.symbol));
      bLog.scan(`Banned tokens: ${bannedTokens.size}`);
    }
  } catch (err) {
    bLog.error(`Failed to load banned tokens: ${err.message}`);
  }

  const topCoins = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !BLACKLIST.has(t.symbol))
    .filter(t => !bannedTokens.has(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, opts.topNCoins || TOP_N_COINS);

  const params = await aiLearner.getOptimalParams();
  const minScore = Math.min(params.MIN_SCORE || 5, 6); // cap at 6 to allow more trades
  const dailyBiasCache = new Map();

  bLog.scan(`Triple HL/LH scan: ${topCoins.length} coins | minScore=${minScore}`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      continue;
    }

    const signal = await analyzeLHHL(ticker, params, dailyBiasCache, opts.kronosPredictions || null);
    analyzed++;

    if (signal && signal.score >= minScore) {
      results.push(signal);
      bLog.scan(
        `SIGNAL: ${signal.symbol} ${signal.direction} | score=${signal.score} ` +
        `setup=${signal.setupName} | SL=$${signal.sl.toFixed(4)} TP=$${signal.tp1.toFixed(4)}`
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
