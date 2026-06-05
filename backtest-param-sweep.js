'use strict';

/**
 * backtest-param-sweep.js
 * Grid search across SL width, TP1, TP2, and leverage to find the
 * optimal config for BTC and ETH with all current filters active.
 *
 * Tests 3 dimensions:
 *   Leverage  : 20x, 30x, 50x, 75x, 100x, 125x
 *   TP1 mult  : 0.3×, 0.5×, 0.8×, 1.0×, 1.5×  (× SL distance)
 *   TP2 mult  : 1.0×, 1.5×, 2.0×, 3.0×, 5.0×  (× SL distance)
 *
 * Capital risk per leverage is fixed at 0.50% of notional, so:
 *   slPct = 0.0050 / leverage   (price % SL distance)
 *
 * All quality gates remain active: ICT killzone, 4H trend, RSI, ADX, VWAP.
 */

// ─── Patch node-fetch ─────────────────────────────────────────────────────────
const Module = require('module');
const _orig  = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'node-fetch') {
    const m = () => Promise.reject(new Error('mocked'));
    m.default = m; return m;
  }
  return _orig.call(this, req, ...rest);
};

const {
  scanKeyLevelSignal,
  classifyTrend,
  TRADING_CONFIG,
} = require('./smc-engine.js');

// ─── Sweep parameters ─────────────────────────────────────────────────────────
const LEVERAGES   = [20, 30, 50, 75, 100, 125];
const TP1_MULTS   = [0.3, 0.5, 0.8, 1.0, 1.5];   // × SL distance
const TP2_MULTS   = [1.0, 1.5, 2.0, 3.0, 5.0];   // × SL distance
const CAP_RISK_PCT = 0.0050;   // fixed 0.50% of notional for SL

// ─── Backtest constants ───────────────────────────────────────────────────────
const BARS_15M    = 6080;   // 3200 warmup + 2880 live (30 days)
const STARTING_CAP = 1000;
const RISK_PCT    = 0.02;   // 2% of capital risked per trade
const FIXED_RISK  = STARTING_CAP * RISK_PCT;   // $20
const FEE_RT      = 0.0012;
const MAX_HOLD_1M = 120;
const SYMBOLS     = Object.keys(TRADING_CONFIG);

// ─── Synthetic data (same as main backtest — down regime for BTC/ETH) ─────────
const SYMBOL_PARAMS = {
  BTCUSDT: { price: 67500, vol: 0.0030, trend: 0.00006, regime: 'down' },
  ETHUSDT: { price: 3450,  vol: 0.0038, trend: 0.00005, regime: 'down' },
};

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0xffffffff; };
}

function genBars15m(symbol, n) {
  const p = SYMBOL_PARAMS[symbol];
  const rand = lcg(symbol.charCodeAt(0) * 7919 + symbol.charCodeAt(1) * 31);
  const bm = () => {
    let u, v, s;
    do { u = rand()*2-1; v = rand()*2-1; s = u*u+v*v; } while (s >= 1);
    return u * Math.sqrt(-2 * Math.log(s) / s);
  };
  const BASE_TS = new Date('2026-01-05T07:00:00Z').getTime() - n * 15 * 60_000;
  const bars = [];
  let price = p.price, volMul = 1;
  const driftBase = p.regime === 'up' ? p.trend*2 : p.regime === 'down' ? -p.trend*2 : 0;
  for (let i = 0; i < n; i++) {
    const regime = Math.floor(i / 200) % 3;
    const drift  = regime === 0 ? driftBase : regime === 1 ? -driftBase*0.5 : p.trend*0.5;
    volMul = 0.9*volMul + 0.1*(0.8+rand()*0.4) + (rand()<0.02 ? rand()*2 : 0);
    const sigma = p.vol * Math.sqrt(volMul);
    const ret = drift + sigma * bm();
    const open = price, close = price * (1 + ret);
    const hi = Math.max(open,close) * (1 + sigma*Math.abs(bm())*0.5);
    const lo = Math.min(open,close) * (1 - sigma*Math.abs(bm())*0.5);
    bars.push({ t: BASE_TS + i*15*60_000, o: open, h: hi, l: lo, c: close, v: 1000+rand()*9000 });
    price = close;
  }
  return bars;
}

