'use strict';
/**
 * Top-down multi-timeframe backtest — 1h → 15m → 1m structure alignment,
 * VWAP band location, and a VSA (volume-spread) volume filter.
 *
 * STRATEGY (as specified by the owner):
 *   1. 1h structure decides direction:  HL -> LONG bias,  LH -> SHORT bias.
 *   2. 15m must confirm the SAME label:  1h HL -> wait for a 15m HL (long);
 *                                        1h LH -> wait for a 15m LH (short).
 *   3. 1m must print the matching label: HL for long, LH for short.
 *   4. VWAP location gate on the 1m entry candle:
 *        LONG  (HL) -> price must be AT / NEAR-INSIDE the LOWER band.
 *        SHORT (LH) -> price must be AT / NEAR-INSIDE the UPPER band.
 *      If the 1m pivot's VWAP location is wrong, SKIP it and look for the
 *      NEXT 1m HL/LH — keep re-finding until a valid one appears OR a fresh
 *      15m HL/LH prints, at which point we re-evaluate 1h, re-find 15m, re-find 1m.
 *   5. VSA gate: if the trigger candle shows BIG BUY volume (wide-spread up bar
 *      on volume >> average = buying climax), do NOT short — wait for the next
 *      1m LH/HH. (Mirror: big SELL volume blocks a long.)
 *
 * DATA: 1h + 15m + 1m klines WITH VOLUME from Bybit v5 linear (same source the
 * repo's other backtests use). Requires outbound access to api.bybit.com.
 *
 * RUN:
 *     node backtest-mtf-1h-15m-1m.js                 # SOLUSDT, 14 days, 20x
 *     SYMBOL=SOLUSDT DAYS=30 LEV=20 node backtest-mtf-1h-15m-1m.js
 *     VWAP_NEAR=0.34 VSA_MULT=2 node backtest-mtf-1h-15m-1m.js
 *
 * Past data only — a good backtest number does not guarantee future profit.
 */

// ── Config (all env-overridable) ─────────────────────────────────────────────
const SYMBOL    = (process.env.SYMBOL || 'SOLUSDT').toUpperCase();
const DAYS      = Number(process.env.DAYS || 14);
const LEV       = Number(process.env.LEV || 20);
const SL_MARGIN = Number(process.env.SL_MARGIN || 0.50);   // -50% of margin (matches live SOL)
const TP_MARGIN = Number(process.env.TP_MARGIN || 0.75);   // +75% of margin
const FEE_SIDE  = Number(process.env.FEE_SIDE || 0.0005);  // 0.05%/side incl. slippage
const PIVOT_L   = Number(process.env.PIVOT_L || 2);        // swing strength (bars each side) for 1h/15m
const PIVOT_1M  = Number(process.env.PIVOT_1M || 2);       // swing strength for 1m
const H15_FRESH_BARS = Number(process.env.H15_FRESH_BARS || 8);  // 15m label active this many 15m bars
const H1_FRESH_BARS  = Number(process.env.H1_FRESH_BARS  || 6);  // 1h bias considered valid this many 1h bars
const VWAP_NEAR = Number(process.env.VWAP_NEAR || 0.34);   // fraction of the half-band that counts as "near the band"
const VSA_LEN   = Number(process.env.VSA_LEN || 20);       // volume SMA lookback (1m bars)
const VSA_MULT  = Number(process.env.VSA_MULT || 2.0);     // volume >= MULT*avg = "big"
const VSA_BODY  = Number(process.env.VSA_BODY || 0.5);     // body/range >= this = wide-spread (directional) bar

const SL_PRICE = SL_MARGIN / LEV;
const TP_PRICE = TP_MARGIN / LEV;
const ROUND_TRIP_FEE = 2 * FEE_SIDE * LEV;   // as fraction of margin

// ── Bybit fetch (paged, with backoff) ────────────────────────────────────────
const BYBIT_IV = { '1m': '1', '15m': '15', '1h': '60' };
const TF_MS    = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchPage(url, attempt = 0) {
  try {
    const res = await fetch(url);
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const data = await res.json();
    if (data.retCode === 10006 || data.retCode === 10018) throw new Error('rate-limit');
    if (data.retCode !== 0) throw new Error(`Bybit retCode ${data.retCode}: ${data.retMsg}`);
    return (data?.result?.list || []).reverse().map(r => ({
      time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    }));
  } catch (e) {
    if (attempt < 5 && /rate-limit|HTTP 429|HTTP 5|fetch failed|ECONN/.test(e.message)) {
      await sleep(1000 * Math.pow(2, attempt));
      return fetchPage(url, attempt + 1);
    }
    throw e;
  }
}

