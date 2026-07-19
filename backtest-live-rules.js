'use strict';

// ============================================================
// backtest-live-rules.js — Backtest of the LIVE strategy rules
//
// Replicates what the bot does RIGHT NOW (HEAD), per token:
//
//   1. SWEEP  (agents/sweep-watcher.js) — BTC/ETH/SOL, 20x
//      Entry: 15m swing pivot (L10/R1) = liquidity level. First bar that
//      breaches a level but CLOSES back on the safe side (sweep+reclaim)
//      → market entry with the reversal, gated by
//        G1: sweep-bar volume < 0.8x its 20-bar average   (VOL_TH)
//        G2: taker flow in trade direction < 45%          (AGGR_TH)
//      Risk : hard SL -50% of margin  (2.5% price at 20x)
//             + ETH sweeps ONLY: hard TP +35% of margin (1.75% price)
//             (ETH_SWEEP_TP_MARGIN, the HEAD commit)
//      Exit : 15m structure labels — LONG closes on HH/LH, SHORT on LL/HL.
//      One evaluation per level, 30-min cooldown per symbol+direction.
//
//   2. LABEL  (agents/expo-watcher.js, setup EXPO_BASELINE) — BTC/SOL, 50x
//      Signal: fresh 15m structure label (HL=long / LH=short)
//      Gates : VWAP location gate + power gate on the label's pivot bar
//              (taker flow in direction >= 55% "rejected" OR < 35% "trapped")
//      Entry : first pullback within the entry window — approximated here as
//              the label-confirm bar close (window is only 5 min).
//      Risk  : hard SL -50% of margin (1.0% price at 50x), no TP, structure exits.
//
// Money model (mirrors cycle.js): margin = 10% of wallet per trade,
// notional = margin x leverage, taker fee 0.04% per side. $1000/token.
//
// DATA: Binance USDT 15m klines (spot mirror data-api.binance.vision or
// fapi cache) — same rows the live bot reads for its flow gates.
// Cache files: data/backtest-cache/<SYM>-15m.json  (Binance kline arrays)
//
//   OFFLINE=1 node backtest-live-rules.js            # use cache only
//   DAYS=30 node backtest-live-rules.js              # fetch live + backtest
//   TRADES=1 node backtest-live-rules.js             # also print every trade
//
// Approximations to be aware of:
//   - Structure labels are rebuilt natively (L10/R1, visible at confirm-bar
//     close). The live bot reads them from TradingView SMC-Expo; timing can
//     differ by a bar or two.
//   - Spot klines stand in for USDT-M perp klines (basis <0.1%); taker ratio
//     is spot flow (live uses futures flow) — highly correlated, direction-safe.
//   - Label-strategy entry = confirm-bar close (live scans 1m for a pullback
//     within 5 min of the label — entry lands inside the same bar).
//   - One open position per symbol per strategy (sweep + label can coexist).
// ============================================================

const fs = require('fs');
const path = require('path');

// ── Config (live values) ───────────────────────────────────────
const DAYS          = Number(process.env.DAYS || 10);
const SYMBOLS       = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim());
const LABEL_SYMBOLS = new Set((process.env.LABEL_SYMBOLS || 'BTCUSDT,SOLUSDT').split(',').map(s => s.trim()));
const START_EQUITY  = Number(process.env.START_EQUITY || 1000);   // per token per account
const MARGIN_PCT    = 0.10;     // 10% of wallet = margin per trade (cycle.js)
const FEE_SIDE      = 0.0004;   // 0.04% taker per side (cycle.js comment)

const SWEEP_LEV     = 20;                          // sweep-watcher.js
const SL_MARGIN     = 0.50;                        // -50% of margin (both strategies)
const ETH_SWEEP_TP  = Number(process.env.ETH_SWEEP_TP_MARGIN ?? 0.35); // HEAD commit: ETH sweeps only
const VOL_TH        = 0.8;                         // sweep gate 1
const AGGR_TH       = 0.45;                        // sweep gate 2
const EXPO_LEV      = Number(process.env.EXPO_LEVERAGE || 50);   // expo-watcher.js
const POWER_TH      = 0.55;                        // label power gate high wing
const POWER_LOW_TH  = 0.35;                        // label power gate low wing

