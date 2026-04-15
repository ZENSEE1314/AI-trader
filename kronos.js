// ============================================================
// Kronos AI Prediction — Pure Node.js Technical Analysis
// Calculates EMA, RSI, MACD, Bollinger Bands, ADX, Volume
// from raw Binance kline data. No Python subprocess needed.
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const BINANCE_KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
const CANDLE_LIMIT = 200;

// Scoring thresholds
const DIRECTION_THRESHOLD = 3;
const HIGH_CONFIDENCE_THRESHOLD = 6;
const MEDIUM_CONFIDENCE_THRESHOLD = 4;
const CHANGE_PCT_MULTIPLIER = 0.3;
const MAX_CHANGE_PCT = 5;
const ADX_TRENDING_THRESHOLD = 25;
const ADX_WEAK_THRESHOLD = 15;
const ADX_TRENDING_MULTIPLIER = 1.5;
const ADX_WEAK_MULTIPLIER = 0.5;

// Cache
const predictions = new Map();
let lastScanTime = 0;
const CACHE_TTL_MS = 3 * 60_000;

// ── Indicator calculations ──────────────────────────────────

function calculateEma(closes, period) {
  const k = 2 / (period + 1);
  const ema = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calculateRsi(closes, period = 14) {
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiValues = [];
  // NOTE: First `period` values have no RSI; we start from index `period`
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - 100 / (1 + rs));
  }

  return rsiValues;
}

function calculateMacd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = calculateEma(closes, fastPeriod);
  const emaSlow = calculateEma(closes, slowPeriod);

  const macdLine = emaFast.map((val, i) => val - emaSlow[i]);
  const signalLine = calculateEma(macdLine, signalPeriod);
  const histogram = macdLine.map((val, i) => val - signalLine[i]);

  return { macdLine, signalLine, histogram };
}

function calculateBollingerBands(closes, period = 20, stdDevMultiplier = 2) {
  const bands = { upper: [], middle: [], lower: [] };

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      bands.upper.push(null);
      bands.middle.push(null);
      bands.lower.push(null);
      continue;
    }

    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((sum, v) => sum + v, 0) / period;
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    bands.middle.push(mean);
    bands.upper.push(mean + stdDevMultiplier * stdDev);
    bands.lower.push(mean - stdDevMultiplier * stdDev);
  }

  return bands;
}

function calculateTrueRange(highs, lows, closes) {
  const tr = [];
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
      continue;
    }
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  return tr;
}

function calculateAdx(highs, lows, closes, period = 14) {
  const tr = calculateTrueRange(highs, lows, closes);
  const plusDm = [];
  const minusDm = [];

  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      plusDm.push(0);
      minusDm.push(0);
      continue;
    }
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's smoothing (RMA)
  const smooth = (values, p) => {
    const result = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      if (i < p) {
        sum += values[i];
        result.push(i === p - 1 ? sum : 0);
      } else {
        result.push(result[i - 1] - result[i - 1] / p + values[i]);
      }
    }
    return result;
  };

  const smoothTr = smooth(tr, period);
  const smoothPlusDm = smooth(plusDm, period);
  const smoothMinusDm = smooth(minusDm, period);

  const plusDi = smoothPlusDm.map((val, i) => (smoothTr[i] === 0 ? 0 : (val / smoothTr[i]) * 100));
  const minusDi = smoothMinusDm.map((val, i) => (smoothTr[i] === 0 ? 0 : (val / smoothTr[i]) * 100));

  const dx = plusDi.map((val, i) => {
    const sum = val + minusDi[i];
    return sum === 0 ? 0 : (Math.abs(val - minusDi[i]) / sum) * 100;
  });

  const adx = smooth(dx, period);
  return adx;
}

function calculateVolumeScore(volumes) {
  const LOOKBACK = 10;
  if (volumes.length < LOOKBACK) return 0;

  const recent = volumes.slice(-LOOKBACK);
  const firstHalf = recent.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
  const secondHalf = recent.slice(5).reduce((s, v) => s + v, 0) / 5;

  if (secondHalf > firstHalf * 1.1) return 1;
  if (secondHalf < firstHalf * 0.9) return -1;
  return 0;
}

// ── Scoring ─────────────────────────────────────────────────

function scoreIndicators(closes, highs, lows, volumes) {
  const currentPrice = closes[closes.length - 1];

  const ema9 = calculateEma(closes, 9);
  const ema21 = calculateEma(closes, 21);
  const ema50 = calculateEma(closes, 50);

  const lastEma9 = ema9[ema9.length - 1];
  const lastEma21 = ema21[ema21.length - 1];
  const lastEma50 = ema50[ema50.length - 1];

  let emaScore = 0;
  if (currentPrice > lastEma9 && lastEma9 > lastEma21 && lastEma21 > lastEma50) {
    emaScore = 2;
  } else if (currentPrice < lastEma9 && lastEma9 < lastEma21 && lastEma21 < lastEma50) {
    emaScore = -2;
  }

  const rsiValues = calculateRsi(closes, 14);
  const rsi = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;
  let rsiScore = 0;
  if (rsi > 55) rsiScore = 1;
  else if (rsi < 45) rsiScore = -1;

  const macd = calculateMacd(closes);
  const lastMacd = macd.macdLine[macd.macdLine.length - 1];
  const lastSignal = macd.signalLine[macd.signalLine.length - 1];
  const lastHist = macd.histogram[macd.histogram.length - 1];
  const prevHist = macd.histogram[macd.histogram.length - 2];

  let macdScore = lastMacd > lastSignal ? 2 : -2;
  const histogramScore = lastHist > prevHist ? 1 : -1;
  macdScore += histogramScore;

  const bb = calculateBollingerBands(closes);
  const lastUpper = bb.upper[bb.upper.length - 1];
  const lastLower = bb.lower[bb.lower.length - 1];

  let bbScore = 0;
  if (lastUpper !== null && lastLower !== null) {
    const bbRange = lastUpper - lastLower;
    if (bbRange > 0) {
      const bbPosition = (currentPrice - lastLower) / bbRange;
      if (bbPosition < 0.2) bbScore = 1;
      else if (bbPosition > 0.8) bbScore = -1;
    }
  }

  const adxValues = calculateAdx(highs, lows, closes, 14);
  const adx = adxValues[adxValues.length - 1] || 0;

  let adxMultiplier = 1;
  if (adx > ADX_TRENDING_THRESHOLD) adxMultiplier = ADX_TRENDING_MULTIPLIER;
  else if (adx < ADX_WEAK_THRESHOLD) adxMultiplier = ADX_WEAK_MULTIPLIER;

  const volumeScore = calculateVolumeScore(volumes);

  const rawScore = emaScore + rsiScore + macdScore + bbScore + volumeScore;
  const totalScore = rawScore * adxMultiplier;

  return {
    ema_score: emaScore,
    rsi: Math.round(rsi * 100) / 100,
    rsi_score: rsiScore,
    macd_score: macdScore,
    bb_score: bbScore,
    adx: Math.round(adx * 100) / 100,
    adx_multiplier: adxMultiplier,
    volume_score: volumeScore,
    total_score: Math.round(totalScore * 100) / 100,
    bb_upper: lastUpper,
    bb_lower: lastLower,
  };
}

// ── Kline fetching ──────────────────────────────────────────

async function fetchKlines(symbol, interval) {
  const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${CANDLE_LIMIT}`;
  const res = await fetch(url, { timeout: 15000 });

  if (!res.ok) {
    throw new Error(`Binance API ${res.status}: ${await res.text()}`);
  }

  const raw = await res.json();
  return raw.map(k => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ── Single prediction ───────────────────────────────────────
// This now returns "Seeds" for the Swarm Simulation Engine
async function getMarketSeeds(symbol, interval = '15m', predLen = 20) {
  const candles = await fetchKlines(symbol, interval);

  if (candles.length < 60) {
    throw new Error(`Insufficient candle data for ${symbol}: got ${candles.length}`);
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const currentPrice = closes[closes.length - 1];
  const indicators = scoreIndicators(closes, highs, lows, volumes);

  let direction = 'NEUTRAL';
  if (indicators.total_score >= DIRECTION_THRESHOLD) direction = 'LONG';
  else if (indicators.total_score <= -DIRECTION_THRESHOLD) direction = 'SHORT';

  const absScore = Math.abs(indicators.total_score);
  let confidence = 'low';
  if (absScore >= HIGH_CONFIDENCE_THRESHOLD) confidence = 'high';
  else if (absScore >= MEDIUM_CONFIDENCE_THRESHOLD) confidence = 'medium';

  let changePct = indicators.total_score * CHANGE_PCT_MULTIPLIER;
  changePct = Math.max(-MAX_CHANGE_PCT, Math.min(MAX_CHANGE_PCT, changePct));
  changePct = Math.round(changePct * 100) / 100;

  // Use adaptive precision: more decimals for low-priced coins
  const rawPredicted = currentPrice * (1 + changePct / 100);
  const decimals = currentPrice >= 100 ? 2 : currentPrice >= 1 ? 4 : currentPrice >= 0.01 ? 6 : 8;
  const factor = Math.pow(10, decimals);
  const predictedPrice = Math.round(rawPredicted * factor) / factor;

  let trend = 'mixed';
  if (indicators.ema_score > 0 && indicators.macd_score > 0) trend = 'bullish';
  else if (indicators.ema_score < 0 && indicators.macd_score < 0) trend = 'bearish';

  const predHigh = indicators.bb_upper != null
    ? Math.round(indicators.bb_upper * factor) / factor
    : null;
  const predLow = indicators.bb_lower != null
    ? Math.round(indicators.bb_lower * factor) / factor
    : null;

  // Remove internal-only fields before returning
  const { bb_upper, bb_lower, ...publicIndicators } = indicators;

  return {
    symbol,
    direction,
    current: currentPrice,
    predicted: predictedPrice,
    change_pct: changePct,
    confidence,
    pred_high: predHigh,
    pred_low: predLow,
    trend,
    candles: predLen,
    interval,
    indicators: publicIndicators,
  };
}

// Legacy wrapper for backward compatibility
async function getKronosPrediction(symbol, interval = '15m', predLen = 20) {
  return await getMarketSeeds(symbol, interval, predLen);
}

// ── Batch scan ──────────────────────────────────────────────

async function scanAllTokens(symbols, interval = '15m', predLen = 20, concurrency = 3) {
  if (!symbols || symbols.length === 0) return predictions;

  bLog.ai(`Kronos scanning ${symbols.length} tokens (${interval}, ${predLen} candles)...`);
  const startTime = Date.now();

  predictions.clear();
  const results = [];

  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(sym => getKronosPrediction(sym, interval, predLen))
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }

  for (const pred of results) {
    if (pred && pred.symbol) {
      predictions.set(pred.symbol, pred);
    }
  }

  lastScanTime = Date.now();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const longs = results.filter(r => r.direction === 'LONG');
  const shorts = results.filter(r => r.direction === 'SHORT');
  const neutrals = results.filter(r => r.direction === 'NEUTRAL');

  bLog.ai(`Kronos scan done in ${elapsed}s: ${longs.length} LONG, ${shorts.length} SHORT, ${neutrals.length} NEUTRAL`);

  try {
    const { query } = require('./db');
    for (const pred of results) {
      if (!pred || !pred.symbol) continue;
      await query(
        `INSERT INTO kronos_predictions (symbol, direction, current_price, predicted_price, change_pct, confidence, trend, pred_high, pred_low, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (symbol) DO UPDATE SET direction=$2, current_price=$3, predicted_price=$4, change_pct=$5, confidence=$6, trend=$7, pred_high=$8, pred_low=$9, scanned_at=NOW()`,
        [pred.symbol, pred.direction, pred.current, pred.predicted, pred.change_pct, pred.confidence, pred.trend || null, pred.pred_high || null, pred.pred_low || null]
      ).catch(() => {});
    }
  } catch (_) {}

  return predictions;
}

async function verifySwarmPredictions() {
  try {
    const { query } = require('./db');
    const unverified = await query(
      `SELECT id, symbol, direction, target_price, predicted_at
       FROM swarm_predictions
       WHERE verified_at IS NULL
       AND predicted_at < NOW() - INTERVAL '30 minutes'
       LIMIT 20`
    );

    if (!unverified.length) return;

    for (const pred of unverified) {
      try {
        const candles = await fetchKlines(pred.symbol, '15m', 50);
        if (candles.length < 20) continue;

        // We want the price ~20 candles after predicted_at
        // Since we use 15m candles, 20 candles = 300 minutes = 5 hours
        // predicted_at is the start point. We look for the close price at the end of the window.
        const currentPrice = candles[candles.length - 1].close;
        const startPrice = candles[0].close;

        const movePct = ((currentPrice - startPrice) / startPrice) * 100;
        const isCorrect = pred.direction === 'LONG' ? currentPrice > startPrice : currentPrice < startPrice;

        await query(
          `UPDATE swarm_predictions SET
            verified_at = NOW(),
            is_correct = $1,
            actual_move_pct = $2
           WHERE id = $3`,
          [isCorrect, movePct, pred.id]
        );
      } catch (e) {
        console.error(`[Kronos Auditor] Failed to verify ${pred.symbol}: ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`[Kronos Auditor] Loop error: ${err.message}`);
  }
}

// ── Cache accessors ─────────────────────────────────────────
async function calculateSwarmAccuracy() {
  try {
    const { query } = require('./db');
    const rows = await query(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_correct = true THEN 1 ELSE 0 END) as correct
       FROM swarm_predictions
       WHERE verified_at IS NOT NULL
       AND predicted_at > NOW() - INTERVAL '7 days'`
    );
    const { total, correct } = rows[0];
    if (!total || total === 0) return 0;
    return Math.round((correct / total) * 100 * 10) / 10;
  } catch (err) {
    console.error(`[Kronos] Accuracy calc failed: ${err.message}`);
    return 0;
  }
}

function getCachedPrediction(symbol) {
  if (Date.now() - lastScanTime > CACHE_TTL_MS) return null;
  return predictions.get(symbol) || null;
}

function getAllPredictions() {
  if (Date.now() - lastScanTime > CACHE_TTL_MS) return [];
  return Array.from(predictions.values())
    .sort((a, b) => Math.abs(b.change_pct || 0) - Math.abs(a.change_pct || 0));
}

// ── Telegram summary ────────────────────────────────────────

async function formatPredictionSummary(coordinator) {
  const all = getAllPredictions();
  if (!all.length) return null;

  const longs = all.filter(p => p.direction === 'LONG').sort((a, b) => b.change_pct - a.change_pct);
  const shorts = all.filter(p => p.direction === 'SHORT').sort((a, b) => a.change_pct - b.change_pct);
  const neutrals = all.filter(p => p.direction === 'NEUTRAL');

  let msg = `🔮 *Kronos AI Scan* — ${all.length} tokens\n`;

  if (longs.length) {
    msg += `\n📈 *BULLISH (${longs.length})*\n`;
    for (const p of longs.slice(0, 10)) {
      const conf = p.confidence === 'high' ? '🔥' : p.confidence === 'medium' ? '⚡' : '·';
      msg += `${conf} \`${p.symbol.replace('USDT', '')}\` +${p.change_pct}% (${p.trend})\n`;
    }
    if (longs.length > 10) msg += `  _...+${longs.length - 10} more_\n`;
  }

  if (shorts.length) {
    msg += `\n📉 *BEARISH (${shorts.length})*\n`;
    for (const p of shorts.slice(0, 10)) {
      const conf = p.confidence === 'high' ? '🔥' : p.confidence === 'medium' ? '⚡' : '·';
      msg += `${conf} \`${p.symbol.replace('USDT', '')}\` ${p.change_pct}% (${p.trend})\n`;
    }
    if (shorts.length > 10) msg += `  _...+${shorts.length - 10} more_\n`;
  }

  if (neutrals.length) {
    msg += `\n➖ *NEUTRAL*: ${neutrals.map(p => p.symbol.replace('USDT', '')).join(', ')}\n`;
  }

  const topMovers = all.filter(p => p.confidence === 'high');
  if (topMovers.length) {
    msg += `\n⭐ *High Confidence*: `;
    msg += topMovers.map(p => `${p.symbol.replace('USDT', '')} ${p.direction} ${p.change_pct > 0 ? '+' : ''}${p.change_pct}%`).join(', ');
    msg += '\n';
  }

  // ── Telemetry: Agent Leaderboard & Swarm Accuracy ──
  if (coordinator) {
    const leaderboard = await coordinator.getAgentLeaderboard();
    msg += `\n🏆 *Agent Leaderboard*\n`;
    leaderboard.slice(0, 3).forEach((a, i) => {
      msg += `${i + 1}. ${a.name} (Lv.${a.level}) - ${a.earnings.toFixed(2)} USDT\n`;
    });

    // Real Swarm Accuracy tracking
    const accuracy = await calculateSwarmAccuracy();
    msg += `\n🎯 *Swarm Accuracy*: ${accuracy}%\n`;
  }

  return msg;
}

module.exports = {
  getKronosPrediction,
  scanAllTokens,
  getCachedPrediction,
  getAllPredictions,
  formatPredictionSummary,
  verifySwarmPredictions,
};
