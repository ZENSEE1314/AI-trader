const express = require('express');
const { injectTVSignal } = require('../cycle');

const router = express.Router();

// Secret must match TV_WEBHOOK_SECRET env var — prevents spoofed signals.
const WEBHOOK_SECRET = process.env.TV_WEBHOOK_SECRET || 'MCT_TV_SECRET';

// Allowed symbols — only accept signals for active trading pairs.
const ALLOWED_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT']);

// POST /api/tv-webhook
// Called by TradingView alert webhook.
// Body: { secret, symbol, direction, price, zone, pivot }
router.post('/', (req, res) => {
  const { secret, symbol, direction, price, zone, pivot } = req.body || {};

  if (secret !== WEBHOOK_SECRET) {
    console.warn(`[TV-Webhook] Rejected — bad secret from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

  const signal = {
    symbol: sym,
    side: direction === 'LONG' ? 'BUY' : 'SELL',
    direction,
    price: entryPrice,
    zone:  zone   || 'TV',
    pivot: pivot  || 'TV',
    signalType: `TV-${direction}`,
    source: 'tradingview',
    receivedAt: Date.now(),
  };

  injectTVSignal(signal);
  console.log(`[TV-Webhook] ✅ ${sym} ${direction} @ ${entryPrice} (zone=${zone} pivot=${pivot})`);
  res.json({ ok: true, signal: `${sym} ${direction}` });
});

module.exports = router;
