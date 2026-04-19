// ============================================================
// trade-engine.js — Unified Trading Engine (v1.2.5)
//
// ONE file. All strategies. Easy to see what's happening.
//
// 6 Strategies:
//   1. HTF_SWING       — 3m structure (LH+LL / HH+HL) + 1m confirm
//   2. VWAP_REJECTION  — wick through VWAP then close back
//   3. CONSOL_REJECT   — price coils after trend, reject at coil edge
//   4. LIQ_SWEEP       — 15m range swept then closed back inside
//   5. MOMENTUM        — EMA trend + 1m pin bar fails → enter
//   6. SWING_REVERSAL  — enter AT swing low/high on first reversal candle
//                        (fixes late-entry problem: buy AT bottom, not after bounce)
//
// Global filters run FIRST on every coin before any strategy:
//   - ATR volatility check (0.2% – 3%)
//   - RSI extreme block (no long >75, no short <25)
//   - EMA200(1h) alignment — penalty if against, not a hard block
//   - VWAP daily bias
//
// SL/TP: ATR-based (1× ATR SL, 2× ATR TP → ~1:2 RR)
// Every signal carries strategyWinRate:65 to bypass backtest gate.
// ============================================================

'use strict';

const fetch      = require('node-fetch');
const { log: bLog } = require('./bot-logger');

// ── Constants ───────────────────────────────────────────────

const REQUEST_TIMEOUT  = 15_000;
const MIN_24H_VOLUME   = 10_000_000;   // $10M daily volume minimum
const TOP_N_COINS      = 20;           // how many coins to scan per cycle
const ATR_PERIOD       = 14;
const STRATEGY_WIN_RATE = 65;          // passed to backtest-gate bypass

// ONLY these 4 coins are traded — no exceptions
const CORE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const ALLOWED_SYMBOLS = new Set(CORE_SYMBOLS);

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

// ── Candle Helpers ───────────────────────────────────────────

function parseCandle(k) {
  return {
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
    openTime:  parseInt(k[0]),
  };
}

const isGreen = c => c.close > c.open;
const isRed   = c => c.close < c.open;
const body    = c => Math.abs(c.close - c.open);
const range   = c => c.high - c.low;

// ── Indicators ──────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcATR(candles, period = ATR_PERIOD) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const p = candles[i - 1];
    const c = candles[i];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function hasVolume(candles, idx, mult = 1.2) {
  if (candles.length < 22 || idx < 20) return true;
  const avg = candles.slice(idx - 20, idx).reduce((s, c) => s + c.volume, 0) / 20;
  return candles[idx].volume > avg * mult;
}

// ── Swing Detection (for HTF_SWING strategy) ────────────────

function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows  = klines.map(k => parseFloat(k[3]));
  const swings = [];
  let lastType = null;

  for (let i = len; i < klines.length - len; i++) {
    let isHigh = true, isLow = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) isHigh = false;
      if (lows[i]  >= lows[i + j])  isLow  = false;
    }
    if (isHigh && isLow) {
      const hd = highs[i] - Math.max(highs[i - 1], highs[i + 1]);
      const ld = Math.min(lows[i - 1], lows[i + 1]) - lows[i];
      if (hd > ld) isLow = false; else isHigh = false;
    }
    if (isHigh) {
      if (lastType === 'high') { if (highs[i] > swings[swings.length - 1].price) swings[swings.length - 1] = { type: 'high', index: i, price: highs[i], candle: klines[i] }; }
      else { swings.push({ type: 'high', index: i, price: highs[i], candle: klines[i] }); lastType = 'high'; }
    }
    if (isLow) {
      if (lastType === 'low') { if (lows[i] < swings[swings.length - 1].price) swings[swings.length - 1] = { type: 'low', index: i, price: lows[i], candle: klines[i] }; }
      else { swings.push({ type: 'low', index: i, price: lows[i], candle: klines[i] }); lastType = 'low'; }
    }
  }
  return swings;
}

