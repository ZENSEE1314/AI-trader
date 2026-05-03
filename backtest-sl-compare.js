// ════════════════════════════════════════════════════════════════
//  backtest-sl-compare.js
//
//  Side-by-side comparison of two trailing SL systems on the same
//  analyzeV3 signals and live historical klines.
//
//  System 5  : 10% initial SL, trail kicks in at +46% → locks +45%
//  System 80 : 10% initial SL, trail kicks in at +81% → locks +80%
//  Both       : +10% SL every +11% capital gain after first lock
//
//  Run:
//    DAYS=30 node backtest-sl-compare.js
//    DAYS=14 SYMBOLS=BTCUSDT,ETHUSDT node backtest-sl-compare.js
//
//  Output: per-coin table + aggregate side-by-side + trade log.
// ════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');
const { analyzeV3, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE } = require('./strategy-v3');

const DAYS    = parseInt(process.env.DAYS    || '30', 10);
const CAPITAL = parseFloat(process.env.CAPITAL || '1000');
const RISK    = parseFloat(process.env.RISK    || '0.10');  // 10% position per trade
const SYMBOLS = (process.env.SYMBOLS || ACTIVE_SYMBOLS.join(',')).split(',').map(s => s.trim());

const REQUEST_TIMEOUT = 20_000;

// ── Trailing SL configs ──────────────────────────────────────
// Both start at -10% capital initial SL.
// trailOn  = capital % gain where trail first activates
// firstLock = capital % locked at activation
// Then +10% SL every +11% capital gain thereafter.
const SYSTEMS = [
  { name: 'System 5 (45%)',  trailOn: 0.46, firstLock: 0.45 },
  { name: 'System 80 (80%)', trailOn: 0.81, firstLock: 0.80 },
];

const INITIAL_SL_CAP = 0.10;  // 10% capital initial SL (same for both)

