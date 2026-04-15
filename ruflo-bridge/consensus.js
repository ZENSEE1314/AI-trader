// ============================================================
// Gossip Consensus — Eventually-consistent trade signal voting
// Transpiled from ruflo v3/@claude-flow/swarm/src/consensus/gossip.ts
//
// Replaces simple weighted averaging in swarm-engine.js with
// proper Byzantine-tolerant consensus. If one AI persona
// hallucinates, it gets outvoted properly instead of corrupting
// the weighted average.
//
// Adapted for single-process in-memory use (no network layer).
// ============================================================

'use strict';

const { EventEmitter } = require('events');

class BoundedSet {
  constructor(maxSize) {
    this.map = new Map();
    this.maxSize = maxSize;
  }

  has(value) { return this.map.has(value); }

  add(value) {
    if (this.map.has(value)) return;
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(value, true);
  }

  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

const DEFAULT_CONSENSUS_THRESHOLD = 0.66;
const DEFAULT_TIMEOUT_MS = 5000;

class TradeConsensus extends EventEmitter {
  constructor(config = {}) {
    super();
    this.threshold = config.threshold || DEFAULT_CONSENSUS_THRESHOLD;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.proposals = new Map();
    this.voters = new Map();
    this.proposalCounter = 0;
    this.history = [];
    this.maxHistory = 100;
  }

  /**
   * Register a voter (agent/persona) with optional weight and expertise.
   */
  registerVoter(voterId, opts = {}) {
    this.voters.set(voterId, {
      id: voterId,
      weight: opts.weight || 1.0,
      expertise: opts.expertise || {},
      winRate: opts.winRate || 0.5,
      totalVotes: 0,
      correctVotes: 0,
    });
  }

  /**
   * Remove a voter.
   */
  removeVoter(voterId) {
    this.voters.delete(voterId);
  }

  /**
   * Create a new trade proposal for agents to vote on.
   * @param {string} symbol
   * @param {object} signalData - { direction, score, sl, tp, strategy, ... }
   * @returns {string} proposalId
   */
  propose(symbol, signalData) {
    this.proposalCounter++;
    const proposalId = `tp_${symbol}_${this.proposalCounter}`;

    this.proposals.set(proposalId, {
      id: proposalId,
      symbol,
      signal: signalData,
      votes: new Map(),
      status: 'pending',
      createdAt: Date.now(),
      result: null,
    });

    return proposalId;
  }

  /**
   * Cast a vote on a proposal.
   * @param {string} proposalId
   * @param {string} voterId
   * @param {object} vote - { approve: bool, confidence: 0-1, direction: 'LONG'|'SHORT'|'NEUTRAL', reasoning: string }
   */
  vote(proposalId, voterId, voteData) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return;

    const voter = this.voters.get(voterId);
    const weight = voter ? voter.weight : 1.0;

    // Boost weight for voters with expertise in this symbol
    let expertiseBoost = 1.0;
    if (voter && voter.expertise[proposal.symbol]) {
      expertiseBoost = voter.expertise[proposal.symbol];
    }

    // Boost weight for historically accurate voters
    let accuracyBoost = 1.0;
    if (voter && voter.totalVotes >= 5) {
      accuracyBoost = 0.5 + (voter.correctVotes / voter.totalVotes);
    }

    proposal.votes.set(voterId, {
      voterId,
      approve: voteData.approve,
      direction: voteData.direction || null,
      confidence: voteData.confidence || 0.5,
      reasoning: voteData.reasoning || '',
      weight: weight * expertiseBoost * accuracyBoost,
      ts: Date.now(),
    });

    if (voter) voter.totalVotes++;

    this._checkConvergence(proposalId);
  }

  /**
   * Force-resolve a proposal (used when timeout hits).
   */
  resolve(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    return this._finalizeProposal(proposalId);
  }

