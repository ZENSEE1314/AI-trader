'use strict';
/**
 * Paged Binance USD-M futures kline fetch → raw arrays
 * [openTime(ms), open, high, low, close, volume, …] — the same shape the MCT
 * chart engine (routes/chart.js) consumes. Shared by the CLI runner and the
 * website backtest route. Requires outbound access to fapi.binance.com.
 */
const TF_MS = { '1h': 3_600_000, '15m': 900_000, '5m': 300_000, '1m': 60_000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchArr(symbol, interval, days, attempt = 0) {
  const need = Math.ceil((days * 86_400_000) / TF_MS[interval]);
  let all = [], end = Date.now();
  try {
    while (all.length < need) {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1500&endTime=${end}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
      const page = await res.json();
      if (!Array.isArray(page) || !page.length) break;
      all = page.concat(all);
      end = page[0][0] - 1;
      if (page.length < 1500) break;
      await sleep(250);
    }
  } catch (e) {
    if (attempt < 4 && /HTTP 4|HTTP 5|fetch failed|ECONN/.test(e.message)) {
      await sleep(1000 * Math.pow(2, attempt));
      return fetchArr(symbol, interval, days, attempt + 1);
    }
    throw e;
  }
  return all.slice(-need);
}

module.exports = { fetchArr, TF_MS };
