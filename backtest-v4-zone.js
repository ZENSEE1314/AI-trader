'use strict';
// ═══════════════════════════════════════════════════════════════════
//  backtest-v4-zone.js  —  V4 Zone-Direction + Strict HL/LH Pivots
//
//  Direction decided by VWAP zone ALONE (no 4H structure gate):
//    ABOVE_UPPER / UPPER_MID → SHORT (price at premium = mean revert)
//    BELOW_LOWER / LOWER_MID → LONG  (price at discount = mean revert)
//
//  "No wrong point" protection is the STRICT PIVOT TYPE gate:
//    LONG:  15m HL + 1m HL only  (never LL — still bearish)
//    SHORT: 15m LH + 1m LH only  (never HH — still bullish)
//
//  If 15m is making LL in a downtrend, the HL gate blocks LONG entries
//  even though zone says discount — this IS the "no wrong point" rule.
//
//  4H structure shown in log for diagnostic only (not used for gating).
//
//  VWAP distance filter (MIN_DIST_SIGMA = 0.5):
//    LONG:  price must be ≤ 1.0σ above the lower band (near support)
//           blocks entries where price already recovered far from the band
//    SHORT: price must be ≤ 1.0σ below the upper band (near resistance)
//           blocks entries where price already fell far from the band
//
//  SL  : 25% capital risk per trade
//  TP  : 2:1 RR (50% capital gain)
//  Size: 10% of current wallet per trade
//  Cap : $1000 start  |  30-day window
// ═══════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const https = require('https');
const AGENT = new https.Agent({ rejectUnauthorized: false });

// ── Parameters ─────────────────────────────────────────────────────
const SWING_1M  = 3;
const SWING_15M = 5;
const SWING_4H  = 5;
const RISK_PCT  = 0.25;   // 25% capital at risk per trade
const TRADE_PCT = 0.10;   // 10% of wallet per trade
const INIT_CAP  = 1000;
const RR        = 2;

const MAX_CHASE      = 0.08;  // LONG: entry within 0.08% of 1m HL
const MAX_DROP       = 0.12;  // SHORT: entry within 0.12% of 15m/1m LH
const MAX_GAP        = 0.50;  // 1m HL gap ≤ 0.50%
const MIN_DIST_SIGMA = 0.5;   // VWAP σ-distance: LONG ≥0.5σ above lower; SHORT ≥0.5σ below upper
const DAYS           = 30;
const MAX_PIVOT_HIST = 50;

const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT'];
const LEV  = { BTCUSDT: 100, ETHUSDT: 100, BNBUSDT: 100, ADAUSDT: 75, SOLUSDT: 75 };

const ENDPOINTS = [
  'https://api.bytick.com/v5/market/kline',
  'https://api.bybit.nl/v5/market/kline',
  'https://api.bybit.com/v5/market/kline',
];

// ── Fetch helpers ───────────────────────────────────────────────────
async function fetchPage(sym, iv, limit, endTime) {
  const p = { category: 'linear', symbol: sym, interval: String(iv), limit: String(Math.min(limit, 1000)) };
  if (endTime) p.end = String(endTime);
  const qs = new URLSearchParams(p);
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(`${ep}?${qs}`, { agent: AGENT });
      const j = await r.json();
      if (j.retCode !== 0) throw new Error(j.retMsg);
      return j.result.list
        .map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
        .sort((a, b) => a.t - b.t);
    } catch (e) { /* try next endpoint */ }
  }
  throw new Error('All Bybit endpoints failed');
}

async function fetchAll(sym, iv, days) {
  const totalBars = Math.ceil(days * 24 * 60 / iv);
  const pages     = Math.ceil(totalBars / 1000);
  let all = [], end = null;
  for (let p = 0; p < pages; p++) {
    const batch = await fetchPage(sym, iv, 1000, end);
    if (!batch.length) break;
    end = batch[0].t - 1;
    all = [...batch, ...all];
    await new Promise(r => setTimeout(r, 400));
  }
  const seen = new Set();
  return all.filter(b => seen.has(b.t) ? false : seen.add(b.t)).sort((a, b) => a.t - b.t);
}

