'use strict';
/**
 * HTF/LTF Market-Structure Strategy  (15m bias → 1m confirmation)
 * ===============================================================
 * Implements the structure entry described by the shop owner, natively
 * from OHLCV candles — no dependency on a private TradingView indicator
 * or a desktop MCP bridge, so it is fully deterministic and backtestable.
 *
 * RULES (as specified by the shop owner):
 *   1. 15m bias from swing structure:
 *        Higher Low  (HL)  -> bullish bias  -> only look for LONGs  (buy the dip)
 *        Lower High  (LH)  -> bearish bias  -> only look for SHORTs (sell the rally)
 *   2. 1m entry = PULLBACK EXHAUSTION (implemented in backtest-structure.js):
 *        LONG : while bias is long, the 1m pulls back making consecutive LOWER lows;
 *               enter the moment a candle STOPS making a new lower low (dip exhausted).
 *        SHORT: while bias is short, the 1m pulls back making consecutive HIGHER highs;
 *               enter the moment a candle STOPS making a new higher high (rally exhausted).
 *   (This module provides the 15m bias; the 1m exhaustion trigger lives in the backtester.)
 *
 * IMPORTANT: swings are only treated as valid once `swingRight` candles have
 * formed AFTER them. This avoids look-ahead bias (the #1 way backtests lie).
 */

const CONFIG = {
  swingLeft:  2,   // candles on the left to qualify a swing
  swingRight: 2,   // candles on the right to confirm a swing (no look-ahead)
};

// ── Swing detection (fractal) ────────────────────────────────────────────
// Returns { highs:[{i,price,confirmAt}], lows:[{i,price,confirmAt}] }
// confirmAt = index at which the swing becomes known (i + right).
function detectSwings(candles, left = CONFIG.swingLeft, right = CONFIG.swingRight) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= left; k++) {
      if (candles[i].high <= candles[i - k].high) isHigh = false;
      if (candles[i].low  >= candles[i - k].low)  isLow  = false;
    }
    for (let k = 1; k <= right; k++) {
      if (candles[i].high <= candles[i + k].high) isHigh = false;
      if (candles[i].low  >= candles[i + k].low)  isLow  = false;
    }
    if (isHigh) highs.push({ i, price: candles[i].high, confirmAt: i + right, time: candles[i].time });
    if (isLow)  lows.push({  i, price: candles[i].low,  confirmAt: i + right, time: candles[i].time });
  }
  return { highs, lows };
}

/**
 * Build a timeline of 15m bias changes from confirmed swings.
 * Each entry: { time, bias:'long'|'short', level } where `level` is the
 * structure low (long) / high (short) that invalidates the bias if broken.
 * `time` is the candle CLOSE time at which the bias becomes known.
 */
function buildHtfBias(c15) {
  const { highs, lows } = detectSwings(c15);
  // Merge swing events in the order they are *confirmed*.
  const events = [
    ...highs.map(h => ({ kind: 'high', price: h.price, confirmAt: h.confirmAt })),
    ...lows.map(l  => ({ kind: 'low',  price: l.price, confirmAt: l.confirmAt })),
  ].sort((a, b) => a.confirmAt - b.confirmAt);

  const biasTimeline = [];
  let prevHigh = null, prevLow = null;
  for (const ev of events) {
    const closeTime = c15[Math.min(ev.confirmAt, c15.length - 1)].time;
    if (ev.kind === 'low') {
      if (prevLow != null && ev.price > prevLow) {
        // Higher Low -> bullish
        biasTimeline.push({ time: closeTime, bias: 'long', level: prevLow });
      }
      prevLow = ev.price;
    } else {
      if (prevHigh != null && ev.price < prevHigh) {
        // Lower High -> bearish
        biasTimeline.push({ time: closeTime, bias: 'short', level: prevHigh });
      }
      prevHigh = ev.price;
    }
  }
  return biasTimeline;
}

// Active bias at a given timestamp = most recent bias whose time <= ts.
function biasAt(biasTimeline, ts) {
  let active = null;
  for (const b of biasTimeline) {
    if (b.time <= ts) active = b; else break;
  }
  return active; // {bias, level} or null
}

// ── SMC-indicator-matching 15m bias windows ──────────────────────────────
// Mirrors SMC-Pro-Suite.pine: ta.pivothigh/low(piv_len, piv_len) with piv_len=5,
// single HL pivot => long bias, single LH pivot => short bias, bias active for
// (piv_len + 3) bars AFTER the pivot's confirmation, then it expires.
// Returns sorted [{ bias:'long'|'short', from, to }] in epoch-ms.
function buildSmcBiasWindows(c15, pivLen = 5, windowExtra = 3, barMs = 15 * 60 * 1000) {
  const BAR_MS = barMs;
  const highs = [], lows = [];
  for (let i = pivLen; i < c15.length - pivLen; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= pivLen; k++) {
      if (!(c15[i].high > c15[i - k].high && c15[i].high > c15[i + k].high)) isHigh = false;
      if (!(c15[i].low  < c15[i - k].low  && c15[i].low  < c15[i + k].low))  isLow  = false;
    }
    if (isHigh) highs.push({ i, price: c15[i].high });
    if (isLow)  lows.push({ i, price: c15[i].low });
  }
  const windows = [];
  const win = (pivotIdx, bias, pivotPrice) => {
    const fromIdx = Math.min(pivotIdx + pivLen, c15.length - 1);                 // confirmation bar
    const toIdx   = Math.min(pivotIdx + pivLen + windowExtra, c15.length - 1);   // bias expiry bar
    windows.push({ bias, from: c15[fromIdx].time, to: c15[toIdx].time + BAR_MS, pivotIdx, pivotPrice });
  };
  for (let j = 1; j < lows.length; j++)  if (lows[j].price  > lows[j - 1].price)  win(lows[j].i, 'long',  lows[j].price);  // HL
  for (let j = 1; j < highs.length; j++) if (highs[j].price < highs[j - 1].price) win(highs[j].i, 'short', highs[j].price); // LH
  windows.sort((a, b) => a.from - b.from);
  return windows;
}

// Per-1m-candle bias label from the windows (null if no bias active).
function biasArrayFromWindows(c1, windows) {
  const arr = new Array(c1.length).fill(null);
  for (const w of windows) {
    for (let i = 0; i < c1.length; i++) {
      if (c1[i].time >= w.from && c1[i].time < w.to) arr[i] = w.bias;
    }
  }
  return arr;
}

module.exports = { CONFIG, detectSwings, buildHtfBias, biasAt, buildSmcBiasWindows, biasArrayFromWindows };
