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
const MARKET_REFRESH_MS = 12 * 60 * 1000; // refresh every 12 min (market resolves every 15m)

// Rolling price history for the Up token  { ts_ms, price }[]
const _upTokenHistory = [];
const UP_HISTORY_MAX  = 30; // keep last 30 readings

/**
 * Find the current active "BTC Up or Down 15m" Polymarket market.
 * Returns { upTokenId, downTokenId, question, slug } or null.
 * Tries 4 progressively broader strategies so it always finds the market.
 */
async function getBTC15mMarket() {
  const nowMs = Date.now();
  if (_btc15mMarket && nowMs - _btc15mMarket.fetchedAt < MARKET_REFRESH_MS) {
    return _btc15mMarket;
  }

  // Helper: check if a market/event is the BTC Up or Down 15m market
  const isTarget = (slug = '', question = '') => {
    const s = slug.toLowerCase();
    const q = question.toLowerCase();
    return (
      (s.includes('btc-updown') || s.includes('btc-up-or-down') || s.includes('updown-15')) ||
      (q.includes('up or down') && (q.includes('btc') || q.includes('bitcoin')) && q.includes('15'))
    );
  };

  // Strategy 1: events — bitcoin tag
  // Strategy 2: events — crypto tag
  // Strategy 3: events — no tag filter (broader)
  // Strategy 4: markets — broad search
  const eventUrls = [
    `${GAMMA_API}/events?active=true&closed=false&limit=50&tag_slug=bitcoin`,
    `${GAMMA_API}/events?active=true&closed=false&limit=50&tag_slug=crypto`,
    `${GAMMA_API}/events?active=true&closed=false&limit=100`,
  ];

  for (const url of eventUrls) {
    try {
      const events = await _fetchJson(url);
      const evList = Array.isArray(events) ? events : (events?.data || events?.events || []);
      for (const ev of evList) {
        if (!isTarget(ev.slug, ev.title || ev.question || '')) continue;

        // Nested markets
        for (const mkt of (ev.markets || [])) {
          const found = _extractUpDown(mkt, ev.slug, ev.title || ev.question);
          if (found) {
            _btc15mMarket = { ...found, fetchedAt: nowMs };
            console.log(`[poly-btc-signal] Found 15m market via events: "${found.question}"`);
            return _btc15mMarket;
          }
        }
        // Event-level tokens
        const found = _extractUpDown(ev, ev.slug, ev.title || ev.question);
        if (found) {
          _btc15mMarket = { ...found, fetchedAt: nowMs };
          console.log(`[poly-btc-signal] Found 15m market (event-level): "${found.question}"`);
          return _btc15mMarket;
        }
      }
    } catch (_) {}
  }

  // Strategy 4: markets endpoint — broader
  for (const url of [
    `${GAMMA_API}/markets?active=true&closed=false&limit=200&tag_slug=bitcoin`,
    `${GAMMA_API}/markets?active=true&closed=false&limit=200&tag_slug=crypto`,
  ]) {
    try {
      const markets = await _fetchJson(url);
      const list = Array.isArray(markets) ? markets : (markets?.data || markets?.markets || []);
      for (const m of list) {
        if (!isTarget(m.slug, m.question || '')) continue;
        const found = _extractUpDown(m, m.slug, m.question);
        if (found) {
          _btc15mMarket = { ...found, fetchedAt: nowMs };
          console.log(`[poly-btc-signal] Found 15m market via markets: "${found.question}"`);
          return _btc15mMarket;
        }
      }
    } catch (_) {}
  }

  console.warn('[poly-btc-signal] BTC Up or Down 15m market not found — will retry next cycle');
  return null;
}

