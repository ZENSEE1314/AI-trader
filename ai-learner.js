// ============================================================
// AI Self-Learning Engine
// Tracks trade outcomes, learns patterns, adapts parameters
// Storage: SQLite (data/trades.db)
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'trades.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Database Setup ───────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    setup TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    pnl_pct REAL,
    is_win INTEGER,
    leverage INTEGER,
    duration_min INTEGER,
    session TEXT,
    rsi_at_entry REAL,
    atr_pct REAL,
    vol_ratio REAL,
    sentiment_score REAL,
    bb_position REAL,
    score_at_entry REAL,
    sl_distance_pct REAL,
    tp_distance_pct REAL,
    trend_1h TEXT,
    market_structure TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS parameter_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    param_name TEXT NOT NULL,
    old_value REAL NOT NULL,
    new_value REAL NOT NULL,
    reason TEXT,
    trade_count INTEGER,
    win_rate REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    trade_count INTEGER NOT NULL,
    win_rate REAL,
    avg_pnl REAL,
    total_pnl REAL,
    params TEXT NOT NULL,
    setup_weights TEXT,
    avoided_coins TEXT,
    changes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
  CREATE INDEX IF NOT EXISTS idx_trades_setup ON trades(setup);
  CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session);
  CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
  CREATE INDEX IF NOT EXISTS idx_versions_created ON ai_versions(created_at);
`);

// ── Prepared Statements ──────────────────────────────────────

const insertTrade = db.prepare(`
  INSERT INTO trades (
    symbol, direction, setup, entry_price, exit_price, pnl_pct, is_win,
    leverage, duration_min, session, rsi_at_entry, atr_pct, vol_ratio,
    sentiment_score, bb_position, score_at_entry, sl_distance_pct,
    tp_distance_pct, trend_1h, market_structure, closed_at
  ) VALUES (
    @symbol, @direction, @setup, @entryPrice, @exitPrice, @pnlPct, @isWin,
    @leverage, @durationMin, @session, @rsiAtEntry, @atrPct, @volRatio,
    @sentimentScore, @bbPosition, @scoreAtEntry, @slDistancePct,
    @tpDistancePct, @trend1h, @marketStructure, @closedAt
  )
`);

const insertParamChange = db.prepare(`
  INSERT INTO parameter_history (param_name, old_value, new_value, reason, trade_count, win_rate)
  VALUES (@paramName, @oldValue, @newValue, @reason, @tradeCount, @winRate)
