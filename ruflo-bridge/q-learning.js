// ============================================================
// Q-Learning — Tabular Reinforcement Learning for agent decisions
// Transpiled from ruflo v3/@claude-flow/neural/src/algorithms/q-learning.ts
//
// Each agent learns which actions (trade/skip/reduce_size/increase_size)
// are optimal in different market states. The survival HP system
// already tracks win/loss — Q-Learning formalizes this into actual
// policy learning with epsilon-greedy exploration.
//
// Performance: <1ms per update. ~160KB per agent Q-table.
// ============================================================

'use strict';

// Action space for trading agents
const TRADING_ACTIONS = ['trade', 'skip', 'reduce_size', 'increase_size'];
const NUM_ACTIONS = TRADING_ACTIONS.length;

const DEFAULT_CONFIG = {
  learningRate: 0.1,
  gamma: 0.99,
  explorationInitial: 1.0,
  explorationFinal: 0.01,
  explorationDecay: 5000,
  maxStates: 10000,
  useEligibilityTraces: false,
  traceDecay: 0.9,
};

class QLearning {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.qTable = new Map();
    this.epsilon = this.config.explorationInitial;
    this.stepCount = 0;
    this.numActions = config.numActions || NUM_ACTIONS;
    this.traces = new Map();
    this.updateCount = 0;
    this.avgTDError = 0;
    this.totalReward = 0;
  }

  /**
   * Update Q-values from a trajectory (sequence of state-action-reward steps).
   * @param {{ steps: Array<{stateBefore: Float32Array, action: string|number, reward: number, stateAfter: Float32Array}> }} trajectory
   */
  update(trajectory) {
    if (!trajectory.steps || trajectory.steps.length === 0) {
      return { tdError: 0 };
    }

    let totalTDError = 0;

    if (this.config.useEligibilityTraces) {
      this.traces.clear();
    }

    for (let i = 0; i < trajectory.steps.length; i++) {
      const step = trajectory.steps[i];
      const stateKey = this._hashState(step.stateBefore);
      const action = typeof step.action === 'number' ? step.action : this._hashAction(step.action);

      const qEntry = this._getOrCreateEntry(stateKey);
      const currentQ = qEntry.qValues[action];

      let targetQ;
      if (i === trajectory.steps.length - 1) {
        targetQ = step.reward;
      } else {
        const nextStateKey = this._hashState(step.stateAfter);
        const nextEntry = this._getOrCreateEntry(nextStateKey);
        const maxNextQ = Math.max(...nextEntry.qValues);
        targetQ = step.reward + this.config.gamma * maxNextQ;
      }

      const tdError = targetQ - currentQ;
      totalTDError += Math.abs(tdError);

      if (this.config.useEligibilityTraces) {
        this._updateTrace(stateKey, action);
        this._updateWithTraces(tdError);
      } else {
        qEntry.qValues[action] += this.config.learningRate * tdError;
        qEntry.visits++;
        qEntry.lastUpdate = Date.now();
      }

      this.totalReward += step.reward;
    }

    this.stepCount += trajectory.steps.length;
    this.epsilon = Math.max(
      this.config.explorationFinal,
      this.config.explorationInitial - this.stepCount / this.config.explorationDecay
    );

    if (this.qTable.size > this.config.maxStates) {
      this._pruneQTable();
    }

    this.updateCount++;
    this.avgTDError = totalTDError / trajectory.steps.length;

    return { tdError: this.avgTDError };
  }

  /**
   * Get recommended action index using epsilon-greedy policy.
   * @param {Float32Array} state
   * @param {boolean} explore - whether to use exploration
   * @returns {number} action index
   */
  getAction(state, explore = true) {
    if (explore && Math.random() < this.epsilon) {
      return Math.floor(Math.random() * this.numActions);
    }

    const stateKey = this._hashState(state);
    const entry = this.qTable.get(stateKey);

    if (!entry) {
      return Math.floor(Math.random() * this.numActions);
    }

    return this._argmax(entry.qValues);
  }

  /**
   * Get the action name from action index.
   */
  getActionName(actionIndex) {
    return TRADING_ACTIONS[actionIndex] || `action_${actionIndex}`;
  }

  /**
   * Get Q-values for a state.
   */
  getQValues(state) {
    const stateKey = this._hashState(state);
    const entry = this.qTable.get(stateKey);
    if (!entry) return new Float32Array(this.numActions);
    return new Float32Array(entry.qValues);
  }

  /**
   * Get confidence (max Q-value normalized) for the recommended action.
   */
  getConfidence(state) {
    const qValues = this.getQValues(state);
    const maxQ = Math.max(...qValues);
    const minQ = Math.min(...qValues);
    if (maxQ === minQ) return 0;
    return Math.min(1, Math.max(0, (maxQ - minQ) / (Math.abs(maxQ) + 0.001)));
  }

  getStats() {
    return {
      updateCount: this.updateCount,
      qTableSize: this.qTable.size,
      epsilon: Math.round(this.epsilon * 1000) / 1000,
      avgTDError: Math.round(this.avgTDError * 10000) / 10000,
      stepCount: this.stepCount,
      totalReward: Math.round(this.totalReward * 100) / 100,
    };
  }

  reset() {
    this.qTable.clear();
    this.traces.clear();
    this.epsilon = this.config.explorationInitial;
    this.stepCount = 0;
    this.updateCount = 0;
    this.avgTDError = 0;
    this.totalReward = 0;
  }

  toJSON() {
    const table = {};
    for (const [key, entry] of this.qTable) {
      table[key] = { q: Array.from(entry.qValues), v: entry.visits, t: entry.lastUpdate };
    }
    return {
      config: this.config,
      epsilon: this.epsilon,
      stepCount: this.stepCount,
      updateCount: this.updateCount,
      totalReward: this.totalReward,
      table,
    };
  }

  static fromJSON(json) {
    const ql = new QLearning(json.config);
    ql.epsilon = json.epsilon || ql.config.explorationInitial;
    ql.stepCount = json.stepCount || 0;
    ql.updateCount = json.updateCount || 0;
    ql.totalReward = json.totalReward || 0;
    for (const [key, entry] of Object.entries(json.table || {})) {
      ql.qTable.set(key, {
        qValues: new Float32Array(entry.q),
        visits: entry.v,
        lastUpdate: entry.t,
      });
    }
    return ql;
  }

  // ── Private Methods ───────────────────────────────────────

  _hashState(state) {
    const bins = 10;
    const parts = [];
    for (let i = 0; i < Math.min(8, state.length); i++) {
      const normalized = (state[i] + 1) / 2;
      const bin = Math.floor(Math.max(0, Math.min(bins - 1, normalized * bins)));
      parts.push(bin);
    }
    return parts.join(',');
  }

  _hashAction(action) {
    if (typeof action === 'number') return action % this.numActions;
    let hash = 0;
    for (let i = 0; i < action.length; i++) {
      hash = (hash * 31 + action.charCodeAt(i)) % this.numActions;
    }
    return hash;
  }

  _getOrCreateEntry(stateKey) {
    let entry = this.qTable.get(stateKey);
    if (!entry) {
      entry = { qValues: new Float32Array(this.numActions), visits: 0, lastUpdate: Date.now() };
      this.qTable.set(stateKey, entry);
    }
    return entry;
  }

  _updateTrace(stateKey, action) {
    for (const [key, trace] of this.traces) {
      for (let a = 0; a < this.numActions; a++) {
        trace[a] *= this.config.gamma * this.config.traceDecay;
      }
      const maxTrace = Math.max(...trace);
      if (maxTrace < 0.001) this.traces.delete(key);
    }
    let trace = this.traces.get(stateKey);
    if (!trace) {
      trace = new Float32Array(this.numActions);
      this.traces.set(stateKey, trace);
    }
    trace[action] = 1.0;
  }

  _updateWithTraces(tdError) {
    const lr = this.config.learningRate;
    for (const [stateKey, trace] of this.traces) {
      const entry = this.qTable.get(stateKey);
      if (entry) {
        for (let a = 0; a < this.numActions; a++) {
          entry.qValues[a] += lr * tdError * trace[a];
        }
        entry.visits++;
        entry.lastUpdate = Date.now();
      }
    }
  }

  _pruneQTable() {
    const entries = Array.from(this.qTable.entries())
      .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);
    const toRemove = entries.length - Math.floor(this.config.maxStates * 0.8);
    for (let i = 0; i < toRemove; i++) {
      this.qTable.delete(entries[i][0]);
    }
  }

  _argmax(values) {
    let maxIdx = 0, maxVal = values[0];
    for (let i = 1; i < values.length; i++) {
      if (values[i] > maxVal) { maxVal = values[i]; maxIdx = i; }
    }
    return maxIdx;
  }
}

module.exports = { QLearning, TRADING_ACTIONS, DEFAULT_CONFIG };
