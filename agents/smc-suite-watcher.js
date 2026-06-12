'use strict';

// =============================================================
// SMC Pro Suite Watcher — AI Learning Edition
//
// Reads SMC Pro Suite indicator values via TradingView WebSocket.
// Runs a rolling backtest on 200 bars to find the optimal probability
// threshold, then feeds a Q-Learning agent the rich indicator state
// so it learns WHEN to act on signals.
//
// Plot index discovery: on first onUpdate, all plot values are logged
// so you can verify sig_long/sig_short indices from Railway logs.
// =============================================================

const TradingView = require('@mathieuc/tradingview');
const { injectTVSignal } = require('../cycle');

const bLog = (...args) => console.log('[SMC-Watcher]', ...args);

// ── Config ──────────────────────────────────────────────────
const SYMBOLS        = ['BITUNIX:BTCUSDT.P', 'BITUNIX:ETHUSDT.P', 'BITUNIX:SOLUSDT.P'];
const TIMEFRAMES     = ['15', '1'];  // live trading timeframes (15m + 1m)
const BT_TIMEFRAME   = '1';         // 1m backtest
const HISTORY_BARS   = 5000;        // ~3.5 days of 1m bars for backtest
const COOLDOWN_MS  = 30 * 60 * 1000;  // 30 min cooldown per symbol per direction
const SCRIPT_ID    = 'USER;5c16ebbf6afb4746a8fc0b693cc3a834';

// Plot index layout (Pine Script declaration order):
// 0  VWAP
// 1  VWAP+1
// 2  VWAP-1
// 3  VWAP+2
// 4  VWAP-2
// 5  HH  (plotshape)
// 6  LL  (plotshape)
// 7  Smart Trail
// 8  sig_long       ← these are the signal plots
// 9  sig_short
// 10 prob_long      ← AI learning exports (added in Pine v2)
// 11 prob_short
// 12 smc_l
// 13 smc_s
// 14 liq_l
// 15 liq_s
// 16 ob_l
// 17 ob_s
// 18 wt_l
// 19 wt_s
// 20 trail_dir

// If the indicator hasn't been re-published with AI exports yet, fall back:
const IDX = {
  sigLong:   8,
  sigShort:  9,
  probLong:  10,
  probShort: 11,
  smcL:      12,
  smcS:      13,
  liqL:      14,
  liqS:      15,
  obL:       16,
  obS:       17,
  wtL:       18,
  wtS:       19,
  trailDir:  20,
};

// ── Q-Learning ───────────────────────────────────────────────
// State = (probBucket, smcScore, liqScore, obScore, wtScore, trailDir)
// Actions = 0 (skip), 1 (trade)
// Reward  = +1 win, -1 loss  (winner determined by next bar direction)

const Q_TABLE = {};   // 'state' → [skipValue, tradeValue]
const ALPHA   = 0.1;  // learning rate
const GAMMA   = 0.9;  // discount
let   EPSILON = 0.3;  // exploration (decays toward 0.05)

function stateKey(f) {
  const prob = Math.floor(f.prob / 20) * 20;  // bucket to 20s: 0,20,40,60,80,100
  return `${prob}|${f.smc}|${f.liq}|${f.ob}|${f.wt}|${f.trail}`;
}

function qValues(key) {
  if (!Q_TABLE[key]) Q_TABLE[key] = [0, 0];
  return Q_TABLE[key];
}

function qAction(key) {
  const q = qValues(key);
  if (Math.random() < EPSILON) return Math.random() < 0.5 ? 0 : 1;
  return q[1] >= q[0] ? 1 : 0;  // 1=trade, 0=skip
}

function qUpdate(key, action, reward) {
  const q = qValues(key);
  q[action] += ALPHA * (reward + GAMMA * Math.max(...q) - q[action]);
  EPSILON = Math.max(0.05, EPSILON * 0.9995);
}

// ── Backtester ───────────────────────────────────────────────
// Given historical periods from the study, find the probability
// threshold where win rate is highest (using at least 10 trades).

