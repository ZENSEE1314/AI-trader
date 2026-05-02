// ============================================================
// ChartAgent — Market scanning & signal generation
//
// Wraps smc-engine.js + scalper-ai.js to produce trade signals.
// Responsibilities:
//   - Scan top coins for SMC setups
//   - Score and rank candidates
//   - Emit ranked signals for TraderAgent consumption
// ============================================================

const { BaseAgent } = require('./base-agent');
const aiLearner = require('../ai-learner');

class ChartAgent extends BaseAgent {
  constructor(options = {}) {
    super('ChartAgent', options);
    this.lastSignals = [];
    this.scanHistory = [];
    this.maxHistory = 50;

    this._profile = {
      description: 'Scans all markets for high-probability SMC trade setups using multi-timeframe analysis.',
      role: 'Market Scanner',
      icon: 'chart',
      skills: [
        { id: 'smc_scan', name: 'SMC Scan', description: 'Swing Cascade strategy — 4H/1H/15M/1M confirmation', enabled: true },
        { id: 'scalper_confirm', name: 'Scalper Confirmation', description: 'Composite oscillator (ADX, RSI, ATR, OBV) entry filter', enabled: true },
        { id: 'volume_filter', name: 'Volume Filter', description: 'Reject coins below $10M daily volume', enabled: true },
        { id: 'ai_scoring', name: 'AI Scoring', description: 'Boost signals using setup/coin/session win-rate history', enabled: true },
        { id: 'memory', name: 'Memory', description: 'Remember best-performing coins and setups across restarts', enabled: true },
        { id: 'self_learn', name: 'Self-Learning', description: 'Track which signals led to wins/losses and adjust scoring', enabled: true },
      ],
      config: [
        { key: 'topNCoins', label: 'Top N Coins to Scan', type: 'number', value: options.topNCoins || 50, min: 10, max: 200 },
        { key: 'maxHistory', label: 'Scan History Size', type: 'number', value: 50, min: 10, max: 200 },
      ],
    };
  }

  async execute(context = {}) {
    // Signal generation moved entirely to per-coin TokenAgents (analyzeV3).
    // ChartAgent stays as a system agent for the Floor / AI chat / activity
    // log, but no longer scans the market itself.
    const session = aiLearner.getCurrentSession();
    const scanResult = { ts: Date.now(), session, signalCount: 0, topSignal: null };
    this.scanHistory.push(scanResult);
    if (this.scanHistory.length > this.maxHistory) this.scanHistory.shift();
    this.lastSignals = [];
    return { signals: [], scanResult };
  }

  async _getAIContext() {
    return {
      lastSignals: this.lastSignals.map(s => ({ symbol: s.symbol, direction: s.direction, score: s.score, setup: s.setupName })),
      totalScans: this.scanHistory.length,
      topNCoins: this._profile.config.find(c => c.key === 'topNCoins')?.value || 50,
    };
  }

  // Get sentiment overlay for a specific symbol
  async getSentiment(symbols = []) {
    try {
      const scores = await getSentimentScores(symbols);
      return scores;
    } catch (err) {
      this.logError(`Sentiment fetch failed: ${err.message}`);
      return {};
    }
  }

  getLastSignals() {
    return this.lastSignals;
  }

  getScanHistory() {
    return this.scanHistory;
  }

  getHealth() {
    return {
      ...super.getHealth(),
      lastSignalCount: this.lastSignals.length,
      totalScans: this.scanHistory.length,
      lastScanAt: this.scanHistory.length
        ? this.scanHistory[this.scanHistory.length - 1].ts
        : null,
    };
  }
}

module.exports = { ChartAgent };
