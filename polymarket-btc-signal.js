// ============================================================
// Polymarket BTC Signal Reader
//
// Two signal sources:
//
// 1. getBTCUpDownSignal() — tracks the live "BTC Up or Down 15m"
//    market on Polymarket. The Up token price IS the crowd's
//    probability that BTC goes up in the next 15 minutes.
//    This is the primary source for PolyBTCAgent trades.
//
// 2. getBTCSignal() — longer-term composite from top liquid BTC
//    markets (e.g. "Will BTC hit $1M?"). Used by swarm-engine.
// ============================================================

const CLOB_HOST  = 'https://clob.polymarket.com';
const GAMMA_API  = 'https://gamma-api.polymarket.com';
const TIMEOUT_MS = 10_000;

// ── Helpers ──────────────────────────────────────────────────

async function _fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Polymarket ${res.status}: ${url}`);
  return res.json();
}

async function _getTokenMidPrice(tokenId) {
  try {
    const data = await _fetchJson(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
    return parseFloat(data?.mid || data?.midpoint || 0);
  } catch {
    return 0;
  }
}

async function _get15mHistory(tokenId, hoursBack = 4) {
  try {
    const endTs   = Math.floor(Date.now() / 1000);
    const startTs = endTs - hoursBack * 3600;
    const url = `${CLOB_HOST}/prices-history?market=${tokenId}&fidelity=15&startTs=${startTs}&endTs=${endTs}`;
    const data = await _fetchJson(url);
    const candles = data?.history || data?.prices || [];
    return candles.map(c => ({
      ts_ms: (c.t || c.ts || 0) * 1000,
      price: parseFloat(c.p || c.price || c.c || 0),
    })).filter(c => c.price > 0 && c.ts_ms > 0);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// Part 1 — "BTC Up or Down 15m" market discovery + signal
// ═══════════════════════════════════════════════════════════════

// Cache: { upTokenId, downTokenId, question, slug, fetchedAt }
let _btc15mMarket = null;

// Rolling price history for the Up token — { ts_ms, price, slug }[]
const _upTokenHistory = [];
const UP_HISTORY_MAX  = 30;

// Slot size for "BTC Up or Down 15m" markets (seconds)
const SLOT_SEC = 900; // 15 × 60

/**
 * Compute the slug for the 15m market that is active RIGHT NOW.
 * Slug format: btc-updown-15m-{unix_start_of_current_slot}
 * where start = floor(now_sec / 900) * 900  (UTC 15-min boundaries)
 */
function _currentSlugAndNeighbours() {
  const nowSec     = Math.floor(Date.now() / 1000);
  const currentStart = Math.floor(nowSec / SLOT_SEC) * SLOT_SEC;
  return [
    `btc-updown-15m-${currentStart}`,           // current window
    `btc-updown-15m-${currentStart - SLOT_SEC}`, // previous (might still be tradeable)
    `btc-updown-15m-${currentStart + SLOT_SEC}`, // next (might open early)
  ];
}

/**
 * Find the current active "BTC Up or Down 15m" Polymarket market.
 * Uses computed slug — no tag search needed.
 * Returns { upTokenId, downTokenId, question, slug } or null.
 */
async function getBTC15mMarket() {
  const nowMs = Date.now();
  // Refresh every 13 min — well before next 15-min slot opens
  if (_btc15mMarket && nowMs - _btc15mMarket.fetchedAt < 13 * 60_000) {
    return _btc15mMarket;
  }

  const slugs = _currentSlugAndNeighbours();

  for (const slug of slugs) {
    try {
      const ev = await _fetchJson(`${GAMMA_API}/events?slug=${slug}`);
      // Gamma returns an array when queried with ?slug=
      const event = Array.isArray(ev) ? ev[0] : ev;
      if (!event?.markets?.length) continue;

      const mkt      = event.markets[0];
      const tokenIds = mkt.clobTokenIds || [];
      const outcomes = mkt.outcomes     || [];

      // Outcomes are ["Up","Down"] in index order matching clobTokenIds
      const upIdx   = outcomes.findIndex(o => o.toLowerCase() === 'up');
      const downIdx = outcomes.findIndex(o => o.toLowerCase() === 'down');

      const upTokenId   = tokenIds[upIdx   >= 0 ? upIdx   : 0] || null;
      const downTokenId = tokenIds[downIdx >= 0 ? downIdx : 1] || null;

      if (!upTokenId || !downTokenId) continue;

      _btc15mMarket = {
        upTokenId,
        downTokenId,
        slug,
        question: mkt.question || event.title || slug,
        fetchedAt: nowMs,
        closed: mkt.closed || event.closed || false,
      };
      console.log(
        `[poly-btc-signal] Market: "${_btc15mMarket.question}" ` +
        `Up=${upTokenId.slice(0, 10)}... Down=${downTokenId.slice(0, 10)}... ` +
        `closed=${_btc15mMarket.closed}`
      );
      return _btc15mMarket;
    } catch (e) {
      console.warn(`[poly-btc-signal] slug ${slug} fetch failed: ${e.message}`);
    }
  }

  console.warn('[poly-btc-signal] No active BTC Up/Down 15m market found');
  return null;
}

/**
 * Momentum signal based on the "BTC Up or Down 15m" Up-token price.
 *
 * The Up token price = crowd probability BTC rises in the next 15 min.
 * Rising Up price → more bullish → LONG signal.
 * Falling Up price → more bearish → SHORT signal.
 *
 * @returns {Promise<{
 *   direction: 'LONG'|'SHORT'|'NEUTRAL',
 *   confidence: number,       // 0–100
 *   upPrice:    number,       // current Up token probability (0–1)
 *   downPrice:  number,       // current Down token probability (0–1)
 *   change:     number,       // Up price change vs lookback
 *   market:     string,       // market question
 *   upTokenId:  string,
 *   downTokenId:string,
 * }>}
 */
/**
 * Signal for the "BTC Up or Down 15m" market.
 *
 * Strategy: bet WITH the crowd direction when it has any edge.
 * The Up-token price = crowd probability BTC goes up.
 *
 *   Up > 0.55 → crowd leans LONG  → BUY Up token
 *   Up < 0.45 → crowd leans SHORT → BUY Down token
 *   0.45–0.55 → too close to call → NEUTRAL (skip)
 *
 * Fires on FIRST call — no warm-up, no history needed.
 * Confidence = how far the crowd is from 50/50 (0–100 scale).
 *
 * Also returns bestAsk for Up/Down so the caller can bid correctly.
 */
async function getBTCUpDownSignal() {
  const NEUTRAL = (market = '', upTokenId = '', downTokenId = '') => ({
    direction: 'NEUTRAL', confidence: 0, upPrice: 0.5, downPrice: 0.5,
    upAsk: 0.5, downAsk: 0.5, market, upTokenId, downTokenId,
  });

  const mkt = await getBTC15mMarket();
  if (!mkt)            return NEUTRAL();
  if (mkt.closed)      return NEUTRAL(mkt.question, mkt.upTokenId, mkt.downTokenId);

  // Get live orderbook for both tokens in parallel
  const [upData, downData] = await Promise.all([
    _getTokenBook(mkt.upTokenId),
    _getTokenBook(mkt.downTokenId),
  ]);

  const upPrice = upData.mid;
  if (!upPrice || upPrice <= 0 || upPrice >= 1) {
    return NEUTRAL(mkt.question, mkt.upTokenId, mkt.downTokenId);
  }

  const downPrice = 1 - upPrice;
  const deviation = upPrice - 0.5;                         // positive = crowd leans up
  const confidence = Math.min(100, Math.round(Math.abs(deviation) / 0.5 * 100));

  const MIN_DEVIATION = 0.05; // need at least 55/45 split to trade
  let direction = 'NEUTRAL';
  if (deviation >  MIN_DEVIATION) direction = 'LONG';
  if (deviation < -MIN_DEVIATION) direction = 'SHORT';

  return {
    direction,
    confidence,
    upPrice,
    downPrice,
    upAsk:   upData.ask,
    downAsk: downData.ask,
    market:  mkt.question,
    upTokenId:   mkt.upTokenId,
    downTokenId: mkt.downTokenId,
  };
}

/** Fetch mid + best ask for a token from the CLOB orderbook. */
async function _getTokenBook(tokenId) {
  try {
    const [midData, bookData] = await Promise.all([
      _fetchJson(`${CLOB_HOST}/midpoint?token_id=${tokenId}`).catch(() => null),
      _fetchJson(`${CLOB_HOST}/book?token_id=${tokenId}`).catch(() => null),
    ]);
    const mid = parseFloat(midData?.mid || midData?.midpoint || 0);
    // asks are sorted ascending — lowest ask first
    const asks = bookData?.asks || bookData?.data?.asks || [];
    const bestAsk = asks.length > 0 ? parseFloat(asks[0]?.price || asks[0] || 0) : mid + 0.01;
    return { mid, ask: bestAsk || mid + 0.01 };
  } catch {
    return { mid: 0, ask: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// Part 2 — longer-term composite BTC signal (existing)
// ═══════════════════════════════════════════════════════════════

const BTC_YES_TOKENS = [
  {
    label:   'BTC hits $1M',
    tokenId: '105267568073659068217311993901927962476298440625043565106676088842803600775810',
    weight:  1.0,
  },
];

const _priceHistory  = new Map();
const HISTORY_MAX_AGE_MS = 4 * 60 * 60 * 1000;

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
          weight:  Math.min(2, parseFloat(m.volume) / 1_000_000),
        });
      }
    }
  } catch {
    // Non-fatal — use seeded tokens
  }
}

async function getBTCSignal({ lookbackCandles = 3, minChange = 0.003 } = {}) {
  const results = [];

  for (const token of BTC_YES_TOKENS) {
    const candles = await _get15mHistory(token.tokenId, 2);
    if (candles.length < 2) {
      const now  = await _getTokenMidPrice(token.tokenId);
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

    const recent = candles.slice(-Math.max(lookbackCandles, 2));
    const oldest = recent[0].price;
    const latest = recent[recent.length - 1].price;
    const change = latest - oldest;

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

  const rawConf  = Math.min(100, Math.abs(weightedDelta) / 0.02 * 100);
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

// Kick off refreshes (non-blocking)
refreshBTCMarkets().catch(() => {});
getBTC15mMarket().catch(() => {}); // warm the cache at startup

module.exports = {
  getBTCSignal,
  getBTCUpDownSignal,
  getBTC15mMarket,
  getSwarmSeed,
  refreshBTCMarkets,
  BTC_YES_TOKENS,
};
