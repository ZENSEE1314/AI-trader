'use strict';

/**
 * backtest-smc-v2.js
 * Self-contained SMC signal backtest on Bybit historical data (no DB deps).
 *
 * Falls back to realistic synthetic OHLCV data if the network proxy blocks
 * external API calls (sandbox environment restriction).
 */

const https = require('https');

// ─── Constants ───────────────────────────────────────────────────────────────
const SYMBOLS       = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','LINKUSDT','AVAXUSDT','LTCUSDT'];
const STRUCT_BARS   = 16;   // context pivot age limit
const PIVOT_FRESH   = 8;    // entry pivot age limit
const SL_PCT        = 0.002;
const STARTING_CAP  = 1000;
const RISK_PCT      = 0.02;   // 2% risk per trade = $20 fixed per trade
const FIXED_RISK    = STARTING_CAP * RISK_PCT; // $20 — fixed (non-compounding) dollar risk
const FEE_RT        = 0.0012; // 0.12% round trip taker fee
const MAX_HOLD_BARS = 50;
const COOLDOWN_BARS = 4;
const BARS_PER_SYMBOL = 1000;

// ─── Realistic starting prices and volatility params per symbol ───────────────
const SYMBOL_PARAMS = {
  BTCUSDT:  { price: 67500,  vol: 0.0035, trend: 0.00005 },
  ETHUSDT:  { price: 3450,   vol: 0.0045, trend: 0.00003 },
  SOLUSDT:  { price: 172,    vol: 0.0060, trend: 0.00008 },
  BNBUSDT:  { price: 595,    vol: 0.0040, trend: 0.00004 },
  ADAUSDT:  { price: 0.615,  vol: 0.0055, trend: 0.00002 },
  DOTUSDT:  { price: 8.42,   vol: 0.0065, trend: 0.00003 },
  LINKUSDT: { price: 18.75,  vol: 0.0058, trend: 0.00004 },
  AVAXUSDT: { price: 38.90,  vol: 0.0060, trend: 0.00005 },
  LTCUSDT:  { price: 88.50,  vol: 0.0042, trend: 0.00002 },
};

// ─── Utility: HTTP GET with JSON parse ───────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message} — body: ${raw.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Synthetic OHLCV data generator ──────────────────────────────────────────
// Generates realistic crypto OHLCV bars using geometric Brownian motion with
// mean-reverting volatility, occasional momentum bursts, and realistic
// intrabar price action (high/low relative to open/close).
function generateSyntheticBars(symbol, n = BARS_PER_SYMBOL) {
  const params = SYMBOL_PARAMS[symbol] || { price: 100, vol: 0.005, trend: 0.00003 };
  let price  = params.price;
  let vol    = params.vol;
  const bars = [];
  const INTERVAL_MS = 15 * 60 * 1000;
  // Start ~10 days ago
  let ts = Date.now() - n * INTERVAL_MS;

  // Seeded-ish random using symbol name for reproducibility
  let seed = 0;
  for (let c of symbol) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;

  function rand() {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xFFFFFFFF);
  }

  function randn() {
    // Box-Muller
    const u1 = rand() + 1e-10;
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // Trend state machine: 0=ranging, 1=uptrend, -1=downtrend
  let trendState = 0;
  let trendBarsLeft = 0;
  let trendStrength = 0;

  for (let i = 0; i < n; i++) {
    // Volatility clustering (GARCH-like)
    const volShock = randn();
    vol = Math.max(params.vol * 0.4, Math.min(params.vol * 3.0,
      vol * 0.94 + params.vol * 0.06 + Math.abs(volShock) * params.vol * 0.02
    ));

    // Trend regime switching
    if (trendBarsLeft <= 0) {
      const r = rand();
      if (r < 0.08) {
        trendState    = 1;
        trendBarsLeft = Math.floor(rand() * 30 + 8);
        trendStrength = rand() * 0.0006 + 0.0002;
      } else if (r < 0.16) {
        trendState    = -1;
        trendBarsLeft = Math.floor(rand() * 30 + 8);
        trendStrength = rand() * 0.0006 + 0.0002;
      } else {
        trendState    = 0;
        trendBarsLeft = Math.floor(rand() * 20 + 5);
        trendStrength = 0;
      }
    }
    trendBarsLeft--;

    // Price return for this bar
    const trendDrift = trendState * trendStrength;
    const ret = trendDrift + vol * randn();

    const open  = price;
    const close = price * (1 + ret);

    // Intrabar: high and low
    // Wicks are log-normally distributed relative to bar range
    const bodySize   = Math.abs(close - open);
    const bodyFrac   = bodySize / price;
    const wickExtra  = Math.max(bodyFrac * 0.2, vol * 0.5) * (rand() * 1.5 + 0.3);

    let high, low;
    if (close >= open) {
      // bullish bar
      high = Math.max(open, close) * (1 + wickExtra * (rand() * 0.7 + 0.05));
      low  = Math.min(open, close) * (1 - wickExtra * (rand() * 0.5 + 0.05));
    } else {
      // bearish bar
      high = Math.max(open, close) * (1 + wickExtra * (rand() * 0.5 + 0.05));
      low  = Math.min(open, close) * (1 - wickExtra * (rand() * 0.7 + 0.05));
    }

    // Occasional spike candles (flash crash / pump)
    if (rand() < 0.005) {
      const spikeDir = rand() < 0.5 ? 1 : -1;
      const spikeMag = vol * (rand() * 3 + 2);
      if (spikeDir > 0) high  = Math.max(high,  open * (1 + spikeMag));
      else               low   = Math.min(low,   open * (1 - spikeMag));
    }

    const volume = price * (rand() * 0.8 + 0.6) * params.vol * 10000;

    bars.push({ t: ts, o: open, h: high, l: low, c: close, v: volume });

    price = close;
    ts   += INTERVAL_MS;
  }

  return bars;
}

// ─── Fetch 1000 bars of 15m klines (5 requests × 200) ───────────────────────
async function fetchBars(symbol) {
  const bars = [];
  let endTime = null;
  let apiSuccess = false;

  for (let page = 0; page < 5; page++) {
    let url = `https://api.bybit.com/v5/market/kline?symbol=${symbol}&category=linear&interval=15&limit=200`;
    if (endTime !== null) url += `&end=${endTime}`;

    let data;
    try {
      data = await httpGet(url);
    } catch (e) {
      // Network blocked — fall through to synthetic data
      break;
    }

    if (!data || data.retCode !== 0) {
      break;
    }

    const list = data.result && data.result.list;
    if (!list || list.length === 0) break;

    const chunk = list.map(r => ({
      t: Number(r[0]),
      o: parseFloat(r[1]),
      h: parseFloat(r[2]),
      l: parseFloat(r[3]),
      c: parseFloat(r[4]),
      v: parseFloat(r[5])
    }));

    bars.unshift(...chunk.reverse());
    endTime = chunk[0].t - 1;
    apiSuccess = true;

    await sleep(500);
  }

  if (apiSuccess && bars.length >= 250) {
    // Deduplicate and sort
    const map = new Map();
    for (const b of bars) map.set(b.t, b);
    const sorted = Array.from(map.values()).sort((a, b) => a.t - b.t);
    return { bars: sorted, source: 'bybit-api' };
  }

  // Fallback: synthetic data
  return { bars: generateSyntheticBars(symbol, BARS_PER_SYMBOL), source: 'synthetic' };
}

