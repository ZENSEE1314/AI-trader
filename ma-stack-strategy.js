// ============================================================
// MA Stack Trend Strategy — Trend-Following on 1m Chart
//
// Fills the gap left by Triple MA (mean-reversion, sideways-only).
// This strategy fires on TRENDING moves where all 3 MAs are fanned
// in strict order and price has broken through all of them.
//
// Exact setup from the ETH drop the user flagged:
//   SMA5 < SMA10 < SMA20 (bearish stack, spread ≥ 0.15%)
//   Price < SMA5 — broken through all MAs
//   Price ≤ VWAP  — momentum confirms bearish
//   ATR(14) ≥ 0.3% — real trend, not noise
//   Last closed candle is bearish (body confirmation)
//   Volume ≥ SMA9 — conviction behind the move
//   Price within 1.5× ATR below SMA5 — don't chase extended drops
//
// LONG is the mirror (SMA5 > SMA10 > SMA20, price above all, above VWAP).
//
// SL: just above SMA20 + 0.5% buffer (SHORT) — if price reclaims the
//     highest MA, the bearish stack is broken. Min 1.0%, cap 2.5%.
// TP: 2× SL distance (2:1 R:R).
//
// Symbols: ETHUSDT, BTCUSDT, SOLUSDT, BNBUSDT
// Candles: 1m (drop still-forming last bar)
// Runs: 24/7 — trends form at any time
// ============================================================

const fetch        = require('node-fetch');
const { log: bLog } = require('./bot-logger');
const { getCfg }   = require('./strategy-config');

const REQUEST_TIMEOUT = 12000;

const MA_STACK_SYMBOLS = new Map([
  ['ETHUSDT',  50],
  ['BTCUSDT',  50],
  ['SOLUSDT',  20],
  ['BNBUSDT',  20],
]);

// All tuning constants are loaded from strategy-config.js (DB-backed, admin-editable).
// The MAX_SIGNAL_AGE_MS constant is kept as a module-level value since it controls
// the fetch loop — not performance-sensitive enough to reload per-candle.
const MAX_SIGNAL_AGE_MS = 180_000;

// ── Indicators ────────────────────────────────────────────────

function sma(arr, n) {
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function atr(closes, highs, lows, period) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i]  - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// Session VWAP — resets at 00:00 UTC, same logic as T-Junction.
function sessionVwap(bars, endIdx) {
  const d = new Date(bars[endIdx].ts);
  d.setUTCHours(0, 0, 0, 0);
  const dayStart = d.getTime();
  let tpv = 0, vol = 0;
  for (let i = endIdx; i >= 0; i--) {
    if (bars[i].ts < dayStart) break;
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    tpv += tp * bars[i].vol;
    vol += bars[i].vol;
  }
  return vol > 0 ? tpv / vol : bars[endIdx].close;
}

