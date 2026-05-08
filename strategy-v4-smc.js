'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-v4-smc.js  —  VWAP Zone + 15m/1m Pivot Confluence
//
//  Zone rules (VWAP daily 2σ bands):
//
//    ABOVE_UPPER  → SHORT only
//                   15m must be HH (strict — strongest overbought signal)
//                   1m  must be HH or LH (any high confirmation)
//
//    UPPER_MID    → SHORT or LONG
//    LOWER_MID    → SHORT or LONG
//                   SHORT: 15m = HH or LH  +  1m = HH or LH
//                   LONG:  15m = HL or LL  +  1m = HL or LL
//
//    BELOW_LOWER  → LONG only
//                   15m must be HL or LL (any low)
//                   1m  must be HL or LL (any low confirmation)
//
//  SL  : LONG  → entry × (1 − CAPITAL_RISK/lev)
//        SHORT → entry × (1 + CAPITAL_RISK/lev)
//  Trailing SL: no hard TP — let winners run
//
//  Pivot detection:
//    SWING_BARS_1M  = 3 bars each side  (~3 min confirm on 1m)
//    SWING_BARS_15M = 5 bars each side  (~75 min confirm on 15m)
//    Live/forming candle always excluded — matches TV lookahead_off.
//
//  Data  : Bybit v5 linear klines
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
const SWING_BARS_1M  =  3;  // 1m: 3 closed bars each side (~3 min)
const SWING_BARS_15M =  5;  // 15m: 5 closed bars each side (~75 min) — matches TradingView SMC default

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

      // Two most-recent confirmed 15m swing highs/lows (price levels)
      sh15_1: null, sh15_2: null,
      sl15_1: null, sl15_2: null,

      // The TYPE of the most-recent confirmed 15m pivot — this is what TradingView labels.
      // 'HH' | 'HL' | 'LH' | 'LL' | null
      // SHORT only fires when last15mPivotType === 'LH'  (market just rejected at a lower high)
      // LONG  only fires when last15mPivotType === 'HL'  (market just bounced from a higher low)
      last15mPivotType:  null,
      last15mPivotPrice: null,

      // Two most-recent confirmed 1m swing highs/lows
      sh1m_1: null, sh1m_2: null,
      sl1m_1: null, sl1m_2: null,

      // The TYPE of the most-recent confirmed 1m pivot — same pattern as 15m.
      // 'HH' | 'HL' | 'LH' | 'LL' | null
      // LONG only fires when last1mPivotType === 'HL' (not just sl1m_1 > sl1m_2 positional)
      last1mPivotType:  null,
      last1mPivotPrice: null,

      last15mPivotTime: 0,
      last1mPivotTime:  0,
      lastSignalTime:   0,
      lastProcessed1m:  0,

      // Deferred entry: pivot confirmed on bar N → signal fires on bar N+1 open.
      pendingSignal: null,

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
// Tracks the TYPE of each 15m pivot — HH / HL / LH / LL — exactly as
// TradingView's SMC indicator labels them. last15mPivotType is the key
// signal gate: SHORT only when last pivot = 'LH', LONG only when = 'HL'.
// This is more accurate than comparing sh15_1 vs sh15_2 separately because
// it respects the TIME ORDER of pivots (a HL low printed after a LH high
// means the market is now bullish regardless of what old highs say).
function update15m(state) {
  const p = checkPivot(state.candles15m, SWING_BARS_15M);
  if (!p || p.bar.openTime === state.last15mPivotTime) return;
  state.last15mPivotTime = p.bar.openTime;
  if (p.isHigh) {
    // HH if this high is above the previous swing high, else LH
    const pivotType = (state.sh15_1 === null || p.bar.high > state.sh15_1) ? 'HH' : 'LH';
    state.sh15_2 = state.sh15_1;
    state.sh15_1 = p.bar.high;
    state.last15mPivotType  = pivotType;
    state.last15mPivotPrice = p.bar.high;
  }
  if (p.isLow) {
    // HL if this low is above the previous swing low, else LL
    const pivotType = (state.sl15_1 === null || p.bar.low > state.sl15_1) ? 'HL' : 'LL';
    state.sl15_2 = state.sl15_1;
    state.sl15_1 = p.bar.low;
    state.last15mPivotType  = pivotType;
    state.last15mPivotPrice = p.bar.low;
  }
}

