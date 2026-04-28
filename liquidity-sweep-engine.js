// ============================================================
// VWAP + Structure Trading Engine
//
// Active Strategies:
//   1. Liquidity Sweep     — 15m range break + close back inside, 1m entry
//   3. Momentum Scalping   — 15m EMA trend + 1m pin bar failure
//   6. SMC HL Structure    — Zeiierman curved structure + EMA55 + 1m cascade
//   8. Strategy V2         — 15m swing + 1m confirmation + milestone trail
//  11. Structure Follow    — (15m HL/HH) + (1m HH/HL) = LONG
//                            (15m LH/LL) + (1m LL/LH) = SHORT
//
// Entry gates (ALL signals must pass):
//   • Price > VWAP upper band → LONG only  (SHORT blocked)
//   • Price < VWAP lower band → SHORT only (LONG blocked)
//   • Price between bands     → structure decides (both OK)
//   • Structure: (15m HL||HH) + (1m HH||HL) for LONG
//               (15m LH||LL) + (1m LL||LH) for SHORT
//
// Tokens: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT  |  Leverage: 100×
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');
const { getMarketIntel, applyMarketIntel, heatmapToLevels, logMarketIntel } = require('./coinglass-data');
const { detectV2Signal } = require('./strategy-v2');
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

// ── HTF Market Structure ───────────────────────────────────

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

// ── Strategy 6: SMC HL HL HL / LH LH LH Structure Trade ────
// Multi-timeframe cascade (per PDF + Zeiierman style):
//   15m: Zeiierman curved structure (HL HL = bullish, LH LH = bearish)
//   15m: EMA55 strength confirms direction (slope not opposing)
//   3m:  EMA9 > EMA21 alignment (trend continuation, not reversal)
//   1m:  Trigger on NEXT closed candle (broke prior 1m high/low) + volume
//
// ONLY fires during institutional session windows (Asia/Europe/US open).
// Trailing SL handles exit — no fixed TP (per PDF rule).

