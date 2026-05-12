const express = require('express');
const { getStore } = require('../monitor-agent');

const router = express.Router();

// ── GET /api/monitor/stats ────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    const s = getStore();
    res.json({
      winRate24h:    s.winRate24h,
      totalTrades24h: s.totalTrades24h,
      pnl24h:        s.pnl24h,
      streak:        s.streak,
      lastTrades:    s.lastTrades,
      anomalies:     s.anomalies,
      lastChecked:   s.lastChecked,
    });
  } catch (err) {
    console.error('[monitor] GET /stats error:', err.message);
    res.status(500).json({ error: 'Failed to load monitor stats' });
  }
});

// ── GET /api/monitor/anomalies ────────────────────────────────────────────────
router.get('/anomalies', (req, res) => {
  try {
    const { anomalies, lastChecked } = getStore();
    res.json({ anomalies, lastChecked });
  } catch (err) {
    console.error('[monitor] GET /anomalies error:', err.message);
    res.status(500).json({ error: 'Failed to load anomalies' });
  }
});

module.exports = router;
