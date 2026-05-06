'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-v4-smc.js  —  VWAP Zone + 15m/1m Swing Structure
//
//  Signal rules:
//    UPPER_MID   (VWAP mid → upper 2σ) : 15m LH + 1m LH → SHORT
//    LOWER_MID   (VWAP lower 2σ → mid) : 15m HL + 1m HL → LONG
//    BELOW_LOWER (below lower 2σ)       : 15m LL + 1m LL → LONG (reversal)
//    ABOVE_UPPER (above upper 2σ)       : NO TRADE — never fade a strong trend
//
//  Pivot detection:
//    SWING_BARS = 1: bar[i] is a swing high when bar[i].high > bar[i-1].high
//    AND bar[i].high > bar[i+1].high. bar[i+1] must be a CLOSED bar.
//    The live/forming candle is always excluded — matches TradingView lookahead_off.
//
//  Entry  : current close of the candle where the 1m pivot fires
//  SL     : 25% capital risk → price % = 0.25 / leverage
//  Data   : Bybit v5 linear klines (ISP-friendly, Binance blocked in some regions)
//  State  : module-level per symbol — seeded on first call, incremental after
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────
const BYBIT_KLINE_URL  = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS = 10_000;
const SWING_BARS       = 1;    // pivot needs 1 bar each side confirmed + closed
const WARMUP_1M        = 100;  // bars loaded on first call to seed swing trackers
const WARMUP_15M       = 100;
const DELTA_1M         = 10;   // bars fetched each subsequent cycle
const DELTA_15M        =  5;
const CAPITAL_RISK     = 0.25; // 25% capital risk per trade

// ── Traded symbols and leverage ────────────────────────────────
const ACTIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'AVAXUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 100,
  ADAUSDT:  75,
  SOLUSDT:  75,
  AVAXUSDT: 75,
};

// ── Per-symbol persistent state ────────────────────────────────
const _state = {};

function getState(symbol) {
  if (!_state[symbol]) {
    _state[symbol] = {
      candles1m:  [],
      candles15m: [],

      // Two most-recent confirmed 15m swing highs/lows
      sh15_1: null, sh15_2: null,   // sh = swing high, _1 = latest, _2 = previous
      sl15_1: null, sl15_2: null,

      // Two most-recent confirmed 1m swing highs/lows
      sh1m_1: null, sh1m_2: null,
      sl1m_1: null, sl1m_2: null,

      last15mPivotTime:  0,  // openTime of last confirmed 15m pivot bar
      last1mPivotTime:   0,  // openTime of last confirmed 1m pivot bar
      lastSignalTime:    0,  // dedup: one signal per confirmed 1m pivot
      lastProcessed1m:   0,  // openTime of last CLOSED 1m bar we processed

      ready: false,
    };
  }
  return _state[symbol];
}

