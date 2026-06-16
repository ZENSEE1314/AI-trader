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

const bLog = (...a) => console.log('[Expo-Watcher]', ...a);

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
const WINDOW_MS    = 120 * 60 * 1000;      // entry window once a fresh Expo HL/LH appears (8 × 15m)
const FRESH_MS     = WINDOW_MS;            // Pine keeps HL/LH bias alive for piv_len + 3 bars
const COOLDOWN_MS  = 30 * 60 * 1000;       // 30 min per symbol per direction
const SCAN_MS      = 30_000;               // 1m entry scan cadence
const LEVERAGE     = 20;
const SL_MARGIN    = 0.50;                 // hard SL −50% of margin
const TP_MARGIN    = 0.35;                 // hard TP +35% of margin
const BYBIT_URL    = 'https://api.bybit.com/v5/market/kline';

// ── Shared state ─────────────────────────────────────────────────
const biasMap   = {};   // sym → { direction, labelTime, openedAt, traded }
const lastSeen  = {};   // sym → labelTime of the most recently processed Expo label
const cooldowns = new Map();
let   _client = null;
let   _expoInd = null;
let   _scanTimer = null;

// Trade only London/NY hours. Asia session is blocked.
// Allowed: 07:00-21:00 UTC (14:00-04:00 Jakarta).
function inTradingSession() { const h = new Date().getUTCHours(); return h >= 7 && h < 21; }
function canTrade(sym, dir)   { return Date.now() - (cooldowns.get(`${sym}:${dir}`) || 0) > COOLDOWN_MS; }
function markTraded(sym, dir) { cooldowns.set(`${sym}:${dir}`, Date.now()); }
function normSym(tv)          { return tv.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT'); }
// Bias is live for WINDOW_MS after a fresh label opened it; cleared after one trade.
function biasAlive(sym) {
  const b = biasMap[sym];
  if (!b || b.traded) return null;
  return Date.now() - b.openedAt < WINDOW_MS ? b : null;
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
          time: t,
          type: l.text,
          dir: l.text === 'HL' ? 'LONG' : l.text === 'LH' ? 'SHORT' : null,
        };
      }
      if (!newest) return;
      if (lastSeen[sym] === newest.time) return;   // already processed this label
      lastSeen[sym] = newest.time;

      const age = Date.now() - newest.time;
      const at  = new Date(newest.time).toISOString().slice(0, 16);
      if (newest.dir && age <= FRESH_MS) {
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
  const sessionOpen = inTradingSession();
  for (const tvTicker of TV_SYMBOLS) {
    const sym = normSym(tvTicker);
    const b = biasAlive(sym);
    if (!b) continue;
    if (!sessionOpen) continue;   // outside London/NY hours — no entries
    if (!canTrade(sym, b.direction)) continue;
    try {
      const c1m = await fetch1m(BYBIT_SYM[sym], 5);
      const dir = detectEntry(c1m, b.direction);
      if (!dir) continue;

      const price = c1m[c1m.length - 1].close;
      const isLong = dir === 'LONG';
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
  _scanTimer = setTimeout(scanEntries, 5000);
}

if (require.main === module) start().catch(console.error);
module.exports = { start };
