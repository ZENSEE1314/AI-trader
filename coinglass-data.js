// ============================================================
// Market Intelligence — Funding Rate, Open Interest,
// Long/Short Ratio (Binance free) + Coinglass Liquidation
// Heatmap (requires COINGLASS_API_KEY env var).
//
// How each data point improves trades:
//   Funding rate   — extreme positive → longs overcrowded → block LONG
//                    extreme negative → shorts overcrowded → block SHORT
//   Open interest  — OI rising + price falling = strong downtrend
//                    OI rising + price rising  = strong uptrend
//   L/S ratio      — >70% one side = contrarian pressure (market will hunt them)
//   Liq heatmap    — real liquidation cluster levels added to S/R map
//                    so stop-hunt strategy targets the right price
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const TIMEOUT_MS        = 8000;
const CACHE_TTL_MS      = 3 * 60 * 1000;  // 3 min — funding/OI change slowly
const HEATMAP_CACHE_TTL = 10 * 60 * 1000; // 10 min — heatmap is heavy

// Funding rate thresholds
const FUNDING_BLOCK_LONG  =  0.0005; // +0.05% → longs overcrowded → block LONG
const FUNDING_BLOCK_SHORT = -0.0005; // −0.05% → shorts overcrowded → block SHORT
const FUNDING_WARN_LONG   =  0.0003; // +0.03% → longs getting crowded → −1 score
const FUNDING_WARN_SHORT  = -0.0003; // −0.03% → shorts getting crowded → −1 score

// Long/short ratio thresholds
const LS_EXTREME_LONG  = 0.70; // ≥70% longs → contrarian SHORT pressure
const LS_EXTREME_SHORT = 0.30; // ≤30% longs → contrarian LONG pressure

// ── Per-symbol cache ─────────────────────────────────────────

const cache = {};     // { [symbol]: { data, ts } }
const heatmapCache = {}; // { [coin]: { levels, ts } }

function isFresh(entry, ttl) {
  return entry && Date.now() - entry.ts < ttl;
}

// ── Fetch helpers ────────────────────────────────────────────

async function safeFetch(url, opts = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (_) {
    return null;
  }
}

// ── Binance — Funding Rate ────────────────────────────────────

async function fetchFundingRate(symbol) {
  // Returns current funding rate (e.g. 0.0001 = 0.01%)
  const res = await safeFetch(
    `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`
  );
  if (!res || !res.ok) return null;
  try {
    const d = await res.json();
    return parseFloat(d.lastFundingRate);
  } catch (_) { return null; }
}

// ── Binance — Open Interest ───────────────────────────────────

async function fetchOpenInterest(symbol) {
  // Returns open interest in contracts (base asset)
  const res = await safeFetch(
    `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`
  );
  if (!res || !res.ok) return null;
  try {
    const d = await res.json();
    return parseFloat(d.openInterest);
  } catch (_) { return null; }
}

// ── Binance — Open Interest History (for OI trend) ───────────

async function fetchOIHistory(symbol, period = '5m', limit = 12) {
  // Returns array of OI snapshots to detect rising/falling OI
  const res = await safeFetch(
    `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`
  );
  if (!res || !res.ok) return null;
  try {
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const latest = parseFloat(arr[arr.length - 1].sumOpenInterest);
    const oldest = parseFloat(arr[0].sumOpenInterest);
    const changePct = (latest - oldest) / oldest;
    return { latest, oldest, changePct, trend: changePct > 0.005 ? 'rising' : changePct < -0.005 ? 'falling' : 'flat' };
  } catch (_) { return null; }
}

// ── Binance — Global Long/Short Ratio ────────────────────────

async function fetchLongShortRatio(symbol, period = '5m', limit = 1) {
  const res = await safeFetch(
    `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`
  );
  if (!res || !res.ok) return null;
  try {
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr[0]) return null;
    const longRatio  = parseFloat(arr[0].longAccount);   // e.g. 0.55
    const shortRatio = parseFloat(arr[0].shortAccount);  // e.g. 0.45
    return { longRatio, shortRatio };
  } catch (_) { return null; }
}

