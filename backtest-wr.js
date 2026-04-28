'use strict';
// ============================================================
// WIN-RATE BACKTEST — current engine logic
//
// Simulates the live engine on historical data:
//   1. VWAP bands (1m session candles from UTC midnight)
//   2. 15m structure: HL/HH/LH/LL + HH-bear(sweep) + LL-bull(sweep)
//   3. 1m entry confirmation: pivot HH/HL for LONG, LL/LH for SHORT
//   4. Trade outcome: SL vs TP using 1m intra-bar highs/lows
//
// Reports:
//   - Win Rate, Avg RR, Profit Factor, Total Trades
//   - Breakdown by direction (LONG / SHORT) and by day
//
// Run on Railway (needs Binance access):
//   node backtest-wr.js [symbol] [days]
//   node backtest-wr.js BTCUSDT 7
//   node backtest-wr.js ALL 7
// ============================================================

const fetch = require('node-fetch');

const PROXY  = process.env.PROXY_URL || '';
const ARG1   = process.argv[2] || 'ALL';
const DAYS   = parseInt(process.argv[3] || '7', 10);

const SYMBOLS = ARG1 === 'ALL'
  ? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']
  : [ARG1];

// ── Strategy params (must match live engine) ─────────────────
const VWAP_MULT  = 1.0;   // 1 σ
const ATR_SL_K   = 1.2;   // SL = entry ± ATR × 1.2
const ATR_TP_K   = 2.0;   // TP = entry ± ATR × 2.0
const MIN_RR     = 1.2;
const PIVOT_B    = 2;      // 1m pivot lookback bars each side
const MAX_HOLD   = 96;     // max 24h (96 × 15m bars) before timeout

// ── HTTP helpers ─────────────────────────────────────────────

function base() {
  return PROXY
    ? `${PROXY}/fapi/v1`
    : 'https://fapi.binance.com/fapi/v1';
}

async function fetchJSON(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { timeout: 25000 });
      if (r.ok) return r.json();
      console.warn(`  HTTP ${r.status} — ${url.slice(0, 120)}`);
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  return null;
}

