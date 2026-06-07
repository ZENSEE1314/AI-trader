// ============================================================
// analyze-winners.js  — run once (or on cron) on Railway
//
// Queries ALL closed trades from DB, groups by WIN vs LOSS,
// extracts indicator fingerprints from market_structure + setup
// + direction, then saves data/sv-winner-profile.json
//
// Run:  node scripts/analyze-winners.js
// ============================================================

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { query } = require('../db');

const OUT_FILE = path.join(__dirname, '../data/sv-winner-profile.json');

// ── Helpers ──────────────────────────────────────────────────

function parseStructure(raw) {
  if (!raw || typeof raw !== 'string') return {};
  // market_structure is stored as JSON string in many cases
  try { return JSON.parse(raw); } catch (_) { return { raw }; }
}

// Bucket a numeric value into a named zone
function adxZone(v)  { if (!v || isNaN(v)) return 'uk'; return v < 20 ? 'weak' : v < 40 ? 'mod' : 'str'; }
function rsiZone(v)  { if (!v || isNaN(v)) return 'uk'; return v < 35 ? 'low'  : v < 65 ? 'mid' : 'high'; }

// Convert setup/market_structure string into normalised tags
function extractTags(trade) {
  const tags = [];

  // Direction
  tags.push(`dir:${(trade.direction || 'UK').toUpperCase()}`);

  // Symbol
  tags.push(`sym:${(trade.symbol || 'UK').replace('USDT','')}`);

  // Setup name
  const setup = (trade.setup || '').toLowerCase();
  if (setup.includes('smc'))     tags.push('setup:smc');
  if (setup.includes('ai'))      tags.push('setup:ai');
  if (setup.includes('rev'))     tags.push('setup:rev');
  if (setup.includes('hl'))      tags.push('setup:hl');
  if (setup.includes('lh'))      tags.push('setup:lh');
  if (setup.includes('bos'))     tags.push('setup:bos');
  if (setup.includes('choch'))   tags.push('setup:choch');
  if (setup.includes('vision'))  tags.push('setup:vision');
  if (!tags.some(t => t.startsWith('setup:'))) tags.push('setup:other');

  // Parse market_structure JSON for embedded indicators
  const ms = parseStructure(trade.market_structure);

  // RSI
  const rsiVal = parseFloat(ms.rsi ?? ms.rsi15 ?? ms.rsi14 ?? NaN);
  tags.push(`rsi:${rsiZone(rsiVal)}`);

  // ADX
  const adxVal = parseFloat(ms.adx ?? ms.adx14 ?? NaN);
  tags.push(`adx:${adxZone(adxVal)}`);

  // 4H trend
  const trend = (ms.trend4h || ms.trend || '').toUpperCase();
  if (trend === 'UP' || trend === 'DOWN' || trend === 'NEUTRAL') tags.push(`trend:${trend}`);

  // TV alignment (if stored)
  const tvAlign = ms.tvAlign || ms.tv_align || null;
  if (tvAlign) tags.push(`tv:${tvAlign}`);

  // Time of day bucket (UTC hour)
  if (trade.created_at) {
    const h = new Date(trade.created_at).getUTCHours();
    const session = h >= 2 && h < 6   ? 'asian'
                  : h >= 7 && h < 10  ? 'london'
                  : h >= 12 && h < 15 ? 'ny_am'
                  : h >= 18 && h < 21 ? 'ny_pm'
                  : 'off';
    tags.push(`session:${session}`);
  }

  return tags;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('[analyze-winners] Querying closed trades…');

  const rows = await query(`
    SELECT symbol, direction, status, pnl_usdt, entry_price, exit_price,
           market_structure, setup, tf_15m, tf_3m, tf_1m, created_at, leverage
    FROM trades
    WHERE status IN ('WIN','LOSS','SL','TP','CLOSED')
    ORDER BY created_at DESC
    LIMIT 2000
  `);

  console.log(`[analyze-winners] ${rows.length} closed trades found`);
  if (rows.length === 0) { console.log('No data — exiting'); process.exit(0); }

  // ── Categorise ───────────────────────────────────────────
  const wins   = rows.filter(r => {
    const s = (r.status || '').toUpperCase();
    const p = parseFloat(r.pnl_usdt ?? 0);
    return s === 'WIN' || s === 'TP' || p > 0;
  });
  const losses = rows.filter(r => {
    const s = (r.status || '').toUpperCase();
    const p = parseFloat(r.pnl_usdt ?? 0);
    return s === 'LOSS' || s === 'SL' || p < 0;
  });

  console.log(`[analyze-winners] Wins: ${wins.length}  Losses: ${losses.length}  WR: ${(wins.length/rows.length*100).toFixed(1)}%`);

  // ── Tag frequency maps ────────────────────────────────────
  function buildFreqMap(trades) {
    const freq = {};
    for (const t of trades) {
      for (const tag of extractTags(t)) {
        freq[tag] = (freq[tag] || 0) + 1;
      }
    }
    return freq;
  }

  const winFreq  = buildFreqMap(wins);
  const lossFreq = buildFreqMap(losses);

  // ── Edge score per tag: (winPct - lossPct) ───────────────
  const allTags = new Set([...Object.keys(winFreq), ...Object.keys(lossFreq)]);
  const edgeMap = {};

  for (const tag of allTags) {
    const wPct = (winFreq[tag]  || 0) / wins.length;
    const lPct = (lossFreq[tag] || 0) / losses.length;
    const edge = wPct - lPct;               // positive = tag appears more in wins
    const winCount  = winFreq[tag]  || 0;
    const lossCount = lossFreq[tag] || 0;
    const total     = winCount + lossCount;
    const wr        = total > 0 ? winCount / total : 0;

    edgeMap[tag] = {
      winCount, lossCount, total,
      winPct:  +(wPct  * 100).toFixed(1),
      lossPct: +(lPct  * 100).toFixed(1),
      wr:      +(wr    * 100).toFixed(1),
      edge:    +edge.toFixed(4),
    };
  }

  // Sort by edge descending
  const sorted = Object.entries(edgeMap)
    .sort((a,b) => b[1].edge - a[1].edge);

  // ── Winner profile: tags where wr >= 55% AND total >= 3 ──
  const MIN_TRADES = 3;
  const MIN_WR     = 55;

  const winnerTags = sorted
    .filter(([, v]) => v.total >= MIN_TRADES && v.wr >= MIN_WR)
    .map(([tag, v]) => ({ tag, ...v }));

  const loserTags = sorted
    .filter(([, v]) => v.total >= MIN_TRADES && v.wr < 40)
    .map(([tag, v]) => ({ tag, ...v }));

  // ── Per-symbol stats ──────────────────────────────────────
  const symStats = {};
  for (const r of rows) {
    const sym = r.symbol || 'UNKNOWN';
    if (!symStats[sym]) symStats[sym] = { wins: 0, losses: 0, pnl: 0 };
    const isWin = (r.status||'').toUpperCase() === 'WIN' || (r.status||'').toUpperCase() === 'TP' || parseFloat(r.pnl_usdt||0) > 0;
    if (isWin) symStats[sym].wins++;
    else        symStats[sym].losses++;
    symStats[sym].pnl += parseFloat(r.pnl_usdt || 0);
  }

  // ── Per-setup stats ───────────────────────────────────────
  const setupStats = {};
  for (const r of rows) {
    const s = (r.setup || 'unknown').toLowerCase().slice(0, 30);
    if (!setupStats[s]) setupStats[s] = { wins: 0, losses: 0, pnl: 0 };
    const isWin = (r.status||'').toUpperCase() === 'WIN' || (r.status||'').toUpperCase() === 'TP' || parseFloat(r.pnl_usdt||0) > 0;
    if (isWin) setupStats[s].wins++;
    else        setupStats[s].losses++;
    setupStats[s].pnl += parseFloat(r.pnl_usdt || 0);
  }
  // Add WR to each setup
  for (const [, v] of Object.entries(setupStats)) {
    v.total = v.wins + v.losses;
    v.wr    = v.total > 0 ? +(v.wins / v.total * 100).toFixed(1) : 0;
  }

  // ── Session stats ─────────────────────────────────────────
  const sessionStats = {};
  for (const r of rows) {
    if (!r.created_at) continue;
    const h = new Date(r.created_at).getUTCHours();
    const sess = h >= 2 && h < 6   ? 'asian'
               : h >= 7 && h < 10  ? 'london'
               : h >= 12 && h < 15 ? 'ny_am'
               : h >= 18 && h < 21 ? 'ny_pm'
               : 'off_hours';
    if (!sessionStats[sess]) sessionStats[sess] = { wins: 0, losses: 0, pnl: 0 };
    const isWin = (r.status||'').toUpperCase() === 'WIN' || (r.status||'').toUpperCase() === 'TP' || parseFloat(r.pnl_usdt||0) > 0;
    if (isWin) sessionStats[sess].wins++;
    else        sessionStats[sess].losses++;
    sessionStats[sess].pnl += parseFloat(r.pnl_usdt || 0);
  }
  for (const [, v] of Object.entries(sessionStats)) {
    v.total = v.wins + v.losses;
    v.wr    = v.total > 0 ? +(v.wins / v.total * 100).toFixed(1) : 0;
  }

  // ── Build output ─────────────────────────────────────────
  const profile = {
    generatedAt:    new Date().toISOString(),
    totalTrades:    rows.length,
    totalWins:      wins.length,
    totalLosses:    losses.length,
    overallWR:      +(wins.length / rows.length * 100).toFixed(1),
    totalPnl:       +rows.reduce((s,r) => s + parseFloat(r.pnl_usdt||0), 0).toFixed(2),

    // Tags that appear significantly more in wins (use these)
    winnerTags,

    // Tags that appear significantly more in losses (avoid these)
    loserTags,

    // Full edge map (all tags, sorted by edge)
    allTagEdges: Object.fromEntries(sorted),

    // Per-symbol breakdown
    symStats,

    // Per-setup breakdown
    setupStats,

    // Per-session breakdown
    sessionStats,
  };

  // ── Save ──────────────────────────────────────────────────
  const dir = path.dirname(OUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(profile, null, 2));

  // ── Print summary ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('   WINNER INDICATOR PROFILE — SUMMARY');
  console.log('═══════════════════════════════════════════');
  console.log(`Total trades: ${rows.length}  WR: ${profile.overallWR}%  PnL: $${profile.totalPnl}`);

  console.log('\n✅ TOP WINNING TAGS (trade ONLY when these match):');
  winnerTags.slice(0,15).forEach(t =>
    console.log(`  ${t.tag.padEnd(30)}  WR=${t.wr}%  trades=${t.total}  edge=+${t.edge}`)
  );

  console.log('\n❌ TOP LOSING TAGS (SKIP when these match):');
  loserTags.slice(0,10).forEach(t =>
    console.log(`  ${t.tag.padEnd(30)}  WR=${t.wr}%  trades=${t.total}  edge=${t.edge}`)
  );

  console.log('\n📊 PER-SYMBOL:');
  for (const [sym, v] of Object.entries(symStats)) {
    const wr = v.wins + v.losses > 0 ? (v.wins/(v.wins+v.losses)*100).toFixed(1) : '-';
    console.log(`  ${sym.padEnd(10)} W:${v.wins} L:${v.losses} WR:${wr}% PnL:$${v.pnl.toFixed(2)}`);
  }

  console.log('\n⏰ PER-SESSION:');
  for (const [sess, v] of Object.entries(sessionStats)) {
    console.log(`  ${sess.padEnd(12)} W:${v.wins} L:${v.losses} WR:${v.wr}% PnL:$${v.pnl.toFixed(2)}`);
  }

  console.log('\n🔧 PER-SETUP:');
  const topSetups = Object.entries(setupStats).sort((a,b) => b[1].pnl - a[1].pnl).slice(0,10);
  for (const [s, v] of topSetups) {
    console.log(`  ${s.padEnd(30)} W:${v.wins} L:${v.losses} WR:${v.wr}% PnL:$${v.pnl.toFixed(2)}`);
  }

  console.log(`\n✅ Profile saved → ${OUT_FILE}`);
  process.exit(0);
}

main().catch(e => { console.error('[analyze-winners] FATAL:', e.message); process.exit(1); });
