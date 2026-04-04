// Debug script to test login/auth issues
const jwt = require('jsonwebtoken');

console.log('=== DEBUG LOGIN/AUTH ISSUES ===\n');

// Check environment
console.log('1. Environment Check:');
console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
console.log(`   JWT_SECRET: ${process.env.JWT_SECRET ? 'SET' : 'NOT SET'}`);
console.log(`   JWT_SECRET length: ${process.env.JWT_SECRET ? process.env.JWT_SECRET.length : 0}`);
console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? 'SET' : 'NOT SET'}`);

// Check if we can verify a token
console.log('\n2. JWT Test:');
if (process.env.JWT_SECRET) {
  try {
    // Create a test token
    const testToken = jwt.sign({ userId: 1, email: 'test@example.com' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    console.log(`   Test token created: ${testToken.substring(0, 20)}...`);
    
    // Verify it
    const decoded = jwt.verify(testToken, process.env.JWT_SECRET);
    console.log(`   Token verification: SUCCESS (user: ${decoded.email})`);
  } catch (err) {
    console.log(`   Token verification: FAILED - ${err.message}`);
  }
} else {
  console.log('   Cannot test JWT - JWT_SECRET not set');
}

// Check common issues
console.log('\n3. Common Dashboard Issues:');
console.log('   a) JWT_SECRET not set in Railway variables');
console.log('   b) Database connection failing');
console.log('   c) Cookie domain/issues (Railway uses different domain)');
console.log('   d) Frontend JavaScript errors');
console.log('   e) Authentication middleware failing');

console.log('\n4. Quick Fixes to Try:');
console.log('   1. Check Railway Variables → Set JWT_SECRET');
console.log('   2. Clear browser cookies for the site');
console.log('   3. Check browser console for JavaScript errors');
console.log('   4. Visit /health endpoint to see if server is running');
console.log('   5. Visit /status endpoint for debug info');

console.log('\n5. Railway-Specific Issues:');
console.log('   - Railway URL might be different from localhost');
console.log('   - Cookies might need SameSite=None, Secure=true for cross-domain');
console.log('   - JWT_SECRET must be the same across deployments');

console.log('\n=== END DEBUG ===');