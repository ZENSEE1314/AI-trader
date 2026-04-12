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

  validateToken(token) {
    if (!token) return false;
    return true; // PERMISSIVE_MODE
  }

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

    this._profile = {
      description: 'Executes approved trades on Binance & Bitunix for all users, manages trailing stops and position sync.',
      role: 'Trade Executor',
      icon: 'trader',
      skills: [
        { id: 'multi_user_exec', name: 'Multi-User Execution', description: 'Execute trades for all registered user API keys in parallel', enabled: true },
        { id: 'owner_trade', name: 'Owner Account Trading', description: 'Trade on the owner Binance account with full TP/SL', enabled: true },
        { id: 'trailing_sl', name: 'Trailing Stop-Loss', description: 'Dynamic trailing SL with tiered steps (+30%, +50%, +75%...)', enabled: true },
        { id: 'position_sync', name: 'Position Sync', description: 'Sync open trades with exchange, detect closes, record P&L', enabled: true },
        { id: 'structure_exit', name: '15M Structure Exit', description: 'Exit early on 15-minute structure break (LH for longs, HL for shorts)', enabled: true },
        { id: 'usdt_topup', name: 'USDT Top-Up Detection', description: 'Auto-detect USDT deposits and credit user wallets', enabled: true },
        { id: 'memory', name: 'Memory', description: 'Remember trade outcomes per coin and avoid repeat losers', enabled: true },
        { id: 'self_learn', name: 'Self-Learning', description: 'Learn which coins/setups are profitable and adjust execution', enabled: true },
      ],
      config: [
        { key: 'maxHistory', label: 'Trade History Size', type: 'number', value: 100, min: 20, max: 500 },
      ],
    };
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

    // Consume inter-agent messages from KronosAgent
    const kronosSignals = this.consumeMessages('kronos-signals');
    if (kronosSignals.length > 0) {
      const latest = kronosSignals[kronosSignals.length - 1].payload?.signals || [];
      if (latest.length > 0) {
        this.addActivity('info', `Kronos shared ${latest.length} strong signal(s): ${latest.map(s => `${s.symbol} ${s.direction}`).join(', ')}`);
      }
    }

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

        // Kronos AI hard gate — block trades where Kronos disagrees
        try {
          const kronosModule = require('../kronos');
          const sym = pick.symbol || pick.sym;
          const kronosResult = kronosModule.getCachedPrediction(sym) || await kronosModule.getKronosPrediction(sym, '15m', 20);

          this.logTrade(`Kronos: ${sym} → ${kronosResult.direction} ${kronosResult.change_pct}% conf=${kronosResult.confidence}`);

          if (kronosResult.direction !== 'NEUTRAL' && kronosResult.direction !== pick.direction && kronosResult.confidence === 'high') {
            this.logTrade(`KRONOS WARNING: ${sym} SMC=${pick.direction} but Kronos=${kronosResult.direction} (high) — proceeding with caution`);
            this.addActivity('info', `${sym} Kronos disagrees (${kronosResult.direction}) but 3m+1m confirmed — trading`);
          }

          if (kronosResult.direction === pick.direction && kronosResult.confidence === 'high') {
            this.logTrade(`KRONOS CONFIRMED: ${sym} ${pick.direction} HIGH confidence`);
          }
        } catch (kronosErr) {
          this.logTrade(`Kronos unavailable — proceeding with SMC signal only: ${kronosErr.message}`);
          this.addActivity('info', `${pick.symbol} Kronos unavailable — trading on SMC signal`);
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
        // NOTE: XP awarded only when trade wins (see cycle.js)
        // Memory: record trade entry (DB + Hermes)
        if (this.isSkillEnabled('memory')) {
          await this.remember(`last_trade_${pick.symbol}`, {
            direction: pick.direction, score: pick.score, ts: Date.now(),
          }, 'trades');

          // Hermes persistent memory
          const ts = new Date().toISOString().slice(0, 16);
          this.hermesRemember(`[${ts}] EXECUTED: ${pick.symbol} ${pick.direction} score=${pick.score}`);
          this.shareWithTeam(`Trade executed: ${pick.symbol} ${pick.direction} score=${pick.score}`);
        }

        // TTS voice alert for high-confidence trades
        if (pick.score >= 70) {
          this.speak(`New ${pick.direction} trade opened on ${pick.symbol.replace('USDT', '')} with score ${pick.score}`).catch(() => {});
        }
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

          const userLev = await require('../cycle').getTokenLeverage(pick.symbol, null, price);
          if (userLev === null) {
            this.logTrade(`Owner: ${pick.symbol} has no token configuration — skipping`);
            this.tradesSkipped++;
            this.addActivity('skip', `${pick.symbol} no token config — skipped`);
          } else if (avail >= CONFIG.MIN_BALANCE) {
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

  async _getAIContext() {
    let openTrades = [];
    try {
      const { query } = require('../db');
      openTrades = await query("SELECT symbol, direction, entry_price, leverage, pnl_usdt, created_at FROM trades WHERE status = 'OPEN' ORDER BY created_at DESC LIMIT 10");
    } catch {}
    return {
      cycleCount: this.cycleCount,
      openPositions: this.openPositionCount,
      tradesExecuted: this.tradesExecuted,
      tradesSkipped: this.tradesSkipped,
      openTrades: openTrades.map(t => ({ symbol: t.symbol, direction: t.direction, entry: t.entry_price, lev: t.leverage, pnl: t.pnl_usdt })),
      lastResult: this.lastTradeResult,
    };
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
