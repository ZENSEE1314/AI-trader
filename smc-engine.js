// ============================================================
// SMC Swing Cascade Trading Engine
//
// Strategy (ALL must pass):
//   1. 15M swing point formed — determines direction (HL=LONG, LH=SHORT)
//   2. 3M swing point confirms same direction
//   3. 1M swing point formed — enter on the NEXT candle after swing
//   4. Risk: dynamic TP based on volume, fixed SL
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');

const REQUEST_TIMEOUT = 15000;
const TOP_N_COINS = 50;
const MIN_24H_VOLUME = 10_000_000;

const TP_PCT = 0.045; // 4.5% take profit
const SL_PCT = 0.03;  // 3% stop loss

// Swing lengths per timeframe
const SWING_LENGTHS = { '15m': 10, '3m': 5, '1m': 5 };

// ── Fetch Helpers ────────────────────────────────────────────

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (res.ok) return res;
    } catch (e) {
      if (i === retries - 1) bLog.error(`fetchWithRetry failed: ${url.split('?')[0]} — ${e.message}`);
    }
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

// ── Helpers for detailed logging ────────────────────────────

function getSwingChain(struct, count = 4) {
  const all = [
    ...struct.highLabels.map(h => ({ ...h, tag: h.label })),
    ...struct.lowLabels.map(l => ({ ...l, tag: l.label })),
  ].sort((a, b) => a.index - b.index);
  return all.slice(-count).map(s => s.tag).join('→');
}

function getEMAPosition(klines, price) {
  const closes = klines.map(k => parseFloat(k[4]));
  if (closes.length < 22) return { ema7: 0, ema22: 0, label: '?' };
  const ema = (arr, period) => {
    const k = 2 / (period + 1);
    let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
    return val;
  };
  const e7 = ema(closes, 7);
  const e22 = ema(closes, 22);
  const aboveEma7 = price > e7;
  const aboveEma22 = price > e22;
  let label;
  if (aboveEma7 && aboveEma22) label = 'ABOVE both';
  else if (!aboveEma7 && !aboveEma22) label = 'BELOW both';
  else if (aboveEma7) label = 'above EMA7 below EMA22';
  else label = 'below EMA7 above EMA22';
  return { ema7: e7, ema22: e22, label, aboveEma7, aboveEma22 };
}

function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ── Market Structure Labels ─────────────────────────────────

function getStructure(klines, len) {
  const swings = detectSwings(klines, len);
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

  const lastHigh = highLabels.length ? highLabels[highLabels.length - 1] : null;
  const lastLow = lowLabels.length ? lowLabels[lowLabels.length - 1] : null;

  let trend = 'neutral';
  if (lastHigh && lastLow) {
    const isBearish = lastHigh.label === 'LH' && lastLow.label === 'LL';
    const isBullish = lastHigh.label === 'HH' && lastLow.label === 'HL';
    if (isBearish) trend = 'bearish';
    else if (isBullish) trend = 'bullish';
    else if (lastHigh.label === 'LH') trend = 'bearish_lean';
    else if (lastLow.label === 'HL') trend = 'bullish_lean';
  }

  return {
    swings, swingHighs, swingLows, highLabels, lowLabels, lastHigh, lastLow, trend,
    hasLH: lastHigh?.label === 'LH',
    hasHL: lastLow?.label === 'HL',
    hasHH: lastHigh?.label === 'HH',
    hasLL: lastLow?.label === 'LL',
    label: `${lastHigh?.label || '--'}/${lastLow?.label || '--'}`,
  };
}

// ── Daily Stats ─────────────────────────────────────────────

const dailyStats = { date: '', trades: 0, consecutiveLosses: 0 };

function recordDailyTrade(isWin) {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyStats.date !== today) {
    dailyStats.date = today;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }
  dailyStats.trades++;
  if (isWin) dailyStats.consecutiveLosses = 0;
  else dailyStats.consecutiveLosses++;
}

function checkDailyLimits() {
  if (dailyStats.consecutiveLosses >= 2) {
    return { canTrade: false, reason: `${dailyStats.consecutiveLosses} consecutive losses — cooling down` };
  }
  return { canTrade: true };
}

