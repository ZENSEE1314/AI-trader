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
const BARS_3M          = 480;       // 3m bars — 480×3min = 24h session VWAP coverage
const SCORE            = 72;        // signal score (higher than SMCProAgent's default)
const AGENT_NAME       = 'SMCPatternAgent';

// ── 1m BMS (Break of Market Structure) detector ──────────────
// Checks whether the current 1m bar closed above the last confirmed pivot HIGH
// (bullish BMS) or below the last confirmed pivot LOW (bearish BMS).
// Uses TV indicator's asymmetric pivot: 1 left bar, 2 right bars.
// When bullish BMS is active → no SHORTs.  When bearish BMS → no LONGs.
function detect1mBMS(bars) {
  if (!bars || bars.length < 10) return null;
  const last = bars[bars.length - 1]; // current (most recent closed) bar

  // Pivot highs: bar[i].h must exceed 1 bar to the left and 2 bars to the right
  let lastHighPrice = null;
  for (let i = 1; i < bars.length - 2; i++) {
    if (bars[i].h > bars[i - 1].h && bars[i].h > bars[i + 1].h && bars[i].h > bars[i + 2].h) {
      lastHighPrice = bars[i].h;
    }
  }

  // Pivot lows: bar[i].l must be under 1 bar to the left and 2 bars to the right
  let lastLowPrice = null;
  for (let i = 1; i < bars.length - 2; i++) {
    if (bars[i].l < bars[i - 1].l && bars[i].l < bars[i + 1].l && bars[i].l < bars[i + 2].l) {
      lastLowPrice = bars[i].l;
    }
  }

  if (lastHighPrice !== null && last.c > lastHighPrice) return 'BULLISH'; // closed above swing high
  if (lastLowPrice  !== null && last.c < lastLowPrice)  return 'BEARISH'; // closed below swing low
  return null;
}

// ── 1m structure classifier — used to validate CHoCH signals ─
// CHoCH is only a valid REVERSAL when it breaks the PRIOR trend:
//   CHoCH-BEAR (→ SHORT) requires prior BULLISH structure (HH or HL present)
//   CHoCH-BULL (→ LONG)  requires prior BEARISH structure (LL or LH present)
// If structure is already trending the same way → continuation, not reversal → skip.
function classify1mStructure(bars1m) {
  if (!bars1m || bars1m.length < 12) return { bullishStructure: false, bearishStructure: false };

  const recent = bars1m.slice(-50); // last 50 bars ≈ 50 minutes of context
  const ph = [], pl = [];
  for (let i = 1; i < recent.length - 2; i++) {
    if (recent[i].h > recent[i-1].h && recent[i].h > recent[i+1].h && recent[i].h > recent[i+2].h)
      ph.push(recent[i].h);
    if (recent[i].l < recent[i-1].l && recent[i].l < recent[i+1].l && recent[i].l < recent[i+2].l)
      pl.push(recent[i].l);
  }

  // HH: last pivot high > second-last pivot high (rising highs)
  const hasHH = ph.length >= 2 && ph[ph.length - 1] > ph[ph.length - 2];
  // HL: last pivot low  > second-last pivot low  (rising lows)
  const hasHL = pl.length >= 2 && pl[pl.length - 1] > pl[pl.length - 2];
  // LH: last pivot high < second-last pivot high (falling highs)
  const hasLH = ph.length >= 2 && ph[ph.length - 1] < ph[ph.length - 2];
  // LL: last pivot low  < second-last pivot low  (falling lows)
  const hasLL = pl.length >= 2 && pl[pl.length - 1] < pl[pl.length - 2];

  return {
    hasHH, hasHL, hasLH, hasLL,
    bullishStructure: hasHH || hasHL, // at least one rising pivot = prior bullish structure
    bearishStructure: hasLL || hasLH, // at least one falling pivot = prior bearish structure
  };
}

