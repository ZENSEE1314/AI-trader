// ============================================================
// Trailing SL Watchdog — runs every 15 seconds
//
// ⚠ HARDCODED — these rules apply to ALL trades regardless of which
//   strategy version is active in the admin panel. Do NOT move these
//   thresholds into strategy_versions or any DB config.
//
// Trail logic:
//   Below 20% capital profit → no movement, trade breathes freely
//   20%+ capital profit      → lock 60% of current profit (slides up)
//   35%+ capital profit      → also use candle structural trail
//   Floor = taker fees + funding fees + 1% buffer (always net positive)
// ============================================================

const fetch = require('node-fetch');
const { BitunixClient } = require('./bitunix-client');
const { USDMClient } = require('binance');
const { getFetchOptions, getBinanceRequestOptions } = require('./proxy-agent');
const cryptoUtils = require('./crypto-utils');
const { calcV2TrailSL } = require('./strategy-v2');

const INTERVAL_MS = 15 * 1000;
const db = require('./db');

// NOTE: V1 trail constants removed — all trades now use V2 milestone trail.
// V2 thresholds live in strategy-v2.js (V2_SL_CAPITAL_PCT / TRAIL_START / TRAIL_STEP).
// Funding rate cache kept for getLivePrice fallback only.
const FUNDING_FALLBACK = 0.0001;

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


async function updateSlBitunix(client, symbol, newSlPrice, pricePrec, existingTp, cachedPos = null) {
  try {
    // Reuse already-fetched position data if available (avoids a second API call)
    let pos = cachedPos;
    if (!pos) {
      const posData = await client.getOpenPositions(symbol);
      const posList = Array.isArray(posData) ? posData
        : (posData?.positionList || posData?.list || (posData && typeof posData === 'object' ? [posData] : []));
      const symUpper = symbol.toUpperCase();
      pos = posList.find(p => (p.symbol || '').toUpperCase() === symUpper);
      if (!pos) {
        log(`Bitunix: no position found for ${symbol} (checked ${posList.length} positions: [${posList.map(p => p.symbol).join(', ')}])`);
        return false;
      }
    }
    const posId = pos.positionId || pos.id;
    if (!posId) {
      log(`Bitunix: position found for ${symbol} but no positionId`);
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
        // Infer decimal precision from whichever price column has the most decimals.
        // sl_price may be NULL for some trades — fall back to entry_price precision.
        const pricePrec  = Math.max(
          inferPricePrec(trade.sl_price),
          inferPricePrec(trade.entry_price)
        );
        const entryPrice = parseFloat(trade.entry_price);
        const dbLeverage = parseFloat(trade.leverage) || 0;

        // Get live price + exchange position data (needed for real leverage).
        // DB leverage can be NULL for trades opened before V2 or synced by accountant.
        // Always trust the exchange's reported leverage over the DB value.
        const curPrice = await getLivePrice(trade.symbol);
        if (!curPrice) {
          log(`[DIAG] ${trade.symbol}: getLivePrice returned null — Binance API unavailable or invalid symbol`);
          continue;
        }

        // Fetch live position to get real leverage (one call per trade, cached outcome used below)
        let leverage = dbLeverage || 20;
        let livePositionData = null;
        if (trade.platform === 'bitunix') {
          try {
            const client = new BitunixClient({ apiKey, apiSecret });
            const posData = await client.getOpenPositions(trade.symbol);
            const posList = Array.isArray(posData) ? posData
              : (posData?.positionList || posData?.list || (posData && typeof posData === 'object' ? [posData] : []));
            const symUpper = trade.symbol.toUpperCase();
            const pos = posList.find(p => (p.symbol || '').toUpperCase() === symUpper);
            if (pos) {
              livePositionData = pos;
              const exchangeLev = parseFloat(pos.leverage || 0);
              if (exchangeLev > 0 && exchangeLev !== dbLeverage) {
                log(`[DIAG] ${trade.symbol}: leverage DB=${dbLeverage} vs exchange=${exchangeLev} — using exchange value`);
              }
              if (exchangeLev > 0) leverage = exchangeLev;
            }
          } catch (_) {
            // Fall back to DB leverage — non-fatal
          }
        }

        const profitPct = isLong
          ? (curPrice - entryPrice) / entryPrice
          : (entryPrice - curPrice) / entryPrice;
        const capitalPct = profitPct * leverage;

        // ── V2 Milestone Trail ────────────────────────────────────
        // Activates at +31% capital profit.
        // Locks in each 10% milestone as the new SL:
        //   profit 31% → SL +30% | profit 40% → SL +40% | profit 50% → SL +50% …
        const pctDisplay = `${capitalPct >= 0 ? '+' : ''}${(capitalPct * 100).toFixed(2)}%`;
        log(`[DIAG] ${trade.symbol} ${isLong ? 'LONG' : 'SHORT'} | entry=$${entryPrice} cur=$${curPrice.toFixed(inferPricePrec(trade.entry_price))} | lev=${leverage}x (DB=${dbLeverage}) | capital=${pctDisplay} (need +31% to trail) | currentSL=$${currentSl}`);

        const v2Result = calcV2TrailSL(entryPrice, curPrice, isLong, leverage, currentSl);
        if (!v2Result) {
          log(`[DIAG] ${trade.symbol} trail SKIP — capital ${pctDisplay} < +31% threshold or new SL doesn't improve current`);
          continue;
        }

        const bestSl  = v2Result.newSl;
        const srcLabel = `trail(+${(v2Result.capitalPct*100).toFixed(1)}%→lock${(v2Result.milestone*100).toFixed(0)}%)`;

        // Only update if it genuinely improves the stored SL.
        // currentSl = 0 means not yet set — always allow first write.
        const improved = currentSl === 0
          || (isLong  ? bestSl > currentSl + 0.0001
                      : bestSl < currentSl - 0.0001);
        if (!improved) continue;

        log(`${trade.symbol} ${isLong ? 'LONG' : 'SHORT'} [${srcLabel}] SL: $${currentSl.toFixed(pricePrec)} → $${bestSl.toFixed(pricePrec)} | +${(v2Result.capitalPct*100).toFixed(1)}% capital`);

        let updated = false;
        if (trade.platform === 'bitunix') {
          const client = new BitunixClient({ apiKey, apiSecret });
          updated = await updateSlBitunix(client, trade.symbol, bestSl, pricePrec, trade.tp_price, livePositionData);
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
            `Profit: +${(v2Result.capitalPct * 100).toFixed(1)}% capital | locked ${(v2Result.milestone * 100).toFixed(0)}%`
          );
        } else {
          log(`✗ ${trade.symbol} SL update FAILED (exchange rejected)`);
          await notify(
            `🚨 *Trail SL Failed*\n` +
            `*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `Tried SL → \`$${bestSl.toFixed(pricePrec)}\` — exchange rejected\n` +
            `Profit: +${(v2Result.capitalPct * 100).toFixed(1)}% capital`
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

log('Trail watchdog started — 15s interval | V2 milestone trail | activates@31%cap | locks 30→40→50…% every 10% step');
log('Orphan guard started — 2min interval | auto-close unmanaged positions > -25% capital');
runTrailCycle();
setInterval(runTrailCycle, INTERVAL_MS);

// Stagger orphan guard by 30s so it doesn't overlap with first trail cycle
setTimeout(() => {
  runOrphanGuard();
  setInterval(runOrphanGuard, ORPHAN_CHECK_INTERVAL);
}, 30000);
