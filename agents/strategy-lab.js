// ============================================================
// StrategyLab — AI-Powered Strategy Factory
//
// Discovers, generates, evolves, and validates trading strategies.
// Uses AI brain + web search to learn new techniques.
// Creates dynamic scan functions from indicator recipes.
//
// Capabilities:
//   1. Web search for trading strategies, indicators, patterns
//   2. AI-generated indicator combinations
//   3. Genetic evolution — mutate winners, kill losers
//   4. Dynamic strategy compilation (recipe -> scan function)
//   5. Strategy DNA storage in DB for persistence
// ============================================================

const fetch = require('node-fetch');

// Indicator building blocks — each returns an array of values
const INDICATOR_LIB = {
  ema: (closes, period) => {
    const k = 2 / (period + 1);
    const ema = [closes[0]];
    for (let i = 1; i < closes.length; i++) {
      ema.push(closes[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  },

  sma: (closes, period) => {
    const sma = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) { sma.push(closes[i]); continue; }
      const slice = closes.slice(i - period + 1, i + 1);
      sma.push(slice.reduce((a, b) => a + b) / period);
    }
    return sma;
  },

  rsi: (closes, period = 14) => {
    const rsi = new Array(closes.length).fill(50);
    if (closes.length < period + 1) return rsi;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period;
    avgLoss /= period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
      rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return rsi;
  },

  macd: (closes) => {
    const ema12 = INDICATOR_LIB.ema(closes, 12);
    const ema26 = INDICATOR_LIB.ema(closes, 26);
    const line = ema12.map((v, i) => v - ema26[i]);
    const signal = INDICATOR_LIB.ema(line, 9);
    const hist = line.map((v, i) => v - signal[i]);
    return { line, signal, hist };
  },

  bb: (closes, period = 20, mult = 2) => {
    const upper = [], middle = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) {
        upper.push(closes[i]); middle.push(closes[i]); lower.push(closes[i]);
        continue;
      }
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b) / period;
      const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
      upper.push(mean + mult * std);
      middle.push(mean);
      lower.push(mean - mult * std);
    }
    return { upper, middle, lower };
  },

  stochastic: (closes, highs, lows, kPeriod = 14, dPeriod = 3) => {
    const k = new Array(closes.length).fill(50);
    for (let i = kPeriod - 1; i < closes.length; i++) {
      const hSlice = highs.slice(i - kPeriod + 1, i + 1);
      const lSlice = lows.slice(i - kPeriod + 1, i + 1);
      const highest = Math.max(...hSlice);
      const lowest = Math.min(...lSlice);
      k[i] = highest === lowest ? 50 : ((closes[i] - lowest) / (highest - lowest)) * 100;
    }
    const d = INDICATOR_LIB.sma(k, dPeriod);
    return { k, d };
  },

  atr: (highs, lows, closes, period = 14) => {
    const tr = [highs[0] - lows[0]];
    for (let i = 1; i < closes.length; i++) {
      tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    const atr = new Array(closes.length).fill(0);
    let sum = 0;
    for (let i = 0; i < Math.min(period, tr.length); i++) sum += tr[i];
    atr[period - 1] = sum / period;
    for (let i = period; i < tr.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
    return atr;
  },

  vwap: (closes, volumes) => {
    const vwap = [];
    let cumVol = 0, cumTP = 0;
    for (let i = 0; i < closes.length; i++) {
      cumTP += closes[i] * (volumes[i] || 1);
      cumVol += volumes[i] || 1;
      vwap.push(cumVol > 0 ? cumTP / cumVol : closes[i]);
    }
    return vwap;
  },

  adx: (highs, lows, closes, period = 14) => {
    const adx = new Array(closes.length).fill(20);
    if (closes.length < period * 3) return adx;
    const tr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < closes.length; i++) {
      tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
      const up = highs[i] - highs[i - 1];
      const down = lows[i - 1] - lows[i];
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
    }
    let atr = tr.slice(0, period).reduce((a, b) => a + b) / period;
    let aPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b) / period;
    let aMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b) / period;
    const dx = [];
    for (let i = period; i < tr.length; i++) {
      atr = (atr * (period - 1) + tr[i]) / period;
      aPlusDM = (aPlusDM * (period - 1) + plusDM[i]) / period;
      aMinusDM = (aMinusDM * (period - 1) + minusDM[i]) / period;
      const pdi = atr > 0 ? (aPlusDM / atr) * 100 : 0;
      const mdi = atr > 0 ? (aMinusDM / atr) * 100 : 0;
      const sum = pdi + mdi;
      dx.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0);
    }
    let adxVal = dx.length >= period ? dx.slice(0, period).reduce((a, b) => a + b) / period : 20;
    for (let i = period; i < dx.length; i++) {
      adxVal = (adxVal * (period - 1) + dx[i]) / period;
      if (i + 1 + period < adx.length) adx[i + 1 + period] = adxVal;
    }
    return adx;
  },

  swingDetect: (highs, lows, len = 5) => {
    const swings = [];
    let lastType = null;
    for (let j = len; j < highs.length - len; j++) {
      let isHigh = true, isLow = true;
      for (let k = -len; k <= len; k++) {
        if (k === 0) continue;
        if (highs[j] <= highs[j + k]) isHigh = false;
        if (lows[j] >= lows[j + k]) isLow = false;
      }
      if (isHigh && isLow) {
        const hd = highs[j] - Math.max(highs[j - 1], highs[j + 1]);
        const ld = Math.min(lows[j - 1], lows[j + 1]) - lows[j];
        if (hd > ld) isLow = false; else isHigh = false;
      }
      if (isHigh) {
        if (lastType === 'high') {
          if (highs[j] > swings[swings.length - 1].price) {
            swings[swings.length - 1] = { type: 'high', price: highs[j], index: j };
          }
        } else {
          swings.push({ type: 'high', price: highs[j], index: j });
          lastType = 'high';
        }
      }
      if (isLow) {
        if (lastType === 'low') {
          if (lows[j] < swings[swings.length - 1].price) {
            swings[swings.length - 1] = { type: 'low', price: lows[j], index: j };
          }
        } else {
          swings.push({ type: 'low', price: lows[j], index: j });
          lastType = 'low';
        }
      }
    }
    return swings;
  },
};

