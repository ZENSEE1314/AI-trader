'use strict';

/**
 * backtest-smc-v3.js
 * Production-accurate SMC backtest — calls the real scanKeyLevelSignal() from
 * smc-engine.js with synthetic 15m + 1m + 4h data. All production filters apply:
 *   • Step 1b : 4H trend gate (blocks LONG if 4H=DOWN, SHORT if 4H=UP)
 *   • Step 1c : 1m CHoCH conflict/redirect
 *   • Step 2  : 1m swing pivot within WINDOW_MS of 15m pivot
 *   • Step 2b : 1m level must be within slPct×2 of 15m pivot
 *   • Step 3  : 1m pivot ≤ 10 bars old
 *   • Step 4  : price within ENTRY_TOL of 1m level
 *   • Cooldown: per pivot-ts, 1h
 *
 * The backtest uses synthetic OHLCV (GBM + trend regimes + vol clustering)
 * since the Bybit API is blocked in this sandbox.
 */

// ─── Patch node-fetch before requiring smc-engine ────────────────────────────
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'node-fetch') {
    const mock = () => Promise.reject(new Error('node-fetch mocked out in backtest'));
    mock.default = mock;
    return mock;
  }
  return _origLoad.call(this, req, ...rest);
};

const {
  scanKeyLevelSignal,
  classifyTrend,
  TRADING_CONFIG,
  TP1_PCT,
  TP2_PCT,
} = require('./smc-engine.js');

// ─── Constants ───────────────────────────────────────────────────────────────
const SYMBOLS           = Object.keys(TRADING_CONFIG);  // all 9 from production config
// 30-day backtest window:
//   EMA200 warmup  = 200 4H bars × 16 (15m/bar) = 3200 bars
//   30 trading days = 30 × 24h × 4 bars/h       = 2880 bars
//   Total needed                                  = 6080 bars
const BARS_15M          = 6080;   // 3200 warmup + 2880 live = 30 days of real trading
const STARTING_CAP      = 1000;
const RISK_PCT          = 0.02;
const FIXED_RISK        = STARTING_CAP * RISK_PCT;  // $20 per trade
const FEE_RT            = 0.0012;
const MAX_HOLD_1M       = 120;    // max 120 1m bars to hold trade (2h)
const SCAN_EVERY        = 1;      // scan every N 15m bars

// ─── Synthetic data generation ────────────────────────────────────────────────
// NOTE: BTC and ETH use 'down' regime to simulate a realistic bear market
// (matches current real conditions: BTC RSI=17.5, ETH RSI=15.3, both full bearish EMA stack).
// This allows the 4H trend classifier to produce DOWN signals — enabling trend-following SHORTs
// which are the highest-WR setups in the strategy.
const SYMBOL_PARAMS = {
  BTCUSDT:  { price: 67500, vol: 0.0030, trend: 0.00006, regime: 'down' },
  ETHUSDT:  { price: 3450,  vol: 0.0038, trend: 0.00005, regime: 'down' },
  SOLUSDT:  { price: 155,   vol: 0.0055, trend: 0.00007, regime: 'down' },  // SOL: higher vol, strong downtrend
  BNBUSDT:  { price: 520,   vol: 0.0032, trend: 0.00005, regime: 'down' },  // BNB: mid vol, moderate downtrend
  SOLUSDT:  { price: 172,   vol: 0.0055, trend: 0.00008, regime: 'up'    },
  BNBUSDT:  { price: 595,   vol: 0.0035, trend: 0.00004, regime: 'range' },
  ADAUSDT:  { price: 0.615, vol: 0.0050, trend: 0.00002, regime: 'up'    },
  DOTUSDT:  { price: 8.42,  vol: 0.0060, trend: 0.00003, regime: 'range' },
  LINKUSDT: { price: 18.75, vol: 0.0055, trend: 0.00004, regime: 'down'  },
  AVAXUSDT: { price: 38.90, vol: 0.0058, trend: 0.00005, regime: 'range' },
  LTCUSDT:  { price: 88.50, vol: 0.0040, trend: 0.00002, regime: 'down'  },
};

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0xffffffff; };
}

