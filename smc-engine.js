// ============================================================
// SMC Trading Engine — Simple 2-Gate Strategy
//
// Gate 1: 3m HL/LH — determines direction
// Gate 2: 1m HL/LH — confirms direction, enter at swing point
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
      if (p.swingLen3m) SWING_LENGTHS['3m'] = p.swingLen3m;
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

  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const label = swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH';
    highLabels.push({ ...swingHighs[i], label });
  }

  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    const label = swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL';
    lowLabels.push({ ...swingLows[i], label });
  }

  // Always use the most recent swing — the swing detection algorithm (len param)
  // already filters noise by requiring pivots higher/lower than N neighbors
  const lastHigh = highLabels.length ? highLabels[highLabels.length - 1] : null;
  const lastLow = lowLabels.length ? lowLabels[lowLabels.length - 1] : null;

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
  // Bullish ChoCh: Price breaks the most recent LH
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

// Institutional session windows matching PDF trading rules
const SMC_SESSION_WINDOWS = [
  { name: 'Asia',   startH: 23, endH: 2  },
  { name: 'Europe', startH: 7,  endH: 10 },
  { name: 'US',     startH: 12, endH: 16 },
];
// Avoid :00/:15/:30/:45 — high-volatility candle-open spikes
const SMC_AVOID_MINUTES = new Set([0, 15, 30, 45]);

function checkDailyLimits() {
  const tradingDay = getTradingDay();
  if (dailyStats.date !== tradingDay) {
    dailyStats.date = tradingDay;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }
  const dayOfWeek = new Date().getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const maxTrades = isWeekend ? 1 : 2;

  if (dailyStats.trades >= maxTrades) {
    return { canTrade: false, reason: `SMC: daily trade limit reached (${dailyStats.trades}/${maxTrades})` };
  }
  if (dailyStats.consecutiveLosses >= 2) {
    return { canTrade: false, reason: `SMC: stopped after ${dailyStats.consecutiveLosses} consecutive losses` };
  }
  return { canTrade: true };
}

function isGoodTradingSession() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  if (SMC_AVOID_MINUTES.has(m)) return false;
  return SMC_SESSION_WINDOWS.some(s => {
    if (s.startH > s.endH) return h >= s.startH || h < s.endH; // overnight (Asia wraps midnight)
    return h >= s.startH && h < s.endH;
  });
}

// ── Analyze Single Coin (Full Checklist — config-driven) ───

