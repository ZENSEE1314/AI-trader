'use strict';

// EXPO baseline watcher — BTC / ETH / SOL
// ======================================================================
// Entry (matches backtest-expo-struct.js "baseline"):
//   BIAS  : 15m — read SMC Expo (PUB;26ae…) HL/LH structure labels live.
//           When a NEW HL/LH label appears in the feed (first sighting = its
//           birth; pivot bar at most LABEL_MAX_AGE_MS old) the entry window
//           opens NOW for WINDOW_MS. The startup/reconnect backlog is
//           baselined and never traded.
//           HL → long bias, LH → short bias.
//   ENTRY : 1m native swing pullback — enter on the candle after a 1m swing
//           low (long) / high (short). One trade per bias window.
//   RISK  : 20x, hard SL -50% of margin, no TP/trailing, structure exit enabled
//           (setup='EXPO_BASELINE', trailing skipped in cycle.js/trail-watchdog).
//   EXIT  : 15m Expo structure exit - HL long closes on HH/LH; LH short closes on LL/HL.
//
// ⚠ Validated on only ~8 days / ~7 trades per token — directional, not robust.
// Signals go through injectTVSignal → cycle.js (same path as the old watcher).

const TradingView = require('@mathieuc/tradingview');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { checkTimefmDirection } = require('./timefm-gate');

const bLog = (...a) => console.log('[Expo-Watcher]', ...a);

const pHigh = p => p.high ?? p.max;
const pLow = p => p.low ?? p.min;

function asc(periods) {
  return periods && periods.length ? [...periods].reverse() : [];
}

function computeVwapBands(bars) {
  const v2u = new Array(bars.length).fill(null);
  const v2d = new Array(bars.length).fill(null);
  const mid = new Array(bars.length).fill(null);
  let day = null, tpv = 0, vol = 0, tpv2 = 0;
  for (let i = 0; i < bars.length; i++) {
    const p = bars[i];
    const t = (p.time != null ? p.time : p[0]) * 1000;
    const d = Math.floor(t / 86400000);
    if (d !== day) { day = d; tpv = 0; vol = 0; tpv2 = 0; }
    const high = pHigh(p), low = pLow(p), close = p.close;
    const volume = p.volume || 0;
    if (high == null || low == null || close == null) continue;
    const tp = (high + low + close) / 3;
    tpv += tp * volume; vol += volume; tpv2 += tp * tp * volume;
    if (vol > 0) {
      const vw = tpv / vol;
      const variance = tpv2 / vol - vw * vw;
      const sd = variance > 0 ? Math.sqrt(variance) : 0;
      mid[i] = vw;
      v2u[i] = vw + 2 * sd;
      v2d[i] = vw - 2 * sd;
    }
  }
  return { v2u, v2d, mid };
}

function expoPivotAtOuterVwap(periodsNewestFirst, labelX, direction) {
  const bars = asc(periodsNewestFirst);
  const idx = bars.length - 1 - labelX;
  if (idx < 0 || idx >= bars.length) return { pass: false, reason: 'missing pivot bar' };
  const bar = bars[idx];
  const { v2u, v2d, mid } = computeVwapBands(bars);
  const upper = v2u[idx], lower = v2d[idx], vw = mid[idx];
  if (upper == null || lower == null || vw == null) return { pass: false, reason: 'missing VWAP band' };

  // 15m context filter:
  // - HL long is valid above VWAP mid, or below the lower outer VWAP band.
  // - LH short is valid below VWAP mid, or above the upper outer VWAP band.
  // - Inside the wrong VWAP half is blocked for both directions.
  // 1m may be inside VWAP/range; only this 15m context decides trend alignment.
  const high = pHigh(bar), low = pLow(bar);
  // Gate the actual Expo pivot, not the candle close. An HL wick below VWAP
  // mid is still a lower-half HL even if the candle closes back above mid.
  const pivotRef = direction === 'SHORT' ? high : low;
  const longUpperHalf = pivotRef >= vw;
  const longLowerOuter = pivotRef <= lower;
  const shortLowerHalf = pivotRef <= vw;
  const shortUpperOuter = pivotRef >= upper;
  const pass = direction === 'SHORT' ? (shortLowerHalf || shortUpperOuter) : (longUpperHalf || longLowerOuter);
  return {
    pass,
    reason: pass
      ? (direction === 'SHORT'
        ? (shortUpperOuter ? '15m above upper outer VWAP band' : '15m lower VWAP half')
        : (longLowerOuter ? '15m below lower outer VWAP band' : '15m upper VWAP half'))
      : (direction === 'SHORT' ? '15m inside upper VWAP half' : '15m inside lower VWAP half'),
  };
}

