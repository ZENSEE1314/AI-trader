// Sweep-reversal backtest — "the HH/LL taps an OB, sweeps the orders, then reverses."
//
// The entry (owner's model): price runs to a swing extreme that (1) TAKES OUT prior
// liquidity (breaks a previous swing low/high or EQL/EQH), (2) sits at/near an ORDER
// BLOCK, then (3) REVERSES — price closes back through the swept level. That reversal
// off the swept OB is the entry; the stops it just grabbed become the stop-loss.
//
//   LL sweep → LONG : low breaks a prior swing low, at a bullish OB, then closes back
//                     above the swept low. SL below the sweep low; TP = nearest EQH/high.
//   HH sweep → SHORT: mirror (bearish OB; TP = nearest EQL/low).
//
// Fewer, higher-quality trades than flipping every pivot. Reuses smc-engine
// detectPivots / detectOrderBlocks / detectLiquidityPools. Runs on static-klines
// (sandbox-safe) with Bybit fallback.
//
//   SYMBOL=ETHUSDT WEEKS_15M=30 node backtest-sweep-reversal.js
//   REQUIRE_OB=0 node backtest-sweep-reversal.js          # ablate the OB condition
//   node backtest-sweep-reversal.js --selftest

const SYMBOL   = (process.env.SYMBOL || 'ETHUSDT').toUpperCase();
const WEEKS    = Math.max(4, parseInt(process.env.WEEKS_15M || '30', 10) || 30);
const LBL = 10, LBR = 1;
const REQUIRE_OB   = process.env.REQUIRE_OB !== '0';
const OB_TOL       = (Number(process.env.SWEEP_OB_TOL_PCT || 0.3) || 0.3) / 100;   // "near" the OB
const CONFIRM_BARS = Math.max(1, parseInt(process.env.SWEEP_CONFIRM_BARS || '12', 10) || 12);
const MAX_TP_DIST  = (Number(process.env.SWEEP_MAX_TP_PCT || 6) || 6) / 100;
const SL_BUF       = (Number(process.env.SWEEP_SL_BUF_PCT || 0.1) || 0.1) / 100;
const MIN_RR       = Number(process.env.SWEEP_MIN_RR || 0.5) || 0.5;
const FEE          = (Number(process.env.FEE_PCT || 0.08) || 0.08) / 100;          // round-trip
const EXIT_MODE    = (process.env.EXIT_MODE || 'fixed').toLowerCase();              // 'fixed' | 'trail'
const rS = n => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2) + 'R';

// Outcome in R for a bracket. dir +1 long / -1 short. SL conservative on ties.
function outcome(dir, entry, sl, tp, future) {
  const risk = Math.abs(entry - sl);
  for (const b of future) {
    if (dir > 0) { if (b.l <= sl) return -1; if (b.h >= tp) return (tp - entry) / risk; }
    else         { if (b.h >= sl) return -1; if (b.l <= tp) return (entry - tp) / risk; }
  }
  const last = future.length ? future[future.length - 1].c : entry;
  return (dir > 0 ? last - entry : entry - last) / risk;
}

