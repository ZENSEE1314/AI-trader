'use strict';
/**
 * Backtest for the 15m→1m market-structure strategy.
 * Sweeps leverage × stop-loss × take-profit and reports, per coin:
 *   win rate, profit factor, total return, max drawdown, # liquidations.
 *
 * RUN (works from anywhere Bybit is reachable — incl. Indonesia):
 *     node backtest-structure.js
 *     set LOOKBACK_DAYS=14 && node backtest-structure.js   # Windows, more history
 *     LOOKBACK_DAYS=14 node backtest-structure.js          # Mac/Linux
 *
 * NOTE: results come from PAST data only. A good backtest WR does NOT
 * guarantee future profit. High leverage does not raise win rate — it only
 * multiplies gains, losses, and liquidation risk. This is not financial advice.
 */

const { buildSmcBiasWindows, biasArrayFromWindows } = require('./strategy-structure-htf-ltf');
const { computeProbability } = require('./probability-engine.js');

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT').split(',');
// Lookback days: accept as 1st CLI arg (e.g. `node backtest-structure.js 30`) or env, default 7.
const LOOKBACK_DAYS = Number(process.argv[2] || process.env.LOOKBACK_DAYS || 7);
// Mode: 2nd CLI arg. 'prob' = probability-vs-winrate analysis; otherwise the leverage grid.
const MODE = (process.argv[3] || process.env.MODE || 'grid').toLowerCase();
const CONF_WIN = Number(process.env.CONF_WIN || 8); // must match the Pine "Confluence memory (bars)"
// Entry trigger: 'pullback' = enter the candle after a 1m swing low(long)/high(short) [your rule];
//                'twocandle' = two consecutive same-direction candles.
const ENTRY_MODE = (process.env.ENTRY_MODE || 'pullback').toLowerCase();
const OOS_SEGMENTS = Math.max(2, Number(process.env.OOS_SEGMENTS || 2)); // independent periods for MODE=oos
// VWAP location filter (your rule): only take a 15m signal if its pivot reached the OUTER
// (±2 SD) VWAP band — long needs the HL pivot at/below VWAP−2SD, short needs LH at/above +2SD.
// '1' (default) = on, '0' = off (so you can compare with/without).
const VWAP_FILTER = (process.env.VWAP_FILTER || '1') !== '0';
const FEE_PER_SIDE = Number(process.env.FEE_PER_SIDE || 0.0005); // 0.05% incl. slippage estimate

// ── Risk model ──────────────────────────────────────────────────────────────
// 'margin' (default): SL/TP are a % of the MARGIN you put on each trade.
//    e.g. $100 margin, SL 35% = lose $35, TP 70% = gain $70  (2:1 reward:risk).
//    The price move needed = (margin% / leverage), so leverage is swept.
// 'price': old mode — SL/TP are raw price moves, swept directly.
const RISK_MODE   = process.env.RISK_MODE || 'margin';
const MARGIN_FRAC = Number(process.env.MARGIN_FRAC || 0.10);  // 10% of fund per trade ($100 on $1000)
const SL_MARGIN   = Number(process.env.SL_MARGIN   || 0.35);  // stop at -35% of margin ($35)
const TP_MARGINS  = (process.env.TP_MARGINS ? process.env.TP_MARGINS.split(',').map(Number) : [0.35, 0.50, 0.70]); // TP $35/$50/$70

// Parameter grids for the sweep
const LEVERAGES = (process.env.LEVERAGES ? process.env.LEVERAGES.split(',').map(Number) : [20, 50, 75, 100, 150]);
const SL_PCTS   = [0.003, 0.005, 0.008, 0.012];   // 0.3% – 1.2% price move (price mode only)
const TP_PCTS   = [0.005, 0.010, 0.015, 0.025];   // 0.5% – 2.5% price move (price mode only)

// Timeframe combos: bias from a higher TF, entry confirmation on a slower-than-1m TF.
// Default tests the two we discussed. Override with BIAS_TF + ENTRY_TF for a single custom run.
const TF_COMBOS = (process.env.BIAS_TF && process.env.ENTRY_TF)
  ? [{ bias: process.env.BIAS_TF, entry: process.env.ENTRY_TF }]
  : [{ bias: '15m', entry: '1m' }, { bias: '15m', entry: '5m' }];

