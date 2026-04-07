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
const { scanSMC, isGoodTradingSession } = require('../smc-engine');
const { getSentimentScores } = require('../sentiment-scraper');
const aiLearner = require('../ai-learner');

class ChartAgent extends BaseAgent {
  constructor(options = {}) {
    super('ChartAgent', options);
    this.lastSignals = [];
    this.scanHistory = [];      // rolling window of last N scans
    this.maxHistory = 50;
  }

  async execute(context = {}) {
    const { topNCoins = 50, forceScan = false } = context;

    this.logScan('Starting market scan...');

    // 1. Load AI params for scoring adjustments
    const aiParams = await aiLearner.getOptimalParams();
    this.logScan(`AI params loaded: minScore=${aiParams.MIN_SCORE} TP=${(aiParams.TP_MARGIN_PCT * 100).toFixed(1)}% SL=${(aiParams.SL_MARGIN_PCT * 100).toFixed(1)}%`);

    // 2. Check trading session quality
    const session = aiLearner.getCurrentSession();
    const sessionGood = isGoodTradingSession();
    this.logScan(`Session: ${session} | Good session: ${sessionGood}`);

    // 3. Run SMC scan
    const signals = await scanSMC(
      (msg) => this.logScan(msg),
      { topNCoins }
    );

    // 4. Record scan result
    const scanResult = {
      ts: Date.now(),
      session,
      signalCount: signals.length,
      topSignal: signals[0] || null,
      aiParams,
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
    }

    // 5. Emit signals event
    this.emit('signals', { signals, scanResult });

    return { signals, scanResult };
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
