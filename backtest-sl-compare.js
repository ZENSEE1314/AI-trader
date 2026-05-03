// ════════════════════════════════════════════════════════════════
//  backtest-sl-compare.js
//
//  Side-by-side comparison of two trailing SL systems on the same
//  analyzeV3 signals and live historical klines.
//
//  System 5  : 10% initial SL, trail kicks in at +46% → locks +45%
//  System 80 : 10% initial SL, trail kicks in at +81% → locks +80%
//  Both       : +10% SL every +11% capital gain after first lock
//
//  Run:
//    DAYS=30 node backtest-sl-compare.js
//    DAYS=14 SYMBOLS=BTCUSDT,ETHUSDT node backtest-sl-compare.js
//
//  Output: per-coin table + aggregate side-by-side + trade log.
// ════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');
const fs   = require('fs');
const path = require('path');
const { analyzeV3, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE, atr: calcAtr } = require('./strategy-v3');

const TV_CACHE_DIR = path.join(__dirname, 'data', 'tv-cache');

const DAYS    = parseInt(process.env.DAYS    || '30', 10);
const CAPITAL = parseFloat(process.env.CAPITAL || '1000');
const RISK    = parseFloat(process.env.RISK    || '0.10');  // 10% position per trade
const SYMBOLS = (process.env.SYMBOLS || ACTIVE_SYMBOLS.join(',')).split(',').map(s => s.trim());

const REQUEST_TIMEOUT = 20_000;

// ── Trailing SL configs ──────────────────────────────────────
// Both start at -10% capital initial SL.
// trailOn  = capital % gain where trail first activates
// firstLock = capital % locked at activation
// Then +10% SL every +11% capital gain thereafter.
const SYSTEMS = [
  { name: 'System 5 (45%)',  trailOn: 0.46, firstLock: 0.45 },
  { name: 'System 80 (80%)', trailOn: 0.81, firstLock: 0.80 },
];

const INITIAL_SL_CAP = 0.25;  // 25% capital initial SL (same for both)

