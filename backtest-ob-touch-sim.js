// DB-FREE forward-simulation of the OB-touch SHORT gate.
//
// Unlike backtest-ob-touch.js (which replays your real fills and needs the DB),
// this one needs ONLY market data — a single host, api.bybit.com. It rebuilds
// short signals from raw klines and compares outcomes WITH vs WITHOUT the gate,
// so you can see "how it'd go" without touching the database.
//
// It approximates the V5 SMC short trigger (see strategy-v5-smc.js):
//   • a confirmed 15m LOWER HIGH (this swing high < the previous swing high)
//   • price in the VWAP PREMIUM half (above daily VWAP, at/below the +2σ band)
//   • 4H trend = DOWN (smc-engine.classifyTrend)
// It does NOT model the 1m confirmation, Homma candle, or chase filter — so the
// signal set is broader than live. That's fine: both cohorts (all vs gated) use
// the SAME signals, so the delta isolates the OB-touch gate's effect.
//
// Outcome model: fixed bracket — SL at entry×(1+SL_PCT), TP at entry×(1−SL_PCT×RR).
// Whichever the future bars hit first; if a bar could hit both, SL is counted
// first (conservative). Open-at-end trades are marked to the last close, in R.
//
//   NETWORK: needs api.bybit.com reachable. In a web sandbox set the cloud
//   environment's Network access to Custom and add api.bybit.com (see the PR).
//
//   node backtest-ob-touch-sim.js                 # SOLUSDT, ~10 days of 15m
//   SYMBOL=SOLUSDT BARS_15M=1000 SL_PCT=0.025 RR=1.5 node backtest-ob-touch-sim.js
//   node backtest-ob-touch-sim.js --selftest      # offline: proves the P&L engine

const SYMBOL    = (process.env.SYMBOL || 'SOLUSDT').toUpperCase();
const BARS_15M  = Math.min(1000, Math.max(200, parseInt(process.env.BARS_15M || '1000', 10) || 1000));
const SL_PCT    = Number(process.env.SL_PCT || 0.025) || 0.025;   // price distance to SL (2.5% ≈ 0.50/20x)
const RR        = Number(process.env.RR || 1.5) || 1.5;            // reward:risk of the TP bracket
const COOLDOWN  = Math.max(0, parseInt(process.env.COOLDOWN_BARS || '4', 10) || 4);
const LBL_15M   = 10, LBR_15M = 1;                                // TV "SMC Expo" pivot lookback

const pctS = n => `${Number(n || 0).toFixed(1)}%`;
const rS   = n => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2) + 'R';

// ── Fixed-bracket outcome for a SHORT, in R. Pure — unit tested by --selftest.
//   future: bars AFTER entry, oldest-first, each {h, l, c}
function simulateShort(entry, future, slPct = SL_PCT, rr = RR) {
  const sl = entry * (1 + slPct);
  const tp = entry * (1 - slPct * rr);
  for (const b of future) {
    const hitSL = b.h >= sl;
    const hitTP = b.l <= tp;
    if (hitSL) return { r: -1, exit: 'SL' };        // SL checked first (conservative)
    if (hitTP) return { r: rr, exit: 'TP' };
  }
  if (!future.length) return { r: 0, exit: 'NONE' };
  const last = future[future.length - 1].c;
  return { r: (entry - last) / (entry * slPct), exit: 'OPEN' };  // mark-to-market, in R
}

// ── daily-reset VWAP + 2σ as-of bar i (mirrors strategy-v5 calcVwap) ──
function vwapAsOf(c15, i) {
  const day = new Date(c15[i].t); day.setUTCHours(0, 0, 0, 0);
  const start = day.getTime();
  let tpv = 0, tpv2 = 0, vol = 0;
  for (let j = 0; j <= i; j++) {
    if (c15[j].t < start) continue;
    const tp = (c15[j].h + c15[j].l + c15[j].c) / 3;
    tpv += tp * c15[j].v; tpv2 += tp * tp * c15[j].v; vol += c15[j].v;
  }
  if (vol === 0) return null;
  const vwap = tpv / vol;
  const sd = Math.sqrt(Math.max(0, tpv2 / vol - vwap * vwap));
  return { vwap, upper: vwap + 2 * sd, lower: vwap - 2 * sd, stddev: sd };
}

function agg(rows) {
  const n = rows.length;
  const wins = rows.filter(r => r.r > 0).length;
  const net = rows.reduce((s, r) => s + r.r, 0);
  return { n, wr: n ? wins / n * 100 : 0, net, avg: n ? net / n : 0 };
}

