const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { USDMClient } = require('binance');
const cryptoUtils = require('../crypto-utils');

const router = express.Router();
router.use(authMiddleware);

const PERIOD_INTERVALS = {
  '1d':  '1 day',
  '7d':  '7 days',
  '30d': '30 days',
  '6m':  '6 months',
  '1y':  '1 year',
};

// Trade history
router.get('/trades', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const period = PERIOD_INTERVALS[req.query.period];

    const params = [req.userId];
    const dateFilter = period
      ? `AND t.created_at > NOW() - INTERVAL '${period}'`
      : '';
    const dateFilterCount = period
      ? `AND created_at > NOW() - INTERVAL '${period}'`
      : '';

    const rows = await query(
      `SELECT t.*, ak.label as key_label, ak.platform
       FROM trades t
       LEFT JOIN api_keys ak ON t.api_key_id = ak.id
       WHERE t.user_id = $1 ${dateFilter}
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    const countRes = await query(
      `SELECT COUNT(*) as cnt FROM trades WHERE user_id = $1 ${dateFilterCount}`,
      [req.userId]
    );
    res.json({ trades: rows, total: parseInt(countRes[0].cnt), page, pages: Math.ceil(countRes[0].cnt / limit) });
  } catch (err) {
    console.error('Trades error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// P&L summary (supports ?period=1d|7d|30d|6m|1y filter)
router.get('/summary', async (req, res) => {
  try {
    const period = PERIOD_INTERVALS[req.query.period];
    const dateFilter = period
      ? `AND created_at > NOW() - INTERVAL '${period}'`
      : '';

    const rows = await query(
      `SELECT
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE status = 'WIN' OR status LIKE 'TP%' OR (status = 'CLOSED' AND pnl_usdt > 0)) as wins,
        COUNT(*) FILTER (WHERE status = 'LOSS' OR status = 'SL' OR (status = 'CLOSED' AND pnl_usdt < 0)) as losses,
        COUNT(*) FILTER (WHERE status = 'OPEN') as open_trades,
        COALESCE(SUM(pnl_usdt), 0) as total_pnl,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE pnl_usdt > 0), 0) as total_won,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE pnl_usdt < 0), 0) as total_lost,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) as pnl_24h,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0) as pnl_7d
       FROM trades WHERE user_id = $1 ${dateFilter}`,
      [req.userId]
    );

    const perKey = await query(
      `SELECT ak.label, ak.platform, COUNT(t.id) as trades,
              COALESCE(SUM(t.pnl_usdt), 0) as pnl
       FROM api_keys ak
       LEFT JOIN trades t ON t.api_key_id = ak.id
       WHERE ak.user_id = $1
       GROUP BY ak.id, ak.label, ak.platform`,
      [req.userId]
    );

    const summary = rows[0];
    const total = parseInt(summary.total_trades);
    const wins = parseInt(summary.wins);
    const losses = parseInt(summary.losses);
    summary.win_rate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0';
    summary.per_key = perKey;

    res.json(summary);
  } catch (err) {
    console.error('Summary error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Futures wallet balances from ALL connected exchanges
router.get('/futures-wallet', async (req, res) => {
  try {
    const keys = await query(
      `SELECT id, platform, label, api_key_enc, iv, auth_tag, api_secret_enc, secret_iv, secret_auth_tag
       FROM api_keys WHERE user_id = $1 AND enabled = true ORDER BY id`,
      [req.userId]
    );

    const wallets = [];
    let totalBalance = 0;
    let totalAvailable = 0;
    let totalUnrealizedPnl = 0;

    for (const key of keys) {
      try {
        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

        let balance = 0, available = 0, unrealizedPnl = 0, positions = 0;

        if (key.platform === 'binance') {
          const { getBinanceRequestOptions } = require('../proxy-agent');
          const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
          const account = await client.getAccountInformation({ omitZeroBalances: false });
          balance = parseFloat(account.totalWalletBalance) || 0;
          available = parseFloat(account.availableBalance) || 0;
          unrealizedPnl = parseFloat(account.totalUnrealizedProfit) || 0;
          positions = (account.positions || []).filter(p => parseFloat(p.positionAmt) !== 0).length;
        } else if (key.platform === 'bitunix') {
          const { BitunixClient } = require('../bitunix-client');
          const client = new BitunixClient({ apiKey, apiSecret });
          const account = await client.getAccountInformation();
          balance = parseFloat(account.totalWalletBalance) || 0;
          available = parseFloat(account.availableBalance) || 0;
          unrealizedPnl = parseFloat(account.totalUnrealizedProfit) || 0;
          positions = (account.positions || []).length;
        }

        wallets.push({
          id: key.id,
          platform: key.platform,
          label: key.label || `${key.platform} key`,
          balance,
          available,
          unrealizedPnl,
          positions,
        });

        totalBalance += balance;
        totalAvailable += available;
        totalUnrealizedPnl += unrealizedPnl;
      } catch (err) {
        wallets.push({
          id: key.id,
          platform: key.platform,
          label: key.label || `${key.platform} key`,
          balance: 0, available: 0, unrealizedPnl: 0, positions: 0,
          error: err.message,
        });
      }
    }

    res.json({
      balance: totalBalance,
      available: totalAvailable,
      unrealizedPnl: totalUnrealizedPnl,
      wallets,
    });
  } catch (err) {
    console.error('Futures wallet error:', err.message);
    res.json({ balance: 0, available: 0, unrealizedPnl: 0, wallets: [] });
  }
});

module.exports = router;
