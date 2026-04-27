// ============================================================
// Strategy V2 — Two-Step Swing Confirmation Entry
//
// Step 1 — 15m chart: wait for a swing point to FORM.
//   Swing HIGH formed (HH or LH) → bias = SHORT
//   Swing LOW  formed (HL or LL) → bias = LONG
//   Do NOT enter yet.
//
// Step 2 — 1m chart: wait for a matching swing to confirm.
//   LONG  bias → wait for 1m HL or LL → enter on the NEXT candle
//   SHORT bias → wait for 1m HH or LH → enter on the NEXT candle
//
// Stop Loss:  fixed at -15% of margin capital (leverage-adjusted price)
// Trail:      activates at +30% capital profit → locks breakeven (0%)  [30% gap]
//             then every +10% more capital → lock steps up 10%         [10% gap]
//             30 → 0% | 40 → 30% | 50 → 40% | 60 → 50% | …
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');
const { getMarketIntel, applyMarketIntel, heatmapToLevels } = require('./coinglass-data');

// ── Constants ─────────────────────────────────────────────────

const V2_SL_CAPITAL_PCT    = 0.15; // initial SL: -15% of margin
const V2_TRAIL_START_PCT   = 0.20; // trail activates at +20% capital profit → lock breakeven
const V2_TRAIL_STEP_PCT    = 0.10; // trail steps every 10% capital gain after activation
const V2_TRAIL_GAP_PCT     = 0.10; // gap on subsequent steps (10%); first step gap is 20%

// Only accept 15m swing points formed within last N bars
const SWING15_RECENCY_BARS = 8;
// Only accept 1m confirmation swing within last N bars — tight so entry is close to the swing
const SWING1_RECENCY_BARS  = 2;

// ── Candle parser ─────────────────────────────────────────────

function parseCandle(k) {
  return {
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
    openTime:  parseInt(k[0]),
    closeTime: parseInt(k[6]),
  };
}

// ── Fetch klines ──────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit = 100) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    return res.json();
  } catch (_) { return null; }
}

// ── Swing point detection ─────────────────────────────────────

/**
 * Find all pivot highs and lows in a parsed candle array.
 * pivot = candle strictly higher/lower than N bars on each side.
 */
function findPivots(parsed, bars = 2) {
  const highs = [];
  const lows  = [];
  for (let i = bars; i < parsed.length - bars; i++) {
    let isHigh = true;
    let isLow  = true;
    for (let j = 1; j <= bars; j++) {
      if (parsed[i].high <= parsed[i - j].high || parsed[i].high <= parsed[i + j].high) isHigh = false;
      if (parsed[i].low  >= parsed[i - j].low  || parsed[i].low  >= parsed[i + j].low)  isLow  = false;
    }
    if (isHigh) highs.push({ price: parsed[i].high, index: i });
    if (isLow)  lows.push({ price: parsed[i].low,  index: i });
  }
  return { highs, lows };
}

/**
 * Classify the most recent swing type relative to the previous one.
 * Returns 'HH' | 'LH' for highs, 'HL' | 'LL' for lows.
 */
function classifySwing(pivots) {
  if (pivots.length < 2) return null;
  const last = pivots[pivots.length - 1];
  const prev = pivots[pivots.length - 2];
  return last.price > prev.price
    ? (pivots === pivots ? 'HH_or_HL' : null)  // placeholder — caller differentiates
    : 'LH_or_LL';
}

// ── Step 1: 15m swing bias ────────────────────────────────────

/**
 * Scans 15m chart for the most recently formed swing point.
 * Returns { direction, swingType, swingPrice, barsAgo } or null.
 *
 * Swing HIGH (HH or LH) → direction = SHORT
 * Swing LOW  (HL or LL) → direction = LONG
 */
