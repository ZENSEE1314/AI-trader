// ============================================================
// AI Self-Learning Engine
// Tracks trade outcomes, learns patterns, adapts parameters
// Storage: Neon PostgreSQL (persistent across deploys)
// ============================================================

const { query } = require('./db');

// ── Constants ────────────────────────────────────────────────

const MIN_TRADES_FOR_LEARNING = 20;
const RECALC_INTERVAL = 10;
const MAX_WEIGHT_SHIFT = 0.05;
const EMA_ALPHA = 0.3;
let lastVersionTradeCount = 0;

// ── Current Session Detection ────────────────────────────────

function getCurrentSession() {
  const utcH = new Date().getUTCHours();
  if (utcH >= 23 || utcH <= 2) return 'asia';
  if (utcH >= 7 && utcH <= 10) return 'asia_europe';
  if (utcH >= 12 && utcH <= 16) return 'europe_us';
  return 'off_hours';
}

// ── Record a Completed Trade ─────────────────────────────────

async function recordTrade(data) {
  const isWin = data.pnlPct > 0 ? 1 : 0;
  await query(
    `INSERT INTO ai_trades (
      symbol, direction, setup, entry_price, exit_price, pnl_pct, is_win,
      leverage, duration_min, session, rsi_at_entry, atr_pct, vol_ratio,
      sentiment_score, bb_position, score_at_entry, sl_distance_pct,
      tp_distance_pct, trend_1h, market_structure, closed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      data.symbol, data.direction, data.setup, data.entryPrice,
      data.exitPrice || null, data.pnlPct || 0, isWin,
      data.leverage || 20, data.durationMin || 0,
      data.session || getCurrentSession(),
      data.rsiAtEntry || null, data.atrPct || null, data.volRatio || null,
      data.sentimentScore || null, data.bbPosition || null,
      data.scoreAtEntry || null, data.slDistancePct || null,
      data.tpDistancePct || null, data.trend1h || null,
      data.marketStructure || null, new Date().toISOString(),
    ]
  );

  const countRes = await query('SELECT COUNT(*) as c FROM ai_trades WHERE pnl_pct IS NOT NULL');
  const totalTrades = parseInt(countRes[0].c);
  if (totalTrades >= MIN_TRADES_FOR_LEARNING && totalTrades - lastVersionTradeCount >= RECALC_INTERVAL) {
    lastVersionTradeCount = totalTrades;
    await saveVersion(totalTrades);
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
  const weight = 0.5 + winRate * 1.5;
  return Math.max(0.5, Math.min(2.0, weight));
}

// ── Setup Weight ─────────────────────────────────────────────

async function getSetupWeight(setupType) {
  const trades = await query(
    `SELECT is_win FROM ai_trades
     WHERE setup = $1 AND pnl_pct IS NOT NULL
     ORDER BY created_at ASC`,
    [setupType]
  );
  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Coin Weight ──────────────────────────────────────────────

async function getCoinWeight(symbol) {
  const trades = await query(
    `SELECT is_win FROM ai_trades
     WHERE symbol = $1 AND pnl_pct IS NOT NULL
     ORDER BY created_at ASC`,
    [symbol]
  );
  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Session Weight ───────────────────────────────────────────

async function getSessionWeight() {
  const session = getCurrentSession();
  const trades = await query(
    `SELECT is_win FROM ai_trades
     WHERE session = $1 AND pnl_pct IS NOT NULL
     ORDER BY created_at ASC`,
    [session]
  );
  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Should Avoid Coin ────────────────────────────────────────

async function shouldAvoidCoin(symbol) {
  const stats = await query(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins
     FROM ai_trades
     WHERE symbol = $1 AND pnl_pct IS NOT NULL`,
    [symbol]
  );
  const row = stats[0];
  if (!row || parseInt(row.total) < MIN_TRADES_FOR_LEARNING) return false;
  const winRate = parseInt(row.wins) / parseInt(row.total);
  return winRate < 0.30;
}

// ── Optimal Parameters (adaptive tuning) ─────────────────────

const DEFAULT_PARAMS = {
  SL_BUFFER: 0.001,
  TP_PCT: 0.01,
  MIN_SCORE: 6,
  WALLET_RISK_PCT: 0.03,
  RSI_MAX: 68,
  RSI_MIN: 32,
  VOL_RATIO_MIN: 1.2,
};

