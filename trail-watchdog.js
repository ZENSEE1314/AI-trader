// ============================================================
// Trailing SL Watchdog — runs every 15 seconds
// Two mechanisms combined, takes the better (higher protection):
//   1. Candle trail  — SL = lowest low of last 2 completed 15m candles,
//                      with minimum 0.5% breathing room from current price
//   2. Profit tiers  — milestone locks with generous gaps so trades have room to run
// ============================================================

const fetch = require('node-fetch');
const { BitunixClient } = require('./bitunix-client');
const { USDMClient } = require('binance');
const { getFetchOptions, getBinanceRequestOptions } = require('./proxy-agent');

const INTERVAL_MS = 15 * 1000;
const db = require('./db');

// Taker fee: 0.04% entry + 0.04% exit = 0.08% of notional both legs
// In margin % = 0.08% × leverage  (e.g. 20x = 1.6%, 100x = 8%)
const TAKER_FEE_BOTH_LEGS = 0.0008; // 0.08% of notional

// Profit tier guarantees — all values in capital % (margin)
// Gaps are wide so trades have room to breathe and not get stopped prematurely.
// Fee floor (dynamic, computed per-trade below) is the only early trigger.
const TRAIL_TIERS = [
  { trigger: 0.20, sl: 0.10  }, // +20%  → lock 10%  (gap=10%)
  { trigger: 0.35, sl: 0.22  }, // +35%  → lock 22%  (gap=13%)
  { trigger: 0.50, sl: 0.35  }, // +50%  → lock 35%  (gap=15%)
  { trigger: 0.70, sl: 0.55  }, // +70%  → lock 55%  (gap=15%)
  { trigger: 0.90, sl: 0.75  }, // +90%  → lock 75%  (gap=15%)
  { trigger: 1.20, sl: 1.05  }, // +120% → lock 105% (gap=15%)
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
// Also enforces a FEE FLOOR: once profit > fees+1%, SL can never go below
// entry + fees + 1% profit so you NEVER lose a cent on a winning trade.
function calcTierSlPrice(entryPrice, curPrice, isLong, leverage) {
  const pricePct = isLong
    ? (curPrice - entryPrice) / entryPrice
    : (entryPrice - curPrice) / entryPrice;
  const capitalPct = pricePct * leverage;

  // Dynamic fee floor: fees (both legs) + 1% profit buffer, in capital %
  const feesCapital   = TAKER_FEE_BOTH_LEGS * leverage; // e.g. 20x→1.6%, 100x→8%
  const feeFloorCap   = feesCapital + 0.01;             // fees + 1% = absolute minimum lock
  const feeFloorPrice = isLong
    ? entryPrice * (1 + feeFloorCap / leverage)
    : entryPrice * (1 - feeFloorCap / leverage);

  // Tier lookup
  let bestSlCapital = null;
  for (const tier of TRAIL_TIERS) {
    if (capitalPct >= tier.trigger) bestSlCapital = tier.sl;
  }

  // Apply fee floor as soon as profit covers fees+1%
  if (capitalPct >= feeFloorCap) {
    const feeFloorSl = feeFloorCap;
    if (bestSlCapital === null || feeFloorSl > bestSlCapital) bestSlCapital = feeFloorSl;
  }

  if (bestSlCapital === null) return null;

  const slPricePct = bestSlCapital / leverage;
  return isLong
    ? entryPrice * (1 + slPricePct)
    : entryPrice * (1 - slPricePct);
}

// Minimum price distance between SL and current price (0.5%)
// Prevents SL from being placed too close and getting clipped by normal volatility
const MIN_SL_DISTANCE = 0.005;

// Structural SL based on the lowest low of the last 2 completed 15m candles.
// Uses 2 candles (not 1) for wider structural support.
// Enforces MIN_SL_DISTANCE from current price so the trade has breathing room.
async function calcCandleSlPrice(symbol, isLong, currentSl, curPrice) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=5`;
    const res = await fetch(url, { timeout: 6000, ...getFetchOptions() });
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 3) return null;

    // Last 2 completed candles (exclude the forming candle at index -1)
    const c1 = data[data.length - 2];
    const c2 = data[data.length - 3];

    // For LONG: use the lowest low of both candles — deeper structural support
    // For SHORT: use the highest high — deeper structural resistance
    const structLow  = Math.min(parseFloat(c1[3]), parseFloat(c2[3]));
    const structHigh = Math.max(parseFloat(c1[2]), parseFloat(c2[2]));

    if (isLong) {
      // Reject if candle low is too close to current price — no breathing room
      if (structLow > curPrice * (1 - MIN_SL_DISTANCE)) return null;
      if (structLow > currentSl) return structLow;
    } else {
      // Reject if candle high is too close to current price
      if (structHigh < curPrice * (1 + MIN_SL_DISTANCE)) return null;
      if (structHigh < currentSl) return structHigh;
    }
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

        // Mechanism 2: Candle structural trail (last 2 candles, min 0.5% from price)
        const candleSl = await calcCandleSlPrice(trade.symbol, isLong, currentSl, curPrice);

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

// ── Orphan Position Guard ──────────────────────────────────
// Positions that exist on exchange but NOT in DB have no SL protection.
// If they lose more than 25% capital with no stop, this guard closes them.
// Runs every 2 minutes (less aggressive than main trail cycle).

const ORPHAN_LOSS_THRESHOLD = 0.25; // auto-close at -25% capital loss
const ORPHAN_CHECK_INTERVAL = 2 * 60 * 1000; // every 2 minutes

async function runOrphanGuard() {
  try {
    // Get all DB-tracked open trades to know which are already managed
    const dbTrades = await db.query(
      `SELECT t.symbol, ak.id as key_id
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE t.status = 'OPEN' AND ak.enabled = true`
    );
    const managed = new Set(dbTrades.map(r => `${r.key_id}:${r.symbol}`));

    // Get all active Bitunix API keys
    const keys = await db.query(
      `SELECT ak.id, ak.api_key, ak.api_secret, ak.leverage, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.platform = 'bitunix' AND ak.enabled = true`
    );

    for (const key of keys) {
      try {
        const client = new BitunixClient({ apiKey: key.api_key, apiSecret: key.api_secret });
        const raw = await Promise.race([
          client.getOpenPositions(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
        const positions = Array.isArray(raw) ? raw
          : (raw?.positionList || raw?.list || []);

        for (const p of positions) {
          const qty = parseFloat(p.qty || p.size || 0);
          if (qty === 0) continue;

          const sym = (p.symbol || '').toUpperCase();
          const posKey = `${key.id}:${sym}`;

          // Skip if this position is DB-managed (trail watchdog handles it)
          if (managed.has(posKey)) continue;

          const entry     = parseFloat(p.entryPrice || p.avgOpenPrice || 0);
          const isLong    = (p.side || '').toUpperCase() === 'BUY';
          const lev       = parseFloat(p.leverage || key.leverage || 20);
          const upnl      = parseFloat(p.unrealizedPNL || p.unrealizedPnl || 0);

          // Calculate approximate capital loss %
          const curPrice = await getLivePrice(sym);
          if (!curPrice || entry === 0) continue;

          const pricePct  = isLong ? (curPrice - entry) / entry : (entry - curPrice) / entry;
          const capitalPct = pricePct * lev;

          if (capitalPct >= -ORPHAN_LOSS_THRESHOLD) continue; // not bad enough yet

          log(`⚠ ORPHAN ${sym} ${isLong ? 'LONG' : 'SHORT'} [${key.email}] — no DB record, ${(capitalPct * 100).toFixed(1)}% capital loss — AUTO-CLOSING`);

          // Market close: place a market order in the opposite direction
          try {
            const posData = await client.getOpenPositions(sym);
            const posList = Array.isArray(posData) ? posData
              : (posData?.positionList || posData?.list || []);
            const pos   = posList.find(x => (x.symbol || '').toUpperCase() === sym);
            const posId = pos ? (pos.positionId || pos.id) : null;

            if (posId) {
              await client.placeOrder({
                symbol: sym,
                side: isLong ? 'SELL' : 'BUY',
                orderType: 'MARKET',
                qty: String(qty),
                positionId: posId,
                reduceOnly: true,
              });
              log(`✓ ORPHAN ${sym} closed — saved from further loss`);
            }
          } catch (closeErr) {
            log(`ORPHAN close failed ${sym}: ${closeErr.message}`);
          }
        }
      } catch (keyErr) {
        // Key unavailable — skip silently
      }
    }
  } catch (e) {
    log(`runOrphanGuard error: ${e.message}`);
  }
}

log('Trail watchdog started — 15s interval | 2-candle trail (0.5% min gap) + profit tier');
log('Orphan guard started — 2min interval | auto-close unmanaged positions > -25% capital');
runTrailCycle();
setInterval(runTrailCycle, INTERVAL_MS);

// Stagger orphan guard by 30s so it doesn't overlap with first trail cycle
setTimeout(() => {
  runOrphanGuard();
  setInterval(runOrphanGuard, ORPHAN_CHECK_INTERVAL);
}, 30000);