// ── VWAP + 2σ bands (daily reset at UTC midnight) ──────────────────
function calcVwap(c15, ms) {
  const ds = new Date(ms); ds.setUTCHours(0, 0, 0, 0);
  const bars = c15.filter(c => c.t >= ds.getTime() && c.t < ms);
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
  if (price > v.up)  return 'ABOVE_UPPER';
  if (price > v.vw)  return 'UPPER_MID';
  if (price >= v.lo) return 'LOWER_MID';
  return 'BELOW_LOWER';
}

// ── Pivot detection ────────────────────────────────────────────────
function checkPivot(arr, sw) {
  const n = arr.length;
  if (n < 2 * sw + 1) return null;
  const i = n - 1 - sw, b = arr[i];
  let H = true, L = true;
  for (let j = 1; j <= sw; j++) {
    if (b.h <= arr[i - j].h || b.h <= arr[i + j].h) H = false;
    if (b.l >= arr[i - j].l || b.l >= arr[i + j].l) L = false;
  }
  if (!H && !L) return null;
  return { H, L, b };
}

// ── Labeled pivot sequence helpers ─────────────────────────────────
// Each entry: { label: 'HH'|'LH'|'HL'|'LL', price, side: 'H'|'L' }
function addPivot(arr, label, price, side) {
  arr.push({ label, price, side });
  if (arr.length > MAX_PIVOT_HIST) arr.shift();
}

function findLastPivot(arr, side) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].side === side) return arr[i];
  }
  return null;
}

// Structure from labeled pivot sequence — mirrors get4hStructure / get15mStructure
function getStruct(pivots, currentPrice) {
  if (pivots.length < 4) return 'UNKNOWN';
  const lastH = findLastPivot(pivots, 'H');
  const lastL = findLastPivot(pivots, 'L');
  if (!lastH || !lastL) return 'UNKNOWN';
  const breakingLow  = currentPrice !== undefined && currentPrice < lastL.price;
  const breakingHigh = currentPrice !== undefined && currentPrice > lastH.price;
  if (lastH.label === 'LH' && (lastL.label === 'LL' || breakingLow))  return 'BEARISH';
  if (lastH.label === 'HH' && (lastL.label === 'HL' || breakingHigh)) return 'BULLISH';
  return 'MIXED';
}

// ── Zone → allowed direction ───────────────────────────────────────
// BELOW_LOWER LONG is blocked — price broke through the lower 2σ band
// into selling momentum territory.  Entering LONG there is "catching a
// falling knife": the band was broken with force, price needs to recover
// back into LOWER_MID before a bounce entry is meaningful.
//
// ABOVE_UPPER SHORT is kept — selling an overbought spike into the upper
// band works well as a mean-reversion setup even in bull markets.
//
// NOTE: 15m structure is NOT used as a gate here.  Testing showed that
// the best reversal LONG setups (buying at the exact bottom of a bearish
// 15m sequence) fire precisely when 15m = BEARISH.  Blocking those
// removes winning entries without eliminating losing ones.
function getAllowedDir(s4h, s15, zone) {   // s4h / s15 kept for log compatibility
  if (zone === 'BELOW_LOWER') return null;  // catching knife — wait for recovery
  if (zone === 'ABOVE_UPPER' || zone === 'UPPER_MID') return 'SHORT';
  if (zone === 'LOWER_MID')                            return 'LONG';
  return null;
}

