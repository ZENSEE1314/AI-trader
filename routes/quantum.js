const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const quantumOptimizer = require('../quantum-optimizer');

const router = express.Router();
router.use(authMiddleware);

async function adminOnly(req, res, next) {
  const rows = await query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
  if (!rows.length || !rows[0].is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// GET /api/quantum/combos — all 15 combos with stats
router.get('/combos', adminOnly, async (req, res) => {
  try {
    const stats = await quantumOptimizer.getComboStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get combo stats' });
  }
});

// GET /api/quantum/active — current active combo
router.get('/active', adminOnly, async (req, res) => {
  try {
    const comboId = await quantumOptimizer.getActiveCombo();
    const strategies = quantumOptimizer.getEnabledStrategies(comboId);
    const name = quantumOptimizer.comboToName(comboId);
    res.json({ combo_id: comboId, combo_name: name, strategies });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get active combo' });
  }
});

// POST /api/quantum/activate/:id — admin force-activate a combo
router.post('/activate/:id', adminOnly, async (req, res) => {
  const comboId = parseInt(req.params.id);
  if (isNaN(comboId) || comboId < 1 || comboId > 15) {
    return res.status(400).json({ error: 'combo_id must be 1-15' });
  }

  const ok = await quantumOptimizer.adminSetCombo(comboId);
  if (!ok) return res.status(500).json({ error: 'Failed to activate combo' });

  res.json({
    combo_id: comboId,
    combo_name: quantumOptimizer.comboToName(comboId),
    strategies: quantumOptimizer.getEnabledStrategies(comboId),
    admin_locked: true,
  });
});

// POST /api/quantum/unlock — unlock admin override, resume auto
router.post('/unlock', adminOnly, async (req, res) => {
  const ok = await quantumOptimizer.adminUnlockCombo();
  if (!ok) return res.status(500).json({ error: 'Failed to unlock' });
  res.json({ message: 'Auto-optimization resumed' });
});

// GET /api/quantum/exploration — exploration status
router.get('/exploration', adminOnly, async (req, res) => {
  try {
    const stats = await quantumOptimizer.getComboStats();
    const underExplored = stats.combos.filter(c => c.total_trades < 20);
    res.json({
      phase: stats.current_phase,
      progress: stats.exploration_progress,
      under_explored: underExplored.map(c => ({
        combo_id: c.combo_id,
        combo_name: c.combo_name,
        trades_done: c.total_trades,
        trades_needed: 20 - c.total_trades,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get exploration status' });
  }
});

module.exports = router;