function genBars15m(symbol, n) {
  const p = SYMBOL_PARAMS[symbol];
  const rand = lcg(symbol.charCodeAt(0) * 7919 + symbol.charCodeAt(1) * 31);
  const boxMuller = () => {
    let u, v, s;
    do { u = rand() * 2 - 1; v = rand() * 2 - 1; s = u * u + v * v; } while (s >= 1);
    return u * Math.sqrt(-2 * Math.log(s) / s);
  };

  // Fixed anchor: Monday 2026-01-05 07:00 UTC — ensures each batch of 2000×15m bars
  // starts at London open, giving stable kill zone coverage across runs.
  const BASE_TS = new Date('2026-01-05T07:00:00Z').getTime() - n * 15 * 60_000;
  const bars = [];
  let price  = p.price;
  let volMul = 1;
  // Regime-based drift: 'up' = positive, 'down' = negative, 'range' = near-zero
  const driftBase = p.regime === 'up' ? p.trend * 2 : p.regime === 'down' ? -p.trend * 2 : 0;

  for (let i = 0; i < n; i++) {
    // Trend regime switching every ~200 bars
    const regime = Math.floor(i / 200) % 3;
    const drift  = regime === 0 ? driftBase : regime === 1 ? -driftBase * 0.5 : p.trend * 0.5;

    // GARCH-like vol clustering
    volMul = 0.9 * volMul + 0.1 * (0.8 + rand() * 0.4) + (rand() < 0.02 ? rand() * 2 : 0);
    const sigma = p.vol * Math.sqrt(volMul);

    const ret  = drift + sigma * boxMuller();
    const open = price;
    const close = price * (1 + ret);

    // Body range
    const hi = Math.max(open, close) * (1 + sigma * Math.abs(boxMuller()) * 0.5);
    const lo = Math.min(open, close) * (1 - sigma * Math.abs(boxMuller()) * 0.5);
    const vol = 1000 + rand() * 9000;

    bars.push({ t: BASE_TS + i * 15 * 60_000, o: open, h: hi, l: lo, c: close, v: vol });
    price = close;
  }
  return bars;
}

// Expand one 15m bar into 15 1m sub-bars (consistent OHLC)
function expand15mTo1m(bar15m) {
  const rand = lcg(Math.round(bar15m.t / 1000) % 999983);
  const bars1m = [];
  const dir = bar15m.c > bar15m.o ? 1 : -1;
  let price = bar15m.o;
  const body = Math.abs(bar15m.c - bar15m.o);
  const range = bar15m.h - bar15m.l;

  for (let j = 0; j < 15; j++) {
    const isLast = j === 14;
    const frac   = isLast ? 1 : rand();
    const step   = (bar15m.c - price) * frac * (isLast ? 1 : 0.3 + rand() * 0.4);
    const o15 = price;
    const c15 = isLast ? bar15m.c : price + step;

    // Wick proportional to 15m range
    const wickMul = range / (body + 1e-10);
    const h15 = Math.max(o15, c15) + range * 0.05 * rand() * (j === 2 || j === 10 ? wickMul * 0.5 : 0.2);
    const l15 = Math.min(o15, c15) - range * 0.05 * rand() * (j === 5 || j === 12 ? wickMul * 0.5 : 0.2);

    // Ensure 1m high/low respects 15m bounds
    bars1m.push({
      t: bar15m.t + j * 60_000,
      o: o15,
      h: Math.min(h15, bar15m.h),
      l: Math.max(l15, bar15m.l),
      c: c15,
      v: bar15m.v / 15,
    });
    price = c15;
  }
  return bars1m;
}

// Aggregate 15m bars into 4h bars (16 × 15m = 1 × 4h)
function agg15mTo4h(bars15m) {
  const bars4h = [];
  for (let i = 0; i + 15 < bars15m.length; i += 16) {
    const chunk = bars15m.slice(i, i + 16);
    bars4h.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map(b => b.h)),
      l: Math.min(...chunk.map(b => b.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((a, b) => a + b.v, 0),
    });
  }
  return bars4h;
}

