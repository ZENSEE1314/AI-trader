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
    const user = await query(
      `SELECT cash_wallet, commission_earned, referral_code, usdt_address, usdt_network,
              referral_tier, total_referral_commission
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!user.length) return res.status(404).json({ error: 'User not found' });
    const u = user[0];

    // Referral details: names + commission earned from each
    const referrals = await query(
      `SELECT u.id, u.email, u.created_at,
              COALESCE(SUM(rc.amount), 0) as total_commission
       FROM users u
       LEFT JOIN referral_commissions rc ON rc.referee_id = u.id AND rc.referrer_id = $1
       WHERE u.referred_by = $1
       GROUP BY u.id, u.email, u.created_at
       ORDER BY u.created_at DESC`,
      [req.userId]
    );

    const rawCash = parseFloat(u.cash_wallet) || 0;
    const commissionEarned = parseFloat(u.commission_earned) || 0;
    const cashWallet = rawCash + commissionEarned;

    res.json({
      cash_wallet: cashWallet,
      commission_earned: commissionEarned,
      total_balance: cashWallet,
      referral_code: u.referral_code || '',
      referral_count: referrals.length,
      referral_tier: parseInt(u.referral_tier) || 1,
      total_referral_commission: parseFloat(u.total_referral_commission) || 0,
      usdt_address: u.usdt_address || '',
      usdt_network: u.usdt_network || 'BEP20',
      referrals: referrals.map(r => ({
        email: r.email,
        joined: r.created_at,
        commission: parseFloat(r.total_commission) || 0,
      })),
    });
  } catch (err) {
    console.error('Cash wallet error:', err.message);
    res.json({ cash_wallet: 0, commission_earned: 0, total_balance: 0, referral_code: '', referral_count: 0 });
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

// Pause/resume bot for this user
router.post('/toggle-pause', async (req, res) => {
  try {
    const keys = await query(
      'SELECT id, paused_by_user FROM api_keys WHERE user_id = $1 AND enabled = true',
      [req.userId]
    );
    if (!keys.length) return res.status(404).json({ error: 'No active keys found' });

    const currentlyPaused = keys[0].paused_by_user === true;
    const newState = !currentlyPaused;

    await query(
      `UPDATE api_keys SET paused_by_user = $1, paused_at = $2
       WHERE user_id = $3 AND enabled = true`,
      [newState, newState ? new Date() : null, req.userId]
    );

    // If pausing, also pause the weekly timer by recording pause time on user
    if (newState) {
      await query(
        'UPDATE users SET timer_paused_at = NOW() WHERE id = $1',
        [req.userId]
      );
    } else {
      // Resuming: add paused duration to last_paid_at so timer doesn't count paused time
      const user = await query('SELECT timer_paused_at, last_paid_at FROM users WHERE id = $1', [req.userId]);
      if (user.length && user[0].timer_paused_at) {
        const pausedMs = Date.now() - new Date(user[0].timer_paused_at).getTime();
        await query(
          `UPDATE users SET last_paid_at = last_paid_at + ($1 || ' milliseconds')::interval,
                           timer_paused_at = NULL WHERE id = $2`,
          [pausedMs, req.userId]
        );
      }
    }

    res.json({ paused: newState });
  } catch (err) {
    console.error('Toggle pause error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get pause status
router.get('/pause-status', async (req, res) => {
  try {
    const keys = await query(
      'SELECT paused_by_user FROM api_keys WHERE user_id = $1 AND enabled = true LIMIT 1',
      [req.userId]
    );
    const paused = keys.length > 0 && keys[0].paused_by_user === true;
    res.json({ paused });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// CSV export of all trades
router.get('/trades/csv', async (req, res) => {
  try {
    const period = PERIOD_INTERVALS[req.query.period];
    const dateFilter = period
      ? `AND t.created_at > NOW() - INTERVAL '${period}'`
      : '';

    const rows = await query(
      `SELECT t.created_at, t.symbol, t.direction, t.entry_price, t.exit_price,
              t.sl_price, t.tp_price, t.pnl_usdt, t.status, t.closed_at,
              ak.label as key_label, ak.platform
       FROM trades t
       LEFT JOIN api_keys ak ON t.api_key_id = ak.id
       WHERE t.user_id = $1 ${dateFilter}
       ORDER BY t.created_at DESC`,
      [req.userId]
    );

    const header = 'Date,Symbol,Direction,Entry Price,Exit Price,SL Price,TP Price,PnL (USDT),Status,Closed At,Key Label,Platform';
    const csvRows = rows.map(r => {
      const date = r.created_at ? new Date(r.created_at).toISOString() : '';
      const closedAt = r.closed_at ? new Date(r.closed_at).toISOString() : '';
      return [
        date, r.symbol || '', r.direction || '', r.entry_price || '', r.exit_price || '',
        r.sl_price || '', r.tp_price || '', r.pnl_usdt || '0', r.status || '', closedAt,
        (r.key_label || '').replace(/,/g, ' '), (r.platform || '').replace(/,/g, ' '),
      ].join(',');
    });

    const csv = '\uFEFF' + ['sep=,', header, ...csvRows].join('\r\n');
    const filename = `trades_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('CSV export error:', err.message);
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

// Weekly earnings with profit split (rolling 7-day window from last payment)
router.get('/weekly-earnings', async (req, res) => {
  try {
    const now = new Date();

    // Rolling window: last_paid_at → now. Resets to 0 after each payment.
    const userRow = await query(
      `SELECT created_at, last_paid_at FROM users WHERE id = $1`, [req.userId]
    );
    const paidAt = userRow[0]?.last_paid_at ? new Date(userRow[0].last_paid_at) : new Date(userRow[0]?.created_at || now);
    const periodStart = paidAt;
    const dueDate = new Date(paidAt.getTime() + 7 * 86400000);
    const msRemaining = dueDate - now;
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / 86400000));
    const isOverdue = msRemaining <= 0;

    // Get user's profit share settings per key
    const keys = await query(
      `SELECT id, label, platform, profit_share_user_pct, profit_share_admin_pct
       FROM api_keys WHERE user_id = $1`,
      [req.userId]
    );

    // Get trades closed since last payment (rolling window)
    const weeklyTrades = await query(
      `SELECT t.api_key_id, t.pnl_usdt, t.status, t.symbol, t.direction,
              t.entry_price, t.exit_price, t.created_at, t.closed_at
       FROM trades t
       WHERE t.user_id = $1
         AND t.status IN ('WIN', 'LOSS', 'TP', 'SL', 'CLOSED')
         AND t.closed_at >= $2
       ORDER BY t.closed_at DESC`,
      [req.userId, periodStart]
    );

    // Calculate per-key earnings using NET P&L (wins - losses)
    const perKey = [];
    let totalNetPnl = 0;
    let totalUserShare = 0;
    let totalAdminShare = 0;
    let totalTrades = 0;
    let totalWins = 0;

    for (const key of keys) {
      const keyTrades = weeklyTrades.filter(t => t.api_key_id === key.id);
      const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
      const netPnl = keyTrades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const userPct = parseFloat(key.profit_share_user_pct) || 60;
      const adminPct = parseFloat(key.profit_share_admin_pct) || 40;
      const shareable = Math.max(0, netPnl);
      const userShare = shareable * userPct / 100;
      const adminShare = shareable * adminPct / 100;

      perKey.push({
        key_id: key.id,
        label: key.label || key.platform,
        platform: key.platform,
        total_trades: keyTrades.length,
        win_count: wins.length,
        loss_count: keyTrades.length - wins.length,
        net_pnl: netPnl,
        user_share_pct: userPct,
        admin_share_pct: adminPct,
        user_share: userShare,
        admin_share: adminShare,
      });

      totalNetPnl += netPnl;
      totalUserShare += userShare;
      totalAdminShare += adminShare;
      totalTrades += keyTrades.length;
      totalWins += wins.length;
    }

    res.json({
      week_start: periodStart.toISOString(),
      week_end: dueDate.toISOString(),
      total_trades: totalTrades,
      total_wins: totalWins,
      total_losses: totalTrades - totalWins,
      net_pnl: totalNetPnl,
      user_share: totalUserShare,
      admin_share: totalAdminShare,
      user_share_pct: keys.length > 0 ? (parseFloat(keys[0].profit_share_user_pct) || 60) : 60,
      admin_share_pct: keys.length > 0 ? (parseFloat(keys[0].profit_share_admin_pct) || 40) : 40,
      per_key: perKey,
      payment_due: dueDate.toISOString(),
      days_remaining: daysRemaining,
      is_overdue: isOverdue,
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

// User self-pay: deduct platform fee from cash wallet
router.post('/pay-weekly', async (req, res) => {
  try {
    const userId = req.userId;
    const now = new Date();

    // Rolling window: last_paid_at → now
    const userInfo = await query(
      `SELECT created_at, last_paid_at FROM users WHERE id = $1`, [userId]
    );
    const paidAt = userInfo[0]?.last_paid_at ? new Date(userInfo[0].last_paid_at) : new Date(userInfo[0]?.created_at || now);
    const periodStart = paidAt;

    // Get user's keys
    const keys = await query(
      `SELECT id, profit_share_user_pct, profit_share_admin_pct FROM api_keys WHERE user_id = $1`,
      [userId]
    );
    if (!keys.length) return res.status(400).json({ error: 'No API keys found' });

    // Get trades closed since last payment
    const trades = await query(
      `SELECT api_key_id, pnl_usdt, status FROM trades
       WHERE user_id = $1 AND status IN ('WIN','LOSS','TP','SL','CLOSED')
         AND closed_at >= $2`,
      [userId, periodStart]
    );

    // Calculate total admin share (platform fee)
    let totalAdminShare = 0;
    for (const key of keys) {
      const keyTrades = trades.filter(t => t.api_key_id === key.id);
      const netPnl = keyTrades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const shareable = Math.max(0, netPnl);
      const adminPct = parseFloat(key.profit_share_admin_pct) || 40;
      totalAdminShare += shareable * adminPct / 100;
    }

    if (totalAdminShare <= 0) return res.status(400).json({ error: 'No platform fee to pay (no net profit this week)' });

    // Check user has enough balance
    const userRow = await query(
      `SELECT cash_wallet, commission_earned FROM users WHERE id = $1`, [userId]
    );
    const cashWallet = (parseFloat(userRow[0]?.cash_wallet) || 0) + (parseFloat(userRow[0]?.commission_earned) || 0);
    if (cashWallet < totalAdminShare) {
      const shortfall = totalAdminShare - cashWallet;
      return res.status(400).json({
        error: `Insufficient balance. Fee: $${totalAdminShare.toFixed(2)}, Wallet: $${cashWallet.toFixed(2)}. Please top up at least $${shortfall.toFixed(2)}.`,
        code: 'INSUFFICIENT_BALANCE',
        fee: totalAdminShare,
        balance: cashWallet,
        shortfall,
      });
    }

    // Save per-key earnings to weekly_earnings history
    for (const key of keys) {
      const keyTrades = trades.filter(t => t.api_key_id === key.id);
      const netPnl = keyTrades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
      const winPnl = wins.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const shareable = Math.max(0, netPnl);
      const userPct = parseFloat(key.profit_share_user_pct) || 60;
      const adminPct = parseFloat(key.profit_share_admin_pct) || 40;

      await query(
        `INSERT INTO weekly_earnings (user_id, api_key_id, week_start, week_end,
          total_pnl, winning_pnl, user_share, admin_share,
          user_share_pct, admin_share_pct, trade_count, win_count, settled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
         ON CONFLICT (user_id, api_key_id, week_start)
         DO UPDATE SET total_pnl=$5, winning_pnl=$6, user_share=$7, admin_share=$8,
           trade_count=$11, win_count=$12, settled=true`,
        [userId, key.id, periodStart, now, netPnl, winPnl,
         shareable * userPct / 100, shareable * adminPct / 100,
         userPct, adminPct, keyTrades.length, wins.length]
      );
    }

    // Deduct from cash_wallet (prefer cash_wallet first, then commission_earned)
    let remaining = totalAdminShare;
    const rawCash = parseFloat(userRow[0]?.cash_wallet) || 0;
    const commEarned = parseFloat(userRow[0]?.commission_earned) || 0;
    const cashDeduct = Math.min(rawCash, remaining);
    remaining -= cashDeduct;
    const commDeduct = Math.min(commEarned, remaining);

    await query(
      `UPDATE users SET cash_wallet = cash_wallet - $1,
                        commission_earned = commission_earned - $2,
                        last_paid_at = NOW()
       WHERE id = $3`,
      [cashDeduct, commDeduct, userId]
    );

    // Record the payment in wallet_transactions
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
       VALUES ($1, 'platform_fee', $2, 'completed', $3)`,
      [userId, -totalAdminShare,
       `Weekly platform fee payment for ${periodStart.toISOString().slice(0,10)} to ${now.toISOString().slice(0,10)} | Trades: ${trades.length} | Net P&L: $${trades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0).toFixed(2)}`]
    );

    // Resume trading (unpause keys)
    await query(
      `UPDATE api_keys SET paused_by_admin = false, enabled = true WHERE user_id = $1`,
      [userId]
    );

    // Pay referral commission from platform's share
    const referrerRow = await query('SELECT referred_by FROM users WHERE id = $1', [userId]);
    if (referrerRow.length > 0 && referrerRow[0].referred_by) {
      const referrerId = referrerRow[0].referred_by;
      const settingsRow = await query("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
      const refPct = settingsRow.length > 0 ? parseFloat(settingsRow[0].value) : 10;
      const referralAmount = parseFloat((totalAdminShare * refPct / 100).toFixed(4));

      if (referralAmount > 0) {
        const userEmail = (await query('SELECT email FROM users WHERE id = $1', [userId]))[0]?.email || `#${userId}`;
        await query(
          `UPDATE users SET cash_wallet = cash_wallet + $1,
                            commission_earned = commission_earned + $1,
                            total_referral_commission = total_referral_commission + $1
           WHERE id = $2`,
          [referralAmount, referrerId]
        );
        await query(
          `INSERT INTO referral_commissions (referrer_id, referee_id, level, amount, description)
           VALUES ($1, $2, 1, $3, $4)`,
          [referrerId, userId, referralAmount,
           `Weekly commission from ${userEmail} (${refPct}% of $${totalAdminShare.toFixed(2)} platform fee)`]
        );
        await query(
          `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
           VALUES ($1, 'referral_commission', $2, 'completed', $3)`,
          [referrerId, referralAmount,
           `Weekly referral commission from ${userEmail}`]
        );
      }
    }

    res.json({ ok: true, message: `Paid $${totalAdminShare.toFixed(2)} platform fee. Trading resumed!` });
  } catch (err) {
    console.error('Pay weekly error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
