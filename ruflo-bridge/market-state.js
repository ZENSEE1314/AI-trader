// ============================================================
// Market State Encoder — Converts raw market data to vectors
//
// Encodes RSI, MACD, EMA alignment, volume, ATR, price change,
// Bollinger Band position, and Stochastic into a normalized
// Float32Array suitable for HNSW similarity search and Q-Learning
// state hashing.
//
// Dimension: 16 (fixed, optimized for the HNSW index)
// Range: [-1, 1] normalized
// ============================================================

'use strict';

const DIMENSIONS = 16;

/**
 * Encode market indicators into a normalized Float32Array.
 * Missing values default to 0 (neutral).
 *
 * @param {object} indicators - raw market indicator values
 * @returns {Float32Array} 16-dimensional normalized state vector
 */
function encodeMarketState(indicators = {}) {
  const state = new Float32Array(DIMENSIONS);

  // [0] RSI normalized: 0-100 → [-1, 1]
  state[0] = _norm(indicators.rsi, 0, 100);

  // [1] MACD histogram: typically [-2, 2] → [-1, 1]
  state[1] = _clamp(indicators.macdHist || indicators.macd_hist || 0, -2, 2);

  // [2] MACD signal cross: 1 if MACD > signal, -1 if below
  state[2] = indicators.macdCross != null ? (indicators.macdCross ? 1 : -1) : 0;

  // [3] EMA alignment: price relative to EMA (e.g., (price - ema) / ema * 100)
  state[3] = _clamp(indicators.emaAlignment || 0, -5, 5) / 5;

  // [4] Volume ratio: current / average, normalized
  state[4] = _clamp((indicators.volumeRatio || 1) - 1, -2, 2) / 2;

  // [5] ATR relative: atr / price * 100, normalized
  state[5] = _clamp(indicators.atrPct || 0, 0, 5) / 2.5 - 1;

  // [6] Price change %: last N candles
  state[6] = _clamp(indicators.priceChangePct || 0, -10, 10) / 10;

  // [7] Bollinger Band position: (price - lower) / (upper - lower) → [0, 1] → [-1, 1]
  state[7] = _norm(indicators.bbPosition, 0, 1) || 0;

  // [8] Stochastic K: 0-100 → [-1, 1]
  state[8] = _norm(indicators.stochK, 0, 100);

  // [9] Stochastic D: 0-100 → [-1, 1]
  state[9] = _norm(indicators.stochD, 0, 100);

  // [10] ADX strength: 0-100 → [-1, 1]
  state[10] = _norm(indicators.adx, 0, 100);

  // [11] Trend direction: from higher-TF EMA alignment
  state[11] = _clamp(indicators.trendDirection || 0, -1, 1);

  // [12] Candle body ratio: (close-open) / (high-low), sign = direction
  state[12] = _clamp(indicators.bodyRatio || 0, -1, 1);

  // [13] Wick ratio: upper wick / total range
  state[13] = _clamp(indicators.wickRatio || 0, 0, 1) * 2 - 1;

  // [14] Consecutive direction: count of same-direction candles
  state[14] = _clamp(indicators.consecutiveDir || 0, -10, 10) / 10;

  // [15] Sentiment/mood score: -1 (fear) to 1 (greed)
  state[15] = _clamp(indicators.sentiment || 0, -1, 1);

  return state;
}

/**
 * Extract indicators from raw kline (candle) data.
 * Useful when you have klines but not pre-computed indicators.
 *
 * @param {Array} klines - array of [time, open, high, low, close, volume]
 * @param {object} preComputed - any pre-computed indicators to merge
 * @returns {object} indicators suitable for encodeMarketState()
 */
function extractIndicatorsFromKlines(klines, preComputed = {}) {
  if (!klines || klines.length < 14) return preComputed;

  const closes = klines.map(k => parseFloat(k[4]));
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const volumes = klines.map(k => parseFloat(k[5]));
  const opens = klines.map(k => parseFloat(k[1]));

  const lastClose = closes[closes.length - 1];
  const lastOpen = opens[opens.length - 1];
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  // RSI (14-period)
  const rsi = _computeRSI(closes, 14);

  // Price change %
  const priceChangePct = closes.length >= 5
    ? ((lastClose - closes[closes.length - 5]) / closes[closes.length - 5]) * 100
    : 0;

  // Volume ratio
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);
  const volumeRatio = avgVolume > 0 ? volumes[volumes.length - 1] / avgVolume : 1;

  // ATR %
  const atr = _computeATR(highs, lows, closes, 14);
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

  // EMA alignment
  const ema20 = _computeEMA(closes, 20);
  const emaAlignment = ema20 > 0 ? ((lastClose - ema20) / ema20) * 100 : 0;

  // Candle body/wick ratios
  const range = lastHigh - lastLow;
  const bodyRatio = range > 0 ? (lastClose - lastOpen) / range : 0;
  const upperWick = range > 0 ? (lastHigh - Math.max(lastClose, lastOpen)) / range : 0;

  // Consecutive direction
  let consecutiveDir = 0;
  for (let i = closes.length - 1; i >= 1; i--) {
    if (closes[i] > closes[i - 1]) {
      if (consecutiveDir >= 0) consecutiveDir++;
      else break;
    } else if (closes[i] < closes[i - 1]) {
      if (consecutiveDir <= 0) consecutiveDir--;
      else break;
    } else break;
  }

  return {
    rsi,
    priceChangePct,
    volumeRatio,
    atrPct,
    emaAlignment,
    bodyRatio,
    wickRatio: upperWick,
    consecutiveDir,
    ...preComputed,
  };
}

// ── Helper Functions ──────────────────────────────────────

function _norm(val, min, max) {
  if (val == null || isNaN(val)) return 0;
  return ((val - min) / (max - min)) * 2 - 1;
}

function _clamp(val, min, max) {
  if (val == null || isNaN(val)) return 0;
  return Math.max(min, Math.min(max, val));
}

function _computeRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function _computeATR(highs, lows, closes, period) {
  if (highs.length < period + 1) return 0;
  let sum = 0;
  for (let i = highs.length - period; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    sum += tr;
  }
  return sum / period;
}

function _computeEMA(data, period) {
  if (data.length < period) return data[data.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

module.exports = { encodeMarketState, extractIndicatorsFromKlines, DIMENSIONS };
