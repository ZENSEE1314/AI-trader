'use strict';
/**
 * Reverse-engineer SMC Expo's HH/HL/LH/LL by testing candidate market-structure
 * algorithms against the REAL extracted Expo labels (data/expo-labels/*.json).
 * Reports match rate per algorithm per symbol so we can iterate to a faithful port.
 *
 *   node _expo_match.js           (VPN required — fetches 15m klines from Bybit)
 */
const fs = require('fs');
const TV = require('@mathieuc/tradingview');
const SESSION = process.env.TV_SESSION, SIGN = process.env.TV_SESSION_SIGN;

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const TVSYM = { BTCUSDT: 'BITUNIX:BTCUSDT.P', ETHUSDT: 'BITUNIX:ETHUSDT.P', SOLUSDT: 'BITUNIX:SOLUSDT.P', BNBUSDT: 'BITUNIX:BNBUSDT.P' };
const BAR_MS = 15 * 60 * 1000;
const TOL_BARS = 2;                       // a computed label matches an Expo label within ±2 bars
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 15m OHLCV from TradingView (same bars Expo saw; no Bybit/VPN needed).
function tvKlines(tvSym) {
  return new Promise((resolve) => {
    const client = new TV.Client({ token: SESSION, signature: SIGN });
    const chart = new client.Session.Chart();
    chart.setMarket(tvSym, { timeframe: '15', range: 900 });
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      const p = (chart.periods || []).map(b => ({ time: b.time * 1000, open: b.open, high: b.max, low: b.min, close: b.close })).sort((a, b) => a.time - b.time);
      client.end(); resolve(p);
    };
    chart.onUpdate(() => { if ((chart.periods || []).length) setTimeout(finish, 1200); });
    chart.onError(() => finish());
    setTimeout(finish, 20000);
  });
}

// ── Candidate algorithms — each returns [{ time, type }] ──────────────────────
function pivots(c, L) {
  const hi = [], lo = [];
  for (let i = L; i < c.length - L; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= L; k++) {
      if (!(c[i].high > c[i - k].high && c[i].high > c[i + k].high)) isH = false;
      if (!(c[i].low  < c[i - k].low  && c[i].low  < c[i + k].low))  isL = false;
    }
    if (isH) hi.push(i); if (isL) lo.push(i);
  }
  return { hi, lo };
}

// A) Naive pivot comparison at length L (what swing_len did).
function algoNaive(c, L) {
  const { hi, lo } = pivots(c, L);
  const out = [];
  let pH = null, pL = null;
  // merge in time order
  const evs = [...hi.map(i => ({ i, k: 'h' })), ...lo.map(i => ({ i, k: 'l' }))].sort((a, b) => a.i - b.i);
  for (const e of evs) {
    if (e.k === 'h') { out.push({ time: c[e.i].time, type: pH == null || c[e.i].high > pH ? 'HH' : 'LH' }); pH = c[e.i].high; }
    else { out.push({ time: c[e.i].time, type: pL == null || c[e.i].low > pL ? 'HL' : 'LL' }); pL = c[e.i].low; }
  }
  return out;
}

// A2) Alternating pivots: collapse consecutive same-type pivots (keep the extreme)
// so labels strictly alternate H/L — Expo emits fewer labels than raw pivots.
function algoAlt(c, L) {
  const { hi, lo } = pivots(c, L);
  const evs = [...hi.map(i => ({ i, k: 'h', v: c[i].high })), ...lo.map(i => ({ i, k: 'l', v: c[i].low }))].sort((a, b) => a.i - b.i);
  const col = [];
  for (const e of evs) {
    const last = col[col.length - 1];
    if (last && last.k === e.k) { if ((e.k === 'h' && e.v > last.v) || (e.k === 'l' && e.v < last.v)) col[col.length - 1] = e; }
    else col.push(e);
  }
  const out = []; let pH = null, pL = null;
  for (const e of col) {
    if (e.k === 'h') { out.push({ time: c[e.i].time, type: pH == null || e.v > pH ? 'HH' : 'LH' }); pH = e.v; }
    else { out.push({ time: c[e.i].time, type: pL == null || e.v > pL ? 'HL' : 'LL' }); pL = e.v; }
  }
  return out;
}

// B) Trend/BOS market structure (Zeiierman-style): a swing is only labelled when
// price BREAKS the prior swing (BOS). In an up-leg, broken-high=HH, the low before=HL;
// flip to down-leg on a CHoCH (break below the last HL). Length L pivots.
function algoBOS(c, L) {
  const { hi, lo } = pivots(c, L);
  const hiSet = new Map(hi.map(i => [i, c[i].high]));
  const loSet = new Map(lo.map(i => [i, c[i].low]));
  const out = [];
  let trend = 0;                 // +1 up, -1 down
  let lastSH = null, lastSL = null;       // {i, price}
  let prevSHprice = null, prevSLprice = null;
  for (let i = 0; i < c.length; i++) {
    if (hiSet.has(i)) lastSH = { i, price: hiSet.get(i) };
    if (loSet.has(i)) lastSL = { i, price: loSet.get(i) };
    // break above last swing high → bullish structure
    if (lastSH && c[i].close > lastSH.price && (trend !== 1 || prevSHprice == null || lastSH.price > prevSHprice)) {
      const type = (prevSHprice == null || lastSH.price > prevSHprice) ? 'HH' : 'LH';
      out.push({ time: c[lastSH.i].time, type });
      if (lastSL) out.push({ time: c[lastSL.i].time, type: (prevSLprice == null || lastSL.price > prevSLprice) ? 'HL' : 'LL' });
      prevSHprice = lastSH.price; prevSLprice = lastSL ? lastSL.price : prevSLprice;
      trend = 1; lastSH = null;
    }
    // break below last swing low → bearish structure
    if (lastSL && c[i].close < lastSL.price && (trend !== -1 || prevSLprice == null || lastSL.price < prevSLprice)) {
      const type = (prevSLprice == null || lastSL.price < prevSLprice) ? 'LL' : 'HL';
      out.push({ time: c[lastSL.i].time, type });
      if (lastSH) out.push({ time: c[lastSH.i].time, type: (prevSHprice == null || lastSH.price < prevSHprice) ? 'LH' : 'HH' });
      prevSLprice = lastSL.price; prevSHprice = lastSH ? lastSH.price : prevSHprice;
      trend = -1; lastSL = null;
    }
  }
  // dedup by time+type
  const seen = new Set();
  return out.filter(o => { const k = `${o.time}:${o.type}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function score(computed, truth) {
  const used = new Array(computed.length).fill(false);
  let exact = 0, timeOnly = 0;
  for (const t of truth) {
    let best = -1, bestType = false;
    for (let j = 0; j < computed.length; j++) {
      if (used[j]) continue;
      if (Math.abs(computed[j].time - t.time) <= TOL_BARS * BAR_MS) {
        if (computed[j].type === t.type) { best = j; bestType = true; break; }
        if (best < 0) best = j;
      }
    }
    if (best >= 0) { used[best] = true; if (bestType) exact++; else timeOnly++; }
  }
  return { exact, timeOnly, truthN: truth.length, compN: computed.length };
}

async function main() {
  console.log('\n=== SMC Expo structure-match — candidate algos vs REAL Expo labels ===');
  console.log('exact = same type+time(±2bars) | pos = right place wrong label | miss = Expo label with no computed match\n');
  for (const sym of SYMBOLS) {
    const path = `data/expo-labels/${sym}-15m-expo.json`;
    if (!fs.existsSync(path)) { console.log(`${sym}: no labels`); continue; }
    const truth = JSON.parse(fs.readFileSync(path, 'utf8')).filter(l => /^(HH|HL|LH|LL)$/.test(l.type));
    let c15;
    try { c15 = await tvKlines(TVSYM[sym]); } catch (e) { console.log(`${sym}: fetch SKIP (${e.message})`); continue; }
    if (!c15.length) { console.log(`${sym}: no TV klines`); continue; }
    c15 = c15.filter(b => b.time >= truth[0].time - 3 * BAR_MS && b.time <= truth[truth.length - 1].time + 12 * BAR_MS);

    console.log(`── ${sym} | ${truth.length} Expo labels | ${c15.length} 15m bars ──`);
    const cand = [
      ['naive pivot(10)', algoNaive(c15, 10)],
      ['alt pivot(8)',    algoAlt(c15, 8)],
      ['alt pivot(9)',    algoAlt(c15, 9)],
      ['alt pivot(10)',   algoAlt(c15, 10)],
      ['alt pivot(11)',   algoAlt(c15, 11)],
      ['alt pivot(12)',   algoAlt(c15, 12)],
    ];
    for (const [name, computed] of cand) {
      const s = score(computed, truth);
      const pct = (s.exact / s.truthN * 100).toFixed(0);
      console.log(`   ${name.padEnd(16)} exact ${String(s.exact).padStart(2)}/${s.truthN} (${pct.padStart(3)}%)  pos+${s.timeOnly}  computed=${s.compN}`);
    }
    console.log('');
    await sleep(500);
  }
  console.log('Goal: pick the algo with the highest exact-match %, then refine + port to Pine.\n');
}
main().catch(e => { console.error('failed:', e.message); process.exit(1); });
