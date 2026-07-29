// Backtest the entry guards against REAL historical trades.
//
// For every closed trade in the window it reconstructs the klines as they were
// AT the entry time (Bybit &end=) and asks entry-guards.evaluateEntry() whether
// it would have blocked the trade — then tallies the P&L WITH vs WITHOUT the
// guard. This answers the only question that matters: would the guard have
// blocked your losers without killing your winners?
//
// Honest by construction: it replays your own fills, not a synthetic signal set.
// A trade whose history can't be fetched is left ALLOWED (fail-open) and counted
// as "not evaluable" so it never flatters the result.
//
// Needs DB + network (production):
//   railway run -- node backtest-entry-guards.js [email]
// Env: DAYS (default 90), SYMBOLS (filter, e.g. ETHUSDT,SOLUSDT),
//      plus the ENTRY_GUARD_* tuning vars (LIQ_PROX_PCT, TREND, LIQUIDITY).

process.env.ENTRY_GUARDS_ENABLED = '1'; // force guard on for evaluation

const { query, pool } = require('./db');
const { fetchCandlesUpTo } = require('./trade-deep-analysis');
const { evaluateEntry } = require('./entry-guards');

const EMAIL = (process.argv[2] || process.env.EMAIL || '').trim();
const DAYS  = Math.max(1, parseInt(process.env.DAYS || '90', 10) || 90);
const SYMS  = (process.env.SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const money = n => (n < 0 ? '−$' : '+$') + Math.abs(Number(n || 0)).toFixed(2);
const pct   = n => `${Number(n || 0).toFixed(1)}%`;

async function evalTrade(t) {
  const entryMs = +new Date(t.created_at);
  let c4h = null, c15 = null;
  try {
    [c4h, c15] = await Promise.all([
      fetchCandlesUpTo(t.symbol, '4h', 220, entryMs),
      fetchCandlesUpTo(t.symbol, '15m', 150, entryMs),
    ]);
  } catch {}
  if (!c4h || !c15) return { ...t, evaluable: false, allow: true, reason: 'no klines' };
  const g = await evaluateEntry({ symbol: t.symbol, direction: t.direction, candles4h: c4h, candles15m: c15 });
  const rule = !g.allow ? (/trend/i.test(g.reason) ? 'trend' : /EQH|EQL|liquidity/i.test(g.reason) ? 'liquidity' : 'other') : null;
  return { ...t, evaluable: g.checked !== false, allow: g.allow, reason: g.reason || 'allowed', rule };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set — run via `railway run`.');

  const params = [String(DAYS)];
  let ef = '';
  if (EMAIL) { params.push(EMAIL); ef = `AND LOWER(u.email) = LOWER($${params.length})`; }
  let sf = '';
  if (SYMS.length) { params.push(SYMS); sf = `AND UPPER(t.symbol) = ANY($${params.length})`; }
  const trades = await query(
    `SELECT t.id, t.symbol, t.direction, t.created_at, t.pnl_usdt
       FROM trades t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.status IN ('WIN','LOSS','TP','SL','CLOSED') AND t.pnl_usdt IS NOT NULL
        AND t.created_at > NOW() - ($1::text || ' days')::interval
        ${ef} ${sf}
      ORDER BY t.created_at ASC`, params);

  if (!trades.length) { console.log('No closed trades in window.'); return; }
  console.log(`Backtesting entry guards on ${trades.length} real trades${EMAIL ? ' for ' + EMAIL : ''} — last ${DAYS}d`);
  console.log(`Guard config: TREND=${process.env.ENTRY_GUARD_TREND !== '0'} LIQUIDITY=${process.env.ENTRY_GUARD_LIQUIDITY !== '0'} LIQ_PROX=${process.env.ENTRY_GUARD_LIQ_PROX_PCT || '0.4'}%\n`);

  // Evaluate in small batches to be kind to Bybit.
  const evald = [];
  for (let i = 0; i < trades.length; i += 4) {
    evald.push(...await Promise.all(trades.slice(i, i + 4).map(evalTrade)));
    process.stdout.write(`\r  evaluated ${Math.min(i + 4, trades.length)}/${trades.length}`);
  }
  console.log('\n');

  const sum = a => a.reduce((s, t) => s + Number(t.pnl_usdt), 0);
  const allowed = evald.filter(t => t.allow);
  const blocked = evald.filter(t => !t.allow);
  const notEval = evald.filter(t => !t.evaluable);
  const blockedLosers  = blocked.filter(t => Number(t.pnl_usdt) <= 0);
  const blockedWinners = blocked.filter(t => Number(t.pnl_usdt) > 0);

  const actualNet = sum(evald);
  const guardNet  = sum(allowed);
  const wr = a => a.length ? a.filter(t => Number(t.pnl_usdt) > 0).length / a.length * 100 : 0;

  console.log('══════════ RESULT: WITH vs WITHOUT guard ══════════');
  console.log(`Trades:            ${evald.length}  (evaluable ${evald.length - notEval.length}, no-klines ${notEval.length})`);
  console.log(`WITHOUT guard:     net ${money(actualNet)}  | WR ${pct(wr(evald))}  | n ${evald.length}`);
  console.log(`WITH guard:        net ${money(guardNet)}  | WR ${pct(wr(allowed))}  | n ${allowed.length} (took ${allowed.length}, skipped ${blocked.length})`);
  console.log(`Δ from guard:      ${money(guardNet - actualNet)}\n`);

  console.log(`Blocked ${blocked.length} trades: ${blockedLosers.length} losers (saved ${money(-sum(blockedLosers))}), `
    + `${blockedWinners.length} winners (gave up ${money(-sum(blockedWinners))})`);
  const byRule = {};
  for (const t of blocked) (byRule[t.rule] ??= []).push(t);
  for (const [r, ts] of Object.entries(byRule))
    console.log(`  · ${r}: blocked ${ts.length} | net of those ${money(sum(ts))} (positive = guard cut winners)`);

  console.log('\nBlock precision (did it block the right ones?):');
  console.log(`  ${blocked.length ? pct(blockedLosers.length / blocked.length * 100) : '0%'} of blocked trades were losers.`);

  console.log('\n── Sample of blocked trades ──');
  for (const t of blocked.slice(0, 15))
    console.log(`  #${t.id} ${t.symbol} ${t.direction} pnl ${money(t.pnl_usdt)} — ${t.reason}`);

  if (notEval.length)
    console.log(`\nNote: ${notEval.length} trades had no fetchable klines at entry time and were left ALLOWED (fail-open).`);
  console.log('\nVerdict rule: enable live only if WITH-guard net > WITHOUT and block precision is clearly >50%.');
}

main()
  .catch(e => { console.error(`\nBacktest failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
