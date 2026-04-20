const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const { query } = require('../db');
const { authMiddleware, signToken } = require('../middleware/auth');
const emailService = require('../email-service');

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

    // Set initial weekly fee due 7 days from signup (free trial period)
    const feeDue = new Date();
    feeDue.setDate(feeDue.getDate() + 7);

    // First registered user becomes admin automatically
    const userCount = await query('SELECT COUNT(*) as cnt FROM users');
    const isFirstUser = parseInt(userCount[0]?.cnt || 0) === 0;

    const rows = await query(
      'INSERT INTO users (email, password_hash, referral_code, referred_by, weekly_fee_due, is_admin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [email.toLowerCase(), hash, myRefCode, referredBy, feeDue, isFirstUser]
    );
    const token = signToken(rows[0].id, email.toLowerCase());
    res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ ok: true });

    // Send welcome email in background — don't block the response
    emailService.sendWelcome(email.toLowerCase(), '').catch(() => {});
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
    console.log(`[LOGIN] attempt for ${email}`);
    const rows = await query('SELECT id, password_hash, is_blocked FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) {
      console.log(`[LOGIN] no user found for ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (rows[0].is_blocked) return res.status(403).json({ error: 'Account is blocked. Contact support.' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) {
      console.log(`[LOGIN] wrong password for ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 30 days or 1 day
    const token = signToken(rows[0].id, email.toLowerCase(), remember);
    // secure: true required on Railway (HTTPS) so browsers honour the cookie
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('token', token, { httpOnly: true, maxAge, sameSite: 'lax', secure: isSecure });
    console.log(`[LOGIN] success for ${email} (secure=${isSecure})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[LOGIN] error:', err.message, err.stack);
    res.status(500).json({ error: `Server error: ${err.message}` });
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

    // 1. Send reset email directly to the user
    const emailResult = await emailService.sendPasswordReset(email.toLowerCase(), resetLink);

    // 2. Also notify admin via Telegram (as backup / audit trail)
    const tgToken = process.env.TELEGRAM_TOKEN;
    const tgChats = (process.env.TELEGRAM_CHAT_ID || '').split(',').filter(Boolean);
    if (tgToken && tgChats.length) {
      const emailStatus = emailResult.ok ? '✅ Email sent to user' : `⚠️ Email failed (${emailResult.reason}) — send manually`;
      const msg = `🔑 Password Reset Request\nUser: ${email}\nLink: ${resetLink}\n\n${emailStatus}`;
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

    const message = emailResult.ok
      ? 'If that email exists, a reset link has been sent to your inbox.'
      : 'If that email exists, a reset link has been sent. Please also check with support if you don\'t receive it.';

    res.json({ ok: true, message });
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
    const tokenBuf = Buffer.from(token);
    const storedBuf = Buffer.from(storedToken);
    if (tokenBuf.length !== storedBuf.length || !crypto.timingSafeEqual(tokenBuf, storedBuf)) {
      return res.status(400).json({ error: 'Invalid reset link' });
    }
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
      `SELECT id, username, email, is_admin, is_blocked, referral_code, wallet_balance,
              cash_wallet, commission_earned, weekly_fee_due, usdt_address, usdt_network
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!user.length) return res.status(401).json({ error: 'User not found' });
    if (user[0].is_blocked) return res.status(403).json({ error: 'Account is blocked' });

    const u = user[0];
    const feeDue = u.weekly_fee_due ? new Date(u.weekly_fee_due) : null;
    const feeOverdue = feeDue ? new Date() > feeDue : false;

    res.json({
      userId: u.id,
      username: u.username || '',
      email: u.email,
      is_admin: u.is_admin,
      referral_code: u.referral_code,
      wallet_balance: parseFloat(u.wallet_balance) || 0,
      cash_wallet: parseFloat(u.cash_wallet) || 0,
      commission_earned: parseFloat(u.commission_earned) || 0,
      weekly_fee_due: u.weekly_fee_due,
      fee_overdue: feeOverdue,
      usdt_address: u.usdt_address || '',
      usdt_network: u.usdt_network || 'BEP20',
    });
  } catch (err) {
    console.error('[ME] error:', err.message, err.stack);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

// Update profile (username, email)
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { username, email } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (username !== undefined) {
      updates.push(`username = $${idx++}`);
      params.push(username.trim());
    }
    if (email) {
      const existing = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.toLowerCase(), req.userId]);
      if (existing.length) return res.status(409).json({ error: 'Email already in use' });
      updates.push(`email = $${idx++}`);
      params.push(email.toLowerCase());
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.userId);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    // If email changed, re-issue token
    if (email) {
      const newToken = signToken(req.userId, email.toLowerCase());
      res.cookie('token', newToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });

    const rows = await query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.userId]);
    res.json({ ok: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: look up referrer info by referral code (used on landing page)
// Returns only the Bitunix referral link — no sensitive data
router.get('/referral-info', async (req, res) => {
  try {
    const code = (req.query.ref || '').trim().toUpperCase();
    if (!code) return res.json({ found: false });
    const rows = await query(
      `SELECT email, bitunix_referral_link FROM users WHERE referral_code = $1 LIMIT 1`,
      [code]
    );
    if (!rows.length) return res.json({ found: false });
    const u = rows[0];
    res.json({
      found: true,
      referrer_email: u.email ? u.email.replace(/(.{2}).*(@.*)/, '$1***$2') : '',
      bitunix_referral_link: u.bitunix_referral_link || '',
    });
  } catch (err) {
    res.json({ found: false });
  }
});

module.exports = router;
