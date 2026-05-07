// ════════════════════════════════════════════════════════════════
//  loss-pattern-analysis.js
//  Query ai_trades for recent losses, group by indicator dimensions,
//  and surface the patterns most associated with losing trades.
//
//  Usage:
//    DAYS=14 MIN_LOSSES=3 node loss-pattern-analysis.js
//
//  Posts a ranked list of loser-buckets so we can blacklist them.
// ════════════════════════════════════════════════════════════════

'use strict';

const { query } = require('./db');

const DAYS = parseInt(process.env.DAYS || '14', 10);
const MIN_LOSSES = parseInt(process.env.MIN_LOSSES || '3', 10);

function pad(s, n) { return String(s ?? '-').slice(0, n).padEnd(n); }
function pct(x) { return (x * 100).toFixed(1) + '%'; }

(async () => {
  try {
    const since = `NOW() - INTERVAL '${DAYS} days'`;

    const rows = await query(`
      SELECT symbol, direction, setup, market_structure, tf_15m, tf_3m, tf_1m,
             trend_1h, session, exit_reason, is_win, pnl_pct, leverage, closed_at
      FROM ai_trades
      WHERE closed_at >= ${since}
    `);

    if (!rows.length) {
      console.log(`No ai_trades closed in last ${DAYS} days.`);
      process.exit(0);
    }

    const total = rows.length;
    const losses = rows.filter(r => Number(r.is_win) === 0).length;
    const wins   = total - losses;
    const overallWR = wins / total;

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  LOSS PATTERN ANALYSIS — last ${DAYS} days`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Total trades: ${total}  |  WIN: ${wins}  |  LOSS: ${losses}  |  WR: ${pct(overallWR)}`);
    console.log('');

    // Group by various dimensions. For each value: trades, losses, WR, total pnl.
    const dims = {
      symbol:           r => r.symbol,
      direction:        r => r.direction,
      setup:            r => r.setup,
      'symbol+dir':     r => `${r.symbol}/${r.direction}`,
      market_structure: r => r.market_structure,
      tf_15m:           r => r.tf_15m,
      tf_3m:            r => r.tf_3m,
      tf_1m:            r => r.tf_1m,
      trend_1h:         r => r.trend_1h,
      session:          r => r.session,
      exit_reason:      r => r.exit_reason,
    };

    for (const [name, getter] of Object.entries(dims)) {
      const buckets = new Map();
      for (const r of rows) {
        const k = getter(r);
        if (k == null || k === '') continue;
        if (!buckets.has(k)) buckets.set(k, { trades: 0, losses: 0, pnl: 0 });
        const b = buckets.get(k);
        b.trades++;
        if (Number(r.is_win) === 0) b.losses++;
        b.pnl += Number(r.pnl_pct || 0);
      }

      const arr = [...buckets.entries()]
        .map(([k, b]) => ({
          k, trades: b.trades, losses: b.losses,
          wr: 1 - b.losses / b.trades,
          pnl: b.pnl,
        }))
        .filter(x => x.losses >= MIN_LOSSES)
        .sort((a, b) => a.wr - b.wr);

      if (!arr.length) continue;
      console.log(`── BY ${name.toUpperCase()} (≥${MIN_LOSSES} losses) ──`);
      console.log('  value                              trades  loss   WR     sum pnl%');
      for (const x of arr.slice(0, 12)) {
        const flag = x.wr < overallWR - 0.05 ? '🔴' : x.wr < overallWR ? '⚠️ ' : '  ';
        console.log(`  ${flag}${pad(x.k, 33)}  ${String(x.trades).padStart(5)}  ${String(x.losses).padStart(4)}  ${pad(pct(x.wr), 6)} ${x.pnl.toFixed(1).padStart(7)}`);
      }
      console.log('');
    }

    // 2-dim crosses to find compound losers.
    const compoundDims = [
      ['symbol', 'direction'],
      ['setup', 'direction'],
      ['symbol', 'session'],
      ['market_structure', 'direction'],
      ['tf_15m', 'direction'],
    ];

    console.log('═══ COMPOUND LOSERS (2D crosses, sorted by WR ascending) ═══');
    for (const [a, b] of compoundDims) {
      const buckets = new Map();
      for (const r of rows) {
        const ka = r[a === 'symbol' ? 'symbol' : a] ?? null;
        const kb = r[b === 'direction' ? 'direction' : b] ?? null;
        if (!ka || !kb) continue;
        const k = `${ka} × ${kb}`;
        if (!buckets.has(k)) buckets.set(k, { trades: 0, losses: 0, pnl: 0 });
        const o = buckets.get(k);
        o.trades++;
        if (Number(r.is_win) === 0) o.losses++;
        o.pnl += Number(r.pnl_pct || 0);
      }
      const arr = [...buckets.entries()]
        .map(([k, o]) => ({ k, trades: o.trades, losses: o.losses, wr: 1 - o.losses/o.trades, pnl: o.pnl }))
        .filter(x => x.losses >= MIN_LOSSES)
        .sort((a, b) => a.wr - b.wr)
        .slice(0, 8);
      if (!arr.length) continue;
      console.log(`── ${a} × ${b} ──`);
      for (const x of arr) {
        const flag = x.wr < 0.4 ? '🔴' : x.wr < overallWR ? '⚠️ ' : '  ';
        console.log(`  ${flag}${pad(x.k, 40)}  ${String(x.trades).padStart(5)}  ${String(x.losses).padStart(4)}  ${pad(pct(x.wr), 6)} ${x.pnl.toFixed(1).padStart(7)}`);
      }
      console.log('');
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SUGGESTED BLACKLIST (WR < 40% AND ≥ 5 losses)');
    console.log('═══════════════════════════════════════════════════════════');
    const all = [];
    for (const [name, getter] of Object.entries(dims)) {
      const buckets = new Map();
      for (const r of rows) {
        const k = getter(r);
        if (k == null || k === '') continue;
        if (!buckets.has(k)) buckets.set(k, { trades: 0, losses: 0 });
        const b = buckets.get(k);
        b.trades++;
        if (Number(r.is_win) === 0) b.losses++;
      }
      for (const [k, b] of buckets) {
        const wr = 1 - b.losses/b.trades;
        if (wr < 0.4 && b.losses >= 5) {
          all.push({ dim: name, value: k, trades: b.trades, losses: b.losses, wr });
        }
      }
    }
    all.sort((a,b) => a.wr - b.wr);
    for (const x of all) {
      console.log(`  block ${pad(x.dim, 18)} = ${pad(x.value, 26)}  (${x.trades}t, ${x.losses}L, WR ${pct(x.wr)})`);
    }
    if (!all.length) console.log('  (none)');

    process.exit(0);
  } catch (e) {
    console.error('Failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