async function fetchKlines(symbol, interval, days) {
  const iv = BYBIT_IV[interval];
  const total = Math.ceil((days * 86_400_000) / TF_MS[interval]);
  const base = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}`;
  let all = await fetchPage(`${base}&limit=1000`);
  const pages = Math.ceil(total / 1000);
  for (let p = 1; p < pages && all.length < total; p++) {
    if (!all.length) break;
    await sleep(350);
    const page = await fetchPage(`${base}&limit=1000&end=${all[0].time - 1}`);
    if (!page.length) break;
    all = [...page, ...all];
  }
  return all.slice(-total);
}

// ── Structure detection: pivots -> HH/HL/LH/LL sequence ──────────────────────
// A confirmed pivot needs `strength` bars on each side. We emit a label the
// moment the pivot is CONFIRMED (strength bars later) so there is no lookahead.
function structureEvents(candles, strength) {
  const events = [];              // { time (confirm time), price, kind: 'HH'|'HL'|'LH'|'LL' }
  let lastHigh = null, lastLow = null;
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (!(candles[i].high > candles[i - k].high && candles[i].high > candles[i + k].high)) isHigh = false;
      if (!(candles[i].low  < candles[i - k].low  && candles[i].low  < candles[i + k].low )) isLow  = false;
    }
    const confirmTime = candles[i + strength].time;   // known only once the right side closes
    if (isHigh) {
      const kind = lastHigh == null ? null : (candles[i].high < lastHigh ? 'LH' : 'HH');
      if (kind) events.push({ time: confirmTime, price: candles[i].high, kind });
      lastHigh = candles[i].high;
    }
    if (isLow) {
      const kind = lastLow == null ? null : (candles[i].low > lastLow ? 'HL' : 'LL');
      if (kind) events.push({ time: confirmTime, price: candles[i].low, kind });
      lastLow = candles[i].low;
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

// Directional bias from a structure stream as of time `t`: the most recent
// HL/LH event (HL->long, LH->short) within `freshMs`. HH/LL are continuation
// and do not flip bias.
function biasAsOf(events, t, freshMs) {
  for (let j = events.length - 1; j >= 0; j--) {
    const e = events[j];
    if (e.time > t) continue;
    if (e.kind === 'HL' || e.kind === 'LH') {
      if (t - e.time > freshMs) return { dir: null, at: e.time };
      return { dir: e.kind === 'HL' ? 'long' : 'short', at: e.time, kind: e.kind };
    }
  }
  return { dir: null, at: 0 };
}

// ── Session VWAP ±2SD bands on the 1m series (resets daily UTC) ───────────────
function vwapBands(c1) {
  const out = new Array(c1.length);
  let day = null, tpv = 0, vol = 0, tpv2 = 0;
  for (let i = 0; i < c1.length; i++) {
    const b = c1[i];
    const d = Math.floor(b.time / 86_400_000);
    if (d !== day) { day = d; tpv = 0; vol = 0; tpv2 = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    tpv += tp * b.volume; vol += b.volume; tpv2 += tp * tp * b.volume;
    if (vol > 0) {
      const vw = tpv / vol;
      const varr = Math.max(0, tpv2 / vol - vw * vw);
      const sd = Math.sqrt(varr);
      out[i] = { mid: vw, upper: vw + 2 * sd, lower: vw - 2 * sd };
    } else {
      out[i] = { mid: b.close, upper: b.close, lower: b.close };
    }
  }
  return out;
}

// VWAP location gate. LONG wants price near/inside LOWER band; SHORT near/inside UPPER.
function vwapLocationOk(band, price, dir, near) {
  if (!band) return false;
  if (dir === 'short') {
    const thresh = band.upper - near * (band.upper - band.mid);   // top `near` of upper half, and beyond
    return price >= thresh;
  } else {
    const thresh = band.lower + near * (band.mid - band.lower);
    return price <= thresh;
  }
}

// VSA: is this a big-volume wide-spread bar in `side` direction?
function vsaBig(c1, i, side) {
  if (i < VSA_LEN) return false;
  let avg = 0;
  for (let k = 1; k <= VSA_LEN; k++) avg += c1[i - k].volume;
  avg /= VSA_LEN;
  const b = c1[i];
  const range = b.high - b.low || 1e-9;
  const body = Math.abs(b.close - b.open) / range;
  const bigVol = b.volume >= VSA_MULT * avg;
  if (side === 'buy')  return bigVol && b.close > b.open && body >= VSA_BODY;
  return bigVol && b.close < b.open && body >= VSA_BODY;   // sell
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== MTF backtest 1h→15m→1m | ${SYMBOL} | ${DAYS}d | ${LEV}x ===`);
  console.log(`SL ${SL_MARGIN * 100}% margin (${(SL_PRICE * 100).toFixed(2)}% px) | TP ${TP_MARGIN * 100}% margin (${(TP_PRICE * 100).toFixed(2)}% px) | fee ${(ROUND_TRIP_FEE * 100).toFixed(2)}%/rt`);
  console.log(`VWAP_NEAR=${VWAP_NEAR} | VSA ${VSA_MULT}x/${VSA_LEN} body>=${VSA_BODY} | pivots 1h/15m=${PIVOT_L} 1m=${PIVOT_1M}\n`);

  console.log('fetching klines…');
  const [c1h, c15, c1] = await Promise.all([
    fetchKlines(SYMBOL, '1h', DAYS + 2),
    fetchKlines(SYMBOL, '15m', DAYS + 1),
    fetchKlines(SYMBOL, '1m', DAYS),
  ]);
  console.log(`  1h=${c1h.length}  15m=${c15.length}  1m=${c1.length}`);

  const ev1h = structureEvents(c1h, PIVOT_L);
  const ev15 = structureEvents(c15, PIVOT_L);
  const ev1m = structureEvents(c1, PIVOT_1M);
  const bands = vwapBands(c1);
  console.log(`  structure events: 1h=${ev1h.length}  15m=${ev15.length}  1m=${ev1m.length}\n`);

  // index 1m structure events by the candle index at/after their confirm time
  const evByIdx = new Map();
  let ej = 0;
  for (let i = 0; i < c1.length; i++) {
    while (ej < ev1m.length && ev1m[ej].time <= c1[i].time) {
      if (!evByIdx.has(i)) evByIdx.set(i, []);
      evByIdx.get(i).push(ev1m[ej]);
      ej++;
    }
  }

  const H15_FRESH = H15_FRESH_BARS * TF_MS['15m'];
  const H1_FRESH  = H1_FRESH_BARS  * TF_MS['1h'];

  const trades = [];
  let pos = null;           // { side, entry, slPx, tpPx }
  let lastWindowKey = null; // one trade per (15m-label) window

  for (let i = 1; i < c1.length; i++) {
    const c = c1[i];

    // ---- manage open position (intrabar: check both, assume adverse first) ----
    if (pos) {
      const hitSL = pos.side === 'long' ? c.low <= pos.slPx : c.high >= pos.slPx;
      const hitTP = pos.side === 'long' ? c.high >= pos.tpPx : c.low <= pos.tpPx;
      let r = null;
      if (hitSL) r = -SL_MARGIN;
      else if (hitTP) r = TP_MARGIN;
      if (r != null) { trades.push({ side: pos.side, r: r - ROUND_TRIP_FEE, entryT: pos.entryT }); pos = null; }
      else continue;   // stay in the trade; don't look for new entries while holding
    }

    // ---- top-down alignment as of this 1m candle ----
    const b1h = biasAsOf(ev1h, c.time, H1_FRESH);
    if (!b1h.dir) continue;
    const b15 = biasAsOf(ev15, c.time, H15_FRESH);
    if (b15.dir !== b1h.dir) continue;             // 15m must confirm the 1h direction

    // one trade per 15m window
    const windowKey = `${b15.dir}:${b15.at}`;
    if (windowKey === lastWindowKey) continue;

    // ---- 1m structure label matching direction, printed on this candle ----
    const evs = evByIdx.get(i) || [];
    const want = b15.dir === 'long' ? 'HL' : 'LH';
    const has1m = evs.some(e => e.kind === want);
    if (!has1m) continue;

    // ---- VWAP location gate ----
    if (!vwapLocationOk(bands[i], c.close, b15.dir, VWAP_NEAR)) continue;  // wrong band -> wait for next 1m pivot

    // ---- VSA gate: block short on big BUY volume / block long on big SELL volume ----
    if (b15.dir === 'short' && vsaBig(c1, i, 'buy'))  continue;  // buying climax -> wait for next 1m LH/HH
    if (b15.dir === 'long'  && vsaBig(c1, i, 'sell')) continue;

    // ---- enter ----
    const entry = c.close;
    pos = {
      side: b15.dir, entry, entryT: c.time,
      slPx: b15.dir === 'long' ? entry * (1 - SL_PRICE) : entry * (1 + SL_PRICE),
      tpPx: b15.dir === 'long' ? entry * (1 + TP_PRICE) : entry * (1 - TP_PRICE),
    };
    lastWindowKey = windowKey;
  }

  // ── report ──
  const rep = (name, ts) => {
    if (!ts.length) { console.log(`${name.padEnd(12)}: no trades`); return; }
    const wins = ts.filter(t => t.r > 0);
    const pnl = ts.reduce((a, t) => a + t.r, 0);
    const gW = wins.reduce((a, t) => a + t.r, 0);
    const gL = ts.filter(t => t.r <= 0).reduce((a, t) => a + t.r, 0);
    const pf = gL !== 0 ? (gW / -gL) : Infinity;
    console.log(`${name.padEnd(12)}: ${String(ts.length).padStart(3)} trades | WR ${(wins.length / ts.length * 100).toFixed(0).padStart(3)}% `
      + `| net ${(pnl * 100 >= 0 ? '+' : '')}${(pnl * 100).toFixed(0)}% margin (${(pnl * 100 / ts.length).toFixed(1)}%/trade) `
      + `| PF ${pf.toFixed(2)}`);
  };
  console.log('── results ─────────────────────────────');
  rep('ALL', trades);
  rep('LONGS', trades.filter(t => t.side === 'long'));
  rep('SHORTS', trades.filter(t => t.side === 'short'));
  console.log('\nNote: past data only; not financial advice.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
