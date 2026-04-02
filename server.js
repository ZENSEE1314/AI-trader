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
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.1.0' }));

// Bot logs endpoint (live dashboard)
const { getLogs, getRecentLogs, getHistoricalLogs, getScanStats, getLogCounts } = require('./bot-logger');
const { authMiddleware } = require('./middleware/auth');
const aiLearner = require('./ai-learner');
const { getLatestReport } = require('./nightly-analysis');

// Logs: first load reads from DB (persisted), polling reads from memory (fast)
app.get('/api/logs', authMiddleware, async (req, res) => {
  const since = parseFloat(req.query.since) || 0;
  const category = req.query.category || null;
  const count = parseInt(req.query.count) || 200;

  if (since > 0) {
    // Polling: fast in-memory for new entries
    res.json(getLogs(since, category));
  } else {
    // Initial load / refresh: read from PostgreSQL so old logs survive redeploys
    try {
      const dbLogs = await getHistoricalLogs({ category, limit: count });
      if (dbLogs && dbLogs.length > 0) {
        // DB returns newest-first, reverse to oldest-first for display
        res.json(dbLogs.reverse());
      } else {
        // Fallback to in-memory if DB is empty or unavailable
        res.json(getRecentLogs(count, category));
      }
    } catch {
      // DB error — fall back to in-memory
      res.json(getRecentLogs(count, category));
    }
  }
});

// Historical logs from DB (survives redeploys)
app.get('/api/logs/history', authMiddleware, async (req, res) => {
  try {
    const logs = await getHistoricalLogs({
      category: req.query.category || null,
      symbol: req.query.symbol || null,
      limit: Math.min(parseInt(req.query.limit) || 200, 1000),
      offset: parseInt(req.query.offset) || 0,
      startDate: req.query.start || null,
      endDate: req.query.end || null,
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan analytics for AI learning
app.get('/api/logs/scan-stats', authMiddleware, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const stats = await getScanStats(days);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log summary counts
app.get('/api/logs/counts', authMiddleware, async (req, res) => {
  try {
    res.json(await getLogCounts());
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Nightly analysis report
app.get('/api/reports/nightly', authMiddleware, async (req, res) => {
  try {
    const report = await getLatestReport();
    if (!report) return res.status(404).json({ error: 'No nightly report available yet' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Server outbound IP (for Bitunix API key IP binding)
app.get('/api/server-ip', authMiddleware, async (req, res) => {
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

// ── Auto-migrate: add new trading parameter columns ──────────
const { query: dbQuery } = require('./db');
(async () => {
  const cols = [
    { name: 'tp_pct',           sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tp_pct DECIMAL DEFAULT 0.045' },
    { name: 'sl_pct',           sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS sl_pct DECIMAL DEFAULT 0.03' },
    { name: 'max_consec_loss',  sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_consec_loss INTEGER DEFAULT 2' },
    { name: 'top_n_coins',      sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS top_n_coins INTEGER DEFAULT 50' },
  ];
  for (const c of cols) {
    try { await dbQuery(c.sql); } catch (_) {}
  }
})();

module.exports = app;
