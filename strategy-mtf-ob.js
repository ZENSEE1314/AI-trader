'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  strategy-mtf-ob.js — top-down MTF strategy (backtest-validated chain)
//
//    4h / 1d OB   = the ZONE (where)        — biggest edge (OB @ ≥4h backtests best)
//    15m HL / LH  = the TRIGGER (when)       — 64% WR in-zone (backtest-eth-mtf.js)
//    3m CHoCH     = the ENTRY (exact fill)   — mtf-entry.refineEntry, tight stop
//
//  A long fires when a 15m HL prints inside a bullish (demand) 4h/1d OB and the
//  entry-TF (default 3m) confirms with a CHoCH; short mirrors with a 15m LH in a
//  bearish (supply) OB. TP = the opposite liquidity. SL = the entry-TF swing.
//
//  OFF by default — cycle.js only scans this when MTF_OB_ENABLED=1. Env:
//    MTF_OB_ENABLED=1            master switch (default off)
//    MTF_OB_SYMBOLS=ETHUSDT      symbols to scan (default ETHUSDT — where it backtests best)
//    MTF_OB_PROFILE=pullback     pullback (HL/LH) | breakout (HH/LL) | any
//    MTF_OB_PIVOT_MAXAGE=8       max 15m bars since the pivot confirmed (freshness)
//    ENTRY_TF=3                  entry timeframe for the CHoCH (mtf-entry.js)
// ════════════════════════════════════════════════════════════════════════════

const LBL_15 = 10, LBR_15 = 1;
const OB_TOL = (Number(process.env.MTF_OB_TOL_PCT || 0.2) || 0.2) / 100;
const MAX_TP_DIST = (Number(process.env.MTF_OB_MAX_TP_PCT || 6) || 6) / 100;
const MIN_RR = Number(process.env.MTF_OB_MIN_RR || 0.5) || 0.5;

// Bullish structure labels → LONG (need a demand OB); bearish → SHORT (supply OB).
const BULL = new Set(['HL', 'HH']), BEAR = new Set(['LH', 'LL']);
// Which labels a profile trades: pullback = HL/LH, breakout = HH/LL, any = all.
const profileLabels = p => p === 'breakout' ? ['HH', 'LL'] : p === 'any' ? ['HL', 'HH', 'LH', 'LL'] : ['HL', 'LH'];

function labelPivots(pivots) {
  let ph = null, pl = null; const out = [];
  for (const p of pivots) {
    if (p.type === 'HIGH') { out.push({ ...p, label: ph == null ? null : (p.price > ph ? 'HH' : 'LH') }); ph = p.price; }
    else { out.push({ ...p, label: pl == null ? null : (p.price > pl ? 'HL' : 'LL') }); pl = p.price; }
  }
  return out;
}

const inOB = (obs, price, kind) => (obs || []).find(o =>
  o.kind === kind && price >= o.bottom * (1 - OB_TOL) && price <= o.top * (1 + OB_TOL)) || null;

// ── Pure decision: given the latest labeled 15m pivot, current price, HTF OBs and
// the profile, is there an in-zone candidate? Returns {direction, label, ob} | null.
// No I/O — unit-testable (see --selftest).
function mtfCandidate({ lastPivot, price, obs, profile = 'pullback' }) {
  if (!lastPivot || !lastPivot.label) return null;
  const lbl = lastPivot.label;
  if (!profileLabels(profile).includes(lbl)) return null;
  if (BULL.has(lbl)) { const ob = inOB(obs, price, 'BULLISH'); if (ob) return { direction: 'LONG', label: lbl, ob }; }
  if (BEAR.has(lbl)) { const ob = inOB(obs, price, 'BEARISH'); if (ob) return { direction: 'SHORT', label: lbl, ob }; }
  return null;
}

