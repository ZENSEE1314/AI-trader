'use strict';

// MTF SMC strategy (Luxalgo convention) — wired to backtest-structure.js
// ====================================================================
//   15m HL (higher low) → bullish bias → 1m HL/LL + next bullish candle → LONG
//   15m LH (lower high) → bearish bias → 1m LH/HH + next bearish candle → SHORT
//
// VWAP ±2SD FILTER (the edge from the backtest):
//   A 15m pivot only sets bias if its price reached the OUTER session-VWAP band
//   (long: HL at/below VWAP−2SD; short: LH at/above VWAP+2SD). This mirrors
//   backtest-structure.js exactly — it is what lifted the win rate (aggregated
//   SL 50% / TP 70% margin at 20x → ~68% WR, PF 2.75 across BTC/ETH/SOL/BNB).
//   Toggle with env VWAP_FILTER=0 to compare live with/without.
//
// NOTE ON ORDERING: @mathieuc/tradingview returns chart.periods AND pine.periods
//   sorted NEWEST-FIRST (descending time). We normalise to ascending so the
//   newest bar is the last element, matching the backtest's chronological math.
//   Period shape: { time(sec), open, close, max(=high), min(=low), volume }.
//
// Structure labels (Luxalgo):
//   HH = higher high | LH = lower high | HL = higher low | LL = lower low
//
// Pine plot indices (verified against SMC-Pro-Suite.pine):
//   0-4  : VWAP bands   | 10 prob_long | 11 prob_short | 12-13 smc_l/s
//   14-15: liq_l/s | 16-17 ob_l/s | 18-19 wt_l/s | 20 trail_dir
//   21   : lh_raw (LH confirmed) | 22 hl_raw (HL) | 23 hh_raw (HH) | 24 ll_raw (LL)

const TradingView = require('@mathieuc/tradingview');
const { injectTVSignal } = require('../cycle');

const bLog = (...a) => console.log('[SMC-Watcher]', ...a);

// ── Config ───────────────────────────────────────────────────────
const SYMBOLS        = ['BITUNIX:BTCUSDT.P', 'BITUNIX:ETHUSDT.P', 'BITUNIX:SOLUSDT.P'];
const HISTORY_BARS   = 500;
const COOLDOWN_MS    = 30 * 60 * 1000;     // 30 min per symbol per direction
const BIAS_TTL_MS    = 4 * 60 * 60 * 1000; // 15m bias expires after 4 hours
const BIAS_LOOKBACK  = 4;                  // scan last 4 × 15m bars on startup (~1 hour)
const SCRIPT_ID      = 'USER;5c16ebbf6afb4746a8fc0b693cc3a834';
const PIVOT_LEN      = 5;                   // SMC-Pro-Suite pivot length (matches backtest pivLen=5)
const VWAP_FILTER    = (process.env.VWAP_FILTER || '1') !== '0';

// Money management — backtest-structure.js optimum (SL 50% / TP 70% margin).
// NOTE: cycle.js derives the live SL/TP for professional SMC setups (0.50/0.75 of
// margin); these fields are signal metadata for logging/telemetry.
const TRADE_SIZE_PCT = 0.10;
const SL_PCT         = 0.50;
const TP_PCT         = 0.70;

// Plot indices
const IDX = {
  probLong: 10, probShort: 11,
  smcL: 12, smcS: 13, liqL: 14, liqS: 15,
  obL: 16, obS: 17, wtL: 18, wtS: 19, trailDir: 20,
  lhRaw: 21, hlRaw: 22, hhRaw: 23, llRaw: 24,
};

// ── Q-Learning (reward tracking only — no trade gate, per commit aed1597) ──
const Q_TABLE = {};
const ALPHA = 0.1, GAMMA = 0.9;
let   EPSILON = 0.3;
function stateKey(f) { return `${Math.floor(f.prob / 20) * 20}|${f.smc}|${f.liq}|${f.ob}|${f.wt}|${f.trail}`; }
function qValues(k)  { if (!Q_TABLE[k]) Q_TABLE[k] = [0, 0]; return Q_TABLE[k]; }
function qUpdate(k, a, r) { const q = qValues(k); q[a] += ALPHA * (r + GAMMA * Math.max(...q) - q[a]); EPSILON = Math.max(0.05, EPSILON * 0.9995); }

