// ════════════════════════════════════════════════════════════════
//  backtest-ytd-losses.js
//
//  Pulls every losing trade from the last 24 h and re-runs the
//  current gate stack against the 1m + 15m klines AT THE ENTRY TIME.
//  Tells you which gate WOULD have blocked the trade today, if any.
//
//  Run on Railway:
//    node backtest-ytd-losses.js
//
//  Output: per-trade gate verdict + aggregate "if all gates were
//  active, X% of these losses would have been prevented".
// ════════════════════════════════════════════════════════════════

'use strict';

const { query } = require('./db');
const fetch = require('node-fetch');

const REQUEST_TIMEOUT = 15_000;

async function fetchKlines(symbol, interval, startMs, endMs, limit = 100) {
  // Try Binance first (most data); fall back to Bybit which isn't IP-blocked
  // from GH Actions runners. Both return klines with the same shape:
  //   [openTime, open, high, low, close, volume, ...]
  const tries = [
    {
      name: 'binance',
      url:  `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${limit}`,
      parse: j => Array.isArray(j) ? j : null,
    },
    {
      // Bybit v5 — interval string differs slightly: '1', '15' instead of '1m', '15m'.
      name: 'bybit',
      url:  `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval.replace('m','')}&start=${startMs}&end=${endMs}&limit=${limit}`,
      parse: j => {
        if (!j || j.retCode !== 0 || !j.result?.list) return null;
        // Bybit returns NEWEST first; reverse to match Binance ordering.
        return j.result.list.slice().reverse().map(k => [
          parseInt(k[0]),    // openTime
          k[1], k[2], k[3], k[4], k[5],   // o h l c v
        ]);
      },
    },
  ];
  let lastErr = '';
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { timeout: REQUEST_TIMEOUT });
      if (!r.ok) { lastErr = `${t.name} HTTP ${r.status}`; continue; }
      const j = await r.json();
      const arr = t.parse(j);
      if (arr && arr.length) return arr;
      lastErr = `${t.name} empty`;
    } catch (e) {
      lastErr = `${t.name} ${e.message}`;
    }
  }
  if (process.env.BACKTEST_VERBOSE) {
    console.error(`fetchKlines ${symbol} ${interval} (${startMs}→${endMs}): ${lastErr}`);
  }
  return null;
}

// ─── Pivot detection (matches liquidity-sweep-engine inline path) ───
function pivots(klines, B = 2) {
  const ph = [], pl = [];
  for (let i = B; i < klines.length - B; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= B; j++) {
      if (parseFloat(klines[i][2]) <= parseFloat(klines[i-j][2]) ||
          parseFloat(klines[i][2]) <= parseFloat(klines[i+j][2])) isH = false;
      if (parseFloat(klines[i][3]) >= parseFloat(klines[i-j][3]) ||
          parseFloat(klines[i][3]) >= parseFloat(klines[i+j][3])) isL = false;
    }
    if (isH) ph.push(parseFloat(klines[i][2]));
    if (isL) pl.push(parseFloat(klines[i][3]));
  }
  const hh = ph.length >= 2 && ph[ph.length-1] > ph[ph.length-2];
  const lh = ph.length >= 2 && ph[ph.length-1] < ph[ph.length-2];
  const hl = pl.length >= 2 && pl[pl.length-1] > pl[pl.length-2];
  const ll = pl.length >= 2 && pl[pl.length-1] < pl[pl.length-2];
  return { hh, hl, lh, ll };
}

