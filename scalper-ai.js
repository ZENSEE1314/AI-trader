// ============================================================
// Pro Scalper AI — Composite Oscillator Signal Engine
// Port of Pine Script "Pro Scalper AI [BullByte]"
//
// Computes: ADX/DI trend, HMA trend, Stoch RSI momentum,
// ATR volatility, OBV volume → weighted composite oscillator
// → dynamic thresholds → Strong Buy/Sell/Early Buy/Sell
// ============================================================

const { log: bLog } = require('./bot-logger');

// ── Config (matches Pine Script defaults) ───────────────────
const CFG = {
  ADX_LEN: 14,
  DI_LEN: 14,
  ATR_LEN: 14,
  HMA_LEN: 21,
  STOCH_RSI_LEN: 12,
  STOCH_K: 3,
  STOCH_D: 3,
  W_TREND: 0.3,
  W_MOMENTUM: 0.3,
  W_VOLATILITY: 0.2,
  W_VOLUME: 0.2,
  BASE_UPPER: 25.0,
  BASE_LOWER: -25.0,
  DYN_MULT: 0.5,
  OSC_LOOKBACK: 50,
  VOL_LOOKBACK: 50,
  ADX_THRESHOLD: 20,
};

// ── Math Helpers ────────────────────────────────────────────

function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = sma(arr.slice(0, period), period);
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function rma(arr, period) {
  if (arr.length < period) return null;
  let val = sma(arr.slice(0, period), period);
  const alpha = 1 / period;
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * alpha + val * (1 - alpha);
  }
  return val;
}

function wma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0, wSum = 0;
  for (let i = 0; i < period; i++) {
    const w = i + 1;
    sum += arr[arr.length - period + i] * w;
    wSum += w;
  }
  return sum / wSum;
}

function hma(arr, length) {
  const half = Math.round(length / 2);
  const sqrtLen = Math.round(Math.sqrt(length));
  if (arr.length < length + sqrtLen) return null;

  const diff = [];
  for (let i = sqrtLen; i <= arr.length; i++) {
    const slice = arr.slice(0, i);
    const w1 = wma(slice, length);
    const w2 = wma(slice, half);
    if (w1 === null || w2 === null) continue;
    diff.push(2 * w2 - w1);
  }
  if (diff.length < sqrtLen) return null;
  return wma(diff, sqrtLen);
}

function stdev(arr, period) {
  if (arr.length < period) return 0;
  const slice = arr.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function highest(arr, period) {
  if (arr.length < period) return arr.length ? Math.max(...arr) : 0;
  return Math.max(...arr.slice(-period));
}

function lowest(arr, period) {
  if (arr.length < period) return arr.length ? Math.min(...arr) : 0;
  return Math.min(...arr.slice(-period));
}

// ── Indicator Calculations ──────────────────────────────────

function calcTrueRange(highs, lows, closes) {
  const tr = [];
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
    } else {
      tr.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
  }
  return tr;
}

function calcADX(highs, lows, closes, adxLen, diLen) {
  const plusDM = [], minusDM = [], tr = [];

  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      plusDM.push(0); minusDM.push(0);
      tr.push(highs[i] - lows[i]);
      continue;
    }
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  const smoothTR = rma(tr, diLen);
  const smoothPlusDM = rma(plusDM, diLen);
  const smoothMinusDM = rma(minusDM, diLen);

  if (!smoothTR || smoothTR === 0) return { adx: 0, diPlus: 0, diMinus: 0 };

  const diPlus = 100 * smoothPlusDM / smoothTR;
  const diMinus = 100 * smoothMinusDM / smoothTR;
  const diSum = diPlus + diMinus || 1;
  const dx = 100 * Math.abs(diPlus - diMinus) / diSum;

  // Build DX series for RMA
  const dxSeries = [];
  const len = Math.min(tr.length, 100);
  for (let i = tr.length - len; i < tr.length; i++) {
    const sliceTR = tr.slice(0, i + 1);
    const slicePDM = plusDM.slice(0, i + 1);
    const sliceMDM = minusDM.slice(0, i + 1);
    const sTR = rma(sliceTR, diLen) || 1;
    const sPDM = rma(slicePDM, diLen) || 0;
    const sMDM = rma(sliceMDM, diLen) || 0;
    const dp = 100 * sPDM / sTR;
    const dm = 100 * sMDM / sTR;
    const ds = dp + dm || 1;
    dxSeries.push(100 * Math.abs(dp - dm) / ds);
  }

  const adx = rma(dxSeries, adxLen) || 0;
  return { adx, diPlus, diMinus };
}

