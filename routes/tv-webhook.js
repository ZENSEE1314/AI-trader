const express = require('express');
const { injectTVSignal } = require('../cycle');
const smc = require('../smc-engine');
const msob = require('../strategy-ms-ob-vwap');

const router = express.Router();

// Allowed symbols — only accept signals for active trading pairs.
const ALLOWED_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT']);

// Bybit kline interval codes.
const TF = { h1: '60', h4: '240', m15: '15', m1: '1' };

// POST /api/tv-webhook
// DISABLED — all signals now flow exclusively through SMCPatternAgent (4-step rule).
// TV webhooks bypassed the 4H trend gate and structure checks, firing wrong trades.
// To re-enable, restore the injectTVSignal() call below and remove the early return.
//
// Required fields:
//   secret, symbol, direction, price
//
// Optional fields:
//   override       — true = bypass ALL gates (user is 100% confident)
//   zone           — VWAP zone from TV (UPPER_MID, ABOVE_UPPER, LOWER_MID, BELOW_LOWER)
//   pivot_15m      — 15m pivot type (HH, HL, LH, LL)
//   pivot_1m       — 1m pivot type  (HH, HL, LH, LL)
//   ema200Bias     — 'bullish' | 'bearish' | null
//   reason         — user's note (e.g. "LH at supply + shooting star")
//   hommaPatterns  — comma-separated pattern names from TV
//   volumeOk       — true if TV shows volume spike
//
// Response: { ok, mode, message, signal }
//
// POST /api/tv-webhook
// A TradingView alert (e.g. from the LuxAlgo Market-Structure dashboard) POSTs
// here as a TRIGGER. The bot then computes the MS-OB-VWAP short setup itself
// (HH/LH on 1H/4H → 15m/1m confirm → SHORT near VWAP upper band → TP at the
// nearest green order block, skip if a red OB is nearer) and, if valid,
// auto-executes. The alert only needs { symbol, secret }.
//
// Gated: OFF unless MSOB_ENABLED=1. If TV_WEBHOOK_SECRET is set, the alert must
// include a matching `secret`. Backtest before enabling on a live book.
router.post('/', async (req, res) => {
  try {
    if (process.env.MSOB_ENABLED !== '1') {
      return res.json({ ok: false, message: 'MS-OB-VWAP strategy disabled — set MSOB_ENABLED=1 to enable' });
    }
    const { symbol, secret } = req.body || {};

    const wantSecret = process.env.TV_WEBHOOK_SECRET || '';
    if (wantSecret && secret !== wantSecret) {
      return res.status(401).json({ ok: false, error: 'bad secret' });
    }

    const sym = (symbol || '').replace(/.*:/, '').toUpperCase().replace(/[^A-Z]/g, '').replace('USDTP', 'USDT');
    if (!ALLOWED_SYMBOLS.has(sym)) {
      return res.status(400).json({ ok: false, error: `Symbol ${sym} not in active list` });
    }

    // Fetch the timeframes the strategy needs.
    let c1h, c4h, c15, c1m;
    try {
      [c1h, c4h, c15, c1m] = await Promise.all([
        smc.fetchCandles(sym, TF.h1, 120),
        smc.fetchCandles(sym, TF.h4, 120),
        smc.fetchCandles(sym, TF.m15, 200),
        smc.fetchCandles(sym, TF.m1, 120),
      ]);
    } catch (e) {
      return res.status(502).json({ ok: false, error: `kline fetch failed: ${e.message}` });
    }

    const setup = msob.evaluate({ symbol: sym, c1h, c4h, c15, c1m });
    if (!setup.take) {
      console.log(`[MSOB] ${sym} no trade — ${setup.reason}`);
      return res.json({ ok: true, taken: false, reason: setup.reason });
    }

    // Auto-execute: queue a SHORT with TP at the green OB and SL above structure.
    const signal = {
      symbol: sym,
      side: 'SELL',
      direction: 'SHORT',
      price: setup.entry,
      sl: setup.sl,
      tp1: setup.tp,
      zone: 'MSOB_VWAP_UPPER',
      setup: 'MSOB_VWAP',
      setupName: 'MS-OB-VWAP',
      score: 999,
      signalType: 'MSOB-SHORT',
      source: 'msob',
      reason: setup.reason,
      override: true, // strategy already ran full structure/OB/VWAP validation
      receivedAt: Date.now(),
    };
    injectTVSignal(signal);
    console.log(`[MSOB] ✅ ${sym} SHORT queued @ ${setup.entry} | TP ${setup.tp} | SL ${setup.sl.toFixed(4)} | RR ${setup.rr} — ${setup.reason}`);

    res.json({ ok: true, taken: true, signal: { symbol: sym, direction: 'SHORT', entry: setup.entry, tp: setup.tp, sl: setup.sl, rr: setup.rr }, reason: setup.reason });
  } catch (e) {
    console.error('[MSOB webhook] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tv-webhook/dry-run
// Same validation as real webhook, but does NOT queue the signal.
// Use this to test your TradingView alert message format safely.
router.post('/dry-run', (req, res) => {
  const {
    symbol, direction, price,
    override, zone, pivot_15m, pivot_1m,
    ema200Bias, reason, hommaPatterns, volumeOk
  } = req.body || {};

  const sym = (symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!ALLOWED_SYMBOLS.has(sym)) {
    return res.status(400).json({ ok: false, error: `Symbol ${sym} not allowed` });
  }

  if (direction !== 'LONG' && direction !== 'SHORT') {
    return res.status(400).json({ ok: false, error: 'direction must be LONG or SHORT' });
  }

  const entryPrice = parseFloat(price);
  if (!entryPrice || entryPrice <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid price' });
  }

  const isOverride = override === true || override === 'true';
  const mode = isOverride ? 'OVERRIDE' : 'VALIDATED';

  return res.json({
    ok: true,
    mode,
    dryRun: true,
    wouldQueue: true,
    signal: {
      symbol: sym,
      direction,
      price: entryPrice,
      zone: zone || 'TV',
      pivot: `${pivot_15m || '?'}+${pivot_1m || '?'}`,
      override: isOverride,
      ema200Bias: ema200Bias || null,
      hommaPatterns: hommaPatterns || null,
      volumeOk: volumeOk === true || volumeOk === 'true',
      reason: reason || '',
    },
    gates: {
      ema200: isOverride ? 'BYPASSED' : ema200Bias ? `CHECK: ${ema200Bias}` : 'CHECK: live',
      adx: isOverride ? 'BYPASSED' : 'CHECK: live',
      structure: isOverride ? 'BYPASSED' : 'CHECK: live',
      volume: isOverride ? 'BYPASSED' : volumeOk ? 'PASSED (TV confirmed)' : 'CHECK: live',
    },
    message: `Dry-run OK — ${sym} ${direction} would be queued as ${mode}`
  });
});

// GET /api/tv-webhook/help
// Returns the expected payload format for TradingView alert messages.
router.get('/help', (req, res) => {
  res.json({
    description: 'MS-OB-VWAP trigger webhook. The alert is only a trigger — the bot computes the setup (HH/LH on 1H/4H → 15m/1m confirm → SHORT near VWAP upper band → TP at nearest green order block, skip if a red OB is nearer) and auto-executes if valid.',
    method: 'POST',
    url: '/api/tv-webhook',
    headers: { 'Content-Type': 'application/json' },
    payload: {
      symbol: '{{ticker}}',   // e.g. BITUNIX:ETHUSDT.P — normalised to ETHUSDT
      secret: '<TV_WEBHOOK_SECRET>'
    },
    enable: 'set MSOB_ENABLED=1 (and optionally TV_WEBHOOK_SECRET) in the environment',
    tuning: {
      MSOB_VWAP_K: 'upper-band std-dev multiple (default 2)',
      MSOB_VWAP_PROX_PCT: 'how near the upper band counts as "near" (default 0.15%)',
      MSOB_MIN_RR: 'minimum reward:risk to take (default 1.2)',
      MSOB_SL_BUF_PCT: 'stop buffer above structure high / band (default 0.1%)'
    },
    notes: [
      'Direction is always SHORT (fade the VWAP upper band) per the current spec',
      'Response: { ok, taken, reason } — taken=false with a reason when a rule blocks it',
      'Symbols: BTCUSDT / ETHUSDT / BNBUSDT / SOLUSDT'
    ]
  });
});

// POST /api/tv-webhook/smc-pro
// Dedicated endpoint for SMC Pro Suite Pine Script signals.
// Uses `signal` field (LONG/SHORT) and sets override=true so the signal
// bypasses the old internal gates — SMC Pro Suite already ran 6-factor
// confluence analysis before firing, so no second-guessing needed.
router.post('/smc-pro', (req, res) => {
  return res.json({ ok: false, message: 'SMC Pro webhook disabled - only SMC Expo watcher may trade' });

  const { signal, symbol = 'BTCUSDT', price, secret } = req.body || {};

  // Normalise ticker — TradingView sends "BITUNIX:BTCUSDT.P"
  const sym = (symbol || '').replace(/.*:/, '').replace(/[^A-Z]/g, '').replace('USDTP', 'USDT');

  if (!ALLOWED_SYMBOLS.has(sym)) {
    return res.status(400).json({ error: `Symbol ${sym} not in active list` });
  }

  const direction = (signal || '').toUpperCase();
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return res.status(400).json({ error: 'signal must be LONG or SHORT' });
  }

  const entryPrice = parseFloat(price);
  if (!entryPrice || entryPrice <= 0) {
    return res.status(400).json({ error: 'Invalid price' });
  }

  const tvSignal = {
    symbol:        sym,
    side:          direction === 'LONG' ? 'BUY' : 'SELL',
    direction,
    price:         entryPrice,
    zone:          'SMC_PRO',
    pivot:         'SMC_PRO',
    setup:         'SMC_PRO_SUITE',
    setupName:     'SMC Pro Suite',
    score:         999,
    signalType:    `SMC-PRO-${direction}`,
    source:        'smc-pro-suite',
    isMomentumBreakout: true,  // override all internal gates
    override:      true,
    receivedAt:    Date.now(),
  };

  injectTVSignal(tvSignal);

  console.log(`[SMC-Pro-Suite] ${sym} ${direction} @ ${entryPrice}`);
  res.json({ ok: true, action: direction, symbol: sym, price: entryPrice });
});

module.exports = router;
