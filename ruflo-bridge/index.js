// ============================================================
// Ruflo Bridge — Integration layer for ruflo/claude-flow AI
// orchestration into the crypto trading bot.
//
// Extracts the most valuable ruflo components and adapts them
// for CJS Node.js use in a single-process trading bot:
//
//   1. HNSW-Lite  — Fast vector similarity search for patterns
//   2. Q-Learning — Reinforcement learning for agent decisions
//   3. Consensus  — Multi-agent trade signal voting
//   4. Pattern Learner — Market pattern extraction & evolution
//   5. Market State Encoder — Raw data → normalized vectors
// ============================================================

'use strict';

const { HnswLite, cosineSimilarity } = require('./hnsw-lite');
const { QLearning, TRADING_ACTIONS } = require('./q-learning');
const { TradeConsensus } = require('./consensus');
const { PatternLearner } = require('./pattern-learner');
const { encodeMarketState, extractIndicatorsFromKlines, DIMENSIONS } = require('./market-state');

module.exports = {
  HnswLite,
  QLearning,
  TradeConsensus,
  PatternLearner,
  encodeMarketState,
  extractIndicatorsFromKlines,
  cosineSimilarity,
  TRADING_ACTIONS,
  DIMENSIONS,
};
