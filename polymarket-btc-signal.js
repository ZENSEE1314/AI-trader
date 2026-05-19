// ============================================================
// Polymarket BTC Signal Reader
//
// Reads the 15-min price history of the Polymarket BTC YES token
// (currently "Will BTC hit $1M before GTA VI?" — the most liquid
// BTC prediction market) and derives a directional momentum signal.
//
// The YES token price == crowd probability that BTC is rising.
// When the probability TRENDS UP on the 15m chart → crowd is buying
// BTC optimism → LONG signal.
// When it TRENDS DOWN → crowd selling BTC optimism → SHORT signal.
//
// Also used by swarm-engine.js to inject prediction-market
// sentiment into the KronosAgent Swarm simulation.
// ============================================================

const CLOB_HOST   = 'https://clob.polymarket.com';
const GAMMA_API   = 'https://gamma-api.polymarket.com';
const TIMEOUT_MS  = 10_000;

// ── BTC Market Registry ─────────────────────────────────────
// Top liquid BTC prediction markets — YES token IDs (probability of BTC going up).
// Updated programmatically at startup; seeded with known IDs for reliability.
const BTC_YES_TOKENS = [
  {
    label:   'BTC hits $1M',
    tokenId: '105267568073659068217311993901927962476298440625043565106676088842803600775810',
    weight:  1.0,
  },
];

// In-memory 15-min history buffer  { tokenId → [{ts, price}] }
const _priceHistory = new Map();
const HISTORY_MAX_AGE_MS = 4 * 60 * 60 * 1000; // keep 4 hours

// ── Helpers ──────────────────────────────────────────────────

