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

// The competing entry filters, evaluated on the SAME short signals.
const MODES = ['baseline', 'touch', 'magnet', 'barrier', 'align'];

async function run() {
  const smc = require('./smc-engine');
  const { decideShortFromOBs, decideByMode, classifyOBs, normalize } = require('./ob-touch');
  const tol = (Number(process.env.OB_TOUCH_MAX_DIST_PCT || 0.5) || 0.5) / 100;
  const tagWin = Math.max(1, parseInt(process.env.OB_TOUCH_TAG_WINDOW || '12', 10) || 12);
  const maxRangePct = (Number(process.env.OB_PATH_MAX_RANGE_PCT || 3) || 3) / 100;

  // Data source: Bybit if reachable (prod), else the static-klines dataset over
  // raw.githubusercontent.com (works in the web sandbox where exchanges are blocked).
  // Force with KLINES_SOURCE=static | bybit.
  const wantStatic = process.env.KLINES_SOURCE === 'static';
  const weeks15 = Math.max(12, Math.ceil(BARS_15M / 672) + 1);   // ≥ ~12 weeks for a real sample
  let c15, c1h, c4h, source = 'bybit';

  async function fromStatic() {
    const { loadStatic } = require('./klines-static');
    source = 'static-klines (finom/static-klines via raw.githubusercontent.com)';
    return Promise.all([
      loadStatic(SYMBOL, '15m', weeks15),
      loadStatic(SYMBOL, '1h', 6),
      loadStatic(SYMBOL, '4h', 3),
    ]);
  }

  if (wantStatic) {
    console.log(`Loading ${SYMBOL} klines from static-klines dataset …`);
    [c15, c1h, c4h] = await fromStatic();
  } else {
    console.log(`Fetching ${SYMBOL} klines from Bybit …`);
    try {
      [c15, c1h, c4h] = await Promise.all([
        smc.fetchCandles(SYMBOL, '15', BARS_15M),
        smc.fetchCandles(SYMBOL, '60', 500),
        smc.fetchCandles(SYMBOL, '240', 500),
      ]);
    } catch (e) {
      console.log(`Bybit unreachable (${e.message}) — falling back to static-klines dataset …`);
      [c15, c1h, c4h] = await fromStatic();
    }
  }
  if (!c15 || c15.length < 100) {
    console.error('Not enough 15m data from any source.');
    console.error('(static-klines needs raw.githubusercontent.com egress; Bybit needs api.bybit.com.)');
    process.exitCode = 1; return;
  }
  console.log(`Source: ${source}`);
  console.log(`Got ${c15.length}×15m, ${(c1h || []).length}×1h, ${(c4h || []).length}×4h bars. `
    + `Params: SL=${(SL_PCT * 100).toFixed(2)}% RR=1:${RR} tol=${(tol * 100).toFixed(2)}% `
    + `range=${(maxRangePct * 100).toFixed(1)}% tag=${tagWin}\n`);

  const cs = c15.map(normalize);
  const c1 = (c1h || []).map(normalize);
  const c4 = (c4h || []).map(normalize);
  const pivots = smc.detectPivots(cs, LBL_15M, LBR_15M).filter(p => p.type === 'HIGH');

  // As-of multi-timeframe OB set at time T (15m + 1h + 4h), uniform + merged.
  const obsAsOf = (T) => {
    const per = [['15', cs], ['60', c1], ['240', c4]];
    let merged = [];
    for (const [tf, arr] of per) {
      const upto = arr.filter(b => b.t <= T);
      if (upto.length < 30) continue;
      const st = smc.analyzeStructure(upto, 10, 3);
      merged = merged.concat(classifyOBs(smc.detectOrderBlocks(upto, st.pivots), tf));
    }
    return merged;
  };

  const cohorts = Object.fromEntries(MODES.map(m => [m, []]));
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
    if (!(entry > vw.vwap && entry <= vw.upper)) continue;      // premium half, not extended

    const asof4h = (c4h || []).filter(b => b.t <= cs[cbar].t);
    if (asof4h.length < 60 || smc.classifyTrend(asof4h) !== 'DOWN') continue;   // 4H down

    lastEntryBar = cbar;
    const out = simulateShort(entry, cs.slice(cbar + 1));

    // data available at the entry bar
    const T = cs[cbar].t;
    const win = cs.slice(Math.max(0, cbar - tagWin + 1), cbar + 1);
    const recentHigh = Math.max(...win.map(c => c.h));
    const recentLow  = Math.min(...win.map(c => c.l));
    const obs15raw = smc.detectOrderBlocks(cs.slice(0, cbar + 1), smc.analyzeStructure(cs.slice(0, cbar + 1), 10, 3).pivots) || [];
    const obsMulti = obsAsOf(T);
    const P = { direction: 'SHORT', price: entry, obs: obsMulti, recentHigh, recentLow, maxRangePct };

    const allow = {
      baseline: true,
      touch:   decideShortFromOBs(obs15raw, entry, { recentHigh, tol }).allow,
      magnet:  decideByMode('magnet',  P).allow,
      barrier: decideByMode('barrier', P).allow,
      align:   decideByMode('align',   P).allow,
    };
    for (const m of MODES) if (allow[m]) cohorts[m].push(out);
  }

  const rows = MODES.map(m => ({ mode: m, ...agg(cohorts[m]) }));
  const base = rows.find(r => r.mode === 'baseline');
  // Rank the FILTERS (exclude baseline) by avg-R, then net-R.
  const ranked = rows.filter(r => r.mode !== 'baseline')
    .sort((a, b) => (b.avg - a.avg) || (b.net - a.net));

  console.log('══════════ OB entry filters — forward simulation (SHORTS) ══════════');
  console.log('mode        n     WR      net R     avg R    Δavg vs base');
  const fmt = r => `${r.mode.padEnd(9)} ${String(r.n).padStart(3)}  ${pctS(r.wr).padStart(6)}  ${rS(r.net).padStart(9)}  ${rS(r.avg).padStart(7)}  ${rS(r.avg - base.avg)}`;
  console.log(fmt(base));
  for (const r of ranked) console.log(fmt(r));

  const best = ranked[0];
  console.log(`\n🏆 Best filter by avg-R: ${best.mode}  (${rS(best.avg)}/trade over ${best.n} shorts, `
    + `${rS(best.avg - base.avg)} vs no filter)`);
  console.log('\nHow to read it:');
  console.log('  • avg R = expectancy per trade (higher is better); net R = total edge over the window.');
  console.log('  • A good filter LIFTS avg-R while keeping n high enough to matter.');
  console.log('  • n far below baseline = very selective; check it is not just luck on a few trades.');
  console.log('\nCaveat: broader signal set than live (no 1m/Homma/chase), fixed-bracket exits.');
  console.log('Treat as directional; confirm the winner on real fills with backtest-ob-touch.js in prod.');
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

  // ── Mode decisions (pure, no network) ──
  const { decideByMode } = require('./ob-touch');
  const chkB = (name, got, want) => {
    const ok = got === want;
    console.log(`  ${ok ? '✓' : '✗'} ${name}: allow=${got} (want ${want})`);
    ok ? pass++ : fail++;
  };
  const bearAbove = [{ kind: 'BEARISH', top: 75, bottom: 74.5 }];
  const bullBelow = [{ kind: 'BULLISH', top: 73.5, bottom: 73 }];
  // align: short the tagged bearish OB above → allow
  chkB('align short @tagged bearish above', decideByMode('align', { direction: 'SHORT', price: 74.4, obs: bearAbove, recentHigh: 75.1, recentLow: 74.3 }).allow, true);
  // align: nearest is bullish demand below → short blocked (wrong direction)
  chkB('align short vs bullish-below', decideByMode('align', { direction: 'SHORT', price: 74.0, obs: bullBelow, recentHigh: 74.1, recentLow: 74.0 }).allow, false);
  // magnet: bearish OB above untagged → short blocked (price pulled up first)
  chkB('magnet short vs untagged-above', decideByMode('magnet', { direction: 'SHORT', price: 74.0, obs: bearAbove, recentHigh: 74.2, recentLow: 73.9 }).allow, false);
  // magnet: same OB already tagged → short allowed
  chkB('magnet short @tagged-above', decideByMode('magnet', { direction: 'SHORT', price: 74.0, obs: bearAbove, recentHigh: 75.1, recentLow: 73.9 }).allow, true);
  // barrier: OB below in the path untagged → short blocked
  chkB('barrier short into below-OB', decideByMode('barrier', { direction: 'SHORT', price: 74.0, obs: bullBelow, recentHigh: 74.1, recentLow: 74.0 }).allow, false);
  // barrier: no OB in the downward path → short allowed
  chkB('barrier short, path clear', decideByMode('barrier', { direction: 'SHORT', price: 74.0, obs: bearAbove, recentHigh: 74.1, recentLow: 74.0 }).allow, true);

  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

if (process.argv.includes('--selftest')) selftest();
else run().catch(e => { console.error(`sim failed: ${e.message}`); process.exitCode = 1; });
