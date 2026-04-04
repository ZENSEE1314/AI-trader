const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Get wallet balance + referral info
router.get('/balance', async (req, res) => {
  try {
    const user = await query(
      'SELECT cash_wallet, commission_earned, referral_code, usdt_address, usdt_network, referral_tier, total_referral_commission FROM users WHERE id = $1',
      [req.userId]
    );

    const referralCount = await query(
      'SELECT COUNT(*) as cnt FROM users WHERE referred_by = $1', [req.userId]
    );

    const totalCommission = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions
       WHERE user_id = $1 AND type = 'commission'`, [req.userId]
    );

    // Get referral commission by tier
    const tierCommissions = await query(
      `SELECT level, COALESCE(SUM(amount), 0) as total
       FROM referral_commissions
       WHERE referrer_id = $1
       GROUP BY level
       ORDER BY level`, [req.userId]
    );

    // Get downline users with their tiers
    const downline = await query(
      `SELECT u.id, u.email, u.created_at, rc.level, rc.amount, rc.created_at as commission_date
       FROM users u
       LEFT JOIN referral_commissions rc ON rc.referee_id = u.id AND rc.referrer_id = $1
       WHERE u.referred_by = $1
       ORDER BY u.created_at DESC`, [req.userId]
    );

    res.json({
      cash_wallet: parseFloat(user[0]?.cash_wallet || 0),
      commission_earned: parseFloat(user[0]?.commission_earned || 0),
      total_balance: (parseFloat(user[0]?.cash_wallet || 0)) + (parseFloat(user[0]?.commission_earned || 0)),
      referral_code: user[0]?.referral_code || '',
      referral_count: parseInt(referralCount[0]?.cnt || 0),
      total_commission: parseFloat(totalCommission[0]?.total || 0),
      total_referral_commission: parseFloat(user[0]?.total_referral_commission || 0),
      referral_tier: parseInt(user[0]?.referral_tier || 1),
      usdt_address: user[0]?.usdt_address || '',
      usdt_network: user[0]?.usdt_network || 'BEP20',
      tier_commissions: tierCommissions,
      downline: downline
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

// Top-up wallet (simulate payment)
router.post('/topup', async (req, res) => {
  try {
    const { amount, method } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Start transaction
    await query('BEGIN');

    // Add to user's cash wallet
    await query(
      'UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2',
      [amount, req.userId]
    );

    // Record transaction
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'topup', $2, $3, 'completed')`,
      [req.userId, amount, `Top-up via ${method || 'manual'}`]
    );

    await query('COMMIT');

    // Get updated balance
    const user = await query(
      'SELECT cash_wallet FROM users WHERE id = $1', [req.userId]
    );

    res.json({
      success: true,
      new_balance: parseFloat(user[0]?.cash_wallet || 0),
      transaction_amount: amount
    });
  } catch (err) {
    await query('ROLLBACK');
    console.error('Top-up error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get commission breakdown
router.get('/commission/breakdown', async (req, res) => {
  try {
    const { period = 'all' } = req.query;
    let dateFilter = '';
    
    if (period === '7d') {
      dateFilter = "AND created_at > NOW() - INTERVAL '7 days'";
    } else if (period === '30d') {
      dateFilter = "AND created_at > NOW() - INTERVAL '30 days'";
    } else if (period === '90d') {
      dateFilter = "AND created_at > NOW() - INTERVAL '90 days'";
    }

    // Get commission by source
    const bySource = await query(
      `SELECT 
        CASE 
          WHEN description LIKE '%referral%' THEN 'referral'
          WHEN description LIKE '%tier%' THEN 'tier_bonus'
          ELSE 'other'
        END as source,
        COALESCE(SUM(amount), 0) as total,
        COUNT(*) as count
       FROM wallet_transactions
       WHERE user_id = $1 AND type = 'commission' ${dateFilter}
       GROUP BY source
       ORDER BY total DESC`,
      [req.userId]
    );

    // Get commission by date (last 30 days)
    const byDate = await query(
      `SELECT 
        DATE(created_at) as date,
        COALESCE(SUM(amount), 0) as total,
        COUNT(*) as count
       FROM wallet_transactions
       WHERE user_id = $1 AND type = 'commission' 
         AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [req.userId]
    );

    // Get top referral earners
    const topReferrals = await query(
      `SELECT 
        rc.referee_id,
        u.email,
        COUNT(rc.id) as transactions,
        COALESCE(SUM(rc.amount), 0) as total_commission
       FROM referral_commissions rc
       JOIN users u ON u.id = rc.referee_id
       WHERE rc.referrer_id = $1 ${dateFilter.replace('created_at', 'rc.created_at')}
       GROUP BY rc.referee_id, u.email
       ORDER BY total_commission DESC
       LIMIT 10`,
      [req.userId]
    );

    res.json({
      by_source: bySource,
      by_date: byDate,
      top_referrals: topReferrals
    });
  } catch (err) {
    console.error('Commission breakdown error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper: check if user is admin
async function isAdmin(userId) {
  try {
    const rows = await query('SELECT is_admin FROM users WHERE id = $1', [userId]);
    return rows.length > 0 && rows[0].is_admin === true;
  } catch { return false; }
}

// Admin: Add commission to user (for manual adjustments)
router.post('/admin/add-commission', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const { user_id, amount, description } = req.body;
    
    if (!user_id || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid user_id or amount' });
    }

    await query('BEGIN');

    // Add to user's commission
    await query(
      'UPDATE users SET commission_earned = commission_earned + $1 WHERE id = $2',
      [amount, user_id]
    );

    // Record transaction
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'commission', $2, $3, 'completed')`,
      [user_id, amount, description || 'Manual commission adjustment by admin']
    );

    await query('COMMIT');

    res.json({ success: true });
  } catch (err) {
    await query('ROLLBACK');
    console.error('Admin add commission error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
