// ============================================================
// Smart Crypto Trader v4 — AI Self-Learning Edition
// Binance USDT-M Futures + Bitunix Futures
// Strategy: SMC (Smart Money Concepts) with AI adaptation
// Target: 1% profit per trade
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { scanSMC, detectStructure, recordDailyTrade } = require('./smc-engine');
const { getSentimentScores } = require('./sentiment-scraper');
const { log: bLog } = require('./bot-logger');

const API_KEY        = process.env.BINANCE_API_KEY    || '';
const API_SECRET     = process.env.BINANCE_API_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN     || '';
const TELEGRAM_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const PRIVATE_CHATS  = TELEGRAM_CHATS.filter(id => !id.startsWith('-'));

// ── CONFIG (defaults — AI may override some via getOptimalParams) ─
const CONFIG = {
  LEVERAGE_HIGH:   100,
  LEVERAGE_LOW:    20,
  HIGH_LEV_COINS:  ['BTCUSDT', 'ETHUSDT'],

  SL_BUFFER:       0.001,
  TP_PCT:          0.01,     // 1% profit target
  TP2_MULT:        1.5,      // TP2 = 1.5%
  TP3_MULT:        2.0,      // TP3 = 2%

  TRAIL_PCT:       0.006,    // 0.6% trailing activation
  WALLET_RISK_PCT: 0.03,
  MIN_BALANCE:     5,
  MIN_VOL_M:       100,
  MIN_SCORE:       6,

  RSI_MAX:         68,
  RSI_MIN:         32,
  TAKER_FEE:       0.0004,
  EMA_FAST:        9,
  EMA_SLOW:        21,

  BLACKLIST: [
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
    // TradFi perps — require separate agreement, not crypto
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ],
};

