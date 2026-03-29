// ============================================================
// SMC (Smart Money Concepts) Trading Engine
// Enhanced from MCT Strategy with:
//   - Fair Value Gap (FVG) detection
//   - Breaker Block detection
//   - Premium/Discount zones
//   - Optimal Trade Entry (OTE) via Fibonacci
//   - AI-learned weight modifiers
//   - Sentiment integration
//   - 1% profit targeting
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { getSentimentScores, getSentimentModifier } = require('./sentiment-scraper');

const REQUEST_TIMEOUT = 15000;

// ── Fetch Helpers ────────────────────────────────────────────

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
    levels.pdh = parseFloat(prevDay[2]);
    levels.pdl = parseFloat(prevDay[3]);
    levels.op = parseFloat(today[1]);
  }
  if (weeklyKlines && weeklyKlines.length >= 2) {
    const prevWeek = weeklyKlines[weeklyKlines.length - 2];
    levels.pwh = parseFloat(prevWeek[2]);
    levels.pwl = parseFloat(prevWeek[3]);
  }
  return levels;
}

// ── Swing Points Detection ───────────────────────────────────

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

// ── Market Structure (HH/HL/LH/LL + CHoCH) ──────────────────

function detectStructure(klines) {
  const n = klines.length;
  if (n < 20) return { trend: 'ranging', shLabel: '?', slLabel: '?', choch: null };

  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));

  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2])
      swingHighs.push({ price: highs[i], idx: i });
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2])
      swingLows.push({ price: lows[i], idx: i });
  }

  if (swingHighs.length < 2 || swingLows.length < 2)
    return { trend: 'ranging', shLabel: '?', slLabel: '?', choch: null };

  const sh1 = swingHighs[swingHighs.length - 1].price;
  const sh2 = swingHighs[swingHighs.length - 2].price;
  const sl1 = swingLows[swingLows.length - 1].price;
  const sl2 = swingLows[swingLows.length - 2].price;

  const shLabel = sh1 > sh2 ? 'HH' : 'LH';
  const slLabel = sl1 > sl2 ? 'HL' : 'LL';

  let trend = 'ranging';
  if (shLabel === 'HH' && slLabel === 'HL') trend = 'uptrend';
  else if (shLabel === 'LH' && slLabel === 'LL') trend = 'downtrend';
  else if (shLabel === 'HH') trend = 'bullish';
  else if (shLabel === 'LH') trend = 'bearish';

  const lastClose = closes[closes.length - 1];
  let choch = null;
  if ((trend === 'uptrend' || trend === 'bullish') && lastClose < sl1) choch = 'bearish';
  if ((trend === 'downtrend' || trend === 'bearish') && lastClose > sh1) choch = 'bullish';

  const EQ_TOL = 0.003;
  const eql = Math.abs(sl1 - sl2) / sl2 < EQ_TOL ? (sl1 + sl2) / 2 : null;
  const eqh = Math.abs(sh1 - sh2) / sh2 < EQ_TOL ? (sh1 + sh2) / 2 : null;

  return { trend, shLabel, slLabel, sh1, sl1, sh2, sl2, choch, eql, eqh };
}

// ── Fair Value Gap (FVG) Detection ───────────────────────────
// Bullish FVG: candle[i-2] high < candle[i] low (gap up)
// Bearish FVG: candle[i-2] low > candle[i] high (gap down)

