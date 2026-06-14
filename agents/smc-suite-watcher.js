'use strict';

// MTF SMC strategy (Luxalgo convention):
//   15m LH (lower high) → bearish bias → 1m LH or HH + next bearish candle → SHORT
//   15m HL (higher low) → bullish bias → 1m HL or LL + next bullish candle → LONG
//
// Structure labels match Luxalgo:
//   HH = higher high (bullish continuation)
//   LH = lower high  (bearish structure)
//   HL = higher low  (bullish structure)
//   LL = lower low   (bearish continuation)
//
// Pine plot indices (verified against SMC-Pro-Suite.pine):
//   0-4  : VWAP bands
//   5    : plotshape HH
//   6    : plotshape LL
//   7    : Smart Trail
//   8    : sig_long   (original signal — not used)
//   9    : sig_short  (original signal — not used)
//   10   : prob_long
//   11   : prob_short
//   12-13: smc_l / smc_s
//   14-15: liq_l / liq_s
//   16-17: ob_l / ob_s
//   18-19: wt_l / wt_s
//   20   : trail_dir
//   21   : lh_raw  ← LH pivot confirmed
//   22   : hl_raw  ← HL pivot confirmed
//   23   : hh_raw  ← HH pivot confirmed
//   24   : ll_raw  ← LL pivot confirmed

const TradingView = require('@mathieuc/tradingview');
const { injectTVSignal } = require('../cycle');

const bLog = (...a) => console.log('[SMC-Watcher]', ...a);

// ── Config ───────────────────────────────────────────────────────
const SYMBOLS        = ['BITUNIX:BTCUSDT.P', 'BITUNIX:ETHUSDT.P', 'BITUNIX:SOLUSDT.P'];
const HISTORY_BARS   = 500;
const COOLDOWN_MS    = 30 * 60 * 1000;   // 30 min per symbol per direction
const BIAS_TTL_MS    = 4 * 60 * 60 * 1000; // 15m bias expires after 4 hours
const BIAS_LOOKBACK  = 4;                // scan last 4 × 15m bars on startup (~1 hour)
const SCRIPT_ID      = 'USER;5c16ebbf6afb4746a8fc0b693cc3a834';

// Money management (backtest-optimised: 66% WR, +150% return)
const TRADE_SIZE_PCT = 0.10;
const SL_PCT         = 0.50;
const TP_PCT         = 0.60;

// Plot indices
const IDX = {
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
  lhRaw:     21,  // LH confirmed → SHORT signal
  hlRaw:     22,  // HL confirmed → LONG  signal
  hhRaw:     23,  // HH confirmed → SHORT sweep (needs next bearish candle)
  llRaw:     24,  // LL confirmed → LONG  sweep (needs next bullish candle)
};

// ── Q-Learning ───────────────────────────────────────────────────
const Q_TABLE = {};
const ALPHA   = 0.1;
const GAMMA   = 0.9;
let   EPSILON = 0.3;

function stateKey(f) {
  return `${Math.floor(f.prob / 20) * 20}|${f.smc}|${f.liq}|${f.ob}|${f.wt}|${f.trail}`;
}
function qValues(k)           { if (!Q_TABLE[k]) Q_TABLE[k] = [0, 0]; return Q_TABLE[k]; }
function qAction(k)           { const q = qValues(k); return Math.random() < EPSILON ? (Math.random() < 0.5 ? 0 : 1) : (q[1] >= q[0] ? 1 : 0); }
function qUpdate(k, a, r)     { const q = qValues(k); q[a] += ALPHA * (r + GAMMA * Math.max(...q) - q[a]); EPSILON = Math.max(0.05, EPSILON * 0.9995); }

<<<<<<< Updated upstream
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
=======
// ── Shared state ─────────────────────────────────────────────────
// bias[sym] = { direction:'LONG'|'SHORT', setAt:ms } | null
const biasMap   = {};
>>>>>>> Stashed changes
const cooldowns = new Map();
const qPending  = new Map();  // sym → { key, action, direction, entryPx }

