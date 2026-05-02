// ════════════════════════════════════════════════════════════════
//  backtest-v342-remix-grid.js
//
//  Tests v3.42's HTF-only base + various quality filters mixed in.
//  Goal: find the highest-WR / highest-P&L combination.
// ════════════════════════════════════════════════════════════════

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const DAYS = process.env.DAYS || '30';

const FILTERS = ['1m_align', 'chase', 'rpos', 'volspike', 'strict_htf'];

function combinations(arr, n) {
  if (n === 0) return [[]];
  if (arr.length === 0) return [];
  const [first, ...rest] = arr;
  return [
    ...combinations(rest, n - 1).map(c => [first, ...c]),
    ...combinations(rest, n),
  ];
}

const VARIANTS = [
  { label: 'v3.42 base (no filters)', filters: '' },
  // Singles
  ...FILTERS.map(f => ({ label: `+ ${f}`, filters: f })),
  // Pairs
  ...combinations(FILTERS, 2).map(c => ({ label: `+ ${c.join('+')}`, filters: c.join(',') })),
  // Triples
  ...combinations(FILTERS, 3).map(c => ({ label: `+ ${c.join('+')}`, filters: c.join(',') })),
  // All-on
  { label: `+ ALL (${FILTERS.join('+')})`, filters: FILTERS.join(',') },
];

function runOne(filters) {
  return new Promise((resolve) => {
    const env = { ...process.env, DAYS, FILTERS: filters };
    const child = spawn('node', [path.join(__dirname, 'backtest-v342.js')], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => resolve(out));
  });
}

function parseSummary(text) {
  const m = text.match(/TOTAL\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)%\s+\$([-\d.]+)/);
  if (!m) return null;
  return {
    trades: parseInt(m[1]), wins: parseInt(m[2]), losses: parseInt(m[3]),
    wr: parseFloat(m[4]), pnl: parseFloat(m[5]),
  };
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  V3.42 REMIX GRID — ${DAYS} days, $1000`);
  console.log(`  Variants: ${VARIANTS.length}`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];
  for (const v of VARIANTS) {
    process.stdout.write(`\n▶ ${v.label.padEnd(45)} ... `);
    const t0 = Date.now();
    const out = await runOne(v.filters);
    const s = parseSummary(out);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    if (s) {
      console.log(`${s.trades}t  WR=${s.wr.toFixed(1)}%  P&L=$${s.pnl.toFixed(2)}  (${elapsed}s)`);
      results.push({ ...v, ...s });
    } else {
      console.log(`PARSE FAILED  (${elapsed}s)`);
      results.push({ ...v, trades: 0, wr: 0, pnl: 0 });
    }
  }

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RANKED BY WR');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('rank  variant                                         trades  WR      P&L');
  console.log('────────────────────────────────────────────────────────────────────────');
  const byWR = results.slice().sort((a, b) => b.wr - a.wr);
  byWR.forEach((r, i) => {
    console.log(`${String(i+1).padStart(2)}.   ${r.label.padEnd(45)} ${String(r.trades).padStart(6)}  ${r.wr.toFixed(1).padStart(5)}%  $${r.pnl.toFixed(2).padStart(9)}`);
  });

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RANKED BY P&L');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('rank  variant                                         trades  WR      P&L');
  console.log('────────────────────────────────────────────────────────────────────────');
  const byPnl = results.slice().sort((a, b) => b.pnl - a.pnl);
  byPnl.forEach((r, i) => {
    console.log(`${String(i+1).padStart(2)}.   ${r.label.padEnd(45)} ${String(r.trades).padStart(6)}  ${r.wr.toFixed(1).padStart(5)}%  $${r.pnl.toFixed(2).padStart(9)}`);
  });
  process.exit(0);
})().catch(e => { console.error('failed:', e.stack); process.exit(1); });