function isGoodTradingSession() {
  const utcH = new Date().getUTCHours();
  return !(utcH >= 4 && utcH <= 5);
}

// ── Analyze Single Coin (Swing Cascade: 15m → 3m → 1m) ─────

async function analyzeLHHL(ticker, params) {
  const symbol = ticker.symbol;
  const price = parseFloat(ticker.lastPrice);

  // ┌─────────────────────────────────────────────────────────┐
  // │ Fetch 15m, 3m, 1m klines                                │
  // └─────────────────────────────────────────────────────────┘
  const [klines15m, klines3m, klines1m] = await Promise.all([
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '3m', 100),
    fetchKlines(symbol, '1m', 100),
  ]);

  if (!klines15m || !klines3m || !klines1m) return null;
  // Need enough history: 80 x 15m = 20 hours min (rejects brand new listings)
  if (klines15m.length < 80 || klines3m.length < 50 || klines1m.length < 30) return null;

  const struct15m = getStructure(klines15m, SWING_LENGTHS['15m']);
  const struct3m = getStructure(klines3m, SWING_LENGTHS['3m']);
  const struct1m = getStructure(klines1m, SWING_LENGTHS['1m']);

  const vol24h = parseFloat(ticker.quoteVolume || 0);
  const emaPos = getEMAPosition(klines15m, price);
  const chain15m = getSwingChain(struct15m);
  const chain3m = getSwingChain(struct3m);
  const chain1m = getSwingChain(struct1m);

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 1: 15M structure — determines direction            │
  // │ LONG: 15M must be bullish (HH + HL) — full trend       │
  // │ SHORT: 15M must be bearish (LH + LL) — full trend      │
  // │ Mixed (LH + HL) = pullback, NO TRADE                   │
  // └─────────────────────────────────────────────────────────┘
  // Build structure label strings: e.g. "HH/HL bullish"
  const lbl15m = `${struct15m.label} ${struct15m.trend}`;
  const lbl3m = `${struct3m.label} ${struct3m.trend}`;
  const lbl1m = `${struct1m.label} ${struct1m.trend}`;

  // Require FULL trend alignment: both high AND low must agree
  // HH + HL = bullish → LONG
  // LH + LL = bearish → SHORT
  // LH + HL or HH + LL = mixed/pullback → skip
  const isBullish15m = struct15m.hasHH && struct15m.hasHL; // full bullish
  const isBearish15m = struct15m.hasLH && struct15m.hasLL; // full bearish

  if (!isBullish15m && !isBearish15m) {
    bLog.scan(
      `${symbol}: $${price} | Vol=${fmtVol(vol24h)} | ` +
      `15M=[${chain15m}] ${lbl15m} | 3M=[${chain3m}] ${lbl3m} | 1M=[${chain1m}] ${lbl1m} | ` +
      `EMA: ${emaPos.label} — 15M not fully aligned (need HH+HL or LH+LL) ❌`
    );
    return null;
  }

  const direction = isBullish15m ? 'LONG' : 'SHORT';

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 2: 3M swing point confirms same direction          │
  // │ LONG needs HL on 3M, SHORT needs LH on 3M              │
  // └─────────────────────────────────────────────────────────┘
  const has3mConfirm = (direction === 'LONG' && struct3m.hasHL) ||
                       (direction === 'SHORT' && struct3m.hasLH);

  if (!has3mConfirm) {
    bLog.scan(
      `${symbol}: $${price} | Vol=${fmtVol(vol24h)} | ${direction} | ` +
      `15M=[${chain15m}] ${lbl15m} ✓ | 3M=[${chain3m}] ${lbl3m} need ${direction === 'LONG' ? 'HL' : 'LH'} ❌ | ` +
      `1M=[${chain1m}] ${lbl1m} | EMA: ${emaPos.label}`
    );
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 3: 1M swing point formed — enter on NEXT candle    │
  // │ LONG needs HL on 1M, SHORT needs LH on 1M              │
  // │ Entry candle = the candle right after the swing point   │
  // └─────────────────────────────────────────────────────────┘
  const has1mEntry = (direction === 'LONG' && struct1m.hasHL) ||
                     (direction === 'SHORT' && struct1m.hasLH);

  if (!has1mEntry) {
    bLog.scan(
      `${symbol}: $${price} | Vol=${fmtVol(vol24h)} | ${direction} | ` +
      `15M=[${chain15m}] ${lbl15m} ✓ | 3M=[${chain3m}] ${lbl3m} ✓ | ` +
      `1M=[${chain1m}] ${lbl1m} need ${direction === 'LONG' ? 'HL' : 'LH'} — WAITING ⏳`
    );
    return null;
  }

  // The 1M swing must be fresh — enter on the next candle after confirmation
  const lastCandleIdx = klines1m.length - 1;
  const entrySwing = direction === 'LONG' ? struct1m.lastLow : struct1m.lastHigh;
  if (!entrySwing) return null;

  const candlesAfterSwing = lastCandleIdx - entrySwing.index;
  // Swing needs SWING_LENGTHS['1m'] candles after it to be confirmed
  // So "age since confirmed" = candlesAfterSwing - SWING_LENGTHS['1m']
  const swingLen = SWING_LENGTHS['1m'];
  const ageAfterConfirm = candlesAfterSwing - swingLen;

  // Not yet confirmed (still forming)
  if (ageAfterConfirm < 1) {
    bLog.scan(
      `${symbol}: $${price} | ${direction} | ` +
      `15M=[${chain15m}] ${lbl15m} ✓ | 3M=[${chain3m}] ${lbl3m} ✓ | ` +
      `1M=[${chain1m}] ${lbl1m} ✓ | swing confirming (${candlesAfterSwing}/${swingLen + 1} candles) — WAIT ⏳`
    );
    return null;
  }

  // Enter within 5 candles after swing is confirmed, then it's stale
  const MAX_ENTRY_AGE = 5;
  if (ageAfterConfirm > MAX_ENTRY_AGE) {
    bLog.scan(
      `${symbol}: $${price} | ${direction} | ` +
      `15M=[${chain15m}] ${lbl15m} ✓ | 3M=[${chain3m}] ${lbl3m} ✓ | ` +
      `1M=[${chain1m}] ${lbl1m} ✓ | confirmed ${ageAfterConfirm} candles ago (max ${MAX_ENTRY_AGE}) — STALE ⏳`
    );
    return null;
  }

  // ┌─────────────────────────────────────────────────────────┐
  // │ Step 4: Risk Management — Dynamic TP based on volume    │
  // └─────────────────────────────────────────────────────────┘
  const BTC_ETH = new Set(['BTCUSDT', 'ETHUSDT']);
  const leverage = BTC_ETH.has(symbol) ? Math.min(params.LEV_BTC_ETH || 20, 20) : Math.min(params.LEV_ALT || 20, 20);

  // Volume strength: compare last 5 candles avg volume vs last 20 candles avg
  const volumes1m = klines1m.map(k => parseFloat(k[5]));
  const recentVol = volumes1m.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVol = volumes1m.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol > 0 ? recentVol / avgVol : 1;

  let dynamicTP;
  let volLabel;
  if (volRatio >= 1.5) {
    dynamicTP = TP_PCT;           // 4.5%
    volLabel = 'STRONG';
  } else if (volRatio >= 0.8) {
    dynamicTP = TP_PCT * 0.67;    // ~3%
    volLabel = 'NORMAL';
  } else {
    dynamicTP = TP_PCT * 0.44;    // ~2%
    volLabel = 'WEAK';
  }

  const sl = direction === 'LONG' ? price * (1 - SL_PCT) : price * (1 + SL_PCT);
  const tp = direction === 'LONG' ? price * (1 + dynamicTP) : price * (1 - dynamicTP);
  const slDist = SL_PCT;

  // ┌─────────────────────────────────────────────────────────┐
  // │ Score                                                    │
  // └─────────────────────────────────────────────────────────┘
  let score = 10;

  // Bonus: all 3 TFs strictly aligned (not just lean)
  if (struct15m.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 3;
  if (struct3m.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 2;
  if (struct1m.trend === (direction === 'LONG' ? 'bullish' : 'bearish')) score += 1;

  // Bonus: strong volume
  if (volLabel === 'STRONG') score += 2;

  // Bonus: EMA alignment
  if (direction === 'LONG' && emaPos.aboveEma7 && emaPos.aboveEma22) score += 1;
  if (direction === 'SHORT' && !emaPos.aboveEma7 && !emaPos.aboveEma22) score += 1;

  // AI modifier
  const setup = direction === 'LONG' ? 'CASCADE_LONG' : 'CASCADE_SHORT';
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, setup, direction);
  score = score * aiModifier;

  bLog.scan(
    `✅ SIGNAL: ${symbol} ${direction} $${price} | Vol=${fmtVol(vol24h)} (1M vol: ${volLabel} ${volRatio.toFixed(1)}x) | ` +
    `15M=[${chain15m}] ${struct15m.trend} | 3M=[${chain3m}] ${struct3m.trend} | ` +
    `1M=[${chain1m}] ${struct1m.trend} | EMA: ${emaPos.label} | ` +
    `Entry: ${candlesAfterSwing} candle(s) after 1M swing | ` +
    `TP=${(dynamicTP * 100).toFixed(1)}% SL=${(SL_PCT * 100)}% | score=${Math.round(score)}`
  );

  return {
    symbol,
    direction,
    price,
    lastPrice: price,
    sl,
    tp1: tp,
    tp2: direction === 'LONG' ? price * (1 + dynamicTP * 1.2) : price * (1 - dynamicTP * 1.2),
    tp3: direction === 'LONG' ? price * (1 + dynamicTP * 1.5) : price * (1 - dynamicTP * 1.5),
    slDist,
    leverage,
    score: Math.round(score * 10) / 10,
    setup,
    setupName: `${direction}-CASCADE`,
    aiModifier: Math.round(aiModifier * 100) / 100,
    structure: {
      tf15: struct15m.label,
      tf3: struct3m.label,
      tf1: struct1m.label,
      trend15m: struct15m.trend,
      trend3m: struct3m.trend,
      trend1m: struct1m.trend,
    },
  };
}

// ── Main Scan ────────────────────────────────────────────────

async function scanSMC(log, opts = {}) {
  const limits = checkDailyLimits();
  if (!limits.canTrade) {
    log(`Cascade: ${limits.reason}. Stopped trading.`);
    bLog.scan(limits.reason);
    return [];
  }

  if (!isGoodTradingSession()) {
    const sessionW = await aiLearner.getSessionWeight();
    if (sessionW < 1.2) {
      log('Cascade: Dead zone (UTC 4-5). Skipping.');
      bLog.scan('Dead zone hours. Waiting for volume.');
      return [];
    }
    bLog.ai(`AI override: session weight ${sessionW.toFixed(2)} > 1.2 — scanning in dead zone`);
  }

  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('Failed to fetch tickers'); return []; }

  const BLACKLIST = new Set([
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
    'BASEUSDT','EDGEUSDT',
  ]);

  // Filter out new tokens: need at least 100 15m candles (25 hours of data)
  // New listings have unreliable swing structure

  const topCoins = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !BLACKLIST.has(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, opts.topNCoins || TOP_N_COINS);

  const params = await aiLearner.getOptimalParams();
  const minScore = params.MIN_SCORE || 8;

  bLog.scan(`Cascade scan: ${topCoins.length} coins | 15m→3m→1m | TP=${TP_PCT * 100}% SL=${SL_PCT * 100}%`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      continue;
    }

    const signal = await analyzeLHHL(ticker, params);
    analyzed++;

    if (signal && signal.score >= minScore) {
      results.push(signal);
      bLog.scan(
        `SIGNAL: ${signal.symbol} ${signal.direction} | score=${signal.score} ` +
        `setup=${signal.setupName} | ` +
        `SL=$${signal.sl.toFixed(4)} TP=$${signal.tp1.toFixed(4)} lev=${signal.leverage}x`
      );
    }

    await new Promise(r => setTimeout(r, 200));
  }

  if (skippedAI > 0) bLog.ai(`AI avoided ${skippedAI} coins`);
  bLog.scan(`Scan complete: ${analyzed} analyzed, ${results.length} signals`);

  if (!results.length) {
    bLog.scan('No signals — cascade not aligned on any coin.');
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
