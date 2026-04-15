// ============================================================
// Backtest Gate — Only trade strategies with 80%+ backtest WR
//
// Runs quick backtests per token × strategy on recent data.
// Stores results in DB. Trades are BLOCKED unless WR >= 80%.
// Background job refreshes results every 2 hours.
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const MIN_WIN_RATE = 80;        // 80% minimum to fire a live trade
const BACKTEST_DAYS = 7;        // test on last 7 days of data
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000; // re-test every 2 hours
const MIN_TRADES_REQUIRED = 5;  // need at least 5 simulated trades to be valid

let _db = null;
function getDB() {
  if (!_db) { try { _db = require('./db'); } catch (_) {} }
  return _db;
}

// Fetch klines from Binance
async function fetchKlines(symbol, interval, limit) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url, { timeout: 15000 });
    return await r.json();
  } catch { return []; }
}

function parseCandle(k) {
  return {
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]),
    volume: parseFloat(k[5]), time: k[0],
  };
}

// Simple indicators for backtest signal generation
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Run a quick backtest for a specific token using the LIVE strategy logic
// Tests: given recent candle data, how many signals would have won vs lost?
async function backtestToken(symbol, days = BACKTEST_DAYS) {
  const limit15m = days * 24 * 4; // 15m candles
  const klines15m = await fetchKlines(symbol, '15m', Math.min(limit15m, 1000));
  const klines1h = await fetchKlines(symbol, '1h', Math.min(days * 24, 500));

  if (!klines15m || klines15m.length < 50) return null;

  const candles15m = klines15m.map(parseCandle);
  const candles1h = (klines1h || []).map(parseCandle);
  const closes15m = candles15m.map(c => c.close);

  // SL/TP: fixed 30% margin / 45% margin at 20x leverage
  const slPct = 0.30 / 20; // 1.5% price
  const tpPct = 0.45 / 20; // 2.25% price

  const results = {
    LIQUIDITY_SWEEP: { wins: 0, losses: 0, trades: [] },
    STOP_LOSS_HUNT: { wins: 0, losses: 0, trades: [] },
    MOMENTUM_SCALP: { wins: 0, losses: 0, trades: [] },
    BRR_FIBO: { wins: 0, losses: 0, trades: [] },
    SMC_CLASSIC: { wins: 0, losses: 0, trades: [] },
    ALL: { wins: 0, losses: 0, trades: [] },
  };

  // Walk through candles, simulate entries and check outcomes
  const WINDOW = 30; // need at least 30 candles of context
  for (let i = WINDOW; i < candles15m.length - 10; i++) {
    const slice15m = candles15m.slice(Math.max(0, i - 80), i + 1);
    const currentPrice = candles15m[i].close;
    const futureCandles = candles15m.slice(i + 1, i + 40); // next 10h of 15m candles

    if (futureCandles.length < 5) continue;

    // Get 1h context
    const candleTime = candles15m[i].time;
    const h1Slice = candles1h.filter(c => c.time <= candleTime).slice(-30);

    // Determine trend
    let h1Trend = 'neutral';
    if (h1Slice.length >= 21) {
      const h1Closes = h1Slice.map(c => c.close);
      const ema9 = calcEMA(h1Closes, 9);
      const ema21 = calcEMA(h1Closes, 21);
      if (ema9 !== null && ema21 !== null) {
        h1Trend = ema9 > ema21 ? 'bullish' : 'bearish';
      }
    }

    // RSI
    const rsi = calcRSI(closes15m.slice(0, i + 1));

    // EMA on 15m
    const ema9_15 = calcEMA(closes15m.slice(0, i + 1), 9);
    const ema21_15 = calcEMA(closes15m.slice(0, i + 1), 21);
    const trend15m = (ema9_15 && ema21_15) ? (ema9_15 > ema21_15 ? 'bullish' : 'bearish') : 'neutral';

    // Simple signal detection per strategy
    const signals = [];

    // LIQUIDITY SWEEP: sweep below recent low + close back inside
    const recentLow = Math.min(...slice15m.slice(-6, -1).map(c => c.low));
    const recentHigh = Math.max(...slice15m.slice(-6, -1).map(c => c.high));
    const sweepCandle = candles15m[i];
    if (sweepCandle.low < recentLow && sweepCandle.close > recentLow) {
      signals.push({ strategy: 'LIQUIDITY_SWEEP', direction: 'LONG', price: currentPrice });
    }
    if (sweepCandle.high > recentHigh && sweepCandle.close < recentHigh) {
      signals.push({ strategy: 'LIQUIDITY_SWEEP', direction: 'SHORT', price: currentPrice });
    }

    // STOP LOSS HUNT: price breaks S/R level then reverses
    const pivotHigh = Math.max(...slice15m.slice(-20, -3).map(c => c.high));
    const pivotLow = Math.min(...slice15m.slice(-20, -3).map(c => c.low));
    if (sweepCandle.high > pivotHigh * 1.001 && sweepCandle.close < pivotHigh) {
      signals.push({ strategy: 'STOP_LOSS_HUNT', direction: 'SHORT', price: currentPrice });
    }
    if (sweepCandle.low < pivotLow * 0.999 && sweepCandle.close > pivotLow) {
      signals.push({ strategy: 'STOP_LOSS_HUNT', direction: 'LONG', price: currentPrice });
    }

    // MOMENTUM SCALP: trend + reversal candle
    if (trend15m === 'bullish' && rsi > 40 && rsi < 65) {
      const prev = candles15m[i - 1];
      if (prev.close < prev.open && sweepCandle.close > sweepCandle.open && sweepCandle.close > prev.high) {
        signals.push({ strategy: 'MOMENTUM_SCALP', direction: 'LONG', price: currentPrice });
      }
    }
    if (trend15m === 'bearish' && rsi > 35 && rsi < 60) {
      const prev = candles15m[i - 1];
      if (prev.close > prev.open && sweepCandle.close < sweepCandle.open && sweepCandle.close < prev.low) {
        signals.push({ strategy: 'MOMENTUM_SCALP', direction: 'SHORT', price: currentPrice });
      }
    }

    // BRR: breakout above resistance then pullback
    if (h1Trend === 'bullish' && sweepCandle.close > pivotHigh && rsi < 70) {
      signals.push({ strategy: 'BRR_FIBO', direction: 'LONG', price: currentPrice });
    }
    if (h1Trend === 'bearish' && sweepCandle.close < pivotLow && rsi > 30) {
      signals.push({ strategy: 'BRR_FIBO', direction: 'SHORT', price: currentPrice });
    }

    // SMC CLASSIC: higher-high + higher-low for LONG
    if (slice15m.length >= 10) {
      const r = slice15m.slice(-10);
      const highs = r.map(c => c.high);
      const lows = r.map(c => c.low);
      const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
      const hl = lows[lows.length - 1] > Math.min(...lows.slice(2, -1));
      if (hh && hl && h1Trend === 'bullish') {
        signals.push({ strategy: 'SMC_CLASSIC', direction: 'LONG', price: currentPrice });
      }
      const lh = highs[highs.length - 1] < Math.max(...highs.slice(0, -3));
      const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
      if (lh && ll && h1Trend === 'bearish') {
        signals.push({ strategy: 'SMC_CLASSIC', direction: 'SHORT', price: currentPrice });
      }
    }

    // Filter by trend alignment
    const filteredSignals = signals.filter(s => {
      if (s.direction === 'LONG' && h1Trend === 'bearish') return false;
      if (s.direction === 'SHORT' && h1Trend === 'bullish') return false;
      return true;
    });

    // Simulate each signal against future candles
    for (const sig of filteredSignals) {
      const entry = sig.price;
      const isLong = sig.direction === 'LONG';
      const tp = isLong ? entry * (1 + tpPct) : entry * (1 - tpPct);
      const sl = isLong ? entry * (1 - slPct) : entry * (1 + slPct);

      let outcome = 'TIMEOUT';
      for (const fc of futureCandles) {
        if (isLong) {
          if (fc.low <= sl) { outcome = 'LOSS'; break; }
          if (fc.high >= tp) { outcome = 'WIN'; break; }
        } else {
          if (fc.high >= sl) { outcome = 'LOSS'; break; }
          if (fc.low <= tp) { outcome = 'WIN'; break; }
        }
      }

      // Timeout = check if in profit at end
      if (outcome === 'TIMEOUT') {
        const lastClose = futureCandles[futureCandles.length - 1].close;
        outcome = (isLong && lastClose > entry) || (!isLong && lastClose < entry) ? 'WIN' : 'LOSS';
      }

      const isWin = outcome === 'WIN';
      results[sig.strategy].trades.push({ outcome, direction: sig.direction });
      if (isWin) results[sig.strategy].wins++;
      else results[sig.strategy].losses++;

      results.ALL.trades.push({ outcome, direction: sig.direction, strategy: sig.strategy });
      if (isWin) results.ALL.wins++;
      else results.ALL.losses++;
    }
  }

  // Calculate win rates
  const output = {};
  for (const [strategy, data] of Object.entries(results)) {
    const total = data.wins + data.losses;
    output[strategy] = {
      wins: data.wins,
      losses: data.losses,
      total,
      winRate: total > 0 ? Math.round(data.wins / total * 100) : 0,
      valid: total >= MIN_TRADES_REQUIRED,
    };
  }

  return output;
}

