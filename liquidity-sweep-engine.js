// ============================================================
// Smart Money + BRR Trading Engine
//
// SMC Strategies:
//   1. Liquidity Sweep    — 15m range break + close back inside, 1m entry
//   2. Stop-Loss Hunt     — S/R false break + reversal
//   3. Momentum Scalping  — 15m trend + 1m failed pin bar
//
// BRR Strategy:
//   4. Breakout-Retest-Rejection — HTF structure + Fib confluence
//      HTF defines direction, LTF provides BRR entry at Fib 50/61.8%
//
// Risk: SL below range/candle, TP at next key level
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');
let smcEngine = null;
try { smcEngine = require('./smc-engine'); } catch (e) { console.warn('[Engine] SMC engine not available:', e.message); }

const REQUEST_TIMEOUT = 15000;
const TOP_N_COINS = 100;
const MIN_24H_VOLUME = 10_000_000;

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

// ── Candle Helpers ──────────────────────────────────────────

function parseCandle(k) {
  return {
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    openTime: parseInt(k[0]),
    closeTime: parseInt(k[6]),
  };
}

function isGreenCandle(c) { return c.close > c.open; }
function isRedCandle(c) { return c.close < c.open; }
function bodySize(c) { return Math.abs(c.close - c.open); }
function totalRange(c) { return c.high - c.low; }

function isBullishPinBar(c) {
  const body = bodySize(c);
  const range = totalRange(c);
  if (range === 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return lowerWick > body * 2 && lowerWick > range * 0.6;
}

function isBearishPinBar(c) {
  const body = bodySize(c);
  const range = totalRange(c);
  if (range === 0) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  return upperWick > body * 2 && upperWick > range * 0.6;
}

// ── RSI Calculation ────────────────────────────────────────

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

// ── Volume Check ───────────────────────────────────────────

function hasVolumeConfirm(candles, idx, multiplier = 1.2) {
  if (candles.length < 22 || idx < 20) return true; // not enough data, pass
  const avgVol = candles.slice(idx - 20, idx).reduce((s, c) => s + c.volume, 0) / 20;
  return candles[idx].volume > avgVol * multiplier;
}

// ── EMA for trend detection ────────────────────────────────

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

// ── ATR for dynamic SL buffer ──────────────────────────────

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    sum += tr;
  }
  return sum / period;
}

// ── RMA (Wilder Smoothing — matches Pine Script ta.rma()) ──
// Alpha = 1/period, giving slower smoothing that follows structure curves
// This is the basis for Zeiierman's "Curved Smart Money Concept Probability"

function calcRMAArray(values, period) {
  if (values.length < period) return [];
  const result = new Array(period - 1).fill(null);
  let rma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(rma);
  for (let i = period; i < values.length; i++) {
    rma = (values[i] + rma * (period - 1)) / period;
    result.push(rma);
  }
  return result;
}

// ── EMA slope strength ─────────────────────────────────────
// Returns EMA value and slope (% change over last N bars)
// Used to verify trend direction has conviction, not just flat

function calcEMAStrength(candles, period = 55, slopeBars = 5) {
  if (candles.length < period + slopeBars) return { ema: null, slope: 0, isBullish: false, isBearish: false };
  const closes = candles.map(c => c.close);
  const k = 2 / (period + 1);

  // Compute EMA up to (length - slopeBars) for the "past" value
  let emaPast = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const pastEnd = closes.length - slopeBars;
  for (let i = period; i < pastEnd; i++) emaPast = closes[i] * k + emaPast * (1 - k);

  // Compute full EMA for current value
  let emaNow = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) emaNow = closes[i] * k + emaNow * (1 - k);

  const slope = (emaNow - emaPast) / emaPast; // % slope over slopeBars
  const price = closes[closes.length - 1];

  return {
    ema: emaNow,
    slope,
    isBullish: price > emaNow && slope > -0.0003,   // above EMA + not declining hard
    isBearish: price < emaNow && slope < 0.0003,    // below EMA + not rising hard
  };
}

// ── Zeiierman Curved SMC Structure Detection ───────────────
// Inspired by "Curved Smart Money Concept Probability" (Zeiierman, TradingView)
// Uses RMA-smoothed highs/lows to curve out noise, then finds pivot structure.
// Detects HL HL (bullish — Higher Lows sequence) and LH LH (bearish — Lower Highs).
// Returns a probability score based on how extreme price is within the curved band.

function detectCurvedStructure(candles, rmaLen = 10, pivotLen = 4) {
  const minLen = rmaLen + pivotLen * 2 + 5;
  if (candles.length < minLen) return null;

  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);

  // Step 1: Smooth highs and lows with RMA (curves out micro-noise)
  const rmaHighs = calcRMAArray(highs, rmaLen);
  const rmaLows  = calcRMAArray(lows, rmaLen);

  // Step 2: Find swing pivots in smoothed data (left-right comparison)
  const swingHighs = [];
  const swingLows  = [];

  for (let i = pivotLen; i < rmaHighs.length - pivotLen; i++) {
    if (rmaHighs[i] === null || rmaLows[i] === null) continue;

    let isSwingHigh = true;
    let isSwingLow  = true;

    for (let j = 1; j <= pivotLen; j++) {
      if (rmaHighs[i] <= rmaHighs[i - j] || rmaHighs[i] <= rmaHighs[i + j]) isSwingHigh = false;
      if (rmaLows[i]  >= rmaLows[i - j]  || rmaLows[i]  >= rmaLows[i + j])  isSwingLow  = false;
    }

    if (isSwingHigh) swingHighs.push({ idx: i, price: rmaHighs[i], rawHigh: highs[i] });
    if (isSwingLow)  swingLows.push ({ idx: i, price: rmaLows[i],  rawLow:  lows[i]  });
  }

  // Step 3: Count consecutive Higher Lows (HL HL) and Lower Highs (LH LH)
  const recentHighs = swingHighs.slice(-3);
  const recentLows  = swingLows.slice(-3);

  let hlCount = 0; // consecutive Higher Lows
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i - 1].price) hlCount++;
  }

  let lhCount = 0; // consecutive Lower Highs
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price < recentHighs[i - 1].price) lhCount++;
  }

  const isBullish = hlCount >= 1 && recentLows.length >= 2;
  const isBearish = lhCount >= 1 && recentHighs.length >= 2;

  // Step 4: Zeiierman probability — position within the curved band
  // 0 = at lower band (prime LONG zone), 1 = at upper band (prime SHORT zone)
  const lastH = rmaHighs.filter(v => v !== null).slice(-1)[0] || 0;
  const lastL = rmaLows.filter(v => v !== null).slice(-1)[0] || 0;
  const price  = candles[candles.length - 1].close;
  const bandW  = lastH - lastL;
  const pos    = bandW > 0 ? (price - lastL) / bandW : 0.5;

  // Probability scores (0–100): higher = better setup quality
  const longProb  = isBullish ? Math.min(100, Math.round((1 - pos) * 50 + hlCount * 30)) : 0;
  const shortProb = isBearish ? Math.min(100, Math.round(pos * 50 + lhCount * 30))        : 0;

  return {
    isBullish,
    isBearish,
    hlCount,
    lhCount,
    swingHighs: recentHighs,
    swingLows:  recentLows,
    nearLowerBand: pos < 0.35,
    nearUpperBand: pos > 0.65,
    normalizedPos: pos,
    longProbability:  longProb,
    shortProbability: shortProb,
    curvedHigh: lastH,
    curvedLow:  lastL,
  };
}

// ── S/R Zone Detection (6-Criteria Scoring) ────────────────
// Levels are ZONES not lines. Scored on 6 criteria:
//   1. Major swing high/low (is it a significant turning point?)
//   2. Multiple rejections (how many times price bounced here?)
//   3. Obvious level (would most traders see this?)
//   4. Strong reaction (did price move aggressively away?)
//   5. Role reversal (did support become resistance or vice versa?)
//   6. Recent respect (has price reacted here recently?)
// More criteria met = stronger zone. Zone width = ATR-based.

function findKeyLevels(candles, lookback = 50) {
  const slice = candles.slice(-lookback);
  const totalCandles = slice.length;
  const atr = calcATR(slice);
  const zoneWidth = atr * 0.5; // zone extends half an ATR each side

  // Step 1: Find all swing highs and lows
  const rawLevels = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    const isSwingHigh = c.high > slice[i - 1].high && c.high > slice[i - 2].high &&
                        c.high > slice[i + 1].high && c.high > slice[i + 2].high;
    const isSwingLow = c.low < slice[i - 1].low && c.low < slice[i - 2].low &&
                       c.low < slice[i + 1].low && c.low < slice[i + 2].low;

    if (isSwingHigh) rawLevels.push({ price: c.high, type: 'resistance', index: i, candle: c });
    if (isSwingLow) rawLevels.push({ price: c.low, type: 'support', index: i, candle: c });
  }

  // Step 2: Cluster into zones and score each zone on 6 criteria
  const used = new Set();
  const zones = [];

  for (let i = 0; i < rawLevels.length; i++) {
    if (used.has(i)) continue;
    const cluster = [rawLevels[i]];
    used.add(i);

    for (let j = i + 1; j < rawLevels.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(rawLevels[j].price - rawLevels[i].price) / rawLevels[i].price < 0.004) {
        cluster.push(rawLevels[j]);
        used.add(j);
      }
    }

    const avgPrice = cluster.reduce((s, l) => s + l.price, 0) / cluster.length;
    const types = cluster.map(l => l.type);
    const primaryType = types.filter(t => t === 'support').length >= types.filter(t => t === 'resistance').length
      ? 'support' : 'resistance';

    // ── CRITERION 1: Major swing point (is it a significant high/low?) ──
    let isMajorSwing = false;
    for (const l of cluster) {
      const leftBars = Math.min(l.index, 5);
      const rightBars = Math.min(totalCandles - l.index - 1, 5);
      if (leftBars >= 3 && rightBars >= 3) {
        let leftOK = true, rightOK = true;
        for (let b = 1; b <= 3; b++) {
          if (l.type === 'resistance' && slice[l.index - b].high >= l.candle.high) leftOK = false;
          if (l.type === 'resistance' && l.index + b < totalCandles && slice[l.index + b].high >= l.candle.high) rightOK = false;
          if (l.type === 'support' && slice[l.index - b].low <= l.candle.low) leftOK = false;
          if (l.type === 'support' && l.index + b < totalCandles && slice[l.index + b].low <= l.candle.low) rightOK = false;
        }
        if (leftOK && rightOK) { isMajorSwing = true; break; }
      }
    }

    // ── CRITERION 2: Multiple rejections ──
    const rejections = cluster.length;

    // ── CRITERION 3: Obvious level (round numbers, widely visible) ──
    const priceStr = avgPrice.toFixed(2);
    const isRound = priceStr.endsWith('00') || priceStr.endsWith('50') ||
                    priceStr.endsWith('000') || priceStr.endsWith('500');
    const isObvious = isRound || rejections >= 3;

    // ── CRITERION 4: Strong reaction (aggressive move away from level) ──
    let hasStrongReaction = false;
    for (const l of cluster) {
      if (l.index + 2 < totalCandles) {
        const moveAfter = Math.abs(slice[l.index + 2].close - l.price) / l.price;
        if (moveAfter > 0.005) { hasStrongReaction = true; break; }
      }
    }

    // ── CRITERION 5: Role reversal (support became resistance or vice versa) ──
    const hasRoleReversal = types.includes('support') && types.includes('resistance');

    // ── CRITERION 6: Recent respect (last touch within recent 30% of data) ──
    const recentThreshold = totalCandles * 0.7;
    const isRecent = cluster.some(l => l.index >= recentThreshold);

    // Score: each criterion adds 1 point (max 6)
    let strength = 0;
    if (isMajorSwing) strength++;
    if (rejections >= 2) strength++;
    if (rejections >= 3) strength++; // bonus for 3+ rejections
    if (isObvious) strength++;
    if (hasStrongReaction) strength++;
    if (hasRoleReversal) strength++;
    if (isRecent) strength++;

    zones.push({
      price: avgPrice,
      zoneHigh: avgPrice + zoneWidth,
      zoneLow: avgPrice - zoneWidth,
      type: primaryType,
      touches: rejections,
      strength, // 0-7 score
      isMajorSwing,
      isObvious,
      hasStrongReaction,
      hasRoleReversal,
      isRecent,
    });
  }

  return zones.sort((a, b) => b.strength - a.strength);
}

// ── Check if price is inside an S/R zone ───────────────────

function isInZone(price, zone) {
  return price >= zone.zoneLow && price <= zone.zoneHigh;
}

