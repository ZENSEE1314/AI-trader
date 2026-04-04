#!/usr/bin/env node

const { query, initAllTables } = require('./db');

async function setupDatabase() {
  console.log('Setting up new database features...');
  
  try {
    // Initialize all tables (including new ones)
    await initAllTables();
    console.log('✓ Database tables initialized');
    
    // Check if default risk levels already exist
    const existingLevels = await query('SELECT COUNT(*) as count FROM risk_levels');
    if (parseInt(existingLevels[0].count) === 0) {
      console.log('Creating default risk levels...');
      
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
      
      for (const level of defaultLevels) {
        await query(
          `INSERT INTO risk_levels 
           (name, description, tp_pct, sl_pct, max_consec_loss, top_n_coins, capital_percentage, max_leverage, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [level.name, level.description, level.tp_pct, level.sl_pct, 
           level.max_consec_loss, level.top_n_coins, level.capital_percentage, level.max_leverage]
        );
        console.log(`✓ Created risk level: ${level.name}`);
      }
    } else {
      console.log('✓ Risk levels already exist');
    }
    
    // Add some default token leverage settings
    const defaultTokens = [
      { symbol: 'BTCUSDT', leverage: 20 },
      { symbol: 'ETHUSDT', leverage: 20 },
      { symbol: 'SOLUSDT', leverage: 50 },
      { symbol: 'XRPUSDT', leverage: 50 },
      { symbol: 'ADAUSDT', leverage: 50 },
      { symbol: 'DOGEUSDT', leverage: 50 },
      { symbol: 'DOTUSDT', leverage: 50 },
      { symbol: 'AVAXUSDT', leverage: 50 },
      { symbol: 'LINKUSDT', leverage: 50 },
      { symbol: 'MATICUSDT', leverage: 50 }
    ];
    
    for (const token of defaultTokens) {
      try {
        await query(
          `INSERT INTO token_leverage (symbol, leverage, enabled)
           VALUES ($1, $2, true)
           ON CONFLICT (symbol) DO NOTHING`,
          [token.symbol, token.leverage]
        );
      } catch (err) {
        // Ignore errors for existing tokens
      }
    }
    console.log('✓ Default token leverage settings added');
    
    // Update existing API keys to have default capital percentage
    await query(
      `UPDATE api_keys SET capital_percentage = 10.0 WHERE capital_percentage IS NULL`
    );
    console.log('✓ Updated existing API keys with default capital percentage');
    
    console.log('\n✅ Setup completed successfully!');
    console.log('\nNew features available:');
    console.log('1. Cash wallet with top-up and commission tracking');
    console.log('2. Token-specific leverage settings (defaults added)');
    console.log('3. 3-level risk management system (No Risk, Medium Risk, High Risk)');
    console.log('4. 10% capital usage for trading (configurable per API key)');
    console.log('5. Commission from trading profits (10% from downline)');
    
  } catch (err) {
    console.error('Error during setup:', err.message);
    process.exit(1);
  }
}

// Run setup
setupDatabase();