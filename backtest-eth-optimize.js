// ETH-only optimizer — HH/LL sweep entries, toggling VWAP / OB / VSA filters and
// the exit, to find the best combination for capturing the reversal.
//
// Base setup: a swing extreme that BREAKS prior liquidity (LL < prior low / HH >
// prior high) and then price closes back through the swept level = the reversal.
// On top of that, three independent confirmations (each on/off) and two exits:
//
//   VWAP — the extreme is on the right side of daily VWAP (LL below / HH above:
//          a discount/premium sweep, not mid-range).
//   OB   — the extreme taps an order block (bullish OB for LL, bearish for HH).
//   VSA  — Volume-Spread-Analysis stopping volume at the extreme: high volume AND
//          the bar closes rejecting the extreme (close in the far half of its range).
//   exit — fixed (TP at opposite liquidity) | trail (ride to next opposite swing).
//
// Heavy context is computed ONCE per candidate; the 2³×2 combinations are then
// scored cheaply and ranked by expectancy (avg R).
//
//   node backtest-eth-optimize.js            # ETH, ~30 weeks static-klines
//   SYMBOL=ETHUSDT WEEKS_15M=30 VOL_MULT=1.5 node backtest-eth-optimize.js

const SYMBOL = (process.env.SYMBOL || 'ETHUSDT').toUpperCase();
const WEEKS  = Math.max(4, parseInt(process.env.WEEKS_15M || '30', 10) || 30);
const LBL = 10, LBR = 1;
const OB_TOL       = (Number(process.env.SWEEP_OB_TOL_PCT || 0.3) || 0.3) / 100;
const CONFIRM_BARS = Math.max(1, parseInt(process.env.SWEEP_CONFIRM_BARS || '12', 10) || 12);
const MAX_TP_DIST  = (Number(process.env.SWEEP_MAX_TP_PCT || 6) || 6) / 100;
const SL_BUF       = (Number(process.env.SWEEP_SL_BUF_PCT || 0.1) || 0.1) / 100;
const MIN_RR       = Number(process.env.SWEEP_MIN_RR || 0.5) || 0.5;
const VOL_MULT     = Number(process.env.VOL_MULT || 1.5) || 1.5;    // VSA volume threshold
const VOL_N        = Math.max(5, parseInt(process.env.VOL_N || '20', 10) || 20);
const MIN_N        = Math.max(1, parseInt(process.env.MIN_N || '15', 10) || 15);   // flag small samples
const rS = n => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2) + 'R';
const pc = n => (n * 100).toFixed(1) + '%';

function outcome(dir, entry, sl, tp, future) {
  const risk = Math.abs(entry - sl);
  for (const b of future) {
    if (dir > 0) { if (b.l <= sl) return -1; if (b.h >= tp) return (tp - entry) / risk; }
    else         { if (b.h >= sl) return -1; if (b.l <= tp) return (entry - tp) / risk; }
  }
  const last = future.length ? future[future.length - 1].c : entry;
  return (dir > 0 ? last - entry : entry - last) / risk;
}
function vwapAsOf(c, i) {
  const d = new Date(c[i].t); d.setUTCHours(0, 0, 0, 0); const s = d.getTime();
  let a = 0, v = 0;
  for (let j = 0; j <= i; j++) { if (c[j].t < s) continue; const tp = (c[j].h + c[j].l + c[j].c) / 3; a += tp * c[j].v; v += c[j].v; }
  return v ? a / v : null;
}

