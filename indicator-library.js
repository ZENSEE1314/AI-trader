// ============================================================
// Indicator Library
//
// Two exports:
//   INDICATOR_LIBRARY  — metadata array consumed by the admin UI
//   indicators         — execution functions called by strategy-runner.js
//
// Param convention (matches the existing STRATEGY_SCHEMA pattern):
//   default   — raw decimal  (e.g. 0.0012 for 0.12%)
//   scale     — UI multiplier (100 for %, 1 for counts)
//   min/max/step — display-space values (0.05 = 0.05%)
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const REQUEST_TIMEOUT = 12000;

// ─────────────────────────────────────────────────────────────
// INDICATOR_LIBRARY — UI metadata
// ─────────────────────────────────────────────────────────────

const INDICATOR_LIBRARY = [
  // ── Gates (run first — if fail, skip symbol entirely) ──────
  {
    id: 'session_gate', name: 'Session Time Gate', role: 'gate',
    description: 'Only trade during specific UTC session windows (Asia / Europe / US). Each session is configurable.',
    params: [
      { key: 'asia_start',   label: 'Asia Start',    type: 'number', unit: 'h UTC',  scale: 1,   default: 23,    min: 0,  max: 23,  step: 1 },
      { key: 'asia_end',     label: 'Asia End',      type: 'number', unit: 'h UTC',  scale: 1,   default: 2,     min: 0,  max: 23,  step: 1 },
      { key: 'europe_start', label: 'EU Start',      type: 'number', unit: 'h UTC',  scale: 1,   default: 7,     min: 0,  max: 23,  step: 1 },
      { key: 'europe_end',   label: 'EU End',        type: 'number', unit: 'h UTC',  scale: 1,   default: 10,    min: 0,  max: 23,  step: 1 },
      { key: 'us_start',     label: 'US Start',      type: 'number', unit: 'h UTC',  scale: 1,   default: 12,    min: 0,  max: 23,  step: 1 },
      { key: 'us_end',       label: 'US End',        type: 'number', unit: 'h UTC',  scale: 1,   default: 16,    min: 0,  max: 23,  step: 1 },
      { key: 'grace_ms',     label: 'Grace Period',  type: 'number', unit: 'ms',     scale: 1,   default: 90000, min: 0,  max: 300000, step: 10000, hint: 'Extra ms after session end to still accept signals.' },
    ],
  },
  {
    id: 'prime_session', name: 'Prime Session Gate', role: 'gate',
    description: 'Only fires during 02-04 & 16-22 UTC — institutional dead-zones where T-Junction patterns are strongest.',
    params: [
      { key: 'grace_ms', label: 'Grace Period', type: 'number', unit: 'ms', scale: 1, default: 90000, min: 0, max: 300000, step: 10000 },
    ],
  },

  // ── Signal Indicators (determine direction + entry) ────────
  {
    id: 'hl_structure', name: 'HL/LH Structure (SMC)', role: 'signal',
    description: '2-gate SMC: primary TF HL/LH sets direction, confirm TF HL/LH confirms. Enters near the fresh swing point.',
    params: [
      { key: 'primary_tf',     label: 'Direction TF',       type: 'select', options: ['1m','3m','5m','15m'], default: '3m', hint: 'Timeframe used to determine trade direction (3m = default SMC).' },
      { key: 'confirm_tf',     label: 'Confirm TF',         type: 'select', options: ['1m','3m','5m'],       default: '1m', hint: 'Timeframe used to confirm and time the entry.' },
      { key: 'primary_swing',  label: 'Primary Swing Len',  type: 'number', unit: 'candles', scale: 1, default: 5,     min: 2, max: 20,  step: 1,    hint: 'Candles each side to confirm a swing on direction TF.' },
      { key: 'confirm_swing',  label: 'Confirm Swing Len',  type: 'number', unit: 'candles', scale: 1, default: 4,     min: 2, max: 15,  step: 1,    hint: 'Candles each side to confirm a swing on confirm TF.' },
      { key: 'max_candle_age', label: 'Max Swing Age',      type: 'number', unit: 'candles', scale: 1, default: 20,    min: 3, max: 50,  step: 1,    hint: 'Swing older than this = stale, skip.' },
      { key: 'max_chase_pct',  label: 'Max Chase %',        type: 'number', unit: '%',       scale: 100, default: 0.015, min: 0.1, max: 5, step: 0.1, hint: 'Max % price distance from swing point. Beyond = chasing.' },
    ],
  },
  {
    id: 'ma_stack', name: 'MA Stack (SMA 5/10/20)', role: 'signal',
    description: 'SMA5/10/20 in strict order (bullish or bearish fan). Price must cross through all three. Fan must be actively opening.',
    params: [
      { key: 'min_spread',        label: 'Min MA Spread',     type: 'number', unit: '%',    scale: 100, default: 0.0007, min: 0.01, max: 1,   step: 0.01 },
      { key: 'min_spread_growth', label: 'Min Spread Growth', type: 'number', unit: '×',    scale: 1,   default: 1.2,   min: 1.0,  max: 3.0, step: 0.05, hint: 'Fan spread must be this × wider than 3 bars ago.' },
      { key: 'max_extension_atr', label: 'Max Extension',     type: 'number', unit: '× ATR',scale: 1,   default: 1.5,   min: 0.5,  max: 5,   step: 0.1,  hint: "Don't enter if price is more than this × ATR past SMA5." },
      { key: 'atr_period',        label: 'ATR Period',        type: 'number', unit: 'candles', scale: 1, default: 14,  min: 5,    max: 50,  step: 1 },
    ],
  },
  {
    id: 'tjunction', name: 'T-Junction (MA Convergence)', role: 'signal',
    description: 'MAs must have converged for N bars (T-stem) then fanned out (T-bar). Precisely times compression breakouts.',
    params: [
      { key: 'converge_band', label: 'Convergence Band',   type: 'number', unit: '%', scale: 100, default: 0.0025, min: 0.05, max: 1,  step: 0.05, hint: 'Max spread for a bar to count as converged.' },
      { key: 'converge_min',  label: 'Min Converged Bars', type: 'number', unit: 'bars', scale: 1, default: 2,  min: 1, max: 10, step: 1 },
      { key: 'diverge_min',   label: 'Min Divergence',     type: 'number', unit: '%', scale: 100, default: 0.0012, min: 0.05, max: 1,  step: 0.05, hint: 'Fan spread must reach at least this before entry.' },
    ],
  },
  {
    id: 'spike_hl', name: 'Spike-HL Rejection', role: 'signal',
    description: 'Candle wicked past a confirmed pivot high/low then closed back inside — smart-money stop sweep entry.',
    params: [
      { key: 'min_spike_pct',  label: 'Min Spike',      type: 'number', unit: '%', scale: 100, default: 0.0015, min: 0.05, max: 1,   step: 0.05 },
      { key: 'max_spike_pct',  label: 'Max Spike',      type: 'number', unit: '%', scale: 100, default: 0.015,  min: 0.5,  max: 5,   step: 0.1,  hint: 'Beyond this = crash/news spike, skip.' },
      { key: 'min_wick_ratio', label: 'Min Wick Ratio', type: 'number', unit: '×', scale: 1,   default: 1.2,   min: 1.0,  max: 5,   step: 0.1 },
      { key: 'sl_buffer',      label: 'SL Buffer',      type: 'number', unit: '%', scale: 100, default: 0.001,  min: 0.01, max: 0.5, step: 0.01, hint: 'SL placed this % past the spike extreme.' },
    ],
  },

  // ── Filter Indicators (validate / score direction) ─────────
  {
    id: 'ema_filter', name: 'EMA Trend Filter', role: 'filter',
    description: 'Checks price vs EMA on a higher timeframe. Prevents trading against the macro trend.',
    params: [
      { key: 'period',  label: 'EMA Period',  type: 'number', unit: 'bars', scale: 1, default: 200, min: 20,  max: 500, step: 10 },
      { key: 'htf',     label: 'Timeframe',   type: 'select', options: ['1m','5m','15m','1h','4h'], default: '1h', hint: 'Higher timeframe for the EMA calculation.' },
      { key: 'strict',  label: 'Hard Gate',   type: 'bool',   default: false, hint: 'ON = block trades against EMA. OFF = score penalty only (-3 pts).' },
    ],
  },
  {
    id: 'vwap_filter', name: 'VWAP Side Filter', role: 'filter',
    description: 'Price must be on correct side of session VWAP (above for LONG, below for SHORT).',
    params: [
      { key: 'tolerance', label: 'Tolerance', type: 'number', unit: '%', scale: 100, default: 0.001, min: 0, max: 1, step: 0.05, hint: 'Allow price to be this % on wrong side of VWAP before blocking.' },
    ],
  },
  {
    id: 'vol_filter', name: 'Volume Conviction', role: 'filter',
    description: 'Signal candle volume must exceed the SMA of the previous N candles.',
    params: [
      { key: 'sma_period', label: 'Volume SMA',  type: 'number', unit: 'candles', scale: 1, default: 9,   min: 3,   max: 30,  step: 1 },
      { key: 'min_ratio',  label: 'Min Ratio',   type: 'number', unit: '×',       scale: 1, default: 1.0, min: 0.5, max: 3.0, step: 0.1, hint: 'Signal candle vol must be ≥ this × the SMA.' },
    ],
  },
  {
    id: 'atr_gate', name: 'ATR Range Gate', role: 'filter',
    description: 'ATR as % of price must be within min/max bounds. Set min >0 for trending-only; set max <1 for sideways-only.',
    params: [
      { key: 'period',  label: 'ATR Period', type: 'number', unit: 'candles', scale: 1,   default: 14,  min: 5,  max: 50,   step: 1 },
      { key: 'min_pct', label: 'Min ATR',    type: 'number', unit: '%',       scale: 100, default: 0,   min: 0,  max: 2,    step: 0.05, hint: '0 = disabled. Set >0 to require trending volatility.' },
      { key: 'max_pct', label: 'Max ATR',    type: 'number', unit: '%',       scale: 100, default: 1.0, min: 0.1, max: 100, step: 0.1,  hint: '100 = disabled. Set low to require calm conditions.' },
    ],
  },
  {
    id: 'candle_dir', name: 'Candle Direction', role: 'filter',
    description: 'Signal candle body must match direction — bullish body for LONG, bearish body for SHORT.',
    params: [],
  },
  {
    id: 'rsi_filter', name: 'RSI Filter', role: 'filter',
    description: 'RSI must be in the expected zone. LONG: below oversold level. SHORT: above overbought level.',
    params: [
      { key: 'period',     label: 'RSI Period',    type: 'number', unit: 'candles', scale: 1, default: 14, min: 5,  max: 50, step: 1 },
      { key: 'oversold',   label: 'Oversold',      type: 'number', unit: '',        scale: 1, default: 40, min: 10, max: 50, step: 1, hint: 'LONG entry only when RSI < this level.' },
      { key: 'overbought', label: 'Overbought',    type: 'number', unit: '',        scale: 1, default: 60, min: 50, max: 90, step: 1, hint: 'SHORT entry only when RSI > this level.' },
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// Math Helpers
// ─────────────────────────────────────────────────────────────

function sma(arr, n) {
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
  return val;
}

function calcAtr(closes, highs, lows, period) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i]  - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function calcRsi(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function sessionVwap(bars, endIdx) {
  const d = new Date(bars[endIdx].ts);
  d.setUTCHours(0, 0, 0, 0);
  const dayStart = d.getTime();
  let tpv = 0, vol = 0;
  for (let i = endIdx; i >= 0; i--) {
    if (bars[i].ts < dayStart) break;
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    tpv += tp * bars[i].vol;
    vol += bars[i].vol;
  }
  return vol > 0 ? tpv / vol : bars[endIdx].close;
}

// ─────────────────────────────────────────────────────────────
// Shared Fetch
// ─────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit = 100) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
    if (!res.ok) return null;
    const raw = await res.json();
    return raw.map(r => ({
      ts:    Number(r[0]),
      open:  parseFloat(r[1]),
      high:  parseFloat(r[2]),
      low:   parseFloat(r[3]),
      close: parseFloat(r[4]),
      vol:   parseFloat(r[5]),
    }));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Swing Detection (shared by hl_structure + spike_hl)
// Extracted from smc-engine.js
// ─────────────────────────────────────────────────────────────

function detectSwings(klines, len) {
  const highs = klines.map(k => k.high);
  const lows  = klines.map(k => k.low);
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
      if (lastType === 'high') {
        const prev = swings[swings.length - 1];
        if (highs[i] > prev.price) swings[swings.length - 1] = { type: 'high', index: i, price: highs[i] };
      } else { swings.push({ type: 'high', index: i, price: highs[i] }); lastType = 'high'; }
    }
    if (isLow) {
      if (lastType === 'low') {
        const prev = swings[swings.length - 1];
        if (lows[i] < prev.price) swings[swings.length - 1] = { type: 'low', index: i, price: lows[i] };
      } else { swings.push({ type: 'low', index: i, price: lows[i] }); lastType = 'low'; }
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
  const lastLow  = lowLabels.length  ? lowLabels[lowLabels.length - 1]  : null;
  return {
    swingHighs, swingLows,
    lastHigh, lastLow,
    hasHH: lastHigh?.label === 'HH', hasHL: lastLow?.label === 'HL',
    hasLH: lastHigh?.label === 'LH', hasLL: lastLow?.label === 'LL',
  };
}

// ─────────────────────────────────────────────────────────────
// Gate Indicators
// Return { pass: bool } — if false, stop processing this symbol.
// ─────────────────────────────────────────────────────────────

function checkSessionGate(params, nowMs = Date.now()) {
  const sessions = [
    [params.asia_start ?? 23, params.asia_end ?? 2],
    [params.europe_start ?? 7, params.europe_end ?? 10],
    [params.us_start ?? 12, params.us_end ?? 16],
  ];
  const grace = params.grace_ms ?? 90000;
  const inWindow = (t) => {
    const h = new Date(t).getUTCHours();
    return sessions.some(([s, e]) => {
      if (e < s) return h >= s || h < e;  // wraps midnight
      return h >= s && h < e;
    });
  };
  return { pass: inWindow(nowMs) || inWindow(nowMs - grace) };
}

function checkPrimeSession(params, nowMs = Date.now()) {
  const grace = params.grace_ms ?? 90000;
  const PRIME = [[2, 4], [16, 22]];
  const inPrime = (t) => {
    const h = new Date(t).getUTCHours();
    return PRIME.some(([s, e]) => h >= s && h < e);
  };
  return { pass: inPrime(nowMs) || inPrime(nowMs - grace) };
}

// ─────────────────────────────────────────────────────────────
// Signal Indicators
// Return { pass, direction, ...extra } or null to block.
// ─────────────────────────────────────────────────────────────

function checkHLStructure(barsMap, params) {
  const primaryTf = params.primary_tf || '3m';
  const confirmTf = params.confirm_tf || '1m';
  const primarySwing = params.primary_swing ?? 5;
  const confirmSwing = params.confirm_swing ?? 4;
  const maxAge       = params.max_candle_age ?? 20;
  const maxChase     = params.max_chase_pct  ?? 0.015;

  const klines3m = barsMap[primaryTf];
  const klines1m = barsMap[confirmTf];
  if (!klines3m || klines3m.length < 30) return null;
  if (!klines1m || klines1m.length < 30) return null;

  const struct3m = getStructure(klines3m, primarySwing);
  let direction = null;
  if      (struct3m.hasHL && struct3m.hasHH) direction = 'LONG';
  else if (struct3m.hasLH && struct3m.hasLL) direction = 'SHORT';
  if (!direction) return null;

  const struct1m = getStructure(klines1m, confirmSwing);
  if (direction === 'LONG'  && !struct1m.hasHL) return null;
  if (direction === 'SHORT' && !struct1m.hasLH) return null;

  const swingPoint = direction === 'LONG' ? struct1m.lastLow : struct1m.lastHigh;
  if (!swingPoint) return null;

  const confirmIdx = swingPoint.index + confirmSwing;
  const age = klines1m.length - 1 - confirmIdx;
  if (age < 0 || age > maxAge) return null;

  const price = klines1m[klines1m.length - 1].close;
  const dist  = Math.abs(price - swingPoint.price) / swingPoint.price;
  if (dist > maxChase) return null;

  // SL from previous swing
  const swingLows  = struct1m.swingLows;
  const swingHighs = struct1m.swingHighs;
  let sl;
  if (direction === 'LONG') {
    const prev = swingLows.length >= 2 ? swingLows[swingLows.length - 2] : null;
    sl = prev ? prev.price * 0.999 : swingPoint.price * 0.995;
  } else {
    const prev = swingHighs.length >= 2 ? swingHighs[swingHighs.length - 2] : null;
    sl = prev ? prev.price * 1.001 : swingPoint.price * 1.005;
  }
  const slDist = Math.abs(price - sl) / price;
  if (slDist < 0.0005 || slDist > 0.05) return null;

  return { pass: true, direction, swingPrice: swingPoint.price, sl, slDist, swingAge: age };
}

function checkMAStack(bars, params) {
  if (bars.length < 25) return null;
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);

  const ma5  = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const mid  = (ma5 + ma10 + ma20) / 3;
  const stackSpread = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / mid;

  const minSpread = params.min_spread ?? 0.0007;
  if (stackSpread < minSpread) return null;

  // Spread growth: compare to 3 bars ago
  const prevCloses = closes.slice(0, -3);
  if (prevCloses.length >= 21) {
    const pm5 = sma(prevCloses, 5); const pm10 = sma(prevCloses, 10); const pm20 = sma(prevCloses, 20);
    const pmid = (pm5 + pm10 + pm20) / 3;
    const prevSpread = (Math.max(pm5, pm10, pm20) - Math.min(pm5, pm10, pm20)) / pmid;
    const minGrowth = params.min_spread_growth ?? 1.2;
    if (prevSpread > 0 && (stackSpread / prevSpread) < minGrowth) return null;
  }

  const atrPeriod = params.atr_period ?? 14;
  const atrVal    = calcAtr(closes, highs, lows, atrPeriod);
  if (!atrVal) return null;

  const price     = bars[bars.length - 1].close;
  const maxExt    = params.max_extension_atr ?? 1.5;
  const bearish   = ma5 < ma10 && ma10 < ma20 && price < ma5 && price > ma5 - atrVal * maxExt;
  const bullish   = ma5 > ma10 && ma10 > ma20 && price > ma5 && price < ma5 + atrVal * maxExt;

  if (!bearish && !bullish) return null;
  return { pass: true, direction: bearish ? 'SHORT' : 'LONG', ma5, ma10, ma20, atrVal, price };
}

function checkTJunction(bars, params) {
  if (bars.length < 26) return null;
  const i      = bars.length - 1;
  const closes = bars.slice(i - 24, i + 1).map(b => b.close);
  const ma5    = sma(closes, 5);
  const ma10   = sma(closes, 10);
  const ma20   = sma(closes, 20);
  const mid    = (ma5 + ma10 + ma20) / 3;

  const divergeMin  = params.diverge_min  ?? 0.0012;
  const convergeB   = params.converge_band ?? 0.0025;
  const convergeMin = params.converge_min  ?? 2;

  const curSpread = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / mid;
  if (curSpread < divergeMin) return null;

  let convergedBars = 0;
  for (let back = 1; back <= 8; back++) {
    const j = i - back;
    if (j < 20) break;
    const pc = bars.slice(j - 19, j + 1).map(b => b.close);
    const pm = ((sma(pc, 5) + sma(pc, 10) + sma(pc, 20)) / 3);
    const ps = (Math.max(sma(pc, 5), sma(pc, 10), sma(pc, 20)) - Math.min(sma(pc, 5), sma(pc, 10), sma(pc, 20))) / pm;
    if (ps < convergeB) convergedBars++; else break;
  }
  if (convergedBars < convergeMin) return null;

  const bullFan = ma5 > ma10 && ma10 > ma20;
  const bearFan = ma5 < ma10 && ma10 < ma20;
  if (!bullFan && !bearFan) return null;

  return { pass: true, direction: bullFan ? 'LONG' : 'SHORT', ma5, ma10, ma20, convergedBars, spread: curSpread };
}

function checkSpikeHL(bars, params) {
  if (bars.length < 8) return null;
  const spike = bars[bars.length - 1];
  const prev  = bars.slice(0, -1);

  const minSpike = params.min_spike_pct ?? 0.0015;
  const maxSpike = params.max_spike_pct ?? 0.015;
  const minWick  = params.min_wick_ratio ?? 1.2;
  const slBuf    = params.sl_buffer ?? 0.001;

  // Find pivot low (bilateral confirmation)
  let pivotLow = null;
  for (let i = prev.length - 3; i >= Math.max(1, prev.length - 15); i--) {
    if (prev[i].low < prev[i - 1].low && prev[i].low < prev[i + 1].low) {
      pivotLow = prev[i].low; break;
    }
  }
  // Find pivot high
  let pivotHigh = null;
  for (let i = prev.length - 3; i >= Math.max(1, prev.length - 15); i--) {
    if (prev[i].high > prev[i - 1].high && prev[i].high > prev[i + 1].high) {
      pivotHigh = prev[i].high; break;
    }
  }

  // LONG spike: wick below pivot low, closed above
  if (pivotLow && spike.low < pivotLow && spike.close > pivotLow) {
    const depth = (pivotLow - spike.low) / pivotLow;
    if (depth >= minSpike && depth <= maxSpike) {
      const body = Math.abs(spike.close - spike.open);
      const wick = Math.min(spike.open, spike.close) - spike.low;
      if (body >= 0.000001 && wick >= minWick * body) {
        const sl = spike.low * (1 - slBuf);
        return { pass: true, direction: 'LONG', entry: spike.close, sl, pivotLevel: pivotLow };
      }
    }
  }

  // SHORT spike: wick above pivot high, closed below
  if (pivotHigh && spike.high > pivotHigh && spike.close < pivotHigh) {
    const depth = (spike.high - pivotHigh) / pivotHigh;
    if (depth >= minSpike && depth <= maxSpike) {
      const body = Math.abs(spike.close - spike.open);
      const wick = spike.high - Math.max(spike.open, spike.close);
      if (body >= 0.000001 && wick >= minWick * body) {
        const sl = spike.high * (1 + slBuf);
        return { pass: true, direction: 'SHORT', entry: spike.close, sl, pivotLevel: pivotHigh };
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Filter Indicators
// Return { pass, penalty } — penalty reduces the signal score.
// ─────────────────────────────────────────────────────────────

function checkEMAFilter(htfBars, params, direction) {
  if (!htfBars || htfBars.length < 20) return { pass: true, penalty: 0 };
  const period  = params.period ?? 200;
  const closes  = htfBars.map(b => b.close);
  const emaVal  = ema(closes, Math.min(period, closes.length - 1));
  if (!emaVal) return { pass: true, penalty: 0 };

  const price   = closes[closes.length - 1];
  const aligned = (direction === 'LONG' && price > emaVal) || (direction === 'SHORT' && price < emaVal);

  if (aligned) return { pass: true, penalty: 0 };
  if (params.strict) return { pass: false, penalty: 0 };
  return { pass: true, penalty: -3 };
}

function checkVWAP(bars, params, direction) {
  if (!bars || bars.length < 2) return { pass: true };
  const vwap      = sessionVwap(bars, bars.length - 1);
  const price     = bars[bars.length - 1].close;
  const tolerance = params.tolerance ?? 0.001;

  if (direction === 'LONG'  && price < vwap * (1 - tolerance)) return { pass: false };
  if (direction === 'SHORT' && price > vwap * (1 + tolerance)) return { pass: false };
  return { pass: true };
}

function checkVolume(bars, params) {
  if (!bars || bars.length < 3) return { pass: true };
  const smaPeriod = params.sma_period ?? 9;
  const minRatio  = params.min_ratio  ?? 1.0;
  const sigBar    = bars[bars.length - 1];
  const avg       = bars.slice(Math.max(0, bars.length - 1 - smaPeriod), bars.length - 1)
    .reduce((s, b) => s + b.vol, 0) / smaPeriod;
  return { pass: sigBar.vol >= avg * minRatio };
}

function checkATRGate(bars, params) {
  if (!bars || bars.length < 16) return { pass: true, atrPct: 0 };
  const period = params.period  ?? 14;
  const minPct = params.min_pct ?? 0;
  const maxPct = params.max_pct ?? 1.0;
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const atrVal = calcAtr(closes, highs, lows, period);
  if (!atrVal) return { pass: true, atrPct: 0 };
  const price  = closes[closes.length - 1];
  const atrPct = atrVal / price;
  if (atrPct < minPct && minPct > 0) return { pass: false, atrPct };
  if (atrPct > maxPct && maxPct < 1) return { pass: false, atrPct };
  return { pass: true, atrPct };
}

function checkCandleDir(bar, direction) {
  if (!bar) return { pass: true };
  const bullish = bar.close > bar.open;
  if (direction === 'LONG'  && !bullish) return { pass: false };
  if (direction === 'SHORT' &&  bullish) return { pass: false };
  return { pass: true };
}

function checkRSIFilter(bars, params, direction) {
  if (!bars || bars.length < 16) return { pass: true };
  const period     = params.period     ?? 14;
  const oversold   = params.oversold   ?? 40;
  const overbought = params.overbought ?? 60;
  const closes     = bars.map(b => b.close);
  const rsiVal     = calcRsi(closes, period);
  if (rsiVal == null) return { pass: true };
  if (direction === 'LONG'  && rsiVal >= oversold)   return { pass: false };
  if (direction === 'SHORT' && rsiVal <= overbought) return { pass: false };
  return { pass: true };
}

// ─────────────────────────────────────────────────────────────
// Fetch all timeframes needed by enabled indicators
// ─────────────────────────────────────────────────────────────

async function fetchNeededBars(symbol, indicatorConfig) {
  const needed = new Set();
  const ic     = indicatorConfig || {};

  // Always fetch primary strategy timeframe — caller sets this via stratDef.timeframe
  // but indicators may need additional TFs
  if (ic.hl_structure?.enabled) {
    needed.add(ic.hl_structure.primary_tf || '3m');
    needed.add(ic.hl_structure.confirm_tf || '1m');
  }
  if (ic.ema_filter?.enabled) needed.add(ic.ema_filter.htf || '1h');

  // Default primary TFs all strategies need some version of
  ['1m', '3m', '5m'].forEach(tf => needed.add(tf));

  const barsMap = {};
  await Promise.all([...needed].map(async (tf) => {
    barsMap[tf] = await fetchKlines(symbol, tf, 110);
  }));
  return barsMap;
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  INDICATOR_LIBRARY,
  fetchKlines,
  fetchNeededBars,
  gates: { checkSessionGate, checkPrimeSession },
  signals: { checkHLStructure, checkMAStack, checkTJunction, checkSpikeHL },
  filters: { checkEMAFilter, checkVWAP, checkVolume, checkATRGate, checkCandleDir, checkRSIFilter },
};
