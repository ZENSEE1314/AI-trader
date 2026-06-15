'use strict';

// EXPO baseline watcher — BTC / ETH / SOL
// ======================================================================
// Entry (matches backtest-expo-struct.js "baseline"):
//   BIAS  : 15m — read SMC Expo (PUB;26ae…) HL/LH structure labels live.
//           HL → long bias, LH → short bias. Active ~2h (8 × 15m) after the
//           label appears (the label is already pivot-confirmed when read).
//   ENTRY : 1m native swing pullback — enter on the candle after a 1m swing
//           low (long) / swing high (short). One trade per bias window.
//   RISK  : 20x, hard SL −50% margin, hard TP +35% margin, NO trailing,
//           NO 15m early exit (setup='EXPO_BASELINE', noTrail flag in cycle.js).
//
// ⚠ Validated on only ~8 days / ~7 trades per token — directional, not robust.
// Signals go through injectTVSignal → cycle.js (same path as smc-suite-watcher).

const TradingView = require('@mathieuc/tradingview');
const fetch = require('node-fetch');
const { injectTVSignal } = require('../cycle');

const bLog = (...a) => console.log('[Expo-Watcher]', ...a);

// ── Config ───────────────────────────────────────────────────────
const EXPO_ID      = 'PUB;26ae10374a9d4b0591b5b51a41356e57';   // Smart Money Concept (Expo)
const TV_SYMBOLS   = ['BITUNIX:BTCUSDT.P', 'BITUNIX:ETHUSDT.P', 'BITUNIX:SOLUSDT.P'];
const BYBIT_SYM    = { BTCUSDT: 'BTCUSDT', ETHUSDT: 'ETHUSDT', SOLUSDT: 'SOLUSDT' };
const HISTORY_BARS = 300;
const LABEL_LAG_MS = 150 * 60 * 1000;      // Expo label appears ~10×15m after its pivot bar (confirm lag)
const WINDOW_MS    = 120 * 60 * 1000;      // entry window = 8×15m once the label goes live (matches backtest)
const COOLDOWN_MS  = 30 * 60 * 1000;       // 30 min per symbol per direction
const SCAN_MS      = 30_000;               // 1m entry scan cadence
const LEVERAGE     = 20;
const SL_MARGIN    = 0.50;                 // hard SL −50% of margin
const TP_MARGIN    = 0.35;                 // hard TP +35% of margin
const BYBIT_URL    = 'https://api.bybit.com/v5/market/kline';

// ── Shared state ─────────────────────────────────────────────────
const biasMap   = {};   // sym → { direction:'LONG'|'SHORT', labelTime, setAt }
const cooldowns = new Map();
let   _scanTimer = null;

function canTrade(sym, dir)   { return Date.now() - (cooldowns.get(`${sym}:${dir}`) || 0) > COOLDOWN_MS; }
function markTraded(sym, dir) { cooldowns.set(`${sym}:${dir}`, Date.now()); }
function normSym(tv)          { return tv.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT'); }
// Bias is live only while NOW sits inside the label's entry window — based on the
// label's own pivot time, not when we read it (else stale labels fire at startup).
function biasAlive(sym) {
  const b = biasMap[sym];
  if (!b || b.traded) return null;
  const start = b.labelTime + LABEL_LAG_MS;
  const now = Date.now();
  return (now >= start && now <= start + WINDOW_MS) ? b : null;
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

// ── 15m Expo watcher — reads HL/LH labels, sets bias ─────────────
let _expoInd = null;
async function loadExpo() {
  if (!_expoInd) _expoInd = await TradingView.getIndicator(EXPO_ID, 'last', process.env.TV_SESSION || '', process.env.TV_SESSION_SIGN || '');
  return _expoInd;
}

async function watch15m(tvTicker) {
  const sym = normSym(tvTicker);
  bLog(`[${sym}][15m] Starting Expo label watch`);

  const client = new TradingView.Client({ token: process.env.TV_SESSION || '', signature: process.env.TV_SESSION_SIGN || '' });
  client.onError((...e) => {
    bLog(`[${sym}][15m] TV error — reconnect 30s: ${e.join(' ')}`);
    client.end();
    setTimeout(() => watch15m(tvTicker), 30_000);
  });

  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: '15', range: HISTORY_BARS });

  let ind;
  try { ind = await loadExpo(); }
  catch (e) { bLog(`[${sym}][15m] Expo load failed: ${e.message} — retry 60s`); client.end(); setTimeout(() => watch15m(tvTicker), 60_000); return; }

  const study = new chart.Study(ind);
  study.onError((...e) => bLog(`[${sym}][15m] study error: ${e.join(' ')}`));
  study.onUpdate(() => {
    try {
      const labels = (study.graphic && study.graphic.labels) || [];
      const periods = chart.periods || [];   // newest-first; label.x = bars-from-newest
      if (!labels.length || !periods.length) return;

      // Most recent confirmed HL/LH label (smallest x = newest, x != null = confirmed)
      let newest = null;
      for (const l of labels) {
        if (l.x == null) continue;
        if (l.text !== 'HL' && l.text !== 'LH') continue;
        const bar = periods[l.x];
        if (!bar) continue;
        const t = bar.time * 1000;
        if (!newest || t > newest.time) newest = { time: t, dir: l.text === 'HL' ? 'LONG' : 'SHORT' };
      }
      if (!newest) return;

      const cur = biasMap[sym];
      if (cur && cur.labelTime === newest.time) return;   // already have this label
      biasMap[sym] = { direction: newest.dir, labelTime: newest.time, traded: false };
      const start = newest.time + LABEL_LAG_MS, now = Date.now();
      const live = now >= start && now <= start + WINDOW_MS;
      bLog(`[${sym}][15m] Expo ${newest.dir === 'LONG' ? 'HL' : 'LH'} @ ${new Date(newest.time).toISOString().slice(0,16)} → bias=${newest.dir} ${live ? `(LIVE — ${Math.round((start + WINDOW_MS - now)/60000)}m left)` : '(stale — outside entry window, idle)'}`);
    } catch (e) { bLog(`[${sym}][15m] parse error: ${e.message}`); }
  });
}

