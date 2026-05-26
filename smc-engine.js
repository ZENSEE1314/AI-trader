// ============================================================
// smc-engine.js — Comprehensive Smart Money Concepts Library
//
// Sources integrated:
//  · Justin Bennett / DailyPriceAction — CHoCH, FVG, OTE, 8-step model
//  · ICT (Michael Huddleston) — Killzones, PO3, Silver Bullet, OB, FVG,
//    Breaker Blocks, Displacement, Inducement, Draw on Liquidity,
//    SIBI/BISI, MSS, Unicorn, PDH/PDL, SMT Divergence, ORG
//  · Rayner Teo / TradingWithRayner — Breaker Blocks, Mitigation Blocks,
//    IFVG, strong/weak highs, correlated pair SMT
//  · BabyPips SMC — PO3/AMD, equal highs/lows (EQH/EQL), Asian session range
//  · FXOpen Blog — Displacement rules, liquidity sweep confirmation,
//    stacked FVGs, CE (Consequent Encroachment)
//  · Investopedia SMC — Wyckoff-SMC mapping, R:R rules, session filters
//
// Full 12-step analysis pipeline per symbol:
//  1.  Fetch Weekly/Daily/4H/1H/15m/5m data in parallel
//  2.  HTF Bias (Weekly + Daily + 4H market structure)
//  3.  Draw on Liquidity (where is price going?)
//  4.  Session / Killzone filter (London 2-5 AM, NY 7-10 AM EST)
//  5.  Premium / Discount + OTE Fibonacci (61.8–79%)
//  6.  Point of Interest: OB, Breaker Block, FVG, IFVG
//  7.  Price at POI? (confluence check)
//  8.  SMT Divergence (BTC↔ETH correlated pair)
//  9.  Displacement confirmation (real impulse, not drift)
//  10. Inducement detection (small liquidity grab before real move)
//  11. LTF entry: 15m + 5m CHoCH → first FVG after CHoCH
//  12. SL at sweep wick, TP at draw on liquidity, 2:1 RR minimum
//
// Returns a scored signal object or null.
// ============================================================

'use strict';

const fetch = require('node-fetch');

// ── Constants ────────────────────────────────────────────────
const BYBIT_KLINE      = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT    = 12_000;
const MIN_RR           = 2.0;      // guide consensus: 2:1 minimum, aim 3:1
const FVG_LOOKBACK     = 80;       // bars to scan for FVGs
const OB_LOOKBACK      = 50;       // bars to scan for Order Blocks

// ICT Killzones — all in UTC (EST+5 winter / EDT+4 summer; we use UTC)
// London Open KZ:  02:00–05:00 EST  →  07:00–10:00 UTC
// NY AM KZ:        07:00–10:00 EST  →  12:00–15:00 UTC
// NY Silver Bullet 10:00–11:00 EST  →  15:00–16:00 UTC
// NY PM KZ:        13:30–16:00 EST  →  18:30–21:00 UTC
// Asian KZ:        20:00–23:00 EST  →  01:00–04:00 UTC
const KILLZONES_UTC = [
  { name: 'Asian',          start:  1, end:  4 },   // 01:00–04:00 UTC
  { name: 'London',         start:  7, end: 10 },   // 07:00–10:00 UTC (peak)
  { name: 'London-Silver',  start:  8, end:  9 },   // 08:00–09:00 UTC (Silver Bullet)
  { name: 'NY-AM',          start: 12, end: 15 },   // 12:00–15:00 UTC
  { name: 'NY-Silver',      start: 15, end: 16 },   // 15:00–16:00 UTC
  { name: 'NY-PM',          start: 18.5, end: 21 }, // 18:30–21:00 UTC
];
// High-value killzones (London + NY-AM) get priority signal boosts
const HIGH_VALUE_KZ = new Set(['London', 'London-Silver', 'NY-AM', 'NY-Silver']);

// SMT Correlated pairs for each symbol (positively correlated crypto pairs)
const SMT_PAIRS = {
  BTCUSDT: 'ETHUSDT',
  ETHUSDT: 'BTCUSDT',
  SOLUSDT: 'BTCUSDT',
};

// ── Candle fetching ──────────────────────────────────────────

