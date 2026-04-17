// ============================================================
// Triple MA Sideways Strategy — Backtest-Tuned v3
//
// Runs ONLY during sideways market time (OUTSIDE institutional
// session windows). Uses 3 MAs on 5m candles to detect
// directional alignment and enter from value zones.
//
// Symbols: BNBUSDT, SOLUSDT, ETHUSDT  (1000PEPE removed — too volatile, PF 0.92)
//
// Scenario A — MA20-Touch TP (BOTH LONG and SHORT):
//   MA20 on top    → LONG  at lowest  MA (MA5/MA10), TP when MA20 drops to entry
//   MA20 on bottom → SHORT at highest MA (MA5/MA10), TP when MA20 rises to entry
//   SL = -1% / +1% fixed (backtest: WR 58.3%, PF 2.83, edge +25%)
//   ATR(14) < 0.8% of price — only trade in genuinely sideways conditions
//   BNB: 84.6% WR | SOL: 60.8% WR | ETH: 83.3% WR
//
// Scenario B — Bullish Alignment Dip-Buy:
//   MA20 < MA5 && MA20 < MA10 + RSI(14) < 45 + price at/below lower BB
//   LONG only — trailing SL every +5% gain → SL moves to +2.5% from entry
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const REQUEST_TIMEOUT = 15000;

// 1000PEPE removed — backtested PF 0.92 (losing) due to extreme volatility
// BNB/SOL/ETH: WR 60-84%, PF 3-9 with MA20-touch TP + 1% SL
const TRIPLE_MA_SYMBOLS = ['BNBUSDT', 'SOLUSDT', 'ETHUSDT'];

const LEVERAGE_MAP = {
  'BNBUSDT':  20,
  'SOLUSDT':  20,
  'ETHUSDT':  50,
};

const MA_FAST   = 5;
const MA_MED    = 10;
const MA_SLOW   = 20;
const SIZE_PCT  = 0.10; // 10% of capital per trade

// Entry tolerance: price must be within 0.5% of the MA level to enter (no chasing)
const SCENARIO_A_TOLERANCE = 0.005;

// SL=1% is the backtest winner: WR 58.3%, PF 2.83, edge +25% above break-even
// TP is DYNAMIC — close when MA20 crosses back to entry price (no fixed % target)
const SCENARIO_A_SL_PCT = 0.010;

// ATR range filter: only enter Scenario A when market is truly sideways
// 14-bar ATR must be < 0.8% of price — filters out trending/volatile sessions
const ATR_PERIOD    = 14;
const ATR_MAX_PCT   = 0.008; // 0.8% ATR-to-price threshold

// Scenario B: RSI threshold — backtest shows RSI<45 gives 81.8% WR in bullish alignment
// RSI<30 was too strict (zero trades fired in backtests)
const RSI_PERIOD    = 14;
const RSI_OVERSOLD  = 45;
// Bollinger Band period and std deviation
const BB_PERIOD     = 20;
const BB_STD        = 2;

// Scenario B trailing SL tiers (price-based from entry):
// Every 5% gain in price → SL moves to halfway (2.5%) of that gain.
const TRIPLE_MA_B_TIERS = [
  { trigger: 0.050, move_sl_to: 0.025 },
  { trigger: 0.100, move_sl_to: 0.075 },
  { trigger: 0.150, move_sl_to: 0.125 },
  { trigger: 0.200, move_sl_to: 0.175 },
  { trigger: 0.250, move_sl_to: 0.225 },
  { trigger: 0.300, move_sl_to: 0.275 },
];

// ── Helpers ──────────────────────────────────────────────────

