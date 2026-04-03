const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Get wallet balance + referral info
router.get('/balance', async (req, res) => {
  try {
    const user = await query(
      'SELECT cash_wallet, commission_earned, referral_code, usdt_address, usdt_network FROM users WHERE id = $1',
      [req.userId]
    );

    const referralCount = await query(
      'SELECT COUNT(*) as cnt FROM users WHERE referred_by = $1', [req.userId]
    );

    const totalCommission = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions
       WHERE user_id = $1 AND type = 'commission'`, [req.userId]
    );

    res.json({
      cash_wallet: parseFloat(user[0]?.cash_wallet || 0),
      commission_earned: parseFloat(user[0]?.commission_earned || 0),
      total_balance: (parseFloat(user[0]?.cash_wallet || 0)) + (parseFloat(user[0]?.commission_earned || 0)),
      referral_code: user[0]?.referral_code || '',
      referral_count: parseInt(referralCount[0]?.cnt || 0),
      total_commission: parseFloat(totalCommission[0]?.total || 0),
      usdt_address: user[0]?.usdt_address || '',
      usdt_network: user[0]?.usdt_network || 'BEP20',
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
      `SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Wallet txns error:', err.message);
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
