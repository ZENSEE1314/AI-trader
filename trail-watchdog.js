// ============================================================
// Trailing SL Watchdog — runs every 15 seconds
//
// ⚠ HARDCODED — these rules apply to ALL trades regardless of which
//   strategy version is active in the admin panel. Do NOT move these
//   thresholds into strategy_versions or any DB config.
//
// Initial SL: 20% capital
// Trail logic:
//   Below +21% capital profit → no movement, trade breathes freely
//   +21% capital profit       → SL locked at +20% (profit secured)
//   +30% capital profit       → SL moves to +30%
//   +40% capital profit       → SL moves to +40%
//   ... steps up every +10% capital gain, always locking in the milestone
// ============================================================

const fetch = require('node-fetch');
const { BitunixClient } = require('./bitunix-client');
const { USDMClient } = require('binance');
const { getFetchOptions, getBinanceRequestOptions } = require('./proxy-agent');
const cryptoUtils = require('./crypto-utils');
const { calcTrailingSLV3 } = require('./strategy-v3');

// Adapter: returns { newSl, capitalPct, milestone } expected by the
// log/notify code below, or null when there's no improvement to lock in.
// Wraps calcTrailingSLV3 — 15% capital initial SL (tight), trailing at
// +21% → lock +20%, then +30/+40/... by floor(cap×10)/10.
function calcV2TrailSL(entryPrice, currentPrice, isLong, leverage, currentSl) {
  const side = isLong ? 'LONG' : 'SHORT';
  const pricePct = isLong
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  const capitalPct = pricePct * leverage;
  // Leverage-aware trigger: 50x trades (SOL/BNB/XRP) start trailing at
  // +16% capital (lock +15%); 100x trades (BTC/ETH) start at +21% (lock
  // +20%). Matches calcTrailingSLV3 and cycle.js TRAILING_TIERS_50X.
  const TRAIL_ON_CAP = leverage <= 50 ? 0.16 : 0.21;
  if (capitalPct < TRAIL_ON_CAP) return null;
  const newSl = calcTrailingSLV3(entryPrice, currentPrice, side, leverage);
  const milestone = leverage <= 50
    ? 0.15 + Math.floor((capitalPct - 0.16 + 1e-9) / 0.11) * 0.10
    : Math.floor((capitalPct - 0.01 + 1e-9) * 10) / 10;
  return { newSl, capitalPct, milestone };
}

const INTERVAL_MS = 15 * 1000;
const db = require('./db');