// ── Persist Expo HH/HL/LH/LL labels to the cache the homepage backtester reads ──
// Reuses this watcher's existing TV connection (no extra connections). Throttled.
const LABELS_DIR = path.join(__dirname, '..', 'data', 'expo-labels');
const _lastPersist = {};
const PERSIST_MS = 3 * 60 * 1000;
function persistLabels(sym, labels, periods) {
  if (Date.now() - (_lastPersist[sym] || 0) < PERSIST_MS) return;
  _lastPersist[sym] = Date.now();
  try {
    const out = [];
    for (const l of labels) {
      if (l.x == null || !/^(HH|HL|LH|LL)$/.test(l.text || '')) continue;
      const bar = periods[l.x];
      if (bar) out.push({ time: bar.time * 1000, type: l.text, price: l.y });
    }
    if (out.length < 4) return;
    out.sort((a, b) => a.time - b.time);
    fs.mkdirSync(LABELS_DIR, { recursive: true });
    fs.writeFileSync(path.join(LABELS_DIR, `${sym}-15m-expo.json`), JSON.stringify(out));
  } catch (_) {}
}

// ── DIAG: measure Expo label repaint lag (owner 2026-07-21) ──────────────────
// Records the wall-clock moment each HH/HL/LH/LL first appears in the live TV feed
// vs its pivot-bar time. If an HL/LH surfaces long after its bar — especially once a
// newer HH/LL has already printed and superseded it — the label repaints and cannot
// be traded live. This distinguishes "indicator is slow/repaints" from "parse bug".
const _labelFirstSeen = {};   // `${sym}:${tf}` → Map(key → firstSeenMs)
const _diagReady = new Set();  // `${sym}:${tf}` keys whose startup backlog is recorded
const _diagLog = [];           // ring buffer of measurements, exposed via /api/admin/diag-labels
function diagLabelLag(sym, tf, labels, periods, onlyEntry = false) {
  const mk = `${sym}:${tf}`;
  const seen = _labelFirstSeen[mk] || (_labelFirstSeen[mk] = new Map());
  const now = Date.now();
  let newestT = 0, newestType = null;
  const cur = [];
  for (const l of labels) {
    if (l.x == null || !/^(HH|HL|LH|LL)$/.test(l.text || '')) continue;
    const bar = periods[l.x];
    if (!bar) continue;
    const t = bar.time * 1000;
    cur.push({ t, type: l.text });
    if (t > newestT) { newestT = t; newestType = l.text; }
  }
  const first = !_diagReady.has(mk);
  for (const { t, type } of cur) {
    const key = `${t}:${type}`;
    if (seen.has(key)) continue;
    seen.set(key, now);
    if (first) continue;   // startup backlog — record silently, no lag to report
    if (onlyEntry && type !== 'HL' && type !== 'LH') continue;   // 1m: only entry labels
    const lagMin = ((now - t) / 60000).toFixed(1);
    const superseded = t < newestT ? `${newestType}@${new Date(newestT).toISOString().slice(11, 16)}` : null;
    const sup = superseded ? `SUPERSEDED by ${superseded}` : 'is newest';
    bLog(`[${sym}][${tf}][DIAG] new label ${type} @ ${new Date(t).toISOString().slice(0, 16)} — first-seen lag=${lagMin}m, ${sup}`);
    _diagLog.push({ at: now, sym, tf, type, labelTime: t, lagMin: Number(lagMin), superseded });
    if (_diagLog.length > 300) _diagLog.shift();
  }
  if (first) {
    _diagReady.add(mk);
    bLog(`[${sym}][${tf}][DIAG] baseline recorded (${cur.length} labels); now logging repaint lag for new labels`);
  }
  if (seen.size > 300) { const ks = [...seen.keys()]; for (const k of ks.slice(0, seen.size - 300)) seen.delete(k); }
}

// ── Config ───────────────────────────────────────────────────────
const EXPO_ID      = 'PUB;26ae10374a9d4b0591b5b51a41356e57';   // Smart Money Concept (Expo)
const TV_SYMBOLS   = ['BITUNIX:BTCUSDT.P', 'BITUNIX:ETHUSDT.P', 'BITUNIX:SOLUSDT.P'];
const BYBIT_SYM    = { BTCUSDT: 'BTCUSDT', ETHUSDT: 'ETHUSDT', SOLUSDT: 'SOLUSDT' };
const HISTORY_BARS = 300;
// 1m-confirm window: if no 1m structure appears within it, the setup is missed and
// we go back to waiting for the next fresh 15m label. 8 min per owner 2026-07-17.
// With power gated ONCE at the label, a longer window just gives the 1m pullback
// more chances without quality loss — up to a point, then late entries hurt.
// Backtest (BTC+SOL 50x two-wing, reversal exit): 5m +$7,681 / 8m +$8,511 /
// 10m +$8,351 / 45m +$6,901 (90d); 30d 5m +$3,345, 8m +$3,342, 10m +$2,242.
// 8m = the peak (best 90d, ties 5m on 30d). Env ENTRY_WINDOW_MIN to change.
const ENTRY_CONFIRM_MS = Number(process.env.ENTRY_WINDOW_MIN || 8) * 60 * 1000;
const WINDOW_MS    = ENTRY_CONFIRM_MS;     // entry window once a fresh Expo HL/LH appears
const LABEL_MAX_AGE_MS = 45 * 60 * 1000;   // newborn label tradeable if its pivot bar is ≤3 bars old (V-bottoms confirm late)
const COOLDOWN_MS  = 30 * 60 * 1000;       // 30 min per symbol per direction
const SCAN_MS      = 30_000;               // 1m entry scan cadence
const HEARTBEAT_MS = 5 * 60 * 1000;        // explain silent/no-trade periods
const STALE_TV_MS  = 12 * 60 * 1000;       // reconnect if TradingView study stops updating
const LEVERAGE     = Number(process.env.EXPO_LEVERAGE || 50);   // 50x per owner 2026-07-16 (backtest profit peak; SL auto-tightens to 1% price move). Roll back: set EXPO_LEVERAGE=20.
const SL_MARGIN    = 0.50;                 // hard SL −50% of margin
const BYBIT_URL    = 'https://api.bybit.com/v5/market/kline';

