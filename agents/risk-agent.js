// ============================================================
// RiskAgent — Portfolio risk management & signal filtering
//
// Sits between ChartAgent and TraderAgent in the pipeline.
// Evaluates signals against risk rules before they reach execution.
//
// Responsibilities:
//   - Max open position limits
//   - Correlated pair detection (don't open BTC + ETH same direction)
//   - Drawdown protection (reduce size after consecutive losses)
//   - Session-based risk scaling
//   - Signal quality gate (reject below threshold)
// ============================================================

const { BaseAgent } = require('./base-agent');
const aiLearner = require('../ai-learner');

// Correlated pairs check REMOVED per user direction — trade every signal independently

class RiskAgent extends BaseAgent {
  constructor(options = {}) {
    super('RiskAgent', options);
    this.maxOpenPositions = options.maxOpenPositions || 5;
    this.minSignalScore = options.minSignalScore || 0;
    this.consecutiveLosses = 0;
    this.dailyTradeCount = 0;
    this.dailyResetAt = 0;
    this.signalsApproved = 0;
    this.signalsRejected = 0;
    this.lastRiskReport = null;

    this._profile = {
      description: 'Filters signals through risk rules before they reach execution. Protects capital from overexposure.',
      role: 'Risk Manager',
      icon: 'risk',
      skills: [
        { id: 'max_positions', name: 'Max Position Limit', description: 'Block new trades when at maximum open positions', enabled: true },
        { id: 'duplicate_check', name: 'Duplicate Prevention', description: 'Block re-entry into a symbol already open', enabled: true },
        { id: 'score_gate', name: 'Score Gate', description: 'Reject signals below AI minimum score threshold', enabled: true },
        { id: 'memory', name: 'Memory', description: 'Remember which coins/pairs caused losses and avoid them', enabled: true },
        { id: 'self_learn', name: 'Self-Learning', description: 'Learn rejection patterns — which blocks saved money', enabled: true },
      ],
      config: [
        { key: 'maxOpenPositions', label: 'Max Open Positions', type: 'number', value: options.maxOpenPositions || 5, min: 1, max: 20 },
        { key: 'minSignalScore', label: 'Min Signal Score', type: 'number', value: options.minSignalScore || 0, min: 0, max: 100 },
      ],
    };
  }