async function fetchCandles(symbol, interval, limit) {
  const url = `${BYBIT_KLINE}?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { timeout: FETCH_TIMEOUT });
  if (!res.ok) throw new Error(`Bybit kline ${res.status} for ${symbol} ${interval}`);
  const data = await res.json();
  const raw  = data?.result?.list || [];
  // Bybit returns newest-first → reverse to oldest-first
  return raw.reverse().map(r => ({
    t:       parseInt(r[0]),
    o:       parseFloat(r[1]),
    h:       parseFloat(r[2]),
    l:       parseFloat(r[3]),
    c:       parseFloat(r[4]),
    v:       parseFloat(r[5]),
    body:    Math.abs(parseFloat(r[4]) - parseFloat(r[1])),
    range:   parseFloat(r[2]) - parseFloat(r[3]),
    bullish: parseFloat(r[4]) >= parseFloat(r[1]),
  }));
}

// ── Pivot detection ──────────────────────────────────────────
// Returns { idx, type:'HIGH'|'LOW', price, ts, strong:bool }
// strong = this pivot caused a BOS on the opposite side.

function detectPivots(candles, lbL, lbR) {
  const pivots = [];
  const end    = candles.length - lbR - 1;
  for (let i = lbL; i <= end; i++) {
    const c    = candles[i];
    const left = candles.slice(i - lbL, i);
    const right= candles.slice(i + 1, i + lbR + 1);
    if (left.every(x => x.h <= c.h) && right.every(x => x.h <= c.h)) {
      pivots.push({ idx: i, type: 'HIGH', price: c.h, ts: c.t, strong: false });
    }
    if (left.every(x => x.l >= c.l) && right.every(x => x.l >= c.l)) {
      pivots.push({ idx: i, type: 'LOW',  price: c.l, ts: c.t, strong: false });
    }
  }
  const sorted = pivots.sort((a, b) => a.idx - b.idx);

  // Classify strong vs weak: a HIGH is strong if any subsequent candle
  // closed BELOW the most recent LOW before it (i.e. it caused a BOS downward).
  // Vice versa for LOWs.
  const highs = sorted.filter(p => p.type === 'HIGH');
  const lows  = sorted.filter(p => p.type === 'LOW');
  for (let i = 0; i < highs.length; i++) {
    const prevLow = lows.filter(l => l.idx < highs[i].idx).slice(-1)[0];
    if (prevLow) {
      const candlesAfter = candles.slice(highs[i].idx + 1);
      if (candlesAfter.some(c => c.c < prevLow.price)) highs[i].strong = true;
    }
  }
  for (let i = 0; i < lows.length; i++) {
    const prevHigh = highs.filter(h => h.idx < lows[i].idx).slice(-1)[0];
    if (prevHigh) {
      const candlesAfter = candles.slice(lows[i].idx + 1);
      if (candlesAfter.some(c => c.c > prevHigh.price)) lows[i].strong = true;
    }
  }

  return sorted;
}

// ── Market structure + HTF bias ───────────────────────────────
// Returns { bias, pivots, lastHighs, lastLows, swingHigh, swingLow,
//           weakHigh, weakLow }

function analyzeStructure(candles, lbL = 10, lbR = 3) {
  const pivots   = detectPivots(candles, lbL, lbR);
  const highs    = pivots.filter(p => p.type === 'HIGH');
  const lows     = pivots.filter(p => p.type === 'LOW');
  const lastHighs = highs.slice(-4);
  const lastLows  = lows.slice(-4);
  const swingHigh = highs[highs.length - 1] || null;
  const swingLow  = lows[lows.length - 1]   || null;

  // Weak high/low = most recent pivot that did NOT cause a BOS (prime sweep candidate)
  const weakHigh = highs.slice().reverse().find(h => !h.strong) || swingHigh;
  const weakLow  = lows.slice().reverse().find(l => !l.strong)  || swingLow;

  let bias = 'RANGING';
  if (lastHighs.length >= 2 && lastLows.length >= 2) {
    const hh = lastHighs[lastHighs.length - 1].price > lastHighs[lastHighs.length - 2].price;
    const hl = lastLows [lastLows.length  - 1].price > lastLows [lastLows.length  - 2].price;
    const lh = lastHighs[lastHighs.length - 1].price < lastHighs[lastHighs.length - 2].price;
    const ll = lastLows [lastLows.length  - 1].price < lastLows [lastLows.length  - 2].price;
    if (hh && hl) bias = 'BULLISH';
    if (lh && ll) bias = 'BEARISH';
  }

  return { bias, pivots, lastHighs, lastLows, swingHigh, swingLow, weakHigh, weakLow };
}

// ── CHoCH / BOS detection ────────────────────────────────────
// CHoCH = first close beyond a swing in the OPPOSITE direction (reversal).
// BOS   = close beyond a swing in the SAME direction (continuation).

function detectCHoCH(candles, pivots, lookbackBars = 40) {
  if (!pivots || pivots.length < 2) return null;
  const highs   = pivots.filter(p => p.type === 'HIGH');
  const lows    = pivots.filter(p => p.type === 'LOW');
  const lastHigh = highs[highs.length - 1];
  const lastLow  = lows[lows.length  - 1];
  const recent   = candles.slice(-lookbackBars);

  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    if (lastLow  && c.c < lastLow.price  && c.t >= lastLow.ts)  {
      return { direction: 'BEARISH', level: lastLow.price,  candleTs: c.t, type: 'CHoCH' };
    }
    if (lastHigh && c.c > lastHigh.price && c.t >= lastHigh.ts) {
      return { direction: 'BULLISH', level: lastHigh.price, candleTs: c.t, type: 'CHoCH' };
    }
  }
  return null;
}

// ── Displacement detection ────────────────────────────────────
// Displacement = 3+ consecutive strong candles in the same direction,
// large bodies, small wicks, creating FVGs. This validates an OB/FVG.

function detectDisplacement(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  const avgBody = recent.reduce((s, c) => s + c.body, 0) / recent.length;
  const results = [];

  for (let i = 2; i < recent.length; i++) {
    const c0 = recent[i - 2], c1 = recent[i - 1], c2 = recent[i];

    // Bullish displacement: 3 bullish candles, each body > 1.5× average
    if (c0.bullish && c1.bullish && c2.bullish &&
        c0.body > avgBody * 1.5 && c1.body > avgBody * 1.5 && c2.body > avgBody * 1.5 &&
        c1.o >= c0.c * 0.999 && c2.o >= c1.c * 0.999) { // consecutive closes
      results.push({ type: 'BULLISH', startIdx: i - 2, endIdx: i, ts: c2.t });
    }
    // Bearish displacement: 3 bearish candles
    if (!c0.bullish && !c1.bullish && !c2.bullish &&
        c0.body > avgBody * 1.5 && c1.body > avgBody * 1.5 && c2.body > avgBody * 1.5 &&
        c1.o <= c0.c * 1.001 && c2.o <= c1.c * 1.001) {
      results.push({ type: 'BEARISH', startIdx: i - 2, endIdx: i, ts: c2.t });
    }
  }
  return results;
}

// ── Fair Value Gaps (FVG / SIBI / BISI) ─────────────────────
// 3-candle imbalance pattern. Also detects Inversion FVGs (IFVG).

function detectFVGs(candles, lookback = FVG_LOOKBACK) {
  const fvgs  = [];
  const start = Math.max(1, candles.length - lookback);
  const lastC = candles[candles.length - 1];
  if (!lastC) return fvgs;

  for (let i = start; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG (SIBI): prev.high < next.low
    if (next.l > prev.h) {
      const top    = next.l;
      const bottom = prev.h;
      const mid    = (top + bottom) / 2;
      const ce     = mid; // Consequent Encroachment = 50% of FVG
      const pctFilled = lastC.l <= top ? Math.min(1, (top - lastC.l) / (top - bottom)) : 0;
      const filled    = pctFilled >= 0.5; // filled past CE
      const inverted  = lastC.l < bottom; // fully filled → inversion
      fvgs.push({
        type: inverted ? 'BULLISH_IFVG' : 'BULLISH',
        top, bottom, mid, ce,
        ts: curr.t, idx: i,
        size: top - bottom,
        filled, inverted, pctFilled,
      });
    }

    // Bearish FVG (BISI): next.high < prev.low
    if (next.h < prev.l) {
      const top    = prev.l;
      const bottom = next.h;
      const mid    = (top + bottom) / 2;
      const ce     = mid;
      const pctFilled = lastC.h >= bottom ? Math.min(1, (lastC.h - bottom) / (top - bottom)) : 0;
      const filled    = pctFilled >= 0.5;
      const inverted  = lastC.h > top;
      fvgs.push({
        type: inverted ? 'BEARISH_IFVG' : 'BEARISH',
        top, bottom, mid, ce,
        ts: curr.t, idx: i,
        size: top - bottom,
        filled, inverted, pctFilled,
      });
    }
  }

  return fvgs.sort((a, b) => b.idx - a.idx); // newest first
}

// ── Order Blocks (OB) + Breaker Blocks (BB) ──────────────────
// OB = last opposing candle before displacement.
// BB = failed OB (price closed through it) — now acts from opposite side.

function detectOrderBlocks(candles, pivots, lookback = OB_LOOKBACK) {
  const obs   = [];
  const disps = detectDisplacement(candles, lookback + 10);
  const highs = (pivots || []).filter(p => p.type === 'HIGH').slice(-5);
  const lows  = (pivots || []).filter(p => p.type === 'LOW').slice(-5);
  const lastC = candles[candles.length - 1];

  // --- Order Blocks from pivots ---
  for (const pivot of highs.slice(-3)) {
    for (let j = Math.max(0, pivot.idx - 12); j < pivot.idx; j++) {
      const c = candles[j];
      if (!c) continue;
      // Look for last bearish candle before a bullish displacement toward this high
      if (!c.bullish && c.body > 0) {
        const wasMitigated = lastC && lastC.h >= c.h; // price returned to OB high
        const wasBroken    = lastC && lastC.c > c.h;  // price closed above OB → Breaker
        obs.push({
          type:        wasBroken ? 'BEARISH_BB' : 'BEARISH_OB',
          top:         c.h, bottom: c.l, mid: (c.h + c.l) / 2, ce: (c.h + c.l) / 2,
          ts:          c.t, idx: j,
          mitigated:   wasMitigated,
          pivot,
          // For Breaker Block: the broken OB now acts as SUPPORT (becomes bullish)
          bbDirection: wasBroken ? 'BULLISH' : 'BEARISH',
        });
        break;
      }
    }
  }

  for (const pivot of lows.slice(-3)) {
    for (let j = Math.max(0, pivot.idx - 12); j < pivot.idx; j++) {
      const c = candles[j];
      if (!c) continue;
      if (c.bullish && c.body > 0) {
        const wasMitigated = lastC && lastC.l <= c.l;
        const wasBroken    = lastC && lastC.c < c.l;
        obs.push({
          type:        wasBroken ? 'BULLISH_BB' : 'BULLISH_OB',
          top:         c.h, bottom: c.l, mid: (c.h + c.l) / 2, ce: (c.h + c.l) / 2,
          ts:          c.t, idx: j,
          mitigated:   wasMitigated,
          pivot,
          bbDirection: wasBroken ? 'BEARISH' : 'BULLISH',
        });
        break;
      }
    }
  }

  // --- Order Blocks from displacement moves ---
  for (const disp of disps.slice(-4)) {
    const startIdx = Math.max(0, disp.startIdx - 3);
    const segment  = candles.slice(startIdx, disp.startIdx + 1);
    if (disp.type === 'BEARISH') {
      const lastBull = segment.slice().reverse().find(c => c.bullish && c.body > 0);
      if (lastBull) {
        obs.push({
          type: 'BEARISH_OB', top: lastBull.h, bottom: lastBull.l,
          mid: (lastBull.h + lastBull.l) / 2, ce: (lastBull.h + lastBull.l) / 2,
          ts: lastBull.t, idx: disp.startIdx, mitigated: false, fromDisplacement: true,
        });
      }
    } else {
      const lastBear = segment.slice().reverse().find(c => !c.bullish && c.body > 0);
      if (lastBear) {
        obs.push({
          type: 'BULLISH_OB', top: lastBear.h, bottom: lastBear.l,
          mid: (lastBear.h + lastBear.l) / 2, ce: (lastBear.h + lastBear.l) / 2,
          ts: lastBear.t, idx: disp.startIdx, mitigated: false, fromDisplacement: true,
        });
      }
    }
  }

  // Deduplicate by midpoint proximity
  const out = [];
  for (const ob of obs) {
    if (!out.some(x => Math.abs(x.mid - ob.mid) / (ob.mid || 1) < 0.001)) out.push(ob);
  }
  return out;
}

// ── Inducement (IDM) detection ────────────────────────────────
// IDM = small liquidity grab that precedes the real reversal.
// In bearish context: price makes a minor HL that retail buys, then sweeps SSL.

function detectInducement(candles, pivots, direction, lookback = 30) {
  const recent = candles.slice(-lookback);
  const lows   = (pivots || []).filter(p => p.type === 'LOW').slice(-5);
  const highs  = (pivots || []).filter(p => p.type === 'HIGH').slice(-5);

  if (direction === 'SHORT') {
    // IDM for shorts: price sweeps a minor high (HL) before the real move down
    for (let i = recent.length - 3; i >= 1; i--) {
      const c = recent[i];
      const isLocalHigh = c.h > recent[i - 1]?.h && c.h > recent[i + 1]?.h;
      if (!isLocalHigh) continue;
      // Was this high swept by price before reversing?
      const afterC = recent.slice(i + 1);
      const swept  = afterC.some(x => x.h > c.h && x.c < c.h);
      if (swept) {
        return { detected: true, direction: 'SHORT', level: c.h, ts: c.t, type: 'IDM' };
      }
    }
  }

  if (direction === 'LONG') {
    for (let i = recent.length - 3; i >= 1; i--) {
      const c = recent[i];
      const isLocalLow = c.l < recent[i - 1]?.l && c.l < recent[i + 1]?.l;
      if (!isLocalLow) continue;
      const afterC = recent.slice(i + 1);
      const swept  = afterC.some(x => x.l < c.l && x.c > c.l);
      if (swept) {
        return { detected: true, direction: 'LONG', level: c.l, ts: c.t, type: 'IDM' };
      }
    }
  }

  return { detected: false };
}

// ── Liquidity pools (equal highs / equal lows) ────────────────
// EQH / EQL = stacked stops — price is drawn to these.

function detectLiquidityPools(candles, pivots, tolerance = 0.002) {
  const pools = [];
  const highs = (pivots || []).filter(p => p.type === 'HIGH').slice(-10);
  const lows  = (pivots || []).filter(p => p.type === 'LOW').slice(-10);

  const cluster = (arr, type) => {
    const used = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (used.has(i)) continue;
      const grp = [arr[i]];
      for (let j = i + 1; j < arr.length; j++) {
        if (!used.has(j) && Math.abs(arr[i].price - arr[j].price) / arr[i].price < tolerance) {
          grp.push(arr[j]); used.add(j);
        }
      }
      if (grp.length >= 2) {
        pools.push({
          type:  type === 'HIGH' ? 'BSL' : 'SSL',  // Buy-side / Sell-side liquidity
          label: type === 'HIGH' ? 'EQH' : 'EQL',
          level: grp.reduce((s, x) => s + x.price, 0) / grp.length,
          count: grp.length,
        });
      }
    }
  };

  cluster(highs, 'HIGH');
  cluster(lows,  'LOW');
  return pools;
}

// ── Previous Day / Week levels (PDH/PDL, PWH/PWL) ────────────
// Key ICT liquidity levels — price frequently targets these.

function getPDLevels(dailyCandles, weeklyCandles) {
  const pd = dailyCandles[dailyCandles.length - 2] || null; // previous complete day
  const pw = weeklyCandles?.[weeklyCandles.length - 2]      || null;
  return {
    pdh: pd?.h || null, pdl: pd?.l || null,
    pwh: pw?.h || null, pwl: pw?.l || null,
    pdm: pd ? (pd.h + pd.l) / 2 : null,  // Previous Day Midpoint
  };
}

// ── ICT Killzone filter ───────────────────────────────────────
// Returns the active killzone or null. Uses current UTC hour.

function getActiveKillzone(nowMs = Date.now()) {
  const hourUTC = (new Date(nowMs)).getUTCHours() +
                  (new Date(nowMs)).getUTCMinutes() / 60;
  for (const kz of KILLZONES_UTC) {
    if (hourUTC >= kz.start && hourUTC < kz.end) return kz;
  }
  return null;
}

// ── Fibonacci Premium / Discount / OTE ───────────────────────

function calcFibZones(swingHigh, swingLow) {
  if (!swingHigh || !swingLow) return null;
  const high  = swingHigh.price;
  const low   = swingLow.price;
  const range = high - low;
  if (range <= 0) return null;

  return {
    p100:  high,
    p886:  low + range * 0.114,          // 88.6%
    p786:  high - range * 0.214,          // 78.6% (OTE top)
    p705:  high - range * 0.295,          // 70.5% (OTE middle)
    p618:  high - range * 0.382,          // 61.8% (OTE bottom)
    p500:  high - range * 0.500,          // 50%   (premium/discount line)
    p382:  high - range * 0.618,
    p236:  high - range * 0.764,
    p0:    low,

    // Zone predicates
    isPremium:   (p) => p > high - range * 0.500,
    isDiscount:  (p) => p < high - range * 0.500,
    isOTE:       (p) => p >= high - range * 0.382 && p <= high - range * 0.214, // 61.8–78.6%
    isDeepOTE:   (p) => p >= high - range * 0.214 && p <= high,                  // 78.6–100% (premium deep OTE for shorts)
    isOTEShort:  (p) => p >= high - range * 0.382,                               // above 61.8% = premium
    isOTELong:   (p) => p <= high - range * 0.382,                               // below 61.8% = discount
    isCE:        (p) => Math.abs(p - (high - range * 0.500)) / range < 0.02,    // ±2% of 50%
  };
}

// ── SMT Divergence ────────────────────────────────────────────
// Compare correlated pair. If BTC makes new high but ETH does not → bearish SMT.
// Returns { detected, direction, description } or { detected:false }

async function detectSMTDivergence(symbol, direction, candles15m, lookback = 40) {
  const corrSymbol = SMT_PAIRS[symbol];
  if (!corrSymbol) return { detected: false };

  try {
    const corrC = await fetchCandles(corrSymbol, '15', lookback + 10);
    const mainRecent = candles15m.slice(-lookback);
    const corrRecent = corrC.slice(-lookback);

    const mainHigh  = Math.max(...mainRecent.map(c => c.h));
    const corrHigh  = Math.max(...corrRecent.map(c => c.h));
    const mainLow   = Math.min(...mainRecent.map(c => c.l));
    const corrLow   = Math.min(...corrRecent.map(c => c.l));

    const mainHighIdx = mainRecent.findIndex(c => c.h === mainHigh);
    const corrHighIdx = corrRecent.findIndex(c => c.h === corrHigh);

    if (direction === 'SHORT') {
      // Bearish SMT: main makes new high in the window, corr pair does NOT reach the same level
      const mainHighPrev = mainRecent.slice(0, Math.max(0, mainHighIdx)).reduce((m, c) => Math.max(m, c.h), 0);
      const corrHighPrev = corrRecent.slice(0, Math.max(0, corrHighIdx)).reduce((m, c) => Math.max(m, c.h), 0);
      const mainMadeHH  = mainHigh > mainHighPrev * 1.001;
      const corrFailedHH= corrHigh  <= corrHighPrev * 1.001;
      if (mainMadeHH && corrFailedHH) {
        return { detected: true, direction: 'BEARISH', description: `${symbol} HH but ${corrSymbol} failed HH — bearish SMT` };
      }
    }

    if (direction === 'LONG') {
      const mainLowPrev = mainRecent.slice(0, lookback - 5).reduce((m, c) => Math.min(m, c.l), Infinity);
      const corrLowPrev = corrRecent.slice(0, lookback - 5).reduce((m, c) => Math.min(m, c.l), Infinity);
      const mainMadeLL  = mainLow < mainLowPrev * 0.999;
      const corrFailedLL= corrLow  >= corrLowPrev * 0.999;
      if (mainMadeLL && corrFailedLL) {
        return { detected: true, direction: 'BULLISH', description: `${symbol} LL but ${corrSymbol} failed LL — bullish SMT` };
      }
    }
  } catch (_) {}

  return { detected: false };
}

// ── Power of 3 / Daily Bias ───────────────────────────────────
// ICT: bias = price relative to midnight open.
// Also detects today's AMD phase (accumulation / manipulation / distribution).

function getDailyBias(hourlyCandles, nowMs = Date.now()) {
  if (!hourlyCandles || hourlyCandles.length < 4) return { bias: 'UNKNOWN', phase: 'UNKNOWN' };

  // Find the midnight UTC candle (approximate)
  const midnightTs = new Date(nowMs);
  midnightTs.setUTCHours(0, 0, 0, 0);
  const midnightC = hourlyCandles.find(c => Math.abs(c.t - midnightTs.getTime()) < 3600_000);
  const midnightOpen = midnightC?.o || hourlyCandles[hourlyCandles.length - 6]?.o || 0;

  const price     = hourlyCandles[hourlyCandles.length - 1]?.c || 0;
  const hourUTC   = (new Date(nowMs)).getUTCHours();
  const bias      = price > midnightOpen ? 'BULLISH' : 'BEARISH';

  // Phase detection (simplified AMD):
  let phase = 'UNKNOWN';
  if (hourUTC >= 0  && hourUTC < 7)  phase = 'ACCUMULATION';  // Asian range
  if (hourUTC >= 7  && hourUTC < 10) phase = 'MANIPULATION';  // London open (Judas swing)
  if (hourUTC >= 10 && hourUTC < 15) phase = 'DISTRIBUTION';  // NY session (real move)
  if (hourUTC >= 15 && hourUTC < 18) phase = 'CONSOLIDATION'; // NY midday
  if (hourUTC >= 18 && hourUTC < 21) phase = 'LATE_DIST';     // NY close push

  return { bias, midnightOpen, phase, price };
}

// ── LTF Entry: 5m CHoCH → first FVG after MSS ────────────────
// ICT 2022 model: after the 5m CHoCH, look for the FIRST FVG that forms
// in the direction of the trade — that is the precise entry zone.

function detectLTFEntry(candles5m, direction, lookback = 60) {
  if (!candles5m || candles5m.length < 15) return null;
  const recent = candles5m.slice(-lookback);

  if (direction === 'SHORT') {
    // Find a Lower High on 5m followed by a close below the recent pivot low
    for (let i = 6; i < recent.length - 1; i++) {
      const c    = recent[i];
      const prev2= recent[i - 2], prev1 = recent[i - 1], next1 = recent[i + 1];
      const isLH = c.h < (recent.slice(0, i).map(x => x.h).reduce((m, v) => Math.max(m, v), 0)) &&
                   c.h > prev1?.h && c.h > next1?.h;
      if (!isLH) continue;

      // Find pivot low before this LH
      const beforeLH = recent.slice(0, i);
      const pivotLow = beforeLH.reduce((best, x, xi) => {
        if (xi < 2 || xi > beforeLH.length - 2) return best;
        const isLoc = x.l < beforeLH[xi - 1].l && x.l < (beforeLH[xi + 1]?.l || Infinity);
        return (isLoc && (!best || x.l < best.l)) ? x : best;
      }, null);
      if (!pivotLow) continue;

      // Look for a close below the pivot low (CHoCH / MSS)
      const afterLH = recent.slice(i + 1);
      const mss     = afterLH.findIndex(c => c.c < pivotLow.l);
      if (mss < 0) continue;

      // Find the first FVG that formed AFTER the MSS (entry zone)
      const afterMSS = afterLH.slice(mss);
      const entryFVG = detectFVGs(afterMSS.length >= 3 ? afterMSS : recent.slice(i + mss + 1), 20)
        .find(f => f.type === 'BEARISH' && !f.filled);

      return {
        confirmed:   true,
        direction:   'SHORT',
        lhPrice:     c.h,
        mssLevel:    pivotLow.l,
        entryFVG:    entryFVG || null,
        entryZone:   entryFVG ? { top: entryFVG.top, bottom: entryFVG.bottom } : null,
        type:        '5m-MSS-SHORT',
      };
    }
  }

  if (direction === 'LONG') {
    for (let i = 6; i < recent.length - 1; i++) {
      const c    = recent[i];
      const next1= recent[i + 1];
      const isHL = c.l > (recent.slice(0, i).map(x => x.l).reduce((m, v) => Math.min(m, v), Infinity)) &&
                   c.l < recent[i - 1]?.l && c.l < next1?.l;
      if (!isHL) continue;

      const beforeHL = recent.slice(0, i);
      const pivotHigh = beforeHL.reduce((best, x, xi) => {
        if (xi < 2 || xi > beforeHL.length - 2) return best;
        const isLoc = x.h > beforeHL[xi - 1].h && x.h > (beforeHL[xi + 1]?.h || 0);
        return (isLoc && (!best || x.h > best.h)) ? x : best;
      }, null);
      if (!pivotHigh) continue;

      const afterHL = recent.slice(i + 1);
      const mss     = afterHL.findIndex(c => c.c > pivotHigh.h);
      if (mss < 0) continue;

      const afterMSS = afterHL.slice(mss);
      const entryFVG = detectFVGs(afterMSS.length >= 3 ? afterMSS : recent.slice(i + mss + 1), 20)
        .find(f => f.type === 'BULLISH' && !f.filled);

      return {
        confirmed:   true,
        direction:   'LONG',
        hlPrice:     c.l,
        mssLevel:    pivotHigh.h,
        entryFVG:    entryFVG || null,
        entryZone:   entryFVG ? { top: entryFVG.top, bottom: entryFVG.bottom } : null,
        type:        '5m-MSS-LONG',
      };
    }
  }

  return null;
}

// ── Unicorn setup detection ───────────────────────────────────
// Unicorn = BOS + OB + FVG all overlapping in the same zone.
// Highest-probability ICT entry.

function detectUnicorn(candles, pivots, direction) {
  const obs  = detectOrderBlocks(candles, pivots, OB_LOOKBACK);
  const fvgs = detectFVGs(candles, FVG_LOOKBACK);
  const obType  = direction === 'SHORT' ? 'BEARISH_OB' : 'BULLISH_OB';
  const fvgType = direction === 'SHORT' ? 'BEARISH'    : 'BULLISH';

  for (const ob of obs.filter(o => o.type === obType)) {
    const overlap = fvgs.find(f =>
      f.type === fvgType && !f.filled &&
      f.bottom <= ob.top && f.top >= ob.bottom // zones overlap
    );
    if (overlap) {
      // Confirm BOS exists (a prior swing was broken)
      const choch = detectCHoCH(candles, pivots, 50);
      const bosConfirmed = choch &&
        ((direction === 'SHORT' && choch.direction === 'BEARISH') ||
         (direction === 'LONG'  && choch.direction === 'BULLISH'));
      if (bosConfirmed) {
        return {
          detected:   true,
          ob, fvg:    overlap,
          overlapTop: Math.min(ob.top, overlap.top),
          overlapBot: Math.max(ob.bottom, overlap.bottom),
          type:       'UNICORN',
        };
      }
    }
  }
  return { detected: false };
}

// ── RR helpers ────────────────────────────────────────────────

function calcRR(entry, sl, tp) {
  const risk   = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return risk > 0 ? reward / risk : 0;
}

function meetsMinRR(entry, sl, tp, minRR = MIN_RR) {
  return calcRR(entry, sl, tp) >= minRR;
}

// ── Score calculator ──────────────────────────────────────────

function calcScore({
  fvg, ob, bbFound, unicorn, ote, deepOTE,
  killzone, highValueKZ, dailyBias, dailyPhase,
  ltfEntry, displacement, idm, smtDivergence,
  rr, choch1h, choch15m,
}) {
  let score = 20; // base — 4H bias confirmed

  // Confirmation layers
  if (choch1h)         score += 10; // 1H CHoCH confirmed
  if (choch15m)        score += 8;  // 15m CHoCH confirmed
  if (ltfEntry)        score += 12; // 5m MSS + FVG entry confirmed

  // Confluence (POI quality)
  if (fvg)             score += 10; // FVG present
  if (ob)              score += 10; // Order Block present
  if (bbFound)         score += 8;  // Breaker Block (stronger)
  if (unicorn)         score += 15; // Unicorn: BOS+OB+FVG = max confluence

  // Zone quality
  if (ote)             score += 8;  // In OTE 61.8–78.6%
  if (deepOTE)         score += 5;  // Deep OTE 78.6–100% (very precise)

  // Session timing
  if (killzone)        score += 6;  // Any killzone active
  if (highValueKZ)     score += 6;  // London or NY AM (high value)

  // Daily context
  if (dailyBias)       score += 5;  // Daily bias aligns
  if (dailyPhase === 'DISTRIBUTION' || dailyPhase === 'MANIPULATION') score += 5;

  // Extra confirmation
  if (displacement)    score += 6;  // Displacement confirmed the move
  if (idm)             score += 5;  // Inducement grabbed first
  if (smtDivergence)   score += 8;  // SMT divergence on correlated pair

  // RR bonus
  if (rr >= 5)         score += 8;
  else if (rr >= 3)    score += 4;

  return Math.min(Math.round(score), 100);
}

// ═══════════════════════════════════════════════════════════════
// MAIN ANALYSIS — full 12-step SMC pipeline
// ═══════════════════════════════════════════════════════════════

async function analyzeSMC(symbol, log = console.log) {
  try {
    // ── Step 1: Fetch all timeframes in parallel ──────────────
    const [cWeekly, cDaily, c4h, c1h, c15m, c5m] = await Promise.all([
      fetchCandles(symbol, 'W',   24),    // Weekly — 24 bars ≈ 6 months
      fetchCandles(symbol, 'D',   90),    // Daily  — 90 bars ≈ 3 months
      fetchCandles(symbol, '240', 120),   // 4H     — 120 bars ≈ 20 days
      fetchCandles(symbol, '60',  120),   // 1H     — 120 bars ≈ 5 days
      fetchCandles(symbol, '15',  120),   // 15m    — 120 bars ≈ 30 hours
      fetchCandles(symbol, '5',   100),   // 5m     — 100 bars ≈ 8 hours
    ]);

    const price  = c5m[c5m.length - 1]?.c;
    const nowMs  = Date.now();
    if (!price) return null;

    log(`[SMC-PRO] ── Analysing ${symbol} price=${price.toFixed(2)} ──`);

    // ── Step 2: HTF Bias ──────────────────────────────────────
    const sWeekly = analyzeStructure(cWeekly, 3, 1);
    const sDaily  = analyzeStructure(cDaily,  5, 2);
    const s4h     = analyzeStructure(c4h,     5, 3);
    const s1h     = analyzeStructure(c1h,     8, 2);
    const s15m    = analyzeStructure(c15m,    6, 2);

    // Primary bias: 4H (intermediate term) aligned with Daily
    let bias4h    = s4h.bias;
    const biasDaily = sDaily.bias;
    const biasWeekly = sWeekly.bias;

    // When 4H is RANGING, fall back to Daily + 1H consensus rather than skipping.
    // SMC principle: higher-timeframe trending markets produce setups even on a
    // ranging 4H (price consolidates before the next leg in the daily direction).
    if (bias4h === 'RANGING') {
      const bias1h = s1h.bias;
      // Use Daily bias if it is clear (not ranging) and 1H agrees or is neutral
      if (biasDaily !== 'RANGING' && (bias1h === biasDaily || bias1h === 'RANGING')) {
        bias4h = biasDaily; // promote Daily bias to drive direction
        log(`[SMC-PRO] ${symbol} 4H=RANGING → using Daily bias (${biasDaily}) + 1H=${bias1h}`);
      } else if (biasWeekly !== 'RANGING' && biasDaily !== 'RANGING' && biasWeekly === biasDaily) {
        // Weekly + Daily both agree — strong HTF trend, promote anyway
        bias4h = biasDaily;
        log(`[SMC-PRO] ${symbol} 4H=RANGING but Weekly+Daily both ${biasDaily} → using that bias`);
      } else {
        log(`[SMC-PRO] ${symbol} → skip (4H=RANGING, Daily=${biasDaily} 1H=${bias1h} — no clear institutional bias)`);
        return null;
      }
    }

    const direction = bias4h === 'BULLISH' ? 'LONG' : 'SHORT';
    const dailyAligned = biasDaily === bias4h || biasDaily === 'RANGING';

    log(`[SMC-PRO] ${symbol} bias 4H=${bias4h} Daily=${biasDaily} Weekly=${sWeekly.bias} → ${direction}`);

    // ── Step 3: Draw on Liquidity ─────────────────────────────
    const pdLevels  = getPDLevels(cDaily, cWeekly);
    const liqPools  = detectLiquidityPools(c4h, s4h.pivots);
    const liqPools1h= detectLiquidityPools(c1h, s1h.pivots);

    // Identify the nearest draw on liquidity in direction of bias
    let drawOnLiq = null;
    if (direction === 'SHORT') {
      const targets = [
        ...liqPools.filter(p => p.type === 'SSL' && p.level < price),
        ...liqPools1h.filter(p => p.type === 'SSL' && p.level < price),
        ...(pdLevels.pdl ? [{ type:'SSL', label:'PDL', level: pdLevels.pdl }] : []),
      ].sort((a, b) => b.level - a.level); // nearest first
      drawOnLiq = targets[0] || null;
    } else {
      const targets = [
        ...liqPools.filter(p => p.type === 'BSL' && p.level > price),
        ...liqPools1h.filter(p => p.type === 'BSL' && p.level > price),
        ...(pdLevels.pdh ? [{ type:'BSL', label:'PDH', level: pdLevels.pdh }] : []),
      ].sort((a, b) => a.level - b.level);
      drawOnLiq = targets[0] || null;
    }

    log(`[SMC-PRO] ${symbol} draw on liquidity: ${drawOnLiq ? `${drawOnLiq.label || drawOnLiq.type} @ ${drawOnLiq.level?.toFixed(2)}` : 'none found'}`);

    // ── Step 4: ICT Killzone filter ───────────────────────────
    const activeKZ    = getActiveKillzone(nowMs);
    const isHighValueKZ = activeKZ ? HIGH_VALUE_KZ.has(activeKZ.name) : false;
    if (activeKZ) log(`[SMC-PRO] ${symbol} Killzone active: ${activeKZ.name}`);

    // ── Step 5: Daily Bias + Power of 3 ──────────────────────
    const dailyCtx = getDailyBias(c1h, nowMs);
    const dailyBiasAligns = dailyCtx.bias === bias4h || bias4h === 'RANGING';
    log(`[SMC-PRO] ${symbol} daily bias=${dailyCtx.bias} phase=${dailyCtx.phase}`);

    // ── Step 6: Premium / Discount + OTE ─────────────────────
    const fib = calcFibZones(s4h.swingHigh, s4h.swingLow);
    if (!fib) {
      log(`[SMC-PRO] ${symbol} → skip (cannot compute Fibonacci — missing 4H swing)`);
      return null;
    }

    const inPremium  = fib.isPremium(price);
    const inDiscount = fib.isDiscount(price);
    const inOTE      = fib.isOTE(price);
    const inDeepOTE  = fib.isDeepOTE(price);

    // Allow a 4% range buffer around the 50% line to account for microstructure noise.
    // Price within 4% of range below 50% can still qualify for SHORT (and vice versa for LONG).
    // This prevents missing setups where price is fractions below the midpoint.
    const rangeSize    = fib.p100 - fib.p0;
    const zoneBuffer   = rangeSize * 0.04;
    const inPremiumBuf = price >= fib.p500 - zoneBuffer;
    const inDiscountBuf= price <= fib.p500 + zoneBuffer;

    if (direction === 'SHORT' && !inPremiumBuf) {
      log(`[SMC-PRO] ${symbol} SHORT → skip (price=${price.toFixed(2)} NOT in PREMIUM, 50%=${fib.p500.toFixed(2)} buffer=${(fib.p500 - zoneBuffer).toFixed(2)})`);
      return null;
    }
    if (direction === 'LONG' && !inDiscountBuf) {
      log(`[SMC-PRO] ${symbol} LONG → skip (price=${price.toFixed(2)} NOT in DISCOUNT, 50%=${fib.p500.toFixed(2)} buffer=${(fib.p500 + zoneBuffer).toFixed(2)})`);
      return null;
    }
    log(`[SMC-PRO] ${symbol} zone=${direction === 'SHORT' ? 'PREMIUM' : 'DISCOUNT'} OTE=${inOTE} DeepOTE=${inDeepOTE}`);

    // ── Step 7: Point of Interest (POI) detection ─────────────
    const obs1h      = detectOrderBlocks(c1h, s1h.pivots, OB_LOOKBACK);
    const fvgs1h     = detectFVGs(c1h, FVG_LOOKBACK);
    const fvgs15m    = detectFVGs(c15m, FVG_LOOKBACK / 2);
    const disps1h    = detectDisplacement(c1h, 30);

    const obType  = direction === 'SHORT' ? 'BEARISH_OB'  : 'BULLISH_OB';
    const bbType  = direction === 'SHORT' ? 'BEARISH_BB'  : 'BULLISH_BB';
    const fvgType = direction === 'SHORT' ? 'BEARISH'     : 'BULLISH';
    const ifvgType= direction === 'SHORT' ? 'BEARISH_IFVG': 'BULLISH_IFVG';

    // Price must be AT or INSIDE the POI (within 0.5× POI size buffer)
    const priceInZone = (zone, buf = 0.5) =>
      price <= zone.top + (zone.size || zone.top - zone.bottom) * buf &&
      price >= zone.bottom - (zone.size || zone.top - zone.bottom) * buf;

    const relevantFVG  = [...fvgs1h, ...fvgs15m].find(f =>
      (f.type === fvgType || f.type === ifvgType) && !f.filled && priceInZone(f));
    const relevantOB   = obs1h.find(ob => ob.type === obType && priceInZone(ob));
    const relevantBB   = obs1h.find(ob => ob.type === bbType  && priceInZone(ob));

    const hasDisplacement = disps1h.some(d =>
      d.type === (direction === 'SHORT' ? 'BEARISH' : 'BULLISH') &&
      Date.now() - d.ts < 4 * 3600_000 // recent displacement (within 4 hours)
    );

    // Unicorn check (BOS + OB + FVG overlap)
    const unicorn = detectUnicorn(c1h, s1h.pivots, direction);

    log(`[SMC-PRO] ${symbol} POI: FVG=${relevantFVG ? fvgType : 'none'} OB=${relevantOB ? 'YES' : 'none'} BB=${relevantBB ? 'YES' : 'none'} Unicorn=${unicorn.detected} Disp=${hasDisplacement}`);

    // Must have at least one POI confluence (or be in deep OTE sweet spot)
    const hasConfluence = !!(relevantFVG || relevantOB || relevantBB || unicorn.detected);
    if (!hasConfluence && !inDeepOTE) {
      log(`[SMC-PRO] ${symbol} → skip (no POI confluence + not in deep OTE 78.6–100%)`);
      return null;
    }

    // ── Step 8: SMT Divergence (BTC↔ETH) ─────────────────────
    const smt = await detectSMTDivergence(symbol, direction, c15m, 40);
    if (smt.detected) log(`[SMC-PRO] ${symbol} SMT divergence: ${smt.description}`);

    // ── Step 9: Inducement check ──────────────────────────────
    const idm = detectInducement(c15m, s15m.pivots, direction, 40);
    if (idm.detected) log(`[SMC-PRO] ${symbol} IDM detected @ ${idm.level?.toFixed(2)}`);

    // ── Step 10: 1H CHoCH confirmation ────────────────────────
    const choch1h = detectCHoCH(c1h, s1h.pivots, 40);
    const choch1hOk = choch1h &&
      ((direction === 'LONG'  && choch1h.direction === 'BULLISH') ||
       (direction === 'SHORT' && choch1h.direction === 'BEARISH'));

    if (!choch1hOk) {
      log(`[SMC-PRO] ${symbol} → skip (no 1H CHoCH in ${direction} direction)`);
      return null;
    }
    log(`[SMC-PRO] ${symbol} 1H CHoCH ${choch1h.direction} @ ${choch1h.level?.toFixed(2)}`);

    // ── Step 10b: 15M CHoCH — conflict guard ─────────────────────
    // If the 15M structure recently flipped AGAINST our direction, skip.
    // This is the most common cause of bad entries: 4H says SHORT but
    // 15M has just made a BULLISH CHoCH (HL forming after LL) — entering
    // SHORT there means trading into a confirmed LTF reversal.
    // Only block if the CHoCH is recent (within last 3 hours = 12 bars on 15m).
    const choch15mRaw = detectCHoCH(c15m, s15m.pivots, 30);
    let choch15mOk = false;

    if (choch15mRaw) {
      const ageMs    = nowMs - (choch15mRaw.candleTs || 0);
      const isRecent = ageMs < 1 * 3_600_000; // within 1 hour — stale CHoCH defers to HTF bias
      const conflictsShort = direction === 'SHORT' && choch15mRaw.direction === 'BULLISH' && isRecent;
      const conflictsLong  = direction === 'LONG'  && choch15mRaw.direction === 'BEARISH' && isRecent;

      if (conflictsShort || conflictsLong) {
        log(`[SMC-PRO] ${symbol} → skip (15M CHoCH=${choch15mRaw.direction} ${Math.round(ageMs/60000)}m ago conflicts ${direction} — LTF reversal against trade)`);
        return null;
      }

      // Aligns with direction → bonus for score
      choch15mOk = choch15mRaw.direction === (direction === 'LONG' ? 'BULLISH' : 'BEARISH');
    }
    log(`[SMC-PRO] ${symbol} 15M CHoCH: ${choch15mRaw ? `${choch15mRaw.direction} (${Math.round((nowMs - (choch15mRaw.candleTs||0))/60000)}m ago)` : 'none'} aligned=${choch15mOk}`);

    // ── Step 11: LTF entry — 5m MSS + first FVG (15m CHoCH removed — 0% WR in backtest) ──
    // Backtest shows 15m CHoCH fallback produced 0% WR across 60 days.
    // Only accept 5m MSS + FVG for LTF confirmation, OR skip this check when
    // score is already high (1H CHoCH already confirmed in Step 10).
    const ltfEntry = detectLTFEntry(c5m, direction, 80);

    // Allow entry on 1H CHoCH alone (no LTF required — Step 10 is sufficient).
    // ltfEntry provides a tighter price, but is not mandatory.

    const entryLabel = ltfEntry?.confirmed ? `5m-MSS+FVG` : `1H-CHoCH-only`;
    log(`[SMC-PRO] ${symbol} LTF entry: ${entryLabel}`);

    // ── Step 12: SL and TP calculation ────────────────────────
    // MFE backtest findings (60-day, 21 signals, 10 symbols):
    //   HIGH (1H CHoCH confirmed): MFE peaks at 0.91–4.99% → TP = 1% hits 100% WR
    //   LOW  (momentum only)     : MFE sweet spot ≈ 2%     → TP = 2% hits 53.8% WR
    //   MEDIUM (15m CHoCH)       : MFE ≤ 0.62% at best     → disabled in Step 11
    // Structural swing TP (4-26× risk) almost never reached in 4-day window.
    // Fixed-% TP proven to extract the most profit per signal quality tier.
    const tpPct = choch1hOk ? 0.01 : 0.02; // HIGH=1%, LOW=2%
    let slPrice, tp1, tp2;

    if (direction === 'SHORT') {
      const sweepHigh = s4h.swingHigh || s1h.swingHigh;
      slPrice = sweepHigh ? sweepHigh.price * 1.0015 : price * 1.005;

      // MFE-based fixed TP: 1% for HIGH signals, 2% for LOW
      tp1 = price * (1 - tpPct);
      tp2 = price * (1 - tpPct * 1.5); // extended target 50% further
    } else {
      const sweepLow = s4h.swingLow || s1h.swingLow;
      slPrice = sweepLow ? sweepLow.price * 0.9985 : price * 0.995;

      // MFE-based fixed TP: 1% for HIGH signals, 2% for LOW
      tp1 = price * (1 + tpPct);
      tp2 = price * (1 + tpPct * 1.5); // extended target 50% further
    }

    // Use 5m entry FVG if available for tighter entry
    const entryZone = ltfEntry?.entryZone;
    const entryPrice = entryZone
      ? (direction === 'SHORT' ? entryZone.top : entryZone.bottom)
      : price;

    log(`[SMC-PRO] ${symbol} entry=${entryPrice.toFixed(2)} sl=${slPrice.toFixed(2)} tp1=${tp1?.toFixed(2)} tp2=${tp2?.toFixed(2)}`);

    // ── RR check (minimum 2:1) ────────────────────────────────
    if (!tp1 || !meetsMinRR(entryPrice, slPrice, tp1)) {
      const rr = tp1 ? calcRR(entryPrice, slPrice, tp1).toFixed(2) : 'N/A';
      log(`[SMC-PRO] ${symbol} → skip (RR=${rr} < ${MIN_RR}:1 minimum)`);
      return null;
    }

    const rr = parseFloat(calcRR(entryPrice, slPrice, tp1).toFixed(2));

    // ── Score ─────────────────────────────────────────────────
    const score = calcScore({
      fvg:          !!relevantFVG,
      ob:           !!relevantOB,
      bbFound:      !!relevantBB,
      unicorn:      unicorn.detected,
      ote:          inOTE,
      deepOTE:      inDeepOTE,
      killzone:     !!activeKZ,
      highValueKZ:  isHighValueKZ,
      dailyBias:    dailyBiasAligns,
      dailyPhase:   dailyCtx.phase,
      ltfEntry:     ltfEntry?.confirmed,
      displacement: hasDisplacement,
      idm:          idm.detected,
      smtDivergence:smt.detected,
      rr,
      choch1h:      choch1hOk,
      choch15m:     choch15mOk,
    });

    log(`[SMC-PRO] ${symbol} ✅ SIGNAL ${direction} score=${score} RR=${rr} killzone=${activeKZ?.name || 'off-session'}`);

    // ── Build signal ──────────────────────────────────────────
    // Profit-lock: slide SL to entry + 0.5× risk when price moves 0.5× risk in favour
    const risk = Math.abs(entryPrice - slPrice);
    const lockTrigger = direction === 'SHORT' ? entryPrice - risk * 0.5 : entryPrice + risk * 0.5;
    const lockSl      = direction === 'SHORT' ? entryPrice - risk       : entryPrice + risk;

    return {
      symbol,
      direction,
      side:          direction,
      signal:        direction === 'SHORT' ? 'SELL' : 'BUY',
      lastPrice:     price,
      entry:         entryPrice,
      sl:            slPrice,
      tp:            tp1,
      tp1,
      tp2:           tp2 || null,
      rr,
      lockTrigger,
      lockSl,
      setupName:     unicorn.detected ? 'SMC-UNICORN' : (relevantBB ? 'SMC-BREAKER' : relevantOB ? 'SMC-OB' : 'SMC-FVG'),
      score,
      timeframe:     '4H+1H+15m+5m',
      version:       'smc-pro-v2',
      zone:          direction === 'SHORT' ? 'PREMIUM' : 'DISCOUNT',
      smcContext: {
        bias4h, biasDaily,
        killzone:       activeKZ?.name || null,
        dailyPhase:     dailyCtx.phase,
        choch1h,
        choch15m:       choch15mRaw || null,
        ltfEntry:       ltfEntry    || null,
        fvg:            relevantFVG || null,
        ob:             relevantOB  || relevantBB || null,
        unicorn:        unicorn.detected ? unicorn : null,
        displacement:   hasDisplacement,
        idm:            idm.detected ? idm : null,
        smt:            smt.detected ? smt : null,
        drawOnLiq:      drawOnLiq   || null,
        pdLevels,
        fib:            { p50: fib.p500, p618: fib.p618, p786: fib.p786 },
        invalidation:   slPrice,
      },
    };

  } catch (err) {
    log(`[SMC-PRO] ${symbol} analysis error: ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// BACKTESTED PATTERN ENGINE — v3 (90-day optimized)
// HL/LL → LONG  |  LH/HH → SHORT
// 4H EMA trend filter + fib50 zone for NEUTRAL markets
// Token-specific SL & entry TF from 90-day backtest results
// XRP removed (49% WR — below breakeven after fees)
// ═══════════════════════════════════════════════════════════════

// ── CHoCH redirect state ─────────────────────────────────────────
// Persists across scanKeyLevelSignal calls. When 15m structure says X but 1m CHoCH
// says the opposite, we block X and wait for the opposite 15m structure to confirm.
// Key: symbol  Value: { redirectDir, blockedDir, blockedAt, expiresAt }
const _chochRedirectMap = new Map();

// ── Token trading config ─────────────────────────────────────────
// iv = entry timeframe interval (Bybit format)
// slPct = stop-loss % from pattern level (optimized per token)
// label = human-readable TF label
const TRADING_CONFIG = {
  BTCUSDT:  { iv:'15',  slPct:0.0025, label:'15M', name:'BTC'  },
  ETHUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'ETH'  },
  SOLUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'SOL'  },
  BNBUSDT:  { iv:'15',  slPct:0.0030, label:'15M', name:'BNB'  },
  ADAUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'ADA'  },
  DOTUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'DOT'  },
  LINKUSDT: { iv:'15',  slPct:0.0030, label:'15M', name:'LINK' },
  AVAXUSDT: { iv:'15',  slPct:0.0025, label:'15M', name:'AVAX' },
  LTCUSDT:  { iv:'15',  slPct:0.0025, label:'15M', name:'LTC'  },
  // XRP removed — 49% WR after fees, not profitable
  // All tokens: 15M primary + 1M LTF confirmation (follows BTC 15M+1M standard)
};

