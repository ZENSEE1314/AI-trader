'use strict';

// EQL/EQH liquidity sweep backtest.
//
// Strategy:
//   EQL below price = sell-side liquidity.
//     If price sweeps below EQL and closes back above it, then breaks a recent
//     micro swing high, enter LONG.
//   EQH above price = buy-side liquidity.
//     If price sweeps above EQH and closes back below it, then breaks a recent
//     micro swing low, enter SHORT.
//
// This follows the common liquidity-sweep idea: equal highs/lows are liquidity,
// but entry waits for rejection + market structure shift.

const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getFetchOptions } = require('./proxy-agent');

const DAYS = parseInt(process.env.DAYS || '30', 10);
const START_BALANCE = parseFloat(process.env.START_BALANCE || '1000');
const CAPITAL_PCT = parseFloat(process.env.CAPITAL_PCT || '0.10');
const FEE_RATE = parseFloat(process.env.FEE_RATE || '0.0012');
const TP_ON_MARGIN = parseFloat(process.env.TP_ON_MARGIN || '0.50');
const SL_ON_MARGIN = parseFloat(process.env.SL_ON_MARGIN || '0.30');
const LEVERAGE_OVERRIDE = parseFloat(process.env.LEVERAGE_OVERRIDE || '50');
const MAX_HOLD_BARS = parseInt(process.env.MAX_HOLD_BARS || '48', 10); // 12h on 15m
const EQ_TOL_PCT = parseFloat(process.env.EQ_TOL_PCT || '0.0010'); // equal within 0.10%
const SWEEP_MIN_PCT = parseFloat(process.env.SWEEP_MIN_PCT || '0.0002');
const MSS_LOOKBACK = parseInt(process.env.MSS_LOOKBACK || '8', 10);
const EQ_LOOKBACK = parseInt(process.env.EQ_LOOKBACK || '80', 10);

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,ADAUSDT,DOTUSDT,LINKUSDT,LTCUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function money(n) {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

function ymdUtc(date) {
  return date.toISOString().slice(0, 10);
}

function archiveDates(days) {
  const out = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  for (let i = 0; i < days; i++) {
    out.push(ymdUtc(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

async function downloadFile(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return true;
  const res = await fetch(url, { timeout: 30000, ...getFetchOptions() });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    res.body.pipe(out);
    res.body.on('error', reject);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return true;
}

function parseCsv(csv) {
  return csv.trim().split(/\r?\n/)
    .filter(line => line && !line.startsWith('open_time'))
    .map(line => {
      const r = line.split(',');
      return { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] };
    })
    .filter(b => Number.isFinite(b.t) && Number.isFinite(b.c));
}

async function fetchArchiveCandles(symbol, interval, days) {
  const cacheDir = path.join(os.tmpdir(), 'ai-trader-binance-archive');
  fs.mkdirSync(cacheDir, { recursive: true });
  const bars = [];
  for (const date of archiveDates(days)) {
    const base = `${symbol}-${interval}m-${date}`;
    const zipPath = path.join(cacheDir, `${base}.zip`);
    const extractDir = path.join(cacheDir, base);
    const csvPath = path.join(extractDir, `${base}.csv`);
    const url = `https://data.binance.vision/data/futures/um/daily/klines/${symbol}/${interval}m/${base}.zip`;
    const ok = await downloadFile(url, zipPath);
    if (!ok) continue;
    if (!fs.existsSync(csvPath)) {
      fs.mkdirSync(extractDir, { recursive: true });
      execFileSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'ignore' });
    }
    if (fs.existsSync(csvPath)) bars.push(...parseCsv(fs.readFileSync(csvPath, 'utf8')));
  }
  const byTime = new Map();
  for (const b of bars) byTime.set(b.t, b);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function pivots(bars, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let hi = true, lo = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].h > bars[i].h) hi = false;
      if (bars[j].l < bars[i].l) lo = false;
    }
    if (hi) highs.push({ idx: i, t: bars[i].t, price: bars[i].h });
    if (lo) lows.push({ idx: i, t: bars[i].t, price: bars[i].l });
  }
  return { highs, lows };
}

function nearestEqualLevel(points, maxIdx, side) {
  const recent = points.filter(p => p.idx < maxIdx && p.idx >= maxIdx - EQ_LOOKBACK);
  let best = null;
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i], b = recent[j];
      const mid = (a.price + b.price) / 2;
      if (Math.abs(a.price - b.price) / mid > EQ_TOL_PCT) continue;
      if (!best || b.idx > best.lastIdx) {
        best = { side, price: mid, firstIdx: a.idx, lastIdx: b.idx, touches: 2 };
      }
    }
  }
  return best;
}

function closeTrade(bars, entryIndex, entry, dir, lev) {
  const tpMove = TP_ON_MARGIN / lev;
  const slMove = SL_ON_MARGIN / lev;
  const isLong = dir === 'LONG';
  const tp = isLong ? entry * (1 + tpMove) : entry * (1 - tpMove);
  const sl = isLong ? entry * (1 - slMove) : entry * (1 + slMove);
  const maxIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD_BARS);

  for (let i = entryIndex; i <= maxIndex; i++) {
    const b = bars[i];
    const hitTp = isLong ? b.h >= tp : b.l <= tp;
    const hitSl = isLong ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return { exit: sl, exitIndex: i, reason: 'SL_first_assumed' };
    if (hitTp) return { exit: tp, exitIndex: i, reason: 'TP' };
    if (hitSl) return { exit: sl, exitIndex: i, reason: 'SL' };
  }
  return { exit: bars[maxIndex].c, exitIndex: maxIndex, reason: 'TIMEOUT' };
}

