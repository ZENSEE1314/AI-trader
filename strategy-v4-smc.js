'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-v4-smc.js  —  VWAP Zone + 15m/1m Swing Structure
//
//  Signal rules (15m is the KEY — 15m structure fires, 1m confirms):
//
//    SHORT (mean-reversion fade at VWAP extremes):
//      ABOVE_UPPER (price > upper 2σ band)
//        15m HH  +  (1m HH  OR  1m LH)  →  SHORT
//
//    LONG (reversal from VWAP lower extreme):
//      LOWER_MID  (lower 2σ → VWAP mid)
//        15m HL  +  1m HL               →  LONG  (HL+HL)
//      BELOW_LOWER (below lower 2σ band)
//        (15m HL OR LL)  +  (1m HL OR LL)  →  LONG
//
//  SL  : LONG  → entry × (1 − CAPITAL_RISK/lev)   (below entry)
//        SHORT → entry × (1 + CAPITAL_RISK/lev)   (above entry)
//  Trailing SL: no hard TP — let winners run
//
//  Pivot detection:
//    SWING_BARS_1M  = 100 bars each side  (~100 min per side on 1m)
//    SWING_BARS_15M = 100 bars each side  (major 15m structure)
//    Live/forming candle always excluded — matches TV lookahead_off.
//
//  Data  : Bybit v5 linear klines (ISP-friendly fallback list)
//  State : module-level per symbol — seeded on first call, incremental
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────
const BYBIT_KLINE_URL  = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS = 10_000;

// Pivot confirmation lengths — match what a human trader sees on the chart.
// SWING_BARS=100 caused 100-min lag on 1m and 25-HOUR lag on 15m —
// the bot saw a "15m HL" that was 25 hours old while the user saw a
// fresh one on the chart. Zero trades fired as a result.
// Now 3 bars each side: 1m pivot confirms in ~3 min, 15m in ~45 min.
const SWING_BARS_1M  =  3;  // 1m: 3 closed bars each side (~3 min confirmation)
const SWING_BARS_15M =  3;  // 15m: 3 closed bars each side (~45 min confirmation)

const WARMUP_1M  =  50;  // bars loaded on first call (need ≥ 2×3+1 = 7, 50 is plenty)
const WARMUP_15M =  50;  // bars loaded on first call
const DELTA_1M   =  10;  // bars fetched each subsequent 1m cycle
const DELTA_15M  =   5;  // bars fetched each subsequent 15m cycle
const CAPITAL_RISK = 0.25; // 25% capital risk per trade

// ── Traded symbols and leverage ────────────────────────────────
const ACTIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 100,
  ADAUSDT:  75,
  SOLUSDT:  75,
};

// ── Per-symbol persistent state ────────────────────────────────
const _state = {};

function getState(symbol) {
  if (!_state[symbol]) {
    _state[symbol] = {
      candles1m:  [],
      candles15m: [],

      // Two most-recent confirmed 15m swing highs/lows
      sh15_1: null, sh15_2: null,
      sl15_1: null, sl15_2: null,

      // Two most-recent confirmed 1m swing highs/lows
      sh1m_1: null, sh1m_2: null,
      sl1m_1: null, sl1m_2: null,

      last15mPivotTime: 0,
      last1mPivotTime:  0,
      lastSignalTime:   0,
      lastProcessed1m:  0,

      ready: false,
    };
  }
  return _state[symbol];
}

// ── Bybit kline fetch ──────────────────────────────────────────
async function fetchKlines(symbol, interval, limit) {
  const qs = new URLSearchParams({
    category: 'linear', symbol, interval: String(interval), limit: String(limit),
  });
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
  return { vwap, upper: vwap + 2 * stddev, lower: vwap - 2 * stddev, stddev };
}

function getZone(price, { vwap, upper, lower }) {
  if (price > upper) return 'ABOVE_UPPER';
  if (price > vwap)  return 'UPPER_MID';
  if (price >= lower) return 'LOWER_MID';
  return 'BELOW_LOWER';
}