// ── TP / lock constants (same for all tokens) ────────────────────
const TP1_PCT   = 0.005;   // 0.5%  — close 50% of position at TP1
const TP2_PCT   = 0.010;   // 1.0%  — close remaining 50% at TP2
const LOCK_PCT  = 0.0025;  // +0.25% — slide SL to lock after TP1 hit
const PAT_TOL   = 0.002;   // 0.2% proximity to pattern level — tight so bot enters AT the LH/HL, not after price already moved away
const PAT_WINGS = 2;       // bars each side to confirm pivot — was 3 (45min lag), 2 = 30min on 15m
const PAT_LKBK  = 60;     // bars lookback for pivot detection
const PAT_CD    = 45 * 60_000;  // 45-min cooldown — was 2H, shortened so HL#1 + HL#2 both fire

// ── EMA periods for trend state (4H chart) ───────────────────────
const TREND_EMA_S = 20;
const TREND_EMA_M = 50;
const TREND_EMA_L = 200;

// ── EMA calculator ────────────────────────────────────────────────
function calcEMASeries(bars, period) {
  const k   = 2 / (period + 1);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += bars[i].c;
  out[period - 1] = seed / period;
  for (let i = period; i < bars.length; i++) {
    out[i] = bars[i].c * k + out[i - 1] * (1 - k);
  }
  return out;
}

