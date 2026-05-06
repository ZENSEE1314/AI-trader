'use strict';

// ═══════════════════════════════════════════════════════════════
//  BACKTEST v4 — Replay 3 days of 1m + 15m klines for 6 symbols
//  Uses Bybit public API (not Binance — avoids ISP filtering)
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

// Bybit v5 public API — OHLCV identical to Binance for backtesting purposes
const BYBIT_BASE       = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS = 10_000;
const BACKTEST_DAYS    = 3;
const STARTING_CAPITAL     = 1_000;
const TRADE_CAPITAL_FRAC   = 0.10;   // 10% of wallet per trade
const CAPITAL_RISK_FRAC    = 0.25;   // 25% of margin as initial SL distance

const SMC_WARMUP_BARS = 150; // bars to skip before trading (SMC needs history)

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

// ── Fetch helpers (Bybit v5) ───────────────────────────────────
// Bybit interval names: "1" = 1m, "15" = 15m
// Bybit returns rows newest-first: [startTime, open, high, low, close, volume, turnover]
// Max 200 per call; we page backwards to collect BACKTEST_DAYS of data.

function bybitInterval(interval) {
  return interval === '1m' ? '1' : '15';
}

async function fetchBybitPage(symbol, interval, endMs) {
  const params = new URLSearchParams({
    category: 'linear',
    symbol,
    interval: bybitInterval(interval),
    limit:    '200',
    end:      String(endMs),
  });
  const url = `${BYBIT_BASE}?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit error ${json.retCode}: ${json.retMsg}`);
    return json.result.list; // newest-first array of string arrays
  } finally {
    clearTimeout(timer);
  }
}

// Fetch enough bars for BACKTEST_DAYS of data by paging backwards.
// 1m: 1440 bars/day; 15m: 96 bars/day
async function fetchHistoricalKlines(symbol, interval) {
  const barsPerDay  = interval === '1m' ? 1_440 : 96;
  const targetBars  = barsPerDay * BACKTEST_DAYS + 200; // buffer for VWAP warmup
  const allRows     = [];
  let   endMs       = Date.now();

  while (allRows.length < targetBars) {
    const page = await fetchBybitPage(symbol, interval, endMs);
    if (!page || page.length === 0) break;

    // page is newest-first; oldest entry is last
    allRows.push(...page);
    const oldestTime = parseInt(page[page.length - 1][0]);
    endMs = oldestTime - 1; // next page ends just before oldest

    if (page.length < 200) break; // no more data
    await new Promise(r => setTimeout(r, 100)); // be polite to API
  }

  // Sort oldest-first (Bybit returns newest-first)
  allRows.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  return allRows.slice(-targetBars); // keep most recent targetBars
}

