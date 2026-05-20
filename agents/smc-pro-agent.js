// ============================================================
// SMCProAgent — Smart Money Concepts Pro Trader
//
// Follows the full SMC framework from:
//   https://dailypriceaction.com/blog/smc-trading-strategy/
//
// Step-by-step per trade:
//   1. 4H market structure → BULLISH or BEARISH bias
//   2. 1H CHoCH → confirms the directional shift is REAL
//   3. Fibonacci OTE → price must be in premium (short) or discount (long)
//   4. 1H/15m FVG or Order Block → area of interest / confluence
//   5. Pre-planned TP at next swing high/low or liquidity pool
//   6. 5m CHoCH → lower-timeframe execution confirmation (LH then BOS)
//   7. SL at invalidation level (above last swing high / below last swing low)
//   8. 3:1 RR minimum — no trade below this threshold
//
// Runs alongside the existing V4-SMC strategy as a parallel signal source.
// Higher score (60+) than V4 (score=5) so it gets priority in the pipeline.
// ============================================================

'use strict';

const { BaseAgent }  = require('./base-agent');
const { analyzeSMC } = require('../smc-engine');
const { log: bLog }  = require('../bot-logger');

const ACTIVE_SYMBOLS   = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT'];
const SCAN_INTERVAL_MS = 45_000;    // scan every 45 seconds
const COOLDOWN_MS      = 3 * 3600_000; // 3-hour per-direction cooldown per symbol

