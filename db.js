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
    // Admin can approve users to trade without subscription
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_no_sub BOOLEAN DEFAULT false`,
    // Profit share columns on api_keys (per-user configurable by admin)
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS profit_share_user_pct DECIMAL DEFAULT 60`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS profit_share_admin_pct DECIMAL DEFAULT 40`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS paused_by_admin BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_paid_at TIMESTAMPTZ DEFAULT NOW()`,
    // Cash wallet system (replaces subscription)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS cash_wallet DECIMAL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_earned DECIMAL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_fee_amount DECIMAL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_fee_due TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS usdt_address VARCHAR(100)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS usdt_network VARCHAR(20) DEFAULT 'BEP20'`,
    // Wallet transactions table
    `CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type VARCHAR(30) NOT NULL,
      amount DECIMAL NOT NULL,
      description TEXT,
      tx_hash TEXT,
      status VARCHAR(20) DEFAULT 'completed',
      ref_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wt_user_id ON wallet_transactions (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wt_type ON wallet_transactions (type)`,
    // Add status column if missing (for existing tables)
    `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed'`,
    `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS tx_hash TEXT`,
    // Withdrawals table
    `CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount DECIMAL NOT NULL,
      bank_name VARCHAR(100),
      account_number VARCHAR(100),
      account_name VARCHAR(100),
      status VARCHAR(20) DEFAULT 'pending',
      admin_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wd_user_id ON withdrawals (user_id)`,
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
    // Referral commission tracking
    `CREATE TABLE IF NOT EXISTS referral_commissions (
      id SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL,
      referee_id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      amount DECIMAL NOT NULL,
      description TEXT,
      trade_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rc_referrer_id ON referral_commissions (referrer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rc_referee_id ON referral_commissions (referee_id)`,
    // Token leverage settings
    `CREATE TABLE IF NOT EXISTS token_leverage (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(30) NOT NULL,
      leverage INTEGER DEFAULT 20,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(symbol)
    )`,
    // Risk level settings
    `CREATE TABLE IF NOT EXISTS risk_levels (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      description TEXT,
      tp_pct DECIMAL DEFAULT 0.045,
      sl_pct DECIMAL DEFAULT 0.03,
      max_consec_loss INTEGER DEFAULT 2,
      top_n_coins INTEGER DEFAULT 50,
      capital_percentage DECIMAL DEFAULT 10.0,
      max_leverage INTEGER DEFAULT 20,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // User risk level assignment
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS risk_level_id INTEGER`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS capital_percentage DECIMAL DEFAULT 10.0`,
    // Add referral tier columns
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_tier INTEGER DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_referral_commission DECIMAL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS ai_versions (
      id SERIAL PRIMARY KEY,
      version VARCHAR(20),
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
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_admin BOOLEAN DEFAULT false,
      is_blocked BOOLEAN DEFAULT false,
      referral_code VARCHAR(20) UNIQUE,
      referred_by INTEGER REFERENCES users(id),
      wallet_balance DECIMAL DEFAULT 0,
      telegram_id VARCHAR(50),
      reset_token VARCHAR(255),
      reset_token_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      platform VARCHAR(20) NOT NULL,
      label VARCHAR(100),
      api_key_enc TEXT NOT NULL,
      api_secret_enc TEXT NOT NULL,
      iv VARCHAR(64),
      auth_tag VARCHAR(64),
      secret_iv VARCHAR(64),
      secret_auth_tag VARCHAR(64),
      leverage INTEGER DEFAULT 20,
      risk_pct DECIMAL DEFAULT 0.10,
      max_loss_usdt DECIMAL,
      max_positions INTEGER DEFAULT 3,
      enabled BOOLEAN DEFAULT true,
      allowed_coins TEXT DEFAULT '',
      banned_coins TEXT DEFAULT '',
      tp_pct DECIMAL DEFAULT 0.045,
      sl_pct DECIMAL DEFAULT 0.03,
      max_consec_loss INTEGER DEFAULT 2,
      top_n_coins INTEGER DEFAULT 50,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      plan VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pending',
      amount DECIMAL,
      payment_method VARCHAR(30),
      proof_url TEXT,
      stripe_session_id VARCHAR(255),
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      type VARCHAR(30),
      amount DECIMAL,
      description TEXT,
      ref_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      amount DECIMAL,
      bank_name VARCHAR(100),
      account_number VARCHAR(50),
      account_name VARCHAR(100),
      status VARCHAR(20) DEFAULT 'pending',
      admin_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Global token settings (admin can enable/ban tokens for all users)
    `CREATE TABLE IF NOT EXISTS global_token_settings (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL UNIQUE,
      enabled BOOLEAN DEFAULT true,
      banned BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Per-key per-token user leverage overrides
    `CREATE TABLE IF NOT EXISTS user_token_leverage (
      id SERIAL PRIMARY KEY,
      api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      symbol VARCHAR(20) NOT NULL,
      leverage INTEGER NOT NULL CHECK (leverage >= 1 AND leverage <= 125),
      UNIQUE(api_key_id, symbol)
    )`,
    // Trailing SL columns on trades
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_sl_price NUMERIC`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_sl_last_step NUMERIC DEFAULT 0`,
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error('[DB] Table init error:', err.message);
    }
  }

  // Create indexes for frequently queried columns
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_trades_user_status ON trades (user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades (symbol, status)',
    'CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades (created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_ai_trades_symbol ON ai_trades (symbol)',
    'CREATE INDEX IF NOT EXISTS idx_ai_trades_setup ON ai_trades (setup)',
    'CREATE INDEX IF NOT EXISTS idx_ai_trades_created_at ON ai_trades (created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id, enabled)',
    'CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions (user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_global_tokens_symbol ON global_token_settings (symbol)',
    'CREATE INDEX IF NOT EXISTS idx_user_token_lev ON user_token_leverage (api_key_id, symbol)',
  ];

  for (const sql of indexes) {
    try { await pool.query(sql); } catch (_) {}
  }

  // Seed default platform settings
  const seeds = [
    `INSERT INTO settings (key, value) VALUES ('referral_commission_pct', '10') ON CONFLICT (key) DO NOTHING`,
  ];
  for (const sql of seeds) {
    try { await pool.query(sql); } catch (_) {}
  }

  console.log('[DB] All tables verified');
}

module.exports = { query, pool, initAllTables };
