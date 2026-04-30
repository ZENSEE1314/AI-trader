// ═══════════════════════════════════════════════════════════════
//  STRATEGY v2  —  Clean-sheet. Old rules (mct-strategy.js) are
//  UNTOUCHED and still live.  This file is completely independent.
// ═══════════════════════════════════════════════════════════════
//
//  STEP 1  ─  15m or 3m chart: swing point detection
//    Swing HIGH forms (HH or LH)  →  SHORT bias
//    Swing LOW  forms (HL or LL)  →  LONG  bias
//    Do NOT enter yet — wait for Step 2.
//
//  STEP 2  ─  Drop to 1m chart for entry confirmation
//    LONG  : HL or LL forms on 1m  →  enter on NEXT candle
//    SHORT : HH or LH forms on 1m  →  enter on NEXT candle
//
//  VWAP BAND FILTER
//    Price ≥ upper band (VWAP + 1σ)  →  LONG only
//      (only HL or LL on 15m/3m accepted; HH/LH rejected)
//    Price ≤ lower band (VWAP − 1σ)  →  SHORT only
//      (only HH or LH on 15m/3m accepted; HL/LL rejected)
//
//  STOP LOSS & TRAILING
//    Initial SL  = 30 % of position value
//    Trailing activates at first +31 % profit
//    After activation: SL = floor(profit% ÷ 10%) × 10%  (ratchets, never moves back)
//
//    Example — $100 position:
//      Profit $31  →  SL locked at $30  (30 %)
//      Profit $40  →  SL locked at $40  (40 %)
//      Profit $50  →  SL locked at $50  (50 %)
//      …every +$10 thereafter
//
// ═══════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

const REQUEST_TIMEOUT = 15_000;

// ── Fetch helpers ─────────────────────────────────────────────

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
  const url =
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;
  return res.json();
}

async function fetchTickers() {
  const res = await fetchWithRetry('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (!res) return [];
  return res.json();
}

// ── VWAP + standard-deviation bands ──────────────────────────
//   Computed from the supplied klines (use intraday 15m slice for session VWAP).
//   Returns { vwap, upper1, lower1, upper2, lower2, stdDev } or null.

function calcVWAPBands(klines) {
  let cumTPV  = 0;
  let cumTPV2 = 0;
  let cumVol  = 0;

  for (const k of klines) {
    const hi  = parseFloat(k[2]);
    const lo  = parseFloat(k[3]);
    const cl  = parseFloat(k[4]);
    const vol = parseFloat(k[5]);
    const tp  = (hi + lo + cl) / 3;
    cumTPV  += tp * vol;
    cumTPV2 += tp * tp * vol;
    cumVol  += vol;
  }

  if (cumVol === 0) return null;

  const vwap   = cumTPV / cumVol;
  const stdDev = Math.sqrt(Math.max(0, cumTPV2 / cumVol - vwap * vwap));

  return {
    vwap,
    upper1: vwap + stdDev,
    lower1: vwap - stdDev,
    upper2: vwap + 2 * stdDev,
    lower2: vwap - 2 * stdDev,
    stdDev,
  };
}

// ── Swing-point detection ─────────────────────────────────────
//   A pivot HIGH at index i requires:
//     highs[i] > highs[i±j] for j = 1..lookback
//   Same rule inverted for pivot LOWs.
//   Last `lookback` bars are excluded — they are not yet confirmed.

function findSwings(klines, lookback = 2) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows  = klines.map(k => parseFloat(k[3]));
  const n     = klines.length;

  const swingHighs = [];
  const swingLows  = [];

  for (let i = lookback; i < n - lookback; i++) {
    let isH = true;
    let isL = true;
    for (let j = 1; j <= lookback; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isH = false;
      if (lows[i]  >= lows[i - j]  || lows[i]  >= lows[i + j])  isL = false;
    }
    if (isH) swingHighs.push({ idx: i, val: highs[i] });
    if (isL) swingLows.push({ idx: i, val: lows[i] });
  }

  return { swingHighs, swingLows };
}

