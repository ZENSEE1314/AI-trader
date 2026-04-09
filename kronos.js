// ============================================================
// Kronos AI Prediction — Node.js wrapper + batch scanner
// Calls kronos-predict.py and returns predictions as JSON
// Batch mode: predict all tokens, store results, share with agents
// ============================================================

const { execFile } = require('child_process');
const path = require('path');
const { log: bLog } = require('./bot-logger');

const SCRIPT_PATH = path.join(__dirname, 'kronos-predict.py');
const TIMEOUT_MS = 60_000;
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

// Shared prediction cache — agents read from here
const predictions = new Map();
let lastScanTime = 0;
const CACHE_TTL_MS = 3 * 60_000; // 3 min cache — matches cycle interval

/**
 * Get Kronos AI prediction for a single symbol.
 */
function getKronosPrediction(symbol, interval = '15m', predLen = 20) {
  return new Promise((resolve) => {
    const args = [SCRIPT_PATH, symbol, interval, String(predLen)];

    execFile(PYTHON_CMD, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.error(`[Kronos] Error for ${symbol}: ${err.message}`);
        reject(new Error(`Kronos prediction failed: ${err.message}`));
        return;
      }

      try {
        const lines = stdout.trim().split('\n');
        const jsonLine = lines[lines.length - 1];
        const result = JSON.parse(jsonLine);
        result.symbol = symbol;
        resolve(result);
      } catch (parseErr) {
        console.error(`[Kronos] Parse error: ${parseErr.message}, stdout: ${stdout}`);
        reject(new Error(`Kronos parse failed: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Batch scan all symbols with Kronos. Runs predictions in parallel batches.
 * @param {string[]} symbols - Array of symbols to predict
 * @param {string} interval - Candle interval
 * @param {number} predLen - Number of future candles
 * @param {number} concurrency - Max parallel predictions (limit to avoid overload)
 * @returns {Promise<Map<string, object>>} Map of symbol → prediction
 */
async function scanAllTokens(symbols, interval = '15m', predLen = 20, concurrency = 3) {
  if (!symbols || symbols.length === 0) return predictions;

  bLog.ai(`Kronos scanning ${symbols.length} tokens (${interval}, ${predLen} candles)...`);
  const startTime = Date.now();

  predictions.clear();
  const results = [];

  // Process in batches to limit CPU/memory load
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(sym => getKronosPrediction(sym, interval, predLen))
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      // Rejected predictions are silently skipped in batch mode
    }
  }

  // Store in cache
  for (const pred of results) {
    if (pred && pred.symbol) {
      predictions.set(pred.symbol, pred);
    }
  }

  lastScanTime = Date.now();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Categorize results
  const longs = results.filter(r => r.direction === 'LONG');
  const shorts = results.filter(r => r.direction === 'SHORT');
  const neutrals = results.filter(r => r.direction === 'NEUTRAL');
  const errors = results.filter(r => r.error);

  bLog.ai(`Kronos scan done in ${elapsed}s: ${longs.length} LONG, ${shorts.length} SHORT, ${neutrals.length} NEUTRAL, ${errors.length} errors`);

  return predictions;
}

/**
 * Get cached prediction for a symbol.
 * Returns null if cache is stale or symbol not scanned.
 */
function getCachedPrediction(symbol) {
  if (Date.now() - lastScanTime > CACHE_TTL_MS) return null;
  return predictions.get(symbol) || null;
}

/**
 * Get all cached predictions as array (sorted by absolute change_pct descending).
 */
function getAllPredictions() {
  if (Date.now() - lastScanTime > CACHE_TTL_MS) return [];
  return Array.from(predictions.values())
    .filter(p => !p.error)
    .sort((a, b) => Math.abs(b.change_pct || 0) - Math.abs(a.change_pct || 0));
}

/**
 * Build a Telegram-friendly summary of all predictions.
 */
function formatPredictionSummary() {
  const all = getAllPredictions();
  if (!all.length) return null;

  const longs = all.filter(p => p.direction === 'LONG').sort((a, b) => b.change_pct - a.change_pct);
  const shorts = all.filter(p => p.direction === 'SHORT').sort((a, b) => a.change_pct - b.change_pct);
  const neutrals = all.filter(p => p.direction === 'NEUTRAL');

  let msg = `🔮 *Kronos AI Scan* — ${all.length} tokens\n`;

  if (longs.length) {
    msg += `\n📈 *BULLISH (${longs.length})*\n`;
    for (const p of longs.slice(0, 10)) {
      const conf = p.confidence === 'high' ? '🔥' : p.confidence === 'medium' ? '⚡' : '·';
      msg += `${conf} \`${p.symbol.replace('USDT', '')}\` +${p.change_pct}% (${p.trend})\n`;
    }
    if (longs.length > 10) msg += `  _...+${longs.length - 10} more_\n`;
  }

  if (shorts.length) {
    msg += `\n📉 *BEARISH (${shorts.length})*\n`;
    for (const p of shorts.slice(0, 10)) {
      const conf = p.confidence === 'high' ? '🔥' : p.confidence === 'medium' ? '⚡' : '·';
      msg += `${conf} \`${p.symbol.replace('USDT', '')}\` ${p.change_pct}% (${p.trend})\n`;
    }
    if (shorts.length > 10) msg += `  _...+${shorts.length - 10} more_\n`;
  }

  if (neutrals.length) {
    msg += `\n➖ *NEUTRAL*: ${neutrals.map(p => p.symbol.replace('USDT', '')).join(', ')}\n`;
  }

  // Top movers
  const topMovers = all.filter(p => p.confidence === 'high');
  if (topMovers.length) {
    msg += `\n⭐ *High Confidence*: `;
    msg += topMovers.map(p => `${p.symbol.replace('USDT', '')} ${p.direction} ${p.change_pct > 0 ? '+' : ''}${p.change_pct}%`).join(', ');
    msg += '\n';
  }

  return msg;
}

module.exports = {
  getKronosPrediction,
  scanAllTokens,
  getCachedPrediction,
  getAllPredictions,
  formatPredictionSummary,
};