// ── 1m entry scan loop (native Bybit) ────────────────────────────
async function scanEntries() {
  for (const tvTicker of TV_SYMBOLS) {
    const sym = normSym(tvTicker);
    const b = biasAlive(sym);
    if (!b) continue;
    if (!canTrade(sym, b.direction)) continue;
    try {
      const c1m = await fetch1m(BYBIT_SYM[sym], 5);
      const dir = detectEntry(c1m, b.direction);
      if (!dir) continue;

      const price = c1m[c1m.length - 1].close;
      const isLong = dir === 'LONG';
      const slFrac = SL_MARGIN / LEVERAGE;   // price-% (0.50/20 = 0.025)
      const tpFrac = TP_MARGIN / LEVERAGE;   // price-% (0.35/20 = 0.0175)
      markTraded(sym, dir);
      biasMap[sym].traded = true;   // one trade per bias window

      bLog(`[${sym}][1m] *** TRADE ${dir} | price=${price} | Expo bias + 1m swing | baseline SL50/TP35 ***`);
      injectTVSignal({
        symbol: sym,
        side: isLong ? 'BUY' : 'SELL',
        direction: dir,
        price,
        zone: 'EXPO',
        pivot: isLong ? 'HL' : 'LH',
        setup: 'EXPO_BASELINE',
        // NOTE: cycle.js stores `setupName || setup` in the trades table, and the
        // trailing-skip guards match setup === 'EXPO_BASELINE' — so setupName MUST be
        // exactly that, else the stored value won't match and trailing won't be skipped.
        setupName: 'EXPO_BASELINE',
        score: 75,
        signalType: `EXPO-${dir}`,
        source: 'expo-watcher',
        timeframe: '1',
        leverage: LEVERAGE,
        slMarginFrac: slFrac,
        tpMarginFrac: tpFrac,
        noTrail: true,            // baseline: hard SL/TP only, no trailing
        isMomentumBreakout: true,
        override: true,
        receivedAt: Date.now(),
      });
    } catch (e) { bLog(`[${sym}][1m] scan error: ${e.message}`); }
  }
  _scanTimer = setTimeout(scanEntries, SCAN_MS);
}

// ── Start ─────────────────────────────────────────────────────────
async function start() {
  bLog(`Starting Expo baseline watcher — ${TV_SYMBOLS.map(normSym).join('/')} | 20x SL${SL_MARGIN*100}%/TP${TP_MARGIN*100}% | NO trail`);
  if (!process.env.TV_SESSION) bLog('⚠ TV_SESSION not set — Expo study will fail to load.');
  for (const tv of TV_SYMBOLS) {
    watch15m(tv).catch(e => bLog(`[15m fatal] ${tv}: ${e.message}`));
    await new Promise(r => setTimeout(r, 2000));
  }
  _scanTimer = setTimeout(scanEntries, 5000);
}

if (require.main === module) start().catch(console.error);
module.exports = { start };
