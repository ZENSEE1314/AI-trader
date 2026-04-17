// ============================================================
// Trailing SL Watchdog — runs every 15 seconds
// Two mechanisms combined, takes the better (higher protection):
//   1. Candle trail  — SL = last completed 15m candle low/high
//   2. Profit tiers  — at 30% profit, SL locks 20% minimum (never lose a winner)
// ============================================================

const fetch = require('node-fetch');
const { BitunixClient } = require('./bitunix-client');
const { USDMClient } = require('binance');
const { getFetchOptions, getBinanceRequestOptions } = require('./proxy-agent');

const INTERVAL_MS = 15 * 1000;
const db = require('./db');

// Profit tier guarantees — capital % (margin)
// At 30% profit → SL locks minimum 20% so you NEVER give back more than 10%
const TRAIL_TIERS = [
  { trigger: 0.10, sl: 0.05  }, // +10% → lock 5%
  { trigger: 0.20, sl: 0.12  }, // +20% → lock 12%
  { trigger: 0.30, sl: 0.20  }, // +30% → lock 20%  (user: min 15%, we do 20%)
  { trigger: 0.45, sl: 0.35  }, // +45% → lock 35%
  { trigger: 0.60, sl: 0.50  }, // +60% → lock 50%
  { trigger: 0.80, sl: 0.70  }, // +80% → lock 70%
  { trigger: 1.00, sl: 0.90  }, // +100% → lock 90%
];

function log(msg) {
  const t = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' });
  console.log(`[TRAIL ${t}] ${msg}`);
}

function inferPricePrec(storedPrice) {
  const s = String(parseFloat(storedPrice) || 0);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Get live mark price from Binance public API (works for both exchanges)
async function getLivePrice(symbol) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
      { timeout: 5000, ...getFetchOptions() }
    );
    const d = await res.json();
    const p = parseFloat(d.price);
    return p > 0 ? p : null;
  } catch (e) {
    return null;
  }
}

// Tier-based minimum SL price — guarantees profit lock at milestone levels
function calcTierSlPrice(entryPrice, curPrice, isLong, leverage) {
  const pricePct = isLong
    ? (curPrice - entryPrice) / entryPrice
    : (entryPrice - curPrice) / entryPrice;
  const capitalPct = pricePct * leverage;

  let bestSlCapital = null;
  for (const tier of TRAIL_TIERS) {
    if (capitalPct >= tier.trigger) bestSlCapital = tier.sl;
  }
  if (bestSlCapital === null) return null;

  const slPricePct = bestSlCapital / leverage;
  return isLong
    ? entryPrice * (1 + slPricePct)
    : entryPrice * (1 - slPricePct);
}

// Last completed 15m candle structural SL
async function calcCandleSlPrice(symbol, isLong, currentSl) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=3`;
    const res = await fetch(url, { timeout: 6000, ...getFetchOptions() });
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return null;

    const completed = data[data.length - 2];
    const candleLow  = parseFloat(completed[3]);
    const candleHigh = parseFloat(completed[2]);

    if (isLong  && candleLow  > currentSl) return candleLow;
    if (!isLong && candleHigh < currentSl) return candleHigh;
    return null;
  } catch (e) {
    log(`calcCandleSlPrice ${symbol}: ${e.message}`);
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
    if (!pos || !posId) { log(`Bitunix: no position found for ${symbol}`); return false; }
    const payload = { symbol, positionId: posId, slPrice: String(newSlPrice.toFixed(pricePrec)) };
    if (existingTp) payload.tpPrice = String(parseFloat(existingTp).toFixed(pricePrec));
    await client.placePositionTpSl(payload);
    return true;
  } catch (e) {
    log(`Bitunix updateSL ${symbol}: ${e.message}`);
    return false;
  }
}

async function updateSlBinance(client, symbol, newSlPrice, isLong, pricePrec) {
  try {
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
    const trades = await db.query(`
      SELECT t.id, t.symbol, t.direction, t.entry_price, t.sl_price,
             t.trailing_sl_price, t.tp_price, t.leverage,
             ak.platform, ak.api_key, ak.api_secret
      FROM trades t
      JOIN api_keys ak ON ak.id = t.api_key_id
      WHERE t.status = 'OPEN' AND ak.enabled = true
    `);

    if (!trades.length) return;

    for (const trade of trades) {
      try {
        const isLong     = trade.direction !== 'SHORT';
        const currentSl  = parseFloat(trade.trailing_sl_price) || parseFloat(trade.sl_price) || 0;
        const pricePrec  = inferPricePrec(trade.sl_price);
        const entryPrice = parseFloat(trade.entry_price);
        const leverage   = parseFloat(trade.leverage) || 20;

        // Get live price
        const curPrice = await getLivePrice(trade.symbol);
        if (!curPrice) continue;

        const profitPct = isLong
          ? (curPrice - entryPrice) / entryPrice
          : (entryPrice - curPrice) / entryPrice;
        const capitalPct = profitPct * leverage;

        // Mechanism 1: Profit tier guarantee
        const tierSl = calcTierSlPrice(entryPrice, curPrice, isLong, leverage);

        // Mechanism 2: Candle structural trail
        const candleSl = await calcCandleSlPrice(trade.symbol, isLong, currentSl);

        // Take the BETTER of the two (highest SL for LONG, lowest for SHORT)
        let bestSl = currentSl;
        if (tierSl) bestSl = isLong ? Math.max(bestSl, tierSl) : Math.min(bestSl, tierSl);
        if (candleSl) bestSl = isLong ? Math.max(bestSl, candleSl) : Math.min(bestSl, candleSl);

        // Only update if improved beyond current SL
        const improved = isLong ? bestSl > currentSl + 0.001 : bestSl < currentSl - 0.001;
        if (!improved) continue;

        const source = [];
        if (tierSl && (isLong ? tierSl > currentSl : tierSl < currentSl)) source.push(`tier(+${(capitalPct*100).toFixed(0)}%cap)`);
        if (candleSl && (isLong ? candleSl > currentSl : candleSl < currentSl)) source.push('candle');

        log(`${trade.symbol} ${isLong ? 'LONG' : 'SHORT'} [${source.join('+')}] SL: $${currentSl.toFixed(pricePrec)} → $${bestSl.toFixed(pricePrec)} | profit +${(capitalPct*100).toFixed(1)}% capital`);

        let updated = false;
        if (trade.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey: trade.api_key, apiSecret: trade.api_secret });
          updated = await updateSlBitunix(client, trade.symbol, bestSl, pricePrec, trade.tp_price);
        } else if (trade.platform === 'binance') {
          const client = new USDMClient(
            { api_key: trade.api_key, api_secret: trade.api_secret },
            getBinanceRequestOptions()
          );
          updated = await updateSlBinance(client, trade.symbol, bestSl, isLong, pricePrec);
        }

        if (updated) {
          await db.query(
            `UPDATE trades SET trailing_sl_price = $1 WHERE id = $2`,
            [bestSl, trade.id]
          );
          log(`✓ ${trade.symbol} SL locked → $${bestSl.toFixed(pricePrec)}`);
        }
      } catch (e) {
        log(`Error ${trade.symbol}: ${e.message}`);
      }
    }
  } catch (e) {
    log(`runTrailCycle error: ${e.message}`);
  }
}

log('Trail watchdog started — 15s interval | candle trail + profit tier');
runTrailCycle();
setInterval(runTrailCycle, INTERVAL_MS);
