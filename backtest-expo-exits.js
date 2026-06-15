'use strict';
/**
 * Expo-structure backtest WITH live trade management, to compare against the
 * "ride to full SL" model. Three exit models per token at 20x, SL 50% / TP 35%:
 *   1. baseline   — hard SL/TP only (what backtest-expo-struct.js does)
 *   2. +trail     — adds the live capital%-tier trailing SL (trail-tiers.js)
 *   3. +trail+15m — also adds the 15m structure-flip early exit (cycle.js shouldExit15m)
 *
 *   node backtest-expo-exits.js [leverage] [slMargin] [tpMargin]   (VPN required)
 */
const fs = require('fs');
const bt = require('./backtest-structure.js');
const { biasArrayFromWindows } = require('./strategy-structure-htf-ltf');
const { calculateTrailingStep } = require('./trail-tiers');

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT').split(',');
const LEV  = Number(process.argv[2] || 20);
const SL_M = Number(process.argv[3] || 0.50);
const TP_M = Number(process.argv[4] || 0.35);
const LAG_BARS = 10, WINDOW_BARS = 8, BAR_MS = 15 * 60 * 1000, SWING_LEN_15 = 10;
const FEE_PER_SIDE = 0.0005;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '∞';

function biasWindowsFromExpo(labels) {
  const w = [];
  for (const l of labels) {
    if (l.type !== 'HL' && l.type !== 'LH') continue;
    const from = l.time + LAG_BARS * BAR_MS;
    w.push({ bias: l.type === 'HL' ? 'long' : 'short', from, to: from + WINDOW_BARS * BAR_MS });
  }
  return w.sort((a, b) => a.from - b.from);
}

// Per-15m-bar early-exit flags (mirrors cycle.js shouldExit15m, Zeiierman swings len 10).
// long=true → a confirmed Lower-High exists (exit longs); short=true → confirmed Higher-Low.
function buildExit15(c15, len) {
  const highs = [], lows = [];
  for (let i = len; i < c15.length - len; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= len; k++) {
      if (!(c15[i].high > c15[i - k].high && c15[i].high > c15[i + k].high)) isH = false;
      if (!(c15[i].low  < c15[i - k].low  && c15[i].low  < c15[i + k].low))  isL = false;
    }
    if (isH) highs.push({ confirmAt: i + len, price: c15[i].high });
    if (isL) lows.push({ confirmAt: i + len, price: c15[i].low });
  }
  const map = new Map();
  let hi = 0, lo = 0;
  for (let t = 0; t < c15.length; t++) {
    while (hi < highs.length && highs[hi].confirmAt <= t) hi++;
    while (lo < lows.length  && lows[lo].confirmAt  <= t) lo++;
    const longExit  = hi >= 2 && highs[hi - 1].price < highs[hi - 2].price; // LH
    const shortExit = lo >= 2 && lows[lo - 1].price  > lows[lo - 2].price;  // HL
    map.set(c15[t].time, { long: longExit, short: shortExit });
  }
  return map;
}

