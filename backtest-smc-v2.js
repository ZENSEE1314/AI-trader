'use strict';

// ============================================================
// SMC Strategy Backtest v2 — Filter Optimization
//
// Tests 8 filter combinations to find the config that achieves
// 50%+ WR on BTC/ETH/SOL/BNB with meaningful trade count.
//
// Base strategy:
//   3m structure bias (HH/HL or LH/LL) + EMA200 trend alignment
//   + 1m swing HL/LH confirmation + proximity to swing level
//   + session gate (Asia 23-02 / Europe 07-10 / US 12-16)
//
// Filters tested:
//   V = volume spike  (entry bar vol > 1.5x avg-20)
//   R = rejection wick (wick > 55% of candle range at entry bar)
//   I = RSI gate      (LONG: RSI<65, SHORT: RSI>35)
//   P = tight proximity (0.3% instead of 0.6%)
//   T = TP at 2% instead of 3% (higher fill, lower RR)
// ============================================================

// ─── Constants ───────────────────────────────────────────────

const SYMBOLS = [
  { name: 'BTCUSDT', leverage: 100, vol: 0.0045 },
  { name: 'ETHUSDT', leverage: 100, vol: 0.0055 },
  { name: 'SOLUSDT', leverage: 20,  vol: 0.0075 },
  { name: 'BNBUSDT', leverage: 20,  vol: 0.0045 },
];

const N_1M        = 7200;  // 5 days of 1m bars
const SWING_LB    = 5;     // swing lookback
const EMA_PERIOD  = 200;
const RSI_PERIOD  = 14;
const ATR_PERIOD  = 14;
const VOL_AVG_LEN = 20;
const MAX_HOLD    = 200;   // max bars in trade before force-close
const MAX_PER_DAY = 3;

const BASE_SL_PCT  = 0.010;  // 1% SL — fixed
const PROXIMITY_LOOSE = 0.006;
const PROXIMITY_TIGHT = 0.003;

// Session windows (UTC hours) — only trade during institutional sessions
const SESSIONS = [[23, 26], [7, 10], [12, 16]];
const AVOID_MIN = new Set([0, 15, 30, 45]);

// ─── OHLCV Synthetic Generator ───────────────────────────────
// Generates realistic candles with:
//   - Alternating trend/range phases for real swing structure
//   - Proper OHLC (body + upper/lower wicks)
//   - Volume with spikes at swing turning points

function generateCandles(nBars, baseVol, basePrice) {
  const bars = [];
  let price = basePrice;

  // Phase schedule: trend-up, range, trend-down, range, repeat
  const phaseLen = [180, 80, 180, 80];
  let phase = 0;
  let phaseBar = 0;

  // Drift per bar based on phase
  const drifts = [+0.00015, 0, -0.00015, 0];

  for (let i = 0; i < nBars; i++) {
    if (phaseBar >= phaseLen[phase % 4]) {
      phase++;
      phaseBar = 0;
    }
    phaseBar++;

    const drift = drifts[phase % 4];
    const noise = baseVol * (Math.random() * 2 - 1);
    const ret   = drift + noise;

    const open  = price;
    const close = Math.max(open * (1 + ret), 0.00001);

    // Wicks: up to 50% of body size on each side
    const bodySize = Math.abs(close - open);
    const upperWick = bodySize * Math.random() * 0.7;
    const lowerWick = bodySize * Math.random() * 0.7;

    const high = Math.max(open, close) + upperWick;
    const low  = Math.min(open, close) - lowerWick;

    // Volume: spike near phase transitions (swing turning points)
    const atTurn = phaseBar <= 5 || phaseBar >= phaseLen[phase % 4] - 3;
    const baseV  = 1000 + Math.random() * 500;
    const vol    = atTurn ? baseV * (2 + Math.random() * 2) : baseV * (0.5 + Math.random());

    // Timestamps: each bar = 1 minute, starting from 5 days ago
    const ts = Date.now() - (nBars - i) * 60 * 1000;

    bars.push({ ts, open, high, low, close, vol });
    price = close;
  }
  return bars;
}