// ── Shared state ─────────────────────────────────────────────────
// biasMap[sym] = { direction:'LONG'|'SHORT', setAt:ms } | null
const biasMap   = {};
const cooldowns = new Map();
const qPending  = new Map();  // sym → { key, direction, entryPx }

function canTrade(sym, dir)   { return Date.now() - (cooldowns.get(`${sym}:${dir}`) || 0) > COOLDOWN_MS; }
function markTraded(sym, dir) { cooldowns.set(`${sym}:${dir}`, Date.now()); }
function normSym(tv)          { return tv.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT'); }
function biasAlive(sym)       { const b = biasMap[sym]; return b && Date.now() - b.setAt < BIAS_TTL_MS ? b : null; }

// chart.periods / pine.periods are newest-first — return an ascending (oldest→newest) copy.
function asc(periods) { return periods && periods.length ? [...periods].reverse() : []; }
const pHigh = (p) => p.high ?? p.max;
const pLow  = (p) => p.low ?? p.min;

// ── Session VWAP ±2SD bands (mirrors backtest-structure.js computeVwapBands) ──
// Anchored daily at UTC midnight; typical price hlc3; band = VWAP ± 2·SD.
// `bars` MUST be ascending (oldest→newest). Returns { v2u, v2d } per bar.
function computeVwapBands(bars) {
  const v2u = new Array(bars.length).fill(null);
  const v2d = new Array(bars.length).fill(null);
  let day = null, tpv = 0, vol = 0, tpv2 = 0;
  for (let i = 0; i < bars.length; i++) {
    const p = bars[i];
    const t = (p.time != null ? p.time : p[0]) * 1000; // tv periods use seconds
    const d = Math.floor(t / 86400000);
    if (d !== day) { day = d; tpv = 0; vol = 0; tpv2 = 0; }
    const tp = (pHigh(p) + pLow(p) + p.close) / 3;
    const v = p.volume || 0;
    tpv += tp * v; vol += v; tpv2 += tp * tp * v;
    if (vol > 0) {
      const vw = tpv / vol;
      const variance = tpv2 / vol - vw * vw;
      const sd = variance > 0 ? Math.sqrt(variance) : 0;
      v2u[i] = vw + 2 * sd;
      v2d[i] = vw - 2 * sd;
    }
  }
  return { v2u, v2d };
}

// Did the confirmed pivot reach the outer band? `ascBars` = ascending 15m OHLCV.
// The indicator confirms a pivot PIVOT_LEN bars after it forms, so the pivot
// bar sits PIVOT_LEN back from the newest bar. Conservative: drop if data thin.
function pivotAtBand(ascBars, direction) {
  if (!VWAP_FILTER) return true;
  const n = ascBars.length;
  const pivIdx = n - 1 - PIVOT_LEN;
  if (pivIdx < 0) return false;
  const bar = ascBars[pivIdx];
  if (!bar) return false;
  const { v2u, v2d } = computeVwapBands(ascBars);
  const lo = v2d[pivIdx], hi = v2u[pivIdx];
  if (lo == null || hi == null) return false;
  return direction === 'LONG' ? pLow(bar) <= lo : pHigh(bar) >= hi;
}

// ── Indicator loader (shared) ────────────────────────────────────
async function loadIndicator() {
  return TradingView.getIndicator(
    SCRIPT_ID, 'last',
    process.env.TV_SESSION || '', process.env.TV_SESSION_SIGN || '',
  );
}

// ── 15m watcher — reads LH/HL, applies VWAP filter, sets bias ─────
async function watch15m(tvTicker) {
  const sym = normSym(tvTicker);
  bLog(`[${sym}][15m] Starting`);

  const client = new TradingView.Client();
  client.onError((...e) => {
    bLog(`[${sym}][15m] TV error — reconnect 30s: ${e.join(' ')}`);
    client.end();
    setTimeout(() => watch15m(tvTicker), 30_000);
  });

  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: '15', range: HISTORY_BARS });

  let ind;
  try   { ind = await loadIndicator(); }
  catch (e) {
    bLog(`[${sym}][15m] Indicator load failed: ${e.message} — retry 60s`);
    client.end();
    setTimeout(() => watch15m(tvTicker), 60_000);
    return;
  }

  const pine        = new chart.Study(ind);
  let   startupDone = false;
  let   debugDumped = false;

  // Set bias only if the VWAP filter passes for this pivot.
  const trySetBias = (direction, label) => {
    if (!pivotAtBand(asc(chart.periods), direction)) {
      bLog(`[${sym}][15m] ${label} ✗ VWAP filter (pivot not at ±2SD band) — bias not set`);
      return;
    }
    biasMap[sym] = { direction, setAt: Date.now() };
    bLog(`[${sym}][15m] ${label} confirmed ✓ VWAP — bias=${direction}`);
  };

  pine.onUpdate(() => {
    try {
      const periods = asc(pine.periods);   // ascending: newest = last
      const n = periods.length;
      if (n < 2) return;
      const latest = periods[n - 1];

      if (!debugDumped) {
        debugDumped = true;
        const vals = Array.from({ length: 27 }, (_, i) => `[${i}]=${latest[i]}`);
        bLog(`[${sym}][15m] PLOT DUMP: ${vals.join(' ')}`);
      }

      // Startup: scan the last BIAS_LOOKBACK closed bars for a recent LH/HL we missed
      if (!startupDone && n >= BIAS_LOOKBACK + 1) {
        startupDone = true;
        for (let i = n - 2; i >= Math.max(0, n - 1 - BIAS_LOOKBACK); i--) {
          const b = periods[i];
          if (!b) continue;
          if (b[IDX.lhRaw] === 1) { trySetBias('SHORT', 'STARTUP LH'); break; }
          if (b[IDX.hlRaw] === 1) { trySetBias('LONG',  'STARTUP HL'); break; }
        }
        if (!biasMap[sym]) bLog(`[${sym}][15m] STARTUP: no qualifying LH/HL in last ${BIAS_LOOKBACK} bars`);
      }

      // Live: set bias on each new LH/HL that clears the VWAP filter
      const lh = latest[IDX.lhRaw] === 1;
      const hl = latest[IDX.hlRaw] === 1;
      if (lh) trySetBias('SHORT', 'LH');
      else if (hl) trySetBias('LONG', 'HL');
    } catch (e) {
      bLog(`[${sym}][15m] error: ${e.message}`);
    }
  });
}