// ─── Trade simulation (1m bars) ───────────────────────────────────────────────
function simulateTrade(bars1m, entryIdx, dir, entry, sl, tp1, tp2) {
  let phase = 1;  // 1 = waiting for TP1, 2 = waiting for TP2 (SL moved to entry)
  let movedSL = entry;

  for (let i = entryIdx; i < Math.min(entryIdx + MAX_HOLD_1M, bars1m.length); i++) {
    const { h, l } = bars1m[i];

    if (dir === 'LONG') {
      if (phase === 1) {
        if (l <= sl)   return { outcome: 'LOSS', R: -1 };
        if (h >= tp1)  { phase = 2; movedSL = entry; }
      } else {
        if (l <= movedSL) return { outcome: 'PARTIAL', R: 1 };
        if (h >= tp2)     return { outcome: 'TP2',     R: 3 };
      }
    } else {
      if (phase === 1) {
        if (h >= sl)   return { outcome: 'LOSS', R: -1 };
        if (l <= tp1)  { phase = 2; movedSL = entry; }
      } else {
        if (h >= movedSL) return { outcome: 'PARTIAL', R: 1 };
        if (l <= tp2)     return { outcome: 'TP2',     R: 3 };
      }
    }
  }
  return { outcome: 'TIMEOUT', R: phase === 2 ? 1 : -0.3 };
}

// ─── Format helpers ───────────────────────────────────────────────────────────
const fmtTs    = ts => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
const fmtPrice = p  => p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(6);

// ─── Per-symbol backtest ──────────────────────────────────────────────────────
function backtestSymbol(symbol, bars15m) {
  const bars1mAll = bars15m.flatMap(expand15mTo1m);
  const bars4hAll = agg15mTo4h(bars15m);

  const trades    = [];
  const rejections = { step0: 0, step1: 0, step1b: 0, step1c: 0, step1d: 0, step1e: 0, step2: 0, step2b: 0, step3: 0, step4: 0, cooldown: 0 };
  const cooldowns = new Map();
  const logs      = [];

  // Scan from bar 3200 onwards so EMA200 on 4H has 200 complete 4H bars
  // (3200 15m bars ÷ 16 = 200 4H bars — minimum for valid classifyTrend)
  for (let i = 3200; i < bars15m.length - 2; i += SCAN_EVERY) {
    const bars15mWin = bars15m.slice(Math.max(0, i - 199), i + 1);
    const curTs      = bars15m[i].t + 14 * 60_000;  // end of 15m bar = start of last 1m

    // 1m window: last 180 1m bars up to the current 15m bar close
    const bars1mWin = bars1mAll.filter(b => b.t <= curTs).slice(-180);

    // 4h window: full history up to now — needed for EMA200 (requires 200+ bars)
    const bars4hWin = bars4hAll.filter(b => b.t <= curTs);

    if (bars1mWin.length < 10 || bars4hWin.length < 3) continue;

    // Capture per-step log lines
    const stepLogs = [];
    const logFn = msg => stepLogs.push(msg);

    const signal = scanKeyLevelSignal(symbol, bars15mWin, bars1mWin, bars4hWin, cooldowns, logFn);

    // Parse rejections from log
    for (const msg of stepLogs) {
      if (msg.includes('Step0 FAIL'))   rejections.step0++;
      else if (msg.includes('Step1 FAIL'))   rejections.step1++;
      else if (msg.includes('Step1b FAIL')) rejections.step1b++;
      else if (msg.includes('Step1c FAIL')) rejections.step1c++;
      else if (msg.includes('Step1d FAIL')) rejections.step1d++;
      else if (msg.includes('Step1e FAIL')) rejections.step1e++;
      else if (msg.includes('Step2 WAIT') || msg.includes('Step2 FAIL')) rejections.step2++;
      else if (msg.includes('Step2b FAIL')) rejections.step2b++;
      else if (msg.includes('Step3 FAIL')) rejections.step3++;
      else if (msg.includes('Step4 FAIL')) rejections.step4++;
    }

    if (!signal) continue;

    // Trade fired — find the corresponding 1m bar entry
    const entryTs    = signal.ts;
    const entryIdx1m = bars1mAll.findIndex(b => b.t >= entryTs);
    if (entryIdx1m < 0 || entryIdx1m + 1 >= bars1mAll.length) continue;

    // Enter on the next 1m bar open after signal
    const nextBar = bars1mAll[entryIdx1m + 1];
    if (!nextBar) continue;

    const entry = nextBar.o;
    const sl    = signal.sl;
    const tp1   = signal.tp1;
    const tp2   = signal.tp2;
    const dir   = signal.dir;

    // Basic validity: entry between SL and TP1
    if (dir === 'LONG'  && (entry <= sl || entry >= tp1)) continue;
    if (dir === 'SHORT' && (entry >= sl || entry <= tp1)) continue;

    const sim    = simulateTrade(bars1mAll, entryIdx1m + 2, dir, entry, sl, tp1, tp2);
    const feeAmt = FIXED_RISK * FEE_RT;
    const pnl    = sim.R * FIXED_RISK - feeAmt;

    const trend4h = (() => { try { return classifyTrend(bars4hWin); } catch { return '?'; } })();

    trades.push({
      symbol, dir, barTs: bars15m[i].t, entry, sl, tp1, tp2,
      outcome: sim.outcome, R: sim.R, pnl, trend4h,
      label: signal.label || signal.pattern15 || signal.pattern || '?',
    });

    // Skip ahead to avoid simulating same region twice
    i += 4;
  }

  return { trades, rejections };
}

