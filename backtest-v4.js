'use strict';
// Bypass ISP SSL interception for Binance API (backtest only, never in prod)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ═══════════════════════════════════════════════════════════════
//  BACKTEST v4 — Replay 3 days of 1m + 15m klines for 6 symbols
//
//  Run with: node backtest-v4.js
//
//  Each 1m candle:
//    1. Recalculate daily VWAP from 15m bars since midnight
//    2. Check V4 signal on last 32 x 15m + last 30 x 1m
//    3. Entry at open of NEXT 1m candle
//    4. Trail SL through tiers; close when SL hit
//
//  Starting capital: $1000 | 10% per trade | leverage per symbol
// ═══════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────

// Use spot API as fallback — OHLCV data is identical to futures for backtesting
const BINANCE_FUTURES_BASE = 'https://api.binance.com/api/v3';
const FETCH_TIMEOUT_MS     = 10_000;
const BACKTEST_DAYS        = 3;
const STARTING_CAPITAL     = 1_000;
const TRADE_CAPITAL_FRAC   = 0.10;   // 10% of wallet per trade
const CAPITAL_RISK_FRAC    = 0.25;   // 25% of margin as initial SL distance
const SWING_BARS_EACH_SIDE = 1;

const CANDLES_15M_FOR_STRUCT = 32;
const CANDLES_1M_FOR_STRUCT  = 30;

const ACTIVE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'ADAUSDT',
  'SOLUSDT',
  'AVAXUSDT',
];

const SYMBOL_LEVERAGE = {
  BTCUSDT:  100,
  ETHUSDT:  100,
  BNBUSDT:   50,
  ADAUSDT:   50,
  SOLUSDT:   50,
  AVAXUSDT:  50,
};

// ── Trailing SL tier definitions ───────────────────────────────
// Format: [triggerPct, lockPct] — capital % thresholds (e.g. 46 = +46% profit)

// Safety tier: lock in +10% when +20% is hit (both leverage tiers)
const SAFETY_TIER = [20, 10];

const TRAILING_TIERS_100X = [
  [46, 45], [51, 50], [61, 60], [71, 70],
  [81, 80], [91, 90], [101, 100], [111, 110],
  [121, 120], [151, 150], [201, 200], [301, 300],
];

const TRAILING_TIERS_50X = [
  [21, 20], [31, 30], [38, 35], [49, 45],
  [60, 55], [71, 65], [82, 75], [93, 85],
  [104, 95],
];

// ── Kline field indices (Binance futures) ──────────────────────
const K_OPEN_TIME = 0;
const K_OPEN      = 1;
const K_HIGH      = 2;
const K_LOW       = 3;
const K_CLOSE     = 4;
const K_VOLUME    = 5;

// ── Fetch helpers ──────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE_FUTURES_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Fetch enough bars for BACKTEST_DAYS of data.
// 1m: 1440 bars/day; 15m: 96 bars/day
async function fetchHistoricalKlines(symbol, interval) {
  const barsPerDay = interval === '1m' ? 1_440 : 96;
  const limit = barsPerDay * BACKTEST_DAYS + 200; // buffer for VWAP warmup
  return fetchKlines(symbol, interval, Math.min(limit, 1_500));
}

function parseKlineSimple(raw) {
  return {
    openTime: parseInt(raw[K_OPEN_TIME]),
    open:     parseFloat(raw[K_OPEN]),
    high:     parseFloat(raw[K_HIGH]),
    low:      parseFloat(raw[K_LOW]),
    close:    parseFloat(raw[K_CLOSE]),
    volume:   parseFloat(raw[K_VOLUME]),
  };
}

// ── VWAP calculation (same logic as strategy-v4.js) ───────────

