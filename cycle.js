// ============================================================
// Smart Crypto Trader v4 — AI Self-Learning Edition
// Binance USDT-M Futures + Bitunix Futures
// Strategy: Swing Cascade (15M → 3M → 1M swing confirmation)
// TP: Dynamic based on volume (4.5%/3%/2%), SL: 3%
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { scanSMC, recordDailyTrade, detectSwings, SWING_LENGTHS } = require('./smc-engine');
const { getSentimentScores } = require('./sentiment-scraper');
const { log: bLog } = require('./bot-logger');
const { getBinanceRequestOptions, getFetchOptions } = require('./proxy-agent');

const API_KEY        = process.env.BINANCE_API_KEY    || '';
const API_SECRET     = process.env.BINANCE_API_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN     || '';
const TELEGRAM_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const PRIVATE_CHATS  = TELEGRAM_CHATS.filter(id => !id.startsWith('-'));

// ── CONFIG (defaults — AI may override some via getOptimalParams) ─
const BTC_ETH_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT']);

const CONFIG = {
  MIN_BALANCE:     5,
  TAKER_FEE:       0.0004,

  BLACKLIST: [
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
    'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
  ],
};

// ── Trailing SL config ─────────────────────────────────────
const TRAILING_SL = {
  INITIAL_SL_PCT:  0.01,   // -1% initial SL from entry
  FIRST_STEP:      0.013,  // First profit lock at 1.3%
  STEP_INCREMENT:  0.01,   // Each subsequent step is +1%
};

// ── Compound: always use current wallet balance ─────────────
function getDailyCapital(key, currentBalance) {
  return currentBalance;
}

// Get token-specific leverage: user per-key → admin global → risk level → 20x default
async function getTokenLeverage(symbol, apiKeyId = null) {
  try {
    const { query } = require('./db');

    // Priority 1: User per-key per-token leverage override
    if (apiKeyId) {
      const userTokenRows = await query(
        'SELECT leverage FROM user_token_leverage WHERE api_key_id = $1 AND symbol = $2',
        [apiKeyId, symbol]
      );
      if (userTokenRows.length > 0) {
        return parseInt(userTokenRows[0].leverage);
      }
    }

    // Priority 2: Admin global token leverage
    const tokenRows = await query(
      'SELECT leverage FROM token_leverage WHERE symbol = $1 AND enabled = true',
      [symbol]
    );
    if (tokenRows.length > 0) {
      return parseInt(tokenRows[0].leverage);
    }

    // Priority 3: Risk level max_leverage from API key
    if (apiKeyId) {
      const keyRows = await query(
        `SELECT rl.max_leverage
         FROM api_keys ak
         LEFT JOIN risk_levels rl ON ak.risk_level_id = rl.id
         WHERE ak.id = $1 AND rl.enabled = true`,
        [apiKeyId]
      );
      if (keyRows.length > 0 && keyRows[0].max_leverage) {
        return parseInt(keyRows[0].max_leverage);
      }
    }

    return 20;
  } catch (err) {
    console.error('Error getting token leverage:', err.message);
    return 20;
  }
}

// Get capital percentage for trading (default 10%)
async function getCapitalPercentage(apiKeyId = null) {
  try {
    if (!apiKeyId) return 10.0;

    const { query } = require('./db');
    const keyRows = await query(
      `SELECT COALESCE(ak.capital_percentage, rl.capital_percentage, 10.0) as capital_pct
       FROM api_keys ak
       LEFT JOIN risk_levels rl ON ak.risk_level_id = rl.id
       WHERE ak.id = $1`,
      [apiKeyId]
    );

    if (keyRows.length > 0) {
      return parseFloat(keyRows[0].capital_pct);
    }

    return 10.0;
  } catch (err) {
    console.error('Error getting capital percentage:', err.message);
    return 10.0;
  }
}

// Check if a token is globally banned by admin
async function isTokenBanned(symbol) {
  try {
    const { query } = require('./db');
    // Check if explicitly banned
    const banned = await query(
      'SELECT banned FROM global_token_settings WHERE symbol = $1 AND banned = true',
      [symbol]
    );
    if (banned.length > 0) return true;

    // Check allowed whitelist — if any allowed tokens exist, only those can trade
    const allowed = await query(
      'SELECT symbol FROM global_token_settings WHERE enabled = true AND banned = false'
    );
    if (allowed.length > 0) {
      const isAllowed = allowed.some(r => r.symbol === symbol);
      return !isAllowed;
    }

    return false;
  } catch {
    return false;
  }
}

// AI-tuned leverage — params come from getOptimalParams()
function getLeverage(symbol, price, params = {}) {
  if (BTC_ETH_SYMBOLS.has(symbol)) return Math.min(params.LEV_BTC_ETH || 20, 20);
  return Math.min(params.LEV_ALT || 20, 20);
}

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

// ── 15m EXIT CHECK (structure break using Zeiierman swings) ──
function shouldExit15m(klines15, entryPrice, direction) {
  const swings = detectSwings(klines15, SWING_LENGTHS['15m']);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');

  if (direction === 'LONG' && swingHighs.length >= 2) {
    const recent = swingHighs[swingHighs.length - 1];
    const prev = swingHighs[swingHighs.length - 2];
    const isLH = recent.price < prev.price;
    const curPrice = parseFloat(klines15[klines15.length - 1][4]);
    return isLH && curPrice < entryPrice;
  }
  if (direction === 'SHORT' && swingLows.length >= 2) {
    const recent = swingLows[swingLows.length - 1];
    const prev = swingLows[swingLows.length - 2];
    const isHL = recent.price > prev.price;
    const curPrice = parseFloat(klines15[klines15.length - 1][4]);
    return isHL && curPrice > entryPrice;
  }
  return false;
}

// ── TRAILING SL: Update exchange stop-loss order ─────────────
async function updateStopLoss(client, symbol, newSlPrice, closeSide, platform, pricePrec) {
  const fmtP = (p) => parseFloat(p.toFixed(pricePrec || 2));
  const slFmt = fmtP(newSlPrice);

  if (platform === 'binance') {
    // Cancel existing algo SL orders, then place new one
    try { await client.cancelAllAlgoOpenOrders({ symbol }); } catch (_) {}
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol, side: closeSide,
      type: 'STOP_MARKET', triggerPrice: slFmt,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    return true;
  } else if (platform === 'bitunix') {
    // Update position SL via Bitunix API
    const positions = await client.getOpenPositions(symbol);
    const pos = Array.isArray(positions) ? positions.find(p => p.symbol === symbol) : null;
    if (pos && pos.positionId) {
      await client.placePositionTpSl({
        symbol, positionId: pos.positionId,
        slPrice: slFmt,
      });
      return true;
    }
    return false;
  }
  return false;
}