`);

// ── Constants ────────────────────────────────────────────────

const MIN_TRADES_FOR_LEARNING = 20;
const RECALC_INTERVAL = 10;
const MAX_WEIGHT_SHIFT = 0.05;
const EMA_ALPHA = 0.3; // weight recent trades more heavily
let lastVersionTradeCount = 0; // track when to snapshot

// ── Current Session Detection ────────────────────────────────

function getCurrentSession() {
  const utcH = new Date().getUTCHours();
  if (utcH >= 23 || utcH <= 2) return 'asia';
  if (utcH >= 7 && utcH <= 10) return 'asia_europe';
  if (utcH >= 12 && utcH <= 16) return 'europe_us';
  return 'off_hours';
}

// ── Record a Completed Trade ─────────────────────────────────

function recordTrade(data) {
  const isWin = data.pnlPct > 0 ? 1 : 0;
  insertTrade.run({
    symbol: data.symbol,
    direction: data.direction,
    setup: data.setup,
    entryPrice: data.entryPrice,
    exitPrice: data.exitPrice || null,
    pnlPct: data.pnlPct || 0,
    isWin,
    leverage: data.leverage || 20,
    durationMin: data.durationMin || 0,
    session: data.session || getCurrentSession(),
    rsiAtEntry: data.rsiAtEntry || null,
    atrPct: data.atrPct || null,
    volRatio: data.volRatio || null,
    sentimentScore: data.sentimentScore || null,
    bbPosition: data.bbPosition || null,
    scoreAtEntry: data.scoreAtEntry || null,
    slDistancePct: data.slDistancePct || null,
    tpDistancePct: data.tpDistancePct || null,
    trend1h: data.trend1h || null,
    marketStructure: data.marketStructure || null,
    closedAt: new Date().toISOString(),
  });

  // Check if we should snapshot a new AI version
  const totalTrades = db.prepare('SELECT COUNT(*) as c FROM trades WHERE pnl_pct IS NOT NULL').get().c;
  if (totalTrades >= MIN_TRADES_FOR_LEARNING && totalTrades - lastVersionTradeCount >= RECALC_INTERVAL) {
    lastVersionTradeCount = totalTrades;
    saveVersion(totalTrades);
  }
}

// ── Weight Calculations (EMA-based) ──────────────────────────

function calcEMAWinRate(trades) {
  if (!trades.length) return 0.5;
  let emaWinRate = trades[0].is_win;
  for (let i = 1; i < trades.length; i++) {
    emaWinRate = EMA_ALPHA * trades[i].is_win + (1 - EMA_ALPHA) * emaWinRate;
  }
  return emaWinRate;
}

function winRateToWeight(winRate) {
  // Map win rate to weight: 0% → 0.5x, 50% → 1.0x, 80%+ → 1.5x
  // Clamped to [0.5, 2.0]
  const weight = 0.5 + winRate * 1.5;
  return Math.max(0.5, Math.min(2.0, weight));
}

// ── Setup Weight ─────────────────────────────────────────────

function getSetupWeight(setupType) {
  const trades = db.prepare(`
    SELECT is_win FROM trades
    WHERE setup = ? AND pnl_pct IS NOT NULL
    ORDER BY created_at ASC
  `).all(setupType);

  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Coin Weight ──────────────────────────────────────────────

function getCoinWeight(symbol) {
  const trades = db.prepare(`
    SELECT is_win FROM trades
    WHERE symbol = ? AND pnl_pct IS NOT NULL
    ORDER BY created_at ASC
  `).all(symbol);

  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Session Weight ───────────────────────────────────────────

function getSessionWeight() {
  const session = getCurrentSession();
  const trades = db.prepare(`
    SELECT is_win FROM trades
    WHERE session = ? AND pnl_pct IS NOT NULL
    ORDER BY created_at ASC
  `).all(session);

  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Should Avoid Coin ────────────────────────────────────────

function shouldAvoidCoin(symbol) {
  const stats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins
    FROM trades
    WHERE symbol = ? AND pnl_pct IS NOT NULL
  `).get(symbol);

  if (!stats || stats.total < MIN_TRADES_FOR_LEARNING) return false;
  const winRate = stats.wins / stats.total;
  return winRate < 0.30;
}

// ── Optimal Parameters (adaptive tuning) ─────────────────────

const DEFAULT_PARAMS = {
  SL_BUFFER: 0.001,
  TP_PCT: 0.01,
  MIN_SCORE: 8,
  WALLET_RISK_PCT: 0.03,
  RSI_MAX: 68,
  RSI_MIN: 32,
  VOL_RATIO_MIN: 1.2,
};

function getOptimalParams() {
  const totalTrades = db.prepare(`
    SELECT COUNT(*) as count FROM trades WHERE pnl_pct IS NOT NULL
  `).get().count;

  if (totalTrades < MIN_TRADES_FOR_LEARNING * 2) return { ...DEFAULT_PARAMS };

  const params = { ...DEFAULT_PARAMS };

  // Analyze SL distance: if most losses are from SL too tight, widen it
  const slAnalysis = db.prepare(`
    SELECT
      AVG(CASE WHEN is_win = 0 THEN sl_distance_pct END) as avg_losing_sl,
      AVG(CASE WHEN is_win = 1 THEN sl_distance_pct END) as avg_winning_sl,
      AVG(pnl_pct) as avg_pnl
    FROM trades
    WHERE pnl_pct IS NOT NULL AND sl_distance_pct IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
  `).get();

  if (slAnalysis.avg_losing_sl && slAnalysis.avg_winning_sl) {
    // If winning SL is wider than losing SL, we're being stopped out too early
    if (slAnalysis.avg_winning_sl > slAnalysis.avg_losing_sl * 1.2) {
      const newSL = Math.min(params.SL_BUFFER * (1 + MAX_WEIGHT_SHIFT), 0.003);
      if (newSL !== params.SL_BUFFER) {
        logParamChange('SL_BUFFER', params.SL_BUFFER, newSL, 'winning trades use wider SL', totalTrades);
        params.SL_BUFFER = newSL;
      }
    }
  }

  // Analyze RSI: find optimal RSI range from winning trades
  const rsiAnalysis = db.prepare(`
    SELECT
      AVG(CASE WHEN is_win = 1 AND direction = 'LONG' THEN rsi_at_entry END) as avg_win_rsi_long,
      AVG(CASE WHEN is_win = 1 AND direction = 'SHORT' THEN rsi_at_entry END) as avg_win_rsi_short
    FROM trades
    WHERE pnl_pct IS NOT NULL AND rsi_at_entry IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 100
  `).get();

  if (rsiAnalysis.avg_win_rsi_long) {
    // Gradually shift RSI bounds toward winning averages
    const targetMax = Math.round(rsiAnalysis.avg_win_rsi_long + 10);
    params.RSI_MAX = Math.round(params.RSI_MAX + (targetMax - params.RSI_MAX) * MAX_WEIGHT_SHIFT);
    params.RSI_MAX = Math.max(60, Math.min(75, params.RSI_MAX));
  }

  // Analyze score threshold: find minimum score that still wins
  const scoreAnalysis = db.prepare(`
    SELECT score_at_entry, is_win
    FROM trades
    WHERE pnl_pct IS NOT NULL AND score_at_entry IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 100
  `).all();

  if (scoreAnalysis.length >= 30) {
    const winsByScore = {};
    for (const t of scoreAnalysis) {
      const bucket = Math.floor(t.score_at_entry / 2) * 2;
      if (!winsByScore[bucket]) winsByScore[bucket] = { wins: 0, total: 0 };
      winsByScore[bucket].total++;
      if (t.is_win) winsByScore[bucket].wins++;
    }
    // Find lowest score bucket with >50% win rate
    const goodBuckets = Object.entries(winsByScore)
      .filter(([, v]) => v.total >= 3 && v.wins / v.total > 0.5)
      .map(([k]) => parseInt(k))
      .sort((a, b) => a - b);
    if (goodBuckets.length) {
      const optimalMin = goodBuckets[0];
      params.MIN_SCORE = Math.round(params.MIN_SCORE + (optimalMin - params.MIN_SCORE) * MAX_WEIGHT_SHIFT);
      params.MIN_SCORE = Math.max(5, Math.min(15, params.MIN_SCORE));
    }
  }

  return params;
}