// ── Trend state classifier (uses 4H bars) ────────────────────────
// Returns: 'UP' | 'DOWN' | 'NEUTRAL'
// UP:   full stack EMA20 > EMA50 > EMA200, OR recovery phase (EMA20 > EMA50 + price > EMA200)
// DOWN: full stack EMA20 < EMA50 < EMA200, OR distribution (EMA20 < EMA50 + price < EMA200)
// NEUTRAL: mixed signals — use fib50 to decide direction
//
// NOTE: EMA200 is slow (200 bars = 33 days on 4H). During recovery from a downtrend,
// EMA20 > EMA50 but EMA50 still < EMA200. If price has already crossed above EMA200,
// the trend has flipped bullish — classify as UP so LONGs can fire.
function classifyTrend(bars4h) {
  const eS = calcEMASeries(bars4h, TREND_EMA_S);
  const eM = calcEMASeries(bars4h, TREND_EMA_M);
  const eL = calcEMASeries(bars4h, TREND_EMA_L);
  const last  = bars4h.length - 1;
  const s = eS[last], m = eM[last], l = eL[last];
  if (s === null || m === null || l === null) return 'NEUTRAL';

  const price = bars4h[last].c;

  // Full bullish stack
  if (s > m && m > l) return 'UP';
  // Full bearish stack
  if (s < m && m < l) return 'DOWN';

  // Recovery phase: short+medium EMA stack bullish AND price already above slow EMA.
  // Guard: EMA50 must be within 5% of EMA200 — if EMA50 is still deeply below EMA200
  // (e.g. a brief bear-market relief rally), this is NOT a real recovery.
  if (s > m && price > l && m > l * 0.95) return 'UP';
  // Distribution phase: short+medium stack bearish AND price still below slow EMA.
  if (s < m && price < l && m < l * 1.05) return 'DOWN';

  return 'NEUTRAL';
}

// ── Trend filter (SMC premium/discount zones) ────────────────────
//
// Core SMC rule: trade WITH the trend MOST of the time.
// Exception: at EXTREME zones (premium/discount), fade the extension.
//
//   UP trend:
//     LONG  at discount (price ≤ fib50) — continuation pullback entry  ← best trade
//     LONG  at any level                — trend continuation always OK
//     SHORT at premium (price ≥ fib50) — fade the HH / premium zone    ← allowed
//     SHORT at discount                — BLOCKED (shorting into support)
//
//   DOWN trend:
//     SHORT at premium (price ≥ fib50) — continuation pullback entry   ← best trade
//     SHORT at any level               — trend continuation always OK
//     LONG  at discount (price ≤ fib50)— fade the LL / discount zone   ← allowed
//     LONG  at premium                 — BLOCKED (buying into resistance)
//
//   NEUTRAL: premium zone → SHORT, discount zone → LONG, midrange → skip
//
// This matches exactly what the 15m chart shows:
//   15m uptrend → HH at 2147 (premium) → SHORT valid ✓
//   15m uptrend → HL at 2120 (discount) → LONG valid ✓

// isTrendAligned(trend, dir, fibZones, price)
// fibZones = full object from calcFibZones (or null)
//
// OTE zone thresholds (tighter than 50%):
//   SHORT allowed only when price >= fib61.8 (top 38.2% of range = true premium)
//   LONG  allowed only when price <= fib38.2 (bottom 38.2% of range = true discount)
//
// Why 61.8% not 50%?
//   At the midpoint the market is neutral — no edge.
//   The HL pullback in an uptrend sits near the 50% line; shorting there
//   means shorting INTO structural support → low win rate, big drawdown.
//   Only above 61.8% (approaching HH) does a SHORT have a genuine edge.
//
// Example from chart: LL=2123, HH=2147, range=24
//   fib61.8 = 2123 + 24×0.618 = 2137.8
//   HL at 2137 < 2137.8 → SHORT blocked ✓ (it IS a LONG entry, not SHORT)
//   HH at 2147 > 2137.8 → SHORT allowed  ✓ (the premium fade)

function isTrendAligned(trend, dir, fibZones, price) {
  // Support old callers that pass fib50 as a number
  let fib618 = null, fib382 = null, fib50 = null;
  if (fibZones !== null && typeof fibZones === 'object' && !Array.isArray(fibZones) && fibZones.p618 !== undefined) {
    fib618 = fibZones.p618;   // 61.8% level from low = OTE premium line
    fib382 = fibZones.p382;   // 38.2% level from low = OTE discount line
    fib50  = fibZones.p500;
  } else if (typeof fibZones === 'number') {
    // Legacy: caller passed a plain fib50 number — fall back to 50% threshold
    fib50  = fibZones;
    fib618 = fibZones;
    fib382 = fibZones;
  }

  // TRUE premium: above the 61.8% Fibonacci level (approaching HH, top 38.2%)
  // TRUE discount: below the 38.2% Fibonacci level (approaching LL, bottom 38.2%)
  const inPremium  = fib618 !== null && price >= fib618;
  const inDiscount = fib382 !== null && price <= fib382;
  // Neutral zone fallback (for NEUTRAL trend when fibZones not available)
  const aboveMid   = fib50  !== null && price >= fib50;
  const belowMid   = fib50  !== null && price <= fib50;

  if (trend === 'UP') {
    if (dir === 'LONG')  return true;         // always LONG in uptrend
    if (dir === 'SHORT') return inPremium;    // SHORT only at HH (above 61.8%) — NOT at HL pullback
    return false;
  }

  if (trend === 'DOWN') {
    // SHORT only when price is in the UPPER half of the swing range (premium zone).
    // HL forms in the lower half (discount) — shorting there means entering at support;
    // price will bounce to LH first, stopping you out, then continue down.
    // LH forms in the upper half (premium) — that is the correct short entry.
    if (dir === 'SHORT') return aboveMid;     // SHORT only at/above 50% midline (LH zone)
    if (dir === 'LONG')  return inDiscount;   // LONG only at LL (below 38.2%) — NOT at LH bounce
    return false;
  }

  // NEUTRAL — OTE zones, fall back to midpoint if fib not available
  if (dir === 'LONG')  return fib382 !== null ? inDiscount : belowMid;
  if (dir === 'SHORT') return fib618 !== null ? inPremium  : aboveMid;
  return false;
}

// ── Pivot point helpers (for pattern detection) ──────────────────