// ── TRAILING SL: Calculate and step SL up as profit grows ────
// Returns { stepped: boolean, newSlPrice, newLastStep } or null
function calculateTrailingStep(entryPrice, currentPrice, isLong, lastStep) {
  const profitPct = isLong
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;

  // Determine what the next step threshold is
  const nextStep = lastStep === 0 ? TRAILING_SL.FIRST_STEP : lastStep + TRAILING_SL.STEP_INCREMENT;

  if (profitPct < nextStep) return null;

  // Price may have jumped multiple levels — find the highest reached step
  let reachedStep = nextStep;
  while (true) {
    const stepAfter = reachedStep + TRAILING_SL.STEP_INCREMENT;
    if (profitPct >= stepAfter) {
      reachedStep = stepAfter;
    } else {
      break;
    }
  }

  // Set SL at the reached step profit level
  const newSlPrice = isLong
    ? entryPrice * (1 + reachedStep)
    : entryPrice * (1 - reachedStep);

  return { stepped: true, newSlPrice, newLastStep: reachedStep };
}

// ── PROFIT SPLIT: Credit 60% user, 40% platform fee ─────────
async function recordProfitSplit(db, userId, apiKeyId, pnlUsdt, symbol) {
  if (pnlUsdt <= 0) return;

  try {
    // Get profit share settings from the API key
    const keyRows = await db.query(
      'SELECT profit_share_user_pct, profit_share_admin_pct FROM api_keys WHERE id = $1',
      [apiKeyId]
    );
    const userPct = keyRows.length > 0 ? (parseFloat(keyRows[0].profit_share_user_pct) || 60) : 60;
    const adminPct = keyRows.length > 0 ? (parseFloat(keyRows[0].profit_share_admin_pct) || 40) : 40;

    const userShare = pnlUsdt * userPct / 100;
    const platformFee = pnlUsdt * adminPct / 100;

    // Record platform fee as wallet transaction
    await db.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, status, note)
       VALUES ($1, 'platform_fee', $2, 'completed', $3)`,
      [userId, platformFee, `${adminPct}% platform fee on ${symbol} profit $${pnlUsdt.toFixed(2)}`]
    );

    // Record user profit share
    await db.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, status, note)
       VALUES ($1, 'profit_share', $2, 'completed', $3)`,
      [userId, userShare, `${userPct}% profit share on ${symbol} profit $${pnlUsdt.toFixed(2)}`]
    );

    // Credit user's 60% to their cash wallet
    await db.query(
      `UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2`,
      [userShare, userId]
    );

    // Handle referral commission from the platform's share
    const referrerRow = await db.query(
      'SELECT referred_by FROM users WHERE id = $1',
      [userId]
    );
    if (referrerRow.length > 0 && referrerRow[0].referred_by) {
      const referrerId = referrerRow[0].referred_by;
      const settingsRow = await db.query(
        "SELECT value FROM settings WHERE key = 'referral_commission_pct'"
      );
      const refPct = settingsRow.length > 0 ? parseFloat(settingsRow[0].value) : 10;
      const referralAmount = platformFee * refPct / 100;

      if (referralAmount > 0) {
        await db.query(
          `UPDATE users SET cash_wallet = cash_wallet + $1,
                            commission_earned = commission_earned + $1,
                            total_referral_commission = total_referral_commission + $1
           WHERE id = $2`,
          [referralAmount, referrerId]
        );
        await db.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, status, note)
           VALUES ($1, 'referral_commission', $2, 'completed', $3)`,
          [referrerId, referralAmount, `${refPct}% referral commission from user #${userId} ${symbol} trade`]
        );
      }
    }

    bLog.trade(`Profit split: ${symbol} PnL=$${pnlUsdt.toFixed(2)} → user ${userPct}%=$${userShare.toFixed(2)} platform ${adminPct}%=$${platformFee.toFixed(2)}`);
  } catch (err) {
    bLog.error(`Profit split error for ${symbol}: ${err.message}`);
  }
}

