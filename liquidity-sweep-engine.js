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

  // Look at recent 15m candles for a range candle + sweep candle
  for (let i = parsed15.length - 5; i < parsed15.length - 1; i++) {
    const rangeCandle = parsed15[i];
    const sweepCandle = parsed15[i + 1];
    if (!rangeCandle || !sweepCandle) continue;

    const rangeHigh = rangeCandle.high;
    const rangeLow = rangeCandle.low;

    // Bullish sweep: sweep candle breaks below range low then closes back inside
    const isBullishSweep = sweepCandle.low < rangeLow &&
                           sweepCandle.close > rangeLow &&
                           sweepCandle.close <= rangeHigh;

    // Bearish sweep: sweep candle breaks above range high then closes back inside
    const isBearishSweep = sweepCandle.high > rangeHigh &&
                           sweepCandle.close < rangeHigh &&
                           sweepCandle.close >= rangeLow;

    if (!isBullishSweep && !isBearishSweep) continue;

    const direction = isBullishSweep ? 'LONG' : 'SHORT';

    // Confirm on 1m: look for same pattern in recent candles
    for (let j = parsed1.length - 8; j < parsed1.length - 1; j++) {
      const range1m = parsed1[j];
      const sweep1m = parsed1[j + 1];
      if (!range1m || !sweep1m) continue;

      const h1m = range1m.high;
      const l1m = range1m.low;

      if (direction === 'LONG') {
        // 1m bullish sweep: breaks below and closes back inside
        if (sweep1m.low < l1m && sweep1m.close > l1m && sweep1m.close <= h1m) {
          return {
            direction,
            setup: 'LIQUIDITY_SWEEP',
            entryPrice: sweep1m.close,
            sl: Math.min(sweepCandle.low, sweep1m.low),
            rangeHigh,
            rangeLow,
            sweepCandle15m: i + 1,
            sweepCandle1m: j + 1,
          };
        }
      } else {
        // 1m bearish sweep: breaks above and closes back inside
        if (sweep1m.high > h1m && sweep1m.close < h1m && sweep1m.close >= l1m) {
          return {
            direction,
            setup: 'LIQUIDITY_SWEEP',
            entryPrice: sweep1m.close,
            sl: Math.max(sweepCandle.high, sweep1m.high),
            rangeHigh,
            rangeLow,
            sweepCandle15m: i + 1,
            sweepCandle1m: j + 1,
          };
        }
      }
    }
  }

  return null;
}

// ── Strategy 2: Stop-Loss Hunt ─────────────────────────────
// Price touches S/R multiple times → false break → reversal close back

