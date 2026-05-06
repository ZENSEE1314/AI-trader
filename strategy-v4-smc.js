'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-v4-smc.js  —  VWAP Zone + LuxAlgo SMC (live scanner)
//
//  Signal logic ported from backtest-v4.js (89.6% WR, 7-day test):
//    • Internal CHoCH (size=5) + 1m confirmation → entry
//    • Swing BOS (size=50) → continuation entry
//    • VWAP 2σ bands for zone classification
//    • 15m swing trend gates: bull=LONG only | bear=SHORT only | ranging=nothing
//
//  State is PERSISTENT between cycles (module-level).
//  First call: warm up with 250 1m + 200 15m bars.
//  Every subsequent call: process only new bars since last run.
//  This mirrors the backtest exactly — no staleness / window issues.
//
//  Data: Bybit v5 public API (klines). Trading still via Binance.
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const BYBIT_KLINE_URL  = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS = 10_000;

// Warm-up: enough bars for SWING_SIZE=50 + SMC history
const WARMUP_BARS_1M  = 300;
const WARMUP_BARS_15M = 200;

// Per-cycle delta: fetch enough to cover cycle lag + small buffer
const DELTA_BARS_1M  = 10;
const DELTA_BARS_15M = 5;

const CAPITAL_RISK_FRAC = 0.25; // 25% margin → initial SL distance

// ── Symbol config (backtest-validated best config) ─────────────
const ACTIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'AVAXUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 100,
  ADAUSDT:  75,
  SOLUSDT:  75,
  AVAXUSDT: 75,
};

// ── SMC engine constants ───────────────────────────────────────
const INTERNAL_SIZE = 5;
const SWING_SIZE    = 50;

// ── Persistent per-symbol state ───────────────────────────────
// Survives across scanV4SMC() calls for the lifetime of the process.
const _sym = {}; // symbol → SymbolState

function getState(symbol) {
  if (!_sym[symbol]) {
    _sym[symbol] = {
      smc1m:           createSMCState(),
      smc15m:          createSMCState(),
      candles1m:       [], // sliding window of recent 1m candles
      candles15m:      [], // sliding window of recent 15m candles
      smc15mIdx:       0,  // how far into candles15m the 15m engine has advanced
      last15mInt:      null,
      last15mSw:       null,
      lastProcessed1m: 0,  // openTime of last 1m bar stepped through SMC
      ready:           false,
      freshSignal:     null, // set when a signal fires on a new bar; consumed by scanner
    };
  }
  return _sym[symbol];
}

// ── Bybit kline helpers ────────────────────────────────────────