// Symmetric pivot helpers — used by HTF scanner (15m/30m/1H)
// PAT_WINGS bars on BOTH sides required before confirming a pivot.
function _pivLows(bars) {
  const pts = [];
  for (let i = PAT_WINGS; i < bars.length - PAT_WINGS; i++) {
    const lo = bars[i].l; let ok = true;
    for (let j = 1; j <= PAT_WINGS; j++) {
      if (bars[i-j].l <= lo || bars[i+j].l <= lo) { ok = false; break; }
    }
    if (ok) pts.push({ price: lo, idx: i });
  }
  return pts;
}

function _pivHighs(bars) {
  const pts = [];
  for (let i = PAT_WINGS; i < bars.length - PAT_WINGS; i++) {
    const hi = bars[i].h; let ok = true;
    for (let j = 1; j <= PAT_WINGS; j++) {
      if (bars[i-j].h >= hi || bars[i+j].h >= hi) { ok = false; break; }
    }
    if (ok) pts.push({ price: hi, idx: i });
  }
  return pts;
}

// Asymmetric pivot helpers — matches TradingView "SMC Expo 10 1 2" indicator exactly.
// leftBars=1, rightBars=2: confirms pivot with only 1 bar to the left, 2 to the right.
// This is FASTER than symmetric detection — pivots appear 1-2 bars sooner.
// Used by scan1mPatterns so the bot sees the same BMS/CHoCH as the TV indicator.
function _pivLowsLR(bars, lBars, rBars) {
  const pts = [];
  for (let i = lBars; i < bars.length - rBars; i++) {
    const lo = bars[i].l; let ok = true;
    for (let j = 1; j <= lBars; j++) { if (bars[i-j].l <= lo) { ok = false; break; } }
    if (!ok) continue;
    for (let j = 1; j <= rBars; j++) { if (bars[i+j].l <= lo) { ok = false; break; } }
    if (ok) pts.push({ price: lo, idx: i });
  }
  return pts;
}

function _pivHighsLR(bars, lBars, rBars) {
  const pts = [];
  for (let i = lBars; i < bars.length - rBars; i++) {
    const hi = bars[i].h; let ok = true;
    for (let j = 1; j <= lBars; j++) { if (bars[i-j].h >= hi) { ok = false; break; } }
    if (!ok) continue;
    for (let j = 1; j <= rBars; j++) { if (bars[i+j].h >= hi) { ok = false; break; } }
    if (ok) pts.push({ price: hi, idx: i });
  }
  return pts;
}

// ── LTF confirmation (cascade: 1m → 3m → 15m pattern-only) ──────────
// HTF identifies the zone; LTF triggers the trade.
// Cascade: try 1m first, fall back to 3m, fall back to pattern-only (no block).
// recency controls how fresh the LTF pivot must be:
//   1m → recency=5 (last 5 bars = 5 min)
//   3m → recency=2 (last 2 bars  = 6 min)

const LTF_WINDOW       = 40;  // last N bars of LTF to scan for structure
const LTF_RECENCY_1M   = 5;   // 1m: pivot must be within 5 bars
const LTF_RECENCY_3M   = 2;   // 3m: pivot must be within 2 bars (~6 min)

// LONG LTF check: bars must show a recent HL with bullish rejection
function _confirmLongLTF(bars, recency) {
  if (!bars || bars.length < LTF_WINDOW) return false;
  const win  = bars.slice(-LTF_WINDOW);
  const lows = _pivLows(win);
  if (lows.length < 2) return false;
  const prev = lows[lows.length - 2];
  const curr = lows[lows.length - 1];
  if (curr.price <= prev.price) return false;  // must be higher low
  if (curr.idx + PAT_WINGS < win.length - recency) return false;  // must be fresh
  return _isBullishRejection(win[curr.idx]);
}

// SHORT LTF check: bars must show a recent LH with bearish rejection
function _confirmShortLTF(bars, recency) {
  if (!bars || bars.length < LTF_WINDOW) return false;
  const win   = bars.slice(-LTF_WINDOW);
  const highs = _pivHighs(win);
  if (highs.length < 2) return false;
  const prev = highs[highs.length - 2];
  const curr = highs[highs.length - 1];
  if (curr.price >= prev.price) return false;  // must be lower high
  if (curr.idx + PAT_WINGS < win.length - recency) return false;  // must be fresh
  return _isBearishRejection(win[curr.idx]);
}

// ── Big-wave quality helpers ──────────────────────────────────────
// Three filters that separate institutional moves from weak bounces:
//  1. Pivot bar REJECTION — did smart money step in with force?
//  2. Pivot bar VOLUME    — was there real participation?
//  3. Entry bar MOMENTUM  — is the move already starting right now?

