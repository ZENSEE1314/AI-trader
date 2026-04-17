// Persistent loop — runs cycle every minute + trail watchdog every 15s
const { spawn } = require('child_process');
const path = require('path');
const { runNightlyAnalysis } = require('./nightly-analysis');

const INTERVAL_MIN = 1;
const CYCLE_TIMEOUT_MS = 4 * 60 * 1000;
const NIGHTLY_CHECK_INTERVAL_MS = 60 * 1000;
const NIGHTLY_JAKARTA_HOUR = 22;
const botDir = __dirname;

let lastNightlyRunDate = null;
let cycleRunning = false;
let trailWatchdog = null;

function log(msg) {
  const t = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' });
  console.log(`[${t}] ${msg}`);
}

function getJakartaDate() {
  const now = new Date();
  const jakartaStr = now.toLocaleString('en-CA', { timeZone: 'Asia/Jakarta' });
  return {
    date: jakartaStr.split(',')[0].trim(),
    hour: parseInt(now.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false })),
  };
}

async function checkNightlySchedule() {
  try {
    const jakarta = getJakartaDate();
    if (jakarta.hour === NIGHTLY_JAKARTA_HOUR && lastNightlyRunDate !== jakarta.date) {
      lastNightlyRunDate = jakarta.date;
      log('── Running nightly analysis ──');
      await runNightlyAnalysis();
      log('── Nightly analysis complete ──');
    }
  } catch (e) {
    log(`Nightly analysis error: ${e.message}`);
  }
}

function runCycle() {
  if (cycleRunning) {
    log('── Cycle still running, skipping ──');
    return;
  }

  cycleRunning = true;
  log('── Running cycle ──');

  const child = spawn('node', [path.join(botDir, 'cycle.js')], {
    cwd: botDir,
    stdio: 'inherit',
  });

  const timer = setTimeout(() => {
    log('Cycle timeout — killing process');
    child.kill('SIGTERM');
  }, CYCLE_TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(timer);
    cycleRunning = false;
    if (code !== 0) log(`Cycle exited with code ${code}`);
    log(`── Next cycle in ${INTERVAL_MIN} minutes ──\n`);
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    cycleRunning = false;
    log(`Cycle error: ${err.message}`);
  });
}

function startTrailWatchdog() {
  if (trailWatchdog) return; // already running
  trailWatchdog = spawn('node', [path.join(botDir, 'trail-watchdog.js')], {
    cwd: botDir,
    stdio: 'inherit',
  });
  trailWatchdog.on('close', (code) => {
    log(`Trail watchdog exited (code ${code}) — restarting in 5s`);
    trailWatchdog = null;
    setTimeout(startTrailWatchdog, 5000);
  });
  trailWatchdog.on('error', (err) => {
    log(`Trail watchdog error: ${err.message} — restarting in 5s`);
    trailWatchdog = null;
    setTimeout(startTrailWatchdog, 5000);
  });
  log('Trail watchdog started (15s interval)');
}

log(`===================================`);
log(`  CryptoBot Loop Started`);
log(`  Cycle: every ${INTERVAL_MIN} minutes`);
log(`  Trail SL: every 15 seconds`);
log(`  Nightly analysis: ${NIGHTLY_JAKARTA_HOUR}:00 Jakarta`);
log(`===================================\n`);

// Start trail watchdog first (runs continuously)
startTrailWatchdog();

// Run cycle immediately, then every minute
runCycle();
setInterval(runCycle, INTERVAL_MIN * 60 * 1000);

// Check nightly schedule every minute
setInterval(checkNightlySchedule, NIGHTLY_CHECK_INTERVAL_MS);
