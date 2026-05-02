// ════════════════════════════════════════════════════════════════
//  backtest-v3-gates.js
//
//  Walk-forward backtest of the current strategy-v3 gate stack.
//  Pulls historical klines for BTC/ETH/SOL/BNB, iterates 1m at a
//  time, and feeds analyzeV3 with sliced kline windows. Trades that
//  fire are simulated to TP / SL / structure exit; capital tracked
//  on a $1000 starting balance with 10% risk per trade.
//
//  Run on Railway:
//    DAYS=7 node backtest-v3-gates.js
//
//  Output: per-coin and aggregate W/L, WR%, P&L on $1000.
// ════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');
const { analyzeV3 } = require('./strategy-v3');

const DAYS    = parseInt(process.env.DAYS || '7',  10);
const CAPITAL = parseFloat(process.env.CAPITAL || '1000');
const RISK    = parseFloat(process.env.RISK || '0.10'); // 10% per trade
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT').split(',');
const HIGH_LEV = new Set(['BTCUSDT', 'ETHUSDT']);

// Initial SL = 20% of capital, TP-trail starts at +21% capital, then
// every +10% gain locks SL +10% above the previous lock.
const INITIAL_SL_PCT  = 0.20;  // capital
const TRAIL_START_PCT = 0.21;
const TRAIL_STEP_PCT  = 0.10;

const REQUEST_TIMEOUT = 20_000;

async function fetchAll(symbol, interval, totalNeeded) {
  // Binance limit per request = 1500. Bybit = 1000. OKX = 300. CC = 2000.
  const out = [];
  const intervalMs = ({ '1m': 60e3, '3m': 180e3, '15m': 900e3, '1h': 3600e3 })[interval];
  const okxSym = symbol.replace('USDT', '-USDT-SWAP');
  const okxBar = interval === '1h' ? '1H' : interval;
  // CryptoCompare fsym/tsym
  const ccBase = symbol.replace('USDT', '');
  const ccQuote = 'USDT';
  // CC supports 1m and 1h directly. 3m/15m we aggregate from 1m later.
  const ccEndpoint = interval === '1h' ? 'histohour' : interval === '1m' ? 'histominute' : null;
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
        url: `https://min-api.cryptocompare.com/data/v2/${ccEndpoint}?fsym=${ccBase}&tsym=${ccQuote}&limit=${Math.min(2000, limit)}&toTs=${Math.floor(endTime / 1000)}`,
        parse: j => (j.Response === 'Success' && j.Data?.Data?.length)
          ? j.Data.Data.map(d => [d.time * 1000, String(d.open), String(d.high), String(d.low), String(d.close), String(d.volumefrom)])
          : null,
      });
    }
    let batch = null;
    let usedSrc = null;
    let lastErr = '';
    for (const t of tries) {
      try {
        const r = await fetch(t.url, { timeout: REQUEST_TIMEOUT });
        if (!r.ok) { lastErr = `${t.name} HTTP ${r.status}`; continue; }
        const j = await r.json();
        const arr = t.parse(j);
        if (arr && arr.length) { batch = arr; usedSrc = t.name; break; }
        lastErr = `${t.name} empty`;
      } catch (e) {
        lastErr = `${t.name} ${e.message}`;
      }
    }
    if (firstAttempt) {
      console.log(`  [fetchAll ${symbol} ${interval}] first batch: ${batch ? `${batch.length} bars from ${usedSrc}` : `FAILED — last err: ${lastErr}`}`);
      firstAttempt = false;
    }
    if (!batch || !batch.length) break;
    out.unshift(...batch);
    endTime = parseInt(batch[0][0]) - 1;
    if (out.length >= totalNeeded) break;
  }
  return out.slice(-totalNeeded);
}

// Aggregate 1m bars into n-minute bars (used when CC fallback is the
// only source — CC has 1m and 1h but not 3m/15m).
function aggregate(klines1m, nMin) {
  const out = [];
  let i = 0;
  while (i + nMin <= klines1m.length) {
    const slice = klines1m.slice(i, i + nMin);
    const o = slice[0][1];
    const c = slice[slice.length - 1][4];
    let h = -Infinity, l = Infinity, v = 0;
    for (const k of slice) {
      const hh = parseFloat(k[2]);
      const ll = parseFloat(k[3]);
      if (hh > h) h = hh;
      if (ll < l) l = ll;
      v += parseFloat(k[5] || 0);
    }
    out.push([parseInt(slice[0][0]), String(o), String(h), String(l), String(c), String(v)]);
    i += nMin;
  }
  return out;
}

