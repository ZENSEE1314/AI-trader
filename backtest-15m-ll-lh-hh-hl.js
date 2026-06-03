'use strict';

// 15m structure-only backtest:
//   LL -> LH = SHORT
//   HH -> HL = LONG
// Risk model:
//   START_BALANCE=1000, CAPITAL_PCT=0.10
//   TP_ON_MARGIN=0.50, SL_ON_MARGIN=0.30, TRAIL_ON_MARGIN=0.00

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
const TRAIL_ON_MARGIN = parseFloat(process.env.TRAIL_ON_MARGIN || '0.00');
const LEVERAGE_OVERRIDE = parseFloat(process.env.LEVERAGE_OVERRIDE || '0');
const MAX_HOLD_BARS = parseInt(process.env.MAX_HOLD_BARS || '32', 10); // 8h on 15m
const LEFT = parseInt(process.env.PIVOT_LEFT || '2', 10);
const RIGHT = parseInt(process.env.PIVOT_RIGHT || '2', 10);
const TREND_FILTER = (process.env.TREND_FILTER || 'none').toLowerCase();
const VWAP_BAND_FILTER = process.env.VWAP_BAND_FILTER !== '0';
const VWAP_LOOKBACK_BARS = parseInt(process.env.VWAP_LOOKBACK_BARS || '96', 10); // 24h of 15m bars
const INCLUDE_CHOCH = process.env.INCLUDE_CHOCH !== '0';
const SIDE_FILTER = (process.env.SIDE_FILTER || 'both').toUpperCase();

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,ADAUSDT,DOTUSDT,LINKUSDT,LTCUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const LEVERAGE = {
  BTCUSDT: 100,
  ETHUSDT: 100,
  BNBUSDT: 100,
  SOLUSDT: 75,
  ADAUSDT: 75,
  DOTUSDT: 75,
  LINKUSDT: 75,
  LTCUSDT: 75,
};

