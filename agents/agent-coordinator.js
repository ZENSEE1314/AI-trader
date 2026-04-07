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

class AgentCoordinator extends BaseAgent {
  constructor(options = {}) {
    super('Coordinator', options);
    this.chartAgent = new ChartAgent(options);
    this.traderAgent = new TraderAgent(options);
    this.riskAgent = new RiskAgent(options);
    this.sentimentAgent = new SentimentAgent(options);
    this.accountantAgent = new AccountantAgent(options);

    // Agent registry — order matters for display
    this._agents = new Map();
    this._agents.set('sentiment', this.sentimentAgent);
    this._agents.set('chart', this.chartAgent);
    this._agents.set('risk', this.riskAgent);
    this._agents.set('trader', this.traderAgent);
    this._agents.set('accountant', this.accountantAgent);

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

      // ── Step 1: SentimentAgent fetches market mood ──
      let mood = 'neutral';
      if (!this.sentimentAgent.paused) {
        this.currentTask = { description: 'SentimentAgent checking mood', startedAt: Date.now() };
        try {
          const sentResult = await this.sentimentAgent.run();
          if (sentResult) mood = sentResult.mood;
          this.addActivity('info', `Market mood: ${mood}`);
        } catch (err) {
          this.addActivity('error', `Sentiment error (non-fatal): ${err.message}`);
        }
      }

      // ── Step 2: ChartAgent scans for signals ──
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

      // ── Step 3: SentimentAgent enriches signals ──
      if (signals.length > 0 && !this.sentimentAgent.paused) {
        signals = this.sentimentAgent.enrichSignals(signals);
        const enriched = signals.filter(s => s._sentimentModifier !== 0);
        if (enriched.length) {
          this.addActivity('info', `Sentiment enriched ${enriched.length} signal(s)`);
        }
      }

      // ── Step 4: RiskAgent filters signals ──
      let approvedSignals = signals;
      let riskReport = null;

      if (signals.length > 0 && !this.riskAgent.paused) {
        this.currentTask = { description: 'RiskAgent evaluating risk', startedAt: Date.now() };
        // Get current open positions for risk evaluation
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
            this.addActivity('info', `RiskAgent: ${approvedSignals.length} approved, ${riskResult.rejected.length} rejected`);
          }
        }
      }

      // ── Step 5: TraderAgent executes approved signals ──
      let tradeResult = null;

      if (!this.traderAgent.paused) {
        this.currentTask = { description: 'TraderAgent executing', startedAt: Date.now() };
        tradeResult = await this.traderAgent.run({ signals: approvedSignals, mode: 'signals' });
        if (tradeResult?.executed) {
          this.addActivity('success', `Trade executed: ${approvedSignals[0]?.symbol} ${approvedSignals[0]?.direction}`);
        }
      } else {
        this.addActivity('skip', 'TraderAgent paused — skipping execution');
      }

      this.currentTask = null;
      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      this.log(`Cycle complete in ${elapsed}s | Mood: ${mood} | Signals: ${signals.length} → ${approvedSignals.length} approved | Executed: ${tradeResult?.executed || false}`);
      this.addActivity('success', `Cycle done in ${elapsed}s`);

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

    // ── Status / report queries ──
    if (/^(status|report|what.*(doing|happening|going on)|how.*(are|is)|sitrep|update)/.test(text)) {
      return this._buildStatusChat();
    }
    if (/^(who|which|what).*(trading|open|position)/.test(text)) {
      return this._buildPositionsChat();
    }
    if (/^(mood|sentiment|market|how.*(market|crypto))/.test(text)) {
      return this._buildSentimentChat();
    }
    if (/^(signal|what.*(found|see|scan)|any.*(signal|trade|setup))/.test(text)) {
      return this._buildSignalsChat();
    }
    if (/^(risk|danger|safe|exposure|drawdown)/.test(text)) {
      return this._buildRiskChat();
    }
    if (/^(performance|win|loss|how.*doing|results|pnl|profit)/.test(text)) {
      return this._buildPerformanceChat();
    }
    // Accountant commands — audit and fix trades
    if (/accountant|audit|check.*trad|fix.*trad|fix.*pnl|wrong.*pnl|correct.*pnl|recalc|recheck/.test(text)) {
      return this._runAccountantAudit();
    }
    if (/^(pnl|profit|loss|trade history|trades|show.*trade|my.*trade|earnings|revenue|income|how much.*(made|lost|earn))/.test(text)) {
      return this._buildTradeHistoryChat();
    }
    if (/^(fee|commission|cost|how much.*pay|charges)/.test(text)) {
      return this._buildFeeChat();
    }
    if (/^(help|what can you|commands|how do i)/.test(text)) {
      return { from: 'Coordinator', message: 'You can tell me:\n\n• "scan now" — hunt for trades\n• "pause/resume all" — control all agents\n• "pause/resume chart/trader/risk/sentiment" — control one agent\n• "status" — full team report\n• "what are you trading?" — open positions\n• "any signals?" — latest scan results\n• "market mood?" — sentiment report\n• "risk report" — risk exposure\n• "performance" — win/loss stats\n• "trade history" / "pnl" — last 10 trades with fees\n• "fees" — total fees paid\n• "accountant" / "audit trades" / "fix pnl" — audit & fix all trade records\n• "check trades" — recalculate PnL + recover missing fees' };
    }

    // Catch-all
    return { from: 'Coordinator', message: `I didn't understand "${message}". Try "status", "scan now", "pause chart", or "help" to see what I can do.` };
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
    // Don't allow removing core agents
    const core = ['chart', 'trader', 'risk', 'sentiment'];
    if (core.includes(agentKey)) return { ok: false, error: 'Cannot remove core agents' };
    const agent = this._agents.get(agentKey);
    if (!agent) return { ok: false, error: `Agent "${agentKey}" not found` };
    agent.shutdown();
    this._agents.delete(agentKey);
    this.log(`Agent removed: ${agentKey}`);
    return { ok: true };
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