// ── Shared state ─────────────────────────────────────────────────
const biasMap   = {};   // sym → { direction, labelTime, openedAt, traded }
const lastSeen  = {};   // sym → labelTime:type of the most recently processed Expo label
const cooldowns = new Map();
const watchState = {}; // sym -> latest observed 15m Expo study state
const structureExitSeen = new Set(); // sym:labelTime:direction exits already handled
let   _client = null;
let   _expoInd = null;
let   _scanTimer = null;
let   _heartbeatTimer = null;
let   _watchdogTimer = null;

function canTrade(sym, dir)   { return Date.now() - (cooldowns.get(`${sym}:${dir}`) || 0) > COOLDOWN_MS; }
function markTraded(sym, dir) { cooldowns.set(`${sym}:${dir}`, Date.now()); }
function normSym(tv)          { return tv.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT'); }
// Bias is live only for ENTRY_CONFIRM_MS after a fresh label.
// If no 1m structure confirms inside that window, the 15m signal is missed.
function biasAlive(sym) {
  const b = biasMap[sym];
  if (!b || b.traded) return null;
  return Date.now() - b.openedAt <= ENTRY_CONFIRM_MS ? b : null;
}

// ── Which symbols may open LABEL entries ──────────────────────────
// All TV_SYMBOLS stay watched (their labels drive structure EXITS for both this
// strategy AND the sweep watcher) — but only these open entry windows.
// SOL-only (owner 2026-07-21): across 90d+30d windows BTC's label consistently
// LOSES (−$1,128 / −$1,046) while SOL wins both (+$1,691 / +$1,475). ETH looks
// strong (+$2,785/90d) but on a thin, historically-inconsistent sample — held out
// pending multi-window validation. Env EXPO_ENTRY_SYMBOLS overrides this default.
const ENTRY_SYMBOLS = new Set(
  (process.env.EXPO_ENTRY_SYMBOLS || 'SOLUSDT').split(',').map(s => s.trim()).filter(Boolean)
);

// ── Power-confirmation gate (evaluated ONCE, at the 15m label) ────
// A label opens an entry window only if taker flow on its own pivot bar carries
// CONVICTION — and conviction lives at BOTH extremes:
//   >= POWER_TH      the extreme was rejected on its own bar (a rejection candle)
//   <  POWER_LOW_TH  the aggressors pushed it hard and FAILED = trapped (this is
//                    the sweep strategy's mechanism, independently validated)
// The 35-55% middle is no-conviction noise and bled −$6,220 across 311 trades.
// BTC+SOL 90d: no gate −$7,709 | one-wing +$3,306 | two-wing +$7,024 (WR 71%);
// 30d +$3,050 (WR 83%). Env: POWER_GATE=0 disables, POWER_LOW_TH=0 = one-wing.
const POWER_GATE   = process.env.POWER_GATE !== '0';
const POWER_TH     = Number(process.env.POWER_TH || 0.55);
const POWER_LOW_TH = Number(process.env.POWER_LOW_TH || 0.35);
// Label trades exit only on the reversal label (ride the full leg through
// continuation). Sweep trades unaffected. Env EXPO_EXIT_REVERSAL_ONLY=0 to revert.
const EXIT_REVERSAL_ONLY = process.env.EXPO_EXIT_REVERSAL_ONLY !== '0';
// Quiet-pivot filter: block a label whose pivot bar had LOUD volume (>= this x its
// 20-bar avg). Loser autopsy: losers averaged 1.23x pivot volume vs 0.93x for winners
// (loud = initiative/continuation, not fadeable exhaustion). Blocking >=2.0x improves
// BOTH windows: +$8,511->+$9,121/90d, +$3,342->+$3,568/30d. Env PIVOT_VOL_MAX=0 disables.
const PIVOT_VOL_MAX = Number(process.env.PIVOT_VOL_MAX || 2.0);
const BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines';

// Volume of the label's pivot bar as a multiple of its 20-bar average (from Binance
// 15m). Returns null if history is insufficient (fail open — don't block on no data).
async function fetchPivotVolRatio(symbol, barTime) {
  const start = barTime - 20 * 15 * 60000;
  const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=15m&startTime=${start}&limit=21`;
  const res = await fetch(url, { timeout: 8000 });
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 21) return null;
  const pivotIdx = rows.findIndex(r => +r[0] === barTime);
  if (pivotIdx < 20) return null;
  const vols = rows.map(r => parseFloat(r[5]));
  const avg = vols.slice(pivotIdx - 20, pivotIdx).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? vols[pivotIdx] / avg : null;
}

// Taker-buy ratio of ONE specific 15m bar. Used on the label's own pivot bar, which
// is already closed when the label appears — so the flow is complete and exact, with
// no lookahead and none of the stale-vs-forming ambiguity that plagued reading it at
// entry time (that misread 41% when live flow was 59% and killed a valid ETH short).
async function fetchBuyRatioAt(symbol, barTime) {
  const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=15m&startTime=${barTime}&limit=1`;
  const res = await fetch(url, { timeout: 8000 });
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length || +rows[0][0] !== barTime) throw new Error('bar not found');
  const vol = parseFloat(rows[0][5]), buy = parseFloat(rows[0][9]);
  if (!(vol > 0)) throw new Error('zero volume bar');
  return buy / vol;
}