async function fetchKlines(symbol, interval, limit, startTime) {
  let url = `${base()}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  return fetchJSON(url);
}

// ── Candle helpers ────────────────────────────────────────────

function pc(k) {
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
  if (candles.length < period + 1) return candles.length > 1
    ? Math.abs(candles[candles.length-1].close - candles[candles.length-2].close) * 2 : 0;
  let s = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const p = candles[i - 1], c = candles[i];
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return s / period;
}

// ── VWAP ─────────────────────────────────────────────────────

function computeVWAP(candles1m) {
  if (!candles1m || candles1m.length < 5) return null;
  let cumTV = 0, cumV = 0;
  const tp = [];
  for (const c of candles1m) {
    const t = (c.high + c.low + c.close) / 3;
    tp.push(t);
    cumTV += t * c.volume;
    cumV  += c.volume;
  }
  const mid = cumV > 0 ? cumTV / cumV : null;
  if (!mid) return null;
  let cumVar = 0;
  for (let i = 0; i < candles1m.length; i++) {
    const d = tp[i] - mid;
    cumVar += candles1m[i].volume * d * d;
  }
  const sd = Math.sqrt(cumV > 0 ? cumVar / cumV : 0);
  return { mid, upper: mid + VWAP_MULT * sd, lower: mid - VWAP_MULT * sd, sd };
}

// ── Pivot scan ───────────────────────────────────────────────

function pivots(candles, B) {
  const H = [], L = [];
  for (let i = B; i < candles.length - B; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= B; j++) {
      if (candles[i].high <= candles[i-j].high || candles[i].high <= candles[i+j].high) isH = false;
      if (candles[i].low  >= candles[i-j].low  || candles[i].low  >= candles[i+j].low)  isL = false;
    }
    if (isH) H.push(candles[i].high);
    if (isL) L.push(candles[i].low);
  }
  return { H, L };
}

// ── Signal detection at a single 15m bar ─────────────────────

function detectAt(c15Slice, c1mToday, price) {
  // VWAP — must have 1m data; no 15m fallback (matches live engine fix)
  if (!c1mToday || c1mToday.length < 5) return null;
  const vwap = computeVWAP(c1mToday);
  if (!vwap) return null;

  let vwapZone;
  if (price >= vwap.upper)      vwapZone = 'above_upper';
  else if (price <= vwap.lower) vwapZone = 'below_lower';
  else if (price >= vwap.mid)   vwapZone = 'above_mid';
  else                          vwapZone = 'below_mid';

  // 15m candle structure (immediate — no pivot wait)
  const c15 = c15Slice.slice(-4);
  if (c15.length < 3) return null;
  const last = c15[c15.length - 1];
  const prev = c15[c15.length - 2];
  const has15mHL = last.low  > prev.low;
  const has15mHH = last.high > prev.high;
  const has15mLH = last.high < prev.high;
  const has15mLL = last.low  < prev.low;
  const lastBull = last.close > last.open;
  const lastBear = last.close < last.open;

  // 1m pivots (last 30 bars)
  const s1m = c1mToday.slice(-30);
  const pv = pivots(s1m, PIVOT_B);
  const has1mHH = pv.H.length >= 2 && pv.H[pv.H.length-1] > pv.H[pv.H.length-2];
  const has1mHL = pv.L.length >= 2 && pv.L[pv.L.length-1] > pv.L[pv.L.length-2];
  const has1mLL = pv.L.length >= 2 && pv.L[pv.L.length-1] < pv.L[pv.L.length-2];
  const has1mLH = pv.H.length >= 2 && pv.H[pv.H.length-1] < pv.H[pv.H.length-2];

  // LONG condition
  if (vwapZone !== 'below_lower') {
    const struct15 = has15mHL || has15mHH || (has15mLL && lastBull);
    const conf1m   = has1mHH || has1mHL;
    if (struct15 && conf1m) {
      const atr = calcATR(c15Slice);
      const sl = price - atr * ATR_SL_K;
      const tp = price + atr * ATR_TP_K;
      const slDist = (price - sl) / price;
      const tpDist = (tp - price) / price;
      const rr = slDist > 0 ? tpDist / slDist : 0;
      if (rr >= MIN_RR && slDist > 0.001 && slDist < 0.05) {
        const why = has15mHL ? '15HL' : has15mHH ? '15HH' : '15LL+bull';
        return { direction: 'LONG', price, sl, tp, slDist, rr, why, vwapZone, vwap };
      }
    }
  }

  // SHORT condition
  if (vwapZone !== 'above_upper') {
    const struct15 = has15mLH || has15mLL || (has15mHH && lastBear);
    const conf1m   = has1mLL || has1mLH;
    if (struct15 && conf1m) {
      const atr = calcATR(c15Slice);
      const sl = price + atr * ATR_SL_K;
      const tp = price - atr * ATR_TP_K;
      const slDist = (sl - price) / price;
      const tpDist = (price - tp) / price;
      const rr = slDist > 0 ? tpDist / slDist : 0;
      if (rr >= MIN_RR && slDist > 0.001 && slDist < 0.05) {
        const why = has15mLH ? '15LH' : has15mLL ? '15LL' : '15HH+bear';
        return { direction: 'SHORT', price, sl, tp, slDist, rr, why, vwapZone, vwap };
      }
    }
  }

  return null;
}

// ── Trade outcome simulation ─────────────────────────────────
// Walk forward through 1m bars after entry. Return 'WIN' / 'LOSS' / 'TIMEOUT'

function simulateOutcome(sig, futureC1m) {
  for (const bar of futureC1m) {
    if (sig.direction === 'LONG') {
      if (bar.low  <= sig.sl) return 'LOSS';
      if (bar.high >= sig.tp) return 'WIN';
    } else {
      if (bar.high >= sig.sl) return 'LOSS';
      if (bar.low  <= sig.tp) return 'WIN';
    }
  }
  return 'TIMEOUT';
}

// ── Fetch all 1m candles for a date range (paginated) ────────

async function fetchAll1m(symbol, fromMs, toMs) {
  const all = [];
  let start = fromMs;
  while (start < toMs) {
    const raw = await fetchKlines(symbol, '1m', 1000, start);
    if (!raw || !raw.length) break;
    const parsed = raw.map(pc);
    all.push(...parsed);
    const last = parsed[parsed.length - 1];
    if (last.closeTime >= toMs) break;
    start = last.openTime + 60000; // +1 minute
    await new Promise(r => setTimeout(r, 200));
  }
  return all.filter(c => c.openTime >= fromMs && c.closeTime <= toMs);
}

// ── Main backtest for one symbol ─────────────────────────────

async function backtestSymbol(symbol) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(` ${symbol}  (${DAYS} days)`);
  console.log('─'.repeat(60));

  const nowMs   = Date.now();
  const fromMs  = nowMs - DAYS * 86400000;

  // Fetch 15m candles (all days in one request if <= 1000 bars)
  const n15 = Math.min(DAYS * 96 + 20, 999);
  console.log(`  Fetching ${n15} × 15m candles…`);
  const raw15 = await fetchKlines(symbol, '15m', n15);
  if (!raw15 || raw15.length < 30) { console.log('  Not enough 15m data — skip'); return null; }
  const c15all = raw15.map(pc).filter(c => c.openTime >= fromMs);
  console.log(`  Got ${c15all.length} × 15m candles`);

  // Fetch all 1m candles for the period (paginated)
  console.log(`  Fetching 1m candles for ${DAYS} days (paginated)…`);
  const c1mall = await fetchAll1m(symbol, fromMs, nowMs);
  console.log(`  Got ${c1mall.length} × 1m candles`);

  if (c1mall.length < 100) {
    console.log('  Not enough 1m data — skip');
    return null;
  }

  // ── Walk-forward simulation ─────────────────────────────────
  const trades = [];
  const IN_TRADE_COOLDOWN = 15 * 60000; // 15 min cooldown after trade closes
  let lastTradeEndMs = 0;

  for (let i = 20; i < c15all.length - 2; i++) {
    const bar = c15all[i];
    if (bar.closeTime <= lastTradeEndMs + IN_TRADE_COOLDOWN) continue;

    // 1m candles from start of THIS day up to this bar's close
    const dayStart = new Date(bar.openTime);
    const dayStartMs = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate());
    const c1mToday = c1mall.filter(c => c.openTime >= dayStartMs && c.closeTime <= bar.closeTime);

    const sig = detectAt(c15all.slice(0, i + 1), c1mToday, bar.close);
    if (!sig) continue;

    // Future 1m bars for outcome simulation (up to MAX_HOLD × 15m worth)
    const maxFutureMs = bar.closeTime + MAX_HOLD * 15 * 60000;
    const futureC1m = c1mall.filter(c => c.openTime > bar.closeTime && c.closeTime <= maxFutureMs);
    if (futureC1m.length < 10) continue;

    const outcome = simulateOutcome(sig, futureC1m);

    const pnlR = outcome === 'WIN' ? sig.rr
               : outcome === 'LOSS' ? -1.0
               : -0.2; // timeout = small loss (missed opportunity cost)

    const time = new Date(bar.openTime).toISOString().slice(0, 16);
    trades.push({
      time, symbol, direction: sig.direction, price: sig.price,
      sl: sig.sl, tp: sig.tp, rr: Math.round(sig.rr * 10) / 10,
      outcome, pnlR, why: sig.why, vwapZone: sig.vwapZone,
    });

    console.log(
      `  ${outcome === 'WIN' ? '✅' : outcome === 'LOSS' ? '❌' : '⏱️'} ` +
      `${time}  ${sig.direction.padEnd(5)} @${sig.price.toFixed(2)}  ` +
      `SL=${sig.sl.toFixed(2)} TP=${sig.tp.toFixed(2)}  RR=${sig.rr.toFixed(1)}x  ` +
      `why=${sig.why}  zone=${sig.vwapZone}`
    );

    // Don't enter another trade until this one closes
    if (outcome !== 'TIMEOUT') {
      const closingBar = futureC1m.find(c =>
        (sig.direction === 'LONG' && (c.low <= sig.sl || c.high >= sig.tp)) ||
        (sig.direction === 'SHORT' && (c.high >= sig.sl || c.low <= sig.tp))
      );
      if (closingBar) lastTradeEndMs = closingBar.closeTime;
    } else {
      lastTradeEndMs = bar.closeTime + MAX_HOLD * 15 * 60000;
    }
  }

  return trades;
}

// ── Summary ─────────────────────────────────────────────────

function printSummary(allTrades) {
  if (!allTrades.length) { console.log('\nNo trades found.'); return; }

  const wins    = allTrades.filter(t => t.outcome === 'WIN');
  const losses  = allTrades.filter(t => t.outcome === 'LOSS');
  const timeout = allTrades.filter(t => t.outcome === 'TIMEOUT');
  const total   = allTrades.length;
  const wr      = Math.round(wins.length / total * 100);
  const totalR  = allTrades.reduce((s, t) => s + t.pnlR, 0);
  const avgRR   = wins.length ? (wins.reduce((s, t) => s + t.rr, 0) / wins.length).toFixed(2) : '0';
  const grossW  = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossL  = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const pf      = grossL > 0 ? (grossW / grossL).toFixed(2) : '∞';

  const longs  = allTrades.filter(t => t.direction === 'LONG');
  const shorts = allTrades.filter(t => t.direction === 'SHORT');
  const longWR  = longs.length  ? Math.round(longs.filter(t => t.outcome === 'WIN').length  / longs.length  * 100) : 0;
  const shortWR = shorts.length ? Math.round(shorts.filter(t => t.outcome === 'WIN').length / shorts.length * 100) : 0;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(` BACKTEST RESULTS — ${DAYS} days  (${ARG1})`);
  console.log('═'.repeat(60));
  console.log(` Total trades  : ${total}  (${wins.length}W / ${losses.length}L / ${timeout.length} timeout)`);
  console.log(` Win Rate      : ${wr}%`);
  console.log(` Avg RR (wins) : ${avgRR}x`);
  console.log(` Profit Factor : ${pf}  (need > 1.5 to be viable)`);
  console.log(` Net R         : ${totalR.toFixed(1)}R over ${DAYS} days`);
  console.log(` LONG  trades  : ${longs.length}  WR=${longWR}%`);
  console.log(` SHORT trades  : ${shorts.length}  WR=${shortWR}%`);
  console.log('─'.repeat(60));

  // Per-day breakdown
  const byDay = {};
  for (const t of allTrades) {
    const day = t.time.slice(0, 10);
    if (!byDay[day]) byDay[day] = { w: 0, l: 0, r: 0 };
    if (t.outcome === 'WIN')  byDay[day].w++;
    if (t.outcome === 'LOSS') byDay[day].l++;
    byDay[day].r += t.pnlR;
  }
  console.log(' Day breakdown:');
  for (const [day, d] of Object.entries(byDay)) {
    const dWR = d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0;
    const bar = d.r >= 0 ? '▓'.repeat(Math.min(10, Math.round(d.r * 2))) : '░'.repeat(Math.min(10, Math.round(-d.r * 2)));
    console.log(`   ${day}  ${d.w}W/${d.l}L  WR=${dWR}%  R=${d.r.toFixed(1)}  ${bar}`);
  }
  console.log('═'.repeat(60));

  // Worst losing streaks
  let streak = 0, maxStreak = 0;
  for (const t of allTrades) {
    if (t.outcome === 'LOSS') { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }
  console.log(` Max consec losses: ${maxStreak}`);

  // VWAP zone distribution
  const zones = {};
  for (const t of allTrades) zones[t.vwapZone] = (zones[t.vwapZone] || 0) + 1;
  console.log(` VWAP zones: ${Object.entries(zones).map(([k,v]) => `${k}=${v}`).join(' | ')}`);
  console.log('═'.repeat(60));
}

// ── Run ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` WIN RATE BACKTEST  |  ${ARG1}  |  ${DAYS} days`);
  console.log(`${'═'.repeat(60)}`);
  console.log(` VWAP mult=${VWAP_MULT}σ  SL=ATR×${ATR_SL_K}  TP=ATR×${ATR_TP_K}  minRR=${MIN_RR}`);

  const allTrades = [];

  for (const sym of SYMBOLS) {
    try {
      const trades = await backtestSymbol(sym);
      if (trades) allTrades.push(...trades);
    } catch (e) {
      console.error(`  ${sym} error: ${e.message}`);
    }
  }

  printSummary(allTrades);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
