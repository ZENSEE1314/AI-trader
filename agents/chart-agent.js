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

  explain(question) {
    const text = question.toLowerCase();
    if (/smc|smart money|how.*scan|strategy|method|swing/.test(text)) {
      return `**How I Scan (SMC Swing Cascade)**\n\nI use Smart Money Concepts across 4 timeframes:\n\n**1. Daily Bias** — check if yesterday's candle was bullish or bearish\n**2. HTF Structure (4H + 1H)** — both must align with daily bias (HH/HL for bullish, LH/LL for bearish)\n**3. Setup (15M)** — look for Higher Low (long) or Lower High (short) forming\n**4. Entry (1M)** — confirm HL or LH on the 1-minute chart\n\n**Filters:**\n• Min $10M daily volume\n• Scalper AI confirmation (ADX, RSI, ATR, OBV composite)\n• AI score boost from win-rate history per setup/coin/session\n\nI scan the top ${this._profile.config.find(c => c.key === 'topNCoins')?.value || 50} coins by volume every cycle. Only signals that pass ALL checklist items get through.`;
    }
    if (/signal|score|rank|how.*pick/.test(text)) {
      const last = this.lastSignals;
      let msg = `**Signal Scoring**\n\nEach coin gets scored 0-100:\n• Timeframe alignment: +points per TF confirming\n• AI setup weight: based on historical win rate of that setup\n• AI coin weight: based on historical win rate on that coin\n• Session weight: how well this trading session performs\n• Sentiment modifier: boost if news/trends align\n\nTop 3 signals passed to RiskAgent for filtering.`;
      if (last.length) msg += `\n\n**Last scan found ${last.length} signal(s):**\n` + last.map(s => `• ${s.symbol} ${s.direction} score=${s.score}`).join('\n');
      return msg;
    }
    return super.explain(question);
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
