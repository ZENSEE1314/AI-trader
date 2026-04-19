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
const { scanAll } = require('../trade-engine');
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
    const { topNCoins = 50, forceScan = false, kronosPredictions = null, monitoredSymbols = null } = context;

    // Consume winning strategy intel from StrategyAgent
    const stratMsgs = this.consumeMessages('winning-strategy');
    if (stratMsgs.length > 0) {
      const strat = stratMsgs[stratMsgs.length - 1].payload;
      this.addActivity('info', `Strategy intel: "${strat.name}" won with ${strat.winRate?.toFixed(1)}% WR — noted for scanning`);
    }

    this.logScan('Starting market scan (trade-engine — BTC/ETH/SOL/BNB only)...');

    const session = aiLearner.getCurrentSession();
    this.logScan(`Session: ${session}`);

    // Scan using unified trade-engine — only 4 allowed coins (BTC/ETH/SOL/BNB)
    const signals = await scanAll(
      (msg) => this.logScan(msg),
      { kronosPredictions }
    );

    // 4. Record scan result
    const scanResult = {
      ts: Date.now(),
      session,
      signalCount: signals.length,
      topSignal: signals[0] || null,
    };
    this.scanHistory.push(scanResult);
    if (this.scanHistory.length > this.maxHistory) this.scanHistory.shift();

    this.lastSignals = signals;

    if (signals.length === 0) {
      this.logScan('No signals found this scan.');
    } else {
      for (const s of signals) {
        this.logScan(`Signal: ${s.symbol} ${s.direction} score=${s.score} setup=${s.setupName}`);
      }
      // NOTE: XP awarded only when signal leads to a winning trade (see cycle.js)
    }

    // 5. Memory: remember best coins and signal patterns
    if (this.isSkillEnabled('memory') && signals.length > 0) {
      const topSignal = signals[0];
      await this.remember(`last_signal_${topSignal.symbol}`, {
        direction: topSignal.direction, score: topSignal.score,
        setup: topSignal.setupName, session, ts: Date.now(),
      }, 'signals');
      // Track signal frequency per coin
      const freq = (await this.recall(`signal_freq_${topSignal.symbol}`)) || 0;
      await this.remember(`signal_freq_${topSignal.symbol}`, freq + 1, 'frequency');
    }

    // 6. Emit signals event
    this.emit('signals', { signals, scanResult });

    return { signals, scanResult };
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
