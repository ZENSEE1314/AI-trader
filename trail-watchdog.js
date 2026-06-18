// ============================================================
// Trailing SL Watchdog — runs every 15 seconds
//
// ⚠ HARDCODED — these rules apply to ALL trades regardless of which
//   strategy version is active in the admin panel. Do NOT move these
//   thresholds into strategy_versions or any DB config.
//
// Initial SL: 20% capital
// Trail logic:
//   Below +25% capital profit → no movement, trade breathes freely
//   +25% capital profit       → SL locked at +20% (profit secured, fees covered)
//   +27% capital profit       → SL moves to +25%
//   +32% capital profit       → SL moves to +30%
//   ... steps up every +5–10% capital gain, always locking in the milestone
// ============================================================

const fetch = require('node-fetch');
const { BitunixClient } = require('./bitunix-client');
const { USDMClient } = require('binance');
const { getFetchOptions, getBinanceRequestOptions } = require('./proxy-agent');
const cryptoUtils = require('./crypto-utils');
const { calculateTrailingStep, calculateExpoTrail, setDynamicTiers, buildTierTable } = require('./trail-tiers');
const _warnedExpiredKeys = new Set();   // throttle "key expired" log/notify to ONCE per key (was every 15s)

// Load TSL tier config from v4_config DB table — same tables cycle.js uses.
// Falls back to trail-tiers.js hardcoded defaults when DB is unavailable.
async function loadTierConfig() {
  try {
    const rows = await db.query('SELECT key, value FROM v4_config');
    const cfg = {};
    for (const r of rows) cfg[r.key] = r.value;
    const g = (k, def) => cfg[k] ? parseFloat(cfg[k]) : def;
    setDynamicTiers({
      '100': buildTierTable(
        g('tsl_100x_t1_trig', 46), g('tsl_100x_t1_lock', 45),
        g('tsl_100x_t2_trig', 51), g('tsl_100x_t2_lock', 50),
        g('tsl_100x_t3_trig', 61), g('tsl_100x_t3_lock', 60),
        g('tsl_100x_step', 10)
      ),
      '75': buildTierTable(
        g('tsl_75x_t1_trig', 16), g('tsl_75x_t1_lock', 30),
        g('tsl_75x_t2_trig', 41), g('tsl_75x_t2_lock', 40),
        g('tsl_75x_t3_trig', 51), g('tsl_75x_t3_lock', 50),
        g('tsl_75x_step', 10)
      ),
      '50': buildTierTable(
        g('tsl_50x_t1_trig', 21), g('tsl_50x_t1_lock', 20),
        g('tsl_50x_t2_trig', 31), g('tsl_50x_t2_lock', 30),
        g('tsl_50x_t3_trig', 38), g('tsl_50x_t3_lock', 35),
        g('tsl_50x_step', 11)
      ),
    });
    log('Tier config loaded from v4_config DB');
  } catch (e) {
    log(`Tier config load failed — using hardcoded defaults: ${e.message}`);
  }
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
const EXPO_TP1_CAPITAL = 0.35;
const EXPO_TP2_CAPITAL = 0.70;

function isExpoSetup(setup) {
  return String(setup || '').startsWith('EXPO_BASELINE');
}

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

async function manageExpoTpBitunix(client, dbTrade, pos, symbol, isLong, qty, entry, price, pricePrec, capitalPct, leverage) {
  const posId = pos.positionId || pos.id;
  const tp1Hit = dbTrade.smc_tp1_hit === true || dbTrade.smc_tp1_hit === 't';
  try {
    if (tp1Hit && capitalPct >= EXPO_TP2_CAPITAL) {
      if (posId && typeof client.flashClose === 'function') {
        await client.flashClose({ positionId: posId });
      } else {
        await client.placeOrder({
          symbol,
          side: isLong ? 'SELL' : 'BUY',
          orderType: 'MARKET',
          tradeSide: 'CLOSE',
          qty: String(Math.abs(qty)),
          positionId: posId,
          reduceOnly: true,
        });
      }
      await db.query(
        `UPDATE trades
         SET status = 'CLOSED', exit_reason = 'expo_tp70',
             exit_price = $1, closed_at = NOW()
         WHERE id = $2 AND status = 'OPEN'`,
        [price, dbTrade.id]
      );
      log(`✓ ${symbol} EXPO TP2 full close sent @ $${price} (+${(capitalPct * 100).toFixed(2)}% capital)`);
      await notify(
        `Expo TP2 Hit\n` +
        `${symbol} ${isLong ? 'LONG' : 'SHORT'} runner closed @ $${price}\n` +
        `Profit: +${(capitalPct * 100).toFixed(1)}% capital`
      );
      return true;
    }

    if (!tp1Hit && capitalPct >= EXPO_TP1_CAPITAL) {
      const closeQty = Math.floor(Math.abs(qty) * 0.5 * 1e8) / 1e8;
      if (closeQty > 0) {
        await client.placeOrder({
          symbol,
          side: isLong ? 'SELL' : 'BUY',
          orderType: 'MARKET',
          tradeSide: 'CLOSE',
          qty: String(closeQty),
          positionId: posId,
          reduceOnly: true,
        });
      }
      const lockPricePct = EXPO_TP1_CAPITAL / leverage;
      const lockSl = isLong
        ? entry * (1 + lockPricePct)
        : entry * (1 - lockPricePct);
      await updateSlBitunix(client, symbol, lockSl, pricePrec, null, pos);
      await db.query(
        `UPDATE trades
         SET smc_tp1_hit = true, trailing_sl_price = $1, sl_price = $1,
             trailing_sl_last_step = $2
         WHERE id = $3 AND status = 'OPEN'`,
        [parseFloat(lockSl.toFixed(pricePrec)), EXPO_TP1_CAPITAL, dbTrade.id]
      );
      log(`✓ ${symbol} EXPO TP1 50% close sent @ $${price} (+${(capitalPct * 100).toFixed(2)}% capital)`);
      await notify(
        `Expo TP1 Hit\n` +
        `${symbol} ${isLong ? 'LONG' : 'SHORT'} 50% closed @ $${price}\n` +
        `SL locked at +35%, runner waits for +70%`
      );
      return true;
    }

    return false;
  } catch (e) {
    log(`✗ ${symbol} EXPO TP management failed: ${e.message}`);
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
             ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
             u.email
      FROM api_keys ak
      JOIN users u ON u.id = ak.user_id
      WHERE ak.enabled = true
    `);
    if (!keys.length) return;

    // ── Step 2: load DB open trades for currentSl lookup ─────
    // DB is NOT the source of truth for which positions exist —
    // the exchange is. DB only tells us the last SL we set.
    const dbTrades = await db.query(`
      SELECT t.id, t.symbol, t.direction, t.entry_price, t.sl_price, t.quantity,
             t.trailing_sl_price, t.tp_price, t.leverage, t.api_key_id, t.setup,
             t.smc_tp1_hit
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
        // Token Invalid (code 10003) = API key expired on Bitunix — user must reconnect key.
        // Other errors = network / rate-limit — transient, no action needed.
        const isTokenInvalid = e.message.includes('10003') || e.message.toLowerCase().includes('token invalid');
        if (isTokenInvalid) {
          // An expired key fails every 15s — log + notify only ONCE per key per process.
          if (!_warnedExpiredKeys.has(key.id)) {
            _warnedExpiredKeys.add(key.id);
            log(`⚠ Bitunix key #${key.id} (${key.email || 'unknown'}) EXPIRED — user must reconnect in Settings. Trailing disabled for this account.`);
            await notify(
              `⚠️ *API Key Expired*\n` +
              `User: \`${key.email || key.id}\`\n` +
              `Bitunix key #${key.id} returned Token Invalid.\n` +
              `Trailing SL is *disabled* for this account until the key is reconnected in Settings.`
            ).catch(() => {});
          }
        } else {
          log(`⚠ getOpenPositions FAILED for key ${key.id}: ${e.message}`);
        }
        continue;
      }

      if (!positions.length) continue;

      // Create client once per key — reused for all positions in this key's loop
      const posClient = new BitunixClient({ apiKey, apiSecret });

      for (const pos of positions) {
        try {
          const qty = parseFloat(pos.qty || pos.size || pos.positionAmt || 0);
          if (qty === 0) continue;

          const symbol   = (pos.symbol || '').toUpperCase();
          const isLong   = (pos.side || '').toUpperCase() === 'BUY'
                        || (pos.side || '').toUpperCase() === 'LONG';
          const entry    = parseFloat(pos.avgOpenPrice || pos.entryPrice || pos.openPrice || 0);
          const leverage = parseFloat(pos.leverage || 20);

          if (entry === 0) continue;

          // ── capitalPct via Binance live price (most reliable) ──
          // Bitunix's `margin` field is often the NOTIONAL (qty × price), not
          // the initial margin collateral. upnl/notional gives ~0.003% not 46%.
          // Always compute from: price move × leverage via Binance mark price.
          const livePrice = await getLivePrice(symbol);
          if (!livePrice) continue;
          const pricePct = isLong
            ? (livePrice - entry) / entry
            : (entry - livePrice) / entry;
          const capitalPct = pricePct * leverage;

          // Look up DB trade — may not exist (orphan position)
          const dbTrade   = dbTradeMap.get(`${key.id}:${symbol}`);
          let currentSl = dbTrade
            ? (parseFloat(dbTrade.trailing_sl_price) || parseFloat(dbTrade.sl_price) || 0)
            : 0;
          const pricePrec = dbTrade
            ? Math.max(inferPricePrec(dbTrade.sl_price), inferPricePrec(dbTrade.entry_price))
            : inferPricePrec(entry);

          // ── Exchange SL sync guard ─────────────────────────────────────
          // Bitunix position data may include the current SL price on the exchange.
          // If the exchange already has a more protective SL (e.g., from a previous
          // trail cycle that DB didn't persist), use that instead of the DB value.
          // This prevents the watchdog from downgrading a 45% lock back to 15%
          // after a process restart when trailing_sl_price is null in DB.
          const liveExchangeSl = parseFloat(
            pos.slPrice || pos.stopLoss || pos.stopLossPrice || pos.sl || 0
          );
          if (liveExchangeSl > 0) {
            // For LONG: keep whichever SL is HIGHER (closer to current price = more protective)
            // For SHORT: keep whichever SL is LOWER
            const exchangeBetter = isLong
              ? liveExchangeSl > currentSl + 0.0001
              : (currentSl === 0 || liveExchangeSl < currentSl - 0.0001);
            if (exchangeBetter) {
              log(`[SYNC] ${symbol} exchange SL=$${liveExchangeSl.toFixed(pricePrec)} better than DB SL=$${currentSl.toFixed(pricePrec)} — syncing DB`);
              currentSl = liveExchangeSl;
              // Persist so next restart doesn't lose this lock
              if (dbTrade) {
                await db.query(
                  `UPDATE trades SET trailing_sl_price = $1 WHERE id = $2`,
                  [liveExchangeSl, dbTrade.id]
                ).catch(e => log(`[SYNC] DB update failed: ${e.message}`));
              }
            }
          }

          const pctDisplay = `${capitalPct >= 0 ? '+' : ''}${(capitalPct * 100).toFixed(2)}%`;
          log(`[DIAG] ${key.email || key.id} | ${symbol} ${isLong ? 'LONG' : 'SHORT'} | entry=$${entry} live=$${livePrice} | lev=${leverage}x | capital=${pctDisplay} | curSL=$${currentSl.toFixed(pricePrec)} | exchSL=$${liveExchangeSl > 0 ? liveExchangeSl.toFixed(pricePrec) : 'N/A'} | DB=${dbTrade ? 'found' : 'ORPHAN'}`);

          if (isExpoSetup(dbTrade?.setup) && capitalPct >= EXPO_TP1_CAPITAL) {
            await manageExpoTpBitunix(posClient, dbTrade, pos, symbol, isLong, qty, entry, livePrice, pricePrec, capitalPct, leverage);
            continue;
          }

          // ── Retro-adjust SL to 20% capital ────────────────
          // If a losing position's SL is tighter than 20% capital loss,
          // widen it to give the trade room to recover.
          // Only widens (never tightens). Runs once per position per
          // watchdog process via _widened set.
          if (capitalPct < 0 && currentSl > 0) {
            const targetSlPricePct = 0.20 / leverage;
            const targetSl = isLong
              ? entry * (1 - targetSlPricePct)
              : entry * (1 + targetSlPricePct);
            const tol = (0.0005 / leverage) * entry;
            // Only act if targetSl gives MORE room than currentSl
            const wouldWiden = isLong ? targetSl < currentSl - tol : targetSl > currentSl + tol;
            const needsAdjust = wouldWiden;
            // Key: key.id:symbol — each user's position is independent.
          // Previously 'symbol' only, which caused ZenSee's position to block
          // ALL other users from getting the 20%-retro-fix on the same symbol.
          const widenKey = `${key.id}:${symbol}`;
          if (needsAdjust && !_widened.has(widenKey)) {
              _widened.add(widenKey);
              log(`[20%-FIX] ${symbol} ${isLong ? 'LONG' : 'SHORT'}: SL $${currentSl.toFixed(pricePrec)} → $${targetSl.toFixed(pricePrec)} (normalising to 20% capital)`);
              const hasHardTp20 = dbTrade?.setup === 'RANGE_BOUNCE' || dbTrade?.setup === 'SCENARIO_A';
              const ok = await updateSlBitunix(posClient, symbol, targetSl, pricePrec, hasHardTp20 ? dbTrade?.tp_price : null, pos);
              if (ok && dbTrade) {
                await db.query(
                  `UPDATE trades SET trailing_sl_price = $1, sl_price = $1 WHERE id = $2`,
                  [targetSl, dbTrade.id]
                );
              }
              currentSl = targetSl;
            }
          }

          // Derive lastStep (capital %) from the stored SL price so the ratchet works correctly.
          const lastStep = currentSl === 0 ? 0
            : isLong  ? Math.max(0, (currentSl / entry - 1) * leverage)
                      : Math.max(0, (1 - currentSl / entry) * leverage);

          const trailResult = isExpoSetup(dbTrade?.setup)
            ? calculateExpoTrail(entry, livePrice, isLong, lastStep, leverage)   // no lock until TP1 (+35%), then +15/+10
            : calculateTrailingStep(entry, livePrice, isLong, lastStep, leverage);
          if (!trailResult) {
            log(`[DIAG] ${symbol} trail SKIP — ${pctDisplay} not yet at T1 (${leverage}x lv${(lastStep*100).toFixed(0)}% already locked)`);
            continue;
          }
          log(`[DIAG] ${symbol} trail HIT — ${pctDisplay} → lock ${(trailResult.newLastStep*100).toFixed(0)}% | SL $${trailResult.newSlPrice.toFixed(pricePrec)}`);

          const bestSl   = trailResult.newSlPrice;
          const srcLabel = `trail(${pctDisplay}→lock${(trailResult.newLastStep * 100).toFixed(0)}%)`;

          // Ratchet guard: new SL must be strictly better than BOTH:
          //   1. currentSl (already covers DB + exchange via the sync above)
          //   2. liveExchangeSl directly (double-check, catches any race condition)
          // For LONG: "better" = higher (more profit protected)
          // For SHORT: "better" = lower (more profit protected)
          const betterThanCurrent = currentSl === 0
            || (isLong ? bestSl > currentSl + 0.0001 : bestSl < currentSl - 0.0001);
          const betterThanExchange = liveExchangeSl === 0
            || (isLong ? bestSl > liveExchangeSl + 0.0001 : bestSl < liveExchangeSl - 0.0001);
          const improved = betterThanCurrent && betterThanExchange;

          if (!improved) {
            log(`[DIAG] ${symbol} trail ALREADY RATCHETED — bestSL=$${bestSl.toFixed(pricePrec)} currentSL=$${currentSl.toFixed(pricePrec)} exchangeSL=$${liveExchangeSl > 0 ? liveExchangeSl.toFixed(pricePrec) : 'N/A'}`);
            continue;
          }

          log(`${symbol} ${isLong ? 'LONG' : 'SHORT'} [${srcLabel}] SL: $${currentSl.toFixed(pricePrec)} → $${bestSl.toFixed(pricePrec)} | ${pctDisplay} capital`);

          const hasHardTp = dbTrade?.setup === 'RANGE_BOUNCE' || dbTrade?.setup === 'SCENARIO_A';
          const updated = await updateSlBitunix(posClient, symbol, bestSl, pricePrec, hasHardTp ? dbTrade?.tp_price : null, pos);

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
              `Profit: ${pctDisplay} capital | locked ${(trailResult.newLastStep * 100).toFixed(0)}%`
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

        if (isExpoSetup(trade.setup) && capitalPct >= EXPO_TP1_CAPITAL) {
          try {
            const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
            const tp1Hit = trade.smc_tp1_hit === true || trade.smc_tp1_hit === 't';
            const positions = await client.getPositions({ symbol: trade.symbol }).catch(() => []);
            const openPos = (Array.isArray(positions) ? positions : [])
              .find(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
            const liveQty = Math.abs(parseFloat(openPos?.positionAmt || 0));

            if (tp1Hit && capitalPct >= EXPO_TP2_CAPITAL && liveQty > 0) {
              await client.submitNewOrder({
                symbol: trade.symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'MARKET',
                quantity: liveQty,
                reduceOnly: true,
              });
              await db.query(
                `UPDATE trades
                 SET status = 'CLOSED', exit_reason = 'expo_tp70',
                     exit_price = $1, closed_at = NOW()
                 WHERE id = $2 AND status = 'OPEN'`,
                [curPrice, trade.id]
              );
              log(`✓ ${trade.symbol} (Binance) EXPO TP2 close sent @ $${curPrice} (+${(capitalPct * 100).toFixed(2)}% capital)`);
              await notify(`Expo TP2 Hit\n${trade.symbol} runner closed @ $${curPrice}`);
            } else if (!tp1Hit) {
              const closeQty = Math.floor(((parseFloat(trade.quantity) || liveQty) * 0.5) * 1e8) / 1e8;
              if (closeQty > 0) {
                await client.submitNewOrder({
                  symbol: trade.symbol,
                  side: isLong ? 'SELL' : 'BUY',
                  type: 'MARKET',
                  quantity: closeQty,
                  reduceOnly: true,
                });
              }
              const lockPricePct = EXPO_TP1_CAPITAL / leverage;
              const lockSl = isLong
                ? entryPrice * (1 + lockPricePct)
                : entryPrice * (1 - lockPricePct);
              await updateSlBinance(client, trade.symbol, lockSl, isLong, pricePrec);
              await db.query(
                `UPDATE trades
                 SET smc_tp1_hit = true, trailing_sl_price = $1,
                     trailing_sl_last_step = $2
                 WHERE id = $3 AND status = 'OPEN'`,
                [parseFloat(lockSl.toFixed(pricePrec)), EXPO_TP1_CAPITAL, trade.id]
              );
              log(`✓ ${trade.symbol} (Binance) EXPO TP1 50% close sent @ $${curPrice} (+${(capitalPct * 100).toFixed(2)}% capital)`);
              await notify(`Expo TP1 Hit\n${trade.symbol} 50% closed @ $${curPrice}\nRunner waits for +70%`);
            }
          } catch (e) {
            log(`Binance EXPO TP management error ${trade.symbol}: ${e.message}`);
          }
          continue;
        }

        const lastStep = currentSl === 0 ? 0
          : isLong  ? Math.max(0, (currentSl / entryPrice - 1) * leverage)
                    : Math.max(0, (1 - currentSl / entryPrice) * leverage);

        const trailResult = isExpoSetup(trade.setup)
          ? calculateExpoTrail(entryPrice, curPrice, isLong, lastStep, leverage)   // no lock until TP1 (+35%), then +15/+10
          : calculateTrailingStep(entryPrice, curPrice, isLong, lastStep, leverage);
        if (!trailResult) continue;

        const bestSl   = trailResult.newSlPrice;
        const capPctDisplay = `${capitalPct >= 0 ? '+' : ''}${(capitalPct * 100).toFixed(2)}%`;
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
            `Profit: ${capPctDisplay} capital | locked ${(trailResult.newLastStep * 100).toFixed(0)}%`
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
// Keep the emergency close aligned with the Expo baseline hard stop:
// 50% margin loss at 20x = 2.5% price move.
// Runs every 2 minutes (less aggressive than main trail cycle).

const ORPHAN_LOSS_THRESHOLD = 0.50; // auto-close at -50% capital loss
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

log('Trail watchdog started — 15s interval | tier trail (100x:46%→45% / 75x:31%→30% / 50x:21%→20%)');
log('Safety trail (fee-aware): 125x→lock≈21% / 75x→lock≈17% / 150x→lock≈24% / 200x→lock≈28% | nets +10% after fees');
log('Orphan guard started — 2min interval | auto-close unmanaged positions > -50% capital');
// Load tier config before first cycle so dynamic tables are ready
loadTierConfig().then(() => {
  runTrailCycle();
  setInterval(runTrailCycle, INTERVAL_MS);
});

// Stagger orphan guard by 30s so it doesn't overlap with first trail cycle
setTimeout(() => {
  runOrphanGuard();
  setInterval(runOrphanGuard, ORPHAN_CHECK_INTERVAL);
}, 30000);
