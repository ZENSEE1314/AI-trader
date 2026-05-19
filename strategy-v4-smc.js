'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-v4-smc.js  —  VWAP Zone + Zone-Specific Pivot Gate
//
//  Direction — VWAP zone (momentum: trade with the trend):
//    ABOVE_UPPER / UPPER_MID  → LONG   (above VWAP = bullish bias)
//    LOWER_MID  / BELOW_LOWER → SHORT  (below VWAP = bearish bias)
//
//  4H gate:
//    LONG  blocked if 4H=BEARISH (don't long against downtrend)
//    SHORT blocked if 4H=BULLISH (don't short against uptrend)
//    EXP-O: LONG blocked if 4H+15m both BULLISH (overbought — chasing)
//
//  Pivot gate:
//    LONG  (upper zones): 15m HH or HL + 1m HH or HL  (bullish structure)
//    SHORT (lower zones): 15m LL or LH + 1m LL or LH  (bearish structure)
//
//  15m structure: diagnostic log only — not used for gating.
//
//  SL  : LONG  → entry × (1 − CAPITAL_RISK/lev)
//        SHORT → entry × (1 + CAPITAL_RISK/lev)
//  Trailing SL: no hard TP — let winners run
//
//  Pivot detection:
//    1m:  lbL=3, lbR=1  (~1 min confirm)
//    15m: lbL=10, lbR=1 (~15 min confirm — matches TV "SMC Expo" lbL=10 lbR=1)
//    Live/forming candle always excluded — matches TV lookahead_off.
//
//  Data  : Bybit v5 linear klines
//  State : module-level per symbol — seeded on first call, incremental
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────
const BYBIT_KLINE_URL  = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS = 10_000;

// Pivot confirmation lengths — asymmetric to match TradingView "SMC Expo" indicator.
// TV settings visible on chart: lbL=10, lbR=1
// lbR=1 means pivot confirms on the very next closed bar — same as what the user sees live.
// lbL=10 means the pivot must be the highest/lowest of the 10 bars before it.
const LBL_1M  =  3;  // 1m left lookback  — fast confirmation
const LBR_1M  =  1;  // 1m right lookback — 1 bar = ~1 min lag
const LBL_15M = 10;  // 15m left lookback — matches TV "SMC Expo" lbL=10
const LBR_15M =  1;  // 15m right lookback — matches TV "SMC Expo" lbR=1 (1 bar = 15 min lag)
const LBL_4H  =  5;  // 4H left lookback  — symmetric, robust higher-TF structure
const LBR_4H  =  5;  // 4H right lookback — 5 bars = ~20 h (intentionally slow)

const WARMUP_1M  =  50;  // bars loaded on first call (need ≥ 2×3+1 = 7, 50 is plenty)
const WARMUP_15M =  50;  // bars loaded on first call
const WARMUP_4H  = 100;  // 4H warmup: covers ~17 days of structure history
const DELTA_1M   =  10;  // bars fetched each subsequent 1m cycle
const DELTA_15M  =   5;  // bars fetched each subsequent 15m cycle
const DELTA_4H   =   3;  // bars fetched each subsequent 4H cycle (slow-moving TF)
// NOTE: dollar risk per trade = tradeCap × SYMBOL_SL_PCT[sym] × SYMBOL_LEVERAGE[sym]
// e.g. BTC: $100 × 0.0025 × 125 = $31.25 risk per $100 trade (31.3% of trade)

// ── Traded symbols, leverage and per-symbol SL distance ────────
// ADA removed — structurally weak WR at any leverage setting.
// SL price distances and leverages from EXP-O SL×LEV grid optimizer (30d backtest).
const ACTIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 125,  // 31.3% risk/trade
  ETHUSDT: 125,  // 31.3% risk/trade
  BNBUSDT: 200,  // 50.0% risk/trade
  SOLUSDT: 150,  // 30.0% risk/trade
};

// SL price distance per symbol (decimal: 0.0025 = 0.25%)
// Decoupled from leverage so each symbol gets its own optimal stop width.
const SYMBOL_SL_PCT = {
  BTCUSDT: 0.0025,  // 0.25% — tight, confirmed optimal from SL sweep
  ETHUSDT: 0.0025,  // 0.25% — tightened to match BTC risk at 125x (31.3% risk/trade)
  BNBUSDT: 0.0025,  // 0.25% — grid #3: SL 0.25% at 200x
  SOLUSDT: 0.0020,  // 0.20% — tight pivots, 49.2% WR confirmed
};

// ── Per-symbol persistent state ────────────────────────────────
const _state = {};

