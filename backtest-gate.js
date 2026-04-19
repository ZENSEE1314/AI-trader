// ============================================================
// Backtest Gate — Inline per-token backtest before each trade
//
// Each agent backtests its OWN token right before trading.
// No bulk background job — fast, focused, per-token.
// Results cached in DB for 2 hours to avoid redundant runs.
// No minimum trade count — even 1 signal is valid data.
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const MIN_WIN_RATE = 40;          // 40% minimum — profitable at 1:2 RR (40 wins×2 - 60 losses×1 = net +20). 50% was too strict given trailing SL dynamic exits.
const BACKTEST_DAYS = 30;         // default: 30 days of history
const MAX_BACKTEST_DAYS = 90;     // can go up to 90 days
const CACHE_HOURS = 2;            // re-use cached result for 2 hours

let _db = null;
function getDB() {
  if (!_db) { try { _db = require('./db'); } catch (_) {} }
  return _db;
}

// In-memory cache to avoid DB hits every cycle
const _memCache = new Map();
const MEM_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min in-memory

function getMemCached(symbol, strategy) {
  const key = `${symbol}:${strategy}`;
  const entry = _memCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > MEM_CACHE_TTL_MS) {
    _memCache.delete(key);
    return null;
  }
  return entry;
}

function setMemCache(symbol, strategy, winRate, total) {
  _memCache.set(`${symbol}:${strategy}`, {
    winRate, total, time: Date.now(),
  });
}

// Fetch klines from Binance
async function fetchKlines(symbol, interval, limit) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url, { timeout: 15000 });
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data;
  } catch { return []; }
}

function parseCandle(k) {
  return {
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]),
    volume: parseFloat(k[5]), time: k[0],
  };
}

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

// Strategies the backtest engine knows how to simulate
const KNOWN_STRATEGIES = new Set(['LIQUIDITY_SWEEP', 'STOP_LOSS_HUNT', 'MOMENTUM_SCALP', 'BRR_FIBO', 'SMC_CLASSIC', 'SMC_HL_STRUCTURE', 'RANGE_BOUNCE', 'CONSOL_REJECTION', 'VWAP_REJECTION', 'ALL']);

