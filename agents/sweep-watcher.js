'use strict';

// EQ-SWEEP watcher — BTC / ETH / SOL (forward-test of backtest-live-rules.js winner)
// ======================================================================
// ENTRY: a 15m swing pivot (left 10 bars, right 1) is a liquidity level.
//        When the LATEST CLOSED 15m bar sweeps a level (trades through it)
//        but CLOSES back on the safe side, AND the sweep bar was quiet
//        (volume < 0.8× its 20-bar average) AND the aggressors were against
//        the reversal and failed (taker ratio in trade direction < 45%,
//        from Binance futures klines) → market entry with the trend reversal.
//        Level swept down + reclaimed → LONG; swept up + rejected → SHORT.
// EXIT : TV Expo 15m structure labels via expo-watcher's closeExpoOnStructure
//        (setup LIKE 'EXPO_BASELINE%' covers [SWEEP] trades: LONG closes on
//        HH/LH, SHORT on LL/HL) — plus the hard SL (−50% margin) placed by
//        cycle. Native quick pivots (L10/R1) proved too noisy for exits: they
//        closed a winning ETH short on a phantom HL on 2026-07-12.
// TAG  : setup EXPO_BASELINE (exact, required by the executor whitelist),
//        setupName EXPO_BASELINE[SWEEP] so DB rows are distinguishable and all
//        EXPO guards (no TP, no trailing, structure-only) apply via startsWith.
//
// Backtest (90d, $1000 @ 20x, all gates): BTC +$1213 ETH +$714 SOL +$2146,
// WR 67-78%, PF 2.2-2.9, ~1.3 trades/day across 3 tokens. Forward-test to confirm.

const fetch = require('node-fetch');

const bLog = (...a) => console.log('[Sweep-Watcher]', ...a);

// ── Config ───────────────────────────────────────────────────────
// SOL+ETH only (owner 2026-07-23): BTC loses on the sweep (−$83 to −$208/90d) —
// dropped, same as it was dropped from the label. SOL is the sweep edge (+$155–461);
// ETH is ~breakeven (+$10) and kept per owner. Env SWEEP_ENTRY_SYMBOLS overrides.
const SYMBOLS     = (process.env.SWEEP_ENTRY_SYMBOLS || 'ETHUSDT,SOLUSDT').split(',').map(s => s.trim()).filter(Boolean);
const SWING_LEN   = 10;                  // left-side pivot strength (matches Expo structure period)
const CONFIRM     = 1;                   // right-side bars to confirm a pivot (fast, live-like)
const VOL_TH      = Number(process.env.SWEEP_VOL_TH  || 0.8);   // sweep bar quieter than 0.8× avg(20)
const AGGR_TH     = Number(process.env.SWEEP_AGGR_TH || 0.45);  // taker flow in trade direction below 45%
const LEVERAGE    = 20;
const SL_MARGIN   = 0.50;                // hard SL −50% of margin (cycle places it)
const COOLDOWN_MS = 30 * 60 * 1000;      // per symbol per direction
const POLL_MS     = 30_000;
const BARS        = 120;                 // 15m history per poll (pivots + vol SMA)
const BAR_MS      = 15 * 60 * 1000;
const BYBIT_URL   = 'https://api.bybit.com/v5/market/kline';
const BINANCE_URL = 'https://fapi.binance.com/fapi/v1/klines';

// ── State ────────────────────────────────────────────────────────
const cooldowns  = new Map();            // `${sym}:${dir}` → ts
const firedKeys  = new Set();            // `${sym}:${pivotBarTime}` — levels already traded
const status     = {};                   // sym → diagnostics for /api/admin/sweep-status
let   _timer     = null;

function canTrade(sym, dir)   { return Date.now() - (cooldowns.get(`${sym}:${dir}`) || 0) > COOLDOWN_MS; }
function markTraded(sym, dir) { cooldowns.set(`${sym}:${dir}`, Date.now()); }

