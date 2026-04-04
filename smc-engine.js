// ============================================================
// Refined Rule-Based SMC Trading Engine
//
// Checklist (ALL must pass):
//   1. Daily Bias    — Previous day candle direction
//   2. HTF Structure — 15M trend must align with daily bias
//   3. Key Levels    — Price at PDH/PDL or VWAP bands
//   4. Setup (3M)    — HL formed (bullish) or LH formed (bearish)
//   5. Entry (1M)    — HL confirmed → LONG, LH confirmed → SHORT
//   6. Risk          — SL at 1M swing, 1:1.5 RR, max 3% risk
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');

const REQUEST_TIMEOUT = 15000;
const TOP_N_COINS = 100;
const MIN_24H_VOLUME = 10_000_000;

// Default risk: 1.5% SL (30% margin at 20x), 2.25% TP (45% margin at 20x)
// Overridden by AI params when available
const DEFAULT_SL_PCT = 0.015;
const DEFAULT_TP_PCT = 0.0225;

// Swing lengths per timeframe
const SWING_LENGTHS = { '15m': 10, '3m': 10, '1m': 5 };

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

// ── Daily Stats (resets at 7am) ─────────────────────────────
// Rule: 2 consecutive losses = stop trading for the day
// Win resets the consecutive loss counter
// E.g. W-W-W-L-W-L → ongoing (max consecutive losses = 1)
// E.g. W-L-L → STOP (2 consecutive losses)

const dailyStats = { date: '', trades: 0, consecutiveLosses: 0, lastResetHour: -1 };

function getTradingDay() {
  // Trading day resets at 7am
  const now = new Date();
  const h = now.getHours();
  const d = new Date(now);
  if (h < 7) d.setDate(d.getDate() - 1); // before 7am = still yesterday
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
  if (isWin) {
    dailyStats.consecutiveLosses = 0; // win resets the counter
  } else {
    dailyStats.consecutiveLosses++;
  }
}

