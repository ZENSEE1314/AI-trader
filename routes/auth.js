const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
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

    const { remember } = req.body;
    const rows = await query('SELECT id, password_hash, is_blocked FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    if (rows[0].is_blocked) return res.status(403).json({ error: 'Account is blocked. Contact support.' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 30 days or 1 day
    const token = signToken(rows[0].id, email.toLowerCase(), remember);
    res.cookie('token', token, { httpOnly: true, maxAge, sameSite: 'lax' });
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

// Forgot password — generate reset token
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const rows = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    // Always return success (don't leak whether email exists)
    if (!rows.length) return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store token in DB (reuse referral_code column would be messy, so store in a simple way)
    await query(
      `UPDATE users SET referral_code = COALESCE(referral_code, $1) WHERE id = $2`,
      [generateReferralCode(), rows[0].id]
    );

    // For now, store reset token as a setting keyed by user id
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`reset_${rows[0].id}`, `${resetToken}|${expires.toISOString()}`]
    );

    const appUrl = process.env.APP_URL || 'https://millionairecryptotraders.up.railway.app';
    const resetLink = `${appUrl}/?reset=${resetToken}&uid=${rows[0].id}`;

    // Send via Telegram to admin (simple notification — no email service needed)
    const tgToken = process.env.TELEGRAM_TOKEN;
    const tgChats = (process.env.TELEGRAM_CHAT_ID || '').split(',').filter(Boolean);
    if (tgToken && tgChats.length) {
      const msg = `🔑 Password Reset Request\nUser: ${email}\nLink: ${resetLink}\n\nSend this link to the user.`;
      for (const chatId of tgChats) {
        try {
          await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId.trim(), text: msg }),
          });
        } catch (_) {}
      }
    }

    res.json({ ok: true, message: 'If that email exists, a reset link has been sent to admin. Contact support to receive it.' });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset password with token
router.post('/reset-password', async (req, res) => {
  try {
    const { token, uid, password } = req.body;
    if (!token || !uid || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

    const rows = await query('SELECT value FROM settings WHERE key = $1', [`reset_${uid}`]);
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset link' });

    const [storedToken, expiresStr] = rows[0].value.split('|');
    if (storedToken !== token) return res.status(400).json({ error: 'Invalid reset link' });
    if (new Date(expiresStr) < new Date()) return res.status(400).json({ error: 'Reset link expired' });

    const hash = await bcrypt.hash(password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, uid]);
    await query('DELETE FROM settings WHERE key = $1', [`reset_${uid}`]);

    res.json({ ok: true, message: 'Password reset! You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
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