// ── UTILS ─────────────────────────────────────────────────────
function now() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function log(msg) { console.log(`[${now()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtPrice(p) {
  if (!p || isNaN(p)) return 'N/A';
  if (p >= 1000)  return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.01)  return p.toFixed(6);
  return p.toFixed(8);
}

// ── TELEGRAM ──────────────────────────────────────────────────
async function sendToChat(chatId, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const json = await res.json();
      if (!json.ok) log(`Telegram API error chat=${chatId}: ${json.error_code}`);
      return;
    } catch (e) {
      log(`Telegram error chat=${chatId} (${i+1}/${retries}): ${e.message?.substring(0, 80)}`);
      if (i < retries - 1) await sleep(2000 * (i + 1));
    }
  }
}

async function notify(msg) {
  log(`>> ${msg.replace(/\*/g,'').replace(/`/g,'').substring(0, 100)}`);
  if (!TELEGRAM_TOKEN || !PRIVATE_CHATS.length) return;
  await Promise.all(PRIVATE_CHATS.map(id => sendToChat(id, msg)));
}

// ── INDICATORS (kept for trailing stop monitoring) ───────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── TRADE STATE ──────────────────────────────────────────────
const tradeState = new Map();
// sym → { entry, tp1, tp2, tp3, sl, qty, isLong, tpHit1, tpHit2, pricePrec, qtyPrec, setup, openedAt }

// ── 15m EXIT CHECK ───────────────────────────────────────────
function shouldExit15m(struct15, entryPrice, direction) {
  if (direction === 'LONG') {
    const newSwing = struct15.sh1 && struct15.sh1 > entryPrice * 1.005;
    const liqSwept = struct15.eqh && struct15.eqh > 0;
    return newSwing && liqSwept;
  }
  const newSwing = struct15.sl1 && struct15.sl1 < entryPrice * 0.995;
  const liqSwept = struct15.eql && struct15.eql > 0;
  return newSwing && liqSwept;
}

// ── OPEN TRADE (1% TP targeting) ──────────────────────────────
async function openTrade(client, pick, wallet) {
  const sym = pick.symbol || pick.sym;
  const price = pick.lastPrice || pick.price;
  const direction = pick.direction;
  const isLong = direction !== 'SHORT';
  const leverage = CONFIG.HIGH_LEV_COINS.includes(sym) ? CONFIG.LEVERAGE_HIGH : CONFIG.LEVERAGE_LOW;

  await client.setLeverage({ symbol: sym, leverage });
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch (e) { if (!e.message?.includes('No need')) throw e; }

  const info = await client.getExchangeInfo();
  const sinfo = info.symbols.find(s => s.symbol === sym);
  const qtyPrec = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;

  const floorQ = (q) => Math.floor(q * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
  const fmtP = (p) => parseFloat(p.toFixed(pricePrec));

  // AI-optimized parameters
  const params = aiLearner.getOptimalParams();
  const TP_PCT = params.TP_PCT || CONFIG.TP_PCT;

  // SL from SMC engine (swing point based)
  const sl = fmtP(pick.sl);
  const slDist = Math.abs(price - sl) / price;

  // Position size: risk % of wallet
  const MIN_NOTIONAL = 5.5;
  const riskUsdt = wallet * (params.WALLET_RISK_PCT || CONFIG.WALLET_RISK_PCT);
  const rawQty = riskUsdt / (slDist * price);
  let qty = floorQ(rawQty);

  if (qty * price < MIN_NOTIONAL) {
    qty = Math.ceil(MIN_NOTIONAL / price * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
    log(`Qty bumped to ${qty} to meet min notional for ${sym}`);
  }
  if (qty <= 0) {
    log(`Qty too small for ${sym} — skipping`);
    return null;
  }

  // TP levels: 1%, 1.5%, 2% (AI-adjusted)
  const tp1 = fmtP(isLong ? price * (1 + TP_PCT) : price * (1 - TP_PCT));
  const tp2 = fmtP(isLong ? price * (1 + TP_PCT * CONFIG.TP2_MULT) : price * (1 - TP_PCT * CONFIG.TP2_MULT));
  const tp3 = fmtP(isLong ? price * (1 + TP_PCT * CONFIG.TP3_MULT) : price * (1 - TP_PCT * CONFIG.TP3_MULT));

  // Fee check
  const notional = qty * price;
  const totalFees = notional * CONFIG.TAKER_FEE * 2;
  const tp1Profit = notional * TP_PCT * 0.5;
  bLog.trade(`Fee check: notional=$${notional.toFixed(2)} fees=$${totalFees.toFixed(4)} TP1=$${tp1Profit.toFixed(4)} SL%=${(slDist*100).toFixed(3)}%`);
  log(`Fee check: notional=$${notional.toFixed(2)} fees=$${totalFees.toFixed(4)} TP1=$${tp1Profit.toFixed(4)} SL%=${(slDist*100).toFixed(3)}%`);
  if (tp1Profit < totalFees * 1.5) {
    bLog.trade(`Trade rejected: TP1 profit $${tp1Profit.toFixed(4)} < 1.5x fees $${(totalFees * 1.5).toFixed(4)}`);
    throw new Error(`Trade rejected: TP1 profit < 1.5x fees`);
  }

  const entrySide = isLong ? 'BUY' : 'SELL';
  const closeSide = isLong ? 'SELL' : 'BUY';

  // Market entry
  const order = await client.submitNewOrder({ symbol: sym, side: entrySide, type: 'MARKET', quantity: qty });
  await sleep(1500);

  // SL + TP via Algo Order API (Binance migrated conditional orders Dec 2025)
  let slOk = false, tpOk = false;

  try {
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
      type: 'STOP_MARKET', triggerPrice: sl,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    slOk = true;
    bLog.trade(`✅ Owner SL set at $${fmtPrice(sl)}`);
  } catch (e) { bLog.error(`Owner SL algo failed: ${e.message}`); }

  try {
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
      type: 'TAKE_PROFIT_MARKET', triggerPrice: tp3,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    tpOk = true;
    bLog.trade(`✅ Owner TP set at $${fmtPrice(tp3)}`);
  } catch (e) { bLog.error(`Owner TP algo failed: ${e.message}`); }

  if (!slOk || !tpOk) {
    const missing = [!slOk ? 'SL' : '', !tpOk ? 'TP' : ''].filter(Boolean).join('+');
    bLog.error(`⚠️ Owner ${sym} missing ${missing} — set manually!`);
    await notify(`*⚠️ ${sym} ${direction}* opened without *${missing}*! Set manually NOW.`);
  }

  tradeState.set(sym, {
    entry: price, tp1, tp2, tp3, sl, qty, isLong,
    tpHit1: false, tpHit2: false,
    pricePrec, qtyPrec,
    setup: pick.setup,
    openedAt: Date.now(),
  });

  return {
    sym, qty, entry: price, leverage, tp1, tp2, tp3, sl,
    slDist, confidence: pick.score, direction,
    orderId: order.orderId, setup: pick.setup,
  };
}

// ── CHECK MULTI-TP + EXIT + AI LEARNING ──────────────────────
async function checkTrailingStop(client) {
  try {
    const account = await client.getAccountInformation({ omitZeroBalances: false });
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    // Clean up state for closed positions + record to AI
    for (const sym of tradeState.keys()) {
      if (!positions.find(p => p.symbol === sym)) {
        const state = tradeState.get(sym);
        if (state) {
          // Position closed — record to AI learner
          const ticker = await client.getSymbolPriceTicker({ symbol: sym }).catch(() => null);
          const exitPrice = ticker ? parseFloat(ticker.price) : state.entry;
          const pnlPct = state.isLong
            ? (exitPrice - state.entry) / state.entry * 100
            : (state.entry - exitPrice) / state.entry * 100;
          const durationMin = Math.round((Date.now() - state.openedAt) / 60000);

          const winLoss = pnlPct > 0 ? 'WIN' : 'LOSS';
          bLog.trade(`CLOSED: ${sym} ${state.isLong ? 'LONG' : 'SHORT'} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${winLoss}) | duration: ${durationMin}min | entry=$${fmtPrice(state.entry)} exit=$${fmtPrice(exitPrice)}`);
          bLog.ai(`Recording trade to AI learner: ${sym} setup=${state.setup} ${winLoss} ${pnlPct.toFixed(2)}%`);

          aiLearner.recordTrade({
            symbol: sym,
            direction: state.isLong ? 'LONG' : 'SHORT',
            setup: state.setup || 'unknown',
            entryPrice: state.entry,
            exitPrice,
            pnlPct,
            leverage: CONFIG.HIGH_LEV_COINS.includes(sym) ? CONFIG.LEVERAGE_HIGH : CONFIG.LEVERAGE_LOW,
            durationMin,
            session: aiLearner.getCurrentSession(),
            slDistancePct: Math.abs(state.entry - state.sl) / state.entry * 100,
            tpDistancePct: Math.abs(state.tp1 - state.entry) / state.entry * 100,
          });

          recordDailyTrade(pnlPct > 0);
          log(`AI recorded: ${sym} PnL=${pnlPct.toFixed(2)}% duration=${durationMin}min setup=${state.setup}`);

          // Update DB trades table
          try {
            const db = require('./db');
            await db.query(
              `UPDATE trades SET status = 'CLOSED', pnl_usdt = $1
               WHERE symbol = $2 AND status = 'OPEN'`,
              [parseFloat((pnlPct * state.qty * state.entry / 100).toFixed(4)), sym]
            );
            bLog.trade(`DB updated: ${sym} → CLOSED (${winLoss})`);
          } catch (dbErr) {
            bLog.error(`DB update failed for ${sym}: ${dbErr.message}`);
          }
        }
        tradeState.delete(sym);
      }
    }

    for (const p of positions) {
      const sym = p.symbol;
      const entry = parseFloat(p.entryPrice);
      const amt = parseFloat(p.positionAmt);
      const isLong = amt > 0;
      const ticker = await client.getSymbolPriceTicker({ symbol: sym });
      const cur = parseFloat(ticker.price);
      const closeSide = isLong ? 'SELL' : 'BUY';
      const gain = isLong ? (cur - entry) / entry : (entry - cur) / entry;

      // 15m swing exit check
      try {
        const klines15 = await client.getKlines({ symbol: sym, interval: '15m', limit: 50 });
        const struct15 = detectStructure(klines15);
        if (shouldExit15m(struct15, entry, isLong ? 'LONG' : 'SHORT')) {
          log(`Exit [${isLong ? 'LONG' : 'SHORT'}] ${sym}: 15m swing + liquidity swept`);
          try { await client.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
          try { await client.cancelAllAlgoOpenOrders({ symbol: sym }); } catch (_) {}
          await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true' });
          await notify(
            `*Exit: 15m Swing + Liq Swept*\n` +
            `*${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `Entry: \`$${fmtPrice(entry)}\` Exit: \`$${fmtPrice(cur)}\`\n` +
            `PnL: *${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(2)}%*`
          );
          continue;
        }
      } catch (_) {}

      const state = tradeState.get(sym);
      if (!state) continue;

      const fmtP = (p) => parseFloat(p.toFixed(state.pricePrec));
      const floorQ = (q) => Math.floor(q * Math.pow(10, state.qtyPrec)) / Math.pow(10, state.qtyPrec);
      const origQty = Math.abs(state.qty);

      // TP1 hit: close 50%, SL → break even
      if (!state.tpHit1) {
        const tp1Hit = isLong ? cur >= state.tp1 : cur <= state.tp1;
        if (tp1Hit) {
          state.tpHit1 = true;
          const closeQty = floorQ(origQty * 0.5);
          const newSl = fmtP(state.entry);
          log(`TP1 hit ${sym} @ $${fmtPrice(cur)}: closing 50%, SL → BE`);
          try {
            try { await client.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
            try { await client.cancelAllAlgoOpenOrders({ symbol: sym }); } catch (_) {}
            if (closeQty > 0) {
              await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: closeQty, reduceOnly: 'true' });
            }
            await client.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
              type: 'STOP_MARKET', triggerPrice: newSl,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            await client.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
              type: 'TAKE_PROFIT_MARKET', triggerPrice: state.tp3,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
          } catch (e) { log(`TP1 exec warn: ${e.message}`); state.tpHit1 = false; }
          await notify(
            `*TP1 Hit! (1%)* — *${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `50% closed @ \`$${fmtPrice(cur)}\`\n` +
            `SL → break even | TP2: \`$${fmtPrice(state.tp2)}\``
          );
          continue;
        }
      }

      // TP2 hit: close 25%, SL → TP1
      if (state.tpHit1 && !state.tpHit2) {
        const tp2Hit = isLong ? cur >= state.tp2 : cur <= state.tp2;
        if (tp2Hit) {
          state.tpHit2 = true;
          const closeQty = floorQ(origQty * 0.25);
          const newSl = fmtP(state.tp1);
          log(`TP2 hit ${sym} @ $${fmtPrice(cur)}: closing 25%, SL → TP1`);
          try {
            try { await client.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
            try { await client.cancelAllAlgoOpenOrders({ symbol: sym }); } catch (_) {}
            if (closeQty > 0) {
              await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: closeQty, reduceOnly: 'true' });
            }
            await client.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
              type: 'STOP_MARKET', triggerPrice: newSl,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            await client.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
              type: 'TAKE_PROFIT_MARKET', triggerPrice: state.tp3,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
          } catch (e) { log(`TP2 exec warn: ${e.message}`); state.tpHit2 = false; }
          await notify(
            `*TP2 Hit! (1.5%)* — *${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `25% closed @ \`$${fmtPrice(cur)}\`\n` +
            `SL locked at TP1 | Riding 25% → TP3: \`$${fmtPrice(state.tp3)}\``
          );
          continue;
        }
      }
    }
  } catch (e) { log(`checkTrailingStop err: ${e.message}`); }
}

// ── BAN DETECTION ─────────────────────────────────────────────
let banUntil = 0;

function checkBanError(err) {
  const m = String(err?.message || err).match(/banned until (\d+)/);
  if (!m) return false;
  banUntil = parseInt(m[1]);
  const mins = Math.ceil((banUntil - Date.now()) / 60000);
  log(`IP BANNED — pausing for ${mins} min`);
  notify(`*Binance IP Banned* — paused ${mins} min`);
  return true;
}

// ── MAIN TRADING CYCLE ───────────────────────────────────────
async function main() {
  if (banUntil > Date.now()) {
    log(`Still banned — skipping cycle`);
    return;
  }

  log('=== AI Smart Trader v4 Cycle Start ===');
  const hasOwnerKeys = !!(API_KEY && API_SECRET);

  try {
    // ── Step 1: SMC Scan (includes AI weights + sentiment) ──
    const signals = await scanSMC(log);

    if (!signals.length) {
      log('No SMC signals found this cycle.');

      // Still check trailing stops if we have open positions
      if (hasOwnerKeys) {
        const client = getClient();
        await checkTrailingStop(client);
      }
      return;
    }

    // Try signals in order — fall through to runner-ups if first pick is too expensive
    let executed = false;
    for (const pick of signals) {
      log(`Signal: ${pick.symbol} ${pick.direction} score=${pick.score} setup=${pick.setup} AI=${pick.aiModifier}`);
      bLog.trade(`TRYING: ${pick.symbol} ${pick.direction} | setup=${pick.setupName} score=${pick.score} | TP1=$${fmtPrice(pick.tp1)} SL=$${fmtPrice(pick.sl)} | zone=${pick.premiumDiscount} RSI=${pick.rsi}`);

      // ── Step 2: Execute for all registered users ──
      bLog.trade(`Executing trade: ${pick.symbol} ${pick.direction} for registered users...`);
      const result = await executeForAllUsers(pick);

      if (result === 'ALL_TOO_EXPENSIVE') {
        bLog.trade(`${pick.symbol} too expensive for all users — trying next signal...`);
        continue;
      }
      executed = true;
      break;
    }
    const pick = signals[0]; // keep reference for owner path

    // ── Step 3: Owner's Binance account ──
    if (hasOwnerKeys) {
      bLog.trade(`Executing trade on owner Binance account...`);
      try {
        const client = getClient();
        const account = await client.getAccountInformation({ omitZeroBalances: false });
        const wallet = parseFloat(account.totalWalletBalance);
        const avail = parseFloat(account.availableBalance);
        bLog.trade(`Owner wallet: $${wallet.toFixed(2)} available: $${avail.toFixed(2)}`);

        await checkTrailingStop(client);

        if (avail >= CONFIG.MIN_BALANCE) {
          const openPos = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);
          if (openPos.length === 0) {
            bLog.trade(`No open positions — opening trade on ${pick.symbol}...`);
            const result = await openTrade(client, pick, wallet);
            if (result) {
              const dirEmoji = result.direction !== 'SHORT' ? '🟢' : '🔴';
              bLog.trade(`TRADE OPENED: ${result.sym} ${result.direction} x${result.leverage} qty=${result.qty} entry=$${fmtPrice(result.entry)}`);
              await notify(
                `*AI Trade — ${now()}*\n` +
                `*${result.sym}* ${dirEmoji} *${result.direction} x${result.leverage}*\n` +
                `Setup: *${result.setup}*\n` +
                `Entry: \`$${fmtPrice(result.entry)}\`\n` +
                `TP1(1%): \`$${fmtPrice(result.tp1)}\` | TP2: \`$${fmtPrice(result.tp2)}\` | TP3: \`$${fmtPrice(result.tp3)}\`\n` +
                `SL: \`$${fmtPrice(result.sl)}\` (${(result.slDist*100).toFixed(2)}%)\n` +
                `Qty: \`${result.qty}\` | Wallet: *$${avail.toFixed(2)}*\n` +
                `AI Score: *${pick.score}* | Sentiment: ${pick.sentiment || 'neutral'}`
              );
            } else {
              bLog.trade(`openTrade returned null for ${pick.symbol} — trade rejected`);
            }
          } else {
            bLog.trade(`Already in position: ${openPos.map(p => p.symbol).join(', ')} — monitoring only`);
          }
        } else {
          bLog.trade(`Owner balance too low: $${avail.toFixed(2)} < min $${CONFIG.MIN_BALANCE}`);
        }
      } catch (ownerErr) {
        bLog.error(`Owner trade error: ${ownerErr.message}`);
        log(`Owner trade error: ${ownerErr.message}`);
      }
    } else {
      bLog.system(`No owner API keys in env — relying on user keys from dashboard`);
    }

  } catch (err) {
    if (checkBanError(err)) return;
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes('agreement')) {
      bLog.error(`Binance agreement required: ${msg}`);
      await notify(`*Action Required — Binance Futures Agreement*\nSign the USDT-M Futures agreement on Binance.`);
      return;
    }
    bLog.error(`Cycle error: ${msg}`);
    log(`ERROR: ${msg}`);
    await notify(`*Bot Error — ${now()}*\n\`${msg.substring(0, 200)}\``);
  }

  log('=== Cycle End ===');
}

function getClient() {
  return new USDMClient({ api_key: API_KEY, api_secret: API_SECRET });
}

// ── MULTI-USER TRADE EXECUTION ──────────────────────────────
async function executeForAllUsers(pick) {
  let db, cryptoUtils, BitunixClient;
  try {
    db = require('./db');
    cryptoUtils = require('./crypto-utils');
    BitunixClient = require('./bitunix-client').BitunixClient;
  } catch (e) {
    bLog.error(`Multi-user deps not available: ${e.message}`);
    log(`Multi-user deps not available: ${e.message}`);
    return;
  }

  try {
    const allKeys = await db.query(
      `SELECT ak.*, u.email FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true`
    );

    if (!allKeys.length) {
      bLog.trade('No enabled user API keys found — no users to trade for');
      log('No enabled user API keys — skipping multi-user execution');
      return;
    }

    const keys = allKeys;
    const sym = pick.symbol || pick.sym;
    bLog.trade(`Found ${keys.length} unique API key(s) — executing ${sym} ${pick.direction}...`);
    log(`Executing ${sym} ${pick.direction} for ${keys.length} user keys`);

    // Run sequentially per user to prevent race conditions (parallel DB checks)
    const results = [];
    for (const key of keys) {
      const result = await (async () => {
      try {
        const symbol = sym;
        const allowedCoins = (key.allowed_coins || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        const bannedCoins = (key.banned_coins || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

        if (allowedCoins.length > 0 && !allowedCoins.includes(symbol)) {
          bLog.trade(`User ${key.email}: ${symbol} not in allowed list — skipped`);
          return;
        }
        if (bannedCoins.includes(symbol)) {
          bLog.trade(`User ${key.email}: ${symbol} is banned — skipped`);
          return;
        }

        // Check DB for existing open trade on same symbol to prevent duplicates
        const existingTrade = await db.query(
          `SELECT id FROM trades WHERE user_id = $1 AND symbol = $2 AND status = 'OPEN' LIMIT 1`,
          [key.user_id, symbol]
        );
        if (existingTrade.length > 0) {
          bLog.trade(`User ${key.email}: already has OPEN trade on ${symbol} in DB — skipping duplicate`);
          return;
        }

        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        const maxPos = parseInt(key.max_positions) || 1;

        const price = pick.lastPrice || pick.price || pick.entry;
        const isLong = pick.direction !== 'SHORT';
        const userRiskPct = parseFloat(key.risk_pct) || CONFIG.WALLET_RISK_PCT;
        const userLev = price < 100 ? 10 : (parseInt(key.leverage) || CONFIG.LEVERAGE_LOW);

        let account, wallet, openPosCount;

        if (key.platform === 'binance') {
          const userClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret });
          account = await userClient.getAccountInformation({ omitZeroBalances: false });
          wallet = parseFloat(account.totalWalletBalance);
          const openPositions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);
          openPosCount = openPositions.length;

          if (openPosCount >= maxPos) { bLog.trade(`User ${key.email}: at max positions (${openPosCount}/${maxPos})`); return; }
          if (wallet < CONFIG.MIN_BALANCE) { bLog.trade(`User ${key.email}: wallet too low ($${wallet.toFixed(2)})`); return; }

          // Check if already in a position on this specific symbol
          const existingPos = openPositions.find(p => p.symbol === symbol);
          if (existingPos) {
            bLog.trade(`User ${key.email}: already in ${symbol} position — skipping duplicate`);
            return;
          }

          bLog.trade(`User ${key.email} Binance: wallet=$${wallet.toFixed(2)} pos=${openPosCount}/${maxPos} lev=x${userLev}`);

          // Use SMC engine SL if available, otherwise 1% default
          const slPrice = pick.sl || (isLong ? price * (1 - CONFIG.TP_PCT) : price * (1 + CONFIG.TP_PCT));
          const tp3Price = pick.tp3 || (isLong ? price * (1 + CONFIG.TP_PCT * CONFIG.TP3_MULT) : price * (1 - CONFIG.TP_PCT * CONFIG.TP3_MULT));

          try { await userClient.setLeverage({ symbol, leverage: userLev }); } catch (_) {}
          try { await userClient.setMarginType({ symbol, marginType: 'ISOLATED' }); } catch (e) { if (!e.message?.includes('No need')) throw e; }

          const info = await userClient.getExchangeInfo();
          const sinfo = info.symbols.find(s => s.symbol === symbol);
          if (!sinfo) { bLog.error(`User ${key.email}: ${symbol} not found on Binance`); return; }
          const qtyPrec = sinfo.quantityPrecision ?? 6;
          const pricePrec = sinfo.pricePrecision ?? 2;
          const fmtP = (p) => parseFloat(p.toFixed(pricePrec));

          // Position sizing: use full available margin with leverage
          const marginUsdt = wallet * userRiskPct;
          const notional = marginUsdt * userLev;
          let qty = notional / price;

          // Ensure minimum notional ($5.5) and minimum lot size
          const minQty = 1 / Math.pow(10, qtyPrec); // e.g. 0.001 for BTC
          const minNotionalQty = Math.ceil(5.5 / price * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
          qty = Math.floor(qty * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

          if (qty < minNotionalQty) qty = minNotionalQty;
          if (qty < minQty) qty = minQty;

          // Check if wallet can afford this qty with leverage
          const requiredMargin = (qty * price) / userLev;
          if (requiredMargin > wallet * 0.95) {
            bLog.trade(`User ${key.email}: ${symbol} needs $${requiredMargin.toFixed(2)} margin but only $${wallet.toFixed(2)} available — too expensive`);
            return 'TOO_EXPENSIVE';
          }

          bLog.trade(`User ${key.email}: placing MARKET ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty}...`);
          await userClient.submitNewOrder({ symbol, side: isLong ? 'BUY' : 'SELL', type: 'MARKET', quantity: qty });

          // Wait for position to register before setting SL/TP
          await sleep(1500);

          // SL + TP via Algo Order API (Binance migrated conditional orders Dec 2025)
          const closeSide = isLong ? 'SELL' : 'BUY';
          const slFmt = fmtP(slPrice);
          const tpFmt = fmtP(tp3Price);
          bLog.trade(`Setting SL=$${slFmt} TP=$${tpFmt} for ${symbol} via Algo API...`);

          let slOk = false, tpOk = false;

          try {
            await userClient.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol, side: closeSide,
              type: 'STOP_MARKET', triggerPrice: slFmt,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            slOk = true;
            bLog.trade(`✅ SL set at $${slFmt}`);
          } catch (e) {
            bLog.error(`❌ SL algo failed for ${symbol}: ${e.message}`);
          }

          try {
            await userClient.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol, side: closeSide,
              type: 'TAKE_PROFIT_MARKET', triggerPrice: tpFmt,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            tpOk = true;
            bLog.trade(`✅ TP set at $${tpFmt}`);
          } catch (e) {
            bLog.error(`❌ TP algo failed for ${symbol}: ${e.message}`);
          }

          if (!slOk || !tpOk) {
            const missing = [!slOk ? 'SL' : '', !tpOk ? 'TP' : ''].filter(Boolean).join(' and ');
            bLog.error(`⚠️ ${symbol} OPEN without ${missing} — SET MANUALLY!`);
            await notify(`*⚠️ WARNING: ${symbol} ${pick.direction}*\nPosition opened but *${missing} failed to set!*\nSet manually on Binance NOW.`);
          }

          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')`,
            [key.id, key.user_id, symbol, pick.direction, price, fmtP(slPrice), fmtP(tp3Price), qty, userLev]
          );
          bLog.trade(`✅ Binance OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty} entry=$${fmtPrice(price)}`);
          log(`Binance OK: ${key.email} ${symbol} ${pick.direction} x${userLev}`);

        } else if (key.platform === 'bitunix') {
          const userClient = new BitunixClient({ apiKey, apiSecret });
          account = await userClient.getAccountInformation();
          wallet = parseFloat(account.totalWalletBalance);
          const bxPositions = account.positions || [];
          openPosCount = bxPositions.length;

          if (openPosCount >= maxPos) { bLog.trade(`User ${key.email}: at max positions (${openPosCount}/${maxPos})`); return; }
          if (wallet < CONFIG.MIN_BALANCE) { bLog.trade(`User ${key.email}: wallet too low ($${wallet.toFixed(2)})`); return; }

          const existingPosBx = bxPositions.find(p => p.symbol === symbol);
          if (existingPosBx) {
            bLog.trade(`User ${key.email}: already in ${symbol} position — skipping duplicate`);
            return;
          }

          bLog.trade(`User ${key.email} Bitunix: wallet=$${wallet.toFixed(2)} pos=${openPosCount}/${maxPos} lev=x${userLev}`);

          const marginUsdt = wallet * userRiskPct;
          const notional = marginUsdt * userLev;
          let qty = notional / price;
          if (qty * price < 5.5) qty = 5.5 / price;
          qty = parseFloat(qty.toFixed(6));
          if (qty <= 0) qty = parseFloat((5.5 / price).toFixed(6));

          const requiredMarginBx = (qty * price) / userLev;
          if (requiredMarginBx > wallet * 0.95) {
            bLog.trade(`User ${key.email}: ${symbol} needs $${requiredMarginBx.toFixed(2)} margin but only $${wallet.toFixed(2)} — too expensive`);
            return 'TOO_EXPENSIVE';
          }

          const slPrice = pick.sl || (isLong ? price * (1 - CONFIG.TP_PCT) : price * (1 + CONFIG.TP_PCT));
          const tp3Price = pick.tp3 || (isLong ? price * (1 + CONFIG.TP_PCT * CONFIG.TP3_MULT) : price * (1 - CONFIG.TP_PCT * CONFIG.TP3_MULT));

          try { await userClient.changeMarginMode(symbol, 'ISOLATION'); } catch (_) {}
          try { await userClient.changeLeverage(symbol, userLev); } catch (_) {}

          const slFmtBx = parseFloat(slPrice.toFixed(8));
          const tpFmtBx = parseFloat(tp3Price.toFixed(8));

          // Place order with TP/SL inline — more reliable than setting after
          bLog.trade(`User ${key.email}: placing Bitunix MARKET ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty} SL=$${slFmtBx} TP=$${tpFmtBx}...`);
          const order = await userClient.placeOrder({
            symbol, side: isLong ? 'BUY' : 'SELL',
            qty: String(qty), orderType: 'MARKET', tradeSide: 'OPEN',
            tpPrice: tpFmtBx, tpStopType: 'MARK_PRICE', tpOrderType: 'MARKET',
            slPrice: slFmtBx, slStopType: 'MARK_PRICE', slOrderType: 'MARKET',
          });
          bLog.trade(`✅ Bitunix order placed with TP/SL inline`);

          // Verify TP/SL was set by checking position
          await sleep(1500);
          const positions = await userClient.getOpenPositions(symbol);
          const pos = Array.isArray(positions) ? positions.find(p => p.symbol === symbol) : null;

          if (pos && pos.positionId) {
            bLog.trade(`Bitunix position confirmed: ${pos.positionId}`);
            // If inline TP/SL didn't stick, set them on the position as backup
            if (!pos.tpPrice && !pos.slPrice) {
              bLog.trade(`Bitunix inline TP/SL not detected — setting via position API...`);
              try {
                await userClient.placePositionTpSl({
                  symbol, positionId: pos.positionId,
                  tpPrice: tpFmtBx, slPrice: slFmtBx,
                });
                bLog.trade(`✅ Bitunix TP/SL set via position API`);
              } catch (e) {
                bLog.error(`❌ Bitunix TP/SL FAILED: ${e.message} — SET MANUALLY`);
                await notify(`*⚠️ Bitunix ${symbol} ${pick.direction}*\nTP/SL failed! Set manually.`);
              }
            }
          } else {
            bLog.error(`❌ Bitunix position not found after order — verify on exchange`);
          }

          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')`,
            [key.id, key.user_id, symbol, pick.direction, price, parseFloat(slPrice.toFixed(8)), parseFloat(tp3Price.toFixed(8)), qty, userLev]
          );
          bLog.trade(`✅ Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty}`);
          log(`Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev}`);
        } else {
          bLog.error(`User ${key.email}: unknown platform "${key.platform}"`);
        }
      } catch (err) {
        bLog.error(`User ${key.email} trade error: ${err.message}`);
        log(`User ${key.email} trade error: ${err.message}`);
      }
    })().catch(e => e.message);
      results.push(result);
    }

    const tooExpensive = results.filter(r => r === 'TOO_EXPENSIVE').length;
    const ok = results.length - tooExpensive;
    bLog.trade(`Multi-user execution done: ${ok} traded, ${tooExpensive} too expensive`);
    log(`Multi-user done: ${ok} ok, ${tooExpensive} too expensive`);

    // If every user found this coin too expensive, signal caller to try next
    if (tooExpensive === keys.length) return 'ALL_TOO_EXPENSIVE';
    return 'OK';
  } catch (err) {
    bLog.error(`Multi-user error: ${err.message}`);
    log(`Multi-user error: ${err.message}`);
    return 'ERROR';
  }
}

