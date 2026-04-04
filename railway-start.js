#!/usr/bin/env node

// Railway startup script - runs both web server and trading bot
const { spawn } = require('child_process');
const path = require('path');

console.log('🚂 Railway AI-Trader Startup');
console.log('=============================');
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Port: ${process.env.PORT || 3000}`);
console.log('');

// Check required environment variables
const requiredEnvVars = [
  'DATABASE_URL',
  'JWT_SECRET',
  'TELEGRAM_TOKEN',
  'TELEGRAM_CHAT_ID'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('\nPlease set these in Railway dashboard → Variables');
  process.exit(1);
}

console.log('✅ All required environment variables are set');

// Start processes
const processes = [];

// Start web server
console.log('\n🌐 Starting web server...');
const webServer = spawn('node', ['server.js'], {
  stdio: 'inherit',
  env: process.env
});
processes.push(webServer);

webServer.on('error', (err) => {
  console.error('❌ Web server failed to start:', err.message);
});

// Wait a bit for web server to start
setTimeout(() => {
  // Start trading bot
  console.log('\n🤖 Starting trading bot...');
  const tradingBot = spawn('node', ['bot.js'], {
    stdio: 'inherit',
    env: process.env
  });
  processes.push(tradingBot);

  tradingBot.on('error', (err) => {
    console.error('❌ Trading bot failed to start:', err.message);
  });
}, 3000);

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down...');
  processes.forEach(proc => proc.kill('SIGINT'));
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down...');
  processes.forEach(proc => proc.kill('SIGTERM'));
  process.exit(0);
});

// Keep process alive
setInterval(() => {
  // Heartbeat
}, 60000);

console.log('\n✅ AI-Trader is running on Railway!');
console.log('📊 Health check: https://your-railway-url.up.railway.app/health');
console.log('📱 Web interface: https://your-railway-url.up.railway.app');
console.log('\nPress Ctrl+C to stop');