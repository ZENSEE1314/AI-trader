'use strict';
// ============================================================
// UNIFIED BACKTEST — single file, two modes
//
// MODE 1: Signal audit (shows every fired/blocked signal per 15m bar)
//   node backtest.js signal [symbol] [days]
//   e.g.  node backtest.js signal BTCUSDT 3
//
// MODE 2: Win-rate optimizer (tests 6 filter configs, finds best WR)
//   node backtest.js wr [symbol|ALL] [days]
//   e.g.  node backtest.js wr ALL 90     ← 90-day backtest
//         node backtest.js wr BTCUSDT 90
//
// Run on Railway (has PROXY_URL set):
//   node backtest.js wr ALL 90
//
// 90-day note: fetches ~8,640 × 15m bars + ~129,600 × 1m bars per symbol.
// 1m data is paginated (1000 bars/page). Expect ~5-8 min per symbol.
// ============================================================

const fetch = require('node-fetch');

const PROXY   = process.env.PROXY_URL || '';
const MODE    = (process.argv[2] || 'wr').toLowerCase(); // 'signal' | 'wr'
const ARG_SYM = process.argv[3] || 'BTCUSDT';
const DAYS    = parseInt(process.argv[4] || '7', 10);

const VWAP_MULT = 1.0;
const MAX_HOLD  = 96; // 96 × 15m = 24 h timeout

const ALL_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const SYMBOLS = ARG_SYM === 'ALL' ? ALL_SYMBOLS : [ARG_SYM];

// ── HTTP ──────────────────────────────────────────────────────

function apiBase() {
  return PROXY ? `${PROXY}/fapi/v1` : 'https://fapi.binance.com/fapi/v1';
}

async function fetchJSON(url, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { timeout: 30000 });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status === 418) {
        await new Promise(res => setTimeout(res, 5000 * (i + 1)));
        continue;
      }
    } catch (e) {
      if (i < retries - 1) { await new Promise(res => setTimeout(res, 2000 * (i + 1))); continue; }
      throw e;
    }
  }
  return null;
}

async function getKlines(symbol, interval, limit, startTime) {
  let url = `${apiBase()}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  return fetchJSON(url);
}

// ── Candle parser ─────────────────────────────────────────────

function pc(k) {
  return {
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5], openTime: +k[0], closeTime: +k[6],
  };
}

// ── ATR (14-period) ───────────────────────────────────────────

function calcATR(candles, n = 14) {
  if (candles.length < n + 1) return candles.length > 1
    ? Math.abs(candles.at(-1).close - candles.at(-2).close) * 1.5 : 0;
  let s = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const p = candles[i - 1], c = candles[i];
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return s / n;
}

// ── VWAP from 1m candles (UTC midnight session) ───────────────
// IMPORTANT: never fall back to 15m — 15m σ is 4-5x wider = bands wrong.

function calcVWAP(c1m) {
  if (!c1m || c1m.length < 5) return null;
  let tv = 0, v = 0;
  const tp = c1m.map(c => {
    const t = (c.high + c.low + c.close) / 3;
    tv += t * c.volume;
    v  += c.volume;
    return t;
  });
  const mid = v > 0 ? tv / v : null;
  if (!mid) return null;
  let vv = 0;
  for (let i = 0; i < c1m.length; i++) vv += c1m[i].volume * (tp[i] - mid) ** 2;
  const sd = Math.sqrt(v > 0 ? vv / v : 0);
  return { mid, upper: mid + VWAP_MULT * sd, lower: mid - VWAP_MULT * sd };
}

function vwapZone(price, v) {
  if (!v) return 'unknown';
  if (price >= v.upper) return 'above_upper';
  if (price <= v.lower) return 'below_lower';
  if (price >= v.mid)   return 'above_mid';
  return 'below_mid';
}

// ── Pivot scan ────────────────────────────────────────────────

function findPivots(candles, B = 2) {
  const H = [], L = [];
  for (let i = B; i < candles.length - B; i++) {
    let h = true, l = true;
    for (let j = 1; j <= B; j++) {
      if (candles[i].high <= candles[i-j].high || candles[i].high <= candles[i+j].high) h = false;
      if (candles[i].low  >= candles[i-j].low  || candles[i].low  >= candles[i+j].low)  l = false;
    }
    if (h) H.push({ price: candles[i].high, idx: i });
    if (l) L.push({ price: candles[i].low,  idx: i });
  }
  return { H, L };
}

// ── WR optimizer config matrix ────────────────────────────────
// vwapStrict:    no SHORT above mid, no LONG below mid
// require2HL:    need 2 consecutive HLs/LHs (not just 1) for confirmation
// structSL:      SL at actual structure low/high (not ATR×1.2)
// freshPivot:    1m pivot window size — smaller = require more recent pivot
// sessionOnly:   skip 00:00–06:30 UTC Asia session
// minStructPct:  minimum % move to count HL/LH as valid (filter micro-noise)

const CONFIGS = [
  {
    name: '1_BASELINE',
    desc: 'Current live logic (no extra filters)',
    vwapStrict: false, require2HL: false, structSL: false,
    freshPivot: 30, sessionOnly: false, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '2_VWAP_STRICT',
    desc: 'Trade WITH VWAP — above mid=LONG zone, below mid=SHORT zone',
    vwapStrict: true, require2HL: false, structSL: false,
    freshPivot: 30, sessionOnly: false, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '3_SESSION_FILTER',
    desc: 'VWAP strict + skip Asia session (outside 06:30–20:00 UTC)',
    vwapStrict: true, require2HL: false, structSL: false,
    freshPivot: 30, sessionOnly: true, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '4_STRUCT_2HL',
    desc: 'VWAP + session + require 2 consecutive HLs/LHs',
    vwapStrict: true, require2HL: true, structSL: false,
    freshPivot: 30, sessionOnly: true, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '5_STRUCT_SL',
    desc: 'VWAP + session + 2HL + SL at structure point (not ATR)',
    vwapStrict: true, require2HL: true, structSL: true,
    freshPivot: 15, sessionOnly: true, minStructPct: 0.001,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.5,
  },
  {
    name: '6_FULL_STRICT',
    desc: 'All filters + fresh 1m pivot (10 bars) + min structure 0.15%',
    vwapStrict: true, require2HL: true, structSL: true,
    freshPivot: 10, sessionOnly: true, minStructPct: 0.0015,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.5,
  },
];

// ── Core signal detection (shared by both modes) ──────────────
// cfg = null  → signal-audit mode (returns full debug array)
// cfg = object → WR mode (returns first fired signal or null)

function detectSignal(c15Slice, c1mToday, cfg) {
  if (!c1mToday || c1mToday.length < 5) {
    return cfg ? null : [{ dir: 'LONG', blocked: 'not enough 1m bars' }];
  }

  const v = calcVWAP(c1mToday);
  if (!v) return cfg ? null : [{ dir: 'LONG', blocked: 'VWAP unavailable' }];

  const price = c15Slice.at(-1).close;
  const zone  = vwapZone(price, v);
  if (zone === 'unknown') return cfg ? null : [{ dir: 'LONG', blocked: 'VWAP zone unknown' }];

  // Session: 06:30–20:00 UTC (London + NY)
  const barMs  = c15Slice.at(-1).openTime;
  const utcMin = new Date(barMs).getUTCHours() * 60 + new Date(barMs).getUTCMinutes();
  if (cfg?.sessionOnly && (utcMin < 390 || utcMin > 1200)) return null;

  // 15m structure — last 5 candles, direct comparison (no swing pivot wait)
  const c5 = c15Slice.slice(-5);
  if (c5.length < 3) return cfg ? null : [{ dir: 'LONG', blocked: 'not enough 15m bars' }];
  const last  = c5.at(-1);
  const prev  = c5.at(-2);
  const prev2 = c5.at(-3);

  const has15mHL = last.low  > prev.low;
  const has15mHH = last.high > prev.high;
  const has15mLH = last.high < prev.high;
  const has15mLL = last.low  < prev.low;
  const lastBull = last.close > last.open;
  const lastBear = last.close < last.open;

  const minPct    = cfg?.minStructPct ?? 0;
  const hlQual    = has15mHL && (last.low - prev.low)   / prev.low   >= minPct;
  const lhQual    = has15mLH && (prev.high - last.high) / prev.high  >= minPct;
  const prev15mHL = prev.low  > prev2.low;
  const prev15mLH = prev.high < prev2.high;

  // 1m pivots
  const pivotLen   = cfg?.freshPivot ?? 15;
  const scan1m     = c1mToday.slice(-pivotLen);
  const pv         = findPivots(scan1m, 2);
  const freshThresh = Math.floor(scan1m.length * 0.5);
  const freshH      = pv.H.length && pv.H.at(-1).idx >= freshThresh;
  const freshL      = pv.L.length && pv.L.at(-1).idx >= freshThresh;

  const has1mHH = pv.H.length >= 2 && pv.H.at(-1).price > pv.H.at(-2).price;
  const has1mHL = pv.L.length >= 2 && pv.L.at(-1).price > pv.L.at(-2).price;
  const has1mLL = pv.L.length >= 2 && pv.L.at(-1).price < pv.L.at(-2).price;
  const has1mLH = pv.H.length >= 2 && pv.H.at(-1).price < pv.H.at(-2).price;

  const struct15 = [
    has15mHL ? 'HL' : '', has15mHH ? 'HH' : '',
    has15mLH ? 'LH' : '', has15mLL ? 'LL' : '',
  ].filter(Boolean).join('+') || 'none';

  const struct1m = [
    has1mHH ? '1m-HH' : '', has1mHL ? '1m-HL' : '',
    has1mLL ? '1m-LL' : '', has1mLH ? '1m-LH' : '',
  ].filter(Boolean).join('+') || 'none';

  const atrVal = calcATR(c15Slice);
  const results = [];

  // ── LONG ─────────────────────────────────────────────────
  // Hard rule: never LONG below lower VWAP band
  // Strict mode: also no LONG below mid
  const longVwapOk = zone !== 'below_lower' &&
    (!cfg?.vwapStrict || zone === 'above_mid' || zone === 'above_upper');

  const longStruct15 = hlQual || has15mHH || (has15mLL && lastBull);
  const longConsec   = !cfg?.require2HL || (has15mHL && prev15mHL) || has15mHH;
  const long1m       = (has1mHH || has1mHL) && (!cfg?.freshPivot || freshL || freshH);

  if (!longVwapOk) {
    results.push({ dir: 'LONG', blocked: `VWAP block (${zone}) — no LONG`, struct15, struct1m, zone });
  } else if (!longStruct15) {
    results.push({ dir: 'LONG', blocked: `15m no bull struct HL=${hlQual} HH=${has15mHH} LL+bull=${has15mLL&&lastBull}`, struct15, struct1m, zone });
  } else if (!longConsec) {
    results.push({ dir: 'LONG', blocked: `15m need 2nd confirm prevHL=${prev15mHL}`, struct15, struct1m, zone });
  } else if (!long1m) {
    results.push({ dir: 'LONG', blocked: `1m no HH/HL (HH=${has1mHH} HL=${has1mHL} fresh=${freshL||freshH})`, struct15, struct1m, zone });
  } else {
    let sl;
    if (cfg?.structSL) {
      sl = Math.min(last.low, prev.low) * (1 - 0.0005);
    } else {
      sl = price - atrVal * (cfg?.atrSL ?? 1.2);
    }
    const slDist = (price - sl) / price;
    const tp     = price + Math.max(atrVal * (cfg?.atrTP ?? 2.0), slDist * price * (cfg?.minRR ?? 1.2));
    const rr     = slDist > 0 ? Math.round((tp - price) / (price - sl) * 10) / 10 : 0;
    const minRR  = cfg?.minRR ?? 1.2;
    if (rr >= minRR && slDist > 0.001 && slDist < 0.05) {
      const why = has15mHL ? '15HL' : has15mHH ? '15HH' : '15LL+bull';
      const sig = { dir: 'LONG', fired: true, price, sl: Math.round(sl*100)/100, tp: Math.round(tp*100)/100, slDist, rr, why, struct15, struct1m, zone };
      if (cfg) return sig; // WR mode: return immediately
      results.push(sig);
    } else {
      results.push({ dir: 'LONG', blocked: `RR too low (${rr}x < ${minRR}x) or SL out of range`, struct15, struct1m, zone });
    }
  }

  // ── SHORT ─────────────────────────────────────────────────
  // Hard rule: never SHORT above upper VWAP band
  // Strict mode: also no SHORT above mid
  const shortVwapOk = zone !== 'above_upper' &&
    (!cfg?.vwapStrict || zone === 'below_mid' || zone === 'below_lower');

  const shortStruct15 = lhQual || has15mLL || (has15mHH && lastBear);
  const shortConsec   = !cfg?.require2HL || (has15mLH && prev15mLH) || has15mLL;
  const short1m       = (has1mLL || has1mLH) && (!cfg?.freshPivot || freshH || freshL);

  if (!shortVwapOk) {
    results.push({ dir: 'SHORT', blocked: `VWAP block (${zone}) — no SHORT`, struct15, struct1m, zone });
  } else if (!shortStruct15) {
    results.push({ dir: 'SHORT', blocked: `15m no bear struct LH=${lhQual} LL=${has15mLL} HH+bear=${has15mHH&&lastBear}`, struct15, struct1m, zone });
  } else if (!shortConsec) {
    results.push({ dir: 'SHORT', blocked: `15m need 2nd confirm prevLH=${prev15mLH}`, struct15, struct1m, zone });
  } else if (!short1m) {
    results.push({ dir: 'SHORT', blocked: `1m no LL/LH (LL=${has1mLL} LH=${has1mLH} fresh=${freshH||freshL})`, struct15, struct1m, zone });
  } else {
    let sl;
    if (cfg?.structSL) {
      sl = Math.max(last.high, prev.high) * (1 + 0.0005);
    } else {
      sl = price + atrVal * (cfg?.atrSL ?? 1.2);
    }
    const slDist = (sl - price) / price;
    const tp     = price - Math.max(atrVal * (cfg?.atrTP ?? 2.0), slDist * price * (cfg?.minRR ?? 1.2));
    const rr     = slDist > 0 ? Math.round((price - tp) / (sl - price) * 10) / 10 : 0;
    const minRR  = cfg?.minRR ?? 1.2;
    if (rr >= minRR && slDist > 0.001 && slDist < 0.05) {
      const why = has15mLH ? '15LH' : has15mLL ? '15LL' : '15HH+bear';
      const sig = { dir: 'SHORT', fired: true, price, sl: Math.round(sl*100)/100, tp: Math.round(tp*100)/100, slDist, rr, why, struct15, struct1m, zone };
      if (cfg) return sig;
      results.push(sig);
    } else {
      results.push({ dir: 'SHORT', blocked: `RR too low (${rr}x < ${minRR}x) or SL out of range`, struct15, struct1m, zone });
    }
  }

  return results; // signal-audit mode: always return full array
}

// ── Trade outcome simulator ───────────────────────────────────

function simulate(sig, futureC1m) {
  for (const bar of futureC1m) {
    if (sig.dir === 'LONG') {
      if (bar.low  <= sig.sl) return 'LOSS';
      if (bar.high >= sig.tp) return 'WIN';
    } else {
      if (bar.high >= sig.sl) return 'LOSS';
      if (bar.low  <= sig.tp) return 'WIN';
    }
  }
  return 'TIMEOUT';
}

// ── Fetch candles paginated (any interval) ────────────────────
// maxPages safety: 1m×90d = 130 pages, 15m×90d = 9 pages

async function fetchAllCandles(symbol, interval, fromMs, toMs) {
  const intervalMs = interval === '1m' ? 60000 : interval === '15m' ? 900000 : 60000;
  const maxPages   = Math.ceil((toMs - fromMs) / (intervalMs * 1000)) + 2;
  const all = [];
  let start = fromMs, pages = 0;
  while (start < toMs && pages < maxPages) {
    const raw = await getKlines(symbol, interval, 1000, start);
    if (!raw || !raw.length) break;
    const parsed = raw.map(pc);
    all.push(...parsed);
    const last = parsed.at(-1);
    if (last.closeTime >= toMs) break;
    start = last.openTime + intervalMs;
    pages++;
    // Throttle: 1m has many pages, be gentle with the API
    await new Promise(r => setTimeout(r, interval === '1m' ? 220 : 100));
    if (pages % 20 === 0) process.stdout.write(` [${pages}p]`);
  }
  return all.filter(c => c.openTime >= fromMs && c.closeTime <= toMs);
}

// Convenience wrappers
const fetchAll15m = (sym, from, to) => fetchAllCandles(sym, '15m', from, to);
const fetchAll1m  = (sym, from, to) => fetchAllCandles(sym, '1m',  from, to);

// ── Stats ─────────────────────────────────────────────────────
// netR = net R-multiples (1R = risk per trade).
// netUsd = dollar PnL assuming $100 risk per trade (1R = $100).
//   WIN  → +$100 × RR
//   LOSS → -$100
//   TIMEOUT → -$30 (partial loss, trade timed out)

function calcStats(trades) {
  if (!trades.length) return { total: 0, wr: 0, avgRR: 0, pf: 0, netR: 0, netUsd: 0 };
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const wr     = Math.round(wins.length / trades.length * 100);
  const avgRR  = wins.length ? wins.reduce((s, t) => s + t.rr, 0) / wins.length : 0;
  const gw     = wins.reduce((s, t) => s + t.pnlR, 0);
  const gl     = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const pf     = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
  const netR   = trades.reduce((s, t) => s + t.pnlR, 0);
  const netUsd = Math.round(netR * 100); // $100 per 1R
  return { total: trades.length, wins: wins.length, losses: losses.length, wr, avgRR, pf, netR, netUsd };
}

// ════════════════════════════════════════════════════════════
// MODE 1: SIGNAL AUDIT
// Walk every 15m bar — show which signals FIRE or are BLOCKED.
// ════════════════════════════════════════════════════════════

async function runSignalAudit(symbol) {
  const nowMs  = Date.now();
  const fromMs = nowMs - DAYS * 86400000;

  console.log(`\n${'═'.repeat(62)}`);
  console.log(` SIGNAL AUDIT  |  ${symbol}  |  ${DAYS} days`);
  console.log(`${'═'.repeat(62)}\n`);

  process.stdout.write(`Fetching 15m…`);
  const c15all = await fetchAll15m(symbol, fromMs, nowMs);
  console.log(` ${c15all.length} bars`);

  process.stdout.write(`Fetching 1m… `);
  const c1mall = await fetchAll1m(symbol, fromMs, nowMs);
  console.log(` ${c1mall.length} bars\n`);

  if (!c15all.length || !c1mall.length) { console.log('Failed to fetch candles'); return; }

  let fired = 0, blockedVwap = 0, blockedStruct = 0, blocked1m = 0;
  const trades = [];

  for (let i = 20; i < c15all.length - 1; i++) {
    const bar     = c15all[i];
    const barTime = new Date(bar.openTime).toISOString().slice(0, 16);
    const barDay  = new Date(bar.openTime);
    const dayMs   = Date.UTC(barDay.getUTCFullYear(), barDay.getUTCMonth(), barDay.getUTCDate());
    const c1mToday = c1mall.filter(c => c.openTime >= dayMs && c.closeTime <= bar.closeTime);
    if (c1mToday.length < 10) continue;

    const results = detectSignal(c15all.slice(0, i + 1), c1mToday, null);
    const arr = Array.isArray(results) ? results : [results];

    for (const r of arr) {
      if (!r) continue;
      if (r.fired) {
        fired++;
        const icon = r.dir === 'LONG' ? '📈' : '📉';
        console.log(`${icon} FIRE  ${barTime}  ${r.dir}  @${bar.close.toFixed(4)}  sl=${r.sl}  tp=${r.tp}  RR=${r.rr}x`);
        console.log(`       why: ${r.why}  |  15m: ${r.struct15}  1m: ${r.struct1m}  vwap: ${r.zone}`);
        trades.push({ time: barTime, ...r });
      } else if (r.blocked) {
        if (r.blocked.includes('VWAP')) blockedVwap++;
        else if (r.blocked.includes('15m')) blockedStruct++;
        else blocked1m++;
        if (r.struct15 !== 'none') {
          const icon = r.dir === 'LONG' ? '🚫📈' : '🚫📉';
          console.log(`${icon} BLKD  ${barTime}  ${r.dir}  @${bar.close.toFixed(4)}  → ${r.blocked}`);
          console.log(`       15m: ${r.struct15}  1m: ${r.struct1m}  vwap: ${r.zone}`);
        }
      }
    }
  }

  console.log(`\n${'═'.repeat(62)}`);
  console.log(` SUMMARY  ${symbol}  ${DAYS}d`);
  console.log(`${'═'.repeat(62)}`);
  console.log(` Fired signals   : ${fired}`);
  console.log(` Blocked by VWAP : ${blockedVwap}`);
  console.log(` Blocked by 15m  : ${blockedStruct}`);
  console.log(` Blocked by 1m   : ${blocked1m}`);
  if (trades.length) {
    const longs  = trades.filter(t => t.dir === 'LONG');
    const shorts = trades.filter(t => t.dir === 'SHORT');
    console.log(`\n LONG signals: ${longs.length}`);
    for (const t of longs.slice(-10)) console.log(`   ${t.time}  RR=${t.rr}x  why: ${t.why}`);
    console.log(`\n SHORT signals: ${shorts.length}`);
    for (const t of shorts.slice(-10)) console.log(`   ${t.time}  RR=${t.rr}x  why: ${t.why}`);
  }
  console.log('');
}

// ════════════════════════════════════════════════════════════
// MODE 2: WR OPTIMIZER
// Run all 6 configs, simulate trade outcomes, find best WR.
// ════════════════════════════════════════════════════════════

function runConfig(c15all, c1mall, cfg) {
  const trades = [];
  let lastTradeEndMs = 0;

  for (let i = 20; i < c15all.length - 2; i++) {
    const bar = c15all[i];
    if (bar.openTime <= lastTradeEndMs + 15 * 60000) continue;

    const barDay   = new Date(bar.openTime);
    const dayMs    = Date.UTC(barDay.getUTCFullYear(), barDay.getUTCMonth(), barDay.getUTCDate());
    const c1mToday = c1mall.filter(c => c.openTime >= dayMs && c.closeTime <= bar.closeTime);

    const sig = detectSignal(c15all.slice(0, i + 1), c1mToday, cfg);
    if (!sig || !sig.fired) continue;

    const maxFutMs  = bar.closeTime + MAX_HOLD * 15 * 60000;
    const futureC1m = c1mall.filter(c => c.openTime > bar.closeTime && c.closeTime <= maxFutMs);
    if (futureC1m.length < 5) continue;

    const outcome = simulate(sig, futureC1m);
    const pnlR    = outcome === 'WIN' ? sig.rr : outcome === 'LOSS' ? -1.0 : -0.3;

    trades.push({
      time:      new Date(bar.openTime).toISOString().slice(0, 16),
      direction: sig.dir, price: sig.price, sl: sig.sl, tp: sig.tp,
      rr: Math.round(sig.rr * 10) / 10, outcome, pnlR,
      why: sig.why, zone: sig.zone,
    });

    if (outcome !== 'TIMEOUT') {
      const closingBar = futureC1m.find(c =>
        (sig.dir === 'LONG'  && (c.low <= sig.sl || c.high >= sig.tp)) ||
        (sig.dir === 'SHORT' && (c.high >= sig.sl || c.low <= sig.tp))
      );
      if (closingBar) lastTradeEndMs = closingBar.closeTime;
    } else {
      lastTradeEndMs = maxFutMs;
    }
  }
  return trades;
}

async function backtestSymbol(symbol, fromMs, nowMs) {
  process.stdout.write(`  [${symbol}] Fetching 15m…`);
  const c15all = await fetchAll15m(symbol, fromMs, nowMs);
  if (c15all.length < 30) { console.log(' skip (no 15m data)'); return {}; }
  console.log(` ${c15all.length} bars`);

  process.stdout.write(`  [${symbol}] Fetching 1m… `);
  const c1mall = await fetchAll1m(symbol, fromMs, nowMs);
  console.log(` ${c1mall.length} bars`);

  if (c1mall.length < 200) { console.log(`  [${symbol}] Not enough 1m data — skip`); return {}; }

  const results = {};
  for (const cfg of CONFIGS) {
    const trades = runConfig(c15all, c1mall, cfg);
    results[cfg.name] = { trades, ...calcStats(trades) };
  }
  return results;
}

async function runWROptimizer() {
  const nowMs  = Date.now();
  const fromMs = nowMs - DAYS * 86400000;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(` WIN-RATE OPTIMIZER  |  ${ARG_SYM}  |  ${DAYS} days`);
  console.log(`${'═'.repeat(70)}\n`);

  const aggByConfig = {};
  for (const cfg of CONFIGS) aggByConfig[cfg.name] = [];

  for (const symbol of SYMBOLS) {
    console.log(`\n── ${symbol} ──────────────────────`);
    try {
      const res = await backtestSymbol(symbol, fromMs, nowMs);
      for (const [name, data] of Object.entries(res)) {
        aggByConfig[name].push(...(data.trades || []));
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }

  // ── Summary table ─────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(` RESULTS SUMMARY  (${DAYS} days · $100 risk per trade)`);
  console.log('═'.repeat(80));
  console.log(` ${'Config'.padEnd(20)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(6)} ${'AvgRR'.padEnd(7)} ${'PF'.padEnd(6)} ${'NetR'.padEnd(8)} ${'$PnL'.padEnd(10)}`);
  console.log('─'.repeat(80));

  let bestCfg = null, bestScore = -99;
  for (const cfg of CONFIGS) {
    const s = calcStats(aggByConfig[cfg.name]);
    const score = s.wr * 0.5 + s.pf * 20 + s.netR;
    if (score > bestScore && s.total >= 5) { bestScore = score; bestCfg = cfg; }
    const flag = s.wr >= 80 ? ' ✅' : s.wr >= 65 ? ' 🔶' : ' ❌';
    const dollarStr = (s.netUsd >= 0 ? '+$' : '-$') + Math.abs(s.netUsd);
    console.log(
      ` ${cfg.name.padEnd(20)} ${String(s.total).padEnd(8)} ${String(s.wr + '%').padEnd(6)} ` +
      `${s.avgRR.toFixed(2).padEnd(7)} ${s.pf.toFixed(2).padEnd(6)} ${s.netR.toFixed(1).padEnd(8)} ${dollarStr.padEnd(10)}${flag}`
    );
  }
  console.log('═'.repeat(80));
  if (bestCfg) {
    console.log(`\n ★ BEST CONFIG: ${bestCfg.name}`);
    console.log(`   ${bestCfg.desc}`);
  }

  if (!bestCfg) { console.log('\n Not enough trades to determine best config.'); return; }

  const bestTrades = aggByConfig[bestCfg.name];
  const s = calcStats(bestTrades);

  // ── All trades ────────────────────────────────────────────
  console.log(`\n── All trades (${bestCfg.name}) ──────────────────────────────────`);
  for (const t of bestTrades) {
    const icon = t.outcome === 'WIN' ? '✅' : t.outcome === 'LOSS' ? '❌' : '⏱️';
    console.log(
      `  ${icon} ${t.time}  ${t.direction.padEnd(5)} @${t.price.toFixed(2).padEnd(10)} ` +
      `RR=${t.rr}x  ${t.outcome.padEnd(7)} why=${t.why} zone=${t.zone}`
    );
  }

  // ── Per-day breakdown ─────────────────────────────────────
  console.log(`\n── Per-day breakdown ──────────────────────────────────────────────`);
  const byDay = {};
  for (const t of bestTrades) {
    const d = t.time.slice(0, 10);
    if (!byDay[d]) byDay[d] = { w: 0, l: 0, r: 0 };
    if (t.outcome === 'WIN')  byDay[d].w++;
    if (t.outcome === 'LOSS') byDay[d].l++;
    byDay[d].r += t.pnlR;
  }
  for (const [day, d] of Object.entries(byDay)) {
    const wr = d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : '-';
    console.log(`  ${day}  ${d.w}W / ${d.l}L  WR=${wr}%  R=${d.r.toFixed(1)}`);
  }

  // ── Loss analysis ─────────────────────────────────────────
  console.log(`\n── Loss analysis ──────────────────────────────────────────────────`);
  const lost = bestTrades.filter(t => t.outcome === 'LOSS');
  const zoneL = {}, whyL = {}, dirL = {};
  for (const t of lost) {
    zoneL[t.zone]     = (zoneL[t.zone]     || 0) + 1;
    whyL[t.why]       = (whyL[t.why]       || 0) + 1;
    dirL[t.direction] = (dirL[t.direction] || 0) + 1;
  }
  console.log(`  By VWAP zone : ${Object.entries(zoneL).map(([k,v]) => `${k}=${v}`).join(' | ') || 'none'}`);
  console.log(`  By structure : ${Object.entries(whyL).map(([k,v]) => `${k}=${v}`).join(' | ') || 'none'}`);
  console.log(`  By direction : ${Object.entries(dirL).map(([k,v]) => `${k}=${v}`).join(' | ') || 'none'}`);

  const dollarFinal = (s.netUsd >= 0 ? '+$' : '-$') + Math.abs(s.netUsd);
  console.log(`\n${'═'.repeat(80)}`);
  console.log(` BEST CONFIG: ${bestCfg.name}`);
  console.log(` WR: ${s.wr}%  |  Profit Factor: ${s.pf.toFixed(2)}  |  Trades: ${s.total}  |  Net R: ${s.netR.toFixed(1)}`);
  console.log(` Dollar PnL (@ $100 risk/trade): ${dollarFinal}`);
  console.log('═'.repeat(80));
  console.log('\n Reply with these results to apply the best config to the live engine.\n');
}

// ── Entry ─────────────────────────────────────────────────────

async function main() {
  if (MODE === 'signal') {
    for (const sym of SYMBOLS) await runSignalAudit(sym);
  } else if (MODE === 'wr') {
    await runWROptimizer();
  } else {
    console.log('Usage:');
    console.log('  node backtest.js signal [symbol] [days]   — signal audit');
    console.log('  node backtest.js wr [symbol|ALL] [days]   — WR optimizer');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
