const express = require('express');
const { query } = require('../db');
const { encrypt, decrypt } = require('../crypto-utils');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// List user's keys (never return actual keys)
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT ak.id, ak.platform, ak.label, ak.leverage, ak.risk_pct, ak.max_loss_usdt, ak.max_positions, ak.enabled,
              ak.allowed_coins, ak.banned_coins, ak.tp_pct, ak.sl_pct, ak.max_consec_loss, ak.top_n_coins,
              ak.risk_level_id, ak.capital_percentage,
              rl.name as risk_level_name, rl.description as risk_level_description,
              substring(ak.api_key_enc, 1, 8) as key_preview, ak.created_at
       FROM api_keys ak
       LEFT JOIN risk_levels rl ON ak.risk_level_id = rl.id
       WHERE ak.user_id = $1 ORDER BY ak.created_at`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('List keys error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a new API key (no subscription required — admin can toggle trading on/off)
router.post('/', async (req, res) => {
  try {
    const { platform, label, apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API key and secret required' });
    if (!platform) return res.status(400).json({ error: 'Platform required' });

    const validPlatforms = ['binance', 'bitunix'];
    if (!validPlatforms.includes(platform)) return res.status(400).json({ error: 'Unsupported platform' });

    // Check if admin
    const user = await query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    const isAdmin = user.length && user[0].is_admin;

    // Non-admin: check max 3 keys
    if (!isAdmin) {
      const count = await query('SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = $1', [req.userId]);
      if (parseInt(count[0].cnt) >= 3) return res.status(400).json({ error: 'Maximum 3 API keys allowed' });
    }

    // Skip validation test — IP/proxy issues cause false failures.
    // If key is invalid, errors will show in bot logs on first trade attempt.

    const keyEnc = encrypt(apiKey);
    const secretEnc = encrypt(apiSecret);

    await query(
      `INSERT INTO api_keys (user_id, platform, label, api_key_enc, api_secret_enc,
        iv, auth_tag, secret_iv, secret_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [req.userId, platform, label || `${platform} key`,
       keyEnc.encrypted, secretEnc.encrypted,
       keyEnc.iv, keyEnc.authTag, secretEnc.iv, secretEnc.authTag]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Add key error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update settings for a key
router.put('/:id/settings', async (req, res) => {
  try {
    const { leverage, risk_pct, max_loss_usdt, max_positions, enabled, allowed_coins, banned_coins,
            tp_pct, sl_pct, max_consec_loss, top_n_coins, risk_level_id, capital_percentage } = req.body;

    if (leverage !== undefined && (leverage < 1 || leverage > 125)) {
      return res.status(400).json({ error: 'Leverage must be 1-125' });
    }
    if (risk_pct !== undefined && (risk_pct < 0.01 || risk_pct > 0.20)) {
      return res.status(400).json({ error: 'Risk % must be 1-20%' });
    }
    if (max_positions !== undefined && (max_positions < 1 || max_positions > 10)) {
      return res.status(400).json({ error: 'Max positions must be 1-10' });
    }
    if (tp_pct !== undefined && (tp_pct < 0.005 || tp_pct > 0.20)) {
      return res.status(400).json({ error: 'TP must be 0.5-20%' });
    }
    if (sl_pct !== undefined && (sl_pct < 0.005 || sl_pct > 0.10)) {
      return res.status(400).json({ error: 'SL must be 0.5-10%' });
    }
    if (max_consec_loss !== undefined && (max_consec_loss < 1 || max_consec_loss > 10)) {
      return res.status(400).json({ error: 'Max consecutive losses must be 1-10' });
    }
    if (top_n_coins !== undefined && (top_n_coins < 5 || top_n_coins > 200)) {
      return res.status(400).json({ error: 'Top coins must be 5-200' });
    }
    if (capital_percentage !== undefined && (capital_percentage < 1 || capital_percentage > 100)) {
      return res.status(400).json({ error: 'Capital percentage must be 1-100%' });
    }
    
    // Validate risk_level_id if provided
    if (risk_level_id !== undefined) {
      if (risk_level_id === null) {
        // Allow null to clear risk level
      } else {
        const riskLevel = await query('SELECT id FROM risk_levels WHERE id = $1', [risk_level_id]);
        if (!riskLevel.length) {
          return res.status(400).json({ error: 'Invalid risk level ID' });
        }
      }
    }

    // Verify ownership
    const rows = await query('SELECT id FROM api_keys WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Key not found' });

    await query(
      `UPDATE api_keys SET
        leverage = COALESCE($1, leverage),
        risk_pct = COALESCE($2, risk_pct),
        max_loss_usdt = COALESCE($3, max_loss_usdt),
        max_positions = COALESCE($4, max_positions),
        enabled = COALESCE($5, enabled),
        allowed_coins = COALESCE($6, allowed_coins),
        banned_coins = COALESCE($7, banned_coins),
        tp_pct = COALESCE($8, tp_pct),
        sl_pct = COALESCE($9, sl_pct),
        max_consec_loss = COALESCE($10, max_consec_loss),
        top_n_coins = COALESCE($11, top_n_coins),
        risk_level_id = COALESCE($12, risk_level_id),
        capital_percentage = COALESCE($13, capital_percentage)
       WHERE id = $14 AND user_id = $15`,
      [leverage, risk_pct, max_loss_usdt, max_positions, enabled, allowed_coins, banned_coins,
       tp_pct, sl_pct, max_consec_loss, top_n_coins, risk_level_id, capital_percentage, req.params.id, req.userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Update settings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a key
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
    if (!result.length) return res.status(404).json({ error: 'Key not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete key error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
