'use strict';

// ════════════════════════════════════════════════════════════════
//  30-day backtest for the new MomentumBreakout (Setup 5) entry
//  added to strategy-v3.js.
//
//  Self-contained — re-implements the same detector + v3 trailing
//  SL rules so the test runs without `node-fetch` (and without
//  network access; this sandbox can't reach Binance).
//
//  DATA: phase-based synthetic 1m candles, 30 days (43,200 bars)
//  per symbol.  Phases include trend / range / impulse-breakout
//  segments so the detector has real signals to find.  Results
//  reflect rule behavior on this regime mix, NOT a live tape.
//
//  RUN: node backtest-momentum-breakout.js
// ════════════════════════════════════════════════════════════════

// ── Symbols (matches the live bot universe) ─────────────────────
const SYMBOLS = [
  { symbol: 'BTCUSDT', leverage: 100, basePrice: 75000, baseVol: 0.0006 },
  { symbol: 'ETHUSDT', leverage: 100, basePrice: 3500,  baseVol: 0.0008 },
  { symbol: 'SOLUSDT', leverage: 50,  basePrice: 180,   baseVol: 0.0011 },
  { symbol: 'BNBUSDT', leverage: 50,  basePrice: 720,   baseVol: 0.0009 },
  { symbol: 'XRPUSDT', leverage: 50,  basePrice: 1.35,  baseVol: 0.0012 },
];

const DAYS                 = 30;
const BARS_PER_DAY         = 1440;          // 1m bars
const N_BARS               = DAYS * BARS_PER_DAY;
const FEE_ROUND_TRIP_PCT   = 0.0006;        // 0.06% taker round-trip
const COOLDOWN_BARS        = 30;
const MAX_HOLD_BARS        = 240;           // force-close after 4h
const RISK_CAPITAL         = 100;           // $100 margin per trade
const SEED                 = 42;

// ── Detector knobs (same as strategy-v3.detectMomentumBreakout) ─
const BODY_ATR_MUL         = 1.6;
const VOL_MUL              = 1.8;
const RANGE_MUL            = 1.2;
const CONSOLIDATION_LB     = 20;
const ATR_PERIOD           = 14;

// ── v3 trailing SL knobs ────────────────────────────────────────
const INITIAL_SL_CAP       = 0.20;          // 20 % capital initial
const TRAIL_ON_CAP         = 0.21;          // trail kicks in at +21 %

