// ════════════════════════════════════════════════════════════════
//  analyze-trade-wr.js
//
//  Pulls every CLOSED trade from the last N days and computes
//  win rate / avg P&L breakdowns by:
//    - symbol
//    - symbol × direction
//    - setup (NEW — only present on trades opened after the
//      setup-tagging deploy)
//    - market_structure
//    - tf_15m / tf_3m / tf_1m (legacy structure tags)
//
//  Run on Railway:
//    DAYS=30 node analyze-trade-wr.js
// ════════════════════════════════════════════════════════════════

'use strict';

const { query } = require('./db');

const DAYS = parseInt(process.env.DAYS || '30', 10);

function fmtPct(n)   { return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—'; }
function fmtUsd(n)   { return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'; }

function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }

function tableRow(cols, widths) {
  return cols.map((c, i) => pad(c, widths[i])).join('  ');
}

function printTable(title, rows, header, widths) {
  console.log('');
  console.log(`── ${title} `.padEnd(78, '─'));
  console.log(tableRow(header, widths));
  console.log(widths.map(w => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(tableRow(r, widths));
}

async function breakdown(label, groupCols, header, widths, minTotal = 1) {
  const groupExpr = groupCols.join(', ');
  const sql = `
    SELECT ${groupExpr},
           COUNT(*)::int                                                AS total,
           SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END)::int           AS wins,
           SUM(CASE WHEN pnl_usdt <= 0 THEN 1 ELSE 0 END)::int          AS losses,
           COALESCE(SUM(pnl_usdt), 0)::numeric(12,2)                    AS net,
           COALESCE(AVG(pnl_usdt), 0)::numeric(12,2)                    AS avg_pnl
    FROM trades
    WHERE status = 'CLOSED'
      AND pnl_usdt IS NOT NULL
      AND closed_at > NOW() - INTERVAL '${DAYS} days'
    GROUP BY ${groupExpr}
    HAVING COUNT(*) >= ${minTotal}
    ORDER BY total DESC
  `;
  const r = await query(sql);
  if (!r.length) return;
  const rows = r.map(row => {
    const wr = row.total > 0 ? (row.wins / row.total) * 100 : 0;
    return [
      ...groupCols.map(g => row[g.split('.').pop()] ?? '∅'),
      String(row.total),
      String(row.wins),
      String(row.losses),
      fmtPct(wr),
      fmtUsd(parseFloat(row.net)),
      fmtUsd(parseFloat(row.avg_pnl)),
    ];
  });
  printTable(label, rows, header, widths);
}

(async () => {
  console.log('');
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  TRADE WIN-RATE ANALYSIS — last ${DAYS} days`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);

  const summary = await query(`
    SELECT COUNT(*)::int AS total,
           SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END)::int AS wins,
           SUM(CASE WHEN pnl_usdt <= 0 THEN 1 ELSE 0 END)::int AS losses,
           COALESCE(SUM(pnl_usdt), 0)::numeric(12,2) AS net
    FROM trades
    WHERE status='CLOSED' AND pnl_usdt IS NOT NULL
      AND closed_at > NOW() - INTERVAL '${DAYS} days'
  `);
  const s = summary[0] || { total: 0, wins: 0, losses: 0, net: 0 };
  const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
  console.log(`Closed trades: ${s.total}   wins=${s.wins}   losses=${s.losses}   WR=${fmtPct(wr)}   net=${fmtUsd(parseFloat(s.net))}`);

  if (s.total === 0) {
    console.log('No closed trades in the window — nothing to analyse.');
    process.exit(0);
  }

  await breakdown('By SETUP (only set on trades opened after setup-tag deploy)',
    ['setup'],
    ['setup', 'total', 'win', 'loss', 'WR', 'net', 'avg'],
    [22, 6, 5, 5, 8, 10, 10]);

  await breakdown('By SYMBOL',
    ['symbol'],
    ['symbol', 'total', 'win', 'loss', 'WR', 'net', 'avg'],
    [10, 6, 5, 5, 8, 10, 10]);

  await breakdown('By SYMBOL × DIRECTION',
    ['symbol', 'direction'],
    ['symbol', 'dir', 'total', 'win', 'loss', 'WR', 'net', 'avg'],
    [10, 6, 6, 5, 5, 8, 10, 10]);

  await breakdown('By MARKET STRUCTURE',
    ['market_structure'],
    ['structure', 'total', 'win', 'loss', 'WR', 'net', 'avg'],
    [22, 6, 5, 5, 8, 10, 10],
    2);

  await breakdown('By TF_15M tag',
    ['tf_15m'],
    ['tf_15m', 'total', 'win', 'loss', 'WR', 'net', 'avg'],
    [22, 6, 5, 5, 8, 10, 10],
    2);

  await breakdown('By TF_3M tag',
    ['tf_3m'],
    ['tf_3m', 'total', 'win', 'loss', 'WR', 'net', 'avg'],
    [22, 6, 5, 5, 8, 10, 10],
    2);

  console.log('');
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  Setup field will populate on new trades only — historical trades`);
  console.log(`  show NULL. Re-run this report in 1-2 weeks for proper setup WR.`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  process.exit(0);
})().catch(e => {
  console.error('analyze-trade-wr failed:', e.stack || e.message);
  process.exit(1);
});