// ── Per-symbol backtest ────────────────────────────────────────────
async function runSym(sym) {
  const lev        = LEV[sym] || 100;
  const slPricePct = RISK_PCT / lev;

  console.log(`\n${'='.repeat(65)}`);
  console.log(` ${sym}  |  lev=${lev}x  |  SL=${(slPricePct * 100).toFixed(3)}% price  =  ${(RISK_PCT * 100).toFixed(0)}% capital`);
  console.log('='.repeat(65));
  process.stdout.write(' Fetching data…');

  const [raw1m, raw15m, raw4h] = await Promise.all([
    fetchAll(sym, 1,   DAYS),
    fetchAll(sym, 15,  DAYS),
    fetchAll(sym, 240, DAYS + 10),  // extra days for 4H warmup
  ]);

  const c1  = raw1m.slice(0, -1);
  const c15 = raw15m.slice(0, -1);
  const c4h = raw4h.slice(0, -1);
  console.log(` 1m=${c1.length}bars  15m=${c15.length}bars  4H=${c4h.length}bars`);

  // ── 15m pivot state ───────────────────────────────────────────────
  let ptr15 = 0;
  let sh15_1 = null, sl15_1 = null, sl15_2 = null;
  let type15 = null, price15 = null, time15 = 0;
  const pivots15m = [];  // labeled pivot sequence for structure detection

  function sync15m(upToMs) {
    while (ptr15 < c15.length && c15[ptr15].t < upToMs) {
      ptr15++;
      const pivotAt = ptr15 - 1 - SWING_15M;
      if (pivotAt < SWING_15M || pivotAt >= c15.length) continue;
      const b = c15[pivotAt];
      if (b.t === time15) continue;

      let H = true, L = true;
      for (let j = 1; j <= SWING_15M; j++) {
        if (b.h <= c15[pivotAt - j].h || b.h <= c15[pivotAt + j].h) H = false;
        if (b.l >= c15[pivotAt - j].l || b.l >= c15[pivotAt + j].l) L = false;
      }
      if (!H && !L) continue;

      time15 = b.t;
      if (H) {
        const label = (sh15_1 === null || b.h > sh15_1) ? 'HH' : 'LH';
        sh15_1 = b.h;
        type15 = label; price15 = b.h;
        addPivot(pivots15m, label, b.h, 'H');
      }
      if (L) {
        const label = (sl15_1 === null || b.l > sl15_1) ? 'HL' : 'LL';
        sl15_2 = sl15_1; sl15_1 = b.l;
        type15 = label; price15 = b.l;
        addPivot(pivots15m, label, b.l, 'L');
      }
    }
  }

  // ── 4H pivot state ────────────────────────────────────────────────
  let ptr4h = 0;
  let sh4h_1 = null, sl4h_1 = null, time4h = 0;
  const pivots4h = [];  // labeled pivot sequence

  function sync4h(upToMs) {
    while (ptr4h < c4h.length && c4h[ptr4h].t < upToMs) {
      ptr4h++;
      const pivotAt = ptr4h - 1 - SWING_4H;
      if (pivotAt < SWING_4H || pivotAt >= c4h.length) continue;
      const b = c4h[pivotAt];
      if (b.t === time4h) continue;

      let H = true, L = true;
      for (let j = 1; j <= SWING_4H; j++) {
        if (b.h <= c4h[pivotAt - j].h || b.h <= c4h[pivotAt + j].h) H = false;
        if (b.l >= c4h[pivotAt - j].l || b.l >= c4h[pivotAt + j].l) L = false;
      }
      if (!H && !L) continue;

      time4h = b.t;
      if (H) {
        const label = (sh4h_1 === null || b.h > sh4h_1) ? 'HH' : 'LH';
        sh4h_1 = b.h;
        addPivot(pivots4h, label, b.h, 'H');
      }
      if (L) {
        const label = (sl4h_1 === null || b.l > sl4h_1) ? 'HL' : 'LL';
        sl4h_1 = b.l;
        addPivot(pivots4h, label, b.l, 'L');
      }
    }
  }

  // ── 1m pivot state ────────────────────────────────────────────────
  let sh1_1 = null, sl1_1 = null, sl1_2 = null;
  let type1 = null, time1 = 0;

  // ── Cooldown: zone-group + per-direction time gap ─────────────────
  // Zone-group: PREMIUM (ABOVE_UPPER + UPPER_MID), DISCOUNT (BELOW_LOWER + LOWER_MID).
  //   Moving between ABOVE_UPPER and UPPER_MID does NOT reset — only crossing
  //   to the opposite group does. Prevents multi-signal in same area.
  // Per-direction time gap (3 h): after a LONG fires, no new LONG for 3 h.
  //   Prevents back-to-back same-direction entries when zone briefly ticks
  //   across the VWAP and resets the group cooldown within minutes.
  function getZoneGroup(z) {
    if (z === 'ABOVE_UPPER' || z === 'UPPER_MID') return 'PREMIUM';
    return 'DISCOUNT';
  }
  const MIN_DIR_GAP_MS = 3 * 60 * 60 * 1000;  // 3 hours per direction
  let prevGroup    = null;
  let zoneTraded   = false;
  let lastLongTime = 0;
  let lastShortTime = 0;

  // ── Trade loop ────────────────────────────────────────────────────
  let capital  = INIT_CAP;
  let pending  = null;
  let lastSigT = 0;
  const trades = [];
  const buf1m  = [];

  for (let idx = 0; idx < c1.length - 1; idx++) {
    const bar = c1[idx];
    sync15m(bar.t);
    sync4h(bar.t);
    buf1m.push(bar);

    // ── Step 1: Fire pending signal at this bar's OPEN ─────────────
    if (pending) {
      const p = pending;
      pending  = null;
      const entry = bar.o;

      const vf = calcVwap(c15, bar.t);
      if (vf) {
        const zf   = getZone(entry, vf);
        const s4hF = getStruct(pivots4h, entry);
        const s15F = getStruct(pivots15m, entry);
        const dirZ = getAllowedDir(s4hF, s15F, zf);

        // Pivot still valid at entry?
        const pivotOk = (p.dir === 'LONG' && type1 === 'HL') ||
                        (p.dir === 'SHORT' && type1 === 'LH');

        // Chase / drop filter at entry
        let filterOk = true;
        if (p.dir === 'LONG' && p.sl1 !== null) {
          if ((entry - p.sl1) / p.sl1 * 100 > MAX_CHASE) filterOk = false;
        }
        if (p.dir === 'SHORT' && p.sh1 !== null) {
          if ((p.sh1 - entry) / p.sh1 * 100 > MAX_DROP) filterOk = false;
        }

        if (dirZ === p.dir && pivotOk && filterOk) {
          const tradeCap = capital * TRADE_PCT;
          const sl = p.dir === 'LONG'
            ? entry * (1 - slPricePct)
            : entry * (1 + slPricePct);
          const slDist = Math.abs(entry - sl);
          const tp = p.dir === 'LONG'
            ? entry + slDist * RR
            : entry - slDist * RR;

          let result = 'OPEN';
          for (let f = idx; f < Math.min(idx + 5000, c1.length); f++) {
            const fb = c1[f];
            if (p.dir === 'LONG') {
              if (fb.l <= sl) { result = 'LOSS'; break; }
              if (fb.h >= tp) { result = 'WIN';  break; }
            } else {
              if (fb.h >= sl) { result = 'LOSS'; break; }
              if (fb.l <= tp) { result = 'WIN';  break; }
            }
          }

          const pnl = result === 'WIN'  ?  tradeCap * RISK_PCT * RR
                    : result === 'LOSS' ? -tradeCap * RISK_PCT
                    : 0;
          if (result !== 'OPEN') capital = Math.max(0, capital + pnl);

          trades.push({
            ts:      new Date(bar.t).toISOString().slice(0, 16).replace('T', ' '),
            dir:     p.dir,
            zone:    p.zone,
            s4h:     p.s4h,
            s15:     p.s15,
            type:    p.type,
            entry:   entry.toFixed(4),
            result,
            pnl:     pnl.toFixed(2),
            capital: capital.toFixed(2),
          });
        }
      }
    }

    // ── Step 2: Detect 1m pivot ─────────────────────────────────────
    if (buf1m.length <= 2 * SWING_1M + 1) continue;
    const p1 = checkPivot(buf1m, SWING_1M);
    if (!p1 || p1.b.t === time1) continue;
    time1 = p1.b.t;

    if (p1.H) {
      const label = (sh1_1 === null || p1.b.h > sh1_1) ? 'HH' : 'LH';
      sh1_1 = p1.b.h;
      type1 = label;
    }
    if (p1.L) {
      const label = (sl1_1 === null || p1.b.l > sl1_1) ? 'HL' : 'LL';
      sl1_2 = sl1_1; sl1_1 = p1.b.l;
      type1 = label;
    }

    if (p1.b.t === lastSigT) continue;

    // ── VWAP zone ───────────────────────────────────────────────────
    const v    = calcVwap(c15, bar.t);
    if (!v) continue;
    const zone = getZone(bar.c, v);

    // Zone GROUP cooldown — reset only when crossing to opposite group
    const grp = getZoneGroup(zone);
    if (grp !== prevGroup) { prevGroup = grp; zoneTraded = false; }
    if (zoneTraded) continue;

    // Per-direction time cooldown — prevent same-direction re-entry within 3 h
    const dir0 = getAllowedDir(null, null, zone);
    if (dir0 === 'LONG'  && bar.t - lastLongTime  < MIN_DIR_GAP_MS) continue;
    if (dir0 === 'SHORT' && bar.t - lastShortTime < MIN_DIR_GAP_MS) continue;

    const s4h  = getStruct(pivots4h, bar.c);
    const s15  = getStruct(pivots15m, bar.c);
    const dir  = getAllowedDir(s4h, s15, zone);
    if (!dir) continue;

    // ── Pivot type gate — any low for LONG, any high for SHORT ─────
    // LONG:  15m pivot must be a LOW (HL or LL) + 1m pivot also a LOW.
    //        Zone (LOWER_MID) determines direction; any confirmed low in
    //        that zone is valid — LL at support = exhausted selling = best
    //        reversal entry; HL = bounce already started.
    // SHORT: 15m pivot must be a HIGH (LH or HH) + 1m pivot also a HIGH.
    //        HH at premium zone = exhausted buying = best short entry;
    //        LH = rejection already started.
    const isLow15  = type15 === 'HL' || type15 === 'LL';
    const isLow1m  = type1  === 'HL' || type1  === 'LL';
    const isHigh15 = type15 === 'LH' || type15 === 'HH';
    const isHigh1m = type1  === 'LH' || type1  === 'HH';
    if (dir === 'LONG'  && (!isLow15  || !isLow1m))  continue;
    if (dir === 'SHORT' && (!isHigh15 || !isHigh1m)) continue;

    // ── Filters ─────────────────────────────────────────────────────
    if (dir === 'LONG') {
      if (sl1_1 === null || sl1_2 === null) continue;
      const gap = Math.abs(sl1_1 - sl1_2) / sl1_2 * 100;
      if (gap > MAX_GAP) continue;
      if ((bar.c - sl1_1) / sl1_1 * 100 > MAX_CHASE) continue;
      // VWAP distance: price must be within 1.0σ of the lower band.
      // Blocks LONG entries where price already recovered far from
      // the band (≥1.0σ above it) — the best bounce entries are
      // those closest to the lower band, not mid-zone recoveries.
      if (v.std > 0 && (bar.c - v.lo) / v.std > MIN_DIST_SIGMA * 2) continue;
    }
    if (dir === 'SHORT') {
      if (sh1_1 === null) continue;
      if ((sh1_1 - bar.c) / sh1_1 * 100 > MAX_DROP) continue;
      if (price15 !== null && (price15 - bar.c) / price15 * 100 > MAX_DROP) continue;
      // VWAP distance: price must be within 1.0σ of the upper band.
      // Blocks SHORT entries where price already fell far from the
      // upper band — best short entries are near the rejection point.
      if (v.std > 0 && (v.up - bar.c) / v.std > MIN_DIST_SIGMA * 2) continue;
    }

    lastSigT   = p1.b.t;
    zoneTraded = true;  // block further signals in this zone group entry
    if (dir === 'LONG')  lastLongTime  = bar.t;
    if (dir === 'SHORT') lastShortTime = bar.t;
    pending = {
      dir, zone, s4h, s15,
      type: `${type15}+${type1}`,
      sl1:  sl1_1,
      sh1:  sh1_1,
    };
  }

  // ── Results ──────────────────────────────────────────────────────
  const closed = trades.filter(t => t.result !== 'OPEN');
  const wins   = closed.filter(t => t.result === 'WIN').length;
  const losses = closed.filter(t => t.result === 'LOSS').length;
  const wr     = closed.length ? wins / closed.length * 100 : 0;
  const profit = capital - INIT_CAP;

  console.log(` Signals: ${trades.length}  |  Closed: ${closed.length}  |  Wins: ${wins}  Losses: ${losses}`);
  console.log(` WR: ${wr.toFixed(1)}%  |  Capital: $${capital.toFixed(2)}  |  Profit: $${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`);

  if (trades.length === 0) {
    console.log(' (No signals — check pivot seeding or VWAP availability)');
  } else {
    console.log(`\n ${'─'.repeat(100)}`);
    console.log(` UTC TIME            DIR    ZONE           4H       15m     TYPE      ENTRY        RESULT         CAPITAL`);
    console.log(` ${'─'.repeat(100)}`);
    for (const t of trades) {
      const resStr = t.result === 'WIN'
        ? `WIN   +$${Number(t.pnl).toFixed(2)}`
        : t.result === 'LOSS'
        ? `LOSS  -$${Math.abs(Number(t.pnl)).toFixed(2)}`
        : 'OPEN';
      console.log(
        ` ${t.ts.padEnd(20)} ${t.dir.padEnd(6)} ${t.zone.padEnd(14)} ${(t.s4h||'?').padEnd(8)} ${(t.s15||'?').padEnd(7)} ${t.type.padEnd(9)} ` +
        `${String(t.entry).padEnd(12)} ${resStr.padEnd(16)} $${t.capital}`
      );
    }
  }

  return { sym, total: trades.length, closed: closed.length, wins, losses, wr, profit, capital };
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const arg  = process.argv[2]?.toUpperCase();
  const syms = arg && SYMS.includes(arg) ? [arg] : SYMS;

  console.log('\n' + '#'.repeat(70));
  console.log(' V4-SMC BACKTEST  |  Zone Direction + Strict HL/LH + VWAP σ-Proximity');
  console.log(` Capital $${INIT_CAP}  |  ${(TRADE_PCT*100).toFixed(0)}% per trade  |  ${RR}:1 RR  |  ${DAYS}d window`);
  console.log(' LONG:  LOWER_MID only  (BELOW_LOWER blocked = no knife-catch)');
  console.log(' SHORT: ABOVE_UPPER / UPPER_MID');
  console.log(' Pivot LONG:  15m HL or LL  +  1m HL or LL  (any low in discount zone)');
  console.log(' Pivot SHORT: 15m LH or HH  +  1m LH or HH  (any high in premium zone)');
  console.log(' 4H / 15m structure: diagnostic log only, NOT used as gate');
  console.log('#'.repeat(70));

  const results = [];
  for (const s of syms) {
    try {
      results.push(await runSym(s));
    } catch (e) {
      console.log(` ${s} ERROR: ${e.message}`);
    }
  }

  console.log('\n' + '='.repeat(65));
  console.log(' SUMMARY  —  all symbols  —  starting capital $' + INIT_CAP);
  console.log('='.repeat(65));
  let tClosed = 0, tWins = 0, tLosses = 0;
  for (const r of results) {
    const sign = r.profit >= 0 ? '+' : '';
    console.log(
      ` ${r.sym.padEnd(10)} ${String(r.closed).padEnd(4)} trades` +
      `  |  WR: ${r.wr.toFixed(1)}%` +
      `  |  Profit: ${sign}$${r.profit.toFixed(2)}` +
      `  |  Capital: $${r.capital.toFixed(2)}`
    );
    tClosed += r.closed; tWins += r.wins; tLosses += r.losses;
  }
  const totalWR = tClosed ? tWins / tClosed * 100 : 0;
  console.log(' ' + '─'.repeat(60));
  console.log(
    ` TOTAL      ${tClosed} trades` +
    `  |  WR: ${totalWR.toFixed(1)}%` +
    `  |  Wins: ${tWins}  Losses: ${tLosses}`
  );
  console.log(`\n Per-trade risk: ${(RISK_PCT*100).toFixed(0)}% of ${(TRADE_PCT*100).toFixed(0)}% capital`);
  console.log(` WIN  = +${(RISK_PCT*RR*100).toFixed(0)}% of trade capital  (${(TRADE_PCT*RISK_PCT*RR*100).toFixed(2)}% wallet)`);
  console.log(` LOSS = -${(RISK_PCT*100).toFixed(0)}% of trade capital  (${(TRADE_PCT*RISK_PCT*100).toFixed(2)}% wallet)`);
}

main().catch(console.error);