function calcSMA(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(data.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Average True Range — true ATR using high/low/prev-close.
// Close-to-close differences understate volatility on spike/gap candles.
// TR = max(high-low, |high-prevClose|, |low-prevClose|)
function calcATR(closes, highs, lows, period) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const tr = Math.max(
      highs[i]  - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function calcBollingerBands(closes, period, stdMult) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + stdMult * std, middle: mean, lower: mean - stdMult * std };
}

async function fetchKlines(symbol, interval, limit) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Main Scan ────────────────────────────────────────────────

async function scanTripleMA(log) {
  // Only trade OUTSIDE institutional session windows.
  // Session windows belong to SMC strategy — Triple MA is sideways only.
  const { getActiveSession } = require('./liquidity-sweep-engine');
  const session = getActiveSession();
  if (session) {
    return []; // SMC handles this window
  }

  log('Triple MA: sideways window active — scanning 4 tokens...');

  const signals = [];

  for (const symbol of TRIPLE_MA_SYMBOLS) {
    try {
      const klines = await fetchKlines(symbol, '5m', 100);
      if (!klines || klines.length < BB_PERIOD + 5) {
        log(`Triple MA: ${symbol} insufficient candles`);
        continue;
      }

      const closes = klines.map(k => parseFloat(k[4]));
      const highs  = klines.map(k => parseFloat(k[2]));
      const lows   = klines.map(k => parseFloat(k[3]));
      const price  = closes[closes.length - 1];

      const ma5  = calcSMA(closes, MA_FAST);
      const ma10 = calcSMA(closes, MA_MED);
      const ma20 = calcSMA(closes, MA_SLOW);
      const rsi  = calcRSI(closes, RSI_PERIOD);
      const bb   = calcBollingerBands(closes, BB_PERIOD, BB_STD);
      const atr  = calcATR(closes, highs, lows, ATR_PERIOD);

      if (!ma5 || !ma10 || !ma20) continue;

      // ATR range filter for Scenario A: only enter when market is genuinely sideways
      // ATR < 0.8% of price = low volatility = mean-reversion works; above = trending, skip
      const atrPct  = atr ? atr / price : 1;
      const isSideways = atrPct < ATR_MAX_PCT;

      log(`${symbol}: MA5=$${ma5.toFixed(4)} MA10=$${ma10.toFixed(4)} MA20=$${ma20.toFixed(4)} RSI=${rsi?.toFixed(1)} ATR=${(atrPct*100).toFixed(3)}% ${isSideways?'✓sideways':'✗trending'} price=$${price}`);

      // ── Scenario A LONG: Bearish Alignment (MA20 on top) ────────
      // MA20 highest, fast MAs at bottom → LONG at lowest MA level
      // TP: when MA20 drops down to entry price (lines converge)
      // SL: 1% fixed below entry | Backtest: WR 60-84% per symbol
      if (ma20 > ma5 && ma20 > ma10 && isSideways) {
        const lowestMA   = Math.min(ma5, ma10);
        const distAbove  = (price - lowestMA) / lowestMA;

        if (distAbove > SCENARIO_A_TOLERANCE) {
          log(`${symbol}: A-LONG — price ${(distAbove*100).toFixed(2)}% above MA level, waiting`);
        } else if (price < lowestMA * 0.992) {
          log(`${symbol}: A-LONG — price broke below MA support, skip`);
        } else {
          const entryPrice = price;
          const slPrice    = entryPrice * (1 - SCENARIO_A_SL_PCT);
          const leverage   = LEVERAGE_MAP[symbol];
          signals.push({
            symbol,
            direction:       'LONG',
            scenario:        'A',
            price:           entryPrice,
            lastPrice:       price,
            tp1:             null,      // TP is dynamic: MA20 drops to entry
            tp2:             null,
            tp3:             null,
            sl:              slPrice,
            slDist:          SCENARIO_A_SL_PCT,
            leverage,
            sizePct:         SIZE_PCT,
            setup:           'TRIPLE_MA_A',
            setupName:       'Triple MA A — LONG (MA20-touch TP)',
            score:           16,
            ema200Bias:      null,
            marketStructure: `TRIPLE_MA_A_LONG ma5=${ma5.toFixed(2)} ma10=${ma10.toFixed(2)} ma20=${ma20.toFixed(2)} atr=${(atrPct*100).toFixed(3)}%`,
            ma20ExitLevel:   entryPrice,
          });
          log(`${symbol}: A-LONG $${entryPrice.toFixed(4)} SL=$${slPrice.toFixed(4)} | TP = MA20 drops to entry (dynamic)`);
        }

      // ── Scenario A SHORT: Bullish Alignment (MA20 on bottom) → SHORT ─────
      // MA20 lowest, fast MAs at top → SHORT at highest MA level
      // TP: when MA20 rises up to entry price (lines converge)
      // SL: 1% fixed above entry | Backtest: part of 58.3% combined WR
      } else if (ma20 < ma5 && ma20 < ma10 && isSideways) {
        const highestMA  = Math.max(ma5, ma10);
        const distBelow  = (highestMA - price) / highestMA;

        if (distBelow > SCENARIO_A_TOLERANCE) {
          log(`${symbol}: A-SHORT — price ${(distBelow*100).toFixed(2)}% below MA level, waiting`);
        } else if (price > highestMA * 1.008) {
          log(`${symbol}: A-SHORT — price broke above MA resistance, skip`);
        } else {
          const entryPrice = price;
          const slPrice    = entryPrice * (1 + SCENARIO_A_SL_PCT);
          const leverage   = LEVERAGE_MAP[symbol];
          signals.push({
            symbol,
            direction:       'SHORT',
            scenario:        'A',
            price:           entryPrice,
            lastPrice:       price,
            tp1:             null,      // TP is dynamic: MA20 rises to entry
            tp2:             null,
            tp3:             null,
            sl:              slPrice,
            slDist:          SCENARIO_A_SL_PCT,
            leverage,
            sizePct:         SIZE_PCT,
            setup:           'TRIPLE_MA_A',
            setupName:       'Triple MA A — SHORT (MA20-touch TP)',
            score:           16,
            ema200Bias:      null,
            marketStructure: `TRIPLE_MA_A_SHORT ma5=${ma5.toFixed(2)} ma10=${ma10.toFixed(2)} ma20=${ma20.toFixed(2)} atr=${(atrPct*100).toFixed(3)}%`,
            ma20ExitLevel:   entryPrice,
          });
          log(`${symbol}: A-SHORT $${entryPrice.toFixed(4)} SL=$${slPrice.toFixed(4)} | TP = MA20 rises to entry (dynamic)`);
        }

      // ── Scenario B: RSI dip-buy in uptrend (non-sideways, MA20 bottom) ──
      } else if (ma20 < ma5 && ma20 < ma10) {
        if (!rsi || !bb) continue;

        // Only enter on extreme oversold dip (RSI < 30 AND price at/below lower BB)
        const atLowerBB = price <= bb.lower * 1.005; // within 0.5% of lower band
        if (rsi >= RSI_OVERSOLD || !atLowerBB) {
          log(`${symbol}: Scenario B — RSI=${rsi?.toFixed(1)} BB_lower=$${bb?.lower.toFixed(4)} price=$${price} — not oversold enough, waiting`);
          continue;
        }

        const entryPrice = price;
        const leverage   = LEVERAGE_MAP[symbol];

        signals.push({
          symbol,
          direction:        'LONG',
          scenario:         'B',
          price:            entryPrice,
          lastPrice:        price,
          tp1:              null, // no fixed TP — trailing SL handles exit
          tp2:              null,
          tp3:              null,
          sl:               entryPrice * (1 - 0.030), // 3% emergency SL — trailing tightens it
          slDist:           0.025,
          leverage,
          sizePct:          SIZE_PCT,
          setup:            'TRIPLE_MA_B',
          setupName:        'Triple MA Sideways B',
          score:            14,
          ema200Bias:       null, // bypass EMA200 gate for this strategy
          marketStructure:  `TRIPLE_MA_B ma5=${ma5.toFixed(2)} ma10=${ma10.toFixed(2)} ma20=${ma20.toFixed(2)} rsi=${rsi.toFixed(1)} bb_lower=${bb.lower.toFixed(4)}`,
          noHardSL:         true,      // trailing SL only
          trailTiers:       'TRIPLE_MA_B',
        });

        log(`${symbol}: Triple MA Scenario B — LONG at $${entryPrice.toFixed(4)} RSI=${rsi.toFixed(1)} BB_lower=$${bb.lower.toFixed(4)} (trailing SL every 5%)`);

      } else {
        // Mixed alignment — market direction unclear → no trade
        log(`${symbol}: Triple MA — mixed MA alignment, direction unclear — waiting`);
      }
    } catch (err) {
      log(`Triple MA: ${symbol} error — ${err.message}`);
    }
  }

  return signals;
}

// ── Scenario A Exit Monitor ───────────────────────────────────
// LONG: exit when MA20 drops to (<=) entry — lines converge from above.
// SHORT: exit when MA20 rises to (>=) entry — lines converge from below.
async function shouldExitScenarioA(symbol, entryPrice, direction = 'LONG') {
  try {
    const klines = await fetchKlines(symbol, '5m', 25);
    if (!klines || klines.length < MA_SLOW) return false;

    const closes = klines.map(k => parseFloat(k[4]));
    const ma20   = calcSMA(closes, MA_SLOW);
    if (!ma20) return false;

    const touched = direction === 'SHORT'
      ? ma20 >= entryPrice   // MA20 rose up to entry
      : ma20 <= entryPrice;  // MA20 dropped down to entry

    if (touched) {
      const verb = direction === 'SHORT' ? 'rose' : 'dropped';
      bLog.trade(`Triple MA Scenario A ${direction}: ${symbol} MA20=$${ma20.toFixed(4)} ${verb} to entry=$${entryPrice.toFixed(4)} — exit signal`);
    }
    return touched;
  } catch {
    return false;
  }
}

// ── Trailing SL Calculator for Scenario B ────────────────────
// Every 5% price gain → SL moves to 2.5% mark.
// Returns null if no step change needed.
function calcTripleMABTrailStep(entryPrice, currentPrice, lastStepPct) {
  const pricePct = (currentPrice - entryPrice) / entryPrice;
  if (pricePct <= 0) return null;

  let bestTier = null;
  for (const tier of TRIPLE_MA_B_TIERS) {
    if (pricePct >= tier.trigger && tier.move_sl_to > lastStepPct) {
      bestTier = tier;
    }
  }
  if (!bestTier) return null;

  const newSlPrice = entryPrice * (1 + bestTier.move_sl_to);
  return {
    newSlPrice,
    newLastStep: bestTier.move_sl_to,
    trigger:     bestTier.trigger,
  };
}

module.exports = {
  scanTripleMA,
  shouldExitScenarioA,
  calcTripleMABTrailStep,
  TRIPLE_MA_SYMBOLS,
  LEVERAGE_MAP,
  TRIPLE_MA_B_TIERS,
  SCENARIO_A_SL_PCT,
};