function runBacktest(periods, pricePeriods, direction) {
  const sigIdx  = direction === 'LONG' ? IDX.sigLong  : IDX.sigShort;
  const probIdx = direction === 'LONG' ? IDX.probLong : IDX.probShort;

  const signals = [];
  for (let i = 0; i < periods.length - 1; i++) {
    const bar  = periods[i];
    const next = pricePeriods?.[i + 1];
    if (!bar || !next) continue;

    const fired = bar[sigIdx] === 1;
    if (!fired) continue;

    const prob    = bar[probIdx] ?? 50;
    const entryPx = next.open  ?? 0;
    const exitPx  = next.close ?? 0;
    const pnl     = direction === 'LONG'
      ? exitPx - entryPx
      : entryPx - exitPx;

    signals.push({ prob, win: pnl > 0 });
  }

  if (signals.length < 3) return { threshold: 40, winRate: null, trades: signals.length };

  // Try thresholds 30–80 in steps of 5; pick the one with best win rate (min 3 trades)
  let bestThreshold = 40;
  let bestWinRate   = 0;

  for (let t = 30; t <= 80; t += 5) {
    const subset = signals.filter(s => s.prob >= t);
    if (subset.length < 3) continue;
    const wins    = subset.filter(s => s.win).length;
    const winRate = wins / subset.length;
    if (winRate > bestWinRate) {
      bestWinRate   = winRate;
      bestThreshold = t;
    }
  }

  return { threshold: bestThreshold, winRate: bestWinRate, trades: signals.length };
}

// ── Pending trades for Q-Learning reward assignment ──────────
// When we trade, remember the state+action so we can reward it next bar.
const pending = new Map();  // sym → { key, action, direction, entryPx }

// ── Cooldown ────────────────────────────────────────────────
const cooldowns = new Map();

function canTrade(sym, direction) {
  const last = cooldowns.get(`${sym}:${direction}`) || 0;
  return Date.now() - last > COOLDOWN_MS;
}

function markTraded(sym, direction) {
  cooldowns.set(`${sym}:${direction}`, Date.now());
}

function normalizeSym(tvTicker) {
  return tvTicker.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT');
}

// ── Per-symbol dynamic thresholds ───────────────────────────
const dynamicThreshold = {};  // sym → { long: N, short: N }

const MIN_THRESHOLD = 15;  // never trade below this regardless of backtest

function getThreshold(sym, direction) {
  const bt = dynamicThreshold[sym]?.[direction.toLowerCase()] ?? MIN_THRESHOLD;
  return Math.max(bt, MIN_THRESHOLD);
}

// ── 1m Backtest runner ───────────────────────────────────────
// Runs once on startup: fetches 5000 1m bars, finds every signal,
// tests all thresholds, prints a full WR table to the logs.

