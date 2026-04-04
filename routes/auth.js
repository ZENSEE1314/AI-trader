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

    // Set initial weekly fee due 7 days from signup (free trial period)
    const feeDue = new Date();
    feeDue.setDate(feeDue.getDate() + 7);

    const rows = await query(
      'INSERT INTO users (email, password_hash, referral_code, referred_by, weekly_fee_due) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [email.toLowerCase(), hash, myRefCode, referredBy, feeDue]
    );
    const token = signToken(rows[0].id, email.toLowerCase());
    // Railway-compatible cookie settings
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
    res.cookie('token', token, { 
      httpOnly: true, 
      maxAge: 30 * 24 * 60 * 60 * 1000, 
      sameSite: isProduction ? 'none' : 'lax',
      secure: isProduction,
      domain: isProduction ? undefined : 'localhost'
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    console.log('[AUTH DEBUG] Login attempt:', { 
      email: req.body.email ? 'provided' : 'missing',
      password: req.body.password ? 'provided' : 'missing',
      remember: req.body.remember,
      hasJWTSecret: !!process.env.JWT_SECRET,
      nodeEnv: process.env.NODE_ENV,
      isRailway: !!process.env.RAILWAY_ENVIRONMENT
    });
    
    const { email, password } = req.body;
    if (!email || !password) {
      console.log('[AUTH DEBUG] Missing email or password');
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { remember } = req.body;
    console.log('[AUTH DEBUG] Querying database for user:', email.toLowerCase());
    const rows = await query('SELECT id, password_hash, is_blocked FROM users WHERE email = $1', [email.toLowerCase()]);
    console.log('[AUTH DEBUG] Database result:', { found: rows.length, isBlocked: rows[0]?.is_blocked });
    
    if (!rows.length) {
      console.log('[AUTH DEBUG] User not found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (rows[0].is_blocked) {
      console.log('[AUTH DEBUG] User is blocked');
      return res.status(403).json({ error: 'Account is blocked. Contact support.' });
    }

    console.log('[AUTH DEBUG] Checking password...');
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    console.log('[AUTH DEBUG] Password valid:', valid);
    
    if (!valid) {
      console.log('[AUTH DEBUG] Invalid password');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 30 days or 1 day
    console.log('[AUTH DEBUG] Creating JWT token...');
    const token = signToken(rows[0].id, email.toLowerCase(), remember);
    console.log('[AUTH DEBUG] Token created, length:', token.length);
    
    // Railway-compatible cookie settings
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
    console.log('[AUTH DEBUG] Cookie settings:', { 
      isProduction, 
      sameSite: isProduction ? 'none' : 'lax',
      secure: isProduction,
      maxAge
    });
    
    res.cookie('token', token, { 
      httpOnly: true, 
      maxAge,
      sameSite: isProduction ? 'none' : 'lax',
      secure: isProduction,
      domain: isProduction ? undefined : 'localhost'
    });
    
    console.log('[AUTH DEBUG] Login successful, sending response');
    res.json({ ok: true });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
  res.clearCookie('token', { 
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    domain: isProduction ? undefined : 'localhost'
  });
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
      `SELECT id, email, is_admin, is_blocked, referral_code, wallet_balance,
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
    console.error('Me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
