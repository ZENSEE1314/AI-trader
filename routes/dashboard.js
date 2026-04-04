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

// Cash wallet info for dashboard
router.get('/cash-wallet', async (req, res) => {
  try {
    const { query } = require('../db');
    
    // Get user's wallet balance
    const walletResult = await query(
      'SELECT balance, referral_tier, total_referral_commission FROM users WHERE id = $1',
      [req.userId]
    );
    
    // Get commission breakdown
    const commissionResult = await query(
      `SELECT SUM(amount) as total_commission 
       FROM referral_commissions 
       WHERE recipient_id = $1 AND status = 'paid'`,
      [req.userId]
    );
    
    const wallet = walletResult[0] || { balance: 0, referral_tier: 'standard', total_referral_commission: 0 };
    const totalCommission = parseFloat(commissionResult[0]?.total_commission || 0);
    
    res.json({
      balance: parseFloat(wallet.balance || 0),
      total_commission: totalCommission,
      total_balance: parseFloat(wallet.balance || 0) + totalCommission,
      referral_tier: wallet.referral_tier || 'standard',
      referral_code: `ref${req.userId.toString().padStart(6, '0')}`,
      referral_count: 0, // You can add referral count logic later
      usdt_address: '', // Add USDT address field to users table if needed
      usdt_network: 'ERC20',
      fee_due: false,
      days_left: 30,
      weekly_fee: 0,
      weekly_fee_due: null
    });
  } catch (err) {
    console.error('Cash wallet error:', err.message);
    // Return default values if error
    res.json({
      balance: 0,
      total_commission: 0,
      total_balance: 0,
      referral_tier: 'standard',
      referral_code: `ref${req.userId.toString().padStart(6, '0')}`,
      referral_count: 0,
      usdt_address: '',
      usdt_network: 'ERC20',
      fee_due: false,
      days_left: 30,
      weekly_fee: 0,
      weekly_fee_due: null
    });
  }
});

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

    // Fetch all exchange wallets in parallel
    const results = await Promise.allSettled(keys.map(async (key) => {
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

      return { id: key.id, platform: key.platform, label: key.label || `${key.platform} key`, balance, available, unrealizedPnl, positions };
    }));

    const wallets = [];
    let totalBalance = 0;
    let totalAvailable = 0;
    let totalUnrealizedPnl = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        wallets.push(r.value);
        totalBalance += r.value.balance;
        totalAvailable += r.value.available;
        totalUnrealizedPnl += r.value.unrealizedPnl;
      } else {
        wallets.push({
          id: keys[i].id, platform: keys[i].platform,
          label: keys[i].label || `${keys[i].platform} key`,
          balance: 0, available: 0, unrealizedPnl: 0, positions: 0,
          error: r.reason?.message || 'Unknown error',
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

// Weekly earnings with profit split
router.get('/weekly-earnings', async (req, res) => {
  try {
    // Get current week (Monday to Sunday)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    // Get user's profit share settings per key
    const keys = await query(
      `SELECT id, label, platform, profit_share_user_pct, profit_share_admin_pct
       FROM api_keys WHERE user_id = $1`,
      [req.userId]
    );

    // Get this week's closed trades with positive PnL (winnings only)
    const weeklyTrades = await query(
      `SELECT t.api_key_id, t.pnl_usdt, t.status, t.symbol, t.direction,
              t.entry_price, t.exit_price, t.created_at, t.closed_at
       FROM trades t
       WHERE t.user_id = $1
         AND t.status IN ('WIN', 'LOSS', 'TP', 'SL', 'CLOSED')
         AND t.closed_at >= $2 AND t.closed_at <= $3
       ORDER BY t.closed_at DESC`,
      [req.userId, monday, sunday]
    );

    // Calculate per-key earnings
    const perKey = [];
    let totalWinningPnl = 0;
    let totalUserShare = 0;
    let totalAdminShare = 0;
    let totalTrades = 0;
    let totalWins = 0;

    for (const key of keys) {
      const keyTrades = weeklyTrades.filter(t => t.api_key_id === key.id);
      const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
      const winningPnl = wins.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const userPct = parseFloat(key.profit_share_user_pct) || 60;
      const adminPct = parseFloat(key.profit_share_admin_pct) || 40;
      const userShare = Math.max(0, winningPnl * userPct / 100);
      const adminShare = Math.max(0, winningPnl * adminPct / 100);

      perKey.push({
        key_id: key.id,
        label: key.label || key.platform,
        platform: key.platform,
        total_trades: keyTrades.length,
        win_count: wins.length,
        loss_count: keyTrades.length - wins.length,
        winning_pnl: winningPnl,
        user_share_pct: userPct,
        admin_share_pct: adminPct,
        user_share: userShare,
        admin_share: adminShare,
      });

      totalWinningPnl += winningPnl;
      totalUserShare += userShare;
      totalAdminShare += adminShare;
      totalTrades += keyTrades.length;
      totalWins += wins.length;
    }

    res.json({
      week_start: monday.toISOString(),
      week_end: sunday.toISOString(),
      total_trades: totalTrades,
      total_wins: totalWins,
      total_losses: totalTrades - totalWins,
      winning_pnl: totalWinningPnl,
      user_share: totalUserShare,
      admin_share: totalAdminShare,
      user_share_pct: keys.length > 0 ? (parseFloat(keys[0].profit_share_user_pct) || 60) : 60,
      admin_share_pct: keys.length > 0 ? (parseFloat(keys[0].profit_share_admin_pct) || 40) : 40,
      per_key: perKey,
    });
  } catch (err) {
    console.error('Weekly earnings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Historical weekly earnings (last 8 weeks)
router.get('/weekly-history', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks) || 8;
    const rows = await query(
      `SELECT week_start, week_end,
              SUM(winning_pnl) as winning_pnl,
              SUM(user_share) as user_share,
              SUM(admin_share) as admin_share,
              SUM(trade_count) as trade_count,
              SUM(win_count) as win_count
       FROM weekly_earnings
       WHERE user_id = $1 AND settled = true
       GROUP BY week_start, week_end
       ORDER BY week_start DESC
       LIMIT $2`,
      [req.userId, weeks]
    );
    res.json(rows);
  } catch (err) {
    console.error('Weekly history error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