function expand15mTo1m(bar15m) {
  const rand = lcg(Math.round(bar15m.t/1000) % 999983);
  const bars1m = []; let price = bar15m.o;
  const body = Math.abs(bar15m.c - bar15m.o), range = bar15m.h - bar15m.l;
  for (let j = 0; j < 15; j++) {
    const isLast = j === 14;
    const frac = isLast ? 1 : rand();
    const step = (bar15m.c - price) * frac * (isLast ? 1 : 0.3+rand()*0.4);
    const o15 = price, c15 = isLast ? bar15m.c : price + step;
    const wm = range / (body + 1e-10);
    const h15 = Math.max(o15,c15) + range*0.05*rand()*(j===2||j===10 ? wm*0.5 : 0.2);
    const l15 = Math.min(o15,c15) - range*0.05*rand()*(j===5||j===12 ? wm*0.5 : 0.2);
    bars1m.push({ t: bar15m.t+j*60_000, o: o15, h: Math.min(h15,bar15m.h), l: Math.max(l15,bar15m.l), c: c15, v: bar15m.v/15 });
    price = c15;
  }
  return bars1m;
}

function agg15mTo4h(bars15m) {
  const out = [];
  for (let i = 0; i+15 < bars15m.length; i += 16) {
    const chunk = bars15m.slice(i, i+16);
    out.push({ t: chunk[0].t, o: chunk[0].o, h: Math.max(...chunk.map(b=>b.h)),
               l: Math.min(...chunk.map(b=>b.l)), c: chunk[chunk.length-1].c,
               v: chunk.reduce((a,b) => a+b.v, 0) });
  }
  return out;
}

// ─── Trade simulator (parametric TP1/TP2) ────────────────────────────────────
function simulateTrade(bars1m, entryIdx, dir, entry, sl, tp1, tp2) {
  let phase = 1, movedSL = entry;
  for (let i = entryIdx; i < Math.min(entryIdx + MAX_HOLD_1M, bars1m.length); i++) {
    const { h, l } = bars1m[i];
    if (dir === 'LONG') {
      if (phase === 1) {
        if (l <= sl)  return { outcome:'LOSS',    R:-1 };
        if (h >= tp1) { phase = 2; movedSL = entry; }
      } else {
        if (l <= movedSL) return { outcome:'PARTIAL', R:1 };
        if (h >= tp2)     return { outcome:'TP2',     R:3 };
      }
    } else {
      if (phase === 1) {
        if (h >= sl)  return { outcome:'LOSS',    R:-1 };
        if (l <= tp1) { phase = 2; movedSL = entry; }
      } else {
        if (h >= movedSL) return { outcome:'PARTIAL', R:1 };
        if (l <= tp2)     return { outcome:'TP2',     R:3 };
      }
    }
  }
  return { outcome:'TIMEOUT', R: phase===2 ? 1 : -0.3 };
}

