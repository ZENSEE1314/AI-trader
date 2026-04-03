const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

async function query(sql, params) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ── Auto-create all required tables ─────────────────────────

let _tablesReady = false;
async function initAllTables() {
  if (_tablesReady) return;
  _tablesReady = true;
  const statements = [
    `CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      api_key_id INTEGER,
      user_id INTEGER,
      symbol VARCHAR(30),
      direction VARCHAR(10),
      entry_price DECIMAL,
      exit_price DECIMAL,
      sl_price DECIMAL,
      tp_price DECIMAL,
      quantity DECIMAL,
      leverage INTEGER DEFAULT 20,
      status VARCHAR(10) DEFAULT 'OPEN',
      pnl_usdt DECIMAL,
      error_msg TEXT,
      tf_15m VARCHAR(30),
      tf_3m VARCHAR(30),
      tf_1m VARCHAR(30),
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ai_trades (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(30),
      direction VARCHAR(10),
      setup VARCHAR(50),
      entry_price DECIMAL,
      exit_price DECIMAL,
      pnl_pct DECIMAL,
      is_win INTEGER DEFAULT 0,
      leverage INTEGER DEFAULT 20,
      duration_min INTEGER DEFAULT 0,
      session VARCHAR(20),
      rsi_at_entry DECIMAL,
      atr_pct DECIMAL,
      vol_ratio DECIMAL,
      sentiment_score DECIMAL,
      bb_position DECIMAL,
      score_at_entry DECIMAL,
      sl_distance_pct DECIMAL,
      tp_distance_pct DECIMAL,
      trend_1h VARCHAR(20),
      market_structure VARCHAR(50),
      closed_at TIMESTAMPTZ,
      tf_15m VARCHAR(30),
      tf_3m VARCHAR(30),
      tf_1m VARCHAR(30),
      exit_reason VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ai_parameter_history (
      id SERIAL PRIMARY KEY,
      param_name VARCHAR(50),
      old_value DECIMAL,
      new_value DECIMAL,
      reason TEXT,
      trade_count INTEGER,
      win_rate DECIMAL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Profit share columns on api_keys (per-user configurable by admin)
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS profit_share_user_pct DECIMAL DEFAULT 60`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS profit_share_admin_pct DECIMAL DEFAULT 40`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS paused_by_admin BOOLEAN DEFAULT false`,
    // Weekly earnings tracking
    `CREATE TABLE IF NOT EXISTS weekly_earnings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      api_key_id INTEGER,
      week_start DATE NOT NULL,
      week_end DATE NOT NULL,
      total_pnl DECIMAL DEFAULT 0,
      winning_pnl DECIMAL DEFAULT 0,
      user_share DECIMAL DEFAULT 0,
      admin_share DECIMAL DEFAULT 0,
      user_share_pct DECIMAL DEFAULT 60,
      admin_share_pct DECIMAL DEFAULT 40,
      trade_count INTEGER DEFAULT 0,
      win_count INTEGER DEFAULT 0,
      settled BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, api_key_id, week_start)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_versions (
      id SERIAL PRIMARY KEY,
      version INTEGER,
      trade_count INTEGER,
      win_rate DECIMAL,
      avg_pnl DECIMAL,
      total_pnl DECIMAL,
      params JSONB,
      setup_weights JSONB,
      avoided_coins JSONB,
      changes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error('[DB] Table init error:', err.message);
    }
  }
  console.log('[DB] All tables verified');
}

module.exports = { query, pool, initAllTables };
