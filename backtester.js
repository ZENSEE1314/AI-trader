// ============================================================
// Backtester — Tests multiple strategies on 30-90 days of
// historical data to find the best formula for 1-2% per trade.
//
// Strategies tested:
//   1. SMC HTF (current) — 4H+1H structure alignment
//   2. EMA Crossover — EMA9/21 cross with trend filter
//   3. RSI Reversal — RSI oversold/overbought bounce
//   4. MACD Momentum — MACD cross with ADX trend filter
//   5. Bollinger Bounce — mean reversion at BB extremes
//   6. Multi-Indicator — combined score from all indicators
//   7. Kronos Composite — EMA + RSI + MACD + BB + ADX combined
//
// Each strategy is tested with multiple TP/SL configs to find
// the combo that consistently delivers 1-2% per trade.
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const BINANCE_KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
const REQUEST_TIMEOUT = 15000;

// ── Indicator Calculations ──────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const ema = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signal[i]);
  return { macdLine, signal, histogram };
}

function calcBB(closes, period = 20, mult = 2) {
  const bb = { upper: [], middle: [], lower: [] };
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      bb.upper.push(closes[i]); bb.middle.push(closes[i]); bb.lower.push(closes[i]);
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b) / period;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    bb.upper.push(mean + mult * std);
    bb.middle.push(mean);
    bb.lower.push(mean - mult * std);
  }
  return bb;
}

function calcADX(highs, lows, closes, period = 14) {
  const adx = new Array(closes.length).fill(20);
  if (closes.length < period * 3) return adx;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b) / period;
  let aPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b) / period;
  let aMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b) / period;
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    aPlusDM = (aPlusDM * (period - 1) + plusDM[i]) / period;
    aMinusDM = (aMinusDM * (period - 1) + minusDM[i]) / period;
    const pdi = atr > 0 ? (aPlusDM / atr) * 100 : 0;
    const mdi = atr > 0 ? (aMinusDM / atr) * 100 : 0;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0);
  }
  let adxVal = dx.length >= period ? dx.slice(0, period).reduce((a, b) => a + b) / period : 20;
  const startIdx = period * 2;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    if (i + 1 + period < adx.length) adx[i + 1 + period] = adxVal;
  }
  // Fill remaining with last calculated
  for (let i = adx.length - 1; i >= 0; i--) {
    if (adx[i] === 20 && i > 0 && adx[i - 1] !== 20) { adx[i] = adx[i - 1]; break; }
  }
  return adx;
}

// ── Fetch Historical Klines ─────────────────────────────────