function detectFVG(klines) {
  const gaps = [];
  for (let i = 2; i < klines.length; i++) {
    const c0High = parseFloat(klines[i - 2][2]);
    const c0Low = parseFloat(klines[i - 2][3]);
    const c2High = parseFloat(klines[i][2]);
    const c2Low = parseFloat(klines[i][3]);

    // Bullish FVG: gap between candle 0 high and candle 2 low
    if (c2Low > c0High) {
      gaps.push({
        type: 'bullish',
        top: c2Low,
        bottom: c0High,
        midpoint: (c2Low + c0High) / 2,
        size: (c2Low - c0High) / c0High,
        idx: i,
        filled: false,
      });
    }

    // Bearish FVG: gap between candle 0 low and candle 2 high
    if (c2High < c0Low) {
      gaps.push({
        type: 'bearish',
        top: c0Low,
        bottom: c2High,
        midpoint: (c0Low + c2High) / 2,
        size: (c0Low - c2High) / c2High,
        idx: i,
        filled: false,
      });
    }
  }

  // Check which FVGs have been filled by subsequent price action
  const lastPrice = parseFloat(klines[klines.length - 1][4]);
  for (const gap of gaps) {
    if (gap.type === 'bullish' && lastPrice < gap.bottom) gap.filled = true;
    if (gap.type === 'bearish' && lastPrice > gap.top) gap.filled = true;
  }

  // Return unfilled FVGs (price should come back to fill them)
  return gaps.filter(g => !g.filled);
}

// ── Order Block Detection (Enhanced) ─────────────────────────

function detectOrderBlocks(klines) {
  const n = klines.length;
  if (n < 15) return [];

  const opens = klines.map(k => parseFloat(k[1]));
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const vols = klines.map(k => parseFloat(k[5]));

  const blocks = [];
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);

  for (let i = 3; i < n - 3; i++) {
    // Bullish OB: last bearish candle before strong bullish impulse
    const impulseUp = (closes[i + 2] - closes[i]) / closes[i];
    if (impulseUp > 0.015 && closes[i] < opens[i]) {
      const isVolSpike = vols[i + 1] > avgVol * 1.5 || vols[i + 2] > avgVol * 1.5;
      blocks.push({
        type: 'bullish',
        high: Math.max(opens[i], closes[i]),
        low: Math.min(opens[i], closes[i]),
        fullHigh: highs[i],
        fullLow: lows[i],
        strength: impulseUp,
        hasVolume: isVolSpike,
        idx: i,
      });
    }

    // Bearish OB: last bullish candle before strong bearish impulse
    const impulseDown = (closes[i] - closes[i + 2]) / closes[i];
    if (impulseDown > 0.015 && closes[i] > opens[i]) {
      const isVolSpike = vols[i + 1] > avgVol * 1.5 || vols[i + 2] > avgVol * 1.5;
      blocks.push({
        type: 'bearish',
        high: Math.max(opens[i], closes[i]),
        low: Math.min(opens[i], closes[i]),
        fullHigh: highs[i],
        fullLow: lows[i],
        strength: impulseDown,
        hasVolume: isVolSpike,
        idx: i,
      });
    }
  }

  return blocks;
}

// ── Breaker Block Detection ──────────────────────────────────
// A failed OB that gets broken through becomes support/resistance

function detectBreakerBlocks(klines, orderBlocks) {
  const price = parseFloat(klines[klines.length - 1][4]);
  const breakers = [];

  for (const ob of orderBlocks) {
    if (ob.type === 'bullish') {
      // Bullish OB failed = price broke below it → becomes bearish breaker (resistance)
      const brokeBelowAfter = klines.slice(ob.idx + 3).some(k => parseFloat(k[4]) < ob.fullLow);
      if (brokeBelowAfter && price < ob.high) {
        breakers.push({
          type: 'bearish_breaker',
          level: ob.high,
          zone: { high: ob.high, low: ob.low },
        });
      }
    } else {
      // Bearish OB failed = price broke above it → becomes bullish breaker (support)
      const brokeAboveAfter = klines.slice(ob.idx + 3).some(k => parseFloat(k[4]) > ob.fullHigh);
      if (brokeAboveAfter && price > ob.low) {
        breakers.push({
          type: 'bullish_breaker',
          level: ob.low,
          zone: { high: ob.high, low: ob.low },
        });
      }
    }
  }

  return breakers;
}

