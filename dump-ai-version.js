// ════════════════════════════════════════════════════════════════
//  dump-ai-version.js
//  Print the full config of a saved AI version.
//
//  Usage:
//    VERSION=v3.42 node dump-ai-version.js
//    VERSION_LIKE=3.42 node dump-ai-version.js
//    TOP_N=5 node dump-ai-version.js   # top 5 by total_pnl
// ════════════════════════════════════════════════════════════════

'use strict';

const { query } = require('./db');

(async () => {
  try {
    const exact = process.env.VERSION;
    const like  = process.env.VERSION_LIKE;
    const topN  = parseInt(process.env.TOP_N || '0', 10);

    let rows;
    if (exact) {
      rows = await query(
        `SELECT * FROM ai_versions WHERE version = $1 ORDER BY id DESC LIMIT 5`,
        [exact],
      );
    } else if (like) {
      rows = await query(
        `SELECT * FROM ai_versions WHERE version ILIKE $1 ORDER BY id DESC LIMIT 5`,
        [`%${like}%`],
      );
    } else if (topN > 0) {
      rows = await query(
        `SELECT * FROM ai_versions
         WHERE win_rate IS NOT NULL AND total_pnl IS NOT NULL
         ORDER BY total_pnl DESC
         LIMIT $1`,
        [topN],
      );
    } else {
      rows = await query(
        `SELECT id, version, trade_count, win_rate, total_pnl, created_at
         FROM ai_versions ORDER BY id DESC LIMIT 30`,
      );
      console.log('Latest 30 saved versions (set VERSION=… to inspect one):');
      console.table(rows.map(r => ({
        id: r.id, version: r.version, trades: r.trade_count,
        wr: r.win_rate, pnl: r.total_pnl, created: r.created_at,
      })));
      process.exit(0);
    }

    if (!rows.length) {
      console.log('No matching version found.');
      process.exit(0);
    }

    for (const r of rows) {
      console.log('═'.repeat(70));
      console.log(`#${r.id}  ${r.version}`);
      console.log(`created_at: ${r.created_at}`);
      console.log(`trades=${r.trade_count}  WR=${r.win_rate}%  total_pnl=${r.total_pnl}  avg_pnl=${r.avg_pnl}`);
      console.log('');
      console.log('--- PARAMS (active config) ---');
      console.log(JSON.stringify(r.params, null, 2));
      console.log('');
      console.log('--- SETUP_WEIGHTS (per-setup performance) ---');
      console.log(JSON.stringify(r.setup_weights, null, 2));
      console.log('');
      console.log('--- AVOIDED_COINS ---');
      console.log(JSON.stringify(r.avoided_coins, null, 2));
      console.log('');
      console.log('--- CHANGES (notes) ---');
      console.log(r.changes || '(none)');
      console.log('');
    }
    process.exit(0);
  } catch (e) {
    console.error('dump failed:', e.stack || e.message);
    process.exit(1);
  }
})();
