'use strict';

// ============================================================
// Spike-HL Liquidity Sweep Backtest v2
//
// The pattern (ICT/SMC liquidity sweep):
//   1. Uptrend: price making Higher Lows (HL1, HL2, HL3...)
//   2. One candle's LOW spikes BELOW the previous HL
//   3. That candle CLOSES BACK ABOVE the previous HL
//   → Stops below the HL are swept, smart money fills longs
//   → Price rockets from the spike bottom
//
// Entry models:
//   A) LIMIT at prev-HL level (filled during spike, best price)
//   B) MARKET at close of spike candle (detectable in real-time)
//
// SL: below the spike candle's LOW (last lower candle)
// Exit:
//   - Trail SL to each rising candle's low
//   - Compare vs fixed TP exits
// ============================================================

const SYMBOLS = [
  { name: 'BTCUSDT', leverage: 100, vol: 0.0040 },
  { name: 'ETHUSDT', leverage: 100, vol: 0.0050 },
  { name: 'SOLUSDT', leverage: 20,  vol: 0.0070 },
  { name: 'BNBUSDT', leverage: 20,  vol: 0.0040 },
];

const N_BARS     = 20000; // ~14 days of 1m bars
const EMA_PERIOD = 200;
const MAX_HOLD   = 300;
const MAX_PER_DAY = 5;
const SESSIONS   = [[23, 26], [7, 10], [12, 16]];
const AVOID_MIN  = new Set([0, 15, 30, 45]);

// Pattern thresholds
const MIN_SPIKE_BELOW_HL = 0.0015; // spike must pierce ≥ 0.15% below prev HL
const MAX_SPIKE_BELOW_HL = 0.015;  // but not more than 1.5% (outlier crash, not sweep)
const MIN_WICK_RATIO     = 1.2;    // lower wick ≥ 1.2× body
const SL_BUFFER          = 0.001;  // SL = spike_low × (1 - 0.1%) buffer

// ─── Synthetic OHLCV with embedded sweep candles ─────────────
// Generates a realistic uptrend with periodic liquidity sweeps:
// every SWEEP_INTERVAL bars during the uptrend phase, inject a
// spike candle that overshoots the prev low then recovers.

function genBars(n, vol, base) {
  const SWEEP_INTERVAL = 25; // inject a sweep event every ~25 bars in uptrend
  const bars = [];
  let price = base;

  // Alternating phases: uptrend 300 bars, sideways 80 bars, downtrend 300 bars, sideways 80 bars
  const phases  = [300, 80, 300, 80];
  const drifts  = [+0.00020, 0.00002, -0.00020, -0.00002];
  let ph = 0, phBar = 0;

  for (let i = 0; i < n; i++) {
    if (phBar >= phases[ph % 4]) { ph++; phBar = 0; }
    phBar++;

    const isUptrend = (ph % 4) === 0;
    const drift = drifts[ph % 4];
    const noise = vol * (Math.random() * 2 - 1);
    const open  = price;
    const close = Math.max(open * (1 + drift + noise), 0.00001);
    const body  = Math.abs(close - open);

    let high, low;

    // In uptrend, periodically inject a liquidity sweep spike
    if (isUptrend && phBar % SWEEP_INTERVAL === 0 && phBar > 5) {
      // Spike: wick down 0.25–1.2% below the open, then close near high
      const spikeDepth = 0.0025 + Math.random() * 0.0095;
      const spikeClose = Math.max(open, close) * (1 - Math.random() * 0.001); // close near top
      low  = open * (1 - spikeDepth);
      high = spikeClose * (1 + Math.random() * 0.0005);
      bars.push({ ts: Date.now() - (n - i) * 60000, open, high, low, close: spikeClose, isSweep: true });
      price = spikeClose;
    } else {
      high = Math.max(open, close) + body * (0.1 + Math.random() * 0.5);
      low  = Math.min(open, close) - body * (0.1 + Math.random() * 0.5);
      bars.push({ ts: Date.now() - (n - i) * 60000, open, high, low, close, isSweep: false });
      price = close;
    }
  }
  return bars;
}