// ── Helpers ──────────────────────────────────────────────────
function fmtUsd(n)  { return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'; }
function fmtPct(n)  { return Number.isFinite(n) ? `${(n >= 0 ? '+' : '')}${n.toFixed(2)}%` : '—'; }
function pad(s, w)  { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }

// ── SL calculator — mirrors calcTrailingSLV3 in strategy-v3.js ──
function calcSL(entry, close, side, leverage, trailOn, firstLock) {
  const pricePct = side === 'LONG'
    ? (close - entry) / entry
    : (entry - close) / entry;
  const capitalPct = pricePct * leverage;

  if (capitalPct < trailOn - 0.0001) {
    const slPricePct = INITIAL_SL_CAP / leverage;
    return side === 'LONG'
      ? entry * (1 - slPricePct)
      : entry * (1 + slPricePct);
  }

  // First lock + +10% every +11% thereafter
  const offsetPct  = Math.round((capitalPct - trailOn) * 10000) / 10000;
  const stepsAbove = Math.floor(offsetPct / 0.11);
  const lockCapPct = firstLock + stepsAbove * 0.10;
  const lockPricePct = lockCapPct / leverage;

  return side === 'LONG'
    ? entry * (1 + lockPricePct)
    : entry * (1 - lockPricePct);
}

// ── Kline fetcher (multi-source fallback) ────────────────────
async function fetchAll(symbol, interval, totalNeeded) {
  const intervalMs = ({ '1m': 60e3, '3m': 180e3, '15m': 900e3, '1h': 3600e3 })[interval];
  const okxSym = symbol.replace('USDT', '-USDT-SWAP');
  const okxBar = interval === '1h' ? '1H' : interval;
  const ccBase = symbol.replace('USDT', '');
  const ccEndpoint = interval === '1h' ? 'histohour' : interval === '1m' ? 'histominute' : null;

  const out = [];
  let endTime = Date.now();
  let firstAttempt = true;

  while (out.length < totalNeeded) {
    const limit = Math.min(1000, totalNeeded - out.length);
    const startTime = endTime - limit * intervalMs;

    const tries = [
      {
        name: 'binance-fapi',
        url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`,
        parse: j => Array.isArray(j) ? j : null,
      },
      {
        name: 'binance-spot',
        url: `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`,
        parse: j => Array.isArray(j) ? j : null,
      },
      {
        name: 'bybit',
        url: `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval.replace('m','').replace('h','60')}&start=${startTime}&end=${endTime}&limit=${Math.min(1000,limit)}`,
        parse: j => j.result?.list?.length
          ? j.result.list.slice().reverse().map(k => [parseInt(k[0]), k[1], k[2], k[3], k[4], k[5]])
          : null,
      },
      {
        name: 'okx',
        url: `https://www.okx.com/api/v5/market/history-candles?instId=${okxSym}&bar=${okxBar}&after=${endTime}&limit=${Math.min(300, limit)}`,
        parse: j => (j.code === '0' && j.data?.length)
          ? j.data.slice().reverse().map(k => [parseInt(k[0]), k[1], k[2], k[3], k[4], k[5]])
          : null,
      },
    ];
    if (ccEndpoint) {
      tries.push({
        name: 'cryptocompare',
        url: `https://min-api.cryptocompare.com/data/v2/${ccEndpoint}?fsym=${ccBase}&tsym=USDT&limit=${Math.min(2000, limit)}&toTs=${Math.floor(endTime / 1000)}`,
        parse: j => (j.Response === 'Success' && j.Data?.Data?.length)
          ? j.Data.Data.map(d => [d.time * 1000, String(d.open), String(d.high), String(d.low), String(d.close), String(d.volumefrom)])
          : null,
      });
    }

    let batch = null, usedSrc = null, lastErr = '';
    for (const t of tries) {
      try {
        const r = await fetch(t.url, { timeout: REQUEST_TIMEOUT });
        if (!r.ok) { lastErr = `${t.name} HTTP ${r.status}`; continue; }
        const j = await r.json();
        const arr = t.parse(j);
        if (arr && arr.length) { batch = arr; usedSrc = t.name; break; }
        lastErr = `${t.name} empty`;
      } catch (e) { lastErr = `${t.name} ${e.message}`; }
    }

    if (firstAttempt) {
      console.log(`  [${symbol} ${interval}] ${batch ? `${batch.length} bars from ${usedSrc}` : `FAILED — ${lastErr}`}`);
      firstAttempt = false;
    }
    if (!batch || !batch.length) break;
    out.unshift(...batch);
    endTime = parseInt(batch[0][0]) - 1;
    if (out.length >= totalNeeded) break;
  }
  return out.slice(-totalNeeded);
}

function aggregate(klines1m, nMin) {
  const out = [];
  for (let i = 0; i + nMin <= klines1m.length; i += nMin) {
    const slice = klines1m.slice(i, i + nMin);
    let h = -Infinity, l = Infinity, v = 0;
    for (const k of slice) {
      if (parseFloat(k[2]) > h) h = parseFloat(k[2]);
      if (parseFloat(k[3]) < l) l = parseFloat(k[3]);
      v += parseFloat(k[5] || 0);
    }
    out.push([parseInt(slice[0][0]), slice[0][1], String(h), String(l), slice[slice.length-1][4], String(v)]);
  }
  return out;
}

