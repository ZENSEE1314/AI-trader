// NOTE: Background loop runs every 60 seconds. Stores latest findings in memory
// so the /api/monitor routes can serve them without hitting the DB on every request.
const { query } = require('./db');

const POLL_INTERVAL_MS = 60 * 1000;
const LAST_50_TRADES_LIMIT = 50;
const LAST_24H_INTERVAL = '24 hours';

// ── In-memory store — written by the loop, read by routes/monitor.js ─────────
const store = {
  winRate24h: 0,
  totalTrades24h: 0,
  pnl24h: 0,
  streak: { type: 'NONE', count: 0 },
  lastTrades: [],
  anomalies: [],
  lastChecked: null,
};

function getStore() {
  return store;
}

// ── Setup parsing ─────────────────────────────────────────────────────────────

// Extracts the pivot suffix from a setup string like "V4-LONG-HL+HL" → "HL+HL".
function parsePivotSuffix(setup) {
  if (!setup) return '';
  const lastDash = setup.lastIndexOf('-');
  return lastDash === -1 ? setup : setup.slice(lastDash + 1);
}

// Returns true when the pivot suffix and direction combination is invalid.
// LONG is only valid on HL/LL pivots (demand zones). SHORT on HH/LH (supply).
function isAnomalous(direction, setup) {
  const pivot = parsePivotSuffix(setup).toUpperCase();
  if (direction === 'LONG' && (pivot.includes('HH') || pivot.includes('LH'))) return true;
  if (direction === 'SHORT' && (pivot.includes('HL') || pivot.includes('LL'))) return true;
  return false;
}

function anomalyExplanation(direction, setup) {
  const pivot = parsePivotSuffix(setup);
  if (direction === 'LONG') {
    return `LONG entered on supply pivot "${pivot}" — only HL or LL pivots are valid LONG setups`;
  }
  return `SHORT entered on demand pivot "${pivot}" — only HH or LH pivots are valid SHORT setups`;
}

// ── Streak calculation ────────────────────────────────────────────────────────

function calcStreak(trades) {
  if (!trades.length) return { type: 'NONE', count: 0 };

  const sorted = [...trades].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const first = sorted[0].status;
  let count = 0;

  for (const t of sorted) {
    if (t.status !== first) break;
    count++;
  }

  return { type: first, count };
}

// ── Log formatting ────────────────────────────────────────────────────────────

function formatTradeLog(trade, winRate, streak) {
  const outcome = trade.status === 'WIN' ? '✅ WIN' : '❌ LOSS';
  const pnlSign = trade.pnl_usdt >= 0 ? '+' : '';
  const pnl = `${pnlSign}$${parseFloat(trade.pnl_usdt || 0).toFixed(2)}`;
  const pivot = parsePivotSuffix(trade.setup);
  const symbol = (trade.symbol || '???').replace('USDT', '');
  const streakLabel = streak.type === 'LOSS' ? `${streak.count}L` : `${streak.count}W`;

  return `[MONITOR] ${symbol} ${trade.direction} ${pivot} ${outcome} ${pnl} | Win%: ${winRate}% | Streak: ${streakLabel}`;
}

// ── Main monitoring cycle ─────────────────────────────────────────────────────

async function runCycle() {
  try {
    // Last 50 closed trades (any age) for streak + signal analysis
    const last50 = await query(
      `SELECT id, symbol, direction, status, pnl_usdt, setup, created_at
         FROM trades
        WHERE status IN ('WIN', 'LOSS')
          AND is_copy_trade = false
        ORDER BY created_at DESC
        LIMIT $1`,
      [LAST_50_TRADES_LIMIT]
    );

    // 24h window stats
    const stats24h = await query(
      `SELECT
         COUNT(*)                                                            AS total,
         ROUND(AVG(CASE WHEN status = 'WIN' THEN 1.0 ELSE 0.0 END) * 100, 1) AS win_rate,
         COALESCE(SUM(pnl_usdt), 0)                                         AS pnl
         FROM trades
        WHERE status IN ('WIN', 'LOSS')
          AND is_copy_trade = false
          AND created_at >= NOW() - INTERVAL '${LAST_24H_INTERVAL}'`
    );

    const row = stats24h[0] || {};
    const totalTrades24h = parseInt(row.total) || 0;
    const winRate24h = parseFloat(row.win_rate) || 0;
    const pnl24h = parseFloat(row.pnl) || 0;

    const streak = calcStreak(last50);

    // Last 5 closed trades formatted for API response
    const lastTrades = last50.slice(0, 5).map(t => ({
      symbol: t.symbol,
      direction: t.direction,
      setup: parsePivotSuffix(t.setup),
      status: t.status,
      pnl: parseFloat(t.pnl_usdt || 0),
      time: t.created_at,
    }));

    // Anomaly detection over last 50 trades
    const anomalies = last50
      .filter(t => isAnomalous(t.direction, t.setup))
      .map(t => ({
        id: t.id,
        symbol: t.symbol,
        direction: t.direction,
        setup: t.setup,
        status: t.status,
        pnl: parseFloat(t.pnl_usdt || 0),
        time: t.created_at,
        reason: anomalyExplanation(t.direction, t.setup),
      }));

    // Update shared store
    store.winRate24h = winRate24h;
    store.totalTrades24h = totalTrades24h;
    store.pnl24h = pnl24h;
    store.streak = streak;
    store.lastTrades = lastTrades;
    store.anomalies = anomalies;
    store.lastChecked = new Date().toISOString();

    // Console summary — last 5 trades + anomaly count
    const recentForLog = last50.slice(0, 5);
    for (const t of recentForLog) {
      console.log(formatTradeLog(t, winRate24h, streak));
    }

    if (anomalies.length > 0) {
      console.warn(`[MONITOR] ⚠️  ${anomalies.length} anomalous trade(s) detected in last ${LAST_50_TRADES_LIMIT}`);
      for (const a of anomalies) {
        const sym = (a.symbol || '???').replace('USDT', '');
        console.warn(`[MONITOR] ⚠️  ${sym} ${a.direction} "${a.setup}" — ${a.reason}`);
      }
    }

    console.log(
      `[MONITOR] 24h: ${totalTrades24h} trades | WR: ${winRate24h}% | PnL: $${pnl24h.toFixed(2)} | Streak: ${streak.count}${streak.type === 'NONE' ? '' : streak.type[0]}`
    );
  } catch (err) {
    // Never crash the process — log and continue
    console.error('[MONITOR] Cycle error:', err.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function startMonitor() {
  console.log('[MONITOR] Trade monitor started — polling every 60s');
  runCycle(); // immediate first run
  setInterval(runCycle, POLL_INTERVAL_MS);
}

module.exports = { startMonitor, getStore };