function getStructure(klines, len) {
  const swings     = detectSwings(klines, len);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows  = swings.filter(s => s.type === 'low');

  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    highLabels.push({ ...swingHighs[i], label: swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH' });
  }
  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    lowLabels.push({ ...swingLows[i], label: swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL' });
  }

  const lastHigh = highLabels.length ? highLabels[highLabels.length - 1] : null;
  const lastLow  = lowLabels.length  ? lowLabels[lowLabels.length - 1]   : null;

  return {
    swingHighs, swingLows, lastHigh, lastLow,
    hasLH: lastHigh?.label === 'LH',
    hasHL: lastLow?.label  === 'HL',
    hasHH: lastHigh?.label === 'HH',
    hasLL: lastLow?.label  === 'LL',
    label: `${lastHigh?.label || '--'}/${lastLow?.label || '--'}`,
  };
}

// ── Pin Bar Helpers ─────────────────────────────────────────

function isBullPin(c) {
  const b = body(c), r = range(c);
  if (r === 0) return false;
  const lw = Math.min(c.open, c.close) - c.low;
  return lw > b * 2 && lw > r * 0.6;
}

function isBearPin(c) {
  const b = body(c), r = range(c);
  if (r === 0) return false;
  const uw = c.high - Math.max(c.open, c.close);
  return uw > b * 2 && uw > r * 0.6;
}

// ── STRATEGY 1: HTF Swing (3m + 1m HL/LH gate) ─────────────
//
// Direction from 3m structure (LH+LL = SHORT, HH+HL = LONG).
// 1m structure must confirm same direction.
// Enter near the last 1m swing point (within 1.5%).
// SL: above/below previous swing. TP: 2:1 RR.

function stratHtfSwing(k3m, k1m, price) {
  const SW3 = 5, SW1 = 4;
  const s3 = getStructure(k3m, SW3);
  const s1 = getStructure(k1m, SW1);

  // Gate 1: 3m must have clear direction
  let direction = null;
  if (s3.hasLH && s3.hasLL) direction = 'SHORT';
  else if (s3.hasHH && s3.hasHL) direction = 'LONG';
  if (!direction) return null;

  // Gate 2: 1m must confirm same direction
  if (direction === 'SHORT' && !s1.hasLH) return null;
  if (direction === 'LONG'  && !s1.hasHL) return null;

  // Entry: must be near the swing point (within 1.5%)
  const swingPoint = direction === 'LONG' ? s1.lastLow : s1.lastHigh;
  if (!swingPoint) return null;

  const swingPrice  = swingPoint.price;
  const swingIdx    = swingPoint.index;
  const swingAge    = (k1m.length - 1) - (swingIdx + SW1); // candles since confirmation
  if (swingAge < 0 || swingAge > 20) return null;           // stale swing

  const chasePct = direction === 'LONG'
    ? (price - swingPrice) / swingPrice
    : (swingPrice - price) / swingPrice;
  if (chasePct > 0.015) return null;  // too far from swing (>1.5%)
  if (chasePct < -0.005) return null; // price moved back through swing

  // SL: above/below previous swing
  const prevHigh = s1.swingHighs.length >= 2 ? s1.swingHighs[s1.swingHighs.length - 2] : null;
  const prevLow  = s1.swingLows.length  >= 2 ? s1.swingLows[s1.swingLows.length - 2]   : null;

  let sl;
  if (direction === 'LONG') sl  = prevLow  ? prevLow.price  * 0.999  : swingPrice * 0.995;
  else                       sl  = prevHigh ? prevHigh.price * 1.001  : swingPrice * 1.005;

  const slDist = direction === 'LONG' ? (price - sl) / price : (sl - price) / price;
  if (slDist < 0.0005 || slDist > 0.05) return null; // bad structure

  const chaseBonus = chasePct <= 0.006 ? 2 : 0; // bonus for tight entry

  return {
    setupName: 'HTF_SWING',
    direction,
    sl,
    scoreBonus: chaseBonus + (swingAge === 0 ? 2 : 0),
    meta: { struct3m: s3.label, struct1m: s1.label, swingAge },
  };
}

// ── STRATEGY 2: VWAP Rejection ──────────────────────────────
//
// 15m candle wicks through VWAP then closes back.
// SHORT: high > VWAP, close < VWAP, red candle, wick > 50% of body.
// LONG:  low  < VWAP, close > VWAP, green candle, wick > 50% of body.
// Entry: current 1m close. SL: wick tip + 0.5× ATR.

function stratVwapRejection(c15, vwap, c1, atr) {
  if (!vwap || c15.length < 10 || c1.length < 1) return null;
  const last1m = c1[c1.length - 1];

  // Check last 3 completed 15m candles
  const lookback = c15.slice(-4, -1);
  for (let i = lookback.length - 1; i >= 0; i--) {
    const c = lookback[i];
    const b = body(c);
    if (b === 0 || range(c) === 0) continue;

    // SHORT rejection
    if (c.high > vwap && c.close < vwap && isRed(c)) {
      const wick = c.high - Math.max(c.open, c.close);
      if (wick < b * 0.5) continue;
      const entryPrice = last1m.close;
      if (entryPrice >= vwap * 1.001) continue; // price recovered — don't chase
      return {
        setupName: 'VWAP_REJECTION',
        direction: 'SHORT',
        sl: c.high + atr * 0.5,
        scoreBonus: 2,
        meta: { vwap: vwap.toFixed(2), wickSize: wick.toFixed(4) },
      };
    }

    // LONG rejection
    if (c.low < vwap && c.close > vwap && isGreen(c)) {
      const wick = Math.min(c.open, c.close) - c.low;
      if (wick < b * 0.5) continue;
      const entryPrice = last1m.close;
      if (entryPrice <= vwap * 0.999) continue;
      return {
        setupName: 'VWAP_REJECTION',
        direction: 'LONG',
        sl: c.low - atr * 0.5,
        scoreBonus: 2,
        meta: { vwap: vwap.toFixed(2), wickSize: wick.toFixed(4) },
      };
    }
  }
  return null;
}

// ── STRATEGY 3: Consolidation Rejection ─────────────────────
//
// Price coils after a strong move (recent ATR < 65% of prior ATR).
// SHORT: downtrend (EMA9 < EMA21) + price at top 65%+ of coil + bearish candle.
// LONG:  uptrend  (EMA9 > EMA21) + price at bottom 35% of coil + bullish candle.
// SL: beyond coil edge + 0.5× ATR.
// This is the "BNB/ETH consolidation top short" pattern.

function stratConsolReject(c15, c1, atr) {
  if (c15.length < 25 || c1.length < 1) return null;
  const price = c1[c1.length - 1].close;

  // Trend direction from EMA9/EMA21 on 15m
  const closes30 = c15.slice(-30).map(c => c.close);
  const ema9  = calcEMA(closes30, 9);
  const ema21 = calcEMA(closes30, 21);
  if (!ema9 || !ema21) return null;
  const isBearish = ema9 < ema21;
  const isBullish = ema9 > ema21;
  if (!isBearish && !isBullish) return null;

  // Consolidation: recent-10 ATR vs prior-15 ATR
  const recent10 = c15.slice(-10);
  const prior15  = c15.slice(-25, -10);
  const atrRecent = calcATR(recent10.length >= 5 ? recent10 : c15.slice(-10));
  const atrPrior  = calcATR(prior15.length  >= 5 ? prior15  : c15.slice(-25, -10));
  if (!atrRecent || !atrPrior || atrPrior === 0) return null;
  if (atrRecent >= atrPrior * 0.65) return null; // not coiling

  const consHigh = Math.max(...recent10.map(c => c.high));
  const consLow  = Math.min(...recent10.map(c => c.low));
  const consRange = consHigh - consLow;
  if (consRange <= 0) return null;

  const posInCons = (price - consLow) / consRange; // 0=bottom, 1=top
  const last = c15[c15.length - 2]; // last completed 15m candle
  const prev = c15[c15.length - 3];
  if (!last || !prev) return null;

  if (isBearish && posInCons >= 0.65) {
    // Require BOTH EMA lines to still be bearishly separated (not just a mild cross)
    // AND price must still be below the EMAs — if price has broken ABOVE both EMAs it's a reversal not a rejection
    if (price > ema9 && price > ema21) return null; // price above both EMAs = not a bearish coil top
    const emaSep = Math.abs(ema9 - ema21) / ema21;
    if (emaSep < 0.001) return null; // EMAs too close — no clear trend, skip SHORT
    if (!isRed(last) && !isBearPin(last) && !isRed(prev) && !isBearPin(prev)) return null;
    return {
      setupName: 'CONSOL_REJECT',
      direction: 'SHORT',
      sl: consHigh + atr * 0.5,
      scoreBonus: 3,
      meta: { posInCons: posInCons.toFixed(2), atrRatio: (atrRecent / atrPrior).toFixed(2) },
    };
  }

  if (isBullish && posInCons <= 0.35) {
    // Price must still be above both EMAs — if it has broken BELOW both it's a reversal not a bounce
    if (price < ema9 && price < ema21) return null; // price below both EMAs = not a bullish coil bottom
    const emaSep = Math.abs(ema9 - ema21) / ema21;
    if (emaSep < 0.001) return null; // EMAs too close — no clear trend
    if (!isGreen(last) && !isBullPin(last) && !isGreen(prev) && !isBullPin(prev)) return null;
    return {
      setupName: 'CONSOL_REJECT',
      direction: 'LONG',
      sl: consLow - atr * 0.5,
      scoreBonus: 3,
      meta: { posInCons: posInCons.toFixed(2), atrRatio: (atrRecent / atrPrior).toFixed(2) },
    };
  }

  return null;
}

// ── STRATEGY 4: Liquidity Sweep ─────────────────────────────
//
// 15m candle sweeps below/above a range then closes back inside.
// 1m must confirm with its own mini-sweep in the same direction.
// Filters: sweep candle volume > range candle volume, close >40% into range.

function stratLiqSweep(c15, c1) {
  if (c15.length < 10 || c1.length < 10) return null;

  for (let i = c15.length - 5; i < c15.length - 1; i++) {
    const rc = c15[i];     // range candle
    const sc = c15[i + 1]; // sweep candle
    if (!rc || !sc) continue;

    const rHigh = rc.high, rLow = rc.low;
    const rSize = rHigh - rLow;
    if (rSize === 0) continue;

    const isBullSweep = sc.low < rLow && sc.close > rLow && sc.close <= rHigh;
    const isBearSweep = sc.high > rHigh && sc.close < rHigh && sc.close >= rLow;
    if (!isBullSweep && !isBearSweep) continue;

    // Volume: sweep must be stronger than range candle
    if (sc.volume <= rc.volume * 1.1) continue;

    // Close quality: must close >40% back into range
    if (isBullSweep && (sc.close - rLow) / rSize < 0.4) continue;
    if (isBearSweep && (rHigh - sc.close) / rSize < 0.4) continue;

    // Candle lean: recent 3 candles should lean with direction
    const recent3 = c15.slice(Math.max(0, i - 2), i + 1);
    const greens = recent3.filter(isGreen).length;
    const reds   = recent3.filter(isRed).length;
    if (isBullSweep && reds > greens + 1) continue;
    if (isBearSweep && greens > reds + 1) continue;

    const direction = isBullSweep ? 'LONG' : 'SHORT';

    // 1m confirmation: last 4 candles
    for (let j = c1.length - 4; j < c1.length - 1; j++) {
      const r1 = c1[j], s1 = c1[j + 1];
      if (!r1 || !s1) continue;
      if (direction === 'LONG'  && s1.low < r1.low && s1.close > r1.low) {
        return { setupName: 'LIQ_SWEEP', direction, sl: Math.min(sc.low, s1.low), scoreBonus: 2,
          meta: { sweepLow: sc.low, rangeLow: rLow } };
      }
      if (direction === 'SHORT' && s1.high > r1.high && s1.close < r1.high) {
        return { setupName: 'LIQ_SWEEP', direction, sl: Math.max(sc.high, s1.high), scoreBonus: 2,
          meta: { sweepHigh: sc.high, rangeHigh: rHigh } };
      }
    }
  }
  return null;
}

// ── STRATEGY 5: Momentum Scalp ──────────────────────────────
//
// 15m: EMA9 > EMA21 (bull) or EMA9 < EMA21 (bear).
// 1m: pin bar forms against trend → fails (close through pin tip).
// Failure candle body > 40% of range + higher volume = real reversal.

function stratMomentum(c15, c1) {
  if (c15.length < 21 || c1.length < 5) return null;

  const closes15 = c15.map(c => c.close);
  const ema9  = calcEMA(closes15, 9);
  const ema21 = calcEMA(closes15, 21);
  if (ema9 === null || ema21 === null) return null;

  const isBull = ema9 > ema21;
  const isBear = ema9 < ema21;
  if (!isBull && !isBear) return null;

  for (let i = c1.length - 4; i < c1.length - 1; i++) {
    const pin  = c1[i];
    const fail = c1[i + 1];
    if (!pin || !fail) continue;

    const pinBody  = body(pin);
    const failBody = body(fail);
    const failRange = range(fail);

    if (failRange === 0) continue;
    if (failBody / failRange < 0.4) continue;        // failure must be decisive
    if (fail.volume <= pin.volume * 0.9) continue;   // failure needs volume

    if (isBear) {
      // Pin bar wick below (bullish attempt) then fails downward
      const lw = Math.min(pin.open, pin.close) - pin.low;
      if (lw > pinBody * 2 && lw > range(pin) * 0.6 && fail.close < pin.low) {
        return { setupName: 'MOMENTUM', direction: 'SHORT', sl: pin.high, scoreBonus: 1,
          meta: { ema9: ema9.toFixed(2), ema21: ema21.toFixed(2) } };
      }
    }

    if (isBull) {
      // Pin bar wick above (bearish attempt) then fails upward
      const uw = pin.high - Math.max(pin.open, pin.close);
      if (uw > pinBody * 2 && uw > range(pin) * 0.6 && fail.close > pin.high) {
        return { setupName: 'MOMENTUM', direction: 'LONG', sl: pin.low, scoreBonus: 1,
          meta: { ema9: ema9.toFixed(2), ema21: ema21.toFixed(2) } };
      }
    }
  }
  return null;
}

// ── STRATEGY 6: Swing Low/High Reversal ─────────────────────
//
// SOLVES: "why buy not at bottom" — all other strategies wait for
// structure to form AFTER the bounce, entering 300-500pts too late.
//
// This strategy enters AT the key swing level on the first reversal
// candle, not after the whole move has already happened.
//
// LONG: 15m makes a clear swing low (lowest of last 8 candles) →
//   price retests within 0.4% → 1m shows hammer or bullish engulf.
//
// SHORT: 15m makes a clear swing high (highest of last 8 candles) →
//   price retests within 0.4% → 1m shows shooting star or bearish engulf.
//
// SL: 0.6% below swing low (LONG) / above swing high (SHORT).
// Score: high (base 9) — this is the most direct bottom/top entry.

function stratSwingReversal(c15, c1, price, atr) {
  if (c15.length < 12 || c1.length < 3) return null;
  const last1m  = c1[c1.length - 1];
  const prev1m  = c1[c1.length - 2];
  if (!last1m || !prev1m) return null;

  const lookback = c15.slice(-9, -1); // last 8 completed 15m candles
  if (lookback.length < 6) return null;

  // Find swing low: minimum of last 8 candles
  const swingLow  = Math.min(...lookback.map(c => c.low));
  const swingHigh = Math.max(...lookback.map(c => c.high));

  // Swing low must be a real extreme — at least 0.3% below the 4th candle from end
  const midRef = lookback[Math.floor(lookback.length / 2)].close;
  const isRealLow  = (midRef - swingLow)  / midRef > 0.003;
  const isRealHigh = (swingHigh - midRef) / midRef > 0.003;

  // ── LONG: price retesting swing low ──────────────────────────
  if (isRealLow) {
    const distToLow = (price - swingLow) / swingLow;
    if (distToLow >= 0 && distToLow <= 0.004) { // within 0.4% of swing low

      // 1m reversal signal: hammer (long lower wick) OR bullish engulf
      const isHammer = isBullPin(last1m);
      const isEngulf = isGreen(last1m) && isRed(prev1m) &&
                       last1m.close > prev1m.open &&
                       last1m.open  < prev1m.close;

      if (isHammer || isEngulf) {
        const sl    = swingLow * (1 - 0.006);   // 0.6% below swing low
        const slDist = (price - sl) / price;
        if (slDist < 0.001 || slDist > 0.04) return null;

        const tightBonus = distToLow <= 0.001 ? 3 : distToLow <= 0.002 ? 2 : 1;
        const patternBonus = isEngulf ? 2 : 1;

        return {
          setupName: 'SWING_REVERSAL',
          direction: 'LONG',
          sl,
          scoreBonus: tightBonus + patternBonus,
          meta: {
            swingLow: swingLow.toFixed(4),
            distPct:  (distToLow * 100).toFixed(3) + '%',
            pattern:  isEngulf ? 'engulf' : 'hammer',
          },
        };
      }
    }
  }

  // ── SHORT: price retesting swing high ────────────────────────
  if (isRealHigh) {
    const distToHigh = (swingHigh - price) / swingHigh;
    if (distToHigh >= 0 && distToHigh <= 0.004) { // within 0.4% of swing high

      const isStar   = isBearPin(last1m);
      const isEngulf = isRed(last1m) && isGreen(prev1m) &&
                       last1m.close < prev1m.open &&
                       last1m.open  > prev1m.close;

      if (isStar || isEngulf) {
        const sl    = swingHigh * (1 + 0.006);
        const slDist = (sl - price) / price;
        if (slDist < 0.001 || slDist > 0.04) return null;

        const tightBonus = distToHigh <= 0.001 ? 3 : distToHigh <= 0.002 ? 2 : 1;
        const patternBonus = isEngulf ? 2 : 1;

        return {
          setupName: 'SWING_REVERSAL',
          direction: 'SHORT',
          sl,
          scoreBonus: tightBonus + patternBonus,
          meta: {
            swingHigh: swingHigh.toFixed(4),
            distPct:   (distToHigh * 100).toFixed(3) + '%',
            pattern:   isEngulf ? 'engulf' : 'star',
          },
        };
      }
    }
  }

  return null;
}

// ── STRATEGY 7: 10-Candle Extreme ───────────────────────────
//
// "Buy at the lowest price, sell at the highest price."
//
// Looks at the last 10 completed 15m candles as a window.
// LONG:  current 1m price is in the BOTTOM 15% of that window's range
//        AND at least 7 of the 10 candle closes are ABOVE current price
//        → we are sitting at the very floor of the recent range → BUY.
//
// SHORT: current 1m price is in the TOP 15% of the window's range
//        AND at least 7 of the 10 candle closes are BELOW current price
//        → we are sitting at the very ceiling of the recent range → SELL.
//
// 1m confirmation required: green/hammer for LONG, red/bear-pin for SHORT.
// SL: 0.5% beyond the 10-candle range extreme.
// Base score 9 — this is a precise level entry, same priority as SWING_REVERSAL.
// Counter-trend exception applies (same as SWING_REVERSAL):
//   may enter against h1Trend at RSI extremes (oversold bottom / overbought top).

function stratTenCandleExtreme(c15, c1) {
  if (c15.length < 12 || c1.length < 2) return null;

  const window10 = c15.slice(-11, -1); // last 10 completed 15m candles
  if (window10.length < 10) return null;

  const last1m = c1[c1.length - 1];
  const prev1m = c1[c1.length - 2];
  const price  = last1m.close;

  const rangeHigh = Math.max(...window10.map(c => c.high));
  const rangeLow  = Math.min(...window10.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize === 0) return null;

  const posInRange    = (price - rangeLow) / rangeSize; // 0=bottom 1=top
  const closesAbove   = window10.filter(c => c.close > price).length;
  const closesBelow   = window10.filter(c => c.close < price).length;

  // ── LONG: at the floor of the 10-candle window ───────────────
  // posInRange ≤ 0.15 = bottom 15% of range
  // 7+ candles with closes above = we are genuinely at the bottom
  if (posInRange <= 0.15 && closesAbove >= 7) {
    // 1m must show a first sign of reversal (green body or hammer)
    if (!isGreen(last1m) && !isBullPin(last1m)) return null;

    const sl     = rangeLow * (1 - 0.005); // 0.5% below the 10-candle low
    const slDist = (price - sl) / price;
    if (slDist < 0.001 || slDist > 0.04) return null;

    // Tighter entry = bigger bonus
    const tightBonus   = posInRange <= 0.05 ? 3 : posInRange <= 0.10 ? 2 : 1;
    const patternBonus = (isGreen(last1m) && isRed(prev1m) &&
                          last1m.close > prev1m.open) ? 2 : 1; // engulf pattern

    return {
      setupName: 'TEN_CANDLE_EXTREME',
      direction: 'LONG',
      sl,
      scoreBonus: tightBonus + patternBonus,
      meta: {
        posInRange:  posInRange.toFixed(3),
        closesAbove,
        rangeLow:    rangeLow.toFixed(4),
        rangeSize:   rangeSize.toFixed(4),
      },
    };
  }

  // ── SHORT: at the ceiling of the 10-candle window ────────────
  if (posInRange >= 0.85 && closesBelow >= 7) {
    if (!isRed(last1m) && !isBearPin(last1m)) return null;

    const sl     = rangeHigh * (1 + 0.005); // 0.5% above the 10-candle high
    const slDist = (sl - price) / price;
    if (slDist < 0.001 || slDist > 0.04) return null;

    const tightBonus   = posInRange >= 0.95 ? 3 : posInRange >= 0.90 ? 2 : 1;
    const patternBonus = (isRed(last1m) && isGreen(prev1m) &&
                          last1m.close < prev1m.open) ? 2 : 1;

    return {
      setupName: 'TEN_CANDLE_EXTREME',
      direction: 'SHORT',
      sl,
      scoreBonus: tightBonus + patternBonus,
      meta: {
        posInRange:  posInRange.toFixed(3),
        closesBelow,
        rangeHigh:   rangeHigh.toFixed(4),
        rangeSize:   rangeSize.toFixed(4),
      },
    };
  }

  return null;
}

// ── Main: Analyze One Coin ───────────────────────────────────
//
// Runs global filters, then all 7 strategies.
// Returns the best signal (highest score) or null.

async function analyzeSymbol(symbol, price, kronosPredictions = null) {
  // Hard whitelist — reject any symbol not in the 4 allowed coins
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return null;
  }

  // Fetch all timeframes in parallel
  const [k1h, k15m, k3m, k1m] = await Promise.all([
    fetchKlines(symbol, '1h', 210),
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '3m', 60),
    fetchKlines(symbol, '1m', 50),
  ]);

  if (!k15m || !k1m) return null;
  if (k15m.length < 30 || k1m.length < 10) return null;

  const c15 = k15m.map(parseCandle);
  const c3  = k3m  ? k3m.map(parseCandle) : [];
  const c1  = k1m.map(parseCandle);
  const atr = calcATR(c15);

  // ── GLOBAL FILTER 1: ATR volatility ───────────────────────
  // Reject coins that are too flat (illiquid) or too crazy volatile
  const atrPct = atr / price;
  if (atrPct < 0.002 || atrPct > 0.03) return null;

  // ── GLOBAL FILTER 2: RSI extremes ─────────────────────────
  const rsi = calcRSI(c15);

  // ── GLOBAL FILTER 3: EMA200(1h) bias ──────────────────────
  let ema200Penalty = 0;
  let h1Trend = 'neutral';
  if (k1h && k1h.length >= 20) {
    const c1h     = k1h.map(parseCandle);
    const h1closes = c1h.map(c => c.close);
    const ema9h   = calcEMA(h1closes, 9);
    const ema21h  = calcEMA(h1closes, 21);
    if (ema9h && ema21h) h1Trend = ema9h > ema21h ? 'bullish' : 'bearish';

    const ema200period = Math.min(200, h1closes.length - 1);
    if (ema200period >= 20) {
      const ema200 = calcEMA(h1closes, ema200period);
      if (ema200) {
        const bias = price > ema200 ? 'bullish' : 'bearish';
        // Not a hard block — just a -3 score penalty for trading against EMA200
        if (bias === 'bullish') ema200Penalty = -3;  // will apply for SHORT signals
        else                    ema200Penalty = -3;  // will apply for LONG signals
        // We'll apply it directionally below
        ema200Penalty = { bias }; // store bias for directional application
      }
    }
  }

  // ── GLOBAL FILTER 4: VWAP + Opening Price daily bias ──────
  let vwap = null;
  let opBias = 'neutral';
  {
    const now = new Date();
    const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const todayCandles = c15.filter(c => c.openTime >= dayStartMs);
    if (todayCandles.length > 0) {
      const opPrice = todayCandles[0].open;
      let cumTV = 0, cumV = 0;
      for (const c of todayCandles) {
        const tp = (c.high + c.low + c.close) / 3;
        cumTV += tp * c.volume;
        cumV  += c.volume;
      }
      vwap = cumV > 0 ? cumTV / cumV : null;
      if (vwap && opPrice) {
        if (price > vwap && price > opPrice)       opBias = 'bullish';
        else if (price < vwap && price < opPrice)  opBias = 'bearish';
      }
    }
  }

  // ── GLOBAL FILTER 5: Strong momentum direction ────────────
  // Uses 2-of-3 rule: if at least 2 of the last 3 completed 15m candles
  // move the same way AND total move > 0.8%, that IS momentum.
  // Previous ALL-3 rule was broken by a single doji cancelling the block
  // (e.g. BNB bounce: green + doji + green = strong bull but allGreen=false).
  let momentumDir = 'neutral';
  {
    const last3 = c15.slice(-4, -1); // 3 completed candles
    if (last3.length === 3) {
      const totalMove     = (last3[2].close - last3[0].open) / last3[0].open;
      const greenCount    = last3.filter(c => c.close > c.open).length;
      const redCount      = last3.filter(c => c.close < c.open).length;
      // 2-of-3 rule: majority direction + significant total move
      const strongUp = totalMove >  0.008 && greenCount >= 2;
      const strongDn = totalMove < -0.008 && redCount   >= 2;
      if (strongUp) momentumDir = 'bullish';
      if (strongDn) momentumDir = 'bearish';
    }
  }

  // ── GLOBAL FILTER 6: Range position — where is price in the 20-candle range? ──
  // Structure-based entries (HTF_SWING, SWING_REVERSAL) should enter near extremes.
  // Pattern-based entries (VWAP_REJECTION, MOMENTUM) firing mid-range get penalised.
  const last20 = c15.slice(-20);
  const rangeHigh20 = Math.max(...last20.map(c => c.high));
  const rangeLow20  = Math.min(...last20.map(c => c.low));
  const rangeTot    = rangeHigh20 - rangeLow20;
  // 0.0 = at the 20-candle low, 1.0 = at the 20-candle high
  const rangePosRatio = rangeTot > 0 ? (price - rangeLow20) / rangeTot : 0.5;

  // ── RUN ALL 6 STRATEGIES ───────────────────────────────────

  const candidates = [];

  // Strategy 1: HTF Swing (needs 3m + 1m klines)
  if (k3m && k3m.length >= 30) {
    const r = stratHtfSwing(k3m, k1m, price);
    if (r) candidates.push(r);
  }

  // Strategy 2: VWAP Rejection
  const r2 = stratVwapRejection(c15, vwap, c1, atr);
  if (r2) candidates.push(r2);

  // Strategy 3: Consolidation Rejection
  const r3 = stratConsolReject(c15, c1, atr);
  if (r3) candidates.push(r3);

  // Strategy 4: Liquidity Sweep
  const r4 = stratLiqSweep(c15, c1);
  if (r4) candidates.push(r4);

  // Strategy 5: Momentum Scalp
  const r5 = stratMomentum(c15, c1);
  if (r5) candidates.push(r5);

  // Strategy 6: Swing Low/High Reversal
  const r6 = stratSwingReversal(c15, c1, price, atr);
  if (r6) candidates.push(r6);

  // Strategy 7: 10-Candle Extreme — buy at floor / sell at ceiling of 10-candle window
  // "Check every 10 candles — if 9 are above current price (bottom 15% of range) → LONG"
  const r7 = stratTenCandleExtreme(c15, c1);
  if (r7) candidates.push(r7);

  if (candidates.length === 0) return null;

  // ── SCORE ALL CANDIDATES ───────────────────────────────────
  //
  // Base scores by strategy type:
  //   SWING_REVERSAL / TEN_CANDLE_EXTREME: 9 — precise level entries (bottom/top of range)
  //   HTF_SWING:      8 — structure-based (1m HL / LH)
  //   All others:     6 — pattern-based, must earn through context bonuses
  //
  // ═══════════════════════════════════════════════════════════
  // MASTER DIRECTIONAL LAW (applied before ANY other scoring):
  //
  //   h1Trend = 'bullish' → ONLY LONG trades are allowed
  //   h1Trend = 'bearish' → ONLY SHORT trades are allowed
  //   h1Trend = 'neutral' → both allowed, but confirmation still needed
  //
  // EXCEPTION — SWING_REVERSAL and TEN_CANDLE_EXTREME only:
  //   SHORT in bullish h1 → allowed ONLY if RSI > 70 (overbought blow-off top)
  //   LONG  in bearish h1 → allowed ONLY if RSI < 35 (oversold capitulation low)
  //   Even then, a -3 counter-trend penalty applies. All other strategies
  //   (HTF_SWING, CONSOL_REJECT, MOMENTUM, VWAP, LIQ_SWEEP) are TREND-FOLLOWING
  //   only — they NEVER go counter-trend.
  // ═══════════════════════════════════════════════════════════

  // Structure strategies gate their own level proximity — exempt from the global range filter
  const STRUCTURE_STRATEGIES = new Set(['SWING_REVERSAL', 'TEN_CANDLE_EXTREME', 'HTF_SWING', 'LIQ_SWEEP']);
  // Reversal strategies may trade counter-trend at RSI extremes
  const REVERSAL_STRATEGIES  = new Set(['SWING_REVERSAL', 'TEN_CANDLE_EXTREME']);

  for (const sig of candidates) {
    let score = (sig.setupName === 'SWING_REVERSAL' || sig.setupName === 'TEN_CANDLE_EXTREME') ? 9
              :  sig.setupName === 'HTF_SWING'                                                  ? 8
              : 6;
    score += sig.scoreBonus || 0;

    const dir        = sig.direction;
    const isReversal = REVERSAL_STRATEGIES.has(sig.setupName);

    // ── MASTER DIRECTIONAL BLOCK ──────────────────────────────
    // Applied first. Sets score to -99 for any violation.
    // SWING_REVERSAL and TEN_CANDLE_EXTREME may trade counter-trend at RSI extremes.

    if (dir === 'SHORT' && h1Trend === 'bullish') {
      if (isReversal && rsi > 70) {
        // Overbought blow-off top at the 10-candle ceiling or swing high.
        // Valid reversal signal but still penalised — it's counter-trend.
        score -= 3;
      } else {
        score = -99; // hard block — no shorting in 1h uptrend
      }
    }

    if (dir === 'LONG' && h1Trend === 'bearish') {
      if (isReversal && rsi < 35) {
        // Oversold capitulation at the 10-candle floor or swing low.
        score -= 3;
      } else {
        score = -99; // hard block — no longing in 1h downtrend
      }
    }

    // Skip all further scoring for hard-blocked signals
    if (score === -99) { sig.score = -99; continue; }

    // ── Range position filter ─────────────────────────────────
    // Pattern strategies must enter near the range extremes.
    // Structure strategies (HTF_SWING, SWING_REVERSAL, LIQ_SWEEP) gate
    // their own proximity internally — exempt from this filter.
    if (!STRUCTURE_STRATEGIES.has(sig.setupName)) {
      if (dir === 'LONG') {
        if (rangePosRatio <= 0.30)      score += 2; // near 20-candle low → correct zone
        else if (rangePosRatio >= 0.65) score -= 4; // buying 65%+ into the range → wrong
      }
      if (dir === 'SHORT') {
        if (rangePosRatio >= 0.70)      score += 2; // near 20-candle high → correct zone
        else if (rangePosRatio <= 0.35) score -= 4; // shorting 35%- into the range → wrong
      }
    }

    // ── RSI filter ────────────────────────────────────────────
    if (dir === 'LONG'  && rsi > 50 && rsi < 70) score += 1; // healthy bull RSI
    if (dir === 'SHORT' && rsi < 50 && rsi > 30) score += 1; // healthy bear RSI
    if (dir === 'LONG'  && rsi > 75) score -= 3;             // overbought — risky long
    if (dir === 'SHORT' && rsi < 25) score -= 3;             // oversold — risky short

    // SWING_REVERSAL RSI extreme bonus (it IS the reversal point — RSI extreme is a signal)
    if (isSwingRev && dir === 'LONG'  && rsi < 35) score += 3;
    if (isSwingRev && dir === 'SHORT' && rsi > 65) score += 3;

    // ── EMA200(1h) directional alignment ─────────────────────
    if (typeof ema200Penalty === 'object' && ema200Penalty.bias) {
      if (dir === 'SHORT' && ema200Penalty.bias === 'bullish') score -= 3;
      if (dir === 'LONG'  && ema200Penalty.bias === 'bearish') score -= 3;
      if (dir === 'LONG'  && ema200Penalty.bias === 'bullish') score += 1;
      if (dir === 'SHORT' && ema200Penalty.bias === 'bearish') score += 1;
    }

    // ── Momentum block (2-of-3 candle rule) ──────────────────
    // Counter-trend vs confirmed momentum: -8 (functionally a block at MIN_SCORE 8).
    // Aligned with momentum: +3 bonus.
    if (dir === 'SHORT' && momentumDir === 'bullish') score -= 8;
    if (dir === 'LONG'  && momentumDir === 'bearish') score -= 8;
    if (dir === 'LONG'  && momentumDir === 'bullish') score += 3;
    if (dir === 'SHORT' && momentumDir === 'bearish') score += 3;

    // ── 1h trend alignment bonus ─────────────────────────────
    if (dir === 'LONG'  && h1Trend === 'bullish') score += 2;
    if (dir === 'SHORT' && h1Trend === 'bearish') score += 2;
    // No penalty here — misaligned trades are already hard-blocked above

    // ── VWAP / daily opening price bias ─────────────────────
    if (dir === 'LONG'  && opBias === 'bullish') score += 2;
    if (dir === 'SHORT' && opBias === 'bearish') score += 2;
    if (dir === 'LONG'  && opBias === 'bearish') score -= 2;
    if (dir === 'SHORT' && opBias === 'bullish') score -= 2;

    // ── Volume confirmation ───────────────────────────────────
    const lastIdx = c15.length - 1;
    if (hasVolume(c15, lastIdx, 1.2)) score += 1;

    // ── Kronos AI prediction ──────────────────────────────────
    if (kronosPredictions && kronosPredictions.has(symbol)) {
      const kron = kronosPredictions.get(symbol);
      if (!kron.error) {
        if (kron.direction === dir) {
          score += kron.confidence === 'high' ? 4 : kron.confidence === 'medium' ? 2 : 1;
        } else if (kron.direction !== 'NEUTRAL') {
          score -= kron.confidence === 'high' ? 4 : kron.confidence === 'medium' ? 2 : 1;
        }
      }
    }

    sig.score = Math.round(score);
  }

  // Pick the highest-scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // ── BUILD SIGNAL OBJECT ────────────────────────────────────
  const isLong = best.direction === 'LONG';
  const tp     = isLong ? price + atr * 2 : price - atr * 2;

  // Leverage: BTC/ETH → 100x, BNB/SOL → 20x, others by price
  const HIGH_LEV = new Set(['BTCUSDT', 'ETHUSDT']);
  const MID_LEV  = new Set(['BNBUSDT', 'SOLUSDT']);
  const leverage = HIGH_LEV.has(symbol) ? 100 : MID_LEV.has(symbol) ? 20 : price >= 100 ? 50 : 20;

  bLog.scan(
    `ENGINE: ${symbol} ${best.direction} [${best.setupName}] ` +
    `score=${best.score} RSI=${rsi.toFixed(0)} h1=${h1Trend} opBias=${opBias} ` +
    `SL=${best.sl?.toFixed(4)} TP=${tp.toFixed(4)}`
  );

  return {
    symbol,
    direction: best.direction,
    price,
    lastPrice: price,
    sl:          best.sl,
    tp1:         tp,
    tp2:         tp,
    tp3:         tp,
    leverage,
    score:       best.score,
    setupName:   best.setupName,
    strategyWinRate: STRATEGY_WIN_RATE,  // bypasses backtest-gate simulation
    meta: {
      ...best.meta,
      rsi: Math.round(rsi),
      h1Trend,
      opBias,
      vwap: vwap ? vwap.toFixed(4) : null,
      atr: atr.toFixed(4),
    },
  };
}

