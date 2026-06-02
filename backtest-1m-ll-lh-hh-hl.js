// 1m structure-only backtest:
//   LL -> LH = SHORT
//   HH -> HL = LONG
//
// Defaults:
//   DAYS=30 START_BALANCE=1000 CAPITAL_PCT=0.10 FEE_RATE=0.0012
//   TP_ON_MARGIN=0.35, SL_ON_MARGIN=0.25.

'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { TRADING_CONFIG } = require('./smc-engine');
const { getFetchOptions } = require('./proxy-agent');

const DAYS = Math.max(1, parseInt(process.env.DAYS || '30', 10) || 30);
const START_BALANCE = parseFloat(process.env.START_BALANCE || '1000');
const CAPITAL_PCT = parseFloat(process.env.CAPITAL_PCT || '0.10');
const FEE_RATE = parseFloat(process.env.FEE_RATE || '0.0012');
const TP_PCT = parseFloat(process.env.TP_PCT || '0.0035');
const DEFAULT_SL_PCT = parseFloat(process.env.SL_PCT || '0.0025');
const TP_ON_MARGIN = parseFloat(process.env.TP_ON_MARGIN || '0.35');
const SL_ON_MARGIN = parseFloat(process.env.SL_ON_MARGIN || '0.25');
const LEFT = parseInt(process.env.PIVOT_LEFT || '1', 10);
const RIGHT = parseInt(process.env.PIVOT_RIGHT || '2', 10);
const MAX_HOLD_BARS = parseInt(process.env.MAX_HOLD_BARS || '120', 10);
const DATA_SOURCE = (process.env.DATA_SOURCE || 'archive').toLowerCase();
const HTF_GATE = (process.env.HTF_GATE || '15m_structure').toLowerCase();
const HTF_MAX_AGE_MIN = parseInt(process.env.HTF_MAX_AGE_MIN || '0', 10);
const SIDE_FILTER = (process.env.SIDE_FILTER || 'both').toUpperCase();

const LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 100,
  SOLUSDT: 75,
  ADAUSDT: 75,
  AVAXUSDT: 75,
  DOTUSDT: 75,
  LINKUSDT: 75,
  LTCUSDT: 75,
};

const SYMBOLS = (process.env.SYMBOLS || Object.keys(TRADING_CONFIG).join(','))
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

function intervalMs(interval) {
  return Number(interval) * 60 * 1000;
}

async function fetchBinanceFuturesCandles(symbol, interval, days) {
  const out = [];
  const step = intervalMs(interval);
  const endAll = Date.now();
  const startAll = endAll - days * 86400000;
  let cursor = startAll;

  while (cursor < endAll) {
    const end = Math.min(endAll, cursor + step * 1500);
    const url = new URL('https://fapi.binance.com/fapi/v1/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', `${interval}m`);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(end));
    url.searchParams.set('limit', '1500');

    const res = await fetch(url, { timeout: 15000, ...getFetchOptions() });
    if (!res.ok) throw new Error(`${symbol} ${interval} kline HTTP ${res.status}`);
    const rows = await res.json();
    const bars = (Array.isArray(rows) ? rows : []).map(r => ({
      t: parseInt(r[0], 10),
      o: parseFloat(r[1]),
      h: parseFloat(r[2]),
      l: parseFloat(r[3]),
      c: parseFloat(r[4]),
      v: parseFloat(r[5]),
    }));
    out.push(...bars);
    if (!bars.length) break;
    cursor = bars[bars.length - 1].t + step;
    await new Promise(resolve => setTimeout(resolve, 80));
  }

  const byTime = new Map();
  for (const b of out) byTime.set(b.t, b);
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

function ymdUtc(date) {
  return date.toISOString().slice(0, 10);
}

