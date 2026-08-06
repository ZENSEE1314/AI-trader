// Does a BIGGER-timeframe OB make the sweep entry more accurate?
// Same ETH HH/LL sweep-reversal entries (fixed exit), but the "at an OB" check is
// evaluated against OBs from 15m / 1h / 4h / 1d — compared head to head.

const SYMBOL = (process.env.SYMBOL || 'ETHUSDT').toUpperCase();
const WEEKS  = Math.max(4, parseInt(process.env.WEEKS_15M || '30', 10) || 30);
const LBL = 10, LBR = 1;
const OB_TOL = (Number(process.env.SWEEP_OB_TOL_PCT || 0.3) || 0.3) / 100;
const CONFIRM_BARS = 12, MAX_TP_DIST = 0.06, SL_BUF = 0.001, MIN_RR = 0.5, MIN_N = 15;
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

async function run() {
  const smc = require('./smc-engine');
  const { classifyOBs, normalize } = require('./ob-touch');
  const { loadStatic } = require('./klines-static');
  const useStatic = process.env.KLINES_SOURCE === 'static';
  const load = async (tf, n, bars) => {
    if (!useStatic) { try { return (await smc.fetchCandles(SYMBOL, tf === '15m' ? '15' : tf === '1h' ? '60' : tf === '4h' ? '240' : 'D', 1000)).map(normalize); } catch {} }
    return (await loadStatic(SYMBOL, tf, n)).map(normalize);
  };
  const [c15, c1h, c4h, c1d] = await Promise.all([
    load('15m', WEEKS), load('1h', Math.ceil(WEEKS / 4) + 1), load('4h', Math.ceil(WEEKS / 13) + 2), load('1d', 2),
  ]);
  if (!c15 || c15.length < 200) { console.error('Not enough data.'); process.exitCode = 1; return; }
  const days = (c15[c15.length - 1].t - c15[0].t) / 864e5;
  const TFS = { '15m': c15, '1h': c1h, '4h': c4h, '1d': c1d };

  const pivots = smc.detectPivots(c15, LBL, LBR);
  const highs = pivots.filter(p => p.type === 'HIGH'), lows = pivots.filter(p => p.type === 'LOW');
  const nearOB = (obs, price, kind) => obs.some(o => o.kind === kind && price >= o.bottom * (1 - OB_TOL) && price <= o.top * (1 + OB_TOL));
  const obOnTF = (arr, T, price, kind) => {
    const u = arr.filter(b => b.t <= T);
    if (u.length < 30) return false;
    const st = smc.analyzeStructure(u, 10, 3);
    return nearOB(classifyOBs(smc.detectOrderBlocks(u, st.pivots)), price, kind);
  };

  const cand = [];
  const build = (arr, dir) => {
    for (let k = 1; k < arr.length; k++) {
      const P = arr[k], Pprev = arr[k - 1], i = P.idx;
      if (dir > 0 ? P.price >= Pprev.price : P.price <= Pprev.price) continue;
      let ci = -1;
      for (let j = i + LBR; j <= Math.min(c15.length - 1, i + LBR + CONFIRM_BARS); j++)
        if (dir > 0 ? c15[j].c > Pprev.price : c15[j].c < Pprev.price) { ci = j; break; }
      if (ci < 0) continue;
      const e = c15[ci].c, sl = dir > 0 ? P.price * (1 - SL_BUF) : P.price * (1 + SL_BUF);
      const risk = Math.abs(e - sl); if (risk <= 0) continue;
      const upto = pivots.filter(p => p.idx <= i);
      const pools = smc.detectLiquidityPools(c15.slice(0, i + 1), upto) || [];
      const tgts = dir > 0
        ? [...pools.filter(p => p.label === 'EQH' && p.level > e).map(p => p.level), ...highs.filter(h => h.idx <= i && h.price > e).map(h => h.price)]
        : [...pools.filter(p => p.label === 'EQL' && p.level < e).map(p => p.level), ...lows.filter(l => l.idx <= i && l.price < e).map(l => l.price)];
      if (!tgts.length) continue;
      const tp = dir > 0 ? Math.min(...tgts) : Math.max(...tgts);
      const dist = dir > 0 ? (tp - e) / e : (e - tp) / e, reward = Math.abs(tp - e);
      if (dist > MAX_TP_DIST || reward / risk < MIN_RR) continue;
      const T = c15[i].t, kind = dir > 0 ? 'BULLISH' : 'BEARISH';
      cand.push({
        r: outcome(dir, e, sl, tp, c15.slice(ci + 1)),
        ob: Object.fromEntries(Object.entries(TFS).map(([tf, arr]) => [tf, obOnTF(arr, T, P.price, kind)])),
      });
    }
  };
  build(lows, 1); build(highs, -1);

  const agg = rows => { const n = rows.length, w = rows.filter(r => r > 0).length, net = rows.reduce((s, r) => s + r, 0); return { n, wr: n ? w / n : 0, avg: n ? net / n : 0, net }; };
  const cohorts = {
    'no OB (base)': cand.map(c => c.r),
    'OB @ 15m': cand.filter(c => c.ob['15m']).map(c => c.r),
    'OB @ 1h':  cand.filter(c => c.ob['1h']).map(c => c.r),
    'OB @ 4h':  cand.filter(c => c.ob['4h']).map(c => c.r),
    'OB @ 1d':  cand.filter(c => c.ob['1d']).map(c => c.r),
    'OB @ ≥1h (1h/4h/1d)': cand.filter(c => c.ob['1h'] || c.ob['4h'] || c.ob['1d']).map(c => c.r),
    'OB @ ≥4h (4h/1d)':    cand.filter(c => c.ob['4h'] || c.ob['1d']).map(c => c.r),
  };
  const rows = Object.entries(cohorts).map(([label, rs]) => ({ label, ...agg(rs) })).filter(r => r.n > 0);
  rows.sort((a, b) => (b.avg - a.avg) || (b.net - a.net));

  console.log(`══════════ ${SYMBOL} — OB accuracy by timeframe (${cand.length} sweep candidates, ~${days.toFixed(0)}d) ══════════`);
  console.log('OB timeframe            n     WR      avg R     net R');
  for (const r of rows)
    console.log(`${r.label.padEnd(22)} ${String(r.n).padStart(3)}  ${pc(r.wr).padStart(6)}  ${rS(r.avg).padStart(7)}  ${rS(r.net).padStart(8)}${r.n < MIN_N ? '  (low n)' : ''}`);
  const best = rows.find(r => r.n >= MIN_N) || rows[0];
  console.log(`\n🏆 Best (n ≥ ${MIN_N}): ${best.label} — ${pc(best.wr)} WR, ${rS(best.avg)}/trade over ${best.n} trades`);
  console.log('\nCaveat: one ~30-week window of community spot data; confirm out-of-sample.');
}

run().catch(e => { console.error(`failed: ${e.message}`); process.exitCode = 1; });