class SMCProAgent extends BaseAgent {
  constructor(options = {}) {
    super('SMCProAgent', options);

    this._scanTimer    = null;
    this._cooldowns    = new Map(); // 'BTCUSDT:SHORT' → lastTradeMs
    this._signalCount  = 0;
    this._lastScanAt   = 0;
    this._lastError    = null;
    this._lastSignals  = [];

    this._profile = {
      description: 'Institutional Smart Money Concepts trader — FVG, Order Blocks, CHoCH, OTE, 3:1 RR minimum.',
      role:        'SMC Pro Trader',
      icon:        'smc',
      skills: [
        { id: 'structure',  name: '4H Structure',      description: 'Reads 4H market bias — BULLISH or BEARISH',          enabled: true },
        { id: 'choch',      name: 'CHoCH Detection',   description: 'Confirms direction shift on 1H and 5m timeframes',   enabled: true },
        { id: 'fvg',        name: 'Fair Value Gaps',   description: 'Finds 1H/15m FVGs — areas of interest to enter',    enabled: true },
        { id: 'ob',         name: 'Order Blocks',      description: 'Detects institutional supply/demand zones',           enabled: true },
        { id: 'ote',        name: 'Fibonacci OTE',     description: 'Only enters 61.8–78.6% retracement sweet spot',      enabled: true },
        { id: 'rr',         name: '3:1 RR Gate',       description: 'Rejects any trade under 3:1 risk-to-reward',         enabled: true },
        { id: 'ltf_entry',  name: '5m Entry Filter',   description: 'Drops to 5m chart for CHoCH execution confirmation', enabled: true },
        { id: 'liq_pool',   name: 'Liquidity Targets', description: 'Pre-plans TP at equal highs/lows liquidity pools',   enabled: true },
      ],
      config: [
        { key: 'scanIntervalMs', label: 'Scan Interval (ms)', type: 'number', value: SCAN_INTERVAL_MS, min: 15000, max: 300000 },
        { key: 'cooldownHours',  label: 'Per-Direction Cooldown (h)', type: 'number', value: 3, min: 1, max: 24 },
      ],
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async init() {
    await super.init();
    this.addActivity('info', 'SMC Pro Agent initialised — scanning 4H+1H+15m+5m for institutional setups');
    bLog.scan('[SMC-PRO] Agent ready — FVG / OB / CHoCH / OTE / 3:1 RR active');
  }

  // ── Main execute — called by AgentCoordinator CEO loop ────

  async execute(context = {}) {
    const now = Date.now();

    // Throttle: respect scan interval
    if (now - this._lastScanAt < SCAN_INTERVAL_MS) {
      return { skipped: true, reason: 'throttled' };
    }
    this._lastScanAt = now;

    this.currentTask = { description: 'Scanning 4H+1H+15m+5m SMC structure...', startedAt: now };

    // Log session status so it is visible in every scan cycle
    const utcHour = new Date().getUTCHours();
    const utcMin  = new Date().getUTCMinutes();
    const sessions = [
      { name: 'Asian',    start:  1, end:  4 },
      { name: 'London',   start:  7, end: 10 },
      { name: 'NY-AM',    start: 12, end: 15 },
      { name: 'NY-Silver',start: 15, end: 16 },
      { name: 'NY-PM',    start: 18.5, end: 21 },
    ];
    const hFrac   = utcHour + utcMin / 60;
    const session = sessions.find(s => hFrac >= s.start && hFrac < s.end);
    const sessionLabel = session ? `🟢 ${session.name} KILLZONE` : `⚪ Off-session`;
    bLog.scan(`[SMC-PRO] ${sessionLabel} — UTC ${String(utcHour).padStart(2,'0')}:${String(utcMin).padStart(2,'0')} — scanning ${ACTIVE_SYMBOLS.join('/')}`);
    this.addActivity('info', `SMC scan ${sessionLabel} | ${ACTIVE_SYMBOLS.join('/')} [4H+1H+15m+5m]`);

    const signals = [];

    for (const symbol of ACTIVE_SYMBOLS) {
      try {
        const signal = await analyzeSMC(symbol, msg => bLog.scan(msg));
        if (!signal) continue;

        // Per-direction cooldown check
        const cooldownKey = `${symbol}:${signal.direction}`;
        const lastMs      = this._cooldowns.get(cooldownKey) || 0;
        if (now - lastMs < COOLDOWN_MS) {
          const waitMin = Math.ceil((COOLDOWN_MS - (now - lastMs)) / 60_000);
          bLog.scan(`[SMC-PRO] ${symbol} ${signal.direction} on cooldown — ${waitMin}m remaining`);
          this.addActivity('skip', `${symbol} ${signal.direction} cooldown — ${waitMin}m`);
          continue;
        }

        signals.push(signal);
        this._cooldowns.set(cooldownKey, now);
        this._signalCount++;

        const msg = `${symbol} ${signal.direction} score=${signal.score} RR=${signal.rr} [${signal.smcContext?.fvg ? 'FVG' : ''}${signal.smcContext?.ob ? '+OB' : ''} CHoCH+OTE]`;
        this.addActivity('success', msg);
        bLog.trade(`[SMC-PRO] SIGNAL: ${msg}`);
      } catch (err) {
        this._lastError = err.message;
        this.addActivity('error', `${symbol} scan failed: ${err.message}`);
        bLog.error(`[SMC-PRO] ${symbol} error: ${err.message}`);
      }
    }

    this._lastSignals = signals;
    this.currentTask  = { description: `Standing by — ${this._signalCount} signals total`, startedAt: Date.now() };

    if (!signals.length) {
      this.addActivity('info', 'No SMC setups found this cycle — waiting for confluence');
      return { ok: true, signals: 0 };
    }

    // ── Route signals through coordinator's trade pipeline ────
    // RiskAgent filters, then TraderAgent executes directly via execute().
    // NOTE: traderAgent.receive() puts messages in an inbox that execute()
    // never reads — must call execute({ signals }) directly instead.
    if (context.coordinator) {
      try {
        const riskAgent   = context.coordinator.riskAgent;
        const traderAgent = context.coordinator.traderAgent;

        let approved = signals;
        if (riskAgent && !riskAgent.paused) {
          const riskResult = await riskAgent.run({ signals, openPositions: [] });
          approved = riskResult?.approved || signals; // fall back to all if risk unavailable
          bLog.scan(`[SMC-PRO] RiskAgent: ${approved.length}/${signals.length} approved`);
        }

        if (approved.length && traderAgent && !traderAgent.paused) {
          this.addActivity('trade', `Routing ${approved.length} SMC signal(s) → TraderAgent`);
          bLog.trade(`[SMC-PRO] → TraderAgent.execute ${approved.length} signal(s): ${approved.map(s => `${s.symbol} ${s.direction} score=${s.score}`).join(', ')}`);
          // Execute directly — traderAgent.receive() goes to an unread inbox
          await traderAgent.execute({ signals: approved, mode: 'signals' });
          this.addActivity('success', `TraderAgent executed ${approved.length} SMC signal(s)`);
        }
      } catch (err) {
        this.addActivity('error', `Signal routing failed: ${err.message}`);
        bLog.error(`[SMC-PRO] Routing error: ${err.message}`);
      }
    }

    return { ok: true, signals: signals.length, results: signals };
  }

  // ── Health / context ───────────────────────────────────────

  async _getAIContext() {
    return {
      lastScanAt:   new Date(this._lastScanAt).toISOString(),
      signalCount:  this._signalCount,
      lastSignals:  this._lastSignals.map(s => ({
        symbol:    s.symbol,
        direction: s.direction,
        score:     s.score,
        rr:        s.rr,
        setup:     s.setupName,
      })),
      lastError:    this._lastError,
      cooldowns:    Object.fromEntries(this._cooldowns),
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      lastScanAt:   this._lastScanAt,
      signalCount:  this._signalCount,
      lastSignals:  this._lastSignals.map(s => ({ symbol: s.symbol, direction: s.direction, score: s.score, rr: s.rr })),
      lastError:    this._lastError,
    };
  }
}

module.exports = { SMCProAgent };
