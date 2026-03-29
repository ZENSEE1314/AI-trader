// ============================================================
// MCT Trading Strategy Engine
// Based on: MCT Trading Strategy PDF
// 3 Core Setups:
//   1. Break and Retest of Key Levels
//   2. Liquidity Grab and Reversal (Smart Money Concepts)
//   3. Trend Following Using VWAP as Dynamic Support/Resistance
// ============================================================

const fetch = require('node-fetch');

const REQUEST_TIMEOUT = 15000;

// ── Fetch helpers ────────────────────────────────────────────

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (res.ok) return res;
    } catch (_) {}
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

async function fetchKlines(symbol, interval, limit = 100) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;
  return res.json();
}

async function fetchTickers() {
  const res = await fetchWithRetry('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (!res) return [];
  return res.json();
}

// ── Technical Indicators ─────────────────────────────────────

function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / (losses / period)));
}

function calcVWAP(klines) {
  // VWAP = cumulative(typical_price * volume) / cumulative(volume)
  let cumTPV = 0, cumVol = 0;
  for (const k of klines) {
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const vol = parseFloat(k[5]);
    const tp = (high + low + close) / 3;
    cumTPV += tp * vol;
    cumVol += vol;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function calcATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const pClose = parseFloat(klines[i - 1][4]);
    trs.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── Key Levels: PDH, PDL, OP, PWH, PWL ──────────────────────

function getKeyLevels(dailyKlines, weeklyKlines) {
  const levels = {};

  if (dailyKlines && dailyKlines.length >= 2) {
    const prevDay = dailyKlines[dailyKlines.length - 2];
    const today = dailyKlines[dailyKlines.length - 1];
    levels.pdh = parseFloat(prevDay[2]); // Previous Day High
    levels.pdl = parseFloat(prevDay[3]); // Previous Day Low
    levels.op = parseFloat(today[1]);     // Today's Opening Price
  }

  if (weeklyKlines && weeklyKlines.length >= 2) {
    const prevWeek = weeklyKlines[weeklyKlines.length - 2];
    levels.pwh = parseFloat(prevWeek[2]); // Previous Week High
    levels.pwl = parseFloat(prevWeek[3]); // Previous Week Low
  }

  return levels;
}

// ── Swing Points Detection (for SL placement) ───────────────

function findSwingPoints(klines, lookback = 5) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const n = klines.length;

  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isHigh = false;
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) isLow = false;
    }
    if (isHigh) swingHighs.push({ idx: i, val: highs[i] });
    if (isLow) swingLows.push({ idx: i, val: lows[i] });
  }

  return { swingHighs, swingLows };
}

// ── Engulfing / Rejection Candle Detection ───────────────────

function hasRejection(klines, idx) {
  if (idx < 1 || idx >= klines.length) return null;
  const open = parseFloat(klines[idx][1]);
  const high = parseFloat(klines[idx][2]);
  const low = parseFloat(klines[idx][3]);
  const close = parseFloat(klines[idx][4]);
  const body = Math.abs(close - open);
  const range = high - low;
  if (range === 0) return null;

  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;

  // Bullish rejection: long lower wick, close near high
  if (lowerWick > body * 2 && close > open) return 'bullish';
  // Bearish rejection: long upper wick, close near low
  if (upperWick > body * 2 && close < open) return 'bearish';

  // Bullish engulfing
  const prevOpen = parseFloat(klines[idx - 1][1]);
  const prevClose = parseFloat(klines[idx - 1][4]);
  if (prevClose < prevOpen && close > open && close > prevOpen && open < prevClose) return 'bullish';
  // Bearish engulfing
  if (prevClose > prevOpen && close < open && close < prevOpen && open > prevClose) return 'bearish';

  return null;
}

// ── Volume Spike Detection ───────────────────────────────────

function hasVolumeSpike(klines, idx, avgPeriod = 20) {
  if (idx < avgPeriod) return false;
  const volumes = klines.slice(idx - avgPeriod, idx).map(k => parseFloat(k[5]));
  const avgVol = volumes.reduce((a, b) => a + b, 0) / avgPeriod;
  const curVol = parseFloat(klines[idx][5]);
  return curVol > avgVol * 1.5;
}

