// ============================================================
// StrategyAgent — Autonomous Strategy Discovery & Evolution
//
// Runs 24/7 discovering, generating, and evolving trading
// strategies using AI brain + web search + genetic evolution.
//
// Capabilities:
//   1. Generate random strategies from indicator recipes
//   2. Search online for new trading ideas
//   3. Ask AI brain to invent novel strategies
//   4. Evolve winners (mutation + crossover)
//   5. Kill losers — survival of the fittest
//   6. Connect to CoderAgent for self-upgrades
//   7. Share winning strategies with the whole team
//
// The agent thinks like a real trader — researches, tests,
// adapts, and never stops hunting for better edge.
// ============================================================

const { BaseAgent } = require('./base-agent');
const {
  generateStrategy,
  evolveStrategy,
  crossoverStrategy,
  createFromAiSuggestion,
  recompileStrategy,
  searchTradingKnowledge,
  aiDiscoverStrategies,
  RECIPE_TEMPLATES,
} = require('./strategy-lab');

const DISCOVERY_INTERVAL_MS = 8 * 60 * 1000; // discover every 8 min
const MAX_POPULATION = 50;  // max strategies alive at once
const MIN_TRADES_TO_JUDGE = 5;
const ELITE_WIN_RATE = 55;  // % — strategies above this survive
const CULL_WIN_RATE = 35;   // % — strategies below this die
const WEB_SEARCH_INTERVAL = 6; // search online every N cycles
const AI_DISCOVER_INTERVAL = 4; // ask AI every N cycles
const EVOLVE_TOP_N = 5;     // evolve from top N strategies

class StrategyAgent extends BaseAgent {
  constructor(options = {}) {
    super('StrategyAgent', options);
    this._profile = {
      description: 'Autonomous strategy researcher. Discovers, generates, evolves, and tests trading strategies 24/7 using AI + web search + genetic evolution.',
      role: 'Strategy Researcher',
      icon: 'strategy',
      skills: [
        { id: 'generate', name: 'Generate', description: 'Create random strategy from indicator recipes', enabled: true },
        { id: 'evolve', name: 'Evolve', description: 'Mutate and crossover winning strategies', enabled: true },
        { id: 'web_search', name: 'Web Research', description: 'Search online for new trading strategies', enabled: true },
        { id: 'ai_discover', name: 'AI Discovery', description: 'Ask AI brain for novel strategy ideas', enabled: true },
        { id: 'backtest', name: 'Backtest', description: 'Test strategies against historical data', enabled: true },
        { id: 'cull', name: 'Cull Losers', description: 'Kill underperforming strategies', enabled: true },
        { id: 'upgrade', name: 'Self-Upgrade', description: 'Request CoderAgent to add new capabilities', enabled: true },
      ],
      config: [
        { key: 'backtestDays', label: 'Backtest Days', type: 'number', value: 14, min: 3, max: 60 },
        { key: 'minWinRate', label: 'Min Win Rate %', type: 'number', value: 50, min: 35, max: 80 },
        { key: 'populationSize', label: 'Max Strategies', type: 'number', value: MAX_POPULATION, min: 10, max: 100 },
        { key: 'autoEvolve', label: 'Auto-Evolve', type: 'boolean', value: true },
        { key: 'webSearch', label: 'Web Research', type: 'boolean', value: true },
        { key: 'aiDiscovery', label: 'AI Discovery', type: 'boolean', value: true },
      ],
    };

    // Strategy population — survival of the fittest
    this._population = [];     // { id, name, recipe, params, scan, results, generation, ... }
    this._graveyard = [];      // dead strategies (for learning)
    this._hallOfFame = [];     // all-time best strategies
    this._cycleCount = 0;
    this._totalGenerated = 0;
    this._totalEvolved = 0;
    this._totalCulled = 0;
    this._totalWebSearches = 0;
    this._totalAiDiscoveries = 0;
    this._bestEverWinRate = 0;
    this._bestEverStrategy = null;
    this._webKnowledge = [];   // accumulated knowledge from web searches
    this._runTimer = null;
  }

