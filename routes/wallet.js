const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { BitunixClient } = require('../bitunix-client');

const router = express.Router();

// ── Deposit verification helpers ─────────────────────────────────────────────

// Lazy-init admin Bitunix client (uses admin API key from env / DB)
let _adminClient = null;
async function getAdminBitunixClient() {
  if (_adminClient) return _adminClient;
  // Try env first, then pull the first admin API key from DB
  const apiKey    = process.env.ADMIN_BITUNIX_API_KEY;
  const apiSecret = process.env.ADMIN_BITUNIX_API_SECRET;
  if (apiKey && apiSecret) {
    _adminClient = new BitunixClient({ apiKey, apiSecret });
    return _adminClient;
  }
  // Fall back to DB: pick the api key for user_id=1
  const rows = await query(
    `SELECT api_key, api_secret FROM api_keys WHERE user_id = 1 AND platform = 'bitunix' LIMIT 1`
  );
  if (!rows.length) throw new Error('No admin Bitunix API key configured');
  _adminClient = new BitunixClient({ apiKey: rows[0].api_key, apiSecret: rows[0].api_secret });
  return _adminClient;
}

// Refresh admin client if env vars change (call after env update)
function resetAdminClient() { _adminClient = null; }
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

// ── DEPOSIT SYSTEM — Auto-detect via Bitunix API ─────────────────────────
//
//  Flow:
//    1. User enters amount → clicks "I've Sent" → POST /deposit/submit
//    2. Server records pending request with amount + timestamp
//    3. Background poller (every 30s) calls Bitunix deposit history API
//    4. Matches new deposits by amount ± $0.01 that arrived AFTER request time
//    5. On match → auto-credits user wallet, marks request verified
//    6. Frontend polls GET /deposit/status/:id every 5s to show live status
//
//  No txHash needed from the user at all.
// ─────────────────────────────────────────────────────────────────────────

// Amount match tolerance: ±$0.01 covers minor network rounding
const AMOUNT_TOLERANCE = 0.02;

// How long to keep polling before giving up (30 minutes)
const DEPOSIT_TIMEOUT_MS = 30 * 60 * 1000;

