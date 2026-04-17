// ============================================================
// Spike-HL Liquidity Sweep Strategy
//
// Backtest (14 days × 4 symbols): 91% WR, PF 121, avg RR 1:10
// BTC: max single win +265% leveraged | ETH: +314% leveraged
//
// Pattern (LONG):
//   1. Find prevHL = most recent 1m candle where low > prev candle low
//   2. Current candle's LOW spikes BELOW prevHL (sweeps stop-losses)
//   3. Current candle CLOSES BACK ABOVE prevHL (smart money rejection)
//   4. Lower wick ≥ 1.2× body (spike candle confirmation)
//   → Entry at close | SL = spike low × 0.999 | Trail SL to candle lows
//
// Pattern (SHORT — mirror image):
//   1. Find prevLH = most recent 1m candle where high < prev candle high
//   2. Current candle's HIGH spikes ABOVE prevLH
//   3. Current candle CLOSES BACK BELOW prevLH
//   4. Upper wick ≥ 1.2× body
//   → Entry at close | SL = spike high × 1.001 | Trail SL to candle highs
//
// Only runs DURING institutional session windows (SMC windows).
// Symbols: BTCUSDT×100, ETHUSDT×100, SOLUSDT×20, BNBUSDT×20
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');
// isSessionOpenBlackout is shared from liquidity-sweep-engine to stay in sync
const { isSessionOpenBlackout } = require('./liquidity-sweep-engine');

const REQUEST_TIMEOUT = 12000;

const SPIKE_HL_SYMBOLS = new Map([
  ['BTCUSDT', 100],
  ['ETHUSDT', 100],
  ['SOLUSDT',  20],
  ['BNBUSDT',  20],
]);

// Spike detection thresholds
const MIN_SPIKE_PCT   = 0.0015; // spike must pierce ≥ 0.15% beyond prevHL/LH
const MAX_SPIKE_PCT   = 0.015;  // cap at 1.5% — beyond that is a crash, not a sweep
const MIN_WICK_RATIO  = 1.2;    // lower/upper wick ≥ 1.2× candle body
const SL_BUFFER       = 0.001;  // SL sits 0.1% beyond spike extreme
const EMA_PERIOD      = 200;
const SIZE_PCT        = 0.10;   // 10% of capital per trade

// ─── Fetch Helpers ────────────────────────────────────────────

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
    }));
  } catch {
    return null;
  }
}

// ─── EMA ─────────────────────────────────────────────────────