async function runFullBacktest(tvTicker) {
  const sym = normalizeSym(tvTicker);
  bLog(`[${sym}][BT] Loading 1m backtest (${HISTORY_BARS} bars)...`);

  const client = new TradingView.Client();
  const chart  = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: BT_TIMEFRAME, range: HISTORY_BARS });

  let indicator;
  try {
    indicator = await TradingView.getIndicator(
      SCRIPT_ID, 'last',
      process.env.TV_SESSION      || '',
      process.env.TV_SESSION_SIGN || '',
    );
  } catch (err) {
    bLog(`[${sym}][BT] Failed to load indicator: ${err.message}`);
    client.end();
    return;
  }

  const pine = new chart.Study(indicator);

  await new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    // Wait until we have enough bars or 60s timeout
    pine.onUpdate(() => {
      if ((pine.periods?.length ?? 0) >= Math.min(500, HISTORY_BARS * 0.1)) done();
    });
    setTimeout(done, 60_000);
  });

  const periods      = pine.periods      || [];
  const pricePeriods = chart.periods     || [];

  if (periods.length < 10) {
    bLog(`[${sym}][BT] Not enough bars (${periods.length}) — skipping`);
    client.end();
    return;
  }

  bLog(`[${sym}][BT] Got ${periods.length} bars on 1m`);

  for (const dir of ['LONG', 'SHORT']) {
    const sigIdx  = dir === 'LONG' ? IDX.sigLong  : IDX.sigShort;
    const probIdx = dir === 'LONG' ? IDX.probLong : IDX.probShort;

    const signals = [];
    for (let i = 0; i < periods.length - 1; i++) {
      const bar  = periods[i];
      const next = pricePeriods?.[i + 1];
      if (!bar || !next) continue;
      if (bar[sigIdx] !== 1) continue;

      const prob    = bar[probIdx] ?? 50;
      const entryPx = next.open  ?? 0;
      const exitPx  = next.close ?? 0;
      const pnl     = dir === 'LONG' ? exitPx - entryPx : entryPx - exitPx;
      signals.push({ prob, win: pnl > 0, pnl });
    }

    if (signals.length === 0) {
      bLog(`[${sym}][BT] ${dir}: no signals found in ${periods.length} bars`);
      continue;
    }

    // Print WR table for every threshold
    bLog(`[${sym}][BT] ── ${dir} (${signals.length} total signals) ──`);
    let bestLine = '';
    let bestWR   = 0;
    for (let t = 20; t <= 90; t += 5) {
      const sub   = signals.filter(s => s.prob >= t);
      if (sub.length === 0) continue;
      const wins  = sub.filter(s => s.win).length;
      const wr    = (wins / sub.length * 100).toFixed(1);
      const bar   = '█'.repeat(Math.round(wins / sub.length * 10)) + '░'.repeat(10 - Math.round(wins / sub.length * 10));
      const line  = `  thresh=${t}%  trades=${sub.length}  wins=${wins}  WR=${wr}%  ${bar}`;
      bLog(`[${sym}][BT]${line}`);
      if (wins / sub.length > bestWR && sub.length >= 3) {
        bestWR   = wins / sub.length;
        bestLine = `thresh=${t}%  WR=${wr}%  trades=${sub.length}`;
      }
    }
    bLog(`[${sym}][BT] BEST ${dir}: ${bestLine}`);

    // Apply best threshold to live trading
    if (!dynamicThreshold[sym]) dynamicThreshold[sym] = { long: 40, short: 40 };
    dynamicThreshold[sym][dir.toLowerCase()] = parseInt(bestLine.match(/thresh=(\d+)/)?.[1] ?? '40');
  }

  client.end();
  bLog(`[${sym}][BT] Done — live thresholds: LONG=${dynamicThreshold[sym]?.long}% SHORT=${dynamicThreshold[sym]?.short}%`);
}

