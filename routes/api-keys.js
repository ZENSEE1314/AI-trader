const express = require('express');
const { query } = require('../db');
const { encrypt, decrypt } = require('../crypto-utils');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// List user's keys (never return actual keys)
router.get('/', async (req, res) => {
  try {
    // Try the new query with risk levels, fall back to simple query if it fails
    let rows;
    try {
      rows = await query(
        `SELECT ak.id, ak.platform, ak.label, ak.leverage, ak.risk_pct, ak.max_loss_usdt, ak.max_positions, ak.enabled,
                ak.allowed_coins, ak.banned_coins, ak.tp_pct, ak.sl_pct, ak.max_consec_loss, ak.top_n_coins,
                COALESCE(ak.risk_level_id, 1) as risk_level_id,
                COALESCE(ak.capital_percentage, 10.0) as capital_percentage,
                COALESCE(ak.trailing_sl_step, 1.2) as trailing_sl_step,
                COALESCE(rl.name, 'Medium Risk') as risk_level_name,
                COALESCE(rl.description, 'Balanced risk profile') as risk_level_description,
                substring(ak.api_key_enc, 1, 8) as key_preview, ak.created_at
         FROM api_keys ak
         LEFT JOIN risk_levels rl ON ak.risk_level_id = rl.id
         WHERE ak.user_id = $1 ORDER BY ak.created_at`,
        [req.userId]
      );
    } catch (err) {
      // Fallback to simple query if new columns/tables don't exist yet
      console.log('Using fallback API key query:', err.message);
      rows = await query(
        `SELECT ak.id, ak.platform, ak.label, ak.leverage, ak.risk_pct, ak.max_loss_usdt, ak.max_positions, ak.enabled,
                ak.allowed_coins, ak.banned_coins, ak.tp_pct, ak.sl_pct, ak.max_consec_loss, ak.top_n_coins,
                1 as risk_level_id,
                10.0 as capital_percentage,
                COALESCE(ak.trailing_sl_step, 1.2) as trailing_sl_step,
                'Medium Risk' as risk_level_name,
                'Balanced risk profile' as risk_level_description,
                substring(ak.api_key_enc, 1, 8) as key_preview, ak.created_at
         FROM api_keys ak
         WHERE ak.user_id = $1 ORDER BY ak.created_at`,
        [req.userId]
      );
    }
    // Fetch user token leverages for each key
    const keyIds = rows.map(r => r.id);
    let tokenLeverages = [];
    if (keyIds.length) {
      try {
        tokenLeverages = await query(
          `SELECT api_key_id, symbol, leverage FROM user_token_leverage WHERE api_key_id = ANY($1) ORDER BY symbol`,
          [keyIds]
        );
      } catch (_) { /* table may not exist yet */ }
    }

    // Attach token leverages to each key
    for (const row of rows) {
      row.token_leverages = tokenLeverages.filter(tl => tl.api_key_id === row.id);
    }

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

    // Validate key by testing connection to exchange
    try {
      if (platform === 'binance') {
        const { USDMClient } = require('binance');
        const testClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret });
        await testClient.getAccountInformation({ omitZeroBalances: true });
      } else if (platform === 'bitunix') {
        const { BitunixClient } = require('../bitunix-client');
        const testClient = new BitunixClient({ apiKey, apiSecret });
        await testClient.getAccountInformation();
      }
    } catch (testErr) {
      const msg = testErr.message || 'Unknown error';
      console.error(`API key validation failed (${platform}): ${msg}`);
      if (msg.includes('Invalid API') || msg.includes('signature') || msg.includes('401') || msg.includes('403') || msg.includes('invalid')) {
        return res.status(400).json({ error: `Invalid API key — ${platform} rejected the credentials. Check your key and secret.` });
      }
      // Network/IP errors — save anyway, key might work from Railway
      console.warn(`API key test inconclusive (${platform}): ${msg} — saving anyway`);
    }

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
    res.status(500).json({ error: 'Failed to save API key' });
  }
});