// ── Helpers ──────────────────────────────────────────────────
function fmtUsd(n)  { return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'; }
function fmtPct(n)  { return Number.isFinite(n) ? `${(n >= 0 ? '+' : '')}${n.toFixed(2)}%` : '—'; }
function pad(s, w)  { return String(s).padEnd(w); }
function rpad(s, w) { return String(s).padStart(w); }

// Simple EMA for diagnostic use in the backtest (not exported from strategy-v3)
function emaCalc(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

// ── SL calculator — mirrors calcTrailingSLV3 in strategy-v3.js ──
// Safety tier: when capital gain reaches +30%, lock in +10% profit.
// Fires before the main trail activates (+46% off-session / +61% SMC).
// If the trade reverses after +30%, you exit with +$10 instead of -$25.
// The bar-loop ratchet ensures the SL never moves backwards after this fires.
const SAFETY_TRIGGER = 0.30; // +30% capital → lock profit
const SAFETY_LOCK    = 0.10; // SL moves to +10% capital profit

function calcSL(entry, close, side, leverage, trailOn, firstLock) {
  const pricePct = side === 'LONG'
    ? (close - entry) / entry
    : (entry - close) / entry;
  const capitalPct = pricePct * leverage;

  if (capitalPct < trailOn - 0.0001) {
    // Safety: at +30% lock in +10% profit before main trail activates
    if (capitalPct >= SAFETY_TRIGGER) {
      const safeSlPricePct = SAFETY_LOCK / leverage;
      return side === 'LONG'
        ? entry * (1 + safeSlPricePct)
        : entry * (1 - safeSlPricePct);
    }
    // Below safety trigger — keep full initial SL
    const slPricePct = INITIAL_SL_CAP / leverage;
    return side === 'LONG'
      ? entry * (1 - slPricePct)
      : entry * (1 + slPricePct);
  }

  // First lock + +10% every +11% thereafter
  const offsetPct  = Math.round((capitalPct - trailOn) * 10000) / 10000;
  const stepsAbove = Math.floor(offsetPct / 0.11);
  const lockCapPct = firstLock + stepsAbove * 0.10;
  const lockPricePct = lockCapPct / leverage;

  return side === 'LONG'
    ? entry * (1 + lockPricePct)
    : entry * (1 - lockPricePct);
}

// ── Kline fetcher (multi-source fallback) ────────────────────
async function fetchAll(symbol, interval, totalNeeded) {
  // TradingView cache (populated by fetch-tv-data.js) — check first
  const tvFile = path.join(TV_CACHE_DIR, `${symbol}-${interval}.json`);
  if (fs.existsSync(tvFile)) {
    const cached = JSON.parse(fs.readFileSync(tvFile));
    if (cached.length >= Math.floor(totalNeeded * 0.7)) {
      console.log(`  [${symbol} ${interval}] ${cached.length} bars from tv-cache`);
      return cached.slice(-totalNeeded);
    }
  }

  const intervalMs = ({ '1m': 60e3, '3m': 180e3, '15m': 900e3, '1h': 3600e3 })[interval];
  const okxSym = symbol.replace('USDT', '-USDT-SWAP');
  const okxBar = interval === '1h' ? '1H' : interval;
  const ccBase = symbol.replace('USDT', '');
  const ccEndpoint = interval === '1h' ? 'histohour' : interval === '1m' ? 'histominute' : null;

  const out = [];
  let endTime = Date.now();
  let firstAttempt = true;

  while (out.length < totalNeeded) {
    const limit = Math.min(1000, totalNeeded - out.length);
    const startTime = endTime - limit * intervalMs;

    const tries = [
      {
        name: 'binance-fapi',
        url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`,
        parse: j => Array.isArray(j) ? j : null,
      },
      {
        name: 'binance-spot',
        url: `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`,
        parse: j => Array.isArray(j) ? j : null,
      },
      {
        name: 'bybit',
        url: `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval.replace('m','').replace('h','60')}&start=${startTime}&end=${endTime}&limit=${Math.min(1000,limit)}`,
        parse: j => j.result?.list?.length
          ? j.result.list.slice().reverse().map(k => [parseInt(k[0]), k[1], k[2], k[3], k[4], k[5]])
          : null,
      },
      {
        name: 'okx',
        url: `https://www.okx.com/api/v5/market/history-candles?instId=${okxSym}&bar=${okxBar}&after=${endTime}&limit=${Math.min(300, limit)}`,
        parse: j => (j.code === '0' && j.data?.length)
          ? j.data.slice().reverse().map(k => [parseInt(k[0]), k[1], k[2], k[3], k[4], k[5]])
          : null,
      },
    ];
    if (ccEndpoint) {
      tries.push({
        name: 'cryptocompare',
        url: `https://min-api.cryptocompare.com/data/v2/${ccEndpoint}?fsym=${ccBase}&tsym=USDT&limit=${Math.min(2000, limit)}&toTs=${Math.floor(endTime / 1000)}`,
        parse: j => (j.Response === 'Success' && j.Data?.Data?.length)
          ? j.Data.Data.map(d => [d.time * 1000, String(d.open), String(d.high), String(d.low), String(d.close), String(d.volumefrom)])
          : null,
      });
    }

    let batch = null, usedSrc = null, lastErr = '';
    for (const t of tries) {
      try {
        const r = await fetch(t.url, { timeout: REQUEST_TIMEOUT });
        if (!r.ok) { lastErr = `${t.name} HTTP ${r.status}`; continue; }
        const j = await r.json();
        const arr = t.parse(j);
        if (arr && arr.length) { batch = arr; usedSrc = t.name; break; }
        lastErr = `${t.name} empty`;
      } catch (e) { lastErr = `${t.name} ${e.message}`; }
    }

    if (firstAttempt) {
      console.log(`  [${symbol} ${interval}] ${batch ? `${batch.length} bars from ${usedSrc}` : `FAILED — ${lastErr}`}`);
      firstAttempt = false;
    }
    if (!batch || !batch.length) break;
    out.unshift(...batch);
    endTime = parseInt(batch[0][0]) - 1;
    if (out.length >= totalNeeded) break;
  }
  return out.slice(-totalNeeded);
}

function aggregate(klines1m, nMin) {
  const out = [];
  for (let i = 0; i + nMin <= klines1m.length; i += nMin) {
    const slice = klines1m.slice(i, i + nMin);
    let h = -Infinity, l = Infinity, v = 0;
    for (const k of slice) {
      if (parseFloat(k[2]) > h) h = parseFloat(k[2]);
      if (parseFloat(k[3]) < l) l = parseFloat(k[3]);
      v += parseFloat(k[5] || 0);
    }
    out.push([parseInt(slice[0][0]), slice[0][1], String(h), String(l), slice[slice.length-1][4], String(v)]);
  }
  return out;
}

// ── Simulate one system on a pre-collected signal list ───────
// signals: [{ entryTs, entry, side, setup, k1mAfter, ... }]
// Enforces sequential trades: if a signal fires while a previous trade
// is still open (based on actual exit timestamp), it is skipped.
// This makes the result independent of the signal collection logic.
function simulateSystem(signals, leverage, sys) {
  const trades = [];
  let lastExitTs = 0; // timestamp when the last trade closed

  for (const sig of signals) {
    // Skip if this signal arrived while a prior trade was still open
    if (sig.entryTs < lastExitTs) continue;

    const { entry, side, setup, k1mAfter, entryTs } = sig;
    const isLong = side === 'LONG';
    // SMC session opens (Asia/London/NY) hold to +60% before locking;
    // off-session uses the system default (typically +46% → +45%).
    const trailOn   = sig.sessionMode === 'smc' ? 0.61 : sys.trailOn;
    const firstLock = sig.sessionMode === 'smc' ? 0.60 : sys.firstLock;
    let sl = isLong
      ? entry * (1 - INITIAL_SL_CAP / leverage)
      : entry * (1 + INITIAL_SL_CAP / leverage);

    let exitTs = null, exitPrice = null, exitReason = null;
    let mfePrice = entry; // Maximum Favorable Excursion: best price reached during trade

    for (const bar of k1mAfter) {
      const high  = parseFloat(bar[2]);
      const low   = parseFloat(bar[3]);
      const close = parseFloat(bar[4]);
      const ts    = parseInt(bar[0]);

      // Track peak price for MFE
      if (isLong  && high  > mfePrice) mfePrice = high;
      if (!isLong && low   < mfePrice) mfePrice = low;

      // Check SL hit on this bar (using low/high for realistic fill)
      const slHit = isLong ? low <= sl : high >= sl;
      if (slHit) {
        exitTs = ts; exitPrice = sl; exitReason = 'SL';
        break;
      }

      // Update trailing SL using close of this bar
      const newSl = calcSL(entry, close, side, leverage, trailOn, firstLock);
      // SL can only move in the profitable direction (ratchet)
      if (isLong && newSl > sl) sl = newSl;
      if (!isLong && newSl < sl) sl = newSl;
    }

    // If no exit found, close at last bar
    if (!exitTs) {
      const last = k1mAfter[k1mAfter.length - 1];
      exitTs = parseInt(last[0]);
      exitPrice = parseFloat(last[4]);
      exitReason = 'EOD';
    }

    lastExitTs = exitTs; // gate: next signal must start after this trade closed

    const pnlPct = isLong
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;
    const pnlUsd = CAPITAL * RISK * pnlPct * leverage;

    // MFE as % capital profit (same units as trailing SL)
    const mfePricePct = isLong
      ? (mfePrice - entry) / entry
      : (entry - mfePrice) / entry;
    const mfeCapitalPct = mfePricePct * leverage * 100; // e.g. 150 = +150% capital

    trades.push({
      side, setup, entry, sl: exitPrice, exitReason, pnlPct, pnlUsd, entryTs, exitTs,
      mfeCapitalPct,  // peak capital profit % seen during the trade
      // Session + style
      sessionMode:              sig.sessionMode              || 'smc',
      isVWAPFade:               sig.isVWAPFade               || false,
      isStructureShift:         sig.isStructureShift         || false,
      isSessionOpenAggressive:  sig.isSessionOpenAggressive  || false,
      // Propagate diagnostic fields for loss analysis
      h1trend:        sig.h1trend        || '??',
      emaSpreadPct:   sig.emaSpreadPct   ?? null,
      priceVsVwapPct: sig.priceVsVwapPct ?? null,
      utcH:           sig.utcH           ?? null,
      atrPct:         sig.atrPct         ?? null,
    });
  }

  return trades;
}

// ── MCT Session Time Filter (PDF rules) ─────────────────────
// Only trade during the 3 high-liquidity windows (SGT = UTC+8):
//   Asia    : 7:00–10:00 SGT  → 23:00–02:00 UTC
//   Europe  : 3:00–6:00  SGT  → 07:00–10:00 UTC
//   US      : 8:00–12:00 SGT  → 12:00–16:00 UTC
// Also skip entries at :00/:15/:30/:45 minute marks (candle-close chop)
// and within 10 min of the session-boundary hours (8am/12pm/4pm/8pm SGT).
function isInTradingSession(ts) {
  const d   = new Date(ts);
  const utcH = d.getUTCHours();
  const utcM = d.getUTCMinutes();
  const utcFrac = utcH + utcM / 60;

  // Active windows in UTC hours
  const inAsia   = utcFrac >= 23.0 || utcFrac < 2.0;    // 23:00–02:00 UTC
  const inEurope = utcFrac >= 7.0  && utcFrac < 10.0;   // 07:00–10:00 UTC
  const inUS     = utcFrac >= 12.0 && utcFrac < 16.0;   // 12:00–16:00 UTC
  if (!inAsia && !inEurope && !inUS) return false;

  // Avoid :00/:15/:30/:45 candle-close minute marks (±1 min buffer)
  const minMod = utcM % 15;
  if (minMod <= 1 || minMod >= 14) return false;

  return true;
}

// ── Entry confirmation buffer per symbol ────────────────────
// For volatile coins, don't enter at the exact signal bar close.
// Wait until price moves this % in the signal direction first.
// If price immediately reverses and never confirms, skip the entry → zero loss.
// At 50x: 0.15% price = 7.5% capital move before entry (filters noise reversals).
const CONFIRM_PCT = {
  SOLUSDT: 0.0008,  // 0.08% price confirmation — filters immediate reversals, keeps more trades
  XRPUSDT: 0.0005,  // 0.05% price confirmation — light filter for XRP
};

// ── Known-loser reversal candidates ─────────────────────────
// These are setups that were 0-12% WR as-is but may be profitable
// if the direction is FLIPPED (e.g. MomentumBreakout+@RangeHigh as
// LONG = 8% WR; reversed to SHORT = potentially 92% WR).
const REVERSAL_PREFIXES = [
  'MomentumBreakout+@RangeHigh',   // bull trap → flip to SHORT
  'MSTF+@15HH+1mHH',               // buying overextended 15m HH → flip SHORT
  'MSTF+@15LL+1mLL',               // selling overextended 15m LL → flip LONG
  'VWAPTrend+@VWAP+EMADn',         // VWAP short in downtrend (0% WR) → flip LONG
];

// ── Run one symbol: collect signals once, simulate both systems ─
async function runSymbol(symbol) {
  const lev = SYMBOL_LEVERAGE[symbol] || 100;
  console.log(`\n── ${symbol} (${lev}x) — fetching ${DAYS} days...`);

  const N1m  = DAYS * 1440;
  const N3m  = DAYS * 480;
  const N15m = DAYS * 96;
  const N1h  = DAYS * 24 + 72;

  const [k1m, k3mFetched, k15mFetched, k1h] = await Promise.all([
    fetchAll(symbol, '1m',  N1m),
    fetchAll(symbol, '3m',  N3m),
    fetchAll(symbol, '15m', N15m),
    fetchAll(symbol, '1h',  N1h),
  ]);

  const k3m  = k3mFetched.length  ? k3mFetched  : aggregate(k1m, 3);
  const k15m = k15mFetched.length ? k15mFetched : aggregate(k1m, 15);
  if (!k3mFetched.length  && k1m.length) console.log(`  ↳ 3m  aggregated → ${k3m.length} bars`);
  if (!k15mFetched.length && k1m.length) console.log(`  ↳ 15m aggregated → ${k15m.length} bars`);

  console.log(`  fetched: 1m=${k1m.length} 3m=${k3m.length} 15m=${k15m.length} 1h=${k1h.length}`);
  if (k1m.length < 200 || k15m.length < 30) { console.log(`  insufficient data — skip`); return null; }

  // Build ts→idx maps for aligned windows
  const byTs = {
    '3m':  new Map(k3m.map((k, i) => [parseInt(k[0]), i])),
    '15m': new Map(k15m.map((k, i) => [parseInt(k[0]), i])),
    '1h':  new Map(k1h.map((k, i) => [parseInt(k[0]), i])),
  };
  function lastIdxAtOrBefore(map, ts) {
    for (let off = 0; off <= 60; off++) {
      const idx = map.get(ts - off * 60_000);
      if (idx !== undefined) return idx;
    }
    return -1;
  }

  // ── Signal collection pass (run analyzeV3 once per bar) ──
  // Collects ALL candidate signals with NO inTrade gating — the simulation
  // enforces "one trade at a time" via lastExitTs, making trade counts
  // independent of SL size. Different SL configs see the same signal set.
  const signals = [];
  let analyzeCalls = 0, analyzeErrs = 0;
  const confirmPct = CONFIRM_PCT[symbol] || 0;

  for (let i = 100; i < k1m.length - 1; i++) {
    const bar   = k1m[i];
    const ts    = parseInt(bar[0]);
    const close = parseFloat(bar[4]);

    const i3m  = lastIdxAtOrBefore(byTs['3m'],  ts);
    const i15m = lastIdxAtOrBefore(byTs['15m'], ts);
    const i1h  = lastIdxAtOrBefore(byTs['1h'],  ts);
    if (i3m < 30 || i15m < 30 || i1h < 24) continue;

    const k1mWin  = k1m.slice(Math.max(0, i - 59), i + 1);
    const k3mWin  = k3m.slice(Math.max(0, i3m - 99),  i3m + 1);
    const k15mWin = k15m.slice(Math.max(0, i15m - 99), i15m + 1);
    const k1hWin  = k1h.slice(Math.max(0, i1h - 71),  i1h + 1);

    let sig = null;
    try {
      sig = await analyzeV3({
        symbol,
        lastPrice: String(close),
        klines: { k1m: k1mWin, k3m: k3mWin, k15m: k15mWin, k1h: k1hWin },
      });
    } catch (e) { analyzeErrs++; }
    analyzeCalls++;

    if (!sig || !sig.direction) continue;

    // ── Confirmation buffer (volatile symbols) ──────────────
    // For SOL/XRP: don't enter at exact signal close. Scan the next
    // few bars until price has moved confirmPct% in the signal direction.
    // If price immediately reverses and never confirms → skip (zero loss).
    let entryBarIdx = i;
    let entryPrice  = close;
    if (confirmPct > 0) {
      const isLong = sig.direction === 'LONG';
      let confirmed = false;
      for (let j = i + 1; j < Math.min(k1m.length, i + 6); j++) {
        const c    = parseFloat(k1m[j][4]);
        const moved = isLong ? (c - close) / close : (close - c) / close;
        if (moved >= confirmPct) {
          entryBarIdx = j;
          entryPrice  = c;
          confirmed   = true;
          break;
        }
      }
      if (!confirmed) continue; // reversed before confirming → skip
    }

    const k1mAfter = k1m.slice(entryBarIdx + 1, Math.min(k1m.length, entryBarIdx + 1 + 7 * 1440));
    if (!k1mAfter.length) continue;

    const entryTs = parseInt(k1m[entryBarIdx][0]);

    // ── Diagnostics for loss analysis ──────────────────────
    const k1hWinNow   = k1h.slice(Math.max(0, i1h - 71), i1h + 1);
    const k1hCloses   = k1hWinNow.map(k => parseFloat(k[4]));
    const ema9_1h     = emaCalc(k1hCloses, 9);
    const ema21_1h    = emaCalc(k1hCloses, 21);
    const h1trend     = ema9_1h && ema21_1h ? (ema9_1h > ema21_1h ? 'UP' : 'DN') : '??';
    const ema9_15     = sig.ema9  || null;
    const ema21_15    = sig.ema21 || null;
    const emaSpreadPct = ema9_15 && ema21_15
      ? ((ema9_15 - ema21_15) / ema21_15 * 100)
      : null;
    const vwap        = sig.vwap || null;
    const priceVsVwapPct = vwap ? ((close - vwap) / vwap * 100) : null;
    const utcH        = new Date(ts).getUTCHours();

    // ATR(14) on 1m — average candle range as % of price.
    // Used to detect low-movement markets where the trade can't reach +30% safety lock.
    const atr14       = calcAtr(k1mWin, 14);
    const atrPct      = atr14 && close > 0 ? (atr14 / close * 100) : null;

    signals.push({
      entryTs,
      entry:   entryPrice,
      side:    sig.direction,
      setup:   sig.setupName || 'unknown',
      score:   sig.score || 0,
      k1mAfter,
      // Session + style
      sessionMode:              sig.sessionMode              || 'smc',
      isVWAPFade:               sig.isVWAPFade               || false,
      isStructureShift:         sig.isStructureShift         || false,
      isSessionOpenAggressive:  sig.isSessionOpenAggressive  || false,
      // Diagnostics
      h1trend,
      ema9_1h,  ema21_1h,
      ema9_15,  ema21_15,
      emaSpreadPct,
      vwap,
      priceVsVwapPct,
      utcH,
      atrPct,   // 1m ATR(14) as % of price — how much the market moves per candle
    });
  }

  console.log(`  signals found: ${signals.length}  (analyzeV3 calls=${analyzeCalls} errs=${analyzeErrs})`);
  if (!signals.length) return null;

  // ── Reversal pass: collect known-loser setups with flipped direction ──
  // Runs the same bars again with skipBlocklist=true, filters to REVERSAL_PREFIXES
  // setups, flips their direction, and simulates separately.
  const reversalSignals = [];
  let revInTrade = false;

  for (let i = 100; i < k1m.length - 1; i++) {
    const bar   = k1m[i];
    const ts    = parseInt(bar[0]);
    const close = parseFloat(bar[4]);

    if (revInTrade) {
      const lastSig = reversalSignals[reversalSignals.length - 1];
      if (lastSig) {
        const slSys5 = calcSL(lastSig.entry, close, lastSig.side, lev, 0.46, 0.45);
        const high = parseFloat(bar[2]), low = parseFloat(bar[3]);
        if (lastSig.side === 'LONG' ? low <= slSys5 : high >= slSys5) revInTrade = false;
        if (ts - lastSig.entryTs > 7 * 24 * 60 * 60 * 1000) revInTrade = false;
      }
      if (revInTrade) continue;
    }

    const i3m  = lastIdxAtOrBefore(byTs['3m'],  ts);
    const i15m = lastIdxAtOrBefore(byTs['15m'], ts);
    const i1h  = lastIdxAtOrBefore(byTs['1h'],  ts);
    if (i3m < 30 || i15m < 30 || i1h < 24) continue;

    const k1mWin  = k1m.slice(Math.max(0, i - 59), i + 1);
    const k3mWin  = k3m.slice(Math.max(0, i3m - 99),  i3m + 1);
    const k15mWin = k15m.slice(Math.max(0, i15m - 99), i15m + 1);
    const k1hWin  = k1h.slice(Math.max(0, i1h - 71),  i1h + 1);

    let revSig = null;
    try {
      revSig = await analyzeV3({
        symbol,
        lastPrice: String(close),
        klines: { k1m: k1mWin, k3m: k3mWin, k15m: k15mWin, k1h: k1hWin },
      }, { skipBlocklist: true });
    } catch (_) {}

    if (!revSig?.direction) continue;

    const setupNm = revSig.setupName || 'unknown';
    const isReversal = REVERSAL_PREFIXES.some(pfx => setupNm.startsWith(pfx));
    if (!isReversal) continue;

    // Flip the direction for this known-loser setup
    const flippedDir = revSig.direction === 'LONG' ? 'SHORT' : 'LONG';

    const k1mAfter = k1m.slice(i + 1, Math.min(k1m.length, i + 1 + 7 * 1440));
    if (!k1mAfter.length) continue;

    reversalSignals.push({
      entryTs: ts,
      entry:   close,
      side:    flippedDir,
      setup:   `REV:${setupNm}`,
      score:   revSig.score || 0,
      k1mAfter,
    });
    revInTrade = true;
  }

  console.log(`  reversal signals: ${reversalSignals.length}`);

  // ── Simulate both systems on the same signals ──
  const results = {};
  for (const sys of SYSTEMS) {
    results[sys.name] = simulateSystem(signals, lev, sys);
  }

  // Reversal system simulation (known-loser setups flipped)
  const reversalTrades = reversalSignals.length
    ? simulateSystem(reversalSignals, lev, SYSTEMS[0])
    : [];

  // FULL flip: take every normal signal and reverse its direction
  const allFlippedSignals = signals.map(s => ({
    ...s,
    side:  s.side === 'LONG' ? 'SHORT' : 'LONG',
    setup: `FLIP:${s.setup}`,
  }));
  const fullFlipTrades = allFlippedSignals.length
    ? simulateSystem(allFlippedSignals, lev, SYSTEMS[0])
    : [];

  return { symbol, lev, signals, results, reversalTrades, fullFlipTrades };
}

// ── Stats helper ─────────────────────────────────────────────
function stats(trades) {
  if (!trades.length) return { total: 0, wins: 0, losses: 0, wr: 0, net: 0, avgWin: 0, avgLoss: 0 };
  const wins   = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const net    = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const avgWin  = wins.length   ? wins.reduce((s, t)   => s + t.pnlUsd, 0) / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : 0;
  return {
    total:   trades.length,
    wins:    wins.length,
    losses:  losses.length,
    wr:      (wins.length / trades.length) * 100,
    net,
    avgWin,
    avgLoss,
    profitFactor: losses.length && Math.abs(avgLoss) > 0
      ? (wins.reduce((s, t) => s + t.pnlUsd, 0)) / Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0))
      : Infinity,
  };
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const SYS5 = SYSTEMS[0];  // System 5 only

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  SYSTEM 5 BACKTEST — ${DAYS} days — $${CAPITAL} start — ${(RISK*100).toFixed(0)}% risk/trade`);
  console.log(`  −10% initial SL, trail at +46% → lock +45%, then +10% SL per +11%`);
  console.log('═══════════════════════════════════════════════════════════════════');

  const allSymResults = [];
  for (const sym of SYMBOLS) {
    const r = await runSymbol(sym);
    if (r) allSymResults.push(r);
  }

  if (!allSymResults.length) { console.log('\nNo results.'); process.exit(0); }

  // ── Per-coin table ───────────────────────────────────────
  console.log('\n══════════ PER-COIN RESULTS ════════════════════════════════════════');
  console.log(`${'symbol'.padEnd(11)} ${'lev'.padEnd(5)} ${'trades'.padStart(6)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'WR%'.padStart(6)} ${'avg W'.padStart(9)} ${'avg L'.padStart(9)} ${'net P&L'.padStart(10)}`);
  console.log('─'.repeat(70));

  let allTrades = [];
  let totWins = 0, totLosses = 0, totNet = 0;

  for (const r of allSymResults) {
    const trades = r.results[SYS5.name];
    const s = stats(trades);
    console.log(
      `${pad(r.symbol, 11)} ${pad(r.lev + 'x', 5)} ${rpad(s.total, 6)} ${rpad(s.wins, 4)} ${rpad(s.losses, 4)}` +
      ` ${rpad(s.wr.toFixed(1) + '%', 6)} ${rpad(fmtUsd(s.avgWin), 9)} ${rpad(fmtUsd(s.avgLoss), 9)} ${rpad(fmtUsd(s.net), 10)}`
    );
    allTrades.push(...trades.map(t => ({ ...t, symbol: r.symbol, lev: r.lev })));
    totWins   += s.wins;
    totLosses += s.losses;
    totNet    += s.net;
  }
  const totTrades = totWins + totLosses;
  const totWR = totTrades ? (totWins / totTrades) * 100 : 0;
  console.log('─'.repeat(70));
  console.log(
    `${'TOTAL'.padEnd(16)} ${rpad(totTrades, 6)} ${rpad(totWins, 4)} ${rpad(totLosses, 4)}` +
    ` ${rpad(totWR.toFixed(1) + '%', 6)}` +
    `${' '.repeat(20)} ${rpad(fmtUsd(totNet), 10)}`
  );
  console.log(`  Final capital: $${(CAPITAL + totNet).toFixed(2)}  (${totNet >= 0 ? '+' : ''}${((totNet / CAPITAL) * 100).toFixed(1)}% return)`);

  // ── By setup ─────────────────────────────────────────────
  console.log('\n══════════ BY SETUP (worst losers first) ═══════════════════════════');
  console.log(`${'setup'.padEnd(38)} ${'n'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'WR%'.padStart(6)} ${'net'.padStart(9)}`);
  console.log('─'.repeat(70));
  const bySetup = {};
  for (const t of allTrades) {
    if (!bySetup[t.setup]) bySetup[t.setup] = { wins: 0, losses: 0, net: 0 };
    bySetup[t.setup].net += t.pnlUsd;
    if (t.pnlUsd > 0) bySetup[t.setup].wins++; else bySetup[t.setup].losses++;
  }
  // Sort by net (worst first)
  for (const [name, v] of Object.entries(bySetup).sort((a, b) => a[1].net - b[1].net)) {
    const n  = v.wins + v.losses;
    const wr = (v.wins / n) * 100;
    const marker = v.net < 0 ? ' ◄ LOSING' : '';
    console.log(`${pad(name, 38)} ${rpad(n, 4)} ${rpad(v.wins, 4)} ${rpad(v.losses, 4)} ${rpad(wr.toFixed(1) + '%', 6)} ${rpad(fmtUsd(v.net), 9)}${marker}`);
  }

  // ── By direction ─────────────────────────────────────────
  console.log('\n══════════ LONG vs SHORT ═══════════════════════════════════════════');
  for (const dir of ['LONG', 'SHORT']) {
    const dt = allTrades.filter(t => t.side === dir);
    if (!dt.length) continue;
    const s = stats(dt);
    console.log(`  ${dir.padEnd(6)}  ${s.total} trades   W=${s.wins}  L=${s.losses}   WR=${s.wr.toFixed(1)}%   avg win=${fmtUsd(s.avgWin)}   avg loss=${fmtUsd(s.avgLoss)}   net=${fmtUsd(s.net)}`);
  }

  // ── By session mode ──────────────────────────────────────
  console.log('\n══════════ SMC SESSION vs OFF-SESSION ══════════════════════════════');
  for (const mode of ['smc', 'off']) {
    const mt = allTrades.filter(t => t.sessionMode === mode);
    if (!mt.length) continue;
    const s = stats(mt);
    const label = mode === 'smc' ? 'SMC (session opens)' : 'OFF (between sessions)';
    console.log(`  ${label.padEnd(22)} ${s.total} trades   W=${s.wins}  L=${s.losses}   WR=${s.wr.toFixed(1)}%   avg win=${fmtUsd(s.avgWin)}   avg loss=${fmtUsd(s.avgLoss)}   net=${fmtUsd(s.net)}`);
  }
  const fadeTradesAll = allTrades.filter(t => t.isVWAPFade);
  if (fadeTradesAll.length) {
    const fs = stats(fadeTradesAll);
    console.log(`  ${'VWAPFade only'.padEnd(22)} ${fs.total} trades   W=${fs.wins}  L=${fs.losses}   WR=${fs.wr.toFixed(1)}%   avg win=${fmtUsd(fs.avgWin)}   avg loss=${fmtUsd(fs.avgLoss)}   net=${fmtUsd(fs.net)}`);
  } else {
    console.log('  (no VWAPFade trades in this run)');
  }
  const shiftTradesAll = allTrades.filter(t => t.isStructureShift);
  if (shiftTradesAll.length) {
    const ss = stats(shiftTradesAll);
    console.log(`  ${'StructureShift only'.padEnd(22)} ${ss.total} trades   W=${ss.wins}  L=${ss.losses}   WR=${ss.wr.toFixed(1)}%   avg win=${fmtUsd(ss.avgWin)}   avg loss=${fmtUsd(ss.avgLoss)}   net=${fmtUsd(ss.net)}`);
  } else {
    console.log('  (no StructureShift trades in this run)');
  }
  const soaTrades = allTrades.filter(t => t.isSessionOpenAggressive);
  if (soaTrades.length) {
    const sa = stats(soaTrades);
    console.log(`  ${'SessionOpen (aggr)'.padEnd(22)} ${sa.total} trades   W=${sa.wins}  L=${sa.losses}   WR=${sa.wr.toFixed(1)}%   avg win=${fmtUsd(sa.avgWin)}   avg loss=${fmtUsd(sa.avgLoss)}   net=${fmtUsd(sa.net)}`);
  } else {
    console.log('  (no session-open aggressive trades in this run)');
  }

  // ── Per-symbol setup breakdown ───────────────────────────
  console.log('\n══════════ PER-SYMBOL SETUP BREAKDOWN ═════════════════════════════');
  for (const r of allSymResults) {
    const trades = r.results[SYS5.name].map(t => ({ ...t, symbol: r.symbol, lev: r.lev }));
    if (!trades.length) continue;
    const symSetups = {};
    for (const t of trades) {
      if (!symSetups[t.setup]) symSetups[t.setup] = { wins: 0, losses: 0, net: 0 };
      symSetups[t.setup].net += t.pnlUsd;
      if (t.pnlUsd > 0) symSetups[t.setup].wins++; else symSetups[t.setup].losses++;
    }
    const ss = stats(trades);
    console.log(`\n  ${r.symbol} (${r.lev}x)  ${ss.total} trades  ${ss.wr.toFixed(1)}% WR  net ${fmtUsd(ss.net)}`);
    for (const [name, v] of Object.entries(symSetups).sort((a, b) => a[1].net - b[1].net)) {
      const n = v.wins + v.losses;
      const wr = (v.wins / n * 100).toFixed(0);
      const marker = v.net < 0 ? ' ◄' : '';
      console.log(`    ${pad(name, 42)} ${rpad(n, 2)}t  ${rpad(wr + '%', 5)} WR  ${rpad(fmtUsd(v.net), 9)}${marker}`);
    }
  }

  // ── Losing setups detail ─────────────────────────────────
  const losingSetups = Object.entries(bySetup)
    .filter(([, v]) => v.net < 0)
    .sort((a, b) => a[1].net - b[1].net);

  if (losingSetups.length) {
    console.log('\n══════════ ROOT CAUSE — LOSING SETUP EXAMPLES ═════════════════════');
    for (const [name] of losingSetups.slice(0, 3)) {
      const examples = allTrades
        .filter(t => t.setup === name && t.pnlUsd < 0)
        .slice(0, 3);
      console.log(`\n  ${name}:`);
      for (const t of examples) {
        const ts = new Date(t.entryTs).toISOString().slice(0, 16);
        console.log(`    ${ts}  ${t.symbol} ${t.side}  entry=$${t.entry.toFixed(2)}  pnl=${fmtUsd(t.pnlUsd)}`);
      }
    }
  }

  // ── MFE ANALYSIS — peak profit reached during each trade ─
  // Shows how high the trade went before the trailing SL exited.
  // Key question: do SMC session trades hit 100%+ capital profit?
  // If yes → raise trailConfig.startPct for SMC trades so we let them run.
  console.log('\n══════════ MFE — PEAK CAPITAL PROFIT DURING TRADE ═════════════════');
  const mfeBuckets = [0, 20, 50, 100, 150, 200, 300, Infinity];
  const bucketLabel = (lo, hi) => hi === Infinity ? `>${lo}%` : `${lo}–${hi}%`;
  for (const mode of ['smc', 'off', 'all']) {
    const mt = mode === 'all' ? allTrades : allTrades.filter(t => t.sessionMode === mode);
    if (!mt.length) continue;
    const wins = mt.filter(t => t.pnlUsd > 0);
    const label = mode === 'smc' ? 'SMC wins' : mode === 'off' ? 'OFF wins' : 'ALL wins';
    if (!wins.length) { console.log(`  ${label}: no wins`); continue; }
    const buckets = [];
    for (let i = 0; i < mfeBuckets.length - 1; i++) {
      const lo = mfeBuckets[i], hi = mfeBuckets[i + 1];
      const count = wins.filter(t => t.mfeCapitalPct >= lo && t.mfeCapitalPct < hi).length;
      if (count) buckets.push(`${bucketLabel(lo, hi)}: ${count}`);
    }
    const avgMfe = (wins.reduce((s, t) => s + t.mfeCapitalPct, 0) / wins.length).toFixed(0);
    const over100 = wins.filter(t => t.mfeCapitalPct >= 100).length;
    console.log(`  ${label.padEnd(10)} avg_peak=+${avgMfe}%  over100%: ${over100}/${wins.length} (${(over100/wins.length*100).toFixed(0)}%)   [${buckets.join('  ')}]`);
  }
  console.log('\n  ── Per-trade MFE (wins, sorted by peak) ──');
  const smcWins = allTrades.filter(t => t.sessionMode === 'smc' && t.pnlUsd > 0).sort((a, b) => b.mfeCapitalPct - a.mfeCapitalPct);
  const offWins = allTrades.filter(t => t.sessionMode === 'off' && t.pnlUsd > 0).sort((a, b) => b.mfeCapitalPct - a.mfeCapitalPct);
  if (smcWins.length) {
    console.log('  SMC wins:');
    for (const t of smcWins) {
      const ts = new Date(t.entryTs).toISOString().slice(0, 16);
      console.log(`    ${ts}  ${(t.symbol||'').padEnd(10)} ${t.side.padEnd(6)} peak=+${t.mfeCapitalPct.toFixed(0)}%cap  exit=+${(t.pnlUsd).toFixed(0)}$  setup=${t.setup}`);
    }
  }
  if (offWins.length) {
    console.log('  OFF wins (top 5):');
    for (const t of offWins.slice(0, 5)) {
      const ts = new Date(t.entryTs).toISOString().slice(0, 16);
      console.log(`    ${ts}  ${(t.symbol||'').padEnd(10)} ${t.side.padEnd(6)} peak=+${t.mfeCapitalPct.toFixed(0)}%cap  exit=+${(t.pnlUsd).toFixed(0)}$  setup=${t.setup}`);
    }
  }

  // ── LOSS ANALYSIS — conditions at every losing trade ─────
  const allLosses = allTrades.filter(t => t.pnlUsd <= 0);
  if (allLosses.length) {
    console.log('\n══════════ LOSS ANALYSIS — what conditions caused each loss ════════');
    // ATR% = 1m ATR(14) as % of price. Measures how much the market actually moves per candle.
    // Low ATR = choppy/quiet market — not enough movement to reach +30% safety lock.
    // Safety lock at +30% capital needs: 0.30/leverage% price move (e.g. 0.30% at 100x, 0.60% at 50x).
    // If ATR < that target, price can barely move 1 candle worth before hitting the SL.
    console.log(`${'ts'.padEnd(17)} ${'sym'.padEnd(8)} ${'side'.padEnd(6)} ${'setup'.padEnd(42)} ${'h1'.padEnd(3)} ${'EMA%'.padEnd(8)} ${'ATR%'.padEnd(7)} ${'hr'.padEnd(4)}`);
    console.log('─'.repeat(104));
    for (const t of allLosses) {
      const ts  = new Date(t.entryTs).toISOString().slice(0, 16);
      const ema = t.emaSpreadPct != null ? (t.emaSpreadPct >= 0 ? '+' : '') + t.emaSpreadPct.toFixed(3) + '%' : '—';
      const atrStr = t.atrPct != null ? t.atrPct.toFixed(4) + '%' : '—';
      // Flag: is ATR too small to reach +30% capital in a few candles?
      const needPct   = (0.30 / (t.lev || 20)) * 100;
      const atrFlag   = t.atrPct != null && t.atrPct < needPct * 0.5 ? ' ◄ LOW ATR' : '';
      console.log(`${ts.padEnd(17)} ${pad(t.symbol, 8)} ${pad(t.side, 6)} ${pad(t.setup, 42)} ${pad(t.h1trend||'??', 3)} ${pad(ema, 8)} ${pad(atrStr, 7)} ${String(t.utcH||'?').padEnd(4)}${atrFlag}`);
    }

    // ── ATR explainer ──
    console.log('\n  What ATR means for each coin:');
    const levsShown = new Set();
    for (const t of allLosses) {
      const lev = t.lev || 20;
      if (levsShown.has(lev)) continue;
      levsShown.add(lev);
      const needPct = (SAFETY_TRIGGER / lev * 100).toFixed(3);
      console.log(`    ${lev}x leverage: need ${needPct}% price move to reach +30% capital (safety lock)`);
    }

    // ── Filter opportunity summary ──
    console.log('\n  ── Filter opportunity: would these have been blocked? ──');

    // H1 trend filter
    const h1dn_losses = allLosses.filter(t => t.h1trend === 'DN' && t.side === 'LONG').length
                      + allLosses.filter(t => t.h1trend === 'UP' && t.side === 'SHORT').length;
    const h1dn_wins   = allTrades.filter(t => t.pnlUsd > 0 &&
      ((t.h1trend === 'DN' && t.side === 'LONG') || (t.h1trend === 'UP' && t.side === 'SHORT'))).length;
    console.log(`  1h-trend against trade direction → blocks ${h1dn_losses} losses  but also ${h1dn_wins} wins`);

    // EMA spread filter (< 0.05%)
    const weakEma_losses = allLosses.filter(t => t.emaSpreadPct != null && Math.abs(t.emaSpreadPct) < 0.05).length;
    const weakEma_wins   = allTrades.filter(t => t.pnlUsd > 0 && t.emaSpreadPct != null && Math.abs(t.emaSpreadPct) < 0.05).length;
    console.log(`  Weak EMA spread (<0.05%) filter   → blocks ${weakEma_losses} losses  but also ${weakEma_wins} wins`);

    // ATR too low to reach +30% safety lock (ATR < 50% of needed price move)
    const lowAtr_losses = allLosses.filter(t => {
      if (t.atrPct == null) return false;
      const needPct = (SAFETY_TRIGGER / (t.lev || 20)) * 100;
      return t.atrPct < needPct * 0.5;
    }).length;
    const lowAtr_wins = allTrades.filter(t => {
      if (t.pnlUsd <= 0 || t.atrPct == null) return false;
      const needPct = (SAFETY_TRIGGER / (t.lev || 20)) * 100;
      return t.atrPct < needPct * 0.5;
    }).length;
    console.log(`  Low ATR (<50% of safety-lock move) → blocks ${lowAtr_losses} losses  but also ${lowAtr_wins} wins`);

    // Price above VWAP for LONG (should be at/below VWAP for a pullback)
    const aboveVwap_losses = allLosses.filter(t => t.side === 'LONG' && t.priceVsVwapPct != null && t.priceVsVwapPct > 0.2).length;
    const aboveVwap_wins   = allTrades.filter(t => t.pnlUsd > 0 && t.side === 'LONG' && t.priceVsVwapPct != null && t.priceVsVwapPct > 0.2).length;
    console.log(`  LONG entered >0.2% above VWAP     → blocks ${aboveVwap_losses} losses  but also ${aboveVwap_wins} wins`);

    // 50x coins VWAPTrend
    const v50_losses = allLosses.filter(t => t.lev === 50 && t.setup.startsWith('VWAPTrend')).length;
    const v50_wins   = allTrades.filter(t => t.pnlUsd > 0 && t.lev === 50 && t.setup.startsWith('VWAPTrend')).length;
    console.log(`  Block VWAPTrend on 50x coins       → blocks ${v50_losses} losses  but also ${v50_wins} wins`);
  }

  // ── FULL FLIP test — flip EVERY signal direction ─────────
  // User question: if WR is 20%, does flipping everything give 80%?
  const allFlipTrades = allSymResults.flatMap(r =>
    (r.fullFlipTrades || []).map(t => ({ ...t, symbol: r.symbol, lev: r.lev }))
  );
  if (allFlipTrades.length) {
    console.log('\n══════════ FULL FLIP — ALL LONG↔SHORT REVERSED ════════════════════');
    console.log('  Every signal from the normal strategy, direction flipped.');
    const fs = stats(allFlipTrades);
    console.log(`\n  Flipped trades  : ${fs.total}`);
    console.log(`  Win Rate        : ${fs.wr.toFixed(1)}%  (W=${fs.wins}  L=${fs.losses})`);
    console.log(`  Avg Win / Loss  : ${fmtUsd(fs.avgWin)} / ${fmtUsd(fs.avgLoss)}`);
    console.log(`  Net P&L         : ${fmtUsd(fs.net)}`);
    console.log(`  Profit Factor   : ${Number.isFinite(fs.profitFactor) ? fs.profitFactor.toFixed(2) : '∞'}`);
    console.log(`\n  Normal  WR: ${totWR.toFixed(1)}%  net: ${fmtUsd(totNet)}`);
    console.log(`  Flipped WR: ${fs.wr.toFixed(1)}%  net: ${fmtUsd(fs.net)}`);
    const better = fs.net > totNet ? '  ← FLIPPED IS BETTER' : '  ← ORIGINAL IS BETTER';
    console.log(`  Winner: ${fs.net > totNet ? 'FLIPPED' : 'ORIGINAL'}${better}`);
  }

  // ── Reversal test ─────────────────────────────────────────
  // Did flipping direction on the known-loser setups produce profit?
  const allRevTrades = allSymResults.flatMap(r =>
    (r.reversalTrades || []).map(t => ({ ...t, symbol: r.symbol, lev: r.lev }))
  );
  if (allRevTrades.length) {
    console.log('\n══════════ REVERSAL TEST — FLIPPED DIRECTION ON KNOWN LOSERS ═══════');
    console.log('  Same entry bar, direction flipped: LONG→SHORT, SHORT→LONG');
    console.log('  (MomentumBreakout@RangeHigh, MSTF@15HH/15LL, VWAPEMADn)');
    const rs = stats(allRevTrades);
    console.log(`\n  Reversed trades : ${rs.total}`);
    console.log(`  Win Rate        : ${rs.wr.toFixed(1)}%  (W=${rs.wins}  L=${rs.losses})`);
    console.log(`  Avg Win / Loss  : ${fmtUsd(rs.avgWin)} / ${fmtUsd(rs.avgLoss)}`);
    console.log(`  Net P&L         : ${fmtUsd(rs.net)}`);
    console.log(`  Profit Factor   : ${Number.isFinite(rs.profitFactor) ? rs.profitFactor.toFixed(2) : '∞'}`);

    const byRevSetup = {};
    for (const t of allRevTrades) {
      if (!byRevSetup[t.setup]) byRevSetup[t.setup] = { wins: 0, losses: 0, net: 0 };
      byRevSetup[t.setup].net += t.pnlUsd;
      if (t.pnlUsd > 0) byRevSetup[t.setup].wins++; else byRevSetup[t.setup].losses++;
    }
    console.log(`\n  ${'setup'.padEnd(52)} ${'n'.padStart(4)} ${'WR%'.padStart(6)} ${'net'.padStart(9)}`);
    console.log('  ' + '─'.repeat(74));
    for (const [name, v] of Object.entries(byRevSetup).sort((a, b) => b[1].net - a[1].net)) {
      const n  = v.wins + v.losses;
      const wr = (v.wins / n) * 100;
      const marker = v.net > 0 ? '  ✓ ADD THIS' : '  ✗ still loses reversed too';
      console.log(`  ${pad(name, 52)} ${rpad(n, 4)} ${rpad(wr.toFixed(1) + '%', 6)} ${rpad(fmtUsd(v.net), 9)}${marker}`);
    }

    const combinedNet    = totNet + rs.net;
    const combinedTrades = totTrades + rs.total;
    const combinedWins   = totWins + rs.wins;
    console.log(`\n  ── Combined result if reversed setups are added to normal strategy ──`);
    console.log(`  ${totTrades} normal + ${rs.total} reversed = ${combinedTrades} total trades`);
    console.log(`  WR: ${((combinedWins / combinedTrades) * 100).toFixed(1)}%   Net: ${fmtUsd(combinedNet)}`);
    console.log(`  Final capital: $${(CAPITAL + combinedNet).toFixed(2)}  (${combinedNet >= 0 ? '+' : ''}${((combinedNet / CAPITAL) * 100).toFixed(1)}% return)`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  process.exit(0);
})().catch(e => {
  console.error('backtest failed:', e.stack || e.message);
  process.exit(1);
});
