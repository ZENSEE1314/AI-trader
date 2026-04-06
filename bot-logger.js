// ============================================================
// Bot Logger — Dual storage: in-memory buffer + PostgreSQL
// Categories: trade, scan, sentiment, ai, system, error
// Logs persist across redeploys for AI learning & case study
// ============================================================

const { query } = require('./db');

const MAX_MEMORY_LOGS = 500;
const memoryLogs = [];
let dbReady = false;

// Auto-create table on first load
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS bot_logs (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ DEFAULT NOW(),
        category VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        data JSONB,
        symbol VARCHAR(30),
        direction VARCHAR(10),
        score DECIMAL,
        result VARCHAR(20),
        user_id INTEGER
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_ts ON bot_logs (ts DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_category ON bot_logs (category)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_symbol ON bot_logs (symbol)`);
    await query(`ALTER TABLE bot_logs ADD COLUMN IF NOT EXISTS user_id INTEGER`);
    await query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_user_id ON bot_logs (user_id)`);
    dbReady = true;
    console.log('[LOGGER] PostgreSQL bot_logs table ready');
  } catch (err) {
    console.error('[LOGGER] Failed to create bot_logs table:', err.message);
  }
})();

function extractSymbol(message) {
  const match = message.match(/^([A-Z0-9]+USDT)/);
  return match ? match[1] : null;
}

function extractDirection(message) {
  if (message.includes(' LONG ')) return 'LONG';
  if (message.includes(' SHORT ')) return 'SHORT';
  return null;
}

function extractScore(message) {
  const match = message.match(/score=(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function extractResult(message) {
  if (message.includes('✅')) return 'SIGNAL';
  if (message.includes('not fully aligned')) return 'TF_FAIL';
  if (message.includes('NO CONFIRM')) return 'CONFIRM_FAIL';
  if (message.includes('WAITING')) return 'ENTRY_WAIT';
  if (message.includes('STALE')) return 'STALE';
  if (message.includes('WAIT 1 CANDLE')) return 'WAIT_CANDLE';
  if (message.includes('TRADE OPENED')) return 'OPENED';
  if (message.includes('consecutive losses')) return 'COOLDOWN';
  return null;
}

const TIMEZONE = 'Asia/Singapore';

function toLocalTime(date) {
  return date.toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function addLog(category, message, data = null, userId = null) {
  const now = new Date();
  const entry = {
    id: Date.now() + Math.random(),
    ts: now.toISOString(),
    tsLocal: toLocalTime(now),
    category,
    message,
    data,
    user_id: userId,
  };

  // In-memory buffer for live dashboard
  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) memoryLogs.shift();

  // Console output in Singapore time
  const tag = category.toUpperCase().padEnd(9);
  console.log(`[${entry.tsLocal}] [${tag}] ${message}`);

  // Persist to PostgreSQL (non-blocking)
  if (dbReady) {
    const symbol = extractSymbol(message);
    const direction = extractDirection(message);
    const score = extractScore(message);
    const result = extractResult(message);

    query(
      `INSERT INTO bot_logs (ts, category, message, data, symbol, direction, score, result, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.ts, category, message, data ? JSON.stringify(data) : null,
       symbol, direction, score, result, userId]
    ).catch(err => {
      console.error('[LOGGER] DB write failed:', err.message);
    });
  }
}

// Live dashboard: in-memory for speed (userId=null = system logs only, 'all' = everything)
function getLogs(since = 0, category = null, userId = null) {
  let filtered = memoryLogs.filter(l => l.id > since);
  if (category) filtered = filtered.filter(l => l.category === category);
  if (userId !== 'all') {
    // Show system logs (no user_id) + caller's own logs
    filtered = filtered.filter(l => !l.user_id || l.user_id === userId);
  }
  return filtered;
}

function getRecentLogs(count = 100, category = null, userId = null) {
  let source = category ? memoryLogs.filter(l => l.category === category) : memoryLogs;
  if (userId !== 'all') {
    source = source.filter(l => !l.user_id || l.user_id === userId);
  }
  return source.slice(-count);
}

// DB queries for historical logs (survives redeploys)
async function getHistoricalLogs(opts = {}) {
  const { category, symbol, limit = 200, offset = 0, startDate, endDate, userId } = opts;
  let where = [];
  let params = [];
  let idx = 1;

  if (category) { where.push(`category = $${idx++}`); params.push(category); }
  if (symbol) { where.push(`symbol = $${idx++}`); params.push(symbol); }
  if (startDate) { where.push(`ts >= $${idx++}`); params.push(startDate); }
  if (endDate) { where.push(`ts <= $${idx++}`); params.push(endDate); }

  // User scoping: system logs (user_id IS NULL) + own logs, unless admin (userId === 'all')
  if (userId && userId !== 'all') {
    where.push(`(user_id IS NULL OR user_id = $${idx++})`);
    params.push(userId);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return query(
    `SELECT id, ts, category, message, data, symbol, direction, score, result, user_id
     FROM bot_logs ${whereClause} ORDER BY ts DESC LIMIT $${idx++} OFFSET $${idx}`,
    [...params, limit, offset]
  );
}

// Analytics: scan performance stats for AI learning
async function getScanStats(days = 7) {
  return query(`
    SELECT
      symbol,
      COUNT(*) FILTER (WHERE result = 'SIGNAL') as signals,
      COUNT(*) FILTER (WHERE result = 'HTF_FAIL') as htf_fails,
      COUNT(*) FILTER (WHERE result = 'LEVEL_FAIL') as level_fails,
      COUNT(*) FILTER (WHERE result = 'SETUP_FAIL') as setup_fails,
      COUNT(*) FILTER (WHERE result = 'ENTRY_WAIT') as entry_waits,
      COUNT(*) FILTER (WHERE result = 'STALE') as stale,
      COUNT(*) as total_scans
    FROM bot_logs
    WHERE category = 'scan' AND symbol IS NOT NULL
      AND ts > NOW() - INTERVAL '${parseInt(days)} days'
    GROUP BY symbol
    ORDER BY signals DESC
  `);
}

// Get signal hit rate per coin for AI learning
async function getSignalHistory(symbol, days = 30) {
  return query(
    `SELECT ts, message, direction, score, result
     FROM bot_logs
     WHERE category = 'scan' AND symbol = $1 AND result = 'SIGNAL'
       AND ts > NOW() - INTERVAL '${parseInt(days)} days'
     ORDER BY ts DESC`,
    [symbol]
  );
}

// Log count by category (for dashboard stats)
async function getLogCounts() {
  return query(`
    SELECT category, COUNT(*) as cnt,
           MIN(ts) as first_log, MAX(ts) as last_log
    FROM bot_logs
    GROUP BY category
    ORDER BY cnt DESC
  `);
}

// Convenience methods
const log = {
  trade:     (msg, data, userId) => addLog('trade', msg, data, userId),
  scan:      (msg, data, userId) => addLog('scan', msg, data, userId),
  sentiment: (msg, data, userId) => addLog('sentiment', msg, data, userId),
  ai:        (msg, data, userId) => addLog('ai', msg, data, userId),
  system:    (msg, data, userId) => addLog('system', msg, data, userId),
  error:     (msg, data, userId) => addLog('error', msg, data, userId),
};

module.exports = {
  addLog, getLogs, getRecentLogs, log,
  getHistoricalLogs, getScanStats, getSignalHistory, getLogCounts,
};