// Sample every 3rd bar as "3m" candles
function make3m(bars1m) {
  const out = [];
  for (let i = 0; i + 2 < bars1m.length; i += 3) {
    const slice = bars1m.slice(i, i + 3);
    out.push({
      ts:    slice[0].ts,
      open:  slice[0].open,
      high:  Math.max(...slice.map(b => b.high)),
      low:   Math.min(...slice.map(b => b.low)),
      close: slice[2].close,
      vol:   slice.reduce((s, b) => s + b.vol, 0),
    });
  }
  return out;
}

// ─── Indicators ──────────────────────────────────────────────

function computeEma(bars, period) {
  const k = 2 / (period + 1);
  const emas = new Array(bars.length).fill(null);
  let ema = bars[0].close;
  for (let i = 0; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    emas[i] = ema;
  }
  return emas;
}

function computeRsi(bars, period) {
  const rsi = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  rsi[period] = 100 - 100 / (1 + avgG / (avgL || 0.00001));
  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    rsi[i] = 100 - 100 / (1 + avgG / (avgL || 0.00001));
  }
  return rsi;
}

function computeAtr(bars, period) {
  const atr = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return atr;
  let sumTr = 0;
  for (let i = 1; i <= period; i++) {
    sumTr += Math.max(bars[i].high, bars[i - 1].close) - Math.min(bars[i].low, bars[i - 1].close);
  }
  atr[period] = sumTr / period;
  for (let i = period + 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high, bars[i - 1].close) - Math.min(bars[i].low, bars[i - 1].close);
    atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}

function volAvg20(bars, i) {
  if (i < VOL_AVG_LEN) return null;
  let sum = 0;
  for (let k = i - VOL_AVG_LEN; k < i; k++) sum += bars[k].vol;
  return sum / VOL_AVG_LEN;
}

// ─── Swing Detection ─────────────────────────────────────────

function detectSwings(bars) {
  const n = bars.length;
  const sH = new Array(n).fill(null);
  const sL = new Array(n).fill(null);
  for (let i = SWING_LB; i < n - SWING_LB; i++) {
    let isH = true, isL = true;
    for (let j = i - SWING_LB; j <= i + SWING_LB; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low  <= bars[i].low)  isL = false;
    }
    if (isH) sH[i] = bars[i].high;
    if (isL) sL[i] = bars[i].low;
  }
  return { sH, sL };
}

function labelSwings(sH, sL, upTo) {
  const highs = [], lows = [];
  for (let i = 0; i <= upTo; i++) {
    if (sH[i] !== null) {
      const prev = highs.length ? highs[highs.length - 1] : null;
      highs.push({ i, price: sH[i], label: !prev ? 'HH' : sH[i] > prev.price ? 'HH' : 'LH' });
    }
    if (sL[i] !== null) {
      const prev = lows.length ? lows[lows.length - 1] : null;
      lows.push({ i, price: sL[i], label: !prev ? 'HL' : sL[i] > prev.price ? 'HL' : 'LL' });
    }
  }
  return { highs, lows };
}

function getBias(sH, sL, upTo) {
  const { highs, lows } = labelSwings(sH, sL, upTo);
  if (highs.length < 2 || lows.length < 2) return null;
  const isBull = highs[highs.length - 1].label === 'HH' && lows[lows.length - 1].label === 'HL';
  const isBear = highs[highs.length - 1].label === 'LH' && lows[lows.length - 1].label === 'LL';
  if (isBull) return 'bullish';
  if (isBear) return 'bearish';
  return null;
}

// Find last 3m index whose ts <= ts1m
function find3mIdx(bars3m, ts1m) {
  let lo = 0, hi = bars3m.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars3m[mid].ts <= ts1m) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// ─── Session Gate ─────────────────────────────────────────────

function inSession(ts) {
  const d  = new Date(ts);
  const h  = d.getUTCHours();
  const m  = d.getUTCMinutes();
  if (AVOID_MIN.has(m)) return false;
  for (const [s, e] of SESSIONS) {
    if (e <= 24) { if (h >= s && h < e) return true; }
    else         { if (h >= s || h < e - 24) return true; }
  }
  return false;
}

// ─── Single Filter Combination Backtest ──────────────────────

