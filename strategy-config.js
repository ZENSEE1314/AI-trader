// ============================================================
// Strategy Config Loader
//
// Single source of truth for all strategy tuning parameters.
// Reads overrides from the DB `settings` table (keys prefixed
// with "strat."). Falls back to hardcoded defaults if no DB
// override exists. Cache TTL = 60 s so changes propagate
// within one scan cycle without restarting the process.
//
// Usage in a strategy:
//   const { getCfg } = require('./strategy-config');
//   async function scanFoo(log) {
//     const cfg = await getCfg();
//     const minSpread = cfg['strat.ma_stack.min_stack_spread'];
//     ...
//   }
// ============================================================

// ── Defaults ─────────────────────────────────────────────────
// These are the authoritative defaults. DB values override them.
// Keys must stay in sync with STRATEGY_SCHEMA in routes/admin.js
// (that schema drives the admin UI labels / metadata).

const DEFAULTS = {
  // ── MA Stack Trend ──────────────────────────────────────────
  'strat.ma_stack.enabled':          1,      // 1 = on, 0 = off
  'strat.ma_stack.atr_period':        14,     // ATR lookback (candles)
  'strat.ma_stack.vol_sma_period':    9,      // volume SMA period for conviction filter
  'strat.ma_stack.min_stack_spread':  0.0007, // 0.07% hard floor for MA separation
  'strat.ma_stack.min_spread_growth': 1.20,   // fan must grow ≥20% vs 3 bars ago
  'strat.ma_stack.min_atr_pct':       0.003,  // 0.3% ATR minimum — confirms trending
  'strat.ma_stack.max_extension_atr': 1.5,    // don't chase > 1.5× ATR past SMA5
  'strat.ma_stack.max_signal_age_ms': 180000, // 3 min signal freshness (ms)
  'strat.ma_stack.sl_min_pct':        0.010,  // 1.0% SL floor
  'strat.ma_stack.sl_max_pct':        0.025,  // 2.5% SL cap
  'strat.ma_stack.tp_multiplier':     2.0,    // TP = SL × 2 (2:1 R:R)

  // ── T-Junction ──────────────────────────────────────────────
  'strat.tjunction.enabled':          1,      // 1 = on, 0 = off
  'strat.tjunction.vol_sma_period':   9,      // volume SMA period for conviction filter
  'strat.tjunction.vwap_tolerance':   0.0010, // 0.10% max distance from VWAP allowed
  'strat.tjunction.converge_band':    0.0025, // 0.25% max spread = "converged"
  'strat.tjunction.converge_min':     2,      // min consecutive converged bars
  'strat.tjunction.diverge_min':      0.0012, // 0.12% min fan spread = breakout
  'strat.tjunction.tp_pct':           0.020,  // 2% TP
  'strat.tjunction.sl_pct':           0.010,  // 1% SL
  'strat.tjunction.size_pct':         0.10,   // 10% capital per trade

  // ── Triple MA (Sideways / Mean-Reversion) ───────────────────
  'strat.triple_ma.enabled':          0,      // off by default (poor backtest results)
  'strat.triple_ma.atr_max_pct':           0.008,  // 0.8% ATR cap — sideways only
  'strat.triple_ma.scenario_a_sl_pct':     0.010,  // 1% SL for Scenario A
  'strat.triple_ma.scenario_a_tolerance':  0.005,  // 0.5% entry proximity to MA
  'strat.triple_ma.rsi_oversold':          45,     // RSI < 45 for Scenario B dip-buy
  'strat.triple_ma.size_pct':              0.10,   // 10% capital per trade

  // ── Spike HL ────────────────────────────────────────────────
  'strat.spike_hl.enabled':          1,      // 1 = on, 0 = off
  'strat.spike_hl.ema_period':      200,    // EMA period for trend bias filter (e.g. 100 or 200)
  'strat.spike_hl.min_spike_pct':   0.0015, // 0.15% minimum spike size
  'strat.spike_hl.max_spike_pct':   0.015,  // 1.5% cap — beyond = crash, skip
  'strat.spike_hl.min_wick_ratio':  1.2,    // wick must be ≥ 1.2× candle body
  'strat.spike_hl.sl_buffer':       0.001,  // 0.1% beyond spike extreme for SL
  'strat.spike_hl.size_pct':        0.10,   // 10% capital per trade

  // ── SMC Engine ──────────────────────────────────────────────
  'strat.smc.enabled':              1,      // 1 = on, 0 = off
  'strat.smc.swing_len_3m':         5,      // candles each side to confirm a 3m swing point
  'strat.smc.swing_len_1m':         4,      // candles each side to confirm a 1m swing point
  'strat.smc.ema_period':           200,    // 1h EMA bias period (200 or 100)
  'strat.smc.max_candle_age':       20,     // max candles since swing before entry expires
  'strat.smc.max_chase_pct':        0.015,  // 1.5% max price distance from swing (no chasing)
  'strat.smc.sl_pct':               0.005,  // 0.5% SL distance from entry
  'strat.smc.tp_pct':               0.010,  // 1.0% TP distance (1:2 R:R)
  'strat.smc.trailing_step':        0.012,  // 1.2% trail-stop step once TP hit
  'strat.smc.size_pct':             0.10,   // 10% capital per trade
};

// ── Cache ─────────────────────────────────────────────────────

let _cache  = null;
let _cacheTs = 0;
const CACHE_TTL = 60_000; // 60 seconds

async function getCfg() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  try {
    const { query } = require('./db');
    const rows = await query("SELECT key, value FROM settings WHERE key LIKE 'strat.%'");
    const merged = { ...DEFAULTS };
    for (const r of rows) {
      if (r.key in DEFAULTS) {
        const parsed = Number(r.value);
        merged[r.key] = Number.isFinite(parsed) ? parsed : DEFAULTS[r.key];
      }
    }
    _cache  = merged;
    _cacheTs = Date.now();
    return _cache;
  } catch {
    // DB unavailable — use defaults so strategies still run
    return DEFAULTS;
  }
}

// Call after a PUT /strategy-config so the next scan picks up changes immediately.
function invalidateCache() {
  _cache  = null;
  _cacheTs = 0;
}

module.exports = { getCfg, invalidateCache, DEFAULTS };
