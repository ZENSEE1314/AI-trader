// Shared trade-forensics engine.
// One source of truth for both the CLI (analyze-my-trades.js) and the admin
// dashboard endpoint (GET /api/admin/trade-forensics).
//
// Answers, per trade: what's OPEN; full trace of MANUAL / Trader-Mode trades
// with a "winner cut early" flag; why losers lost + a 15m-structure follow
// check; and a same-signal cohort breakdown.

const fs = require('fs');
const path = require('path');
const { query } = require('./db');

// Exit reasons the BOT sets when it closes a position itself (vs SL / TP /
// manual). A profitable trade closed with one of these is a winner cut early.
const BOT_EXIT = /(expo_structure|reversal|swarm|structure_break)/i;
const TP_EXIT  = /(smc_tp|take_?profit|\btp\b)/i;

const isManual = t => String(t.setup || '').toUpperCase() === 'MANUAL'
                   || String(t.market_structure || '').toUpperCase() === 'TRADER_MODE';

const durationMin = t => (t.created_at && t.closed_at)
  ? Math.round((new Date(t.closed_at) - new Date(t.created_at)) / 60000) : null;

// Best-effort: the most-recent HH/HL/LH/LL label at/before `atMs`, from the
// cached expo labels (data/expo-labels/<SYM>-15m-expo.json). null if unknown.
const _labelCache = {};
function structureAt(symbol, atMs) {
  if (!atMs) return null;
  const sym = String(symbol || '').toUpperCase();
  if (!(sym in _labelCache)) {
    const file = path.join(__dirname, 'data', 'expo-labels', `${sym}-15m-expo.json`);
    try { _labelCache[sym] = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { _labelCache[sym] = null; }
  }
  const labels = _labelCache[sym];
  if (!Array.isArray(labels) || !labels.length) return null;
  let found = null;
  for (const l of labels) {
    const t = Number(l.time) * (String(l.time).length <= 10 ? 1000 : 1); // sec or ms
    if (t <= atMs) found = { type: l.type, price: l.price, tMs: t }; else break;
  }
  return found;
}

// HL/HH ⇒ long bias, LH/LL ⇒ short bias. Returns true / false / null(unknown).
function followsStructure(direction, label) {
  if (!label) return null;
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
    return Number(t.pnl_usdt) < 0
      ? 'stop-loss / liquidation or manual close (no reason recorded)'
      : 'closed on exchange / manual (no reason recorded)';
  }
  if (BOT_EXIT.test(r)) return `BOT exit — ${t.exit_reason}`;
  if (TP_EXIT.test(r))  return `take-profit — ${t.exit_reason}`;
  return t.exit_reason;
}

function structureLabelFor(t) {
  return t.tf_15m || structureAt(t.symbol, +new Date(t.created_at))?.type || null;
}

// The structure label (HH/HL/LH/LL) the bot exited on — parsed from exit_reason
// (e.g. 'expo_structure_HH'). null if the exit wasn't a labelled structure exit.
function exitLabel(reason) {
  // Labels are appended as a suffix (e.g. 'expo_structure_HH'); underscores are
  // word chars so \b doesn't help — match the token not followed by a letter,
  // and take the last such match.
  const m = String(reason || '').toUpperCase().match(/(HH|HL|LH|LL)(?![A-Z])/g);
  return m ? m[m.length - 1] : null;
}

// Classify a structure exit relative to trade direction:
//   CONTINUATION = same-direction structure kept going → cutting here is premature.
//     LONG exits on HH, SHORT exits on LL.
//   REVERSAL = structure flipped against the trade → a legit exit.
//     LONG exits on LH, SHORT exits on HL.
// This is exactly the distinction expo-watcher's EXIT_REVERSAL_ONLY encodes;
// here we measure how often the *closer* actually cut on a continuation.
function exitClass(direction, label) {
  if (!label) return null;
  const dir = String(direction || '').toUpperCase();
  if (dir === 'LONG')  return label === 'HH' ? 'continuation' : label === 'LH' ? 'reversal' : 'other';
  if (dir === 'SHORT') return label === 'LL' ? 'continuation' : label === 'HL' ? 'reversal' : 'other';
  return null;
}

