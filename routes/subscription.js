const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ── Get wallet status ────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const user = await query(
      `SELECT cash_wallet, commission_earned, usdt_address, usdt_network, referral_code
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!user.length) return res.status(404).json({ error: 'User not found' });
    const u = user[0];

    const referralCount = await query(
      'SELECT COUNT(*) as cnt FROM users WHERE referred_by = $1', [req.userId]
    );

    // Get platform USDT address for display
    const platformAddrRow = await query("SELECT value FROM settings WHERE key = 'platform_usdt_address'").catch(() => []);
    const platformNetRow = await query("SELECT value FROM settings WHERE key = 'platform_usdt_network'").catch(() => []);

    const cashWallet = (parseFloat(u.cash_wallet) || 0) + (parseFloat(u.commission_earned) || 0);
    res.json({
      cash_wallet: cashWallet,
      commission_earned: parseFloat(u.commission_earned) || 0,
      total_balance: cashWallet,
      usdt_address: u.usdt_address || '',
      usdt_network: u.usdt_network || 'BEP20',
      referral_code: u.referral_code || '',
      referral_count: parseInt(referralCount[0]?.cnt || 0),
      platform_usdt_address: platformAddrRow[0]?.value || '',
      platform_usdt_network: platformNetRow[0]?.value || 'BEP20',
    });
  } catch (err) {
    console.error('Wallet status error:', err.message);
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

// Transfer commission endpoint removed — commission auto-added to cash wallet

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

// ── Withdraw from cash wallet as USDT ───────────────────────
router.post('/withdraw', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 10) return res.status(400).json({ error: 'Minimum withdrawal is $10 USDT' });

    const user = await query('SELECT cash_wallet, usdt_address, usdt_network FROM users WHERE id = $1', [req.userId]);
    if (!user.length) return res.status(404).json({ error: 'User not found' });

    const u = user[0];
    if (!u.usdt_address) return res.status(400).json({ error: 'Set your USDT withdrawal address first' });

    // Atomic deduct from cash_wallet
    const deducted = await query(
      'UPDATE users SET cash_wallet = cash_wallet - $1 WHERE id = $2 AND cash_wallet >= $1 RETURNING cash_wallet',
      [amount, req.userId]
    );
    if (!deducted.length) {
      const bal = parseFloat(u.cash_wallet) || 0;
      return res.status(400).json({ error: `Insufficient balance. Have $${bal.toFixed(2)}` });
    }

    await query(
      `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.userId, amount, `USDT (${u.usdt_network})`, u.usdt_address, 'Crypto Withdrawal']
    );

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
