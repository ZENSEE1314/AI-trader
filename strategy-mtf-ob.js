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
//  The 'climax' profile is the owner's VSA method: an extreme TAPS an OB and prints
//  a volume climax (big orders) → fade it to the opposite OB. Direction comes from
//  the OB (a climax HH into supply = SHORT), and a ≥3× volume climax is required —
//  backtest: 78% WR at ≥3× vs 58% for all OB taps (a blanket VSA gate hurt; the
//  climax AT the OB is what works).
//
//  OFF by default — cycle.js only scans this when MTF_OB_ENABLED=1. Env:
//    MTF_OB_ENABLED=1            master switch (default off)
//    MTF_OB_SYMBOLS=ETHUSDT      symbols to scan (default ETHUSDT — where it backtests best)
//    MTF_OB_PROFILE=climax       climax (owner's VSA fade) | pullback (HL/LH) | breakout (HH/LL) | any
//    MTF_OB_CLIMAX_MIN=3         pivot-bar volume ≥ N× its 20-bar avg (default 3 for climax, else off)
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

// HTF short-gate (owner rule): when 4h AND 1h are BOTH bullish (HH/HL), only shorts
// are allowed — block longs. Any other HTF state imposes no restriction. Pure/testable.
function htfShortGateAllows(dir, bias4h, bias1h) {
  const bothBull = bias4h === 'BULLISH' && bias1h === 'BULLISH';
  if (bothBull && String(dir || '').toUpperCase() === 'LONG') return false;
  return true;
}