// Strategy recipe templates — building blocks AI can combine
const RECIPE_TEMPLATES = [
  // Trend following
  { type: 'ema_cross', indicators: ['ema_fast', 'ema_slow'], logic: 'cross', description: 'EMA crossover' },
  { type: 'ema_ribbon', indicators: ['ema_fast', 'ema_mid', 'ema_slow'], logic: 'alignment', description: 'Triple EMA alignment' },
  { type: 'macd_cross', indicators: ['macd'], logic: 'signal_cross', description: 'MACD signal line cross' },
  { type: 'adx_trend', indicators: ['adx', 'ema_fast'], logic: 'trend_strength', description: 'ADX trend + EMA direction' },
  // Mean reversion
  { type: 'rsi_extreme', indicators: ['rsi'], logic: 'oversold_overbought', description: 'RSI extreme bounce' },
  { type: 'bb_bounce', indicators: ['bb', 'rsi'], logic: 'band_touch_rsi', description: 'BB band + RSI filter' },
  { type: 'stoch_cross', indicators: ['stochastic'], logic: 'kd_cross', description: 'Stochastic K/D cross' },
  // Structure
  { type: 'swing_structure', indicators: ['swings'], logic: 'hh_hl', description: 'Swing HH/HL structure' },
  { type: 'swing_rsi', indicators: ['swings', 'rsi'], logic: 'structure_rsi', description: 'Swing structure + RSI' },
  { type: 'swing_ema', indicators: ['swings', 'ema_fast', 'ema_slow'], logic: 'structure_ema', description: 'Swing + EMA trend' },
  // Momentum
  { type: 'rsi_macd', indicators: ['rsi', 'macd'], logic: 'dual_momentum', description: 'RSI + MACD agreement' },
  { type: 'macd_bb', indicators: ['macd', 'bb'], logic: 'momentum_band', description: 'MACD momentum at BB level' },
  // Volatility
  { type: 'atr_breakout', indicators: ['atr', 'ema_fast'], logic: 'volatility_break', description: 'ATR breakout above EMA' },
  { type: 'bb_squeeze', indicators: ['bb', 'macd'], logic: 'squeeze_momentum', description: 'BB squeeze + MACD expansion' },
  // Composite scoring
  { type: 'multi_score', indicators: ['ema_fast', 'ema_slow', 'rsi', 'macd', 'bb', 'adx'], logic: 'weighted_score', description: 'Multi-indicator weighted score' },
  { type: 'vwap_rsi', indicators: ['vwap', 'rsi'], logic: 'vwap_zone', description: 'VWAP zone + RSI filter' },
];