// ── Session Filter (London/NY overlap is best) ───────────────

function isGoodTradingSession() {
  const now = new Date();
  const utcH = now.getUTCHours();
  // Asia-Europe overlap: 07:00-10:00 UTC (3PM-6PM SGT)
  // Europe-US overlap: 12:00-16:00 UTC (8PM-12AM SGT) — BEST
  // Also allow Asia session: 23:00-02:00 UTC (7AM-10AM SGT)
  if (utcH >= 7 && utcH <= 10) return true;   // Asia-Europe
  if (utcH >= 12 && utcH <= 16) return true;  // Europe-US (peak)
  if (utcH >= 23 || utcH <= 2) return true;   // Asia
  return false;
}

// Avoid entries at round hours and quarter marks
function isAvoidTime() {
  const now = new Date();
  const min = now.getUTCMinutes();
  const hour = now.getUTCHours();
  // Avoid :00, :15, :30, :45 (give 2 min buffer)
  if (min <= 1 || (min >= 14 && min <= 16) || (min >= 29 && min <= 31) || (min >= 44 && min <= 46)) return true;
  // Avoid 8am, 12pm, 4pm, 8pm UTC
  if ([0, 4, 8, 12, 16, 20].includes(hour) && min <= 5) return true;
  return false;
}

// ── MCT Strategy: Analyze a single coin ──────────────────────

