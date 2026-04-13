// ============================================================
// SMC Trading Engine — Simple 2-Gate Strategy
//
// Gate 1: 3m HL/LH — determines direction
// Gate 2: 1m HL/LH — confirms direction (next candle entry)
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');

const REQUEST_TIMEOUT = 15000;
const TOP_N_COINS = 10;
const MIN_24H_VOLUME = 10_000_000;

const SL_PCT = 0.005;          // 0.5% price = 10% capital at 20x
const TP_PCT = 0.01;           // 1% price = 20% capital at 20x (RR 1:2)
const TRAILING_STEP = 0.012;   // trail SL by 1.2% after TP reached

// Swing lengths per timeframe (defaults, overridden by strategyConfig)
// Defaults match Quantum Optimizer v3.46 winning strategy (sw:6/7/14/4)
let SWING_LENGTHS = { '4h': 6, '1h': 7, '15m': 14, '3m': 5, '1m': 4 };

// Strategy config loaded from DB (ai_versions best params)
let strategyConfig = null;
let strategyConfigLoadedAt = 0;
const STRATEGY_CONFIG_TTL = 120000; // 2 min cache

async function getStrategyConfig() {
  if (strategyConfig && Date.now() - strategyConfigLoadedAt < STRATEGY_CONFIG_TTL) return strategyConfig;
  try {
    const db = require('./db');
    const rows = await db.query('SELECT params FROM ai_versions ORDER BY id DESC LIMIT 1');
    if (rows.length && rows[0].params) {
      const p = typeof rows[0].params === 'string' ? JSON.parse(rows[0].params) : rows[0].params;
      strategyConfig = p;
      strategyConfigLoadedAt = Date.now();
      // Update swing lengths if provided
      if (p.swingLen4h) SWING_LENGTHS['4h'] = p.swingLen4h;
      if (p.swingLen1h) SWING_LENGTHS['1h'] = p.swingLen1h;
      if (p.swingLen15m) SWING_LENGTHS['15m'] = p.swingLen15m;
      if (p.swingLen1m) SWING_LENGTHS['1m'] = p.swingLen1m;
      bLog.ai(`Strategy config loaded: sw=${p.swingLen4h||10}/${p.swingLen1h||10}/${p.swingLen15m||10}/${p.swingLen1m||5} HTF:${p.requireBothHTF?'both':'either'} KL:${p.requireKeyLevel?'Y':'N'} 1m:${p.require1m?'Y':'N'}`);
      return p;
    }
  } catch (err) { bLog.error(`Failed to load strategy config: ${err.message}`); }
  return null;
}

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

// ── Swing Detection ─────────────────────────────────────────