// ── Data ─────────────────────────────────────────────────────────
async function fetch15m(symbol) {
  const url = `${BYBIT_URL}?category=linear&symbol=${symbol}&interval=15&limit=${BARS}`;
  const res = await fetch(url, { timeout: 10_000 });
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
  const bars = json.result.list
    .map(r => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
    .sort((a, b) => a.time - b.time);
  // Closed bars only — the in-progress bar must not trigger sweeps or labels
  while (bars.length && bars[bars.length - 1].time + BAR_MS > Date.now()) bars.pop();
  return bars;
}

// Taker-buy ratio of one 15m bar (who was hitting market orders)
async function fetchBuyRatio(symbol, barTime) {
  const url = `${BINANCE_URL}?symbol=${symbol}&interval=15m&startTime=${barTime}&limit=1`;
  const res = await fetch(url, { timeout: 10_000 });
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length || +rows[0][0] !== barTime) throw new Error('no Binance bar');
  const vol = parseFloat(rows[0][5]), buy = parseFloat(rows[0][9]);
  return vol > 0 ? buy / vol : 0.5;
}

// ── Structure engine (same rules as the backtest) ────────────────
function findPivots(bars) {
  const pivots = [];
  for (let i = SWING_LEN; i < bars.length - CONFIRM; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= SWING_LEN && (isH || isL); k++) {
      if (isH && !(bars[i].high > bars[i - k].high)) isH = false;
      if (isL && !(bars[i].low  < bars[i - k].low))  isL = false;
    }
    for (let k = 1; k <= CONFIRM && (isH || isL); k++) {
      if (isH && !(bars[i].high > bars[i + k].high)) isH = false;
      if (isL && !(bars[i].low  < bars[i + k].low))  isL = false;
    }
    if (isH) pivots.push({ kind: 'H', i, price: bars[i].high, time: bars[i].time });
    if (isL) pivots.push({ kind: 'L', i, price: bars[i].low,  time: bars[i].time });
  }
  return pivots; // ordered by bar index; confirm bar = i + CONFIRM
}

// Newest confirmed HH/HL/LH/LL label (for structure exits)
function newestLabel(pivots) {
  let prevHigh = null, prevLow = null, newest = null;
  for (const p of pivots) {
    let type = null;
    if (p.kind === 'H') { type = prevHigh == null ? null : (p.price > prevHigh ? 'HH' : 'LH'); prevHigh = p.price; }
    else { type = prevLow == null ? null : (p.price > prevLow ? 'HL' : 'LL'); prevLow = p.price; }
    if (type) newest = { type, time: p.time, price: p.price };
  }
  return newest;
}