// ── Bybit kline fetch ──────────────────────────────────────────
async function fetchKlines(symbol, interval, limit) {
  const qs = new URLSearchParams({ category: 'linear', symbol, interval: String(interval), limit: String(limit) });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res  = await fetch(`${BYBIT_KLINE_URL}?${qs}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
    return json.result.list
      .map(r => ({ openTime: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
      .sort((a, b) => a.openTime - b.openTime);
  } finally {
    clearTimeout(t);
  }
}

// ── VWAP + 2σ bands (daily, resets at midnight UTC) ───────────
function calcVwap(candles15m, asOfMs) {
  const dayStart = new Date(asOfMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const bars = candles15m.filter(c => c.openTime >= dayStart.getTime() && c.openTime < asOfMs);
  if (bars.length < 2) return null;

  let cumTPV = 0, cumTPV2 = 0, cumVol = 0;
  for (const c of bars) {
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

function getZone(price, { vwap, upper, lower }) {
  if (price > upper) return 'ABOVE_UPPER';
  if (price > vwap)  return 'UPPER_MID';
  if (price >= lower) return 'LOWER_MID';
  return 'BELOW_LOWER';
}

// ── Swing pivot detection ──────────────────────────────────────
// Checks bar at candles[len-1-SWING_BARS]. The bar after it (candles[len-1])
// MUST be a fully closed candle — the caller ensures the live bar is excluded.
function checkPivot(candles) {
  const len = candles.length;
  if (len < 2 * SWING_BARS + 1) return null;

  const i = len - 1 - SWING_BARS;
  const bar = candles[i];
  let isHigh = true, isLow = true;

  for (let j = 1; j <= SWING_BARS; j++) {
    if (bar.high <= candles[i - j].high || bar.high <= candles[i + j].high) isHigh = false;
    if (bar.low  >= candles[i - j].low  || bar.low  >= candles[i + j].low)  isLow  = false;
  }

  return { isHigh, isLow, bar };
}

// ── Swing tracker updates ──────────────────────────────────────
function update15m(state) {
  const p = checkPivot(state.candles15m);
  if (!p || p.bar.openTime === state.last15mPivotTime) return;
  state.last15mPivotTime = p.bar.openTime;
  if (p.isHigh) { state.sh15_2 = state.sh15_1; state.sh15_1 = p.bar.high; }
  if (p.isLow)  { state.sl15_2 = state.sl15_1; state.sl15_1 = p.bar.low;  }
}

// Returns confirmed pivot openTime, or 0 if nothing new.
function update1m(state) {
  const p = checkPivot(state.candles1m);
  if (!p || p.bar.openTime === state.last1mPivotTime) return 0;
  state.last1mPivotTime = p.bar.openTime;
  if (p.isHigh) { state.sh1m_2 = state.sh1m_1; state.sh1m_1 = p.bar.high; }
  if (p.isLow)  { state.sl1m_2 = state.sl1m_1; state.sl1m_1 = p.bar.low;  }
  return p.bar.openTime;
}

// ── Signal logic ───────────────────────────────────────────────
// Called only when a fresh 1m pivot just fired (deduped by openTime).
// Both 15m and 1m structure come from CLOSED bars only.
function resolveSignal(state, zone) {
  const lh15 = state.sh15_1 !== null && state.sh15_2 !== null && state.sh15_1 < state.sh15_2;
  const hl15 = state.sl15_1 !== null && state.sl15_2 !== null && state.sl15_1 > state.sl15_2;
  const ll15 = state.sl15_1 !== null && state.sl15_2 !== null && state.sl15_1 < state.sl15_2;

  const lh1m = state.sh1m_1 !== null && state.sh1m_2 !== null && state.sh1m_1 < state.sh1m_2;
  const hl1m = state.sl1m_1 !== null && state.sl1m_2 !== null && state.sl1m_1 > state.sl1m_2;
  const ll1m = state.sl1m_1 !== null && state.sl1m_2 !== null && state.sl1m_1 < state.sl1m_2;

  if (zone === 'UPPER_MID'   && lh15 && lh1m) return { direction: 'SHORT', type: 'LH+LH' };
  if (zone === 'LOWER_MID'   && hl15 && hl1m) return { direction: 'LONG',  type: 'HL+HL' };
  if (zone === 'BELOW_LOWER' && ll15 && ll1m) return { direction: 'LONG',  type: 'LL+LL' };
  // ABOVE_UPPER → no trade (price above 2σ = strong trend, never fade)
  return null;
}

// ── Per-symbol analysis ────────────────────────────────────────
async function analyze(symbol, log) {
  const st = getState(symbol);

  // ── First call: warm up swing trackers from history ──────────
  if (!st.ready) {
    log(`[V4] ${symbol} warming up…`);
    const c1m  = await fetchKlines(symbol, 1,  WARMUP_1M);
    const c15m = await fetchKlines(symbol, 15, WARMUP_15M);

    // Seed 15m swings: replay all CLOSED bars (exclude the last = live)
    st.candles15m = c15m.slice(0, -1);
    for (let i = SWING_BARS; i < st.candles15m.length - SWING_BARS; i++) {
      const slice = st.candles15m.slice(0, i + SWING_BARS + 1);
      const p = checkPivot(slice);
      if (p && p.bar.openTime !== st.last15mPivotTime) {
        st.last15mPivotTime = p.bar.openTime;
        if (p.isHigh) { st.sh15_2 = st.sh15_1; st.sh15_1 = p.bar.high; }
        if (p.isLow)  { st.sl15_2 = st.sl15_1; st.sl15_1 = p.bar.low;  }
      }
    }

    // Seed 1m swings: replay all CLOSED bars (exclude the last = live)
    st.candles1m = c1m.slice(0, -1);
    for (let i = SWING_BARS; i < st.candles1m.length - SWING_BARS; i++) {
      const slice = st.candles1m.slice(0, i + SWING_BARS + 1);
      const p = checkPivot(slice);
      if (p && p.bar.openTime !== st.last1mPivotTime) {
        st.last1mPivotTime = p.bar.openTime;
        if (p.isHigh) { st.sh1m_2 = st.sh1m_1; st.sh1m_1 = p.bar.high; }
        if (p.isLow)  { st.sl1m_2 = st.sl1m_1; st.sl1m_1 = p.bar.low;  }
      }
    }

    st.lastProcessed1m = st.candles1m.length ? st.candles1m[st.candles1m.length - 1].openTime : 0;
    st.ready = true;
    log(`[V4] ${symbol} ready | sh15=${st.sh15_1?.toFixed(4)}/${st.sh15_2?.toFixed(4)} sl15=${st.sl15_1?.toFixed(4)}/${st.sl15_2?.toFixed(4)}`);
    return null;
  }

  // ── Incremental: process only new bars ───────────────────────
  const [fresh1m, fresh15m] = await Promise.all([
    fetchKlines(symbol, 1,  DELTA_1M),
    fetchKlines(symbol, 15, DELTA_15M),
  ]);

  // 15m: add newly CLOSED bars only (skip the last = live)
  const last15t = st.candles15m.length ? st.candles15m[st.candles15m.length - 1].openTime : 0;
  const new15m  = fresh15m.filter(c => c.openTime > last15t).slice(0, -1); // drop live
  if (new15m.length) {
    st.candles15m.push(...new15m);
    if (st.candles15m.length > WARMUP_15M + 20) st.candles15m.splice(0, new15m.length);
    update15m(st);
  }

  // 1m: process CLOSED bars only (skip the last = live)
  const new1m = fresh1m.filter(c => c.openTime > st.lastProcessed1m).slice(0, -1); // drop live
  if (!new1m.length) return null;

  let signal = null;

  for (const bar of new1m) {
    st.candles1m.push(bar);
    if (st.candles1m.length > WARMUP_1M + 20) st.candles1m.shift();

    const pivotTime = update1m(st);

    if (pivotTime && pivotTime !== st.lastSignalTime) {
      const vwap = calcVwap(st.candles15m, bar.openTime);
      if (vwap) {
        const zone = getZone(bar.close, vwap);
        const sig  = resolveSignal(st, zone);
        if (sig) {
          st.lastSignalTime = pivotTime;
          signal = { ...sig, price: bar.close, zone };
          log(`[V4] ✓ ${symbol} ${sig.direction} zone=${zone} type=${sig.type} sh15=${st.sh15_1?.toFixed(4)}/${st.sh15_2?.toFixed(4)} sh1m=${st.sh1m_1?.toFixed(4)}/${st.sh1m_2?.toFixed(4)}`);
        }
      }
    }

    st.lastProcessed1m = bar.openTime;
  }

  if (!signal) return null;

  const leverage = SYMBOL_LEVERAGE[symbol] ?? 100;
  const slPct    = CAPITAL_RISK / leverage;
  const sl       = signal.direction === 'LONG'
    ? signal.price * (1 - slPct)
    : signal.price * (1 + slPct);

  return {
    symbol,
    direction:  signal.direction,
    side:       signal.direction,
    signal:     signal.direction === 'LONG' ? 'BUY' : 'SELL',
    lastPrice:  signal.price,
    entry:      signal.price,
    sl,
    slPct:      (CAPITAL_RISK * 100).toFixed(2),
    setupName:  `V4-${signal.type}`,
    score:      5,
    zone:       signal.zone,
    signalType: signal.type,
    timeframe:  '15m+1m',
    version:    'v4',
    tp1: null, tp2: null, tp3: null,
  };
}

// ── Exports ────────────────────────────────────────────────────

// Multi-symbol scan (called by runCycle / coordinator)
async function scanV4SMC(log = console.log) {
  const results = [];
  for (const sym of ACTIVE_SYMBOLS) {
    try {
      const sig = await analyze(sym, log);
      if (sig) results.push(sig);
      await new Promise(r => setTimeout(r, 200)); // small gap between symbols
    } catch (e) {
      log(`[V4] ${sym} error: ${e.message}`);
    }
  }
  log(`[V4] scan done — ${results.length} signal(s)`);
  return results;
}

// Single-symbol entry point (called by token-agent.js)
async function analyzeV4SMC(symbol) {
  const { log: bLog } = require('./bot-logger');
  return analyze(symbol, msg => bLog.scan(msg));
}

module.exports = { scanV4SMC, analyzeV4SMC, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE };
