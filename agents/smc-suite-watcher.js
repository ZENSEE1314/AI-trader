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

// ── Cross-TF state: 15m structure must be confirmed before 1m can trade ──
// Step 1+2: 15m LH (SHORT) or HL (LONG) detected → stored here
// Step 3:   1m LH/HL in same direction → pendingEntry armed
// Step 4:   next 1m candle confirms direction → trade fires
const _tf15mStructure = new Map();  // sym → { direction, detectedAt, features }
const TF15M_EXPIRY_MS = 4 * 60 * 60 * 1000;  // 4h — discard stale 15m structure

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

  // Pivot tracking for LH/HL detection
  let lastPivotHigh   = null;  // { price, barIdx }
  let lastPivotLow    = null;  // { price, barIdx }
  let pendingEntry    = null;  // { direction, setOnBarIdx, features } — fires on next confirming candle
  const PIVOT_LEN     = 3;    // bars each side for pivot detection

  pine.onUpdate(() => {
    try {
      const periods      = pine.periods;
      const pricePeriods = chart.periods;
      if (!periods || periods.length < 2) return;

      const latest      = periods[periods.length - 1];
      const priceLatest = pricePeriods?.[pricePeriods.length - 1];
      const n           = pricePeriods?.length ?? 0;

      // Dump plot indices once on first update
      if (!debugDumped && latest) {
        debugDumped = true;
        const vals = [];
        for (let i = 0; i < 25; i++) vals.push(`[${i}]=${latest[i]}`);
        bLog(`[${sym}][${timeframe}m] PLOT DUMP: ${vals.join(' ')}`);
      }

      // Q-Learning reward from previous trade (1 bar later)
      const pend = pending.get(sym + timeframe);
      if (pend && priceLatest) {
        const curPx = priceLatest.close ?? 0;
        if (pend.entryPx > 0 && curPx > 0) {
          const pnl    = pend.direction === 'LONG' ? curPx - pend.entryPx : pend.entryPx - curPx;
          const reward = pnl > 0 ? 1 : -1;
          qUpdate(pend.key, pend.action, reward);
          bLog(`[${sym}][${timeframe}m] Q-update: dir=${pend.direction} reward=${reward}`);
        }
        pending.delete(sym + timeframe);
      }

      if (n < PIVOT_LEN * 2 + 2) return;

      // Extract SMC feature state from Pine indicator for signal quality scoring
      const probL = latest[IDX.probLong]  ?? 0;
      const probS = latest[IDX.probShort] ?? 0;
      const smcL  = Math.round(latest[IDX.smcL]  ?? 0);
      const smcS  = Math.round(latest[IDX.smcS]  ?? 0);
      const liqL  = Math.round(latest[IDX.liqL]  ?? 0);
      const liqS  = Math.round(latest[IDX.liqS]  ?? 0);
      const obL   = Math.round(latest[IDX.obL]   ?? 0);
      const obS   = Math.round(latest[IDX.obS]   ?? 0);
      const wtL   = Math.round(latest[IDX.wtL]   ?? 0);
      const wtS   = Math.round(latest[IDX.wtS]   ?? 0);
      const trail = Math.round(latest[IDX.trailDir] ?? 0);
      const price = priceLatest?.close ?? 0;

      // ── Pivot detection: LH / HL on price data ──────────────────
      // 4-step rule:
      //   Step 1+2 (15m): detect LH → SHORT structure / HL → LONG structure
      //   Step 3   (1m):  detect LH/HL matching 15m direction → arm pending entry
      //   Step 4   (1m):  next candle confirms direction → fire trade
      const pivIdx = n - PIVOT_LEN - 1;
      const pivBar = pricePeriods[pivIdx];
      if (pivBar) {
        let isPivHigh = true, isPivLow = true;
        for (let i = pivIdx - PIVOT_LEN; i <= pivIdx + PIVOT_LEN; i++) {
          if (i === pivIdx) continue;
          const b = pricePeriods[i];
          if (!b) continue;
          if (b.high >= pivBar.high) isPivHigh = false;
          if (b.low  <= pivBar.low)  isPivLow  = false;
        }

        if (timeframe === '15') {
          // 15m watcher: confirm structure, store cross-TF state (no direct trade)
          if (isPivHigh) {
            if (lastPivotHigh && pivBar.high < lastPivotHigh.price) {
              const feats = { prob: probS || 50, smc: smcS, liq: liqS, ob: obS, wt: wtS, trail: -trail };
              _tf15mStructure.set(sym, { direction: 'SHORT', detectedAt: Date.now(), features: feats });
              bLog(`[${sym}][15m] 15m LH confirmed (${lastPivotHigh.price.toFixed(2)} → ${pivBar.high.toFixed(2)}) — SHORT structure armed, waiting for 1m LH`);
            }
            lastPivotHigh = { price: pivBar.high, barIdx: pivIdx };
          }
          if (isPivLow) {
            if (lastPivotLow && pivBar.low > lastPivotLow.price) {
              const feats = { prob: probL || 50, smc: smcL, liq: liqL, ob: obL, wt: wtL, trail };
              _tf15mStructure.set(sym, { direction: 'LONG', detectedAt: Date.now(), features: feats });
              bLog(`[${sym}][15m] 15m HL confirmed (${lastPivotLow.price.toFixed(2)} → ${pivBar.low.toFixed(2)}) — LONG structure armed, waiting for 1m HL`);
            }
            lastPivotLow = { price: pivBar.low, barIdx: pivIdx };
          }
        } else {
          // 1m watcher: require matching 15m structure before arming entry
          if (isPivHigh) {
            if (lastPivotHigh && pivBar.high < lastPivotHigh.price) {
              const tf15m = _tf15mStructure.get(sym);
              if (tf15m && tf15m.direction === 'SHORT' && Date.now() - tf15m.detectedAt < TF15M_EXPIRY_MS) {
                const feats = { prob: tf15m.features.prob, smc: smcS, liq: liqS, ob: obS, wt: wtS, trail: -trail };
                pendingEntry = { direction: 'SHORT', setOnBarIdx: n, features: feats };
                bLog(`[${sym}][1m] 1m LH ✓ + 15m LH ✓ → SHORT pending (waiting next candle)`);
              } else {
                bLog(`[${sym}][1m] 1m LH detected — no matching 15m SHORT structure, skipping`);
              }
            }
            lastPivotHigh = { price: pivBar.high, barIdx: pivIdx };
          }
          if (isPivLow) {
            if (lastPivotLow && pivBar.low > lastPivotLow.price) {
              const tf15m = _tf15mStructure.get(sym);
              if (tf15m && tf15m.direction === 'LONG' && Date.now() - tf15m.detectedAt < TF15M_EXPIRY_MS) {
                const feats = { prob: tf15m.features.prob, smc: smcL, liq: liqL, ob: obL, wt: wtL, trail };
                pendingEntry = { direction: 'LONG', setOnBarIdx: n, features: feats };
                bLog(`[${sym}][1m] 1m HL ✓ + 15m HL ✓ → LONG pending (waiting next candle)`);
              } else {
                bLog(`[${sym}][1m] 1m HL detected — no matching 15m LONG structure, skipping`);
              }
            }
            lastPivotLow = { price: pivBar.low, barIdx: pivIdx };
          }
        }
      }

      // ── Next-candle confirmation ─────────────────────────────────
      if (!pendingEntry || n <= pendingEntry.setOnBarIdx) return;

      const confirmBar = priceLatest;
      if (!confirmBar) return;
      const isBearish  = confirmBar.close < confirmBar.open;
      const isBullish  = confirmBar.close > confirmBar.open;
      const confirmed  = (pendingEntry.direction === 'SHORT' && isBearish)
                      || (pendingEntry.direction === 'LONG'  && isBullish);

      // Cancel if no confirm within 3 bars
      if (n > pendingEntry.setOnBarIdx + 3) {
        bLog(`[${sym}][${timeframe}m] ${pendingEntry.direction} entry expired (no confirmation)`);
        pendingEntry = null;
        return;
      }

      if (!confirmed) return;

      const direction = pendingEntry.direction;
      const features  = pendingEntry.features;
      pendingEntry = null;

      if (!canTrade(sym, direction)) return;

      bLog(`[${sym}][${timeframe}m] Signal ${direction} — LH/HL + next-candle confirmed — prob=${features.prob}%`);

      // Q-Learning decides whether to act
      const key    = stateKey(features);
      const action = qAction(key);
      const prob   = features.prob;

      if (action === 0) {
        bLog(`[${sym}][${timeframe}m] Q-Learning said SKIP (epsilon=${EPSILON.toFixed(3)})`);
        return;
      }

      markTraded(sym, direction);

      // Remember for reward next bar
      pending.set(sym + timeframe, { key, action, direction, entryPx: price });

      bLog(`[${sym}][${timeframe}m] *** TRADING ${direction} price=${price} prob=${prob}% ***`);

      injectTVSignal({
        symbol:             sym,
        side:               direction === 'LONG' ? 'BUY' : 'SELL',
        direction,
        price,
        zone:               'SMC_PRO',
        pivot:              'LH_HL',
        setup:              'SMC_PRO_SUITE',
        setupName:          `SMC LH/HL (${timeframe}m)`,
        score:              prob,
        signalType:         `SMC-PRO-${direction}-${timeframe}M`,
        source:             'smc-suite-watcher',
        timeframe,
        isMomentumBreakout: true,
        override:           true,
        receivedAt:         Date.now(),
        // AI metadata for the Q-Learning coordinator
        aiFeatures: {
          probLong: features.prob, probShort: features.prob,
          smcL: features.smc, smcS: features.smc,
          liqL: features.liq, liqS: features.liq,
          obL: features.ob,   obS: features.ob,
          wtL: features.wt,   wtS: features.wt,
          trail: features.trail,
          qEpsilon: parseFloat(EPSILON.toFixed(4)),
        },
      });

    } catch (err) {
      bLog(`[${sym}][${timeframe}m] onUpdate error: ${err.message}`);
    }
  });
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
