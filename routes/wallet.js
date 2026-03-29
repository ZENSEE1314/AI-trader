const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Get wallet balance + referral info
router.get('/balance', async (req, res) => {
  try {
    const user = await query(
      'SELECT wallet_balance, referral_code FROM users WHERE id = $1', [req.userId]
    );

    const referralCount = await query(
      'SELECT COUNT(*) as cnt FROM users WHERE referred_by = $1', [req.userId]
    );

    const totalCommission = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions
       WHERE user_id = $1 AND type = 'commission'`, [req.userId]
    );

    res.json({
      balance: parseFloat(user[0]?.wallet_balance || 0),
      referral_code: user[0]?.referral_code || '',
      referral_count: parseInt(referralCount[0]?.cnt || 0),
      total_commission: parseFloat(totalCommission[0]?.total || 0),
    });
  } catch (err) {
    console.error('Wallet balance error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Transaction history
router.get('/transactions', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Wallet txns error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Request withdrawal
router.post('/withdraw', async (req, res) => {
  try {
    const { amount, bank_name, account_number, account_name } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Minimum withdrawal is $1' });
    if (!bank_name || !account_number || !account_name) {
      return res.status(400).json({ error: 'Bank details required' });
    }

    const user = await query('SELECT wallet_balance FROM users WHERE id = $1', [req.userId]);
    const balance = parseFloat(user[0]?.wallet_balance || 0);
    if (balance < amount) {
      return res.status(400).json({ error: `Insufficient balance. Have $${balance.toFixed(2)}` });
    }

    // Deduct from wallet
    await query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amount, req.userId]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES ($1, 'withdrawal', $2, $3)`,
      [req.userId, -amount, `Withdrawal to ${bank_name} ${account_number}`]
    );

    // Create withdrawal request
    await query(
      `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.userId, amount, bank_name, account_number, account_name]
    );

    res.json({ ok: true, message: 'Withdrawal submitted. Admin will process it.' });
  } catch (err) {
    console.error('Withdrawal error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Withdrawal history
router.get('/withdrawals', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Withdrawals list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
