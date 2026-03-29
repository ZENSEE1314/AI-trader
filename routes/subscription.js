const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
// Public endpoint — no auth needed (for landing page)
router.get('/prices', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ price: settings.price, signal_price: settings.signal_price });
  } catch { res.json({ price: 29.99, signal_price: 500 }); }
});

router.use(authMiddleware);

const BANK_DETAILS = {
  bank: process.env.BANK_NAME || 'DBS Bank',
  account: process.env.BANK_ACCOUNT || '123-456789-0',
  name: process.env.BANK_HOLDER || 'CryptoBot Trading',
};

async function getSettings() {
  const rows = await query('SELECT key, value FROM settings');
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    price: parseFloat(s.sub_price) || 29.99,
    signal_price: parseFloat(s.signal_price) || 500,
    tier1: parseFloat(s.commission_tier1) || 0,
    tier2: parseFloat(s.commission_tier2) || 0,
    tier3: parseFloat(s.commission_tier3) || 0,
  };
}

// Extend subscription by N days — stacks on existing time
async function extendSubscription(userId, days, amount, method, plan = 'monthly') {
  // Find existing active sub for this plan
  const existing = await query(
    `SELECT id, expires_at FROM subscriptions WHERE user_id = $1 AND status = 'active' AND plan = $2 AND expires_at > NOW()
     ORDER BY expires_at DESC LIMIT 1`,
    [userId, plan]
  );

  const now = new Date();
  let newExpiry;

  if (existing.length) {
    // Extend from current expiry date
    newExpiry = new Date(existing[0].expires_at);
    newExpiry.setDate(newExpiry.getDate() + days);
    await query('UPDATE subscriptions SET expires_at = $1 WHERE id = $2', [newExpiry, existing[0].id]);
  } else {
    // Create new subscription starting now
    newExpiry = new Date(now);
    newExpiry.setDate(newExpiry.getDate() + days);
    await query(
      `INSERT INTO subscriptions (user_id, plan, status, amount, payment_method, starts_at, expires_at)
       VALUES ($1, $2, 'active', $3, $4, $5, $6)`,
      [userId, plan, amount, method, now, newExpiry]
    );
  }

  return newExpiry;
}

