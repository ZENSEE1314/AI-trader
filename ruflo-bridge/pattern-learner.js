// ============================================================
// Pattern Learner — Market pattern extraction, matching & evolution
// Transpiled from ruflo v3/@claude-flow/neural/src/pattern-learner.ts
//
// Automatically extracts recurring market patterns and tracks
// their evolution. Agents remember "this RSI+MACD combo produced
// a 70% win rate across 12 similar setups" and use that context
// for future decisions.
//
// Integrated with HNSW-Lite for fast similarity search.
// ============================================================

'use strict';

const { HnswLite, cosineSimilarity } = require('./hnsw-lite');

const DEFAULT_CONFIG = {
  maxPatterns: 500,
  matchThreshold: 0.7,
  minUsagesForStable: 5,
  qualityThreshold: 0.3,
  enableClustering: true,
  numClusters: 30,
  evolutionLearningRate: 0.1,
};

class PatternLearner {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.patterns = new Map();
    this.clusters = [];
    this.patternToCluster = new Map();
    this.hnsw = new HnswLite(16, 16, 50, 'cosine');

    this.matchCount = 0;
    this.totalMatchTime = 0;
    this.extractionCount = 0;
    this.evolutionCount = 0;
  }

  /**
   * Find similar market patterns for a given market state.
   * @param {Float32Array} queryEmbedding - market state vector
   * @param {number} k - number of matches to return
   * @returns {Array<{pattern, similarity, confidence}>}
   */
  findMatches(queryEmbedding, k = 3) {
    const start = performance.now();

    if (this.patterns.size === 0) return [];

    // Use HNSW for fast search
    const hnswResults = this.hnsw.search(queryEmbedding, k * 2, this.config.matchThreshold);

    const matches = [];
    for (const result of hnswResults) {
      const pattern = this.patterns.get(result.id);
      if (!pattern) continue;

      matches.push({
        pattern,
        similarity: result.score,
        confidence: this._computeConfidence(pattern, result.score),
      });
    }

    matches.sort((a, b) => b.similarity - a.similarity);

    this.matchCount++;
    this.totalMatchTime += performance.now() - start;

    return matches.slice(0, k);
  }

  /**
   * Find the single best matching pattern.
   */
  findBestMatch(queryEmbedding) {
    const matches = this.findMatches(queryEmbedding, 1);
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Store a new market pattern from a trade outcome.
   * @param {object} opts
   * @param {Float32Array} opts.embedding - market state vector
   * @param {string} opts.symbol
   * @param {string} opts.direction - LONG/SHORT
   * @param {string} opts.strategy - strategy name
   * @param {number} opts.quality - 0-1 (win=1, loss=0, partial based on pnl)
   * @param {object} opts.context - any extra context
   * @returns {object|null} the stored/updated pattern
   */
  storePattern(opts) {
    const { embedding, symbol, direction, strategy, quality, context } = opts;

    if (quality < this.config.qualityThreshold && this.patterns.size > 10) {
      return null;
    }

    // Check for existing similar pattern
    const existing = this._findSimilar(embedding, 0.92);
    if (existing) {
      this._updatePattern(existing, quality);
      return existing;
    }

    const patternId = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const pattern = {
      patternId,
      symbol,
      direction,
      strategy: strategy || 'unknown',
      embedding: new Float32Array(embedding),
      successRate: quality,
      usageCount: 1,
      qualityHistory: [quality],
      outcomes: { wins: quality >= 0.5 ? 1 : 0, losses: quality < 0.5 ? 1 : 0 },
      context: context || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.patterns.set(patternId, pattern);
    this.hnsw.add(patternId, embedding);

    if (this.patterns.size > this.config.maxPatterns) {
      this._prunePatterns();
    }

    this.extractionCount++;
    return pattern;
  }

  /**
   * Evolve a pattern after a new trade outcome.
   * @param {string} patternId
   * @param {number} quality - 0-1 outcome quality
   * @param {boolean} isWin
   */
  evolvePattern(patternId, quality, isWin) {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return;

    const lr = this.config.evolutionLearningRate;

    pattern.qualityHistory.push(quality);
    if (pattern.qualityHistory.length > 100) {
      pattern.qualityHistory = pattern.qualityHistory.slice(-100);
    }

    pattern.successRate = pattern.successRate * (1 - lr) + quality * lr;
    pattern.usageCount++;
    pattern.updatedAt = Date.now();

    if (isWin) pattern.outcomes.wins++;
    else pattern.outcomes.losses++;

    this.evolutionCount++;
  }

  /**
   * Merge two similar patterns into one.
   */
  mergePatterns(idA, idB) {
    const a = this.patterns.get(idA);
    const b = this.patterns.get(idB);
    if (!a || !b) return null;

    const [keep, remove] = a.successRate >= b.successRate ? [a, b] : [b, a];

    const totalUsage = keep.usageCount + remove.usageCount;
    const w1 = keep.usageCount / totalUsage;
    const w2 = remove.usageCount / totalUsage;

    for (let i = 0; i < keep.embedding.length; i++) {
      keep.embedding[i] = keep.embedding[i] * w1 + remove.embedding[i] * w2;
    }

    keep.usageCount += remove.usageCount;
    keep.outcomes.wins += remove.outcomes.wins;
    keep.outcomes.losses += remove.outcomes.losses;
    keep.qualityHistory.push(...remove.qualityHistory);
    keep.successRate = keep.qualityHistory.reduce((a, b) => a + b, 0) / keep.qualityHistory.length;

    this.patterns.delete(remove.patternId);
    this.hnsw.remove(remove.patternId);
    this.hnsw.remove(keep.patternId);
    this.hnsw.add(keep.patternId, keep.embedding);

    return keep;
  }

  /**
   * Get all stored patterns.
   */
  getPatterns() {
    return Array.from(this.patterns.values());
  }

  /**
   * Get stable patterns (enough usage to be reliable).
   */
  getStablePatterns() {
    return Array.from(this.patterns.values())
      .filter(p => p.usageCount >= this.config.minUsagesForStable);
  }

  /**
   * Get patterns filtered by symbol.
   */
  getPatternsBySymbol(symbol) {
    return Array.from(this.patterns.values()).filter(p => p.symbol === symbol);
  }

  getStats() {
    const patterns = Array.from(this.patterns.values());
    return {
      totalPatterns: this.patterns.size,
      stablePatterns: patterns.filter(p => p.usageCount >= this.config.minUsagesForStable).length,
      avgSuccessRate: patterns.length > 0
        ? Math.round(patterns.reduce((s, p) => s + p.successRate, 0) / patterns.length * 100) / 100
        : 0,
      avgMatchTimeMs: this.matchCount > 0
        ? Math.round(this.totalMatchTime / this.matchCount * 100) / 100
        : 0,
      matchCount: this.matchCount,
      extractionCount: this.extractionCount,
      evolutionCount: this.evolutionCount,
    };
  }

  toJSON() {
    const pats = [];
    for (const [, p] of this.patterns) {
      pats.push({
        ...p,
        embedding: Array.from(p.embedding),
      });
    }
    return { config: this.config, patterns: pats };
  }

  static fromJSON(json) {
    const pl = new PatternLearner(json.config);
    for (const p of json.patterns || []) {
      p.embedding = new Float32Array(p.embedding);
      pl.patterns.set(p.patternId, p);
      pl.hnsw.add(p.patternId, p.embedding);
    }
    return pl;
  }

  // ── Private Methods ───────────────────────────────────────

  _findSimilar(embedding, threshold) {
    const results = this.hnsw.search(embedding, 1, threshold);
    if (results.length === 0) return null;
    return this.patterns.get(results[0].id) || null;
  }

  _updatePattern(pattern, quality) {
    const lr = this.config.evolutionLearningRate;
    pattern.qualityHistory.push(quality);
    if (pattern.qualityHistory.length > 100) {
      pattern.qualityHistory = pattern.qualityHistory.slice(-100);
    }
    pattern.successRate = pattern.successRate * (1 - lr) + quality * lr;
    pattern.usageCount++;
    pattern.updatedAt = Date.now();
    if (quality >= 0.5) pattern.outcomes.wins++;
    else pattern.outcomes.losses++;
  }

  _computeConfidence(pattern, similarity) {
    const usageWeight = Math.min(pattern.usageCount / 10, 1);
    const qualityWeight = pattern.successRate;
    return similarity * 0.6 + usageWeight * 0.2 + qualityWeight * 0.2;
  }

  _prunePatterns() {
    const scored = Array.from(this.patterns.entries())
      .map(([id, p]) => ({
        id,
        score: p.successRate * Math.log(p.usageCount + 1),
      }))
      .sort((a, b) => a.score - b.score);

    const toRemove = scored.length - Math.floor(this.config.maxPatterns * 0.8);
    for (let i = 0; i < toRemove && i < scored.length; i++) {
      this.patterns.delete(scored[i].id);
      this.hnsw.remove(scored[i].id);
    }
  }
}

module.exports = { PatternLearner };