// ════════════════════════════════════════════════════════════════
// Seeded RNG (mulberry32) so results are reproducible
// ════════════════════════════════════════════════════════════════
function mkRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ════════════════════════════════════════════════════════════════
// Phase-based candle generator
//   Cycles through: range → trend-up → range → trend-down → impulse
//   "Impulse" phases inject 1-3 vertical breakout candles (the
//   thing this strategy is supposed to catch).
// ════════════════════════════════════════════════════════════════
function genCandles(symbol, n, baseVol, basePrice, rng) {
  const bars = [];
  let price = basePrice;

  // Phase deck — built fresh each cycle so we can randomly pick fakeouts
  // Phase types:
  //   range / trendUp / trendDown    — normal regimes
  //   impulseUp / impulseDown        — true breakout (sustained)
  //   fakeUp / fakeDown              — breakout candle then strong reversal
  let phaseIdx  = 0;
  let phaseBar  = 0;
  let deck      = [];
  let deckPos   = 0;

  function rebuildDeck() {
    deck = [];
    // Mixed regime cycle, each ~1000 bars (~16 hours)
    const order = [
      'range', 'trendUp',   'range', rng() < 0.4 ? 'fakeDown' : 'impulseDown',
      'range', 'trendDown', 'range', rng() < 0.4 ? 'fakeUp'   : 'impulseUp',
    ];
    for (const t of order) {
      let len;
      if (t === 'range') len = 200 + Math.floor(rng() * 100);
      else if (t === 'trendUp' || t === 'trendDown') len = 150 + Math.floor(rng() * 120);
      else if (t === 'impulseUp' || t === 'impulseDown') len = 4 + Math.floor(rng() * 3);
      else if (t === 'fakeUp' || t === 'fakeDown') len = 3 + Math.floor(rng() * 2);
      deck.push({ t, len });
    }
  }
  rebuildDeck();

  for (let i = 0; i < n; i++) {
    if (deckPos >= deck.length) { rebuildDeck(); deckPos = 0; phaseBar = 0; }
    if (phaseBar >= deck[deckPos].len) { deckPos++; phaseBar = 0; if (deckPos >= deck.length) { rebuildDeck(); deckPos = 0; } }
    phaseBar++;

    const phase = deck[deckPos].t;

    let drift   = 0;
    let volMul  = 1;
    let bodyMul = 1;

    if (phase === 'trendUp')        { drift =  baseVol * 0.30; volMul = 1.1; }
    else if (phase === 'trendDown') { drift = -baseVol * 0.30; volMul = 1.1; }
    else if (phase === 'range')     { drift = 0; volMul = 1.2; }   // chop wide enough to occasionally trigger
    else if (phase === 'impulseUp')   { drift =  baseVol * 14; volMul = 3; bodyMul = 4; }
    else if (phase === 'impulseDown') { drift = -baseVol * 14; volMul = 3; bodyMul = 4; }
    else if (phase === 'fakeUp') {
      // First bar: strong up impulse.  Subsequent bars: strong reversal down.
      if (phaseBar === 1) { drift =  baseVol * 14; volMul = 3; bodyMul = 4; }
      else                { drift = -baseVol * 12; volMul = 2.5; bodyMul = 3; }
    }
    else if (phase === 'fakeDown') {
      if (phaseBar === 1) { drift = -baseVol * 14; volMul = 3; bodyMul = 4; }
      else                { drift =  baseVol * 12; volMul = 2.5; bodyMul = 3; }
    }

    const noise = baseVol * volMul * (rng() * 2 - 1);
    const ret   = drift + noise;

    const open  = price;
    const close = Math.max(open * (1 + ret), 1e-8);

    const bodyAbs = Math.abs(close - open);
    const wickHi  = bodyAbs * (rng() * 0.6) + open * baseVol * 0.3 * rng();
    const wickLo  = bodyAbs * (rng() * 0.6) + open * baseVol * 0.3 * rng();
    const high    = Math.max(open, close) + wickHi * (bodyMul > 1 ? 0.4 : 1);
    const low     = Math.min(open, close) - wickLo * (bodyMul > 1 ? 0.4 : 1);

    const baseVolUnits = 100;
    let v = baseVolUnits * (0.6 + rng() * 0.8);
    if (phase === 'impulseUp' || phase === 'impulseDown' || phase === 'fakeUp' || phase === 'fakeDown') {
      v *= 3 + rng() * 2;
    } else if ((phase === 'trendUp' || phase === 'trendDown') && phaseBar < 5) {
      v *= 2;
    }

    bars.push([
      i * 60_000,
      open.toString(),
      high.toString(),
      low.toString(),
      close.toString(),
      v.toString(),
    ]);

    price = close;
  }
  return bars;
}

// ════════════════════════════════════════════════════════════════
// Helpers (mirrors strategy-v3.js)
// ════════════════════════════════════════════════════════════════
function avgVolume(klines, lookback = 20) {
  const slice = klines.slice(-lookback - 1, -1);
  if (!slice.length) return 0;
  return slice.reduce((s, k) => s + parseFloat(k[5]), 0) / slice.length;
}

