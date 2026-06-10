'use strict';

// =============================================================
// SMC Pro Suite Watcher
//
// Connects to TradingView via WebSocket and reads the SMC Pro Suite
// indicator values in real-time. No webhook / no premium account needed.
//
// When SIGNAL flips to LONG or SHORT (probability >= threshold),
// it calls injectTVSignal() directly — same path as the webhook endpoint.
//
// Run standalone:  node agents/smc-suite-watcher.js
// Or required by server.js at startup alongside other agents.
// =============================================================

const TradingView = require('@mathieuc/tradingview');
const { injectTVSignal } = require('../cycle');
const bLog = (...args) => console.log('[SMC-Watcher]', ...args);

// ── Config ──────────────────────────────────────────────────
const SYMBOLS   = ['BITUNIX:BTCUSDT.P', 'BITUNIX:ETHUSDT.P', 'BITUNIX:SOLUSDT.P'];
const TIMEFRAME = '15';   // 15-minute bars — matches the chart you use

// Cooldown: don't fire the same direction twice within 4 hours
const COOLDOWN_MS = 4 * 60 * 60 * 1000;

// SMC Pro Suite script ID on TradingView (the published indicator)
// This is the script the bot polls. Must match the script on the chart.
const SCRIPT_ID = 'PUB;SMCProSuite';   // will be resolved dynamically below
// ────────────────────────────────────────────────────────────

const cooldowns = new Map();   // 'BTCUSDT:LONG' → lastFiredMs

function canTrade(sym, direction) {
  const key = `${sym}:${direction}`;
  const last = cooldowns.get(key) || 0;
  return Date.now() - last > COOLDOWN_MS;
}

function markTraded(sym, direction) {
  cooldowns.set(`${sym}:${direction}`, Date.now());
}

function normalizeSym(tvTicker) {
  // 'BITUNIX:BTCUSDT.P' → 'BTCUSDT'
  return tvTicker.replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT');
}

// ── Main watcher ─────────────────────────────────────────────
async function watchSymbol(tvTicker) {
  const sym = normalizeSym(tvTicker);
  bLog(`[SMC-Suite-Watcher] Starting watcher for ${sym} (${tvTicker})`);

  const client = new TradingView.Client();

  client.onError((...err) => {
    bLog(`[SMC-Suite-Watcher][${sym}] TV error: ${err.join(' ')} — reconnecting in 30s`);
    setTimeout(() => watchSymbol(tvTicker), 30_000);
  });

  const chart = new client.Session.Chart();

  chart.setMarket(tvTicker, {
    timeframe:      TIMEFRAME,
    range:          10,    // only need recent bars
    to:             undefined,
  });

  // Search for the SMC Pro Suite indicator by name then load it
  let indicator;
  try {
    const results = await TradingView.searchIndicator('SMC Pro Suite');
    bLog(`[SMC-Suite-Watcher][${sym}] Search returned ${results.length} results: ${results.slice(0,3).map(r=>`${r.name}(${r.access})`).join(', ')}`);
    const match = results.find(r =>
      r.name.toLowerCase().includes('smc pro suite')
    );

    if (!match) {
      bLog(`[SMC-Suite-Watcher][${sym}] Could not find "SMC Pro Suite" indicator on TradingView. ` +
           `Make sure it is saved as a published/private indicator on your account.`);
      client.end();
      setTimeout(() => watchSymbol(tvTicker), 120_000);
      return;
    }

    bLog(`[SMC-Suite-Watcher][${sym}] Found indicator: ${match.name} (${match.id})`);
    indicator = await match.get();
  } catch (err) {
    bLog(`[SMC-Suite-Watcher][${sym}] Failed to load indicator: ${err.message}`);
    client.end();
    setTimeout(() => watchSymbol(tvTicker), 60_000);
    return;
  }

  const pine = new chart.Study(indicator);

  let lastSignal = null;

  // Build a name→index map once the study metadata is available
  let sigLongIdx  = -1;
  let sigShortIdx = -1;
  pine.onReady(() => {
    const plots = pine.studyInputsInfo?.plots || pine.metaInfo?.plots || [];
    plots.forEach((p, i) => {
      if (p.id === 'sig_long'  || p.title === 'sig_long')  sigLongIdx  = i;
      if (p.id === 'sig_short' || p.title === 'sig_short') sigShortIdx = i;
    });
    bLog(`[SMC-Suite-Watcher][${sym}] Plot map: sig_long=${sigLongIdx} sig_short=${sigShortIdx}`);
  });

  pine.onUpdate(() => {
    try {
      const periods = pine.periods;
      if (!periods || periods.length === 0) return;

      const latest = periods[periods.length - 1];
      if (!latest) return;

      // Use named plot indices; fall back to legacy positions 2/3 if metadata not ready
      const lIdx = sigLongIdx  >= 0 ? sigLongIdx  : 2;
      const sIdx = sigShortIdx >= 0 ? sigShortIdx : 3;

      const sigLong  = latest[lIdx];
      const sigShort = latest[sIdx];

      const price = chart.periods?.[chart.periods.length - 1]?.close;

      // Detect signal — 1 on the bar the alert fires
      let direction = null;
      if (sigLong  === 1) direction = 'LONG';
      if (sigShort === 1) direction = 'SHORT';

      if (!direction) return;
      if (direction === lastSignal) return;   // same bar, don't double-fire
      if (!canTrade(sym, direction)) return;

      lastSignal = direction;
      markTraded(sym, direction);

      bLog(`[SMC-Suite-Watcher] *** ${sym} ${direction} signal! price=${price} ***`);

      injectTVSignal({
        symbol:             sym,
        side:               direction === 'LONG' ? 'BUY' : 'SELL',
        direction,
        price:              price || 0,
        zone:               'SMC_PRO',
        pivot:              'SMC_PRO',
        setup:              'SMC_PRO_SUITE',
        setupName:          'SMC Pro Suite',
        score:              999,
        signalType:         `SMC-PRO-${direction}`,
        source:             'smc-suite-watcher',
        isMomentumBreakout: true,
        override:           true,
        receivedAt:         Date.now(),
      });

    } catch (err) {
      bLog(`[SMC-Suite-Watcher][${sym}] onUpdate error: ${err.message}`);
    }
  });

  // Reset lastSignal each new bar so next bar can fire again
  chart.onUpdate(() => {
    lastSignal = null;
  });
}

// ── Entry ────────────────────────────────────────────────────
async function start() {
  bLog('[SMC-Suite-Watcher] Starting — watching BTCUSDT, ETHUSDT, SOLUSDT via TradingView WebSocket');
  for (const sym of SYMBOLS) {
    watchSymbol(sym).catch(err =>
      bLog(`[SMC-Suite-Watcher] Fatal error for ${sym}: ${err.message}`)
    );
    // Stagger connections slightly to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }
}

// If run standalone: node agents/smc-suite-watcher.js
if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start };