// ── Simulate one system on a pre-collected signal list ───────
// signals: [{ entryTs, entry, side, setup, k1m (remaining bars after entry) }]
function simulateSystem(signals, leverage, sys) {
  const trades = [];

  for (const sig of signals) {
    const { entry, side, setup, k1mAfter, entryTs } = sig;
    const isLong = side === 'LONG';
    let sl = isLong
      ? entry * (1 - INITIAL_SL_CAP / leverage)
      : entry * (1 + INITIAL_SL_CAP / leverage);

    let exitTs = null, exitPrice = null, exitReason = null;

    for (const bar of k1mAfter) {
      const high  = parseFloat(bar[2]);
      const low   = parseFloat(bar[3]);
      const close = parseFloat(bar[4]);
      const ts    = parseInt(bar[0]);

      // Check SL hit on this bar (using low/high for realistic fill)
      const slHit = isLong ? low <= sl : high >= sl;
      if (slHit) {
        exitTs = ts; exitPrice = sl; exitReason = 'SL';
        break;
      }

      // Update trailing SL using close of this bar
      const newSl = calcSL(entry, close, side, leverage, sys.trailOn, sys.firstLock);
      // SL can only move in the profitable direction (ratchet)
      if (isLong && newSl > sl) sl = newSl;
      if (!isLong && newSl < sl) sl = newSl;
    }

    // If no exit found, close at last bar
    if (!exitTs) {
      const last = k1mAfter[k1mAfter.length - 1];
      exitTs = parseInt(last[0]);
      exitPrice = parseFloat(last[4]);
      exitReason = 'EOD';
    }

    const pnlPct = isLong
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;
    const pnlUsd = CAPITAL * RISK * pnlPct * leverage;

    trades.push({ side, setup, entry, sl: exitPrice, exitReason, pnlPct, pnlUsd, entryTs, exitTs });
  }

  return trades;
}

// ── Known-loser reversal candidates ─────────────────────────
// These are setups that were 0-12% WR as-is but may be profitable
// if the direction is FLIPPED (e.g. MomentumBreakout+@RangeHigh as
// LONG = 8% WR; reversed to SHORT = potentially 92% WR).
const REVERSAL_PREFIXES = [
  'MomentumBreakout+@RangeHigh',   // bull trap → flip to SHORT
  'MSTF+@15HH+1mHH',               // buying overextended 15m HH → flip SHORT
  'MSTF+@15LL+1mLL',               // selling overextended 15m LL → flip LONG
  'VWAPTrend+@VWAP+EMADn',         // VWAP short in downtrend (0% WR) → flip LONG
];