async function fetchHistoricalKlines(symbol, interval, days) {
  const intervalMs = { '15m': 900000, '1h': 3600000, '4h': 14400000 };
  const ms = intervalMs[interval] || 900000;
  const totalCandles = Math.ceil((days * 24 * 3600 * 1000) / ms);
  const limit = 1000; // Binance max per request
  const allKlines = [];
  let endTime = Date.now();

  for (let fetched = 0; fetched < totalCandles; ) {
    const batch = Math.min(limit, totalCandles - fetched);
    const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${batch}&endTime=${endTime}`;
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (!res.ok) break;
      const data = await res.json();
      if (!data.length) break;
      allKlines.unshift(...data);
      endTime = data[0][0] - 1;
      fetched += data.length;
      if (data.length < batch) break;
      await new Promise(r => setTimeout(r, 100));
    } catch { break; }
  }
  return allKlines;
}

// ── Strategy Definitions ────────────────────────────────────

const STRATEGIES = {
  ema_cross: {
    name: 'EMA Crossover (9/21)',
    description: 'EMA9 crosses above EMA21 = LONG, below = SHORT. EMA50 as trend filter.',
    scan(closes, highs, lows, i) {
      if (i < 55) return null;
      const slice = closes.slice(0, i + 1);
      const ema9 = calcEMA(slice, 9);
      const ema21 = calcEMA(slice, 21);
      const ema50 = calcEMA(slice, 50);
      const curr9 = ema9[i], prev9 = ema9[i - 1];
      const curr21 = ema21[i], prev21 = ema21[i - 1];
      const curr50 = ema50[i];
      // Cross up + above EMA50
      if (prev9 <= prev21 && curr9 > curr21 && closes[i] > curr50) return 'LONG';
      // Cross down + below EMA50
      if (prev9 >= prev21 && curr9 < curr21 && closes[i] < curr50) return 'SHORT';
      return null;
    },
  },

  rsi_reversal: {
    name: 'RSI Reversal',
    description: 'RSI drops below 30 then rises = LONG, above 70 then drops = SHORT.',
    scan(closes, highs, lows, i) {
      if (i < 20) return null;
      const rsi = calcRSI(closes.slice(0, i + 1), 14);
      const curr = rsi[rsi.length - 1];
      const prev = rsi[rsi.length - 2];
      const prev2 = rsi[rsi.length - 3];
      // Oversold bounce
      if (prev2 < 30 && prev < 35 && curr > 35 && curr > prev) return 'LONG';
      // Overbought drop
      if (prev2 > 70 && prev > 65 && curr < 65 && curr < prev) return 'SHORT';
      return null;
    },
  },

  macd_momentum: {
    name: 'MACD Momentum + ADX',
    description: 'MACD crosses signal line with ADX > 20 confirming trend.',
    scan(closes, highs, lows, i) {
      if (i < 35) return null;
      const slice = closes.slice(0, i + 1);
      const { macdLine, signal } = calcMACD(slice);
      const adx = calcADX(highs.slice(0, i + 1), lows.slice(0, i + 1), slice, 14);
      const currADX = adx[adx.length - 1];
      if (currADX < 20) return null;
      const currMACD = macdLine[macdLine.length - 1], prevMACD = macdLine[macdLine.length - 2];
      const currSig = signal[signal.length - 1], prevSig = signal[signal.length - 2];
      if (prevMACD <= prevSig && currMACD > currSig) return 'LONG';
      if (prevMACD >= prevSig && currMACD < currSig) return 'SHORT';
      return null;
    },
  },

  bb_bounce: {
    name: 'Bollinger Band Bounce',
    description: 'Price touches lower BB = LONG, upper BB = SHORT (mean reversion).',
    scan(closes, highs, lows, i) {
      if (i < 25) return null;
      const slice = closes.slice(0, i + 1);
      const bb = calcBB(slice, 20, 2);
      const price = closes[i];
      const lower = bb.lower[bb.lower.length - 1];
      const upper = bb.upper[bb.upper.length - 1];
      const mid = bb.middle[bb.middle.length - 1];
      const range = upper - lower;
      if (range <= 0) return null;
      // Price within 10% of lower band
      if (price <= lower + range * 0.1 && closes[i] > closes[i - 1]) return 'LONG';
      // Price within 10% of upper band
      if (price >= upper - range * 0.1 && closes[i] < closes[i - 1]) return 'SHORT';
      return null;
    },
  },

  kronos_composite: {
    name: 'Kronos Composite (All Indicators)',
    description: 'Combined EMA + RSI + MACD + BB + ADX scoring (same as Kronos engine).',
    scan(closes, highs, lows, i) {
      if (i < 55) return null;
      const slice = closes.slice(0, i + 1);
      const hSlice = highs.slice(0, i + 1);
      const lSlice = lows.slice(0, i + 1);

      let score = 0;
      // EMA alignment
      const ema9 = calcEMA(slice, 9);
      const ema21 = calcEMA(slice, 21);
      const ema50 = calcEMA(slice, 50);
      const c = closes[i];
      if (c > ema9[i] && ema9[i] > ema21[i] && ema21[i] > ema50[i]) score += 2;
      else if (c < ema9[i] && ema9[i] < ema21[i] && ema21[i] < ema50[i]) score -= 2;

      // RSI
      const rsi = calcRSI(slice, 14);
      const rsiVal = rsi[rsi.length - 1];
      if (rsiVal > 55) score += 1;
      else if (rsiVal < 45) score -= 1;

      // MACD
      const { macdLine, signal, histogram } = calcMACD(slice);
      if (macdLine[macdLine.length - 1] > signal[signal.length - 1]) score += 2;
      else score -= 2;
      if (histogram[histogram.length - 1] > histogram[histogram.length - 2]) score += 1;
      else score -= 1;

      // BB position
      const bb = calcBB(slice, 20, 2);
      const bbRange = bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1];
      if (bbRange > 0) {
        const pos = (c - bb.lower[bb.lower.length - 1]) / bbRange;
        if (pos < 0.2) score += 1;
        else if (pos > 0.8) score -= 1;
      }

      // ADX multiplier
      const adx = calcADX(hSlice, lSlice, slice, 14);
      const adxVal = adx[adx.length - 1];
      if (adxVal > 25) score = Math.round(score * 1.5);
      else if (adxVal < 15) score = Math.round(score * 0.5);

      // Volume trend
      if (i >= 10) {
        const vols = slice.slice(-10);
        const recent = vols.slice(-5).reduce((a, b) => a + b) / 5;
        const older = vols.slice(0, 5).reduce((a, b) => a + b) / 5;
        if (recent > older * 1.2) score += (score > 0 ? 1 : -1);
      }

      if (score >= 4) return 'LONG';
      if (score <= -4) return 'SHORT';
      return null;
    },
  },

  ema_rsi_macd: {
    name: 'EMA + RSI + MACD Triple Confirm',
    description: 'All three must agree: EMA trend + RSI zone + MACD cross.',
    scan(closes, highs, lows, i) {
      if (i < 35) return null;
      const slice = closes.slice(0, i + 1);
      const ema9 = calcEMA(slice, 9);
      const ema21 = calcEMA(slice, 21);
      const rsi = calcRSI(slice, 14);
      const { macdLine, signal } = calcMACD(slice);

      const emaBull = ema9[i] > ema21[i] && closes[i] > ema9[i];
      const emaBear = ema9[i] < ema21[i] && closes[i] < ema9[i];
      const rsiBull = rsi[rsi.length - 1] > 50 && rsi[rsi.length - 1] < 70;
      const rsiBear = rsi[rsi.length - 1] < 50 && rsi[rsi.length - 1] > 30;
      const macdBull = macdLine[macdLine.length - 1] > signal[signal.length - 1];
      const macdBear = macdLine[macdLine.length - 1] < signal[signal.length - 1];

      if (emaBull && rsiBull && macdBull) return 'LONG';
      if (emaBear && rsiBear && macdBear) return 'SHORT';
      return null;
    },
  },

  ema_bb_rsi: {
    name: 'EMA Trend + BB Entry + RSI Filter',
    description: 'EMA21 trend direction, BB for entry timing, RSI safety filter.',
    scan(closes, highs, lows, i) {
      if (i < 30) return null;
      const slice = closes.slice(0, i + 1);
      const ema21 = calcEMA(slice, 21);
      const ema50 = calcEMA(slice, 50);
      const rsi = calcRSI(slice, 14);
      const bb = calcBB(slice, 20, 2);

      const trend = ema21[i] > ema50[i] ? 'bull' : ema21[i] < ema50[i] ? 'bear' : null;
      if (!trend) return null;
      const rsiVal = rsi[rsi.length - 1];
      const lower = bb.lower[bb.lower.length - 1];
      const upper = bb.upper[bb.upper.length - 1];
      const mid = bb.middle[bb.middle.length - 1];

      // Bull trend: buy on BB lower touch, RSI not overbought
      if (trend === 'bull' && closes[i] <= lower * 1.005 && rsiVal < 65 && rsiVal > 30) return 'LONG';
      // Bear trend: sell on BB upper touch, RSI not oversold
      if (trend === 'bear' && closes[i] >= upper * 0.995 && rsiVal > 35 && rsiVal < 70) return 'SHORT';
      return null;
    },
  },
};

// ── TP/SL Configurations to Test ────────────────────────────

const TP_SL_CONFIGS = [
  { name: '1%TP/0.5%SL (RR 2:1)', tp: 0.01, sl: 0.005 },
  { name: '1.5%TP/0.75%SL (RR 2:1)', tp: 0.015, sl: 0.0075 },
  { name: '2%TP/1%SL (RR 2:1)', tp: 0.02, sl: 0.01 },
  { name: '1%TP/0.7%SL (RR 1.4:1)', tp: 0.01, sl: 0.007 },
  { name: '1.5%TP/1%SL (RR 1.5:1)', tp: 0.015, sl: 0.01 },
  { name: '2%TP/0.8%SL (RR 2.5:1)', tp: 0.02, sl: 0.008 },
  { name: '0.8%TP/0.4%SL (RR 2:1)', tp: 0.008, sl: 0.004 },
  { name: '1.2%TP/0.5%SL (RR 2.4:1)', tp: 0.012, sl: 0.005 },
];

// ── Backtest Runner ─────────────────────────────────────────

function simulateTrades(closes, highs, lows, strategyFn, tpPct, slPct) {
  const trades = [];
  let inTrade = false;
  let entry = 0, direction = null, entryIdx = 0;

  for (let i = 55; i < closes.length - 1; i++) {
    if (inTrade) {
      const pricePnl = direction === 'LONG'
        ? (closes[i] - entry) / entry
        : (entry - closes[i]) / entry;

      // Check high/low for SL/TP hit within candle
      const highPnl = direction === 'LONG'
        ? (highs[i] - entry) / entry
        : (entry - lows[i]) / entry;
      const lowPnl = direction === 'LONG'
        ? (lows[i] - entry) / entry
        : (entry - highs[i]) / entry;

      if (lowPnl <= -slPct) {
        // SL hit
        trades.push({ dir: direction, entry, exit: entry * (1 - (direction === 'LONG' ? slPct : -slPct)), pnl: -slPct, bars: i - entryIdx, result: 'SL' });
        inTrade = false;
      } else if (highPnl >= tpPct) {
        // TP hit
        trades.push({ dir: direction, entry, exit: entry * (1 + (direction === 'LONG' ? tpPct : -tpPct)), pnl: tpPct, bars: i - entryIdx, result: 'TP' });
        inTrade = false;
      } else if (i - entryIdx > 96) {
        // Max hold: 96 candles (~24h on 15m). Close at market.
        trades.push({ dir: direction, entry, exit: closes[i], pnl: pricePnl, bars: i - entryIdx, result: pricePnl > 0 ? 'WIN' : 'LOSS' });
        inTrade = false;
      }
    }

    if (!inTrade) {
      const signal = strategyFn(closes, highs, lows, i);
      if (signal) {
        inTrade = true;
        direction = signal;
        entry = closes[i];
        entryIdx = i;
      }
    }
  }

  // Close remaining trade
  if (inTrade) {
    const lastPrice = closes[closes.length - 1];
    const pnl = direction === 'LONG'
      ? (lastPrice - entry) / entry
      : (entry - lastPrice) / entry;
    trades.push({ dir: direction, entry, exit: lastPrice, pnl, bars: closes.length - 1 - entryIdx, result: pnl > 0 ? 'WIN' : 'LOSS' });
  }

  return trades;
}

function analyzeResults(trades) {
  if (!trades.length) return { total: 0, wins: 0, losses: 0, winRate: 0, avgPnl: 0, avgWin: 0, avgLoss: 0, totalPnl: 0, maxDrawdown: 0, profitFactor: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length) * 100,
    avgPnl: (totalPnl / trades.length) * 100,
    avgWin: wins.length ? (grossWin / wins.length) * 100 : 0,
    avgLoss: losses.length ? -(grossLoss / losses.length) * 100 : 0,
    totalPnl: totalPnl * 100,
    maxDrawdown: maxDD * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    avgBars: Math.round(trades.reduce((s, t) => s + t.bars, 0) / trades.length),
  };
}

// ── Main Backtest ───────────────────────────────────────────

async function runBacktest(options = {}) {
  const {
    symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
    days = 60,
    interval = '15m',
    strategies = null, // null = test all
  } = options;

  bLog.ai(`Backtester starting: ${symbols.length} symbols × ${days} days × ${Object.keys(STRATEGIES).length} strategies × ${TP_SL_CONFIGS.length} configs`);
  const startTime = Date.now();

  const results = [];
  const stratKeys = strategies || Object.keys(STRATEGIES);

  for (const symbol of symbols) {
    bLog.ai(`Fetching ${days}d of ${interval} data for ${symbol}...`);
    const klines = await fetchHistoricalKlines(symbol, interval, days);
    if (!klines || klines.length < 100) {
      bLog.ai(`${symbol}: not enough data (${klines?.length || 0} candles)`);
      continue;
    }

    const closes = klines.map(k => parseFloat(k[4]));
    const highs = klines.map(k => parseFloat(k[2]));
    const lows = klines.map(k => parseFloat(k[3]));

    bLog.ai(`${symbol}: ${klines.length} candles loaded`);

    for (const stratKey of stratKeys) {
      const strat = STRATEGIES[stratKey];
      if (!strat) continue;

      for (const config of TP_SL_CONFIGS) {
        const trades = simulateTrades(closes, highs, lows, strat.scan, config.tp, config.sl);
        const stats = analyzeResults(trades);

        results.push({
          symbol,
          strategy: stratKey,
          strategyName: strat.name,
          tpSlConfig: config.name,
          tp: config.tp,
          sl: config.sl,
          days,
          candles: klines.length,
          ...stats,
        });
      }
    }
  }

  // Sort by: trades > 5, then by avgPnl descending
  results.sort((a, b) => {
    if (a.total < 5 && b.total >= 5) return 1;
    if (b.total < 5 && a.total >= 5) return -1;
    return b.avgPnl - a.avgPnl;
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  bLog.ai(`Backtest done in ${elapsed}s: ${results.length} combinations tested`);

  // Find best configs targeting 1-2% avg per trade
  const viable = results.filter(r => r.total >= 5 && r.winRate >= 45 && r.avgPnl >= 0.5);
  const bestOverall = viable[0] || results[0];

  // Build summary
  const summary = {
    elapsed: parseFloat(elapsed),
    totalCombinations: results.length,
    viableStrategies: viable.length,
    bestStrategy: bestOverall ? {
      strategy: bestOverall.strategyName,
      config: bestOverall.tpSlConfig,
      winRate: bestOverall.winRate.toFixed(1),
      avgPnl: bestOverall.avgPnl.toFixed(2),
      totalPnl: bestOverall.totalPnl.toFixed(2),
      trades: bestOverall.total,
      profitFactor: bestOverall.profitFactor.toFixed(2),
      maxDrawdown: bestOverall.maxDrawdown.toFixed(2),
    } : null,
    top10: viable.slice(0, 10).map(r => ({
      strategy: r.strategyName,
      symbol: r.symbol,
      config: r.tpSlConfig,
      trades: r.total,
      winRate: r.winRate.toFixed(1) + '%',
      avgPnl: r.avgPnl.toFixed(2) + '%',
      totalPnl: r.totalPnl.toFixed(1) + '%',
      pf: r.profitFactor.toFixed(2),
    })),
    allResults: results,
  };

  // Save to DB
  try {
    const { query } = require('./db');
    for (const r of viable.slice(0, 20)) {
      await query(
        `INSERT INTO strategy_backtests (name, params, total_trades, wins, losses, win_rate, total_pnl, avg_win, avg_loss, max_drawdown, symbols, top_trades)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          `${r.strategyName} | ${r.tpSlConfig}`,
          JSON.stringify({ strategy: r.strategy, tp: r.tp, sl: r.sl, days }),
          r.total, r.wins, r.losses, r.winRate, r.totalPnl,
          r.avgWin, r.avgLoss, r.maxDrawdown,
          JSON.stringify([r.symbol]),
          JSON.stringify({ avgBars: r.avgBars, profitFactor: r.profitFactor }),
        ]
      ).catch(() => {});
    }
  } catch {}

  return summary;
}

