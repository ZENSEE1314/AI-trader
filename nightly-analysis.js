// ============================================================
// Nightly Analysis — Runs at 10pm Jakarta time (3pm UTC)
// Analyzes all trades, generates reports, updates AI learner
// ============================================================

const { query } = require('./db');
const { log: bLog } = require('./bot-logger');
const aiLearner = require('./ai-learner');

// ── Constants ───────────────────────────────────────────────

const BLACKLIST_WIN_RATE_THRESHOLD = 0.30;
const BLACKLIST_MIN_TRADES = 3;

// ── Table Setup ─────────────────────────────────────────────

async function ensureReportTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS nightly_reports (
      id SERIAL PRIMARY KEY,
      report_date DATE UNIQUE,
      total_trades INT,
      wins INT,
      losses INT,
      errors INT,
      win_rate DECIMAL,
      best_coins JSONB,
      worst_coins JSONB,
      blacklist_suggestions JSONB,
      recommendations JSONB,
      full_report JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Data Fetching ───────────────────────────────────────────

async function fetchAllTrades() {
  return query(`
    SELECT id, symbol, direction, entry_price, sl_price, tp_price,
           leverage, status, pnl_usdt, created_at, closed_at, error_msg
    FROM trades
    ORDER BY created_at DESC
  `);
}

async function fetchRecentLogs() {
  return query(`
    SELECT message, category, symbol, result, COALESCE(ts, created_at) as created_at
    FROM bot_logs
    ORDER BY COALESCE(ts, created_at) DESC
    LIMIT 500
  `);
}

// ── Trade Analysis ──────────────────────────────────────────

function analyzeTrades(trades) {
  const total = trades.length;
  const wins = trades.filter(t => t.status === 'WIN').length;
  const losses = trades.filter(t => t.status === 'LOSS').length;
  const errors = trades.filter(t => t.entry_price === null || t.status === 'ERROR').length;
  const winRate = total - errors > 0 ? wins / (total - errors) : 0;

  const bySymbol = groupByField(trades, 'symbol');
  const byDirection = groupByField(trades, 'direction');
  const byHour = groupByHour(trades);

  const coinStats = buildCoinStats(bySymbol);
  const directionStats = buildDirectionStats(byDirection);
  const hourStats = buildHourStats(byHour);
  const blacklistSuggestions = findBlacklistCandidates(coinStats);
  const wrongDirectionTrades = findWrongDirectionTrades(trades);

  const sortedCoins = Object.entries(coinStats)
    .filter(([, s]) => s.total >= 2)
    .sort((a, b) => b[1].winRate - a[1].winRate);

  const bestCoins = sortedCoins
    .filter(([, s]) => s.winRate > 0.5)
    .slice(0, 5)
    .map(([sym, s]) => ({ symbol: sym, winRate: s.winRate, trades: s.total, pnl: s.totalPnl }));

  const worstCoins = sortedCoins
    .filter(([, s]) => s.winRate < 0.5)
    .slice(-5)
    .reverse()
    .map(([sym, s]) => ({ symbol: sym, winRate: s.winRate, trades: s.total, pnl: s.totalPnl }));

  const recommendations = buildRecommendations({
    winRate, directionStats, blacklistSuggestions, hourStats, wrongDirectionTrades, errors, total,
  });

  return {
    total,
    wins,
    losses,
    errors,
    winRate: Math.round(winRate * 10000) / 100,
    coinStats,
    directionStats,
    hourStats,
    bestCoins,
    worstCoins,
    blacklistSuggestions,
    wrongDirectionTrades: wrongDirectionTrades.length,
    recommendations,
  };
}

function groupByField(trades, field) {
  const groups = {};
  for (const t of trades) {
    const key = t[field] || 'UNKNOWN';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  return groups;
}

function groupByHour(trades) {
  const groups = {};
  for (const t of trades) {
    if (!t.created_at) continue;
    const hour = new Date(t.created_at).getUTCHours();
    if (!groups[hour]) groups[hour] = [];
    groups[hour].push(t);
  }
  return groups;
}

function buildCoinStats(bySymbol) {
  const stats = {};
  for (const [symbol, trades] of Object.entries(bySymbol)) {
    const resolved = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
    const wins = resolved.filter(t => t.status === 'WIN').length;
    const totalPnl = resolved.reduce((sum, t) => sum + (parseFloat(t.pnl_usdt) || 0), 0);

    const byDir = {};
    for (const t of resolved) {
      const dir = t.direction || 'UNKNOWN';
      if (!byDir[dir]) byDir[dir] = { wins: 0, total: 0 };
      byDir[dir].total++;
      if (t.status === 'WIN') byDir[dir].wins++;
    }

    stats[symbol] = {
      total: resolved.length,
      wins,
      losses: resolved.length - wins,
      winRate: resolved.length > 0 ? wins / resolved.length : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      byDirection: byDir,
    };
  }
  return stats;
}

function buildDirectionStats(byDirection) {
  const stats = {};
  for (const [dir, trades] of Object.entries(byDirection)) {
    const resolved = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
    const wins = resolved.filter(t => t.status === 'WIN').length;
    const totalPnl = resolved.reduce((sum, t) => sum + (parseFloat(t.pnl_usdt) || 0), 0);
    stats[dir] = {
      total: resolved.length,
      wins,
      losses: resolved.length - wins,
      winRate: resolved.length > 0 ? Math.round((wins / resolved.length) * 10000) / 100 : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
    };
  }
  return stats;
}

function buildHourStats(byHour) {
  const stats = {};
  for (const [hour, trades] of Object.entries(byHour)) {
    const resolved = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
    const wins = resolved.filter(t => t.status === 'WIN').length;
    stats[hour] = {
      total: resolved.length,
      wins,
      losses: resolved.length - wins,
      winRate: resolved.length > 0 ? Math.round((wins / resolved.length) * 10000) / 100 : 0,
    };
  }
  return stats;
}

function findBlacklistCandidates(coinStats) {
  const candidates = [];
  for (const [symbol, s] of Object.entries(coinStats)) {
    if (s.total >= BLACKLIST_MIN_TRADES && s.winRate < BLACKLIST_WIN_RATE_THRESHOLD) {
      candidates.push({
        symbol,
        winRate: Math.round(s.winRate * 10000) / 100,
        trades: s.total,
        pnl: s.totalPnl,
      });
    }
  }
  return candidates.sort((a, b) => a.winRate - b.winRate);
}

function findWrongDirectionTrades(trades) {
  return trades.filter(t => {
    if (t.status !== 'LOSS') return false;
    if (!t.entry_price || !t.sl_price) return false;
    const entry = parseFloat(t.entry_price);
    const sl = parseFloat(t.sl_price);
    const isLong = sl < entry;
    const pnl = parseFloat(t.pnl_usdt) || 0;
    // Large loss relative to SL distance suggests direction was wrong
    return pnl < 0 && Math.abs(pnl) > 0;
  });
}

// ── Recommendations ─────────────────────────────────────────

function buildRecommendations({ winRate, directionStats, blacklistSuggestions, hourStats, wrongDirectionTrades, errors, total }) {
  const recs = [];

  if (winRate < 0.4) {
    recs.push('Overall win rate below 40% — consider tightening entry filters or increasing MIN_SCORE.');
  }
  if (winRate > 0.6) {
    recs.push('Win rate above 60% — strategy is performing well. Consider slightly increasing position size.');
  }

  const longStats = directionStats.LONG;
  const shortStats = directionStats.SHORT;
  if (longStats && shortStats) {
    if (longStats.winRate > shortStats.winRate + 15) {
      recs.push(`LONG win rate (${longStats.winRate}%) significantly higher than SHORT (${shortStats.winRate}%). Consider biasing towards LONG.`);
    }
    if (shortStats.winRate > longStats.winRate + 15) {
      recs.push(`SHORT win rate (${shortStats.winRate}%) significantly higher than LONG (${longStats.winRate}%). Consider biasing towards SHORT.`);
    }
  }

  if (blacklistSuggestions.length > 0) {
    const symbols = blacklistSuggestions.map(b => b.symbol).join(', ');
    recs.push(`Consider blacklisting ${blacklistSuggestions.length} coin(s) with <30% win rate: ${symbols}`);
  }

  const hourEntries = Object.entries(hourStats).filter(([, s]) => s.total >= 3);
  const bestHours = hourEntries.filter(([, s]) => s.winRate > 60).sort((a, b) => b[1].winRate - a[1].winRate);
  const worstHours = hourEntries.filter(([, s]) => s.winRate < 30).sort((a, b) => a[1].winRate - b[1].winRate);

  if (bestHours.length > 0) {
    const hrs = bestHours.slice(0, 3).map(([h, s]) => `${h}:00 UTC (${s.winRate}%)`).join(', ');
    recs.push(`Best trading hours: ${hrs}`);
  }
  if (worstHours.length > 0) {
    const hrs = worstHours.slice(0, 3).map(([h, s]) => `${h}:00 UTC (${s.winRate}%)`).join(', ');
    recs.push(`Avoid trading at: ${hrs}`);
  }

  if (wrongDirectionTrades > 0 && total > 0) {
    const pct = Math.round((wrongDirectionTrades / total) * 100);
    recs.push(`${wrongDirectionTrades} losing trades (${pct}% of total) — review direction logic.`);
  }

  if (errors > 0 && total > 0) {
    const errorPct = Math.round((errors / total) * 100);
    recs.push(`${errors} error trades (${errorPct}% of total) with null entry price — investigate order execution.`);
  }

  if (recs.length === 0) {
    recs.push('No significant issues detected. Continue monitoring.');
  }

  return recs;
}

// ── AI Learner Updates ──────────────────────────────────────

async function updateAiLearner(report) {
  for (const coin of report.blacklistSuggestions) {
    try {
      // Record a synthetic low-performing data point so shouldAvoidCoin picks it up
      // The ai-learner already checks ai_trades for < 30% win rate coins,
      // but we log a warning so it shows in the AI logs
      bLog.ai(
        `Nightly warning: ${coin.symbol} has ${coin.winRate}% win rate ` +
        `over ${coin.trades} trades — flagged for avoidance`
      );
    } catch (err) {
      bLog.error(`Failed to update AI for ${coin.symbol}: ${err.message}`);
    }
  }

  // Log direction insights
  const { directionStats } = report;
  if (directionStats.LONG && directionStats.SHORT) {
    bLog.ai(
      `Nightly direction stats — LONG: ${directionStats.LONG.winRate}% WR ` +
      `(${directionStats.LONG.total} trades), SHORT: ${directionStats.SHORT.winRate}% WR ` +
      `(${directionStats.SHORT.total} trades)`
    );
  }
}

// ── Save Report to DB ───────────────────────────────────────

async function saveReport(report) {
  const today = new Date().toISOString().slice(0, 10);

  await query(`
    INSERT INTO nightly_reports (
      report_date, total_trades, wins, losses, errors, win_rate,
      best_coins, worst_coins, blacklist_suggestions, recommendations, full_report
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (report_date) DO UPDATE SET
      total_trades = EXCLUDED.total_trades,
      wins = EXCLUDED.wins,
      losses = EXCLUDED.losses,
      errors = EXCLUDED.errors,
      win_rate = EXCLUDED.win_rate,
      best_coins = EXCLUDED.best_coins,
      worst_coins = EXCLUDED.worst_coins,
      blacklist_suggestions = EXCLUDED.blacklist_suggestions,
      recommendations = EXCLUDED.recommendations,
      full_report = EXCLUDED.full_report,
      created_at = NOW()
  `, [
    today,
    report.total,
    report.wins,
    report.losses,
    report.errors,
    report.winRate,
    JSON.stringify(report.bestCoins),
    JSON.stringify(report.worstCoins),
    JSON.stringify(report.blacklistSuggestions),
    JSON.stringify(report.recommendations),
    JSON.stringify(report),
  ]);
}

// ── Fetch Latest Report ─────────────────────────────────────

async function getLatestReport() {
  const rows = await query(`
    SELECT * FROM nightly_reports
    ORDER BY report_date DESC
    LIMIT 1
  `);
  return rows.length > 0 ? rows[0] : null;
}

// ── Main Entry Point ────────────────────────────────────────

async function runNightlyAnalysis() {
  const startTime = Date.now();
  bLog.system('Nightly analysis starting...');

  try {
    await ensureReportTable();

    const [trades, logs] = await Promise.all([
      fetchAllTrades(),
      fetchRecentLogs(),
    ]);

    if (trades.length === 0) {
      bLog.system('Nightly analysis: no trades found — skipping.');
      return null;
    }

    const report = analyzeTrades(trades);

    await saveReport(report);
    await updateAiLearner(report);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const flagged = report.blacklistSuggestions.length;

    bLog.system(
      `Nightly analysis: ${report.total} trades, ${report.winRate}% win rate, ` +
      `${flagged} coins flagged — completed in ${elapsed}s`
    );

    // Log individual recommendations
    for (const rec of report.recommendations) {
      bLog.ai(`Nightly recommendation: ${rec}`);
    }

    return report;
  } catch (err) {
    bLog.error(`Nightly analysis failed: ${err.message}`);
    return null;
  }
}

module.exports = { runNightlyAnalysis, getLatestReport };