function findNearestLevel(price, levels, direction, minDistPct = 0.003) {
  let best = null;
  let bestDist = Infinity;

  for (const level of levels) {
    const dist = Math.abs(level.price - price) / price;
    if (dist < minDistPct) continue;

    if (direction === 'LONG' && level.price > price && dist < bestDist) {
      best = level;
      bestDist = dist;
    }
    if (direction === 'SHORT' && level.price < price && dist < bestDist) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}

// ── Trendline Detection (Dynamic S/R) ──────────────────────
// Connects swing lows (uptrend support) or swing highs (downtrend resistance)
// Requires 2+ points of contact. Trendlines are zones, not exact lines.

function detectTrendlines(candles) {
  const parsed = candles.map ? candles : candles.map(parseCandle);
  if (parsed.length < 20) return { uptrend: null, downtrend: null };

  // Find swing lows for uptrend line
  const swingLows = [];
  const swingHighs = [];
  for (let i = 2; i < parsed.length - 2; i++) {
    if (parsed[i].low < parsed[i - 1].low && parsed[i].low < parsed[i - 2].low &&
        parsed[i].low < parsed[i + 1].low && parsed[i].low < parsed[i + 2].low) {
      swingLows.push({ price: parsed[i].low, index: i });
    }
    if (parsed[i].high > parsed[i - 1].high && parsed[i].high > parsed[i - 2].high &&
        parsed[i].high > parsed[i + 1].high && parsed[i].high > parsed[i + 2].high) {
      swingHighs.push({ price: parsed[i].high, index: i });
    }
  }

  // Uptrend line: connect ascending swing lows (HL pattern)
  let uptrend = null;
  for (let i = 0; i < swingLows.length - 1; i++) {
    for (let j = i + 1; j < swingLows.length; j++) {
      if (swingLows[j].price <= swingLows[i].price) continue; // must be ascending
      const slope = (swingLows[j].price - swingLows[i].price) / (swingLows[j].index - swingLows[i].index);
      if (slope <= 0) continue;

      // Count how many other swing lows touch this line
      let touches = 2;
      for (let k = 0; k < swingLows.length; k++) {
        if (k === i || k === j) continue;
        const expectedPrice = swingLows[i].price + slope * (swingLows[k].index - swingLows[i].index);
        if (Math.abs(swingLows[k].price - expectedPrice) / expectedPrice < 0.004) touches++;
      }

      // Project line to current candle
      const currentIdx = parsed.length - 1;
      const currentTrendPrice = swingLows[i].price + slope * (currentIdx - swingLows[i].index);

      if (touches >= 2 && (!uptrend || touches > uptrend.touches)) {
        uptrend = { slope, touches, currentPrice: currentTrendPrice, startIdx: swingLows[i].index, type: 'support' };
      }
    }
  }

  // Downtrend line: connect descending swing highs (LH pattern)
  let downtrend = null;
  for (let i = 0; i < swingHighs.length - 1; i++) {
    for (let j = i + 1; j < swingHighs.length; j++) {
      if (swingHighs[j].price >= swingHighs[i].price) continue; // must be descending
      const slope = (swingHighs[j].price - swingHighs[i].price) / (swingHighs[j].index - swingHighs[i].index);
      if (slope >= 0) continue;

      let touches = 2;
      for (let k = 0; k < swingHighs.length; k++) {
        if (k === i || k === j) continue;
        const expectedPrice = swingHighs[i].price + slope * (swingHighs[k].index - swingHighs[i].index);
        if (Math.abs(swingHighs[k].price - expectedPrice) / expectedPrice < 0.004) touches++;
      }

      const currentIdx = parsed.length - 1;
      const currentTrendPrice = swingHighs[i].price + slope * (currentIdx - swingHighs[i].index);

      if (touches >= 2 && (!downtrend || touches > downtrend.touches)) {
        downtrend = { slope, touches, currentPrice: currentTrendPrice, startIdx: swingHighs[i].index, type: 'resistance' };
      }
    }
  }

  return { uptrend, downtrend };
}

// ── Candlestick Pattern Confirmation at Key Levels ─────────
// Patterns alone aren't enough — they must form AT a key level to be valid.

function isBullishEngulfing(prev, curr) {
  return isRedCandle(prev) && isGreenCandle(curr) &&
         curr.open <= prev.close && curr.close >= prev.open &&
         bodySize(curr) > bodySize(prev);
}

function isBearishEngulfing(prev, curr) {
  return isGreenCandle(prev) && isRedCandle(curr) &&
         curr.open >= prev.close && curr.close <= prev.open &&
         bodySize(curr) > bodySize(prev);
}

function isHammer(c) {
  // Bullish hammer: small body at top, long lower wick
  const body = bodySize(c);
  const range = totalRange(c);
  if (range === 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  return lowerWick >= body * 1.5 && upperWick < body * 0.5 && body / range < 0.4;
}

function isShootingStar(c) {
  // Bearish shooting star: small body at bottom, long upper wick
  const body = bodySize(c);
  const range = totalRange(c);
  if (range === 0) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return upperWick >= body * 1.5 && lowerWick < body * 0.5 && body / range < 0.4;
}

// Check if recent candles show a confirmation pattern at a zone
function hasCandleConfirmation(candles, zone, direction) {
  if (candles.length < 3) return { confirmed: false, pattern: null };

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  // Price must be near the zone
  const nearZone = isInZone(last.close, zone) || isInZone(last.low, zone) || isInZone(last.high, zone) ||
                   isInZone(prev.close, zone) || isInZone(prev.low, zone) || isInZone(prev.high, zone);
  if (!nearZone) return { confirmed: false, pattern: null };

  if (direction === 'LONG') {
    if (isBullishEngulfing(prev, last)) return { confirmed: true, pattern: 'bullish_engulfing' };
    if (isHammer(last)) return { confirmed: true, pattern: 'hammer' };
    if (isBullishPinBar(last)) return { confirmed: true, pattern: 'bullish_pin_bar' };
    // Morning star: red → small body → green
    if (isRedCandle(prev2) && bodySize(prev) < bodySize(prev2) * 0.3 && isGreenCandle(last) && last.close > prev2.open) {
      return { confirmed: true, pattern: 'morning_star' };
    }
  }

  if (direction === 'SHORT') {
    if (isBearishEngulfing(prev, last)) return { confirmed: true, pattern: 'bearish_engulfing' };
    if (isShootingStar(last)) return { confirmed: true, pattern: 'shooting_star' };
    if (isBearishPinBar(last)) return { confirmed: true, pattern: 'bearish_pin_bar' };
    // Evening star: green → small body → red
    if (isGreenCandle(prev2) && bodySize(prev) < bodySize(prev2) * 0.3 && isRedCandle(last) && last.close < prev2.open) {
      return { confirmed: true, pattern: 'evening_star' };
    }
  }

  return { confirmed: false, pattern: null };
}

// ── Strategy 1: Liquidity Sweep ────────────────────────────
// 15m: single candle range → next candle breaks & closes back inside
// 1m: same pattern for entry

function detectLiquiditySweep(candles15m, candles1m) {
  if (candles15m.length < 10 || candles1m.length < 10) return null;

  const parsed15 = candles15m.map(parseCandle);
  const parsed1 = candles1m.map(parseCandle);

  for (let i = parsed15.length - 5; i < parsed15.length - 1; i++) {
    const rangeCandle = parsed15[i];
    const sweepCandle = parsed15[i + 1];
    if (!rangeCandle || !sweepCandle) continue;

    const rangeHigh = rangeCandle.high;
    const rangeLow = rangeCandle.low;
    const rangeSize = rangeHigh - rangeLow;
    if (rangeSize === 0) continue;

    const isBullishSweep = sweepCandle.low < rangeLow && sweepCandle.close > rangeLow && sweepCandle.close <= rangeHigh;
    const isBearishSweep = sweepCandle.high > rangeHigh && sweepCandle.close < rangeHigh && sweepCandle.close >= rangeLow;
    if (!isBullishSweep && !isBearishSweep) continue;

    // Volume: sweep candle must have higher volume than range candle
    if (sweepCandle.volume <= rangeCandle.volume * 1.1) continue;

    // Close quality: must close >40% into range (not barely inside)
    if (isBullishSweep && (sweepCandle.close - rangeLow) / rangeSize < 0.4) continue;
    if (isBearishSweep && (rangeHigh - sweepCandle.close) / rangeSize < 0.4) continue;

    // Trend lean: last 3 15m candles should lean in direction
    const recent3 = parsed15.slice(Math.max(0, i - 2), i + 1);
    const greenRecent = recent3.filter(isGreenCandle).length;
    const redRecent = recent3.filter(isRedCandle).length;
    if (isBullishSweep && redRecent > greenRecent + 1) continue; // too bearish
    if (isBearishSweep && greenRecent > redRecent + 1) continue; // too bullish

    const direction = isBullishSweep ? 'LONG' : 'SHORT';

    // 1m confirmation: tightened to last 4 candles only
    for (let j = parsed1.length - 4; j < parsed1.length - 1; j++) {
      const range1m = parsed1[j];
      const sweep1m = parsed1[j + 1];
      if (!range1m || !sweep1m) continue;

      if (direction === 'LONG') {
        if (sweep1m.low < range1m.low && sweep1m.close > range1m.low) {
          return { direction, setup: 'LIQUIDITY_SWEEP', entryPrice: sweep1m.close,
            sl: Math.min(sweepCandle.low, sweep1m.low), rangeHigh, rangeLow };
        }
      } else {
        if (sweep1m.high > range1m.high && sweep1m.close < range1m.high) {
          return { direction, setup: 'LIQUIDITY_SWEEP', entryPrice: sweep1m.close,
            sl: Math.max(sweepCandle.high, sweep1m.high), rangeHigh, rangeLow };
        }
      }
    }
  }
  return null;
}

// ── Strategy 2: Stop-Loss Hunt ─────────────────────────────
// Price touches S/R multiple times → false break → reversal close back

function detectStopLossHunt(candles15m, candles1m, cfg = {}) {
  const minTouches = cfg.minTouches || 3; // raised from 2
  const proximityPct = cfg.proximityPct || 0.005; // tightened from 1% to 0.5%
  const lookback = cfg.lookback || 50;

  if (candles15m.length < 30 || candles1m.length < 10) return null;

  const parsed15 = candles15m.map(parseCandle);
  const parsed1 = candles1m.map(parseCandle);
  const levels = findKeyLevels(parsed15, lookback);

  // Require strong zones (strength >= 3 AND enough touches)
  const strongLevels = levels.filter(l => l.touches >= minTouches && l.strength >= 3);
  if (!strongLevels.length) return null;

  const lastCandle15 = parsed15[parsed15.length - 1];
  const prevCandle15 = parsed15[parsed15.length - 2];

  // Momentum check: recent 15m candles should show direction
  const recent5 = parsed15.slice(-5);
  const recentGreen = recent5.filter(isGreenCandle).length;
  const recentRed = recent5.filter(isRedCandle).length;

  for (const level of strongLevels) {
    const proxPct = Math.abs(lastCandle15.close - level.price) / level.price;
    if (proxPct > proximityPct) continue;

    if (level.type === 'support') {
      const brokeBelow = lastCandle15.low < level.price;
      const closedAbove = lastCandle15.close > level.price;
      // Rejection body must be larger than break (conviction)
      const hasConviction = bodySize(lastCandle15) > bodySize(prevCandle15) * 0.7;
      // Need at least 2 green in last 5 (momentum)
      if (brokeBelow && closedAbove && hasConviction && recentGreen >= 2) {
        const last1m = parsed1[parsed1.length - 1];
        if (last1m.close > level.price && isGreenCandle(last1m)) {
          return { direction: 'LONG', setup: 'STOP_LOSS_HUNT', entryPrice: last1m.close,
            sl: lastCandle15.low, level: level.price, levelType: level.type,
            touches: level.touches, strength: level.strength };
        }
      }
    }

    if (level.type === 'resistance') {
      const brokeAbove = lastCandle15.high > level.price;
      const closedBelow = lastCandle15.close < level.price;
      const hasConviction = bodySize(lastCandle15) > bodySize(prevCandle15) * 0.7;
      if (brokeAbove && closedBelow && hasConviction && recentRed >= 2) {
        const last1m = parsed1[parsed1.length - 1];
        if (last1m.close < level.price && isRedCandle(last1m)) {
          return { direction: 'SHORT', setup: 'STOP_LOSS_HUNT', entryPrice: last1m.close,
            sl: lastCandle15.high, level: level.price, levelType: level.type,
            touches: level.touches, strength: level.strength };
        }
      }
    }
  }
  return null;
}

// ── Strategy 3: Momentum Scalping ──────────────────────────
// 15m: strong trend → 1m: pin bar forms → pin bar FAILS → enter

function detectMomentumScalp(candles15m, candles1m, cfg = {}) {
  const trendStrength = cfg.trendStrength || 7;
  const pinBarWickRatio = cfg.pinBarWickRatio || 2.5; // tightened from 2.0

  if (candles15m.length < 15 || candles1m.length < 10) return null;

  const parsed15 = candles15m.map(parseCandle);
  const parsed1 = candles1m.map(parseCandle);

  // EMA trend check (more robust than candle counting)
  const closes15 = parsed15.map(c => c.close);
  const ema9 = calcEMA(closes15, 9);
  const ema21 = calcEMA(closes15, 21);
  if (ema9 === null || ema21 === null) return null;

  // Also check recent candle direction for confirmation
  const recent10 = parsed15.slice(-10);
  const greenCount = recent10.filter(isGreenCandle).length;
  const redCount = recent10.filter(isRedCandle).length;

  // EMA alignment + candle count together
  const isBullishTrend = ema9 > ema21 && greenCount >= trendStrength;
  const isBearishTrend = ema9 < ema21 && redCount >= trendStrength;
  if (!isBullishTrend && !isBearishTrend) return null;

  // 1m: look for pin bar + failure (last 4 candles only — fresh)
  for (let i = parsed1.length - 4; i < parsed1.length - 1; i++) {
    const pinCandle = parsed1[i];
    const failCandle = parsed1[i + 1];
    if (!pinCandle || !failCandle) continue;

    const pinBody = bodySize(pinCandle);
    const pinRange = totalRange(pinCandle);
    const failBody = bodySize(failCandle);
    if (pinRange === 0) continue;

    // Failure must be convincing: body > 40% of range
    if (failBody / totalRange(failCandle) < 0.4) continue;

    // Volume: failure candle should have more volume
    if (failCandle.volume <= pinCandle.volume * 0.9) continue;

    if (isBearishTrend) {
      const lw = Math.min(pinCandle.open, pinCandle.close) - pinCandle.low;
      if (lw > pinBody * pinBarWickRatio && lw > pinRange * 0.6 && failCandle.close < pinCandle.low) {
        return { direction: 'SHORT', setup: 'MOMENTUM_SCALP', entryPrice: failCandle.close,
          sl: pinCandle.high, trendDirection: 'bearish', pinBarIndex: i };
      }
    }

    if (isBullishTrend) {
      const uw = pinCandle.high - Math.max(pinCandle.open, pinCandle.close);
      if (uw > pinBody * pinBarWickRatio && uw > pinRange * 0.6 && failCandle.close > pinCandle.high) {
        return { direction: 'LONG', setup: 'MOMENTUM_SCALP', entryPrice: failCandle.close,
          sl: pinCandle.low, trendDirection: 'bullish', pinBarIndex: i };
      }
    }
  }
  return null;
}

// ── HTF Market Structure (for BRR alignment) ──────────────

function getHTFStructure(candles) {
  if (candles.length < 20) return { trend: 'neutral', momentum: 'neutral' };

  const parsed = candles.map(parseCandle);

  // Swing highs/lows for structure
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < parsed.length - 2; i++) {
    if (parsed[i].high > parsed[i - 1].high && parsed[i].high > parsed[i - 2].high &&
        parsed[i].high > parsed[i + 1].high && parsed[i].high > parsed[i + 2].high) {
      swingHighs.push({ price: parsed[i].high, index: i });
    }
    if (parsed[i].low < parsed[i - 1].low && parsed[i].low < parsed[i - 2].low &&
        parsed[i].low < parsed[i + 1].low && parsed[i].low < parsed[i + 2].low) {
      swingLows.push({ price: parsed[i].low, index: i });
    }
  }

  let trend = 'neutral';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const lastSH = swingHighs[swingHighs.length - 1];
    const prevSH = swingHighs[swingHighs.length - 2];
    const lastSL = swingLows[swingLows.length - 1];
    const prevSL = swingLows[swingLows.length - 2];

    const isHH = lastSH.price > prevSH.price;
    const isHL = lastSL.price > prevSL.price;
    const isLH = lastSH.price < prevSH.price;
    const isLL = lastSL.price < prevSL.price;

    if (isHH && isHL) trend = 'bullish';
    else if (isLH && isLL) trend = 'bearish';
    else if (isHL) trend = 'bullish_lean';
    else if (isLH) trend = 'bearish_lean';
  }

  // Momentum: EMA 9 vs EMA 21
  const closes = parsed.map(c => c.close);
  const ema9 = calcEMAArray(closes, 9);
  const ema21 = calcEMAArray(closes, 21);
  let momentum = 'neutral';
  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) momentum = 'bullish';
    else if (ema9 < ema21) momentum = 'bearish';
  }

  return {
    trend, momentum, swingHighs, swingLows,
    lastSwingHigh: swingHighs.length ? swingHighs[swingHighs.length - 1] : null,
    lastSwingLow: swingLows.length ? swingLows[swingLows.length - 1] : null,
  };
}

