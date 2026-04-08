// ============================================================
// Kronos AI Prediction — Node.js wrapper
// Calls kronos-predict.py and returns prediction as JSON
// ============================================================

const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'kronos-predict.py');
const TIMEOUT_MS = 60_000; // 60s — model inference takes ~10s on CPU
const PYTHON_CMD = 'python';

/**
 * Get Kronos AI prediction for a symbol.
 * @param {string} symbol - e.g., "BTCUSDT"
 * @param {string} interval - e.g., "15m", "1h"
 * @param {number} predLen - number of future candles to predict
 * @returns {Promise<{direction: string, current: number, predicted: number, change_pct: number, confidence: string, trend: string}>}
 */
function getKronosPrediction(symbol, interval = '15m', predLen = 20) {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT_PATH, symbol, interval, String(predLen)];

    execFile(PYTHON_CMD, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[Kronos] Error for ${symbol}: ${err.message}`);
        resolve({ direction: 'NEUTRAL', error: err.message });
        return;
      }

      try {
        // Parse the last line of stdout (JSON output)
        const lines = stdout.trim().split('\n');
        const jsonLine = lines[lines.length - 1];
        const result = JSON.parse(jsonLine);
        return resolve(result);
      } catch (parseErr) {
        console.error(`[Kronos] Parse error: ${parseErr.message}, stdout: ${stdout}`);
        resolve({ direction: 'NEUTRAL', error: 'Parse failed' });
      }
    });
  });
}

module.exports = { getKronosPrediction };
