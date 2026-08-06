// Top-down MTF entry — HTF (4h+1d) OB is the ZONE, LTF (15m) structure is the TIMING.
//
// Price trades into a big-timeframe order block, then on 15m we wait for the
// confirming labeled pivot to enter:
//   bullish HTF OB (demand)  → LONG on a 15m HL (pullback) or HH (breakout)
//   bearish HTF OB (supply)  → SHORT on a 15m LH (rejection) or LL (breakdown)
// SL beyond the 15m swing, TP at the opposite liquidity. We compare which LTF
// trigger profile times the entry best.
//
//   node backtest-eth-mtf.js            # ETH, ~30 weeks static-klines

const SYMBOL = (process.env.SYMBOL || 'ETHUSDT').toUpperCase();
const WEEKS  = Math.max(4, parseInt(process.env.WEEKS_15M || '30', 10) || 30);
const LBL = 10, LBR = 1;
const OB_TOL = (Number(process.env.OB_TOL_PCT || 0.2) || 0.2) / 100;
const SL_BUF = 0.001, MAX_TP_DIST = 0.06, MIN_RR = 0.5, MIN_N = 15;
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

// Label a pivot sequence: HH/LH for highs, HL/LL for lows (vs previous same-type).
function labelPivots(pivots) {
  let ph = null, pl = null; const out = [];
  for (const p of pivots) {
    if (p.type === 'HIGH') { out.push({ ...p, label: ph == null ? null : (p.price > ph ? 'HH' : 'LH') }); ph = p.price; }
    else { out.push({ ...p, label: pl == null ? null : (p.price > pl ? 'HL' : 'LL') }); pl = p.price; }
  }
  return out;
}