function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const swings = [];
  let lastType = null;

  for (let i = len; i < klines.length - len; i++) {
    let isHigh = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) { isHigh = false; break; }
    }

    let isLow = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (lows[i] >= lows[i + j]) { isLow = false; break; }
    }

    if (isHigh && isLow) {
      const highDist = highs[i] - Math.max(highs[i - 1], highs[i + 1]);
      const lowDist = Math.min(lows[i - 1], lows[i + 1]) - lows[i];
      if (highDist > lowDist) isLow = false;
      else isHigh = false;
    }

    if (isHigh) {
      if (lastType === 'high') {
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


function detectTentativePivot(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const tentative = { isLow: false, isHigh: false, index: -1, price: 0 };
  const lastIdx = klines.length - 1;

  for (let i = lastIdx - 1; i >= Math.max(0, lastIdx - len); i--) {
    let isLocalLow = true;
    for (let j = i - len; j < i; j++) {
      if (j < 0) continue;
      if (lows[i] >= lows[j]) { isLocalLow = false; break; }
    }
    if (isLocalLow) {
      tentative.isLow = true;
      tentative.index = i;
      tentative.price = lows[i];
      break;
    }
  }
  for (let i = lastIdx - 1; i >= Math.max(0, lastIdx - len); i--) {
    let isLocalHigh = true;
    for (let j = i - len; j < i; j++) {
      if (j < 0) continue;
      if (highs[i] >= highs[j]) { isLocalHigh = false; break; }
    }
    if (isLocalHigh) {
      tentative.isHigh = true;
      tentative.index = i;
      tentative.price = highs[i];
      break;
    }
  }
  return tentative;
}

// ── Market Structure Labels ─────────────────────────────────

function getStructure(klines, len) {
  const swings = detectSwings(klines, len);
  const tentative = detectTentativePivot(klines, len);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');

  // Minimum swing size: HL/LH must differ by at least 0.05% from previous swing
  // Lowered from 0.15% to 0.05% to capture deeper, more significant structure changes
  const MIN_SWING_PCT = 0.0005;

  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const diff = Math.abs(swingHighs[i].price - swingHighs[i - 1].price) / swingHighs[i - 1].price;
    const label = swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH';
    highLabels.push({ ...swingHighs[i], label, significant: diff >= MIN_SWING_PCT });
  }

  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    const diff = Math.abs(swingLows[i].price - swingLows[i - 1].price) / swingLows[i - 1].price;
    const label = swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL';
    lowLabels.push({ ...swingLows[i], label, significant: diff >= MIN_SWING_PCT });
  }

  // Only consider significant swings for direction decisions
  const sigHighs = highLabels.filter(h => h.significant);
  const sigLows = lowLabels.filter(l => l.significant);
  const lastHigh = sigHighs.length ? sigHighs[sigHighs.length - 1] : (highLabels.length ? highLabels[highLabels.length - 1] : null);
  const lastLow = sigLows.length ? sigLows[sigLows.length - 1] : (lowLabels.length ? lowLabels[lowLabels.length - 1] : null);

  let trend = 'neutral';
  let isChoCh = false;

  if (lastHigh && lastLow) {
    const isBearish = lastHigh.label === 'LH' && lastLow.label === 'LL';
    const isBullish = lastHigh.label === 'HH' && lastLow.label === 'HL';
    if (isBearish) trend = 'bearish';
    else if (isBullish) trend = 'bullish';
    else if (lastHigh.label === 'LH') trend = 'bearish';
    else if (lastLow.label === 'HL') trend = 'bullish';
  }

  // Detect Change of Character (ChoCh)
  // Bullish ChoCh: Price breaks the most recent significant LH
  if (lastHigh && lastHigh.label === 'LH' && klines[klines.length - 1][4] > lastHigh.price) {
    isChoCh = true;
  }

  return {
    swings, swingHighs, swingLows, highLabels, lowLabels, lastHigh, lastLow, trend,
    hasLH: lastHigh?.label === 'LH',
    hasHL: lastLow?.label === 'HL',
    hasHH: lastHigh?.label === 'HH',
    hasLL: lastLow?.label === 'LL',
    isChoCh,
    tentative,
    label: `${lastHigh?.label || '--'}/${lastLow?.label || '--'}`,
  };
}

// ── Daily Stats ─────────────────────────────────────────────

// Daily stats tracked at engine level, but per-user loss limits are in cycle.js
const dailyStats = { date: '', trades: 0, consecutiveLosses: 0 };

