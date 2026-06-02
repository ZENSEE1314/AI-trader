'use strict';

// ============================================================
// MarketDecisionAgent
//
// Final trade-quality gate before TraderAgent execution.
// Combines:
//   - Recent live mistake memory
//   - Market/news sentiment alignment
//   - Signal structural quality hints
//
// It is intentionally a gate, not an oracle. It blocks bad conditions and
// annotates approved trades; it does not invent trades by itself.
// ============================================================

const { BaseAgent } = require('./base-agent');
const { log: bLog } = require('../bot-logger');
const { analyzeRecentTrades } = require('../pattern-analyzer');

const DEFAULTS = {
  enabled: process.env.MARKET_DECISION_AGENT !== '0',
  minScore: parseFloat(process.env.MARKET_DECISION_MIN_SCORE || '70'),
  minRecentWr: parseFloat(process.env.MARKET_DECISION_MIN_RECENT_WR || '45'),
  allowSentimentConflict: process.env.MARKET_DECISION_ALLOW_SENTIMENT_CONFLICT === '1',
  recentTradeLookback: parseInt(process.env.MARKET_DECISION_LOOKBACK || '20', 10),
  baseSizeMod: parseFloat(process.env.MARKET_DECISION_BASE_SIZE || '0.70'),
  goodSizeMod: parseFloat(process.env.MARKET_DECISION_GOOD_SIZE || '1.00'),
  highSizeMod: parseFloat(process.env.MARKET_DECISION_HIGH_SIZE || '1.50'),
  maxSizeMod: parseFloat(process.env.MARKET_DECISION_MAX_SIZE || '2.00'),
};

class MarketDecisionAgent extends BaseAgent {
  constructor(options = {}) {
    super('MarketDecisionAgent', options);
    this.enabled = DEFAULTS.enabled;
    this.minScore = DEFAULTS.minScore;
    this.minRecentWr = DEFAULTS.minRecentWr;
    this.allowSentimentConflict = DEFAULTS.allowSentimentConflict;
    this.recentTradeLookback = DEFAULTS.recentTradeLookback;
    this.baseSizeMod = DEFAULTS.baseSizeMod;
    this.goodSizeMod = DEFAULTS.goodSizeMod;
    this.highSizeMod = DEFAULTS.highSizeMod;
    this.maxSizeMod = DEFAULTS.maxSizeMod;
    this.decisions = 0;
    this.approved = 0;
    this.rejected = 0;
    this.lastDecisionReport = null;

    this._profile = {
      description: 'Final market decision gate. Uses structure, recent trade mistakes, and market/news sentiment before execution.',
      role: 'Market Decision Officer',
      icon: 'decision',
      skills: [
        { id: 'mistake_memory', name: 'Mistake Memory', description: 'Blocks recent losing symbol/setup behavior', enabled: true },
        { id: 'sentiment_gate', name: 'News Sentiment Gate', description: 'Avoids trading directly against strong market mood', enabled: true },
        { id: 'structure_gate', name: 'Structure Quality Gate', description: 'Requires strong SMC structure metadata', enabled: true },
      ],
      config: [
        { key: 'enabled', label: 'Enabled', type: 'boolean', value: this.enabled },
        { key: 'minScore', label: 'Minimum Signal Score', type: 'number', value: this.minScore, min: 0, max: 100 },
        { key: 'minRecentWr', label: 'Minimum Recent WR', type: 'number', value: this.minRecentWr, min: 0, max: 100 },
        { key: 'baseSizeMod', label: 'Base Size Multiplier', type: 'number', value: this.baseSizeMod, min: 0.1, max: 1 },
        { key: 'highSizeMod', label: 'High Confidence Size Multiplier', type: 'number', value: this.highSizeMod, min: 1, max: 2 },
      ],
    };
  }

  async execute(context = {}) {
    const { signals = [], sentimentAgent = null } = context;
    if (!signals.length) {
      return { approved: [], rejected: [], report: this._buildReport([], []) };
    }

    const approved = [];
    const rejected = [];

    for (const signal of signals) {
      const decision = await this._evaluateSignal(signal, sentimentAgent);
      this.decisions++;

      if (decision.pass || !this.enabled) {
        const size = this._sizeForDecision(signal, decision);
        const enriched = {
          ...signal,
          marketDecision: decision,
          sizeMod: Math.min(this.maxSizeMod, Math.max(0.1, (signal.sizeMod || 1) * size.mod)),
          sizeReason: size.reason,
          score: Math.max(signal.score || 0, decision.score),
        };
        approved.push(enriched);
        this.approved++;
        this.addActivity('success', `Approved ${signal.symbol} ${signal.direction}: ${decision.summary}`);
      } else {
        rejected.push({ signal, reasons: decision.reasons, decision });
        this.rejected++;
        this.addActivity('skip', `Rejected ${signal.symbol} ${signal.direction}: ${decision.reasons[0]}`);
      }
    }

    this.lastDecisionReport = this._buildReport(approved, rejected);
    bLog.scan(`[MDA] approved=${approved.length}/${signals.length} rejected=${rejected.length}`);
    return { approved, rejected, report: this.lastDecisionReport };
  }

