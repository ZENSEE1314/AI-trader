'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-v4-smc.js  —  VWAP Zone + 15m/1m Swing HL/LH
//
//  Rules (exact match to strategy-v4-tradingview.pine):
//    LOWER_MID zone  : 15m HL  + 1m HL  → LONG  (swTrend=+1 only)
//    UPPER_MID zone  : 15m LH  + 1m LH  → SHORT (swTrend=-1 only)
//    ABOVE_UPPER zone: 15m HL  + 1m HL  → LONG  (bull continuation)
//                      15m HH  + 1m HH  → SHORT (reversal, swTrend=-1)
//    BELOW_LOWER zone: 15m LH  + 1m LH  → SHORT (bear continuation)
//                      15m LL  + 1m LL  → LONG  (reversal, swTrend=+1)
//
//  Entry : next 1m candle after 15m + 1m both confirm
//  SL    : 25% capital / leverage
//  Gates : swTrend15m +1=LONG only | -1=SHORT only | 0=nothing
//
//  Data  : Bybit v5 public API (klines). Trading via Binance.
//  State : persistent per-symbol (module-level). First call warms
//          up; subsequent calls process only new delta bars.
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const BYBIT_KLINE_URL  = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS = 10_000;

// Swing pivot: 1 bar each side must be lower/higher (matches pine swing_bars=1)
const SWING_BARS = 1;

// Warm-up: enough bars to seed swing trackers
const WARMUP_BARS_1M  = 100;
const WARMUP_BARS_15M = 100;

// Delta per cycle
const DELTA_BARS_1M  = 10;
const DELTA_BARS_15M =  5;

const CAPITAL_RISK_FRAC = 0.25;

// ── Symbol config ──────────────────────────────────────────────
const ACTIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'AVAXUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 100,
  ADAUSDT:  75,
  SOLUSDT:  75,
  AVAXUSDT: 75,
};

// ── Persistent per-symbol state ───────────────────────────────
const _sym = {};

function getState(symbol) {
  if (!_sym[symbol]) {
    _sym[symbol] = {
      // Sliding candle windows
      candles1m:  [],
      candles15m: [],

      // 15m swing trackers (sh=swing high, sl=swing low; _1=most recent, _2=previous)
      sh15_1: null, sh15_2: null,
      sl15_1: null, sl15_2: null,
      _last15mPivotTime: 0,   // openTime of the last 15m bar whose pivot we confirmed

      // 1m swing trackers
      sh1m_1: null, sh1m_2: null,
      sl1m_1: null, sl1m_2: null,
      _last1mPivotTime:  0,   // openTime of the last 1m bar whose pivot we confirmed

      // Signal dedup: only one signal per confirmed 1m pivot
      _lastSignalPivotTime: 0,

      lastProcessed1m: 0,
      ready: false,
    };
  }
  return _sym[symbol];
}