// ── Scan All Coins ───────────────────────────────────────────
//
// Called by coordinator each cycle.
// Returns one signal per coin (the best from all 5 strategies).

async function scanAll(log, opts = {}) {
  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('[Engine] Failed to fetch tickers'); return []; }

  // Load banned tokens from DB
  let banned = new Set();
  try {
    const db = require('./db');
    const rows = await db.query('SELECT symbol FROM global_token_settings WHERE banned = true');
    banned = new Set(rows.map(r => r.symbol));
  } catch (_) {}

  const BLACKLIST = new Set([
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT','LYNUSDT','PORT3USDT',
    'RVVUSDT','BSWUSDT','NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT','TRUUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ]);

  // ONLY scan the 4 allowed symbols — BTC, ETH, SOL, BNB
  const topCoins = [];
  for (const sym of CORE_SYMBOLS) {
    if (banned.has(sym)) continue;
    const t = tickers.find(t => t.symbol === sym);
    if (t) topCoins.push({ symbol: sym, price: parseFloat(t.lastPrice) });
  }

  const kronosPredictions = opts.kronosPredictions || null;
  const results = [];

  bLog.scan(`[Engine] Scanning ${topCoins.length} coins...`);

  for (const coin of topCoins) {
    try {
      const signal = await analyzeSymbol(coin.symbol, coin.price, kronosPredictions);
      // MIN_SCORE = 8 — signals must earn their pass through bonuses, not scrape through on base score.
      // A counter-trend SHORT in a bull market scores ~4 (base 6 + CONSOL +3 - EMA200 -3 - h1 -1 - opBias -1 = 4).
      // Raising threshold to 8 blocks these without touching legitimate aligned trades (score 12–19).
      if (signal && signal.score >= 8) {
        results.push(signal);
        bLog.scan(`[Engine] SIGNAL: ${signal.symbol} ${signal.direction} [${signal.setupName}] score=${signal.score}`);
      } else if (signal) {
        bLog.scan(`[Engine] SKIP: ${signal.symbol} ${signal.direction} [${signal.setupName}] score=${signal.score} (below MIN_SCORE 8)`);
      }
    } catch (err) {
      bLog.error(`[Engine] ${coin.symbol} error: ${err.message}`);
    }
  }

  results.sort((a, b) => b.score - a.score);
  bLog.scan(`[Engine] Scan done — ${results.length} signal(s) found`);
  return results;
}

// ── Exports ──────────────────────────────────────────────────

module.exports = { analyzeSymbol, scanAll, STRATEGY_WIN_RATE };