async function run() {
  const smc = require('./smc-engine');
  const { classifyOBs, normalize } = require('./ob-touch');
  const { loadStatic } = require('./klines-static');
  const st = process.env.KLINES_SOURCE === 'static';
  const load = async (tf, n, code) => {
    if (!st) { try { return (await smc.fetchCandles(SYMBOL, code, 1000)).map(normalize); } catch {} }
    return (await loadStatic(SYMBOL, tf, n)).map(normalize);
  };
  const [c15, c4h, c1d] = await Promise.all([
    load('15m', WEEKS, '15'), load('4h', Math.ceil(WEEKS / 13) + 2, '240'), load('1d', 2, 'D'),
  ]);
  if (!c15 || c15.length < 200) { console.error('Not enough data.'); process.exitCode = 1; return; }
  const days = (c15[c15.length - 1].t - c15[0].t) / 864e5;

  const piv15 = smc.detectPivots(c15, LBL, LBR);
  const labeled = labelPivots(piv15);
  const highs = piv15.filter(p => p.type === 'HIGH'), lows = piv15.filter(p => p.type === 'LOW');

  // HTF OBs as-of a time T, cached by (# closed 4h bars, # closed 1d bars).
  const cache = new Map();
  const htfObs = (T) => {
    const u4 = c4h.filter(b => b.t <= T), u1 = c1d.filter(b => b.t <= T);
    const key = `${u4.length}:${u1.length}`;
    if (cache.has(key)) return cache.get(key);
    let obs = [];
    if (u4.length >= 30) obs = obs.concat(classifyOBs(smc.detectOrderBlocks(u4, smc.analyzeStructure(u4, 10, 3).pivots), '4h'));
    if (u1.length >= 30) obs = obs.concat(classifyOBs(smc.detectOrderBlocks(u1, smc.analyzeStructure(u1, 10, 3).pivots), '1d'));
    cache.set(key, obs); return obs;
  };
  const inOB = (obs, price, kind) => obs.some(o => o.kind === kind && price >= o.bottom * (1 - OB_TOL) && price <= o.top * (1 + OB_TOL));

  // Build candidates: a labeled 15m pivot sitting inside a matching HTF OB.
  const cand = [];
  for (const P of labeled) {
    if (!P.label) continue;
    const i = P.idx, ci = i + LBR; if (ci >= c15.length - 1) continue;
    const T = c15[i].t;
    const dir = P.type === 'LOW' ? 1 : -1;                 // low pivot → long zone, high pivot → short zone
    const kind = dir > 0 ? 'BULLISH' : 'BEARISH';
    if (!inOB(htfObs(T), P.price, kind)) continue;         // must be in a HTF OB of the right kind
    const e = c15[ci].c, sl = dir > 0 ? P.price * (1 - SL_BUF) : P.price * (1 + SL_BUF);
    const risk = Math.abs(e - sl); if (risk <= 0) continue;
    const upto = piv15.filter(p => p.idx <= i);
    const pools = smc.detectLiquidityPools(c15.slice(0, i + 1), upto) || [];
    const tgts = dir > 0
      ? [...pools.filter(p => p.label === 'EQH' && p.level > e).map(p => p.level), ...highs.filter(h => h.idx <= i && h.price > e).map(h => h.price)]
      : [...pools.filter(p => p.label === 'EQL' && p.level < e).map(p => p.level), ...lows.filter(l => l.idx <= i && l.price < e).map(l => l.price)];
    if (!tgts.length) continue;
    const tp = dir > 0 ? Math.min(...tgts) : Math.max(...tgts);
    const dist = dir > 0 ? (tp - e) / e : (e - tp) / e;
    if (dist > MAX_TP_DIST || Math.abs(tp - e) / risk < MIN_RR) continue;
    cand.push({ label: P.label, dir, r: outcome(dir, e, sl, tp, c15.slice(ci + 1)) });
  }

  const agg = rows => { const n = rows.length, w = rows.filter(r => r > 0).length, net = rows.reduce((s, r) => s + r, 0); return { n, wr: n ? w / n : 0, avg: n ? net / n : 0, net }; };
  // Trigger profiles (which 15m label times the entry).
  const profiles = {
    'pullback  (HL long / LH short)': cand.filter(c => c.label === 'HL' || c.label === 'LH'),
    'breakout  (HH long / LL short)': cand.filter(c => c.label === 'HH' || c.label === 'LL'),
    'any pivot (HL/HH / LH/LL)':      cand.slice(),
    '  · HL only (long)':  cand.filter(c => c.label === 'HL'),
    '  · LH only (short)': cand.filter(c => c.label === 'LH'),
    '  · HH only (long)':  cand.filter(c => c.label === 'HH'),
    '  · LL only (short)': cand.filter(c => c.label === 'LL'),
  };
  const rows = Object.entries(profiles).map(([label, cs]) => ({ label, ...agg(cs.map(c => c.r)) })).filter(r => r.n > 0);

  console.log(`══════════ ${SYMBOL} — HTF-OB zone + LTF-structure entry (${cand.length} in-zone signals, ~${days.toFixed(0)}d) ══════════`);
  console.log('LTF trigger                        n     WR      avg R     net R');
  for (const r of rows)
    console.log(`${r.label.padEnd(32)} ${String(r.n).padStart(3)}  ${pc(r.wr).padStart(6)}  ${rS(r.avg).padStart(7)}  ${rS(r.net).padStart(8)}${r.n < MIN_N ? '  (low n)' : ''}`);
  const rank = rows.filter(r => !r.label.startsWith('  ')).sort((a, b) => b.avg - a.avg);
  const best = rank.find(r => r.n >= MIN_N) || rank[0];
  if (best) console.log(`\n🏆 Best profile (n ≥ ${MIN_N}): ${best.label.trim()} — ${pc(best.wr)} WR, ${rS(best.avg)}/trade over ${best.n} trades (${(best.n / days).toFixed(2)}/day)`);
  console.log('\nModel: enter only when a 15m HL/LH/HH/LL prints INSIDE a 4h/1d OB. One window,');
  console.log('community spot data — confirm out-of-sample and on real fills.');
}

run().catch(e => { console.error(`failed: ${e.message}`); process.exitCode = 1; });
