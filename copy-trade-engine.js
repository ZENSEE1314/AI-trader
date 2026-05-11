// Copy Trade Engine — mirrors a source trade to all active followers.
// Safe to call from cycle.js; errors per-follower are isolated.

const db = require('./db');
const { BitunixClient } = require('./bitunix-client');
const cryptoUtils = require('./crypto-utils');

const IS_AI_SETUP = (setup) => typeof setup === 'string' && (setup.includes('V4-') || setup.startsWith('AI'));

// Trigger copy trades for all followers of the source user / AI signal.
// sourceTrade: { id, symbol, direction, entry_price, sl_price, tp_price,
//               quantity, leverage, setup, bitunix_position_id, is_ai_trade }
// sourceApiKey: the api_keys row that opened the trade (for user matching)
// sourceUser:   { id, email }
async function triggerCopyTrades(sourceTrade, sourceApiKey, sourceUser) {
  const isAiTrade = sourceTrade.is_ai_trade || IS_AI_SETUP(sourceTrade.setup);

  // Build subscription filter: match AI followers OR same-user followers
  let subscriptions;
  try {
    subscriptions = await db.query(
      `SELECT cts.id, cts.follower_key_id, cts.leader_type,
              ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.user_id, ak.platform,
              u.email
         FROM copy_trade_subscriptions cts
         JOIN api_keys ak ON ak.id = cts.follower_key_id AND ak.enabled = true
         JOIN users u ON u.id = ak.user_id
        WHERE cts.is_active = true
          AND (
            (cts.leader_type = 'ai' AND $1 = true)
            OR
            (cts.leader_type = 'user' AND cts.leader_user_id = $2)
          )
          AND ak.user_id <> $2`,
      [isAiTrade, sourceUser.id]
    );
  } catch (err) {
    console.error(`[CopyTrade] Failed to load subscriptions: ${err.message}`);
    return;
  }

  if (!subscriptions.length) return;

  console.log(`[CopyTrade] ${sourceTrade.symbol} ${sourceTrade.direction} — mirroring to ${subscriptions.length} follower(s)`);

  for (const sub of subscriptions) {
    try {
      await _placeCopyTrade(sub, sourceTrade);
    } catch (err) {
      // One failure must never block the others
      console.error(`[CopyTrade] Follower key#${sub.follower_key_id} (${sub.email}) failed: ${err.message}`);
    }
  }
}

async function _placeCopyTrade(sub, sourceTrade) {
  // Skip if follower already has an open trade on this symbol
  const existing = await db.query(
    `SELECT id FROM trades
      WHERE api_key_id = $1 AND symbol = $2 AND status = 'OPEN'
      LIMIT 1`,
    [sub.follower_key_id, sourceTrade.symbol]
  );
  if (existing.length) {
    console.log(`[CopyTrade] Skip key#${sub.follower_key_id} — already open on ${sourceTrade.symbol}`);
    return;
  }

  const apiKey    = cryptoUtils.decrypt(sub.api_key_enc,    sub.iv,        sub.auth_tag);
  const apiSecret = cryptoUtils.decrypt(sub.api_secret_enc, sub.secret_iv, sub.secret_auth_tag);

  if (sub.platform !== 'bitunix') {
    console.warn(`[CopyTrade] key#${sub.follower_key_id} platform "${sub.platform}" not supported for copy trades`);
    return;
  }

  const client = new BitunixClient({ apiKey, apiSecret });

  // Use same direction, leverage, sl, tp — quantity mirrors source exactly.
  // NOTE: A production system would scale quantity by follower's balance.
  const { symbol, direction, quantity, leverage, sl_price, tp_price, setup } = sourceTrade;

  let posId = null;
  let actualEntry = sourceTrade.entry_price;

  try {
    const orderResult = await client.placeOrder({
      symbol,
      side: direction === 'LONG' ? 'BUY' : 'SELL',
      orderType: 'MARKET',
      qty: quantity,
      leverage,
      reduceOnly: false,
    });

    posId = orderResult?.data?.positionId || orderResult?.positionId || null;

    // Attempt to fetch actual fill price
    if (posId) {
      try {
        const pos = await client.getPosition(symbol);
        const match = (pos?.data?.list || []).find(p => p.positionId === posId);
        if (match) actualEntry = parseFloat(match.entryPrice) || actualEntry;
      } catch (_) {}
    }

    // Set SL/TP on the follower's position
    if (sl_price && posId) {
      try {
        await client.setStopLoss({ symbol, positionId: posId, stopPrice: sl_price });
      } catch (slErr) {
        console.warn(`[CopyTrade] key#${sub.follower_key_id} SL set failed: ${slErr.message}`);
      }
    }
    if (tp_price && posId) {
      try {
        await client.setTakeProfit({ symbol, positionId: posId, stopPrice: tp_price });
      } catch (tpErr) {
        console.warn(`[CopyTrade] key#${sub.follower_key_id} TP set failed: ${tpErr.message}`);
      }
    }
  } catch (orderErr) {
    console.error(`[CopyTrade] Order failed for key#${sub.follower_key_id}: ${orderErr.message}`);
    // Record the failure attempt so it's visible in logs — do not insert a trade row
    return;
  }

  // Record the copy trade in the trades table
  try {
    await db.query(
      `INSERT INTO trades
         (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price,
          quantity, leverage, status, trailing_sl_price, trailing_sl_last_step,
          bitunix_position_id, setup, is_copy_trade, copied_from_trade_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $6, 0, $10, $11, true, $12)`,
      [
        sub.follower_key_id, sub.user_id, symbol, direction,
        actualEntry, sl_price || 0, tp_price || 0,
        quantity, leverage,
        posId || null,
        setup || 'COPY',
        sourceTrade.id || null,
      ]
    );
    console.log(`[CopyTrade] Recorded copy trade for key#${sub.follower_key_id} (${sub.email}) ${symbol} ${direction}`);
  } catch (dbErr) {
    console.error(`[CopyTrade] DB insert failed for key#${sub.follower_key_id}: ${dbErr.message}`);
  }
}

module.exports = { triggerCopyTrades };