  async _evaluateSignal(signal, sentimentAgent) {
    const reasons = [];
    let score = signal.score || 0;
    const sym = signal.symbol || signal.sym || '';
    const dir = signal.direction;
    const setup = signal.setupName || signal.setup || 'unknown';

    if (score < this.minScore) {
      reasons.push(`score ${score} < ${this.minScore}`);
    }

    const structure = this._scoreStructure(signal);
    score += structure.bonus;
    if (structure.block) reasons.push(structure.block);

    const sentiment = this._scoreSentiment(signal, sentimentAgent);
    score += sentiment.bonus;
    if (sentiment.block) reasons.push(sentiment.block);

    const memory = await this._scoreMistakeMemory(sym, setup);
    score += memory.bonus;
    if (memory.block) reasons.push(memory.block);

    const pass = reasons.length === 0;
    return {
      pass,
      score,
      reasons,
      summary: pass
        ? `score=${score.toFixed(0)} structure=${structure.label} sentiment=${sentiment.label} memory=${memory.label}`
        : reasons.join('; '),
      structure,
      sentiment,
      memory,
    };
  }

  _sizeForDecision(signal, decision) {
    const score = decision.score || signal.score || 0;
    const recentWr = decision.memory?.winRate ?? null;
    const sentimentAligned = String(decision.sentiment?.label || '').startsWith('aligned');

    if (score >= 90 && (recentWr == null || recentWr >= 60) && sentimentAligned) {
      return { mod: this.highSizeMod, reason: `high-confidence score=${score.toFixed(0)} recentWR=${recentWr ?? 'n/a'} sentiment=aligned` };
    }
    if (score >= 80 && (recentWr == null || recentWr >= 50)) {
      return { mod: this.goodSizeMod, reason: `good-confidence score=${score.toFixed(0)} recentWR=${recentWr ?? 'n/a'}` };
    }
    return { mod: this.baseSizeMod, reason: `normal-confidence score=${score.toFixed(0)} using reduced size` };
  }

  _scoreStructure(signal) {
    const ctx = signal.smcContext || {};
    const pattern = ctx.pattern || signal.pattern || signal.setupName || '';
    const tf = ctx.tf || signal.timeframe || '';

    if (!pattern && !tf) {
      return { label: 'missing', bonus: 0, block: 'missing structure context' };
    }
    if (/LL→LH|HH→HL|LH|HL|LL|HH/.test(String(pattern)) || /15m\+1m/i.test(String(tf))) {
      return { label: pattern || tf, bonus: 5, block: null };
    }
    return { label: pattern || tf, bonus: 0, block: null };
  }

  _scoreSentiment(signal, sentimentAgent) {
    if (!sentimentAgent || sentimentAgent.paused) {
      return { label: 'unavailable', bonus: 0, block: null };
    }
    const mood = sentimentAgent.getMood ? sentimentAgent.getMood() : 'neutral';
    const dir = signal.direction;
    const mod = typeof sentimentAgent.getSignalModifier === 'function'
      ? sentimentAgent.getSignalModifier(signal.symbol, dir)
      : (signal._sentimentModifier || 0);

    if (!this.allowSentimentConflict) {
      if (mood === 'risk-on' && dir === 'SHORT' && mod < 0) {
        return { label: `conflict:${mood}`, bonus: -10, block: 'risk-on news conflicts with SHORT' };
      }
      if (mood === 'risk-off' && dir === 'LONG' && mod < 0) {
        return { label: `conflict:${mood}`, bonus: -10, block: 'risk-off news conflicts with LONG' };
      }
    }

    if (mod > 0) return { label: `aligned:${mood}`, bonus: 5, block: null };
    if (mod < 0) return { label: `soft-conflict:${mood}`, bonus: -5, block: null };
    return { label: mood || 'neutral', bonus: 0, block: null };
  }

  async _scoreMistakeMemory(symbol, setup) {
    try {
      const result = await analyzeRecentTrades(symbol, this.recentTradeLookback);
      if (!result.ready) return { label: result.reason || 'not-ready', bonus: 0, block: null };

      const wr = parseFloat(result.winRate);
      if (Number.isFinite(wr) && wr < this.minRecentWr) {
        return { label: `recentWR=${wr.toFixed(1)}%`, bonus: -10, block: `${symbol} recent WR ${wr.toFixed(1)}% < ${this.minRecentWr}%` };
      }

      const avoidCombo = result.filters?.bestPivotCombo ? null : null;
      if (avoidCombo && setup.includes(avoidCombo)) {
        return { label: 'avoid-combo', bonus: -10, block: `setup matches losing memory ${avoidCombo}` };
      }

      return { label: `recentWR=${wr.toFixed(1)}%`, winRate: wr, bonus: wr >= 60 ? 10 : 5, block: null };
    } catch (err) {
      return { label: `memory-error:${err.message}`, bonus: 0, block: null };
    }
  }

  _buildReport(approved, rejected) {
    return {
      ts: Date.now(),
      enabled: this.enabled,
      approved: approved.length,
      rejected: rejected.length,
      rejectedReasons: rejected.map(r => ({
        symbol: r.signal.symbol,
        direction: r.signal.direction,
        reasons: r.reasons,
      })),
      totalDecisions: this.decisions,
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      enabled: this.enabled,
      decisions: this.decisions,
      approved: this.approved,
      rejected: this.rejected,
      lastDecisionReport: this.lastDecisionReport,
    };
  }
}

module.exports = { MarketDecisionAgent };