// Tracks symbols whose SL we've already retro-adjusted to 15% capital this
// process lifetime.  Prevents re-applying on every 15-second tick.
const _widened = new Set();

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
    // ── Step 1: load all active API keys ─────────────────────
    const keys = await db.query(`
      SELECT ak.id, ak.platform,
             ak.api_key_enc, ak.iv, ak.auth_tag,
             ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
      FROM api_keys ak
      WHERE ak.enabled = true
    `);
    if (!keys.length) return;

    // ── Step 2: load DB open trades for currentSl lookup ─────
    // DB is NOT the source of truth for which positions exist —
    // the exchange is. DB only tells us the last SL we set.
    const dbTrades = await db.query(`
      SELECT t.id, t.symbol, t.direction, t.entry_price, t.sl_price,
             t.trailing_sl_price, t.tp_price, t.leverage, t.api_key_id
      FROM trades t
      WHERE t.status = 'OPEN'
    `);
    // Index by api_key_id + symbol for O(1) lookup
    const dbTradeMap = new Map();
    for (const t of dbTrades) {
      dbTradeMap.set(`${t.api_key_id}:${t.symbol.toUpperCase()}`, t);
    }

    // ── Step 3: for each key, fetch live positions & trail ────
    for (const key of keys) {
      if (key.platform !== 'bitunix') continue; // Binance handled separately below

      const apiKey    = cryptoUtils.decrypt(key.api_key_enc,    key.iv,        key.auth_tag);
      const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
      if (!apiKey || !apiSecret) continue;

      let positions = [];
      try {
        const client  = new BitunixClient({ apiKey, apiSecret });
        const posData = await client.getOpenPositions();
        positions = Array.isArray(posData) ? posData
          : (posData?.positionList || posData?.list || []);
      } catch (e) {
        log(`getOpenPositions failed for key ${key.id}: ${e.message}`);
        continue;
      }

      if (!positions.length) continue;

      for (const pos of positions) {
        try {
          const qty = parseFloat(pos.qty || pos.size || pos.positionAmt || 0);
          if (qty === 0) continue;

          const symbol   = (pos.symbol || '').toUpperCase();
          const isLong   = (pos.side || '').toUpperCase() === 'BUY'
                        || (pos.side || '').toUpperCase() === 'LONG';
          const entry    = parseFloat(pos.avgOpenPrice || pos.entryPrice || pos.openPrice || 0);
          const leverage = parseFloat(pos.leverage || 20);
          const upnl     = parseFloat(pos.unrealizedPNL || pos.unrealizedPnl || pos.unrealizedProfit || 0);
          const margin   = parseFloat(pos.margin || pos.positionMargin || pos.initialMargin || pos.im || 0);

          if (entry === 0) continue;

          // Look up DB trade — may not exist (orphan position)
          const dbTrade   = dbTradeMap.get(`${key.id}:${symbol}`);
          let currentSl = dbTrade
            ? (parseFloat(dbTrade.trailing_sl_price) || parseFloat(dbTrade.sl_price) || 0)
            : 0;
          const pricePrec = dbTrade
            ? Math.max(inferPricePrec(dbTrade.sl_price), inferPricePrec(dbTrade.entry_price))
            : inferPricePrec(entry);

          // Calculate capitalPct — prefer exchange margin data over our own formula
          let capitalPct;
          if (margin > 0 && upnl !== 0) {
            capitalPct = upnl / margin;
          } else {
            const curPrice = await getLivePrice(symbol);
            if (!curPrice) continue;
            const pricePct = isLong
              ? (curPrice - entry) / entry
              : (entry - curPrice) / entry;
            capitalPct = pricePct * leverage;
          }

          const pctDisplay = `${capitalPct >= 0 ? '+' : ''}${(capitalPct * 100).toFixed(2)}%`;
          log(`[DIAG] ${symbol} ${isLong ? 'LONG' : 'SHORT'} | entry=$${entry} | lev=${leverage}x | capital=${pctDisplay} | currentSL=$${currentSl} | DB=${dbTrade ? 'found' : 'ORPHAN'}`);

          // ── Retro-adjust SL to 20% capital ────────────────
          // Standardise every open position's SL to 20% capital on the first
          // tick after deploy.  Only acts on losing trades; winners pass to
          // the trail-up logic below.  Runs once per position per watchdog
          // process via _widened set.  Adjusts in EITHER direction.
          if (capitalPct < 0 && currentSl > 0) {
            const targetSlPricePct = 0.20 / leverage;
            const targetSl = isLong
              ? entry * (1 - targetSlPricePct)
              : entry * (1 + targetSlPricePct);
            const tol = (0.0005 / leverage) * entry;
            const needsAdjust = Math.abs(currentSl - targetSl) > tol;
            if (needsAdjust && !_widened.has(symbol)) {
              _widened.add(symbol);
              log(`[20%-FIX] ${symbol} ${isLong ? 'LONG' : 'SHORT'}: SL $${currentSl.toFixed(pricePrec)} → $${targetSl.toFixed(pricePrec)} (normalising to 20% capital)`);
              const ok = await updateSlBitunix(client, symbol, targetSl, pricePrec, dbTrade?.tp_price, pos);
              if (ok && dbTrade) {
                await db.query(
                  `UPDATE trades SET trailing_sl_price = $1, sl_price = $1 WHERE id = $2`,
                  [targetSl, dbTrade.id]
                );
              }
              currentSl = targetSl;
            }
          }

          const v2Result = calcV2TrailSL(entry, isLong ? entry * (1 + capitalPct / leverage) : entry * (1 - capitalPct / leverage), isLong, leverage, currentSl);
          if (!v2Result) {
            log(`[DIAG] ${symbol} trail SKIP — ${pctDisplay} < +20% or SL already at milestone`);
            continue;
          }

          const bestSl   = v2Result.newSl;
          const srcLabel = `trail(+${(v2Result.capitalPct*100).toFixed(1)}%→lock${(v2Result.milestone*100).toFixed(0)}%)`;
          const improved = currentSl === 0
            || (isLong ? bestSl > currentSl + 0.0001 : bestSl < currentSl - 0.0001);
          if (!improved) continue;

          log(`${symbol} ${isLong ? 'LONG' : 'SHORT'} [${srcLabel}] SL: $${currentSl.toFixed(pricePrec)} → $${bestSl.toFixed(pricePrec)} | ${pctDisplay} capital`);

          const client  = new BitunixClient({ apiKey, apiSecret });
          const updated = await updateSlBitunix(client, symbol, bestSl, pricePrec, dbTrade?.tp_price, pos);

          if (updated) {
            if (dbTrade) {
              await db.query(
                `UPDATE trades SET trailing_sl_price = $1 WHERE id = $2`,
                [bestSl, dbTrade.id]
              );
            }
            log(`✓ ${symbol} SL locked → $${bestSl.toFixed(pricePrec)}`);
            await notify(
              `📈 *Trail SL Moved*\n` +
              `*${symbol}* ${isLong ? 'LONG' : 'SHORT'}${dbTrade ? '' : ' ⚠️ orphan'}\n` +
              `SL: \`$${currentSl.toFixed(pricePrec)}\` → \`$${bestSl.toFixed(pricePrec)}\`\n` +
              `Profit: +${(v2Result.capitalPct * 100).toFixed(1)}% capital | locked ${(v2Result.milestone * 100).toFixed(0)}%`
            );
          } else {
            log(`✗ ${symbol} SL update FAILED`);
          }
        } catch (e) {
          log(`Error processing position ${pos?.symbol}: ${e.message}`);
        }
      }
    }

    // ── Binance trades (still DB-driven, exchange gives order-based SL) ──
    const binanceTrades = dbTrades.filter(t => {
      const key = keys.find(k => k.id === t.api_key_id);
      return key?.platform === 'binance';
    });
    for (const trade of binanceTrades) {
      try {
        const key       = keys.find(k => k.id === trade.api_key_id);
        if (!key) continue;
        const apiKey    = cryptoUtils.decrypt(key.api_key_enc,    key.iv,        key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        if (!apiKey || !apiSecret) continue;

        const isLong     = trade.direction !== 'SHORT';
        const currentSl  = parseFloat(trade.trailing_sl_price) || parseFloat(trade.sl_price) || 0;
        const pricePrec  = Math.max(inferPricePrec(trade.sl_price), inferPricePrec(trade.entry_price));
        const entryPrice = parseFloat(trade.entry_price);
        const leverage   = parseFloat(trade.leverage) || 20;

        const curPrice = await getLivePrice(trade.symbol);
        if (!curPrice) continue;

        const profitPct  = isLong ? (curPrice - entryPrice) / entryPrice : (entryPrice - curPrice) / entryPrice;
        const capitalPct = profitPct * leverage;

        const v2Result = calcV2TrailSL(entryPrice, curPrice, isLong, leverage, currentSl);
        if (!v2Result) continue;

        const bestSl  = v2Result.newSl;
        const improved = currentSl === 0 || (isLong ? bestSl > currentSl + 0.0001 : bestSl < currentSl - 0.0001);
        if (!improved) continue;

        const client  = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
        const updated = await updateSlBinance(client, trade.symbol, bestSl, isLong, pricePrec);
        if (updated) {
          await db.query(`UPDATE trades SET trailing_sl_price = $1 WHERE id = $2`, [bestSl, trade.id]);
          log(`✓ ${trade.symbol} (Binance) SL locked → $${bestSl.toFixed(pricePrec)}`);
          await notify(
            `📈 *Trail SL Moved*\n*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `SL: \`$${currentSl.toFixed(pricePrec)}\` → \`$${bestSl.toFixed(pricePrec)}\`\n` +
            `Profit: +${(v2Result.capitalPct * 100).toFixed(1)}% capital | locked ${(v2Result.milestone * 100).toFixed(0)}%`
          );
        }
      } catch (e) {
        log(`Binance trail error ${trade.symbol}: ${e.message}`);
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
