// Forensic trade tracer — answers, per trade:
//   1. What is still OPEN right now?
//   2. Trace every MANUAL / Trader-Mode trade: entry → exit, PnL, WHY it closed,
//      and FLAG winners the bot cut early (closed in profit by a bot exit).
//   3. Why did the losers lose, and did the direction follow 15m structure?
//   4. Same-signal cohort: how every trade sharing that setup performed.
//
// This reads your LIVE trades table, so it needs DB access. Run it where the
// database is reachable:
//   railway run -- node analyze-my-trades.js [email]
//   DATABASE_URL=... node analyze-my-trades.js [email]
//
// Optional scoping:
//   arg[0] / EMAIL   — limit to one user's trades (default: all users)
//   DAYS             — lookback window for closed trades (default 60)
//   SYMBOL           — focus symbol for the manual trace (default ETHUSDT)

const fs = require('fs');
const path = require('path');
const { query, pool, initAllTables } = require('./db');

const EMAIL  = (process.argv[2] || process.env.EMAIL || '').trim();
const DAYS   = Math.max(1, parseInt(process.env.DAYS || '60', 10) || 60);
const FOCUS  = (process.env.SYMBOL || 'ETHUSDT').toUpperCase();

// Exit reasons the BOT sets when it closes a position itself (as opposed to a
// stop-loss / TP / manual close). A profitable trade closed with one of these
// is a "winner the bot cut early".
const BOT_EXIT = /(expo_structure|reversal|swarm|structure_break)/i;
const TP_EXIT  = /(smc_tp|take_?profit|\btp\b)/i;

const money = v => `${Number(v || 0) < 0 ? '-' : ''}$${Math.abs(Number(v || 0)).toFixed(2)}`;
const pct   = v => `${Number(v || 0).toFixed(1)}%`;
const iso   = t => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—');
const isManual = t => String(t.setup || '').toUpperCase() === 'MANUAL'
                   || String(t.market_structure || '').toUpperCase() === 'TRADER_MODE';