  async init() {
    await super.init();
    await this._loadPopulation();

    // Seed initial population if empty
    if (this._population.length === 0) {
      this._seedInitialPopulation();
    }

    this._scheduleNextRun();
    this.log(`Strategy discovery online — ${this._population.length} strategies in population`);
  }

  _seedInitialPopulation() {
    this.addActivity('info', 'Seeding initial strategy population...');
    const count = 15; // start with 15 random strategies
    for (let i = 0; i < count; i++) {
      const strat = generateStrategy();
      this._population.push(strat);
      this._totalGenerated++;
    }
    this.addActivity('success', `Seeded ${count} random strategies from ${RECIPE_TEMPLATES.length} recipe types`);
  }

  _scheduleNextRun() {
    if (this._runTimer) clearTimeout(this._runTimer);
    this._runTimer = setTimeout(async () => {
      if (!this.paused && this._survival?.isAlive !== false) {
        try {
          await this.run();
        } catch (err) {
          this.addActivity('error', `Discovery cycle failed: ${err.message}`);
        }
      }
      this._scheduleNextRun();
    }, DISCOVERY_INTERVAL_MS);
  }

  async shutdown() {
    if (this._runTimer) clearTimeout(this._runTimer);
    await super.shutdown();
  }

  setCoordinator(coordinator) {
    this._coordinator = coordinator;
  }

  async execute(context = {}) {
    this._cycleCount++;
    const coordinator = context.coordinator || this._coordinator;
    const config = this.getConfig();

    this.currentTask = { description: `Discovery cycle #${this._cycleCount}`, startedAt: Date.now() };
    this.addActivity('info', `Discovery cycle #${this._cycleCount} — ${this._population.length} strategies alive`);

    // Phase 1: Web research (every N cycles)
    if (config.webSearch !== false && this._cycleCount % WEB_SEARCH_INTERVAL === 0) {
      await this._phaseWebResearch();
    }

    // Phase 2: AI discovery (every N cycles)
    if (config.aiDiscovery !== false && this._cycleCount % AI_DISCOVER_INTERVAL === 0) {
      await this._phaseAiDiscovery();
    }

    // Phase 3: Generate new random strategies (keep population healthy)
    this._phaseGenerate();

    // Phase 4: Backtest a batch of untested strategies
    const tested = await this._phaseBacktest(config.backtestDays || 14);

    // Phase 5: Evolve winners
    if (config.autoEvolve !== false) {
      this._phaseEvolve();
    }

    // Phase 6: Cull losers
    this._phaseCull(config.minWinRate || 50);

    // Phase 7: Share winners with team
    this._phaseShareWinners(coordinator);

    // Phase 8: Request upgrades from CoderAgent if needed
    await this._phaseRequestUpgrades(coordinator);

    // Save state
    await this._savePopulation();

    const summary = `Cycle #${this._cycleCount}: ${tested} tested, ${this._population.length} alive, best ${this._bestEverWinRate.toFixed(1)}% WR`;
    this.addActivity('success', summary);
    this.currentTask = { description: `Hunting... (${this._population.length} strategies, best ${this._bestEverWinRate.toFixed(1)}% WR)`, startedAt: Date.now() };

    return {
      cycle: this._cycleCount,
      tested,
      alive: this._population.length,
      bestWinRate: this._bestEverWinRate,
      bestStrategy: this._bestEverStrategy?.name || 'N/A',
    };
  }

  // ── Phase 1: Web Research ────────────────────────────────

