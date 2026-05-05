'use strict';
// ════════════════════════════════════════════════════════════════
//  strategy-3timing.js  —  Live 3-Timing H4 + H1 + H1-micro
//
//  Ported from backtest-3timing-v3.js (51% WR, +$14,950 / 90 days).
//
//  Logic:
//    Tier 1 — H4 macro bias  : HH+HL → bullish | LL+LH → bearish
//    Tier 2 — H1 48-bar bias : must agree with H4
//    Tier 3 — H1 micro 16-bar: must still agree
//
//  SL / Trail (user's exact spec):
//    Initial SL : -25% cap from entry
//    At +30% cap: SL moves to +10% profit lock
//    At +46% cap: main trail — lock +45%, step +10% per +11%
// ════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const REQUEST_TIMEOUT = 15_000;

// ── Symbol config (backtest-validated 5-coin set) ─────────────
const ACTIVE_SYMBOLS = ['BTCUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'AVAXUSDT'];

const SYMBOL_LEVERAGE = {
  BTCUSDT: 100,
  BNBUSDT:  75,
  ADAUSDT:  75,
  SOLUSDT:  50,
  AVAXUSDT: 50,
};

// ── SL / trail constants ──────────────────────────────────────
const INITIAL_SL_CAP   = 0.25;   // 25% cap initial SL
const LOCK_TRIGGER_CAP = 0.30;   // move SL to profit lock when cap gain ≥ 30%
const LOCK_PROFIT_CAP  = 0.10;   // lock SL at +10% cap profit
const TRAIL_ON_CAP     = 0.46;   // main trail activates at +46% cap
const TRAIL_FIRST_LOCK = 0.45;   // first trail lock at +45% cap
const TRAIL_STEP_GAIN  = 0.11;   // trail steps every +11% cap
const TRAIL_STEP_LOCK  = 0.10;   // each step locks +10% more

// ── Structure detection constants ─────────────────────────────
const PIVOT_LEFT  = 2;
const PIVOT_RIGHT = 2;
const H4_STRUCT   = 30;  // H4 bars for macro bias window
const H1_CURR     = 48;  // H1 bars for intermediate bias
const H1_MICRO    = 16;  // H1 bars for micro bias
const COOLDOWN_H1 = 4;   // hours between signals per symbol

// ── Per-symbol cooldown ───────────────────────────────────────
const _lastSignalAt = new Map(); // symbol → timestamp ms

// ── Binance futures klines ────────────────────────────────────
async function fetchKlines(symbol, interval, limit) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
      if (res.ok) return res.json();
    } catch (_) {}
    if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

// ── H4 aggregation from H1 klines (UTC-aligned: 0/4/8/12/16/20) ─
function aggregateH4(h1Klines) {
  const bars  = [];
  let   group = [];

  for (const k of h1Klines) {
    const hourUtc = new Date(parseInt(k[0])).getUTCHours();
    if (hourUtc % 4 === 0 && group.length > 0) {
      bars.push({
        high:  Math.max(...group.map(b => parseFloat(b[2]))),
        low:   Math.min(...group.map(b => parseFloat(b[3]))),
        close: parseFloat(group[group.length - 1][4]),
      });
      group = [];
    }
    group.push(k);
  }
  if (group.length > 0) {
    bars.push({
      high:  Math.max(...group.map(b => parseFloat(b[2]))),
      low:   Math.min(...group.map(b => parseFloat(b[3]))),
      close: parseFloat(group[group.length - 1][4]),
    });
  }
  return bars;
}

// ── Pivot swing detection ─────────────────────────────────────
function swingHighs(bars) {
  const out = [];
  for (let i = PIVOT_LEFT; i < bars.length - PIVOT_RIGHT; i++) {
    let ok = true;
    for (let j = i - PIVOT_LEFT; j <= i + PIVOT_RIGHT; j++) {
      if (j !== i && bars[j].high >= bars[i].high) { ok = false; break; }
    }
    if (ok) out.push(bars[i].high);
  }
  return out;
}

function swingLows(bars) {
  const out = [];
  for (let i = PIVOT_LEFT; i < bars.length - PIVOT_RIGHT; i++) {
    let ok = true;
    for (let j = i - PIVOT_LEFT; j <= i + PIVOT_RIGHT; j++) {
      if (j !== i && bars[j].low <= bars[i].low) { ok = false; break; }
    }
    if (ok) out.push(bars[i].low);
  }
  return out;
}

// Returns 'bullish' | 'bearish' | 'neutral'
function getBias(bars) {
  if (!bars || bars.length < PIVOT_LEFT + PIVOT_RIGHT + 2) return 'neutral';
  const highs = swingHighs(bars);
  const lows  = swingLows(bars);
  if (highs.length < 2 || lows.length < 2) return 'neutral';
  const hh = highs.at(-1) > highs.at(-2);
  const lh = highs.at(-1) < highs.at(-2);
  const hl = lows.at(-1)  > lows.at(-2);
  const ll = lows.at(-1)  < lows.at(-2);
  if (hh && hl)  return 'bullish';
  if (ll && lh)  return 'bearish';
  if (hh && !ll) return 'bullish';
  if (ll && !hh) return 'bearish';
  return 'neutral';
}