function canTrade(sym, dir) { return Date.now() - (cooldowns.get(`${sym}:${dir}`) || 0) > COOLDOWN_MS; }
function markTraded(sym, dir) { cooldowns.set(`${sym}:${dir}`, Date.now()); }
function normSym(tv)          { return tv.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT'); }
function biasAlive(sym)       { const b = biasMap[sym]; return b && Date.now() - b.setAt < BIAS_TTL_MS ? b : null; }

// ── Indicator loader (shared) ────────────────────────────────────
async function loadIndicator() {
  return TradingView.getIndicator(
    SCRIPT_ID, 'last',
    process.env.TV_SESSION || '', process.env.TV_SESSION_SIGN || '',
  );
}

// ── 15m watcher — reads LH/HL, sets bias ─────────────────────────
async function watch15m(tvTicker) {
  const sym = normSym(tvTicker);
  bLog(`[${sym}][15m] Starting`);

  const client = new TradingView.Client();
  client.onError((...e) => {
    bLog(`[${sym}][15m] TV error — reconnect 30s: ${e.join(' ')}`);
    client.end();
    setTimeout(() => watch15m(tvTicker), 30_000);
  });

  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: '15', range: HISTORY_BARS });

  let ind;
  try   { ind = await loadIndicator(); }
  catch (e) {
    bLog(`[${sym}][15m] Indicator load failed: ${e.message} — retry 60s`);
    client.end();
    setTimeout(() => watch15m(tvTicker), 60_000);
    return;
  }

  const pine        = new chart.Study(ind);
  let   startupDone = false;
  let   debugDumped = false;

  pine.onUpdate(() => {
    try {
      const periods = pine.periods;
      if (!periods || periods.length < 2) return;
      const n      = periods.length;
      const latest = periods[n - 1];

      // Dump plot values once to verify indices
      if (!debugDumped) {
        debugDumped = true;
        const vals = Array.from({ length: 27 }, (_, i) => `[${i}]=${latest[i]}`);
        bLog(`[${sym}][15m] PLOT DUMP: ${vals.join(' ')}`);
      }

      // Startup: scan last BIAS_LOOKBACK bars for a recent LH/HL we missed
      if (!startupDone && n >= BIAS_LOOKBACK + 1) {
        startupDone = true;
        for (let i = n - 2; i >= Math.max(0, n - 1 - BIAS_LOOKBACK); i--) {
          const b = periods[i];
          if (!b) continue;
          if (b[IDX.lhRaw] === 1) {
            biasMap[sym] = { direction: 'SHORT', setAt: Date.now() };
            bLog(`[${sym}][15m] STARTUP recovered LH → bias=SHORT`);
            break;
          }
          if (b[IDX.hlRaw] === 1) {
            biasMap[sym] = { direction: 'LONG', setAt: Date.now() };
            bLog(`[${sym}][15m] STARTUP recovered HL → bias=LONG`);
            break;
          }
        }
        if (!biasMap[sym]) bLog(`[${sym}][15m] STARTUP: no recent LH/HL in last ${BIAS_LOOKBACK} bars`);
      }

      // Live: set bias on each new LH/HL
      const lh = latest[IDX.lhRaw] === 1;
      const hl = latest[IDX.hlRaw] === 1;
      if (!lh && !hl) return;

      const dir = lh ? 'SHORT' : 'LONG';
      biasMap[sym] = { direction: dir, setAt: Date.now() };
      bLog(`[${sym}][15m] ${lh ? 'LH' : 'HL'} confirmed → bias=${dir}`);
    } catch (e) {
      bLog(`[${sym}][15m] error: ${e.message}`);
    }
  });
}

