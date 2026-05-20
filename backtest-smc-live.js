'use strict';

// ============================================================
// backtest-smc-live.js — Walk-forward backtest of the live SMC engine
//
// Uses the EXACT same analysis functions as smc-engine.js (imported
// directly) on real Bybit historical candles so results reflect what
// the live bot would have done.
//
// Symbols : BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT
// Capital : $1 000 starting, 2% risk per trade
// Leverage: 10× (consistent, conservative)
// Lookback: ~60 days of 4H data (360 bars per symbol)
// Signal  : scanned every 4H bar (same cadence as bot's 45-min scan)
// Outcome : TP1 or SL hit first within next 72 x 1H bars (~3 days)
// ============================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const https = require('https');

// ── Re-use the live SMC engine functions ─────────────────────
const {
  analyzeStructure,
  detectCHoCH,
  detectFVGs,
  detectOrderBlocks,
  detectInducement,
  calcFibZones,
  calcRR,
  meetsMinRR,
  getActiveKillzone,
  KILLZONES_UTC,
} = require('./smc-engine');

// ── Config ───────────────────────────────────────────────────
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT',
  'ADAUSDT', 'DOTUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT',
];

const CAPITAL_START   = 1_000;   // USD
const RISK_PCT        = 0.02;    // 2% per trade
const LEVERAGE        = 10;      // 10× leverage (used for margin calc only)
const TAKER_FEE       = 0.0006;  // 0.06% taker fee per side
const MIN_RR          = 2.0;
const ZONE_BUFFER_PCT = 0.04;    // 4% range buffer around 50% line (matches live engine)

// Scan every N 4H bars (1 = every bar, 2 = every 8h, etc.)
const SCAN_EVERY_N_4H = 2; // every 8H to reduce redundancy

// How many 1H bars to look forward for outcome
const MAX_HOLD_1H = 96; // 4 days

// CHoCH: accept 1H OR 15m confirmation (15m = more signals, slightly lower quality)
const ACCEPT_15M_CHOCH = true;

// ── Bybit fetch (paginated) ───────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15_000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message} from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

// Fetch candles from Bybit (returns oldest-first, same as smc-engine.js)
async function fetchBybitCandles(symbol, interval, limit) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await fetchJson(url);
  const raw  = data?.result?.list || [];
  // Bybit newest-first → reverse to oldest-first
  return raw.reverse().map(r => ({
    t:       parseInt(r[0]),
    o:       parseFloat(r[1]),
    h:       parseFloat(r[2]),
    l:       parseFloat(r[3]),
    c:       parseFloat(r[4]),
    v:       parseFloat(r[5]),
    body:    Math.abs(parseFloat(r[4]) - parseFloat(r[1])),
    range:   parseFloat(r[2]) - parseFloat(r[3]),
    bullish: parseFloat(r[4]) >= parseFloat(r[1]),
  }));
}

