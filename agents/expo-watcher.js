'use strict';

// EXPO baseline watcher — BTC / ETH / SOL
// ======================================================================
// Entry (matches backtest-expo-struct.js "baseline"):
//   BIAS  : 15m — read SMC Expo (PUB;26ae…) HL/LH structure labels live.
//           When a FRESH HL/LH appears (its pivot < FRESH_MS old) the entry
//           window opens NOW for WINDOW_MS. Old labels seen at startup are
//           ignored (age guard) so we never trade stale structure.
//           HL → long bias, LH → short bias.
//   ENTRY : 1m native swing pullback — enter on the candle after a 1m swing
//           low (long) / high (short). One trade per bias window.
//   RISK  : 20x, hard SL −50% / TP +35% of margin, NO trailing, NO 15m exit
//           (setup='EXPO_BASELINE', trailing skipped in cycle.js/trail-watchdog).
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
  // - HL long is blocked only when it is inside the lower VWAP half.
  // - LH short remains valid below VWAP mid.
  // 1m may be inside VWAP/range; only this 15m context decides trend alignment.
  const high = pHigh(bar), low = pLow(bar), close = bar.close;
  const pivotRef = direction === 'SHORT'
    ? Math.min(close ?? high, high ?? close)
    : Math.max(close ?? low, low ?? close);
  const longUpperHalf = pivotRef >= vw;
  const longLowerOuter = pivotRef <= lower;
  const pass = direction === 'SHORT' ? pivotRef <= vw : (longUpperHalf || longLowerOuter);
  return {
    pass,
    reason: pass
      ? (direction === 'SHORT'
        ? '15m lower VWAP half'
        : (longLowerOuter ? '15m below lower outer VWAP band' : '15m upper VWAP half'))
      : (direction === 'SHORT' ? '15m upper VWAP half' : '15m inside lower VWAP half'),
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

// ── Config ───────────────────────────────────────────────────────
const EXPO_ID      = 'PUB;26ae10374a9d4b0591b5b51a41356e57';   // Smart Money Concept (Expo)
const TV_SYMBOLS   = ['BITUNIX:BTCUSDT.P', 'BITUNIX:ETHUSDT.P', 'BITUNIX:SOLUSDT.P'];
const BYBIT_SYM    = { BTCUSDT: 'BTCUSDT', ETHUSDT: 'ETHUSDT', SOLUSDT: 'SOLUSDT' };
const HISTORY_BARS = 300;
const ENTRY_CONFIRM_MS = 10 * 60 * 1000;   // if no 1m structure appears in 10 candles, miss it
const WINDOW_MS    = ENTRY_CONFIRM_MS;     // entry window once a fresh Expo HL/LH appears
const FRESH_MS     = 5 * 60 * 1000;        // reject old 15m labels after startup/reconnect
const COOLDOWN_MS  = 30 * 60 * 1000;       // 30 min per symbol per direction
const SCAN_MS      = 30_000;               // 1m entry scan cadence
const HEARTBEAT_MS = 5 * 60 * 1000;        // explain silent/no-trade periods
const STALE_TV_MS  = 12 * 60 * 1000;       // reconnect if TradingView study stops updating
const LEVERAGE     = 20;
const SL_MARGIN    = 0.50;                 // hard SL −50% of margin
const TP_MARGIN    = 0.35;                 // hard TP +35% of margin
const BYBIT_URL    = 'https://api.bybit.com/v5/market/kline';

// ── Shared state ─────────────────────────────────────────────────
const biasMap   = {};   // sym → { direction, labelTime, openedAt, traded }
const lastSeen  = {};   // sym → labelTime of the most recently processed Expo label
const cooldowns = new Map();
const watchState = {}; // sym -> latest observed 15m Expo study state
let   _client = null;
let   _expoInd = null;
let   _scanTimer = null;
let   _heartbeatTimer = null;
let   _watchdogTimer = null;

function canTrade(sym, dir)   { return Date.now() - (cooldowns.get(`${sym}:${dir}`) || 0) > COOLDOWN_MS; }
function markTraded(sym, dir) { cooldowns.set(`${sym}:${dir}`, Date.now()); }
function normSym(tv)          { return tv.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT'); }
// Bias is live only for the first 5 one-minute candles after a fresh label.
// If no 1m structure confirms inside that window, the 15m signal is missed.
function biasAlive(sym) {
  const b = biasMap[sym];
  if (!b || b.traded) return null;
  return Date.now() - b.openedAt <= ENTRY_CONFIRM_MS ? b : null;
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

  study.onUpdate(() => {
    try {
      const labels  = (study.graphic && study.graphic.labels) || [];
      const periods = chart.periods || [];   // newest-first; label.x = bars-from-newest
      if (!labels.length || !periods.length) return;

      persistLabels(sym, labels, periods);   // keep the homepage backtest cache fresh

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
      if (lastSeen[sym] === newest.time) return;   // already processed this label
      lastSeen[sym] = newest.time;

      const age = Date.now() - newest.time;
      const at  = new Date(newest.time).toISOString().slice(0, 16);
      if (newest.dir && age <= FRESH_MS) {
        const vwap = expoPivotAtOuterVwap(periods, newest.x, newest.dir);
        if (!vwap.pass) {
          delete biasMap[sym];
          bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} blocked: ${vwap.reason}; ${newest.dir} requires 15m VWAP trend alignment`);
          return;
        }
        // Fresh structure just printed → open the entry window now.
        biasMap[sym] = { direction: newest.dir, labelTime: newest.time, openedAt: Date.now(), traded: false };
        bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} (age ${Math.round(age / 60000)}m) → bias=${newest.dir} LIVE — window ${WINDOW_MS / 60000}m`);
      } else if (newest.dir) {
        delete biasMap[sym];
        bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} (age ${Math.round(age / 60000)}m) — stale, bias cleared`);
      } else {
        delete biasMap[sym];
        bLog(`[${sym}][15m] Expo ${newest.type} @ ${at} (age ${Math.round(age / 60000)}m) — no HL/LH entry bias, bias cleared`);
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
function connectAll(ind) {
  if (_client) { try { _client.end(); } catch (_) {} }
  const client = new TradingView.Client({ token: process.env.TV_SESSION || '', signature: process.env.TV_SESSION_SIGN || '' });
  _client = client;
  client.onError((...e) => {
    bLog(`TV client error — reconnect 30s: ${e.join(' ')}`);
    setTimeout(() => connectAll(ind), 30_000);
  });
  for (const tv of TV_SYMBOLS) {
    try { watch15m(client, ind, tv); } catch (e) { bLog(`[${normSym(tv)}][15m] watch failed: ${e.message}`); }
  }
  bLog(`Watching ${TV_SYMBOLS.map(normSym).join('/')} on one TV client`);
}

// ── 1m entry scan loop (native Bybit) ────────────────────────────
async function scanEntries() {
  for (const tvTicker of TV_SYMBOLS) {
    const sym = normSym(tvTicker);
    const rawBias = biasMap[sym];
    if (rawBias && !rawBias.traded && Date.now() - rawBias.openedAt > ENTRY_CONFIRM_MS) {
      rawBias.traded = true;
      bLog(`[${sym}][1m] ${rawBias.direction} missed - no 1m structure within 10 candles`);
      continue;
    }
    const b = biasAlive(sym);
    if (!b) continue;
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

      markTraded(sym, dir);
      biasMap[sym].traded = true;   // one trade per bias window

      bLog(`[${sym}][1m] *** TRADE ${dir} | price=${price} | Expo bias + 1m swing | baseline SL50/TP35 ***`);
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
        tpMarginFrac: TP_MARGIN / LEVERAGE,
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
  bLog(`Starting Expo baseline watcher — ${TV_SYMBOLS.map(normSym).join('/')} | 20x SL${SL_MARGIN*100}%/TP${TP_MARGIN*100}% | NO trail`);
  if (!process.env.TV_SESSION) bLog('⚠ TV_SESSION not set — Expo study will fail to load.');
  let ind;
  try { ind = await loadExpo(); }
  catch (e) { bLog(`Expo load failed: ${e.message} — retry 60s`); return void setTimeout(start, 60_000); }
  connectAll(ind);
  startDiagnostics(ind);
  _scanTimer = setTimeout(scanEntries, 5000);
}

if (require.main === module) start().catch(console.error);
module.exports = { start };