// Parameter ranges for genetic evolution
const PARAM_RANGES = {
  ema_fast: [5, 7, 8, 9, 10, 12],
  ema_mid: [15, 18, 20, 21, 25],
  ema_slow: [30, 40, 50, 55, 60, 100, 200],
  rsi_period: [7, 9, 14, 21],
  rsi_ob: [65, 70, 75, 80],
  rsi_os: [20, 25, 30, 35],
  bb_period: [15, 20, 25, 30],
  bb_mult: [1.5, 2, 2.5, 3],
  stoch_k: [9, 14, 21],
  stoch_d: [3, 5, 7],
  adx_threshold: [15, 20, 25, 30],
  swing_len: [3, 4, 5, 6, 7, 8],
  atr_period: [10, 14, 20],
  atr_mult: [1.0, 1.5, 2.0, 2.5],
  score_threshold: [3, 4, 5, 6, 7],
  tp_pct: [0.005, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025],
  sl_pct: [0.003, 0.004, 0.005, 0.007, 0.008, 0.01, 0.012, 0.015],
};

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomParams() {
  return {
    ema_fast: randomPick(PARAM_RANGES.ema_fast),
    ema_mid: randomPick(PARAM_RANGES.ema_mid),
    ema_slow: randomPick(PARAM_RANGES.ema_slow),
    rsi_period: randomPick(PARAM_RANGES.rsi_period),
    rsi_ob: randomPick(PARAM_RANGES.rsi_ob),
    rsi_os: randomPick(PARAM_RANGES.rsi_os),
    bb_period: randomPick(PARAM_RANGES.bb_period),
    bb_mult: randomPick(PARAM_RANGES.bb_mult),
    stoch_k: randomPick(PARAM_RANGES.stoch_k),
    stoch_d: randomPick(PARAM_RANGES.stoch_d),
    adx_threshold: randomPick(PARAM_RANGES.adx_threshold),
    swing_len: randomPick(PARAM_RANGES.swing_len),
    atr_period: randomPick(PARAM_RANGES.atr_period),
    atr_mult: randomPick(PARAM_RANGES.atr_mult),
    score_threshold: randomPick(PARAM_RANGES.score_threshold),
    tp_pct: randomPick(PARAM_RANGES.tp_pct),
    sl_pct: randomPick(PARAM_RANGES.sl_pct),
  };
}

