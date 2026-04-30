// ═══════════════════════════════════════════════════════════════
//  STRATEGY v3  —  MCT Trading Strategy (from PDF)
//  Strategy v2 is UNTOUCHED. This file is completely independent.
// ═══════════════════════════════════════════════════════════════
//
//  SOURCE: MCT Trading Strategy-1.pdf
//
//  THREE SETUPS:
//
//   Setup 1 — Break & Retest of Key Levels
//     Key levels: PDH, PDL, Opening Price (OP)
//     Price breaks a level, pulls back, retests it, shows rejection.
//     Confirmed by: rejection candle (wick > body) + volume spike.
//
//   Setup 2 — Liquidity Grab & Reversal (Smart Money)
//     Price spikes above/below a key level (stop hunt / false break),
//     then closes back inside. Enter in the reversal direction.
//     Confirmed by: close back inside + follow-through candle.
//
//   Setup 3 — VWAP Trend Following
//     In an uptrend (EMA9 > EMA21 on 15m), price pulls back to VWAP
//     and shows a bullish rejection → LONG.
//     In a downtrend (EMA9 < EMA21 on 15m), price retests VWAP from
//     below as resistance → SHORT.
//
//  BIAS FILTER (required for all setups):
//     Price > OP  AND within 1.5% of VWAP  →  LONG only
//     Price < OP  AND within 1.5% of VWAP  →  SHORT only
//     (1.5% tolerance allows pullback entries near VWAP, which is
//      where HL/LH setups naturally form)
//
//  NO SESSION FILTER — 24/7 scanning.
//
//  TRAILING SL (capital % based, leveraged):
//     Initial SL:    20 % of capital (margin)
//     Trail starts:  +21 % profit  →  SL locked at +20 %
//     Steps:         +31 %  → SL +30 %
//                    +41 %  → SL +40 %
//                    … every +10 % thereafter
//     Formula:       lockCapPct = floor(capitalPct × 10) / 10
//
//     Example — $100 margin, 20x leverage:
//       Profit $21 → SL at $20  (20 %)
//       Profit $31 → SL at $30  (30 %)
//       Profit $41 → SL at $40  (40 %)
//
// ═══════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

const REQUEST_TIMEOUT = 15_000;

// ── Fetch helpers ──────────────────────────────────────────────

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

// ── Key levels from klines ─────────────────────────────────────
//   PDH/PDL: previous UTC-day high/low (from 1h klines)
//   OP:      first 15m candle open of current UTC day

function extractKeyLevels(klines1h, klines15m) {
  if (!klines1h || klines1h.length < 2) return null;
  if (!klines15m || klines15m.length < 2) return null;

  const now = Date.now();
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  // PDH / PDL: max high / min low of candles that opened BEFORE today (yesterday's session)
  const yesterdayCandles = klines1h.filter(k => {
    const t = parseInt(k[0]);
    return t < todayMs && t >= todayMs - 48 * 60 * 60 * 1000;
  });

  if (yesterdayCandles.length === 0) return null;

  const pdh = Math.max(...yesterdayCandles.map(k => parseFloat(k[2])));
  const pdl = Math.min(...yesterdayCandles.map(k => parseFloat(k[3])));

  // OP: open price of the first 15m candle today (UTC midnight)
  const todayCandles15m = klines15m.filter(k => parseInt(k[0]) >= todayMs);
  if (todayCandles15m.length === 0) return null;
  todayCandles15m.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  const op = parseFloat(todayCandles15m[0][1]); // [1] = open

  return { pdh, pdl, op };
}

// ── Intraday VWAP (from today's 15m candles) ──────────────────

