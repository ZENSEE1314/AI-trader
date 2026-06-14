'use strict';
/**
 * SL × TP sweep for the HTF/LTF structure strategy, AGGREGATED across all symbols.
 * Reuses the exact backtest engine (runOne) + VWAP ±2SD filter from backtest-structure.js
 * so the result is identical to the live strategy rules — only SL/TP/leverage change.
 *
 *   node backtest-sltp-sweep.js [lookbackDays] [leverage]
 *   node backtest-sltp-sweep.js 21 50
 *
 * Answers: "which SL and TP (as % of margin) gives the best win rate / profit factor?"
 */

const bt = require('./backtest-structure.js');
const { buildSmcBiasWindows, biasArrayFromWindows } = require('./strategy-structure-htf-ltf');

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT').split(',');
const DAYS = Number(process.argv[2] || 14);
const LEV = Number(process.argv[3] || 50);
const BIAS_TF = '15m', ENTRY_TF = '1m';

// Grids (fraction of margin): SL 25%–60%, TP 35%–90%.
const SL_GRID = [0.25, 0.30, 0.35, 0.40, 0.50, 0.60];
const TP_GRID = [0.35, 0.50, 0.60, 0.70, 0.90];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '∞';

async function main() {
  console.log(`\n=== SL × TP sweep (aggregated) | ${DAYS}d | ${LEV}x | VWAP ±2SD filter ON | ${BIAS_TF}→${ENTRY_TF} ===`);
  console.log(`Symbols: ${SYMBOLS.join(', ')} | SL%margin × TP%margin\n`);

  // Fetch once per symbol, precompute the VWAP-filtered bias array (independent of SL/TP).
  const prepared = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`Fetching ${sym} … `);
    try {
      const c15 = await bt.fetchKlines(sym, BIAS_TF, DAYS); await sleep(400);
      const c1  = await bt.fetchKlines(sym, ENTRY_TF, DAYS); await sleep(400);
      let windows = buildSmcBiasWindows(c15, 5, 3, bt.TF_MS[BIAS_TF]);
      windows = bt.applyVwapFilter(windows, bt.computeVwapBands(c15));
      const biasArr = biasArrayFromWindows(c1, windows);
      prepared.push({ sym, c1, biasArr });
      console.log(`${c15.length} 15m, ${c1.length} 1m, ${windows.length} bias windows`);
    } catch (e) {
      console.log(`SKIP (${e.message})`);
    }
    await sleep(800);
  }

  // For each SL/TP, run every symbol and pool the trades for one aggregate stat.
  console.log(`\n  SL%   TP%   trades  WR%    PF     totRet%  worstSymRet%`);
  const rows = [];
  for (const slM of SL_GRID) {
    for (const tpM of TP_GRID) {
      let pooled = [];
      let worstSym = Infinity;
      for (const p of prepared) {
        const r = bt.runOne(p.c1, p.biasArr, { lev: LEV, slPct: slM / LEV, tpPct: tpM / LEV });
        pooled = pooled.concat(r.tradeList);
        if (r.trades >= 3) worstSym = Math.min(worstSym, r.totalReturnPct);
      }
      const n = pooled.length;
      const wins = pooled.filter(t => t.exit === 'TP').length;
      const gw = pooled.filter(t => t.rOM > 0).reduce((s, t) => s + t.rOM, 0);
      const gl = -pooled.filter(t => t.rOM < 0).reduce((s, t) => s + t.rOM, 0);
      const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
      const ret = pooled.reduce((s, t) => s + t.rOM, 0) * 100;
      const wr = n ? wins / n * 100 : 0;
      const worst = Number.isFinite(worstSym) ? worstSym : null;
      rows.push({ slM, tpM, n, wr, pf, ret, worstSym: worst });
      const flag = (pf > 1.2 && ret > 0 && n >= 20) ? ' ✅' : '';
      console.log(`  ${String(slM*100).padStart(3)}  ${String(tpM*100).padStart(4)}   ${String(n).padStart(4)}  ${fmt(wr).padStart(4)}  ${fmt(pf,2).padStart(5)}  ${fmt(ret).padStart(7)}  ${worst==null?'   -':fmt(worst).padStart(7)}${flag}`);
    }
  }

  // Rank: profitable, enough trades, then by profit factor.
  const viable = rows.filter(r => r.n >= 20 && r.pf > 1 && r.ret > 0).sort((a, b) => b.pf - a.pf);
  console.log('\n  ── best by profit factor (≥20 trades, profitable) ──');
  for (const r of viable.slice(0, 5)) {
    console.log(`     SL ${r.slM*100}% / TP ${r.tpM*100}%  →  WR ${fmt(r.wr)}%  PF ${fmt(r.pf,2)}  ret ${fmt(r.ret)}%  (${r.n} trades)`);
  }
  if (!viable.length) console.log('     none cleared the bar at this leverage/lookback.');
  console.log('');
}

main().catch(e => { console.error('Sweep failed:', e.message); process.exit(1); });
