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

    this._profile = {
      description: 'Fetches market sentiment from multiple sources and provides mood context to the trading pipeline.',
      role: 'Market Analyst',
      icon: 'sentiment',
      skills: [
        { id: 'coingecko', name: 'CoinGecko Trending', description: 'Track trending coins and market cap rankings', enabled: true },
        { id: 'cryptopanic', name: 'CryptoPanic News', description: 'Scan crypto news for bullish/bearish keywords', enabled: true },
        { id: 'binance_momentum', name: 'Binance Momentum', description: 'Detect momentum surges from 24h volume data', enabled: true },
        { id: 'x_twitter', name: 'X/Twitter Sentiment', description: 'Monitor crypto mentions and sentiment on X', enabled: true },
        { id: 'extreme_detect', name: 'Extreme Event Detection', description: 'Flag FOMO/FUD when multiple sources spike', enabled: true },
        { id: 'signal_enrich', name: 'Signal Enrichment', description: 'Add sentiment modifier to ChartAgent signals', enabled: true },
        { id: 'memory', name: 'Memory', description: 'Remember mood history and extreme events across restarts', enabled: true },
        { id: 'self_learn', name: 'Self-Learning', description: 'Track if mood predictions aligned with market moves', enabled: true },
      ],
      config: [
        { key: 'maxHistory', label: 'Mood History Size', type: 'number', value: 50, min: 10, max: 200 },
      ],
    };
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

    // Memory: persist mood and extreme events
    if (this.isSkillEnabled('memory')) {
      await this.remember('last_mood', { mood, bullishPct, bearishPct, ts: Date.now() }, 'mood');
      await this.remember('mood_streak', {
        current: mood,
        count: (this.moodHistory.filter(m => m.mood === mood).length),
      }, 'mood');
    }
    // Learn: track mood accuracy
    if (this.isSkillEnabled('self_learn') && this.moodHistory.length >= 2) {
      const prev = this.moodHistory[this.moodHistory.length - 2];
      if (prev.mood !== mood) {
        this.learn('mood_shift', { from: prev.mood, to: mood }, { bullishPct, bearishPct },
          `Mood shifted ${prev.mood} → ${mood}`, 0).catch(() => {});
      }
    }

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

  async _getAIContext() {
    const topCoins = this.lastScores ? Object.entries(this.lastScores)
      .filter(([, v]) => v.trendScore > 0.2)
      .sort((a, b) => b[1].trendScore - a[1].trendScore)
      .slice(0, 5)
      .map(([sym, v]) => ({ symbol: sym, trend: v.trendScore, sentiment: v.sentiment, mentions: v.mentions }))
      : [];
    return {
      mood: this.lastMood,
      coinsTracked: this.lastScores ? Object.keys(this.lastScores).length : 0,
      topCoins,
      extremeEvents: this.extremeEvents.slice(-3),
      moodHistory: this.moodHistory.slice(-5),
    };
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
