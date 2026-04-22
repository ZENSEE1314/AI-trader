// ============================================================
// Strategy Backtest
//
// Runs a strategy_definitions record against historical klines
// using the same indicator-library functions as live trading.
//
// Time gates (session_gate, prime_session) honour the bar's
// timestamp so results reflect real historical time-of-day.
// ============================================================

const fetch = require('node-fetch');
const { gates, signals, filters } = require('./indicator-library');
const { analyzeResults }          = require('./backtester');
const { log: bLog }               = require('./bot-logger');

const REQUEST_TIMEOUT = 15000;
const WARMUP_BARS     = 250;   // bars skipped before first signal check
const MAX_HOLD_BARS   = 200;   // force-close after this many bars

// ── Fetch historical klines (oldest → newest) ────────────────

async function fetchHistoricalKlines(symbol, interval, days) {
  const msPerBar = {
    '1m': 60e3, '3m': 180e3, '5m': 300e3,
    '15m': 900e3, '1h': 3600e3, '4h': 14400e3,
  };
  const ms      = msPerBar[interval] || 300e3;
  const needed  = Math.ceil((days * 86400e3) / ms) + WARMUP_BARS + 50;
  const LIMIT   = 1000;

  const allBars = [];
  let endTime   = Date.now();

  while (allBars.length < needed) {
    const batch = Math.min(LIMIT, needed - allBars.length);
    const url   = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${batch}&endTime=${endTime}`;
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (!res.ok) break;
      const raw = await res.json();
      if (!raw.length) break;
      allBars.unshift(...raw.map(r => ({
        ts:    Number(r[0]),
        open:  parseFloat(r[1]),
        high:  parseFloat(r[2]),
        low:   parseFloat(r[3]),
        close: parseFloat(r[4]),
        vol:   parseFloat(r[5]),
      })));
      endTime = raw[0][0] - 1;
      if (raw.length < batch) break;
      await new Promise(r => setTimeout(r, 120));
    } catch { break; }
  }
  return allBars;
}

// ── Determine which TFs a strategy config needs ──────────────

function getNeededTfs(ic, primaryTf) {
  const tfs = new Set([primaryTf]);
  if (ic.hl_structure?.enabled) {
    tfs.add(ic.hl_structure.primary_tf || '3m');
    tfs.add(ic.hl_structure.confirm_tf || '1m');
  }
  if (ic.ema_filter?.enabled) tfs.add(ic.ema_filter.htf || '1h');
  // ma_stack / tjunction / spike_hl only need the primary TF
  return [...tfs];
}

// ── Per-TF alignment index ────────────────────────────────────
// Returns an array where alignIdx[i] = last index in secondaryBars
// whose ts <= primaryBars[i].ts.  Uses a monotone pointer.

function buildAlignmentIndex(primaryBars, secondaryBars) {
  let j = 0;
  return primaryBars.map(bar => {
    while (j < secondaryBars.length - 1 && secondaryBars[j + 1].ts <= bar.ts) j++;
    return j;
  });
}

// ── Run indicator chain on a barsMap slice ───────────────────
// Mirrors strategy-runner.runStrategy but accepts pre-built barsMap
// and uses barTs for time-gate checks.

function runIndicatorChain(stratDef, barsMap, barTs) {
  const cfg  = typeof stratDef.config === 'string'
    ? JSON.parse(stratDef.config) : (stratDef.config || {});
  const ic   = cfg.indicators || {};
  const tf   = cfg.timeframe  || '5m';
  const bars = barsMap[tf] || Object.values(barsMap)[0] || [];

  if (!bars || bars.length < 20) return null;

  // ── Gates (use bar timestamp for historical accuracy) ────────
  if (ic.session_gate?.enabled) {
    if (!gates.checkSessionGate(ic.session_gate, barTs).pass) return null;
  }
  if (ic.prime_session?.enabled) {
    if (!gates.checkPrimeSession(ic.prime_session, barTs).pass) return null;
  }

  // ── Signal indicators ─────────────────────────────────────
  let direction = null, signalSl = null, signalEntry = null;

  if (ic.hl_structure?.enabled && !direction) {
    const r = signals.checkHLStructure(barsMap, ic.hl_structure);
    if (!r) return null;
    direction = r.direction; signalSl = r.sl; signalEntry = bars[bars.length - 1].close;
  }
  if (ic.spike_hl?.enabled && !direction) {
    const r = signals.checkSpikeHL(barsMap[tf] || bars, ic.spike_hl);
    if (!r) return null;
    direction = r.direction; signalSl = r.sl; signalEntry = r.entry;
  }
  if (ic.ma_stack?.enabled && !direction) {
    const r = signals.checkMAStack(barsMap[tf] || bars, ic.ma_stack);
    if (!r) return null;
    direction = r.direction;
  }
  if (ic.tjunction?.enabled && !direction) {
    const r = signals.checkTJunction(barsMap[tf] || bars, ic.tjunction);
    if (!r) return null;
    direction = r.direction;
  }

  if (!direction) return null;

  const entry = signalEntry || bars[bars.length - 1].close;

  // ── Filter indicators ──────────────────────────────────────
  if (ic.ema_filter?.enabled) {
    const htf  = ic.ema_filter.htf || '1h';
    const htfB = barsMap[htf] || [];
    if (!filters.checkEMAFilter(htfB, ic.ema_filter, direction).pass) return null;
  }
  if (ic.vwap_filter?.enabled) {
    if (!filters.checkVWAP(bars, ic.vwap_filter, direction).pass) return null;
  }
  if (ic.vol_filter?.enabled) {
    if (!filters.checkVolume(bars, ic.vol_filter).pass) return null;
  }
  if (ic.atr_gate?.enabled) {
    if (!filters.checkATRGate(bars, ic.atr_gate).pass) return null;
  }
  if (ic.candle_dir?.enabled) {
    if (!filters.checkCandleDir(bars[bars.length - 1], direction).pass) return null;
  }
  if (ic.rsi_filter?.enabled) {
    if (!filters.checkRSIFilter(bars, ic.rsi_filter, direction).pass) return null;
  }

  return { direction, entry, signalSl };
}

// ── Main backtest entry point ─────────────────────────────────

async function backtestStrategyDefinition(stratDef, options = {}) {
  const cfg     = typeof stratDef.config === 'string'
    ? JSON.parse(stratDef.config) : (stratDef.config || {});
  const days    = Math.min(options.days || 7, 14);
  const symbols = (options.symbols?.length ? options.symbols : null)
    || cfg.symbols?.length ? cfg.symbols : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
  const primaryTf = cfg.timeframe || '5m';
  const ic        = cfg.indicators || {};
  const slPct     = cfg.sl_pct        || 0.01;
  const tpMult    = cfg.tp_multiplier || 2.0;
  const tpPct     = slPct * tpMult;

  const neededTfs   = getNeededTfs(ic, primaryTf);
  const WINDOW      = 260; // max bars per TF slice passed to indicators

  const perSymbol = [];
  const allTrades = [];

  bLog.ai(`Backtest [${stratDef.name}]: ${symbols.length} symbols × ${days}d on ${primaryTf}`);

  for (const symbol of symbols) {
    try {
      bLog.ai(`Backtest: fetching ${symbol}...`);

      // Fetch all needed TFs in parallel
      const allBarsMap = {};
      await Promise.all(neededTfs.map(async (tf) => {
        allBarsMap[tf] = await fetchHistoricalKlines(symbol, tf, days);
      }));

      const primaryBars = allBarsMap[primaryTf];
      if (!primaryBars || primaryBars.length < WARMUP_BARS + 20) {
        perSymbol.push({ symbol, total: 0, error: 'Not enough data' });
        continue;
      }

      // Precompute alignment indices for each non-primary TF
      const alignIdx = {};
      for (const tf of neededTfs) {
        if (tf !== primaryTf) {
          alignIdx[tf] = buildAlignmentIndex(primaryBars, allBarsMap[tf]);
        }
      }

      const trades     = [];
      let inTrade      = false;
      let entryPrice   = 0;
      let tradeDir     = null;
      let tradeSl      = 0;
      let tradeTp      = 0;
      let entryBarIdx  = 0;

      for (let i = WARMUP_BARS; i < primaryBars.length - 1; i++) {
        const bar = primaryBars[i];

        // ── In-trade: check TP/SL on this bar ─────────────────
        if (inTrade) {
          const hi = bar.high;
          const lo = bar.low;
          let exited = false;

          if (tradeDir === 'LONG') {
            if (lo <= tradeSl) {
              trades.push({ dir: tradeDir, entry: entryPrice, exit: tradeSl,
                pnl: -slPct, bars: i - entryBarIdx, result: 'SL', symbol, ts: bar.ts });
              exited = true;
            } else if (hi >= tradeTp) {
              trades.push({ dir: tradeDir, entry: entryPrice, exit: tradeTp,
                pnl: tpPct, bars: i - entryBarIdx, result: 'TP', symbol, ts: bar.ts });
              exited = true;
            }
          } else {
            if (hi >= tradeSl) {
              trades.push({ dir: tradeDir, entry: entryPrice, exit: tradeSl,
                pnl: -slPct, bars: i - entryBarIdx, result: 'SL', symbol, ts: bar.ts });
              exited = true;
            } else if (lo <= tradeTp) {
              trades.push({ dir: tradeDir, entry: entryPrice, exit: tradeTp,
                pnl: tpPct, bars: i - entryBarIdx, result: 'TP', symbol, ts: bar.ts });
              exited = true;
            }
          }

          // Max hold
          if (!exited && i - entryBarIdx >= MAX_HOLD_BARS) {
            const pnl = tradeDir === 'LONG'
              ? (bar.close - entryPrice) / entryPrice
              : (entryPrice - bar.close) / entryPrice;
            trades.push({ dir: tradeDir, entry: entryPrice, exit: bar.close,
              pnl, bars: i - entryBarIdx, result: pnl > 0 ? 'WIN' : 'LOSS', symbol, ts: bar.ts });
            exited = true;
          }

          if (exited) inTrade = false;
        }

        // ── Not in trade: check for signal ───────────────────
        if (!inTrade) {
          // Build barsMap slice: last WINDOW bars of each TF up to this bar's ts
          const barsMap = { [primaryTf]: primaryBars.slice(Math.max(0, i - WINDOW + 1), i + 1) };
          for (const tf of neededTfs) {
            if (tf === primaryTf) continue;
            const idx  = alignIdx[tf][i];
            barsMap[tf] = allBarsMap[tf].slice(Math.max(0, idx - WINDOW + 1), idx + 1);
          }

          const sig = runIndicatorChain(stratDef, barsMap, bar.ts);
          if (sig) {
            inTrade     = true;
            entryPrice  = sig.entry;
            tradeDir    = sig.direction;
            entryBarIdx = i;

            // Use signal-provided SL if available
            const sl    = sig.signalSl != null ? sig.signalSl
              : tradeDir === 'LONG'  ? entryPrice * (1 - slPct)
              : entryPrice * (1 + slPct);
            const slDist = Math.abs(entryPrice - sl) / entryPrice;
            tradeSl = sl;
            tradeTp = tradeDir === 'LONG'
              ? entryPrice + (entryPrice - sl) * tpMult
              : entryPrice - (sl - entryPrice) * tpMult;
          }
        }
      }

      // Force-close open trade at last bar
      if (inTrade && primaryBars.length > 0) {
        const lastBar = primaryBars[primaryBars.length - 1];
        const pnl = tradeDir === 'LONG'
          ? (lastBar.close - entryPrice) / entryPrice
          : (entryPrice - lastBar.close) / entryPrice;
        trades.push({ dir: tradeDir, entry: entryPrice, exit: lastBar.close,
          pnl, bars: primaryBars.length - 1 - entryBarIdx, result: pnl > 0 ? 'WIN' : 'LOSS',
          symbol, ts: lastBar.ts });
      }

      const stats = analyzeResults(trades);
      perSymbol.push({ symbol, ...stats });
      allTrades.push(...trades);
      bLog.ai(`Backtest ${symbol}: ${trades.length} trades, WR=${stats.winRate?.toFixed(1)}%`);

    } catch (err) {
      bLog.error(`Backtest ${symbol}: ${err.message}`);
      perSymbol.push({ symbol, total: 0, error: err.message });
    }
  }

  const totals = analyzeResults(allTrades);

  return {
    strategyId:   stratDef.id,
    strategyName: stratDef.name,
    days,
    symbols,
    timeframe:    primaryTf,
    slPct,
    tpMult,
    tpPct,
    perSymbol,
    ...totals,
    longTrades:   allTrades.filter(t => t.dir === 'LONG').length,
    shortTrades:  allTrades.filter(t => t.dir === 'SHORT').length,
    tpHits:       allTrades.filter(t => t.result === 'TP').length,
    slHits:       allTrades.filter(t => t.result === 'SL').length,
    recentTrades: allTrades.slice(-8).reverse().map(t => ({
      symbol:  t.symbol,
      dir:     t.dir,
      entry:   t.entry?.toFixed(4),
      exit:    t.exit?.toFixed(4),
      pnlPct:  (t.pnl * 100).toFixed(2),
      result:  t.result,
      bars:    t.bars,
      date:    t.ts ? new Date(t.ts).toLocaleString() : '',
    })),
    gatesHonoured: !!(ic.session_gate?.enabled || ic.prime_session?.enabled),
  };
}

module.exports = { backtestStrategyDefinition };