async function run() {
  const smc = require('./smc-engine');
  const { classifyOBs, normalize } = require('./ob-touch');
  let cs;
  try {
    if (process.env.KLINES_SOURCE === 'static') throw new Error('forced static');
    cs = (await smc.fetchCandles(SYMBOL, '15', 1000)).map(normalize);
  } catch {
    cs = (await require('./klines-static').loadStatic(SYMBOL, '15m', WEEKS)).map(normalize);
  }
  if (!cs || cs.length < 200) { console.error('Not enough data.'); process.exitCode = 1; return; }
  const spanDays = (cs[cs.length - 1].t - cs[0].t) / 864e5;

  const pivots = smc.detectPivots(cs, LBL, LBR);
  const highs = pivots.filter(p => p.type === 'HIGH');
  const lows  = pivots.filter(p => p.type === 'LOW');

  // OBs / liquidity as-of a bar index (cheap: only computed at candidate pivots).
  const ctxAt = (i) => {
    const upto = pivots.filter(p => p.idx <= i);
    const obs = classifyOBs(smc.detectOrderBlocks(cs.slice(0, i + 1), upto));
    const pools = smc.detectLiquidityPools(cs.slice(0, i + 1), upto) || [];
    return { upto, obs, pools };
  };
  const nearOB = (obs, price, kind) => obs.some(o =>
    o.kind === kind && price >= o.bottom * (1 - OB_TOL) && price <= o.top * (1 + OB_TOL));

  // 'trail' exit: ride to the next opposite pivot (the swing target), SL still active.
  const trailLong = (e, sl, ci, pivIdx) => {
    const nh = highs.find(h => h.idx > pivIdx);
    const eb = nh ? Math.min(cs.length - 1, nh.idx + LBR) : cs.length - 1;
    const risk = e - sl;
    for (let j = ci + 1; j <= eb; j++) if (cs[j].l <= sl) return -1;
    return (cs[eb].c - e) / risk;
  };
  const trailShort = (e, sl, ci, pivIdx) => {
    const nl = lows.find(l => l.idx > pivIdx);
    const eb = nl ? Math.min(cs.length - 1, nl.idx + LBR) : cs.length - 1;
    const risk = sl - e;
    for (let j = ci + 1; j <= eb; j++) if (cs[j].h >= sl) return -1;
    return (e - cs[eb].c) / risk;
  };

  const trades = [];

  // LL sweeps → LONG
  for (let k = 1; k < lows.length; k++) {
    const L = lows[k], Lprev = lows[k - 1];
    if (L.price >= Lprev.price) continue;                 // must break the prior low (sweep)
    const i = L.idx;
    const { obs, pools } = ctxAt(i);
    if (REQUIRE_OB && !nearOB(obs, L.price, 'BULLISH')) continue;
    // reversal confirm: close back above the swept prior low within CONFIRM_BARS
    let ci = -1;
    for (let j = i + LBR; j <= Math.min(cs.length - 1, i + LBR + CONFIRM_BARS); j++)
      if (cs[j].c > Lprev.price) { ci = j; break; }
    if (ci < 0) continue;
    const e = cs[ci].c, sl = L.price * (1 - SL_BUF);
    const risk = e - sl;
    if (risk <= 0) continue;
    if (EXIT_MODE === 'trail') { trades.push({ dir: 1, r: trailLong(e, sl, ci, i) }); continue; }
    const hiTargets = [
      ...pools.filter(p => p.label === 'EQH' && p.level > e).map(p => p.level),
      ...highs.filter(h => h.idx <= i && h.price > e).map(h => h.price),
    ];
    if (!hiTargets.length) continue;
    const tp = Math.min(...hiTargets);
    if ((tp - e) / e > MAX_TP_DIST) continue;
    if ((tp - e) / risk < MIN_RR) continue;
    trades.push({ dir: 1, r: outcome(1, e, sl, tp, cs.slice(ci + 1)) });
  }

  // HH sweeps → SHORT
  for (let k = 1; k < highs.length; k++) {
    const H = highs[k], Hprev = highs[k - 1];
    if (H.price <= Hprev.price) continue;
    const i = H.idx;
    const { obs, pools } = ctxAt(i);
    if (REQUIRE_OB && !nearOB(obs, H.price, 'BEARISH')) continue;
    let ci = -1;
    for (let j = i + LBR; j <= Math.min(cs.length - 1, i + LBR + CONFIRM_BARS); j++)
      if (cs[j].c < Hprev.price) { ci = j; break; }
    if (ci < 0) continue;
    const e = cs[ci].c, sl = H.price * (1 + SL_BUF);
    const risk = sl - e;
    if (risk <= 0) continue;
    if (EXIT_MODE === 'trail') { trades.push({ dir: -1, r: trailShort(e, sl, ci, i) }); continue; }
    const loTargets = [
      ...pools.filter(p => p.label === 'EQL' && p.level < e).map(p => p.level),
      ...lows.filter(l => l.idx <= i && l.price < e).map(l => l.price),
    ];
    if (!loTargets.length) continue;
    const tp = Math.max(...loTargets);
    if ((e - tp) / e > MAX_TP_DIST) continue;
    if ((e - tp) / risk < MIN_RR) continue;
    trades.push({ dir: -1, r: outcome(-1, e, sl, tp, cs.slice(ci + 1)) });
  }

  const n = trades.length;
  if (!n) { console.log(`${SYMBOL}: no sweep-reversal setups in window.`); return; }
  const wins = trades.filter(t => t.r > 0).length;
  const net = trades.reduce((s, t) => s + t.r, 0);
  console.log(`══════════ Sweep-reversal — ${SYMBOL} ══════════`);
  console.log(`Window ~${spanDays.toFixed(0)}d | OB required: ${REQUIRE_OB} | confirm ≤ ${CONFIRM_BARS} bars | min RR ${MIN_RR}`);
  console.log(`Trades: ${n}  (${(n / spanDays).toFixed(2)}/day)  | WR ${(wins / n * 100).toFixed(1)}%  | avg ${rS(net / n)}  | net ${rS(net)}`);
  console.log(`Longs ${trades.filter(t => t.dir > 0).length} / Shorts ${trades.filter(t => t.dir < 0).length}`);
  console.log('\nModel: swing extreme breaks prior liquidity AT an OB, then closes back through');
  console.log('the swept level → enter the reversal, SL beyond the sweep, TP at opposite liquidity.');
}

function selftest() {
  let pass = 0, fail = 0;
  const chk = (n, got, want) => { const ok = Math.abs(got - want) < 1e-9; console.log(`  ${ok ? '✓' : '✗'} ${n}: ${got.toFixed(3)} (want ${want})`); ok ? pass++ : fail++; };
  chk('long TP +2R', outcome(1, 100, 99, 102, [{ h: 102, l: 100, c: 102 }]), 2);
  chk('long SL -1R', outcome(1, 100, 99, 102, [{ h: 100.5, l: 98.5, c: 98.5 }]), -1);
  chk('short TP +2R', outcome(-1, 100, 101, 98, [{ h: 100, l: 98, c: 98 }]), 2);
  console.log(`\nself-test: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
}

if (process.argv.includes('--selftest')) selftest();
else run().catch(e => { console.error(`failed: ${e.message}`); process.exitCode = 1; });