// Median volume — resistant to single spike events that inflate the mean
// and chronically block low-volume tokens (DOT/ADA/AVAX) from ever firing.
function _avgVol(bars) {
  const sorted = bars.map(b => b.v).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// LONG rejection: pivot-low bar closes in the upper half of its range (bullish pin)
function _isBullishRejection(bar) {
  const range = bar.h - bar.l;
  if (range <= 0) return true;   // doji — neutral, don't block
  return (bar.c - bar.l) / range >= 0.45;
}

// SHORT rejection: pivot-high bar closes in the lower half of its range (bearish pin)
function _isBearishRejection(bar) {
  const range = bar.h - bar.l;
  if (range <= 0) return true;
  return (bar.c - bar.l) / range <= 0.55;
}

// ── Pattern detectors ─────────────────────────────────────────────
// Each returns signal object or null.
// window  = last PAT_LKBK bars
// curBar  = full current bar object (uses .c for close, .bullish for momentum)
// slPct   = token SL

function detectHL(window, curBar, slPct, ltfBars = null, ltfRecency = LTF_RECENCY_1M) {
  // Higher Low → LONG: uptrend making HL retest
  const cur  = curBar.c;
  const lows = _pivLows(window);
  if (lows.length < 2) return null;
  const prev = lows[lows.length - 2];
  const curr = lows[lows.length - 1];
  if (curr.price <= prev.price) return null;        // must be higher low
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  // Absolute distance — catches HL bounce at the level AND retest from above
  const dist = Math.abs(cur - curr.price) / curr.price;
  if (dist > PAT_TOL) return null;   // must be within 0.2% of HL level (either side)

  // ── Structural rally filter ────────────────────────────────
  // Between the previous low and this HL there must be a meaningful rally.
  // Prevents buying a sideways drift where two lows are close together
  // with no real bounce structure between them.
  const barsBetween = window.slice(prev.idx + 1, curr.idx);
  if (barsBetween.length < 3) return null;
  const highestBetween = Math.max(...barsBetween.map(b => b.h));
  const rallyPct       = (highestBetween - curr.price) / curr.price;
  if (rallyPct < slPct * 3) return null; // rally must be ≥ 3× SL to be structural

  // ── Big-wave quality gate ──────────────────────────────────
  const pivotBar = window[curr.idx];
  if (!_isBullishRejection(pivotBar)) return null;        // weak close at the low → likely to drop
  if (pivotBar.v < _avgVol(window) * 0.85) return null;  // low-volume bounce → not institutional
  if (!curBar.bullish) return null;                        // entry bar must be rising right now

  // ── LTF confirmation (cascade: 1m → 3m → pattern-only) ───────────
  // ltfBars=null means no LTF available — trust the 15m pattern alone (don't block)
  if (ltfBars && !_confirmLongLTF(ltfBars, ltfRecency)) return null;

  // Entry price: LTF bar close for precision; fall back to 15m close
  const entryHL = (ltfBars && ltfBars.length > 0) ? ltfBars[ltfBars.length - 1].c : cur;

  return {
    pattern:  'HL',
    dir:      'LONG',
    level:    curr.price,
    slPrice:  curr.price * (1 - slPct),
    tp1:      entryHL * (1 + TP1_PCT),
    tp2:      entryHL * (1 + TP2_PCT),
    lockAt:   entryHL * (1 + LOCK_PCT),
  };
}

function detectLL(window, curBar, slPct, ltfBars = null, ltfRecency = LTF_RECENCY_1M) {
  // Lower Low → LONG: discount zone bounce
  const cur  = curBar.c;
  const lows = _pivLows(window);
  if (lows.length < 2) return null;
  const prev = lows[lows.length - 2];
  const curr = lows[lows.length - 1];
  if (curr.price >= prev.price) return null;        // must be lower low
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  // Absolute distance — LL bounce entry must be close to the actual LL level
  const dist = Math.abs(cur - curr.price) / curr.price;
  if (dist > PAT_TOL) return null;

  // ── Structural rally filter ────────────────────────────────
  const barsBetween = window.slice(prev.idx + 1, curr.idx);
  if (barsBetween.length < 3) return null;
  const highestBetween = Math.max(...barsBetween.map(b => b.h));
  const rallyPct       = (highestBetween - curr.price) / curr.price;
  if (rallyPct < slPct * 3) return null;

  // ── Big-wave quality gate ──────────────────────────────────
  const pivotBar = window[curr.idx];
  if (!_isBullishRejection(pivotBar)) return null;
  if (pivotBar.v < _avgVol(window) * 0.85) return null;
  if (!curBar.bullish) return null;

  // ── LTF confirmation (cascade: 1m → 3m → pattern-only) ───────────
  if (ltfBars && !_confirmLongLTF(ltfBars, ltfRecency)) return null;

  const entryLL = (ltfBars && ltfBars.length > 0) ? ltfBars[ltfBars.length - 1].c : cur;

  return {
    pattern:  'LL',
    dir:      'LONG',
    level:    curr.price,
    slPrice:  curr.price * (1 - slPct),
    tp1:      entryLL * (1 + TP1_PCT),
    tp2:      entryLL * (1 + TP2_PCT),
    lockAt:   entryLL * (1 + LOCK_PCT),
  };
}

// SHORT proximity tolerance — LH/HH pivot must be within 0.5% of recent swing high.
// Prevents mid-range shorts: if the structural high was $2,157 and the LH pivot is
// at $2,143 (0.65% below), that's a mid-range entry — skip it. Only short at the top.
const SHORT_PROX_TOL = 0.005;

function detectLH(window, curBar, slPct, ltfBars = null, ltfRecency = LTF_RECENCY_1M) {
  // Lower High → SHORT: downtrend making LH retest
  const cur   = curBar.c;
  const highs = _pivHighs(window);
  if (highs.length < 2) return null;
  const prev = highs[highs.length - 2];
  const curr = highs[highs.length - 1];
  if (curr.price >= prev.price) return null;        // must be lower high
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  // Use absolute distance so we catch BOTH:
  //   a) price just broke below LH (direct entry)
  //   b) price retesting LH from below (approaching from underneath = correct SMC retest short)
  // Entering far below the LH = shorting near LL support = no room to fall.
  const dist = Math.abs(curr.price - cur) / curr.price;
  if (dist > PAT_TOL) return null;   // must be within 0.2% of LH level (either side)

  // ── Short-at-the-top filter ────────────────────────────────
  // LH pivot must be within 0.5% of the recent swing high.
  // Stops mid-range shorts where price already fell far from the structural high.
  const winHigh = Math.max(...window.slice(-36).map(b => b.h)); // matches 36-bar recency window
  if ((winHigh - curr.price) / winHigh > SHORT_PROX_TOL) return null;

  // ── Structural pullback filter ─────────────────────────────
  // Between the previous high and this LH there MUST be a meaningful pullback.
  // Without this check, detectLH fires on a tiny bounce immediately after a HH
  // (price just drifts sideways and any minor lower-high is called "LH").
  // A real LH requires:  prev HIGH → significant drop → bounce → LH retest.
  // Minimum pullback = 3× slPct so the structure is clearly formed.
  const barsBetween = window.slice(prev.idx + 1, curr.idx);
  if (barsBetween.length < 3) return null;  // at least 3 bars of structure required
  const lowestBetween = Math.min(...barsBetween.map(b => b.l));
  const pullbackPct   = (curr.price - lowestBetween) / curr.price;
  if (pullbackPct < slPct * 3) return null; // pullback must be ≥ 3× SL to be structural

  // ── Big-wave quality gate ──────────────────────────────────
  const pivotBar = window[curr.idx];
  if (!_isBearishRejection(pivotBar)) return null;
  if (pivotBar.v < _avgVol(window) * 0.85) return null;
  if (curBar.bullish) return null;                         // entry bar must be falling

  // ── HL escape hatch ────────────────────────────────────────
  // If the most recent confirmed low is a HIGHER LOW (HL) that formed AFTER
  // this LH pivot, the market already reversed upward — do NOT short.
  // Pattern: LL → HL (rising lows) after LH means buyers absorbed the sell.
  // The TV indicator shows "HL" on the right edge in exactly this scenario.
  const allLows = _pivLows(window);
  if (allLows.length >= 2) {
    const lastL = allLows[allLows.length - 1];
    const prevL = allLows[allLows.length - 2];
    if (lastL.price > prevL.price && lastL.idx > curr.idx) return null; // HL post-dates LH → skip
  }

  // ── LTF confirmation (cascade: 1m → 3m → pattern-only) ───────────
  if (ltfBars && !_confirmShortLTF(ltfBars, ltfRecency)) return null;

  const entryLH = (ltfBars && ltfBars.length > 0) ? ltfBars[ltfBars.length - 1].c : cur;

  return {
    pattern:  'LH',
    dir:      'SHORT',
    level:    curr.price,
    slPrice:  curr.price * (1 + slPct),
    tp1:      entryLH * (1 - TP1_PCT),
    tp2:      entryLH * (1 - TP2_PCT),
    lockAt:   entryLH * (1 - LOCK_PCT),
  };
}

function detectHH(window, curBar, slPct, ltfBars = null, ltfRecency = LTF_RECENCY_1M) {
  // Higher High → SHORT: premium zone fade
  const cur   = curBar.c;
  const highs = _pivHighs(window);
  if (highs.length < 2) return null;
  const prev = highs[highs.length - 2];
  const curr = highs[highs.length - 1];
  if (curr.price <= prev.price) return null;        // must be higher high
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  // Absolute distance — catches both direct breakdown and retest from below
  const dist = Math.abs(curr.price - cur) / curr.price;
  if (dist > PAT_TOL) return null;

  // ── Short-at-the-top filter ────────────────────────────────
  const winHigh = Math.max(...window.slice(-36).map(b => b.h)); // matches 36-bar recency window
  if ((winHigh - curr.price) / winHigh > SHORT_PROX_TOL) return null;

  // ── Structural pullback filter ─────────────────────────────
  // HH must have had a meaningful pullback from the previous high before pushing to new HH.
  // Prevents shorting a straight-up impulse move with no structure between the two highs.
  const barsBetween = window.slice(prev.idx + 1, curr.idx);
  if (barsBetween.length < 3) return null;
  const lowestBetween = Math.min(...barsBetween.map(b => b.l));
  const pullbackPct   = (curr.price - lowestBetween) / curr.price;
  if (pullbackPct < slPct * 3) return null;

  // ── Big-wave quality gate ──────────────────────────────────
  const pivotBar = window[curr.idx];
  if (!_isBearishRejection(pivotBar)) return null;
  if (pivotBar.v < _avgVol(window) * 0.85) return null;
  if (curBar.bullish) return null;

  // ── HL escape hatch ────────────────────────────────────────
  // If a higher low formed AFTER the HH pivot, buyers stepped in — don't short the HH fade.
  const allLowsHH = _pivLows(window);
  if (allLowsHH.length >= 2) {
    const lastL = allLowsHH[allLowsHH.length - 1];
    const prevL = allLowsHH[allLowsHH.length - 2];
    if (lastL.price > prevL.price && lastL.idx > curr.idx) return null;
  }

  // ── LTF confirmation (cascade: 1m → 3m → pattern-only) ───────────
  if (ltfBars && !_confirmShortLTF(ltfBars, ltfRecency)) return null;

  const entryHH = (ltfBars && ltfBars.length > 0) ? ltfBars[ltfBars.length - 1].c : cur;

  return {
    pattern:  'HH',
    dir:      'SHORT',
    level:    curr.price,
    slPrice:  curr.price * (1 + slPct),
    tp1:      entryHH * (1 - TP1_PCT),
    tp2:      entryHH * (1 - TP2_PCT),
    lockAt:   entryHH * (1 - LOCK_PCT),
  };
}

// ── Main pattern scanner ─────────────────────────────────────────
// Scans all 4 patterns on the current bar window.
// Returns first valid trend-aligned signal or null.
// cooldowns: Map<sym_pat → lastSignalTs> (passed in from caller to persist)

function scanPatterns(sym, patBars, bars4h, cooldowns = new Map(), bars1m = null, bars3m = null) {
  const cfg = TRADING_CONFIG[sym];
  if (!cfg) return null;                            // symbol not in config (XRP removed)

  const cur  = patBars[patBars.length - 1];
  const now  = cur.t;

  // ── LTF cascade: 1m preferred → 3m fallback → 15m pattern-only ──
  // If 1m data is available and thick enough, use it. Fall back to 3m if not.
  // If neither is available, ltfBars=null and detectors will not block the trade —
  // the 15m pattern structure alone is sufficient.
  let ltfBars    = null;
  let ltfRecency = LTF_RECENCY_1M;
  let ltfLabel   = '15m(no-ltf)';

  if (bars1m && bars1m.length >= LTF_WINDOW) {
    ltfBars    = bars1m;
    ltfRecency = LTF_RECENCY_1M;
    ltfLabel   = '1m';
  } else if (bars3m && bars3m.length >= LTF_WINDOW) {
    ltfBars    = bars3m;
    ltfRecency = LTF_RECENCY_3M;
    ltfLabel   = '3m';
  }

  // Entry price: LTF close for precision; fall back to 15m close when no LTF
  const price = ltfBars ? ltfBars[ltfBars.length - 1].c : cur.c;

  // Build pattern window
  if (patBars.length < PAT_LKBK + PAT_WINGS + 2) return null;
  const window = patBars.slice(-(PAT_LKBK + PAT_WINGS + 1));

  // Trend state from 4H EMA
  const trend = classifyTrend(bars4h);

  // Full OTE fib zones — used by isTrendAligned for 61.8/38.2% premium/discount gates
  let fib50    = null;
  let fibZones = null;
  try {
    const s4h = analyzeStructure(bars4h, 5, 3);
    const fz  = calcFibZones(s4h.swingHigh, s4h.swingLow);
    if (fz) { fibZones = fz; fib50 = fz.p500; }
  } catch (_) {}

  // Prioritise detectors by trend direction so the trend-aligned pattern
  // is always evaluated first. Trend filter blocks the opposite direction
  // anyway, but ordering ensures we don't waste cycles and always return
  // the best-aligned signal when both sides happen to pass pattern checks.
  //
  // DOWN or NEUTRAL-premium → LH/HH first (short bias)
  // UP   or NEUTRAL-discount → HL/LL first (long bias)
  const inPremium = fib50 !== null && price >= fib50;
  const shortFirst = trend === 'DOWN' || (trend === 'NEUTRAL' && inPremium);

  // Only HL (LONG) and LH (SHORT) — user rule: no LL bounce trades, no HH fade trades.
  const detectors = shortFirst
    ? [
        { key: 'LH', fn: detectLH },
        { key: 'HL', fn: detectHL },
      ]
    : [
        { key: 'HL', fn: detectHL },
        { key: 'LH', fn: detectLH },
      ];

  for (const { key, fn } of detectors) {
    const cdKey = `${sym}_${key}`;

    // Cooldown: skip if fired within 2H
    if (cooldowns.has(cdKey) && now - cooldowns.get(cdKey) < PAT_CD) continue;

    const sig = fn(window, cur, cfg.slPct, ltfBars, ltfRecency);
    if (!sig) continue;

    // Trend alignment filter — uses full fibZones (61.8/38.2% OTE gates)
    if (!isTrendAligned(trend, sig.dir, fibZones ?? fib50, price)) continue;

    // Update cooldown
    cooldowns.set(cdKey, now);

    return {
      symbol:   sym,
      name:     cfg.name,
      tf:       cfg.label,
      iv:       cfg.iv,
      pattern:  sig.pattern,
      dir:      sig.dir,
      side:     sig.dir === 'LONG' ? 'BUY' : 'SELL',
      price,
      level:    sig.level,
      sl:       sig.slPrice,
      tp1:      sig.tp1,
      tp2:      sig.tp2,
      lockAt:   sig.lockAt,
      slPct:    (cfg.slPct * 100).toFixed(2) + '%',
      tp1Pct:   (TP1_PCT  * 100).toFixed(2) + '%',
      tp2Pct:   (TP2_PCT  * 100).toFixed(2) + '%',
      trend,
      fib50,
      fib618:   fibZones?.p618 ?? null,  // OTE premium line — SHORT only above this
      fib382:   fibZones?.p382 ?? null,  // OTE discount line — LONG only below this
      ltfUsed:  ltfLabel,   // which LTF confirmed: '1m' | '3m' | '15m(no-ltf)'
      ts:       now,
      signal:   `${sig.pattern}(${sig.dir}) on ${cfg.label}+${ltfLabel} | trend=${trend} | entry=${price.toFixed(4)} sl=${sig.slPrice.toFixed(4)} tp1=${sig.tp1.toFixed(4)} tp2=${sig.tp2.toFixed(4)}`,
    };
  }

  return null;
}

// ── TP management helper ─────────────────────────────────────────
// Call on each new bar to check if TP1/TP2/SL/lock triggered.
// trade = object from scanPatterns signal
// bar   = { h, l } current bar
// Returns updated trade state.
function checkTradeState(trade, bar) {
  if (!trade || trade.closed) return trade;
  const { h, l } = bar;
  const dir = trade.dir;
  const state = { ...trade };

  if (!state.tp1Hit) {
    // Check TP1
    const tp1Hit = dir === 'LONG' ? h >= state.tp1 : l <= state.tp1;
    if (tp1Hit) {
      state.tp1Hit    = true;
      state.tp1HitTs  = bar.t;
      state.sl        = state.lockAt; // slide SL to lock level
    }
    // Check SL before TP1
    const slHit = dir === 'LONG' ? l <= state.sl : h >= state.sl;
    if (slHit && !tp1Hit) {
      state.closed    = true;
      state.exitReason = 'LOSS';
      state.exitPrice  = state.sl;
      return state;
    }
  } else {
    // TP1 already hit — runner active
    const tp2Hit = dir === 'LONG' ? h >= state.tp2 : l <= state.tp2;
    const lockHit = dir === 'LONG' ? l <= state.sl : h >= state.sl;
    if (tp2Hit) {
      state.closed    = true;
      state.exitReason = 'FULL_WIN';
      state.exitPrice  = state.tp2;
      return state;
    }
    if (lockHit) {
      state.closed    = true;
      state.exitReason = 'LOCK_WIN';
      state.exitPrice  = state.lockAt;
      return state;
    }
  }

  return state;
}

// CHoCH pattern detectors removed — do not re-add.
// CHoCH (BullCHoCH / BearCHoCH) was removed because it fires at breakout tops/bottoms,
// producing entries that look like "buying at the top." HL/LH structure is sufficient.

// ── SMC Expo indicator parameters (matches TradingView "SMC Expo 10 1 2 20") ──
// pivotLen=10: swing lookback — how many bars define a swing high/low
// lBars=1, rBars=2: asymmetric pivot confirmation (1 left, 2 right)
//   → confirms a pivot faster than symmetric detection (2+2)
//   → bot sees the same BMS/CHoCH labels at the same time as the TV indicator
// ema20: EMA(20) for the trend line shown on chart
const IND_PIVOT_LEN = 10;   // swing lookback (indicator "10")
const IND_L_BARS    = 1;    // left confirmation bars  (indicator "1")
const IND_R_BARS    = 2;    // right confirmation bars (indicator "2")
const IND_EMA_LEN   = 20;   // EMA period for trend line (indicator "20")
const CHOCH_LKBK    = 20;   // bars to check for LH/HL sequence before CHoCH fires
const CHOCH_TOL     = 0.003; // 0.3% max overshoot past broken level

// Pivot helpers using indicator's exact asymmetric parameters
function _ind1mHighs(bars) { return _pivHighsLR(bars, IND_L_BARS, IND_R_BARS); }
function _ind1mLows(bars)  { return _pivLowsLR(bars,  IND_L_BARS, IND_R_BARS); }


// ── 1m direct scanner (reference / unused) ───────────────────────
// Scans 1m bars for HL and LH patterns. Not called by any active agent — kept for reference.
// Active scanner is scanKeyLevelSignal (15m+1m structure).
//
// This is what the TradingView SMC indicator does:
//   BMS  = HL/LL/LH/HH structure breaks on 1m
//   CHoCH = trend reversal on 1m
//
// Uses separate cooldown keys (prefix '1m_') so 1m and 15m signals don't block each other.

// SCAN1M window = pivotLen(10) + rBars(2) + 1 slack = 13 bars minimum
// Using 25 bars gives the indicator enough history to see 2 swings
const SCAN1M_LKBK = 25;              // 25-bar window (= 25 min — matches indicator's 10-pivot lookback)
const SCAN1M_CD   = 10 * 60_000;    // 10-min cooldown for 1m signals

// 1m-specific LH/HL/HH/LL detectors using the indicator's asymmetric pivots.
// These wrap the existing detectors but override the internal pivot calls to use _ind1mHighs/_ind1mLows.
// We do this inline in scan1mPatterns below (see detector wrappers).

function scan1mPatterns(sym, bars1m, bars4h, cooldowns = new Map()) {
  const cfg = TRADING_CONFIG[sym];
  if (!cfg) return null;
  if (!bars1m || bars1m.length < SCAN1M_LKBK + IND_R_BARS + 2) return null;
  if (!bars4h  || bars4h.length < 50) return null;

  const cur   = bars1m[bars1m.length - 1];
  const now   = cur.t;
  const price = cur.c;

  // Build 1m window using indicator's pivot length
  const window = bars1m.slice(-(SCAN1M_LKBK + IND_R_BARS + 1));

  // 4H trend + full OTE fib zones (same filter as scanPatterns)
  const trend = classifyTrend(bars4h);
  let fib50    = null;
  let fibZones = null;
  try {
    const s4h = analyzeStructure(bars4h, 5, 3);
    const fz  = calcFibZones(s4h.swingHigh, s4h.swingLow);
    if (fz) { fibZones = fz; fib50 = fz.p500; }
  } catch (_) {}

  // Detector order: trend-aligned first
  // Use fib61.8 for premium detection (same as isTrendAligned threshold)
  const premiumLine = fibZones?.p618 ?? fib50;
  const inPremium   = premiumLine !== null && price >= premiumLine;
  const shortFirst  = trend === 'DOWN' || (trend === 'NEUTRAL' && inPremium);

  // ── 1m structure detectors using indicator's asymmetric pivots (1L/2R) ───
  // These detect LH/HL/HH/LL using _ind1mHighs/_ind1mLows instead of the HTF
  // symmetric pivot helpers — this matches what the TV indicator draws on chart.
  // No LTF confirmation needed (1m IS the primary TF here).
  function _1mLH(w, c, s) {
    const highs = _ind1mHighs(w);
    if (highs.length < 2) return null;
    const prev = highs[highs.length - 2];
    const curr = highs[highs.length - 1];
    if (curr.price >= prev.price) return null;
    if (curr.idx < w.length - 20) return null;
    const dist = Math.abs(curr.price - c.c) / curr.price;
    if (dist > PAT_TOL) return null;
    if (c.bullish) return null; // entry bar must be falling
    // HL escape hatch: if a higher low formed AFTER this LH, market reversed up — skip SHORT
    // (TV indicator shows "HL" at the right edge — bot must agree and NOT short there)
    const lows = _ind1mLows(w);
    if (lows.length >= 2) {
      const lastL = lows[lows.length - 1];
      const prevL = lows[lows.length - 2];
      if (lastL.price > prevL.price && lastL.idx > curr.idx) return null;
    }
    return { pattern:'LH', dir:'SHORT', level:curr.price, slPrice:curr.price*(1+s), tp1:c.c*(1-TP1_PCT), tp2:c.c*(1-TP2_PCT), lockAt:c.c*(1-LOCK_PCT) };
  }
  function _1mHL(w, c, s) {
    const lows = _ind1mLows(w);
    if (lows.length < 2) return null;
    const prev = lows[lows.length - 2];
    const curr = lows[lows.length - 1];
    if (curr.price <= prev.price) return null;
    if (curr.idx < w.length - 20) return null;
    const dist = Math.abs(c.c - curr.price) / curr.price;
    if (dist > PAT_TOL) return null;
    if (!c.bullish) return null; // entry bar must be rising
    return { pattern:'HL', dir:'LONG', level:curr.price, slPrice:curr.price*(1-s), tp1:c.c*(1+TP1_PCT), tp2:c.c*(1+TP2_PCT), lockAt:c.c*(1+LOCK_PCT) };
  }
  function _1mHH(w, c, s) {
    const highs = _ind1mHighs(w);
    if (highs.length < 2) return null;
    const prev = highs[highs.length - 2];
    const curr = highs[highs.length - 1];
    if (curr.price <= prev.price) return null;
    if (curr.idx < w.length - 20) return null;
    const dist = Math.abs(curr.price - c.c) / curr.price;
    if (dist > PAT_TOL) return null;
    if (c.bullish) return null;
    // HL escape hatch: if a higher low formed AFTER this HH, market reversed up — skip SHORT
    const lows = _ind1mLows(w);
    if (lows.length >= 2) {
      const lastL = lows[lows.length - 1];
      const prevL = lows[lows.length - 2];
      if (lastL.price > prevL.price && lastL.idx > curr.idx) return null;
    }
    return { pattern:'HH', dir:'SHORT', level:curr.price, slPrice:curr.price*(1+s), tp1:c.c*(1-TP1_PCT), tp2:c.c*(1-TP2_PCT), lockAt:c.c*(1-LOCK_PCT) };
  }
  function _1mLL(w, c, s) {
    const lows = _ind1mLows(w);
    if (lows.length < 2) return null;
    const prev = lows[lows.length - 2];
    const curr = lows[lows.length - 1];
    if (curr.price >= prev.price) return null;
    if (curr.idx < w.length - 20) return null;
    const dist = Math.abs(c.c - curr.price) / curr.price;
    if (dist > PAT_TOL) return null;
    if (!c.bullish) return null;
    return { pattern:'LL', dir:'LONG', level:curr.price, slPrice:curr.price*(1-s), tp1:c.c*(1+TP1_PCT), tp2:c.c*(1+TP2_PCT), lockAt:c.c*(1+LOCK_PCT) };
  }

  // ── Current structure gate: most recent confirmed pivot decides direction ──
  // The TV SMC indicator labels the MOST RECENT pivot (HL or LH) on the chart.
  // If the last confirmed pivot is an HL → only LONG signals are valid right now.
  // If the last confirmed pivot is an LH → only SHORT signals are valid right now.
  // This prevents the old shortFirst ordering from firing LH(SHORT) when the chart
  // clearly shows HL at the right edge — the root cause of "bot shorts at HL".
  let structureOnlyDir = null; // null = allow both directions (LL/HH/ambiguous)
  {
    const latestHighs = _ind1mHighs(window);
    const latestLows  = _ind1mLows(window);
    const lastH = latestHighs[latestHighs.length - 1];
    const lastL = latestLows[latestLows.length - 1];
    const prevH = latestHighs[latestHighs.length - 2];
    const prevL = latestLows[latestLows.length - 2];

    if (lastH && lastL) {
      if (lastL.idx > lastH.idx) {
        // Most recent confirmed pivot is a LOW
        if (prevL && lastL.price > prevL.price) {
          structureOnlyDir = 'LONG';  // HL confirmed → only LONG
        }
        // LL: no trade on 1m (LL removed from detectors) → null, no restriction needed
      } else {
        // Most recent confirmed pivot is a HIGH
        if (prevH && lastH.price < prevH.price) {
          structureOnlyDir = 'SHORT'; // LH confirmed → only SHORT
        }
        // HH: no trade on 1m (HH removed from detectors) → null, no restriction needed
      }
    }
  }

  // Only HL (LONG) and LH (SHORT):
  // 15min LH + 1min LH → SHORT on next candle
  // 15min HL + 1min HL → LONG on next candle
  const detectors = [
    { key: 'HL', fn: _1mHL },
    { key: 'LH', fn: _1mLH },
  ];

  for (const { key, fn } of detectors) {
    // Use '1m_' prefix so 1m cooldowns don't block 15m signals and vice versa
    const cdKey = `${sym}_1m_${key}`;
    if (cooldowns.has(cdKey) && now - cooldowns.get(cdKey) < SCAN1M_CD) continue;

    const sig = fn(window, cur, cfg.slPct);
    if (!sig) continue;

    // Structure gate: if most recent pivot is HL, block any SHORT; if LH, block any LONG.
    if (structureOnlyDir && sig.dir !== structureOnlyDir) {
      continue; // e.g. LH(SHORT) blocked when HL is the current confirmed structure
    }

    // Trend alignment — uses full OTE fibZones (61.8/38.2% gates)
    if (!isTrendAligned(trend, sig.dir, fibZones ?? fib50, price)) continue;

    cooldowns.set(cdKey, now);

    return {
      symbol:  sym,
      name:    cfg.name,
      tf:      '1m',           // primary TF is 1m
      iv:      '1',
      pattern: sig.pattern,
      dir:     sig.dir,
      side:    sig.dir === 'LONG' ? 'BUY' : 'SELL',
      price,
      level:   sig.level,
      sl:      sig.slPrice,
      tp1:     sig.tp1,
      tp2:     sig.tp2,
      lockAt:  sig.lockAt,
      slPct:   (cfg.slPct * 100).toFixed(2) + '%',
      tp1Pct:  (TP1_PCT  * 100).toFixed(2) + '%',
      tp2Pct:  (TP2_PCT  * 100).toFixed(2) + '%',
      trend,
      fib50,
      ltfUsed: '1m-primary',
      ts:      now,
      signal:  `${sig.pattern}(${sig.dir}) on 1m | trend=${trend} | entry=${price.toFixed(4)} sl=${sig.slPrice.toFixed(4)} tp1=${sig.tp1.toFixed(4)} tp2=${sig.tp2.toFixed(4)}`,
    };
  }

  return null;
}

// ── Exports ──────────────────────────────────────────────────

// ── scanKeyLevelSignal ────────────────────────────────────────────
//
// USER RULE:
//   15m pivot HIGH (HH or LH) + 1m pivot HIGH (HH or LH) → SHORT next candle
//   15m pivot LOW  (LL or HL) + 1m pivot LOW  (LL or HL) → LONG  next candle
//
// "HH or LH" simply means a confirmed swing HIGH on that timeframe.
// "LL or HL" simply means a confirmed swing LOW  on that timeframe.
// The type (HH vs LH, LL vs HL) does not matter — both are just "high pivot" or "low pivot".
//
// Both timeframes must agree on direction:
//   Both show a recent swing HIGH → sellers in control → SHORT
//   Both show a recent swing LOW  → buyers in control → LONG
//
// Cooldown keyed on 15m pivot bar timestamp — each new 15m pivot fires once.
// 1m pivot must be within last 30 bars (~30 min) to be considered fresh.
//
// Pivot detection (1L/2R — matches TV SMC Expo indicator):
//   HIGH: bars[i].h > bars[i-1].h AND bars[i].h > bars[i+1].h AND bars[i].h > bars[i+2].h
//   LOW : bars[i].l < bars[i-1].l AND bars[i].l < bars[i+1].l AND bars[i].l < bars[i+2].l

// ── Signal engine constants ───────────────────────────────────────────
const STRUCT_BARS_15M  = 16;        // structure context: HH (for LONG) or LL (for SHORT) can be up to 4 h old
const PIVOT_FRESH_BARS = 8;         // entry pivot freshness: HL (LONG) or LH (SHORT) must be ≤8 bars = 2 h old
const WINDOW_MS        = 2 * 60 * 60_000; // 1m pivot must form within 2 h of the 15m pivot bar open
const ENTRY_TOL        = 0.002;     // MUST equal slPct — entry must be within slPct% of the 1m HL/LH.
                                    // If ENTRY_TOL > slPct the SL would float above the structural HL when
                                    // entering at max drift, blowing out capital by 2× slPct × leverage.

// Pivot detection: 2L/2R — matches the TradingView SMC indicator "∨ 2" setting.
// A pivot HIGH at bar i requires bars[i-2], bars[i-1] both lower on the left
// AND bars[i+1], bars[i+2] both lower on the right.
// 1L/2R (old) fired on micro-bounces TV never labeled; 2L/2R matches TV exactly.
function _allPivots(bars) {
  if (!bars || bars.length < 6) return { ph: [], pl: [] };
  const ph = [], pl = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].h > bars[i-1].h && bars[i].h > bars[i-2].h &&
        bars[i].h > bars[i+1].h && bars[i].h > bars[i+2].h)
      ph.push({ idx: i, price: bars[i].h, barTs: bars[i].t });
    if (bars[i].l < bars[i-1].l && bars[i].l < bars[i-2].l &&
        bars[i].l < bars[i+1].l && bars[i].l < bars[i+2].l)
      pl.push({ idx: i, price: bars[i].l, barTs: bars[i].t });
  }
  return { ph, pl };
}

