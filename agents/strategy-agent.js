// ============================================================
// StrategyAgent — Discovers and backtests new trading strategies
//
// Runs 24/7, testing parameter variations against historical data.
// Saves results to DB and logs for the user to review.
// Shares winning strategies with ChartAgent and RiskAgent.
// ============================================================

const { BaseAgent } = require('./base-agent');

const STRATEGY_VARIATIONS = [
  // Swing length variations
  { name: 'Tight Swings',    params: { swing_4h: 4, swing_1h: 5, swing_15m: 10, swing_3m: 3, swing_1m: 3 } },
  { name: 'Wide Swings',     params: { swing_4h: 8, swing_1h: 9, swing_15m: 18, swing_3m: 7, swing_1m: 5 } },
  { name: 'Ultra Tight',     params: { swing_4h: 3, swing_1h: 4, swing_15m: 8,  swing_3m: 3, swing_1m: 2 } },
  { name: 'Balanced',        params: { swing_4h: 6, swing_1h: 7, swing_15m: 14, swing_3m: 5, swing_1m: 4 } },
  // TP/SL variations
  { name: 'Tight SL Wide TP',  params: { sl_pct: 0.008, tp_pct: 0.025 } },
  { name: 'Wide SL Tight TP',  params: { sl_pct: 0.020, tp_pct: 0.012 } },
  { name: 'Equal SL/TP',       params: { sl_pct: 0.015, tp_pct: 0.015 } },
  { name: 'Scalp Mode',        params: { sl_pct: 0.005, tp_pct: 0.008 } },
  { name: 'Swing Mode',        params: { sl_pct: 0.025, tp_pct: 0.040 } },
  // Trailing SL variations
  { name: 'Aggressive Trail',  params: { trail_start: 0.8, trail_step: 0.6 } },
  { name: 'Conservative Trail', params: { trail_start: 2.0, trail_step: 1.5 } },
  { name: 'Standard Trail',   params: { trail_start: 1.3, trail_step: 1.0 } },
  // Combined variations
  { name: 'Scalp Tight',      params: { swing_15m: 8, swing_3m: 3, sl_pct: 0.006, tp_pct: 0.010, trail_start: 0.6, trail_step: 0.5 } },
  { name: 'Swing Wide',       params: { swing_15m: 18, swing_3m: 7, sl_pct: 0.020, tp_pct: 0.035, trail_start: 1.8, trail_step: 1.2 } },
  { name: 'Balanced Optimal', params: { swing_15m: 12, swing_3m: 5, sl_pct: 0.012, tp_pct: 0.020, trail_start: 1.0, trail_step: 0.8 } },
];

class StrategyAgent extends BaseAgent {
  constructor(options = {}) {
    super('StrategyAgent', options);
    this._profile = {
      description: 'Discovers new strategies by backtesting parameter variations 24/7.',
      role: 'Strategy Researcher',
      icon: 'strategy',
      skills: [
        { id: 'backtest', name: 'Backtest', description: 'Run backtests on strategy variations', enabled: true },
        { id: 'discover', name: 'Discover', description: 'Find new winning parameter sets', enabled: true },
        { id: 'share', name: 'Share Results', description: 'Share winning strategies with team', enabled: true },
      ],
      config: [
        { key: 'backtestDays', label: 'Backtest Days', type: 'number', value: 14, min: 3, max: 60 },
        { key: 'minWinRate', label: 'Min Win Rate %', type: 'number', value: 55, min: 40, max: 80 },
        { key: 'topCoins', label: 'Coins to Test', type: 'number', value: 10, min: 3, max: 30 },
      ],
    };
    this.testsRun = 0;
    this.strategiesFound = 0;
    this.bestWinRate = 0;
    this.currentVariationIdx = 0;
    this._runTimer = null;
  }

  async init() {
    await super.init();
    // Start 24/7 background loop — run a backtest every 10 minutes
    this._scheduleNextRun();
    this.log('Strategy discovery loop started (every 10 min)');
  }

  _scheduleNextRun() {
    if (this._runTimer) clearTimeout(this._runTimer);
    this._runTimer = setTimeout(async () => {
      if (!this.paused) {
        try {
          await this.run();
        } catch (err) {
          this.addActivity('error', `Auto-run failed: ${err.message}`);
        }
      }
      this._scheduleNextRun();
    }, 10 * 60 * 1000); // every 10 minutes
  }

