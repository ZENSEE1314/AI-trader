// ============================================================
// Market Sentiment Scraper
// Sources: CoinGecko trending, CryptoPanic, Binance announcements
// No API keys required — uses public endpoints + scraping
// ============================================================

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const REQUEST_TIMEOUT = 15000;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ── Cache ────────────────────────────────────────────────────

let sentimentCache = { data: null, ts: 0 };

// ── Keyword Dictionaries ─────────────────────────────────────

const BULLISH_WORDS = [
  'bull', 'bullish', 'pump', 'moon', 'rally', 'surge', 'breakout',
  'ath', 'all-time high', 'buy', 'long', 'accumulate', 'green',
  'parabolic', 'skyrocket', 'explode', 'massive gains', 'outperform',
  'upgrade', 'adoption', 'partnership', 'launch', 'listing',
];

const BEARISH_WORDS = [
  'bear', 'bearish', 'dump', 'crash', 'drop', 'plunge', 'sell',
  'short', 'liquidat', 'red', 'correction', 'collapse', 'scam',
  'hack', 'exploit', 'delist', 'ban', 'regulate', 'fine', 'sue',
  'fraud', 'rug', 'rugpull', 'ponzi', 'warning',
];

// ── Fetch Helpers ────────────────────────────────────────────

async function safeFetch(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...opts.headers,
      },
    });
    clearTimeout(timer);
    return res;
  } catch (_) {
    return null;
  }
}

// ── Source 1: CoinGecko Trending ─────────────────────────────

async function fetchCoinGeckoTrending() {
  const results = {};
  try {
    const res = await safeFetch('https://api.coingecko.com/api/v3/search/trending');
    if (!res || !res.ok) return results;
    const data = await res.json();

    for (const { item } of (data.coins || [])) {
      const symbol = (item.symbol || '').toUpperCase() + 'USDT';
      results[symbol] = {
        trendScore: Math.min(1, (item.score || 0) / 10 + 0.5),
        source: 'coingecko_trending',
        rank: item.market_cap_rank || 999,
      };
    }
  } catch (_) {}
  return results;
}

// ── Source 2: CryptoPanic News Feed ──────────────────────────

async function fetchCryptoPanicNews() {
  const results = {};
  try {
    // CryptoPanic free RSS-like public endpoint
    const res = await safeFetch('https://cryptopanic.com/news/rss/');
    if (!res || !res.ok) return results;
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    const items = [];
    $('item').each((_, el) => {
      const title = $(el).find('title').text().toLowerCase();
      const pubDate = new Date($(el).find('pubDate').text());
      items.push({ title, pubDate });
    });

    // Extract coin mentions and sentiment from headlines
    const now = Date.now();
    for (const item of items) {
      const ageHours = (now - item.pubDate.getTime()) / (1000 * 60 * 60);
      const recencyWeight = ageHours < 4 ? 2.0 : ageHours < 12 ? 1.0 : 0.5;

      // Count bullish/bearish words
      let bullCount = 0;
      let bearCount = 0;
      for (const w of BULLISH_WORDS) {
        if (item.title.includes(w)) bullCount++;
      }
      for (const w of BEARISH_WORDS) {
        if (item.title.includes(w)) bearCount++;
      }

      // Try to extract coin symbols from title
      const symbolMatches = item.title.match(/\b[A-Z]{2,6}\b/gi) || [];
      for (const sym of symbolMatches) {
        const key = sym.toUpperCase() + 'USDT';
        if (!results[key]) {
          results[key] = { newsCount: 0, bullish: 0, bearish: 0, recencySum: 0 };
        }
        results[key].newsCount++;
        results[key].bullish += bullCount * recencyWeight;
        results[key].bearish += bearCount * recencyWeight;
        results[key].recencySum += recencyWeight;
      }
    }
  } catch (_) {}
  return results;
}

// ── Source 3: Binance Futures Gainers/Losers (momentum) ──────

