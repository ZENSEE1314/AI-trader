'use strict';
// ============================================================
// STRUCTURE BACKTEST — HL / HH / LH / LL signal audit
//
// Walks through 7 days of historical BTCUSDT/ETHUSDT/SOLUSDT/BNBUSDT
// data, simulates what the current structure-detection engine would
// have done at every 15m candle close, and reports:
//   - Signals FIRED  (direction, setup, price, RR)
//   - Signals BLOCKED (reason)
//   - Structure state at each bar (15m HL/HH/LH/LL + VWAP zone)
//
// Run:  node backtest-structure.js [symbol] [days]
// e.g.: node backtest-structure.js BTCUSDT 3
//       node backtest-structure.js SOLUSDT 7
// ============================================================

const fetch = require('node-fetch');

const PROXY    = process.env.PROXY_URL || '';
const SYMBOL   = process.argv[2] || 'BTCUSDT';
const DAYS     = parseInt(process.argv[3] || '3', 10);
const VWAP_MULT = 1.0;

// ── helpers ─────────────────────────────────────────────────

function parseCandle(k) {
  return {
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
    openTime:  parseInt(k[0]),
    closeTime: parseInt(k[6]),
  };
}
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

async function fetchKlines(symbol, interval, limit) {
  const base = PROXY
    ? `${PROXY}/fapi/v1/klines`
    : 'https://fapi.binance.com/fapi/v1/klines';
  const url = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url, { timeout: 20000 });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.json();
}

// ── VWAP computation on a slice of 1m candles ───────────────

function computeVWAP(candles1m) {
  if (!candles1m || candles1m.length < 2) return null;
  let cumTV = 0, cumV = 0;
  const typicals = [];
  for (const c of candles1m) {
    const tp = (c.high + c.low + c.close) / 3;
    typicals.push(tp);
    cumTV += tp * c.volume;
    cumV  += c.volume;
  }
  const mid = cumV > 0 ? cumTV / cumV : null;
  if (!mid) return null;
  let cumVar = 0;
  for (let i = 0; i < candles1m.length; i++) {
    const diff = typicals[i] - mid;
    cumVar += candles1m[i].volume * diff * diff;
  }
  const sd = Math.sqrt(cumV > 0 ? cumVar / cumV : 0);
  return { mid, upper: mid + VWAP_MULT * sd, lower: mid - VWAP_MULT * sd };
}

// ── pivot scan ───────────────────────────────────────────────

function pivotScan(candles, B = 2) {
  const highs = [], lows = [];
  for (let i = B; i < candles.length - B; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= B; j++) {
      if (candles[i].high <= candles[i-j].high || candles[i].high <= candles[i+j].high) isH = false;
      if (candles[i].low  >= candles[i-j].low  || candles[i].low  >= candles[i+j].low)  isL = false;
    }
    if (isH) highs.push(candles[i].high);
    if (isL) lows.push(candles[i].low);
  }
  return { highs, lows };
}

// ── signal detection at a single bar ────────────────────────

function detectSignalAt(c15Slice, c1mSlice, price) {
  const c15 = c15Slice.slice(-4);
  if (c15.length < 3) return { blocked: 'not enough 15m bars' };

  const lastC = c15[c15.length - 1];
  const prevC = c15[c15.length - 2];

  const has15mHL = lastC.low  > prevC.low;
  const has15mHH = lastC.high > prevC.high;
  const has15mLH = lastC.high < prevC.high;
  const has15mLL = lastC.low  < prevC.low;
  const last15mBull = lastC.close > lastC.open;
  const last15mBear = lastC.close < lastC.open;

  // VWAP
  const vwap = computeVWAP(c1mSlice);
  let vwapZone = 'unknown';
  if (vwap) {
    if (price >= vwap.upper)      vwapZone = 'above_upper';
    else if (price <= vwap.lower) vwapZone = 'below_lower';
    else if (price >= vwap.mid)   vwapZone = 'above_mid';
    else                          vwapZone = 'below_mid';
  }

  // 1m pivots (scan last 30 bars)
  const scan1m = c1mSlice.slice(-30);
  const { highs: pH1m, lows: pL1m } = pivotScan(scan1m, 2);
  const has1mHH = pH1m.length >= 2 && pH1m[pH1m.length-1] > pH1m[pH1m.length-2];
  const has1mHL = pL1m.length >= 2 && pL1m[pL1m.length-1] > pL1m[pL1m.length-2];
  const has1mLL = pL1m.length >= 2 && pL1m[pL1m.length-1] < pL1m[pL1m.length-2];
  const has1mLH = pH1m.length >= 2 && pH1m[pH1m.length-1] < pH1m[pH1m.length-2];

  const struct15 = [
    has15mHL ? 'HL' : '',
    has15mHH ? 'HH' : '',
    has15mLH ? 'LH' : '',
    has15mLL ? 'LL' : '',
  ].filter(Boolean).join('+') || 'none';

  const struct1m = [
    has1mHH ? '1m-HH' : '',
    has1mHL ? '1m-HL' : '',
    has1mLL ? '1m-LL' : '',
    has1mLH ? '1m-LH' : '',
  ].filter(Boolean).join('+') || 'none';

  // VWAP hard blocks
  if (vwapZone === 'unknown') return { blocked: 'VWAP unavailable', struct15, struct1m, vwapZone };

  const atr = calcATR(c15Slice) || price * 0.005;

  const results = [];

  // LONG check
  const longStruct = has15mHL || has15mHH || (has15mLL && last15mBull);
  const long1m     = has1mHH || has1mHL;
  if (vwapZone === 'below_lower') {
    results.push({ dir: 'LONG', blocked: `VWAP below_lower — LONG blocked`, struct15, struct1m, vwapZone });
  } else if (!longStruct) {
    results.push({ dir: 'LONG', blocked: `15m no bull struct (HL=${has15mHL} HH=${has15mHH} LL+bull=${has15mLL&&last15mBull})`, struct15, struct1m, vwapZone });
  } else if (!long1m) {
    results.push({ dir: 'LONG', blocked: `1m no HH/HL (HH=${has1mHH} HL=${has1mHL})`, struct15, struct1m, vwapZone });
  } else {
    const sl = price - atr * 1.2;
    const tp = price + atr * 2.0;
    const rr = Math.round(((tp - price) / (price - sl)) * 10) / 10;
    const why = has15mHL ? '15m-HL' : has15mHH ? '15m-HH' : '15m-LL+bull(sweep)';
    const why1 = has1mHH ? '1m-HH' : '1m-HL';
    results.push({ dir: 'LONG', fired: true, price, sl: Math.round(sl*100)/100, tp: Math.round(tp*100)/100, rr, why: `${why} + ${why1}`, struct15, struct1m, vwapZone });
  }

  // SHORT check
  const shortStruct = has15mLH || has15mLL || (has15mHH && last15mBear);
  const short1m     = has1mLL || has1mLH;
  if (vwapZone === 'above_upper') {
    results.push({ dir: 'SHORT', blocked: `VWAP above_upper — SHORT blocked`, struct15, struct1m, vwapZone });
  } else if (!shortStruct) {
    results.push({ dir: 'SHORT', blocked: `15m no bear struct (LH=${has15mLH} LL=${has15mLL} HH+bear=${has15mHH&&last15mBear})`, struct15, struct1m, vwapZone });
  } else if (!short1m) {
    results.push({ dir: 'SHORT', blocked: `1m no LL/LH (LL=${has1mLL} LH=${has1mLH})`, struct15, struct1m, vwapZone });
  } else {
    const sl = price + atr * 1.2;
    const tp = price - atr * 2.0;
    const rr = Math.round(((price - tp) / (sl - price)) * 10) / 10;
    const why = has15mLH ? '15m-LH' : has15mLL ? '15m-LL' : '15m-HH+bear(sweep)';
    const why1 = has1mLL ? '1m-LL' : '1m-LH';
    results.push({ dir: 'SHORT', fired: true, price, sl: Math.round(sl*100)/100, tp: Math.round(tp*100)/100, rr, why: `${why} + ${why1}`, struct15, struct1m, vwapZone });
  }

  return results;
}

// ── main ─────────────────────────────────────────────────────

