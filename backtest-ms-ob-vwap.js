// Backtest the MS-OB-VWAP short strategy over historical klines.
//
// Walks 15m bars; at each bar it evaluates strategy-ms-ob-vwap.js against the
// 1H/4H/15m windows AS THEY WERE at that bar, and when a SHORT fires it
// simulates the trade to TP (green OB) or SL (above structure), one position
// per symbol at a time. Reports signals, win-rate, avg RR, and net R.
//
// Needs network (Bybit) — run on the VPN machine:
//   node backtest-ms-ob-vwap.js
// Env: DAYS (default 60), SYMBOLS (default BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT),
//      MAX_HOLD_BARS (15m bars before timeout close, default 96 = 1 day),
//      plus the MSOB_* strategy tunables.
//
// Honest limitations: 1m confirmation is NOT applied (1m history over months is
// impractical to fetch) — so live will take slightly FEWER trades than this.
// TP/SL are detected at 15m resolution; no fees/slippage. Treat R multiples as
// the headline; a real fill will be a touch worse.

const fs = require('fs');
const { fetchCandlesUpTo } = require('./trade-deep-analysis');
const msob = require('./strategy-ms-ob-vwap');

// KLINES_FILE = run offline from a msob-collect.js dump (no network needed).
const KFILE = process.env.KLINES_FILE || '';
const FILEDATA = KFILE ? JSON.parse(fs.readFileSync(KFILE, 'utf8')) : null;

const DAYS = Math.max(5, parseInt(process.env.DAYS || '60', 10) || 60);
const SYMS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const MAX_HOLD = Math.max(4, parseInt(process.env.MAX_HOLD_BARS || '96', 10) || 96);
const TF = { h1: '60', h4: '240', m15: '15' };
const money = n => (n < 0 ? '−' : '+') + Math.abs(n).toFixed(2);

// Paginate Bybit backwards until we have ~targetBars (oldest-first, deduped).
async function fetchLong(sym, tf, targetBars) {
  const map = new Map();
  let end = Date.now(), guard = 0;
  while (map.size < targetBars && guard++ < 80) {
    const batch = await fetchCandlesUpTo(sym, tf, 1000, end);
    if (!batch || !batch.length) break;
    for (const c of batch) map.set(c.t, c);
    end = batch[0].t - 1;
    if (batch.length < 1000) break;
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

async function getSeries(sym, tf, bars) {
  if (FILEDATA) return (FILEDATA.data?.[sym]?.[tf]) || [];
  return fetchLong(sym, tf, bars);
}

async function backtestSymbol(sym) {
  const [c15, c1h, c4h] = await Promise.all([
    getSeries(sym, TF.m15, DAYS * 96 + 220),
    getSeries(sym, TF.h1,  DAYS * 24 + 160),
    getSeries(sym, TF.h4,  DAYS * 6  + 160),
  ]);
  if (c15.length < 300 || c1h.length < 60 || c4h.length < 60) {
    return { sym, error: `insufficient history (15m=${c15.length}, 1h=${c1h.length}, 4h=${c4h.length})` };
  }

  const trades = [];
  let h1 = 0, h4 = 0, open = null;

  for (let i = 220; i < c15.length; i++) {
    const bar = c15[i];
    // advance HTF pointers to the last closed HTF bar at/before this 15m bar
    while (h1 + 1 < c1h.length && c1h[h1 + 1].t <= bar.t) h1++;
    while (h4 + 1 < c4h.length && c4h[h4 + 1].t <= bar.t) h4++;

    // manage an open SHORT on this bar
    if (open) {
      const hitSl = bar.h >= open.sl;
      const hitTp = bar.l <= open.tp;
      let exit = null, outcome = null;
      if (hitSl && hitTp) { exit = open.sl; outcome = 'SL'; }         // conservative: assume SL first
      else if (hitSl)     { exit = open.sl; outcome = 'SL'; }
      else if (hitTp)     { exit = open.tp; outcome = 'TP'; }
      else if (i - open.i >= MAX_HOLD) { exit = bar.c; outcome = 'TIMEOUT'; }
      if (exit != null) {
        const risk = open.sl - open.entry;
        const rMult = (open.entry - exit) / risk; // SHORT: profit when exit < entry
        trades.push({ ...open, exit, outcome, rMult, pnlPct: (open.entry - exit) / open.entry * 100 });
        open = null;
      }
      continue; // one position per symbol at a time
    }

    const setup = msob.evaluate({
      symbol: sym,
      c1h: c1h.slice(Math.max(0, h1 - 119), h1 + 1),
      c4h: c4h.slice(Math.max(0, h4 - 119), h4 + 1),
      c15: c15.slice(i - 199, i + 1),
      c1m: null, // see limitations note
    });
    if (setup.take) open = { i, t: bar.t, entry: setup.entry, tp: setup.tp, sl: setup.sl, rrPlanned: setup.rr };
  }

  const wins = trades.filter(t => t.rMult > 0);
  const sumR = trades.reduce((s, t) => s + t.rMult, 0);
  const sumPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  return {
    sym, n: trades.length,
    wins: wins.length, wr: trades.length ? wins.length / trades.length * 100 : 0,
    tp: trades.filter(t => t.outcome === 'TP').length,
    sl: trades.filter(t => t.outcome === 'SL').length,
    to: trades.filter(t => t.outcome === 'TIMEOUT').length,
    sumR, avgR: trades.length ? sumR / trades.length : 0, sumPct,
    trades,
  };
}

async function main() {
  console.log(`MS-OB-VWAP backtest — ${SYMS.join(',')} | ${DAYS}d | max hold ${MAX_HOLD} bars`);
  console.log(`Tunables: K=${process.env.MSOB_VWAP_K || 2} prox=${process.env.MSOB_VWAP_PROX_PCT || 0.15}% minRR=${process.env.MSOB_MIN_RR || 1.2}\n`);
  let allN = 0, allW = 0, allR = 0, allPct = 0;
  for (const sym of SYMS) {
    let r;
    try { r = await backtestSymbol(sym); } catch (e) { console.log(`${sym}: ERROR ${e.message}`); continue; }
    if (r.error) { console.log(`${sym}: ${r.error}`); continue; }
    console.log(`${sym.padEnd(9)} signals ${String(r.n).padStart(3)} | WR ${r.wr.toFixed(1).padStart(5)}% `
      + `| TP/SL/TO ${r.tp}/${r.sl}/${r.to} | netR ${money(r.sumR).padStart(7)} | avgR ${r.avgR.toFixed(2).padStart(5)} | sum% ${money(r.sumPct)}`);
    allN += r.n; allW += r.wins; allR += r.sumR; allPct += r.sumPct;
  }
  console.log(`\nTOTAL      signals ${allN} | WR ${allN ? (allW / allN * 100).toFixed(1) : '0'}% | netR ${money(allR)} | sum% ${money(allPct)}`);
  console.log(`\nEnable live only if netR is clearly positive with a workable win-rate.`);
  console.log(`Reminder: 1m confirmation not applied here (live takes fewer, better-timed trades); no fees/slippage.`);
}

main().catch(e => { console.error('Backtest failed:', e.message); process.exitCode = 1; });