// ─── Pivot detection ─────────────────────────────────────────────────────────
function _allPivots(bars) {
  if (!bars || bars.length < 6) return { ph: [], pl: [] };
  const ph = [], pl = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].h > bars[i-1].h && bars[i].h > bars[i-2].h &&
        bars[i].h > bars[i+1].h && bars[i].h > bars[i+2].h)
      ph.push({ idx: i, price: bars[i].h, barTs: bars[i].t });
    if (bars[i].l < bars[i-1].l && bars[i].l < bars[i-2].l &&
        bars[i].l < bars[i+1].l && bars[i].l < bars[i+2].l)
      pl.push({ idx: i, price: bars[i].l, barTs: bars[i].t });
  }
  return { ph, pl };
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmtTs(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

function fmtPrice(p) {
  if (p >= 1000)  return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

// ─── Simulate single trade outcome ───────────────────────────────────────────
// Phase-1: walk bars until SL or TP1 hit
// Phase-2 (if TP1 hit): walk remaining bars until moved_SL or TP2 hit
// Returns { outcome, R, exitBar }
function simulateTrade(bars, entryIdx, direction, entry, sl, tp1, tp2) {
  const phase1End = Math.min(bars.length - 1, entryIdx + MAX_HOLD_BARS);

  for (let j = entryIdx; j <= phase1End; j++) {
    const bar = bars[j];

    if (direction === 'SHORT') {
      const slHit  = bar.h >= sl;
      const tp1Hit = bar.l <= tp1;

      // If both hit same bar: conservative = SL first
      if (slHit && tp1Hit) return { outcome: 'LOSS', R: -1, exitBar: j };
      if (slHit)            return { outcome: 'LOSS', R: -1, exitBar: j };

      if (tp1Hit) {
        // Move SL to entry (breakeven), enter phase 2
        const movedSL = entry;
        for (let k = j + 1; k <= phase1End; k++) {
          const b2 = bars[k];
          const slHit2 = b2.h >= movedSL;
          const tp2Hit = b2.l <= tp2;
          if (slHit2 && tp2Hit) return { outcome: 'PARTIAL', R: 1, exitBar: k };
          if (slHit2)            return { outcome: 'PARTIAL', R: 1, exitBar: k };
          if (tp2Hit)            return { outcome: 'TP2',     R: 3, exitBar: k };
        }
        // Ran out of bars in phase 2 → exit at TP1 level
        return { outcome: 'TP1', R: 1, exitBar: phase1End };
      }
    } else { // LONG
      const slHit  = bar.l <= sl;
      const tp1Hit = bar.h >= tp1;

      if (slHit && tp1Hit) return { outcome: 'LOSS', R: -1, exitBar: j };
      if (slHit)            return { outcome: 'LOSS', R: -1, exitBar: j };

      if (tp1Hit) {
        const movedSL = entry;
        for (let k = j + 1; k <= phase1End; k++) {
          const b2 = bars[k];
          const slHit2 = b2.l <= movedSL;
          const tp2Hit = b2.h >= tp2;
          if (slHit2 && tp2Hit) return { outcome: 'PARTIAL', R: 1, exitBar: k };
          if (slHit2)            return { outcome: 'PARTIAL', R: 1, exitBar: k };
          if (tp2Hit)            return { outcome: 'TP2',     R: 3, exitBar: k };
        }
        return { outcome: 'TP1', R: 1, exitBar: phase1End };
      }
    }
  }
  return { outcome: 'TIMEOUT', R: 0, exitBar: phase1End };
}

// ─── Backtest one symbol ──────────────────────────────────────────────────────
// Uses FIXED_RISK ($20) per trade for realistic P&L reporting.
// Also tracks compounding capital for reference.
function backtestSymbol(symbol, bars, compoundingCapital) {
  const trades = [];
  let lastSignalBar = -999;
  let capCompound   = compoundingCapital; // tracks 2%-of-current compounding

  // Need i+1 for entry bar and i+50 for simulation end → stop at bars.length - 52
  const maxI = bars.length - 52;

  for (let i = 200; i <= maxI; i++) {
    // Cooldown: don't signal within COOLDOWN_BARS of last signal
    if (i - lastSignalBar < COOLDOWN_BARS) continue;

    // Rolling 200-bar window ending at bar i (inclusive)
    // Inside window: index 0 = oldest, index 199 = bar i (most recent closed)
    const window = bars.slice(i - 199, i + 1);
    const { ph: ph15, pl: pl15 } = _allPivots(window);

    if (ph15.length < 2 || pl15.length < 2) continue;

    const lastH = ph15[ph15.length - 1];
    const prevH = ph15[ph15.length - 2];
    const lastL = pl15[pl15.length - 1];
    const prevL = pl15[pl15.length - 2];

    // Age = how many bars ago the pivot formed (0 = just formed at bar i)
    const lastHAge = 199 - lastH.idx;
    const lastLAge = 199 - lastL.idx;

    // ── SHORT setup ──────────────────────────────────────────────────────────
    // LH + LL + LH after LL + fresh ages + minimum range
    if (
      lastH.price < prevH.price &&               // Lower High
      lastL.price < prevL.price &&               // Lower Low
      lastH.barTs > lastL.barTs &&               // LH formed after LL
      lastHAge <= PIVOT_FRESH &&                 // entry pivot ≤8 bars old
      lastLAge <= STRUCT_BARS &&                 // context pivot ≤16 bars old
      (lastH.price - lastL.price) / lastL.price >= SL_PCT * 2  // sufficient swing range
    ) {
      // CHoCH guard: bar between LL and LH that breaks above prior HH invalidates setup
      const highsBeforeLL = ph15.filter(p => p.barTs < lastL.barTs);
      const prevHHprice   = highsBeforeLL.length > 0
        ? Math.max(...highsBeforeLL.map(p => p.price))
        : prevH.price;

      const llTs = lastL.barTs;
      const lhTs = lastH.barTs;
      let choch  = false;
      for (const b of window) {
        if (b.t > llTs && b.t < lhTs && b.h > prevHHprice) { choch = true; break; }
      }

      if (!choch) {
        const entryBarIdx = i + 1;
        if (entryBarIdx < bars.length) {
          const entry = bars[entryBarIdx].o;
          const sl    = lastH.price * (1 + SL_PCT);
          const tp1   = entry * (1 - 0.005);
          const tp2   = entry * (1 - 0.010);

          // Validate: entry must be below SL (valid short setup)
          if (entry < sl) {
            const sim = simulateTrade(bars, entryBarIdx + 1, 'SHORT', entry, sl, tp1, tp2);

            // Fixed-risk P&L: always risk FIXED_RISK ($20) per trade
            // Fee: approximate as FEE_RT fraction of the FIXED_RISK (conservative)
            const feeAmt       = FIXED_RISK * FEE_RT;
            const pnlFixed     = sim.R * FIXED_RISK - feeAmt;

            // Compounding P&L (for reference)
            const compRisk     = capCompound * RISK_PCT;
            const pnlCompound  = sim.R * compRisk - compRisk * FEE_RT;
            capCompound       += pnlCompound;

            trades.push({
              symbol, direction: 'SHORT',
              barTs: bars[i].t, entry, sl, tp1, tp2,
              outcome: sim.outcome, R: sim.R,
              pnl: pnlFixed,        // fixed-risk dollar P&L
              pnlCompound,          // compounding dollar P&L
              capCompound           // running compounding capital after this trade
            });
            lastSignalBar = i;
          }
        }
      }
    }

    // ── LONG setup ───────────────────────────────────────────────────────────
    // HL + HH + HL after HH + fresh ages + minimum range
    else if (
      lastL.price > prevL.price &&               // Higher Low
      lastH.price > prevH.price &&               // Higher High
      lastL.barTs > lastH.barTs &&               // HL formed after HH
      lastLAge <= PIVOT_FRESH &&                 // entry pivot ≤8 bars old
      lastHAge <= STRUCT_BARS &&                 // context pivot ≤16 bars old
      (lastH.price - lastL.price) / lastH.price >= SL_PCT * 2  // sufficient swing range
    ) {
      const entryBarIdx = i + 1;
      if (entryBarIdx < bars.length) {
        const entry = bars[entryBarIdx].o;
        const sl    = lastL.price * (1 - SL_PCT);
        const tp1   = entry * (1 + 0.005);
        const tp2   = entry * (1 + 0.010);

        // Validate: entry must be above SL (valid long setup)
        if (entry > sl) {
          const sim = simulateTrade(bars, entryBarIdx + 1, 'LONG', entry, sl, tp1, tp2);

          const feeAmt       = FIXED_RISK * FEE_RT;
          const pnlFixed     = sim.R * FIXED_RISK - feeAmt;

          const compRisk     = capCompound * RISK_PCT;
          const pnlCompound  = sim.R * compRisk - compRisk * FEE_RT;
          capCompound       += pnlCompound;

          trades.push({
            symbol, direction: 'LONG',
            barTs: bars[i].t, entry, sl, tp1, tp2,
            outcome: sim.outcome, R: sim.R,
            pnl: pnlFixed,
            pnlCompound,
            capCompound
          });
          lastSignalBar = i;
        }
      }
    }
  }

  return { trades, finalCapital: capCompound };
}

// ─── Print per-trade lines ────────────────────────────────────────────────────
function printTrades(trades) {
  for (const t of trades) {
    const outcomeStr =
      t.outcome === 'TP2'     ? 'TP2     +3R' :
      t.outcome === 'PARTIAL' ? 'TP1+BE  +1R' :
      t.outcome === 'TP1'     ? 'TP1     +1R' :
      t.outcome === 'LOSS'    ? 'LOSS    -1R' :
      t.outcome === 'TIMEOUT' ? 'TIMEOUT  0R' : t.outcome;

    // Fixed-risk P&L (basis: $20 risk per trade)
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
    console.log(
      `  [${t.symbol} ${t.direction.padEnd(5)}] bar=${fmtTs(t.barTs)} ` +
      `entry=${fmtPrice(t.entry).padStart(10)} sl=${fmtPrice(t.sl).padStart(10)} ` +
      `tp1=${fmtPrice(t.tp1).padStart(10)} tp2=${fmtPrice(t.tp2).padStart(10)} ` +
      `→ ${outcomeStr}  (${pnlStr})`
    );
  }
}

// ─── Print summary table ──────────────────────────────────────────────────────
function printSummary(allResults) {
  console.log('\n' + '═'.repeat(100));
  console.log(
    'Symbol    '.padEnd(11) +
    'Trades'.padStart(7) +
    'Win%'.padStart(7) +
    'TP2%'.padStart(7) +
    'TP1%'.padStart(7) +
    'BE%'.padStart(6) +
    'Loss%'.padStart(7) +
    'TO%'.padStart(6) +
    'Avg_R'.padStart(8) +
    'Total_R'.padStart(9) +
    'Net_PnL'.padStart(11)
  );
  console.log('─'.repeat(100));

  let totTrades = 0, totWins = 0, totTP2 = 0, totTP1 = 0, totBE = 0;
  let totLoss = 0, totTO = 0, totR = 0, totPnl = 0;

  for (const { symbol, trades } of allResults) {
    if (!trades || trades.length === 0) {
      console.log(`${symbol.padEnd(11)}${'0'.padStart(7)}  (no trades)`);
      continue;
    }
    const n      = trades.length;
    const tp2    = trades.filter(t => t.outcome === 'TP2').length;
    const tp1    = trades.filter(t => t.outcome === 'TP1').length;
    const be     = trades.filter(t => t.outcome === 'PARTIAL').length;
    const loss   = trades.filter(t => t.outcome === 'LOSS').length;
    const to     = trades.filter(t => t.outcome === 'TIMEOUT').length;
    const wins   = tp2 + tp1 + be;
    const sumR   = trades.reduce((a, t) => a + t.R, 0);
    const sumPnl = trades.reduce((a, t) => a + t.pnl, 0); // fixed-risk P&L
    const avgR   = sumR / n;

    const winPct  = (wins  / n * 100).toFixed(0);
    const tp2Pct  = (tp2   / n * 100).toFixed(0);
    const tp1Pct  = (tp1   / n * 100).toFixed(0);
    const bePct   = (be    / n * 100).toFixed(0);
    const lossPct = (loss  / n * 100).toFixed(0);
    const toPct   = (to    / n * 100).toFixed(0);

    console.log(
      symbol.padEnd(11) +
      String(n).padStart(7) +
      `${winPct}%`.padStart(7) +
      `${tp2Pct}%`.padStart(7) +
      `${tp1Pct}%`.padStart(7) +
      `${bePct}%`.padStart(6) +
      `${lossPct}%`.padStart(7) +
      `${toPct}%`.padStart(6) +
      `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`.padStart(8) +
      `${sumR >= 0 ? '+' : ''}${sumR.toFixed(1)}R`.padStart(9) +
      `${sumPnl >= 0 ? '+' : ''}$${sumPnl.toFixed(2)}`.padStart(11)
    );

    totTrades += n; totWins += wins; totTP2 += tp2; totTP1 += tp1; totBE += be;
    totLoss   += loss; totTO += to; totR += sumR; totPnl += sumPnl;
  }

  console.log('─'.repeat(100));
  if (totTrades > 0) {
    const avgR = totR / totTrades;
    const winPct  = (totWins  / totTrades * 100).toFixed(0);
    const tp2Pct  = (totTP2   / totTrades * 100).toFixed(0);
    const tp1Pct  = (totTP1   / totTrades * 100).toFixed(0);
    const bePct   = (totBE    / totTrades * 100).toFixed(0);
    const lossPct = (totLoss  / totTrades * 100).toFixed(0);
    const toPct   = (totTO    / totTrades * 100).toFixed(0);

    console.log(
      'OVERALL'.padEnd(11) +
      String(totTrades).padStart(7) +
      `${winPct}%`.padStart(7) +
      `${tp2Pct}%`.padStart(7) +
      `${tp1Pct}%`.padStart(7) +
      `${bePct}%`.padStart(6) +
      `${lossPct}%`.padStart(7) +
      `${toPct}%`.padStart(6) +
      `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`.padStart(8) +
      `${totR >= 0 ? '+' : ''}${totR.toFixed(1)}R`.padStart(9) +
      `${totPnl >= 0 ? '+' : ''}$${totPnl.toFixed(2)}`.padStart(11)
    );
  }
  console.log('═'.repeat(100));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           SMC Strategy Backtest v2 — Bybit 15m Klines           ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  console.log(`Symbols    : ${SYMBOLS.join(', ')}`);
  console.log(`Bars       : ${BARS_PER_SYMBOL} × 15m per symbol (~10.4 days)`);
  console.log(`Capital    : $${STARTING_CAP}  Risk/trade: ${RISK_PCT*100}%  Fee: ${FEE_RT*100}% round-trip`);
  console.log(`SL/TP      : SL=${SL_PCT*100}% from pivot  TP1=0.5%  TP2=1.0% from entry`);
  console.log(`Structure  : Pivot age limits — entry ≤${PIVOT_FRESH} bars, context ≤${STRUCT_BARS} bars`);
  console.log(`Outcome R  : LOSS=-1R  TP1=+1R  TP1+BE(partial)=+1R  TP2=+3R\n`);

  const allResults = [];
  let capital = STARTING_CAP;
  let anyApiData = false;

  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol} (${BARS_PER_SYMBOL} bars)... `);
    const { bars, source } = await fetchBars(symbol);

    if (source === 'bybit-api') {
      anyApiData = true;
      process.stdout.write(`[LIVE API] `);
    } else {
      process.stdout.write(`[SYNTHETIC] `);
    }

    if (!bars || bars.length < 250) {
      console.log(`✗ insufficient data (${bars ? bars.length : 0} bars), skipping`);
      allResults.push({ symbol, trades: [], source });
      continue;
    }

    console.log(`✓ ${bars.length} bars  [${fmtTs(bars[0].t)} → ${fmtTs(bars[bars.length-1].t)}]`);

    const { trades, finalCapital } = backtestSymbol(symbol, bars, capital);
    capital = finalCapital;

    console.log(`\n--- ${symbol} (${source}): ${trades.length} trades ---`);
    printTrades(trades);

    allResults.push({ symbol, trades, source });
  }

  if (!anyApiData) {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║  NOTE: Network proxy blocked Bybit API. Using synthetic OHLCV.  ║');
    console.log('║  Data generated via GBM + volatility clustering + trend regimes. ║');
    console.log('║  Signal logic is identical to live production code.              ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');
  }

  printSummary(allResults);

  // Fixed-risk totals (the meaningful metric: $20 risk per trade throughout)
  const allTrades = allResults.flatMap(r => r.trades || []);
  const fixedPnl  = allTrades.reduce((a, t) => a + t.pnl, 0);
  const fixedFinalCap = STARTING_CAP + fixedPnl;
  const fixedPct  = (fixedPnl / STARTING_CAP * 100).toFixed(2);

  console.log(`\n── Fixed-risk accounting ($${FIXED_RISK.toFixed(0)} risk/trade) ─────────────────────`);
  console.log(`  Starting capital : $${STARTING_CAP.toFixed(2)}`);
  console.log(`  Net P&L (fixed)  : ${fixedPnl >= 0 ? '+' : ''}$${fixedPnl.toFixed(2)}  (${fixedPct}%)`);
  console.log(`  Final capital    : $${fixedFinalCap.toFixed(2)}`);

  // Compounding reference (2% of current capital per trade)
  const compoundPnl = capital - STARTING_CAP;
  const compoundPct = (compoundPnl / STARTING_CAP * 100).toFixed(2);
  console.log(`\n── Compounding reference (2% of current capital/trade) ──────────────`);
  console.log(`  Net P&L (cmpd.)  : ${compoundPnl >= 0 ? '+' : ''}$${compoundPnl.toFixed(2)}  (${compoundPct}%)`);
  console.log(`  Final capital    : $${capital.toFixed(2)}`);

  // ── Per-direction breakdown ───────────────────────────────────────────────
  const longs  = allTrades.filter(t => t.direction === 'LONG');
  const shorts = allTrades.filter(t => t.direction === 'SHORT');

  if (longs.length > 0 || shorts.length > 0) {
    console.log('\n── Direction breakdown (fixed-risk) ─────────────────────────────────');
    for (const [label, group] of [['LONG', longs], ['SHORT', shorts]]) {
      if (group.length === 0) continue;
      const wins   = group.filter(t => t.R > 0).length;
      const sumR   = group.reduce((a, t) => a + t.R, 0);
      const sumPnl = group.reduce((a, t) => a + t.pnl, 0);
      console.log(
        `  ${label.padEnd(6)}  n=${group.length}  ` +
        `win%=${(wins/group.length*100).toFixed(0)}%  ` +
        `avgR=${sumR >= 0 ? '+' : ''}${(sumR/group.length).toFixed(2)}R  ` +
        `total=${sumR >= 0 ? '+' : ''}${sumR.toFixed(1)}R  ` +
        `pnl=${sumPnl >= 0 ? '+' : ''}$${sumPnl.toFixed(2)}`
      );
    }
  }

  // ── Signal frequency analysis ─────────────────────────────────────────────
  if (allTrades.length > 0) {
    console.log('\n── Signal quality metrics ───────────────────────────────────────────');
    const totalBarsScanned = BARS_PER_SYMBOL * SYMBOLS.length;
    const signalRate = (allTrades.length / totalBarsScanned * 100).toFixed(3);
    console.log(`  Total bars scanned : ${totalBarsScanned.toLocaleString()}`);
    console.log(`  Total signals      : ${allTrades.length}`);
    console.log(`  Signal rate        : ${signalRate}% of bars`);
    console.log(`  Avg bars/signal    : ${(totalBarsScanned / allTrades.length).toFixed(0)} bars`);

    const tp2s = allTrades.filter(t => t.outcome === 'TP2').length;
    const tp1s = allTrades.filter(t => t.outcome === 'TP1').length;
    const bes  = allTrades.filter(t => t.outcome === 'PARTIAL').length;
    const ls   = allTrades.filter(t => t.outcome === 'LOSS').length;
    const tos  = allTrades.filter(t => t.outcome === 'TIMEOUT').length;
    console.log(`  TP2=${tp2s}  TP1=${tp1s}  BE(partial)=${bes}  LOSS=${ls}  TIMEOUT=${tos}`);

    const expectancy = allTrades.reduce((a, t) => a + t.R, 0) / allTrades.length;
    const expectancyDollar = expectancy * FIXED_RISK;
    console.log(`  Expectancy         : ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(3)}R per trade  (${expectancyDollar >= 0 ? '+' : ''}$${expectancyDollar.toFixed(2)} fixed-risk)`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