function checkDailyLimits() {
  // Check if we've crossed 7am and need to reset
  const tradingDay = getTradingDay();
  if (dailyStats.date !== tradingDay) {
    dailyStats.date = tradingDay;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }

  // 5 consecutive losses = stop scanning for the day (per-user cooldown at 2 is in cycle.js)
  if (dailyStats.consecutiveLosses >= 5) {
    return { canTrade: false, reason: `${dailyStats.consecutiveLosses} consecutive losses — stopped for today. Resets at 7am.` };
  }
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

  // Validate daily bias with latest 4H candle — reject stale bias
  try {
    const klines4h = await fetchKlines(symbol, '4h', 3);
    if (klines4h && klines4h.length >= 2) {
      const last4h = klines4h[klines4h.length - 2]; // last completed 4H candle
      const open4h = parseFloat(last4h[1]);
      const close4h = parseFloat(last4h[4]);
      const is4hGreen = close4h > open4h;
      // If daily says bearish but last 4H is green (buyers stepping in), skip
      if (bias === 'bearish' && is4hGreen) {
        bLog.scan(`${symbol}: daily bearish but 4H green — bias conflict, skipping`);
        return null;
      }
      // If daily says bullish but last 4H is red (sellers stepping in), skip
      if (bias === 'bullish' && !is4hGreen) {
        bLog.scan(`${symbol}: daily bullish but 4H red — bias conflict, skipping`);
        return null;
      }
    }
  } catch { /* continue if 4H data unavailable */ }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 2: HTF Structure (15M + 3M)                       │
  // └─────────────────────────────────────────────────────────┘
  const [klines15m, klines3m, klines1m] = await Promise.all([
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '3m', 100),
    fetchKlines(symbol, '1m', 100),
  ]);

  if (!klines15m || !klines3m || !klines1m) return null;
  if (klines15m.length < 30 || klines3m.length < 30 || klines1m.length < 15) return null;

  const struct15m = getStructure(klines15m, SWING_LENGTHS['15m']);
  const struct3m = getStructure(klines3m, SWING_LENGTHS['3m']);
  const struct1m = getStructure(klines1m, SWING_LENGTHS['1m']);

  // HTF must align with daily bias — use 15M as the trend gate
  // Require strict trend (HH+HL or LH+LL), not lean variants (single swing)
  const isBullishHTF = struct15m.trend === 'bullish';
  const isBearishHTF = struct15m.trend === 'bearish';

  let direction = null;
  if (bias === 'bullish' && isBullishHTF) direction = 'LONG';
  else if (bias === 'bearish' && isBearishHTF) direction = 'SHORT';

  if (!direction) {
    bLog.scan(`${symbol}: bias=${bias} 15M=${struct15m.trend} — HTF not aligned (strict)`);
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
  // │ Step 4: Setup TF (3M) — swing point formed             │
  // └─────────────────────────────────────────────────────────┘
  const has3mSetup = (direction === 'LONG' && struct3m.hasHL) ||
                     (direction === 'SHORT' && struct3m.hasLH);

  if (!has3mSetup) {
    bLog.scan(`${symbol}: ${direction} at ${levelCheck.level} but no 3M ${direction === 'LONG' ? 'HL' : 'LH'} — no setup`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 5: Entry TF (1M) — HL or LH confirmed             │
  // └─────────────────────────────────────────────────────────┘
  const has1mEntry = (direction === 'LONG' && struct1m.hasHL) ||
                     (direction === 'SHORT' && struct1m.hasLH);

  if (!has1mEntry) {
    bLog.scan(`${symbol}: ${direction} setup on 3M but no 1M ${direction === 'LONG' ? 'HL' : 'LH'} entry — waiting`);
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
  // │ 10% margin, 1.5% SL (30% of margin at 20x),            │
  // │ 2.25% TP (45% of margin at 20x)                        │
  // └─────────────────────────────────────────────────────────┘
  const BTC_ETH = new Set(['BTCUSDT', 'ETHUSDT']);
  const leverage = BTC_ETH.has(symbol) ? Math.min(params.LEV_BTC_ETH || 20, 20) : Math.min(params.LEV_ALT || 20, 20);

  // AI-tuned TP/SL: convert margin-based % to price-move % using leverage
  // margin_pct / leverage = price_move_pct (e.g. 0.45 margin / 20x = 2.25% price)
  const baseTpPct = params.TP_MARGIN_PCT ? params.TP_MARGIN_PCT / leverage : DEFAULT_TP_PCT;
  const baseSlPct = params.SL_MARGIN_PCT ? params.SL_MARGIN_PCT / leverage : DEFAULT_SL_PCT;

  // Volume strength: compare last 5 candles avg volume vs last 20 candles avg
  const volumes1m = klines1m.map(k => parseFloat(k[5]));
  const recentVol = volumes1m.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVol = volumes1m.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol > 0 ? recentVol / avgVol : 1;

  let dynamicTP;
  let volLabel;
  if (volRatio >= 1.5) {
    dynamicTP = baseTpPct;           // full TP
    volLabel = 'STRONG';
  } else if (volRatio >= 0.8) {
    dynamicTP = baseTpPct * 0.67;    // ~67% of TP
    volLabel = 'NORMAL';
  } else {
    // Weak volume — skip entry entirely to avoid choppy market losses
    bLog.scan(`${symbol}: ${direction} setup valid but volume too weak (${volRatio.toFixed(2)}x avg) — skipping`);
    return null;
  }

  const sl = direction === 'LONG' ? price * (1 - baseSlPct) : price * (1 + baseSlPct);
  const tp = direction === 'LONG' ? price * (1 + dynamicTP) : price * (1 - dynamicTP);
  const slDist = baseSlPct;
  // ┌─────────────────────────────────────────────────────────┐
  // │ Score                                                    │
  // └─────────────────────────────────────────────────────────┘
  let score = 10;

  // Bonus: full HTF alignment (15M trend matches direction)
  if (struct15m.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 3;

  // Bonus: 3M also aligned (confirmation, not required)
  if (struct3m.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 2;

  // Bonus: at PDH/PDL (stronger than VWAP)
  if (levelCheck.level === 'PDH' || levelCheck.level === 'PDL') score += 2;

  // AI modifier
  const setup = direction === 'LONG' ? 'REFINED_LONG' : 'REFINED_SHORT';
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, setup, direction);
  score = score * aiModifier;

  bLog.scan(
    `✅ ${symbol} ${direction} | bias=${bias} 15M=${struct15m.label} 3M=${struct3m.label} ` +
    `1M=${struct1m.label} | at=${levelCheck.level} | score=${Math.round(score)}`
  );

  return {
    symbol,
    direction,
    price,
    lastPrice: price,
    sl,
    tp1: tp,
    tp2: direction === 'LONG' ? price + (price * tpDist * 1.2) : price - (price * tpDist * 1.2),
    tp3: direction === 'LONG' ? price + (price * tpDist * 1.5) : price - (price * tpDist * 1.5),
    slDist,
    leverage,
    score: Math.round(score * 10) / 10,
    setup,
    setupName: `${direction}-REFINED`,
    aiModifier: Math.round(aiModifier * 100) / 100,
    structure: {
      bias,
      tf15: struct15m.label,
      tf3: struct3m.label,
      tf1: struct1m.label,
      trend15m: struct15m.trend,
      trend3m: struct3m.trend,
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

  bLog.scan(`Refined scan: ${topCoins.length} coins | AI TP_margin=${(params.TP_MARGIN_PCT * 100).toFixed(0)}% SL_margin=${(params.SL_MARGIN_PCT * 100).toFixed(0)}% minScore=${minScore}`);

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
