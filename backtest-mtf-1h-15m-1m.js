'use strict';
/**
 * CLI runner for the top-down 1h→15m→1m MTF backtest.
 *
 * Reuses the MCT site's OWN chart engine (routes/chart.js `lib`: detectSwings,
 * getStructureLabels, detectEQHEQL, calcCurvedBands) via backtest-mtf-engine.js,
 * so the numbers reflect the exact structure / equal-highs / curved bands the
 * website draws. Data is Binance USD-M futures klines (same source as the site).
 *
 * RUN (needs outbound access to fapi.binance.com — i.e. your Railway/local box):
 *     node backtest-mtf-1h-15m-1m.js
 *     SYMBOL=SOLUSDT DAYS=30 LEV=20 node backtest-mtf-1h-15m-1m.js
 *     BAND_NEAR=0.25 VSA_MULT=2 EQH_GUARD=0.003 node backtest-mtf-1h-15m-1m.js
 *
 * Past data only — not financial advice.
 */
const { runMtfBacktest, summarize } = require('./backtest-mtf-engine');
const { fetchArr } = require('./backtest-mtf-fetch');
const { lib } = require('./routes/chart');           // the site's real chart engine

const SYMBOL = (process.env.SYMBOL || 'SOLUSDT').toUpperCase();
const DAYS   = Number(process.env.DAYS || 14);

const opts = {
  lev:        Number(process.env.LEV || 20),
  slMargin:   Number(process.env.SL_MARGIN || 0.50),
  tpMargin:   Number(process.env.TP_MARGIN || 0.75),
  bandNear:   Number(process.env.BAND_NEAR || 0.25),
  pivot1m:    Number(process.env.PIVOT_1M || 2),
  vsaMult:    Number(process.env.VSA_MULT || 2.0),
  vsaLen:     Number(process.env.VSA_LEN || 20),
  vsaBody:    Number(process.env.VSA_BODY || 0.5),
  eqhGuardPct: Number(process.env.EQH_GUARD || 0),
};

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
function line(name, s) {
  if (!s.n) return console.log(`${name.padEnd(8)}: no trades`);
  console.log(`${name.padEnd(8)}: ${String(s.n).padStart(3)} trades | WR ${(s.wr * 100).toFixed(0).padStart(3)}% `
    + `| net ${pct(s.pnl).padStart(6)} margin (${(s.perTrade * 100).toFixed(1)}%/trade) | PF ${s.pf.toFixed(2)}`);
}

(async () => {
  console.log(`\n=== MTF 1h→15m→1m backtest | ${SYMBOL} | ${DAYS}d | ${opts.lev}x (uses MCT chart engine) ===`);
  console.log(`SL ${opts.slMargin * 100}% / TP ${opts.tpMargin * 100}% margin | bandNear ${opts.bandNear} `
    + `| VSA ${opts.vsaMult}x/${opts.vsaLen} body>=${opts.vsaBody} | EQH guard ${opts.eqhGuardPct || 'off'}\n`);
  console.log('fetching klines (Binance USD-M)…');
  const [k1h, k15, k1m] = await Promise.all([
    fetchArr(SYMBOL, '1h', DAYS + 3),
    fetchArr(SYMBOL, '15m', DAYS + 1),
    fetchArr(SYMBOL, '1m', DAYS),
  ]);
  console.log(`  1h=${k1h.length} 15m=${k15.length} 1m=${k1m.length}`);

  const r = runMtfBacktest({ k1h, k15, k1m, lib, opts });
  const s = summarize(r.trades);
  console.log(`  structure: 1h labels=${r.counts.lab1h} 15m labels=${r.counts.lab15} EQH/EQL=${r.counts.eqh1h} 1m pivots=${r.counts.piv1m}`);
  console.log(`  filtered out → 1h/15m misalign, no-1m-pivot ${r.skips.no1mPivot}, band ${r.skips.band}, VSA ${r.skips.vsa}, EQH ${r.skips.eqh}\n`);
  console.log('── results ─────────────────────────────');
  line('ALL', s.all); line('LONGS', s.longs); line('SHORTS', s.shorts);
  console.log('\nPast data only; not financial advice.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