// ─── Single-config backtest for one symbol ────────────────────────────────────
// Patches TRADING_CONFIG.slPct, runs the scan, returns summary stats.
function runConfig(symbol, bars15m, bars1mAll, bars4hAll, slPct) {
  // Temporarily patch the engine's slPct for this symbol
  const origCfg = { ...require('./smc-engine.js').TRADING_CONFIG[symbol] };
  require('./smc-engine.js').TRADING_CONFIG[symbol].slPct = slPct;

  const cooldowns = new Map();
  const rawSignals = [];   // { signal, entryTs }

  for (let i = 3200; i < bars15m.length - 2; i++) {
    const bars15mWin = bars15m.slice(Math.max(0, i-199), i+1);
    const curTs      = bars15m[i].t + 14*60_000;
    const bars1mWin  = bars1mAll.filter(b => b.t <= curTs).slice(-180);
    const bars4hWin  = bars4hAll.filter(b => b.t <= curTs);
    if (bars1mWin.length < 10 || bars4hWin.length < 3) continue;

    const sig = scanKeyLevelSignal(symbol, bars15mWin, bars1mWin, bars4hWin, cooldowns);
    if (!sig) continue;
    rawSignals.push({ sig, curTs });
    i += 4;  // skip ahead (same as main backtest)
  }

  // Restore original config
  require('./smc-engine.js').TRADING_CONFIG[symbol].slPct = origCfg.slPct;
  return rawSignals;
}