// ── Swing pivot detection ──────────────────────────────────────
// bar at candles[len-1-swingBars] is a pivot high when it is strictly
// greater than ALL swingBars bars before it AND ALL swingBars bars after.
// The LAST bar in the array must be a confirmed CLOSED bar — callers
// always slice off the live bar before passing the array.
function checkPivot(candles, swingBars) {
  const len = candles.length;
  if (len < 2 * swingBars + 1) return null;

  const i = len - 1 - swingBars;
  const bar = candles[i];
  let isHigh = true, isLow = true;

  for (let j = 1; j <= swingBars; j++) {
    if (bar.high <= candles[i - j].high || bar.high <= candles[i + j].high) isHigh = false;
    if (bar.low  >= candles[i - j].low  || bar.low  >= candles[i + j].low)  isLow  = false;
  }

  return { isHigh, isLow, bar };
}

// ── Swing tracker updates ──────────────────────────────────────
function update15m(state) {
  const p = checkPivot(state.candles15m, SWING_BARS_15M);
  if (!p || p.bar.openTime === state.last15mPivotTime) return;
  state.last15mPivotTime = p.bar.openTime;
  if (p.isHigh) { state.sh15_2 = state.sh15_1; state.sh15_1 = p.bar.high; }
  if (p.isLow)  { state.sl15_2 = state.sl15_1; state.sl15_1 = p.bar.low;  }
}

// Returns confirmed pivot openTime, or 0 if nothing new.
function update1m(state) {
  const p = checkPivot(state.candles1m, SWING_BARS_1M);
  if (!p || p.bar.openTime === state.last1mPivotTime) return 0;
  state.last1mPivotTime = p.bar.openTime;
  if (p.isHigh) { state.sh1m_2 = state.sh1m_1; state.sh1m_1 = p.bar.high; }
  if (p.isLow)  { state.sl1m_2 = state.sl1m_1; state.sl1m_1 = p.bar.low;  }
  return p.bar.openTime;
}

// ── Signal filters ─────────────────────────────────────────────
// VWAP distance: accept entries anywhere above the lower band.
// Was 0.5σ minimum which blocked the best entries right AT the band.
// With 3-bar swings, pivots confirm quickly and we want to catch the
// bounce as soon as it forms, not 0.5σ later (too late for BTC/SOL).
function isGoodVwapDistance(price, { lower, stddev }) {
  const distFromLower = (price - lower) / stddev;
  return distFromLower >= 0;  // accept anywhere above lower band
}

// 1m gap: reject if HL/LL gap > 1.5% — means chasing a move already done.
// Was 0.5% which blocked virtually all BTC/ETH signals (their consecutive
// swing lows are typically 0.5-1.5% apart even on short swings).
const MAX_1M_GAP_PCT = 1.5;

function is1mGapOk(sl1m_1, sl1m_2) {
  if (sl1m_1 === null || sl1m_2 === null) return false;
  const gap = Math.abs(sl1m_1 - sl1m_2) / sl1m_2 * 100;
  return gap <= MAX_1M_GAP_PCT;
}

// Chase filter: reject LONG if price has already moved > MAX_CHASE_PCT
// above the confirmed 1m HL pivot.
// With SWING_BARS=3, the pivot confirms 3 min after the actual swing low.
// On BTC at 100x, price can rally 0.3% in 3 min — that's 30% capital gain
// already done before entry. Beyond 0.3% we're entering near resistance.
const MAX_CHASE_PCT = 0.30; // 0.30% price move above the HL low = skip

function isChasing(price, sl1m_1) {
  if (sl1m_1 === null) return false;
  const chasePct = (price - sl1m_1) / sl1m_1 * 100;
  return chasePct > MAX_CHASE_PCT;
}