// ── Entry: sweep + reclaim + flow gates on the latest closed bar ──
async function checkEntries(sym, bars, pivots) {
  const lastIdx = bars.length - 1;
  const bar = bars[lastIdx];
  if (lastIdx < SWING_LEN + 21) return;

  for (const p of pivots) {
    // Level is sweepable only after its confirm bar; first breach must be the latest bar
    const activeFrom = p.i + CONFIRM + 1;
    if (activeFrom > lastIdx) continue;
    const fireKey = `${sym}:${p.time}:${p.kind}`;
    if (firedKeys.has(fireKey)) continue;

    let firstBreach = -1;
    for (let j = activeFrom; j <= lastIdx; j++) {
      if (p.kind === 'L' ? bars[j].low < p.price : bars[j].high > p.price) { firstBreach = j; break; }
    }
    if (firstBreach !== lastIdx) {
      if (firstBreach !== -1) firedKeys.add(fireKey);   // swept in an older bar — level spent, never re-trade
      continue;
    }

    // Sweep on THIS bar — reclaim check
    const dir = p.kind === 'L' ? 'LONG' : 'SHORT';
    const reclaimed = p.kind === 'L' ? bar.close > p.price : bar.close < p.price;
    firedKeys.add(fireKey);                             // one evaluation per level, pass or fail
    if (!reclaimed) { bLog(`[${sym}] level ${p.price} swept, no reclaim (close ${bar.close}) — continuation, skip`); continue; }
    if (!canTrade(sym, dir)) continue;

    // Gate 1: quiet sweep — volume below VOL_TH × 20-bar average
    const avgVol = bars.slice(lastIdx - 20, lastIdx).reduce((s, b) => s + b.volume, 0) / 20;
    const volRatio = avgVol > 0 ? bar.volume / avgVol : null;
    if (volRatio == null || volRatio >= VOL_TH) {
      bLog(`[${sym}] sweep+reclaim ${dir} blocked: volume ${volRatio == null ? 'n/a' : volRatio.toFixed(2)}× avg (need <${VOL_TH}) — initiative flow, likely continuation`);
      continue;
    }

    // Gate 2: trapped aggressors — taker flow in trade direction below AGGR_TH
    let buyRatio;
    try { buyRatio = await fetchBuyRatio(sym, bar.time); }
    catch (e) { bLog(`[${sym}] sweep ${dir} blocked: Binance flow unavailable (${e.message})`); continue; }
    const aggrInDir = dir === 'LONG' ? buyRatio : 1 - buyRatio;
    if (aggrInDir >= AGGR_TH) {
      bLog(`[${sym}] sweep+reclaim ${dir} blocked: aggressor ratio ${(aggrInDir * 100).toFixed(0)}% (need <${AGGR_TH * 100}%) — no trapped flow`);
      continue;
    }

    // All gates passed — fire
    const price = bar.close;
    markTraded(sym, dir);
    bLog(`[${sym}] *** SWEEP TRADE ${dir} | level=${p.price} sweptBar=${new Date(bar.time).toISOString().slice(11, 16)} close=${price} vol=${volRatio.toFixed(2)}× aggr=${(aggrInDir * 100).toFixed(0)}% ***`);
    const signal = {
      symbol: sym,
      side: dir === 'LONG' ? 'BUY' : 'SELL',
      direction: dir,
      price,
      lastPrice: price,
      zone: 'EQ_SWEEP',
      pivot: dir === 'LONG' ? 'HL' : 'LH',
      setup: 'EXPO_BASELINE',                  // exact value required by executor whitelist
      setupName: 'EXPO_BASELINE[SWEEP]',       // stored in trades.setup — keeps EXPO guards via startsWith
      score: 75,
      signalType: `SWEEP-${dir}`,
      source: 'expo-watcher',                  // executor whitelist requires this exact source
      timeframe: '15',
      leverage: LEVERAGE,
      slMarginFrac: SL_MARGIN / LEVERAGE,
      isMomentumBreakout: true,
      override: true,
      receivedAt: Date.now(),
    };
    try {
      const { getCoordinator } = require('../agents');
      const coord = getCoordinator && getCoordinator();
      if (coord && coord.traderAgent && !coord.traderAgent.paused) {
        await coord.traderAgent.execute({ signals: [signal], mode: 'signals' });
        status[sym].entriesFired = (status[sym].entriesFired || 0) + 1;
        bLog(`[${sym}] → TraderAgent executed`);
      } else {
        bLog(`[${sym}] TraderAgent unavailable — signal dropped`);
      }
    } catch (e) {
      bLog(`[${sym}] routing error: ${e.message}`);
    }
    return;   // one entry per symbol per poll
  }
}

// ── Poll loop ─────────────────────────────────────────────────────
async function poll() {
  for (const sym of SYMBOLS) {
    try {
      const bars = await fetch15m(sym);
      if (bars.length < SWING_LEN + 25) { status[sym] = { ...status[sym], lastError: 'not enough bars' }; continue; }
      const pivots = findPivots(bars);

      // Exits are handled by expo-watcher's TV Expo structure labels (+ hard SL);
      // the native label here is diagnostics only.
      const label = newestLabel(pivots);

      await checkEntries(sym, bars, pivots);

      status[sym] = {
        ...status[sym],
        lastPoll: Date.now(),
        lastClosedBar: bars[bars.length - 1].time,
        pivotCount: pivots.length,
        newestLabel: label ? `${label.type}@${new Date(label.time).toISOString().slice(0, 16)}` : null,
        lastError: null,
      };
    } catch (e) {
      status[sym] = { ...status[sym], lastPoll: Date.now(), lastError: e.message };
      bLog(`[${sym}] poll error: ${e.message}`);
    }
  }
  // Prevent unbounded growth across weeks of uptime
  if (firedKeys.size > 5000) firedKeys.clear();
  _timer = setTimeout(poll, POLL_MS);
}

function getStatus() {
  return { config: { SYMBOLS, SWING_LEN, CONFIRM, VOL_TH, AGGR_TH, LEVERAGE, SL_MARGIN }, symbols: status };
}

async function start() {
  bLog(`Starting EQ-Sweep watcher — ${SYMBOLS.join('/')} | pivots L${SWING_LEN}/R${CONFIRM} | gates: vol<${VOL_TH}× aggr<${AGGR_TH * 100}% | ${LEVERAGE}x SL${SL_MARGIN * 100}% | structure exits`);
  for (const sym of SYMBOLS) status[sym] = {};
  _timer = setTimeout(poll, 5000);
}

if (require.main === module) start().catch(console.error);
module.exports = { start, getStatus };