// ── Apply Best Strategy ─────────────────────────────────────
// Updates ai_versions params to use the best backtest result

async function applyBestStrategy(backtestResult) {
  if (!backtestResult?.bestStrategy) return { ok: false, error: 'No viable strategy found' };

  const best = backtestResult.allResults?.find(r =>
    r.strategyName === backtestResult.bestStrategy.strategy &&
    r.tpSlConfig === backtestResult.bestStrategy.config
  );
  if (!best) return { ok: false, error: 'Strategy details not found' };

  try {
    const { query } = require('./db');
    const prevRows = await query('SELECT params FROM ai_versions ORDER BY id DESC LIMIT 1');
    const prev = prevRows.length && prevRows[0].params
      ? (typeof prevRows[0].params === 'string' ? JSON.parse(prevRows[0].params) : prevRows[0].params)
      : {};

    const newParams = {
      ...prev,
      // Apply the winning TP/SL from backtest
      SL_MARGIN_PCT: best.sl * 20, // convert price % to margin % at 20x
      TP_MARGIN_PCT: best.tp * 20,
      MIN_SCORE: 5,
      bestStrategy: best.strategy,
      bestStrategyName: best.strategyName,
      bestConfig: best.tpSlConfig,
      backtestWinRate: best.winRate,
      backtestAvgPnl: best.avgPnl,
      backtestTotalPnl: best.totalPnl,
      backtestDays: best.days,
      appliedAt: Date.now(),
    };

    // Save as new AI version
    const countRes = await query('SELECT COUNT(*) as c FROM ai_trades WHERE pnl_pct IS NOT NULL');
    const tradeCount = parseInt(countRes[0]?.c) || 0;
    const major = Math.floor(tradeCount / 50) + 1;
    const version = `v${major}.BT`;

    await query(
      `INSERT INTO ai_versions (version, trade_count, win_rate, avg_pnl, total_pnl, params, changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        version, tradeCount, best.winRate, best.avgPnl, best.totalPnl,
        JSON.stringify(newParams),
        `Applied backtest winner: ${best.strategyName} ${best.tpSlConfig} (${best.winRate.toFixed(1)}% WR, ${best.avgPnl.toFixed(2)}% avg)`,
      ]
    );

    bLog.ai(`Applied backtest strategy: ${best.strategyName} ${best.tpSlConfig} — ${best.winRate.toFixed(1)}% WR, ${best.avgPnl.toFixed(2)}% avg PnL`);
    return { ok: true, strategy: best.strategyName, config: best.tpSlConfig, winRate: best.winRate, avgPnl: best.avgPnl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  runBacktest,
  applyBestStrategy,
  STRATEGIES,
  TP_SL_CONFIGS,
  // Expose indicator helpers for other modules
  calcEMA,
  calcRSI,
  calcMACD,
  calcBB,
  calcADX,
};