function logParamChange(name, oldVal, newVal, reason, tradeCount) {
  const winRate = db.prepare(`
    SELECT AVG(is_win) as wr FROM trades WHERE pnl_pct IS NOT NULL
  `).get().wr || 0;

  insertParamChange.run({
    paramName: name,
    oldValue: oldVal,
    newValue: newVal,
    reason,
    tradeCount,
    winRate,
  });
}

// ── Version Snapshots ────────────────────────────────────────

function saveVersion(tradeCount) {
  const overall = db.prepare(`
    SELECT
      AVG(is_win) as win_rate,
      AVG(pnl_pct) as avg_pnl,
      SUM(pnl_pct) as total_pnl
    FROM trades WHERE pnl_pct IS NOT NULL
  `).get();

  const params = getOptimalParams();

  // Collect setup weights
  const setups = db.prepare(`
    SELECT setup, COUNT(*) as total,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1.0 ELSE 0.0 END), 3) as win_rate
    FROM trades WHERE pnl_pct IS NOT NULL
    GROUP BY setup HAVING total >= 3
  `).all();
  const setupWeights = {};
  for (const s of setups) {
    setupWeights[s.setup] = { trades: s.total, winRate: s.win_rate, weight: getSetupWeight(s.setup) };
  }

  // Collect avoided coins
  const allSymbols = db.prepare(`
    SELECT DISTINCT symbol FROM trades WHERE pnl_pct IS NOT NULL
  `).all().map(r => r.symbol);
  const avoided = allSymbols.filter(s => shouldAvoidCoin(s));

  // Detect what changed vs previous version
  const prevVersion = db.prepare(`
    SELECT params FROM ai_versions ORDER BY id DESC LIMIT 1
  `).get();
  const changes = [];
  if (prevVersion) {
    const prev = JSON.parse(prevVersion.params);
    for (const [key, val] of Object.entries(params)) {
      if (prev[key] !== undefined && prev[key] !== val) {
        changes.push(`${key}: ${prev[key]} → ${val}`);
      }
    }
  }

  // Generate version number: v1.0, v1.1, v1.2... major bumps every 50 trades
  const major = Math.floor(tradeCount / 50) + 1;
  const minor = Math.floor((tradeCount % 50) / RECALC_INTERVAL);
  const version = `v${major}.${minor}`;

  db.prepare(`
    INSERT INTO ai_versions (version, trade_count, win_rate, avg_pnl, total_pnl, params, setup_weights, avoided_coins, changes)
    VALUES (@version, @tradeCount, @winRate, @avgPnl, @totalPnl, @params, @setupWeights, @avoidedCoins, @changes)
  `).run({
    version,
    tradeCount,
    winRate: overall.win_rate || 0,
    avgPnl: overall.avg_pnl || 0,
    totalPnl: overall.total_pnl || 0,
    params: JSON.stringify(params),
    setupWeights: JSON.stringify(setupWeights),
    avoidedCoins: avoided.join(','),
    changes: changes.length ? changes.join(' | ') : 'initial snapshot',
  });

  console.log(`[AI] Version ${version} saved — ${tradeCount} trades, ${((overall.win_rate || 0) * 100).toFixed(0)}% WR, ${changes.length} param changes`);
}