// Common enrichment applied to every returned row.
function enrich(t) {
  const label = structureLabelFor(t);
  const closedInProfit = Number(t.pnl_usdt) > 0;
  const botCut = BOT_EXIT.test(String(t.exit_reason || ''));
  let verdict;
  if (t.status === 'OPEN') verdict = 'open';
  else if (closedInProfit && botCut) verdict = 'WINNER_CLOSED_EARLY';
  else if (botCut) verdict = 'bot_exit_in_loss';
  else if (closedInProfit) verdict = 'winner';
  else verdict = 'loser';
  return {
    id: t.id, symbol: t.symbol, direction: t.direction, leverage: t.leverage,
    entry_price: t.entry_price, exit_price: t.exit_price,
    sl_price: t.sl_price, tp_price: t.tp_price,
    pnl_usdt: t.pnl_usdt == null ? null : Number(t.pnl_usdt),
    status: t.status, setup: t.setup || t.market_structure || null,
    exit_reason: t.exit_reason || null, email: t.email || null,
    created_at: t.created_at, closed_at: t.closed_at,
    duration_min: durationMin(t),
    is_manual: isManual(t),
    structure_label: label,
    follows_structure: followsStructure(t.direction, label),
    why_closed: whyClosed(t),
    early_close: closedInProfit && botCut,
    verdict,
  };
}

// Appends the email bind to `params` (when set) and returns the SQL fragment.
function emailClause(email, params) {
  if (!email) return '';
  params.push(email);
  return `AND LOWER(u.email) = LOWER($${params.length})`;
}