// ─── Score a set of signals with given TP1/TP2 multipliers ───────────────────
function scoreSignals(signals, bars1mAll, tp1Mult, tp2Mult) {
  let wins = 0, losses = 0, totalR = 0, totalPnl = 0;
  for (const { sig, curTs } of signals) {
    const entryTs  = sig.ts;
    const eIdx     = bars1mAll.findIndex(b => b.t >= entryTs);
    if (eIdx < 0 || eIdx + 1 >= bars1mAll.length) continue;

    const next  = bars1mAll[eIdx + 1];
    const entry = next.o;
    const slDist = Math.abs(entry - sig.sl);    // raw price distance to SL
    const tp1   = sig.dir === 'LONG' ? entry + slDist*tp1Mult : entry - slDist*tp1Mult;
    const tp2   = sig.dir === 'LONG' ? entry + slDist*tp2Mult : entry - slDist*tp2Mult;
    const sl    = sig.sl;

    // Basic validity
    if (sig.dir === 'LONG'  && (entry <= sl || entry >= tp1)) continue;
    if (sig.dir === 'SHORT' && (entry >= sl || entry <= tp1)) continue;

    const sim = simulateTrade(bars1mAll, eIdx + 2, sig.dir, entry, sl, tp1, tp2);
    const pnl = sim.R * FIXED_RISK - FIXED_RISK * FEE_RT;
    totalR   += sim.R;
    totalPnl += pnl;
    if (sim.R > 0) wins++;
    else           losses++;
  }
  const n = wins + losses;
  return { n, wins, losses, wr: n ? wins/n : 0, avgR: n ? totalR/n : 0, totalR, totalPnl };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║          SMC Parameter Sweep — SL / TP1 / TP2 / Leverage Optimisation        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');
  console.log('Generating 30-day synthetic data (bear regime)...\n');

  const allResults = [];

  for (const symbol of SYMBOLS) {
    const bars15m  = genBars15m(symbol, BARS_15M);
    const bars1mAll = bars15m.flatMap(expand15mTo1m);
    const bars4hAll = agg15mTo4h(bars15m);

    console.log(`\n${'═'.repeat(100)}`);
    console.log(`  ${symbol} — sweeping ${LEVERAGES.length} leverages × ${TP1_MULTS.length} TP1s × ${TP2_MULTS.length} TP2s = ${LEVERAGES.length*TP1_MULTS.length*TP2_MULTS.length} combinations`);
    console.log(`${'═'.repeat(100)}`);
    console.log(`  Lev    SL%    TP1%   TP2%  |  Trades  Prof%  AvgR    TotalR    Net$30d   RR`);
    console.log(`  ${'─'.repeat(97)}`);

    const symResults = [];

    for (const lev of LEVERAGES) {
      const slPct  = CAP_RISK_PCT / lev;   // price % SL distance
      const slPct_display = (slPct * 100).toFixed(3);

      // Get signals once for this slPct (entry / pivot checks depend on slPct)
      const signals = runConfig(symbol, bars15m, bars1mAll, bars4hAll, slPct);

      for (const tp1m of TP1_MULTS) {
        for (const tp2m of TP2_MULTS) {
          if (tp2m <= tp1m) continue;  // TP2 must be further than TP1

          const tp1Pct = (slPct * tp1m * 100).toFixed(3);
          const tp2Pct = (slPct * tp2m * 100).toFixed(3);
          const rr     = (tp2m / 1).toFixed(1);  // R:R to TP2 (SL = 1R)

          const stats = scoreSignals(signals, bars1mAll, tp1m, tp2m);

          const row = {
            symbol, lev, slPct, tp1m, tp2m,
            slPct_display, tp1Pct, tp2Pct,
            ...stats
          };
          symResults.push(row);

          // Only print rows with trades
          if (stats.n >= 3) {
            const flag = stats.wr >= 0.75 && stats.avgR >= 0.5 ? ' ◀ ✓' :
                         stats.wr >= 0.65 && stats.avgR >= 0.3 ? ' ◀'   : '';
            console.log(
              `  ${String(lev+'x').padEnd(5)} ${slPct_display.padEnd(6)} ${tp1Pct.padEnd(6)} ${tp2Pct.padEnd(5)} |` +
              `  ${String(stats.n).padStart(5)}  ${(stats.wr*100).toFixed(0).padStart(4)}%` +
              `  ${(stats.avgR>=0?'+':'')}${stats.avgR.toFixed(2)}R` +
              `  ${(stats.totalR>=0?'+':'')}${stats.totalR.toFixed(1).padStart(6)}R` +
              `  ${stats.totalPnl>=0?'+':' '}$${stats.totalPnl.toFixed(0).padStart(7)}` +
              `   ${rr}:1${flag}`
            );
          }
        }
      }
    }

    // ── Top 5 by total P&L ──────────────────────────────────────────
    const top5pnl = [...symResults].filter(r => r.n >= 3)
      .sort((a,b) => b.totalPnl - a.totalPnl).slice(0, 5);
    // Top 5 by win rate (minimum 5 trades)
    const top5wr  = [...symResults].filter(r => r.n >= 5)
      .sort((a,b) => b.wr - a.wr || b.avgR - a.avgR).slice(0, 5);

    console.log(`\n  ┌─ TOP 5 by Net P&L (${symbol}) ─────────────────────────────────────────────┐`);
    console.log(`  │  Rank  Lev    SL%    TP1%   TP2%    Trades  WR%   AvgR    Net$30d         │`);
    top5pnl.forEach((r,i) => {
      console.log(
        `  │  #${i+1}   ${String(r.lev+'x').padEnd(5)} ${r.slPct_display.padEnd(6)} ${r.tp1Pct.padEnd(6)} ${r.tp2Pct.padEnd(6)} ` +
        `  ${String(r.n).padStart(4)}  ${(r.wr*100).toFixed(0).padStart(4)}%` +
        `  ${(r.avgR>=0?'+':'')}${r.avgR.toFixed(2)}R` +
        `  +$${r.totalPnl.toFixed(0).padStart(7)}        │`
      );
    });
    console.log(`  └─────────────────────────────────────────────────────────────────────────────┘`);

    console.log(`\n  ┌─ TOP 5 by Win Rate (${symbol}, min 5 trades) ───────────────────────────────┐`);
    console.log(`  │  Rank  Lev    SL%    TP1%   TP2%    Trades  WR%   AvgR    Net$30d         │`);
    top5wr.forEach((r,i) => {
      console.log(
        `  │  #${i+1}   ${String(r.lev+'x').padEnd(5)} ${r.slPct_display.padEnd(6)} ${r.tp1Pct.padEnd(6)} ${r.tp2Pct.padEnd(6)} ` +
        `  ${String(r.n).padStart(4)}  ${(r.wr*100).toFixed(0).padStart(4)}%` +
        `  ${(r.avgR>=0?'+':'')}${r.avgR.toFixed(2)}R` +
        `  +$${r.totalPnl.toFixed(0).padStart(7)}        │`
      );
    });
    console.log(`  └─────────────────────────────────────────────────────────────────────────────┘`);

    allResults.push({ symbol, symResults });
  }

  // ── Cross-symbol: best combined BTC+ETH config ───────────────────────────────
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  COMBINED BTC+ETH — Best configs by combined 30-day P&L');
  console.log(`${'═'.repeat(100)}`);

  // Build combined score for each (lev, tp1m, tp2m) combo
  const combMap = new Map();
  for (const { symResults } of allResults) {
    for (const r of symResults) {
      const key = `${r.lev}_${r.tp1m}_${r.tp2m}`;
      const prev = combMap.get(key) || { lev: r.lev, tp1m: r.tp1m, tp2m: r.tp2m, slPct_display: r.slPct_display, tp1Pct: r.tp1Pct, tp2Pct: r.tp2Pct, n:0, wins:0, totalPnl:0, totalR:0 };
      prev.n        += r.n;
      prev.wins     += r.wins;
      prev.totalPnl += r.totalPnl;
      prev.totalR   += r.totalR;
      combMap.set(key, prev);
    }
  }

  const combined = [...combMap.values()]
    .filter(r => r.n >= 6)
    .map(r => ({ ...r, wr: r.n ? r.wins/r.n : 0, avgR: r.n ? r.totalR/r.n : 0 }))
    .sort((a,b) => b.totalPnl - a.totalPnl)
    .slice(0, 10);

  console.log(`\n  Rank  Lev    SL%    TP1%   TP2%    Trades  WR%    AvgR    BTC+ETH Net$30d`);
  console.log(`  ${'─'.repeat(80)}`);
  combined.forEach((r,i) => {
    const rr = (r.tp2m/1).toFixed(1);
    console.log(
      `  #${String(i+1).padEnd(3)} ${String(r.lev+'x').padEnd(5)} ${r.slPct_display.padEnd(6)} ${r.tp1Pct.padEnd(6)} ${r.tp2Pct.padEnd(6)} ` +
      `  ${String(r.n).padStart(4)}  ${(r.wr*100).toFixed(0).padStart(4)}%` +
      `   ${(r.avgR>=0?'+':'')}${r.avgR.toFixed(2)}R` +
      `   +$${r.totalPnl.toFixed(0).padStart(7)}  (${rr}:1 RR)`
    );
  });

  // ── Winner recommendation ────────────────────────────────────────────────────
  const winner = combined[0];
  if (winner) {
    const slCapital = (CAP_RISK_PCT / (CAP_RISK_PCT / winner.slPct_display) * 100).toFixed(2);
    console.log(`\n${'═'.repeat(100)}`);
    console.log('  🏆  RECOMMENDED CONFIG (highest combined BTC+ETH profit, ≥6 trades)');
    console.log(`${'═'.repeat(100)}`);
    console.log(`  Leverage : ${winner.lev}×`);
    console.log(`  SL width : ${winner.slPct_display}% from 1m pivot level`);
    console.log(`  TP1      : ${winner.tp1Pct}% from entry  (close 50% position — locks in partial profit)`);
    console.log(`  TP2      : ${winner.tp2Pct}% from entry  (close remaining 50% — the runner)`);
    console.log(`  R:R      : 1 : ${winner.tp2m}  (risk 1 to win ${winner.tp2m})`);
    console.log(`  30d WR   : ${(winner.wr*100).toFixed(0)}%  |  AvgR: ${winner.avgR>=0?'+':''}${winner.avgR.toFixed(2)}R  |  Trades: ${winner.n}`);
    console.log(`  $1,000 capital → +$${winner.totalPnl.toFixed(0)} in 30 days`);
    console.log(`  Final capital  : $${(1000 + winner.totalPnl).toFixed(0)}`);
  }
}

main().catch(console.error);