function fmtUsd(n)  { return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'; }
function fmtPct(n)  { return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—'; }

async function runSymbol(symbol) {
  const lev = HIGH_LEV.has(symbol) ? 100 : 50;
  console.log(`\n── ${symbol} (${lev}x) — fetching ${DAYS} days of klines...`);

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

  // Fall back to aggregating from 1m when 3m/15m fetch failed.
  const k3m  = k3mFetched.length  ? k3mFetched  : aggregate(k1m, 3);
  const k15m = k15mFetched.length ? k15mFetched : aggregate(k1m, 15);
  if (!k3mFetched.length  && k1m.length) console.log(`  ↳ 3m  aggregated from ${k1m.length} 1m bars → ${k3m.length} bars`);
  if (!k15mFetched.length && k1m.length) console.log(`  ↳ 15m aggregated from ${k1m.length} 1m bars → ${k15m.length} bars`);

  console.log(`  fetched: 1m=${k1m.length} 3m=${k3m.length} 15m=${k15m.length} 1h=${k1h.length}`);
  if (k1m.length < 100 || k15m.length < 30) {
    console.log(`  insufficient data — skipping`);
    return null;
  }

  const trades = [];
  let openPos = null;

  // Pre-build timestamp -> idx maps for fast lookups
  const byTs = {
    '3m':  new Map(k3m.map((k, i) => [parseInt(k[0]), i])),
    '15m': new Map(k15m.map((k, i) => [parseInt(k[0]), i])),
    '1h':  new Map(k1h.map((k, i) => [parseInt(k[0]), i])),
  };

  function lastIdxAtOrBefore(map, ts) {
    // Walk back at most 240 minutes to find an aligned bar
    for (let off = 0; off <= 60; off++) {
      const aligned = ts - off * 60_000;
      const idx = map.get(aligned);
      if (idx !== undefined) return idx;
    }
    return -1;
  }

  // Walk forward — start at index 60 to ensure all windows have data
  for (let i = 100; i < k1m.length - 1; i++) {
    const bar = k1m[i];
    const ts  = parseInt(bar[0]);
    const close = parseFloat(bar[4]);

    // Manage open position first
    if (openPos) {
      const high = parseFloat(bar[2]);
      const low  = parseFloat(bar[3]);
      const isLong = openPos.side === 'LONG';

      // Check SL hit
      const slHit = isLong ? low <= openPos.sl : high >= openPos.sl;
      if (slHit) {
        const pnlPct = isLong
          ? (openPos.sl - openPos.entry) / openPos.entry
          : (openPos.entry - openPos.sl) / openPos.entry;
        const pnlUsd = openPos.size * pnlPct * lev;
        trades.push({ ...openPos, exitTs: ts, exitPrice: openPos.sl, pnlPct, pnlUsd, exitReason: 'SL' });
        openPos = null;
        continue;
      }

      // Check trail step — every TRAIL_STEP_PCT of capital gain, lock SL +TRAIL_STEP_PCT
      const profitPct = isLong
        ? (close - openPos.entry) / openPos.entry
        : (openPos.entry - close) / openPos.entry;
      const capPct = profitPct * lev;
      if (capPct >= TRAIL_START_PCT) {
        const lockPct = Math.floor(capPct * 10) / 10; // floor to 0.1
        const lockedSlCapPct = lockPct - 0.01; // lock 1% below current capital pct
        if (lockedSlCapPct > openPos.lockedSlCapPct) {
          const newSlPricePct = lockedSlCapPct / lev;
          const newSl = isLong
            ? openPos.entry * (1 + newSlPricePct)
            : openPos.entry * (1 - newSlPricePct);
          openPos.sl = newSl;
          openPos.lockedSlCapPct = lockedSlCapPct;
        }
      }
    }

    // Skip signal check if a position is open (1 trade per coin at a time)
    if (openPos) continue;

    // Build kline windows ending at the current 1m bar
    const k1mWin  = k1m.slice(Math.max(0, i - 59), i + 1);
    const i3m     = lastIdxAtOrBefore(byTs['3m'],  ts);
    const i15m    = lastIdxAtOrBefore(byTs['15m'], ts);
    const i1h     = lastIdxAtOrBefore(byTs['1h'],  ts);
    if (i3m < 30 || i15m < 30 || i1h < 24) continue;

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
    } catch (e) { /* skip */ }

    if (!sig || !sig.direction) continue;

    // Open position — entry at current close, SL at -INITIAL_SL_PCT capital
    const slPricePct = INITIAL_SL_PCT / lev;
    const slPrice = sig.direction === 'LONG'
      ? close * (1 - slPricePct)
      : close * (1 + slPricePct);

    openPos = {
      symbol,
      side: sig.direction,
      setup: sig.setupName || 'unknown',
      entry: close,
      sl: slPrice,
      entryTs: ts,
      size: CAPITAL * RISK,
      lockedSlCapPct: -INITIAL_SL_PCT,
    };
  }

  // Close any leftover position at last close
  if (openPos) {
    const last = k1m[k1m.length - 1];
    const exitPrice = parseFloat(last[4]);
    const isLong = openPos.side === 'LONG';
    const pnlPct = isLong
      ? (exitPrice - openPos.entry) / openPos.entry
      : (openPos.entry - exitPrice) / openPos.entry;
    const pnlUsd = openPos.size * pnlPct * lev;
    trades.push({ ...openPos, exitTs: parseInt(last[0]), exitPrice, pnlPct, pnlUsd, exitReason: 'EOD' });
  }

  return { symbol, lev, trades };
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  STRATEGY V3 BACKTEST — ${DAYS} days — $${CAPITAL} capital`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];
  for (const sym of SYMBOLS) {
    const r = await runSymbol(sym);
    if (r) results.push(r);
  }

  console.log('\n══════════ PER-COIN RESULTS ═══════════════════════════════');
  console.log('symbol      lev  trades  wins  losses    WR     net P&L');
  console.log('─'.repeat(64));
  let allWins = 0, allLosses = 0, allNet = 0, allTrades = 0;
  const allTradesArr = [];
  for (const r of results) {
    const wins = r.trades.filter(t => t.pnlUsd > 0).length;
    const losses = r.trades.filter(t => t.pnlUsd <= 0).length;
    const net = r.trades.reduce((s, t) => s + t.pnlUsd, 0);
    const wr = r.trades.length ? (wins / r.trades.length) * 100 : 0;
    console.log(
      `${r.symbol.padEnd(12)}${String(r.lev + 'x').padEnd(5)}` +
      `${String(r.trades.length).padStart(6)} ${String(wins).padStart(5)} ${String(losses).padStart(7)}` +
      `   ${fmtPct(wr).padStart(6)}   ${fmtUsd(net).padStart(10)}`
    );
    allWins   += wins;
    allLosses += losses;
    allNet    += net;
    allTrades += r.trades.length;
    allTradesArr.push(...r.trades);
  }
  console.log('─'.repeat(64));
  const aggWr = allTrades ? (allWins / allTrades) * 100 : 0;
  console.log(
    `${'TOTAL'.padEnd(17)}${String(allTrades).padStart(6)} ${String(allWins).padStart(5)} ${String(allLosses).padStart(7)}` +
    `   ${fmtPct(aggWr).padStart(6)}   ${fmtUsd(allNet).padStart(10)}`
  );

  console.log('\n══════════ BY SETUP ═══════════════════════════════════════');
  const bySetup = {};
  for (const t of allTradesArr) {
    if (!bySetup[t.setup]) bySetup[t.setup] = { wins: 0, losses: 0, net: 0, total: 0 };
    bySetup[t.setup].total++;
    bySetup[t.setup].net += t.pnlUsd;
    if (t.pnlUsd > 0) bySetup[t.setup].wins++; else bySetup[t.setup].losses++;
  }
  for (const [k, v] of Object.entries(bySetup).sort((a, b) => b[1].total - a[1].total)) {
    const wr = (v.wins / v.total) * 100;
    console.log(`  ${k.padEnd(20)} ${String(v.total).padStart(4)} trades   W=${v.wins}  L=${v.losses}   WR=${fmtPct(wr)}   net=${fmtUsd(v.net)}`);
  }

  console.log('\n══════════ ENDING CAPITAL ═════════════════════════════════');
  const finalCap = CAPITAL + allNet;
  const retPct = (allNet / CAPITAL) * 100;
  console.log(`  Start:  $${CAPITAL.toFixed(2)}`);
  console.log(`  End:    $${finalCap.toFixed(2)}`);
  console.log(`  Return: ${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%   (over ${DAYS} days)`);
  console.log('═══════════════════════════════════════════════════════════');

  process.exit(0);
})().catch(e => {
  console.error('backtest failed:', e.stack || e.message);
  process.exit(1);
});