// Compile a recipe + params into a scan function
function compileStrategy(recipe, params) {
  const p = params;
  const minBars = Math.max(p.ema_slow + 5, 55);

  return function scan(closes, highs, lows, i) {
    if (i < minBars) return null;

    const slice = closes.slice(0, i + 1);
    const hSlice = highs.slice(0, i + 1);
    const lSlice = lows.slice(0, i + 1);

    switch (recipe.logic) {
      case 'cross': {
        const fast = INDICATOR_LIB.ema(slice, p.ema_fast);
        const slow = INDICATOR_LIB.ema(slice, p.ema_slow);
        const trend = INDICATOR_LIB.ema(slice, p.ema_slow);
        if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i] && closes[i] > trend[i]) return 'LONG';
        if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i] && closes[i] < trend[i]) return 'SHORT';
        return null;
      }

      case 'alignment': {
        const fast = INDICATOR_LIB.ema(slice, p.ema_fast);
        const mid = INDICATOR_LIB.ema(slice, p.ema_mid);
        const slow = INDICATOR_LIB.ema(slice, p.ema_slow);
        if (fast[i] > mid[i] && mid[i] > slow[i] && closes[i] > fast[i]) return 'LONG';
        if (fast[i] < mid[i] && mid[i] < slow[i] && closes[i] < fast[i]) return 'SHORT';
        return null;
      }

      case 'signal_cross': {
        const { line, signal } = INDICATOR_LIB.macd(slice);
        const adx = INDICATOR_LIB.adx(hSlice, lSlice, slice, 14);
        if (adx[adx.length - 1] < p.adx_threshold) return null;
        if (line[line.length - 2] <= signal[signal.length - 2] && line[line.length - 1] > signal[signal.length - 1]) return 'LONG';
        if (line[line.length - 2] >= signal[signal.length - 2] && line[line.length - 1] < signal[signal.length - 1]) return 'SHORT';
        return null;
      }

      case 'trend_strength': {
        const adx = INDICATOR_LIB.adx(hSlice, lSlice, slice, 14);
        const fast = INDICATOR_LIB.ema(slice, p.ema_fast);
        const slow = INDICATOR_LIB.ema(slice, p.ema_slow);
        if (adx[adx.length - 1] < p.adx_threshold) return null;
        if (fast[i] > slow[i] && fast[i] > fast[i - 1]) return 'LONG';
        if (fast[i] < slow[i] && fast[i] < fast[i - 1]) return 'SHORT';
        return null;
      }

      case 'oversold_overbought': {
        const rsi = INDICATOR_LIB.rsi(slice, p.rsi_period);
        const curr = rsi[rsi.length - 1];
        const prev = rsi[rsi.length - 2];
        const prev2 = rsi[rsi.length - 3];
        if (prev2 < p.rsi_os && prev < p.rsi_os + 5 && curr > p.rsi_os + 5 && curr > prev) return 'LONG';
        if (prev2 > p.rsi_ob && prev > p.rsi_ob - 5 && curr < p.rsi_ob - 5 && curr < prev) return 'SHORT';
        return null;
      }

      case 'band_touch_rsi': {
        const bb = INDICATOR_LIB.bb(slice, p.bb_period, p.bb_mult);
        const rsi = INDICATOR_LIB.rsi(slice, p.rsi_period);
        const rsiVal = rsi[rsi.length - 1];
        const lower = bb.lower[bb.lower.length - 1];
        const upper = bb.upper[bb.upper.length - 1];
        const range = upper - lower;
        if (range <= 0) return null;
        if (closes[i] <= lower + range * 0.1 && rsiVal < p.rsi_ob && rsiVal > p.rsi_os && closes[i] > closes[i - 1]) return 'LONG';
        if (closes[i] >= upper - range * 0.1 && rsiVal > p.rsi_os && rsiVal < p.rsi_ob && closes[i] < closes[i - 1]) return 'SHORT';
        return null;
      }

      case 'kd_cross': {
        const { k, d } = INDICATOR_LIB.stochastic(slice, hSlice, lSlice, p.stoch_k, p.stoch_d);
        if (k[i - 1] <= d[i - 1] && k[i] > d[i] && k[i] < 30) return 'LONG';
        if (k[i - 1] >= d[i - 1] && k[i] < d[i] && k[i] > 70) return 'SHORT';
        return null;
      }

      case 'hh_hl': {
        const swings = INDICATOR_LIB.swingDetect(hSlice, lSlice, p.swing_len);
        const sh = swings.filter(s => s.type === 'high');
        const sl = swings.filter(s => s.type === 'low');
        if (sh.length < 2 || sl.length < 2) return null;
        const isHH = sh[sh.length - 1].price > sh[sh.length - 2].price;
        const isHL = sl[sl.length - 1].price > sl[sl.length - 2].price;
        const isLH = sh[sh.length - 1].price < sh[sh.length - 2].price;
        const isLL = sl[sl.length - 1].price < sl[sl.length - 2].price;
        const lastSwingAge = i - Math.max(sh[sh.length - 1].index, sl[sl.length - 1].index);
        if (lastSwingAge > p.swing_len + 5) return null;
        if (isHH && isHL) return 'LONG';
        if (isLH && isLL) return 'SHORT';
        return null;
      }

      case 'structure_rsi': {
        const swings = INDICATOR_LIB.swingDetect(hSlice, lSlice, p.swing_len);
        const sh = swings.filter(s => s.type === 'high');
        const slo = swings.filter(s => s.type === 'low');
        if (sh.length < 2 || slo.length < 2) return null;
        const isHH = sh[sh.length - 1].price > sh[sh.length - 2].price;
        const isHL = slo[slo.length - 1].price > slo[slo.length - 2].price;
        const isLH = sh[sh.length - 1].price < sh[sh.length - 2].price;
        const isLL = slo[slo.length - 1].price < slo[slo.length - 2].price;
        const rsi = INDICATOR_LIB.rsi(slice, p.rsi_period);
        const rsiVal = rsi[rsi.length - 1];
        if (isHH && isHL && rsiVal < p.rsi_ob) return 'LONG';
        if (isLH && isLL && rsiVal > p.rsi_os) return 'SHORT';
        return null;
      }

      case 'structure_ema': {
        const swings = INDICATOR_LIB.swingDetect(hSlice, lSlice, p.swing_len);
        const sh = swings.filter(s => s.type === 'high');
        const slo = swings.filter(s => s.type === 'low');
        if (sh.length < 2 || slo.length < 2) return null;
        const isHH = sh[sh.length - 1].price > sh[sh.length - 2].price;
        const isHL = slo[slo.length - 1].price > slo[slo.length - 2].price;
        const isLH = sh[sh.length - 1].price < sh[sh.length - 2].price;
        const isLL = slo[slo.length - 1].price < slo[slo.length - 2].price;
        const fast = INDICATOR_LIB.ema(slice, p.ema_fast);
        const slow = INDICATOR_LIB.ema(slice, p.ema_slow);
        if (isHH && isHL && fast[i] > slow[i]) return 'LONG';
        if (isLH && isLL && fast[i] < slow[i]) return 'SHORT';
        return null;
      }

      case 'dual_momentum': {
        const rsi = INDICATOR_LIB.rsi(slice, p.rsi_period);
        const rsiVal = rsi[rsi.length - 1];
        const { line, signal } = INDICATOR_LIB.macd(slice);
        const macdBull = line[line.length - 1] > signal[signal.length - 1];
        if (macdBull && rsiVal > 50 && rsiVal < p.rsi_ob) return 'LONG';
        if (!macdBull && rsiVal < 50 && rsiVal > p.rsi_os) return 'SHORT';
        return null;
      }

      case 'momentum_band': {
        const { line, signal, hist } = INDICATOR_LIB.macd(slice);
        const bb = INDICATOR_LIB.bb(slice, p.bb_period, p.bb_mult);
        const lower = bb.lower[bb.lower.length - 1];
        const upper = bb.upper[bb.upper.length - 1];
        const expanding = Math.abs(hist[hist.length - 1]) > Math.abs(hist[hist.length - 2]);
        if (line[line.length - 1] > signal[signal.length - 1] && closes[i] < lower * 1.01 && expanding) return 'LONG';
        if (line[line.length - 1] < signal[signal.length - 1] && closes[i] > upper * 0.99 && expanding) return 'SHORT';
        return null;
      }

      case 'volatility_break': {
        const atr = INDICATOR_LIB.atr(hSlice, lSlice, slice, p.atr_period);
        const fast = INDICATOR_LIB.ema(slice, p.ema_fast);
        const atrVal = atr[atr.length - 1];
        const breakUp = closes[i] > fast[i] + atrVal * p.atr_mult;
        const breakDown = closes[i] < fast[i] - atrVal * p.atr_mult;
        if (breakUp && closes[i] > closes[i - 1]) return 'LONG';
        if (breakDown && closes[i] < closes[i - 1]) return 'SHORT';
        return null;
      }

      case 'squeeze_momentum': {
        const bb = INDICATOR_LIB.bb(slice, p.bb_period, p.bb_mult);
        const { hist } = INDICATOR_LIB.macd(slice);
        const bbWidth = (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1];
        const prevWidth = (bb.upper[bb.upper.length - 2] - bb.lower[bb.lower.length - 2]) / bb.middle[bb.middle.length - 2];
        const expanding = bbWidth > prevWidth;
        const histUp = hist[hist.length - 1] > 0 && hist[hist.length - 1] > hist[hist.length - 2];
        const histDown = hist[hist.length - 1] < 0 && hist[hist.length - 1] < hist[hist.length - 2];
        if (expanding && histUp) return 'LONG';
        if (expanding && histDown) return 'SHORT';
        return null;
      }

      case 'weighted_score': {
        let score = 0;
        const fast = INDICATOR_LIB.ema(slice, p.ema_fast);
        const slow = INDICATOR_LIB.ema(slice, p.ema_slow);
        if (closes[i] > fast[i] && fast[i] > slow[i]) score += 2;
        else if (closes[i] < fast[i] && fast[i] < slow[i]) score -= 2;

        const rsi = INDICATOR_LIB.rsi(slice, p.rsi_period);
        const rsiVal = rsi[rsi.length - 1];
        if (rsiVal > 55 && rsiVal < p.rsi_ob) score += 1;
        else if (rsiVal < 45 && rsiVal > p.rsi_os) score -= 1;

        const { line, signal, hist } = INDICATOR_LIB.macd(slice);
        if (line[line.length - 1] > signal[signal.length - 1]) score += 2;
        else score -= 2;
        if (hist[hist.length - 1] > hist[hist.length - 2]) score += 1;
        else score -= 1;

        const bb = INDICATOR_LIB.bb(slice, p.bb_period, p.bb_mult);
        const bbRange = bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1];
        if (bbRange > 0) {
          const pos = (closes[i] - bb.lower[bb.lower.length - 1]) / bbRange;
          if (pos < 0.2) score += 1;
          else if (pos > 0.8) score -= 1;
        }

        const adx = INDICATOR_LIB.adx(hSlice, lSlice, slice, 14);
        if (adx[adx.length - 1] > p.adx_threshold) score = Math.round(score * 1.5);
        else if (adx[adx.length - 1] < 15) score = Math.round(score * 0.5);

        if (score >= p.score_threshold) return 'LONG';
        if (score <= -p.score_threshold) return 'SHORT';
        return null;
      }

      case 'vwap_zone': {
        const rsi = INDICATOR_LIB.rsi(slice, p.rsi_period);
        const rsiVal = rsi[rsi.length - 1];
        const fast = INDICATOR_LIB.ema(slice, p.ema_fast);
        const slow = INDICATOR_LIB.ema(slice, p.ema_slow);
        const trend = fast[i] > slow[i] ? 'bull' : fast[i] < slow[i] ? 'bear' : null;
        if (!trend) return null;
        if (trend === 'bull' && closes[i] > fast[i] && rsiVal > 50 && rsiVal < p.rsi_ob) return 'LONG';
        if (trend === 'bear' && closes[i] < fast[i] && rsiVal < 50 && rsiVal > p.rsi_os) return 'SHORT';
        return null;
      }

      default:
        return null;
    }
  };
}