// ── Bybit 1m klines (ascending) ──────────────────────────────────
async function fetch1m(symbol, limit = 5) {
  const url = `${BYBIT_URL}?category=linear&symbol=${symbol}&interval=1&limit=${limit}`;
  const res = await fetch(url, { timeout: 10_000 });
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
  return json.result.list
    .map(r => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] }))
    .sort((a, b) => a.time - b.time);
}

function recent1mStructure(c1m) {
  const highs = [];
  const lows = [];
  for (let i = 1; i < c1m.length - 1; i++) {
    if (c1m[i].high > c1m[i - 1].high && c1m[i].high > c1m[i + 1].high) {
      highs.push({ price: c1m[i].high, time: c1m[i].time });
    }
    if (c1m[i].low < c1m[i - 1].low && c1m[i].low < c1m[i + 1].low) {
      lows.push({ price: c1m[i].low, time: c1m[i].time });
    }
  }
  const lastLow = lows[lows.length - 1] || null;
  const prevLow = lows[lows.length - 2] || null;
  const lastHigh = highs[highs.length - 1] || null;
  const prevHigh = highs[highs.length - 2] || null;
  return {
    lastLow,
    prevLow,
    lastHigh,
    prevHigh,
    lastLowType: lastLow && prevLow ? (lastLow.price > prevLow.price ? 'HL' : 'LL') : null,
    lastHighType: lastHigh && prevHigh ? (lastHigh.price < prevHigh.price ? 'LH' : 'HH') : null,
  };
}

// 1m swing pullback: prev candle is a local low (long) / high (short). Enter on current bar.
function detectEntry(c1m, bias) {
  if (c1m.length < 3) return null;
  const n = c1m.length, prev = c1m[n - 2], pre = c1m[n - 3], curr = c1m[n - 1];
  if (bias === 'LONG'  && prev.low  < pre.low  && prev.low  < curr.low)  return 'LONG';
  if (bias === 'SHORT' && prev.high > pre.high && prev.high > curr.high) return 'SHORT';
  return null;
}

