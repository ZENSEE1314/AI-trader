const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: dbUrl.includes('sslmode=') ? dbUrl : `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}sslmode=require`,
  ssl: { rejectUnauthorized: false },
  max: 20,                    // raised from 10 — exhaustive optimizer + trading cycle + web requests all compete
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 60000,
  statement_timeout: 30000,
  query_timeout: 30000,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

async function query(sql, params, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await pool.query(sql, params);
      return res.rows;
    } catch (err) {
      const isTransient = err.message.includes('timeout') || err.message.includes('Connection terminated') || err.code === 'ECONNRESET';
      if (isTransient && attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
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
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(100)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance DECIMAL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_no_sub BOOLEAN DEFAULT false`,
    `ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS points DECIMAL DEFAULT 0`,
    // Profit share columns on api_keys (per-user configurable by admin)
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS profit_share_user_pct DECIMAL DEFAULT 60`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS profit_share_admin_pct DECIMAL DEFAULT 40`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS paused_by_admin BOOLEAN DEFAULT false`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS paused_by_user BOOLEAN DEFAULT false`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_paid_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS timer_paused_at TIMESTAMPTZ`,
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
    // Deposit requests — auto-detected via Bitunix API by amount+time matching
    `CREATE TABLE IF NOT EXISTS deposit_requests (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      amount       DECIMAL(18,6) NOT NULL,
      tx_hash      TEXT,
      network      VARCHAR(20) DEFAULT 'TRC20',
      status       VARCHAR(20) DEFAULT 'pending',
      note         TEXT,
      verified_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_deposit_req_user ON deposit_requests (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_deposit_req_status ON deposit_requests (status)`,
    `CREATE INDEX IF NOT EXISTS idx_deposit_req_txhash ON deposit_requests (tx_hash)`,
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
      sl_pct DECIMAL DEFAULT 0.20,
      max_consec_loss INTEGER DEFAULT 2,
      top_n_coins INTEGER DEFAULT 50,
      capital_percentage DECIMAL DEFAULT 10.0,
      max_leverage INTEGER DEFAULT 20,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Seed default risk levels if empty
    `INSERT INTO risk_levels (name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage)
     SELECT 'No Risk', 'Conservative — low risk', 0.02, 0.01, 1, 30, 5.0, 10
     WHERE NOT EXISTS (SELECT 1 FROM risk_levels WHERE name = 'No Risk')`,
    `INSERT INTO risk_levels (name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage)
     SELECT 'Medium Risk', 'Balanced risk-reward', 0.045, 0.03, 2, 50, 10.0, 20
     WHERE NOT EXISTS (SELECT 1 FROM risk_levels WHERE name = 'Medium Risk')`,
    `INSERT INTO risk_levels (name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage)
     SELECT 'High Risk', 'Aggressive trading', 0.08, 0.05, 3, 80, 20.0, 50
     WHERE NOT EXISTS (SELECT 1 FROM risk_levels WHERE name = 'High Risk')`,
    // User risk level assignment
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS risk_level_id INTEGER`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS capital_percentage DECIMAL DEFAULT 10.0`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS trailing_sl_step DECIMAL DEFAULT 1.2`,
    `ALTER TABLE risk_levels ADD COLUMN IF NOT EXISTS trailing_sl_step DECIMAL DEFAULT 1.2`,
    // Add referral tier columns
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_tier INTEGER DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_referral_commission DECIMAL DEFAULT 0`,
    // Per-user Bitunix affiliate referral link (set by user or admin)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bitunix_referral_link TEXT`,
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
    // Quantum AI strategy optimizer
    `CREATE TABLE IF NOT EXISTS quantum_strategy_combos (
      id SERIAL PRIMARY KEY,
      combo_id INTEGER NOT NULL,
      combo_name VARCHAR(100),
      total_trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      total_pnl DECIMAL DEFAULT 0,
      avg_pnl DECIMAL DEFAULT 0,
      win_rate DECIMAL DEFAULT 0,
      ema_win_rate DECIMAL DEFAULT 0.5,
      sharpe_estimate DECIMAL DEFAULT 0,
      is_active BOOLEAN DEFAULT false,
      is_exploring BOOLEAN DEFAULT false,
      admin_locked BOOLEAN DEFAULT false,
      last_trade_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(combo_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_qsc_combo_id ON quantum_strategy_combos (combo_id)`,
    `ALTER TABLE quantum_strategy_combos ADD COLUMN IF NOT EXISTS best_params JSONB`,
    `ALTER TABLE ai_trades ADD COLUMN IF NOT EXISTS combo_id INTEGER DEFAULT 15`,
    `ALTER TABLE ai_trades ADD COLUMN IF NOT EXISTS vwap_zone VARCHAR(20)`,
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100),
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
      sl_pct DECIMAL DEFAULT 0.20,
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
    `CREATE TABLE IF NOT EXISTS strategy_config_versions (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      config    JSONB NOT NULL,
      is_active BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_definitions (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      is_builtin  BOOLEAN DEFAULT false,
      is_enabled  BOOLEAN DEFAULT true,
      config      JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
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
      "rank" INTEGER DEFAULT 999,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE global_token_settings ADD COLUMN IF NOT EXISTS "rank" INTEGER DEFAULT 999`,
    `ALTER TABLE global_token_settings ADD COLUMN IF NOT EXISTS risk_tag VARCHAR(20) DEFAULT NULL`,
    `ALTER TABLE global_token_settings ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT false`,
    `ALTER TABLE global_token_settings ADD COLUMN IF NOT EXISTS direction_override VARCHAR(10) DEFAULT NULL`,
    // Per-key per-token user leverage overrides
    `CREATE TABLE IF NOT EXISTS user_token_leverage (
      id SERIAL PRIMARY KEY,
      api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      symbol VARCHAR(20) NOT NULL,
      leverage INTEGER NOT NULL CHECK (leverage >= 1 AND leverage <= 125),
      UNIQUE(api_key_id, symbol)
    )`,
    // Trailing SL columns on trades
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_price DECIMAL`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS error_msg TEXT`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS tf_15m VARCHAR(30)`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS tf_3m VARCHAR(30)`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS tf_1m VARCHAR(30)`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_sl_price NUMERIC`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_sl_last_step NUMERIC DEFAULT 0`,
    // Market structure and user trailing config
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS market_structure VARCHAR(50)`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS key_trailing_sl_step NUMERIC DEFAULT 0`,
    // Setup/strategy tag — required for per-setup WR analysis
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS setup VARCHAR(50)`,
    `CREATE INDEX IF NOT EXISTS idx_trades_setup ON trades (setup)`,
    // Agent survival system — $1000 capital, HP health, kill on 0
    `CREATE TABLE IF NOT EXISTS agent_survival (
      agent VARCHAR(50) PRIMARY KEY,
      health INTEGER DEFAULT 100,
      is_alive BOOLEAN DEFAULT true,
      capital NUMERIC DEFAULT 1000,
      monthly_pnl NUMERIC DEFAULT 0,
      month_start VARCHAR(7) DEFAULT '',
      start_capital NUMERIC DEFAULT 1000,
      total_trades INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_losses INTEGER DEFAULT 0,
      kill_reason TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Trade fee tracking
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trading_fee NUMERIC DEFAULT 0`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS gross_pnl NUMERIC`,
    // Funding fee tracked separately from exchange trading fee
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS funding_fee NUMERIC DEFAULT 0`,
    // Bitunix position ID — stored at open, used for exact match at sync (no guessing)
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS bitunix_position_id VARCHAR(64)`,
    // Exit reason — recorded when bot closes a trade (triple_ma, spike_hl, swarm, etc.)
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(100)`,
    // User token watchlist (which tokens each user wants to trade)
    `CREATE TABLE IF NOT EXISTS user_watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      symbol VARCHAR(30) NOT NULL,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, symbol)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist (user_id)`,
    // Token daily results (aggregated daily P&L per token)
    `CREATE TABLE IF NOT EXISTS token_daily_results (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(30) NOT NULL,
      trade_date DATE NOT NULL,
      total_trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      total_pnl NUMERIC DEFAULT 0,
      total_fee NUMERIC DEFAULT 0,
      avg_pnl NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(symbol, trade_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_token_daily_date ON token_daily_results (trade_date DESC)`,
    // Agent memory (persists across restarts)
    `CREATE TABLE IF NOT EXISTS agent_memory (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB,
      category TEXT DEFAULT 'general',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent, key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory (agent)`,
    // Agent learning log
    `CREATE TABLE IF NOT EXISTS agent_lessons (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      type TEXT NOT NULL,
      input JSONB,
      outcome JSONB,
      lesson TEXT,
      score NUMERIC DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS pattern_penalties (
      id SERIAL PRIMARY KEY,
      pattern_dna TEXT UNIQUE NOT NULL,
      loss_count INTEGER DEFAULT 0,
      win_count INTEGER DEFAULT 0,
      current_penalty DECIMAL DEFAULT 0.0,
      last_updated TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pattern_dna ON pattern_penalties (pattern_dna)`,

    // Agent profiles — level, XP, earnings tracking (RPG system)
    `CREATE TABLE IF NOT EXISTS agent_profiles (
      agent TEXT PRIMARY KEY,
      level INTEGER DEFAULT 1,
      xp INTEGER DEFAULT 0,
      total_earned NUMERIC DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      tasks_success INTEGER DEFAULT 0,
      points DECIMAL DEFAULT 0,
      tier VARCHAR(20) DEFAULT 'Bronze',
      monthly_pnl NUMERIC DEFAULT 0,
      monthly_risk NUMERIC DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS agent_trophies (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      month VARCHAR(10) NOT NULL,
      trophy_type VARCHAR(50),
      buff_multiplier DECIMAL DEFAULT 1.0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent, month)
    )`,
    `CREATE TABLE IF NOT EXISTS user_agent_preferences (
      id SERIAL PRIMARY KEY,
      api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      preferred_agent TEXT,
      min_tier VARCHAR(20),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(api_key_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_at_agent ON agent_trophies (agent)`,
    `CREATE INDEX IF NOT EXISTS idx_uap_key ON user_agent_preferences (api_key_id)`,
    // Kronos AI predictions (persisted so dashboard can read them)
    `CREATE TABLE IF NOT EXISTS kronos_predictions (
      symbol VARCHAR(20) PRIMARY KEY,
      direction VARCHAR(10),
      current_price NUMERIC,
      predicted_price NUMERIC,
      change_pct NUMERIC,
      confidence VARCHAR(10),
      trend VARCHAR(20),
      pred_high NUMERIC,
      pred_low NUMERIC,
      scanned_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Strategy backtests (StrategyAgent saves results here)
    `CREATE TABLE IF NOT EXISTS strategy_backtests (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      params JSONB NOT NULL,
      total_trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      win_rate NUMERIC DEFAULT 0,
      total_pnl NUMERIC DEFAULT 0,
      avg_win NUMERIC DEFAULT 0,
      avg_loss NUMERIC DEFAULT 0,
      max_drawdown NUMERIC DEFAULT 0,
      symbols JSONB DEFAULT '[]',
      top_trades JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_backtests_name ON strategy_backtests (name)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_backtests_created ON strategy_backtests (created_at DESC)`,
    // Agent jail records (PoliceAgent tracks violations)
    `CREATE TABLE IF NOT EXISTS agent_jail (
      id SERIAL PRIMARY KEY,
      agent_key VARCHAR(50) NOT NULL,
      agent_name VARCHAR(100) NOT NULL,
      reason TEXT NOT NULL,
      violation_type VARCHAR(50),
      severity VARCHAR(20),
      warnings INTEGER DEFAULT 0,
      jailed_at TIMESTAMPTZ DEFAULT NOW(),
      released_at TIMESTAMPTZ,
      released_by VARCHAR(100)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_jail_key ON agent_jail (agent_key)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_jail_active ON agent_jail (released_at) WHERE released_at IS NULL`,
    // CoderAgent patch records (self-healing code history)
    `CREATE TABLE IF NOT EXISTS code_patches (
      id SERIAL PRIMARY KEY,
      file VARCHAR(200) NOT NULL,
      description TEXT,
      patch_type VARCHAR(30),
      search_text TEXT,
      replace_text TEXT,
      confidence NUMERIC DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      applied_at TIMESTAMPTZ,
      reverted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_code_patches_status ON code_patches (status)`,
    // Discovered strategies (StrategyAgent autonomous discovery)
    `CREATE TABLE IF NOT EXISTS discovered_strategies (
      strategy_id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(200),
      recipe VARCHAR(100),
      params JSONB,
      win_rate NUMERIC DEFAULT 0,
      total_pnl NUMERIC DEFAULT 0,
      total_trades INTEGER DEFAULT 0,
      generation INTEGER DEFAULT 1,
      source VARCHAR(50) DEFAULT 'random',
      parent_id VARCHAR(200),
      is_active BOOLEAN DEFAULT true,
      adopted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_disc_strat_wr ON discovered_strategies (win_rate DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_disc_strat_source ON discovered_strategies (source)`,
    // Agent trade history — full record of every trade per agent
    `CREATE TABLE IF NOT EXISTS agent_trade_history (
      id SERIAL PRIMARY KEY,
      agent VARCHAR(100) NOT NULL,
      symbol VARCHAR(30),
      direction VARCHAR(10),
      entry_price NUMERIC,
      exit_price NUMERIC,
      pnl_usdt NUMERIC,
      is_win BOOLEAN,
      strategy VARCHAR(200),
      setup VARCHAR(100),
      leverage INTEGER DEFAULT 20,
      capital_after NUMERIC,
      health_after INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_trades_agent ON agent_trade_history (agent)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_trades_created ON agent_trade_history (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_trades_symbol ON agent_trade_history (symbol)`,
    // Add total_revenue column to agent_survival
    `ALTER TABLE agent_survival ADD COLUMN IF NOT EXISTS total_revenue NUMERIC DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS swarm_predictions (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20),
      direction VARCHAR(10),
      target_price DECIMAL,
      confidence INTEGER,
      predicted_at TIMESTAMPTZ DEFAULT NOW(),
      verified_at TIMESTAMPTZ,
      is_correct BOOLEAN,
      actual_move_pct DECIMAL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_pred_symbol ON swarm_predictions (symbol)`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_pred_verified ON swarm_predictions (verified_at)`,
    // Optimizer candle cache (survives redeploys)
    `CREATE TABLE IF NOT EXISTS optimizer_cache (
      id INTEGER PRIMARY KEY,
      cache_key TEXT,
      candle_data JSONB,
      created_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS backtest_gate (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(30) NOT NULL,
      strategy VARCHAR(50) NOT NULL,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      total_trades INTEGER DEFAULT 0,
      win_rate DECIMAL DEFAULT 0,
      tested_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(symbol, strategy)
    )`,
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
    'CREATE INDEX IF NOT EXISTS idx_trades_user_closed ON trades (user_id, closed_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_trades_api_key_status ON trades (api_key_id, status)',
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

  // V4 SMC token leverage — upsert on every boot (safe to re-run)
  // Config: BTC/ETH/BNB=100x, ADA/SOL/AVAX=75x (backtest-validated 89.6% WR)
  try {
    await pool.query(
      `INSERT INTO token_leverage (symbol, leverage, enabled) VALUES
         ('BTCUSDT',  100, true),
         ('ETHUSDT',  100, true),
         ('BNBUSDT',  100, true),
         ('ADAUSDT',   75, true),
         ('SOLUSDT',   75, true),
         ('AVAXUSDT',  75, true)
       ON CONFLICT (symbol) DO UPDATE SET leverage = EXCLUDED.leverage, enabled = true`
    );
    console.log('[DB] V4 SMC leverage: BTC/ETH/BNB=100×, ADA/SOL/AVAX=75×');
  } catch (_) {}

  // Clean up truly delisted/invalid symbols only — do NOT remove active strategy tokens
  const badSymbols = ['PEPEUSDT', 'SHIBUSDT', 'STABLEUSDT', 'NIGHTUSDT'];
  for (const sym of badSymbols) {
    try { await pool.query('DELETE FROM global_token_settings WHERE symbol = $1', [sym]); } catch (_) {}
  }

  // Sync global_token_settings with ACTIVE_SYMBOLS — always upsert all active tokens.
  // This runs every boot so adding/removing coins from strategy-v4-smc.js auto-syncs the DB.
  try {
    const { ACTIVE_SYMBOLS } = require('./strategy-v4-smc');
    const rankMap = {};
    ACTIVE_SYMBOLS.forEach((sym, i) => { rankMap[sym] = i + 1; });
    for (const sym of ACTIVE_SYMBOLS) {
      await pool.query(
        `INSERT INTO global_token_settings (symbol, enabled, banned, "rank")
         VALUES ($1, true, false, $2)
         ON CONFLICT (symbol) DO UPDATE
           SET enabled = true, banned = false, "rank" = EXCLUDED."rank"`,
        [sym, rankMap[sym]]
      );
    }
    console.log(`[DB] Token pool synced: ${ACTIVE_SYMBOLS.join(', ')}`);
  } catch (e) {
    console.error('[DB] Token pool sync failed:', e.message);
  }

  // Seed built-in strategy definitions on first boot
  try {
    const sdCount = await pool.query('SELECT COUNT(*) FROM strategy_definitions WHERE is_builtin = true');
    if (parseInt(sdCount.rows[0].count, 10) === 0) {
      const builtins = [
        {
          name: 'SMC Engine',
          description: '2-gate SMC: 3m HL/LH sets direction, 1m HL/LH confirms entry near fresh swing. EMA200 bias penalty.',
          config: {
            timeframe: '1m', symbols: ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'],
            sl_pct: 0.005, tp_multiplier: 2.0, trailing_step: 0.012, size_pct: 0.10,
            indicators: {
              hl_structure: { enabled: true,  primary_tf: '3m', confirm_tf: '1m', primary_swing: 5, confirm_swing: 4, max_candle_age: 20, max_chase_pct: 0.015 },
              ema_filter:   { enabled: true,  period: 200, htf: '1h', strict: false },
              vol_filter:   { enabled: true,  sma_period: 9, min_ratio: 1.0 },
              candle_dir:   { enabled: false },
              session_gate: { enabled: false, asia_start: 23, asia_end: 2, europe_start: 7, europe_end: 10, us_start: 12, us_end: 16, grace_ms: 90000 },
              prime_session: { enabled: false, grace_ms: 90000 },
              vwap_filter:  { enabled: false, tolerance: 0.001 },
              atr_gate:     { enabled: false, period: 14, min_pct: 0, max_pct: 1.0 },
              ma_stack:     { enabled: false, min_spread: 0.0007, min_spread_growth: 1.2, max_extension_atr: 1.5, atr_period: 14 },
              tjunction:    { enabled: false, converge_band: 0.0025, converge_min: 2, diverge_min: 0.0012 },
              spike_hl:     { enabled: false, min_spike_pct: 0.0015, max_spike_pct: 0.015, min_wick_ratio: 1.2, sl_buffer: 0.001 },
              rsi_filter:   { enabled: false, period: 14, oversold: 40, overbought: 60 },
            },
          },
        },
        {
          name: 'T-Junction',
          description: 'MA5/10/20 converge into a T-stem then fan out. Fires in prime UTC sessions only. VWAP + volume confirmed.',
          config: {
            timeframe: '5m', symbols: ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'],
            sl_pct: 0.010, tp_multiplier: 2.0, trailing_step: 0, size_pct: 0.10,
            indicators: {
              prime_session: { enabled: true,  grace_ms: 90000 },
              tjunction:     { enabled: true,  converge_band: 0.0025, converge_min: 2, diverge_min: 0.0012 },
              vwap_filter:   { enabled: true,  tolerance: 0.001 },
              vol_filter:    { enabled: true,  sma_period: 9, min_ratio: 1.0 },
              candle_dir:    { enabled: true  },
              ema_filter:    { enabled: false, period: 200, htf: '1h', strict: false },
              session_gate:  { enabled: false, asia_start: 23, asia_end: 2, europe_start: 7, europe_end: 10, us_start: 12, us_end: 16, grace_ms: 90000 },
              atr_gate:      { enabled: false, period: 14, min_pct: 0, max_pct: 1.0 },
              hl_structure:  { enabled: false, primary_tf: '3m', confirm_tf: '1m', primary_swing: 5, confirm_swing: 4, max_candle_age: 20, max_chase_pct: 0.015 },
              ma_stack:      { enabled: false, min_spread: 0.0007, min_spread_growth: 1.2, max_extension_atr: 1.5, atr_period: 14 },
              spike_hl:      { enabled: false, min_spike_pct: 0.0015, max_spike_pct: 0.015, min_wick_ratio: 1.2, sl_buffer: 0.001 },
              rsi_filter:    { enabled: false, period: 14, oversold: 40, overbought: 60 },
            },
          },
        },
        {
          name: 'MA Stack Trend',
          description: 'SMA5/10/20 strict order + active fan opening. Trending setups only. VWAP + ATR + volume gated.',
          config: {
            timeframe: '1m', symbols: ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'],
            sl_pct: 0.015, tp_multiplier: 2.0, trailing_step: 0, size_pct: 0.10,
            indicators: {
              ma_stack:     { enabled: true,  min_spread: 0.0007, min_spread_growth: 1.2, max_extension_atr: 1.5, atr_period: 14 },
              atr_gate:     { enabled: true,  period: 14, min_pct: 0.003, max_pct: 1.0 },
              vwap_filter:  { enabled: true,  tolerance: 0.001 },
              vol_filter:   { enabled: true,  sma_period: 9, min_ratio: 1.0 },
              candle_dir:   { enabled: true  },
              ema_filter:   { enabled: false, period: 200, htf: '1h', strict: false },
              session_gate: { enabled: false, asia_start: 23, asia_end: 2, europe_start: 7, europe_end: 10, us_start: 12, us_end: 16, grace_ms: 90000 },
              prime_session:{ enabled: false, grace_ms: 90000 },
              hl_structure: { enabled: false, primary_tf: '3m', confirm_tf: '1m', primary_swing: 5, confirm_swing: 4, max_candle_age: 20, max_chase_pct: 0.015 },
              tjunction:    { enabled: false, converge_band: 0.0025, converge_min: 2, diverge_min: 0.0012 },
              spike_hl:     { enabled: false, min_spike_pct: 0.0015, max_spike_pct: 0.015, min_wick_ratio: 1.2, sl_buffer: 0.001 },
              rsi_filter:   { enabled: false, period: 14, oversold: 40, overbought: 60 },
            },
          },
        },
        {
          name: 'Spike-HL Sweep',
          description: 'Smart-money pivot rejection. Wick sweeps a stop level then closes back. Session gated + EMA trend bias.',
          config: {
            timeframe: '1m', symbols: ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'],
            sl_pct: 0.005, tp_multiplier: 3.0, trailing_step: 0, size_pct: 0.10,
            indicators: {
              spike_hl:     { enabled: true,  min_spike_pct: 0.0015, max_spike_pct: 0.015, min_wick_ratio: 1.2, sl_buffer: 0.001 },
              session_gate: { enabled: true,  asia_start: 23, asia_end: 2, europe_start: 7, europe_end: 10, us_start: 12, us_end: 16, grace_ms: 90000 },
              ema_filter:   { enabled: true,  period: 200, htf: '1h', strict: false },
              vwap_filter:  { enabled: false, tolerance: 0.001 },
              vol_filter:   { enabled: false, sma_period: 9, min_ratio: 1.0 },
              candle_dir:   { enabled: false },
              prime_session:{ enabled: false, grace_ms: 90000 },
              atr_gate:     { enabled: false, period: 14, min_pct: 0, max_pct: 1.0 },
              hl_structure: { enabled: false, primary_tf: '3m', confirm_tf: '1m', primary_swing: 5, confirm_swing: 4, max_candle_age: 20, max_chase_pct: 0.015 },
              ma_stack:     { enabled: false, min_spread: 0.0007, min_spread_growth: 1.2, max_extension_atr: 1.5, atr_period: 14 },
              tjunction:    { enabled: false, converge_band: 0.0025, converge_min: 2, diverge_min: 0.0012 },
              rsi_filter:   { enabled: false, period: 14, oversold: 40, overbought: 60 },
            },
          },
        },
      ];
      for (const b of builtins) {
        await pool.query(
          `INSERT INTO strategy_definitions (name, description, is_builtin, is_enabled, config)
           VALUES ($1, $2, true, true, $3)`,
          [b.name, b.description, JSON.stringify(b.config)]
        );
      }
      console.log('[DB] Built-in strategy definitions seeded (4)');
    }
  } catch (err) { console.error('[DB] Strategy seed error:', err.message); }

  // Strategy Version Manager — split into separate try blocks so one failure
  // does not suppress the others. No UNIQUE on column; index is created separately.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS strategy_versions (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(200) NOT NULL,
        genome        JSONB        NOT NULL,
        genome_hash   VARCHAR(64),
        win_rate      DECIMAL(8,4),
        profit_factor DECIMAL(8,4),
        total_return  DECIMAL(12,4),
        max_drawdown  DECIMAL(8,4),
        expectancy    DECIMAL(12,4),
        sharpe        DECIMAL(8,4),
        total_trades  INTEGER,
        wins          INTEGER,
        losses        INTEGER,
        fitness       DECIMAL(12,4),
        source        VARCHAR(50)  DEFAULT 'optimizer',
        symbols       TEXT,
        is_active     BOOLEAN      DEFAULT FALSE,
        activated_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    console.log('[DB] strategy_versions table ready');
  } catch (e) { console.error('[DB] strategy_versions create error:', e.message); }

  try {
    await pool.query(`ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS genome_hash VARCHAR(64)`);
  } catch (_) {}

  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sv_genome_hash ON strategy_versions (genome_hash) WHERE genome_hash IS NOT NULL`);
  } catch (_) {}

  // Migration: change trades.api_key_id FK to ON DELETE SET NULL so keys can be
  // deleted without wiping trade history. Also makes the column nullable.
  try {
    await pool.query(`ALTER TABLE trades ALTER COLUMN api_key_id DROP NOT NULL`);
  } catch (_) {}
  try {
    await pool.query(`ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_api_key_id_fkey`);
    await pool.query(`ALTER TABLE trades ADD CONSTRAINT trades_api_key_id_fkey
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL`);
  } catch (e) { console.warn('[DB] trades FK migration warning:', e.message); }


  // ── Fee backfill: deduct 0.12% round-trip fee for old trades missing it ─
  // Applies to CLOSED trades where trading_fee is NULL/0 but gross_pnl is set.
  // 0.12% = 0.06% maker each leg (Bitunix default). Safe to run on every boot.
  try {
    const backfillResult = await pool.query(`
      UPDATE trades
      SET
        trading_fee = ROUND(exit_price * quantity * 0.0012, 4),
        pnl_usdt    = ROUND(gross_pnl  - (exit_price * quantity * 0.0012), 4),
        status      = CASE
                        WHEN gross_pnl - (exit_price * quantity * 0.0012) > 0 THEN 'WIN'
                        ELSE 'LOSS'
                      END
      WHERE status IN ('WIN','LOSS','CLOSED')
        AND (trading_fee IS NULL OR trading_fee = 0)
        AND gross_pnl    IS NOT NULL
        AND exit_price   IS NOT NULL
        AND quantity     IS NOT NULL AND quantity > 0
    `);
    if (backfillResult.rowCount > 0) {
      console.log(`[DB] Fee backfill: updated ${backfillResult.rowCount} trade(s) with estimated 0.12% round-trip fee`);
    }
  } catch (e) { console.warn('[DB] Fee backfill warning:', e.message); }

  console.log('[DB] All tables verified');
}

module.exports = { query, pool, initAllTables };
