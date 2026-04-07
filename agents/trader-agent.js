// ============================================================
// TraderAgent — Trade execution & position management
//
// Wraps cycle.js functions: openTrade, executeForAllUsers,
// checkTrailingStop, syncTradeStatus.
// Responsibilities:
//   - Execute trades from ChartAgent signals
//   - Monitor open positions (trailing SL, TP tiers)
//   - Sync trade status with exchanges
//   - Record results to AI learner
// ============================================================

const { BaseAgent } = require('./base-agent');
const { run: runCycle } = require('../cycle');

class TraderAgent extends BaseAgent {
  constructor(options = {}) {
    super('TraderAgent', options);
    this.lastTradeResult = null;
    this.tradeHistory = [];
    this.maxHistory = 100;
    this.cycleCount = 0;
  }

  /**
   * Execute a full trading cycle.
   *
   * The existing cycle.js `run()` function handles the complete flow:
   *   1. Sync trade status with exchanges
   *   2. Check USDT top-ups
   *   3. Scan for signals (via smc-engine)
   *   4. Execute trades for all users + owner
   *   5. Monitor trailing stops
   *
   * In the current phase, we delegate to cycle.run() to preserve
   * all existing behavior. Future phases will break this into
   * discrete sub-steps that the coordinator controls.
   *
   * @param {Object} context - { signals, scanResult } from ChartAgent (unused in Phase 1)
   */
  async execute(context = {}) {
    const { signals = [], mode = 'full' } = context;
    this.cycleCount++;

    if (mode === 'full') {
      // Phase 1: delegate to existing cycle.js run()
      this.logTrade(`Cycle #${this.cycleCount} — running full trading cycle...`);
      await runCycle();
      this.logTrade(`Cycle #${this.cycleCount} — complete`);

      const result = {
        cycleNumber: this.cycleCount,
        mode: 'full',
        signalsReceived: signals.length,
        ts: Date.now(),
      };
      this._recordResult(result);
      return result;
    }

    // Phase 2 stub: signal-driven execution
    // When we break cycle.js apart, this path will handle:
    //   - Receive signals from ChartAgent
    //   - Execute trades per signal
    //   - Manage positions independently
    this.logTrade(`Cycle #${this.cycleCount} — signal-driven mode (${signals.length} signals)`);

    const result = {
      cycleNumber: this.cycleCount,
      mode: 'signal-driven',
      signalsReceived: signals.length,
      ts: Date.now(),
    };
    this._recordResult(result);
    return result;
  }

  _recordResult(result) {
    this.lastTradeResult = result;
    this.tradeHistory.push(result);
    if (this.tradeHistory.length > this.maxHistory) this.tradeHistory.shift();
  }

  getLastResult() {
    return this.lastTradeResult;
  }

  getTradeHistory() {
    return this.tradeHistory;
  }

  getHealth() {
    return {
      ...super.getHealth(),
      cycleCount: this.cycleCount,
      lastResult: this.lastTradeResult,
    };
  }
}

module.exports = { TraderAgent };