// Update settings for a key
router.put('/:id/settings', async (req, res) => {
  try {
    const { leverage, risk_pct, max_loss_usdt, max_positions, enabled, allowed_coins, banned_coins,
            tp_pct, sl_pct, max_consec_loss, top_n_coins, risk_level_id, capital_percentage, trailing_sl_step, token_leverages } = req.body;

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
    if (trailing_sl_step !== undefined && (trailing_sl_step < 0.5 || trailing_sl_step > 5.0)) {
      return res.status(400).json({ error: 'Trailing SL step must be 0.5-5%' });
    }
    
    // Validate risk_level_id if provided (skip if null/0/empty — means "no risk level")
    if (risk_level_id !== undefined && risk_level_id !== null && risk_level_id !== 0 && risk_level_id !== '') {
      const riskLevel = await query('SELECT id FROM risk_levels WHERE id = $1', [risk_level_id]);
      if (!riskLevel.length) {
        return res.status(400).json({ error: 'Invalid risk level ID — go to Admin > Risk Levels to create levels first' });
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
        capital_percentage = COALESCE($13, capital_percentage),
        trailing_sl_step = COALESCE($14, trailing_sl_step)
       WHERE id = $15 AND user_id = $16`,
      [leverage, risk_pct, max_loss_usdt, max_positions, enabled, allowed_coins, banned_coins,
       tp_pct, sl_pct, max_consec_loss, top_n_coins, risk_level_id, capital_percentage, trailing_sl_step, req.params.id, req.userId]
    );

    // Handle per-token leverage overrides
    if (Array.isArray(token_leverages)) {
      // Delete existing and re-insert
      await query('DELETE FROM user_token_leverage WHERE api_key_id = $1', [req.params.id]);
      for (const tl of token_leverages) {
        if (tl.symbol && tl.leverage >= 1 && tl.leverage <= 125) {
          await query(
            `INSERT INTO user_token_leverage (api_key_id, symbol, leverage) VALUES ($1, $2, $3)
             ON CONFLICT (api_key_id, symbol) DO UPDATE SET leverage = $3`,
            [req.params.id, tl.symbol.toUpperCase(), tl.leverage]
          );
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Update settings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a key — cleans up all related rows first to avoid FK constraint errors.
// Each cleanup is individually try/caught so a missing table or unknown FK
// on the live DB can't block the final DELETE.
router.delete('/:id', async (req, res) => {
  const keyId = req.params.id;
  try {
    // Verify ownership
    const owned = await query(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
      [keyId, req.userId]
    );
    if (!owned.length) return res.status(404).json({ error: 'Key not found' });

    // Disable immediately so the bot stops using it
    try { await query('UPDATE api_keys SET enabled = false WHERE id = $1', [keyId]); } catch (_) {}

    // Clean up every table that references api_key_id — each step is isolated
    // so a missing table or unexpected constraint never blocks the delete.
    // NOTE: trade records are intentionally NOT touched — the key is disabled
    // immediately so the bot stops using it, but open trade records stay in DB.
    // Force-closing them here would wipe manual/synced positions the user still
    // has on the exchange.
    const cleanups = [
      `DELETE FROM user_token_leverage    WHERE api_key_id = $1`,
      `DELETE FROM user_agent_preferences WHERE api_key_id = $1`,
      `DELETE FROM weekly_earnings        WHERE api_key_id = $1`,
      `DELETE FROM subscriptions          WHERE api_key_id = $1`,
    ];
    for (const sql of cleanups) {
      try { await query(sql, [keyId]); } catch (e) {
        console.warn(`Delete key ${keyId} cleanup warning: ${e.message}`);
      }
    }

    // Now safe to delete the key itself
    await query('DELETE FROM api_keys WHERE id = $1', [keyId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