// Backtest a SINGLE token × strategy combo on recent data
// Called inline by the agent right before it wants to trade
async function backtestToken(symbol, strategy, days = BACKTEST_DAYS) {
  // AI-discovered and custom strategy names (e.g. AI-vwap_rsi, SHORT-3m1m) can't be
  // simulated by this engine — fall back to 'ALL' which checks if the TOKEN is generally
  // tradeable using all known strategies. If any known strategy is profitable on this
  // token the AI strategy gets a green light too.
  if (!KNOWN_STRATEGIES.has(strategy)) {
    return backtestToken(symbol, 'ALL', days);
  }
  const clampedDays = Math.min(days, MAX_BACKTEST_DAYS);
  const limit15m = clampedDays * 24 * 4; // 15m candles
  const limit1h = clampedDays * 24;

  // Binance max 1500 klines per request — split if needed
  const klines15m = await fetchKlines(symbol, '15m', Math.min(limit15m, 1500));
  const klines1h = await fetchKlines(symbol, '1h', Math.min(limit1h, 720));

  if (!klines15m || klines15m.length < 30) return null;

  const candles15m = klines15m.map(parseCandle);
  const candles1h = (klines1h || []).map(parseCandle);
  const closes15m = candles15m.map(c => c.close);

  // SL/TP: fixed 30% margin / 45% margin at 20x leverage
  const slPct = 0.30 / 20; // 1.5% price move
  const tpPct = 0.45 / 20; // 2.25% price move

  let wins = 0;
  let losses = 0;

  const WINDOW = 30;
  for (let i = WINDOW; i < candles15m.length - 10; i++) {
    const slice15m = candles15m.slice(Math.max(0, i - 80), i + 1);
    const currentPrice = candles15m[i].close;
    const futureCandles = candles15m.slice(i + 1, i + 40);
    if (futureCandles.length < 3) continue;

    const sweepCandle = candles15m[i];
    const candleTime = candles15m[i].time;

    // 1h trend context
    const h1Slice = candles1h.filter(c => c.time <= candleTime).slice(-30);
    let h1Trend = 'neutral';
    if (h1Slice.length >= 21) {
      const h1Closes = h1Slice.map(c => c.close);
      const ema9 = calcEMA(h1Closes, 9);
      const ema21 = calcEMA(h1Closes, 21);
      if (ema9 !== null && ema21 !== null) {
        h1Trend = ema9 > ema21 ? 'bullish' : 'bearish';
      }
    }

    const rsi = calcRSI(closes15m.slice(0, i + 1));
    const ema9_15 = calcEMA(closes15m.slice(0, i + 1), 9);
    const ema21_15 = calcEMA(closes15m.slice(0, i + 1), 21);
    const trend15m = (ema9_15 && ema21_15)
      ? (ema9_15 > ema21_15 ? 'bullish' : 'bearish')
      : 'neutral';

    // Detect signals for the REQUESTED strategy only
    const signals = [];

    if (strategy === 'LIQUIDITY_SWEEP' || strategy === 'ALL') {
      const recentLow = Math.min(...slice15m.slice(-6, -1).map(c => c.low));
      const recentHigh = Math.max(...slice15m.slice(-6, -1).map(c => c.high));
      if (sweepCandle.low < recentLow && sweepCandle.close > recentLow) {
        signals.push({ direction: 'LONG', price: currentPrice });
      }
      if (sweepCandle.high > recentHigh && sweepCandle.close < recentHigh) {
        signals.push({ direction: 'SHORT', price: currentPrice });
      }
    }

    if (strategy === 'STOP_LOSS_HUNT' || strategy === 'ALL') {
      const pivotHigh = Math.max(...slice15m.slice(-20, -3).map(c => c.high));
      const pivotLow = Math.min(...slice15m.slice(-20, -3).map(c => c.low));
      if (sweepCandle.high > pivotHigh * 1.001 && sweepCandle.close < pivotHigh) {
        signals.push({ direction: 'SHORT', price: currentPrice });
      }
      if (sweepCandle.low < pivotLow * 0.999 && sweepCandle.close > pivotLow) {
        signals.push({ direction: 'LONG', price: currentPrice });
      }
    }

    if (strategy === 'MOMENTUM_SCALP' || strategy === 'ALL') {
      if (trend15m === 'bullish' && rsi > 40 && rsi < 65 && i > 0) {
        const prev = candles15m[i - 1];
        if (prev.close < prev.open && sweepCandle.close > sweepCandle.open && sweepCandle.close > prev.high) {
          signals.push({ direction: 'LONG', price: currentPrice });
        }
      }
      if (trend15m === 'bearish' && rsi > 35 && rsi < 60 && i > 0) {
        const prev = candles15m[i - 1];
        if (prev.close > prev.open && sweepCandle.close < sweepCandle.open && sweepCandle.close < prev.low) {
          signals.push({ direction: 'SHORT', price: currentPrice });
        }
      }
    }

    if (strategy === 'BRR_FIBO' || strategy === 'ALL') {
      const pivotHigh = Math.max(...slice15m.slice(-20, -3).map(c => c.high));
      const pivotLow = Math.min(...slice15m.slice(-20, -3).map(c => c.low));
      if (h1Trend === 'bullish' && sweepCandle.close > pivotHigh && rsi < 70) {
        signals.push({ direction: 'LONG', price: currentPrice });
      }
      if (h1Trend === 'bearish' && sweepCandle.close < pivotLow && rsi > 30) {
        signals.push({ direction: 'SHORT', price: currentPrice });
      }
    }

    if (strategy === 'SMC_CLASSIC' || strategy === 'ALL') {
      if (slice15m.length >= 10) {
        const r = slice15m.slice(-10);
        const highs = r.map(c => c.high);
        const lows = r.map(c => c.low);
        const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
        const hl = lows[lows.length - 1] > Math.min(...lows.slice(2, -1));
        if (hh && hl && h1Trend === 'bullish') {
          signals.push({ direction: 'LONG', price: currentPrice });
        }
        const lh = highs[highs.length - 1] < Math.max(...highs.slice(0, -3));
        const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
        if (lh && ll && h1Trend === 'bearish') {
          signals.push({ direction: 'SHORT', price: currentPrice });
        }
      }
    }

    // SMC HL Structure backtest: consecutive HLs (bullish) or LHs (bearish) on 15m
    // EMA55 direction + 1m trigger candle simulated via next 15m bar
    if (strategy === 'SMC_HL_STRUCTURE' || strategy === 'ALL') {
      if (slice15m.length >= 30) {
        const closes15 = slice15m.map(c => c.close);
        const ema55_now  = calcEMA(closes15, Math.min(55, closes15.length - 1));
        const ema55_prev = calcEMA(closes15.slice(0, -5), Math.min(55, closes15.length - 6));
        const slope = ema55_now && ema55_prev ? (ema55_now - ema55_prev) / ema55_prev : 0;

        // Check for 2+ consecutive HLs in last 20 bars (swing lows going up)
        const lows20  = slice15m.slice(-20).map(c => c.low);
        const highs20 = slice15m.slice(-20).map(c => c.high);
        const swingLows  = lows20.filter((v, i) => i > 0 && i < lows20.length - 1 && v < lows20[i - 1] && v < lows20[i + 1]);
        const swingHighs = highs20.filter((v, i) => i > 0 && i < highs20.length - 1 && v > highs20[i - 1] && v > highs20[i + 1]);
        const hlPattern = swingLows.length >= 2 && swingLows[swingLows.length - 1] > swingLows[swingLows.length - 2];
        const lhPattern = swingHighs.length >= 2 && swingHighs[swingHighs.length - 1] < swingHighs[swingHighs.length - 2];

        if (hlPattern && ema55_now && currentPrice > ema55_now && slope > -0.0003 && h1Trend !== 'bearish') {
          signals.push({ direction: 'LONG', price: currentPrice });
        }
        if (lhPattern && ema55_now && currentPrice < ema55_now && slope < 0.0003 && h1Trend !== 'bullish') {
          signals.push({ direction: 'SHORT', price: currentPrice });
        }
      }
    }

    // RANGE_BOUNCE: sideways market, buy at range low, sell at range high
    // Uses range-wall SL (0.5% beyond wall) and opposite-wall TP — different from trend strategies
    if (strategy === 'RANGE_BOUNCE') {
      const rangeWindow = slice15m.slice(-20);
      if (rangeWindow.length >= 15) {
        const rangeHigh = Math.max(...rangeWindow.map(c => c.high));
        const rangeLow  = Math.min(...rangeWindow.map(c => c.low));
        const rangeSize = (rangeHigh - rangeLow) / rangeHigh;

        // Only trade sideways markets: range < 3%, not a big trending move
        if (rangeSize > 0.005 && rangeSize < 0.03) {
          const nearLow  = currentPrice <= rangeLow  * 1.003; // within 0.3% of range low
          const nearHigh = currentPrice >= rangeHigh * 0.997; // within 0.3% of range high
          const isBullishCandle = sweepCandle.close > sweepCandle.open;
          const isBearishCandle = sweepCandle.close < sweepCandle.open;

          if (nearLow && isBullishCandle) {
            // LONG at range bottom — TP at range high, SL 0.5% below range low
            signals.push({
              direction: 'LONG',
              price: currentPrice,
              tp: rangeHigh * 0.998,
              sl: rangeLow  * 0.995,
              useOwnSlTp: true,
            });
          }
          if (nearHigh && isBearishCandle) {
            // SHORT at range top — TP at range low, SL 0.5% above range high
            signals.push({
              direction: 'SHORT',
              price: currentPrice,
              tp: rangeLow  * 1.002,
              sl: rangeHigh * 1.005,
              useOwnSlTp: true,
            });
          }
        }
      }
    }

    // Trend alignment filter — RANGE_BOUNCE skips this (works in both directions)
    const filtered = signals.filter(s => {
      if (s.useOwnSlTp) return true; // range-bounce trades both directions by design
      if (s.direction === 'LONG' && h1Trend === 'bearish') return false;
      if (s.direction === 'SHORT' && h1Trend === 'bullish') return false;
      return true;
    });

    // Simulate each signal
    for (const sig of filtered) {
      const entry = sig.price;
      const isLong = sig.direction === 'LONG';
      // RANGE_BOUNCE supplies its own SL/TP; others use fixed margin-based values
      const tp = sig.useOwnSlTp ? sig.tp : (isLong ? entry * (1 + tpPct) : entry * (1 - tpPct));
      const sl = sig.useOwnSlTp ? sig.sl : (isLong ? entry * (1 - slPct) : entry * (1 + slPct));

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

      if (outcome === 'TIMEOUT') {
        const lastClose = futureCandles[futureCandles.length - 1].close;
        outcome = (isLong && lastClose > entry) || (!isLong && lastClose < entry) ? 'WIN' : 'LOSS';
      }

      if (outcome === 'WIN') wins++;
      else losses++;
    }
  }

  const total = wins + losses;
  const winRate = total > 0 ? Math.round(wins / total * 100) : 0;

  return { wins, losses, total, winRate };
}