// ── Indicator + 15m Expo label watch (shares one TV client) ──────
async function closeExpoOnStructure(sym, labelType, labelTime) {
  const exitDirection = (labelType === 'HH' || labelType === 'LH') ? 'LONG'
    : (labelType === 'LL' || labelType === 'HL') ? 'SHORT'
    : null;
  if (!exitDirection) return;

  const exitKey = `${sym}:${labelTime}:${exitDirection}`;
  if (structureExitSeen.has(exitKey)) return;

  let rows = [];
  try {
    const db = require('../db');
    rows = await db.query(
      `SELECT id, created_at, setup
       FROM trades
       WHERE symbol = $1
         AND direction = $2
         AND status = 'OPEN'
         AND COALESCE(setup, '') LIKE 'EXPO_BASELINE%'
       ORDER BY created_at ASC`,
      [sym, exitDirection]
    );
  } catch (e) {
    bLog(`[${sym}][15m] structure exit DB check failed: ${e.message}`);
    return;
  }

  const eligible = (Array.isArray(rows) ? rows : rows.rows || []).filter(t => {
    const openedAt = t.created_at ? new Date(t.created_at).getTime() : 0;
    return !openedAt || openedAt <= labelTime;
  });
  if (!eligible.length) return;

  // LABEL trades ride the full leg: close only on the REVERSAL label (LONG→LH,
  // SHORT→HL), holding through continuation (HH/LL). Backtest: +$7,024→+$7,681/90d,
  // +$3,051→+$3,345/30d, avg win +25.9%→+36.2% (captures the big 1h legs the quick
  // exit was missing). Sweep trades keep the continuation exit (it was a wash there).
  // Env EXPO_EXIT_REVERSAL_ONLY=0 reverts label trades to exit-on-either.
  const isSweep = eligible.some(t => String(t.setup || '').includes('[SWEEP]'));
  const isContinuation = (exitDirection === 'LONG' && labelType === 'HH')
                      || (exitDirection === 'SHORT' && labelType === 'LL');
  if (EXIT_REVERSAL_ONLY && !isSweep && isContinuation) {
    bLog(`[${sym}][15m] Expo ${labelType} — label ${exitDirection} rides the leg (continuation, not a reversal); no exit`);
    return;
  }

  structureExitSeen.add(exitKey);
  try {
    const { closePositionForAllUsers } = require('../cycle');
    bLog(`[${sym}][15m] Expo ${labelType} structure exit -> closing ${exitDirection} (${eligible.length} open EXPO trade row(s))`);
    const closed = await closePositionForAllUsers(sym, `expo_structure_${labelType}`);
    bLog(`[${sym}][15m] Expo ${labelType} structure exit ${closed ? 'sent' : 'found no exchange position'} for ${exitDirection}`);
  } catch (e) {
    structureExitSeen.delete(exitKey);
    bLog(`[${sym}][15m] structure exit close failed: ${e.message}`);
  }
}
async function loadExpo() {
  if (!_expoInd) _expoInd = await TradingView.getIndicator(EXPO_ID, 'last', process.env.TV_SESSION || '', process.env.TV_SESSION_SIGN || '');
  return _expoInd;
}