async function fetchBinanceMomentum() {
  const results = {};
  try {
    const res = await safeFetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
    if (!res || !res.ok) return results;
    const tickers = await res.json();

    // Top gainers and losers = high interest coins
    const sorted = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .map(t => ({
        symbol: t.symbol,
        chg: parseFloat(t.priceChangePercent),
        vol: parseFloat(t.quoteVolume),
      }))
      .filter(t => t.vol > 50e6);

    sorted.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));

    for (const t of sorted.slice(0, 20)) {
      results[t.symbol] = {
        momentum: t.chg / 100,
        volume: t.vol,
        isTrending: Math.abs(t.chg) > 5,
      };
    }
  } catch (_) {}
  return results;
}

// ── Source 4: X/Twitter Crypto Sentiment (public scraping) ───

async function fetchXSentiment() {
  const results = {};
  try {
    // Use nitter instances for public access to crypto-related posts
    const nitterInstances = [
      'https://nitter.privacydev.net',
      'https://nitter.poast.org',
    ];

    for (const instance of nitterInstances) {
      try {
        const res = await safeFetch(`${instance}/search?q=%23crypto+%23trading&f=tweets`, {
          headers: { Accept: 'text/html' },
        });
        if (!res || !res.ok) continue;
        const html = await res.text();
        const $ = cheerio.load(html);

        const tweets = [];
        $('.timeline-item .tweet-content').each((_, el) => {
          tweets.push($(el).text().toLowerCase());
        });

        // Analyze tweets for coin mentions and sentiment
        for (const tweet of tweets) {
          // Look for $SYMBOL cashtags
          const cashtags = tweet.match(/\$[a-z]{2,6}/gi) || [];
          // Look for common coin names
          const coinMentions = tweet.match(/\b(btc|eth|sol|xrp|ada|doge|bnb|avax|dot|link|matic|arb|op|sui|apt|sei|inj|tia|jup|wif|pepe|bonk|floki)\b/gi) || [];

          const allMentions = [...new Set([
            ...cashtags.map(c => c.replace('$', '').toUpperCase() + 'USDT'),
            ...coinMentions.map(c => c.toUpperCase() + 'USDT'),
          ])];

          let bullScore = 0;
          let bearScore = 0;
          for (const w of BULLISH_WORDS) { if (tweet.includes(w)) bullScore++; }
          for (const w of BEARISH_WORDS) { if (tweet.includes(w)) bearScore++; }

          for (const sym of allMentions) {
            if (!results[sym]) results[sym] = { mentions: 0, bullish: 0, bearish: 0 };
            results[sym].mentions++;
            results[sym].bullish += bullScore;
            results[sym].bearish += bearScore;
          }
        }

        break; // success — don't try other instances
      } catch (_) {
        continue;
      }
    }
  } catch (_) {}
  return results;
}

// ── Combine All Sources into Final Scores ────────────────────

function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const w of BULLISH_WORDS) { if (lower.includes(w)) bull++; }
  for (const w of BEARISH_WORDS) { if (lower.includes(w)) bear++; }
  const total = bull + bear;
  if (total === 0) return 'neutral';
  return bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
}

