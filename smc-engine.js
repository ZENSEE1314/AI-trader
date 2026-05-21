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

// ── Token trading config ─────────────────────────────────────────
// iv = entry timeframe interval (Bybit format)
// slPct = stop-loss % from pattern level (optimized per token)
// label = human-readable TF label
const TRADING_CONFIG = {
  BTCUSDT:  { iv:'15',  slPct:0.0025, label:'15M', name:'BTC'  },
  ETHUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'ETH'  },
  SOLUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'SOL'  },
  BNBUSDT:  { iv:'60',  slPct:0.0030, label:'1H',  name:'BNB'  },
  ADAUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'ADA'  },
  DOTUSDT:  { iv:'15',  slPct:0.0020, label:'15M', name:'DOT'  },
  LINKUSDT: { iv:'60',  slPct:0.0030, label:'1H',  name:'LINK' },
  AVAXUSDT: { iv:'30',  slPct:0.0025, label:'30M', name:'AVAX' },
  LTCUSDT:  { iv:'30',  slPct:0.0025, label:'30M', name:'LTC'  },
  // XRP removed — 49% WR after fees, not profitable
};

// ── TP / lock constants (same for all tokens) ────────────────────
const TP1_PCT   = 0.005;   // 0.5%  — close 50% of position at TP1
const TP2_PCT   = 0.010;   // 1.0%  — close remaining 50% at TP2
const LOCK_PCT  = 0.0025;  // +0.25% — slide SL to lock after TP1 hit
const PAT_TOL   = 0.015;   // 1.5% retest tolerance — was 0.5%, too tight for crypto momentum
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

// ── Trend filter (asymmetric — SHORT allowed in all trends) ──────
// LONG:  UP trend, or NEUTRAL when price is in discount (below fib50)
//        BLOCKED in DOWN trend — never buy into a confirmed downtrend
// SHORT: DOWN trend (always), NEUTRAL or UP when price is at premium (above fib50)
//        NOT blocked in UP trend — LH/HH at premium are valid fades even in uptrends
// This asymmetry reflects SMC: the market can make LH retests during bull runs.
function isTrendAligned(trend, dir, fib50, price) {
  if (dir === 'LONG') {
    if (trend === 'UP') return true;
    // NEUTRAL: only allow LONG in discount zone
    if (trend === 'NEUTRAL' && fib50 !== null && price <= fib50) return true;
    return false; // block LONG in DOWN trend
  }

  // SHORT — allowed in all trend states, but must be at premium in UP/NEUTRAL
  if (trend === 'DOWN') return true;
  // NEUTRAL or UP: only allow SHORT from premium zone (price above fib50)
  if (fib50 !== null && price >= fib50) return true;
  return false; // price is in discount — no short from here
}

// ── Pivot point helpers (for pattern detection) ──────────────────
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

// ── 1m LTF confirmation ───────────────────────────────────────────
// Requires the 1m chart to ALSO be making an HL/LH before HTF signal fires.
// This is the SMC "LTF entry" rule: HTF identifies the zone, LTF triggers the trade.
// PAT_WINGS=2 on 1m means pivot confirms in just 2 minutes.

const LTF_1M_WINDOW  = 40;   // look at last 40 1m bars (= 40 min) for LTF structure
const LTF_1M_RECENCY = 20;   // 1m pivot must be within last 20 bars (= 20 min)

// LONG LTF check: 1m must show a recent Higher Low with bullish rejection
function _confirm1mHL(bars1m) {
  if (!bars1m || bars1m.length < LTF_1M_WINDOW) return false; // no data → block, not skip
  const win  = bars1m.slice(-LTF_1M_WINDOW);
  const lows = _pivLows(win);
  if (lows.length < 2) return false;
  const prev = lows[lows.length - 2];
  const curr = lows[lows.length - 1];
  if (curr.price <= prev.price) return false;  // must be higher low on 1m
  // Recency: pivot confirmation bar (curr.idx + PAT_WINGS) must be within last LTF_1M_RECENCY bars
  if (curr.idx + PAT_WINGS < win.length - LTF_1M_RECENCY) return false;
  return _isBullishRejection(win[curr.idx]);   // bullish pin on 1m pivot bar
}