// ── Signal logic ───────────────────────────────────────────────
// Only fires when a fresh 1m pivot confirms (deduped by openTime).
// All structure comes from CLOSED bars only — no live bar leakage.
// 15m is the PRIMARY signal — 1m is the confirmation trigger.
function resolveSignal(state, zone, price) {
  // ── 15m structure ────────────────────────────────────────────
  const hh15 = state.sh15_1 !== null && state.sh15_2 !== null && state.sh15_1 > state.sh15_2;
  const hl15 = state.sl15_1 !== null && state.sl15_2 !== null && state.sl15_1 > state.sl15_2;
  const ll15 = state.sl15_1 !== null && state.sl15_2 !== null && state.sl15_1 < state.sl15_2;

  // ── 1m structure ─────────────────────────────────────────────
  const hh1m = state.sh1m_1 !== null && state.sh1m_2 !== null && state.sh1m_1 > state.sh1m_2;
  const lh1m = state.sh1m_1 !== null && state.sh1m_2 !== null && state.sh1m_1 < state.sh1m_2;
  const hl1m = state.sl1m_1 !== null && state.sl1m_2 !== null && state.sl1m_1 > state.sl1m_2;
  const ll1m = state.sl1m_1 !== null && state.sl1m_2 !== null && state.sl1m_1 < state.sl1m_2;

  // ── SHORT: ABOVE_UPPER + 15m HH + (1m HH or 1m LH) ─────────
  // Price above VWAP upper 2σ band — exhaustion at extremes.
  // 15m HH = higher high printed at resistance.
  // 1m HH or LH = local swing high confirms the fade entry.
  if (zone === 'ABOVE_UPPER' && hh15 && (hh1m || lh1m)) {
    return { direction: 'SHORT', type: 'HH+SHORT' };
  }

  // ── LONG signals — apply 1m swing-low gap filter ─────────────
  // Reject if the two most-recent 1m swing lows are > MAX_1M_GAP_PCT apart
  // (means the HL structure is too loose to be a clean entry).
  if (!is1mGapOk(state.sl1m_1, state.sl1m_2)) return null;

  // Chase filter: reject if price has already moved > MAX_CHASE_PCT above
  // the most-recent confirmed 1m swing low. With SWING_BARS=3, the pivot
  // confirms 3 min after the actual low — on fast moves (BTC near HH) the
  // entry would be at resistance, not support.
  if (isChasing(price, state.sl1m_1)) return null;

  // LOWER_MID: price between VWAP lower band and VWAP mid.
  // 15m HL + 1m HL = bullish structure on both timeframes.
  if (zone === 'LOWER_MID' && hl15 && hl1m) {
    return { direction: 'LONG', type: 'HL+HL' };
  }

  // BELOW_LOWER: price below VWAP lower 2σ band — extreme oversold.
  // Any HL or LL on BOTH timeframes is valid — price is already at
  // the edge, structure on either tf is enough to confirm reversal.
  if (zone === 'BELOW_LOWER' && (hl15 || ll15) && (hl1m || ll1m)) {
    const type = `${hl15 ? 'HL' : 'LL'}+${hl1m ? 'HL' : 'LL'}`;
    return { direction: 'LONG', type };
  }

  return null;
}

