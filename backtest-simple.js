// Pure 15m structure backtest: HH→HL = LONG, LL→LH = SHORT
// No 1m filter, no CHoCH guard, just raw 2-pivot detection + kill zone + 4H gate

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','LINKUSDT','LTCUSDT'];
const SL_PCT   = { BTCUSDT:0.0025, ETHUSDT:0.002, SOLUSDT:0.002, BNBUSDT:0.003, ADAUSDT:0.002, DOTUSDT:0.002, LINKUSDT:0.003, LTCUSDT:0.0025 };
const TP1_PCT  = 0.005;
const TP2_PCT  = 0.010;
const LOCK_PCT = 0.0025;
const RISK     = 20;          // $ per trade
const BARS_15M = 2000;
const BASE_TS  = new Date('2026-01-05T07:00:00Z').getTime();

// ── GBM synthetic data ─────────────────────────────────────────────────────
function genBars(n, startPrice, drift=0.0001, vol=0.008) {
  const bars = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const ts = BASE_TS - (n - 1 - i) * 15 * 60_000;
    const r  = drift + vol * (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
    const open  = price;
    const close = price * (1 + r);
    const hi    = Math.max(open, close) * (1 + Math.random() * vol * 0.5);
    const lo    = Math.min(open, close) * (1 - Math.random() * vol * 0.5);
    bars.push({ t: ts, o: open, h: hi, l: lo, c: close });
    price = close;
  }
  return bars;
}

// ── 2L/2R pivot detection ──────────────────────────────────────────────────
function getPivotHighs(bars) {
  const pivots = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].h > bars[i-1].h && bars[i].h > bars[i-2].h &&
        bars[i].h > bars[i+1].h && bars[i].h > bars[i+2].h) {
      pivots.push({ idx: i, price: bars[i].h, barTs: bars[i].t });
    }
  }
  return pivots;
}
function getPivotLows(bars) {
  const pivots = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].l < bars[i-1].l && bars[i].l < bars[i-2].l &&
        bars[i].l < bars[i+1].l && bars[i].l < bars[i+2].l) {
      pivots.push({ idx: i, price: bars[i].l, barTs: bars[i].t });
    }
  }
  return pivots;
}

// ── 4H trend ──────────────────────────────────────────────────────────────
function get4HTrend(bars15m, upToIdx) {
  const slice = bars15m.slice(0, upToIdx + 1);
  if (slice.length < 16) return 'NEUTRAL';
  const ph = getPivotHighs(slice); const pl = getPivotLows(slice);
  if (ph.length < 2 || pl.length < 2) return 'NEUTRAL';
  const lH = ph[ph.length-1]; const pH = ph[ph.length-2];
  const lL = pl[pl.length-1]; const pL = pl[pl.length-2];
  const hh = lH.price > pH.price; const hl = lL.price > pL.price;
  const ll = lL.price < pL.price; const lh = lH.price < pH.price;
  if (hh && hl) return 'UP';
  if (ll && lh) return 'DOWN';
  return 'NEUTRAL';
}

// ── Kill zone check ────────────────────────────────────────────────────────
function inKillZone(ts) {
  const d = new Date(ts);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (h >= 7 && h < 10) || (h >= 12 && h < 16);
}

// ── Simulate trade outcome on future bars ─────────────────────────────────
function simulateTrade(dir, entry, slPct, bars15m, fromIdx) {
  const sl  = dir === 'LONG' ? entry * (1 - slPct)     : entry * (1 + slPct);
  const tp1 = dir === 'LONG' ? entry * (1 + TP1_PCT)   : entry * (1 - TP1_PCT);
  const tp2 = dir === 'LONG' ? entry * (1 + TP2_PCT)   : entry * (1 - TP2_PCT);
  const lock= dir === 'LONG' ? entry * (1 + LOCK_PCT)  : entry * (1 - LOCK_PCT);
  let tp1Hit = false, lockedIn = false;

  for (let i = fromIdx; i < Math.min(fromIdx + 96, bars15m.length); i++) {
    const b = bars15m[i];
    if (dir === 'LONG') {
      if (!tp1Hit && b.h >= tp1) { tp1Hit = true; }
      if (tp1Hit && b.h >= lock) { lockedIn = true; }
      if (tp1Hit && b.h >= tp2) return { outcome: 'TP2', r: +3 };
      if (lockedIn && b.l <= lock) return { outcome: 'BE', r: +1 };
      if (b.l <= sl) return tp1Hit ? { outcome: 'BE', r: +1 } : { outcome: 'LOSS', r: -1 };
    } else {
      if (!tp1Hit && b.l <= tp1) { tp1Hit = true; }
      if (tp1Hit && b.l <= lock) { lockedIn = true; }
      if (tp1Hit && b.l <= tp2) return { outcome: 'TP2', r: +3 };
      if (lockedIn && b.h >= lock) return { outcome: 'BE', r: +1 };
      if (b.h >= sl) return tp1Hit ? { outcome: 'BE', r: +1 } : { outcome: 'LOSS', r: -1 };
    }
  }
  return { outcome: 'TO', r: tp1Hit ? +1 : -1 };
}

