// ════════════════════════════════════════════════════════════════
//  dump-ai-version.js
//  Print the full config of a saved version, searching ALL three
//  tables the dashboard pulls from:
//    1. ai_versions          (named, e.g. v3.52)
//    2. strategy_versions    (manually saved/activated)
//    3. strategy_search_results (optimizer scans, grouped by genome)
//
//  Usage:
//    VERSION=v3.42 node dump-ai-version.js   # exact match across tables
//    QUERY=3.42    node dump-ai-version.js   # fuzzy ILIKE search
//    LIST=1        node dump-ai-version.js   # list latest 30
// ════════════════════════════════════════════════════════════════

'use strict';

const { query } = require('./db');

(async () => {
  try {
    const exact = process.env.VERSION;
    const fuzzy = process.env.QUERY;
    const list  = process.env.LIST;

    if (list) {
      console.log('═══ ai_versions (latest 20) ═══');
      const r = await query(
        `SELECT id, version, trade_count, win_rate, total_pnl, created_at
         FROM ai_versions ORDER BY id DESC LIMIT 20`,
      ).catch(() => []);
      console.table(r.map(x => ({ id: x.id, version: x.version, tr: x.trade_count, wr: x.win_rate, pnl: x.total_pnl })));

      console.log('\n═══ strategy_versions (top 20 by WR) ═══');
      const sv = await query(
        `SELECT id, name, win_rate, total_trades, total_return, source, is_active, created_at
         FROM strategy_versions ORDER BY win_rate DESC NULLS LAST LIMIT 20`,
      ).catch(() => []);
      console.table(sv.map(x => ({ id: x.id, name: x.name, wr: x.win_rate, tr: x.total_trades, ret: x.total_return, src: x.source, active: x.is_active })));

      process.exit(0);
    }

    const found = [];

    // 1. ai_versions
    if (exact || fuzzy) {
      const sql = exact
        ? `SELECT * FROM ai_versions WHERE version = $1 LIMIT 5`
        : `SELECT * FROM ai_versions WHERE version ILIKE $1 LIMIT 5`;
      const args = exact ? [exact] : [`%${fuzzy}%`];
      const rows = await query(sql, args).catch(() => []);
      for (const r of rows) found.push({ table: 'ai_versions', row: r });
    }

    // 2. strategy_versions
    if (exact || fuzzy) {
      const sql = exact
        ? `SELECT * FROM strategy_versions WHERE name = $1 LIMIT 5`
        : `SELECT * FROM strategy_versions WHERE name ILIKE $1 LIMIT 5`;
      const args = exact ? [exact] : [`%${fuzzy}%`];
      const rows = await query(sql, args).catch(() => []);
      for (const r of rows) found.push({ table: 'strategy_versions', row: r });
    }

    if (!found.length) {
      console.log(`No version matching "${exact || fuzzy}" in ai_versions or strategy_versions.`);
      console.log('Try LIST=1 to see all versions, or QUERY=<part> for fuzzy match.');
      process.exit(0);
    }

    for (const f of found) {
      console.log('═'.repeat(70));
      console.log(`SOURCE: ${f.table}`);
      const r = f.row;
      console.log(`id=${r.id}  ${r.version || r.name}`);
      console.log(`created_at: ${r.created_at}`);
      console.log(`trades=${r.trade_count || r.total_trades}  WR=${r.win_rate}  total=${r.total_pnl ?? r.total_return}`);
      console.log('');
      console.log('--- PARAMS / GENOME ---');
      console.log(JSON.stringify(r.params || r.genome, null, 2));
      console.log('');
      if (r.setup_weights) {
        console.log('--- SETUP_WEIGHTS ---');
        console.log(JSON.stringify(r.setup_weights, null, 2));
      }
      if (r.avoided_coins) {
        console.log('--- AVOIDED_COINS ---');
        console.log(JSON.stringify(r.avoided_coins, null, 2));
      }
      if (r.changes) {
        console.log('--- CHANGES ---');
        console.log(r.changes);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error('dump failed:', e.stack || e.message);
    process.exit(1);
  }
})();