// _lastPivots kept for internal use (1m confirmation helpers still reference it)
function _lastPivots(bars) {
  const { ph, pl } = _allPivots(bars);
  const lastH = ph[ph.length - 1], prevH = ph[ph.length - 2];
  const lastL = pl[pl.length - 1], prevL = pl[pl.length - 2];
  const lh = (lastH && prevH && lastH.price < prevH.price)
    ? { price: lastH.price, idx: lastH.idx, barTs: lastH.barTs } : null;
  const hl = (lastL && prevL && lastL.price > prevL.price)
    ? { price: lastL.price, idx: lastL.idx, barTs: lastL.barTs } : null;
  return { lh, hl };
}

function _rawPivots(bars) {
  const { ph, pl } = _allPivots(bars);
  return {
    high: ph[ph.length - 1] ?? null,
    low:  pl[pl.length - 1] ?? null,
  };
}

// Converts _allPivots output to the { type, price, ts } format expected by detectCHoCH.
function _toPivotsForCHoCH(bars) {
  const { ph, pl } = _allPivots(bars);
  const out = [];
  for (const p of ph) out.push({ type: 'HIGH', price: p.price, ts: p.barTs, idx: p.idx });
  for (const p of pl) out.push({ type: 'LOW',  price: p.price, ts: p.barTs, idx: p.idx });
  return out.sort((a, b) => a.idx - b.idx);
}

// ── _detect15mStructure ───────────────────────────────────────────────
// Detects a complete 2-pivot trend structure on the 15m chart:
//
//   SHORT: LL → LH   (saw a Lower Low, then price bounced to a Lower High)
//     Wait for LL first. When LH confirms → SHORT setup ready.
//
//   LONG:  HH → HL   (saw a Higher High, then price pulled back to a Higher Low)
//     Wait for HH first. When HL confirms → LONG setup ready.
//
// Both pivots must be within STRUCT_BARS_15M bars (3 h) — no stale setups.
// Sideways market (no LL→LH or HH→HL sequence) → returns null → no trade.
// minBouncePct: pass 0 — 2L/2R pivot detection on 15m candles is the sole judge.
// The lowest candle in a 60-min window IS the HL; no artificial % filter on top.
function _detect15mStructure(ph15, pl15, bars15m, minBouncePct, slPct = 0.002) {
  if (ph15.length < 2 || pl15.length < 2) return null;
  if (!bars15m || bars15m.length < 6) return null;

  const bars15mLen = bars15m.length;

  // Use actual candle data for global extremes — catches spiky moves that aren't 2L/2R pivots.
  // This prevents treating a local LH as HH when an older HH candle exists in the window.
  const globalMaxH = Math.max(...bars15m.map(b => b.h));
  const globalMinL = Math.min(...bars15m.map(b => b.l));
  const EXTREME_TOL = 0.002; // 0.2% — candle must be within this of true extreme to count

  // Index of the bar containing the global minimum low (for LONG guard below)
  const globalMinIdx = bars15m.reduce(
    (minIdx, b, i) => b.l < bars15m[minIdx].l ? i : minIdx, 0
  );
  const globalMinAge = (bars15mLen - 1) - globalMinIdx;

  // ── SHORT: LL → LH ───────────────────────────────────────────────
  // Find the TRUE LL: pivot low nearest the global candle minimum.
  // Then find the most recent pivot HIGH after it that is a genuine LH
  // (below the global candle max — not the new HH).
  // llPivot must also be LOWER than the previous pivot low (genuine LL, not HL bounce).
  const llPivot = pl15.reduce((min, p) => p.price < min.price ? p : min, pl15[0]);
  const llAge   = (bars15mLen - 1) - llPivot.idx;

  if (llAge <= STRUCT_BARS_15M) {
    // llPivot must be lower than the pivot low before it (real LL, not a HL in uptrend)
    const prevLL = pl15.filter(p => p.barTs < llPivot.barTs).slice(-1)[0];
    if (prevLL && llPivot.price >= prevLL.price) return null; // HL masquerading as LL → no SHORT

    const lhCandidates = ph15.filter(p =>
      p.barTs > llPivot.barTs &&                        // LH formed AFTER the LL
      p.price < globalMaxH * (1 - EXTREME_TOL)          // NOT the global max → genuine LH
    );
    if (lhCandidates.length > 0) {
      const lh    = lhCandidates[lhCandidates.length - 1]; // most recent valid LH
      const lhAge = (bars15mLen - 1) - lh.idx;

      // After LH forms, no 15m bar should have closed ABOVE the LH (structure still intact)
      const barsAfterLH = bars15m.filter(b => b.t > lh.barTs);
      if (barsAfterLH.some(b => b.c > lh.price * (1 + EXTREME_TOL))) return null;

      // CHoCH guard: if the bounce from LL to LH broke above the last pivot high
      // that existed BEFORE the LL, a CHoCH (trend flip) happened in between.
      // LL + CHoCH + LH = ambiguous structure → user rule: reset, no trade.
      const highsBeforeLL = ph15.filter(p => p.barTs < llPivot.barTs);
      const prevHHprice   = highsBeforeLL.length > 0
        ? Math.max(...highsBeforeLL.map(p => p.price))
        : globalMaxH; // no prior high → use global max as guard level
      const barsInBounce  = bars15m.filter(b => b.t > llPivot.barTs && b.t < lh.barTs);
      const chochHappened = barsInBounce.some(b => b.h > prevHHprice);
      if (chochHappened) return null; // CHoCH between LL and LH → reset

      // Minimum bounce: LL→LH must span at least 2×slPct or the range is too tight
      // (a ranging market produces many micro LL→LH patterns that aren't real downtrends)
      const bouncePct = (lh.price - llPivot.price) / llPivot.price;
      if (bouncePct < slPct * 2) return null;

      if (lhAge <= PIVOT_FRESH_BARS) {
        return { dir: 'SHORT', pivot15: lh, preceding: llPivot, label: 'LL→LH' };
      }
    }
  }

  // ── LONG: HH → HL ────────────────────────────────────────────────
  // LONG rules (all must pass):
  //   1. No recent LL (globalMinAge > STRUCT_BARS_15M) — avoids bounce in downtrend
  //   2. hhPivot must be HIGHER than the previous pivot high (genuine HH, not a LH)
  //   3. HL must form AFTER the HH and be ABOVE the pivot low that preceded the HH
  //      (genuine HL — price respected the prior low)
  //   4. After HL forms, no 15m bar closed BELOW the HL (structure still intact)
  //   5. No LL break between HH and HL (bearish structure break)
  if (globalMinAge <= STRUCT_BARS_15M) return null; // recent LL → reversal bounce → no LONG

  const hhPivot  = ph15.reduce((max, p) => p.price > max.price ? p : max, ph15[0]);
  const hhAge    = (bars15mLen - 1) - hhPivot.idx;

  if (hhAge <= STRUCT_BARS_15M) {
    // Rule 2: hhPivot must be higher than the pivot high before it (real HH, not LH)
    const prevHH = ph15.filter(p => p.barTs < hhPivot.barTs).slice(-1)[0];
    if (prevHH && hhPivot.price <= prevHH.price) return null; // LH masquerading as HH → no LONG

    // Rule 3: HL must be above the pivot low that preceded the HH
    const prevHL = pl15.filter(p => p.barTs < hhPivot.barTs).slice(-1)[0];

    const hlCandidates = pl15.filter(p =>
      p.barTs > hhPivot.barTs &&                              // HL formed AFTER the HH
      p.price > globalMinL * (1 + EXTREME_TOL) &&            // NOT the global min → genuine HL
      (!prevHL || p.price > prevHL.price)                     // above the prior swing low (real HL)
    );
    if (hlCandidates.length > 0) {
      const hl    = hlCandidates[hlCandidates.length - 1]; // most recent valid HL
      const hlAge = (bars15mLen - 1) - hl.idx;

      // Rule 4: After HL formed, no 15m bar closed BELOW HL — structure must still be intact
      const barsAfterHL = bars15m.filter(b => b.t > hl.barTs);
      const structureBroken = barsAfterHL.some(b => b.c < hl.price * (1 - EXTREME_TOL));
      if (structureBroken) return null; // price already broke below HL → no LONG

      // Rule 5: Reject if a LL was made between HH and HL (bearish structure break)
      const lowestBetween = pl15
        .filter(p => p.barTs > hhPivot.barTs && p.barTs < hl.barTs)
        .reduce((min, p) => p.price < min ? p.price : min, Infinity);
      const noLLbreak = lowestBetween >= globalMinL * (1 + EXTREME_TOL);

      // Minimum pullback: HH→HL must span at least 2×slPct or the range is too tight
      const pullbackPct = (hhPivot.price - hl.price) / hhPivot.price;
      if (hlAge <= PIVOT_FRESH_BARS && noLLbreak && pullbackPct >= slPct * 2) {
        return { dir: 'LONG', pivot15: hl, preceding: hhPivot, label: 'HH→HL' };
      }
    }
  }

  return null; // sideways / incomplete structure → no trade
}

