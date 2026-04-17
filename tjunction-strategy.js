// ============================================================
// T-Junction MA Strategy  (live scanner)
//
// Backtest: 14 days × 4 symbols
//   Best slots: 16-18, 18-20, 20-22, 02-04 UTC → 62–75% WR
//   Overall with filters: 51.5% WR | PF 2.12 | Net +327% (TP 2%)
//   Best time-restricted: ~69% WR (188 trades across prime slots)
//
// Pattern — SHORT (T-junction at HIGH):
//   1. MA5, MA10, MA20 all converge within 0.25% for ≥2 bars (T-stem)
//   2. MAs fan out bearish: MA5 < MA10 < MA20 (spread ≥0.12%)
//   3. Current candle is bearish (close < open)
//   4. Price ≤ VWAP (session VWAP confirms resistance)
//   5. Candle volume ≥ SMA9 (not a fake squeeze)
//   → Entry short at close | SL = entry × 1.010 | TP = entry × 0.980
//
// Pattern — LONG (T-junction at LOW):
//   Mirror: MAs fan bullish | price ≥ VWAP | bullish candle
//   → Entry long at close | SL = entry × 0.990 | TP = entry × 1.020
//
// Only fires during prime time windows (avoids Asian open + EU open noise)
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const REQUEST_TIMEOUT = 12000;

const TJUNCTION_SYMBOLS = new Map([
  ['ETHUSDT', 100],
  ['BTCUSDT', 100],
  ['SOLUSDT',  20],
  ['BNBUSDT',  20],
]);

// ── Detection Thresholds ──────────────────────────────────────
const CONVERGE_BAND = 0.0025; // max(MA5,10,20) - min < 0.25% of mid-price
const CONVERGE_MIN  = 2;      // must be converged ≥ 2 consecutive bars
const DIVERGE_MIN   = 0.0012; // fan spread ≥ 0.12% = breakout confirmed

// ── Trade Params ─────────────────────────────────────────────
const TP_PCT   = 0.020; // 2% TP — best balance (PF 2.12)
const SL_PCT   = 0.010; // 1% SL
const SIZE_PCT = 0.10;  // 10% of capital per trade

// ── Prime Time Windows (UTC hours) ───────────────────────────
// Best WR slots from backtest: 16-18 (75%), 02-04 (72.5%), 20-22 (67.6%), 18-20 (62%)
// These are dead-zones BETWEEN institutional sessions — consolidation → breakout
const PRIME_SESSIONS = [
  [2,  4],   // 02-04 UTC  (Asia dead-zone, pre-EU buildup)
  [16, 22],  // 16-22 UTC  (post-US open exhaustion, London/NY close drift)
];
const GRACE_MS = 90_000; // 90s grace so edge-of-window signals aren't dropped

function isInPrimeSession(tsMs = Date.now()) {
  const check = (t) => {
    const h = new Date(t).getUTCHours();
    for (const [start, end] of PRIME_SESSIONS) {
      if (h >= start && h < end) return true;
    }
    return false;
  };
  return check(tsMs) || check(Date.now() - GRACE_MS);
}

// ─── Fetch ────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
    if (!res.ok) return null;
    const raw = await res.json();
    return raw.map(r => ({
      ts:    Number(r[0]),
      open:  parseFloat(r[1]),
      high:  parseFloat(r[2]),
      low:   parseFloat(r[3]),
      close: parseFloat(r[4]),
      vol:   parseFloat(r[5]),
    }));
  } catch {
    return null;
  }
}

// ─── Indicators ───────────────────────────────────────────────