function hr(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

// ── Best-effort: what did 15m structure look like when the trade opened? ──
// Reads the cached expo labels (data/expo-labels/<SYM>-15m-expo.json). Returns
// the most-recent HH/HL/LH/LL label at or before `atMs`, or null.
const labelCache = {};
function structureAt(symbol, atMs) {
  if (!atMs) return null;
  const sym = symbol.toUpperCase();
  if (!(sym in labelCache)) {
    const file = path.join(__dirname, 'data', 'expo-labels', `${sym}-15m-expo.json`);
    try { labelCache[sym] = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { labelCache[sym] = null; }
  }
  const labels = labelCache[sym];
  if (!Array.isArray(labels) || !labels.length) return null;
  let found = null;
  for (const l of labels) {
    const t = Number(l.time) * (String(l.time).length <= 10 ? 1000 : 1); // sec or ms
    if (t <= atMs) found = { ...l, tMs: t }; else break;
  }
  return found;
}

// Does the entry direction agree with the structure bias? (HL/HH ⇒ long bias,
// LH/LL ⇒ short bias.) `structureLabel` may come from tf_15m or the cache.
function followsStructure(direction, label) {
  if (!label) return null; // unknown — no structure recorded
  const up   = /HL|HH/i.test(label);
  const down = /LH|LL/i.test(label);
  const dir  = String(direction || '').toUpperCase();
  if (dir === 'LONG'  && up)   return true;
  if (dir === 'SHORT' && down) return true;
  if ((dir === 'LONG' && down) || (dir === 'SHORT' && up)) return false;
  return null;
}

function whyClosed(t) {
  const r = String(t.exit_reason || '').toLowerCase();
  if (!r) {
    if (t.status === 'OPEN') return 'still open';
    return Number(t.pnl_usdt) < 0 ? 'stop-loss / liquidation or manual close (no reason recorded)'
                                  : 'closed on exchange / manual (no reason recorded)';
  }
  if (BOT_EXIT.test(r)) return `BOT exit — ${t.exit_reason}`;
  if (TP_EXIT.test(r))  return `take-profit — ${t.exit_reason}`;
  return t.exit_reason;
}

async function fetchTrades(extraWhere, params) {
  const emailJoin   = 'LEFT JOIN users u ON u.id = t.user_id';
  const emailFilter = EMAIL ? `AND LOWER(u.email) = LOWER($${params.length + 1})` : '';
  if (EMAIL) params = [...params, EMAIL];
  return query(
    `SELECT t.*, u.email
       FROM trades t ${emailJoin}
      WHERE ${extraWhere} ${emailFilter}
      ORDER BY COALESCE(t.closed_at, t.created_at) DESC`,
    params
  );
}

function line(t, extra = '') {
  const dur = t.created_at && t.closed_at
    ? `${Math.round((new Date(t.closed_at) - new Date(t.created_at)) / 60000)}m` : '—';
  return `#${t.id} ${t.symbol} ${t.direction} ${t.leverage || '?'}x`
    + ` | entry ${t.entry_price ?? '—'} → exit ${t.exit_price ?? '—'}`
    + ` | PnL ${t.pnl_usdt == null ? '—' : money(t.pnl_usdt)}`
    + ` | ${t.status} | setup ${t.setup || t.market_structure || '—'}`
    + ` | opened ${iso(t.created_at)} closed ${iso(t.closed_at)} (${dur})`
    + (t.email ? ` | ${t.email}` : '') + extra;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Run via `railway run -- node analyze-my-trades.js` or set DATABASE_URL.');
  }
  await initAllTables();

  console.log(`Trade forensic report${EMAIL ? ` for ${EMAIL}` : ' (all users)'} — closed lookback ${DAYS}d, focus ${FOCUS}`);

  // ── 1. OPEN TRADES ────────────────────────────────────────────────────
  hr('1. OPEN TRADES (live exposure right now)');
  const open = await fetchTrades(`t.status = 'OPEN'`, []);
  if (!open.length) console.log('None open.');
  for (const t of open) {
    const label = t.tf_15m || (structureAt(t.symbol, +new Date(t.created_at))?.type);
    const fs2 = followsStructure(t.direction, label);
    console.log(line(t,
      ` | SL ${t.sl_price ?? '—'} TP ${t.tp_price ?? '—'} | 15m-structure ${label || 'n/a'}`
      + ` | follows-structure ${fs2 === null ? '?' : fs2 ? 'YES' : 'NO'}`
      + (isManual(t) ? ' | ⟵ MANUAL' : '')));
  }

  // ── 2. MANUAL / TRADER-MODE TRACE ─────────────────────────────────────
  hr('2. MANUAL / TRADER-MODE TRADES — full trace + early-close flag');
  const manual = await fetchTrades(
    `(UPPER(COALESCE(t.setup,'')) = 'MANUAL' OR UPPER(COALESCE(t.market_structure,'')) = 'TRADER_MODE')
     AND COALESCE(t.closed_at, t.created_at) > NOW() - ($1::text || ' days')::interval`,
    [String(DAYS)]
  );
  if (!manual.length) {
    console.log('No manual / Trader-Mode trades found in window.');
    console.log('NOTE: a position opened manually OUTSIDE Trader Mode has no DB row — it can only');
    console.log('      be traced from exchange history, not from here.');
  }
  for (const t of manual) {
    const entryLabel = structureAt(t.symbol, +new Date(t.created_at));
    const closedInProfit = Number(t.pnl_usdt) > 0;
    const botCut = BOT_EXIT.test(String(t.exit_reason || ''));
    let verdict = '';
    if (t.status === 'OPEN') verdict = ' → still open';
    else if (closedInProfit && botCut) verdict = ' → ⚠️  WINNER CLOSED EARLY BY BOT EXIT';
    else if (botCut) verdict = ' → closed by bot exit (was in loss)';
    else if (closedInProfit) verdict = ' → winner (SL/TP/manual)';
    else verdict = ' → loser';
    console.log('\n' + line(t));
    console.log(`   why closed : ${whyClosed(t)}${verdict}`);
    console.log(`   structure  : recorded=${t.tf_15m || 'n/a'} | cached-at-entry=${entryLabel ? entryLabel.type + '@' + iso(entryLabel.tMs) : 'n/a'}`);
    if (entryLabel) {
      const fs2 = followsStructure(t.direction, entryLabel.type);
      console.log(`   direction vs structure: ${fs2 === null ? 'unclear' : fs2 ? 'followed structure' : 'AGAINST structure'}`);
    }
    console.log(`   NOTE: the system does not store WHY you opened a manual trade — only the`);
    console.log(`         market context above (structure label, entry vs SL/TP) is available.`);
  }

  // ── 3. LOSERS — why, and did they follow structure? ───────────────────
  hr(`3. LOSING TRADES (last ${DAYS}d) — why they lost + structure check`);
  const losers = await fetchTrades(
    `t.status IN ('WIN','LOSS','TP','SL','CLOSED') AND t.pnl_usdt IS NOT NULL AND t.pnl_usdt < 0
     AND COALESCE(t.closed_at, t.created_at) > NOW() - ($1::text || ' days')::interval`,
    [String(DAYS)]
  );
  if (!losers.length) console.log('No losing closed trades in window.');
  let against = 0;
  for (const t of losers) {
    const label = t.tf_15m || structureAt(t.symbol, +new Date(t.created_at))?.type;
    const fs2 = followsStructure(t.direction, label);
    if (fs2 === false) against++;
    console.log(line(t, ` | why: ${whyClosed(t)} | structure ${label || 'n/a'} | followed ${fs2 === null ? '?' : fs2 ? 'YES' : 'NO ⚠️'}`));
  }
  if (losers.length) {
    console.log(`\nOf ${losers.length} losers, ${against} were opened AGAINST 15m structure`
      + ` (${pct(against / losers.length * 100)}).`);
  }

  // ── 4. SAME-SIGNAL COHORT ─────────────────────────────────────────────
  hr(`4. SAME-SIGNAL COHORT — every trade grouped by setup (last ${DAYS}d)`);
  const cohorts = await query(
    `SELECT COALESCE(NULLIF(t.setup,''), t.market_structure, 'unknown') AS signal,
            t.direction,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE t.pnl_usdt > 0)::int AS wins,
            ROUND(SUM(t.pnl_usdt)::numeric, 2)::float AS net,
            ROUND(AVG(t.pnl_usdt)::numeric, 2)::float AS avg
       FROM trades t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.status IN ('WIN','LOSS','TP','SL','CLOSED') AND t.pnl_usdt IS NOT NULL
        AND COALESCE(t.closed_at, t.created_at) > NOW() - ($1::text || ' days')::interval
        ${EMAIL ? 'AND LOWER(u.email) = LOWER($2)' : ''}
      GROUP BY signal, t.direction
      ORDER BY net ASC`,
    EMAIL ? [String(DAYS), EMAIL] : [String(DAYS)]
  );
  if (!cohorts.length) console.log('No closed trades to group.');
  for (const c of cohorts) {
    const wr = c.n ? (c.wins / c.n * 100) : 0;
    console.log(`${c.signal} ${c.direction}  | trades ${c.n} | WR ${pct(wr)} | net ${money(c.net)} | avg ${money(c.avg)}`);
  }

  // Same-signal peers of the manual trade(s)
  const manualSignals = [...new Set(manual.map(t => (t.setup || t.market_structure || 'unknown')))];
  if (manualSignals.length) {
    hr(`4b. PEERS OF YOUR MANUAL SIGNAL(S): ${manualSignals.join(', ')}`);
    const peers = await fetchTrades(
      `COALESCE(NULLIF(t.setup,''), t.market_structure,'unknown') = ANY($1)
       AND COALESCE(t.closed_at, t.created_at) > NOW() - ($2::text || ' days')::interval`,
      [manualSignals, String(DAYS)]
    );
    for (const t of peers) {
      const botCut = BOT_EXIT.test(String(t.exit_reason || ''));
      const flag = Number(t.pnl_usdt) > 0 && botCut ? ' ⚠️ winner cut early' : '';
      console.log(line(t, ` | why: ${whyClosed(t)}${flag}`));
    }
  }

  console.log('\nLegend: ⚠️ WINNER CLOSED EARLY = trade was in profit when a bot exit'
    + ' (structure/reversal/swarm) closed it. That is the pattern behind the ETH complaint.');
}

main()
  .catch(err => { console.error(`\nAnalysis failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
