-- ── Polymarket Copy Trade tables ─────────────────────────────
-- Run once: psql $DATABASE_URL -f migrations/add_polymarket.sql

-- Trade log for every copied Polymarket order
CREATE TABLE IF NOT EXISTS polymarket_trades (
  id              SERIAL PRIMARY KEY,
  api_key_id      INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id)    ON DELETE CASCADE,
  target_address  TEXT    NOT NULL,
  token_id        TEXT    NOT NULL,
  market_slug     TEXT,
  question        TEXT,
  side            TEXT    NOT NULL CHECK (side IN ('BUY','SELL')),
  price           NUMERIC(10,4) NOT NULL,
  usdc_amount     NUMERIC(12,4) NOT NULL,
  shares          NUMERIC(16,4),
  order_id        TEXT,
  status          TEXT    DEFAULT 'submitted',
  outcome         TEXT,                   -- WIN / LOSS / PENDING (filled in later)
  resolved_pnl    NUMERIC(12,4),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE (api_key_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_trades_user    ON polymarket_trades (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_trades_key     ON polymarket_trades (api_key_id);
CREATE INDEX IF NOT EXISTS idx_pm_trades_target  ON polymarket_trades (target_address);

-- Leaderboard snapshot cache (so we can show users who we're following)
CREATE TABLE IF NOT EXISTS polymarket_leaderboard (
  id          SERIAL PRIMARY KEY,
  address     TEXT  NOT NULL,
  name        TEXT,
  pnl         NUMERIC(16,2),
  volume      NUMERIC(16,2),
  trades      INTEGER,
  window      TEXT DEFAULT '1m',
  rank        INTEGER,
  is_target   BOOLEAN DEFAULT false,
  fetched_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Config flags (stored in v4_config table, no schema change needed)
-- Keys used:
--   polymarket_enabled        = 'true' | 'false'
--   polymarket_target         = '<wallet_address>'  (optional override; '' = use #1 leaderboard)
--   polymarket_multiplier     = '0.1'
--   polymarket_max_usdc       = '50'
--   polymarket_buy_only       = 'true'
