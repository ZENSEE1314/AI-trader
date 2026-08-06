// The owner's exact method, on 15m: a swing extreme TAPS an OB and prints a VSA
// VOLUME CLIMAX (big orders) → fade it back to the OPPOSITE OB.
//
//   SHORT: a high pivot taps a bearish (supply) OB with a volume climax → short,
//          SL above the pivot, TP at the nearest demand (bullish) OB / liquidity below
//          ("eat the green OB").  LONG mirrors.
//
// This tests the key question the general VSA test couldn't answer: does requiring
// a HIGH-volume climax AT AN OB EXTREME *help*, even though a blanket high-volume
// filter HURT? (Context: loud-at-extreme = exhaustion; loud-mid-move = continuation.)
// It sweeps the climax threshold so the data decides.
//
//   node backtest-eth-climax.js            # ETH, ~30 weeks static-klines

const SYMBOL = (process.env.SYMBOL || 'ETHUSDT').toUpperCase();
const WEEKS  = Math.max(4, parseInt(process.env.WEEKS_15M || '30', 10) || 30);
const LBL = 10, LBR = 1;
const OB_TOL = (Number(process.env.OB_TOL_PCT || 0.3) || 0.3) / 100;
const MAX_TP_DIST = (Number(process.env.MAX_TP_PCT || 6) || 6) / 100;
const SL_BUF = (Number(process.env.SL_BUF_PCT || 0.1) || 0.1) / 100;
const MIN_RR = Number(process.env.MIN_RR || 0.5) || 0.5;
const VOL_N = Math.max(5, parseInt(process.env.VOL_N || '20', 10) || 20);
const MIN_N = 15;
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

  const piv = smc.detectPivots(c15, LBL, LBR);
  const highs = piv.filter(p => p.type === 'HIGH'), lows = piv.filter(p => p.type === 'LOW');
  const obsAt = (T) => {
    let m = [];
    for (const [tf, arr] of [['15', c15], ['240', c4h], ['1d', c1d]]) {
      const u = arr.filter(b => b.t <= T);
      if (u.length < 30) continue;
      m = m.concat(classifyOBs(smc.detectOrderBlocks(u, smc.analyzeStructure(u, 10, 3).pivots), tf));
    }
    return m;
  };
  const tapOB = (obs, price, kind) => obs.some(o => o.kind === kind && price >= o.bottom * (1 - OB_TOL) && price <= o.top * (1 + OB_TOL));
  const climax = (i) => {
    let v = 0, k = 0; for (let j = i - 1; j >= 0 && k < VOL_N; j--, k++) v += c15[j].v;
    const avg = k ? v / k : 0; return avg ? c15[i].v / avg : 0;      // volume ratio on the pivot bar
  };

  // Build candidates: extreme taps an OB → fade to the opposite OB / liquidity.
  const cand = [];
  const build = (arr, dir) => {                                      // dir +1 long (demand OB), -1 short (supply OB)
    for (const P of arr) {
      const i = P.idx, ci = i + LBR; if (ci >= c15.length - 1) continue;
      const obs = obsAt(c15[i].t);
      if (!tapOB(obs, P.price, dir > 0 ? 'BULLISH' : 'BEARISH')) continue;
      const e = c15[ci].c, sl = dir > 0 ? P.price * (1 - SL_BUF) : P.price * (1 + SL_BUF);
      const risk = Math.abs(e - sl); if (risk <= 0) continue;
      // target = opposite OB / liquidity ("eat the green OB")
      const tgts = dir > 0
        ? [...obs.filter(o => o.kind === 'BEARISH' && o.bottom > e).map(o => o.bottom),
           ...highs.filter(h => h.idx <= i && h.price > e).map(h => h.price)]
        : [...obs.filter(o => o.kind === 'BULLISH' && o.top < e).map(o => o.top),
           ...lows.filter(l => l.idx <= i && l.price < e).map(l => l.price)];
      if (!tgts.length) continue;
      const tp = dir > 0 ? Math.min(...tgts) : Math.max(...tgts);
      const dist = dir > 0 ? (tp - e) / e : (e - tp) / e;
      if (dist > MAX_TP_DIST || Math.abs(tp - e) / risk < MIN_RR) continue;
      cand.push({ dir, vol: climax(i), r: outcome(dir, e, sl, tp, c15.slice(ci + 1)) });
    }
  };
  build(highs, -1); build(lows, 1);

  const agg = rows => { const n = rows.length, w = rows.filter(r => r > 0).length, net = rows.reduce((s, r) => s + r, 0); return { n, wr: n ? w / n : 0, avg: n ? net / n : 0, net }; };
  console.log(`══════════ ${SYMBOL} — climax-at-OB fade (${cand.length} OB-tap setups, ~${days.toFixed(0)}d) ══════════`);
  console.log(`Does a VOLUME CLIMAX on the pivot bar help? (vol ratio vs ${VOL_N}-bar avg)\n`);
  console.log('climax filter         n     WR      avg R     net R');
  const rows = [];
  for (const [label, min] of [['none (all OB taps)', 0], ['vol ≥ 1.5×', 1.5], ['vol ≥ 2.0×', 2.0], ['vol ≥ 2.5×', 2.5], ['vol ≥ 3.0×', 3.0]]) {
    const a = agg(cand.filter(c => c.vol >= min).map(c => c.r));
    if (!a.n) continue;
    rows.push({ label, min, ...a });
    console.log(`${label.padEnd(20)} ${String(a.n).padStart(3)}  ${pc(a.wr).padStart(6)}  ${rS(a.avg).padStart(7)}  ${rS(a.net).padStart(8)}${a.n < MIN_N ? '  (low n)' : ''}`);
  }
  // Also: the LOW-volume (quiet) cohort — what the bot currently trades.
  const quiet = agg(cand.filter(c => c.vol < 1.0).map(c => c.r));
  if (quiet.n) console.log(`\n(for contrast) quiet pivots vol < 1.0×: n=${quiet.n}  WR ${pc(quiet.wr)}  avg ${rS(quiet.avg)}`);
  const base = rows.find(r => r.min === 0);
  const best = rows.filter(r => r.n >= MIN_N).sort((a, b) => b.avg - a.avg)[0];
  if (base && best) {
    console.log(`\nVerdict: climax ${best.avg > base.avg ? 'HELPS' : 'does NOT help'} — best is "${best.label}" `
      + `(${rS(best.avg)}/trade vs ${rS(base.avg)} for all taps).`);
    console.log(best.avg > base.avg
      ? "→ Your read holds: loud volume AT the OB is a real filter (opposite of a blanket VSA gate)."
      : "→ In this data the climax didn't add edge at the OB either. Worth revisiting the definition.");
  }
  console.log('\nCaveat: one ~30w window, community spot data; 1m entry not modeled. Confirm OOS / in prod.');
}

run().catch(e => { console.error(`failed: ${e.message}`); process.exitCode = 1; });