// ── Premium/Discount Zone ────────────────────────────────────
// Premium = above 50% of range (good for shorts)
// Discount = below 50% of range (good for longs)

function getPremiumDiscount(klines, lookback = 50) {
  const subset = klines.slice(-lookback);
  const rangeHigh = Math.max(...subset.map(k => parseFloat(k[2])));
  const rangeLow = Math.min(...subset.map(k => parseFloat(k[3])));
  const equilibrium = (rangeHigh + rangeLow) / 2;
  const price = parseFloat(klines[klines.length - 1][4]);

  return {
    zone: price > equilibrium ? 'premium' : 'discount',
    equilibrium,
    rangeHigh,
    rangeLow,
    position: (price - rangeLow) / (rangeHigh - rangeLow), // 0=bottom, 1=top
  };
}

// ── Optimal Trade Entry (OTE) — Fibonacci Retracement ────────

function getOTE(swingHigh, swingLow, direction) {
  const range = swingHigh - swingLow;
  if (direction === 'LONG') {
    // OTE for longs: 62-79% retracement from the low
    return {
      top: swingHigh - range * 0.618,
      bottom: swingHigh - range * 0.786,
      midpoint: swingHigh - range * 0.702,
    };
  }
  // OTE for shorts: 62-79% retracement from the high
  return {
    top: swingLow + range * 0.786,
    bottom: swingLow + range * 0.618,
    midpoint: swingLow + range * 0.702,
  };
}

// ── Rejection Candle Detection ───────────────────────────────

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

  if (lowerWick > body * 2 && close > open) return 'bullish';
  if (upperWick > body * 2 && close < open) return 'bearish';

  const prevOpen = parseFloat(klines[idx - 1][1]);
  const prevClose = parseFloat(klines[idx - 1][4]);
  if (prevClose < prevOpen && close > open && close > prevOpen && open < prevClose) return 'bullish';
  if (prevClose > prevOpen && close < open && close < prevOpen && open > prevClose) return 'bearish';

  return null;
}

// ── Volume Spike ─────────────────────────────────────────────

function hasVolumeSpike(klines, idx, avgPeriod = 20) {
  if (idx < avgPeriod) return false;
  const volumes = klines.slice(idx - avgPeriod, idx).map(k => parseFloat(k[5]));
  const avgVol = volumes.reduce((a, b) => a + b, 0) / avgPeriod;
  return parseFloat(klines[idx][5]) > avgVol * 1.5;
}

// ── Session Filter ───────────────────────────────────────────

function isGoodTradingSession() {
  const utcH = new Date().getUTCHours();
  if (utcH >= 7 && utcH <= 10) return true;
  if (utcH >= 12 && utcH <= 16) return true;
  if (utcH >= 23 || utcH <= 2) return true;
  return false;
}

function isAvoidTime() {
  const min = new Date().getUTCMinutes();
  if (min <= 1 || (min >= 14 && min <= 16) || (min >= 29 && min <= 31) || (min >= 44 && min <= 46)) return true;
  return false;
}

// ── 1-Minute Entry Confirmation ──────────────────────────────

function detect1mEntry(klines1m, targetLevel, direction) {
  if (!klines1m || klines1m.length < 10) return { valid: false, reason: 'not enough 1m data' };

  const struct1m = detectStructure(klines1m);
  const closes1m = klines1m.map(k => parseFloat(k[4]));
  const price = closes1m[closes1m.length - 1];

  const nearTarget = Math.abs(price - targetLevel) / targetLevel < 0.02;
  if (!nearTarget) return { valid: false, reason: `not near target` };

  if (direction === 'SHORT') {
    const llFormed = struct1m.slLabel === 'LL';
    const lhFormed = struct1m.shLabel === 'LH';
    const valid = (llFormed && lhFormed) || struct1m.choch === 'bearish';
    return { valid, reason: valid ? '1m bearish confirmed' : '1m not ready for short' };
  }

  const hhFormed = struct1m.shLabel === 'HH';
  const hlFormed = struct1m.slLabel === 'HL';
  const valid = (hhFormed && hlFormed) || struct1m.choch === 'bullish';
  return { valid, reason: valid ? '1m bullish confirmed' : '1m not ready for long' };
}