function archiveDates(days) {
  const dates = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  for (let i = 0; i < days; i++) {
    dates.push(ymdUtc(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.reverse();
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

function parseArchiveCsv(csv) {
  return csv
    .trim()
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith('open_time'))
    .map(line => {
      const r = line.split(',');
      return {
        t: parseInt(r[0], 10),
        o: parseFloat(r[1]),
        h: parseFloat(r[2]),
        l: parseFloat(r[3]),
        c: parseFloat(r[4]),
        v: parseFloat(r[5]),
      };
    })
    .filter(b => Number.isFinite(b.t) && Number.isFinite(b.o) && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c));
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
    if (!fs.existsSync(csvPath)) continue;
    bars.push(...parseArchiveCsv(fs.readFileSync(csvPath, 'utf8')));
  }

  const byTime = new Map();
  for (const b of bars) byTime.set(b.t, b);
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

function isPivotHigh(bars, i) {
  const c = bars[i];
  for (let j = i - LEFT; j <= i + RIGHT; j++) {
    if (j === i) continue;
    if (!bars[j] || bars[j].h > c.h) return false;
  }
  return true;
}

function isPivotLow(bars, i) {
  const c = bars[i];
  for (let j = i - LEFT; j <= i + RIGHT; j++) {
    if (j === i) continue;
    if (!bars[j] || bars[j].l < c.l) return false;
  }
  return true;
}

function aggregateBars(bars, minutes) {
  const bucketMs = minutes * 60 * 1000;
  const out = [];
  let cur = null;

  for (const b of bars) {
    const t = Math.floor(b.t / bucketMs) * bucketMs;
    if (!cur || cur.t !== t) {
      if (cur) out.push(cur);
      cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }

  if (cur) out.push(cur);
  return out;
}

function detectLatestStructure(bars, upToTime, left = 2, right = 2) {
  const confirmed = bars.filter(b => b.t + right * 15 * 60000 <= upToTime);
  if (confirmed.length < left + right + 6) return null;

  const highs = [];
  const lows = [];
  const pivotHigh = (i) => {
    const c = confirmed[i];
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (!confirmed[j] || confirmed[j].h > c.h) return false;
    }
    return true;
  };
  const pivotLow = (i) => {
    const c = confirmed[i];
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (!confirmed[j] || confirmed[j].l < c.l) return false;
    }
    return true;
  };

  let latest = null;
  for (let i = left; i < confirmed.length - right; i++) {
    if (pivotHigh(i)) {
      const prevHigh = highs[highs.length - 1];
      highs.push({ idx: i, price: confirmed[i].h, t: confirmed[i].t });
      const prevLow = lows[lows.length - 2];
      const lastLow = lows[lows.length - 1];
      if (prevHigh && confirmed[i].h < prevHigh.price && prevLow && lastLow && lastLow.price < prevLow.price && lastLow.t < confirmed[i].t) {
        latest = { dir: 'SHORT', pattern: '15m LL->LH', t: confirmed[i].t };
      }
    }

    if (pivotLow(i)) {
      const prevLow = lows[lows.length - 1];
      lows.push({ idx: i, price: confirmed[i].l, t: confirmed[i].t });
      const prevHigh = highs[highs.length - 2];
      const lastHigh = highs[highs.length - 1];
      if (prevLow && confirmed[i].l > prevLow.price && prevHigh && lastHigh && lastHigh.price > prevHigh.price && lastHigh.t < confirmed[i].t) {
        latest = { dir: 'LONG', pattern: '15m HH->HL', t: confirmed[i].t };
      }
    }
  }

  return latest;
}

function closeTrade({ bars, entryIndex, entry, dir, sl, tp }) {
  const isLong = dir === 'LONG';
  const maxIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD_BARS);

  for (let i = entryIndex; i <= maxIndex; i++) {
    const b = bars[i];
    const hitSl = isLong ? b.l <= sl : b.h >= sl;
    const hitTp = isLong ? b.h >= tp : b.l <= tp;

    if (hitSl && hitTp) {
      return { exit: sl, exitIndex: i, reason: 'SL_first_assumed' };
    }
    if (hitSl) return { exit: sl, exitIndex: i, reason: 'SL' };
    if (hitTp) return { exit: tp, exitIndex: i, reason: 'TP' };
  }

  return { exit: bars[maxIndex].c, exitIndex: maxIndex, reason: 'TIMEOUT' };
}

