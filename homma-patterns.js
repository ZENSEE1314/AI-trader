// ============================================================
// Munehisa Homma Candlestick Techniques
// Detects classic reversal and continuation patterns from raw OHLC
// ============================================================

// ── Helpers ────────────────────────────────────────────────────

function bodySize(c) { return Math.abs(c.close - c.open); }
function rangeSize(c)  { return c.high - c.low; }
function isGreen(c)    { return c.close > c.open; }
function isRed(c)      { return c.close < c.open; }
function bodyPct(c)    { return bodySize(c) / rangeSize(c); } // 0 = doji, 1 = marubozu
function upperWick(c)  { return c.high - Math.max(c.open, c.close); }
function lowerWick(c)  { return Math.min(c.open, c.close) - c.low; }
function wickRatio(c)  {
  const body = bodySize(c);
  return body <= 0 ? 99 : (rangeSize(c) - body) / body;
}

// ── Single-Candle Patterns ───────────────────────────────────

function detectHammer(c) {
  // Small body at top, long lower wick (≥2× body), little/no upper wick
  if (rangeSize(c) <= 0) return false;
  const body = bodySize(c);
  const lw = lowerWick(c);
  const uw = upperWick(c);
  if (body <= 0) return false;
  return lw >= body * 2 && uw <= body * 0.5 && isGreen(c);
}

function detectShootingStar(c) {
  // Small body at bottom, long upper wick (≥2× body), little/no lower wick
  if (rangeSize(c) <= 0) return false;
  const body = bodySize(c);
  const uw = upperWick(c);
  const lw = lowerWick(c);
  if (body <= 0) return false;
  return uw >= body * 2 && lw <= body * 0.5 && isRed(c);
}

function detectDoji(c, threshold = 0.05) {
  // Open ≈ Close (body < 5% of range)
  return bodyPct(c) < threshold;
}

function detectMarubozu(c) {
  // No wicks (body = range)
  return bodyPct(c) > 0.95;
}

function detectSpinningTop(c) {
  // Small body, long wicks both sides (indecision)
  const body = bodySize(c);
  const range = rangeSize(c);
  if (range <= 0) return false;
  return body / range < 0.3 && upperWick(c) > body && lowerWick(c) > body;
}

// ── Two-Candle Patterns ──────────────────────────────────────

function detectBullishEngulfing(prev, curr) {
  // Prev red, curr green, curr body fully engulfs prev body
  if (!isRed(prev) || !isGreen(curr)) return false;
  return curr.open < prev.close && curr.close > prev.open;
}

function detectBearishEngulfing(prev, curr) {
  // Prev green, curr red, curr body fully engulfs prev body
  if (!isGreen(prev) || !isRed(curr)) return false;
  return curr.open > prev.close && curr.close < prev.open;
}

function detectTweezerTop(prev, curr) {
  // Two candles with same high, first green, second red
  const highMatch = Math.abs(prev.high - curr.high) / prev.high < 0.001;
  return isGreen(prev) && isRed(curr) && highMatch;
}

function detectTweezerBottom(prev, curr) {
  // Two candles with same low, first red, second green
  const lowMatch = Math.abs(prev.low - curr.low) / prev.low < 0.001;
  return isRed(prev) && isGreen(curr) && lowMatch;
}

// ── Three-Candle Patterns ────────────────────────────────────

function detectMorningStar(c1, c2, c3) {
  // Strong red, small indecision, strong green that closes > 50% into c1 body
  if (!isRed(c1) || !isGreen(c3)) return false;
  const midC1 = (c1.open + c1.close) / 2;
  return bodySize(c2) < bodySize(c1) * 0.5 && c3.close > midC1;
}

function detectEveningStar(c1, c2, c3) {
  // Strong green, small indecision, strong red that closes < 50% into c1 body
  if (!isGreen(c1) || !isRed(c3)) return false;
  const midC1 = (c1.open + c1.close) / 2;
  return bodySize(c2) < bodySize(c1) * 0.5 && c3.close < midC1;
}

function detectThreeWhiteSoldiers(c1, c2, c3) {
  // Three green candles, each open inside prior body, each close higher
  return isGreen(c1) && isGreen(c2) && isGreen(c3) &&
         c2.open > c1.open && c2.open < c1.close &&
         c3.open > c2.open && c3.open < c2.close &&
         c2.close > c1.close && c3.close > c2.close;
}

function detectThreeBlackCrows(c1, c2, c3) {
  // Three red candles, each open inside prior body, each close lower
  return isRed(c1) && isRed(c2) && isRed(c3) &&
         c2.open < c1.open && c2.open > c1.close &&
         c3.open < c2.open && c3.open > c2.close &&
         c2.close < c1.close && c3.close < c2.close;
}

// ── Volume-Confirmed EQ (Effort vs Result) ────────────────────

function checkVolumeConfirmation(candles, idx, minRatio = 1.3) {
  // Reversal candle should have above-average volume
  const c = candles[idx];
  const prev = candles.slice(Math.max(0, idx - 10), idx);
  if (!prev.length) return false;
  const avgVol = prev.reduce((s, x) => s + (x.volume || 0), 0) / prev.length;
  return avgVol > 0 && (c.volume || 0) >= avgVol * minRatio;
}

// ── Master Scanner ─────────────────────────────────────────────

function scanHommaPatterns(candles) {
  const results = [];
  for (let i = 2; i < candles.length; i++) {
    const c  = candles[i];
    const p1 = candles[i - 1];
    const p2 = candles[i - 2];

    const patterns = [];

    // Single candle
    if (detectHammer(c))        patterns.push({ name: 'HAMMER',        bias: 'BULLISH', strength: 1 });
    if (detectShootingStar(c))  patterns.push({ name: 'SHOOTING_STAR', bias: 'BEARISH', strength: 1 });
    if (detectDoji(c))          patterns.push({ name: 'DOJI',          bias: 'NEUTRAL', strength: 0 });
    if (detectMarubozu(c))      patterns.push({ name: 'MARUBOZU',      bias: isGreen(c) ? 'BULLISH' : 'BEARISH', strength: 1 });
    if (detectSpinningTop(c))   patterns.push({ name: 'SPINNING_TOP',  bias: 'NEUTRAL', strength: 0 });

    // Two candle
    if (detectBullishEngulfing(p1, c)) patterns.push({ name: 'BULLISH_ENGULFING', bias: 'BULLISH', strength: 2 });
    if (detectBearishEngulfing(p1, c)) patterns.push({ name: 'BEARISH_ENGULFING', bias: 'BEARISH', strength: 2 });
    if (detectTweezerTop(p1, c))       patterns.push({ name: 'TWEEZER_TOP',       bias: 'BEARISH', strength: 2 });
    if (detectTweezerBottom(p1, c))      patterns.push({ name: 'TWEEZER_BOTTOM',    bias: 'BULLISH', strength: 2 });

    // Three candle
    if (detectMorningStar(p2, p1, c))     patterns.push({ name: 'MORNING_STAR',      bias: 'BULLISH', strength: 3 });
    if (detectEveningStar(p2, p1, c))     patterns.push({ name: 'EVENING_STAR',      bias: 'BEARISH', strength: 3 });
    if (detectThreeWhiteSoldiers(p2, p1, c)) patterns.push({ name: 'THREE_WHITE_SOLDIERS', bias: 'BULLISH', strength: 3 });
    if (detectThreeBlackCrows(p2, p1, c))    patterns.push({ name: 'THREE_BLACK_CROWS',    bias: 'BEARISH', strength: 3 });

    // Volume confirmation boost
    if (patterns.length && checkVolumeConfirmation(candles, i, 1.2)) {
      for (const p of patterns) p.strength += 1;
    }

    if (patterns.length) {
      results.push({ index: i, candle: c, patterns });
    }
  }
  return results;
}

// ── Aggregate Signal ─────────────────────────────────────────

function getHommaSignal(candles, lookback = 5) {
  const recent = candles.slice(-lookback);
  const scan = scanHommaPatterns(recent);
  if (!scan.length) return { bias: 'NEUTRAL', score: 0, patterns: [] };

  const last = scan[scan.length - 1];
  const bullish = last.patterns.filter(p => p.bias === 'BULLISH');
  const bearish = last.patterns.filter(p => p.bias === 'BEARISH');

  const bullScore = bullish.reduce((s, p) => s + p.strength, 0);
  const bearScore = bearish.reduce((s, p) => s + p.strength, 0);

  if (bullScore > bearScore + 1) return { bias: 'BULLISH', score: bullScore, patterns: last.patterns.map(p=>p.name) };
  if (bearScore > bullScore + 1) return { bias: 'BEARISH', score: bearScore, patterns: last.patterns.map(p=>p.name) };
  return { bias: 'NEUTRAL', score: Math.max(bullScore, bearScore), patterns: last.patterns.map(p=>p.name) };
}

// ── Export ───────────────────────────────────────────────────
module.exports = {
  scanHommaPatterns,
  getHommaSignal,
  // Individual detectors for custom logic
  detectHammer,
  detectShootingStar,
  detectDoji,
  detectBullishEngulfing,
  detectBearishEngulfing,
  detectMorningStar,
  detectEveningStar,
  detectThreeWhiteSoldiers,
  detectThreeBlackCrows,
  checkVolumeConfirmation,
};