function calcEMAArray(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Fibonacci Retracement ──────────────────────────────────

function calcFibLevels(swingLow, swingHigh) {
  const diff = swingHigh - swingLow;
  return {
    level_0: swingHigh,
    level_236: swingHigh - diff * 0.236,
    level_382: swingHigh - diff * 0.382,
    level_500: swingHigh - diff * 0.500,
    level_618: swingHigh - diff * 0.618,
    level_786: swingHigh - diff * 0.786,
    level_1: swingLow,
  };
}

function isNearFibLevel(price, fibLevels, tolerancePct = 0.003) {
  const keyLevels = [
    { name: 'fib_50', price: fibLevels.level_500 },
    { name: 'fib_618', price: fibLevels.level_618 },
  ];

  for (const level of keyLevels) {
    if (Math.abs(price - level.price) / level.price < tolerancePct) {
      return { isNear: true, level: level.name, levelPrice: level.price };
    }
  }

  // Also check 38.2% as secondary confluence
  if (Math.abs(price - fibLevels.level_382) / fibLevels.level_382 < tolerancePct) {
    return { isNear: true, level: 'fib_382', levelPrice: fibLevels.level_382 };
  }

  return { isNear: false, level: null, levelPrice: null };
}

// ── Strategy 4: Breakout-Retest-Rejection (BRR) ───────────
// Rules:
//   1. Market structure determines direction:
//      - Uptrend (HH+HL) → only BUY
//      - Downtrend (LH+LL) → only SELL
//      - Range/neutral → SKIP (be patient, don't force trades)
//   2. THREE conditions must ALL be met:
//      a) STRONG breakout — big body candle, closes decisively past level
//      b) WEAK retest — small body, low volume pullback toward the level
//      c) CLEAR rejection — wick/pin showing level is defended, close away from level
//   3. Fibonacci 50% / 61.8% retracement adds confluence
//   4. LTF setup must align with HTF structure (don't swim against the current)

function isStrongBreakout(breakCandle, prevCandle, levelPrice, direction, bodyRatio = 1.2) {
  const breakBody = bodySize(breakCandle);
  const breakRange = totalRange(breakCandle);
  const prevBody = bodySize(prevCandle);

  const isLargerBody = breakBody > prevBody * bodyRatio;
  // 2. Break candle body must be > 50% of its total range (not a wick-heavy candle)
  const isFullBody = breakRange > 0 && (breakBody / breakRange) > 0.5;
  // 3. Close must be decisively past the level (> 0.1% beyond it)
  let isDecisive = false;
  if (direction === 'LONG') {
    isDecisive = (breakCandle.close - levelPrice) / levelPrice > 0.003;
  } else {
    isDecisive = (levelPrice - breakCandle.close) / levelPrice > 0.003;
  }

  return isLargerBody && isFullBody && isDecisive;
}

function isWeakRetest(retestCandle, breakCandle, levelPrice, direction, retestRatio = 0.7) {
  const retestBody = bodySize(retestCandle);
  const breakBody = bodySize(breakCandle);
  const retestRange = totalRange(retestCandle);

  const isSmallerBody = retestBody < breakBody * retestRatio;
  // 2. Retest candle range should be smaller (less conviction in pullback)
  const isSmallerRange = retestRange < totalRange(breakCandle) * 0.9;
  // 3. Price touches or comes very close to the level but doesn't close past it
  let touchesLevel = false;
  let closesCorrectSide = false;
  if (direction === 'LONG') {
    touchesLevel = retestCandle.low <= levelPrice * 1.004;
    closesCorrectSide = retestCandle.close > levelPrice;
  } else {
    touchesLevel = retestCandle.high >= levelPrice * 0.996;
    closesCorrectSide = retestCandle.close < levelPrice;
  }

  return isSmallerBody && touchesLevel && closesCorrectSide;
}

function isClearRejection(rejectionCandle, levelPrice, direction) {
  const body = bodySize(rejectionCandle);
  const range = totalRange(rejectionCandle);
  if (range === 0) return false;

  if (direction === 'LONG') {
    // Bullish rejection: long lower wick touching the level, close well above it
    const lowerWick = Math.min(rejectionCandle.open, rejectionCandle.close) - rejectionCandle.low;
    const wickRatio = lowerWick / range;
    const closesAbove = rejectionCandle.close > levelPrice;
    const isGreen = rejectionCandle.close > rejectionCandle.open;
    // Wick must be significant (> 30% of range) OR candle is green closing above level
    return closesAbove && (wickRatio > 0.5) && rejectionCandle.close > rejectionCandle.open;
  } else {
    // Bearish rejection: long upper wick touching the level, close well below it
    const upperWick = rejectionCandle.high - Math.max(rejectionCandle.open, rejectionCandle.close);
    const wickRatio = upperWick / range;
    const closesBelow = rejectionCandle.close < levelPrice;
    const isRed = rejectionCandle.close < rejectionCandle.open;
    return closesBelow && (wickRatio > 0.5) && rejectionCandle.close < rejectionCandle.open;
  }
}

function detectBRR(candles1h, candles15m, candles1m, cfg = {}) {
  const breakoutBodyRatio = cfg.breakoutBodyRatio || 0.8;
  const retestBodyRatio = cfg.retestBodyRatio || 0.7;

  if (!candles1h || candles1h.length < 30 || candles15m.length < 20 || candles1m.length < 15) return null;

  // HTF structure from 1h
  const htf = getHTFStructure(candles1h);

  // RULE: Only trade clear trends. Range/neutral = be patient, skip.
  // Uptrend (HH+HL) → only BUY. Downtrend (LH+LL) → only SELL.
  const htfBullish = htf.trend === 'bullish';
  const htfBearish = htf.trend === 'bearish';
  if (!htfBullish && !htfBearish) return null; // skip leans and neutral — be patient

  // HTF momentum must align with structure
  if (htfBullish && htf.momentum === 'bearish') return null;
  if (htfBearish && htf.momentum === 'bullish') return null;

  const parsed15 = candles15m.map(parseCandle);
  const parsed1 = candles1m.map(parseCandle);
  const levels15 = findKeyLevels(parsed15, 40);

  // Fib from HTF swings
  let fibLevels = null;
  if (htf.lastSwingLow && htf.lastSwingHigh) {
    fibLevels = calcFibLevels(htf.lastSwingLow.price, htf.lastSwingHigh.price);
  }

  // Scan 15m for BRR pattern — all 3 conditions must pass
  for (let i = parsed15.length - 12; i < parsed15.length - 2; i++) {
    if (i < 1) continue;

    for (const level of levels15.slice(0, 8)) {
      const levelPrice = level.price;

      // === BULLISH BRR: uptrend → break above resistance → weak retest → clear rejection ===
      if (htfBullish) {
        const breakCandle = parsed15[i];
        const prevCandle = parsed15[i - 1];

        // Was below, now closes above
        if (!(prevCandle.close < levelPrice && breakCandle.close > levelPrice)) continue;

        // CONDITION 1: Strong breakout
        if (!isStrongBreakout(breakCandle, prevCandle, levelPrice, 'LONG', breakoutBodyRatio)) continue;

        // Look for retest + rejection in subsequent candles
        for (let r = i + 1; r < Math.min(i + 6, parsed15.length); r++) {
          const retestCandle = parsed15[r];

          // CONDITION 2: Weak retest
          if (!isWeakRetest(retestCandle, breakCandle, levelPrice, 'LONG', retestBodyRatio)) continue;

          // CONDITION 3: Clear rejection
          if (!isClearRejection(retestCandle, levelPrice, 'LONG')) continue;

          // All 3 BRR conditions met — check Fibonacci confluence
          let fibConfluence = false;
          let fibLevel = null;
          if (fibLevels) {
            const fibCheck = isNearFibLevel(retestCandle.low, fibLevels, 0.003);
            fibConfluence = fibCheck.isNear;
            fibLevel = fibCheck.level;
          }

          // Entry on 1m confirmation
          const last1m = parsed1[parsed1.length - 1];
          if (last1m.close <= levelPrice) continue;

          const baseScore = 8;
          const fibBonus = fibConfluence ? 4 : 0;
          const momentumBonus = htf.momentum === 'bullish' ? 2 : 0;
          const strongHTFBonus = htf.trend === 'bullish' ? 2 : 0; // full HH+HL trend

          return {
            direction: 'LONG',
            setup: 'BRR_FIBO',
            entryPrice: last1m.close,
            sl: Math.min(retestCandle.low, levelPrice) * 0.997,
            breakoutLevel: levelPrice,
            fibLevel,
            fibConfluence,
            htfTrend: htf.trend,
            htfMomentum: htf.momentum,
            brrConditions: { strongBreakout: true, weakRetest: true, clearRejection: true },
            score: baseScore + fibBonus + momentumBonus + strongHTFBonus,
          };
        }
      }

      // === BEARISH BRR: downtrend → break below support → weak retest → clear rejection ===
      if (htfBearish) {
        const breakCandle = parsed15[i];
        const prevCandle = parsed15[i - 1];

        // Was above, now closes below
        if (!(prevCandle.close > levelPrice && breakCandle.close < levelPrice)) continue;

        // CONDITION 1: Strong breakout
        if (!isStrongBreakout(breakCandle, prevCandle, levelPrice, 'SHORT', breakoutBodyRatio)) continue;

        // Look for retest + rejection
        for (let r = i + 1; r < Math.min(i + 6, parsed15.length); r++) {
          const retestCandle = parsed15[r];

          // CONDITION 2: Weak retest
          if (!isWeakRetest(retestCandle, breakCandle, levelPrice, 'SHORT', retestBodyRatio)) continue;

          // CONDITION 3: Clear rejection
          if (!isClearRejection(retestCandle, levelPrice, 'SHORT')) continue;

          // All 3 BRR conditions met — check Fibonacci
          let fibConfluence = false;
          let fibLevel = null;
          if (fibLevels) {
            const fibCheck = isNearFibLevel(retestCandle.high, fibLevels, 0.003);
            fibConfluence = fibCheck.isNear;
            fibLevel = fibCheck.level;
          }

          // Entry on 1m
          const last1m = parsed1[parsed1.length - 1];
          if (last1m.close >= levelPrice) continue;

          const baseScore = 8;
          const fibBonus = fibConfluence ? 4 : 0;
          const momentumBonus = htf.momentum === 'bearish' ? 2 : 0;
          const strongHTFBonus = htf.trend === 'bearish' ? 2 : 0;

          return {
            direction: 'SHORT',
            setup: 'BRR_FIBO',
            entryPrice: last1m.close,
            sl: Math.max(retestCandle.high, levelPrice) * 1.003,
            breakoutLevel: levelPrice,
            fibLevel,
            fibConfluence,
            htfTrend: htf.trend,
            htfMomentum: htf.momentum,
            brrConditions: { strongBreakout: true, weakRetest: true, clearRejection: true },
            score: baseScore + fibBonus + momentumBonus + strongHTFBonus,
          };
        }
      }
    }
  }

  return null;
}

// ── Strategy 6: SMC HL HL HL / LH LH LH Structure Trade ────
// Multi-timeframe cascade (per PDF + Zeiierman style):
//   15m: Zeiierman curved structure (HL HL = bullish, LH LH = bearish)
//   15m: EMA55 strength confirms direction (slope not opposing)
//   3m:  EMA9 > EMA21 alignment (trend continuation, not reversal)
//   1m:  Trigger on NEXT closed candle (broke prior 1m high/low) + volume
//
// ONLY fires during institutional session windows (Asia/Europe/US open).
// Trailing SL handles exit — no fixed TP (per PDF rule).

function detectSMCStructureTrade(candles15m, candles3m, candles1m, h1Trend = 'neutral') {
  if (candles15m.length < 60 || candles3m.length < 20 || candles1m.length < 10) return null;

  // ── STEP 1: EMA55 strength on 15m ──────────────────────────
  // 55 × 15min ≈ 13.75h — reliable medium-term trend proxy
  const ema55 = calcEMAStrength(candles15m, Math.min(55, candles15m.length - 5), 5);
  if (!ema55.ema) return null;

  // ── STEP 2: Zeiierman curved structure on 15m ───────────────
  const structure = detectCurvedStructure(candles15m);
  if (!structure) return null;

  // ── STEP 3: 3m EMA alignment ───────────────────────────────
  const closes3 = candles3m.map(c => c.close);
  const ema9_3m  = calcEMA(closes3, 9);
  const ema21_3m = calcEMA(closes3, 21);
  if (!ema9_3m || !ema21_3m) return null;
  const trend3Bullish = ema9_3m > ema21_3m;
  const trend3Bearish = ema9_3m < ema21_3m;

  // ── STEP 4: 1m trigger ─────────────────────────────────────
  const last1 = candles1m[candles1m.length - 1];
  const vol1m = hasVolumeConfirm(candles1m, candles1m.length - 1, 1.2);
  const atr15 = calcATR(candles15m);

  // ── LONG: HL HL structure + EMA55 above + 3m bullish + 1m retest of HL ──
  // SMC/ICT: BUY at the BOTTOM of the HL (when price pulls back to the HL zone
  // and rejects bullishly), NOT on a breakout above a prior high (which buys the top).
  // Entry condition:
  //   1. 1m candle's LOW came within 0.5% of the last swing low (HL level) — it tested support
  //   2. Candle closed BULLISH (rejection of the HL)
  //   3. Close is in the upper 60% of the candle — strong rejection, not a doji
  //   4. Volume confirmed
  const lastHL = structure.swingLows.length > 0 ? structure.swingLows[structure.swingLows.length - 1].rawLow : null;

  if (
    structure.isBullish &&
    ema55.isBullish &&
    (h1Trend === 'bullish' || h1Trend === 'neutral') &&
    trend3Bullish &&
    lastHL &&
    last1.low  <= lastHL * 1.005 &&                                     // wick tested the HL zone
    isGreenCandle(last1) &&                                             // closed bullish (rejection)
    last1.close >= last1.low + (last1.high - last1.low) * 0.6 &&       // closed in upper 60%
    vol1m
  ) {
    // SL just below the HL — tight because we're entering right at support
    const slPrice = lastHL * 0.997;

    return {
      direction: 'LONG',
      setup: 'SMC_HL_STRUCTURE',
      entryPrice: last1.close,
      sl: slPrice,
      hlCount:     structure.hlCount,
      probability: structure.longProbability,
      ema55Slope:  Math.round(ema55.slope * 10000) / 100,
      tf15: 'HL_HL_bullish',
      tf3:  'EMA_aligned',
      tf1:  '1m_hl_retest',
    };
  }

  // ── SHORT: LH LH structure + EMA55 below + 3m bearish + 1m retest of LH ──
  // Sell at the TOP of the LH (when price rallies back to the LH zone and rejects bearishly).
  const lastLH = structure.swingHighs.length > 0 ? structure.swingHighs[structure.swingHighs.length - 1].rawHigh : null;

  if (
    structure.isBearish &&
    ema55.isBearish &&
    (h1Trend === 'bearish' || h1Trend === 'neutral') &&
    trend3Bearish &&
    lastLH &&
    last1.high >= lastLH * 0.995 &&                                     // wick tested the LH zone
    isRedCandle(last1) &&                                               // closed bearish (rejection)
    last1.close <= last1.high - (last1.high - last1.low) * 0.6 &&      // closed in lower 60%
    vol1m
  ) {
    // SL just above the LH — tight because we're entering right at resistance
    const slPrice = lastLH * 1.003;

    return {
      direction: 'SHORT',
      setup: 'SMC_HL_STRUCTURE',
      entryPrice: last1.close,
      sl: slPrice,
      lhCount:     structure.lhCount,
      probability: structure.shortProbability,
      ema55Slope:  Math.round(ema55.slope * 10000) / 100,
      tf15: 'LH_LH_bearish',
      tf3:  'EMA_aligned',
      tf1:  '1m_lh_retest',
    };
  }

  return null;
}

// ── Trend-Follow Entry: 3-timeframe cascade ───────────────
//
// Full entry rules:
//
//  LONG:
//    1. 15m trend = HH + HL (confirmed uptrend)
//    2. 3m swing  = most recent 3m swing low is an HL (higher low on 3m)
//    3. 1m entry  = next 1m candle after the 3m HL is green (bullish)
//       SL = 0.3% below the 3m HL level
//
//  SHORT:
//    1. 15m trend = LL + LH (confirmed downtrend)
//    2. 3m swing  = most recent 3m swing high is a LH (lower high on 3m)
//    3. 1m entry  = next 1m candle after the 3m LH is red (bearish)
//       SL = 0.3% above the 3m LH level
//
//  No LONG in downtrend. No SHORT in uptrend.
//  3m HL/LH must be within last 10 × 3m bars (≈30 min) — keeps entries fresh.
// ──────────────────────────────────────────────────────────

function detectTrendFollowEntry(klines15m, klines3m, klines1m) {
  if (!klines15m || klines15m.length < 30) return null;
  if (!klines3m  || klines3m.length  < 10) return null;
  if (!klines1m  || klines1m.length  <  3) return null;

  const parsed15 = klines15m.map(parseCandle);
  const parsed3  = klines3m.map(parseCandle);
  const parsed1  = klines1m.map(parseCandle);

  // ── Step 1: 15m trend — 2-bar pivot swing detection ─────
  const sh15 = [];
  const sl15 = [];
  for (let i = 2; i < parsed15.length - 2; i++) {
    if (
      parsed15[i].high > parsed15[i - 1].high && parsed15[i].high > parsed15[i - 2].high &&
      parsed15[i].high > parsed15[i + 1].high && parsed15[i].high > parsed15[i + 2].high
    ) sh15.push({ price: parsed15[i].high, index: i });
    if (
      parsed15[i].low < parsed15[i - 1].low && parsed15[i].low < parsed15[i - 2].low &&
      parsed15[i].low < parsed15[i + 1].low && parsed15[i].low < parsed15[i + 2].low
    ) sl15.push({ price: parsed15[i].low, index: i });
  }
  if (sh15.length < 2 || sl15.length < 2) return null;

  const lastSH15 = sh15[sh15.length - 1];
  const prevSH15 = sh15[sh15.length - 2];
  const lastSL15 = sl15[sl15.length - 1];
  const prevSL15 = sl15[sl15.length - 2];

  const isBullTrend = lastSH15.price > prevSH15.price && lastSL15.price > prevSL15.price; // HH+HL
  const isBearTrend = lastSH15.price < prevSH15.price && lastSL15.price < prevSL15.price; // LH+LL

  if (!isBullTrend && !isBearTrend) return null;

  // ── Step 2: 3m swing — 1-bar pivot (responsive for entry timing) ──
  // Confirmed pivot at index i requires bars i-1 and i+1 to exist.
  // Most recent confirmed swing is at parsed3.length - 2.
  const sh3 = [];
  const sl3 = [];
  for (let i = 1; i < parsed3.length - 1; i++) {
    if (parsed3[i].high > parsed3[i - 1].high && parsed3[i].high > parsed3[i + 1].high)
      sh3.push({ price: parsed3[i].high, index: i });
    if (parsed3[i].low  < parsed3[i - 1].low  && parsed3[i].low  < parsed3[i + 1].low)
      sl3.push({ price: parsed3[i].low,  index: i });
  }
  if (sl3.length < 2 || sh3.length < 2) return null;

  const lastSL3 = sl3[sl3.length - 1];
  const prevSL3 = sl3[sl3.length - 2];
  const lastSH3 = sh3[sh3.length - 1];
  const prevSH3 = sh3[sh3.length - 2];

  const is3mHL = lastSL3.price > prevSL3.price; // 3m Higher Low  → bullish pull-back
  const is3mLH = lastSH3.price < prevSH3.price; // 3m Lower  High → bearish bounce

  // 3m HL/LH must be fresh — within last 10 × 3m bars (≈30 min)
  const RECENCY_3M = 10;
  const total3 = parsed3.length;

  // ── Step 3: 1m entry candle ──────────────────────────────
  const last1  = parsed1[parsed1.length - 1];
  const price  = last1.close;

  // ── LONG: 15m HH+HL  +  3m HL  +  next 1m green ────────
  if (
    isBullTrend &&
    is3mHL &&
    (total3 - lastSL3.index) <= RECENCY_3M &&
    isGreenCandle(last1)
  ) {
    const hlLevel3m = lastSL3.price;
    // Price should still be near the 3m HL (not already run far above it)
    const pctAbove = (price - hlLevel3m) / hlLevel3m;
    if (pctAbove >= 0 && pctAbove <= 0.015) {
      return {
        direction:  'LONG',
        setup:      'TREND_FOLLOW_HL',
        entryPrice: price,
        sl:         hlLevel3m * 0.997, // SL just below the 3m HL
        trend:      'bullish_HH_HL',
        hlLevel3m,
        tf15: `HH(${prevSH15.price.toFixed(4)}→${lastSH15.price.toFixed(4)})`
            + `+HL(${prevSL15.price.toFixed(4)}→${lastSL15.price.toFixed(4)})`,
        tf3:  `3m_HL(${prevSL3.price.toFixed(4)}→${lastSL3.price.toFixed(4)})`,
        tf1:  'next_1m_green_entry',
      };
    }
  }

  // ── SHORT: 15m LH+LL  +  3m LH  +  next 1m red ─────────
  if (
    isBearTrend &&
    is3mLH &&
    (total3 - lastSH3.index) <= RECENCY_3M &&
    isRedCandle(last1)
  ) {
    const lhLevel3m = lastSH3.price;
    const pctBelow = (lhLevel3m - price) / lhLevel3m;
    if (pctBelow >= 0 && pctBelow <= 0.015) {
      return {
        direction:  'SHORT',
        setup:      'TREND_FOLLOW_LH',
        entryPrice: price,
        sl:         lhLevel3m * 1.003, // SL just above the 3m LH
        trend:      'bearish_LL_LH',
        lhLevel3m,
        tf15: `LH(${prevSH15.price.toFixed(4)}→${lastSH15.price.toFixed(4)})`
            + `+LL(${prevSL15.price.toFixed(4)}→${lastSL15.price.toFixed(4)})`,
        tf3:  `3m_LH(${prevSH3.price.toFixed(4)}→${lastSH3.price.toFixed(4)})`,
        tf1:  'next_1m_red_entry',
      };
    }
  }

  return null;
}

// ── MCT Session Windows (from PDF strategy) ────────────────
// Only trade during the 3 institutional opening windows.
// Outside these windows: institutions are not active, moves are unreliable.
//
// Asia-Pacific:  23:00–02:00 UTC  (7:00–10:00 AM SGT)
// European:      07:00–10:00 UTC  (3:00–6:00 PM SGT)
// U.S.:          12:00–16:00 UTC  (8:00 PM–12:00 AM SGT)

const SESSION_WINDOWS = [
  { name: 'Asia',   startH: 23, endH: 2  },  // wraps midnight
  { name: 'Europe', startH: 7,  endH: 10 },
  { name: 'US',     startH: 12, endH: 16 },
];

// Hours and minutes to AVOID entering (per PDF):
// "Avoid entries at 8am, 12pm, 4pm, and 8pm UTC"
// "Avoid minute timings like 00, 15, 30, 45"
const AVOID_HOURS_UTC   = new Set([8, 12, 16, 20]);
const AVOID_MINUTES_UTC = new Set([0, 15, 30, 45]);

// Session open blackout: first 30 minutes of each session = institutional fake-out zone.
// EU opens at 07:00, Asia at 23:00, US at 12:00 — institutions run fake sweeps to trap
// retail before the real direction. Don't enter during this window.
const SESSION_OPEN_BLACKOUT_MIN = 30;

function isSessionOpenBlackout(tsMs = Date.now()) {
  const d    = new Date(tsMs);
  const utcH = d.getUTCHours();
  const utcM = d.getUTCMinutes();
  for (const win of SESSION_WINDOWS) {
    if (utcH === win.startH && utcM < SESSION_OPEN_BLACKOUT_MIN) return true;
  }
  return false;
}

function getActiveSession() {
  const now = new Date();
  const utcH = now.getUTCHours();
  for (const win of SESSION_WINDOWS) {
    if (win.startH > win.endH) {
      // Wraps midnight (Asia: 23–02)
      if (utcH >= win.startH || utcH < win.endH) return win;
    } else {
      if (utcH >= win.startH && utcH < win.endH) return win;
    }
  }
  return null; // outside all windows
}

function isAvoidTime() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  if (AVOID_HOURS_UTC.has(utcH) && utcM < 3) return true;   // ±3 min buffer around avoid hours
  if (AVOID_MINUTES_UTC.has(utcM)) return true;               // avoid 00, 15, 30, 45 min marks
  if (isSessionOpenBlackout()) return true;                   // first 30 min of each session = fake-out zone
  return false;
}

