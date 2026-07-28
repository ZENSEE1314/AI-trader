// Forensic trade tracer (CLI). Thin console wrapper over trade-forensics.js.
// Answers, per trade: what's OPEN; a full trace of MANUAL / Trader-Mode trades
// with a "winner cut early" flag; why losers lost + a 15m-structure follow
// check; and a same-signal cohort breakdown.
//
// Needs DB access — run where the database is reachable:
//   railway run -- node analyze-my-trades.js [email]
//   DATABASE_URL=... node analyze-my-trades.js [email]
//
// Scoping: arg[0]/EMAIL limits to one user (default all); DAYS lookback
// (default 60); SYMBOL focus for the manual trace (default ETHUSDT).

const { pool } = require('./db');
const { analyze } = require('./trade-forensics');

const EMAIL = (process.argv[2] || process.env.EMAIL || '').trim();
const DAYS  = parseInt(process.env.DAYS || '60', 10) || 60;
const FOCUS = (process.env.SYMBOL || 'ETHUSDT').toUpperCase();

const money = v => v == null ? '—' : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toFixed(2)}`;
const pct   = v => `${Number(v || 0).toFixed(1)}%`;
const iso   = t => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—');
const hr    = title => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

function line(t, extra = '') {
  return `#${t.id} ${t.symbol} ${t.direction} ${t.leverage || '?'}x`
    + ` | entry ${t.entry_price ?? '—'} → exit ${t.exit_price ?? '—'}`
    + ` | PnL ${money(t.pnl_usdt)} | ${t.status} | setup ${t.setup || '—'}`
    + ` | opened ${iso(t.created_at)} closed ${iso(t.closed_at)} (${t.duration_min == null ? '—' : t.duration_min + 'm'})`
    + (t.email ? ` | ${t.email}` : '') + extra;
}
const follow = f => f === null ? '?' : f ? 'YES' : 'NO';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Run via `railway run -- node analyze-my-trades.js` or set DATABASE_URL.');
  }
  const r = await analyze({ email: EMAIL, days: DAYS, focusSymbol: FOCUS });

  console.log(`Trade forensic report${EMAIL ? ` for ${EMAIL}` : ' (all users)'} — closed lookback ${DAYS}d, focus ${FOCUS}`);

  hr('1. OPEN TRADES (live exposure right now)');
  if (!r.open.length) console.log('None open.');
  for (const t of r.open) {
    console.log(line(t,
      ` | SL ${t.sl_price ?? '—'} TP ${t.tp_price ?? '—'} | 15m-structure ${t.structure_label || 'n/a'}`
      + ` | follows-structure ${follow(t.follows_structure)}` + (t.is_manual ? ' | ⟵ MANUAL' : '')));
  }

  hr('2. MANUAL / TRADER-MODE TRADES — full trace + early-close flag');
  if (!r.manual.length) {
    console.log('No manual / Trader-Mode trades found in window.');
    console.log('NOTE: a position opened manually OUTSIDE Trader Mode has no DB row — it can only');
    console.log('      be traced from exchange history, not from here.');
  }
  for (const t of r.manual) {
    const verdict = t.verdict === 'WINNER_CLOSED_EARLY' ? ' → ⚠️  WINNER CLOSED EARLY BY BOT EXIT'
      : t.verdict === 'bot_exit_in_loss' ? ' → closed by bot exit (was in loss)'
      : t.verdict === 'winner' ? ' → winner (SL/TP/manual)'
      : t.verdict === 'open' ? ' → still open' : ' → loser';
    console.log('\n' + line(t));
    console.log(`   why closed : ${t.why_closed}${verdict}`);
    console.log(`   structure  : ${t.structure_label || 'n/a'} | direction vs structure: ${t.follows_structure === null ? 'unclear' : t.follows_structure ? 'followed' : 'AGAINST'}`);
    console.log(`   NOTE: the system does not store WHY you opened a manual trade — only market context above.`);
  }

  hr(`3. LOSING TRADES (last ${DAYS}d) — why they lost + structure check`);
  if (!r.losers.trades.length) console.log('No losing closed trades in window.');
  for (const t of r.losers.trades) {
    console.log(line(t, ` | why: ${t.why_closed} | structure ${t.structure_label || 'n/a'} | followed ${follow(t.follows_structure)}${t.follows_structure === false ? ' ⚠️' : ''}`));
  }
  if (r.losers.trades.length) {
    console.log(`\nOf ${r.losers.total} losers, ${r.losers.against_structure} were opened AGAINST 15m structure (${pct(r.losers.against_structure_pct)}).`);
  }

  hr(`4. SAME-SIGNAL COHORT — every trade grouped by setup (last ${DAYS}d)`);
  if (!r.cohorts.length) console.log('No closed trades to group.');
  for (const c of r.cohorts) {
    console.log(`${c.signal} ${c.direction}  | trades ${c.trades} | WR ${pct(c.win_rate)} | net ${money(c.net)} | avg ${money(c.avg)}`);
  }

  if (r.peers.length) {
    hr(`4b. PEERS OF YOUR MANUAL SIGNAL(S): ${r.manual_signals.join(', ')}`);
    for (const t of r.peers) {
      console.log(line(t, ` | why: ${t.why_closed}${t.early_close ? ' ⚠️ winner cut early' : ''}`));
    }
  }

  if (r.winners_cut_early.length) {
    hr('SUMMARY: winners the bot cut early');
    for (const w of r.winners_cut_early) {
      console.log(`#${w.id} ${w.symbol} ${w.direction} | +${money(w.pnl_usdt)} closed by ${w.exit_reason}`);
    }
  }
  console.log('\nLegend: ⚠️ WINNER CLOSED EARLY = trade was in profit when a bot exit'
    + ' (structure/reversal/swarm) closed it. That is the pattern behind the ETH complaint.');
}

main()
  .catch(err => { console.error(`\nAnalysis failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
