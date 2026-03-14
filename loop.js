// Persistent loop — runs cycle every 30 minutes forever
const { execSync } = require('child_process');
const path = require('path');

const INTERVAL_MIN = 30;
const botDir = __dirname;

function log(msg) {
  const t = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' });
  console.log(`[${t}] ${msg}`);
}

async function runCycle() {
  log(`── Running cycle ──`);
  try {
    execSync(`node "${path.join(botDir, 'cycle.js')}"`, {
      cwd: botDir,
      stdio: 'inherit',
      timeout: 4 * 60 * 1000, // 4 min max
    });
  } catch(e) {
    log(`Cycle error: ${e.message}`);
  }
  log(`── Next cycle in ${INTERVAL_MIN} minutes ──\n`);
}

log(`===================================`);
log(`  CryptoBot Loop Started`);
log(`  Interval: every ${INTERVAL_MIN} minutes`);
log(`===================================\n`);

// Run immediately, then every 30 min
runCycle();
setInterval(runCycle, INTERVAL_MIN * 60 * 1000);