// Get subscription status + pricing info + countdown
router.get('/status', async (req, res) => {
  try {
    const settings = await getSettings();
    const sub = await query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [req.userId]
    );
    const user = await query('SELECT wallet_balance, telegram_id FROM users WHERE id = $1', [req.userId]);

    // Check signal sub separately
    const signalSub = await query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' AND plan = 'signal' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [req.userId]
    );

    let days_left = 0;
    if (sub.length) {
      const now = new Date();
      const exp = new Date(sub[0].expires_at);
      days_left = Math.max(0, Math.ceil((exp - now) / (1000 * 60 * 60 * 24)));
    }

    let signal_days_left = 0;
    if (signalSub.length) {
      const now = new Date();
      const exp = new Date(signalSub[0].expires_at);
      signal_days_left = Math.max(0, Math.ceil((exp - now) / (1000 * 60 * 60 * 24)));
    }

    res.json({
      active: sub.length > 0,
      subscription: sub[0] || null,
      days_left,
      signal_active: signalSub.length > 0,
      signal_sub: signalSub[0] || null,
      signal_days_left,
      price: settings.price,
      signal_price: settings.signal_price,
      wallet_balance: parseFloat(user[0]?.wallet_balance || 0),
      telegram_id: user[0]?.telegram_id || '',
      bank_details: BANK_DETAILS,
    });
  } catch (err) {
    console.error('Sub status error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save Telegram ID
router.post('/telegram-id', async (req, res) => {
  try {
    const { telegram_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Telegram ID required' });
    await query('UPDATE users SET telegram_id = $1 WHERE id = $2', [telegram_id.trim(), req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram ID error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pay via bank transfer (submit proof)
router.post('/bank-transfer', async (req, res) => {
  try {
    const settings = await getSettings();
    const { proof_url, plan } = req.body;
    if (!proof_url) return res.status(400).json({ error: 'Payment proof URL required' });

    const isSignal = plan === 'signal';
    const amount = isSignal ? settings.signal_price : settings.price;
    const planName = isSignal ? 'signal' : 'monthly';

    if (isSignal) {
      const user = await query('SELECT telegram_id FROM users WHERE id = $1', [req.userId]);
      if (!user[0]?.telegram_id) return res.status(400).json({ error: 'Set your Telegram ID first' });
    }

    await query(
      `INSERT INTO subscriptions (user_id, plan, status, amount, payment_method, proof_url)
       VALUES ($1, $2, 'pending', $3, 'bank_transfer', $4)`,
      [req.userId, planName, amount, proof_url]
    );
    res.json({ ok: true, message: 'Payment submitted. Waiting for admin approval.' });
  } catch (err) {
    console.error('Bank transfer error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pay via wallet balance
router.post('/pay-wallet', async (req, res) => {
  try {
    const settings = await getSettings();
    const { plan } = req.body;
    const isSignal = plan === 'signal';
    const amount = isSignal ? settings.signal_price : settings.price;
    const planName = isSignal ? 'signal' : 'monthly';

    if (isSignal) {
      const u = await query('SELECT telegram_id FROM users WHERE id = $1', [req.userId]);
      if (!u[0]?.telegram_id) return res.status(400).json({ error: 'Set your Telegram ID first' });
    }

    const user = await query('SELECT wallet_balance FROM users WHERE id = $1', [req.userId]);
    const balance = parseFloat(user[0]?.wallet_balance || 0);

    if (balance < amount) {
      return res.status(400).json({ error: `Insufficient balance. Need $${amount}, have $${balance.toFixed(2)}` });
    }

    await query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amount, req.userId]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES ($1, 'subscription', $2, $3)`,
      [req.userId, -amount, `${isSignal ? 'Signal' : 'Bot'} subscription payment`]
    );

    const expires = await extendSubscription(req.userId, 30, amount, 'wallet', planName);
    await payReferralCommission(req.userId, { ...settings, price: amount });

    res.json({ ok: true, message: `${isSignal ? 'Signal' : 'Bot'} subscription active until ${expires.toISOString().slice(0, 10)}!` });
  } catch (err) {
    console.error('Wallet pay error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pay via Stripe
router.post('/stripe-checkout', async (req, res) => {
  try {
    const settings = await getSettings();
    const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_KEY) return res.status(400).json({ error: 'Stripe not configured' });

    const stripe = require('stripe')(STRIPE_KEY);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'CryptoBot Monthly Subscription' },
          unit_amount: Math.round(settings.price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.APP_URL || 'https://cryptobot-g35r.onrender.com'}/?payment=success`,
      cancel_url: `${process.env.APP_URL || 'https://cryptobot-g35r.onrender.com'}/?payment=cancel`,
      metadata: { userId: String(req.userId) },
    });

    await query(
      `INSERT INTO subscriptions (user_id, plan, status, amount, payment_method, stripe_session_id)
       VALUES ($1, 'monthly', 'stripe_pending', $2, 'stripe', $3)`,
      [req.userId, settings.price, session.id]
    );

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Stripe checkout failed' });
  }
});

// Stripe webhook (no auth — Stripe calls this)
router.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
    const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
    if (!STRIPE_KEY || !WEBHOOK_SECRET) return res.status(400).send('Not configured');

    const stripe = require('stripe')(STRIPE_KEY);
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = parseInt(session.metadata.userId);
      const settings = await getSettings();
      await extendSubscription(userId, 30, settings.price, 'stripe');
      // Mark stripe sub record as active
      await query(`UPDATE subscriptions SET status = 'active' WHERE stripe_session_id = $1`, [session.id]);
      await payReferralCommission(userId, settings);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    res.status(400).send(err.message);
  }
});

// Pay 3-tier referral commission
// Tier 1: user who directly referred → tier1 %
// Tier 2: person who referred tier 1 → tier2 %
// Tier 3: person who referred tier 2 → tier3 %
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

      // Only pay commission if referrer has active subscription
      const activeSub = await query(
        `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW() LIMIT 1`,
        [referrerId]
      );
      if (!activeSub.length) {
        // Referrer's account is not active — skip commission, continue up chain
        currentId = referrerId;
        continue;
      }

      const commission = settings.price * (pct / 100);

      await query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [commission, referrerId]);
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, ref_id)
         VALUES ($1, 'commission', $2, $3, $4)`,
        [referrerId, commission, `Tier ${tier + 1} commission from user #${userId} (${pct}%)`, userId]
      );

      currentId = referrerId;
    }
  } catch (err) {
    console.error('Referral commission error:', err.message);
  }
}

module.exports = router;
