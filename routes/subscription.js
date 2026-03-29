const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const MONTHLY_PRICE = parseFloat(process.env.SUB_PRICE || '29.99');
const REFERRAL_COMMISSION_PCT = parseFloat(process.env.REFERRAL_PCT || '0.20'); // 20%
const BANK_DETAILS = {
  bank: process.env.BANK_NAME || 'DBS Bank',
  account: process.env.BANK_ACCOUNT || '123-456789-0',
  name: process.env.BANK_HOLDER || 'CryptoBot Trading',
};

// Get subscription status + pricing info
router.get('/status', async (req, res) => {
  try {
    const sub = await query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [req.userId]
    );
    const user = await query('SELECT wallet_balance FROM users WHERE id = $1', [req.userId]);
    res.json({
      active: sub.length > 0,
      subscription: sub[0] || null,
      price: MONTHLY_PRICE,
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
    const { proof_url } = req.body;
    if (!proof_url) return res.status(400).json({ error: 'Payment proof URL required' });

    await query(
      `INSERT INTO subscriptions (user_id, plan, status, amount, payment_method, proof_url)
       VALUES ($1, 'monthly', 'pending', $2, 'bank_transfer', $3)`,
      [req.userId, MONTHLY_PRICE, proof_url]
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
    const user = await query('SELECT wallet_balance FROM users WHERE id = $1', [req.userId]);
    const balance = parseFloat(user[0]?.wallet_balance || 0);

    if (balance < MONTHLY_PRICE) {
      return res.status(400).json({ error: `Insufficient balance. Need $${MONTHLY_PRICE}, have $${balance.toFixed(2)}` });
    }

    // Deduct from wallet
    await query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [MONTHLY_PRICE, req.userId]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES ($1, 'subscription', $2, 'Monthly subscription payment')`,
      [req.userId, -MONTHLY_PRICE]
    );

    // Activate subscription
    const now = new Date();
    const expires = new Date(now);
    expires.setMonth(expires.getMonth() + 1);
    await query(
      `INSERT INTO subscriptions (user_id, plan, status, amount, payment_method, starts_at, expires_at)
       VALUES ($1, 'monthly', 'active', $2, 'wallet', $3, $4)`,
      [req.userId, MONTHLY_PRICE, now, expires]
    );

    // Pay referral commission
    await payReferralCommission(req.userId, MONTHLY_PRICE);

    res.json({ ok: true, message: 'Subscription activated!' });
  } catch (err) {
    console.error('Wallet pay error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pay via Stripe
router.post('/stripe-checkout', async (req, res) => {
  try {
    const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_KEY) return res.status(400).json({ error: 'Stripe not configured' });

    const stripe = require('stripe')(STRIPE_KEY);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'CryptoBot Monthly Subscription' },
          unit_amount: Math.round(MONTHLY_PRICE * 100),
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
      [req.userId, MONTHLY_PRICE, session.id]
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
      await payReferralCommission(userId, MONTHLY_PRICE);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    res.status(400).send(err.message);
  }
});

// Pay referral commission to the person who referred this user
async function payReferralCommission(userId, amount) {
  try {
    const user = await query('SELECT referred_by FROM users WHERE id = $1', [userId]);
    if (!user.length || !user[0].referred_by) return;

    const referrerId = user[0].referred_by;
    const commission = amount * REFERRAL_COMMISSION_PCT;

    await query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [commission, referrerId]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, ref_id)
       VALUES ($1, 'commission', $2, $3, $4)`,
      [referrerId, commission, `Referral commission from user #${userId}`, userId]
    );
  } catch (err) {
    console.error('Referral commission error:', err.message);
  }
}

module.exports = router;
