const express = require('express');
const { query } = require('./db');

const router = express.Router();

// Health check endpoint
router.get('/', async (req, res) => {
  try {
    const { query } = require('./db');
    
    // Try database connection
    let databaseStatus = 'connected';
    let tablesStatus = 'unknown';
    
    try {
      await query('SELECT 1');
      
      // Check if essential tables exist
      const tables = ['users', 'api_keys', 'trades'];
      const tableChecks = await Promise.all(
        tables.map(table => 
          query(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables 
              WHERE table_name = $1
            ) as exists
          `, [table])
        )
      );
      
      tablesStatus = tableChecks.every(result => result[0].exists) ? 'all_exist' : 'some_missing';
    } catch (dbError) {
      databaseStatus = 'disconnected';
      tablesStatus = 'unknown';
      console.warn('Database check failed:', dbError.message);
    }
    
    const healthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: databaseStatus,
      tables: tablesStatus,
      new_features: {
        token_leverage: true,
        risk_levels: true,
        referral_system: true,
        cash_wallet: true
      },
      environment: process.env.NODE_ENV || 'development',
      version: require('./package.json').version,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
    
    res.status(200).json(healthStatus);
  } catch (error) {
    console.error('Health check failed:', error.message);
    
    const healthStatus = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'unknown',
      error: error.message,
      environment: process.env.NODE_ENV || 'development',
      version: require('./package.json').version
    };
    
    res.status(503).json(healthStatus);
  }
});

// Simple ping endpoint
router.get('/ping', (req, res) => {
  res.json({ 
    status: 'pong', 
    timestamp: new Date().toISOString(),
    message: 'AI Trader is running'
  });
});

// Version endpoint
router.get('/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    new_features: [
      'Cash wallet system',
      'Token-specific leverage',
      '3-level risk management',
      'Referral commission system',
      '10% capital trading logic'
    ]
  });
});

module.exports = router;