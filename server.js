const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/keys', require('./routes/api-keys'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/chart', require('./routes/chart'));

// Stripe webhook needs raw body — mount before json parser catches it
// (already handled inside subscription.js with express.raw)

// Available trading pairs (cached 1 hour)
let coinListCache = { data: null, ts: 0 };
app.get('/api/coins', async (req, res) => {
  try {
    if (coinListCache.data && Date.now() - coinListCache.ts < 3600000) {
      return res.json(coinListCache.data);
    }
    const fetch = require('node-fetch');
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
    const tickers = await r.json();
    const coins = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 200)
      .map(t => t.symbol);
    coinListCache = { data: coins, ts: Date.now() };
    res.json(coins);
  } catch { res.json([]); }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Bot logs endpoint (live dashboard)
const { getLogs, getRecentLogs } = require('./bot-logger');
const { authMiddleware } = require('./middleware/auth');
const aiLearner = require('./ai-learner');

app.get('/api/logs', authMiddleware, (req, res) => {
  const since = parseFloat(req.query.since) || 0;
  const category = req.query.category || null;
  const count = parseInt(req.query.count) || 100;

  if (since > 0) {
    res.json(getLogs(since, category));
  } else {
    res.json(getRecentLogs(count, category));
  }
});

// AI version history
app.get('/api/ai/versions', authMiddleware, async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    current: await aiLearner.getCurrentVersion(),
    versions: await aiLearner.getVersions(limit),
  });
});

// Server outbound IP (for Bitunix API key IP binding)
app.get('/api/server-ip', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const r = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const data = await r.json();
    res.json({ ip: data.ip });
  } catch {
    res.json({ ip: 'Unable to detect — try again later' });
  }
});

// SPA fallback — serve index.html for non-API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
