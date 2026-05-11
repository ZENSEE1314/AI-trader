// Copy Trade Engine — mirrors a source trade to all active followers.
// Safe to call from cycle.js; errors per-follower are fully isolated.
//
// RISK SIZING:
//   Each subscriber sets copy_size_pct (default 10%) — how much of THEIR OWN
//   wallet balance to allocate per copy trade. The leader's quantity is IGNORED.
//
//   follower_qty = (follower_balance × copy_size_pct/100 × leverage) / entry_price
//
//   This means:
//     - 10% risk  → uses 10% of follower's wallet per trade (conservative)
//     - 50% risk  → uses 50% of follower's wallet (aggressive)
//     - 100% risk → mirrors full wallet (matches leader proportionally)

'use strict';

const db          = require('./db');
const { BitunixClient } = require('./bitunix-client');
const cryptoUtils = require('./crypto-utils');

const IS_AI_SETUP = (s) => typeof s === 'string' && (s.includes('V4-') || s.startsWith('AI'));

// ── Quantity precision lookup ─────────────────────────────────────────────────
// Bitunix requires qty to match the symbol's step size. Approximate minimums:
const QTY_PRECISION = {
  BTCUSDT:  3,  // 0.001 BTC minimum
  ETHUSDT:  3,  // 0.001 ETH
  SOLUSDT:  2,  // 0.01 SOL
  BNBUSDT:  2,  // 0.01 BNB
};
function roundQty(symbol, qty) {
  const prec = QTY_PRECISION[symbol.toUpperCase()] ?? 2;
  return parseFloat(qty.toFixed(prec));
}

// ── Fetch follower's available USDT balance from Bitunix ─────────────────────
async function getFollowerBalance(client) {
  try {
    const data = await client.getAccountBalance();
    // Bitunix balance response varies — try common field paths
    const assets = data?.data?.list || data?.data?.assets || data?.list || data?.assets || [];
    const usdt = assets.find(a =>
      (a.currency || a.asset || a.coin || '').toUpperCase() === 'USDT'
    );
    const balance = parseFloat(usdt?.available || usdt?.availableBalance || usdt?.walletBalance || 0);
    return balance > 0 ? balance : null;
  } catch (err) {
    console.warn(`[CopyTrade] getAccountBalance failed: ${err.message}`);
    return null;
  }
}

// ── Main entry point called from cycle.js ────────────────────────────────────
// sourceTrade: { id, symbol, direction, entry_price, sl_price, tp_price,
//               quantity, leverage, setup, bitunix_position_id, is_ai_trade }
// sourceApiKey: api_keys row of the leader
// sourceUser:   { id, email }
async function triggerCopyTrades(sourceTrade, sourceApiKey, sourceUser) {
  const isAiTrade = sourceTrade.is_ai_trade || IS_AI_SETUP(sourceTrade.setup);

  let subscriptions;
  try {
    subscriptions = await db.query(
      `SELECT cts.id, cts.follower_key_id, cts.leader_type,
              cts.copy_size_pct,
              ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.user_id, ak.platform, ak.leverage AS key_leverage,
              u.email
         FROM copy_trade_subscriptions cts
         JOIN api_keys ak ON ak.id = cts.follower_key_id AND ak.enabled = true
         JOIN users u    ON u.id  = ak.user_id
        WHERE cts.is_active = true
          AND (
                (cts.leader_type = 'ai'   AND $1 = true)
             OR (cts.leader_type = 'user' AND cts.leader_user_id = $2)
          )
          AND ak.user_id <> $2`,
      [isAiTrade, sourceUser.id]
    );
  } catch (err) {
    console.error(`[CopyTrade] Failed to load subscriptions: ${err.message}`);
    return;
  }

  if (!subscriptions.length) return;

  console.log(
    `[CopyTrade] ${sourceTrade.symbol} ${sourceTrade.direction} ` +
    `— mirroring to ${subscriptions.length} follower(s)`
  );

  for (const sub of subscriptions) {
    try {
      await _placeCopyTrade(sub, sourceTrade);
    } catch (err) {
      console.error(
        `[CopyTrade] Follower key#${sub.follower_key_id} (${sub.email}) failed: ${err.message}`
      );
    }
  }
}