// NOTE: Previously took a candles3m parameter for the EMA alignment step.
// Now uses 15m EMA9/21 throughout — more reliable, no extra TF needed.
function detectSMCStructureTrade(candles15m, candles1m, h1Trend = 'neutral') {
  if (candles15m.length < 60 || candles1m.length < 10) return null;

  // ── STEP 1: EMA55 strength on 15m ──────────────────────────
  // 55 × 15min ≈ 13.75h — reliable medium-term trend proxy
  const ema55 = calcEMAStrength(candles15m, Math.min(55, candles15m.length - 5), 5);
  if (!ema55.ema) return null;

  // ── STEP 2: Zeiierman curved structure on 15m ───────────────
  const structure = detectCurvedStructure(candles15m);
  if (!structure) return null;

  // ── STEP 3: 15m EMA9/21 alignment (replaces former 3m EMA check) ─────────
  const closes15 = candles15m.map(c => c.close);
  const ema9_15m  = calcEMA(closes15, 9);
  const ema21_15m = calcEMA(closes15, 21);
  if (!ema9_15m || !ema21_15m) return null;
  const trend3Bullish = ema9_15m > ema21_15m; // keep variable name for compatibility
  const trend3Bearish = ema9_15m < ema21_15m;

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

// ── No session restrictions — trade 24/7 ───────────────────

// Stub kept so cycle.js import of recordDailyTrade doesn't break
function recordDailyTrade() {}
function checkDailyLimits() { return { canTrade: true }; }
function getDailyTradeLimit() { return Infinity; }
function isGoodTradingSession() { return true; }
function getActiveSession() { return null; }
function isAvoidTime() { return false; }
function isSessionOpenBlackout() { return false; }

const SESSION_WINDOWS = [];

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

  const [klines1h, klines15m, klines3m, klines1m, marketIntel] = await Promise.all([
    fetchKlines(symbol, '1h', 60),
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '3m', 50),
    fetchKlines(symbol, '1m', 300), // 300 candles = ~5h of 1m data for accurate VWAP session
    getMarketIntel(symbol),
  ]);

  if (!klines15m || !klines3m) return null;
  if (klines15m.length < 30 || klines3m.length < 10) return null;

  const parsed15 = klines15m.map(parseCandle);
  const parsed1  = klines3m.map(parseCandle);   // 3m used for swing detection in strategies
  const parsed1m = klines1m ? klines1m.map(parseCandle) : [];
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
  const VWAP_BAND_MULT = 1.0; // 1 standard deviation (matches TradingView VWAP Session)
  let opBias      = 'neutral';
  let vwapUpper   = null;
  let vwapLower   = null;
  let vwapMid     = null;
  // Default: unknown — if VWAP can't be computed, block both directions (no trade)
  let vwapBandPos = 'unknown';
  {
    const now = new Date();
    const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    // Use 1m candles for VWAP — matches TradingView VWAP Session resolution.
    // 15m candles produce σ ≈ 4–5× wider bands (coarser typical price swings).
    // Filter to today's session only; fall back to last 60 1m bars if session is fresh.
    const today1m = parsed1m.filter(c => c.openTime >= dayStartMs);
    const vwapCandles = today1m.length >= 10 ? today1m
                      : parsed1m.length  >= 10 ? parsed1m.slice(-60)
                      : parsed15.filter(c => c.openTime >= dayStartMs);

    const opCandles15 = parsed15.filter(c => c.openTime >= dayStartMs);
    const opPrice = opCandles15.length > 0 ? opCandles15[0].open : null;

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

        // Band position — bands are the hard lines (matches TradingView visual):
        //   price > upper band → LONG zone   (above upper = bullish extreme)
        //   price < lower band → SHORT zone  (below lower = bearish extreme)
        //   between bands      → neutral     (both directions allowed by structure)
        if (price >= vwapUpper)      vwapBandPos = 'above_upper';
        else if (price <= vwapLower) vwapBandPos = 'below_lower';
        else if (price >= vwapVal)   vwapBandPos = 'above_mid';
        else                         vwapBandPos = 'below_mid';
      }

      // OP + VWAP directional bias
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
  // Merge Coinglass liquidation cluster levels into S/R map
  // These are real stop-hunt targets — price will be pulled to them
  const liqLevels = heatmapToLevels(marketIntel?.heatmapLevels, price);
  if (liqLevels.length) allLevels.push(...liqLevels);
  logMarketIntel(symbol, marketIntel);

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

  // Strategy 6: SMC HL Structure (Zeiierman curved + EMA55 + 15m EMA/1m cascade)
  if (!enabledStrategies || enabledStrategies.SMC_HL_STRUCTURE !== false) {
    if (parsed15.length >= 20) {
      const hlSignal = detectSMCStructureTrade(parsed15, parsed1, h1Trend);
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

  // Strategy 8: Strategy V2 — 15m swing + 1m confirmation + milestone trail
  if (!enabledStrategies || enabledStrategies.STRATEGY_V2 !== false) {
    const v2Signal = await detectV2Signal(symbol, params.LEV_BTC_ETH || 100);
    if (v2Signal) {
      signals.push({
        symbol,
        direction: v2Signal.direction,
        price:     v2Signal.price,
        lastPrice: price,
        sl:        v2Signal.sl,
        tp1:       v2Signal.tp1,
        tp2:       v2Signal.tp1, // trail manages profit — tp2/3 are placeholders
        tp3:       v2Signal.tp1,
        slDist:    v2Signal.slDist,
        setup:     'STRATEGY_V2',
        setupName: v2Signal.setupName,
        score:     v2Signal.score,
        rr:        v2Signal.rr,
        tf15:      v2Signal.structure.swing15,
        tf1:       v2Signal.structure.confirm1m,
      });
    }
  } // end STRATEGY_V2 gate

  // Strategy 11: Structure Follow
  // LONG:  (15m HL or HH) + (1m HH or HL) → LONG
  // SHORT: (15m LH or LL) + (1m LL or LH) → SHORT
  {
    const PIVOT_B = 2;
    const sHs15 = [], sLs15 = [];
    for (let i = PIVOT_B; i < parsed15.length - PIVOT_B; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= PIVOT_B; j++) {
        if (parsed15[i].high <= parsed15[i-j].high || parsed15[i].high <= parsed15[i+j].high) isH = false;
        if (parsed15[i].low  >= parsed15[i-j].low  || parsed15[i].low  >= parsed15[i+j].low)  isL = false;
      }
      if (isH) sHs15.push(parsed15[i].high);
      if (isL) sLs15.push(parsed15[i].low);
    }
    const has15mHL = sLs15.length >= 2 && sLs15[sLs15.length - 1] > sLs15[sLs15.length - 2];
    const has15mHH = sHs15.length >= 2 && sHs15[sHs15.length - 1] > sHs15[sHs15.length - 2];
    const has15mLH = sHs15.length >= 2 && sHs15[sHs15.length - 1] < sHs15[sHs15.length - 2];
    const has15mLL = sLs15.length >= 2 && sLs15[sLs15.length - 1] < sLs15[sLs15.length - 2];

    const pH1m = [], pL1m = [];
    for (let i = PIVOT_B; i < parsed1.length - PIVOT_B; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= PIVOT_B; j++) {
        if (parsed1[i].high <= parsed1[i-j].high || parsed1[i].high <= parsed1[i+j].high) isH = false;
        if (parsed1[i].low  >= parsed1[i-j].low  || parsed1[i].low  >= parsed1[i+j].low)  isL = false;
      }
      if (isH) pH1m.push(parsed1[i].high);
      if (isL) pL1m.push(parsed1[i].low);
    }
    const has1mHH = pH1m.length >= 2 && pH1m[pH1m.length - 1] > pH1m[pH1m.length - 2];
    const has1mHL = pL1m.length >= 2 && pL1m[pL1m.length - 1] > pL1m[pL1m.length - 2];
    const has1mLL = pL1m.length >= 2 && pL1m[pL1m.length - 1] < pL1m[pL1m.length - 2];
    const has1mLH = pH1m.length >= 2 && pH1m[pH1m.length - 1] < pH1m[pH1m.length - 2];

    const longOk  = (has15mHL || has15mHH) && (has1mHH || has1mHL);
    const shortOk = (has15mLH || has15mLL) && (has1mLL || has1mLH);

    const atr = calcATR(parsed15);

    if (longOk) {
      const sl     = pL1m.length ? Math.min(...pL1m.slice(-3)) * 0.9995 : price * 0.998;
      const slDist = Math.abs(price - sl) / price;
      const tp1    = price + atr * 2.0;
      const rr     = slDist > 0 ? Math.round((atr * 2.0) / (price * slDist) * 10) / 10 : 0;
      if (rr >= 1.2 && slDist > 0.001 && slDist < 0.03) {
        const tag15 = has15mHL ? `HL:${sLs15[sLs15.length-2]?.toFixed(2)}→${sLs15[sLs15.length-1]?.toFixed(2)}` : `HH:${sHs15[sHs15.length-2]?.toFixed(2)}→${sHs15[sHs15.length-1]?.toFixed(2)}`;
        const tag1  = has1mHH  ? `HH:${pH1m[pH1m.length-2]?.toFixed(2)}→${pH1m[pH1m.length-1]?.toFixed(2)}`  : `HL:${pL1m[pL1m.length-2]?.toFixed(2)}→${pL1m[pL1m.length-1]?.toFixed(2)}`;
        signals.push({
          symbol, direction: 'LONG', price, lastPrice: price,
          sl, tp1, tp2: price + atr * 3.0, tp3: price + atr * 4.0,
          slDist, setup: 'STRUCTURE_FOLLOW',
          setupName: `LONG-${has15mHL ? '15HL' : '15HH'}-${has1mHH ? '1HH' : '1HL'}`,
          score: 8, rr, tf15: `15m ${tag15}`, tf1: `1m ${tag1}`,
        });
      }
    }

    if (shortOk) {
      const sl     = pH1m.length ? Math.max(...pH1m.slice(-3)) * 1.0005 : price * 1.002;
      const slDist = Math.abs(sl - price) / price;
      const tp1    = price - atr * 2.0;
      const rr     = slDist > 0 ? Math.round((atr * 2.0) / (price * slDist) * 10) / 10 : 0;
      if (rr >= 1.2 && slDist > 0.001 && slDist < 0.03) {
        const tag15 = has15mLH ? `LH:${sHs15[sHs15.length-2]?.toFixed(2)}→${sHs15[sHs15.length-1]?.toFixed(2)}` : `LL:${sLs15[sLs15.length-2]?.toFixed(2)}→${sLs15[sLs15.length-1]?.toFixed(2)}`;
        const tag1  = has1mLL  ? `LL:${pL1m[pL1m.length-2]?.toFixed(2)}→${pL1m[pL1m.length-1]?.toFixed(2)}`  : `LH:${pH1m[pH1m.length-2]?.toFixed(2)}→${pH1m[pH1m.length-1]?.toFixed(2)}`;
        signals.push({
          symbol, direction: 'SHORT', price, lastPrice: price,
          sl, tp1, tp2: price - atr * 3.0, tp3: price - atr * 4.0,
          slDist, setup: 'STRUCTURE_FOLLOW',
          setupName: `SHORT-${has15mLH ? '15LH' : '15LL'}-${has1mLL ? '1LL' : '1LH'}`,
          score: 8, rr, tf15: `15m ${tag15}`, tf1: `1m ${tag1}`,
        });
      }
    }
  } // end STRUCTURE_FOLLOW

  if (!signals.length) return null;

  // Detect 15m swing structure for the hard direction filter below
  const swingTrend15 = getHTFStructure(klines15m);

  // Apply confluence bonuses + global filters to all signals
  for (const sig of signals) {

    // ── VWAP + STRUCTURE RULE ────────────────────────────────────────────────
    //
    // Entry condition (all zones):
    //   LONG  → 15m HL (last swing low > prev swing low) + 1m HH (last pivot high > prev)
    //   SHORT → 15m LH (last swing high < prev swing high) + 1m LL (last pivot low < prev)
    //
    // VWAP band hard blocks — 3 VWAP lines (lower / mid / upper):
    //   price > upper band → LONG only  (no SHORT above upper line)
    //   price < lower band → SHORT only (no LONG  below lower line)
    //   between bands      → both directions OK, structure decides
    //
    // VWAP unknown → block all.
    if (vwapBandPos === 'unknown') {
      sig.score = -99;
      sig.blocked = 'blocked — VWAP not available';
      continue;
    }

    // Hard VWAP band blocks
    if (vwapBandPos === 'above_upper' && sig.direction === 'SHORT') {
      sig.score = -99;
      sig.blocked = `SHORT blocked — price above VWAP upper (${vwapUpper?.toFixed(2)}): LONG only`;
      continue;
    }
    if (vwapBandPos === 'below_lower' && sig.direction === 'LONG') {
      sig.score = -99;
      sig.blocked = `LONG blocked — price below VWAP lower (${vwapLower?.toFixed(2)}): SHORT only`;
      continue;
    }

    // ── 15m + 1m structure confirmation ─────────────────────────────────────
    // LONG:  (15m HL or HH) + (1m HH or HL)
    // SHORT: (15m LH or LL) + (1m LL or LH)
    {
      const sHs15 = swingTrend15.swingHighs;
      const sLs15 = swingTrend15.swingLows;
      const has15mHL = sLs15.length >= 2 && sLs15[sLs15.length - 1].price > sLs15[sLs15.length - 2].price;
      const has15mHH = sHs15.length >= 2 && sHs15[sHs15.length - 1].price > sHs15[sHs15.length - 2].price;
      const has15mLH = sHs15.length >= 2 && sHs15[sHs15.length - 1].price < sHs15[sHs15.length - 2].price;
      const has15mLL = sLs15.length >= 2 && sLs15[sLs15.length - 1].price < sLs15[sLs15.length - 2].price;

      const P1B = 2;
      const pH1m = [], pL1m = [];
      for (let i = P1B; i < parsed1.length - P1B; i++) {
        let isH = true, isL = true;
        for (let j = 1; j <= P1B; j++) {
          if (parsed1[i].high <= parsed1[i - j].high || parsed1[i].high <= parsed1[i + j].high) isH = false;
          if (parsed1[i].low  >= parsed1[i - j].low  || parsed1[i].low  >= parsed1[i + j].low)  isL = false;
        }
        if (isH) pH1m.push(parsed1[i].high);
        if (isL) pL1m.push(parsed1[i].low);
      }
      const has1mHH = pH1m.length >= 2 && pH1m[pH1m.length - 1] > pH1m[pH1m.length - 2];
      const has1mHL = pL1m.length >= 2 && pL1m[pL1m.length - 1] > pL1m[pL1m.length - 2];
      const has1mLL = pL1m.length >= 2 && pL1m[pL1m.length - 1] < pL1m[pL1m.length - 2];
      const has1mLH = pH1m.length >= 2 && pH1m[pH1m.length - 1] < pH1m[pH1m.length - 2];

      const longOk  = (has15mHL || has15mHH) && (has1mHH || has1mHL);
      const shortOk = (has15mLH || has15mLL) && (has1mLL || has1mLH);

      if (sig.direction === 'LONG' && !longOk) {
        sig.score = -99;
        sig.blocked = `LONG blocked — need (15m HL(${has15mHL})||HH(${has15mHH})) + (1m HH(${has1mHH})||HL(${has1mHL}))`;
        continue;
      }
      if (sig.direction === 'SHORT' && !shortOk) {
        sig.score = -99;
        sig.blocked = `SHORT blocked — need (15m LH(${has15mLH})||LL(${has15mLL})) + (1m LL(${has1mLL})||LH(${has1mLH}))`;
        continue;
      }
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

  // Filter: RR minimum 1.2, SL reasonable, not blocked
  const validSignals = signals.filter(s => s.rr >= 1.2 && s.slDist > 0.0005 && s.slDist < 0.05 && s.score >= 0);

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
  best.leverage = params.LEV_BTC_ETH || 100;

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
    choch15: (() => {
      const sHs = swingTrend15.swingHighs;
      const sLs = swingTrend15.swingLows;
      if (sHs.length < 2 || sLs.length < 2) return 'unknown';
      const isHH = sHs[sHs.length - 1].price > sHs[sHs.length - 2].price;
      const isLL = sLs[sLs.length - 1].price < sLs[sLs.length - 2].price;
      if (isHH && isLL) return sHs[sHs.length-1].index > sLs[sLs.length-1].index ? 'bullish' : 'bearish';
      return isHH ? 'bullish' : isLL ? 'bearish' : 'unknown';
    })(),
    swingAligned: best.swingAligned || false,
    trendTag: best.trendTag || null,
    vwapMid:   vwapMid   ? Math.round(vwapMid   * 10000) / 10000 : null,
    vwapUpper: vwapUpper ? Math.round(vwapUpper * 10000) / 10000 : null,
    vwapLower: vwapLower ? Math.round(vwapLower * 10000) / 10000 : null,
    vwapBandPos,
    fundingRate:    marketIntel?.fundingRate  ?? null,
    oiTrend:        marketIntel?.oiTrend      ?? null,
    longShortRatio: marketIntel?.longRatio    ? `L${(marketIntel.longRatio*100).toFixed(0)}%/S${(marketIntel.shortRatio*100).toFixed(0)}%` : null,
    liqCluster:     best.liqCluster || null,
    intelDelta:     best.intelDelta || 0,
  };

  return best;
}

// ── Main Scan ──────────────────────────────────────────────

async function scanSMC(log, opts = {}) {

  const ALLOWED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];

  const tickers = await fetchTickers();
  if (!tickers.length) { bLog.error('Failed to fetch tickers'); return []; }

  const topCoins = tickers.filter(t => ALLOWED_SYMBOLS.includes(t.symbol));

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

  bLog.scan(`BTC trend=${btcTrend} | Quantum combo=${comboName} (${activeCombo}) | ${topCoins.length} coins`);

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
  detectSwings,
  SWING_LENGTHS,
  detectLiquiditySweep,
  detectMomentumScalp,
  detectSMCStructureTrade,
  detectCurvedStructure,
  calcEMAStrength,
  findKeyLevels,
  detectTrendlines,
  hasCandleConfirmation,
};
