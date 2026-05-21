// ============================================================
// SMCPatternAgent — Backtested Pattern Engine (v3)
//
// Uses the HL/LL/LH/HH pivot-retest patterns validated across
// 90 days + Feb–Apr 2025 downtrend on 9 tokens.
//
// Key characteristics vs SMCProAgent:
//  · 9 tokens from TRADING_CONFIG (XRP removed — 49% WR)
//  · Per-token optimal timeframe (15M / 1H / 30M)
//  · Per-token SL: SOL/DOT/ETH/ADA=0.20%, BTC/AVAX/LTC=0.25%, BNB/LINK=0.30%
//  · 4H EMA20/50/200 trend filter — asymmetric (SHORT allowed in all trends)
//  · 2H per-symbol×pattern cooldown (built into scanPatterns)
//  · TP1=0.5% (close 50%), TP2=1.0% (close 50%), lock at +0.25% after TP1
//  · Backtest WR: 51–59% per token, avg +$22K/90 days at $100/trade
// ============================================================

'use strict';

const { BaseAgent }     = require('./base-agent');
const { log: bLog }     = require('../bot-logger');
const {
  fetchCandles,
  TRADING_CONFIG,
  scanPatterns,
  checkTradeState,
} = require('../smc-engine');

// ── Constants ────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 30_000;    // 30s — catches new closes on all TFs
const BARS_PATTERN     = 120;       // bars for pattern detection window
const BARS_4H_TREND    = 250;       // bars for 4H EMA200 (needs 200 minimum)
const BARS_1M          = 80;        // 1m bars for LTF confirmation (80 min coverage)
const SCORE            = 72;        // signal score (higher than SMCProAgent's default)
const AGENT_NAME       = 'SMCPatternAgent';

// Symbols to scan — pulled from TRADING_CONFIG (XRP excluded there)
const SYMBOLS = Object.keys(TRADING_CONFIG);

// ── Interval conversion (minutes → Bybit format) ─────────────
// TRADING_CONFIG uses numeric minutes: '15', '30', '60', '240', '1', etc.
// Bybit uses the same minute values as strings, but '60' = '60' and '240' = '240'.
// 4H on Bybit is interval='240'.
const INTERVAL_4H = '240';

// ── Signal formatter ─────────────────────────────────────────
// Adapts scanPatterns output to the shape TraderAgent expects.
function formatSignal(raw) {
  const isLong = raw.dir === 'LONG';

  // R:R: distance to TP2 vs distance to SL
  const entry  = raw.price;
  const tp2    = raw.tp2;
  const sl     = raw.sl;
  const rr = isLong
    ? ((tp2 - entry) / (entry - sl)).toFixed(2)
    : ((entry - tp2) / (sl - entry)).toFixed(2);

  return {
    // ── Core fields TraderAgent reads ─────────────────────
    symbol:    raw.symbol,
    direction: raw.dir,      // 'LONG' | 'SHORT'
    side:      raw.side,     // 'BUY'  | 'SELL'
    score:     SCORE,
    rr:        parseFloat(rr),
    setupName: `${raw.pattern}(${raw.dir})@${raw.tf}`,

    // ── Price levels ───────────────────────────────────────
    entry:   entry,
    sl:      sl,
    tp:      tp2,   // primary TP target

    // ── Extended SMC-style context (for logging/UI) ───────
    smcContext: {
      pattern:  raw.pattern,
      tf:       raw.tf,
      trend:    raw.trend,
      fib50:    raw.fib50,
      level:    raw.level,
      tp1:      raw.tp1,
      tp2:      raw.tp2,
      lockAt:   raw.lockAt,
      slPct:    raw.slPct,
    },

    // ── Human-readable summary ────────────────────────────
    signal: raw.signal,
    ts:     raw.ts,
  };
}

// ── Agent ────────────────────────────────────────────────────

