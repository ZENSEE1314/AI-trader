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
