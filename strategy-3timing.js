'use strict';
// ════════════════════════════════════════════════════════════════
//  strategy-3timing.js  —  VWAP + H1 + H1-micro
//
//  Direction filter: Daily VWAP
//    Price above VWAP → uptrend  → LONG only
//    Price below VWAP → downtrend → SHORT only
//
//  Entry confirmation (2 tiers):
//    Tier 1 — H1 48-bar range bias agrees with VWAP direction
//    Tier 2 — H1 micro 16-bar (HL for long / LH for short)
//
//  SL / Trail (user's exact spec):
//    Initial SL : -25% cap from entry
//    At +30% cap: SL moves to +10% profit lock
//    At +46% cap: main trail — lock +45%, step +10% per +11%
// ════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const REQUEST_TIMEOUT = 15_000;

// ── Symbol config ─────────────────────────────────────────────
const ACTIVE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'AVAXUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT:  75,
  ADAUSDT:  75,
  SOLUSDT:  50,
  AVAXUSDT: 50,
};

// ── SL / trail constants ──────────────────────────────────────
const INITIAL_SL_CAP   = 0.25;
const LOCK_TRIGGER_CAP = 0.30;
const LOCK_PROFIT_CAP  = 0.10;
const TRAIL_ON_CAP     = 0.46;
const TRAIL_FIRST_LOCK = 0.45;
const TRAIL_STEP_GAIN  = 0.11;
const TRAIL_STEP_LOCK  = 0.10;

// ── Structure window sizes ────────────────────────────────────
const H1_CURR  = 48;  // H1 bars for intermediate bias
const H1_MICRO = 16;  // H1 bars for micro bias (HL / LH entry)

// ── Binance futures klines ────────────────────────────────────
async function fetchKlines(symbol, interval, limit) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (res.ok) return res.json();
    } catch (_) {}
    if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

// ── Daily VWAP from today's H1 bars ──────────────────────────
// Price above VWAP = uptrend. Price below = downtrend.
function calcDailyVWAP(h1Klines) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const todayBars = h1Klines.filter(k => parseInt(k[0]) >= todayMs);
  // Fallback: use last 8 bars if today hasn't enough data yet (e.g. early UTC)
  const bars = todayBars.length >= 2 ? todayBars : h1Klines.slice(-8);

  let cumTPV = 0, cumVol = 0;
  for (const k of bars) {
    const tp  = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
    const vol = parseFloat(k[5]) || 1;
    cumTPV += tp * vol;
    cumVol += vol;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ── Range-comparison bias ─────────────────────────────────────
// Splits bars into recent half vs earlier half, compares high/low ranges.
// Works in strong trends where pivot detection would return 'neutral'.
function getRangeBias(bars) {
  if (!bars || bars.length < 4) return 'neutral';
  const half    = Math.floor(bars.length / 2);
  const earlier = bars.slice(0, half);
  const recent  = bars.slice(half);
  const eH = Math.max(...earlier.map(b => b.high));
  const eL = Math.min(...earlier.map(b => b.low));
  const rH = Math.max(...recent.map(b => b.high));
  const rL = Math.min(...recent.map(b => b.low));
  if (rH > eH && rL > eL) return 'bullish';
  if (rH < eH && rL < eL) return 'bearish';
  // Tiebreak: close direction
  if (recent.at(-1).close > earlier.at(-1).close) return 'bullish';
  if (recent.at(-1).close < earlier.at(-1).close) return 'bearish';
  return 'neutral';
}

// ── Trail SL ─────────────────────────────────────────────────
function calcTrail3Timing(entryPrice, currentPrice, side, leverage) {
  const pricePct = side === 'LONG'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  const capPct = pricePct * leverage;

  if (capPct >= TRAIL_ON_CAP - 0.0001) {
    const steps   = Math.floor((capPct - TRAIL_ON_CAP) / TRAIL_STEP_GAIN);
    const lockCap = TRAIL_FIRST_LOCK + steps * TRAIL_STEP_LOCK;
    const slPct   = lockCap / leverage;
    return side === 'LONG' ? entryPrice * (1 + slPct) : entryPrice * (1 - slPct);
  }
  if (capPct >= LOCK_TRIGGER_CAP) {
    const slPct = LOCK_PROFIT_CAP / leverage;
    return side === 'LONG' ? entryPrice * (1 + slPct) : entryPrice * (1 - slPct);
  }
  const slPct = INITIAL_SL_CAP / leverage;
  return side === 'LONG' ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
}

// ── Analyze one symbol ────────────────────────────────────────
async function analyzeSymbol(symbol, log) {
  const lev = SYMBOL_LEVERAGE[symbol] || 50;

  const h1Klines = await fetchKlines(symbol, '1h', H1_CURR + 30);
  if (!h1Klines || h1Klines.length < H1_CURR + 4) {
    log(`3-timing: ${symbol} — insufficient data (${h1Klines?.length ?? 0} bars)`);
    return null;
  }

  // ── Direction: VWAP ──────────────────────────────────────────
  const vwap  = calcDailyVWAP(h1Klines);
  if (!vwap) return null;

  const price = parseFloat(h1Klines.at(-1)[4]); // last H1 close
  const vwapDir = price > vwap ? 'bullish' : price < vwap ? 'bearish' : null;
  if (!vwapDir) return null;

  const h1Bars = h1Klines.map(k => ({
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));

  // ── Tier 1: H1 48-bar range bias must agree with VWAP ────────
  const h1Bias = getRangeBias(h1Bars.slice(-H1_CURR - 1, -1));
  if (h1Bias !== vwapDir) return null;

  // ── Tier 2: H1 micro 16-bar (HL for long / LH for short) ────
  const micBias = getRangeBias(h1Bars.slice(-H1_MICRO - 1, -1));
  if (micBias !== vwapDir) return null;

  // ── All aligned → signal ──────────────────────────────────────
  const side  = vwapDir === 'bullish' ? 'LONG' : 'SHORT';
  const slPct = INITIAL_SL_CAP / lev;
  const sl    = side === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);

  return {
    symbol,
    lastPrice:  price,
    signal:     side === 'LONG' ? 'BUY' : 'SELL',
    side,
    direction:  side,
    entry:      price,
    sl,
    slPct:      (INITIAL_SL_CAP * 100).toFixed(2),
    setupName:  'VWAP+H1+H1m',
    score:      3,
    tp1: null, tp2: null, tp3: null,
    vwap:    vwap.toFixed(4),
    vwapDir, h1Bias, micBias,
    timeframe: 'vwap+1h+1h-micro',
    version:   '3timing-vwap',
  };
}

// ── Main scan ─────────────────────────────────────────────────
async function scan3Timing(log = console.log) {
  const results = [];

  for (const symbol of ACTIVE_SYMBOLS) {
    try {
      const sig = await analyzeSymbol(symbol, log);
      if (sig) {
        results.push(sig);
        log(`3-timing: ✓ ${symbol} ${sig.side} | VWAP=${sig.vwapDir} price=$${sig.entry.toFixed(2)} vwap=$${sig.vwap}`);
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      log(`3-timing: ${symbol} — error: ${e.message}`);
    }
  }

  log(`3-timing: scan complete — ${results.length} signal(s)`);
  return results;
}

function getSessionMode() { return 'always'; }

module.exports = {
  ACTIVE_SYMBOLS,
  SYMBOL_LEVERAGE,
  scan3Timing,
  calcTrail3Timing,
  getSessionMode,
};
