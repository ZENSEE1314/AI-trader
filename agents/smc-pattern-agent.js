// ============================================================
// SMCPatternAgent — Nearest-Pivot Match Engine
//
// Signal rule: nearest 15min confirmed pivot + nearest 1min confirmed pivot
// must be the same type (both HL or both LH).
//   Both HL → LONG   |   Both LH → SHORT
//   LL / HH / mismatch → no trade
//
// Pivot detection: 1L/2R asymmetric (matches TradingView SMC Expo indicator).
// Fires immediately on match. SL at 1m pivot level ± per-token slPct.
//
// Tokens: 9 from TRADING_CONFIG (XRP removed)
// Per-token SL: SOL/DOT/ETH/ADA=0.20%, BTC/AVAX/LTC=0.25%, BNB/LINK=0.30%
// TP1=0.5% (close 50%), TP2=1.0% (close 50%)
// Filters: 4H EMA trend, 45-min cooldown, VWAP session bands, BMS
// ============================================================

'use strict';

const { BaseAgent }        = require('./base-agent');
const { log: bLog }        = require('../bot-logger');
const { query }            = require('../db');
const { getAIChartLearner } = require('./ai-chart-learner');
const {
  fetchCandles,
  TRADING_CONFIG,
  scanNearestPivotMatch,
  checkTradeState,
  calcRSI,
  calcADX,
  classifyTrend,
  calcEMASeries,
} = require('../smc-engine');
const { getTA } = require('@mathieuc/tradingview');

// ── TradingView TA confirmation ───────────────────────────────
// Fetches TV TA scores for 15m and 1h. Returns { bull, bear, neutral }
// bull  = TV says both 15m AND 1h are bullish (All score > 0)
// bear  = TV says both 15m AND 1h are bearish (All score < 0)
// neutral = mixed / unavailable
const TV_EXCHANGE = {
  BTCUSDT: 'BINANCE:BTCUSDT', ETHUSDT: 'BINANCE:ETHUSDT',
  SOLUSDT: 'BINANCE:SOLUSDT', BNBUSDT: 'BINANCE:BNBUSDT',
};
async function tvBias(sym) {
  try {
    const data = await getTA(TV_EXCHANGE[sym] || `BINANCE:${sym}`, '15');
    if (!data) return 'neutral';
    const s15 = data['15']?.All ?? 0;
    const s1h  = data['60']?.All ?? 0;
    if (s15 > 0 && s1h > 0) return 'bull';
    if (s15 < 0 && s1h < 0) return 'bear';
    return 'neutral';
  } catch (_) { return 'neutral'; }
}

// ── Constants ────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 30_000;    // 30s scan cadence
const BARS_15M         = 200;       // 15min bars — 200 bars = 50h of history (captures HH/LL context)
const BARS_4H_TREND    = 250;       // 4H bars for EMA200 trend
const BARS_1M          = 180;       // 1m bars — 180 min covers the 2h WINDOW_MS confirmation window
const BARS_3M          = 480;       // 3m bars — 24h of 3min for VWAP
const SCORE            = 72;        // signal score
const AGENT_NAME       = 'SMCPatternAgent';

// ── Self-learning thresholds ─────────────────────────────────
// After MIN_TRADES on a symbol+pattern combo, if win rate drops
// below WIN_RATE_FLOOR, that combo is blocked (pattern "forgotten").
// Block is lifted automatically when wins catch up above UNBLOCK_FLOOR.
const MIN_TRADES       = 5;         // minimum trades before applying filter
const WIN_RATE_FLOOR   = 0.40;      // < 40% WR → block
const UNBLOCK_FLOOR    = 0.50;      // ≥ 50% WR → unblock

// ── 1m BMS (Break of Market Structure) detector ──────────────
// Checks whether the current 1m bar closed above the last confirmed pivot HIGH
// (bullish BMS) or below the last confirmed pivot LOW (bearish BMS).
// Uses TV indicator's asymmetric pivot: 1 left bar, 2 right bars.
// When bullish BMS is active → no SHORTs.  When bearish BMS → no LONGs.