function getState(symbol) {
  if (!_state[symbol]) {
    _state[symbol] = {
      candles1m:  [],
      candles15m: [],

      // ── 4H structure state — PRIMARY direction gate ──────────────
      // 4H BULLISH → LONG only (at VWAP lower band or mid)
      // 4H BEARISH → SHORT only (at VWAP upper band or mid)
      // 4H MIXED   → fall back to 15m structure gate
      candles4h:       [],
      pivots4h:        [],   // labeled sequence: { type:'H'|'L', price, time, label }
      sh4h_1: null, sh4h_2: null,
      sl4h_1: null, sl4h_2: null,
      last4hPivotType:  null,
      last4hPivotPrice: null,
      last4hPivotTime:  0,

      // Full labeled 15m pivot sequence — up to 50 entries.
      // Each entry: { type:'H'|'L', price, time, label:'HH'|'LH'|'HL'|'LL' }
      // Labeled by comparing each new pivot to the PREVIOUS pivot of the same type.
      // Structure is derived from the most-recent labeled H and L in this array,
      // giving proper sequence-aware HH/LH/HL/LL detection over 50 candles of history.
      pivots15m: [],

      // Two most-recent confirmed 15m swing highs/lows (price levels — kept for
      // entry reference, chase filter, DIAG log)
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

      // Zone entry cooldown — one trade per zone GROUP entry (PREMIUM/DISCOUNT).
      // Resets when price crosses to the opposite group OR escalates within
      // the same group (e.g. UPPER_MID → ABOVE_UPPER = price broke through
      // the upper band = new extreme = fresh SHORT opportunity).
      prevZone:      null,  // stores 'PREMIUM' or 'DISCOUNT' group label
      prevZoneExact: null,  // stores exact zone ('ABOVE_UPPER','UPPER_MID','LOWER_MID','BELOW_LOWER')
      zoneTraded:     false,
      lastLongTime:   0,  // EXP-O: per-direction 3-hour cooldown
      lastShortTime:  0,  // EXP-O: per-direction 3-hour cooldown

      ready: false,

      // ── CHoCH (Change of Character) state ───────────────────────────────────────
      // CHoCH SHORT: price breaks BELOW last confirmed 15m HL in a bullish structure
      // CHoCH LONG:  price breaks ABOVE last confirmed 15m LH in a bearish structure
      // These catch the BIG trend-reversal moves that normal pivot-confirmation misses.
      // Levels update every time a new HL or LH is confirmed on the 15m.
      // choch_bear_level: last 15m HL price — break below this = bearish CHoCH → SHORT
      // choch_bull_level: last 15m LH price — break above this = bullish CHoCH → LONG
      // choch_bear_fired: timestamp of last bearish CHoCH fire (cooldown guard)
      // choch_bull_fired: timestamp of last bullish CHoCH fire (cooldown guard)
      choch_bear_level: null,
      choch_bull_level: null,
      choch_bear_fired: 0,
      choch_bull_fired: 0,
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
// Asymmetric lookback: bar at candles[len-1-lbR] is a pivot high when it is
// strictly greater than ALL lbL bars before it AND ALL lbR bars after it.
// lbL=10, lbR=1 matches TradingView "SMC Expo" — confirms after just 1 closed bar.
// The LAST bar in the array must be a confirmed CLOSED bar — callers
// always slice off the live bar before passing the array.
function checkPivot(candles, lbL, lbR) {
  const len = candles.length;
  if (len < lbL + lbR + 1) return null;

  const i = len - 1 - lbR;
  if (i < lbL) return null;
  const bar = candles[i];
  let isHigh = true, isLow = true;

  for (let j = 1; j <= lbL; j++) {
    if (bar.high <= candles[i - j].high) isHigh = false;
    if (bar.low  >= candles[i - j].low)  isLow  = false;
  }
  for (let j = 1; j <= lbR; j++) {
    if (bar.high <= candles[i + j].high) isHigh = false;
    if (bar.low  >= candles[i + j].low)  isLow  = false;
  }

  return { isHigh, isLow, bar };
}

// ── Swing tracker updates ──────────────────────────────────────
// Tracks the TYPE of each 15m pivot — HH / HL / LH / LL — exactly as
// TradingView's SMC indicator labels them.
//
// Each new confirmed pivot is labeled by comparing it to the PREVIOUS pivot
// of the SAME TYPE (high vs high, low vs low) in the sequence:
//   new high > last high → HH   new high < last high → LH
//   new low  > last low  → HL   new low  < last low  → LL
//
// Entries are pushed to state.pivots15m (capped at 50) so that
// get15mStructure() can read the full recent sequence rather than
// just comparing sh15_1 vs sh15_2 in isolation.
function update15m(state) {
  const p = checkPivot(state.candles15m, LBL_15M, LBR_15M);
  if (!p || p.bar.openTime === state.last15mPivotTime) return;
  state.last15mPivotTime = p.bar.openTime;

  if (p.isHigh) {
    // Find the last HIGH in the pivot sequence to label correctly
    const lastH = findLastPivot(state.pivots15m, 'H');
    const label = (!lastH || p.bar.high > lastH.price) ? 'HH' : 'LH';
    state.sh15_2 = state.sh15_1;
    state.sh15_1 = p.bar.high;
    state.pivots15m.push({ type: 'H', price: p.bar.high, time: p.bar.openTime, label });
    state.last15mPivotType  = label;
    state.last15mPivotPrice = p.bar.high;
    // LH = lower high → this is the CHoCH bullish level: break ABOVE = trend flipping LONG
    // Reset fired flag so the new level can trigger a fresh CHoCH LONG signal
    if (label === 'LH') {
      state.choch_bull_level = p.bar.high;
      state.choch_bull_fired = 0;
    }
  }
  if (p.isLow) {
    // Find the last LOW in the pivot sequence to label correctly
    const lastL = findLastPivot(state.pivots15m, 'L');
    const label = (!lastL || p.bar.low > lastL.price) ? 'HL' : 'LL';
    state.sl15_2 = state.sl15_1;
    state.sl15_1 = p.bar.low;
    state.pivots15m.push({ type: 'L', price: p.bar.low, time: p.bar.openTime, label });
    state.last15mPivotType  = label;
    state.last15mPivotPrice = p.bar.low;
    // HL = higher low → this is the CHoCH bearish level: break BELOW = trend flipping SHORT
    // Reset fired flag so the new level can trigger a fresh CHoCH SHORT signal
    if (label === 'HL') {
      state.choch_bear_level = p.bar.low;
      state.choch_bear_fired = 0;
    }
  }

  // Keep at most 50 pivot entries — covers ~50×15m = 12.5 hours of history
  if (state.pivots15m.length > 50) state.pivots15m = state.pivots15m.slice(-50);
}

// Returns the most-recent pivot entry of the given type ('H' or 'L'), or null.
function findLastPivot(pivots, type) {
  for (let i = pivots.length - 1; i >= 0; i--) {
    if (pivots[i].type === type) return pivots[i];
  }
  return null;
}

// ── 4H swing tracker ──────────────────────────────────────────
// Mirrors update15m() exactly, but operates on 4H candles and pivots4h[].
// Called whenever new closed 4H bars arrive.
function update4h(state) {
  const p = checkPivot(state.candles4h, LBL_4H, LBR_4H);
  if (!p || p.bar.openTime === state.last4hPivotTime) return;
  state.last4hPivotTime = p.bar.openTime;

  if (p.isHigh) {
    const lastH = findLastPivot(state.pivots4h, 'H');
    const label = (!lastH || p.bar.high > lastH.price) ? 'HH' : 'LH';
    state.sh4h_2 = state.sh4h_1;
    state.sh4h_1 = p.bar.high;
    state.pivots4h.push({ type: 'H', price: p.bar.high, time: p.bar.openTime, label });
    state.last4hPivotType  = label;
    state.last4hPivotPrice = p.bar.high;
  }
  if (p.isLow) {
    const lastL = findLastPivot(state.pivots4h, 'L');
    const label = (!lastL || p.bar.low > lastL.price) ? 'HL' : 'LL';
    state.sl4h_2 = state.sl4h_1;
    state.sl4h_1 = p.bar.low;
    state.pivots4h.push({ type: 'L', price: p.bar.low, time: p.bar.openTime, label });
    state.last4hPivotType  = label;
    state.last4hPivotPrice = p.bar.low;
  }

  // Keep up to 50 4H pivot entries (~200 candles of structure context = ~33 days)
  if (state.pivots4h.length > 50) state.pivots4h = state.pivots4h.slice(-50);
}

// ── 4H Market Structure — PRIMARY direction gate ───────────────
// Same logic as get15mStructure() but reads pivots4h[].
// Returns: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN'
//
// BULLISH = last 4H high is HH AND last 4H low is HL  → only LONG allowed
// BEARISH = last 4H high is LH AND last 4H low is LL  → only SHORT allowed
// MIXED   = diverging labels                           → fall back to 15m gate
// UNKNOWN = not enough 4H pivots yet (<4 entries)     → fall back to 15m gate
//
// Entry zones per structure:
//   4H BULLISH → LONG at VWAP lower 2σ band (price is a discount) OR VWAP mid
//   4H BEARISH → SHORT at VWAP upper 2σ band (price is a premium) OR VWAP mid
function get4hStructure(state, currentPrice) {
  const pivots = state.pivots4h;
  if (pivots.length < 4) return 'UNKNOWN';

  const lastH = findLastPivot(pivots, 'H');
  const lastL = findLastPivot(pivots, 'L');
  if (!lastH || !lastL) return 'UNKNOWN';

  // Real-time breakout: live price already crossed confirmed 4H level
  const breakingLow  = currentPrice !== undefined && currentPrice < lastL.price;
  const breakingHigh = currentPrice !== undefined && currentPrice > lastH.price;

  if (lastH.label === 'LH' && (lastL.label === 'LL' || breakingLow))  return 'BEARISH';
  if (lastH.label === 'HH' && (lastL.label === 'HL' || breakingHigh)) return 'BULLISH';
  return 'MIXED';
}

// Returns confirmed pivot openTime, or 0 if nothing new.
// Also tracks last1mPivotType ('HH'|'HL'|'LH'|'LL') — same logic as 15m tracker.
// LONG only fires when last1mPivotType === 'HL', not just sl1m_1 > sl1m_2.
// The positional comparison (sl1m_1 > sl1m_2) can remain TRUE from OLD data
// even after a new LH high fires, causing false LONG signals on stale structure.
function update1m(state) {
  const p = checkPivot(state.candles1m, LBL_1M, LBR_1M);
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
// EXP-L discovery: loosening to 0.75 allows entries up to 1.5σ from band instead of 1.0σ.
// Captures more of the LOWER_MID zone — validated in EXP-O backtest (+$1,783 vs +$973).
const MIN_DIST_SIGMA = 0.75;

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
const MAX_CHASE_PCT = 0.25;  // raised from 0.08 — 0.08% was ~$61 on BTC, too tight for pivot confirmation lag

function isChasing(price, sl1m_1) {
  if (sl1m_1 === null) return false;
  const chasePct = (price - sl1m_1) / sl1m_1 * 100;
  return chasePct > MAX_CHASE_PCT;
}

// SHORT proximity filter: reject SHORT if price has already dropped > MAX_SHORT_DROP_PCT
// below the 15m HH/LH reference. The rejection already played out — we'd be
// entering mid-fall, not at the top where the setup was valid.
// 0.12% was too tight — 15m pivot takes ~30 min (LBR bars) to confirm, during which
// price easily drops 0.3–0.5%. Raised to 0.45% so the entry window survives confirmation lag.
const MAX_SHORT_DROP_PCT = 0.45;

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

// VWAP σ-distance filter for SHORT entries.
// Price must be ≥ MIN_DIST_SIGMA below the upper 2σ band to confirm the
// rejection is already happening — blocks entries right AT the upper band
// where price is still rising (mid-breakout).
function isGoodUpperDistance(price, { upper, stddev }) {
  const distFromUpper = (upper - price) / stddev;
  return stddev > 0 && distFromUpper >= MIN_DIST_SIGMA;
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
// ── 15m Structure from full pivot sequence ─────────────────────
// Reads state.pivots15m — the labeled history of all confirmed 15m swing
// highs and lows over the last 50 pivot entries (~50 candles of history).
//
// Structure is determined by the MOST-RECENT labeled H and L:
//   Most-recent H = LH + most-recent L = LL → BEARISH  (lower highs AND lower lows)
//   Most-recent H = HH + most-recent L = HL → BULLISH  (higher highs AND higher lows)
//   Any other combination             → MIXED   (ranging/transitioning)
//
// This replaces the old 2-point comparison (sh15_1 vs sh15_2) which was wrong
// when the 2nd-last pivot was stale or from a different market phase.
//
// currentPrice: live bar close for real-time breakout detection.
// If price already broke BELOW the last confirmed swing low (LL forming live),
// or already broke ABOVE the last confirmed swing high (HH forming live),
// treat structure as BEARISH/BULLISH immediately — no need to wait 75 min
// for the new pivot to collect its 5 confirmation bars.
function get15mStructure(state, currentPrice) {
  const pivots = state.pivots15m;
  if (pivots.length < 4) return 'UNKNOWN'; // need at least 2H + 2L to determine structure

  // Walk back from the end — find the most-recently labeled HIGH and LOW
  const lastH = findLastPivot(pivots, 'H');
  const lastL = findLastPivot(pivots, 'L');

  if (!lastH || !lastL) return 'UNKNOWN';

  const lastHighLabel = lastH.label; // 'HH' or 'LH'
  const lastLowLabel  = lastL.label; // 'HL' or 'LL'

  // Real-time breakout detection:
  // If price already crossed the last confirmed swing level, the new pivot
  // is FORMING even though not yet confirmed by 5 bars.
  const breakingLow  = currentPrice !== undefined && currentPrice < lastL.price;
  const breakingHigh = currentPrice !== undefined && currentPrice > lastH.price;

  // BEARISH: most-recent high = LH AND (most-recent low = LL OR price breaking below it)
  if (lastHighLabel === 'LH' && (lastLowLabel === 'LL' || breakingLow))  return 'BEARISH';
  // BULLISH: most-recent high = HH AND (most-recent low = HL OR price breaking above it)
  if (lastHighLabel === 'HH' && (lastLowLabel === 'HL' || breakingHigh)) return 'BULLISH';
  return 'MIXED'; // diverging labels — zone decides direction
}

// ── Munehisa Homma Candlestick Pattern Detector ────────────────
//
//  Applied as a HARD GATE for BNBUSDT and SOLUSDT only.
//  Candles array: most recent is last. Needs at least 3 bars.
//  Each candle: { o, h, l, c } or { open, high, low, close }
//
//  LONG patterns (bullish reversal):
//    - Hammer:           long lower wick (≥2× body), small upper wick (<50% body)
//    - Inverted Hammer:  long upper wick (≥2× body), small lower wick (<50% body)
//    - Bullish Engulfing: green candle fully engulfs previous red candle body
//    - Morning Star:     [bearish] [small body doji/spinner] [bullish closes above mid-prev]
//
//  SHORT patterns (bearish reversal):
//    - Hanging Man:      same shape as hammer (long lower wick) at supply zone
//    - Shooting Star:    long upper wick (≥2× body), small lower wick (<50% body)
//    - Bearish Engulfing: red candle fully engulfs previous green candle body
//    - Evening Star:     [bullish] [small body doji/spinner] [bearish closes below mid-prev]
//
//  Returns: { pattern: string, isLong: bool } | null
//
//  offset: how many bars from the END to treat as "current".
//    0 (default) = most recent bar is current.
//    LBR_1M=1    = check at the PIVOT bar (1 bar before most recent confirmed bar,
//                  because the pivot confirms 1 bar after the actual pivot bar).
//    Use offset=LBR_1M when checking at pivot detection time so the pattern is
//    evaluated ON the pivot bar, not on the trailing confirmation bar.
function detectHommaPattern(candles, offset = 0) {
  if (!candles || candles.length < 3 + offset) return null;

  const n    = candles.length;
  const norm = (c) => ({ o: c.o ?? c.open, h: c.h ?? c.high, l: c.l ?? c.low, c: c.c ?? c.close });

  const cur  = norm(candles[n - 1 - offset]);
  const prev = norm(candles[n - 2 - offset]);
  const prev2= norm(candles[n - 3 - offset]);

  const body    = (c) => Math.abs(c.c - c.o);
  const upWick  = (c) => c.h - Math.max(c.o, c.c);
  const dnWick  = (c) => Math.min(c.o, c.c) - c.l;
  const range   = (c) => c.h - c.l;
  const isBull  = (c) => c.c >= c.o;  // >= handles doji-like candles
  const isBear  = (c) => c.c <= c.o;
  const midBody = (c) => (c.o + c.c) / 2;
  // On 1m crypto candles (no gaps, 24/7), bodies are small and wicks thin.
  // Relaxed thresholds vs classical definitions — keeps the spirit of each pattern.
  const isSmallBody = (c) => range(c) > 0 && body(c) / range(c) < 0.45;
  const MIN_BODY_RATIO = 0.0001; // body ≥ 0.01% of price — allows small 1m bodies

  const curBody = body(cur);
  const prevBody = body(prev);

  // ── Hammer (bullish): long lower wick ≥1.5× body, upper wick ≤100% of body ──
  if (curBody > cur.o * MIN_BODY_RATIO && dnWick(cur) >= curBody * 1.5 && upWick(cur) <= curBody) {
    return { pattern: 'Hammer', isLong: true };
  }

  // ── Inverted Hammer (bullish): long upper wick ≥1.5× body, lower wick ≤100% ─
  if (curBody > cur.o * MIN_BODY_RATIO && upWick(cur) >= curBody * 1.5 && dnWick(cur) <= curBody) {
    return { pattern: 'InvertedHammer', isLong: true };
  }

  // ── Bullish Engulfing: cur green body covers prev red body (gap-less crypto) ─
  if (isBull(cur) && isBear(prev) && prevBody > prev.o * MIN_BODY_RATIO &&
      cur.c >= prev.o && cur.o <= prev.c && curBody > prevBody * 0.8) {
    return { pattern: 'BullishEngulfing', isLong: true };
  }

  // ── Morning Star: [bearish][small body][bullish above mid of first] ──────────
  if (isBear(prev2) && isSmallBody(prev) && isBull(cur) &&
      body(prev2) > prev2.o * MIN_BODY_RATIO && cur.c > midBody(prev2)) {
    return { pattern: 'MorningStar', isLong: true };
  }

  // ── Wick Reversal (bullish): strong lower wick >55% of total range ───────────
  if (isBull(cur) && dnWick(cur) > range(cur) * 0.55) {
    return { pattern: 'WickReversal', isLong: true };
  }

  // ── Shooting Star (bearish): long upper wick ≥1.5× body, lower wick ≤100% ───
  if (curBody > cur.o * MIN_BODY_RATIO && upWick(cur) >= curBody * 1.5 && dnWick(cur) <= curBody) {
    return { pattern: 'ShootingStar', isLong: false };
  }

  // ── Hanging Man (bearish): long lower wick ≥1.5× body, upper wick ≤100% ─────
  if (curBody > cur.o * MIN_BODY_RATIO && dnWick(cur) >= curBody * 1.5 && upWick(cur) <= curBody) {
    return { pattern: 'HangingMan', isLong: false };
  }

  // ── Bearish Engulfing: cur red body covers prev green body (gap-less crypto) ─
  if (isBear(cur) && isBull(prev) && prevBody > prev.o * MIN_BODY_RATIO &&
      cur.c <= prev.o && cur.o >= prev.c && curBody > prevBody * 0.8) {
    return { pattern: 'BearishEngulfing', isLong: false };
  }

  // ── Evening Star: [bullish][small body][bearish below mid of first] ──────────
  if (isBull(prev2) && isSmallBody(prev) && isBear(cur) &&
      body(prev2) > prev2.o * MIN_BODY_RATIO && cur.c < midBody(prev2)) {
    return { pattern: 'EveningStar', isLong: false };
  }

  // ── Wick Rejection (bearish): strong upper wick >55% of total range ──────────
  if (isBear(cur) && upWick(cur) > range(cur) * 0.55) {
    return { pattern: 'WickRejection', isLong: false };
  }

  return null;
}

// Symbols that require a Homma candlestick confirmation as a hard gate
// ── CHoCH (Change of Character) detection ──────────────────────────────────
// CHoCH fires when the CURRENT TREND STRUCTURE IS BROKEN — the exact signal
// that catches big waves BEFORE normal pivot confirmation would fire.
//
// Bearish CHoCH (→ SHORT): In a bullish market (HH+HL), price CLOSES BELOW last HL.
//   The HL level is set every time a new 15m HL forms (update15m sets choch_bear_level).
//   This is the "Change of Character" from bullish to bearish → enter SHORT immediately.
//
// Bullish CHoCH (→ LONG): In a bearish market (LH+LL), price CLOSES ABOVE last LH.
//   The LH level is set every time a new 15m LH forms (update15m sets choch_bull_level).
//   This is the "Change of Character" from bearish to bullish → enter LONG immediately.
//
// CHoCH still respects the 4H gate: LONG CHoCH blocked if 4H=BEARISH, SHORT CHoCH blocked if
// 4H=BULLISH. A 15m structure break against the dominant 4H trend is usually a fake-out.
// CHoCH bypasses the 1m pivot confirmation wait only (level break IS the signal).
//
// Cooldown: 3 hours per direction — prevents re-firing on same move.
// Min break: 0.04% beyond the level — filters noise / wicks.
const CHOCH_COOLDOWN_MS   = 3 * 60 * 60 * 1000;  // 3 hours per direction
const CHOCH_MIN_BREAK_PCT = 0.0004;                // 0.04% clear break beyond level

function detectCHoCH(state, bar, nowMs) {
  if (!state.choch_bear_level && !state.choch_bull_level) return null;
  const price = bar.close;

  // Bearish CHoCH: 1m bar closes BELOW last 15m HL level
  if (state.choch_bear_level && state.choch_bear_fired === 0) {
    const breakFrac = (state.choch_bear_level - price) / state.choch_bear_level;
    if (breakFrac >= CHOCH_MIN_BREAK_PCT) {
      state.choch_bear_fired = nowMs;
      return { direction: 'SHORT', type: 'CHoCH', level: state.choch_bear_level, breakPct: (breakFrac * 100).toFixed(3) };
    }
  }

  // Bullish CHoCH: 1m bar closes ABOVE last 15m LH level
  if (state.choch_bull_level && state.choch_bull_fired === 0) {
    const breakFrac = (price - state.choch_bull_level) / state.choch_bull_level;
    if (breakFrac >= CHOCH_MIN_BREAK_PCT) {
      state.choch_bull_fired = nowMs;
      return { direction: 'LONG', type: 'CHoCH', level: state.choch_bull_level, breakPct: (breakFrac * 100).toFixed(3) };
    }
  }

  return null;
}

const HOMMA_GATE_SYMBOLS = new Set(['BNBUSDT', 'SOLUSDT']);

// ── Signal logic ───────────────────────────────────────────────
//
//  Pivot type decides direction — zone gates extremes only:
//    LL or HL pivot → tryLong()   (demand zone — buy the low)
//    HH or LH pivot → tryShort()  (supply zone — sell the high)
//
//  Why: HL often forms just BELOW VWAP (price dips to demand, then bounces).
//  Old code routed LOWER_MID → tryShort(), which missed every HL-in-lower-zone LONG.
//
//  4H gate: LONG blocked if 4H=BEARISH; SHORT blocked if 4H=BULLISH.
//  EXP-O:  LONG blocked if 4H=BULLISH && 15m=BULLISH (already overbought).
//          SHORT blocked if 4H=BEARISH && 15m=BEARISH (already oversold).
//
//  Pivot gate:
//    LONG:  15m HH or HL + 1m HH or HL  (bullish structure — confirmed up-pivots)
//    SHORT: 15m LL or LH + 1m LL or LH  (bearish structure — confirmed down-pivots)
//
//  Homma gate (BNB + SOL only — hard gate):
//    LONG:  requires a bullish Homma pattern on 1m (Hammer, InvHammer, BullEngulf, MorningStar)
//    SHORT: requires a bearish Homma pattern on 1m (ShootingStar, HangingMan, BearEngulf, EveningStar)
//
//  Chase filter (LONG):  price within MAX_CHASE_PCT of last 1m swing HIGH.
//  Chase filter (SHORT): price within MAX_SHORT_DROP_PCT of last 1m swing LOW.
// Maximum time allowed between the 15m pivot bar's open and the 1m entry:
// 30min (lbR=1 confirmation lag) + 10min (entry window) = 40min.
// After 40 minutes the 15m pivot is stale — price has already moved too far
// from the demand/supply zone for the entry to be meaningful.
const MAX_15M_PIVOT_AGE_MS = 75 * 60 * 1000;  // raised from 40min — LBR confirmation adds ~30min, leaving only 10min window at 40min

function resolveSignal(state, zone, price, vwap, nowMs, symbol) {
  const p15 = state.last15mPivotType;
  const p1m = state.last1mPivotType;

  // ── LONG: price at a LOW pivot (LL or HL) — demand zone entry ──────────────
  // HL = higher low  → price dipped to demand, buyers stepped in → LONG continuation
  // LL = new low     → price hit demand zone, potential bounce    → LONG reversal
  // Both place entry AT THE LOW — the point where buyers should be strongest.
  // 4H gate: if macro trend is BEARISH, demand zones tend to fail (lows break lower).
  function tryLong() {
    const s4h   = get4hStructure(state, price);
    const s15chk = get15mStructure(state, price);
    if (s4h === 'BEARISH') return null;   // macro downtrend — demand zones fail
    // When 4H is uncertain (MIXED/UNKNOWN), require 15m to EXPLICITLY confirm bullish.
    // MIXED 4H + MIXED/BEARISH 15m = no clear trend → skip entirely. Too many losers
    // come from trading in no-man's land when both timeframes are uncertain.
    if ((s4h === 'MIXED' || s4h === 'UNKNOWN') && s15chk !== 'BULLISH') return null;
    // Demand zone entry: 15m must be at a low; 1m can be LL/HL (at the low, classic)
    // OR HH (price already bouncing from demand — confirms support, entry still valid).
    // LH on 1m = price pulling back down toward demand still → skip (wait for bounce).
    const isDemand15 = p15 === 'LL' || p15 === 'HL';
    const isDemand1m = p1m === 'LL' || p1m === 'HL' || p1m === 'HH';
    if (!isDemand15 || !isDemand1m) return null;
    // Freshness: 1m entry must be within 10 candles (10 min) after 15m pivot confirms.
    // 15m pivot bar opens at last15mPivotTime → lbR=1 bar confirms ~30min later.
    // Entry window = confirmation + 10min = pivot bar open + 40min.
    // Beyond that, price has already bounced away from the demand zone — too late.
    if (nowMs && state.last15mPivotTime && nowMs - state.last15mPivotTime > MAX_15M_PIVOT_AGE_MS) return null;
    // Chase filter: don't enter if price already bounced far above the 1m swing low
    if (isChasing(price, state.sh1m_1)) return null;
    // VWAP: block if price is already well above the upper band (too extended for a low entry)
    if (vwap && vwap.stddev > 0) {
      const distAboveUpper = (price - vwap.upper) / vwap.stddev;
      if (distAboveUpper > MIN_DIST_SIGMA * 2) return null;
    }
    // Homma gate: BNB and SOL require a bullish candlestick pattern at the pivot bar.
    // offset=LBR_1M: check the pivot bar itself (1 bar before the latest confirmed bar).
    if (symbol && HOMMA_GATE_SYMBOLS.has(symbol)) {
      const homma = detectHommaPattern(state.candles1m, LBR_1M);
      if (!homma || !homma.isLong) return null;
    }
    return { direction: 'LONG', type: `${p15}+${p1m}` };
  }

  // ── SHORT: price at a HIGH pivot (HH or LH) — supply zone entry ─────────────
  // LH = lower high  → price bounced to supply, sellers rejected it → SHORT continuation
  // HH = new high    → price hit supply zone, potential reversal    → SHORT reversal
  // Both place entry AT THE HIGH — the point where sellers should be strongest.
  // 4H gate: if macro trend is BULLISH, supply zones tend to break (highs keep printing).
  function tryShort() {
    const s4h    = get4hStructure(state, price);
    const s15chk = get15mStructure(state, price);
    if (s4h === 'BULLISH') return null;   // macro uptrend — supply zones break
    // When 4H is uncertain (MIXED/UNKNOWN), require 15m to EXPLICITLY confirm bearish.
    // MIXED 4H + MIXED/BULLISH 15m = no clear trend → skip entirely. Don't short
    // into uncertainty — supply zones break when trend is ambiguous.
    if ((s4h === 'MIXED' || s4h === 'UNKNOWN') && s15chk !== 'BEARISH') return null;
    // Supply zone entry: 15m must be at a high; 1m can be HH/LH (at the high, classic)
    // OR LL (price already falling from supply — confirms rejection, entry still valid).
    // HL on 1m = price bouncing up toward supply still → skip (wait for rejection).
    const isSupply15 = p15 === 'HH' || p15 === 'LH';
    const isSupply1m = p1m === 'HH' || p1m === 'LH' || p1m === 'LL';
    if (!isSupply15 || !isSupply1m) return null;
    // Freshness: same 10-candle (10 min) window after 15m pivot confirms — see tryLong.
    if (nowMs && state.last15mPivotTime && nowMs - state.last15mPivotTime > MAX_15M_PIVOT_AGE_MS) return null;
    // Chase filter: don't enter if price already dropped far below the 1m swing high
    if (isShortTooLate(price, state.last15mPivotPrice)) return null;
    if (isShort1mTooLate(price, state.sl1m_1)) return null;
    // VWAP: block if price is already well below the lower band (too extended for a high entry)
    if (vwap && vwap.stddev > 0) {
      const distBelowLower = (vwap.lower - price) / vwap.stddev;
      if (distBelowLower > MIN_DIST_SIGMA * 2) return null;
    }
    // Homma gate: BNB and SOL require a bearish candlestick pattern at the pivot bar.
    // offset=LBR_1M: check the pivot bar itself (1 bar before the latest confirmed bar).
    if (symbol && HOMMA_GATE_SYMBOLS.has(symbol)) {
      const homma = detectHommaPattern(state.candles1m, LBR_1M);
      if (!homma || homma.isLong) return null;
    }
    return { direction: 'SHORT', type: `${p15}+${p1m}` };
  }

  // ── Dispatcher: pivot type → direction ────────────────────────────────────
  // LOW pivot  (LL or HL) = price at demand zone → LONG  (buy the low)
  // HIGH pivot (HH or LH) = price at supply zone → SHORT (sell the high)
  // Zone guard: don't LONG if price is already above upper band (ABOVE_UPPER)
  //             don't SHORT if price is already below lower band (BELOW_LOWER)
  const isLowPivot  = p15 === 'LL' || p15 === 'HL';
  const isHighPivot = p15 === 'HH' || p15 === 'LH';
  if (isLowPivot  && zone !== 'ABOVE_UPPER') return tryLong();
  if (isHighPivot && zone !== 'BELOW_LOWER') return tryShort();
  return null;
}

// ── Per-symbol analysis ────────────────────────────────────────
async function analyze(symbol, log) {
  const st = getState(symbol);

  // ── First call: seed swing trackers from history ─────────────
  if (!st.ready) {
    log(`[V4] ${symbol} warming up…`);
    const [c1m, c15m, c4h] = await Promise.all([
      fetchKlines(symbol, 1,   WARMUP_1M),
      fetchKlines(symbol, 15,  WARMUP_15M),
      fetchKlines(symbol, 240, WARMUP_4H),   // 240 min = 4H
    ]);

    // 15m: replay all CLOSED bars (exclude last = live)
    // Compute last15mPivotType during replay so it matches what TradingView
    // would show: each new pivot compared against the previous one of its kind.
    st.candles15m = c15m.slice(0, -1);
    for (let i = LBL_15M; i < st.candles15m.length - LBR_15M; i++) {
      const slice = st.candles15m.slice(0, i + LBR_15M + 1);
      const p = checkPivot(slice, LBL_15M, LBR_15M);
      if (p && p.bar.openTime !== st.last15mPivotTime) {
        st.last15mPivotTime = p.bar.openTime;
        if (p.isHigh) {
          const pivotType = (st.sh15_1 === null || p.bar.high > st.sh15_1) ? 'HH' : 'LH';
          st.sh15_2 = st.sh15_1; st.sh15_1 = p.bar.high;
          st.last15mPivotType = pivotType; st.last15mPivotPrice = p.bar.high;
          // Seed CHoCH bullish level: LH = break above this = bullish CHoCH → LONG
          if (pivotType === 'LH') { st.choch_bull_level = p.bar.high; st.choch_bull_fired = 0; }
        }
        if (p.isLow) {
          const pivotType = (st.sl15_1 === null || p.bar.low > st.sl15_1) ? 'HL' : 'LL';
          st.sl15_2 = st.sl15_1; st.sl15_1 = p.bar.low;
          st.last15mPivotType = pivotType; st.last15mPivotPrice = p.bar.low;
          // Seed CHoCH bearish level: HL = break below this = bearish CHoCH → SHORT
          if (pivotType === 'HL') { st.choch_bear_level = p.bar.low; st.choch_bear_fired = 0; }
        }
      }
    }

    // 1m: replay all CLOSED bars (exclude last = live)
    // Compute last1mPivotType in time order — same as 15m warmup above.
    st.candles1m = c1m.slice(0, -1);
    for (let i = LBL_1M; i < st.candles1m.length - LBR_1M; i++) {
      const slice = st.candles1m.slice(0, i + LBR_1M + 1);
      const p = checkPivot(slice, LBL_1M, LBR_1M);
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

    // 4H: replay all CLOSED bars (exclude last = live), build pivots4h[]
    st.candles4h = c4h.slice(0, -1);
    for (let i = LBL_4H; i < st.candles4h.length - LBR_4H; i++) {
      const slice = st.candles4h.slice(0, i + LBR_4H + 1);
      const p = checkPivot(slice, LBL_4H, LBR_4H);
      if (p && p.bar.openTime !== st.last4hPivotTime) {
        st.last4hPivotTime = p.bar.openTime;
        if (p.isHigh) {
          const lastH = findLastPivot(st.pivots4h, 'H');
          const label = (!lastH || p.bar.high > lastH.price) ? 'HH' : 'LH';
          st.sh4h_2 = st.sh4h_1; st.sh4h_1 = p.bar.high;
          st.pivots4h.push({ type: 'H', price: p.bar.high, time: p.bar.openTime, label });
          st.last4hPivotType = label; st.last4hPivotPrice = p.bar.high;
        }
        if (p.isLow) {
          const lastL = findLastPivot(st.pivots4h, 'L');
          const label = (!lastL || p.bar.low > lastL.price) ? 'HL' : 'LL';
          st.sl4h_2 = st.sl4h_1; st.sl4h_1 = p.bar.low;
          st.pivots4h.push({ type: 'L', price: p.bar.low, time: p.bar.openTime, label });
          st.last4hPivotType = label; st.last4hPivotPrice = p.bar.low;
        }
      }
    }
    if (st.pivots4h.length > 50) st.pivots4h = st.pivots4h.slice(-50);

    st.lastProcessed1m = st.candles1m.length ? st.candles1m[st.candles1m.length - 1].openTime : 0;
    st.ready = true;
    const struct4hReady = get4hStructure(st, null);
    const seq4h = st.pivots4h.slice(-4).map(x => `${x.label}@${x.price.toFixed(2)}`).join('→');
    log(`[V4] ${symbol} ready | 4H=${struct4hReady} [${seq4h}] | last_15m_pivot=${st.last15mPivotType||'none'}@${st.last15mPivotPrice?.toFixed(4)||'n/a'} | pivot lbL/lbR: 1m=${LBL_1M}/${LBR_1M} 15m=${LBL_15M}/${LBR_15M} 4H=${LBL_4H}/${LBR_4H}`);
    return null;
  }

  // ── Incremental: process only new CLOSED bars ────────────────
  const [fresh1m, fresh15m, fresh4h] = await Promise.all([
    fetchKlines(symbol, 1,   DELTA_1M),
    fetchKlines(symbol, 15,  DELTA_15M),
    fetchKlines(symbol, 240, DELTA_4H),
  ]);

  // 4H: add newly CLOSED bars (drop live = last), update 4H structure
  const last4ht = st.candles4h.length ? st.candles4h[st.candles4h.length - 1].openTime : 0;
  const new4h   = fresh4h.filter(c => c.openTime > last4ht).slice(0, -1);
  if (new4h.length) {
    st.candles4h.push(...new4h);
    if (st.candles4h.length > WARMUP_4H + 20) st.candles4h.splice(0, new4h.length);
    update4h(st);
  }

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
      const struct4h  = get4hStructure(st, diagBar.close);
      const struct15  = get15mStructure(st, diagBar.close);
      // Last 6 pivot labels from the sequence — shows exactly what TV SMC shows
      const pivotSeq  = st.pivots15m.slice(-6).map(x => `${x.label}@${x.price.toFixed(2)}`).join(' → ');
      const seq4hDiag = st.pivots4h.slice(-4).map(x => `${x.label}@${x.price.toFixed(2)}`).join('→');
      // ABOVE_UPPER=LONG, UPPER_MID=SHORT, LOWER_MID=LONG, BELOW_LOWER=SHORT
      const zoneSide = (diagZone === 'ABOVE_UPPER' || diagZone === 'LOWER_MID') ? 'LONG' : 'SHORT';
      log(`[V4-DIAG] ${symbol} zone=${diagZone}(${zoneSide}) 4H=${struct4h}[${seq4hDiag}] 15m=${struct15} price=${diagBar.close.toFixed(4)} | seq=[${pivotSeq}] | 15m=${st.last15mPivotType||'none'}@${st.last15mPivotPrice?.toFixed(4)||'n/a'} sh=${st.sh15_1?.toFixed(4)}/${st.sh15_2?.toFixed(4)} sl=${st.sl15_1?.toFixed(4)}/${st.sl15_2?.toFixed(4)}${dropFromHigh} | 1m=${st.last1mPivotType||'none'}@${st.last1mPivotPrice?.toFixed(4)||'n/a'} | sl1m=${st.sl1m_1?.toFixed(4)}/${st.sl1m_2?.toFixed(4)} gap=${gapPct}%(${gapOk?'OK':'BLOCKED'})`);
    }
  }

  for (const bar of new1m) {
    st.candles1m.push(bar);
    if (st.candles1m.length > WARMUP_1M + 50) st.candles1m.shift();

    // ── Step 1: Fire deferred signal on this bar's OPEN ──────────
    // Pivot confirmed on the previous bar → enter at the open of the next
    // candle.  Before firing, run EVERY check through resolveSignal() as
    // the single source of truth — zone, 4H structure, VWAP band proximity,
    // 15m/1m pivot type, 1m gap, live-state chase/drop.  Only after that
    // full gate passes do we also apply the frozen-ref chase/drop (using
    // the pivot price captured at queue time, which is more conservative
    // than the current st.sl1m_1 / st.sh1m_1 which may have shifted).
    if (st.pendingSignal) {
      const pending = st.pendingSignal;
      st.pendingSignal = null;
      const vwapNext = calcVwap(st.candles15m, bar.openTime);
      if (!vwapNext) {
        log(`[V4] pending ${symbol} ${pending.direction} cancelled — no VWAP data at fire bar`);
      } else {
        const entryPrice = bar.open;
        const zoneNext   = getZone(entryPrice, vwapNext);

        // Full re-validation via resolveSignal() — same function used at signal
        // creation, now evaluated against actual entry price and live state.
        // CHoCH entries bypass resolveSignal() re-validation — the level break IS the signal.
        // Normal SMC entries go through full re-validation (4H gate + pivot type + chase filter).
        let resolved, frozenOk;
        if (pending.choch) {
          // CHoCH: only check that price hasn't reversed hard against the direction
          // (e.g., if CHoCH SHORT fired but price immediately shot back up 0.5%, abort)
          const MAX_CHOCH_REVERSAL = 0.003;  // 0.3% reversal cancels CHoCH entry
          const revPct = pending.direction === 'SHORT'
            ? (entryPrice - pending.price) / pending.price   // SHORT: bad if price went UP
            : (pending.price - entryPrice) / pending.price;  // LONG:  bad if price went DOWN
          resolved = revPct < MAX_CHOCH_REVERSAL ? { direction: pending.direction, type: 'CHoCH' } : null;
          frozenOk = true;
          if (!resolved) log(`[V4-CHoCH] ${symbol} ${pending.direction} CHoCH entry CANCELLED — price reversed ${(revPct*100).toFixed(3)}% against direction`);
        } else {
          resolved = resolveSignal(st, zoneNext, entryPrice, vwapNext, bar.openTime, symbol);
          // Frozen-ref chase/drop using pivot refs frozen at queue time.
          const frozenRef = pending.direction === 'SHORT' ? pending.sh1m_1 : pending.sl1m_1;
          frozenOk = pending.direction === 'SHORT'
            ? !isShort1mTooLate(entryPrice, frozenRef)
            : !isChasing(entryPrice, frozenRef);
        }

        if (resolved && resolved.direction === pending.direction && frozenOk) {
          signal = { ...pending, price: entryPrice, zone: zoneNext };
          if (pending.direction === 'SHORT') {
            const frozenRef = pending.sh1m_1;
            const dropPct = frozenRef ? ((frozenRef - entryPrice) / frozenRef * 100).toFixed(3) : 'n/a';
            log(`[V4] ✓ ${symbol} SHORT entry=$${entryPrice.toFixed(4)} zone=${zoneNext} type=${pending.type} drop=${dropPct}% vs sh1m_frozen=${frozenRef?.toFixed(4)} 4H=${get4hStructure(st, entryPrice)} vwap=OK`);
          } else {
            const frozenRef = pending.sl1m_1;
            const chasePct = frozenRef ? ((entryPrice - frozenRef) / frozenRef * 100).toFixed(3) : 'n/a';
            log(`[V4] ✓ ${symbol} LONG  entry=$${entryPrice.toFixed(4)} zone=${zoneNext} type=${pending.type} chase=${chasePct}% vs sl1m_frozen=${frozenRef?.toFixed(4)} 4H=${get4hStructure(st, entryPrice)} vwap=OK`);
          }
        } else {
          // Diagnose exactly which check failed
          let cancelReason;
          if (!resolved && pending.choch) {
            // CHoCH entry cancelled by reversal guard (price moved against direction before fill)
            cancelReason = `CHoCH ${pending.direction} reversed before entry fill`;
          } else if (!resolved) {
            const s4h  = get4hStructure(st, entryPrice);
            const p15  = st.last15mPivotType;
            const p1m  = st.last1mPivotType;
            const zoneDir = (zoneNext === 'UPPER_MID' || zoneNext === 'ABOVE_UPPER') ? 'SHORT' : 'LONG';  // BELOW_LOWER is now LONG

            if (false) {
              cancelReason = '';  // BELOW_LOWER LONG is now allowed — handled by resolveSignal
            } else if (zoneDir !== pending.direction) {
              cancelReason = `zone changed: ${pending.zone}→${zoneNext} now wants ${zoneDir}, had ${pending.direction}`;
            } else if (pending.direction === 'LONG' && s4h === 'BEARISH') {
              cancelReason = `4H=BEARISH — LONG blocked (macro downtrend, demand zones fail)`;
            } else if (pending.direction === 'LONG') {
              const isDemand15 = p15 === 'LL' || p15 === 'HL';
              const isDemand1m = p1m === 'LL' || p1m === 'HL';
              const pivotAgeMs = st.last15mPivotTime ? bar.openTime - st.last15mPivotTime : 0;
              if (pivotAgeMs > MAX_15M_PIVOT_AGE_MS) {
                cancelReason = `15m pivot stale: ${Math.round(pivotAgeMs/60000)}min ago (limit=40min) — price already bounced, entry too late`;
              } else if (!isDemand15) {
                cancelReason = `15m pivot flipped to ${p15} — need LL or HL for LONG (demand zone)`;
              } else if (!isDemand1m) {
                cancelReason = `1m pivot flipped to ${p1m} — need LL or HL for LONG (demand zone)`;
              } else if (!is1mGapOk(st.sl1m_1, st.sl1m_2)) {
                const g = (st.sl1m_1 && st.sl1m_2) ? (Math.abs(st.sl1m_1 - st.sl1m_2) / st.sl1m_2 * 100).toFixed(3) : 'n/a';
                cancelReason = `1m gap=${g}% too wide (limit=${MAX_1M_GAP_PCT}%)`;
              } else if (isChasing(entryPrice, st.sl1m_1)) {
                const c = st.sl1m_1 ? ((entryPrice - st.sl1m_1) / st.sl1m_1 * 100).toFixed(3) : 'n/a';
                cancelReason = `live chase=${c}% above sl1m (limit=${MAX_CHASE_PCT}%)`;
              } else {
                const dist = (entryPrice - vwapNext.lower) / vwapNext.stddev;
                cancelReason = `VWAP proximity ${dist.toFixed(2)}σ above lower band (limit=${MIN_DIST_SIGMA * 2}σ)`;
              }
            } else {
              // SHORT
              const isSupply15 = p15 === 'HH' || p15 === 'LH';
              const isSupply1m = p1m === 'HH' || p1m === 'LH';
              const pivotAgeMs = st.last15mPivotTime ? bar.openTime - st.last15mPivotTime : 0;
              if (pivotAgeMs > MAX_15M_PIVOT_AGE_MS) {
                cancelReason = `15m pivot stale: ${Math.round(pivotAgeMs/60000)}min ago (limit=40min) — price already dropped, entry too late`;
              } else if (!isSupply15) {
                cancelReason = `15m pivot flipped to ${p15} — need HH or LH for SHORT (supply zone)`;
              } else if (!isSupply1m) {
                cancelReason = `1m pivot flipped to ${p1m} — need HH or LH for SHORT (supply zone)`;
              } else if (isShortTooLate(entryPrice, st.last15mPivotPrice)) {
                const d = st.last15mPivotPrice ? ((st.last15mPivotPrice - entryPrice) / st.last15mPivotPrice * 100).toFixed(3) : 'n/a';
                cancelReason = `15m drop=${d}% already past pivot (limit=${MAX_SHORT_DROP_PCT}%)`;
              } else if (isShort1mTooLate(entryPrice, st.sh1m_1)) {
                const d = st.sh1m_1 ? ((st.sh1m_1 - entryPrice) / st.sh1m_1 * 100).toFixed(3) : 'n/a';
                cancelReason = `1m drop=${d}% already past sh1m_live=${st.sh1m_1?.toFixed(4)} (limit=${MAX_SHORT_DROP_PCT}%)`;
              } else {
                const dist = (vwapNext.upper - entryPrice) / vwapNext.stddev;
                cancelReason = `VWAP proximity ${dist.toFixed(2)}σ below upper band (limit=${MIN_DIST_SIGMA * 2}σ) — entry in the middle, not near resistance`;
              }
            }
          } else if (resolved && resolved.direction !== pending.direction) {
            cancelReason = `resolveSignal wants ${resolved.direction} but pending was ${pending.direction}`;
          } else if (!pending.choch) {
            // frozen-ref failed (SMC entries only — CHoCH handles its own reversal check above)
            const frozenRefDiag = pending.direction === 'SHORT' ? pending.sh1m_1 : pending.sl1m_1;
            if (pending.direction === 'SHORT') {
              const d = frozenRefDiag ? ((frozenRefDiag - entryPrice) / frozenRefDiag * 100).toFixed(3) : 'n/a';
              cancelReason = `frozen drop=${d}% past sh1m_frozen=${frozenRefDiag?.toFixed(4)} (limit=${MAX_SHORT_DROP_PCT}%)`;
            } else {
              const c = frozenRefDiag ? ((entryPrice - frozenRefDiag) / frozenRefDiag * 100).toFixed(3) : 'n/a';
              cancelReason = `frozen chase=${c}% above sl1m_frozen=${frozenRefDiag?.toFixed(4)} (limit=${MAX_CHASE_PCT}%)`;
            }
          }
          log(`[V4] pending ${symbol} ${pending.direction} CANCELLED — ${cancelReason} | zone=${pending.zone}→${zoneNext} 4H=${get4hStructure(st, entryPrice)} 15m=${st.last15mPivotType||'none'} 1m=${st.last1mPivotType||'none'}`);
        }
      }
    }

    // ── Step 2: Check for a new pivot confirmation on this bar ────
    const pivotTime = update1m(st);

    // ── CHoCH Fast Entry: fires BEFORE normal pivot-based SMC ────────────────────
    // CHoCH fires when the current market structure is BROKEN on the 15m level.
    // Bypasses 4H gate (CHoCH IS the 4H-level structural break) and the 1m pivot wait.
    // Only fires once per HL/LH level (resets when a new HL or LH forms on 15m).
    // Does NOT fire if a signal is already pending or a position is already open (zoneTraded).
    if (!st.pendingSignal && !signal) {
      const choch = detectCHoCH(st, bar, bar.openTime);
      if (choch) {
        const vwapC = calcVwap(st.candles15m, bar.openTime);
        const zoneC = vwapC ? getZone(bar.close, vwapC) : 'UNKNOWN';
        // Soft VWAP zone guard: don't CHoCH SHORT when already at extreme lows (BELOW_LOWER),
        // don't CHoCH LONG when already at extreme highs (ABOVE_UPPER) — those are traps.
        const zoneOk = (choch.direction === 'SHORT' && zoneC !== 'BELOW_LOWER')
                    || (choch.direction === 'LONG'  && zoneC !== 'ABOVE_UPPER');
        // 4H gate: CHoCH LONG requires 4H not BEARISH; CHoCH SHORT requires 4H not BULLISH.
        // CHoCH catches 15m structure breaks but should not fight the dominant 4H trend.
        const h4 = get4hStructure(st, bar.close);
        const trendOk = (choch.direction === 'LONG'  && h4 !== 'BEARISH')
                     || (choch.direction === 'SHORT' && h4 !== 'BULLISH');
        if (!trendOk) {
          log(`[V4-CHoCH] ${symbol} ${choch.direction} CHoCH blocked — 4H=${h4} opposes trade direction`);
        }
        if (zoneOk && trendOk) {
          log(`[V4-CHoCH] ⚡ ${symbol} ${choch.direction} — broke ${choch.direction === 'SHORT' ? 'HL' : 'LH'}@${choch.level.toFixed(2)} by ${choch.breakPct}% | price=${bar.close.toFixed(2)} zone=${zoneC} 4H=${get4hStructure(st, bar.close)} → queuing entry next candle`);
          // Queue as pending so the deferred fire mechanism enters at next bar open.
          // CHoCH entries bypass resolveSignal() re-validation at fire time (they have their own gate).
          st.pendingSignal = {
            direction: choch.direction,
            type:      'CHoCH',
            zone:      zoneC,
            price:     bar.close,   // reference price (overwritten at fire time)
            sh1m_1:    st.sh1m_1,
            sl1m_1:    st.sl1m_1,
            score:     75,
            choch:     true,        // flag: skip resolveSignal() re-validation at fire time
          };
          // NOTE: intentionally NOT setting lastLongTime/lastShortTime for CHoCH.
          // CHoCH has its own one-shot cooldown (choch_bear_fired/choch_bull_fired).
          // Setting the 3h SMC cooldown here would block regular pivot entries for 3h after
          // every CHoCH — that's too aggressive. The two systems run independently.
          st.zoneTraded = true;
        } else {
          log(`[V4-CHoCH] ${symbol} ${choch.direction} CHoCH detected but zone=${zoneC} is extreme — skipping (trap risk)`);
        }
      }
    }

    if (pivotTime && pivotTime !== st.lastSignalTime) {
      const vwap = calcVwap(st.candles15m, bar.openTime);
      if (vwap) {
        const zone = getZone(bar.close, vwap);

        // Zone GROUP cooldown — reset when:
        //   (a) price crosses to the opposite group (PREMIUM ↔ DISCOUNT), OR
        //   (b) price ESCALATES within the same group to a more extreme zone:
        //       UPPER_MID → ABOVE_UPPER (broke through upper band = new HH extreme)
        //       LOWER_MID → BELOW_LOWER (broke through lower band = new LL extreme)
        // Normal oscillation within the same sub-zone does NOT reset (no repeated signals
        // at the same level). Escalation = price extended further = fresh opportunity.
        const zoneGroup = (zone === 'ABOVE_UPPER' || zone === 'UPPER_MID') ? 'PREMIUM' : 'DISCOUNT';
        if (zoneGroup !== st.prevZone) {
          st.prevZone = zoneGroup;
          st.prevZoneExact = zone;
          st.zoneTraded = false;
        } else if (zone !== st.prevZoneExact) {
          // Escalation within the same group = price pushed into more extreme
          // territory = fresh reversal opportunity at the new band.
          // UPPER_MID → ABOVE_UPPER: bull push through upper band = extreme SHORT.
          // LOWER_MID → BELOW_LOWER: bear push through lower band = extreme LONG.
          const escalated = (zone === 'ABOVE_UPPER' && st.prevZoneExact === 'UPPER_MID')
                         || (zone === 'BELOW_LOWER' && st.prevZoneExact === 'LOWER_MID');
          if (escalated) {
            log(`[V4] zone escalation ${st.prevZoneExact}→${zone} — resetting zoneTraded for fresh signal at new extreme`);
            st.zoneTraded = false;
          }
          st.prevZoneExact = zone;
        }

        const nowMs = bar.openTime;
        const MIN_DIR_GAP = 3 * 60 * 60 * 1000;  // EXP-O: per-direction 3-hour cooldown

        const sig = resolveSignal(st, zone, bar.close, vwap, bar.openTime, symbol);

        // Per-direction cooldown — allows opposite direction to fire independently
        if (sig && sig.direction === 'LONG'  && nowMs - st.lastLongTime  < MIN_DIR_GAP) continue;
        if (sig && sig.direction === 'SHORT' && nowMs - st.lastShortTime < MIN_DIR_GAP) continue;
        const piv15t = st.last15mPivotType || 'none';
        const piv1mt  = st.last1mPivotType  || 'none';
        const longOk  = (piv15t==='HH'||piv15t==='HL') && (piv1mt==='HH'||piv1mt==='HL');
        const shortOk = (piv15t==='LL'||piv15t==='LH') && (piv1mt==='LL'||piv1mt==='LH');
        log(`[V4-SIG] ${symbol} zone=${zone} 4H=${get4hStructure(st, bar.close)} 15m=${get15mStructure(st, bar.close)} piv15=${piv15t} piv1m=${piv1mt} longOk=${longOk} shortOk=${shortOk} price=${bar.close.toFixed(4)} traded=${st.zoneTraded} → ${sig && !st.zoneTraded ? sig.direction+'+'+sig.type : (sig ? 'ZONE_TRADED' : 'NO_SIGNAL')}`);
        if (sig && !st.zoneTraded) {
          st.lastSignalTime = pivotTime;
          st.zoneTraded     = true;
          if (sig.direction === 'LONG')  st.lastLongTime  = bar.openTime;
          if (sig.direction === 'SHORT') st.lastShortTime = bar.openTime;
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
          // Diagnose why no signal — 4H gate + zone + pivot check
          const pType    = st.last15mPivotType || 'none';
          const p1Type   = st.last1mPivotType  || 'none';
          const pPrice   = st.last15mPivotPrice?.toFixed(4) || 'n/a';
          const dropPct  = st.last15mPivotPrice ? ((st.last15mPivotPrice - bar.close) / st.last15mPivotPrice * 100).toFixed(3) : 'n/a';
          const gapOk2   = is1mGapOk(st.sl1m_1, st.sl1m_2);
          const chasing2 = isChasing(bar.close, st.sl1m_1);
          const chasePct2 = st.sl1m_1 ? ((bar.close - st.sl1m_1) / st.sl1m_1 * 100).toFixed(3) : 'n/a';
          const gapPct2   = (st.sl1m_1 && st.sl1m_2) ? (Math.abs(st.sl1m_1 - st.sl1m_2) / st.sl1m_2 * 100).toFixed(3) : 'n/a';
          const s4h = get4hStructure(st, bar.close);
          const s15 = get15mStructure(st, bar.close);
          const isDiscount = zone === 'BELOW_LOWER' || zone === 'LOWER_MID';
          const isPremium  = zone === 'ABOVE_UPPER'  || zone === 'UPPER_MID';

          if (s4h === 'BEARISH' && isDiscount) {
            // 4H bearish LONG block — the primary new gate
            log(`[V4] LONG BLOCKED — ${symbol} 4H=BEARISH zone=${zone} (waiting for 4H to base before LONG)`);
          } else if (s4h === 'BULLISH' && !isDiscount) {
            log(`[V4] no signal — ${symbol} 4H=BULLISH zone=${zone} (need LOWER_MID for LONG)`);
          } else if (s4h === 'BEARISH' && !isPremium) {
            log(`[V4] no signal — ${symbol} 4H=BEARISH zone=${zone} (need ABOVE_UPPER/UPPER_MID for SHORT)`);
          } else if (s4h !== 'BULLISH' && s4h !== 'BEARISH' && s15 === 'BULLISH' && !isDiscount) {
            log(`[V4] no signal — ${symbol} 4H=MIXED 15m=BULLISH zone=${zone} (need discount zone for LONG)`);
          } else if (s4h !== 'BULLISH' && s4h !== 'BEARISH' && s15 === 'BEARISH' && !isPremium) {
            log(`[V4] no signal — ${symbol} 4H=MIXED 15m=BEARISH zone=${zone} (need premium zone for SHORT)`);
          } else if (isDiscount) {
            // Right zone for LONG — diagnose pivot issue
            if (pType !== 'HH' && pType !== 'HL') {
              log(`[V4] no signal — ${symbol} zone=${zone} 4H=${s4h} 15m=${pType} (need 15m HH or HL for LONG)`);
            } else if (!gapOk2) {
              log(`[V4] LONG WAIT — ${symbol} zone=${zone} 4H=${s4h} 15m=${pType} gap=${gapPct2}% too wide (need ≤${MAX_1M_GAP_PCT}%)`);
            } else if (chasing2) {
              log(`[V4] LONG WAIT — ${symbol} zone=${zone} 4H=${s4h} 15m=${pType} 1m=${p1Type} chase=${chasePct2}% above sl1m`);
            } else {
              log(`[V4] no signal — ${symbol} zone=${zone} 4H=${s4h} 15m=${pType} 1m=${p1Type} (need 1m HH or HL)`);
            }
          } else if (isPremium) {
            // Right zone for SHORT — diagnose pivot issue
            if (pType !== 'LL' && pType !== 'LH') {
              log(`[V4] no signal — ${symbol} zone=${zone} 4H=${s4h} 15m=${pType} (need 15m LL or LH for SHORT)`);
            } else if (isShortTooLate(bar.close, st.last15mPivotPrice)) {
              log(`[V4] SHORT BLOCKED — ${symbol} zone=${zone} 4H=${s4h} 15m=${pType} dropped ${dropPct}% (>${MAX_SHORT_DROP_PCT}% from pivot)`);
            } else {
              log(`[V4] no signal — ${symbol} zone=${zone} 4H=${s4h} 15m=${pType} 1m=${p1Type} (need 1m LL or LH)`);
            }
          } else {
            log(`[V4] no signal — ${symbol} zone=${zone} 4H=${s4h} 15m=${s15} piv=${pType}/${p1Type}@${pPrice}`);
          }
        }
      }
    }

    st.lastProcessed1m = bar.openTime;
  }

  if (!signal) return null;

  const leverage = SYMBOL_LEVERAGE[symbol] ?? 100;
  const slPct    = SYMBOL_SL_PCT[symbol] ?? 0.0025;  // per-symbol SL price distance
  const riskPct  = slPct * leverage;                  // fraction of trade capital at risk
  // SL above entry for SHORT, below entry for LONG
  const sl = signal.direction === 'SHORT'
    ? signal.price * (1 + slPct)
    : signal.price * (1 - slPct);
  const tp = signal.direction === 'SHORT'
    ? signal.price * (1 - slPct * 2)
    : signal.price * (1 + slPct * 2);

  // ── TV-parity diagnostic log ──
  // Prints every signal in a format the user can paste next to their
  // TradingView SMC Pro chart to verify the bot saw the same pivots.
  // Format: SYMBOL DIR zone=ZONE 15m=TYPE@$PRICE 1m=TYPE@$PRICE entry=$X sl=$X tp=$X
  log(`[V4-SIGNAL-TV] ${symbol} ${signal.direction} zone=${signal.zone} ` +
      `15m=${st.last15mPivotType}@$${st.last15mPivotPrice} ` +
      `1m=${st.last1mPivotType}@$${st.last1mPivotPrice} ` +
      `entry=$${signal.price} sl=$${sl.toFixed(8)} tp=$${tp.toFixed(8)}`);

  return {
    symbol,
    direction:  signal.direction,
    side:       signal.direction,
    signal:     signal.direction === 'SHORT' ? 'SELL' : 'BUY',
    lastPrice:  signal.price,
    entry:      signal.price,
    sl,
    tp,
    slPct:      (slPct * 100).toFixed(3),
    tpPct:      (slPct * 200).toFixed(3),
    riskPct:    (riskPct * 100).toFixed(1),
    leverage,
    setupName:  `V4-${signal.type}`,
    score:      5,
    zone:       signal.zone,
    signalType: signal.type,
    timeframe:  '4H+15m+1m',
    version:    'v4',
    tp1: tp, tp2: null, tp3: null,
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

module.exports = { scanV4SMC, analyzeV4SMC, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE, SYMBOL_SL_PCT };
