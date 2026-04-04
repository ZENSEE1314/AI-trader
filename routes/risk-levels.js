const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Helper: check if user is admin
async function isAdmin(userId) {
  try {
    const rows = await query('SELECT is_admin FROM users WHERE id = $1', [userId]);
    return rows.length > 0 && rows[0].is_admin === true;
  } catch { return false; }
}

// Get all risk levels
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM risk_levels ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    console.error('Risk levels list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get specific risk level
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await query(
      'SELECT * FROM risk_levels WHERE id = $1',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Risk level not found' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    console.error('Risk level get error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new risk level (admin only)
router.post('/', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const {
      name,
      description,
      tp_pct = 0.045,
      sl_pct = 0.03,
      max_consec_loss = 2,
      top_n_coins = 50,
      capital_percentage = 10.0,
      max_leverage = 20,
      enabled = true
    } = req.body;

    // Validate inputs
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (tp_pct <= 0 || tp_pct > 1) return res.status(400).json({ error: 'TP percentage must be between 0 and 1' });
    if (sl_pct <= 0 || sl_pct > 1) return res.status(400).json({ error: 'SL percentage must be between 0 and 1' });
    if (capital_percentage <= 0 || capital_percentage > 100) return res.status(400).json({ error: 'Capital percentage must be between 0 and 100' });
    if (max_leverage < 1 || max_leverage > 100) return res.status(400).json({ error: 'Max leverage must be between 1 and 100' });

    const rows = await query(
      `INSERT INTO risk_levels 
       (name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('Risk level create error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update risk level (admin only)
router.put('/:id', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const { id } = req.params;
    const {
      name,
      description,
      tp_pct,
      sl_pct,
      max_consec_loss,
      top_n_coins,
      capital_percentage,
      max_leverage,
      enabled
    } = req.body;

    // Validate inputs if provided
    if (tp_pct !== undefined && (tp_pct <= 0 || tp_pct > 1)) {
      return res.status(400).json({ error: 'TP percentage must be between 0 and 1' });
    }
    if (sl_pct !== undefined && (sl_pct <= 0 || sl_pct > 1)) {
      return res.status(400).json({ error: 'SL percentage must be between 0 and 1' });
    }
    if (capital_percentage !== undefined && (capital_percentage <= 0 || capital_percentage > 100)) {
      return res.status(400).json({ error: 'Capital percentage must be between 0 and 100' });
    }
    if (max_leverage !== undefined && (max_leverage < 1 || max_leverage > 100)) {
      return res.status(400).json({ error: 'Max leverage must be between 1 and 100' });
    }

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount}`);
      values.push(name);
      paramCount++;
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      values.push(description);
      paramCount++;
    }
    if (tp_pct !== undefined) {
      updates.push(`tp_pct = $${paramCount}`);
      values.push(tp_pct);
      paramCount++;
    }
    if (sl_pct !== undefined) {
      updates.push(`sl_pct = $${paramCount}`);
      values.push(sl_pct);
      paramCount++;
    }
    if (max_consec_loss !== undefined) {
      updates.push(`max_consec_loss = $${paramCount}`);
      values.push(max_consec_loss);
      paramCount++;
    }
    if (top_n_coins !== undefined) {
      updates.push(`top_n_coins = $${paramCount}`);
      values.push(top_n_coins);
      paramCount++;
    }
    if (capital_percentage !== undefined) {
      updates.push(`capital_percentage = $${paramCount}`);
      values.push(capital_percentage);
      paramCount++;
    }
    if (max_leverage !== undefined) {
      updates.push(`max_leverage = $${paramCount}`);
      values.push(max_leverage);
      paramCount++;
    }
    if (enabled !== undefined) {
      updates.push(`enabled = $${paramCount}`);
      values.push(enabled);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const rows = await query(
      `UPDATE risk_levels SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Risk level not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Risk level update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete risk level (admin only)
router.delete('/:id', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const { id } = req.params;
    
    // Check if any API keys are using this risk level
    const keysUsing = await query(
      'SELECT COUNT(*) as count FROM api_keys WHERE risk_level_id = $1',
      [id]
    );
    
    if (parseInt(keysUsing[0].count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete risk level that is in use by API keys. Update the keys first.' 
      });
    }

    await query('DELETE FROM risk_levels WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Risk level delete error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get default risk levels (create if they don't exist)
router.get('/setup/defaults', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const defaultLevels = [
      {
        name: 'No Risk',
        description: 'Conservative trading with minimal risk',
        tp_pct: 0.02,
        sl_pct: 0.01,
        max_consec_loss: 1,
        top_n_coins: 30,
        capital_percentage: 5.0,
        max_leverage: 10
      },
      {
        name: 'Medium Risk',
        description: 'Balanced risk-reward trading',
        tp_pct: 0.045,
        sl_pct: 0.03,
        max_consec_loss: 2,
        top_n_coins: 50,
        capital_percentage: 10.0,
        max_leverage: 20
      },
      {
        name: 'High Risk',
        description: 'Aggressive trading with higher risk',
        tp_pct: 0.08,
        sl_pct: 0.05,
        max_consec_loss: 3,
        top_n_coins: 80,
        capital_percentage: 20.0,
        max_leverage: 50
      }
    ];

    const createdLevels = [];
    for (const level of defaultLevels) {
      const rows = await query(
        `INSERT INTO risk_levels 
         (name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           tp_pct = EXCLUDED.tp_pct,
           sl_pct = EXCLUDED.sl_pct,
           max_consec_loss = EXCLUDED.max_consec_loss,
           top_n_coins = EXCLUDED.top_n_coins,
           capital_percentage = EXCLUDED.capital_percentage,
           max_leverage = EXCLUDED.max_leverage
         RETURNING *`,
        [level.name, level.description, level.tp_pct, level.sl_pct, 
         level.max_consec_loss, level.top_n_coins, level.capital_percentage, level.max_leverage]
      );
      createdLevels.push(rows[0]);
    }

    res.json(createdLevels);
  } catch (err) {
    console.error('Setup default risk levels error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;