// Store single token×strategy result in DB
async function storeResult(symbol, strategy, data) {
  const db = getDB();
  if (!db) return;
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

// Main gate check — called inline before each trade
// Runs backtest on the spot if no cached result exists
// signalWinRate: the AI strategy's own backtested WR (0 if not provided / unknown strategy)
async function passesGate(symbol, strategy, days = BACKTEST_DAYS, signalWinRate = 0) {
  // AI/evolved strategies (e.g. AI-adx_trend, vwap_rsi_*, evo_*) can't be simulated by
  // this engine. If the signal already carries its own backtested WR >= 55%, trust it
  // directly instead of running a proxy simulation on a different strategy set.
  const isUnknownStrategy = !KNOWN_STRATEGIES.has(strategy);
  if (isUnknownStrategy && signalWinRate >= 55) {
    bLog.scan(`${symbol} ${strategy}: AI strategy WR=${signalWinRate.toFixed(1)}% — PASSED (trusted signal WR)`);
    return true;
  }

  // Map AI-discovered / unknown strategy names to 'ALL' for cache + backtest lookup.
  // Unknown strategies produce 0 signals in backtestToken → WR=0% → permanent block.
  // Using 'ALL' asks "is this TOKEN generally tradeable?" which is the right question.
  const cacheStrategy = KNOWN_STRATEGIES.has(strategy) ? strategy : 'ALL';

  // 1. Check in-memory cache first (fastest)
  const mem = getMemCached(symbol, cacheStrategy);
  if (mem) {
    if (mem.total === 0) {
      bLog.scan(`${symbol} ${strategy}: 0 backtest signals (${days}d) — BLOCKED (cached)`);
      return false;
    }
    if (mem.winRate < MIN_WIN_RATE) {
      bLog.scan(`${symbol} ${strategy}: backtest WR=${mem.winRate}% < ${MIN_WIN_RATE}% — BLOCKED (cached)`);
      return false;
    }
    bLog.scan(`${symbol} ${strategy}: backtest WR=${mem.winRate}% (${mem.total} trades) — PASSED (cached)`);
    return true;
  }

  // 2. Check DB cache (still fast, avoids re-running backtest)
  const db = getDB();
  if (db) {
    try {
      const rows = await db.query(
        `SELECT win_rate, total_trades, tested_at FROM backtest_gate
         WHERE symbol = $1 AND strategy = $2
         AND tested_at > NOW() - INTERVAL '${CACHE_HOURS} hours'
         LIMIT 1`,
        [symbol, cacheStrategy]
      );

      if (rows.length > 0) {
        const wr = parseFloat(rows[0].win_rate);
        const total = parseInt(rows[0].total_trades);
        setMemCache(symbol, cacheStrategy, wr, total);

        if (total === 0) {
          bLog.scan(`${symbol} ${strategy}: 0 backtest signals — BLOCKED (DB cache)`);
          return false;
        }
        if (wr < MIN_WIN_RATE) {
          bLog.scan(`${symbol} ${strategy}: backtest WR=${wr}% < ${MIN_WIN_RATE}% — BLOCKED (DB cache)`);
          return false;
        }
        bLog.scan(`${symbol} ${strategy}: backtest WR=${wr}% (${total} trades) — PASSED (DB cache)`);
        return true;
      }
    } catch (err) {
      bLog.error(`[BacktestGate] DB cache check error: ${err.message}`);
    }
  }

  // 3. No cache — run backtest inline for THIS token × strategy
  bLog.scan(`${symbol} ${strategy}: running ${days}-day backtest inline...`);

  try {
    const result = await backtestToken(symbol, cacheStrategy, days);

    if (!result) {
      // No data from Binance — don't cache 0 WR (would block for 10 min on a transient error)
      bLog.scan(`${symbol} ${strategy}: backtest returned no data — allowing trade (fail-open)`);
      return true;
    }

    // Cache the result under cacheStrategy key
    setMemCache(symbol, cacheStrategy, result.winRate, result.total);
    await storeResult(symbol, cacheStrategy, result);

    if (result.total === 0) {
      bLog.scan(`${symbol} ${strategy}: 0 signals in ${days}d backtest — BLOCKED`);
      return false;
    }

    if (result.winRate < MIN_WIN_RATE) {
      bLog.scan(`${symbol} ${strategy}: backtest WR=${result.winRate}% (${result.total} trades, ${days}d) — BLOCKED`);
      return false;
    }

    bLog.scan(`${symbol} ${strategy}: backtest WR=${result.winRate}% (${result.total} trades, ${days}d) — PASSED`);
    return true;
  } catch (err) {
    // Backtest error (rate limit, network) — fail open so a transient API issue doesn't freeze trading
    bLog.error(`[BacktestGate] Inline backtest error for ${symbol} ${strategy}: ${err.message} — allowing trade`);
    return true;
  }
}

// Get all strategies that pass for a symbol (useful for dashboard)
async function getPassingStrategies(symbol, days = BACKTEST_DAYS) {
  const strategies = ['LIQUIDITY_SWEEP', 'STOP_LOSS_HUNT', 'MOMENTUM_SCALP', 'BRR_FIBO', 'SMC_CLASSIC', 'SMC_HL_STRUCTURE', 'RANGE_BOUNCE'];
  const passing = [];

  for (const strat of strategies) {
    const passes = await passesGate(symbol, strat, days);
    if (passes) {
      const mem = getMemCached(symbol, strat);
      passing.push({ strategy: strat, winRate: mem ? mem.winRate : 0 });
    }
  }

  return passing;
}

module.exports = {
  backtestToken,
  passesGate,
  getPassingStrategies,
  MIN_WIN_RATE,
  BACKTEST_DAYS,
};