// ─── EMA ─────────────────────────────────────────────────────
function ema(bars, p) {
  const k = 2 / (p + 1);
  const out = new Array(bars.length).fill(null);
  let v = bars[0].close;
  for (let i = 0; i < bars.length; i++) {
    v = bars[i].close * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

// ─── Session Gate ─────────────────────────────────────────────
function inSession(ts) {
  const d = new Date(ts), h = d.getUTCHours(), m = d.getUTCMinutes();
  if (AVOID_MIN.has(m)) return false;
  for (const [s, e] of SESSIONS) {
    if (e <= 24) { if (h >= s && h < e) return true; }
    else         { if (h >= s || h < e - 24) return true; }
  }
  return false;
}

// ─── Spike-HL Detector ───────────────────────────────────────
// Looks at bars[i-1] (prev HL candle) and bars[i] (spike candle):
//   bars[i-1].low = prevHL   — the higher-low level
//   bars[i].low   = spikeLow — spiked BELOW prevHL
//   bars[i].close > prevHL  — closed BACK ABOVE (rejection)
//   lower wick > MIN_WICK_RATIO × body (spike, not just a drop)

function detectSpike(bars, i) {
  if (i < 4) return null;

  // Find the prevHL: scan back up to 5 bars for a clear local low
  // that is HIGHER than the bar before it (confirmed Higher Low)
  let prevHL = null;
  let prevHL_idx = -1;
  for (let back = 1; back <= 5; back++) {
    const c = bars[i - back];
    const cPrev = bars[i - back - 1];
    if (!c || !cPrev) continue;
    if (c.low > cPrev.low) { // c.low is a Higher Low vs cPrev
      prevHL = c.low;
      prevHL_idx = i - back;
      break;
    }
  }
  if (!prevHL) return null;

  const spike = bars[i];

  // Spike must pierce BELOW the prevHL
  if (spike.low >= prevHL) return null;
  const spikeDepth = (prevHL - spike.low) / prevHL;
  if (spikeDepth < MIN_SPIKE_BELOW_HL) return null; // too small — noise
  if (spikeDepth > MAX_SPIKE_BELOW_HL) return null; // too big — crash, not sweep

  // Close must be BACK ABOVE the prevHL (rejection confirmed)
  if (spike.close <= prevHL) return null;

  // Wick ratio check: lower wick vs body
  const body      = Math.abs(spike.close - spike.open);
  const lowerWick = Math.min(spike.open, spike.close) - spike.low;
  if (body < 0.000001) return null;
  if (lowerWick < MIN_WICK_RATIO * body) return null;

  // SL = just below the spike low
  const slLevel = spike.low * (1 - SL_BUFFER);

  return {
    spikeLow:   spike.low,      // Model A entry (limit order)
    closeEntry: spike.close,    // Model B entry (market at close)
    prevHL,
    prevHL_idx,
    slLevel,
    spikeDepth,                 // how deep the spike went
    wickSize:   lowerWick / (spike.high - spike.low), // wick as % of range
  };
}

// ─── Trailing SL exit ─────────────────────────────────────────
// Trail SL to each rising candle's LOW (if above entry).
// Exit when low ≤ current SL.
function simulateTrade(bars, entryBar, entry, sl, startI) {
  let curSl = sl;
  let peak  = entry;

  for (let j = startI + 1; j < Math.min(startI + MAX_HOLD, bars.length); j++) {
    const bar = bars[j];
    peak = Math.max(peak, bar.high);

    // Trail SL: move to just below this candle's low IF it forms a higher low
    // (bar.low > prev bar.low && bar.low > entry)
    if (j > startI + 1) {
      const prevLow = bars[j - 1].low;
      if (bar.low > prevLow && bar.low > entry && bar.low > curSl) {
        curSl = bar.low * (1 - SL_BUFFER);
      }
    }

    // Check SL hit
    if (bar.low <= curSl) {
      const exitPrice = curSl;
      const pnl = (exitPrice - entry) / entry;
      return { pnl, peak, exitBar: j, bars_held: j - startI };
    }
  }

  // Force-close at MAX_HOLD
  const exitPrice = bars[Math.min(startI + MAX_HOLD, bars.length - 1)].close;
  return { pnl: (exitPrice - entry) / entry, peak, exitBar: startI + MAX_HOLD, bars_held: MAX_HOLD };
}

// ─── Run Backtest ─────────────────────────────────────────────
function runBacktest(bars, ema200, entryModel, exitMode, tpPct) {
  const trades = [], days = {};
  let activeUntil = 0; // no overlapping trades

  for (let i = EMA_PERIOD + 6; i < bars.length - MAX_HOLD - 1; i++) {
    if (i <= activeUntil) continue;
    if (!inSession(bars[i].ts)) continue;

    const day = new Date(bars[i].ts).toISOString().slice(0, 10);
    if ((days[day] ?? 0) >= MAX_PER_DAY) continue;

    // EMA200: bullish bias required
    const e200 = ema200[i];
    if (!e200 || bars[i].close < e200 * 0.993) continue;

    const sig = detectSpike(bars, i);
    if (!sig) continue;

    // Entry price
    const entry = entryModel === 'A' ? sig.spikeLow : sig.closeEntry;
    if (entry <= 0 || sig.slLevel >= entry) continue;

    let result;
    if (exitMode === 'trail') {
      result = simulateTrade(bars, i, entry, sig.slLevel, i);
    } else {
      // Fixed TP simulation
      const tp = entry * (1 + tpPct);
      let pnl = null, exitBar = i + MAX_HOLD;
      for (let j = i + 1; j < Math.min(i + MAX_HOLD, bars.length); j++) {
        if (bars[j].low  <= sig.slLevel) { pnl = (sig.slLevel - entry) / entry; exitBar = j; break; }
        if (bars[j].high >= tp)          { pnl = tpPct; exitBar = j; break; }
      }
      if (pnl === null) pnl = (bars[exitBar].close - entry) / entry;
      result = { pnl, peak: tp, exitBar, bars_held: exitBar - i };
    }

    const slDist = (entry - sig.slLevel) / entry;
    const out    = result.pnl > 0 ? 'W' : 'L';
    const rr     = slDist > 0 ? result.pnl / slDist : 0;

    trades.push({
      out,
      pnl:        result.pnl,
      slDist,
      spikeDepth: sig.spikeDepth,
      wickSize:   sig.wickSize,
      rr,
      bars_held:  result.bars_held,
    });

    activeUntil = result.exitBar;
    days[day] = (days[day] ?? 0) + 1;
  }
  return trades;
}

// ─── Stats ───────────────────────────────────────────────────
function st(trades) {
  if (!trades.length) return null;
  const W = trades.filter(t => t.out === 'W');
  const L = trades.filter(t => t.out === 'L');
  const gW  = W.reduce((s, t) => s + t.pnl, 0);
  const gL  = L.reduce((s, t) => s + Math.abs(t.pnl), 0);
  const maxW = W.length ? Math.max(...W.map(t => t.pnl)) : 0;
  const avgRR = trades.reduce((s, t) => s + t.rr, 0) / trades.length;
  const avgSlDist = trades.reduce((s, t) => s + t.slDist, 0) / trades.length;
  return {
    total:    trades.length,
    wins:     W.length,
    losses:   L.length,
    wr:       (W.length / trades.length * 100).toFixed(1),
    pf:       gL > 0 ? (gW / gL).toFixed(2) : '∞',
    net:      (trades.reduce((s, t) => s + t.pnl, 0) * 100).toFixed(2),
    avgW:     W.length ? (gW / W.length * 100).toFixed(3) : '0',
    avgL:     L.length ? (gL / L.length * 100).toFixed(3) : '0',
    maxW:     (maxW * 100).toFixed(3),
    avgRR:    avgRR.toFixed(2),
    avgSlDist:(avgSlDist * 100).toFixed(3),
  };
}

// ─── Main ─────────────────────────────────────────────────────
function main() {
  console.log('');
  console.log('╔═════════════════════════════════════════════════════════════════════════╗');
  console.log('║  SPIKE-HL LIQUIDITY SWEEP BACKTEST v2  (14 days × 4 symbols)          ║');
  console.log('╚═════════════════════════════════════════════════════════════════════════╝');
  console.log('Pattern: prev-HL spike-below + close-above (liquidity sweep rejection)');
  console.log('SL: just below the spike candle LOW (0.1% buffer)');
  console.log('EMA200 bullish bias | Session gate | No overlapping trades');
  console.log('');

  const symData = SYMBOLS.map(s => {
    const bars = genBars(N_BARS, s.vol, 1000);
    const e200 = ema(bars, EMA_PERIOD);
    return { ...s, bars, e200 };
  });

  const configs = [
    { label: 'A-Limit  + Trail SL (candle lows)', model: 'A', exit: 'trail', tp: null },
    { label: 'B-Market + Trail SL (candle lows)', model: 'B', exit: 'trail', tp: null },
    { label: 'B-Market + Fixed TP 1.0%',          model: 'B', exit: 'fixed', tp: 0.010 },
    { label: 'B-Market + Fixed TP 1.5%',          model: 'B', exit: 'fixed', tp: 0.015 },
    { label: 'B-Market + Fixed TP 2.0%',          model: 'B', exit: 'fixed', tp: 0.020 },
    { label: 'B-Market + Fixed TP 3.0%',          model: 'B', exit: 'fixed', tp: 0.030 },
    { label: 'A-Limit  + Fixed TP 1.5%',          model: 'A', exit: 'fixed', tp: 0.015 },
    { label: 'A-Limit  + Fixed TP 2.0%',          model: 'A', exit: 'fixed', tp: 0.020 },
  ];

  // ── Aggregate across all symbols ──
  const agg = configs.map(() => []);
  for (const s of symData) {
    configs.forEach((c, ci) => {
      agg[ci].push(...runBacktest(s.bars, s.e200, c.model, c.exit, c.tp));
    });
  }

  // ── Summary table ──
  console.log('COMBINED RESULTS (4 symbols):');
  const C = [38, 7, 7, 9, 6, 9, 9, 9, 7];
  console.log(['Config','Trades','WR%','Net%','PF','AvgWin%','AvgLoss%','MaxWin%','AvgRR'].map((h,i)=>h.padEnd(C[i])).join(''));
  console.log('─'.repeat(C.reduce((a,b)=>a+b)));

  configs.forEach((c, ci) => {
    const s = st(agg[ci]);
    if (!s) { console.log(c.label.padEnd(C[0]) + '  (no trades)'); return; }
    const wr = parseFloat(s.wr);
    const mark = wr >= 50 ? ' ✓' : '';
    console.log([
      (c.label + mark).padEnd(C[0]),
      String(s.total).padEnd(C[1]),
      (s.wr + '%').padEnd(C[2]),
      ((parseFloat(s.net)>=0?'+':'') + s.net + '%').padEnd(C[3]),
      s.pf.padEnd(C[4]),
      ('+' + s.avgW + '%').padEnd(C[5]),
      ('-' + s.avgL + '%').padEnd(C[6]),
      ('+' + s.maxW + '%').padEnd(C[7]),
      s.avgRR.padEnd(C[8]),
    ].join(''));
  });

  // ── Per-symbol for best config (A-Limit + Trail) ──
  console.log('');
  console.log('PER-SYMBOL — Model A (Limit at spike low) + Trailing SL:');
  console.log('─'.repeat(85));
  for (const s of symData) {
    const trades = runBacktest(s.bars, s.e200, 'A', 'trail', null);
    const r = st(trades);
    if (!r) { console.log(`  ${s.name}: no trades`); continue; }
    const lev = s.leverage;
    const bigWins = trades.filter(t => t.pnl >= 0.01).length; // unlev ≥1% = 100% cap at 100x
    const avgSlPct = (trades.reduce((a, t) => a + t.slDist, 0) / trades.length * 100).toFixed(3);
    const avgSpike = (trades.reduce((a, t) => a + t.spikeDepth, 0) / trades.length * 100).toFixed(3);

    console.log(`  ${s.name.padEnd(10)} x${String(lev).padEnd(4)} | ` +
      `trades=${r.total.toString().padStart(3)} WR=${r.wr.padStart(5)}% PF=${r.pf.padStart(5)} | ` +
      `avgWin=+${r.avgW}% → ${(parseFloat(r.avgW)*lev).toFixed(1)}% leveraged | ` +
      `maxWin=+${r.maxW}% → ${(parseFloat(r.maxW)*lev).toFixed(1)}% leveraged | ` +
      `wins≥1%=${bigWins}`);
    console.log(`  ${''.padEnd(10)}      avgSL=${avgSlPct}% spike=${avgSpike}% avgRR=1:${r.avgRR}`);
  }

  // ── Spike depth distribution ──
  console.log('');
  console.log('SPIKE DEPTH DISTRIBUTION (all symbols, Model A):');
  const allA = [];
  for (const s of symData) allA.push(...runBacktest(s.bars, s.e200, 'A', 'trail', null));
  if (allA.length) {
    const depths = allA.map(t => t.spikeDepth * 100).sort((a, b) => a - b);
    const p25 = depths[Math.floor(depths.length * 0.25)];
    const p50 = depths[Math.floor(depths.length * 0.50)];
    const p75 = depths[Math.floor(depths.length * 0.75)];
    const p90 = depths[Math.floor(depths.length * 0.90)];
    console.log(`  Total sweeps: ${depths.length}`);
    console.log(`  p25=${p25?.toFixed(3)}%  p50=${p50?.toFixed(3)}%  p75=${p75?.toFixed(3)}%  p90=${p90?.toFixed(3)}%`);
    console.log(`  → This is the typical SL distance from entry (spike low to last lower candle)`);
  }

  // ── How to implement in live bot ──
  console.log('');
  console.log('═'.repeat(75));
  console.log('HOW TO IMPLEMENT IN LIVE BOT:');
  console.log('');
  console.log('  1. During session window, scan 1m candles every minute');
  console.log('  2. Find current prevHL = most recent candle where low > prev candle low');
  console.log('  3. Place a standing LIMIT BUY order at prevHL level');
  console.log('  4. When price spikes below prevHL and fills the limit:');
  console.log('     → Entry = prevHL (you filled at the HL, not the spike bottom)');
  console.log('     → SL = spike candle low × 0.999');
  console.log('     → Trail SL: each new 1m candle, if its LOW > current SL → update SL');
  console.log('  5. Close when trailing SL is hit (momentum exhausted)');
  console.log('');
  console.log('  Real-time detection (Model B — market order):');
  console.log('  → Wait for candle CLOSE above prevHL after spiking below');
  console.log('  → Market buy at close, SL below spike low');
  console.log('  → Same trailing SL logic');
  console.log('═'.repeat(75));
}

main();