function detect15mSwing(klines15m) {
  if (!klines15m || klines15m.length < 20) return null;
  const parsed = klines15m.map(parseCandle);
  const total  = parsed.length;

  const { highs, lows } = findPivots(parsed, 2);
  if (!highs.length || !lows.length) return null;

  const lastSH = highs[highs.length - 1];
  const prevSH = highs.length >= 2 ? highs[highs.length - 2] : null;
  const lastSL = lows[lows.length - 1];
  const prevSL = lows.length >= 2  ? lows[lows.length - 2]  : null;

  // Bars since each last swing formed (higher = older)
  const shAge = total - 1 - lastSH.index;
  const slAge = total - 1 - lastSL.index;

  // Classify swing types
  const shType = prevSH ? (lastSH.price > prevSH.price ? 'HH' : 'LH') : null;
  const slType = prevSL ? (lastSL.price > prevSL.price ? 'HL' : 'LL') : null;

  // Pick the more recently formed swing
  const useHigh = shAge <= slAge && shType !== null;
  const useLow  = slAge <  shAge && slType !== null;

  if (useHigh) {
    if (shAge > SWING15_RECENCY_BARS) return null; // too old
    return {
      direction:  'SHORT',
      swingType:  shType,          // 'HH' or 'LH'
      swingPrice: lastSH.price,
      barsAgo:    shAge,
    };
  } else if (useLow) {
    if (slAge > SWING15_RECENCY_BARS) return null;
    return {
      direction:  'LONG',
      swingType:  slType,          // 'HL' or 'LL'
      swingPrice: lastSL.price,
      barsAgo:    slAge,
    };
  }

  return null;
}

// ── Step 2: 1m entry confirmation ────────────────────────────

/**
 * Confirms the entry signal on the 1m chart.
 *
 * LONG  bias → look for 1m HL or LL → enter on NEXT (current) candle
 * SHORT bias → look for 1m HH or LH → enter on NEXT (current) candle
 *
 * Returns { entryPrice, sl, confirm1m } or null.
 */
function detect1mEntry(klines1m, setupDirection, leverage) {
  if (!klines1m || klines1m.length < 5) return null;
  const parsed = klines1m.map(parseCandle);
  const total  = parsed.length;

  // The last candle is the ENTRY candle (the "next candle" after confirmation)
  const entryCandleIdx = total - 1;
  // Scan the candles BEFORE the entry candle for the confirmation swing
  // We use a 1-bar pivot over the candles excluding the current forming candle
  const { highs, lows } = findPivots(parsed.slice(0, entryCandleIdx), 1);

  const entryPrice = parsed[entryCandleIdx].close;

  if (setupDirection === 'LONG') {
    // Need HL or LL on 1m
    if (lows.length < 2) return null;
    const lastSL = lows[lows.length - 1];
    const prevSL = lows[lows.length - 2];
    const barsAgo = (entryCandleIdx - 1) - lastSL.index; // relative to pre-entry slice
    if (barsAgo > SWING1_RECENCY_BARS) return null;

    const swingType = lastSL.price > prevSL.price ? 'HL' : 'LL';
    // Deduct fees from SL budget so NET loss ≤ V2_SL_CAPITAL_PCT
    const feesCapPct = 0.0008 * leverage; // 0.04% taker × 2 sides × leverage
    const netSlPct   = Math.max(0, V2_SL_CAPITAL_PCT - feesCapPct) / leverage;
    const slPrice    = entryPrice * (1 - netSlPct);

    return {
      entryPrice,
      sl:       slPrice,
      confirm1m: `1m_${swingType}`,
      slStructure: lastSL.price, // actual 1m swing low (for reference)
    };
  } else {
    // SHORT: need HH or LH on 1m
    if (highs.length < 2) return null;
    const lastSH = highs[highs.length - 1];
    const prevSH = highs[highs.length - 2];
    const barsAgo = (entryCandleIdx - 1) - lastSH.index;
    if (barsAgo > SWING1_RECENCY_BARS) return null;

    const swingType = lastSH.price > prevSH.price ? 'HH' : 'LH';
    const feesCapPct = 0.0008 * leverage;
    const netSlPct   = Math.max(0, V2_SL_CAPITAL_PCT - feesCapPct) / leverage;
    const slPrice    = entryPrice * (1 + netSlPct);

    return {
      entryPrice,
      sl:       slPrice,
      confirm1m: `1m_${swingType}`,
      slStructure: lastSH.price,
    };
  }
}

