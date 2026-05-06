// ============================================================
// Smart Crypto Trader v4 — AI Self-Learning Edition
// Binance USDT-M Futures + Bitunix Futures
// Strategy: V4 SMC — VWAP Zone + LuxAlgo BOS/CHoCH (89.6% WR, 7-day backtest)
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
// V4 SMC strategy: VWAP 2σ zones + 15m/1m BOS+CHoCH confluence
// Rules: bull days → LONG only | bear days → SHORT only | ranging → nothing
const { scanV4SMC, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE } = require('./strategy-v4-smc');
// Keep 3-timing import for calcTrail3Timing + getSessionMode (still used elsewhere)
const { getSessionMode } = require('./strategy-3timing'); // v4: trailing SL uses calculateTrailingStep (cycle.js) instead of calcTrail3Timing
const { scanChartAgent } = require('./chart-agent');
const { getSentimentScores } = require('./sentiment-scraper');
const { log: bLog } = require('./bot-logger');
const { getBinanceRequestOptions, getFetchOptions } = require('./proxy-agent');

// ── Trade outcome callback — agents hook in to track survival ──
let _onTradeOutcome = null;
function onTradeOutcome(fn) { _onTradeOutcome = fn; }
function fireTradeOutcome(data) { if (_onTradeOutcome) { try { _onTradeOutcome(data); } catch (_) {} } }

const API_KEY        = process.env.BINANCE_API_KEY    || '';
const API_SECRET     = process.env.BINANCE_API_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN     || '';
const TELEGRAM_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const PRIVATE_CHATS  = TELEGRAM_CHATS.filter(id => !id.startsWith('-'));

// ── CONFIG (defaults — AI may override some via getOptimalParams) ─
const BTC_ETH_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT']);
// These tokens trade at 100x leverage
const HIGH_PRICE_SYMBOLS = new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
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

// ── Global State ──────────────────────────────────────────────
let lastBitunixSync = 0;

// ── SL/TP Config ──────────────────────────────────────────
// System 5 — initial SL = 25% capital (margin).
// Fees at 100x: 0.04% taker × 2 sides × 100 leverage = 8% of margin.
// Fees at  50x: 0.04% taker × 2 sides ×  50 leverage = 4% of margin.
// SL_PCT is price-loss fraction; capital loss = SL_PCT × leverage.
//   100x: price SL = 0.25/100 = 0.25% price move → 25% capital loss
//    50x: price SL = 0.25/50  = 0.50% price move → 25% capital loss
//    20x: price SL = 0.25/20  = 1.25% price move → 25% capital loss
const SL_PCT = 0.25;   // System 5: 25% capital initial SL
const TP_PCT = 0.45;   // reference only — trailing SL handles the actual exit

// ── Active AI Version params — loaded from settings table, refreshed every 60s ──
// Admin activates a backtest version via the UI → params saved to settings.
// cycle.js reads them here and overrides SL/TP/trail at trade time.
let _activeVersionCache = { params: null, ts: 0 };
const ACTIVE_VERSION_TTL = 60_000;

async function getActiveVersionParams() {
  if (Date.now() - _activeVersionCache.ts < ACTIVE_VERSION_TTL) return _activeVersionCache.params;
  try {
    const { query: dbQ } = require('./db');
    const rows = await dbQ(`SELECT value FROM settings WHERE key = 'active_ai_version'`);
    _activeVersionCache.params = rows.length ? JSON.parse(rows[0].value) : null;
  } catch {
    _activeVersionCache.params = null;
  }
  _activeVersionCache.ts = Date.now();
  return _activeVersionCache.params;
}

// Taker fee: 0.04% entry + 0.04% exit = 0.08% notional both legs
const TAKER_FEE_BOTH_LEGS = 0.0008;

// Trailing SL tiers — System 5 (used by non-v2/v3 strategies via calculateTrailingStep)
// 3-Timing active strategy uses calcTrail3Timing in strategy-3timing.js instead.
//
// System 5: initial SL = 10% capital, trail triggers at +46%, first lock = +45%
//   +46% capital → lock +45%   gap = 1%
//   +57% capital → lock +55%   gap = 10%
//   +68% capital → lock +65%   gap = 10%
//   … +10% SL every +11% capital gain
//
// At 20x leverage:  +10% capital = +0.5% price move
// At 100x leverage: +10% capital = +0.1% price move
//
// trigger = capital % gain needed to activate (price % × leverage)
// lock    = capital % above entry to lock the SL at
// Per-user rule: trigger is exactly 1% above the lock at every tier
// (e.g. +21% profit locks +20%, +31% locks +30%, +41% locks +40%, ...).
// This table is used for HIGH-leverage trades (>= 100x — BTC, ETH).
// First tier starts at +31% capital (user request — gives trade more room before locking).
const TRAILING_TIERS = [
  { trigger: 0.46, lock: 0.45 }, // +46% capital → SL locks at +45%   — 1% gap (first tier, 100x)
  { trigger: 0.51, lock: 0.50 }, // +51% capital → SL locks at +50%   — 1% gap
  { trigger: 0.61, lock: 0.60 }, // +61% capital → SL locks at +60%   — 1% gap
  { trigger: 0.71, lock: 0.70 }, // +71% capital → SL locks at +70%   — 1% gap
  { trigger: 0.81, lock: 0.80 }, // +81% capital → SL locks at +80%   — 1% gap
  { trigger: 0.91, lock: 0.90 }, // +91% capital → SL locks at +90%   — 1% gap
  { trigger: 1.01, lock: 1.00 }, // +101% capital → SL locks at +100% — 1% gap
  { trigger: 1.11, lock: 1.10 }, // +111% capital → SL locks at +110% — 1% gap
  { trigger: 1.21, lock: 1.20 }, // +121% capital → SL locks at +120% — 1% gap
  { trigger: 1.51, lock: 1.50 }, // +151% capital → SL locks at +150% — 1% gap
  { trigger: 2.01, lock: 2.00 }, // +201% capital → SL locks at +200% — 1% gap
  { trigger: 3.01, lock: 3.00 }, // +301% capital → SL locks at +300% — 1% gap
];

// Per user direction for 50x tokens (SOL/BNB/XRP):
// First tier at +16% → +15% (1% gap), then every +11% profit advances
// the lock by +10%. The gap therefore widens by 1% each step
// (16/15→1%, 27/25→2%, 38/35→3%, ...).
const TRAILING_TIERS_50X = [
  { trigger: 0.21, lock: 0.20 }, // +21% → +20% (first tier, 50x)
  { trigger: 0.31, lock: 0.30 }, // +31% → +30%
  { trigger: 0.38, lock: 0.35 }, // +38% → +35%
  { trigger: 0.49, lock: 0.45 }, // +49% → +45%
  { trigger: 0.60, lock: 0.55 }, // +60% → +55%
  { trigger: 0.71, lock: 0.65 }, // +71% → +65%
  { trigger: 0.82, lock: 0.75 }, // +82% → +75%
  { trigger: 0.93, lock: 0.85 }, // +93% → +85%
  { trigger: 1.04, lock: 0.95 }, // +104% → +95%
  { trigger: 1.15, lock: 1.05 }, // +115% → +105%
  { trigger: 1.26, lock: 1.15 }, // +126% → +115%
  { trigger: 1.50, lock: 1.40 }, // +150% → +140%
  { trigger: 2.00, lock: 1.90 }, // +200% → +190%
  { trigger: 3.00, lock: 2.90 }, // +300% → +290%
];

// 75x tier table for V4 SMC alt coins (ADA/SOL/AVAX at 75x leverage):
// Starts at +31% capital (vs 21% for 100x) — more room before first lock.
// Each step: trigger +1% above lock, advancing every +10% capital gain.
const TRAILING_TIERS_75X = [
  { trigger: 0.31, lock: 0.30 }, // +31% → +30% (first tier, 75x)
  { trigger: 0.41, lock: 0.40 }, // +41% → +40%
  { trigger: 0.51, lock: 0.50 }, // +51% → +50%
  { trigger: 0.61, lock: 0.60 }, // +61% → +60%
  { trigger: 0.71, lock: 0.70 }, // +71% → +70%
  { trigger: 0.81, lock: 0.80 }, // +81% → +80%
  { trigger: 0.91, lock: 0.90 }, // +91% → +90%
  { trigger: 1.01, lock: 1.00 }, // +101% → +100%
  { trigger: 1.21, lock: 1.20 }, // +121% → +120%
  { trigger: 1.51, lock: 1.50 }, // +151% → +150%
  { trigger: 2.01, lock: 2.00 }, // +201% → +200%
];

function tierTableForLev(leverage) {
  // V4 SMC leverage tiers:
  //   100x → tight 1% gap table (BTC/ETH/BNB)
  //    75x → 75x table (ADA/SOL/AVAX)
  //    ≤50x → gentler 50x table
  if (leverage >= 100) return TRAILING_TIERS;
  if (leverage >= 75)  return TRAILING_TIERS_75X;
  return TRAILING_TIERS_50X;
}

function getTrailingSLConfig(leverage) {
  const t = tierTableForLev(leverage);
  return {
    INITIAL_SL_PCT: SL_PCT / leverage,
    FIRST_TRIGGER: t[0].trigger,
    FIRST_SL:      t[0].lock,
    STEP_TRIGGER:  leverage <= 50 ? 0.11 : 0.10,
    STEP_SL:       0.10,
  };
}

// ── Compound: always use current wallet balance ─────────────
function getDailyCapital(key, currentBalance) {
  return currentBalance;
}

// Get token-specific leverage: user per-key → admin global → risk level → price-based default
async function getTokenLeverage(symbol, apiKeyId = null, price = 0) {
  const MAX_LEVERAGE = 125; // Exchange max — user/admin settings decide actual value
  try {
    const { query } = require('./db');

    // Priority 1: User per-key per-token leverage override (user explicitly set this)
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

    // Priority 4: No explicit config — all 4 allowed tokens use 100x
    return 100;
  } catch (err) {
    console.error('Error getting token leverage:', err.message);
    // Return null instead of fallback to ensure safety
    return null;
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
    // Only check explicit bans — tokens not in the table are allowed by default
    const banned = await query(
      'SELECT banned FROM global_token_settings WHERE symbol = $1 AND banned = true',
      [symbol]
    );
    return banned.length > 0;
  } catch {
    return false;
  }
}

// Leverage from the single source of truth in strategy-3timing.js
function getLeverage(symbol, price, params = {}) {
  return SYMBOL_LEVERAGE[symbol] || params.LEV_BTC_ETH || 100;
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

// ── Swing detection (Zeiierman-style pivots) ──
const SWING_LENGTHS = { '15m': 10, '3m': 10, '1m': 5 };
function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows  = klines.map(k => parseFloat(k[3]));
  const swings = [];
  let lastType = null;
  for (let i = len; i < klines.length - len; i++) {
    let isHigh = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) { isHigh = false; break; }
    }
    let isLow = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (lows[i] >= lows[i + j]) { isLow = false; break; }
    }
    if (isHigh && isLow) {
      const highDist = highs[i] - Math.max(highs[i - 1], highs[i + 1]);
      const lowDist  = Math.min(lows[i - 1], lows[i + 1]) - lows[i];
      if (highDist > lowDist) isLow = false; else isHigh = false;
    }
    if (isHigh) {
      if (lastType === 'high') {
        const prev = swings[swings.length - 1];
        if (highs[i] > prev.price) swings[swings.length - 1] = { type: 'high', index: i, price: highs[i], candle: klines[i] };
      } else {
        swings.push({ type: 'high', index: i, price: highs[i], candle: klines[i] });
        lastType = 'high';
      }
    }
    if (isLow) {
      if (lastType === 'low') {
        const prev = swings[swings.length - 1];
        if (lows[i] < prev.price) swings[swings.length - 1] = { type: 'low', index: i, price: lows[i], candle: klines[i] };
      } else {
        swings.push({ type: 'low', index: i, price: lows[i], candle: klines[i] });
        lastType = 'low';
      }
    }
  }
  return swings;
}

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
    let posId = null;
    let posRawKeys = '';
    try {
      const posData = await client.getOpenPositions(symbol);
      bLog.trade(`[Bitunix updateStopLoss] ${symbol}: raw posData type=${Array.isArray(posData) ? 'array' : typeof posData}, keys=${JSON.stringify(posData ? Object.keys(posData) : null)}`);
      // Bitunix may return a bare array OR a wrapped object (positionList / list / single obj).
      const posList = Array.isArray(posData) ? posData
        : (posData?.positionList || posData?.list
            || (posData && typeof posData === 'object' && !Array.isArray(posData) ? [posData] : []));
      bLog.trade(`[Bitunix updateStopLoss] ${symbol}: posList length=${posList.length}`);
      const pos = posList.find(p => p.symbol === symbol);
      if (pos) {
        posRawKeys = JSON.stringify(Object.keys(pos));
        // Try every known field name Bitunix uses for position ID
        posId = pos.positionId || pos.id || pos.position_id || pos.orderId;
        bLog.trade(`[Bitunix updateStopLoss] ${symbol}: pos found, posId=${posId}, fields=${posRawKeys}`);
      } else {
        bLog.error(`[Bitunix updateStopLoss] ${symbol}: no matching pos in list of ${posList.length}. Symbols: ${posList.map(p => p.symbol).join(',')}`);
      }
    } catch (e) {
      bLog.error(`[Bitunix updateStopLoss] ${symbol}: getOpenPositions failed: ${e.message}`);
    }

    const buildTpSlBody = (withPosId) => {
      const body = { symbol };
      if (withPosId && posId) body.positionId = String(posId);
      body.slPrice = String(slFmt);
      body.slStopType = 'MARK_PRICE';
      body.slOrderType = 'MARKET';
      if (existingTpPrice) {
        body.tpPrice = String(fmtP(existingTpPrice));
        body.tpStopType = 'MARK_PRICE';
        body.tpOrderType = 'MARKET';
      }
      return body;
    };

    // Attempt 1: with positionId (required by Bitunix in hedge mode)
    if (posId) {
      const body1 = buildTpSlBody(true);
      bLog.trade(`[Bitunix updateStopLoss] ${symbol}: attempt 1 body=${JSON.stringify(body1)}`);
      const raw1 = await client._rawPost('/api/v1/futures/tpsl/position/place_order', body1);
      bLog.trade(`[Bitunix updateStopLoss] ${symbol}: attempt 1 raw response=${JSON.stringify(raw1)}`);
      if (raw1?.code === 0) return true;
      bLog.error(`[Bitunix updateStopLoss] ${symbol}: attempt 1 FAILED code=${raw1?.code} msg=${raw1?.msg}`);
    }

    // Attempt 2: without positionId (one-way / netting mode)
    const body2 = buildTpSlBody(false);
    bLog.trade(`[Bitunix updateStopLoss] ${symbol}: attempt 2 body=${JSON.stringify(body2)}`);
    const raw2 = await client._rawPost('/api/v1/futures/tpsl/position/place_order', body2);
    bLog.trade(`[Bitunix updateStopLoss] ${symbol}: attempt 2 raw response=${JSON.stringify(raw2)}`);
    if (raw2?.code === 0) {
      bLog.trade(`[Bitunix updateStopLoss] ${symbol}: SL set without positionId (fallback)`);
      return true;
    }
    bLog.error(`[Bitunix updateStopLoss] ${symbol}: attempt 2 FAILED code=${raw2?.code} msg=${raw2?.msg}`);
    return false;
  }
  return false;
}

