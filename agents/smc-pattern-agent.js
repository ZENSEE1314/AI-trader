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
  scan1mPatterns,
  checkTradeState,
} = require('../smc-engine');

// ── Constants ────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 30_000;    // 30s — catches new closes on all TFs
const BARS_PATTERN     = 120;       // bars for pattern detection window
const BARS_4H_TREND    = 250;       // bars for 4H EMA200 (needs 200 minimum)
const BARS_1M          = 80;        // 1m bars for LTF confirmation (80 min coverage)
const BARS_3M          = 60;        // 3m bars for LTF fallback (3hr coverage)
const SCORE            = 72;        // signal score (higher than SMCProAgent's default)
const AGENT_NAME       = 'SMCPatternAgent';

// Symbols to scan — pulled from TRADING_CONFIG (XRP excluded there)
const SYMBOLS = Object.keys(TRADING_CONFIG);

// ── Interval conversion (minutes → Bybit format) ─────────────
// TRADING_CONFIG uses numeric minutes: '15', '30', '60', '240', '1', etc.
// Bybit uses the same minute values as strings, but '60' = '60' and '240' = '240'.
// 4H on Bybit is interval='240'.
const INTERVAL_4H = '240';
const INTERVAL_3M = '3';

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
      ltfUsed:  raw.ltfUsed,   // '1m' | '3m' | '15m(no-ltf)'
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
        { id: 'trend',   name: '4H Trend Filter', description: 'EMA20/50/200 — UP trend: LONG always + SHORT at premium (HH fade). DOWN trend: SHORT always + LONG at discount (LL bounce). NEUTRAL: zone-only.', enabled: true },
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

        // Parallel fetch: pattern TF + 4H trend + 1m LTF + 3m LTF fallback
        const [patBars, bars4h, bars1m, bars3m] = await Promise.all([
          fetchCandles(sym, cfg.iv,      BARS_PATTERN),
          fetchCandles(sym, INTERVAL_4H, BARS_4H_TREND),
          fetchCandles(sym, '1',         BARS_1M),
          fetchCandles(sym, INTERVAL_3M, BARS_3M),
        ]);

        if (!patBars || patBars.length < 70) continue;
        if (!bars4h  || bars4h.length  < 210) continue;

        // LTF cascade: prefer 1m, fall back to 3m, fall back to pattern-only
        const LTF_WINDOW = 40;
        const valid1m = bars1m?.length >= LTF_WINDOW ? bars1m : null;
        const valid3m = bars3m?.length >= LTF_WINDOW ? bars3m : null;

        const ltfTag = valid1m ? '1m' : valid3m ? '3m' : '15m-only';
        bLog.scan(`[SMC-PAT] ${sym}: LTF=${ltfTag} (1m=${bars1m?.length ?? 0} 3m=${bars3m?.length ?? 0})`);

        // ── Scan 1: HTF primary (15m/30m/1H) + LTF confirmation ───
        const raw = scanPatterns(sym, patBars, bars4h, this._cooldowns, valid1m, valid3m);

        // ── Scan 2: 1m PRIMARY — BMS/CHoCH/LH/HL on 1m directly ──
        // This catches what the TradingView SMC indicator shows:
        //   CHoCH-BULL = bullish reversal on 1m → LONG
        //   CHoCH-BEAR = bearish reversal on 1m → SHORT
        //   LH/HL/LL/HH on 1m = structure entries
        const raw1m = valid1m ? scan1mPatterns(sym, valid1m, bars4h, this._cooldowns) : null;

        // Process both signals — 1m primary first (highest precision), then HTF
        const raws = [raw1m, raw].filter(Boolean);
        if (!raws.length) continue;

        for (const r of raws) {
          const sig = formatSignal(r);
          signals.push(sig);
          this._signalCount++;

          const tfLabel = r.tf === '1m' ? `1m(${r.pattern})` : `${cfg.label}+${r.ltfUsed ?? '?'}`;
          const msg = `${sig.symbol} ${sig.direction} pattern=${r.pattern} TF=${tfLabel} ` +
                      `trend=${r.trend} entry=${r.price.toFixed(4)} sl=${r.sl.toFixed(4)} ` +
                      `tp1=${r.tp1.toFixed(4)} tp2=${r.tp2.toFixed(4)} RR=${sig.rr}`;

          this.addActivity('success', msg);
          bLog.trade(`[SMC-PAT] SIGNAL: ${msg}`);

          const tradeKey = `${sym}_${r.pattern}`;
          this._openTrades.set(tradeKey, {
            ...r,
            signalTs: now,
            tp1Hit:   false,
            closed:   false,
          });
        }
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

    // ── Deduplicate: one signal per symbol (1m always listed first → wins) ──
    // Both scanners (1m primary + HTF) can fire for the same symbol in
    // opposite directions. Keep only the first signal per symbol so TraderAgent
    // never sees conflicting directions for the same token in one batch.
    const seenSymbols = new Set();
    const uniqueSignals = signals.filter(s => {
      if (seenSymbols.has(s.symbol)) {
        bLog.scan(`[SMC-PAT] Dedup: dropped ${s.symbol} ${s.direction} (${s.smcContext?.tf}) — ${s.symbol} already queued`);
        return false;
      }
      seenSymbols.add(s.symbol);
      return true;
    });

    if (uniqueSignals.length < signals.length) {
      this.addActivity('info', `Deduped ${signals.length} → ${uniqueSignals.length} signal(s) (one per symbol)`);
    }

    // ── Route signals: RiskAgent → TraderAgent ─────────────
    if (context.coordinator) {
      try {
        const riskAgent   = context.coordinator.riskAgent;
        const traderAgent = context.coordinator.traderAgent;

        let approved = uniqueSignals;
        if (riskAgent && !riskAgent.paused) {
          const riskResult = await riskAgent.run({ signals: uniqueSignals, openPositions: [] });
          approved = riskResult?.approved || uniqueSignals;
          bLog.scan(`[SMC-PAT] RiskAgent: ${approved.length}/${uniqueSignals.length} approved`);
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
