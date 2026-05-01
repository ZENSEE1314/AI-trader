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
//   Setup 4 — Multi-Timeframe Structure (MSTF)
//     LONG:  (15m or 3m) shows HH or HL  AND  1m shows HH or HL
//     SHORT: (15m or 3m) shows LL or LH  AND  1m shows LL or LH
//     HTF (15m/3m) sets the directional bias; 1m is the entry trigger.
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

// ── Market structure detection (HH / HL / LH / LL) ──────────
//
//   Scans klines for confirmed swing highs and lows.
//   A swing high: candle[i].high > all candles within ±swingLen.
//   A swing low : candle[i].low  < all candles within ±swingLen.
//   Returns the last two of each, then classifies structure.
//
//   Returns: { hh, hl, lh, ll } booleans, or null if not enough data.

function detectStructure(klines, swingLen = 3) {
  const len = klines.length;
  if (len < swingLen * 6) return null;

  const swingHighs = []; // { idx, price }
  const swingLows  = [];

  for (let i = swingLen; i < len - swingLen; i++) {
    const h = parseFloat(klines[i][2]);
    const l = parseFloat(klines[i][3]);

    let isHigh = true;
    let isLow  = true;
    for (let j = i - swingLen; j <= i + swingLen; j++) {
      if (j === i) continue;
      if (parseFloat(klines[j][2]) >= h) isHigh = false;
      if (parseFloat(klines[j][3]) <= l) isLow  = false;
    }
    if (isHigh) swingHighs.push(h);
    if (isLow)  swingLows.push(l);
  }

  if (swingHighs.length < 2 && swingLows.length < 2) return null;

  const hLen = swingHighs.length;
  const lLen = swingLows.length;

  // Compare last two swing highs and lows
  const hh = hLen >= 2 && swingHighs[hLen - 1] > swingHighs[hLen - 2];
  const lh = hLen >= 2 && swingHighs[hLen - 1] < swingHighs[hLen - 2];
  const hl = lLen >= 2 && swingLows[lLen - 1]  > swingLows[lLen - 2];
  const ll = lLen >= 2 && swingLows[lLen - 1]  < swingLows[lLen - 2];

  return { hh, hl, lh, ll };
}

// ── Setup 5: Momentum Breakout (waterfall / vertical impulse) ─────
//
//   PURPOSE: catch the moves the structure-based setups miss — a
//   vertical impulse candle that breaks out of a recent range with
//   no pullback and no LH/HL retest.
//
//   TRIGGERS (all must hold on the just-closed 1m candle):
//     1. Body magnitude  ≥ IMPULSE_BODY_ATR × ATR(14) on 1m
//     2. Volume          ≥ IMPULSE_VOL_MUL  × avg-volume(20) on 1m
//     3. Range expansion: candle range ≥ MAX(last 5 ranges) × 1.2
//     4. Range break:   close pierces max-high/min-low of last
//                       CONSOLIDATION_LB bars (excluding the candle)
//
//   Direction is taken from the candle body sign — this is the
//   point: we follow the impulse, we do NOT wait for a retest.
//
//   No swing-age check, no chase check.
//   Optional 1h-EMA200 alignment is a SCORE bonus, not a veto.