// ── Run one symbol: collect signals once, simulate both systems ─
async function runSymbol(symbol) {
  const lev = SYMBOL_LEVERAGE[symbol] || 100;
  console.log(`\n── ${symbol} (${lev}x) — fetching ${DAYS} days...`);

  const N1m  = DAYS * 1440;
  const N3m  = DAYS * 480;
  const N15m = DAYS * 96;
  const N1h  = DAYS * 24 + 72;

  const [k1m, k3mFetched, k15mFetched, k1h] = await Promise.all([
    fetchAll(symbol, '1m',  N1m),
    fetchAll(symbol, '3m',  N3m),
    fetchAll(symbol, '15m', N15m),
    fetchAll(symbol, '1h',  N1h),
  ]);

  const k3m  = k3mFetched.length  ? k3mFetched  : aggregate(k1m, 3);
  const k15m = k15mFetched.length ? k15mFetched : aggregate(k1m, 15);
  if (!k3mFetched.length  && k1m.length) console.log(`  ↳ 3m  aggregated → ${k3m.length} bars`);
  if (!k15mFetched.length && k1m.length) console.log(`  ↳ 15m aggregated → ${k15m.length} bars`);

  console.log(`  fetched: 1m=${k1m.length} 3m=${k3m.length} 15m=${k15m.length} 1h=${k1h.length}`);
  if (k1m.length < 200 || k15m.length < 30) { console.log(`  insufficient data — skip`); return null; }

  // Build ts→idx maps for aligned windows
  const byTs = {
    '3m':  new Map(k3m.map((k, i) => [parseInt(k[0]), i])),
    '15m': new Map(k15m.map((k, i) => [parseInt(k[0]), i])),
    '1h':  new Map(k1h.map((k, i) => [parseInt(k[0]), i])),
  };
  function lastIdxAtOrBefore(map, ts) {
    for (let off = 0; off <= 60; off++) {
      const idx = map.get(ts - off * 60_000);
      if (idx !== undefined) return idx;
    }
    return -1;
  }

  // ── Signal collection pass (run analyzeV3 once per bar) ──
  const signals = [];
  let inTrade = false;
  let analyzeCalls = 0, analyzeErrs = 0;

  for (let i = 100; i < k1m.length - 1; i++) {
    const bar   = k1m[i];
    const ts    = parseInt(bar[0]);
    const close = parseFloat(bar[4]);

    // Simple "one trade at a time" gate — skip if in trade
    // (use System 5 SL as the gating trade so we don't double-count signals)
    if (inTrade) {
      // Check if the last open trade would have exited by now
      const lastSig = signals[signals.length - 1];
      if (lastSig) {
        const isLong = lastSig.side === 'LONG';
        const slSys5 = calcSL(lastSig.entry, close, lastSig.side, lev, 0.46, 0.45);
        const high = parseFloat(bar[2]);
        const low  = parseFloat(bar[3]);
        if (isLong ? low <= slSys5 : high >= slSys5) inTrade = false;
        // Also exit if we've been in trade > 7 days (10080 min) — prevents lock-up
        if (ts - lastSig.entryTs > 7 * 24 * 60 * 60 * 1000) inTrade = false;
      }
      if (inTrade) continue;
    }

    const i3m  = lastIdxAtOrBefore(byTs['3m'],  ts);
    const i15m = lastIdxAtOrBefore(byTs['15m'], ts);
    const i1h  = lastIdxAtOrBefore(byTs['1h'],  ts);
    if (i3m < 30 || i15m < 30 || i1h < 24) continue;

    const k1mWin  = k1m.slice(Math.max(0, i - 59), i + 1);
    const k3mWin  = k3m.slice(Math.max(0, i3m - 99),  i3m + 1);
    const k15mWin = k15m.slice(Math.max(0, i15m - 99), i15m + 1);
    const k1hWin  = k1h.slice(Math.max(0, i1h - 71),  i1h + 1);

    let sig = null;
    try {
      sig = await analyzeV3({
        symbol,
        lastPrice: String(close),
        klines: { k1m: k1mWin, k3m: k3mWin, k15m: k15mWin, k1h: k1hWin },
      });
    } catch (e) { analyzeErrs++; }
    analyzeCalls++;

    if (!sig || !sig.direction) continue;

    // Capture the remaining 1m bars after entry (up to 7 days) for simulation
    const k1mAfter = k1m.slice(i + 1, Math.min(k1m.length, i + 1 + 7 * 1440));
    if (!k1mAfter.length) continue;

    signals.push({
      entryTs: ts,
      entry:   close,
      side:    sig.direction,
      setup:   sig.setupName || 'unknown',
      score:   sig.score || 0,
      k1mAfter,
    });
    inTrade = true;
  }

  console.log(`  signals found: ${signals.length}  (analyzeV3 calls=${analyzeCalls} errs=${analyzeErrs})`);
  if (!signals.length) return null;

  // ── Reversal pass: collect known-loser setups with flipped direction ──
  // Runs the same bars again with skipBlocklist=true, filters to REVERSAL_PREFIXES
  // setups, flips their direction, and simulates separately.
  const reversalSignals = [];
  let revInTrade = false;

  for (let i = 100; i < k1m.length - 1; i++) {
    const bar   = k1m[i];
    const ts    = parseInt(bar[0]);
    const close = parseFloat(bar[4]);

    if (revInTrade) {
      const lastSig = reversalSignals[reversalSignals.length - 1];
      if (lastSig) {
        const slSys5 = calcSL(lastSig.entry, close, lastSig.side, lev, 0.46, 0.45);
        const high = parseFloat(bar[2]), low = parseFloat(bar[3]);
        if (lastSig.side === 'LONG' ? low <= slSys5 : high >= slSys5) revInTrade = false;
        if (ts - lastSig.entryTs > 7 * 24 * 60 * 60 * 1000) revInTrade = false;
      }
      if (revInTrade) continue;
    }

    const i3m  = lastIdxAtOrBefore(byTs['3m'],  ts);
    const i15m = lastIdxAtOrBefore(byTs['15m'], ts);
    const i1h  = lastIdxAtOrBefore(byTs['1h'],  ts);
    if (i3m < 30 || i15m < 30 || i1h < 24) continue;

    const k1mWin  = k1m.slice(Math.max(0, i - 59), i + 1);
    const k3mWin  = k3m.slice(Math.max(0, i3m - 99),  i3m + 1);
    const k15mWin = k15m.slice(Math.max(0, i15m - 99), i15m + 1);
    const k1hWin  = k1h.slice(Math.max(0, i1h - 71),  i1h + 1);

    let revSig = null;
    try {
      revSig = await analyzeV3({
        symbol,
        lastPrice: String(close),
        klines: { k1m: k1mWin, k3m: k3mWin, k15m: k15mWin, k1h: k1hWin },
      }, { skipBlocklist: true });
    } catch (_) {}

    if (!revSig?.direction) continue;

    const setupNm = revSig.setupName || 'unknown';
    const isReversal = REVERSAL_PREFIXES.some(pfx => setupNm.startsWith(pfx));
    if (!isReversal) continue;

    // Flip the direction for this known-loser setup
    const flippedDir = revSig.direction === 'LONG' ? 'SHORT' : 'LONG';

    const k1mAfter = k1m.slice(i + 1, Math.min(k1m.length, i + 1 + 7 * 1440));
    if (!k1mAfter.length) continue;

    reversalSignals.push({
      entryTs: ts,
      entry:   close,
      side:    flippedDir,
      setup:   `REV:${setupNm}`,
      score:   revSig.score || 0,
      k1mAfter,
    });
    revInTrade = true;
  }

  console.log(`  reversal signals: ${reversalSignals.length}`);

  // ── Simulate both systems on the same signals ──
  const results = {};
  for (const sys of SYSTEMS) {
    results[sys.name] = simulateSystem(signals, lev, sys);
  }

  // Reversal system simulation
  const reversalTrades = reversalSignals.length
    ? simulateSystem(reversalSignals, lev, SYSTEMS[0])
    : [];

  return { symbol, lev, signals, results, reversalTrades };
}

