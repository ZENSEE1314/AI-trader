'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-v4-smc.js  —  VWAP Zone + LuxAlgo SMC (live scanner)
//
//  Signal logic ported from backtest-v4.js (89.6% WR, 7-day test):
//    • Internal CHoCH (size=5) + 1m confirmation → entry
//    • Swing BOS (size=50) → continuation entry
//    • VWAP 2σ bands for zone classification
//    • 15m swing trend gates: longs need swTrend +1, shorts need swTrend -1
//    • Ranging days (swTrend === 0): shorts suppressed entirely
//
//  Data: Bybit v5 public API (klines only — trading still via Binance).
//  Leverage: BTC/ETH/BNB=100x, ADA/SOL/AVAX=75x (backtest-validated).
//  SL: 25% of margin = CAPITAL_RISK_FRAC / leverage price distance.
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const BYBIT_KLINE_URL   = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS  = 10_000;
const BARS_1M           = 250; // enough for SWING_SIZE=50 warmup + recent signals
const BARS_15M          = 200; // covers today's VWAP + SMC history (200×15min = 50h)
const SIGNAL_MAX_AGE_MS = 2 * 60_000; // only return signals from last 2 completed bars

const CAPITAL_RISK_FRAC = 0.25; // 25% margin as initial SL distance

// ── Symbol config (mirrors backtest-v4.js best config) ────────
const ACTIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'AVAXUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 100,
  ADAUSDT:  75,
  SOLUSDT:  75,
  AVAXUSDT: 75,
};

// ── SMC engine constants (LuxAlgo port) ───────────────────────
const INTERNAL_SIZE = 5;
const SWING_SIZE    = 50;

// ── Bybit kline fetch (single page — no paging needed for live scan) ──

