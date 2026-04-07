// ============================================================
// TraderAgent — Trade execution & position management
//
// Phase 2: Decoupled from cycle.js — receives signals from
// ChartAgent and executes trades independently.
//
// Responsibilities:
//   - Execute trades from ChartAgent signals (all users + owner)
//   - Monitor open positions (trailing SL, TP tiers)
//   - Sync trade status with exchanges
//   - Check USDT top-ups
//   - Record results to AI learner
// ============================================================

const { BaseAgent } = require('./base-agent');
const {
  executeForAllUsers,
  openTrade,
  checkTrailingStop,
  syncTradeStatus,
  checkUsdtTopups,
  getClient,
  isTokenBanned,
  getDailyCapital,
  notify,
  CONFIG,
  tradeState,
} = require('../cycle');
const { log: bLog } = require('../bot-logger');
const aiLearner = require('../ai-learner');

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

class TraderAgent extends BaseAgent {
  constructor(options = {}) {
    super('TraderAgent', options);
    this.lastTradeResult = null;
    this.tradeHistory = [];
    this.maxHistory = 100;
    this.cycleCount = 0;
    this.openPositionCount = 0;
    this.lastSyncAt = null;
    this.tradesExecuted = 0;
    this.tradesSkipped = 0;
  }

  /**
   * Execute a trading cycle.
   *
   * Phase 2 modes:
   *   - 'full': Legacy — calls cycle.run() (fallback)
   *   - 'signals': Receives signals from ChartAgent, executes trades
   *   - 'manage': Only manage positions (trailing SL, sync, topups)
   */
  async execute(context = {}) {
    const { signals = [], mode = 'signals' } = context;
    this.cycleCount++;

    if (mode === 'full') {
      // Fallback: delegate to cycle.run()
      this.currentTask = { description: 'Full cycle (legacy)', startedAt: Date.now() };
      const { run: runCycle } = require('../cycle');
      await runCycle();
      this.addActivity('success', `Legacy cycle #${this.cycleCount} complete`);
      const result = { cycleNumber: this.cycleCount, mode: 'full', ts: Date.now() };
      this._recordResult(result);
      return result;
    }

    // ── Phase 2: Decoupled pipeline ──

    // Step 1: Sync trade status & check top-ups
    this.currentTask = { description: 'Syncing trades with exchanges', startedAt: Date.now() };
    this.addActivity('info', 'Syncing trade status...');
    await syncTradeStatus();
    await checkUsdtTopups();
    this.lastSyncAt = Date.now();

    // Step 2: Execute signals (if any)
    let executed = false;
    let executionResult = null;

    if (signals.length > 0) {
      this.currentTask = { description: `Evaluating ${signals.length} signals`, startedAt: Date.now() };
      this.addActivity('info', `Received ${signals.length} signal(s) from ChartAgent`);

      for (const pick of signals) {
        this.logTrade(`Signal: ${pick.symbol} ${pick.direction} score=${pick.score} setup=${pick.setupName}`);

        // Check global token ban
        if (await isTokenBanned(pick.symbol || pick.sym)) {
          this.logTrade(`${pick.symbol} globally banned — skipping`);
          this.tradesSkipped++;
          this.addActivity('skip', `${pick.symbol} banned — skipped`);
          continue;
        }

        // Execute for all registered users
        this.currentTask = { description: `Trading ${pick.symbol} ${pick.direction}`, startedAt: Date.now() };
        this.addActivity('trade', `Executing ${pick.symbol} ${pick.direction} for users...`);
        const result = await executeForAllUsers(pick);

        if (result === 'ALL_TOO_EXPENSIVE') {
          this.logTrade(`${pick.symbol} too expensive for all users — trying next`);
          this.tradesSkipped++;
          this.addActivity('skip', `${pick.symbol} too expensive — next signal`);
          continue;
        }

        executed = true;
        executionResult = result;
        this.tradesExecuted++;
        this.addActivity('success', `${pick.symbol} ${pick.direction} executed for users`);
        break; // One trade per cycle
      }

      // Step 3: Owner account trade (first signal)
      const pick = signals[0];
      const hasOwnerKeys = !!(API_KEY && API_SECRET);

      if (hasOwnerKeys) {
        this.currentTask = { description: 'Owner account check', startedAt: Date.now() };
        try {
          const client = getClient();
          const account = await client.getAccountInformation({ omitZeroBalances: false });
          const rawWallet = parseFloat(account.totalWalletBalance);
          const avail = parseFloat(account.availableBalance);
          const wallet = getDailyCapital('owner-binance', rawWallet);

          // Manage trailing stops
          await checkTrailingStop(client);

          const openPos = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);
          this.openPositionCount = openPos.length;

          if (avail >= CONFIG.MIN_BALANCE) {
            const alreadyInSymbol = openPos.find(p => p.symbol === pick.symbol);
            if (alreadyInSymbol) {
              this.logTrade(`Owner already in ${pick.symbol} — skipping`);
            } else {
              const result = await openTrade(client, pick, wallet);
              if (result && result !== 'TOO_EXPENSIVE') {
                this.tradesExecuted++;
                this.addActivity('success', `Owner: ${result.sym} ${result.direction} x${result.leverage}`);
                const dirEmoji = result.direction !== 'SHORT' ? '🟢' : '🔴';
                await notify(
                  `*AI Trade — ${this._ts()}*\n` +
                  `*${result.sym}* ${dirEmoji} *${result.direction} x${result.leverage}*\n` +
                  `Setup: *${result.setup}*\n` +
                  `Entry: \`$${this._fmtPrice(result.entry)}\`\n` +
                  `TP: \`$${this._fmtPrice(result.tp1)}\`\n` +
                  `SL: \`$${this._fmtPrice(result.sl)}\`\n` +
                  `Qty: \`${result.qty}\` | Wallet: *$${avail.toFixed(2)}*\n` +
                  `AI Score: *${pick.score}*`
                );
              }
            }
          } else {
            this.logTrade(`Owner balance too low: $${avail.toFixed(2)}`);
          }
        } catch (err) {
          this.logError(`Owner trade error: ${err.message}`);
        }
      }
    } else {
      // No signals — still manage existing positions
      this.currentTask = { description: 'Managing positions (no signals)', startedAt: Date.now() };
      this.addActivity('info', 'No signals — managing existing positions');

      const hasOwnerKeys = !!(API_KEY && API_SECRET);
      if (hasOwnerKeys) {
        try {
          const client = getClient();
          await checkTrailingStop(client);
          const account = await client.getAccountInformation({ omitZeroBalances: false });
          this.openPositionCount = account.positions.filter(p => parseFloat(p.positionAmt) !== 0).length;
        } catch (err) {
          this.logError(`Position management error: ${err.message}`);
        }
      }
    }

    this.currentTask = null;

    const result = {
      cycleNumber: this.cycleCount,
      mode: 'signals',
      signalsReceived: signals.length,
      executed,
      executionResult,
      openPositions: this.openPositionCount,
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

  _fmtPrice(p) {
    if (!p || isNaN(p)) return 'N/A';
    if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(4);
    if (p >= 0.01) return p.toFixed(6);
    return p.toFixed(8);
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
      openPositions: this.openPositionCount,
      tradesExecuted: this.tradesExecuted,
      tradesSkipped: this.tradesSkipped,
      lastSyncAt: this.lastSyncAt,
      lastResult: this.lastTradeResult,
    };
  }
}

module.exports = { TraderAgent };
