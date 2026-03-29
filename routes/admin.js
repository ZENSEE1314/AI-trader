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
      const now = new Date();
      const expires = new Date(now);
      expires.setMonth(expires.getMonth() + 1);
      await query(
        `UPDATE subscriptions SET status = 'active', starts_at = $1, expires_at = $2 WHERE id = $3`,
        [now, expires, req.params.id]
      );
    } else {
      await query('UPDATE subscriptions SET status = $1 WHERE id = $2', ['rejected', req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin sub action error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

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

module.exports = router;