function calcDailyVwap(candles15m, asOfMs) {
  const midnight = new Date(asOfMs);
  midnight.setUTCHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  const todayCandles = candles15m.filter(c => c.openTime >= midnightMs && c.openTime < asOfMs);
  if (todayCandles.length < 2) return null;

  let cumTPV  = 0;
  let cumTPV2 = 0;
  let cumVol  = 0;

  for (const c of todayCandles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV  += tp * c.volume;
    cumTPV2 += tp * tp * c.volume;
    cumVol  += c.volume;
  }

  if (cumVol === 0) return null;

  const vwap    = cumTPV / cumVol;
  const variance = (cumTPV2 / cumVol) - (vwap * vwap);
  const stddev  = Math.sqrt(Math.max(variance, 0));

  const upper = vwap + 2 * stddev;
  const lower = vwap - 2 * stddev;

  const mid       = Math.floor(todayCandles.length / 2);
  const vwapOf    = (bars) => {
    let tv = 0, v = 0;
    for (const c of bars) { const tp = (c.high + c.low + c.close) / 3; tv += tp * c.volume; v += c.volume; }
    return v > 0 ? tv / v : 0;
  };
  const slope = vwapOf(todayCandles.slice(mid)) - vwapOf(todayCandles.slice(0, mid));

  return { vwap, upper, lower, slope };
}

function classifyZone(price, vwapData) {
  const { vwap, upper, lower } = vwapData;
  if (price > upper)                   return 'ABOVE_UPPER';
  if (price > vwap && price <= upper)  return 'UPPER_MID';
  if (price >= lower && price <= vwap) return 'LOWER_MID';
  return 'BELOW_LOWER';
}

// ── Swing structure detection ──────────────────────────────────

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

function classifyStructure(candles) {
  const { highs, lows } = detectSwings(candles);

  const hasHH = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
  const hasLL  = lows.length  >= 2 && lows[lows.length - 1]  < lows[lows.length - 2];
  const hasHL  = lows.length  >= 2 && lows[lows.length - 1]  > lows[lows.length - 2];
  const hasLH  = highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2];

  if (hasHH && hasHL) return 'HH';
  if (hasLL && hasLH) return 'LL';
  if (hasHL)          return 'HL';
  if (hasLH)          return 'LH';
  if (hasHH)          return 'HH';
  if (hasLL)          return 'LL';

  return null;
}

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

// ── Stop-loss ─────────────────────────────────────────────────

function calcInitialSL(entry, direction, leverage) {
  const dist = CAPITAL_RISK_FRAC / leverage;
  return direction === 'LONG'
    ? entry * (1 - dist)
    : entry * (1 + dist);
}

// ── Position management ────────────────────────────────────────
// Returns updated SL price after checking trailing tiers.
// currentProfitPct = profit as % of margin (e.g. 46 = 46%).

function applyTrailingTiers(entry, direction, leverage, slPrice, margin, currentProfitPct) {
  const tiers = leverage >= 100 ? TRAILING_TIERS_100X : TRAILING_TIERS_50X;

  // Safety tier first
  if (currentProfitPct >= SAFETY_TIER[0]) {
    const safetyLockPct = SAFETY_TIER[1];
    const safetySlPrice = direction === 'LONG'
      ? entry * (1 + safetyLockPct / 100 / leverage)
      : entry * (1 - safetyLockPct / 100 / leverage);

    if (direction === 'LONG'  && safetySlPrice > slPrice) slPrice = safetySlPrice;
    if (direction === 'SHORT' && safetySlPrice < slPrice) slPrice = safetySlPrice;
  }

  // Main trailing tiers
  for (const [trigger, lock] of tiers) {
    if (currentProfitPct >= trigger) {
      const lockedSL = direction === 'LONG'
        ? entry * (1 + lock / 100 / leverage)
        : entry * (1 - lock / 100 / leverage);

      if (direction === 'LONG'  && lockedSL > slPrice) slPrice = lockedSL;
      if (direction === 'SHORT' && lockedSL < slPrice) slPrice = lockedSL;
    }
  }

  return slPrice;
}

function calcProfitPct(entry, price, direction, leverage) {
  const priceDelta = direction === 'LONG'
    ? (price - entry) / entry
    : (entry - price) / entry;
  return priceDelta * leverage * 100;
}

function isSLHit(candle, direction, slPrice) {
  if (direction === 'LONG')  return candle.low  <= slPrice;
  if (direction === 'SHORT') return candle.high >= slPrice;
  return false;
}