// SHORT LTF check: 1m must show a recent Lower High with bearish rejection
function _confirm1mLH(bars1m) {
  if (!bars1m || bars1m.length < LTF_1M_WINDOW) return false; // no data → block
  const win   = bars1m.slice(-LTF_1M_WINDOW);
  const highs = _pivHighs(win);
  if (highs.length < 2) return false;
  const prev = highs[highs.length - 2];
  const curr = highs[highs.length - 1];
  if (curr.price >= prev.price) return false;
  if (curr.idx + PAT_WINGS < win.length - LTF_1M_RECENCY) return false;
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

function detectHL(window, curBar, slPct, bars1m = null) {
  // Higher Low → LONG: uptrend making HL retest
  const cur  = curBar.c;
  const lows = _pivLows(window);
  if (lows.length < 2) return null;
  const prev = lows[lows.length - 2];
  const curr = lows[lows.length - 1];
  if (curr.price <= prev.price) return null;        // must be higher low
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  const above = (cur - curr.price) / curr.price;
  if (above < 0 || above > PAT_TOL) return null;   // price must be just above level

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

  // ── 1m LTF confirmation ────────────────────────────────────
  // 15m HL identified the zone — 1m HL must confirm the entry
  if (!_confirm1mHL(bars1m)) return null;

  return {
    pattern:  'HL',
    dir:      'LONG',
    level:    curr.price,
    slPrice:  curr.price * (1 - slPct),
    tp1:      cur * (1 + TP1_PCT),
    tp2:      cur * (1 + TP2_PCT),
    lockAt:   cur * (1 + LOCK_PCT),
  };
}

function detectLL(window, curBar, slPct, bars1m = null) {
  // Lower Low → LONG: discount zone bounce
  const cur  = curBar.c;
  const lows = _pivLows(window);
  if (lows.length < 2) return null;
  const prev = lows[lows.length - 2];
  const curr = lows[lows.length - 1];
  if (curr.price >= prev.price) return null;        // must be lower low
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  const above = (cur - curr.price) / curr.price;
  if (above < 0 || above > PAT_TOL) return null;

  // ── Structural rally filter ────────────────────────────────
  // Between the previous low and this LL there must be a meaningful bounce
  // so the LL has real structure — not just price grinding sideways lower.
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

  // ── 1m LTF confirmation ────────────────────────────────────
  if (!_confirm1mHL(bars1m)) return null;

  return {
    pattern:  'LL',
    dir:      'LONG',
    level:    curr.price,
    slPrice:  curr.price * (1 - slPct),
    tp1:      cur * (1 + TP1_PCT),
    tp2:      cur * (1 + TP2_PCT),
    lockAt:   cur * (1 + LOCK_PCT),
  };
}

// SHORT proximity tolerance — LH/HH pivot must be within 0.5% of recent swing high.
// Prevents mid-range shorts: if the structural high was $2,157 and the LH pivot is
// at $2,143 (0.65% below), that's a mid-range entry — skip it. Only short at the top.
const SHORT_PROX_TOL = 0.005;

function detectLH(window, curBar, slPct, bars1m = null) {
  // Lower High → SHORT: downtrend making LH retest
  const cur   = curBar.c;
  const highs = _pivHighs(window);
  if (highs.length < 2) return null;
  const prev = highs[highs.length - 2];
  const curr = highs[highs.length - 1];
  if (curr.price >= prev.price) return null;        // must be lower high
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  const below = (curr.price - cur) / curr.price;
  if (below < 0 || below > PAT_TOL) return null;   // price must be just below level

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

  // ── 1m LTF confirmation ────────────────────────────────────
  if (!_confirm1mLH(bars1m)) return null;

  return {
    pattern:  'LH',
    dir:      'SHORT',
    level:    curr.price,
    slPrice:  curr.price * (1 + slPct),
    tp1:      cur * (1 - TP1_PCT),
    tp2:      cur * (1 - TP2_PCT),
    lockAt:   cur * (1 - LOCK_PCT),
  };
}

function detectHH(window, curBar, slPct, bars1m = null) {
  // Higher High → SHORT: premium zone fade
  const cur   = curBar.c;
  const highs = _pivHighs(window);
  if (highs.length < 2) return null;
  const prev = highs[highs.length - 2];
  const curr = highs[highs.length - 1];
  if (curr.price <= prev.price) return null;        // must be higher high
  if (curr.idx < window.length - 36) return null;  // must be within last 36 bars
  const below = (curr.price - cur) / curr.price;
  if (below < 0 || below > PAT_TOL) return null;

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

  // ── 1m LTF confirmation ────────────────────────────────────
  if (!_confirm1mLH(bars1m)) return null;

  return {
    pattern:  'HH',
    dir:      'SHORT',
    level:    curr.price,
    slPrice:  curr.price * (1 + slPct),
    tp1:      cur * (1 - TP1_PCT),
    tp2:      cur * (1 - TP2_PCT),
    lockAt:   cur * (1 - LOCK_PCT),
  };
}

// ── Main pattern scanner ─────────────────────────────────────────
// Scans all 4 patterns on the current bar window.
// Returns first valid trend-aligned signal or null.
// cooldowns: Map<sym_pat → lastSignalTs> (passed in from caller to persist)

function scanPatterns(sym, patBars, bars4h, cooldowns = new Map(), bars1m = null) {
  const cfg = TRADING_CONFIG[sym];
  if (!cfg) return null;                            // symbol not in config (XRP removed)

  const cur  = patBars[patBars.length - 1];
  const now  = cur.t;
  const price = cur.c;

  // Build pattern window
  if (patBars.length < PAT_LKBK + PAT_WINGS + 2) return null;
  const window = patBars.slice(-(PAT_LKBK + PAT_WINGS + 1));

  // Trend state from 4H EMA
  const trend = classifyTrend(bars4h);

  // Fib50 for NEUTRAL zone decisions
  let fib50 = null;
  try {
    const s4h = analyzeStructure(bars4h, 5, 3);
    const fz  = calcFibZones(s4h.swingHigh, s4h.swingLow);
    if (fz) fib50 = fz.p500;
  } catch (_) {}

  // Prioritise detectors by trend direction so the trend-aligned pattern
  // is always evaluated first.  If both an HL and an LH pass all their
  // individual checks, we want the one that matches the trend to win —
  // not whichever happened to be first in a hard-coded list.
  //
  // DOWN trend or NEUTRAL-premium: LH/HH first (short bias)
  // UP   trend or NEUTRAL-discount: HL/LL first (long bias)
  const inPremium = fib50 !== null && price >= fib50;
  const shortFirst = trend === 'DOWN' || (trend === 'NEUTRAL' && inPremium)
                     || (trend === 'UP' && inPremium);  // asymmetric: UP still lets short from premium

  const detectors = shortFirst
    ? [
        { key: 'LH', fn: detectLH },
        { key: 'HH', fn: detectHH },
        { key: 'HL', fn: detectHL },
        { key: 'LL', fn: detectLL },
      ]
    : [
        { key: 'HL', fn: detectHL },
        { key: 'LL', fn: detectLL },
        { key: 'LH', fn: detectLH },
        { key: 'HH', fn: detectHH },
      ];

  for (const { key, fn } of detectors) {
    const cdKey = `${sym}_${key}`;

    // Cooldown: skip if fired within 2H
    if (cooldowns.has(cdKey) && now - cooldowns.get(cdKey) < PAT_CD) continue;

    const sig = fn(window, cur, cfg.slPct, bars1m);  // bars1m = 1m LTF confirmation
    if (!sig) continue;

    // Trend alignment filter
    if (!isTrendAligned(trend, sig.dir, fib50, price)) continue;

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
      ts:       now,
      signal:   `${sig.pattern}(${sig.dir}) on ${cfg.label} | trend=${trend} | entry=${price.toFixed(4)} sl=${sig.slPrice.toFixed(4)} tp1=${sig.tp1.toFixed(4)} tp2=${sig.tp2.toFixed(4)}`,
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

// ── Exports ──────────────────────────────────────────────────

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
  scanPatterns,     // main scanner — call per symbol per bar
  checkTradeState,  // TP/SL/lock manager — call per bar on open trade
};