// Generate a random new strategy
function generateStrategy() {
  const recipe = randomPick(RECIPE_TEMPLATES);
  const params = randomParams();
  const name = `${recipe.description} [${recipe.type}_${Date.now().toString(36).slice(-4)}]`;
  const scan = compileStrategy(recipe, params);

  return {
    id: `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    recipe: recipe.type,
    recipeDescription: recipe.description,
    params,
    scan,
    generation: 1,
    parentId: null,
    source: 'random',
    createdAt: Date.now(),
  };
}

// Mutate a winning strategy — small tweaks to parameters
function evolveStrategy(parent) {
  const params = { ...parent.params };

  // Mutate 2-4 random parameters
  const mutations = 2 + Math.floor(Math.random() * 3);
  const keys = Object.keys(PARAM_RANGES);
  for (let m = 0; m < mutations; m++) {
    const key = randomPick(keys);
    if (PARAM_RANGES[key]) {
      params[key] = randomPick(PARAM_RANGES[key]);
    }
  }

  const recipe = RECIPE_TEMPLATES.find(r => r.type === parent.recipe) || randomPick(RECIPE_TEMPLATES);
  const scan = compileStrategy(recipe, params);

  return {
    id: `evo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: `${parent.name.split(' [')[0]} [evo_${Date.now().toString(36).slice(-4)}]`,
    recipe: parent.recipe,
    recipeDescription: parent.recipeDescription || recipe.description,
    params,
    scan,
    generation: (parent.generation || 1) + 1,
    parentId: parent.id,
    source: 'evolution',
    createdAt: Date.now(),
  };
}