// ── Live scan → array of picks (cycle.js pushes these into `signals`).
async function scanMtfOb(log = () => {}) {
  const smc = require('./smc-engine');
  const { classifyOBs } = require('./ob-touch');
  const { refineEntry } = require('./mtf-entry');
  const profile = (process.env.MTF_OB_PROFILE || 'pullback').toLowerCase();
  const maxAge = Math.max(1, parseInt(process.env.MTF_OB_PIVOT_MAXAGE || '8', 10) || 8);
  const syms = (process.env.MTF_OB_SYMBOLS || 'ETHUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const picks = [];

  for (const symbol of syms) {
    try {
      const [c15, c4h, c1d] = await Promise.all([
        smc.fetchCandles(symbol, '15', 200),
        smc.fetchCandles(symbol, '240', 300),
        smc.fetchCandles(symbol, 'D', 300),
      ]);
      if (!c15 || c15.length < 60) continue;

      const piv = smc.detectPivots(c15, LBL_15, LBR_15);
      const labeled = labelPivots(piv);
      const lastPivot = labeled[labeled.length - 1];
      if (!lastPivot) continue;
      // freshness: pivot must have confirmed within maxAge bars of the latest closed bar
      if ((c15.length - 1) - (lastPivot.idx + LBR_15) > maxAge) continue;

      const price = c15[c15.length - 1].c;
      const obs = [
        ...classifyOBs(smc.detectOrderBlocks(c4h, smc.analyzeStructure(c4h, 10, 3).pivots), '4h'),
        ...classifyOBs(smc.detectOrderBlocks(c1d, smc.analyzeStructure(c1d, 10, 3).pivots), '1d'),
      ];
      const cand = mtfCandidate({ lastPivot, price, obs, profile });
      if (!cand) continue;

      // entry-TF (3m) confirmation + tight stop
      const trig = await refineEntry({ symbol, direction: cand.direction });
      if (!trig.triggered) { log(`[MTF-OB] ${symbol} ${cand.direction} in ${cand.ob.tf} OB — waiting for ${trig.tf}m CHoCH`); continue; }

      // TP = opposite liquidity
      const upto = piv.filter(p => p.idx <= lastPivot.idx);
      const pools = smc.detectLiquidityPools(c15, upto) || [];
      const highs = piv.filter(p => p.type === 'HIGH'), lows = piv.filter(p => p.type === 'LOW');
      const e = trig.entry, dir = cand.direction === 'LONG' ? 1 : -1;
      const tgts = dir > 0
        ? [...pools.filter(p => p.label === 'EQH' && p.level > e).map(p => p.level), ...highs.filter(h => h.price > e).map(h => h.price)]
        : [...pools.filter(p => p.label === 'EQL' && p.level < e).map(p => p.level), ...lows.filter(l => l.price < e).map(l => l.price)];
      if (!tgts.length) continue;
      const tp = dir > 0 ? Math.min(...tgts) : Math.max(...tgts);
      const risk = Math.abs(e - trig.stop), reward = Math.abs(tp - e);
      const dist = dir > 0 ? (tp - e) / e : (e - tp) / e;
      if (risk <= 0 || dist > MAX_TP_DIST || reward / risk < MIN_RR) continue;

      picks.push({
        symbol, sym: symbol, direction: cand.direction,
        price: e, sl: trig.stop, tp1: tp,
        setupName: `MTF_OB_${profile}`, type: `${cand.ob.tf}OB+15m${cand.label}+${trig.tf}m`,
        score: 70, source: 'mtf-ob',
      });
      log(`[MTF-OB] ${symbol} ${cand.direction} @ ${e} — ${cand.ob.tf} OB + 15m ${cand.label} + ${trig.tf}m CHoCH | SL ${trig.stop.toFixed(4)} TP ${tp.toFixed(4)} (RR ${(reward / risk).toFixed(2)})`);
    } catch (e) {
      log(`[MTF-OB] ${symbol} scan error: ${e.message}`);
    }
  }
  return picks;
}

module.exports = { scanMtfOb, mtfCandidate, labelPivots };

// ── Offline self-test of the pure candidate logic ──
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const chk = (n, got, want) => { const ok = got === want; console.log(`  ${ok ? '✓' : '✗'} ${n}: ${got} (want ${want})`); ok ? pass++ : fail++; };
  const bullOB = [{ kind: 'BULLISH', bottom: 99, top: 101, tf: '4h' }];
  const bearOB = [{ kind: 'BEARISH', bottom: 109, top: 111, tf: '1d' }];
  // 15m HL inside a bullish OB → LONG (pullback)
  chk('HL in bull OB → LONG', mtfCandidate({ lastPivot: { type: 'LOW', label: 'HL', price: 100 }, price: 100, obs: bullOB, profile: 'pullback' })?.direction, 'LONG');
  // 15m LH inside a bearish OB → SHORT
  chk('LH in bear OB → SHORT', mtfCandidate({ lastPivot: { type: 'HIGH', label: 'LH', price: 110 }, price: 110, obs: bearOB, profile: 'pullback' })?.direction, 'SHORT');
  // HL but price NOT in any OB → null
  chk('HL out of OB → null', mtfCandidate({ lastPivot: { type: 'LOW', label: 'HL', price: 105 }, price: 105, obs: bullOB, profile: 'pullback' }), null);
  // LL with pullback profile (trades HL/LH only) → null
  chk('LL under pullback → null', mtfCandidate({ lastPivot: { type: 'LOW', label: 'LL', price: 100 }, price: 100, obs: bullOB, profile: 'pullback' }), null);
  // LL (bearish) with breakout profile, price in a BEARISH OB → SHORT
  chk('LL breakout in bear OB → SHORT', mtfCandidate({ lastPivot: { type: 'LOW', label: 'LL', price: 110 }, price: 110, obs: bearOB, profile: 'breakout' })?.direction, 'SHORT');
  // HH (bullish) with breakout profile, price in a BULLISH OB → LONG
  chk('HH breakout in bull OB → LONG', mtfCandidate({ lastPivot: { type: 'HIGH', label: 'HH', price: 100 }, price: 100, obs: bullOB, profile: 'breakout' })?.direction, 'LONG');
  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