function simulateSymbol(symbol, bars) {
  const cfg = TRADING_CONFIG[symbol] || {};
  const slPct = DEFAULT_SL_PCT || cfg.slPct || 0.0025;
  const lev = parseFloat(process.env.LEVERAGE || LEVERAGE[symbol] || 75);
  let equity = START_BALANCE;
  const trades = [];
  let lastExitIndex = -1;
  const bars15m = aggregateBars(bars, 15);

  const highs = [];
  const lows = [];

  for (let i = LEFT; i < bars.length - RIGHT - 1; i++) {
    const confirmIndex = i + RIGHT;
    if (confirmIndex <= lastExitIndex) continue;

    let signal = null;

    if (isPivotHigh(bars, i)) {
      const prevHigh = highs[highs.length - 1];
      highs.push({ idx: i, price: bars[i].h, t: bars[i].t });

      const prevLow = lows[lows.length - 2];
      const lastLow = lows[lows.length - 1];
      const isLH = prevHigh && bars[i].h < prevHigh.price;
      const isLL = prevLow && lastLow && lastLow.price < prevLow.price && lastLow.t < bars[i].t;
      if (isLH && isLL) signal = { dir: 'SHORT', pattern: 'LL->LH' };
    }

    if (!signal && isPivotLow(bars, i)) {
      const prevLow = lows[lows.length - 1];
      lows.push({ idx: i, price: bars[i].l, t: bars[i].t });

      const prevHigh = highs[highs.length - 2];
      const lastHigh = highs[highs.length - 1];
      const isHL = prevLow && bars[i].l > prevLow.price;
      const isHH = prevHigh && lastHigh && lastHigh.price > prevHigh.price && lastHigh.t < bars[i].t;
      if (isHL && isHH) signal = { dir: 'LONG', pattern: 'HH->HL' };
    }

    if (!signal) continue;
    if (SIDE_FILTER !== 'BOTH' && signal.dir !== SIDE_FILTER) continue;
    const entryIndex = confirmIndex + 1;
    if (!bars[entryIndex]) continue;

    if (HTF_GATE === '15m_structure') {
      const htf = detectLatestStructure(bars15m, bars[entryIndex].t);
      if (!htf || htf.dir !== signal.dir) continue;
      if (HTF_MAX_AGE_MIN > 0 && bars[entryIndex].t - htf.t > HTF_MAX_AGE_MIN * 60000) continue;
    }

    const entry = bars[entryIndex].o;
    const isLong = signal.dir === 'LONG';
    const priceSlPct = Number.isFinite(SL_ON_MARGIN) && SL_ON_MARGIN > 0 ? SL_ON_MARGIN / lev : slPct;
    const priceTpPct = Number.isFinite(TP_ON_MARGIN) && TP_ON_MARGIN > 0 ? TP_ON_MARGIN / lev : TP_PCT;
    const sl = isLong ? entry * (1 - priceSlPct) : entry * (1 + priceSlPct);
    const tp = isLong ? entry * (1 + priceTpPct) : entry * (1 - priceTpPct);
    const closed = closeTrade({ bars, entryIndex, entry, dir: signal.dir, sl, tp });
    const movePct = isLong ? (closed.exit - entry) / entry : (entry - closed.exit) / entry;

    const margin = equity * CAPITAL_PCT;
    const notional = margin * lev;
    const fee = notional * FEE_RATE;
    const pnl = notional * movePct - fee;
    equity += pnl;
    lastExitIndex = closed.exitIndex;

    trades.push({
      symbol,
      dir: signal.dir,
      pattern: signal.pattern,
      entry,
      exit: closed.exit,
      reason: closed.reason,
      movePct,
      pnl,
      equity,
    });

    if (equity <= 0) break;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const sideStats = (dir) => {
    const side = trades.filter(t => t.dir === dir);
    const sideWins = side.filter(t => t.pnl > 0);
    const pnl = side.reduce((sum, t) => sum + t.pnl, 0);
    return {
      trades: side.length,
      wins: sideWins.length,
      winRate: side.length ? sideWins.length / side.length : 0,
      pnl,
    };
  };
  return {
    symbol,
    bars: bars.length,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    start: START_BALANCE,
    final: equity,
    pnl: equity - START_BALANCE,
    maxWin: trades.length ? Math.max(...trades.map(t => t.pnl)) : 0,
    maxLoss: trades.length ? Math.min(...trades.map(t => t.pnl)) : 0,
    longTrades: trades.filter(t => t.dir === 'LONG').length,
    shortTrades: trades.filter(t => t.dir === 'SHORT').length,
    long: sideStats('LONG'),
    short: sideStats('SHORT'),
    tp: trades.filter(t => t.reason === 'TP').length,
    sl: trades.filter(t => t.reason.startsWith('SL')).length,
    timeout: trades.filter(t => t.reason === 'TIMEOUT').length,
  };
}

function money(n) {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

async function main() {
  console.log(`1m LL->LH SHORT / HH->HL LONG backtest`);
  console.log(`Days=${DAYS} Start=${money(START_BALANCE)} Capital=${(CAPITAL_PCT * 100).toFixed(1)}% TP_margin=${(TP_ON_MARGIN * 100).toFixed(1)}% SL_margin=${(SL_ON_MARGIN * 100).toFixed(1)}% Fee=${(FEE_RATE * 100).toFixed(3)}% Pivot=${LEFT}L/${RIGHT}R MaxHold=${MAX_HOLD_BARS}m`);
  console.log('');

  const results = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol}... `);
    const bars = DATA_SOURCE === 'api'
      ? await fetchBinanceFuturesCandles(symbol, '1', DAYS)
      : await fetchArchiveCandles(symbol, '1', DAYS);
    const result = simulateSymbol(symbol, bars);
    results.push(result);
    console.log(`${result.trades} trades WR=${(result.winRate * 100).toFixed(1)}% final=${money(result.final)} pnl=${money(result.pnl)}`);
  }

  console.log('\nSummary');
  console.log('-------');
  for (const r of results.sort((a, b) => b.pnl - a.pnl)) {
    console.log(`${r.symbol.padEnd(10)} trades=${String(r.trades).padStart(4)} WR=${(r.winRate * 100).toFixed(1).padStart(5)}% final=${money(r.final).padStart(10)} pnl=${money(r.pnl).padStart(10)} L/S=${r.longTrades}/${r.shortTrades} TP/SL/TO=${r.tp}/${r.sl}/${r.timeout} maxWin=${money(r.maxWin)} maxLoss=${money(r.maxLoss)}`);
    console.log(`           LONG  trades=${String(r.long.trades).padStart(4)} WR=${(r.long.winRate * 100).toFixed(1).padStart(5)}% pnl=${money(r.long.pnl).padStart(10)} | SHORT trades=${String(r.short.trades).padStart(4)} WR=${(r.short.winRate * 100).toFixed(1).padStart(5)}% pnl=${money(r.short.pnl).padStart(10)}`);
  }

  const totalStart = results.length * START_BALANCE;
  const totalFinal = results.reduce((sum, r) => sum + r.final, 0);
  const totalTrades = results.reduce((sum, r) => sum + r.trades, 0);
  const totalWins = results.reduce((sum, r) => sum + r.wins, 0);
  console.log('\nPortfolio');
  console.log('---------');
  console.log(`tokens=${results.length} start=${money(totalStart)} final=${money(totalFinal)} pnl=${money(totalFinal - totalStart)} trades=${totalTrades} WR=${totalTrades ? (totalWins / totalTrades * 100).toFixed(1) : '0.0'}%`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
