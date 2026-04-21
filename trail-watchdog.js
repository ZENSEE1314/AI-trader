// ============================================================
// Trailing SL Watchdog — runs every 15 seconds
//
// Two-stage trailing logic:
//   Stage 1 (30% capital profit) — move SL to lock 15% capital profit
//   Stage 2 (45% capital profit) — switch to candle structural trail
//
// Below 30% capital profit: SL stays at original entry SL (no trail).
// This gives trades room to breathe without premature closure.
// ============================================================

const fetch = require('node-fetch');
const { BitunixClient } = require('./bitunix-client');
const { USDMClient } = require('binance');
const { getFetchOptions, getBinanceRequestOptions } = require('./proxy-agent');
const cryptoUtils = require('./crypto-utils');

const INTERVAL_MS = 15 * 1000;
const db = require('./db');

// Trailing thresholds (capital profit %)
const TRAIL_ACTIVATE_CAP = 0.20; // don't trail below 20% capital profit — let trade breathe
const PROFIT_LOCK_PCT    = 0.60; // lock 60% of current profit (slides up as profit grows)
//   At 20% profit → SL at 12%  (still profitable after fees)
//   At 30% profit → SL at 18%
//   At 50% profit → SL at 30%
//   At 100% profit → SL at 60%
const CANDLE_TRAIL_CAP   = 0.35; // switch to candle structural trail at 35%+ capital profit

// Fees (capital %)
const TAKER_FEE_BOTH_LEGS = 0.0008; // 0.08% notional × leverage = taker in+out
const FUNDING_INTERVAL_H  = 8;      // funding charged every 8 hours
const FUNDING_FALLBACK    = 0.0001; // 0.01% per 8h if API unavailable

// Cache funding rates to avoid hammering Binance every 15s
const fundingRateCache = new Map(); // symbol → { rate, fetchedAt }
const FUNDING_CACHE_TTL = 5 * 60 * 1000; // refresh every 5 minutes

async function getFundingRate(symbol) {
  const now = Date.now();
  const cached = fundingRateCache.get(symbol);
  if (cached && now - cached.fetchedAt < FUNDING_CACHE_TTL) return cached.rate;
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
      { timeout: 4000, ...getFetchOptions() }
    );
    const d = await res.json();
    const rate = Math.abs(parseFloat(d.lastFundingRate) || FUNDING_FALLBACK);
    fundingRateCache.set(symbol, { rate, fetchedAt: now });
    return rate;
  } catch (_) {
    return FUNDING_FALLBACK;
  }
}

function log(msg) {
  const t = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' });
  console.log(`[TRAIL ${t}] ${msg}`);
}

async function notify(msg) {
  try {
    const token = process.env.TELEGRAM_TOKEN;
    const chats = (process.env.TELEGRAM_CHAT_ID || '').split(',').filter(Boolean);
    if (!token || !chats.length) return;
    for (const chatId of chats) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId.trim(), text: msg, parse_mode: 'Markdown' }),
        timeout: 5000, ...getFetchOptions(),
      }).catch(() => {});
    }
  } catch (_) {}
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