function calcStochRSI(closes, rsiLen, kLen) {
  if (closes.length < rsiLen + kLen) return 0;

  // RSI
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const avgGain = rma(gains, rsiLen);
  const avgLoss = rma(losses, rsiLen);
  if (!avgGain || !avgLoss) return 0;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsiNow = 100 - 100 / (1 + rs);

  // Build RSI series for stochastic
  const rsiSeries = [];
  for (let i = rsiLen; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const g = [], l = [];
    for (let j = 1; j < slice.length; j++) {
      const d = slice[j] - slice[j - 1];
      g.push(d > 0 ? d : 0);
      l.push(d < 0 ? -d : 0);
    }
    const ag = rma(g, rsiLen);
    const al = rma(l, rsiLen);
    if (!ag || !al) continue;
    const r = al === 0 ? 100 : ag / al;
    rsiSeries.push(100 - 100 / (1 + r));
  }

  if (rsiSeries.length < rsiLen) return 0;

  const lo = lowest(rsiSeries, rsiLen);
  const hi = highest(rsiSeries, rsiLen);
  const range = hi - lo || 0.0001;
  const stoch = (rsiSeries[rsiSeries.length - 1] - lo) / range;

  // SMA smoothing (%K)
  const stochSeries = rsiSeries.slice(-kLen * 2).map((v, i, arr) => {
    const loV = lowest(rsiSeries.slice(0, rsiSeries.length - arr.length + i + 1), rsiLen);
    const hiV = highest(rsiSeries.slice(0, rsiSeries.length - arr.length + i + 1), rsiLen);
    return (v - loV) / (Math.max(hiV - loV, 0.0001));
  });
  const k = sma(stochSeries, kLen) || stoch;

  // Normalize to [-1, 1]
  return (k - 0.5) * 2;
}

function calcOBV(closes, volumes, lookback) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else obv.push(obv[i - 1]);
  }
  const obvMin = lowest(obv, lookback);
  const obvMax = highest(obv, lookback);
  const range = obvMax - obvMin || 0.0001;
  return ((obv[obv.length - 1] - obvMin) / range) * 2 - 1;
}

// ── Main Analysis Function ──────────────────────────────────

/**
 * Analyze klines using the Pro Scalper AI composite oscillator.
 * @param {Array} klines - Binance-format klines [[time, open, high, low, close, volume], ...]
 * @returns {{ signal: string, oscillator: number, adx: number, trendHMA: string, upperThreshold: number, lowerThreshold: number }}
 */