// ── Per-symbol analysis ────────────────────────────────────────
async function analyze(symbol, log) {
  const st = getState(symbol);

  // ── First call: seed swing trackers from history ─────────────
  if (!st.ready) {
    log(`[V4] ${symbol} warming up…`);
    const c1m  = await fetchKlines(symbol, 1,  WARMUP_1M);
    const c15m = await fetchKlines(symbol, 15, WARMUP_15M);

    // 15m: replay all CLOSED bars (exclude last = live)
    st.candles15m = c15m.slice(0, -1);
    for (let i = SWING_BARS_15M; i < st.candles15m.length - SWING_BARS_15M; i++) {
      const slice = st.candles15m.slice(0, i + SWING_BARS_15M + 1);
      const p = checkPivot(slice, SWING_BARS_15M);
      if (p && p.bar.openTime !== st.last15mPivotTime) {
        st.last15mPivotTime = p.bar.openTime;
        if (p.isHigh) { st.sh15_2 = st.sh15_1; st.sh15_1 = p.bar.high; }
        if (p.isLow)  { st.sl15_2 = st.sl15_1; st.sl15_1 = p.bar.low;  }
      }
    }

    // 1m: replay all CLOSED bars (exclude last = live)
    st.candles1m = c1m.slice(0, -1);
    for (let i = SWING_BARS_1M; i < st.candles1m.length - SWING_BARS_1M; i++) {
      const slice = st.candles1m.slice(0, i + SWING_BARS_1M + 1);
      const p = checkPivot(slice, SWING_BARS_1M);
      if (p && p.bar.openTime !== st.last1mPivotTime) {
        st.last1mPivotTime = p.bar.openTime;
        if (p.isHigh) { st.sh1m_2 = st.sh1m_1; st.sh1m_1 = p.bar.high; }
        if (p.isLow)  { st.sl1m_2 = st.sl1m_1; st.sl1m_1 = p.bar.low;  }
      }
    }

    st.lastProcessed1m = st.candles1m.length ? st.candles1m[st.candles1m.length - 1].openTime : 0;
    st.ready = true;
    log(`[V4] ${symbol} ready | sh15=${st.sh15_1?.toFixed(4)}/${st.sh15_2?.toFixed(4)} sl15=${st.sl15_1?.toFixed(4)}/${st.sl15_2?.toFixed(4)} | 1m swing_bars=${SWING_BARS_1M} 15m swing_bars=${SWING_BARS_15M}`);
    return null;
  }

  // ── Incremental: process only new CLOSED bars ────────────────
  const [fresh1m, fresh15m] = await Promise.all([
    fetchKlines(symbol, 1,  DELTA_1M),
    fetchKlines(symbol, 15, DELTA_15M),
  ]);

  // 15m: add newly CLOSED bars only (drop live = last)
  const last15t = st.candles15m.length ? st.candles15m[st.candles15m.length - 1].openTime : 0;
  const new15m  = fresh15m.filter(c => c.openTime > last15t).slice(0, -1);
  if (new15m.length) {
    st.candles15m.push(...new15m);
    if (st.candles15m.length > WARMUP_15M + 50) st.candles15m.splice(0, new15m.length);
    update15m(st);
  }

  // 1m: process CLOSED bars only (drop live = last)
  const new1m = fresh1m.filter(c => c.openTime > st.lastProcessed1m).slice(0, -1);
  if (!new1m.length) return null;

  let signal = null;

  // Per-cycle diagnostic: show zone + pivot state even when no pivot fires.
  // Logged once per scan (based on the most-recent closed 1m bar) so the
  // admin can see exactly WHY the strategy is silent.
  const diagBar = new1m[new1m.length - 1] || st.candles1m[st.candles1m.length - 1];
  if (diagBar) {
    const diagVwap = calcVwap(st.candles15m, diagBar.openTime);
    if (diagVwap) {
      const diagZone = getZone(diagBar.close, diagVwap);
      const gapOk    = is1mGapOk(st.sl1m_1, st.sl1m_2);
      const gapPct   = (st.sl1m_1 && st.sl1m_2)
        ? (Math.abs(st.sl1m_1 - st.sl1m_2) / st.sl1m_2 * 100).toFixed(3)
        : 'null';
      const distSigma = (diagVwap.stddev > 0 && st.sl1m_1)
        ? ((diagBar.close - diagVwap.lower) / diagVwap.stddev).toFixed(2)
        : 'n/a';
      const hh15 = st.sh15_1 !== null && st.sh15_2 !== null && st.sh15_1 > st.sh15_2;
      const hl15 = st.sl15_1 !== null && st.sl15_2 !== null && st.sl15_1 > st.sl15_2;
      const ll15 = st.sl15_1 !== null && st.sl15_2 !== null && st.sl15_1 < st.sl15_2;
      const struct15 = hh15 ? 'HH' : hl15 ? 'HL' : ll15 ? 'LL' : '??';
      log(`[V4-DIAG] ${symbol} zone=${diagZone} price=${diagBar.close.toFixed(4)} | 15m:${struct15}(sh=${st.sh15_1?.toFixed(4)}/${st.sh15_2?.toFixed(4)} sl=${st.sl15_1?.toFixed(4)}/${st.sl15_2?.toFixed(4)}) | 1m:sl=${st.sl1m_1?.toFixed(4)}/${st.sl1m_2?.toFixed(4)} gap=${gapPct}%(${gapOk?'OK':'BLOCKED'}) dist=${distSigma}σ`);
    }
  }

  for (const bar of new1m) {
    st.candles1m.push(bar);
    if (st.candles1m.length > WARMUP_1M + 50) st.candles1m.shift();

    const pivotTime = update1m(st);

    if (pivotTime && pivotTime !== st.lastSignalTime) {
      const vwap = calcVwap(st.candles15m, bar.openTime);
      if (vwap) {
        const zone = getZone(bar.close, vwap);
        // VWAP dist filter: only for LOWER_MID LONG.
        // BELOW_LOWER: price below band by design — skip dist check.
        // ABOVE_UPPER SHORT: no dist filter (price above the band).
        const distBlocked = zone === 'LOWER_MID' && !isGoodVwapDistance(bar.close, vwap);
        if (distBlocked) {
          log(`[V4] skip ${symbol} — price too close to lower band (< 0.5σ) dist=${((bar.close - vwap.lower) / vwap.stddev).toFixed(2)}σ`);
        } else {
          const sig = resolveSignal(st, zone, bar.close);
          if (sig) {
            st.lastSignalTime = pivotTime;
            signal = { ...sig, price: bar.close, zone };
            if (sig.direction === 'SHORT') {
              log(`[V4] ✓ ${symbol} SHORT zone=${zone} type=${sig.type} sh15=${st.sh15_1?.toFixed(4)}/${st.sh15_2?.toFixed(4)} sh1m=${st.sh1m_1?.toFixed(4)}/${st.sh1m_2?.toFixed(4)}`);
            } else {
              log(`[V4] ✓ ${symbol} LONG  zone=${zone} type=${sig.type} sl15=${st.sl15_1?.toFixed(4)}/${st.sl15_2?.toFixed(4)} sl1m=${st.sl1m_1?.toFixed(4)}/${st.sl1m_2?.toFixed(4)}`);
            }
          } else {
            // Log why the signal was rejected (zone mismatch, gap, chase, etc.)
            const gapOk   = is1mGapOk(st.sl1m_1, st.sl1m_2);
            const chasing = isChasing(bar.close, st.sl1m_1);
            const chasePct = st.sl1m_1 ? ((bar.close - st.sl1m_1) / st.sl1m_1 * 100).toFixed(3) : 'n/a';
            const hl15 = st.sl15_1 !== null && st.sl15_2 !== null && st.sl15_1 > st.sl15_2;
            const ll15 = st.sl15_1 !== null && st.sl15_2 !== null && st.sl15_1 < st.sl15_2;
            const hh15 = st.sh15_1 !== null && st.sh15_2 !== null && st.sh15_1 > st.sh15_2;
            log(`[V4] pivot confirmed but no signal: ${symbol} zone=${zone} 15m:hh=${hh15} hl=${hl15} ll=${ll15} gap1m=${gapOk?'ok':'blocked'} chase=${chasing?`SKIP(${chasePct}%)`:`ok(${chasePct}%)`}`);
          }
        }
      }
    }

    st.lastProcessed1m = bar.openTime;
  }

  if (!signal) return null;

  const leverage = SYMBOL_LEVERAGE[symbol] ?? 100;
  const slPct    = CAPITAL_RISK / leverage;
  // SL above entry for SHORT, below entry for LONG
  const sl = signal.direction === 'SHORT'
    ? signal.price * (1 + slPct)
    : signal.price * (1 - slPct);

  return {
    symbol,
    direction:  signal.direction,
    side:       signal.direction,
    signal:     signal.direction === 'SHORT' ? 'SELL' : 'BUY',
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
      await new Promise(r => setTimeout(r, 200));
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
