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
// Tokens priced $100+ need 100x leverage — small % moves matter more
const HIGH_PRICE_SYMBOLS = new Set([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'AAVEUSDT',
  'MKRUSDT', 'BCHUSDT', 'LTCUSDT', 'AVAXUSDT', 'LINKUSDT',
]);

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

// ── Circuit Breaker: pause after consecutive losses ────────
const CIRCUIT_BREAKER = { MAX_CONSECUTIVE_LOSSES: 3, COOLDOWN_MS: 30 * 60 * 1000 }; // 30 min pause
let consecutiveLosses = 0;
let circuitBreakerUntil = 0;

// ── Trailing SL config ─────────────────────────────────────
// All values are PRICE % (not capital %).
// Initial SL: 1% price distance from entry (at 20x = 20% capital risk).
// Trailing: at +1% profit → SL locks at +0.5%, every +1% adds another +0.5% to SL.
// Example: +1%→SL+0.5%, +2%→SL+1%, +3%→SL+1.5%, +4%→SL+2%, ...
// Trailing SL config: capital-based (10% of capital = trigger)
// These are CAPITAL percentages — divided by leverage to get price %
const TRAILING_SL_CAPITAL = {
  INITIAL_SL_CAPITAL: 0.10,    // Risk 10% of margin on initial SL
  FIRST_TRIGGER_CAPITAL: 0.10, // First trail at +10% capital profit
  FIRST_SL_CAPITAL: 0.05,     // Lock SL at +5% capital profit
  STEP_TRIGGER_CAPITAL: 0.10,  // Each step = +10% capital above previous
  STEP_SL_CAPITAL: 0.05,      // Each step locks +5% capital
};

function getTrailingSLConfig(leverage) {
  const c = TRAILING_SL_CAPITAL;
  return {
    INITIAL_SL_PCT: c.INITIAL_SL_CAPITAL / leverage,
    FIRST_TRIGGER: c.FIRST_TRIGGER_CAPITAL / leverage,
    FIRST_SL: c.FIRST_SL_CAPITAL / leverage,
    STEP_TRIGGER: c.STEP_TRIGGER_CAPITAL / leverage,
    STEP_SL: c.STEP_SL_CAPITAL / leverage,
  };
}

// ── Compound: always use current wallet balance ─────────────
function getDailyCapital(key, currentBalance) {
  return currentBalance;
}

// Get token-specific leverage: user per-key → admin global → risk level → 20x default
async function getTokenLeverage(symbol, apiKeyId = null) {
  const MAX_LEVERAGE = 20;
  try {
    const { query } = require('./db');

    // Priority 1: User per-key per-token leverage override
    if (apiKeyId) {
      const userTokenRows = await query(
        'SELECT leverage FROM user_token_leverage WHERE api_key_id = $1 AND symbol = $2',
        [apiKeyId, symbol]
      );
      if (userTokenRows.length > 0) {
        return Math.min(parseInt(userTokenRows[0].leverage), MAX_LEVERAGE);
      }
    }

    // Priority 2: Admin global token leverage
    const tokenRows = await query(
      'SELECT leverage FROM token_leverage WHERE symbol = $1 AND enabled = true',
      [symbol]
    );
    if (tokenRows.length > 0) {
      return Math.min(parseInt(tokenRows[0].leverage), MAX_LEVERAGE);
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
        return Math.min(parseInt(keyRows[0].max_leverage), MAX_LEVERAGE);
      }
    }

    return MAX_LEVERAGE;
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

// Check if a token is allowed by admin (must be in approved list)
async function isTokenBanned(symbol) {
  try {
    const { query } = require('./db');
    // Explicitly banned
    const banned = await query(
      'SELECT banned FROM global_token_settings WHERE symbol = $1 AND banned = true',
      [symbol]
    );
    if (banned.length > 0) return true;

    // Must be in approved list — if approved tokens exist, only those can trade
    const allowed = await query(
      'SELECT symbol FROM global_token_settings WHERE enabled = true AND banned = false'
    );
    if (allowed.length > 0) {
      return !allowed.some(r => r.symbol === symbol);
    }

    return false;
  } catch {
    return false;
  }
}

// AI-tuned leverage — params come from getOptimalParams()
function getLeverage(symbol, price, params = {}) {
  // Tokens priced $100+ use 100x — small % moves need higher leverage to hit TP
  if (HIGH_PRICE_SYMBOLS.has(symbol) || price >= 100) {
    return params.LEV_BTC_ETH || 100;
  }
  // Mid-price tokens ($10-99) use 50x
  if (price >= 10) {
    return params.LEV_MID || 50;
  }
  // Low-price tokens use 20x
  return params.LEV_ALT || 20;
}

// ── UTILS ─────────────────────────────────────────────────────
function now() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
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
async function updateStopLoss(client, symbol, newSlPrice, closeSide, platform, pricePrec, existingTpPrice) {
  const fmtP = (p) => parseFloat(p.toFixed(pricePrec || 2));
  const slFmt = fmtP(newSlPrice);

  if (platform === 'binance') {
    // Save existing TP orders before cancelling all algo orders
    let existingTpOrders = [];
    try {
      const algoOrders = await client.getAlgoOpenOrders({ symbol });
      existingTpOrders = (algoOrders || []).filter(o => o.type === 'TAKE_PROFIT_MARKET');
    } catch (_) {}

    try { await client.cancelAllAlgoOpenOrders({ symbol }); } catch (_) {}

    // Place new SL
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol, side: closeSide,
      type: 'STOP_MARKET', triggerPrice: slFmt,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });

    // Re-place TP orders that were cancelled
    for (const tp of existingTpOrders) {
      try {
        await client.submitNewAlgoOrder({
          algoType: 'CONDITIONAL', symbol, side: tp.side,
          type: 'TAKE_PROFIT_MARKET', triggerPrice: tp.triggerPrice,
          closePosition: 'true', workingType: 'MARK_PRICE',
        });
      } catch (_) {}
    }

    // Also re-place from existingTpPrice param if provided and no algo TP was found
    if (existingTpPrice && existingTpOrders.length === 0) {
      try {
        await client.submitNewAlgoOrder({
          algoType: 'CONDITIONAL', symbol, side: closeSide,
          type: 'TAKE_PROFIT_MARKET', triggerPrice: fmtP(existingTpPrice),
          closePosition: 'true', workingType: 'MARK_PRICE',
        });
      } catch (_) {}
    }
    return true;
  } else if (platform === 'bitunix') {
    // NOTE: Bitunix replaces the entire TP/SL config on each call.
    // Must re-send TP alongside SL to avoid wiping it.
    const positions = await client.getOpenPositions(symbol);
    const pos = Array.isArray(positions) ? positions.find(p => p.symbol === symbol) : null;
    if (pos && pos.positionId) {
      const tpslPayload = { symbol, positionId: pos.positionId, slPrice: slFmt };
      if (existingTpPrice) tpslPayload.tpPrice = fmtP(existingTpPrice);
      await client.placePositionTpSl(tpslPayload);
      return true;
    }
    return false;
  }
  return false;
}