// Symbols to scan — all 4 tokens from TRADING_CONFIG trade simultaneously
const PROFESSIONAL_SHORT_FILTER = false; // disabled — all tokens, both directions
const PROFESSIONAL_SHORT_SYMBOLS = new Set(
  Object.keys(TRADING_CONFIG) // all tokens
);
const PROFESSIONAL_MAX_15M_AGE_MS = (parseInt(process.env.PROFESSIONAL_MAX_15M_AGE_MIN || '60', 10) || 60) * 60_000;
const SYMBOLS = Object.keys(TRADING_CONFIG); // BTC, ETH, SOL, BNB — all active

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
    pattern15: raw.pattern15 || raw.pattern,
    pivot15Ts: raw.pivot15Ts,

    // ── Price levels ───────────────────────────────────────
    entry:   entry,
    sl:      sl,
    tp:      tp2,   // primary TP target

    // ── Extended SMC-style context (for logging/UI) ───────
    smcContext: {
      pattern:  raw.pattern,
      pattern15: raw.pattern15 || raw.pattern,
      pivot15Ts: raw.pivot15Ts,
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

function professionalShortFilter(raw, now = Date.now()) {
  if (!PROFESSIONAL_SHORT_FILTER) return { pass: true, reason: 'disabled' };
  if (!PROFESSIONAL_SHORT_SYMBOLS.has(raw.symbol)) {
    return { pass: false, reason: `${raw.symbol} not in professional short whitelist` };
  }
  const professionalPattern = String(raw.pattern15 || raw.pattern || '');
  const professionalTrendShort = raw.dir === 'SHORT' && professionalPattern.includes('LL') && professionalPattern.includes('LH');
  const professionalTrendLong = raw.dir === 'LONG' && professionalPattern.includes('HH') && professionalPattern.includes('HL');
  if (professionalTrendShort || professionalTrendLong) {
    if (!raw.pivot15Ts || now - raw.pivot15Ts > PROFESSIONAL_MAX_15M_AGE_MS) {
      const ageMin = raw.pivot15Ts ? Math.round((now - raw.pivot15Ts) / 60_000) : 'unknown';
      return { pass: false, reason: `${raw.symbol} 15m structure too old (${ageMin}m)` };
    }
    return { pass: true, reason: 'professional trend-follow setup' };
  }
  if (raw.dir !== 'SHORT') {
    return { pass: false, reason: `${raw.symbol} ${raw.dir} blocked: professional mode is SHORT-only` };
  }
  const pattern15 = String(raw.pattern15 || raw.pattern || '');
  if (!(pattern15.includes('LL') && pattern15.includes('LH'))) {
    return { pass: false, reason: `${raw.symbol} pattern ${raw.pattern15 || raw.pattern} blocked: need 15m LL→LH` };
  }
  if (!raw.pivot15Ts || now - raw.pivot15Ts > PROFESSIONAL_MAX_15M_AGE_MS) {
    const ageMin = raw.pivot15Ts ? Math.round((now - raw.pivot15Ts) / 60_000) : 'unknown';
    return { pass: false, reason: `${raw.symbol} 15m structure too old (${ageMin}m)` };
  }
  return { pass: true, reason: 'professional short setup' };
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

    // Cooldown map: 'BTCUSDT_NP_HL' → lastSignalTs (45-min, shared with scanNearestPivotMatch)
    this._cooldowns    = new Map();

    // ── "Next candle" pending signals ──────────────────────────────────
    // User rule: "find 1m LH/HL → fire on the NEXT candle"
    // When a signal fires, store it here instead of executing immediately.
    // On the next execute() that sees a NEW 1m candle has opened (bar.t > pending.barTs),
    // the pending signal is promoted and executed.
    // Key: symbol → { signal, barTs (1m bar open time when detected), dir, detectedAt }
    this._pendingSignals = new Map();


    // Active virtual trades: signal.symbol+'_'+signal.smcContext.pattern → { ...signal, bars4hCache }
    // Used to run checkTradeState per bar and log outcomes.
    this._openTrades   = new Map();

    // Self-learning memory: 'BTCUSDT_LH' → { wins, losses, winRate }
    // Loaded from DB on start, updated after every trade close.
    // Blocks patterns with < 40% WR after 5+ trades.
    this._patternMemory = new Map();

    this._profile = {
      description: `Nearest 15min pivot + nearest 1min pivot must match. ` +
                   `Both HL → LONG. Both LH → SHORT. Fires immediately on match. ` +
                   `4H trend filter. Per-token SL (0.20–0.30%).`,
      role:   'Pattern Engine Trader',
      icon:   'pattern',
      skills: [
        { id: 'hl', name: 'HL (Higher Low)',  description: 'Nearest 15min HL + nearest 1min HL → LONG', enabled: true },
        { id: 'lh', name: 'LH (Lower High)', description: 'Nearest 15min LH + nearest 1min LH → SHORT', enabled: true },
        { id: 'trend',   name: '4H Trend Filter', description: 'EMA20/50/200 — gates direction alignment', enabled: true },
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
    await this._loadPatternMemory();
    this.addActivity('info',
      `SMC Pattern Agent ready — ${SYMBOLS.length} tokens | HL/LH | self-learning active`
    );
    bLog.scan(`[SMC-PAT] Ready — tokens: ${SYMBOLS.join('/')}`);
    bLog.scan(`[SMC-PAT] Per-token TFs: ${SYMBOLS.map(s => `${TRADING_CONFIG[s].name}=${TRADING_CONFIG[s].label}`).join(', ')}`);
  }

  // ── Pattern memory helpers ─────────────────────────────────

  async _loadPatternMemory() {
    try {
      const rows = await query('SELECT symbol, pattern, wins, losses, win_rate FROM smc_pattern_memory');
      for (const r of rows.rows) {
        this._patternMemory.set(`${r.symbol}_${r.pattern}`, {
          wins:    parseInt(r.wins,    10),
          losses:  parseInt(r.losses,  10),
          winRate: parseFloat(r.win_rate),
        });
      }
      bLog.scan(`[SMC-PAT] Pattern memory loaded: ${this._patternMemory.size} entries`);
    } catch (err) {
      bLog.error(`[SMC-PAT] _loadPatternMemory: ${err.message}`);
    }
  }

  // Returns true if the pattern+symbol combo should be blocked.
  _isPatternBlocked(symbol, pattern) {
    const mem = this._patternMemory.get(`${symbol}_${pattern}`);
    if (!mem) return false;
    const total = mem.wins + mem.losses;
    if (total < MIN_TRADES) return false;
    return mem.winRate < WIN_RATE_FLOOR;
  }

  async _recordOutcome(symbol, pattern, isWin) {
    const key = `${symbol}_${pattern}`;
    const mem = this._patternMemory.get(key) ?? { wins: 0, losses: 0, winRate: 0 };
    if (isWin) mem.wins++;
    else        mem.losses++;
    const total = mem.wins + mem.losses;
    mem.winRate = total > 0 ? mem.wins / total : 0;
    this._patternMemory.set(key, mem);

    const outcome = isWin ? 'WIN' : 'LOSS';
    bLog.trade(`[SMC-PAT] Memory update: ${key} → ${outcome} | W=${mem.wins} L=${mem.losses} WR=${(mem.winRate*100).toFixed(0)}%`);
    if (!isWin && total >= MIN_TRADES && mem.winRate < WIN_RATE_FLOOR) {
      bLog.trade(`[SMC-PAT] ⚠ BLOCKED: ${key} WR=${(mem.winRate*100).toFixed(0)}% < ${(WIN_RATE_FLOOR*100).toFixed(0)}% threshold`);
      this.addActivity('warning', `${symbol} ${pattern} BLOCKED — WR=${(mem.winRate*100).toFixed(0)}% (${mem.wins}W/${mem.losses}L)`);
    } else if (isWin && total >= MIN_TRADES && mem.winRate >= UNBLOCK_FLOOR) {
      this.addActivity('info', `${symbol} ${pattern} memory: WR=${(mem.winRate*100).toFixed(0)}% (${mem.wins}W/${mem.losses}L)`);
    }

    try {
      await query(`
        INSERT INTO smc_pattern_memory (symbol, pattern, wins, losses, win_rate, last_outcome, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (symbol, pattern) DO UPDATE
          SET wins        = EXCLUDED.wins,
              losses      = EXCLUDED.losses,
              win_rate    = EXCLUDED.win_rate,
              last_outcome = EXCLUDED.last_outcome,
              updated_at  = NOW()
      `, [symbol, pattern, mem.wins, mem.losses, mem.winRate, outcome]);
    } catch (err) {
      bLog.error(`[SMC-PAT] _recordOutcome DB write: ${err.message}`);
    }
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

    // ── Fetch + scan all 4 tokens in parallel ──────────────
    const symResults = await Promise.all(SYMBOLS.map(async sym => {
      try {
        const [bars15m, bars4h, bars1m] = await Promise.all([
          fetchCandles(sym, '15',        BARS_15M),
          fetchCandles(sym, INTERVAL_4H, BARS_4H_TREND),
          fetchCandles(sym, '1',         BARS_1M),
        ]);

        if (!bars15m || bars15m.length < 10) return null;
        if (!bars4h  || bars4h.length  < 50) return null;
        if (!bars1m  || bars1m.length  <  6) return null;

        bLog.scan(`[SMC-PAT] ${sym}: 15m=${bars15m.length} 1m=${bars1m.length}`);

        const raw = scanNearestPivotMatch(sym, bars15m, bars1m, bars4h, this._cooldowns, bLog.scan);
        if (!raw) return null;

        // ── TradingView bias gate ──────────────────────────────
        // TV 15m+1h must agree with the signal direction.
        // If TV says bullish → no SHORT. If TV says bearish → no LONG.
        // This catches false pivot detections that don't match real chart structure.
        const tv = await tvBias(sym);
        if (raw.dir === 'SHORT' && tv === 'bull') {
          bLog.scan(`[SMC-PAT] ${sym} SHORT blocked — TradingView 15m+1h BULLISH (TV overrides internal pivot)`);
          return null;
        }
        if (raw.dir === 'LONG' && tv === 'bear') {
          bLog.scan(`[SMC-PAT] ${sym} LONG blocked — TradingView 15m+1h BEARISH (TV overrides internal pivot)`);
          return null;
        }
        bLog.scan(`[SMC-PAT] ${sym} TV bias=${tv} dir=${raw.dir} ✓ aligned`);

        // ── Attach indicator snapshot so DB trade history is rich ──
        try {
          const price    = bars1m[bars1m.length - 1]?.c || raw.price;
          const trend4h  = classifyTrend(bars4h);
          const ema1hSeries = calcEMASeries(bars1m, Math.min(50, bars1m.length - 1));
          const ema1h    = ema1hSeries[ema1hSeries.length - 1];
          const above1h  = ema1h !== null && price > ema1h;
          const trendEff = trend4h === 'DOWN' && above1h  ? 'UP'
                         : trend4h === 'UP'   && !above1h ? 'DOWN'
                         : trend4h === 'NEUTRAL'          ? (above1h ? 'UP' : 'DOWN')
                         : trend4h;
          const rsi = calcRSI(bars15m, 14);
          const adx = calcADX(bars4h,  14);
          raw.marketStructure = JSON.stringify({
            pattern:  raw.pattern,
            trend4h,
            trend:    trendEff,
            rsi:      rsi ? +rsi.toFixed(2) : null,
            adx:      adx ? +adx.toFixed(2) : null,
            above1hEma: above1h,
          });
        } catch (_) {}

        bLog.scan(`[SMC-PAT] ${sym} SIGNAL: key=${raw.keyLevel?.toFixed(4)} 1m_piv=${raw.pivot1m?.toFixed(4)} type=${raw.pattern} dir=${raw.dir}`);
        return raw;
      } catch (err) {
        this._lastError = err.message;
        this.addActivity('error', `${sym} scan failed: ${err.message}`);
        bLog.error(`[SMC-PAT] ${sym} error: ${err.message}`);
        return null;
      }
    }));

    for (const raw of symResults) {
      if (!raw) continue;
      const sym = raw.symbol;
      {
          const r = raw;
          const sig = formatSignal(r);
          signals.push(sig);
          this._signalCount++;

          const msg = `${sig.symbol} ${sig.direction} pattern=${r.pattern} ` +
                      `entry=${r.price.toFixed(4)} sl=${r.sl.toFixed(4)} ` +
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
    }

    // ── Update open trade states (outcome logging only) ────
    await this._tickOpenTrades();

    this._lastSignals = signals;
    this.currentTask  = {
      description: `Standing by — ${this._signalCount} signals fired total`,
      startedAt: Date.now(),
    };

    // ── Step 4: Promote pending signals only when next candle confirms "not LH/HL" ────
    //
    // 4-step rule:
    //   1. 15m LL (SHORT) or HH (LONG)
    //   2. 15m LH (SHORT) or HL (LONG)
    //   3. 1m  LH (SHORT) or HL (LONG)   ← stored as pending at this point
    //   4. NEXT 1m candle must NOT be a LH/HL (must respect the pivot level):
    //        SHORT: next bar HIGH < 1m LH level → fire.  HIGH ≥ level → still LH → wait.
    //        LONG:  next bar LOW  > 1m HL level → fire.  LOW  ≤ level → still HL → wait.
    //      Cancel if structure is broken (price blows through the pivot by >0.1%).
    //      Fire only when the candle that opens AFTER the pivot candle respects it.
    //      Update entry price to current candle close when promoting.
    const pendingToExecute = [];
    for (const [sym, pending] of this._pendingSignals.entries()) {
      // Expire after 5 candles (5 min) — if market doesn't confirm, signal is stale
      if (now - pending.detectedAt > 5 * 60_000) {
        bLog.scan(`[SMC-PAT] PENDING ${sym} ${pending.dir}: expired (5-min timeout) — reset structure`);
        this.addActivity('skip', `${sym} ${pending.dir} — step-4 expired, waiting for new 15m structure`);
        this._pendingSignals.delete(sym);
        continue;
      }

      // Wait until the signal's 1m candle has fully closed (barTs + 60s elapsed)
      if (now < pending.barTs + 60_000) {
        const waitMs = (pending.barTs + 60_000) - now;
        bLog.scan(`[SMC-PAT] PENDING ${sym} ${pending.dir}: waiting ${(waitMs/1000).toFixed(0)}s for candle close`);
        continue;
      }

      // ── New candle has opened — fetch fresh 1m bars for step-4 check ──
      let freshBars;
      try {
        freshBars = await fetchCandles(sym, '1', 5);
      } catch (e) {
        bLog.scan(`[SMC-PAT] PENDING ${sym} ${pending.dir}: bar fetch failed (${e.message}) — will retry next cycle`);
        continue;
      }
      if (!freshBars || freshBars.length < 2) {
        bLog.scan(`[SMC-PAT] PENDING ${sym} ${pending.dir}: insufficient bars — will retry next cycle`);
        continue;
      }

      // The most-recently CLOSED bar (not still-forming) is the "next candle"
      // freshBars[last] = still-forming (current), freshBars[last-1] = last closed.
      // We need the bar that OPENED after the signal's pivot candle (barTs).
      // Find the first bar whose open time > pending.barTs.
      const nextIndex = freshBars.findIndex(b => b.t > pending.barTs);
      const nextBar = nextIndex >= 0 ? freshBars[nextIndex] : null;
      if (!nextBar) {
        bLog.scan(`[SMC-PAT] PENDING ${sym} ${pending.dir}: no bar found after barTs ${pending.barTs} — retrying`);
        continue;
      }

      const prevBar = nextIndex > 0 ? freshBars[nextIndex - 1] : null;
      const pivotLevel = pending.level; // 1m LH price (SHORT) or 1m HL price (LONG)
      const isShort    = pending.dir === 'SHORT';

      if (!pivotLevel) {
        // No pivot level stored → can't check → promote immediately
        bLog.scan(`[SMC-PAT] PENDING ${sym} ${pending.dir}: no pivot level — promoting directly`);
        pending.signal.price     = nextBar.c;
        pending.signal.lastPrice = nextBar.c;
        pendingToExecute.push(pending.signal);
        this._pendingSignals.delete(sym);
        continue;
      }

      if (isShort) {
        // SHORT: next candle HIGH must be BELOW the 1m LH pivot (bar is not a new LH)
        if (nextBar.h > pivotLevel * 1.001) {
          // Structure broken — price punched above LH, invalidate signal
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} SHORT: CANCELLED — next bar HIGH ${nextBar.h.toFixed(4)} ` +
            `broke above LH pivot ${pivotLevel.toFixed(4)} — structure invalid`
          );
          this.addActivity('skip', `${sym} SHORT — step-4 failed: price broke above 1m LH, resetting`);
          this._pendingSignals.delete(sym);
        } else if (nextBar.h >= pivotLevel) {
          // Still forming a LH — wait for the next candle
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} SHORT: WAIT — next bar HIGH ${nextBar.h.toFixed(4)} ` +
            `still at LH level ${pivotLevel.toFixed(4)} — waiting another candle`
          );
          // Advance barTs to this candle so we wait for the NEXT one
          pending.barTs = nextBar.t;
        } else if (nextBar.c < pivotLevel * 0.997) {
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} SHORT: CANCELLED - close ${nextBar.c.toFixed(4)} ` +
            `is too far below LH ${pivotLevel.toFixed(4)} - late chase entry`
          );
          this.addActivity('skip', `${sym} SHORT - too far below LH, no bottom short`);
          this._pendingSignals.delete(sym);
        } else if (!(nextBar.c < nextBar.o && (!prevBar || nextBar.c < prevBar.c))) {
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} SHORT: WAIT - LH held but candle not bearish ` +
            `(o=${nextBar.o.toFixed(4)} c=${nextBar.c.toFixed(4)} prevC=${prevBar ? prevBar.c.toFixed(4) : 'n/a'})`
          );
          pending.barTs = nextBar.t;
        } else {
          // next bar HIGH < LH pivot → confirmed "not LH" → fire
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} SHORT: CONFIRMED — next bar HIGH ${nextBar.h.toFixed(4)} ` +
            `below LH ${pivotLevel.toFixed(4)} — step 4 passed, firing`
          );
          this.addActivity('trade', `${sym} SHORT — step 4 confirmed: next candle respected LH pivot`);
          pending.signal.price     = nextBar.c;
          pending.signal.lastPrice = nextBar.c;
          pendingToExecute.push(pending.signal);
          this._pendingSignals.delete(sym);
        }
      } else {
        // LONG: next candle LOW must be ABOVE the 1m HL pivot (bar is not a new HL)
        if (nextBar.l < pivotLevel * 0.999) {
          // Structure broken — price dropped below HL, invalidate signal
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} LONG: CANCELLED — next bar LOW ${nextBar.l.toFixed(4)} ` +
            `broke below HL pivot ${pivotLevel.toFixed(4)} — structure invalid`
          );
          this.addActivity('skip', `${sym} LONG — step-4 failed: price broke below 1m HL, resetting`);
          this._pendingSignals.delete(sym);
        } else if (nextBar.l <= pivotLevel) {
          // Still forming a HL — wait for the next candle
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} LONG: WAIT — next bar LOW ${nextBar.l.toFixed(4)} ` +
            `still at HL level ${pivotLevel.toFixed(4)} — waiting another candle`
          );
          pending.barTs = nextBar.t;
        } else if (nextBar.c > pivotLevel * 1.003) {
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} LONG: CANCELLED - close ${nextBar.c.toFixed(4)} ` +
            `is too far above HL ${pivotLevel.toFixed(4)} - late chase entry`
          );
          this.addActivity('skip', `${sym} LONG - too far above HL, no top long`);
          this._pendingSignals.delete(sym);
        } else if (!(nextBar.c > nextBar.o && (!prevBar || nextBar.c > prevBar.c))) {
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} LONG: WAIT - HL held but candle not bullish ` +
            `(o=${nextBar.o.toFixed(4)} c=${nextBar.c.toFixed(4)} prevC=${prevBar ? prevBar.c.toFixed(4) : 'n/a'})`
          );
          pending.barTs = nextBar.t;
        } else {
          // next bar LOW > HL pivot → confirmed "not HL" → fire
          bLog.scan(
            `[SMC-PAT] PENDING ${sym} LONG: CONFIRMED — next bar LOW ${nextBar.l.toFixed(4)} ` +
            `above HL ${pivotLevel.toFixed(4)} — step 4 passed, firing`
          );
          this.addActivity('trade', `${sym} LONG — step 4 confirmed: next candle respected HL pivot`);
          pending.signal.price     = nextBar.c;
          pending.signal.lastPrice = nextBar.c;
          pendingToExecute.push(pending.signal);
          this._pendingSignals.delete(sym);
        }
      }
    }

    if (!signals.length && !pendingToExecute.length) {
      this.addActivity('info', 'No pattern setups this cycle — waiting for pivot retest');
      return { ok: true, signals: 0 };
    }

    // ── Deduplicate: one signal per symbol ───────────────────
    const seenSymbols = new Set();
    const btcFiltered = signals.filter(s => {
      if (seenSymbols.has(s.symbol)) return false;
      seenSymbols.add(s.symbol);
      return true;
    });

    // ── Route signals: RiskAgent → TraderAgent ─────────────
    if (context.coordinator) {
      try {
        const riskAgent   = context.coordinator.riskAgent;
        const traderAgent = context.coordinator.traderAgent;

        // Pass real open positions to RiskAgent for context (no hard block)
        let openPositions = [];
        try {
          const openRows = await query("SELECT symbol, direction FROM trades WHERE status = 'OPEN'");
          openPositions = (Array.isArray(openRows) ? openRows : openRows.rows || []).map(r => r.symbol);
        } catch (_) {}

        let approved = btcFiltered;
        if (riskAgent && !riskAgent.paused) {
          const riskResult = await riskAgent.run({ signals: btcFiltered, openPositions });
          approved = riskResult?.approved || btcFiltered;
          bLog.scan(`[SMC-PAT] RiskAgent: ${approved.length}/${btcFiltered.length} approved`);
        }

        const marketDecisionAgent = context.coordinator.marketDecisionAgent;
        if (approved.length && marketDecisionAgent && !marketDecisionAgent.paused) {
          const decisionResult = await marketDecisionAgent.run({
            signals: approved,
            sentimentAgent: context.coordinator.sentimentAgent,
          });
          approved = decisionResult?.approved || [];
          const rejected = decisionResult?.rejected || [];
          if (rejected.length) {
            bLog.scan(`[SMC-PAT] MarketDecisionAgent rejected ${rejected.length}: ` +
              rejected.map(r => `${r.signal.symbol} ${r.reasons?.[0] || 'decision block'}`).join(' | '));
          }
          bLog.scan(`[SMC-PAT] MarketDecisionAgent: ${approved.length}/${riskAgent && !riskAgent.paused ? 'risk-approved' : btcFiltered.length} approved`);
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
            return true;
          });
        }

        // ── Store new signals as PENDING — execute on next candle ──────────
        // User rule: "fire on the NEXT candle after 1m LH/HL signal"
        // Don't route to TraderAgent immediately. Store with the current 1m
        // bar timestamp. The pending check at the top of execute() will promote
        // these once a new 1m bar opens (barTs + 60s elapsed).
        for (const sig of approved) {
          const sym = sig.symbol;
          // If there's already a pending signal for this symbol in the OPPOSITE
          // direction, it means structure changed — cancel old, store new.
          const existing = this._pendingSignals.get(sym);
          if (existing && existing.dir !== sig.direction) {
            bLog.scan(`[SMC-PAT] PENDING ${sym}: direction flipped ${existing.dir}→${sig.direction} — replacing`);
            this._pendingSignals.delete(sym);
          }
          if (!this._pendingSignals.has(sym)) {
            const barTs = sig.ts ?? now; // sig.ts = 1m bar open time from smc-engine
            this._pendingSignals.set(sym, {
              signal:      sig,
              dir:         sig.direction,
              level:       sig.smcContext?.level ?? null, // 1m LH/HL pivot price
              barTs,       // 1m bar open time when signal was detected
              detectedAt:  now,
            });
            bLog.trade(
              `[SMC-PAT] PENDING: ${sym} ${sig.direction} — waiting for next 1m candle ` +
              `(barTs=${new Date(barTs).toISOString().slice(11,19)} UTC, ` +
              `entry in ~${Math.max(0, Math.ceil((barTs + 60_000 - now)/1000))}s)`
            );
            this.addActivity('info',
              `${sym} ${sig.direction} signal stored — enters on next candle open`
            );
          }
        }

        // ── Execute promoted signals (waited one full candle) ──────────────
        if (pendingToExecute.length && traderAgent && !traderAgent.paused) {
          this.addActivity('trade', `Executing ${pendingToExecute.length} next-candle signal(s) → TraderAgent`);
          bLog.trade(`[SMC-PAT] → TraderAgent.execute ${pendingToExecute.length} next-candle signal(s): ` +
            pendingToExecute.map(s => `${s.symbol} ${s.direction} score=${s.score}`).join(', '));
          const execNow = Date.now();
          for (const sig of pendingToExecute) {
            const pivotTs = sig.pivot15Ts || sig.smcContext?.pivot15Ts;
            if (pivotTs) this._cooldowns.set(`${sig.symbol}_KL_${pivotTs}`, execNow);
            const lock = context.coordinator._sharedSignalLock;
            if (lock) lock.set(`${sig.symbol}:${sig.direction}`, execNow);
          }
          await traderAgent.execute({ signals: pendingToExecute, mode: 'signals' });
          this.addActivity('success', `TraderAgent executed ${pendingToExecute.length} next-candle signal(s)`);
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
          const isWin  = updated.exitReason !== 'LOSS';
          const pnlSign = isWin ? '🟢' : '🔴';
          const msg = `${pnlSign} ${trade.symbol} ${trade.pattern} → ${updated.exitReason} ` +
                      `exit=${updated.exitPrice?.toFixed(4)}`;
          this.addActivity(isWin ? 'success' : 'warning', msg);
          bLog.trade(`[SMC-PAT] CLOSED: ${msg}`);
          // Feed outcome into self-learning memory (fire-and-forget)
          this._recordOutcome(trade.symbol, trade.pattern, isWin).catch(() => {});
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
