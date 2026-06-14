// ============================================================
// VwapPullbackAgent — Backtested SMC pullback strategy
//
// Rules (exact match to backtest-structure.js):
//   BIAS  : 15m chart — detect HL (Higher Low) → long bias
//                               LH (Lower High) → short bias
//           pivot(5) — bar must be highest/lowest of 5 left + 5 right
//   FILTER: The 15m pivot must sit at or beyond the ±2 SD VWAP band
//           (daily VWAP anchored at UTC midnight).
//           HL pivot price ≤ VWAP − 2SD  →  long allowed
//           LH pivot price ≥ VWAP + 2SD  →  short allowed
//   ENTRY : Drop to 1m chart. Within the bias window, wait for a
//           1m swing LOW  (low[i-1] < both neighbours) → long on next bar
//           1m swing HIGH (high[i-1] > both neighbours) → short on next bar
//           One trade per bias window; rearms on new HL/LH.
//   RISK  : Leverage 20x, SL = −35% of margin, TP = +50% of margin
//           (matches the best OOS-validated cell: SOL ✅ all, ETH 50x/$35 ✅)
//   SYMBOLS: SOLUSDT (20x), ETHUSDT (20x)
//
// Backtest results (30d, OOS validated):
//   SOL 20x/$50 : ✅ both halves  P1 55.6% PF1.62 / P2 62.5% PF2.16
//   SOL 20x/$35 : ✅ both halves  P1 75.0% PF2.68 / P2 66.7% PF1.78
//   ETH 50x/$35 : ✅ both halves  P1 66.7% PF1.50 / P2 64.7% PF1.37
//   BTC/BNB     : NOT deployed — failed OOS test
// ============================================================

'use strict';

const fetch        = require('node-fetch');
const { BaseAgent } = require('./base-agent');
const { log: bLog } = require('../bot-logger');

// ── Config ────────────────────────────────────────────────────
const SYMBOLS = [
  { symbol: 'SOLUSDT', leverage: 20, slMargin: 0.35, tpMargin: 0.50 },
  { symbol: 'ETHUSDT', leverage: 20, slMargin: 0.35, tpMargin: 0.50 },
];

const SCAN_INTERVAL_MS  = 60_000;       // scan every 60 s
const COOLDOWN_MS       = 4 * 3600_000; // 4h per-symbol cooldown after any trade
const PIVOT_LEN         = 5;            // bars left+right for pivot detection
const BIAS_WINDOW_BARS  = 8;            // 15m bias window length after pivot confirms
const KLINE_LIMIT_15M   = 150;          // 15m bars to fetch (covers ~37 h)
const KLINE_LIMIT_1M    = 300;          // 1m bars to fetch (covers 5 h)
const BYBIT_URL         = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT_MS  = 12_000;

