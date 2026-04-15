// ============================================================
// Token Scanner — Per-token live SMC signal status
//
// Scans each token individually for 15m/3m/1m HL/LH structure.
// Results cached in memory, refreshed every scan cycle.
// Users pick tokens from the signal board to auto-trade.
// ============================================================

const { scanAI } = require('./ai-signal-scanner');
const { log: bLog } = require('./bot-logger');

// In-memory signal board — refreshed every cycle
let signalBoard = {};
let lastScanAt = 0;

/**
 * Scan all tokens and build the signal board.
 * Returns { BTCUSDT: { direction, score, ... }, ... }
 */
async function scanAllTokens(log, opts = {}) {
  const signals = await scanAI(log, opts);

  // Update signal board with fresh signals
  const now = Date.now();
  // Mark old signals as stale
  for (const sym of Object.keys(signalBoard)) {
    if (now - signalBoard[sym].ts > 5 * 60 * 1000) {
      signalBoard[sym].status = 'no_signal';
      signalBoard[sym].direction = null;
      signalBoard[sym].score = 0;
    }
  }

  // Add fresh signals
  for (const s of signals) {
    signalBoard[s.symbol] = {
      symbol: s.symbol,
      direction: s.direction,
      score: s.score,
      setup: s.setupName,
      sl: s.sl,
      tp: s.tp1,
      structure: s.structure,
      status: 'signal',
      ts: now,
    };
  }

  lastScanAt = now;
  return signals;
}

/**
 * Get the full signal board (all tokens with status).
 */
function getSignalBoard() {
  return { tokens: signalBoard, lastScanAt };
}

/**
 * Get signal for a specific token.
 */
function getTokenSignal(symbol) {
  return signalBoard[symbol] || null;
}

/**
 * Update daily results for a closed trade.
 */
async function recordTokenResult(symbol, pnlUsdt, fee, isWin) {
  try {
    const { query } = require('./db');
    const today = new Date().toISOString().split('T')[0];
    await query(
      `INSERT INTO token_daily_results (symbol, trade_date, total_trades, wins, losses, total_pnl, total_fee, avg_pnl, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $5, NOW())
       ON CONFLICT (symbol, trade_date) DO UPDATE SET
         total_trades = token_daily_results.total_trades + 1,
         wins = token_daily_results.wins + $3,
         losses = token_daily_results.losses + $4,
         total_pnl = token_daily_results.total_pnl + $5,
         total_fee = token_daily_results.total_fee + $6,
         avg_pnl = (token_daily_results.total_pnl + $5) / (token_daily_results.total_trades + 1),
         updated_at = NOW()`,
      [symbol, today, isWin ? 1 : 0, isWin ? 0 : 1, pnlUsdt, fee]
    );
  } catch (err) {
    bLog.error(`recordTokenResult error: ${err.message}`);
  }
}

/**
 * Get daily results leaderboard.
 */
async function getDailyResults(date = null) {
  try {
    const { query } = require('./db');
    const d = date || new Date().toISOString().split('T')[0];
    const rows = await query(
      `SELECT * FROM token_daily_results WHERE trade_date = $1 ORDER BY total_pnl DESC`,
      [d]
    );
    return rows;
  } catch { return []; }
}

module.exports = { scanAllTokens, getSignalBoard, getTokenSignal, recordTokenResult, getDailyResults };
