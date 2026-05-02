// ════════════════════════════════════════════════════════════════
//  backtest-v3-grid.js
//
//  Plug-and-play gate ablation study. Runs the v3 backtest multiple
//  times with different gate combinations and reports which combo
//  gives the highest WR + P&L.
//
//  Strategy:
//    1. Baseline — all gates on
//    2. Single ablation — disable one gate at a time
//    3. Disable each pair of "negative" gates from step 2
//    4. Report ranked table
//
//  Run on Railway:
//    DAYS=30 node backtest-v3-grid.js
// ════════════════════════════════════════════════════════════════

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const DAYS    = process.env.DAYS    || '30';
const CAPITAL = process.env.CAPITAL || '1000';

const ALL_GATES = ['htf', 'regime', 'zone', 'band', 'chase', 'rpos', 'slope', 'tightrange', 'strongtrend'];

const VARIANTS = [
  { label: 'baseline (all gates ON)',     disable: '' },
  ...ALL_GATES.map(g => ({ label: `disable ${g}`, disable: g })),
  // A few combos
  { label: 'disable rpos + chase',        disable: 'rpos,chase' },
  { label: 'disable zone + regime',       disable: 'zone,regime' },
  { label: 'minimal (only htf + band)',   disable: 'regime,zone,chase,rpos,slope,tightrange,strongtrend' },
];

function runOne(disable) {
  return new Promise((resolve) => {
    const env = { ...process.env, DAYS, CAPITAL, V3_DISABLE: disable };
    const child = spawn('node', [path.join(__dirname, 'backtest-v3-gates.js')], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', () => {});
    child.on('close', () => resolve(out));
  });
}

function parseSummary(text) {
  // Parse: TOTAL  170    76    94   44.7%   $140.01
  const m = text.match(/TOTAL\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)%\s+\$([-\d.]+)/);
  if (!m) return null;
  return {
    trades: parseInt(m[1]),
    wins:   parseInt(m[2]),
    losses: parseInt(m[3]),
    wr:     parseFloat(m[4]),
    pnl:    parseFloat(m[5]),
  };
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  GATE ABLATION STUDY — ${DAYS} days, $${CAPITAL}`);
  console.log(`  Variants: ${VARIANTS.length}`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];
  for (const v of VARIANTS) {
    process.stdout.write(`\n▶ ${v.label.padEnd(40)} ... `);
    const t0 = Date.now();
    const out = await runOne(v.disable);
    const summary = parseSummary(out);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    if (summary) {
      console.log(`${summary.trades}t  WR=${summary.wr.toFixed(1)}%  P&L=$${summary.pnl.toFixed(2)}  (${elapsed}s)`);
      results.push({ ...v, ...summary });
    } else {
      console.log(`PARSE FAILED  (${elapsed}s)`);
      results.push({ ...v, trades: 0, wr: 0, pnl: 0, parseError: true });
    }
  }

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RANKED RESULTS (by P&L descending)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('rank  variant                                         trades  WR      P&L');
  console.log('────────────────────────────────────────────────────────────────────────');
  const ranked = results.slice().sort((a, b) => b.pnl - a.pnl);
  ranked.forEach((r, i) => {
    const rank = String(i + 1).padStart(2);
    const label = r.label.padEnd(45);
    const tr = String(r.trades).padStart(6);
    const wr = `${r.wr.toFixed(1)}%`.padStart(6);
    const pnl = `$${r.pnl.toFixed(2)}`.padStart(10);
    console.log(`${rank}.   ${label} ${tr}  ${wr}  ${pnl}`);
  });
  console.log('────────────────────────────────────────────────────────────────────────');
  const best = ranked[0];
  console.log(`\n  WINNER: ${best.label}`);
  console.log(`          ${best.trades} trades, ${best.wr.toFixed(1)}% WR, P&L $${best.pnl.toFixed(2)}`);
  console.log(`          V3_DISABLE="${best.disable}"`);
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(0);
})().catch(e => {
  console.error('grid failed:', e.stack || e.message);
  process.exit(1);
});