  async shutdown() {
    if (this._runTimer) clearTimeout(this._runTimer);
    await super.shutdown();
  }

  async execute(context = {}) {
    // Pick next strategy variation to test
    const variation = STRATEGY_VARIATIONS[this.currentVariationIdx % STRATEGY_VARIATIONS.length];
    this.currentVariationIdx++;

    const config = this.getConfig();
    const backtestDays = config.backtestDays || 14;
    const minWinRate = config.minWinRate || 55;
    const topCoins = config.topCoins || 10;

    this.currentTask = { description: `Testing "${variation.name}"...`, startedAt: Date.now() };
    this.addActivity('info', `Backtesting strategy: "${variation.name}" (${backtestDays}d, ${topCoins} coins)`);

    const startTime = Date.now();

    try {
      const result = await this._runBacktest(variation, backtestDays, topCoins);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.testsRun++;

      // Save to DB
      await this._saveResult(variation.name, variation.params, result);

      const isWinner = result.winRate >= minWinRate && result.totalTrades >= 5;
      if (isWinner) this.strategiesFound++;
      if (result.winRate > this.bestWinRate) this.bestWinRate = result.winRate;

      const summary = `"${variation.name}" — ${result.winRate.toFixed(1)}% WR, ${result.totalTrades} trades, ${result.totalPnl >= 0 ? '+' : ''}${result.totalPnl.toFixed(2)}% PnL, ${elapsed}s`;

      if (isWinner) {
        this.addActivity('success', `WINNER: ${summary}`);
        this.log(`STRATEGY WINNER: ${summary}`);

        // Share winning strategy with team
        if (context.coordinator) {
          this._shareWinningStrategy(context.coordinator, variation, result);
        }
        this.shareWithTeam(`Strategy found: "${variation.name}" — ${result.winRate.toFixed(1)}% WR, ${result.totalPnl.toFixed(2)}% PnL over ${backtestDays}d`);
        this.learn('strategy', variation.params, { winRate: result.winRate, pnl: result.totalPnl }, `"${variation.name}" won with ${result.winRate.toFixed(1)}% WR`, result.winRate).catch(() => {});
      } else {
        this.addActivity('info', `TESTED: ${summary}`);
      }

      this.currentTask = null;
      return { variation: variation.name, ...result, isWinner, elapsed: parseFloat(elapsed) };

    } catch (err) {
      this.addActivity('error', `Backtest failed for "${variation.name}": ${err.message}`);
      this.currentTask = null;
      return { variation: variation.name, error: err.message };
    }
  }

  async _runBacktest(variation, days, topCoins) {
    const fetch = require('node-fetch');

    // Fetch top coins by volume
    let symbols;
    try {
      const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
      const tickers = await res.json();
      symbols = tickers
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, topCoins)
        .map(t => t.symbol);
    } catch {
      symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    }

    // Fetch historical klines for each symbol
    const trades = [];
    const WALLET = 1000;
    const RISK_PCT = 0.10;
    const LEVERAGE = 20;
    const SL_PCT = variation.params.sl_pct || 0.015;
    const TP_PCT = variation.params.tp_pct || 0.015;
    const SWING_15M = variation.params.swing_15m || 14;