async function main() {
  const N15 = DAYS * 96 + 20;  // 96 × 15m candles per day + buffer
  const N1m = DAYS * 1440 + 60; // 1440 × 1m candles per day + buffer

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(` STRUCTURE BACKTEST  |  ${SYMBOL}  |  ${DAYS} days`);
  console.log(`═══════════════════════════════════════════════════════\n`);
  console.log(`Fetching ${N15} × 15m + ${N1m} × 1m candles …`);

  const [raw15, raw1m] = await Promise.all([
    fetchKlines(SYMBOL, '15m', Math.min(N15, 1000)),
    fetchKlines(SYMBOL, '1m',  Math.min(N1m, 1000)),
  ]);

  const c15all = raw15.map(parseCandle);
  const c1mall = raw1m.map(parseCandle);

  console.log(`Got ${c15all.length} × 15m,  ${c1mall.length} × 1m\n`);

  // Walk through every 15m bar (skip first 20 for warm-up)
  let fired = 0, blockedVwap = 0, blockedStruct = 0, blocked1m = 0;
  const trades = [];

  for (let i = 20; i < c15all.length - 1; i++) {
    const bar = c15all[i];
    const barTime = new Date(bar.openTime).toISOString().slice(0, 16);
    const price = bar.close;

    // 1m candles up to this 15m bar's close time
    const c1mSlice = c1mall.filter(c => c.closeTime <= bar.closeTime);
    if (c1mSlice.length < 30) continue;

    // Today's session for VWAP
    const barDay = new Date(bar.openTime);
    const dayStart = Date.UTC(barDay.getUTCFullYear(), barDay.getUTCMonth(), barDay.getUTCDate());
    const todayC1m = c1mSlice.filter(c => c.openTime >= dayStart);
    const vwapCandles = todayC1m.length >= 10 ? todayC1m : c1mSlice.slice(-60);

    const results = detectSignalAt(c15all.slice(0, i + 1), vwapCandles, price);
    const arr = Array.isArray(results) ? results : [results];

    for (const r of arr) {
      if (r.fired) {
        fired++;
        const icon = r.dir === 'LONG' ? '📈' : '📉';
        console.log(`${icon} FIRE  ${barTime}  ${r.dir}  @${price.toFixed(4)}  sl=${r.sl}  tp=${r.tp}  RR=${r.rr}x`);
        console.log(`       why: ${r.why}  |  15m: ${r.struct15}  1m: ${r.struct1m}  vwap: ${r.vwapZone}`);
        trades.push({ time: barTime, ...r });
      } else if (r.blocked) {
        if (r.blocked.includes('VWAP')) blockedVwap++;
        else if (r.blocked.includes('15m')) blockedStruct++;
        else blocked1m++;
        // Only show blocked if the price had some structure (don't spam "none")
        if (r.struct15 !== 'none') {
          const icon = r.dir === 'LONG' ? '🚫📈' : '🚫📉';
          console.log(`${icon} BLKD  ${barTime}  ${r.dir}  @${price.toFixed(4)}  → ${r.blocked}`);
          console.log(`       15m: ${r.struct15}  1m: ${r.struct1m}  vwap: ${r.vwapZone}`);
        }
      }
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(` SUMMARY  ${SYMBOL}  ${DAYS}d`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(` Fired signals   : ${fired}`);
  console.log(` Blocked by VWAP : ${blockedVwap}`);
  console.log(` Blocked by 15m  : ${blockedStruct}`);
  console.log(` Blocked by 1m   : ${blocked1m}`);

  if (trades.length) {
    const longs  = trades.filter(t => t.dir === 'LONG');
    const shorts = trades.filter(t => t.dir === 'SHORT');
    console.log(`\n LONG signals: ${longs.length}`);
    for (const t of longs.slice(-10)) {
      console.log(`   ${t.time}  RR=${t.rr}x  why: ${t.why}`);
    }
    console.log(`\n SHORT signals: ${shorts.length}`);
    for (const t of shorts.slice(-10)) {
      console.log(`   ${t.time}  RR=${t.rr}x  why: ${t.why}`);
    }
  }
  console.log('');
}

main().catch(e => { console.error('Backtest error:', e.message); process.exit(1); });