// ── Kline fetcher (Bybit v5) ──────────────────────────────────
async function fetchKlines(symbol, intervalMin, limit) {
  const qs = new URLSearchParams({
    category: 'linear',
    symbol,
    interval: String(intervalMin),
    limit:    String(limit),
  });
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res  = await fetch(`${BYBIT_URL}?${qs}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
    return json.result.list
      .map(r => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
      .sort((a, b) => a.time - b.time);
  } finally {
    clearTimeout(tid);
  }
}

// ── Daily VWAP + ±2 SD bands (UTC midnight anchor) ───────────
function calcVwapBands(candles) {
  let day = null, tpv = 0, vol = 0, tpv2 = 0;
  const result = candles.map(c => {
    const d = Math.floor(c.time / 86_400_000);
    if (d !== day) { day = d; tpv = 0; vol = 0; tpv2 = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    tpv  += tp * c.volume;
    vol  += c.volume;
    tpv2 += tp * tp * c.volume;
    if (vol === 0) return { ...c, vwap: null, upper2: null, lower2: null };
    const vwap = tpv / vol;
    const sd   = Math.sqrt(Math.max(0, tpv2 / vol - vwap * vwap));
    return { ...c, vwap, upper2: vwap + 2 * sd, lower2: vwap - 2 * sd };
  });
  return result;
}

// ── 15m pivot detection ───────────────────────────────────────
// Returns array of { idx, kind:'high'|'low', price, confirmAt } 
function detectPivots(candles, len) {
  const pivots = [];
  for (let i = len; i < candles.length - len; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= len; k++) {
      if (candles[i].high <= candles[i - k].high || candles[i].high <= candles[i + k].high) isHigh = false;
      if (candles[i].low  >= candles[i - k].low  || candles[i].low  >= candles[i + k].low)  isLow  = false;
    }
    if (isHigh) pivots.push({ idx: i, kind: 'high', price: candles[i].high, confirmAt: i + len });
    if (isLow)  pivots.push({ idx: i, kind: 'low',  price: candles[i].low,  confirmAt: i + len });
  }
  return pivots;
}

// ── Detect current active bias window ────────────────────────
// Looks for the most recent unconfirmed HL (long) or LH (short) on 15m.
// Returns { bias:'long'|'short', fromTime, toTime, pivotPrice, vwapOk } or null.
function detectBiasWindow(c15withBands) {
  const pivots = detectPivots(c15withBands, PIVOT_LEN);
  const highs  = pivots.filter(p => p.kind === 'high');
  const lows   = pivots.filter(p => p.kind === 'low');
  const now    = Date.now();

  const candidates = [];

  // HL → long
  for (let j = 1; j < lows.length; j++) {
    if (lows[j].price > lows[j - 1].price) {
      const confirmBar = c15withBands[lows[j].confirmAt];
      if (!confirmBar) continue;
      const fromTime = confirmBar.time;
      const toTime   = fromTime + BIAS_WINDOW_BARS * 15 * 60_000;
      if (now >= fromTime && now <= toTime) {
        const band = c15withBands[lows[j].idx];
        const vwapOk = band.lower2 != null && lows[j].price <= band.lower2;
        candidates.push({ bias: 'long', fromTime, toTime, pivotPrice: lows[j].price, vwapOk });
      }
    }
  }
  // LH → short
  for (let j = 1; j < highs.length; j++) {
    if (highs[j].price < highs[j - 1].price) {
      const confirmBar = c15withBands[highs[j].confirmAt];
      if (!confirmBar) continue;
      const fromTime = confirmBar.time;
      const toTime   = fromTime + BIAS_WINDOW_BARS * 15 * 60_000;
      if (now >= fromTime && now <= toTime) {
        const band = c15withBands[highs[j].idx];
        const vwapOk = band.upper2 != null && highs[j].price >= band.upper2;
        candidates.push({ bias: 'short', fromTime, toTime, pivotPrice: highs[j].price, vwapOk });
      }
    }
  }

  // Most recent wins
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.fromTime - a.fromTime)[0];
}

// ── 1m swing entry detection ──────────────────────────────────
// Returns 'long' | 'short' | null based on the last confirmed 1m swing.
function detectEntry(c1m, bias) {
  if (c1m.length < 3) return null;
  const n    = c1m.length;
  const prev = c1m[n - 2]; // the candle that just closed (potential swing point)
  const pre  = c1m[n - 3]; // candle before it
  const curr = c1m[n - 1]; // the current forming candle (entry bar)

  if (bias === 'long') {
    // swing low: prev.low < both neighbours
    if (prev.low < pre.low && prev.low < curr.low) return 'long';
  } else if (bias === 'short') {
    // swing high: prev.high > both neighbours
    if (prev.high > pre.high && prev.high > curr.high) return 'short';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
class VwapPullbackAgent extends BaseAgent {

  constructor(options = {}) {
    super('VwapPullbackAgent', options);

    this._scanTimer   = null;
    this._cooldowns   = new Map(); // symbol → lastTradeMs
    this._windowState = new Map(); // symbol → { armed, bias, fromTime, toTime }

    this._profile = {
      description: 'Backtested VWAP+SMC pullback trader — SOL & ETH only, 20x, VWAP outer-band filter.',
      role:        'VWAP Pullback Trader',
      icon:        'smc',
      skills: [
        { id: 'htf_bias',      name: '15m HL/LH Bias',      description: 'Detects HL (long) / LH (short) pivots on 15m chart', enabled: true },
        { id: 'vwap_filter',   name: 'VWAP ±2SD Filter',    description: 'Only trades when pivot reaches the outer VWAP band', enabled: true },
        { id: 'ltf_entry',     name: '1m Swing Entry',       description: 'Enters on the candle after a 1m swing low/high',     enabled: true },
        { id: 'risk',          name: 'Fixed Risk 20x',       description: 'SL −35% margin, TP +50% margin, 20x leverage',       enabled: true },
        { id: 'cooldown',      name: '4h Cooldown',          description: 'One trade per symbol per 4 hours',                   enabled: true },
      ],
      config: [
        { key: 'scanIntervalMs', label: 'Scan interval (ms)', type: 'number', value: SCAN_INTERVAL_MS },
      ],
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────
  async init() {
    await super.init();
    bLog.scan('[VWAP-PB] VwapPullbackAgent ready — SOL/ETH 20x outer-band pullback');
    this.addActivity('info', 'VwapPullbackAgent initialised — SOL & ETH, VWAP ±2SD filter, 1m swing entry');
  }

  async stop() {
    if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
    await super.stop();
  }

  // ── Main execute — called by AgentCoordinator CEO loop ─────
  async execute(context = {}) {
    const now = Date.now();

    this.currentTask = { description: 'Scanning 15m+1m VWAP pullback...', startedAt: now };

    const signals = [];

    for (const cfg of SYMBOLS) {
      const { symbol, leverage, slMargin, tpMargin } = cfg;
      try {
        // ── Cooldown check ──────────────────────────────────
        const lastTrade = this._cooldowns.get(symbol) || 0;
        if (now - lastTrade < COOLDOWN_MS) {
          const waitMin = Math.ceil((COOLDOWN_MS - (now - lastTrade)) / 60_000);
          bLog.scan(`[VWAP-PB] ${symbol} cooldown — ${waitMin}m remaining`);
          this.addActivity('skip', `${symbol} cooldown — ${waitMin}m`);
          continue;
        }

        // ── Fetch candles ───────────────────────────────────
        const [c15raw, c1m] = await Promise.all([
          fetchKlines(symbol, 15, KLINE_LIMIT_15M),
          fetchKlines(symbol, 1,  KLINE_LIMIT_1M),
        ]);
        if (c15raw.length < PIVOT_LEN * 2 + 2 || c1m.length < 3) {
          bLog.scan(`[VWAP-PB] ${symbol} insufficient candles — skip`);
          continue;
        }

        // ── VWAP bands on 15m ──────────────────────────────
        const c15 = calcVwapBands(c15raw);

        // ── Detect active bias window ───────────────────────
        const window = detectBiasWindow(c15);
        if (!window) {
          bLog.scan(`[VWAP-PB] ${symbol} — no active 15m bias window`);
          this.addActivity('info', `${symbol} — no active HL/LH window`);
          continue;
        }

        const { bias, vwapOk, pivotPrice, fromTime, toTime } = window;
        const bandDesc = vwapOk ? '✅ at outer band' : '⛔ inside bands — filtered out';
        bLog.scan(`[VWAP-PB] ${symbol} bias=${bias.toUpperCase()} pivot=${pivotPrice.toFixed(2)} VWAP ±2SD: ${bandDesc}`);

        if (!vwapOk) {
          this.addActivity('skip', `${symbol} ${bias} — pivot inside VWAP bands, no trade`);
          continue;
        }

        // ── Track window arming (one trade per window) ──────
        const winKey = `${symbol}:${fromTime}`;
        const state  = this._windowState.get(winKey);
        if (state && state.traded) {
          bLog.scan(`[VWAP-PB] ${symbol} — already traded this bias window`);
          continue;
        }
        // Clean up old window states (older than 2h)
        for (const [k, v] of this._windowState.entries()) {
          if (now - v.openedAt > 7_200_000) this._windowState.delete(k);
        }
        if (!state) this._windowState.set(winKey, { traded: false, openedAt: now });

        // ── 1m swing entry check ────────────────────────────
        const entryDirection = detectEntry(c1m, bias);
        if (!entryDirection) {
          bLog.scan(`[VWAP-PB] ${symbol} ${bias} — waiting for 1m swing entry trigger`);
          this.addActivity('info', `${symbol} ${bias} — in window, waiting for 1m swing`);
          continue;
        }

        // ── Signal ready ────────────────────────────────────
        const price     = c1m[c1m.length - 1].close;
        const isLong    = entryDirection === 'long';
        const slPricePct = slMargin / leverage;
        const tpPricePct = tpMargin / leverage;
        const slPrice   = isLong ? price * (1 - slPricePct) : price * (1 + slPricePct);
        const tpPrice   = isLong ? price * (1 + tpPricePct) : price * (1 - tpPricePct);

        const signal = {
          symbol,
          direction:     isLong ? 'LONG' : 'SHORT',
          price,
          leverage,
          slPrice:       parseFloat(slPrice.toFixed(4)),
          tpPrice:       parseFloat(tpPrice.toFixed(4)),
          slMarginFrac:  slMargin / leverage,   // price-% for SL (0.35/20 = 0.0175)
          tpMarginFrac:  tpMargin / leverage,   // price-% for TP (0.50/20 = 0.025)
          score:         75,   // above SMCProAgent priority so coordinator won't suppress it
          strategy:      'VWAP_PULLBACK',
          setup:         `15m_${bias.toUpperCase()}_VWAP2SD_1mSwing`,
          smcContext:    { vwapFilter: true, pivotPrice, biasWindow: `${new Date(fromTime).toISOString()}→${new Date(toTime).toISOString()}` },
        };

        signals.push(signal);
        this._cooldowns.set(symbol, now);
        this._windowState.get(winKey).traded = true;

        const msg = `${symbol} ${signal.direction} entry=${price.toFixed(2)} SL=${signal.slPrice} TP=${signal.tpPrice} [VWAP outer-band + 1m swing]`;
        bLog.trade(`[VWAP-PB] SIGNAL: ${msg}`);
        this.addActivity('trade', msg);

      } catch (err) {
        bLog.error(`[VWAP-PB] ${symbol} error: ${err.message}`);
        this.addActivity('error', `${symbol} scan failed: ${err.message}`);
      }
    }

    this.currentTask = { description: `Standing by — last scan ${new Date().toUTCString()}`, startedAt: now };

    if (!signals.length) return { ok: true, signals: 0 };

    // ── Route through coordinator pipeline (same as SMCProAgent) ──
    if (context.coordinator) {
      try {
        const { riskAgent, traderAgent } = context.coordinator;
        const { query: dbQ }             = require('../db');

        let openPositions = [];
        try {
          const rows = await dbQ("SELECT symbol, direction FROM trades WHERE status = 'OPEN'");
          openPositions = rows.rows.map(r => r.symbol);
        } catch (_) {}

        // Block if same symbol already has an open position
        const filtered = signals.filter(s => {
          if (openPositions.includes(s.symbol)) {
            bLog.scan(`[VWAP-PB] ${s.symbol} already has open position — skip`);
            this.addActivity('skip', `${s.symbol} open position exists`);
            return false;
          }
          return true;
        });

        let approved = filtered;
        if (riskAgent && !riskAgent.paused) {
          const riskResult = await riskAgent.run({ signals: filtered, openPositions });
          approved = riskResult?.approved || filtered;
          bLog.scan(`[VWAP-PB] RiskAgent: ${approved.length}/${filtered.length} approved`);
        }

        // Cross-agent dedup lock
        const lock   = context.coordinator._sharedSignalLock;
        const lockMs = context.coordinator.SHARED_SIGNAL_COOLDOWN_MS;
        if (lock && lockMs) {
          approved = approved.filter(s => {
            const key    = `${s.symbol}:${s.direction}`;
            const lastAt = lock.get(key) || 0;
            if (now - lastAt < lockMs) {
              bLog.scan(`[VWAP-PB] Cross-agent dedup: ${s.symbol} ${s.direction} locked`);
              return false;
            }
            lock.set(key, now);
            return true;
          });
        }

        if (approved.length && traderAgent && !traderAgent.paused) {
          bLog.trade(`[VWAP-PB] → TraderAgent.execute ${approved.length} signal(s)`);
          this.addActivity('trade', `Routing ${approved.length} signal(s) → TraderAgent`);
          await traderAgent.execute({ signals: approved, mode: 'signals' });
          this.addActivity('success', `TraderAgent executed ${approved.length} signal(s)`);
        }
      } catch (err) {
        bLog.error(`[VWAP-PB] Routing error: ${err.message}`);
        this.addActivity('error', `Signal routing failed: ${err.message}`);
      }
    }

    return { ok: true, signals: signals.length, results: signals };
  }

  // ── Status / health ────────────────────────────────────────
  getStatus() {
    return {
      ...super.getStatus?.() || {},
      cooldowns:    Object.fromEntries(this._cooldowns),
      windowStates: this._windowState.size,
      symbols:      SYMBOLS.map(s => s.symbol),
    };
  }
}

module.exports = { VwapPullbackAgent };
