'use strict';

// ═══════════════════════════════════════════════════════════════
//  STRATEGY v4 — VWAP Zone + Dual-TF Structure Confirmation
//
//  Zone rules (daily VWAP with 2σ bands, 15m candles since midnight):
//    Above upper band  → HL = LONG  |  HH = SHORT (reversal)
//    Upper mid zone    → LH = SHORT only
//    Lower mid zone    → HL = LONG only
//    Below lower band  → LH = SHORT  |  LL = LONG (reversal)
//
//  Confirmation: 15m detects structure, 1m must show same direction.
//  Entry: open of next 1m candle after both timeframes confirm.
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const BINANCE_FUTURES_BASE = 'https://fapi.binance.com/fapi/v1';
const FETCH_TIMEOUT_MS = 8_000;
const KLINES_15M_LIMIT = 200;
const KLINES_1M_LIMIT = 60;
const SWING_BARS_EACH_SIDE = 1;

// Capital risk per trade — 25% of margin at the leveraged price distance
const CAPITAL_RISK_FRACTION = 0.25;

const ACTIVE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'ADAUSDT',
  'SOLUSDT',
  'AVAXUSDT',
];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 50,
  ADAUSDT: 50,
  SOLUSDT: 50,
  AVAXUSDT: 50,
};

// ── Kline field indices (Binance futures format) ───────────────
const K_OPEN_TIME = 0;
const K_OPEN      = 1;
const K_HIGH      = 2;
const K_LOW       = 3;
const K_CLOSE     = 4;
const K_VOLUME    = 5;

// ── Fetch ──────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE_FUTURES_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseKline(raw) {
  return {
    openTime: parseInt(raw[K_OPEN_TIME]),
    open:  parseFloat(raw[K_OPEN]),
    high:  parseFloat(raw[K_HIGH]),
    low:   parseFloat(raw[K_LOW]),
    close: parseFloat(raw[K_CLOSE]),
    volume: parseFloat(raw[K_VOLUME]),
  };
}

// ── VWAP calculation ──────────────────────────────────────────
// Returns { vwap, upper, lower, slope } from 15m bars since midnight UTC.

function calcDailyVwap(candles15m) {
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  const todayCandles = candles15m.filter(c => c.openTime >= midnightMs);
  if (todayCandles.length < 2) return null;

  let cumTPV = 0;
  let cumVol = 0;
  let cumTPV2 = 0; // for variance: Σ(tp² × vol)

  for (const c of todayCandles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV  += tp * c.volume;
    cumTPV2 += tp * tp * c.volume;
    cumVol  += c.volume;
  }

  if (cumVol === 0) return null;

  const vwap = cumTPV / cumVol;
  // Population variance of TP weighted by volume
  const variance = (cumTPV2 / cumVol) - (vwap * vwap);
  const stddev = Math.sqrt(Math.max(variance, 0));

  const upper = vwap + 2 * stddev;
  const lower = vwap - 2 * stddev;

  // Slope: compare first-half vwap vs second-half vwap of today's bars
  const mid = Math.floor(todayCandles.length / 2);
  const firstHalf  = todayCandles.slice(0, mid);
  const secondHalf = todayCandles.slice(mid);

  const vwapOf = (bars) => {
    let tv = 0, v = 0;
    for (const c of bars) { const tp = (c.high + c.low + c.close) / 3; tv += tp * c.volume; v += c.volume; }
    return v > 0 ? tv / v : 0;
  };

  const slope = vwapOf(secondHalf) - vwapOf(firstHalf);

  return { vwap, upper, lower, slope };
}

// ── Classify VWAP zone ─────────────────────────────────────────

function classifyZone(price, vwapData) {
  const { vwap, upper, lower } = vwapData;
  if (price > upper)                       return 'ABOVE_UPPER';
  if (price > vwap && price <= upper)      return 'UPPER_MID';
  if (price >= lower && price <= vwap)     return 'LOWER_MID';
  /* price < lower */                      return 'BELOW_LOWER';
}

// ── Swing structure detection ──────────────────────────────────
// Returns arrays of swing highs and lows (price values, not indices).
// Uses 1 bar each side (fast detection).

function detectSwings(candles) {
  const highs = [];
  const lows  = [];

  for (let i = SWING_BARS_EACH_SIDE; i < candles.length - SWING_BARS_EACH_SIDE; i++) {
    const h = candles[i].high;
    const l = candles[i].low;

    if (h > candles[i - 1].high && h > candles[i + 1].high) highs.push(h);
    if (l < candles[i - 1].low  && l < candles[i + 1].low)  lows.push(l);
  }

  return { highs, lows };
}

// ── Structural pattern classification ─────────────────────────
// Needs at least 2 recent swing highs and 2 recent swing lows.
// Returns one of: 'HL', 'LH', 'HH', 'LL', or null.