// ── Trail SL (user's exact spec) ─────────────────────────────
// Returns the absolute SL price at the current market price.
// Caller ensures SL only moves in the favourable direction.
function calcTrail3Timing(entryPrice, currentPrice, side, leverage) {
  const pricePct = side === 'LONG'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  const capPct = pricePct * leverage;

  // Zone 2: main trail (≥ +46% cap)
  if (capPct >= TRAIL_ON_CAP - 0.0001) {
    const steps   = Math.floor((capPct - TRAIL_ON_CAP) / TRAIL_STEP_GAIN);
    const lockCap = TRAIL_FIRST_LOCK + steps * TRAIL_STEP_LOCK;
    const slPct   = lockCap / leverage;
    return side === 'LONG'
      ? entryPrice * (1 + slPct)
      : entryPrice * (1 - slPct);
  }

  // Zone 1: profit lock (+30–45% cap → lock +10%)
  if (capPct >= LOCK_TRIGGER_CAP) {
    const slPct = LOCK_PROFIT_CAP / leverage;
    return side === 'LONG'
      ? entryPrice * (1 + slPct)
      : entryPrice * (1 - slPct);
  }

  // Zone 0: fixed initial SL (-25% cap)
  const slPct = INITIAL_SL_CAP / leverage;
  return side === 'LONG'
    ? entryPrice * (1 - slPct)
    : entryPrice * (1 + slPct);
}

// ── Analyze one symbol ────────────────────────────────────────
async function analyzeSymbol(symbol, log) {
  const lev = SYMBOL_LEVERAGE[symbol] || 50;

  // Fetch enough H1 bars for H4_STRUCT*4 warmup + H1 windows + buffer
  const need = Math.min(H4_STRUCT * 4 + H1_CURR + 30, 500);
  const h1Klines = await fetchKlines(symbol, '1h', need);
  if (!h1Klines || h1Klines.length < H1_CURR + 10) {
    log(`3-timing: ${symbol} — insufficient H1 data (${h1Klines?.length ?? 0} bars)`);
    return null;
  }

  // Convert Binance kline arrays to OHLC objects
  const h1Bars = h1Klines.map(k => ({
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));

  const h4Bars = aggregateH4(h1Klines);
  if (h4Bars.length < H4_STRUCT + 2) {
    log(`3-timing: ${symbol} — insufficient H4 data (${h4Bars.length} bars)`);
    return null;
  }

  // Tier 1: H4 macro bias — exclude the forming H4 bar (last one)
  const h4Bias = getBias(h4Bars.slice(-H4_STRUCT - 1, -1));
  if (h4Bias === 'neutral') return null;

  // Tier 2: H1 intermediate bias — last H1_CURR confirmed bars
  const h1Bias = getBias(h1Bars.slice(-H1_CURR - 1, -1));
  if (h1Bias !== h4Bias) return null;

  // Tier 3: H1 micro bias — last H1_MICRO confirmed bars
  const micBias = getBias(h1Bars.slice(-H1_MICRO - 1, -1));
  if (micBias !== h4Bias) return null;

  // All 3 tiers aligned — generate signal
  const side  = h4Bias === 'bullish' ? 'LONG' : 'SHORT';
  const price = h1Bars.at(-1).close;
  const slPct = INITIAL_SL_CAP / lev;
  const sl    = side === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);

  return {
    symbol,
    lastPrice:  price,
    signal:     side === 'LONG' ? 'BUY' : 'SELL',
    side,
    direction:  side,
    entry:      price,
    sl,
    slPct:      (INITIAL_SL_CAP * 100).toFixed(2),
    setupName:  '3-Timing(H4+H1+H1m)',
    score:      3,
    tp1: null, tp2: null, tp3: null,
    // diagnostics
    h4Bias, h1Bias, micBias,
    timeframe: '4h+1h+1h-micro',
    version:   '3timing-v3',
  };
}

// ── Main scan (called each cycle from cycle.js) ───────────────
async function scan3Timing(log = console.log) {
  const now     = Date.now();
  const results = [];

  for (const symbol of ACTIVE_SYMBOLS) {
    try {
      // Per-symbol cooldown: skip if signal fired < COOLDOWN_H1 hours ago
      const lastAt    = _lastSignalAt.get(symbol) || 0;
      const hoursAgo  = (now - lastAt) / 3_600_000;
      if (hoursAgo < COOLDOWN_H1) {
        log(`3-timing: ${symbol} — cooldown (${(COOLDOWN_H1 - hoursAgo).toFixed(1)}h left)`);
        continue;
      }

      const sig = await analyzeSymbol(symbol, log);
      if (sig) {
        _lastSignalAt.set(symbol, now);
        results.push(sig);
        log(`3-timing: ✓ ${symbol} ${sig.side} | H4=${sig.h4Bias} H1=${sig.h1Bias} micro=${sig.micBias} price=$${sig.entry.toFixed(4)}`);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      log(`3-timing: ${symbol} — error: ${e.message}`);
    }
  }

  log(`3-timing: scan complete — ${results.length} signal(s)`);
  return results;
}

function getSessionMode() { return 'always'; }

module.exports = {
  ACTIVE_SYMBOLS,
  SYMBOL_LEVERAGE,
  scan3Timing,
  calcTrail3Timing,
  getSessionMode,
};