// True only when inside a session window AND not at a candle-open time to avoid
function isGoodTradingSession() {
  if (isAvoidTime()) return false;
  return getActiveSession() !== null;
}

// ── Daily Stats ────────────────────────────────────────────
// PDF rule: max 2 trades weekdays, max 1 trade weekends.
// Stop immediately after 2 consecutive losses.

const dailyStats = { date: '', trades: 0, consecutiveLosses: 0 };

function getTradingDay() {
  // Trading day resets at 7am UTC (PDF: "resets at 7am")
  const now = new Date();
  const utcH = now.getUTCHours();
  const d = new Date(now);
  if (utcH < 7) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getDailyTradeLimit() {
  const dow = new Date().getUTCDay(); // 0=Sun, 6=Sat
  return (dow === 0 || dow === 6) ? 1 : 2; // 1 on weekends, 2 on weekdays
}

function recordDailyTrade(isWin) {
  const tradingDay = getTradingDay();
  if (dailyStats.date !== tradingDay) {
    dailyStats.date = tradingDay;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }
  dailyStats.trades++;
  if (isWin) {
    dailyStats.consecutiveLosses = 0;
  } else {
    dailyStats.consecutiveLosses++;
  }
}

function checkDailyLimits() {
  const tradingDay = getTradingDay();
  if (dailyStats.date !== tradingDay) {
    dailyStats.date = tradingDay;
    dailyStats.trades = 0;
    dailyStats.consecutiveLosses = 0;
  }
  if (dailyStats.consecutiveLosses >= 2) {
    return { canTrade: false, reason: `${dailyStats.consecutiveLosses} consecutive losses — stopped for today. Resets at 7am UTC.` };
  }
  const limit = getDailyTradeLimit();
  if (dailyStats.trades >= limit) {
    return { canTrade: false, reason: `Daily trade limit reached (${dailyStats.trades}/${limit}). Resets at 7am UTC.` };
  }
  return { canTrade: true };
}

// ── Swing Detection (kept for 15m exit monitoring) ─────────

const SWING_LENGTHS = { '15m': 10, '3m': 10, '1m': 5 };

function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const swings = [];
  let lastType = null;

  for (let i = len; i < klines.length - len; i++) {
    let isHigh = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) { isHigh = false; break; }
    }

    let isLow = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (lows[i] >= lows[i + j]) { isLow = false; break; }
    }

    if (isHigh && isLow) {
      const highDist = highs[i] - Math.max(highs[i - 1], highs[i + 1]);
      const lowDist = Math.min(lows[i - 1], lows[i + 1]) - lows[i];
      if (highDist > lowDist) isLow = false;
      else isHigh = false;
    }

    if (isHigh) {
      if (lastType === 'high') {
        const prev = swings[swings.length - 1];
        if (highs[i] > prev.price) swings[swings.length - 1] = { type: 'high', index: i, price: highs[i], candle: klines[i] };
      } else {
        swings.push({ type: 'high', index: i, price: highs[i], candle: klines[i] });
        lastType = 'high';
      }
    }

    if (isLow) {
      if (lastType === 'low') {
        const prev = swings[swings.length - 1];
        if (lows[i] < prev.price) swings[swings.length - 1] = { type: 'low', index: i, price: lows[i], candle: klines[i] };
      } else {
        swings.push({ type: 'low', index: i, price: lows[i], candle: klines[i] });
        lastType = 'low';
      }
    }
  }

  return swings;
}