// ── Coinglass — Liquidation Heatmap ──────────────────────────
// Requires COINGLASS_API_KEY environment variable.
// Returns array of { price, liquidationUsd } sorted by liquidationUsd desc.

async function fetchLiquidationHeatmap(coin = 'ETH', range = '12h') {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) return null;

  // Cache check
  const cacheKey = `${coin}_${range}`;
  if (isFresh(heatmapCache[cacheKey], HEATMAP_CACHE_TTL)) {
    return heatmapCache[cacheKey].data;
  }

  try {
    const res = await safeFetch(
      `https://open-api.coinglass.com/public/v2/liquidation_map?symbol=${coin}&timeType=${range}`,
      { headers: { coinglassSecret: apiKey } }
    );
    if (!res || !res.ok) return null;
    const json = await res.json();

    if (!json.data) return null;
    // Coinglass returns { priceList, shortLiqMap, longLiqMap }
    const { priceList, shortLiqMap, longLiqMap } = json.data;
    if (!priceList || !Array.isArray(priceList)) return null;

    const levels = priceList.map((price, i) => ({
      price: parseFloat(price),
      longLiqUsd:  (longLiqMap?.[i]  || 0) * 1e6,
      shortLiqUsd: (shortLiqMap?.[i] || 0) * 1e6,
      totalLiqUsd: ((longLiqMap?.[i] || 0) + (shortLiqMap?.[i] || 0)) * 1e6,
    }));

    // Keep only levels with significant liquidation clusters (>$500k)
    const significant = levels
      .filter(l => l.totalLiqUsd > 500_000)
      .sort((a, b) => b.totalLiqUsd - a.totalLiqUsd);

    heatmapCache[cacheKey] = { data: significant, ts: Date.now() };
    return significant;
  } catch (_) { return null; }
}

// ── Main: fetch all data for a symbol ────────────────────────

async function getMarketIntel(symbol) {
  if (isFresh(cache[symbol], CACHE_TTL_MS)) {
    return cache[symbol].data;
  }

  // Coin name for heatmap (strip USDT)
  const coin = symbol.replace(/USDT$/, '').replace(/PERP$/, '');

  const [fundingRate, oiHistory, lsRatio, heatmap] = await Promise.all([
    fetchFundingRate(symbol),
    fetchOIHistory(symbol),
    fetchLongShortRatio(symbol),
    fetchLiquidationHeatmap(coin),
  ]);

  const intel = {
    symbol,
    fundingRate,           // raw float, e.g. 0.0001
    oiTrend: oiHistory?.trend  || 'flat',
    oiChangePct: oiHistory?.changePct || 0,
    longRatio:  lsRatio?.longRatio  || null,
    shortRatio: lsRatio?.shortRatio || null,
    heatmapLevels: heatmap || [],  // array of { price, totalLiqUsd, longLiqUsd, shortLiqUsd }
    ts: Date.now(),
  };

  cache[symbol] = { data: intel, ts: Date.now() };
  return intel;
}

// ── Scoring helpers used by liquidity-sweep-engine ───────────

/**
 * Returns a score delta and optional hard-block for a signal
 * based on funding rate, OI, and L/S ratio.
 *
 * @returns { scoreDelta: number, block: string|null }
 */
