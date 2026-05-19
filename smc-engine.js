// ============================================================
// smc-engine.js — Pure SMC analysis library
//
// Implements the full Smart Money Concepts framework:
//   Step 1  — Market structure on higher timeframe (4H bias)
//   Step 2  — External highs/lows (swing pivots)
//   Step 3  — Change of Character (CHoCH) confirmation
//   Step 4  — Premium / Discount + Fibonacci OTE (61.8–78.6%)
//   Step 5  — Fair Value Gaps (FVGs) as areas of interest
//   Step 6  — Pre-planned targets (liquidity pools)
//   Step 7  — Lower-timeframe (15m / 5m) CHoCH for execution
//   Step 8  — Entry + SL at invalidation + 3:1 RR check
//
// Reference: https://dailypriceaction.com/blog/smc-trading-strategy/
// Data source: Bybit v5 linear klines (same as strategy-v4-smc.js)
// ============================================================

'use strict';

const fetch = require('node-fetch');

const BYBIT_KLINE    = 'https://api.bybit.com/v5/market/kline';
const FETCH_TIMEOUT  = 10_000;
const MIN_RR         = 3.0;    // minimum risk-to-reward ratio (guide: 3:1)
const FVG_LOOKBACK   = 60;     // bars to scan for FVGs
const OB_LOOKBACK    = 40;     // bars to scan for Order Blocks

// ── Candle fetching ──────────────────────────────────────────