// ── Analyze Single Coin ────────────────────────────────────

async function analyzeCoin(ticker, params, enabledStrategies = null, strategyCfg = {}, btcTrend = 'neutral') {
  const symbol = ticker.symbol;
  const price = parseFloat(ticker.lastPrice);

  const [klines1h, klines15m, klines3m, klines1m] = await Promise.all([
    fetchKlines(symbol, '1h', 60),
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '3m', 50),
    fetchKlines(symbol, '1m', 50),
  ]);

  if (!klines15m || !klines1m) return null;
  if (klines15m.length < 30 || klines1m.length < 10) return null;

  const parsed15 = klines15m.map(parseCandle);
  const parsed3  = klines3m ? klines3m.map(parseCandle) : [];
  const parsed1  = klines1m.map(parseCandle);
  const atr15 = calcATR(parsed15);

  // ── GLOBAL FILTERS ──────────────────────────────────────
  // ATR volatility filter: reject illiquid or insanely volatile
  const atrPct = atr15 / price;
  if (atrPct < 0.002 || atrPct > 0.03) return null; // 0.2% - 3% ATR range

  // RSI filter
  const rsi14 = calcRSI(parsed15);

  // 1h trend + EMA200 bias (PDF: "above MA200 → look long, below → look short")
  let h1Trend = 'neutral';
  let h1Ema21 = null;
  let ema200_bias = 'neutral'; // 'bullish' | 'bearish' — hard filter from PDF
  if (klines1h && klines1h.length >= 20) {
    const parsed1h = klines1h.map(parseCandle);
    const h1Closes = parsed1h.map(c => c.close);
    const h1Ema9  = calcEMA(h1Closes, 9);
    h1Ema21 = calcEMA(h1Closes, 21);
    if (h1Ema9 !== null && h1Ema21 !== null) {
      h1Trend = h1Ema9 > h1Ema21 ? 'bullish' : 'bearish';
    }
    // EMA200 needs ≥200 candles — use whatever we have (60 is often the max fetched)
    // Fall back to EMA55 as a medium-term proxy when <200 bars available
    const ema200period = Math.min(200, h1Closes.length - 1);
    const ema200_1h = ema200period >= 10 ? calcEMA(h1Closes, ema200period) : null;
    if (ema200_1h !== null) {
      ema200_bias = price > ema200_1h ? 'bullish' : 'bearish';
    }
  }

  // ── VWAP + OP daily bias (PDF rule) + VWAP band filter ─────
  // "If price > OP AND > VWAP → look LONG only. If < OP AND < VWAP → look SHORT only."
  // Opening Price (OP) = first 15m candle open of the UTC day
  //
  // VWAP Standard-Deviation Bands (user rule):
  //   Upper band = VWAP + VWAP_BAND_MULT × σ
  //   Lower band = VWAP − VWAP_BAND_MULT × σ
  //   price > upper band → bullish zone → NO SHORT until price falls below upper band
  //   price < lower band → bearish zone → NO LONG  until price rises above lower band
  const VWAP_BAND_MULT = 1.0; // 1 standard deviation (matches TradingView default)
  let opBias      = 'neutral';
  let vwapUpper   = null;
  let vwapLower   = null;
  let vwapMid     = null;
  // Default: unknown — if VWAP can't be computed, block both directions (no trade)
  let vwapBandPos = 'unknown';
  {
    const now = new Date();
    const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const todayCandles = parsed15.filter(c => c.openTime >= dayStartMs);
    // Fall back to all 15m candles when the session has just started (<3 candles today)
    const vwapCandles = todayCandles.length >= 3 ? todayCandles : parsed15;
    const opPrice = todayCandles.length > 0 ? todayCandles[0].open : null;

    if (vwapCandles.length > 0) {
      // Step 1: VWAP
      let cumTV = 0, cumV = 0;
      const typicals = [];
      for (const c of vwapCandles) {
        const tp = (c.high + c.low + c.close) / 3;
        typicals.push(tp);
        cumTV += tp * c.volume;
        cumV  += c.volume;
      }
      const vwapVal = cumV > 0 ? cumTV / cumV : null;

      if (vwapVal) {
        // Step 2: volume-weighted variance → std dev
        let cumVarTV = 0;
        for (let i = 0; i < vwapCandles.length; i++) {
          const diff = typicals[i] - vwapVal;
          cumVarTV += vwapCandles[i].volume * diff * diff;
        }
        const variance = cumV > 0 ? cumVarTV / cumV : 0;
        const stdDev   = Math.sqrt(variance);

        vwapMid   = vwapVal;
        vwapUpper = vwapVal + VWAP_BAND_MULT * stdDev;
        vwapLower = vwapVal - VWAP_BAND_MULT * stdDev;

        // Where is price relative to VWAP?
        // Rule: price < VWAP mid → bearish zone → NO LONG, only SHORT
        //       price > VWAP mid → bullish zone → NO SHORT, only LONG
        // Extreme zones (outside bands) add extra confirmation.
        if (price >= vwapUpper)      vwapBandPos = 'above_upper';  // strongly bullish
        else if (price >= vwapVal)   vwapBandPos = 'above_mid';    // mildly bullish
        else if (price <= vwapLower) vwapBandPos = 'below_lower';  // strongly bearish
        else                         vwapBandPos = 'below_mid';    // price < VWAP mid → bearish
      }

      // OP + VWAP directional bias (unchanged)
      if (opPrice && vwapVal) {
        if (price > opPrice && price > vwapVal)      opBias = 'bullish';
        else if (price < opPrice && price < vwapVal) opBias = 'bearish';
      }
    }
  }

  // 15m EMA for pullback detection (buy low, sell high)
  const closes15 = parsed15.map(c => c.close);
  const ema21_15m = calcEMA(closes15, 21);
  const ema9_15m = calcEMA(closes15, 9);

  // Position quality: is price at a good entry or chasing?
  // LONG entry = price should be near or below EMA21 (pulled back, not extended)
  // SHORT entry = price should be near or above EMA21 (bounced, not crashed)
  let entryQuality = 'neutral';
  if (ema21_15m !== null) {
    const distFromEma = (price - ema21_15m) / ema21_15m;
    // For LONG: price near/below EMA21 = good dip buy (within -1% to +0.3%)
    // For LONG: price far above EMA21 (>0.5%) = chasing, bad entry
    // For SHORT: price near/above EMA21 = good sell point
    // For SHORT: price far below EMA21 = chasing the dump
    if (distFromEma > 0.015) entryQuality = 'extended_up';     // >1.5% above EMA = chasing up
    else if (distFromEma < -0.015) entryQuality = 'extended_down'; // >1.5% below EMA = chasing down
    else if (distFromEma >= -0.005 && distFromEma <= 0.005) entryQuality = 'at_ema'; // within 0.5% of EMA = best
    else entryQuality = 'near_ema'; // 0.5-1.5% off EMA — acceptable
  }

  // Recent high/low to detect if we're at extreme
  const recent20 = parsed15.slice(-20);
  const recentHigh = Math.max(...recent20.map(c => c.high));
  const recentLow = Math.min(...recent20.map(c => c.low));
  const recentRange = recentHigh - recentLow;
  const priceInRange = recentRange > 0 ? (price - recentLow) / recentRange : 0.5; // 0=bottom, 1=top

  // ── SWING POINT PROXIMITY (buy HL/LL, sell HH/LH) ────────
  // Detect 15m pivot swing lows and highs for structural entry quality.
  // A LONG entry must be near a swing low (HL or LL), a SHORT near a swing high.
  const structSwingLows  = [];
  const structSwingHighs = [];
  for (let i = 2; i < parsed15.length - 1; i++) {
    if (parsed15[i].low  < parsed15[i-1].low  && parsed15[i].low  < parsed15[i+1].low)  structSwingLows.push(parsed15[i].low);
    if (parsed15[i].high > parsed15[i-1].high && parsed15[i].high > parsed15[i+1].high) structSwingHighs.push(parsed15[i].high);
  }
  // Nearest swing low AT or below current price (support below us)
  const nearestSwingLow  = [...structSwingLows].filter(l => l <= price * 1.002).sort((a, b) => b - a)[0] || null;
  // Nearest swing high AT or above current price (resistance above us)
  const nearestSwingHigh = [...structSwingHighs].filter(h => h >= price * 0.998).sort((a, b) => a - b)[0] || null;

  // ── 1m SPIKE DETECTION ───────────────────────────────────
  // The 15m RSI lags by up to 3 candles during a short-timeframe spike.
  // Directly measure 1m momentum: if price moved >1.0% in the last 3×1m candles
  // it's an active spike — entering in the spike direction means buying the top.
  let spike3mPct = 0;
  if (parsed1.length >= 3) {
    const spBase = parsed1[parsed1.length - 3].open;
    if (spBase > 0) spike3mPct = (parsed1[parsed1.length - 1].close - spBase) / spBase;
  }

  // Volume on latest candle
  const lastVolOK = parsed15.length >= 22 && hasVolumeConfirm(parsed15, parsed15.length - 1, 1.0);

  const allLevels = findKeyLevels(parsed15, 80);
  const trendlines = detectTrendlines(parsed15);

  // Try enabled strategies — pick highest scoring
  const signals = [];

  // Strategy 1: Liquidity Sweep
  if (!enabledStrategies || enabledStrategies.LIQUIDITY_SWEEP) {
  const sweep = detectLiquiditySweep(klines15m, klines1m);
  if (sweep) {
    const tp = findNearestLevel(sweep.entryPrice, allLevels, sweep.direction);
    const slDist = Math.abs(sweep.entryPrice - sweep.sl) / sweep.entryPrice;
    const tpPrice = tp ? tp.price : sweep.direction === 'LONG'
      ? sweep.entryPrice * (1 + slDist * 2)
      : sweep.entryPrice * (1 - slDist * 2);
    const tpDist = Math.abs(tpPrice - sweep.entryPrice) / sweep.entryPrice;
    const rr = tpDist / slDist;

    if (rr >= 1.5 && slDist > 0.001 && slDist < 0.05) {
      signals.push({
        symbol, direction: sweep.direction, price: sweep.entryPrice,
        lastPrice: price,
        sl: sweep.sl,
        tp1: tpPrice,
        tp2: sweep.direction === 'LONG' ? sweep.entryPrice + (tpDist * price * 1.5) : sweep.entryPrice - (tpDist * price * 1.5),
        tp3: sweep.direction === 'LONG' ? sweep.entryPrice + (tpDist * price * 2) : sweep.entryPrice - (tpDist * price * 2),
        slDist, setup: 'LIQUIDITY_SWEEP',
        setupName: `${sweep.direction}-LIQ-SWEEP`,
        score: 6 + (rr > 2 ? 2 : 0),
        rr: Math.round(rr * 10) / 10,
      });
    }
  }
  } // end LIQUIDITY_SWEEP gate

  // Strategy 2: Stop-Loss Hunt
  if (!enabledStrategies || enabledStrategies.STOP_LOSS_HUNT) {
  const hunt = detectStopLossHunt(klines15m, klines1m, strategyCfg.hunt || {});
  if (hunt) {
    const tp = findNearestLevel(hunt.entryPrice, allLevels, hunt.direction);
    const slDist = Math.abs(hunt.entryPrice - hunt.sl) / hunt.entryPrice;
    const tpPrice = tp ? tp.price : hunt.direction === 'LONG'
      ? hunt.entryPrice * (1 + slDist * 2.5)
      : hunt.entryPrice * (1 - slDist * 2.5);
    const tpDist = Math.abs(tpPrice - hunt.entryPrice) / hunt.entryPrice;
    const rr = tpDist / slDist;

    if (rr >= 1.5 && slDist > 0.001 && slDist < 0.05) {
      const touchBonus = Math.min(hunt.touches, 4);
      signals.push({
        symbol, direction: hunt.direction, price: hunt.entryPrice,
        lastPrice: price,
        sl: hunt.sl,
        tp1: tpPrice,
        tp2: hunt.direction === 'LONG' ? hunt.entryPrice + (tpDist * price * 1.5) : hunt.entryPrice - (tpDist * price * 1.5),
        tp3: hunt.direction === 'LONG' ? hunt.entryPrice + (tpDist * price * 2) : hunt.entryPrice - (tpDist * price * 2),
        slDist, setup: 'STOP_LOSS_HUNT',
        setupName: `${hunt.direction}-SL-HUNT`,
        score: 7 + Math.min(touchBonus, 3),
        rr: Math.round(rr * 10) / 10,
      });
    }
  }
  } // end STOP_LOSS_HUNT gate

  // Strategy 3: Momentum Scalping
  if (!enabledStrategies || enabledStrategies.MOMENTUM_SCALP) {
  const momentum = detectMomentumScalp(klines15m, klines1m, strategyCfg.momentum || {});
  if (momentum) {
    const slDist = Math.abs(momentum.entryPrice - momentum.sl) / momentum.entryPrice;
    const tp = findNearestLevel(momentum.entryPrice, allLevels, momentum.direction);
    const tpPrice = tp ? tp.price : momentum.direction === 'LONG'
      ? momentum.entryPrice * (1 + slDist * 2)
      : momentum.entryPrice * (1 - slDist * 2);
    const tpDist = Math.abs(tpPrice - momentum.entryPrice) / momentum.entryPrice;
    const rr = tpDist / slDist;

    if (rr >= 1.5 && slDist > 0.001 && slDist < 0.05) {
      signals.push({
        symbol, direction: momentum.direction, price: momentum.entryPrice,
        lastPrice: price,
        sl: momentum.sl,
        tp1: tpPrice,
        tp2: momentum.direction === 'LONG' ? momentum.entryPrice + (tpDist * price * 1.5) : momentum.entryPrice - (tpDist * price * 1.5),
        tp3: momentum.direction === 'LONG' ? momentum.entryPrice + (tpDist * price * 2) : momentum.entryPrice - (tpDist * price * 2),
        slDist, setup: 'MOMENTUM_SCALP',
        setupName: `${momentum.direction}-MOM-SCALP`,
        score: 5,
        rr: Math.round(rr * 10) / 10,
      });
    }
  }
  } // end MOMENTUM_SCALP gate

  // Strategy 4: BRR (Breakout-Retest-Rejection) + Fibonacci
  if (!enabledStrategies || enabledStrategies.BRR_FIBO) {
  const brr = detectBRR(klines1h, klines15m, klines1m, strategyCfg.brr || {});
  if (brr) {
    const slDist = Math.abs(brr.entryPrice - brr.sl) / brr.entryPrice;
    const tp = findNearestLevel(brr.entryPrice, allLevels, brr.direction);
    const tpPrice = tp ? tp.price : brr.direction === 'LONG'
      ? brr.entryPrice * (1 + slDist * 2.5)
      : brr.entryPrice * (1 - slDist * 2.5);
    const tpDist = Math.abs(tpPrice - brr.entryPrice) / brr.entryPrice;
    const rr = tpDist / slDist;

    if (rr >= 1.5 && slDist > 0.001 && slDist < 0.05) {
      signals.push({
        symbol, direction: brr.direction, price: brr.entryPrice,
        lastPrice: price,
        sl: brr.sl,
        tp1: tpPrice,
        tp2: brr.direction === 'LONG' ? brr.entryPrice + (tpDist * price * 1.5) : brr.entryPrice - (tpDist * price * 1.5),
        tp3: brr.direction === 'LONG' ? brr.entryPrice + (tpDist * price * 2) : brr.entryPrice - (tpDist * price * 2),
        slDist, setup: 'BRR_FIBO',
        setupName: `${brr.direction}-BRR${brr.fibConfluence ? '+FIB' : ''}`,
        score: brr.score,
        rr: Math.round(rr * 10) / 10,
        fibLevel: brr.fibLevel,
        htfTrend: brr.htfTrend,
      });
    }
  }
  } // end BRR_FIBO gate

  // Strategy 5: SMC Classic (Daily Bias → 4H+1H HTF → 15m Setup → 1m Entry)
  if ((!enabledStrategies || enabledStrategies.SMC_CLASSIC) && smcEngine) {
    try {
      const dailyBiasCache = new Map();
      const smcSignal = await smcEngine.analyzeLHHL(
        { symbol, lastPrice: price }, await aiLearner.getOptimalParams(), dailyBiasCache
      );
      if (smcSignal && smcSignal.score >= 8) {
        signals.push({
          symbol, direction: smcSignal.direction, price: smcSignal.price || price,
          lastPrice: price,
          sl: smcSignal.sl,
          tp1: smcSignal.tp1,
          tp2: smcSignal.tp2,
          tp3: smcSignal.tp3,
          slDist: smcSignal.slDist || Math.abs(price - smcSignal.sl) / price,
          setup: 'SMC_CLASSIC',
          setupName: `${smcSignal.direction}-SMC`,
          score: smcSignal.score,
          rr: smcSignal.slDist > 0 ? Math.abs(smcSignal.tp1 - price) / Math.abs(price - smcSignal.sl) : 1.5,
        });
      }
    } catch { /* SMC engine error — skip */ }
  } // end SMC_CLASSIC gate

  // Strategy 6: SMC HL Structure (Zeiierman curved + EMA55 + 3m/1m cascade)
  if (!enabledStrategies || enabledStrategies.SMC_HL_STRUCTURE !== false) {
    if (parsed3.length >= 20) {
      const hlSignal = detectSMCStructureTrade(parsed15, parsed3, parsed1, h1Trend);
      if (hlSignal) {
        const slDist  = Math.abs(hlSignal.entryPrice - hlSignal.sl) / hlSignal.entryPrice;
        const atrTp   = calcATR(parsed15) * 2.5;
        const tp1     = hlSignal.direction === 'LONG'
          ? hlSignal.entryPrice + atrTp
          : hlSignal.entryPrice - atrTp;
        const rr      = slDist > 0 ? atrTp / (hlSignal.entryPrice * slDist) : 1.5;

        // Base score 10: premium strategy with all 3 TF alignment + volume
        // Bonus: high probability from Zeiierman band position, hlCount
        let score = 10;
        if ((hlSignal.probability || 0) > 60) score += 2;
        if ((hlSignal.hlCount || hlSignal.lhCount || 0) >= 2) score += 2;

        signals.push({
          symbol,
          direction: hlSignal.direction,
          price: hlSignal.entryPrice,
          lastPrice: price,
          sl: hlSignal.sl,
          tp1,
          tp2: hlSignal.direction === 'LONG' ? hlSignal.entryPrice + atrTp * 1.5 : hlSignal.entryPrice - atrTp * 1.5,
          tp3: hlSignal.direction === 'LONG' ? hlSignal.entryPrice + atrTp * 2   : hlSignal.entryPrice - atrTp * 2,
          slDist,
          rr,
          setup: 'SMC_HL_STRUCTURE',
          setupName: `${hlSignal.direction}-HL${hlSignal.hlCount || hlSignal.lhCount || ''}`,
          score,
          zeiierProb: hlSignal.probability || 0,
          tf15: hlSignal.tf15,
          tf3:  hlSignal.tf3,
          tf1:  hlSignal.tf1,
        });
      }
    }
  } // end SMC_HL_STRUCTURE gate

  // Strategy 7: Trend-Follow HL/LH — HH+HL uptrend → LONG; LL+LH downtrend → SHORT
  // Entry: next 1m candle after the swing HL (for longs) or LH (for shorts) has confirmed.
  if (!enabledStrategies || enabledStrategies.TREND_FOLLOW !== false) {
    const tfSignal = detectTrendFollowEntry(klines15m, klines3m, klines1m);
    if (tfSignal) {
      const slDist = Math.abs(tfSignal.entryPrice - tfSignal.sl) / tfSignal.entryPrice;
      const tpPrice = findNearestLevel(tfSignal.entryPrice, allLevels, tfSignal.direction)?.price
        || (tfSignal.direction === 'LONG'
          ? tfSignal.entryPrice * (1 + slDist * 2.5)
          : tfSignal.entryPrice * (1 - slDist * 2.5));
      const tpDist = Math.abs(tpPrice - tfSignal.entryPrice) / tfSignal.entryPrice;
      const rr = slDist > 0 ? tpDist / slDist : 1.5;
      if (rr >= 1.5 && slDist > 0.001 && slDist < 0.05) {
        signals.push({
          symbol,
          direction:  tfSignal.direction,
          price:      tfSignal.entryPrice,
          lastPrice:  price,
          sl:         tfSignal.sl,
          tp1:        tpPrice,
          tp2:        tfSignal.direction === 'LONG'
            ? tfSignal.entryPrice + tpDist * price * 1.5
            : tfSignal.entryPrice - tpDist * price * 1.5,
          tp3:        tfSignal.direction === 'LONG'
            ? tfSignal.entryPrice + tpDist * price * 2.0
            : tfSignal.entryPrice - tpDist * price * 2.0,
          slDist,
          setup:      tfSignal.setup,
          setupName:  `${tfSignal.direction}-${tfSignal.setup}`,
          score:      9, // high base score — trend-confirmed entry
          rr:         Math.round(rr * 10) / 10,
          tf15:       tfSignal.tf15,
          tf1:        tfSignal.tf1,
          trendTag:   tfSignal.trend,
        });
      }
    }
  } // end TREND_FOLLOW gate

  if (!signals.length) return null;

  // Detect 15m swing structure for the hard direction filter below
  const swingTrend15 = getHTFStructure(klines15m);

  // Apply confluence bonuses + global filters to all signals
  for (const sig of signals) {
    // ── PDF HARD FILTERS ─────────────────────────────────────

    // EMA200 bias (PDF: "above MA200 → look long, below → look short")
    // Hard block if direction conflicts with EMA200 trend
    if (ema200_bias === 'bullish' && sig.direction === 'SHORT') {
      sig.score = -99;
      sig.blocked = `SHORT blocked — price above EMA200 (bullish bias per PDF)`;
      continue;
    }
    if (ema200_bias === 'bearish' && sig.direction === 'LONG') {
      sig.score = -99;
      sig.blocked = `LONG blocked — price below EMA200 (bearish bias per PDF)`;
      continue;
    }

    // ── 15m SWING STRUCTURE DIRECTION FILTER (user rule) ────
    // HH+HL (bullish) or HL only (bullish_lean) → LONG only  (no short)
    // LL+LH (bearish) or LH only (bearish_lean) → SHORT only (no long)
    const is15mBearish = swingTrend15.trend === 'bearish' || swingTrend15.trend === 'bearish_lean';
    const is15mBullish = swingTrend15.trend === 'bullish' || swingTrend15.trend === 'bullish_lean';
    if (is15mBullish && sig.direction === 'SHORT') {
      sig.score = -99;
      sig.blocked = `SHORT blocked — 15m swing structure is ${swingTrend15.trend}: no short while trend is up`;
      continue;
    }
    if (is15mBearish && sig.direction === 'LONG') {
      sig.score = -99;
      sig.blocked = `LONG blocked — 15m swing structure is ${swingTrend15.trend}: no long while trend is down`;
      continue;
    }
    // Reward with-trend entries for trending structures
    if ((is15mBullish && sig.direction === 'LONG') ||
        (is15mBearish && sig.direction === 'SHORT')) {
      sig.score += 3;
      sig.swingAligned = true;
    }

    // ── VWAP DIRECTION FILTER (user rule) ────────────────────
    // price >= VWAP mid → bullish side → SHORT blocked
    // price <  VWAP mid → bearish side → LONG blocked
    // unknown           → VWAP not computable → block all trades
    if (vwapBandPos === 'unknown') {
      sig.score = -99;
      sig.blocked = 'blocked — VWAP not available, skipping trade';
      continue;
    }
    const isVwapBearish = vwapBandPos === 'below_mid' || vwapBandPos === 'below_lower';
    const isVwapBullish = vwapBandPos === 'above_mid' || vwapBandPos === 'above_upper';
    if (isVwapBearish && sig.direction === 'LONG') {
      sig.score = -99;
      sig.blocked = `LONG blocked — price below VWAP (mid=${vwapMid?.toFixed(4)}, price=${price.toFixed(4)}): bearish side, no longs until price rises above VWAP`;
      continue;
    }
    if (isVwapBullish && sig.direction === 'SHORT') {
      sig.score = -99;
      sig.blocked = `SHORT blocked — price above VWAP (mid=${vwapMid?.toFixed(4)}, price=${price.toFixed(4)}): bullish side, no shorts until price falls below VWAP`;
      continue;
    }
    // Reward entries deep in the correct zone (outside bands = strong confirmation)
    if (vwapBandPos === 'above_upper' && sig.direction === 'LONG')  sig.score += 2;
    if (vwapBandPos === 'below_lower' && sig.direction === 'SHORT') sig.score += 2;

    // VWAP + OP bias (PDF: "avoid entering in between VWAP and OP if gap is small")
    // Hard block if direction conflicts with OP+VWAP combined bias
    if (opBias === 'bullish' && sig.direction === 'SHORT') {
      sig.score -= 3; // strong headwind — not a hard block, but very costly
      sig.opVwapContra = true;
    }
    if (opBias === 'bearish' && sig.direction === 'LONG') {
      sig.score -= 3;
      sig.opVwapContra = true;
    }
    if (opBias === 'neutral') {
      // Between OP and VWAP — small gap zone, PDF says avoid
      sig.score -= 2;
    }
    // Bonus: direction aligns with both OP and VWAP
    if ((opBias === 'bullish' && sig.direction === 'LONG') ||
        (opBias === 'bearish' && sig.direction === 'SHORT')) {
      sig.score += 3;
    }

    // Session tag — add active session name to signal
    const sess = getActiveSession();
    if (sess) sig.session = sess.name;

    // ── POSITION QUALITY: buy low, sell high — don't chase ──

    // RSI: LONG should enter on pullback (RSI 25-55), not when overbought
    //       SHORT should enter on bounce (RSI 45-75), not when oversold
    if (sig.direction === 'LONG') {
      if (rsi14 > 70) { sig.score = -99; sig.blocked = 'LONG rejected — RSI ' + rsi14.toFixed(0) + ' overbought, chasing'; }
      else if (rsi14 > 55) sig.score -= 2; // slightly extended
      else if (rsi14 >= 30 && rsi14 <= 50) sig.score += 2; // pullback zone — ideal buy
      else if (rsi14 < 25) sig.score += 1; // oversold bounce possible
    }
    if (sig.direction === 'SHORT') {
      if (rsi14 < 30) { sig.score = -99; sig.blocked = 'SHORT rejected — RSI ' + rsi14.toFixed(0) + ' oversold, chasing'; }
      else if (rsi14 < 45) sig.score -= 2; // slightly extended
      else if (rsi14 >= 50 && rsi14 <= 70) sig.score += 2; // bounce zone — ideal sell
      else if (rsi14 > 75) sig.score += 1; // overbought reversal possible
    }

    // EMA position: don't chase extended moves
    if (sig.direction === 'LONG') {
      if (entryQuality === 'extended_up') { sig.score -= 4; sig.chasing = true; } // chasing pump
      if (entryQuality === 'at_ema' || entryQuality === 'near_ema') sig.score += 2; // pullback to EMA = good
      if (entryQuality === 'extended_down') sig.score += 1; // dip buy
    }
    if (sig.direction === 'SHORT') {
      if (entryQuality === 'extended_down') { sig.score -= 4; sig.chasing = true; } // chasing dump
      if (entryQuality === 'at_ema' || entryQuality === 'near_ema') sig.score += 2; // bounce from EMA = good
      if (entryQuality === 'extended_up') sig.score += 1; // sell the rally
    }

    // ── 1m SPIKE HARD BLOCK ──────────────────────────────────
    // RSI(14) on 15m candles lags 3×5m candles behind a spike. Measure it
    // directly: if price moved >1.0% in the last 3×1m candles, entering in
    // the spike direction = buying the top / selling the bottom.
    if (sig.direction === 'LONG' && spike3mPct > 0.010) {
      sig.score = -99;
      sig.blocked = `LONG blocked — 1m up-spike +${(spike3mPct * 100).toFixed(2)}% in 3 candles (chasing top)`;
    }
    if (sig.direction === 'SHORT' && spike3mPct < -0.010) {
      sig.score = -99;
      sig.blocked = `SHORT blocked — 1m down-spike ${(spike3mPct * 100).toFixed(2)}% in 3 candles (chasing bottom)`;
    }

    // Price position in range: LONG must be near the LOW, SHORT near the HIGH.
    // Hard block if price is at the wrong extreme — never buy tops, never sell bottoms.
    if (sig.direction === 'LONG') {
      if (priceInRange > 0.80) {
        sig.score = -99;
        sig.blocked = `LONG blocked — price at ${(priceInRange * 100).toFixed(0)}% of 5h range (top — should SHORT not LONG)`;
      } else if (priceInRange < 0.35) sig.score += 2; // near the bottom — ideal HL/LL entry
      else if (priceInRange > 0.65) sig.score -= 3;   // upper half but not blocked — risky
    }
    if (sig.direction === 'SHORT') {
      if (priceInRange < 0.20) {
        sig.score = -99;
        sig.blocked = `SHORT blocked — price at ${(priceInRange * 100).toFixed(0)}% of 5h range (bottom — should LONG not SHORT)`;
      } else if (priceInRange > 0.75) sig.score += 4; // at the very top — ideal SHORT zone
      else if (priceInRange > 0.65) sig.score += 2;   // near the top — good SHORT zone
    }

    // Structural proximity: reward entries tight to actual swing structure (HL/LL for LONG, HH/LH for SHORT)
    if (sig.direction === 'LONG' && nearestSwingLow) {
      const pctFromLow = (price - nearestSwingLow) / nearestSwingLow;
      if (pctFromLow <= 0.005)       sig.score += 3; // price at swing low — perfect HL/LL retest
      else if (pctFromLow <= 0.015)  sig.score += 1; // within 1.5% — acceptable pullback
    }
    if (sig.direction === 'SHORT' && nearestSwingHigh) {
      const pctFromHigh = (nearestSwingHigh - price) / nearestSwingHigh;
      if (pctFromHigh <= 0.005)      sig.score += 3; // price at swing high — perfect HH/LH test
      else if (pctFromHigh <= 0.015) sig.score += 1; // within 1.5% — acceptable bounce
    }

    // 1h trend alignment — hard block for counter-trend, bonus for with-trend
    if (sig.direction === 'LONG' && h1Trend === 'bearish') {
      sig.score = -99;
      sig.blocked = 'LONG blocked — 1h EMA9 < EMA21 (1h downtrend): no long against higher-TF trend';
      continue;
    }
    if (sig.direction === 'SHORT' && h1Trend === 'bullish') {
      sig.score = -99;
      sig.blocked = 'SHORT blocked — 1h EMA9 > EMA21 (1h uptrend): no short against higher-TF trend';
      continue;
    }
    if (sig.direction === 'LONG' && h1Trend === 'bullish') sig.score += 3;
    if (sig.direction === 'SHORT' && h1Trend === 'bearish') sig.score += 3;

    // BTC market correlation: don't fight BTC's direction on altcoins
    // When BTC is clearly bullish, shorting alts is fighting the market
    if (symbol !== 'BTCUSDT') {
      if (btcTrend === 'bullish' && sig.direction === 'SHORT') {
        sig.score = -99;
        sig.blocked = 'SHORT blocked — BTC is bullish, alts follow BTC';
        continue;
      }
      if (btcTrend === 'bearish' && sig.direction === 'LONG') {
        sig.score = -99;
        sig.blocked = 'LONG blocked — BTC is bearish, alts follow BTC';
        continue;
      }
      // Bonus for trading WITH BTC direction
      if (btcTrend === 'bullish' && sig.direction === 'LONG') sig.score += 2;
      if (btcTrend === 'bearish' && sig.direction === 'SHORT') sig.score += 2;
    }

    // Volume confirmation
    if (lastVolOK) sig.score += 2;

    // Trendline confluence (tightened to 0.2%)
    if (sig.direction === 'LONG' && trendlines.uptrend) {
      const trendDist = Math.abs(sig.price - trendlines.uptrend.currentPrice) / sig.price;
      if (trendDist < 0.002) { sig.score += 2; sig.trendlineConfluence = 'uptrend_support'; }
    }
    if (sig.direction === 'SHORT' && trendlines.downtrend) {
      const trendDist = Math.abs(sig.price - trendlines.downtrend.currentPrice) / sig.price;
      if (trendDist < 0.002) { sig.score += 2; sig.trendlineConfluence = 'downtrend_resistance'; }
    }

    // Candlestick pattern at zone
    const nearestZone = allLevels.find(z => isInZone(sig.price, z) || Math.abs(sig.price - z.price) / sig.price < 0.003);
    if (nearestZone) {
      const candleConf = hasCandleConfirmation(parsed1, nearestZone, sig.direction);
      if (candleConf.confirmed) { sig.score += 3; sig.candlePattern = candleConf.pattern; }
      if (nearestZone.strength >= 4) sig.score += 2;
      else if (nearestZone.strength >= 2) sig.score += 1;
      sig.zoneStrength = nearestZone.strength;
    }

    // Dynamic ATR-based SL: use ATR as MINIMUM distance — give room to breathe
    if (atr15 > 0) {
      const atrSl = sig.direction === 'LONG' ? sig.price - atr15 * 1.2 : sig.price + atr15 * 1.2;
      // Use ATR SL if it's WIDER than strategy SL (more room = fewer stop-outs on noise)
      if (sig.direction === 'LONG' && atrSl < sig.sl) sig.sl = atrSl;
      if (sig.direction === 'SHORT' && atrSl > sig.sl) sig.sl = atrSl;
      sig.slDist = Math.abs(sig.price - sig.sl) / sig.price;
    }

    // Smart TP: find nearest strong S/R level in direction
    const strongLevels = allLevels.filter(l => l.strength >= 3);
    const tpLevel = findNearestLevel(sig.price, strongLevels, sig.direction, sig.slDist * 1.2);
    if (tpLevel) {
      sig.tp1 = tpLevel.price;
    } else {
      // Fallback: ATR-based TP (2x ATR)
      sig.tp1 = sig.direction === 'LONG' ? sig.price + atr15 * 2.0 : sig.price - atr15 * 2.0;
    }
    sig.tp2 = sig.direction === 'LONG' ? sig.price + Math.abs(sig.tp1 - sig.price) * 1.5 : sig.price - Math.abs(sig.tp1 - sig.price) * 1.5;
    sig.tp3 = sig.direction === 'LONG' ? sig.price + Math.abs(sig.tp1 - sig.price) * 2.0 : sig.price - Math.abs(sig.tp1 - sig.price) * 2.0;

    // Recalculate RR with updated SL/TP
    const tpDist = Math.abs(sig.tp1 - sig.price) / sig.price;
    sig.rr = sig.slDist > 0 ? Math.round(tpDist / sig.slDist * 10) / 10 : 1.0;
  }

  // Log blocked signals for debugging
  const blocked = signals.filter(s => s.blocked);
  for (const b of blocked) {
    bLog.scan(`${symbol}: ${b.direction} ${b.setup} BLOCKED — ${b.blocked} (1h trend=${h1Trend})`);
  }

  // Filter: RR minimum 1.2, SL reasonable, not blocked by trend
  const validSignals = signals.filter(s => s.rr >= 1.2 && s.slDist > 0.001 && s.slDist < 0.03 && s.score >= 0);

  if (!validSignals.length) return null;

  // Return highest scoring signal
  validSignals.sort((a, b) => b.score - a.score);
  const best = validSignals[0];

  // Add AI modifier
  const aiModifier = await aiLearner.getAIScoreModifier(symbol, best.setup, best.direction);
  best.score = Math.round(best.score * aiModifier * 10) / 10;
  best.aiModifier = Math.round(aiModifier * 100) / 100;

  // Add leverage
  const BTC_ETH = new Set(['BTCUSDT', 'ETHUSDT']);
  best.leverage = BTC_ETH.has(symbol) ? Math.min(params.LEV_BTC_ETH || 20, 20) : Math.min(params.LEV_ALT || 20, 20);

  // Add structure info for logging
  best.structure = {
    setup: best.setup,
    tf15: best.tf15 || 'sweep-engine',
    tf3:  best.tf3  || null,
    tf1:  best.tf1  || 'entry-confirmed',
    trendline: best.trendlineConfluence || null,
    candlePattern: best.candlePattern || null,
    zoneStrength: best.zoneStrength || null,
    zeiierProb: best.zeiierProb || null,
    session: best.session || null,
    ema200bias: ema200_bias,
    opVwapBias: opBias,
    swingTrend: swingTrend15.trend,
    swingAligned: best.swingAligned || false,
    trendTag: best.trendTag || null,
    vwapMid:   vwapMid   ? Math.round(vwapMid   * 10000) / 10000 : null,
    vwapUpper: vwapUpper ? Math.round(vwapUpper * 10000) / 10000 : null,
    vwapLower: vwapLower ? Math.round(vwapLower * 10000) / 10000 : null,
    vwapBandPos,
  };

  return best;
}