// ── Stats helper ─────────────────────────────────────────────
function stats(trades) {
  if (!trades.length) return { total: 0, wins: 0, losses: 0, wr: 0, net: 0, avgWin: 0, avgLoss: 0 };
  const wins   = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const net    = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const avgWin  = wins.length   ? wins.reduce((s, t)   => s + t.pnlUsd, 0) / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : 0;
  return {
    total:   trades.length,
    wins:    wins.length,
    losses:  losses.length,
    wr:      (wins.length / trades.length) * 100,
    net,
    avgWin,
    avgLoss,
    profitFactor: losses.length && Math.abs(avgLoss) > 0
      ? (wins.reduce((s, t) => s + t.pnlUsd, 0)) / Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0))
      : Infinity,
  };
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const SYS5 = SYSTEMS[0];  // System 5 only

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  SYSTEM 5 BACKTEST — ${DAYS} days — $${CAPITAL} start — ${(RISK*100).toFixed(0)}% risk/trade`);
  console.log(`  −10% initial SL, trail at +46% → lock +45%, then +10% SL per +11%`);
  console.log('═══════════════════════════════════════════════════════════════════');

  const allSymResults = [];
  for (const sym of SYMBOLS) {
    const r = await runSymbol(sym);
    if (r) allSymResults.push(r);
  }

  if (!allSymResults.length) { console.log('\nNo results.'); process.exit(0); }

  // ── Per-coin table ───────────────────────────────────────
  console.log('\n══════════ PER-COIN RESULTS ════════════════════════════════════════');
  console.log(`${'symbol'.padEnd(11)} ${'lev'.padEnd(5)} ${'trades'.padStart(6)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'WR%'.padStart(6)} ${'avg W'.padStart(9)} ${'avg L'.padStart(9)} ${'net P&L'.padStart(10)}`);
  console.log('─'.repeat(70));

  let allTrades = [];
  let totWins = 0, totLosses = 0, totNet = 0;

  for (const r of allSymResults) {
    const trades = r.results[SYS5.name];
    const s = stats(trades);
    console.log(
      `${pad(r.symbol, 11)} ${pad(r.lev + 'x', 5)} ${rpad(s.total, 6)} ${rpad(s.wins, 4)} ${rpad(s.losses, 4)}` +
      ` ${rpad(s.wr.toFixed(1) + '%', 6)} ${rpad(fmtUsd(s.avgWin), 9)} ${rpad(fmtUsd(s.avgLoss), 9)} ${rpad(fmtUsd(s.net), 10)}`
    );
    allTrades.push(...trades.map(t => ({ ...t, symbol: r.symbol, lev: r.lev })));
    totWins   += s.wins;
    totLosses += s.losses;
    totNet    += s.net;
  }
  const totTrades = totWins + totLosses;
  const totWR = totTrades ? (totWins / totTrades) * 100 : 0;
  console.log('─'.repeat(70));
  console.log(
    `${'TOTAL'.padEnd(16)} ${rpad(totTrades, 6)} ${rpad(totWins, 4)} ${rpad(totLosses, 4)}` +
    ` ${rpad(totWR.toFixed(1) + '%', 6)}` +
    `${' '.repeat(20)} ${rpad(fmtUsd(totNet), 10)}`
  );
  console.log(`  Final capital: $${(CAPITAL + totNet).toFixed(2)}  (${totNet >= 0 ? '+' : ''}${((totNet / CAPITAL) * 100).toFixed(1)}% return)`);

  // ── By setup ─────────────────────────────────────────────
  console.log('\n══════════ BY SETUP (worst losers first) ═══════════════════════════');
  console.log(`${'setup'.padEnd(38)} ${'n'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'WR%'.padStart(6)} ${'net'.padStart(9)}`);
  console.log('─'.repeat(70));
  const bySetup = {};
  for (const t of allTrades) {
    if (!bySetup[t.setup]) bySetup[t.setup] = { wins: 0, losses: 0, net: 0 };
    bySetup[t.setup].net += t.pnlUsd;
    if (t.pnlUsd > 0) bySetup[t.setup].wins++; else bySetup[t.setup].losses++;
  }
  // Sort by net (worst first)
  for (const [name, v] of Object.entries(bySetup).sort((a, b) => a[1].net - b[1].net)) {
    const n  = v.wins + v.losses;
    const wr = (v.wins / n) * 100;
    const marker = v.net < 0 ? ' ◄ LOSING' : '';
    console.log(`${pad(name, 38)} ${rpad(n, 4)} ${rpad(v.wins, 4)} ${rpad(v.losses, 4)} ${rpad(wr.toFixed(1) + '%', 6)} ${rpad(fmtUsd(v.net), 9)}${marker}`);
  }

  // ── By direction ─────────────────────────────────────────
  console.log('\n══════════ LONG vs SHORT ═══════════════════════════════════════════');
  for (const dir of ['LONG', 'SHORT']) {
    const dt = allTrades.filter(t => t.side === dir);
    if (!dt.length) continue;
    const s = stats(dt);
    console.log(`  ${dir.padEnd(6)}  ${s.total} trades   W=${s.wins}  L=${s.losses}   WR=${s.wr.toFixed(1)}%   avg win=${fmtUsd(s.avgWin)}   avg loss=${fmtUsd(s.avgLoss)}   net=${fmtUsd(s.net)}`);
  }

  // ── Losing setups detail ─────────────────────────────────
  const losingSetups = Object.entries(bySetup)
    .filter(([, v]) => v.net < 0)
    .sort((a, b) => a[1].net - b[1].net);

  if (losingSetups.length) {
    console.log('\n══════════ ROOT CAUSE — LOSING SETUP EXAMPLES ═════════════════════');
    for (const [name] of losingSetups.slice(0, 3)) {
      const examples = allTrades
        .filter(t => t.setup === name && t.pnlUsd < 0)
        .slice(0, 3);
      console.log(`\n  ${name}:`);
      for (const t of examples) {
        const ts = new Date(t.entryTs).toISOString().slice(0, 16);
        console.log(`    ${ts}  ${t.symbol} ${t.side}  entry=$${t.entry.toFixed(2)}  pnl=${fmtUsd(t.pnlUsd)}`);
      }
    }
  }

  // ── Reversal test ─────────────────────────────────────────
  // Did flipping direction on the known-loser setups produce profit?
  const allRevTrades = allSymResults.flatMap(r =>
    (r.reversalTrades || []).map(t => ({ ...t, symbol: r.symbol, lev: r.lev }))
  );
  if (allRevTrades.length) {
    console.log('\n══════════ REVERSAL TEST — FLIPPED DIRECTION ON KNOWN LOSERS ═══════');
    console.log('  Same entry bar, direction flipped: LONG→SHORT, SHORT→LONG');
    console.log('  (MomentumBreakout@RangeHigh, MSTF@15HH/15LL, VWAPEMADn)');
    const rs = stats(allRevTrades);
    console.log(`\n  Reversed trades : ${rs.total}`);
    console.log(`  Win Rate        : ${rs.wr.toFixed(1)}%  (W=${rs.wins}  L=${rs.losses})`);
    console.log(`  Avg Win / Loss  : ${fmtUsd(rs.avgWin)} / ${fmtUsd(rs.avgLoss)}`);
    console.log(`  Net P&L         : ${fmtUsd(rs.net)}`);
    console.log(`  Profit Factor   : ${Number.isFinite(rs.profitFactor) ? rs.profitFactor.toFixed(2) : '∞'}`);

    const byRevSetup = {};
    for (const t of allRevTrades) {
      if (!byRevSetup[t.setup]) byRevSetup[t.setup] = { wins: 0, losses: 0, net: 0 };
      byRevSetup[t.setup].net += t.pnlUsd;
      if (t.pnlUsd > 0) byRevSetup[t.setup].wins++; else byRevSetup[t.setup].losses++;
    }
    console.log(`\n  ${'setup'.padEnd(52)} ${'n'.padStart(4)} ${'WR%'.padStart(6)} ${'net'.padStart(9)}`);
    console.log('  ' + '─'.repeat(74));
    for (const [name, v] of Object.entries(byRevSetup).sort((a, b) => b[1].net - a[1].net)) {
      const n  = v.wins + v.losses;
      const wr = (v.wins / n) * 100;
      const marker = v.net > 0 ? '  ✓ ADD THIS' : '  ✗ still loses reversed too';
      console.log(`  ${pad(name, 52)} ${rpad(n, 4)} ${rpad(wr.toFixed(1) + '%', 6)} ${rpad(fmtUsd(v.net), 9)}${marker}`);
    }

    const combinedNet    = totNet + rs.net;
    const combinedTrades = totTrades + rs.total;
    const combinedWins   = totWins + rs.wins;
    console.log(`\n  ── Combined result if reversed setups are added to normal strategy ──`);
    console.log(`  ${totTrades} normal + ${rs.total} reversed = ${combinedTrades} total trades`);
    console.log(`  WR: ${((combinedWins / combinedTrades) * 100).toFixed(1)}%   Net: ${fmtUsd(combinedNet)}`);
    console.log(`  Final capital: $${(CAPITAL + combinedNet).toFixed(2)}  (${combinedNet >= 0 ? '+' : ''}${((combinedNet / CAPITAL) * 100).toFixed(1)}% return)`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  process.exit(0);
})().catch(e => {
  console.error('backtest failed:', e.stack || e.message);
  process.exit(1);
});