class SMCPatternAgent extends BaseAgent {
  constructor(options = {}) {
    super(AGENT_NAME, options);

    this._lastScanAt   = 0;
    this._signalCount  = 0;
    this._lastError    = null;
    this._lastSignals  = [];

    // Cooldown map shared with scanPatterns: 'BTCUSDT_HL' → lastSignalTs
    this._cooldowns    = new Map();

    // Active virtual trades: signal.symbol+'_'+signal.smcContext.pattern → { ...signal, bars4hCache }
    // Used to run checkTradeState per bar and log outcomes.
    this._openTrades   = new Map();

    this._profile = {
      description: `Backtested pivot-retest patterns (HL/LL/LH/HH) on 9 tokens. ` +
                   `EMA20/50/200 trend filter. Per-token SL (0.20–0.30%). ` +
                   `WR 51–59%, avg +$22K/90d at $100/trade.`,
      role:   'Pattern Engine Trader',
      icon:   'pattern',
      skills: [
        { id: 'hl',      name: 'HL (Higher Low)',  description: 'Long on uptrend retest — pivot low must be rising',        enabled: true },
        { id: 'll',      name: 'LL (Lower Low)',   description: 'Long on discount bounce — pivot low at new extreme',       enabled: true },
        { id: 'lh',      name: 'LH (Lower High)', description: 'Short on downtrend retest — pivot high must be falling',   enabled: true },
        { id: 'hh',      name: 'HH (Higher High)', description: 'Short fading premium — pivot high at new extreme',        enabled: true },
        { id: 'trend',   name: '4H Trend Filter', description: 'EMA20/50/200 — LONG only in UP trend or NEUTRAL-discount, SHORT only in DOWN trend or NEUTRAL-premium. Counter-trend trades blocked.', enabled: true },
        { id: 'cooldown',name: '2H Cooldown',     description: 'Skip repeated signals on same sym×pattern within 2 hours', enabled: true },
      ],
      config: [
        { key: 'scanIntervalMs', label: 'Scan Interval (ms)', type: 'number', value: SCAN_INTERVAL_MS, min: 10000, max: 300000 },
      ],
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async init() {
    await super.init();
    this.addActivity('info',
      `SMC Pattern Agent ready — ${SYMBOLS.length} tokens | HL/LL/LH/HH | 4H trend filter`
    );
    bLog.scan(`[SMC-PAT] Ready — tokens: ${SYMBOLS.join('/')}`);
    bLog.scan(`[SMC-PAT] Per-token TFs: ${SYMBOLS.map(s => `${TRADING_CONFIG[s].name}=${TRADING_CONFIG[s].label}`).join(', ')}`);
  }

  // ── Main execute — called by AgentCoordinator CEO loop ─────

  async execute(context = {}) {
    const now = Date.now();

    if (now - this._lastScanAt < SCAN_INTERVAL_MS) {
      return { skipped: true, reason: 'throttled' };
    }
    this._lastScanAt = now;

    this.currentTask = {
      description: `Scanning ${SYMBOLS.length} tokens for HL/LL/LH/HH patterns...`,
      startedAt: now,
    };

    const signals = [];

    // ── Fetch bars + scan each symbol ──────────────────────
    for (const sym of SYMBOLS) {
      try {
        const cfg = TRADING_CONFIG[sym];

        // Parallel fetch: pattern TF bars + 4H trend bars + 1m LTF confirmation
        const [patBars, bars4h, bars1m] = await Promise.all([
          fetchCandles(sym, cfg.iv,    BARS_PATTERN),
          fetchCandles(sym, INTERVAL_4H, BARS_4H_TREND),
          fetchCandles(sym, '1',       BARS_1M),
        ]);

        if (!patBars || patBars.length < 70) continue;
        if (!bars4h  || bars4h.length  < 210) continue;
        // bars1m requires >= BARS_1M (40) bars to run LTF confirmation — otherwise block
        const valid1m = bars1m?.length >= BARS_1M ? bars1m : null;
        if (!valid1m) bLog.scan(`[SMC-PAT] ${sym}: 1m bars thin (${bars1m?.length ?? 0}) — LTF confirmation blocked`);

        // Run pattern scanner (handles cooldown + trend filter + 1m confirmation internally)
        const raw = scanPatterns(sym, patBars, bars4h, this._cooldowns, valid1m);
        if (!raw) continue;

        const sig = formatSignal(raw);
        signals.push(sig);
        this._signalCount++;

        const msg = `${sig.symbol} ${sig.direction} pattern=${raw.pattern} TF=${cfg.label} ` +
                    `trend=${raw.trend} entry=${raw.price.toFixed(4)} sl=${raw.sl.toFixed(4)} ` +
                    `tp1=${raw.tp1.toFixed(4)} tp2=${raw.tp2.toFixed(4)} RR=${sig.rr}`;

        this.addActivity('success', msg);
        bLog.trade(`[SMC-PAT] SIGNAL: ${msg}`);

        // Track the open trade for outcome logging
        const tradeKey = `${sym}_${raw.pattern}`;
        this._openTrades.set(tradeKey, {
          ...raw,
          signalTs: now,
          tp1Hit:   false,
          closed:   false,
        });
      } catch (err) {
        this._lastError = err.message;
        this.addActivity('error', `${sym} scan failed: ${err.message}`);
        bLog.error(`[SMC-PAT] ${sym} error: ${err.message}`);
      }
    }

    // ── Update open trade states (outcome logging only) ────
    // Real position management is in TraderAgent + trail-watchdog.
    // This loop tracks virtual outcomes for the activity feed.
    await this._tickOpenTrades();

    this._lastSignals = signals;
    this.currentTask  = {
      description: `Standing by — ${this._signalCount} signals fired total`,
      startedAt: Date.now(),
    };

    if (!signals.length) {
      this.addActivity('info', 'No pattern setups this cycle — waiting for pivot retest');
      return { ok: true, signals: 0 };
    }

    // ── Route signals: RiskAgent → TraderAgent ─────────────
    if (context.coordinator) {
      try {
        const riskAgent   = context.coordinator.riskAgent;
        const traderAgent = context.coordinator.traderAgent;

        let approved = signals;
        if (riskAgent && !riskAgent.paused) {
          const riskResult = await riskAgent.run({ signals, openPositions: [] });
          approved = riskResult?.approved || signals;
          bLog.scan(`[SMC-PAT] RiskAgent: ${approved.length}/${signals.length} approved`);
        }

        if (approved.length && traderAgent && !traderAgent.paused) {
          this.addActivity('trade', `Routing ${approved.length} pattern signal(s) → TraderAgent`);
          bLog.trade(`[SMC-PAT] → TraderAgent.execute ${approved.length} signal(s): ` +
            approved.map(s => `${s.symbol} ${s.direction} score=${s.score}`).join(', '));
          await traderAgent.execute({ signals: approved, mode: 'signals' });
          this.addActivity('success', `TraderAgent executed ${approved.length} pattern signal(s)`);
        }
      } catch (err) {
        this.addActivity('error', `Signal routing failed: ${err.message}`);
        bLog.error(`[SMC-PAT] Routing error: ${err.message}`);
      }
    }

    return { ok: true, signals: signals.length, results: signals };
  }

  // ── Open trade state tracker ───────────────────────────────
  // Fetches the latest bar for each open virtual trade and
  // calls checkTradeState — logs FULL_WIN / LOCK_WIN / LOSS.
  async _tickOpenTrades() {
    if (!this._openTrades.size) return;

    for (const [key, trade] of this._openTrades.entries()) {
      if (trade.closed) { this._openTrades.delete(key); continue; }

      // Timeout: close virtual trade after 24H regardless
      if (Date.now() - trade.signalTs > 24 * 3_600_000) {
        this._openTrades.delete(key);
        this.addActivity('info', `${trade.symbol} ${trade.pattern} virtual trade timed out (24H)`);
        continue;
      }

      try {
        const cfg  = TRADING_CONFIG[trade.symbol];
        const bars = await fetchCandles(trade.symbol, cfg.iv, 3);
        if (!bars || !bars.length) continue;

        const latestBar = bars[bars.length - 1];
        const updated   = checkTradeState(trade, latestBar);

        if (updated.closed) {
          this._openTrades.delete(key);
          const pnlSign = updated.exitReason === 'LOSS' ? '🔴' : '🟢';
          const msg = `${pnlSign} ${trade.symbol} ${trade.pattern} → ${updated.exitReason} ` +
                      `exit=${updated.exitPrice?.toFixed(4)}`;
          this.addActivity(updated.exitReason === 'LOSS' ? 'warning' : 'success', msg);
          bLog.trade(`[SMC-PAT] CLOSED: ${msg}`);
        } else {
          // Update TP1 flag if hit
          this._openTrades.set(key, updated);
        }
      } catch (err) {
        bLog.error(`[SMC-PAT] _tickOpenTrades ${key}: ${err.message}`);
      }
    }
  }

  // ── Health / context ───────────────────────────────────────

  async _getAIContext() {
    return {
      lastScanAt:   new Date(this._lastScanAt).toISOString(),
      signalCount:  this._signalCount,
      openTrades:   this._openTrades.size,
      lastSignals:  this._lastSignals.map(s => ({
        symbol:    s.symbol,
        direction: s.direction,
        pattern:   s.smcContext?.pattern,
        tf:        s.smcContext?.tf,
        trend:     s.smcContext?.trend,
        score:     s.score,
        rr:        s.rr,
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
      openTrades:   this._openTrades.size,
      lastSignals:  this._lastSignals.map(s => ({
        symbol:    s.symbol,
        direction: s.direction,
        pattern:   s.smcContext?.pattern,
        tf:        s.smcContext?.tf,
        trend:     s.smcContext?.trend,
        score:     s.score,
        rr:        s.rr,
      })),
      lastError:    this._lastError,
    };
  }
}

module.exports = { SMCPatternAgent };