// ── Main SMC Analysis for a Single Coin ──────────────────────

async function analyzeSMC(ticker, sentimentScores = {}) {
  try {
    const symbol = ticker.symbol;
    const price = parseFloat(ticker.lastPrice);

    // Check if AI says to avoid this coin
    if (aiLearner.shouldAvoidCoin(symbol)) return null;

    // Get AI-optimal parameters
    const params = aiLearner.getOptimalParams();

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

    // ── VWAP ──
    const todayKlines = klines1h.slice(-24);
    const vwap = calcVWAP(todayKlines);
    if (!vwap) return null;

    // ── Trend Bias ──
    const aboveOP = price > levels.op;
    const aboveVWAP = price > vwap;
    const bias = (aboveOP && aboveVWAP) ? 'long' : (!aboveOP && !aboveVWAP) ? 'short' : 'neutral';
    if (bias === 'neutral') return null;

    // ── Indicators ──
    const closes15m = klines15m.map(k => parseFloat(k[4]));
    const rsi = calcRSI(closes15m);
    const atr = calcATR(klines15m, 14) || price * 0.01;
    const closes1h = klines1h.map(k => parseFloat(k[4]));
    const ema7 = calcEMA(closes1h.slice(-20), 7);

    if (bias === 'long' && rsi > 75) return null;
    if (bias === 'short' && rsi < 25) return null;

    // ── Market Structure ──
    const struct15m = detectStructure(klines15m);
    const swings = findSwingPoints(klines15m, 3);

    // ── NEW: Fair Value Gaps ──
    const fvgs = detectFVG(klines15m);

    // ── NEW: Order Blocks (enhanced) ──
    const orderBlocks = detectOrderBlocks(klines15m);

    // ── NEW: Breaker Blocks ──
    const breakerBlocks = detectBreakerBlocks(klines15m, orderBlocks);

    // ── NEW: Premium/Discount ──
    const pd = getPremiumDiscount(klines15m);

    // ── NEW: OTE Zone ──
    let oteZone = null;
    if (swings.swingHighs.length && swings.swingLows.length) {
      const lastSH = swings.swingHighs[swings.swingHighs.length - 1].val;
      const lastSL = swings.swingLows[swings.swingLows.length - 1].val;
      oteZone = getOTE(lastSH, lastSL, bias === 'long' ? 'LONG' : 'SHORT');
    }

    // ── 1m Confirmation ──
    const lastIdx = klines1m.length - 1;
    const rejection1m = hasRejection(klines1m, lastIdx);
    const volSpike1m = hasVolumeSpike(klines1m, lastIdx);

    const direction = bias === 'long' ? 'LONG' : 'SHORT';
    const proximity = atr * 1.5;

    // ── Build key level array ──
    const keyLevelArr = [
      { name: 'PDH', val: levels.pdh },
      { name: 'PDL', val: levels.pdl },
      { name: 'OP', val: levels.op },
    ];
    if (levels.pwh) keyLevelArr.push({ name: 'PWH', val: levels.pwh });
    if (levels.pwl) keyLevelArr.push({ name: 'PWL', val: levels.pwl });

    // Find nearest key level
    let nearestLevel = null;
    let nearestDist = Infinity;
    for (const lv of keyLevelArr) {
      const dist = Math.abs(price - lv.val);
      if (dist < nearestDist) { nearestDist = dist; nearestLevel = lv; }
    }

    // ── Scoring System ──
    let setup = null;
    let setupName = '';
    let score = 0;
    let sl = null;
    const isLong = direction === 'LONG';

    // === Setup 1: Break and Retest ===
    if (nearestLevel && nearestDist <= proximity) {
      for (const lv of keyLevelArr) {
        const dist = Math.abs(price - lv.val);
        if (dist > proximity) continue;

        if (isLong && price > lv.val && price - lv.val < proximity) {
          if (rejection1m === 'bullish' || volSpike1m) {
            setup = 'break_retest';
            setupName = `Break & Retest ${lv.name}`;
            sl = lv.val - atr * 0.5;
            score = 8;
            if (volSpike1m) score += 2;
            if (rejection1m === 'bullish') score += 3;
            break;
          }
        }
        if (!isLong && price < lv.val && lv.val - price < proximity) {
          if (rejection1m === 'bearish' || volSpike1m) {
            setup = 'break_retest';
            setupName = `Break & Retest ${lv.name}`;
            sl = lv.val + atr * 0.5;
            score = 8;
            if (volSpike1m) score += 2;
            if (rejection1m === 'bearish') score += 3;
            break;
          }
        }
      }
    }

    // === Setup 2: Liquidity Grab and Reversal ===
    if (!setup) {
      for (const lv of keyLevelArr) {
        const recent = klines1m.slice(-12);
        const recentHigh = Math.max(...recent.map(k => parseFloat(k[2])));
        const recentLow = Math.min(...recent.map(k => parseFloat(k[3])));

        if (isLong && recentLow < lv.val && price > lv.val) {
          if (rejection1m === 'bullish') {
            setup = 'liquidity_grab';
            setupName = `Liquidity Grab below ${lv.name}`;
            sl = recentLow - atr * 0.3;
            score = 9;
            if (volSpike1m) score += 2;
            break;
          }
        }
        if (!isLong && recentHigh > lv.val && price < lv.val) {
          if (rejection1m === 'bearish') {
            setup = 'liquidity_grab';
            setupName = `Liquidity Grab above ${lv.name}`;
            sl = recentHigh + atr * 0.3;
            score = 9;
            if (volSpike1m) score += 2;
            break;
          }
        }
      }
    }

    // === Setup 3: VWAP Trend Follow ===
    if (!setup) {
      const vwapDist = Math.abs(price - vwap);
      if (vwapDist < proximity) {
        if (isLong && price >= vwap && rejection1m === 'bullish') {
          setup = 'vwap_trend';
          setupName = `VWAP Trend Follow (Long)`;
          sl = vwap - atr * 0.5;
          score = 7;
          if (volSpike1m) score += 2;
          if (ema7 && price > ema7) score += 1;
        }
        if (!isLong && price <= vwap && rejection1m === 'bearish') {
          setup = 'vwap_trend';
          setupName = `VWAP Trend Follow (Short)`;
          sl = vwap + atr * 0.5;
          score = 7;
          if (volSpike1m) score += 2;
          if (ema7 && price < ema7) score += 1;
        }
      }
    }

    // === Setup 4 (NEW): Fair Value Gap Entry ===
    if (!setup && fvgs.length) {
      for (const fvg of fvgs) {
        const inGap = price >= fvg.bottom && price <= fvg.top;
        if (!inGap) continue;

        if (isLong && fvg.type === 'bullish' && rejection1m === 'bullish') {
          setup = 'fvg_entry';
          setupName = `FVG Bullish Entry`;
          sl = fvg.bottom - atr * 0.3;
          score = 8;
          if (volSpike1m) score += 2;
          if (pd.zone === 'discount') score += 3; // FVG in discount = high probability
          break;
        }
        if (!isLong && fvg.type === 'bearish' && rejection1m === 'bearish') {
          setup = 'fvg_entry';
          setupName = `FVG Bearish Entry`;
          sl = fvg.top + atr * 0.3;
          score = 8;
          if (volSpike1m) score += 2;
          if (pd.zone === 'premium') score += 3;
          break;
        }
      }
    }

    // === Setup 5 (NEW): Breaker Block Entry ===
    if (!setup && breakerBlocks.length) {
      for (const bb of breakerBlocks) {
        const nearBreaker = Math.abs(price - bb.level) / price < 0.005;
        if (!nearBreaker) continue;

        if (isLong && bb.type === 'bullish_breaker' && rejection1m === 'bullish') {
          setup = 'breaker_block';
          setupName = `Bullish Breaker Block`;
          sl = bb.zone.low - atr * 0.3;
          score = 9;
          if (volSpike1m) score += 2;
          break;
        }
        if (!isLong && bb.type === 'bearish_breaker' && rejection1m === 'bearish') {
          setup = 'breaker_block';
          setupName = `Bearish Breaker Block`;
          sl = bb.zone.high + atr * 0.3;
          score = 9;
          if (volSpike1m) score += 2;
          break;
        }
      }
    }

    if (!setup) return null;

    // ── Bonus scoring from new SMC concepts ──

    // Premium/Discount alignment
    if (isLong && pd.zone === 'discount') score += 2;
    if (!isLong && pd.zone === 'premium') score += 2;
    if (isLong && pd.zone === 'premium') score -= 2;
    if (!isLong && pd.zone === 'discount') score -= 2;

    // OTE zone bonus
    if (oteZone) {
      const inOTE = price >= oteZone.bottom && price <= oteZone.top;
      if (inOTE) score += 3;
    }

    // Market structure confirmation
    if (isLong && (struct15m.trend === 'uptrend' || struct15m.trend === 'bullish')) score += 2;
    if (!isLong && (struct15m.trend === 'downtrend' || struct15m.trend === 'bearish')) score += 2;
    if (struct15m.choch === 'bullish' && isLong) score += 3;
    if (struct15m.choch === 'bearish' && !isLong) score += 3;

    // ── 1m entry confirmation ──
    const targetLevel = isLong
      ? (swings.swingLows.length ? swings.swingLows[swings.swingLows.length - 1].val : price)
      : (swings.swingHighs.length ? swings.swingHighs[swings.swingHighs.length - 1].val : price);
    const entry1m = detect1mEntry(klines1m, targetLevel, direction);
    if (entry1m.valid) score += 3;

    // ── AI-learned modifiers ──
    const aiModifier = aiLearner.getAIScoreModifier(symbol, setup, direction);
    score = score * aiModifier;

    // ── Sentiment modifier ──
    const sentMod = getSentimentModifier(symbol, direction);
    score += sentMod;

    // ── Check minimum score ──
    if (score < params.MIN_SCORE) return null;

    // ── TP/SL for 1% profit target ──
    const slDist = Math.abs(price - sl);
    const slPct = slDist / price;

    // Target 1% profit — only take if SL allows >= 1:1 RR
    const TP_TARGET = params.TP_PCT || 0.01;
    if (slPct > TP_TARGET) return null; // SL too wide for 1% target — skip

    const tp1 = isLong ? price * (1 + TP_TARGET) : price * (1 - TP_TARGET);
    const tp2 = isLong ? price * (1 + TP_TARGET * 1.5) : price * (1 - TP_TARGET * 1.5);
    const tp3 = isLong ? price * (1 + TP_TARGET * 2) : price * (1 - TP_TARGET * 2);

    const sentiment = sentimentScores[symbol] || null;

    return {
      symbol,
      lastPrice: price,
      signal: isLong ? 'BUY' : 'SELL',
      direction,
      setup,
      setupName,
      score: parseFloat(score.toFixed(1)),
      entry: price,
      sl,
      tp1,
      tp2,
      tp3,
      slPct: (slPct * 100).toFixed(2),
      tp1Pct: (TP_TARGET * 100).toFixed(2),
      bias,
      vwap,
      levels,
      rsi: parseFloat(rsi.toFixed(0)),
      atr,
      rejection: rejection1m,
      volSpike: volSpike1m,
      chg24h: parseFloat(ticker.priceChangePercent),
      timeframe: '15m/1m',
      // New SMC data
      fvgCount: fvgs.length,
      orderBlockCount: orderBlocks.length,
      breakerBlockCount: breakerBlocks.length,
      premiumDiscount: pd.zone,
      pdPosition: parseFloat(pd.position.toFixed(2)),
      inOTE: oteZone ? (price >= oteZone.bottom && price <= oteZone.top) : false,
      entry1mValid: entry1m.valid,
      entry1mReason: entry1m.reason,
      // AI data
      aiModifier: parseFloat(aiModifier.toFixed(2)),
      sentimentMod: sentMod,
      sentiment: sentiment ? sentiment.sentiment : 'unknown',
      trendScore: sentiment ? sentiment.trendScore : 0,
    };
  } catch (err) {
    return null;
  }
}

