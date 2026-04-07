// ============================================================
// SentimentAgent — Market sentiment & macro context
//
// Wraps sentiment-scraper.js and provides market context
// to the Coordinator and other agents.
//
// Responsibilities:
//   - Fetch & cache sentiment scores from multiple sources
//   - Provide overall market mood (risk-on / risk-off / neutral)
//   - Flag extreme sentiment events (FUD / FOMO)
//   - Boost/penalize signals based on sentiment alignment
// ============================================================

const { BaseAgent } = require('./base-agent');
const { getSentimentScores, getSentimentModifier, getSentimentSummary } = require('../sentiment-scraper');

const MOOD_THRESHOLDS = {
  RISK_ON:  0.6,   // >60% of tracked coins bullish
  RISK_OFF: 0.4,   // >60% of tracked coins bearish
};

class SentimentAgent extends BaseAgent {
  constructor(options = {}) {
    super('SentimentAgent', options);
    this.lastScores = null;
    this.lastMood = 'neutral';
    this.moodHistory = [];
    this.maxHistory = 50;
    this.scansCompleted = 0;
    this.extremeEvents = [];
  }

  /**
   * Fetch latest sentiment and derive market mood.
   * @returns {Object} { mood, scores, summary, stats }
   */
  async execute(context = {}) {
    this.currentTask = { description: 'Fetching market sentiment', startedAt: Date.now() };
    this.scansCompleted++;

    // 1. Fetch scores from all sources
    const scores = await getSentimentScores();
    this.lastScores = scores;

    // 2. Calculate overall market mood
    const entries = Object.entries(scores);
    const withSentiment = entries.filter(([, v]) => v.sentiment !== 'neutral');
    const bullishCount = withSentiment.filter(([, v]) => v.sentiment === 'bullish').length;
    const bearishCount = withSentiment.filter(([, v]) => v.sentiment === 'bearish').length;
    const total = withSentiment.length || 1;

    const bullishPct = bullishCount / total;
    const bearishPct = bearishCount / total;

    let mood = 'neutral';
    if (bullishPct >= MOOD_THRESHOLDS.RISK_ON) mood = 'risk-on';
    else if (bearishPct >= 1 - MOOD_THRESHOLDS.RISK_OFF) mood = 'risk-off';

    this.lastMood = mood;
    this.moodHistory.push({ mood, ts: Date.now(), bullishPct, bearishPct });
    if (this.moodHistory.length > this.maxHistory) this.moodHistory.shift();

    // 3. Detect extreme events
    const highTrend = entries.filter(([, v]) => v.trendScore > 0.8);
    const highMentions = entries.filter(([, v]) => v.mentions > 20);
    if (highTrend.length > 3 || highMentions.length > 3) {
      const event = {
        ts: Date.now(),
        type: mood === 'risk-off' ? 'FUD' : mood === 'risk-on' ? 'FOMO' : 'HYPE',
        coins: highTrend.map(([sym]) => sym).slice(0, 5),
      };
      this.extremeEvents.push(event);
      if (this.extremeEvents.length > 20) this.extremeEvents.shift();
      this.addActivity('warning', `Extreme event: ${event.type} — ${event.coins.join(', ')}`);
    }

    // 4. Summary stats
    const stats = {
      totalCoinsTracked: entries.length,
      bullish: bullishCount,
      bearish: bearishCount,
      neutral: total - bullishCount - bearishCount,
      avgTrendScore: entries.length ? entries.reduce((s, [, v]) => s + v.trendScore, 0) / entries.length : 0,
    };

    this.addActivity('success', `Mood: ${mood} (${bullishCount}B/${bearishCount}R/${stats.neutral}N) — ${entries.length} coins`);
    this.currentTask = null;

    return { mood, scores, stats };
  }

  /**
   * Get sentiment modifier for a specific signal.
   * Positive = aligned with sentiment, negative = against.
   */
  getSignalModifier(symbol, direction) {
    return getSentimentModifier(symbol, direction);
  }

  /**
   * Apply sentiment modifiers to an array of signals.
   * Returns signals with _sentimentModifier and _sentimentNote attached.
   */
  enrichSignals(signals) {
    if (!this.lastScores) return signals;

    return signals.map(signal => {
      const sym = signal.symbol || signal.sym;
      const mod = this.getSignalModifier(sym, signal.direction);
      const score = this.lastScores[sym];

      signal._sentimentModifier = mod;
      signal._sentimentNote = score
        ? `${score.sentiment} (trend:${(score.trendScore * 100).toFixed(0)}% mentions:${score.mentions})`
        : 'no data';

      return signal;
    });
  }

  getMood() {
    return this.lastMood;
  }

  getMoodHistory() {
    return this.moodHistory;
  }

  getHealth() {
    return {
      ...super.getHealth(),
      mood: this.lastMood,
      scansCompleted: this.scansCompleted,
      coinsTracked: this.lastScores ? Object.keys(this.lastScores).length : 0,
      extremeEvents: this.extremeEvents.length,
      lastMoodChange: this.moodHistory.length > 1
        ? this.moodHistory[this.moodHistory.length - 1].ts
        : null,
    };
  }
}

module.exports = { SentimentAgent };