async function analyze({ email = '', days = 60, focusSymbol = 'ETHUSDT', limit = 300 } = {}) {
  const D = String(Math.max(1, Math.min(365, parseInt(days, 10) || 60)));
  const em = String(email || '').trim();
  const cap = Math.max(1, Math.min(2000, parseInt(limit, 10) || 300));
  const base = `SELECT t.*, u.email FROM trades t LEFT JOIN users u ON u.id = t.user_id`;

  // 1. OPEN
  const openParams = [];
  const open = await query(
    `${base} WHERE t.status = 'OPEN' ${emailClause(em, openParams)}
     ORDER BY t.created_at DESC LIMIT ${cap}`, openParams);

  // 2. MANUAL / TRADER-MODE
  const manParams = [D];
  const manual = await query(
    `${base} WHERE (UPPER(COALESCE(t.setup,'')) = 'MANUAL' OR UPPER(COALESCE(t.market_structure,'')) = 'TRADER_MODE')
       AND COALESCE(t.closed_at, t.created_at) > NOW() - ($1::text || ' days')::interval
       ${emailClause(em, manParams)}
     ORDER BY COALESCE(t.closed_at, t.created_at) DESC LIMIT ${cap}`, manParams);

  // 3. LOSERS
  const loseParams = [D];
  const loserRows = await query(
    `${base} WHERE t.status IN ('WIN','LOSS','TP','SL','CLOSED') AND t.pnl_usdt IS NOT NULL AND t.pnl_usdt < 0
       AND COALESCE(t.closed_at, t.created_at) > NOW() - ($1::text || ' days')::interval
       ${emailClause(em, loseParams)}
     ORDER BY t.pnl_usdt ASC LIMIT ${cap}`, loseParams);

  // 4. SAME-SIGNAL COHORT
  const cohParams = [D];
  const cohEmail = emailClause(em, cohParams);
  const cohorts = await query(
    `SELECT COALESCE(NULLIF(t.setup,''), t.market_structure, 'unknown') AS signal,
            t.direction,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE t.pnl_usdt > 0)::int AS wins,
            ROUND((COUNT(*) FILTER (WHERE t.pnl_usdt > 0)::numeric / NULLIF(COUNT(*),0)) * 100, 1)::float AS win_rate,
            ROUND(SUM(t.pnl_usdt)::numeric, 2)::float AS net,
            ROUND(AVG(t.pnl_usdt)::numeric, 2)::float AS avg
       FROM trades t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.status IN ('WIN','LOSS','TP','SL','CLOSED') AND t.pnl_usdt IS NOT NULL
        AND COALESCE(t.closed_at, t.created_at) > NOW() - ($1::text || ' days')::interval
        ${cohEmail}
      GROUP BY signal, t.direction
      ORDER BY net ASC LIMIT 50`, cohParams);

  // 4b. PEERS of the manual trade's signal(s)
  const manualSignals = [...new Set(manual.map(t => (t.setup || t.market_structure || 'unknown')))];
  let peers = [];
  if (manualSignals.length) {
    const peerParams = [manualSignals, D];
    peers = await query(
      `${base} WHERE COALESCE(NULLIF(t.setup,''), t.market_structure,'unknown') = ANY($1)
         AND COALESCE(t.closed_at, t.created_at) > NOW() - ($2::text || ' days')::interval
         ${emailClause(em, peerParams)}
       ORDER BY COALESCE(t.closed_at, t.created_at) DESC LIMIT ${cap}`, peerParams);
  }

  // 5. EXIT QUALITY — how often did a bot STRUCTURE exit cut on a continuation
  //    (premature) vs a reversal (legit)? This is the recurring-pattern check:
  //    "does the bot frequently cut winners against the ongoing structure?"
  const eqParams = [D];
  const botExits = await query(
    `${base} WHERE t.status IN ('WIN','LOSS','TP','SL','CLOSED')
       AND t.exit_reason ~* 'expo_structure|structure_break'
       AND COALESCE(t.closed_at, t.created_at) > NOW() - ($1::text || ' days')::interval
       ${emailClause(em, eqParams)}
     ORDER BY COALESCE(t.closed_at, t.created_at) DESC LIMIT ${cap}`, eqParams);

  const exits = botExits.map(t => {
    const label = exitLabel(t.exit_reason);
    const klass = exitClass(t.direction, label);
    return {
      id: t.id, symbol: t.symbol, direction: t.direction,
      pnl_usdt: t.pnl_usdt == null ? null : Number(t.pnl_usdt),
      exit_reason: t.exit_reason, exit_label: label, exit_class: klass,
      premature: klass === 'continuation',
      winner_cut: klass === 'continuation' && Number(t.pnl_usdt) > 0,
      closed_at: t.closed_at,
    };
  });
  const contCuts   = exits.filter(e => e.exit_class === 'continuation');
  const winnerCuts = contCuts.filter(e => Number(e.pnl_usdt) > 0);
  const bySymbolDir = {};
  for (const e of exits) {
    const k = `${e.symbol} ${e.direction}`;
    const b = bySymbolDir[k] || (bySymbolDir[k] = { symbol: e.symbol, direction: e.direction, structure_exits: 0, continuation_cuts: 0, winners_cut: 0 });
    b.structure_exits++;
    if (e.exit_class === 'continuation') b.continuation_cuts++;
    if (e.winner_cut) b.winners_cut++;
  }

  const losers = loserRows.map(enrich);
  const against = losers.filter(l => l.follows_structure === false).length;

  return {
    params: { email: em || null, days: Number(D), focusSymbol, limit: cap },
    open: open.map(enrich),
    manual: manual.map(enrich),
    losers: {
      trades: losers,
      total: losers.length,
      against_structure: against,
      against_structure_pct: losers.length ? Number((against / losers.length * 100).toFixed(1)) : 0,
    },
    cohorts: cohorts.map(c => ({
      signal: c.signal, direction: c.direction, trades: c.n, wins: c.wins,
      win_rate: c.win_rate, net: c.net, avg: c.avg,
    })),
    manual_signals: manualSignals,
    peers: peers.map(enrich),
    winners_cut_early: manual.filter(t => Number(t.pnl_usdt) > 0 && BOT_EXIT.test(String(t.exit_reason || '')))
      .map(t => ({ id: t.id, symbol: t.symbol, direction: t.direction, pnl_usdt: Number(t.pnl_usdt), exit_reason: t.exit_reason })),
    exit_quality: {
      structure_exits: exits.length,
      continuation_cuts: contCuts.length,
      reversal_exits: exits.filter(e => e.exit_class === 'reversal').length,
      winners_cut_on_continuation: winnerCuts.length,
      pct_premature: exits.length ? Number((contCuts.length / exits.length * 100).toFixed(1)) : 0,
      pct_winners_cut: contCuts.length ? Number((winnerCuts.length / contCuts.length * 100).toFixed(1)) : 0,
      by_symbol_direction: Object.values(bySymbolDir).sort((a, b) => b.continuation_cuts - a.continuation_cuts),
      examples: exits.slice(0, 25),
    },
    generated_at: new Date().toISOString(),
  };
}

module.exports = { analyze, isManual, structureAt, followsStructure, whyClosed, durationMin, BOT_EXIT, TP_EXIT };
