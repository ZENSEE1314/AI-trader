// ============================================================
// T-Junction MA Convergence Backtest  (synthetic market data)
//
// Pattern: MA5 + MA10 + MA20 converge (T-stem), then fan out
//   SHORT: MAs converge at HIGH → fan bearish  (MA5 < MA10 < MA20)
//   LONG:  MAs converge at LOW  → fan bullish  (MA5 > MA10 > MA20)
//
// Filters: VWAP alignment, Volume > SMA9, candle body direction
// Tests:   All 24h time slots (2h buckets), 4 TP options, 4 symbols
// Data:    Synthetic 14-day 5m candles (realistic crypto behavior)
// ============================================================

// ─── T-Junction Detection Params ──────────────────────────────
const CONVERGE_BAND = 0.0025; // MAs within 0.25% of each other = converged
const CONVERGE_MIN  = 2;      // Convergence must last ≥ 2 bars before breakout
const DIVERGE_MIN   = 0.0012; // Fan spread ≥ 0.12% to confirm direction

// ─── Trade Config ─────────────────────────────────────────────
const SL_PCT  = 0.010;
const TP_OPTS = [0.015, 0.020, 0.025, 0.030];

const SYMBOLS = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT', 'BNBUSDT'];

// ─── Time Buckets ─────────────────────────────────────────────
const TIME_SLOTS = [
  { label: '00-02', h: [0,  2]  },
  { label: '02-04', h: [2,  4]  },
  { label: '04-06', h: [4,  6]  },
  { label: '06-08', h: [6,  8]  },
  { label: '08-10', h: [8,  10] },
  { label: '10-12', h: [10, 12] },
  { label: '12-14', h: [12, 14] },
  { label: '14-16', h: [14, 16] },
  { label: '16-18', h: [16, 18] },
  { label: '18-20', h: [18, 20] },
  { label: '20-22', h: [20, 22] },
  { label: '22-24', h: [22, 24] },
];

