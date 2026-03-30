// ============================================================
// Multi-Timeframe LH/HL Trading Engine
// Strategy: 3-timeframe confluence (15m, 3m, 1m)
//   - SHORT: All 3 TFs show Lower Highs (LH)
//   - LONG:  All 3 TFs show Higher Lows (HL)
//   - SL: 1m most recent swing candle high/low + 0.1%
//   - TP: Risk-Reward 1:1.5
//   - Universe: Top 200 market cap tokens only
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');

const REQUEST_TIMEOUT = 15000;
const TOP_N_COINS = 200;

// ── Fetch Helpers ────────────────────────────────────────────

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (res.ok) return res;
    } catch (_) {}
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

async function fetchKlines(symbol, interval, limit = 100) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;
  return res.json();
}

async function fetchTickers() {
  const res = await fetchWithRetry('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (!res) return [];
  return res.json();
}

// ── Swing Detection ──────────────────────────────────────────
// A swing high: candle whose high is higher than both neighbors
// A swing low:  candle whose low is lower than both neighbors
// Returns the 2 most recent swings of each type

function findSwingHighs(klines) {
  const swings = [];
  for (let i = 1; i < klines.length - 1; i++) {
    const high = parseFloat(klines[i][2]);
    const prevHigh = parseFloat(klines[i - 1][2]);
    const nextHigh = parseFloat(klines[i + 1][2]);
    if (high > prevHigh && high > nextHigh) {
      swings.push({ index: i, price: high, candle: klines[i] });
    }
  }
  return swings.slice(-2);
}

function findSwingLows(klines) {
  const swings = [];
  for (let i = 1; i < klines.length - 1; i++) {
    const low = parseFloat(klines[i][3]);
    const prevLow = parseFloat(klines[i - 1][3]);
    const nextLow = parseFloat(klines[i + 1][3]);
    if (low < prevLow && low < nextLow) {
      swings.push({ index: i, price: low, candle: klines[i] });
    }
  }
  return swings.slice(-2);
}

// ── LH / HL Detection ───────────────────────────────────────
// LH (Lower High): most recent swing high < previous swing high
// HL (Higher Low): most recent swing low > previous swing low

function hasLowerHigh(klines) {
  const swingHighs = findSwingHighs(klines);
  if (swingHighs.length < 2) return null;
  const prev = swingHighs[0];
  const recent = swingHighs[1];
  if (recent.price < prev.price) {
    return { isLH: true, recentSwing: recent, prevSwing: prev };
  }
  return null;
}

function hasHigherLow(klines) {
  const swingLows = findSwingLows(klines);
  if (swingLows.length < 2) return null;
  const prev = swingLows[0];
  const recent = swingLows[1];
  if (recent.price > prev.price) {
    return { isHL: true, recentSwing: recent, prevSwing: prev };
  }
  return null;
}

// ── Daily Limits ─────────────────────────────────────────────

const dailyStats = { date: '', trades: 0, consecutiveLosses: 0 };
const MAX_DAILY_TRADES = 5;
const MAX_CONSECUTIVE_LOSSES = 3;

function recordDailyTrade(isWin) {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyStats.date !== today) {
    dailyStats.date = today;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }
  dailyStats.trades++;
  if (isWin) {
    dailyStats.consecutiveLosses = 0;
  } else {
    dailyStats.consecutiveLosses++;
  }
}

function checkDailyLimits() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyStats.date !== today) return { canTrade: true };
  if (dailyStats.trades >= MAX_DAILY_TRADES) return { canTrade: false, reason: `Daily limit reached (${MAX_DAILY_TRADES})` };
  if (dailyStats.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) return { canTrade: false, reason: `${MAX_CONSECUTIVE_LOSSES} consecutive losses` };
  return { canTrade: true };
}

function isGoodTradingSession() {
  const utcH = new Date().getUTCHours();
  return !(utcH >= 4 && utcH <= 5);
}

// ── Analyze Single Coin ──────────────────────────────────────