const SWING_LEN = 10, CONFIRM = 1;                 // pivot L10/R1 (both watchers)
const COOLDOWN_MS = 30 * 60 * 1000;                // 30 min per symbol per direction
const BAR_MS = 15 * 60 * 1000;

const DATA_DIR = path.join(__dirname, 'data', 'backtest-cache');
const OFFLINE  = process.env.OFFLINE === '1';
const VERBOSE  = process.env.TRADES === '1';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Data loading ───────────────────────────────────────────────
function loadCache(sym) {
  const file = path.join(DATA_DIR, `${sym}-15m.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.map(r => ({
    t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4],
    v: +r[5], tb: +r[9], // field 9 = taker-buy base volume
  })).filter(b => Number.isFinite(b.c));
}

async function fetchLive(sym, days) {
  const total = Math.ceil(days * 96) + 2;
  const all = [];
  let end = Date.now();
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=${limit}&endTime=${end}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${sym} HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    all.unshift(...rows);
    end = +rows[0][0] - 1;
    await sleep(250);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `${sym}-15m.json`), JSON.stringify(all.slice(-total)));
  return all.slice(-total).map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], tb: +r[9] }));
}

async function getCandles(sym) {
  const cached = loadCache(sym);
  if (cached && cached.length) return cached;
  if (OFFLINE) throw new Error(`no cache for ${sym} (data/backtest-cache/${sym}-15m.json)`);
  return fetchLive(sym, DAYS);
}

// ── Structure engine (exact port of sweep-watcher.js) ──────────
function findPivots(bars) {
  const pivots = [];
  for (let i = SWING_LEN; i < bars.length - CONFIRM; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= SWING_LEN && (isH || isL); k++) {
      if (isH && !(bars[i].h > bars[i - k].h)) isH = false;
      if (isL && !(bars[i].l < bars[i - k].l)) isL = false;
    }
    for (let k = 1; k <= CONFIRM && (isH || isL); k++) {
      if (isH && !(bars[i].h > bars[i + k].h)) isH = false;
      if (isL && !(bars[i].l < bars[i + k].l)) isL = false;
    }
    if (isH) pivots.push({ kind: 'H', i, price: bars[i].h, time: bars[i].t });
    if (isL) pivots.push({ kind: 'L', i, price: bars[i].l, time: bars[i].t });
  }
  return pivots;
}

// HH/HL/LH/LL sequence; a label is VISIBLE at the close of pivotIdx + CONFIRM
// (live: Expo draws it within the watcher's poll cadence after confirmation).
function buildLabels(bars, pivots) {
  const labels = [];
  let prevHigh = null, prevLow = null;
  for (const p of pivots) {
    let type = null;
    if (p.kind === 'H') { type = prevHigh == null ? null : (p.price > prevHigh ? 'HH' : 'LH'); prevHigh = p.price; }
    else               { type = prevLow  == null ? null : (p.price > prevLow  ? 'HL' : 'LL'); prevLow  = p.price; }
    if (type) labels.push({ type, pivotIdx: p.i, pivotTime: p.time, price: p.price, visibleIdx: p.i + CONFIRM });
  }
  return labels;
}

// Session VWAP ±2σ, anchored daily at UTC (expo-watcher.js computeVwapBands)
function computeVwapBands(bars) {
  const v2u = new Array(bars.length).fill(null);
  const v2d = new Array(bars.length).fill(null);
  const mid = new Array(bars.length).fill(null);
  let day = null, tpv = 0, vol = 0, tpv2 = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor(bars[i].t / 86400000);
    if (d !== day) { day = d; tpv = 0; vol = 0; tpv2 = 0; }
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    const v = bars[i].v || 0;
    tpv += tp * v; vol += v; tpv2 += tp * tp * v;
    if (vol > 0) {
      const vw = tpv / vol;
      const sd = Math.sqrt(Math.max(0, tpv2 / vol - vw * vw));
      mid[i] = vw; v2u[i] = vw + 2 * sd; v2d[i] = vw - 2 * sd;
    }
  }
  return { v2u, v2d, mid };
}

// ── Accounts ───────────────────────────────────────────────────
class Account {
  constructor(sym, strategy, lev, tpMargin) {
    this.sym = sym;
    this.strategy = strategy;           // 'SWEEP' | 'LABEL'
    this.lev = lev;
    this.tpMargin = tpMargin || 0;      // hard TP as fraction of margin (ETH sweep only)
    this.slPricePct = Math.min(SL_MARGIN / lev, (1 / lev) * 0.80); // liq guard
    this.tpPricePct = tpMargin > 0 ? tpMargin / lev : 0;
    this.equity = START_EQUITY;
    this.peak = START_EQUITY;
    this.maxDD = 0;
    this.pos = null;                    // { dir, entry, entryIdx, entryT, sl, tp }
    this.trades = [];
    this.lastTradeAt = { LONG: 0, SHORT: 0 };
  }

  canEnter(dir, t) {
    return !this.pos && (t - this.lastTradeAt[dir]) > COOLDOWN_MS;
  }

  enter(dir, idx, t, price, tag) {
    const margin = this.equity * MARGIN_PCT;
    const notional = margin * this.lev;
    const isLong = dir === 'LONG';
    this.pos = {
      dir, entry: price, entryIdx: idx, entryT: t, tag,
      margin, notional,
      sl: isLong ? price * (1 - this.slPricePct) : price * (1 + this.slPricePct),
      tp: this.tpPricePct ? (isLong ? price * (1 + this.tpPricePct) : price * (1 - this.tpPricePct)) : null,
    };
    this.lastTradeAt[dir] = t;
  }

  // Exit at a hard price (SL / TP) or market close (structure / EOD)
  closeAt(idx, t, exitPrice, reason) {
    const p = this.pos;
    if (!p) return;
    const move = p.dir === 'LONG' ? (exitPrice - p.entry) / p.entry : (p.entry - exitPrice) / p.entry;
    const gross = p.notional * move;
    const fees = p.notional * FEE_SIDE * 2;
    const pnl = gross - fees;
    this.equity += pnl;
    if (this.equity > this.peak) this.peak = this.equity;
    this.maxDD = Math.max(this.maxDD, (this.peak - this.equity) / this.peak);
    this.trades.push({
      sym: this.sym, strategy: this.strategy, dir: p.dir, tag: p.tag,
      entryT: p.entryT, entry: p.entry, exitT: t, exit: exitPrice,
      reason, pnl, equity: this.equity,
    });
    this.pos = null;
  }

  // Hard-stop / TP management on bar k (entry bar excluded — orders rest from
  // the next bar, matching the exchange-side placement after the signal close).
  manage(bar, idx) {
    const p = this.pos;
    if (!p || idx <= p.entryIdx) return false;
    if (p.dir === 'LONG') {
      if (bar.l <= p.sl) { this.closeAt(idx, bar.t, p.sl, 'SL'); return true; }
      if (p.tp && bar.h >= p.tp) { this.closeAt(idx, bar.t, p.tp, 'TP'); return true; }
    } else {
      if (bar.h >= p.sl) { this.closeAt(idx, bar.t, p.sl, 'SL'); return true; }
      if (p.tp && bar.l <= p.tp) { this.closeAt(idx, bar.t, p.tp, 'TP'); return true; }
    }
    return false;
  }

  // Structure exit at bar close: LONG closes on HH/LH, SHORT on LL/HL.
  // Skips labels created at/before the trade's own entry (openedAt <= pivotTime).
  structureExit(label, barClose, visibleT) {
    const p = this.pos;
    if (!p) return;
    const exitDir = (label.type === 'HH' || label.type === 'LH') ? 'LONG'
      : (label.type === 'LL' || label.type === 'HL') ? 'SHORT' : null;
    if (exitDir !== p.dir) return;
    if (p.entryT > label.pivotTime) return; // label belongs to an earlier pivot than entry
    this.closeAt(label.visibleIdx, visibleT, barClose, 'STRUCT_' + label.type);
  }
}

// ── SWEEP strategy (port of sweep-watcher.js) ──────────────────
function runSweep(sym, bars, pivots) {
  const acc = new Account(sym, 'SWEEP', SWEEP_LEV, sym === 'ETHUSDT' ? ETH_SWEEP_TP : 0);
  const levelState = new Map();  // pivot index -> 'open' | 'spent'
  const labels = buildLabels(bars, pivots);
  let lblPtr = 0;
  const MIN_BAR = SWING_LEN + 21;          // same guard as the watcher

  for (let j = 0; j < bars.length; j++) {
    const bar = bars[j];

    // 1) manage hard SL/TP
    acc.manage(bar, j);

    // 2) structure exits at this close (labels confirmed on this bar)
    while (lblPtr < labels.length && labels[lblPtr].visibleIdx === j) {
      if (acc.pos) acc.structureExit(labels[lblPtr], bar.c, bar.t);
      lblPtr++;
    }
    if (j < MIN_BAR) continue;
    if (acc.pos) continue;                 // one position per account

    // 3) entries — sweeps evaluated on THIS closed bar, levels in pivot order
    for (const p of pivots) {
      const activeFrom = p.i + CONFIRM + 1;
      if (activeFrom > j) continue;        // level not sweepable yet
      if (p.i > j - CONFIRM) break;        // pivots beyond current knowledge
      const key = p.i + ':' + p.kind;
      if (levelState.get(key) === 'spent') continue;

      // first breach must be THIS bar — if it happened earlier, level is spent
      const breached = p.kind === 'L' ? bar.l < p.price : bar.h > p.price;
      if (!breached) continue;
      levelState.set(key, 'spent');

      const dir = p.kind === 'L' ? 'LONG' : 'SHORT';
      const reclaimed = p.kind === 'L' ? bar.c > p.price : bar.c < p.price;
      if (!reclaimed) continue;            // continuation, level passes unplayed

      // Gate 1: quiet sweep
      const avgVol = bars.slice(j - 20, j).reduce((s, b) => s + b.v, 0) / 20;
      const volRatio = avgVol > 0 ? bar.v / avgVol : null;
      if (volRatio == null || volRatio >= VOL_TH) continue;

      // Gate 2: trapped aggressors
      const buyRatio = bar.v > 0 ? bar.tb / bar.v : 0.5;
      const aggrInDir = dir === 'LONG' ? buyRatio : 1 - buyRatio;
      if (aggrInDir >= AGGR_TH) continue;

      if (!acc.canEnter(dir, bar.t)) continue;

      acc.enter(dir, j, bar.t, bar.c, `sweep ${p.kind === 'L' ? 'EQL' : 'EQH'} @${p.price}`);
      break;                               // one entry per symbol per bar (poll)
    }
  }
  // EOD closeout
  if (acc.pos) acc.closeAt(bars.length - 1, bars[bars.length - 1].t, bars[bars.length - 1].c, 'EOD');
  return acc;
}

// ── LABEL strategy (port of expo-watcher.js signal path) ───────
function runLabel(sym, bars, pivots, vwap) {
  const acc = new Account(sym, 'LABEL', EXPO_LEV, 0);
  const labels = buildLabels(bars, pivots);
  const tradedLabels = new Set();

  for (let j = 0; j < bars.length; j++) {
    const bar = bars[j];

    acc.manage(bar, j);

    // labels visible at this close: exits first, then entry evaluation
    const fresh = labels.filter(l => l.visibleIdx === j);
    for (const l of fresh) {
      if (acc.pos) acc.structureExit(l, bar.c, bar.t);
    }
    if (acc.pos) continue;

    for (const l of fresh) {
      const dir = l.type === 'HL' ? 'LONG' : l.type === 'LH' ? 'SHORT' : null;
      if (!dir || tradedLabels.has(l.pivotTime)) continue;

      // VWAP location gate (on the label's own pivot bar)
      const i = l.pivotIdx;
      const vw = vwap.mid[i], v2u = vwap.v2u[i], v2d = vwap.v2d[i];
      if (vw == null) continue;
      const pivotRef = dir === 'SHORT' ? bars[i].h : bars[i].l;
      const pass = dir === 'SHORT'
        ? (pivotRef <= vw || pivotRef >= v2u)   // lower half or above upper outer band
        : (pivotRef >= vw || pivotRef <= v2d);  // upper half or below lower outer band
      if (!pass) continue;

      // Power gate on the pivot bar's complete taker flow
      const buyRatio = bars[i].v > 0 ? bars[i].tb / bars[i].v : 0.5;
      const powerInDir = dir === 'LONG' ? buyRatio : 1 - buyRatio;
      const rejected = powerInDir >= POWER_TH;
      const trapped = POWER_LOW_TH > 0 && powerInDir < POWER_LOW_TH;
      if (!rejected && !trapped) continue;

      tradedLabels.add(l.pivotTime);       // gates = one-shot kill (live: no window re-opens)
      if (!acc.canEnter(dir, bar.t)) continue;

      // Live enters on a 1m pullback within ~5 min → approximated by this close
      acc.enter(dir, j, bar.t, bar.c, `label ${l.type} @${l.price.toFixed(2)}`);
      break;
    }
  }
  if (acc.pos) acc.closeAt(bars.length - 1, bars[bars.length - 1].t, bars[bars.length - 1].c, 'EOD');
  return acc;
}

// ── Reporting ──────────────────────────────────────────────────
function stats(acc, spanDays) {
  const t = acc.trades;
  const wins = t.filter(x => x.pnl > 0);
  const gw = wins.reduce((s, x) => s + x.pnl, 0);
  const gl = -t.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
  return {
    sym: acc.sym, strategy: acc.strategy, lev: acc.lev,
    trades: t.length, wins: wins.length,
    wr: t.length ? wins.length / t.length * 100 : 0,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    net: acc.equity - START_EQUITY,
    roi: (acc.equity / START_EQUITY - 1) * 100,
    final: acc.equity,
    maxDD: acc.maxDD * 100,
    avgWin: wins.length ? gw / wins.length : 0,
    avgLoss: t.length > wins.length ? -gl / (t.length - wins.length) : 0,
    perDay: t.length / spanDays,
  };
}

function fmt$(n) { return `${n < 0 ? '-' : n > 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`; }
function fmtN(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : 'inf'; }

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' BACKTEST — LIVE RULES (HEAD)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(` SWEEP: BTC/ETH/SOL @ ${SWEEP_LEV}x | SL -${SL_MARGIN * 100}% margin | ETH-sweep TP +${ETH_SWEEP_TP * 100}% | gates vol<${VOL_TH}x aggr<${AGGR_TH}`);
  console.log(` LABEL: ${[...LABEL_SYMBOLS].join('/')} @ ${EXPO_LEV}x | SL -${SL_MARGIN * 100}% margin | power ${POWER_LOW_TH}/${POWER_TH} + VWAP gate`);
  console.log(` Money: $${START_EQUITY}/token, margin ${MARGIN_PCT * 100}% of wallet, fee ${FEE_SIDE * 100}%/side\n`);

  const allAccts = [];
  const spans = {};

  for (const sym of SYMBOLS) {
    process.stdout.write(` ${sym}: loading candles … `);
    const bars = await getCandles(sym);
    if (!bars.length) { console.log('NO DATA — skipped'); continue; }
    const spanDays = (bars[bars.length - 1].t - bars[0].t) / 86400000;
    spans[sym] = spanDays;
    console.log(`${bars.length} bars (${spanDays.toFixed(1)}d, ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)})`);

    const pivots = findPivots(bars);
    const vwap = computeVwapBands(bars);

    allAccts.push(runSweep(sym, bars, pivots));
    if (LABEL_SYMBOLS.has(sym)) allAccts.push(runLabel(sym, bars, pivots, vwap));
  }

  // Per-token table
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(' PER TOKEN · PER STRATEGY  ($' + START_EQUITY + ' each, compounded)');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` ${'Token'.padEnd(9)} ${'Strategy'.padStart(8)} ${'Lev'.padStart(4)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'Net P&L'.padStart(10)} ${'Final'.padStart(10)} ${'MaxDD'.padStart(7)}`);
  console.log(' ' + '─'.repeat(74));

  const bySym = {};
  for (const s of allAccts.map(a => stats(a, spans[a.sym] || 1))) {
    bySym[s.sym] = bySym[s.sym] || [];
    bySym[s.sym].push(s);
  }
  for (const sym of SYMBOLS) {
    for (const s of (bySym[sym] || [])) {
      console.log(` ${s.sym.padEnd(9)} ${s.strategy.padStart(8)} ${String(s.lev + 'x').padStart(4)} ${String(s.trades).padStart(7)} ${fmtN(s.wr).padStart(6)} ${fmtN(s.pf, 2).padStart(6)} ${fmt$(s.net).padStart(10)} ${('$' + s.final.toFixed(2)).padStart(10)} ${fmtN(s.maxDD).padStart(6)}%`);
    }
  }

  // Per-token combined (what a $1000 wallet on that token earns running both)
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(' PER TOKEN · COMBINED WALLET VIEW');
  console.log(' (sweep + label trades pooled per token, margin taken from');
  console.log('  separate $' + START_EQUITY + ' accounts — summed P&L, summed WR)');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` ${'Token'.padEnd(9)} ${'Trades'.padStart(7)} ${'Wins'.padStart(6)} ${'WR%'.padStart(6)} ${'Net P&L'.padStart(10)} ${'on $1000'.padStart(9)} ${'Tr/day'.padStart(7)}`);
  console.log(' ' + '─'.repeat(56));
  const totals = { trades: 0, wins: 0, net: 0 };
  for (const sym of SYMBOLS) {
    const rows = bySym[sym] || [];
    const tr = rows.reduce((a, r) => a + r.trades, 0);
    const wn = rows.reduce((a, r) => a + r.wins, 0);
    const net = rows.reduce((a, r) => a + r.net, 0);
    totals.trades += tr; totals.wins += wn; totals.net += net;
    const perDay = tr / (spans[sym] || 1);
    console.log(` ${sym.padEnd(9)} ${String(tr).padStart(7)} ${String(wn).padStart(6)} ${(tr ? fmtN(wn / tr * 100) : '-').padStart(6)} ${fmt$(net).padStart(10)} ${fmtN(net / START_EQUITY * 100).padStart(8)}% ${fmtN(perDay).padStart(6)}`);
  }
  console.log(' ' + '─'.repeat(56));
  console.log(` ${'TOTAL'.padEnd(9)} ${String(totals.trades).padStart(7)} ${String(totals.wins).padStart(6)} ${(totals.trades ? fmtN(totals.wins / totals.trades * 100) : '-').padStart(6)} ${fmt$(totals.net).padStart(10)}`);

  // Exit-reason breakdown
  console.log('\n Exit reasons (all trades):');
  const reasons = {};
  for (const a of allAccts) for (const t of a.trades) {
    reasons[t.reason] = reasons[t.reason] || { n: 0, pnl: 0 };
    reasons[t.reason].n++; reasons[t.reason].pnl += t.pnl;
  }
  for (const [r, v] of Object.entries(reasons).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   ${r.padEnd(12)} ${String(v.n).padStart(4)} trades   ${fmt$(v.pnl)}`);
  }

  if (VERBOSE) {
    console.log('\n Trade log:');
    const all = allAccts.flatMap(a => a.trades).sort((x, y) => x.entryT - y.entryT);
    for (const t of all) {
      console.log(`   ${new Date(t.entryT).toISOString().slice(5, 16).replace('T', ' ')}  ${t.sym.padEnd(9)} ${t.strategy.padEnd(6)} ${t.dir.padEnd(5)} @${t.entry.toFixed(t.entry > 100 ? 1 : 2)} → ${t.exit.toFixed(2)}  ${t.reason.padEnd(11)} ${fmt$(t.pnl)}`);
    }
  }

  // Save machine-readable summary next to the cache
  const out = {
    generatedAt: new Date().toISOString(),
    config: { DAYS, SYMBOLS, START_EQUITY, SWEEP_LEV, EXPO_LEV, SL_MARGIN, ETH_SWEEP_TP },
    perToken: Object.fromEntries(Object.entries(bySym).map(([k, v]) => [k, v])),
    trades: allAccts.flatMap(a => a.trades),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'live-rules-summary.json'), JSON.stringify(out, null, 2));
  console.log(`\n Summary written to data/backtest-cache/live-rules-summary.json`);
  console.log(' NOTE: structure labels rebuilt natively (TV Expo proxy); spot flow');
  console.log(' stands in for futures flow. Refine locally with real TV labels via');
  console.log(' _expo_extract.js + DAYS=30/90 for 30/90-day windows.\n');
}

main().catch(e => { console.error('\nFATAL:', e.stack || e.message); process.exit(1); });