async function analyzeMCT(ticker) {
  try {
    const symbol = ticker.symbol;
    const price = parseFloat(ticker.lastPrice);

    // Fetch multi-timeframe data
    const [klines1d, klines1w, klines1h, klines15m, klines1m] = await Promise.all([
      fetchKlines(symbol, '1d', 5),
      fetchKlines(symbol, '1w', 3),
      fetchKlines(symbol, '1h', 50),
      fetchKlines(symbol, '15m', 100),
      fetchKlines(symbol, '1m', 60),
    ]);

    if (!klines15m || klines15m.length < 30 || !klines1h || klines1h.length < 20) return null;
    if (!klines1m || klines1m.length < 10) return null;

    // ── Key Levels ──
    const levels = getKeyLevels(klines1d, klines1w);
    if (!levels.pdh || !levels.pdl || !levels.op) return null;

    // ── VWAP (calculated from today's 1h bars) ──
    const todayKlines = klines1h.slice(-24); // last 24 hours
    const vwap = calcVWAP(todayKlines);
    if (!vwap) return null;

    // ── Trend Bias: price vs OP and VWAP ──
    const aboveOP = price > levels.op;
    const aboveVWAP = price > vwap;
    const bias = (aboveOP && aboveVWAP) ? 'long' : (!aboveOP && !aboveVWAP) ? 'short' : 'neutral';
    if (bias === 'neutral') return null; // MCT rule: don't trade between VWAP and OP

    // ── EMA 200 trend guide ──
    const closes1h = klines1h.map(k => parseFloat(k[4]));
    const ema200 = closes1h.length >= 50 ? calcEMA(closes1h, 50) : null; // use 50 on 1h ≈ 200 on 15m
    const ema7 = calcEMA(closes1h.slice(-20), 7);

    // ── RSI ──
    const closes15m = klines15m.map(k => parseFloat(k[4]));
    const rsi = calcRSI(closes15m);

    // RSI divergence check (bearish div = price making HH but RSI making LH)
    // Simplified: if RSI > 70 and bias is long, be cautious
    if (bias === 'long' && rsi > 75) return null;
    if (bias === 'short' && rsi < 25) return null;

    // ── ATR for SL sizing ──
    const atr = calcATR(klines15m, 14) || price * 0.01;

    // ── Swing Points on 15m for SL placement ──
    const swings = findSwingPoints(klines15m, 3);

    // ── Check which setup applies ──
    let setup = null;
    let entry = price;
    let sl = null;
    let direction = bias === 'long' ? 'LONG' : 'SHORT';
    let setupName = '';
    let score = 0;

    const keyLevelArr = [
      { name: 'PDH', val: levels.pdh },
      { name: 'PDL', val: levels.pdl },
      { name: 'OP', val: levels.op },
    ];
    if (levels.pwh) keyLevelArr.push({ name: 'PWH', val: levels.pwh });
    if (levels.pwl) keyLevelArr.push({ name: 'PWL', val: levels.pwl });

    const proximity = atr * 1.5; // how close price needs to be to a key level

    // Find nearest key level
    let nearestLevel = null;
    let nearestDist = Infinity;
    for (const lv of keyLevelArr) {
      const dist = Math.abs(price - lv.val);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestLevel = lv;
      }
    }

    // MCT rule: don't enter if not near key levels
    if (!nearestLevel || nearestDist > proximity * 2) return null;

    // ── Check 1m candles for confirmation ──
    const lastIdx = klines1m.length - 1;
    const rejection1m = hasRejection(klines1m, lastIdx);
    const volSpike1m = hasVolumeSpike(klines1m, lastIdx);

    // ── Setup 1: Break and Retest ──
    // Price broke a key level and is retesting it
    for (const lv of keyLevelArr) {
      const dist = Math.abs(price - lv.val);
      if (dist > proximity) continue;

      if (bias === 'long' && price > lv.val && price - lv.val < proximity) {
        // Price broke above and is retesting from above (support)
        if (rejection1m === 'bullish' || volSpike1m) {
          setup = 'break_retest';
          setupName = `Break & Retest of ${lv.name} ($${lv.val.toFixed(2)})`;
          sl = lv.val - atr * 0.5; // SL below the level
          score = 8;
          if (volSpike1m) score += 2;
          if (rejection1m === 'bullish') score += 3;
          break;
        }
      }
      if (bias === 'short' && price < lv.val && lv.val - price < proximity) {
        // Price broke below and is retesting from below (resistance)
        if (rejection1m === 'bearish' || volSpike1m) {
          setup = 'break_retest';
          setupName = `Break & Retest of ${lv.name} ($${lv.val.toFixed(2)})`;
          sl = lv.val + atr * 0.5;
          score = 8;
          if (volSpike1m) score += 2;
          if (rejection1m === 'bearish') score += 3;
          break;
        }
      }
    }

    // ── Setup 2: Liquidity Grab and Reversal ──
    if (!setup) {
      // Check if price spiked beyond a key level and reversed (false breakout)
      for (const lv of keyLevelArr) {
        const klines5m = klines1m.slice(-12); // last ~12 minutes of 1m bars
        const recentHigh = Math.max(...klines5m.map(k => parseFloat(k[2])));
        const recentLow = Math.min(...klines5m.map(k => parseFloat(k[3])));

        // Bullish liquidity grab: price spiked below level and came back above
        if (bias === 'long' && recentLow < lv.val && price > lv.val) {
          if (rejection1m === 'bullish') {
            setup = 'liquidity_grab';
            setupName = `Liquidity Grab below ${lv.name} ($${lv.val.toFixed(2)})`;
            sl = recentLow - atr * 0.3; // SL below the spike
            score = 9;
            if (volSpike1m) score += 2;
            break;
          }
        }

        // Bearish liquidity grab: price spiked above level and came back below
        if (bias === 'short' && recentHigh > lv.val && price < lv.val) {
          if (rejection1m === 'bearish') {
            setup = 'liquidity_grab';
            setupName = `Liquidity Grab above ${lv.name} ($${lv.val.toFixed(2)})`;
            sl = recentHigh + atr * 0.3;
            score = 9;
            if (volSpike1m) score += 2;
            break;
          }
        }
      }
    }

    // ── Setup 3: VWAP Trend Follow ──
    if (!setup) {
      const vwapDist = Math.abs(price - vwap);
      if (vwapDist < proximity) {
        if (bias === 'long' && price >= vwap && rejection1m === 'bullish') {
          setup = 'vwap_trend';
          setupName = `VWAP Trend Follow (Long) — VWAP $${vwap.toFixed(2)}`;
          sl = vwap - atr * 0.5;
          score = 7;
          if (volSpike1m) score += 2;
          // Bonus if EMA7 supports
          if (ema7 && price > ema7) score += 1;
        }
        if (bias === 'short' && price <= vwap && rejection1m === 'bearish') {
          setup = 'vwap_trend';
          setupName = `VWAP Trend Follow (Short) — VWAP $${vwap.toFixed(2)}`;
          sl = vwap + atr * 0.5;
          score = 7;
          if (volSpike1m) score += 2;
          if (ema7 && price < ema7) score += 1;
        }
      }
    }

    if (!setup) return null;

    // ── TP: 1:3 RR from SL distance, or next key level ──
    const slDist = Math.abs(entry - sl);
    const isLong = direction === 'LONG';

    // Find next key level as TP target
    let tpTarget = null;
    for (const lv of keyLevelArr) {
      if (isLong && lv.val > entry + slDist) {
        if (!tpTarget || lv.val < tpTarget) tpTarget = lv.val;
      }
      if (!isLong && lv.val < entry - slDist) {
        if (!tpTarget || lv.val > tpTarget) tpTarget = lv.val;
      }
    }

    const tp1 = isLong ? entry + slDist * 1.5 : entry - slDist * 1.5; // 1:1.5 RR
    const tp2 = isLong ? entry + slDist * 2.5 : entry - slDist * 2.5; // 1:2.5 RR
    const tp3 = tpTarget || (isLong ? entry + slDist * 3.5 : entry - slDist * 3.5); // next level or 1:3.5

    const slPct = (slDist / entry * 100).toFixed(2);
    const tp1Pct = (Math.abs(tp1 - entry) / entry * 100).toFixed(2);
    const tp2Pct = (Math.abs(tp2 - entry) / entry * 100).toFixed(2);
    const tp3Pct = (Math.abs(tp3 - entry) / entry * 100).toFixed(2);

    return {
      symbol, lastPrice: price,
      signal: direction === 'LONG' ? 'BUY' : 'SELL',
      direction, setup, setupName, score,
      entry, sl, tp1, tp2, tp3,
      slPct, tp1Pct, tp2Pct, tp3Pct,
      bias, vwap,
      levels, rsi: rsi.toFixed(0),
      ema200, ema7,
      atr, rejection: rejection1m, volSpike: volSpike1m,
      chg24h: parseFloat(ticker.priceChangePercent),
      timeframe: '15m/1m',
    };
  } catch (err) {
    return null;
  }
}

