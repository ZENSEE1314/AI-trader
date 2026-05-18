'use strict';

const fetch = require('node-fetch');

const BINANCE_FAPI = 'https://fapi.binance.com';

/**
 * Fetch klines (candlestick data) from Binance Futures API.
 * Returns array of arrays: [openTime, open, high, low, close, volume]
 *
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} interval - e.g. '5m', '15m', '4h'
 * @param {number} limit - number of candles to fetch
 * @returns {Promise<Array>}
 */
async function fetchBitgetKlines(symbol, interval, limit = 100) {
  const url = `${BINANCE_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) {
    throw new Error(`Binance klines API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  // Binance returns: [openTime, open, high, low, close, volume, closeTime, ...]
  // Return in the format expected by strategy-homma-smc.js
  return data.map(k => [k[0], k[1], k[2], k[3], k[4], k[5]]);
}

module.exports = { fetchBitgetKlines };
