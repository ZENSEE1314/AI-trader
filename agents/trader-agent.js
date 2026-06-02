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
  syncTradeStatus,
  checkUsdtTopups,
  isTokenBanned,
  getDailyCapital,
  notify,
  CONFIG,
  tradeState,
} = require('../cycle');
const { log: bLog } = require('../bot-logger');
const aiLearner = require('../ai-learner');

class TraderAgent extends BaseAgent {

  validateToken(token) {
    if (!token) return false;
    return true; // PERMISSIVE_MODE
  }

  // ── Post-close cooldown helpers ────────────────────────────────
  // Returns true if symbol is still in the 1-hour cooldown window.
  // Checks in-memory map first, then falls back to DB (survives restarts).
  async _isInCloseCooldown(symbol) {
    const sym = (symbol || '').toUpperCase();
    const now = Date.now();

    // 1. In-memory hit (fast path)
    const memTs = this._closedAt.get(sym);
    if (memTs && now - memTs < this.CLOSE_COOLDOWN_MS) return true;

    // 2. DB fallback — covers restarts and orphaned closes
    try {
      const db = require('../db');
      const rows = await db.query(
        `SELECT closed_at FROM trades
         WHERE symbol = $1
           AND status IN ('WIN','LOSS','TP','SL','CLOSED','GHOST','TIMEOUT')
           AND closed_at > NOW() - INTERVAL '1 hour'
         ORDER BY closed_at DESC LIMIT 1`,
        [sym]
      );
      if (rows.length) {
        const closeTs = new Date(rows[0].closed_at).getTime();
        this._closedAt.set(sym, closeTs); // warm the in-memory cache
        if (now - closeTs < this.CLOSE_COOLDOWN_MS) return true;
      }
    } catch (_) {
      // DB unavailable — rely on in-memory map only
    }

    return false;
  }