// Returns confirmed pivot openTime, or 0 if nothing new.
// Also tracks last1mPivotType ('HH'|'HL'|'LH'|'LL') — same logic as 15m tracker.
// LONG only fires when last1mPivotType === 'HL', not just sl1m_1 > sl1m_2.
// The positional comparison (sl1m_1 > sl1m_2) can remain TRUE from OLD data
// even after a new LH high fires, causing false LONG signals on stale structure.
function update1m(state) {
  const p = checkPivot(state.candles1m, SWING_BARS_1M);
  if (!p || p.bar.openTime === state.last1mPivotTime) return 0;
  state.last1mPivotTime = p.bar.openTime;
  if (p.isHigh) {
    const pivotType = (state.sh1m_1 === null || p.bar.high > state.sh1m_1) ? 'HH' : 'LH';
    state.sh1m_2 = state.sh1m_1; state.sh1m_1 = p.bar.high;
    state.last1mPivotType  = pivotType;
    state.last1mPivotPrice = p.bar.high;
  }
  if (p.isLow) {
    const pivotType = (state.sl1m_1 === null || p.bar.low > state.sl1m_1) ? 'HL' : 'LL';
    state.sl1m_2 = state.sl1m_1; state.sl1m_1 = p.bar.low;
    state.last1mPivotType  = pivotType;
    state.last1mPivotPrice = p.bar.low;
  }
  return p.bar.openTime;
}

// ── Signal filters ─────────────────────────────────────────────
// VWAP distance: price must be ≥ 0.5σ above the lower band.
// Backtest on 8.3d of data: with dist≥0.5σ filter → 71.4% WR (SOL), 52.3% overall.
// Without the filter: WR drops by ~9.6%. Entries right at the band edge are low quality.
const MIN_DIST_SIGMA = 0.5;

function isGoodVwapDistance(price, { lower, stddev }) {
  const distFromLower = (price - lower) / stddev;
  return stddev > 0 && distFromLower >= MIN_DIST_SIGMA;
}

// 1m gap: reject if HL/LL gap > 0.50% — consecutive swing lows too far apart
// means the bounce already started well before entry. Tightened from 1.0%:
// with 3-bar 1m pivots, genuine bounces see swing-low spacing of 0.05–0.35%.
const MAX_1M_GAP_PCT = 0.50;

function is1mGapOk(sl1m_1, sl1m_2) {
  if (sl1m_1 === null || sl1m_2 === null) return false;
  const gap = Math.abs(sl1m_1 - sl1m_2) / sl1m_2 * 100;
  return gap <= MAX_1M_GAP_PCT;
}

// Chase filter: reject LONG if price has already moved > MAX_CHASE_PCT above
// the confirmed 1m HL/LL pivot.
// At 100x: 0.08% price move = 8% capital already consumed before entry.
// Tightened from 0.20% (was 20% capital burned before even opening — too far
// from the pivot, entering "in no where" as user described).
// Entry MUST be within 0.08% of the actual swing low — if it moved more, skip.
const MAX_CHASE_PCT = 0.08;

function isChasing(price, sl1m_1) {
  if (sl1m_1 === null) return false;
  const chasePct = (price - sl1m_1) / sl1m_1 * 100;
  return chasePct > MAX_CHASE_PCT;
}

// SHORT proximity filter: reject SHORT if price has already dropped > MAX_SHORT_DROP_PCT
// below the 15m HH/LH reference. The rejection already played out — we'd be
// entering mid-fall, not at the top where the setup was valid.
// Tightened from 0.30% to 0.12%: at 100x, 0.12% = 12% capital already moved.
// Entry must be within 0.12% of the swing high — if it dropped more, skip.
const MAX_SHORT_DROP_PCT = 0.12;

function isShortTooLate(price, sh15_1) {
  if (sh15_1 === null) return false;  // no swing high reference — don't block
  const dropPct = (sh15_1 - price) / sh15_1 * 100;
  return dropPct > MAX_SHORT_DROP_PCT;
}