function calcVWAP(klines15m) {
  const now = Date.now();
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const todayK = klines15m.filter(k => parseInt(k[0]) >= todayMs);
  if (todayK.length === 0) {
    // Fallback: use last 32 bars as session proxy
    const slice = klines15m.slice(-32);
    let cumTPV = 0, cumVol = 0;
    for (const k of slice) {
      const tp = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
      const vol = parseFloat(k[5]);
      cumTPV += tp * vol;
      cumVol += vol;
    }
    return cumVol === 0 ? null : cumTPV / cumVol;
  }

  let cumTPV = 0, cumVol = 0;
  for (const k of todayK) {
    const tp = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
    const vol = parseFloat(k[5]);
    cumTPV += tp * vol;
    cumVol += vol;
  }
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ── EMA helper ────────────────────────────────────────────────

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

// ── Average volume helper ─────────────────────────────────────

function avgVolume(klines, lookback = 20) {
  const slice = klines.slice(-lookback - 1, -1); // exclude current forming candle
  if (slice.length === 0) return 0;
  return slice.reduce((s, k) => s + parseFloat(k[5]), 0) / slice.length;
}

// ── Rejection candle test ─────────────────────────────────────
//   Returns 'bullish' if bottom wick > body, 'bearish' if top wick > body.
//   At minimum: wick-to-body ratio >= 1.5.

function rejectionType(k) {
  const o = parseFloat(k[1]), h = parseFloat(k[2]);
  const l = parseFloat(k[3]), c = parseFloat(k[4]);
  const body    = Math.abs(c - o);
  const topWick = h - Math.max(o, c);
  const botWick = Math.min(o, c) - l;
  const minRatio = 1.5;
  const bullish = botWick > body * minRatio && botWick > topWick;
  const bearish = topWick > body * minRatio && topWick > botWick;
  if (bullish) return 'bullish';
  if (bearish) return 'bearish';
  return null;
}

// ── PROXIMITY check ──────────────────────────────────────────
//   Is `price` within `pct` (decimal) of `level`?

function near(price, level, pct = 0.003) {
  return Math.abs(price - level) / level <= pct;
}

// ── Setup 1: Break & Retest ───────────────────────────────────
//   Looks at last WINDOW 15m bars for: a break above/below a key level
//   followed by a pullback-retest with rejection + volume confirmation.

function detectBreakRetest(klines15m, levels, bias, price) {
  const WINDOW  = 30;
  const NEAR    = 0.005; // within 0.5 % of level
  const VOL_MUL = 1.3;   // volume spike threshold

  const slice = klines15m.slice(-WINDOW);
  const candleVolAvg = avgVolume(klines15m, 30);
  const lastCandle   = klines15m[klines15m.length - 1];
  const prevCandle   = klines15m[klines15m.length - 2];
  const lastVol      = parseFloat(lastCandle[5]);

  const keyLevs = [levels.pdh, levels.pdl, levels.op].filter(Boolean);

  for (const lv of keyLevs) {
    if (bias === 'long') {
      // Level was broken upward (some past candle closed above lv)
      const broke = slice.some(k => parseFloat(k[4]) > lv * 1.001);
      if (!broke) continue;
      // Current price is retesting (near lv from above)
      if (!near(price, lv, NEAR)) continue;
      // Rejection: bullish rejection candle on last or prev candle
      const rej = rejectionType(lastCandle) === 'bullish' ||
                  rejectionType(prevCandle) === 'bullish';
      if (!rej) continue;
      // Volume spike
      if (lastVol < candleVolAvg * VOL_MUL) continue;
      return { setupName: 'BreakRetest', level: lv, levelType: labelLevel(lv, levels) };
    } else {
      // Level was broken downward
      const broke = slice.some(k => parseFloat(k[4]) < lv * 0.999);
      if (!broke) continue;
      if (!near(price, lv, NEAR)) continue;
      const rej = rejectionType(lastCandle) === 'bearish' ||
                  rejectionType(prevCandle) === 'bearish';
      if (!rej) continue;
      if (lastVol < candleVolAvg * VOL_MUL) continue;
      return { setupName: 'BreakRetest', level: lv, levelType: labelLevel(lv, levels) };
    }
  }
  return null;
}

// ── findLastIdx — Node <18 compatible replacement for findLastIndex ──

function findLastIdx(arr, predicate) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

// ── Setup 2: Liquidity Grab & Reversal ───────────────────────

function detectLiqGrab(klines15m, levels, bias, price) {
  const WINDOW = 15;

  const slice      = klines15m.slice(-WINDOW);
  const lastCandle = klines15m[klines15m.length - 1];
  const keyLevs    = [levels.pdh, levels.pdl, levels.op].filter(Boolean);

  for (const lv of keyLevs) {
    if (bias === 'long') {
      // Spike: a recent candle's LOW dipped below lv but CLOSED above it (false break down)
      const grabIdx = findLastIdx(slice, k =>
        parseFloat(k[3]) < lv * 0.999 && parseFloat(k[4]) > lv
      );
      if (grabIdx < 0) continue;
      // Price has since moved away from the spike (recovering upward)
      if (price < lv) continue;
      // Last candle is bullish
      const lc = lastCandle;
      if (parseFloat(lc[4]) <= parseFloat(lc[1])) continue;
      return { setupName: 'LiqGrab', level: lv, levelType: labelLevel(lv, levels) };
    } else {
      // Spike above lv, close back below
      const grabIdx = findLastIdx(slice, k =>
        parseFloat(k[2]) > lv * 1.001 && parseFloat(k[4]) < lv
      );
      if (grabIdx < 0) continue;
      if (price > lv) continue;
      const lc = lastCandle;
      if (parseFloat(lc[4]) >= parseFloat(lc[1])) continue;
      return { setupName: 'LiqGrab', level: lv, levelType: labelLevel(lv, levels) };
    }
  }
  return null;
}

// ── Setup 3: VWAP Trend Following ────────────────────────────

function detectVWAPTrend(klines15m, vwap, bias, price) {
  if (!vwap) return null;

  const closes = klines15m.map(k => parseFloat(k[4]));
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  if (!e9 || !e21) return null;

  const NEAR = 0.008; // within 0.8 % of VWAP (pullbacks land in this zone)

  if (bias === 'long') {
    // Uptrend: EMA9 > EMA21
    if (e9 <= e21) return null;
    // Price near VWAP (pullback to VWAP)
    if (!near(price, vwap, NEAR)) return null;
    // Bullish rejection at VWAP
    const lastCandle = klines15m[klines15m.length - 1];
    const prevCandle = klines15m[klines15m.length - 2];
    const rej = rejectionType(lastCandle) === 'bullish' ||
                rejectionType(prevCandle) === 'bullish' ||
                parseFloat(lastCandle[4]) > parseFloat(lastCandle[1]); // bullish candle
    if (!rej) return null;
    return { setupName: 'VWAPTrend', level: vwap, levelType: 'VWAP', ema9: e9, ema21: e21 };
  } else {
    // Downtrend: EMA9 < EMA21
    if (e9 >= e21) return null;
    if (!near(price, vwap, NEAR)) return null;
    const lastCandle = klines15m[klines15m.length - 1];
    const prevCandle = klines15m[klines15m.length - 2];
    const rej = rejectionType(lastCandle) === 'bearish' ||
                rejectionType(prevCandle) === 'bearish' ||
                parseFloat(lastCandle[4]) < parseFloat(lastCandle[1]); // bearish candle
    if (!rej) return null;
    return { setupName: 'VWAPTrend', level: vwap, levelType: 'VWAP', ema9: e9, ema21: e21 };
  }
}

// ── Label a level value ───────────────────────────────────────

function labelLevel(val, levels) {
  if (Math.abs(val - levels.pdh) < 0.0001) return 'PDH';
  if (Math.abs(val - levels.pdl) < 0.0001) return 'PDL';
  if (Math.abs(val - levels.op)  < 0.0001) return 'OP';
  return 'KEY';
}

// ── Scoring ──────────────────────────────────────────────────
//   Max 20 pts.

function scoreSignal({ setup, bias, vwapBias, volSpike, rejCandle, ema9, ema21 }) {
  let s = 0;

  // Base per setup
  if (setup === 'BreakRetest') s += 8;
  if (setup === 'LiqGrab')     s += 9;  // SMC setups slightly higher value
  if (setup === 'VWAPTrend')   s += 7;

  // VWAP bias alignment bonus
  if (vwapBias) s += 2;

  // Volume spike
  if (volSpike) s += 2;

  // Clear rejection candle
  if (rejCandle) s += 2;

  // EMA trend confirmation (for VWAPTrend — already checked internally)
  if (ema9 && ema21) {
    const trendAligned = (bias === 'long' && ema9 > ema21) ||
                         (bias === 'short' && ema9 < ema21);
    if (trendAligned) s += 2;
  }

  return Math.min(s, 20);
}

// ── Trailing SL (capital % — v3 rules) ───────────────────────
//   Initial SL:   20 % capital  =  20%/leverage price move
//   Trail starts: +21 % capital profit
//   Lock formula: floor(capitalPct × 10) / 10  (same maths as v2, lower threshold)
//
//   With leverage=20, entry=$2000:
//     +21 % capital (+1.05 % price) → SL at entry − 1.0 % (20 % capital locked)
//     +31 % capital (+1.55 % price) → SL at entry + 0.5 % (30 % capital locked)

function calcTrailingSLV3(entryPrice, currentPrice, side, leverage = 1) {
  const pricePct =
    side === 'LONG'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;

  const capitalPct = pricePct * leverage;

  const INITIAL_SL_CAP = 0.20;  // 20 % capital initial stop
  const TRAIL_ON_CAP   = 0.21;  // trailing kicks in at +21 % capital

  if (capitalPct < TRAIL_ON_CAP) {
    const slPricePct = INITIAL_SL_CAP / leverage;
    return side === 'LONG'
      ? entryPrice * (1 - slPricePct)
      : entryPrice * (1 + slPricePct);
  }

  // Lock: floor(0.21 → 0.20, 0.31 → 0.30, 0.41 → 0.40 …)
  const lockCapPct   = Math.floor(capitalPct * 10) / 10;
  const lockPricePct = lockCapPct / leverage;

  return side === 'LONG'
    ? entryPrice * (1 + lockPricePct)
    : entryPrice * (1 - lockPricePct);
}

// ── Analyze one symbol ────────────────────────────────────────

async function analyzeV3(ticker) {
  try {
    const symbol = ticker.symbol;
    const price  = parseFloat(ticker.lastPrice);

    // Fetch 15m (for VWAP, price action, OP), 1h (for PDH/PDL)
    const [klines15m, klines1h] = await Promise.all([
      fetchKlines(symbol, '15m', 100),
      fetchKlines(symbol, '1h',  72),   // last 3 days of 1h bars
    ]);

    if (!klines15m || klines15m.length < 30) return null;
    if (!klines1h  || klines1h.length  < 24) return null;

    // ── Key levels ────────────────────────────────────────────
    const levels = extractKeyLevels(klines1h, klines15m);
    if (!levels) return null;

    // ── Session VWAP ─────────────────────────────────────────
    const vwap = calcVWAP(klines15m);
    if (!vwap) return null;

    // ── Bias filter ───────────────────────────────────────────
    //   PDF: above OP + VWAP = long, below both = short.
    //   Pullback entries land slightly below VWAP by definition,
    //   so allow 1.5% tolerance below VWAP for longs (and above for shorts).
    //   OP is the primary gate; VWAP position is a scoring bonus.
    const aboveOP   = price > levels.op;
    const aboveVWAP = price > vwap;
    const vwapDiff  = (price - vwap) / vwap; // +ve = above VWAP
    let bias;
    if (aboveOP && vwapDiff >= -0.015)      bias = 'long';
    else if (!aboveOP && vwapDiff <= 0.015) bias = 'short';
    else return null;

    // ── Run all three setups ──────────────────────────────────
    const setup =
      detectBreakRetest(klines15m, levels, bias, price) ||
      detectLiqGrab(klines15m, levels, bias, price)     ||
      detectVWAPTrend(klines15m, vwap, bias, price);

    if (!setup) return null;

    // ── Extra confirmation flags ──────────────────────────────
    const lastCandle  = klines15m[klines15m.length - 1];
    const candleVolAvg = avgVolume(klines15m, 20);
    const lastVol     = parseFloat(lastCandle[5]);
    const volSpike    = lastVol > candleVolAvg * 1.3;
    const rejCandle   = rejectionType(lastCandle) !== null;

    const closes = klines15m.map(k => parseFloat(k[4]));
    const ema9   = ema(closes, 9);
    const ema21  = ema(closes, 21);
    const vwapBias = (bias === 'long' && aboveVWAP) || (bias === 'short' && !aboveVWAP);

    // ── Score ─────────────────────────────────────────────────
    const score = scoreSignal({
      setup: setup.setupName,
      bias, vwapBias, volSpike, rejCandle,
      ema9, ema21,
    });
    if (score < 9) return null;  // minimum confluence

    // ── Entry & SL ────────────────────────────────────────────
    const side = bias === 'long' ? 'LONG' : 'SHORT';
    const entry = price;

    // SL display: 20% capital at 20x default = 1.0% price move
    const INITIAL_SL_PRICE_PCT = 0.20 / 20;
    const sl = side === 'LONG'
      ? entry * (1 - INITIAL_SL_PRICE_PCT)
      : entry * (1 + INITIAL_SL_PRICE_PCT);

    // ── Setup label ───────────────────────────────────────────
    const parts = [setup.setupName, `@${setup.levelType}`];
    if (bias === 'long' && ema9 && ema21 && ema9 > ema21) parts.push('EMAUp');
    if (bias === 'short' && ema9 && ema21 && ema9 < ema21) parts.push('EMADn');
    if (volSpike) parts.push('VolSpike');
    const setupName = parts.join('+');

    return {
      symbol,
      lastPrice:  price,
      signal:     side === 'LONG' ? 'BUY' : 'SELL',
      side,
      direction:  side,        // cycle.js compatibility
      entry,
      sl,
      slPct:      (INITIAL_SL_PRICE_PCT * 100).toFixed(2),

      trailConfig: {
        startPct:     0.21,  // trail starts at +21 % capital profit
        stepPct:      0.10,  // lock step every +10 % capital
        initialSLPct: 0.20,  // initial SL: 20 % capital
      },

      setupName,
      score,

      // no fixed TP — trailing SL manages exits
      tp1: null, tp2: null, tp3: null,

      // Diagnostics
      levels:   { pdh: levels.pdh, pdl: levels.pdl, op: levels.op },
      vwap,
      ema9, ema21,
      volSpike,
      rejCandle,
      setupLevel:     setup.level,
      setupLevelType: setup.levelType,

      chg24h:   parseFloat(ticker.priceChangePercent),
      timeframe: '15m+1h',
      version:  'v3',
    };

  } catch (_) {
    return null;
  }
}

// ── Main scan ─────────────────────────────────────────────────

async function scanV3(log = console.log) {
  const tickers = await fetchTickers();
  if (!tickers.length) {
    log('v3: failed to fetch tickers');
    return [];
  }

  // Top 30 USDT perpetuals by 24h quote volume, min $100M
  const top30 = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => parseFloat(t.quoteVolume) > 100e6)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 30);

  log(`v3: scanning ${top30.length} symbols…`);

  const results = [];
  for (const ticker of top30) {
    const sig = await analyzeV3(ticker);
    if (sig) {
      results.push(sig);
      log(`  ✓ ${sig.symbol} ${sig.side} score=${sig.score} — ${sig.setupName}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  results.sort((a, b) => b.score - a.score);
  log(`v3: ${results.length} signal(s) found`);
  return results.slice(0, 3);
}

module.exports = {
  scanV3,
  analyzeV3,
  calcTrailingSLV3,
  extractKeyLevels,
  calcVWAP,
};
