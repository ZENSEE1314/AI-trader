// ============================================================
// Trailing SL Watchdog — runs every 15 seconds
// Moves SL to last completed 15m candle low (LONG) or high (SHORT)
// Operates independently of the main cycle so trailing is always live
// ============================================================

const fetch = require('node-fetch');
const { BitunixClient } = require('./bitunix-client');
const { USDMClient } = require('binance');
const { getFetchOptions, getBinanceRequestOptions } = require('./proxy-agent');

const INTERVAL_MS = 15 * 1000; // 15 seconds
const db = require('./db');

function log(msg) {
  const t = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' });
  console.log(`[TRAIL ${t}] ${msg}`);
}

function inferPricePrec(storedPrice) {
  const s = String(parseFloat(storedPrice) || 0);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Fetch last completed 15m candle low (LONG) or high (SHORT)
async function getCandleTrailSl(symbol, isLong, currentSl) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=3`;
    const res = await fetch(url, { timeout: 6000, ...getFetchOptions() });
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return null;

    // Last item is still-forming — use second-to-last
    const completed = data[data.length - 2];
    const candleLow  = parseFloat(completed[3]);
    const candleHigh = parseFloat(completed[2]);

    if (isLong  && candleLow  > currentSl) return candleLow;
    if (!isLong && candleHigh < currentSl) return candleHigh;
    return null;
  } catch (e) {
    log(`getCandleTrailSl ${symbol}: ${e.message}`);
    return null;
  }
}

async function updateSlBitunix(client, symbol, newSlPrice, pricePrec, existingTp) {
  try {
    const posData = await client.getOpenPositions(symbol);
    const posList = Array.isArray(posData) ? posData
      : (posData?.positionList || posData?.list || (posData && typeof posData === 'object' ? [posData] : []));
    const pos = posList.find(p => p.symbol === symbol);
    const posId = pos ? (pos.positionId || pos.id) : null;
    if (!pos || !posId) {
      log(`Bitunix: no open position found for ${symbol}`);
      return false;
    }
    const payload = { symbol, positionId: posId, slPrice: String(newSlPrice.toFixed(pricePrec)) };
    if (existingTp) payload.tpPrice = String(parseFloat(existingTp).toFixed(pricePrec));
    await client.placePositionTpSl(payload);
    return true;
  } catch (e) {
    log(`Bitunix updateSL ${symbol}: ${e.message}`);
    return false;
  }
}

async function updateSlBinance(client, symbol, newSlPrice, isLong, pricePrec, existingTp) {
  try {
    // Cancel existing stop orders
    const openOrders = await client.getAllOpenOrders({ symbol });
    const stops = (openOrders || []).filter(o =>
      o.type === 'STOP_MARKET' || o.type === 'STOP' || o.origType === 'STOP_MARKET'
    );
    for (const o of stops) {
      try { await client.cancelOrder({ symbol, orderId: o.orderId }); } catch (_) {}
    }
    await client.submitNewOrder({
      symbol,
      side: isLong ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      stopPrice: newSlPrice.toFixed(pricePrec),
      closePosition: 'true',
      timeInForce: 'GTC',
      workingType: 'MARK_PRICE',
    });
    return true;
  } catch (e) {
    log(`Binance updateSL ${symbol}: ${e.message}`);
    return false;
  }
}

async function runTrailCycle() {
  try {
    // Load all open trades with their api key info
    const trades = await db.query(`
      SELECT t.id, t.symbol, t.direction, t.entry_price, t.sl_price,
             t.trailing_sl_price, t.trailing_sl_last_step, t.tp_price,
             t.leverage, t.user_id,
             ak.platform, ak.api_key, ak.api_secret
      FROM trades t
      JOIN api_keys ak ON ak.id = t.api_key_id
      WHERE t.status = 'OPEN'
        AND ak.enabled = true
    `);

    if (!trades.length) return;

    for (const trade of trades) {
      try {
        const isLong     = trade.direction !== 'SHORT';
        const currentSl  = parseFloat(trade.trailing_sl_price) || parseFloat(trade.sl_price) || 0;
        const pricePrec  = inferPricePrec(trade.sl_price);
        const entryPrice = parseFloat(trade.entry_price);

        // Get candle trail SL
        const newSl = await getCandleTrailSl(trade.symbol, isLong, currentSl);
        if (!newSl) continue;

        // Safety: don't set SL beyond entry if trade isn't profitable yet
        // Allow slight tolerance (0.05%) to avoid flip-flopping at entry
        const slOnWrongSide = isLong
          ? (newSl < entryPrice * 0.9995 && currentSl < entryPrice * 0.9995)
          : (newSl > entryPrice * 1.0005 && currentSl > entryPrice * 1.0005);
        // Always allow improvement even if still at loss — candle low is a valid SL
        // but reject if new SL would be WORSE than current (move against trade)
        const isImprovement = isLong ? newSl > currentSl : newSl < currentSl;
        if (!isImprovement) continue;

        log(`${trade.symbol} ${isLong ? 'LONG' : 'SHORT'} trail SL: $${currentSl.toFixed(pricePrec)} → $${newSl.toFixed(pricePrec)} (15m candle ${isLong ? 'low' : 'high'})`);

        let updated = false;
        if (trade.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey: trade.api_key, apiSecret: trade.api_secret });
          updated = await updateSlBitunix(client, trade.symbol, newSl, pricePrec, trade.tp_price);
        } else if (trade.platform === 'binance') {
          const client = new USDMClient(
            { api_key: trade.api_key, api_secret: trade.api_secret },
            getBinanceRequestOptions()
          );
          updated = await updateSlBinance(client, trade.symbol, newSl, isLong, pricePrec, trade.tp_price);
        }

        if (updated) {
          await db.query(
            `UPDATE trades SET trailing_sl_price = $1 WHERE id = $2`,
            [newSl, trade.id]
          );
          log(`✓ ${trade.symbol} SL updated → $${newSl.toFixed(pricePrec)}`);
        }
      } catch (e) {
        log(`Error processing ${trade.symbol}: ${e.message}`);
      }
    }
  } catch (e) {
    log(`runTrailCycle error: ${e.message}`);
  }
}

log('Trail watchdog started — running every 15 seconds');

// Run immediately, then every 15 seconds
runTrailCycle();
setInterval(runTrailCycle, INTERVAL_MS);