// ── Main Scan ──────────────────────────────────────────────

async function scanSMC(log, opts = {}) {
  const limits = checkDailyLimits();
  if (!limits.canTrade) {
    log(`Liquidity Engine: ${limits.reason}. Stopped trading.`);
    bLog.scan(limits.reason);
    return [];
  }

  if (isAvoidTime()) {
    log('Liquidity Engine: Candle-open avoid time (UTC 8/12/16/20 or minute 0/15/30/45). Skipping entry.');
    bLog.scan('Avoid candle-open time per PDF rules.');
    return [];
  }

  const activeSession = getActiveSession();
  if (!activeSession) {
    // NOTE: AI session override removed — trading outside institutional windows causes losses.
    // Sessions (Asia 23-02, Europe 07-10, US 12-16 UTC) are hard boundaries, not suggestions.
    log('Liquidity Engine: Outside session windows (Asia 23-02/Europe 07-10/US 12-16 UTC). Waiting.');
    bLog.scan('Outside institutional session windows. No trades until next opening.');
    return [];
  }
  bLog.scan(`Active session: ${activeSession.name} (${activeSession.startH}:00–${activeSession.endH}:00 UTC)`);

  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('Failed to fetch tickers'); return []; }

  const BLACKLIST = new Set([
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ]);

  const topCoins = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !BLACKLIST.has(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, opts.topNCoins || TOP_N_COINS);

  const params = await aiLearner.getOptimalParams();
  const minScore = params.MIN_SCORE || 8;

  // Quantum optimizer: get active strategy combo + best params from backtest
  let activeCombo = 15;
  let enabledStrategies = null;
  let comboName = 'ALL';
  let bestParams = {};
  try {
    const quantumOptimizer = require('./quantum-optimizer');
    activeCombo = await quantumOptimizer.getActiveCombo();
    enabledStrategies = quantumOptimizer.getEnabledStrategies(activeCombo);
    comboName = quantumOptimizer.comboToName(activeCombo);
    bestParams = await quantumOptimizer.getActiveParams();
  } catch (err) {
    bLog.error(`Quantum optimizer not available: ${err.message} — using all strategies`);
  }

  // BTC market trend: when BTC is clearly trending, don't fight it on alts
  let btcTrend = 'neutral';
  try {
    const btcKlines = await fetchKlines('BTCUSDT', '1h', 30);
    if (btcKlines && btcKlines.length >= 20) {
      const btcParsed = btcKlines.map(parseCandle);
      const btcCloses = btcParsed.map(c => c.close);
      const btcEma9 = calcEMA(btcCloses, 9);
      const btcEma21 = calcEMA(btcCloses, 21);
      if (btcEma9 !== null && btcEma21 !== null) {
        const btcDist = (btcEma9 - btcEma21) / btcEma21;
        // Only set trend when clear (>0.2% EMA spread)
        if (btcDist > 0.002) btcTrend = 'bullish';
        else if (btcDist < -0.002) btcTrend = 'bearish';
      }
    }
  } catch (_) { /* BTC fetch failed — continue with neutral */ }

  const sessionTag = activeSession ? activeSession.name : 'AI-override';
  const dailyLimit = getDailyTradeLimit();
  bLog.scan(`Session=${sessionTag} | BTC trend=${btcTrend} | Quantum combo=${comboName} (${activeCombo}) | ${topCoins.length} coins | daily trades=${dailyStats.trades}/${dailyLimit}`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      continue;
    }

    const signal = await analyzeCoin(ticker, params, enabledStrategies, bestParams, btcTrend);
    if (signal) signal.comboId = activeCombo;
    analyzed++;

    if (signal && signal.score >= minScore) {
      results.push(signal);
      bLog.scan(
        `SIGNAL: ${signal.symbol} ${signal.direction} | score=${signal.score} ` +
        `setup=${signal.setupName} RR=1:${signal.rr} | ` +
        `SL=$${signal.sl.toFixed(4)} TP=$${signal.tp1.toFixed(4)} lev=${signal.leverage}x`
      );
    }

    await new Promise(r => setTimeout(r, 200));
  }

  if (skippedAI > 0) bLog.ai(`AI avoided ${skippedAI} coins`);
  bLog.scan(`Scan complete: ${analyzed} analyzed, ${results.length} signals`);

  if (!results.length) {
    bLog.scan('No signals — no liquidity sweep patterns found.');
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3);
}

module.exports = {
  scanSMC,
  analyzeCoin,
  recordDailyTrade,
  checkDailyLimits,
  isGoodTradingSession,
  getActiveSession,
  isAvoidTime,
  isSessionOpenBlackout,
  getDailyTradeLimit,
  SESSION_WINDOWS,
  detectSwings,
  SWING_LENGTHS,
  detectLiquiditySweep,
  detectStopLossHunt,
  detectMomentumScalp,
  detectBRR,
  detectSMCStructureTrade,
  detectCurvedStructure,
  calcEMAStrength,
  findKeyLevels,
  detectTrendlines,
  hasCandleConfirmation,
};
