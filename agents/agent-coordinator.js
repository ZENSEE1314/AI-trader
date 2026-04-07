// ============================================================
// AgentCoordinator — Orchestrates all trading agents
//
// Phase 2: Decoupled pipeline
//   1. ChartAgent scans for signals (via smc-engine)
//   2. Coordinator evaluates & approves signals
//   3. TraderAgent executes approved signals + manages positions
//   4. Results fed back for learning
//
// Future phases will add:
//   - RiskAgent for position sizing & portfolio risk
//   - SentimentAgent for macro context
//   - Agent voting / consensus on trades
// ============================================================

const { BaseAgent, AGENT_STATES } = require('./base-agent');
const { ChartAgent } = require('./chart-agent');
const { TraderAgent } = require('./trader-agent');

class AgentCoordinator extends BaseAgent {
  constructor(options = {}) {
    super('Coordinator', options);
    this.chartAgent = new ChartAgent(options);
    this.traderAgent = new TraderAgent(options);

    // Registry for future agents
    this._agents = new Map();
    this._agents.set('chart', this.chartAgent);
    this._agents.set('trader', this.traderAgent);

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
  }

  async init() {
    this.log('Initializing agent framework...');

    for (const [name, agent] of this._agents) {
      await agent.init();
      this.log(`  ${name}: initialized`);
    }

    this.log(`Agent framework ready — ${this._agents.size} agents loaded`);
  }

  /**
   * Run one full trading cycle through the decoupled agent pipeline.
   *
   * Flow:
   *   1. ChartAgent scans market for SMC signals
   *   2. Coordinator logs signal count
   *   3. TraderAgent syncs positions, executes signals, manages trailing SL
   */
  async execute(context = {}) {
    if (this.cycleRunning) {
      this.log('Cycle already running — skipping');
      return null;
    }

    this.cycleRunning = true;
    const cycleStart = Date.now();
    this.addActivity('info', 'Cycle started');

    try {
      // Resolve top N coins from DB (same as cycle.js main())
      let topNCoins = 50;
      try {
        const { query: dbQuery } = require('../db');
        const topNRows = await dbQuery('SELECT MAX(top_n_coins) as max_n FROM api_keys WHERE enabled = true');
        topNCoins = parseInt(topNRows[0]?.max_n) || 50;
      } catch (_) {}

      // ── Step 1: ChartAgent scans for signals ──
      let signals = [];
      let scanResult = null;

      if (!this.chartAgent.paused) {
        this.currentTask = { description: 'ChartAgent scanning market', startedAt: Date.now() };
        const chartOutput = await this.chartAgent.run({ topNCoins });
        if (chartOutput) {
          signals = chartOutput.signals || [];
          scanResult = chartOutput.scanResult;
        }
        this.addActivity('info', `ChartAgent found ${signals.length} signal(s)`);
      } else {
        this.addActivity('skip', 'ChartAgent paused — skipping scan');
      }

      // ── Step 2: TraderAgent executes signals + manages positions ──
      let tradeResult = null;

      if (!this.traderAgent.paused) {
        this.currentTask = { description: 'TraderAgent executing', startedAt: Date.now() };
        tradeResult = await this.traderAgent.run({ signals, mode: 'signals' });
        if (tradeResult?.executed) {
          this.addActivity('success', `Trade executed: ${signals[0]?.symbol} ${signals[0]?.direction}`);
        }
      } else {
        this.addActivity('skip', 'TraderAgent paused — skipping execution');
      }

      this.currentTask = null;
      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      this.log(`Cycle complete in ${elapsed}s | Signals: ${signals.length} | Executed: ${tradeResult?.executed || false}`);
      this.addActivity('success', `Cycle done in ${elapsed}s`);

      return {
        elapsed: parseFloat(elapsed),
        signals: signals.length,
        scanResult,
        tradeResult,
        agents: this.getAgentHealthSummary(),
      };
    } catch (err) {
      this.addActivity('error', `Cycle error: ${err.message}`);
      throw err;
    } finally {
      this.cycleRunning = false;
      this.currentTask = null;
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

  // ── Health & Status ───────────────────────────────────────

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
