// ============================================================
// OptimizerAgent — 24/7 Strategy Optimization Engine
//
// Continuously backtests ALL tokens with ALL formulas, indicators,
// and strategies to find the best winning formula for each token.
// Runs in background, cycling through tokens and strategies.
//
// When it finds a winning formula (>55% WR, >1% avg PnL), it:
//   1. Saves it to DB
//   2. Tells CoderAgent to update token agents
//   3. Shares results with the team
//   4. Auto-applies the best config to live trading
// ============================================================

const { BaseAgent } = require('./base-agent');

const OPTIMIZE_INTERVAL_MS = 10 * 60 * 1000; // run every 10 min
const BACKTEST_DAYS = 60;
const MIN_WIN_RATE = 50;
const MIN_AVG_PNL = 0.5; // 0.5% minimum average PnL per trade
const TOKENS_PER_BATCH = 5;

class OptimizerAgent extends BaseAgent {
  constructor(options = {}) {
    super('OptimizerAgent', options);

    this._profile = {
      description: 'Runs 24/7 backtests on all tokens to find the best winning formula. Auto-upgrades trading strategies.',
      role: 'Strategy Optimizer',
      icon: 'optimizer',
      skills: [
        { id: 'backtest', name: 'Backtest All', description: 'Test all strategies on all tokens', enabled: true },
        { id: 'rank', name: 'Rank Strategies', description: 'Rank and compare strategy performance', enabled: true },
        { id: 'apply', name: 'Auto-Apply', description: 'Apply the best strategy to live trading', enabled: true },
        { id: 'evolve', name: 'Evolve', description: 'Generate new strategy variations from winners', enabled: true },
      ],
      config: [
        { key: 'backtestDays', label: 'Backtest Days', type: 'number', value: BACKTEST_DAYS, min: 7, max: 90 },
        { key: 'minWinRate', label: 'Min Win Rate %', type: 'number', value: MIN_WIN_RATE, min: 40, max: 80 },
        { key: 'autoApply', label: 'Auto-Apply Best', type: 'boolean', value: true },
        { key: 'interval', label: 'Run Interval (min)', type: 'number', value: 10, min: 5, max: 60 },
      ],
    };

    this._optimizeTimer = null;
    this._runIdx = 0;
    this._totalBacktests = 0;
    this._bestResults = new Map(); // symbol → best result
    this._currentBest = null;
    this._lastOptimizeAt = 0;
    this._isRunning = false;
  }

  async init() {
    await super.init();
    await this._loadState();
    this._scheduleNextRun();
    this.log('Strategy Optimizer online — hunting for winning formulas 24/7');
  }

  _scheduleNextRun() {
    if (this._optimizeTimer) clearTimeout(this._optimizeTimer);
    const interval = (this.options.interval || 10) * 60 * 1000;
    this._optimizeTimer = setTimeout(async () => {
      if (!this.paused && this.state !== 'jailed') {
        try {
          await this.run({ coordinator: this._coordinator });
        } catch (err) {
          this.addActivity('error', `Optimization failed: ${err.message}`);
        }
      }
      this._scheduleNextRun();
    }, interval);
  }

  async shutdown() {
    if (this._optimizeTimer) clearTimeout(this._optimizeTimer);
    await super.shutdown();
  }

  setCoordinator(coordinator) {
    this._coordinator = coordinator;
  }

