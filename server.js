require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const path = require('path');
const { initAllTables } = require('./db');

const app = express();

// Ensure all tables exist on startup
initAllTables().catch(err => console.error('DB init error:', err.message));

// Initialize Agent Framework
(async () => {
  try {
    const { getCoordinator } = require('./agents');
    await getCoordinator().init();
    console.log('[SERVER] Agent framework initialized successfully');
  } catch (err) {
    console.error('[SERVER] Agent framework init failed:', err);
  }
})();

// ── Performance: gzip compression (saves 60-80% bandwidth) ──
app.use(compression({ threshold: 1024 }));

// Skip JSON parsing for Stripe webhook — needs raw body for signature verification
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res, next) => {
  if (req.path === '/api/subscription/stripe-webhook') return next();
  express.json()(req, res, next);
});
app.use(cookieParser());

// ── Performance: static files with 1-day cache + ETag ──
app.use(express.static(path.resolve(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
}));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/keys', require('./routes/api-keys'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/chart', require('./routes/chart'));
app.use('/api/token-leverage', require('./routes/token-leverage'));
app.use('/api/risk-levels', require('./routes/risk-levels'));
// Fast health endpoint for Railway healthcheck (no DB queries)
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.use('/health/details', require('./health'));

// Customer chatbot (public — no auth needed)
app.post('/api/chatbot', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ reply: 'Please type a message.' });
    const { think, isAvailable } = require('./agents/ai-brain');
    console.log(`[CHATBOT] AI available: ${isAvailable()} | provider: ${require('./agents/ai-brain').getProviderName()}`);
    if (isAvailable()) {
      const reply = await think({
        agentName: 'CustomerBot',
        systemPrompt: `You are the customer support chatbot for MCT (Millionaire Crypto Traders), an AI-powered crypto auto-trading platform.

About MCT:
- AI bot trades crypto futures 24/7 on user's exchange account (Binance, Bitunix)
- Users connect their exchange API keys (trading only, never withdrawal)
- Bot uses SMC (Smart Money Concepts) strategy with multi-timeframe analysis
- Profit split: 60% user / 40% platform
- No monthly fees — we only earn when users profit
- Bot manages trailing stop-loss, take-profit, and position sizing automatically

How to get started:
1. Sign up at the website
2. Create API keys on Binance or Bitunix (trading permission only)
3. Add API keys to the dashboard
4. Bot starts trading automatically

Be helpful, concise, and friendly. If asked about specific trades or account details, tell them to log in to their dashboard or contact admin on Telegram.
Do NOT give financial advice. Always remind users that crypto trading involves risk.`,
        userMessage: message,
        context: {},
      });
      if (reply) return res.json({ reply });
    }
    // Fallback: simple FAQ
    const faq = customerFAQ(message.toLowerCase());
    res.json({ reply: faq });
  } catch (err) {
    res.json({ reply: 'Sorry, I\'m having trouble right now. Please try again or contact us on Telegram.' });
  }
});

function customerFAQ(text) {
  if (/how.*work|what.*do|about/.test(text)) return 'MCT is an AI-powered crypto trading bot. It trades futures 24/7 on your exchange using Smart Money Concepts. You connect your API key, and the bot handles everything — scanning, executing, and managing positions. Profit split is 60% you / 40% platform.';
  if (/start|sign up|register|join/.test(text)) return 'Getting started is easy:\n1. Sign up on this website\n2. Create API keys on Binance or Bitunix (trading permission only, never enable withdrawal)\n3. Add your keys to the dashboard\n4. The bot starts trading automatically!';
  if (/api.*key|connect|setup/.test(text)) return 'To connect your exchange:\n1. Go to Binance/Bitunix → API Management\n2. Create a new API key with Trading permission only\n3. Never enable Withdrawal permission\n4. Paste the key and secret in our dashboard under API Keys tab';
  if (/profit|split|fee|cost|price/.test(text)) return 'No monthly fees! We use a 60/40 profit split:\n- You keep 60% of all profits\n- Platform takes 40% as performance fee\n- If you don\'t profit, you don\'t pay anything\n- Losses are 100% yours (no platform fee on losing trades)';
  if (/safe|security|trust|scam/.test(text)) return 'Your funds stay on YOUR exchange account at all times. We never have access to withdraw. API keys are encrypted at rest. The bot only has permission to place and manage trades. You can revoke API keys anytime from your exchange.';
  if (/risk|lose|loss/.test(text)) return 'Crypto trading involves risk. The bot uses stop-losses and risk management, but losses can happen. Never trade with money you can\'t afford to lose. The bot\'s risk management includes: 5% SL, 10% TP, trailing stops, and position size limits.';
  if (/contact|support|help|telegram/.test(text)) return 'For support, reach out to our admin on Telegram. You can also check the dashboard for trade logs and performance stats.';
  if (/withdraw|payout|payment/.test(text)) return 'Your profits stay on your exchange. The platform\'s 40% share is settled weekly by admin. You can withdraw from your exchange anytime — we never touch your funds.';
  return 'I can help with:\n- How the trading bot works\n- Setting up your account\n- Connecting API keys\n- Understanding the profit split\n- Security questions\n\nWhat would you like to know?';
}