// Crossover — combine two parents
function crossoverStrategy(parent1, parent2) {
  const params = {};
  const keys = Object.keys(parent1.params);
  for (const key of keys) {
    params[key] = Math.random() > 0.5 ? parent1.params[key] : (parent2.params[key] ?? parent1.params[key]);
  }

  const recipe = Math.random() > 0.5 ? parent1.recipe : parent2.recipe;
  const tmpl = RECIPE_TEMPLATES.find(r => r.type === recipe) || RECIPE_TEMPLATES[0];
  const scan = compileStrategy(tmpl, params);

  return {
    id: `cross_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: `Crossover [${recipe}_${Date.now().toString(36).slice(-4)}]`,
    recipe,
    recipeDescription: tmpl.description,
    params,
    scan,
    generation: Math.max(parent1.generation || 1, parent2.generation || 1) + 1,
    parentId: `${parent1.id}+${parent2.id}`,
    source: 'crossover',
    createdAt: Date.now(),
  };
}

// Create strategy from AI-suggested recipe
function createFromAiSuggestion(suggestion) {
  const matchedRecipe = RECIPE_TEMPLATES.find(r =>
    suggestion.toLowerCase().includes(r.type) ||
    suggestion.toLowerCase().includes(r.description.toLowerCase())
  ) || randomPick(RECIPE_TEMPLATES);

  const params = randomParams();

  // Try to extract specific parameters from the suggestion
  const numMatch = suggestion.match(/ema\s*(\d+)/i);
  if (numMatch) params.ema_fast = parseInt(numMatch[1]) || params.ema_fast;
  const rsiMatch = suggestion.match(/rsi\s*(\d+)/i);
  if (rsiMatch) params.rsi_period = parseInt(rsiMatch[1]) || params.rsi_period;

  const scan = compileStrategy(matchedRecipe, params);

  return {
    id: `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: `AI: ${matchedRecipe.description} [ai_${Date.now().toString(36).slice(-4)}]`,
    recipe: matchedRecipe.type,
    recipeDescription: matchedRecipe.description,
    params,
    scan,
    generation: 1,
    parentId: null,
    source: 'ai_discovery',
    aiSuggestion: suggestion.slice(0, 200),
    createdAt: Date.now(),
  };
}