// ─── Replay each gate ───────────────────────────────────────────────
function replayGates(direction, price, klines1m, klines15m) {
  const verdict = { blockedBy: [], passed: [] };
  if (!klines1m || klines1m.length < 21 || !klines15m || klines15m.length < 8) {
    verdict.blockedBy.push('insufficient-data');
    return verdict;
  }

  // 1. 15m + 1m structure (PR #61)
  const s15 = pivots(klines15m, 2);
  const s1  = pivots(klines1m,  2);
  const ltfBull = s1.hh || s1.hl;
  const ltfBear = s1.ll || s1.lh;
  // 15m only blocks when CONFIRMED against the 1m direction (matches
  // strategy-v3.detectMSTF and liquidity-sweep-engine STRUCTURE_FOLLOW
  // post-PR #74).
  const htf15CounterLong  = s15.ll && s15.lh;
  const htf15CounterShort = s15.hh && s15.hl;
  if (direction === 'LONG' && (!ltfBull || htf15CounterLong)) verdict.blockedBy.push('no-1m-bull-or-15m-confirmed-bear');
  else if (direction === 'SHORT' && (!ltfBear || htf15CounterShort)) verdict.blockedBy.push('no-1m-bear-or-15m-confirmed-bull');
  else verdict.passed.push('1m-structure-ok');

  // 2. Counter-trend filter (PR #60)
  const confirmedBull = s1.hh && s1.hl;
  const confirmedBear = s1.ll && s1.lh;
  if (direction === 'LONG' && confirmedBear) verdict.blockedBy.push('counter-trend (1m ll&&lh)');
  else if (direction === 'SHORT' && confirmedBull) verdict.blockedBy.push('counter-trend (1m hh&&hl)');
  else verdict.passed.push('counter-trend-ok');

  // 3. Range position (PR #51)
  const w20 = klines1m.slice(-11, -1); // 10-bar window — recent context
  let hi = -Infinity, lo = Infinity;
  for (const k of w20) {
    const h = parseFloat(k[2]);
    const l = parseFloat(k[3]);
    if (h > hi) hi = h;
    if (l < lo) lo = l;
  }
  const sz = hi - lo;
  const rPos = sz > 0 ? (price - lo) / sz : 0.5;
  if (direction === 'LONG'  && rPos > 0.40) verdict.blockedBy.push(`range-pos ${(rPos*100).toFixed(0)}% > 40%`);
  else if (direction === 'SHORT' && rPos < 0.60) verdict.blockedBy.push(`range-pos ${(rPos*100).toFixed(0)}% < 60%`);
  else verdict.passed.push(`range-pos ${(rPos*100).toFixed(0)}%`);

  // 4. Pause gate (skipped at extreme, PR #57)
  const atExtreme = (direction === 'LONG' && rPos < 0.20) || (direction === 'SHORT' && rPos > 0.80);
  if (!atExtreme && klines1m.length >= 4) {
    const lastH = parseFloat(klines1m[klines1m.length - 2][2]);
    const lastL = parseFloat(klines1m[klines1m.length - 2][3]);
    const midH  = parseFloat(klines1m[klines1m.length - 3][2]);
    const midL  = parseFloat(klines1m[klines1m.length - 3][3]);
    const oldH  = parseFloat(klines1m[klines1m.length - 4][2]);
    const oldL  = parseFloat(klines1m[klines1m.length - 4][3]);
    let p1, p2;
    if (direction === 'LONG') {
      p1 = lastH <= midH && lastL <= midL;
      p2 = midH  <= oldH && midL  <= oldL;
    } else {
      p1 = lastL >= midL && lastH >= midH;
      p2 = midL  >= oldL && midH  >= oldH;
    }
    if (!(p1 && p2)) verdict.blockedBy.push('pause-gate (last-2 1m candles still extending)');
    else verdict.passed.push('pause-gate');
  } else if (atExtreme) {
    verdict.passed.push('pause-gate-skipped-at-extreme');
  }

  return verdict;
}

(async () => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  YESTERDAY\'S LOSING TRADES — GATE REPLAY (current code)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const losses = await query(`
    SELECT id, symbol, direction, entry_price, sl_price, exit_price, pnl_usdt,
           leverage, created_at, closed_at, market_structure, status
      FROM trades
     WHERE created_at >= $1
       AND ((status IN ('LOSS','SL'))
            OR (status = 'CLOSED' AND pnl_usdt < 0))
     ORDER BY created_at DESC
  `, [since]);

  if (!losses.length) {
    console.log('No losing trades in the last 24 h. ✓');
    process.exit(0);
  }

  console.log(`Total losses (last 24 h): ${losses.length}\n`);

  let wouldBlock = 0;
  const blockReasons = {};

  for (const t of losses) {
    const entryMs   = new Date(t.created_at).getTime();
    const startMs   = entryMs - 60 * 60 * 1000;       // 1 h before
    const endMs     = entryMs;                         // up to entry instant
    const k1m       = await fetchKlines(t.symbol, '1m',  startMs, endMs, 60);
    const k15m      = await fetchKlines(t.symbol, '15m', entryMs - 24*3600*1000, endMs, 100);
    const price     = parseFloat(t.entry_price);
    const v         = replayGates(t.direction, price, k1m, k15m);

    const blocked   = v.blockedBy.length > 0;
    if (blocked) {
      wouldBlock++;
      for (const r of v.blockedBy) blockReasons[r.split(' ')[0]] = (blockReasons[r.split(' ')[0]] || 0) + 1;
    }

    const pnl  = parseFloat(t.pnl_usdt || 0);
    const dur  = t.closed_at ? Math.round((new Date(t.closed_at) - new Date(t.created_at)) / 60000) : '?';
    const setup = t.market_structure || '?';
    console.log(`${t.symbol} ${t.direction.padEnd(5)} | ${blocked ? '🛡 BLOCKED ' : '⚠️  ALLOWED'} | PnL $${pnl.toFixed(2).padStart(7)} | dur ${String(dur).padStart(3)}m | setup=${setup}`);
    if (blocked)         console.log(`   blocked by: ${v.blockedBy.join(' · ')}`);
    else                 console.log(`   passed all: ${v.passed.join(' · ')}  (would still fire today)`);
  }

  const pct = (wouldBlock / losses.length * 100).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  AGGREGATE: ${wouldBlock} / ${losses.length} losses (${pct}%) would have been BLOCKED today.`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Block-reason breakdown:');
  for (const [k, n] of Object.entries(blockReasons).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${n.toString().padStart(3)}  ${k}`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  // The remaining "would still fire today" ones are the trades we
  // need to study — past gates ≠ losing-trade prevention.
  process.exit(0);
})().catch(err => {
  console.error('analysis failed:', err);
  process.exit(1);
});
