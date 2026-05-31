// Closed Trade WR / PnL Analyzer
// Runs locally with DATABASE_URL, or inside Railway via:
//   railway run -- node analyze-trade-wr.js

const { query, pool, initAllTables } = require('./db');

const DAYS = Math.max(1, parseInt(process.env.DAYS || '30', 10) || 30);
const CLOSED = "status IN ('WIN','LOSS','TP','SL','CLOSED') AND pnl_usdt IS NOT NULL";

function money(value) {
  const n = Number(value || 0);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function printRows(title, rows, columns) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  if (!rows.length) {
    console.log('No rows.');
    return;
  }
  for (const row of rows) {
    console.log(columns.map(([label, key, fmt]) => `${label}: ${fmt ? fmt(row[key], row) : row[key]}`).join(' | '));
  }
}

async function groupedReport(groupExpr, groupBy, minTrades, orderBy) {
  return query(
    `SELECT
       ${groupExpr} AS bucket,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE pnl_usdt > 0)::int AS wins,
       COUNT(*) FILTER (WHERE pnl_usdt <= 0)::int AS losses,
       ROUND((COUNT(*) FILTER (WHERE pnl_usdt > 0)::numeric / NULLIF(COUNT(*), 0)) * 100, 1)::float AS win_rate,
       ROUND(SUM(pnl_usdt)::numeric, 4)::float AS total_pnl,
       ROUND(AVG(pnl_usdt)::numeric, 4)::float AS avg_pnl,
       ROUND(MAX(pnl_usdt)::numeric, 4)::float AS best_pnl,
       ROUND(MIN(pnl_usdt)::numeric, 4)::float AS worst_pnl
     FROM trades
     WHERE ${CLOSED}
       AND COALESCE(closed_at, created_at) > NOW() - ($1::text || ' days')::interval
     GROUP BY ${groupBy}
     HAVING COUNT(*) >= $2
     ORDER BY ${orderBy}
     LIMIT 20`,
    [DAYS, minTrades]
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Run through Railway or set DATABASE_URL locally.');
  }

  await initAllTables();

  const [summary] = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE pnl_usdt > 0)::int AS wins,
       COUNT(*) FILTER (WHERE pnl_usdt <= 0)::int AS losses,
       ROUND((COUNT(*) FILTER (WHERE pnl_usdt > 0)::numeric / NULLIF(COUNT(*), 0)) * 100, 1)::float AS win_rate,
       ROUND(SUM(pnl_usdt)::numeric, 4)::float AS total_pnl,
       ROUND(AVG(pnl_usdt)::numeric, 4)::float AS avg_pnl,
       ROUND(MAX(pnl_usdt)::numeric, 4)::float AS best_pnl,
       ROUND(MIN(pnl_usdt)::numeric, 4)::float AS worst_pnl
     FROM trades
     WHERE ${CLOSED}
       AND COALESCE(closed_at, created_at) > NOW() - ($1::text || ' days')::interval`,
    [DAYS]
  );

  console.log(`Closed Trade Report - Last ${DAYS} Days`);
  console.log('-----------------------------------');
  console.log(`Trades: ${summary.total} | Wins: ${summary.wins} | Losses: ${summary.losses} | WR: ${pct(summary.win_rate)} | Net: ${money(summary.total_pnl)} | Avg: ${money(summary.avg_pnl)} | Best: ${money(summary.best_pnl)} | Worst: ${money(summary.worst_pnl)}`);

  const cols = [
    ['Pattern', 'bucket'],
    ['Trades', 'total'],
    ['W/L', 'wins', (_, r) => `${r.wins}/${r.losses}`],
    ['WR', 'win_rate', pct],
    ['Net', 'total_pnl', money],
    ['Avg', 'avg_pnl', money],
    ['Worst', 'worst_pnl', money],
  ];

  printRows('Best Symbol + Direction', await groupedReport("symbol || ' ' || direction", 'symbol, direction', 2, 'total_pnl DESC'), cols);
  printRows('Worst Symbol + Direction', await groupedReport("symbol || ' ' || direction", 'symbol, direction', 2, 'total_pnl ASC'), cols);
  printRows('Best Setup + Direction', await groupedReport("COALESCE(setup, market_structure, 'unknown') || ' ' || direction", "COALESCE(setup, market_structure, 'unknown'), direction", 2, 'total_pnl DESC'), cols);
  printRows('Worst Setup + Direction', await groupedReport("COALESCE(setup, market_structure, 'unknown') || ' ' || direction", "COALESCE(setup, market_structure, 'unknown'), direction", 2, 'total_pnl ASC'), cols);
  printRows('Worst Exact Combos To Block', await groupedReport("symbol || ' ' || direction || ' ' || COALESCE(setup, market_structure, 'unknown')", "symbol, direction, COALESCE(setup, market_structure, 'unknown')", 2, 'total_pnl ASC'), cols);
  printRows('Exit Reasons', await groupedReport("COALESCE(exit_reason, 'exchange_or_manual')", "COALESCE(exit_reason, 'exchange_or_manual')", 2, 'total_pnl ASC'), cols);
}

main()
  .catch(err => {
    console.error(`Trade WR analysis failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