function detectStopLossHunt(candles15m, candles1m, cfg = {}) {
  const minTouches = cfg.minTouches || 2;
  const proximityPct = cfg.proximityPct || 0.01;
  const lookback = cfg.lookback || 50;

  if (candles15m.length < 30 || candles1m.length < 10) return null;

  const parsed15 = candles15m.map(parseCandle);
  const parsed1 = candles1m.map(parseCandle);
  const levels = findKeyLevels(parsed15, lookback);

  // Only consider levels with enough touches
  const strongLevels = levels.filter(l => l.touches >= minTouches);
  if (!strongLevels.length) return null;

  const lastCandle15 = parsed15[parsed15.length - 1];
  const prevCandle15 = parsed15[parsed15.length - 2];

  for (const level of strongLevels) {
    const proxPct = Math.abs(lastCandle15.close - level.price) / level.price;
    if (proxPct > proximityPct) continue;

    // Bullish SL hunt: support level
    // Price drops below support then closes back above it
    if (level.type === 'support') {
      const brokeBelow = lastCandle15.low < level.price;
      const closedAbove = lastCandle15.close > level.price;

      if (brokeBelow && closedAbove) {
        // Confirm on 1m
        const last1m = parsed1[parsed1.length - 1];
        if (last1m.close > level.price) {
          return {
            direction: 'LONG',
            setup: 'STOP_LOSS_HUNT',
            entryPrice: last1m.close,
            sl: lastCandle15.low,
            level: level.price,
            levelType: level.type,
            touches: level.touches,
          };
        }
      }
    }

    // Bearish SL hunt: resistance level
    // Price spikes above resistance then closes back below it
    if (level.type === 'resistance') {
      const brokeAbove = lastCandle15.high > level.price;
      const closedBelow = lastCandle15.close < level.price;

      if (brokeAbove && closedBelow) {
        const last1m = parsed1[parsed1.length - 1];
        if (last1m.close < level.price) {
          return {
            direction: 'SHORT',
            setup: 'STOP_LOSS_HUNT',
            entryPrice: last1m.close,
            sl: lastCandle15.high,
            level: level.price,
            levelType: level.type,
            touches: level.touches,
          };
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
  const pinBarWickRatio = cfg.pinBarWickRatio || 2.0;

  if (candles15m.length < 15 || candles1m.length < 10) return null;

  const parsed15 = candles15m.map(parseCandle);
  const parsed1 = candles1m.map(parseCandle);

  const recent15 = parsed15.slice(-10);
  const greenCount = recent15.filter(isGreenCandle).length;
  const redCount = recent15.filter(isRedCandle).length;

  const isBullishTrend = greenCount >= trendStrength;
  const isBearishTrend = redCount >= trendStrength;
  if (!isBullishTrend && !isBearishTrend) return null;

  // On 1m: look for pin bar + its failure
  for (let i = parsed1.length - 6; i < parsed1.length - 1; i++) {
    const pinCandle = parsed1[i];
    const failCandle = parsed1[i + 1];
    if (!pinCandle || !failCandle) continue;

    if (isBearishTrend) {
      // In bearish trend: bullish pin bar → failure
      const lw = Math.min(pinCandle.open, pinCandle.close) - pinCandle.low;
      if (lw > bodySize(pinCandle) * pinBarWickRatio && lw > totalRange(pinCandle) * 0.5 && failCandle.close < pinCandle.low) {
        return {
          direction: 'SHORT',
          setup: 'MOMENTUM_SCALP',
          entryPrice: failCandle.close,
          sl: pinCandle.high,
          trendDirection: 'bearish',
          pinBarIndex: i,
        };
      }
    }

    if (isBullishTrend) {
      // In bullish trend: bearish pin bar → failure
      const uw = pinCandle.high - Math.max(pinCandle.open, pinCandle.close);
      if (uw > bodySize(pinCandle) * pinBarWickRatio && uw > totalRange(pinCandle) * 0.5 && failCandle.close > pinCandle.high) {
        return {
          direction: 'LONG',
          setup: 'MOMENTUM_SCALP',
          entryPrice: failCandle.close,
          sl: pinCandle.low,
          trendDirection: 'bullish',
          pinBarIndex: i,
        };
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

function isStrongBreakout(breakCandle, prevCandle, levelPrice, direction, bodyRatio = 0.8) {
  const breakBody = bodySize(breakCandle);
  const breakRange = totalRange(breakCandle);
  const prevBody = bodySize(prevCandle);

  const isLargerBody = breakBody > prevBody * bodyRatio;
  // 2. Break candle body must be > 50% of its total range (not a wick-heavy candle)
  const isFullBody = breakRange > 0 && (breakBody / breakRange) > 0.5;
  // 3. Close must be decisively past the level (> 0.1% beyond it)
  let isDecisive = false;
  if (direction === 'LONG') {
    isDecisive = (breakCandle.close - levelPrice) / levelPrice > 0.001;
  } else {
    isDecisive = (levelPrice - breakCandle.close) / levelPrice > 0.001;
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
    return closesAbove && (wickRatio > 0.3 || isGreen) && rejectionCandle.close > rejectionCandle.open;
  } else {
    // Bearish rejection: long upper wick touching the level, close well below it
    const upperWick = rejectionCandle.high - Math.max(rejectionCandle.open, rejectionCandle.close);
    const wickRatio = upperWick / range;
    const closesBelow = rejectionCandle.close < levelPrice;
    const isRed = rejectionCandle.close < rejectionCandle.open;
    return closesBelow && (wickRatio > 0.3 || isRed) && rejectionCandle.close < rejectionCandle.open;
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
            const fibCheck = isNearFibLevel(retestCandle.low, fibLevels, 0.005);
            fibConfluence = fibCheck.isNear;
            fibLevel = fibCheck.level;
          }

          // Entry on 1m confirmation
          const last1m = parsed1[parsed1.length - 1];
          if (last1m.close <= levelPrice) continue;

          const baseScore = 15;
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
            const fibCheck = isNearFibLevel(retestCandle.high, fibLevels, 0.005);
            fibConfluence = fibCheck.isNear;
            fibLevel = fibCheck.level;
          }

          // Entry on 1m
          const last1m = parsed1[parsed1.length - 1];
          if (last1m.close >= levelPrice) continue;

          const baseScore = 15;
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

// ── Daily Stats ────────────────────────────────────────────

const dailyStats = { date: '', trades: 0, consecutiveLosses: 0 };

function getTradingDay() {
  const now = new Date();
  const h = now.getHours();
  const d = new Date(now);
  if (h < 7) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
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
    return { canTrade: false, reason: `${dailyStats.consecutiveLosses} consecutive losses — stopped for today. Resets at 7am.` };
  }
  return { canTrade: true };
}

function isGoodTradingSession() {
  const utcH = new Date().getUTCHours();
  return !(utcH >= 4 && utcH <= 5);
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

async function analyzeCoin(ticker, params, enabledStrategies = null, strategyCfg = {}) {
  const symbol = ticker.symbol;
  const price = parseFloat(ticker.lastPrice);

  const [klines1h, klines15m, klines1m] = await Promise.all([
    fetchKlines(symbol, '1h', 60),
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '1m', 50),
  ]);

  if (!klines15m || !klines1m) return null;
  if (klines15m.length < 30 || klines1m.length < 10) return null;

  const parsed15 = klines15m.map(parseCandle);
  const parsed1 = klines1m.map(parseCandle);
  const atr15 = calcATR(parsed15);
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
        score: 12 + (rr > 2 ? 3 : 0),
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
        score: 13 + touchBonus,
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
        score: 11,
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

  if (!signals.length) return null;

  // Apply confluence bonuses to all signals before sorting
  for (const sig of signals) {
    // Trendline confluence: is entry near a trendline?
    if (sig.direction === 'LONG' && trendlines.uptrend) {
      const trendDist = Math.abs(sig.price - trendlines.uptrend.currentPrice) / sig.price;
      if (trendDist < 0.005) {
        sig.score += 2;
        sig.trendlineConfluence = 'uptrend_support';
      }
    }
    if (sig.direction === 'SHORT' && trendlines.downtrend) {
      const trendDist = Math.abs(sig.price - trendlines.downtrend.currentPrice) / sig.price;
      if (trendDist < 0.005) {
        sig.score += 2;
        sig.trendlineConfluence = 'downtrend_resistance';
      }
    }

    // Candlestick confirmation at nearest S/R zone
    const nearestZone = allLevels.find(z => isInZone(sig.price, z) || Math.abs(sig.price - z.price) / sig.price < 0.005);
    if (nearestZone) {
      const candleConf = hasCandleConfirmation(parsed1, nearestZone, sig.direction);
      if (candleConf.confirmed) {
        sig.score += 3;
        sig.candlePattern = candleConf.pattern;
      }
      // S/R zone strength bonus
      if (nearestZone.strength >= 4) sig.score += 2;
      else if (nearestZone.strength >= 2) sig.score += 1;
      sig.zoneStrength = nearestZone.strength;
    }
  }

  // Return highest scoring signal
  signals.sort((a, b) => b.score - a.score);
  const best = signals[0];

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
    tf15: 'sweep-engine',
    tf3: null,
    tf1: 'entry-confirmed',
    trendline: best.trendlineConfluence || null,
    candlePattern: best.candlePattern || null,
    zoneStrength: best.zoneStrength || null,
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

  if (!isGoodTradingSession()) {
    const sessionW = await aiLearner.getSessionWeight();
    if (sessionW < 1.2) {
      log('Liquidity Engine: Dead zone (UTC 4-5). Skipping.');
      bLog.scan('Dead zone hours. Waiting for volume.');
      return [];
    }
    bLog.ai(`AI override: session weight ${sessionW.toFixed(2)} > 1.2 — scanning in dead zone`);
  }

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

  bLog.scan(`Quantum combo=${comboName} (${activeCombo}) | ${topCoins.length} coins | S/R zones + trendlines + candle confirm`);

  const results = [];
  let analyzed = 0;
  let skippedAI = 0;

  for (const ticker of topCoins) {
    if (await aiLearner.shouldAvoidCoin(ticker.symbol)) {
      skippedAI++;
      continue;
    }

    const signal = await analyzeCoin(ticker, params, enabledStrategies, bestParams);
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
  detectSwings,
  SWING_LENGTHS,
  detectLiquiditySweep,
  detectStopLossHunt,
  detectMomentumScalp,
  detectBRR,
  findKeyLevels,
  detectTrendlines,
  hasCandleConfirmation,
};