async function _fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Polymarket ${res.status}: ${url}`);
  return res.json();
}

// ── Live probability snapshot ─────────────────────────────────

async function _getTokenMidPrice(tokenId) {
  try {
    const data = await _fetchJson(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
    return parseFloat(data?.mid || data?.midpoint || 0);
  } catch {
    return 0;
  }
}

// ── 15-min OHLC history from CLOB ─────────────────────────────
// fidelity=15 → 15-minute buckets; returns [{t, p}] (unix timestamp, close price)

async function _get15mHistory(tokenId, hoursBack = 4) {
  try {
    const startTs = Math.floor((Date.now() - hoursBack * 3600_000) / 1000);
    const url = `${CLOB_HOST}/prices-history?token_id=${tokenId}&interval=max&fidelity=15&start_ts=${startTs}`;
    const data = await _fetchJson(url);
    const candles = data?.history || data?.prices || [];
    // Normalise to [{ts_ms, price}]
    return candles.map(c => ({
      ts_ms: (c.t || c.ts || 0) * 1000,
      price: parseFloat(c.p || c.price || c.c || 0),
    })).filter(c => c.price > 0 && c.ts_ms > 0);
  } catch {
    return [];
  }
}

// ── Auto-discover additional liquid BTC markets ───────────────

async function refreshBTCMarkets() {
  try {
    const markets = await _fetchJson(
      `${GAMMA_API}/markets?closed=false&tag_slug=bitcoin&limit=50`
    );
    const sorted = (Array.isArray(markets) ? markets : [])
      .filter(m => m.active && parseFloat(m.volume || 0) > 50_000)
      .sort((a, b) => parseFloat(b.volume) - parseFloat(a.volume))
      .slice(0, 5);

    for (const m of sorted) {
      const yesToken = (m.tokens || []).find(t => t.outcome?.toLowerCase() === 'yes');
      if (!yesToken) continue;
      const already = BTC_YES_TOKENS.some(t => t.tokenId === yesToken.token_id);
      if (!already) {
        BTC_YES_TOKENS.push({
          label:   m.question?.slice(0, 50) || m.slug,
          tokenId: yesToken.token_id,
          weight:  Math.min(2, parseFloat(m.volume) / 1_000_000), // volume-weighted
        });
      }
    }
  } catch {
    // Non-fatal — use seeded tokens
  }
}

// ── Core signal computation ───────────────────────────────────

/**
 * Returns the current Polymarket BTC directional signal.
 *
 * Uses 15-min CLOB history for each registered BTC YES token,
 * calculates slope over the last N candles, and returns a
 * volume-weighted composite direction.
 *
 * @param {Object} opts
 * @param {number} [opts.lookbackCandles=3]  how many 15m candles to use for slope
 * @param {number} [opts.minChange=0.003]    minimum prob change to avoid neutral
 * @returns {Promise<{
 *   direction: 'LONG'|'SHORT'|'NEUTRAL',
 *   confidence: number,       // 0-100
 *   probChange: number,       // weighted average 15m prob delta
 *   currentProb: number,      // latest composite probability (0-1)
 *   markets: string[],        // market labels used
 *   candles: number,          // candles analysed
 * }>}
 */
async function getBTCSignal({ lookbackCandles = 3, minChange = 0.003 } = {}) {
  const results = [];

  for (const token of BTC_YES_TOKENS) {
    const candles = await _get15mHistory(token.tokenId, 2);
    if (candles.length < 2) {
      // Fallback: compare live mid vs cached last reading
      const now = await _getTokenMidPrice(token.tokenId);
      const hist = _priceHistory.get(token.tokenId) || [];
      const prev = hist.length > 0 ? hist[hist.length - 1].price : 0;
      if (now > 0 && prev > 0) {
        results.push({ change: now - prev, weight: token.weight, label: token.label, currentProb: now });
      }
      if (now > 0) {
        const newHist = [...hist, { ts_ms: Date.now(), price: now }]
          .filter(h => Date.now() - h.ts_ms < HISTORY_MAX_AGE_MS);
        _priceHistory.set(token.tokenId, newHist);
      }
      continue;
    }

    // Use last N candles to compute slope
    const recent = candles.slice(-Math.max(lookbackCandles, 2));
    const oldest = recent[0].price;
    const latest = recent[recent.length - 1].price;
    const change  = latest - oldest;

    results.push({
      change,
      weight:      token.weight,
      label:       token.label,
      currentProb: latest,
      candles:     recent.length,
    });
  }

  if (!results.length) {
    return { direction: 'NEUTRAL', confidence: 0, probChange: 0, currentProb: 0.5, markets: [], candles: 0 };
  }

  const totalWeight   = results.reduce((s, r) => s + r.weight, 0);
  const weightedDelta = results.reduce((s, r) => s + r.change * r.weight, 0) / totalWeight;
  const avgProb       = results.reduce((s, r) => s + r.currentProb * r.weight, 0) / totalWeight;

  // Confidence scales with signal strength — 0.02 prob change = 100 confidence
  const rawConf = Math.min(100, Math.abs(weightedDelta) / 0.02 * 100);
  const confidence = Math.round(rawConf);

  let direction = 'NEUTRAL';
  if (weightedDelta >  minChange) direction = 'LONG';
  if (weightedDelta < -minChange) direction = 'SHORT';

  return {
    direction,
    confidence,
    probChange:  weightedDelta,
    currentProb: avgProb,
    markets:     results.map(r => r.label),
    candles:     results[0]?.candles || 0,
  };
}

// ── Single-call summary for swarm seed injection ──────────────

/**
 * Returns a concise snapshot for the Swarm Engine persona prompt.
 * Includes current probability, 15-min trend, and market names.
 */
async function getSwarmSeed() {
  const sig = await getBTCSignal({ lookbackCandles: 3 });
  return {
    polymarketProb:    (sig.currentProb * 100).toFixed(1),
    polymarketTrend:   sig.direction,
    polymarketConf:    sig.confidence,
    polymarketDelta:   (sig.probChange * 100).toFixed(2),
    polymarketMarkets: sig.markets.join(', '),
  };
}

// Kick off market refresh (non-blocking)
refreshBTCMarkets().catch(() => {});

module.exports = {
  getBTCSignal,
  getSwarmSeed,
  refreshBTCMarkets,
  BTC_YES_TOKENS,
};