// ── TRAILING SL ────────────────────────────────────────────
// Trailing SL: capital%-based tiers — SL only moves up (LONG) or down (SHORT), never backwards.
// Triggers fire at CAPITAL % gain (price % × leverage).
// SL lock is also in CAPITAL %, converted to price % for the actual order price.

// Infer price decimal precision from a stored price string/number.
// Used so trailing SL respects Binance PRICE_FILTER tick sizes (e.g. BTCUSDT = 1 decimal).
function inferPricePrec(storedPrice) {
  const s = String(parseFloat(storedPrice) || 0);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// ── CANDLE-LOW TRAILING SL ────────────────────────────────────
// After each completed 15m candle, move SL to:
//   LONG  → low  of the last completed 15m candle (if higher than current SL)
//   SHORT → high of the last completed 15m candle (if lower than current SL)
// Only moves SL in the profitable direction — never against the trade.
async function calcCandleTrailSl(symbol, isLong, currentSlPrice) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=3`;
    const res = await fetch(url, { timeout: 6000, ...getFetchOptions() });
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return null;

    // data[data.length - 1] is the still-forming candle — use data[data.length - 2]
    const lastCompleted = data[data.length - 2];
    const candleLow  = parseFloat(lastCompleted[3]); // index 3 = low
    const candleHigh = parseFloat(lastCompleted[2]); // index 2 = high

    if (isLong) {
      // Move SL up to the completed candle's low — only if it's higher than current SL
      if (candleLow > currentSlPrice) return { newSl: candleLow, source: '15m_candle_low' };
    } else {
      // Move SL down to the completed candle's high — only if it's lower than current SL
      if (candleHigh < currentSlPrice) return { newSl: candleHigh, source: '15m_candle_high' };
    }
    return null; // candle didn't improve — keep current SL
  } catch (e) {
    bLog.error(`calcCandleTrailSl ${symbol}: ${e.message}`);
    return null;
  }
}

// calculateTrailingStep — capital%-based trailing SL.
// Uses CAPITAL % (profit as % of margin = pricePct × leverage) for tier triggers.
// Converts capital lock % back to price % when computing the new SL price.
//
// lastStep: last capital % lock applied — stored in DB as trailing_sl_last_step.
//           Prevents SL from moving backwards.
//
// Tier logic (capital % = price % × leverage):
//   +21% capital → lock SL at +20% capital above entry             1% gap
//   +31% capital → lock SL at +30% capital above entry             1% gap
//   +41% capital → lock SL at +40% capital above entry             1% gap
//   ... every +10% capital gain advances the lock by +10% (gap stays 1%)
//
// Example — 20x leverage, BTC entry $90,000:
//   +1.05% price (+21% capital) → SL moves to entry +1.0% (+20% capital)
//   +3.0% price (+60% capital) → SL moves to entry + 1.5% ($91,350)
// Trailing SL rules:
//
// Safety tier (+30%→+10%): at +30% capital profit, lock in +10% profit before
//   the main trail activates. If the trade reverses after +30% you still exit
//   with +10% capital gain instead of -25% loss. Always fires regardless of
//   smcMode — both session types benefit from this early profit lock.
//   Ratchet-safe: +0.10 > 0 (initial lastStep) so it flows through the normal
//   ratchet check without any special sentinel handling.
//
// smcMode (+61%→+60%): during Asia/London/NY session opens, first lock jumps
//   straight to +60% capital, skipping the 20–50% early tiers. Off-session uses
//   the default table (first lock +20%).
const SAFETY_TRAIL_TRIGGER = 0.20; // +20% capital → lock in profit
const SAFETY_TRAIL_LOCK    = 0.10; // SL moves to +10% capital profit

function calculateTrailingStep(entryPrice, currentPrice, isLong, lastStep, leverage = 20, userTrailStepPct = 0, smcMode = false) {
  const pricePct = isLong
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;

  // Convert price move to capital % (profit relative to margin)
  const capitalPct = pricePct * leverage;

  // ── Safety tier: +30% capital → lock +10% profit ────────────
  // Fires before the main trail activates. Always applies (SMC and off-session).
  // The ratchet (+0.10 > 0 initial lastStep) handles it naturally — no special logic.
  if (userTrailStepPct === 0 && capitalPct >= SAFETY_TRAIL_TRIGGER && lastStep < SAFETY_TRAIL_LOCK) {
    const tiers = tierTableForLev(leverage);
    const firstMainTrigger = smcMode
      ? (tiers.find(t => t.lock >= 0.60)?.trigger ?? 0.61)
      : tiers[0].trigger;
    if (capitalPct < firstMainTrigger) {
      // Pre-trail zone: lock in +10% profit
      const lockPricePct = SAFETY_TRAIL_LOCK / leverage;
      const newSlPrice = isLong
        ? entryPrice * (1 + lockPricePct)
        : entryPrice * (1 - lockPricePct);
      return { stepped: true, newSlPrice, newLastStep: SAFETY_TRAIL_LOCK };
    }
  }

  let bestLockCapitalPct = null;

  if (userTrailStepPct > 0) {
    // User custom trailing (step in capital %): fire at stepPct, lock one step behind
    const stepPct = userTrailStepPct / 100;
    if (capitalPct >= stepPct) {
      const stepsAbove = Math.floor((capitalPct + 1e-10) / stepPct);
      bestLockCapitalPct = (stepsAbove - 1) * stepPct;
    }
  } else {
    // Fixed tiers — all thresholds in CAPITAL %. The table is leverage-
    // aware: 50x tokens (SOL/BNB/XRP) use a gentler ladder than 100x
    // tokens (BTC/ETH).
    const tiers = tierTableForLev(leverage);
    for (const tier of tiers) {
      // SMC session mode: skip all tiers that lock below 60% capital.
      // Session opens (Asia/London/NY) tend to run hard past 60%; locking
      // at 20/30/40/50% exits these trades too early.
      if (smcMode && tier.lock < 0.60) continue;
      if (capitalPct >= tier.trigger) bestLockCapitalPct = tier.lock;
    }
    // Beyond last tier: extend with the same step-per-tier pattern.
    // 100x table uses +10% trigger / +10% lock; 50x table uses +11% / +10%.
    const lastTier = tiers[tiers.length - 1];
    if (capitalPct > lastTier.trigger) {
      const triggerStep = leverage <= 50 ? 0.11 : 0.10;
      const lockStep    = 0.10;
      const stepsAbove  = Math.floor((capitalPct - lastTier.trigger) / triggerStep);
      const extraLock   = lastTier.lock + stepsAbove * lockStep;
      if (extraLock > (bestLockCapitalPct || 0)) bestLockCapitalPct = extraLock;
    }
  }

  if (bestLockCapitalPct === null) return null;
  // Ratchet: SL only moves in profitable direction.
  // lastStep may be negative (-0.10 safety sentinel) — any positive lock clears it.
  if (bestLockCapitalPct <= lastStep) return null;

  // ── Minimum first-lock: must clear fees + small profit ──────
  // On the FIRST trailing step (lastStep === 0), ensure the locked SL is high enough
  // that if hit it covers: entry taker + exit taker + estimated funding + a small profit.
  // Fee cost in capital % = (taker_both_legs + funding_estimate) × leverage
  //   20x:  (0.08% + 0.03%) × 20  =  2.2% capital in fees
  //   100x: (0.08% + 0.03%) × 100 = 11.0% capital in fees
  // Add MIN_PROFIT_BUFFER (5% capital) so there's always real profit left after fees.
  if (lastStep === 0) {
    const FEE_RATE  = TAKER_FEE_BOTH_LEGS + 0.0003; // entry+exit taker + one funding period
    const feeCapitalPct    = FEE_RATE * leverage;
    const MIN_PROFIT_BUFFER = 0.05;                  // 5% capital profit minimum
    const minFirstLock = feeCapitalPct + MIN_PROFIT_BUFFER;
    if (bestLockCapitalPct < minFirstLock) bestLockCapitalPct = minFirstLock;
  }

  // Convert capital lock % → price % for actual SL price
  const lockPricePct = bestLockCapitalPct / leverage;
  const newSlPrice = isLong
    ? entryPrice * (1 + lockPricePct)
    : entryPrice * (1 - lockPricePct);

  return { stepped: true, newSlPrice, newLastStep: bestLockCapitalPct };
}

// ── PROFIT SPLIT: Credit 60% user, 40% platform fee ─────────
// Admin accounts are fully exempt — no platform fee, 100% profit recorded as theirs.
async function recordProfitSplit(db, userId, apiKeyId, pnlUsdt, symbol) {
  if (pnlUsdt <= 0) return;

  try {
    // Check if user is admin — admins pay no platform fee
    const userRows = await db.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
    const isAdmin = userRows.length > 0 && userRows[0].is_admin === true;

    if (isAdmin) {
      // Admin: record 100% as profit share, no platform fee
      await db.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
         VALUES ($1, 'profit_share', $2, 'completed', $3)`,
        [userId, pnlUsdt, `100% profit (admin exempt) — ${symbol} trade profit $${pnlUsdt.toFixed(2)} (stays on exchange)`]
      );
      bLog.trade(`Profit (admin exempt): ${symbol} PnL=$${pnlUsdt.toFixed(2)} → 100% to admin, no platform fee`);
      return;
    }

    // Get profit share settings from the API key
    const keyRows = await db.query(
      'SELECT profit_share_user_pct, profit_share_admin_pct FROM api_keys WHERE id = $1',
      [apiKeyId]
    );
    const userPct  = keyRows.length > 0 ? (parseFloat(keyRows[0].profit_share_user_pct)  || 60) : 60;
    const adminPct = keyRows.length > 0 ? (parseFloat(keyRows[0].profit_share_admin_pct) || 40) : 40;

    const userShare   = pnlUsdt * userPct  / 100;
    const platformFee = pnlUsdt * adminPct / 100;

    // Record for PnL display only — cash_wallet is NOT touched by trades.
    // Cash wallet only grows from: manual top-ups + referral commission when referral pays weekly fee.
    await db.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
       VALUES ($1, 'profit_share', $2, 'completed', $3)`,
      [userId, userShare, `${userPct}% profit share — ${symbol} trade profit $${pnlUsdt.toFixed(2)} (stays on exchange)`]
    );
    await db.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
       VALUES ($1, 'platform_fee', $2, 'completed', $3)`,
      [userId, platformFee, `${adminPct}% platform fee on ${symbol} profit $${pnlUsdt.toFixed(2)}`]
    );

    bLog.trade(`Profit split: ${symbol} PnL=$${pnlUsdt.toFixed(2)} → user ${userPct}%=$${userShare.toFixed(2)} | platform ${adminPct}%=$${platformFee.toFixed(2)}`);
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
  const walletSizePct = 0.10; // locked — 10% of wallet per trade (safety agent)

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

  // SL price distance = SL_PCT / leverage (gross price loss, fees accepted on top)
  // At 100x: 0.25/100 = 0.25% price move → 25% capital price loss + 8% fees ≈ 33% gross
  // At  50x: 0.25/50  = 0.50% price move → 25% capital price loss + 4% fees ≈ 29% gross
  let slPricePct = SL_PCT / leverage;
  const tpPricePct = TP_PCT / leverage;

  // Liquidation guard: SL must not exceed liquidation distance
  const maxSlPct = (1 / leverage) * 0.80;
  if (slPricePct > maxSlPct) {
    bLog.trade(`SL clamped: ${(slPricePct*100).toFixed(3)}% > liq limit ${(maxSlPct*100).toFixed(3)}% at ${leverage}x`);
    slPricePct = maxSlPct;
  }

  const slDist = slPricePct;
  const initialSlPrice = fmtP(isLong ? price * (1 - slPricePct) : price * (1 + slPricePct));

  // TP targets (no hard close — trailing SL handles exit, TP is just reference)
  const tp1 = fmtP(isLong ? price * (1 + tpPricePct) : price * (1 - tpPricePct));
  const tp2 = fmtP(isLong ? price * (1 + tpPricePct * 1.5) : price * (1 - tpPricePct * 1.5));
  const tp3 = fmtP(isLong ? price * (1 + tpPricePct * 2.0) : price * (1 - tpPricePct * 2.0));

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

  // Fee check: ensure TP profit covers fees
  const totalFees = notional * CONFIG.TAKER_FEE * 2;
  const tpProfit = notional * tpPricePct;
  bLog.trade(`Size: ${(walletSizePct*100).toFixed(0)}% wallet=$${tradeUsdt.toFixed(2)} notional=$${notional.toFixed(2)} lev=${leverage}x margin=$${requiredMargin.toFixed(2)} | SL=${(slPricePct*100).toFixed(2)}%price TP=${(tpPricePct*100).toFixed(2)}%price`);
  log(`Trade: ${sym} ${direction} lev=${leverage}x qty=${qty} notional=$${notional.toFixed(2)} margin=$${requiredMargin.toFixed(2)}`);
  if (tpProfit < totalFees * 1.5) {
    bLog.trade(`Trade rejected: TP profit $${tpProfit.toFixed(4)} < 1.5x fees $${(totalFees * 1.5).toFixed(4)}`);
    throw new Error(`Trade rejected: TP profit < 1.5x fees`);
  }

  const entrySide = isLong ? 'BUY' : 'SELL';
  const closeSide = isLong ? 'SELL' : 'BUY';

  // Market entry
  const order = await client.submitNewOrder({ symbol: sym, side: entrySide, type: 'MARKET', quantity: qty });
  await sleep(1500);

  // Set SL on exchange — NO hard TP (trailing SL handles exit, lets winners ride)
  let slOk = false;

  try {
    await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL', symbol: sym, side: closeSide,
      type: 'STOP_MARKET', triggerPrice: initialSlPrice,
      closePosition: 'true', workingType: 'MARK_PRICE',
    });
    slOk = true;
    bLog.trade(`SL set at $${fmtPrice(initialSlPrice)} (${(slPricePct*100).toFixed(2)}% from entry) | System 5 trailing: SMC session → first lock +60% capital; off-session → +20%, then +10% SL every +10% gain`);
  } catch (e) { bLog.error(`Owner SL algo failed: ${e.message}`); }

  if (!slOk) {
    bLog.error(`Owner ${sym} missing SL — set manually!`);
    await notify(`*${sym} ${direction}* opened without *SL*! Set manually NOW.`);
  }

  tradeState.set(sym, {
    entry: price, tp1, tp2, tp3, sl: initialSlPrice, qty, isLong,
    tpHit1: false, tpHit2: false,
    pricePrec, qtyPrec,
    setup: pick.setup,
    comboId: pick.comboId || 15,
    openedAt: Date.now(),
    tf15m: null,
    tf3m: pick.structure?.tf3m || null,
    tf1m: pick.structure?.tf1m || null,
    marketStructure: pick.marketStructure || null,
    trailingSlPrice: initialSlPrice,
    trailingSlLastStep: 0,
    leverage,
    vwapZone: pick.vwapBandPos || null,
    // v2 flag: use swing-point 30%/31% trailing logic instead of capital-tier logic
    strategyVersion: pick.version || null,
  });

  // Auto-clear per-token direction override — it was one-shot, trade is now open
  if (pick.tokenDirectionOverride) {
    try {
      await require('./db').query(
        `UPDATE global_token_settings SET direction_override = NULL WHERE symbol = $1`,
        [sym]
      );
      bLog.ai(`${sym}: per-token direction override cleared (one-shot, trade opened)`);
    } catch (_) {}
  }

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
            const trades = await client.getAccountTrades({ symbol: sym, limit: 5 });
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
            marketStructure: state.marketStructure || null,
            vwapZone: state.vwapZone || null,
            exitReason: 'position_closed',
            comboId: state.comboId || 15,
          });

          if (pnlPct < 0) {
            await aiLearner.performLossAutopsy({
              symbol: sym,
              setup: state.setup || 'unknown',
              direction: state.isLong ? 'LONG' : 'SHORT',
              session: aiLearner.getCurrentSession(),
              marketStructure: state.marketStructure || 'unknown',
              vwapZone: state.vwapZone || null,
            });
          } else {
            await aiLearner.performWinAutopsy({
              symbol: sym,
              setup: state.setup || 'unknown',
              direction: state.isLong ? 'LONG' : 'SHORT',
              session: aiLearner.getCurrentSession(),
              marketStructure: state.marketStructure || 'unknown',
              vwapZone: state.vwapZone || null,
            });
          }

          // Trigger systematic pattern analysis every 50 trades
          const countRes = await require('./db').query('SELECT COUNT(*) as c FROM ai_trades');
          const totalTrades = parseInt(countRes[0].c);
          if (totalTrades > 0 && totalTrades % 50 === 0) {
            bLog.ai(`Periodic AI Maintenance: analyzing worst patterns (Trade #${totalTrades})`);
            await aiLearner.analyzeWorstPatterns();
          }

          log(`AI recorded: ${sym} PnL=${pnlPct.toFixed(2)}% duration=${durationMin}min setup=${state.setup}`);

          // Record ChartAgent outcome for self-learning
          if (state.setup && state.setup.startsWith('ChartAI')) {
            const { recordOutcome } = require('./chart-agent-memory');
            recordOutcome(sym, state.isLong ? 'LONG' : 'SHORT', state.entry, exitPrice, pnlPct).catch(() => {});
          }

          // Notify agents of trade outcome (for survival HP + capital tracking)
          if (_onTradeOutcome) {
            const tradeQty = Math.abs(parseFloat(state.qty || 0));
            const pnlUsdt = parseFloat(((pnlPct / 100) * exitPrice * tradeQty).toFixed(4)) || 0;
            try {
              _onTradeOutcome({ symbol: sym, direction: state.isLong ? 'LONG' : 'SHORT', status: winLoss, pnlUsdt, structure: state.marketStructure });
              bLog.trade(`Survival updated: ${sym} ${winLoss} pnl=$${pnlUsdt.toFixed(4)}`);
            } catch (_) {}
          }

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
              marketStructure: st.marketStructure || null,
              vwapZone: st.vwapZone || null,
              exitReason: 'structure_break_15m',
              comboId: st.comboId || 15,
            });

            if (gain < 0) {
              await aiLearner.performLossAutopsy({
                symbol: sym, setup: st.setup || 'unknown',
                direction: isLong ? 'LONG' : 'SHORT',
                session: aiLearner.getCurrentSession(),
                marketStructure: st.marketStructure || 'unknown',
                vwapZone: st.vwapZone || null,
              });
            } else {
              await aiLearner.performWinAutopsy({
                symbol: sym, setup: st.setup || 'unknown',
                direction: isLong ? 'LONG' : 'SHORT',
                session: aiLearner.getCurrentSession(),
                marketStructure: st.marketStructure || 'unknown',
                vwapZone: st.vwapZone || null,
              });
            }
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
                marketStructure: st.marketStructure || null,
                vwapZone: st.vwapZone || null,
                exitReason: 'spike_tp',
              });
              await aiLearner.performWinAutopsy({
                symbol: sym, setup: st.setup || 'unknown',
                direction: isLong ? 'LONG' : 'SHORT',
                session: aiLearner.getCurrentSession(),
                marketStructure: st.marketStructure || 'unknown',
                vwapZone: st.vwapZone || null,
              });
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

      // ── Trailing SL step check (v4 tier ladder) ─────────────
      let trailResult;
      {
        const lev      = state.leverage || 20;
        const lastStep = state.lastStep || 0;
        const step = calculateTrailingStep(state.entry, cur, state.isLong, lastStep, lev);
        if (step && step.newSlPrice) {
          const betterSl = state.isLong
            ? step.newSlPrice > (state.trailingSlPrice || 0)
            : step.newSlPrice < (state.trailingSlPrice || Infinity);
          trailResult = betterSl ? { newSlPrice: step.newSlPrice, newLastStep: step.newLastStep } : null;
        } else {
          trailResult = null;
        }
      }

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

      // TP1 hit: close 30% (not 50% — let winners run), SL -> break even
      if (!state.tpHit1) {
        const tp1Hit = isLong ? cur >= state.tp1 : cur <= state.tp1;
        if (tp1Hit) {
          state.tpHit1 = true;
          const closeQty = floorQ(origQty * 0.30); // 30% not 50%
          // SL moves to entry + small profit buffer (not exact BE — gives room)
          const bePad = isLong ? state.entry * 1.001 : state.entry * 0.999; // 0.1% above/below entry
          const newSl = fmtP(bePad);
          log(`TP1 hit ${sym} @ $${fmtPrice(cur)}: closing 30%, SL -> BE+0.1%`);
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
            `*TP1 Hit!* — *${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `30% secured @ \`$${fmtPrice(cur)}\`\n` +
            `SL -> BE+buffer | 70% riding → TP2: \`$${fmtPrice(state.tp2)}\``
          );
          continue;
        }
      }

      // TP2 hit: close 40% more (total 70% taken), SL -> halfway between entry and TP1
      if (state.tpHit1 && !state.tpHit2) {
        const tp2Hit = isLong ? cur >= state.tp2 : cur <= state.tp2;
        if (tp2Hit) {
          state.tpHit2 = true;
          const closeQty = floorQ(origQty * 0.40); // 40% not 25%
          // SL moves to midpoint between entry and TP1 (locks meaningful profit)
          const midSl = (state.entry + state.tp1) / 2;
          const newSl = fmtP(midSl);
          log(`TP2 hit ${sym} @ $${fmtPrice(cur)}: closing 40%, SL -> mid(entry,TP1)`);
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
            `*TP2 Hit!* — *${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
            `40% secured @ \`$${fmtPrice(cur)}\` (70% total taken)\n` +
            `SL locked at profit | Riding 30% → TP3: \`$${fmtPrice(state.tp3)}\``
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

  // ── Maintenance & Sync ───────────────────────────────────────
  const now = Date.now();
  if (!lastBitunixSync || now - lastBitunixSync > 12 * 60 * 60 * 1000) {
    bLog.info('Running periodic Bitunix trade history sync...');
    try {
      const { AccountantAgent } = require('./agents/accountant-agent');
      const accAgent = new AccountantAgent();
      const syncResult = await accAgent.syncBitunixHistory();
      lastBitunixSync = now;
      bLog.info(`Bitunix Sync Complete: ${syncResult.synced} new, ${syncResult.updated} updated`);
    } catch (e) {
      bLog.error(`Bitunix sync loop failed: ${e.message}`);
    }
  }


  log('=== AI Smart Trader v4 Cycle Start ===');
  const hasOwnerKeys = !!(API_KEY && API_SECRET);

  try {
    const { query: dbQuery, initAllTables } = require('./db');
    await initAllTables();

    // One-time: enforce backtest-tuned leverage in token_leverage table.
    //   BTC/ETH      → 100x  (proven WR ≥ 55% on the momentum backtest)
    //   SOL/BNB/XRP  →  50x  (100x makes the v3 initial SL 0.2 % price,
    //                          which is inside 1m noise; 50x widens to
    //                          0.4 % and materially improves WR/PF)
    if (!runCycle._leverageFixDone) {
      runCycle._leverageFixDone = true;
      try {
        for (const [sym, lev] of Object.entries(SYMBOL_LEVERAGE)) {
          await dbQuery(
            `INSERT INTO token_leverage (symbol, leverage, enabled)
             VALUES ($1, $2, true)
             ON CONFLICT (symbol) DO UPDATE SET leverage = $2, enabled = true`,
            [sym, lev]
          );
        }
        bLog.system('[LEVERAGE-FIX] BTC/ETH=100x, SOL/BNB/XRP=50x written to token_leverage');
      } catch (e) {
        bLog.error(`[LEVERAGE-FIX] Failed to update token_leverage: ${e.message}`);
      }
    }

    // Disable the consecutive-loss pause — the strategy's SL trail IS the risk manager.
    // Reset max_consec_loss to 0 (disabled) so no key gets stuck paused after 2 losses.
    if (!runCycle._consecLossFixDone) {
      runCycle._consecLossFixDone = true;
      try {
        const r = await dbQuery(
          `UPDATE api_keys SET max_consec_loss = 0
           WHERE max_consec_loss IS DISTINCT FROM 0`
        );
        bLog.system(`[CONSEC-LOSS-FIX] max_consec_loss = 0 (disabled) on ${r.rowCount ?? '?'} keys — SL trail handles risk`);
      } catch (e) {
        bLog.error(`[CONSEC-LOSS-FIX] Failed: ${e.message}`);
      }
    }

    // One-time diagnostic: dump all API keys on first cycle after deploy
    if (!runCycle._keyDiagDone) {
      runCycle._keyDiagDone = true;
      try {
        const allDbKeys = await dbQuery(
          `SELECT ak.id, ak.user_id, ak.enabled, ak.paused_by_admin, ak.paused_by_user, ak.exchange, u.email
           FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id ORDER BY ak.id`
        );
        bLog.system(`[KEY-DIAG] ALL ${allDbKeys.length} api_keys: ${allDbKeys.map(k => `#${k.id} ${k.email || 'NO-USER(uid='+k.user_id+')'} ex=${k.exchange||'?'} en=${k.enabled} ap=${k.paused_by_admin} up=${k.paused_by_user}`).join(' | ')}`);
      } catch (_) {}
    }
    const topNRows = await dbQuery('SELECT MAX(top_n_coins) as max_n FROM api_keys WHERE enabled = true');
    const topNCoins = parseInt(topNRows[0]?.max_n) || 50;

    // ── Kronos AI Batch Scan: only the 4 watchlist tokens ──────
    let kronosPredictions = null;
    try {
      const kronos = require('./kronos');

      // Only scan the 5 coins we actually trade — no top-volume sweep
      const topSymbols = ACTIVE_SYMBOLS;

      bLog.ai(`Kronos batch scan starting: ${topSymbols.join(', ')}`);
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

    // ── Strategy Scans — ACTIVE execution ──
    // 1) V4 SMC: VWAP 2σ zones + 15m/1m BOS/CHoCH confluence (89.6% WR, 7-day backtest)
    //    Rules: bull swTrend=+1 → LONG only | bear swTrend=-1 → SHORT only | ranging=0 → nothing
    // 2) ChartAgent: Claude reads VWAP slope, EQ levels, structure like a human trader
    // Both feed the same signal pipeline. Dedup by symbol keeps only the highest score.
    const signals = [];
    try {
      const rawV4 = await scanV4SMC(msg => bLog.scan(msg));
      if ((rawV4 || []).length > 0) {
        signals.push(...rawV4);
        bLog.scan(`V4-SMC: ${rawV4.length} signal(s) → ${rawV4.map(s => `${s.symbol} ${s.side} (${s.signalType})`).join(', ')}`);
      }
    } catch (tErr) {
      bLog.error(`V4-SMC scan failed: ${tErr.message}`);
    }

    try {
      const rawCA = await scanChartAgent(ACTIVE_SYMBOLS, msg => bLog.scan(msg));
      if ((rawCA || []).length > 0) {
        signals.push(...rawCA);
        bLog.scan(`ChartAgent: ${rawCA.length} signal(s) → ${rawCA.map(s => `${s.symbol} ${s.side}`).join(', ')}`);
      }
    } catch (caErr) {
      bLog.error(`ChartAgent scan failed: ${caErr.message}`);
    }

    if (!signals.length) {
      log('No AI signals found this cycle — agents still learning.');

      if (hasOwnerKeys) {
        const client = getClient();
        await checkTrailingStop(client);
      }
      return;
    }

    // Deduplicate signals by symbol — only the highest-scored signal per symbol per cycle.
    // Multiple strategies (e.g. LiqSweep + SLHunt) can both fire on BNB in the same scan.
    // Without this, executeForAllUsers gets called twice for BNB → two trades per user.
    const seenSignalSymbols = new Map(); // symbol → best signal
    for (const pick of signals) {
      const sym = pick.symbol || pick.sym;
      if (!sym) continue;
      const existing = seenSignalSymbols.get(sym);
      if (!existing || (pick.score || 0) > (existing.score || 0)) {
        seenSignalSymbols.set(sym, pick);
      }
    }
    const dedupedSignals = Array.from(seenSignalSymbols.values());
    if (dedupedSignals.length < signals.length) {
      bLog.trade(`Signal dedup: ${signals.length} → ${dedupedSignals.length} (removed ${signals.length - dedupedSignals.length} duplicate-symbol signals)`);
    }

    let executed = false;
    for (const pick of dedupedSignals) {
      log(`Signal: ${pick.symbol} ${pick.direction} score=${pick.score} setup=${pick.setupName} AI=${pick.aiModifier ?? 'n/a'}`);
      bLog.trade(`TRYING: ${pick.symbol} ${pick.direction} | setup=${pick.setupName} score=${pick.score} | TP=${pick.tp1 ? `$${fmtPrice(pick.tp1)}` : 'trailing'} SL=$${fmtPrice(pick.sl)} | RR=1:1.5`);

      // Check global token ban
      if (await isTokenBanned(pick.symbol || pick.sym)) {
        bLog.trade(`${pick.symbol} is globally banned — skipping`);
        continue;
      }

      // Backtest gate DISABLED per user direction.
      // Reasoning: the gate blocks any strategy whose 30-day historical
      // WR is below 50 %, which silenced the bot entirely while no
      // active strategy crossed 50 %. The user prefers to trade on the
      // live structure rules (15m+1m HL/LH, counter-trend filter,
      // 10-bar range pos, pause gate, leverage-aware trail) and accept
      // losing windows while the optimizer keeps tuning. The auto-
      // activate path (PR #77) still kicks in when the optimizer finds
      // a >= 50% strategy — at which point the live gates simply align
      // with that historical edge.
      //
      // To re-enable, uncomment the block below.
      //
      // try {
      //   const backtestGate = require('./backtest-gate');
      //   const gateSym = pick.symbol || pick.sym;
      //   const gateStrategy = pick.setupName || pick.setup || 'ALL';
      //   const signalWr = pick.strategyWinRate || 0;
      //   const gatePasses = await backtestGate.passesGate(gateSym, gateStrategy, undefined, signalWr);
      //   if (!gatePasses) {
      //     bLog.trade(`BACKTEST GATE BLOCKED: ${gateSym} ${gateStrategy} — WR below ${backtestGate.MIN_WIN_RATE}%`);
      //     continue;
      //   }
      //   bLog.trade(`BACKTEST GATE PASSED: ${gateSym} ${gateStrategy}`);
      // } catch (gateErr) {
      //   bLog.error(`Backtest gate error: ${gateErr.message} — blocking trade for safety`);
      //   continue;
      // }

      // AI Brain veto removed — ChartAgent already IS the AI analysis layer.
      // Double-checking ChartAgent with another AI just blocks good signals.
      try {
        const { isAvailable } = require('./agents/ai-brain');
        if (isAvailable()) bLog.ai(`AI Brain available (not used — ChartAgent handles analysis)`);
      } catch (aiErr) {
        // optional — ignore
      }

      // Final EMA200 safety gate — belt-and-suspenders check before any trade fires
      // isMomentumBreakout bypasses — flash crashes start while EMA200 still shows prior trend
      if (!pick.isMomentumBreakout && pick.ema200Bias === 'bullish' && pick.direction === 'SHORT') {
        bLog.trade(`FINAL GATE BLOCKED: ${pick.symbol} SHORT rejected — price above EMA200 (bullish bias)`);
        continue;
      }
      if (!pick.isMomentumBreakout && pick.ema200Bias === 'bearish' && pick.direction === 'LONG') {
        bLog.trade(`FINAL GATE BLOCKED: ${pick.symbol} LONG rejected — price below EMA200 (bearish bias)`);
        continue;
      }

      bLog.trade(`Executing trade: ${pick.symbol} ${pick.direction} for registered users...`);
      const result = await executeForAllUsers(pick);

      if (result === 'ALL_TOO_EXPENSIVE') {
        bLog.trade(`${pick.symbol} too expensive for all users — trying next signal...`);
        continue;
      }
      executed = true;
      // Continue processing remaining signals so ALL users get a trade opportunity.
      // Users who already traded are protected by: max_positions, dedup guard, open trade check.
    }
    // Owner account handled via executeForAllUsers (DB keys with pause/enabled checks)
    // No separate owner path — all accounts go through the same pipeline

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

  // Sync trades + trailing SL for all users (including owner via DB) every cycle
  await syncTradeStatus();
  await checkUsdtTopups();

  // Also check owner tradeState positions (Binance direct / not stored in DB)
  try {
    if (API_KEY && API_SECRET && tradeState.size > 0) await checkTrailingStop(getClient());
  } catch (e) { bLog.error(`End-of-cycle trailing check: ${e.message}`); }

  log('=== Cycle End ===');
}

function getClient() {
  return new USDMClient({ api_key: API_KEY, api_secret: API_SECRET }, getBinanceRequestOptions());
}

// ── TRADE OPEN LOCK ─────────────────────────────────────────
// Process-level guard: prevents two concurrent execution paths (main cycle +
// agent coordinator running at the same time) from both opening the same
// trade before the first DB INSERT commits.
const _openTradeInProgress = new Set(); // key: `${userId}:${symbol}`

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
    // NOTE: Auto-pause for payment overdue was removed — it silently blocked users who registered
    // more than 7 days ago. Payment enforcement is handled explicitly via the admin panel.

    // One-time: clear any paused_by_admin flags set by the old auto-pause logic,
    // and reset last_paid_at for admin accounts so they're never caught by any payment check.
    if (!executeForAllUsers._unpauseDone) {
      executeForAllUsers._unpauseDone = true;
      try {
        const unpaused = await db.query(
          `UPDATE api_keys SET paused_by_admin = false
           WHERE paused_by_admin = true AND paused_by_user = false
           RETURNING id, user_id`
        );
        if (unpaused.length > 0) {
          bLog.trade(`[UNBLOCK] Cleared auto-pause on ${unpaused.length} key(s) — were blocked by payment-overdue logic. Keys: ${unpaused.map(k => `#${k.id}`).join(', ')}`);
        }
        // Keep admin accounts' last_paid_at current so they're always clear
        await db.query(`UPDATE users SET last_paid_at = NOW() WHERE is_admin = true`);
        bLog.trade('[UNBLOCK] Admin accounts: last_paid_at refreshed — no subscription required');
      } catch (e) {
        bLog.error(`[UNBLOCK] Failed to clear auto-pauses: ${e.message}`);
      }
    }

    // Diagnostic: show ALL api_keys with status every 10 cycles so admin can see why users are skipped
    executeForAllUsers._diagCount = (executeForAllUsers._diagCount || 0) + 1;
    if (executeForAllUsers._diagCount === 1 || executeForAllUsers._diagCount % 10 === 0) {
      try {
        const allDbKeys = await db.query(
          `SELECT ak.id, ak.user_id, ak.enabled, ak.paused_by_admin, ak.paused_by_user, ak.platform, u.email
           FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id ORDER BY ak.id`
        );
        bLog.trade(`[DIAG] ALL api_keys (${allDbKeys.length}): ${allDbKeys.map(k => `#${k.id} ${k.email || 'NO-USER(uid='+k.user_id+')'} platform=${k.platform||'NULL'} en=${k.enabled} ap=${k.paused_by_admin} up=${k.paused_by_user}`).join(' | ')}`);
      } catch (diagErr) {
        bLog.error(`[DIAG] Failed: ${diagErr.message}`);
      }
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
      // Debug + auto-fix: check WHY no keys are found
      try {
        const debugKeys = await db.query(
          `SELECT ak.id, u.email, ak.enabled, ak.paused_by_admin, ak.paused_by_user
           FROM api_keys ak JOIN users u ON u.id = ak.user_id`
        );
        if (debugKeys.length > 0) {
          const reasons = debugKeys.map(k => `${k.email}(enabled=${k.enabled} admin_pause=${k.paused_by_admin} user_pause=${k.paused_by_user})`);
          bLog.trade(`No tradeable keys — all ${debugKeys.length} keys blocked: ${reasons.join(', ')}`);

          // Auto-fix: if ALL keys are disabled (not paused), re-enable them
          const allDisabled = debugKeys.every(k => k.enabled === false && !k.paused_by_admin && !k.paused_by_user);
          if (allDisabled) {
            await db.query(`UPDATE api_keys SET enabled = true`);
            bLog.trade(`AUTO-FIX: Re-enabled all ${debugKeys.length} API keys (all were disabled without pause flags)`);
          }
        } else {
          bLog.trade('No API keys in database at all');
        }
      } catch (_) {}
      return;
    }

    // Also check for orphan keys (api_keys without matching users row)
    try {
      const orphanKeys = await db.query(
        `SELECT ak.id, ak.user_id, ak.enabled, ak.paused_by_admin, ak.paused_by_user
         FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id
         WHERE u.id IS NULL`
      );
      if (orphanKeys.length > 0) {
        bLog.trade(`WARNING: ${orphanKeys.length} orphan API key(s) with no matching user record — ids: ${orphanKeys.map(k => `key=${k.id} user_id=${k.user_id}`).join(', ')}`);
      }
    } catch (_) {}

    const keys = allKeys;
    const sym = pick.symbol || pick.sym;

    // ── HARD WHITELIST: Only 5 coins ever reach the exchange ──────────────────
    const TRADE_WHITELIST = new Set(ACTIVE_SYMBOLS);
    if (!TRADE_WHITELIST.has(sym)) {
      bLog.trade(`BLOCKED: ${sym} is not in the 5-coin whitelist — trade cancelled`);
      return;
    }

    const userEmails = [...new Set(keys.map(k => k.email))].join(', ');
    bLog.trade(`Found ${keys.length} unique API key(s) — executing ${sym} ${pick.direction} for: ${userEmails}`);
    log(`Executing ${sym} ${pick.direction} for ${keys.length} user keys: ${userEmails}`);

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

        // Dedup guard: skip if this USER+symbol was already executed this cycle (across all their keys).
        // Use user_id not key.id — a user with 3 keys should only get 1 trade per signal.
        const dedupKey = `user:${key.user_id}:${symbol}`;
        if (executedUserSymbols.has(dedupKey)) {
          userLog.trade(`User ${key.email}: ${symbol} already executed for this user this cycle — skipping extra key`);
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

        // Process-level lock: blocks concurrent opens for same user+symbol before DB INSERT commits.
        const openLockKey = `${key.user_id}:${symbol}`;
        if (_openTradeInProgress.has(openLockKey)) {
          userLog.trade(`User ${key.email}: ${symbol} trade open already in progress — skipping concurrent duplicate`);
          return;
        }
        _openTradeInProgress.add(openLockKey);

        // Check DB for existing open trade on same SYMBOL for this USER (across ALL their keys).
        // Previously checked api_key_id only — if a user has 3 keys, all 3 would open the same trade.
        const existingTrade = await db.query(
          `SELECT id FROM trades WHERE user_id = $1 AND symbol = $2 AND status = 'OPEN' LIMIT 1`,
          [key.user_id, symbol]
        );
        if (existingTrade.length > 0) {
          _openTradeInProgress.delete(openLockKey);
          userLog.trade(`User ${key.email}: already has OPEN trade on ${symbol} (user-wide check) — skipping duplicate`);
          return;
        }

        // No cooldown — the 3-tier confluence (VWAP + H1 + H1-micro) and ChartAgent
        // AI analysis are the quality filter. Blocking re-entry after a loss means
        // missing the recovery move. The trailing SL handles risk on each trade.

        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        const maxPos = parseInt(key.max_positions) || 5;

        const price = pick.lastPrice || pick.price || pick.entry;
        const isLong = pick.direction !== 'SHORT';

        // ── Read ALL user settings from DB ──
        const userLev = await getTokenLeverage(symbol, key.id, price);
        if (userLev === null) {
          userLog.trade(`User ${key.email}: ${symbol} has no token configuration — skipped`);
          return;
        }

        // Consecutive-loss pause is disabled — max_consec_loss = 0.
        // The trailing SL system manages per-trade risk. Blocking after losses
        // means missing the recovery move. Strategy confluence is the quality gate.

        // User's risk settings — active AI version can override SL/trail if admin activated one
        const walletSizePct = (await getCapitalPercentage(key.id)) / 100;
        const activeVer = await getActiveVersionParams();

        // Direction enable/disable — if active version disables a direction, skip this trade
        if (activeVer) {
          const enableL = activeVer.enableLong  !== false && activeVer.enableLong  !== 'false';
          const enableS = activeVer.enableShort !== false && activeVer.enableShort !== 'false';
          if (isLong  && !enableL) { userLog.trade(`User ${key.email}: ${symbol} LONG disabled by active version — skipping`); return; }
          if (!isLong && !enableS) { userLog.trade(`User ${key.email}: ${symbol} SHORT disabled by active version — skipping`); return; }
        }

        // Per-direction SL/TP/Trail: use direction-specific value if set, else use global value, else hardcoded default
        const dirSlKey    = isLong ? 'slPctLong'    : 'slPctShort';
        const dirTpKey    = isLong ? 'tpPctLong'    : 'tpPctShort';
        const dirTrailKey = isLong ? 'trailStepLong' : 'trailStepShort';

        const globalSl    = activeVer?.slPct     != null ? parseFloat(activeVer.slPct)     : null;
        const globalTp    = activeVer?.tpPct     != null ? parseFloat(activeVer.tpPct)     : null;
        // Active version stores trail as price % fraction (e.g. 0.012 = 1.2% price).
        // calculateTrailingStep expects capital % as a plain number (e.g. 1.2 = 1.2% capital).
        // Convert: price fraction × 100 → percentage number. 0.012 → 1.2
        const rawGlobalTrail = activeVer?.trailStep != null ? parseFloat(activeVer.trailStep) : null;
        const globalTrail    = rawGlobalTrail != null ? rawGlobalTrail * 100 : null;

        const dirSl  = activeVer?.[dirSlKey]  != null && parseFloat(activeVer[dirSlKey])  > 0 ? parseFloat(activeVer[dirSlKey])  : globalSl;
        const dirTp  = activeVer?.[dirTpKey]  != null && parseFloat(activeVer[dirTpKey])  > 0 ? parseFloat(activeVer[dirTpKey])  : globalTp;
        const rawDirTrail = activeVer?.[dirTrailKey] != null && parseFloat(activeVer[dirTrailKey]) > 0
          ? parseFloat(activeVer[dirTrailKey]) * 100  // price fraction → capital %
          : globalTrail;
        const dirTrail = rawDirTrail;

        const userMaxLoss = parseFloat(key.max_loss_usdt) || 0;
        // Trail step: direction-specific → active version global → api_key setting → hardcoded default
        // key.trailing_sl_step is already stored as capital % (e.g. 1.2 = 1.2% capital per step)
        const userTrailStep = dirTrail ?? parseFloat(key.trailing_sl_step) ?? 1.2;

        // SL price distance = SL_PCT / leverage (gross; fees accepted on top)
        // 100x: 0.15/100 = 0.15% price → ~23% total loss incl. fees — well under 50%
        let slPricePct = dirSl != null ? dirSl : (SL_PCT / userLev);
        const tpPricePct = dirTp != null && dirTp > 0 ? dirTp : (TP_PCT / userLev);

        // Liquidation guard
        const maxSlPct = (1 / userLev) * 0.80;
        if (slPricePct > maxSlPct) {
          userLog.trade(`User ${key.email}: SL clamped from ${(slPricePct*100).toFixed(3)}% to ${(maxSlPct*100).toFixed(3)}% (liq guard at ${userLev}x)`);
          slPricePct = maxSlPct;
        }

        const initialSlPrice = isLong ? price * (1 - slPricePct) : price * (1 + slPricePct);
        const userTpPrice = isLong ? price * (1 + tpPricePct) : price * (1 - tpPricePct);
        const userTp3Price = isLong ? price * (1 + tpPricePct * 2.0) : price * (1 - tpPricePct * 2.0);

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

          userLog.trade(`User ${key.email} Binance: wallet=$${rawWallet.toFixed(2)} pos=${openPosCount}/${maxPos} lev=x${userLev} SL=${(slPricePct*100).toFixed(2)}%price TP=${(tpPricePct*100).toFixed(2)}%price`);

          // Range Bounce: use signal's range-wall SL + hard TP at opposite wall
          // Other strategies: fixed 30% margin SL, no hard TP (trailing handles exit)
          const isRangeBounce = pick.setup === 'RANGE_BOUNCE';
          const slPrice = (isRangeBounce && pick.sl) ? pick.sl : initialSlPrice;
          const bnTpPrice = (isRangeBounce && pick.tp1) ? pick.tp1 : null;

          try { await userClient.setLeverage({ symbol, leverage: userLev }); } catch (_) {}
          try { await userClient.setMarginType({ symbol, marginType: 'ISOLATED' }); } catch (e) { if (!e.message?.includes('No need')) throw e; }

          const info = await userClient.getExchangeInfo();
          const sinfo = info.symbols.find(s => s.symbol === symbol);
          if (!sinfo) { userLog.error(`User ${key.email}: ${symbol} not found on Binance`); return; }
          const qtyPrec = sinfo.quantityPrecision ?? 6;
          const pricePrec = sinfo.pricePrecision ?? 2;
          const fmtP = (p) => parseFloat(p.toFixed(pricePrec));

          // Position sizing: walletSizePct of wallet, adjusted by AI hour learning, capped by max_loss
          const sizeMod = pick.sizeMod || 1.0;
          let tradeUsdt = wallet * walletSizePct * sizeMod;
          if (sizeMod !== 1.0) userLog.trade(`User ${key.email}: AI hour sizing ${sizeMod < 1 ? 'reduced' : 'boosted'} ×${sizeMod}`);
          // Cap by max loss: if user sets max loss per trade, limit margin so SL loss <= max_loss
          if (userMaxLoss > 0) {
            const maxMarginByLoss = userMaxLoss / slPricePct;
            if (tradeUsdt > maxMarginByLoss) {
              userLog.trade(`User ${key.email}: capping margin $${tradeUsdt.toFixed(2)} → $${maxMarginByLoss.toFixed(2)} (max loss $${userMaxLoss})`);
              tradeUsdt = maxMarginByLoss;
            }
          }
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

          // Mark dedup immediately after order — before DB INSERT so DB failure can't cause a second trade.
          executedUserSymbols.add(dedupKey);

          await sleep(1500);

          const closeSide = isLong ? 'SELL' : 'BUY';
          const slFmt = fmtP(slPrice);
          const tpNote = bnTpPrice ? ` TP=$${fmtP(bnTpPrice)} (hard close at range wall)` : ` TP target $${fmtP(userTpPrice)} (+${(TP_PCT*100).toFixed(0)}% margin) — trailing rides higher`;
          userLog.trade(`Setting SL=$${slFmt} for ${symbol} —${tpNote}...`);

          let slOk = false;

          try {
            await userClient.submitNewAlgoOrder({
              algoType: 'CONDITIONAL', symbol, side: closeSide,
              type: 'STOP_MARKET', triggerPrice: slFmt,
              closePosition: 'true', workingType: 'MARK_PRICE',
            });
            slOk = true;
          } catch (e) {
            userLog.error(`SL algo failed for ${symbol}: ${e.message}`);
          }

          // Range Bounce: set hard TP at opposite range wall
          if (bnTpPrice) {
            try {
              await userClient.submitNewAlgoOrder({
                algoType: 'CONDITIONAL', symbol, side: closeSide,
                type: 'TAKE_PROFIT_MARKET', triggerPrice: fmtP(bnTpPrice),
                closePosition: 'true', workingType: 'MARK_PRICE',
              });
              userLog.trade(`TP set at $${fmtP(bnTpPrice)} (opposite range wall) for ${symbol}`);
            } catch (e) {
              userLog.error(`Range TP failed for ${symbol}: ${e.message}`);
            }
          }

          if (!slOk) {
            userLog.error(`${symbol} OPEN without SL — SET MANUALLY!`);
            await notify(`*${symbol} ${pick.direction}*\nPosition opened but *SL failed to set!*\nSet manually on Binance NOW.`);
          }

          const bnTpRef = bnTpPrice ?? fmtP(userTpPrice);
          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
             trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m, market_structure, key_trailing_sl_step, setup)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13, $14, $15, $16)`,
            [key.id, key.user_id, symbol, pick.direction, price, fmtP(slPrice), bnTpRef, qty, userLev,
             fmtP(slPrice),
             null, pick.structure?.tf3m || null, pick.structure?.tf1m || null,
             pick.marketStructure || null, userTrailStep,
             pick.setupName || pick.setup || null]
          );
          userLog.trade(`Binance OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty} entry=$${fmtPrice(price)} SL=$${fmtPrice(slPrice)} ${bnTpPrice ? `TP=$${fmtPrice(bnTpPrice)}` : `TP(ref)=$${fmtPrice(userTpPrice)}`}`);
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

          // Position sizing: walletSizePct of wallet, adjusted by AI hour learning, capped by max_loss
          let tradeUsdtBx = wallet * walletSizePct * (pick.sizeMod || 1.0);
          if (userMaxLoss > 0) {
            const maxMarginByLoss = userMaxLoss / slPricePct;
            if (tradeUsdtBx > maxMarginByLoss) {
              userLog.trade(`User ${key.email}: capping margin $${tradeUsdtBx.toFixed(2)} → $${maxMarginByLoss.toFixed(2)} (max loss $${userMaxLoss})`);
              tradeUsdtBx = maxMarginByLoss;
            }
          }
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

          const isTripleMA    = pick.setup === 'TRIPLE_MA_A' || pick.setup === 'TRIPLE_MA_B';
          const isScenarioA   = pick.setup === 'TRIPLE_MA_A';
          const isScenarioB   = pick.setup === 'TRIPLE_MA_B';
          const isRangeBounce = pick.setup === 'RANGE_BOUNCE';

          // Range Bounce: SL at range wall ± 0.5% (tight), hard TP at opposite wall
          // Triple MA Scenario A: SL from signal, TP at +3.5%
          // Triple MA Scenario B: no hard SL, trailing only
          // All other strategies: fixed 30% margin SL, trailing handles exit
          const slPrice = isScenarioB ? null
            : (isRangeBounce && pick.sl) ? pick.sl
            : (isScenarioA   && pick.sl) ? pick.sl
            : initialSlPrice;

          try { await userClient.changeMarginMode(symbol, 'ISOLATION'); } catch (_) {}
          try { await userClient.changeLeverage(symbol, userLev); } catch (_) {}

          // Scenario B is now MARKET on RSI<30 + BB lower touch (no longer 50% crash-buy)
          const bxOrderType  = 'MARKET';
          const bxLimitPrice = undefined;

          // TP: Range Bounce uses hard TP at opposite wall, Scenario A at +3.5%, others none
          const bxEntryRef = price;
          let bxTpPrice = null;
          if ((isScenarioA || isRangeBounce) && pick.tp1) {
            bxTpPrice = parseFloat(parseFloat(pick.tp1).toFixed(8));
          }

          const slFmtBx = slPrice ? parseFloat(slPrice.toFixed(8)) : null;

          userLog.trade(`User ${key.email}: placing Bitunix ${bxOrderType} ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty}${slFmtBx ? ` SL=$${slFmtBx}` : ' (no SL)'}${bxTpPrice ? ` TP=$${bxTpPrice}` : ''} setup=${pick.setup || 'SMC'}...`);

          const orderPayload = {
            symbol, side: isLong ? 'BUY' : 'SELL',
            qty: String(qty), orderType: bxOrderType, tradeSide: 'OPEN',
          };
          if (bxLimitPrice)                               orderPayload.price = String(bxLimitPrice);
          if (bxTpPrice && (isScenarioA || isRangeBounce)) { orderPayload.tpPrice = String(bxTpPrice); orderPayload.tpOrderType = 'MARKET'; orderPayload.tpStopType = 'MARK_PRICE'; }

          const order = await userClient.placeOrder(orderPayload);
          userLog.trade(`Bitunix order placed: ${JSON.stringify(order)}`);

          // Mark dedup immediately after order — before DB INSERT.
          // Prevents a second key from opening the same trade if INSERT later fails.
          executedUserSymbols.add(dedupKey);

          await sleep(2000);
          const posRaw = await userClient.getOpenPositions(symbol);
          // Handle bare array OR wrapped response (positionList / list)
          const posArr = Array.isArray(posRaw) ? posRaw
            : (posRaw?.positionList || posRaw?.list || (posRaw && typeof posRaw === 'object' ? [posRaw] : []));
          const pos = posArr.find(p => p.symbol === symbol);
          // Bitunix uses 'positionId' or 'id' depending on API version
          const posId = pos ? (pos.positionId || pos.id) : null;
          userLog.trade(`Bitunix position lookup: ${JSON.stringify(pos ? { id: posId, symbol: pos.symbol, side: pos.side, qty: pos.qty } : null)}`);

          if (pos && posId) {
            // Recalculate SL from actual entry price to avoid stale-price rejection
            const actualEntry = parseFloat(pos.avgOpenPrice || pos.entryPrice || pos.avgPrice) || price;

            let slFmtActual = null;
            if (!isTripleMA) {
              if (isRangeBounce && pick.sl) {
                // Range Bounce: SL is at the range wall — not relative to actual entry
                slFmtActual = parseFloat(parseFloat(pick.sl).toFixed(8));
              } else {
                // Normal SMC trades: recalculate SL from actual fill price
                const actualSlPrice = isLong
                  ? actualEntry * (1 - slPricePct)
                  : actualEntry * (1 + slPricePct);
                slFmtActual = parseFloat(actualSlPrice.toFixed(8));
              }
            }

            if (slFmtActual) {
              const tpNote = bxTpPrice ? ` TP=$${bxTpPrice} (hard close)` : '';
              userLog.trade(`Bitunix position confirmed: ${posId} entry=$${actualEntry} — setting SL=$${slFmtActual}${tpNote}...`);
              const tpSLPayload = { symbol, positionId: posId, slPrice: slFmtActual };
              if (bxTpPrice && (isScenarioA || isRangeBounce)) tpSLPayload.tpPrice = String(bxTpPrice);
              // Retry SL placement up to 3 times. Silent first-attempt
              // failures (rate limit, position not yet visible on exchange,
              // transient API hiccups) caused some users to end up with a
              // position that had NO SL order on Bitunix even though the
              // DB recorded one. Backoff 1s, 2s.
              let slPlaced = false;
              let slLastErr = '';
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  await userClient.placePositionTpSl(tpSLPayload);
                  slPlaced = true;
                  userLog.trade(`Bitunix SL set on ${posId} (attempt ${attempt}): SL=$${slFmtActual}${bxTpPrice ? ` TP=$${bxTpPrice}` : ''}`);
                  break;
                } catch (e) {
                  slLastErr = e.message;
                  userLog.error(`Bitunix SL attempt ${attempt}/3 FAILED: ${e.message}`);
                  if (attempt < 3) await sleep(attempt * 1000); // 1s, 2s backoff
                }
              }
              if (!slPlaced) {
                userLog.error(`Bitunix SL FAILED after 3 attempts: ${slLastErr} — SET MANUALLY`);
                await notify(`🚨 *Bitunix ${symbol} ${pick.direction}*\nSL FAILED 3× — *no SL on exchange*\nUser: ${key.email}\nEntry: $${actualEntry}\nIntended SL: $${slFmtActual}\n\`${slLastErr.substring(0,150)}\`\nSet SL on Bitunix NOW.`);
              }
            } else if ((isScenarioA || isRangeBounce) && bxTpPrice) {
              userLog.trade(`Bitunix: no SL — setting TP=$${bxTpPrice} only...`);
              try {
                await userClient.placePositionTpSl({ symbol, positionId: posId, tpPrice: String(bxTpPrice), tpOrderType: 'MARKET', tpStopType: 'MARK_PRICE' });
              } catch (e) {
                userLog.error(`Bitunix TP FAILED: ${e.message}`);
              }
            }

            const tpRef = (isScenarioA || isRangeBounce) && bxTpPrice
              ? bxTpPrice
              : isLong ? actualEntry * (1 + tpPricePct) : actualEntry * (1 - tpPricePct);

            await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
               trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m, market_structure, key_trailing_sl_step, bitunix_position_id, setup)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13, $14, $15, $16, $17)`,
              [key.id, key.user_id, symbol, pick.direction, actualEntry,
               slFmtActual || 0, parseFloat(tpRef.toFixed(8)), qty, userLev,
               slFmtActual || 0,
               null, pick.structure?.tf3m || null, pick.structure?.tf1m || null,
               pick.marketStructure || null, userTrailStep, posId || null,
               pick.setupName || pick.setup || null]
            );
          } else {
            userLog.error(`Bitunix position not found after order — verify on exchange`);
            await notify(`*Bitunix ${symbol}*\nOrder placed but position not found. Check Bitunix manually.`);

            await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
               trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m, market_structure, key_trailing_sl_step, setup)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13, $14, $15, $16)`,
              [key.id, key.user_id, symbol, pick.direction, price,
               parseFloat(slPrice.toFixed(8)), 0, qty, userLev, parseFloat(slPrice.toFixed(8)),
               null, pick.structure?.tf3m || null, pick.structure?.tf1m || null,
               pick.marketStructure || null, userTrailStep,
               pick.setupName || pick.setup || null]
            );
          }
          userLog.trade(`Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty}`);
          log(`Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev}`);
        } else {
          userLog.error(`User ${key.email}: unknown platform "${key.platform}"`);
        }
      } catch (err) {
        userLog.error(`User ${key.email} trade error: ${err.message}`);
        log(`User ${key.email} trade error: ${err.message}`);
        // NOTE: not saving ERROR trades to DB — they pollute trade history with no useful data.
        // Errors are visible in bot logs already.
      } finally {
        // Always release the process-level lock so the next cycle can re-enter.
        _openTradeInProgress.delete(`${key.user_id}:${sym}`);
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

        // Hedge-mode safe: key positions by symbol+side so a LONG and a
        // SHORT (or duplicate fills) on the same symbol don't collapse.
        const posKey = (sym, dir) => `${sym}:${dir}`;
        let openSymbols = new Map();

        if (key.platform === 'binance') {
          const userClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
          const account = await userClient.getAccountInformation({ omitZeroBalances: false });
          for (const p of account.positions) {
            const amt = parseFloat(p.positionAmt);
            if (amt === 0) continue;
            const dir = amt > 0 ? 'LONG' : 'SHORT';
            openSymbols.set(posKey(p.symbol, dir), {
              amt,
              pnl: parseFloat(p.unrealizedProfit || 0),
              entryPrice: parseFloat(p.entryPrice || 0),
            });
          }

          // ── Swarm-based Dynamic Exit ─────────────────────────────────────
          // Check if the swarm consensus has shifted against our positions
          for (const trade of trades) {
            const exchangePos = openSymbols.get(posKey(trade.symbol, trade.direction || 'LONG'));
            if (exchangePos) {
              try {
                const { runSwarm } = require('./agents/swarm-engine');
                // Fetch minimal seeds for a quick swarm check
                const seeds = {
                  current: exchangePos.entryPrice, // simplified for exit check
                  indicators: {},
                  pred_high: 0, pred_low: 0, trend: 'unknown'
                };
                const swarm = await runSwarm(trade.symbol, seeds);

                // Skip dynamic exit if swarm has no valid votes (all agents failed)
                if (!swarm.totalVotes || swarm.totalVotes === 0 || swarm.confidence === 0) {
                  continue;
                }

                let shouldExit = false;
                if (trade.direction === 'LONG' && swarm.direction === 'SHORT' && swarm.confidence >= 60) {
                  shouldExit = true;
                } else if (trade.direction === 'SHORT' && swarm.direction === 'LONG' && swarm.confidence >= 60) {
                  shouldExit = true;
                }

                if (shouldExit) {
                  bLog.trade(`DYNAMIC EXIT: Swarm shift detected for ${trade.symbol} (${trade.direction}). Consensus: ${swarm.direction} (${swarm.confidence}%). Closing position.`);
                  const closeSide = trade.direction === 'LONG' ? 'SELL' : 'BUY';
                  await userClient.createOrder({
                    symbol: trade.symbol,
                    side: closeSide,
                    type: 'MARKET',
                    quantity: Math.abs(exchangePos.amt),
                    reduceOnly: true
                  });
                  await db.query(`UPDATE trades SET status = 'CLOSED', exit_reason = 'swarm_consensus_shift', closed_at = NOW() WHERE id = $1`, [trade.id]);
                  await notify(`📉 *Dynamic AI Exit*\n${trade.symbol} ${trade.direction} closed early due to Swarm shift to ${swarm.direction} (${swarm.confidence}% confidence).`);
                  continue; // Move to next trade, position is now closed
                }
              } catch (e) {
                bLog.error(`Swarm dynamic exit failed for ${trade.symbol}: ${e.message}`);
              }
            }
          }

          // Check trailing SL for open positions
          for (const trade of trades) {
            const exchangePos = openSymbols.get(posKey(trade.symbol, trade.direction || 'LONG'));
            if (exchangePos && trade.trailing_sl_last_step !== undefined) {
              const entryPrice = parseFloat(trade.entry_price);
              const isLong = trade.direction !== 'SHORT';
              const curPrice = exchangePos.entryPrice && exchangePos.pnl !== undefined
                ? (isLong ? entryPrice + (exchangePos.pnl / (Math.abs(exchangePos.amt) || 1))
                          : entryPrice - (exchangePos.pnl / (Math.abs(exchangePos.amt) || 1)))
                : entryPrice;
              const lastStep = parseFloat(trade.trailing_sl_last_step) || 0;
              const tradeLev = parseFloat(trade.leverage) || 20;
              const userTrailPct = parseFloat(trade.key_trailing_sl_step) || 0;
              const pricePctDebug = isLong
                ? (curPrice - entryPrice) / entryPrice
                : (entryPrice - curPrice) / entryPrice;
              const capitalPctDebug = pricePctDebug * tradeLev;
              const binSlPrec = inferPricePrec(trade.sl_price);
              const currentSlBin = parseFloat(trade.trailing_sl_price) || parseFloat(trade.sl_price) || 0;
              bLog.trade(`Binance trail check: ${trade.symbol} cur=$${fmtPrice(curPrice)} entry=$${entryPrice} pricePct=${(pricePctDebug*100).toFixed(3)}% capitalPct=${(capitalPctDebug*100).toFixed(2)}% lev=${tradeLev}x currentSL=$${currentSlBin.toFixed(binSlPrec)}`);

              // ── Candle-low trail: move SL to last completed 15m candle low/high ──
              let binNewSl = null;
              let binSlSource = '';
              const binCandleTrail = await calcCandleTrailSl(trade.symbol, isLong, currentSlBin);
              if (binCandleTrail && pricePctDebug > 0.002) {
                binNewSl = binCandleTrail.newSl;
                binSlSource = binCandleTrail.source;
              }

              // ── Fallback: tier-based if candle trail didn't fire ──
              if (!binNewSl) {
                const smcNow = getSessionMode(Date.now()) === 'smc';
                const trailResult = calculateTrailingStep(entryPrice, curPrice, isLong, lastStep, tradeLev, userTrailPct, smcNow);
                if (trailResult) { binNewSl = trailResult.newSlPrice; binSlSource = 'tier'; }
              }

              if (binNewSl) {
                const closeSide = isLong ? 'SELL' : 'BUY';
                bLog.trade(`Binance trailing SL (${binSlSource}): ${trade.symbol} → newSL=$${binNewSl.toFixed(binSlPrec)}`);
                let slUpdated = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                  try {
                    const userTp = parseFloat(trade.tp_price) || 0;
                    slUpdated = await updateStopLoss(userClient, trade.symbol, binNewSl, closeSide, 'binance', binSlPrec, userTp || undefined);
                    if (slUpdated) break;
                  } catch (e) {
                    bLog.error(`WATCHDOG: Binance SL update failed for ${trade.symbol} attempt ${attempt}/3: ${e.message}`);
                    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
                  }
                }
                if (slUpdated) {
                  const tierRes = binSlSource === 'tier'
                    ? calculateTrailingStep(entryPrice, curPrice, isLong, lastStep, tradeLev, 0, smcNow)
                    : null;
                  await db.query(
                    `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2 WHERE id = $3`,
                    [binNewSl, tierRes ? tierRes.newLastStep : lastStep, trade.id]
                  );
                  bLog.trade(`✓ Binance trailing SL (${binSlSource}): ${trade.symbol} SL=$${binNewSl.toFixed(binSlPrec)}`);
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
            const amt = parseFloat(p.positionAmt || 0);
            if (!amt) continue;
            const dir = amt > 0 ? 'LONG' : 'SHORT';
            openSymbols.set(posKey(p.symbol, dir), {
              amt,
              pnl: parseFloat(p.unrealizedProfit || 0),
              markPrice: p.markPrice ? parseFloat(p.markPrice) : null,
            });
          }

          // ── Unmanaged-position detector (hedge-mode safety) ──────
          // Warn when a Bitunix position has no matching OPEN DB trade by
          // (symbol, direction). Triggered by manual trades on the same key
          // or by another tool/script. Deduped per (symbol+side+entry) per
          // process so we don't spam alerts each sync tick.
          syncTradeStatus._alertedUnmanaged = syncTradeStatus._alertedUnmanaged || new Set();
          for (const p of (account.positions || [])) {
            const amt = parseFloat(p.positionAmt || 0);
            if (!amt) continue;
            const dir = amt > 0 ? 'LONG' : 'SHORT';
            const matched = trades.some(t =>
              t.symbol === p.symbol && (t.direction || 'LONG') === dir
            );
            if (matched) continue;
            const entry = parseFloat(p.entryPrice || 0);
            const dedupKey = `${key.id}:${p.symbol}:${dir}:${entry}`;
            if (syncTradeStatus._alertedUnmanaged.has(dedupKey)) continue;
            syncTradeStatus._alertedUnmanaged.add(dedupKey);
            bLog.system(`UNMANAGED POSITION: Bitunix ${p.symbol} ${dir} qty=${Math.abs(amt)} entry=$${entry} — not opened by bot`);
            await notify(
              `⚠️ *Unmanaged Position*\n` +
              `${p.symbol} *${dir}* (Bitunix)\n` +
              `Entry: \`$${entry}\`  Qty: ${Math.abs(amt)}\n` +
              `Not opened by the bot — manual or external.\n` +
              `The bot will not trail/manage this position.`
            );
          }

          // ── SL re-confirm sweep (self-heal missing initial SL) ──
          // Some users had positions opened where the original SL placement
          // failed silently — DB had the SL price but no order on Bitunix.
          // For each trade still on initial SL (trailing_sl_last_step == 0),
          // re-call updateStopLoss once per process. Bitunix treats this
          // idempotently: it updates an existing SL or creates one if
          // missing. Cached in _slConfirmed so we only retry once per
          // trade.id per process — once trailing kicks in (lastStep > 0)
          // the trail logic re-sets the SL on every improvement anyway.
          syncTradeStatus._slConfirmed = syncTradeStatus._slConfirmed || new Set();
          for (const trade of trades) {
            const tradeDir = trade.direction || 'LONG';
            const exchangePos = openSymbols.get(posKey(trade.symbol, tradeDir));
            if (!exchangePos) continue;
            const lastStep = parseFloat(trade.trailing_sl_last_step) || 0;
            if (lastStep > 0) continue;
            const sealKey = `${trade.id}`;
            if (syncTradeStatus._slConfirmed.has(sealKey)) continue;
            const slPrice = parseFloat(trade.sl_price);
            if (!slPrice) continue;
            const slPrec = inferPricePrec(trade.sl_price);
            try {
              const ok = await updateStopLoss(userClient, trade.symbol, slPrice, null, 'bitunix', slPrec, parseFloat(trade.tp_price) || undefined);
              if (ok) {
                syncTradeStatus._slConfirmed.add(sealKey);
                bLog.system(`✓ Bitunix SL re-confirmed for ${trade.symbol} ${tradeDir} (key=${key.email}): $${slPrice}`);
              } else {
                bLog.error(`Bitunix SL re-confirm returned false for ${trade.symbol} ${tradeDir} (key=${key.email})`);
              }
            } catch (e) {
              bLog.error(`Bitunix SL re-confirm threw for ${trade.symbol} ${tradeDir}: ${e.message}`);
            }
          }

          // Check trailing SL for Bitunix positions (self-healing)
          bLog.system(`Bitunix trailing SL: checking ${trades.length} trade(s), ${openSymbols.size} live position(s): [${[...openSymbols.keys()].join(',')}]`);
          for (const trade of trades) {
            const tradeDir = trade.direction || 'LONG';
            const exchangePos = openSymbols.get(posKey(trade.symbol, tradeDir));
            if (!exchangePos) {
              bLog.system(`Bitunix trailing SL: ${trade.symbol} ${tradeDir} not in openSymbols — skipping trail (position may be closed)`);
            }
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

              // Legacy TRIPLE_MA / SPIKE_HL trail/exit blocks removed — those
              // strategies are no longer used as signal sources, and any
              // remaining open trades with those market_structure tags will
              // fall through to the standard v3 trailing logic below.
              const bxSlPrec = inferPricePrec(trade.sl_price);
              const currentSl = parseFloat(trade.trailing_sl_price) || parseFloat(trade.sl_price) || 0;
              const bxProfitPct = isLong
                ? (curPrice - entryPrice) / entryPrice
                : (entryPrice - curPrice) / entryPrice;
              bLog.trade(`Bitunix trail check: ${trade.symbol} cur=$${fmtPrice(curPrice)} entry=$${entryPrice} pricePct=${(bxProfitPct*100).toFixed(3)}% capitalPct=${(bxProfitPct*tradeLev*100).toFixed(2)}% lev=${tradeLev}x currentSL=$${currentSl.toFixed(bxSlPrec)}`);

              // ── Bitunix trailing SL calculation ──────────────────────────────
              // Rules:
              //   • Only fire once profit is meaningful (>= 0.5% price from entry, i.e. ~10% capital at 20x)
              //   • SL must be at least MIN_TRAIL_DIST below current price (Bitunix rejects closer)
              //   • SL can never go backwards (only improves vs current SL)
              //   • Lock in progressively more profit as price climbs
              //
              // Strategy: trail at TRAIL_LOCK_BEHIND (0.5% of current price) behind current price,
              // but no closer than MIN_TRAIL_DIST.  This fires reliably and Bitunix always accepts it.
              const MIN_TRAIL_DIST  = 0.005;  // 0.5% from current price minimum (exchange requirement)
              const TRAIL_LOCK_PCT  = 0.008;  // lock SL 0.8% behind current price for LONG

              let newSlPrice = null;
              let slSource = '';
              let tierLastStep = null;

              // ── Tier-based trail (TRAILING_TIERS, capital %) ──────
              // +21%→+20%, +31%→+30%, +41%→+40%, ... regardless of leverage.
              // The previous price-based gate (0.5% price = 50% capital at
              // 100x) never fired at the user's requested +21% capital
              // milestone on high-leverage trades. This path uses capital%
              // so 100x ETH at +21% locks +20% the same as 20x BTC at +21%.
              const lastStepCap  = parseFloat(trade.trailing_sl_last_step) || 0;
              const smcNow       = getSessionMode(Date.now()) === 'smc';
              const tierResult   = calculateTrailingStep(entryPrice, curPrice, isLong, lastStepCap, tradeLev, 0, smcNow);
              if (tierResult) {
                const tierSl = tierResult.newSlPrice;
                // Reject if SL would be on the wrong side of current price
                // (immediate trigger). Real-world: at 100x +21% peak, +20%
                // lock is 0.01% price below current — fine. Edge case:
                // price retraced below the lock level → skip and let the
                // fallback handle it.
                const validSide = isLong ? tierSl < curPrice : tierSl > curPrice;
                const wouldImprove = isLong ? tierSl > currentSl : tierSl < currentSl;
                if (validSide && wouldImprove) {
                  newSlPrice    = tierSl;
                  slSource      = `tier+${Math.round(tierResult.newLastStep * 100)}%`;
                  tierLastStep  = tierResult.newLastStep;
                }
              }

              // ── Fallback: 0.8% behind current price ─────────────
              // Only runs if tier trail didn't produce an improvement
              // (e.g. capital < +21% so calculateTrailingStep returned null).
              if (!newSlPrice && bxProfitPct >= 0.005) {
                const rawTrailSl = isLong
                  ? curPrice * (1 - TRAIL_LOCK_PCT)
                  : curPrice * (1 + TRAIL_LOCK_PCT);

                // Enforce minimum distance from current price
                const minSl = isLong
                  ? curPrice * (1 - MIN_TRAIL_DIST)
                  : curPrice * (1 + MIN_TRAIL_DIST);
                const candidateSl = isLong
                  ? Math.min(rawTrailSl, minSl)   // LONG: SL must be ≤ minSl (further from current)
                  : Math.max(rawTrailSl, minSl);

                // Must improve current SL (never go backwards)
                const wouldImprove = isLong
                  ? candidateSl > currentSl
                  : candidateSl < currentSl;

                if (wouldImprove) {
                  newSlPrice = candidateSl;
                  slSource = 'price_trail';
                }
              }

              // ── Candle-low fallback: use 15m candle low if it's better ──
              const candleTrail = await calcCandleTrailSl(trade.symbol, isLong, currentSl);
              if (candleTrail) {
                const candidateCandle = candleTrail.newSl;
                // Candle trail must also respect minimum distance
                const candleTooClose = isLong
                  ? candidateCandle > curPrice * (1 - MIN_TRAIL_DIST)
                  : candidateCandle < curPrice * (1 + MIN_TRAIL_DIST);
                if (!candleTooClose) {
                  const candleImproves = isLong
                    ? candidateCandle > (newSlPrice || currentSl)
                    : candidateCandle < (newSlPrice || currentSl);
                  if (candleImproves && bxProfitPct > 0.002) {
                    newSlPrice = candidateCandle;
                    slSource = candleTrail.source;
                  }
                }
              }

              if (!newSlPrice) {
                bLog.trade(`Bitunix trail: ${trade.symbol} no improvement (capitalPct=${(bxProfitPct*tradeLev*100).toFixed(1)}% currentSL=$${currentSl.toFixed(bxSlPrec)}) — skipping`);
                continue;
              }
              bLog.trade(`Bitunix trailing SL (${slSource}): ${trade.symbol} → newSL=$${newSlPrice.toFixed(bxSlPrec)}`);
              await notify(`🔧 *Trail SL*\n${trade.symbol} ${isLong ? 'LONG' : 'SHORT'}\n+${(bxProfitPct*tradeLev*100).toFixed(1)}% capital\nSL → \`$${newSlPrice.toFixed(bxSlPrec)}\` (was $${currentSl.toFixed(bxSlPrec)})\ncur=$${curPrice.toFixed(bxSlPrec)}`);

              // ── Update SL on exchange (retry up to 3 times) ──
              let slUpdated = false;
              let slLastError = '';
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  const existingTp = parseFloat(trade.tp_price) || 0;
                  slUpdated = await updateStopLoss(userClient, trade.symbol, newSlPrice, null, 'bitunix', bxSlPrec, existingTp || undefined);
                  if (slUpdated) break;
                  slLastError = 'updateStopLoss returned false';
                  bLog.error(`WATCHDOG: updateStopLoss returned false for ${trade.symbol} (attempt ${attempt}/3)`);
                } catch (e) {
                  slLastError = e.message;
                  bLog.error(`WATCHDOG: updateStopLoss failed for ${trade.symbol} attempt ${attempt}/3: ${e.message}`);
                  if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
                }
              }

              if (slUpdated) {
                // Store the tier's lock level when tier-trail fired (so the
                // tier table doesn't re-trigger the same step); otherwise
                // store the raw capital % so future tier comparisons still
                // know how far we've already trailed.
                const newLastStep = tierLastStep != null ? tierLastStep : (bxProfitPct * tradeLev);
                await db.query(
                  `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2 WHERE id = $3`,
                  [newSlPrice, newLastStep, trade.id]
                );
                bLog.trade(`✓ Trailing SL (Bitunix/${slSource}): ${trade.symbol} SL=$${newSlPrice.toFixed(bxSlPrec)}`);
                await notify(
                  `📈 *Trailing SL Moved*\n` +
                  `*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                  `SL → \`$${newSlPrice.toFixed(bxSlPrec)}\` (${slSource})`
                );
              } else {
                bLog.error(`WATCHDOG ALERT: Failed to set trailing SL for ${trade.symbol} after 3 attempts! Last error: ${slLastError}`);
                await notify(
                  `🚨 *TRAILING SL FAILED*\n` +
                  `*${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                  `Profit: +${(bxProfitPct*tradeLev*100).toFixed(1)}% capital\n` +
                  `SL=$${newSlPrice.toFixed(bxSlPrec)} (${slSource})\n` +
                  `Error: \`${slLastError.substring(0, 150)}\`\n` +
                  `⚠️ Check position manually!`
                );
              }
            }
          }
        }

        bLog.system(`Sync: exchange has ${openSymbols.size} open positions, DB has ${trades.length} OPEN trades`);

        for (const trade of trades) {
          const exchangePos = openSymbols.get(posKey(trade.symbol, trade.direction || 'LONG'));

          if (!exchangePos) {
            // Position closed on exchange — find the exit price
            const entryPrice = parseFloat(trade.entry_price);
            const qty = parseFloat(trade.quantity || 0);
            const isLong = trade.direction !== 'SHORT';
            let exitPrice = entryPrice;
            let realizedPnl = null;
            let tradingFee = 0;
            let fundingFee = 0;

            if (key.platform === 'binance') {
              try {
                const binClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
                // Get fills after the trade was opened
                const openTime = trade.created_at ? new Date(trade.created_at).getTime() : Date.now() - 86400000;
                const fills = await binClient.getAccountTrades({ symbol: trade.symbol, startTime: openTime, limit: 50 });
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
              // foundPnl: position history matched and gave us PnL data but closePrice=0.
              // We still need to find exit price via Method 2 (order history).
              let foundPnl = false;
              const tradeOpenTime = trade.created_at ? new Date(trade.created_at).getTime() : 0;
              const tradeEntry = parseFloat(trade.entry_price);
              const tradeSideLong = trade.direction !== 'SHORT';
              // Hoist positionId so both Method 1 and Method 2 can use it
              const storedPosId = trade.bitunix_position_id;

              // Method 1: Position history
              // Priority: match by positionId (stored at open) → entry price + time fallback
              // NOTE: Bitunix sometimes returns closePrice=0. We still extract PnL/fee data
              // from the matched record — exit price will be found in Method 2 if missing.
              try {
                const positions = await bxClient.getHistoryPositions({ symbol: trade.symbol, pageSize: 50 });
                if (positions.length > 0) {
                  bLog.system(`[SYNC] Bitunix raw position[0]: ${JSON.stringify(positions[0])}`);
                }

                let bestMatch = null;
                let bestTimeDiff = Infinity;

                for (const p of positions) {
                  const ep  = parseFloat(p.entryPrice  || p.avgOpenPrice   || p.openPrice   || p.open_price  || 0);
                  const pid = p.positionId || p.id || p.position_id || '';
                  const pSide = (p.side || p.positionSide || p.position_side || '').toUpperCase();
                  const pSideLong = pSide === 'LONG' || pSide === 'BUY';
                  const closeMs = parseInt(p.closeTime || p.mtime || p.ctime || p.updateTime || p.close_time || 0);

                  // Filter by symbol and side only — don't filter on closePrice (may be 0)
                  if (p.symbol !== trade.symbol || pSideLong !== tradeSideLong) continue;

                  // ID match = definitive, use immediately
                  if (storedPosId && String(pid) === String(storedPosId)) {
                    bestMatch = p;
                    break;
                  }

                  // Entry price within 0.5% AND closed after trade opened
                  const entryMatch = ep > 0 && Math.abs(ep - tradeEntry) / tradeEntry < 0.005;
                  const closedAfterOpen = !tradeOpenTime || !closeMs || closeMs >= tradeOpenTime;
                  if (entryMatch && closedAfterOpen) {
                    const timeDiff = closeMs && tradeOpenTime ? Math.abs(closeMs - tradeOpenTime) : 9e12;
                    if (timeDiff < bestTimeDiff) { bestTimeDiff = timeDiff; bestMatch = p; }
                  }
                }

                if (bestMatch) {
                  const p = bestMatch;
                  const cp  = parseFloat(p.closePrice  || p.avgClosePrice  || p.closedPrice || p.close_price || 0);
                  const ep  = parseFloat(p.entryPrice  || p.avgOpenPrice   || p.openPrice   || p.open_price  || 0);
                  tradingFee  = Math.abs(parseFloat(p.fee          || p.tradingFee  || p.commission || 0));
                  fundingFee  = Math.abs(parseFloat(p.funding      || p.fundingFee  || p.fund_fee   || 0));
                  const pnlRaw = p.realizedPNL ?? p.realizedPnl ?? p.pnl ?? p.profit ?? p.realPnl ?? null;
                  realizedPnl = pnlRaw != null ? parseFloat(pnlRaw) : null;

                  if (cp > 0) {
                    // Have both exit price and PnL — fully resolved
                    exitPrice = cp;
                    found = true;
                    bLog.system(`[SYNC] MATCH trade#${trade.id} ${trade.symbol}: entry=${ep} exit=${cp} pnl=${realizedPnl} fee=${tradingFee} funding=${fundingFee}`);
                  } else {
                    // Position matched, PnL extracted, but closePrice=0 from Bitunix.
                    // Method 2 will supply the exit price from order fill data.
                    foundPnl = realizedPnl !== null;
                    bLog.system(`[SYNC] MATCH(no price) trade#${trade.id} ${trade.symbol}: entry=${ep} pnl=${realizedPnl} fee=${tradingFee} — seeking exit from orders`);
                  }
                } else {
                  bLog.system(`[SYNC] NO MATCH trade#${trade.id} ${trade.symbol} entry=${tradeEntry} — ${positions.length} positions checked`);
                }
              } catch (e) { bLog.error(`[SYNC] Bitunix posHistory error: ${e.message}`); }

              // Method 2: Order history — CLOSE orders.
              // Runs when Method 1 gave no exit price (closePrice=0 or no match at all).
              // Uses positionId for precise matching when available.
              if (!found) {
                try {
                  const orderList = await bxClient.getHistoryOrders({ symbol: trade.symbol, pageSize: 50 });
                  for (const o of orderList) {
                    const oPrice = parseFloat(o.avgPrice || o.price || 0);
                    const isClose = o.reduceOnly || o.tradeSide === 'CLOSE' || (o.effect || '').toUpperCase() === 'CLOSE';
                    const oMs = parseInt(o.ctime || o.mtime || 0);
                    const posIdMatch = storedPosId && String(o.positionId || '') === String(storedPosId);
                    const timeMatch = !tradeOpenTime || !oMs || oMs > tradeOpenTime;

                    if (isClose && oPrice > 0 && (posIdMatch || timeMatch)) {
                      exitPrice = oPrice;
                      bLog.system(`[SYNC] Bitunix orderHistory: ${trade.symbol} | ${JSON.stringify({
                        avgPrice: o.avgPrice, price: o.price, realizedPNL: o.realizedPNL,
                        profit: o.profit, pnl: o.pnl, fee: o.fee, tradeSide: o.tradeSide,
                        reduceOnly: o.reduceOnly, positionId: o.positionId, qty: o.qty
                      })}`);
                      // Only pull PnL from order if Method 1 didn't already set it
                      if (!foundPnl) {
                        const profit = o.profit    != null ? parseFloat(o.profit)       : null;
                        const pnl    = o.pnl       != null ? parseFloat(o.pnl)          : null;
                        const rpnl   = o.realizedPNL != null ? parseFloat(o.realizedPNL) : null;
                        if      (profit != null && profit !== 0) realizedPnl = profit;
                        else if (pnl    != null && pnl    !== 0) realizedPnl = pnl;
                        else if (rpnl   != null && rpnl   !== 0) realizedPnl = rpnl;
                      }
                      found = true;
                      bLog.system(`[SYNC] orderHistory RESULT: ${trade.symbol} exit=${exitPrice} net=${realizedPnl}`);
                      break;
                    }
                  }
                } catch (e) { bLog.error(`Bitunix histOrders error: ${e.message}`); }
              }

              // Method 3: Current market price as last resort (only when all history APIs fail)
              if (!found) {
                try {
                  const mp = await bxClient.getMarketPrice(trade.symbol);
                  if (mp > 0) exitPrice = mp;
                } catch (e) { bLog.error(`Bitunix marketPrice error: ${e.message}`); }
              }

              // Guard: if ALL methods returned nothing meaningful, re-check open positions
              // before writing a LOSS. A momentary Bitunix API timeout can make an open
              // position temporarily invisible — falsely closing destroys commission records.
              if (realizedPnl === null && exitPrice === entryPrice) {
                try {
                  const recheckRaw = await bxClient.getOpenPositions();
                  const recheckList = Array.isArray(recheckRaw)
                    ? recheckRaw
                    : (recheckRaw?.positionList || recheckRaw?.list || []);
                  const stillOpen = recheckList.some(p => {
                    const ep = parseFloat(p.avgOpenPrice || p.entryPrice || p.openPrice || 0);
                    return (p.symbol || '').toUpperCase() === trade.symbol.toUpperCase()
                      && ep > 0
                      && Math.abs(ep - entryPrice) / entryPrice < 0.005;
                  });
                  if (stillOpen) {
                    bLog.trade(`[SYNC] Re-check: ${trade.symbol} IS still open — aborting false closure`);
                    continue; // Skip — position is still live, don't write LOSS to DB
                  }
                  bLog.trade(`[SYNC] Re-check confirmed ${trade.symbol} is truly closed — proceeding`);
                } catch (e) {
                  // Re-check failed — be conservative and defer rather than falsely close
                  bLog.error(`[SYNC] Re-check failed for ${trade.symbol}: ${e.message} — deferring to next cycle`);
                  continue;
                }
              }
            }

            // PnL calculation:
            // Bitunix: use exchange data exactly as returned — no price math
            //   realizedPnl = NET (exchange already deducted fees + funding)
            //   tradingFee + fundingFee = what exchange charged
            //   grossPnl = net + fee + funding (simple add-back, no price calculation)
            // Binance: realizedPnl = GROSS, so net = gross - fees
            // Fallback (no exchange data): estimate from price × qty
            let grossPnl;
            let pnlUsdt;
            if (realizedPnl !== null && key.platform === 'bitunix') {
              // Use Bitunix data as-is — no math
              pnlUsdt   = parseFloat(realizedPnl.toFixed(4));
              grossPnl  = parseFloat((realizedPnl + tradingFee + fundingFee).toFixed(4));
            } else if (realizedPnl !== null) {
              // Binance: realizedPnl is GROSS
              grossPnl = parseFloat(realizedPnl.toFixed(4));
              pnlUsdt  = parseFloat((realizedPnl - tradingFee - fundingFee).toFixed(4));
            } else {
              // No exchange data — fall back to price × qty estimate
              grossPnl = isLong
                ? parseFloat(((exitPrice - entryPrice) * qty).toFixed(4))
                : parseFloat(((entryPrice - exitPrice) * qty).toFixed(4));
              if (tradingFee === 0 && fundingFee === 0) {
                const notional = exitPrice * qty;
                tradingFee = parseFloat((notional * 0.0012).toFixed(4)); // 0.12% round trip estimate
                bLog.trade(`Estimated fee ${trade.symbol}: $${tradingFee} (0.12% of $${notional.toFixed(2)})`);
              }
              pnlUsdt = parseFloat((grossPnl - tradingFee - fundingFee).toFixed(4));
            }
            tradingFee = parseFloat(tradingFee.toFixed(4));
            fundingFee = parseFloat(fundingFee.toFixed(4));
            grossPnl = parseFloat(grossPnl.toFixed(4));
            const status = pnlUsdt > 0 ? 'WIN' : 'LOSS';

            await db.query(
              `UPDATE trades SET status = $1, pnl_usdt = $2, exit_price = $3, closed_at = NOW(),
               trading_fee = $5, gross_pnl = $6, funding_fee = $7
               WHERE id = $4`,
              [status, pnlUsdt, exitPrice, trade.id, tradingFee, grossPnl, fundingFee]
            );
            bLog.trade(`DB synced: ${trade.symbol} -> ${status} gross=$${grossPnl} fee=$${tradingFee} funding=$${fundingFee} net=$${pnlUsdt} exit=$${fmtPrice(exitPrice)}`);

            // Notify agents of trade outcome (for survival system)
            if (_onTradeOutcome) {
              try { _onTradeOutcome({ symbol: trade.symbol, direction: trade.direction, status, pnlUsdt, structure: trade.market_structure }); } catch (_) {}
            }

            // Record token daily result
            try {
              const { recordTokenResult } = require('./token-scanner');
              await recordTokenResult(trade.symbol, pnlUsdt, tradingFee, pnlUsdt > 0);
            } catch (_) {}

            // Record profit split for any profitable close (WIN or trail-closed with positive net)
            if (pnlUsdt > 0) {
              await recordProfitSplit(db, trade.user_id, trade.api_key_id, pnlUsdt, trade.symbol);
            }

            // RPG: XP and Point Distribution System
            try {
              const { getCoordinator } = require('./agents');
              const coord = getCoordinator();
              const tokenKey = trade.symbol.toLowerCase().replace('usdt', '');
              const tokenAgent = coord._agents.get(tokenKey);

              // 1. Point Distribution (New Economy Logic)
              if (pnlUsdt > 0) {
                // Credit (Wins)
                // Signal Discoverer (Chart): +10 pts
                if (coord.chartAgent) await coord.chartAgent.adjustPoints(10);
                // Signal Approver (Risk): +5 pts
                if (coord.riskAgent) await coord.riskAgent.adjustPoints(5);
                // Trade Executor (Trader): +2 pts
                if (coord.traderAgent) await coord.traderAgent.adjustPoints(2);

                // TP3 Hit multiplier (2x points)
                // We estimate TP3 hit if pnl is significantly high (e.g. > 2% absolute price move)
                const priceMove = Math.abs((exitPrice - entryPrice) / entryPrice);
                if (priceMove >= 0.02) {
                  if (coord.chartAgent) await coord.chartAgent.adjustPoints(10); // Extra 10
                  if (coord.riskAgent) await coord.riskAgent.adjustPoints(5);  // Extra 5
                }
              } else {
                // Blame (Losses): -5 pts for all involved
                if (coord.chartAgent) await coord.chartAgent.adjustPoints(-5);
                if (coord.riskAgent) await coord.riskAgent.adjustPoints(-5);
                if (coord.traderAgent) await coord.traderAgent.adjustPoints(-5);

                // RiskAgent Penalty: Harsh penalty if it was a "Trap Pattern"
                try {
                  const { getPatternPenalty } = require('./ai-learner');
                  const penalty = await getPatternPenalty(trade.symbol, trade.direction);
                  if (penalty > 0) {
                    if (coord.riskAgent) await coord.riskAgent.adjustPoints(-15);
                    bLog.trade(`Economy: RiskAgent penalized -15pts for approving trap pattern on ${trade.symbol}`);
                  }
                } catch (_) {}
              }

              // 2. Legacy XP System (Keep for consistency)
              if (pnlUsdt > 0) {
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

// ── BACKFILL FEES FROM BITUNIX API ───────────────────────────
// On startup: re-fetch real fee + PnL from Bitunix for ALL recent closed
// trades across ALL users. Fixes wrong/estimated values for every account.
async function backfillFeesFromBitunix() {
  let db, cryptoUtils, BitunixClient;
  try {
    db = require('./db');
    cryptoUtils = require('./crypto-utils');
    BitunixClient = require('./bitunix-client').BitunixClient;
  } catch (e) { return; }

  try {
    // Fetch ALL recent closed Bitunix trades across all users — no fee filter.
    // Re-syncing a correctly-synced trade is harmless (same value written back).
    // This catches: NULL fee, estimated fee, wrong pnl_usdt from price×qty estimate.
    const trades = await db.query(
      `SELECT t.id, t.symbol, t.direction, t.entry_price, t.exit_price,
              t.quantity, t.gross_pnl, t.pnl_usdt, t.trading_fee, t.created_at,
              t.api_key_id, t.bitunix_position_id,
              ak.api_key, ak.api_secret, ak.platform,
              u.email
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       JOIN users    u  ON u.id  = t.user_id
       WHERE t.status IN ('WIN','LOSS','CLOSED')
         AND ak.platform = 'bitunix'
         AND t.closed_at > NOW() - INTERVAL '60 days'
       ORDER BY t.closed_at DESC
       LIMIT 500`
    );

    if (!trades.length) {
      bLog.system('[FEE-BACKFILL] No recent closed Bitunix trades — nothing to do');
      return;
    }
    bLog.system(`[FEE-BACKFILL] Re-syncing ${trades.length} recent closed Bitunix trade(s) across all users`);

    // Group by api_key_id to minimise API calls
    const byKey = {};
    for (const t of trades) {
      if (!byKey[t.api_key_id]) byKey[t.api_key_id] = { apiKey: t.api_key, apiSecret: t.api_secret, trades: [] };
      byKey[t.api_key_id].trades.push(t);
    }

    let updated = 0;
    for (const [keyId, { apiKey, apiSecret, trades: keyTrades }] of Object.entries(byKey)) {
      let decryptedKey, decryptedSecret;
      try {
        decryptedKey    = cryptoUtils.decrypt(apiKey);
        decryptedSecret = cryptoUtils.decrypt(apiSecret);
      } catch { continue; }

      const bxClient = new BitunixClient({ apiKey: decryptedKey, apiSecret: decryptedSecret });

      // Fetch up to 200 history positions per unique symbol for this key
      const symbolsDone = new Set();
      const posCache = {};  // symbol → positions[]

      for (const trade of keyTrades) {
        if (!posCache[trade.symbol] && !symbolsDone.has(trade.symbol)) {
          try {
            posCache[trade.symbol] = await bxClient.getHistoryPositions({ symbol: trade.symbol, pageSize: 100 });
            bLog.system(`[FEE-BACKFILL] key#${keyId} ${trade.symbol}: ${posCache[trade.symbol].length} history positions`);
          } catch (e) {
            bLog.error(`[FEE-BACKFILL] key#${keyId} ${trade.symbol} fetch error: ${e.message}`);
            posCache[trade.symbol] = [];
          }
          symbolsDone.add(trade.symbol);
        }

        const positions = posCache[trade.symbol] || [];
        const tradeEntry = parseFloat(trade.entry_price);
        const tradeOpenMs = trade.created_at ? new Date(trade.created_at).getTime() : 0;
        const tradeSideLong = trade.direction !== 'SHORT';
        const storedPosId = trade.bitunix_position_id;

        // Find best matching position
        let bestMatch = null;
        let bestTimeDiff = Infinity;

        for (const p of positions) {
          const ep   = parseFloat(p.entryPrice || p.avgOpenPrice || p.openPrice || p.open_price || 0);
          const pid  = p.positionId || p.id || p.position_id || '';
          const pSide = (p.side || p.positionSide || p.position_side || '').toUpperCase();
          const pSideLong = pSide === 'LONG' || pSide === 'BUY';
          const closeMs = parseInt(p.closeTime || p.mtime || p.ctime || p.updateTime || p.close_time || 0);

          if ((p.symbol || '') !== trade.symbol || pSideLong !== tradeSideLong) continue;

          // positionId match = definitive
          if (storedPosId && String(pid) === String(storedPosId)) { bestMatch = p; break; }

          // Entry price within 0.5% AND closed after trade opened
          const entryMatch = ep > 0 && Math.abs(ep - tradeEntry) / tradeEntry < 0.005;
          const closedAfterOpen = !tradeOpenMs || !closeMs || closeMs >= tradeOpenMs;
          if (entryMatch && closedAfterOpen) {
            const diff = closeMs && tradeOpenMs ? Math.abs(closeMs - tradeOpenMs) : 9e12;
            if (diff < bestTimeDiff) { bestTimeDiff = diff; bestMatch = p; }
          }
        }

        if (!bestMatch) {
          bLog.system(`[FEE-BACKFILL] trade#${trade.id} ${trade.symbol}: no Bitunix match found`);
          continue;
        }

        const tradingFee = Math.abs(parseFloat(bestMatch.fee || bestMatch.tradingFee || bestMatch.commission || 0));
        const fundingFee = Math.abs(parseFloat(bestMatch.funding || bestMatch.fundingFee || bestMatch.fund_fee || 0));
        const pnlRaw = bestMatch.realizedPNL ?? bestMatch.realizedPnl ?? bestMatch.pnl ?? bestMatch.profit ?? bestMatch.realPnl ?? null;
        const netPnl = pnlRaw != null ? parseFloat(pnlRaw) : null;

        if (tradingFee === 0 && netPnl === null) {
          bLog.system(`[FEE-BACKFILL] trade#${trade.id} ${trade.symbol}: match found but fee=0 and no PnL — skipping`);
          continue;
        }

        // Bitunix: netPnl is already after fees. grossPnl = net + fee + funding.
        const grossPnl = netPnl != null
          ? parseFloat((netPnl + tradingFee + fundingFee).toFixed(4))
          : (trade.gross_pnl ? parseFloat(trade.gross_pnl) : null);
        const pnlUsdt = netPnl != null
          ? parseFloat(netPnl.toFixed(4))
          : (grossPnl != null ? parseFloat((grossPnl - tradingFee - fundingFee).toFixed(4)) : null);
        const status = pnlUsdt != null ? (pnlUsdt > 0 ? 'WIN' : 'LOSS') : null;

        await db.query(
          `UPDATE trades SET
             trading_fee = $1,
             funding_fee = $2,
             gross_pnl   = COALESCE($3, gross_pnl),
             pnl_usdt    = COALESCE($4, pnl_usdt),
             status      = COALESCE($5, status)
           WHERE id = $6`,
          [
            parseFloat(tradingFee.toFixed(4)),
            parseFloat(fundingFee.toFixed(4)),
            grossPnl,
            pnlUsdt,
            status,
            trade.id,
          ]
        );
        updated++;
        bLog.system(`[FEE-BACKFILL] trade#${trade.id} ${trade.email} ${trade.symbol}: fee=$${tradingFee.toFixed(4)} net=$${pnlUsdt ?? '?'} gross=$${grossPnl ?? '?'} status=${status ?? 'unchanged'}`);
      }
    }

    bLog.system(`[FEE-BACKFILL] Done — updated ${updated}/${trades.length} trades with real Bitunix fees`);
  } catch (err) {
    bLog.error(`[FEE-BACKFILL] error: ${err.message}`);
  }
}

// ── RECONCILE ORPHAN POSITIONS ───────────────────────────────
// On startup: fetch all live Bitunix positions and insert any that are
// missing from the DB. Prevents silent data loss when Railway restarts
// mid-INSERT, ensuring commission/PnL tracking always has a record.
async function reconcileOrphanPositions() {
  let db, cryptoUtils, BitunixClient;
  try {
    db = require('./db');
    cryptoUtils = require('./crypto-utils');
    BitunixClient = require('./bitunix-client').BitunixClient;
  } catch (e) { return; }

  try {
    const keys = await db.query(
      `SELECT ak.*, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true
         AND ak.platform = 'bitunix'`
    );

    if (!keys.length) return;

    let recovered = 0;

    for (const key of keys) {
      let apiKey, apiSecret;
      try {
        apiKey    = cryptoUtils.decrypt(key.api_key_enc,    key.iv,         key.auth_tag);
        apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv,  key.secret_auth_tag);
      } catch (e) {
        bLog.error(`[Reconcile] Failed to decrypt key #${key.id}: ${e.message}`);
        continue;
      }

      let positions = [];
      try {
        const client = new BitunixClient({ apiKey, apiSecret });
        const raw = await client.getOpenPositions();
        positions = Array.isArray(raw) ? raw : [];
      } catch (e) {
        bLog.error(`[Reconcile] Failed to fetch positions for key #${key.id}: ${e.message}`);
        continue;
      }

      for (const pos of positions) {
        const symbol    = (pos.symbol || '').toUpperCase();
        const qty       = parseFloat(pos.qty || pos.positionAmt || 0);
        const leverage  = parseFloat(pos.leverage || 20);
        const entry     = parseFloat(pos.avgOpenPrice || pos.entryPrice || pos.openPrice || 0);
        const side      = (pos.side || '').toUpperCase();
        const direction = (side === 'BUY' || side === 'LONG') ? 'LONG' : 'SHORT';
        const positionId = pos.positionId || pos.id || null;

        if (!symbol || !entry || !qty) continue;

        // Check if this position already has an OPEN trade record
        const existing = await db.query(
          `SELECT id FROM trades
           WHERE api_key_id = $1 AND symbol = $2 AND status = 'OPEN'
           LIMIT 1`,
          [key.id, symbol]
        );

        if (existing.length > 0) continue; // already tracked

        // Insert a recovery record so the trade is trackable
        const slGuess = direction === 'LONG'
          ? entry * (1 - 0.30 / leverage)
          : entry * (1 + 0.30 / leverage);

        await db.query(
          `INSERT INTO trades
             (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price,
              quantity, leverage, status, trailing_sl_price, trailing_sl_last_step,
              market_structure, bitunix_position_id)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 'OPEN', $6, 0, 'RECOVERED', $9)`,
          [key.id, key.user_id, symbol, direction, entry,
           parseFloat(slGuess.toFixed(8)), qty, leverage, positionId]
        );

        recovered++;
        bLog.system(`[Reconcile] RECOVERED orphan: ${symbol} ${direction} ${leverage}x entry=$${entry} qty=${qty} (key #${key.id} ${key.email})`);
        await notify(
          `🔄 *Trade Recovered* (restart reconcile)\n` +
          `${symbol} ${direction} ${leverage}x\n` +
          `Entry: $${entry} | Qty: ${qty}\n` +
          `SL estimate: $${slGuess.toFixed(4)}\n` +
          `_Was missing from DB — added as RECOVERED_`
        ).catch(() => {});
      }
    }

    if (recovered > 0) {
      bLog.system(`[Reconcile] Inserted ${recovered} orphan position(s) into DB`);
    } else {
      bLog.system(`[Reconcile] All live positions accounted for in DB`);
    }
  } catch (err) {
    bLog.error(`[Reconcile] reconcileOrphanPositions error: ${err.message}`);
  }
}

async function run() {
  log(`AI Smart Trader v4 | Telegram: ${!!TELEGRAM_TOKEN} | Chats: ${PRIVATE_CHATS.join(', ') || 'NONE'}`);
  await syncTradeStatus();
  await reconcileOrphanPositions();
  await backfillFeesFromBitunix();
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
  reconcileOrphanPositions,
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
  SL_PCT, TP_PCT, TRAILING_TIERS,
  getTrailingSLConfig,
  tradeState,
  onTradeOutcome,
  fireTradeOutcome,
};