// ── Per-symbol backtest ────────────────────────────────────────

function backtestSymbol(symbol, candles1m, candles15m) {
  const leverage = SYMBOL_LEVERAGE[symbol] ?? 50;
  const trades   = [];

  let position = null; // null = flat

  // Walk each 1m candle (skip first 100 for warmup)
  for (let i = 100; i < candles1m.length - 1; i++) {
    const currentCandle = candles1m[i];
    const nextCandle    = candles1m[i + 1];
    const nowMs         = currentCandle.openTime;

    // ── Manage open position ─────────────────────────────────
    if (position) {
      const { entry, direction, sl: prevSL, margin, entryIndex } = position;
      const profitPct = calcProfitPct(entry, currentCandle.close, direction, leverage);
      const newSL = applyTrailingTiers(entry, direction, leverage, prevSL, margin, profitPct);
      position.sl = newSL;

      if (isSLHit(currentCandle, direction, newSL)) {
        // Close at SL price
        const closePrice = newSL;
        const pnlPct     = calcProfitPct(entry, closePrice, direction, leverage);
        const pnlDollar  = margin * pnlPct / 100;
        const durationMin = (currentCandle.openTime - candles1m[entryIndex].openTime) / 60_000;

        trades.push({
          symbol,
          direction: position.direction,
          entry,
          closePrice,
          pnlPct,
          pnlDollar,
          durationMin,
          win: pnlPct > 0,
        });

        position = null;
      }

      if (position) continue; // still in position, skip signal check
    }

    // ── Signal check ─────────────────────────────────────────
    // Collect 15m bars up to this 1m candle's openTime
    const bars15m = candles15m.filter(c => c.openTime < nowMs);
    if (bars15m.length < CANDLES_15M_FOR_STRUCT + 4) continue;

    const vwapData = calcDailyVwap(bars15m, nowMs);
    if (!vwapData) continue;

    const price = currentCandle.close;
    const zone  = classifyZone(price, vwapData);

    const slice15m = bars15m.slice(-CANDLES_15M_FOR_STRUCT);
    const slice1m  = candles1m.slice(Math.max(0, i - CANDLES_1M_FOR_STRUCT + 1), i + 1);

    const struct15m = classifyStructure(slice15m);
    const struct1m  = classifyStructure(slice1m);
    const direction = resolveSignal(zone, struct15m, struct1m);

    if (!direction) continue;

    // Entry at open of NEXT 1m candle
    const entry  = nextCandle.open;
    const sl     = calcInitialSL(entry, direction, leverage);
    const margin = STARTING_CAPITAL * TRADE_CAPITAL_FRAC; // fixed $100 margin slice

    position = {
      symbol,
      direction,
      entry,
      sl,
      margin,
      entryIndex: i + 1,
    };
  }

  // Force-close any open position at last candle close
  if (position) {
    const lastCandle  = candles1m[candles1m.length - 1];
    const closePrice  = lastCandle.close;
    const pnlPct      = calcProfitPct(position.entry, closePrice, position.direction, leverage);
    const pnlDollar   = position.margin * pnlPct / 100;
    const durationMin = (lastCandle.openTime - candles1m[position.entryIndex].openTime) / 60_000;

    trades.push({
      symbol,
      direction: position.direction,
      entry: position.entry,
      closePrice,
      pnlPct,
      pnlDollar,
      durationMin,
      win: pnlPct > 0,
    });
  }

  return trades;
}

// ── Report helpers ─────────────────────────────────────────────

function printSymbolReport(symbol, trades) {
  if (trades.length === 0) {
    console.log(`  ${symbol}: no trades`);
    return;
  }
  const wins   = trades.filter(t => t.win).length;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlDollar, 0);
  const winRate  = ((wins / trades.length) * 100).toFixed(1);
  console.log(`  ${symbol}: ${trades.length} trades | ${wins}W/${trades.length - wins}L | WR ${winRate}% | PnL $${totalPnl.toFixed(2)}`);
}

