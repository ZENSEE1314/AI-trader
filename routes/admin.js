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

// ── Force re-sync all trades with exchange data ────
router.post('/fix-bitunix-pnl', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');
    const { USDMClient } = require('binance');
    const getBinanceRequestOptions = () => {
      const PROXY_URL = process.env.QUOTAGUARDSTATIC_URL;
      if (!PROXY_URL) return {};
      const { HttpsProxyAgent } = require('https-proxy-agent');
      return { requestOptions: { agent: new HttpsProxyAgent(PROXY_URL) } };
    };

    // Find all trades that need syncing (OPEN, $0 PnL, or NULL exit)
    const badTrades = await query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE t.status = 'OPEN'
          OR (t.pnl_usdt = 0 AND t.exit_price IS NOT NULL)
          OR t.pnl_usdt IS NULL
       ORDER BY t.created_at DESC
       LIMIT 100`
    );

    if (!badTrades.length) return res.json({ ok: true, fixed: 0, message: 'No trades to fix' });

    const results = [];
    for (const trade of badTrades) {
      try {
        const apiKey = cryptoUtils.decrypt(trade.api_key_enc, trade.iv, trade.auth_tag);
        const apiSecret = cryptoUtils.decrypt(trade.api_secret_enc, trade.secret_iv, trade.secret_auth_tag);

        const entryPrice = parseFloat(trade.entry_price);
        const qty = parseFloat(trade.quantity || 0);
        const isLong = trade.direction !== 'SHORT';
        let exitPrice = entryPrice;
        let realizedPnl = null;
        let isStillOpen = false;

        if (trade.platform === 'binance') {
          const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
          const account = await client.getAccountInformation({ omitZeroBalances: false });
          const openPos = account.positions.find(p => p.symbol === trade.symbol && parseFloat(p.positionAmt) !== 0);

          if (openPos) {
            const livePnl = parseFloat(openPos.unrealizedProfit || 0);
            await query('UPDATE trades SET pnl_usdt = $1 WHERE id = $2', [livePnl, trade.id]);
            results.push({ id: trade.id, symbol: trade.symbol, status: 'STILL_OPEN', pnl: livePnl });
            continue;
          }

          // Closed — get fill data
          try {
            const openTime = trade.created_at ? new Date(trade.created_at).getTime() : Date.now() - 7 * 86400000;
            const fills = await client.getAccountTradeList({ symbol: trade.symbol, startTime: openTime, limit: 50 });
            const closeSide = isLong ? 'SELL' : 'BUY';
            const closeFills = (fills || []).filter(f => f.side === closeSide);
            if (closeFills.length > 0) {
              let totalQty = 0, totalValue = 0, totalPnl = 0;
              for (const f of closeFills) {
                const fQty = parseFloat(f.qty);
                totalQty += fQty;
                totalValue += fQty * parseFloat(f.price);
                totalPnl += parseFloat(f.realizedPnl || 0);
              }
              if (totalQty > 0) exitPrice = totalValue / totalQty;
              if (totalPnl !== 0) realizedPnl = totalPnl;
            }
          } catch {
            try {
              const ticker = await client.getSymbolPriceTicker({ symbol: trade.symbol });
              exitPrice = parseFloat(ticker.price);
            } catch { /* keep entryPrice */ }
          }
        } else if (trade.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey, apiSecret });
          const account = await client.getAccountInformation();
          const openPos = (account.positions || []).find(p => p.symbol === trade.symbol);

          if (openPos) {
            const livePnl = parseFloat(openPos.unrealizedProfit || 0);
            await query('UPDATE trades SET pnl_usdt = $1 WHERE id = $2', [livePnl, trade.id]);
            results.push({ id: trade.id, symbol: trade.symbol, status: 'STILL_OPEN', pnl: livePnl });
            continue;
          }

          let found = false;

          // Method 1: Position history — has closePrice and realizedPNL
          try {
            const positions = await client.getHistoryPositions({ symbol: trade.symbol, pageSize: 20 });
            for (const p of positions) {
              const cp = parseFloat(p.closePrice || 0);
              if (cp > 0 && p.symbol === trade.symbol) {
                exitPrice = cp;
                if (p.realizedPNL != null) realizedPnl = parseFloat(p.realizedPNL);
                found = true;
                break;
              }
            }
          } catch { /* try next method */ }

          // Method 2: Order history — reduceOnly orders are close orders
          if (!found) {
            try {
              const orderList = await client.getHistoryOrders({ symbol: trade.symbol, pageSize: 20 });
              for (const o of orderList) {
                const oPrice = parseFloat(o.avgPrice || 0);
                if (o.reduceOnly && oPrice > 0) {
                  exitPrice = oPrice;
                  if (o.realizedPNL != null) realizedPnl = parseFloat(o.realizedPNL);
                  found = true;
                  break;
                }
              }
            } catch { /* try next method */ }
          }

          // Method 3: Market price fallback
          if (!found) {
            try {
              const priceData = await client.getMarketPrice(trade.symbol);
              const mp = parseFloat(priceData?.lastPrice || priceData?.price || priceData || 0);
              if (mp > 0) exitPrice = mp;
            } catch { /* keep entryPrice */ }
          }
        }

        // Calculate PnL
        let pnlUsdt;
        if (realizedPnl !== null) {
          pnlUsdt = parseFloat(realizedPnl.toFixed(4));
        } else {
          pnlUsdt = isLong
            ? parseFloat(((exitPrice - entryPrice) * qty).toFixed(4))
            : parseFloat(((entryPrice - exitPrice) * qty).toFixed(4));
        }
        const status = pnlUsdt > 0 ? 'WIN' : 'LOSS';

        await query(
          `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3, closed_at = COALESCE(closed_at, NOW())
           WHERE id = $4`,
          [status, pnlUsdt, exitPrice, trade.id]
        );

        results.push({ id: trade.id, symbol: trade.symbol, platform: trade.platform, status, pnl: pnlUsdt, exitPrice, entryPrice, qty, realizedPnl });
      } catch (err) {
        results.push({ id: trade.id, symbol: trade.symbol, error: err.message });
      }
    }

    res.json({ ok: true, fixed: results.length, results });
  } catch (err) {
    console.error('Fix trade sync error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Diagnostic: test Bitunix API responses for a trade ────
router.post('/debug-bitunix', async (req, res) => {
  try {
    const cryptoUtils = require('../crypto-utils');
    const { BitunixClient } = require('../bitunix-client');

    // Find a Bitunix trade to test
    const trades = await query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE ak.platform = 'bitunix'
       ORDER BY t.created_at DESC LIMIT 1`
    );

    if (!trades.length) return res.json({ error: 'No Bitunix trades found' });

    const trade = trades[0];
    const apiKey = cryptoUtils.decrypt(trade.api_key_enc, trade.iv, trade.auth_tag);
    const apiSecret = cryptoUtils.decrypt(trade.api_secret_enc, trade.secret_iv, trade.secret_auth_tag);
    const client = new BitunixClient({ apiKey, apiSecret });

    const results = {
      trade: { id: trade.id, symbol: trade.symbol, direction: trade.direction, entry: trade.entry_price },
      keyPreview: apiKey.substring(0, 8) + '...',
    };

    const sym = trade.symbol;
    // Bitunix might use different symbol format
    const symDash = sym.replace('USDT', '-USDT');

    // Account works! Auth + proxy confirmed. Now find the right trade history endpoint.

    // 1. Position history endpoints (closed positions = what we need)
    try { results.posHistory_v1 = await client._rawPost('/api/v1/futures/position/get_history_positions', { pageNum: 1, pageSize: 5 }); } catch (e) { results.posHistory_v1_err = e.message; }
    try { results.posHistory_GET = await client._rawGet('/api/v1/futures/position/get_history_positions', { pageNum: 1, pageSize: 5 }); } catch (e) { results.posHistory_GET_err = e.message; }

    // 2. Open positions (GET)
    try { results.openPos = await client._rawGet('/api/v1/futures/position/get_pending_positions', {}); } catch (e) { results.openPos_err = e.message; }

    // 3. get_fills needs orderId?
    try { results.fills_orderId = await client._rawPost('/api/v1/futures/trade/get_fills', { orderId: '12345', symbol: sym }); } catch (e) { results.fills_orderId_err = e.message; }

    // 4. Order list endpoints (GET vs POST)
    try { results.orderList_GET = await client._rawGet('/api/v1/futures/trade/get_history_orders', { symbol: sym, pageNum: 1, pageSize: 5 }); } catch (e) { results.orderList_GET_err = e.message; }
    try { results.openOrders = await client._rawGet('/api/v1/futures/trade/get_open_orders', { symbol: sym }); } catch (e) { results.openOrders_err = e.message; }
    try { results.openOrders_POST = await client._rawPost('/api/v1/futures/trade/get_open_orders', { symbol: sym }); } catch (e) { results.openOrders_POST_err = e.message; }

    // 5. Try /api/v1/futures/order/ paths
    try { results.orderHist_alt = await client._rawPost('/api/v1/futures/order/get_history_orders', { symbol: sym, pageNum: 1, pageSize: 5 }); } catch (e) { results.orderHist_alt_err = e.message; }

    // 6. Bill/ledger endpoint (some exchanges put PnL here)
    try { results.bills = await client._rawPost('/api/v1/futures/account/bills', { pageNum: 1, pageSize: 5 }); } catch (e) { results.bills_err = e.message; }
    try { results.bills_GET = await client._rawGet('/api/v1/futures/account/bills', { pageNum: 1, pageSize: 5 }); } catch (e) { results.bills_GET_err = e.message; }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backtest: run strategy simulation over last 30 days ────