function applyMarketIntel(intel, direction) {
  if (!intel) return { scoreDelta: 0, block: null };

  const { fundingRate, oiTrend, oiChangePct, longRatio } = intel;
  let scoreDelta = 0;
  let block = null;

  // ── Funding Rate ──────────────────────────────────────────
  if (fundingRate !== null) {
    // Extreme crowding → hard block
    if (fundingRate >= FUNDING_BLOCK_LONG && direction === 'LONG') {
      block = `LONG blocked — funding rate +${(fundingRate * 100).toFixed(4)}%: longs overcrowded, market will punish them`;
    } else if (fundingRate <= FUNDING_BLOCK_SHORT && direction === 'SHORT') {
      block = `SHORT blocked — funding rate ${(fundingRate * 100).toFixed(4)}%: shorts overcrowded`;
    }

    // Warning zone → score penalty
    if (!block) {
      if (fundingRate >= FUNDING_WARN_LONG  && direction === 'LONG')  scoreDelta -= 2;
      if (fundingRate <= FUNDING_WARN_SHORT && direction === 'SHORT') scoreDelta -= 2;
      // Contrarian bonus: shorting into high positive funding = smart
      if (fundingRate >= FUNDING_WARN_LONG  && direction === 'SHORT') scoreDelta += 2;
      if (fundingRate <= FUNDING_WARN_SHORT && direction === 'LONG')  scoreDelta += 2;
    }
  }

  // ── Open Interest trend ───────────────────────────────────
  if (!block) {
    if (oiTrend === 'rising' && direction === 'LONG')  scoreDelta += 2; // OI up + long = conviction
    if (oiTrend === 'rising' && direction === 'SHORT') scoreDelta += 2; // OI up + short = conviction
    if (oiTrend === 'falling')                         scoreDelta -= 1; // de-risking environment
  }

  // ── Long/Short ratio ─────────────────────────────────────
  if (!block && longRatio !== null) {
    if (longRatio >= LS_EXTREME_LONG && direction === 'SHORT') {
      scoreDelta += 3; // 70%+ longs → market will hunt them → SHORT is smart
    }
    if (longRatio <= LS_EXTREME_SHORT && direction === 'LONG') {
      scoreDelta += 3; // 70%+ shorts → market will hunt them → LONG is smart
    }
    // Penalty for going with the crowd when it's very crowded
    if (longRatio >= LS_EXTREME_LONG && direction === 'LONG')  scoreDelta -= 2;
    if (longRatio <= LS_EXTREME_SHORT && direction === 'SHORT') scoreDelta -= 2;
  }

  return { scoreDelta, block };
}

/**
 * Converts heatmap liquidation levels into S/R level objects
 * compatible with the allLevels array in liquidity-sweep-engine.
 *
 * Large short liquidation cluster above price → acts as resistance (stop hunt target for SHORT entry)
 * Large long  liquidation cluster below price → acts as support   (stop hunt target for LONG  entry)
 */
function heatmapToLevels(heatmapLevels, currentPrice) {
  if (!heatmapLevels || !heatmapLevels.length) return [];

  return heatmapLevels
    .filter(l => l.totalLiqUsd > 1_000_000) // only $1M+ clusters
    .map(l => {
      const pctFromPrice = (l.price - currentPrice) / currentPrice;
      // Which side dominates determines level type
      const dominated = l.longLiqUsd > l.shortLiqUsd ? 'long_cluster' : 'short_cluster';
      return {
        price:    l.price,
        type:     dominated,
        strength: Math.min(5, Math.floor(l.totalLiqUsd / 5_000_000) + 1), // 1-5 strength
        source:   'coinglass_heatmap',
        liqUsd:   l.totalLiqUsd,
        pctAway:  pctFromPrice,
      };
    })
    .filter(l => Math.abs(l.pctAway) < 0.05); // only within 5% of current price
}

/**
 * Log a human-readable market intel summary.
 */
function logMarketIntel(symbol, intel) {
  if (!intel) return;
  const fr  = intel.fundingRate !== null ? `${(intel.fundingRate * 100).toFixed(4)}%` : 'n/a';
  const ls  = intel.longRatio   !== null ? `L${(intel.longRatio*100).toFixed(0)}%/S${(intel.shortRatio*100).toFixed(0)}%` : 'n/a';
  const oi  = `OI ${intel.oiTrend}`;
  const liq = intel.heatmapLevels.length ? `${intel.heatmapLevels.length} liq levels` : 'no liq data';
  bLog.scan(`[MarketIntel] ${symbol} | funding=${fr} | ${ls} | ${oi} | ${liq}`);
}

module.exports = {
  getMarketIntel,
  applyMarketIntel,
  heatmapToLevels,
  logMarketIntel,
  fetchLiquidationHeatmap,
};