function simulateSymbol(symbol, bars) {
  const lev = LEVERAGE_OVERRIDE;
  const { highs, lows } = pivots(bars, 2, 2);
  let equity = START_BALANCE;
  let lastExit = -1;
  const trades = [];

  for (let i = EQ_LOOKBACK; i < bars.length - 2; i++) {
    if (i <= lastExit) continue;
    const bar = bars[i];
    let signal = null;

    const eql = nearestEqualLevel(lows, i, 'EQL');
    if (eql && bar.l < eql.price * (1 - SWEEP_MIN_PCT) && bar.c > eql.price) {
      const mssHigh = Math.max(...bars.slice(Math.max(0, i - MSS_LOOKBACK), i).map(b => b.h));
      const next = bars[i + 1];
      if (next && next.c > mssHigh) signal = { dir: 'LONG', pattern: 'EQL sweep + bullish MSS', level: eql.price };
    }

    if (!signal) {
      const eqh = nearestEqualLevel(highs, i, 'EQH');
      if (eqh && bar.h > eqh.price * (1 + SWEEP_MIN_PCT) && bar.c < eqh.price) {
        const mssLow = Math.min(...bars.slice(Math.max(0, i - MSS_LOOKBACK), i).map(b => b.l));
        const next = bars[i + 1];
        if (next && next.c < mssLow) signal = { dir: 'SHORT', pattern: 'EQH sweep + bearish MSS', level: eqh.price };
      }
    }

    if (!signal) continue;
    const entryIndex = i + 2;
    if (!bars[entryIndex]) continue;
    const entry = bars[entryIndex].o;
    const closed = closeTrade(bars, entryIndex, entry, signal.dir, lev);
    const movePct = signal.dir === 'LONG' ? (closed.exit - entry) / entry : (entry - closed.exit) / entry;
    const margin = equity * CAPITAL_PCT;
    const notional = margin * lev;
    const pnl = notional * movePct - notional * FEE_RATE;
    equity += pnl;
    lastExit = closed.exitIndex;
    trades.push({ ...signal, reason: closed.reason, pnl });
    if (equity <= 0) break;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const side = dir => {
    const xs = trades.filter(t => t.dir === dir);
    const ws = xs.filter(t => t.pnl > 0);
    return { trades: xs.length, wr: xs.length ? ws.length / xs.length : 0, pnl: xs.reduce((s, t) => s + t.pnl, 0) };
  };

  return {
    symbol,
    trades: trades.length,
    wins: wins.length,
    wr: trades.length ? wins.length / trades.length : 0,
    final: equity,
    pnl: equity - START_BALANCE,
    long: side('LONG'),
    short: side('SHORT'),
    tp: trades.filter(t => t.reason === 'TP').length,
    sl: trades.filter(t => t.reason.startsWith('SL')).length,
    timeout: trades.filter(t => t.reason === 'TIMEOUT').length,
  };
}

async function main() {
  console.log(`EQL/EQH liquidity sweep backtest`);
  console.log(`Days=${DAYS} Start=${money(START_BALANCE)} Capital=${(CAPITAL_PCT * 100).toFixed(1)}% TP=${(TP_ON_MARGIN * 100).toFixed(1)}% SL=${(SL_ON_MARGIN * 100).toFixed(1)}% Lev=${LEVERAGE_OVERRIDE}x EQtol=${(EQ_TOL_PCT * 100).toFixed(2)}%`);
  console.log('');

  const results = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol}... `);
    const bars = await fetchArchiveCandles(symbol, 15, DAYS);
    const r = simulateSymbol(symbol, bars);
    results.push(r);
    console.log(`${r.trades} trades WR=${(r.wr * 100).toFixed(1)}% final=${money(r.final)} pnl=${money(r.pnl)}`);
  }

  console.log('\nSummary');
  for (const r of results.sort((a, b) => b.pnl - a.pnl)) {
    console.log(`${r.symbol.padEnd(10)} trades=${String(r.trades).padStart(4)} WR=${(r.wr * 100).toFixed(1).padStart(5)}% final=${money(r.final).padStart(10)} pnl=${money(r.pnl).padStart(10)} L/S=${r.long.trades}/${r.short.trades} TP/SL/TO=${r.tp}/${r.sl}/${r.timeout}`);
    console.log(`           LONG  trades=${String(r.long.trades).padStart(4)} WR=${(r.long.wr * 100).toFixed(1).padStart(5)}% pnl=${money(r.long.pnl).padStart(10)} | SHORT trades=${String(r.short.trades).padStart(4)} WR=${(r.short.wr * 100).toFixed(1).padStart(5)}% pnl=${money(r.short.pnl).padStart(10)}`);
  }

  const totalStart = results.length * START_BALANCE;
  const totalFinal = results.reduce((s, r) => s + r.final, 0);
  const totalTrades = results.reduce((s, r) => s + r.trades, 0);
  const totalWins = results.reduce((s, r) => s + r.wins, 0);
  console.log('\nPortfolio');
  console.log(`tokens=${results.length} start=${money(totalStart)} final=${money(totalFinal)} pnl=${money(totalFinal - totalStart)} trades=${totalTrades} WR=${totalTrades ? (totalWins / totalTrades * 100).toFixed(1) : '0.0'}%`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