function classifyStructure(candles) {
  const { highs, lows } = detectSwings(candles);

  // Need at least 2 of each to compare
  const hasHH = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
  const hasLL  = lows.length  >= 2 && lows[lows.length - 1]  < lows[lows.length - 2];
  const hasHL  = lows.length  >= 2 && lows[lows.length - 1]  > lows[lows.length - 2];
  const hasLH  = highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2];

  // Priority: most recent dominant pattern
  if (hasHH && hasHL) return 'HH'; // strong uptrend: both high and low moving up, label by higher high
  if (hasLL && hasLH) return 'LL'; // strong downtrend
  if (hasHL)          return 'HL';
  if (hasLH)          return 'LH';
  if (hasHH)          return 'HH';
  if (hasLL)          return 'LL';

  return null;
}

// ── Zone + structure → signal direction ───────────────────────

function resolveSignal(zone, structure15m, structure1m) {
  if (!structure15m || !structure1m) return null;

  const longConfirmed  = structure1m === 'HL';
  const shortConfirmed = structure1m === 'LH';

  switch (zone) {
    case 'ABOVE_UPPER':
      if (structure15m === 'HL' && longConfirmed)  return 'LONG';
      if (structure15m === 'HH' && shortConfirmed) return 'SHORT';
      break;
    case 'UPPER_MID':
      if (structure15m === 'LH' && shortConfirmed) return 'SHORT';
      break;
    case 'LOWER_MID':
      if (structure15m === 'HL' && longConfirmed)  return 'LONG';
      break;
    case 'BELOW_LOWER':
      if (structure15m === 'LH' && shortConfirmed) return 'SHORT';
      if (structure15m === 'LL' && longConfirmed)  return 'LONG';
      break;
  }

  return null;
}

// ── Stop-loss calculation ──────────────────────────────────────
// 25% capital risk → price SL distance = CAPITAL_RISK_FRACTION / leverage

function calcSL(price, direction, leverage) {
  const slDistanceFraction = CAPITAL_RISK_FRACTION / leverage;
  if (direction === 'LONG')  return price * (1 - slDistanceFraction);
  if (direction === 'SHORT') return price * (1 + slDistanceFraction);
  return null;
}

// ── Signal score (0–100) ───────────────────────────────────────
// Higher score = stronger confluence.

function calcScore(zone, structure15m, structure1m, vwapData) {
  let score = 50; // base

  // Zone extremes get bonus (reversal setups have edge from OB/OS)
  if (zone === 'ABOVE_UPPER' || zone === 'BELOW_LOWER') score += 10;

  // VWAP slope alignment with direction adds confidence
  if (structure15m === 'HL' && vwapData.slope > 0) score += 15;
  if (structure15m === 'LH' && vwapData.slope < 0) score += 15;

  // Both timeframes agree on reversal structure
  if (structure15m === structure1m) score += 10;

  return Math.min(score, 100);
}

// ── Single-symbol scan ─────────────────────────────────────────

async function scanSymbol(symbol) {
  const [raw15m, raw1m] = await Promise.all([
    fetchKlines(symbol, '15m', KLINES_15M_LIMIT),
    fetchKlines(symbol, '1m',  KLINES_1M_LIMIT),
  ]);

  if (!raw15m || !raw1m || raw15m.length < 32 || raw1m.length < 10) return null;

  const candles15m = raw15m.map(parseKline);
  const candles1m  = raw1m.map(parseKline);

  const vwapData = calcDailyVwap(candles15m);
  if (!vwapData) return null;

  // Use last closed candle for price reference (exclude in-progress bar)
  const lastClosed15m = candles15m[candles15m.length - 2];
  const lastClosed1m  = candles1m[candles1m.length - 2];
  const price = lastClosed1m.close;

  const zone = classifyZone(price, vwapData);

  // Structure on last 32 x 15m bars, last 30 x 1m bars
  const structure15m = classifyStructure(candles15m.slice(-32));
  const structure1m  = classifyStructure(candles1m.slice(-30));

  const direction = resolveSignal(zone, structure15m, structure1m);
  if (!direction) return null;

  const leverage = SYMBOL_LEVERAGE[symbol] ?? 50;

  // Entry: open of the NEXT 1m candle (current in-progress bar)
  const entry = candles1m[candles1m.length - 1].open;
  const sl    = calcSL(entry, direction, leverage);
  const score = calcScore(zone, structure15m, structure1m, vwapData);

  const setupName = `V4-${zone}-${structure15m}`;
  const reason    = `Zone=${zone} | 15m=${structure15m} | 1m=${structure1m} | VWAP=${vwapData.vwap.toFixed(2)}`;

  return {
    symbol,
    direction,
    entry,
    sl,
    setupName,
    score,
    reason,
    zone,
    tf15mStruct: structure15m,
    tf1mStruct:  structure1m,
  };
}

// ── Public API ─────────────────────────────────────────────────

async function scanV4(symbols = ACTIVE_SYMBOLS, log = console.log) {
  const signals = [];

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const signal = await scanSymbol(symbol);
        if (signal) {
          log(`[V4] ${symbol} → ${signal.direction} | ${signal.reason}`);
          signals.push(signal);
        }
      } catch (err) {
        log(`[V4] ${symbol} error: ${err.message}`);
      }
    })
  );

  return signals;
}

module.exports = { scanV4, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE };
