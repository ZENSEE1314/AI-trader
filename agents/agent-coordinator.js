// ============================================================
// AgentCoordinator — Orchestrates all trading agents
//
// Phase 3: Full agent pipeline
//   1. SentimentAgent fetches market mood
//   2. ChartAgent scans for signals (via smc-engine)
//   3. SentimentAgent enriches signals with sentiment data
//   4. RiskAgent filters signals (position limits, correlation, drawdown)
//   5. TraderAgent executes approved signals + manages positions
// ============================================================

const { BaseAgent, AGENT_STATES } = require('./base-agent');
const { ChartAgent } = require('./chart-agent');
const { TraderAgent } = require('./trader-agent');
const { RiskAgent } = require('./risk-agent');
const { SentimentAgent } = require('./sentiment-agent');
const { AccountantAgent } = require('./accountant-agent');
const { TokenAgent } = require('./token-agent');
const { KronosAgent } = require('./kronos-agent');
const { StrategyAgent } = require('./strategy-agent');
const { PoliceAgent } = require('./police-agent');
const { CoderAgent } = require('./coder-agent');
const { OptimizerAgent } = require('./optimizer-agent');

const SELF_IMPROVE_LESSONS = {
  excessive_losses: 'I will reduce position sizes and wait for stronger confirmations.',
  high_error_rate: 'I will validate inputs more carefully and handle edge cases.',
  ignoring_risk: 'I will always respect RiskAgent rejection — safety first.',
  stale_agent: 'I will stay active and report status regularly.',
  repeated_failures: 'I will diagnose root causes instead of repeating failed patterns.',
};

// Top tokens that always get their own agent
const DEFAULT_TOKEN_AGENTS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'SUIUSDT', 'LINKUSDT',
];

class AgentCoordinator extends BaseAgent {
  constructor(options = {}) {
    super('Coordinator', options);
    this.chartAgent = new ChartAgent(options);
    this.traderAgent = new TraderAgent(options);
    this.riskAgent = new RiskAgent(options);
    this.sentimentAgent = new SentimentAgent(options);
    this.accountantAgent = new AccountantAgent(options);
    this.kronosAgent = new KronosAgent(options);
    this.strategyAgent = new StrategyAgent(options);
    this.policeAgent = new PoliceAgent(options);
    this.coderAgent = new CoderAgent(options);
    this.optimizerAgent = new OptimizerAgent(options);

    // Agent registry — order matters for display
    this._agents = new Map();
    this._agents.set('sentiment', this.sentimentAgent);
    this._agents.set('chart', this.chartAgent);
    this._agents.set('risk', this.riskAgent);
    this._agents.set('trader', this.traderAgent);
    this._agents.set('accountant', this.accountantAgent);
    this._agents.set('kronos', this.kronosAgent);
    this._agents.set('strategy', this.strategyAgent);
    this._agents.set('police', this.policeAgent);
    this._agents.set('coder', this.coderAgent);
    this._agents.set('optimizer', this.optimizerAgent);

    // Wire up inter-agent events
    this.chartAgent.on('signals', (data) => {
      this.traderAgent.receive({
        from: 'ChartAgent',
        type: 'signals',
        payload: data,
        ts: Date.now(),
      });
    });

    this.cycleRunning = false;
    this.tokenAgents = new Map(); // symbol → TokenAgent

    // CEO always-on state
    this._ceoTimer = null;
    this._microCycleRunning = false;
    this._microCycleCount = 0;
    this._lastFullCycleAt = 0;
    this._tokenScanQueue = [];     // round-robin scan queue
    this._tokenScanIdx = 0;
    this._tokenScanTimer = null;

    // Intervals
    this.MICRO_CYCLE_MS = 30_000;           // CEO checks every 30s
    this.TOKEN_SCAN_INTERVAL_MS = 30_000;   // each token scanned every 30s
    this.FULL_CYCLE_INTERVAL_MS = 60_000;   // full pipeline every 60s
    this.TOKEN_BATCH_SIZE = 5;              // scan 5 tokens per tick to stagger load
  }

  async init() {
    this.log('Initializing agent framework...');

    for (const [name, agent] of this._agents) {
      await agent.init();
      await agent.loadRpgProfile().catch(() => {});
      this.log(`  ${name}: initialized (Lv.${agent._rpg.level})`);
    }

    // Create dedicated token agents for top coins by volume
    // Dashboard enabled/disabled is per-user trading preference — scanning is global
    for (const symbol of DEFAULT_TOKEN_AGENTS) {
      this.addTokenAgent(symbol);
    }

    // Fetch top coins by volume from Binance and create agents for all of them
    try {
      const fetch = require('node-fetch');
      const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
      if (res.ok) {
        const tickers = await res.json();
        // Get banned tokens from DB
        const { query } = require('../db');
        const bannedRows = await query('SELECT symbol FROM global_token_settings WHERE banned = true').catch(() => []);
        const banned = new Set(bannedRows.map(r => r.symbol));

        const topCoins = tickers
          .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
          .filter(t => !banned.has(t.symbol))
          .filter(t => parseFloat(t.quoteVolume) >= 10_000_000)
          .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
          .slice(0, 50)
          .map(t => t.symbol);

        for (const sym of topCoins) {
          if (!this.tokenAgents.has(sym)) this.addTokenAgent(sym);
        }
        this.log(`Loaded top ${topCoins.length} tokens by volume`);
      }
    } catch (err) {
      this.logError(`Failed to fetch top tokens: ${err.message}`);
      // Fallback: load from global_token_settings
      try {
        const { query } = require('../db');
        const rows = await query('SELECT symbol FROM global_token_settings WHERE banned = false');
        for (const r of rows) {
          if (!this.tokenAgents.has(r.symbol)) this.addTokenAgent(r.symbol);
        }
      } catch {}
    }

    // Start StrategyAgent 24/7 background loop
    this.strategyAgent.init().catch(err => this.logError(`StrategyAgent init failed: ${err.message}`));

    // Start PoliceAgent patrol loop
    this.policeAgent.init().catch(err => this.logError(`PoliceAgent init failed: ${err.message}`));

    // Start CoderAgent self-healing loop
    this.coderAgent.setCoordinator(this);
    this.coderAgent.init().catch(err => this.logError(`CoderAgent init failed: ${err.message}`));

    // Start OptimizerAgent 24/7 strategy optimization loop
    this.optimizerAgent.setCoordinator(this);
    this.optimizerAgent.init().catch(err => this.logError(`OptimizerAgent init failed: ${err.message}`));

    this.log(`Agent framework ready — ${this._agents.size} system agents + ${this.tokenAgents.size} token agents`);

    // CEO always-on: permanently at desk, monitoring everything
    this._startCeoLoop();
    this._startTokenScanLoop();
  }

  addTokenAgent(symbol) {
    if (this.tokenAgents.has(symbol)) return;
    const agent = new TokenAgent(symbol);
    this.tokenAgents.set(symbol, agent);
    const key = symbol.toLowerCase().replace('usdt', '');
    this._agents.set(key, agent);
    agent.init();
    // Keep token agents permanently active at their stations
    agent.managedByCoordinator = true;
    agent.state = 'running';
    agent.currentTask = { description: `Watching ${symbol}`, startedAt: Date.now() };
    // Rebuild scan queue when new token added
    this._rebuildScanQueue();
  }

  removeTokenAgent(symbol) {
    const key = symbol.toLowerCase().replace('usdt', '');
    const agent = this.tokenAgents.get(symbol);
    if (agent) agent.shutdown();
    this.tokenAgents.delete(symbol);
    this._agents.delete(key);
  }

  // ── CEO Always-On Loop ──────────────────────────────────────
  // Coordinator stays permanently "running" at its desk.
  // Every 30s it runs a micro-cycle: monitor positions, sync trades,
  // and decide whether to trigger a full pipeline scan.

  _startCeoLoop() {
    // CEO is always running — never goes idle
    this.state = 'running';
    this.managedByCoordinator = true;
    this.currentTask = { description: 'Commanding agents — monitoring markets', startedAt: Date.now() };
    this.addActivity('info', 'CEO online — always-on mode activated');

    // Keep all core agents at their stations permanently
    const coreAgents = [this.sentimentAgent, this.chartAgent, this.riskAgent, this.traderAgent, this.accountantAgent, this.kronosAgent, this.strategyAgent, this.policeAgent, this.coderAgent, this.optimizerAgent];
    for (const a of coreAgents) {
      if (!a.paused) {
        a.managedByCoordinator = true;
        a.state = 'running';
        a.currentTask = { description: 'Monitoring — standing by', startedAt: Date.now() };
      }
    }

    this._ceoTimer = setInterval(async () => {
      if (this.paused) return;
      try {
        await this._microCycle();
      } catch (err) {
        this.addActivity('error', `Micro-cycle error: ${err.message}`);
      }
    }, this.MICRO_CYCLE_MS);

    this.log('CEO always-on loop started (30s micro-cycles)');
  }

  async _microCycle() {
    this._microCycleCount++;
    const now = Date.now();

    // Update CEO task display
    this.currentTask = { description: `Cycle #${this._microCycleCount} — monitoring ${this.tokenAgents.size} tokens`, startedAt: now };

    // 1. Sync trade status + check top-ups (every micro-cycle)
    try {
      this.traderAgent.currentTask = { description: 'Syncing positions...', startedAt: now };
      const { syncTradeStatus, checkUsdtTopups } = require('../cycle');
      await syncTradeStatus();
      await checkUsdtTopups();
      this.traderAgent.currentTask = { description: 'Monitoring positions', startedAt: now };
    } catch (err) {
      this.addActivity('error', `Sync error: ${err.message}`);
    }

    // 2. Check if it's time for a full pipeline scan
    const timeSinceFullCycle = now - this._lastFullCycleAt;
    if (timeSinceFullCycle >= this.FULL_CYCLE_INTERVAL_MS && !this.cycleRunning) {
      this.run({ forced: false }).catch(err => {
        this.addActivity('error', `Full cycle error: ${err.message}`);
      });
    }

    // 3. Competition: update leaderboard and rivalries every 5 micro-cycles
    if (this._microCycleCount % 5 === 0) {
      this.updateRivalries();
    }

    // 4. Generate thoughts for all agents every 10 micro-cycles (~5 min)
    if (this._microCycleCount % 10 === 0) {
      this.generateAllThoughts();
      this.getLeaderboard(); // refresh ranks
    }

    // 5. Run police patrol (pass coordinator context)
    if (this._microCycleCount % 2 === 0 && !this.policeAgent.paused) {
      this.policeAgent.run({ coordinator: this }).catch(() => {});
    }

    // 6. Update CEO display
    const board = this.getLeaderboard();
    const topAgent = board[0];
    const topDisplay = topAgent ? ` | #1: ${topAgent.name} Lv.${topAgent.level}` : '';
    this.currentTask = { description: `Commanding ${this.tokenAgents.size} tokens${topDisplay}`, startedAt: Date.now() };
  }

  // ── Staggered Token Scan Loop ──────────────────────────────
  // Scans tokens in rotating batches every few seconds so each
  // token gets checked ~every 30 seconds.

  _startTokenScanLoop() {
    // Calculate tick interval: scan TOKEN_BATCH_SIZE tokens per tick
    // so all tokens are covered within TOKEN_SCAN_INTERVAL_MS
    this._rebuildScanQueue();

    const tickMs = Math.max(2000, Math.floor(this.TOKEN_SCAN_INTERVAL_MS / Math.ceil(this.tokenAgents.size / this.TOKEN_BATCH_SIZE)) || 5000);

    this._tokenScanTimer = setInterval(async () => {
      if (this.paused || this.cycleRunning) return;
      try {
        await this._scanTokenBatch();
      } catch (err) {
        this.addActivity('error', `Token scan batch error: ${err.message}`);
      }
    }, tickMs);

    this.log(`Token scan loop started — ${this.TOKEN_BATCH_SIZE} tokens every ${(tickMs / 1000).toFixed(1)}s`);
  }

  _rebuildScanQueue() {
    this._tokenScanQueue = [...this.tokenAgents.keys()];
    this._tokenScanIdx = 0;
  }

  async _scanTokenBatch() {
    if (this._tokenScanQueue.length === 0) {
      this._rebuildScanQueue();
      if (this._tokenScanQueue.length === 0) return;
    }

    // Pick next batch from queue
    const batch = [];
    for (let i = 0; i < this.TOKEN_BATCH_SIZE && this._tokenScanIdx < this._tokenScanQueue.length; i++) {
      const sym = this._tokenScanQueue[this._tokenScanIdx++];
      const agent = this.tokenAgents.get(sym);
      if (agent && !agent.paused) batch.push([sym, agent]);
    }

    // Wrap around when we reach the end
    if (this._tokenScanIdx >= this._tokenScanQueue.length) {
      this._tokenScanIdx = 0;
    }

    if (batch.length === 0) return;

    // Get cached Kronos predictions for token scans
    let kronosPredictions = null;
    if (this.kronosAgent.lastPredictions?.size > 0) {
      kronosPredictions = this.kronosAgent.lastPredictions;
    }
    const dailyBiasCache = new Map();

    // Scan batch
    const signals = [];
    for (const [sym, agent] of batch) {
      agent.currentTask = { description: `Quick-scanning ${sym}...`, startedAt: Date.now() };
      try {
        const result = await agent.run({ kronosPredictions, dailyBiasCache });
        if (result && result.direction) {
          signals.push(result);
          agent.addActivity('success', `SIGNAL: ${sym} ${result.direction}`);
        }
      } catch {
        // Skip failed scans silently
      }
      agent.currentTask = { description: `Watching ${sym}`, startedAt: Date.now() };
    }

    // If any signals found during background scan, feed them through risk + trader
    if (signals.length > 0) {
      this.addActivity('info', `Background scan: ${signals.length} signal(s) — ${signals.map(s => `${s.symbol} ${s.direction}`).join(', ')}`);

      // Quick risk check + execute
      try {
        let approved = signals;
        if (!this.riskAgent.paused) {
          let openPositions = [];
          try {
            const { query: dbQuery } = require('../db');
            const openTrades = await dbQuery("SELECT symbol FROM trades WHERE status = 'OPEN'");
            openPositions = openTrades.map(t => t.symbol);
          } catch {}
          const riskResult = await this.riskAgent.run({ signals, openPositions });
          approved = riskResult?.approved || [];
        }
        if (approved.length > 0 && !this.traderAgent.paused) {
          this.addActivity('trade', `Background signal approved: ${approved.map(s => `${s.symbol} ${s.direction}`).join(', ')}`);
          await this.traderAgent.run({ signals: approved, mode: 'signals' });
        }
      } catch (err) {
        this.addActivity('error', `Background trade error: ${err.message}`);
      }
    }
  }

  // ── Competition & Leaderboard System ────────────────────────
  // Agents compete against each other — ranked by XP, earnings, and success rate.
  // Rivalries form automatically between agents of similar level.

  getLeaderboard() {
    const board = [];
    for (const [key, agent] of this._agents) {
      if (key === 'coordinator') continue;
      const stats = agent.getCompetitionStats();
      board.push({ key, ...stats });
    }
    board.sort((a, b) => b.xp - a.xp);
    board.forEach((entry, idx) => {
      entry.rank = idx + 1;
      const agent = this._agents.get(entry.key);
      if (agent) agent._competition.rank = idx + 1;
    });
    return board;
  }

  /** Auto-assign rivalries between agents of similar level for competition */
  updateRivalries() {
    const board = this.getLeaderboard();
    for (let i = 0; i < board.length; i++) {
      const agent = this._agents.get(board[i].key);
      if (!agent) continue;
      // Rival is the agent directly above or below in ranking
      const rivalIdx = i > 0 ? i - 1 : (i < board.length - 1 ? i + 1 : -1);
      if (rivalIdx >= 0) {
        const rivalAgent = this._agents.get(board[rivalIdx].key);
        if (rivalAgent && rivalAgent.name !== agent.name && rivalAgent.state !== 'jailed') {
          agent.setRival(rivalAgent.name);
        }
      }
    }
  }

  /** Generate thoughts for all agents — called periodically */
  generateAllThoughts() {
    for (const [, agent] of this._agents) {
      if (agent.state === 'jailed' || agent.paused) continue;
      agent.generateThought();
    }
  }

  // ── Jail Review (for user/admin) ───────────────────────────

  getJailedAgents() {
    return this.policeAgent.getJailedAgents();
  }

  async releaseAgent(agentKey) {
    const report = await this.policeAgent.getViolationReport(agentKey);
    const released = await this.policeAgent.releaseAgent(agentKey, this);
    if (released) {
      const agent = this._agents.get(agentKey);
      if (agent) {
        agent.managedByCoordinator = true;
        agent.state = 'running';

        const violation = report?.jailRecord?.violationType || 'unknown';
        const lesson = SELF_IMPROVE_LESSONS[violation] || 'I will be more careful and follow protocol.';
        agent.currentTask = { description: `Self-improving: ${lesson}`, startedAt: Date.now() };
        agent.addActivity('success', `Released from jail — lesson learned: ${lesson}`);

        try {
          await agent.remember(`improvement_${Date.now()}`, {
            violation,
            reason: report?.jailRecord?.reason || 'unknown',
            lesson,
            releasedAt: Date.now(),
          }, 'self_improvement');
        } catch { /* DB may not be ready */ }

        agent.generateThought();
      }
    }
    return { released, report };
  }

  async getViolationReport(agentKey) {
    return this.policeAgent.getViolationReport(agentKey);
  }