// ── Main backtest ──────────────────────────────────────────────────────────
const START_PRICES = { BTCUSDT:95000, ETHUSDT:3500, SOLUSDT:200, BNBUSDT:600, ADAUSDT:0.55, DOTUSDT:7, LINKUSDT:18, LTCUSDT:110 };
const allResults = [];
let totalPnl = 0, totalTrades = 0;

console.log('\n══ PURE 15M STRUCTURE BACKTEST (HH→HL LONG / LL→LH SHORT) ══\n');

for (const sym of SYMBOLS) {
  const slPct = SL_PCT[sym];
  const bars  = genBars(BARS_15M, START_PRICES[sym]);
  const trades = [];

  for (let i = 10; i < bars.length - 5; i++) {
    if (!inKillZone(bars[i].t)) continue;

    const slice = bars.slice(0, i + 1);
    const ph = getPivotHighs(slice);
    const pl = getPivotLows(slice);
    if (ph.length < 2 || pl.length < 2) continue;

    const lH = ph[ph.length-1]; const pH = ph[ph.length-2];
    const lL = pl[pl.length-1]; const pL = pl[pl.length-2];

    const trend4h = get4HTrend(bars, i);

    let dir = null, label = '';

    // HH → HL = LONG
    if (lH.price > pH.price && lL.price > pL.price && lL.barTs > lH.barTs) {
      if (trend4h !== 'DOWN') { dir = 'LONG'; label = 'HH→HL'; }
    }
    // LL → LH = SHORT
    else if (lL.price < pL.price && lH.price < pH.price && lH.barTs > lL.barTs) {
      if (trend4h !== 'UP') { dir = 'SHORT'; label = 'LL→LH'; }
    }

    if (!dir) continue;

    // Avoid re-entering same pivot setup
    if (trades.length > 0) {
      const last = trades[trades.length - 1];
      if (last.pivotIdx === (dir === 'LONG' ? lL.idx : lH.idx)) continue;
    }

    const entry   = bars[i + 1].o;
    const pivotIdx = dir === 'LONG' ? lL.idx : lH.idx;
    const res     = simulateTrade(dir, entry, slPct, bars, i + 1);
    const pnl     = res.r * RISK;

    const d = new Date(bars[i].t);
    const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;

    trades.push({ dir, label, entry, outcome: res.outcome, r: res.r, pnl, pivotIdx, trend4h, dateStr });
  }

  const wins   = trades.filter(t => t.r > 0).length;
  const tp2s   = trades.filter(t => t.outcome === 'TP2').length;
  const losses = trades.filter(t => t.r < 0).length;
  const symPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgR   = trades.length > 0 ? trades.reduce((s,t)=>s+t.r,0)/trades.length : 0;

  console.log(`${sym.padEnd(10)} ${trades.length} trades  win=${Math.round(wins/trades.length*100)||0}%  tp2=${Math.round(tp2s/trades.length*100)||0}%  avgR=${avgR.toFixed(2)}R  pnl=${symPnl>=0?'+':''}$${symPnl.toFixed(0)}`);

  allResults.push(...trades);
  totalPnl += symPnl;
  totalTrades += trades.length;
}

const wins   = allResults.filter(t => t.r > 0).length;
const losses = allResults.filter(t => t.r < 0).length;
const tp2s   = allResults.filter(t => t.outcome === 'TP2').length;
const bes    = allResults.filter(t => t.outcome === 'BE').length;
const avgR   = allResults.reduce((s,t)=>s+t.r,0) / allResults.length;

console.log(`\n${'─'.repeat(70)}`);
console.log(`TOTAL  ${totalTrades} trades  win=${Math.round(wins/totalTrades*100)}%  tp2=${Math.round(tp2s/totalTrades*100)}%  be=${Math.round(bes/totalTrades*100)}%  loss=${Math.round(losses/totalTrades*100)}%`);
console.log(`AvgR = ${avgR.toFixed(3)}R   Net P&L = ${totalPnl>=0?'+':''}$${totalPnl.toFixed(2)}`);
console.log(`Capital: $1000 → $${(1000+totalPnl).toFixed(2)}  (${totalPnl>=0?'+':''}${(totalPnl/10).toFixed(1)}%)`);
console.log(`${'─'.repeat(70)}\n`);

// Direction breakdown
const longs  = allResults.filter(t=>t.dir==='LONG');
const shorts = allResults.filter(t=>t.dir==='SHORT');
const lWin   = longs.filter(t=>t.r>0).length;
const sWin   = shorts.filter(t=>t.r>0).length;
console.log(`LONG  n=${longs.length}  win=${Math.round(lWin/longs.length*100)||0}%  avgR=${longs.length?(longs.reduce((s,t)=>s+t.r,0)/longs.length).toFixed(2):0}R`);
console.log(`SHORT n=${shorts.length}  win=${Math.round(sWin/shorts.length*100)||0}%  avgR=${shorts.length?(shorts.reduce((s,t)=>s+t.r,0)/shorts.length).toFixed(2):0}R`);
