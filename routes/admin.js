const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Admin check middleware
async function adminOnly(req, res, next) {
  const rows = await query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
  if (!rows.length || !rows[0].is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}
router.use(adminOnly);

// Weekly earnings overview for admin (all users)
router.get('/weekly-earnings', async (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    // Get all users with their profit share settings and weekly performance
    const users = await query(
      `SELECT u.id, u.email,
              ak.id as key_id, ak.label as key_label, ak.platform,
              ak.profit_share_user_pct, ak.profit_share_admin_pct,
              ak.paused_by_admin, ak.enabled
       FROM users u
       LEFT JOIN api_keys ak ON ak.user_id = u.id
       WHERE u.is_admin = false
       ORDER BY u.email, ak.id`
    );

    // Get this week's trades for all users
    const trades = await query(
      `SELECT t.user_id, t.api_key_id, t.pnl_usdt, t.status, t.symbol
       FROM trades t
       WHERE t.status IN ('WIN', 'LOSS', 'TP', 'SL', 'CLOSED')
         AND t.closed_at >= $1 AND t.closed_at <= $2`,
      [monday, sunday]
    );

    // Build per-user/per-key summary
    const result = [];
    let grandTotalWinning = 0;
    let grandTotalUserShare = 0;
    let grandTotalAdminShare = 0;

    const userMap = {};
    for (const u of users) {
      if (!userMap[u.id]) {
        userMap[u.id] = {
          user_id: u.id,
          email: u.email,
          keys: [],
          total_winning_pnl: 0,
          total_user_share: 0,
          total_admin_share: 0,
          total_trades: 0,
          total_wins: 0,
        };
      }
      if (u.key_id) {
        const keyTrades = trades.filter(t => t.api_key_id === u.key_id);
        const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
        const winningPnl = wins.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
        const userPct = parseFloat(u.profit_share_user_pct) || 60;
        const adminPct = parseFloat(u.profit_share_admin_pct) || 40;

        const keyData = {
          key_id: u.key_id,
          label: u.key_label || u.platform,
          platform: u.platform,
          paused: u.paused_by_admin || false,
          enabled: u.enabled !== false,
          total_trades: keyTrades.length,
          win_count: wins.length,
          winning_pnl: winningPnl,
          user_share_pct: userPct,
          admin_share_pct: adminPct,
          user_share: Math.max(0, winningPnl * userPct / 100),
          admin_share: Math.max(0, winningPnl * adminPct / 100),
        };

        userMap[u.id].keys.push(keyData);
        userMap[u.id].total_winning_pnl += winningPnl;
        userMap[u.id].total_user_share += keyData.user_share;
        userMap[u.id].total_admin_share += keyData.admin_share;
        userMap[u.id].total_trades += keyTrades.length;
        userMap[u.id].total_wins += wins.length;
      }
    }

    for (const u of Object.values(userMap)) {
      grandTotalWinning += u.total_winning_pnl;
      grandTotalUserShare += u.total_user_share;
      grandTotalAdminShare += u.total_admin_share;
    }

    res.json({
      week_start: monday.toISOString(),
      week_end: sunday.toISOString(),
      grand_total_winning: grandTotalWinning,
      grand_total_user_share: grandTotalUserShare,
      grand_total_admin_share: grandTotalAdminShare,
      users: Object.values(userMap),
    });
  } catch (err) {
    console.error('Admin weekly earnings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update profit share for a specific API key
router.put('/keys/:id/profit-share', async (req, res) => {
  try {
    const { user_pct, admin_pct } = req.body;
    if (user_pct === undefined || admin_pct === undefined) {
      return res.status(400).json({ error: 'user_pct and admin_pct required' });
    }
    const up = parseFloat(user_pct);
    const ap = parseFloat(admin_pct);
    if (isNaN(up) || isNaN(ap) || up < 0 || ap < 0 || up + ap !== 100) {
      return res.status(400).json({ error: 'Percentages must be >= 0 and sum to 100' });
    }
    await query(
      `UPDATE api_keys SET profit_share_user_pct = $1, profit_share_admin_pct = $2 WHERE id = $3`,
      [up, ap, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Profit share update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pause/resume an API key
router.put('/keys/:id/pause', async (req, res) => {
  try {
    const { paused } = req.body;
    await query(
      `UPDATE api_keys SET paused_by_admin = $1 WHERE id = $2`,
      [!!paused, req.params.id]
    );
    // If pausing, also disable so the bot skips it
    if (paused) {
      await query(`UPDATE api_keys SET enabled = false WHERE id = $1`, [req.params.id]);
    }
    res.json({ ok: true, paused: !!paused });
  } catch (err) {
    console.error('Pause key error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Resume an API key (re-enable)
router.put('/keys/:id/resume', async (req, res) => {
  try {
    await query(
      `UPDATE api_keys SET paused_by_admin = false, enabled = true WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true, paused: false });
  } catch (err) {
    console.error('Resume key error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all users
router.get('/users', async (req, res) => {
  try {
    const rows = await query(
      `SELECT u.id, u.email, u.is_blocked, u.is_admin, u.approved_no_sub,
              u.referral_code, u.wallet_balance, u.cash_wallet, u.commission_earned,
              u.weekly_fee_amount, u.weekly_fee_due, u.usdt_address, u.usdt_network,
              u.created_at,
              (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count,
              (SELECT email FROM users WHERE id = u.referred_by) as referred_by_email
       FROM users u ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin users error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/revoke user to trade without subscription
router.put('/users/:id/approve-no-sub', async (req, res) => {
  try {
    const { approved } = req.body;
    await query('UPDATE users SET approved_no_sub = $1 WHERE id = $2', [!!approved, req.params.id]);
    res.json({ ok: true, approved: !!approved });
  } catch (err) {
    console.error('Approve no-sub error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Block/unblock user
router.put('/users/:id/block', async (req, res) => {
  try {
    const { blocked } = req.body;
    await query('UPDATE users SET is_blocked = $1 WHERE id = $2', [!!blocked, req.params.id]);
    if (blocked) {
      await query('UPDATE api_keys SET enabled = false WHERE user_id = $1', [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Block user error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit user wallet balance
router.put('/users/:id/wallet', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (amount === undefined || amount === null) return res.status(400).json({ error: 'Amount required' });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) return res.status(400).json({ error: 'Invalid amount' });

    // Get current balance
    const user = await query('SELECT wallet_balance, email FROM users WHERE id = $1', [req.params.id]);
    if (!user.length) return res.status(404).json({ error: 'User not found' });

    const currentBalance = parseFloat(user[0].wallet_balance);
    const diff = parsedAmount - currentBalance;

    // Update balance
    await query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [parsedAmount, req.params.id]);

    // Log the adjustment
    if (diff !== 0) {
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description)
         VALUES ($1, 'admin_adjustment', $2, $3)`,
        [req.params.id, diff, reason || `Admin adjusted balance from $${currentBalance.toFixed(2)} to $${parsedAmount.toFixed(2)}`]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Admin wallet edit error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear all ERROR trades
router.delete('/trades/errors', async (req, res) => {
  try {
    const result = await query('DELETE FROM trades WHERE status = $1', ['ERROR']);
    res.json({ ok: true });
  } catch (err) {
    console.error('Clear errors error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// List pending subscriptions (bank transfer proofs to approve)
router.get('/subscriptions', async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.*, u.email FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin subs error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/reject subscription
router.put('/subscriptions/:id', async (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'
    const sub = await query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (!sub.length) return res.status(404).json({ error: 'Not found' });

    if (action === 'approve') {
      const userId = sub[0].user_id;
      // Extend by 30 days (stacks on existing time)
      const existing = await query(
        `SELECT id, expires_at FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
         ORDER BY expires_at DESC LIMIT 1`,
        [userId]
      );

      const now = new Date();
      let newExpiry;
      if (existing.length) {
        newExpiry = new Date(existing[0].expires_at);
        newExpiry.setDate(newExpiry.getDate() + 30);
        await query('UPDATE subscriptions SET expires_at = $1 WHERE id = $2', [newExpiry, existing[0].id]);
        // Mark this payment record as processed
        await query('UPDATE subscriptions SET status = $1 WHERE id = $2', ['processed', req.params.id]);
      } else {
        newExpiry = new Date(now);
        newExpiry.setDate(newExpiry.getDate() + 30);
        await query(
          `UPDATE subscriptions SET status = 'active', starts_at = $1, expires_at = $2 WHERE id = $3`,
          [now, newExpiry, req.params.id]
        );
      }

      // Pay referral commissions
      const settings = {};
      const rows = await query('SELECT key, value FROM settings');
      for (const r of rows) settings[r.key] = r.value;
      const commSettings = {
        price: parseFloat(settings.sub_price) || 29.99,
        tier1: parseFloat(settings.commission_tier1) || 0,
        tier2: parseFloat(settings.commission_tier2) || 0,
        tier3: parseFloat(settings.commission_tier3) || 0,
      };
      await payReferralCommission(userId, commSettings);
    } else {
      await query('UPDATE subscriptions SET status = $1 WHERE id = $2', ['rejected', req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin sub action error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3-tier referral commission (same logic as subscription.js)
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
      // Only pay if referrer has active subscription
      const activeSub = await query(
        `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW() LIMIT 1`,
        [referrerId]
      );
      if (!activeSub.length) { currentId = referrerId; continue; }
      const commission = settings.price * (pct / 100);
      await query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [commission, referrerId]);
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, ref_id) VALUES ($1, 'commission', $2, $3, $4)`,
        [referrerId, commission, `Tier ${tier + 1} commission from user #${userId} (${pct}%)`, userId]
      );
      currentId = referrerId;
    }
  } catch (err) { console.error('Referral commission error:', err.message); }
}

// List pending withdrawals
router.get('/withdrawals', async (req, res) => {
  try {
    const rows = await query(
      `SELECT w.*, u.email FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       ORDER BY w.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin withdrawals error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/reject withdrawal
router.put('/withdrawals/:id', async (req, res) => {
  try {
    const { action, admin_note } = req.body;
    const w = await query('SELECT * FROM withdrawals WHERE id = $1', [req.params.id]);
    if (!w.length) return res.status(404).json({ error: 'Not found' });
    if (w[0].status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      await query('UPDATE withdrawals SET status = $1, admin_note = $2 WHERE id = $3', ['approved', admin_note || '', req.params.id]);
    } else {
      // Refund to wallet
      await query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [w[0].amount, w[0].user_id]);
      await query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, ref_id) VALUES ($1, 'refund', $2, 'Withdrawal rejected', $3)`,
        [w[0].user_id, w[0].amount, w[0].id]
      );
      await query('UPDATE withdrawals SET status = $1, admin_note = $2 WHERE id = $3', ['rejected', admin_note || '', req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin withdrawal action error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Pending top-ups ──────────────────────────────────────────
router.get('/topups', async (req, res) => {
  try {
    const rows = await query(
      `SELECT w.*, u.email FROM wallet_transactions w
       JOIN users u ON u.id = w.user_id
       WHERE w.type = 'topup_pending'
       ORDER BY w.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin topups error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve/reject top-up
router.put('/topups/:id', async (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'
    const txn = await query('SELECT * FROM wallet_transactions WHERE id = $1', [req.params.id]);
    if (!txn.length) return res.status(404).json({ error: 'Not found' });
    if (txn[0].type !== 'topup_pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      const amount = parseFloat(txn[0].amount);
      await query('UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2', [amount, txn[0].user_id]);
      await query(
        `UPDATE wallet_transactions SET type = 'topup', status = 'approved', description = description || ' (approved)' WHERE id = $1`,
        [req.params.id]
      );
    } else {
      await query(
        `UPDATE wallet_transactions SET type = 'topup_rejected', status = 'rejected', description = description || ' (rejected)' WHERE id = $1`,
        [req.params.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin topup action error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Set weekly fee for a user ────────────────────────────────
router.put('/users/:id/weekly-fee', async (req, res) => {
  try {
    const { amount } = req.body;
    if (amount === undefined || amount < 0) return res.status(400).json({ error: 'Valid amount required' });
    await query('UPDATE users SET weekly_fee_amount = $1 WHERE id = $2', [parseFloat(amount), req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Set weekly fee error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Set weekly fee due date for a user ───────────────────────
router.put('/users/:id/fee-due', async (req, res) => {
  try {
    const { due_date } = req.body;
    await query('UPDATE users SET weekly_fee_due = $1 WHERE id = $2', [due_date, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Set fee due error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Users with unpaid fees ──────────────────────────────────
router.get('/unpaid-fees', async (req, res) => {
  try {
    const rows = await query(
      `SELECT u.id, u.email, u.cash_wallet, u.commission_earned,
              u.weekly_fee_amount, u.weekly_fee_due,
              (u.cash_wallet + u.commission_earned) as total_available,
              (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND enabled = true) as active_keys
       FROM users u
       WHERE u.is_admin = false
         AND u.weekly_fee_due IS NOT NULL
         AND u.weekly_fee_due < NOW()
       ORDER BY u.weekly_fee_due ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Unpaid fees error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get settings
router.get('/settings', async (req, res) => {
  try {
    const rows = await query('SELECT key, value FROM settings');
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (err) {
    console.error('Admin settings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update settings
router.put('/settings', async (req, res) => {
  try {
    const { referral_commission_pct, commission_tier1, commission_tier2, commission_tier3, min_topup } = req.body;

    const { platform_usdt_address, platform_usdt_network, bscscan_api_key } = req.body;

    const updates = [
      ['referral_commission_pct', referral_commission_pct],
      ['commission_tier1', commission_tier1],
      ['commission_tier2', commission_tier2],
      ['commission_tier3', commission_tier3],
      ['min_topup', min_topup],
      ['platform_usdt_address', platform_usdt_address],
      ['platform_usdt_network', platform_usdt_network],
      ['bscscan_api_key', bscscan_api_key],
    ];

    for (const [key, val] of updates) {
      if (val !== undefined && val !== null) {
        await query(
          `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
          [key, String(val)]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin update settings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Risk Level Management ───────────────────────────────────

router.get('/risk-levels', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM risk_levels ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error('Risk levels list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/risk-levels', async (req, res) => {
  try {
    const { name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const row = await query(
      `INSERT INTO risk_levels (name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, description || '', tp_pct || 0.01, sl_pct || 0.01, max_consec_loss || 2, top_n_coins || 50, capital_percentage || 10, max_leverage || 20]
    );
    res.json(row[0]);
  } catch (err) {
    console.error('Risk level create error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/risk-levels/:id', async (req, res) => {
  try {
    const { name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled } = req.body;
    await query(
      `UPDATE risk_levels SET name = COALESCE($1, name), description = COALESCE($2, description),
       tp_pct = COALESCE($3, tp_pct), sl_pct = COALESCE($4, sl_pct),
       max_consec_loss = COALESCE($5, max_consec_loss), top_n_coins = COALESCE($6, top_n_coins),
       capital_percentage = COALESCE($7, capital_percentage), max_leverage = COALESCE($8, max_leverage),
       enabled = COALESCE($9, enabled) WHERE id = $10`,
      [name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Risk level update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/risk-levels/:id', async (req, res) => {
  try {
    await query('UPDATE api_keys SET risk_level_id = NULL WHERE risk_level_id = $1', [req.params.id]);
    await query('DELETE FROM risk_levels WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Risk level delete error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Global Token Management ─────────────────────────────────

// List all global token settings
router.get('/global-tokens', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM global_token_settings ORDER BY symbol');
    res.json(rows);
  } catch (err) {
    console.error('Global tokens list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add or update global token setting
router.post('/global-tokens', async (req, res) => {
  try {
    const { symbol, enabled, banned } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });

    await query(
      `INSERT INTO global_token_settings (symbol, enabled, banned)
       VALUES ($1, $2, $3)
       ON CONFLICT (symbol) DO UPDATE SET enabled = EXCLUDED.enabled, banned = EXCLUDED.banned`,
      [symbol.toUpperCase(), enabled !== false, banned === true]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Global token add error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove global token setting
router.delete('/global-tokens/:symbol', async (req, res) => {
  try {
    await query('DELETE FROM global_token_settings WHERE symbol = $1', [req.params.symbol.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Global token delete error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── One-time fix: re-sync Bitunix trades with $0.00 PnL ────
router.post('/fix-bitunix-pnl', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');

    // Find all Bitunix trades with $0.00 PnL that are LOSS or OPEN
    const badTrades = await query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE ak.platform = 'bitunix'
         AND (t.pnl_usdt = 0 OR t.pnl_usdt IS NULL OR t.status = 'OPEN')
       ORDER BY t.created_at DESC
       LIMIT 50`
    );

    if (!badTrades.length) return res.json({ ok: true, fixed: 0, message: 'No trades to fix' });

    const results = [];
    for (const trade of badTrades) {
      try {
        const apiKey = cryptoUtils.decrypt(trade.api_key_enc, trade.iv, trade.auth_tag);
        const apiSecret = cryptoUtils.decrypt(trade.api_secret_enc, trade.secret_iv, trade.secret_auth_tag);
        const client = new BitunixClient({ apiKey, apiSecret });

        const entryPrice = parseFloat(trade.entry_price);
        let exitPrice = entryPrice;

        // Check if position is still open
        const account = await client.getAccountInformation();
        const openPos = (account.positions || []).find(p => p.symbol === trade.symbol);

        if (openPos) {
          // Still open — update live PnL
          const livePnl = parseFloat(openPos.unrealizedProfit || 0);
          await query('UPDATE trades SET pnl_usdt = $1 WHERE id = $2', [livePnl, trade.id]);
          results.push({ id: trade.id, symbol: trade.symbol, status: 'STILL_OPEN', pnl: livePnl });
          continue;
        }

        // Position closed — try to get fill price
        try {
          const histTrades = await client.getHistoryTrades({ symbol: trade.symbol, pageSize: 10 });
          const tradeList = Array.isArray(histTrades) ? histTrades : (histTrades?.orderList || []);
          if (tradeList.length > 0) {
            exitPrice = parseFloat(tradeList[0].price || tradeList[0].avgPrice || entryPrice);
          }
        } catch {
          try {
            const priceData = await client.getMarketPrice(trade.symbol);
            exitPrice = parseFloat(priceData?.lastPrice || priceData?.price || entryPrice);
          } catch { /* keep entryPrice */ }
        }

        const isLong = trade.direction !== 'SHORT';
        const pnlPct = isLong
          ? (exitPrice - entryPrice) / entryPrice * 100
          : (entryPrice - exitPrice) / entryPrice * 100;
        const qty = parseFloat(trade.quantity || 1);
        const pnlUsdt = parseFloat((pnlPct * qty * entryPrice / 100).toFixed(4));
        const status = pnlPct > 0 ? 'WIN' : 'LOSS';

        await query(
          `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3, closed_at = COALESCE(closed_at, NOW())
           WHERE id = $4`,
          [status, pnlUsdt, exitPrice, trade.id]
        );

        // Record profit split for winning trades
        if (pnlUsdt > 0) {
          const { query: dbQuery } = require('../db');
          const keyRows = await dbQuery(
            'SELECT profit_share_user_pct, profit_share_admin_pct FROM api_keys WHERE id = $1',
            [trade.api_key_id]
          );
          const userPct = keyRows.length > 0 ? (parseFloat(keyRows[0].profit_share_user_pct) || 60) : 60;
          const userShare = pnlUsdt * userPct / 100;
          await dbQuery('UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2', [userShare, trade.user_id]);
        }

        results.push({ id: trade.id, symbol: trade.symbol, status, pnl: pnlUsdt, exitPrice });
      } catch (err) {
        results.push({ id: trade.id, symbol: trade.symbol, error: err.message });
      }
    }

    res.json({ ok: true, fixed: results.length, results });
  } catch (err) {
    console.error('Fix Bitunix PnL error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