  async _phaseWebResearch() {
    this.currentTask = { description: 'Researching trading strategies online...', startedAt: Date.now() };
    this.addActivity('info', 'Searching web for new trading strategies...');

    const topics = [
      'crypto scalping strategy EMA RSI',
      'futures trading bollinger bands MACD',
      'smart money concepts swing trading',
      'momentum breakout strategy crypto',
      'mean reversion stochastic RSI crypto',
      'ADX trend following strategy parameters',
      'VWAP trading strategy crypto',
      'ATR volatility breakout strategy',
    ];

    const topic = topics[this._cycleCount % topics.length];
    const knowledge = await searchTradingKnowledge(topic);
    this._totalWebSearches++;

    if (knowledge.length > 0) {
      this._webKnowledge.push(...knowledge);
      // Keep only last 50 knowledge items
      if (this._webKnowledge.length > 50) {
        this._webKnowledge = this._webKnowledge.slice(-50);
      }

      // Create strategies from web knowledge
      let created = 0;
      for (const snippet of knowledge.slice(0, 2)) {
        const strat = createFromAiSuggestion(snippet);
        this._population.push(strat);
        this._totalGenerated++;
        created++;
      }

      this.addActivity('info', `Web research: found ${knowledge.length} insights, created ${created} new strategies from "${topic}"`);
    } else {
      this.addActivity('info', `Web research: no actionable insights for "${topic}"`);
    }
  }

  // ── Phase 2: AI Discovery ────────────────────────────────

  async _phaseAiDiscovery() {
    this.currentTask = { description: 'Asking AI brain for strategy ideas...', startedAt: Date.now() };
    this.addActivity('info', 'Consulting AI brain for novel strategy ideas...');

    const ideas = await aiDiscoverStrategies();
    this._totalAiDiscoveries++;

    if (ideas.length > 0) {
      let created = 0;
      for (const idea of ideas.slice(0, 3)) {
        const strat = createFromAiSuggestion(idea);
        this._population.push(strat);
        this._totalGenerated++;
        created++;
      }
      this.addActivity('success', `AI brain suggested ${ideas.length} ideas, created ${created} strategies`);
    } else {
      this.addActivity('info', 'AI brain had no new ideas this cycle');
    }
  }

  // ── Phase 3: Generate Random ─────────────────────────────

  _phaseGenerate() {
    const maxPop = this.getConfig().populationSize || MAX_POPULATION;
    const deficit = Math.max(0, Math.min(5, maxPop - this._population.length));

    for (let i = 0; i < deficit; i++) {
      const strat = generateStrategy();
      this._population.push(strat);
      this._totalGenerated++;
    }

    if (deficit > 0) {
      this.addActivity('info', `Generated ${deficit} random strategies to fill population`);
    }
  }

  // ── Phase 4: Backtest ────────────────────────────────────

  async _phaseBacktest(days) {
    // Pick strategies that haven't been tested yet (or oldest-tested first)
    const untested = this._population
      .filter(s => !s.results)
      .slice(0, 5); // test 5 per cycle

    if (untested.length === 0) {
      // Re-test oldest strategies
      const sorted = [...this._population]
        .filter(s => s.results)
        .sort((a, b) => (a.results?.testedAt || 0) - (b.results?.testedAt || 0));
      const oldest = sorted.slice(0, 3);
      for (const s of oldest) {
        s.results = null; // mark for re-testing
      }
    }

    const toTest = this._population.filter(s => !s.results).slice(0, 5);
    if (toTest.length === 0) return 0;

    this.currentTask = { description: `Backtesting ${toTest.length} strategies...`, startedAt: Date.now() };

    let tested = 0;
    for (const strat of toTest) {
      try {
        const result = await this._backtestStrategy(strat, days);
        strat.results = { ...result, testedAt: Date.now() };
        tested++;

        // Track hall of fame
        if (result.winRate > this._bestEverWinRate && result.totalTrades >= MIN_TRADES_TO_JUDGE) {
          this._bestEverWinRate = result.winRate;
          this._bestEverStrategy = { name: strat.name, recipe: strat.recipe, params: strat.params };
          this._hallOfFame.push({
            name: strat.name,
            recipe: strat.recipe,
            params: strat.params,
            winRate: result.winRate,
            totalPnl: result.totalPnl,
            trades: result.totalTrades,
            foundAt: Date.now(),
          });
          if (this._hallOfFame.length > 20) this._hallOfFame = this._hallOfFame.slice(-20);
          this.addActivity('success', `NEW BEST: "${strat.name}" — ${result.winRate.toFixed(1)}% WR, ${result.totalPnl.toFixed(2)}% PnL`);
        }

        const label = result.winRate >= ELITE_WIN_RATE ? 'WINNER' : result.winRate >= CULL_WIN_RATE ? 'OK' : 'WEAK';
        this.addActivity(label === 'WINNER' ? 'success' : 'info',
          `[${label}] "${strat.name}" — ${result.winRate.toFixed(1)}% WR, ${result.totalTrades} trades, ${result.totalPnl.toFixed(2)}% PnL`
        );
      } catch (err) {
        strat.results = { error: err.message, testedAt: Date.now(), winRate: 0, totalTrades: 0, totalPnl: 0 };
        this.addActivity('error', `Backtest failed: "${strat.name}" — ${err.message}`);
      }
    }

    return tested;
  }