// ── TRAILING SL ────────────────────────────────────────────
// At +1% profit → SL locks at +0.5%.
// Every +1% more: +2%→SL+1%, +3%→SL+1.5%, +4%→SL+2%, etc.
// SL only moves up, never down.
function calculateTrailingStep(entryPrice, currentPrice, isLong, lastStep, leverage = 20) {
  const pricePct = isLong
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;

  const { FIRST_TRIGGER, FIRST_SL, STEP_TRIGGER, STEP_SL } = getTrailingSLConfig(leverage);
  let bestSl = null;

  if (pricePct >= FIRST_TRIGGER) {
    // First tier: lock SL at FIRST_SL profit
    bestSl = FIRST_SL;

    // Additional steps
    const stepsAbove = Math.floor((pricePct - FIRST_TRIGGER + 1e-10) / STEP_TRIGGER);
    if (stepsAbove > 0) {
      bestSl = FIRST_SL + stepsAbove * STEP_SL;
    }
  }

  if (bestSl === null) return null;
  if (bestSl <= lastStep) return null; // SL only moves up, never down

  const newSlPrice = isLong
    ? entryPrice * (1 + bestSl)
    : entryPrice * (1 - bestSl);

  return { stepped: true, newSlPrice, newLastStep: bestSl };
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
      `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
       VALUES ($1, 'platform_fee', $2, 'completed', $3)`,
      [userId, platformFee, `${adminPct}% platform fee on ${symbol} profit $${pnlUsdt.toFixed(2)}`]
    );

    // Record user profit share (for tracking only — profit stays on exchange)
    await db.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
       VALUES ($1, 'profit_share', $2, 'completed', $3)`,
      [userId, userShare, `${userPct}% profit share on ${symbol} profit $${pnlUsdt.toFixed(2)}`]
    );

    // NOTE: User's 60% profit stays in their Binance/Bitunix account.
    // Cash wallet is only for top-ups and referral commissions.
    // Platform's 40% fee is collected separately (admin marks paid weekly).

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

  // Initial SL: 10% capital risk, scaled by leverage
  const trailConfig = getTrailingSLConfig(leverage);
  const slPricePct = trailConfig.INITIAL_SL_PCT;
  const initialSlPrice = fmtP(isLong ? price * (1 - slPricePct) : price * (1 + slPricePct));
  const tpPct = Math.abs(tp1 - price) / price;

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

  // Fee check: ensure trailing SL first trigger profit covers fees
  const totalFees = notional * CONFIG.TAKER_FEE * 2;
  const trailProfit = notional * trailConfig.FIRST_TRIGGER;
  const slMarginLoss = slPricePct * leverage * 100;
  bLog.trade(`Size: ${(walletSizePct*100).toFixed(0)}% wallet=$${tradeUsdt.toFixed(2)} notional=$${notional.toFixed(2)} lev=${leverage}x margin=$${requiredMargin.toFixed(2)} | SL=${slMarginLoss.toFixed(0)}%margin | trail trigger=${(trailConfig.FIRST_TRIGGER*100).toFixed(3)}%`);
  log(`Trade: ${sym} ${direction} lev=${leverage}x qty=${qty} notional=$${notional.toFixed(2)} margin=$${requiredMargin.toFixed(2)}`);
  if (trailProfit < totalFees * 1.5) {
    bLog.trade(`Trade rejected: trailing profit $${trailProfit.toFixed(4)} < 1.5x fees $${(totalFees * 1.5).toFixed(4)}`);
    throw new Error(`Trade rejected: trailing profit < 1.5x fees`);
  }

  const entrySide = isLong ? 'BUY' : 'SELL';
  const closeSide = isLong ? 'SELL' : 'BUY';

  // Market entry
  const order = await client.submitNewOrder({ symbol: sym, side: entrySide, type: 'MARKET', quantity: qty });
  await sleep(1500);

  // Set initial SL and TP on exchange
  let slOk = false;
  let tpOk = false;

  try {
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
      type: 'STOP_MARKET', triggerPrice: initialSlPrice,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    slOk = true;
    bLog.trade(`SL set at $${fmtPrice(initialSlPrice)} (-${(slPricePct*100).toFixed(2)}% price = ${(slPricePct*leverage*100).toFixed(0)}% capital)`);
  } catch (e) { bLog.error(`Owner SL algo failed: ${e.message}`); }

  // Place TP order on exchange (take profit at tp1)
  try {
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
      type: 'TAKE_PROFIT_MARKET', triggerPrice: tp1,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    tpOk = true;
    bLog.trade(`TP set at $${fmtPrice(tp1)} (+${(tpPct*100).toFixed(1)}% from entry)`);
  } catch (e) { bLog.error(`Owner TP algo failed: ${e.message}`); }

  if (!slOk) {
    bLog.error(`Owner ${sym} missing SL — set manually!`);
    await notify(`*${sym} ${direction}* opened without *SL*! Set manually NOW.`);
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
    leverage,
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

          // NOTE: User trades are updated by syncTradeStatus() with per-user PnL.
          // Owner account has no rows in the trades table.
          bLog.trade(`Owner position closed: ${sym} -> ${winLoss} exit=$${fmtPrice(exitPrice)}`);
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

          // NOTE: User trades are updated by syncTradeStatus() with per-user PnL.
          // Owner 15m exit only closes the owner's exchange position.

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

      // ── Spike TP: close at 0.5% profit if token spiked ──
      // Detect spike: price moved >1.5% in last 5 minutes (5x 1m candles)
      const priceProfitPct = gain * 100; // gain is already directional
      if (priceProfitPct >= 0.5) {
        try {
          const klines1m = await client.getKlines({ symbol: sym, interval: '1m', limit: 6 });
          if (klines1m && klines1m.length >= 5) {
            const opens = klines1m.map(k => parseFloat(k[1]));
            const highs = klines1m.map(k => parseFloat(k[2]));
            const lows = klines1m.map(k => parseFloat(k[3]));
            const startPrice = opens[0];
            const maxHigh = Math.max(...highs);
            const minLow = Math.min(...lows);
            const spikeUp = (maxHigh - startPrice) / startPrice;
            const spikeDown = (startPrice - minLow) / startPrice;
            const spikeSize = isLong ? spikeUp : spikeDown;

            if (spikeSize >= 0.015) { // 1.5%+ move in 5 minutes = spike
              bLog.trade(`SPIKE TP: ${sym} spiked ${(spikeSize*100).toFixed(2)}% in 5min — closing at +${priceProfitPct.toFixed(2)}% profit`);
              try { await client.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
              try { await client.cancelAllAlgoOpenOrders({ symbol: sym }); } catch (_) {}
              await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true' });

              const st = state;
              await aiLearner.recordTrade({
                symbol: sym, direction: isLong ? 'LONG' : 'SHORT',
                setup: st.setup || 'unknown', entryPrice: entry, exitPrice: cur,
                pnlPct: priceProfitPct, leverage: st.leverage || 20,
                durationMin: Math.round((Date.now() - st.openedAt) / 60000),
                session: aiLearner.getCurrentSession(),
                slDistancePct: Math.abs(entry - st.sl) / entry * 100,
                tpDistancePct: Math.abs(st.tp1 - entry) / entry * 100,
                tf15m: st.tf15m || null, tf3m: st.tf3m || null, tf1m: st.tf1m || null,
                exitReason: 'spike_tp',
              });
              recordDailyTrade(true);
              tradeState.delete(sym);

              await notify(
                `*Spike TP — Quick Profit Locked*\n` +
                `*${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                `Spike: *${(spikeSize*100).toFixed(1)}%* in 5min\n` +
                `Entry: \`$${fmtPrice(entry)}\` Exit: \`$${fmtPrice(cur)}\`\n` +
                `PnL: *+${priceProfitPct.toFixed(2)}%*`
              );
              continue;
            }
          }
        } catch (e) { bLog.error(`Spike TP check failed for ${sym}: ${e.message}`); }
      }

      // ── Trailing SL step check ──
      const trailResult = calculateTrailingStep(
        state.entry, cur, state.isLong,
        state.trailingSlLastStep || 0,
        state.leverage || 20
      );

      if (trailResult) {
        const { newSlPrice, newLastStep } = trailResult;
        let slUpdated = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            slUpdated = await updateStopLoss(client, sym, newSlPrice, closeSide, 'binance', state.pricePrec, state.tp3 || state.tp1);
            if (slUpdated) break;
          } catch (e) {
            bLog.error(`WATCHDOG: Owner SL update failed for ${sym} attempt ${attempt}/3: ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
          }
        }
        if (slUpdated) {
          const oldStep = state.trailingSlLastStep || 0;
          state.trailingSlPrice = newSlPrice;
          state.trailingSlLastStep = newLastStep;
          state.sl = parseFloat(newSlPrice.toFixed(state.pricePrec));
          bLog.trade(`✓ Trailing SL stepped: ${sym} ${(oldStep*100).toFixed(1)}% -> ${(newLastStep*100).toFixed(1)}% | SL=$${fmtPrice(newSlPrice)}`);

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
            `Capital profit: *+${(newLastStep*100).toFixed(1)}%*\n` +
            `SL locked at: \`$${fmtPrice(newSlPrice)}\``
          );
        } else {
          bLog.error(`WATCHDOG ALERT: Owner SL failed 3x for ${sym}!`);
          await notify(`🚨 *TRAILING SL FAILED*\n${sym} owner SL update failed 3 times!\nCheck manually!`);
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

  // Circuit breaker: pause after consecutive losses
  if (Date.now() < circuitBreakerUntil) {
    const remainMin = Math.ceil((circuitBreakerUntil - Date.now()) / 60000);
    log(`Circuit breaker active — ${consecutiveLosses} consecutive losses. Pausing ${remainMin}min. Only checking trailing SL.`);
    // Still check trailing SL on existing positions
    try {
      if (API_KEY && API_SECRET) await checkTrailingStop(getClient());
    } catch (e) { bLog.error(`Trailing check during breaker: ${e.message}`); }
    return;
  }

  log('=== AI Smart Trader v4 Cycle Start ===');
  const hasOwnerKeys = !!(API_KEY && API_SECRET);

  try {
    const { query: dbQuery, initAllTables } = require('./db');
    await initAllTables();
    const topNRows = await dbQuery('SELECT MAX(top_n_coins) as max_n FROM api_keys WHERE enabled = true');
    const topNCoins = parseInt(topNRows[0]?.max_n) || 50;

    // ── Kronos AI Batch Scan: predict ALL top tokens ──────────
    let kronosPredictions = null;
    try {
      const kronos = require('./kronos');
      const fetch = require('node-fetch');

      // Fetch top coins list (same as SMC uses)
      const tickerRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000 });
      const tickers = await tickerRes.json();
      const topSymbols = tickers
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
        .filter(t => parseFloat(t.quoteVolume) >= 10_000_000)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, Math.min(topNCoins, 30))  // Cap at 30 to limit prediction time
        .map(t => t.symbol);

      bLog.ai(`Kronos batch scan starting: ${topSymbols.length} tokens`);
      kronosPredictions = await kronos.scanAllTokens(topSymbols, '15m', 20, 3);

      // Send summary to Telegram
      const summary = kronos.formatPredictionSummary();
      if (summary) {
        await notify(summary);
        bLog.ai(`Kronos summary sent to Telegram (${kronosPredictions.size} predictions)`);
      }
    } catch (kronosBatchErr) {
      bLog.error(`Kronos batch scan failed (non-blocking): ${kronosBatchErr.message}`);
    }

    const signals = await scanSMC(log, { topNCoins, kronosPredictions });

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

      // Kronos AI prediction — use cached batch result or fetch fresh
      try {
        const kronosModule = require('./kronos');
        const sym = pick.symbol || pick.sym;
        const kronosResult = kronosModule.getCachedPrediction(sym) || await kronosModule.getKronosPrediction(sym, '15m', 20);

        bLog.ai(`Kronos ${sym}: ${kronosResult.direction} (${kronosResult.change_pct > 0 ? '+' : ''}${kronosResult.change_pct}%) confidence=${kronosResult.confidence} trend=${kronosResult.trend}`);
        log(`Kronos: ${sym} → ${kronosResult.direction} ${kronosResult.change_pct}% conf=${kronosResult.confidence}`);

        if (kronosResult.direction !== 'NEUTRAL' && kronosResult.direction !== pick.direction && kronosResult.confidence !== 'low') {
          bLog.trade(`KRONOS BLOCKED: ${sym} SMC=${pick.direction} but Kronos=${kronosResult.direction} (${kronosResult.change_pct}% ${kronosResult.confidence}) — skipping`);
          await notify(`🚫 Kronos blocked *${sym}* ${pick.direction}\nAI predicts ${kronosResult.direction} (${kronosResult.change_pct}%)`);
          continue;
        }

        if (kronosResult.direction === pick.direction && kronosResult.confidence === 'high') {
          bLog.trade(`KRONOS CONFIRMED: ${sym} ${pick.direction} with HIGH confidence (${kronosResult.change_pct}%)`);
        }
      } catch (kronosErr) {
        bLog.error(`Kronos error — blocking trade for safety: ${kronosErr.message}`);
        continue; // Don't trade without Kronos validation
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
          const alreadyInSymbol = openPos.find(p => p.symbol === pick.symbol);

          if (alreadyInSymbol) {
            bLog.trade(`Owner already in ${pick.symbol} — skipping duplicate. Open: ${openPos.map(p => p.symbol).join(', ')}`);
          } else {
            bLog.trade(`Owner has ${openPos.length} open position(s) — opening ${pick.symbol}...`);
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
          }
        } else {
          bLog.trade(`Owner balance too low: $${avail.toFixed(2)} < min $${CONFIG.MIN_BALANCE}`);
        }
      } catch (ownerErr) {
        bLog.error(`Owner trade error: ${ownerErr.message}`);
        log(`Owner trade error: ${ownerErr.message}`);
      }
    } else {
      // No owner env keys — normal mode, using user keys from dashboard
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
    // Auto-pause users with overdue payment (>7 days since last paid, with positive earnings)
    const PAYMENT_OVERDUE_DAYS = 7;
    try {
      const overdueUsers = await db.query(
        `SELECT DISTINCT ak.user_id
         FROM api_keys ak
         JOIN users u ON u.id = ak.user_id
         WHERE ak.enabled = true
           AND (ak.paused_by_admin = false OR ak.paused_by_admin IS NULL)
           AND u.last_paid_at < NOW() - INTERVAL '${PAYMENT_OVERDUE_DAYS} days'`
      );
      for (const row of overdueUsers) {
        // Only pause if user has net positive earnings since last payment
        const earningsCheck = await db.query(
          `SELECT COALESCE(SUM(pnl_usdt), 0) as net_pnl
           FROM trades
           WHERE user_id = $1 AND status IN ('WIN','LOSS','TP','SL','CLOSED')
             AND closed_at > (SELECT last_paid_at FROM users WHERE id = $1)`,
          [row.user_id]
        );
        const netPnl = parseFloat(earningsCheck[0]?.net_pnl) || 0;
        if (netPnl > 0) {
          await db.query(
            `UPDATE api_keys SET paused_by_admin = true WHERE user_id = $1 AND enabled = true`,
            [row.user_id]
          );
          bLog.trade(`User ${row.user_id}: auto-paused — payment overdue (>7 days, net P&L: $${netPnl.toFixed(2)})`);
        }
      }
    } catch (pauseErr) {
      bLog.error(`Auto-pause check failed: ${pauseErr.message}`);
    }

    const allKeys = await db.query(
      `SELECT ak.*, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true
         AND (ak.paused_by_admin = false OR ak.paused_by_admin IS NULL)
         AND (ak.paused_by_user = false OR ak.paused_by_user IS NULL)`
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

    // Track which user+symbol combos have been executed this cycle to prevent duplicates
    const executedUserSymbols = new Set();

    // Execute sequentially per key to prevent race condition duplicates
    // (parallel execution caused all keys to check DB simultaneously, find no trade, and all open)
    for (const key of keys) {
      const userLog = {
        trade:     (msg, data) => bLog.trade(msg, data, key.user_id),
        scan:      (msg, data) => bLog.scan(msg, data, key.user_id),
        error:     (msg, data) => bLog.error(msg, data, key.user_id),
        system:    (msg, data) => bLog.system(msg, data, key.user_id),
        ai:        (msg, data) => bLog.ai(msg, data, key.user_id),
      };
      await (async () => {
      try {
        const symbol = sym;

        // Dedup guard: skip if this user+symbol was already executed this cycle
        const dedupKey = `${key.user_id}:${symbol}`;
        if (executedUserSymbols.has(dedupKey)) {
          userLog.trade(`User ${key.email}: ${symbol} already executed this cycle — skipping duplicate key`);
          return;
        }

        const bannedCoins = (key.banned_coins || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (bannedCoins.includes(symbol)) {
          userLog.trade(`User ${key.email}: ${symbol} is banned — skipped`);
          return;
        }

        // Check user's watchlist — if they have one, only trade their picks
        try {
          const watchlist = await db.query(
            'SELECT symbol FROM user_watchlist WHERE user_id = $1 AND enabled = true',
            [key.user_id]
          );
          if (watchlist.length > 0 && !watchlist.some(w => w.symbol === symbol)) {
            userLog.trade(`User ${key.email}: ${symbol} not in watchlist — skipped`);
            return;
          }
        } catch (_) {}

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

        // Cooldown: don't re-enter same token within 4 hours after last closed trade
        const recentClosed = await db.query(
          `SELECT id, closed_at FROM trades WHERE user_id = $1 AND symbol = $2 AND status IN ('WIN','LOSS','TP','SL','CLOSED') AND closed_at > NOW() - INTERVAL '4 hours' ORDER BY closed_at DESC LIMIT 1`,
          [key.user_id, symbol]
        );
        if (recentClosed.length > 0) {
          userLog.trade(`User ${key.email}: ${symbol} recently closed — cooldown active, skipping re-entry`);
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
        // SL: 10% capital risk, scaled by user's leverage
        const userTrailConfig = getTrailingSLConfig(userLev);
        const slPricePct = userTrailConfig.INITIAL_SL_PCT;
        const initialSlPrice = isLong ? price * (1 - slPricePct) : price * (1 + slPricePct);
        const userTp = pick.tp1 || (isLong ? price * 1.01 : price * 0.99);

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

          userLog.trade(`User ${key.email} Binance: wallet=$${rawWallet.toFixed(2)} available=$${parseFloat(account.availableBalance).toFixed(2)} pos=${openPosCount}/${maxPos} lev=x${userLev} SL=${(slPricePct*100).toFixed(0)}% trailing`);

          const slPrice = initialSlPrice;

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
          const tpFmt = fmtP(userTp);
          userLog.trade(`Setting SL=$${slFmt} TP=$${tpFmt} for ${symbol}...`);

          let slOk = false;
          let tpOk = false;

          try {
            await userClient.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol, side: closeSide,
              type: 'STOP_MARKET', triggerPrice: slFmt,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            slOk = true;
            userLog.trade(`SL set at $${slFmt} (-${(slPricePct*100).toFixed(1)}% from entry)`);
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

          if (!slOk) {
            userLog.error(`${symbol} OPEN without SL — SET MANUALLY!`);
            await notify(`*${symbol} ${pick.direction}*\nPosition opened but *SL failed to set!*\nSet manually on Binance NOW.`);
          }

          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
             trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13)`,
            [key.id, key.user_id, symbol, pick.direction, price, fmtP(slPrice), fmtP(userTp), qty, userLev,
             fmtP(slPrice),
             pick.structure?.tf4h || pick.structure?.tf15 || null, pick.structure?.tf1h || pick.structure?.tf3 || null, pick.structure?.tf15 || pick.structure?.tf1 || null]
          );
          executedUserSymbols.add(dedupKey);
          userLog.trade(`Binance OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty} entry=$${fmtPrice(price)} SL=$${fmtPrice(slPrice)} TP=$${fmtPrice(userTp)}`);
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

          try { await userClient.changeMarginMode(symbol, 'ISOLATION'); } catch (_) {}
          try { await userClient.changeLeverage(symbol, userLev); } catch (_) {}

          const slFmtBx = parseFloat(slPrice.toFixed(8));

          userLog.trade(`User ${key.email}: placing Bitunix MARKET ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty} SL=$${slFmtBx} TP=$${parseFloat(userTp.toFixed(8))}...`);
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
            // Recalculate SL from actual entry price to avoid stale-price rejection
            const actualEntry = parseFloat(pos.avgOpenPrice || pos.entryPrice || pos.avgPrice) || price;
            const actualSlPrice = isLong
              ? actualEntry * (1 - slPricePct)
              : actualEntry * (1 + slPricePct);
            const slFmtActual = parseFloat(actualSlPrice.toFixed(8));

            const actualTpPrice = isLong
              ? actualEntry * (1 + Math.abs(userTp - price) / price)
              : actualEntry * (1 - Math.abs(userTp - price) / price);
            const tpFmtActual = parseFloat(actualTpPrice.toFixed(8));

            userLog.trade(`Bitunix position confirmed: ${pos.positionId} entry=$${actualEntry} — setting SL=$${slFmtActual} TP=$${tpFmtActual}...`);
            try {
              await userClient.placePositionTpSl({ symbol, positionId: pos.positionId, slPrice: slFmtActual, tpPrice: tpFmtActual });
              userLog.trade(`Bitunix SL/TP set on ${pos.positionId}: SL=$${slFmtActual} TP=$${tpFmtActual}`);
            } catch (e) {
              userLog.error(`Bitunix SL FAILED: ${e.message} — SET MANUALLY`);
              await notify(`*Bitunix ${symbol} ${pick.direction}*\nSL failed! Set manually on Bitunix NOW.`);
            }

            // Store actual entry price in DB
            await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
               trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13)`,
              [key.id, key.user_id, symbol, pick.direction, actualEntry,
               slFmtActual, tpFmtActual, qty, userLev, slFmtActual,
               pick.structure?.tf4h || pick.structure?.tf15 || null, pick.structure?.tf1h || pick.structure?.tf3 || null, pick.structure?.tf15 || pick.structure?.tf1 || null]
            );
          } else {
            userLog.error(`Bitunix position not found after order — verify on exchange`);
            await notify(`*Bitunix ${symbol}*\nOrder placed but position not found. Check Bitunix manually.`);

            await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
               trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13)`,
              [key.id, key.user_id, symbol, pick.direction, price,
               parseFloat(slPrice.toFixed(8)), 0, qty, userLev, parseFloat(slPrice.toFixed(8)),
               pick.structure?.tf4h || pick.structure?.tf15 || null, pick.structure?.tf1h || pick.structure?.tf3 || null, pick.structure?.tf15 || pick.structure?.tf1 || null]
            );
          }
          executedUserSymbols.add(dedupKey);
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
      });
    }

    const okCount = keys.length - executedUserSymbols.size;
    const tradedCount = executedUserSymbols.size;
    bLog.trade(`Multi-user execution done: ${tradedCount} traded, ${okCount} skipped/failed`);
    log(`Multi-user done: ${tradedCount} traded, ${okCount} skipped/failed`);

    if (tradedCount === 0) return 'ALL_TOO_EXPENSIVE';
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
              ak.platform, COALESCE(ak.trailing_sl_step, 1.0) as key_trailing_sl_step
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
              const curPrice = exchangePos.entryPrice && exchangePos.pnl !== undefined
                ? (isLong ? entryPrice + (exchangePos.pnl / (Math.abs(exchangePos.amt) || 1))
                          : entryPrice - (exchangePos.pnl / (Math.abs(exchangePos.amt) || 1)))
                : entryPrice;
              const lastStep = parseFloat(trade.trailing_sl_last_step) || 0;
              const tradeLev = parseFloat(trade.leverage) || 20;
              const trailResult = calculateTrailingStep(entryPrice, curPrice, isLong, lastStep, tradeLev);
              if (trailResult) {
                const closeSide = isLong ? 'SELL' : 'BUY';
                let slUpdated = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                  try {
                    const userTp = parseFloat(trade.tp_price) || 0;
                    slUpdated = await updateStopLoss(userClient, trade.symbol, trailResult.newSlPrice, closeSide, 'binance', 8, userTp || undefined);
                    if (slUpdated) break;
                  } catch (e) {
                    bLog.error(`WATCHDOG: Binance SL update failed for ${trade.symbol} attempt ${attempt}/3: ${e.message}`);
                    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
                  }
                }
                if (slUpdated) {
                  await db.query(
                    `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2 WHERE id = $3`,
                    [trailResult.newSlPrice, trailResult.newLastStep, trade.id]
                  );
                  bLog.trade(`Sync trailing SL: ${trade.symbol} stepped to ${(trailResult.newLastStep*100).toFixed(1)}% SL=$${fmtPrice(trailResult.newSlPrice)}`);
                } else {
                  bLog.error(`WATCHDOG ALERT: Binance SL failed 3x for ${trade.symbol}`);
                  await notify(`🚨 *TRAILING SL FAILED*\n${trade.symbol} Binance SL update failed 3 times!`);
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
              markPrice: p.markPrice ? parseFloat(p.markPrice) : null,
            });
          }

          // Check trailing SL for Bitunix positions (self-healing)
          for (const trade of trades) {
            const exchangePos = openSymbols.get(trade.symbol);
            if (exchangePos && trade.trailing_sl_last_step !== undefined) {
              const entryPrice = parseFloat(trade.entry_price);
              const isLong = trade.direction !== 'SHORT';
              const tradeLev = parseFloat(trade.leverage) || 20;

              // ── Step 1: Get current price (3 methods, must succeed) ──
              let curPrice = null;
              const priceMethods = [
                // Method A: Bitunix client getMarketPrice (native to this exchange)
                async () => {
                  const p = await userClient.getMarketPrice(trade.symbol);
                  if (!p || isNaN(p)) throw new Error('invalid');
                  return p;
                },
                // Method B: Bitunix markPrice from position data
                async () => {
                  if (exchangePos.markPrice) return exchangePos.markPrice;
                  throw new Error('no markPrice');
                },
                // Method C: Binance futures public API (fallback for shared symbols)
                async () => {
                  const fetch = require('node-fetch');
                  const res = await fetch(
                    `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${trade.symbol}`,
                    { timeout: 5000, ...getFetchOptions() }
                  );
                  const d = await res.json();
                  const p = parseFloat(d.price);
                  if (!p || isNaN(p)) throw new Error('invalid');
                  return p;
                },
                // Method D: Calculate from PnL
                async () => {
                  const absAmt = Math.abs(exchangePos.amt) || 1;
                  const p = isLong
                    ? entryPrice + (exchangePos.pnl / absAmt)
                    : entryPrice - (exchangePos.pnl / absAmt);
                  if (!p || isNaN(p) || p <= 0) throw new Error('invalid calc');
                  return p;
                },
              ];

              for (let i = 0; i < priceMethods.length; i++) {
                try {
                  curPrice = await priceMethods[i]();
                  if (i > 0) bLog.trade(`Bitunix trailing: ${trade.symbol} price from fallback method ${i + 1}: $${curPrice}`);
                  break;
                } catch (e) {
                  bLog.error(`Bitunix trailing: price method ${i + 1} failed for ${trade.symbol}: ${e.message}`);
                }
              }

              if (!curPrice) {
                bLog.error(`WATCHDOG: ALL price methods failed for ${trade.symbol} — cannot trail SL!`);
                await notify(`⚠️ *TRAILING SL BROKEN*\n${trade.symbol}: all price sources failed!\nManual check needed.`);
                continue;
              }

              // ── Step 2: Calculate profit & trailing step ──
              const profitPct = isLong
                ? (curPrice - entryPrice) / entryPrice
                : (entryPrice - curPrice) / entryPrice;
              const capitalPct = profitPct * tradeLev;
              const lastStep = parseFloat(trade.trailing_sl_last_step) || 0;

              bLog.trade(`Bitunix trailing: ${trade.symbol} entry=$${entryPrice} cur=$${curPrice} pricePct=${(profitPct*100).toFixed(3)}% capitalPct=${(capitalPct*100).toFixed(2)}% lev=${tradeLev}x lastStep=${(lastStep*100).toFixed(1)}%`);

              const trailResult = calculateTrailingStep(entryPrice, curPrice, isLong, lastStep, tradeLev);
              if (!trailResult) continue;

              // ── Step 3: Update SL on exchange (retry up to 3 times) ──
              let slUpdated = false;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  const existingTp = parseFloat(trade.tp_price) || 0;
                  slUpdated = await updateStopLoss(userClient, trade.symbol, trailResult.newSlPrice, null, 'bitunix', 8, existingTp || undefined);
                  if (slUpdated) break;
                  bLog.error(`WATCHDOG: updateStopLoss returned false for ${trade.symbol} (attempt ${attempt}/3)`);
                } catch (e) {
                  bLog.error(`WATCHDOG: updateStopLoss failed for ${trade.symbol} attempt ${attempt}/3: ${e.message}`);
                  if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
                }
              }

              // ── Step 4: Verify SL was actually set ──
              if (slUpdated) {
                await db.query(
                  `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2 WHERE id = $3`,
                  [trailResult.newSlPrice, trailResult.newLastStep, trade.id]
                );
                bLog.trade(`✓ Trailing SL (Bitunix): ${trade.symbol} stepped to ${(trailResult.newLastStep*100).toFixed(1)}% SL=$${trailResult.newSlPrice.toFixed(8)}`);
                await notify(
                  `*Trailing SL Stepped*\n` +
                  `*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                  `Capital profit: *+${(trailResult.newLastStep*100).toFixed(1)}%*\n` +
                  `SL locked at: \`$${trailResult.newSlPrice.toFixed(8)}\``
                );
              } else {
                // All 3 attempts failed — emergency alert
                bLog.error(`WATCHDOG ALERT: Failed to set trailing SL for ${trade.symbol} after 3 attempts!`);
                await notify(
                  `🚨 *TRAILING SL FAILED*\n` +
                  `*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                  `Profit: +${(capitalPct*100).toFixed(1)}% capital\n` +
                  `SL update FAILED 3 times!\n` +
                  `⚠️ Check position manually!`
                );
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
            let tradingFee = 0;

            if (key.platform === 'binance') {
              try {
                const binClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
                // Get fills after the trade was opened
                const openTime = trade.created_at ? new Date(trade.created_at).getTime() : Date.now() - 86400000;
                const fills = await binClient.getAccountTradeList({ symbol: trade.symbol, startTime: openTime, limit: 50 });
                if (fills && fills.length > 0) {
                  // Calculate total fees from ALL fills (entry + exit)
                  for (const f of fills) {
                    tradingFee += Math.abs(parseFloat(f.commission || 0));
                  }
                  // Find the close fills (opposite side of entry)
                  const closeSide = isLong ? 'SELL' : 'BUY';
                  const closeFills = fills.filter(f => f.side === closeSide);
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
              const tradeOpenTime = trade.created_at ? new Date(trade.created_at).getTime() : 0;
              const tradeEntry = parseFloat(trade.entry_price);
              // Bitunix position history uses LONG/SHORT (not BUY/SELL)
              const tradeSideLong = trade.direction !== 'SHORT';

              // Method 1: Position history — match by symbol + side + entry price + time
              try {
                const positions = await bxClient.getHistoryPositions({ symbol: trade.symbol, pageSize: 50 });
                // Log first result's ALL keys so we know exact Bitunix field names
                if (positions.length > 0) {
                  bLog.system(`Bitunix posHistory FIELDS for ${trade.symbol}: ${JSON.stringify(Object.keys(positions[0]))}`);
                  bLog.system(`Bitunix posHistory FIRST RAW: ${JSON.stringify(positions[0])}`);
                }
                for (const p of positions) {
                  // Bitunix may use avgOpenPrice instead of entryPrice
                  const cp = parseFloat(p.closePrice || p.avgClosePrice || 0);
                  const ep = parseFloat(p.entryPrice || p.avgOpenPrice || 0);
                  const pSideLong = (p.side || '').toUpperCase() === 'LONG';
                  const closeMs = parseInt(p.mtime || p.ctime || 0);

                  const entryMatch = ep > 0 && Math.abs(ep - tradeEntry) / tradeEntry < 0.002;
                  const sideMatch = pSideLong === tradeSideLong;
                  const timeMatch = !tradeOpenTime || !closeMs || closeMs > tradeOpenTime;

                  if (cp > 0 && p.symbol === trade.symbol && entryMatch && sideMatch && timeMatch) {
                    exitPrice = cp;
                    // Log ALL raw fields so we can verify which one matches Bitunix dashboard
                    bLog.system(`Bitunix RAW posHistory: ${trade.symbol} | ${JSON.stringify({
                      entryPrice: p.entryPrice, closePrice: p.closePrice, side: p.side,
                      realizedPNL: p.realizedPNL, profit: p.profit, pnl: p.pnl,
                      fee: p.fee, funding: p.funding, qty: p.qty, volume: p.volume,
                      marginMode: p.marginMode, leverage: p.leverage
                    })}`);
                    // Try all possible net P&L fields from Bitunix
                    const profit = parseFloat(p.profit || 0);
                    const pnl = parseFloat(p.pnl || 0);
                    const rpnl = parseFloat(p.realizedPNL || 0);
                    const fee = Math.abs(parseFloat(p.fee || 0));
                    const funding = Math.abs(parseFloat(p.funding || 0));
                    tradingFee = fee + funding;
                    // Priority: profit > pnl > (realizedPNL - fee - funding)
                    if (profit !== 0) {
                      realizedPnl = profit;
                    } else if (pnl !== 0) {
                      realizedPnl = pnl;
                    } else {
                      realizedPnl = rpnl - fee - funding;
                    }
                    found = true;
                    bLog.system(`Bitunix posHistory RESULT: ${trade.symbol} net=${realizedPnl} (used: ${profit !== 0 ? 'profit' : pnl !== 0 ? 'pnl' : 'rpnl-fee-funding'})`);
                    break;
                  }
                }
              } catch (e) { bLog.error(`Bitunix posHistory error: ${e.message}`); }

              // Method 2: Order history — CLOSE orders
              if (!found) {
                try {
                  const orderList = await bxClient.getHistoryOrders({ symbol: trade.symbol, pageSize: 50 });
                  for (const o of orderList) {
                    const oPrice = parseFloat(o.avgPrice || o.price || 0);
                    const isClose = o.reduceOnly || o.tradeSide === 'CLOSE';
                    const oMs = parseInt(o.ctime || o.mtime || 0);
                    const timeMatch = !tradeOpenTime || !oMs || oMs > tradeOpenTime;

                    if (isClose && oPrice > 0 && timeMatch) {
                      exitPrice = oPrice;
                      bLog.system(`Bitunix RAW orderHistory: ${trade.symbol} | ${JSON.stringify({
                        avgPrice: o.avgPrice, price: o.price, realizedPNL: o.realizedPNL,
                        profit: o.profit, pnl: o.pnl, fee: o.fee, tradeSide: o.tradeSide,
                        reduceOnly: o.reduceOnly, qty: o.qty
                      })}`);
                      const profit = parseFloat(o.profit || 0);
                      const pnl = parseFloat(o.pnl || 0);
                      const rpnl = parseFloat(o.realizedPNL || 0);
                      const fee = Math.abs(parseFloat(o.fee || 0));
                      // Priority: profit > pnl > realizedPNL > (realizedPNL - fee)
                      if (profit !== 0) {
                        realizedPnl = profit;
                      } else if (pnl !== 0) {
                        realizedPnl = pnl;
                      } else if (rpnl !== 0) {
                        realizedPnl = rpnl;
                      }
                      found = true;
                      bLog.system(`Bitunix orderHistory RESULT: ${trade.symbol} net=${realizedPnl} (used: ${profit !== 0 ? 'profit' : pnl !== 0 ? 'pnl' : 'rpnl'})`);
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
            // Binance: realizedPnl = gross (before fees), so net = gross - fees
            // Bitunix: profit/pnl fields are NET (fees already included), so net = as-is
            let grossPnl;
            let pnlUsdt;
            if (realizedPnl !== null) {
              if (key.platform === 'bitunix') {
                // Bitunix Position PnL is NET (fees already deducted)
                pnlUsdt = parseFloat(realizedPnl.toFixed(4));
                grossPnl = parseFloat((realizedPnl + tradingFee).toFixed(4));
              } else {
                // Binance realizedPnl is GROSS (before fees)
                grossPnl = parseFloat(realizedPnl.toFixed(4));
                pnlUsdt = parseFloat((realizedPnl - tradingFee).toFixed(4));
              }
            } else {
              grossPnl = isLong
                ? parseFloat(((exitPrice - entryPrice) * qty).toFixed(4))
                : parseFloat(((entryPrice - exitPrice) * qty).toFixed(4));
              // Estimate fees when exchange data unavailable: ~0.06% per side (open+close)
              if (tradingFee === 0) {
                const notional = exitPrice * qty;
                tradingFee = parseFloat((notional * 0.0012).toFixed(4)); // 0.12% round trip
                bLog.trade(`Estimated trading fee for ${trade.symbol}: $${tradingFee.toFixed(4)} (0.12% of $${notional.toFixed(2)} notional)`);
              }
              pnlUsdt = parseFloat((grossPnl - tradingFee).toFixed(4));
            }
            tradingFee = parseFloat(tradingFee.toFixed(4));
            grossPnl = parseFloat(grossPnl.toFixed(4));
            const status = pnlUsdt > 0 ? 'WIN' : 'LOSS';

            await db.query(
              `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3, closed_at = NOW(),
               trading_fee = $5, gross_pnl = $6
               WHERE id = $4`,
              [status, pnlUsdt, exitPrice, trade.id, tradingFee, grossPnl]
            );
            bLog.trade(`DB synced: ${trade.symbol} -> ${status} gross=$${grossPnl} fee=$${tradingFee} net=$${pnlUsdt} exit=$${fmtPrice(exitPrice)}`);

            // Circuit breaker: track consecutive losses
            if (status === 'LOSS') {
              consecutiveLosses++;
              if (consecutiveLosses >= CIRCUIT_BREAKER.MAX_CONSECUTIVE_LOSSES) {
                circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER.COOLDOWN_MS;
                bLog.trade(`CIRCUIT BREAKER: ${consecutiveLosses} consecutive losses — pausing ${CIRCUIT_BREAKER.COOLDOWN_MS / 60000}min`);
                await notify(`*Circuit Breaker Activated*\n${consecutiveLosses} consecutive losses — pausing new trades for 30 minutes.`);
              }
            } else {
              consecutiveLosses = 0; // Reset on any win
            }

            // Record token daily result
            try {
              const { recordTokenResult } = require('./token-scanner');
              await recordTokenResult(trade.symbol, pnlUsdt, tradingFee, pnlUsdt > 0);
            } catch (_) {}

            // Record profit split for winning trades
            if (pnlUsdt > 0) {
              await recordProfitSplit(db, trade.user_id, trade.api_key_id, pnlUsdt, trade.symbol);
            }

            // RPG: XP only from winning trades — all agents involved get rewarded
            try {
              const { getCoordinator } = require('./agents');
              const coord = getCoordinator();
              const tokenKey = trade.symbol.toLowerCase().replace('usdt', '');
              const tokenAgent = coord._agents.get(tokenKey);
              if (pnlUsdt > 0) {
                // Winning trade — reward all agents in the pipeline
                if (tokenAgent) tokenAgent.gainXp(100, true).catch(() => {});
                coord.traderAgent.gainXp(50, true).catch(() => {});
                coord.chartAgent.gainXp(30, true).catch(() => {});
                coord.riskAgent.gainXp(20, true).catch(() => {});
                coord.sentimentAgent.gainXp(15, true).catch(() => {});
                coord.kronosAgent.gainXp(15, true).catch(() => {});
                coord.strategyAgent.gainXp(10, true).catch(() => {});
                coord.gainXp(10, true).catch(() => {});
              }
              // Track earnings regardless of win/loss
              if (tokenAgent) tokenAgent.addEarnings(Math.abs(pnlUsdt)).catch(() => {});
              coord.traderAgent.addEarnings(Math.abs(pnlUsdt)).catch(() => {});
            } catch (_) {}
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

module.exports = {
  run,
  // Exported for agent framework (Phase 2)
  executeForAllUsers,
  openTrade,
  checkTrailingStop,
  syncTradeStatus,
  checkUsdtTopups,
  getClient,
  isTokenBanned,
  getTokenLeverage,
  getCapitalPercentage,
  getDailyCapital,
  calculateTrailingStep,
  updateStopLoss,
  recordProfitSplit,
  notify,
  CONFIG,
  TRAILING_SL_CAPITAL,
  getTrailingSLConfig,
  tradeState,
};
