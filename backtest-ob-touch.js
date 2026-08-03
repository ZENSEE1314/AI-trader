// Backtest the OB-touch SHORT gate against REAL historical trades.
//
// For every closed SHORT in the window it reconstructs the 15m klines as they
// were AT the entry time (Bybit &end=) and asks ob-touch.evaluateShortOBTouch()
// whether the entry sat at a tagged bearish order block — then tallies the P&L
// WITH vs WITHOUT the gate. The only question that matters: does requiring an OB
// touch cut the mid-range losing shorts without killing the winners?
//
// LONGs are never evaluated (the gate is short-only); they pass through unchanged
// and are added to the WITH-gate net as-is, so the comparison is apples-to-apples
// on the whole book while isolating the gate's effect on shorts.
//
// Honest by construction: it replays your own fills, not a synthetic signal set.
// A short whose klines can't be fetched is left ALLOWED (fail-open) and counted
// as "not evaluable" so it never flatters the result.
//
// Needs DB + network (production / Railway — Bybit egress is blocked elsewhere):
//   railway run -- node backtest-ob-touch.js [email]
// Env: DAYS (default 90), SYMBOLS (filter, default SOLUSDT), plus the OB_TOUCH_*
//      tuning vars (MAX_DIST_PCT, TAG_WINDOW).
//
// Offline logic check (no DB, no network — runnable anywhere):
//   node backtest-ob-touch.js --selftest

process.env.OB_TOUCH_SHORTS_ENABLED = '1';            // force gate on for evaluation
if (!process.env.OB_TOUCH_SYMBOLS && !process.argv.includes('--selftest'))
  process.env.OB_TOUCH_SYMBOLS = process.env.SYMBOLS || 'SOLUSDT';

const money = n => (n < 0 ? '−$' : '+$') + Math.abs(Number(n || 0)).toFixed(2);
const pct   = n => `${Number(n || 0).toFixed(1)}%`;

// ─────────────────────────────────────────────────────────────────────────────
// Offline self-test: proves decideShortFromOBs behaves — no DB / network needed.
// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const { decideShortFromOBs } = require('./ob-touch');
  const ob = { type: 'BEARISH_OB', bbDirection: 'BEARISH', bottom: 74.40, top: 74.90 };
  const breaker = { type: 'BEARISH_OB', bbDirection: 'BULLISH', bottom: 74.40, top: 74.90 };
  const tol = 0.005;
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    console.log(`  ${ok ? '✓' : '✗'} ${name}: allow=${got} (want ${want})`);
    ok ? pass++ : fail++;
  };

  // Entry AT the OB top, price tagged the zone → SHORT allowed.
  check('at OB top, tagged',
    decideShortFromOBs([ob], 74.88, { recentHigh: 74.92, tol }).allow, true);
  // Entry in the middle of the range, well below the OB, never tagged → BLOCKED.
  check('mid-range, no tag (the reported case)',
    decideShortFromOBs([ob], 74.06, { recentHigh: 74.06, tol }).allow, false);
  // Entry near the top but price never reached the OB → BLOCKED (no tag).
  check('near top but untagged',
    decideShortFromOBs([{ ...ob, bottom: 74.85, top: 74.95 }], 74.90, { recentHigh: 74.70, tol }).allow, false);
  // OB was broken and flipped bullish (breaker) → BLOCKED (don't short a breaker).
  check('broken breaker block',
    decideShortFromOBs([breaker], 74.88, { recentHigh: 74.92, tol }).allow, false);
  // Entry inside the upper half of the OB, tagged → allowed.
  check('inside upper half, tagged',
    decideShortFromOBs([ob], 74.70, { recentHigh: 74.95, tol }).allow, true);
  // No OBs at all → BLOCKED.
  check('no OBs present',
    decideShortFromOBs([], 74.88, { recentHigh: 74.92, tol }).allow, false);

  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB replay (production).