// ── Pure decision: given the latest labeled 15m pivot, current price, HTF OBs and
// the profile, is there an in-zone candidate? Returns {direction, label, ob} | null.
// No I/O — unit-testable (see --selftest).
function mtfCandidate({ lastPivot, price, obs, profile = 'pullback', climaxRatio = null, climaxMin = 0 }) {
  if (!lastPivot || !lastPivot.label) return null;
  // VSA climax gate: when configured, the pivot bar must be a volume climax
  // (big orders). Backtest: ≥3× avg at an OB → ~78% WR (owner's method).
  if (climaxMin > 0 && (climaxRatio == null || climaxRatio < climaxMin)) return null;

  // 'climax' profile — the owner's fade: an extreme that TAPS an OB and prints a
  // climax reverses to the opposite OB. Direction comes from the OB, not the label:
  // a HIGH into a supply OB → SHORT; a LOW into a demand OB → LONG (so a climax HH
  // into supply is a short, which the label-based profiles would never take).
  if (profile === 'climax') {
    if (lastPivot.type === 'HIGH') { const ob = inOB(obs, price, 'BEARISH'); if (ob) return { direction: 'SHORT', label: lastPivot.label, ob }; }
    if (lastPivot.type === 'LOW')  { const ob = inOB(obs, price, 'BULLISH'); if (ob) return { direction: 'LONG',  label: lastPivot.label, ob }; }
    return null;
  }

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
  // VSA climax: require the pivot bar to be ≥ this × its 20-bar avg volume.
  // Default 3.0 for the 'climax' profile (backtest ~78% WR), off otherwise.
  const climaxMin = Number(process.env.MTF_OB_CLIMAX_MIN ?? (profile === 'climax' ? 3.0 : 0)) || 0;
  const CLIMAX_N = 20;
  const syms = (process.env.MTF_OB_SYMBOLS || 'ETHUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const picks = [];

  for (const symbol of syms) {
    try {
      const [c15, c1h, c4h, c1d] = await Promise.all([
        smc.fetchCandles(symbol, '15', 200),
        smc.fetchCandles(symbol, '60', 300),
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
      // VSA climax ratio on the pivot bar (big orders).
      let vv = 0, kk = 0; for (let j = lastPivot.idx - 1; j >= 0 && kk < CLIMAX_N; j--, kk++) vv += c15[j].v;
      const cavg = kk ? vv / kk : 0;
      const climaxRatio = cavg ? c15[lastPivot.idx].v / cavg : 0;

      const cand = mtfCandidate({ lastPivot, price, obs, profile, climaxRatio, climaxMin });
      if (!cand) continue;

      // HTF short-gate: 4h AND 1h both bullish (HH/HL) → shorts only, block longs.
      if (process.env.MTF_OB_HTF_SHORTGATE !== '0') {
        const bias4h = (c4h && c4h.length >= 40) ? smc.analyzeStructure(c4h, 10, 3).bias : 'RANGING';
        const bias1h = (c1h && c1h.length >= 40) ? smc.analyzeStructure(c1h, 10, 3).bias : 'RANGING';
        if (!htfShortGateAllows(cand.direction, bias4h, bias1h)) {
          log(`[MTF-OB] ${symbol} ${cand.direction} blocked — 4h(${bias4h})+1h(${bias1h}) bullish = shorts only`);
          continue;
        }
      }

      // entry-TF (3m) confirmation + tight stop
      const trig = await refineEntry({ symbol, direction: cand.direction });
      if (!trig.triggered) { log(`[MTF-OB] ${symbol} ${cand.direction} in ${cand.ob.tf} OB — waiting for ${trig.tf}m CHoCH`); continue; }

      // TP = the opposite OB ("eat the green OB"), else opposite liquidity.
      const upto = piv.filter(p => p.idx <= lastPivot.idx);
      const pools = smc.detectLiquidityPools(c15, upto) || [];
      const highs = piv.filter(p => p.type === 'HIGH'), lows = piv.filter(p => p.type === 'LOW');
      const e = trig.entry, dir = cand.direction === 'LONG' ? 1 : -1;
      const tgts = dir > 0
        ? [...obs.filter(o => o.kind === 'BEARISH' && o.bottom > e).map(o => o.bottom),
           ...pools.filter(p => p.label === 'EQH' && p.level > e).map(p => p.level), ...highs.filter(h => h.price > e).map(h => h.price)]
        : [...obs.filter(o => o.kind === 'BULLISH' && o.top < e).map(o => o.top),
           ...pools.filter(p => p.label === 'EQL' && p.level < e).map(p => p.level), ...lows.filter(l => l.price < e).map(l => l.price)];
      if (!tgts.length) continue;
      const tp = dir > 0 ? Math.min(...tgts) : Math.max(...tgts);
      const risk = Math.abs(e - trig.stop), reward = Math.abs(tp - e);
      const dist = dir > 0 ? (tp - e) / e : (e - tp) / e;
      if (risk <= 0 || dist > MAX_TP_DIST || reward / risk < MIN_RR) continue;

      picks.push({
        symbol, sym: symbol, direction: cand.direction,
        price: e, sl: trig.stop, tp1: tp,
        leverage: Number(process.env.MTF_OB_LEVERAGE || 25) || 25,   // low by default — tight 3m stop
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

module.exports = { scanMtfOb, mtfCandidate, labelPivots, htfShortGateAllows };

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
  // ── climax profile (owner's method): direction from the OB, not the label ──
  // A climax HH into a SUPPLY OB → SHORT (label-based profiles would call it LONG).
  chk('climax HH in bear OB → SHORT', mtfCandidate({ lastPivot: { type: 'HIGH', label: 'HH', price: 110 }, price: 110, obs: bearOB, profile: 'climax', climaxRatio: 3.5, climaxMin: 3.0 })?.direction, 'SHORT');
  // A climax LOW into a DEMAND OB → LONG.
  chk('climax LOW in bull OB → LONG', mtfCandidate({ lastPivot: { type: 'LOW', label: 'LL', price: 100 }, price: 100, obs: bullOB, profile: 'climax', climaxRatio: 4.0, climaxMin: 3.0 })?.direction, 'LONG');
  // No climax (2.0 < 3.0 min) → blocked even at the OB.
  chk('no climax → blocked', mtfCandidate({ lastPivot: { type: 'HIGH', label: 'HH', price: 110 }, price: 110, obs: bearOB, profile: 'climax', climaxRatio: 2.0, climaxMin: 3.0 }), null);
  // ── HTF short-gate: 4h+1h both bullish → shorts only ──
  chk('long blocked when 4h+1h bullish', htfShortGateAllows('LONG', 'BULLISH', 'BULLISH'), false);
  chk('short allowed when 4h+1h bullish', htfShortGateAllows('SHORT', 'BULLISH', 'BULLISH'), true);
  chk('long allowed when only 4h bullish', htfShortGateAllows('LONG', 'BULLISH', 'RANGING'), true);
  chk('long allowed when both bearish', htfShortGateAllows('LONG', 'BEARISH', 'BEARISH'), true);
  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