function getTradingDay() {
  const now = new Date();
  const h = now.getHours();
  const d = new Date(now);
  if (h < 7) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function recordDailyTrade(isWin) {
  const tradingDay = getTradingDay();
  if (dailyStats.date !== tradingDay) {
    dailyStats.date = tradingDay;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }
  dailyStats.trades++;
  if (isWin) dailyStats.consecutiveLosses = 0;
  else dailyStats.consecutiveLosses++;
}

function checkDailyLimits() {
  // Per-user loss limits handled in cycle.js via key.max_consec_loss
  // Engine always scans — individual users get stopped by their own setting
  return { canTrade: true };
}

function isGoodTradingSession() {
  const utcH = new Date().getUTCHours();
  return !(utcH >= 4 && utcH <= 5);
}

// ── Analyze Single Coin (Full Checklist — config-driven) ───

async function analyzeLHHL(ticker, params, dailyBiasCache, kronosPredictions = null) {
  const symbol = ticker.symbol;
  bLog.scan(`[HEARTBEAT] Analyzing ${symbol}...`);
  const price = parseFloat(ticker.lastPrice);

  // Load AI-optimized strategy params from DB (set by Quantum Optimizer)
  // ┌─────────────────────────────────────────────────────────┐
  // │ Simple 2-Gate Strategy: 3m HL/LH → 1m HL/LH confirm    │
  // │ Direction from 3m structure, entry on 1m next candle    │
  // └─────────────────────────────────────────────────────────┘

  const [klines3m, klines1m] = await Promise.all([
    fetchKlines(symbol, '3m', 100),
    fetchKlines(symbol, '1m', 100),
  ]);

  if (!klines3m || !klines1m) return null;
  if (klines3m.length < 30 || klines1m.length < 30) return null;

  // ── Gate 1: 3m Structure — determines direction ──
  const struct3m = getStructure(klines3m, SWING_LENGTHS['3m']);
  let direction = null;
  if (struct3m.hasHL) direction = 'LONG';
  else if (struct3m.hasLH) direction = 'SHORT';

  if (!direction) {
    bLog.scan(`${symbol}: 3m no HL/LH — skipped`);
    return null;
  }

  // ── Gate 2: 1m Structure — confirms direction + next candle entry ──
  const struct1m = getStructure(klines1m, SWING_LENGTHS['1m']);

  if (direction === 'LONG' && !struct1m.hasHL) {
    bLog.scan(`${symbol}: LONG — 3m has HL but 1m has no HL confirmation`);
    return null;
  }
  if (direction === 'SHORT' && !struct1m.hasLH) {
    bLog.scan(`${symbol}: SHORT — 3m has LH but 1m has no LH confirmation`);
    return null;
  }

  // Next candle entry: trade must fire within 1 candle of 1m confirmation
  const swingIdx = direction === 'LONG' ? struct1m.lastLow?.index : struct1m.lastHigh?.index;
  if (swingIdx === undefined) return null;

  const confirmationIdx = swingIdx + SWING_LENGTHS['1m'];
  const currentIdx = klines1m.length - 1;
  const candleAge = currentIdx - confirmationIdx;

  if (candleAge < 0 || candleAge > 3) {
    bLog.scan(`${symbol}: ${direction} — swing age ${candleAge} (need 0-3 for fresh entry)`);
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Risk Management: SL/TP scaled by leverage               │
  // │ Always risk 10% capital, target 20% capital (RR 1:2)    │
  // │ SL/trailing stay the same — user-configured             │
  // └─────────────────────────────────────────────────────────┘
  // Leverage based on token price: $100+ → 100x, $10-99 → 50x, <$10 → 20x
  const HIGH_PRICE = new Set(['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','AAVEUSDT','MKRUSDT','BCHUSDT','LTCUSDT','AVAXUSDT','LINKUSDT']);
  let leverage;
  if (HIGH_PRICE.has(symbol) || price >= 100) leverage = params.LEV_BTC_ETH || 100;
  else if (price >= 10) leverage = params.LEV_MID || 50;
  else leverage = params.LEV_ALT || 20;

  const CAPITAL_SL = 0.10;
  const CAPITAL_TP = 0.20;
  const slPct = CAPITAL_SL / leverage;
  const tpPct = CAPITAL_TP / leverage;

  const sl = direction === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);
  const slDist = slPct;
  const tp = direction === 'LONG' ? price * (1 + tpPct) : price * (1 - tpPct);

  // ┌─────────────────────────────────────────────────────────┐
  // │ Score — simple: 3m + 1m agreement                      │
  // └─────────────────────────────────────────────────────────┘
  let score = 10; // Base score for passing both gates

  // Bonus: strong trend on both TFs
  const expectedTrend = direction === 'LONG' ? 'bullish' : 'bearish';
  if (struct3m.trend === expectedTrend) score += 3;
  if (struct1m.trend === expectedTrend) score += 2;

  // Fresh swing bonus (age 0 = just formed)
  if (candleAge === 0) score += 2;

  // Kronos AI prediction bonus/penalty
  let kronosData = null;
  if (kronosPredictions && kronosPredictions.has(symbol)) {
    kronosData = kronosPredictions.get(symbol);
    if (!kronosData.error) {
      if (kronosData.direction === direction) {
        const boost = kronosData.confidence === 'high' ? 5 : kronosData.confidence === 'medium' ? 3 : 1;
        score += boost;
        bLog.scan(`${symbol}: Kronos AGREES ${direction} (+${boost}) conf=${kronosData.confidence} ${kronosData.change_pct}%`);
      } else if (kronosData.direction !== 'NEUTRAL') {
        const penalty = kronosData.confidence === 'high' ? 6 : kronosData.confidence === 'medium' ? 3 : 1;
        score -= penalty;
        bLog.scan(`${symbol}: Kronos DISAGREES (${kronosData.direction} vs ${direction}) (-${penalty}) conf=${kronosData.confidence}`);
      }
    }
  }

  // AI modifier from learning history
  const setup = direction === 'LONG' ? 'HTF_LONG' : 'HTF_SHORT';
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, setup, direction);
  score = score * aiModifier;

  // Pattern modifier
  const session = aiLearner.getCurrentSession();
  const trend1m = struct1m.trend || 'unknown';
  const patternMod = await aiLearner.getPatternModifier(symbol, setup, direction, session, trend1m);
  if (patternMod !== 0) {
    score += patternMod;
    bLog.scan(`${symbol}: pattern modifier ${patternMod > 0 ? '+' : ''}${patternMod}`);
  }

  bLog.scan(
    `SIGNAL: ${symbol} ${direction} | 3m=${struct3m.label} 1m=${struct1m.label} ` +
    `| score=${Math.round(score)} | age=${candleAge}`
  );

  return {
    symbol,
    direction,
    price,
    lastPrice: price,
    sl,
    tp1: tp,
    tp2: tp,
    tp3: tp,
    trailingStep: TRAILING_STEP,
    slDist,
    leverage,
    score: Math.round(score * 10) / 10,
    setup,
    setupName: `${direction}-3m1m`,
    aiModifier: Math.round(aiModifier * 100) / 100,
    structure: {
      tf3m: struct3m.label,
      tf1m: struct1m.label,
    },
    kronos: kronosData ? {
      direction: kronosData.direction,
      change_pct: kronosData.change_pct,
      confidence: kronosData.confidence,
      trend: kronosData.trend,
    } : null,
  };
}