function watch15m(client, ind, tvTicker) {
  const sym = normSym(tvTicker);
  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: '15', range: HISTORY_BARS });
  const study = new chart.Study(ind);
  study.onError((...e) => bLog(`[${sym}][15m] study error: ${e.join(' ')}`));

  // First update after (re)connect is backlog, not a newborn label — never
  // open an entry window from it. Freshness is measured from when a label
  // FIRST APPEARS in the feed, not from its pivot-bar time: TV draws V-bottom
  // HLs one or more bars after the low, which the old 5-min pivot-age rule
  // classified as stale (missed the 2026-07-12 22:15 BTC capitulation long).
  let baselined = false;

  study.onUpdate(async () => {
    try {
      const labels  = (study.graphic && study.graphic.labels) || [];
      const periods = chart.periods || [];   // newest-first; label.x = bars-from-newest
      if (!labels.length || !periods.length) return;

      persistLabels(sym, labels, periods);   // keep the homepage backtest cache fresh
      diagLabelLag(sym, '15m', labels, periods);   // DIAG: log repaint lag for each new label

      // Most recent readable structure label (x != null = confirmed/positioned).
      // HH/LL must clear stale HL/LH bias, otherwise the 1m scanner can trade
      // from an old HL/LH after the current 15m chart has already moved on.
      let newest = null;
      for (const l of labels) {
        if (l.x == null) continue;
        if (!/^(HH|HL|LH|LL)$/.test(l.text || '')) continue;
        const bar = periods[l.x];
        if (!bar) continue;
        const t = bar.time * 1000;
        if (!newest || t > newest.time) newest = {
          x: l.x,
          time: t,
          type: l.text,
          dir: l.text === 'HL' ? 'LONG' : l.text === 'LH' ? 'SHORT' : null,
        };
      }
      if (!newest) {
        watchState[sym] = { updatedAt: Date.now(), latestType: 'none', latestTime: null, labelCount: labels.length, periodCount: periods.length };
        return;
      }
      watchState[sym] = { updatedAt: Date.now(), latestType: newest.type, latestTime: newest.time, labelCount: labels.length, periodCount: periods.length };
      const seenKey = `${newest.time}:${newest.type}`;
      if (lastSeen[sym] === seenKey) { baselined = true; return; }   // unchanged since last look — feed is proven current
      lastSeen[sym] = seenKey;

      const age = Date.now() - newest.time;
      const at  = new Date(newest.time).toISOString().slice(0, 16);
      await closeExpoOnStructure(sym, newest.type, newest.time);   // missed exits still close on backlog
      if (!baselined) {
        baselined = true;
        delete biasMap[sym];
        bLog(`[${sym}][15m] baseline: Expo ${newest.type} @ ${at} — startup/reconnect backlog, no entry`);
        return;
      }
      if (newest.dir && age <= LABEL_MAX_AGE_MS) {
        // Label entries are disabled for this symbol (we still watch it, because its
        // labels drive structure exits for open trades — including sweep trades).
        if (!ENTRY_SYMBOLS.has(sym)) {
          delete biasMap[sym];
          bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} — label entries disabled for ${sym} (exits still active)`);
          return;
        }
        const vwap = expoPivotAtOuterVwap(periods, newest.x, newest.dir);
        if (!vwap.pass) {
          delete biasMap[sym];
          bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} blocked: ${vwap.reason}; ${newest.dir} requires 15m VWAP trend alignment`);
          return;
        }
        // Power-confirmation gate — evaluated ONCE, here, on the label's own pivot
        // bar (closed → complete flow). Fail = no window opens at all, so the 1m
        // scanner never re-rolls the dice on later bars. Backtest: this one-shot
        // form holds +$3.3k/90d at ANY window length (5/20/40m), while gating at
        // entry collapses to −$7.1k once the window exceeds one 15m bar.
        if (POWER_GATE) {
          let buyRatio;
          try {
            buyRatio = await fetchBuyRatioAt(BYBIT_SYM[sym], newest.time);
          } catch (e) {
            delete biasMap[sym];
            bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} blocked: power flow unavailable (${e.message}) — failing closed, no window`);
            return;
          }
          const powerInDir = newest.dir === 'LONG' ? buyRatio : 1 - buyRatio;
          const side = newest.dir === 'LONG' ? 'buying' : 'selling';
          const pct = (powerInDir * 100).toFixed(0);
          const rejected = powerInDir >= POWER_TH;                              // extreme rejected on its own bar
          const trapped  = POWER_LOW_TH > 0 && powerInDir < POWER_LOW_TH;       // aggressors pushed and failed
          if (!rejected && !trapped) {
            delete biasMap[sym];
            bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} blocked: ${side} power ${pct}% is mid-range (needs >=${POWER_TH * 100}% rejected, or <${POWER_LOW_TH * 100}% trapped) — no conviction, no window`);
            return;
          }
          bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} power confirmed: ${side} ${pct}% (${rejected ? 'rejected on its bar' : 'aggressors trapped'})`);
        }
        // Quiet-pivot filter: a loud pivot bar is initiative volume (continuation),
        // not fadeable exhaustion — the loser signature (1.23x avg vs 0.93x winners).
        if (PIVOT_VOL_MAX > 0) {
          let volRatio = null;
          try { volRatio = await fetchPivotVolRatio(BYBIT_SYM[sym], newest.time); }
          catch (_) { volRatio = null; }   // fail open — a fetch error shouldn't block
          if (volRatio != null && volRatio >= PIVOT_VOL_MAX) {
            delete biasMap[sym];
            bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} blocked: pivot volume ${volRatio.toFixed(2)}x avg >= ${PIVOT_VOL_MAX}x — loud initiative bar, not exhaustion; no window`);
            return;
          }
        }
        // Newborn structure label + flow behind it → open the entry window now.
        biasMap[sym] = { direction: newest.dir, labelTime: newest.time, openedAt: Date.now(), traded: false };
        bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} (pivot age ${Math.round(age / 60000)}m) → bias=${newest.dir} LIVE — window ${WINDOW_MS / 60000}m`);
      } else if (newest.dir) {
        delete biasMap[sym];
        bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} (pivot age ${Math.round(age / 60000)}m) — pivot older than ${LABEL_MAX_AGE_MS / 60000}m cap, bias cleared`);
      } else {
        delete biasMap[sym];
        bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} (pivot age ${Math.round(age / 60000)}m) — no HL/LH entry bias, bias cleared`);
      }
    } catch (e) { bLog(`[${sym}][15m] parse error: ${e.message}`); }
  });
}

function startDiagnostics(ind) {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  if (_watchdogTimer) clearInterval(_watchdogTimer);

  _heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const tv of TV_SYMBOLS) {
      const sym = normSym(tv);
      const st = watchState[sym];
      const bias = biasMap[sym];
      if (!st) {
        bLog(`[${sym}][15m] heartbeat: no Expo study update received yet`);
        continue;
      }
      const latestAt = st.latestTime ? new Date(st.latestTime).toISOString().slice(0, 16) : 'none';
      const ageMin = st.latestTime ? Math.round((now - st.latestTime) / 60000) : 'n/a';
      const updateAgeMin = Math.round((now - st.updatedAt) / 60000);
      const biasText = bias && !bias.traded ? `${bias.direction} open ${Math.round((now - bias.openedAt) / 60000)}m` : 'none';
      bLog(`[${sym}][15m] heartbeat: latest Expo ${st.latestType} @ ${latestAt} age=${ageMin}m, study update ${updateAgeMin}m ago, bias=${biasText}`);
    }
  }, HEARTBEAT_MS);

  _watchdogTimer = setInterval(() => {
    const now = Date.now();
    const stale = TV_SYMBOLS.map(normSym).some(sym => !watchState[sym] || now - watchState[sym].updatedAt > STALE_TV_MS);
    if (stale) {
      bLog(`TradingView Expo stream stale > ${STALE_TV_MS / 60000}m - reconnecting`);
      connectAll(ind);
    }
  }, 60_000);
}
// Observation-only 1m study: reads the SAME SMC Expo indicator on the 1-minute chart
// and logs HL/LH first-seen lag via diagLabelLag. 1m labels form far more often than
// 15m, so this answers the "does the Expo label repaint or is it real-time?" question
// in minutes instead of hours. No trading, no exits — DIAG only. Env DIAG_1M=0 disables.
function watchDiag1m(client, ind, tvTicker) {
  const sym = normSym(tvTicker);
  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: '1', range: HISTORY_BARS });
  const study = new chart.Study(ind);
  study.onError((...e) => bLog(`[${sym}][1m] DIAG study error: ${e.join(' ')}`));
  study.onUpdate(() => {
    try {
      const labels  = (study.graphic && study.graphic.labels) || [];
      const periods = chart.periods || [];
      if (!labels.length || !periods.length) return;
      diagLabelLag(sym, '1m', labels, periods, true);   // onlyEntry: log HL/LH only
    } catch (e) { bLog(`[${sym}][1m] DIAG error: ${e.message}`); }
  });
}

function connectAll(ind) {
  if (_client) { try { _client.end(); } catch (_) {} }
  const client = new TradingView.Client({ token: process.env.TV_SESSION || '', signature: process.env.TV_SESSION_SIGN || '' });
  _client = client;
  client.onError((...e) => {
    bLog(`TV client error — reconnect 30s: ${e.join(' ')}`);
    setTimeout(() => connectAll(ind), 30_000);
  });
  const diag1m = process.env.DIAG_1M !== '0';
  for (const tv of TV_SYMBOLS) {
    try { watch15m(client, ind, tv); } catch (e) { bLog(`[${normSym(tv)}][15m] watch failed: ${e.message}`); }
    if (diag1m) {
      try { watchDiag1m(client, ind, tv); } catch (e) { bLog(`[${normSym(tv)}][1m] DIAG watch failed: ${e.message}`); }
    }
  }
  bLog(`Watching ${TV_SYMBOLS.map(normSym).join('/')} on one TV client${diag1m ? ' (+1m DIAG)' : ''}`);
}

// ── 1m entry scan loop (native Bybit) ────────────────────────────
async function scanEntries() {
  for (const tvTicker of TV_SYMBOLS) {
    const sym = normSym(tvTicker);
    const rawBias = biasMap[sym];
    if (rawBias && !rawBias.traded && Date.now() - rawBias.openedAt > ENTRY_CONFIRM_MS) {
      rawBias.traded = true;
      bLog(`[${sym}][1m] ${rawBias.direction} missed - no 1m structure within ${ENTRY_CONFIRM_MS / 60000} candles`);
      continue;
    }
    const b = biasAlive(sym);
    if (!b) continue;
    // Entry is valid ONLY while the bias's own HL (long) / LH (short) is still the
    // newest 15m label. A newer label of any type — or the same bar repainting to
    // HH/LL — invalidates the setup. This is what blocks entries at HH.
    const expectedType = b.direction === 'LONG' ? 'HL' : 'LH';
    const st = watchState[sym];
    if (!st || st.latestType !== expectedType || st.latestTime !== b.labelTime) {
      delete biasMap[sym];
      bLog(`[${sym}][1m] ${b.direction} blocked - latest 15m Expo is ${st ? st.latestType : 'unknown'}, entry requires its ${expectedType} to still be newest`);
      continue;
    }
    if (!canTrade(sym, b.direction)) continue;
    try {
      const c1m = await fetch1m(BYBIT_SYM[sym], 240);
      const entry = detectEntry(c1m, b.direction);
      if (entry?.blocked) {
        bLog(`[${sym}][1m] ${b.direction} blocked — ${entry.reason}`);
        continue;
      }
      const dir = entry;
      if (!dir) continue;

      const price = c1m[c1m.length - 1].close;
      const isLong = dir === 'LONG';
      const timefm = await checkTimefmDirection({ symbol: sym, direction: dir, candles: c1m });
      const timefmMove = Number.isFinite(timefm.moveBps) ? ` (${timefm.moveBps.toFixed(1)} bps)` : '';
      if (!timefm.pass) {
        bLog(`[${sym}][1m] ${dir} blocked by TimeFM: ${timefm.reason}${timefmMove}`);
        continue;
      }
      bLog(`[${sym}][1m] TimeFM confirmed ${dir}: ${timefm.reason}${timefmMove}`);

      // Final gate: the 1m fetch + TimeFM check take seconds — re-verify the 15m
      // label didn't change/repaint in that gap before committing the order.
      const stFinal = watchState[sym];
      if (!stFinal || stFinal.latestType !== expectedType || stFinal.latestTime !== b.labelTime) {
        delete biasMap[sym];
        bLog(`[${sym}][1m] ${dir} aborted at fire time - 15m Expo now ${stFinal ? stFinal.latestType : 'unknown'}, no longer a fresh ${expectedType}`);
        continue;
      }

      // NOTE: no power check here — it was already applied once at the 15m label,
      // on that pivot bar's complete flow. Re-checking per-pullback made the gate
      // window-length-fragile and forced the stale/forming bar guesswork.

      markTraded(sym, dir);
      biasMap[sym].traded = true;   // one trade per bias window

      bLog(`[${sym}][1m] *** TRADE ${dir} | price=${price} | Expo bias + 1m swing | baseline SL50 | structure exits only ***`);
      const signal = {
        symbol: sym,
        side: isLong ? 'BUY' : 'SELL',
        direction: dir,
        price,
        lastPrice: price,
        zone: 'EXPO',
        pivot: isLong ? 'HL' : 'LH',
        setup: 'EXPO_BASELINE',
        // cycle.js stores `setupName || setup` in trades.setup, and the EXPO branches/
        // guards match setup === 'EXPO_BASELINE' — so setupName MUST be exactly that.
        setupName: 'EXPO_BASELINE',
        score: 75,
        signalType: `EXPO-${dir}`,
        source: 'expo-watcher',
        timeframe: '1',
        leverage: LEVERAGE,
        slMarginFrac: SL_MARGIN / LEVERAGE,
        isMomentumBreakout: true,
        override: true,
        receivedAt: Date.now(),
      };
      // Route through the ACTIVE executor (Coordinator → TraderAgent → executeForAllUsers).
      // injectTVSignal()/_tvSignalQueue is the LEGACY path — its consumer (cycle.run/main)
      // is not running, so signals there never execute. TraderAgent is what VWAP-PB used.
      try {
        const { getCoordinator } = require('../agents');
        const coord = getCoordinator && getCoordinator();
        if (coord && coord.traderAgent && !coord.traderAgent.paused) {
          await coord.traderAgent.execute({ signals: [signal], mode: 'signals' });
          bLog(`[${sym}][1m] → TraderAgent (active path) executed`);
        } else {
          bLog(`[${sym}][1m] TraderAgent unavailable — signal dropped`);
        }
      } catch (e) {
        bLog(`[${sym}][1m] routing error: ${e.message}`);
      }
    } catch (e) { bLog(`[${sym}][1m] scan error: ${e.message}`); }
  }
  _scanTimer = setTimeout(scanEntries, SCAN_MS);
}

// ── Start ─────────────────────────────────────────────────────────
async function start() {
  bLog(`Starting Expo baseline watcher - ${TV_SYMBOLS.map(normSym).join('/')} | 20x SL${SL_MARGIN*100}% | structure exits only`);
  if (!process.env.TV_SESSION) bLog('⚠ TV_SESSION not set — Expo study will fail to load.');
  let ind;
  try { ind = await loadExpo(); }
  catch (e) { bLog(`Expo load failed: ${e.message} — retry 60s`); return void setTimeout(start, 60_000); }
  connectAll(ind);
  startDiagnostics(ind);
  _scanTimer = setTimeout(scanEntries, 5000);
}

function getStatus() {
  const now = Date.now();
  const symbols = {};
  for (const tv of TV_SYMBOLS) {
    const sym = normSym(tv);
    const st = watchState[sym];
    const bias = biasMap[sym];
    symbols[sym] = {
      studyUpdateAgeMin: st ? Math.round((now - st.updatedAt) / 60000) : null,
      latestLabel: st && st.latestTime ? `${st.latestType}@${new Date(st.latestTime).toISOString().slice(0, 16)}` : (st ? st.latestType : 'no update yet'),
      labelAgeMin: st && st.latestTime ? Math.round((now - st.latestTime) / 60000) : null,
      bias: bias ? { direction: bias.direction, openMin: Math.round((now - bias.openedAt) / 60000), traded: bias.traded } : null,
      cooldownLong:  Math.max(0, Math.round((COOLDOWN_MS - (now - (cooldowns.get(`${sym}:LONG`)  || 0))) / 60000)),
      cooldownShort: Math.max(0, Math.round((COOLDOWN_MS - (now - (cooldowns.get(`${sym}:SHORT`) || 0))) / 60000)),
    };
  }
  return {
    config: {
      watched: TV_SYMBOLS.map(normSym), entrySymbols: [...ENTRY_SYMBOLS],
      labelMaxAgeMin: LABEL_MAX_AGE_MS / 60000, entryWindowMin: WINDOW_MS / 60000,
      leverage: LEVERAGE, slMargin: SL_MARGIN,
      powerGate: POWER_GATE, powerTh: POWER_TH, powerLowTh: POWER_LOW_TH, powerAt: 'label',
    },
    tvConnected: !!_client,
    symbols,
  };
}

function getDiagLog() {
  return _diagLog.slice(-200).map(r => ({
    ...r,
    atISO: new Date(r.at).toISOString(),
    labelISO: new Date(r.labelTime).toISOString().slice(0, 16),
  }));
}

if (require.main === module) start().catch(console.error);
module.exports = { start, getStatus, getDiagLog };