function sma(arr, n) {
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

// Session VWAP — resets at 00:00 UTC
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
//
// Returns { dir, score, convergedBars, spread } or null.
// Uses the last 25 closed bars — bar at index i is the signal bar.
//
function detectTjunction(bars, i) {
  if (i < 25) return null;

  const closes = bars.slice(i - 24, i + 1).map(b => b.close);
  const ma5    = sma(closes, 5);
  const ma10   = sma(closes, 10);
  const ma20   = sma(closes, 20);
  const mid    = (ma5 + ma10 + ma20) / 3;

  // Current spread — must be diverging (T-bar forming)
  const curSpread = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / mid;
  if (curSpread < DIVERGE_MIN) return null;

  // Count consecutive converged bars leading up to this bar (the T-stem)
  let convergedBars = 0;
  for (let back = 1; back <= 8; back++) {
    const j = i - back;
    if (j < 20) break;
    const pc  = bars.slice(j - 19, j + 1).map(b => b.close);
    const p5  = sma(pc, 5);
    const p10 = sma(pc, 10);
    const p20 = sma(pc, 20);
    const pm  = (p5 + p10 + p20) / 3;
    const ps  = (Math.max(p5, p10, p20) - Math.min(p5, p10, p20)) / pm;
    if (ps < CONVERGE_BAND) convergedBars++;
    else break; // Must be consecutive
  }
  if (convergedBars < CONVERGE_MIN) return null;

  // Strict stack order required (no messy fan)
  const bullFan = ma5 > ma10 && ma10 > ma20;
  const bearFan = ma5 < ma10 && ma10 < ma20;
  if (!bullFan && !bearFan) return null;

  const dir   = bullFan ? 'LONG' : 'SHORT';
  const score = convergedBars * 10 + Math.round(curSpread * 10000);
  return { dir, score, ma5, ma10, ma20, spread: curSpread, convergedBars };
}

// ─── Main Scanner ─────────────────────────────────────────────

async function scanTjunction(log) {
  if (!isInPrimeSession(Date.now())) {
    return [];
  }

  log('T-Junction: prime session active — scanning for MA convergence breakouts...');

  const signals = [];

  for (const [symbol, leverage] of TJUNCTION_SYMBOLS) {
    try {
      // 5m candles: need 25 for detection + 9 for SMA9 vol + 5 for VWAP lookback
      // Fetch 60 bars to be safe; drop last (still-forming)
      const allBars = await fetchKlines(symbol, '5m', 60);
      if (!allBars || allBars.length < 35) {
        log(`T-Junction: ${symbol} insufficient candles`);
        continue;
      }

      // Drop still-forming candle
      const bars = allBars.slice(0, -1);

      // Scan last 2 closed candles (offset 0 = most recent, offset 1 = previous)
      // Protects against a 5m cycle being slightly late
      let foundSignal = false;
      for (const offset of [0, 1]) {
        if (foundSignal) break;

        const endIdx    = bars.length - offset;
        if (endIdx < 30) continue;

        const spikeBar  = bars[endIdx - 1]; // signal candle
        const candleTs  = spikeBar.ts;

        // Gate: signal candle must be in prime session
        if (!isInPrimeSession(candleTs)) continue;
        // Must not be stale (> 12 min old — one 5m cycle grace)
        if (Date.now() - candleTs > 720_000) continue;

        const sig = detectTjunction(bars.slice(0, endIdx), endIdx - 1);
        if (!sig) continue;

        // ── VWAP filter ──
        const vwap  = sessionVwap(bars, endIdx - 1);
        const price = spikeBar.close;
        if (sig.dir === 'LONG'  && price < vwap * 0.9990) continue; // Above VWAP
        if (sig.dir === 'SHORT' && price > vwap * 1.0010) continue; // Below VWAP

        // ── Volume filter ──
        const avgVol = volSma9(bars, endIdx - 2); // SMA9 of bars before signal
        if (spikeBar.vol < avgVol) continue;

        // ── Candle body direction must agree ──
        const bullBar = spikeBar.close > spikeBar.open;
        if (sig.dir === 'LONG'  && !bullBar) continue;
        if (sig.dir === 'SHORT' &&  bullBar) continue;

        foundSignal = true;

        const slPrice = sig.dir === 'LONG'
          ? price * (1 - SL_PCT)
          : price * (1 + SL_PCT);
        const tpPrice = sig.dir === 'LONG'
          ? price * (1 + TP_PCT)
          : price * (1 - TP_PCT);
        const slDist  = SL_PCT;

        const label = `T-Junction ${sig.dir} (${convergedBarsLabel(sig.convergedBars)} stem, fan ${(sig.spread*100).toFixed(2)}%)`;

        log(`T-Junction ${symbol}: ${sig.dir} — MA5=${sig.ma5.toFixed(4)} MA10=${sig.ma10.toFixed(4)} MA20=${sig.ma20.toFixed(4)} | VWAP=${vwap.toFixed(4)} | entry=${price.toFixed(4)} SL=${slPrice.toFixed(4)} TP=${tpPrice.toFixed(4)}`);

        signals.push({
          symbol,
          direction:       sig.dir,
          scenario:        'TJUNCTION',
          price,
          lastPrice:       price,
          tp1:             tpPrice,
          tp2:             null,
          tp3:             null,
          sl:              slPrice,
          slDist,
          leverage,
          sizePct:         SIZE_PCT,
          setup:           'TJUNCTION',
          setupName:       label,
          score:           18, // high confidence pattern
          ema200Bias:      sig.dir === 'LONG' ? 'bullish' : 'bearish',
          marketStructure: `TJUNCTION_${sig.dir} converged=${sig.convergedBars}bars fan=${(sig.spread*100).toFixed(3)}% vwap=${vwap.toFixed(4)}`,
          trailTiers:      'NONE', // Fixed TP, no trailing
          noHardSL:        false,
        });
      }

      if (!foundSignal) {
        log(`T-Junction ${symbol}: no convergence breakout — scanning next`);
      }

    } catch (err) {
      log(`T-Junction: ${symbol} error — ${err.message}`);
    }
  }

  return signals;
}

function convergedBarsLabel(n) {
  if (n >= 6) return 'strong';
  if (n >= 4) return 'solid';
  return 'light';
}

// ─── Exports ──────────────────────────────────────────────────

module.exports = {
  scanTjunction,
  TJUNCTION_SYMBOLS,
};