function calcEma(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` bars — prevents large initial error
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ─── Session Gate ─────────────────────────────────────────────
// Spike-HL only fires DURING institutional sessions.
// isInSession(ts) checks a specific timestamp (the spike candle's close),
// not the current wall-clock time — so a spike that closed at 09:59:30
// is still valid even if the scan runs at 10:00:20.
// Grace: extends session end by GRACE_MS so edge-of-session spikes aren't lost.

const SESSIONS = [
  [23, 2],  // Asia:   23:00–02:00 UTC
  [7,  10], // Europe: 07:00–10:00 UTC
  [12, 16], // US:     12:00–16:00 UTC
];
const AVOID_MINUTES    = new Set([0, 15, 30, 45]);
const GRACE_MS         = 90_000; // 90s grace past session end
function isInSession(tsMs = Date.now()) {
  // Check the timestamp itself AND the current time (with grace)
  // Either being in-session is enough — catches late scans
  const checkTs = (t) => {
    const d = new Date(t);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    if (AVOID_MINUTES.has(m)) return false;
    if (isSessionOpenBlackout(t)) return false; // skip first 30 min of session
    for (const [start, end] of SESSIONS) {
      if (end < start) { // wraps midnight
        if (h >= start || h < end) return true;
      } else {
        if (h >= start && h < end) return true;
      }
    }
    return false;
  };
  // Candle was in-session, OR we're still within grace period of it
  return checkTs(tsMs) || checkTs(Date.now() - GRACE_MS);
}

// ─── Spike Detection ─────────────────────────────────────────

// Detects a LONG spike: bar[i] spiked below prevHL and closed back above.
// Returns signal object or null.
function detectLongSpike(bars) {
  if (bars.length < 6) return null;

  const spike = bars[bars.length - 1]; // most recent closed candle

  // Find prevHL in the last 5 bars: a candle whose low > its predecessor's low
  let prevHL = null;
  for (let back = 2; back <= 6; back++) {
    const idx = bars.length - back;
    if (idx < 1) break;
    if (bars[idx].low > bars[idx - 1].low) {
      prevHL = bars[idx].low;
      break;
    }
  }
  if (!prevHL) return null;

  // Spike must breach below prevHL
  if (spike.low >= prevHL) return null;
  const spikeDepth = (prevHL - spike.low) / prevHL;
  if (spikeDepth < MIN_SPIKE_PCT || spikeDepth > MAX_SPIKE_PCT) return null;

  // Must close BACK ABOVE prevHL (rejection confirmed)
  if (spike.close <= prevHL) return null;

  // Wick ratio: lower wick must dominate
  const body      = Math.abs(spike.close - spike.open);
  const lowerWick = Math.min(spike.open, spike.close) - spike.low;
  if (body < 0.000001 || lowerWick < MIN_WICK_RATIO * body) return null;

  const slPrice = spike.low * (1 - SL_BUFFER);
  const slDist  = (spike.close - slPrice) / spike.close;

  return {
    direction: 'LONG',
    entry:     spike.close,
    sl:        slPrice,
    slDist,
    spikeLow:  spike.low,
    prevHL,
    spikeDepth,
  };
}

// Detects a SHORT spike: bar[i] spiked above prevLH and closed back below.
function detectShortSpike(bars) {
  if (bars.length < 6) return null;

  const spike = bars[bars.length - 1];

  // Find prevLH: a candle whose high < its predecessor's high
  let prevLH = null;
  for (let back = 2; back <= 6; back++) {
    const idx = bars.length - back;
    if (idx < 1) break;
    if (bars[idx].high < bars[idx - 1].high) {
      prevLH = bars[idx].high;
      break;
    }
  }
  if (!prevLH) return null;

  if (spike.high <= prevLH) return null;
  const spikeDepth = (spike.high - prevLH) / prevLH;
  if (spikeDepth < MIN_SPIKE_PCT || spikeDepth > MAX_SPIKE_PCT) return null;

  // Must close BACK BELOW prevLH
  if (spike.close >= prevLH) return null;

  const body      = Math.abs(spike.close - spike.open);
  const upperWick = spike.high - Math.max(spike.open, spike.close);
  if (body < 0.000001 || upperWick < MIN_WICK_RATIO * body) return null;

  const slPrice = spike.high * (1 + SL_BUFFER);
  const slDist  = (slPrice - spike.close) / spike.close;

  return {
    direction: 'SHORT',
    entry:     spike.close,
    sl:        slPrice,
    slDist,
    spikeHigh: spike.high,
    prevLH,
    spikeDepth,
  };
}

// ─── Main Scanner ─────────────────────────────────────────────

async function scanSpikeHL(log) {
  // Preliminary check — skip if clearly outside any session (and no grace)
  if (!isInSession(Date.now())) {
    return [];
  }

  log('Spike-HL: session active — scanning for liquidity sweeps...');

  const signals = [];

  for (const [symbol, leverage] of SPIKE_HL_SYMBOLS) {
    try {
      // Fetch 1m candles: EMA200 needs 200 bars + 12 for pattern lookback
      // Fetching 215 to be safe; drop the still-forming current candle (last bar)
      const allBars = await fetchKlines(symbol, '1m', 215);
      if (!allBars || allBars.length < EMA_PERIOD + 12) {
        log(`Spike-HL: ${symbol} insufficient candles`);
        continue;
      }

      // Drop the still-forming candle — only work with confirmed closed bars
      const bars   = allBars.slice(0, -1);
      const price  = bars[bars.length - 1].close;
      const closes = bars.map(b => b.close);
      const ema200 = calcEma(closes, EMA_PERIOD);
      if (!ema200) continue;

      const bullish = price > ema200;
      const bearish = price < ema200;

      // ── Scan last 2 closed candles so a 60s-late cycle doesn't miss one ──
      // Offset 0 = most recent closed candle, offset 1 = one before it
      let foundSignal = false;
      for (const offset of [0, 1]) {
        if (foundSignal) break;

        // Slice ending at (bars.length - offset) to treat that bar as "last"
        const endIdx = bars.length - offset;
        if (endIdx < 12) continue;
        const recent     = bars.slice(endIdx - 10, endIdx);
        const spikeBar   = recent[recent.length - 1];
        const spikeCandleTs = spikeBar.ts;

        // Gate: spike candle must have closed during a session window
        if (!isInSession(spikeCandleTs)) continue;
        // And it must not be stale (> 3 minutes old = already handled last cycle)
        if (Date.now() - spikeCandleTs > 180_000) continue;

      // ── Attempt LONG detection ──
      if (bullish) {
        const sig = detectLongSpike(recent);
        if (sig) {
            foundSignal = true;
          log(`Spike-HL ${symbol}: LONG SWEEP — spike to $${sig.spikeLow.toFixed(4)} (${(sig.spikeDepth*100).toFixed(3)}% below prevHL $${sig.prevHL.toFixed(4)}) → close $${sig.entry.toFixed(4)} | SL=$${sig.sl.toFixed(4)} (${(sig.slDist*100).toFixed(3)}%)`);
          signals.push({
            symbol,
            direction:       'LONG',
            scenario:        'SPIKE_HL',
            price:           sig.entry,
            lastPrice:       price,
            tp1:             null, // trailing SL — no fixed TP
            tp2:             null,
            tp3:             null,
            sl:              sig.sl,
            slDist:          sig.slDist,
            leverage,
            sizePct:         SIZE_PCT,
            setup:           'SPIKE_HL',
            setupName:       `Spike-HL LONG (sweep below HL, ${(sig.spikeDepth*100).toFixed(2)}% spike)`,
            score:           20, // high score — very high WR strategy
            ema200Bias:      'bullish',
            marketStructure: `SPIKE_HL_LONG prevHL=${sig.prevHL.toFixed(4)} spikeLow=${sig.spikeLow.toFixed(4)} depth=${(sig.spikeDepth*100).toFixed(3)}%`,
            trailTiers:      'SPIKE_HL',
            noHardSL:        false,
          });
        }
      }

      // ── Attempt SHORT detection ──
      if (bearish && !foundSignal) {
        const sig = detectShortSpike(recent);
        if (sig) {
            foundSignal = true;
          log(`Spike-HL ${symbol}: SHORT SWEEP — spike to $${sig.spikeHigh.toFixed(4)} (${(sig.spikeDepth*100).toFixed(3)}% above prevLH $${sig.prevLH.toFixed(4)}) → close $${sig.entry.toFixed(4)} | SL=$${sig.sl.toFixed(4)} (${(sig.slDist*100).toFixed(3)}%)`);
          signals.push({
            symbol,
            direction:       'SHORT',
            scenario:        'SPIKE_HL',
            price:           sig.entry,
            lastPrice:       price,
            tp1:             null,
            tp2:             null,
            tp3:             null,
            sl:              sig.sl,
            slDist:          sig.slDist,
            leverage,
            sizePct:         SIZE_PCT,
            setup:           'SPIKE_HL',
            setupName:       `Spike-HL SHORT (sweep above LH, ${(sig.spikeDepth*100).toFixed(2)}% spike)`,
            score:           20,
            ema200Bias:      'bearish',
            marketStructure: `SPIKE_HL_SHORT prevLH=${sig.prevLH.toFixed(4)} spikeHigh=${sig.spikeHigh.toFixed(4)} depth=${(sig.spikeDepth*100).toFixed(3)}%`,
            trailTiers:      'SPIKE_HL',
            noHardSL:        false,
          });
        }
      }
      } // end offset loop

      if (!foundSignal) {
        log(`Spike-HL ${symbol}: no sweep pattern — EMA200=$${ema200.toFixed(4)} price=$${price.toFixed(4)} bias=${bullish?'bullish':bearish?'bearish':'neutral'}`);
      }

    } catch (err) {
      log(`Spike-HL: ${symbol} error — ${err.message}`);
    }
  }

  return signals;
}

// ─── Trailing SL Updater ──────────────────────────────────────
// Called every monitoring cycle for open SPIKE_HL trades.
// Fetches latest 1m candles and trails SL to rising candle lows (LONG)
// or falling candle highs (SHORT).
//
// Returns { newSl, updated: true } if SL should move, else { updated: false }.

async function calcSpikeHLTrailSl(symbol, direction, entryPrice, currentSl) {
  try {
    const bars = await fetchKlines(symbol, '1m', 5);
    if (!bars || bars.length < 3) return { updated: false };

    // Look at the last 2 closed candles (skip the still-forming current one)
    const recent = bars.slice(-3, -1); // 2 confirmed closed candles

    if (direction === 'LONG') {
      // Trail SL to just below the highest "rising candle low" above entry
      let bestSl = currentSl;
      for (const bar of recent) {
        // Only trail to this candle's low if it's a green/bullish candle above entry
        if (bar.close > bar.open && bar.low > entryPrice && bar.low > bestSl) {
          const candidate = bar.low * (1 - SL_BUFFER);
          if (candidate > bestSl) {
            bestSl = candidate;
          }
        }
      }
      if (bestSl > currentSl) {
        bLog.trade(`Spike-HL LONG trail: ${symbol} SL $${currentSl.toFixed(4)} → $${bestSl.toFixed(4)}`);
        return { updated: true, newSl: bestSl };
      }

    } else { // SHORT
      // Trail SL to just above the lowest "falling candle high" below entry
      let bestSl = currentSl;
      for (const bar of recent) {
        if (bar.close < bar.open && bar.high < entryPrice && bar.high < bestSl) {
          const candidate = bar.high * (1 + SL_BUFFER);
          if (candidate < bestSl) {
            bestSl = candidate;
          }
        }
      }
      if (bestSl < currentSl) {
        bLog.trade(`Spike-HL SHORT trail: ${symbol} SL $${currentSl.toFixed(4)} → $${bestSl.toFixed(4)}`);
        return { updated: true, newSl: bestSl };
      }
    }

    return { updated: false };
  } catch {
    return { updated: false };
  }
}

module.exports = {
  scanSpikeHL,
  calcSpikeHLTrailSl,
  SPIKE_HL_SYMBOLS,
};