router.post('/backtest', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { getFetchOptions } = require('../proxy-agent');
    const DAYS = parseInt(req.body.days) || 30;
    const TOP_N = parseInt(req.body.topN) || 20;
    const WALLET_START = 1000;
    const RISK_PCT = 0.10;
    const LEVERAGE = 20;
    const MAX_POS = 3;
    const TP_PCT = 0.01;
    const TRAILING = { INIT: 0.01, FIRST: 0.013, STEP: 0.01 };
    const SWING = { '15m': 10, '3m': 10, '1m': 5 };
    const PROXIMITY = 0.003;

    const endTime = Date.now();
    const startTime = endTime - DAYS * 86400000;

    // Fetch functions
    async function fetchK(symbol, interval, limit) {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch(url, { timeout: 15000, ...getFetchOptions() });
          if (r.ok) return r.json();
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      return null;
    }

    // Swing detection
    function detectSwings(klines, len) {
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));
      const swings = [];
      let lastType = null;
      for (let i = len; i < klines.length - len; i++) {
        let isH = true, isL = true;
        for (let j = -len; j <= len; j++) {
          if (j === 0) continue;
          if (highs[i] <= highs[i + j]) isH = false;
          if (lows[i] >= lows[i + j]) isL = false;
        }
        if (isH && isL) {
          const hd = highs[i] - Math.max(highs[i-1], highs[i+1]);
          const ld = Math.min(lows[i-1], lows[i+1]) - lows[i];
          if (hd > ld) isL = false; else isH = false;
        }
        if (isH) {
          if (lastType === 'high' && highs[i] > swings[swings.length-1].price)
            swings[swings.length-1] = { type: 'high', index: i, price: highs[i] };
          else if (lastType !== 'high') { swings.push({ type: 'high', index: i, price: highs[i] }); lastType = 'high'; }
        }
        if (isL) {
          if (lastType === 'low' && lows[i] < swings[swings.length-1].price)
            swings[swings.length-1] = { type: 'low', index: i, price: lows[i] };
          else if (lastType !== 'low') { swings.push({ type: 'low', index: i, price: lows[i] }); lastType = 'low'; }
        }
      }
      return swings;
    }

    function getStruct(klines, len) {
      const sw = detectSwings(klines, len);
      const sH = sw.filter(s => s.type === 'high');
      const sL = sw.filter(s => s.type === 'low');
      const lH = sH.length > 1 ? sH[sH.length-1] : null;
      const lL = sL.length > 1 ? sL[sL.length-1] : null;
      const hLabel = lH && sH.length > 1 ? (sH[sH.length-1].price > sH[sH.length-2].price ? 'HH' : 'LH') : null;
      const lLabel = lL && sL.length > 1 ? (sL[sL.length-1].price > sL[sL.length-2].price ? 'HL' : 'LL') : null;
      return { hasHL: lLabel === 'HL', hasLH: hLabel === 'LH', lastHigh: lH, lastLow: lL };
    }

    function calcVWAP(klines) {
      let cv = 0, ct = 0, ct2 = 0, day = '';
      const vals = [];
      for (const k of klines) {
        const d = new Date(parseInt(k[0])).toISOString().slice(0,10);
        const h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]), v = parseFloat(k[5]);
        if (d !== day) { cv = 0; ct = 0; ct2 = 0; day = d; }
        const tp = (h+l+c)/3;
        ct += tp*v; ct2 += tp*tp*v; cv += v;
        if (cv > 0) { const vw = ct/cv; vals.push({ vwap: vw, upper: vw + Math.sqrt(Math.max(0, ct2/cv - vw*vw)), lower: vw - Math.sqrt(Math.max(0, ct2/cv - vw*vw)) }); }
        else vals.push({ vwap: c, upper: c, lower: c });
      }
      return vals;
    }

    function atKeyLevel(price, pdh, pdl, vwap, dir) {
      const b = vwap[vwap.length-1];
      const nPDH = Math.abs(price-pdh)/pdh < PROXIMITY;
      const nPDL = Math.abs(price-pdl)/pdl < PROXIMITY;
      const nU = Math.abs(price-b.upper)/b.upper < PROXIMITY;
      const nL = Math.abs(price-b.lower)/b.lower < PROXIMITY;
      const nV = Math.abs(price-b.vwap)/b.vwap < PROXIMITY;
      return dir === 'LONG' ? (nL || nPDL || nV) : (nU || nPDH || nV);
    }

    // Get top coins
    const tickerRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000, ...getFetchOptions() });
    const tickers = await tickerRes.json();
    const BL = new Set(['USDCUSDT','ALPACAUSDT','XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT']);
    const topCoins = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && !BL.has(t.symbol))
      .filter(t => parseFloat(t.quoteVolume) >= 10_000_000)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, TOP_N).map(t => t.symbol);

    // Fetch data
    const coinData = {};
    for (const sym of topCoins) {
      const [k15, k3, k1, kD] = await Promise.all([
        fetchK(sym, '15m', 1500), fetchK(sym, '3m', 1500),
        fetchK(sym, '1m', 1500), fetchK(sym, '1d', 35),
      ]);
      if (k15 && k3 && k1 && kD) coinData[sym] = { k15, k3, k1, kD };
      await new Promise(r => setTimeout(r, 200));
    }

    // Simulate
    let wallet = WALLET_START;
    const trades = [];
    const openPos = [];
    const firstCoin = Object.keys(coinData)[0];
    if (!firstCoin) return res.json({ error: 'No data fetched' });

    const timeSteps = coinData[firstCoin].k15.map(k => parseInt(k[0])).filter(t => t >= startTime);

    for (let step = 0; step < timeSteps.length; step++) {
      const now = timeSteps[step];

      // Check open positions
      for (let i = openPos.length - 1; i >= 0; i--) {
        const pos = openPos[i];
        const data = coinData[pos.symbol];
        if (!data) continue;
        const windowStart = step > 0 ? timeSteps[step-1] : now - 900000;
        const candles = data.k1.filter(k => parseInt(k[0]) >= windowStart && parseInt(k[0]) < now);

        let closed = false;
        for (const c of candles) {
          const high = parseFloat(c[2]), low = parseFloat(c[3]), close = parseFloat(c[4]);
          // SL
          if ((pos.dir === 'LONG' && low <= pos.sl) || (pos.dir === 'SHORT' && high >= pos.sl)) {
            pos.exit = pos.sl; pos.reason = 'SL'; pos.exitTime = now;
            pos.pnl = pos.dir === 'LONG' ? (pos.sl - pos.entry) * pos.qty : (pos.entry - pos.sl) * pos.qty;
            wallet += pos.pnl; openPos.splice(i, 1); closed = true; break;
          }
          // TP
          if ((pos.dir === 'LONG' && high >= pos.tp) || (pos.dir === 'SHORT' && low <= pos.tp)) {
            pos.exit = pos.tp; pos.reason = 'TP'; pos.exitTime = now;
            pos.pnl = pos.dir === 'LONG' ? (pos.tp - pos.entry) * pos.qty : (pos.entry - pos.tp) * pos.qty;
            wallet += pos.pnl; openPos.splice(i, 1); closed = true; break;
          }
          // Trailing SL
          const pp = pos.dir === 'LONG' ? (close - pos.entry) / pos.entry : (pos.entry - close) / pos.entry;
          const ns = pos.lastStep === 0 ? TRAILING.FIRST : pos.lastStep + TRAILING.STEP;
          if (pp >= ns) {
            let reached = ns;
            while (pp >= reached + TRAILING.STEP) reached += TRAILING.STEP;
            pos.lastStep = reached;
            pos.sl = pos.dir === 'LONG'
              ? pos.entry * (1 + reached - TRAILING.STEP)
              : pos.entry * (1 - reached + TRAILING.STEP);
          }
        }
      }

      if (openPos.length >= MAX_POS) continue;

      // Scan
      for (const sym of Object.keys(coinData)) {
        if (openPos.length >= MAX_POS) break;
        if (openPos.find(p => p.symbol === sym)) continue;
        const data = coinData[sym];
        const k15 = data.k15.filter(k => parseInt(k[0]) <= now);
        const k3 = data.k3.filter(k => parseInt(k[0]) <= now);
        const k1 = data.k1.filter(k => parseInt(k[0]) <= now);
        if (k15.length < 30 || k3.length < 30 || k1.length < 15) continue;

        // 3-candle trend
        const last3 = k15.slice(-4, -1);
        if (last3.length < 3) continue;
        let gc = 0, rc = 0;
        for (const c of last3) { parseFloat(c[4]) > parseFloat(c[1]) ? gc++ : rc++; }
        let dir = null;
        if (gc >= 2) dir = 'LONG'; else if (rc >= 2) dir = 'SHORT';
        if (!dir) continue;

        const price = parseFloat(k15[k15.length-1][4]);
        const dIdx = data.kD.findIndex(k => parseInt(k[0]) + 86400000 > now);
        const pdh = dIdx > 0 ? parseFloat(data.kD[dIdx-1][2]) : price * 1.01;
        const pdl = dIdx > 0 ? parseFloat(data.kD[dIdx-1][3]) : price * 0.99;

        const vwap = calcVWAP(k15);
        if (!atKeyLevel(price, pdh, pdl, vwap, dir)) continue;

        const s3 = getStruct(k3, SWING['3m']);
        if ((dir === 'LONG' && !s3.hasHL) || (dir === 'SHORT' && !s3.hasLH)) continue;

        const s1 = getStruct(k1, SWING['1m']);
        if ((dir === 'LONG' && !s1.hasHL) || (dir === 'SHORT' && !s1.hasLH)) continue;

        const es = dir === 'LONG' ? s1.lastLow : s1.lastHigh;
        if (!es || (k1.length - 1 - es.index) > 25) continue;

        const vols = k1.slice(-20).map(k => parseFloat(k[5]));
        const rv = vols.slice(-5).reduce((a,b)=>a+b,0)/5;
        const av = vols.reduce((a,b)=>a+b,0)/vols.length;
        if (av > 0 && rv/av < 0.8) continue;

        // Entry!
        const tradeUsdt = wallet * RISK_PCT;
        const qty = (tradeUsdt * LEVERAGE) / price;
        const sl = dir === 'LONG' ? price * (1 - TRAILING.INIT) : price * (1 + TRAILING.INIT);
        const tp = dir === 'LONG' ? price * (1 + TP_PCT) : price * (1 - TP_PCT);
        const trade = { symbol: sym, dir, entry: price, qty, sl, tp, lastStep: 0, entryTime: now, exit: null, reason: null, pnl: null, exitTime: null };
        openPos.push(trade);
        trades.push(trade);
      }
    }

    // Close remaining
    for (const pos of openPos) {
      const data = coinData[pos.symbol];
      if (data && data.k1.length) {
        const lp = parseFloat(data.k1[data.k1.length-1][4]);
        pos.exit = lp; pos.reason = 'END'; pos.exitTime = endTime;
        pos.pnl = pos.dir === 'LONG' ? (lp - pos.entry) * pos.qty : (pos.entry - lp) * pos.qty;
        wallet += pos.pnl;
      }
    }

    // Results
    const closed = trades.filter(t => t.pnl !== null);
    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl <= 0);
    const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

    let peak = WALLET_START, maxDD = 0, running = WALLET_START;
    for (const t of closed) {
      running += t.pnl;
      if (running > peak) peak = running;
      const dd = (peak - running) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    const tradeLog = closed.map(t => ({
      date: new Date(t.entryTime).toISOString().slice(0, 16),
      symbol: t.symbol, dir: t.dir,
      entry: t.entry.toFixed(4), exit: t.exit.toFixed(4),
      pnl: t.pnl.toFixed(2), reason: t.reason,
    }));

    // Per-coin stats
    const coinStats = {};
    for (const t of closed) {
      if (!coinStats[t.symbol]) coinStats[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
      if (t.pnl > 0) coinStats[t.symbol].wins++; else coinStats[t.symbol].losses++;
      coinStats[t.symbol].pnl += t.pnl;
    }

    res.json({
      period: `${new Date(startTime).toISOString().slice(0,10)} → ${new Date(endTime).toISOString().slice(0,10)}`,
      coinsScanned: Object.keys(coinData).length,
      startWallet: WALLET_START,
      finalWallet: parseFloat(wallet.toFixed(2)),
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      totalPnlPct: parseFloat(((totalPnl / WALLET_START) * 100).toFixed(1)),
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? parseFloat(((wins.length / closed.length) * 100).toFixed(1)) : 0,
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      maxDrawdown: parseFloat((maxDD * 100).toFixed(1)),
      trades: tradeLog,
      coinStats: Object.entries(coinStats).sort((a, b) => b[1].pnl - a[1].pnl).map(([s, d]) => ({
        symbol: s, wins: d.wins, losses: d.losses, pnl: parseFloat(d.pnl.toFixed(2)),
      })),
    });
  } catch (err) {
    console.error('Backtest error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