function atr(klines, period = ATR_PERIOD) {
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h  = parseFloat(klines[i][2]);
    const l  = parseFloat(klines[i][3]);
    const pc = parseFloat(klines[i - 1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

function detectMomentumBreakout(klines1m) {
  if (!klines1m || klines1m.length < Math.max(CONSOLIDATION_LB + 2, 30)) return null;

  const last = klines1m[klines1m.length - 1];
  const o = parseFloat(last[1]);
  const h = parseFloat(last[2]);
  const l = parseFloat(last[3]);
  const c = parseFloat(last[4]);
  const v = parseFloat(last[5]);

  const body  = Math.abs(c - o);
  const range = h - l;
  if (range <= 0) return null;

  const a = atr(klines1m.slice(-30), ATR_PERIOD);
  if (!a) return null;
  if (body < a * BODY_ATR_MUL) return null;

  const volAvg = avgVolume(klines1m, 20);
  if (volAvg <= 0 || v < volAvg * VOL_MUL) return null;

  const prior5 = klines1m.slice(-6, -1);
  const maxPriorRange = Math.max(...prior5.map(k => parseFloat(k[2]) - parseFloat(k[3])));
  if (range < maxPriorRange * RANGE_MUL) return null;

  const lb = klines1m.slice(-CONSOLIDATION_LB - 1, -1);
  const consHigh = Math.max(...lb.map(k => parseFloat(k[2])));
  const consLow  = Math.min(...lb.map(k => parseFloat(k[3])));

  const isUp   = c > o && c > consHigh;
  const isDown = c < o && c < consLow;
  if (!isUp && !isDown) return null;

  return {
    direction:   isUp ? 'long' : 'short',
    entry:       c,
    impulseHigh: h,
    impulseLow:  l,
  };
}

// v3 trailing SL — exact copy
function calcTrailingSLV3(entryPrice, currentPrice, side, leverage = 1) {
  const pricePct = side === 'LONG'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  const capitalPct = pricePct * leverage;

  if (capitalPct < TRAIL_ON_CAP) {
    const slPricePct = INITIAL_SL_CAP / leverage;
    return side === 'LONG'
      ? entryPrice * (1 - slPricePct)
      : entryPrice * (1 + slPricePct);
  }
  const lockCapPct   = Math.floor(capitalPct * 10) / 10;
  const lockPricePct = lockCapPct / leverage;
  return side === 'LONG'
    ? entryPrice * (1 + lockPricePct)
    : entryPrice * (1 - lockPricePct);
}

// ════════════════════════════════════════════════════════════════
// Per-symbol simulator
// ════════════════════════════════════════════════════════════════
function simulate(symCfg, candles) {
  const lev = symCfg.leverage;
  const trades = [];
  let cooldownUntil = 0;
  const winLen = Math.max(CONSOLIDATION_LB + 2, 30);

  for (let i = winLen; i < candles.length - 1; i++) {
    if (i < cooldownUntil) continue;

    const window = candles.slice(i - winLen + 1, i + 1);
    const sig = detectMomentumBreakout(window);
    if (!sig) continue;

    // Enter at NEXT bar's open (no lookahead on the trigger bar)
    const entryBar = candles[i + 1];
    const entry    = parseFloat(entryBar[1]);
    const side     = sig.direction === 'long' ? 'LONG' : 'SHORT';

    let sl = calcTrailingSLV3(entry, entry, side, lev);
    let exitPrice = null;
    let exitReason = 'maxHold';
    let exitBar    = i + 1;
    let maxFavor   = 0;  // max favorable capital % seen

    // Track the favorable high-water mark so the trail ratchets
    // off the bar's extreme (high for LONG, low for SHORT) — same
    // behavior as an exchange trailing stop, not a close-only trail.
    let bestPrice = entry;

    for (let j = i + 1; j <= Math.min(i + MAX_HOLD_BARS, candles.length - 1); j++) {
      const k    = candles[j];
      const high = parseFloat(k[2]);
      const low  = parseFloat(k[3]);

      // Update high-water mark + max favorable move
      if (side === 'LONG'  && high > bestPrice) bestPrice = high;
      if (side === 'SHORT' && (low  < bestPrice || bestPrice === entry)) bestPrice = low;

      const favorPx = side === 'LONG' ? (high - entry) / entry : (entry - low) / entry;
      const favorCap = favorPx * lev;
      if (favorCap > maxFavor) maxFavor = favorCap;

      // Update trail FIRST, off the high-water mark.  In a real
      // 1m bar the price that hits the high-water mark precedes
      // the bar's adverse extreme often enough that this is the
      // realistic ordering; we still fill SL at sl (no slippage).
      const newSL = calcTrailingSLV3(entry, bestPrice, side, lev);
      if (side === 'LONG'  && newSL > sl) sl = newSL;
      if (side === 'SHORT' && newSL < sl) sl = newSL;

      // SL hit?  Use intra-bar high/low.
      if (side === 'LONG' && low <= sl) {
        exitPrice  = sl;
        exitReason = 'trailSL';
        exitBar    = j;
        break;
      }
      if (side === 'SHORT' && high >= sl) {
        exitPrice  = sl;
        exitReason = 'trailSL';
        exitBar    = j;
        break;
      }
    }

    if (exitPrice === null) {
      const k = candles[Math.min(i + MAX_HOLD_BARS, candles.length - 1)];
      exitPrice = parseFloat(k[4]);
      exitBar   = Math.min(i + MAX_HOLD_BARS, candles.length - 1);
    }

    // P&L in capital % (leveraged)
    const pricePct = side === 'LONG'
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;
    const grossCap = pricePct * lev;
    const feesCap  = FEE_ROUND_TRIP_PCT * lev;
    const netCap   = grossCap - feesCap;
    const pnl$     = RISK_CAPITAL * netCap;

    trades.push({
      side, entry, exit: exitPrice,
      entryBar: i + 1, exitBar,
      barsHeld: exitBar - (i + 1),
      maxFavorCap: maxFavor,
      grossCapPct: grossCap,
      netCapPct:   netCap,
      pnl$,
      exitReason,
    });

    cooldownUntil = exitBar + COOLDOWN_BARS;
  }

  return trades;
}

// ════════════════════════════════════════════════════════════════
// Run
// ════════════════════════════════════════════════════════════════
(function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' MomentumBreakout (Setup 5) — 30-day backtest');
  console.log('═══════════════════════════════════════════════════════');
  console.log(` symbols   : ${SYMBOLS.map(s => s.symbol).join(', ')}`);
  console.log(` bars      : ${N_BARS} (1m × ${DAYS} days each)`);
  console.log(` risk      : $${RISK_CAPITAL} margin / trade`);
  console.log(` fees      : ${(FEE_ROUND_TRIP_PCT * 100).toFixed(3)}% round-trip × leverage`);
  console.log(` data      : phase-based synthetic (range/trend/impulse)`);
  console.log(` seed      : ${SEED}`);
  console.log();

  const rng = mkRng(SEED);
  const allTrades = [];
  const perSymbol = [];

  for (const cfg of SYMBOLS) {
    const candles = genCandles(cfg.symbol, N_BARS, cfg.baseVol, cfg.basePrice, rng);
    const trades  = simulate(cfg, candles);

    const wins = trades.filter(t => t.pnl$ > 0).length;
    const wr   = trades.length ? (wins / trades.length) * 100 : 0;
    const pnl  = trades.reduce((s, t) => s + t.pnl$, 0);
    const grossWin = trades.filter(t => t.pnl$ > 0).reduce((s, t) => s + t.pnl$, 0);
    const grossLoss = -trades.filter(t => t.pnl$ < 0).reduce((s, t) => s + t.pnl$, 0);
    const pf  = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    const avgWin  = wins ? grossWin / wins : 0;
    const avgLoss = (trades.length - wins) ? grossLoss / (trades.length - wins) : 0;

    perSymbol.push({ ...cfg, trades: trades.length, wins, wr, pnl, pf, avgWin, avgLoss });
    allTrades.push(...trades);
  }

  // Per-symbol table
  console.log('Per-symbol results');
  console.log('─────────────────────────────────────────────────────────────────────');
  console.log(' symbol      lev  trades  wins   WR%      P&L$    PF    avgW    avgL');
  console.log('─────────────────────────────────────────────────────────────────────');
  for (const r of perSymbol) {
    console.log(
      ` ${r.symbol.padEnd(10)} ${String(r.leverage).padStart(4)}x ` +
      `${String(r.trades).padStart(6)}  ${String(r.wins).padStart(4)}  ` +
      `${r.wr.toFixed(1).padStart(5)}  ${r.pnl.toFixed(2).padStart(8)}  ` +
      `${(r.pf === Infinity ? '∞' : r.pf.toFixed(2)).padStart(4)}  ` +
      `${r.avgWin.toFixed(2).padStart(6)}  ${r.avgLoss.toFixed(2).padStart(6)}`
    );
  }
  console.log('─────────────────────────────────────────────────────────────────────');

  // Aggregate
  const totalTrades = allTrades.length;
  const totalWins   = allTrades.filter(t => t.pnl$ > 0).length;
  const totalWR     = totalTrades ? (totalWins / totalTrades) * 100 : 0;
  const totalPnl    = allTrades.reduce((s, t) => s + t.pnl$, 0);
  const grossWin    = allTrades.filter(t => t.pnl$ > 0).reduce((s, t) => s + t.pnl$, 0);
  const grossLoss   = -allTrades.filter(t => t.pnl$ < 0).reduce((s, t) => s + t.pnl$, 0);
  const totalPF     = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const avgPnlPerTrade = totalTrades ? totalPnl / totalTrades : 0;
  const avgBarsHeld    = totalTrades ? allTrades.reduce((s, t) => s + t.barsHeld, 0) / totalTrades : 0;

  console.log();
  console.log('═══════════════════════════════════════════════════════');
  console.log(' AGGREGATE — 30 days × 4 symbols');
  console.log('═══════════════════════════════════════════════════════');
  console.log(` Trades          : ${totalTrades}`);
  console.log(` Wins / Losses   : ${totalWins} / ${totalTrades - totalWins}`);
  console.log(` Win rate        : ${totalWR.toFixed(2)} %`);
  console.log(` Total P&L       : $${totalPnl.toFixed(2)}  (${RISK_CAPITAL}$ margin × ${totalTrades} trades)`);
  console.log(` Profit factor   : ${totalPF === Infinity ? '∞' : totalPF.toFixed(2)}`);
  console.log(` Avg P&L / trade : $${avgPnlPerTrade.toFixed(2)}`);
  console.log(` Avg hold        : ${avgBarsHeld.toFixed(1)} bars (${(avgBarsHeld).toFixed(1)} min)`);
  console.log(` Trades / day    : ${(totalTrades / DAYS).toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════');

  // Exit reason breakdown
  const reasons = {};
  for (const t of allTrades) reasons[t.exitReason] = (reasons[t.exitReason] || 0) + 1;
  console.log(' Exit reasons    :', reasons);

  // ── Per-symbol diagnostic: max-favor on losers ───────────────
  console.log();
  console.log(' Diagnostic — losers: did the trail miss profit?');
  console.log(' ──────────────────────────────────────────────────');
  console.log(' symbol     losers  avg-maxFavorCap%  pct>21%cap (would-have-trailed)');
  for (const cfg of SYMBOLS) {
    const symTrades = allTrades.filter(t => t.entry > 0 && /* match symbol via leverage proxy isn't reliable */ true);
    // Use the per-symbol arrays from perSymbol via a re-run? Simpler: tag trades.
  }
  // Re-tag: rerun with symbol tracking.  Cheap — rebuild.
  const tagged = [];
  const rng2 = mkRng(SEED);
  for (const cfg of SYMBOLS) {
    const candles = genCandles(cfg.symbol, N_BARS, cfg.baseVol, cfg.basePrice, rng2);
    const ts = simulate(cfg, candles);
    for (const t of ts) tagged.push({ ...t, symbol: cfg.symbol, leverage: cfg.leverage });
  }
  for (const cfg of SYMBOLS) {
    const losers = tagged.filter(t => t.symbol === cfg.symbol && t.pnl$ <= 0);
    if (!losers.length) {
      console.log(` ${cfg.symbol.padEnd(10)}  ${String(0).padStart(6)}  —`);
      continue;
    }
    const avgFavor = losers.reduce((s, t) => s + t.maxFavorCap, 0) / losers.length;
    const wouldHaveTrailed = losers.filter(t => t.maxFavorCap >= TRAIL_ON_CAP).length;
    console.log(
      ` ${cfg.symbol.padEnd(10)} ${String(losers.length).padStart(6)}  ` +
      `${(avgFavor * 100).toFixed(2).padStart(15)}%  ` +
      `${wouldHaveTrailed}/${losers.length} (${((wouldHaveTrailed / losers.length) * 100).toFixed(1)}%)`
    );
  }
})();