// ── Data fetch (Bybit v5 linear klines — reachable where Binance is geo-blocked)
const BYBIT_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' };
const TF_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBybitPage(url, attempt = 0) {
  try {
    const res = await fetch(url);
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const data = await res.json();
    if (data.retCode === 10006 || data.retCode === 10018) throw new Error('rate-limit'); // too many visits
    if (data.retCode !== 0) throw new Error(`Bybit retCode ${data.retCode}: ${data.retMsg}`);
    const raw = data?.result?.list || [];
    return raw.reverse().map(r => ({
      time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    }));
  } catch (e) {
    // Retry rate-limits / transient errors with exponential backoff (up to 5 tries)
    if (attempt < 5 && /rate-limit|HTTP 429|HTTP 5|fetch failed|ECONN/.test(e.message)) {
      await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s, 8s, 16s
      return fetchBybitPage(url, attempt + 1);
    }
    throw e;
  }
}

async function fetchKlines(symbol, interval, days) {
  const iv = BYBIT_INTERVAL[interval];
  const msPerCandle = TF_MS[interval];
  const total = Math.ceil((days * 24 * 60 * 60_000) / msPerCandle);
  const base = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}`;

  // First page = most recent 1000 candles
  let all = await fetchBybitPage(`${base}&limit=1000`);
  const pages = Math.ceil(total / 1000);
  for (let p = 1; p < pages && all.length < total; p++) {
    if (!all.length) break;
    const oldestTs = all[0].time;
    await sleep(350); // gentler paging to stay under Bybit's rate limit
    const page = await fetchBybitPage(`${base}&limit=1000&end=${oldestTs - 1}`);
    if (!page.length) break;
    all = [...page, ...all];
  }
  return all.slice(-total);
}

// ── Single backtest run for one parameter combo ────────────────────────────
// Entry rule — mirrors SMC-Pro-Suite.pine:
//   15m single HL pivot => long bias (active ~1h); single LH pivot => short bias.
//   1m trigger: TWO consecutive same-direction candles (both close>open = long,
//   both close<open = short) while the 15m bias window is active.
//   One trade per bias window (the indicator's "one trade per trend leg").
// `biasArr[i]` = 'long' | 'short' | null for each 1m candle (precomputed once).
function runOne(c1, biasArr, { lev, slPct, tpPct, probFn }) {
  const liqPct = 1 / lev;                       // approx isolated-margin liquidation distance
  const roundTripFee = 2 * FEE_PER_SIDE * lev;  // as fraction of margin

  let pos = null; // { side, entry, sl, tp, liq }
  const trades = [];
  let equity = 1.0;            // fixed-fraction equity curve (10% margin/trade)
  // MARGIN_FRAC is the module-level config (default 10% of fund per trade)
  let peak = 1.0, maxDD = 0;
  let armed = false;           // true once a fresh bias window opens; reset after one trade

  for (let i = 1; i < c1.length; i++) {
    const c = c1[i], prev = c1[i - 1];

    // re-arm whenever a new bias window begins (bias goes null/other -> this one)
    if (biasArr[i] && biasArr[i] !== biasArr[i - 1]) armed = true;

    // ----- manage an open position -----
    if (pos) {
      let exit = null;
      if (pos.side === 'long') {
        if (c.low <= pos.liq) exit = 'LIQ';
        else if (c.low <= pos.sl) exit = 'SL';
        else if (c.high >= pos.tp) exit = 'TP';
      } else {
        if (c.high >= pos.liq) exit = 'LIQ';
        else if (c.high >= pos.sl) exit = 'SL';
        else if (c.low <= pos.tp) exit = 'TP';
      }
      if (exit) {
        let rOM; // return on margin
        if (exit === 'LIQ') rOM = -1.0;
        else if (exit === 'TP') rOM = tpPct * lev - roundTripFee;
        else rOM = -slPct * lev - roundTripFee;
        trades.push({ exit, rOM, prob: pos.prob });
        equity += equity * MARGIN_FRAC * rOM;
        if (equity > peak) peak = equity;
        const dd = (peak - equity) / peak;
        if (dd > maxDD) maxDD = dd;
        pos = null;
        if (equity <= 0) { equity = 0; break; }
      }
      continue; // one position at a time
    }

    // ----- look for an entry in an active bias window -----
    const bias = biasArr[i];
    if (!bias || !armed || i < 2) continue;
    const c2 = c1[i - 2];

    // ENTRY_MODE 'pullback' (your rule): a 1m swing low (low[i-1] below both neighbours)
    //   → long; a 1m swing high → short; enter on THIS candle (the one after the swing).
    // ENTRY_MODE 'twocandle': two consecutive same-direction candles.
    let goLong = false, goShort = false;
    if (ENTRY_MODE === 'pullback') {
      goLong  = prev.low  < c2.low  && prev.low  < c.low;   // prev candle is a swing low
      goShort = prev.high > c2.high && prev.high > c.high;  // prev candle is a swing high
    } else {
      goLong  = c.close > c.open && prev.close > prev.open;
      goShort = c.close < c.open && prev.close < prev.open;
    }

    if (bias === 'long' && goLong) {
      const entry = c.close;
      pos = { side: 'long', entry, sl: entry * (1 - slPct), tp: entry * (1 + tpPct), liq: entry * (1 - liqPct), prob: probFn ? probFn(c.time, 'long') : null };
      armed = false; // one trade per window
    } else if (bias === 'short' && goShort) {
      const entry = c.close;
      pos = { side: 'short', entry, sl: entry * (1 + slPct), tp: entry * (1 - tpPct), liq: entry * (1 + liqPct), prob: probFn ? probFn(c.time, 'short') : null };
      armed = false;
    }
  }

  // ----- metrics -----
  const n = trades.length;
  const wins = trades.filter(t => t.exit === 'TP').length;
  const liqs = trades.filter(t => t.exit === 'LIQ').length;
  const grossWin = trades.filter(t => t.rOM > 0).reduce((s, t) => s + t.rOM, 0);
  const grossLoss = -trades.filter(t => t.rOM < 0).reduce((s, t) => s + t.rOM, 0);
  const totalRet = trades.reduce((s, t) => s + t.rOM, 0); // additive, fixed 1-unit margin
  return {
    lev, slPct, tpPct,
    trades: n,
    winRate: n ? (wins / n) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    totalReturnPct: totalRet * 100,
    equityX: equity,        // final equity multiple (10% margin/trade, compounded)
    maxDDPct: maxDD * 100,
    liquidations: liqs,
    tradeList: trades,
  };
}

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : '∞'; }

// ── Probability-vs-winrate analysis ──────────────────────────────────────────
// Fixed exit (50x, SL $35 / TP $50 — price moves 0.7% / 1.0%) so win rate reflects
// the entry quality. Tags every trade with the engine's probability, then buckets.
function probReport(label, cEntry, biasArr, eng) {
  const lev = 50, slPct = SL_MARGIN / lev, tpPct = 0.50 / lev;
  const res = runOne(cEntry, biasArr, { lev, slPct, tpPct, probFn: eng.probAt });
  const t = res.tradeList;
  console.log(`  ── ${label} | ${t.length} trades | exit 50x SL$35/TP$50 ──`);
  if (!t.length) { console.log('     no trades.\n'); return; }
  const stat = (arr) => {
    const w = arr.filter(x => x.exit === 'TP').length;
    const gw = arr.filter(x => x.rOM > 0).reduce((s, x) => s + x.rOM, 0);
    const gl = -arr.filter(x => x.rOM < 0).reduce((s, x) => s + x.rOM, 0);
    return { wr: w / arr.length * 100, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), ret: arr.reduce((s, x) => s + x.rOM, 0) * 100 };
  };
  console.log('     prob band   trades  WR%    PF');
  for (const [lo, hi] of [[0, 39], [40, 49], [50, 59], [60, 69], [70, 100]]) {
    const tt = t.filter(x => x.prob >= lo && x.prob <= hi);
    if (!tt.length) { console.log(`     ${String(lo).padStart(2)}-${String(hi).padStart(3)}%      0     -     -`); continue; }
    const s = stat(tt);
    console.log(`     ${String(lo).padStart(2)}-${String(hi).padStart(3)}%   ${String(tt.length).padStart(4)}   ${fmt(s.wr).padStart(4)}  ${fmt(s.pf, 2)}`);
  }
  console.log('     ── gate: keep only trades with prob >= X ──');
  console.log('     thresh  trades  WR%    PF     totRet%');
  let best = null;
  for (const X of [30, 40, 50, 60, 70]) {
    const tt = t.filter(x => x.prob >= X);
    if (!tt.length) { console.log(`     >=${X}%      0     -      -       -`); continue; }
    const s = stat(tt);
    console.log(`     >=${X}%   ${String(tt.length).padStart(4)}   ${fmt(s.wr).padStart(4)}  ${fmt(s.pf, 2).padStart(5)}  ${fmt(s.ret).padStart(7)}`);
    if (tt.length >= 10 && (!best || s.wr > best.wr)) best = { X, ...s, n: tt.length };
  }
  if (best) console.log(`     → best WR (>=10 trades): prob >= ${best.X}%  →  WR ${fmt(best.wr)}%  PF ${fmt(best.pf, 2)}  (${best.n} trades)`);
  else console.log('     → too few trades at any threshold to call.');
  console.log('');
}

// ── Out-of-sample: split the window into independent periods, re-run low-lev grid ──
// A setting that is profitable in EVERY period is far more trustworthy than one
// that only worked over the whole (single-regime) window.
function oosReport(label, cEntry, biasArr, segs) {
  const n = cEntry.length;
  const bounds = [];
  for (let s = 0; s < segs; s++) bounds.push([Math.floor(s * n / segs), Math.floor((s + 1) * n / segs)]);
  console.log(`  ── ${label} | out-of-sample: ${segs} independent periods (${ENTRY_MODE}) ──`);
  let head = '     lev  TP$ ';
  for (let s = 0; s < segs; s++) head += `| P${s + 1} trd  WR%   PF  `;
  console.log(head + '| verdict');
  for (const lev of [20, 50]) {            // the leverages where the edge lived
    for (const tpM of TP_MARGINS) {
      let row = `     ${String(lev).padStart(3)}  $${String((tpM * 100).toFixed(0)).padStart(2)} `;
      let greens = 0, scored = 0;
      for (const [a, b] of bounds) {
        const r = runOne(cEntry.slice(a, b), biasArr.slice(a, b), { lev, slPct: SL_MARGIN / lev, tpPct: tpM / lev });
        row += `| ${String(r.trades).padStart(3)} ${fmt(r.winRate).padStart(5)} ${fmt(r.profitFactor, 2).padStart(5)} `;
        if (r.trades >= 8) { scored++; if (r.profitFactor > 1 && r.totalReturnPct > 0) greens++; }
      }
      const verdict = scored < segs ? '— thin' : greens === segs ? '✅ holds in all' : greens > 0 ? '⚠ mixed' : '❌ fails';
      console.log(row + '| ' + verdict);
    }
  }
  console.log('');
}

// ── Session VWAP + ±2 SD bands, anchored daily at UTC midnight (mirrors the Pine exactly) ──
// typical price = hlc3; SD from the volume-weighted variance; outer band = ±2 SD.
function computeVwapBands(c) {
  const v2u = new Array(c.length).fill(null);
  const v2d = new Array(c.length).fill(null);
  let day = null, tpv = 0, vol = 0, tpv2 = 0;
  for (let i = 0; i < c.length; i++) {
    const d = Math.floor(c[i].time / 86400000);      // UTC day index
    if (d !== day) { day = d; tpv = 0; vol = 0; tpv2 = 0; }
    const tp = (c[i].high + c[i].low + c[i].close) / 3;
    const v = c[i].volume || 0;
    tpv += tp * v; vol += v; tpv2 += tp * tp * v;
    if (vol > 0) {
      const vw = tpv / vol;
      const variance = tpv2 / vol - vw * vw;
      const sd = variance > 0 ? Math.sqrt(variance) : 0;
      v2u[i] = vw + 2 * sd;
      v2d[i] = vw - 2 * sd;
    }
  }
  return { v2u, v2d };
}

// Keep only windows whose 15m pivot reached the outer ±2 SD band.
function applyVwapFilter(windows, bands) {
  return windows.filter(w => {
    const lo = bands.v2d[w.pivotIdx], hi = bands.v2u[w.pivotIdx];
    if (lo == null || hi == null) return false;
    return w.bias === 'long' ? w.pivotPrice <= lo : w.pivotPrice >= hi;
  });
}

async function main() {
  console.log('\n=== HTF/LTF Structure Strategy — Backtest ===');
  console.log(`build: 2026-06-14e  (mode=${MODE}, entry=${ENTRY_MODE}, confWin=${CONF_WIN}, vwapFilter=${VWAP_FILTER ? 'ON ±2SD' : 'off'})`);
  console.log(`Lookback: ${LOOKBACK_DAYS}d | Fee/side(+slip): ${(FEE_PER_SIDE*100).toFixed(3)}% | Symbols: ${SYMBOLS.join(', ')}`);
  if (RISK_MODE === 'margin') {
    console.log(`Risk model: MARGIN-based — ${(MARGIN_FRAC*100).toFixed(0)}% of fund per trade, SL -${(SL_MARGIN*100).toFixed(0)}% margin.`);
    console.log(`Testing leverage [${LEVERAGES.join(', ')}] × TP [${TP_MARGINS.map(t=>'$'+(t*100).toFixed(0)).join(', ')} of a $100 trade].`);
    console.log(`At 50x fees ≈ ${(2*FEE_PER_SIDE*50*100).toFixed(0)}% of margin/trade; at 150x ≈ ${(2*FEE_PER_SIDE*150*100).toFixed(0)}% — higher leverage = MORE fee drag, not better.`);
  } else {
    console.log('Risk model: PRICE-based — sweeping SL/TP/leverage.');
  }
  console.log('Reminder: past data only. WR is a property of the entry rule; leverage only scales risk.');
  console.log(`Timeframe combos (bias → entry): ${TF_COMBOS.map(c => c.bias+'→'+c.entry).join('  |  ')}\n`);

  // shared: run the sweep on a given entry-candle set + bias array, print the grid/report
  function runGridAndReport(label, cEntry, biasArr, windowCount) {
    const ref = runOne(cEntry, biasArr, { lev: 1, slPct: 0.005, tpPct: 0.010 });
    console.log(`  ── ${label} | bias windows: ${windowCount} | trades: ${ref.trades} | base WR @0.5/1.0: ${fmt(ref.winRate)}%`);
    if (ref.trades < 15) console.log('     ⚠ few trades — read with caution.');

    const results = [];
    if (RISK_MODE === 'margin') {
      for (const lev of LEVERAGES)
        for (const tpM of TP_MARGINS) {
          const r = runOne(cEntry, biasArr, { lev, slPct: SL_MARGIN / lev, tpPct: tpM / lev });
          r.tpMargin = tpM; results.push(r);
        }
    } else {
      for (const lev of LEVERAGES)
        for (const slPct of SL_PCTS)
          for (const tpPct of TP_PCTS)
            results.push(runOne(cEntry, biasArr, { lev, slPct, tpPct }));
    }

    const viable = [...results]
      .filter(r => r.trades >= 15 && r.liquidations === 0 && r.profitFactor > 1 && r.totalReturnPct > 0)
      .sort((a, b) => (a.lev - b.lev) || (b.profitFactor - a.profitFactor));

    if (RISK_MODE === 'margin') {
      console.log('     lev   TP$   trades  WR%    PF    totRet%  maxDD%  liqs');
      for (const r of results) {
        const flag = (r.profitFactor > 1 && r.totalReturnPct > 0 && r.trades >= 15) ? ' ✅' : '';
        console.log(`     ${String(r.lev).padStart(3)}  $${String((r.tpMargin*100).toFixed(0)).padStart(2)}    ${String(r.trades).padStart(4)}  ${fmt(r.winRate).padStart(4)}  ${fmt(r.profitFactor,2).padStart(5)}  ${fmt(r.totalReturnPct).padStart(7)}  ${fmt(r.maxDDPct).padStart(5)}   ${r.liquidations}${flag}`);
      }
    } else {
      const byReturn = [...results].filter(r => r.trades >= 15).sort((a, b) => b.totalReturnPct - a.totalReturnPct);
      console.log('     lev  SL%   TP%   trades  WR%   PF   totRet%  maxDD%  liqs');
      for (const r of byReturn.slice(0, 3))
        console.log(`     ${String(r.lev).padStart(3)}  ${(r.slPct*100).toFixed(1)}   ${(r.tpPct*100).toFixed(1)}    ${String(r.trades).padStart(4)}  ${fmt(r.winRate).padStart(4)}  ${fmt(r.profitFactor,2).padStart(4)}  ${fmt(r.totalReturnPct).padStart(6)}  ${fmt(r.maxDDPct).padStart(5)}  ${r.liquidations}`);
    }
    if (viable.length) {
      const s = viable[0];
      console.log(`     → best VIABLE: ${s.lev}x ${RISK_MODE==='margin'?('TP$'+(s.tpMargin*100).toFixed(0)):('SL'+(s.slPct*100).toFixed(1)+'/TP'+(s.tpPct*100).toFixed(1))}  WR=${fmt(s.winRate)}%  PF=${fmt(s.profitFactor,2)}  ret=${fmt(s.totalReturnPct)}%  (${s.trades} trades)`);
    } else {
      console.log('     → ❌ no viable setting at this timeframe.');
    }
    console.log('');
  }

  for (const sym of SYMBOLS) {
    const neededTFs = [...new Set(TF_COMBOS.flatMap(c => [c.bias, c.entry]))];
    process.stdout.write(`Fetching ${sym} (${neededTFs.join(', ')}) … `);
    const data = {};
    try {
      for (const tf of neededTFs) { data[tf] = await fetchKlines(sym, tf, LOOKBACK_DAYS); await sleep(400); }
    } catch (e) {
      console.log(`SKIP (${e.message})`);
      continue;
    }
    console.log(neededTFs.map(tf => `${data[tf].length} ${tf}`).join(', '));

    for (const combo of TF_COMBOS) {
      const cBias = data[combo.bias], cEntry = data[combo.entry];
      let windows = buildSmcBiasWindows(cBias, 5, 3, TF_MS[combo.bias]);
      const rawCount = windows.length;
      if (VWAP_FILTER) {
        windows = applyVwapFilter(windows, computeVwapBands(cBias));
        console.log(`  [VWAP ±2SD filter] ${sym} ${combo.bias}→${combo.entry}: ${rawCount} signals → ${windows.length} kept (${rawCount ? Math.round(100*windows.length/rawCount) : 0}% at the outer band)`);
      }
      const biasArr = biasArrayFromWindows(cEntry, windows);
      if (MODE === 'prob') {
        const eng = computeProbability(cBias, { confWin: CONF_WIN });
        probReport(`${sym}  ${combo.bias}→${combo.entry}`, cEntry, biasArr, eng);
      } else if (MODE === 'oos') {
        oosReport(`${sym}  ${combo.bias}→${combo.entry}`, cEntry, biasArr, OOS_SEGMENTS);
      } else {
        runGridAndReport(`${sym}  ${combo.bias}→${combo.entry}`, cEntry, biasArr, windows.length);
      }
    }
    await sleep(1500); // breathe between symbols
  }

  if (MODE === 'prob') {
    console.log('Read it like this: if WR climbs as the prob band rises, the probability filter');
    console.log('has real signal — gate your live signal at the threshold with the best WR *and*');
    console.log('enough trades. If WR is flat across bands, the score is noise and gating won\'t help.\n');
  } else if (MODE === 'oos') {
    console.log('"holds in all" = profitable in EVERY independent period = the real test passed.');
    console.log('"mixed" = it worked in one period, not another → regime-dependent, not a stable edge.');
    console.log('Only a setting that holds in all periods is worth a small testnet trial.\n');
  } else {
    console.log('Done. Compare timeframes: a BLOCK of green (not one lucky cell) means that');
    console.log('timeframe has room above the fees. Validate winners on 30 days. Higher');
    console.log('leverage = more fee drag, not edge.\n');
  }
}

main.runOne = runOne;
main.fetchKlines = fetchKlines;
module.exports = main;

if (require.main === module) {
  main().catch(e => { console.error('Backtest failed:', e.message); process.exit(1); });
}