// ─────────────────────────────────────────────────────────────────────────────
async function replay() {
  const { query, pool } = require('./db');
  const { fetchCandlesUpTo } = require('./trade-deep-analysis');
  const { evaluateShortOBTouch } = require('./ob-touch');

  const EMAIL = (process.argv.find(a => a.includes('@')) || process.env.EMAIL || '').trim();
  const DAYS  = Math.max(1, parseInt(process.env.DAYS || '90', 10) || 90);
  const SYMS  = (process.env.OB_TOUCH_SYMBOLS || 'SOLUSDT')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set — run via `railway run`.');

  const params = [String(DAYS)];
  let ef = '';
  if (EMAIL) { params.push(EMAIL); ef = `AND LOWER(u.email) = LOWER($${params.length})`; }
  let sf = '';
  if (SYMS.length) { params.push(SYMS); sf = `AND UPPER(t.symbol) = ANY($${params.length})`; }

  const trades = await query(
    `SELECT t.id, t.symbol, t.direction, t.entry_price, t.created_at, t.pnl_usdt
       FROM trades t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.status IN ('WIN','LOSS','TP','SL','CLOSED') AND t.pnl_usdt IS NOT NULL
        AND t.created_at > NOW() - ($1::text || ' days')::interval
        ${ef} ${sf}
      ORDER BY t.created_at ASC`, params);

  if (!trades.length) { console.log('No closed trades in window.'); return; }
  console.log(`Backtesting OB-touch SHORT gate on ${trades.length} real trades`
    + `${EMAIL ? ' for ' + EMAIL : ''} — ${SYMS.join(',')} — last ${DAYS}d`);
  console.log(`Gate config: MAX_DIST=${process.env.OB_TOUCH_MAX_DIST_PCT || '0.5'}% `
    + `TAG_WINDOW=${process.env.OB_TOUCH_TAG_WINDOW || '12'}\n`);

  const evalTrade = async (t) => {
    const dir = String(t.direction || '').toUpperCase();
    if (dir !== 'SHORT') return { ...t, evaluable: false, allow: true, reason: 'long — not gated' };
    const entryMs = +new Date(t.created_at);
    let c15 = null;
    try { c15 = await fetchCandlesUpTo(t.symbol, '15m', 150, entryMs); } catch {}
    if (!c15 || c15.length < 40) return { ...t, evaluable: false, allow: true, reason: 'no klines' };
    const g = await evaluateShortOBTouch({
      symbol: t.symbol, direction: 'SHORT',
      price: t.entry_price != null ? Number(t.entry_price) : null,
      candles15m: c15,
    });
    return { ...t, evaluable: g.checked !== false, allow: g.allow, reason: g.reason || (g.reasons || []).join('; ') || 'allowed' };
  };

  const evald = [];
  for (let i = 0; i < trades.length; i += 4) {
    evald.push(...await Promise.all(trades.slice(i, i + 4).map(evalTrade)));
    process.stdout.write(`\r  evaluated ${Math.min(i + 4, trades.length)}/${trades.length}`);
  }
  console.log('\n');

  const sum = a => a.reduce((s, t) => s + Number(t.pnl_usdt), 0);
  const wr  = a => a.length ? a.filter(t => Number(t.pnl_usdt) > 0).length / a.length * 100 : 0;

  const shorts       = evald.filter(t => String(t.direction).toUpperCase() === 'SHORT');
  const longs        = evald.filter(t => String(t.direction).toUpperCase() !== 'SHORT');
  const shortsEval    = shorts.filter(t => t.evaluable);
  const notEval       = shorts.filter(t => !t.evaluable);
  const shortsAllowed = shorts.filter(t => t.allow);
  const shortsBlocked = shorts.filter(t => !t.allow);
  const blockedLosers  = shortsBlocked.filter(t => Number(t.pnl_usdt) <= 0);
  const blockedWinners = shortsBlocked.filter(t => Number(t.pnl_usdt) > 0);

  const bookWithout = sum(evald);
  const bookWith    = sum(longs) + sum(shortsAllowed);   // longs untouched + surviving shorts

  console.log('══════════ RESULT: WITH vs WITHOUT the OB-touch gate ══════════');
  console.log(`Shorts:            ${shorts.length}  (evaluable ${shortsEval.length}, no-klines ${notEval.length})`);
  console.log(`SHORTS without gate: net ${money(sum(shorts))}  | WR ${pct(wr(shorts))}  | n ${shorts.length}`);
  console.log(`SHORTS with gate:    net ${money(sum(shortsAllowed))}  | WR ${pct(wr(shortsAllowed))}  | n ${shortsAllowed.length} (took ${shortsAllowed.length}, skipped ${shortsBlocked.length})`);
  console.log(`Δ on shorts:         ${money(sum(shortsAllowed) - sum(shorts))}\n`);

  console.log(`Whole book without gate: net ${money(bookWithout)}  | WR ${pct(wr(evald))}  | n ${evald.length}`);
  console.log(`Whole book with gate:    net ${money(bookWith)}  (longs ${longs.length} untouched)\n`);

  console.log(`Blocked ${shortsBlocked.length} shorts: ${blockedLosers.length} losers (saved ${money(-sum(blockedLosers))}), `
    + `${blockedWinners.length} winners (gave up ${money(-sum(blockedWinners))})`);
  console.log(`Block precision: ${shortsBlocked.length ? pct(blockedLosers.length / shortsBlocked.length * 100) : '0%'} of blocked shorts were losers.\n`);

  console.log('── Sample of blocked shorts ──');
  for (const t of shortsBlocked.slice(0, 15))
    console.log(`  #${t.id} ${t.symbol} SHORT pnl ${money(t.pnl_usdt)} — ${t.reason}`);

  if (notEval.length)
    console.log(`\nNote: ${notEval.length} shorts had no fetchable klines and were left ALLOWED (fail-open).`);
  console.log('\nVerdict rule: enable live only if WITH-gate short net > WITHOUT and block precision is clearly >50%.');

  await pool.end().catch(() => {});
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  replay().catch(e => { console.error(`\nBacktest failed: ${e.message}`); process.exitCode = 1; });
}
