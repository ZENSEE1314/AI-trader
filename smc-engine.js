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

// ── Zeiierman-Style SMC Swing Detection ──────────────────────
// Based on LuxAlgo / Zeiierman Smart Money Concepts methodology:
//   1. Centered rolling window pivot detection (not just neighbors)
//   2. Alternating swings enforced (high-low-high-low, never two highs in a row)
//   3. Full structure labels: HH, HL, LH, LL
//   4. Trend state tracked per timeframe
//
// Swing length per TF (Zeiierman uses adaptive lengths):
//   15m → len=10 (covers ~2.5 hours of structure)
//   3m  → len=8  (covers ~24 min of structure)
//   1m  → len=5  (covers ~5 min of structure)

const SWING_LENGTHS = { '15m': 10, '3m': 8, '1m': 5 };

// ── Pivot Detection (LuxAlgo swings() method) ───────────────
// A bar at index [len] is a swing high if its high > highest of surrounding bars
// A bar at index [len] is a swing low if its low < lowest of surrounding bars
// Uses oscillator state to enforce alternation (H→L→H→L)

function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));

  const swings = []; // { type: 'high'|'low', index, price, candle }
  let lastType = null; // enforce alternation

  for (let i = len; i < klines.length - len; i++) {
    // Check if bar i is the highest high in window [i-len, i+len]
    let isHigh = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) { isHigh = false; break; }
    }

    // Check if bar i is the lowest low in window [i-len, i+len]
    let isLow = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (lows[i] >= lows[i + j]) { isLow = false; break; }
    }

    // Both high and low on same bar — pick the more extreme one
    if (isHigh && isLow) {
      // Rare: compare relative distances to decide
      const highDist = highs[i] - Math.max(highs[i - 1], highs[i + 1]);
      const lowDist = Math.min(lows[i - 1], lows[i + 1]) - lows[i];
      if (highDist > lowDist) isLow = false;
      else isHigh = false;
    }

    if (isHigh) {
      if (lastType === 'high') {
        // Two consecutive swing highs: keep the HIGHER one (Zeiierman rule)
        const prev = swings[swings.length - 1];
        if (highs[i] > prev.price) {
          swings[swings.length - 1] = { type: 'high', index: i, price: highs[i], candle: klines[i] };
        }
      } else {
        swings.push({ type: 'high', index: i, price: highs[i], candle: klines[i] });
        lastType = 'high';
      }
    }

    if (isLow) {
      if (lastType === 'low') {
        // Two consecutive swing lows: keep the LOWER one
        const prev = swings[swings.length - 1];
        if (lows[i] < prev.price) {
          swings[swings.length - 1] = { type: 'low', index: i, price: lows[i], candle: klines[i] };
        }
      } else {
        swings.push({ type: 'low', index: i, price: lows[i], candle: klines[i] });
        lastType = 'low';
      }
    }
  }

  return swings;
}

// ── Market Structure Labels (HH, HL, LH, LL) ────────────────
// Compare consecutive swing highs and consecutive swing lows:
//   New swing high > prev swing high → HH (bullish)
//   New swing high < prev swing high → LH (bearish)
//   New swing low > prev swing low → HL (bullish)
//   New swing low < prev swing low → LL (bearish)