// ── Main Scan ────────────────────────────────────────────────

async function scanSMC(log, opts = {}) {
  const limits = checkDailyLimits();
  if (!limits.canTrade) {
    log(`Refined: ${limits.reason}. Stopped trading.`);
    bLog.scan(limits.reason);
    return [];
  }

  // Dead zone removed — trade 24/7

  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('Failed to fetch tickers'); return []; }

  const BLACKLIST = new Set([
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT','TRUUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ]);

  // Only skip banned tokens (no whitelist — trade everything)
  let bannedTokens = new Set();
  try {
    const db = require('./db');
    const rows = await db.query('SELECT symbol FROM global_token_settings WHERE banned = true');
    if (rows.length > 0) {
      bannedTokens = new Set(rows.map(r => r.symbol));
      bLog.scan(`Banned tokens: ${bannedTokens.size}`);
    }
  } catch (err) {
    bLog.error(`Failed to load banned tokens: ${err.message}`);
  }

  const topCoins = (tickers || [])
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !BLACKLIST.has(t.symbol))
    .filter(t => !bannedTokens.has(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, opts.topNCoins || TOP_N_COINS);

  const params = await aiLearner.getOptimalParams();
  const minScore = Math.min(params.MIN_SCORE || 2, 6); // 3m+1m HL/LH is primary gate
  const dailyBiasCache = new Map();

  bLog.scan(`Triple HL/LH scan: ${topCoins.length} coins | minScore=${minScore}`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      continue;
    }

    const signal = await analyzeLHHL(ticker, params, dailyBiasCache, opts.kronosPredictions || null);
    analyzed++;

    if (signal && signal.score >= minScore) {
      results.push(signal);
      bLog.scan(
        `SIGNAL: ${signal.symbol} ${signal.direction} | score=${signal.score} ` +
        `setup=${signal.setupName} | SL=$${signal.sl.toFixed(4)} TP=$${signal.tp1.toFixed(4)}`
      );
    }

    await new Promise(r => setTimeout(r, 200));
  }

  if (skippedAI > 0) bLog.ai(`AI avoided ${skippedAI} coins`);
  bLog.scan(`Scan complete: ${analyzed} analyzed, ${results.length} signals`);

  if (!results.length) {
    bLog.scan('No signals — checklist not met on any coin.');
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