async function getOptimalParams() {
  const countRes = await query('SELECT COUNT(*) as count FROM ai_trades WHERE pnl_pct IS NOT NULL');
  const totalTrades = parseInt(countRes[0].count);

  if (totalTrades < MIN_TRADES_FOR_LEARNING * 2) return { ...DEFAULT_PARAMS };

  const params = { ...DEFAULT_PARAMS };

  // Analyze SL distance
  const slAnalysis = await query(
    `SELECT
      AVG(CASE WHEN is_win = 0 THEN sl_distance_pct END) as avg_losing_sl,
      AVG(CASE WHEN is_win = 1 THEN sl_distance_pct END) as avg_winning_sl,
      AVG(pnl_pct) as avg_pnl
     FROM (SELECT * FROM ai_trades WHERE pnl_pct IS NOT NULL AND sl_distance_pct IS NOT NULL
           ORDER BY created_at DESC LIMIT 50) sub`
  );

  const sl = slAnalysis[0];
  if (sl && sl.avg_losing_sl && sl.avg_winning_sl) {
    if (parseFloat(sl.avg_winning_sl) > parseFloat(sl.avg_losing_sl) * 1.2) {
      const newSL = Math.min(params.SL_BUFFER * (1 + MAX_WEIGHT_SHIFT), 0.003);
      if (newSL !== params.SL_BUFFER) {
        await logParamChange('SL_BUFFER', params.SL_BUFFER, newSL, 'winning trades use wider SL', totalTrades);
        params.SL_BUFFER = newSL;
      }
    }
  }

  // Analyze RSI
  const rsiAnalysis = await query(
    `SELECT
      AVG(CASE WHEN is_win = 1 AND direction = 'LONG' THEN rsi_at_entry END) as avg_win_rsi_long,
      AVG(CASE WHEN is_win = 1 AND direction = 'SHORT' THEN rsi_at_entry END) as avg_win_rsi_short
     FROM (SELECT * FROM ai_trades WHERE pnl_pct IS NOT NULL AND rsi_at_entry IS NOT NULL
           ORDER BY created_at DESC LIMIT 100) sub`
  );

  const rsi = rsiAnalysis[0];
  if (rsi && rsi.avg_win_rsi_long) {
    const targetMax = Math.round(parseFloat(rsi.avg_win_rsi_long) + 10);
    params.RSI_MAX = Math.round(params.RSI_MAX + (targetMax - params.RSI_MAX) * MAX_WEIGHT_SHIFT);
    params.RSI_MAX = Math.max(60, Math.min(75, params.RSI_MAX));
  }

  // Analyze score threshold
  const scoreAnalysis = await query(
    `SELECT score_at_entry, is_win
     FROM ai_trades
     WHERE pnl_pct IS NOT NULL AND score_at_entry IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 100`
  );

  if (scoreAnalysis.length >= 30) {
    const winsByScore = {};
    for (const t of scoreAnalysis) {
      const bucket = Math.floor(parseFloat(t.score_at_entry) / 2) * 2;
      if (!winsByScore[bucket]) winsByScore[bucket] = { wins: 0, total: 0 };
      winsByScore[bucket].total++;
      if (t.is_win) winsByScore[bucket].wins++;
    }
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

async function logParamChange(name, oldVal, newVal, reason, tradeCount) {
  const wrRes = await query('SELECT AVG(is_win) as wr FROM ai_trades WHERE pnl_pct IS NOT NULL');
  const winRate = parseFloat(wrRes[0].wr) || 0;

  await query(
    `INSERT INTO ai_parameter_history (param_name, old_value, new_value, reason, trade_count, win_rate)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [name, oldVal, newVal, reason, tradeCount, winRate]
  );
}

// ── Version Snapshots ────────────────────────────────────────

async function saveVersion(tradeCount) {
  const overall = await query(
    `SELECT AVG(is_win) as win_rate, AVG(pnl_pct) as avg_pnl, SUM(pnl_pct) as total_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL`
  );
  const o = overall[0];

  const params = await getOptimalParams();

  const setups = await query(
    `SELECT setup, COUNT(*) as total,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1.0 ELSE 0.0 END)::numeric, 3) as win_rate
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY setup HAVING COUNT(*) >= 3`
  );
  const setupWeights = {};
  for (const s of setups) {
    const w = await getSetupWeight(s.setup);
    setupWeights[s.setup] = { trades: parseInt(s.total), winRate: parseFloat(s.win_rate), weight: w };
  }

  const allSymbols = await query(
    'SELECT DISTINCT symbol FROM ai_trades WHERE pnl_pct IS NOT NULL'
  );
  const avoided = [];
  for (const r of allSymbols) {
    if (await shouldAvoidCoin(r.symbol)) avoided.push(r.symbol);
  }

  const prevVersion = await query(
    'SELECT params FROM ai_versions ORDER BY id DESC LIMIT 1'
  );
  const changes = [];
  if (prevVersion.length) {
    const prev = JSON.parse(prevVersion[0].params);
    for (const [key, val] of Object.entries(params)) {
      if (prev[key] !== undefined && prev[key] !== val) {
        changes.push(`${key}: ${prev[key]} → ${val}`);
      }
    }
  }

  const major = Math.floor(tradeCount / 50) + 1;
  const minor = Math.floor((tradeCount % 50) / RECALC_INTERVAL);
  const version = `v${major}.${minor}`;

  await query(
    `INSERT INTO ai_versions (version, trade_count, win_rate, avg_pnl, total_pnl, params, setup_weights, avoided_coins, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      version, tradeCount,
      parseFloat(o.win_rate) || 0,
      parseFloat(o.avg_pnl) || 0,
      parseFloat(o.total_pnl) || 0,
      JSON.stringify(params),
      JSON.stringify(setupWeights),
      avoided.join(','),
      changes.length ? changes.join(' | ') : 'initial snapshot',
    ]
  );

  console.log(`[AI] Version ${version} saved — ${tradeCount} trades, ${((parseFloat(o.win_rate) || 0) * 100).toFixed(0)}% WR, ${changes.length} param changes`);
}