async function analyzeLHHL(ticker, params, dailyBiasCache, kronosPredictions = null) {
  const symbol = ticker.symbol;
  bLog.scan(`[HEARTBEAT] Analyzing ${symbol}...`);
  const price = parseFloat(ticker.lastPrice);

  // NOTE: 24/7 trading — no session or hour blocks. AI hour check is informational only.
  const hourCheck = await aiLearner.shouldTradeNow();
  if (!hourCheck.trade) {
    bLog.scan(`${symbol}: ${hourCheck.reason} — proceeding anyway (24/7 mode)`);
  }

  // Load AI-optimized strategy params from DB (set by Quantum Optimizer)
  // ┌─────────────────────────────────────────────────────────┐
  // │ Simple 2-Gate Strategy: 3m HL/LH → 1m HL/LH confirm    │
  // │ Direction from 3m, enter at 1m HL/LH swing point       │
  // └─────────────────────────────────────────────────────────┘

  const [klines3m, klines1m, klines1h] = await Promise.all([
    fetchKlines(symbol, '3m', 100),
    fetchKlines(symbol, '1m', 100),
    fetchKlines(symbol, '1h', 210),
  ]);

  if (!klines3m || !klines1m) return null;
  if (klines3m.length < 30 || klines1m.length < 30) return null;

  // ── Gate 1: 3m Structure — determines direction ──
  // REQUIRES full trend alignment: HH+HL for LONG, LH+LL for SHORT
  // Mixed structure (LH+HL or HH+LL) = ranging → skip
  const struct3m = getStructure(klines3m, SWING_LENGTHS['3m']);

  // Log swing details for chart comparison
  const fmtSwing = (s) => {
    if (!s) return 'none';
    const t = new Date(parseInt(s.candle[0])).toISOString().slice(11, 16);
    return `${s.label}@${s.price}(${t})`;
  };
  bLog.scan(`${symbol}: 3m sw=${SWING_LENGTHS['3m']} lastH=${fmtSwing(struct3m.lastHigh)} lastL=${fmtSwing(struct3m.lastLow)} → ${struct3m.label} trend=${struct3m.trend}`);

  let direction = null;
  // Only trade when BOTH high and low labels agree on direction
  if (struct3m.hasHL && struct3m.hasHH) direction = 'LONG';     // HH+HL = confirmed uptrend
  else if (struct3m.hasLH && struct3m.hasLL) direction = 'SHORT'; // LH+LL = confirmed downtrend
  // Mixed (LH+HL or HH+LL) = ranging → no trade

  if (!direction) {
    return null;
  }

  // ── EMA200 bias filter (1h) — score penalty for contrary direction (not a hard block) ──
  // NOTE: 24/7 mode — EMA200 is a guide, not a gate. Contrary direction = -3 score penalty.
  let ema200ScorePenalty = 0;
  if (klines1h && klines1h.length >= 50) {
    const closes1h = klines1h.map(k => parseFloat(k[4]));
    const ema200Period = Math.min(200, closes1h.length - 1);
    const k200 = 2 / (ema200Period + 1);
    let ema200 = closes1h[0];
    for (let i = 1; i < closes1h.length; i++) ema200 = closes1h[i] * k200 + ema200 * (1 - k200);
    const ema200Bias = price > ema200 ? 'bullish' : 'bearish';
    bLog.scan(`${symbol}: EMA200(1h)=$${ema200.toFixed(4)} price=$${price} bias=${ema200Bias}`);

    if (ema200Bias === 'bullish' && direction === 'SHORT') {
      ema200ScorePenalty = -3;
      bLog.scan(`${symbol}: SHORT against EMA200(1h) — penalty -3`);
    } else if (ema200Bias === 'bearish' && direction === 'LONG') {
      ema200ScorePenalty = -3;
      bLog.scan(`${symbol}: LONG against EMA200(1h) — penalty -3`);
    } else {
      bLog.scan(`${symbol}: EMA200(1h) aligned with ${direction} — no penalty`);
    }
  }

  // ── Gate 2: 1m Structure — confirms direction ──
  const struct1m = getStructure(klines1m, SWING_LENGTHS['1m']);

  bLog.scan(`${symbol}: 1m sw=${SWING_LENGTHS['1m']} lastH=${fmtSwing(struct1m.lastHigh)} lastL=${fmtSwing(struct1m.lastLow)} → ${struct1m.label} trend=${struct1m.trend}`);

  if (direction === 'LONG' && !struct1m.hasHL) {
    bLog.scan(`${symbol}: LONG rejected — 1m no HL`);
    return null;
  }
  if (direction === 'SHORT' && !struct1m.hasLH) {
    bLog.scan(`${symbol}: SHORT rejected — 1m no LH`);
    return null;
  }

  // ── Entry timing: swing must be fresh (within 3 candles of confirmation) ──
  const swingPoint = direction === 'LONG' ? struct1m.lastLow : struct1m.lastHigh;
  if (!swingPoint) return null;

  const swingIdx = swingPoint.index;
  const swingPrice = swingPoint.price;

  const confirmationIdx = swingIdx + SWING_LENGTHS['1m'];
  const currentIdx = klines1m.length - 1;
  const candleAge = currentIdx - confirmationIdx;

  if (candleAge < 0 || candleAge > 20) {
    bLog.scan(`${symbol}: ${direction} — swing age ${candleAge} (need 0-20 for valid entry)`);
    return null;
  }

  // ── PULLBACK CHECK: only enter when price is near the swing zone ──
  // LONG: buy near the HL (the low), NOT at the HH (the high)
  // SHORT: sell near the LH (the high), NOT at the LL (the low)
  // Max allowed distance: 1.5% — gives room for fast-moving markets
  const MAX_CHASE_PCT = 0.015; // 1.5% max distance from swing
  let chaseScorePenalty = 0;
  if (direction === 'LONG') {
    const distFromSwing = (price - swingPrice) / swingPrice;
    if (distFromSwing > MAX_CHASE_PCT) {
      bLog.scan(`${symbol}: LONG rejected — price $${price} is ${(distFromSwing*100).toFixed(2)}% above HL@$${swingPrice} (chasing the high, max ${MAX_CHASE_PCT*100}%)`);
      return null;
    }
    if (distFromSwing > 0.006) chaseScorePenalty = -2; // 0.6%-1.5% from swing = -2 penalty
  } else {
    const distFromSwing = (swingPrice - price) / swingPrice;
    if (distFromSwing > MAX_CHASE_PCT) {
      bLog.scan(`${symbol}: SHORT rejected — price $${price} is ${(distFromSwing*100).toFixed(2)}% below LH@$${swingPrice} (chasing the low, max ${MAX_CHASE_PCT*100}%)`);
      return null;
    }
    if (distFromSwing > 0.006) chaseScorePenalty = -2; // 0.6%-1.5% from swing = -2 penalty
  }

  // ── SL below the previous swing low (LONG) / above previous swing high (SHORT) ──
  // Proper SMC: stop below the low that formed the HL, with 0.1% buffer
  const swingLows1m = struct1m.swingLows;
  const swingHighs1m = struct1m.swingHighs;
  let sl, slDist;

  if (direction === 'LONG') {
    const prevLow = swingLows1m.length >= 2 ? swingLows1m[swingLows1m.length - 2] : null;
    const slPrice = prevLow ? prevLow.price * 0.999 : swingPrice * 0.995;
    sl = slPrice;
    slDist = (price - sl) / price;
  } else {
    const prevHigh = swingHighs1m.length >= 2 ? swingHighs1m[swingHighs1m.length - 2] : null;
    const slPrice = prevHigh ? prevHigh.price * 1.001 : swingPrice * 1.005;
    sl = slPrice;
    slDist = (sl - price) / price;
  }

  // Sanity: SL distance must be between 0.05% and 5% — outside that range = bad structure
  if (slDist < 0.0005 || slDist > 0.05) {
    bLog.scan(`${symbol}: ${direction} — SL distance ${(slDist*100).toFixed(3)}% out of range (0.05%-5%) — skipped`);
    return null;
  }

  // TP at 2:1 risk:reward from entry
  const tp = direction === 'LONG' ? price + (price - sl) * 2 : price - (sl - price) * 2;

  bLog.scan(`${symbol}: ${direction} entry@$${price} swing@$${swingPrice} SL=$${sl.toFixed(4)} TP=$${tp.toFixed(4)} slDist=${(slDist*100).toFixed(2)}% RR=2:1`);

  // Leverage based on token price: $100+ → 100x, $10-99 → 50x, <$10 → 20x
  const HIGH_PRICE = new Set(['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','AAVEUSDT','MKRUSDT','BCHUSDT','LTCUSDT','AVAXUSDT','LINKUSDT']);
  let leverage;
  if (HIGH_PRICE.has(symbol) || price >= 100) leverage = params.LEV_BTC_ETH || 100;
  else if (price >= 10) leverage = params.LEV_MID || 50;
  else leverage = params.LEV_ALT || 20;

  // ┌─────────────────────────────────────────────────────────┐
  // │ Score — simple: 3m + 1m agreement                      │
  // └─────────────────────────────────────────────────────────┘
  let score = 10; // Base score for passing both gates

  // Apply EMA200 and chase penalties accumulated above
  score += ema200ScorePenalty;
  score += chaseScorePenalty;

  // Bonus: strong trend on both TFs
  const expectedTrend = direction === 'LONG' ? 'bullish' : 'bearish';
  if (struct3m.trend === expectedTrend) score += 3;
  if (struct1m.trend === expectedTrend) score += 2;

  // Swing freshness bonus: fresh = +2, slightly stale = 0, old = -1
  if (candleAge === 0) score += 2;
  else if (candleAge <= 6) score += 0; // normal
  else score -= 1; // old swing, slight penalty

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

  // Structure-based learning: check if this 3m/1m structure combo historically wins
  const structLabel = `${struct3m.label}|${struct1m.label}`;
  const structWR = await aiLearner.getStructureWinRate(struct3m.label, struct1m.label, direction);
  if (structWR && structWR.total >= 5) {
    if (structWR.winRate < 0.25) {
      bLog.scan(`${symbol}: structure ${structLabel} historically loses (${(structWR.winRate*100).toFixed(0)}% WR, ${structWR.total} trades) — BLOCKED`);
      return null;
    }
    if (structWR.winRate < 0.40) {
      score -= 5;
      bLog.scan(`${symbol}: structure ${structLabel} weak WR ${(structWR.winRate*100).toFixed(0)}% (-5)`);
    } else if (structWR.winRate > 0.60) {
      score += 3;
      bLog.scan(`${symbol}: structure ${structLabel} strong WR ${(structWR.winRate*100).toFixed(0)}% (+3)`);
    }
  }

  // Pattern modifier (now uses structure label instead of just trend)
  const session = aiLearner.getCurrentSession();
  const patternMod = await aiLearner.getPatternModifier(symbol, setup, direction, session, structLabel);
  if (patternMod !== 0) {
    score += patternMod;
    bLog.scan(`${symbol}: pattern modifier ${patternMod > 0 ? '+' : ''}${patternMod}`);
  }

  bLog.scan(
    `SIGNAL: ${symbol} ${direction} | 3m=${struct3m.label} 1m=${struct1m.label} ` +
    `| entry@$${price} SL=$${sl.toFixed(4)} TP=$${tp.toFixed(4)} slDist=${(slDist*100).toFixed(2)}% ` +
    `| score=${Math.round(score)} | age=${candleAge}` +
    (structWR ? ` | structWR=${(structWR.winRate*100).toFixed(0)}%/${structWR.total}t` : '')
  );

  return {
    symbol,
    direction,
    price,
    lastPrice: price,
    swingPrice,
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
    sizeMod: hourCheck.reduceSizeBy || hourCheck.boostSizeBy || 1.0,
    marketStructure: structLabel,
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
  // NOTE: 24/7 mode — no session gates, no daily limits. Signal quality gates only.
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