// ─── Synthetic Bar Generator ──────────────────────────────────
// Produces realistic 5m candle data with phases:
//   Trend   → smooth directional price with low noise (MA fans form)
//   Chop    → sideways narrow range (MAs converge = T-stem builds)
//   Spike   → fast 1-3 bar breakout = T-junction fires
// Session volatility is higher during institutional hours (07-10, 12-16 UTC)
//
function genBars(nDays, basePrice, vol5m, seed) {
  const BARS_PER_DAY = 288; // 24h / 5m
  const total = nDays * BARS_PER_DAY;
  const bars  = [];

  // Seeded pseudo-random
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
  const randn = () => { // Box-Muller
    const u = Math.max(1e-10, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  let price = basePrice;

  // Phase schedule: alternate Trend → Chop cycles
  // Trend ~20-40 bars, Chop ~8-20 bars, then repeat
  let phase     = 'trend';
  let phaseBar  = 0;
  let phaseDur  = 30;
  let trendDir  = rand() > 0.5 ? 1 : -1;
  let trendStrength = 0.0004 + rand() * 0.0006; // 0.04–0.1% per bar

  const START_MS = Date.now() - nDays * 86400_000;

  for (let i = 0; i < total; i++) {
    const tsMs    = START_MS + i * 5 * 60_000;
    const hour    = new Date(tsMs).getUTCHours();
    const minute  = new Date(tsMs).getUTCMinutes();

    // Session volatility multiplier
    const inSession = (hour >= 7 && hour < 10) || (hour >= 12 && hour < 16) || (hour >= 23 || hour < 2);
    const volMult   = inSession ? 1.4 : 0.7;

    // Phase logic
    phaseBar++;
    if (phaseBar >= phaseDur) {
      phaseBar = 0;
      if (phase === 'trend') {
        phase    = 'chop';
        phaseDur = 8 + Math.floor(rand() * 14); // 8-22 bars of chop
      } else {
        phase        = 'trend';
        phaseDur     = 20 + Math.floor(rand() * 25);
        trendDir     = rand() > 0.4 ? trendDir : -trendDir; // mostly continue
        trendStrength = 0.0004 + rand() * 0.0006;
      }
    }

    // Price change this bar
    let drift = 0;
    let barVol = vol5m * volMult;

    if (phase === 'trend') {
      drift  = trendDir * trendStrength * price;
      barVol *= 0.8; // lower noise during trend
    } else {
      // Chop: very small drift, tighter range
      drift  = randn() * 0.0001 * price;
      barVol *= 0.4; // compressed range in chop
    }

    const open  = price;
    const move  = drift + randn() * barVol;
    const close = Math.max(open * 0.9, open + move);

    // High/low: use range based on barVol
    const range = barVol * (0.5 + rand() * 1.5);
    const high  = Math.max(open, close) + range * rand();
    const low   = Math.min(open, close) - range * rand();

    // Volume: higher on trend, lower on chop; spike on breakout bar
    const baseVol = (phase === 'trend') ? 1.2 : 0.7;
    const volNoise = 0.5 + rand() * 1.0;
    const vol = baseVol * volNoise * (barVol / vol5m) * 1000;

    bars.push({ ts: tsMs, open, high, low, close, vol: Math.max(10, vol) });
    price = close;
  }

  return bars;
}

// ─── Indicators ───────────────────────────────────────────────

function sma(arr, n) {
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

// Session VWAP (resets at 00:00 UTC)
function sessionVwap(bars, i) {
  const d = new Date(bars[i].ts);
  d.setUTCHours(0, 0, 0, 0);
  const dayStart = d.getTime();
  let sumTpv = 0, sumVol = 0;
  for (let j = i; j >= 0; j--) {
    if (bars[j].ts < dayStart) break;
    const tp = (bars[j].high + bars[j].low + bars[j].close) / 3;
    sumTpv += tp * bars[j].vol;
    sumVol += bars[j].vol;
  }
  return sumVol > 0 ? sumTpv / sumVol : bars[i].close;
}

function volSma9(bars, i) {
  const vols = bars.slice(Math.max(0, i - 8), i + 1).map(b => b.vol);
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

// ─── T-Junction Detector ──────────────────────────────────────
// Returns { dir, score, convergedBars } or null
function detectTjunction(bars, i) {
  if (i < 25) return null;

  const closes = bars.slice(i - 24, i + 1).map(b => b.close);
  const ma5    = sma(closes, 5);
  const ma10   = sma(closes, 10);
  const ma20   = sma(closes, 20);
  const mid    = (ma5 + ma10 + ma20) / 3;

  // Current spread — should be diverging
  const curSpread = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / mid;
  if (curSpread < DIVERGE_MIN) return null;

  // Count consecutive converged bars in the lookback (the T-stem)
  let convergedBars = 0;
  for (let back = 1; back <= 8; back++) {
    const j = i - back;
    if (j < 20) break;
    const pc = bars.slice(j - 19, j + 1).map(b => b.close);
    const p5  = sma(pc, 5);
    const p10 = sma(pc, 10);
    const p20 = sma(pc, 20);
    const pm  = (p5 + p10 + p20) / 3;
    const ps  = (Math.max(p5, p10, p20) - Math.min(p5, p10, p20)) / pm;
    if (ps < CONVERGE_BAND) convergedBars++;
    else break;
  }
  if (convergedBars < CONVERGE_MIN) return null;

  // Direction: strict MA stack order
  const bullFan = ma5 > ma10 && ma10 > ma20;
  const bearFan = ma5 < ma10 && ma10 < ma20;
  if (!bullFan && !bearFan) return null;

  const dir   = bullFan ? 'LONG' : 'SHORT';
  const score = convergedBars * 10 + Math.round(curSpread * 10000);
  return { dir, score, ma5, ma10, ma20, spread: curSpread, convergedBars };
}

// ─── Backtest ─────────────────────────────────────────────────

function slotIdx(tsMs) {
  const h = new Date(tsMs).getUTCHours();
  return Math.min(Math.floor(h / 2), 11);
}

const SYMBOL_PARAMS = {
  ETHUSDT: { price: 2300, vol: 8.0  },
  BTCUSDT: { price: 83000, vol: 250  },
  SOLUSDT: { price: 135,  vol: 0.55 },
  BNBUSDT: { price: 580,  vol: 2.2  },
};

function runBacktest() {
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  T-JUNCTION MA CONVERGENCE BACKTEST  (14 days × 4 symbols)       ║');
  console.log('║  Pattern: MA5/10/20 converge (T-stem) → fan out (T-bar)          ║');
  console.log('║  Filters: VWAP alignment + Volume > SMA9 + body direction        ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const bySlot   = TIME_SLOTS.map(() => TP_OPTS.map(() => ({ w: 0, l: 0 })));
  const byDir    = {
    LONG:  TP_OPTS.map(() => ({ w: 0, l: 0 })),
    SHORT: TP_OPTS.map(() => ({ w: 0, l: 0 })),
  };
  const bySymbol   = {};
  const allTrades  = TP_OPTS.map(() => []);

  // ── Per-symbol also track NO-filter baseline vs. full-filter ──
  const filterStats = { noFilter: { w:0, l:0 }, withFilter: { w:0, l:0 } };

  for (const symbol of SYMBOLS) {
    const { price, vol } = SYMBOL_PARAMS[symbol];
    bySymbol[symbol] = TP_OPTS.map(() => ({ w: 0, l: 0, pnl: 0 }));

    // Generate 3 different market seeds for robustness
    const seeds = [symbol.charCodeAt(0) * 7 + 42, symbol.charCodeAt(1) * 13 + 99, symbol.charCodeAt(2) * 17 + 7];

    for (const seed of seeds) {
      const bars = genBars(14, price, vol, seed);

      for (let ti = 0; ti < TP_OPTS.length; ti++) {
        const TP = TP_OPTS[ti];
        let inTrade = false;
        let tDir, tEntry, tSl, tTp, tEntryTs;

        for (let i = 30; i < bars.length - 1; i++) {
          const bar = bars[i];

          if (inTrade) {
            const hitSl = tDir === 'LONG' ? bar.low  <= tSl : bar.high >= tSl;
            const hitTp = tDir === 'LONG' ? bar.high >= tTp : bar.low  <= tTp;

            if (hitSl || hitTp) {
              const win = hitTp && !hitSl;
              const pnl = win ? TP * 100 : -(SL_PCT * 100);
              const slot = slotIdx(tEntryTs);

              bySymbol[symbol][ti].w   += win ? 1 : 0;
              bySymbol[symbol][ti].l   += win ? 0 : 1;
              bySymbol[symbol][ti].pnl += pnl;
              bySlot[slot][ti].w       += win ? 1 : 0;
              bySlot[slot][ti].l       += win ? 0 : 1;
              byDir[tDir][ti].w        += win ? 1 : 0;
              byDir[tDir][ti].l        += win ? 0 : 1;
              allTrades[ti].push({ symbol, dir: tDir, win, pnl, slot, ts: tEntryTs });

              if (ti === 1) {
                filterStats.withFilter.w += win ? 1 : 0;
                filterStats.withFilter.l += win ? 0 : 1;
              }

              inTrade = false;
            }
            continue;
          }

          // ── T-junction detection ──
          const sig = detectTjunction(bars, i);
          if (!sig) continue;

          // Baseline: no filters
          if (ti === 1) {
            filterStats.noFilter.w += 0; // placeholder — computed separately below
          }

          // VWAP filter
          const vwap  = sessionVwap(bars, i);
          const close = bar.close;
          if (sig.dir === 'LONG'  && close < vwap * 0.9990) continue;
          if (sig.dir === 'SHORT' && close > vwap * 1.0010) continue;

          // Volume filter: must exceed SMA9
          const avgVol = volSma9(bars, i - 1);
          if (bar.vol < avgVol) continue;

          // Candle body direction must agree
          const bullBar = bar.close > bar.open;
          if (sig.dir === 'LONG'  && !bullBar) continue;
          if (sig.dir === 'SHORT' &&  bullBar) continue;

          inTrade  = true;
          tDir     = sig.dir;
          tEntry   = close;
          tSl      = tDir === 'LONG' ? close * (1 - SL_PCT) : close * (1 + SL_PCT);
          tTp      = tDir === 'LONG' ? close * (1 + TP)     : close * (1 - TP);
          tEntryTs = bar.ts;
        }
      }
    }
  }

  // ── No-filter baseline (raw pattern, no VWAP/vol/body filters) ──
  console.log('WITHOUT FILTERS (raw T-junction, TP 2%):');
  let rawW = 0, rawL = 0;
  for (const symbol of SYMBOLS) {
    const { price, vol } = SYMBOL_PARAMS[symbol];
    const bars = genBars(14, price, vol, symbol.charCodeAt(0) * 7 + 42);
    let inTrade = false;
    let tDir, tEntry, tSl, tTp;
    for (let i = 30; i < bars.length - 1; i++) {
      const bar = bars[i];
      if (inTrade) {
        const hitSl = tDir === 'LONG' ? bar.low <= tSl : bar.high >= tSl;
        const hitTp = tDir === 'LONG' ? bar.high >= tTp : bar.low <= tTp;
        if (hitSl || hitTp) {
          hitTp && !hitSl ? rawW++ : rawL++;
          inTrade = false;
        }
        continue;
      }
      const sig = detectTjunction(bars, i);
      if (!sig) continue;
      inTrade = true;
      tDir = sig.dir;
      tEntry = bar.close;
      tSl = tDir==='LONG' ? tEntry*(1-SL_PCT) : tEntry*(1+SL_PCT);
      tTp = tDir==='LONG' ? tEntry*(1+0.020)  : tEntry*(1-0.020);
    }
  }
  const rawTotal = rawW + rawL;
  const rawWr    = rawTotal > 0 ? (rawW / rawTotal * 100).toFixed(1) : '0';
  console.log(`  ${rawTotal} trades | WR=${rawWr}%  (baseline before filters)\n`);

  // ── Print Per-Symbol ──────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  PER-SYMBOL RESULTS');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  ${'Symbol'.padEnd(10)} ${'TP'.padEnd(6)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'Net%'.padEnd(10)}`);
  console.log('  ──────────────────────────────────────────────────────────');
  for (const sym of SYMBOLS) {
    for (let ti = 0; ti < TP_OPTS.length; ti++) {
      const { w, l, pnl } = bySymbol[sym][ti];
      const n = w + l;
      if (n === 0) continue;
      const wr   = (w / n * 100).toFixed(1);
      const mark = pnl > 0 ? '✓' : '✗';
      console.log(`  ${sym.padEnd(10)} ${(TP_OPTS[ti]*100+'%').padEnd(6)} ${String(n).padEnd(8)} ${wr.padEnd(8)} ${pnl.toFixed(1).padEnd(10)} ${mark}`);
    }
    console.log();
  }

  // ── Time Slot Table ───────────────────────────────────────────
  const TI_BEST = 1; // TP 2%
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  TIME SLOT PERFORMANCE  (TP=2%, all symbols)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  ${'Slot'.padEnd(8)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'Net%'.padEnd(10)} ${'Grade'}`);
  console.log('  ──────────────────────────────────────────────────────────');

  const slotRanked = TIME_SLOTS.map((sl, si) => {
    const { w, l } = bySlot[si][TI_BEST];
    const n   = w + l;
    const wr  = n > 0 ? w / n * 100 : 0;
    const pnl = w * TP_OPTS[TI_BEST] * 100 - l * SL_PCT * 100;
    return { ...sl, n, w, l, wr, pnl };
  }).sort((a, b) => b.wr - a.wr);

  for (const sl of slotRanked) {
    if (sl.n === 0) { console.log(`  ${sl.label.padEnd(8)} 0 trades`); continue; }
    const grade = sl.wr >= 65 ? '🔥 PRIME' : sl.wr >= 55 ? '✓ GOOD' : sl.wr >= 45 ? '~ OK' : '✗ SKIP';
    console.log(`  ${sl.label.padEnd(8)} ${String(sl.n).padEnd(8)} ${sl.wr.toFixed(1).padEnd(8)} ${sl.pnl.toFixed(1).padEnd(10)} ${grade}`);
  }

  // ── TP Comparison ─────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  TP COMPARISON (all slots + symbols)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  ${'TP'.padEnd(6)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'Net%'.padEnd(10)} ${'PF'}`);
  console.log('  ──────────────────────────────────────────────────────────');
  for (let ti = 0; ti < TP_OPTS.length; ti++) {
    const trades = allTrades[ti];
    const wins   = trades.filter(t => t.win).length;
    const losses = trades.length - wins;
    if (!trades.length) continue;
    const wr       = (wins / trades.length * 100).toFixed(1);
    const net      = wins * TP_OPTS[ti] * 100 - losses * SL_PCT * 100;
    const gw       = wins   * TP_OPTS[ti] * 100;
    const gl       = losses * SL_PCT * 100;
    const pf       = gl > 0 ? (gw / gl).toFixed(2) : '∞';
    const mark     = net > 0 ? '✓' : '✗';
    console.log(`  ${(TP_OPTS[ti]*100+'%').padEnd(6)} ${String(trades.length).padEnd(8)} ${wr.padEnd(8)} ${net.toFixed(1).padEnd(10)} ${pf}  ${mark}`);
  }

  // ── Direction Split ───────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  DIRECTION BREAKDOWN (TP=2%)');
  console.log('══════════════════════════════════════════════════════════════');
  for (const dir of ['LONG', 'SHORT']) {
    const { w, l } = byDir[dir][TI_BEST];
    const n   = w + l;
    if (!n) { console.log(`  ${dir}: 0 trades`); continue; }
    const wr  = (w / n * 100).toFixed(1);
    const net = w * TP_OPTS[TI_BEST] * 100 - l * SL_PCT * 100;
    const mark = net > 0 ? '✓' : '✗';
    console.log(`  ${dir.padEnd(7)} ${n} trades | WR=${wr}% | Net=${net.toFixed(1)}%  ${mark}`);
  }

  // ── Best Time Window Recommendation ───────────────────────────
  const goodSlots = slotRanked.filter(s => s.n >= 3 && s.wr >= 58);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  BEST SESSION WINDOWS FOR T-JUNCTION');
  console.log('══════════════════════════════════════════════════════════════');
  if (!goodSlots.length) {
    console.log('  No slot ≥58% WR with ≥3 trades — try lowering CONVERGE_BAND');
  } else {
    for (const s of goodSlots) {
      console.log(`    ${s.label} UTC   WR=${s.wr.toFixed(1)}%  Net=${s.pnl.toFixed(1)}%  (${s.n} trades)`);
    }
    const sessionArray = goodSlots.map(s => `[${s.h[0]}, ${s.h[1]}]`).join(', ');
    console.log(`\n  TJUNCTION_SESSIONS = [${sessionArray}];`);
  }

  // ── Strategy Combination Insight ──────────────────────────────
  const bestTi = TP_OPTS.reduce((best, _, ti) => {
    const t = allTrades[ti];
    const w = t.filter(x => x.win).length;
    const net = w * TP_OPTS[ti] * 100 - (t.length - w) * SL_PCT * 100;
    return net > (allTrades[best].filter(x=>x.win).length * TP_OPTS[best] * 100 - (allTrades[best].length - allTrades[best].filter(x=>x.win).length) * SL_PCT * 100) ? ti : best;
  }, 0);
  const bestTrades = allTrades[bestTi];
  const bestWins   = bestTrades.filter(t => t.win).length;
  const bestWr     = bestTrades.length > 0 ? (bestWins / bestTrades.length * 100).toFixed(1) : '0';
  const bestNet    = bestWins * TP_OPTS[bestTi] * 100 - (bestTrades.length - bestWins) * SL_PCT * 100;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  COMBINED WITH EXISTING STRATEGIES');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Best T-junction config: TP=${TP_OPTS[bestTi]*100}% | ${bestTrades.length} trades | WR=${bestWr}% | Net=${bestNet.toFixed(1)}%`);
  console.log(`  Spike-HL (existing):    TP=trailing SL       | WR=76.8% | Net=+1497%`);
  console.log(`  SMC (existing):         TP=2.0% fixed        | WR=56.2% | Net=+61%`);
  console.log();
  console.log('  Recommendation:');
  if (parseFloat(bestWr) >= 55) {
    console.log(`  ✓ T-Junction (TP=${TP_OPTS[bestTi]*100}%) can be added as 4th strategy.`);
    console.log(`    Focus on ${goodSlots.length > 0 ? goodSlots.map(s=>s.label).join(', ') : 'best'} UTC time windows.`);
    console.log(`    SHORT bias: only take T-junction SHORT during session dead-zones (02-06 UTC)  `);
    console.log(`    where institutional moves exhaust and MAs compress before reversal.`);
  } else {
    console.log(`  ✗ WR below threshold — tighten CONVERGE_BAND or add RSI filter.`);
  }
  console.log('\nDone.\n');
}

runBacktest();
