const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ── Get wallet status ────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const user = await query(
      `SELECT cash_wallet, commission_earned, weekly_fee_amount, weekly_fee_due,
              usdt_address, usdt_network, referral_code, is_admin
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!user.length) return res.status(404).json({ error: 'User not found' });
    const u = user[0];

    const referralCount = await query(
      'SELECT COUNT(*) as cnt FROM users WHERE referred_by = $1', [req.userId]
    );

    // Get weekly fee from settings if user doesn't have one set
    let weeklyFee = parseFloat(u.weekly_fee_amount) || 0;
    if (!weeklyFee) {
      const settings = await query("SELECT value FROM settings WHERE key = 'weekly_fee'");
      weeklyFee = parseFloat(settings[0]?.value) || 10;
    }

    const now = new Date();
    const dueDate = u.weekly_fee_due ? new Date(u.weekly_fee_due) : null;
    const isDue = dueDate ? now >= dueDate : false;
    const daysLeft = dueDate ? Math.max(0, Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24))) : 0;

    res.json({
      cash_wallet: parseFloat(u.cash_wallet) || 0,
      commission_earned: parseFloat(u.commission_earned) || 0,
      total_balance: (parseFloat(u.cash_wallet) || 0) + (parseFloat(u.commission_earned) || 0),
      weekly_fee: weeklyFee,
      weekly_fee_due: u.weekly_fee_due,
      fee_due: isDue,
      days_left: daysLeft,
      usdt_address: u.usdt_address || '',
      usdt_network: u.usdt_network || 'BEP20',
      referral_code: u.referral_code || '',
      referral_count: parseInt(referralCount[0]?.cnt || 0),
    });
  } catch (err) {
    console.error('Wallet status error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Pay weekly fee ───────────────────────────────────────────
// source: 'cash' | 'commission' | 'both'
router.post('/pay-fee', async (req, res) => {
  try {
    const { source } = req.body; // 'cash', 'commission', or 'both'

    const user = await query(
      'SELECT cash_wallet, commission_earned, weekly_fee_amount, weekly_fee_due FROM users WHERE id = $1',
      [req.userId]
    );
    if (!user.length) return res.status(404).json({ error: 'User not found' });

    const u = user[0];
    let weeklyFee = parseFloat(u.weekly_fee_amount) || 0;
    if (!weeklyFee) {
      const settings = await query("SELECT value FROM settings WHERE key = 'weekly_fee'");
      weeklyFee = parseFloat(settings[0]?.value) || 10;
    }

    const cashBal = parseFloat(u.cash_wallet) || 0;
    const commBal = parseFloat(u.commission_earned) || 0;

    if (source === 'cash') {
      if (cashBal < weeklyFee) return res.status(400).json({ error: `Insufficient cash wallet. Need $${weeklyFee.toFixed(2)}, have $${cashBal.toFixed(2)}` });
      await query('UPDATE users SET cash_wallet = cash_wallet - $1 WHERE id = $2', [weeklyFee, req.userId]);
    } else if (source === 'commission') {
      if (commBal < weeklyFee) return res.status(400).json({ error: `Insufficient commission. Need $${weeklyFee.toFixed(2)}, have $${commBal.toFixed(2)}` });
      await query('UPDATE users SET commission_earned = commission_earned - $1 WHERE id = $2', [weeklyFee, req.userId]);
    } else {
      // 'both' — use commission first, then cash
      const fromComm = Math.min(commBal, weeklyFee);
      const fromCash = weeklyFee - fromComm;
      if (cashBal < fromCash) return res.status(400).json({ error: `Insufficient balance. Need $${weeklyFee.toFixed(2)} total` });
      if (fromComm > 0) await query('UPDATE users SET commission_earned = commission_earned - $1 WHERE id = $2', [fromComm, req.userId]);
      if (fromCash > 0) await query('UPDATE users SET cash_wallet = cash_wallet - $1 WHERE id = $2', [fromCash, req.userId]);
    }

    // Set next due date (7 days from now, or from current due date if not yet past)
    const now = new Date();
    const baseDate = u.weekly_fee_due && new Date(u.weekly_fee_due) > now ? new Date(u.weekly_fee_due) : now;
    const nextDue = new Date(baseDate);
    nextDue.setDate(nextDue.getDate() + 7);

    await query('UPDATE users SET weekly_fee_due = $1 WHERE id = $2', [nextDue, req.userId]);

    // Log transaction
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description)
       VALUES ($1, 'weekly_fee', $2, $3)`,
      [req.userId, -weeklyFee, `Weekly fee paid from ${source === 'both' ? 'commission+cash' : source} wallet`]
    );

    // Re-enable API keys if they were disabled due to expired fee
    await query(
      `UPDATE api_keys SET enabled = true
       WHERE user_id = $1 AND paused_by_admin = false`,
      [req.userId]
    );

    res.json({ ok: true, next_due: nextDue.toISOString(), message: `Weekly fee paid! Next due: ${nextDue.toISOString().slice(0, 10)}` });
  } catch (err) {
    console.error('Pay fee error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Top up cash wallet (submit proof) ───────────────────────
router.post('/topup', async (req, res) => {
  try {
    const { amount, tx_hash, proof_url } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });
    if (!tx_hash && !proof_url) return res.status(400).json({ error: 'Transaction hash or proof URL required' });

    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, tx_hash, status)
       VALUES ($1, 'topup_pending', $2, $3, $4, 'pending')`,
      [req.userId, amount, `Top-up request $${parseFloat(amount).toFixed(2)}`, tx_hash || proof_url || '']
    );

    res.json({ ok: true, message: 'Top-up submitted. Admin will approve and credit your wallet.' });
  } catch (err) {
    console.error('Top-up error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Transfer commission to cash wallet ──────────────────────
router.post('/transfer-commission', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });

    const user = await query('SELECT commission_earned FROM users WHERE id = $1', [req.userId]);
    const commBal = parseFloat(user[0]?.commission_earned) || 0;
    if (commBal < amount) return res.status(400).json({ error: `Insufficient commission. Have $${commBal.toFixed(2)}` });

    await query('UPDATE users SET commission_earned = commission_earned - $1, cash_wallet = cash_wallet + $1 WHERE id = $2', [amount, req.userId]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES ($1, 'commission_transfer', $2, 'Transferred commission to cash wallet')`,
      [req.amount, -amount]
    );
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES ($1, 'topup', $2, 'Received from commission')`,
      [req.userId, amount]
    );

    res.json({ ok: true, message: `$${amount.toFixed(2)} moved from commission to cash wallet.` });
  } catch (err) {
    console.error('Transfer error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Save USDT withdrawal address ────────────────────────────
router.post('/usdt-address', async (req, res) => {
  try {
    const { address, network } = req.body;
    if (!address) return res.status(400).json({ error: 'USDT address required' });
    const net = (network || 'BEP20').toUpperCase();
    if (!['BEP20', 'ERC20', 'TRC20', 'POLYGON'].includes(net)) {
      return res.status(400).json({ error: 'Supported networks: BEP20, ERC20, TRC20, POLYGON' });
    }
    await query('UPDATE users SET usdt_address = $1, usdt_network = $2 WHERE id = $3', [address.trim(), net, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('USDT address error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Withdraw commission as USDT ─────────────────────────────
router.post('/withdraw', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 10) return res.status(400).json({ error: 'Minimum withdrawal is $10 USDT' });

    const user = await query('SELECT commission_earned, usdt_address, usdt_network FROM users WHERE id = $1', [req.userId]);
    if (!user.length) return res.status(404).json({ error: 'User not found' });

    const u = user[0];
    if (!u.usdt_address) return res.status(400).json({ error: 'Set your USDT withdrawal address first' });

    // Atomic deduct — prevents double-spend race condition
    const deducted = await query(
      'UPDATE users SET commission_earned = commission_earned - $1 WHERE id = $2 AND commission_earned >= $1 RETURNING commission_earned',
      [amount, req.userId]
    );
    if (!deducted.length) {
      const commBal = parseFloat(u.commission_earned) || 0;
      return res.status(400).json({ error: `Insufficient commission. Have $${commBal.toFixed(2)}` });
    }

    // Create withdrawal request
    await query(
      `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.userId, amount, `USDT (${u.usdt_network})`, u.usdt_address, 'Crypto Withdrawal']
    );

    // Log transaction
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description)
       VALUES ($1, 'withdrawal', $2, $3)`,
      [req.userId, -amount, `USDT withdrawal to ${u.usdt_address.slice(0, 8)}...${u.usdt_address.slice(-6)} (${u.usdt_network})`]
    );

    res.json({ ok: true, message: 'Withdrawal submitted. Admin will process USDT transfer.' });
  } catch (err) {
    console.error('Withdrawal error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Transaction history ─────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Transactions error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Withdrawal history ──────────────────────────────────────
router.get('/withdrawals', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Withdrawals error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Referral info ───────────────────────────────────────────
router.get('/referral', async (req, res) => {
  try {
    const user = await query('SELECT referral_code FROM users WHERE id = $1', [req.userId]);
    const referrals = await query(
      `SELECT u.email, u.created_at, u.cash_wallet, u.commission_earned
       FROM users u WHERE u.referred_by = $1 ORDER BY u.created_at DESC`,
      [req.userId]
    );
    const totalComm = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions
       WHERE user_id = $1 AND type = 'commission'`, [req.userId]
    );
    res.json({
      referral_code: user[0]?.referral_code || '',
      referrals,
      total_commission: parseFloat(totalComm[0]?.total || 0),
    });
  } catch (err) {
    console.error('Referral info error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