// Store backtest results in DB
async function storeResults(symbol, results) {
  const db = getDB();
  if (!db) return;

  for (const [strategy, data] of Object.entries(results)) {
    if (strategy === 'ALL') continue; // skip aggregate
    try {
      await db.query(
        `INSERT INTO backtest_gate (symbol, strategy, wins, losses, total_trades, win_rate, tested_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (symbol, strategy) DO UPDATE SET
           wins = $3, losses = $4, total_trades = $5, win_rate = $6, tested_at = NOW()`,
        [symbol, strategy, data.wins, data.losses, data.total, data.winRate]
      );
    } catch (err) {
      console.error(`[BacktestGate] Store error: ${err.message}`);
    }
  }
}

// Check if a signal passes the 80% WR gate
async function passesGate(symbol, strategy, minWR = MIN_WIN_RATE) {
  const db = getDB();
  if (!db) return false;

  try {
    const rows = await db.query(
      `SELECT win_rate, total_trades, tested_at FROM backtest_gate
       WHERE symbol = $1 AND strategy = $2 LIMIT 1`,
      [symbol, strategy]
    );

    if (!rows.length) {
      bLog.scan(`${symbol} ${strategy}: no backtest data — BLOCKED`);
      return false;
    }

    const { win_rate, total_trades, tested_at } = rows[0];
    const wr = parseFloat(win_rate);
    const trades = parseInt(total_trades);

    if (trades < MIN_TRADES_REQUIRED) {
      bLog.scan(`${symbol} ${strategy}: only ${trades} backtest trades (need ${MIN_TRADES_REQUIRED}) — BLOCKED`);
      return false;
    }

    if (wr < minWR) {
      bLog.scan(`${symbol} ${strategy}: backtest WR=${wr}% < ${minWR}% — BLOCKED`);
      return false;
    }

    return true;
  } catch (err) {
    bLog.error(`[BacktestGate] Check error: ${err.message}`);
    return false;
  }
}

