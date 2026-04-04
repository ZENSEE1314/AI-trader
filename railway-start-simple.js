#!/usr/bin/env node

// Simple Railway startup script
console.log('🚀 AI-Trader Railway Startup');
console.log('============================');

// Log environment info
console.log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`PORT: ${process.env.PORT || 3000}`);
console.log(`DATABASE_URL: ${process.env.DATABASE_URL ? 'Set' : 'Not set'}`);
console.log(`TELEGRAM_TOKEN: ${process.env.TELEGRAM_TOKEN ? 'Set' : 'Not set'}`);

// Check minimal requirements
if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.warn('⚠️  WARNING: Telegram tokens not set. Bot notifications will not work.');
}

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  WARNING: DATABASE_URL not set. Using SQLite fallback.');
  process.env.DATABASE_URL = 'sqlite://./data/trades.db';
}

// Start the server
console.log('\n🌐 Starting web server...');
require('./start-server.js');

// Note: The trading bot (bot.js) should be started separately if needed
// or it can be started from within the server if configured that way
console.log('✅ Server started. Trading bot can be started separately if needed.');

// Simple health check response
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});