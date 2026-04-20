const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const emailService = require('../email-service');

const router = express.Router();
router.use(authMiddleware);

// Admin check middleware
async function adminOnly(req, res, next) {
  const rows = await query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
  if (!rows.length || !rows[0].is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}
router.use(adminOnly);

// Weekly earnings overview for admin (all users)
router.get('/weekly-earnings', async (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const users = await query(
      `SELECT u.id, u.email, u.created_at, u.last_paid_at,
              ak.id as key_id, ak.label as key_label, ak.platform,
              ak.profit_share_user_pct, ak.profit_share_admin_pct,
              ak.paused_by_admin, ak.enabled
       FROM users u
       LEFT JOIN api_keys ak ON ak.user_id = u.id
       WHERE u.is_admin = false
       ORDER BY u.email, ak.id`
    );

    // Get all unpaid trades — trades since each user's last_paid_at (or account creation)
    // The per-user filter happens below; here we fetch a broad window
    const earliestPaidAt = users.reduce((min, u) => {
      const pa = u.last_paid_at ? new Date(u.last_paid_at) : new Date(u.created_at);
      return pa < min ? pa : min;
    }, now);

    const trades = await query(
      `SELECT t.user_id, t.api_key_id, t.pnl_usdt, t.status, t.symbol,
              COALESCE(t.closed_at, t.created_at) as closed_at
       FROM trades t
       WHERE t.status IN ('WIN', 'LOSS', 'TP', 'SL', 'CLOSED')
         AND COALESCE(t.closed_at, t.created_at) >= $1`,
      [earliestPaidAt]
    );

    let grandTotalNet = 0;
    let grandTotalUserShare = 0;
    let grandTotalAdminShare = 0;

    const userMap = {};
    for (const u of users) {
      if (!userMap[u.id]) {
        // Timer: 7 days from last_paid_at (or created_at if never paid)
        const paidAt = u.last_paid_at ? new Date(u.last_paid_at) : new Date(u.created_at);
        const dueDate = new Date(paidAt.getTime() + 7 * 86400000);
        const msRemaining = dueDate - now;
        const daysRemaining = Math.max(0, Math.ceil(msRemaining / 86400000));
        const isOverdue = msRemaining <= 0;

        userMap[u.id] = {
          user_id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_paid_at: u.last_paid_at,
          keys: [],
          total_net_pnl: 0,
          total_user_share: 0,
          total_admin_share: 0,
          total_trades: 0,
          total_wins: 0,
          total_losses: 0,
          payment_due: dueDate.toISOString(),
          days_remaining: daysRemaining,
          is_overdue: isOverdue,
        };
      }
      if (u.key_id) {
        // Only count trades AFTER last payment (rolling window resets on payment)
        const paidAt = u.last_paid_at ? new Date(u.last_paid_at) : new Date(u.created_at);
        const keyTrades = trades.filter(t => {
          if (t.api_key_id !== u.key_id) return false;
          return new Date(t.closed_at) > paidAt;
        });
        const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
        const losses = keyTrades.filter(t => parseFloat(t.pnl_usdt) < 0);
        // Net P&L = wins + losses (losses are negative)
        const netPnl = keyTrades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
        const userPct = parseFloat(u.profit_share_user_pct) || 60;
        const adminPct = parseFloat(u.profit_share_admin_pct) || 40;

        // Only share profit if net is positive
        const shareable = Math.max(0, netPnl);
        const keyData = {
          key_id: u.key_id,
          label: u.key_label || u.platform,
          platform: u.platform,
          paused: u.paused_by_admin || false,
          enabled: u.enabled !== false,
          total_trades: keyTrades.length,
          win_count: wins.length,
          loss_count: losses.length,
          net_pnl: netPnl,
          user_share_pct: userPct,
          admin_share_pct: adminPct,
          user_share: shareable * userPct / 100,
          admin_share: shareable * adminPct / 100,
        };

        userMap[u.id].keys.push(keyData);
        userMap[u.id].total_net_pnl += netPnl;
        userMap[u.id].total_user_share += keyData.user_share;
        userMap[u.id].total_admin_share += keyData.admin_share;
        userMap[u.id].total_trades += keyTrades.length;
        userMap[u.id].total_wins += wins.length;
        userMap[u.id].total_losses += losses.length;
      }
    }

    for (const u of Object.values(userMap)) {
      grandTotalNet += u.total_net_pnl;
      grandTotalUserShare += u.total_user_share;
      grandTotalAdminShare += u.total_admin_share;
    }

    res.json({
      week_start: monday.toISOString(),
      week_end: sunday.toISOString(),
      grand_total_net: grandTotalNet,
      grand_total_user_share: grandTotalUserShare,
      grand_total_admin_share: grandTotalAdminShare,
      users: Object.values(userMap),
    });
  } catch (err) {
    console.error('Admin weekly earnings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// CSV export of ALL users' trades (admin only)
router.get('/trades/csv', async (req, res) => {
  try {
    const rows = await query(
      `SELECT t.created_at, t.symbol, t.direction, t.entry_price, t.exit_price,
              t.sl_price, t.tp_price, t.pnl_usdt, t.status, t.closed_at,
              u.email, ak.label as key_label, ak.platform
       FROM trades t
       LEFT JOIN api_keys ak ON t.api_key_id = ak.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.status != 'ERROR'
       ORDER BY t.created_at DESC`
    );

    const header = 'Date,User,Symbol,Direction,Entry Price,Exit Price,SL Price,TP Price,PnL (USDT),Status,Closed At,Key Label,Platform';
    const csvRows = rows.map(r => {
      const date = r.created_at ? new Date(r.created_at).toISOString() : '';
      const closedAt = r.closed_at ? new Date(r.closed_at).toISOString() : '';
      return [
        date, (r.email || '').replace(/,/g, ' '), r.symbol || '', r.direction || '',
        r.entry_price || '', r.exit_price || '', r.sl_price || '', r.tp_price || '',
        r.pnl_usdt || '0', r.status || '', closedAt,
        (r.key_label || '').replace(/,/g, ' '), (r.platform || '').replace(/,/g, ' '),
      ].join(',');
    });

    const csv = '\uFEFF' + ['sep=,', header, ...csvRows].join('\r\n');
    const filename = `all_trades_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('Admin CSV export error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark user as paid — save to history, reset, resume trading
router.post('/mark-paid/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    // Get user's keys
    const keys = await query(
      `SELECT id, profit_share_user_pct, profit_share_admin_pct FROM api_keys WHERE user_id = $1`,
      [userId]
    );

    // Get this week's trades
    const trades = await query(
      `SELECT api_key_id, pnl_usdt, status FROM trades
       WHERE user_id = $1 AND status IN ('WIN','LOSS','TP','SL','CLOSED')
         AND closed_at >= $2 AND closed_at <= $3`,
      [userId, monday, sunday]
    );

    // Save per-key earnings to history
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
        [userId, key.id, monday, sunday, netPnl, winPnl,
         shareable * userPct / 100, shareable * adminPct / 100,
         userPct, adminPct, keyTrades.length, wins.length]
      );
    }

    // Calculate total admin share for referral commission
    const totalNetPnl = trades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
    const totalShareable = Math.max(0, totalNetPnl);
    if (totalShareable > 0) {
      const firstKey = keys[0];
      const adminPct = firstKey ? (parseFloat(firstKey.profit_share_admin_pct) || 40) : 40;
      const totalAdminShare = totalShareable * adminPct / 100;

      // Pay referral commission from platform's share (weekly, on payment)
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
    }

    // Resume all user's keys and record payment timestamp
    await query(
      `UPDATE api_keys SET paused_by_admin = false, enabled = true WHERE user_id = $1`,
      [userId]
    );
    await query(
      `UPDATE users SET last_paid_at = NOW() WHERE id = $1`,
      [userId]
    );

    res.json({ ok: true, message: 'Marked as paid, trading resumed' });
  } catch (err) {
    console.error('Mark paid error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get payment history for all users
router.get('/payment-history', async (req, res) => {
  try {
    const rows = await query(
      `SELECT we.*, u.email FROM weekly_earnings we
       JOIN users u ON u.id = we.user_id
       WHERE we.settled = true
       ORDER BY we.week_end DESC, u.email
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('Payment history error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update profit share for a specific API key
router.put('/keys/:id/profit-share', async (req, res) => {
  try {
    const { user_pct, admin_pct } = req.body;
    if (user_pct === undefined || admin_pct === undefined) {
      return res.status(400).json({ error: 'user_pct and admin_pct required' });
    }
    const up = parseFloat(user_pct);
    const ap = parseFloat(admin_pct);
    if (isNaN(up) || isNaN(ap) || up < 0 || ap < 0 || up + ap !== 100) {
      return res.status(400).json({ error: 'Percentages must be >= 0 and sum to 100' });
    }
    await query(
      `UPDATE api_keys SET profit_share_user_pct = $1, profit_share_admin_pct = $2 WHERE id = $3`,
      [up, ap, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Profit share update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pause/resume an API key
router.put('/keys/:id/pause', async (req, res) => {
  try {
    const { paused } = req.body;
    await query(
      `UPDATE api_keys SET paused_by_admin = $1 WHERE id = $2`,
      [!!paused, req.params.id]
    );
    // If pausing, also disable so the bot skips it
    if (paused) {
      await query(`UPDATE api_keys SET enabled = false WHERE id = $1`, [req.params.id]);
    }
    res.json({ ok: true, paused: !!paused });
  } catch (err) {
    console.error('Pause key error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Resume an API key (re-enable)
router.put('/keys/:id/resume', async (req, res) => {
  try {
    await query(
      `UPDATE api_keys SET paused_by_admin = false, enabled = true WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true, paused: false });
  } catch (err) {
    console.error('Resume key error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all users
router.get('/users', async (req, res) => {
  try {
    const rows = await query(
      `SELECT u.id, u.email, u.is_blocked, u.is_admin, u.approved_no_sub,
              u.referral_code, u.wallet_balance, u.cash_wallet, u.commission_earned,
              u.weekly_fee_amount, u.weekly_fee_due, u.usdt_address, u.usdt_network,
              u.bitunix_referral_link,
              u.created_at, u.last_paid_at,
              (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count,
              (SELECT email FROM users WHERE id = u.referred_by) as referred_by_email
       FROM users u ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin users error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/revoke user to trade without subscription
router.put('/users/:id/approve-no-sub', async (req, res) => {
  try {
    const { approved } = req.body;
    await query('UPDATE users SET approved_no_sub = $1 WHERE id = $2', [!!approved, req.params.id]);
    res.json({ ok: true, approved: !!approved });
  } catch (err) {
    console.error('Approve no-sub error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change user role (admin/user)
router.put('/users/:id/role', async (req, res) => {
  try {
    const { is_admin } = req.body;
    const targetId = parseInt(req.params.id);
    if (targetId === req.userId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    await query('UPDATE users SET is_admin = $1 WHERE id = $2', [!!is_admin, targetId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Change role error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Block/unblock user
router.put('/users/:id/block', async (req, res) => {
  try {
    const { blocked } = req.body;
    await query('UPDATE users SET is_blocked = $1 WHERE id = $2', [!!blocked, req.params.id]);
    if (blocked) {
      await query('UPDATE api_keys SET enabled = false WHERE user_id = $1', [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Block user error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit user wallet balance
// NOTE: UI displays cash_wallet + commission_earned. We update cash_wallet — the
// spendable balance. commission_earned is a read-only running total and stays intact.
router.put('/users/:id/wallet', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (amount === undefined || amount === null) return res.status(400).json({ error: 'Amount required' });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) return res.status(400).json({ error: 'Invalid amount' });

    // Get current displayed balance (cash_wallet + commission_earned) and email
    const user = await query('SELECT cash_wallet, commission_earned, email FROM users WHERE id = $1', [req.params.id]);
    if (!user.length) return res.status(404).json({ error: 'User not found' });

    const currentBalance = parseFloat(user[0].cash_wallet) + parseFloat(user[0].commission_earned || 0);
    const diff = parsedAmount - currentBalance;

    // Update cash_wallet to match the target displayed balance
    // target cash_wallet = parsedAmount - commission_earned (keeps displayed total correct)
    const newCashWallet = parsedAmount - parseFloat(user[0].commission_earned || 0);
    await query('UPDATE users SET cash_wallet = $1 WHERE id = $2', [newCashWallet, req.params.id]);

    // Log the adjustment
    if (diff !== 0) {
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description)
         VALUES ($1, 'admin_adjustment', $2, $3)`,
        [req.params.id, diff, reason || `Admin adjusted balance from $${currentBalance.toFixed(2)} to $${parsedAmount.toFixed(2)}`]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Admin wallet edit error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear all ERROR trades
router.delete('/trades/errors', async (req, res) => {
  try {
    const result = await query('DELETE FROM trades WHERE status = $1', ['ERROR']);
    res.json({ ok: true });
  } catch (err) {
    console.error('Clear errors error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// List pending subscriptions (bank transfer proofs to approve)
router.get('/subscriptions', async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.*, u.email FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin subs error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/reject subscription
router.put('/subscriptions/:id', async (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'
    const sub = await query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (!sub.length) return res.status(404).json({ error: 'Not found' });

    if (action === 'approve') {
      const userId = sub[0].user_id;
      // Extend by 30 days (stacks on existing time)
      const existing = await query(
        `SELECT id, expires_at FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
         ORDER BY expires_at DESC LIMIT 1`,
        [userId]
      );

      const now = new Date();
      let newExpiry;
      if (existing.length) {
        newExpiry = new Date(existing[0].expires_at);
        newExpiry.setDate(newExpiry.getDate() + 30);
        await query('UPDATE subscriptions SET expires_at = $1 WHERE id = $2', [newExpiry, existing[0].id]);
        // Mark this payment record as processed
        await query('UPDATE subscriptions SET status = $1 WHERE id = $2', ['processed', req.params.id]);
      } else {
        newExpiry = new Date(now);
        newExpiry.setDate(newExpiry.getDate() + 30);
        await query(
          `UPDATE subscriptions SET status = 'active', starts_at = $1, expires_at = $2 WHERE id = $3`,
          [now, newExpiry, req.params.id]
        );
      }

      // Pay referral commissions
      const settings = {};
      const rows = await query('SELECT key, value FROM settings');
      for (const r of rows) settings[r.key] = r.value;
      const commSettings = {
        price: parseFloat(settings.sub_price) || 29.99,
        tier1: parseFloat(settings.commission_tier1) || 0,
        tier2: parseFloat(settings.commission_tier2) || 0,
        tier3: parseFloat(settings.commission_tier3) || 0,
      };
      await payReferralCommission(userId, commSettings);
    } else {
      await query('UPDATE subscriptions SET status = $1 WHERE id = $2', ['rejected', req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin sub action error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3-tier referral commission (same logic as subscription.js)
async function payReferralCommission(userId, settings) {
  try {
    const tiers = [settings.tier1, settings.tier2, settings.tier3];
    let currentId = userId;
    for (let tier = 0; tier < 3; tier++) {
      const pct = tiers[tier];
      if (!pct || pct <= 0) break;
      const user = await query('SELECT referred_by FROM users WHERE id = $1', [currentId]);
      if (!user.length || !user[0].referred_by) break;
      const referrerId = user[0].referred_by;
      // Only pay if referrer has active subscription
      const activeSub = await query(
        `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW() LIMIT 1`,
        [referrerId]
      );
      if (!activeSub.length) { currentId = referrerId; continue; }
      const commission = settings.price * (pct / 100);
      await query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [commission, referrerId]);
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, ref_id) VALUES ($1, 'commission', $2, $3, $4)`,
        [referrerId, commission, `Tier ${tier + 1} commission from user #${userId} (${pct}%)`, userId]
      );
      currentId = referrerId;
    }
  } catch (err) { console.error('Referral commission error:', err.message); }
}

// List pending withdrawals
router.get('/withdrawals', async (req, res) => {
  try {
    const rows = await query(
      `SELECT w.*, u.email FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       ORDER BY w.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin withdrawals error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/reject withdrawal
router.put('/withdrawals/:id', async (req, res) => {
  try {
    const { action, admin_note } = req.body;
    const w = await query('SELECT * FROM withdrawals WHERE id = $1', [req.params.id]);
    if (!w.length) return res.status(404).json({ error: 'Not found' });
    if (w[0].status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      await query('UPDATE withdrawals SET status = $1, admin_note = $2 WHERE id = $3', ['approved', admin_note || '', req.params.id]);
    } else {
      // Refund to wallet
      await query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [w[0].amount, w[0].user_id]);
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, ref_id) VALUES ($1, 'refund', $2, 'Withdrawal rejected', $3)`,
        [w[0].user_id, w[0].amount, w[0].id]
      );
      await query('UPDATE withdrawals SET status = $1, admin_note = $2 WHERE id = $3', ['rejected', admin_note || '', req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin withdrawal action error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Pending top-ups ──────────────────────────────────────────
router.get('/topups', async (req, res) => {
  try {
    const rows = await query(
      `SELECT w.*, u.email FROM wallet_transactions w
       JOIN users u ON u.id = w.user_id
       WHERE w.type = 'topup_pending'
       ORDER BY w.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin topups error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/reject top-up
router.put('/topups/:id', async (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'
    const txn = await query('SELECT * FROM wallet_transactions WHERE id = $1', [req.params.id]);
    if (!txn.length) return res.status(404).json({ error: 'Not found' });
    if (txn[0].type !== 'topup_pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      const amount = parseFloat(txn[0].amount);
      await query('UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2', [amount, txn[0].user_id]);
      await query(
        `UPDATE wallet_transactions SET type = 'topup', status = 'approved', description = description || ' (approved)' WHERE id = $1`,
        [req.params.id]
      );
    } else {
      await query(
        `UPDATE wallet_transactions SET type = 'topup_rejected', status = 'rejected', description = description || ' (rejected)' WHERE id = $1`,
        [req.params.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin topup action error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Set Bitunix referral link for a user (admin override) ────
router.put('/users/:id/bitunix-referral-link', async (req, res) => {
  try {
    const { link } = req.body;
    const cleaned = (link || '').trim().slice(0, 500);
    await query('UPDATE users SET bitunix_referral_link = $1 WHERE id = $2', [cleaned || null, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin set Bitunix referral link error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Set weekly fee for a user ────────────────────────────────
router.put('/users/:id/weekly-fee', async (req, res) => {
  try {
    const { amount } = req.body;
    if (amount === undefined || amount < 0) return res.status(400).json({ error: 'Valid amount required' });
    await query('UPDATE users SET weekly_fee_amount = $1 WHERE id = $2', [parseFloat(amount), req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Set weekly fee error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Set weekly fee due date for a user ───────────────────────
router.put('/users/:id/fee-due', async (req, res) => {
  try {
    const { due_date } = req.body;
    await query('UPDATE users SET weekly_fee_due = $1 WHERE id = $2', [due_date, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Set fee due error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Users with unpaid fees ──────────────────────────────────
router.get('/unpaid-fees', async (req, res) => {
  try {
    const rows = await query(
      `SELECT u.id, u.email, u.cash_wallet, u.commission_earned,
              u.weekly_fee_amount, u.weekly_fee_due,
              (u.cash_wallet + u.commission_earned) as total_available,
              (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND enabled = true) as active_keys
       FROM users u
       WHERE u.is_admin = false
         AND u.weekly_fee_due IS NOT NULL
         AND u.weekly_fee_due < NOW()
       ORDER BY u.weekly_fee_due ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Unpaid fees error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get settings
router.get('/settings', async (req, res) => {
  try {
    const rows = await query('SELECT key, value FROM settings');
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (err) {
    console.error('Admin settings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update settings
router.put('/settings', async (req, res) => {
  try {
    const { referral_commission_pct, commission_tier1, commission_tier2, commission_tier3, min_topup } = req.body;

    const { platform_usdt_address, platform_usdt_network, bscscan_api_key } = req.body;

    const updates = [
      ['referral_commission_pct', referral_commission_pct],
      ['commission_tier1', commission_tier1],
      ['commission_tier2', commission_tier2],
      ['commission_tier3', commission_tier3],
      ['min_topup', min_topup],
      ['platform_usdt_address', platform_usdt_address],
      ['platform_usdt_network', platform_usdt_network],
      ['bscscan_api_key', bscscan_api_key],
    ];

    for (const [key, val] of updates) {
      if (val !== undefined && val !== null) {
        await query(
          `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
          [key, String(val)]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin update settings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Risk Level Management ───────────────────────────────────

router.get('/risk-levels', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM risk_levels ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error('Risk levels list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/risk-levels', async (req, res) => {
  try {
    const { name, description, tp_pct, sl_pct, trailing_sl_step, max_consec_loss, top_n_coins, capital_percentage, max_leverage } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const row = await query(
      `INSERT INTO risk_levels (name, description, tp_pct, sl_pct, trailing_sl_step, max_consec_loss, top_n_coins, capital_percentage, max_leverage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [name, description || '', tp_pct || 0.01, sl_pct || 0.01, trailing_sl_step || 1.2, max_consec_loss || 2, top_n_coins || 50, capital_percentage || 10, max_leverage || 20]
    );
    res.json(row[0]);
  } catch (err) {
    console.error('Risk level create error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/risk-levels/:id', async (req, res) => {
  try {
    const { name, description, tp_pct, sl_pct, trailing_sl_step, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled } = req.body;
    await query(
      `UPDATE risk_levels SET name = COALESCE($1, name), description = COALESCE($2, description),
       tp_pct = COALESCE($3, tp_pct), sl_pct = COALESCE($4, sl_pct),
       trailing_sl_step = COALESCE($5, trailing_sl_step),
       max_consec_loss = COALESCE($6, max_consec_loss), top_n_coins = COALESCE($7, top_n_coins),
       capital_percentage = COALESCE($8, capital_percentage), max_leverage = COALESCE($9, max_leverage),
       enabled = COALESCE($10, enabled) WHERE id = $11`,
      [name, description, tp_pct, sl_pct, trailing_sl_step, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Risk level update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/risk-levels/:id', async (req, res) => {
  try {
    await query('UPDATE api_keys SET risk_level_id = NULL WHERE risk_level_id = $1', [req.params.id]);
    await query('DELETE FROM risk_levels WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Risk level delete error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Global Token Management ─────────────────────────────────

// List all global token settings
router.get('/global-tokens', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM global_token_settings ORDER BY "rank" ASC, symbol ASC');
    res.json(rows);
  } catch (err) {
    console.error('Global tokens list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add or update global token setting
router.post('/global-tokens', async (req, res) => {
  try {
    const { symbol, enabled, banned } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });

    await query(
      `INSERT INTO global_token_settings (symbol, enabled, banned)
       VALUES ($1, $2, $3)
       ON CONFLICT (symbol) DO UPDATE SET enabled = EXCLUDED.enabled, banned = EXCLUDED.banned`,
      [symbol.toUpperCase(), enabled !== false, banned === true]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Global token add error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove global token setting
router.delete('/global-tokens/:symbol', async (req, res) => {
  try {
    await query('DELETE FROM global_token_settings WHERE symbol = $1', [req.params.symbol.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Global token delete error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST-based remove (more reliable than DELETE with URL params)
router.post('/remove-global-token', async (req, res) => {
  console.log('[ADMIN] remove-global-token hit, body:', JSON.stringify(req.body));
  try {
    const symbol = (req.body.symbol || '').toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    await query('DELETE FROM global_token_settings WHERE symbol = $1', [symbol]);
    console.log(`[ADMIN] Removed global token: ${symbol}`);
    res.json({ ok: true, symbol });
  } catch (err) {
    console.error('Global token remove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Scan Bitunix for all available futures pairs and sync to global_token_settings
router.post('/scan-bitunix-tokens', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { getFetchOptions } = require('../proxy-agent');

    const url = 'https://fapi.bitunix.com/api/v1/futures/market/trading_pairs';
    const r = await fetch(url, { timeout: 15000, ...getFetchOptions() });
    const json = await r.json();
    if (json.code !== 0 || !Array.isArray(json.data)) {
      return res.status(502).json({ error: `Bitunix API error: ${json.msg || 'unknown'}` });
    }

    const pairs = json.data
      .filter(p => p.quote === 'USDT' && p.symbolStatus === 'OPEN')
      .sort((a, b) => parseInt(b.maxLeverage || 0) - parseInt(a.maxLeverage || 0));

    if (!pairs.length) {
      return res.status(502).json({ error: 'No USDT pairs found on Bitunix' });
    }

    // Get existing tokens so we preserve their enabled/banned state
    const existing = await query('SELECT symbol, enabled, banned FROM global_token_settings');
    const existingMap = {};
    for (const row of existing) existingMap[row.symbol] = row;

    let added = 0;
    let unchanged = 0;
    let removed = 0;

    // Upsert all Bitunix pairs — new ones default to enabled + not banned, store rank by order
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      const pairRank = i + 1;
      if (existingMap[p.symbol]) {
        // Update rank for existing tokens (only if still default 999)
        await query(
          'UPDATE global_token_settings SET "rank" = LEAST("rank", $1) WHERE symbol = $2',
          [pairRank, p.symbol]
        );
        unchanged++;
      } else {
        await query(
          `INSERT INTO global_token_settings (symbol, enabled, banned, "rank")
           VALUES ($1, true, false, $2)
           ON CONFLICT (symbol) DO UPDATE SET "rank" = LEAST(global_token_settings."rank", EXCLUDED."rank")`,
          [p.symbol, pairRank]
        );
        added++;
      }
    }

    // Mark tokens that don't exist on Bitunix as banned (if they were previously added)
    const bitunixSet = new Set(pairs.map(p => p.symbol));
    for (const row of existing) {
      if (!bitunixSet.has(row.symbol) && !row.banned) {
        await query(
          'UPDATE global_token_settings SET banned = true WHERE symbol = $1',
          [row.symbol]
        );
        removed++;
      }
    }

    // Clear candle cache since token list changed
    try {
      await query('DELETE FROM optimizer_cache');
    } catch (_) {}

    const finalRows = await query('SELECT COUNT(*) as total FROM global_token_settings WHERE enabled = true AND banned = false');
    const enabledCount = parseInt(finalRows[0].total);

    res.json({
      ok: true,
      bitunixTotal: pairs.length,
      added,
      unchanged,
      bannedInvalid: removed,
      enabledCount,
      message: `Found ${pairs.length} Bitunix pairs. Added ${added} new, ${removed} invalid banned. ${enabledCount} tokens now enabled.`,
    });
  } catch (err) {
    console.error('Scan Bitunix tokens error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Token Leverage Management ────────────────────────────────

// List all token leverage settings
router.get('/token-leverage', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM token_leverage WHERE enabled = true ORDER BY symbol');
    res.json(rows);
  } catch (err) {
    console.error('Token leverage list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Set leverage for a token
router.post('/token-leverage', async (req, res) => {
  try {
    const { symbol, leverage } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const lev = parseInt(leverage);
    if (!lev || lev < 1 || lev > 125) return res.status(400).json({ error: 'Leverage must be 1-125' });

    await query(
      `INSERT INTO token_leverage (symbol, leverage, enabled)
       VALUES ($1, $2, true)
       ON CONFLICT (symbol) DO UPDATE SET leverage = EXCLUDED.leverage, enabled = true`,
      [symbol.toUpperCase(), lev]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Token leverage set error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove token leverage setting
router.post('/remove-token-leverage', async (req, res) => {
  try {
    const symbol = (req.body.symbol || '').toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    await query('DELETE FROM token_leverage WHERE symbol = $1', [symbol]);
    res.json({ ok: true, symbol });
  } catch (err) {
    console.error('Token leverage remove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auto-populate: fetch all tokens above $1000 from Binance and add with default leverage
router.post('/token-leverage/auto-populate', async (req, res) => {
  try {
    const defaultLev = parseInt(req.body.default_leverage) || 20;
    const minPrice = parseFloat(req.body.min_price) || 1000;

    const fetch = require('node-fetch');
    const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const tickers = await response.json();
    const usdtPairs = tickers.filter(t =>
      t.symbol.endsWith('USDT') && parseFloat(t.price) >= minPrice
    );

    let added = 0;
    for (const t of usdtPairs) {
      const sym = t.symbol;
      const price = parseFloat(t.price);
      // BTC/ETH get 100x, others get the default
      const isTopCoin = sym === 'BTCUSDT' || sym === 'ETHUSDT';
      const lev = isTopCoin ? 100 : defaultLev;

      await query(
        `INSERT INTO token_leverage (symbol, leverage, enabled)
         VALUES ($1, $2, true)
         ON CONFLICT (symbol) DO NOTHING`,
        [sym, lev]
      );
      added++;
    }

    res.json({ ok: true, added, tokens: usdtPairs.map(t => ({ symbol: t.symbol, price: parseFloat(t.price) })) });
  } catch (err) {
    console.error('Token leverage auto-populate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List all open positions across all users ────
// Merges DB-tracked OPEN trades with live positions from all exchanges
router.get('/open-positions', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');

    // 1. DB-tracked OPEN trades
    const rows = await query(
      `SELECT t.id, t.symbol, t.direction, t.entry_price, t.quantity, t.leverage,
              t.sl_price, t.tp_price, t.trailing_sl_price, t.pnl_usdt,
              t.created_at, u.email, ak.platform, ak.id as key_id
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       JOIN users u ON u.id = t.user_id
       WHERE t.status = 'OPEN'
       ORDER BY t.symbol, u.email`
    );

    // 2. Fetch live positions from ALL enabled exchanges in parallel
    const allKeys = await query(
      `SELECT ak.id, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform, ak.leverage, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true`
    );

    // key: "keyId:symbol" → true — for dedup against DB rows
    const dbKeySymSet = new Set(rows.map(r => `${r.key_id}:${r.symbol}`));

    // Fetch live positions from each key in parallel (timeout 8s per key)
    const livePositions = []; // extra positions only on exchange, not in DB
    const liveResults = await Promise.allSettled(allKeys.map(async key => {
      try {
        const apiKey    = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

        if (key.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey, apiSecret });
          const raw = await Promise.race([
            client.getOpenPositions(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]);
          const positions = Array.isArray(raw) ? raw : [];
          for (const p of positions) {
            if (parseFloat(p.qty || p.size || 0) === 0) continue;
            const sym = (p.symbol || '').toUpperCase();
            // Only add if NOT already tracked in DB
            if (!dbKeySymSet.has(`${key.id}:${sym}`)) {
              livePositions.push({
                keyId: key.id,
                email: key.email,
                platform: 'bitunix',
                symbol: sym,
                direction: (p.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
                entry: parseFloat(p.entryPrice || p.avgOpenPrice || 0),
                qty: parseFloat(p.qty || p.size || 0),
                leverage: parseInt(key.leverage) || 20,
                unrealizedPnl: parseFloat(p.unrealizedPNL || p.unrealizedPnl || 0),
                liveOnly: true, // not in DB
              });
            }
          }
        } else if (key.platform === 'binance') {
          try {
            const { USDMClient } = require('binance');
            const getBinanceRequestOptions = () => {
              const PROXY_URL = process.env.QUOTAGUARDSTATIC_URL;
              if (!PROXY_URL) return {};
              const { HttpsProxyAgent } = require('https-proxy-agent');
              return { requestOptions: { agent: new HttpsProxyAgent(PROXY_URL) } };
            };
            const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
            const account = await Promise.race([
              client.getAccountInformation({ omitZeroBalances: true }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
            ]);
            for (const p of (account.positions || [])) {
              const amt = parseFloat(p.positionAmt);
              if (amt === 0) continue;
              const sym = (p.symbol || '').toUpperCase();
              if (!dbKeySymSet.has(`${key.id}:${sym}`)) {
                livePositions.push({
                  keyId: key.id,
                  email: key.email,
                  platform: 'binance',
                  symbol: sym,
                  direction: amt > 0 ? 'LONG' : 'SHORT',
                  entry: parseFloat(p.entryPrice || 0),
                  qty: Math.abs(amt),
                  leverage: parseInt(p.leverage) || 20,
                  unrealizedPnl: parseFloat(p.unrealizedProfit || 0),
                  liveOnly: true,
                });
              }
            }
          } catch (_) {} // Binance errors are non-fatal
        }
      } catch (_) {} // Key-level errors are non-fatal
    }));

    // 3. Fetch live prices from Binance (fastest public endpoint)
    let priceMap = {};
    try {
      const fetch = require('node-fetch');
      const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/price', { timeout: 8000 });
      const tickers = await r.json();
      for (const t of tickers) priceMap[t.symbol] = parseFloat(t.price);
    } catch {}

    function buildPosition(t, overrides = {}) {
      const entry    = overrides.entry    ?? (parseFloat(t.entry_price) || 0);
      const qty      = overrides.qty      ?? (parseFloat(t.quantity) || 0);
      const lev      = overrides.leverage ?? (parseInt(t.leverage) || 20);
      const isLong   = (overrides.direction ?? t.direction) !== 'SHORT';
      const curPrice = priceMap[overrides.symbol ?? t.symbol] || entry;

      const pricePnl  = isLong ? (curPrice - entry) / entry : (entry - curPrice) / entry;
      const capitalPnl = pricePnl * lev;
      // For live-only positions, prefer exchange-reported unrealizedPnl if available
      const pnlUsdt = overrides.unrealizedPnl != null
        ? overrides.unrealizedPnl
        : (isLong ? (curPrice - entry) * qty : (entry - curPrice) * qty);

      const sl     = parseFloat((t.trailing_sl_price || t.sl_price) ?? 0) || 0;
      const slDist = sl > 0 ? (isLong ? (curPrice - sl) / curPrice * 100 : (sl - curPrice) / curPrice * 100) : 0;
      const durationMin = t.created_at ? Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000) : 0;

      let danger = 'safe';
      if (capitalPnl < -0.5) danger = 'critical';
      else if (capitalPnl < -0.2) danger = 'danger';
      else if (capitalPnl < 0) danger = 'warning';

      return {
        id: t.id || null,
        symbol:    overrides.symbol    ?? t.symbol,
        direction: overrides.direction ?? t.direction,
        email:     overrides.email     ?? t.email,
        platform:  overrides.platform  ?? t.platform,
        liveOnly:  overrides.liveOnly  ?? false,
        entry, curPrice, qty, leverage: lev,
        pnlUsdt:    parseFloat(pnlUsdt.toFixed(2)),
        pnlPct:     parseFloat((pricePnl * 100).toFixed(2)),
        capitalPnl: parseFloat((capitalPnl * 100).toFixed(1)),
        sl, tp: parseFloat(t.tp_price ?? 0) || 0, slDist: parseFloat(slDist.toFixed(1)),
        durationMin, danger,
      };
    }

    // 4. Build full position list: DB rows first, then live-only
    const positions = [
      ...rows.map(t => buildPosition(t)),
      ...livePositions.map(p => buildPosition({}, {
        symbol: p.symbol, direction: p.direction, email: p.email,
        platform: p.platform, leverage: p.leverage, entry: p.entry,
        qty: p.qty, unrealizedPnl: p.unrealizedPnl, liveOnly: true,
      })),
    ];

    // 5. Group by symbol
    const grouped = {};
    for (const p of positions) {
      if (!grouped[p.symbol]) grouped[p.symbol] = { symbol: p.symbol, direction: p.direction, trades: [], totalPnl: 0 };
      grouped[p.symbol].trades.push(p);
      grouped[p.symbol].totalPnl += p.pnlUsdt;
    }

    res.json({ positions: Object.values(grouped), all: positions, total: positions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: show raw Bitunix positions for first active key ────
router.get('/debug-positions', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');
    const keys = await query(
      `SELECT ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag, u.email
       FROM api_keys ak JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true AND ak.platform = 'bitunix' LIMIT 1`
    );
    if (!keys.length) return res.json({ error: 'No active Bitunix keys' });
    const apiKey = cryptoUtils.decrypt(keys[0].api_key_enc, keys[0].iv, keys[0].auth_tag);
    const apiSecret = cryptoUtils.decrypt(keys[0].api_secret_enc, keys[0].secret_iv, keys[0].secret_auth_tag);
    const client = new BitunixClient({ apiKey, apiSecret });
    const positions = await client.getOpenPositions();
    res.json({ user: keys[0].email, raw: positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: show raw Bitunix open positions (to check field names)
router.get('/debug-bitunix-positions', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');
    const keys = await query(
      `SELECT ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
       FROM api_keys ak
       WHERE ak.enabled = true AND ak.platform = 'bitunix' LIMIT 1`
    );
    if (!keys.length) return res.json({ error: 'No active Bitunix keys' });
    const apiKey = cryptoUtils.decrypt(keys[0].api_key_enc, keys[0].iv, keys[0].auth_tag);
    const apiSecret = cryptoUtils.decrypt(keys[0].api_secret_enc, keys[0].secret_iv, keys[0].secret_auth_tag);
    const client = new BitunixClient({ apiKey, apiSecret });
    const rawPositions = await client._rawGet('/api/v1/futures/position/get_pending_positions', {});
    res.json({ rawPositions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: show raw Bitunix position history + order history to check PnL
router.get('/debug-bitunix-history', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');
    const keys = await query(
      `SELECT ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag, u.email
       FROM api_keys ak JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true AND ak.platform = 'bitunix' LIMIT 1`
    );
    if (!keys.length) return res.json({ error: 'No active Bitunix keys' });
    const apiKey = cryptoUtils.decrypt(keys[0].api_key_enc, keys[0].iv, keys[0].auth_tag);
    const apiSecret = cryptoUtils.decrypt(keys[0].api_secret_enc, keys[0].secret_iv, keys[0].secret_auth_tag);
    const client = new BitunixClient({ apiKey, apiSecret });

    const symbol = (req.query.symbol || '').toUpperCase() || undefined;
    const [posHistory, orderHistory] = await Promise.all([
      client.getHistoryPositions({ symbol, pageSize: 20 }).catch(e => ({ error: e.message })),
      client.getHistoryOrders({ symbol, pageSize: 20 }).catch(e => ({ error: e.message })),
    ]);

    res.json({ user: keys[0].email, posHistory, orderHistory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Emergency Close: close a specific token across ALL users ────
router.post('/emergency-close', async (req, res) => {
  const symbol = (req.body.symbol || '').toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  console.log(`[ADMIN] ⚠️ EMERGENCY CLOSE ${symbol} for all users`);
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');

    const keys = await query(
      `SELECT ak.id, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true`
    );

    const results = [];
    let totalClosed = 0;

    for (const key of keys) {
      try {
        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

        if (key.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey, apiSecret });
          const positions = await client.getOpenPositions(symbol);
          const openPos = Array.isArray(positions) ? positions.filter(p => p.symbol === symbol && parseFloat(p.qty) > 0) : [];

          if (openPos.length > 0) {
            for (const pos of openPos) {
              try {
                console.log(`[EMERGENCY] Flash closing ${pos.symbol} positionId=${pos.positionId} side=${pos.side} qty=${pos.qty} for ${key.email}`);
                const closeResult = await client.flashClose({ positionId: pos.positionId });
                console.log(`[EMERGENCY] Close result:`, JSON.stringify(closeResult));
                await query(
                  `UPDATE trades SET status = 'CLOSED', exit_price = $1, closed_at = NOW()
                   WHERE api_key_id = $2 AND symbol = $3 AND status = 'OPEN'`,
                  [parseFloat(pos.avgOpenPrice || 0), key.id, pos.symbol]
                );
                totalClosed++;
                results.push({ user: key.email, symbol: pos.symbol, side: pos.side, qty: pos.qty, status: 'CLOSED' });
                console.log(`[EMERGENCY] Closed ${pos.symbol} ${pos.side} qty=${pos.qty} for ${key.email}`);
              } catch (closeErr) {
                results.push({ user: key.email, symbol: pos.symbol, status: 'FAILED', error: closeErr.message });
              }
            }
          } else {
            // No exchange position found — mark DB trades as closed (phantom cleanup)
            const phantomRows = await query(
              `UPDATE trades SET status = 'CLOSED', closed_at = NOW()
               WHERE api_key_id = $1 AND symbol = $2 AND status = 'OPEN'
               RETURNING id`,
              [key.id, symbol]
            );
            if (phantomRows.length > 0) {
              console.log(`[EMERGENCY] Cleaned ${phantomRows.length} phantom DB trade(s) for ${key.email} ${symbol}`);
              totalClosed += phantomRows.length;
              results.push({ user: key.email, symbol, status: 'PHANTOM_CLEANED', count: phantomRows.length });
            }
          }
        } else {
          // Binance — cancel orders first, then close via market order
          try {
            const { USDMClient } = require('binance');
            const getBinanceRequestOptions = () => {
              const PROXY_URL = process.env.QUOTAGUARDSTATIC_URL;
              if (!PROXY_URL) return {};
              const { HttpsProxyAgent } = require('https-proxy-agent');
              return { requestOptions: { agent: new HttpsProxyAgent(PROXY_URL) } };
            };
            const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
            const account = await client.getAccountInformation({ omitZeroBalances: false });
            const openPos = account.positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (openPos.length > 0) {
              // Cancel all existing orders (SL/TP) first so they don't interfere
              try { await client.cancelAllOpenOrders({ symbol }); } catch (_) {}
              try { await client.cancelAllAlgoOpenOrders({ symbol }); } catch (_) {}

              for (const pos of openPos) {
                try {
                  const amt = parseFloat(pos.positionAmt);
                  const closeSide = amt > 0 ? 'SELL' : 'BUY';
                  const absAmt = Math.abs(amt);
                  console.log(`[EMERGENCY] Binance closing ${symbol} ${closeSide} qty=${absAmt} for ${key.email}`);
                  await client.submitNewOrder({ symbol, side: closeSide, type: 'MARKET', quantity: absAmt, reduceOnly: 'true' });
                  const exitPrice = parseFloat(pos.markPrice || pos.entryPrice || 0);
                  await query(`UPDATE trades SET status = 'CLOSED', exit_price = $1, closed_at = NOW() WHERE api_key_id = $2 AND symbol = $3 AND status = 'OPEN'`, [exitPrice, key.id, symbol]);
                  totalClosed++;
                  results.push({ user: key.email, symbol, side: amt > 0 ? 'LONG' : 'SHORT', qty: absAmt, status: 'CLOSED' });
                } catch (closeErr) {
                  console.error(`[EMERGENCY] Binance close failed for ${key.email} ${symbol}:`, closeErr.message);
                  results.push({ user: key.email, symbol, status: 'FAILED', error: closeErr.message });
                }
              }
            } else {
              const phantomRows = await query(`UPDATE trades SET status = 'CLOSED', closed_at = NOW() WHERE api_key_id = $1 AND symbol = $2 AND status = 'OPEN' RETURNING id`, [key.id, symbol]);
              if (phantomRows.length > 0) {
                totalClosed += phantomRows.length;
                results.push({ user: key.email, symbol, status: 'PHANTOM_CLEANED', count: phantomRows.length });
              }
            }
          } catch (binErr) {
            console.error(`[EMERGENCY] Binance error for ${key.email}:`, binErr.message);
            results.push({ user: key.email, symbol, status: 'BINANCE_ERROR', error: binErr.message });
          }
        }
      } catch (keyErr) {
        results.push({ user: key.email, status: 'KEY_ERROR', error: keyErr.message });
      }
    }

    // Also close owner account position
    try {
      const ownerKey = process.env.BINANCE_API_KEY;
      const ownerSecret = process.env.BINANCE_API_SECRET;
      if (ownerKey && ownerSecret) {
        const { USDMClient } = require('binance');
        const getBinanceRequestOptions = () => {
          const PROXY_URL = process.env.QUOTAGUARDSTATIC_URL;
          if (!PROXY_URL) return {};
          const { HttpsProxyAgent } = require('https-proxy-agent');
          return { requestOptions: { agent: new HttpsProxyAgent(PROXY_URL) } };
        };
        const ownerClient = new USDMClient({ api_key: ownerKey, api_secret: ownerSecret }, getBinanceRequestOptions());
        const ownerAccount = await ownerClient.getAccountInformation({ omitZeroBalances: false });
        const ownerPos = ownerAccount.positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (ownerPos.length > 0) {
          try { await ownerClient.cancelAllOpenOrders({ symbol }); } catch (_) {}
          try { await ownerClient.cancelAllAlgoOpenOrders({ symbol }); } catch (_) {}
          for (const pos of ownerPos) {
            const amt = parseFloat(pos.positionAmt);
            const closeSide = amt > 0 ? 'SELL' : 'BUY';
            console.log(`[EMERGENCY] Owner closing ${symbol} ${closeSide} qty=${Math.abs(amt)}`);
            await ownerClient.submitNewOrder({ symbol, side: closeSide, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true' });
            totalClosed++;
            results.push({ user: 'OWNER', symbol, side: amt > 0 ? 'LONG' : 'SHORT', qty: Math.abs(amt), status: 'CLOSED' });
          }
          // Clean up tradeState in cycle.js
          try {
            const { tradeState } = require('../cycle');
            if (tradeState && tradeState.has(symbol)) {
              tradeState.delete(symbol);
              console.log(`[EMERGENCY] Cleared tradeState for ${symbol}`);
            }
          } catch (_) {}
        }
      }
    } catch (ownerErr) {
      console.error(`[EMERGENCY] Owner close error:`, ownerErr.message);
      results.push({ user: 'OWNER', symbol, status: 'FAILED', error: ownerErr.message });
    }

    console.log(`[ADMIN] Emergency close ${symbol}: ${totalClosed} positions closed across ${keys.length + 1} accounts`);
    res.json({ ok: true, symbol, totalClosed, totalUsers: keys.length, results });
  } catch (err) {
    console.error('Emergency close error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Force re-sync all trades with exchange data ────
router.post('/fix-bitunix-pnl', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');
    const { USDMClient } = require('binance');
    const getBinanceRequestOptions = () => {
      const PROXY_URL = process.env.QUOTAGUARDSTATIC_URL;
      if (!PROXY_URL) return {};
      const { HttpsProxyAgent } = require('https-proxy-agent');
      return { requestOptions: { agent: new HttpsProxyAgent(PROXY_URL) } };
    };

    // Step 1: Delete ERROR trades (never executed on exchange — no data to sync)
    const errorDeleted = await query(
      `DELETE FROM trades WHERE status = 'ERROR' OR (entry_price IS NULL AND exit_price IS NULL) RETURNING id`
    );
    const errorCount = errorDeleted.length;

    // Step 2: Find trades that need syncing (OPEN, $0 PnL, or NULL exit)
    const badTrades = await query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE t.status = 'OPEN'
          OR (t.pnl_usdt = 0 AND t.exit_price IS NOT NULL)
          OR t.pnl_usdt IS NULL
       ORDER BY t.created_at DESC
       LIMIT 100`
    );

    if (!badTrades.length && errorCount === 0) return res.json({ ok: true, fixed: 0, errors_deleted: 0, message: 'No trades to fix' });
    if (!badTrades.length) return res.json({ ok: true, fixed: 0, errors_deleted: errorCount, message: `Deleted ${errorCount} ERROR trades` });

    const results = [];
    for (const trade of badTrades) {
      try {
        const apiKey = cryptoUtils.decrypt(trade.api_key_enc, trade.iv, trade.auth_tag);
        const apiSecret = cryptoUtils.decrypt(trade.api_secret_enc, trade.secret_iv, trade.secret_auth_tag);

        const entryPrice = parseFloat(trade.entry_price);
        const qty = parseFloat(trade.quantity || 0);
        const isLong = trade.direction !== 'SHORT';
        let exitPrice = entryPrice;
        let realizedPnl = null;
        let isStillOpen = false;

        if (trade.platform === 'binance') {
          const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
          const account = await client.getAccountInformation({ omitZeroBalances: false });
          const openPos = account.positions.find(p => p.symbol === trade.symbol && parseFloat(p.positionAmt) !== 0);

          if (openPos) {
            const livePnl = parseFloat(openPos.unrealizedProfit || 0);
            await query('UPDATE trades SET pnl_usdt = $1 WHERE id = $2', [livePnl, trade.id]);
            results.push({ id: trade.id, symbol: trade.symbol, status: 'STILL_OPEN', pnl: livePnl });
            continue;
          }

          // Closed — get fill data
          try {
            const openTime = trade.created_at ? new Date(trade.created_at).getTime() : Date.now() - 7 * 86400000;
            const fills = await client.getAccountTrades({ symbol: trade.symbol, startTime: openTime, limit: 50 });
            const closeSide = isLong ? 'SELL' : 'BUY';
            const closeFills = (fills || []).filter(f => f.side === closeSide);
            if (closeFills.length > 0) {
              let totalQty = 0, totalValue = 0, totalPnl = 0;
              for (const f of closeFills) {
                const fQty = parseFloat(f.qty);
                totalQty += fQty;
                totalValue += fQty * parseFloat(f.price);
                totalPnl += parseFloat(f.realizedPnl || 0);
              }
              if (totalQty > 0) exitPrice = totalValue / totalQty;
              if (totalPnl !== 0) realizedPnl = totalPnl;
            }
          } catch {
            try {
              const ticker = await client.getSymbolPriceTicker({ symbol: trade.symbol });
              exitPrice = parseFloat(ticker.price);
            } catch { /* keep entryPrice */ }
          }
        } else if (trade.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey, apiSecret });
          const account = await client.getAccountInformation();
          const openPos = (account.positions || []).find(p => p.symbol === trade.symbol);

          if (openPos) {
            const livePnl = parseFloat(openPos.unrealizedProfit || 0);
            await query('UPDATE trades SET pnl_usdt = $1 WHERE id = $2', [livePnl, trade.id]);
            results.push({ id: trade.id, symbol: trade.symbol, status: 'STILL_OPEN', pnl: livePnl });
            continue;
          }

          let found = false;
          let posExchangeFee = 0;
          let posFundingFee = 0;
          const tradeOpenTime = trade.created_at ? new Date(trade.created_at).getTime() : 0;
          const tradeEntry = parseFloat(trade.entry_price);
          const tradeSideLong = trade.direction !== 'SHORT';

          // Method 1: Position history — match by entry price + side + time
          // Net PnL = realizedPNL - fee - funding
          try {
            const positions = await client.getHistoryPositions({ symbol: trade.symbol, pageSize: 50 });
            for (const p of positions) {
              const cp = parseFloat(p.closePrice || 0);
              const ep = parseFloat(p.entryPrice || p.avgOpenPrice || 0);
              // Bitunix returns side as "BUY"/"SELL", not "LONG"/"SHORT"
              const pSide = (p.side || '').toUpperCase();
              const pSideLong = pSide === 'BUY' || pSide === 'LONG';
              const closeMs = parseInt(p.mtime || p.ctime || 0);
              const entryMatch = ep > 0 && Math.abs(ep - tradeEntry) / tradeEntry < 0.002;
              const sideMatch = pSideLong === tradeSideLong;
              const timeMatch = !tradeOpenTime || !closeMs || closeMs > tradeOpenTime;

              if (cp > 0 && p.symbol === trade.symbol && entryMatch && sideMatch && timeMatch) {
                exitPrice = cp;
                // NOTE: Bitunix realizedPNL is already net (fees + funding deducted)
                realizedPnl = parseFloat(p.realizedPNL || 0);
                posExchangeFee = Math.abs(parseFloat(p.fee || 0));
                posFundingFee  = Math.abs(parseFloat(p.funding || 0));
                found = true;
                break;
              }
            }
          } catch { /* try next method */ }

          // Method 2: Order history — CLOSE orders
          if (!found) {
            try {
              const orderList = await client.getHistoryOrders({ symbol: trade.symbol, pageSize: 50 });
              for (const o of orderList) {
                const oPrice = parseFloat(o.avgPrice || o.price || 0);
                const isClose = o.reduceOnly || o.tradeSide === 'CLOSE';
                const oMs = parseInt(o.ctime || o.mtime || 0);
                const timeMatch = !tradeOpenTime || !oMs || oMs > tradeOpenTime;

                if (isClose && oPrice > 0 && timeMatch) {
                  exitPrice = oPrice;
                  const pnlVal = parseFloat(o.realizedPNL || 0);
                  const fee = Math.abs(parseFloat(o.fee || 0));
                  realizedPnl = pnlVal - fee;
                  found = true;
                  break;
                }
              }
            } catch { /* try next method */ }
          }

          // Method 3: Market price fallback
          if (!found) {
            try {
              const priceData = await client.getMarketPrice(trade.symbol);
              const mp = parseFloat(priceData?.lastPrice || priceData?.price || priceData || 0);
              if (mp > 0) exitPrice = mp;
            } catch { /* keep entryPrice */ }
          }
        }

        // Calculate PnL
        let pnlUsdt;
        if (realizedPnl !== null) {
          pnlUsdt = parseFloat(realizedPnl.toFixed(4));
        } else {
          pnlUsdt = isLong
            ? parseFloat(((exitPrice - entryPrice) * qty).toFixed(4))
            : parseFloat(((entryPrice - exitPrice) * qty).toFixed(4));
        }
        const status = pnlUsdt > 0 ? 'WIN' : 'LOSS';
        const totalFee = posExchangeFee + posFundingFee;
        const grossPnl = parseFloat((pnlUsdt + totalFee).toFixed(4));

        await query(
          `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3,
           trading_fee = $5, funding_fee = $6, gross_pnl = $7,
           closed_at = COALESCE(closed_at, NOW())
           WHERE id = $4`,
          [status, pnlUsdt, exitPrice, trade.id, posExchangeFee, posFundingFee, grossPnl]
        );

        results.push({ id: trade.id, symbol: trade.symbol, platform: trade.platform, status, pnl: pnlUsdt, exitPrice, entryPrice, qty, realizedPnl });
      } catch (err) {
        results.push({ id: trade.id, symbol: trade.symbol, error: err.message });
      }
    }

    res.json({ ok: true, fixed: results.length, errors_deleted: errorCount, results });
  } catch (err) {
    console.error('Fix trade sync error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Diagnostic: test Bitunix API responses for a trade ────
router.post('/debug-bitunix', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');

    // Find a Bitunix trade to test
    const trades = await query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE ak.platform = 'bitunix'
       ORDER BY t.created_at DESC LIMIT 1`
    );

    if (!trades.length) return res.json({ error: 'No Bitunix trades found' });

    const trade = trades[0];
    const apiKey = cryptoUtils.decrypt(trade.api_key_enc, trade.iv, trade.auth_tag);
    const apiSecret = cryptoUtils.decrypt(trade.api_secret_enc, trade.secret_iv, trade.secret_auth_tag);
    const client = new BitunixClient({ apiKey, apiSecret });

    const results = {
      trade: { id: trade.id, symbol: trade.symbol, direction: trade.direction, entry: trade.entry_price },
      keyPreview: apiKey.substring(0, 8) + '...',
    };

    const sym = trade.symbol;
    // Bitunix might use different symbol format
    const symDash = sym.replace('USDT', '-USDT');

    // Account works! Auth + proxy confirmed. Now find the right trade history endpoint.

    // 1. Position history endpoints (closed positions = what we need)
    try { results.posHistory_v1 = await client._rawPost('/api/v1/futures/position/get_history_positions', { pageNum: 1, pageSize: 5 }); } catch (e) { results.posHistory_v1_err = e.message; }
    try { results.posHistory_GET = await client._rawGet('/api/v1/futures/position/get_history_positions', { pageNum: 1, pageSize: 5 }); } catch (e) { results.posHistory_GET_err = e.message; }

    // 2. Open positions (GET)
    try { results.openPos = await client._rawGet('/api/v1/futures/position/get_pending_positions', {}); } catch (e) { results.openPos_err = e.message; }

    // 3. get_fills needs orderId?
    try { results.fills_orderId = await client._rawPost('/api/v1/futures/trade/get_fills', { orderId: '12345', symbol: sym }); } catch (e) { results.fills_orderId_err = e.message; }

    // 4. Order list endpoints (GET vs POST)
    try { results.orderList_GET = await client._rawGet('/api/v1/futures/trade/get_history_orders', { symbol: sym, pageNum: 1, pageSize: 5 }); } catch (e) { results.orderList_GET_err = e.message; }
    try { results.openOrders = await client._rawGet('/api/v1/futures/trade/get_open_orders', { symbol: sym }); } catch (e) { results.openOrders_err = e.message; }
    try { results.openOrders_POST = await client._rawPost('/api/v1/futures/trade/get_open_orders', { symbol: sym }); } catch (e) { results.openOrders_POST_err = e.message; }

    // 5. Try /api/v1/futures/order/ paths
    try { results.orderHist_alt = await client._rawPost('/api/v1/futures/order/get_history_orders', { symbol: sym, pageNum: 1, pageSize: 5 }); } catch (e) { results.orderHist_alt_err = e.message; }

    // 6. Bill/ledger endpoint (some exchanges put PnL here)
    try { results.bills = await client._rawPost('/api/v1/futures/account/bills', { pageNum: 1, pageSize: 5 }); } catch (e) { results.bills_err = e.message; }
    try { results.bills_GET = await client._rawGet('/api/v1/futures/account/bills', { pageNum: 1, pageSize: 5 }); } catch (e) { results.bills_GET_err = e.message; }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI Versions — list for backtest version selector ──────────
// POST /api/admin/ai-versions/:id/activate
// Saves the selected backtest version's params to the settings table so cycle.js
// picks them up for live trading (SL%, trail step, max positions, max losses).
router.post('/ai-versions/:id/activate', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const vId = parseInt(req.params.id);
    if (!vId || isNaN(vId)) return res.status(400).json({ error: 'Invalid id' });

    const rows = await query(`SELECT * FROM ai_versions WHERE id = $1`, [vId]);
    if (!rows.length) return res.status(404).json({ error: 'Version not found' });

    const v = rows[0];
    const params = typeof v.params === 'string' ? JSON.parse(v.params) : (v.params || {});

    // Persist to settings table — cycle.js reads this every 60s
    await query(
      `INSERT INTO settings (key, value) VALUES ('active_ai_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ id: v.id, version: v.version, ...params })]
    );

    res.json({ ok: true, version: v.version, params });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ai-versions/deactivate — revert to hardcoded defaults
router.post('/ai-versions/deactivate', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });
    await query(`DELETE FROM settings WHERE key = 'active_ai_version'`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ai-versions', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, version, trade_count, win_rate, avg_pnl, total_pnl,
              params, setup_weights, avoided_coins, changes, created_at
       FROM ai_versions ORDER BY id DESC LIMIT 50`
    );
    res.json({ versions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ai-versions/activate-manual
// Activates a set of params typed directly in the backtest UI (no saved version needed).
router.post('/ai-versions/activate-manual', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const { name, params } = req.body;
    if (!params || typeof params !== 'object') return res.status(400).json({ error: 'params required' });

    await query(
      `INSERT INTO settings (key, value) VALUES ('active_ai_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ version: name || 'Manual', ...params })]
    );
    res.json({ ok: true, version: name || 'Manual', params });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/ai-versions/active — returns the currently active version params (or null)
router.get('/ai-versions/active', async (req, res) => {
  try {
    const rows = await query(`SELECT value FROM settings WHERE key = 'active_ai_version'`);
    if (!rows.length) return res.json(null);
    res.json(JSON.parse(rows[0].value));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backtest: configurable risk settings + AI version selector ────
router.post('/backtest', async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);
  try {
    const fetch = require('node-fetch');
    const { getFetchOptions } = require('../proxy-agent');

    // ── Risk & Position Management ───────────────────────────────────────────
    const TOP_N         = Math.min(parseInt(req.body.topN) || 100, 200);
    const WALLET_START  = parseFloat(req.body.wallet) || 1000;
    const RISK_PCT      = Math.min(parseFloat(req.body.riskPct) || 0.10, 1);
    const MAX_POS       = parseInt(req.body.maxPositions) || 3;
    const SL_PCT        = parseFloat(req.body.slPct) || 0.03;
    const TP_PCT        = parseFloat(req.body.tpPct) || 0;   // 0 = no fixed TP, trailing only
    const TRAIL_FIRST   = parseFloat(req.body.trailStep) || 0.012;
    const TRAIL_STEP    = TRAIL_FIRST;
    const MAX_LEVERAGE  = parseInt(req.body.leverage) || 20;
    const MAX_CONSEC_LOSS = parseInt(req.body.maxConsecLoss) ?? 2;

    // ── Structure Analysis ────────────────────────────────────────────────────
    // Swing lookback: how many candles left+right define a swing high/low
    const SWING = {
      '4h':  parseInt(req.body.swing4h)  || 10,
      '1h':  parseInt(req.body.swing1h)  || 10,
      '15m': parseInt(req.body.swing15m) || 10,
      '1m':  parseInt(req.body.swing1m)  || 5,
    };
    // Proximity to key level (PDH/PDL/VWAP) — % of price
    const PROXIMITY       = parseFloat(req.body.proximity)       || 0.003;
    // 1m entry freshness — max candles ago the swing extreme can be
    const ENTRY_FRESH     = parseInt(req.body.entryFresh)        || 25;
    // Daily candle body/range ratio — below this = doji/indecision, skip
    const DAILY_BODY_RATIO = parseFloat(req.body.dailyBodyRatio) || 0.30;

    // ── RSI Filter ────────────────────────────────────────────────────────────
    // rsiPeriod = 0 → disabled
    const RSI_PERIOD = parseInt(req.body.rsiPeriod) ?? 14;
    const RSI_OB     = parseFloat(req.body.rsiOb)   || 75;   // reject LONG if RSI > this
    const RSI_OS     = parseFloat(req.body.rsiOs)   || 25;   // reject SHORT if RSI < this

    // ── EMA Filter ────────────────────────────────────────────────────────────
    // emaFast = 0 → EMA filter disabled
    const EMA_FAST  = parseInt(req.body.emaFast)  || 0;
    const EMA_SLOW  = parseInt(req.body.emaSlow)  || 21;
    const EMA_TREND = parseInt(req.body.emaTrend) || 50;   // 0 = skip trend filter

    // ── Volume Filter ─────────────────────────────────────────────────────────
    // volMult = 0 → disabled; e.g. 1.5 = entry candle must be 1.5× avg volume
    const VOL_MULT = parseFloat(req.body.volMult) || 0;

    // ── Direction Settings ────────────────────────────────────────────────────
    // Enable/disable each direction, and optionally override SL/TP/Trail per direction.
    // If a per-direction value is 0 or absent, falls back to the global value above.
    const ENABLE_LONG  = req.body.enableLong  !== false && req.body.enableLong  !== 'false';
    const ENABLE_SHORT = req.body.enableShort !== false && req.body.enableShort !== 'false';

    const SL_LONG   = parseFloat(req.body.slPctLong)     || SL_PCT;
    const SL_SHORT  = parseFloat(req.body.slPctShort)    || SL_PCT;
    const TP_LONG   = parseFloat(req.body.tpPctLong)     || TP_PCT;
    const TP_SHORT  = parseFloat(req.body.tpPctShort)    || TP_PCT;
    const TRAIL_LONG  = parseFloat(req.body.trailStepLong)  || TRAIL_FIRST;
    const TRAIL_SHORT = parseFloat(req.body.trailStepShort) || TRAIL_FIRST;

    const STRATEGY = req.body.strategy || 'full';
    const DAYS     = Math.min(parseInt(req.body.days) || 7, 30);
    const REVERSE  = req.body.reverse === true;
    const endTime  = Date.now();

    // ── Indicator helpers ─────────────────────────────────────────────────────
    function calcRSI(closes, period) {
      if (closes.length < period + 1) return null;
      let avgGain = 0, avgLoss = 0;
      for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) avgGain += d; else avgLoss -= d;
      }
      avgGain /= period; avgLoss /= period;
      for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
      }
      if (avgLoss === 0) return 100;
      return 100 - (100 / (1 + avgGain / avgLoss));
    }

    function calcEMA(closes, period) {
      if (closes.length < period) return null;
      const k = 2 / (period + 1);
      let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
      for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
      return ema;
    }

    // Per-token leverage from admin settings
    const leverageMap = {};
    try {
      const levRows = await query('SELECT symbol, leverage FROM token_leverage WHERE enabled = true');
      for (const r of levRows) leverageMap[r.symbol] = parseInt(r.leverage) || MAX_LEVERAGE;
    } catch (_) {}

    async function fetchK(symbol, interval, limit, et) {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${et ? '&endTime=' + et : ''}`;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch(url, { timeout: 15000, ...getFetchOptions() });
          if (r.ok) return r.json();
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      return null;
    }

    // Swing detection (same as smc-engine.js)
    function detectSwings(klines, len) {
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));
      const swings = [];
      let lastType = null;
      for (let i = len; i < klines.length - len; i++) {
        let isH = true, isL = true;
        for (let j = -len; j <= len; j++) {
          if (j === 0) continue;
          if (highs[i] <= highs[i + j]) isH = false;
          if (lows[i] >= lows[i + j]) isL = false;
        }
        if (isH && isL) {
          const hd = highs[i] - Math.max(highs[i-1], highs[i+1]);
          const ld = Math.min(lows[i-1], lows[i+1]) - lows[i];
          if (hd > ld) isL = false; else isH = false;
        }
        if (isH) {
          if (lastType === 'high' && highs[i] > swings[swings.length-1].price)
            swings[swings.length-1] = { type: 'high', index: i, price: highs[i] };
          else if (lastType !== 'high') { swings.push({ type: 'high', index: i, price: highs[i] }); lastType = 'high'; }
        }
        if (isL) {
          if (lastType === 'low' && lows[i] < swings[swings.length-1].price)
            swings[swings.length-1] = { type: 'low', index: i, price: lows[i] };
          else if (lastType !== 'low') { swings.push({ type: 'low', index: i, price: lows[i] }); lastType = 'low'; }
        }
      }
      return swings;
    }

    function getStruct(klines, len) {
      const sw = detectSwings(klines, len);
      const sH = sw.filter(s => s.type === 'high');
      const sL = sw.filter(s => s.type === 'low');
      const hLabel = sH.length > 1 ? (sH[sH.length-1].price > sH[sH.length-2].price ? 'HH' : 'LH') : null;
      const lLabel = sL.length > 1 ? (sL[sL.length-1].price > sL[sL.length-2].price ? 'HL' : 'LL') : null;
      const trend = (hLabel === 'LH' && lLabel === 'LL') ? 'bearish'
        : (hLabel === 'HH' && lLabel === 'HL') ? 'bullish'
        : hLabel === 'LH' ? 'bearish_lean'
        : lLabel === 'HL' ? 'bullish_lean' : 'neutral';
      return { hasHL: lLabel === 'HL', hasLH: hLabel === 'LH', trend,
        lastHigh: sH.length ? sH[sH.length-1] : null, lastLow: sL.length ? sL[sL.length-1] : null };
    }

    function calcVWAP(klines) {
      let cv = 0, ct = 0, ct2 = 0, day = '';
      const vals = [];
      for (const k of klines) {
        const d = new Date(parseInt(k[0])).toISOString().slice(0,10);
        const h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]), v = parseFloat(k[5]);
        if (d !== day) { cv = 0; ct = 0; ct2 = 0; day = d; }
        const tp = (h+l+c)/3; ct += tp*v; ct2 += tp*tp*v; cv += v;
        if (cv > 0) { const vw = ct/cv; const sd = Math.sqrt(Math.max(0, ct2/cv - vw*vw)); vals.push({ vwap: vw, upper: vw+sd, lower: vw-sd }); }
        else vals.push({ vwap: c, upper: c, lower: c });
      }
      return vals;
    }

    function atKeyLevel(price, pdh, pdl, vwap, dir) {
      const b = vwap[vwap.length-1];
      const nPDH = Math.abs(price-pdh)/pdh < PROXIMITY;
      const nPDL = Math.abs(price-pdl)/pdl < PROXIMITY;
      const nU = Math.abs(price-b.upper)/b.upper < PROXIMITY;
      const nL = Math.abs(price-b.lower)/b.lower < PROXIMITY;
      const nV = Math.abs(price-b.vwap)/b.vwap < PROXIMITY;
      return dir === 'LONG' ? (nL || nPDL || nV) : (nU || nPDH || nV);
    }

    // Get top coins
    const tickerRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000, ...getFetchOptions() });
    const tickers = await tickerRes.json();
    const BL = new Set(['USDCUSDT','ALPACAUSDT','XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT']);
    const topCoins = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && !BL.has(t.symbol))
      .filter(t => parseFloat(t.quoteVolume) >= 10_000_000)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, TOP_N).map(t => t.symbol);

    // Fetch: Daily, 4H, 1H, 15M for all coins + 1M — parallel batches of 5
    const coinData = {};
    const startTime = endTime - DAYS * 86400000;
    const BT_BATCH = 5;
    for (let b = 0; b < topCoins.length; b += BT_BATCH) {
      const batch = topCoins.slice(b, b + BT_BATCH);
      const results = await Promise.all(batch.map(async (sym) => {
        const [kD, k4h, k1h, k15, k1] = await Promise.all([
          fetchK(sym, '1d', Math.max(10, DAYS + 2)),
          fetchK(sym, '4h', 500),
          fetchK(sym, '1h', 500),
          fetchK(sym, '15m', 1500),
          fetchK(sym, '1m', 1500),
        ]);
        return { sym, kD, k4h, k1h, k15, k1 };
      }));
      for (const r of results) {
        if (r.kD && r.k4h && r.k1h && r.k15) coinData[r.sym] = { kD:r.kD, k4h:r.k4h, k1h:r.k1h, k15:r.k15, k1:r.k1||[] };
      }
      console.log(`[BACKTEST] Fetched ${Math.min(b+BT_BATCH, topCoins.length)}/${topCoins.length} coins`);
    }

    // Simulate: Daily bias → 4H+1H → Key level → 15M setup → 1M entry → Swing SL, 1:1.5 RR
    function simulate() {
      let wallet = WALLET_START;
      const trades = [];
      const openPos = [];
      let consecLosses = 0;
      let tradingDay = '';
      const firstCoin = Object.keys(coinData)[0];
      if (!firstCoin) return { trades: [], wallet };

      // Scan on 15M steps
      const timeSteps = coinData[firstCoin].k15.map(k => parseInt(k[0])).filter(t => t >= startTime);

      for (let step = 0; step < timeSteps.length; step++) {
        const now = timeSteps[step];

        // Reset daily losses at 7am
        const d = new Date(now);
        const h = d.getHours();
        const dayKey = h < 7 ? new Date(d.getTime() - 86400000).toISOString().slice(0,10) : d.toISOString().slice(0,10);
        if (dayKey !== tradingDay) { tradingDay = dayKey; consecLosses = 0; }

        // Exit checks on 15M candles — SL hit or trailing SL
        for (let i = openPos.length - 1; i >= 0; i--) {
          const pos = openPos[i];
          const data = coinData[pos.symbol];
          if (!data) continue;
          const curCandle = data.k15.find(k => parseInt(k[0]) === now);
          if (!curCandle) continue;

          const high = parseFloat(curCandle[2]), low = parseFloat(curCandle[3]), close = parseFloat(curCandle[4]);
          // Check SL hit
          if ((pos.dir === 'LONG' && low <= pos.sl) || (pos.dir === 'SHORT' && high >= pos.sl)) {
            pos.exit = pos.sl; pos.reason = pos.lastStep > 0 ? 'TRAIL' : 'SL'; pos.exitTime = now;
            pos.pnl = pos.dir === 'LONG' ? (pos.sl - pos.entry) * pos.qty : (pos.entry - pos.sl) * pos.qty;
            wallet += pos.pnl; openPos.splice(i, 1);
            if (pos.pnl < 0) consecLosses++; else consecLosses = 0;
            continue;
          }
          // Check fixed TP hit (if configured)
          if (pos.tp) {
            if ((pos.dir === 'LONG' && high >= pos.tp) || (pos.dir === 'SHORT' && low <= pos.tp)) {
              pos.exit = pos.tp; pos.reason = 'TP'; pos.exitTime = now;
              pos.pnl = pos.dir === 'LONG' ? (pos.tp - pos.entry) * pos.qty : (pos.entry - pos.tp) * pos.qty;
              wallet += pos.pnl; openPos.splice(i, 1);
              consecLosses = 0;
              continue;
            }
          }
          // Trailing SL — uses per-position step stored at entry time
          const trailStep = pos.trailStep || TRAIL_FIRST;
          const profitPct = pos.dir === 'LONG' ? (close - pos.entry) / pos.entry : (pos.entry - close) / pos.entry;
          const nextStep = pos.lastStep === 0 ? trailStep : pos.lastStep + trailStep;
          if (profitPct >= nextStep) {
            let reached = nextStep;
            while (profitPct >= reached + trailStep) reached += trailStep;
            pos.lastStep = reached;
            const slLevel = reached <= trailStep
              ? reached - trailStep / 2
              : reached - trailStep;
            pos.sl = pos.dir === 'LONG'
              ? pos.entry * (1 + slLevel)
              : pos.entry * (1 - slLevel);
          }
        }

        if (openPos.length >= MAX_POS) continue;
        if (MAX_CONSEC_LOSS > 0 && consecLosses >= MAX_CONSEC_LOSS) continue;

        for (const sym of Object.keys(coinData)) {
          if (openPos.length >= MAX_POS) break;
          if (openPos.find(p => p.symbol === sym)) continue;
          const data = coinData[sym];

          // ── Shared data prep ──
          const dIdx = data.kD.findIndex(k => parseInt(k[0]) + 86400000 > now);
          const prevDay = dIdx > 0 ? data.kD[dIdx - 1] : null;
          const k4h = data.k4h.filter(k => parseInt(k[0]) <= now);
          const k1h = data.k1h.filter(k => parseInt(k[0]) <= now);
          const k15 = data.k15.filter(k => parseInt(k[0]) <= now);
          const k1 = data.k1.filter(k => parseInt(k[0]) <= now);
          if (k15.length < 30) continue;
          const price = parseFloat(k15[k15.length-1][4]);

          let dir = null;

          // ══════════════════════════════════════════════════════
          // STRATEGY: full (Current Live — strictest)
          // Daily → 4H+1H → KeyLevel → 15M → 1M
          // ══════════════════════════════════════════════════════
          if (STRATEGY === 'full') {
            if (!prevDay) continue;
            const dOpen = parseFloat(prevDay[1]), dClose = parseFloat(prevDay[4]);
            const dHigh = parseFloat(prevDay[2]), dLow = parseFloat(prevDay[3]);
            if ((dHigh-dLow) > 0 && (Math.abs(dClose-dOpen)/(dHigh-dLow)) < DAILY_BODY_RATIO) continue;
            const bias = dClose > dOpen ? 'bullish' : 'bearish';
            if (k4h.length < 30 || k1h.length < 30) continue;
            const s4h = getStruct(k4h, SWING['4h']), s1h = getStruct(k1h, SWING['1h']);
            const bullHTF = (s4h.trend==='bullish'||s4h.trend==='bullish_lean')&&(s1h.trend==='bullish'||s1h.trend==='bullish_lean');
            const bearHTF = (s4h.trend==='bearish'||s4h.trend==='bearish_lean')&&(s1h.trend==='bearish'||s1h.trend==='bearish_lean');
            if (bias==='bullish'&&bullHTF) dir='LONG'; else if (bias==='bearish'&&bearHTF) dir='SHORT';
            if (!dir) continue;
            const vwap = calcVWAP(k15);
            if (!atKeyLevel(price, dHigh, dLow, vwap, dir)) continue;
            const s15 = getStruct(k15, SWING['15m']);
            if ((dir==='LONG'&&!s15.hasHL)||(dir==='SHORT'&&!s15.hasLH)) continue;
            if (k1.length < 15) continue;
            const s1 = getStruct(k1, SWING['1m']);
            if ((dir==='LONG'&&!s1.hasHL)||(dir==='SHORT'&&!s1.hasLH)) continue;
            const es = dir==='LONG'?s1.lastLow:s1.lastHigh;
            if (!es||(k1.length-1-es.index)>ENTRY_FRESH) continue;
          }

          // ══════════════════════════════════════════════════════
          // STRATEGY: noKeyLevel
          // Daily → 4H+1H → 15M → 1M  (skip VWAP/PDH/PDL)
          // ══════════════════════════════════════════════════════
          else if (STRATEGY === 'noKeyLevel') {
            if (!prevDay) continue;
            const dOpen = parseFloat(prevDay[1]), dClose = parseFloat(prevDay[4]);
            const dHigh = parseFloat(prevDay[2]), dLow = parseFloat(prevDay[3]);
            if ((dHigh-dLow) > 0 && (Math.abs(dClose-dOpen)/(dHigh-dLow)) < DAILY_BODY_RATIO) continue;
            const bias = dClose > dOpen ? 'bullish' : 'bearish';
            if (k4h.length < 30 || k1h.length < 30) continue;
            const s4h = getStruct(k4h, SWING['4h']), s1h = getStruct(k1h, SWING['1h']);
            const bullHTF = (s4h.trend==='bullish'||s4h.trend==='bullish_lean')&&(s1h.trend==='bullish'||s1h.trend==='bullish_lean');
            const bearHTF = (s4h.trend==='bearish'||s4h.trend==='bearish_lean')&&(s1h.trend==='bearish'||s1h.trend==='bearish_lean');
            if (bias==='bullish'&&bullHTF) dir='LONG'; else if (bias==='bearish'&&bearHTF) dir='SHORT';
            if (!dir) continue;
            // Skip key level check — go straight to 15M
            const s15 = getStruct(k15, SWING['15m']);
            if ((dir==='LONG'&&!s15.hasHL)||(dir==='SHORT'&&!s15.hasLH)) continue;
            if (k1.length < 15) continue;
            const s1 = getStruct(k1, SWING['1m']);
            if ((dir==='LONG'&&!s1.hasHL)||(dir==='SHORT'&&!s1.hasLH)) continue;
            const es = dir==='LONG'?s1.lastLow:s1.lastHigh;
            if (!es||(k1.length-1-es.index)>ENTRY_FRESH) continue;
          }

          // ══════════════════════════════════════════════════════
          // STRATEGY: noHTF
          // Daily → 15M → 1M  (skip 4H+1H structure check)
          // ══════════════════════════════════════════════════════
          else if (STRATEGY === 'noHTF') {
            if (!prevDay) continue;
            const dOpen = parseFloat(prevDay[1]), dClose = parseFloat(prevDay[4]);
            const dHigh = parseFloat(prevDay[2]), dLow = parseFloat(prevDay[3]);
            if ((dHigh-dLow) > 0 && (Math.abs(dClose-dOpen)/(dHigh-dLow)) < DAILY_BODY_RATIO) continue;
            const bias = dClose > dOpen ? 'bullish' : 'bearish';
            dir = bias === 'bullish' ? 'LONG' : 'SHORT';
            // Skip 4H+1H — go straight to 15M
            const s15 = getStruct(k15, SWING['15m']);
            if ((dir==='LONG'&&!s15.hasHL)||(dir==='SHORT'&&!s15.hasLH)) continue;
            if (k1.length < 15) continue;
            const s1 = getStruct(k1, SWING['1m']);
            if ((dir==='LONG'&&!s1.hasHL)||(dir==='SHORT'&&!s1.hasLH)) continue;
            const es = dir==='LONG'?s1.lastLow:s1.lastHigh;
            if (!es||(k1.length-1-es.index)>ENTRY_FRESH) continue;
          }

          // ══════════════════════════════════════════════════════
          // STRATEGY: momentum
          // 15M 3-candle trend → 3M/15M setup → 1M entry (old logic)
          // ══════════════════════════════════════════════════════
          else if (STRATEGY === 'momentum') {
            const last3 = k15.slice(-4, -1);
            if (last3.length < 3) continue;
            let green = 0, red = 0;
            for (const c of last3) { if (parseFloat(c[4]) > parseFloat(c[1])) green++; else red++; }
            if (green >= 2) dir = 'LONG'; else if (red >= 2) dir = 'SHORT';
            if (!dir) continue;
            // 15M setup
            const s15 = getStruct(k15, SWING['15m']);
            if ((dir==='LONG'&&!s15.hasHL)||(dir==='SHORT'&&!s15.hasLH)) continue;
            // 1M entry
            if (k1.length < 15) continue;
            const s1 = getStruct(k1, SWING['1m']);
            if ((dir==='LONG'&&!s1.hasHL)||(dir==='SHORT'&&!s1.hasLH)) continue;
            const es = dir==='LONG'?s1.lastLow:s1.lastHigh;
            if (!es||(k1.length-1-es.index)>ENTRY_FRESH) continue;
          }

          // ══════════════════════════════════════════════════════
          // STRATEGY: relaxedHTF
          // Daily → (4H OR 1H) → KeyLevel → 15M → 1M
          // ══════════════════════════════════════════════════════
          else if (STRATEGY === 'relaxedHTF') {
            if (!prevDay) continue;
            const dOpen = parseFloat(prevDay[1]), dClose = parseFloat(prevDay[4]);
            const dHigh = parseFloat(prevDay[2]), dLow = parseFloat(prevDay[3]);
            if ((dHigh-dLow) > 0 && (Math.abs(dClose-dOpen)/(dHigh-dLow)) < DAILY_BODY_RATIO) continue;
            const bias = dClose > dOpen ? 'bullish' : 'bearish';
            if (k4h.length < 30 || k1h.length < 30) continue;
            const s4h = getStruct(k4h, SWING['4h']), s1h = getStruct(k1h, SWING['1h']);
            // Only need ONE of 4H/1H aligned (not both)
            const bull4h = s4h.trend==='bullish'||s4h.trend==='bullish_lean';
            const bull1h = s1h.trend==='bullish'||s1h.trend==='bullish_lean';
            const bear4h = s4h.trend==='bearish'||s4h.trend==='bearish_lean';
            const bear1h = s1h.trend==='bearish'||s1h.trend==='bearish_lean';
            if (bias==='bullish'&&(bull4h||bull1h)) dir='LONG';
            else if (bias==='bearish'&&(bear4h||bear1h)) dir='SHORT';
            if (!dir) continue;
            const vwap = calcVWAP(k15);
            if (!atKeyLevel(price, dHigh, dLow, vwap, dir)) continue;
            const s15 = getStruct(k15, SWING['15m']);
            if ((dir==='LONG'&&!s15.hasHL)||(dir==='SHORT'&&!s15.hasLH)) continue;
            if (k1.length < 15) continue;
            const s1 = getStruct(k1, SWING['1m']);
            if ((dir==='LONG'&&!s1.hasHL)||(dir==='SHORT'&&!s1.hasLH)) continue;
            const es = dir==='LONG'?s1.lastLow:s1.lastHigh;
            if (!es||(k1.length-1-es.index)>ENTRY_FRESH) continue;
          }

          // ══════════════════════════════════════════════════════
          // STRATEGY: volumeSpike
          // Full + volume must be 1.5x above 20-bar average
          // ══════════════════════════════════════════════════════
          else if (STRATEGY === 'volumeSpike') {
            if (!prevDay) continue;
            const dOpen = parseFloat(prevDay[1]), dClose = parseFloat(prevDay[4]);
            const dHigh = parseFloat(prevDay[2]), dLow = parseFloat(prevDay[3]);
            if ((dHigh-dLow) > 0 && (Math.abs(dClose-dOpen)/(dHigh-dLow)) < DAILY_BODY_RATIO) continue;
            const bias = dClose > dOpen ? 'bullish' : 'bearish';
            if (k4h.length < 30 || k1h.length < 30) continue;
            const s4h = getStruct(k4h, SWING['4h']), s1h = getStruct(k1h, SWING['1h']);
            const bullHTF = (s4h.trend==='bullish'||s4h.trend==='bullish_lean')&&(s1h.trend==='bullish'||s1h.trend==='bullish_lean');
            const bearHTF = (s4h.trend==='bearish'||s4h.trend==='bearish_lean')&&(s1h.trend==='bearish'||s1h.trend==='bearish_lean');
            if (bias==='bullish'&&bullHTF) dir='LONG'; else if (bias==='bearish'&&bearHTF) dir='SHORT';
            if (!dir) continue;
            const vwap = calcVWAP(k15);
            if (!atKeyLevel(price, dHigh, dLow, vwap, dir)) continue;
            const s15 = getStruct(k15, SWING['15m']);
            if ((dir==='LONG'&&!s15.hasHL)||(dir==='SHORT'&&!s15.hasLH)) continue;
            // Volume spike filter: recent 5-bar volume > 1.5x 20-bar average
            const vols = k15.slice(-20).map(k => parseFloat(k[5]));
            const avgVol = vols.reduce((a,b)=>a+b,0)/vols.length;
            const recentVol = vols.slice(-5).reduce((a,b)=>a+b,0)/5;
            if (avgVol > 0 && recentVol/avgVol < 1.5) continue;
            if (k1.length < 15) continue;
            const s1 = getStruct(k1, SWING['1m']);
            if ((dir==='LONG'&&!s1.hasHL)||(dir==='SHORT'&&!s1.hasLH)) continue;
            const es = dir==='LONG'?s1.lastLow:s1.lastHigh;
            if (!es||(k1.length-1-es.index)>ENTRY_FRESH) continue;
          }

          else { continue; } // unknown strategy

          if (REVERSE) dir = dir === 'LONG' ? 'SHORT' : 'LONG';

          // ── Shared indicator filters (apply to every strategy) ────────────
          const closes15 = k15.slice(-Math.max(RSI_PERIOD + 20, EMA_TREND + 5, 55)).map(k => parseFloat(k[4]));

          // RSI filter — reject overbought LONGs and oversold SHORTs
          if (RSI_PERIOD > 0) {
            const rsi = calcRSI(closes15, RSI_PERIOD);
            if (rsi !== null) {
              if (dir === 'LONG'  && rsi > RSI_OB) continue;
              if (dir === 'SHORT' && rsi < RSI_OS) continue;
            }
          }

          // EMA filter — fast must be above slow for LONG (momentum alignment)
          if (EMA_FAST > 0) {
            const emaFast = calcEMA(closes15, EMA_FAST);
            const emaSlow = calcEMA(closes15, EMA_SLOW);
            if (emaFast !== null && emaSlow !== null) {
              if (dir === 'LONG'  && emaFast < emaSlow) continue;
              if (dir === 'SHORT' && emaFast > emaSlow) continue;
            }
            // Trend EMA — price must be on correct side of trend line
            if (EMA_TREND > 0) {
              const emaTrend = calcEMA(closes15, EMA_TREND);
              if (emaTrend !== null) {
                if (dir === 'LONG'  && price < emaTrend) continue;
                if (dir === 'SHORT' && price > emaTrend) continue;
              }
            }
          }

          // Volume filter — last 15m candle must be VOL_MULT × 20-bar average
          if (VOL_MULT > 0 && k15.length >= 21) {
            const vols = k15.slice(-21).map(k => parseFloat(k[5]));
            const avgVol = vols.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
            if (avgVol > 0 && vols[20] / avgVol < VOL_MULT) continue;
          }

          // Direction enable/disable check
          if (dir === 'LONG'  && !ENABLE_LONG)  continue;
          if (dir === 'SHORT' && !ENABLE_SHORT) continue;

          // Step 6: Risk — per-direction SL/TP/Trail override, then fall back to global
          const isLong    = dir === 'LONG';
          const leverage  = leverageMap[sym] || MAX_LEVERAGE;
          const dirSlPct  = isLong ? SL_LONG   : SL_SHORT;
          const dirTpPct  = isLong ? TP_LONG   : TP_SHORT;
          const dirTrail  = isLong ? TRAIL_LONG : TRAIL_SHORT;

          const sl = isLong ? price * (1 - dirSlPct) : price * (1 + dirSlPct);
          const tp = dirTpPct > 0
            ? (isLong ? price * (1 + dirTpPct) : price * (1 - dirTpPct))
            : null;

          const tradeUsdt = wallet * RISK_PCT;
          const qty = (tradeUsdt * leverage) / price;
          const trade = { symbol: sym, dir, entry: price, qty, sl, tp, trailStep: dirTrail,
            lastStep: 0, entryTime: now, exit: null, reason: null, pnl: null, exitTime: null };
          openPos.push(trade);
          trades.push(trade);
        }
      }

      // Close remaining positions at last price
      for (const pos of openPos) {
        const data = coinData[pos.symbol];
        if (data && data.k15.length) {
          const lp = parseFloat(data.k15[data.k15.length-1][4]);
          pos.exit = lp; pos.reason = 'END'; pos.exitTime = endTime;
          pos.pnl = pos.dir === 'LONG' ? (lp - pos.entry) * pos.qty : (pos.entry - lp) * pos.qty;
          wallet += pos.pnl;
        }
      }
      return { trades, wallet };
    }

    function summarize(label, result) {
      const closed = result.trades.filter(t => t.pnl !== null);
      const wins = closed.filter(t => t.pnl > 0);
      const losses = closed.filter(t => t.pnl <= 0);
      const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
      const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
      const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
      let peak = WALLET_START, maxDD = 0, running = WALLET_START;
      for (const t of closed) { running += t.pnl; if (running > peak) peak = running; const dd = (peak - running) / peak; if (dd > maxDD) maxDD = dd; }
      return {
        label, startWallet: WALLET_START, finalWallet: parseFloat(result.wallet.toFixed(2)),
        totalPnl: parseFloat(totalPnl.toFixed(2)), totalPnlPct: parseFloat(((totalPnl / WALLET_START) * 100).toFixed(1)),
        totalTrades: closed.length, wins: wins.length, losses: losses.length,
        winRate: closed.length ? parseFloat(((wins.length / closed.length) * 100).toFixed(1)) : 0,
        avgWin: parseFloat(avgWin.toFixed(2)), avgLoss: parseFloat(avgLoss.toFixed(2)),
        maxDrawdown: parseFloat((maxDD * 100).toFixed(1)),
        trades: closed.map(t => ({
          date: new Date(t.entryTime).toISOString().slice(0, 16), symbol: t.symbol, dir: t.dir,
          entry: t.entry.toFixed(4), exit: t.exit.toFixed(4), pnl: t.pnl.toFixed(2), reason: t.reason,
        })),
      };
    }

    const STRATEGY_NAMES = {
      full: 'Daily→4H+1H→KeyLvl→15M→1M',
      noKeyLevel: 'Daily→4H+1H→15M→1M (no key level)',
      noHTF: 'Daily→15M→1M (skip 4H+1H)',
      momentum: '15M 3-candle→15M setup→1M entry',
      relaxedHTF: 'Daily→(4H OR 1H)→KeyLvl→15M→1M',
      volumeSpike: 'Full + Volume Spike 1.5x filter',
    };
    const label = (REVERSE ? 'REVERSE — ' : '') + (STRATEGY_NAMES[STRATEGY] || STRATEGY) + ' | ';
    const result = simulate();

    const firstData = coinData[topCoins[0]];
    const settingsLabel = `SL:${(SL_PCT*100).toFixed(1)}%` +
      (TP_PCT > 0 ? ` TP:${(TP_PCT*100).toFixed(1)}%` : ' no-TP') +
      ` Trail:${(TRAIL_FIRST*100).toFixed(1)}% Lev:${MAX_LEVERAGE}x` +
      ` Risk:${(RISK_PCT*100)}% MaxPos:${MAX_POS}` +
      (MAX_CONSEC_LOSS > 0 ? ` StopAfter:${MAX_CONSEC_LOSS}L` : ' noStop');
    res.json({
      period: `${new Date(startTime).toISOString().slice(0,10)} → ${new Date(endTime).toISOString().slice(0,10)}`,
      days: DAYS,
      strategy: STRATEGY,
      strategyName: STRATEGY_NAMES[STRATEGY] || STRATEGY,
      reverse: REVERSE,
      coinsScanned: Object.keys(coinData).length,
      settings: {
        // Risk & position management
        slPct: SL_PCT, tpPct: TP_PCT, trailStep: TRAIL_FIRST, leverage: MAX_LEVERAGE,
        riskPct: RISK_PCT, maxPositions: MAX_POS, maxConsecLoss: MAX_CONSEC_LOSS, wallet: WALLET_START, topN: TOP_N,
        // Structure analysis
        swing4h: SWING['4h'], swing1h: SWING['1h'], swing15m: SWING['15m'], swing1m: SWING['1m'],
        proximity: PROXIMITY, entryFresh: ENTRY_FRESH, dailyBodyRatio: DAILY_BODY_RATIO,
        // Indicator filters
        rsiPeriod: RSI_PERIOD, rsiOb: RSI_OB, rsiOs: RSI_OS,
        emaFast: EMA_FAST, emaSlow: EMA_SLOW, emaTrend: EMA_TREND,
        volMult: VOL_MULT,
        // Direction settings
        enableLong: ENABLE_LONG, enableShort: ENABLE_SHORT,
        slPctLong: SL_LONG, slPctShort: SL_SHORT,
        tpPctLong: TP_LONG, tpPctShort: TP_SHORT,
        trailStepLong: TRAIL_LONG, trailStepShort: TRAIL_SHORT,
        strategy: STRATEGY,
      },
      dataPoints: {
        k4h: firstData?.k4h?.length || 0, k1h: firstData?.k1h?.length || 0,
        k15m: firstData?.k15?.length || 0, k1m: firstData?.k1?.length || 0,
      },
      strategy: summarize(label + `Daily→4H+1H→KeyLvl→15M→1M (${settingsLabel})`, result),
    });
  } catch (err) {
    console.error('Backtest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Optimize: streaming NDJSON with candle cache ────
// Quantum AI Optimizer — uses bitmask combo system (15 strategy combinations)
router.post('/ai-optimize', async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function sendLog(msg) { try { res.write(JSON.stringify({ type: 'log', message: msg }) + '\n'); } catch {} }
  function sendProgress(phase, pct) { try { res.write(JSON.stringify({ type: 'progress', phase, pct }) + '\n'); } catch {} }

  const keepalive = setInterval(() => {
    try { res.write(JSON.stringify({ type: 'ping' }) + '\n'); } catch {}
  }, 2000);
  res.on('close', () => clearInterval(keepalive));

  try {
    const fetch = require('node-fetch');
    const quantumOptimizer = require('../quantum-optimizer');
    const engine = require('../liquidity-sweep-engine');
    const DAYS = Math.min(parseInt(req.body.days) || 7, 365);
    const endTime = Date.now();
    const startTime = endTime - DAYS * 86400000;
    const SIM_WALLET = 1000;
    const RISK_PCT = 0.10;
    const LEVERAGE = 20;
    const MIN_SCORE = 8;

    sendLog(`⚛️ Quantum AI Backtester — ${DAYS} day${DAYS > 1 ? 's' : ''}`);
    sendLog(`Simulated wallet: $${SIM_WALLET} | Risk: ${RISK_PCT * 100}% | Leverage: ${LEVERAGE}x`);
    sendProgress('init', 5);

    await quantumOptimizer.initCombos();

    // Get admin tokens
    const tokenRows = await query('SELECT symbol FROM token_leverage WHERE enabled = true');
    let tokens = tokenRows.map(r => r.symbol);
    if (!tokens.length) {
      // Fallback: top 20 by volume
      const tickerRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000 });
      const tickers = await tickerRes.json();
      tokens = tickers
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 20)
        .map(t => t.symbol);
    }
    sendLog(`Tokens: ${tokens.length} (${tokens.slice(0, 5).join(', ')}${tokens.length > 5 ? '...' : ''})`);

    // Fetch klines for all tokens
    async function fetchK(symbol, interval, limit, et = endTime) {
      const PAGE = 1500;
      let all = [];
      let curEnd = et;
      let remaining = limit;
      while (remaining > 0) {
        const batch = Math.min(remaining, PAGE);
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${batch}&endTime=${curEnd}`;
        try {
          const r = await fetch(url, { timeout: 15000 });
          if (!r.ok) break;
          const data = await r.json();
          if (!data.length) break;
          all = data.concat(all);
          curEnd = parseInt(data[0][0]) - 1;
          remaining -= data.length;
          if (data.length < batch) break;
        } catch { break; }
      }
      return all;
    }

    sendLog('Fetching historical data...');
    const klineCache = {};
    let fetchDone = 0;
    const k1mLimit = Math.min(DAYS * 1440, 10000);
    const k15mLimit = Math.min(DAYS * 96, 5000);
    const k1hLimit = Math.min(DAYS * 24, 2000);

    for (const sym of tokens) {
      try {
        const [k1h, k15m, k1m] = await Promise.all([
          fetchK(sym, '1h', k1hLimit),
          fetchK(sym, '15m', k15mLimit),
          fetchK(sym, '1m', k1mLimit),
        ]);
        if (k15m.length >= 30 && k1m.length >= 50) {
          klineCache[sym] = { k1h, k15m, k1m };
          sendLog(`  ✅ ${sym} (1h:${k1h.length} 15m:${k15m.length} 1m:${k1m.length})`);
        } else {
          sendLog(`  ❌ ${sym} — insufficient data`);
        }
      } catch (e) {
        sendLog(`  ❌ ${sym} — ${e.message}`);
      }
      fetchDone++;
      sendProgress('fetch', Math.round(fetchDone / tokens.length * 40) + 10);
      await new Promise(r => setTimeout(r, 200));
    }

    const validTokens = Object.keys(klineCache);
    sendLog(`Data ready: ${validTokens.length} tokens`);
    if (!validTokens.length) throw new Error('No valid token data fetched');

    // Pre-index 1m candles by 15m bucket for fast lookup
    sendLog('Indexing 1m candles...');
    const m1Index = {}; // sym → Map<15m_close_time, [1m candles]>
    for (const sym of validTokens) {
      const { k15m, k1m } = klineCache[sym];
      const idx = new Map();
      let m1ptr = 0;
      for (let i = 0; i < k15m.length; i++) {
        const prevEnd = i > 0 ? parseInt(k15m[i - 1][6]) : 0;
        const curEnd = parseInt(k15m[i][6]);
        const bucket = [];
        while (m1ptr < k1m.length && parseInt(k1m[m1ptr][0]) <= curEnd) {
          if (parseInt(k1m[m1ptr][0]) > prevEnd) bucket.push(k1m[m1ptr]);
          m1ptr++;
        }
        idx.set(i, bucket);
      }
      m1Index[sym] = idx;
    }

    // Pre-index 1h candles by time
    const h1Index = {};
    for (const sym of validTokens) {
      const { k1h } = klineCache[sym];
      h1Index[sym] = k1h.map(k => parseInt(k[6])); // close times
    }

    // Parameter grid — key tunables per strategy
    const PARAM_GRID = {
      rrRatio: [1.5, 2.0, 2.5, 3.0],
      hunt: { minTouches: [2, 3, 4], proximityPct: [0.005, 0.01, 0.015] },
      momentum: { trendStrength: [6, 7, 8], pinBarWickRatio: [1.5, 2.0, 2.5] },
      brr: { breakoutBodyRatio: [0.5, 0.7, 0.9], retestBodyRatio: [0.5, 0.7, 0.9] },
    };

    // Build param variants for grid search (keep it manageable ~48 configs)
    const paramVariants = [];
    for (const rr of PARAM_GRID.rrRatio) {
      // Default params
      paramVariants.push({ rr, hunt: {}, momentum: {}, brr: {}, label: `RR${rr}` });
      // HUNT variants
      for (const mt of PARAM_GRID.hunt.minTouches) {
        for (const pp of PARAM_GRID.hunt.proximityPct) {
          if (mt === 2 && pp === 0.01 && rr !== 2.0) continue; // skip defaults except with RR2
          paramVariants.push({ rr, hunt: { minTouches: mt, proximityPct: pp }, momentum: {}, brr: {}, label: `RR${rr}_HT${mt}_HP${pp}` });
        }
      }
      // MOMENTUM variants
      for (const ts of PARAM_GRID.momentum.trendStrength) {
        if (ts === 7 && rr !== 2.0) continue; // skip default
        paramVariants.push({ rr, hunt: {}, momentum: { trendStrength: ts }, brr: {}, label: `RR${rr}_MT${ts}` });
      }
      // BRR variants (fewer since BRR performs worst)
      if (rr === 2.0 || rr === 2.5) {
        for (const bb of PARAM_GRID.brr.breakoutBodyRatio) {
          paramVariants.push({ rr, hunt: {}, momentum: {}, brr: { breakoutBodyRatio: bb }, label: `RR${rr}_BB${bb}` });
        }
      }
    }
    const TOTAL = quantumOptimizer.STRATEGIES ? Object.keys(quantumOptimizer.STRATEGIES).length : 5;
    const TOTAL_COMBOS = (1 << TOTAL) - 1; // 31 for 5 strategies
    sendLog(`Parameter grid: ${paramVariants.length} configs × ${TOTAL_COMBOS} combos = ${paramVariants.length * TOTAL_COMBOS} tests`);

    // Backtest function — runs one combo with one param config
    const yield_ = () => new Promise(r => setImmediate(r));
    function runBacktest(comboId, params) {
      const enabled = quantumOptimizer.getEnabledStrategies(comboId);
      let trades = 0, wins = 0, losses = 0, totalPnl = 0;

      for (const sym of validTokens) {
        const { k1h, k15m } = klineCache[sym];
        const symM1 = m1Index[sym];
        const symH1Times = h1Index[sym];
        let position = null;

        for (let i = 100; i < k15m.length - 1; i++) {
          if (position) {
            const m1Bucket = symM1.get(i) || [];
            let closed = false;
            for (const c of m1Bucket) {
              const high = parseFloat(c[2]);
              const low = parseFloat(c[3]);
              if (position.direction === 'LONG') {
                if (low <= position.sl) { totalPnl += (position.sl - position.entry) / position.entry * 100; losses++; trades++; closed = true; break; }
                if (high >= position.tp1) { totalPnl += (position.tp1 - position.entry) / position.entry * 100; wins++; trades++; closed = true; break; }
              } else {
                if (high >= position.sl) { totalPnl += (position.entry - position.sl) / position.entry * 100; losses++; trades++; closed = true; break; }
                if (low <= position.tp1) { totalPnl += (position.entry - position.tp1) / position.entry * 100; wins++; trades++; closed = true; break; }
              }
            }
            if (closed) position = null;
          }

          if (!position && i % 4 === 0) {
            const w15m = k15m.slice(Math.max(0, i - 99), i + 1);
            const w1m = [];
            for (let b = Math.max(0, i - 3); b <= i; b++) { const bucket = symM1.get(b) || []; w1m.push(...bucket); }
            const w1mSlice = w1m.slice(-50);
            if (w15m.length < 30 || w1mSlice.length < 10) continue;

            const stepTime = parseInt(k15m[i][6]);
            let h1End = 0;
            for (let h = symH1Times.length - 1; h >= 0; h--) { if (symH1Times[h] <= stepTime) { h1End = h + 1; break; } }
            const w1h = k1h.slice(Math.max(0, h1End - 60), h1End);

            let signal = null;
            try {
              if (enabled.LIQUIDITY_SWEEP) { const s = engine.detectLiquiditySweep(w15m, w1mSlice); if (s) signal = s; }
              if (enabled.STOP_LOSS_HUNT) { const s = engine.detectStopLossHunt(w15m, w1mSlice, params.hunt); if (s && (!signal || s.touches > 2)) signal = s; }
              if (enabled.MOMENTUM_SCALP) { const s = engine.detectMomentumScalp(w15m, w1mSlice, params.momentum); if (s && !signal) signal = s; }
              if (enabled.BRR_FIBO && w1h.length >= 30) { const s = engine.detectBRR(w1h, w15m, w1mSlice, params.brr); if (s && (!signal || s.score > 14)) signal = s; }
              // SMC Classic: strong S/R zone + 1m reversal candle pattern
              if (enabled.SMC_CLASSIC && w1h.length >= 20) {
                const pc = k => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) });
                const levels = engine.findKeyLevels(w15m.map(pc), 50);
                const lp = parseFloat(w15m[w15m.length - 1][4]);
                const near = levels.find(l => Math.abs(l.price - lp) / lp < 0.003 && l.strength >= 3);
                if (near && w1mSlice.length >= 2) {
                  const c1 = parseFloat(w1mSlice[w1mSlice.length - 1][4]), o1 = parseFloat(w1mSlice[w1mSlice.length - 1][1]);
                  const c2 = parseFloat(w1mSlice[w1mSlice.length - 2][4]), o2 = parseFloat(w1mSlice[w1mSlice.length - 2][1]);
                  if (near.type === 'support' && c1 > o1 && c2 < o2 && !signal) {
                    signal = { direction: 'LONG', setup: 'SMC_CLASSIC', entryPrice: c1, sl: near.zoneLow || near.price * 0.997 };
                  }
                  if (near.type === 'resistance' && c1 < o1 && c2 > o2 && !signal) {
                    signal = { direction: 'SHORT', setup: 'SMC_CLASSIC', entryPrice: c1, sl: near.zoneHigh || near.price * 1.003 };
                  }
                }
              }
            } catch {}

            if (signal) {
              const slDist = Math.abs(signal.entryPrice - signal.sl) / signal.entryPrice;
              if (slDist > 0.001 && slDist < 0.05) {
                const tpDist = slDist * params.rr;
                position = {
                  entry: signal.entryPrice, sl: signal.sl, direction: signal.direction,
                  tp1: signal.direction === 'LONG' ? signal.entryPrice * (1 + tpDist) : signal.entryPrice * (1 - tpDist),
                };
              }
            }
          }
        }
        if (position) {
          const lastClose = parseFloat(k15m[k15m.length - 1][4]);
          const pnl = position.direction === 'LONG' ? (lastClose - position.entry) / position.entry * 100 : (position.entry - lastClose) / position.entry * 100;
          totalPnl += pnl; if (pnl > 0) wins++; else losses++; trades++;
        }
      }
      return { trades, wins, losses, totalPnl };
    }

    // Run grid search
    sendLog('');
    sendLog(`=== GRID SEARCH: ${TOTAL_COMBOS} COMBOS × PARAM VARIANTS ===`);
    const comboResults = [];
    let testsRun = 0;
    const totalTests = TOTAL_COMBOS * paramVariants.length;

    for (let comboId = 1; comboId <= TOTAL_COMBOS; comboId++) {
      const name = quantumOptimizer.comboToName(comboId);
      let bestResult = null;
      let bestParams = null;
      let bestPnl = -Infinity;

      for (const pv of paramVariants) {
        const result = runBacktest(comboId, pv);
        testsRun++;
        if (result.totalPnl > bestPnl || (result.totalPnl === bestPnl && result.trades > (bestResult?.trades || 0))) {
          bestPnl = result.totalPnl;
          bestResult = result;
          bestParams = pv;
        }
        if (testsRun % 20 === 0) {
          sendProgress('backtest', Math.round(50 + (testsRun / totalTests) * 40));
          await yield_();
        }
      }

      const wr = bestResult.trades > 0 ? (bestResult.wins / bestResult.trades * 100).toFixed(0) : '0';
      const avgPnl = bestResult.trades > 0 ? (bestResult.totalPnl / bestResult.trades).toFixed(2) : '0.00';
      const pnlSign = bestResult.totalPnl >= 0 ? '+' : '';
      sendLog(`  #${String(comboId).padEnd(3)} ${name.padEnd(28)} ${String(bestResult.trades).padStart(4)} trades | ${wr}% WR | ${pnlSign}${bestResult.totalPnl.toFixed(2)}% | best: RR=${bestParams.rr} ${bestParams.label}`);

      comboResults.push({
        comboId, trades: bestResult.trades, wins: bestResult.wins,
        losses: bestResult.losses, totalPnl: bestResult.totalPnl,
        bestParams: { rr: bestParams.rr, hunt: bestParams.hunt, momentum: bestParams.momentum, brr: bestParams.brr },
      });
      await yield_();
    }

    // Seed results into DB
    sendLog('');
    sendLog('Saving results to database...');
    const bestCombo = await quantumOptimizer.resetAndSeedFromBacktest(comboResults);
    sendProgress('save', 95);

    const bestResult = comboResults.find(c => c.comboId === bestCombo) || {};
    const bestName = quantumOptimizer.comboToName(bestCombo);
    const bestStrats = quantumOptimizer.getEnabledStrategies(bestCombo);
    const enabledList = Object.entries(bestStrats).filter(([, v]) => v).map(([k]) => k).join(', ');

    sendLog(`\n✅ Best combo: #${bestCombo} (${bestName})`);
    sendLog(`   Strategies: ${enabledList}`);
    sendLog(`   ${bestResult.trades || 0} trades | ${bestResult.wins || 0}W/${bestResult.losses || 0}L | ${(bestResult.totalPnl || 0).toFixed(2)}% total PnL`);
    sendProgress('done', 100);

    // Send final result
    res.write(JSON.stringify({
      type: 'result',
      days: DAYS,
      tokens: validTokens.length,
      activeCombo: bestCombo,
      comboName: bestName,
      strategies: bestStrats,
      phase: 'backtest_complete',
      exploration: { explored: 15, total: 15, min_trades: 0 },
      allCombos: comboResults
        .map(c => ({
          id: c.comboId, name: quantumOptimizer.comboToName(c.comboId),
          trades: c.trades, winRate: c.trades > 0 ? c.wins / c.trades : 0,
          avgPnl: c.trades > 0 ? c.totalPnl / c.trades : 0,
          score: c.trades > 0 ? (c.wins / c.trades * 0.4 + Math.max(0, Math.min(1, (c.totalPnl / c.trades + 5) / 10)) * 0.6) : 0,
          active: c.comboId === bestCombo, locked: false,
        }))
        .sort((a, b) => b.score - a.score),
    }) + '\n');

    clearInterval(keepalive);
    res.end();
  } catch (err) {
    console.error('AI optimize error:', err);
    clearInterval(keepalive);
    try {
      res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
      res.end();
    } catch {}
  }
});

// Fix corrupted trades — recalculate PnL from exchange fills per user
router.post('/fix-trades', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { USDMClient } = require('binance');
    const { BitunixClient } = require('../bitunix-client');
    let getBinanceRequestOptions;
    try { getBinanceRequestOptions = require('../proxy-agent').getBinanceRequestOptions; } catch { getBinanceRequestOptions = () => ({}); }

    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const trades = await query(
      `SELECT t.id, t.user_id, t.api_key_id, t.symbol, t.direction,
              t.entry_price, t.exit_price, t.pnl_usdt, t.quantity,
              t.status, t.created_at, t.closed_at,
              u.email,
              ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform
       FROM trades t
       JOIN users u ON u.id = t.user_id
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE t.status IN ('WIN', 'LOSS', 'TP', 'SL', 'CLOSED')
         AND t.closed_at >= $1
       ORDER BY t.api_key_id, t.symbol, t.closed_at`,
      [twoWeeksAgo]
    );

    const results = [];
    let fixed = 0;

    // Group by api_key_id to avoid redundant decrypts + batch per-symbol fetches
    const byKey = {};
    for (const t of trades) {
      const k = t.api_key_id;
      if (!byKey[k]) byKey[k] = { key: t, trades: [] };
      byKey[k].trades.push(t);
    }

    for (const { key: keyRow, trades: keyTrades } of Object.values(byKey)) {
      let apiKey, apiSecret;
      try {
        apiKey = cryptoUtils.decrypt(keyRow.api_key_enc, keyRow.iv, keyRow.auth_tag);
        apiSecret = cryptoUtils.decrypt(keyRow.api_secret_enc, keyRow.secret_iv, keyRow.secret_auth_tag);
      } catch (e) {
        for (const t of keyTrades) results.push({ id: t.id, symbol: t.symbol, error: 'decrypt failed' });
        continue;
      }

      // For Bitunix: fetch position history once per symbol, match all trades locally
      // This is O(symbols) API calls instead of O(trades)
      const posCache = {}; // symbol → position array

      for (const t of keyTrades) {
        const entry = parseFloat(t.entry_price);
        const dbPnl = parseFloat(t.pnl_usdt);
        const qty = parseFloat(t.quantity || 0);
        const isLong = t.direction !== 'SHORT';
        let actualExit = null;
        let actualPnl = null;
        let actualExchangeFee = 0;
        let actualFundingFee = 0;

        if (qty <= 0) continue;

        try {
          if (t.platform === 'binance') {
            const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
            const openTime = new Date(t.created_at).getTime();
            const fills = await client.getAccountTrades({ symbol: t.symbol, startTime: openTime, limit: 50 });
            if (fills && fills.length > 0) {
              const closeSide = isLong ? 'SELL' : 'BUY';
              const closeFills = fills.filter(f => f.side === closeSide);
              if (closeFills.length > 0) {
                let totalQty = 0, totalValue = 0, totalRealizedPnl = 0;
                for (const f of closeFills) {
                  const fQty = parseFloat(f.qty);
                  totalQty += fQty;
                  totalValue += fQty * parseFloat(f.price);
                  totalRealizedPnl += parseFloat(f.realizedPnl || 0);
                }
                if (totalQty > 0) actualExit = totalValue / totalQty;
                if (totalRealizedPnl !== 0) actualPnl = totalRealizedPnl;
              }
            }
          } else if (t.platform === 'bitunix') {
            // Fetch per-symbol position history once and cache
            if (!posCache[t.symbol]) {
              const bxClient = new BitunixClient({ apiKey, apiSecret });
              try {
                posCache[t.symbol] = await bxClient.getHistoryPositions({ symbol: t.symbol, pageSize: 100 });
              } catch { posCache[t.symbol] = []; }
            }

            for (const p of posCache[t.symbol]) {
              const cp = parseFloat(p.closePrice || p.avgClosePrice || 0);
              const ep = parseFloat(p.entryPrice || p.avgOpenPrice || 0);
              // Bitunix returns side as "BUY"/"SELL", not "LONG"/"SHORT"
              const pSide = (p.side || '').toUpperCase();
              const pSideLong = pSide === 'BUY' || pSide === 'LONG';
              const entryMatch = ep > 0 && Math.abs(ep - entry) / entry < 0.002;
              const sideMatch = pSideLong === isLong;
              const tradeMs = t.created_at ? new Date(t.created_at).getTime() : 0;
              const closeMs = parseInt(p.mtime || p.ctime || 0);
              const timeMatch = !tradeMs || !closeMs || closeMs > tradeMs;

              if (cp > 0 && p.symbol === t.symbol && entryMatch && sideMatch && timeMatch) {
                actualExit = cp;
                // realizedPNL is already net of fee + funding on Bitunix
                const rpnl = parseFloat(p.realizedPNL || 0);
                if (rpnl !== 0) actualPnl = rpnl;
                actualExchangeFee = Math.abs(parseFloat(p.fee || 0));
                actualFundingFee  = Math.abs(parseFloat(p.funding || 0));
                break;
              }
            }
          }
        } catch (e) {
          results.push({ id: t.id, email: t.email, symbol: t.symbol, error: e.message });
          continue;
        }

        // Calculate correct PnL
        let correctPnl;
        if (actualPnl !== null) {
          correctPnl = parseFloat(actualPnl.toFixed(4));
        } else if (actualExit !== null) {
          correctPnl = isLong
            ? parseFloat(((actualExit - entry) * qty).toFixed(4))
            : parseFloat(((entry - actualExit) * qty).toFixed(4));
        } else {
          continue;
        }

        const correctStatus = correctPnl > 0 ? 'WIN' : 'LOSS';
        const correctExit = actualExit || parseFloat(t.exit_price);
        const correctGross = parseFloat((correctPnl + actualExchangeFee + actualFundingFee).toFixed(4));
        const isWrong = Math.abs(correctPnl - dbPnl) > 0.01 || correctStatus !== t.status;

        if (isWrong) {
          await query(
            `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3,
             trading_fee = $5, funding_fee = $6, gross_pnl = $7
             WHERE id = $4`,
            [correctStatus, correctPnl, correctExit, t.id, actualExchangeFee, actualFundingFee, correctGross]
          );
          results.push({
            id: t.id, email: t.email, symbol: t.symbol, direction: t.direction,
            old_status: t.status, old_pnl: dbPnl,
            new_status: correctStatus, new_pnl: correctPnl,
            fixed: true,
          });
          fixed++;
        }
      }
    }

    res.json({ total_checked: trades.length, fixed, details: results });
  } catch (err) {
    console.error('Fix trades error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Backfill trading_fee + funding_fee + gross_pnl for all closed Bitunix trades
router.post('/resync-fees', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');

    const trades = await query(
      `SELECT t.id, t.symbol, t.direction, t.entry_price, t.quantity, t.pnl_usdt,
              t.created_at,
              ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.id AS api_key_id
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE ak.platform = 'bitunix'
         AND t.status IN ('WIN','LOSS','TP','SL','CLOSED')
       ORDER BY t.api_key_id, t.symbol, t.created_at DESC`
    );

    let updated = 0;
    const byKey = {};
    for (const t of trades) {
      if (!byKey[t.api_key_id]) byKey[t.api_key_id] = { keyRow: t, trades: [] };
      byKey[t.api_key_id].trades.push(t);
    }

    for (const { keyRow, trades: keyTrades } of Object.values(byKey)) {
      let apiKey, apiSecret;
      try {
        apiKey  = cryptoUtils.decrypt(keyRow.api_key_enc, keyRow.iv, keyRow.auth_tag);
        apiSecret = cryptoUtils.decrypt(keyRow.api_secret_enc, keyRow.secret_iv, keyRow.secret_auth_tag);
      } catch { continue; }

      const posCache = {};

      for (const t of keyTrades) {
        const entry = parseFloat(t.entry_price);
        const isLong = t.direction !== 'SHORT';
        const tradeMs = t.created_at ? new Date(t.created_at).getTime() : 0;

        if (!posCache[t.symbol]) {
          try {
            const client = new BitunixClient({ apiKey, apiSecret });
            posCache[t.symbol] = await client.getHistoryPositions({ symbol: t.symbol, pageSize: 100 });
          } catch { posCache[t.symbol] = []; }
        }

        for (const p of posCache[t.symbol]) {
          const ep = parseFloat(p.entryPrice || p.avgOpenPrice || 0);
          const pSide = (p.side || '').toUpperCase();
          const pSideLong = pSide === 'BUY' || pSide === 'LONG';
          const closeMs = parseInt(p.mtime || p.ctime || 0);
          const entryMatch = ep > 0 && Math.abs(ep - entry) / entry < 0.002;
          const sideMatch = pSideLong === isLong;
          const timeMatch = !tradeMs || !closeMs || closeMs > tradeMs;

          if (p.symbol === t.symbol && entryMatch && sideMatch && timeMatch) {
            const exchangeFee = Math.abs(parseFloat(p.fee || 0));
            const fundingFee  = Math.abs(parseFloat(p.funding || 0));
            const pnl = parseFloat(t.pnl_usdt) || 0;
            const grossPnl = parseFloat((pnl + exchangeFee + fundingFee).toFixed(4));

            await query(
              `UPDATE trades SET trading_fee = $1, funding_fee = $2, gross_pnl = $3 WHERE id = $4`,
              [exchangeFee, fundingFee, grossPnl, t.id]
            );
            updated++;
            break;
          }
        }
      }
    }

    res.json({ ok: true, total_checked: trades.length, updated });
  } catch (err) {
    console.error('Resync fees error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clear old test data from wallet_transactions and withdrawals
router.post('/clear-test-data', async (req, res) => {
  try {
    const txResult = await query('DELETE FROM wallet_transactions');
    const wdResult = await query('DELETE FROM withdrawals');
    res.json({
      ok: true,
      message: `Cleared ${txResult.rowCount || 0} transactions and ${wdResult.rowCount || 0} withdrawals`,
    });
  } catch (err) {
    console.error('Clear test data error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Mission Control: Agent Framework ────────────────────────

// ── Token Board Management ──────────────────────────────────

// GET /api/admin/token-board — all tokens with risk tags + leverage + live price
router.get('/token-board', async (req, res) => {
  try {
    const tokens = await query(
      `SELECT g.symbol, g.enabled, g.banned, g.risk_tag, g.featured, g."rank",
              COALESCE(tl.leverage, 20) as leverage
       FROM global_token_settings g
       LEFT JOIN token_leverage tl ON tl.symbol = g.symbol AND tl.enabled = true
       ORDER BY g."rank" ASC, g.symbol ASC`
    );

    // Get live signal status from token agents
    let signalMap = {};
    try {
      const { getCoordinator } = require('../agents');
      const coord = getCoordinator();
      for (const [sym, agent] of coord.tokenAgents || new Map()) {
        const h = agent.getHealth();
        signalMap[sym] = {
          direction: h.lastSignal?.direction || null,
          score: h.lastSignal?.score || 0,
          structure: h.structure || {},
          hasAgent: true,
        };
      }
    } catch {}

    // Fetch live prices + volume from Binance
    let priceMap = {};
    try {
      const fetch = require('node-fetch');
      const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
      const tickers = await r.json();
      for (const t of tickers) {
        priceMap[t.symbol] = {
          price: parseFloat(t.lastPrice),
          change24h: parseFloat(t.priceChangePercent),
          volume: parseFloat(t.quoteVolume),
        };
      }
    } catch {}

    const result = tokens.map(t => ({
      ...t,
      price: priceMap[t.symbol]?.price || 0,
      change24h: priceMap[t.symbol]?.change24h || 0,
      volume: priceMap[t.symbol]?.volume || 0,
      signal: signalMap[t.symbol]?.direction || null,
      signalScore: signalMap[t.symbol]?.score || 0,
      structure: signalMap[t.symbol]?.structure || null,
      hasAgent: signalMap[t.symbol]?.hasAgent || false,
    }));

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/token-board/:symbol/risk — set risk tag
router.put('/token-board/:symbol/risk', async (req, res) => {
  try {
    const { risk_tag } = req.body; // 'low', 'medium', 'high', 'popular', null
    await query(
      `INSERT INTO global_token_settings (symbol, enabled, banned, risk_tag)
       VALUES ($1, true, false, $2)
       ON CONFLICT (symbol) DO UPDATE SET risk_tag = $2`,
      [req.params.symbol.toUpperCase(), risk_tag || null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/token-board/:symbol/featured — toggle featured
router.put('/token-board/:symbol/featured', async (req, res) => {
  try {
    const { featured } = req.body;
    await query(
      `INSERT INTO global_token_settings (symbol, enabled, banned, featured)
       VALUES ($1, true, false, $2)
       ON CONFLICT (symbol) DO UPDATE SET featured = $2`,
      [req.params.symbol.toUpperCase(), !!featured]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/token-board/populate-top50 — auto-add top 10 by volume
router.post('/token-board/populate-top50', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000 });
    const tickers = await r.json();

    const BLACKLIST = new Set([
      'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
      'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
      'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
      'LEVERUSDT','AGLDUSDT','LOOKSUSDT','TRUUSDT',
      'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
    ]);

    const top10 = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => !BLACKLIST.has(t.symbol))
      .filter(t => parseFloat(t.quoteVolume) >= 10_000_000)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 10)
      .map((t, i) => ({ symbol: t.symbol, rank: i + 1 }));

    let added = 0;

    // Step 1: Ban ALL existing tokens first
    await query('UPDATE global_token_settings SET banned = true, enabled = false');

    // Step 2: Enable only top 10
    for (const t of top10) {
      await query(
        `INSERT INTO global_token_settings (symbol, enabled, banned, "rank")
         VALUES ($1, true, false, $2)
         ON CONFLICT (symbol) DO UPDATE SET enabled = true, banned = false, "rank" = $2`,
        [t.symbol, t.rank]
      );
      added++;
    }

    // Step 3: Delete banned tokens (clean up table — only keep top 10)
    await query('DELETE FROM global_token_settings WHERE banned = true');

    const afterCount = await query('SELECT COUNT(*) as c FROM global_token_settings');

    res.json({ ok: true, added, banned: 0, total: parseInt(afterCount[0].c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/token-board/add — add token to board
router.post('/token-board/add', async (req, res) => {
  try {
    const { symbol, risk_tag } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
    await query(
      `INSERT INTO global_token_settings (symbol, enabled, banned, risk_tag, featured)
       VALUES ($1, true, false, $2, false)
       ON CONFLICT (symbol) DO UPDATE SET enabled = true, banned = false, risk_tag = COALESCE($2, global_token_settings.risk_tag)`,
      [symbol.toUpperCase(), risk_tag || null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/token-board/:symbol — remove from board
router.delete('/token-board/:symbol', async (req, res) => {
  try {
    await query('DELETE FROM global_token_settings WHERE symbol = $1', [req.params.symbol.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/agents/health — Full agent health + activity
router.get('/agents/health', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const coordinator = getCoordinator();
    res.json({
      health: coordinator.getHealth(),
      activity: coordinator.getAllActivity(100),
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/agents/trade-history — All agent trade history (JSON)
router.get('/agents/trade-history', async (req, res) => {
  try {
    const { query } = require('../db');
    const agent = req.query.agent || null;
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);

    let sql = 'SELECT * FROM agent_trade_history';
    const params = [];
    if (agent) {
      sql += ' WHERE agent = $1';
      params.push(agent);
    }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const rows = await query(sql, params);
    res.json({ trades: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/agents/trade-history/csv — Download trade history as CSV (Excel-compatible)
router.get('/agents/trade-history/csv', async (req, res) => {
  try {
    const { query } = require('../db');
    const agent = req.query.agent || null;

    let sql = 'SELECT * FROM agent_trade_history';
    const params = [];
    if (agent) {
      sql += ' WHERE agent = $1';
      params.push(agent);
    }
    sql += ' ORDER BY created_at DESC LIMIT 10000';

    const rows = await query(sql, params);

    // Build CSV
    const headers = ['ID','Agent','Symbol','Direction','Entry Price','Exit Price','PnL (USDT)','Win','Strategy','Setup','Leverage','Capital After','Health After','Date'];
    const csvRows = [headers.join(',')];
    for (const r of rows) {
      csvRows.push([
        r.id,
        `"${r.agent}"`,
        r.symbol,
        r.direction,
        r.entry_price,
        r.exit_price,
        r.pnl_usdt,
        r.is_win ? 'WIN' : 'LOSS',
        `"${(r.strategy || '').replace(/"/g, '""')}"`,
        `"${(r.setup || '').replace(/"/g, '""')}"`,
        r.leverage,
        r.capital_after,
        r.health_after,
        r.created_at ? new Date(r.created_at).toISOString() : '',
      ].join(','));
    }

    const csv = csvRows.join('\n');
    const filename = agent ? `agent_trades_${agent}_${new Date().toISOString().slice(0,10)}.csv` : `all_agent_trades_${new Date().toISOString().slice(0,10)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/agents/revenue-summary — Revenue stats per agent
router.get('/agents/revenue-summary', async (req, res) => {
  try {
    const { query } = require('../db');
    const rows = await query(`
      SELECT agent,
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN NOT is_win THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(pnl_usdt)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl_usdt)::numeric, 2) as avg_pnl,
        ROUND(SUM(CASE WHEN is_win THEN pnl_usdt ELSE 0 END)::numeric, 2) as total_wins_pnl,
        ROUND(SUM(CASE WHEN NOT is_win THEN pnl_usdt ELSE 0 END)::numeric, 2) as total_losses_pnl,
        MAX(created_at) as last_trade_at
      FROM agent_trade_history
      GROUP BY agent
      ORDER BY total_pnl DESC
    `);
    res.json({ agents: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/agents/strategies — Strategy discovery population
router.get('/agents/strategies', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const coordinator = getCoordinator();
    const stratAgent = coordinator.strategyAgent;
    if (!stratAgent) return res.json({ population: [], hallOfFame: [] });
    res.json({
      population: stratAgent.getPopulation(),
      hallOfFame: stratAgent.getHallOfFame(),
      stats: {
        cycleCount: stratAgent._cycleCount,
        totalGenerated: stratAgent._totalGenerated,
        totalEvolved: stratAgent._totalEvolved,
        totalCulled: stratAgent._totalCulled,
        bestEverWinRate: stratAgent._bestEverWinRate,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/agents/ruflo — Ruflo intelligence layer stats
router.get('/agents/ruflo', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const coordinator = getCoordinator();
    const ruflo = coordinator.getRufloStats();
    const { getSwarmConsensusStats } = require('../agents/swarm-engine');

    // Add per-agent Q-Learning stats
    const agentQL = {};
    for (const [name, agent] of coordinator._agents) {
      try {
        agentQL[name] = agent.getQLStats();
      } catch (_) {}
    }

    res.json({
      consensus: ruflo.consensus,
      patterns: ruflo.patterns,
      swarmConsensus: getSwarmConsensusStats(),
      agentQLearning: agentQL,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/agents/command — Send command to coordinator
router.post('/agents/command', async (req, res) => {
  try {
    const { command, params } = req.body;
    if (!command) return res.status(400).json({ error: 'Missing command' });
    const { getCoordinator } = require('../agents');
    const coordinator = getCoordinator();
    const result = await coordinator.handleCommand(command, params || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/agents/chat — Natural language chat with agents (120s timeout for tunnel-routed Ollama)
router.post('/agents/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    const { getCoordinator } = require('../agents');
    const coordinator = getCoordinator();
    const timeoutMs = 120000;
    const reply = await Promise.race([
      coordinator.handleChat(message),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chat timed out — AI is taking too long. Try a simpler question.')), timeoutMs)),
    ]);
    res.json(reply);
  } catch (err) {
    res.status(500).json({ from: 'Coordinator', message: err.message || 'Something went wrong' });
  }
});

// GET /api/admin/agents/activity — Activity feed only
router.get('/agents/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const { getCoordinator } = require('../agents');
    const coordinator = getCoordinator();
    res.json(coordinator.getAllActivity(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/agents/profiles — All agent profiles with skills & config
router.get('/agents/profiles', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    res.json(getCoordinator().getAllProfiles());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/agents/profiles/:key — Single agent profile

router.get('/brain-status', (req, res) => {
  const graphPath = Path('graphify-out/GRAPH_REPORT.md');
  const report = graphPath.exists() ? graphPath.read_text() : 'No report available';
  res.json({ report, status: 'Operational' });
});
router.get('/agents/profiles/:key', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const profile = getCoordinator().getAgentProfile(req.params.key);
    if (!profile) return res.status(404).json({ error: 'Agent not found' });
    res.json(profile);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/agents/profiles/:key/config — Update agent config
router.put('/agents/profiles/:key/config', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const result = getCoordinator().updateAgentConfig(req.params.key, req.body);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PUT /api/admin/agents/profiles/:key/skill — Toggle a skill
router.put('/agents/profiles/:key/skill', async (req, res) => {
  try {
    const { skillId, enabled } = req.body;
    if (!skillId) return res.status(400).json({ error: 'Missing skillId' });
    const { getCoordinator } = require('../agents');
    const result = getCoordinator().toggleAgentSkill(req.params.key, skillId, !!enabled);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/admin/agents/create — Create a custom watcher agent
router.post('/agents/create', async (req, res) => {
  try {
    const { name, symbols, alertThreshold, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const { getCoordinator } = require('../agents');
    const result = getCoordinator().addWatcherAgent(name, {
      symbols: (symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
      alertThreshold: parseFloat(alertThreshold) || 3,
      description: description || '',
    });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/admin/agents/:key — Remove a custom agent
router.delete('/agents/:key', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const result = getCoordinator().removeAgent(req.params.key);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/admin/agents/add — Deploy a new token agent with AI-generated soul
router.post('/agents/add', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ ok: false, error: 'Missing symbol' });
    const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
    const { getCoordinator } = require('../agents');
    const coordinator = getCoordinator();
    if (coordinator.tokenAgents.has(sym)) {
      return res.json({ ok: false, error: `${sym} agent already exists` });
    }
    coordinator.addTokenAgent(sym);
    const key = sym.toLowerCase().replace('usdt', '');
    const agent = coordinator._agents.get(key);
    const profile = agent ? (agent._profile || agent.profile || {}) : {};
    res.json({
      ok: true,
      symbol: sym,
      key,
      profile,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Email Broadcast ─────────────────────────────────────────

// GET /api/admin/email/status — check if SMTP is configured
router.get('/email/status', adminOnly, (req, res) => {
  res.json({
    configured: emailService.isConfigured(),
    from: process.env.EMAIL_FROM || 'not set',
    host: process.env.SMTP_HOST || 'not set',
  });
});

// POST /api/admin/email/broadcast — send custom email to all (or filtered) members
router.post('/email/broadcast', adminOnly, async (req, res) => {
  try {
    const { subject, body_html, body_text, filter } = req.body;
    if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!body_html?.trim() && !body_text?.trim()) return res.status(400).json({ error: 'Email body is required' });

    if (!emailService.isConfigured()) {
      return res.status(503).json({ error: 'SMTP not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS to environment variables.' });
    }

    // Determine recipient list
    let whereClause = 'WHERE is_blocked = false';
    if (filter === 'active') {
      // Only users who have connected API keys
      whereClause = `WHERE is_blocked = false AND id IN (SELECT DISTINCT user_id FROM api_keys WHERE enabled = true)`;
    } else if (filter === 'overdue') {
      // Users with overdue fees
      whereClause = `WHERE is_blocked = false AND weekly_fee_due < NOW()`;
    }

    const rows = await query(`SELECT email FROM users ${whereClause} ORDER BY created_at ASC`);
    const emails = rows.map(r => r.email).filter(Boolean);

    if (emails.length === 0) {
      return res.json({ ok: true, sent: 0, failed: 0, message: 'No recipients matched the filter.' });
    }

    // Log the broadcast to DB for audit trail
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`email_broadcast_last`, JSON.stringify({
        subject,
        filter: filter || 'all',
        recipientCount: emails.length,
        sentBy: req.userId,
        sentAt: new Date().toISOString(),
      })]
    );

    // Respond immediately — send in background to avoid HTTP timeout on large lists
    res.json({ ok: true, recipientCount: emails.length, message: `Sending to ${emails.length} members...` });

    // Background send (non-blocking)
    const html = body_html || `<p>${(body_text || '').replace(/\n/g, '<br/>')}</p>`;
    const text = body_text || body_html?.replace(/<[^>]+>/g, '') || '';
    emailService.broadcastToAll(subject, html, text, emails).catch(err => {
      console.error('[Admin Email] Broadcast error:', err.message);
    });

  } catch (err) {
    console.error('[Admin Email] Broadcast failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/email/test — send a test email to the admin
router.post('/email/test', adminOnly, async (req, res) => {
  try {
    if (!emailService.isConfigured()) {
      return res.status(503).json({ error: 'SMTP not configured.' });
    }
    const adminRow = await query('SELECT email FROM users WHERE id = $1', [req.userId]);
    const adminEmail = adminRow[0]?.email;
    if (!adminEmail) return res.status(404).json({ error: 'Admin email not found' });

    const result = await emailService.sendMail({
      to: adminEmail,
      subject: 'MCT Email Test ✅',
      html: `<p style="font-family:sans-serif;color:#1e293b;">SMTP is working correctly. Sent at ${new Date().toISOString()}.</p>`,
      text: `MCT Email Test — SMTP is working. Sent at ${new Date().toISOString()}.`,
    });

    if (result.ok) {
      res.json({ ok: true, message: `Test email sent to ${adminEmail}` });
    } else {
      res.status(500).json({ error: `Failed: ${result.reason}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