// ── 1m watcher — confirms entry when bias matches ────────────────
async function watch1m(tvTicker) {
  const sym = normSym(tvTicker);
  bLog(`[${sym}][1m] Starting`);

  const client = new TradingView.Client();
  client.onError((...e) => {
    bLog(`[${sym}][1m] TV error — reconnect 30s: ${e.join(' ')}`);
    client.end();
    setTimeout(() => watch1m(tvTicker), 30_000);
  });

  const chart = new client.Session.Chart();
  chart.setMarket(tvTicker, { timeframe: '1', range: 500 });

  let ind;
  try   { ind = await loadIndicator(); }
  catch (e) {
    bLog(`[${sym}][1m] Indicator load failed: ${e.message} — retry 60s`);
    client.end();
    setTimeout(() => watch1m(tvTicker), 60_000);
    return;
  }

  const pine = new chart.Study(ind);
  let pending     = null;  // { direction, trigger, setOnBar } — HH/LL sweep waiting for next candle
  let debugDumped = false;
  let barCount    = 0;

  pine.onUpdate(() => {
    try {
      const periods      = pine.periods;
      const pricePeriods = chart.periods;
      if (!periods || periods.length < 2) return;

      barCount = pricePeriods?.length ?? 0;
      const latest      = periods[periods.length - 1];
      const priceLatest = pricePeriods?.[barCount - 1];

      if (!debugDumped) {
        debugDumped = true;
        const vals = Array.from({ length: 27 }, (_, i) => `[${i}]=${latest[i]}`);
        bLog(`[${sym}][1m] PLOT DUMP: ${vals.join(' ')}`);
      }

      // ── Resolve pending HH/LL sweep — needs next bearish/bullish candle ──
      if (pending && barCount > pending.setOnBar) {
        const isBull = priceLatest?.close > priceLatest?.open;
        const isBear = priceLatest?.close < priceLatest?.open;
        const ok     = (pending.direction === 'SHORT' && isBear)
                    || (pending.direction === 'LONG'  && isBull);

        if (barCount > pending.setOnBar + 3) {
          bLog(`[${sym}][1m] ${pending.direction} ${pending.trigger} sweep expired`);
          pending = null;
        } else if (ok) {
          const { direction, trigger } = pending;
          pending = null;
          executeTrade(direction, trigger, latest, priceLatest);
        }
<<<<<<< Updated upstream
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

      // ── 4-step SMC rule ──────────────────────────────────────────
      // Step 1+2 (15m): indicator fires sig_long/sig_short at the exact HL/LH bar
      //                 → arm _tf15mStructure immediately (no pivot-lag)
      // Step 3   (1m):  price-based LH/HL pivot in same direction gates on 15m state
      // Step 4   (1m):  next candle confirms direction → trade fires

      if (timeframe === '15') {
        // Use the indicator's own signal — fires at the correct bar with no lag
        const sigL = latest[IDX.sigLong]  === 1;
        const sigS = latest[IDX.sigShort] === 1;
        if (sigL) {
          const feats = { prob: probL || 50, smc: smcL, liq: liqL, ob: obL, wt: wtL, trail };
          _tf15mStructure.set(sym, { direction: 'LONG', detectedAt: Date.now(), features: feats });
          bLog(`[${sym}][15m] sig_long fired → LONG structure armed, waiting for 1m HL`);
        }
        if (sigS) {
          const feats = { prob: probS || 50, smc: smcS, liq: liqS, ob: obS, wt: wtS, trail: -trail };
          _tf15mStructure.set(sym, { direction: 'SHORT', detectedAt: Date.now(), features: feats });
          bLog(`[${sym}][15m] sig_short fired → SHORT structure armed, waiting for 1m LH`);
        }
        return; // 15m never fires trades directly
      }

      // 1m watcher: price-based LH/HL pivot detection, gated on 15m structure
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

        if (isPivHigh) {
          if (lastPivotHigh && pivBar.high < lastPivotHigh.price) {
            const tf15m = _tf15mStructure.get(sym);
            if (tf15m && tf15m.direction === 'SHORT' && Date.now() - tf15m.detectedAt < TF15M_EXPIRY_MS) {
              pendingEntry = { direction: 'SHORT', setOnBarIdx: n, features: tf15m.features };
              bLog(`[${sym}][1m] 1m LH ✓ + 15m SHORT ✓ → SHORT pending (waiting next candle)`);
            } else {
              bLog(`[${sym}][1m] 1m LH — no matching 15m SHORT structure, skipping`);
            }
          }
          lastPivotHigh = { price: pivBar.high, barIdx: pivIdx };
        }

        if (isPivLow) {
          if (lastPivotLow && pivBar.low > lastPivotLow.price) {
            const tf15m = _tf15mStructure.get(sym);
            if (tf15m && tf15m.direction === 'LONG' && Date.now() - tf15m.detectedAt < TF15M_EXPIRY_MS) {
              pendingEntry = { direction: 'LONG', setOnBarIdx: n, features: tf15m.features };
              bLog(`[${sym}][1m] 1m HL ✓ + 15m LONG ✓ → LONG pending (waiting next candle)`);
            } else {
              bLog(`[${sym}][1m] 1m HL — no matching 15m LONG structure, skipping`);
            }
          }
          lastPivotLow = { price: pivBar.low, barIdx: pivIdx };
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
=======
>>>>>>> Stashed changes
        return;
      }

      // ── Check 15m bias ────────────────────────────────────────────
      const b = biasAlive(sym);
      if (!b) return;

      const lh = latest[IDX.lhRaw] === 1;
      const hl = latest[IDX.hlRaw] === 1;
      const hh = latest[IDX.hhRaw] === 1;
      const ll = latest[IDX.llRaw] === 1;

<<<<<<< Updated upstream
      if (!canTrade(sym, direction)) return;

      bLog(`[${sym}][1m] *** TRADING ${direction} price=${price} — 15m+1m SMC structure confirmed ***`);
=======
      // All patterns arm a pending entry — fire on the NEXT confirming candle
      if (b.direction === 'SHORT' && (lh || hh)) {
        const trigger = lh ? 'LH' : 'HH';
        bLog(`[${sym}][1m] ${trigger} detected (bias=SHORT) — waiting next bearish candle`);
        pending = { direction: 'SHORT', trigger, setOnBar: barCount };
      } else if (b.direction === 'LONG' && (hl || ll)) {
        const trigger = hl ? 'HL' : 'LL';
        bLog(`[${sym}][1m] ${trigger} detected (bias=LONG) — waiting next bullish candle`);
        pending = { direction: 'LONG', trigger, setOnBar: barCount };
      }
>>>>>>> Stashed changes

      function executeTrade(direction, trigger, bar, priceBar) {
        if (!canTrade(sym, direction)) {
          bLog(`[${sym}][1m] ${direction} (${trigger}) — cooldown, skip`);
          return;
        }

<<<<<<< Updated upstream
      // Q-Learning reward bookkeeping (still records outcome for future learning)
      const key = stateKey(features);
      pending.set(sym + timeframe, { key, action: 1, direction, entryPx: price });

      injectTVSignal({
        symbol:             sym,
        side:               direction === 'LONG' ? 'BUY' : 'SELL',
        direction,
        price,
        zone:               'SMC_PRO',
        pivot:              'LH_HL',
        setup:              'SMC_PRO_SUITE',
        setupName:          `SMC LH/HL (${timeframe}m)`,
        score:              features.prob,
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
=======
        const price = priceBar?.close ?? 0;
        if (price <= 0) return;

        const isLong = direction === 'LONG';
        const prob   = bar[isLong ? IDX.probLong  : IDX.probShort]  ?? 50;
        const smc    = Math.round(bar[isLong ? IDX.smcL   : IDX.smcS]   ?? 0);
        const liq    = Math.round(bar[isLong ? IDX.liqL   : IDX.liqS]   ?? 0);
        const ob     = Math.round(bar[isLong ? IDX.obL    : IDX.obS]    ?? 0);
        const wt     = Math.round(bar[isLong ? IDX.wtL    : IDX.wtS]    ?? 0);
        const trail  = Math.round(bar[IDX.trailDir] ?? 0);
        const feats  = { prob, smc, liq, ob, wt, trail: isLong ? trail : -trail };

        // Q-Learning reward for previous trade
        const qp = qPending.get(sym);
        if (qp && qp.entryPx > 0) {
          const pnl = qp.direction === 'LONG' ? price - qp.entryPx : qp.entryPx - price;
          qUpdate(qp.key, qp.action, pnl > 0 ? 1 : -1);
          bLog(`[${sym}][1m] Q-reward: ${qp.direction} ${pnl > 0 ? 'WIN' : 'LOSS'}`);
          qPending.delete(sym);
        }
>>>>>>> Stashed changes

        const key    = stateKey(feats);
        const action = qAction(key);
        if (action === 0) {
          bLog(`[${sym}][1m] Q-Learning SKIP (ε=${EPSILON.toFixed(3)})`);
          return;
        }

        markTraded(sym, direction);
        qPending.set(sym, { key, action, direction, entryPx: price });

        bLog(`[${sym}][1m] *** TRADE ${direction} | trigger=${trigger} | price=${price} | prob=${prob}% | bias=${biasMap[sym]?.direction} ***`);

        injectTVSignal({
          symbol:             sym,
          side:               isLong ? 'BUY' : 'SELL',
          direction,
          price,
          zone:               'SMC_PRO',
          pivot:              trigger,
          setup:              'SMC_PRO_SUITE',
          setupName:          `${trigger} (1m entry, 15m bias)`,
          score:              prob,
          signalType:         `SMC-MTF-${direction}`,
          source:             'smc-suite-watcher',
          timeframe:          '1',
          isMomentumBreakout: true,
          override:           true,
          receivedAt:         Date.now(),
          tradeSizePct:       TRADE_SIZE_PCT,
          slPct:              SL_PCT,
          tpPct:              TP_PCT,
          aiFeatures: { prob, smc, liq, ob, wt, trail, qEpsilon: parseFloat(EPSILON.toFixed(4)) },
        });
      }

    } catch (e) {
      bLog(`[${sym}][1m] error: ${e.message}`);
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────
async function start() {
  bLog('Starting MTF watcher (15m bias → 1m entry)');
  bLog(`Plot indices: lhRaw=${IDX.lhRaw} hlRaw=${IDX.hlRaw} hhRaw=${IDX.hhRaw} llRaw=${IDX.llRaw}`);

  for (const sym of SYMBOLS) {
    watch15m(sym).catch(e => bLog(`[15m fatal] ${sym}: ${e.message}`));
    await new Promise(r => setTimeout(r, 2000));
    watch1m(sym).catch(e => bLog(`[1m fatal] ${sym}: ${e.message}`));
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (require.main === module) start().catch(console.error);
module.exports = { start };