  /**
   * Run one full trading cycle through the decoupled agent pipeline.
   *
   * Flow:
   *   1. SentimentAgent fetches market mood
   *   2. KronosAgent runs AI predictions
   *   3. TokenAgents + ChartAgent scan for SMC signals
   *   4. SentimentAgent enriches signals
   *   5. RiskAgent filters signals
   *   6. TraderAgent executes approved signals
   *   7. AccountantAgent audits (every 10 cycles)
   */
  async execute(context = {}) {
    if (this.cycleRunning) {
      this.log('Cycle already running — skipping');
      return null;
    }

    this.cycleRunning = true;
    this._lastFullCycleAt = Date.now();
    const cycleStart = Date.now();
    this.addActivity('info', 'Full pipeline cycle started');
    this.currentTask = { description: 'Running full pipeline scan...', startedAt: cycleStart };

    // All agents stay permanently managed by CEO loop — just update their tasks
    const coreAgents = [this.sentimentAgent, this.chartAgent, this.riskAgent, this.traderAgent, this.accountantAgent, this.kronosAgent, this.strategyAgent, this.policeAgent, this.coderAgent, this.optimizerAgent];
    for (const a of coreAgents) {
      if (!a.paused && a.state !== 'jailed') {
        a.managedByCoordinator = true;
        a.state = 'running';
        a.currentTask = { description: 'Pipeline active...', startedAt: Date.now() };
      }
    }

    try {
      // Resolve top N coins from DB (same as cycle.js main())
      let topNCoins = 50;
      try {
        const { query: dbQuery } = require('../db');
        const topNRows = await dbQuery('SELECT MAX(top_n_coins) as max_n FROM api_keys WHERE enabled = true');
        topNCoins = parseInt(topNRows[0]?.max_n) || 50;
      } catch (_) {}

      // ── Step 1: SentimentAgent fetches market mood ──
      let mood = 'neutral';
      if (!this.sentimentAgent.paused) {
        this.currentTask = { description: 'Step 1/7: SentimentAgent checking mood', startedAt: Date.now() };
        this.sentimentAgent.currentTask = { description: 'Analyzing market mood...', startedAt: Date.now() };
        try {
          const sentResult = await this.sentimentAgent.run();
          if (sentResult) mood = sentResult.mood;
          this.addActivity('info', `Mood: ${mood}`);
        } catch (err) {
          this.addActivity('error', `Sentiment error (non-fatal): ${err.message}`);
        }
      } else {
        this.sentimentAgent.addActivity('skip', 'Paused — skipping mood check');
      }

      // ── Step 1.5: KronosAgent runs AI predictions ──
      let kronosPredictions = null;
      if (!this.kronosAgent.paused) {
        this.currentTask = { description: `Step 2/7: KronosAgent predicting...`, startedAt: Date.now() };
        this.kronosAgent.currentTask = { description: `Scanning ${this.tokenAgents.size} tokens...`, startedAt: Date.now() };
        try {
          const tokenSymbols = [...this.tokenAgents.keys()];
          const kronosResult = await this.kronosAgent.run({ symbols: tokenSymbols, coordinator: this });
          if (kronosResult?.predictions > 0) {
            kronosPredictions = this.kronosAgent.lastPredictions;
            this.addActivity('info', `KronosAgent: ${kronosResult.predictions} predictions (${kronosResult.highConf} high-conf)`);
          }
        } catch (kronosErr) {
          this.addActivity('error', `KronosAgent error (non-fatal): ${kronosErr.message}`);
        }
      } else {
        this.kronosAgent.addActivity('skip', 'Paused — skipping predictions');
      }

      // ── Step 2: All TokenAgents scan in parallel ──
      let signals = [];
      let scanResult = null;
      const dailyBiasCache = new Map();

      const tokenEntries = [...this.tokenAgents.entries()].filter(([, a]) => !a.paused);
      this.currentTask = { description: `Step 3/7: Scanning ${tokenEntries.length} tokens`, startedAt: Date.now() };
      this.chartAgent.currentTask = { description: `Scanning ${tokenEntries.length} tokens for setups...`, startedAt: Date.now() };
      this.chartAgent.addActivity('info', `Scanning ${tokenEntries.length} tokens for SMC setups...`);

      // Set all token agents to managed so they stay "running" during scan
      for (const [, ta] of tokenEntries) {
        ta.managedByCoordinator = true;
        ta.state = 'running';
        ta.currentTask = { description: 'Waiting to scan...', startedAt: Date.now() };
      }

      // Run token agents in parallel batches (8 at a time, 200ms delay between batches)
      const BATCH_SIZE = 8;
      let scannedCount = 0;
      for (let i = 0; i < tokenEntries.length; i += BATCH_SIZE) {
        const batch = tokenEntries.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(([sym, agent]) => agent.run({ kronosPredictions, dailyBiasCache }).catch(() => null))
        );
        for (let ri = 0; ri < results.length; ri++) {
          const r = results[ri];
          const [, batchAgent] = batch[ri];
          if (r.status === 'fulfilled' && r.value && r.value.direction) {
            signals.push(r.value);
          }
        }
        scannedCount += batch.length;
        this.currentTask = { description: `Step 3/7: Scanned ${scannedCount}/${tokenEntries.length} tokens (${signals.length} signals)`, startedAt: Date.now() };
        if (i + BATCH_SIZE < tokenEntries.length) await new Promise(r => setTimeout(r, 200));
      }

      // Also run ChartAgent for any tokens that don't have dedicated agents
      if (!this.chartAgent.paused) {
        this.currentTask = { description: 'Step 3/7: ChartAgent checking remaining tokens', startedAt: Date.now() };
        try {
          const chartOutput = await this.chartAgent.run({ topNCoins, kronosPredictions });
          if (chartOutput?.signals) {
            for (const s of chartOutput.signals) {
              if (!signals.find(existing => existing.symbol === s.symbol)) {
                signals.push(s);
              }
            }
          }
        } catch {}
      }

      // Token agents stay active — background scan loop keeps them watching
      for (const [, ta] of tokenEntries) {
        ta.managedByCoordinator = true;
        ta.state = 'running';
        ta.currentTask = { description: `Watching ${ta.symbol}`, startedAt: Date.now() };
      }

      if (signals.length > 0) {
        const signalDetails = signals.map(s => `${s.symbol.replace('USDT','')} ${s.direction} score=${s.score || '?'}`).join(', ');
        this.addActivity('info', `${signals.length} signal(s): ${signalDetails}`);
        this.chartAgent.addActivity('success', `Found ${signals.length} signal(s) from ${tokenEntries.length} tokens`);
      } else {
        this.addActivity('skip', `Scanned ${tokenEntries.length} tokens — no signals`);
        this.chartAgent.addActivity('info', `Scanned ${tokenEntries.length} tokens — no setups passed filters`);
      }

      // ── Step 3: SentimentAgent enriches signals ──
      if (signals.length > 0 && !this.sentimentAgent.paused) {
        this.currentTask = { description: 'Step 4/7: Enriching signals with sentiment', startedAt: Date.now() };
        signals = this.sentimentAgent.enrichSignals(signals);
        const enriched = signals.filter(s => s._sentimentModifier !== 0);
        if (enriched.length) {
          this.addActivity('info', `Sentiment enriched ${enriched.length} signal(s): ${enriched.map(s => `${s.symbol.replace('USDT','')} ${s._sentimentModifier > 0 ? '+' : ''}${s._sentimentModifier}`).join(', ')}`);
        }
      }

      // ── Step 4: RiskAgent filters signals ──
      let approvedSignals = signals;
      let riskReport = null;

      if (signals.length > 0 && !this.riskAgent.paused) {
        this.currentTask = { description: 'Step 5/7: RiskAgent evaluating', startedAt: Date.now() };
        this.riskAgent.currentTask = { description: 'Evaluating signal risk...', startedAt: Date.now() };
        let openPositions = [];
        try {
          const { query: dbQuery } = require('../db');
          const openTrades = await dbQuery("SELECT symbol FROM trades WHERE status = 'OPEN'");
          openPositions = openTrades.map(t => t.symbol);
        } catch (_) {}

        const riskResult = await this.riskAgent.run({ signals, openPositions });
        if (riskResult) {
          approvedSignals = riskResult.approved || [];
          riskReport = riskResult.riskReport;
          if (riskResult.rejected?.length) {
            const rejDetails = riskResult.rejected.map(r => `${(r.symbol || '').replace('USDT','')}(${r.reason || 'filtered'})`).join(', ');
            this.addActivity('warning', `RiskAgent rejected ${riskResult.rejected.length}: ${rejDetails}`);
          }
          if (approvedSignals.length > 0) {
            this.addActivity('success', `RiskAgent approved ${approvedSignals.length}: ${approvedSignals.map(s => `${s.symbol.replace('USDT','')} ${s.direction}`).join(', ')}`);
          }
        }
      } else if (signals.length === 0) {
        this.riskAgent.addActivity('info', 'No signals to evaluate — standing by');
      }

      // ── Step 5: TraderAgent executes approved signals ──
      let tradeResult = null;

      if (!this.traderAgent.paused) {
        this.currentTask = { description: 'Step 6/7: TraderAgent executing', startedAt: Date.now() };
        this.traderAgent.currentTask = { description: 'Executing approved trades...', startedAt: Date.now() };
        tradeResult = await this.traderAgent.run({ signals: approvedSignals, mode: 'signals' });
        if (tradeResult?.executed) {
          const execSymbols = approvedSignals.map(s => `${s.symbol.replace('USDT','')} ${s.direction}`).join(', ');
          this.addActivity('trade', `Trade executed: ${execSymbols}`);
          this.traderAgent.addActivity('trade', `Executed: ${execSymbols}`);
        } else if (approvedSignals.length > 0) {
          this.addActivity('skip', `TraderAgent received ${approvedSignals.length} signal(s) but none executed`);
          this.traderAgent.addActivity('skip', `${approvedSignals.length} signal(s) received — none met execution criteria`);
        } else {
          this.traderAgent.addActivity('info', 'No approved signals — monitoring positions');
        }
      } else {
        this.addActivity('skip', 'TraderAgent paused — skipping execution');
      }

      // ── Step 6: AccountantAgent auto-audit (every 10 cycles) ──
      if (!this.accountantAgent.paused && this.runCount % 10 === 0) {
        this.currentTask = { description: 'AccountantAgent auditing', startedAt: Date.now() };
        this.accountantAgent.currentTask = { description: 'Auditing trade records...', startedAt: Date.now() };
        try {
          const auditResult = await this.accountantAgent.run({ mode: 'audit' });
          if (auditResult?.fixed > 0) {
            this.addActivity('success', `Accountant fixed ${auditResult.fixed} trade(s)`);
          }
        } catch (err) {
          this.addActivity('error', `Audit error: ${err.message}`);
        }
      }

      // XP only earned when trades win — no task-based XP

      this.currentTask = null;
      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      this.log(`Cycle complete in ${elapsed}s | Mood: ${mood} | Signals: ${signals.length} → ${approvedSignals.length} approved | Executed: ${tradeResult?.executed || false}`);
      this.addActivity('success', `Cycle #${this.runCount} done in ${elapsed}s | mood=${mood} | scanned=${tokenEntries.length} | signals=${signals.length} | approved=${approvedSignals.length} | traded=${tradeResult?.executed ? 'YES' : 'no'}`);

      // Hermes: record cycle summary to team memory (only when something happened)
      if (signals.length > 0 || tradeResult?.executed) {
        const hermes = require('../hermes-bridge');
        const ts = new Date().toISOString().slice(0, 16);
        const summary = `[${ts}] Cycle #${this.runCount}: mood=${mood} signals=${signals.length} approved=${approvedSignals.length} traded=${tradeResult?.executed ? 'YES' : 'no'} (${elapsed}s)`;
        hermes.addTeamMemory(summary);
      }

      return {
        elapsed: parseFloat(elapsed),
        mood,
        signals: signals.length,
        approved: approvedSignals.length,
        scanResult,
        riskReport,
        tradeResult,
        agents: this.getAgentHealthSummary(),
      };
    } catch (err) {
      this.addActivity('error', `Cycle error: ${err.message}`);
      throw err;
    } finally {
      this.cycleRunning = false;
      // CEO stays running — agents stay at their stations between cycles
      this.currentTask = { description: `Commanding agents — ${this.tokenAgents.size} tokens monitored`, startedAt: Date.now() };
      for (const a of coreAgents) {
        if (a.state === 'jailed') continue; // jailed agents stay in prison
        if (!a.paused) {
          a.managedByCoordinator = true;
          a.state = 'running';
          a.currentTask = { description: 'Monitoring — standing by', startedAt: Date.now() };
        }
      }
    }
  }

  // ── Agent Management ──────────────────────────────────────

  registerAgent(name, agent) {
    this._agents.set(name, agent);
    this.log(`Agent registered: ${name}`);
  }

  getAgent(name) {
    return this._agents.get(name);
  }

  // ── Chat (CEO → Agents) ────────────────────────────────────

  async handleChat(message) {
    const text = message.trim().toLowerCase();
    this.addActivity('command', `CEO: ${message}`);

    // ── Action commands ──
    if (/^(scan|force scan|scan now|go scan|find trades|hunt|look for)/.test(text)) {
      if (this.cycleRunning) return { from: 'Coordinator', message: 'Already running a scan. Hold on, boss.' };
      this.run({ forced: true }).catch(() => {});
      return { from: 'Coordinator', message: 'On it. Scanning all markets now — ChartAgent is hunting for signals. I\'ll update the feed when done.' };
    }
    if (/^(pause all|stop all|halt|freeze|stop everything|shut down|stand down)/.test(text)) {
      await this.handleCommand('pause-all');
      return { from: 'Coordinator', message: 'All agents standing down. Nobody moves until you say so.' };
    }
    if (/^(resume all|start all|wake|go go|unpause|back to work|get to work|start working|lets go)/.test(text)) {
      await this.handleCommand('resume-all');
      return { from: 'Coordinator', message: 'All agents back online. ChartAgent scanning, RiskAgent filtering, TraderAgent executing. We\'re live.' };
    }

    // Close positions
    if (/close.*position|close.*all|close.*trade|emergency.*close|exit.*all|sell.*all|dump.*all/.test(text)) {
      return this._closeAllPositions();
    }
    // Close specific token
    const closeMatch = text.match(/close\s+([A-Z0-9]+)/i);
    if (closeMatch) {
      const sym = closeMatch[1].toUpperCase();
      const symbol = sym.endsWith('USDT') ? sym : sym + 'USDT';
      return this._closeToken(symbol);
    }

    // Pause/resume/reset specific agent
    const pauseM = text.match(/^(pause|stop|halt)\s+(chart|trader|risk|sentiment)/);
    if (pauseM) {
      await this.handleCommand('pause-agent', { agent: pauseM[2] });
      const names = { chart: 'ChartAgent', trader: 'TraderAgent', risk: 'RiskAgent', sentiment: 'SentimentAgent' };
      return { from: names[pauseM[2]] || 'Coordinator', message: `Understood. I'm paused. Standing by until you need me.` };
    }
    const resumeM = text.match(/^(resume|start|unpause|wake)\s+(chart|trader|risk|sentiment)/);
    if (resumeM) {
      await this.handleCommand('resume-agent', { agent: resumeM[2] });
      const names = { chart: 'ChartAgent', trader: 'TraderAgent', risk: 'RiskAgent', sentiment: 'SentimentAgent' };
      return { from: names[resumeM[2]] || 'Coordinator', message: `Back online. Ready to work.` };
    }
    const resetM = text.match(/^(reset|fix|clear)\s+(chart|trader|risk|sentiment)/);
    if (resetM) {
      await this.handleCommand('reset-agent', { agent: resetM[2] });
      return { from: 'Coordinator', message: `${resetM[2]} agent has been reset. Error cleared, ready to go.` };
    }

    // ── Accountant commands — MUST be before agent question routing ──
    if (/account.*fix|account.*check|account.*audit|audit|fix.*trad|fix.*pnl|fix.*price|fix.*fee|wrong.*pnl|correct.*pnl|recalc|recheck/.test(text)) {
      return this._runAccountantAudit();
    }

    // ── Status / report queries ──
    // Agent-directed questions (only for "how/what/why" questions, not action commands)
    const agentNameMap = {
      chart: this.chartAgent, chartagent: this.chartAgent, 'chart agent': this.chartAgent,
      trader: this.traderAgent, traderagent: this.traderAgent, 'trader agent': this.traderAgent,
      risk: this.riskAgent, riskagent: this.riskAgent, 'risk agent': this.riskAgent,
      sentiment: this.sentimentAgent, sentimentagent: this.sentimentAgent, 'sentiment agent': this.sentimentAgent,
      accountant: this.accountantAgent, accountantagent: this.accountantAgent, 'accountant agent': this.accountantAgent,
      kronos: this.kronosAgent, kronosagent: this.kronosAgent, 'kronos agent': this.kronosAgent, oracle: this.kronosAgent,
      strategy: this.strategyAgent, strategyagent: this.strategyAgent, 'strategy agent': this.strategyAgent, researcher: this.strategyAgent,
      police: this.policeAgent, policeagent: this.policeAgent, 'police agent': this.policeAgent, 'internal affairs': this.policeAgent,
      coder: this.coderAgent, coderagent: this.coderAgent, 'coder agent': this.coderAgent, engineer: this.coderAgent,
      optimizer: this.optimizerAgent, optimizeragent: this.optimizerAgent, 'optimizer agent': this.optimizerAgent,
    };
    for (const [name, agent] of Object.entries(agentNameMap)) {
      if (agent && text.includes(name) && /how|what|why|explain|tell|describe|skill|work|do you/.test(text)) {
        return { from: agent.name, message: await agent.explain(message) };
      }
    }

    if (/^(status|sitrep|update)$/.test(text) || /^(what.*(doing|happening|going on))/.test(text) || /^how are (you|things|we)/.test(text)) {
      return this._buildStatusChat();
    }
    if (/^(who|which|what).*(trading|open|position)/.test(text)) {
      return this._buildPositionsChat();
    }
    if (/^(mood|market mood|how.*(market|crypto))/.test(text)) {
      return this._buildSentimentChat();
    }
    if (/^(signal|what.*(found|see|scan)|any.*(signal|trade|setup))/.test(text)) {
      return this._buildSignalsChat();
    }
    if (/^(risk report|exposure|drawdown)$/.test(text)) {
      return this._buildRiskChat();
    }
    if (/^(performance|win|loss|how.*doing|results|pnl|profit)/.test(text)) {
      return this._buildPerformanceChat();
    }
    if (/^(pnl|profit|loss|trade history|trades|show.*trade|my.*trade|earnings|revenue|income|how much.*(made|lost|earn))/.test(text)) {
      return this._buildTradeHistoryChat();
    }
    if (/^(fee|commission|cost|how much.*pay|charges)/.test(text)) {
      return this._buildFeeChat();
    }
    // Create watcher agent — only when explicitly asking to watch/monitor coins
    if (/(?:create|add|make|new|hire|spawn)\s+(?:a\s+|an\s+)?(?:watcher|agent)\s+(?:to\s+|for\s+)?(?:watch|monitor|track|follow)\s/i.test(text)) {
      return this._handleCreateAgent(text, message);
    }

    // Remove/fire agent
    const removeMatch = text.match(/(?:remove|delete|fire|kill|drop)\s+(?:agent\s+)?(\w+)/);
    if (removeMatch) {
      const key = removeMatch[1].toLowerCase();
      const result = this.removeAgent(key);
      if (result.ok) return { from: 'Coordinator', message: `Agent "${key}" has been removed.` };
      return { from: 'Coordinator', message: result.error };
    }

    // Jail review
    if (/^(jail|prison|jailed|arrested|who.*jail|inmates|prisoners)/.test(text)) {
      const jailed = this.getJailedAgents();
      if (!jailed.length) return { from: 'PoliceAgent', message: 'No agents in jail. Everyone is behaving.' };
      const lines = [`**Prison Report — ${jailed.length} inmate(s)**\n`];
      for (const j of jailed) {
        const dur = Math.round((Date.now() - j.jailedAt) / 60000);
        lines.push(`• **${j.agentKey}** — ${j.reason}\n  Severity: ${j.severity} | In jail ${dur}m | Warnings: ${j.warnings}`);
      }
      lines.push(`\nSay "release <agent>" to free an agent.`);
      return { from: 'PoliceAgent', message: lines.join('\n') };
    }

    // Release from jail
    const releaseMatch = text.match(/^release\s+(\w+)/);
    if (releaseMatch) {
      const key = releaseMatch[1].toLowerCase();
      // Find the agent key - try direct match first, then by agent property name
      let agentKey = null;
      const searchKeys = [key, key + 'Agent', key + 'agent'];
      for (const sk of searchKeys) {
        if (this._agents.has(sk) || this.policeAgent._jailedAgents.has(sk)) {
          agentKey = sk;
          break;
        }
      }
      if (!agentKey) {
        // Try matching agent properties like 'chartAgent', 'traderAgent', etc.
        for (const [jailKey] of this.policeAgent._jailedAgents) {
          if (jailKey.toLowerCase().includes(key)) { agentKey = jailKey; break; }
        }
      }
      if (!agentKey) return { from: 'PoliceAgent', message: `Agent "${key}" not found in jail.` };
      const released = await this.releaseAgent(agentKey);
      if (released) return { from: 'PoliceAgent', message: `Released **${agentKey}** from jail. Agent is back on duty.` };
      return { from: 'PoliceAgent', message: `Failed to release "${agentKey}".` };
    }

    // Backtest
    if (/^(backtest|back.?test|optimize|find.*best|test.*strateg|best.*formula)/.test(text)) {
      this.addActivity('command', 'Starting backtest — testing all strategies over 60 days...');
      const { runBacktest, applyBestStrategy } = require('../backtester');
      runBacktest({
        symbols: [...this.tokenAgents.keys()].slice(0, 10),
        days: 60,
      }).then(async (result) => {
        if (result.bestStrategy) {
          await applyBestStrategy(result);
          this.addActivity('success', `Backtest done: Best = ${result.bestStrategy.strategy} (${result.bestStrategy.winRate}% WR, ${result.bestStrategy.avgPnl}% avg PnL). Auto-applied.`);
          this.shareWithTeam(`Backtest winner: ${result.bestStrategy.strategy} — ${result.bestStrategy.winRate}% WR, ${result.bestStrategy.avgPnl}% avg. Applied to live trading.`);
        }
      }).catch(err => this.addActivity('error', `Backtest failed: ${err.message}`));
      return { from: 'Coordinator', message: 'Backtest started — testing 7 strategies × 8 TP/SL configs × top 10 tokens over 60 days of data. This will take a few minutes. Results will appear in the activity feed and auto-apply the best strategy.' };
    }

    // Leaderboard
    if (/^(leaderboard|ranking|rank|who.*(best|top|#1)|competition|compete|scoreboard)/.test(text)) {
      const board = this.getLeaderboard();
      const lines = [`**Agent Leaderboard**\n`];
      const medals = ['🥇', '🥈', '🥉'];
      for (let i = 0; i < Math.min(board.length, 15); i++) {
        const a = board[i];
        const medal = medals[i] || `#${i + 1}`;
        const rival = a.rivalry ? ` vs ${a.rivalry}` : '';
        lines.push(`${medal} **${a.name}** Lv.${a.level} [${a.tier}] — ${a.xp} XP | ${a.successRate}% WR | streak: ${a.streak}${rival}`);
      }
      return { from: 'Coordinator', message: lines.join('\n') };
    }

    // Check memories
    if (/what.*(remember|learned|know|memory)|memories|lessons|brain/.test(text)) {
      return this._buildMemoryChat(text);
    }

    // List agents
    if (/^(list|show|who|which)\s*(agent|team|all)/.test(text) || text === 'agents' || text === 'team') {
      const agents = Object.entries(this.getAllProfiles());
      const lines = [`**Your Team (${agents.length} agents)**\n`];
      for (const [key, a] of agents) {
        const st = a.health?.paused ? 'PAUSED' : (a.health?.state || 'idle').toUpperCase();
        lines.push(`• **${a.name}** (${a.role}) [${st}] — ${a.description.substring(0, 60)}`);
      }
      lines.push(`\nSay "create agent to watch BTCUSDT" to add a new watcher.`);
      return { from: 'Coordinator', message: lines.join('\n') };
    }

    // ── AI-powered response (primary handler for all questions) ──
    const { isAvailable: aiAvailable, think, getSystemPrompt } = require('./ai-brain');
    if (aiAvailable()) {
      // Route to the right agent
      let targetAgent = null;
      for (const [name, agent] of this._agents) {
        if (text.includes(name) || text.includes(agent.name.toLowerCase())) {
          targetAgent = agent;
          break;
        }
      }
      // Keyword routing
      if (!targetAgent) {
        if (/smc|smart money|swing|scan|signal|setup|timeframe|candle|chart/.test(text)) targetAgent = this.chartAgent;
        else if (/trail|stop.?loss|tp|take.?profit|position|execut|entry|exit|order/.test(text)) targetAgent = this.traderAgent;
        else if (/risk|exposure|max.?pos|drawdown|correlat|safe|block|reject/.test(text)) targetAgent = this.riskAgent;
        else if (/mood|sentiment|bull|bear|fomo|fud|news|trend|market/.test(text)) targetAgent = this.sentimentAgent;
        else if (/audit|pnl|fee|accountant|fix.*trade|check.*trade/.test(text)) targetAgent = this.accountantAgent;
        else if (/kronos|predict|forecast|oracle|ai.?predict/.test(text)) targetAgent = this.kronosAgent;
        else if (/strategy|backtest|variation|discover|win.?rate|parameter/.test(text)) targetAgent = this.strategyAgent;
        else if (/coder|patch|heal|fix.*code|module.*health|self.?heal|bug|error.*log/.test(text)) targetAgent = this.coderAgent;
        else if (/optimi|backtest|best.*formula|best.*strateg|winning.*rate/.test(text)) targetAgent = this.optimizerAgent;
      }

      const agent = targetAgent || this;
      const agentName = agent.name || 'Coordinator';

      // Build context from agent + system state
      const context = {
        health: agent.getHealth ? agent.getHealth() : {},
        profile: agent.getProfile ? agent.getProfile() : {},
        recentActivity: agent.getActivity ? agent.getActivity(5) : [],
      };
      if (agent._getAIContext) Object.assign(context, await agent._getAIContext());

      // Also add memories if available
      try {
        if (agent.recallAll) {
          const memories = await agent.recallAll();
          if (memories.length) context.memories = memories.slice(0, 10).map(m => ({ key: m.key, value: m.value, category: m.category }));
        }
        if (agent.getLessons) {
          const lessons = await agent.getLessons(null, 5);
          if (lessons.length) context.lessons = lessons.map(l => ({ type: l.type, lesson: l.lesson, score: l.score }));
        }
      } catch {}

      const aiReply = await think({ agentName, systemPrompt: getSystemPrompt(agentName), userMessage: message, context });
      if (aiReply) return { from: agentName, message: aiReply };
    }

    // ── Fallback: no API key — use hardcoded explain() ──
    if (/^(help|what can you|commands)/.test(text)) {
      return { from: 'Coordinator', message: 'Set ANTHROPIC_API_KEY on Railway for smart AI responses.\n\nCommands that always work:\n• scan now\n• status / team\n• pause/resume <agent>\n• audit trades\n• create agent to watch BTCUSDT\n• help' };
    }
    // Route to agent explain fallback
    let fallbackAgent = null;
    for (const [name, agent] of this._agents) {
      if (text.includes(name) || text.includes(agent.name.toLowerCase())) { fallbackAgent = agent; break; }
    }
    if (!fallbackAgent) {
      if (/smc|scan|signal|chart/.test(text)) fallbackAgent = this.chartAgent;
      else if (/trail|stop|position|trade/.test(text)) fallbackAgent = this.traderAgent;
      else if (/risk|drawdown/.test(text)) fallbackAgent = this.riskAgent;
      else if (/mood|sentiment/.test(text)) fallbackAgent = this.sentimentAgent;
      else if (/audit|pnl|fee/.test(text)) fallbackAgent = this.accountantAgent;
      else if (/kronos|predict|forecast/.test(text)) fallbackAgent = this.kronosAgent;
      else if (/strategy|backtest/.test(text)) fallbackAgent = this.strategyAgent;
      else if (/coder|patch|heal|bug/.test(text)) fallbackAgent = this.coderAgent;
      else if (/optimi|backtest|formula/.test(text)) fallbackAgent = this.optimizerAgent;
    }
    if (fallbackAgent) return { from: fallbackAgent.name, message: await fallbackAgent.explain(message) };

    return { from: 'Coordinator', message: `Set **ANTHROPIC_API_KEY** on Railway for AI-powered responses. Without it, I can only run commands like "scan now", "status", "audit trades", etc. Type "help" for the full list.` };
  }

  _buildStatusChat() {
    const h = this.getHealth();
    const agents = h.agents || {};
    const lines = [];
    lines.push(`**Team Status Report**`);

    for (const [key, a] of Object.entries(agents)) {
      const state = a.paused ? 'PAUSED' : a.state.toUpperCase();
      let detail = `${a.runCount} runs`;
      if (a.lastSignalCount !== undefined) detail += `, ${a.lastSignalCount} signals last scan`;
      if (a.openPositions !== undefined) detail += `, ${a.openPositions} open positions`;
      if (a.mood) detail += `, mood: ${a.mood}`;
      if (a.consecutiveLosses > 0) detail += `, ${a.consecutiveLosses} consecutive losses`;
      if (a.currentTask) detail = `Working: ${a.currentTask.description}`;
      lines.push(`• ${a.name} [${state}] — ${detail}`);
    }

    if (h.cycleRunning) lines.push(`\nCurrently running a trading cycle.`);
    else lines.push(`\nAll quiet. Waiting for next cycle.`);

    return { from: 'Coordinator', message: lines.join('\n') };
  }

  async _buildPositionsChat() {
    try {
      const { query } = require('../db');
      const trades = await query("SELECT symbol, direction, entry_price, leverage, created_at FROM trades WHERE status = 'OPEN' ORDER BY created_at DESC");
      if (!trades.length) return { from: 'TraderAgent', message: 'No open positions right now. Waiting for a good setup.' };
      const lines = [`We have ${trades.length} open position(s):\n`];
      for (const t of trades) {
        const ago = Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000);
        lines.push(`• ${t.symbol} ${t.direction} x${t.leverage} @ $${parseFloat(t.entry_price).toFixed(4)} — ${ago}m ago`);
      }
      return { from: 'TraderAgent', message: lines.join('\n') };
    } catch {
      return { from: 'TraderAgent', message: 'Can\'t check positions right now — database might be loading.' };
    }
  }

  _buildSentimentChat() {
    const sh = this.sentimentAgent.getHealth();
    if (!sh.scansCompleted) return { from: 'SentimentAgent', message: 'Haven\'t scanned sentiment yet. Run a cycle first or ask me to scan.' };
    const mood = sh.mood;
    const moodDesc = mood === 'risk-on' ? 'Bullish — market is greedy. Good for longs.' :
                     mood === 'risk-off' ? 'Bearish — fear in the market. Careful with longs.' :
                     'Neutral — no strong bias. Normal conditions.';
    return { from: 'SentimentAgent', message: `Market mood: **${mood.toUpperCase()}**\n${moodDesc}\n\nTracking ${sh.coinsTracked} coins across CoinGecko, CryptoPanic, and X/Twitter. ${sh.extremeEvents} extreme events detected.` };
  }

  _buildSignalsChat() {
    const ch = this.chartAgent.getHealth();
    const signals = this.chartAgent.getLastSignals();
    if (!ch.totalScans) return { from: 'ChartAgent', message: 'Haven\'t scanned yet. Tell me to "scan now" and I\'ll look.' };
    if (!signals.length) return { from: 'ChartAgent', message: `Last scan found nothing. Checked ${ch.totalScans} time(s). No setups passed the checklist — all filters are strict. I\'ll keep looking.` };
    const lines = [`Found ${signals.length} signal(s) on last scan:\n`];
    for (const s of signals) {
      lines.push(`• ${s.symbol} ${s.direction} — score: ${s.score}, setup: ${s.setupName || 'SMC'}`);
    }
    return { from: 'ChartAgent', message: lines.join('\n') };
  }

  _buildRiskChat() {
    const rh = this.riskAgent.getHealth();
    const lines = [`**Risk Report**\n`];
    lines.push(`Signals approved: ${rh.signalsApproved}`);
    lines.push(`Signals rejected: ${rh.signalsRejected}`);
    lines.push(`Max open positions: ${rh.maxOpenPositions}`);
    lines.push(`Consecutive losses: ${rh.consecutiveLosses}`);
    if (rh.consecutiveLosses >= 3) lines.push(`\n⚠️ Drawdown mode active — reducing position sizes.`);
    if (rh.lastRiskReport?.rejectionReasons?.length) {
      lines.push(`\nRecent rejections:`);
      for (const r of rh.lastRiskReport.rejectionReasons.slice(0, 3)) {
        lines.push(`• ${r.symbol}: ${r.reasons.join(', ')}`);
      }
    }
    return { from: 'RiskAgent', message: lines.join('\n') };
  }

  async _buildPerformanceChat() {
    try {
      const aiLearner = require('../ai-learner');
      const stats = await aiLearner.getStats();
      if (!stats.overall || parseInt(stats.overall.total) === 0) {
        return { from: 'Coordinator', message: 'No trades recorded yet. The AI is still learning — performance data will appear after the first few trades.' };
      }
      const o = stats.overall;
      const total = parseInt(o.total);
      const wins = parseInt(o.wins);
      const wr = ((wins / total) * 100).toFixed(0);
      const avgPnl = parseFloat(o.avg_pnl || 0).toFixed(3);
      const totalPnl = parseFloat(o.total_pnl || 0).toFixed(2);
      const lines = [`**Performance Report**\n`];
      lines.push(`Total trades: ${total}`);
      lines.push(`Win rate: ${wr}% (${wins}W / ${total - wins}L)`);
      lines.push(`Avg PnL per trade: ${avgPnl}%`);
      lines.push(`Total PnL: ${totalPnl}%`);
      if (o.best_trade) lines.push(`Best trade: +${parseFloat(o.best_trade).toFixed(2)}%`);
      if (o.worst_trade) lines.push(`Worst trade: ${parseFloat(o.worst_trade).toFixed(2)}%`);
      return { from: 'Coordinator', message: lines.join('\n') };
    } catch {
      return { from: 'Coordinator', message: 'Can\'t load performance data right now.' };
    }
  }

  async _closeAllPositions() {
    try {
      const db = require('../db');
      const cryptoUtils = require('../crypto-utils');
      const { BitunixClient } = require('../bitunix-client');

      const keys = await db.query(
        `SELECT ak.*, u.email FROM api_keys ak JOIN users u ON u.id = ak.user_id
         WHERE ak.enabled = true AND (ak.paused_by_admin = false OR ak.paused_by_admin IS NULL)`
      );

      let closed = 0;
      for (const key of keys) {
        try {
          const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
          const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

          if (key.platform === 'bitunix') {
            const client = new BitunixClient({ apiKey, apiSecret });
            const account = await client.getAccountInformation();
            for (const pos of (account.positions || [])) {
              if (parseFloat(pos.positionAmt || pos.qty || 0) !== 0) {
                try {
                  await client.flashClose({ symbol: pos.symbol, positionId: pos.positionId });
                  closed++;
                } catch (e) { this.logError(`Close ${pos.symbol} failed: ${e.message}`); }
              }
            }
          } else if (key.platform === 'binance') {
            const { USDMClient } = require('binance');
            const { getBinanceRequestOptions } = require('../proxy-agent');
            const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
            const account = await client.getAccountInformation({ omitZeroBalances: false });
            for (const pos of account.positions) {
              const amt = parseFloat(pos.positionAmt);
              if (amt !== 0) {
                const side = amt > 0 ? 'SELL' : 'BUY';
                try {
                  await client.submitNewOrder({ symbol: pos.symbol, side, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true' });
                  closed++;
                } catch (e) { this.logError(`Close ${pos.symbol} failed: ${e.message}`); }
              }
            }
          }
        } catch (e) { this.logError(`Close for ${key.email} failed: ${e.message}`); }
      }

      // Update DB — fetch current prices and record actual exit PnL
      const openTrades = await db.query("SELECT id, symbol, direction, entry_price FROM trades WHERE status = 'OPEN'");
      let dbClosed = 0;
      for (const t of openTrades) {
        try {
          // Fetch current price for PnL calculation
          const fetch = require('node-fetch');
          const priceRes = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${t.symbol}`, { timeout: 5000 });
          const priceData = priceRes.ok ? await priceRes.json() : null;
          const exitPrice = priceData ? parseFloat(priceData.price) : 0;
          const entryPrice = parseFloat(t.entry_price) || 0;

          let pnlPct = 0;
          if (entryPrice > 0 && exitPrice > 0) {
            pnlPct = t.direction === 'LONG'
              ? ((exitPrice - entryPrice) / entryPrice) * 100
              : ((entryPrice - exitPrice) / entryPrice) * 100;
          }
          const isWin = pnlPct > 0;
          const status = isWin ? 'WIN' : 'LOSS';

          await db.query(
            `UPDATE trades SET status = $1, closed_at = NOW(), exit_price = $2, pnl_pct = $3
             WHERE id = $4`,
            [status, exitPrice || null, pnlPct, t.id]
          );
          dbClosed++;
        } catch (e) {
          // Fallback: just mark as CLOSED without PnL
          await db.query("UPDATE trades SET status = 'CLOSED', closed_at = NOW() WHERE id = $1", [t.id]);
          dbClosed++;
        }
      }

      this.addActivity('command', `Emergency close: ${closed} positions closed on exchanges, ${dbClosed} trades updated in DB`);
      return { from: 'TraderAgent', message: `Done. Closed ${closed} position(s) on exchanges. ${dbClosed} trade(s) updated with exit prices in DB.` };
    } catch (err) {
      return { from: 'TraderAgent', message: `Failed to close positions: ${err.message}` };
    }
  }

  async _closeToken(symbol) {
    try {
      const db = require('../db');
      const cryptoUtils = require('../crypto-utils');
      const { BitunixClient } = require('../bitunix-client');

      const keys = await db.query(
        `SELECT ak.*, u.email FROM api_keys ak JOIN users u ON u.id = ak.user_id WHERE ak.enabled = true`
      );

      let closed = 0;
      for (const key of keys) {
        try {
          const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
          const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

          if (key.platform === 'bitunix') {
            const client = new BitunixClient({ apiKey, apiSecret });
            const positions = await client.getOpenPositions(symbol);
            const pos = Array.isArray(positions) ? positions.find(p => p.symbol === symbol) : null;
            if (pos && pos.positionId) {
              await client.flashClose({ symbol, positionId: pos.positionId });
              closed++;
            }
          } else if (key.platform === 'binance') {
            const { USDMClient } = require('binance');
            const { getBinanceRequestOptions } = require('../proxy-agent');
            const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
            const account = await client.getAccountInformation({ omitZeroBalances: false });
            const pos = account.positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
            if (pos) {
              const amt = parseFloat(pos.positionAmt);
              const side = amt > 0 ? 'SELL' : 'BUY';
              await client.submitNewOrder({ symbol, side, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true' });
              closed++;
            }
          }
        } catch (e) { this.logError(`Close ${symbol} for ${key.email}: ${e.message}`); }
      }

      await db.query("UPDATE trades SET status = 'CLOSED', closed_at = NOW() WHERE symbol = $1 AND status = 'OPEN'", [symbol]);
      this.addActivity('command', `Closed ${symbol}: ${closed} position(s)`);
      return { from: 'TraderAgent', message: `Closed ${symbol} for ${closed} user(s). DB updated.` };
    } catch (err) {
      return { from: 'TraderAgent', message: `Failed to close ${symbol}: ${err.message}` };
    }
  }

  _handleCreateAgent(text, originalMessage) {
    // Extract symbols from the message
    const symbolMatches = text.match(/[A-Z]{2,10}USDT/gi) || [];
    const symbols = symbolMatches.map(s => s.toUpperCase());

    // Extract a name — use the symbols or a generic name
    let name;
    if (symbols.length === 1) {
      name = `${symbols[0].replace('USDT', '')} Watcher`;
    } else if (symbols.length > 1) {
      name = `${symbols[0].replace('USDT', '')}+ Watcher`;
    } else {
      // Try to extract what they want to watch
      const watchMatch = text.match(/(?:watch|monitor|track|follow)\s+(\w+)/);
      if (watchMatch) {
        const coin = watchMatch[1].toUpperCase();
        if (!coin.endsWith('USDT')) symbols.push(coin + 'USDT');
        name = `${coin} Watcher`;
      } else {
        name = `Custom Watcher ${this._agents.size}`;
      }
    }

    if (!symbols.length) {
      return { from: 'Coordinator', message: `I can create a watcher agent, but which coins should it monitor?\n\nTry: "create agent to watch BTCUSDT, ETHUSDT"` };
    }

    // Extract threshold if mentioned
    const threshMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
    const threshold = threshMatch ? parseFloat(threshMatch[1]) : 3;

    try {
      const result = this.addWatcherAgent(name, {
        symbols,
        alertThreshold: threshold,
        description: `Watches ${symbols.join(', ')} for ${threshold}%+ moves`,
      });

      if (result.ok) {
        return { from: 'Coordinator', message: `Done! Created **${name}**.\n\nWatching: ${symbols.join(', ')}\nAlert threshold: ${threshold}%\nAgent key: ${result.key}\n\nI'll alert you when these coins move ${threshold}%+ in a minute. Say "remove ${result.key}" to delete.` };
      }
      return { from: 'Coordinator', message: `Failed to create agent: ${result.error}` };
    } catch (err) {
      return { from: 'Coordinator', message: `Error creating agent: ${err.message}` };
    }
  }

  async _runAccountantAudit() {
    try {
      this.addActivity('command', 'AccountantAgent audit triggered from chat');
      const result = await this.accountantAgent.run({ mode: 'audit' });
      if (!result) return { from: 'AccountantAgent', message: 'Audit skipped — agent may be paused.' };

      const lines = [`**Trade Audit Complete**\n`];
      lines.push(`Trades audited: ${result.totalAudited}`);
      lines.push(`Issues found: ${result.issuesFound}`);
      lines.push(`Fixed: ${result.fixed}`);
      if (result.feesRecovered > 0) lines.push(`Fees recovered: $${result.feesRecovered.toFixed(2)}`);
      if (result.issues && result.issues.length > 0) {
        lines.push(`\n**Issues:**`);
        for (const issue of result.issues.slice(0, 8)) {
          lines.push(`• ${issue.symbol}: ${issue.problems.join(', ')}`);
        }
        if (result.issues.length > 8) lines.push(`...and ${result.issues.length - 8} more`);
      }
      if (result.issuesFound === 0) lines.push(`\nAll trades look correct.`);

      // Also run financial report
      const report = await this.accountantAgent.generateReport();
      if (report && report.total > 0) {
        lines.push(`\n**Financial Summary:**`);
        lines.push(`${report.wins}W / ${report.losses}L (${report.winRate}% WR)`);
        lines.push(`Gross P&L: $${report.totalGrossPnl}`);
        lines.push(`Total fees: $${report.totalFees}`);
        lines.push(`Net P&L: $${report.totalNetPnl}`);
        lines.push(`Best: +$${report.bestTrade} | Worst: $${report.worstTrade}`);
      }

      return { from: 'AccountantAgent', message: lines.join('\n') };
    } catch (err) {
      return { from: 'AccountantAgent', message: `Audit failed: ${err.message}` };
    }
  }

  async _buildTradeHistoryChat() {
    try {
      const { query } = require('../db');
      const recent = await query(
        `SELECT symbol, direction, status, pnl_usdt, trading_fee, gross_pnl, created_at, closed_at
         FROM trades WHERE status IN ('WIN','LOSS','TP','SL','CLOSED')
         ORDER BY closed_at DESC LIMIT 10`
      );
      if (!recent.length) return { from: 'Coordinator', message: 'No closed trades yet.' };
      const totalNet = recent.reduce((s, t) => s + (parseFloat(t.pnl_usdt) || 0), 0);
      const totalFee = recent.reduce((s, t) => s + (parseFloat(t.trading_fee) || 0), 0);
      const wins = recent.filter(t => t.status === 'WIN' || t.status === 'TP').length;
      const lines = [`**Last ${recent.length} Trades**\n`];
      for (const t of recent) {
        const net = parseFloat(t.pnl_usdt) || 0;
        const fee = parseFloat(t.trading_fee) || 0;
        const gross = t.gross_pnl != null ? parseFloat(t.gross_pnl) : net;
        lines.push(`${t.status === 'WIN' || t.status === 'TP' ? 'W' : 'L'} ${t.symbol} ${t.direction} | gross: $${gross.toFixed(2)} | fee: $${fee.toFixed(2)} | net: $${net.toFixed(2)}`);
      }
      lines.push(`\n**Summary:** ${wins}W/${recent.length - wins}L | Net: $${totalNet.toFixed(2)} | Fees: $${totalFee.toFixed(2)}`);
      return { from: 'Coordinator', message: lines.join('\n') };
    } catch (err) {
      return { from: 'Coordinator', message: `Can't load trade history: ${err.message}` };
    }
  }

  async _buildFeeChat() {
    try {
      const { query } = require('../db');
      const fees = await query(
        `SELECT COALESCE(SUM(trading_fee), 0) as total_fee, COUNT(*) as trades
         FROM trades WHERE status IN ('WIN','LOSS','TP','SL','CLOSED') AND trading_fee > 0`
      );
      const f = fees[0];
      const totalFee = parseFloat(f.total_fee) || 0;
      const count = parseInt(f.trades) || 0;
      if (count === 0) return { from: 'Coordinator', message: 'No fee data recorded yet. Fees will be tracked on future trades.' };
      const avg = totalFee / count;
      return { from: 'Coordinator', message: `**Fee Report**\n\nTotal fees paid: $${totalFee.toFixed(2)}\nTrades with fees: ${count}\nAvg fee per trade: $${avg.toFixed(2)}` };
    } catch (err) {
      return { from: 'Coordinator', message: `Can't load fee data: ${err.message}` };
    }
  }

  async _buildMemoryChat(text) {
    const hermes = require('../hermes-bridge');

    // Check if asking about specific agent
    const agentMatch = text.match(/(chart|trader|risk|sentiment|accountant)/);
    const agentKey = agentMatch ? agentMatch[1] : null;

    const lines = [];
    const agents = agentKey ? [[agentKey, this._agents.get(agentKey)]] : [...this._agents.entries()];

    for (const [key, agent] of agents) {
      if (!agent) continue;
      const memories = await agent.recallAll();
      const lessons = await agent.getLessons(null, 5);
      const hermesMemories = agent.hermesRecallAll ? agent.hermesRecallAll() : [];

      if (memories.length === 0 && lessons.length === 0 && hermesMemories.length === 0) continue;

      lines.push(`**${agent.name}:**`);
      if (memories.length > 0) {
        lines.push(`  DB Memories: ${memories.length}`);
        for (const m of memories.slice(0, 3)) {
          const val = typeof m.value === 'object' ? JSON.stringify(m.value).substring(0, 60) : String(m.value);
          lines.push(`  • [${m.category}] ${m.key}: ${val}`);
        }
        if (memories.length > 3) lines.push(`  ...and ${memories.length - 3} more`);
      }
      if (hermesMemories.length > 0) {
        lines.push(`  Persistent Memories: ${hermesMemories.length}`);
        for (const entry of hermesMemories.slice(-3)) {
          lines.push(`  • ${entry.substring(0, 80)}`);
        }
      }
      if (lessons.length > 0) {
        lines.push(`  Lessons: ${lessons.length}`);
        for (const l of lessons.slice(0, 3)) {
          lines.push(`  • ${l.lesson.substring(0, 70)}`);
        }
      }
      lines.push('');
    }

    // Team memory
    const teamMemories = hermes.readTeamMemory();
    if (teamMemories.length > 0) {
      lines.push(`**Team Shared Memory:**`);
      for (const entry of teamMemories.slice(-5)) {
        lines.push(`  • ${entry.substring(0, 80)}`);
      }
      lines.push('');
    }

    if (lines.length === 0) {
      return { from: 'Coordinator', message: 'No memories or lessons stored yet. Agents will start learning after their first trades and scans.' };
    }

    return { from: 'Coordinator', message: `**Agent Memory & Lessons**\n\n${lines.join('\n')}` };
  }

  // ── Agent Profiles ─────────────────────────────────────────

  getAllProfiles() {
    const profiles = {};
    for (const [key, agent] of this._agents) {
      profiles[key] = {
        ...agent.getProfile(),
        health: agent.getHealth(),
      };
    }
    return profiles;
  }

  getAgentProfile(agentKey) {
    const agent = this._agents.get(agentKey);
    if (!agent) return null;
    return { ...agent.getProfile(), health: agent.getHealth() };
  }

  updateAgentConfig(agentKey, changes) {
    const agent = this._agents.get(agentKey);
    if (!agent) return { ok: false, error: `Agent "${agentKey}" not found` };
    agent.updateConfig(changes);
    this.log(`Config updated for ${agentKey}: ${JSON.stringify(changes)}`);
    return { ok: true };
  }

  toggleAgentSkill(agentKey, skillId, enabled) {
    const agent = this._agents.get(agentKey);
    if (!agent) return { ok: false, error: `Agent "${agentKey}" not found` };
    agent.toggleSkill(skillId, enabled);
    this.log(`Skill ${skillId} ${enabled ? 'enabled' : 'disabled'} on ${agentKey}`);
    return { ok: true };
  }

  // ── Custom Agent Creation ─────────────────────────────────

  addWatcherAgent(name, config = {}) {
    const { WatcherAgent } = require('./watcher-agent');
    const agent = new WatcherAgent(name, config);
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    this._agents.set(key, agent);
    agent.init();
    this.log(`Custom agent added: ${name} (${key})`);
    this.addActivity('command', `New agent: ${name}`);
    return { ok: true, key };
  }

  removeAgent(agentKey) {
    const core = ['chart', 'trader', 'risk', 'sentiment', 'accountant', 'kronos', 'strategy', 'police', 'coder', 'optimizer'];
    if (core.includes(agentKey)) return { ok: false, error: 'Cannot remove core agents' };
    const agent = this._agents.get(agentKey);
    if (!agent) return { ok: false, error: `Agent "${agentKey}" not found` };
    agent.shutdown();
    this._agents.delete(agentKey);
    // Clean up from tokenAgents map if it was a token agent
    const symbol = agentKey.toUpperCase() + 'USDT';
    if (this.tokenAgents.has(symbol)) {
      this.tokenAgents.delete(symbol);
      this._rebuildScanQueue();
    }
    this.log(`Agent removed: ${agentKey}`);
    return { ok: true };
  }

  // ── Health & Status ───────────────────────────────────────

  async _getAIContext() {
    const agentSummary = {};
    for (const [key, agent] of this._agents) {
      const h = agent.getHealth();
      agentSummary[key] = { name: h.name, state: h.state, paused: h.paused, runCount: h.runCount };
    }
    let openTrades = 0;
    try { const { query } = require('../db'); const r = await query("SELECT COUNT(*) as c FROM trades WHERE status = 'OPEN'"); openTrades = parseInt(r[0].c); } catch {}
    return { agents: agentSummary, cycleRunning: this.cycleRunning, totalCycles: this.runCount, openTrades };
  }

  getAgentHealthSummary() {
    const summary = {};
    for (const [name, agent] of this._agents) {
      summary[name] = agent.getHealth();
    }
    return summary;
  }

  getHealth() {
    return {
      ...super.getHealth(),
      cycleRunning: this.cycleRunning,
      agents: this.getAgentHealthSummary(),
    };
  }

  // ── Commands (from Mission Control UI) ─────────────────────

  async handleCommand(command, params = {}) {
    this.log(`Command received: ${command} ${JSON.stringify(params)}`);
    this.addActivity('command', `Command: ${command}`);

    switch (command) {
      case 'force-scan': {
        if (this.cycleRunning) return { ok: false, error: 'Cycle already running' };
        this.addActivity('command', 'Force scan triggered from Mission Control');
        const result = await this.run({ forced: true });
        return { ok: true, result };
      }

      case 'pause-agent': {
        const agent = this._agents.get(params.agent);
        if (!agent) return { ok: false, error: `Agent "${params.agent}" not found` };
        agent.paused = true;
        agent.addActivity('command', 'Paused from Mission Control');
        this.log(`Agent ${params.agent} paused`);
        return { ok: true };
      }

      case 'resume-agent': {
        const agent = this._agents.get(params.agent);
        if (!agent) return { ok: false, error: `Agent "${params.agent}" not found` };
        agent.paused = false;
        agent.addActivity('command', 'Resumed from Mission Control');
        this.log(`Agent ${params.agent} resumed`);
        return { ok: true };
      }

      case 'pause-all': {
        for (const [name, agent] of this._agents) {
          agent.paused = true;
          agent.addActivity('command', 'Paused (pause-all)');
        }
        this.paused = true;
        this.log('All agents paused');
        return { ok: true };
      }

      case 'resume-all': {
        for (const [name, agent] of this._agents) {
          agent.paused = false;
          agent.addActivity('command', 'Resumed (resume-all)');
        }
        this.paused = false;
        this.log('All agents resumed');
        return { ok: true };
      }

      case 'reset-agent': {
        const agent = this._agents.get(params.agent);
        if (!agent) return { ok: false, error: `Agent "${params.agent}" not found` };
        agent.state = 'idle';
        agent.lastError = null;
        agent.currentTask = null;
        agent.addActivity('command', 'Reset from Mission Control');
        this.log(`Agent ${params.agent} reset`);
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown command: ${command}` };
    }
  }

  // ── Full Activity (all agents) ────────────────────────────

  getAllActivity(limit = 30) {
    const all = [];
    all.push(...this.getActivity(limit).map(a => ({ ...a, agent: 'Coordinator' })));
    for (const [name, agent] of this._agents) {
      all.push(...agent.getActivity(limit).map(a => ({ ...a, agent: agent.name })));
    }
    all.sort((a, b) => b.ts - a.ts);
    return all.slice(0, limit);
  }

  // ── Shutdown ──────────────────────────────────────────────

  async shutdown() {
    this.log('Shutting down all agents...');
    // Stop CEO and token scan loops
    if (this._ceoTimer) clearInterval(this._ceoTimer);
    if (this._tokenScanTimer) clearInterval(this._tokenScanTimer);
    // Shut down strategy agent background loop
    await this.strategyAgent.shutdown().catch(() => {});
    await this.coderAgent.shutdown().catch(() => {});
    await this.optimizerAgent.shutdown().catch(() => {});
    for (const [name, agent] of this._agents) {
      await agent.shutdown();
      this.log(`  ${name}: stopped`);
    }
    await super.shutdown();
  }
}

// Singleton coordinator instance
let _instance = null;

function getCoordinator(options = {}) {
  if (!_instance) {
    _instance = new AgentCoordinator(options);
  }
  return _instance;
}

module.exports = { AgentCoordinator, getCoordinator };