function getStructure(klines, len) {
  const swings = detectSwings(klines, len);

  // Separate into highs and lows (in order)
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');

  // Label each swing high
  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const label = swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH';
    highLabels.push({ ...swingHighs[i], label });
  }

  // Label each swing low
  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    const label = swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL';
    lowLabels.push({ ...swingLows[i], label });
  }

  // Get the most recent high label and low label
  const lastHigh = highLabels.length ? highLabels[highLabels.length - 1] : null;
  const lastLow = lowLabels.length ? lowLabels[lowLabels.length - 1] : null;

  // Determine trend: bearish = LH+LL, bullish = HH+HL
  let trend = 'neutral';
  if (lastHigh && lastLow) {
    const isBearish = lastHigh.label === 'LH' && lastLow.label === 'LL';
    const isBullish = lastHigh.label === 'HH' && lastLow.label === 'HL';
    // Partial signals: LH alone is bearish leaning, HL alone is bullish leaning
    if (isBearish) trend = 'bearish';
    else if (isBullish) trend = 'bullish';
    else if (lastHigh.label === 'LH') trend = 'bearish_lean';
    else if (lastLow.label === 'HL') trend = 'bullish_lean';
  } else if (lastHigh) {
    trend = lastHigh.label === 'LH' ? 'bearish_lean' : 'bullish_lean';
  } else if (lastLow) {
    trend = lastLow.label === 'HL' ? 'bullish_lean' : 'bearish_lean';
  }

  return {
    swings,
    swingHighs,
    swingLows,
    highLabels,
    lowLabels,
    lastHigh,
    lastLow,
    trend,
    // Quick access for the user's LH/HL check
    hasLH: lastHigh?.label === 'LH',
    hasHL: lastLow?.label === 'HL',
    hasHH: lastHigh?.label === 'HH',
    hasLL: lastLow?.label === 'LL',
    // Summary label for logging
    label: `${lastHigh?.label || '--'}/${lastLow?.label || '--'}`,
  };
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

  // AI-tuned parameters
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
  if (klines15m.length < 20 || klines3m.length < 20 || klines1m.length < 15) return null;

  // Get full market structure per timeframe (Zeiierman method)
  const struct15 = getStructure(klines15m, SWING_LENGTHS['15m']);
  const struct3 = getStructure(klines3m, SWING_LENGTHS['3m']);
  const struct1 = getStructure(klines1m, SWING_LENGTHS['1m']);

  // SHORT: all 3 TFs must have LH as the most recent swing high label
  // LONG: all 3 TFs must have HL as the most recent swing low label
  let isShortSetup = struct15.hasLH && struct3.hasLH && struct1.hasLH;
  let isLongSetup = struct15.hasHL && struct3.hasHL && struct1.hasHL;

  // AI direction bias — completely block the losing direction
  if (dirBias === 'LONG') {
    isShortSetup = false;
    if (isLongSetup) bLog.ai(`${symbol}: AI bias=LONG — blocking SHORT, allowing LONG`);
  }
  if (dirBias === 'SHORT') {
    isLongSetup = false;
    if (isShortSetup) bLog.ai(`${symbol}: AI bias=SHORT — blocking LONG, allowing SHORT`);
  }

  // Log structure for debugging
  const hasAnySignal = struct15.hasLH || struct15.hasHL || struct3.hasLH || struct3.hasHL || struct1.hasLH || struct1.hasHL;

  if (!isShortSetup && !isLongSetup) {
    if (hasAnySignal) {
      bLog.scan(`${symbol}: 15m=${struct15.label} 3m=${struct3.label} 1m=${struct1.label} — NO confluence`);
    }
    return null;
  }

  bLog.scan(`${symbol}: 15m=${struct15.label} 3m=${struct3.label} 1m=${struct1.label} — ✅ ALL AGREE`);

  let direction, sl;

  if (isShortSetup && isLongSetup) {
    // Both signals: pick based on which 1m swing is more recent
    const lastLH1m = struct1.lastHigh;
    const lastHL1m = struct1.lastLow;
    if (lastLH1m && lastHL1m) {
      direction = lastLH1m.index > lastHL1m.index ? 'SHORT' : 'LONG';
    } else {
      direction = isShortSetup ? 'SHORT' : 'LONG';
    }
  } else if (isShortSetup) {
    direction = 'SHORT';
  } else {
    direction = 'LONG';
  }

  if (direction === 'SHORT') {
    // SL = 1m most recent LH swing candle's highest price + buffer%
    const recentLH = struct1.lastHigh;
    if (!recentLH) return null;
    const swingHigh = recentLH.price;
    sl = swingHigh * (1 + slBufferPct);
  } else {
    // SL = 1m most recent HL swing candle's lowest price - buffer%
    const recentHL = struct1.lastLow;
    if (!recentHL) return null;
    const swingLow = recentHL.price;
    sl = swingLow * (1 - slBufferPct);
  }

  const slDist = Math.abs(price - sl);
  const slPct = slDist / price;

  if (slPct > slMaxPct || slPct < slMinPct) return null;

  // TP = SL distance * AI-tuned RR ratio
  const tpDist = slDist * rrRatio;
  const tp = direction === 'SHORT' ? price - tpDist : price + tpDist;

  // Confidence score
  let score = 10; // base: 3-TF confluence confirmed

  // Bonus: full bearish structure (LH + LL) or full bullish (HH + HL)
  if (direction === 'SHORT') {
    if (struct15.hasLL) score += 2; // 15m also making lower lows = strong downtrend
    if (struct3.hasLL) score += 1;
    if (struct1.hasLL) score += 1;
    // Bonus: trend confirmed on higher TF
    if (struct15.trend === 'bearish') score += 2;
  } else {
    if (struct15.hasHH) score += 2; // 15m also making higher highs = strong uptrend
    if (struct3.hasHH) score += 1;
    if (struct1.hasHH) score += 1;
    if (struct15.trend === 'bullish') score += 2;
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
    structure: {
      tf15: struct15.label,
      tf3: struct3.label,
      tf1: struct1.label,
      trend15: struct15.trend,
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
  detectSwings,
  SWING_LENGTHS,
};
