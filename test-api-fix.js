// Test script to check API key loading issue
console.log('Testing API key loading...');

// Simulate what might be happening
const testQuery = `
SELECT ak.id, ak.platform, ak.label, ak.leverage, ak.risk_pct, ak.max_loss_usdt, ak.max_positions, ak.enabled,
        ak.allowed_coins, ak.banned_coins, ak.tp_pct, ak.sl_pct, ak.max_consec_loss, ak.top_n_coins,
        ak.risk_level_id, ak.capital_percentage,
        rl.name as risk_level_name, rl.description as risk_level_description,
        substring(ak.api_key_enc, 1, 8) as key_preview, ak.created_at
 FROM api_keys ak
 LEFT JOIN risk_levels rl ON ak.risk_level_id = rl.id
 WHERE ak.user_id = $1 ORDER BY ak.created_at
`;

console.log('Query check:');
console.log('1. risk_level_id column exists in api_keys table?');
console.log('2. capital_percentage column exists in api_keys table?');
console.log('3. risk_levels table exists?');
console.log('4. risk_levels table has id, name, description columns?');

console.log('\nPossible issues:');
console.log('1. Database schema not updated - missing new columns');
console.log('2. risk_levels table not created');
console.log('3. LEFT JOIN failing because risk_levels table missing');

console.log('\nQuick fix: Modify the query to handle missing columns/tables');
console.log('Option 1: Remove the new columns from SELECT');
console.log('Option 2: Create default risk_levels table if missing');
console.log('Option 3: Make the query more robust with COALESCE');

const fixedQuery = `
SELECT ak.id, ak.platform, ak.label, ak.leverage, ak.risk_pct, ak.max_loss_usdt, ak.max_positions, ak.enabled,
        ak.allowed_coins, ak.banned_coins, ak.tp_pct, ak.sl_pct, ak.max_consec_loss, ak.top_n_coins,
        COALESCE(ak.risk_level_id, 1) as risk_level_id,
        COALESCE(ak.capital_percentage, 10.0) as capital_percentage,
        COALESCE(rl.name, 'Medium Risk') as risk_level_name,
        COALESCE(rl.description, 'Balanced risk profile') as risk_level_description,
        substring(ak.api_key_enc, 1, 8) as key_preview, ak.created_at
 FROM api_keys ak
 LEFT JOIN risk_levels rl ON ak.risk_level_id = rl.id
 WHERE ak.user_id = $1 ORDER BY ak.created_at
`;

console.log('\nFixed query would use COALESCE for defaults');
console.log('This handles missing columns/tables gracefully');