async function analyzeLHHL(ticker, params) {
  const symbol = ticker.symbol;
  const price = parseFloat(ticker.lastPrice);

  // AI-tuned parameters (defaults: buffer=0.1%, RR=1.5, maxSL=2%, minSL=0.1%)
  const slBufferPct = params.SL_BUFFER_PCT || 0.001;
  const rrRatio = params.RR_RATIO || 1.5;
  const slMaxPct = params.SL_MAX_PCT || 0.02;
  const slMinPct = params.SL_MIN_PCT || 0.001;
  const dirBias = params.DIRECTION_BIAS || null;

  // Fetch 3 timeframes: 15m, 3m, 1m
  const [klines15m, klines3m, klines1m] = await Promise.all([
    fetchKlines(symbol, '15m', 50),
    fetchKlines(symbol, '3m', 50),
    fetchKlines(symbol, '1m', 50),
  ]);

  if (!klines15m || !klines3m || !klines1m) return null;
  if (klines15m.length < 10 || klines3m.length < 10 || klines1m.length < 10) return null;

  // Check for SHORT: all 3 TFs must show Lower High
  const lh15 = hasLowerHigh(klines15m);
  const lh3 = hasLowerHigh(klines3m);
  const lh1 = hasLowerHigh(klines1m);

  // Check for LONG: all 3 TFs must show Higher Low
  const hl15 = hasHigherLow(klines15m);
  const hl3 = hasHigherLow(klines3m);
  const hl1 = hasHigherLow(klines1m);

  let isShortSetup = lh15 && lh3 && lh1;
  let isLongSetup = hl15 && hl3 && hl1;

  // AI direction bias: skip the losing direction if learned
  if (dirBias === 'LONG') isShortSetup = false;
  if (dirBias === 'SHORT') isLongSetup = false;

  if (!isShortSetup && !isLongSetup) return null;

  // If both signals exist (rare), pick the one where 1m swing is more recent
  let direction, sl, swingCandle1m;

  if (isShortSetup && isLongSetup) {
    if (lh1.recentSwing.index > hl1.recentSwing.index) {
      direction = 'SHORT';
    } else {
      direction = 'LONG';
    }
  } else if (isShortSetup) {
    direction = 'SHORT';
  } else {
    direction = 'LONG';
  }

  if (direction === 'SHORT') {
    // SL = 1m most recent LH candle's highest price + buffer%
    swingCandle1m = lh1.recentSwing;
    const swingHigh = parseFloat(swingCandle1m.candle[2]);
    sl = swingHigh * (1 + slBufferPct);
  } else {
    // SL = 1m most recent HL candle's lowest price - buffer%
    swingCandle1m = hl1.recentSwing;
    const swingLow = parseFloat(swingCandle1m.candle[3]);
    sl = swingLow * (1 - slBufferPct);
  }

  const slDist = Math.abs(price - sl);
  const slPct = slDist / price;

  // Skip if SL outside AI-tuned range
  if (slPct > slMaxPct) return null;
  if (slPct < slMinPct) return null;

  // TP = SL distance * AI-tuned RR ratio
  const tpDist = slDist * rrRatio;
  const tp = direction === 'SHORT'
    ? price - tpDist
    : price + tpDist;

  // Confidence score: base 10 for 3-TF confluence
  let score = 10;

  // Bonus: how clean are the swings (bigger difference = stronger trend)
  if (direction === 'SHORT') {
    const lhDiff15 = (lh15.prevSwing.price - lh15.recentSwing.price) / lh15.prevSwing.price;
    const lhDiff3 = (lh3.prevSwing.price - lh3.recentSwing.price) / lh3.prevSwing.price;
    if (lhDiff15 > 0.005) score += 2;
    if (lhDiff3 > 0.003) score += 1;
  } else {
    const hlDiff15 = (hl15.recentSwing.price - hl15.prevSwing.price) / hl15.prevSwing.price;
    const hlDiff3 = (hl3.recentSwing.price - hl3.prevSwing.price) / hl3.prevSwing.price;
    if (hlDiff15 > 0.005) score += 2;
    if (hlDiff3 > 0.003) score += 1;
  }

  // AI modifier
  const setup = direction === 'SHORT' ? 'LH_3TF' : 'HL_3TF';
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, setup, direction);
  score = score * aiModifier;

  return {
    symbol,
    direction,
    price,
    lastPrice: price,
    sl,
    tp1: tp,
    tp2: direction === 'SHORT' ? price - tpDist * 1.3 : price + tpDist * 1.3,
    tp3: direction === 'SHORT' ? price - tpDist * 1.6 : price + tpDist * 1.6,
    slDist: slPct,
    score: Math.round(score * 10) / 10,
    setup,
    setupName: `${direction === 'SHORT' ? 'LH' : 'HL'}-3TF`,
    aiModifier: Math.round(aiModifier * 100) / 100,
    premiumDiscount: direction === 'SHORT' ? 'premium' : 'discount',
    rsi: null,
    sentimentMod: 0,
    sentiment: 'neutral',
    swingInfo: {
      tf15: direction === 'SHORT' ? lh15 : hl15,
      tf3: direction === 'SHORT' ? lh3 : hl3,
      tf1: direction === 'SHORT' ? lh1 : hl1,
    },
  };
}