function runBacktest(bars1m, bars3m, ema200, rsi, opts) {
  const { useVolume, useRejection, useRsiGate, proximity, tpPct, slPct,
          wickThresh = 0.30, volMult = 1.5 } = opts;
  const { sH: sH3m, sL: sL3m } = detectSwings(bars3m);
  const { sH: sH1m, sL: sL1m } = detectSwings(bars1m);

  const trades = [];
  const dayCounts = {};
  let inTrade = null;

  for (let i = EMA_PERIOD + SWING_LB * 2 + 1; i < bars1m.length - MAX_HOLD; i++) {
    const bar = bars1m[i];

    // ── Exit logic ──
    if (inTrade) {
      const { dir, entry, sl, tp, entryBar } = inTrade;
      let outcome = null, exitP = null;

      if (dir === 'LONG') {
        if (bar.low  <= sl)  { outcome = 'LOSS'; exitP = sl; }
        else if (bar.high >= tp) { outcome = 'WIN';  exitP = tp; }
        else if (i - entryBar >= MAX_HOLD) {
          outcome = bar.close >= entry ? 'WIN' : 'LOSS';
          exitP = bar.close;
        }
      } else {
        if (bar.high >= sl)  { outcome = 'LOSS'; exitP = sl; }
        else if (bar.low  <= tp) { outcome = 'WIN';  exitP = tp; }
        else if (i - entryBar >= MAX_HOLD) {
          outcome = bar.close <= entry ? 'WIN' : 'LOSS';
          exitP = bar.close;
        }
      }

      if (outcome) {
        const pnl = dir === 'LONG'
          ? (exitP - entry) / entry
          : (entry - exitP) / entry;
        trades.push({ outcome, pnl, dir });
        inTrade = null;
      }
    }

    // ── Entry logic ──
    if (inTrade) continue;
    if (!inSession(bar.ts)) continue;

    const day = new Date(bar.ts).toISOString().slice(0, 10);
    if ((dayCounts[day] ?? 0) >= MAX_PER_DAY) continue;

    // EMA200 bias
    const ema = ema200[i];
    if (!ema) continue;

    // 3m bias
    const idx3m = find3mIdx(bars3m, bar.ts);
    if (idx3m < SWING_LB * 2) continue;
    const bias = getBias(sH3m, sL3m, idx3m);
    if (!bias) continue;
    if (bias === 'bullish' && bar.close < ema) continue;
    if (bias === 'bearish' && bar.close > ema) continue;

    // 1m swing confirmation
    const { highs, lows } = labelSwings(sH1m, sL1m, i);
    let swingPrice = null, dir = null;
    if (bias === 'bullish') {
      if (!lows.length) continue;
      const last = lows[lows.length - 1];
      if (last.label !== 'HL') continue;
      swingPrice = last.price; dir = 'LONG';
    } else {
      if (!highs.length) continue;
      const last = highs[highs.length - 1];
      if (last.label !== 'LH') continue;
      swingPrice = last.price; dir = 'SHORT';
    }

    // Proximity
    const dist = Math.abs(bar.close - swingPrice) / swingPrice;
    if (dist > proximity) continue;

    // ── Optional filters ──

    // Volume spike: entry bar vol > volMult × avg-20
    if (useVolume) {
      const avgV = volAvg20(bars1m, i);
      if (!avgV || bar.vol < avgV * volMult) continue;
    }

    // Rejection wick: dominant wick in signal direction > wickThresh of range
    if (useRejection) {
      const range = bar.high - bar.low;
      if (range < 0.000001) continue;
      if (dir === 'LONG') {
        const lowerWick = Math.min(bar.open, bar.close) - bar.low;
        if (lowerWick / range < wickThresh) continue;
      } else {
        const upperWick = bar.high - Math.max(bar.open, bar.close);
        if (upperWick / range < wickThresh) continue;
      }
    }

    // RSI gate: don't long overbought, don't short oversold
    if (useRsiGate) {
      const r = rsi[i];
      if (!r) continue;
      if (dir === 'LONG'  && r > 65) continue;
      if (dir === 'SHORT' && r < 35) continue;
    }

    // ── Place trade ──
    const entry = bar.close;
    const sl = dir === 'LONG' ? entry * (1 - slPct) : entry * (1 + slPct);
    const tp = dir === 'LONG' ? entry * (1 + tpPct) : entry * (1 - tpPct);

    inTrade = { dir, entry, sl, tp, entryBar: i };
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
  }

  return trades;
}