// SHORT 1m proximity filter: price must also be within MAX_SHORT_DROP_PCT of
// the 1m swing HIGH (sh1m_1) — not just the 15m reference.
// This catches cases where 15m HH/LH is fresh but price already fell sharply
// on the 1m in the confirmation window (3 bars = 3 min).
function isShort1mTooLate(price, sh1m_1) {
  if (sh1m_1 === null) return false;
  const dropPct = (sh1m_1 - price) / sh1m_1 * 100;
  return dropPct > MAX_SHORT_DROP_PCT;
}

// ── 15m Market Structure ───────────────────────────────────────
// Compares the two most recent confirmed 15m swing highs AND swing lows.
// BULLISH  : sh15_1 > sh15_2 (HH) AND sl15_1 > sl15_2 (HL) → uptrend
// BEARISH  : sh15_1 < sh15_2 (LH) AND sl15_1 < sl15_2 (LL) → downtrend
// MIXED    : one side bullish, one bearish → ranging/transitioning
// UNKNOWN  : fewer than 2 confirmed pivots on each side
//
// Rule: only trade WITH the structure.
//   BEARISH structure → LONG is BLOCKED regardless of zone or 1m type
//   BULLISH structure → SHORT is BLOCKED regardless of zone or 1m type
//   MIXED/UNKNOWN → allow both (zone determines direction)
//
// This is the fix for "fire long at top of nowhere in a downtrend".
// A single 15m HL can pass last15mPivotType='HL' even when highs are
// making LH (bearish). The structure check catches this by requiring
// BOTH highs AND lows to align.
function get15mStructure(state) {
  const { sh15_1, sh15_2, sl15_1, sl15_2 } = state;
  if (sh15_1 === null || sh15_2 === null || sl15_1 === null || sl15_2 === null) {
    return 'UNKNOWN'; // not enough data — allow both directions
  }
  const higherHigh = sh15_1 > sh15_2; // HH
  const higherLow  = sl15_1 > sl15_2; // HL
  const lowerHigh  = sh15_1 < sh15_2; // LH
  const lowerLow   = sl15_1 < sl15_2; // LL
  if (higherHigh && higherLow) return 'BULLISH';
  if (lowerHigh  && lowerLow)  return 'BEARISH';
  return 'MIXED'; // transitioning — allow both, zone decides
}