// ── Place one copy trade for one follower ─────────────────────────────────────
async function _placeCopyTrade(sub, sourceTrade) {
  const { symbol, direction, entry_price, sl_price, tp_price, leverage, setup } = sourceTrade;

  // Skip if follower already has an open trade on this symbol
  const existing = await db.query(
    `SELECT id FROM trades WHERE api_key_id = $1 AND symbol = $2 AND status = 'OPEN' LIMIT 1`,
    [sub.follower_key_id, symbol]
  );
  if (existing.length) {
    console.log(`[CopyTrade] Skip key#${sub.follower_key_id} — already open on ${symbol}`);
    return;
  }

  if (sub.platform !== 'bitunix') {
    console.warn(`[CopyTrade] key#${sub.follower_key_id} platform "${sub.platform}" not supported`);
    return;
  }

  const apiKey    = cryptoUtils.decrypt(sub.api_key_enc,    sub.iv,        sub.auth_tag);
  const apiSecret = cryptoUtils.decrypt(sub.api_secret_enc, sub.secret_iv, sub.secret_auth_tag);
  const client    = new BitunixClient({ apiKey, apiSecret });

  // ── Risk-based quantity sizing ──────────────────────────────────────────────
  // Use follower's OWN balance × their chosen risk %, not the leader's quantity.
  // This ensures a $100 wallet following a $10,000 wallet doesn't blow up.
  const copyPct  = parseFloat(sub.copy_size_pct) || 10.0;   // e.g. 10 = 10%
  const useLev   = parseFloat(leverage) || parseFloat(sub.key_leverage) || 20;

  let copyQty;
  const balance = await getFollowerBalance(client);
  if (balance && balance > 0) {
    // capital_allocated = balance × risk%
    // notional          = capital_allocated × leverage
    // qty               = notional / entry_price
    const allocated = balance * (copyPct / 100);
    const notional  = allocated * useLev;
    copyQty = roundQty(symbol, notional / entry_price);
    console.log(
      `[CopyTrade] key#${sub.follower_key_id} balance=$${balance.toFixed(2)} ` +
      `risk=${copyPct}% → alloc=$${allocated.toFixed(2)} notional=$${notional.toFixed(2)} ` +
      `qty=${copyQty} ${symbol}`
    );
  } else {
    // Fallback: can't read balance → scale leader's qty by risk%
    copyQty = roundQty(symbol, (sourceTrade.quantity || 0) * (copyPct / 100));
    console.warn(
      `[CopyTrade] key#${sub.follower_key_id} balance unavailable ` +
      `— scaling leader qty ${sourceTrade.quantity} × ${copyPct}% = ${copyQty}`
    );
  }

  if (!copyQty || copyQty <= 0) {
    console.warn(`[CopyTrade] key#${sub.follower_key_id} qty=${copyQty} too small — skipping`);
    return;
  }

  // ── Place the order ─────────────────────────────────────────────────────────
  let posId       = null;
  let actualEntry = entry_price;

  try {
    const orderResult = await client.placeOrder({
      symbol,
      side:      direction === 'LONG' ? 'BUY' : 'SELL',
      orderType: 'MARKET',
      qty:       copyQty,
      leverage:  useLev,
      reduceOnly: false,
    });

    posId = orderResult?.data?.positionId || orderResult?.positionId || null;

    // Try to get the actual fill price
    if (posId) {
      try {
        const pos   = await client.getPosition(symbol);
        const match = (pos?.data?.list || []).find(p => p.positionId === posId);
        if (match) actualEntry = parseFloat(match.entryPrice) || actualEntry;
      } catch (_) {}
    }

    // Set SL on follower's position (same price level as leader)
    if (sl_price && posId) {
      try {
        await client.placePositionTpSl({
          symbol,
          positionId: posId,
          slPrice:    String(parseFloat(sl_price).toFixed(4)),
          ...(tp_price ? { tpPrice: String(parseFloat(tp_price).toFixed(4)) } : {}),
        });
      } catch (slErr) {
        console.warn(`[CopyTrade] key#${sub.follower_key_id} SL/TP set failed: ${slErr.message}`);
      }
    }
  } catch (orderErr) {
    console.error(`[CopyTrade] Order FAILED key#${sub.follower_key_id}: ${orderErr.message}`);
    return; // don't insert a DB row if the order didn't land
  }

  // ── Record in trades table ──────────────────────────────────────────────────
  try {
    await db.query(
      `INSERT INTO trades
         (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price,
          quantity, leverage, status, trailing_sl_price, trailing_sl_last_step,
          bitunix_position_id, setup, is_copy_trade, copied_from_trade_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN',$6,0,$10,$11,true,$12)`,
      [
        sub.follower_key_id, sub.user_id, symbol, direction,
        actualEntry, sl_price || 0, tp_price || 0,
        copyQty, useLev,
        posId    || null,
        (setup   || 'COPY') + `[${copyPct}%]`,
        sourceTrade.id || null,
      ]
    );
    console.log(
      `[CopyTrade] ✓ key#${sub.follower_key_id} (${sub.email}) ` +
      `${symbol} ${direction} qty=${copyQty} risk=${copyPct}%`
    );
  } catch (dbErr) {
    console.error(`[CopyTrade] DB insert failed key#${sub.follower_key_id}: ${dbErr.message}`);
  }
}

module.exports = { triggerCopyTrades };