// ── Main Scan ────────────────────────────────────────────────

async function scanSMC(log) {
  const limits = checkDailyLimits();
  if (!limits.canTrade) {
    log(`LH/HL: ${limits.reason}. Stopped trading.`);
    bLog.scan(limits.reason);
    return [];
  }

  if (!isGoodTradingSession()) {
    const sessionW = await aiLearner.getSessionWeight();
    if (sessionW < 1.2) {
      log('LH/HL: Dead zone (UTC 4-5). Low liquidity — skipping.');
      bLog.scan('Dead zone hours. Waiting for volume to return.');
      return [];
    }
    log(`LH/HL: Dead zone but AI session weight ${sessionW.toFixed(2)} is high — scanning anyway.`);
    bLog.ai(`AI override: session weight ${sessionW.toFixed(2)} > 1.2 — scanning in dead zone`);
  }

  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('Failed to fetch tickers from Binance'); return []; }

  // Blacklist: non-crypto TradFi perps + problematic tokens
  const BLACKLIST = new Set([
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ]);

  // Top 200 by market cap (approximated by 24h quote volume)
  const topCoins = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !BLACKLIST.has(t.symbol))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, TOP_N_COINS);

  // Get AI-optimized parameters
  const params = await aiLearner.getOptimalParams();
  const rrRatio = params.RR_RATIO || 1.5;
  const minScore = params.MIN_SCORE || 8;

  bLog.scan(`LH/HL scan: ${topCoins.length} coins | AI params: RR=1:${rrRatio} SL_BUF=${(params.SL_BUFFER_PCT*100).toFixed(2)}% SL_MAX=${(params.SL_MAX_PCT*100).toFixed(1)}% SIZE=${(params.WALLET_SIZE_PCT*100).toFixed(0)}%`);
  if (params.DIRECTION_BIAS) bLog.ai(`AI direction bias: prefer ${params.DIRECTION_BIAS} (other direction losing)`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      bLog.ai(`Skipping ${ticker.symbol} — AI learned poor win rate`);
      continue;
    }

    const signal = await analyzeLHHL(ticker, params);
    analyzed++;

    if (signal && signal.score >= minScore) {
      results.push(signal);
      bLog.scan(
        `SIGNAL: ${signal.symbol} ${signal.direction} | score=${signal.score} setup=${signal.setupName}` +
        ` | SL=$${signal.sl.toFixed(6)} TP=$${signal.tp1.toFixed(6)} RR=1:${rrRatio}`
      );
    }

    // Rate limit: 200ms between API calls per coin
    await new Promise(r => setTimeout(r, 200));
  }

  if (skippedAI > 0) bLog.ai(`AI avoided ${skippedAI} coins based on past performance`);
  bLog.scan(`Scan complete: ${analyzed} analyzed, ${results.length} signals found`);

  if (!results.length) {
    bLog.scan('No 3-TF LH/HL confluence found this cycle.');
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3);
}

module.exports = {
  scanSMC,
  analyzeLHHL,
  recordDailyTrade,
  checkDailyLimits,
  isGoodTradingSession,
};
