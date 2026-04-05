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
const criticalVars = ['DATABASE_URL'];
const recommendedVars = ['JWT_SECRET', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID'];

const missingCritical = criticalVars.filter(v => !process.env[v]);
const missingRecommended = recommendedVars.filter(v => !process.env[v]);

if (missingCritical.length > 0) {
  console.error('❌ Missing critical environment variables:');
  missingCritical.forEach(v => console.error(`   - ${v}`));
  console.error('\nPlease set these in Railway dashboard → Variables');
  process.exit(1);
}

if (missingRecommended.length > 0) {
  console.warn('⚠️  Missing recommended environment variables:');
  missingRecommended.forEach(v => console.warn(`   - ${v}`));
  console.warn('Bot will start but some features may not work.\n');
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

// Wait a bit for web server to start, then launch bot with auto-restart
setTimeout(() => {
  function startBot() {
    console.log('\n🤖 Starting trading bot...');
    const tradingBot = spawn('node', ['bot.js'], {
      stdio: 'inherit',
      env: { ...process.env, SKIP_SERVER: '1' }
    });
    processes.push(tradingBot);

    tradingBot.on('error', (err) => {
      console.error('❌ Trading bot failed to start:', err.message);
    });

    tradingBot.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`⚠️  Trading bot exited with code ${code}, restarting in 10s...`);
        setTimeout(startBot, 10000);
      }
    });
  }
  startBot();
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