// ── Main watcher ─────────────────────────────────────────────
async function watchSymbol(tvTicker, timeframe = '15') {
  const sym = normalizeSym(tvTicker);
  bLog(`[${sym}][${timeframe}m] Starting watcher`);

  const client = new TradingView.Client();
  client.onError((...err) => {
    bLog(`[${sym}][${timeframe}m] TV error: ${err.join(' ')} — reconnecting in 30s`);
    client.end();
    setTimeout(() => watchSymbol(tvTicker, timeframe), 30_000);
  });

  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe, range: HISTORY_BARS });

  let indicator;
  try {
    indicator = await TradingView.getIndicator(
      SCRIPT_ID, 'last',
      process.env.TV_SESSION      || '',
      process.env.TV_SESSION_SIGN || '',
    );
    bLog(`[${sym}][${timeframe}m] Loaded: ${indicator.description || 'SMC Pro Suite'}`);
  } catch (err) {
    bLog(`[${sym}][${timeframe}m] Failed to load indicator: ${err.message} — retrying in 60s`);
    client.end();
    setTimeout(() => watchSymbol(tvTicker, timeframe), 60_000);
    return;
  }

  const pine = new chart.Study(indicator);

  // Discover plot indices from metadata when available
  pine.onReady(() => {
    const plots = pine.studyInputsInfo?.plots || pine.metaInfo?.plots || [];
    bLog(`[${sym}] Total plots in metadata: ${plots.length}`);
    plots.forEach((p, i) => {
      if (p.id || p.title) bLog(`[${sym}]   plot[${i}] id="${p.id}" title="${p.title}"`);
      // Override IDX if names are found
      const name = p.id || p.title || '';
      if (name === 'sig_long')  { IDX.sigLong   = i; bLog(`[${sym}] sig_long  → index ${i}`); }
      if (name === 'sig_short') { IDX.sigShort  = i; bLog(`[${sym}] sig_short → index ${i}`); }
      if (name === 'prob_long') { IDX.probLong  = i; }
      if (name === 'prob_short'){ IDX.probShort = i; }
      if (name === 'smc_l')     { IDX.smcL      = i; }
      if (name === 'smc_s')     { IDX.smcS      = i; }
      if (name === 'liq_l')     { IDX.liqL      = i; }
      if (name === 'liq_s')     { IDX.liqS      = i; }
      if (name === 'ob_l')      { IDX.obL       = i; }
      if (name === 'ob_s')      { IDX.obS       = i; }
      if (name === 'wt_l')      { IDX.wtL       = i; }
      if (name === 'wt_s')      { IDX.wtS       = i; }
      if (name === 'trail_dir') { IDX.trailDir  = i; }
    });
  });

  let backtestDone   = false;
  let debugDumped    = false;
  let lastSignal     = null;
  let lastBarClose   = null;

  pine.onUpdate(() => {
    try {
      const periods      = pine.periods;
      const pricePeriods = chart.periods;
      if (!periods || periods.length < 2) return;

      const latest     = periods[periods.length - 1];
      const prevBar    = periods[periods.length - 2];
      const priceLatest = pricePeriods?.[pricePeriods.length - 1];

      // Dump all plot values once on first update (to discover indices from logs)
      if (!debugDumped && latest) {
        debugDumped = true;
        const vals = [];
        for (let i = 0; i < 25; i++) vals.push(`[${i}]=${latest[i]}`);
        bLog(`[${sym}] PLOT DUMP (latest bar): ${vals.join(' ')}`);
      }

      // Reward Q-Learning from the previous trade (1 bar later)
      const pend = pending.get(sym);
      if (pend && priceLatest) {
        const curPx = priceLatest.close ?? 0;
        if (pend.entryPx > 0 && curPx > 0) {
          const pnl    = pend.direction === 'LONG'
            ? curPx - pend.entryPx
            : pend.entryPx - curPx;
          const reward = pnl > 0 ? 1 : -1;
          qUpdate(pend.key, pend.action, reward);
          bLog(`[${sym}] Q-update: dir=${pend.direction} reward=${reward} (entry=${pend.entryPx} close=${curPx})`);
        }
        pending.delete(sym);
      }

      // Run backtest once we have enough history
      if (!backtestDone && periods.length >= 200) {
        backtestDone = true;
        for (const dir of ['LONG', 'SHORT']) {
          const result = runBacktest(periods, pricePeriods, dir);
          if (!dynamicThreshold[sym]) dynamicThreshold[sym] = { long: 40, short: 40 };
          dynamicThreshold[sym][dir.toLowerCase()] = result.threshold;
          bLog(`[${sym}] Backtest ${dir}: threshold=${result.threshold}% winRate=${
            result.winRate != null ? (result.winRate * 100).toFixed(1) + '%' : 'n/a'
          } (${result.trades} signals in ${periods.length} bars)`);
        }
      }

      // Check signals on latest bar
      const sigLong  = latest[IDX.sigLong];
      const sigShort = latest[IDX.sigShort];

      // Extract AI feature state
      const probL   = latest[IDX.probLong]  ?? 50;
      const probS   = latest[IDX.probShort] ?? 50;
      const smcL    = Math.round(latest[IDX.smcL]  ?? 0);
      const smcS    = Math.round(latest[IDX.smcS]  ?? 0);
      const liqL    = Math.round(latest[IDX.liqL]  ?? 0);
      const liqS    = Math.round(latest[IDX.liqS]  ?? 0);
      const obL     = Math.round(latest[IDX.obL]   ?? 0);
      const obS     = Math.round(latest[IDX.obS]   ?? 0);
      const wtL     = Math.round(latest[IDX.wtL]   ?? 0);
      const wtS     = Math.round(latest[IDX.wtS]   ?? 0);
      const trail   = Math.round(latest[IDX.trailDir] ?? 0);
      const price   = priceLatest?.close ?? 0;

      let direction = null;
      let features  = null;

      // Primary: use Pine Script signal if it fired
      // Fallback: fire directly on probability — bypasses Pine's strict MTF gate
      if (sigLong === 1 || (probL > probS && probL >= 15)) {
        direction = 'LONG';
        features  = { prob: probL, smc: smcL, liq: liqL, ob: obL, wt: wtL, trail };
      } else if (sigShort === 1 || (probS > probL && probS >= 15)) {
        direction = 'SHORT';
        features  = { prob: probS, smc: smcS, liq: liqS, ob: obS, wt: wtS, trail: -trail };
      }

      if (!direction) { lastSignal = null; return; }
      if (direction === lastSignal) return;  // same bar, don't double-fire
      if (!canTrade(sym, direction)) return;

      const threshold = getThreshold(sym, direction);
      const prob      = features.prob;

      bLog(`[${sym}][${timeframe}m] Signal ${direction} — prob=${prob}% threshold=${threshold}% smc=${features.smc} liq=${features.liq} ob=${features.ob} wt=${features.wt} trail=${features.trail}`);

      // Q-Learning decides whether to act
      const key    = stateKey(features);
      const action = qAction(key);

      if (prob < threshold) {
        bLog(`[${sym}] Skipped (prob ${prob}% < threshold ${threshold}%)`);
        qUpdate(key, action, -0.5);  // mild negative for low-prob skip
        return;
      }

      if (action === 0) {
        bLog(`[${sym}] Q-Learning said SKIP (epsilon=${EPSILON.toFixed(3)})`);
        return;
      }

      lastSignal = direction;
      markTraded(sym, direction);

      // Remember for reward next bar
      pending.set(sym, { key, action, direction, entryPx: price });

      bLog(`[${sym}][${timeframe}m] *** TRADING ${direction} price=${price} prob=${prob}% ***`);

      injectTVSignal({
        symbol:             sym,
        side:               direction === 'LONG' ? 'BUY' : 'SELL',
        direction,
        price,
        zone:               'SMC_PRO',
        pivot:              'SMC_PRO',
        setup:              'SMC_PRO_SUITE',
        setupName:          `SMC Pro Suite (${timeframe}m)`,
        score:              prob,
        signalType:         `SMC-PRO-${direction}-${timeframe}M`,
        source:             'smc-suite-watcher',
        timeframe,
        isMomentumBreakout: true,
        override:           true,
        receivedAt:         Date.now(),
        // AI metadata for the Q-Learning coordinator
        aiFeatures: {
          probLong:  probL, probShort: probS,
          smcL, smcS, liqL, liqS, obL, obS, wtL, wtS, trail,
          threshold,
          qEpsilon: parseFloat(EPSILON.toFixed(4)),
        },
      });

    } catch (err) {
      bLog(`[${sym}][${timeframe}m] onUpdate error: ${err.message}`);
    }
  });

  // Reset lastSignal each new bar
  chart.onUpdate(() => { lastSignal = null; });
}

async function start() {
  bLog('Starting — watching BTCUSDT, ETHUSDT, SOLUSDT via TradingView WebSocket');
  bLog(`Initial IDX map: sigLong=${IDX.sigLong} sigShort=${IDX.sigShort} probLong=${IDX.probLong} probShort=${IDX.probShort}`);

  // Run 1m backtests first (in parallel across all symbols)
  bLog('Running 1m backtests before going live...');
  await Promise.allSettled(SYMBOLS.map(sym => runFullBacktest(sym)));
  bLog('Backtests complete — starting live watchers');

  for (const sym of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      watchSymbol(sym, tf).catch(err =>
        bLog(`Fatal error for ${sym}[${tf}m]: ${err.message}`)
      );
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start };
