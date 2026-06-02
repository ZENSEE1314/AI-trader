'use strict';

// Comparative archive backtest for professional-style filters.
// Uses completed Binance USD-M futures daily archive candles.

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
const TP_ON_MARGIN = parseFloat(process.env.TP_ON_MARGIN || '0.35');
const SL_ON_MARGIN = parseFloat(process.env.SL_ON_MARGIN || '0.25');
const MAX_HOLD_BARS = parseInt(process.env.MAX_HOLD_BARS || '120', 10);
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,ADAUSDT,DOTUSDT,LINKUSDT,LTCUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const LEVERAGE = {
  BTCUSDT: 100, ETHUSDT: 100, BNBUSDT: 100,
  SOLUSDT: 75, ADAUSDT: 75, DOTUSDT: 75, LINKUSDT: 75, LTCUSDT: 75,
};

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
      return {
        t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5],
      };
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

function aggregateBars(bars, minutes) {
  const bucketMs = minutes * 60000;
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

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function atrPct(bars, period = 14) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const slice = bars.slice(Math.max(1, i - period + 1), i + 1);
    const atr = slice.reduce((sum, b, n) => {
      const prev = bars[i - slice.length + n].c;
      return sum + Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
    }, 0) / slice.length;
    out[i] = atr / bars[i].c;
  }
  return out;
}

function weeklyVwap(bars, upToTime) {
  const d = new Date(upToTime);
  const elapsed = ((d.getUTCDay() * 24 + d.getUTCHours()) * 60 + d.getUTCMinutes()) * 60000;
  const weekStart = upToTime - elapsed;
  const xs = bars.filter(b => b.t >= weekStart && b.t <= upToTime);
  let pv = 0, vv = 0, pv2 = 0;
  for (const b of xs) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    pv2 += tp * tp * b.v;
    vv += b.v;
  }
  if (!vv) return null;
  const vwap = pv / vv;
  const std = Math.sqrt(Math.max(0, pv2 / vv - vwap * vwap));
  return { vwap, upper: vwap + std, lower: vwap - std };
}

function isPivotHigh(bars, i, left, right) {
  for (let j = i - left; j <= i + right; j++) {
    if (j !== i && (!bars[j] || bars[j].h > bars[i].h)) return false;
  }
  return true;
}

function isPivotLow(bars, i, left, right) {
  for (let j = i - left; j <= i + right; j++) {
    if (j !== i && (!bars[j] || bars[j].l < bars[i].l)) return false;
  }
  return true;
}

function latestStructure(bars, upToTime, tfMinutes, left = 2, right = 2) {
  const confirmed = bars.filter(b => b.t + right * tfMinutes * 60000 <= upToTime);
  const highs = [], lows = [];
  let latest = null;
  for (let i = left; i < confirmed.length - right; i++) {
    if (isPivotHigh(confirmed, i, left, right)) {
      const prevHigh = highs.at(-1);
      highs.push({ price: confirmed[i].h, t: confirmed[i].t });
      const prevLow = lows.at(-2);
      const lastLow = lows.at(-1);
      if (prevHigh && confirmed[i].h < prevHigh.price && prevLow && lastLow && lastLow.price < prevLow.price) {
        latest = { dir: 'SHORT', t: confirmed[i].t };
      }
    }
    if (isPivotLow(confirmed, i, left, right)) {
      const prevLow = lows.at(-1);
      lows.push({ price: confirmed[i].l, t: confirmed[i].t });
      const prevHigh = highs.at(-2);
      const lastHigh = highs.at(-1);
      if (prevLow && confirmed[i].l > prevLow.price && prevHigh && lastHigh && lastHigh.price > prevHigh.price) {
        latest = { dir: 'LONG', t: confirmed[i].t };
      }
    }
  }
  return latest;
}