// ── VWAP midline direction gate ───────────────────────────────

function getVwapBias(klines15m, price) {
  if (!klines15m || klines15m.length < 3) return 'unknown';
  const parsed = klines15m.map(parseCandle);
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const today = parsed.filter(c => c.openTime >= dayStart);
  const candles = today.length >= 3 ? today : parsed;

  let cumTV = 0, cumV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTV += tp * c.volume;
    cumV  += c.volume;
  }
  if (cumV === 0) return 'unknown';
  const vwap = cumTV / cumV;
  return price >= vwap ? 'above' : 'below';
}

// ── Main signal detector ──────────────────────────────────────

/**
 * Full V2 signal pipeline for one symbol.
 * Returns signal object or null.
 */
async function detectV2Signal(symbol, leverage = 20) {
  const [klines15m, klines1m, marketIntel] = await Promise.all([
    fetchKlines(symbol, '15m', 120),
    fetchKlines(symbol, '1m',  30),
    getMarketIntel(symbol),
  ]);

  if (!klines15m || !klines1m) return null;

  const price = parseFloat(klines1m[klines1m.length - 1][4]); // last 1m close

  // ── VWAP gate: above VWAP → LONG only · below VWAP → SHORT only ──
  // Spikes are caught by detectMomentumBreakout (bypasses all gates) — not V2.
  // V2 is a structure strategy and must respect VWAP direction.
  const vwapBias = getVwapBias(klines15m, price);
  if (vwapBias === 'unknown') return null;

  // ── Step 1: 15m swing setup ───────────────────────────────────
  const swing15 = detect15mSwing(klines15m);
  if (!swing15) return null;

  // Block direction against VWAP: above VWAP → no SHORT · below VWAP → no LONG
  if (vwapBias === 'above' && swing15.direction === 'SHORT') return null;
  if (vwapBias === 'below' && swing15.direction === 'LONG')  return null;

  // ── Funding rate / OI hard block ──────────────────────────────
  const intel = applyMarketIntel(marketIntel, swing15.direction);
  if (intel.block) {
    bLog.scan(`[V2] ${symbol} blocked: ${intel.block}`);
    return null;
  }

  // ── Step 2: 1m entry confirmation ────────────────────────────
  const entry = detect1mEntry(klines1m, swing15.direction, leverage);
  if (!entry) return null;

  // Reasonable SL distance check: 0.05% – 5% of price
  const slDist = Math.abs(entry.entryPrice - entry.sl) / entry.entryPrice;
  if (slDist < 0.0005 || slDist > 0.05) return null;

  // Build signal
  const setupName = `V2_${swing15.direction}_${swing15.swingType}_${entry.confirm1m}`;
  const intelBonus = intel.scoreDelta;

  // TP is not fixed — trail takes over. Use 2× SL as initial TP reference only.
  const tp1 = swing15.direction === 'LONG'
    ? entry.entryPrice * (1 + (slDist * 2))
    : entry.entryPrice * (1 - (slDist * 2));

  // Add liquidation cluster levels near entry as context
  const liqLevels = heatmapToLevels(marketIntel?.heatmapLevels, price);
  const nearLiq = liqLevels.find(l => Math.abs(l.price - entry.entryPrice) / entry.entryPrice < 0.005);

  return {
    symbol,
    direction:   swing15.direction,
    price:       entry.entryPrice,
    sl:          entry.sl,
    tp1,
    slDist,
    rr:          2.0, // trail takes over — 2:1 is the floor reference
    score:       7 + intelBonus + (nearLiq ? 2 : 0),
    setup:       'STRATEGY_V2',
    setupName,
    leverage,
    structure: {
      swing15:    `${swing15.swingType} @ ${swing15.swingPrice.toFixed(4)} (${swing15.barsAgo}bars ago)`,
      confirm1m:  entry.confirm1m,
      slStructure: entry.slStructure?.toFixed(4),
      vwapBias,
      fundingRate: marketIntel?.fundingRate ?? null,
      oiTrend:     marketIntel?.oiTrend     ?? null,
      lsRatio:     marketIntel?.longRatio   ? `L${(marketIntel.longRatio*100).toFixed(0)}%/S${(marketIntel.shortRatio*100).toFixed(0)}%` : null,
      liqCluster:  nearLiq ? `$${(nearLiq.liqUsd/1e6).toFixed(1)}M @ ${nearLiq.price}` : null,
      trailRule:   `SL=-${V2_SL_CAPITAL_PCT*100}%cap | trail@+${V2_TRAIL_START_PCT*100}%cap→BE | step+${V2_TRAIL_STEP_PCT*100}%cap | gap=${V2_TRAIL_GAP_PCT*100}%`,
    },
  };
}