async function run() {
  const smc = require('./smc-engine');
  const { classifyOBs, normalize } = require('./ob-touch');
  let cs;
  try {
    if (process.env.KLINES_SOURCE === 'static') throw new Error('static');
    cs = (await smc.fetchCandles(SYMBOL, '15', 1000)).map(normalize);
  } catch { cs = (await require('./klines-static').loadStatic(SYMBOL, '15m', WEEKS)).map(normalize); }
  if (!cs || cs.length < 200) { console.error('Not enough data.'); process.exitCode = 1; return; }
  const days = (cs[cs.length - 1].t - cs[0].t) / 864e5;

  const pivots = smc.detectPivots(cs, LBL, LBR);
  const highs = pivots.filter(p => p.type === 'HIGH'), lows = pivots.filter(p => p.type === 'LOW');
  const nearOB = (obs, price, kind) => obs.some(o => o.kind === kind && price >= o.bottom * (1 - OB_TOL) && price <= o.top * (1 + OB_TOL));
  const vsaOK = (i, dir) => {
    const rng = cs[i].h - cs[i].l; if (rng <= 0) return false;
    let vol = 0, k = 0; for (let j = i - 1; j >= 0 && k < VOL_N; j--, k++) vol += cs[j].v;
    const avg = k ? vol / k : 0;
    if (!avg || cs[i].v < VOL_MULT * avg) return false;                   // stopping volume
    return dir > 0 ? (cs[i].c - cs[i].l) / rng >= 0.5                     // LL closes in upper half
                   : (cs[i].h - cs[i].c) / rng >= 0.5;                    // HH closes in lower half
  };
  const trailR = (dir, e, sl, ci, pivIdx) => {
    const seq = dir > 0 ? highs : lows;
    const nx = seq.find(p => p.idx > pivIdx);
    const eb = nx ? Math.min(cs.length - 1, nx.idx + LBR) : cs.length - 1;
    for (let j = ci + 1; j <= eb; j++) { if (dir > 0 ? cs[j].l <= sl : cs[j].h >= sl) return -1; }
    return (dir > 0 ? cs[eb].c - e : e - cs[eb].c) / Math.abs(e - sl);
  };

  // Build candidates once (heavy context cached per candidate).
  const cand = [];
  const build = (arr, dir) => {
    for (let k = 1; k < arr.length; k++) {
      const P = arr[k], Pprev = arr[k - 1], i = P.idx;
      if (dir > 0 ? P.price >= Pprev.price : P.price <= Pprev.price) continue;   // must sweep prior liq
      let ci = -1;
      for (let j = i + LBR; j <= Math.min(cs.length - 1, i + LBR + CONFIRM_BARS); j++)
        if (dir > 0 ? cs[j].c > Pprev.price : cs[j].c < Pprev.price) { ci = j; break; }
      if (ci < 0) continue;                                                      // no reversal reclaim
      const e = cs[ci].c, sl = dir > 0 ? P.price * (1 - SL_BUF) : P.price * (1 + SL_BUF);
      const risk = Math.abs(e - sl); if (risk <= 0) continue;
      const upto = pivots.filter(p => p.idx <= i);
      const obs = classifyOBs(smc.detectOrderBlocks(cs.slice(0, i + 1), upto));
      const pools = smc.detectLiquidityPools(cs.slice(0, i + 1), upto) || [];
      const vw = vwapAsOf(cs, i);
      // fixed-exit target = nearest opposite liquidity
      const tgts = dir > 0
        ? [...pools.filter(p => p.label === 'EQH' && p.level > e).map(p => p.level), ...highs.filter(h => h.idx <= i && h.price > e).map(h => h.price)]
        : [...pools.filter(p => p.label === 'EQL' && p.level < e).map(p => p.level), ...lows.filter(l => l.idx <= i && l.price < e).map(l => l.price)];
      let fixed = null;
      if (tgts.length) {
        const tp = dir > 0 ? Math.min(...tgts) : Math.max(...tgts);
        const dist = dir > 0 ? (tp - e) / e : (e - tp) / e;
        const reward = Math.abs(tp - e);
        if (dist <= MAX_TP_DIST && reward / risk >= MIN_RR) fixed = outcome(dir, e, sl, tp, cs.slice(ci + 1));
      }
      cand.push({
        dir, obOK: nearOB(obs, P.price, dir > 0 ? 'BULLISH' : 'BEARISH'),
        vwapOK: vw != null && (dir > 0 ? P.price <= vw : P.price >= vw),
        vsaOK: vsaOK(i, dir),
        fixed, trail: trailR(dir, e, sl, ci, i),
      });
    }
  };
  build(lows, 1); build(highs, -1);

  // Score every combination.
  const combos = [];
  for (const OB of [0, 1]) for (const VW of [0, 1]) for (const VSA of [0, 1]) for (const exit of ['fixed', 'trail']) {
    const rows = [];
    for (const c of cand) {
      if (OB && !c.obOK) continue; if (VW && !c.vwapOK) continue; if (VSA && !c.vsaOK) continue;
      const r = exit === 'fixed' ? c.fixed : c.trail;
      if (r == null) continue;
      rows.push(r);
    }
    const n = rows.length; if (!n) continue;
    const net = rows.reduce((s, r) => s + r, 0);
    const wins = rows.filter(r => r > 0).length;
    const label = [OB && 'OB', VW && 'VWAP', VSA && 'VSA'].filter(Boolean).join('+') || 'base';
    combos.push({ label: `${label} / ${exit}`, n, wr: wins / n, avg: net / n, net });
  }
  combos.sort((a, b) => (b.avg - a.avg) || (b.net - a.net));

  console.log(`══════════ ${SYMBOL} setup optimizer — ${cand.length} sweep candidates, ~${days.toFixed(0)}d ══════════`);
  console.log(`VSA: vol ≥ ${VOL_MULT}× avg(${VOL_N}) + close rejects the extreme.  min-n flag: ${MIN_N}\n`);
  console.log('rank  setup                    n    WR      avg R     net R');
  combos.forEach((c, r) => {
    const flag = c.n < MIN_N ? '  (low n)' : '';
    console.log(`${String(r + 1).padStart(2)}.  ${c.label.padEnd(22)} ${String(c.n).padStart(3)}  ${pc(c.wr).padStart(6)}  ${rS(c.avg).padStart(7)}  ${rS(c.net).padStart(8)}${flag}`);
  });
  const best = combos.find(c => c.n >= MIN_N) || combos[0];
  console.log(`\n🏆 Best (n ≥ ${MIN_N}): ${best.label}  — ${pc(best.wr)} WR, ${rS(best.avg)}/trade, ${rS(best.net)} over ${best.n} trades (${(best.n / days).toFixed(2)}/day)`);
  console.log('\nCaveat: one ~30-week window of community spot data; many combos tested = overfitting risk.');
  console.log('Confirm the winner on a different date range and on your real fills before trusting it.');
}

run().catch(e => { console.error(`failed: ${e.message}`); process.exitCode = 1; });