  /**
   * Evaluate signals and return only approved ones.
   * @param {Object} context - { signals, openPositions }
   * @returns {Object} { approved, rejected, riskReport }
   */
  async execute(context = {}) {
    const { signals = [], openPositions = [] } = context;

    // Consume inter-agent messages from KronosAgent and StrategyAgent
    const kronosMsgs = this.consumeMessages('kronos-predictions');
    const strategyMsgs = this.consumeMessages('strategy-risk');

    const swarmIntel = new Map();
    if (kronosMsgs.length > 0) {
      const lastKronos = kronosMsgs[kronosMsgs.length - 1].payload;
      if (lastKronos?.highConf) {
        lastKronos.highConf.forEach(p => {
          swarmIntel.set(p.symbol, { confidence: p.confidence, direction: p.direction, logic: p.logic });
        });
        this.addActivity('info', `Swarm intel: ${lastKronos.highConf.length} high-conf consensus results cached`);
      }
    }
    if (strategyMsgs.length > 0) {
      const strat = strategyMsgs[strategyMsgs.length - 1].payload;
      this.addActivity('info', `Strategy intel: "${strat.name}" ${strat.winRate?.toFixed(1)}% WR, DD=${strat.maxDrawdown?.toFixed(1)}%`);
    }

    if (!signals.length) {
      return { approved: [], rejected: [], riskReport: this._buildReport([], [], openPositions) };
    }

    // Reset daily counters at midnight SGT
    const nowMs = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    if (todayStart > this.dailyResetAt) {
      this.dailyTradeCount = 0;
      this.dailyResetAt = todayStart;
    }

    // Load AI params
    const aiParams = await aiLearner.getOptimalParams();
    const minScore = aiParams.MIN_SCORE || this.minSignalScore;

    const openSymbols = openPositions.map(p =>
      typeof p === 'string' ? p : (p.symbol || p.sym || '')
    );

    const approved = [];
    const rejected = [];

    for (const signal of signals) {
      const sym = signal.symbol || signal.sym;
      const reasons = [];

      // Rule 1: Max open positions
      if (openSymbols.length + approved.length >= this.maxOpenPositions) {
        reasons.push(`Max positions (${this.maxOpenPositions})`);
      }

      // Rule 2: Already in this symbol
      if (openSymbols.includes(sym)) {
        reasons.push(`Already in ${sym}`);
      }

      // Rule 3: Min score gate
      // Skip for signals that already carry their own verified WR (backtest-gate will validate)
      const hasTrustedWr = (signal.strategyWinRate || 0) >= 60;
      if (!hasTrustedWr && signal.score < minScore) {
        reasons.push(`Score ${signal.score} < min ${minScore}`);
      }

      // Rule 4b: Swarm Consensus Gate (skip for trusted-WR signals — swarm may have no data yet)
      const swarm = swarmIntel.get(sym);
      if (swarm && !hasTrustedWr) {
        // If the swarm is heavily conflicted (confidence < 50%), block it even if score is high
        if (swarm.confidence < 50) {
          reasons.push(`Swarm conflict (Conf: ${swarm.confidence}%)`);
        }
        // If the swarm direction contradicts the signal direction, it's a major red flag
        if (swarm.direction !== 'NEUTRAL' && swarm.direction !== signal.direction) {
          reasons.push(`Swarm contradiction (${swarm.direction} vs ${signal.direction})`);
        }
      }

      if (reasons.length > 0) {
        rejected.push({ signal, reasons });
        this.signalsRejected++;
        this.logTrade(`REJECTED: ${sym} ${signal.direction} — ${reasons.join(', ')}`);
        this.addActivity('skip', `Rejected ${sym}: ${reasons[0]}`);
        // Learn: record rejection
        if (this.isSkillEnabled('self_learn')) {
          this.learn('rejection', { symbol: sym, direction: signal.direction, score: signal.score },
            { reasons }, `Blocked ${sym}: ${reasons[0]}`, 0).catch(() => {});
        }
        // Hermes: share important blocks with team
        if (reasons.some(r => r.includes('Correlated') || r.includes('Max positions'))) {
          this.shareWithTeam(`Risk blocked ${sym} ${signal.direction}: ${reasons[0]}`);
        }
      } else {
        approved.push(signal);
        this.signalsApproved++;
        this.addActivity('success', `Approved ${sym} ${signal.direction} score=${signal.score}`);
        // NOTE: XP awarded only when approved signal wins (see cycle.js)
        // Memory: remember approved signals
        if (this.isSkillEnabled('memory')) {
          this.remember(`approved_${sym}`, { direction: signal.direction, score: signal.score, ts: Date.now() }, 'approved').catch(() => {});
        }
      }
    }

    const riskReport = this._buildReport(approved, rejected, openPositions);
    this.lastRiskReport = riskReport;

    this.logTrade(`Risk check: ${approved.length} approved, ${rejected.length} rejected | Open: ${openSymbols.length}/${this.maxOpenPositions}`);

    return { approved, rejected, riskReport };
  }

  async _getAIContext() {
    return {
      maxOpenPositions: this.maxOpenPositions,
      signalsApproved: this.signalsApproved,
      signalsRejected: this.signalsRejected,
      lastRiskReport: this.lastRiskReport,
    };
  }

  _buildReport(approved, rejected, openPositions) {
    return {
      ts: Date.now(),
      openPositionCount: openPositions.length,
      maxPositions: this.maxOpenPositions,
      dailyTradeCount: this.dailyTradeCount,
      signalsReceived: approved.length + rejected.length,
      approved: approved.length,
      rejected: rejected.length,
      rejectionReasons: rejected.map(r => ({ symbol: r.signal.symbol, reasons: r.reasons })),
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      signalsApproved: this.signalsApproved,
      signalsRejected: this.signalsRejected,
      maxOpenPositions: this.maxOpenPositions,
      lastRiskReport: this.lastRiskReport,
    };
  }
}

module.exports = { RiskAgent };
