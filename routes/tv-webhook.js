const express = require('express');
const { injectTVSignal } = require('../cycle');

const router = express.Router();

// Secret check removed per user request — no auth required

// Allowed symbols — only accept signals for active trading pairs.
const ALLOWED_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT']);

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
router.post('/', (req, res) => {
  const {
    symbol, direction, price,
    override, zone, pivot_15m, pivot_1m,
    ema200Bias, reason, hommaPatterns, volumeOk
  } = req.body || {};

  const sym = (symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!ALLOWED_SYMBOLS.has(sym)) {
    return res.status(400).json({ error: `Symbol ${sym} not in active list` });
  }

  if (direction !== 'LONG' && direction !== 'SHORT') {
    return res.status(400).json({ error: 'direction must be LONG or SHORT' });
  }

  const entryPrice = parseFloat(price);
  if (!entryPrice || entryPrice <= 0) {
    return res.status(400).json({ error: 'Invalid price' });
  }

  // DISABLED — SMCPatternAgent is the sole signal source
  return res.json({ ok: false, message: 'TV webhook disabled — signals flow through SMCPatternAgent only' });

  const isOverride = override === true || override === 'true';

  const signal = {
    symbol: sym,
    side: direction === 'LONG' ? 'BUY' : 'SELL',
    direction,
    price: entryPrice,
    zone: zone || 'TV',
    pivot: `${pivot_15m || '?'}+${pivot_1m || '?'}`,
    setup: isOverride ? 'TV_MANUAL_OVERRIDE' : 'TV_WEBHOOK',
    setupName: isOverride ? 'TV_MANUAL_OVERRIDE' : 'TV_WEBHOOK',
    score: 999, // TV signals always win dedup against internal signals
    signalType: `TV-${direction}`,
    source: 'tradingview',
    isMomentumBreakout: isOverride, // override = bypass EMA200 gate
    ema200Bias: ema200Bias || null,
    pivot_15m: pivot_15m || null,
    pivot_1m: pivot_1m || null,
    hommaPatterns: hommaPatterns || null,
    volumeOk: volumeOk === true || volumeOk === 'true',
    reason: reason || '',
    override: isOverride,
    receivedAt: Date.now(),
  };

  injectTVSignal(signal);

  const mode = isOverride ? 'OVERRIDE (bypasses all gates)' : 'VALIDATED (runs through SMC+Homma gates)';
  console.log(`[TV-Webhook] ✅ ${sym} ${direction} @ ${entryPrice} | mode=${mode} | zone=${zone} | 15m=${pivot_15m} | 1m=${pivot_1m} | reason=${reason || 'n/a'}`);

  res.json({
    ok: true,
    mode,
    message: `${sym} ${direction} queued — ${mode}`,
    signal: `${sym} ${direction} @ ${entryPrice}`
  });
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
    description: 'TradingView webhook endpoint for manual trade signals',
    method: 'POST',
    url: '/api/tv-webhook',
    headers: { 'Content-Type': 'application/json' },
    payload: {
      symbol: 'BTCUSDT',
      direction: 'LONG',
      price: '{{close}}',
      override: false,
      zone: '{{plot_0}}',
      pivot_15m: '{{plot_1}}',
      pivot_1m: '{{plot_2}}',
      ema200Bias: '{{plot_3}}',
      hommaPatterns: '{{plot_4}}',
      volumeOk: true,
      reason: 'LH at upper band + shooting star on 1m'
    },
    notes: [
      'No secret required — webhook is open',
      'override=true bypasses ADX, EMA200, and structure gates — use sparingly',
      'TV signals always win dedup against internal AI signals',
      'zone: UPPER_MID / ABOVE_UPPER / LOWER_MID / BELOW_LOWER',
      'pivot_15m / pivot_1m: HH, HL, LH, LL'
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