async function getVersions(limit = 50) {
  return query(
    `SELECT id, version, trade_count, win_rate, avg_pnl, total_pnl,
            params, setup_weights, avoided_coins, changes, created_at
     FROM ai_versions ORDER BY id DESC LIMIT $1`,
    [limit]
  );
}

async function getCurrentVersion() {
  const rows = await query('SELECT version FROM ai_versions ORDER BY id DESC LIMIT 1');
  return rows.length ? rows[0].version : 'v0.0';
}

// ── Stats for Telegram /stats Command ────────────────────────

async function getStats() {
  const overall = await query(
    `SELECT COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl, SUM(pnl_pct) as total_pnl,
      MAX(pnl_pct) as best_trade, MIN(pnl_pct) as worst_trade
     FROM ai_trades WHERE pnl_pct IS NOT NULL`
  );

  const bySetup = await query(
    `SELECT setup, COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY setup ORDER BY AVG(pnl_pct) DESC`
  );

  const bySession = await query(
    `SELECT session, COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY session ORDER BY AVG(pnl_pct) DESC`
  );

  const recent = await query(
    `SELECT symbol, direction, setup, pnl_pct, created_at
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     ORDER BY created_at DESC LIMIT 10`
  );

  const paramChanges = await query(
    `SELECT param_name, old_value, new_value, reason, created_at
     FROM ai_parameter_history ORDER BY created_at DESC LIMIT 5`
  );

  return { overall: overall[0], bySetup, bySession, recent, paramChanges };
}

// ── Best Performing Setups ───────────────────────────────────

async function getBestSetups() {
  return query(
    `SELECT setup, COUNT(*) as total,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1.0 ELSE 0.0 END)::numeric * 100, 1) as win_rate,
      ROUND(AVG(pnl_pct)::numeric, 3) as avg_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY setup HAVING COUNT(*) >= 5
     ORDER BY AVG(pnl_pct) DESC`
  );
}

// ── Direction Preference for a Coin ──────────────────────────

async function getDirectionPreference(symbol) {
  const stats = await query(
    `SELECT direction, COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades WHERE symbol = $1 AND pnl_pct IS NOT NULL
     GROUP BY direction`,
    [symbol]
  );

  if (stats.length < 2) return null;
  const longStats = stats.find(s => s.direction === 'LONG');
  const shortStats = stats.find(s => s.direction === 'SHORT');
  if (!longStats || !shortStats) return null;
  if (parseInt(longStats.total) < 5 || parseInt(shortStats.total) < 5) return null;

  if (parseFloat(longStats.avg_pnl) > parseFloat(shortStats.avg_pnl) * 1.5) return 'LONG';
  if (parseFloat(shortStats.avg_pnl) > parseFloat(longStats.avg_pnl) * 1.5) return 'SHORT';
  return null;
}

// ── Composite AI Score Modifier ──────────────────────────────

async function getAIScoreModifier(symbol, setup, direction) {
  const setupW = await getSetupWeight(setup);
  const coinW = await getCoinWeight(symbol);
  const sessionW = await getSessionWeight();
  const dirPref = await getDirectionPreference(symbol);

  let modifier = (setupW + coinW + sessionW) / 3;

  if (dirPref && dirPref !== direction) {
    modifier *= 0.7;
  }

  return modifier;
}

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