function money(n) {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

function avg(xs, pick = x => x) {
  return xs.length ? xs.reduce((sum, x) => sum + pick(x), 0) / xs.length : 0;
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

function parseCsv(csv) {
  return csv
    .trim()
    .split(/\r?\n/)
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

function isPivotHigh(bars, i) {
  for (let j = i - LEFT; j <= i + RIGHT; j++) {
    if (j !== i && (!bars[j] || bars[j].h > bars[i].h)) return false;
  }
  return true;
}

function isPivotLow(bars, i) {
  for (let j = i - LEFT; j <= i + RIGHT; j++) {
    if (j !== i && (!bars[j] || bars[j].l < bars[i].l)) return false;
  }
  return true;
}

function aggregateBars(bars, minutes) {
  const bucketMs = minutes * 60_000;
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

function alignedIndex(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (bars[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function trendAllows(signalDir, entryTime, trendCtx) {
  if (TREND_FILTER === 'none') return true;

  const passEma = (bars, emaVals, minIdx) => {
    const idx = alignedIndex(bars, entryTime);
    if (idx < minIdx) return false;
    return signalDir === 'LONG' ? bars[idx].c > emaVals[idx] : bars[idx].c < emaVals[idx];
  };

  if (TREND_FILTER === '1h_ema50') return passEma(trendCtx.h1, trendCtx.ema1h50, 50);
  if (TREND_FILTER === '4h_ema50') return passEma(trendCtx.h4, trendCtx.ema4h50, 50);
  if (TREND_FILTER === '1h_4h_ema50') {
    return passEma(trendCtx.h1, trendCtx.ema1h50, 50) && passEma(trendCtx.h4, trendCtx.ema4h50, 50);
  }
  if (TREND_FILTER === 'ai_trend') {
    const trend = aiTrendAt(entryTime, trendCtx);
    return signalDir === 'LONG' ? trend === 'BULLISH' : trend === 'BEARISH';
  }
  return true;
}

function localPivots(bars, maxIndex, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  const start = Math.max(left, maxIndex - 120);
  const end = Math.min(maxIndex - right, bars.length - right - 1);
  for (let i = start; i <= end; i++) {
    let ph = true;
    let pl = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i || !bars[j]) continue;
      if (bars[j].h > bars[i].h) ph = false;
      if (bars[j].l < bars[i].l) pl = false;
    }
    if (ph) highs.push(bars[i]);
    if (pl) lows.push(bars[i]);
  }
  return { highs, lows };
}

function structureVote(bars, idx) {
  if (idx < 20) return 0;
  const { highs, lows } = localPivots(bars, idx);
  const h1 = highs.at(-1);
  const h0 = highs.at(-2);
  const l1 = lows.at(-1);
  const l0 = lows.at(-2);
  if (!h1 || !h0 || !l1 || !l0) return 0;
  const hh = h1.h > h0.h;
  const hl = l1.l > l0.l;
  const lh = h1.h < h0.h;
  const ll = l1.l < l0.l;
  if (hh && hl) return 1;
  if (lh && ll) return -1;
  return 0;
}

function aiTrendAt(entryTime, trendCtx) {
  const idx1 = alignedIndex(trendCtx.h1, entryTime);
  const idx4 = alignedIndex(trendCtx.h4, entryTime);
  if (idx1 < 50 || idx4 < 50) return 'NEUTRAL';

  let score = 0;
  const h1 = trendCtx.h1[idx1];
  const h4 = trendCtx.h4[idx4];
  const e1 = trendCtx.ema1h50[idx1];
  const e4 = trendCtx.ema4h50[idx4];
  const prevE1 = trendCtx.ema1h50[Math.max(0, idx1 - 6)];
  const prevE4 = trendCtx.ema4h50[Math.max(0, idx4 - 3)];

  if (h4.c > e4 && e4 > prevE4) score += 2;
  if (h4.c < e4 && e4 < prevE4) score -= 2;
  if (h1.c > e1 && e1 > prevE1) score += 1;
  if (h1.c < e1 && e1 < prevE1) score -= 1;

  score += structureVote(trendCtx.h4, idx4) * 2;
  score += structureVote(trendCtx.h1, idx1);

  if (score >= 3) return 'BULLISH';
  if (score <= -3) return 'BEARISH';
  return 'NEUTRAL';
}

function rollingVwapBand(bars, index, lookback = VWAP_LOOKBACK_BARS) {
  const start = Math.max(0, index - lookback + 1);
  const xs = bars.slice(start, index + 1);
  if (xs.length < 10) return null;
  let pv = 0;
  let pv2 = 0;
  let vv = 0;
  for (const b of xs) {
    const vol = b.v || 1;
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * vol;
    pv2 += tp * tp * vol;
    vv += vol;
  }
  if (!vv) return null;
  const vwap = pv / vv;
  const std = Math.sqrt(Math.max(0, pv2 / vv - vwap * vwap));
  return { vwap, upper: vwap + std, lower: vwap - std };
}

function vwapAllows(signalDir, bars, entryIndex) {
  if (!VWAP_BAND_FILTER) return true;
  const band = rollingVwapBand(bars, entryIndex);
  if (!band) return true;
  const price = bars[entryIndex].c;
  if (signalDir === 'LONG' && price > band.upper) return false;
  if (signalDir === 'SHORT' && price < band.lower) return false;
  return true;
}

function closeTrade({ bars, entryIndex, entry, dir, lev }) {
  const tpMove = TP_ON_MARGIN / lev;
  const slMove = SL_ON_MARGIN / lev;
  const trailMove = TRAIL_ON_MARGIN / lev;
  const isLong = dir === 'LONG';
  const tp = isLong ? entry * (1 + tpMove) : entry * (1 - tpMove);
  let sl = isLong ? entry * (1 - slMove) : entry * (1 + slMove);
  let best = entry;
  const maxIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD_BARS);

  for (let i = entryIndex; i <= maxIndex; i++) {
    const b = bars[i];
    if (TRAIL_ON_MARGIN > 0) {
      best = isLong ? Math.max(best, b.h) : Math.min(best, b.l);
      const trailedSl = isLong ? best * (1 - trailMove) : best * (1 + trailMove);
      sl = isLong ? Math.max(sl, trailedSl) : Math.min(sl, trailedSl);
    }

    const hitTp = isLong ? b.h >= tp : b.l <= tp;
    const hitSl = isLong ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return { exit: sl, exitIndex: i, reason: 'SL_first_assumed' };
    if (hitTp) return { exit: tp, exitIndex: i, reason: 'TP' };
    if (hitSl) return { exit: sl, exitIndex: i, reason: 'SL' };
  }

  return { exit: bars[maxIndex].c, exitIndex: maxIndex, reason: 'TIMEOUT' };
}

function simulateSymbol(symbol, bars) {
  const lev = LEVERAGE_OVERRIDE || LEVERAGE[symbol] || 75;
  const h1 = aggregateBars(bars, 60);
  const h4 = aggregateBars(bars, 240);
  const trendCtx = {
    h1,
    h4,
    ema1h50: ema(h1.map(b => b.c), 50),
    ema4h50: ema(h4.map(b => b.c), 50),
  };
  let equity = START_BALANCE;
  let lastExitIndex = -1;
  const highs = [];
  const lows = [];
  const trades = [];

  for (let i = LEFT; i < bars.length - RIGHT - 1; i++) {
    const confirmIndex = i + RIGHT;
    if (confirmIndex <= lastExitIndex) continue;

    let signal = null;
    if (isPivotHigh(bars, i)) {
      const prevHigh = highs.at(-1);
      highs.push({ price: bars[i].h, t: bars[i].t });
      const prevLow = lows.at(-2);
      const lastLow = lows.at(-1);
      if (prevHigh && bars[i].h < prevHigh.price && prevLow && lastLow && lastLow.price < prevLow.price && lastLow.t < bars[i].t) {
        signal = { dir: 'SHORT', pattern: '15m LL->LH' };
      } else if (INCLUDE_CHOCH && prevHigh && bars[i].h < prevHigh.price && prevLow && lastLow && lastLow.price > prevLow.price && lastLow.t < bars[i].t) {
        signal = { dir: 'SHORT', pattern: '15m HL->LH' };
      }
    }

    if (!signal && isPivotLow(bars, i)) {
      const prevLow = lows.at(-1);
      lows.push({ price: bars[i].l, t: bars[i].t });
      const prevHigh = highs.at(-2);
      const lastHigh = highs.at(-1);
      if (prevLow && bars[i].l > prevLow.price && prevHigh && lastHigh && lastHigh.price > prevHigh.price && lastHigh.t < bars[i].t) {
        signal = { dir: 'LONG', pattern: '15m HH->HL' };
      } else if (INCLUDE_CHOCH && prevLow && bars[i].l > prevLow.price && prevHigh && lastHigh && lastHigh.price < prevHigh.price && lastHigh.t < bars[i].t) {
        signal = { dir: 'LONG', pattern: '15m LH->HL' };
      }
    }

    if (!signal) continue;
    if (SIDE_FILTER !== 'BOTH' && signal.dir !== SIDE_FILTER) continue;
    const entryIndex = confirmIndex + 1;
    if (!bars[entryIndex]) continue;
    if (!trendAllows(signal.dir, bars[entryIndex].t, trendCtx)) continue;
    if (!vwapAllows(signal.dir, bars, entryIndex)) continue;

    const entry = bars[entryIndex].o;
    const closed = closeTrade({ bars, entryIndex, entry, dir: signal.dir, lev });
    const movePct = signal.dir === 'LONG' ? (closed.exit - entry) / entry : (entry - closed.exit) / entry;
    const margin = equity * CAPITAL_PCT;
    const notional = margin * lev;
    const fee = notional * FEE_RATE;
    const pnl = notional * movePct - fee;
    equity += pnl;
    lastExitIndex = closed.exitIndex;
    trades.push({ ...signal, reason: closed.reason, pnl, equity });
    if (equity <= 0) break;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin = avg(wins, t => t.pnl);
  const avgLoss = Math.abs(avg(losses, t => t.pnl));
  const breakEvenWr = avgWin + avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0;
  const side = dir => {
    const xs = trades.filter(t => t.dir === dir);
    const ws = xs.filter(t => t.pnl > 0);
    const ls = xs.filter(t => t.pnl <= 0);
    const gw = ws.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(ls.reduce((s, t) => s + t.pnl, 0));
    return {
      trades: xs.length,
      wins: ws.length,
      wr: xs.length ? ws.length / xs.length : 0,
      pnl: xs.reduce((s, t) => s + t.pnl, 0),
      avgWin: avg(ws, t => t.pnl),
      avgLoss: Math.abs(avg(ls, t => t.pnl)),
      profitFactor: gl > 0 ? gw / gl : Infinity,
    };
  };

  return {
    symbol,
    bars: bars.length,
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
    avgWin,
    avgLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    breakEvenWr,
  };
}

async function main() {
  console.log(`15m LL->LH SHORT / HH->HL LONG backtest`);
  console.log(`Days=${DAYS} Start=${money(START_BALANCE)} Capital=${(CAPITAL_PCT * 100).toFixed(1)}% TP_margin=${(TP_ON_MARGIN * 100).toFixed(1)}% SL_margin=${(SL_ON_MARGIN * 100).toFixed(1)}% Trail_margin=${(TRAIL_ON_MARGIN * 100).toFixed(1)}% Fee=${(FEE_RATE * 100).toFixed(3)}% Pivot=${LEFT}L/${RIGHT}R MaxHold=${MAX_HOLD_BARS * 15}m Trend=${TREND_FILTER} VWAP_Band=${VWAP_BAND_FILTER ? 'on' : 'off'}`);
  console.log('');

  const results = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol}... `);
    const bars = await fetchArchiveCandles(symbol, 15, DAYS);
    const result = simulateSymbol(symbol, bars);
    results.push(result);
    console.log(`${result.trades} trades WR=${(result.wr * 100).toFixed(1)}% final=${money(result.final)} pnl=${money(result.pnl)}`);
  }

  console.log('\nSummary');
  console.log('-------');
  for (const r of results.sort((a, b) => b.pnl - a.pnl)) {
    console.log(`${r.symbol.padEnd(10)} trades=${String(r.trades).padStart(4)} WR=${(r.wr * 100).toFixed(1).padStart(5)}% final=${money(r.final).padStart(10)} pnl=${money(r.pnl).padStart(10)} L/S=${r.long.trades}/${r.short.trades} TP/SL/TO=${r.tp}/${r.sl}/${r.timeout}`);
    console.log(`           AvgW=${money(r.avgWin)} AvgL=${money(r.avgLoss)} PF=${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf'} BE_WR=${(r.breakEvenWr * 100).toFixed(1)}%`);
    console.log(`           LONG  trades=${String(r.long.trades).padStart(4)} WR=${(r.long.wr * 100).toFixed(1).padStart(5)}% pnl=${money(r.long.pnl).padStart(10)} AvgW=${money(r.long.avgWin)} AvgL=${money(r.long.avgLoss)} PF=${Number.isFinite(r.long.profitFactor) ? r.long.profitFactor.toFixed(2) : 'inf'} | SHORT trades=${String(r.short.trades).padStart(4)} WR=${(r.short.wr * 100).toFixed(1).padStart(5)}% pnl=${money(r.short.pnl).padStart(10)} AvgW=${money(r.short.avgWin)} AvgL=${money(r.short.avgLoss)} PF=${Number.isFinite(r.short.profitFactor) ? r.short.profitFactor.toFixed(2) : 'inf'}`);
  }

  const totalStart = results.length * START_BALANCE;
  const totalFinal = results.reduce((sum, r) => sum + r.final, 0);
  const totalTrades = results.reduce((sum, r) => sum + r.trades, 0);
  const totalWins = results.reduce((sum, r) => sum + r.wins, 0);
  const totalLosses = totalTrades - totalWins;
  const allWinDollars = results.reduce((sum, r) => sum + r.avgWin * r.wins, 0);
  const allLossDollars = results.reduce((sum, r) => sum + r.avgLoss * (r.trades - r.wins), 0);
  const allAvgWin = totalWins ? allWinDollars / totalWins : 0;
  const allAvgLoss = totalLosses ? allLossDollars / totalLosses : 0;
  const allBreakEvenWr = allAvgWin + allAvgLoss > 0 ? allAvgLoss / (allAvgWin + allAvgLoss) : 0;
  console.log('\nPortfolio');
  console.log('---------');
  console.log(`tokens=${results.length} start=${money(totalStart)} final=${money(totalFinal)} pnl=${money(totalFinal - totalStart)} trades=${totalTrades} WR=${totalTrades ? (totalWins / totalTrades * 100).toFixed(1) : '0.0'}% AvgW=${money(allAvgWin)} AvgL=${money(allAvgLoss)} PF=${allLossDollars > 0 ? (allWinDollars / allLossDollars).toFixed(2) : 'inf'} BE_WR=${(allBreakEvenWr * 100).toFixed(1)}%`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