function runManaged(c1, biasArr, exit15, { useTrail, useStruct }) {
  const lev = LEV, liqPct = 1 / lev, fee = 2 * FEE_PER_SIDE * lev;
  let pos = null, armed = false;
  const trades = [];
  for (let i = 1; i < c1.length; i++) {
    const c = c1[i], prev = c1[i - 1];
    if (biasArr[i] && biasArr[i] !== biasArr[i - 1]) armed = true;

    if (pos) {
      const isLong = pos.side === 'long';
      if (useTrail) {
        const r = calculateTrailingStep(pos.entry, c.close, isLong, pos.lastStep, lev, 0, false);
        if (r) {
          pos.sl = isLong ? Math.max(pos.sl, r.newSlPrice) : Math.min(pos.sl, r.newSlPrice);
          pos.lastStep = r.newLastStep;
        }
      }
      let exit = null, px = null;
      if (isLong) {
        if (c.low <= pos.liq) exit = 'LIQ';
        else if (c.low <= pos.sl) { exit = pos.lastStep > 0 ? 'TRAIL' : 'SL'; px = pos.sl; }
        else if (c.high >= pos.tp) { exit = 'TP'; px = pos.tp; }
      } else {
        if (c.high >= pos.liq) exit = 'LIQ';
        else if (c.high >= pos.sl) { exit = pos.lastStep > 0 ? 'TRAIL' : 'SL'; px = pos.sl; }
        else if (c.low <= pos.tp) { exit = 'TP'; px = pos.tp; }
      }
      if (!exit && useStruct) {
        const f = exit15.get(Math.floor(c.time / BAR_MS) * BAR_MS);
        const losing = isLong ? c.close < pos.entry : c.close > pos.entry;
        if (f && losing && ((isLong && f.long) || (!isLong && f.short))) { exit = 'STRUCT'; px = c.close; }
      }
      if (exit) {
        let rOM;
        if (exit === 'LIQ') rOM = -1.0;
        else {
          const pp = (pos.side === 'long') ? (px - pos.entry) / pos.entry : (pos.entry - px) / pos.entry;
          rOM = pp * lev - fee;
        }
        trades.push({ exit, rOM });
        pos = null;
      }
      continue;
    }

    const bias = biasArr[i];
    if (!bias || !armed || i < 2) continue;
    const c2 = c1[i - 2];
    const goLong = prev.low < c2.low && prev.low < c.low;
    const goShort = prev.high > c2.high && prev.high > c.high;
    const slPx = Math.min(SL_M / lev, liqPct * 0.80);
    if (bias === 'long' && goLong) { const e = c.close; pos = { side: 'long', entry: e, sl: e * (1 - slPx), tp: e * (1 + TP_M / lev), liq: e * (1 - liqPct), lastStep: 0 }; armed = false; }
    else if (bias === 'short' && goShort) { const e = c.close; pos = { side: 'short', entry: e, sl: e * (1 + slPx), tp: e * (1 - TP_M / lev), liq: e * (1 + liqPct), lastStep: 0 }; armed = false; }
  }

  const n = trades.length;
  const wins = trades.filter(t => t.rOM > 0).length;
  const gw = trades.filter(t => t.rOM > 0).reduce((s, t) => s + t.rOM, 0);
  const gl = -trades.filter(t => t.rOM < 0).reduce((s, t) => s + t.rOM, 0);
  const losses = trades.filter(t => t.rOM < 0);
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.rOM, 0) / losses.length * 100 : 0;
  const cnt = trades.reduce((a, t) => (a[t.exit] = (a[t.exit] || 0) + 1, a), {});
  return {
    n, wr: n ? wins / n * 100 : 0,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    ret: trades.reduce((s, t) => s + t.rOM, 0) * 100,
    avgLoss, cnt,
  };
}

async function main() {
  console.log(`\n=== Expo structure + LIVE trade management | ${LEV}x | SL ${SL_M*100}% / TP ${TP_M*100}% ===`);
  console.log('Comparing: baseline (hard SL/TP) → +trailing SL → +trailing +15m structure-flip exit\n');
  const prepared = [];
  for (const sym of SYMBOLS) {
    const path = `data/expo-labels/${sym}-15m-expo.json`;
    if (!fs.existsSync(path)) continue;
    const labels = JSON.parse(fs.readFileSync(path, 'utf8'));
    const days = Math.ceil((labels[labels.length - 1].time - labels[0].time) / 86400000) + 2;
    process.stdout.write(`Fetching ${sym} … `);
    let c1, c15;
    try { c1 = await bt.fetchKlines(sym, '1m', days); await sleep(400); c15 = await bt.fetchKlines(sym, '15m', days); await sleep(400); }
    catch (e) { console.log(`SKIP (${e.message})`); continue; }
    const biasArr = biasArrayFromWindows(c1, biasWindowsFromExpo(labels));
    prepared.push({ sym, c1, biasArr, exit15: buildExit15(c15, SWING_LEN_15) });
    console.log('ok');
    await sleep(800);
  }
  console.log('');
  for (const p of prepared) {
    console.log(`── ${p.sym} ──`);
    console.log('   model           trades  WR%    PF     totRet%  avgLoss%  exits');
    const models = [
      ['baseline', { useTrail: false, useStruct: false }],
      ['+trail', { useTrail: true, useStruct: false }],
      ['+trail+15m', { useTrail: true, useStruct: true }],
    ];
    for (const [name, opt] of models) {
      const r = runManaged(p.c1, p.biasArr, p.exit15, opt);
      const exits = Object.entries(r.cnt).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`   ${name.padEnd(13)}  ${String(r.n).padStart(4)}  ${fmt(r.wr).padStart(4)}  ${fmt(r.pf, 2).padStart(5)}  ${fmt(r.ret).padStart(7)}  ${fmt(r.avgLoss).padStart(7)}   ${exits}`);
    }
    console.log('');
  }
  console.log('Reading: trailing converts deep losers into small SL/TRAIL exits and caps winner giveback;');
  console.log('the 15m flip cuts losers at market before the hard stop. avgLoss% shrinking = less downside.');
  console.log('Still ~8d / few trades per token — directional, not a robust edge.\n');
}
main().catch(e => { console.error('failed:', e.message); process.exit(1); });
