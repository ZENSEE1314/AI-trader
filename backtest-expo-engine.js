'use strict';
/**
 * Configurable Expo backtest engine — powers the homepage "live backtest".
 * User sets: tokens, leverage, SL %margin, TP %margin, days. Uses the SAME
 * SMC Expo HL/LH structure as the live bot (cached labels in data/expo-labels,
 * refreshed in the background), plus the 1m swing-pullback entry.
 *
 * Reuses backtest-structure.runOne (baseline hard SL/TP exit) so the homepage
 * number reflects the strategy's raw edge for the chosen risk settings.
 *
 *   const { runExpoBacktest } = require('./backtest-expo-engine');
 *   await runExpoBacktest({ tokens:['BTCUSDT'], leverage:20, slMargin:0.50, tpMargin:0.35, days:7 });
 */
const fs = require('fs');
const path = require('path');
const bt = require('./backtest-structure.js');                       // runOne, fetchKlines
const { biasArrayFromWindows } = require('./strategy-structure-htf-ltf');

const BAR_MS = 15 * 60 * 1000;
const LAG_BARS = 10, WINDOW_BARS = 8;       // Expo label confirm-lag + entry window (match live)
const LABELS_DIR = path.join(__dirname, 'data', 'expo-labels');

const SUPPORTED = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const LIMITS = { daysMin: 1, daysMax: 30, levMin: 1, levMax: 125, marginMin: 0.05, marginMax: 2.0 };

// ── 1m kline cache (per symbol) — avoids re-fetching on every param tweak ──
const _klineCache = new Map();              // sym → { days, c1, ts }
const KLINE_TTL_MS = 5 * 60 * 1000;

async function get1m(sym, days) {
  const hit = _klineCache.get(sym);
  if (hit && hit.days >= days && Date.now() - hit.ts < KLINE_TTL_MS) {
    const cutoff = Date.now() - days * 86400000;
    return hit.c1.filter(c => c.time >= cutoff);
  }
  const c1 = await bt.fetchKlines(sym, '1m', days);
  _klineCache.set(sym, { days, c1, ts: Date.now() });
  return c1;
}

// Expo HL/LH labels → bias windows (HL=long, LH=short), active LAG..LAG+WINDOW bars after the label.
function biasWindowsFromExpo(labels) {
  const w = [];
  for (const l of labels) {
    if (l.type !== 'HL' && l.type !== 'LH') continue;
    const from = l.time + LAG_BARS * BAR_MS;
    w.push({ bias: l.type === 'HL' ? 'long' : 'short', from, to: from + WINDOW_BARS * BAR_MS });
  }
  return w.sort((a, b) => a.from - b.from);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function validate(opts) {
  const tokens = (Array.isArray(opts.tokens) ? opts.tokens : String(opts.tokens || '').split(','))
    .map(t => String(t).toUpperCase().trim())
    .map(t => (t.endsWith('USDT') ? t : t + 'USDT'))
    .filter(t => SUPPORTED.includes(t));
  if (!tokens.length) throw new Error(`No supported tokens. Choose from: ${SUPPORTED.join(', ')}`);
  const leverage = clamp(Math.round(Number(opts.leverage) || 20), LIMITS.levMin, LIMITS.levMax);
  const days     = clamp(Math.round(Number(opts.days) || 7), LIMITS.daysMin, LIMITS.daysMax);
  // Accept SL/TP as %margin (e.g. 50 → 0.50) or fraction (0.50). >2 means it was given as a percent.
  const norm = (v, def) => { let n = Number(v); if (!isFinite(n) || n <= 0) n = def; if (n > 2) n /= 100; return clamp(n, LIMITS.marginMin, LIMITS.marginMax); };
  const slMargin = norm(opts.slMargin ?? opts.sl, 0.50);
  const tpMargin = norm(opts.tpMargin ?? opts.tp, 0.35);
  return { tokens, leverage, days, slMargin, tpMargin };
}

async function runExpoBacktest(rawOpts = {}) {
  const { tokens, leverage, days, slMargin, tpMargin } = validate(rawOpts);
  const cutoff = Date.now() - days * 86400000;
  const perToken = [];
  let pooled = [];

  for (const sym of tokens) {
    const file = path.join(LABELS_DIR, `${sym}-15m-expo.json`);
    if (!fs.existsSync(file)) { perToken.push({ symbol: sym, error: 'no Expo data yet' }); continue; }
    let labels;
    try { labels = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { perToken.push({ symbol: sym, error: 'bad data' }); continue; }
    labels = labels.filter(l => l.time >= cutoff);

    let c1;
    try { c1 = await get1m(sym, days); } catch (e) { perToken.push({ symbol: sym, error: `klines: ${e.message}` }); continue; }

    const windows = biasWindowsFromExpo(labels);
    const biasArr = biasArrayFromWindows(c1, windows);
    const slPct = Math.min(slMargin / leverage, (1 / leverage) * 0.80);  // liq guard (matches live)
    const r = bt.runOne(c1, biasArr, { lev: leverage, slPct, tpPct: tpMargin / leverage });
    pooled = pooled.concat(r.tradeList || []);
    perToken.push({
      symbol: sym,
      trades: r.trades,
      winRate: round(r.winRate),
      profitFactor: Number.isFinite(r.profitFactor) ? round(r.profitFactor, 2) : null,
      totalReturnPct: round(r.totalReturnPct),
      maxDDPct: round(r.maxDDPct),
      liquidations: r.liquidations,
      biasWindows: windows.length,
    });
  }

  const n = pooled.length;
  const wins = pooled.filter(t => t.exit === 'TP').length;
  const gw = pooled.filter(t => t.rOM > 0).reduce((s, t) => s + t.rOM, 0);
  const gl = -pooled.filter(t => t.rOM < 0).reduce((s, t) => s + t.rOM, 0);
  const aggregate = {
    trades: n,
    winRate: n ? round(wins / n * 100) : 0,
    profitFactor: gl > 0 ? round(gw / gl, 2) : (gw > 0 ? null : 0),
    totalReturnPct: round(pooled.reduce((s, t) => s + t.rOM, 0) * 100),
    liquidations: pooled.filter(t => t.exit === 'LIQ').length,
  };

  return {
    params: { tokens, leverage, slMarginPct: round(slMargin * 100), tpMarginPct: round(tpMargin * 100), days },
    perToken,
    aggregate,
    note: 'Past data only. Baseline hard SL/TP — the live bot adds a 50% TP1 close + trailing. Not financial advice.',
  };
}

function round(n, d = 1) { return n == null || !isFinite(n) ? n : Number(n.toFixed(d)); }

module.exports = { runExpoBacktest, SUPPORTED, LIMITS };