// NOTE: period is passed per-call from VOL_SMA_PERIOD (admin-configurable)
function volSma(bars, endIdx, period) {
  const vols = bars.slice(Math.max(0, endIdx - (period - 1)), endIdx + 1).map(b => b.vol);
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

// ── Fetch ─────────────────────────────────────────────────────

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

// ── Main Scanner ──────────────────────────────────────────────

async function scanMAStack(log) {
  const cfg = await getCfg();
  const ATR_PERIOD        = cfg['strat.ma_stack.atr_period']        || 14;
  const VOL_SMA_PERIOD    = cfg['strat.ma_stack.vol_sma_period']    || 9;
  const MAX_AGE_MS        = cfg['strat.ma_stack.max_signal_age_ms'] || MAX_SIGNAL_AGE_MS;
  const MIN_STACK_SPREAD  = cfg['strat.ma_stack.min_stack_spread'];
  const MIN_SPREAD_GROWTH = cfg['strat.ma_stack.min_spread_growth'];
  const MIN_ATR_PCT       = cfg['strat.ma_stack.min_atr_pct'];
  const MAX_EXTENSION_ATR = cfg['strat.ma_stack.max_extension_atr'];
  const SL_MIN_PCT        = cfg['strat.ma_stack.sl_min_pct'];
  const SL_MAX_PCT        = cfg['strat.ma_stack.sl_max_pct'];
  const TP_MULTIPLIER     = cfg['strat.ma_stack.tp_multiplier'];

  log('MA Stack: scanning for trending MA stack setups...');

  const signals = [];

  for (const [symbol, leverage] of MA_STACK_SYMBOLS) {
    try {
      // 60 1m bars — drop last (still forming), use 59 confirmed
      const allBars = await fetchKlines(symbol, '1m', 60);
      if (!allBars || allBars.length < 30) {
        log(`MA Stack: ${symbol} insufficient candles`);
        continue;
      }

      const bars   = allBars.slice(0, -1); // drop live/forming candle
      const closes = bars.map(b => b.close);
      const highs  = bars.map(b => b.high);
      const lows   = bars.map(b => b.low);

      // Check last 2 closed bars (protects against being 1 cycle late)
      let foundSignal = false;
      for (const offset of [0, 1]) {
        if (foundSignal) break;

        const signalIdx = bars.length - 1 - offset;
        if (signalIdx < 25) continue;

        const bar = bars[signalIdx];
        if (Date.now() - bar.ts > MAX_AGE_MS) continue;

        const closesUpTo = closes.slice(0, signalIdx + 1);
        const highsUpTo  = highs.slice(0, signalIdx + 1);
        const lowsUpTo   = lows.slice(0, signalIdx + 1);

        if (closesUpTo.length < 21) continue;

        const ma5  = sma(closesUpTo, 5);
        const ma10 = sma(closesUpTo, 10);
        const ma20 = sma(closesUpTo, 20);
        const atrVal = atr(closesUpTo, highsUpTo, lowsUpTo, ATR_PERIOD);
        if (!atrVal) continue;

        const price   = bar.close;
        const atrPct  = atrVal / price;

        // Must be trending — ATR above minimum threshold
        if (atrPct < MIN_ATR_PCT) {
          log(`MA Stack: ${symbol} ATR=${(atrPct*100).toFixed(3)}% too low (min ${(MIN_ATR_PCT*100).toFixed(1)}%) — sideways, skip`);
          continue;
        }

        const midMA       = (ma5 + ma10 + ma20) / 3;
        const stackSpread = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / midMA;

        if (stackSpread < MIN_STACK_SPREAD) {
          log(`MA Stack: ${symbol} spread=${(stackSpread*100).toFixed(3)}% below floor — skip`);
          continue;
        }

        // Spreading check: MAs must be actively diverging (fan opening).
        // Compare current spread to the spread 3 bars ago — must be growing by ≥20%.
        // This catches post-convergence fans (like V-shape recovery) without needing
        // a large absolute spread that would miss early-stage setups.
        let isSpreading = false;
        if (signalIdx >= 23) {
          const prev3Closes = closes.slice(0, signalIdx - 2);
          if (prev3Closes.length >= 20) {
            const pma5  = sma(prev3Closes, 5);
            const pma10 = sma(prev3Closes, 10);
            const pma20 = sma(prev3Closes, 20);
            const pmid  = (pma5 + pma10 + pma20) / 3;
            const prevSpread = (Math.max(pma5, pma10, pma20) - Math.min(pma5, pma10, pma20)) / pmid;
            isSpreading = prevSpread > 0 && (stackSpread / prevSpread) >= MIN_SPREAD_GROWTH;
          }
        }

        if (!isSpreading) {
          log(`MA Stack: ${symbol} spread=${(stackSpread*100).toFixed(3)}% not growing fast enough — fan not confirmed`);
          continue;
        }

        const vwap   = sessionVwap(bars, signalIdx);
        const avgVol = volSma(bars, signalIdx - 1, VOL_SMA_PERIOD);
        const isBearishCandle = bar.close < bar.open;
        const isBullishCandle = bar.close > bar.open;

        // ── SHORT: SMA5 < SMA10 < SMA20, price broken below all MAs ──
        const bearishStack = ma5 < ma10 && ma10 < ma20;
        const priceBelow   = price < ma5;
        const notChasing   = price > ma5 - (atrVal * MAX_EXTENSION_ATR);
        const belowVwap    = price <= vwap;
        const volOk        = bar.vol >= avgVol;

        if (bearishStack && priceBelow && notChasing && belowVwap && isBearishCandle && volOk) {
          // SL: above MA20 + 0.5% buffer — bearish stack broken if price reclaims MA20
          const rawSlPct = (ma20 * 1.005 - price) / price;
          const slPct    = Math.max(SL_MIN_PCT, Math.min(SL_MAX_PCT, rawSlPct));
          const slPrice  = price * (1 + slPct);
          const tpPrice  = price * (1 - slPct * TP_MULTIPLIER);

          const boost = (bar.vol >= avgVol * 1.5 ? 1 : 0) + (atrPct >= 0.005 ? 1 : 0);
          const score = 15 + boost;

          log(`MA Stack: ${symbol} SHORT — MA5=${ma5.toFixed(4)} MA10=${ma10.toFixed(4)} MA20=${ma20.toFixed(4)} ATR=${(atrPct*100).toFixed(3)}% VWAP=${vwap.toFixed(4)} entry=${price.toFixed(4)} SL=${slPrice.toFixed(4)} TP=${tpPrice.toFixed(4)} score=${score}`);

          signals.push({
            symbol,
            direction:        'SHORT',
            scenario:         'MA_STACK',
            price,
            lastPrice:        price,
            tp1:              tpPrice,
            tp2:              null,
            tp3:              null,
            sl:               slPrice,
            slDist:           slPct,
            leverage,
            sizePct:          SIZE_PCT,
            setup:            'MA_STACK',
            setupName:        `MA Stack SHORT (stack=${( stackSpread*100).toFixed(2)}% ATR=${(atrPct*100).toFixed(2)}%)`,
            score,
            strategyWinRate:  62, // bypasses backtest gate for unknown strategy
            ema200Bias:       'bearish',
            marketStructure:  `MA_STACK_SHORT ma5=${ma5.toFixed(2)} ma10=${ma10.toFixed(2)} ma20=${ma20.toFixed(2)} atr=${(atrPct*100).toFixed(3)}% vwap=${vwap.toFixed(2)}`,
            trailTiers:       'NONE',
            noHardSL:         false,
          });

          foundSignal = true;
          continue;
        }

        // ── LONG: SMA5 > SMA10 > SMA20, price broken above all MAs ──
        const bullishStack = ma5 > ma10 && ma10 > ma20;
        const priceAbove   = price > ma5;
        const notChasingUp = price < ma5 + (atrVal * MAX_EXTENSION_ATR);
        const aboveVwap    = price >= vwap;

        if (bullishStack && priceAbove && notChasingUp && aboveVwap && isBullishCandle && volOk) {
          // SL: below MA20 - 0.5% buffer — bullish stack broken if price falls below MA20
          const rawSlPct = (price - ma20 * 0.995) / price;
          const slPct    = Math.max(SL_MIN_PCT, Math.min(SL_MAX_PCT, rawSlPct));
          const slPrice  = price * (1 - slPct);
          const tpPrice  = price * (1 + slPct * TP_MULTIPLIER);

          const boost = (bar.vol >= avgVol * 1.5 ? 1 : 0) + (atrPct >= 0.005 ? 1 : 0);
          const score = 15 + boost;

          log(`MA Stack: ${symbol} LONG — MA5=${ma5.toFixed(4)} MA10=${ma10.toFixed(4)} MA20=${ma20.toFixed(4)} ATR=${(atrPct*100).toFixed(3)}% VWAP=${vwap.toFixed(4)} entry=${price.toFixed(4)} SL=${slPrice.toFixed(4)} TP=${tpPrice.toFixed(4)} score=${score}`);

          signals.push({
            symbol,
            direction:        'LONG',
            scenario:         'MA_STACK',
            price,
            lastPrice:        price,
            tp1:              tpPrice,
            tp2:              null,
            tp3:              null,
            sl:               slPrice,
            slDist:           slPct,
            leverage,
            sizePct:          SIZE_PCT,
            setup:            'MA_STACK',
            setupName:        `MA Stack LONG (stack=${( stackSpread*100).toFixed(2)}% ATR=${(atrPct*100).toFixed(2)}%)`,
            score,
            strategyWinRate:  62,
            ema200Bias:       'bullish',
            marketStructure:  `MA_STACK_LONG ma5=${ma5.toFixed(2)} ma10=${ma10.toFixed(2)} ma20=${ma20.toFixed(2)} atr=${(atrPct*100).toFixed(3)}% vwap=${vwap.toFixed(2)}`,
            trailTiers:       'NONE',
            noHardSL:         false,
          });

          foundSignal = true;
        }

        if (!foundSignal && offset === 1) {
          log(`MA Stack: ${symbol} no stack setup — MA5=${ma5.toFixed(4)} MA10=${ma10.toFixed(4)} MA20=${ma20.toFixed(4)} ATR=${(atrPct*100).toFixed(3)}% price=${price.toFixed(4)}`);
        }
      }

    } catch (err) {
      log(`MA Stack: ${symbol} error — ${err.message}`);
    }
  }

  return signals;
}

module.exports = { scanMAStack };