// Fetch large history by paginating (Bybit limit = 1000 per call)
async function fetchLargeHistory(symbol, interval, totalBars) {
  if (totalBars <= 1000) return fetchBybitCandles(symbol, interval, totalBars);

  const pages = Math.ceil(totalBars / 1000);
  let all = [];

  // First page = most recent 1000
  const first = await fetchBybitCandles(symbol, interval, 1000);
  all = first;

  // Additional pages using endTime pagination
  for (let p = 1; p < pages; p++) {
    if (all.length === 0) break;
    const oldestTs = all[0].t; // oldest bar so far
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000&end=${oldestTs - 1}`;
    const data = await fetchJson(url);
    const raw  = (data?.result?.list || []).reverse().map(r => ({
      t: parseInt(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]),
      l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]),
      body: Math.abs(parseFloat(r[4]) - parseFloat(r[1])),
      range: parseFloat(r[2]) - parseFloat(r[3]),
      bullish: parseFloat(r[4]) >= parseFloat(r[1]),
    }));
    all = [...raw, ...all];
    await sleep(200); // rate limit
  }

  return all.slice(-totalBars);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SMC Conditions (mirrors live smc-engine.js exactly) ──────

function getDirection(c4h, cDaily, cWeekly) {
  const s4h     = analyzeStructure(c4h,     5, 3);
  const sDaily  = analyzeStructure(cDaily,  5, 2);
  const sWeekly = analyzeStructure(cWeekly, 3, 1);

  let bias4h = s4h.bias;

  if (bias4h === 'RANGING') {
    const s1h = analyzeStructure(c4h.slice(-30), 4, 2); // proxy 1H from 4H tail
    if (sDaily.bias !== 'RANGING' &&
       (s1h.bias === sDaily.bias || s1h.bias === 'RANGING')) {
      bias4h = sDaily.bias;
    } else if (sWeekly.bias !== 'RANGING' && sDaily.bias !== 'RANGING' &&
               sWeekly.bias === sDaily.bias) {
      bias4h = sDaily.bias;
    } else {
      return null; // genuine ranging — skip
    }
  }

  return { direction: bias4h === 'BULLISH' ? 'LONG' : 'SHORT', s4h, sDaily };
}

function checkZone(price, s4h, direction) {
  const fib = calcFibZones(s4h.swingHigh, s4h.swingLow);
  if (!fib) return { ok: false };
  const rangeSize  = fib.p100 - fib.p0;
  const zoneBuffer = rangeSize * ZONE_BUFFER_PCT;
  const ok = direction === 'SHORT'
    ? price >= fib.p500 - zoneBuffer
    : price <= fib.p500 + zoneBuffer;
  return { ok, fib };
}

function checkCHoCH(c1h, c15m, direction) {
  // Check 1H CHoCH first (higher quality)
  const s1h    = analyzeStructure(c1h, 8, 2);
  const choch  = detectCHoCH(c1h, s1h.pivots, 40);
  const chochOk = choch &&
    (direction === 'LONG' ? choch.direction === 'BULLISH' : choch.direction === 'BEARISH');

  if (chochOk) return { ok: true, quality: 'HIGH', tf: '1H' };

  // Fallback: 15m CHoCH (fires sooner, catches turns earlier)
  if (ACCEPT_15M_CHOCH && c15m && c15m.length >= 20) {
    const s15m   = analyzeStructure(c15m, 6, 2);
    const choch15 = detectCHoCH(c15m, s15m.pivots, 30);
    const ok15 = choch15 &&
      (direction === 'LONG' ? choch15.direction === 'BULLISH' : choch15.direction === 'BEARISH');
    if (ok15) return { ok: true, quality: 'MEDIUM', tf: '15m' };
  }

  // Last fallback: simple momentum — last 3 × 1H closes trending in direction
  if (c1h.length >= 5) {
    const last3 = c1h.slice(-4);
    const declining = last3.every((c, i) => i === 0 || c.c < last3[i - 1].c);
    const rising    = last3.every((c, i) => i === 0 || c.c > last3[i - 1].c);
    if (direction === 'SHORT' && declining) return { ok: true, quality: 'LOW', tf: 'momentum' };
    if (direction === 'LONG'  && rising)    return { ok: true, quality: 'LOW', tf: 'momentum' };
  }

  return { ok: false };
}

function checkPOI(c1h, c15m, direction) {
  const s1h    = analyzeStructure(c1h, 8, 2);
  const fvgT   = direction === 'SHORT' ? 'BEARISH' : 'BULLISH';
  const obType = direction === 'SHORT' ? 'BEARISH_OB' : 'BULLISH_OB';
  const price  = c1h[c1h.length - 1]?.c || 0;

  const fvgs1h  = detectFVGs(c1h,  80).filter(f => f.type === fvgT && !f.filled);
  const fvgs15m = c15m ? detectFVGs(c15m, 40).filter(f => f.type === fvgT && !f.filled) : [];
  const obs     = detectOrderBlocks(c1h, s1h.pivots, 50)
    .filter(o => o.type === obType);

  const priceInZone = z =>
    z && price <= z.top * 1.005 && price >= z.bottom * 0.995;

  return fvgs1h.some(priceInZone) || fvgs15m.some(priceInZone) || obs.some(priceInZone);
}

function calcSLTP(price, s4h, direction, fib) {
  let sl, tp;

  if (direction === 'SHORT') {
    const sh = s4h.swingHigh;
    sl = sh ? sh.price * 1.0015 : price * 1.005;

    // TP1: use the nearer of (a) structural swing low, (b) 2.5× risk below entry.
    // Cap at 2.5× so we don't chase unreachable targets.
    const slDist   = Math.abs(price - sl);
    const tpFixed  = price - slDist * 2.5;
    const swingLow = s4h.lastLows[s4h.lastLows.length - 1];
    const tpSwing  = swingLow?.price;
    // Pick whichever is closer (more conservative / more achievable)
    tp = tpSwing && tpSwing > tpFixed ? tpSwing : tpFixed;
  } else {
    const sl_      = s4h.swingLow;
    sl             = sl_ ? sl_.price * 0.9985 : price * 0.995;
    const slDist   = Math.abs(price - sl);
    const tpFixed  = price + slDist * 2.5;
    const swingHigh= s4h.lastHighs[s4h.lastHighs.length - 1];
    const tpSwing  = swingHigh?.price;
    tp = tpSwing && tpSwing < tpFixed ? tpSwing : tpFixed;
  }

  return { sl, tp };
}

function isKillzone(tsMs) {
  const kz = getActiveKillzone(tsMs);
  return kz !== null;
}

// ── Outcome simulation ────────────────────────────────────────
// Look forward in future 1H bars to determine TP or SL hit.
// Returns 'TP', 'SL', or 'EXPIRED'

function simulateOutcome(future1H, direction, entry, sl, tp) {
  for (const bar of future1H) {
    if (direction === 'SHORT') {
      if (bar.l <= tp) return 'TP';   // price hit TP
      if (bar.h >= sl) return 'SL';   // price hit SL
    } else {
      if (bar.h >= tp) return 'TP';
      if (bar.l <= sl) return 'SL';
    }
  }
  return 'EXPIRED'; // neither hit within hold period
}

// ── P&L calculation ───────────────────────────────────────────
// Returns net P&L in USD given account size and outcome.

function calcPnL(capital, entry, sl, tp, direction, outcome) {
  const risk       = RISK_PCT * capital;                     // $ at risk
  const slDist     = Math.abs(entry - sl) / entry;          // SL % from entry
  const posSize    = risk / slDist;                         // notional position size
  const tpDist     = Math.abs(tp - entry) / entry;          // TP % from entry
  const grossWin   = posSize * tpDist;
  const grossLoss  = posSize * slDist;
  const feeCost    = posSize * TAKER_FEE * 2;               // entry + exit

  if (outcome === 'TP')      return grossWin  - feeCost;
  if (outcome === 'SL')      return -(grossLoss + feeCost);
  // EXPIRED: close at last price — approximate 0 P&L (small fee loss)
  return -feeCost;
}

// ── Per-symbol backtest ───────────────────────────────────────

async function backtestSymbol(symbol) {
  process.stdout.write(`  Fetching ${symbol} candles...`);

  // Fetch: 4H×500, 1H×1500, D×90, W×24, 15m×500
  const [c4hAll, c1hAll, cDaily, cWeekly, c15mAll] = await Promise.all([
    fetchLargeHistory(symbol, '240', 500),
    fetchLargeHistory(symbol, '60',  1500),
    fetchBybitCandles(symbol, 'D',   90),
    fetchBybitCandles(symbol, 'W',   24),
    fetchBybitCandles(symbol, '15',  500),
  ]);

  console.log(` got ${c4hAll.length}×4H / ${c1hAll.length}×1H`);

  // Sliding window: start at bar 120 (enough history for structure analysis)
  const WIN_4H  = 120;
  const WIN_1H  = 120;
  const WIN_15M = 80;
  const WIN_D   = 60;
  const WIN_W   = 20;

  const trades = [];
  const skipReasons = {};
  const addSkip = (r) => { skipReasons[r] = (skipReasons[r] || 0) + 1; };

  for (let i = WIN_4H; i < c4hAll.length - 4; i += SCAN_EVERY_N_4H) {
    const c4h  = c4hAll.slice(i - WIN_4H, i);
    const bar  = c4hAll[i]; // current bar
    const tsMs = bar.t;
    const price = bar.c;

    // Map 4H timestamp to approximate 1H and 15m index
    const i1h = c1hAll.findIndex(b => b.t >= tsMs);
    if (i1h < WIN_1H) { addSkip('insufficient_1h_history'); continue; }

    const c1h  = c1hAll.slice(Math.max(0, i1h - WIN_1H), i1h);
    const i15m = c15mAll.findIndex(b => b.t >= tsMs);
    const c15m = i15m > WIN_15M
      ? c15mAll.slice(Math.max(0, i15m - WIN_15M), i15m)
      : null;

    // HTF slices
    const iD = cDaily.findIndex(b => b.t >= tsMs);
    const c4hD = iD >= WIN_D ? cDaily.slice(iD - WIN_D, iD) : cDaily.slice(0, Math.max(1, iD));
    const iW = cWeekly.findIndex(b => b.t >= tsMs);
    const c4hW = iW >= WIN_W ? cWeekly.slice(iW - WIN_W, iW) : cWeekly.slice(0, Math.max(1, iW));

    // Step 1: Direction from 4H (with Daily fallback)
    const dirResult = getDirection(c4h, c4hD.length ? c4hD : cDaily, c4hW.length ? c4hW : cWeekly);
    if (!dirResult) { addSkip('ranging_no_bias'); continue; }
    const { direction, s4h } = dirResult;

    // Step 2: Premium / Discount zone (with 4% buffer)
    const { ok: zoneOk, fib } = checkZone(price, s4h, direction);
    if (!zoneOk) { addSkip(`wrong_zone_${direction}`); continue; }
    if (!fib) { addSkip('no_fib'); continue; }

    // Step 3: CHoCH in direction (1H preferred, 15m fallback, momentum last resort)
    const chochResult = checkCHoCH(c1h, c15m, direction);
    if (!chochResult.ok) { addSkip('no_choch'); continue; }

    // Step 4: POI confluence (FVG or OB near price)
    if (!checkPOI(c1h, c15m, direction)) { addSkip('no_poi'); continue; }

    // Step 5: SL / TP and RR check
    const { sl, tp } = calcSLTP(price, s4h, direction, fib);
    if (!tp || !meetsMinRR(price, sl, tp, MIN_RR)) {
      addSkip('rr_too_low');
      continue;
    }

    const rr = parseFloat(calcRR(price, sl, tp).toFixed(2));

    // Step 6: Outcome — look forward in 1H bars
    const future1H = c1hAll.slice(i1h, i1h + MAX_HOLD_1H);
    const outcome  = simulateOutcome(future1H, direction, price, sl, tp);

    // Killzone flag (informational)
    const inKZ = isKillzone(tsMs);

    trades.push({ symbol, direction, entry: price, sl, tp, rr, outcome, inKZ, tsMs, quality: chochResult.quality, chochTf: chochResult.tf });
  }

  return { trades, skipReasons };
}

// ── Equity simulation ─────────────────────────────────────────

function simulateEquity(allTrades) {
  // Sort by timestamp
  const sorted = [...allTrades].sort((a, b) => a.tsMs - b.tsMs);
  let capital = CAPITAL_START;
  const equity = [{ ts: sorted[0]?.tsMs || Date.now(), capital }];

  for (const t of sorted) {
    const pnl = calcPnL(capital, t.entry, t.sl, t.tp, t.direction, t.outcome);
    capital += pnl;
    t.pnl     = pnl;
    t.capital = capital;
    equity.push({ ts: t.tsMs, capital });
  }

  return { capital, equity, trades: sorted };
}

// ── Report ────────────────────────────────────────────────────

function printReport(allTrades, finalCapital) {
  const divider = '─'.repeat(70);

  console.log('\n' + divider);
  console.log(' SMC LIVE BACKTEST — RESULTS');
  console.log(divider);
  console.log(` Starting capital : $${CAPITAL_START.toFixed(2)}`);
  console.log(` Final capital    : $${finalCapital.toFixed(2)}`);
  const totalPnl = finalCapital - CAPITAL_START;
  console.log(` Net P&L          : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${((totalPnl / CAPITAL_START) * 100).toFixed(1)}%)`);
  console.log(` Risk / trade     : ${(RISK_PCT * 100)}% | Leverage: ${LEVERAGE}×`);
  console.log(divider);

  // Overall stats
  const tps  = allTrades.filter(t => t.outcome === 'TP');
  const sls  = allTrades.filter(t => t.outcome === 'SL');
  const exps = allTrades.filter(t => t.outcome === 'EXPIRED');
  const wr   = allTrades.length > 0 ? (tps.length / allTrades.length * 100).toFixed(1) : '0.0';
  const avgRR = allTrades.length > 0
    ? (allTrades.reduce((s, t) => s + t.rr, 0) / allTrades.length).toFixed(2)
    : '0';

  console.log(` Total signals    : ${allTrades.length}`);
  console.log(` Win rate         : ${wr}%  (${tps.length} TP / ${sls.length} SL / ${exps.length} Expired)`);
  console.log(` Avg RR           : ${avgRR}:1`);

  // Killzone breakdown
  const kzTrades = allTrades.filter(t => t.inKZ);
  const kzTPs    = kzTrades.filter(t => t.outcome === 'TP');
  const kzWR     = kzTrades.length > 0 ? (kzTPs.length / kzTrades.length * 100).toFixed(1) : 'N/A';
  console.log(` In-killzone WR   : ${kzWR}% (${kzTrades.length} trades in London/NY/Asian sessions)`);

  // Max drawdown
  let peak = CAPITAL_START, maxDD = 0;
  for (const t of allTrades) {
    if (t.capital > peak) peak = t.capital;
    const dd = (peak - t.capital) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  console.log(` Max drawdown     : ${(maxDD * 100).toFixed(1)}%`);
  console.log(divider);

  // Per-symbol breakdown
  console.log('\n Per-Symbol Breakdown:\n');
  console.log(` ${'Symbol'.padEnd(10)} ${'Trades'.padStart(7)} ${'TP'.padStart(5)} ${'SL'.padStart(5)} ${'WR%'.padStart(7)} ${'Avg RR'.padStart(8)} ${'Net P&L'.padStart(10)}`);
  console.log(' ' + '─'.repeat(60));

  for (const sym of SYMBOLS) {
    const st   = allTrades.filter(t => t.symbol === sym);
    const stp  = st.filter(t => t.outcome === 'TP');
    const ssl  = st.filter(t => t.outcome === 'SL');
    const swr  = st.length > 0 ? (stp.length / st.length * 100).toFixed(1) : '-';
    const srr  = st.length > 0 ? (st.reduce((s, t) => s + t.rr, 0) / st.length).toFixed(2) : '-';
    const spnl = st.reduce((s, t) => s + (t.pnl || 0), 0);
    const pnlStr = (spnl >= 0 ? '+' : '') + '$' + spnl.toFixed(2);
    console.log(` ${sym.padEnd(10)} ${String(st.length).padStart(7)} ${String(stp.length).padStart(5)} ${String(ssl.length).padStart(5)} ${String(swr).padStart(7)} ${String(srr).padStart(8)} ${pnlStr.padStart(10)}`);
  }

  // Signal quality breakdown
  console.log('\n Signal Quality Breakdown:\n');
  for (const q of ['HIGH', 'MEDIUM', 'LOW']) {
    const qt  = allTrades.filter(t => t.quality === q);
    const qtp = qt.filter(t => t.outcome === 'TP');
    const qwr = qt.length > 0 ? (qtp.length / qt.length * 100).toFixed(1) : '-';
    const qpnl = qt.reduce((s, t) => s + (t.pnl || 0), 0);
    const tfLabel = q === 'HIGH' ? '(1H CHoCH)' : q === 'MEDIUM' ? '(15m CHoCH)' : '(momentum)';
    console.log(`   ${q.padEnd(8)} ${tfLabel.padEnd(16)}: ${qt.length} trades | WR ${qwr}% | P&L ${(qpnl >= 0 ? '+' : '')}$${qpnl.toFixed(2)}`);
  }

  // Direction breakdown
  console.log('\n Direction Breakdown:\n');
  for (const dir of ['LONG', 'SHORT']) {
    const dt  = allTrades.filter(t => t.direction === dir);
    const dtp = dt.filter(t => t.outcome === 'TP');
    const dwr = dt.length > 0 ? (dtp.length / dt.length * 100).toFixed(1) : '-';
    console.log(`   ${dir.padEnd(7)}: ${dt.length} trades | WR ${dwr}%`);
  }

  // Projected monthly / yearly from last 60-day window
  const days   = 60;
  const perDay = allTrades.length / days;
  const dailyPnl = totalPnl / days;
  console.log('\n' + divider);
  console.log(` Projection (based on ~${days}-day backtest window):`);
  console.log(`   Avg trades/day : ${perDay.toFixed(1)}`);
  console.log(`   Avg daily P&L  : ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)}`);
  console.log(`   Monthly (30d)  : ${(dailyPnl * 30 >= 0 ? '+' : '')}$${(dailyPnl * 30).toFixed(2)}`);
  console.log(`   Yearly (365d)  : ${(dailyPnl * 365 >= 0 ? '+' : '')}$${(dailyPnl * 365).toFixed(2)}`);
  console.log(divider + '\n');
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log(' SMC LIVE BACKTEST — Starting (~2–3 min, fetching real Bybit data)');
  console.log('════════════════════════════════════════════════════════════════════\n');
  console.log(` Symbols  : ${SYMBOLS.join(', ')}`);
  console.log(` Capital  : $${CAPITAL_START}`);
  console.log(` Risk/trade: ${RISK_PCT * 100}%  |  Min RR: ${MIN_RR}:1  |  Max hold: ${MAX_HOLD_1H}h`);
  console.log(` Zone buffer: ±${ZONE_BUFFER_PCT * 100}% of swing range (matches live engine)\n`);

  let allTrades = [];
  const allSkipReasons = {};

  for (const sym of SYMBOLS) {
    try {
      const { trades, skipReasons } = await backtestSymbol(sym);
      allTrades = allTrades.concat(trades);
      for (const [k, v] of Object.entries(skipReasons)) {
        allSkipReasons[k] = (allSkipReasons[k] || 0) + v;
      }
      await sleep(400); // rate limit between symbols
    } catch (err) {
      console.error(`  ERROR fetching ${sym}: ${err.message}`);
    }
  }

  if (!allTrades.length) {
    console.log('\n⚠️  No trades generated — check API connectivity.\n');
    return;
  }

  const { capital: finalCapital, trades: sorted } = simulateEquity(allTrades);
  printReport(sorted, finalCapital);

  // Skip reason summary
  console.log(' Skip Reasons (signals filtered out):\n');
  const sortedSkips = Object.entries(allSkipReasons).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedSkips) {
    console.log(`   ${reason.padEnd(30)} ${count.toLocaleString()}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