// Sliding profit lock: activates at 20% capital profit, then locks 60% of
// whatever profit exists — slides up as profit grows.
// feeFloorCap = total fees (taker + funding) + buffer — SL never locks below this.
function calcTierSlPrice(entryPrice, curPrice, isLong, leverage, feeFloorCap = 0.03) {
  const pricePct   = isLong
    ? (curPrice - entryPrice) / entryPrice
    : (entryPrice - curPrice) / entryPrice;
  const capitalPct = pricePct * leverage;

  // Below 20% capital profit — let trade breathe, no movement
  if (capitalPct < TRAIL_ACTIVATE_CAP) return null;

  // Lock 60% of current profit, but never below total fees (taker + funding + buffer)
  const slCapital  = Math.max(capitalPct * PROFIT_LOCK_PCT, feeFloorCap);
  const slPricePct = slCapital / leverage;

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
             t.trailing_sl_price, t.tp_price, t.leverage, t.created_at,
             ak.platform,
             ak.api_key_enc, ak.iv, ak.auth_tag,
             ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
      FROM trades t
      JOIN api_keys ak ON ak.id = t.api_key_id
      WHERE t.status = 'OPEN'
    `);
    // NOTE: intentionally does NOT filter by ak.enabled — pausing a key sets enabled=false
    // but existing open positions must still have their SL protected regardless of pause state.

    if (!trades.length) return;

    for (const trade of trades) {
      try {
        // Decrypt credentials — columns are AES-GCM encrypted at rest
        const apiKey    = cryptoUtils.decrypt(trade.api_key_enc,    trade.iv,         trade.auth_tag);
        const apiSecret = cryptoUtils.decrypt(trade.api_secret_enc, trade.secret_iv,  trade.secret_auth_tag);
        if (!apiKey || !apiSecret) {
          log(`${trade.symbol}: skipping — could not decrypt API credentials`);
          continue;
        }

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

        // ── Total fee cost (taker + funding) ─────────────────────
        // Taker: entry + exit fee in capital %
        const takerCapital = TAKER_FEE_BOTH_LEGS * leverage;
        // Funding: how many 8h periods since trade opened × current rate × leverage
        const tradeAgeMs      = Date.now() - new Date(trade.created_at).getTime();
        const tradeAgeH       = tradeAgeMs / (1000 * 3600);
        const fundingPeriods  = Math.max(1, Math.floor(tradeAgeH / FUNDING_INTERVAL_H));
        const fundingRate     = await getFundingRate(trade.symbol);
        const fundingCapital  = fundingRate * fundingPeriods * leverage;
        // Total fees + 1% comfort buffer — SL must always lock above this
        const totalFeesCapital = takerCapital + fundingCapital + 0.01;

        // Sliding 60% lock — but floor is total fees so we always profit after all costs
        const tierSl = calcTierSlPrice(entryPrice, curPrice, isLong, leverage, totalFeesCapital);

        // Candle structural trail: activates at 35%+ capital profit.
        // Follows the last 2 candle lows/highs as price moves in our favour.
        const candleSl = capitalPct >= CANDLE_TRAIL_CAP
          ? await calcCandleSlPrice(trade.symbol, isLong, currentSl, curPrice)
          : null;

        // Take the BETTER of the two (highest SL for LONG, lowest for SHORT)
        let bestSl = currentSl;
        if (tierSl) bestSl = isLong ? Math.max(bestSl, tierSl) : Math.min(bestSl, tierSl);
        if (candleSl) bestSl = isLong ? Math.max(bestSl, candleSl) : Math.min(bestSl, candleSl);

        // Only update if improved beyond current SL
        const improved = isLong ? bestSl > currentSl + 0.001 : bestSl < currentSl - 0.001;
        if (!improved) continue;

        const source = [];
        if (tierSl && (isLong ? tierSl > currentSl : tierSl < currentSl)) source.push(`60%lock(+${(capitalPct*100).toFixed(1)}%cap)`);
        if (candleSl && (isLong ? candleSl > currentSl : candleSl < currentSl)) source.push('candle');

        log(`${trade.symbol} ${isLong ? 'LONG' : 'SHORT'} [${source.join('+')}] SL: $${currentSl.toFixed(pricePrec)} → $${bestSl.toFixed(pricePrec)} | profit +${(capitalPct*100).toFixed(1)}% capital`);

        let updated = false;
        if (trade.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey, apiSecret });
          updated = await updateSlBitunix(client, trade.symbol, bestSl, pricePrec, trade.tp_price);
        } else if (trade.platform === 'binance') {
          const client = new USDMClient(
            { api_key: apiKey, api_secret: apiSecret },
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
          await notify(
            `📈 *Trail SL Moved*\n` +
            `*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `SL: \`$${currentSl.toFixed(pricePrec)}\` → \`$${bestSl.toFixed(pricePrec)}\`\n` +
            `Source: ${source.join('+')}\n` +
            `Profit: +${(capitalPct * 100).toFixed(1)}% capital\n` +
            `Fees: taker ${(takerCapital * 100).toFixed(2)}% + funding ${(fundingCapital * 100).toFixed(2)}% = total ${(totalFeesCapital * 100).toFixed(2)}%`
          );
        } else {
          log(`✗ ${trade.symbol} SL update FAILED (exchange rejected)`);
          await notify(
            `🚨 *Trail SL Failed*\n` +
            `*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `Tried SL → \`$${bestSl.toFixed(pricePrec)}\` — exchange rejected\n` +
            `Profit: +${(capitalPct * 100).toFixed(1)}% capital`
          );
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
      `SELECT ak.id, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.leverage, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.platform = 'bitunix' AND ak.enabled = true`
    );

    for (const key of keys) {
      try {
        const apiKey    = cryptoUtils.decrypt(key.api_key_enc,    key.iv,        key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        if (!apiKey || !apiSecret) continue;
        const client = new BitunixClient({ apiKey, apiSecret });
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

log('Trail watchdog started — 15s interval | activates@20%cap | 60%sliding-lock | candle-trail@35%cap');
log('Orphan guard started — 2min interval | auto-close unmanaged positions > -25% capital');
runTrailCycle();
setInterval(runTrailCycle, INTERVAL_MS);

// Stagger orphan guard by 30s so it doesn't overlap with first trail cycle
setTimeout(() => {
  runOrphanGuard();
  setInterval(runOrphanGuard, ORPHAN_CHECK_INTERVAL);
}, 30000);