// ── 1m watcher — confirms entry when bias matches ────────────────
async function watch1m(tvTicker) {
  const sym = normSym(tvTicker);
  bLog(`[${sym}][1m] Starting`);

  const client = new TradingView.Client();
  client.onError((...e) => {
    bLog(`[${sym}][1m] TV error — reconnect 30s: ${e.join(' ')}`);
    client.end();
    setTimeout(() => watch1m(tvTicker), 30_000);
  });

  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: '1', range: 500 });

  let ind;
  try   { ind = await loadIndicator(); }
  catch (e) {
    bLog(`[${sym}][1m] Indicator load failed: ${e.message} — retry 60s`);
    client.end();
    setTimeout(() => watch1m(tvTicker), 60_000);
    return;
  }

  const pine = new chart.Study(ind);
  let pending     = null;  // { direction, trigger, setOnBar } — waiting for next confirming candle
  let debugDumped = false;

  pine.onUpdate(() => {
    try {
      const periods      = asc(pine.periods);   // ascending: newest = last
      const pricePeriods = asc(chart.periods);
      const n        = periods.length;
      const barCount = pricePeriods.length;
      if (n < 2 || barCount < 2) return;

      const latest      = periods[n - 1];
      const priceLatest = pricePeriods[barCount - 1];

      if (!debugDumped) {
        debugDumped = true;
        const vals = Array.from({ length: 27 }, (_, i) => `[${i}]=${latest[i]}`);
        bLog(`[${sym}][1m] PLOT DUMP: ${vals.join(' ')}`);
      }

      // ── Resolve pending entry — needs the next bearish/bullish candle ──
      if (pending && barCount > pending.setOnBar) {
        const isBull = priceLatest.close > priceLatest.open;
        const isBear = priceLatest.close < priceLatest.open;
        const ok     = (pending.direction === 'SHORT' && isBear)
                    || (pending.direction === 'LONG'  && isBull);

        if (barCount > pending.setOnBar + 3) {
          bLog(`[${sym}][1m] ${pending.direction} ${pending.trigger} entry expired (no confirmation)`);
          pending = null;
        } else if (ok) {
          const { direction, trigger } = pending;
          pending = null;
          executeTrade(direction, trigger, latest, priceLatest);
          return;
        }
      }

      // ── Check 15m bias ────────────────────────────────────────────
      const b = biasAlive(sym);
      if (!b) return;

      const lh = latest[IDX.lhRaw] === 1;
      const hl = latest[IDX.hlRaw] === 1;
      const hh = latest[IDX.hhRaw] === 1;
      const ll = latest[IDX.llRaw] === 1;

      // Arm a pending entry — fires on the NEXT confirming candle
      if (b.direction === 'SHORT' && (lh || hh)) {
        const trigger = lh ? 'LH' : 'HH';
        bLog(`[${sym}][1m] ${trigger} detected (bias=SHORT) — waiting next bearish candle`);
        pending = { direction: 'SHORT', trigger, setOnBar: barCount };
      } else if (b.direction === 'LONG' && (hl || ll)) {
        const trigger = hl ? 'HL' : 'LL';
        bLog(`[${sym}][1m] ${trigger} detected (bias=LONG) — waiting next bullish candle`);
        pending = { direction: 'LONG', trigger, setOnBar: barCount };
      }

      function executeTrade(direction, trigger, bar, priceBar) {
        if (!canTrade(sym, direction)) {
          bLog(`[${sym}][1m] ${direction} (${trigger}) — cooldown, skip`);
          return;
        }

        const price = priceBar?.close ?? 0;
        if (price <= 0) return;

        const isLong = direction === 'LONG';
        const prob   = bar[isLong ? IDX.probLong : IDX.probShort] ?? 50;
        const smc    = Math.round(bar[isLong ? IDX.smcL : IDX.smcS] ?? 0);
        const liq    = Math.round(bar[isLong ? IDX.liqL : IDX.liqS] ?? 0);
        const ob     = Math.round(bar[isLong ? IDX.obL  : IDX.obS]  ?? 0);
        const wt     = Math.round(bar[isLong ? IDX.wtL  : IDX.wtS]  ?? 0);
        const trail  = Math.round(bar[IDX.trailDir] ?? 0);
        const feats  = { prob, smc, liq, ob, wt, trail: isLong ? trail : -trail };

        // Q-Learning: reward the previous trade (learning telemetry only — no gate)
        const qp = qPending.get(sym);
        if (qp && qp.entryPx > 0) {
          const pnl = qp.direction === 'LONG' ? price - qp.entryPx : qp.entryPx - price;
          qUpdate(qp.key, 1, pnl > 0 ? 1 : -1);
          bLog(`[${sym}][1m] Q-reward: ${qp.direction} ${pnl > 0 ? 'WIN' : 'LOSS'}`);
          qPending.delete(sym);
        }

        markTraded(sym, direction);
        qPending.set(sym, { key: stateKey(feats), direction, entryPx: price });

        bLog(`[${sym}][1m] *** TRADE ${direction} | trigger=${trigger} | price=${price} | prob=${prob}% | bias=${biasMap[sym]?.direction} ***`);

        injectTVSignal({
          symbol:             sym,
          side:               isLong ? 'BUY' : 'SELL',
          direction,
          price,
          zone:               'SMC_PRO',
          pivot:              trigger,
          setup:              'SMC_PRO_SUITE',
          setupName:          `${trigger} (1m entry, 15m bias)`,
          score:              prob,
          signalType:         `SMC-MTF-${direction}`,
          source:             'smc-suite-watcher',
          timeframe:          '1',
          isMomentumBreakout: true,
          override:           true,
          receivedAt:         Date.now(),
          tradeSizePct:       TRADE_SIZE_PCT,
          slPct:              SL_PCT,
          tpPct:              TP_PCT,
          aiFeatures:         { prob, smc, liq, ob, wt, trail, qEpsilon: parseFloat(EPSILON.toFixed(4)) },
        });
      }
    } catch (e) {
      bLog(`[${sym}][1m] error: ${e.message}`);
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────
async function start() {
  bLog('Starting MTF watcher (15m bias → 1m entry) — VWAP ±2SD filter ' + (VWAP_FILTER ? 'ON' : 'OFF'));
  bLog(`Plot indices: lhRaw=${IDX.lhRaw} hlRaw=${IDX.hlRaw} hhRaw=${IDX.hhRaw} llRaw=${IDX.llRaw}`);

  for (const sym of SYMBOLS) {
    watch15m(sym).catch(e => bLog(`[15m fatal] ${sym}: ${e.message}`));
    await new Promise(r => setTimeout(r, 2000));
    watch1m(sym).catch(e => bLog(`[1m fatal] ${sym}: ${e.message}`));
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (require.main === module) start().catch(console.error);
module.exports = { start };