// ── OPEN TRADE (RR 1:1.5) ────────────────────────────────────
async function openTrade(client, pick, wallet) {
  const sym = pick.symbol || pick.sym;
  const price = pick.lastPrice || pick.price;
  const direction = pick.direction;
  const isLong = direction !== 'SHORT';

  // Check global token ban before entry
  if (await isTokenBanned(sym)) {
    bLog.trade(`${sym} is globally banned — skipping`);
    return null;
  }

  // Get AI-tuned params for leverage and sizing
  const aiParams = await aiLearner.getOptimalParams();
  const leverage = getLeverage(sym, price, aiParams);
  const walletSizePct = aiParams.WALLET_SIZE_PCT || 0.10;

  await client.setLeverage({ symbol: sym, leverage });
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch (e) { if (!e.message?.includes('No need')) throw e; }

  const info = await client.getExchangeInfo();
  const sinfo = info.symbols.find(s => s.symbol === sym);
  const qtyPrec = sinfo.quantityPrecision ?? 0;
  const pricePrec = sinfo.pricePrecision;

  const floorQ = (q) => Math.floor(q * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
  const fmtP = (p) => parseFloat(p.toFixed(pricePrec));

  // SL from engine (1m swing candle + AI-tuned buffer)
  const sl = fmtP(pick.sl);
  const slDist = Math.abs(price - sl) / price;

  // TP from engine (AI-tuned RR ratio)
  const tp1 = fmtP(pick.tp1);
  const tp2 = fmtP(pick.tp2);
  const tp3 = fmtP(pick.tp3);

  // Initial trailing SL at -1% from entry
  const initialSlPrice = fmtP(isLong ? price * (1 - TRAILING_SL.INITIAL_SL_PCT) : price * (1 + TRAILING_SL.INITIAL_SL_PCT));

  // Position size: 10% of wallet = margin, notional = margin * leverage
  const MIN_NOTIONAL = 5.5;
  const tradeUsdt = wallet * walletSizePct;
  const notionalUsdt = tradeUsdt * leverage;
  const rawQty = notionalUsdt / price;
  let qty = floorQ(rawQty);

  if (qty * price < MIN_NOTIONAL) {
    qty = Math.ceil(MIN_NOTIONAL / price * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
    log(`Qty bumped to ${qty} to meet min notional for ${sym}`);
  }
  if (qty <= 0) {
    log(`Qty too small for ${sym} — skipping`);
    return null;
  }

  // Margin check
  const notional = qty * price;
  const requiredMargin = notional / leverage;
  if (requiredMargin > wallet * 0.95) {
    log(`Margin $${requiredMargin.toFixed(2)} exceeds wallet $${wallet.toFixed(2)} for ${sym}`);
    return 'TOO_EXPENSIVE';
  }

  // Fee check
  const totalFees = notional * CONFIG.TAKER_FEE * 2;
  const tpDist = Math.abs(tp1 - price) / price;
  const tp1Profit = notional * tpDist;
  const slMarginLoss = slDist * leverage * 100;
  const tpMarginGain = Math.abs(tp1 - price) / price * leverage * 100;
  bLog.trade(`Size: ${(walletSizePct*100).toFixed(0)}% wallet=$${tradeUsdt.toFixed(2)} notional=$${notional.toFixed(2)} lev=${leverage}x margin=$${requiredMargin.toFixed(2)} | SL=${slMarginLoss.toFixed(0)}%margin TP=${tpMarginGain.toFixed(0)}%margin`);
  log(`Trade: ${sym} ${direction} lev=${leverage}x qty=${qty} notional=$${notional.toFixed(2)} margin=$${requiredMargin.toFixed(2)}`);
  if (tp1Profit < totalFees * 1.5) {
    bLog.trade(`Trade rejected: TP profit $${tp1Profit.toFixed(4)} < 1.5x fees $${(totalFees * 1.5).toFixed(4)}`);
    throw new Error(`Trade rejected: TP profit < 1.5x fees`);
  }

  const entrySide = isLong ? 'BUY' : 'SELL';
  const closeSide = isLong ? 'SELL' : 'BUY';

  // Market entry
  const order = await client.submitNewOrder({ symbol: sym, side: entrySide, type: 'MARKET', quantity: qty });
  await sleep(1500);

  // Set initial trailing SL at -1% (not the engine SL)
  let slOk = false, tpOk = false;

  try {
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
      type: 'STOP_MARKET', triggerPrice: initialSlPrice,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    slOk = true;
    bLog.trade(`SL set at $${fmtPrice(initialSlPrice)} (-${(TRAILING_SL.INITIAL_SL_PCT*100).toFixed(0)}% trailing)`);
  } catch (e) { bLog.error(`Owner SL algo failed: ${e.message}`); }

  try {
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
      type: 'TAKE_PROFIT_MARKET', triggerPrice: tp3,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    tpOk = true;
    bLog.trade(`TP set at $${fmtPrice(tp3)}`);
  } catch (e) { bLog.error(`Owner TP algo failed: ${e.message}`); }

  if (!slOk || !tpOk) {
    const missing = [!slOk ? 'SL' : '', !tpOk ? 'TP' : ''].filter(Boolean).join('+');
    bLog.error(`Owner ${sym} missing ${missing} — set manually!`);
    await notify(`*${sym} ${direction}* opened without *${missing}*! Set manually NOW.`);
  }

  tradeState.set(sym, {
    entry: price, tp1, tp2, tp3, sl: initialSlPrice, qty, isLong,
    tpHit1: false, tpHit2: false,
    pricePrec, qtyPrec,
    setup: pick.setup,
    openedAt: Date.now(),
    tf15m: pick.structure?.tf15 || null,
    tf3m: pick.structure?.tf3 || null,
    tf1m: pick.structure?.tf1 || null,
    trailingSlPrice: initialSlPrice,
    trailingSlLastStep: 0,
  });

  return {
    sym, qty, entry: price, leverage, tp1, tp2, tp3, sl: initialSlPrice,
    slDist, confidence: pick.score, direction,
    orderId: order.orderId, setup: pick.setup,
  };
}

// ── CHECK TRAILING SL + MULTI-TP + EXIT + AI LEARNING ────────
async function checkTrailingStop(client) {
  try {
    const account = await client.getAccountInformation({ omitZeroBalances: false });
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    // Clean up state for closed positions + record to AI
    for (const sym of tradeState.keys()) {
      if (!positions.find(p => p.symbol === sym)) {
        const state = tradeState.get(sym);
        if (state) {
          let exitPrice = state.entry;
          try {
            const trades = await client.getAccountTradeList({ symbol: sym, limit: 5 });
            if (trades && trades.length > 0) {
              const lastTrade = trades[trades.length - 1];
              exitPrice = parseFloat(lastTrade.price);
            }
          } catch {
            const ticker = await client.getSymbolPriceTicker({ symbol: sym }).catch(() => null);
            exitPrice = ticker ? parseFloat(ticker.price) : state.entry;
          }
          const pnlPct = state.isLong
            ? (exitPrice - state.entry) / state.entry * 100
            : (state.entry - exitPrice) / state.entry * 100;
          const durationMin = Math.round((Date.now() - state.openedAt) / 60000);

          const winLoss = pnlPct > 0 ? 'WIN' : 'LOSS';
          bLog.trade(`CLOSED: ${sym} ${state.isLong ? 'LONG' : 'SHORT'} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${winLoss}) | duration: ${durationMin}min | entry=$${fmtPrice(state.entry)} exit=$${fmtPrice(exitPrice)}`);
          bLog.ai(`Recording trade to AI learner: ${sym} setup=${state.setup} ${winLoss} ${pnlPct.toFixed(2)}%`);

          await aiLearner.recordTrade({
            symbol: sym,
            direction: state.isLong ? 'LONG' : 'SHORT',
            setup: state.setup || 'unknown',
            entryPrice: state.entry,
            exitPrice,
            pnlPct,
            leverage: getLeverage(sym, state.entry, await aiLearner.getOptimalParams()),
            durationMin,
            session: aiLearner.getCurrentSession(),
            slDistancePct: Math.abs(state.entry - state.sl) / state.entry * 100,
            tpDistancePct: Math.abs(state.tp1 - state.entry) / state.entry * 100,
            tf15m: state.tf15m || null,
            tf3m: state.tf3m || null,
            tf1m: state.tf1m || null,
            exitReason: 'position_closed',
          });

          recordDailyTrade(pnlPct > 0);
          log(`AI recorded: ${sym} PnL=${pnlPct.toFixed(2)}% duration=${durationMin}min setup=${state.setup}`);

          // Update DB trades table with exit_price
          try {
            const db = require('./db');
            const pnlUsdt = parseFloat((pnlPct * state.qty * state.entry / 100).toFixed(4));
            await db.query(
              `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3,
               trailing_sl_price = $4, trailing_sl_last_step = $5,
               closed_at = NOW()
               WHERE symbol = $6 AND status = 'OPEN'`,
              [winLoss, pnlUsdt, exitPrice,
               state.trailingSlPrice || null, state.trailingSlLastStep || 0,
               sym]
            );
            bLog.trade(`DB updated: ${sym} -> ${winLoss} exit=$${fmtPrice(exitPrice)}`);

            // Record profit split if winning
            if (pnlUsdt > 0) {
              // Find the trade to get user_id and api_key_id
              const tradeRow = await db.query(
                `SELECT user_id, api_key_id FROM trades WHERE symbol = $1 AND status = $2 ORDER BY closed_at DESC LIMIT 1`,
                [sym, winLoss]
              );
              if (tradeRow.length > 0) {
                await recordProfitSplit(db, tradeRow[0].user_id, tradeRow[0].api_key_id, pnlUsdt, sym);
              }
            }
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

      // 15m structure break exit check
      const earlyExitParams = await aiLearner.getOptimalParams();
      const earlyExitEnabled = earlyExitParams.EARLY_EXIT_ENABLED !== false;
      try {
        const klines15 = await client.getKlines({ symbol: sym, interval: '15m', limit: 50 });
        if (earlyExitEnabled && shouldExit15m(klines15, entry, isLong ? 'LONG' : 'SHORT')) {
          log(`Exit [${isLong ? 'LONG' : 'SHORT'}] ${sym}: 15m structure break`);
          try { await client.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
          try { await client.cancelAllAlgoOpenOrders({ symbol: sym }); } catch (_) {}
          await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true' });

          try {
            const db = require('./db');
            const pnlUsdt = parseFloat((gain * Math.abs(amt) * entry).toFixed(4));
            await db.query(
              `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3, closed_at = NOW()
               WHERE symbol = $4 AND status = 'OPEN'`,
              [gain > 0 ? 'WIN' : 'LOSS', pnlUsdt, cur, sym]
            );

            if (pnlUsdt > 0) {
              const tradeRow = await db.query(
                `SELECT user_id, api_key_id FROM trades WHERE symbol = $1 AND exit_price = $2 ORDER BY closed_at DESC LIMIT 1`,
                [sym, cur]
              );
              if (tradeRow.length > 0) {
                await recordProfitSplit(db, tradeRow[0].user_id, tradeRow[0].api_key_id, pnlUsdt, sym);
              }
            }
          } catch (_) {}

          const st = tradeState.get(sym);
          if (st) {
            await aiLearner.recordTrade({
              symbol: sym, direction: isLong ? 'LONG' : 'SHORT',
              setup: st.setup || 'unknown', entryPrice: entry, exitPrice: cur,
              pnlPct: gain * 100, leverage: getLeverage(sym, entry, await aiLearner.getOptimalParams()),
              durationMin: Math.round((Date.now() - st.openedAt) / 60000),
              session: aiLearner.getCurrentSession(),
              slDistancePct: Math.abs(entry - st.sl) / entry * 100,
              tpDistancePct: Math.abs(st.tp1 - entry) / entry * 100,
              tf15m: st.tf15m || null, tf3m: st.tf3m || null, tf1m: st.tf1m || null,
              exitReason: 'structure_break_15m',
            });
            recordDailyTrade(gain > 0);
            tradeState.delete(sym);
          }

          await notify(
            `*Exit: 15m Structure Break*\n` +
            `*${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `Entry: \`$${fmtPrice(entry)}\` Exit: \`$${fmtPrice(cur)}\`\n` +
            `PnL: *${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(2)}%*`
          );
          continue;
        }
      } catch (_) {}

      const state = tradeState.get(sym);
      if (!state) continue;

      // ── Trailing SL step check ──
      const trailResult = calculateTrailingStep(
        state.entry, cur, state.isLong,
        state.trailingSlLastStep || 0
      );

      if (trailResult) {
        const { newSlPrice, newLastStep } = trailResult;
        try {
          const stepped = await updateStopLoss(client, sym, newSlPrice, closeSide, 'binance', state.pricePrec);
          if (stepped) {
            const oldStep = state.trailingSlLastStep || 0;
            state.trailingSlPrice = newSlPrice;
            state.trailingSlLastStep = newLastStep;
            state.sl = parseFloat(newSlPrice.toFixed(state.pricePrec));
            bLog.trade(`Trailing SL stepped: ${sym} ${(oldStep*100).toFixed(1)}% -> ${(newLastStep*100).toFixed(1)}% | SL=$${fmtPrice(newSlPrice)}`);
            log(`Trailing SL: ${sym} stepped to ${(newLastStep*100).toFixed(1)}% profit lock, SL=$${fmtPrice(newSlPrice)}`);

            // Update DB
            try {
              const db = require('./db');
              await db.query(
                `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2
                 WHERE symbol = $3 AND status = 'OPEN'`,
                [newSlPrice, newLastStep, sym]
              );
            } catch (_) {}

            await notify(
              `*Trailing SL Stepped*\n` +
              `*${sym}* ${state.isLong ? 'LONG' : 'SHORT'}\n` +
              `Profit: *+${(newLastStep*100).toFixed(1)}%*\n` +
              `SL locked at: \`$${fmtPrice(newSlPrice)}\``
            );
          }
        } catch (e) {
          bLog.error(`Trailing SL update failed for ${sym}: ${e.message}`);
        }
      }

      const fmtP = (p) => parseFloat(p.toFixed(state.pricePrec));
      const floorQ = (q) => Math.floor(q * Math.pow(10, state.qtyPrec)) / Math.pow(10, state.qtyPrec);
      const origQty = Math.abs(state.qty);

      // TP1 hit: close 50%, SL -> break even
      if (!state.tpHit1) {
        const tp1Hit = isLong ? cur >= state.tp1 : cur <= state.tp1;
        if (tp1Hit) {
          state.tpHit1 = true;
          const closeQty = floorQ(origQty * 0.5);
          const newSl = fmtP(state.entry);
          log(`TP1 hit ${sym} @ $${fmtPrice(cur)}: closing 50%, SL -> BE`);
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
            `SL -> break even | TP2: \`$${fmtPrice(state.tp2)}\``
          );
          continue;
        }
      }

      // TP2 hit: close 25%, SL -> TP1
      if (state.tpHit1 && !state.tpHit2) {
        const tp2Hit = isLong ? cur >= state.tp2 : cur <= state.tp2;
        if (tp2Hit) {
          state.tpHit2 = true;
          const closeQty = floorQ(origQty * 0.25);
          const newSl = fmtP(state.tp1);
          log(`TP2 hit ${sym} @ $${fmtPrice(cur)}: closing 25%, SL -> TP1`);
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
            `SL locked at TP1 | Riding 25% -> TP3: \`$${fmtPrice(state.tp3)}\``
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
    const { query: dbQuery, initAllTables } = require('./db');
    await initAllTables();
    const topNRows = await dbQuery('SELECT MAX(top_n_coins) as max_n FROM api_keys WHERE enabled = true');
    const topNCoins = parseInt(topNRows[0]?.max_n) || 50;
    const signals = await scanSMC(log, { topNCoins });

    if (!signals.length) {
      log('No SMC signals found this cycle.');

      if (hasOwnerKeys) {
        const client = getClient();
        await checkTrailingStop(client);
      }
      return;
    }

    let executed = false;
    for (const pick of signals) {
      log(`Signal: ${pick.symbol} ${pick.direction} score=${pick.score} setup=${pick.setupName} AI=${pick.aiModifier}`);
      bLog.trade(`TRYING: ${pick.symbol} ${pick.direction} | setup=${pick.setupName} score=${pick.score} | TP=$${fmtPrice(pick.tp1)} SL=$${fmtPrice(pick.sl)} | RR=1:1.5`);

      // Check global token ban
      if (await isTokenBanned(pick.symbol || pick.sym)) {
        bLog.trade(`${pick.symbol} is globally banned — skipping`);
        continue;
      }

      bLog.trade(`Executing trade: ${pick.symbol} ${pick.direction} for registered users...`);
      const result = await executeForAllUsers(pick);

      if (result === 'ALL_TOO_EXPENSIVE') {
        bLog.trade(`${pick.symbol} too expensive for all users — trying next signal...`);
        continue;
      }
      executed = true;
      break;
    }
    const pick = signals[0];

    // Owner's Binance account
    if (hasOwnerKeys) {
      bLog.trade(`Executing trade on owner Binance account...`);
      try {
        const client = getClient();
        const account = await client.getAccountInformation({ omitZeroBalances: false });
        const rawWallet = parseFloat(account.totalWalletBalance);
        const avail = parseFloat(account.availableBalance);
        const wallet = getDailyCapital('owner-binance', rawWallet);
        bLog.trade(`Owner wallet: $${rawWallet.toFixed(2)} (daily capital: $${wallet.toFixed(2)}) available: $${avail.toFixed(2)}`);

        await checkTrailingStop(client);

        if (avail >= CONFIG.MIN_BALANCE) {
          const openPos = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);
          if (openPos.length === 0) {
            bLog.trade(`No open positions — opening trade on ${pick.symbol}...`);
            const result = await openTrade(client, pick, wallet);
            if (result && result !== 'TOO_EXPENSIVE') {
              const dirEmoji = result.direction !== 'SHORT' ? '🟢' : '🔴';
              bLog.trade(`TRADE OPENED: ${result.sym} ${result.direction} x${result.leverage} qty=${result.qty} entry=$${fmtPrice(result.entry)}`);
              await notify(
                `*AI Trade — ${now()}*\n` +
                `*${result.sym}* ${dirEmoji} *${result.direction} x${result.leverage}*\n` +
                `Setup: *${result.setup}* (3-TF LH/HL)\n` +
                `Entry: \`$${fmtPrice(result.entry)}\`\n` +
                `TP: \`$${fmtPrice(result.tp1)}\` (RR 1:1.5)\n` +
                `SL: \`$${fmtPrice(result.sl)}\` (trailing -1%)\n` +
                `Qty: \`${result.qty}\` | Wallet: *$${avail.toFixed(2)}*\n` +
                `AI Score: *${pick.score}*`
              );
            } else if (!result) {
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

  // Sync trades and check for USDT top-ups at end of each cycle
  await syncTradeStatus();
  await checkUsdtTopups();

  log('=== Cycle End ===');
}

function getClient() {
  return new USDMClient({ api_key: API_KEY, api_secret: API_SECRET }, getBinanceRequestOptions());
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
      `SELECT ak.*, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true AND (ak.paused_by_admin = false OR ak.paused_by_admin IS NULL)`
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

    // Fire to ALL accounts in parallel so everyone gets the trade at the same time
    const promises = keys.map(key => {
      const userLog = {
        trade:     (msg, data) => bLog.trade(msg, data, key.user_id),
        scan:      (msg, data) => bLog.scan(msg, data, key.user_id),
        error:     (msg, data) => bLog.error(msg, data, key.user_id),
        system:    (msg, data) => bLog.system(msg, data, key.user_id),
        ai:        (msg, data) => bLog.ai(msg, data, key.user_id),
      };
      return (async () => {
      try {
        const symbol = sym;
        const allowedCoins = (key.allowed_coins || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        const bannedCoins = (key.banned_coins || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

        if (allowedCoins.length > 0 && !allowedCoins.includes(symbol)) {
          userLog.trade(`User ${key.email}: ${symbol} not in allowed list — skipped`);
          return;
        }
        if (bannedCoins.includes(symbol)) {
          userLog.trade(`User ${key.email}: ${symbol} is banned — skipped`);
          return;
        }

        // Check global token ban
        if (await isTokenBanned(symbol)) {
          userLog.trade(`User ${key.email}: ${symbol} is globally banned — skipped`);
          return;
        }

        // Check DB for existing open trade on same symbol
        const existingTrade = await db.query(
          `SELECT id FROM trades WHERE user_id = $1 AND symbol = $2 AND status = 'OPEN' LIMIT 1`,
          [key.user_id, symbol]
        );
        if (existingTrade.length > 0) {
          userLog.trade(`User ${key.email}: already has OPEN trade on ${symbol} in DB — skipping duplicate`);
          return;
        }

        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        const maxPos = parseInt(key.max_positions) || 3;

        const price = pick.lastPrice || pick.price || pick.entry;
        const isLong = pick.direction !== 'SHORT';
        const aiParams = await aiLearner.getOptimalParams();

        // Per-user settings: use user_token_leverage first, then key default
        const userLev = await getTokenLeverage(symbol, key.id);
        const walletSizePct = (await getCapitalPercentage(key.id)) / 100;
        const userTP = parseFloat(key.tp_pct) || 0.01;
        const userSL = parseFloat(key.sl_pct) || 0.01;
        const userMaxConsecLoss = parseInt(key.max_consec_loss) || 2;

        // Check consecutive losses
        const nowDate = new Date();
        const h = nowDate.getHours();
        const dayStart = new Date(nowDate);
        if (h < 7) dayStart.setDate(dayStart.getDate() - 1);
        dayStart.setHours(7, 0, 0, 0);

        const recentTrades = await db.query(
          `SELECT status FROM trades
           WHERE user_id = $1 AND status IN ('WIN','LOSS')
             AND closed_at >= $2
           ORDER BY closed_at DESC LIMIT $3`,
          [key.user_id, dayStart, userMaxConsecLoss]
        );
        const allLosses = recentTrades.length >= userMaxConsecLoss &&
          recentTrades.every(t => t.status === 'LOSS');
        if (allLosses) {
          userLog.trade(`User ${key.email}: ${userMaxConsecLoss} consecutive losses today — cooling down (resets 7am)`);
          return;
        }

        // Initial trailing SL at -1% from entry
        const initialSlPrice = isLong ? price * (1 - TRAILING_SL.INITIAL_SL_PCT) : price * (1 + TRAILING_SL.INITIAL_SL_PCT);
        const userTpPrice = isLong ? price * (1 + userTP) : price * (1 - userTP);
        const userTp3Price = isLong ? price * (1 + userTP * 1.5) : price * (1 - userTP * 1.5);

        let account, wallet, openPosCount;

        if (key.platform === 'binance') {
          const userClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
          account = await userClient.getAccountInformation({ omitZeroBalances: false });
          const rawWallet = parseFloat(account.totalWalletBalance);
          wallet = getDailyCapital(`user-${key.email}-binance`, rawWallet);
          const openPositions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);
          openPosCount = openPositions.length;

          if (openPosCount >= maxPos) { userLog.trade(`User ${key.email}: at max positions (${openPosCount}/${maxPos})`); return; }
          if (rawWallet < CONFIG.MIN_BALANCE) { userLog.trade(`User ${key.email}: wallet too low ($${rawWallet.toFixed(2)})`); return; }

          const existingPos = openPositions.find(p => p.symbol === symbol);
          if (existingPos) {
            userLog.trade(`User ${key.email}: already in ${symbol} position — skipping duplicate`);
            return;
          }

          userLog.trade(`User ${key.email} Binance: wallet=$${rawWallet.toFixed(2)} available=$${parseFloat(account.availableBalance).toFixed(2)} pos=${openPosCount}/${maxPos} lev=x${userLev} TP=${(userTP*100).toFixed(1)}% SL=trailing`);

          const slPrice = initialSlPrice;
          const tp3Price = userTp3Price;

          try { await userClient.setLeverage({ symbol, leverage: userLev }); } catch (_) {}
          try { await userClient.setMarginType({ symbol, marginType: 'ISOLATED' }); } catch (e) { if (!e.message?.includes('No need')) throw e; }

          const info = await userClient.getExchangeInfo();
          const sinfo = info.symbols.find(s => s.symbol === symbol);
          if (!sinfo) { userLog.error(`User ${key.email}: ${symbol} not found on Binance`); return; }
          const qtyPrec = sinfo.quantityPrecision ?? 6;
          const pricePrec = sinfo.pricePrecision ?? 2;
          const fmtP = (p) => parseFloat(p.toFixed(pricePrec));

          // Position sizing: walletSizePct of wallet = margin
          const tradeUsdt = wallet * walletSizePct;
          const notionalUsdt = tradeUsdt * userLev;
          let qty = notionalUsdt / price;

          const minQty = 1 / Math.pow(10, qtyPrec);
          const minNotionalQty = Math.ceil(5.5 / price * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
          qty = Math.floor(qty * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

          if (qty < minNotionalQty) qty = minNotionalQty;
          if (qty < minQty) qty = minQty;

          const requiredMargin = (qty * price) / userLev;
          if (requiredMargin > wallet * 0.95) {
            userLog.trade(`User ${key.email}: ${symbol} needs $${requiredMargin.toFixed(2)} margin but only $${wallet.toFixed(2)} available — too expensive`);
            return 'TOO_EXPENSIVE';
          }

          userLog.trade(`User ${key.email}: placing MARKET ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty}...`);
          await userClient.submitNewOrder({ symbol, side: isLong ? 'BUY' : 'SELL', type: 'MARKET', quantity: qty });

          await sleep(1500);

          const closeSide = isLong ? 'SELL' : 'BUY';
          const slFmt = fmtP(slPrice);
          const tpFmt = fmtP(tp3Price);
          userLog.trade(`Setting trailing SL=$${slFmt} TP=$${tpFmt} for ${symbol}...`);

          let slOk = false, tpOk = false;

          try {
            await userClient.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol, side: closeSide,
              type: 'STOP_MARKET', triggerPrice: slFmt,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            slOk = true;
            userLog.trade(`SL set at $${slFmt} (-1% trailing)`);
          } catch (e) {
            userLog.error(`SL algo failed for ${symbol}: ${e.message}`);
          }

          try {
            await userClient.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol, side: closeSide,
              type: 'TAKE_PROFIT_MARKET', triggerPrice: tpFmt,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            tpOk = true;
            userLog.trade(`TP set at $${tpFmt}`);
          } catch (e) {
            userLog.error(`TP algo failed for ${symbol}: ${e.message}`);
          }

          if (!slOk || !tpOk) {
            const missing = [!slOk ? 'SL' : '', !tpOk ? 'TP' : ''].filter(Boolean).join(' and ');
            userLog.error(`${symbol} OPEN without ${missing} — SET MANUALLY!`);
            await notify(`*${symbol} ${pick.direction}*\nPosition opened but *${missing} failed to set!*\nSet manually on Binance NOW.`);
          }

          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
             trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13)`,
            [key.id, key.user_id, symbol, pick.direction, price, fmtP(slPrice), fmtP(tp3Price), qty, userLev,
             fmtP(slPrice),
             pick.structure?.tf15 || null, pick.structure?.tf3 || null, pick.structure?.tf1 || null]
          );
          userLog.trade(`Binance OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty} entry=$${fmtPrice(price)} SL=trailing`);
          log(`Binance OK: ${key.email} ${symbol} ${pick.direction} x${userLev}`);

        } else if (key.platform === 'bitunix') {
          const userClient = new BitunixClient({ apiKey, apiSecret });
          account = await userClient.getAccountInformation();
          const rawWalletBx = parseFloat(account.totalWalletBalance);
          wallet = getDailyCapital(`user-${key.email}-bitunix`, rawWalletBx);
          const bxPositions = account.positions || [];
          openPosCount = bxPositions.length;

          if (openPosCount >= maxPos) { userLog.trade(`User ${key.email}: at max positions (${openPosCount}/${maxPos})`); return; }
          if (rawWalletBx < CONFIG.MIN_BALANCE) { userLog.trade(`User ${key.email}: wallet too low ($${rawWalletBx.toFixed(2)})`); return; }

          const existingPosBx = bxPositions.find(p => p.symbol === symbol);
          if (existingPosBx) {
            userLog.trade(`User ${key.email}: already in ${symbol} position — skipping duplicate`);
            return;
          }

          userLog.trade(`User ${key.email} Bitunix: wallet=$${wallet.toFixed(2)} pos=${openPosCount}/${maxPos} lev=x${userLev}`);

          const tradeUsdtBx = wallet * walletSizePct;
          const notionalUsdtBx = tradeUsdtBx * userLev;
          let qty = notionalUsdtBx / price;
          if (qty * price < 5.5) qty = 5.5 / price;
          qty = parseFloat(qty.toFixed(6));
          if (qty <= 0) qty = parseFloat((5.5 / price).toFixed(6));

          const requiredMarginBx = (qty * price) / userLev;
          if (requiredMarginBx > wallet * 0.95) {
            userLog.trade(`User ${key.email}: ${symbol} needs $${requiredMarginBx.toFixed(2)} margin but only $${wallet.toFixed(2)} — too expensive`);
            return 'TOO_EXPENSIVE';
          }

          const slPrice = initialSlPrice;
          const tp3Price = userTp3Price;

          try { await userClient.changeMarginMode(symbol, 'ISOLATION'); } catch (_) {}
          try { await userClient.changeLeverage(symbol, userLev); } catch (_) {}

          const slFmtBx = parseFloat(slPrice.toFixed(8));
          const tpFmtBx = parseFloat(tp3Price.toFixed(8));

          userLog.trade(`User ${key.email}: placing Bitunix MARKET ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty} SL=$${slFmtBx} TP=$${tpFmtBx}...`);
          const order = await userClient.placeOrder({
            symbol, side: isLong ? 'BUY' : 'SELL',
            qty: String(qty), orderType: 'MARKET', tradeSide: 'OPEN',
          });
          userLog.trade(`Bitunix order placed: ${JSON.stringify(order)}`);

          await sleep(2000);
          const positions = await userClient.getOpenPositions(symbol);
          const pos = Array.isArray(positions) ? positions.find(p => p.symbol === symbol) : null;
          userLog.trade(`Bitunix position lookup: ${JSON.stringify(pos ? { id: pos.positionId, symbol: pos.symbol, side: pos.side, qty: pos.qty } : null)}`);

          if (pos && pos.positionId) {
            userLog.trade(`Bitunix position confirmed: ${pos.positionId} — setting TP/SL...`);
            try {
              await userClient.placePositionTpSl({
                symbol, positionId: pos.positionId,
                tpPrice: tpFmtBx, slPrice: slFmtBx,
              });
              userLog.trade(`Bitunix TP=$${tpFmtBx} SL=$${slFmtBx} set on position ${pos.positionId}`);
            } catch (e) {
              userLog.error(`Bitunix TP/SL FAILED: ${e.message} — SET MANUALLY`);
              await notify(`*Bitunix ${symbol} ${pick.direction}*\nTP/SL failed! Set manually on Bitunix NOW.`);
            }
          } else {
            userLog.error(`Bitunix position not found after order — verify on exchange`);
            await notify(`*Bitunix ${symbol}*\nOrder placed but position not found. Check Bitunix manually.`);
          }

          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
             trailing_sl_price, trailing_sl_last_step)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0)`,
            [key.id, key.user_id, symbol, pick.direction, price, parseFloat(slPrice.toFixed(8)), parseFloat(tp3Price.toFixed(8)), qty, userLev,
             parseFloat(slPrice.toFixed(8))]
          );
          userLog.trade(`Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty}`);
          log(`Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev}`);
        } else {
          userLog.error(`User ${key.email}: unknown platform "${key.platform}"`);
        }
      } catch (err) {
        userLog.error(`User ${key.email} trade error: ${err.message}`);
        log(`User ${key.email} trade error: ${err.message}`);
      }
    })().catch(e => {
        userLog.error(`User trade execution failed: ${e.message}`);
        return 'ERROR';
      });
    });

    const settled = await Promise.allSettled(promises);
    const results = settled.map(s => s.status === 'fulfilled' ? s.value : 'ERROR');
    const tooExpensive = results.filter(r => r === 'TOO_EXPENSIVE').length;
    const ok = results.length - tooExpensive;
    bLog.trade(`Multi-user execution done: ${ok} traded, ${tooExpensive} too expensive`);
    log(`Multi-user done: ${ok} ok, ${tooExpensive} too expensive`);

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

        let openSymbols = new Map();

        if (key.platform === 'binance') {
          const userClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
          const account = await userClient.getAccountInformation({ omitZeroBalances: false });
          for (const p of account.positions) {
            if (parseFloat(p.positionAmt) !== 0) {
              openSymbols.set(p.symbol, {
                amt: parseFloat(p.positionAmt),
                pnl: parseFloat(p.unrealizedProfit || 0),
                entryPrice: parseFloat(p.entryPrice || 0),
              });
            }
          }

          // Check trailing SL for open positions
          for (const trade of trades) {
            const exchangePos = openSymbols.get(trade.symbol);
            if (exchangePos && trade.trailing_sl_last_step !== undefined) {
              const entryPrice = parseFloat(trade.entry_price);
              const isLong = trade.direction !== 'SHORT';
              const curPrice = entryPrice + (exchangePos.pnl / Math.abs(exchangePos.amt || 1));
              const lastStep = parseFloat(trade.trailing_sl_last_step) || 0;

              const trailResult = calculateTrailingStep(entryPrice, curPrice, isLong, lastStep);
              if (trailResult) {
                const closeSide = isLong ? 'SELL' : 'BUY';
                try {
                  const stepped = await updateStopLoss(userClient, trade.symbol, trailResult.newSlPrice, closeSide, 'binance', 2);
                  if (stepped) {
                    await db.query(
                      `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2
                       WHERE id = $3`,
                      [trailResult.newSlPrice, trailResult.newLastStep, trade.id]
                    );
                    bLog.trade(`Sync trailing SL: ${trade.symbol} stepped to ${(trailResult.newLastStep*100).toFixed(1)}% SL=$${fmtPrice(trailResult.newSlPrice)}`);
                  }
                } catch (e) {
                  bLog.error(`Sync trailing SL error for ${trade.symbol}: ${e.message}`);
                }
              }
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

          // Check trailing SL for Bitunix positions
          for (const trade of trades) {
            const exchangePos = openSymbols.get(trade.symbol);
            if (exchangePos && trade.trailing_sl_last_step !== undefined) {
              const entryPrice = parseFloat(trade.entry_price);
              const isLong = trade.direction !== 'SHORT';
              const curPrice = entryPrice + (exchangePos.pnl / Math.abs(exchangePos.amt || 1));
              const lastStep = parseFloat(trade.trailing_sl_last_step) || 0;

              const trailResult = calculateTrailingStep(entryPrice, curPrice, isLong, lastStep);
              if (trailResult) {
                try {
                  const stepped = await updateStopLoss(userClient, trade.symbol, trailResult.newSlPrice, null, 'bitunix', 8);
                  if (stepped) {
                    await db.query(
                      `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2
                       WHERE id = $3`,
                      [trailResult.newSlPrice, trailResult.newLastStep, trade.id]
                    );
                    bLog.trade(`Sync trailing SL (Bitunix): ${trade.symbol} stepped to ${(trailResult.newLastStep*100).toFixed(1)}%`);
                  }
                } catch (e) {
                  bLog.error(`Sync trailing SL error (Bitunix) for ${trade.symbol}: ${e.message}`);
                }
              }
            }
          }
        }

        bLog.system(`Sync: exchange has ${openSymbols.size} open positions, DB has ${trades.length} OPEN trades`);

        for (const trade of trades) {
          const exchangePos = openSymbols.get(trade.symbol);

          if (!exchangePos) {
            // Position closed on exchange — find the exit price
            const entryPrice = parseFloat(trade.entry_price);
            const qty = parseFloat(trade.quantity || 0);
            const isLong = trade.direction !== 'SHORT';
            let exitPrice = entryPrice;
            let realizedPnl = null;

            if (key.platform === 'binance') {
              try {
                const binClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
                // Get fills after the trade was opened
                const openTime = trade.created_at ? new Date(trade.created_at).getTime() : Date.now() - 86400000;
                const fills = await binClient.getAccountTradeList({ symbol: trade.symbol, startTime: openTime, limit: 50 });
                if (fills && fills.length > 0) {
                  // Find the close fills (opposite side of entry)
                  const closeSide = isLong ? 'SELL' : 'BUY';
                  const closeFills = fills.filter(f => f.side === closeSide && f.positionSide !== 'BOTH' || f.side === closeSide);
                  if (closeFills.length > 0) {
                    // Weight-averaged exit price from close fills
                    let totalQty = 0, totalValue = 0, totalPnl = 0;
                    for (const f of closeFills) {
                      const fQty = parseFloat(f.qty);
                      totalQty += fQty;
                      totalValue += fQty * parseFloat(f.price);
                      totalPnl += parseFloat(f.realizedPnl || 0);
                    }
                    if (totalQty > 0) exitPrice = totalValue / totalQty;
                    if (totalPnl !== 0) realizedPnl = totalPnl;
                  } else if (fills.length > 0) {
                    exitPrice = parseFloat(fills[fills.length - 1].price);
                  }
                }
              } catch {
                try {
                  const ticker = await new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions())
                    .getSymbolPriceTicker({ symbol: trade.symbol });
                  exitPrice = parseFloat(ticker.price);
                } catch { /* keep entryPrice */ }
              }
            } else if (key.platform === 'bitunix') {
              const bxClient = new BitunixClient({ apiKey, apiSecret });
              let found = false;

              // Method 1: Position history — has entryPrice, closePrice, realizedPNL
              try {
                const positions = await bxClient.getHistoryPositions({ symbol: trade.symbol, pageSize: 20 });
                for (const p of positions) {
                  const cp = parseFloat(p.closePrice || 0);
                  if (cp > 0 && p.symbol === trade.symbol) {
                    exitPrice = cp;
                    if (p.realizedPNL != null) realizedPnl = parseFloat(p.realizedPNL);
                    found = true;
                    break;
                  }
                }
              } catch (e) { bLog.error(`Bitunix posHistory error: ${e.message}`); }

              // Method 2: Order history — look for reduceOnly/CLOSE order with avgPrice
              if (!found) {
                try {
                  const orderList = await bxClient.getHistoryOrders({ symbol: trade.symbol, pageSize: 20 });
                  for (const o of orderList) {
                    const oPrice = parseFloat(o.avgPrice || 0);
                    if (o.reduceOnly && oPrice > 0) {
                      exitPrice = oPrice;
                      if (o.realizedPNL != null) realizedPnl = parseFloat(o.realizedPNL);
                      found = true;
                      break;
                    }
                  }
                } catch (e) { bLog.error(`Bitunix histOrders error: ${e.message}`); }
              }

              // Method 3: Current market price as last resort
              if (!found) {
                try {
                  const priceData = await bxClient.getMarketPrice(trade.symbol);
                  const mp = parseFloat(priceData?.lastPrice || priceData?.price || priceData || 0);
                  if (mp > 0) exitPrice = mp;
                } catch (e) { bLog.error(`Bitunix marketPrice error: ${e.message}`); }
              }
            }

            // Calculate PnL: use exchange realized PnL if available, otherwise compute
            let pnlUsdt;
            if (realizedPnl !== null) {
              pnlUsdt = parseFloat(realizedPnl.toFixed(4));
            } else {
              // PnL = (exit - entry) * qty for LONG, (entry - exit) * qty for SHORT
              pnlUsdt = isLong
                ? parseFloat(((exitPrice - entryPrice) * qty).toFixed(4))
                : parseFloat(((entryPrice - exitPrice) * qty).toFixed(4));
            }
            const status = pnlUsdt > 0 ? 'WIN' : 'LOSS';

            await db.query(
              `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3, closed_at = NOW()
               WHERE id = $4`,
              [status, pnlUsdt, exitPrice, trade.id]
            );
            bLog.trade(`DB synced: ${trade.symbol} -> ${status} PnL=$${pnlUsdt} exit=$${fmtPrice(exitPrice)}`);

            // Record profit split for winning trades
            if (pnlUsdt > 0) {
              await recordProfitSplit(db, trade.user_id, trade.api_key_id, pnlUsdt, trade.symbol);
            }
          } else {
            // Still open — update live PnL
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

// ── Auto-detect USDT top-ups via BSCScan API ─────────────────
const USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
let lastTopupBlock = 0;

async function checkUsdtTopups() {
  let db;
  try { db = require('./db'); } catch { return; }

  try {
    const settings = {};
    const rows = await db.query('SELECT key, value FROM settings');
    for (const r of rows) settings[r.key] = r.value;

    const platformAddr = settings.platform_usdt_address;
    const apiKey = settings.bscscan_api_key;
    if (!platformAddr || !apiKey) return;

    const startBlock = lastTopupBlock || 0;
    const url = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${USDT_BEP20_CONTRACT}&address=${platformAddr}&startblock=${startBlock}&endblock=99999999&sort=asc&apikey=${apiKey}`;

    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== '1' || !Array.isArray(data.result)) return;

    for (const tx of data.result) {
      if (tx.to.toLowerCase() !== platformAddr.toLowerCase()) continue;

      const blockNum = parseInt(tx.blockNumber);
      if (blockNum > lastTopupBlock) lastTopupBlock = blockNum;

      // Check if already processed
      const existing = await db.query(
        "SELECT id FROM wallet_transactions WHERE tx_hash = $1 AND type IN ('topup', 'topup_pending')",
        [tx.hash]
      );
      if (existing.length > 0) continue;

      const decimals = parseInt(tx.tokenDecimal) || 18;
      const amount = parseFloat(tx.value) / Math.pow(10, decimals);
      if (amount < 1) continue;

      // Try to match sender to a user by their USDT address
      const userMatch = await db.query(
        'SELECT id, email FROM users WHERE LOWER(usdt_address) = LOWER($1)',
        [tx.from]
      );

      if (userMatch.length > 0) {
        const userId = userMatch[0].id;
        await db.query(
          'UPDATE users SET cash_wallet = cash_wallet + $1 WHERE id = $2',
          [amount, userId]
        );
        await db.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, description, tx_hash, status)
           VALUES ($1, 'topup', $2, $3, $4, 'completed')`,
          [userId, amount, `Auto-detected USDT top-up from ${tx.from.slice(0, 10)}...`, tx.hash]
        );
        bLog.system(`Auto top-up: $${amount.toFixed(2)} credited to ${userMatch[0].email} (tx: ${tx.hash.slice(0, 12)}...)`);
      } else {
        // Log as pending — admin can manually assign
        await db.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, description, tx_hash, status)
           VALUES (1, 'topup_pending', $1, $2, $3, 'pending')`,
          [amount, `Unmatched USDT transfer from ${tx.from} — assign manually`, tx.hash]
        );
        bLog.system(`Unmatched top-up: $${amount.toFixed(2)} from ${tx.from.slice(0, 10)}... (tx: ${tx.hash.slice(0, 12)}...)`);
      }
    }
  } catch (e) {
    bLog.error(`checkUsdtTopups error: ${e.message}`);
  }
}

async function run() {
  log(`AI Smart Trader v4 | Telegram: ${!!TELEGRAM_TOKEN} | Chats: ${PRIVATE_CHATS.join(', ') || 'NONE'}`);
  await syncTradeStatus();
  await checkUsdtTopups();
  await main();
}

module.exports = { run };