    for (const symbol of symbols) {
      try {
        // Fetch 15m klines
        const endTime = Date.now();
        const startTime = endTime - days * 24 * 60 * 60 * 1000;
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${startTime}&endTime=${endTime}&limit=1500`;
        const res = await fetch(url, { timeout: 10000 });
        if (!res.ok) continue;
        const klines = await res.json();
        if (!klines || klines.length < 100) continue;

        // Simple swing-based backtest simulation
        const candles = klines.map(k => ({
          open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5]), time: k[0],
        }));

        // Detect swings and generate signals
        const swingLen = SWING_15M;
        for (let i = swingLen * 2 + 10; i < candles.length - 20; i++) {
          const window = candles.slice(i - swingLen * 2, i);
          const recent = window.slice(-3);

          // Simple trend: 2 of 3 recent candles direction
          const greens = recent.filter(c => c.close > c.open).length;
          const direction = greens >= 2 ? 'LONG' : greens <= 1 ? 'SHORT' : null;
          if (!direction) continue;

          // Only take signals every 10 candles min
          const lastTradeIdx = trades.length ? trades[trades.length - 1]._idx || 0 : 0;
          if (i - lastTradeIdx < 10) continue;

          const entry = candles[i].close;
          const isLong = direction === 'LONG';
          const sl = isLong ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
          const tp = isLong ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);

          // Simulate forward 20 candles to see outcome
          let exitPrice = entry;
          let exitReason = 'timeout';
          for (let j = i + 1; j < Math.min(i + 20, candles.length); j++) {
            const c = candles[j];
            if (isLong) {
              if (c.low <= sl) { exitPrice = sl; exitReason = 'sl'; break; }
              if (c.high >= tp) { exitPrice = tp; exitReason = 'tp'; break; }
            } else {
              if (c.high >= sl) { exitPrice = sl; exitReason = 'sl'; break; }
              if (c.low <= tp) { exitPrice = tp; exitReason = 'tp'; break; }
            }
            exitPrice = c.close;
          }

          const pnlPct = isLong
            ? (exitPrice - entry) / entry * 100 * LEVERAGE
            : (entry - exitPrice) / entry * 100 * LEVERAGE;

          trades.push({
            symbol, direction, entry, exitPrice, pnlPct,
            exitReason, isWin: pnlPct > 0, _idx: i,
          });
        }
      } catch {
        // Skip symbol on error
      }
    }

    const wins = trades.filter(t => t.isWin).length;
    const losses = trades.length - wins;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const totalPnl = trades.reduce((sum, t) => sum + t.pnlPct, 0);
    const avgWin = wins > 0 ? trades.filter(t => t.isWin).reduce((s, t) => s + t.pnlPct, 0) / wins : 0;
    const avgLoss = losses > 0 ? trades.filter(t => !t.isWin).reduce((s, t) => s + t.pnlPct, 0) / losses : 0;
    const maxDrawdown = this._calcMaxDrawdown(trades);

    return {
      totalTrades: trades.length, wins, losses, winRate,
      totalPnl, avgWin, avgLoss, maxDrawdown,
      symbols: [...new Set(trades.map(t => t.symbol))],
      topTrades: trades.sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5).map(t => ({
        symbol: t.symbol, direction: t.direction, pnl: t.pnlPct.toFixed(2) + '%', exit: t.exitReason,
      })),
    };
  }

  _calcMaxDrawdown(trades) {
    let peak = 0, maxDD = 0, cumPnl = 0;
    for (const t of trades) {
      cumPnl += t.pnlPct;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
  }

  async _saveResult(name, params, result) {
    try {
      const { query } = require('../db');
      await query(
        `INSERT INTO strategy_backtests (name, params, total_trades, wins, losses, win_rate, total_pnl, avg_win, avg_loss, max_drawdown, symbols, top_trades)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [name, JSON.stringify(params), result.totalTrades, result.wins, result.losses,
         result.winRate, result.totalPnl, result.avgWin, result.avgLoss, result.maxDrawdown,
         JSON.stringify(result.symbols || []), JSON.stringify(result.topTrades || [])]
      );
    } catch (err) {
      this.logError(`Failed to save backtest result: ${err.message}`);
    }
  }

  _shareWinningStrategy(coordinator, variation, result) {
    const payload = {
      name: variation.name,
      params: variation.params,
      winRate: result.winRate,
      totalPnl: result.totalPnl,
      trades: result.totalTrades,
    };

    // Tell ChartAgent about winning parameters
    if (coordinator.chartAgent) {
      coordinator.chartAgent.receive({
        from: 'StrategyAgent', type: 'winning-strategy',
        payload, ts: Date.now(),
      });
    }

    // Tell RiskAgent about the strategy's risk profile
    if (coordinator.riskAgent) {
      coordinator.riskAgent.receive({
        from: 'StrategyAgent', type: 'strategy-risk',
        payload: { ...payload, maxDrawdown: result.maxDrawdown },
        ts: Date.now(),
      });
    }
  }

  getHealth() {
    return {
      ...super.getHealth(),
      testsRun: this.testsRun,
      strategiesFound: this.strategiesFound,
      bestWinRate: this.bestWinRate,
      currentVariation: STRATEGY_VARIATIONS[this.currentVariationIdx % STRATEGY_VARIATIONS.length]?.name || 'N/A',
      nextVariationIdx: this.currentVariationIdx % STRATEGY_VARIATIONS.length,
    };
  }
}

module.exports = { StrategyAgent };