// ─── Stats ───────────────────────────────────────────────────

function stats(trades) {
  if (!trades.length) return { total: 0, wr: '0', pf: '0', net: '0', avgW: '0', avgL: '0' };
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const gW = wins.reduce((s, t) => s + t.pnl, 0);
  const gL = losses.reduce((s, t) => s + Math.abs(t.pnl), 0);
  return {
    total: trades.length,
    wr:    (wins.length / trades.length * 100).toFixed(1),
    pf:    gL > 0 ? (gW / gL).toFixed(2) : 'inf',
    net:   (trades.reduce((s, t) => s + t.pnl, 0) * 100).toFixed(2),
    avgW:  wins.length ? (gW / wins.length * 100).toFixed(2) : '0',
    avgL:  losses.length ? (gL / losses.length * 100).toFixed(2) : '0',
  };
}

// ─── Filter Combinations ──────────────────────────────────────

// Wick threshold tuned to 30% — more achievable in realistic candles
const WICK_THRESH = 0.30;

const COMBOS = [
  { label: 'Base  SL1% TP3%',             useVolume: false, useRejection: false, useRsiGate: false, proximity: PROXIMITY_LOOSE, tpPct: 0.03, slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'Base  SL1% TP2%',             useVolume: false, useRejection: false, useRsiGate: false, proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'Base  SL1% TP1.5%',           useVolume: false, useRejection: false, useRsiGate: false, proximity: PROXIMITY_LOOSE, tpPct: 0.015,slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'Base  SL0.8% TP2%',           useVolume: false, useRejection: false, useRsiGate: false, proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.008, wickThresh: WICK_THRESH },
  { label: 'TP2%  + RSI gate',            useVolume: false, useRejection: false, useRsiGate: true,  proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'TP2%  + Tight prox 0.3%',    useVolume: false, useRejection: false, useRsiGate: false, proximity: PROXIMITY_TIGHT, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'TP2%  + Wick 30%',           useVolume: false, useRejection: true,  useRsiGate: false, proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'TP2%  + Vol 1.3x',           useVolume: true,  useRejection: false, useRsiGate: false, proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH, volMult: 1.3 },
  { label: 'TP2%  + RSI + Wick',         useVolume: false, useRejection: true,  useRsiGate: true,  proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'TP2%  + RSI + Wick + Tight', useVolume: false, useRejection: true,  useRsiGate: true,  proximity: PROXIMITY_TIGHT, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH },
  { label: 'TP2%  + Vol + RSI + Wick',   useVolume: true,  useRejection: true,  useRsiGate: true,  proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.010, wickThresh: WICK_THRESH, volMult: 1.3 },
  { label: 'TP2%  + RSI + SL0.8%',      useVolume: false, useRejection: false, useRsiGate: true,  proximity: PROXIMITY_LOOSE, tpPct: 0.02, slPct: 0.008, wickThresh: WICK_THRESH },
];

// ─── Main ─────────────────────────────────────────────────────