// Agent framework health (public — basic status only)
app.get('/api/agents/status', (req, res) => {
  try {
    const { getCoordinator } = require('./agents');
    const { isAvailable, getProviderName } = require('./agents/ai-brain');
    const coordinator = getCoordinator();
    const h = coordinator.getHealth();
    res.json({
      state: h.state,
      cycleRunning: h.cycleRunning,
      runCount: h.runCount,
      agentCount: Object.keys(h.agents || {}).length,
      aiEnabled: isAvailable(),
      aiProvider: getProviderName(),
      googleKeySet: !!process.env.GOOGLE_AI_KEY,
      anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
    });
  } catch (err) {
    res.json({ state: 'offline', error: err.message });
  }
});

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

// Public list of admin-allowed tokens (for user ban-token dropdown)
app.get('/api/allowed-tokens', async (req, res) => {
  try {
    const { query } = require('./db');
    const rows = await query(
      "SELECT symbol FROM global_token_settings WHERE enabled = true AND banned = false ORDER BY symbol"
    );
    res.json(rows.map(r => r.symbol));
  } catch { res.json([]); }
});


// Bot logs endpoint (live dashboard)
const { getLogs, getRecentLogs, getHistoricalLogs, getScanStats, getLogCounts } = require('./bot-logger');
const { authMiddleware } = require('./middleware/auth');
const aiLearner = require('./ai-learner');
const { getLatestReport } = require('./nightly-analysis');
const { query: dbQuery } = require('./db');

// Helper: check if user is admin
async function isAdmin(userId) {
  try {
    const rows = await dbQuery('SELECT is_admin FROM users WHERE id = $1', [userId]);
    return rows.length > 0 && rows[0].is_admin === true;
  } catch { return false; }
}

// Logs: first load reads from DB (persisted), polling reads from memory (fast)
// Users see system logs + their own. Admin sees everything.
app.get('/api/logs', authMiddleware, async (req, res) => {
  const since = parseFloat(req.query.since) || 0;
  const category = req.query.category || null;
  const count = parseInt(req.query.count) || 200;
  const admin = await isAdmin(req.userId);
  const scope = admin ? 'all' : req.userId;

  if (since > 0) {
    // Polling: fast in-memory for new entries
    res.json(getLogs(since, category, scope));
  } else {
    // Initial load / refresh: read from PostgreSQL so old logs survive redeploys
    try {
      const dbLogs = await getHistoricalLogs({ category, limit: count, userId: scope });
      if (dbLogs && dbLogs.length > 0) {
        // DB returns newest-first, reverse to oldest-first for display
        res.json(dbLogs.reverse());
      } else {
        // Fallback to in-memory if DB is empty or unavailable
        res.json(getRecentLogs(count, category, scope));
      }
    } catch {
      // DB error — fall back to in-memory
      res.json(getRecentLogs(count, category, scope));
    }
  }
});

// Historical logs from DB (survives redeploys)
app.get('/api/logs/history', authMiddleware, async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    const logs = await getHistoricalLogs({
      category: req.query.category || null,
      symbol: req.query.symbol || null,
      limit: Math.min(parseInt(req.query.limit) || 200, 1000),
      offset: parseInt(req.query.offset) || 0,
      startDate: req.query.start || null,
      endDate: req.query.end || null,
      userId: admin ? 'all' : req.userId,
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
(async () => {
  const { query: dbQuery } = require('./db');
  const cols = [
    { name: 'tp_pct',           sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tp_pct DECIMAL DEFAULT 0.045' },
    { name: 'sl_pct',           sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS sl_pct DECIMAL DEFAULT 0.03' },
    { name: 'max_consec_loss',  sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_consec_loss INTEGER DEFAULT 2' },
    { name: 'top_n_coins',      sql: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS top_n_coins INTEGER DEFAULT 50' },
    { name: 'username',         sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(100)' },
  ];
  for (const c of cols) {
    try { await dbQuery(c.sql); } catch (_) {}
  }
})();

module.exports = app;