function closeTrade(bars, entryIndex, dir, entry, lev) {
  const tpMove = TP_ON_MARGIN / lev;
  const slMove = SL_ON_MARGIN / lev;
  const tp = dir === 'LONG' ? entry * (1 + tpMove) : entry * (1 - tpMove);
  const sl = dir === 'LONG' ? entry * (1 - slMove) : entry * (1 + slMove);
  const maxIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD_BARS);
  for (let i = entryIndex; i <= maxIndex; i++) {
    const b = bars[i];
    const hitTp = dir === 'LONG' ? b.h >= tp : b.l <= tp;
    const hitSl = dir === 'LONG' ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return { exit: sl, exitIndex: i, reason: 'SL_first_assumed' };
    if (hitTp) return { exit: tp, exitIndex: i, reason: 'TP' };
    if (hitSl) return { exit: sl, exitIndex: i, reason: 'SL' };
  }
  return { exit: bars[maxIndex].c, exitIndex: maxIndex, reason: 'TIMEOUT' };
}

function simulate(symbol, bars, rule) {
  const lev = LEVERAGE[symbol] || 75;
  const bars15 = aggregateBars(bars, 15);
  const bars60 = aggregateBars(bars, 60);
  const closes15 = bars15.map(b => b.c);
  const closes60 = bars60.map(b => b.c);
  const ema15 = ema(closes15, 50);
  const ema60 = ema(closes60, 50);
  const atr1m = atrPct(bars, 14);
  let equity = START_BALANCE;
  let lastExit = -1;
  const trades = [];
  const highs = [], lows = [];

  for (let i = 1; i < bars.length - 3; i++) {
    if (i + 3 <= lastExit) continue;
    let signal = null;

    if (isPivotHigh(bars, i, 1, 2)) {
      const prevHigh = highs.at(-1);
      highs.push({ price: bars[i].h, t: bars[i].t });
      const prevLow = lows.at(-2), lastLow = lows.at(-1);
      if (prevHigh && bars[i].h < prevHigh.price && prevLow && lastLow && lastLow.price < prevLow.price) signal = 'SHORT';
    }
    if (!signal && isPivotLow(bars, i, 1, 2)) {
      const prevLow = lows.at(-1);
      lows.push({ price: bars[i].l, t: bars[i].t });
      const prevHigh = highs.at(-2), lastHigh = highs.at(-1);
      if (prevLow && bars[i].l > prevLow.price && prevHigh && lastHigh && lastHigh.price > prevHigh.price) signal = 'LONG';
    }
    if (!signal) continue;

    const entryIndex = i + 3;
    const entryBar = bars[entryIndex];
    if (!entryBar) continue;
    if (rule.side !== 'BOTH' && signal !== rule.side) continue;

    if (rule.htf15AgeMin) {
      const st = latestStructure(bars15, entryBar.t, 15, 2, 2);
      if (!st || st.dir !== signal || entryBar.t - st.t > rule.htf15AgeMin * 60000) continue;
    }
    if (rule.ema15) {
      const idx = bars15.findIndex(b => b.t > entryBar.t) - 1;
      if (idx < 50) continue;
      if (signal === 'LONG' && !(bars15[idx].c > ema15[idx])) continue;
      if (signal === 'SHORT' && !(bars15[idx].c < ema15[idx])) continue;
    }
    if (rule.ema60) {
      const idx = bars60.findIndex(b => b.t > entryBar.t) - 1;
      if (idx < 50) continue;
      if (signal === 'LONG' && !(bars60[idx].c > ema60[idx])) continue;
      if (signal === 'SHORT' && !(bars60[idx].c < ema60[idx])) continue;
    }
    if (rule.vwap) {
      const vw = weeklyVwap(bars15, entryBar.t);
      if (!vw) continue;
      if (rule.vwap === 'trend') {
        if (signal === 'LONG' && !(entryBar.c > vw.vwap)) continue;
        if (signal === 'SHORT' && !(entryBar.c < vw.vwap)) continue;
      }
      if (rule.vwap === 'extreme_reversal') {
        if (signal === 'LONG' && !(entryBar.c < vw.lower)) continue;
        if (signal === 'SHORT' && !(entryBar.c > vw.upper)) continue;
      }
    }
    if (rule.minAtrPct && atr1m[entryIndex] < rule.minAtrPct) continue;
    if (rule.maxAtrPct && atr1m[entryIndex] > rule.maxAtrPct) continue;
    if (rule.symbols && !rule.symbols.includes(symbol)) continue;

    const entry = entryBar.o;
    const closed = closeTrade(bars, entryIndex, signal, entry, lev);
    const movePct = signal === 'LONG' ? (closed.exit - entry) / entry : (entry - closed.exit) / entry;
    const margin = equity * CAPITAL_PCT;
    const notional = margin * lev;
    const pnl = notional * movePct - notional * FEE_RATE;
    equity += pnl;
    lastExit = closed.exitIndex;
    trades.push({ dir: signal, pnl, reason: closed.reason });
    if (equity <= 0) break;
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  return {
    symbol,
    trades: trades.length,
    wins,
    wr: trades.length ? wins / trades.length : 0,
    final: equity,
    pnl: equity - START_BALANCE,
  };
}

const RULES = [
  { name: 'raw_1m_both', side: 'BOTH' },
  { name: '15m_fresh60_both', side: 'BOTH', htf15AgeMin: 60 },
  { name: '15m_fresh60_short', side: 'SHORT', htf15AgeMin: 60 },
  { name: '15m_fresh60_long', side: 'LONG', htf15AgeMin: 60 },
  { name: 'short_15m60_ema15', side: 'SHORT', htf15AgeMin: 60, ema15: true },
  { name: 'short_15m60_ema60', side: 'SHORT', htf15AgeMin: 60, ema60: true },
  { name: 'short_15m60_vwap_trend', side: 'SHORT', htf15AgeMin: 60, vwap: 'trend' },
  { name: 'short_15m60_vwap_reversal', side: 'SHORT', htf15AgeMin: 60, vwap: 'extreme_reversal' },
  { name: 'short_15m60_low_vol', side: 'SHORT', htf15AgeMin: 60, maxAtrPct: 0.0012 },
  { name: 'short_15m60_high_vol', side: 'SHORT', htf15AgeMin: 60, minAtrPct: 0.0012 },
  { name: 'short_15m60_link_ltc_dot', side: 'SHORT', htf15AgeMin: 60, symbols: ['LINKUSDT', 'LTCUSDT', 'DOTUSDT'] },
];

async function main() {
  console.log(`Compare professional strategy filters: ${DAYS}d, $${START_BALANCE} per token, margin ${(CAPITAL_PCT * 100).toFixed(1)}%, TP ${(TP_ON_MARGIN * 100).toFixed(0)}%, SL ${(SL_ON_MARGIN * 100).toFixed(0)}%`);
  const data = {};
  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol}... `);
    data[symbol] = await fetchArchiveCandles(symbol, 1, DAYS);
    console.log(`${data[symbol].length} bars`);
  }

  const ranked = [];
  for (const rule of RULES) {
    const testedSymbols = rule.symbols || SYMBOLS;
    const per = testedSymbols.map(symbol => simulate(symbol, data[symbol], rule));
    const totalTrades = per.reduce((s, r) => s + r.trades, 0);
    const totalWins = per.reduce((s, r) => s + r.wins, 0);
    const final = per.reduce((s, r) => s + r.final, 0);
    const start = testedSymbols.length * START_BALANCE;
    ranked.push({ rule, per, trades: totalTrades, wr: totalTrades ? totalWins / totalTrades : 0, start, final, pnl: final - start });
  }

  ranked.sort((a, b) => b.pnl - a.pnl);
  console.log('\nRanking');
  for (const r of ranked) {
    console.log(`${r.rule.name.padEnd(28)} trades=${String(r.trades).padStart(5)} WR=${(r.wr * 100).toFixed(1).padStart(5)}% final=${money(r.final).padStart(10)} pnl=${money(r.pnl).padStart(10)}`);
  }

  const best = ranked[0];
  console.log(`\nBest: ${best.rule.name}`);
  for (const r of best.per.filter(x => x.trades > 0 || !best.rule.symbols).sort((a, b) => b.pnl - a.pnl)) {
    console.log(`${r.symbol.padEnd(10)} trades=${String(r.trades).padStart(4)} WR=${(r.wr * 100).toFixed(1).padStart(5)}% final=${money(r.final).padStart(10)} pnl=${money(r.pnl).padStart(10)}`);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