// ── SYNC DB TRADE STATUS WITH EXCHANGE ──────────────────────
async function syncTradeStatus() {
  let db, cryptoUtils, BitunixClient;
  try {
    db = require('./db');
    cryptoUtils = require('./crypto-utils');
    BitunixClient = require('./bitunix-client').BitunixClient;
  } catch (e) { return; }

  try {
    const openTrades = await db.query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE t.status = 'OPEN'`
    );

    if (!openTrades.length) return;

    // Group by API key to avoid repeated exchange calls
    const byKey = {};
    for (const t of openTrades) {
      const kid = t.api_key_id;
      if (!byKey[kid]) byKey[kid] = { key: t, trades: [] };
      byKey[kid].trades.push(t);
    }

    for (const { key, trades } of Object.values(byKey)) {
      try {
        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

        let openSymbols = new Map(); // symbol → { amt, unrealizedPnl, entryPrice }

        if (key.platform === 'binance') {
          const userClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret });
          const account = await userClient.getAccountInformation({ omitZeroBalances: false });
          for (const p of account.positions) {
            if (parseFloat(p.positionAmt) !== 0) {
              openSymbols.set(p.symbol, {
                amt: parseFloat(p.positionAmt),
                pnl: parseFloat(p.unrealizedProfit || 0),
              });
            }
          }
        } else if (key.platform === 'bitunix') {
          const userClient = new BitunixClient({ apiKey, apiSecret });
          const account = await userClient.getAccountInformation();
          for (const p of (account.positions || [])) {
            openSymbols.set(p.symbol, {
              amt: parseFloat(p.positionAmt || 0),
              pnl: parseFloat(p.unrealizedProfit || 0),
            });
          }
        }

        bLog.system(`Sync: exchange has ${openSymbols.size} open positions, DB has ${trades.length} OPEN trades`);

        for (const trade of trades) {
          const exchangePos = openSymbols.get(trade.symbol);

          if (!exchangePos) {
            // Position closed on exchange — mark as WIN/LOSS
            const entryPrice = parseFloat(trade.entry_price);
            const ticker = key.platform === 'binance'
              ? await new USDMClient({ api_key: apiKey, api_secret: apiSecret })
                  .getSymbolPriceTicker({ symbol: trade.symbol }).catch(() => null)
              : null;
            const exitPrice = ticker ? parseFloat(ticker.price) : entryPrice;
            const isLong = trade.direction !== 'SHORT';
            const pnlPct = isLong
              ? (exitPrice - entryPrice) / entryPrice * 100
              : (entryPrice - exitPrice) / entryPrice * 100;
            const pnlUsdt = parseFloat((pnlPct * parseFloat(trade.quantity || 1) * entryPrice / 100).toFixed(4));

            await db.query(
              `UPDATE trades SET status = $1, pnl_usdt = $2 WHERE id = $3`,
              [pnlPct > 0 ? 'WIN' : 'LOSS', pnlUsdt, trade.id]
            );
            bLog.trade(`DB synced: ${trade.symbol} → ${pnlPct > 0 ? 'WIN' : 'LOSS'} PnL=$${pnlUsdt}`);
          } else {
            // Still open — update live unrealized PnL
            const livePnl = parseFloat(exchangePos.pnl.toFixed(4));
            await db.query(
              `UPDATE trades SET pnl_usdt = $1 WHERE id = $2`,
              [livePnl, trade.id]
            );
          }
        }
      } catch (e) {
        bLog.error(`Sync error for key ${key.api_key_id}: ${e.message}`);
      }
    }
  } catch (e) {
    bLog.error(`syncTradeStatus error: ${e.message}`);
  }
}

async function run() {
  log(`AI Smart Trader v4 | Telegram: ${!!TELEGRAM_TOKEN} | Chats: ${PRIVATE_CHATS.join(', ') || 'NONE'}`);
  await syncTradeStatus();
  await main();
}

module.exports = { run };