// Get all passing strategies for a symbol
async function getPassingStrategies(symbol, minWR = MIN_WIN_RATE) {
  const db = getDB();
  if (!db) return [];

  try {
    const rows = await db.query(
      `SELECT strategy, win_rate FROM backtest_gate
       WHERE symbol = $1 AND win_rate >= $2 AND total_trades >= $3`,
      [symbol, minWR, MIN_TRADES_REQUIRED]
    );
    return rows.map(r => ({ strategy: r.strategy, winRate: parseFloat(r.win_rate) }));
  } catch { return []; }
}

// Run backtests for all enabled tokens — called on startup + every 2 hours
async function runAllBacktests() {
  const db = getDB();
  if (!db) return;

  bLog.ai('[BacktestGate] Starting backtest run for all enabled tokens...');

  let tokens = [];
  try {
    // Get admin-enabled tokens
    const rows = await db.query(
      "SELECT symbol FROM global_token_settings WHERE enabled = true AND banned = false ORDER BY symbol"
    );
    tokens = rows.map(r => r.symbol);
  } catch {
    // Fallback to top volume tokens
    try {
      const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000 });
      const tickers = await r.json();
      tokens = tickers
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 30)
        .map(t => t.symbol);
    } catch { return; }
  }

  if (!tokens.length) {
    bLog.ai('[BacktestGate] No tokens to backtest');
    return;
  }

  let tested = 0;
  let passed = 0;

  for (const symbol of tokens) {
    try {
      // Skip if recently tested (within refresh interval)
      const recent = await db.query(
        `SELECT tested_at FROM backtest_gate WHERE symbol = $1 AND tested_at > NOW() - INTERVAL '2 hours' LIMIT 1`,
        [symbol]
      );
      if (recent.length > 0) continue;

      const results = await backtestToken(symbol, BACKTEST_DAYS);
      if (results) {
        await storeResults(symbol, results);
        tested++;

        const passing = Object.entries(results)
          .filter(([k, v]) => k !== 'ALL' && v.valid && v.winRate >= MIN_WIN_RATE);
        passed += passing.length;

        if (passing.length > 0) {
          bLog.ai(`[BacktestGate] ${symbol}: ${passing.map(([k, v]) => `${k}=${v.winRate}%`).join(', ')} ✅`);
        }
      }

      // Rate limit: 300ms between tokens
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      bLog.error(`[BacktestGate] ${symbol} backtest error: ${err.message}`);
    }
  }

  bLog.ai(`[BacktestGate] Complete: ${tested} tokens tested, ${passed} strategy+token combos passed ${MIN_WIN_RATE}% WR gate`);
}

// Start background refresh loop
let _refreshTimer = null;
function startBackgroundRefresh() {
  if (_refreshTimer) return;

  // Initial run after 30s (let server start up first)
  setTimeout(() => {
    runAllBacktests().catch(err => console.error('[BacktestGate] Initial run error:', err.message));
  }, 30000);

  // Refresh every 2 hours
  _refreshTimer = setInterval(() => {
    runAllBacktests().catch(err => console.error('[BacktestGate] Refresh error:', err.message));
  }, REFRESH_INTERVAL_MS);
}

module.exports = {
  backtestToken,
  passesGate,
  getPassingStrategies,
  runAllBacktests,
  startBackgroundRefresh,
  MIN_WIN_RATE,
};
