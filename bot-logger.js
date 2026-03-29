// ============================================================
// Bot Logger — In-memory ring buffer for live dashboard logs
// Categories: trade, scan, sentiment, ai, system, error
// ============================================================

const MAX_LOGS = 500;
const logs = [];

function addLog(category, message, data = null) {
  const entry = {
    id: Date.now() + Math.random(),
    ts: new Date().toISOString(),
    category,
    message,
    data,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();

  // Also print to console
  const tag = category.toUpperCase().padEnd(9);
  console.log(`[${entry.ts.slice(11, 19)}] [${tag}] ${message}`);
}

function getLogs(since = 0, category = null) {
  let filtered = logs.filter(l => l.id > since);
  if (category) filtered = filtered.filter(l => l.category === category);
  return filtered;
}

function getRecentLogs(count = 100, category = null) {
  let source = category ? logs.filter(l => l.category === category) : logs;
  return source.slice(-count);
}

// Convenience methods
const log = {
  trade:     (msg, data) => addLog('trade', msg, data),
  scan:      (msg, data) => addLog('scan', msg, data),
  sentiment: (msg, data) => addLog('sentiment', msg, data),
  ai:        (msg, data) => addLog('ai', msg, data),
  system:    (msg, data) => addLog('system', msg, data),
  error:     (msg, data) => addLog('error', msg, data),
};

module.exports = { addLog, getLogs, getRecentLogs, log };
