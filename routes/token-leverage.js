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

// Get all token leverage settings (admin only)
router.get('/', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const rows = await query(
      'SELECT * FROM token_leverage ORDER BY symbol'
    );
    res.json(rows);
  } catch (err) {
    console.error('Token leverage list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get leverage for a specific token
router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const rows = await query(
      'SELECT * FROM token_leverage WHERE symbol = $1',
      [symbol.toUpperCase()]
    );
    
    if (rows.length === 0) {
      // Return default leverage if not configured
      res.json({ symbol: symbol.toUpperCase(), leverage: 20, enabled: true });
    } else {
      res.json(rows[0]);
    }
  } catch (err) {
    console.error('Token leverage get error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update or create token leverage setting (admin only)
router.post('/:symbol', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const { symbol } = req.params;
    const { leverage, enabled } = req.body;
    
    if (!leverage || leverage < 1 || leverage > 100) {
      return res.status(400).json({ error: 'Leverage must be between 1 and 100' });
    }

    const rows = await query(
      `INSERT INTO token_leverage (symbol, leverage, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (symbol) DO UPDATE SET
         leverage = EXCLUDED.leverage,
         enabled = EXCLUDED.enabled
       RETURNING *`,
      [symbol.toUpperCase(), parseInt(leverage), enabled !== false]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('Token leverage update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete token leverage setting (admin only)
router.delete('/:symbol', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const { symbol } = req.params;
    await query(
      'DELETE FROM token_leverage WHERE symbol = $1',
      [symbol.toUpperCase()]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Token leverage delete error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all available tokens with their leverage settings
router.get('/all/tokens', async (req, res) => {
  try {
    // Get top 200 USDT pairs from Binance
    const fetch = require('node-fetch');
    const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
    const tickers = await response.json();
    
    const tokens = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 200)
      .map(t => t.symbol);

    // Get leverage settings from database
    const leverageSettings = await query('SELECT * FROM token_leverage');
    const leverageMap = {};
    leverageSettings.forEach(setting => {
      leverageMap[setting.symbol] = setting;
    });

    // Combine token list with leverage settings
    const result = tokens.map(symbol => {
      const setting = leverageMap[symbol];
      return {
        symbol,
        leverage: setting ? setting.leverage : 20,
        enabled: setting ? setting.enabled : true,
        custom_setting: !!setting
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Token list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;