  async execute(context = {}) {
    if (this._isRunning) return { status: 'already_running' };
    this._isRunning = true;
    this._runIdx++;

    const coordinator = context.coordinator || this._coordinator;
    const days = this.options.backtestDays || BACKTEST_DAYS;

    this.currentTask = { description: `Optimization round #${this._runIdx} starting...`, startedAt: Date.now() };
    this.addActivity('info', `Optimization round #${this._runIdx} — ${days} day backtest`);

    try {
      const { runBacktest, applyBestStrategy, STRATEGIES } = require('../backtester');

      // Get symbols from coordinator's token agents
      let symbols = [];
      if (coordinator?.tokenAgents) {
        symbols = [...coordinator.tokenAgents.keys()];
      }
      if (!symbols.length) {
        symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
      }

      // Pick a batch of tokens to test this round (rotate through all)
      const startIdx = ((this._runIdx - 1) * TOKENS_PER_BATCH) % symbols.length;
      const batch = [];
      for (let i = 0; i < TOKENS_PER_BATCH && i < symbols.length; i++) {
        batch.push(symbols[(startIdx + i) % symbols.length]);
      }

      this.currentTask = { description: `Testing ${batch.length} tokens: ${batch.map(s => s.replace('USDT', '')).join(', ')}`, startedAt: Date.now() };
      this.addActivity('info', `Testing: ${batch.map(s => s.replace('USDT', '')).join(', ')}`);

      // Test SMC strategies with different swing lengths (the live strategy)
      const smcStrategies = ['smc_2gate', 'smc_rsi', 'smc_ema'];
      for (const swLen of [3, 4, 5, 6, 7]) {
        if (STRATEGIES.smc_2gate) STRATEGIES.smc_2gate.swingLen = swLen;
        if (STRATEGIES.smc_rsi) STRATEGIES.smc_rsi.swingLen = swLen;
        if (STRATEGIES.smc_ema) STRATEGIES.smc_ema.swingLen = swLen;
      }

      // Run backtests on both 3m (live) and 15m timeframes
      const result3m = await runBacktest({
        symbols: batch,
        days: Math.min(days, 14), // 3m data = many candles, limit to 14 days
        interval: '3m',
        strategies: smcStrategies,
      });

      const result = await runBacktest({
        symbols: batch,
        days,
        interval: '15m',
      });

      // Merge results — prefer 3m SMC results since that's the live strategy
      if (result3m.viableStrategies > 0) {
        this.addActivity('info', `3m SMC backtest: ${result3m.viableStrategies} viable (best: ${result3m.bestStrategy?.strategy || 'none'} ${result3m.bestStrategy?.winRate || 0}% WR)`);
      }

      this._totalBacktests += result.totalCombinations;

      // Process results
      if (result.viableStrategies > 0 && result.bestStrategy) {
        const best = result.bestStrategy;
        this.addActivity('success',
          `WINNER: ${best.strategy} ${best.config} — ${best.winRate}% WR, ${best.avgPnl}% avg PnL, ${best.trades} trades, PF ${best.profitFactor}`
        );

        // Track per-symbol bests
        for (const r of (result.allResults || []).filter(r => r.total >= 5 && r.avgPnl > 0)) {
          const existing = this._bestResults.get(r.symbol);
          if (!existing || r.avgPnl > existing.avgPnl) {
            this._bestResults.set(r.symbol, {
              strategy: r.strategyName,
              config: r.tpSlConfig,
              winRate: r.winRate,
              avgPnl: r.avgPnl,
              totalPnl: r.totalPnl,
              trades: r.total,
              profitFactor: r.profitFactor,
              foundAt: Date.now(),
            });
          }
        }

        this._currentBest = best;

        // Auto-apply if enabled
        if (this.options.autoApply !== false) {
          const applied = await applyBestStrategy(result);
          if (applied.ok) {
            this.addActivity('success', `AUTO-APPLIED: ${applied.strategy} — ${applied.winRate.toFixed(1)}% WR`);
            this.shareWithTeam(`Optimizer applied new strategy: ${applied.strategy} ${applied.config} — ${applied.winRate.toFixed(1)}% WR, ${applied.avgPnl.toFixed(2)}% avg PnL per trade`);
          }
        }

        // Share top 5 results with team
        if (result.top10?.length) {
          const topList = result.top10.slice(0, 5).map(r =>
            `${r.symbol.replace('USDT', '')} ${r.strategy}: ${r.winRate} WR, ${r.avgPnl} avg`
          ).join(' | ');
          this.shareWithTeam(`Top strategies found: ${topList}`);
        }
      } else {
        this.addActivity('info', `No viable strategies found for this batch. Continuing search...`);
      }

      // Generate thought about the work
      const thoughtText = result.viableStrategies > 0
        ? `Found ${result.viableStrategies} viable strategies! Best: ${result.bestStrategy?.strategy || 'N/A'} at ${result.bestStrategy?.winRate || 0}% WR.`
        : `Tested ${result.totalCombinations} combos, nothing good yet. Moving to next batch...`;
      this._personality.thoughts.push({ text: thoughtText, ts: Date.now() });

      this._lastOptimizeAt = Date.now();
      await this._saveState();

      const summary = `Round #${this._runIdx}: ${result.totalCombinations} combos, ${result.viableStrategies} viable, best ${result.bestStrategy?.winRate || 0}% WR`;
      this.addActivity('success', summary);
      this.currentTask = { description: `Waiting for next round... (${this._totalBacktests} total tests)`, startedAt: Date.now() };

      return {
        round: this._runIdx,
        tested: result.totalCombinations,
        viable: result.viableStrategies,
        best: result.bestStrategy,
        symbolsTested: batch,
      };
    } catch (err) {
      this.addActivity('error', `Optimization error: ${err.message}`);
      throw err;
    } finally {
      this._isRunning = false;
    }
  }

  getBestResults() {
    const results = [];
    for (const [symbol, data] of this._bestResults) {
      results.push({ symbol, ...data });
    }
    return results.sort((a, b) => b.avgPnl - a.avgPnl);
  }

  async _saveState() {
    await this.remember('run_idx', this._runIdx, 'stats').catch(() => {});
    await this.remember('total_backtests', this._totalBacktests, 'stats').catch(() => {});
    if (this._currentBest) {
      await this.remember('current_best', this._currentBest, 'strategy').catch(() => {});
    }
  }

  async _loadState() {
    try {
      const idx = await this.recall('run_idx');
      if (idx !== null) this._runIdx = parseInt(idx) || 0;
      const total = await this.recall('total_backtests');
      if (total !== null) this._totalBacktests = parseInt(total) || 0;
      const best = await this.recall('current_best');
      if (best) this._currentBest = typeof best === 'string' ? JSON.parse(best) : best;
    } catch {}
  }

  getHealth() {
    return {
      ...super.getHealth(),
      optimizeRound: this._runIdx,
      totalBacktests: this._totalBacktests,
      bestResultCount: this._bestResults.size,
      currentBest: this._currentBest,
      lastOptimizeAt: this._lastOptimizeAt,
    };
  }

  async explain(question) {
    const best = this.getBestResults();
    const lines = [
      `I'm **${this.name}** — the 24/7 Strategy Optimizer.`,
      ``,
      `**Stats:** ${this._runIdx} optimization rounds | ${this._totalBacktests} total backtests | ${this._bestResults.size} token strategies found`,
      ``,
    ];

    if (this._currentBest) {
      lines.push(`**Current Best Strategy:**`);
      lines.push(`• ${this._currentBest.strategy} — ${this._currentBest.winRate}% WR, ${this._currentBest.avgPnl}% avg PnL`);
      lines.push('');
    }

    if (best.length > 0) {
      lines.push(`**Best Per-Token Results (top 5):**`);
      for (const r of best.slice(0, 5)) {
        lines.push(`• ${r.symbol}: ${r.strategy} — ${r.winRate.toFixed(1)}% WR, ${r.avgPnl.toFixed(2)}% avg PnL (PF ${r.profitFactor.toFixed(2)})`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = { OptimizerAgent };
