const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
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
    tier1: parseFloat(s.commission_tier1) || 0,
    tier2: parseFloat(s.commission_tier2) || 0,
    tier3: parseFloat(s.commission_tier3) || 0,
  };
}

// Get subscription status + pricing info
router.get('/status', async (req, res) => {
  try {
    const settings = await getSettings();
    const sub = await query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [req.userId]
    );
    const user = await query('SELECT wallet_balance FROM users WHERE id = $1', [req.userId]);
    res.json({
      active: sub.length > 0,
      subscription: sub[0] || null,
      price: settings.price,
      wallet_balance: parseFloat(user[0]?.wallet_balance || 0),
      bank_details: BANK_DETAILS,
    });
  } catch (err) {
    console.error('Sub status error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pay via bank transfer (submit proof)
router.post('/bank-transfer', async (req, res) => {
  try {
    const settings = await getSettings();
    const { proof_url } = req.body;
    if (!proof_url) return res.status(400).json({ error: 'Payment proof URL required' });

    await query(
      `INSERT INTO subscriptions (user_id, plan, status, amount, payment_method, proof_url)
       VALUES ($1, 'monthly', 'pending', $2, 'bank_transfer', $3)`,
      [req.userId, settings.price, proof_url]
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
    const user = await query('SELECT wallet_balance FROM users WHERE id = $1', [req.userId]);
    const balance = parseFloat(user[0]?.wallet_balance || 0);

    if (balance < settings.price) {
      return res.status(400).json({ error: `Insufficient balance. Need $${settings.price}, have $${balance.toFixed(2)}` });
    }

    await query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [settings.price, req.userId]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES ($1, 'subscription', $2, 'Monthly subscription payment')`,
      [req.userId, -settings.price]
    );

    const now = new Date();
    const expires = new Date(now);
    expires.setMonth(expires.getMonth() + 1);
    await query(
      `INSERT INTO subscriptions (user_id, plan, status, amount, payment_method, starts_at, expires_at)
       VALUES ($1, 'monthly', 'active', $2, 'wallet', $3, $4)`,
      [req.userId, settings.price, now, expires]
    );

    await payReferralCommission(req.userId, settings);

    res.json({ ok: true, message: 'Subscription activated!' });
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
      const now = new Date();
      const expires = new Date(now);
      expires.setMonth(expires.getMonth() + 1);

      await query(
        `UPDATE subscriptions SET status = 'active', starts_at = $1, expires_at = $2
         WHERE stripe_session_id = $3`,
        [now, expires, session.id]
      );
      const settings = await getSettings();
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