// ── _detect15mPivot ───────────────────────────────────────────────────
// Simplified single-pivot 15m detector — replaces the two-pivot sequence.
//
// Rule:
//   HH (Higher High) or HL (Higher Low) on 15m → LONG
//   LH (Lower High)  or LL (Lower Low)  on 15m → SHORT
//
// Picks the freshest pivot (HIGH or LOW) within PIVOT_FRESH_BARS.
// If both are equally fresh, prefers the LOW pivot (entry at support/resistance).
function _detect15mPivot(ph15, pl15, bars15mLen) {
  if (ph15.length < 2 || pl15.length < 2) return null;

  const lastHigh = ph15[ph15.length - 1];
  const prevHigh = ph15[ph15.length - 2];
  const lastLow  = pl15[pl15.length - 1];
  const prevLow  = pl15[pl15.length - 2];

  const highAge = (bars15mLen - 1) - lastHigh.idx;
  const lowAge  = (bars15mLen - 1) - lastLow.idx;

  const candidates = [];

  if (lowAge <= PIVOT_FRESH_BARS) {
    const isHL  = lastLow.price > prevLow.price;
    candidates.push({
      dir:     isHL ? 'LONG' : 'SHORT',
      pivot15: lastLow,
      label:   isHL ? 'HL' : 'LL',
      age:     lowAge,
    });
  }
  if (highAge <= PIVOT_FRESH_BARS) {
    const isHH  = lastHigh.price > prevHigh.price;
    candidates.push({
      dir:     isHH ? 'LONG' : 'SHORT',
      pivot15: lastHigh,
      label:   isHH ? 'HH' : 'LH',
      age:     highAge,
    });
  }

  if (candidates.length === 0) return null;
  // Fresher pivot wins; tie → prefer LOW (entry at support/resistance level)
  candidates.sort((a, b) => a.age !== b.age ? a.age - b.age : (a.label === 'HL' || a.label === 'LL' ? -1 : 1));
  return candidates[0];
}

function scanNearestPivotMatch(sym, bars15m, bars1m, bars4h, cooldowns, log = null) {
  return scanKeyLevelSignal(sym, bars15m, bars1m, bars4h, cooldowns, log);
}

// ── scanKeyLevelSignal — 3-step SMC rule ────────────────────────────
//
// STEP 1 — 15m pivot (direction filter):
//   HH or HL on 15m → LONG  (uptrend pivot, find 1m HL)
//   LH or LL on 15m → SHORT (downtrend pivot, find 1m LH)
//   Pivot must be within PIVOT_FRESH_BARS (2 h). Ranging/no-pivot → no trade.
//
// STEP 2 — 1m confirmation in WINDOW_MS window:
//   SHORT: find a 1m LH within WINDOW_MS of the 15m pivot bar.
//   LONG:  find a 1m HL within WINDOW_MS of the 15m pivot bar.
//   Outside that window → skip, wait for the next 15m candle.
//
// STEP 3 — Entry freshness:
//   The 1m confirmation pivot must be within last 30 bars (30 min) from NOW.
//   Prevents firing on a stale setup that matched hours ago.
function scanKeyLevelSignal(sym, bars15m, bars1m, bars4h, cooldowns, log = null) {
  const L = (msg) => log && log(`[SMC-STEP] ${sym}: ${msg}`);

  const cfg = TRADING_CONFIG[sym];
  if (!cfg) return null;
  if (!bars15m || bars15m.length < 6) return null;
  if (!bars1m  || bars1m.length  < 6) return null;

  const cur   = bars1m[bars1m.length - 1];
  const now   = cur.t;
  const price = cur.c;

  // ── STEP 1: 15m structure — two-pivot sequence (normal) or single pivot (redirect) ──
  //
  // Normal path:  LL→LH → SHORT  |  HH→HL → LONG  (requires both pivots in sequence)
  // Redirect path: when 1m CHoCH blocked the original signal, any single bullish pivot
  //   (HH or HL) resolves a LONG redirect; any single bearish pivot (LH or LL) resolves SHORT.
  //
  // This means:  LL→LH fires SHORT normally.
  //   If 1m CHoCH is BULLISH at that moment → SHORT blocked, redirect=LONG stored.
  //   Next scan sees HH or HL on 15m → redirect resolves → LONG entry (via 1m HL below).
  const { ph: ph15, pl: pl15 } = _allPivots(bars15m);
  const total1m = bars1m.length;

  let dir, pivot15, label;

  const activeRedirect = _chochRedirectMap.get(sym);
  if (activeRedirect) {
    if (now > activeRedirect.expiresAt) {
      // Redirect expired — fall back to normal two-pivot check
      _chochRedirectMap.delete(sym);
      L(`Step1 — CHoCH redirect expired, cleared`);
      const st = _detect15mStructure(ph15, pl15, bars15m, 0, cfg.slPct);
      if (!st) return null;
      ({ dir, pivot15, label } = st);
    } else {
      // Redirect active — wait for a single 15m pivot that matches the redirect direction.
      // SHORT redirect resolves on LH (lower high), LONG redirect resolves on HL (higher low).
      // The trade then fires on the 1m flip: LH or HH for SHORT, HL or LL for LONG (Step 2).
      const single = _detect15mPivot(ph15, pl15, bars15m.length);
      if (single && single.dir === activeRedirect.redirectDir) {
        _chochRedirectMap.delete(sym);
        L(`Step1 REDIRECT ALLOW ✓ — ${single.label} on 15m resolves redirect to ${activeRedirect.redirectDir}`);
        ({ dir, pivot15, label } = single);
      } else {
        const need = activeRedirect.redirectDir === 'SHORT' ? 'LH' : 'HL';
        L(`Step1 REDIRECT BLOCK — waiting for 15m ${need} to ${activeRedirect.redirectDir}`);
        return null;
      }
    }
  } else {
    // Normal path: require full two-pivot sequence
    const st = _detect15mStructure(ph15, pl15, bars15m, 0, cfg.slPct);
    if (!st) {
      const lastH = ph15.length ? ph15[ph15.length - 1] : null;
      const lastL = pl15.length ? pl15[pl15.length - 1] : null;
      const hAge  = lastH ? (bars15m.length - 1) - lastH.idx : -1;
      const lAge  = lastL ? (bars15m.length - 1) - lastL.idx : -1;
      L(`Step1 FAIL — no 15m structure. ph=${ph15.length}(age=${hAge}) pl=${pl15.length}(age=${lAge})`);
      return null;
    }
    ({ dir, pivot15, label } = st);
  }

  L(`Step1 PASS ✓ — ${label} dir=${dir} pivot15=${pivot15.price.toFixed(2)}`);

  // ── Step 1b: 4H trend gate ───────────────────────────────────────────
  let trend4h = 'NEUTRAL';
  try { trend4h = classifyTrend(bars4h ?? []); } catch (_) {}
  if (dir === 'LONG'  && trend4h === 'DOWN') { L(`Step1b FAIL — 4H DOWN, rejecting LONG`);  return null; }
  if (dir === 'SHORT' && trend4h === 'UP')   { L(`Step1b FAIL — 4H UP, rejecting SHORT`);   return null; }
  L(`Step1b PASS ✓ — 4H trend=${trend4h} allows ${dir}`);

  // ── Step 1c: 1m CHoCH conflict → store redirect ──────────────────────
  // Only the 1m CHoCH triggers a flip. 15m CHoCH is NOT checked here —
  // 15m structure is already the signal source, so checking 15m CHoCH
  // would double-filter the same timeframe.
  // If 15m structure says SHORT but 1m CHoCH is BULLISH → block SHORT, redirect LONG.
  // If 15m structure says LONG  but 1m CHoCH is BEARISH → block LONG,  redirect SHORT.
  if (!_chochRedirectMap.has(sym)) {
    const CHOCH_1M_RECENCY = 90 * 60_000; // 90 min

    const choch1m = detectCHoCH(bars1m, _toPivotsForCHoCH(bars1m), 90);

    const conflict1m = choch1m && now - choch1m.candleTs < CHOCH_1M_RECENCY &&
      ((dir === 'SHORT' && choch1m.direction === 'BULLISH') || (dir === 'LONG' && choch1m.direction === 'BEARISH'));

    if (conflict1m) {
      const redirectDir = dir === 'SHORT' ? 'LONG' : 'SHORT';
      _chochRedirectMap.set(sym, { redirectDir, blockedDir: dir, blockedAt: now, expiresAt: now + 4 * 60 * 60_000 });
      L(`Step1c BLOCKED — 1m CHoCH=${choch1m.direction} conflicts with ${dir} → redirect to ${redirectDir}`);
      return null;
    }
  }

  // ── STEP 2: Find 1m swing HIGH (LH or HH) for SHORT, swing LOW (HL or LL) for LONG ──
  // Accept any confirmed 1m pivot in the right direction — HH and LH both anchor a SHORT;
  // HL and LL both anchor a LONG. Pick the highest high (SHORT) or lowest low (LONG)
  // within WINDOW_MS of the 15m pivot bar to get the best structural level.
  const { ph: ph1, pl: pl1 } = _allPivots(bars1m);
  let pivot1m = null;

  if (dir === 'SHORT') {
    for (let i = ph1.length - 1; i >= 1; i--) {
      const diff = ph1[i].barTs - pivot15.barTs;
      if (diff < 0) break;
      if (diff > WINDOW_MS) continue;
      // Accept LH or HH — any 1m swing high is a valid SHORT anchor
      if (!pivot1m || ph1[i].price > pivot1m.price) pivot1m = ph1[i];
    }
  } else {
    for (let i = pl1.length - 1; i >= 1; i--) {
      const diff = pl1[i].barTs - pivot15.barTs;
      if (diff < 0) break;
      if (diff > WINDOW_MS) continue;
      // Accept HL or LL — any 1m swing low is a valid LONG anchor
      if (!pivot1m || pl1[i].price < pivot1m.price) pivot1m = pl1[i];
    }
  }
  if (!pivot1m) {
    L(`Step2 WAIT — no 1m swing ${dir === 'SHORT' ? 'HIGH' : 'LOW'} within window of 15m pivot`);
    return null;
  }
  L(`Step2 PASS ✓ — 1m swing ${dir === 'SHORT' ? 'HIGH' : 'LOW'} @ ${pivot1m.price.toFixed(2)}`);

  // ── STEP 2b: 1m pivot level must be close to 15m pivot ──────────────
  const LEVEL_TOL = cfg.slPct * 2;
  const levelDiff = Math.abs(pivot1m.price - pivot15.price) / pivot15.price;
  if (levelDiff > LEVEL_TOL) {
    L(`Step2b FAIL — 1m ${pivot1m.price.toFixed(2)} too far from 15m ${pivot15.price.toFixed(2)} (${(levelDiff*100).toFixed(2)}% > ${(LEVEL_TOL*100).toFixed(2)}%)`);
    return null;
  }

  // ── STEP 3: 1m pivot freshness from NOW (≤ 30 min) ──────────────────
  const bars1mNowAge = (total1m - 1) - pivot1m.idx;
  if (bars1mNowAge > 30) {
    L(`Step3 FAIL — 1m pivot is ${bars1mNowAge} bars old (max 30)`);
    return null;
  }
  L(`Step3 PASS ✓ — 1m pivot is ${bars1mNowAge} bars old`);

  // ── STEP 4: Chase filter — entry must be within ENTRY_TOL of the 1m pivot ──
  if (dir === 'LONG'  && price > pivot1m.price * (1 + ENTRY_TOL)) {
    L(`Step4 FAIL — price ${price.toFixed(2)} chased above HL ${pivot1m.price.toFixed(2)}`);
    return null;
  }
  if (dir === 'SHORT' && price < pivot1m.price * (1 - ENTRY_TOL)) {
    L(`Step4 FAIL — price ${price.toFixed(2)} chased below LH ${pivot1m.price.toFixed(2)}`);
    return null;
  }

  // ── Cooldown: each 15m pivot bar fires at most once ──────────────────
  const cdKey = `${sym}_KL`;
  const SYMBOL_CD = 60 * 60_000;
  if (cooldowns.has(cdKey) && now - cooldowns.get(cdKey) < SYMBOL_CD) return null;
  cooldowns.set(cdKey, now);

  const sl   = dir === 'LONG' ? pivot1m.price * (1 - cfg.slPct) : pivot1m.price * (1 + cfg.slPct);
  const tp1  = dir === 'LONG' ? price * (1 + TP1_PCT)           : price * (1 - TP1_PCT);
  const tp2  = dir === 'LONG' ? price * (1 + TP2_PCT)           : price * (1 - TP2_PCT);
  const lock = dir === 'LONG' ? price * (1 + LOCK_PCT)          : price * (1 - LOCK_PCT);

  let trend = 'UNKNOWN';
  try { trend = classifyTrend(bars4h ?? []); } catch (_) {}

  const pattern15 = label; // HH | HL | LH | LL

  return {
    symbol:   sym,
    name:     cfg.name,
    tf:       '15m+1m',
    iv:       cfg.iv,
    pattern:  pattern15,
    pattern15,
    dir,
    side:     dir === 'LONG' ? 'BUY' : 'SELL',
    price,
    level:    pivot1m.price,
    keyLevel: pivot15.price,
    sl, tp1, tp2,
    lockAt:   lock,
    slPct:    (cfg.slPct * 100).toFixed(2) + '%',
    tp1Pct:   (TP1_PCT  * 100).toFixed(2) + '%',
    tp2Pct:   (TP2_PCT  * 100).toFixed(2) + '%',
    trend,
    pivot15m: pivot15.price,
    pivot1m:  pivot1m.price,
    ltfUsed:  '1m',
    ts:       now,
    signal:   `${label}@${pivot15.price.toFixed(4)} + 1m_${dir === 'SHORT' ? 'LH' : 'HL'}@${pivot1m.price.toFixed(4)} entry=${price.toFixed(4)} sl=${sl.toFixed(4)}`,
  };
}

module.exports = {
  // ── Existing ICT pipeline exports (unchanged) ────────────────
  fetchCandles,
  detectPivots,
  analyzeStructure,
  detectCHoCH,
  detectDisplacement,
  detectFVGs,
  detectOrderBlocks,
  detectInducement,
  detectLiquidityPools,
  getPDLevels,
  getActiveKillzone,
  calcFibZones,
  detectSMTDivergence,
  getDailyBias,
  detectLTFEntry,
  detectUnicorn,
  calcRR,
  meetsMinRR,
  analyzeSMC,
  MIN_RR,
  KILLZONES_UTC,

  // ── Pattern engine exports (v3 backtested) ────────────────────
  TRADING_CONFIG,   // token list with TF + SL settings (no XRP)
  TP1_PCT,
  TP2_PCT,
  LOCK_PCT,
  classifyTrend,    // 4H EMA trend state
  isTrendAligned,   // asymmetric trend filter
  detectHL,
  detectLL,
  detectLH,
  detectHH,
  IND_PIVOT_LEN,    // indicator pivot length (10)
  IND_L_BARS,       // indicator left bars  (1)
  IND_R_BARS,       // indicator right bars (2)
  IND_EMA_LEN,      // indicator EMA period (20)
  scanPatterns,           // HTF scanner (15m/30m/1H primary TF) — kept for reference
  scan1mPatterns,         // 1m primary scanner — kept for reference
  scanNearestPivotMatch,  // alias → scanKeyLevelSignal
  scanKeyLevelSignal,     // key level engine: dominant 15m HIGH/LOW + 1m confirmation
  checkTradeState,        // TP/SL/lock manager — call per bar on open trade
};