// ── Trailing SL calculator (used by trail-watchdog) ───────────

/**
 * V2 trailing stop logic:
 *   - Trail activates at +31% capital profit
 *   - SL locked at each 10% milestone: 30 → 40 → 50 → …
 *
 * Returns new SL price if it improves on currentSl, else null.
 *
 * @param {number} entryPrice
 * @param {number} curPrice
 * @param {boolean} isLong
 * @param {number} leverage
 * @param {number} currentSl  current SL price stored in DB
 * @returns {number|null}
 */
function calcV2TrailSL(entryPrice, curPrice, isLong, leverage, currentSl) {
  const pricePct = isLong
    ? (curPrice - entryPrice) / entryPrice
    : (entryPrice - curPrice) / entryPrice;
  const capitalPct = pricePct * leverage;

  // Trail hasn't activated yet
  if (capitalPct < V2_TRAIL_START_PCT) return null;

  // First step (capitalPct 0.30–0.39): lock breakeven (0%) — 30% gap.
  // All steps after: lock = step floor − 10% gap.
  //
  //   capitalPct 0.30 → step 3 → first tier  → milestone = 0.00  (breakeven, 30% gap)
  //   capitalPct 0.40 → step 4 → 4×0.10−0.10 → milestone = 0.30  (10% gap)
  //   capitalPct 0.50 → step 5 → 5×0.10−0.10 → milestone = 0.40  (10% gap)
  //
  // NOTE: integer arithmetic avoids Math.floor(0.40/0.10) = 3.9999 edge case.
  const stepsRaw = Math.floor(Math.round(capitalPct * 1000) / Math.round(V2_TRAIL_STEP_PCT * 1000));
  const milestone = stepsRaw <= 2
    ? 0                                             // first tier (+20%) → breakeven (20% gap)
    : Math.max(0, stepsRaw * V2_TRAIL_STEP_PCT - V2_TRAIL_GAP_PCT); // 10% gap

  // Convert milestone capital % → price
  const milestonePrice = isLong
    ? entryPrice * (1 + milestone / leverage)
    : entryPrice * (1 - milestone / leverage);

  // Only move if it improves the SL.
  // NOTE: currentSl = 0 means "no SL set yet" — treat as worst-case for each direction
  // so the first milestone always gets written (avoids 0 blocking SHORT trades).
  const effectiveSl = currentSl === 0
    ? (isLong ? -Infinity : Infinity)
    : currentSl;
  if (isLong  && milestonePrice <= effectiveSl) return null;
  if (!isLong && milestonePrice >= effectiveSl) return null;

  return { newSl: milestonePrice, milestone, capitalPct };
}

module.exports = {
  detectV2Signal,
  detect15mSwing,
  detect1mEntry,
  calcV2TrailSL,
  V2_SL_CAPITAL_PCT,
  V2_TRAIL_START_PCT,
  V2_TRAIL_STEP_PCT,
};
