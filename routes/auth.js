const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { authMiddleware, signToken } = require('../middleware/auth');

const router = express.Router();

function generateReferralCode() {
  return 'CB' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

router.post('/signup', async (req, res) => {
  try {
    const { email, password, referral_code } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.length) return res.status(409).json({ error: 'Email already registered' });

    // Check referral code
    let referredBy = null;
    if (referral_code) {
      const referrer = await query('SELECT id FROM users WHERE referral_code = $1', [referral_code.toUpperCase()]);
      if (referrer.length) referredBy = referrer[0].id;
    }

    const hash = await bcrypt.hash(password, 10);
    const myRefCode = generateReferralCode();
    const rows = await query(
      'INSERT INTO users (email, password_hash, referral_code, referred_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [email.toLowerCase(), hash, myRefCode, referredBy]
    );
    const token = signToken(rows[0].id, email.toLowerCase());
    res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const rows = await query('SELECT id, password_hash, is_blocked FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    if (rows[0].is_blocked) return res.status(403).json({ error: 'Account is blocked. Contact support.' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(rows[0].id, email.toLowerCase());
    res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await query(
      `SELECT id, email, is_admin, is_blocked, referral_code, wallet_balance FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!user.length) return res.status(401).json({ error: 'User not found' });
    if (user[0].is_blocked) return res.status(403).json({ error: 'Account is blocked' });

    // Check active subscription
    const sub = await query(
      `SELECT id, expires_at FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW() LIMIT 1`,
      [req.userId]
    );

    res.json({
      userId: user[0].id,
      email: user[0].email,
      is_admin: user[0].is_admin,
      referral_code: user[0].referral_code,
      wallet_balance: parseFloat(user[0].wallet_balance),
      has_subscription: sub.length > 0,
      sub_expires: sub[0]?.expires_at || null,
    });
  } catch (err) {
    console.error('Me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
