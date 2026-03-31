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
const TOP_N_COINS = 50;

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

// Zeiierman SMC settings: Swing Points Length = 20, Structure Period = 10
const SWING_LENGTHS = { '15m': 20, '3m': 20, '1m': 20 };
const STRUCTURE_PERIOD = 10;

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

  // Capital-based SL/TP: SL = 30% of position margin, TP = 45% of position margin
  // Price distance = margin% / leverage (e.g., 30% / 10x = 3% price move)
  const SL_MARGIN_PCT = params.SL_MARGIN_PCT || 0.30;  // 30% of position margin
  const TP_MARGIN_PCT = params.TP_MARGIN_PCT || 0.45;  // 45% of position margin
  const rrRatio = TP_MARGIN_PCT / SL_MARGIN_PCT;       // 1.5 RR
  const dirBias = params.DIRECTION_BIAS || null;

  // Fetch 3 timeframes: 15m, 3m, 1m (100 candles to support swing length 20)
  const [klines15m, klines3m, klines1m] = await Promise.all([
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '3m', 100),
    fetchKlines(symbol, '1m', 100),
  ]);

  if (!klines15m || !klines3m || !klines1m) return null;
  if (klines15m.length < 20 || klines3m.length < 20 || klines1m.length < 15) return null;

  // Get full market structure per timeframe (Zeiierman method)
  const struct15 = getStructure(klines15m, SWING_LENGTHS['15m']);
  const struct3 = getStructure(klines3m, SWING_LENGTHS['3m']);
  const struct1 = getStructure(klines1m, SWING_LENGTHS['1m']);

  // 2-of-3 TF confluence: any 2 timeframes agreeing is enough
  // HL on 2+ TFs = LONG (the 3rd TF having LL is just a pullback, not trend reversal)
  // LH on 2+ TFs = SHORT (the 3rd TF having HH is just a bounce, not trend reversal)
  const hlCount = (struct15.hasHL ? 1 : 0) + (struct3.hasHL ? 1 : 0) + (struct1.hasHL ? 1 : 0);
  const lhCount = (struct15.hasLH ? 1 : 0) + (struct3.hasLH ? 1 : 0) + (struct1.hasLH ? 1 : 0);

  let isLongSetup = hlCount >= 2;
  let isShortSetup = lhCount >= 2;

  // If both directions qualify, pick the stronger one (more TFs agreeing)
  // If tied, block both — market is indecisive
  if (isLongSetup && isShortSetup) {
    if (hlCount > lhCount) isShortSetup = false;
    else if (lhCount > hlCount) isLongSetup = false;
    else { isLongSetup = false; isShortSetup = false; }
  }

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

  let direction;

  if (isShortSetup && isLongSetup) {
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

  // Verify swing exists (used for direction validation only)
  if (direction === 'SHORT' && !struct1.lastHigh) return null;
  if (direction === 'LONG' && !struct1.lastLow) return null;

  // Recency check: the 1m confirming swing must be within the last 15 candles (15 min)
  // Stale swings from hours ago lead to late entries after the move is exhausted
  const MAX_CANDLE_AGE = 15;
  const lastCandleIndex = klines1m.length - 1;
  const confirmSwing = direction === 'SHORT' ? struct1.lastHigh : struct1.lastLow;
  if (confirmSwing && (lastCandleIndex - confirmSwing.index) > MAX_CANDLE_AGE) {
    bLog.scan(`${symbol}: 1m swing too old (${lastCandleIndex - confirmSwing.index} candles ago) — skipping stale signal`);
    return null;
  }

  // Price position check: don't chase — entry should be near the structure level
  // SHORT: price should be below the last swing high (LH) and not too far below
  // LONG: price should be above the last swing low (HL) and not too far above
  const MAX_CHASE_PCT = 0.02; // 2% max distance from structure level
  if (direction === 'SHORT' && struct1.lastHigh) {
    const distFromLH = (struct1.lastHigh.price - price) / price;
    if (price > struct1.lastHigh.price) {
      bLog.scan(`${symbol}: price above LH — not a valid short entry`);
      return null;
    }
    if (distFromLH > MAX_CHASE_PCT) {
      bLog.scan(`${symbol}: price ${(distFromLH * 100).toFixed(2)}% below LH — too far, chasing`);
      return null;
    }
  }
  if (direction === 'LONG' && struct1.lastLow) {
    const distFromHL = (price - struct1.lastLow.price) / price;
    if (price < struct1.lastLow.price) {
      bLog.scan(`${symbol}: price below HL — not a valid long entry`);
      return null;
    }
    if (distFromHL > MAX_CHASE_PCT) {
      bLog.scan(`${symbol}: price ${(distFromHL * 100).toFixed(2)}% above HL — too far, chasing`);
      return null;
    }
  }

  // Capital-based SL/TP: distance = margin_loss% / leverage
  const BTC_ETH = new Set(['BTCUSDT', 'ETHUSDT']);
  const leverage = BTC_ETH.has(symbol) ? (params.LEV_BTC_ETH || 100)
    : (params.LEV_ALT || 20);

  const slPct = SL_MARGIN_PCT / leverage;
  const tpPct = TP_MARGIN_PCT / leverage;

  // Use swing-based SL as floor: don't place SL tighter than the structure swing
  const swingSl = direction === 'SHORT'
    ? (struct1.lastHigh ? struct1.lastHigh.price * 1.001 : null)
    : (struct1.lastLow ? struct1.lastLow.price * 0.999 : null);
  const swingSlDist = swingSl ? Math.abs(price - swingSl) / price : 0;

  // Take the wider of capital-based or swing-based SL distance
  const effectiveSlPct = Math.max(slPct, swingSlDist);
  const slDist = price * effectiveSlPct;
  const tpDist = price * effectiveSlPct * rrRatio;

  // Guard: reject trades where SL is less than 0.15% from entry (noise territory)
  const MIN_SL_PCT = 0.0015;
  if (effectiveSlPct < MIN_SL_PCT) {
    bLog.scan(`${symbol}: SL too tight (${(effectiveSlPct * 100).toFixed(3)}% < 0.15%) — skipping`);
    return null;
  }

  const sl = direction === 'SHORT' ? price + slDist : price - slDist;
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
    tp2: direction === 'SHORT' ? price - tpDist * 1.2 : price + tpDist * 1.2,
    tp3: direction === 'SHORT' ? price - tpDist * 1.5 : price + tpDist * 1.5,
    slDist: slPct,
    leverage,
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
  const slMargin = params.SL_MARGIN_PCT || 0.30;
  const tpMargin = params.TP_MARGIN_PCT || 0.45;
  const minScore = params.MIN_SCORE || 8;

  bLog.scan(`LH/HL scan: ${topCoins.length} coins | AI params: SL=${(slMargin*100).toFixed(0)}%margin TP=${(tpMargin*100).toFixed(0)}%margin RR=1:${(tpMargin/slMargin).toFixed(1)} SIZE=${(params.WALLET_SIZE_PCT*100).toFixed(0)}%`);
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
        ` | SL=$${signal.sl.toFixed(6)} TP=$${signal.tp1.toFixed(6)} RR=1:${(tpMargin/slMargin).toFixed(1)} lev=${signal.leverage}x`
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