function analyzeScalperAI(klines) {
  if (!klines || klines.length < 60) return null;

  const closes = klines.map(k => parseFloat(k[4]));
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const volumes = klines.map(k => parseFloat(k[5]));

  // 1. ADX & DI
  const { adx, diPlus, diMinus } = calcADX(highs, lows, closes, CFG.ADX_LEN, CFG.DI_LEN);
  const trendDir = diPlus > diMinus ? 1 : diMinus > diPlus ? -1 : 0;
  const normTrend = trendDir * Math.min(Math.max((adx - 20) / 20, 0), 1);

  // 2. ATR volatility
  const tr = calcTrueRange(highs, lows, closes);
  const atr = rma(tr, CFG.ATR_LEN) || 0;
  const normATR = atr / (closes[closes.length - 1] || 1);
  const normVolatility = normATR * 2 - 1;

  // 3. Momentum (Stoch RSI)
  const momentum = calcStochRSI(closes, CFG.STOCH_RSI_LEN, CFG.STOCH_K);

  // 4. Volume (OBV normalized)
  const volumeNorm = calcOBV(closes, volumes, CFG.VOL_LOOKBACK);

  // 5. Composite oscillator (weighted)
  const totalW = CFG.W_TREND + CFG.W_MOMENTUM + CFG.W_VOLATILITY + CFG.W_VOLUME;
  const oscRaw = (
    CFG.W_TREND * normTrend +
    CFG.W_MOMENTUM * momentum +
    CFG.W_VOLATILITY * normVolatility +
    CFG.W_VOLUME * volumeNorm
  ) / totalW;
  const oscillator = oscRaw * 100;

  // 6. Dynamic thresholds
  const oscHistory = [];
  const histLen = Math.min(CFG.OSC_LOOKBACK, closes.length - 30);
  for (let i = closes.length - histLen; i < closes.length; i++) {
    const sliceC = closes.slice(0, i + 1);
    const sliceH = highs.slice(0, i + 1);
    const sliceL = lows.slice(0, i + 1);
    const sliceV = volumes.slice(0, i + 1);
    const a = calcADX(sliceH, sliceL, sliceC, CFG.ADX_LEN, CFG.DI_LEN);
    const td = a.diPlus > a.diMinus ? 1 : a.diMinus > a.diPlus ? -1 : 0;
    const nt = td * Math.min(Math.max((a.adx - 20) / 20, 0), 1);
    const t = calcTrueRange(sliceH, sliceL, sliceC);
    const at = rma(t, CFG.ATR_LEN) || 0;
    const nv = at / (sliceC[sliceC.length - 1] || 1) * 2 - 1;
    const m = calcStochRSI(sliceC, CFG.STOCH_RSI_LEN, CFG.STOCH_K);
    const vo = calcOBV(sliceC, sliceV, Math.min(CFG.VOL_LOOKBACK, sliceC.length));
    oscHistory.push(((CFG.W_TREND * nt + CFG.W_MOMENTUM * m + CFG.W_VOLATILITY * nv + CFG.W_VOLUME * vo) / totalW) * 100);
  }
  const oscStd = oscHistory.length >= 10 ? stdev(oscHistory, oscHistory.length) : 5;
  const upperThreshold = CFG.BASE_UPPER + oscStd * CFG.DYN_MULT;
  const lowerThreshold = CFG.BASE_LOWER - oscStd * CFG.DYN_MULT;

  // 7. HMA trend
  const hmaVal = hma(closes, CFG.HMA_LEN);
  const lastClose = closes[closes.length - 1];
  const trendHMA = hmaVal ? (lastClose > hmaVal ? 'bullish' : lastClose < hmaVal ? 'bearish' : 'flat') : 'flat';

  // 8. Signal generation
  const isStrongBuy = oscillator > upperThreshold && trendHMA === 'bullish' && adx > CFG.ADX_THRESHOLD;
  const isStrongSell = oscillator < lowerThreshold && trendHMA === 'bearish' && adx > CFG.ADX_THRESHOLD;
  const isEarlyBuy = oscillator > CFG.BASE_UPPER && oscillator <= upperThreshold;
  const isEarlySell = oscillator < CFG.BASE_LOWER && oscillator >= lowerThreshold;

  let signal = 'No Signal';
  if (isStrongBuy) signal = 'Strong Buy';
  else if (isStrongSell) signal = 'Strong Sell';
  else if (isEarlyBuy) signal = 'Early Buy';
  else if (isEarlySell) signal = 'Early Sell';

  return {
    signal,
    oscillator: Math.round(oscillator * 100) / 100,
    adx: Math.round(adx * 100) / 100,
    trendHMA,
    momentum: Math.round(momentum * 100) / 100,
    volumeNorm: Math.round(volumeNorm * 100) / 100,
    upperThreshold: Math.round(upperThreshold * 100) / 100,
    lowerThreshold: Math.round(lowerThreshold * 100) / 100,
  };
}

/**
 * Quick check: does the scalper AI confirm the SMC direction?
 * @param {Array} klines15m - 15-minute klines
 * @param {string} direction - 'LONG' or 'SHORT'
 * @returns {{ confirmed: boolean, signal: string, score: number, details: object }}
 */
function confirmSignal(klines15m, direction) {
  const result = analyzeScalperAI(klines15m);
  if (!result) return { confirmed: true, signal: 'N/A', score: 0, details: null };

  const { signal, oscillator, adx } = result;

  // Score bonus: Strong signal in same direction = +3, Early = +1
  // Conflicting strong signal = -5 (blocks trade)
  let scoreBonus = 0;
  let confirmed = true;

  if (direction === 'LONG') {
    if (signal === 'Strong Buy') scoreBonus = 3;
    else if (signal === 'Early Buy') scoreBonus = 1;
    else if (signal === 'Strong Sell') { scoreBonus = -5; confirmed = false; }
  } else {
    if (signal === 'Strong Sell') scoreBonus = 3;
    else if (signal === 'Early Sell') scoreBonus = 1;
    else if (signal === 'Strong Buy') { scoreBonus = -5; confirmed = false; }
  }

  return { confirmed, signal, score: scoreBonus, details: result };
}

module.exports = { analyzeScalperAI, confirmSignal };
