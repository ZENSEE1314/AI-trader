'use strict';
/**
 * Backtest the 1m pullback strategy using SMC EXPO's 15m structure (HL→long, LH→short)
 * instead of our native pivot detection. Expo labels are pre-extracted to
 * data/expo-labels/<SYM>-15m-expo.json by _expo_extract.js (read live from TV).
 *
 * Bias becomes active LAG_BARS×15m after the pivot bar (Expo "Structure Period"=10
 * confirms ~10 bars later — this removes look-ahead). Reuses backtest-structure.js's
 * runOne (1m swing-pullback entry, one trade per window, SL/TP on margin).
 *
 *   node backtest-expo-struct.js [leverage]   (VPN required — fetches 1m klines from Bybit)
 */
const fs = require('fs');
const bt = require('./backtest-structure.js');
const { biasArrayFromWindows } = require('./strategy-structure-htf-ltf');

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT').split(',');
const LEV = Number(process.argv[2] || 20);
const LAG_BARS    = Number(process.env.LAG_BARS    || 10);  // Expo Structure Period confirmation lag
const WINDOW_BARS = Number(process.env.WINDOW_BARS || 8);   // bias active duration after confirmation
const BAR_MS = 15 * 60 * 1000;
const VWAP_FILTER = (process.env.VWAP_FILTER || '0') !== '0'; // off by default (Expo has no VWAP gate)

const SL_GRID = [0.25, 0.35, 0.50, 0.60];
const TP_GRID = [0.35, 0.50, 0.70, 0.90];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '∞';

// Expo labels → bias windows. HL = higher-low → long; LH = lower-high → short.
function biasWindowsFromExpo(labels, bands15) {
  const windows = [];
  for (const l of labels) {
    if (l.type !== 'HL' && l.type !== 'LH') continue;
    if (VWAP_FILTER && bands15) {
      const b = bands15.get(l.time);
      if (!b) continue;
      const ok = l.type === 'HL' ? l.price <= b.lo : l.price >= b.hi;
      if (!ok) continue;
    }
    const from = l.time + LAG_BARS * BAR_MS;
    windows.push({ bias: l.type === 'HL' ? 'long' : 'short', from, to: from + WINDOW_BARS * BAR_MS });
  }
  windows.sort((a, b) => a.from - b.from);
  return windows;
}

async function main() {
  console.log(`\n=== SMC EXPO structure backtest — PER TOKEN | ${LEV}x | lag=${LAG_BARS}b window=${WINDOW_BARS}b | VWAP filter ${VWAP_FILTER ? 'ON' : 'off'} ===`);
  console.log(`Bias from Expo HL/LH labels (data/expo-labels). Entry: 1m swing pullback, one trade/window.\n`);

  const prepared = [];
  for (const sym of SYMBOLS) {
    const path = `data/expo-labels/${sym}-15m-expo.json`;
    if (!fs.existsSync(path)) { console.log(`${sym}: no label file — run _expo_extract.js`); continue; }
    const labels = JSON.parse(fs.readFileSync(path, 'utf8'));
    const days = Math.ceil((labels[labels.length - 1].time - labels[0].time) / 86400000) + 2;
    process.stdout.write(`Fetching ${sym} 1m (${days}d) … `);
    let c1, bands15 = null;
    try {
      c1 = await bt.fetchKlines(sym, '1m', days); await sleep(400);
      if (VWAP_FILTER) {
        const c15 = await bt.fetchKlines(sym, '15m', days); await sleep(400);
        const { v2u, v2d } = bt.computeVwapBands(c15);
        bands15 = new Map(c15.map((c, i) => [c.time, { lo: v2d[i], hi: v2u[i] }]));
      }
    } catch (e) { console.log(`SKIP (${e.message})`); continue; }
    const windows = biasWindowsFromExpo(labels, bands15);
    const biasArr = biasArrayFromWindows(c1, windows);
    prepared.push({ sym, c1, biasArr, windows: windows.length });
    console.log(`${c1.length} 1m bars, ${windows.length} bias windows`);
    await sleep(800);
  }
  if (!prepared.length) { console.log('No data.'); return; }

  // One symbol's SL/TP grid at LEV.
  function symGrid(p) {
    const rows = [];
    for (const slM of SL_GRID) {
      for (const tpM of TP_GRID) {
        const slPct = Math.min(slM / LEV, (1 / LEV) * 0.80);  // liq guard (matches live openTrade)
        const r = bt.runOne(p.c1, p.biasArr, { lev: LEV, slPct, tpPct: tpM / LEV });
        rows.push({ slM, tpM, n: r.trades, wr: r.winRate, pf: r.profitFactor, ret: r.totalReturnPct, liqs: r.liquidations });
      }
    }
    return rows;
  }

  for (const p of prepared) {
    console.log(`\n── ${p.sym}  |  ${p.windows} bias windows (Expo HL/LH) ──`);
    console.log(`   SL%   TP%   trades  WR%    PF     totRet%  liqs`);
    const rows = symGrid(p);
    for (const r of rows) {
      const flag = (r.pf > 1.2 && r.ret > 0 && r.n >= 6 && r.liqs === 0) ? ' ✅' : (r.liqs ? ' ⚠liq' : '');
      console.log(`   ${String(r.slM*100).padStart(3)}  ${String(r.tpM*100).padStart(4)}   ${String(r.n).padStart(4)}  ${fmt(r.wr).padStart(4)}  ${fmt(r.pf,2).padStart(5)}  ${fmt(r.ret).padStart(7)}   ${r.liqs}${flag}`);
    }
    const best = rows.filter(r => r.n >= 6 && r.pf > 1 && r.ret > 0 && r.liqs === 0).sort((a, b) => b.pf - a.pf)[0];
    console.log(best
      ? `   → best: SL ${best.slM*100}% / TP ${best.tpM*100}%  →  WR ${fmt(best.wr)}%  PF ${fmt(best.pf,2)}  ret ${fmt(best.ret)}%  (${best.n} trades)`
      : `   → no viable cell (too few trades / unprofitable)`);
  }
  console.log(`\n  ⚠ Per-token samples are TINY (~7–9d, ${'~'}6–11 trades each) — individual WR/PF are noisy.`);
  console.log('  Read direction + consistency across tokens, not the exact numbers. 20x is the live setting.\n');
}

main().catch(e => { console.error('Backtest failed:', e.message); process.exit(1); });