// ── Classify the most-recent confirmed swing ──────────────────
//   Returns:
//   {
//     type:    'HH' | 'LH' | 'HL' | 'LL',
//     val:      number,
//     idx:      number,
//     bias:    'long' | 'short',
//     barsAgo:  number  (bars since pivot was CONFIRMED)
//   }
//   or null if not enough history.

function classifyLastSwing(klines, lookback = 2) {
  const n = klines.length;
  const { swingHighs, swingLows } = findSwings(klines, lookback);

  if (swingHighs.length === 0 && swingLows.length === 0) return null;

  const lastH = swingHighs[swingHighs.length - 1] || null;
  const lastL = swingLows[swingLows.length  - 1] || null;

  let last;
  let isHigh;

  if      (!lastH)             { last = lastL; isHigh = false; }
  else if (!lastL)             { last = lastH; isHigh = true;  }
  else if (lastH.idx >= lastL.idx) { last = lastH; isHigh = true;  }
  else                         { last = lastL; isHigh = false; }

  let type;
  if (isHigh) {
    const prev = swingHighs[swingHighs.length - 2] || null;
    type = (prev && last.val > prev.val) ? 'HH' : 'LH';
  } else {
    const prev = swingLows[swingLows.length - 2] || null;
    type = (prev && last.val > prev.val) ? 'HL' : 'LL';
  }

  return {
    type,
    val:     last.val,
    idx:     last.idx,
    bias:    isHigh ? 'short' : 'long',
    barsAgo: (n - 1) - last.idx,
  };
}

// ── VWAP zone classifier ──────────────────────────────────────
//   'upper' = at or above VWAP upper band  →  long zone
//   'lower' = at or below VWAP lower band  →  short zone
//   'middle' = between the bands

function vwapZone(price, bands) {
  if (!bands)                    return 'middle';
  if (price >= bands.upper1)     return 'upper';
  if (price <= bands.lower1)     return 'lower';
  return 'middle';
}

// ── Trailing stop-loss price ──────────────────────────────────
//   All percentages are CAPITAL % (P&L as % of margin = price% × leverage).
//   This matches the user's example: "$100 margin, make $31 → SL to $30".
//
//   Initial SL:    30% capital loss  = 30%/leverage price move against entry
//   Trail starts:  +31% capital gain = 31%/leverage price move in favor
//   Lock step:     floor(capitalGain / 10%) × 10%  (ratchets, never moves back)
//
//   With leverage=10, entry=$2000, price at $2062 (+3.1% = +31% capital):
//     → lockCapPct = 0.30 → SL at entry + 3.0% = $2060
//   With price at $2080 (+4.0% = +40% capital):
//     → lockCapPct = 0.40 → SL at entry + 4.0% = $2080
//
//   leverage defaults to 1 (treat pct as direct position % — matches user examples).

function calcTrailingSL(entryPrice, currentPrice, side, leverage = 1) {
  const pricePct =
    side === 'LONG'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;

  // Convert to capital % relative to margin
  const capitalPct = pricePct * leverage;

  const INITIAL_SL_CAP = 0.20; // 20% capital = initial stop (system-wide)
  const TRAIL_ON_CAP   = 0.21; // trailing kicks in at +21% capital → lock +20%

  if (capitalPct < TRAIL_ON_CAP) {
    // Initial SL: 20% capital loss → convert back to price
    const slPricePct = INITIAL_SL_CAP / leverage;
    return side === 'LONG'
      ? entryPrice * (1 - slPricePct)
      : entryPrice * (1 + slPricePct);
  }

  // 1% gap rule: trigger sits 1% above lock at every step.
  //   0.21 → 0.20 | 0.30 → 0.20 | 0.31 → 0.30 | 0.40 → 0.30 | 0.41 → 0.40 …
  // Subtract 0.01 before flooring so the lock only advances 1% past each step.
  // 1e-9 epsilon guards against JS float subtraction artefacts (0.21-0.01).
  const lockCapPct   = Math.floor((capitalPct - 0.01 + 1e-9) * 10) / 10;
  const lockPricePct = lockCapPct / leverage;

  return side === 'LONG'
    ? entryPrice * (1 + lockPricePct)
    : entryPrice * (1 - lockPricePct);
}

