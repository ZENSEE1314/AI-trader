// ============================================================
// AgentCoordinator — Orchestrates all trading agents
//
// Manages the lifecycle of ChartAgent and TraderAgent,
// routes messages between them, and provides a unified
// interface for bot.js to interact with.
//
// Phase 1: Simple sequential pipeline
//   ChartAgent.scan() → signals → TraderAgent.execute()
//
// Future phases will add:
//   - RiskAgent for position sizing & portfolio risk
//   - SentimentAgent for macro context
//   - Parallel agent execution
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
   * Run one full trading cycle through the agent pipeline.
   *
   * Phase 1 flow (preserves existing behavior):
   *   1. TraderAgent runs the full cycle.js pipeline
   *      (which internally calls scanSMC, executes trades, etc.)
   *
   * Phase 2 flow (future — decoupled):
   *   1. ChartAgent scans for signals
   *   2. Coordinator evaluates signals
   *   3. TraderAgent executes approved signals
   *   4. Results fed back to ChartAgent for learning
   */
  async execute(context = {}) {
    if (this.cycleRunning) {
      this.log('Cycle already running — skipping');
      return null;
    }

    this.cycleRunning = true;
    const cycleStart = Date.now();

    try {
      // Phase 1: delegate to TraderAgent which calls cycle.run()
      const tradeResult = await this.traderAgent.run({ mode: 'full' });

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      this.log(`Cycle complete in ${elapsed}s`);

      return {
        elapsed: parseFloat(elapsed),
        tradeResult,
        agents: this.getAgentHealthSummary(),
      };
    } finally {
      this.cycleRunning = false;
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