function printFullReport(allTrades) {
  const wins      = allTrades.filter(t => t.win);
  const losses    = allTrades.filter(t => !t.win);
  const totalPnl  = allTrades.reduce((sum, t) => sum + t.pnlDollar, 0);
  const pnlPct    = (totalPnl / STARTING_CAPITAL * 100).toFixed(2);
  const winRate   = allTrades.length > 0 ? ((wins.length / allTrades.length) * 100).toFixed(1) : '0';
  const avgDur    = allTrades.length > 0
    ? (allTrades.reduce((sum, t) => sum + t.durationMin, 0) / allTrades.length).toFixed(1)
    : '0';

  const bestTrade  = allTrades.reduce((best, t) => (!best || t.pnlDollar > best.pnlDollar) ? t : best, null);
  const worstTrade = allTrades.reduce((worst, t) => (!worst || t.pnlDollar < worst.pnlDollar) ? t : worst, null);

  console.log('\n══════════════════════════════════════════════════');
  console.log('  BACKTEST v4 — RESULTS SUMMARY');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Period  : ${BACKTEST_DAYS} days`);
  console.log(`  Capital : $${STARTING_CAPITAL} | 10% per trade | trailing SL`);
  console.log('──────────────────────────────────────────────────');
  console.log(`  Total trades : ${allTrades.length}`);
  console.log(`  Wins         : ${wins.length}`);
  console.log(`  Losses       : ${losses.length}`);
  console.log(`  Win rate     : ${winRate}%`);
  console.log(`  Net P&L      : $${totalPnl.toFixed(2)} (${pnlPct}% of $${STARTING_CAPITAL})`);
  console.log(`  Avg duration : ${avgDur} minutes`);

  if (bestTrade) {
    console.log(`  Best trade   : ${bestTrade.symbol} ${bestTrade.direction} +$${bestTrade.pnlDollar.toFixed(2)} (${bestTrade.pnlPct.toFixed(1)}%)`);
  }
  if (worstTrade) {
    console.log(`  Worst trade  : ${worstTrade.symbol} ${worstTrade.direction} $${worstTrade.pnlDollar.toFixed(2)} (${worstTrade.pnlPct.toFixed(1)}%)`);
  }

  console.log('\n  Per-symbol breakdown:');
  const bySymbol = {};
  for (const t of allTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }
  for (const symbol of ACTIVE_SYMBOLS) {
    printSymbolReport(symbol, bySymbol[symbol] || []);
  }

  console.log('══════════════════════════════════════════════════\n');
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log(`\n[backtest-v4] Fetching ${BACKTEST_DAYS} days of klines for ${ACTIVE_SYMBOLS.length} symbols...\n`);

  const symbolData = {};

  for (const symbol of ACTIVE_SYMBOLS) {
    process.stdout.write(`[${symbol}] fetching...`);
    try {
      const [raw1m, raw15m] = await Promise.all([
        fetchHistoricalKlines(symbol, '1m'),
        fetchHistoricalKlines(symbol, '15m'),
      ]);

      const candles1m  = raw1m.map(parseKlineSimple);
      const candles15m = raw15m.map(parseKlineSimple);

      process.stdout.write(` ${candles1m.length} x 1m | ${candles15m.length} x 15m loaded\n`);
      symbolData[symbol] = { candles1m, candles15m };
    } catch (err) {
      process.stdout.write(` ERROR: ${err.message}\n`);
    }
  }

  console.log('\n[backtest-v4] Replaying candles...\n');

  const allTrades = [];

  for (const symbol of ACTIVE_SYMBOLS) {
    if (!symbolData[symbol]) continue;

    const { candles1m, candles15m } = symbolData[symbol];
    const trades = backtestSymbol(symbol, candles1m, candles15m);
    allTrades.push(...trades);

    const wins = trades.filter(t => t.win).length;
    console.log(`[${symbol}] done — ${trades.length} trades, ${wins} wins`);
  }

  printFullReport(allTrades);
}

main().catch(err => {
  console.error('[backtest-v4] Fatal error:', err.message);
  process.exit(1);
});