function getVersions(limit = 50) {
  return db.prepare(`
    SELECT id, version, trade_count, win_rate, avg_pnl, total_pnl,
           params, setup_weights, avoided_coins, changes, created_at
    FROM ai_versions
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function getCurrentVersion() {
  const row = db.prepare('SELECT version FROM ai_versions ORDER BY id DESC LIMIT 1').get();
  return row ? row.version : 'v0.0';
}

// ── Stats for Telegram /stats Command ────────────────────────

function getStats() {
  const overall = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl,
      SUM(pnl_pct) as total_pnl,
      MAX(pnl_pct) as best_trade,
      MIN(pnl_pct) as worst_trade
    FROM trades
    WHERE pnl_pct IS NOT NULL
  `).get();

  const bySetup = db.prepare(`
    SELECT setup,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
    FROM trades
    WHERE pnl_pct IS NOT NULL
    GROUP BY setup
    ORDER BY avg_pnl DESC
  `).all();

  const bySession = db.prepare(`
    SELECT session,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
    FROM trades
    WHERE pnl_pct IS NOT NULL
    GROUP BY session
    ORDER BY avg_pnl DESC
  `).all();

  const recent = db.prepare(`
    SELECT symbol, direction, setup, pnl_pct, created_at
    FROM trades
    WHERE pnl_pct IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  const paramChanges = db.prepare(`
    SELECT param_name, old_value, new_value, reason, created_at
    FROM parameter_history
    ORDER BY created_at DESC
    LIMIT 5
  `).all();

  return { overall, bySetup, bySession, recent, paramChanges };
}

// ── Best Performing Setups ───────────────────────────────────

function getBestSetups() {
  return db.prepare(`
    SELECT setup,
      COUNT(*) as total,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate,
      ROUND(AVG(pnl_pct), 3) as avg_pnl
    FROM trades
    WHERE pnl_pct IS NOT NULL
    GROUP BY setup
    HAVING total >= 5
    ORDER BY avg_pnl DESC
  `).all();
}

// ── Direction Preference for a Coin ──────────────────────────

function getDirectionPreference(symbol) {
  const stats = db.prepare(`
    SELECT direction,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
    FROM trades
    WHERE symbol = ? AND pnl_pct IS NOT NULL
    GROUP BY direction
  `).all(symbol);

  if (stats.length < 2) return null;

  const longStats = stats.find(s => s.direction === 'LONG');
  const shortStats = stats.find(s => s.direction === 'SHORT');

  if (!longStats || !shortStats) return null;
  if (longStats.total < 5 || shortStats.total < 5) return null;

  // If one direction significantly outperforms, prefer it
  if (longStats.avg_pnl > shortStats.avg_pnl * 1.5) return 'LONG';
  if (shortStats.avg_pnl > longStats.avg_pnl * 1.5) return 'SHORT';
  return null;
}

// ── Composite AI Score Modifier ──────────────────────────────

function getAIScoreModifier(symbol, setup, direction) {
  const setupW = getSetupWeight(setup);
  const coinW = getCoinWeight(symbol);
  const sessionW = getSessionWeight();
  const dirPref = getDirectionPreference(symbol);

  let modifier = (setupW + coinW + sessionW) / 3;

  // Penalize if AI has learned this coin works better in opposite direction
  if (dirPref && dirPref !== direction) {
    modifier *= 0.7;
  }

  return modifier;
}

// ── Close DB on process exit ─────────────────────────────────

process.on('exit', () => { try { db.close(); } catch (_) {} });

module.exports = {
  recordTrade,
  getSetupWeight,
  getCoinWeight,
  getSessionWeight,
  shouldAvoidCoin,
  getOptimalParams,
  getStats,
  getBestSetups,
  getDirectionPreference,
  getAIScoreModifier,
  getCurrentSession,
  getVersions,
  getCurrentVersion,
  DEFAULT_PARAMS,
};