async function fetchCandles(symbol, interval, limit) {
  const url = `${BYBIT_KLINE}?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { timeout: FETCH_TIMEOUT });
  if (!res.ok) throw new Error(`Bybit kline ${res.status} for ${symbol} ${interval}`);
  const data = await res.json();
  const raw  = data?.result?.list || [];
  // Bybit returns newest-first — reverse so index 0 = oldest
  return raw.reverse().map(r => ({
    t:       parseInt(r[0]),
    o:       parseFloat(r[1]),
    h:       parseFloat(r[2]),
    l:       parseFloat(r[3]),
    c:       parseFloat(r[4]),
    v:       parseFloat(r[5]),
    bullish: parseFloat(r[4]) >= parseFloat(r[1]),
  }));
}

// ── Pivot detection ──────────────────────────────────────────
// Returns array of { idx, type:'HIGH'|'LOW', price, ts }
// sorted oldest→newest, excluding the live (unconfirmed) bar.

function detectPivots(candles, lbL, lbR) {
  const pivots = [];
  const end    = candles.length - lbR - 1;  // exclude live bar + confirmation bars
  for (let i = lbL; i <= end; i++) {
    const c = candles[i];
    const leftSlice  = candles.slice(i - lbL, i);
    const rightSlice = candles.slice(i + 1, i + lbR + 1);

    if (leftSlice.every(x => x.h <= c.h) && rightSlice.every(x => x.h <= c.h)) {
      pivots.push({ idx: i, type: 'HIGH', price: c.h, ts: c.t });
    }
    if (leftSlice.every(x => x.l >= c.l) && rightSlice.every(x => x.l >= c.l)) {
      pivots.push({ idx: i, type: 'LOW',  price: c.l, ts: c.t });
    }
  }
  return pivots.sort((a, b) => a.idx - b.idx);
}

// ── Step 1 + 2: Market structure + directional bias ──────────
// Returns { bias:'BULLISH'|'BEARISH'|'RANGING', swingHigh, swingLow,
//           lastHighs, lastLows, pivots }

function analyzeStructure(candles, lbL = 10, lbR = 3) {
  const pivots   = detectPivots(candles, lbL, lbR);
  const highs    = pivots.filter(p => p.type === 'HIGH');
  const lows     = pivots.filter(p => p.type === 'LOW');

  const lastHighs = highs.slice(-4);
  const lastLows  = lows.slice(-4);
  const swingHigh = highs[highs.length - 1] || null;
  const swingLow  = lows[lows.length - 1]   || null;

  let bias = 'RANGING';
  if (lastHighs.length >= 2 && lastLows.length >= 2) {
    const hh = lastHighs[lastHighs.length - 1].price > lastHighs[lastHighs.length - 2].price;
    const hl = lastLows[lastLows.length   - 1].price > lastLows[lastLows.length   - 2].price;
    const lh = lastHighs[lastHighs.length - 1].price < lastHighs[lastHighs.length - 2].price;
    const ll = lastLows[lastLows.length   - 1].price < lastLows[lastLows.length   - 2].price;
    if (hh && hl) bias = 'BULLISH';
    if (lh && ll) bias = 'BEARISH';
  }

  return { bias, pivots, lastHighs, lastLows, swingHigh, swingLow };
}

// ── Step 3: Change of Character (CHoCH) ──────────────────────
// CHoCH: a real candle close breaks the most recent swing in the
//        opposite direction — strongest SMC confirmation signal.
// Returns { direction:'BULLISH'|'BEARISH', level, candleTs, type:'CHoCH' } or null.

function detectCHoCH(candles, pivots, lookbackBars = 30) {
  if (!pivots || pivots.length < 2) return null;

  const highs   = pivots.filter(p => p.type === 'HIGH');
  const lows    = pivots.filter(p => p.type === 'LOW');
  const lastHigh = highs[highs.length - 1];
  const lastLow  = lows[lows.length  - 1];

  const recent = candles.slice(-lookbackBars);
  // Scan newest→oldest so we return the MOST RECENT CHoCH
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    // Bearish CHoCH: close BELOW the last swing low (momentum flip downward)
    if (lastLow && c.c < lastLow.price && c.t >= lastLow.ts) {
      return { direction: 'BEARISH', level: lastLow.price, candleTs: c.t, type: 'CHoCH' };
    }
    // Bullish CHoCH: close ABOVE the last swing high (momentum flip upward)
    if (lastHigh && c.c > lastHigh.price && c.t >= lastHigh.ts) {
      return { direction: 'BULLISH', level: lastHigh.price, candleTs: c.t, type: 'CHoCH' };
    }
  }
  return null;
}

// Also detects Break of Structure (BOS) — same direction continuation
function detectBOS(candles, pivots, direction, lookbackBars = 20) {
  if (!pivots || !direction) return null;

  const recent = candles.slice(-lookbackBars);
  if (direction === 'LONG') {
    const highs  = pivots.filter(p => p.type === 'HIGH');
    const target = highs[highs.length - 2]; // second-to-last high (first = just broke)
    if (!target) return null;
    const broke = recent.some(c => c.c > target.price);
    return broke ? { direction: 'BULLISH', level: target.price, type: 'BOS' } : null;
  } else {
    const lows   = pivots.filter(p => p.type === 'LOW');
    const target = lows[lows.length - 2];
    if (!target) return null;
    const broke = recent.some(c => c.c < target.price);
    return broke ? { direction: 'BEARISH', level: target.price, type: 'BOS' } : null;
  }
}

// ── Step 4: Fibonacci Premium / Discount + OTE ───────────────
// OTE = Optimal Trade Entry = 61.8% – 78.6% retracement
// Premium zone (>50%) = short entry area in downtrend
// Discount zone (<50%) = long entry area in uptrend

function calcFibZones(swingHigh, swingLow) {
  if (!swingHigh || !swingLow) return null;
  const high  = swingHigh.price;
  const low   = swingLow.price;
  const range = high - low;
  if (range <= 0) return null;

  return {
    p100:  high,
    p786:  high - range * 0.214,  // 78.6% retrace (OTE ceiling)
    p705:  high - range * 0.295,  // 70.5% retrace
    p618:  high - range * 0.382,  // 61.8% retrace (OTE floor)
    p500:  high - range * 0.500,  // 50% — premium/discount boundary
    p382:  high - range * 0.618,
    p236:  high - range * 0.764,
    p0:    low,

    // Zone checks (pass current price)
    isPremium:     (price) => price >  high - range * 0.500,
    isDiscount:    (price) => price <  high - range * 0.500,
    isOTEShort:    (price) => price >= high - range * 0.382 && price <= high,        // 61.8–100% = premium + OTE
    isOTELong:     (price) => price >= low  && price <= high - range * 0.382,        // 0–61.8% = discount + OTE
    isSweetSpot:   (price) => price >= high - range * 0.214 && price <= high - range * 0.382, // 61.8–78.6% OTE sweet spot
  };
}

// ── Step 5: Fair Value Gaps (FVGs) ───────────────────────────
// FVG = 3-candle imbalance where middle candle's move leaves a
// gap between candle[i-1] and candle[i+1].
//
// Bearish FVG: candle[i+1].high < candle[i-1].low  (price dropped fast)
// Bullish FVG: candle[i+1].low  > candle[i-1].high (price rose fast)

function detectFVGs(candles, lookback = FVG_LOOKBACK) {
  const fvgs   = [];
  const start  = Math.max(1, candles.length - lookback);
  const lastC  = candles[candles.length - 1];
  if (!lastC) return fvgs;

  for (let i = start; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: gap between prev.high and next.low
    if (next.l > prev.h) {
      const top    = next.l;
      const bottom = prev.h;
      const mid    = (top + bottom) / 2;
      // FVG is "filled" if price has returned to its midpoint
      const filled = lastC.l <= mid;
      if (!filled) {
        fvgs.push({ type: 'BULLISH', top, bottom, mid, ts: curr.t, idx: i, size: top - bottom });
      }
    }

    // Bearish FVG: gap between next.high and prev.low
    if (next.h < prev.l) {
      const top    = prev.l;
      const bottom = next.h;
      const mid    = (top + bottom) / 2;
      const filled = lastC.h >= mid;
      if (!filled) {
        fvgs.push({ type: 'BEARISH', top, bottom, mid, ts: curr.t, idx: i, size: top - bottom });
      }
    }
  }

  // Return most recent first
  return fvgs.sort((a, b) => b.idx - a.idx);
}

// ── Order Blocks (OBs) ────────────────────────────────────────
// OB = the last opposing candle just before a strong impulse that
// broke market structure. Price often returns to the OB zone.
//
// Bearish OB: last bullish candle before a strong bearish BOS move
// Bullish OB: last bearish candle before a strong bullish BOS move

function detectOrderBlocks(candles, pivots, lookback = OB_LOOKBACK) {
  const obs   = [];
  const start = Math.max(5, candles.length - lookback);
  const highs = (pivots || []).filter(p => p.type === 'HIGH');
  const lows  = (pivots || []).filter(p => p.type === 'LOW');

  // For each confirmed swing high — the bearish OB is the last bullish
  // candle before the move that created that high
  for (const pivot of highs.slice(-3)) {
    // Find the impulse move that CREATED this swing high (look back 10 bars before pivot)
    const beforeIdx = Math.max(0, pivot.idx - 10);
    const segment   = candles.slice(beforeIdx, pivot.idx + 1);
    // Walk backward to find the last bearish candle in the segment
    for (let j = segment.length - 1; j >= 0; j--) {
      if (!segment[j].bullish) {
        obs.push({
          type:   'BEARISH_OB',
          top:    segment[j].h,
          bottom: segment[j].l,
          mid:    (segment[j].h + segment[j].l) / 2,
          ts:     segment[j].t,
          pivot,
        });
        break;
      }
    }
  }

  // For each confirmed swing low — the bullish OB is the last bearish
  // candle before the move that created that low
  for (const pivot of lows.slice(-3)) {
    const beforeIdx = Math.max(0, pivot.idx - 10);
    const segment   = candles.slice(beforeIdx, pivot.idx + 1);
    for (let j = segment.length - 1; j >= 0; j--) {
      if (segment[j].bullish) {
        obs.push({
          type:   'BULLISH_OB',
          top:    segment[j].h,
          bottom: segment[j].l,
          mid:    (segment[j].h + segment[j].l) / 2,
          ts:     segment[j].t,
          pivot,
        });
        break;
      }
    }
  }

  // Deduplicate OBs that are within 0.05% of each other
  const deduped = [];
  for (const ob of obs) {
    const dup = deduped.some(x => Math.abs(x.mid - ob.mid) / ob.mid < 0.0005);
    if (!dup) deduped.push(ob);
  }
  return deduped;
}

// ── Liquidity pools ───────────────────────────────────────────
// Equal highs/lows = stacked orders → price targets these.
// Returns { type:'EQUAL_HIGHS'|'EQUAL_LOWS', level, count }

function detectLiquidityPools(candles, pivots, tolerance = 0.0015) {
  const pools = [];
  const highs = (pivots || []).filter(p => p.type === 'HIGH').slice(-8);
  const lows  = (pivots || []).filter(p => p.type === 'LOW').slice(-8);

  // Group highs within tolerance
  const grouped = (arr, type) => {
    const used = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (used.has(i)) continue;
      const cluster = [arr[i]];
      for (let j = i + 1; j < arr.length; j++) {
        if (Math.abs(arr[i].price - arr[j].price) / arr[i].price < tolerance) {
          cluster.push(arr[j]);
          used.add(j);
        }
      }
      if (cluster.length >= 2) {
        pools.push({
          type:  type === 'HIGH' ? 'EQUAL_HIGHS' : 'EQUAL_LOWS',
          level: cluster.reduce((s, x) => s + x.price, 0) / cluster.length,
          count: cluster.length,
        });
      }
    }
  };

  grouped(highs, 'HIGH');
  grouped(lows,  'LOW');
  return pools;
}

// ── Step 7: Lower-TF CHoCH for execution ─────────────────────
// Specifically checks for:
//   SHORT: a Lower High on the LTF followed by a close below the most recent low
//   LONG:  a Higher Low on the LTF followed by a close above the most recent high

function detectLTFEntry(candles5m, direction, lookback = 40) {
  if (!candles5m || candles5m.length < 10) return null;
  const recent = candles5m.slice(-lookback);

  if (direction === 'SHORT') {
    // Find: pivot high → pivot low → higher pivot (LH) → close below the pivot low (CHoCH short)
    let foundLH = null;
    let foundPivotLow = null;

    for (let i = 5; i < recent.length - 1; i++) {
      const c = recent[i];
      // Detect a local high (simple 3-bar check)
      const isLocalHigh = c.h > recent[i - 1].h && c.h > recent[i - 2].h &&
                          c.h > recent[i + 1]?.h;
      if (isLocalHigh) {
        // Check if this is a Lower High vs the prior local high
        const priorHighs = recent.slice(0, i).filter((x, xi, arr) =>
          xi > 0 && x.h > arr[xi - 1].h && x.h > (arr[xi + 1]?.h || 0)
        );
        const priorHigh = priorHighs[priorHighs.length - 1];
        if (priorHigh && c.h < priorHigh.h) {
          foundLH = { price: c.h, idx: i };
          // Now find the most recent pivot low before this LH
          const lows = recent.slice(0, i).filter((x, xi, arr) =>
            xi > 0 && x.l < arr[xi - 1].l && x.l < (arr[xi + 1]?.l || Infinity)
          );
          foundPivotLow = lows[lows.length - 1];
        }
      }
    }

    if (foundLH && foundPivotLow) {
      // Check if a recent candle closed below the pivot low (CHoCH)
      const afterLH = recent.slice(foundLH.idx + 1);
      const bos     = afterLH.find(c => c.c < foundPivotLow.l);
      if (bos) {
        return {
          confirmed:   true,
          direction:   'SHORT',
          lhPrice:     foundLH.price,
          bosLevel:    foundPivotLow.l,
          entryCandle: bos,
          type:        '5m-CHoCH-SHORT',
        };
      }
    }
  }

  if (direction === 'LONG') {
    let foundHL = null;
    let foundPivotHigh = null;

    for (let i = 5; i < recent.length - 1; i++) {
      const c = recent[i];
      const isLocalLow = c.l < recent[i - 1].l && c.l < recent[i - 2].l &&
                         c.l < recent[i + 1]?.l;
      if (isLocalLow) {
        const priorLows = recent.slice(0, i).filter((x, xi, arr) =>
          xi > 0 && x.l < arr[xi - 1].l && x.l < (arr[xi + 1]?.l || Infinity)
        );
        const priorLow = priorLows[priorLows.length - 1];
        if (priorLow && c.l > priorLow.l) {
          foundHL = { price: c.l, idx: i };
          const highs = recent.slice(0, i).filter((x, xi, arr) =>
            xi > 0 && x.h > arr[xi - 1].h && x.h > (arr[xi + 1]?.h || 0)
          );
          foundPivotHigh = highs[highs.length - 1];
        }
      }
    }

    if (foundHL && foundPivotHigh) {
      const afterHL = recent.slice(foundHL.idx + 1);
      const bos     = afterHL.find(c => c.c > foundPivotHigh.h);
      if (bos) {
        return {
          confirmed:   true,
          direction:   'LONG',
          hlPrice:     foundHL.price,
          bosLevel:    foundPivotHigh.h,
          entryCandle: bos,
          type:        '5m-CHoCH-LONG',
        };
      }
    }
  }

  return null;
}

// ── Step 8: RR validation ─────────────────────────────────────

function calcRR(entry, sl, tp) {
  const risk   = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return 0;
  return reward / risk;
}

function meetsMinRR(entry, sl, tp) {
  return calcRR(entry, sl, tp) >= MIN_RR;
}

// ── Full SMC analysis for one symbol ─────────────────────────
// Returns a trade signal object or null.

async function analyzeSMC(symbol, log = console.log) {
  try {
    // ── Fetch all timeframes in parallel ──────────────────────
    const [c4h, c1h, c15m, c5m] = await Promise.all([
      fetchCandles(symbol, '240', 120),   // 4H  — 120 bars ≈ 20 days
      fetchCandles(symbol, '60',  120),   // 1H  — 120 bars ≈ 5 days
      fetchCandles(symbol, '15',  120),   // 15m — 120 bars ≈ 30 hours
      fetchCandles(symbol, '5',   80),    // 5m  — 80 bars  ≈ 7 hours
    ]);

    const price = c5m[c5m.length - 1]?.c;
    if (!price) return null;

    // ── Step 1+2: 4H structure — establish directional bias ───
    const s4h = analyzeStructure(c4h, 5, 3);
    log(`[SMC] ${symbol} 4H bias=${s4h.bias} swingH=${s4h.swingHigh?.price?.toFixed(2)} swingL=${s4h.swingLow?.price?.toFixed(2)}`);

    if (s4h.bias === 'RANGING') {
      log(`[SMC] ${symbol} → skip (4H=RANGING, no clear bias)`);
      return null;
    }

    const direction = s4h.bias === 'BULLISH' ? 'LONG' : 'SHORT';

    // ── Step 3: 1H CHoCH — confirm direction shift ────────────
    const s1h   = analyzeStructure(c1h, 8, 2);
    const choch = detectCHoCH(c1h, s1h.pivots, 40);

    // Require 1H CHoCH in our favour
    const chochOk = choch &&
      ((direction === 'LONG'  && choch.direction === 'BULLISH') ||
       (direction === 'SHORT' && choch.direction === 'BEARISH'));

    if (!chochOk) {
      log(`[SMC] ${symbol} → skip (no 1H CHoCH in ${direction} direction, got ${choch?.direction || 'none'})`);
      return null;
    }
    log(`[SMC] ${symbol} 1H CHoCH ${choch.direction} confirmed @ ${choch.level?.toFixed(2)}`);

    // ── Step 4: Fibonacci Premium / Discount + OTE ────────────
    // Use 4H swing high and swing low for the Fibonacci
    const fib = calcFibZones(s4h.swingHigh, s4h.swingLow);
    if (!fib) {
      log(`[SMC] ${symbol} → skip (cannot compute Fibonacci — missing swing)`);
      return null;
    }

    const inPremium  = fib.isPremium(price);
    const inDiscount = fib.isDiscount(price);
    const inOTEShort = fib.isOTEShort(price);
    const inOTELong  = fib.isOTELong(price);

    if (direction === 'SHORT' && !inPremium) {
      log(`[SMC] ${symbol} SHORT → skip (price=${price.toFixed(2)} not in PREMIUM zone, 50%=${fib.p500.toFixed(2)})`);
      return null;
    }
    if (direction === 'LONG' && !inDiscount) {
      log(`[SMC] ${symbol} LONG → skip (price=${price.toFixed(2)} not in DISCOUNT zone, 50%=${fib.p500.toFixed(2)})`);
      return null;
    }

    log(`[SMC] ${symbol} ${direction} price=${price.toFixed(2)} zone=${direction === 'SHORT' ? 'PREMIUM' : 'DISCOUNT'} OTE_ok=${direction === 'SHORT' ? inOTEShort : inOTELong}`);

    // ── Step 5: FVGs — area of interest ──────────────────────
    // Look for an unfilled FVG on 1H that price is currently trading inside
    const fvgs1h  = detectFVGs(c1h, FVG_LOOKBACK);
    const fvgs15m = detectFVGs(c15m, FVG_LOOKBACK);

    const relevantFVG = (direction === 'SHORT')
      ? [...fvgs1h, ...fvgs15m].find(f => f.type === 'BEARISH' && price <= f.top && price >= f.bottom - f.size * 0.5)
      : [...fvgs1h, ...fvgs15m].find(f => f.type === 'BULLISH' && price >= f.bottom && price <= f.top + f.size * 0.5);

    // Also check for Order Blocks
    const obs     = detectOrderBlocks(c1h, s1h.pivots, OB_LOOKBACK);
    const obType  = direction === 'SHORT' ? 'BEARISH_OB' : 'BULLISH_OB';
    const relevantOB = obs.find(ob =>
      ob.type === obType && price <= ob.top + ob.size * 0.2 && price >= ob.bottom - ob.size * 0.2
    );

    const hasConfluence = !!(relevantFVG || relevantOB);
    log(`[SMC] ${symbol} FVG=${relevantFVG ? `${relevantFVG.type}[${relevantFVG.bottom.toFixed(2)}-${relevantFVG.top.toFixed(2)}]` : 'none'} OB=${relevantOB ? `${relevantOB.type}[${relevantOB.bottom.toFixed(2)}-${relevantOB.top.toFixed(2)}]` : 'none'}`);

    // Require at least FVG or OB for confluence (can trade without if OTE is sweet spot)
    const inSweetSpot = fib.isSweetSpot(price);
    if (!hasConfluence && !inSweetSpot) {
      log(`[SMC] ${symbol} → skip (no FVG/OB confluence and not in OTE sweet spot 61.8–78.6%)`);
      return null;
    }

    // ── Step 6: Pre-plan targets ──────────────────────────────
    // TP1 = next structural level (swing high for shorts, swing low for longs)
    // TP2 = equal highs/lows (liquidity pool)
    const liqPools = detectLiquidityPools(c1h, s1h.pivots);
    let tp1, tp2, slPrice, invalidationLevel;

    if (direction === 'SHORT') {
      // SL above the most recent swing high (invalidation level)
      const recentHigh = s4h.lastHighs[s4h.lastHighs.length - 1];
      invalidationLevel = recentHigh?.price || s4h.swingHigh?.price;
      slPrice = invalidationLevel ? invalidationLevel * 1.002 : price * 1.004; // 0.2% above invalidation

      // TP1 = most recent swing low
      const recentLow = s4h.lastLows[s4h.lastLows.length - 1];
      tp1 = recentLow?.price || fib.p0;

      // TP2 = nearest equal-lows liquidity pool below price
      const liqBelow = liqPools
        .filter(p => p.type === 'EQUAL_LOWS' && p.level < price)
        .sort((a, b) => b.level - a.level)[0];
      tp2 = liqBelow?.level || (tp1 - Math.abs(price - tp1) * 0.5);
    } else {
      // SL below the most recent swing low (invalidation)
      const recentLow = s4h.lastLows[s4h.lastLows.length - 1];
      invalidationLevel = recentLow?.price || s4h.swingLow?.price;
      slPrice = invalidationLevel ? invalidationLevel * 0.998 : price * 0.996;

      // TP1 = most recent swing high
      const recentHigh = s4h.lastHighs[s4h.lastHighs.length - 1];
      tp1 = recentHigh?.price || fib.p100;

      // TP2 = nearest equal-highs liquidity pool above price
      const liqAbove = liqPools
        .filter(p => p.type === 'EQUAL_HIGHS' && p.level > price)
        .sort((a, b) => a.level - b.level)[0];
      tp2 = liqAbove?.level || (tp1 + Math.abs(tp1 - price) * 0.5);
    }

    log(`[SMC] ${symbol} ${direction} entry~${price.toFixed(2)} sl=${slPrice.toFixed(2)} tp1=${tp1?.toFixed(2)} tp2=${tp2?.toFixed(2)}`);

    // ── Step 7: 15m/5m CHoCH — execution confirmation ─────────
    const s15m = analyzeStructure(c15m, 6, 2);
    const ltfEntry = detectLTFEntry(c5m, direction, 60);

    if (!ltfEntry?.confirmed) {
      // Fallback: accept 15m CHoCH if 5m data is not yet confirmed
      const choch15m = detectCHoCH(c15m, s15m.pivots, 20);
      const choch15mOk = choch15m &&
        ((direction === 'SHORT' && choch15m.direction === 'BEARISH') ||
         (direction === 'LONG'  && choch15m.direction === 'BULLISH'));
      if (!choch15mOk) {
        log(`[SMC] ${symbol} → skip (no 15m/5m CHoCH entry confirmation for ${direction})`);
        return null;
      }
      log(`[SMC] ${symbol} 15m CHoCH ${choch15m.direction} confirmed (5m pending)`);
    } else {
      log(`[SMC] ${symbol} 5m CHoCH ${ltfEntry.direction} confirmed — LH/HL → BOS`);
    }

    // ── Step 8: RR check — minimum 3:1 ───────────────────────
    if (!tp1 || !meetsMinRR(price, slPrice, tp1)) {
      const rr = tp1 ? calcRR(price, slPrice, tp1).toFixed(2) : 'N/A';
      log(`[SMC] ${symbol} → skip (RR=${rr} < 3:1 minimum)`);
      return null;
    }

    const rr = calcRR(price, slPrice, tp1);
    log(`[SMC] ${symbol} ✅ SIGNAL ${direction} entry=${price.toFixed(2)} sl=${slPrice.toFixed(2)} tp1=${tp1.toFixed(2)} RR=${rr.toFixed(2)} — FVG=${!!relevantFVG} OB=${!!relevantOB} CHoCH=OK`);

    // ── Build signal object (matches strategy-v4-smc.js format) ─
    return {
      symbol,
      direction,
      side:      direction,
      signal:    direction === 'SHORT' ? 'SELL' : 'BUY',
      lastPrice: price,
      entry:     price,
      sl:        slPrice,
      tp:        tp1,
      tp1,
      tp2:       tp2 || null,
      rr:        parseFloat(rr.toFixed(2)),

      // Profit-lock params (compatible with trail-tiers.js)
      lockTrigger: direction === 'SHORT' ? price - (price - slPrice) * 0.5 : price + (slPrice - price) * 0.5,
      lockSl:      direction === 'SHORT' ? price - (price - slPrice) * 1.0 : price + (slPrice - price) * 1.0,

      // Context
      setupName:   `SMC-PRO-${direction}`,
      score:       _calcScore({ hasConfluence, inSweetSpot, inOTEShort, inOTELong, direction, rr, ltfEntry }),
      timeframe:   '4H+1H+15m+5m',
      version:     'smc-pro-v1',
      zone:        direction === 'SHORT' ? 'PREMIUM' : 'DISCOUNT',

      // SMC-specific metadata
      smcContext: {
        bias4h:    s4h.bias,
        choch1h:   choch,
        fvg:       relevantFVG || null,
        ob:        relevantOB  || null,
        fib:       { p50: fib.p500, p618: fib.p618, p786: fib.p786 },
        liqPools,
        ltfEntry:  ltfEntry || null,
        invalidation: invalidationLevel,
      },
    };
  } catch (err) {
    log(`[SMC] ${symbol} analysis error: ${err.message}`);
    return null;
  }
}

// Score 0–100 based on confluence quality
function _calcScore({ hasConfluence, inSweetSpot, inOTEShort, inOTELong, direction, rr, ltfEntry }) {
  let score = 40; // base: 4H bias + 1H CHoCH + 15m CHoCH all confirmed
  if (hasConfluence)                                  score += 20; // FVG or OB present
  if (inSweetSpot)                                    score += 10; // OTE sweet spot (61.8–78.6%)
  if ((direction === 'SHORT' && inOTEShort) ||
      (direction === 'LONG'  && inOTELong))           score += 5;
  if (ltfEntry?.confirmed)                            score += 15; // 5m CHoCH confirmed
  if (rr >= 5)                                        score += 10; // exceptional RR
  else if (rr >= 3)                                   score += 5;  // meets minimum
  return Math.min(score, 100);
}

module.exports = {
  fetchCandles,
  detectPivots,
  analyzeStructure,
  detectCHoCH,
  detectBOS,
  calcFibZones,
  detectFVGs,
  detectOrderBlocks,
  detectLiquidityPools,
  detectLTFEntry,
  calcRR,
  meetsMinRR,
  analyzeSMC,
  MIN_RR,
};