// ── Daily Trade Counter ──────────────────────────────────────

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
  if (dailyTrades >= 3) return 'max_trades'; // increased from 2 to 3 with AI
  if (dailyLosses >= 2) return '2_losses';
  return null;
}

function recordDailyTrade(isWin) {
  dailyTrades++;
  if (!isWin) dailyLosses++;
  else dailyLosses = 0;
}

// ── Main Scan Function ───────────────────────────────────────

async function scanSMC(log = console.log) {
  const limitCheck = checkDailyLimits();
  if (limitCheck === 'max_trades') {
    log('SMC: Daily trade limit reached. Waiting for tomorrow.');
    return [];
  }
  if (limitCheck === '2_losses') {
    log('SMC: 2 consecutive losses today. Stopped trading.');
    return [];
  }

  if (!isGoodTradingSession()) {
    // AI can override session filter if session weight is high enough
    const sessionW = aiLearner.getSessionWeight();
    if (sessionW < 1.2) {
      log('SMC: Outside active trading session.');
      return [];
    }
    log(`SMC: Off-hours but AI session weight ${sessionW.toFixed(2)} is high — scanning anyway.`);
  }

  if (isAvoidTime()) {
    log('SMC: Avoiding round-number entry time.');
    return [];
  }

  // Fetch sentiment scores (cached for 15 min)
  let sentimentScores = {};
  try {
    sentimentScores = await getSentimentScores();
    const trendingCount = Object.values(sentimentScores).filter(s => s.trendScore > 0.3).length;
    log(`SMC: Sentiment loaded — ${trendingCount} trending coins detected.`);
  } catch (e) {
    log(`SMC: Sentiment fetch failed (${e.message}) — proceeding without.`);
  }

  const tickers = await fetchTickers();
  if (!tickers.length) return [];

  // Top coins by volume + trending boost
  const top30 = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => parseFloat(t.quoteVolume) > 100e6)
    .map(t => {
      const sentBoost = sentimentScores[t.symbol]?.trendScore || 0;
      return { ...t, sortScore: parseFloat(t.quoteVolume) + sentBoost * 1e9 };
    })
    .sort((a, b) => b.sortScore - a.sortScore)
    .slice(0, 30);

  log(`SMC: Analyzing ${top30.length} coins...`);

  const results = [];
  for (const ticker of top30) {
    const r = await analyzeSMC(ticker, sentimentScores);
    if (r && r.score >= (aiLearner.getOptimalParams().MIN_SCORE || 8)) {
      results.push(r);
      log(`  SMC: ${r.symbol} ${r.direction} score=${r.score} setup=${r.setup} AI=${r.aiModifier} sent=${r.sentimentMod}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3);
}

module.exports = {
  scanSMC,
  analyzeSMC,
  recordDailyTrade,
  checkDailyLimits,
  isGoodTradingSession,
  detectStructure,
  detectFVG,
  detectOrderBlocks,
  detectBreakerBlocks,
  getPremiumDiscount,
  getOTE,
  detect1mEntry,
};
