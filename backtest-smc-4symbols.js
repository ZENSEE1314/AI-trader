'use strict';

const https = require('https');

// ─── Constants ────────────────────────────────────────────────────────────────

const SYMBOLS = [
  { symbol: 'BTCUSDT', leverage: 100, vol: 0.005 },
  { symbol: 'ETHUSDT', leverage: 100, vol: 0.006 },
  { symbol: 'SOLUSDT', leverage: 20,  vol: 0.008 },
  { symbol: 'BNBUSDT', leverage: 20,  vol: 0.005 },
];

const SWING_LOOKBACK = 5;
const ENTRY_PROXIMITY_PCT = 0.006;
const TP_PCT = 0.03;
const SL_PCT = 0.01;
const MAX_TRADES_PER_DAY = 2;
const EMA_PERIOD = 200;
const CANDLES_LIMIT = 500;

// Session windows in UTC hours [start, end)
const SESSIONS = [
  [23, 26], // Asia: 23:00–02:00 (02:00 = 26 in 24h+ notation for wraparound)
  [7, 10],  // Europe: 07:00–10:00
  [12, 16], // US: 12:00–16:00
];

// Blocked minute marks
const BLOCKED_MINUTES = new Set([0, 15, 30, 45]);

// Synthetic base prices (approximate)
const BASE_PRICES = {
  BTCUSDT: 84000,
  ETHUSDT: 1600,
  SOLUSDT: 130,
  BNBUSDT: 590,
};

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function fetchKlines(symbol, interval) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${CANDLES_LIMIT}`;
  const raw = await fetchJson(url);
  // raw[i] = [openTime, open, high, low, close, volume, ...]
  return raw.map((r) => ({
    ts:    Number(r[0]),
    open:  parseFloat(r[1]),
    high:  parseFloat(r[2]),
    low:   parseFloat(r[3]),
    close: parseFloat(r[4]),
  }));
}

// ─── Synthetic GBM data ───────────────────────────────────────────────────────

function generateGbm(symbol, interval, vol) {
  const basePrice = BASE_PRICES[symbol] ?? 100;
  const minutesPerBar = interval === '1m' ? 1 : 3;
  const now = Date.now();
  const startTs = now - CANDLES_LIMIT * minutesPerBar * 60 * 1000;

  const candles = [];
  let price = basePrice;

  for (let i = 0; i < CANDLES_LIMIT; i++) {
    const ts = startTs + i * minutesPerBar * 60 * 1000;
    const drift = 0; // no drift
    const shock = drift + vol * (Math.random() * 2 - 1) * Math.sqrt(minutesPerBar);
    const open = price;
    price = price * (1 + shock);
    const high = Math.max(open, price) * (1 + Math.abs(vol * Math.random() * 0.5));
    const low  = Math.min(open, price) * (1 - Math.abs(vol * Math.random() * 0.5));
    const close = price;
    candles.push({ ts, open, high, low, close });
  }
  return candles;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

function computeEma(candles, period) {
  const k = 2 / (period + 1);
  const emas = new Array(candles.length).fill(null);
  let ema = candles[0].close;
  emas[0] = ema;
  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    emas[i] = ema;
  }
  return emas;
}

// ─── Swing detection ─────────────────────────────────────────────────────────

// Returns array of swing highs and lows for each bar index.
// swingHighs[i] = price if bar i is a swing high, else null.
// swingLows[i]  = price if bar i is a swing low,  else null.
function detectSwings(candles) {
  const n = candles.length;
  const swingHighs = new Array(n).fill(null);
  const swingLows  = new Array(n).fill(null);

  for (let i = SWING_LOOKBACK; i < n - SWING_LOOKBACK; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    let isSwingHigh = true;
    let isSwingLow  = true;

    for (let j = i - SWING_LOOKBACK; j <= i + SWING_LOOKBACK; j++) {
      if (j === i) continue;
      if (candles[j].high >= hi) { isSwingHigh = false; }
      if (candles[j].low  <= lo) { isSwingLow  = false; }
    }
    if (isSwingHigh) swingHighs[i] = hi;
    if (isSwingLow)  swingLows[i]  = lo;
  }
  return { swingHighs, swingLows };
}

// Label consecutive swings: HH/LH for highs, HL/LL for lows.
// Returns arrays of labeled swing events up to index i.
function labelSwings(swingHighs, swingLows, upToIndex) {
  const highs = []; // { index, price, label }
  const lows  = [];

  for (let i = 0; i <= upToIndex; i++) {
    if (swingHighs[i] !== null) {
      const prev = highs.length > 0 ? highs[highs.length - 1] : null;
      const label = prev === null ? 'HH' : (swingHighs[i] > prev.price ? 'HH' : 'LH');
      highs.push({ index: i, price: swingHighs[i], label });
    }
    if (swingLows[i] !== null) {
      const prev = lows.length > 0 ? lows[lows.length - 1] : null;
      const label = prev === null ? 'HL' : (swingLows[i] > prev.price ? 'HL' : 'LL');
      lows.push({ index: i, price: swingLows[i], label });
    }
  }
  return { highs, lows };
}

// Determine 3m structure bias at a given index.
// Returns 'bullish', 'bearish', or null.
function get3mBias(swingHighs3m, swingLows3m, idx) {
  const { highs, lows } = labelSwings(swingHighs3m, swingLows3m, idx);
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHigh = highs[highs.length - 1];
  const lastLow  = lows[lows.length - 1];

  const isBullish = lastHigh.label === 'HH' && lastLow.label === 'HL';
  const isBearish = lastHigh.label === 'LH' && lastLow.label === 'LL';

  if (isBullish) return 'bullish';
  if (isBearish) return 'bearish';
  return null;
}

// ─── Session / time filters ───────────────────────────────────────────────────

function isInSession(tsMs) {
  const date = new Date(tsMs);
  const utcHour   = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();

  if (BLOCKED_MINUTES.has(utcMinute)) return false;

  // Treat hours in 0–26 range to handle Asia session wrapping midnight
  const h = utcHour;
  for (const [start, end] of SESSIONS) {
    if (end <= 24) {
      if (h >= start && h < end) return true;
    } else {
      // Asia: 23–26 wraps → 23:00–23:59 or 00:00–01:59
      if (h >= start || h < end - 24) return true;
    }
  }
  return false;
}

// ─── Align 3m index to 1m index ───────────────────────────────────────────────

// Find the most recent 3m bar that closes before or at the 1m bar timestamp.
function find3mIndex(candles3m, ts1m) {
  let lo = 0;
  let hi = candles3m.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles3m[mid].ts <= ts1m) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return best;
}

// ─── Core backtest ────────────────────────────────────────────────────────────

function backtest(candles1m, candles3m, ema1hValues) {
  const { swingHighs: sh3m, swingLows: sl3m } = detectSwings(candles3m);
  const { swingHighs: sh1m, swingLows: sl1m } = detectSwings(candles1m);

  const trades = [];
  const tradeDayCounts = {}; // 'YYYY-MM-DD' → count

  // For each 1m bar, check entry conditions
  for (let i = EMA_PERIOD + SWING_LOOKBACK + 1; i < candles1m.length; i++) {
    const bar = candles1m[i];
    if (!isInSession(bar.ts)) continue;

    // Day throttle
    const day = new Date(bar.ts).toISOString().slice(0, 10);
    if ((tradeDayCounts[day] ?? 0) >= MAX_TRADES_PER_DAY) continue;

    // EMA200 (1h) — we approximate using the 1m EMA200 values passed in
    // (caller provides EMA of 1m candles as a proxy since we don't have 1h data separately)
    const ema200 = ema1hValues[i];
    const price  = bar.close;

    // Find corresponding 3m bar
    const idx3m = find3mIndex(candles3m, bar.ts);
    if (idx3m < SWING_LOOKBACK * 2) continue;

    const bias3m = get3mBias(sh3m, sl3m, idx3m);
    if (!bias3m) continue;

    // EMA filter
    if (bias3m === 'bullish' && price < ema200) continue;
    if (bias3m === 'bearish' && price > ema200) continue;

    // 1m confirmation
    const { highs: h1m, lows: l1m } = labelSwings(sh1m, sl1m, i);

    // Determine nearest swing point for proximity check
    let swingPoint = null;
    let direction  = null;

    if (bias3m === 'bullish') {
      // Need 1m HL confirmation — last swing low should be HL
      if (l1m.length === 0) continue;
      const lastLow1m = l1m[l1m.length - 1];
      if (lastLow1m.label !== 'HL') continue;
      swingPoint = lastLow1m.price;
      direction  = 'LONG';
    } else {
      // Need 1m LH confirmation — last swing high should be LH
      if (h1m.length === 0) continue;
      const lastHigh1m = h1m[h1m.length - 1];
      if (lastHigh1m.label !== 'LH') continue;
      swingPoint = lastHigh1m.price;
      direction  = 'SHORT';
    }

    // Proximity check: price must be within 0.6% of swing point
    const dist = Math.abs(price - swingPoint) / swingPoint;
    if (dist > ENTRY_PROXIMITY_PCT) continue;

    // Place trade
    const entry = price;
    const tp    = direction === 'LONG'  ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
    const sl    = direction === 'LONG'  ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);

    // Simulate outcome by scanning future 1m bars
    let outcome = null;
    let exitPrice = null;

    for (let j = i + 1; j < candles1m.length; j++) {
      const future = candles1m[j];
      if (direction === 'LONG') {
        if (future.low <= sl)  { outcome = 'LOSS'; exitPrice = sl; break; }
        if (future.high >= tp) { outcome = 'WIN';  exitPrice = tp; break; }
      } else {
        if (future.high >= sl) { outcome = 'LOSS'; exitPrice = sl; break; }
        if (future.low  <= tp) { outcome = 'WIN';  exitPrice = tp; break; }
      }
    }

    if (!outcome) continue; // trade still open at end of data — skip

    const pnlPct = direction === 'LONG'
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;

    trades.push({ day, direction, entry, exitPrice, outcome, pnlPct });
    tradeDayCounts[day] = (tradeDayCounts[day] ?? 0) + 1;

    // Skip ahead to avoid overlapping trades from same bar region
    i += SWING_LOOKBACK;
  }

  return trades;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function calcStats(trades) {
  if (trades.length === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, netPnlPct: 0, avgWin: 0, avgLoss: 0, profitFactor: 0 };
  }

  const wins   = trades.filter((t) => t.outcome === 'WIN');
  const losses = trades.filter((t) => t.outcome === 'LOSS');

  const grossWin  = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPct), 0);

  return {
    total:        trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      wins.length / trades.length,
    netPnlPct:    trades.reduce((s, t) => s + t.pnlPct, 0) * 100,
    avgWin:       wins.length   ? (grossWin  / wins.length)   * 100 : 0,
    avgLoss:      losses.length ? (grossLoss / losses.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         SMC STRATEGY BACKTEST — 4 SYMBOLS                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let usingSynthetic = false;

  // Probe connectivity
  try {
    await fetchKlines('BTCUSDT', '1m');
    console.log('  [INFO] Binance fapi reachable — fetching live data.\n');
  } catch {
    usingSynthetic = true;
    console.log('  [WARN] Binance fapi unreachable — using synthetic GBM data.\n');
  }

  const allTrades = [];
  const symbolResults = [];

  for (const { symbol, leverage, vol } of SYMBOLS) {
    process.stdout.write(`  Processing ${symbol}...`);

    let candles1m, candles3m;

    if (usingSynthetic) {
      candles1m = generateGbm(symbol, '1m', vol);
      candles3m = generateGbm(symbol, '3m', vol);
    } else {
      try {
        [candles1m, candles3m] = await Promise.all([
          fetchKlines(symbol, '1m'),
          fetchKlines(symbol, '3m'),
        ]);
      } catch {
        console.log(` fetch error — using synthetic`);
        candles1m = generateGbm(symbol, '1m', vol);
        candles3m = generateGbm(symbol, '3m', vol);
      }
    }

    // EMA200 on 1m as proxy for 1h trend filter
    const ema1h = computeEma(candles1m, EMA_PERIOD);

    const trades = backtest(candles1m, candles3m, ema1h);
    const stats  = calcStats(trades);

    // Net P&L as % of capital (unleveraged — multiply by leverage for leveraged P&L)
    symbolResults.push({ symbol, leverage, stats, trades });
    allTrades.push(...trades);

    console.log(` done (${trades.length} trades)`);
  }

  // ─── Report ──────────────────────────────────────────────────────────────────

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  PER-SYMBOL RESULTS');
  console.log('══════════════════════════════════════════════════════════════');

  for (const { symbol, leverage, stats } of symbolResults) {
    const leveragedPnl = stats.netPnlPct * leverage;
    console.log(`\n  ${symbol} (x${leverage} leverage)`);
    console.log(`  ─────────────────────────────`);
    console.log(`  Total trades : ${stats.total}`);
    console.log(`  Wins / Losses: ${stats.wins} / ${stats.losses}`);
    console.log(`  Win rate     : ${(stats.winRate * 100).toFixed(1)}%`);
    console.log(`  Net P&L      : ${stats.netPnlPct.toFixed(2)}% (unleveraged) | ${leveragedPnl.toFixed(1)}% (leveraged)`);
    console.log(`  Avg winner   : +${stats.avgWin.toFixed(2)}%`);
    console.log(`  Avg loser    : -${stats.avgLoss.toFixed(2)}%`);
    console.log(`  Profit factor: ${isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}`);
  }

  // Overall
  const overall = calcStats(allTrades);
  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  OVERALL RESULTS (all 4 symbols combined)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Total trades   : ${overall.total}`);
  console.log(`  Wins / Losses  : ${overall.wins} / ${overall.losses}`);
  console.log(`  Overall win rate: ${(overall.winRate * 100).toFixed(1)}%`);
  console.log(`  Net P&L (unlev): ${overall.netPnlPct.toFixed(2)}%`);
  console.log(`  Avg winner     : +${overall.avgWin.toFixed(2)}%`);
  console.log(`  Avg loser      : -${overall.avgLoss.toFixed(2)}%`);
  console.log(`  Profit factor  : ${isFinite(overall.profitFactor) ? overall.profitFactor.toFixed(2) : '∞'}`);

  // RR analysis
  const rr = overall.avgWin / (overall.avgLoss || 1);
  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  RR ANALYSIS');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Target RR      : 1:3 (TP +3% / SL -1%)`);
  console.log(`  Realised RR    : 1:${rr.toFixed(2)}`);

  if (rr >= 2.5) {
    console.log(`  Verdict        : RR 1:3 IS achievable with this strategy.`);
  } else if (rr >= 1.5) {
    console.log(`  Verdict        : RR 1:3 is MARGINAL. Consider tightening SL to 0.7% or reducing TP to 2%.`);
  } else {
    console.log(`  Verdict        : RR 1:3 is NOT achievable. TP gets hit rarely — consider TP at +1.5% for higher fill rate.`);
  }

  const breakEvenWinRate = 1 / (1 + rr);
  console.log(`  Break-even WR  : ${(breakEvenWinRate * 100).toFixed(1)}% at realised RR`);
  console.log(`  Strategy edge  : ${overall.winRate >= breakEvenWinRate ? 'POSITIVE' : 'NEGATIVE'} (actual ${(overall.winRate * 100).toFixed(1)}% vs break-even ${(breakEvenWinRate * 100).toFixed(1)}%)`);

  const dataSource = usingSynthetic ? 'Synthetic GBM (Binance blocked)' : 'Binance Futures live data';
  console.log(`\n  Data source    : ${dataSource}`);
  console.log(`  Lookback       : ~${Math.round(CANDLES_LIMIT / 60 * 10) / 10}h of 1m data per symbol`);
  console.log('\n  Done.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