  async _backtestStrategy(strat, days) {
    const nodeFetch = require('node-fetch');

    // Get top symbols
    let symbols;
    try {
      const res = await nodeFetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
      const tickers = await res.json();
      symbols = tickers
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 8)
        .map(t => t.symbol);
    } catch {
      symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    }

    const allTrades = [];
    const tpPct = strat.params.tp_pct || 0.015;
    const slPct = strat.params.sl_pct || 0.01;

    for (const symbol of symbols) {
      try {
        const endTime = Date.now();
        const startTime = endTime - days * 24 * 60 * 60 * 1000;
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${startTime}&endTime=${endTime}&limit=1500`;
        const res = await nodeFetch(url, { timeout: 10000 });
        if (!res.ok) continue;
        const klines = await res.json();
        if (!klines || klines.length < 100) continue;

        const closes = klines.map(k => parseFloat(k[4]));
        const highs = klines.map(k => parseFloat(k[2]));
        const lows = klines.map(k => parseFloat(k[3]));

        // Run strategy scan
        let inTrade = false;
        let entry = 0, direction = null, entryIdx = 0;

        for (let i = 55; i < closes.length - 1; i++) {
          if (inTrade) {
            const highPnl = direction === 'LONG' ? (highs[i] - entry) / entry : (entry - lows[i]) / entry;
            const lowPnl = direction === 'LONG' ? (lows[i] - entry) / entry : (entry - highs[i]) / entry;

            if (lowPnl <= -slPct) {
              allTrades.push({ symbol, dir: direction, pnl: -slPct, result: 'SL' });
              inTrade = false;
            } else if (highPnl >= tpPct) {
              allTrades.push({ symbol, dir: direction, pnl: tpPct, result: 'TP' });
              inTrade = false;
            } else if (i - entryIdx > 96) {
              const pnl = direction === 'LONG' ? (closes[i] - entry) / entry : (entry - closes[i]) / entry;
              allTrades.push({ symbol, dir: direction, pnl, result: pnl > 0 ? 'WIN' : 'LOSS' });
              inTrade = false;
            }
          }

          if (!inTrade) {
            try {
              const signal = strat.scan(closes, highs, lows, i);
              if (signal) {
                inTrade = true;
                direction = signal;
                entry = closes[i];
                entryIdx = i;
              }
            } catch {
              // Strategy scan error — skip candle
            }
          }
        }
      } catch {
        // Skip symbol
      }
    }

    const wins = allTrades.filter(t => t.pnl > 0).length;
    const losses = allTrades.length - wins;
    const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0) * 100;
    const winRate = allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0;

    return {
      totalTrades: allTrades.length,
      wins,
      losses,
      winRate,
      totalPnl,
      avgPnl: allTrades.length > 0 ? totalPnl / allTrades.length : 0,
      symbols: [...new Set(allTrades.map(t => t.symbol))],
    };
  }

  // ── Phase 5: Evolve Winners ──────────────────────────────

  _phaseEvolve() {
    const winners = this._population
      .filter(s => s.results && s.results.totalTrades >= MIN_TRADES_TO_JUDGE && s.results.winRate >= ELITE_WIN_RATE)
      .sort((a, b) => b.results.winRate - a.results.winRate)
      .slice(0, EVOLVE_TOP_N);

    if (winners.length === 0) return;

    let evolved = 0;
    const maxPop = this.getConfig().populationSize || MAX_POPULATION;

    // Mutation: evolve each winner
    for (const winner of winners.slice(0, 3)) {
      if (this._population.length >= maxPop) break;
      const child = evolveStrategy(winner);
      this._population.push(child);
      this._totalEvolved++;
      evolved++;
    }

    // Crossover: breed top 2 winners
    if (winners.length >= 2 && this._population.length < maxPop) {
      const child = crossoverStrategy(winners[0], winners[1]);
      this._population.push(child);
      this._totalEvolved++;
      evolved++;
    }

    if (evolved > 0) {
      this.addActivity('info', `Evolved ${evolved} new strategies from ${winners.length} winners`);
    }
  }

  // ── Phase 6: Cull Losers ─────────────────────────────────

  _phaseCull(minWinRate) {
    const before = this._population.length;
    const toCull = this._population.filter(s =>
      s.results &&
      s.results.totalTrades >= MIN_TRADES_TO_JUDGE &&
      s.results.winRate < CULL_WIN_RATE
    );

    for (const loser of toCull) {
      this._graveyard.push({
        name: loser.name,
        recipe: loser.recipe,
        params: loser.params,
        winRate: loser.results.winRate,
        reason: `${loser.results.winRate.toFixed(1)}% WR < ${CULL_WIN_RATE}% threshold`,
        killedAt: Date.now(),
      });
      this._totalCulled++;
    }

    // Keep graveyard small
    if (this._graveyard.length > 30) {
      this._graveyard = this._graveyard.slice(-30);
    }

    this._population = this._population.filter(s =>
      !s.results ||
      s.results.totalTrades < MIN_TRADES_TO_JUDGE ||
      s.results.winRate >= CULL_WIN_RATE
    );

    // Also trim population to max size (keep best)
    const maxPop = this.getConfig().populationSize || MAX_POPULATION;
    if (this._population.length > maxPop) {
      this._population.sort((a, b) => {
        const aWR = a.results?.winRate || 0;
        const bWR = b.results?.winRate || 0;
        return bWR - aWR;
      });
      this._population = this._population.slice(0, maxPop);
    }

    const culled = before - this._population.length;
    if (culled > 0) {
      this.addActivity('info', `Culled ${culled} underperforming strategies`);
    }
  }

  // ── Phase 7: Share Winners ───────────────────────────────

  _phaseShareWinners(coordinator) {
    const winners = this._population
      .filter(s => s.results && s.results.winRate >= ELITE_WIN_RATE && s.results.totalTrades >= MIN_TRADES_TO_JUDGE)
      .sort((a, b) => b.results.winRate - a.results.winRate)
      .slice(0, 3);

    for (const winner of winners) {
      // Share with ChartAgent
      if (coordinator?.chartAgent) {
        coordinator.chartAgent.receive({
          from: 'StrategyAgent',
          type: 'discovered-strategy',
          payload: {
            name: winner.name,
            recipe: winner.recipe,
            params: winner.params,
            winRate: winner.results.winRate,
            totalPnl: winner.results.totalPnl,
          },
          ts: Date.now(),
        });
      }

      // Share with RiskAgent
      if (coordinator?.riskAgent) {
        coordinator.riskAgent.receive({
          from: 'StrategyAgent',
          type: 'strategy-risk',
          payload: {
            name: winner.name,
            params: winner.params,
            winRate: winner.results.winRate,
          },
          ts: Date.now(),
        });
      }

      // Share with OptimizerAgent for fine-tuning
      if (coordinator?.optimizerAgent) {
        coordinator.optimizerAgent.receive({
          from: 'StrategyAgent',
          type: 'winning-strategy',
          payload: {
            name: winner.name,
            recipe: winner.recipe,
            params: winner.params,
            winRate: winner.results.winRate,
          },
          ts: Date.now(),
        });
      }
    }

    if (winners.length > 0) {
      const topNames = winners.map(w => `${w.name.split(' [')[0]} (${w.results.winRate.toFixed(0)}%)`).join(', ');
      this.shareWithTeam(`Top strategies: ${topNames}`);
    }
  }

  // ── Phase 8: Self-Upgrade via CoderAgent ─────────────────

  async _phaseRequestUpgrades(coordinator) {
    if (!coordinator?.coderAgent) return;

    // Only request upgrades every 10 cycles
    if (this._cycleCount % 10 !== 0) return;

    // Check if we're stagnating (no improvement in last 5 cycles)
    const recentBest = this._population
      .filter(s => s.results)
      .sort((a, b) => (b.results?.winRate || 0) - (a.results?.winRate || 0))[0];

    if (!recentBest || !recentBest.results) return;

    // If best is below 50% WR, ask CoderAgent for help
    if (recentBest.results.winRate < 50 && this._cycleCount > 20) {
      coordinator.coderAgent.receive({
        from: 'StrategyAgent',
        type: 'upgrade-request',
        payload: {
          reason: 'All strategies underperforming',
          bestWinRate: recentBest.results.winRate,
          populationSize: this._population.length,
          cycleCount: this._cycleCount,
          suggestion: 'Consider adding new indicator types or adjusting parameter ranges in strategy-lab.js',
        },
        ts: Date.now(),
      });
      this.addActivity('info', 'Requested CoderAgent to review strategy capabilities');
    }
  }

  // ── DB Persistence ───────────────────────────────────────

  async _savePopulation() {
    try {
      const { query } = require('../db');

      // Save top strategies to DB
      const top = this._population
        .filter(s => s.results && s.results.totalTrades >= MIN_TRADES_TO_JUDGE)
        .sort((a, b) => (b.results?.winRate || 0) - (a.results?.winRate || 0))
        .slice(0, 20);

      for (const strat of top) {
        await query(
          `INSERT INTO discovered_strategies (strategy_id, name, recipe, params, win_rate, total_pnl, total_trades, generation, source, parent_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (strategy_id) DO UPDATE SET
             win_rate = $5, total_pnl = $6, total_trades = $7, updated_at = NOW()`,
          [
            strat.id, strat.name, strat.recipe, JSON.stringify(strat.params),
            strat.results.winRate, strat.results.totalPnl, strat.results.totalTrades,
            strat.generation || 1, strat.source || 'random', strat.parentId || null,
          ]
        ).catch(() => {});
      }

      // Save population metadata for restore
      const popData = this._population.map(s => ({
        id: s.id, name: s.name, recipe: s.recipe, params: s.params,
        generation: s.generation, parentId: s.parentId, source: s.source,
        results: s.results, createdAt: s.createdAt,
      }));

      await this.remember('population', JSON.stringify(popData.slice(0, 50)), 'state').catch(() => {});
      await this.remember('cycle_count', this._cycleCount, 'stats').catch(() => {});
      await this.remember('best_wr', this._bestEverWinRate, 'stats').catch(() => {});
      await this.remember('total_generated', this._totalGenerated, 'stats').catch(() => {});
      await this.remember('total_evolved', this._totalEvolved, 'stats').catch(() => {});
      await this.remember('total_culled', this._totalCulled, 'stats').catch(() => {});

      if (this._hallOfFame.length > 0) {
        await this.remember('hall_of_fame', JSON.stringify(this._hallOfFame.slice(-10)), 'state').catch(() => {});
      }
    } catch (err) {
      this.logError(`Failed to save population: ${err.message}`);
    }
  }

  async _loadPopulation() {
    try {
      const popStr = await this.recall('population');
      if (popStr) {
        const popData = typeof popStr === 'string' ? JSON.parse(popStr) : popStr;
        for (const saved of popData) {
          const strat = recompileStrategy(saved);
          if (strat) {
            this._population.push(strat);
          }
        }
      }

      const cc = await this.recall('cycle_count');
      if (cc !== null) this._cycleCount = parseInt(cc) || 0;
      const bw = await this.recall('best_wr');
      if (bw !== null) this._bestEverWinRate = parseFloat(bw) || 0;
      const tg = await this.recall('total_generated');
      if (tg !== null) this._totalGenerated = parseInt(tg) || 0;
      const te = await this.recall('total_evolved');
      if (te !== null) this._totalEvolved = parseInt(te) || 0;
      const tc = await this.recall('total_culled');
      if (tc !== null) this._totalCulled = parseInt(tc) || 0;

      const hof = await this.recall('hall_of_fame');
      if (hof) {
        this._hallOfFame = typeof hof === 'string' ? JSON.parse(hof) : hof;
      }
    } catch (err) {
      this.logError(`Failed to load population: ${err.message}`);
    }
  }

  // ── Public API ───────────────────────────────────────────

  getPopulation() {
    return this._population
      .filter(s => s.results)
      .sort((a, b) => (b.results?.winRate || 0) - (a.results?.winRate || 0))
      .map(s => ({
        id: s.id,
        name: s.name,
        recipe: s.recipe,
        source: s.source,
        generation: s.generation,
        winRate: s.results?.winRate || 0,
        totalPnl: s.results?.totalPnl || 0,
        trades: s.results?.totalTrades || 0,
        status: !s.results ? 'untested' :
          s.results.winRate >= ELITE_WIN_RATE ? 'elite' :
          s.results.winRate >= CULL_WIN_RATE ? 'alive' : 'dying',
      }));
  }

  getHallOfFame() {
    return this._hallOfFame.slice(-10).reverse();
  }

  getHealth() {
    const alive = this._population.length;
    const tested = this._population.filter(s => s.results).length;
    const elite = this._population.filter(s => s.results?.winRate >= ELITE_WIN_RATE).length;

    return {
      ...super.getHealth(),
      cycleCount: this._cycleCount,
      populationSize: alive,
      testedCount: tested,
      eliteCount: elite,
      totalGenerated: this._totalGenerated,
      totalEvolved: this._totalEvolved,
      totalCulled: this._totalCulled,
      totalWebSearches: this._totalWebSearches,
      totalAiDiscoveries: this._totalAiDiscoveries,
      bestEverWinRate: this._bestEverWinRate,
      bestEverStrategy: this._bestEverStrategy?.name || 'N/A',
      hallOfFameSize: this._hallOfFame.length,
      webKnowledgeItems: this._webKnowledge.length,
    };
  }

  async explain(question) {
    const pop = this.getPopulation();
    const elite = pop.filter(s => s.status === 'elite');
    const hof = this.getHallOfFame();

    const lines = [
      `I'm **${this.name}** — the autonomous strategy researcher.`,
      ``,
      `**How I work:** I generate, discover (AI + web search), evolve, and cull trading strategies 24/7.`,
      `Survival of the fittest — only the best live. The rest die.`,
      ``,
      `**Stats:**`,
      `- Discovery cycles: ${this._cycleCount}`,
      `- Generated: ${this._totalGenerated} | Evolved: ${this._totalEvolved} | Culled: ${this._totalCulled}`,
      `- Web searches: ${this._totalWebSearches} | AI discoveries: ${this._totalAiDiscoveries}`,
      `- Population: ${this._population.length} alive (${elite.length} elite)`,
      `- Best ever: ${this._bestEverWinRate.toFixed(1)}% WR`,
      ``,
    ];

    if (elite.length > 0) {
      lines.push(`**Elite Strategies (>${ELITE_WIN_RATE}% WR):**`);
      for (const s of elite.slice(0, 5)) {
        lines.push(`- ${s.name}: ${s.winRate.toFixed(1)}% WR, ${s.totalPnl.toFixed(2)}% PnL (gen ${s.generation}, via ${s.source})`);
      }
      lines.push('');
    }

    if (hof.length > 0) {
      lines.push(`**Hall of Fame:**`);
      for (const h of hof.slice(0, 5)) {
        lines.push(`- ${h.name}: ${h.winRate.toFixed(1)}% WR, ${h.totalPnl.toFixed(2)}% PnL`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = { StrategyAgent };