async function getSentimentScores() {
  // Return cache if fresh
  if (sentimentCache.data && Date.now() - sentimentCache.ts < CACHE_TTL) {
    return sentimentCache.data;
  }

  const [trending, news, momentum, xSentiment] = await Promise.all([
    fetchCoinGeckoTrending(),
    fetchCryptoPanicNews(),
    fetchBinanceMomentum(),
    fetchXSentiment(),
  ]);

  const combined = {};

  // Merge trending data
  for (const [sym, data] of Object.entries(trending)) {
    if (!combined[sym]) combined[sym] = createEmptyScore();
    combined[sym].trendScore += data.trendScore * 0.3;
    combined[sym].sources.push('coingecko');
  }

  // Merge news data
  for (const [sym, data] of Object.entries(news)) {
    if (!combined[sym]) combined[sym] = createEmptyScore();
    combined[sym].newsCount += data.newsCount;
    if (data.bullish > data.bearish) {
      combined[sym].trendScore += 0.2;
      combined[sym].sentiment = 'bullish';
    } else if (data.bearish > data.bullish) {
      combined[sym].trendScore -= 0.2;
      combined[sym].sentiment = 'bearish';
    }
    combined[sym].sources.push('cryptopanic');
  }

  // Merge momentum data
  for (const [sym, data] of Object.entries(momentum)) {
    if (!combined[sym]) combined[sym] = createEmptyScore();
    combined[sym].momentum = data.momentum;
    if (data.isTrending) combined[sym].trendScore += 0.15;
    combined[sym].volume24h = data.volume;
    combined[sym].sources.push('binance');
  }

  // Merge X/Twitter data
  for (const [sym, data] of Object.entries(xSentiment)) {
    if (!combined[sym]) combined[sym] = createEmptyScore();
    combined[sym].mentions += data.mentions;
    combined[sym].trendScore += Math.min(data.mentions * 0.05, 0.3);
    if (data.bullish > data.bearish) {
      combined[sym].sentiment = combined[sym].sentiment === 'bearish' ? 'neutral' : 'bullish';
    } else if (data.bearish > data.bullish) {
      combined[sym].sentiment = combined[sym].sentiment === 'bullish' ? 'neutral' : 'bearish';
    }
    combined[sym].sources.push('x_twitter');
  }

  // Normalize trend scores to [0, 1]
  for (const sym of Object.keys(combined)) {
    combined[sym].trendScore = Math.max(0, Math.min(1, combined[sym].trendScore));
  }

  sentimentCache = { data: combined, ts: Date.now() };
  return combined;
}

function createEmptyScore() {
  return {
    trendScore: 0,
    newsCount: 0,
    sentiment: 'neutral',
    mentions: 0,
    momentum: 0,
    volume24h: 0,
    sources: [],
  };
}

// ── Score Modifier for Trading ───────────────────────────────

function getSentimentModifier(symbol, direction) {
  if (!sentimentCache.data || !sentimentCache.data[symbol]) return 0;
  const s = sentimentCache.data[symbol];

  let modifier = 0;

  // Trend score adds to base score
  modifier += s.trendScore * 5; // max +5 points from trending

  // Sentiment alignment bonus/penalty
  if (direction === 'LONG' && s.sentiment === 'bullish') modifier += 3;
  if (direction === 'LONG' && s.sentiment === 'bearish') modifier -= 3;
  if (direction === 'SHORT' && s.sentiment === 'bearish') modifier += 3;
  if (direction === 'SHORT' && s.sentiment === 'bullish') modifier -= 3;

  // High mention count = more attention = more volatility opportunity
  if (s.mentions > 10) modifier += 2;
  if (s.mentions > 25) modifier += 2;

  // Multiple sources confirm trend
  if (s.sources.length >= 3) modifier += 2;

  return modifier;
}

// ── Telegram-friendly Summary ────────────────────────────────

async function getSentimentSummary() {
  const scores = await getSentimentScores();
  const entries = Object.entries(scores)
    .filter(([, v]) => v.trendScore > 0.2 || v.newsCount > 0 || v.mentions > 3)
    .sort((a, b) => b[1].trendScore - a[1].trendScore)
    .slice(0, 10);

  if (!entries.length) return 'No significant trends detected.';

  const lines = entries.map(([sym, data]) => {
    const icon = data.sentiment === 'bullish' ? '🟢' : data.sentiment === 'bearish' ? '🔴' : '⚪';
    const trend = (data.trendScore * 100).toFixed(0);
    const src = data.sources.join(', ');
    return `${icon} *${sym.replace('USDT', '')}* — trend: ${trend}% | ${data.sentiment} | mentions: ${data.mentions} | [${src}]`;
  });

  return `*Market Sentiment*\n\n${lines.join('\n')}`;
}

module.exports = {
  getSentimentScores,
  getSentimentModifier,
  getSentimentSummary,
  analyzeSentiment,
};