// ── Signal scoring (0 – 20) ───────────────────────────────────

function scoreSignal({ swing15, swing3, confirm1m, zone, biasMatchesZone }) {
  let s = 0;

  // Step 1: 15m swing
  if (swing15) {
    s += 5;
    if (swing15.barsAgo <= 3)      s += 3; // ≤ 45 min ago
    else if (swing15.barsAgo <= 7) s += 1;
  }

  // Step 1 (optional): 3m swing alignment
  if (swing3 && swing3.bias === swing15?.bias) {
    s += 3;
    if (swing3.barsAgo <= 4) s += 1; // ≤ 12 min ago
  }

  // Step 2: 1m confirmation (window now 10 bars; bonus for recency)
  if (confirm1m) {
    s += 5;
    if (confirm1m.barsAgo <= 2)       s += 2; // ≤ 2 min — very fresh
    else if (confirm1m.barsAgo <= 5)  s += 1; // ≤ 5 min — fresh
    // 6–10 min: still valid, no bonus
  }

  // VWAP zone bonus
  if (biasMatchesZone && zone !== 'middle') s += 1;

  return Math.min(s, 20);
}

// ── Analyze one symbol ────────────────────────────────────────

async function analyzeV2(ticker) {
  try {
    const symbol = ticker.symbol;
    const price  = parseFloat(ticker.lastPrice);

    // Fetch all needed timeframes in parallel
    const [klines15m, klines3m, klines1m] = await Promise.all([
      fetchKlines(symbol, '15m', 100),
      fetchKlines(symbol, '3m',  100),
      fetchKlines(symbol, '1m',   50),
    ]);

    if (!klines15m || klines15m.length < 20) return null;
    if (!klines3m  || klines3m.length  < 20) return null;
    if (!klines1m  || klines1m.length  < 15) return null;

    // ── VWAP bands from last 96 × 15m bars (≈ 24 h of session data) ──
    const bands = calcVWAPBands(klines15m.slice(-96));
    if (!bands) return null;

    const zone = vwapZone(price, bands);

    // ── STEP 1: 15m swing ──────────────────────────────────────
    const swing15 = classifyLastSwing(klines15m, 2);
    if (!swing15) return null;

    // Must be fresh (≤ 12 bars = 3 hours on 15m)
    if (swing15.barsAgo > 12) return null;

    const bias = swing15.bias; // 'long' | 'short'

    // VWAP band hard filter
    //   upper band → only accept swing LOWs (HL/LL) on 15m for LONG
    //   lower band → only accept swing HIGHs (HH/LH) on 15m for SHORT
    if (zone === 'upper' && bias !== 'long')  return null;
    if (zone === 'lower' && bias !== 'short') return null;

    // ── STEP 1 (optional): 3m alignment ───────────────────────
    const swing3 = classifyLastSwing(klines3m, 2);
    // 3m is optional — used only for scoring

    const biasMatchesZone =
      (zone === 'upper' && bias === 'long') ||
      (zone === 'lower' && bias === 'short') ||
      zone === 'middle';

    // ── STEP 2: 1m confirmation ────────────────────────────────
    //   LONG  → need swing LOW  (HL or LL) on 1m
    //   SHORT → need swing HIGH (HH or LH) on 1m
    const confirm1m = classifyLastSwing(klines1m, 2);
    if (!confirm1m) return null;

    // 1m swing must agree with bias
    if (confirm1m.bias !== bias) return null;

    // 1m confirmation must be fresh (≤ 10 bars = 10 minutes)
    if (confirm1m.barsAgo > 10) return null;

    // ── Entry: current price (= "next candle" after confirmation) ──
    const side  = bias === 'long' ? 'LONG' : 'SHORT';
    const entry = price;

    // SL display: 30% capital at default 20x = 1.5% price move.
    // openTrade() recalculates SL precisely using actual leverage — this is reference only.
    const INITIAL_SL_PRICE_PCT = 0.30 / 20; // 30% capital ÷ 20x default leverage
    const sl = side === 'LONG'
      ? entry * (1 - INITIAL_SL_PRICE_PCT)
      : entry * (1 + INITIAL_SL_PRICE_PCT);

    // ── Score ──────────────────────────────────────────────────
    const score = scoreSignal({ swing15, swing3, confirm1m, zone, biasMatchesZone });
    if (score < 8) return null; // minimum confluence required

    // ── Build setup label ──────────────────────────────────────
    const parts = [`${swing15.type}@15m`];
    if (swing3 && swing3.bias === bias) parts.push(`${swing3.type}@3m`);
    parts.push(`${confirm1m.type}@1m`);
    if (zone !== 'middle') parts.push(`VWAP-${zone}`);
    const setupName = parts.join(' + ');

    return {
      symbol,
      lastPrice:  price,
      signal:     side === 'LONG' ? 'BUY' : 'SELL',
      side,
      entry,
      sl,
      slPct:      (INITIAL_SL_PRICE_PCT * 100).toFixed(2), // price % (30% capital at 20x)

      // Trailing SL config — consumed by the position manager in bot.js
      trailConfig: {
        startPct:     0.31,  // start trailing at +31 % profit
        stepPct:      0.10,  // lock step every +10 %
        initialSLPct: 0.30,  // initial SL distance
      },

      setupName,
      score,

      // cycle.js compatibility aliases
      direction: side,        // 'LONG' | 'SHORT'
      tp1:       null,        // no fixed TP — position runs on trailing SL
      tp2:       null,
      tp3:       null,

      // Diagnostic fields
      swing15:   { type: swing15.type,   val: swing15.val,   barsAgo: swing15.barsAgo   },
      swing3:    swing3 ? { type: swing3.type, val: swing3.val, barsAgo: swing3.barsAgo } : null,
      confirm1m: { type: confirm1m.type, val: confirm1m.val, barsAgo: confirm1m.barsAgo },

      vwap:   bands.vwap,
      vwapU1: bands.upper1,
      vwapL1: bands.lower1,
      zone,

      chg24h:    parseFloat(ticker.priceChangePercent),
      timeframe: '15m/3m+1m',
      version:   'v2',
    };

  } catch (_) {
    return null;
  }
}

// ── Main scan ─────────────────────────────────────────────────

async function scanV2(log = console.log) {
  const tickers = await fetchTickers();
  if (!tickers.length) {
    log('v2: failed to fetch tickers');
    return [];
  }

  // Top 30 futures by 24h quote volume, min $100M
  const top30 = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => parseFloat(t.quoteVolume) > 100e6)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 30);

  log(`v2: scanning ${top30.length} symbols…`);

  const results = [];
  for (const ticker of top30) {
    const sig = await analyzeV2(ticker);
    if (sig) {
      results.push(sig);
      log(`  ✓ ${sig.symbol} ${sig.side} score=${sig.score} — ${sig.setupName}`);
    }
    await new Promise(r => setTimeout(r, 200)); // rate-limit buffer
  }

  results.sort((a, b) => b.score - a.score);
  log(`v2: ${results.length} signal(s) found`);
  return results.slice(0, 3); // max 3 per scan cycle
}

module.exports = {
  scanV2,
  analyzeV2,
  calcTrailingSL,
  calcVWAPBands,
  classifyLastSwing,
  findSwings,
};
