const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

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

    // Get all users with their profit share settings and weekly performance
    const users = await query(
      `SELECT u.id, u.email,
              ak.id as key_id, ak.label as key_label, ak.platform,
              ak.profit_share_user_pct, ak.profit_share_admin_pct,
              ak.paused_by_admin, ak.enabled
       FROM users u
       LEFT JOIN api_keys ak ON ak.user_id = u.id
       WHERE u.is_admin = false
       ORDER BY u.email, ak.id`
    );

    // Get this week's trades for all users
    const trades = await query(
      `SELECT t.user_id, t.api_key_id, t.pnl_usdt, t.status, t.symbol
       FROM trades t
       WHERE t.status IN ('WIN', 'LOSS', 'TP', 'SL', 'CLOSED')
         AND t.closed_at >= $1 AND t.closed_at <= $2`,
      [monday, sunday]
    );

    // Build per-user/per-key summary
    const result = [];
    let grandTotalWinning = 0;
    let grandTotalUserShare = 0;
    let grandTotalAdminShare = 0;

    const userMap = {};
    for (const u of users) {
      if (!userMap[u.id]) {
        userMap[u.id] = {
          user_id: u.id,
          email: u.email,
          keys: [],
          total_winning_pnl: 0,
          total_user_share: 0,
          total_admin_share: 0,
          total_trades: 0,
          total_wins: 0,
        };
      }
      if (u.key_id) {
        const keyTrades = trades.filter(t => t.api_key_id === u.key_id);
        const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
        const winningPnl = wins.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
        const userPct = parseFloat(u.profit_share_user_pct) || 60;
        const adminPct = parseFloat(u.profit_share_admin_pct) || 40;

        const keyData = {
          key_id: u.key_id,
          label: u.key_label || u.platform,
          platform: u.platform,
          paused: u.paused_by_admin || false,
          enabled: u.enabled !== false,
          total_trades: keyTrades.length,
          win_count: wins.length,
          winning_pnl: winningPnl,
          user_share_pct: userPct,
          admin_share_pct: adminPct,
          user_share: Math.max(0, winningPnl * userPct / 100),
          admin_share: Math.max(0, winningPnl * adminPct / 100),
        };

        userMap[u.id].keys.push(keyData);
        userMap[u.id].total_winning_pnl += winningPnl;
        userMap[u.id].total_user_share += keyData.user_share;
        userMap[u.id].total_admin_share += keyData.admin_share;
        userMap[u.id].total_trades += keyTrades.length;
        userMap[u.id].total_wins += wins.length;
      }
    }

    for (const u of Object.values(userMap)) {
      grandTotalWinning += u.total_winning_pnl;
      grandTotalUserShare += u.total_user_share;
      grandTotalAdminShare += u.total_admin_share;
    }

    res.json({
      week_start: monday.toISOString(),
      week_end: sunday.toISOString(),
      grand_total_winning: grandTotalWinning,
      grand_total_user_share: grandTotalUserShare,
      grand_total_admin_share: grandTotalAdminShare,
      users: Object.values(userMap),
    });
  } catch (err) {
    console.error('Admin weekly earnings error:', err.message);
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
      `SELECT u.id, u.email, u.is_blocked, u.is_admin, u.referral_code, u.wallet_balance, u.created_at,
              (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count,
              (SELECT status FROM subscriptions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) as sub_status,
              (SELECT expires_at FROM subscriptions WHERE user_id = u.id AND status = 'active' ORDER BY expires_at DESC LIMIT 1) as sub_expires,
              (SELECT email FROM users WHERE id = u.referred_by) as referred_by_email
       FROM users u ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin users error:', err.message);
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
router.put('/users/:id/wallet', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (amount === undefined || amount === null) return res.status(400).json({ error: 'Amount required' });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) return res.status(400).json({ error: 'Invalid amount' });

    // Get current balance
    const user = await query('SELECT wallet_balance, email FROM users WHERE id = $1', [req.params.id]);
    if (!user.length) return res.status(404).json({ error: 'User not found' });

    const currentBalance = parseFloat(user[0].wallet_balance);
    const diff = parsedAmount - currentBalance;

    // Update balance
    await query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [parsedAmount, req.params.id]);

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
    const { sub_price, signal_price, commission_tier1, commission_tier2, commission_tier3 } = req.body;

    const updates = [
      ['sub_price', sub_price],
      ['signal_price', signal_price],
      ['commission_tier1', commission_tier1],
      ['commission_tier2', commission_tier2],
      ['commission_tier3', commission_tier3],
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

module.exports = router;