function _extractUpDown(obj, slug, question) {
  const tokens = obj.tokens || obj.clobTokenIds || [];
  if (!tokens.length) return null;

  // tokens can be objects { outcome, token_id } or raw strings
  let upTokenId   = null;
  let downTokenId = null;

  for (const t of tokens) {
    const outcome = (t.outcome || t.name || '').toLowerCase();
    const id      = t.token_id || t.id || t.tokenId || (typeof t === 'string' ? t : null);
    if (!id) continue;
    if (outcome === 'up'   || outcome === 'yes') upTokenId   = id;
    if (outcome === 'down' || outcome === 'no')  downTokenId = id;
  }

  // Some markets only have 2 tokens without named outcomes — assign by index
  if (!upTokenId && !downTokenId && tokens.length === 2) {
    upTokenId   = tokens[0]?.token_id || tokens[0]?.id || tokens[0];
    downTokenId = tokens[1]?.token_id || tokens[1]?.id || tokens[1];
  }

  if (!upTokenId || !downTokenId) return null;
  return { upTokenId, downTokenId, slug: slug || '', question: question || '' };
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
 * Two independent signal layers — whichever is stronger wins:
 *
 * A) Extremity signal (fires immediately, no history needed):
 *    If the Up-token price is extreme (crowd is very one-sided),
 *    bet with the crowd. Up < 0.35 → SHORT (crowd says down),
 *    Up > 0.65 → LONG (crowd says up).
 *
 * B) Momentum signal (requires ≥2 readings in rolling history):
 *    If Up-token price is rising → LONG, falling → SHORT.
 *
 * Returns the stronger signal; falls back to NEUTRAL if both weak.
 */
async function getBTCUpDownSignal({ lookbackReadings = 3, minChange = 0.003 } = {}) {
  const NEUTRAL = (market = '', upTokenId = '', downTokenId = '') => ({
    direction: 'NEUTRAL', confidence: 0, upPrice: 0.5, downPrice: 0.5,
    change: 0, market, upTokenId, downTokenId,
  });

  const mkt = await getBTC15mMarket();
  if (!mkt) return NEUTRAL();

  // Get live mid-price for Up token
  const upPrice = await _getTokenMidPrice(mkt.upTokenId);
  if (!upPrice || upPrice <= 0 || upPrice >= 1) return NEUTRAL(mkt.question, mkt.upTokenId, mkt.downTokenId);

  const downPrice = 1 - upPrice;

  // Store in rolling history (keyed by market slug to avoid mixing markets)
  _upTokenHistory.push({ ts_ms: Date.now(), price: upPrice, slug: mkt.slug });
  if (_upTokenHistory.length > UP_HISTORY_MAX) _upTokenHistory.shift();

  // ── Layer A: Extremity signal (immediate — no history needed) ──
  // When crowd is ≥65% one-sided, bet with the crowd.
  const EXTREME_THRESHOLD = 0.35; // fire if Up < 35% or Down < 35%
  let extDirection  = 'NEUTRAL';
  let extConfidence = 0;

  if (upPrice < EXTREME_THRESHOLD) {
    extDirection  = 'SHORT'; // crowd strongly expects DOWN
    extConfidence = Math.round((EXTREME_THRESHOLD - upPrice) / EXTREME_THRESHOLD * 100);
  } else if (upPrice > (1 - EXTREME_THRESHOLD)) {
    extDirection  = 'LONG';  // crowd strongly expects UP
    extConfidence = Math.round((upPrice - (1 - EXTREME_THRESHOLD)) / EXTREME_THRESHOLD * 100);
  }

  // ── Layer B: Momentum signal (slope over last N readings) ──
  // Only use readings from the current market slug to avoid stale data
  const sameMarket = _upTokenHistory.filter(h => h.slug === mkt.slug);
  let momDirection  = 'NEUTRAL';
  let momConfidence = 0;
  let change        = 0;

  if (sameMarket.length >= 2) {
    const window = sameMarket.slice(-Math.max(lookbackReadings, 2));
    const oldest = window[0].price;
    const latest = window[window.length - 1].price;
    change = latest - oldest;
    // Confidence: 0.02 prob change = 100%
    momConfidence = Math.min(100, Math.round(Math.abs(change) / 0.02 * 100));
    if (change >  minChange) momDirection = 'LONG';
    if (change < -minChange) momDirection = 'SHORT';
  }

  // ── Pick the stronger signal ──
  let direction  = 'NEUTRAL';
  let confidence = 0;

  if (extConfidence >= momConfidence && extDirection !== 'NEUTRAL') {
    direction  = extDirection;
    confidence = extConfidence;
  } else if (momDirection !== 'NEUTRAL') {
    direction  = momDirection;
    confidence = momConfidence;
  }

  return {
    direction,
    confidence,
    upPrice,
    downPrice,
    change,
    market:      mkt.question,
    upTokenId:   mkt.upTokenId,
    downTokenId: mkt.downTokenId,
  };
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