// Recompile a saved strategy from its recipe + params
function recompileStrategy(saved) {
  const recipe = RECIPE_TEMPLATES.find(r => r.type === saved.recipe);
  if (!recipe) return null;
  const scan = compileStrategy(recipe, saved.params);
  return { ...saved, scan };
}

// Search for trading knowledge online
async function searchTradingKnowledge(topic = 'crypto trading strategy') {
  const queries = [
    `best ${topic} 2025 2026 high win rate`,
    `profitable crypto ${topic} indicator settings`,
    `${topic} backtest results parameters`,
  ];

  const results = [];
  for (const q of queries) {
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=5`;
      const res = await fetch(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)' },
      });
      if (res.ok) {
        const html = await res.text();
        // Extract useful snippets
        const snippets = html.match(/<span[^>]*>([^<]{50,300})<\/span>/g) || [];
        for (const s of snippets.slice(0, 3)) {
          const text = s.replace(/<[^>]+>/g, '').trim();
          if (text.length > 30 && (text.includes('EMA') || text.includes('RSI') || text.includes('MACD') ||
              text.includes('strategy') || text.includes('indicator') || text.includes('trading'))) {
            results.push(text);
          }
        }
      }
    } catch {
      // Web search failed — continue with AI knowledge
    }
  }
  return results;
}

// Use AI brain to discover new strategy ideas
async function aiDiscoverStrategies() {
  try {
    const { think, isAvailable } = require('./ai-brain');
    if (!isAvailable()) return [];

    const response = await think({
      agentName: 'StrategyLab',
      systemPrompt: `You are an expert quantitative trading researcher specializing in crypto futures.
Your job is to suggest novel trading strategy ideas combining technical indicators.
Each strategy should be practical and backtestable.`,
      userMessage: `Suggest 3 novel crypto trading strategies. For each, provide:
1. A short name
2. Which indicators to use (from: EMA, SMA, RSI, MACD, Bollinger Bands, Stochastic, ADX, ATR, VWAP, Swing Structure)
3. Entry logic (when to LONG, when to SHORT)
4. Recommended parameter ranges
5. Why this combination works

Focus on strategies that work in volatile crypto markets on 3m-15m timeframes.
Be specific about parameter values. Format each strategy as a numbered list.`,
      context: {},
      complexity: 'high',
    });

    if (!response) return [];

    // Parse suggestions into strategy ideas
    const ideas = [];
    const sections = response.split(/\d+\.\s+/);
    for (const section of sections) {
      if (section.trim().length > 20) {
        ideas.push(section.trim().slice(0, 500));
      }
    }
    return ideas.slice(0, 5);
  } catch {
    return [];
  }
}

module.exports = {
  INDICATOR_LIB,
  RECIPE_TEMPLATES,
  PARAM_RANGES,
  generateStrategy,
  evolveStrategy,
  crossoverStrategy,
  createFromAiSuggestion,
  recompileStrategy,
  compileStrategy,
  searchTradingKnowledge,
  aiDiscoverStrategies,
};