async function fetchBybitKlines(symbol, intervalStr, limit) {
  const params = new URLSearchParams({
    category: 'linear',
    symbol,
    interval: intervalStr,
    limit:    String(limit),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res  = await fetch(`${BYBIT_KLINE_URL}?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
    const rows = json.result.list;
    rows.sort((a, b) => parseInt(a[0]) - parseInt(b[0])); // oldest-first
    return rows.map(parseKline);
  } finally {
    clearTimeout(timer);
  }
}

function parseKline(raw) {
  return {
    openTime: parseInt(raw[0]),
    open:     parseFloat(raw[1]),
    high:     parseFloat(raw[2]),
    low:      parseFloat(raw[3]),
    close:    parseFloat(raw[4]),
    volume:   parseFloat(raw[5]),
  };
}

// ── VWAP 2σ (daily, resets at midnight UTC) ───────────────────

function calcDailyVwap(candles15m, asOfMs) {
  const midnight = new Date(asOfMs);
  midnight.setUTCHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  const todayBars = candles15m.filter(c => c.openTime >= midnightMs && c.openTime < asOfMs);
  if (todayBars.length < 2) return null;

  let cumTPV = 0, cumTPV2 = 0, cumVol = 0;
  for (const c of todayBars) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV  += tp * c.volume;
    cumTPV2 += tp * tp * c.volume;
    cumVol  += c.volume;
  }
  if (cumVol === 0) return null;

  const vwap   = cumTPV / cumVol;
  const stddev = Math.sqrt(Math.max(0, cumTPV2 / cumVol - vwap * vwap));

  return { vwap, upper: vwap + 2 * stddev, lower: vwap - 2 * stddev };
}

function classifyZone(price, { vwap, upper, lower }) {
  if (price > upper)                   return 'ABOVE_UPPER';
  if (price > vwap && price <= upper)  return 'UPPER_MID';
  if (price >= lower && price <= vwap) return 'LOWER_MID';
  return 'BELOW_LOWER';
}

// ── SMC state machine ─────────────────────────────────────────

function createSMCState() {
  return {
    intLeg: null, intPivHigh: null, intPivLow: null, intTrend: 0,
    swLeg:  null, swPivHigh:  null, swPivLow:  null, swTrend:  0,
  };
}

function detectLegChange(candles, i, size) {
  if (i < size) return null;
  const pivot = candles[i - size];
  let recentHigh = -Infinity, recentLow = Infinity;
  for (let j = 0; j < size; j++) {
    const c = candles[i - j];
    if (c.high > recentHigh) recentHigh = c.high;
    if (c.low  < recentLow)  recentLow  = c.low;
  }
  return {
    newBear:   pivot.high > recentHigh,
    newBull:   pivot.low  < recentLow,
    pivotHigh: pivot.high,
    pivotLow:  pivot.low,
  };
}

function stepSMC(state, candles, i) {
  const close = candles[i].close;

  const intLeg = detectLegChange(candles, i, INTERNAL_SIZE);
  let intSignal = null;
  if (intLeg) {
    if (intLeg.newBear && state.intLeg !== 'BEAR') {
      state.intLeg = 'BEAR';
      state.intPivHigh = { price: intLeg.pivotHigh, crossed: false };
    } else if (intLeg.newBull && state.intLeg !== 'BULL') {
      state.intLeg = 'BULL';
      state.intPivLow = { price: intLeg.pivotLow, crossed: false };
    }
  }
  if (state.intPivHigh && !state.intPivHigh.crossed && close > state.intPivHigh.price) {
    state.intPivHigh.crossed = true;
    intSignal = state.intTrend === -1 ? 'CHOCH_LONG' : 'BOS_LONG';
    state.intTrend = 1;
  }
  if (state.intPivLow && !state.intPivLow.crossed && close < state.intPivLow.price) {
    state.intPivLow.crossed = true;
    intSignal = state.intTrend === 1 ? 'CHOCH_SHORT' : 'BOS_SHORT';
    state.intTrend = -1;
  }

  const swLeg = detectLegChange(candles, i, SWING_SIZE);
  let swSignal = null;
  if (swLeg) {
    if (swLeg.newBear && state.swLeg !== 'BEAR') {
      state.swLeg = 'BEAR';
      state.swPivHigh = { price: swLeg.pivotHigh, crossed: false };
    } else if (swLeg.newBull && state.swLeg !== 'BULL') {
      state.swLeg = 'BULL';
      state.swPivLow = { price: swLeg.pivotLow, crossed: false };
    }
  }
  if (state.swPivHigh && !state.swPivHigh.crossed && close > state.swPivHigh.price) {
    state.swPivHigh.crossed = true;
    swSignal = state.swTrend === -1 ? 'CHOCH_LONG' : 'BOS_LONG';
    state.swTrend = 1;
  }
  if (state.swPivLow && !state.swPivLow.crossed && close < state.swPivLow.price) {
    state.swPivLow.crossed = true;
    swSignal = state.swTrend === 1 ? 'CHOCH_SHORT' : 'BOS_SHORT';
    state.swTrend = -1;
  }

  return { intSignal, swSignal };
}

function resolveSignal(intSig, swSig, zone) {
  if (intSig === 'CHOCH_LONG'  && zone !== 'ABOVE_UPPER')  return 'LONG';
  if (intSig === 'CHOCH_SHORT' && zone !== 'BELOW_LOWER')  return 'SHORT';
  if (swSig  === 'CHOCH_LONG'  && zone !== 'ABOVE_UPPER')  return 'LONG';
  if (swSig  === 'CHOCH_SHORT' && zone !== 'BELOW_LOWER')  return 'SHORT';
  if (intSig === 'BOS_LONG'    && zone !== 'BELOW_LOWER')  return 'LONG';
  if (intSig === 'BOS_SHORT'   && zone !== 'ABOVE_UPPER')  return 'SHORT';
  return null;
}

// ── Step one 1m bar through the full signal pipeline ──────────
// Mutates state. Returns a signal object if a trade should be entered, else null.

function stepBar(state, bar1m, allCandles1m, barIdx) {
  const nowMs = bar1m.openTime;

  // Advance 15m engine up to this 1m bar's open time
  while (
    state.smc15mIdx < state.candles15m.length &&
    state.candles15m[state.smc15mIdx].openTime < nowMs
  ) {
    const { intSignal, swSignal } = stepSMC(state.smc15m, state.candles15m, state.smc15mIdx);
    if (intSignal) state.last15mInt = intSignal;
    if (swSignal)  state.last15mSw  = swSignal;
    state.smc15mIdx++;
  }

  // Step 1m engine
  const { intSignal: int1m } = stepSMC(state.smc1m, allCandles1m, barIdx);

  // Need enough 15m bars for VWAP
  const bars15mSoFar = state.candles15m.slice(0, state.smc15mIdx);
  if (bars15mSoFar.length < 10) {
    state.last15mInt = null;
    state.last15mSw  = null;
    return null;
  }

  const vwapData = calcDailyVwap(bars15mSoFar, nowMs);
  if (!vwapData) {
    state.last15mInt = null;
    state.last15mSw  = null;
    return null;
  }

  const price      = bar1m.close;
  const zone       = classifyZone(price, vwapData);
  const swTrend15m = state.smc15m.swTrend;
  const inMidZone  = zone === 'UPPER_MID' || zone === 'LOWER_MID';

  let direction = null, signalType = null;

  // Rule 1: 15m CHoCH + 1m confirm
  if (state.last15mInt === 'CHOCH_LONG' && (int1m === 'CHOCH_LONG' || int1m === 'BOS_LONG')) {
    if (swTrend15m === 1 && inMidZone) { direction = 'LONG'; signalType = '15m+1m_CHOCH'; }
  } else if (state.last15mInt === 'CHOCH_SHORT' && (int1m === 'CHOCH_SHORT' || int1m === 'BOS_SHORT')) {
    if (swTrend15m === -1 && inMidZone) { direction = 'SHORT'; signalType = '15m+1m_CHOCH'; }
  }

  // Rule 2: 15m BOS continuation
  if (!direction) {
    const raw = resolveSignal(state.last15mInt, state.last15mSw, zone);
    if (raw === 'LONG'  && swTrend15m === 1  && inMidZone) { direction = 'LONG';  signalType = '15m_BOS'; }
    if (raw === 'SHORT' && swTrend15m === -1 && inMidZone) { direction = 'SHORT'; signalType = '15m_BOS'; }
  }

  // Rule 3: extreme zone exhaustion
  // Bull days only: LONG at BELOW_LOWER | Bear days only: SHORT at ABOVE_UPPER
  if (!direction) {
    const hh = state.last15mSw === 'BOS_LONG'  || state.last15mInt === 'BOS_LONG';
    const ll = state.last15mSw === 'BOS_SHORT' || state.last15mInt === 'BOS_SHORT';
    if (zone === 'ABOVE_UPPER' && hh && swTrend15m === -1) { direction = 'SHORT'; signalType = 'EXTREME_HH'; }
    if (zone === 'BELOW_LOWER' && ll && swTrend15m === 1)  { direction = 'LONG';  signalType = 'EXTREME_LL'; }
  }

  // Consume 15m signal (valid for ONE 1m bar only — same as backtest)
  state.last15mInt = null;
  state.last15mSw  = null;

  if (!direction) return null;

  return { direction, signalType, price, zone, swTrend15m };
}

// ── Per-symbol scan ────────────────────────────────────────────

async function analyzeSymbol(symbol, logFn) {
  const state = getState(symbol);

  if (!state.ready) {
    // ── First run: warm up with full history ─────────────────
    logFn(`v4-smc: ${symbol} — warming up (first run)`);
    const c1m  = await fetchBybitKlines(symbol, '1',  WARMUP_BARS_1M);
    const c15m = await fetchBybitKlines(symbol, '15', WARMUP_BARS_15M);

    state.candles1m  = c1m;
    state.candles15m = c15m;
    state.smc15mIdx  = 0;

    // Replay all bars to build SMC state — don't emit signals during warmup
    for (let i = SWING_SIZE; i < state.candles1m.length; i++) {
      stepBar(state, state.candles1m[i], state.candles1m, i);
    }

    state.lastProcessed1m = state.candles1m[state.candles1m.length - 1].openTime;
    state.ready = true;
    logFn(`v4-smc: ${symbol} — ready (warmed up ${state.candles1m.length} bars, swTrend=${state.smc15m.swTrend})`);
    return null; // no signal on first run (warmup only)
  }

  // ── Subsequent runs: fetch and process only new bars ────────
  const fresh1m  = await fetchBybitKlines(symbol, '1',  DELTA_BARS_1M);
  const fresh15m = await fetchBybitKlines(symbol, '15', DELTA_BARS_15M);

  // Append new 15m bars that haven't been seen yet
  const last15mTime = state.candles15m.length
    ? state.candles15m[state.candles15m.length - 1].openTime
    : 0;
  const new15m = fresh15m.filter(c => c.openTime > last15mTime);
  if (new15m.length) {
    state.candles15m.push(...new15m);
    // Keep a sliding window (don't let it grow forever)
    if (state.candles15m.length > WARMUP_BARS_15M + 50) {
      const trim = state.candles15m.length - WARMUP_BARS_15M;
      state.candles15m.splice(0, trim);
      state.smc15mIdx = Math.max(0, state.smc15mIdx - trim);
    }
  }

  // Process new 1m bars only
  const new1m = fresh1m.filter(c => c.openTime > state.lastProcessed1m);
  if (!new1m.length) return null; // nothing new

  let signal = null;
  for (const bar of new1m) {
    // Append to sliding window
    state.candles1m.push(bar);
    if (state.candles1m.length > WARMUP_BARS_1M + 50) {
      state.candles1m.shift();
    }

    const idx = state.candles1m.length - 1;
    if (idx < SWING_SIZE) continue; // not enough history yet

    const result = stepBar(state, bar, state.candles1m, idx);
    if (result) {
      signal = result; // keep the last signal from new bars
      logFn(`v4-smc: ✓ ${symbol} ${result.direction} | zone=${result.zone} setup=${result.signalType} swTrend=${result.swTrend15m}`);
    }

    state.lastProcessed1m = bar.openTime;
  }

  if (!signal) return null;

  const leverage = SYMBOL_LEVERAGE[symbol] ?? 100;
  const slPct    = CAPITAL_RISK_FRAC / leverage;
  const sl       = signal.direction === 'LONG'
    ? signal.price * (1 - slPct)
    : signal.price * (1 + slPct);

  return {
    symbol,
    lastPrice:  signal.price,
    signal:     signal.direction === 'LONG' ? 'BUY' : 'SELL',
    side:       signal.direction,
    direction:  signal.direction,
    entry:      signal.price,
    sl,
    slPct:      (CAPITAL_RISK_FRAC * 100).toFixed(2),
    setupName:  `V4-SMC-${signal.signalType}`,
    score:      signal.signalType === '15m+1m_CHOCH' ? 5 : 4,
    tp1: null, tp2: null, tp3: null,
    zone:       signal.zone,
    swTrend15m: signal.swTrend15m,
    signalType: signal.signalType,
    timeframe:  '15m+1m-smc',
    version:    'v4-smc',
  };
}

// ── Main scanner — mirrors scan3Timing API ─────────────────────

async function scanV4SMC(logFn = console.log) {
  const results = [];

  for (const symbol of ACTIVE_SYMBOLS) {
    try {
      const sig = await analyzeSymbol(symbol, logFn);
      if (sig) results.push(sig);
      await new Promise(r => setTimeout(r, 200)); // polite Bybit rate limit
    } catch (err) {
      logFn(`v4-smc: ${symbol} — error: ${err.message}`);
    }
  }

  logFn(`v4-smc: scan done — ${results.length} signal(s) (swTrends: ${ACTIVE_SYMBOLS.map(s => `${s.replace('USDT','')}=${_sym[s]?.smc15m?.swTrend ?? '?'}`).join(' ')})`);
  return results;
}

// Single-symbol entry point — drop-in for analyzeV3 in token-agent.js
async function analyzeV4SMC(symbol) {
  return analyzeSymbol(symbol, msg => require('./bot-logger').log.scan(msg));
}

module.exports = { scanV4SMC, analyzeV4SMC, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE };
