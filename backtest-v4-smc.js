// ════════════════════════════════════════════════════════════════
//  backtest-v4-smc.js
//  Replays the CURRENT strategy-v4-smc.js rules on historical klines:
//    - Trend continuation: SHORT below VWAP mid, LONG above
//    - Hard direction guard: cleanBull / cleanBear on both 1m + 15m
//    - 0.10% chase from 1m pivot (LH for SHORT, HL for LONG)
//    - 1.5% max 1m HL/LL gap
//    - Initial SL = 25% capital (CAPITAL_RISK / leverage)
//    - 4h same-symbol cooldown after a LOSS (matches live)
//    - 25% SL / 50% TP (2:1 RR) — matches the live strategy fixed exit
//
//  Fetches via Bybit linear (multi-endpoint fallback). Posts a per-
//  symbol summary + aggregate. ~30 days lookback by default.
// ════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');
const https = require('https');
const AGENT = new https.Agent({ rejectUnauthorized: false });

const SYMS  = (process.env.SYMS || 'BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT,SOLUSDT').split(',');
const DAYS  = parseInt(process.env.DAYS || '30', 10);
const LEV   = { BTCUSDT: 100, ETHUSDT: 100, BNBUSDT: 50, ADAUSDT: 50, SOLUSDT: 50 };

// Exact constants from strategy-v4-smc.js
const SWING_BARS_1M  = 3;
const SWING_BARS_15M = 3;
const MAX_CHASE_PCT  = 0.10;
const MAX_1M_GAP_PCT = 1.5;
const CAPITAL_RISK   = 0.25;          // 25% capital per trade
const LOSS_COOLDOWN  = 4 * 3600 * 1000; // 4h after loss
const TP_RR          = 2;              // 2:1 reward:risk

const BYBIT_ENDPOINTS = [
  'https://api.bybit.com/v5/market/kline',
  'https://api.bytick.com/v5/market/kline',
  'https://api.bybit.nl/v5/market/kline',
];
let BYBIT_OK = BYBIT_ENDPOINTS[0];