// ── GET /api/wallet/deposit/address ──────────────────────────────────────
// Returns your Bitunix deposit address so user knows where to send
router.get('/deposit/address', async (req, res) => {
  try {
    const address = process.env.ADMIN_DEPOSIT_ADDRESS || '';
    const network = process.env.ADMIN_DEPOSIT_NETWORK || 'TRC20';
    const coin    = process.env.ADMIN_DEPOSIT_COIN    || 'USDT';
    if (!address) {
      return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Deposit address not configured yet — contact admin' } });
    }
    res.json({ address, network, coin });
  } catch (err) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/wallet/deposit/submit ──────────────────────────────────────
// User clicks "I've Sent" — just needs amount, no txHash
// Body: { amount: number, network?: string }
router.post('/deposit/submit', async (req, res) => {
  try {
    const { amount, network } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !Number.isFinite(amt)) {
      return res.status(400).json({ error: { code: 'INVALID_AMOUNT', message: 'Enter a valid amount' } });
    }
    if (amt < 1) {
      return res.status(400).json({ error: { code: 'TOO_SMALL', message: 'Minimum deposit is $1 USDT' } });
    }

    // Block if user already has a pending deposit (prevent duplicate confusion)
    const active = await query(
      `SELECT id FROM deposit_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
      [req.userId]
    );
    if (active.length) {
      return res.status(409).json({
        error: { code: 'PENDING_EXISTS', message: 'You already have a pending deposit being verified. Please wait.' },
        deposit_id: active[0].id,
      });
    }

    const rows = await query(
      `INSERT INTO deposit_requests (user_id, amount, tx_hash, network, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
       RETURNING id, created_at`,
      [req.userId, amt, null, (network || process.env.ADMIN_DEPOSIT_NETWORK || 'TRC20').toUpperCase()]
    );

    const depositId = rows[0].id;
    console.log(`[Deposit] New request id=${depositId} user=${req.userId} amount=${amt}`);

    // Kick off immediate check in background
    checkDepositByAmount(depositId, req.userId, amt, rows[0].created_at).catch(() => {});

    res.json({
      success: true,
      deposit_id: depositId,
      status: 'pending',
      message: 'Watching for your deposit — this page will update automatically.',
    });
  } catch (err) {
    console.error('[Deposit submit]', err.message);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /api/wallet/deposit/status/:id ───────────────────────────────────
// Frontend polls this every 5s to get live status
router.get('/deposit/status/:id', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, amount, tx_hash, network, status, verified_at, created_at, note
       FROM deposit_requests WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Deposit not found' } });

    const dep = rows[0];
    // If still pending and not timed out, trigger a fresh Bitunix check
    const age = Date.now() - new Date(dep.created_at).getTime();
    if (dep.status === 'pending' && age < DEPOSIT_TIMEOUT_MS) {
      checkDepositByAmount(dep.id, dep.user_id, parseFloat(dep.amount), dep.created_at).catch(() => {});
    } else if (dep.status === 'pending' && age >= DEPOSIT_TIMEOUT_MS) {
      // Timed out — mark expired so user knows to contact admin
      await query(
        `UPDATE deposit_requests SET status = 'expired', note = 'No matching deposit found within 30 minutes — contact admin', updated_at = NOW() WHERE id = $1`,
        [dep.id]
      );
      dep.status = 'expired';
      dep.note = 'No matching deposit found within 30 minutes — contact admin';
    }

    res.json(dep);
  } catch (err) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /api/wallet/deposit/history ──────────────────────────────────────
router.get('/deposit/history', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, amount, tx_hash, network, status, verified_at, created_at, note
       FROM deposit_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── Core: match a Bitunix deposit by amount + time ────────────────────────
async function checkDepositByAmount(depositId, userId, expectedAmount, requestedAt) {
  try {
    const client = await getAdminBitunixClient();

    // Fetch recent 50 deposits from Bitunix
    const list = await client.getDepositHistory({ coin: 'USDT', pageSize: 50 });
    if (!Array.isArray(list) || !list.length) return;

    const requestTs = new Date(requestedAt).getTime();

    // Find a deposit that:
    //   (a) arrived at or after the request was submitted
    //   (b) amount matches within tolerance
    //   (c) not already used by another deposit_request
    const usedTxHashes = await query(
      `SELECT tx_hash FROM deposit_requests WHERE status = 'verified' AND tx_hash IS NOT NULL`
    );
    const usedSet = new Set(usedTxHashes.map(r => r.tx_hash));

    const match = list.find(d => {
      // Parse Bitunix deposit fields (API uses different key names per version)
      const depAmt    = parseFloat(d.amount || d.qty || d.quantity || 0);
      const depTime   = parseInt(d.createTime || d.time || d.timestamp || d.created_at || 0);
      const depStatus = parseInt(d.status ?? d.state ?? 1); // 1 = completed
      const txHash    = (d.txId || d.txHash || d.hash || d.transactionId || '').toLowerCase();

      if (depStatus !== 1) return false;                        // not completed yet
      if (depTime && depTime < requestTs - 60_000) return false; // arrived before request (60s buffer for clock drift)
      if (usedSet.has(txHash)) return false;                    // already credited elsewhere
      if (Math.abs(depAmt - expectedAmount) > AMOUNT_TOLERANCE) return false; // wrong amount

      return true;
    });

    if (!match) return; // not arrived yet — poller will retry

    const actualAmount = parseFloat(match.amount || match.qty || match.quantity || expectedAmount);
    const txHash = (match.txId || match.txHash || match.hash || match.transactionId || '').toLowerCase() || null;

    // Credit user wallet
    await query('BEGIN');
    try {
      await query(
        `UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2`,
        [actualAmount, userId]
      );
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
         VALUES ($1, 'deposit', $2, $3, 'completed')`,
        [userId, actualAmount, `USDT deposit auto-verified via Bitunix${txHash ? ` — tx: ${txHash}` : ''}`]
      );
      await query(
        `UPDATE deposit_requests
         SET status = 'verified', verified_at = NOW(), tx_hash = $1,
             amount = $2, note = 'Auto-detected via Bitunix deposit API', updated_at = NOW()
         WHERE id = $3`,
        [txHash, actualAmount, depositId]
      );
      await query('COMMIT');
      console.log(`[Deposit] ✓ user=${userId} amount=${actualAmount} USDT credited${txHash ? ` tx=${txHash}` : ''}`);
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error(`[Deposit check] depositId=${depositId}`, err.message);
    await query(
      `UPDATE deposit_requests SET note = $1, updated_at = NOW() WHERE id = $2`,
      [err.message.substring(0, 200), depositId]
    ).catch(() => {});
  }
}

// ── Background poller — runs every 30s, checks all pending deposits ───────
// Exported so server.js / entry.js can start it after DB is ready
function startDepositPoller() {
  setInterval(async () => {
    try {
      const pending = await query(
        `SELECT id, user_id, amount, created_at FROM deposit_requests
         WHERE status = 'pending'
           AND created_at > NOW() - INTERVAL '31 minutes'
         ORDER BY created_at ASC`
      );
      for (const dep of pending) {
        await checkDepositByAmount(dep.id, dep.user_id, parseFloat(dep.amount), dep.created_at);
      }
    } catch (err) {
      console.error('[Deposit poller]', err.message);
    }
  }, 30_000);
  console.log('[Deposit] Background poller started — checking every 30s');
}

// ── Admin: list deposits by status ────────────────────────────────────────
router.get('/admin/deposits', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin only' } });

    const { status = 'pending' } = req.query;
    const rows = await query(
      `SELECT dr.*, u.email FROM deposit_requests dr
       JOIN users u ON u.id = dr.user_id
       WHERE dr.status = $1 ORDER BY dr.created_at DESC LIMIT 100`,
      [status]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── Admin: manually approve a deposit ────────────────────────────────────
router.post('/admin/deposits/:id/approve', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin only' } });

    const rows = await query(
      `SELECT * FROM deposit_requests WHERE id = $1 AND status != 'verified'`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Deposit not found or already verified' } });
    const dep = rows[0];

    await query('BEGIN');
    await query(`UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2`, [dep.amount, dep.user_id]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status) VALUES ($1, 'deposit', $2, $3, 'completed')`,
      [dep.user_id, dep.amount, `USDT deposit — manually approved by admin`]
    );
    await query(
      `UPDATE deposit_requests SET status = 'verified', verified_at = NOW(), note = 'Manually approved by admin', updated_at = NOW() WHERE id = $1`,
      [dep.id]
    );
    await query('COMMIT');

    res.json({ success: true });
  } catch (err) {
    await query('ROLLBACK');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
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
module.exports.startDepositPoller = startDepositPoller;