function parseKlineSimple(raw) {
  // Bybit row: [startTime, open, high, low, close, volume, turnover]
  return {
    openTime: parseInt(raw[0]),
    open:     parseFloat(raw[1]),
    high:     parseFloat(raw[2]),
    low:      parseFloat(raw[3]),
    close:    parseFloat(raw[4]),
    volume:   parseFloat(raw[5]),
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

// ── SMC Structure Engine (ported from LuxAlgo Smart Money Concepts) ──
// Detects BOS (Break of Structure) and CHoCH (Change of Character)
// using the same pivot-tracking + crossover logic as LuxAlgo Pine Script.
//
// Two levels:
//   internal (size=5)  — faster, triggers first, 1m confirmation
//   swing    (size=50) — slower, filters noise, trend bias

const INTERNAL_SIZE = 5;
const SWING_SIZE    = 50;

// Creates a fresh SMC state object for one symbol.
// Call stepSMC() on every candle in order; it returns signals.
function createSMCState() {
  return {
    // Internal structure state
    intLeg:       null, // 'BULL' | 'BEAR'
    intPivHigh:   null, // { price, crossed }
    intPivLow:    null,
    intTrend:     0,    // +1 bullish, -1 bearish

    // Swing structure state
    swLeg:        null,
    swPivHigh:    null,
    swPivLow:     null,
    swTrend:      0,
  };
}

// Detects leg changes at candle index `i` using the LuxAlgo leg() logic:
//   newLegHigh = candle[i-size].high > max(candle[i-size+1 .. i].high)  → BEAR leg
//   newLegLow  = candle[i-size].low  < min(candle[i-size+1 .. i].low)   → BULL leg
// Returns: { newBull, newBear, pivotHigh, pivotLow }
function detectLegChange(candles, i, size) {
  if (i < size) return null;

  const pivot = candles[i - size];
  let recentHigh = -Infinity;
  let recentLow  =  Infinity;

  for (let j = 0; j < size; j++) {
    const c = candles[i - j];
    if (c.high > recentHigh) recentHigh = c.high;
    if (c.low  < recentLow)  recentLow  = c.low;
  }

  return {
    newBear:    pivot.high > recentHigh, // candle[i-size] is swing high → start of bearish leg
    newBull:    pivot.low  < recentLow,  // candle[i-size] is swing low  → start of bullish leg
    pivotHigh:  pivot.high,
    pivotLow:   pivot.low,
  };
}

// Advances SMC state by one candle.
// Returns { bos: 'LONG'|'SHORT'|null, choch: 'LONG'|'SHORT'|null }
function stepSMC(state, candles, i) {
  const close = candles[i].close;

  // ── Internal structure (size=5) ──────────────────────────────
  const intLeg = detectLegChange(candles, i, INTERNAL_SIZE);
  let intSignal = null;

  if (intLeg) {
    if (intLeg.newBear && state.intLeg !== 'BEAR') {
      state.intLeg = 'BEAR';
      state.intPivHigh = { price: intLeg.pivotHigh, crossed: false };
    } else if (intLeg.newBull && state.intLeg !== 'BULL') {
      state.intLeg = 'BULL';
      state.intPivLow = { price: intLeg.pivotLow, crossed: false };
    }
  }

  // Crossover of internal pivot high → bullish BOS or CHoCH
  if (state.intPivHigh && !state.intPivHigh.crossed && close > state.intPivHigh.price) {
    state.intPivHigh.crossed = true;
    intSignal = state.intTrend === -1 ? 'CHOCH_LONG' : 'BOS_LONG';
    state.intTrend = 1;
  }
  // Crossunder of internal pivot low → bearish BOS or CHoCH
  if (state.intPivLow && !state.intPivLow.crossed && close < state.intPivLow.price) {
    state.intPivLow.crossed = true;
    intSignal = state.intTrend === 1 ? 'CHOCH_SHORT' : 'BOS_SHORT';
    state.intTrend = -1;
  }

  // ── Swing structure (size=50) ─────────────────────────────────
  const swLeg = detectLegChange(candles, i, SWING_SIZE);
  let swSignal = null;

  if (swLeg) {
    if (swLeg.newBear && state.swLeg !== 'BEAR') {
      state.swLeg = 'BEAR';
      state.swPivHigh = { price: swLeg.pivotHigh, crossed: false };
    } else if (swLeg.newBull && state.swLeg !== 'BULL') {
      state.swLeg = 'BULL';
      state.swPivLow = { price: swLeg.pivotLow, crossed: false };
    }
  }

  if (state.swPivHigh && !state.swPivHigh.crossed && close > state.swPivHigh.price) {
    state.swPivHigh.crossed = true;
    swSignal = state.swTrend === -1 ? 'CHOCH_LONG' : 'BOS_LONG';
    state.swTrend = 1;
  }
  if (state.swPivLow && !state.swPivLow.crossed && close < state.swPivLow.price) {
    state.swPivLow.crossed = true;
    swSignal = state.swTrend === 1 ? 'CHOCH_SHORT' : 'BOS_SHORT';
    state.swTrend = -1;
  }

  return { intSignal, swSignal };
}

// ── Signal resolution: SMC + VWAP zone ────────────────────────
// Priority: internal CHoCH (reversal) > swing BOS (continuation)
// VWAP zone acts as a filter — prevents longs in free-fall, shorts in parabolic

function resolveSignal(intSignal, swSignal, zone) {
  // Internal CHoCH — highest priority (reversal entry)
  if (intSignal === 'CHOCH_LONG' && zone !== 'ABOVE_UPPER')  return 'LONG';
  if (intSignal === 'CHOCH_SHORT' && zone !== 'BELOW_LOWER') return 'SHORT';

  // Swing CHoCH — strong reversal
  if (swSignal === 'CHOCH_LONG' && zone !== 'ABOVE_UPPER')   return 'LONG';
  if (swSignal === 'CHOCH_SHORT' && zone !== 'BELOW_LOWER')  return 'SHORT';

  // BOS — continuation, only trade with VWAP direction
  if (intSignal === 'BOS_LONG' && (zone === 'LOWER_MID' || zone === 'UPPER_MID' || zone === 'ABOVE_UPPER')) return 'LONG';
  if (intSignal === 'BOS_SHORT' && (zone === 'UPPER_MID' || zone === 'LOWER_MID' || zone === 'BELOW_LOWER')) return 'SHORT';

  return null;

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
  const leverage  = SYMBOL_LEVERAGE[symbol] ?? 50;
  const trades    = [];

  let position    = null; // null = flat

  // SMC state is stateful per symbol — mirrors LuxAlgo's var declarations
  const smc1m  = createSMCState(); // 1m chart structure (internal size=5, swing size=50)
  const smc15m = createSMCState(); // 15m chart structure (replayed bar-by-bar)

  // Pointer into candles15m; tracks last signal seen from 15m timeframe
  let smc15mIdx        = 0;
  let last15mIntSignal = null; // last internal signal from 15m (resets after use)
  let last15mSwSignal  = null; // last swing signal from 15m

  // Walk each 1m candle (skip first 150 for SMC warmup)
  for (let i = 150; i < candles1m.length - 1; i++) {
    const currentCandle = candles1m[i];
    const nextCandle    = candles1m[i + 1];
    const nowMs         = currentCandle.openTime;

    // ── Advance 15m SMC state up to current 1m bar ───────────
    while (smc15mIdx < candles15m.length && candles15m[smc15mIdx].openTime < nowMs) {
      const { intSignal, swSignal } = stepSMC(smc15m, candles15m, smc15mIdx);
      if (intSignal) last15mIntSignal = intSignal;
      if (swSignal)  last15mSwSignal  = swSignal;
      smc15mIdx++;
    }

    // ── Step 1m SMC ──────────────────────────────────────────
    const { intSignal: int1m, swSignal: sw1m } = stepSMC(smc1m, candles1m, i);

    // ── Manage open position ─────────────────────────────────
    if (position) {
      const { entry, direction, sl: prevSL, margin, entryIndex } = position;
      const profitPct = calcProfitPct(entry, currentCandle.close, direction, leverage);
      const newSL = applyTrailingTiers(entry, direction, leverage, prevSL, margin, profitPct);
      position.sl = newSL;

      if (isSLHit(currentCandle, direction, newSL)) {
        const closePrice  = newSL;
        const pnlPct      = calcProfitPct(entry, closePrice, direction, leverage);
        const pnlDollar   = margin * pnlPct / 100;
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

      if (position) continue; // still in trade, skip signal check
    }

    // ── Signal check ─────────────────────────────────────────
    // Need enough 15m bars for VWAP calculation
    const bars15m = candles15m.slice(0, smc15mIdx);
    if (bars15m.length < 10) continue;

    const vwapData = calcDailyVwap(bars15m, nowMs);
    if (!vwapData) continue;

    const price = currentCandle.close;
    const zone  = classifyZone(price, vwapData);

    // ── Combine 15m + 1m signals with VWAP zone filter ─────────
    // Priority 1: 15m internal CHoCH + 1m internal CHoCH/BOS same direction
    // Priority 2: 1m internal CHoCH alone (with 15m trend agreement)
    // Priority 3: 15m swing BOS (trend continuation)
    const intTrend15m = smc15m.intTrend; // +1 bullish, -1 bearish, 0 neutral

    let direction = null;

    // 15m CHoCH + 1m confirm (highest conviction)
    if (last15mIntSignal === 'CHOCH_LONG' && (int1m === 'CHOCH_LONG' || int1m === 'BOS_LONG')) {
      if (zone !== 'ABOVE_UPPER') direction = 'LONG';
    } else if (last15mIntSignal === 'CHOCH_SHORT' && (int1m === 'CHOCH_SHORT' || int1m === 'BOS_SHORT')) {
      if (zone !== 'BELOW_LOWER') direction = 'SHORT';
    }

    // 1m CHoCH alone — needs 15m trend agreement
    if (!direction) {
      if (int1m === 'CHOCH_LONG' && intTrend15m >= 0 && zone !== 'ABOVE_UPPER')  direction = 'LONG';
      if (int1m === 'CHOCH_SHORT' && intTrend15m <= 0 && zone !== 'BELOW_LOWER') direction = 'SHORT';
    }

    // 15m swing BOS — trend continuation, strong confirmation
    if (!direction) {
      direction = resolveSignal(last15mIntSignal, last15mSwSignal, zone);
    }

    // Clear consumed 15m signals so they don't repeat each 1m candle
    last15mIntSignal = null;
    last15mSwSignal  = null;

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
    process.stdout.write(`[${symbol}] fetching from Bybit...`);
    try {
      // Sequential fetch to avoid rate limits (Bybit: 120 req/min per IP)
      const raw1m  = await fetchHistoricalKlines(symbol, '1m');
      const raw15m = await fetchHistoricalKlines(symbol, '15m');

      const candles1m  = raw1m.map(parseKlineSimple);
      const candles15m = raw15m.map(parseKlineSimple);

      process.stdout.write(` ${candles1m.length} x 1m | ${candles15m.length} x 15m ✓\n`);
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