// ── Daily trade counter (resets each day) ────────────────────
let dailyTrades = 0;
let dailyLosses = 0;
let tradeDate = new Date().toISOString().slice(0, 10);

function checkDailyLimits() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== tradeDate) {
    dailyTrades = 0;
    dailyLosses = 0;
    tradeDate = today;
  }
  // Max 2 trades per day (MCT rule)
  if (dailyTrades >= 2) return 'max_trades';
  // Stop after 2 consecutive losses (MCT rule)
  if (dailyLosses >= 2) return '2_losses';
  return null;
}

function recordTrade(isWin) {
  dailyTrades++;
  if (!isWin) dailyLosses++;
  else dailyLosses = 0; // reset consecutive losses on win
}

// ── Main scan function ───────────────────────────────────────

async function scanMCT(log = console.log) {
  // Check daily limits
  const limitCheck = checkDailyLimits();
  if (limitCheck === 'max_trades') {
    log('MCT: Daily trade limit reached (2/2). Waiting for tomorrow.');
    return [];
  }
  if (limitCheck === '2_losses') {
    log('MCT: 2 consecutive losses today. Stopped trading. Waiting for tomorrow.');
    return [];
  }

  // Check trading session
  if (!isGoodTradingSession()) {
    log('MCT: Outside active trading session. Waiting for London/NY overlap.');
    return [];
  }

  // Check avoid times
  if (isAvoidTime()) {
    log('MCT: Avoiding round-number entry time. Will check again next cycle.');
    return [];
  }

  const tickers = await fetchTickers();
  if (!tickers.length) return [];

  // Top 30 by volume
  const top30 = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => parseFloat(t.quoteVolume) > 100e6) // $100M+ volume
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 30);

  log(`MCT: Analyzing ${top30.length} coins...`);

  const results = [];
  for (const ticker of top30) {
    const r = await analyzeMCT(ticker);
    if (r && r.score >= 8) {
      results.push(r);
      log(`  MCT signal: ${r.symbol} ${r.direction} score=${r.score} setup=${r.setup}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3); // max 3 signals per scan
}

module.exports = { scanMCT, analyzeMCT, recordTrade, checkDailyLimits, isGoodTradingSession };