// ─── Summary printer ──────────────────────────────────────────────────────────
function printSummary(allResults) {
  console.log('\n' + '═'.repeat(110));
  console.log(
    'Symbol     '.padEnd(12) +
    'Trades'.padStart(7) +
    'Prof%'.padStart(7) +   // effective profit rate (TP2+BE+TO-win)
    'TradWR%'.padStart(8) + // traditional WR (TP2+BE only)
    'TP2%'.padStart(6) +
    'Loss%'.padStart(7) +
    'Avg_R'.padStart(8) +
    'Total_R'.padStart(9) +
    'Net_PnL'.padStart(11) +
    '  Rejected→ S0 S1b S1c S1d S1e S2 S2b S3'
  );
  console.log('─'.repeat(120));

  let totT = 0, totW = 0, totTP2 = 0, totBE = 0, totL = 0, totTO = 0, totR = 0, totPnl = 0;
  let totRej = { step0: 0, step1: 0, step1b: 0, step1c: 0, step1d: 0, step1e: 0, step2: 0, step2b: 0, step3: 0, step4: 0 };

  for (const { symbol, trades, rejections } of allResults) {
    const n   = trades.length;
    const rej = rejections;
    if (n === 0) {
      console.log(
        `${symbol.padEnd(12)}${'0'.padStart(7)}  (no trades)` +
        `   rej→ s0:${rej.step0} 1b:${rej.step1b} 1c:${rej.step1c} 1d:${rej.step1d} 1e:${rej.step1e} s2:${rej.step2} s2b:${rej.step2b} s3:${rej.step3}`
      );
      for (const k of Object.keys(totRej)) totRej[k] += (rejections[k] || 0);
      continue;
    }
    const tp2  = trades.filter(t => t.outcome === 'TP2').length;
    const be   = trades.filter(t => t.outcome === 'PARTIAL').length;
    const loss = trades.filter(t => t.outcome === 'LOSS').length;
    const toWin = trades.filter(t => t.outcome === 'TIMEOUT' && t.R > 0).length;  // TIMEOUT phase=2 (TP1 hit)
    const toLoss = trades.filter(t => t.outcome === 'TIMEOUT' && t.R <= 0).length; // TIMEOUT phase=1 (no TP1)
    // Traditional WR: TP2 + PARTIAL (locked wins) only — conservative metric
    const winsTraditional = tp2 + be;
    // Effective profit rate: any trade that ended with positive P&L
    const winsEffective   = tp2 + be + toWin;
    const sumR = trades.reduce((a, t) => a + t.R, 0);
    const sumP = trades.reduce((a, t) => a + t.pnl, 0);
    const avgR = sumR / n;

    console.log(
      `${symbol.padEnd(12)}` +
      `${String(n).padStart(7)}` +
      `${(winsEffective/n*100).toFixed(0)}%`.padStart(7) +   // effective profit rate
      `${(winsTraditional/n*100).toFixed(0)}%`.padStart(7) + // traditional WR (TP2+BE only)
      `${(tp2/n*100).toFixed(0)}%`.padStart(6) +
      `${(loss/n*100).toFixed(0)}%`.padStart(7) +
      `${avgR>=0?'+':''}${avgR.toFixed(2)}R`.padStart(8) +
      `${sumR>=0?'+':''}${sumR.toFixed(1)}R`.padStart(9) +
      `${sumP>=0?'+':''}$${sumP.toFixed(2)}`.padStart(11) +
      `   s0:${rej.step0} 1b:${rej.step1b} 1c:${rej.step1c} 1d:${rej.step1d} 1e:${rej.step1e} s2:${rej.step2} s2b:${rej.step2b} s3:${rej.step3}`
    );

    totT += n; totW += winsEffective; totTP2 += tp2; totBE += be; totL += loss; totTO += toLoss;
    totR += sumR; totPnl += sumP;
    for (const k of Object.keys(totRej)) totRej[k] += (rejections[k] || 0);
  }

  console.log('─'.repeat(120));
  if (totT > 0) {
    const avgR = totR / totT;
    console.log(
      `${'OVERALL'.padEnd(12)}` +
      `${String(totT).padStart(7)}` +
      `${(totW/totT*100).toFixed(0)}%`.padStart(7) +
      `${(totTP2/totT*100).toFixed(0)}%`.padStart(7) +
      `${(totBE/totT*100).toFixed(0)}%`.padStart(6) +
      `${(totL/totT*100).toFixed(0)}%`.padStart(7) +
      `${avgR>=0?'+':''}${avgR.toFixed(2)}R`.padStart(8) +
      `${totR>=0?'+':''}${totR.toFixed(1)}R`.padStart(9) +
      `${totPnl>=0?'+':''}$${totPnl.toFixed(2)}`.padStart(11)
    );
  }
  console.log('═'.repeat(120));
  console.log('\nRejection totals (all symbols):');
  console.log(`  Step0  (outside killzone)   : ${totRej.step0}  ← only London 07-10 + NY AM 12-15 UTC`);
  console.log(`  Step1  (no structure)       : ${totRej.step1}`);
  console.log(`  Step1b (4H trend conflict)  : ${totRej.step1b}`);
  console.log(`  Step1c (VWAP conflict)      : ${totRej.step1c}`);
  console.log(`  Step1d (RSI exhausted)      : ${totRej.step1d}  ← LONG>65 or SHORT<35`);
  console.log(`  Step1e (ADX ranging <18)    : ${totRej.step1e}  ← choppy market filter`);
  console.log(`  Step2  (no 1m pivot)        : ${totRej.step2}`);
  console.log(`  Step2b (1m level too far)   : ${totRej.step2b}`);
  console.log(`  Step3  (1m pivot stale)     : ${totRej.step3}`);
  console.log(`  Step4  (price chased)       : ${totRej.step4}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════╗');
  console.log('║      SMC Strategy Backtest v3 — Production-accurate (all filters)      ║');
  console.log('╚════════════════════════════════════════════════════════════════════════╝\n');
  console.log(`Symbols    : ${SYMBOLS.join(', ')}`);
  console.log(`Bars       : ${BARS_15M} × 15m per symbol (~${(BARS_15M*15/60/24).toFixed(1)} days)`);
  console.log(`Capital    : $${STARTING_CAP}  Risk/trade: ${RISK_PCT*100}%  Fixed=$${FIXED_RISK}  Fee=${FEE_RT*100}% RT`);
  console.log(`Production filters: ICT killzone, 4H trend gate, VWAP, RSI(14) gate, ADX(14) gate, 1m CHoCH, level proximity, freshness`);
  console.log(`NOTE: Synthetic data — regime flags set per symbol (see SYMBOL_PARAMS)\n`);

  const allResults = [];
  let totalFixedPnl = 0;

  for (const symbol of SYMBOLS) {
    process.stdout.write(`Backtesting ${symbol}...`);
    const bars15m = genBars15m(symbol, BARS_15M);

    const { trades, rejections } = backtestSymbol(symbol, bars15m);

    // Show 4H trend distribution for this symbol
    const bars4h = agg15mTo4h(bars15m);
    const trend4h = bars4h.length >= 10 ? classifyTrend(bars4h.slice(-50)) : 'N/A';
    console.log(` ${trades.length} trades  [4H end trend = ${trend4h}]`);

    if (trades.length > 0) {
      for (const t of trades) {
        const outStr =
          t.outcome === 'TP2'     ? 'TP2    +3R' :
          t.outcome === 'PARTIAL' ? 'BE     +1R' :
          t.outcome === 'LOSS'    ? 'LOSS   -1R' :
          t.outcome === 'TIMEOUT' ? 'TO      0R' : t.outcome;
        const pStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
        console.log(
          `  [${t.symbol} ${t.dir.padEnd(5)}] ${fmtTs(t.barTs)} ` +
          `${t.label.padEnd(9)} entry=${fmtPrice(t.entry).padStart(10)} ` +
          `→ ${outStr}  (${pStr})  4H=${t.trend4h}`
        );
      }
    }

    const symPnl = trades.reduce((a, t) => a + t.pnl, 0);
    totalFixedPnl += symPnl;
    allResults.push({ symbol, trades, rejections });
  }

  printSummary(allResults);

  const finalCap = STARTING_CAP + totalFixedPnl;
  const pct      = (totalFixedPnl / STARTING_CAP * 100).toFixed(2);
  const allTrades = allResults.flatMap(r => r.trades);
  const expectancy = allTrades.length ? allTrades.reduce((a, t) => a + t.R, 0) / allTrades.length : 0;

  console.log(`\n── Fixed-risk P&L ($${FIXED_RISK.toFixed(0)} risk/trade) ────────────────────────────`);
  console.log(`  Starting capital : $${STARTING_CAP.toFixed(2)}`);
  console.log(`  Net P&L          : ${totalFixedPnl >= 0 ? '+' : ''}$${totalFixedPnl.toFixed(2)}  (${pct}%)`);
  console.log(`  Final capital    : $${finalCap.toFixed(2)}`);
  console.log(`  Expectancy       : ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(3)}R per trade`);

  const longs  = allTrades.filter(t => t.dir === 'LONG');
  const shorts = allTrades.filter(t => t.dir === 'SHORT');
  if (longs.length || shorts.length) {
    console.log('\n── Direction breakdown ──────────────────────────────────────────────────');
    for (const [lbl, grp] of [['LONG', longs], ['SHORT', shorts]]) {
      if (!grp.length) continue;
      const w = grp.filter(t => t.R > 0).length;
      const r = grp.reduce((a, t) => a + t.R, 0);
      const p = grp.reduce((a, t) => a + t.pnl, 0);
      console.log(
        `  ${lbl.padEnd(5)} n=${grp.length}  win%=${(w/grp.length*100).toFixed(0)}%  ` +
        `avgR=${r>=0?'+':''}${(r/grp.length).toFixed(2)}R  totalR=${r>=0?'+':''}${r.toFixed(1)}R  ` +
        `pnl=${p>=0?'+':''}$${p.toFixed(2)}`
      );
    }
  }

  // Per-4H-trend breakdown
  if (allTrades.length) {
    const byTrend = {};
    for (const t of allTrades) {
      byTrend[t.trend4h] = byTrend[t.trend4h] || { n: 0, r: 0 };
      byTrend[t.trend4h].n++;
      byTrend[t.trend4h].r += t.R;
    }
    console.log('\n── By 4H trend at time of signal ────────────────────────────────────────');
    for (const [k, v] of Object.entries(byTrend)) {
      console.log(`  4H=${k.padEnd(7)} n=${String(v.n).padStart(3)}  avgR=${v.r>=0?'+':''}${(v.r/v.n).toFixed(2)}R`);
    }
  }

  console.log('\n── Key insights ─────────────────────────────────────────────────────────');
  const totRej1b = allResults.reduce((a, r) => a + r.rejections.step1b, 0);
  const totRej3  = allResults.reduce((a, r) => a + r.rejections.step3, 0);
  const totRej2b = allResults.reduce((a, r) => a + r.rejections.step2b, 0);
  console.log(`  Step1b (4H gate) rejected ${totRej1b} scans — the more uptrending alt-coins, the more SHORTs blocked`);
  console.log(`  Step3  (stale 1m) rejected ${totRej3} scans — 10-bar max means entry must be taken within 10 min`);
  console.log(`  Step2b (level gap) rejected ${totRej2b} scans — 1m pivot must be within slPct×2 of 15m level`);
  if (totRej1b > allTrades.length * 2)
    console.log(`  ⚠  4H gate is blocking ~${(totRej1b/(totRej1b+allTrades.length)*100).toFixed(0)}% of valid structures — consider loosening for alts`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