async function run() {
  const smc = require('./smc-engine');
  const { decideShortFromOBs, normalize } = require('./ob-touch');
  const tol = (Number(process.env.OB_TOUCH_MAX_DIST_PCT || 0.5) || 0.5) / 100;
  const tagWin = Math.max(1, parseInt(process.env.OB_TOUCH_TAG_WINDOW || '12', 10) || 12);

  console.log(`Fetching ${SYMBOL} klines from Bybit …`);
  let c15, c4h;
  try {
    [c15, c4h] = await Promise.all([
      smc.fetchCandles(SYMBOL, '15', BARS_15M),
      smc.fetchCandles(SYMBOL, '240', 500),
    ]);
  } catch (e) {
    console.error(`\nKline fetch failed: ${e.message}`);
    console.error('If this is a web sandbox, api.bybit.com is likely egress-blocked — set the');
    console.error('cloud environment Network access to Custom and add api.bybit.com, then retry.');
    process.exitCode = 1; return;
  }
  if (!c15 || c15.length < 100) { console.error('Not enough 15m data.'); process.exitCode = 1; return; }
  console.log(`Got ${c15.length}×15m and ${(c4h || []).length}×4h bars. `
    + `Params: SL=${(SL_PCT * 100).toFixed(2)}% RR=1:${RR} tol=${(tol * 100).toFixed(2)}% tag=${tagWin}\n`);

  const cs = c15.map(normalize);
  const pivots = smc.detectPivots(cs, LBL_15M, LBR_15M).filter(p => p.type === 'HIGH');

  const all = [], gated = [];
  let lastEntryBar = -Infinity, prevHighPrice = null;

  for (const piv of pivots) {
    const isLH = prevHighPrice != null && piv.price < prevHighPrice;
    prevHighPrice = piv.price;
    if (!isLH) continue;

    const cbar = piv.idx + LBR_15M;                 // pivot confirms LBR bars later
    if (cbar >= cs.length - 1) continue;
    if (cbar - lastEntryBar < COOLDOWN) continue;

    const entry = cs[cbar].c;
    const vw = vwapAsOf(cs, cbar);
    if (!vw) continue;
    // premium half only, and not extended above the +2σ band (strategy: no trade)
    if (!(entry > vw.vwap && entry <= vw.upper)) continue;

    // 4H trend must be DOWN, as-of this bar
    const asof4h = (c4h || []).filter(b => b.t <= cs[cbar].t);
    if (asof4h.length < 60 || smc.classifyTrend(asof4h) !== 'DOWN') continue;

    lastEntryBar = cbar;
    const future = cs.slice(cbar + 1);
    const out = simulateShort(entry, future);
    all.push(out);

    // OB-touch gate, computed with data available at the entry bar
    const upto = cs.slice(0, cbar + 1);
    const st = smc.analyzeStructure(upto, 10, 3);
    const obs = smc.detectOrderBlocks(upto, st.pivots) || [];
    const recentHigh = Math.max(...upto.slice(-tagWin).map(c => c.h));
    if (decideShortFromOBs(obs, entry, { recentHigh, tol }).allow) gated.push(out);
  }

  const A = agg(all), G = agg(gated);
  const line = (name, x) => console.log(
    `${name.padEnd(22)} n=${String(x.n).padStart(3)}  WR ${pctS(x.wr).padStart(6)}  net ${rS(x.net).padStart(9)}  avg ${rS(x.avg)}`);

  console.log('══════════ OB-touch SHORT gate — forward simulation ══════════');
  line('ALL LH shorts', A);
  line('  └ gated (OB touch)', G);
  console.log(`\nSkipped by gate: ${A.n - G.n} shorts`);
  const skippedNet = A.net - G.net;
  console.log(`Net R of skipped shorts: ${rS(skippedNet)}  (negative = the gate cut net-losing shorts)`);
  console.log(`Avg-R change: ${rS(A.avg)} → ${rS(G.avg)}  (${rS(G.avg - A.avg)} per trade)`);
  console.log('\nReading it: the gate is worth enabling if it lifts avg-R and the skipped');
  console.log('shorts were net-negative — i.e. it removed more bad shorts than good ones.');
  console.log('\nCaveat: broader signal set than live (no 1m/Homma/chase). Treat as directional,');
  console.log('then confirm on your real fills with backtest-ob-touch.js in prod.');
}

// ── Offline self-test of the P&L engine (no network) ──
function selftest() {
  let pass = 0, fail = 0;
  const chk = (name, got, want) => {
    const ok = Math.abs(got - want) < 1e-9;
    console.log(`  ${ok ? '✓' : '✗'} ${name}: r=${got.toFixed(3)} (want ${want})`);
    ok ? pass++ : fail++;
  };
  // TP hit first: short 100, TP at 100*(1-0.025*1.5)=96.25 reached before SL 102.5
  chk('TP first', simulateShort(100, [{ h: 101, l: 96, c: 96 }], 0.025, 1.5).r, 1.5);
  // SL hit first: bar reaches 103 (>102.5) → -1R
  chk('SL first', simulateShort(100, [{ h: 103, l: 99, c: 103 }], 0.025, 1.5).r, -1);
  // Both in one bar → SL counted first
  chk('SL wins ties', simulateShort(100, [{ h: 103, l: 96, c: 100 }], 0.025, 1.5).r, -1);
  // Neither → mark-to-market: (100-99)/(100*0.025) = 0.4R
  chk('open m2m', simulateShort(100, [{ h: 101, l: 99.5, c: 99 }], 0.025, 1.5).r, 0.4);
  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

if (process.argv.includes('--selftest')) selftest();
else run().catch(e => { console.error(`sim failed: ${e.message}`); process.exitCode = 1; });