  // Call this when a trade closes so the in-memory cooldown is updated immediately.
  recordClose(symbol) {
    this._closedAt.set((symbol || '').toUpperCase(), Date.now());
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

    // ── Post-close cooldown ───────────────────────────────────────
    // When a trade closes (any reason), the same token is blocked for 1 hour.
    // Map: symbol (ETHUSDT) → closedAt timestamp (ms)
    // Persisted in-memory; also checked against DB on each signal so restarts are safe.
    this._closedAt = new Map(); // symbol → Date.now() when trade closed
    this.CLOSE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

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
        if (pick.marketDecision) {
          this.logTrade(`MarketDecision: ${pick.marketDecision.summary || 'approved'} | size=${(pick.sizeMod || 1).toFixed(2)}x ${pick.sizeReason || ''}`);
        }

        // Check global token ban
        if (await isTokenBanned(pick.symbol || pick.sym)) {
          this.logTrade(`${pick.symbol} globally banned — skipping`);
          this.tradesSkipped++;
          this.addActivity('skip', `${pick.symbol} banned — skipped`);
          continue;
        }

        // Block duplicate entries. Allow reversals (opposite direction → close first).
        let isReversalEntry = false;
        try {
          const db = require('../db');
          const existing = await db.query(
            `SELECT id, direction FROM trades WHERE symbol = $1 AND status = 'OPEN' LIMIT 1`,
            [(pick.symbol || '').toUpperCase()]
          );
          if (existing.length) {
            const openDir = existing[0].direction;
            if (openDir === pick.direction) {
              // Same direction — already in the trade
              this.logTrade(`${pick.symbol} already OPEN ${openDir} — skip same-direction signal`);
              this.tradesSkipped++;
              this.addActivity('skip', `${pick.symbol} already OPEN ${openDir}`);
              continue;
            }
            // Opposite direction: signal says market flipped — close existing, enter new
            this.logTrade(`${pick.symbol} REVERSAL: ${openDir} open → ${pick.direction} signal — closing first`);
            this.addActivity('trade', `${pick.symbol} reversal: closing ${openDir} → entering ${pick.direction}`);
            try {
              const { closePositionForAllUsers } = require('../cycle');
              await closePositionForAllUsers(pick.symbol, 'reversal_signal');
              // Give exchange 2s to settle the close before opening the new side
              await new Promise(r => setTimeout(r, 2000));
              isReversalEntry = true; // bypass post-close cooldown for this entry
            } catch (closeErr) {
              this.logTrade(`${pick.symbol} reversal close failed: ${closeErr.message} — skipping new entry`);
              this.tradesSkipped++;
              this.addActivity('error', `${pick.symbol} reversal close failed — skipping`);
              continue;
            }
          }
        } catch (dbCheckErr) {
          // DB unavailable — skip for safety. Cannot verify no open position exists.
          this.logTrade(`${pick.symbol} DB check failed (${dbCheckErr.message}) — skipping for safety`);
          this.tradesSkipped++;
          this.addActivity('skip', `${pick.symbol} DB unavailable — skip to avoid duplicate`);
          continue;
        }

        // Check post-close cooldown (1 hour per token after any close).
        // Reversal entries bypass this — we WANT to re-enter immediately on structure flip.
        if (!isReversalEntry && await this._isInCloseCooldown(pick.symbol)) {
          const sym = (pick.symbol || '').toUpperCase();
          const closedTs = this._closedAt.get(sym);
          const minsLeft = closedTs
            ? Math.ceil((this.CLOSE_COOLDOWN_MS - (Date.now() - closedTs)) / 60_000)
            : 60;
          this.logTrade(`${pick.symbol} in post-close cooldown — ${minsLeft}m remaining`);
          this.tradesSkipped++;
          this.addActivity('skip', `${pick.symbol} cooldown ${minsLeft}m — trade closed recently`);
          continue;
        }

        try {
          const liveGate = await aiLearner.shouldBlockLiveTrade({
            symbol: pick.symbol || pick.sym,
            direction: pick.direction,
            setup: pick.setupName || pick.setup || 'unknown',
          });
          if (liveGate.block) {
            this.logTrade(`LIVE-HISTORY BLOCKED: ${liveGate.reason}`);
            this.tradesSkipped++;
            this.addActivity('skip', `${pick.symbol} live history losing - skipped`);
            continue;
          }
        } catch (histErr) {
          this.logTrade(`Live-history gate error: ${histErr.message} - allowing signal`);
        }

        // Backtest gate DISABLED per user direction (PR #78 disabled it in
        // cycle.js but TraderAgent had its own copy that PR missed). The
        // gate was blocking every TokenAgent signal because no current
        // strategy has ≥50% historical WR. User trades on live structure
        // rules instead. Auto-activate (PR #77) still uses the gate's
        // 50% threshold to swap in better strategies as the optimizer
        // finds them.
        //
        // To re-enable, uncomment the block below.
        //
        // try {
        //   const backtestGate = require('../backtest-gate');
        //   const gateSym = pick.symbol || pick.sym;
        //   const gateStrategy = pick.setupName || pick.setup || 'ALL';
        //   const signalWr = pick.strategyWinRate || 0;
        //   const gatePasses = await backtestGate.passesGate(gateSym, gateStrategy, undefined, signalWr);
        //   if (!gatePasses) {
        //     this.logTrade(`BACKTEST GATE BLOCKED: ${gateSym} ${gateStrategy} — WR below ${backtestGate.MIN_WIN_RATE}%`);
        //     this.tradesSkipped++;
        //     this.addActivity('skip', `${gateSym} backtest WR too low — skipped`);
        //     continue;
        //   }
        //   this.logTrade(`BACKTEST GATE PASSED: ${gateSym} ${gateStrategy}`);
        // } catch (gateErr) {
        //   this.logTrade(`Backtest gate error: ${gateErr.message} — blocking for safety`);
        //   this.tradesSkipped++;
        //   continue;
        // }

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

      // Owner account handled via executeForAllUsers (DB keys with pause/enabled checks)
    } else {
      // No signals — still manage existing positions
      this.currentTask = { description: 'Managing positions (no signals)', startedAt: Date.now() };
      this.addActivity('info', 'No signals — managing existing positions');
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