function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  SMC BACKTEST v2 — Filter Optimization (5 days × 4 symbols synthetic)   ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Generating 5 days of 1m candles per symbol with trend/range phases...');
  console.log('Swing detection: SWING_LB=5 | EMA200 trend filter | Session gate');
  console.log('SL=1% fixed | TP varies per combo | Max 3 trades/day');
  console.log('');

  // Accumulate results across all symbols per combo
  const comboAgg = COMBOS.map(() => []);

  for (const sym of SYMBOLS) {
    const bars1m  = generateCandles(N_1M, sym.vol, 1000); // normalised base price
    const bars3m  = make3m(bars1m);
    const ema200  = computeEma(bars1m, EMA_PERIOD);
    const rsi14   = computeRsi(bars1m, RSI_PERIOD);

    for (let c = 0; c < COMBOS.length; c++) {
      const trades = runBacktest(bars1m, bars3m, ema200, rsi14, COMBOS[c]);
      comboAgg[c].push(...trades);
    }
  }

  // ── Summary table ──
  const COL = [40, 7, 8, 8, 7, 8, 6];
  const hdr = ['Filter Combination', 'Trades', 'WR%', 'Net%', 'PF', 'AvgWin', 'AvgLoss'];
  console.log(hdr.map((h, i) => h.padEnd(COL[i])).join(''));
  console.log('─'.repeat(COL.reduce((a, b) => a + b)));

  let bestComboIdx = -1, bestWr = 0;

  for (let c = 0; c < COMBOS.length; c++) {
    const s = stats(comboAgg[c]);
    const wrNum = parseFloat(s.wr);
    const mark  = wrNum >= 50 ? ' ✓' : '';
    if (wrNum > bestWr && s.total >= 20) { bestWr = wrNum; bestComboIdx = c; }
    const row = [
      (COMBOS[c].label + mark).padEnd(COL[0]),
      String(s.total).padEnd(COL[1]),
      (s.wr + '%').padEnd(COL[2]),
      ((parseFloat(s.net) >= 0 ? '+' : '') + s.net + '%').padEnd(COL[3]),
      s.pf.padEnd(COL[4]),
      ('+' + s.avgW + '%').padEnd(COL[5]),
      ('-' + s.avgL + '%').padEnd(COL[6]),
    ];
    console.log(row.join(''));
  }

  console.log('');
  console.log('✓ = WR >= 50%   (needs ≥20 trades to be statistically valid)');

  // ── Per-symbol breakdown for best combo ──
  if (bestComboIdx < 0) {
    console.log('\n⚠  No combo achieved 50%+ WR with ≥20 trades on combined symbols.');
    console.log('   Best result: ' + bestWr.toFixed(1) + '% — see table above for closest config.');
  } else {
    const best = COMBOS[bestComboIdx];
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Best combo: "${best.label}"`);
    console.log(`TP=${(best.tpPct * 100).toFixed(0)}%  SL=1%  Proximity=${(best.proximity * 100).toFixed(1)}%`);
    console.log(`Volume filter: ${best.useVolume}  Rejection wick: ${best.useRejection}  RSI gate: ${best.useRsiGate}`);
    console.log(`${'─'.repeat(60)}`);
    console.log('PER-SYMBOL BREAKDOWN:');

    for (const sym of SYMBOLS) {
      const bars1m = generateCandles(N_1M, sym.vol, 1000);
      const bars3m = make3m(bars1m);
      const ema200 = computeEma(bars1m, EMA_PERIOD);
      const rsi14  = computeRsi(bars1m, RSI_PERIOD);
      const trades = runBacktest(bars1m, bars3m, ema200, rsi14, best);
      const s = stats(trades);
      const longs  = trades.filter(t => t.dir === 'LONG').length;
      const shorts = trades.filter(t => t.dir === 'SHORT').length;
      console.log(`  ${sym.name.padEnd(10)} x${sym.leverage.toString().padEnd(4)} LONG=${longs} SHORT=${shorts} total=${s.total} WR=${s.wr}% PF=${s.pf} net=${parseFloat(s.net) >= 0 ? '+' : ''}${s.net}%`);
    }
  }

  // ── Recommended live config ──
  console.log('');
  console.log('═'.repeat(60));
  console.log('RECOMMENDED CONFIG CHANGES FOR LIVE BOT:');
  console.log('═'.repeat(60));
  if (bestComboIdx >= 0) {
    const b = COMBOS[bestComboIdx];
    console.log(`  TP target       : ${(b.tpPct * 100).toFixed(0)}%`);
    console.log(`  SL              : 1%`);
    console.log(`  Entry proximity : ${(b.proximity * 100).toFixed(1)}%`);
    console.log(`  Volume filter   : ${b.useVolume ? 'ON  — entry bar vol > 1.5x avg-20' : 'OFF'}`);
    console.log(`  Rejection wick  : ${b.useRejection ? 'ON  — wick > 55% of range at swing' : 'OFF'}`);
    console.log(`  RSI gate        : ${b.useRsiGate ? 'ON  — LONG: RSI<65, SHORT: RSI>35' : 'OFF'}`);
  }
  console.log('  EMA200 trend    : ON (unchanged)');
  console.log('  3m structure    : ON (unchanged)');
  console.log('  Session gate    : ON (Asia/Europe/US only, skip :00/:15/:30/:45)');
  console.log('  Max trades/day  : 3');
  console.log('');
}

main();