// ── Signal logic ───────────────────────────────────────────────
//
//  Structure gate (new — applied before zone/pivot checks):
//    BEARISH 15m structure → LONG blocked in ALL zones
//    BULLISH 15m structure → SHORT blocked in ALL zones
//    MIXED/UNKNOWN → both allowed (existing zone rules apply)
//
//  ABOVE_UPPER  → SHORT only
//                 15m = HH (strict — not LH) + 1m = HH or LH
//
//  UPPER_MID    → SHORT or LONG
//  LOWER_MID    → SHORT or LONG
//                 SHORT: 15m = HH or LH  +  1m = HH or LH
//                 LONG:  15m = HL or LL  +  1m = HL or LL
//
//  BELOW_LOWER  → LONG only
//                 15m = HL or LL  +  1m = HL or LL
//
//  Drop filter (SHORT): price within 0.12% of 15m+1m pivot reference.
//  Gap  filter (LONG):  consecutive 1m swing lows ≤ 0.50% apart.
//  Chase filter (LONG): price within 0.08% of 1m swing low.
function resolveSignal(state, zone, price) {
  const p15 = state.last15mPivotType;  // 'HH' | 'HL' | 'LH' | 'LL' | null
  const p1m = state.last1mPivotType;   // 'HH' | 'HL' | 'LH' | 'LL' | null

  const is15High = p15 === 'HH' || p15 === 'LH';
  const is15Low  = p15 === 'HL' || p15 === 'LL';
  const is1High  = p1m === 'HH' || p1m === 'LH';
  const is1Low   = p1m === 'HL' || p1m === 'LL';

  // ── STRUCTURE GATE — must pass before any zone/pivot check ────
  // Compares both swing-high levels AND both swing-low levels on 15m.
  // BEARISH (LH+LL): every 15m high is lower AND every low is lower → downtrend.
  //   Firing LONG here is exactly the "buy in no where during downtrend" problem.
  //   ALL LONG signals blocked until structure turns BULLISH or MIXED.
  // BULLISH (HH+HL): uptrend → block SHORT.
  // MIXED/UNKNOWN: both allowed — zone rules decide direction.
  const structure15m = get15mStructure(state);
  if (structure15m === 'BEARISH') {
    if (is15Low || is1Low) return null; // block LONG — downtrend, no buys
  }
  if (structure15m === 'BULLISH') {
    if (is15High || is1High) return null; // block SHORT — uptrend, no sells
  }
  // structure15m === 'MIXED' or 'UNKNOWN' → fall through to zone logic

  // ── ABOVE_UPPER: SHORT only — 15m must be HH (strict) ─────────
  if (zone === 'ABOVE_UPPER') {
    if (p15 === 'HH' && is1High) {
      if (isShortTooLate(price, state.last15mPivotPrice)) return null;
      if (isShort1mTooLate(price, state.sh1m_1))         return null;
      return { direction: 'SHORT', type: `${p15}+${p1m}` };
    }
    return null;
  }

  // ── BELOW_LOWER: LONG only — any LOW on both ──────────────────
  if (zone === 'BELOW_LOWER') {
    if (is15Low && is1Low) {
      if (!is1mGapOk(state.sl1m_1, state.sl1m_2)) return null;
      if (isChasing(price, state.sl1m_1))          return null;
      return { direction: 'LONG', type: `${p15}+${p1m}` };
    }
    return null;
  }

  // ── UPPER_MID or LOWER_MID: both directions based on structure ─
  if (zone === 'UPPER_MID' || zone === 'LOWER_MID') {
    if (is15High && is1High) {
      if (isShortTooLate(price, state.last15mPivotPrice)) return null;
      if (isShort1mTooLate(price, state.sh1m_1))         return null;
      return { direction: 'SHORT', type: `${p15}+${p1m}` };
    }
    if (is15Low && is1Low) {
      if (!is1mGapOk(state.sl1m_1, state.sl1m_2)) return null;
      if (isChasing(price, state.sl1m_1))          return null;
      return { direction: 'LONG', type: `${p15}+${p1m}` };
    }
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
    // Compute last15mPivotType during replay so it matches what TradingView
    // would show: each new pivot compared against the previous one of its kind.
    st.candles15m = c15m.slice(0, -1);
    for (let i = SWING_BARS_15M; i < st.candles15m.length - SWING_BARS_15M; i++) {
      const slice = st.candles15m.slice(0, i + SWING_BARS_15M + 1);
      const p = checkPivot(slice, SWING_BARS_15M);
      if (p && p.bar.openTime !== st.last15mPivotTime) {
        st.last15mPivotTime = p.bar.openTime;
        if (p.isHigh) {
          const pivotType = (st.sh15_1 === null || p.bar.high > st.sh15_1) ? 'HH' : 'LH';
          st.sh15_2 = st.sh15_1; st.sh15_1 = p.bar.high;
          st.last15mPivotType = pivotType; st.last15mPivotPrice = p.bar.high;
        }
        if (p.isLow) {
          const pivotType = (st.sl15_1 === null || p.bar.low > st.sl15_1) ? 'HL' : 'LL';
          st.sl15_2 = st.sl15_1; st.sl15_1 = p.bar.low;
          st.last15mPivotType = pivotType; st.last15mPivotPrice = p.bar.low;
        }
      }
    }

    // 1m: replay all CLOSED bars (exclude last = live)
    // Compute last1mPivotType in time order — same as 15m warmup above.
    st.candles1m = c1m.slice(0, -1);
    for (let i = SWING_BARS_1M; i < st.candles1m.length - SWING_BARS_1M; i++) {
      const slice = st.candles1m.slice(0, i + SWING_BARS_1M + 1);
      const p = checkPivot(slice, SWING_BARS_1M);
      if (p && p.bar.openTime !== st.last1mPivotTime) {
        st.last1mPivotTime = p.bar.openTime;
        if (p.isHigh) {
          const pivotType = (st.sh1m_1 === null || p.bar.high > st.sh1m_1) ? 'HH' : 'LH';
          st.sh1m_2 = st.sh1m_1; st.sh1m_1 = p.bar.high;
          st.last1mPivotType = pivotType; st.last1mPivotPrice = p.bar.high;
        }
        if (p.isLow) {
          const pivotType = (st.sl1m_1 === null || p.bar.low > st.sl1m_1) ? 'HL' : 'LL';
          st.sl1m_2 = st.sl1m_1; st.sl1m_1 = p.bar.low;
          st.last1mPivotType = pivotType; st.last1mPivotPrice = p.bar.low;
        }
      }
    }

    st.lastProcessed1m = st.candles1m.length ? st.candles1m[st.candles1m.length - 1].openTime : 0;
    st.ready = true;
    log(`[V4] ${symbol} ready | last_15m_pivot=${st.last15mPivotType||'none'}@${st.last15mPivotPrice?.toFixed(4)||'n/a'} | sh15=${st.sh15_1?.toFixed(4)} sl15=${st.sl15_1?.toFixed(4)} | bars: 1m=${SWING_BARS_1M} 15m=${SWING_BARS_15M}`);
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
      const gapOk  = is1mGapOk(st.sl1m_1, st.sl1m_2);
      const gapPct = (st.sl1m_1 && st.sl1m_2)
        ? (Math.abs(st.sl1m_1 - st.sl1m_2) / st.sl1m_2 * 100).toFixed(3)
        : 'null';
      const dropFromHigh = (st.last15mPivotPrice && (st.last15mPivotType === 'HH' || st.last15mPivotType === 'LH'))
        ? ` drop=${((st.last15mPivotPrice - diagBar.close) / st.last15mPivotPrice * 100).toFixed(3)}%`
        : '';
      const struct15 = get15mStructure(st);
      log(`[V4-DIAG] ${symbol} zone=${diagZone} struct=${struct15} price=${diagBar.close.toFixed(4)} | 15m=${st.last15mPivotType||'none'}@${st.last15mPivotPrice?.toFixed(4)||'n/a'} sh=${st.sh15_1?.toFixed(4)}/${st.sh15_2?.toFixed(4)} sl=${st.sl15_1?.toFixed(4)}/${st.sl15_2?.toFixed(4)}${dropFromHigh} | 1m=${st.last1mPivotType||'none'}@${st.last1mPivotPrice?.toFixed(4)||'n/a'} | sl1m=${st.sl1m_1?.toFixed(4)}/${st.sl1m_2?.toFixed(4)} gap=${gapPct}%(${gapOk?'OK':'BLOCKED'}) | LONG=${struct15==='BEARISH'?'BLOCKED':'ok'} SHORT=${struct15==='BULLISH'?'BLOCKED':'ok'}`);
    }
  }

  for (const bar of new1m) {
    st.candles1m.push(bar);
    if (st.candles1m.length > WARMUP_1M + 50) st.candles1m.shift();

    // ── Step 1: Fire deferred signal on this bar's OPEN ──────────
    // Pivot confirmed on the previous bar → enter at the open of the
    // next candle, not mid-close of the confirmation candle itself.
    if (st.pendingSignal) {
      const pending = st.pendingSignal;
      st.pendingSignal = null;
      const vwapNext = calcVwap(st.candles15m, bar.openTime);
      if (vwapNext) {
        const entryPrice = bar.open;
        const zoneNext   = getZone(entryPrice, vwapNext);
        // Re-validate zone at next-bar open (SHORT needs ABOVE_UPPER; LONG needs LOWER_MID/BELOW_LOWER)
        // Zone re-check at fire time — must still be a valid zone for the direction.
        // SHORT valid zones: ABOVE_UPPER, UPPER_MID, LOWER_MID
        // LONG  valid zones: BELOW_LOWER, LOWER_MID, UPPER_MID
        // (same zones where the signal was allowed to fire)
        const shortZones = new Set(['ABOVE_UPPER', 'UPPER_MID', 'LOWER_MID']);
        const longZones  = new Set(['BELOW_LOWER', 'LOWER_MID', 'UPPER_MID']);
        const zoneOk = pending.direction === 'SHORT'
          ? shortZones.has(zoneNext)
          : longZones.has(zoneNext);
        // Re-validate chase at next-bar open using the FROZEN swing reference saved at
        // signal-creation time — NOT st.sl1m_1 which may have risen to a new higher HL
        // by the time this bar fires, making the filter think we're close when we're not.
        const frozenRef = pending.direction === 'SHORT' ? pending.sh1m_1 : pending.sl1m_1;
        // LONG chase: entry must be within MAX_CHASE_PCT (0.08%) of frozen HL/LL pivot
        // SHORT drop: entry must be within MAX_SHORT_DROP_PCT (0.12%) of frozen HH/LH pivot
        const chaseOk = pending.direction === 'SHORT'
          ? !isShort1mTooLate(entryPrice, frozenRef)
          : !isChasing(entryPrice, frozenRef);
        // Re-validate 1m pivot type at fire time: must still be a LOW pivot for LONG
        const is1mLowAtFire = pending.direction !== 'LONG'
          || st.last1mPivotType === 'HL' || st.last1mPivotType === 'LL';
        // Re-validate 1m pivot type for SHORT: must still be a HIGH pivot
        const is1mHighAtFire = pending.direction !== 'SHORT'
          || st.last1mPivotType === 'HH' || st.last1mPivotType === 'LH';
        if (zoneOk && chaseOk && is1mLowAtFire && is1mHighAtFire) {
          signal = { ...pending, price: entryPrice, zone: zoneNext };
          if (pending.direction === 'SHORT') {
            const dropPct = frozenRef ? ((frozenRef - entryPrice) / frozenRef * 100).toFixed(3) : 'n/a';
            log(`[V4] ✓ ${symbol} SHORT next-bar entry=$${entryPrice.toFixed(4)} zone=${zoneNext} type=${pending.type} drop=${dropPct}% vs sh1m=${frozenRef?.toFixed(4)}`);
          } else {
            const chasePct = frozenRef ? ((entryPrice - frozenRef) / frozenRef * 100).toFixed(3) : 'n/a';
            log(`[V4] ✓ ${symbol} LONG  next-bar entry=$${entryPrice.toFixed(4)} zone=${zoneNext} type=${pending.type} chase=${chasePct}% vs sl1m=${frozenRef?.toFixed(4)}`);
          }
        } else {
          const chasePct = frozenRef && pending.direction === 'LONG'
            ? ` chase=${((entryPrice - frozenRef) / frozenRef * 100).toFixed(3)}% (limit=${MAX_CHASE_PCT}%) ref=${frozenRef?.toFixed(4)}`
            : '';
          const dropPct = frozenRef && pending.direction === 'SHORT'
            ? ` drop=${((frozenRef - entryPrice) / frozenRef * 100).toFixed(3)}% (limit=${MAX_SHORT_DROP_PCT}%) ref=${frozenRef?.toFixed(4)}`
            : '';
          const structReason = !is1mLowAtFire ? ` 1m_pivot=${st.last1mPivotType}(need LOW for LONG)`
            : !is1mHighAtFire ? ` 1m_pivot=${st.last1mPivotType}(need HIGH for SHORT)` : '';
          log(`[V4] pending ${symbol} ${pending.direction} cancelled — zoneOk=${zoneOk}(${pending.zone}→${zoneNext}) chaseOk=${chaseOk}${chasePct}${dropPct}${structReason}`);
        }
      }
    }

    // ── Step 2: Check for a new pivot confirmation on this bar ────
    const pivotTime = update1m(st);

    if (pivotTime && pivotTime !== st.lastSignalTime) {
      const vwap = calcVwap(st.candles15m, bar.openTime);
      if (vwap) {
        const zone = getZone(bar.close, vwap);
        const sig = resolveSignal(st, zone, bar.close);
        log(`[V4-SIG] ${symbol} zone=${zone} struct=${get15mStructure(st)} 15m=${st.last15mPivotType||'none'} 1m=${st.last1mPivotType||'none'} price=${bar.close.toFixed(4)} sl1m=${st.sl1m_1?.toFixed(4)||'n/a'} sh15=${st.sh15_1?.toFixed(4)||'n/a'} sh1m=${st.sh1m_1?.toFixed(4)||'n/a'} → ${sig ? sig.direction+'+'+sig.type : 'NO_SIGNAL'}`);
        if (sig) {
          st.lastSignalTime = pivotTime;
          // Freeze the pivot references at signal-creation time.
          // The chase filter on next-bar open must compare against the ORIGINAL
          // swing low (LONG) or swing high (SHORT) that triggered this signal.
          const frozenSl1m = st.sl1m_1;
          const frozenSh1m = st.sh1m_1;
          st.pendingSignal = { ...sig, zone, sl1m_1: frozenSl1m, sh1m_1: frozenSh1m };
          if (sig.direction === 'SHORT') {
            const dropPct = st.last15mPivotPrice
              ? `drop=${((st.last15mPivotPrice - bar.close) / st.last15mPivotPrice * 100).toFixed(3)}%_from_${st.last15mPivotPrice.toFixed(4)}`
              : 'ref=n/a';
            log(`[V4] pivot → pending SHORT ${symbol} zone=${zone} type=${sig.type} sh1m=${frozenSh1m?.toFixed(4)} ${dropPct} — will enter next candle open`);
          } else {
            log(`[V4] pivot → pending LONG  ${symbol} zone=${zone} type=${sig.type} sl1m=${frozenSl1m?.toFixed(4)} — will enter next candle open`);
          }
        } else {
          // Log why no signal — helps diagnose silent periods
          const pType  = st.last15mPivotType || 'none';
          const p1Type = st.last1mPivotType  || 'none';
          const pPrice = st.last15mPivotPrice?.toFixed(4) || 'n/a';
          const is15High = pType === 'HH' || pType === 'LH';
          const is15Low  = pType === 'HL' || pType === 'LL';
          const dropPct   = st.last15mPivotPrice ? ((st.last15mPivotPrice - bar.close) / st.last15mPivotPrice * 100).toFixed(3) : 'n/a';
          const gapOk2    = is1mGapOk(st.sl1m_1, st.sl1m_2);
          const chasing2  = isChasing(bar.close, st.sl1m_1);
          const chasePct2 = st.sl1m_1 ? ((bar.close - st.sl1m_1) / st.sl1m_1 * 100).toFixed(3) : 'n/a';
          const gapPct2   = (st.sl1m_1 && st.sl1m_2) ? (Math.abs(st.sl1m_1 - st.sl1m_2) / st.sl1m_2 * 100).toFixed(3) : 'n/a';
          if (zone === 'ABOVE_UPPER') {
            // SHORT only — 15m must be HH specifically
            if (pType === 'HH') {
              log(`[V4] SHORT WAIT — ${symbol} ABOVE_UPPER 15m=HH but 1m=${p1Type} (need HH or LH)`);
            } else if (isShortTooLate(bar.close, st.last15mPivotPrice)) {
              log(`[V4] SHORT BLOCKED — ${symbol} ABOVE_UPPER 15m=${pType} dropped ${dropPct}% already (>${MAX_SHORT_DROP_PCT}%)`);
            } else {
              log(`[V4] no signal — ${symbol} ABOVE_UPPER but 15m=${pType} (need HH for SHORT here)`);
            }
          } else if (zone === 'UPPER_MID' || zone === 'LOWER_MID') {
            const is15H = pType === 'HH' || pType === 'LH';
            const is15L = pType === 'HL' || pType === 'LL';
            if (is15H) {
              log(`[V4] SHORT WAIT — ${symbol} ${zone} 15m=${pType} but 1m=${p1Type} (need HH or LH) sh1m=${st.sh1m_1?.toFixed(4)}/${st.sh1m_2?.toFixed(4)}`);
            } else if (is15L) {
              const reason = !gapOk2 ? `gap=${gapPct2}%` : chasing2 ? `chase=${chasePct2}%` : `1m=${p1Type}(need HL or LL)`;
              log(`[V4] LONG WAIT — ${symbol} ${zone} 15m=${pType} but ${reason} sl1m=${st.sl1m_1?.toFixed(4)}/${st.sl1m_2?.toFixed(4)}`);
            } else {
              log(`[V4] no signal — ${symbol} ${zone} 15m=${pType}@${pPrice} 1m=${p1Type} — no valid pivot type`);
            }
          } else if (zone === 'BELOW_LOWER') {
            const is15L = pType === 'HL' || pType === 'LL';
            if (is15L) {
              const reason = !gapOk2 ? `gap=${gapPct2}%` : chasing2 ? `chase=${chasePct2}%` : `1m=${p1Type}(need HL or LL)`;
              log(`[V4] LONG WAIT — ${symbol} BELOW_LOWER 15m=${pType} but ${reason} sl1m=${st.sl1m_1?.toFixed(4)}/${st.sl1m_2?.toFixed(4)}`);
            } else {
              log(`[V4] no signal — ${symbol} BELOW_LOWER but 15m=${pType} (need HL or LL for LONG)`);
            }
          } else {
            log(`[V4] no signal — ${symbol} zone=${zone} 15m=${pType}@${pPrice} 1m=${p1Type}`);
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