// ── Session VWAP + ±1σ bands ─────────────────────────────────
// Computed from 3m bars (up to 24h of data).
// Rule: price ≤ lower band → NO LONG (in downtrend territory)
//       price ≥ upper band → NO SHORT (in uptrend territory)
// This matches TradingView "VWAP Session" with standard deviation bands.
function computeVWAP(bars) {
  if (!bars || bars.length < 10) return null;

  // Use bars from the current session (00:00 UTC today) for accurate VWAP.
  // Fall back to all supplied bars if the session filter leaves too few.
  const sessionStart = new Date();
  sessionStart.setUTCHours(0, 0, 0, 0);
  const sessionTs = sessionStart.getTime();
  const sessionBars = bars.filter(b => b.t >= sessionTs);
  const vwapBars = sessionBars.length >= 10 ? sessionBars : bars;

  let sumTPV = 0, sumV = 0;
  const tps = [];
  for (const b of vwapBars) {
    const tp = (b.h + b.l + b.c) / 3;
    const vol = b.v || 1;
    sumTPV += tp * vol;
    sumV   += vol;
    tps.push(tp);
  }
  if (sumV === 0 || tps.length === 0) return null;

  const vwap = sumTPV / sumV;
  // Volume-weighted variance — matches TradingView VWAP band calculation exactly.
  // Simple (unweighted) variance produces bands that are too narrow vs TradingView.
  const variance = vwapBars.reduce((s, b, i) => s + b.v * (tps[i] - vwap) ** 2, 0) / sumV;
  const stdDev = Math.sqrt(variance);

  return { vwap, upper: vwap + stdDev, lower: vwap - stdDev };
}

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

    // BTC market bias — set from BTC's last signal direction.
    // 'BULLISH' | 'BEARISH' | null (neutral)
    // When signal bias expires (15 min), falls back to _btcTrendFallback (4H trend).
    this._btcBias          = null;
    this._btcBiasAt        = 0;
    this._btcTrendFallback = null; // 'BULLISH'|'BEARISH' from BTC's last 4H classifyTrend

    // Cooldown map shared with scanPatterns: 'BTCUSDT_HL' → lastSignalTs
    this._cooldowns    = new Map();

    // 1m signal pending cache — HL/LH signals are held for one full 1m candle (≥60s)
    // before being promoted to live signals. This gives one candle of price confirmation:
    // HL detected → next candle closes bullish → fire LONG
    // LH detected → next candle closes bearish → fire SHORT
    // Map: symbol → { raw, queuedAt }
    this._pending1m    = new Map();
    this.PENDING_1M_MS = 60_000; // one 1m candle

    // BMS (Break of Market Structure) state per symbol.
    // Bullish BMS (close above last swing high) → block all SHORTs.
    // Bearish BMS (close below last swing low)  → block all LONGs.
    // Cleared when CHoCH in the opposite direction fires, or expires after 2h.
    // Map: symbol → { dir: 'BULLISH'|'BEARISH', detectedAt: timestamp }
    this._bmsState = new Map();

    // CHoCH wait state — when CHoCH fires, don't trade immediately.
    // Wait for the next 1m confirming pivot then fire:
    //   CHoCH-BULL → wait for HL or LL on 1m → LONG
    //   CHoCH-BEAR → wait for LH or HH on 1m → SHORT
    // Map: symbol → { dir: 'LONG'|'SHORT', detectedAt: timestamp }
    this._chochWait = new Map();

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

        // ── BMS state update ──────────────────────────────────────
        // Detect whether current 1m bar closed above/below last swing level.
        // Bullish BMS → block shorts.  Bearish BMS → block longs.
        // State persists until opposite CHoCH fires or expires after 2h.
        if (bars1m && bars1m.length >= 10) {
          const bms = detect1mBMS(bars1m);
          if (bms) {
            const prev = this._bmsState.get(sym);
            if (!prev || prev.dir !== bms) {
              this._bmsState.set(sym, { dir: bms, detectedAt: now });
              bLog.scan(`[SMC-PAT] BMS ${sym}: ${bms} — ${bms === 'BULLISH' ? 'no SHORT' : 'no LONG'}`);
              this.addActivity('info', `${sym} BMS ${bms} — ${bms === 'BULLISH' ? 'shorts blocked' : 'longs blocked'}`);
            }
          }
          // Expire BMS state after 2h (structure has had time to reset)
          const cur = this._bmsState.get(sym);
          if (cur && now - cur.detectedAt > 2 * 60 * 60_000) {
            this._bmsState.delete(sym);
          }
        }

        // ── Scan 1: HTF primary (15m/30m/1H) + LTF confirmation ───
        const raw = scanPatterns(sym, patBars, bars4h, this._cooldowns, valid1m, valid3m);

        // ── Scan 2: 1m PRIMARY — BMS/CHoCH/LH/HL on 1m directly ──
        // This catches what the TradingView SMC indicator shows:
        //   CHoCH-BULL / CHoCH-BEAR = reversal → fire immediately (body already confirms)
        //   HL / LH / LL / HH       = structure → 3-candle confirmation flow:
        //
        //   Candle 1: HL detected by scan1mPatterns → QUEUE, do not fire
        //   Candle 2: check current price vs stored HL level (scan cooldown blocks re-detect):
        //     · Price still at level (≤0.3% from HL) → CONFIRM, still don't fire
        //     · Price moved away (>0.3% from HL)     → fire immediately (candle 2 FIRE)
        //   Candle 3: always fire after candle 2 confirmed
        const rawDetected1m = valid1m ? scan1mPatterns(sym, valid1m, bars4h, this._cooldowns) : null;
        let raw1m = null;

        // Current 1m close — used for candle-2 price check (bypasses cooldown issue)
        const cur1mPrice = bars1m?.[bars1m.length - 1]?.c;

        // ── Step 1: Advance any existing pending signal ──────────────
        const pend = this._pending1m.get(sym);
        if (pend) {
          const age = now - pend.queuedAt;

          if (pend.state === 'confirmed') {
            // Candle 3: confirmed last scan → fire now
            raw1m = { ...pend.raw, price: cur1mPrice ?? pend.raw.price };
            this._pending1m.delete(sym);
            bLog.scan(`[SMC-PAT] 1m ${sym} ${pend.raw.pattern}(${pend.raw.dir}) candle-3 FIRE`);
            this.addActivity('trade', `${sym} ${pend.raw.pattern}(${pend.raw.dir}) — candle 3 FIRE`);

          } else if (pend.state === 'pending' && age >= this.PENDING_1M_MS) {
            // Candle 2: one full candle elapsed — check if price still at level
            // scan1mPatterns has a 10-min cooldown so we check price directly here.
            const level = pend.raw.level;
            const TOL   = 0.003; // 0.3% — within 1 SL of the pivot level
            const stillAtLevel = pend.raw.dir === 'LONG'
              ? cur1mPrice <= level * (1 + TOL)   // hasn't bounced far yet
              : cur1mPrice >= level * (1 - TOL);  // hasn't dropped far yet

            if (stillAtLevel) {
              // Price still near the HL/LH level → confirmed, fire on candle 3
              this._pending1m.set(sym, { ...pend, state: 'confirmed', confirmedAt: now });
              const pct = (((cur1mPrice / level) - 1) * 100).toFixed(2);
              bLog.scan(`[SMC-PAT] 1m ${sym} ${pend.raw.pattern}(${pend.raw.dir}) candle-2 CONFIRMED (price ${pct}% from level) — fire next`);
              this.addActivity('info', `${sym} ${pend.raw.pattern} candle 2 confirmed — firing next candle`);
            } else {
              // Price moved away from the level — HL/LH is now in the past, fire immediately
              raw1m = { ...pend.raw, price: cur1mPrice ?? pend.raw.price };
              this._pending1m.delete(sym);
              const pct = (((cur1mPrice / level) - 1) * 100).toFixed(2);
              bLog.scan(`[SMC-PAT] 1m ${sym} ${pend.raw.pattern}(${pend.raw.dir}) candle-2 FIRE (price moved ${pct}%)`);
              this.addActivity('trade', `${sym} ${pend.raw.pattern}(${pend.raw.dir}) — candle 2 FIRE (not at level, price moved)`);
            }

          } else if (age > 3 * 60_000) {
            // Stale — no follow-through in 3 min → expire
            this._pending1m.delete(sym);
            bLog.scan(`[SMC-PAT] 1m ${sym} ${pend.raw.pattern} pending expired (3 min no follow-through)`);
            this.addActivity('skip', `${sym} ${pend.raw.pattern} pending expired — no follow-through`);
          }
        }

        // ── Step 2: Queue new 1m detections (only if no pending firing this cycle) ──
        if (!raw1m && rawDetected1m) {
          const isStructureEntry = rawDetected1m.pattern === 'HL' || rawDetected1m.pattern === 'LH' ||
                                   rawDetected1m.pattern === 'LL' || rawDetected1m.pattern === 'HH';
          if (isStructureEntry && !this._pending1m.has(sym)) {
            // Candle 1: queue — never fire structure entries immediately
            this._pending1m.set(sym, { raw: rawDetected1m, queuedAt: now, state: 'pending' });
            bLog.scan(`[SMC-PAT] 1m ${sym} ${rawDetected1m.pattern}(${rawDetected1m.dir}) candle-1 queued`);
            this.addActivity('info', `${sym} ${rawDetected1m.pattern}(${rawDetected1m.dir}) — candle 1 queued`);
          } else if (!isStructureEntry) {
            // CHoCH: fire immediately — rejection candle body already confirms direction
            raw1m = rawDetected1m;
            this._pending1m.delete(sym);
          }
        }

        // Process both signals — 1m primary first (highest precision), then HTF
        const raws = [raw1m, raw].filter(Boolean);
        if (!raws.length) continue;

        // ── 1m pivot gate — applied to ALL signals (1m + HTF) ─────
        // ════════════════════════════════════════════════════════
        // HARD SIGNAL RULES (applied to ALL signals — 1m + HTF):
        //
        //   HL → LONG only    LL → LONG only
        //   LH → SHORT only   HH → SHORT only
        //
        //   CHoCH-BULL → set _chochWait=LONG, do NOT fire immediately
        //                fire when next HL or LL forms on 1m
        //   CHoCH-BEAR → set _chochWait=SHORT, do NOT fire immediately
        //                fire when next LH or HH forms on 1m
        //
        //   BMS BULLISH (close above last swing high) → no SHORTs
        //   BMS BEARISH (close below last swing low)  → no LONGs
        // ════════════════════════════════════════════════════════

        // ── Step A: Compute 1m pivot direction (1L/2R, matches TV indicator) ──
        // ANY low (HL or LL) as most recent pivot → LONG only (never short at a low)
        // ANY high (LH or HH) as most recent pivot → SHORT only (never long at a high)
        // Also capture the pivot BAR TIMESTAMP so Step C can detect when a NEW pivot forms.
        //
        // PULLBACK ZONE OVERRIDE:
        //   Problem: after HH confirms, it becomes the most recent pivot → gate = SHORT.
        //   But price then pulls BACK toward HL (which hasn't confirmed yet — needs 2 right bars).
        //   During those 2 minutes the gate still says SHORT and a queued SHORT fires AT the HL.
        //
        //   Fix: if price has already dropped ≥0.2% from the last confirmed HIGH in a bullish
        //   structure (HH + HL pattern), override gate → LONG. We're in the HL-forming zone.
        //   Mirror logic: if price has bounced ≥0.2% from last confirmed LOW in a bearish
        //   structure (LL + LH pattern), override gate → SHORT. LH-forming zone.
        let pivotGateDir = null; // 'LONG' | 'SHORT' | null
        let lastPivotTs  = 0;   // ms timestamp of the most recent pivot bar
        if (bars1m && bars1m.length >= 8) {
          const ph = [], pl = [];
          for (let i = 1; i < bars1m.length - 2; i++) {
            if (bars1m[i].h > bars1m[i-1].h && bars1m[i].h > bars1m[i+1].h && bars1m[i].h > bars1m[i+2].h)
              ph.push({ idx: i, ts: bars1m[i].t || 0, price: bars1m[i].h });
            if (bars1m[i].l < bars1m[i-1].l && bars1m[i].l < bars1m[i+1].l && bars1m[i].l < bars1m[i+2].l)
              pl.push({ idx: i, ts: bars1m[i].t || 0, price: bars1m[i].l });
          }
          const lastH = ph[ph.length - 1];
          const lastL = pl[pl.length - 1];

          // Pre-compute structure for the pullback-zone override below
          const gateStruct = classify1mStructure(bars1m);
          const PULLBACK_THRESHOLD = 0.002; // 0.2% — HL/LH-forming zone

          if (lastH && lastL) {
            if (lastL.idx > lastH.idx) {
              // Last confirmed pivot was a LOW (HL or LL) → normally LONG only
              // Mirror check: in bearish structure, if price bounced ≥0.2% above the LOW,
              // a LH is forming — override to SHORT to catch the turn from below.
              const bouncePct = cur1mPrice > 0
                ? (cur1mPrice - lastL.price) / lastL.price
                : 0;
              if (bouncePct >= PULLBACK_THRESHOLD && gateStruct.bearishStructure && !gateStruct.bullishStructure) {
                pivotGateDir = 'SHORT'; // LH-forming zone in pure bearish structure
                lastPivotTs  = lastL.ts;
                bLog.scan(`[SMC-PAT] Pivot gate ${sym}: price +${(bouncePct*100).toFixed(2)}% above LL → LH-forming SHORT zone`);
              } else {
                pivotGateDir = 'LONG';
                lastPivotTs  = lastL.ts;
              }
            } else {
              // Last confirmed pivot was a HIGH (HH or LH) → normally SHORT only
              // KEY FIX: in bullish structure, if price pulled back ≥0.2% from the HIGH,
              // an HL is forming — override to LONG to stop shorting at the dip.
              const pullbackPct = lastH.price > 0 && cur1mPrice > 0
                ? (lastH.price - cur1mPrice) / lastH.price
                : 0;
              if (pullbackPct >= PULLBACK_THRESHOLD && gateStruct.bullishStructure && !gateStruct.bearishStructure) {
                pivotGateDir = 'LONG'; // HL-forming zone in pure bullish structure — NO SHORTS
                lastPivotTs  = lastH.ts;
                bLog.scan(`[SMC-PAT] Pivot gate ${sym}: price -${(pullbackPct*100).toFixed(2)}% below HH → HL-forming zone, LONG only (no short at dip)`);
                this.addActivity('skip', `${sym} pivot gate: pulled back ${(pullbackPct*100).toFixed(2)}% from HH → HL zone, SHORT blocked`);
              } else {
                pivotGateDir = 'SHORT';
                lastPivotTs  = lastH.ts;
              }
            }
          }
        }

        // ── Step B: Separate CHoCH signals from structure signals ──
        // CHoCH does NOT fire as a trade. It sets _chochWait direction and waits
        // for the next confirming pivot (HL/LL for bull, LH/HH for bear).
        const nonChochRaws = [];
        for (const r of raws) {
          if (r.pattern === 'CHoCH-BULL' || r.pattern === 'CHoCH-BEAR') {
            const chochDir = r.pattern === 'CHoCH-BULL' ? 'LONG' : 'SHORT';

            // ── Structure validation: CHoCH must REVERSE a prior trend ──
            // CHoCH-BEAR (SHORT) only fires when prior structure had HH or HL (bullish).
            // CHoCH-BULL (LONG)  only fires when prior structure had LL or LH (bearish).
            // If structure is PURE bearish (only LL+LH, no HH/HL) → CHoCH-BEAR is just
            // continuation, not reversal — skip it entirely. Same logic for bull.
            const struct = classify1mStructure(bars1m);
            if (chochDir === 'SHORT' && !struct.bullishStructure) {
              bLog.scan(`[SMC-PAT] CHoCH-BEAR ${sym}: SKIPPED — no HH/HL in structure (pure LL+LH downtrend, not a reversal)`);
              this.addActivity('skip', `${sym} CHoCH-BEAR skipped — pure LL+LH structure, no bullish trend to break`);
              continue; // don't set _chochWait — this CHoCH is invalid
            }
            if (chochDir === 'LONG' && !struct.bearishStructure) {
              bLog.scan(`[SMC-PAT] CHoCH-BULL ${sym}: SKIPPED — no LL/LH in structure (pure HH+HL uptrend, not a reversal)`);
              this.addActivity('skip', `${sym} CHoCH-BULL skipped — pure HH+HL structure, no bearish trend to break`);
              continue; // don't set _chochWait — this CHoCH is invalid
            }

            const prev = this._chochWait.get(sym);
            if (!prev || prev.dir !== chochDir) {
              // pivotTsAtDetection: the timestamp of the CURRENT most-recent pivot.
              // Step C will only confirm when a pivot with a NEWER timestamp appears,
              // ensuring we waited for a genuine new LH/LL after the CHoCH candle.
              this._chochWait.set(sym, { dir: chochDir, detectedAt: now, pivotTsAtDetection: lastPivotTs });
              bLog.scan(`[SMC-PAT] CHoCH ${sym}: ${r.pattern} → waiting for ${chochDir === 'LONG' ? 'HL/LL' : 'LH/HH'} (pivotTs=${lastPivotTs}) struct=HH${struct.hasHH} HL${struct.hasHL} LL${struct.hasLL} LH${struct.hasLH}`);
              this.addActivity('info', `${sym} ${r.pattern} — waiting for next ${chochDir === 'LONG' ? 'HL or LL' : 'LH or HH'} to fire`);
            }
            // Also reset BMS on CHoCH
            const bms = this._bmsState.get(sym);
            if (bms && ((bms.dir === 'BULLISH' && chochDir === 'SHORT') || (bms.dir === 'BEARISH' && chochDir === 'LONG'))) {
              this._bmsState.delete(sym);
              bLog.scan(`[SMC-PAT] BMS ${sym}: cleared by ${r.pattern}`);
            }
          } else {
            nonChochRaws.push(r);
          }
        }

        // ── Step C: Resolve _chochWait using current pivot gate ──
        // CHoCH-BULL fires → wait for a NEW HL or LL (LONG pivot) to form on 1m
        // CHoCH-BEAR fires → wait for a NEW LH or HH (SHORT pivot) to form on 1m
        //
        // KEY: "new" means lastPivotTs > pivotTsAtDetection — the confirming pivot bar
        // must have a timestamp AFTER the CHoCH was detected. This prevents the CHoCH
        // from confirming itself using the pivot that already existed when it fired
        // (which always matches direction and caused immediate same-cycle confirmation).
        const chochWait = this._chochWait.get(sym);
        if (chochWait) {
          if (now - chochWait.detectedAt > 15 * 60_000) {
            // Expire after 15 min — no confirming pivot arrived
            this._chochWait.delete(sym);
            bLog.scan(`[SMC-PAT] CHoCH wait ${sym} expired — no confirming pivot in 15 min`);
          } else if (
            chochWait.dir === pivotGateDir &&
            lastPivotTs > 0 &&
            chochWait.pivotTsAtDetection > 0 &&
            lastPivotTs > chochWait.pivotTsAtDetection
          ) {
            // A genuinely NEW pivot formed in the correct direction AFTER the CHoCH.
            // Both timestamps must be > 0: if either is missing, keep waiting.
            this._chochWait.delete(sym);
            bLog.scan(`[SMC-PAT] CHoCH ${sym}: new ${pivotGateDir} pivot (ts=${lastPivotTs} > ${chochWait.pivotTsAtDetection}) — signal firing`);
            this.addActivity('info', `${sym} CHoCH confirmed by new 1m pivot — ${pivotGateDir} signal firing`);
          } else {
            // Still waiting — override pivotGateDir to only allow the choch direction
            // (prevents opposite signals while waiting for the confirming pivot)
            pivotGateDir = chochWait.dir;
          }
        }

        // ── Step D: Pivot gate — block all signals against the current pivot direction ──
        const pivotGated = pivotGateDir
          ? nonChochRaws.filter(r => {
              if (r.dir !== pivotGateDir) {
                const label = pivotGateDir === 'LONG' ? 'LOW(HL/LL)' : 'HIGH(LH/HH)';
                bLog.scan(`[SMC-PAT] Pivot gate: ${sym} ${r.pattern}(${r.dir}) blocked — 1m ${label} is current pivot`);
                this.addActivity('skip', `${sym} ${r.pattern}(${r.dir}) blocked — pivot is ${label}`);
                return false;
              }
              return true;
            })
          : nonChochRaws;

        if (!pivotGated.length) continue;

        // ── Step E: VWAP session filter ───────────────────────────
        // price ≤ lower band → NO LONG   price ≥ upper band → NO SHORT
        const vwap = computeVWAP(bars3m);
        const vwapFiltered = vwap
          ? pivotGated.filter(r => {
              const p = r.price;
              if (r.dir === 'LONG' && p <= vwap.lower) {
                bLog.scan(`[SMC-PAT] VWAP block: ${sym} LONG p=${p.toFixed(2)} ≤ lower=${vwap.lower.toFixed(2)}`);
                this.addActivity('skip', `${sym} LONG blocked — price ≤ VWAP lower`);
                return false;
              }
              if (r.dir === 'SHORT' && p >= vwap.upper) {
                bLog.scan(`[SMC-PAT] VWAP block: ${sym} SHORT p=${p.toFixed(2)} ≥ upper=${vwap.upper.toFixed(2)}`);
                this.addActivity('skip', `${sym} SHORT blocked — price ≥ VWAP upper`);
                return false;
              }
              return true;
            })
          : pivotGated;

        if (!vwapFiltered.length) continue;

        // ── Step F: BMS filter ────────────────────────────────────
        // Bullish BMS → no SHORTs.  Bearish BMS → no LONGs.
        const bmsEntry = this._bmsState.get(sym);
        const bmsFiltered = bmsEntry
          ? vwapFiltered.filter(r => {
              if (bmsEntry.dir === 'BULLISH' && r.dir === 'SHORT') {
                bLog.scan(`[SMC-PAT] BMS block: ${sym} SHORT blocked — bullish BMS active`);
                this.addActivity('skip', `${sym} SHORT blocked — BMS BULLISH`);
                return false;
              }
              if (bmsEntry.dir === 'BEARISH' && r.dir === 'LONG') {
                bLog.scan(`[SMC-PAT] BMS block: ${sym} LONG blocked — bearish BMS active`);
                this.addActivity('skip', `${sym} LONG blocked — BMS BEARISH`);
                return false;
              }
              return true;
            })
          : vwapFiltered;

        if (!bmsFiltered.length) continue;

        for (const r of bmsFiltered) {
          const sig = formatSignal(r);
          signals.push(sig);
          this._signalCount++;

          const vwapTag = vwap ? ` vwap=${vwap.vwap.toFixed(2)}[${vwap.lower.toFixed(2)}-${vwap.upper.toFixed(2)}]` : '';
          const tfLabel = r.tf === '1m' ? `1m(${r.pattern})` : `${cfg.label}+${r.ltfUsed ?? '?'}`;
          const msg = `${sig.symbol} ${sig.direction} pattern=${r.pattern} TF=${tfLabel} ` +
                      `trend=${r.trend} entry=${r.price.toFixed(4)} sl=${r.sl.toFixed(4)} ` +
                      `tp1=${r.tp1.toFixed(4)} tp2=${r.tp2.toFixed(4)} RR=${sig.rr}${vwapTag}`;

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

    // ── BTC bias — set from BTC's ACTUAL signal direction ─────
    // BTC's signal is the ground truth. If BTC fires SHORT → BEARISH → altcoins SHORT only.
    // If BTC fires LONG → BULLISH → altcoins LONG only.
    // If BTC has no signal this cycle, keep the last known bias (expires after 30 min).
    // Using BTC's signal direction (not a separate pivot calc) so bias always matches
    // the real trade the bot just fired on BTC — no contradictions possible.
    // BTC signal → strongest source of truth
    const btcSignalThisCycle = signals.find(s => s.symbol === 'BTCUSDT');
    if (btcSignalThisCycle) {
      this._btcBias    = btcSignalThisCycle.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
      this._btcBiasAt  = now;
      // Also cache the 4H trend from the BTC signal as a persistent fallback
      const btcTrend = btcSignalThisCycle.smcContext?.trend;
      if (btcTrend === 'UP')   this._btcTrendFallback = 'BULLISH';
      if (btcTrend === 'DOWN') this._btcTrendFallback = 'BEARISH';
      bLog.scan(`[SMC-PAT] BTC bias → ${this._btcBias} (signal) fallback4H=${this._btcTrendFallback}`);
      this.addActivity('info', `BTC bias: ${this._btcBias} | 4H trend: ${this._btcTrendFallback ?? 'unknown'}`);
    } else if (now - this._btcBiasAt > 15 * 60_000) {
      // Bias expired — fall back to 4H trend instead of blocking everything.
      // The 4H trend doesn't change in 15 min — it's safe as a directional guard.
      const prev = this._btcBias;
      this._btcBias   = this._btcTrendFallback ?? null; // null = truly neutral
      this._btcBiasAt = now; // reset so we don't log every cycle
      if (prev !== this._btcBias) {
        bLog.scan(`[SMC-PAT] BTC bias expired → fallback to 4H: ${this._btcBias ?? 'NEUTRAL'}`);
        this.addActivity('info', `BTC bias expired → 4H fallback: ${this._btcBias ?? 'NEUTRAL (both sides open)'}`);
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

    // ── BTC bias filter — altcoins must follow BTC 15m+1m direction ──
    // BTC is the market leader. Altcoins only trade in BTC's direction.
    // Bias comes from BTC's actual signal (not a separate calc) so they always agree.
    // Bias expires after 15 min (one 15M candle) — stale = altcoins wait for BTC.
    //
    // NEUTRAL (no recent BTC signal): altcoin signals are held — don't trade in the dark.
    // BULLISH (BTC fired LONG):  altcoins LONG only, SHORT blocked.
    // BEARISH (BTC fired SHORT): altcoins SHORT only, LONG blocked.
    const btcBiasAge   = now - this._btcBiasAt;
    const btcBiasValid = this._btcBias && btcBiasAge < 15 * 60_000;

    const btcFiltered = uniqueSignals.filter(s => {
      if (s.symbol === 'BTCUSDT') return true; // BTC always trades its own structure

      // No active BTC bias (truly neutral) → allow both directions (4H is flat / unknown)
      // Previously this blocked all altcoins — too aggressive. When we genuinely
      // don't know BTC direction, let each altcoin's own structure decide.
      if (!btcBiasValid) return true;

      // Direction conflict → block
      const blocked =
        (this._btcBias === 'BULLISH' && s.direction === 'SHORT') ||
        (this._btcBias === 'BEARISH' && s.direction === 'LONG');
      if (blocked) {
        bLog.scan(`[SMC-PAT] BTC-bias block: ${s.symbol} ${s.direction} vs BTC=${this._btcBias}`);
        this.addActivity('skip', `${s.symbol} ${s.direction} blocked — BTC is ${this._btcBias}`);
      }
      return !blocked;
    });

    if (btcFiltered.length < uniqueSignals.length) {
      this.addActivity('info',
        `BTC filter: ${uniqueSignals.length - btcFiltered.length} signal(s) blocked (BTC=${this._btcBias ?? 'NEUTRAL'})`
      );
    }

    // ── Route signals: RiskAgent → TraderAgent ─────────────
    if (context.coordinator) {
      try {
        const riskAgent   = context.coordinator.riskAgent;
        const traderAgent = context.coordinator.traderAgent;

        let approved = btcFiltered;
        if (riskAgent && !riskAgent.paused) {
          const riskResult = await riskAgent.run({ signals: btcFiltered, openPositions: [] });
          approved = riskResult?.approved || btcFiltered;
          bLog.scan(`[SMC-PAT] RiskAgent: ${approved.length}/${btcFiltered.length} approved`);
        }

        // Cross-agent dedup: skip any symbol:direction that SMCProAgent (or any
        // agent) already routed within the shared cooldown window.
        const lock   = context.coordinator._sharedSignalLock;
        const lockMs = context.coordinator.SHARED_SIGNAL_COOLDOWN_MS;
        const now    = Date.now();
        if (lock && lockMs) {
          approved = approved.filter(s => {
            const key     = `${s.symbol}:${s.direction}`;
            const lastAt  = lock.get(key) || 0;
            if (now - lastAt < lockMs) {
              const waitMin = Math.ceil((lockMs - (now - lastAt)) / 60_000);
              bLog.scan(`[SMC-PAT] Cross-agent dedup: ${s.symbol} ${s.direction} locked (${waitMin}m) — skipping`);
              this.addActivity('skip', `${s.symbol} ${s.direction} — SMCPro fired recently (${waitMin}m cooldown)`);
              return false;
            }
            lock.set(key, now); // claim the lock for this signal
            return true;
          });
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

  // ── BTC bias detector ─────────────────────────────────────
  // Reads the last 30 bars of BTC 1m and checks pivot low structure:
  //   Last pivot low > prev pivot low → HL → BULLISH
  //   Last pivot low < prev pivot low → LL → BEARISH
  // Falls back to pivot highs if lows are unclear.
  // Returns 'BULLISH' | 'BEARISH' | null (neutral / unclear)
  _deriveBtcBias(bars1m) {
    if (!bars1m || bars1m.length < 10) return null;
    const win = bars1m.slice(-30);

    // Find simple pivot lows (bar lower than both neighbours)
    const pivLows = [];
    for (let i = 1; i < win.length - 1; i++) {
      if (win[i].l < win[i - 1].l && win[i].l < win[i + 1].l) {
        pivLows.push({ price: win[i].l, idx: i });
      }
    }
    if (pivLows.length >= 2) {
      const last = pivLows[pivLows.length - 1];
      const prev = pivLows[pivLows.length - 2];
      if (last.price > prev.price) return 'BULLISH'; // HL → buyers stepping in higher
      if (last.price < prev.price) return 'BEARISH'; // LL → sellers pushing lower
    }

    // Fallback: pivot highs
    const pivHighs = [];
    for (let i = 1; i < win.length - 1; i++) {
      if (win[i].h > win[i - 1].h && win[i].h > win[i + 1].h) {
        pivHighs.push({ price: win[i].h, idx: i });
      }
    }
    if (pivHighs.length >= 2) {
      const last = pivHighs[pivHighs.length - 1];
      const prev = pivHighs[pivHighs.length - 2];
      if (last.price > prev.price) return 'BULLISH'; // HH
      if (last.price < prev.price) return 'BEARISH'; // LH
    }

    return null; // neutral — no clear bias
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
      btcBias:      this._btcBias ?? 'NEUTRAL',
      btcBiasAge:   this._btcBiasAt ? Math.round((Date.now() - this._btcBiasAt) / 1000) + 's ago' : 'never',
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