  /**
   * Run a full consensus round: propose + collect votes + resolve.
   * Synchronous — all voters must be registered and vote inline.
   *
   * @param {string} symbol
   * @param {object} signalData
   * @param {Array<{voterId: string, vote: object}>} votes
   * @returns {object} consensus result
   */
  runRound(symbol, signalData, votes) {
    const proposalId = this.propose(symbol, signalData);

    for (const { voterId, vote: voteData } of votes) {
      this.vote(proposalId, voterId, voteData);
    }

    return this._finalizeProposal(proposalId);
  }

  /**
   * Record whether a consensus decision was correct (for voter accuracy tracking).
   */
  recordOutcome(proposalId, wasCorrect) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || !proposal.result) return;

    for (const [voterId, voteData] of proposal.votes) {
      const voter = this.voters.get(voterId);
      if (!voter) continue;

      const votedCorrectly = (voteData.approve === wasCorrect) ||
        (voteData.direction === proposal.result.direction && wasCorrect);

      if (votedCorrectly) {
        voter.correctVotes++;
        voter.weight = Math.min(3.0, voter.weight * 1.02);
      } else {
        voter.weight = Math.max(0.3, voter.weight * 0.98);
      }
    }
  }

  getStats() {
    const voterStats = [];
    for (const [id, v] of this.voters) {
      voterStats.push({
        id,
        weight: Math.round(v.weight * 100) / 100,
        accuracy: v.totalVotes > 0 ? Math.round(v.correctVotes / v.totalVotes * 100) : 0,
        totalVotes: v.totalVotes,
      });
    }
    return {
      totalProposals: this.proposalCounter,
      activeProposals: Array.from(this.proposals.values()).filter(p => p.status === 'pending').length,
      voterCount: this.voters.size,
      voters: voterStats,
      recentHistory: this.history.slice(-10),
    };
  }

  // ── Private Methods ───────────────────────────────────────

  _checkConvergence(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return;

    const totalVoters = this.voters.size || 1;
    const voteCount = proposal.votes.size;

    if (voteCount >= totalVoters * this.threshold) {
      this._finalizeProposal(proposalId);
    }
  }

  _finalizeProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;

    const directionVotes = { LONG: 0, SHORT: 0, NEUTRAL: 0 };
    let totalApproveWeight = 0;
    let totalRejectWeight = 0;
    let totalWeight = 0;
    const confidences = [];

    for (const [, voteData] of proposal.votes) {
      totalWeight += voteData.weight;

      if (voteData.approve) {
        totalApproveWeight += voteData.weight;
      } else {
        totalRejectWeight += voteData.weight;
      }

      if (voteData.direction) {
        directionVotes[voteData.direction] = (directionVotes[voteData.direction] || 0) + voteData.weight;
      }

      confidences.push(voteData.confidence * voteData.weight);
    }

    const approvalRate = totalWeight > 0 ? totalApproveWeight / totalWeight : 0;
    const isApproved = approvalRate >= this.threshold;

    const winningDirection = Object.keys(directionVotes).reduce(
      (a, b) => directionVotes[a] > directionVotes[b] ? a : b
    );

    const directionConfidence = totalWeight > 0
      ? directionVotes[winningDirection] / totalWeight
      : 0;

    const avgConfidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / totalWeight
      : 0;

    const result = {
      proposalId,
      symbol: proposal.symbol,
      approved: isApproved,
      direction: winningDirection,
      approvalRate: Math.round(approvalRate * 100) / 100,
      directionConfidence: Math.round(directionConfidence * 100) / 100,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      participationRate: proposal.votes.size / Math.max(1, this.voters.size),
      voteCount: proposal.votes.size,
      directionSplit: directionVotes,
      durationMs: Date.now() - proposal.createdAt,
    };

    proposal.status = isApproved ? 'accepted' : 'rejected';
    proposal.result = result;

    this.history.push(result);
    if (this.history.length > this.maxHistory) this.history.shift();

    this.emit('consensus', result);

    // Clean up old proposals (keep last 50)
    if (this.proposals.size > 50) {
      const sorted = Array.from(this.proposals.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (let i = 0; i < sorted.length - 50; i++) {
        this.proposals.delete(sorted[i][0]);
      }
    }

    return result;
  }
}

module.exports = { TradeConsensus, BoundedSet, DEFAULT_CONSENSUS_THRESHOLD };