async function get(sym, interval, limit, end) {
  const params = { category: 'linear', symbol: sym, interval: String(interval), limit: String(Math.min(limit, 1000)) };
  if (end) params.end = String(end);
  const qs = new URLSearchParams(params);
  let lastErr;
  for (const ep of BYBIT_ENDPOINTS) {
    try {
      const r = await fetch(`${ep}?${qs}`, { agent: AGENT });
      const j = JSON.parse(await r.text());
      if (j.retCode !== 0) throw new Error(j.retMsg);
      if (ep !== BYBIT_OK) { BYBIT_OK = ep; console.log(` [DNS] switched to ${ep}`); }
      return j.result.list
        .map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
        .sort((a, b) => a.t - b.t);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function getMany(sym, interval, totalBars) {
  let all = [], end = null;
  for (let p = 0; p < Math.ceil(totalBars / 1000); p++) {
    const b = await get(sym, interval, 1000, end);
    if (!b.length) break;
    end = b[0].t - 1;
    all = [...b, ...all];
    await new Promise(r => setTimeout(r, 350));
  }
  const seen = new Set();
  return all.filter(b => seen.has(b.t) ? false : seen.add(b.t)).sort((a, b) => a.t - b.t);
}

function calcVwap(c15, asOfMs) {
  const day = new Date(asOfMs); day.setUTCHours(0, 0, 0, 0);
  const bars = c15.filter(c => c.t >= day.getTime() && c.t < asOfMs);
  if (bars.length < 2) return null;
  let tv = 0, tv2 = 0, vol = 0;
  for (const c of bars) {
    const tp = (c.h + c.l + c.c) / 3;
    tv += tp * c.v; tv2 += tp * tp * c.v; vol += c.v;
  }
  if (!vol) return null;
  const vw = tv / vol;
  const std = Math.sqrt(Math.max(0, tv2 / vol - vw * vw));
  return { vw, up: vw + 2 * std, lo: vw - 2 * std, std };
}

function getZone(price, v) {
  if (price > v.up)   return 'ABOVE_UPPER';
  if (price > v.vw)   return 'UPPER_MID';
  if (price >= v.lo)  return 'LOWER_MID';
  return 'BELOW_LOWER';
}

// Confirmed pivot: middle bar of [i-sw .. i .. i+sw] is local extreme
function checkPivot(slice, sw) {
  const n = slice.length;
  if (n < 2 * sw + 1) return null;
  const i = n - 1 - sw;
  const b = slice[i];
  let isHigh = true, isLow = true;
  for (let j = 1; j <= sw; j++) {
    if (b.h <= slice[i - j].h || b.h <= slice[i + j].h) isHigh = false;
    if (b.l >= slice[i - j].l || b.l >= slice[i + j].l) isLow  = false;
  }
  return (isHigh || isLow) ? { isHigh, isLow, bar: b } : null;
}

async function run(sym) {
  const lev    = LEV[sym] || 100;
  const slPct  = CAPITAL_RISK / lev; // price-distance fraction
  const tpPct  = slPct * TP_RR;

  console.log('\n' + '═'.repeat(72));
  console.log(` ${sym}  |  ${lev}x  |  SL=${(slPct * 100).toFixed(3)}%  TP=${(tpPct * 100).toFixed(3)}%  (${DAYS}d)`);
  console.log('═'.repeat(72));

  const need1m = DAYS * 1440 + 200;
  const need15 = DAYS * 96   + 200;
  console.log(' Fetching klines…');
  const [r1, r15] = await Promise.all([getMany(sym, 1, need1m), getMany(sym, 15, need15)]);
  console.log(` 1m: ${r1.length}  15m: ${r15.length}`);
  if (r1.length < 2 * SWING_BARS_1M + 100) { console.log(' Not enough data'); return null; }

  const c1  = r1.slice(0, -1);   // closed bars only
  const c15 = r15.slice(0, -1);

  // Pre-compute all 15m pivots (rolling — most recent confirmed)
  let sh15_2 = null, sh15_1 = null, sl15_2 = null, sl15_1 = null;
  let pivotsBy15Time = new Map();
  for (let i = 2 * SWING_BARS_15M; i < c15.length; i++) {
    const slice = c15.slice(i - 2 * SWING_BARS_15M, i + 1);
    const pv = checkPivot(slice, SWING_BARS_15M);
    if (pv) {
      if (pv.isHigh) { sh15_2 = sh15_1; sh15_1 = pv.bar.h; }
      if (pv.isLow)  { sl15_2 = sl15_1; sl15_1 = pv.bar.l; }
    }
    pivotsBy15Time.set(c15[i].t, { sh15_1, sh15_2, sl15_1, sl15_2 });
  }
  function get15PivotsAt(ts) {
    // Latest confirmed 15m pivot snapshot at-or-before ts
    let last = null;
    for (const [t, p] of pivotsBy15Time) {
      if (t <= ts) last = p; else break;
    }
    return last;
  }

  let sh1m_2 = null, sh1m_1 = null, sl1m_2 = null, sl1m_1 = null;
  const trades = [];
  let lossCooldownUntil = 0;
  let openTrade = null;
  const skipReasons = { chase: 0, gap: 0, dirty: 0, zone: 0, cooldown: 0, vwap_missing: 0 };

  for (let idx = 2 * SWING_BARS_1M; idx < c1.length - 1; idx++) {
    const bar = c1[idx];

    // Update 1m pivots from this bar's confirmation window
    const slice1m = c1.slice(idx - 2 * SWING_BARS_1M, idx + 1);
    const pv = checkPivot(slice1m, SWING_BARS_1M);
    if (pv) {
      if (pv.isHigh) { sh1m_2 = sh1m_1; sh1m_1 = pv.bar.h; }
      if (pv.isLow)  { sl1m_2 = sl1m_1; sl1m_1 = pv.bar.l; }
    }

    // Manage open trade — check intraday SL/TP touches on this bar
    if (openTrade) {
      const slHit = openTrade.dir === 'LONG' ? bar.l <= openTrade.sl : bar.h >= openTrade.sl;
      const tpHit = openTrade.dir === 'LONG' ? bar.h >= openTrade.tp : bar.l <= openTrade.tp;
      if (slHit) {
        openTrade.out = 'LOSS';
        openTrade.exit = openTrade.sl;
        openTrade.closedAt = bar.t;
        lossCooldownUntil = bar.t + LOSS_COOLDOWN;
        trades.push(openTrade); openTrade = null;
      } else if (tpHit) {
        openTrade.out = 'WIN';
        openTrade.exit = openTrade.tp;
        openTrade.closedAt = bar.t;
        trades.push(openTrade); openTrade = null;
      }
    }
    if (openTrade) continue;

    // Cooldown after a loss
    if (bar.t < lossCooldownUntil) { skipReasons.cooldown++; continue; }

    // VWAP at this bar's open time
    const v = calcVwap(c15, bar.t);
    if (!v) { skipReasons.vwap_missing++; continue; }
    const zone = getZone(bar.c, v);

    const p15 = get15PivotsAt(bar.t);
    if (!p15) continue;
    const { sh15_1: SH15_1, sh15_2: SH15_2, sl15_1: SL15_1, sl15_2: SL15_2 } = p15;

    // ── Structure
    const hh15 = SH15_1 != null && SH15_2 != null && SH15_1 > SH15_2;
    const lh15 = SH15_1 != null && SH15_2 != null && SH15_1 < SH15_2;
    const hl15 = SL15_1 != null && SL15_2 != null && SL15_1 > SL15_2;
    const ll15 = SL15_1 != null && SL15_2 != null && SL15_1 < SL15_2;
    const hh1m = sh1m_1 != null && sh1m_2 != null && sh1m_1 > sh1m_2;
    const lh1m = sh1m_1 != null && sh1m_2 != null && sh1m_1 < sh1m_2;
    const hl1m = sl1m_1 != null && sl1m_2 != null && sl1m_1 > sl1m_2;
    const ll1m = sl1m_1 != null && sl1m_2 != null && sl1m_1 < sl1m_2;

    const cleanBull15 = (hh15 || hl15) && !lh15 && !ll15;
    const cleanBear15 = (ll15 || lh15) && !hh15 && !hl15;
    const cleanBull1m = (hh1m || hl1m) && !lh1m && !ll1m;
    const cleanBear1m = (ll1m || lh1m) && !hh1m && !hl1m;

    let dir = null;

    // SHORT — below VWAP mid, clean bear, within 0.10% of 1m LH
    if ((zone === 'LOWER_MID' || zone === 'BELOW_LOWER') && cleanBear15 && cleanBear1m) {
      if (sh1m_1 == null) { continue; }
      const chase = (sh1m_1 - bar.c) / sh1m_1 * 100;
      if (chase > MAX_CHASE_PCT) { skipReasons.chase++; continue; }
      dir = 'SHORT';
    }
    // LONG — above VWAP mid, clean bull, within 0.10% of 1m HL + gap ok
    else if ((zone === 'ABOVE_UPPER' || zone === 'UPPER_MID') && cleanBull15 && cleanBull1m) {
      if (sl1m_1 == null || sl1m_2 == null) { continue; }
      const gap = Math.abs(sl1m_1 - sl1m_2) / sl1m_2 * 100;
      if (gap > MAX_1M_GAP_PCT) { skipReasons.gap++; continue; }
      const chase = (bar.c - sl1m_1) / sl1m_1 * 100;
      if (chase > MAX_CHASE_PCT) { skipReasons.chase++; continue; }
      dir = 'LONG';
    } else if (cleanBull15 || cleanBear15) {
      // had structure but wrong zone
      skipReasons.zone++;
      continue;
    } else {
      skipReasons.dirty++;
      continue;
    }

    if (!dir) continue;

    // Enter at NEXT bar open
    const next = c1[idx + 1];
    const entry = next.o;
    const sl = dir === 'LONG' ? entry * (1 - slPct) : entry * (1 + slPct);
    const tp = dir === 'LONG' ? entry * (1 + tpPct) : entry * (1 - tpPct);
    openTrade = {
      ts: bar.t, openedAt: next.t, dir, entry, sl, tp,
      zone, type: dir === 'LONG' ? 'cleanBull' : 'cleanBear',
    };
  }

  // Stats
  const closed = trades;
  const wins = closed.filter(t => t.out === 'WIN').length;
  const losses = closed.filter(t => t.out === 'LOSS').length;
  const total = closed.length;
  const wr = total ? (wins / total) * 100 : 0;

  // PnL in $ on $1000 capital, 25% risk, 2:1 RR.
  // Per-trade $ outcome: LOSS = -$1000 * 0.25 = -$250 (gross, fees ignored)
  //                     WIN  = +$1000 * 0.25 * 2 = +$500
  const winDollars  = wins   * 500;
  const lossDollars = losses * 250;
  const netUsd = winDollars - lossDollars;
  // Capital % return (per-trade pct on margin, summed)
  const totalPctReturn = closed.reduce((s, t) => s + (t.out === 'WIN' ? CAPITAL_RISK * TP_RR * 100 : -CAPITAL_RISK * 100), 0);

  console.log(` Trades:${total}  W:${wins}  L:${losses}  WR:${wr.toFixed(1)}%  Net:$${netUsd}  (${totalPctReturn.toFixed(0)}% on $1000)`);
  console.log(` Skipped: chase=${skipReasons.chase} gap=${skipReasons.gap} dirty=${skipReasons.dirty} zone=${skipReasons.zone} cooldown=${skipReasons.cooldown} vwap=${skipReasons.vwap_missing}`);

  if (closed.length) {
    const last = closed.slice(-10);
    console.log(' Last 10 trades:');
    console.log('  TIME(UTC)            DIR    ZONE         ENTRY           OUT');
    for (const t of last) {
      const ts = new Date(t.openedAt).toISOString().replace('T', ' ').slice(0, 16);
      const r = t.out === 'WIN' ? 'WIN  +50%cap' : 'LOSS -25%cap';
      console.log(`  ${ts}  ${t.dir.padEnd(5)}  ${t.zone.padEnd(11)}  ${String(t.entry.toFixed(5)).padEnd(14)}  ${r}`);
    }
  }

  return { sym, total, wins, losses, wr, netUsd, totalPctReturn, skipReasons };
}

(async () => {
  console.log('\n' + '#'.repeat(72));
  console.log(` v4-smc backtest — ${SYMS.join(',')} — ${DAYS}d`);
  console.log(` Rules: trend-cont (SHORT<VWAP, LONG>VWAP) | clean direction guard`);
  console.log(` chase 0.10% | gap 1.5% | SL=25%cap | TP=50%cap (2:1) | 4h loss CD`);
  console.log('#'.repeat(72));

  const results = [];
  for (const s of SYMS) {
    try { const r = await run(s); if (r) results.push(r); }
    catch (e) { console.log(` ${s} ERR: ${e.message}`); }
  }

  let T = 0, W = 0, L = 0, USD = 0;
  console.log('\n' + '═'.repeat(72));
  console.log(' AGGREGATE SUMMARY');
  console.log('═'.repeat(72));
  console.log('  SYM          TRADES   W    L    WR     NET $        ');
  console.log('  ' + '-'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.sym.padEnd(11)}  ${String(r.total).padStart(5)}  ${String(r.wins).padStart(3)}  ${String(r.losses).padStart(3)}  ${r.wr.toFixed(1).padStart(5)}%  $${String(r.netUsd).padStart(7)}`);
    T += r.total; W += r.wins; L += r.losses; USD += r.netUsd;
  }
  const overallWR = T ? (W / T * 100).toFixed(1) : '0.0';
  console.log('  ' + '-'.repeat(60));
  console.log(`  ALL          ${String(T).padStart(5)}  ${String(W).padStart(3)}  ${String(L).padStart(3)}  ${overallWR.padStart(5)}%  $${String(USD).padStart(7)}`);
  console.log('═'.repeat(72));
  console.log(` On $1000 capital × ${DAYS}d: ${USD >= 0 ? '+' : ''}$${USD}  →  ${(USD / 1000 * 100).toFixed(1)}% return`);
})().catch(e => { console.error(e); process.exit(1); });