async function fetchBybitKlines(symbol, intervalStr, limit) {
  const params = new URLSearchParams({
    category: 'linear',
    symbol,
    interval: intervalStr, // '1' or '15'
    limit:    String(limit),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res  = await fetch(`${BYBIT_KLINE_URL}?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
    // Bybit returns newest-first — sort oldest-first before returning
    const rows = json.result.list;
    rows.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

function parseKline(raw) {
  // Bybit row: [startTime, open, high, low, close, volume, turnover]
  return {
    openTime: parseInt(raw[0]),
    open:     parseFloat(raw[1]),
    high:     parseFloat(raw[2]),
    low:      parseFloat(raw[3]),
    close:    parseFloat(raw[4]),
    volume:   parseFloat(raw[5]),
  };
}

// ── Daily VWAP with 2σ bands (from midnight UTC) ───────────────

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

  const vwap    = cumTPV / cumVol;
  const stddev  = Math.sqrt(Math.max(0, cumTPV2 / cumVol - vwap * vwap));
  const upper   = vwap + 2 * stddev;
  const lower   = vwap - 2 * stddev;

  // Slope: compare second-half VWAP vs first-half VWAP of today's bars
  const mid   = Math.floor(todayBars.length / 2);
  const vwapH = (bars) => {
    let tv = 0, v = 0;
    for (const c of bars) { const tp = (c.high + c.low + c.close) / 3; tv += tp * c.volume; v += c.volume; }
    return v > 0 ? tv / v : 0;
  };
  const slope = vwapH(todayBars.slice(mid)) - vwapH(todayBars.slice(0, mid));

  return { vwap, upper, lower, slope };
}

function classifyZone(price, { vwap, upper, lower }) {
  if (price > upper)                   return 'ABOVE_UPPER';
  if (price > vwap && price <= upper)  return 'UPPER_MID';
  if (price >= lower && price <= vwap) return 'LOWER_MID';
  return 'BELOW_LOWER';
}

// ── SMC state machine (LuxAlgo Smart Money Concepts port) ────

function createSMCState() {
  return {
    intLeg:     null,
    intPivHigh: null,
    intPivLow:  null,
    intTrend:   0,
    swLeg:      null,
    swPivHigh:  null,
    swPivLow:   null,
    swTrend:    0,
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

  // Internal structure (size=5)
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

  // Swing structure (size=50)
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

// ── BOS signal resolver (continuation entries) ────────────────

function resolveSignal(intSignal, swSignal, zone) {
  if (intSignal === 'CHOCH_LONG' && zone !== 'ABOVE_UPPER')  return 'LONG';
  if (intSignal === 'CHOCH_SHORT' && zone !== 'BELOW_LOWER') return 'SHORT';
  if (swSignal  === 'CHOCH_LONG' && zone !== 'ABOVE_UPPER')  return 'LONG';
  if (swSignal  === 'CHOCH_SHORT' && zone !== 'BELOW_LOWER') return 'SHORT';
  if (intSignal === 'BOS_LONG'   && zone !== 'BELOW_LOWER')  return 'LONG';
  if (intSignal === 'BOS_SHORT'  && zone !== 'ABOVE_UPPER')  return 'SHORT';
  return null;
}

// ── Per-symbol live signal scan ────────────────────────────────
// Replays bars to build up SMC state, then checks if the LAST bar
// produced a valid signal. Returns null if no fresh signal.

async function analyzeSymbol(symbol, logFn) {
  const raw1m  = await fetchBybitKlines(symbol, '1',  BARS_1M);
  const raw15m = await fetchBybitKlines(symbol, '15', BARS_15M);

  const candles1m  = raw1m.map(parseKline);
  const candles15m = raw15m.map(parseKline);

  const smc1m  = createSMCState();
  const smc15m = createSMCState();

  let smc15mIdx        = 0;
  let last15mIntSignal = null;
  let last15mSwSignal  = null;
  let latestSignal     = null;

  for (let i = SWING_SIZE; i < candles1m.length; i++) {
    const current = candles1m[i];
    const nowMs   = current.openTime;

    // Advance 15m state to just before this 1m bar
    while (smc15mIdx < candles15m.length && candles15m[smc15mIdx].openTime < nowMs) {
      const { intSignal, swSignal } = stepSMC(smc15m, candles15m, smc15mIdx);
      if (intSignal) last15mIntSignal = intSignal;
      if (swSignal)  last15mSwSignal  = swSignal;
      smc15mIdx++;
    }

    // Step 1m SMC
    const { intSignal: int1m } = stepSMC(smc1m, candles1m, i);

    // VWAP zone
    const bars15mSoFar = candles15m.slice(0, smc15mIdx);
    const vwapData = bars15mSoFar.length >= 10 ? calcDailyVwap(bars15mSoFar, nowMs) : null;

    if (vwapData) {
      const price      = current.close;
      const zone       = classifyZone(price, vwapData);
      const swTrend15m = smc15m.swTrend;
      const inMidZone  = zone === 'UPPER_MID' || zone === 'LOWER_MID';

      let direction = null, signalType = null;

      // Rule 1: 15m internal CHoCH + 1m confirm (HL/LH flip — highest conviction)
      if (last15mIntSignal === 'CHOCH_LONG' && (int1m === 'CHOCH_LONG' || int1m === 'BOS_LONG')) {
        if (swTrend15m === 1 && inMidZone) { direction = 'LONG'; signalType = '15m+1m_CHOCH'; }
      } else if (last15mIntSignal === 'CHOCH_SHORT' && (int1m === 'CHOCH_SHORT' || int1m === 'BOS_SHORT')) {
        // Ranging day filter: suppress shorts when no swing trend established
        if (swTrend15m === -1 && inMidZone) { direction = 'SHORT'; signalType = '15m+1m_CHOCH'; }
      }

      // Rule 2: 15m BOS continuation (most trades in backtest)
      if (!direction) {
        const raw = resolveSignal(last15mIntSignal, last15mSwSignal, zone);
        if (raw === 'LONG'  && swTrend15m === 1  && inMidZone) { direction = 'LONG';  signalType = '15m_BOS'; }
        // Ranging day filter: swTrend must be -1 (clear bear trend) for shorts — 0 = ranging = skip
        if (raw === 'SHORT' && swTrend15m === -1 && inMidZone) { direction = 'SHORT'; signalType = '15m_BOS'; }
      }

      // Rule 3: extreme zone exhaustion (overbought/oversold reversal)
      // Bear days only: SHORT at ABOVE_UPPER (swTrend must be -1 — no shorts on bull/ranging)
      // Bull days only: LONG  at BELOW_LOWER (swTrend must be +1 — no longs on bear/ranging)
      if (!direction) {
        const hh = last15mSwSignal === 'BOS_LONG'  || last15mIntSignal === 'BOS_LONG';
        const ll = last15mSwSignal === 'BOS_SHORT' || last15mIntSignal === 'BOS_SHORT';
        if (zone === 'ABOVE_UPPER' && hh && swTrend15m === -1) { direction = 'SHORT'; signalType = 'EXTREME_HH'; }
        if (zone === 'BELOW_LOWER' && ll && swTrend15m === 1)  { direction = 'LONG';  signalType = 'EXTREME_LL'; }
      }

      if (direction) {
        latestSignal = { direction, signalType, price, zone, swTrend15m, barMs: nowMs };
      }
    }

    // Consume 15m signals (same as backtest — signals are valid for ONE 1m bar only)
    last15mIntSignal = null;
    last15mSwSignal  = null;
  }

  if (!latestSignal) return null;

  // Only return signal if it fired within the last SIGNAL_MAX_AGE_MS
  const lastBarMs = candles1m[candles1m.length - 1].openTime;
  const ageMs = lastBarMs - latestSignal.barMs;
  if (ageMs > SIGNAL_MAX_AGE_MS) {
    logFn(`v4-smc: ${symbol} — signal stale (${Math.round(ageMs / 60_000)}m ago), skipping`);
    return null;
  }

  const { direction, signalType, price, zone } = latestSignal;
  const leverage = SYMBOL_LEVERAGE[symbol] ?? 100;
  const slPct    = CAPITAL_RISK_FRAC / leverage;
  const sl       = direction === 'LONG'
    ? price * (1 - slPct)
    : price * (1 + slPct);

  return {
    symbol,
    lastPrice:  price,
    signal:     direction === 'LONG' ? 'BUY' : 'SELL',
    side:       direction,
    direction,
    entry:      price,
    sl,
    slPct:      (CAPITAL_RISK_FRAC * 100).toFixed(2),
    setupName:  `V4-SMC-${signalType}`,
    score:      signalType === '15m+1m_CHOCH' ? 5 : 4,
    tp1: null, tp2: null, tp3: null,
    zone,
    swTrend15m: latestSignal.swTrend15m,
    signalType,
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
      if (sig) {
        results.push(sig);
        logFn(`v4-smc: ✓ ${symbol} ${sig.direction} | zone=${sig.zone} setup=${sig.signalType} swTrend=${sig.swTrend15m}`);
      }
      // Polite delay between symbols (Bybit: 2 requests per symbol)
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      logFn(`v4-smc: ${symbol} — error: ${err.message}`);
    }
  }

  logFn(`v4-smc: scan complete — ${results.length} signal(s)`);
  return results;
}

module.exports = { scanV4SMC, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE };
