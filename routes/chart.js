// ============================================================
// SMC Chart API — serves kline data + computed SMC indicators
// for the interactive chart page
// ============================================================

const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();

const REQUEST_TIMEOUT = 12000;
const CACHE_TTL = 60000; // 1 min cache
const cache = new Map();

async function fetchKlines(symbol, interval, limit = 200) {
  const key = `${symbol}_${interval}_${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
  if (!res.ok) return null;
  const data = await res.json();
  cache.set(key, { data, ts: Date.now() });
  return data;
}

// ── Zeiierman SMC Swing Detection ───────────────────────────
// Zeiierman SMC settings: Swing Points Length = 20, Structure Period = 10
const SWING_LENGTHS = { '1w': 10, '1d': 10, '4h': 10, '1h': 10, '15m': 20, '3m': 20, '1m': 20 };
const STRUCTURE_PERIOD = 10;

function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const swings = [];
  let lastType = null;

  // NOTE: Use adaptive right-side lookback near the end so recent candles
  // can still produce swing labels instead of leaving a gap.
  const MIN_RIGHT = 2;

  for (let i = len; i < klines.length - MIN_RIGHT; i++) {
    const rightLen = Math.min(len, klines.length - 1 - i);
    let isHigh = true;
    for (let j = -len; j <= rightLen; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) { isHigh = false; break; }
    }
    let isLow = true;
    for (let j = -len; j <= rightLen; j++) {
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
        if (highs[i] > prev.price) {
          swings[swings.length - 1] = { type: 'high', index: i, price: highs[i], time: parseInt(klines[i][0]) / 1000 };
        }
      } else {
        swings.push({ type: 'high', index: i, price: highs[i], time: parseInt(klines[i][0]) / 1000 });
        lastType = 'high';
      }
    }
    if (isLow) {
      if (lastType === 'low') {
        const prev = swings[swings.length - 1];
        if (lows[i] < prev.price) {
          swings[swings.length - 1] = { type: 'low', index: i, price: lows[i], time: parseInt(klines[i][0]) / 1000 };
        }
      } else {
        swings.push({ type: 'low', index: i, price: lows[i], time: parseInt(klines[i][0]) / 1000 });
        lastType = 'low';
      }
    }
  }
  return swings;
}

function getStructureLabels(swings) {
  const labels = [];
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');

  for (let i = 1; i < swingHighs.length; i++) {
    const label = swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH';
    labels.push({ ...swingHighs[i], label });
  }
  for (let i = 1; i < swingLows.length; i++) {
    const label = swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL';
    labels.push({ ...swingLows[i], label });
  }
  labels.sort((a, b) => a.time - b.time);
  return labels;
}

// ── Order Blocks ────────────────────────────────────────────
function detectOrderBlocks(klines) {
  const obs = [];
  for (let i = 2; i < klines.length; i++) {
    const prev = klines[i - 1];
    const cur = klines[i];
    const prevOpen = parseFloat(prev[1]);
    const prevClose = parseFloat(prev[4]);
    const prevHigh = parseFloat(prev[2]);
    const prevLow = parseFloat(prev[3]);
    const curOpen = parseFloat(cur[1]);
    const curClose = parseFloat(cur[4]);

    // Bullish OB: bearish candle followed by strong bullish candle breaking above
    if (prevClose < prevOpen && curClose > curOpen && curClose > prevHigh) {
      obs.push({
        type: 'bullish',
        time: parseInt(prev[0]) / 1000,
        high: prevOpen,
        low: prevLow,
        endTime: parseInt(cur[0]) / 1000,
      });
    }
    // Bearish OB: bullish candle followed by strong bearish candle breaking below
    if (prevClose > prevOpen && curClose < curOpen && curClose < prevLow) {
      obs.push({
        type: 'bearish',
        time: parseInt(prev[0]) / 1000,
        high: prevHigh,
        low: prevClose,
        endTime: parseInt(cur[0]) / 1000,
      });
    }
  }
  return obs.slice(-15); // last 15 OBs
}

// ── Fair Value Gaps (FVG) ───────────────────────────────────
function detectFVGs(klines) {
  const fvgs = [];
  for (let i = 2; i < klines.length; i++) {
    const c1High = parseFloat(klines[i - 2][2]);
    const c1Low = parseFloat(klines[i - 2][3]);
    const c3High = parseFloat(klines[i][2]);
    const c3Low = parseFloat(klines[i][3]);

    // Bullish FVG: candle 1 high < candle 3 low (gap up)
    if (c1High < c3Low) {
      fvgs.push({
        type: 'bullish',
        time: parseInt(klines[i - 1][0]) / 1000,
        high: c3Low,
        low: c1High,
      });
    }
    // Bearish FVG: candle 1 low > candle 3 high (gap down)
    if (c1Low > c3High) {
      fvgs.push({
        type: 'bearish',
        time: parseInt(klines[i - 1][0]) / 1000,
        high: c1Low,
        low: c3High,
      });
    }
  }
  return fvgs.slice(-15);
}

// ── Key Levels (PDH, PDL, OP, PWH, PWL) ─────────────────────
function getKeyLevels(dailyKlines, weeklyKlines) {
  const levels = {};
  if (dailyKlines && dailyKlines.length >= 2) {
    const prevDay = dailyKlines[dailyKlines.length - 2];
    levels.PDH = parseFloat(prevDay[2]);
    levels.PDL = parseFloat(prevDay[3]);
    const today = dailyKlines[dailyKlines.length - 1];
    levels.OP = parseFloat(today[1]);
  }
  if (weeklyKlines && weeklyKlines.length >= 2) {
    const prevWeek = weeklyKlines[weeklyKlines.length - 2];
    levels.PWH = parseFloat(prevWeek[2]);
    levels.PWL = parseFloat(prevWeek[3]);
  }
  return levels;
}

// ── EMA Calculation ─────────────────────────────────────────
function calcEMA(closes, period) {
  const ema = [];
  const k = 2 / (period + 1);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { ema.push(null); continue; }
    if (i === period - 1) { ema.push(prev); continue; }
    prev = closes[i] * k + prev * (1 - k);
    ema.push(prev);
  }
  return ema;
}

// ── VWAP with Upper/Lower Bands ─────────────────────────────
// Returns { vwap, upper, lower } — bands use rolling std deviation * multiplier
const VWAP_BAND_MULT = 2.0;

function calcVWAPBands(klines) {
  let cumVol = 0, cumTP = 0, cumTP2 = 0;
  const vwap = [], upper = [], lower = [];
  let currentDay = null;

  for (const k of klines) {
    const day = new Date(parseInt(k[0])).toISOString().slice(0, 10);
    if (day !== currentDay) {
      cumVol = 0;
      cumTP = 0;
      cumTP2 = 0;
      currentDay = day;
    }
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const vol = parseFloat(k[5]);
    const tp = (high + low + close) / 3;

    cumTP += tp * vol;
    cumTP2 += tp * tp * vol;
    cumVol += vol;

    if (cumVol > 0) {
      const v = cumTP / cumVol;
      const variance = Math.max(0, cumTP2 / cumVol - v * v);
      const stdDev = Math.sqrt(variance);
      vwap.push(v);
      upper.push(v + stdDev * VWAP_BAND_MULT);
      lower.push(v - stdDev * VWAP_BAND_MULT);
    } else {
      vwap.push(close);
      upper.push(close);
      lower.push(close);
    }
  }
  return { vwap, upper, lower };
}

// ── Curved Structure Bands (Zeiierman) ──────────────────────
// ATR-based adaptive upper/lower bands that curve toward price
const CURVED_TREND_LENGTH = 100;
const CURVED_MULTIPLIER = 3.0;

function calcCurvedBands(klines) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));

  // ATR calculation
  const trueRanges = [];
  for (let i = 0; i < klines.length; i++) {
    if (i === 0) {
      trueRanges.push(highs[i] - lows[i]);
    } else {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trueRanges.push(tr);
    }
  }

  // Simple moving average of TR for adaptive size
  const atrLen = Math.min(CURVED_TREND_LENGTH, klines.length);
  const lengthSquared = CURVED_TREND_LENGTH * CURVED_TREND_LENGTH;

  let upperBand = closes[0];
  let lowerBand = closes[0];
  let barsSinceUpperIncrease = 0;
  let barsSinceLowerDecrease = 0;

  const upperArr = [];
  const lowerArr = [];

  for (let i = 0; i < klines.length; i++) {
    // Rolling ATR (simple average of last atrLen true ranges)
    const start = Math.max(0, i - atrLen + 1);
    let atrSum = 0;
    for (let j = start; j <= i; j++) atrSum += trueRanges[j];
    const adaptiveSize = atrSum / (i - start + 1);

    // Upper band
    const maxCloseUpper = Math.max(highs[i], upperBand);
    barsSinceUpperIncrease = closes[i] > upperBand ? 0 : barsSinceUpperIncrease + 1;
    const upperAdj = (adaptiveSize / lengthSquared) * (barsSinceUpperIncrease + 1) * CURVED_MULTIPLIER;
    upperBand = maxCloseUpper - upperAdj;

    // Lower band
    const minCloseLower = Math.min(lows[i], lowerBand);
    barsSinceLowerDecrease = closes[i] < lowerBand ? 0 : barsSinceLowerDecrease + 1;
    const lowerAdj = (adaptiveSize / lengthSquared) * (barsSinceLowerDecrease + 1) * CURVED_MULTIPLIER;
    lowerBand = minCloseLower + lowerAdj;

    upperArr.push(upperBand);
    lowerArr.push(lowerBand);
  }

  return { upper: upperArr, lower: lowerArr };
}

// ── Daily Levels: Opening Price, Previous Day High/Low ─────
function calcDailyLevels(klines) {
  const dayMap = new Map();
  for (const k of klines) {
    const day = new Date(parseInt(k[0])).toISOString().slice(0, 10);
    if (!dayMap.has(day)) {
      dayMap.set(day, { open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]) });
    } else {
      const d = dayMap.get(day);
      d.high = Math.max(d.high, parseFloat(k[2]));
      d.low = Math.min(d.low, parseFloat(k[3]));
    }
  }

  const days = [...dayMap.keys()].sort();
  const today = days[days.length - 1];
  const yesterday = days.length >= 2 ? days[days.length - 2] : null;

  return {
    openingPrice: dayMap.get(today)?.open || null,
    pdh: yesterday ? dayMap.get(yesterday).high : null,
    pdl: yesterday ? dayMap.get(yesterday).low : null,
  };
}

// ── CHoCH / SMS / BMS Detection (Zeiierman 3-level) ────────
// CHoCH = Change of Character: first break AGAINST the trend
// SMS   = Structure Market Shift: second break same direction (confirms shift)
// BMS   = Break of Market Structure: third+ break WITH the trend (continuation)
function detectCHoCHBMS(swings, klines) {
  const results = [];
  if (swings.length < 3) return results;

  let currentTrend = null; // 'bullish' or 'bearish'
  let bullBreakCount = 0;  // consecutive bullish breaks
  let bearBreakCount = 0;  // consecutive bearish breaks

  for (let i = 1; i < swings.length; i++) {
    const prev = swings[i - 1];
    const curr = swings[i];

    if (prev.type === 'high') {
      for (let k = curr.index + 1; k < klines.length; k++) {
        const high = parseFloat(klines[k][2]);
        if (high > prev.price) {
          const breakTime = parseInt(klines[k][0]) / 1000;
          let label;
          if (currentTrend !== 'bullish') {
            label = 'CHoCH';
            bullBreakCount = 1;
            bearBreakCount = 0;
          } else {
            bullBreakCount++;
            label = bullBreakCount === 2 ? 'SMS' : 'BMS';
          }
          results.push({ type: label, direction: 'bullish', price: prev.price, time: prev.time, breakTime });
          currentTrend = 'bullish';
          break;
        }
        if (i + 1 < swings.length && k >= swings[i + 1].index) break;
      }
    }

    if (prev.type === 'low') {
      for (let k = curr.index + 1; k < klines.length; k++) {
        const low = parseFloat(klines[k][3]);
        if (low < prev.price) {
          const breakTime = parseInt(klines[k][0]) / 1000;
          let label;
          if (currentTrend !== 'bearish') {
            label = 'CHoCH';
            bearBreakCount = 1;
            bullBreakCount = 0;
          } else {
            bearBreakCount++;
            label = bearBreakCount === 2 ? 'SMS' : 'BMS';
          }
          results.push({ type: label, direction: 'bearish', price: prev.price, time: prev.time, breakTime });
          currentTrend = 'bearish';
          break;
        }
        if (i + 1 < swings.length && k >= swings[i + 1].index) break;
      }
    }
  }
  return results;
}

// ── Strong/Weak High-Low Classification ─────────────────────
// Strong High = swing high NOT yet broken by subsequent price action
// Weak Low = swing low NOT yet broken → expected to be taken (liquidity)
function classifyStrongWeak(swings, klines) {
  const classifications = [];
  const lastClose = parseFloat(klines[klines.length - 1][4]);

  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  for (const sh of highs) {
    let broken = false;
    for (let k = sh.index + 1; k < klines.length; k++) {
      if (parseFloat(klines[k][2]) > sh.price) { broken = true; break; }
    }
    classifications.push({
      type: 'high',
      label: broken ? 'Weak High' : 'Strong High',
      price: sh.price,
      time: sh.time,
      isBroken: broken,
    });
  }

  for (const sl of lows) {
    let broken = false;
    for (let k = sl.index + 1; k < klines.length; k++) {
      if (parseFloat(klines[k][3]) < sl.price) { broken = true; break; }
    }
    classifications.push({
      type: 'low',
      label: broken ? 'Weak Low' : 'Strong Low',
      price: sl.price,
      time: sl.time,
      isBroken: broken,
    });
  }

  return classifications;
}

// ── Premium / Discount Zone ─────────────────────────────────
// Premium = above 50% of range (sell zone), Discount = below 50% (buy zone)
function calcPremiumDiscount(swings, candles) {
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  if (!highs.length || !lows.length) return null;

  // Use the most recent significant high and low
  const upperRange = Math.max(...highs.slice(-3).map(h => h.price));
  const lowerRange = Math.min(...lows.slice(-3).map(l => l.price));
  const mid = (upperRange + lowerRange) / 2;

  return { upperRange, lowerRange, mid };
}

// ── Equal Highs / Equal Lows Detection ──────────────────────
function detectEQHEQL(swings) {
  const tolerance = 0.001; // 0.1% tolerance
  const eqs = [];
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const diff = Math.abs(highs[i].price - highs[j].price) / highs[i].price;
      if (diff < tolerance) {
        eqs.push({ type: 'EQH', price: (highs[i].price + highs[j].price) / 2, time: highs[j].time, time1: highs[i].time });
      }
    }
  }
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const diff = Math.abs(lows[i].price - lows[j].price) / lows[i].price;
      if (diff < tolerance) {
        eqs.push({ type: 'EQL', price: (lows[i].price + lows[j].price) / 2, time: lows[j].time, time1: lows[i].time });
      }
    }
  }
  return eqs;
}

// ── Main Chart Data Endpoint ────────────────────────────────
router.get('/data', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '15m';
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const swingLen = SWING_LENGTHS[interval] || 8;

    // Fetch main klines + daily/weekly for key levels
    const [klines, dailyKlines, weeklyKlines] = await Promise.all([
      fetchKlines(symbol, interval, limit),
      fetchKlines(symbol, '1d', 7),
      fetchKlines(symbol, '1w', 4),
    ]);

    if (!klines || !klines.length) {
      return res.status(404).json({ error: 'No data for symbol' });
    }

    // Candlestick data
    const candles = klines.map(k => ({
      time: parseInt(k[0]) / 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    const closes = klines.map(k => parseFloat(k[4]));

    // SMC indicators — wrapped so a crash in any indicator doesn't break candles
    let swings = [], labels = [], orderBlocks = [], fvgs = [], keyLevels = {};
    let eqhEql = [], chochBms = [], strongWeak = [], premiumDiscount = {};
    let trend = 'Neutral', dailyLevels = {};
    let ema7 = [], ema22 = [], ema200 = [];
    let vwapBands = { vwap: [], upper: [], lower: [] };
    let curvedBands = { upper: [], lower: [] };

    try {
      swings = detectSwings(klines, swingLen);
      labels = getStructureLabels(swings);
      orderBlocks = detectOrderBlocks(klines);
      fvgs = detectFVGs(klines);
      keyLevels = getKeyLevels(dailyKlines, weeklyKlines);
      eqhEql = detectEQHEQL(swings);
      chochBms = detectCHoCHBMS(swings, klines);
      strongWeak = classifyStrongWeak(swings, klines);
      premiumDiscount = calcPremiumDiscount(swings, candles);

      const highLabels = labels.filter(l => l.type === 'high');
      const lowLabels = labels.filter(l => l.type === 'low');
      const lastHighLabel = highLabels[highLabels.length - 1];
      const lastLowLabel = lowLabels[lowLabels.length - 1];
      trend = (lastHighLabel?.label === 'HH' && lastLowLabel?.label === 'HL') ? 'Positive'
        : (lastHighLabel?.label === 'LH' && lastLowLabel?.label === 'LL') ? 'Negative' : 'Neutral';

      ema7 = calcEMA(closes, 7);
      ema22 = calcEMA(closes, 22);
      ema200 = calcEMA(closes, 200);
      vwapBands = calcVWAPBands(klines);
      curvedBands = calcCurvedBands(klines);
      dailyLevels = calcDailyLevels(klines);
    } catch (indErr) {
      console.error('Indicator calc error (candles still sent):', indErr.message);
    }

    const emaData = (arr) => candles.map((c, i) => arr[i] !== null ? { time: c.time, value: arr[i] } : null).filter(Boolean);

    res.json({
      symbol,
      interval,
      candles,
      swings,
      labels,
      orderBlocks,
      fvgs,
      keyLevels,
      eqhEql,
      chochBms,
      strongWeak,
      premiumDiscount,
      trend,
      dailyLevels,
      ema7: emaData(ema7),
      ema22: emaData(ema22),
      ema200: emaData(ema200),
      vwap: emaData(vwapBands.vwap),
      vwapUpper: emaData(vwapBands.upper),
      vwapLower: emaData(vwapBands.lower),
      curvedUpper: emaData(curvedBands.upper),
      curvedLower: emaData(curvedBands.lower),
    });
  } catch (err) {
    console.error('Chart data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-TF Structure Summary (for coin list) ──────────────
router.get('/scan', async (req, res) => {
  try {
    const nFetch = require('node-fetch');

    // Fetch tickers from both Binance and Bitunix in parallel
    const [binanceRes, bitunixRes] = await Promise.all([
      nFetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 12000 })
        .then(r => r.json()).catch(() => []),
      nFetch('https://fapi.bitunix.com/api/v1/futures/market/tickers', { timeout: 12000 })
        .then(r => r.json()).then(j => j.data || []).catch(() => []),
    ]);

    // Normalize Binance tickers
    const binanceCoins = (Array.isArray(binanceRes) ? binanceRes : [])
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
        exchange: 'binance',
      }));

    // Normalize Bitunix tickers — only add tokens not already on Binance
    const binanceSymbols = new Set(binanceCoins.map(c => c.symbol));
    const bitunixCoins = bitunixRes
      .filter(t => t.symbol.endsWith('USDT') && !binanceSymbols.has(t.symbol))
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice || t.last),
        change24h: parseFloat(t.open) > 0
          ? ((parseFloat(t.last) - parseFloat(t.open)) / parseFloat(t.open) * 100)
          : 0,
        volume24h: parseFloat(t.quoteVol || 0),
        exchange: 'bitunix',
      }));

    // Merge, sort by volume, take top 50
    const allCoins = [...binanceCoins, ...bitunixCoins]
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 100);

    // Analyze structure for top 30 coins (limit API calls to avoid rate limits)
    const analyzed = [];
    for (const coin of allCoins.slice(0, 30)) {
      try {
        const klines = await fetchKlines(coin.symbol, '15m', 100);
        if (!klines || klines.length < 50) {
          analyzed.push({ ...coin, structure: '--/--', trend: 'neutral' });
          continue;
        }
        // Use shorter swing length (10) for scan overview — full 20 needs more data
        const swings = detectSwings(klines, 10);
        const structLabels = getStructureLabels(swings);

        const lastHigh = structLabels.filter(l => l.type === 'high').pop();
        const lastLow = structLabels.filter(l => l.type === 'low').pop();

        analyzed.push({
          ...coin,
          structure: `${lastHigh?.label || '--'}/${lastLow?.label || '--'}`,
          trend: lastHigh?.label === 'HH' && lastLow?.label === 'HL' ? 'bullish'
            : lastHigh?.label === 'LH' && lastLow?.label === 'LL' ? 'bearish' : 'neutral',
        });
      } catch (_) {
        analyzed.push({ ...coin, structure: '--/--', trend: 'neutral' });
      }
    }

    // Add remaining coins without structure analysis
    const remaining = allCoins.slice(30).map(c => ({ ...c, structure: '--/--', trend: 'neutral' }));

    res.json([...analyzed, ...remaining]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
