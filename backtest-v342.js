// ════════════════════════════════════════════════════════════════
//  backtest-v342.js
//
//  Replicates the v3.42 saved version (Quantum Anneal optimizer #3 pick)
//  to verify the 94.7% WR / +$27,528 claim.
//
//  v3.42 genome:
//    require1m:        OFF
//    require15m:       OFF
//    requireBothHTF:   ON  (1h + 4h must agree)
//    requireKeyLevel:  OFF
//    requireVolSpike:  OFF
//    swingLen1h:       10
//    swingLen4h:       10
//    indecisiveThresh: 0.10
//
//  Run on Railway:
//    DAYS=30 node backtest-v342.js
// ════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

const DAYS    = parseInt(process.env.DAYS || '30', 10);
const CAPITAL = parseFloat(process.env.CAPITAL || '1000');
const RISK    = parseFloat(process.env.RISK || '0.10');
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT').split(',');
const HIGH_LEV = new Set(['BTCUSDT', 'ETHUSDT']);

const SWING_LEN_1H = 10;
const SWING_LEN_4H = 10;
const INDECISIVE  = 0.10;

const INITIAL_SL_PCT  = 0.20;
const TRAIL_START_PCT = 0.21;
const TRAIL_STEP_PCT  = 0.10;

const REQUEST_TIMEOUT = 20_000;

// ── Remix toggles (env-controlled) ─────────────────────────────
// Each filter can be enabled to see which combination produces the
// highest WR while keeping decent trade frequency.
const FILTERS = (process.env.FILTERS || '').split(',').map(s => s.trim()).filter(Boolean);
function f(name) { return FILTERS.includes(name); }

async function fetchAll(symbol, interval, totalNeeded) {
  const out = [];
  const intervalMs = ({ '1m': 60e3, '1h': 3600e3, '4h': 14400e3 })[interval];
  const okxSym = symbol.replace('USDT', '-USDT-SWAP');
  const okxBar = ({ '1m': '1m', '1h': '1H', '4h': '4H' })[interval];
  let endTime = Date.now();
  let firstAttempt = true;
  while (out.length < totalNeeded) {
    const limit = Math.min(1000, totalNeeded - out.length);
    const startTime = endTime - limit * intervalMs;
    const tries = [
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`,
      `https://www.okx.com/api/v5/market/history-candles?instId=${okxSym}&bar=${okxBar}&after=${endTime}&limit=${Math.min(300, limit)}`,
    ];
    let batch = null;
    for (const url of tries) {
      try {
        const r = await fetch(url, { timeout: REQUEST_TIMEOUT });
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j) && j.length) { batch = j; break; }
        if (j.code === '0' && j.data?.length) {
          batch = j.data.slice().reverse().map(k => [parseInt(k[0]), k[1], k[2], k[3], k[4], k[5]]);
          break;
        }
      } catch (_) {}
    }
    if (firstAttempt) {
      console.log(`  [${symbol} ${interval}] first batch: ${batch ? batch.length + ' bars' : 'FAILED'}`);
      firstAttempt = false;
    }
    if (!batch || !batch.length) break;
    out.unshift(...batch);
    endTime = parseInt(batch[0][0]) - 1;
    if (out.length >= totalNeeded) break;
  }
  return out.slice(-totalNeeded);
}

// Detect HH/HL/LL/LH using swingLen
function detectStructure(klines, swingLen) {
  const len = klines.length;
  if (len < swingLen * 6) return null;
  const swingHighs = [], swingLows = [];
  for (let i = swingLen; i < len - swingLen; i++) {
    let isHigh = true, isLow = true;
    const h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]);
    for (let j = i - swingLen; j <= i + swingLen; j++) {
      if (j === i) continue;
      if (parseFloat(klines[j][2]) >= h) isHigh = false;
      if (parseFloat(klines[j][3]) <= l) isLow = false;
    }
    if (isHigh) swingHighs.push(h);
    if (isLow)  swingLows.push(l);
  }
  if (swingHighs.length < 2 && swingLows.length < 2) return null;
  return {
    hh: swingHighs.length >= 2 && swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2],
    lh: swingHighs.length >= 2 && swingHighs[swingHighs.length - 1] < swingHighs[swingHighs.length - 2],
    hl: swingLows.length  >= 2 && swingLows[swingLows.length - 1]  > swingLows[swingLows.length - 2],
    ll: swingLows.length  >= 2 && swingLows[swingLows.length - 1]  < swingLows[swingLows.length - 2],
  };
}

function isIndecisive(k) {
  const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]);
  const body = Math.abs(c - o), range = h - l;
  if (range <= 0) return true;
  return (body / range) < INDECISIVE;
}

async function runSymbol(symbol) {
  const lev = HIGH_LEV.has(symbol) ? 100 : 50;
  console.log(`\n── ${symbol} (${lev}x) — fetching ${DAYS} days...`);

  const N1m = DAYS * 1440;
  const N1h = DAYS * 24 + 200;       // need history for swing detection
  const N4h = DAYS * 6  + 200;

  const [k1m, k1h, k4h] = await Promise.all([
    fetchAll(symbol, '1m', N1m),
    fetchAll(symbol, '1h', N1h),
    fetchAll(symbol, '4h', N4h),
  ]);

  console.log(`  fetched: 1m=${k1m.length} 1h=${k1h.length} 4h=${k4h.length}`);
  if (k1m.length < 100 || k1h.length < 30 || k4h.length < 30) {
    console.log(`  insufficient data — skipping`);
    return null;
  }

  const trades = [];
  let openPos = null;
  const ts1h = new Map(k1h.map((k, i) => [parseInt(k[0]), i]));
  const ts4h = new Map(k4h.map((k, i) => [parseInt(k[0]), i]));

  function lastIdxAtOrBefore(map, t, maxBackMin) {
    for (let off = 0; off <= maxBackMin; off++) {
      const idx = map.get(t - off * 60_000);
      if (idx !== undefined) return idx;
    }
    return -1;
  }

  for (let i = 100; i < k1m.length - 1; i++) {
    const bar = k1m[i];
    const ts  = parseInt(bar[0]);
    const close = parseFloat(bar[4]);
    const isLong = openPos && openPos.side === 'LONG';

    // Manage open position
    if (openPos) {
      const high = parseFloat(bar[2]), low = parseFloat(bar[3]);
      const slHit = isLong ? low <= openPos.sl : high >= openPos.sl;
      if (slHit) {
        const pnlPct = isLong ? (openPos.sl - openPos.entry) / openPos.entry
                              : (openPos.entry - openPos.sl) / openPos.entry;
        const pnlUsd = openPos.size * pnlPct * lev;
        trades.push({ ...openPos, exitTs: ts, exitPrice: openPos.sl, pnlPct, pnlUsd });
        openPos = null;
        continue;
      }
      const profitPct = isLong ? (close - openPos.entry) / openPos.entry
                               : (openPos.entry - close) / openPos.entry;
      const capPct = profitPct * lev;
      if (capPct >= TRAIL_START_PCT) {
        const lockPct = Math.floor(capPct * 10) / 10 - 0.01;
        if (lockPct > openPos.lockedSlCapPct) {
          const newSlPricePct = lockPct / lev;
          openPos.sl = isLong ? openPos.entry * (1 + newSlPricePct)
                              : openPos.entry * (1 - newSlPricePct);
          openPos.lockedSlCapPct = lockPct;
        }
      }
    }
    if (openPos) continue;

    // Skip indecisive 1m candles
    if (isIndecisive(bar)) continue;

    // Get current 1h and 4h structures
    const i1h = lastIdxAtOrBefore(ts1h, ts, 60);
    const i4h = lastIdxAtOrBefore(ts4h, ts, 240);
    if (i1h < SWING_LEN_1H * 6 || i4h < SWING_LEN_4H * 6) continue;

    const k1hWin = k1h.slice(Math.max(0, i1h - 100), i1h + 1);
    const k4hWin = k4h.slice(Math.max(0, i4h - 100), i4h + 1);
    const s1h = detectStructure(k1hWin, SWING_LEN_1H);
    const s4h = detectStructure(k4hWin, SWING_LEN_4H);
    if (!s1h || !s4h) continue;

    // requireBothHTF=ON: both 1h AND 4h must agree
    const bothBull = (s1h.hh || s1h.hl) && (s4h.hh || s4h.hl) && !s1h.ll && !s4h.ll;
    const bothBear = (s1h.ll || s1h.lh) && (s4h.ll || s4h.lh) && !s1h.hh && !s4h.hh;
    let side = null;
    if      (bothBull) side = 'LONG';
    else if (bothBear) side = 'SHORT';
    if (!side) continue;

    // ── Quality remix filters ─────────────────────────────────
    if (f('1m_align')) {
      // 1m must agree with side: HH/HL alone for LONG, LL/LH alone for SHORT
      const k1mWin = k1m.slice(Math.max(0, i - 30), i + 1);
      const s1m = detectStructure(k1mWin, 2);
      if (!s1m) continue;
      if (side === 'LONG'  && !((s1m.hh && !s1m.ll) || (s1m.hl && !s1m.lh && !s1m.ll))) continue;
      if (side === 'SHORT' && !((s1m.ll && !s1m.hh) || (s1m.lh && !s1m.hl && !s1m.hh))) continue;
    }

    if (f('chase')) {
      // Within 0.3% of 30m absolute pivot
      const w30 = k1m.slice(Math.max(0, i - 30), i + 1);
      let lo30 = Infinity, hi30 = -Infinity;
      for (const k of w30) {
        const h = parseFloat(k[2]); if (h > hi30) hi30 = h;
        const l = parseFloat(k[3]); if (l < lo30) lo30 = l;
      }
      if (side === 'LONG'  && (close - lo30) / lo30 > 0.003) continue;
      if (side === 'SHORT' && (hi30 - close) / hi30 > 0.003) continue;
    }

    if (f('rpos')) {
      // Lower 25% (LONG) or upper 75% (SHORT) of last 10×1m range
      const w10 = k1m.slice(Math.max(0, i - 10), i + 1);
      let hi = -Infinity, lo = Infinity;
      for (const k of w10) {
        const h = parseFloat(k[2]); if (h > hi) hi = h;
        const l = parseFloat(k[3]); if (l < lo) lo = l;
      }
      const sz = hi - lo;
      if (sz > 0) {
        const rPos = (close - lo) / sz;
        if (side === 'LONG'  && rPos > 0.25) continue;
        if (side === 'SHORT' && rPos < 0.75) continue;
      }
    }

    if (f('volspike')) {
      // Last 1m vol ≥ 1.5× the 20-bar avg
      const volSlice = k1m.slice(Math.max(0, i - 21), i);
      const avg = volSlice.length
        ? volSlice.reduce((s, k) => s + parseFloat(k[5] || 0), 0) / volSlice.length
        : 0;
      if (avg <= 0) continue;
      const lastVol = parseFloat(bar[5] || 0);
      if (lastVol < avg * 1.5) continue;
    }

    if (f('strict_htf')) {
      // Pure-direction HTF: no opposite swings
      const cleanBull = side === 'LONG'  && s1h.hh && s4h.hh && !s1h.ll && !s4h.ll && !s1h.lh && !s4h.lh;
      const cleanBear = side === 'SHORT' && s1h.ll && s4h.ll && !s1h.hh && !s4h.hh && !s1h.hl && !s4h.hl;
      if (!cleanBull && !cleanBear) continue;
    }

    const slPricePct = INITIAL_SL_PCT / lev;
    const slPrice = side === 'LONG' ? close * (1 - slPricePct) : close * (1 + slPricePct);
    openPos = {
      symbol, side, entry: close, sl: slPrice, entryTs: ts,
      size: CAPITAL * RISK,
      lockedSlCapPct: -INITIAL_SL_PCT,
    };
  }

  if (openPos) {
    const last = k1m[k1m.length - 1];
    const exitPrice = parseFloat(last[4]);
    const isLong = openPos.side === 'LONG';
    const pnlPct = isLong ? (exitPrice - openPos.entry) / openPos.entry
                          : (openPos.entry - exitPrice) / openPos.entry;
    trades.push({ ...openPos, exitTs: parseInt(last[0]), exitPrice, pnlPct, pnlUsd: openPos.size * pnlPct * lev });
  }

  return { symbol, lev, trades };
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  V3.42 REPLICATION BACKTEST — ${DAYS} days, $${CAPITAL}`);
  console.log(`  requireBothHTF=ON (1h + 4h), no 1m/15m/vol/key-level`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];
  for (const sym of SYMBOLS) {
    const r = await runSymbol(sym);
    if (r) results.push(r);
  }

  console.log('\n══════════ PER-COIN RESULTS ═══════════════════════════════');
  console.log('symbol      lev  trades  wins  losses    WR     net P&L');
  let allW = 0, allL = 0, allNet = 0, allT = 0;
  for (const r of results) {
    const w = r.trades.filter(t => t.pnlUsd > 0).length;
    const l = r.trades.filter(t => t.pnlUsd <= 0).length;
    const net = r.trades.reduce((s, t) => s + t.pnlUsd, 0);
    const wr = r.trades.length ? (w / r.trades.length) * 100 : 0;
    console.log(`${r.symbol.padEnd(12)}${(r.lev+'x').padEnd(5)}${String(r.trades.length).padStart(6)} ${String(w).padStart(5)} ${String(l).padStart(7)}   ${wr.toFixed(1).padStart(5)}%   $${net.toFixed(2)}`);
    allW += w; allL += l; allNet += net; allT += r.trades.length;
  }
  console.log('────────────────────────────────────────────────────────────────');
  const aggWr = allT ? (allW / allT) * 100 : 0;
  console.log(`TOTAL              ${String(allT).padStart(6)} ${String(allW).padStart(5)} ${String(allL).padStart(7)}   ${aggWr.toFixed(1).padStart(5)}%   $${allNet.toFixed(2)}`);

  console.log(`\n  Start:  $${CAPITAL.toFixed(2)}`);
  console.log(`  End:    $${(CAPITAL + allNet).toFixed(2)}`);
  console.log(`  Return: ${((allNet / CAPITAL) * 100).toFixed(2)}%`);
  console.log('═══════════════════════════════════════════════════════════');

  console.log('\nNote: this is a faithful replication using the v3.42 genome');
  console.log('against real OKX historical klines with your live SL/trail math.');
  console.log('If this returns much less than +27528%, the dashboard claim was');
  console.log('a backtest math bug in the optimizer (likely full-capital');
  console.log('compounding instead of fixed % risk per trade).');
  process.exit(0);
})().catch(e => { console.error('failed:', e.stack); process.exit(1); });
