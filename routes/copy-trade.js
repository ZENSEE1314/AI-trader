const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const AI_PROFILE = {
  type: 'ai',
  userId: null,
  displayName: '🤖 AI Trader (MCT)',
  isAi: true,
};

// ── GET /api/copy-trade/my-profile — get own trader profile ──────────────────
router.get('/my-profile', authMiddleware, async (req, res) => {
  try {
    const rows = await query(
      `SELECT tp.display_name, tp.bio, tp.is_public, tp.created_at,
              COUNT(cts.id) AS followers
         FROM trader_profiles tp
         LEFT JOIN copy_trade_subscriptions cts
           ON cts.leader_type = 'user' AND cts.leader_user_id = tp.user_id AND cts.is_active = true
        WHERE tp.user_id = $1
        GROUP BY tp.display_name, tp.bio, tp.is_public, tp.created_at`,
      [req.userId]
    );
    if (!rows.length) return res.json(null);
    const r = rows[0];
    res.json({ ...r, followers: parseInt(r.followers) || 0 });
  } catch (err) {
    console.error('[copy-trade] GET /my-profile error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ── PUT /api/copy-trade/my-profile — create or update own trader profile ─────
router.put('/my-profile', authMiddleware, async (req, res) => {
  const { displayName, bio, isPublic } = req.body;
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: 'Display name is required' });
  }
  if (displayName.trim().length > 60) {
    return res.status(400).json({ error: 'Display name max 60 characters' });
  }
  try {
    await query(
      `INSERT INTO trader_profiles (user_id, display_name, bio, is_public)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET display_name = $2,
             bio          = $3,
             is_public    = $4`,
      [req.userId, displayName.trim(), (bio || '').trim().slice(0, 300), !!isPublic]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[copy-trade] PUT /my-profile error:', err.message);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// ── GET /api/copy-trade/traders — public list of all opt-in traders + AI ─────
router.get('/traders', async (req, res) => {
  try {
    const [aiStats, userTraders] = await Promise.all([
      _getAiStats(),
      _getUserTraders(),
    ]);

    res.json([{ ...AI_PROFILE, ...aiStats }, ...userTraders]);
  } catch (err) {
    console.error('[copy-trade] GET /traders error:', err.message);
    res.status(500).json({ error: 'Failed to load traders' });
  }
});

// ── GET /api/copy-trade/my-subscription — current subscription for caller ────
router.get('/my-subscription', authMiddleware, async (req, res) => {
  try {
    const rows = await query(
      `SELECT cts.id, cts.leader_type, cts.leader_user_id, cts.is_active,
              cts.follower_key_id, cts.copy_size_pct, cts.created_at,
              tp.display_name AS leader_display_name
         FROM copy_trade_subscriptions cts
         LEFT JOIN trader_profiles tp ON tp.user_id = cts.leader_user_id
        WHERE cts.follower_key_id IN (
          SELECT id FROM api_keys WHERE user_id = $1
        )
          AND cts.is_active = true`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[copy-trade] GET /my-subscription error:', err.message);
    res.status(500).json({ error: 'Failed to load subscription' });
  }
});

// ── POST /api/copy-trade/subscribe ───────────────────────────────────────────
router.post('/subscribe', authMiddleware, async (req, res) => {
  const { apiKeyId, leaderType, leaderUserId, copySizePct } = req.body;

  if (!apiKeyId) return res.status(400).json({ error: 'apiKeyId required' });
  if (!['ai', 'user'].includes(leaderType)) {
    return res.status(400).json({ error: 'leaderType must be "ai" or "user"' });
  }
  if (leaderType === 'user' && !leaderUserId) {
    return res.status(400).json({ error: 'leaderUserId required for user leader' });
  }

  // Validate risk % — must be 1–100
  const riskPct = parseFloat(copySizePct);
  if (isNaN(riskPct) || riskPct < 1 || riskPct > 100) {
    return res.status(400).json({ error: 'copySizePct must be between 1 and 100' });
  }

  try {
    // Verify apiKeyId belongs to the requesting user
    const owned = await query(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
      [apiKeyId, req.userId]
    );
    if (!owned.length) return res.status(403).json({ error: 'API key not found' });

    // Prevent following yourself
    if (leaderType === 'user' && parseInt(leaderUserId) === req.userId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    // Verify leader exists and is public
    if (leaderType === 'user') {
      const leader = await query(
        'SELECT user_id FROM trader_profiles WHERE user_id = $1 AND is_public = true',
        [leaderUserId]
      );
      if (!leader.length) return res.status(404).json({ error: 'Trader not found or not public' });
    }

    await query(
      `INSERT INTO copy_trade_subscriptions
         (follower_key_id, leader_type, leader_user_id, is_active, copy_size_pct)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (follower_key_id)
       DO UPDATE SET leader_type    = $2,
                     leader_user_id = $3,
                     is_active      = true,
                     copy_size_pct  = $4`,
      [apiKeyId, leaderType, leaderType === 'ai' ? null : leaderUserId, riskPct]
    );

    res.json({ ok: true, copySizePct: riskPct });
  } catch (err) {
    console.error('[copy-trade] POST /subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// ── PATCH /api/copy-trade/risk/:apiKeyId — update risk % without re-subscribing
router.patch('/risk/:apiKeyId', authMiddleware, async (req, res) => {
  const { apiKeyId } = req.params;
  const { copySizePct } = req.body;

  const riskPct = parseFloat(copySizePct);
  if (isNaN(riskPct) || riskPct < 1 || riskPct > 100) {
    return res.status(400).json({ error: 'copySizePct must be between 1 and 100' });
  }

  try {
    const owned = await query(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
      [apiKeyId, req.userId]
    );
    if (!owned.length) return res.status(403).json({ error: 'API key not found' });

    const result = await query(
      `UPDATE copy_trade_subscriptions SET copy_size_pct = $1
       WHERE follower_key_id = $2 AND is_active = true
       RETURNING id`,
      [riskPct, apiKeyId]
    );

    if (!result.length) return res.status(404).json({ error: 'No active subscription for this key' });

    res.json({ ok: true, copySizePct: riskPct });
  } catch (err) {
    console.error('[copy-trade] PATCH /risk error:', err.message);
    res.status(500).json({ error: 'Failed to update risk' });
  }
});

// ── DELETE /api/copy-trade/unsubscribe/:apiKeyId ─────────────────────────────
router.delete('/unsubscribe/:apiKeyId', authMiddleware, async (req, res) => {
  const { apiKeyId } = req.params;
  try {
    // Verify ownership
    const owned = await query(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
      [apiKeyId, req.userId]
    );
    if (!owned.length) return res.status(403).json({ error: 'API key not found' });

    await query(
      'UPDATE copy_trade_subscriptions SET is_active = false WHERE follower_key_id = $1',
      [apiKeyId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[copy-trade] DELETE /unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// ── GET /api/copy-trade/profile/:userId — public trader profile + stats ───────
router.get('/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const profiles = await query(
      `SELECT tp.user_id, tp.display_name, tp.bio, tp.is_public, tp.created_at
         FROM trader_profiles tp
        WHERE tp.user_id = $1 AND tp.is_public = true`,
      [userId]
    );
    if (!profiles.length) return res.status(404).json({ error: 'Trader not found' });

    const stats = await _getUserStats(userId);
    res.json({ ...profiles[0], ...stats });
  } catch (err) {
    console.error('[copy-trade] GET /profile error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function _getAiStats() {
  try {
    const rows = await query(
      `SELECT
         COUNT(*)                                                  AS "totalTrades",
         ROUND(AVG(CASE WHEN status = 'WIN' THEN 1.0 ELSE 0.0 END) * 100, 1) AS "winRate",
         COALESCE(SUM(pnl_usdt), 0)                              AS "totalPnl",
         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN pnl_usdt ELSE 0 END), 0) AS "pnl30d",
         COALESCE(AVG(pnl_usdt), 0)                              AS "avgPnl"
       FROM trades
      WHERE is_copy_trade = false
        AND status IN ('WIN', 'LOSS')
        AND (setup LIKE 'V4-%' OR setup LIKE 'AI%')`
    );

    const followers = await query(
      `SELECT COUNT(*) AS cnt FROM copy_trade_subscriptions WHERE leader_type = 'ai' AND is_active = true`
    );

    const s = rows[0] || {};
    return {
      totalTrades: parseInt(s.totalTrades) || 0,
      winRate: parseFloat(s.winRate) || 0,
      totalPnl: parseFloat(s.totalPnl) || 0,
      pnl30d: parseFloat(s.pnl30d) || 0,
      avgPnl: parseFloat(s.avgPnl) || 0,
      followers: parseInt(followers[0]?.cnt) || 0,
    };
  } catch (err) {
    console.error('[copy-trade] _getAiStats error:', err.message);
    return { totalTrades: 0, winRate: 0, totalPnl: 0, pnl30d: 0, avgPnl: 0, followers: 0 };
  }
}

async function _getUserTraders() {
  try {
    const rows = await query(
      `SELECT
         tp.user_id                                                          AS "userId",
         tp.display_name                                                     AS "displayName",
         COUNT(t.id)                                                         AS "totalTrades",
         ROUND(AVG(CASE WHEN t.status = 'WIN' THEN 1.0 ELSE 0.0 END) * 100, 1) AS "winRate",
         COALESCE(SUM(t.pnl_usdt), 0)                                       AS "totalPnl",
         COALESCE(SUM(CASE WHEN t.created_at >= NOW() - INTERVAL '30 days' THEN t.pnl_usdt ELSE 0 END), 0) AS "pnl30d",
         COALESCE(AVG(t.pnl_usdt), 0)                                       AS "avgPnl",
         (SELECT COUNT(*) FROM copy_trade_subscriptions cts
           WHERE cts.leader_type = 'user' AND cts.leader_user_id = tp.user_id AND cts.is_active = true) AS "followers"
       FROM trader_profiles tp
       LEFT JOIN trades t ON t.user_id = tp.user_id
         AND t.is_copy_trade = false
         AND t.status IN ('WIN', 'LOSS')
      WHERE tp.is_public = true
      GROUP BY tp.user_id, tp.display_name
      ORDER BY "pnl30d" DESC`
    );

    return rows.map(r => ({
      type: 'user',
      userId: r.userId,
      displayName: r.displayName,
      winRate: parseFloat(r.winRate) || 0,
      totalTrades: parseInt(r.totalTrades) || 0,
      totalPnl: parseFloat(r.totalPnl) || 0,
      pnl30d: parseFloat(r.pnl30d) || 0,
      avgPnl: parseFloat(r.avgPnl) || 0,
      followers: parseInt(r.followers) || 0,
      isAi: false,
    }));
  } catch (err) {
    console.error('[copy-trade] _getUserTraders error:', err.message);
    return [];
  }
}

async function _getUserStats(userId) {
  try {
    const rows = await query(
      `SELECT
         COUNT(*)                                                  AS "totalTrades",
         ROUND(AVG(CASE WHEN status = 'WIN' THEN 1.0 ELSE 0.0 END) * 100, 1) AS "winRate",
         COALESCE(SUM(pnl_usdt), 0)                              AS "totalPnl",
         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN pnl_usdt ELSE 0 END), 0) AS "pnl30d",
         COALESCE(AVG(pnl_usdt), 0)                              AS "avgPnl"
       FROM trades
      WHERE user_id = $1
        AND is_copy_trade = false
        AND status IN ('WIN', 'LOSS')`,
      [userId]
    );

    const followers = await query(
      `SELECT COUNT(*) AS cnt FROM copy_trade_subscriptions
        WHERE leader_type = 'user' AND leader_user_id = $1 AND is_active = true`,
      [userId]
    );

    const s = rows[0] || {};
    return {
      totalTrades: parseInt(s.totalTrades) || 0,
      winRate: parseFloat(s.winRate) || 0,
      totalPnl: parseFloat(s.totalPnl) || 0,
      pnl30d: parseFloat(s.pnl30d) || 0,
      avgPnl: parseFloat(s.avgPnl) || 0,
      followers: parseInt(followers[0]?.cnt) || 0,
    };
  } catch (err) {
    console.error('[copy-trade] _getUserStats error:', err.message);
    return { totalTrades: 0, winRate: 0, totalPnl: 0, pnl30d: 0, avgPnl: 0, followers: 0 };
  }
}

module.exports = router;