function atr(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h  = parseFloat(klines[i][2]);
    const l  = parseFloat(klines[i][3]);
    const pc = parseFloat(klines[i - 1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder-style: SMA of first `period` TRs, then RMA
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

function detectMomentumBreakout(klines1m, opts = {}) {
  const {
    // Loosened from initial 1.6/1.8/1.2 — synthetic backtest had cleaner
    // impulse signals than real BTC tape; relaxing slightly so realistic
    // trend-bar breakouts (e.g. BTC 75.3k→76k in 80m) can fire.
    bodyAtrMul       = 1.3,   // body must be ≥ 1.3 × ATR
    volMul           = 1.5,   // volume must be ≥ 1.5 × avg-20
    rangeMul         = 1.1,   // candle range ≥ 1.1 × max(last 5 ranges)
    consolidationLB  = 20,    // bars used to define the range break
  } = opts;

  if (!klines1m || klines1m.length < Math.max(consolidationLB + 2, 30)) return null;

  const last = klines1m[klines1m.length - 1];
  const o = parseFloat(last[1]);
  const h = parseFloat(last[2]);
  const l = parseFloat(last[3]);
  const c = parseFloat(last[4]);
  const v = parseFloat(last[5]);

  const body  = Math.abs(c - o);
  const range = h - l;
  if (range <= 0) return null;

  const a = atr(klines1m.slice(-30), 14);
  if (!a) return null;
  if (body < a * bodyAtrMul) return null;

  const volAvg = avgVolume(klines1m, 20);
  if (volAvg <= 0 || v < volAvg * volMul) return null;

  // Range expansion vs last 5 candles (excluding current)
  const prior5 = klines1m.slice(-6, -1);
  const maxPriorRange = Math.max(...prior5.map(k => parseFloat(k[2]) - parseFloat(k[3])));
  if (range < maxPriorRange * rangeMul) return null;

  // Consolidation break: close beyond max-high / min-low of prior LB bars
  const lb = klines1m.slice(-consolidationLB - 1, -1);
  const consHigh = Math.max(...lb.map(k => parseFloat(k[2])));
  const consLow  = Math.min(...lb.map(k => parseFloat(k[3])));

  const isUp   = c > o && c > consHigh;
  const isDown = c < o && c < consLow;
  if (!isUp && !isDown) return null;

  return {
    setupName: 'MomentumBreakout',
    level:     isUp ? consHigh : consLow,
    levelType: isUp ? 'RangeHigh' : 'RangeLow',
    direction: isUp ? 'long' : 'short',
    impulseHigh: h,
    impulseLow:  l,
    bodyAtr:     body / a,
    volMul:      v / volAvg,
  };
}

// ── Setup 4: Multi-Timeframe Structure (HTF + 1m confirmation) ──
//
//   LONG:  (15m or 3m) shows HH or HL  AND  1m shows HH or HL
//   SHORT: (15m or 3m) shows LL or LH  AND  1m shows LL or LH
//
//   HTF sets the direction; 1m is the entry trigger.

function detectMSTF(klines15m, klines3m, klines1m, bias) {
  if (!klines1m) return null;

  // Per user direction: trade on (15m OR 3m) HTF + 1m. Either HTF can
  // confirm structure; both being mid-formation simultaneously is the
  // only case we can't resolve. The COUNTER-block still requires the
  // ACTING HTF to not be confirmed-against-direction.
  const s15 = detectStructure(klines15m, 3);
  const s3  = klines3m ? detectStructure(klines3m, 3) : null;
  const s1  = detectStructure(klines1m,  2);

  if (!s1) return null;

  const ltfBull = s1.hh  || s1.hl;
  const ltfBear = s1.ll  || s1.lh;

  // Either HTF can supply bullish or bearish confirmation.
  const htfBull = (s15 && (s15.hh || s15.hl)) || (s3 && (s3.hh || s3.hl));
  const htfBear = (s15 && (s15.ll || s15.lh)) || (s3 && (s3.ll || s3.lh));

  // Block only when BOTH HTFs are confirmed-counter (or the only-one-
  // available HTF is confirmed-counter) — otherwise the trade can fire.
  const htfCounterLong  = (s15 && s15.ll && s15.lh) && (!s3 || (s3.ll && s3.lh));
  const htfCounterShort = (s15 && s15.hh && s15.hl) && (!s3 || (s3.hh && s3.hl));

  // ── 1m structure-pause gate ────────────────────────────────
  const len1 = klines1m.length;
  let longPaused = false, shortPaused = false;
  if (len1 >= 3) {
    const lastH = parseFloat(klines1m[len1 - 2][2]);
    const lastL = parseFloat(klines1m[len1 - 2][3]);
    const prevH = parseFloat(klines1m[len1 - 3][2]);
    const prevL = parseFloat(klines1m[len1 - 3][3]);
    longPaused  = lastH <= prevH && lastL <= prevL;
    shortPaused = lastL >= prevL && lastH >= prevH;
  }

  if (bias === 'long' && ltfBull && htfBull && !htfCounterLong && longPaused) {
    // Pick whichever HTF is bullish for the label
    const htfTag = (s15 && (s15.hh || s15.hl))
      ? `15${s15.hh ? 'HH' : 'HL'}`
      : `3${s3.hh ? 'HH' : 'HL'}`;
    const ltfType = s1.hh ? 'HH' : 'HL';
    return {
      setupName: 'MSTF',
      level:     null,
      levelType: `${htfTag}+1m${ltfType}`,
      htfStruct: { s15, s3 },
      ltfStruct: s1,
    };
  }

  if (bias === 'short' && ltfBear && htfBear && !htfCounterShort && shortPaused) {
    const htfTag = (s15 && (s15.ll || s15.lh))
      ? `15${s15.ll ? 'LL' : 'LH'}`
      : `3${s3.ll ? 'LL' : 'LH'}`;
    const ltfType = s1.ll ? 'LL' : 'LH';
    return {
      setupName: 'MSTF',
      level:     null,
      levelType: `${htfTag}+1m${ltfType}`,
      htfStruct: { s15, s3 },
      ltfStruct: s1,
    };
  }

  return null;
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
  if (setup === 'BreakRetest')      s += 8;
  if (setup === 'LiqGrab')          s += 9;  // SMC setups slightly higher value
  if (setup === 'VWAPTrend')        s += 7;
  if (setup === 'MSTF')             s += 9;  // multi-TF structure: strong confluence
  if (setup === 'MomentumBreakout') s += 9;  // impulse: base passes the score floor without
                                             // 15m confluence (which is unreliable mid-bar)

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
  // Leverage-aware trail trigger:
  //   100x (BTC, ETH)             — kicks in at +21 % → lock +20 %
  //   50x  (SOL, BNB, XRP, ...)   — kicks in at +16 % → lock +15 %
  const is50x         = leverage <= 50;
  const TRAIL_ON_CAP  = is50x ? 0.16 : 0.21;

  if (capitalPct < TRAIL_ON_CAP) {
    const slPricePct = INITIAL_SL_CAP / leverage;
    return side === 'LONG'
      ? entryPrice * (1 - slPricePct)
      : entryPrice * (1 + slPricePct);
  }

  // Tier ladders:
  //   100x: +21→+20, +31→+30, +41→+40, ... (+10 trigger / +10 lock, 1% gap constant)
  //         lock = floor((cap - 0.01) * 10) / 10
  //   50x : +16→+15, +27→+25, +38→+35, +49→+45, ... (+11 trigger / +10 lock, gap grows)
  //         n    = floor((cap - 0.16) / 0.11)
  //         lock = 0.15 + n * 0.10
  // The 1e-9 epsilon absorbs floating-point error from the subtraction.
  let lockCapPct;
  if (is50x) {
    const n  = Math.floor((capitalPct - 0.16 + 1e-9) / 0.11);
    lockCapPct = 0.15 + n * 0.10;
  } else {
    lockCapPct = Math.floor((capitalPct - 0.01 + 1e-9) * 10) / 10;
  }
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

    // Fetch all timeframes in parallel
    const [klines15m, klines1h, klines3m, klines1m] = await Promise.all([
      fetchKlines(symbol, '15m', 100),
      fetchKlines(symbol, '1h',  72),  // 3 days of 1h bars for PDH/PDL
      fetchKlines(symbol, '3m',  100), // structure detection on 3m
      fetchKlines(symbol, '1m',  60),  // 1m entry confirmation
    ]);

    // Diagnostic: tell why we're returning null. Enable per-call by
    // setting opts.verbose=true (TokenAgent passes it). Helps diagnose
    // "no signal" silence from the chat side.
    const verbose = !!(ticker && ticker.verbose);
    const dlog    = m => verbose && console.log(`[v3-diag] ${ticker.symbol}: ${m}`);

    if (!klines15m || klines15m.length < 30) { dlog('null — klines15m too short'); return null; }
    if (!klines1h  || klines1h.length  < 24) { dlog('null — klines1h too short');  return null; }

    // ── Key levels ────────────────────────────────────────────
    const levels = extractKeyLevels(klines1h, klines15m);
    if (!levels) { dlog('null — no key levels'); return null; }

    // ── Session VWAP ─────────────────────────────────────────
    const vwap = calcVWAP(klines15m);
    if (!vwap) { dlog('null — no VWAP'); return null; }

    // ── Bias filter ───────────────────────────────────────────
    const aboveOP   = price > levels.op;
    const aboveVWAP = price > vwap;
    const vwapDiff  = (price - vwap) / vwap; // +ve = above VWAP
    let bias;
    if (aboveOP && vwapDiff >= -0.015)      bias = 'long';
    else if (!aboveOP && vwapDiff <= 0.015) bias = 'short';
    else bias = null;
    dlog(`bias=${bias} aboveOP=${aboveOP} vwapDiff=${(vwapDiff*100).toFixed(2)}% (OP=${levels.op} VWAP=${vwap.toFixed(4)})`);

    // ── Setup 5 (MomentumBreakout) bypasses the OP/VWAP bias gate ─
    //   Impulse breakouts pick their own direction from candle body —
    //   the whole point is to catch waterfall moves the structure
    //   setups miss. Bias is set from the impulse direction.
    //   IMPORTANT: Binance returns the IN-PROGRESS 1m bar as the last
    //   entry; we slice it off so the detector evaluates the just-
    //   closed candle (which is what the backtest validated against).
    const klines1mClosed = klines1m.slice(0, -1);
    const breakoutSig = detectMomentumBreakout(klines1mClosed);

    if (!bias && !breakoutSig) { dlog('null — no bias and no momentum breakout'); return null; }

    // ── Run all setups ────────────────────────────────────────
    let setup = null;
    if (bias) {
      setup =
        detectBreakRetest(klines15m, levels, bias, price)        ||
        detectLiqGrab(klines15m, levels, bias, price)            ||
        detectVWAPTrend(klines15m, vwap, bias, price)            ||
        detectMSTF(klines15m, klines3m, klines1m, bias);
    }
    if (!setup && breakoutSig) {
      setup = breakoutSig;
      bias  = breakoutSig.direction;
    }

    if (!setup) { dlog(`null — no setup detected for bias=${bias} (BreakRetest/LiqGrab/VWAPTrend/MSTF/MomentumBreakout all returned null)`); return null; }
    dlog(`setup=${setup.setupName} @ ${setup.levelType}`);

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
    if (score < 9) { dlog(`null — score ${score} < 9`); return null; }

    // Counter-trend filter REMOVED per user direction: buy on the LL
    // candle / sell on the HH candle — those are reversal entries.
    // Earlier the filter blocked LONG on 1m ll+lh (confirmed bearish);
    // now allowed because user wants to catch the bottom. The HTF
    // (15m OR 3m) directional check + VWAP-band block + range-pos
    // with momentum exception still protect against truly bad setups.

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

    // ── VWAP bands (1m bars, matches Bitunix chart) — computed FIRST
    // because the range-pos gate now uses them for the momentum-side
    // exception (LONG above upper band / SHORT below lower band ride
    // momentum and skip range-pos).
    const k1m = klines1m || [];
    let vwapUpper = null, vwapLower = null;
    if (k1m.length > 30) {
      const dayStartMs = Date.UTC(new Date().getUTCFullYear(),
                                  new Date().getUTCMonth(),
                                  new Date().getUTCDate());
      const today1m = k1m.filter(k => parseInt(k[0]) >= dayStartMs);
      const used = today1m.length > 30 ? today1m : k1m.slice(-Math.min(k1m.length, 240));
      let cumTPV = 0, cumVol = 0;
      const tps = [];
      for (const k of used) {
        const tp = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
        const v  = parseFloat(k[5]) || 1;
        tps.push(tp);
        cumTPV += tp * v; cumVol += v;
      }
      if (cumVol > 0 && tps.length > 30) {
        const mid = cumTPV / cumVol;
        let varSum = 0;
        for (const t of tps) varSum += (t - mid) * (t - mid);
        const sd = Math.sqrt(varSum / tps.length);
        vwapUpper = mid + 2 * sd;
        vwapLower = mid - 2 * sd;
      }
    }

    // No-contrarian-at-extremes: blocks SHORT above upper, LONG below lower.
    if (vwapUpper && side === 'SHORT' && price >= vwapUpper) return null;
    if (vwapLower && side === 'LONG'  && price <= vwapLower) return null;

    // Momentum-side at the band: when price is at/above upper for LONG,
    // or at/below lower for SHORT, we ride the momentum and SKIP the
    // range-pos chase filter (the band itself proves it's not noise —
    // price has decisively pushed through ±2σ of session VWAP).
    const longMomentum  = vwapUpper && side === 'LONG'  && price >= vwapUpper;
    const shortMomentum = vwapLower && side === 'SHORT' && price <= vwapLower;

    // ── Range-position + pause gates ────────────────────────────────
    // Range pos in last 10×1m (0 = HL, 1 = HH).
    //   LONG  blocked if pos > 0.40 (chase up)   — UNLESS longMomentum
    //   SHORT blocked if pos < 0.60 (chase down) — UNLESS shortMomentum
    let rPos = null;
    if (k1m.length >= 11) {
      const w20 = k1m.slice(-11, -1);
      let hi = -Infinity, lo = Infinity;
      for (const k of w20) {
        const h = parseFloat(k[2]);
        const l = parseFloat(k[3]);
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      const sz = hi - lo;
      if (sz > 0) {
        rPos = (price - lo) / sz;
        if (!longMomentum  && side === 'LONG'  && rPos > 0.40) return null;
        if (!shortMomentum && side === 'SHORT' && rPos < 0.60) return null;
      }
    }

    const atExtreme = rPos !== null && (
      (side === 'LONG'  && rPos < 0.20) ||
      (side === 'SHORT' && rPos > 0.80)
    );

    // Pause gate also skipped on momentum-side band entries — the band
    // breach is the momentum confirmation, no need for a 2-candle pause.
    // Per latest user direction, this is now a SINGLE-candle pause:
    // the last closed 1m candle alone must not extend in the trade
    // direction. The prior 2-candle requirement (PR #49) was making the
    // bot miss reversal entries that paused for one candle and continued.
    // Token leverage — 50x for SOL/BNB/XRP, 100x for BTC/ETH.
    // Used by the tight-range filter (50x only) and to inform the
    // diagnostics log.
    const HIGH_LEV_SYMS = new Set(['BTCUSDT', 'ETHUSDT']);
    const tokenLev      = HIGH_LEV_SYMS.has(symbol) ? 100 : 50;

    // ── Tight-range skip (50x tokens only) ──────────────────────
    // At 50x, +21% capital = +0.42 % price. If the recent 20×1m range
    // is < 0.5 % of price, the TP target sits right at the historical
    // upper extreme of recent action — hard to hit, low EV. Skip the
    // trade. 100x tokens (BTC/ETH) have a +0.21 % TP target which
    // remains reachable in tighter ranges, so the filter doesn't apply.
    if (tokenLev === 50 && k1m.length >= 21) {
      const w20full = k1m.slice(-21, -1);
      let hi20 = -Infinity, lo20 = Infinity;
      for (const k of w20full) {
        const h = parseFloat(k[2]); if (h > hi20) hi20 = h;
        const l = parseFloat(k[3]); if (l < lo20) lo20 = l;
      }
      const rangePct = (hi20 - lo20) / price;
      if (rangePct < 0.005) {
        dlog(`null — 20×1m range ${(rangePct*100).toFixed(2)}% < 0.50% (TP unreachable on 50x)`);
        return null;
      }
    }

    // ── Volume-aware pause gate ─────────────────────────────────
    // Last closed 1m candle high-volume (≥ 20-bar average): 1-candle
    // pause is enough — the bar has commitment behind it. Low-volume:
    // require 2 paused candles since the structure forming on thin
    // tape is more likely a noise pivot. Skipped at extreme-zone /
    // momentum band (already covered upstream).
    if (!atExtreme && !longMomentum && !shortMomentum && k1m.length >= 3) {
      const lastH = parseFloat(k1m[k1m.length - 2][2]);
      const lastL = parseFloat(k1m[k1m.length - 2][3]);
      const midH  = parseFloat(k1m[k1m.length - 3][2]);
      const midL  = parseFloat(k1m[k1m.length - 3][3]);

      // Average volume over the last 20 closed 1m bars
      const volSlice = k1m.slice(-21, -1);
      const volAvgN = volSlice.length
        ? volSlice.reduce((s, k) => s + parseFloat(k[5] || 0), 0) / volSlice.length
        : 0;
      const lastVol = parseFloat(k1m[k1m.length - 2][5] || 0);
      const lowVolume = volAvgN > 0 && lastVol < volAvgN;

      if (side === 'LONG') {
        const paused1 = lastH <= midH && lastL <= midL;
        if (!paused1) { dlog('null — last 1m extending up (no pause)'); return null; }
        if (lowVolume && k1m.length >= 4) {
          const oldH = parseFloat(k1m[k1m.length - 4][2]);
          const oldL = parseFloat(k1m[k1m.length - 4][3]);
          const paused2 = midH <= oldH && midL <= oldL;
          if (!paused2) { dlog(`null — low-volume HL (vol ${lastVol.toFixed(0)} < avg ${volAvgN.toFixed(0)}) needs 2 paused candles`); return null; }
        }
      } else {
        const paused1 = lastL >= midL && lastH >= midH;
        if (!paused1) { dlog('null — last 1m extending down (no pause)'); return null; }
        if (lowVolume && k1m.length >= 4) {
          const oldH = parseFloat(k1m[k1m.length - 4][2]);
          const oldL = parseFloat(k1m[k1m.length - 4][3]);
          const paused2 = midL >= oldL && midH >= oldH;
          if (!paused2) { dlog(`null — low-volume LH (vol ${lastVol.toFixed(0)} < avg ${volAvgN.toFixed(0)}) needs 2 paused candles`); return null; }
        }
      }
    }

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
        startPct:     0.21,  // trail starts at +21 % capital profit → locks +20 %
        stepPct:      0.10,  // lock step every +10 % capital
        initialSLPct: 0.20,  // initial SL: 20 % capital
      },

      setupName,
      score,

      // Setup 5 marker — cycle.js uses this to bypass the EMA200 gate
      // (waterfall impulses start while EMA200 still shows prior trend)
      isMomentumBreakout: setup.setupName === 'MomentumBreakout',

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
      mstfStruct:     setup.setupName === 'MSTF' ? setup.htfStruct : null,

      chg24h:   parseFloat(ticker.priceChangePercent),
      timeframe: '1m+3m+15m+1h',
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
  detectMomentumBreakout,
  atr,
};