// ── Bybit helpers ──────────────────────────────────────────────

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
    rows.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    return rows.map(r => ({
      openTime: parseInt(r[0]),
      open:  parseFloat(r[1]),
      high:  parseFloat(r[2]),
      low:   parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume:parseFloat(r[5]),
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ── VWAP 2σ (daily, resets midnight UTC) ─────────────────────

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

// ── Swing pivot detection ──────────────────────────────────────
// A pivot at index i is confirmed once bar i+SWING_BARS has closed.
// We call this after appending the latest bar so:
//   pivot candidate = candles[len - 1 - SWING_BARS]
// Returns { isSwingHigh, isSwingLow, pivot } or null if too few bars.

function detectPivot(candles) {
  const len = candles.length;
  if (len < 2 * SWING_BARS + 1) return null;

  const idx   = len - 1 - SWING_BARS;
  const pivot = candles[idx];

  let isSwingHigh = true;
  let isSwingLow  = true;
  for (let j = 1; j <= SWING_BARS; j++) {
    if (pivot.high <= candles[idx - j].high || pivot.high <= candles[idx + j].high) isSwingHigh = false;
    if (pivot.low  >= candles[idx - j].low  || pivot.low  >= candles[idx + j].low)  isSwingLow  = false;
  }

  return { isSwingHigh, isSwingLow, pivot };
}

// Update 15m swing trackers. Returns true if anything changed.
function update15mSwings(state) {
  const p = detectPivot(state.candles15m);
  if (!p || p.pivot.openTime === state._last15mPivotTime) return false;

  state._last15mPivotTime = p.pivot.openTime;
  if (p.isSwingHigh) { state.sh15_2 = state.sh15_1; state.sh15_1 = p.pivot.high; }
  if (p.isSwingLow)  { state.sl15_2 = state.sl15_1; state.sl15_1 = p.pivot.low;  }
  return true;
}

// Update 1m swing trackers. Returns the pivot openTime if a new pivot confirmed, else 0.
function update1mSwings(state) {
  const p = detectPivot(state.candles1m);
  if (!p || p.pivot.openTime === state._last1mPivotTime) return 0;

  state._last1mPivotTime = p.pivot.openTime;
  if (p.isSwingHigh) { state.sh1m_2 = state.sh1m_1; state.sh1m_1 = p.pivot.high; }
  if (p.isSwingLow)  { state.sl1m_2 = state.sl1m_1; state.sl1m_1 = p.pivot.low;  }
  return p.pivot.openTime;
}

// ── 15m swing trend direction ─────────────────────────────────
// +1 = higher lows (bull) | -1 = lower highs (bear) | 0 = ranging

function swTrend15m(state) {
  const hl = state.sl15_1 !== null && state.sl15_2 !== null && state.sl15_1 > state.sl15_2;
  const lh = state.sh15_1 !== null && state.sh15_2 !== null && state.sh15_1 < state.sh15_2;
  if (hl && !lh) return  1;
  if (lh && !hl) return -1;
  return 0;
}

// ── Signal resolver ────────────────────────────────────────────
// Called only when a fresh 1m pivot is confirmed AND trend gates allow.
// Returns { direction, signalType } or null.

function resolveSignal(state, price, zone) {
  const trend = swTrend15m(state);
  if (trend === 0) return null; // ranging — no trades

  // 15m structure flags
  const h15_HL = state.sl15_1 !== null && state.sl15_2 !== null && state.sl15_1 > state.sl15_2;
  const h15_LH = state.sh15_1 !== null && state.sh15_2 !== null && state.sh15_1 < state.sh15_2;
  const h15_HH = state.sh15_1 !== null && state.sh15_2 !== null && state.sh15_1 > state.sh15_2;
  const h15_LL = state.sl15_1 !== null && state.sl15_2 !== null && state.sl15_1 < state.sl15_2;

  // 1m structure flags
  const m1_HL = state.sl1m_1 !== null && state.sl1m_2 !== null && state.sl1m_1 > state.sl1m_2;
  const m1_LH = state.sh1m_1 !== null && state.sh1m_2 !== null && state.sh1m_1 < state.sh1m_2;
  const m1_HH = state.sh1m_1 !== null && state.sh1m_2 !== null && state.sh1m_1 > state.sh1m_2;
  const m1_LL = state.sl1m_1 !== null && state.sl1m_2 !== null && state.sl1m_1 < state.sl1m_2;

  // Zone × structure × trend gate
  if (zone === 'LOWER_MID') {
    if (h15_HL && m1_HL && trend === 1) return { direction: 'LONG',  signalType: 'HL+HL' };
  }
  if (zone === 'UPPER_MID') {
    if (h15_LH && m1_LH && trend === -1) return { direction: 'SHORT', signalType: 'LH+LH' };
  }
  if (zone === 'ABOVE_UPPER') {
    if (h15_HL && m1_HL && trend === 1)  return { direction: 'LONG',  signalType: 'HL+HL_above' };
    if (h15_HH && m1_HH && trend === -1) return { direction: 'SHORT', signalType: 'HH_reversal' };
  }
  if (zone === 'BELOW_LOWER') {
    if (h15_LH && m1_LH && trend === -1) return { direction: 'SHORT', signalType: 'LH+LH_below' };
    if (h15_LL && m1_LL && trend === 1)  return { direction: 'LONG',  signalType: 'LL_reversal' };
  }
  return null;
}

// ── Per-symbol analysis ────────────────────────────────────────

async function analyzeSymbol(symbol, logFn) {
  const state = getState(symbol);

  if (!state.ready) {
    // First run: load history to seed swing trackers
    logFn(`v4: ${symbol} — warming up`);
    const c1m  = await fetchBybitKlines(symbol, '1',  WARMUP_BARS_1M);
    const c15m = await fetchBybitKlines(symbol, '15', WARMUP_BARS_15M);

    state.candles1m  = c1m;
    state.candles15m = c15m;

    // Replay 15m pivots
    for (let i = SWING_BARS; i < c15m.length - SWING_BARS; i++) {
      const slice = c15m.slice(0, i + SWING_BARS + 1);
      const p = detectPivot(slice);
      if (p && p.pivot.openTime !== state._last15mPivotTime) {
        state._last15mPivotTime = p.pivot.openTime;
        if (p.isSwingHigh) { state.sh15_2 = state.sh15_1; state.sh15_1 = p.pivot.high; }
        if (p.isSwingLow)  { state.sl15_2 = state.sl15_1; state.sl15_1 = p.pivot.low;  }
      }
    }

    // Replay 1m pivots
    for (let i = SWING_BARS; i < c1m.length - SWING_BARS; i++) {
      const slice = c1m.slice(0, i + SWING_BARS + 1);
      const p = detectPivot(slice);
      if (p && p.pivot.openTime !== state._last1mPivotTime) {
        state._last1mPivotTime = p.pivot.openTime;
        if (p.isSwingHigh) { state.sh1m_2 = state.sh1m_1; state.sh1m_1 = p.pivot.high; }
        if (p.isSwingLow)  { state.sl1m_2 = state.sl1m_1; state.sl1m_1 = p.pivot.low;  }
      }
    }

    state.lastProcessed1m = c1m[c1m.length - 1].openTime;
    state.ready = true;
    const trend = swTrend15m(state);
    logFn(`v4: ${symbol} — ready | sh15=${state.sh15_1?.toFixed(4)}/${state.sh15_2?.toFixed(4)} sl15=${state.sl15_1?.toFixed(4)}/${state.sl15_2?.toFixed(4)} trend=${trend}`);
    return null;
  }

  // Subsequent runs: fetch and process only new bars
  const fresh1m  = await fetchBybitKlines(symbol, '1',  DELTA_BARS_1M);
  const fresh15m = await fetchBybitKlines(symbol, '15', DELTA_BARS_15M);

  // Append new 15m bars and update swing trackers
  const last15mTime = state.candles15m.length ? state.candles15m[state.candles15m.length - 1].openTime : 0;
  const new15m = fresh15m.filter(c => c.openTime > last15mTime);
  if (new15m.length) {
    state.candles15m.push(...new15m);
    if (state.candles15m.length > WARMUP_BARS_15M + 20) state.candles15m.splice(0, new15m.length);
    update15mSwings(state);
  }

  // Process new 1m bars
  const new1m = fresh1m.filter(c => c.openTime > state.lastProcessed1m);
  if (!new1m.length) return null;

  let signal = null;

  for (const bar of new1m) {
    state.candles1m.push(bar);
    if (state.candles1m.length > WARMUP_BARS_1M + 20) state.candles1m.shift();

    // Check if a new 1m pivot was just confirmed on this bar
    const newPivotTime = update1mSwings(state);

    if (newPivotTime && newPivotTime !== state._lastSignalPivotTime) {
      // We have a fresh 1m pivot — check for signal
      const vwapData = calcDailyVwap(state.candles15m, bar.openTime);
      if (vwapData) {
        const zone = classifyZone(bar.close, vwapData);
        const sig  = resolveSignal(state, bar.close, zone);
        if (sig) {
          state._lastSignalPivotTime = newPivotTime;
          signal = { ...sig, price: bar.close, zone };
          logFn(`v4: ✓ ${symbol} ${sig.direction} | zone=${zone} setup=${sig.signalType} trend=${swTrend15m(state)} sl15=${state.sl15_1?.toFixed(4)} sl1m=${state.sl1m_1?.toFixed(4)}`);
        }
      }
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
    setupName:  `V4-${signal.signalType}`,
    score:      5,
    tp1: null, tp2: null, tp3: null,
    zone:       signal.zone,
    swTrend:    swTrend15m(state),
    signalType: signal.signalType,
    timeframe:  '15m+1m-HL',
    version:    'v4',
  };
}

// ── Main scanner ───────────────────────────────────────────────

async function scanV4SMC(logFn = console.log) {
  const results = [];
  for (const symbol of ACTIVE_SYMBOLS) {
    try {
      const sig = await analyzeSymbol(symbol, logFn);
      if (sig) results.push(sig);
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      logFn(`v4: ${symbol} — error: ${err.message}`);
    }
  }
  const trends = ACTIVE_SYMBOLS.map(s => {
    const st = _sym[s];
    return `${s.replace('USDT', '')}=${st ? swTrend15m(st) : '?'}`;
  });
  logFn(`v4: scan done — ${results.length} signal(s) | trends: ${trends.join(' ')}`);
  return results;
}

// Single-symbol entry — used by token-agent.js
async function analyzeV4SMC(symbol) {
  return analyzeSymbol(symbol, msg => require('./bot-logger').log.scan(msg));
}

module.exports = { scanV4SMC, analyzeV4SMC, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE };
