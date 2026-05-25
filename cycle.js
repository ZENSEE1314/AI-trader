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
const { scanV4SMC, ACTIVE_SYMBOLS, SYMBOL_LEVERAGE, SYMBOL_SL_PCT } = require('./strategy-v4-smc');
const { scanHommaSMC } = require('./strategy-homma-smc');
// Keep 3-timing import for calcTrail3Timing + getSessionMode (still used elsewhere)
const { getSessionMode } = require('./strategy-3timing'); // v4: trailing SL uses calculateTrailingStep (cycle.js) instead of calcTrail3Timing

const { getSentimentScores } = require('./sentiment-scraper');
const { log: bLog } = require('./bot-logger');
const { getBinanceRequestOptions, getFetchOptions } = require('./proxy-agent');
const { query: dbQuery } = require('./db');
const { fetchKlines } = require('./indicator-library');
const { analyzeRecentTrades, checkPerformanceAlert } = require('./pattern-analyzer');

// ── Performance alert throttling ─────────────────────────────
let _lastPerfAlertTime = 0;
const PERF_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between alerts

// ── Trail tier tables — single source of truth shared with trail-watchdog.js ──
const {
  TRAILING_TIERS_100X: TRAILING_TIERS,
  TRAILING_TIERS_75X, TRAILING_TIERS_50X,
  SAFETY_TRAIL_TRIGGER, SAFETY_TRAIL_LOCK,
  setDynamicTiers, buildTierTable, tierTableForLev, calculateTrailingStep,
} = require('./trail-tiers');

// ── Trade outcome callback — agents hook in to track survival ──
let _onTradeOutcome = null;
function onTradeOutcome(fn) { _onTradeOutcome = fn; }
function fireTradeOutcome(data) { if (_onTradeOutcome) { try { _onTradeOutcome(data); } catch (_) {} } }

// ── ADX helper ─────────────────────────────────────────────
function calcADX(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return { adx: 0, diPlus: 0, diMinus: 0 };

  let tr = 0, dmPlus = 0, dmMinus = 0;
  for (let i = 1; i <= period; i++) {
    const h = highs[i], l = lows[i], c = closes[i];
    const ph = highs[i - 1], pl = lows[i - 1];
    const tr0 = Math.max(h - l, Math.abs(h - closes[i - 1]), Math.abs(l - closes[i - 1]));
    const dmP = (h - ph) > (pl - l) && (h - ph) > 0 ? (h - ph) : 0;
    const dmM = (pl - l) > (h - ph) && (pl - l) > 0 ? (pl - l) : 0;
    tr += tr0; dmPlus += dmP; dmMinus += dmM;
  }

  let trSmooth = tr, dmPlusSmooth = dmPlus, dmMinusSmooth = dmMinus;
  let diPlus = 100 * dmPlusSmooth / trSmooth;
  let diMinus = 100 * dmMinusSmooth / trSmooth;
  let dx = 100 * Math.abs(diPlus - diMinus) / (diPlus + diMinus || 1);
  let adx = dx;

  for (let i = period + 1; i < highs.length; i++) {
    const h = highs[i], l = lows[i];
    const ph = highs[i - 1], pl = lows[i - 1];
    const tr0 = Math.max(h - l, Math.abs(h - closes[i - 1]), Math.abs(l - closes[i - 1]));
    const dmP = (h - ph) > (pl - l) && (h - ph) > 0 ? (h - ph) : 0;
    const dmM = (pl - l) > (h - ph) && (pl - l) > 0 ? (pl - l) : 0;

    trSmooth = trSmooth - (trSmooth / period) + tr0;
    dmPlusSmooth = dmPlusSmooth - (dmPlusSmooth / period) + dmP;
    dmMinusSmooth = dmMinusSmooth - (dmMinusSmooth / period) + dmM;

    diPlus = 100 * dmPlusSmooth / trSmooth;
    diMinus = 100 * dmMinusSmooth / trSmooth;
    dx = 100 * Math.abs(diPlus - diMinus) / (diPlus + diMinus || 1);
    adx = ((adx * (period - 1)) + dx) / period;
  }
  return { adx, diPlus, diMinus };
}
// ──────────────────────────────────────────────────────────

const API_KEY        = process.env.BINANCE_API_KEY    || '';
const API_SECRET     = process.env.BINANCE_API_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN     || '';
const TELEGRAM_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const PRIVATE_CHATS  = TELEGRAM_CHATS.filter(id => !id.startsWith('-'));

// ── CONFIG (defaults — AI may override some via getOptimalParams) ─
const BTC_ETH_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT']);
const HIGH_PRICE_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);

// V4 strategy constants — loaded from v4_config DB table on startup (admin-editable).
// Falls back to these safe defaults when the DB row is missing.
let CAPITAL_PER_TRADE = 0.10;
// Per-symbol capital overrides — populated from v4_config (cap_ETHUSDT etc.)
// Falls back to CAPITAL_PER_TRADE when no symbol-specific value is set.
const SYMBOL_CAPITAL = {};

// ── TradingView webhook signal queue ──────────────────────────
// Signals injected via /api/tv-webhook are stored here (keyed by symbol).
// The next cycle picks them up and processes them exactly like internal signals.
// Only one pending signal per symbol — last one wins (prevents backlog).
const _tvSignalQueue = new Map();

function injectTVSignal(signal) {
  _tvSignalQueue.set(signal.symbol, signal);
  console.log(`[TV-Queue] Queued ${signal.symbol} ${signal.direction} — will fire next cycle`);
}

let TOKEN_LEVERAGE = {
  BTCUSDT: 125, // 125x — higher return per TP hit
  ETHUSDT: 125,
  SOLUSDT: 125,
};

async function loadV4Config() {
  try {
    const rows = await dbQuery('SELECT key, value FROM v4_config');
    const cfg = {};
    for (const r of rows) cfg[r.key] = r.value;

    // NOTE: capital_pct intentionally NOT loaded from DB — hardcoded at 10% in all scenarios.
    // if (cfg.capital_pct) CAPITAL_PER_TRADE = parseFloat(cfg.capital_pct) / 100;
    if (cfg.lev_BTCUSDT) TOKEN_LEVERAGE.BTCUSDT = parseInt(cfg.lev_BTCUSDT);
    if (cfg.lev_ETHUSDT) TOKEN_LEVERAGE.ETHUSDT = parseInt(cfg.lev_ETHUSDT);
    if (cfg.lev_BNBUSDT) TOKEN_LEVERAGE.BNBUSDT = parseInt(cfg.lev_BNBUSDT);
    if (cfg.lev_SOLUSDT) TOKEN_LEVERAGE.SOLUSDT = parseInt(cfg.lev_SOLUSDT);

    // NOTE: per-symbol capital overrides intentionally disabled — all tokens use hardcoded 10%.
    // for (const sym of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT']) {
    //   const capKey = `cap_${sym}`;
    //   if (cfg[capKey]) SYMBOL_CAPITAL[sym] = parseFloat(cfg[capKey]) / 100;
    // }

    // Build dynamic trailing SL tier tables from admin config.
    // Pushed into trail-tiers.js via setDynamicTiers so both cycle.js
    // and trail-watchdog.js use the exact same tables.
    const g = (k, def) => cfg[k] ? parseFloat(cfg[k]) : def;
    const dynamicTiers = {
      '100': buildTierTable(
        g('tsl_100x_t1_trig', 46), g('tsl_100x_t1_lock', 45),
        g('tsl_100x_t2_trig', 51), g('tsl_100x_t2_lock', 50),
        g('tsl_100x_t3_trig', 61), g('tsl_100x_t3_lock', 60),
        g('tsl_100x_step', 10)
      ),
      '75': buildTierTable(
        g('tsl_75x_t1_trig', 31), g('tsl_75x_t1_lock', 30),
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
    };
    setDynamicTiers(dynamicTiers);

    const t100 = dynamicTiers['100'];
    const t75  = dynamicTiers['75'];
    const t50  = dynamicTiers['50'];
    const capEth = SYMBOL_CAPITAL['ETHUSDT'] ? `ETH=${(SYMBOL_CAPITAL['ETHUSDT']*100).toFixed(0)}%` : '';
    const capOverrides = Object.keys(SYMBOL_CAPITAL).map(s => `${s.replace('USDT','')}=${(SYMBOL_CAPITAL[s]*100).toFixed(0)}%`).join(' ');
    console.log(`[V4 Config] Loaded — capital: ${(CAPITAL_PER_TRADE * 100).toFixed(0)}%${capOverrides ? ` (overrides: ${capOverrides})` : ''} | leverage: BTC=${TOKEN_LEVERAGE.BTCUSDT}x ETH=${TOKEN_LEVERAGE.ETHUSDT}x BNB=${TOKEN_LEVERAGE.BNBUSDT}x SOL=${TOKEN_LEVERAGE.SOLUSDT}x`);
    console.log(`[V4 Config] TSL tiers — 100x: T1=${t100[0].trigger*100}%→${t100[0].lock*100}% T2=${t100[1].trigger*100}%→${t100[1].lock*100}% T3=${t100[2].trigger*100}%→${t100[2].lock*100}% step=${g('tsl_100x_step',10)}%`);
    console.log(`[V4 Config] TSL tiers —  75x: T1=${t75[0].trigger*100}%→${t75[0].lock*100}%  T2=${t75[1].trigger*100}%→${t75[1].lock*100}%  T3=${t75[2].trigger*100}%→${t75[2].lock*100}%  step=${g('tsl_75x_step',10)}%`);
    console.log(`[V4 Config] TSL tiers —  50x: T1=${t50[0].trigger*100}%→${t50[0].lock*100}%  T2=${t50[1].trigger*100}%→${t50[1].lock*100}%  T3=${t50[2].trigger*100}%→${t50[2].lock*100}%  step=${g('tsl_50x_step',11)}%`);
  } catch (e) {
    console.warn('[V4 Config] Could not load from DB, using hardcoded defaults:', e.message);
  }
}

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

// Consecutive-loss pause: tracks losses per api_key_id in-memory.
// Resets to 0 on WIN. On 2nd consecutive LOSS, key is paused 4 hours.
const _consecLosses = new Map(); // api_key_id → { count, lastLossAt }

// Per-symbol loss cooldown: symbol loses → blocked 4h for that symbol specifically.
// Key: `${userId}:${symbol}` → timestamp (ms) when block expires.
const _symbolLossCooldown = new Map();

// Signal-type loss tracker: if same signal type loses twice on same symbol,
// block it for 24h so the bot doesn't repeat the same losing pattern.
// Key: `${symbol}:${direction}:${pivotType}` → { count, blockUntil }
const _signalLossTracker = new Map();

// ── SL/TP Config ──────────────────────────────────────────
// Max capital loss per trade = 20%.
// SL_PCT is price-loss fraction; capital loss = SL_PCT (independent of leverage).
//   125x: price SL = 0.20/125 = 0.16% price move → 20% capital loss
//   100x: price SL = 0.20/100 = 0.20% price move → 20% capital loss
//    75x: price SL = 0.15/75  = 0.20% price move → 15% capital loss
//    50x: price SL = 0.15/50  = 0.30% price move → 15% capital loss
const SL_PCT = 0.15;   // 15% max capital loss at any leverage
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

// Tier tables and trailing logic live in trail-tiers.js (imported above).
// TRAILING_TIERS / TRAILING_TIERS_75X / TRAILING_TIERS_50X are imported as aliases.
// buildTierTable / tierTableForLev / calculateTrailingStep come from the same module.

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

// Get token leverage — reads directly from TOKEN_LEVERAGE constant.
// All DB tables (user_token_leverage, token_leverage, risk_levels) are bypassed.
// TOKEN_LEVERAGE at the top of this file is the single source of truth.
async function getTokenLeverage(symbol, apiKeyId = null, price = 0) {
  const lev = TOKEN_LEVERAGE[symbol] || 100;
  console.log(`[LEV] ${symbol} → ${lev}x (source: TOKEN_LEVERAGE hardcoded)`);
  return lev;

  // NOTE: DB-based priority lookup removed — was causing BNB to stay at 20x
  // because user_token_leverage (Priority 1) had stale 20x value that overrode everything.
  // To change leverage: edit TOKEN_LEVERAGE constant above and redeploy.

  // Dead code below kept for reference only — never reached:
  // Priority 1 (old): user_token_leverage
  // Priority 2 (old): token_leverage table
  // Priority 3 (old): risk_levels.max_leverage
  // Priority 4 (old): default 100x
  if (false) { // eslint-disable-line no-constant-condition
    const MAX_LEVERAGE = 125;
    const { query } = require('./db');

    if (apiKeyId) {
      const userTokenRows = await query(
        'SELECT leverage FROM user_token_leverage WHERE api_key_id = $1 AND symbol = $2',
        [apiKeyId, symbol]
      );
      if (userTokenRows.length > 0) return Math.min(parseInt(userTokenRows[0].leverage), MAX_LEVERAGE);
    }
    const tokenRows = await query('SELECT leverage FROM token_leverage WHERE symbol = $1 AND enabled = true', [symbol]);
    if (tokenRows.length > 0) return Math.min(parseInt(tokenRows[0].leverage), MAX_LEVERAGE);
    return 100;
  } // end if(false)
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

// ── 5m REVERSAL EXIT CHECK (structure-reversal exit for Rev-SMC trades) ──
// LONG exits when a 5m LH pivot forms (lower high = momentum shift down)
// SHORT exits when a 5m HL pivot forms (higher low = momentum shift up)
function shouldExitRev(klines5m, direction) {
  const swings = detectSwings(klines5m, 5);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows  = swings.filter(s => s.type === 'low');
  if (direction === 'LONG' && swingHighs.length >= 2) {
    const recent = swingHighs[swingHighs.length - 1];
    const prev   = swingHighs[swingHighs.length - 2];
    return recent.price < prev.price; // LH = lower high
  }
  if (direction === 'SHORT' && swingLows.length >= 2) {
    const recent = swingLows[swingLows.length - 1];
    const prev   = swingLows[swingLows.length - 2];
    return recent.price > prev.price; // HL = higher low
  }
  return false;
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

// calculateTrailingStep / SAFETY_TRAIL_TRIGGER / SAFETY_TRAIL_LOCK
// imported from trail-tiers.js above — single source of truth.

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
  const leverage = pick.leverage || getLeverage(sym, price, aiParams);
  const walletSizePct = CAPITAL_PER_TRADE; // 10% of wallet — single source of truth

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

  // TP targets — capital %-based scale-out ladder (30% / 40% / 50% capital)
  const tp1 = fmtP(isLong ? price * (1 + 0.30 / leverage) : price * (1 - 0.30 / leverage));
  const tp2 = fmtP(isLong ? price * (1 + 0.40 / leverage) : price * (1 - 0.40 / leverage));
  const tp3 = fmtP(isLong ? price * (1 + 0.50 / leverage) : price * (1 - 0.50 / leverage));

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
    scaleOutStage: 0,
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
    exitMode: pick.exitMode || 'TRAIL',
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
          let realizedPnl = null;
          let tradingFee = 0;
          try {
            // Fetch fills since position opened — avoid limit=5 missing close fill
            const fills = await client.getAccountTrades({ symbol: sym, startTime: state.openedAt, limit: 50 });
            if (fills && fills.length > 0) {
              // Sum fees from all fills
              for (const f of fills) {
                tradingFee += Math.abs(parseFloat(f.commission || 0));
              }
              // Find close fills (opposite side of entry)
              const closeSide = state.isLong ? 'SELL' : 'BUY';
              const closeFills = fills.filter(f => f.side === closeSide);
              if (closeFills.length > 0) {
                let totalQty = 0, totalValue = 0, totalPnl = 0;
                for (const f of closeFills) {
                  const fQty = parseFloat(f.qty);
                  totalQty += fQty;
                  totalValue += fQty * parseFloat(f.price);
                  totalPnl += parseFloat(f.realizedPnl || 0);
                }
                if (totalQty > 0) exitPrice = totalValue / totalQty;
                if (totalPnl !== 0) realizedPnl = totalPnl;
              } else {
                exitPrice = parseFloat(fills[fills.length - 1].price);
              }
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

      // ── 5m Structure-Reversal EXIT (Rev-SMC trades only) ──
      const state = tradeState.get(sym);
      if (state && state.exitMode === 'REV') {
        try {
          const klines5 = await client.getKlines({ symbol: sym, interval: '5m', limit: 50 });
          if (shouldExitRev(klines5, isLong ? 'LONG' : 'SHORT')) {
            log(`Exit [${isLong ? 'LONG' : 'SHORT'}] ${sym}: 5m structure reversal (Rev)`);
            try { await client.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
            try { await client.cancelAllAlgoOpenOrders({ symbol: sym }); } catch (_) {}
            await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true' });

            await aiLearner.recordTrade({
              symbol: sym, direction: isLong ? 'LONG' : 'SHORT',
              setup: state.setup || 'unknown', entryPrice: entry, exitPrice: cur,
              pnlPct: gain * 100, leverage: state.leverage || getLeverage(sym, entry, await aiLearner.getOptimalParams()),
              durationMin: Math.round((Date.now() - state.openedAt) / 60000),
              session: aiLearner.getCurrentSession(),
              slDistancePct: Math.abs(entry - state.sl) / entry * 100,
              tpDistancePct: Math.abs(state.tp1 - entry) / entry * 100,
              tf15m: state.tf15m || null, tf3m: state.tf3m || null, tf1m: state.tf1m || null,
              marketStructure: state.marketStructure || null,
              vwapZone: state.vwapZone || null,
              exitReason: 'structure_reversal_5m',
              comboId: state.comboId || 15,
            });
            if (gain < 0) {
              await aiLearner.performLossAutopsy({
                symbol: sym, setup: state.setup || 'unknown',
                direction: isLong ? 'LONG' : 'SHORT',
                session: aiLearner.getCurrentSession(),
                marketStructure: state.marketStructure || 'unknown',
                vwapZone: state.vwapZone || null,
              });
            } else {
              await aiLearner.performWinAutopsy({
                symbol: sym, setup: state.setup || 'unknown',
                direction: isLong ? 'LONG' : 'SHORT',
                session: aiLearner.getCurrentSession(),
                marketStructure: state.marketStructure || 'unknown',
                vwapZone: state.vwapZone || null,
              });
            }
            tradeState.delete(sym);
            await notify(
              `*Exit: 5m Rev*
` +
              `*${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
              `Entry: \`$${fmtPrice(entry)}\` Exit: \`$${fmtPrice(cur)}\`\n` +
              `PnL: *${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(2)}%*`
            );
            continue;
          }
        } catch (_) {}
      }

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
      // Skip for Rev-SMC trades — they exit on 5m structure reversal
      let trailResult;
      if (state.exitMode === 'REV') {
        trailResult = null;
      } else {
        const lev      = state.leverage || 20;
        const lastStep = state.trailingSlLastStep || 0;
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
      const curQty  = Math.abs(amt);

      // ── Capital %-based scale-out ladder ─────────────────────────
      //   +20% capital → early SL lock +15%  (handled by trail-tiers.js)
      //   +30% capital → close 50%,     SL to +30%
      //   +40% capital → close 50% of remaining, SL to +40%
      //   +50% capital → close rest
      const lev = state.leverage || 20;
      const capitalPct = gain * 100 * lev; // gain = price fraction, capital% = price% * leverage

      if (state.scaleOutStage === undefined) state.scaleOutStage = 0;

      // Scale-out ladder — skipped for Rev-SMC trades (they ride to Rev exit)
      if (state.exitMode !== 'REV' && state.scaleOutStage < 1 && capitalPct >= 30) {
        state.scaleOutStage = 1;
        const closeQty = floorQ(curQty * 0.50);
        const slPricePct = 0.30 / lev;
        const newSl = fmtP(isLong ? state.entry * (1 + slPricePct) : state.entry * (1 - slPricePct));
        log(`Scale-out 1 ${sym} @ +${capitalPct.toFixed(1)}% capital: closing 50% (${closeQty}), SL -> +30%`);
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
        } catch (e) { log(`Scale-out 1 exec warn: ${e.message}`); state.scaleOutStage = 0; }

        // Sync in-memory SL state so trailing SL ratchet respects the new lock
        state.trailingSlPrice = newSl;
        state.trailingSlLastStep = 0.30;
        state.sl = newSl;
        try {
          const db = require('./db');
          await db.query(
            `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2 WHERE symbol = $3 AND status = 'OPEN'`,
            [newSl, 0.30, sym]
          );
        } catch (_) {}

        await notify(
          `*TP1 Hit!* — *${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
          `50% secured @ +30% capital | SL locked +30%\n` +
          `Riding 50% → TP2 (+40%) / TP3 (+50%)`
        );
        continue;
      }

      if (state.exitMode !== 'REV' && state.scaleOutStage < 2 && capitalPct >= 40) {
        state.scaleOutStage = 2;
        const closeQty = floorQ(curQty * 0.50);
        const slPricePct = 0.40 / lev;
        const newSl = fmtP(isLong ? state.entry * (1 + slPricePct) : state.entry * (1 - slPricePct));
        log(`Scale-out 2 ${sym} @ +${capitalPct.toFixed(1)}% capital: closing 50% of remaining (${closeQty}), SL -> +40%`);
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
        } catch (e) { log(`Scale-out 2 exec warn: ${e.message}`); state.scaleOutStage = 1; }

        state.trailingSlPrice = newSl;
        state.trailingSlLastStep = 0.40;
        state.sl = newSl;
        try {
          const db = require('./db');
          await db.query(
            `UPDATE trades SET trailing_sl_price = $1, trailing_sl_last_step = $2 WHERE symbol = $3 AND status = 'OPEN'`,
            [newSl, 0.40, sym]
          );
        } catch (_) {}

        await notify(
          `*TP2 Hit!* — *${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
          `25% secured @ +40% capital (75% total taken)\n` +
          `SL locked +40% | Riding 25% → TP3 (+50%)`
        );
        continue;
      }

      if (state.exitMode !== 'REV' && state.scaleOutStage < 3 && capitalPct >= 50) {
        state.scaleOutStage = 3;
        const closeQty = floorQ(curQty);
        log(`Scale-out 3 ${sym} @ +${capitalPct.toFixed(1)}% capital: closing rest (${closeQty})`);
        try {
          try { await client.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
          try { await client.cancelAllAlgoOpenOrders({ symbol: sym }); } catch (_) {}
          if (closeQty > 0) {
            await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: closeQty, reduceOnly: 'true' });
          }
        } catch (e) { log(`Scale-out 3 exec warn: ${e.message}`); state.scaleOutStage = 2; }

        await notify(
          `*TP3 Hit!* — *${sym}* ${isLong ? 'LONG' : 'SHORT'}\n` +
          `25% secured @ +50% capital (100% closed)\n` +
          `Full position exited`
        );
        continue;
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
  if (!lastBitunixSync || now - lastBitunixSync > 30 * 60_000) {
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

    // Load admin-editable V4 config on first cycle only
    if (!runCycle._v4ConfigLoaded) {
      runCycle._v4ConfigLoaded = true;
      await loadV4Config();
    }

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

    // One-time: ensure every user can trade all 5 tokens simultaneously.
    // Any key with max_positions < 5 (or NULL) is upgraded to 5.
    if (!runCycle._maxPosFix5Done) {
      runCycle._maxPosFix5Done = true;
      try {
        const updated = await dbQuery(
          `UPDATE api_keys SET max_positions = 5
           WHERE max_positions IS NULL OR max_positions < 5
           RETURNING id, user_id`
        );
        if (updated.length > 0) {
          bLog.system(`[MAX-POS-FIX] Set max_positions=5 on ${updated.length} key(s): ${updated.map(k => `#${k.id}(uid=${k.user_id})`).join(', ')}`);
        } else {
          bLog.system('[MAX-POS-FIX] All keys already have max_positions ≥ 5 — no changes needed');
        }
      } catch (e) {
        bLog.error(`[MAX-POS-FIX] Failed: ${e.message}`);
      }
    }

    // One-time diagnostic: dump all API keys + active version on first cycle after deploy
    if (!runCycle._keyDiagDone) {
      runCycle._keyDiagDone = true;
      try {
        const allDbKeys = await dbQuery(
          `SELECT ak.id, ak.user_id, ak.enabled, ak.paused_by_admin, ak.paused_by_user,
                  ak.loss_cooldown_until, ak.platform, u.email
           FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id ORDER BY ak.id`
        );
        bLog.system(`[KEY-DIAG] ALL ${allDbKeys.length} api_keys: ${allDbKeys.map(k => {
          const cd = k.loss_cooldown_until ? ` cd=${new Date(k.loss_cooldown_until).toISOString().slice(0,16)}` : '';
          return `#${k.id} ${k.email || 'NO-USER(uid='+k.user_id+')'} platform=${k.platform||'NULL'} en=${k.enabled} ap=${k.paused_by_admin} up=${k.paused_by_user}${cd}`;
        }).join(' | ')}`);
      } catch (_) {}
      // Log active AI version — if enableLong/enableShort=false, trades are silently blocked
      try {
        const avRows = await dbQuery(`SELECT value FROM settings WHERE key = 'active_ai_version'`);
        if (avRows.length) {
          const av = JSON.parse(avRows[0].value);
          const enableL = av.enableLong  !== false && av.enableLong  !== 'false';
          const enableS = av.enableShort !== false && av.enableShort !== 'false';
          bLog.system(`[ACTIVE-VER] version="${av.version}" enableLong=${enableL} enableShort=${enableS} slPct=${av.slPct||'default'} trailStep=${av.trailStep||'default'}`);
          if (!enableL && !enableS) {
            bLog.error('[ACTIVE-VER] WARNING: BOTH directions disabled — no trades will fire until version is deactivated!');
            await notify(`⚠️ *AI Version Warning*\nActive version "${av.version}" has BOTH Long and Short DISABLED.\nGo to Admin > AI Versions and click Deactivate, or trading will remain paused.`);
          } else if (!enableL) {
            bLog.error('[ACTIVE-VER] WARNING: LONG disabled by active version');
          } else if (!enableS) {
            bLog.error('[ACTIVE-VER] WARNING: SHORT disabled by active version');
          }
        } else {
          bLog.system('[ACTIVE-VER] No active AI version — using hardcoded defaults (all directions enabled)');
        }
      } catch (_) {}
    }
    const topNRows = await dbQuery('SELECT MAX(top_n_coins) as max_n FROM api_keys WHERE enabled = true');
    const topNCoins = parseInt(topNRows[0]?.max_n) || 50;

    // ── Pattern Analyzer — learn from recent trades ────────────
    let patternRecs = null;
    try {
      patternRecs = await analyzeRecentTrades(null, 15);
      if (patternRecs.ready) {
        bLog.ai(`[PatternAnalyzer] Last ${patternRecs.totalTrades} trades: ${patternRecs.winRate}% WR`);
        for (const rec of patternRecs.recommendations.slice(0, 3)) {
          bLog.ai(`[PatternAnalyzer] ${rec}`);
        }
      }
    } catch (paErr) {
      bLog.error(`[PatternAnalyzer] error: ${paErr.message}`);
    }

    // ── Performance Alert — last 5 trades since this deploy ─────
    try {
      const perf = await checkPerformanceAlert(40, 5);
      if (perf.alert) {
        const nowMs = Date.now();
        if (nowMs - _lastPerfAlertTime > PERF_ALERT_COOLDOWN_MS) {
          _lastPerfAlertTime = nowMs;
          await notify(perf.message);
        }
      } else if (perf.winRate !== undefined) {
        bLog.ai(`[Performance] ${perf.message}`);
      }
    } catch (perfErr) {
      bLog.error(`[PerformanceAlert] error: ${perfErr.message}`);
    }

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

    // ── Strategy Scan — V4 SMC via TokenAgent ──
    // VWAP 2σ zones + 15m/1m swing-pivot confluence.
    // Rules: ABOVE_UPPER + 15m HH + (1m HH|LH) → SHORT
    //        LOWER_MID   + 15m HL + 1m HL       → LONG (HL+HL)
    //        BELOW_LOWER + any HL/LL on both TFs → LONG
    const signals = [];

    // ── TradingView webhook signals DISABLED ──
    // TV webhooks bypassed the 4-step SMC rule and fired wrong trades.
    // All signals now flow exclusively through SMCPatternAgent.
    if (_tvSignalQueue.size > 0) {
      bLog.scan(`TV-Webhook: ${_tvSignalQueue.size} queued signal(s) DISCARDED — SMCPatternAgent is sole source`);
      _tvSignalQueue.clear(); // drain without executing
    }

    // ── Internal strategy scans DISABLED ──
    // All signals now come exclusively from SMCPatternAgent (smc-engine.js)
    // which enforces the strict 15m LL→LH→1m LH→SHORT / HH→HL→1m HL→LONG rule.
    // The old scanV4SMC and scanHommaSMC have been removed to prevent
    // them firing trades without proper 15m confirmation.
    bLog.scan('Internal scan: disabled — signals from SMCPatternAgent only');

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

      // ── HARD-BLOCK losers identified from 30d live WR report ──
      // 1. VWAPTrend setups: 0% WR, -$0.56
      // 2. BreakRetest+OP+VolSpike: 0% WR, -$0.51
      // Hard-block historical 0% WR setups — these are strategy names, not symbols
      const setupName = pick.setupName || pick.setup || '';
      if (setupName.includes('VWAPTrend')) {
        bLog.trade(`BLOCKED: ${pick.symbol} ${pick.direction} setup=${setupName} — historical 0% WR loser`);
        continue;
      }
      if (setupName.includes('BreakRetest')) {
        bLog.trade(`BLOCKED: ${pick.symbol} ${pick.direction} setup=${setupName} — historical 0% WR loser`);
        continue;
      }

      // ── TradingView MANUAL OVERRIDE ────────────────────────────
      // If user sends override=true from TV webhook, bypass ALL gates
      // and execute immediately. Log it loud for audit trail.
      if (pick.source === 'tradingview' && pick.override === true) {
        const overrideMsg = `🎚️ *MANUAL OVERRIDE*\n${pick.symbol} ${pick.direction} @ $${fmtPrice(pick.price)}\nReason: ${pick.reason || 'none'}\nBy-passing: EMA200, ADX, structure, loss-tracker`;
        bLog.trade(`TV-OVERRIDE: ${pick.symbol} ${pick.direction} @ ${pick.price} — BYPASSING ALL GATES`);
        await notify(overrideMsg);
        // Skip directly to execution
        const result = await executeForAllUsers(pick);
        if (result === 'ALL_TOO_EXPENSIVE' || result === 'NO_KEYS') {
          bLog.trade(`TV-OVERRIDE FAILED: ${pick.symbol} — ${result}`);
          continue;
        }
        executed = true;
        continue; // next signal
      }

      // ── TradingView WEBHOOK (non-override) ─────────────────────
      // Runs through same gates as internal signals, but with TV-specific logging
      if (pick.source === 'tradingview' && !pick.override) {
        bLog.trade(`TV-VALIDATED: ${pick.symbol} ${pick.direction} — running through SMC+Homma gates`);
      }

      // ── Signal-type loss blocker ───────────────────────────────
      // If the same pivot+direction combo has lost ≥ 2 times, block it for 24h.
      // Prevents the bot from repeating the exact same losing pattern.
      const sigPivot  = pick.type || pick.pivot || pick.setup || 'unknown';
      const sigKey    = `${pick.symbol}:${pick.direction}:${sigPivot}`;
      const sigRecord = _signalLossTracker.get(sigKey);
      if (sigRecord && sigRecord.blockUntil > Date.now()) {
        const resumeStr = new Date(sigRecord.blockUntil).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        bLog.trade(`BLOCKED: ${pick.symbol} ${pick.direction} [${sigPivot}] — lost ${sigRecord.count}x, blocked until ${resumeStr}`);
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

      // ── Trend-strength gate ──
      // Don't fade VWAP when the trend is strong (ADX > 28).
      // Momentum breakouts are allowed through.
      const MEAN_REVERSION_SETUPS = new Set(['RANGE_BOUNCE', 'VWAP_SMC', 'SMC_ZONE']);
      if (!pick.isMomentumBreakout && MEAN_REVERSION_SETUPS.has(pick.setup)) {
        try {
          const klines = await fetchKlines(pick.symbol, '15m', 20); // 20 bars ≈ 5h
          if (klines && klines.length >= 15) {
            const highs = klines.map(k => k.high);
            const lows  = klines.map(k => k.low);
            const closes = klines.map(k => k.close);
            const { adx, diPlus, diMinus } = calcADX(highs, lows, closes, 14);

            const isUptrend = diPlus > diMinus;
            const isDowntrend = diMinus > diPlus;

            if (adx > 28) {
              if (pick.direction === 'SHORT' && isUptrend) {
                bLog.trade(`TREND GATE BLOCKED: ${pick.symbol} SHORT rejected — ADX ${adx.toFixed(1)} uptrend too strong to fade`);
                continue;
              }
              if (pick.direction === 'LONG' && isDowntrend) {
                bLog.trade(`TREND GATE BLOCKED: ${pick.symbol} LONG rejected — ADX ${adx.toFixed(1)} downtrend too strong to fade`);
                continue;
              }
            }
          }
        } catch (adxErr) {
          bLog.warn(`ADX gate error for ${pick.symbol}: ${adxErr.message} — allowing trade`);
        }
      }
      // ──────────────────────────────────────────────────────────

      bLog.trade(`Executing trade: ${pick.symbol} ${pick.direction} for registered users...`);
      const result = await executeForAllUsers(pick);

      if (result === 'ALL_TOO_EXPENSIVE') {
        bLog.trade(`${pick.symbol} too expensive for all users — trying next signal...`);
        continue;
      }
      if (result === 'NO_KEYS') {
        bLog.trade(`${pick.symbol}: no active keys to trade — check api_keys table`);
        continue;
      }
      executed = true;
      // Continue processing remaining signals so ALL users get a trade opportunity.
      // Users who already traded are protected by: max_positions, dedup guard, open trade check.
    }
    // Owner account handled via executeForAllUsers (DB keys with pause/enabled checks)
    // No separate owner path — all accounts go through the same pipeline

    // If signals arrived but zero executed, diagnose the blockage once per hour
    if (dedupedSignals.length > 0 && !executed) {
      runCycle._sigBlockCount = (runCycle._sigBlockCount || 0) + 1;
      if (runCycle._sigBlockCount === 1 || runCycle._sigBlockCount % 12 === 0) {
        const symList = dedupedSignals.map(s => `${s.symbol} ${s.direction}`).join(', ');
        bLog.error(`[BLOCKED] ${dedupedSignals.length} signal(s) generated but 0 trades executed: ${symList}`);
        await notify(`⚠️ *Trade Signals Blocked*\n${dedupedSignals.length} signal(s) generated but 0 trades executed.\nSignals: ${symList}\nCheck: active AI version (enableLong/Short), api_key pauses, open positions, wallet balance.`);
      }
    } else {
      runCycle._sigBlockCount = 0;
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

  // Trader Mode: detect manually opened positions and mirror to followers
  await processTraderModeKeys().catch(e => bLog.error(`[TraderMode] cycle error: ${e.message}`));

  // Hard-sync exchange positions with DB every cycle — fast and idempotent.
  // Covers keys with zero DB trades (syncTradeStatus early-returns for those).
  await hardSyncExchangeDB();

  // Sync trades + trailing SL for all users (including owner via DB) every cycle
  await syncTradeStatus();
  await checkUsdtTopups();

  // Periodic PnL backfill — re-syncs real PnL/fees from Bitunix for all closed trades.
  // Fixes estimated values (market-price fallback) that syncTradeStatus wrote when
  // the Bitunix API was unavailable at close time. Runs every 6 hours.
  runCycle._lastBackfill = runCycle._lastBackfill || 0;
  if (Date.now() - runCycle._lastBackfill > 6 * 60 * 60_000) {
    runCycle._lastBackfill = Date.now();
    backfillFeesFromBitunix().catch(e => bLog.error(`[FEE-BACKFILL] periodic error: ${e.message}`));
  }

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

    // One-time: add loss_cooldown_until column (safe no-op if already exists),
    // clear any stale paused_by_admin flags (not cooldown pauses), and refresh admin accounts.
    if (!executeForAllUsers._unpauseDone) {
      executeForAllUsers._unpauseDone = true;
      try {
        // Ensure the cooldown column exists (idempotent)
        await db.query(`
          ALTER TABLE api_keys
          ADD COLUMN IF NOT EXISTS loss_cooldown_until TIMESTAMPTZ DEFAULT NULL
        `);
        bLog.trade('[CONSEC-LOSS] loss_cooldown_until column ready');
      } catch (e) {
        bLog.error(`[CONSEC-LOSS] Column migration failed: ${e.message}`);
      }
      try {
        // On every restart: clear ALL paused_by_admin flags.
        // The in-memory _consecLosses streak resets on restart, so DB pause must too.
        // Use two separate statements so paused_by_admin is cleared even if the
        // loss_cooldown_until column doesn't exist yet (avoids "column not found" on SET).
        const unpaused = await db.query(
          `UPDATE api_keys
           SET paused_by_admin = false
           WHERE paused_by_admin = true AND paused_by_user = false
           RETURNING id, user_id`
        );
        if (unpaused.length > 0) {
          bLog.trade(`[UNBLOCK] Restart cleared admin-pause on ${unpaused.length} key(s): ${unpaused.map(k => `#${k.id}`).join(', ')}`);
        }
        // Reset cooldown column separately (safe — column was just created above)
        try {
          await db.query(`UPDATE api_keys SET loss_cooldown_until = NULL WHERE loss_cooldown_until IS NOT NULL`);
        } catch (_) {}
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
          `SELECT ak.id, ak.user_id, ak.enabled, ak.paused_by_admin, ak.paused_by_user,
                  ak.loss_cooldown_until, ak.platform, u.email
           FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id ORDER BY ak.id`
        );
        bLog.trade(`[DIAG] ALL api_keys (${allDbKeys.length}): ${allDbKeys.map(k => {
          const cooldown = k.loss_cooldown_until ? ` cooldown_until=${new Date(k.loss_cooldown_until).toISOString().slice(0,16)}` : '';
          return `#${k.id} ${k.email || 'NO-USER(uid='+k.user_id+')'} platform=${k.platform||'NULL'} en=${k.enabled} ap=${k.paused_by_admin} up=${k.paused_by_user}${cooldown}`;
        }).join(' | ')}`);
      } catch (diagErr) {
        bLog.error(`[DIAG] Failed: ${diagErr.message}`);
      }
    }

    // Auto-resume keys whose 4-hour consecutive-loss cooldown has expired
    try {
      const resumed = await db.query(
        `UPDATE api_keys
         SET paused_by_admin = false, loss_cooldown_until = NULL
         WHERE paused_by_admin = true
           AND loss_cooldown_until IS NOT NULL
           AND loss_cooldown_until <= NOW()
         RETURNING id, user_id`
      );
      for (const r of resumed) {
        _consecLosses.set(r.id, { count: 0, lastLossAt: 0 });
        bLog.trade(`[CONSEC-LOSS] Key #${r.id} auto-resumed — 4h cooldown expired`);
        await notify(`▶️ *Trading Resumed*\nKey #${r.id} — 4-hour cooldown complete. Ready to trade.`);
      }
    } catch (e) {
      bLog.error(`[CONSEC-LOSS] Auto-resume check failed: ${e.message}`);
    }

    const allKeys = await db.query(
      // NOTE: paused_by_admin filter removed intentionally.
      // When admin fires a trade, ALL users follow — even those paused by loss cooldown.
      // The paused_by_admin check is now enforced inside the loop, but bypassed when
      // adminOverride is active (i.e., an admin key is present in the list).
      // paused_by_user is still respected — user manually paused themselves.
      `SELECT ak.*, u.email, u.is_admin
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true
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
          // Auto-fix: if ALL keys are paused_by_admin with no valid cooldown, clear the pause.
          // This handles the case where consecutive-loss logic paused on startup and restart
          // didn't fully clear it (e.g. loss_cooldown_until column didn't exist yet).
          const allAdminPaused = debugKeys.every(k => k.paused_by_admin === true && !k.paused_by_user);
          if (allAdminPaused) {
            try {
              await db.query(
                `UPDATE api_keys SET paused_by_admin = false
                 WHERE paused_by_admin = true AND paused_by_user = false`
              );
              bLog.trade(`AUTO-FIX: Cleared paused_by_admin on all ${debugKeys.length} keys — no valid cooldown active`);
            } catch (fixErr) {
              bLog.error(`AUTO-FIX pause clear failed: ${fixErr.message}`);
            }
          }
        } else {
          bLog.trade('No API keys in database at all');
        }
      } catch (_) {}
      return 'NO_KEYS';
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

    let keys = allKeys;
    const sym = pick.symbol || pick.sym;

    // ── HARD WHITELIST: Only 5 coins ever reach the exchange ──────────────────
    const TRADE_WHITELIST = new Set(ACTIVE_SYMBOLS);
    if (!TRADE_WHITELIST.has(sym)) {
      bLog.trade(`BLOCKED: ${sym} is not in the 5-coin whitelist — trade cancelled`);
      return;
    }

    // ── SINGLE-USER MODE: restrict trading to admin only (debug/test mode) ────
    // Enabled via settings key 'bot.single_user_mode' = 'true'.
    // When on, non-admin keys are filtered out so only admin trades.
    // Toggle from admin panel — survives restarts.
    try {
      const suRows = await db.query(`SELECT value FROM settings WHERE key = 'bot.single_user_mode'`);
      if (suRows.length > 0 && suRows[0].value === 'true') {
        const before = keys.length;
        keys = keys.filter(k => k.is_admin === true);
        bLog.trade(`[SINGLE-USER-MODE] Active — trading restricted to admin only (${keys.length}/${before} keys)`);
      }
    } catch (_) {}

    // ── ADMIN OVERRIDE: if admin's key is active, ALL users follow ────────────
    // When admin fires a trade: paused_by_admin and per-symbol loss cooldown are
    // bypassed for every user. paused_by_user is still respected (user's own choice).
    // Admin's own key is always exempt from pause/cooldown regardless.
    const adminOverride = keys.some(k => k.is_admin === true);
    if (adminOverride) {
      const pausedCount = keys.filter(k => !k.is_admin && k.paused_by_admin).length;
      bLog.trade(`[ADMIN-OVERRIDE] Admin key active — all users follow ${sym} ${pick.direction}` +
        (pausedCount > 0 ? ` (bypassing loss-cooldown pause for ${pausedCount} user(s))` : ''));
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

        // NOTE: per-user banned_coins and watchlist filters removed.
        // All users trade all 5 active symbols (BTC/ETH/BNB/ADA/SOL).

        const isAdminKey = !!key.is_admin;

        // ── paused_by_admin gate ──────────────────────────────────────────────
        // Admin keys: always exempt — never blocked by loss cooldown.
        // Non-admin keys: normally skip if paused. BUT if adminOverride is active
        // (admin has an active key in this cycle), everyone follows regardless.
        if (!isAdminKey && key.paused_by_admin) {
          if (!adminOverride) {
            userLog.trade(`User ${key.email}: paused by admin (loss cooldown) — skipping`);
            return;
          }
          userLog.trade(`User ${key.email}: paused by admin BUT admin override active — following admin trade`);
        }

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
          `SELECT id, status FROM trades WHERE user_id = $1 AND symbol = $2 AND status IN ('OPEN','PENDING_LIMIT') LIMIT 1`,
          [key.user_id, symbol]
        );
        if (existingTrade.length > 0) {
          _openTradeInProgress.delete(openLockKey);
          userLog.trade(`User ${key.email}: already has ${existingTrade[0].status} trade on ${symbol} — skipping duplicate`);
          return;
        }

        // Per-symbol LOSS cooldown: 4 hours after a LOSS on this symbol.
        // Bypassed when adminOverride is active — admin fires, everyone follows.
        // Admin keys themselves are also always exempt.
        if (!isAdminKey && !adminOverride) {
          // In-memory fast check first (avoids DB query each cycle)
          const cooldownKey = `${key.user_id}:${symbol}`;
          const memBlock = _symbolLossCooldown.get(cooldownKey);
          if (memBlock && Date.now() < memBlock) {
            _openTradeInProgress.delete(openLockKey);
            const resumeStr = new Date(memBlock).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
            userLog.trade(`User ${key.email}: ${symbol} on 4h loss cooldown (in-memory) — resumes ${resumeStr}`);
            return;
          }
          // DB check for LOSS within last 4 hours (covers bot restarts)
          const recentLoss = await db.query(
            `SELECT id, closed_at FROM trades
             WHERE user_id = $1 AND symbol = $2 AND status = 'LOSS'
               AND closed_at > NOW() - INTERVAL '4 hours'
             ORDER BY closed_at DESC LIMIT 1`,
            [key.user_id, symbol]
          );
          if (recentLoss.length > 0) {
            _openTradeInProgress.delete(openLockKey);
            const resumeAt = new Date(new Date(recentLoss[0].closed_at).getTime() + 4 * 3600 * 1000);
            _symbolLossCooldown.set(cooldownKey, resumeAt.getTime()); // cache in memory
            const resumeStr = resumeAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
            userLog.trade(`User ${key.email}: ${symbol} on 4h loss cooldown — resumes ${resumeStr}`);
            return;
          }
        }

        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        const maxPos = Math.max(5, parseInt(key.max_positions) || 5);

        const price = pick.lastPrice || pick.price || pick.entry;
        const isLong = pick.direction !== 'SHORT';

        // ── Read ALL user settings from DB ──
        const userLev = await getTokenLeverage(symbol, key.id, price);
        if (userLev === null) {
          userLog.trade(`User ${key.email}: ${symbol} has no token configuration — skipped`);
          return;
        }

        // Position sizing: per-symbol override from SYMBOL_CAPITAL, else global CAPITAL_PER_TRADE.
        // Set via v4_config: cap_ETHUSDT=20 → 20% for ETH, others stay at capital_pct default.
        const walletSizePct = SYMBOL_CAPITAL[symbol] ?? CAPITAL_PER_TRADE;
        userLog.trade(`User ${key.email}: sizing = ${(walletSizePct * 100).toFixed(0)}% of wallet for ${symbol}${SYMBOL_CAPITAL[symbol] ? ' (symbol override)' : ''}`);
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

        // SL price distance: per-symbol from SYMBOL_SL_PCT (e.g. BTC=0.25%, ETH=0.40%)
        // Falls back to SL_PCT / leverage for non-V4 symbols.
        let slPricePct = dirSl != null ? dirSl : (SYMBOL_SL_PCT[symbol] ?? (SL_PCT / userLev));
        const tpPricePct = dirTp != null && dirTp > 0 ? dirTp : (TP_PCT / userLev);

        // Liquidation guard
        const maxSlPct = (1 / userLev) * 0.80;
        if (slPricePct > maxSlPct) {
          userLog.trade(`User ${key.email}: SL clamped from ${(slPricePct*100).toFixed(3)}% to ${(maxSlPct*100).toFixed(3)}% (liq guard at ${userLev}x)`);
          slPricePct = maxSlPct;
        }

        // ── SMC pivot anchor: SL placed beyond the 1m structural pivot, not at entry ──
        // At 125x, SL_PCT/lev = 0.12% from entry. If entry is $2,100 and the 1m LH
        // pivot is at $2,102, old SL = $2,102.52 — only $0.52 above LH. The confirming
        // wick (next 1-2 bars after LH forms) easily hits it, stopping a correct trade.
        // Fix: anchor SL to the pivot price so SL is always 0.12% BEYOND the structural
        // level, not right at it. pick.smcContext.level = 1m LH (for SHORT) / HL (for LONG).
        const smcPivotPrice = pick.smcContext?.level ?? null;
        const slAnchor = smcPivotPrice ?? price;
        if (smcPivotPrice) {
          const pivotGap = isLong
            ? (price - smcPivotPrice) / price   // LONG: how far above HL pivot
            : (smcPivotPrice - price) / price;  // SHORT: how far below LH pivot
          userLog.trade(
            `User ${key.email}: SMC pivot anchor — ${isLong ? 'HL' : 'LH'}=${smcPivotPrice.toFixed(4)} ` +
            `entry=${price.toFixed(4)} gap=${(pivotGap * 100).toFixed(3)}% ` +
            `SL anchored to pivot (not entry)`
          );
        }
        const initialSlPrice = isLong ? slAnchor * (1 - slPricePct) : slAnchor * (1 + slPricePct);
        const userTpPrice = isLong ? price * (1 + tpPricePct) : price * (1 - tpPricePct);
        const userTp3Price = isLong ? price * (1 + tpPricePct * 2.0) : price * (1 - tpPricePct * 2.0);

        let account, wallet, openPosCount;
        // Hoisted so the outer catch can detect EXCHANGE ONLY (order on exchange, no DB record).
        // qty and slPrice also hoisted so the emergency INSERT in the catch can use them.
        let orderOnExchange = false;
        let tradeDbInserted = false;
        let qty, slPrice;

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

          // Position sizing: walletSizePct of wallet, adjusted by AI hour learning, capped by max_loss.
          // Consecutive-loss soft reduction (Freqtrade drawdown-protection pattern):
          //   1 loss  → 0.70× size (reduce before pausing)
          //   2 losses → 0.50× size
          //   ≥ max_consec_loss → pause (existing behaviour)
          const consecData = _consecLosses.get(key.id) || { count: 0 };
          const consecSizeMod = consecData.count >= 2 ? 0.50 : consecData.count >= 1 ? 0.70 : 1.0;
          const sizeMod = (pick.sizeMod || 1.0) * consecSizeMod;
          let tradeUsdt = wallet * walletSizePct * sizeMod;
          if (sizeMod !== 1.0) {
            const reason = consecData.count > 0
              ? `consec-loss(${consecData.count}) ×${consecSizeMod}`
              : `score-confidence ×${(pick.sizeMod || 1.0).toFixed(2)}`;
            userLog.trade(`User ${key.email}: sizing adjusted — ${reason} → final ×${sizeMod.toFixed(2)}`);
          }
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
          // Paper trading mode (AI-Trader pattern) — simulate without real API calls.
          // Enable with PAPER_TRADING=true env var. Logs to DB with paper flag so P&L can be tracked.
          if (process.env.PAPER_TRADING === 'true') {
            userLog.trade(`User ${key.email}: [PAPER] MARKET ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty} @ $${price} — skipping real order`);
            await notify(`📄 *Paper Trade*: ${symbol} ${pick.direction} qty=${qty} @ $${price} (simulated)`);
          } else {
            await userClient.submitNewOrder({ symbol, side: isLong ? 'BUY' : 'SELL', type: 'MARKET', quantity: qty });
          }

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

          // SMC-PRO: store tp1 as soft target, tp2 as runner target (monitored in syncTradeStatus)
          const isSmcProBn = (pick.setupName || pick.setup || '').includes('SMC');
          const bnTpRef    = isSmcProBn && pick.tp1
            ? fmtP(pick.tp1)
            : (bnTpPrice ?? fmtP(userTpPrice));
          const bnTp2Ref   = isSmcProBn && pick.tp2 ? fmtP(pick.tp2) : 0;

          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
             trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m, market_structure, key_trailing_sl_step, setup, tp2_price)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13, $14, $15, $16, $17)`,
            [key.id, key.user_id, symbol, pick.direction, price, fmtP(slPrice), bnTpRef, qty, userLev,
             fmtP(slPrice),
             null, pick.structure?.tf3m || null, pick.structure?.tf1m || null,
             pick.marketStructure || null, userTrailStep,
             pick.setupName || pick.setup || null, bnTp2Ref]
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
            // Check if it's EXCHANGE ONLY (position on exchange but no matching DB open trade)
            const dbMatchPromise = db.query(
              `SELECT id FROM trades WHERE user_id = $1 AND symbol = $2 AND status = 'OPEN' LIMIT 1`,
              [key.user_id, symbol]
            ).catch(() => []);
            const dbMatch = await dbMatchPromise;
            const isExchangeOnly = dbMatch.length === 0;
            if (isExchangeOnly) {
              userLog.trade(`User ${key.email}: EXCHANGE ONLY ${symbol} position (on exchange, no DB record) — cannot open new trade. Use Emergency Close to clear it first.`);
            } else {
              userLog.trade(`User ${key.email}: already in ${symbol} position — skipping duplicate`);
            }
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
          qty = notionalUsdtBx / price;
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
          slPrice = isScenarioB ? null
            : (isRangeBounce && pick.sl) ? pick.sl
            : (isScenarioA   && pick.sl) ? pick.sl
            : initialSlPrice;

          try { await userClient.changeMarginMode(symbol, 'ISOLATION'); } catch (_) {}

          // Set leverage — MUST succeed before placing order.
          // Silent catch was hiding failures causing trades to open at wrong leverage.
          // Now: log the error and ABORT the trade if leverage cannot be confirmed.
          try {
            await userClient.changeLeverage(symbol, userLev);
            userLog.trade(`User ${key.email}: leverage set ${symbol} → ${userLev}x`);
          } catch (levErr) {
            userLog.trade(`User ${key.email}: ABORT — changeLeverage(${symbol}, ${userLev}x) failed: ${levErr.message}. Trade not placed.`);
            log(`changeLeverage FAILED for ${key.email} ${symbol} ${userLev}x: ${levErr.message}`);
            return;
          }

          // ── Order type: LIMIT at pattern level for SMC signals ──────
          // SMC signals carry `pick.level` = the actual structural price
          // (pivot low for LONG, pivot high for SHORT, break level for CHoCH).
          // Using LIMIT at that level ensures we enter AT the structure,
          // not wherever market is when the signal fires (avoids buying 77,200
          // when the real support is 76,700).
          //
          // LONG  limit: fills when ask ≤ level (price comes DOWN to our buy)
          // SHORT limit: fills when bid ≥ level (price comes UP to our sell)
          //
          // Limit orders expire automatically via the 15-min cancel check in
          // trail-watchdog. If price never reaches the level → order cancelled,
          // no loss taken. Better to miss a trade than enter at the wrong price.
          // ── Order type: LIMIT only for CHoCH (retest entry), MARKET for everything else ──
          // CHoCH: price just BROKE a level → place LIMIT at that level to enter on the RETEST.
          //        (e.g. price broke LH at 77,200 → LIMIT BUY at 77,200 waits for pullback)
          // HL/LL/LH/HH: price is ALREADY AT the pivot level (bounced, confirmed).
          //        PAT_TOL ensures signal fires only within 0.2% of the level.
          //        → MARKET fills immediately at the correct structural price.
          // Using LIMIT on HL/LL would never fill because price already bounced away.
          const rawLevel   = parseFloat(pick.level || pick.entry || price || 0);
          const isChoch    = (pick.smcContext?.pattern || pick.setupName || '').includes('CHoCH');
          const hasLevel   = rawLevel > 0 && pick.setupName;
          const useLimit   = hasLevel && isChoch;
          const bxOrderType  = useLimit ? 'LIMIT' : 'MARKET';
          const bxLimitPrice = useLimit ? parseFloat(rawLevel.toFixed(8)) : undefined;

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

          // Paper trading mode — simulate without real API calls.
          let order;
          if (process.env.PAPER_TRADING === 'true') {
            order = { orderId: `PAPER_${Date.now()}`, paper: true };
            userLog.trade(`User ${key.email}: [PAPER] Bitunix ${bxOrderType} ${isLong ? 'BUY' : 'SELL'} ${symbol} qty=${qty} — skipping real order`);
            await notify(`📄 *Paper Trade*: ${symbol} ${pick.direction} qty=${qty} @ $${price} (simulated)`);
          } else {
            order = await userClient.placeOrder(orderPayload);
            userLog.trade(`Bitunix order placed: ${JSON.stringify(order)}`);
          }

          // ── CRITICAL FLAG: order is on exchange — INSERT must happen ──────
          // Hoisted to outer try scope — outer catch reads these to do emergency INSERT
          // if placeOrder succeeded but anything below threw (EXCHANGE ONLY prevention).
          orderOnExchange = process.env.PAPER_TRADING !== 'true';

          // Mark dedup immediately after order — before DB INSERT.
          // Prevents a second key from opening the same trade if INSERT later fails.
          executedUserSymbols.add(dedupKey);

          // Wrap position lookup in its own try/catch.
          // If getOpenPositions throws after a successful placeOrder, pos/posId stay null
          // and we fall into the else-branch below which still INSERTs a DB record.
          // Without this, a lookup failure would jump to the outer catch and skip the INSERT,
          // leaving the position on Bitunix with no DB record (EXCHANGE ONLY).
          let pos = null, posId = null;
          try {
            await sleep(2000);
            const posRaw = await userClient.getOpenPositions(symbol);
            // Handle bare array OR wrapped response (positionList / list)
            const posArr = Array.isArray(posRaw) ? posRaw
              : (posRaw?.positionList || posRaw?.list || (posRaw && typeof posRaw === 'object' ? [posRaw] : []));
            pos   = posArr.find(p => p.symbol === symbol) || null;
            posId = pos ? (pos.positionId || pos.id) : null;
          } catch (posLookupErr) {
            userLog.error(`Bitunix getOpenPositions failed after order — will INSERT DB record with estimated entry: ${posLookupErr.message}`);
          }
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

            // Hard TP: only RANGE_BOUNCE and SCENARIO_A have a ceiling — store the actual TP price.
            // SMC-PRO: store tp1 as tp_price (soft TP1 level, monitored in software for partial close)
            //          and tp2 in tp2_price (runner target after SL moves to TP1).
            // All other setups trail freely — store 0.
            const isSmcPro = (pick.setupName || pick.setup || '').includes('SMC');
            const tpRef = (isScenarioA || isRangeBounce) && bxTpPrice
              ? bxTpPrice
              : (isSmcPro && pick.tp1 ? parseFloat(parseFloat(pick.tp1).toFixed(8)) : 0);
            const tp2Ref = isSmcPro && pick.tp2 ? parseFloat(parseFloat(pick.tp2).toFixed(8)) : 0;

            const insertedRows = await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
               trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m, market_structure, key_trailing_sl_step, bitunix_position_id, setup, tp2_price)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13, $14, $15, $16, $17, $18)
               RETURNING id`,
              [key.id, key.user_id, symbol, pick.direction, actualEntry,
               slFmtActual || 0, parseFloat(tpRef.toFixed(8)), qty, userLev,
               slFmtActual || 0,
               null, pick.structure?.tf3m || null, pick.structure?.tf1m || null,
               pick.marketStructure || null, userTrailStep, posId || null,
               pick.setupName || pick.setup || null, tp2Ref]
            );
            tradeDbInserted = true;
            const insertedTradeId = insertedRows[0]?.id || null;

            // Trigger copy trades for followers of this user / AI signal
            try {
              const { triggerCopyTrades } = require('./copy-trade-engine');
              await triggerCopyTrades(
                {
                  id: insertedTradeId, symbol, direction: pick.direction,
                  entry_price: actualEntry, sl_price: slFmtActual,
                  tp_price: tpRef, quantity: qty, leverage: userLev,
                  setup: pick.setupName || pick.setup || 'V4-SMC',
                  bitunix_position_id: posId || null, is_ai_trade: true,
                },
                key,
                { id: key.user_id, email: key.email }
              );
            } catch (copyErr) {
              userLog.error(`Copy trade trigger failed: ${copyErr.message}`);
            }
          } else if (bxOrderType === 'LIMIT' && bxLimitPrice) {
            // ── LIMIT order placed but not yet filled ──────────────
            // This is expected — position won't exist until price reaches the limit.
            // Insert as PENDING_LIMIT so syncTradeStatus can promote it to OPEN when filled,
            // or cancel it after 15 min (one 15M candle) if price never reaches the level.
            // orderId stored in market_structure field for cancel lookup.
            const isSmcPL = (pick.setupName || pick.setup || '').includes('SMC');
            const tp1PL  = isSmcPL && pick.tp1 ? parseFloat(parseFloat(pick.tp1).toFixed(8)) : 0;
            const tp2PL  = isSmcPL && pick.tp2 ? parseFloat(parseFloat(pick.tp2).toFixed(8)) : 0;
            await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
               trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m, market_structure, key_trailing_sl_step, setup, tp2_price)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_LIMIT', $10, 0, $11, $12, $13, $14, $15, $16, $17)`,
              [key.id, key.user_id, symbol, pick.direction, bxLimitPrice,
               parseFloat((slPrice ?? 0).toFixed(8)), tp1PL, qty, userLev, parseFloat((slPrice ?? 0).toFixed(8)),
               null, pick.structure?.tf3m || null, pick.structure?.tf1m || null,
               `LIMIT_ORDER:${order?.orderId || '?'}`, userTrailStep,
               pick.setupName || pick.setup || null, tp2PL]
            );
            tradeDbInserted = true;
            userLog.trade(`${key.email}: LIMIT order pending @ $${bxLimitPrice} — waiting for fill (orderId=${order?.orderId})`);
            await notify(`*Bitunix ${symbol}*\nLimit ${isLong ? 'BUY' : 'SELL'} @ $${bxLimitPrice} — waiting for price to reach level`);
          } else {
            userLog.error(`Bitunix position not found after order — verify on exchange`);
            await notify(`*Bitunix ${symbol}*\nOrder placed but position not found. Check Bitunix manually.`);

            const isSmcProFb = (pick.setupName || pick.setup || '').includes('SMC');
            const tp1Fb  = isSmcProFb && pick.tp1 ? parseFloat(parseFloat(pick.tp1).toFixed(8)) : 0;
            const tp2Fb  = isSmcProFb && pick.tp2 ? parseFloat(parseFloat(pick.tp2).toFixed(8)) : 0;
            await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status,
               trailing_sl_price, trailing_sl_last_step, tf_15m, tf_3m, tf_1m, market_structure, key_trailing_sl_step, setup, tp2_price)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, $12, $13, $14, $15, $16, $17)`,
              [key.id, key.user_id, symbol, pick.direction, price,
               parseFloat((slPrice ?? 0).toFixed(8)), tp1Fb, qty, userLev, parseFloat((slPrice ?? 0).toFixed(8)),
               null, pick.structure?.tf3m || null, pick.structure?.tf1m || null,
               pick.marketStructure || null, userTrailStep,
               pick.setupName || pick.setup || null, tp2Fb]
            );
            tradeDbInserted = true;
          }
          userLog.trade(`Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev} qty=${qty}`);
          log(`Bitunix OK: ${key.email} ${symbol} ${pick.direction} x${userLev}`);
        } else {
          userLog.error(`User ${key.email}: unknown platform "${key.platform}"`);
        }
      } catch (err) {
        userLog.error(`User ${key.email} trade error: ${err.message}`);
        log(`User ${key.email} trade error: ${err.message}`);
        // Emergency INSERT: order landed on exchange but something after placeOrder threw
        // (position lookup failure, SL submission error, DB connection timeout, etc.).
        // Without this, the position stays on exchange with no DB record → EXCHANGE ONLY.
        if (orderOnExchange && !tradeDbInserted) {
          try {
            const emergencySl = slPrice ? parseFloat(slPrice.toFixed(8)) : 0;
            await db.query(
              `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, quantity, leverage, status, setup)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', $9)`,
              [key.id, key.user_id, symbol, pick.direction, price,
               emergencySl, qty, userLev,
               pick.setupName || pick.setup || 'V4-SMC']
            );
            userLog.trade(`EMERGENCY DB INSERT OK: ${symbol} ${pick.direction} — order was on exchange but regular INSERT failed (${err.message})`);
          } catch (e2) {
            userLog.error(`EMERGENCY INSERT FAILED for ${symbol}: ${e2.message} — EXCHANGE ONLY POSITION!`);
            await notify(`🚨 EXCHANGE ONLY: ${symbol} ${pick.direction} is on exchange but has NO DB record!\nOriginal error: ${err.message}\nEmergency insert error: ${e2.message}\nFix manually in DB.`);
          }
        }
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

// ── HARD SYNC: RECONCILE EXCHANGE POSITIONS WITH DB ─────────────
// Runs at startup and every cycle.
// For every enabled Bitunix key (even keys with zero DB trades):
//   1. Fetch all open positions from exchange
//   2. UPSERT each position (keyed on bitunix_position_id, fallback symbol+direction)
//   3. Detect ghost DB trades (OPEN in DB but gone from exchange) and mark GHOST
async function hardSyncExchangeDB() {
  let db, cryptoUtils, BitunixClient;
  try {
    db = require('./db');
    cryptoUtils = require('./crypto-utils');
    BitunixClient = require('./bitunix-client').BitunixClient;
  } catch (e) { return; }

  // All enabled Bitunix keys — no paused_by_user filter so we catch all live positions
  let keys;
  try {
    keys = await db.query(
      `SELECT ak.*, u.email, u.is_admin
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true
         AND ak.platform = 'bitunix'`
    );
  } catch (e) {
    bLog.error(`hardSyncExchangeDB: failed to fetch keys: ${e.message}`);
    return;
  }
  if (!keys.length) return;

  for (const key of keys) {
    try {
      const apiKey    = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
      const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
      const client    = new BitunixClient({ apiKey, apiSecret });

      const account   = await client.getAccountInformation();
      const positions = account.positions || [];

      // Build a set of exchange position keys for ghost detection
      const exchangeKeys = new Set(); // `${symbol}:${dir}` and posId

      for (const p of positions) {
        const rawAmt = parseFloat(p.positionAmt || p.qty || 0);
        if (!rawAmt) continue;

        const symbol      = p.symbol;
        const dir         = rawAmt > 0 ? 'LONG' : 'SHORT';
        const qty         = Math.abs(rawAmt);
        const entry       = parseFloat(p.avgOpenPrice || p.entryPrice || p.avgPrice || 0);
        const posId       = p.positionId || p.id || null;
        const exchangeLev = parseInt(p.leverage) || SYMBOL_LEVERAGE[symbol] || 100;
        if (!entry) continue;

        exchangeKeys.add(`${symbol}:${dir}`);
        if (posId) exchangeKeys.add(`posid:${posId}`);

        const isLong     = dir === 'LONG';
        const slPct      = SL_PCT / exchangeLev;
        const recoverySl = parseFloat((isLong
          ? entry * (1 - slPct)
          : entry * (1 + slPct)
        ).toFixed(8));

        // ── Attempt UPSERT keyed on bitunix_position_id ───────────────
        let upserted = false;
        if (posId) {
          try {
            const upsertRows = await db.query(
              `INSERT INTO trades
                 (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price,
                  quantity, leverage, status, trailing_sl_price, trailing_sl_last_step,
                  bitunix_position_id, setup)
               VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 'OPEN', $9, 0, $10, 'V4-SMC-RECOVERY')
               ON CONFLICT (bitunix_position_id) WHERE bitunix_position_id IS NOT NULL AND status = 'OPEN'
               DO UPDATE SET
                 leverage    = EXCLUDED.leverage,
                 quantity    = EXCLUDED.quantity,
                 entry_price = EXCLUDED.entry_price
               WHERE trades.status = 'OPEN'
               RETURNING id, xmax, leverage AS prev_lev`,
              [key.id, key.user_id, symbol, dir, entry, recoverySl,
               qty, exchangeLev, recoverySl, posId]
            );
            if (upsertRows.length > 0) {
              upserted = true;
              const row = upsertRows[0];
              const isInsert = parseInt(row.xmax) === 0;
              if (isInsert) {
                const msg = `🔧 SYNC: new position recorded ${symbol} ${dir} x${exchangeLev} entry=$${entry}`;
                log(msg);
                bLog.trade(msg);
                await notify(
                  `🔧 *SYNC: New Position Recorded*\n` +
                  `${symbol} *${dir}* x${exchangeLev} (${key.email})\n` +
                  `Entry: \`$${entry}\`  Qty: ${qty}\n` +
                  `Recovery SL: \`$${recoverySl}\``
                );
                if (syncTradeStatus._alertedUnmanaged) {
                  syncTradeStatus._alertedUnmanaged.delete(`${key.id}:${symbol}:${dir}:${entry}`);
                }
              } else {
                // xmax > 0 means UPDATE — leverage may have been corrected
                const prevLev = parseInt(row.prev_lev) || exchangeLev;
                if (prevLev !== exchangeLev) {
                  log(`📊 SYNC: leverage corrected ${prevLev}→${exchangeLev} for ${symbol} ${dir} (key #${key.id})`);
                }
              }
            }
          } catch (upsertErr) {
            bLog.error(`hardSyncExchangeDB UPSERT ${symbol} ${dir}: ${upsertErr.message}`);
          }
        }

        // ── Fallback: no posId or UPSERT didn't create/update — check by symbol+dir ──
        if (!upserted) {
          const existing = await db.query(
            `SELECT id FROM trades
             WHERE api_key_id = $1 AND symbol = $2 AND direction = $3 AND status = 'OPEN'
             LIMIT 1`,
            [key.id, symbol, dir]
          );
          if (!existing.length) {
            try {
              await db.query(
                `INSERT INTO trades
                   (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price,
                    quantity, leverage, status, trailing_sl_price, trailing_sl_last_step,
                    bitunix_position_id, setup)
                 VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 'OPEN', $9, 0, $10, 'V4-SMC-RECOVERY')`,
                [key.id, key.user_id, symbol, dir, entry, recoverySl,
                 qty, exchangeLev, recoverySl, posId || null]
              );
              const msg = `🔧 SYNC: new position recorded ${symbol} ${dir} x${exchangeLev} entry=$${entry}`;
              log(msg);
              bLog.trade(msg);
              await notify(
                `🔧 *SYNC: New Position Recorded*\n` +
                `${symbol} *${dir}* x${exchangeLev} (${key.email})\n` +
                `Entry: \`$${entry}\`  Qty: ${qty}\n` +
                `Recovery SL: \`$${recoverySl}\``
              );
              if (syncTradeStatus._alertedUnmanaged) {
                syncTradeStatus._alertedUnmanaged.delete(`${key.id}:${symbol}:${dir}:${entry}`);
              }
            } catch (insertErr) {
              bLog.error(`hardSyncExchangeDB INSERT ${symbol} ${dir}: ${insertErr.message}`);
            }
          }
        }
      }

      // ── Ghost detection: DB OPEN trades with no matching exchange position ──
      // Only mark as GHOST if the trade is > 5 minutes old (avoid race with new trades)
      const dbOpenTrades = await db.query(
        `SELECT id, symbol, direction, bitunix_position_id
         FROM trades
         WHERE api_key_id = $1 AND status = 'OPEN'
           AND created_at < NOW() - INTERVAL '5 minutes'`,
        [key.id]
      );

      for (const t of dbOpenTrades) {
        const symDirKey = `${t.symbol}:${t.direction}`;
        const posIdKey  = t.bitunix_position_id ? `posid:${t.bitunix_position_id}` : null;
        const onExchange = exchangeKeys.has(symDirKey) || (posIdKey && exchangeKeys.has(posIdKey));

        if (!onExchange) {
          try {
            await db.query(
              `UPDATE trades SET status = 'GHOST', closed_at = NOW()
               WHERE id = $1 AND status = 'OPEN'`,
              [t.id]
            );
            const msg = `👻 GHOST: ${t.symbol} ${t.direction} — closed on exchange but DB showed OPEN (id=${t.id})`;
            log(msg);
            bLog.trade(msg);
            await notify(
              `👻 *Ghost Trade Detected*\n` +
              `${t.symbol} *${t.direction}* (${key.email})\n` +
              `Trade id=${t.id} was OPEN in DB but has no matching exchange position.\n` +
              `Marked as GHOST — excluded from tracking.`
            );
          } catch (ghostErr) {
            bLog.error(`hardSyncExchangeDB GHOST update id=${t.id}: ${ghostErr.message}`);
          }
        }
      }
    } catch (keyErr) {
      bLog.error(`hardSyncExchangeDB key #${key.id} ${key.email}: ${keyErr.message}`);
    }
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

  // ── PENDING_LIMIT: check if limit orders have filled or need cancelling ──
  // Runs before the main OPEN trade sync. For each pending limit:
  //   • If position now exists on exchange → promote to OPEN
  //   • If order is > 15 min old and still pending → cancel on exchange + mark CANCELLED
  try {
    const pendingLimits = await db.query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag, ak.platform
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE t.status = 'PENDING_LIMIT' AND ak.platform = 'bitunix'`
    );

    for (const pl of pendingLimits) {
      try {
        const apiKey    = cryptoUtils.decrypt(pl.api_key_enc, pl.iv, pl.auth_tag);
        const apiSecret = cryptoUtils.decrypt(pl.api_secret_enc, pl.secret_iv, pl.secret_auth_tag);
        const client    = new BitunixClient({ apiKey, apiSecret });
        const symbol    = pl.symbol;

        // Check if the position opened (limit order filled)
        const posRaw = await client.getOpenPositions(symbol).catch(() => []);
        const posArr = Array.isArray(posRaw) ? posRaw : (posRaw?.positionList || posRaw?.list || []);
        const pos    = posArr.find(p => p.symbol === symbol);

        if (pos) {
          // Limit order filled — promote to OPEN
          const actualEntry = parseFloat(pos.avgOpenPrice || pos.entryPrice || pos.avgPrice) || parseFloat(pl.entry_price);
          // Use the structural SL stored at PENDING_LIMIT insert time, not a hardcoded %.
          // The sl_price from the signal already reflects the correct structural level.
          await db.query(
            `UPDATE trades SET status='OPEN', entry_price=$1, trailing_sl_price=$2 WHERE id=$3`,
            [actualEntry, parseFloat(pl.sl_price || 0), pl.id]
          );
          log(`LIMIT FILLED: ${symbol} ${pl.direction} @ $${actualEntry} — promoted to OPEN`);
          await notify(`✅ *Limit filled*: ${symbol} ${pl.direction} @ $${actualEntry}`);
          continue;
        }

        // Not filled — check age
        const ageMs = Date.now() - new Date(pl.created_at).getTime();
        if (ageMs > 15 * 60_000) {
          // 15 min expired — cancel the order on exchange
          const orderIdMatch = (pl.market_structure || '').match(/LIMIT_ORDER:(\S+)/);
          if (orderIdMatch) {
            try {
              await client.cancelOrder({ symbol, orderId: orderIdMatch[1] });
              log(`LIMIT CANCELLED (15 min expired): ${symbol} ${pl.direction} orderId=${orderIdMatch[1]}`);
            } catch (cancelErr) {
              log(`LIMIT cancel failed: ${symbol} ${cancelErr.message}`);
            }
          }
          await db.query(`UPDATE trades SET status='CANCELLED', closed_at=NOW() WHERE id=$1`, [pl.id]);
          await notify(`⏱ *Limit expired*: ${symbol} ${pl.direction} @ $${pl.entry_price} — cancelled (15 min, price never reached level)`);
        }
      } catch (plErr) {
        log(`PENDING_LIMIT check error: ${pl.symbol} — ${plErr.message}`);
      }
    }
  } catch (plBatchErr) {
    log(`PENDING_LIMIT batch error: ${plBatchErr.message}`);
  }

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
                  // Compute approximate exit price from Binance unrealized PnL
                  const _swarmIsLong = trade.direction !== 'SHORT';
                  const _swarmEntry  = parseFloat(trade.entry_price) || exchangePos.entryPrice || 0;
                  const _swarmAmt    = Math.abs(exchangePos.amt) || 1;
                  const _swarmCurPx  = _swarmEntry > 0
                    ? (_swarmIsLong
                        ? _swarmEntry + exchangePos.pnl / _swarmAmt
                        : _swarmEntry - exchangePos.pnl / _swarmAmt)
                    : null;
                  const _swarmStatus = exchangePos.pnl >= 0 ? 'WIN' : 'LOSS';
                  await db.query(
                    `UPDATE trades SET status = $1, exit_reason = 'swarm_consensus_shift',
                     exit_price = COALESCE($2, exit_price),
                     pnl_usdt   = COALESCE(pnl_usdt, $3),
                     closed_at  = NOW()
                     WHERE id = $4`,
                    [_swarmStatus, _swarmCurPx ? parseFloat(_swarmCurPx.toFixed(4)) : null, parseFloat(exchangePos.pnl.toFixed(4)), trade.id]
                  );
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
              const tradeLev = parseFloat(trade.leverage) || SYMBOL_LEVERAGE[trade.symbol] || 100;
              const userTrailPct = parseFloat(trade.key_trailing_sl_step) || 0;
              const pricePctDebug = isLong
                ? (curPrice - entryPrice) / entryPrice
                : (entryPrice - curPrice) / entryPrice;
              const capitalPctDebug = pricePctDebug * tradeLev;
              const binSlPrec = inferPricePrec(trade.sl_price);
              const currentSlBin = parseFloat(trade.trailing_sl_price) || parseFloat(trade.sl_price) || 0;
              bLog.trade(`Binance trail check: ${trade.symbol} cur=$${fmtPrice(curPrice)} entry=$${entryPrice} pricePct=${(pricePctDebug*100).toFixed(3)}% capitalPct=${(capitalPctDebug*100).toFixed(2)}% lev=${tradeLev}x currentSL=$${currentSlBin.toFixed(binSlPrec)}`);

              // ── SMC TP1-hit (Binance): close 50%, lock SL at TP1, ride runner to TP2 ──
              const bnSmcTp1 = parseFloat(trade.tp_price)  || 0;
              const bnSmcTp2 = parseFloat(trade.tp2_price) || 0;
              const bnTp1Hit = trade.smc_tp1_hit === true || trade.smc_tp1_hit === 't';

              if (bnSmcTp1 > 0 && bnSmcTp2 > 0 && !bnTp1Hit) {
                const tp1Reached = isLong ? curPrice >= bnSmcTp1 : curPrice <= bnSmcTp1;
                if (tp1Reached) {
                  bLog.trade(`[SMC-TP1-BN] ${trade.symbol} TP1 hit @ $${curPrice} — closing 50%, locking SL at TP1`);
                  const closeSideBn = isLong ? 'SELL' : 'BUY';
                  const curAmtBn    = Math.abs(exchangePos.amt);
                  const closeQtyBn  = Math.floor(curAmtBn * 0.5 * 1e8) / 1e8;

                  try {
                    if (closeQtyBn > 0) {
                      await userClient.submitNewOrder({ symbol: trade.symbol, side: closeSideBn, type: 'MARKET', quantity: closeQtyBn, reduceOnly: true });
                      bLog.trade(`[SMC-TP1-BN] ${trade.symbol} 50% closed (qty=${closeQtyBn})`);
                    }
                  } catch (bnTp1CloseErr) {
                    bLog.error(`[SMC-TP1-BN] ${trade.symbol} 50% close failed: ${bnTp1CloseErr.message}`);
                  }

                  try {
                    const bnSlFmt = parseFloat(bnSmcTp1.toFixed(binSlPrec));
                    await updateStopLoss(userClient, trade.symbol, bnSlFmt, closeSideBn, 'binance', binSlPrec, bnSmcTp2 || undefined);
                    bLog.trade(`[SMC-TP1-BN] ${trade.symbol} SL locked at TP1=$${bnSlFmt}`);
                  } catch (bnTp1SlErr) {
                    bLog.error(`[SMC-TP1-BN] ${trade.symbol} SL move to TP1 failed: ${bnTp1SlErr.message}`);
                  }

                  try {
                    await db.query(
                      `UPDATE trades SET smc_tp1_hit = true, trailing_sl_price = $1, sl_price = $1, tp_price = $2 WHERE id = $3`,
                      [bnSmcTp1, bnSmcTp2, trade.id]
                    );
                  } catch (bnTp1DbErr) {
                    bLog.error(`[SMC-TP1-BN] ${trade.symbol} DB update failed: ${bnTp1DbErr.message}`);
                  }

                  await notify(
                    `✅ *SMC TP1 Hit!* — *${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                    `Closed 50% @ \`$${fmtPrice(curPrice)}\`\n` +
                    `SL locked at TP1 \`$${fmtPrice(bnSmcTp1)}\` — zero-risk runner\n` +
                    `Riding 50% → TP2 \`$${fmtPrice(bnSmcTp2)}\``
                  );
                  continue;
                }
              }

              // ── SMC TP2-hit (Binance): close remaining runner ──
              if (bnSmcTp1 > 0 && bnSmcTp2 > 0 && bnTp1Hit) {
                const tp2Reached = isLong ? curPrice >= bnSmcTp2 : curPrice <= bnSmcTp2;
                if (tp2Reached) {
                  bLog.trade(`[SMC-TP2-BN] ${trade.symbol} TP2 hit @ $${curPrice} — closing remaining`);
                  const closeSideBn2 = isLong ? 'SELL' : 'BUY';
                  try {
                    await userClient.submitNewOrder({ symbol: trade.symbol, side: closeSideBn2, type: 'MARKET', quantity: Math.abs(exchangePos.amt), reduceOnly: true });
                    await db.query(
                      `UPDATE trades SET status = 'WIN', exit_reason = 'smc_tp2',
                       exit_price = $1, closed_at = NOW() WHERE id = $2`,
                      [parseFloat(curPrice.toFixed(4)), trade.id]
                    );
                    await notify(
                      `🎯 *SMC TP2 Hit!* — *${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                      `Runner closed @ \`$${fmtPrice(curPrice)}\` — trade complete`
                    );
                  } catch (bnTp2Err) {
                    bLog.error(`[SMC-TP2-BN] ${trade.symbol} runner close failed: ${bnTp2Err.message}`);
                  }
                  continue;
                }
              }

              // ── Candle-low trail: move SL to last completed 15m candle low/high ──
              let binNewSl = null;
              let binSlSource = '';
              const binCandleTrail = await calcCandleTrailSl(trade.symbol, isLong, currentSlBin);
              if (binCandleTrail && pricePctDebug > 0.002) {
                binNewSl = binCandleTrail.newSl;
                binSlSource = binCandleTrail.source;
              }

              // ── Fallback: tier-based if candle trail didn't fire ──
              // smcMode disabled: V4 SMC uses the full tier table at every step.
              // smcMode was for the old 3-timing strategy (no longer active).
              if (!binNewSl) {
                const trailResult = calculateTrailingStep(entryPrice, curPrice, isLong, lastStep, tradeLev, userTrailPct, false);
                if (trailResult) { binNewSl = trailResult.newSlPrice; binSlSource = 'tier'; }
              }

              if (binNewSl) {
                const closeSide = isLong ? 'SELL' : 'BUY';
                bLog.trade(`Binance trailing SL (${binSlSource}): ${trade.symbol} → newSL=$${binNewSl.toFixed(binSlPrec)}`);
                let slUpdated = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                  try {
                    // Only hard TP for RANGE_BOUNCE / SCENARIO_A — V4/SMC trails freely
                    const bnHasHardTp = trade.setup === 'RANGE_BOUNCE' || trade.setup === 'SCENARIO_A';
                    const userTp = bnHasHardTp ? (parseFloat(trade.tp_price) || 0) : 0;
                    slUpdated = await updateStopLoss(userClient, trade.symbol, binNewSl, closeSide, 'binance', binSlPrec, userTp || undefined);
                    if (slUpdated) break;
                  } catch (e) {
                    bLog.error(`WATCHDOG: Binance SL update failed for ${trade.symbol} attempt ${attempt}/3: ${e.message}`);
                    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
                  }
                }
                if (slUpdated) {
                  const tierRes = binSlSource === 'tier'
                    ? calculateTrailingStep(entryPrice, curPrice, isLong, lastStep, tradeLev, 0, false)
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

          // ── Exchange-Only inline repair (runs every sync tick) ──────
          // Every position on exchange MUST have a DB record so the bot
          // can trail-stop it. If it's missing (EXCHANGE ONLY), INSERT now.
          // hardSyncExchangeDB also runs every cycle, but this provides an
          // additional in-loop safety net while iterating active positions.
          syncTradeStatus._alertedUnmanaged = syncTradeStatus._alertedUnmanaged || new Set();
          for (const p of (account.positions || [])) {
            const rawAmt = parseFloat(p.positionAmt || p.qty || 0);
            if (!rawAmt) continue;
            const dir = rawAmt > 0 ? 'LONG' : 'SHORT';
            // Refresh: check DB directly (trades list may be stale if INSERT happened above)
            const matched = trades.some(t =>
              t.symbol === p.symbol && (t.direction || 'LONG') === dir
            );
            if (matched) continue;

            const sym   = p.symbol;
            const qty   = Math.abs(rawAmt);
            const entry = parseFloat(p.avgOpenPrice || p.entryPrice || p.avgPrice || 0);
            const posId = p.positionId || p.id || null;
            if (!entry) continue;

            const dedupKey = `${key.id}:${sym}:${dir}:${entry}`;
            if (syncTradeStatus._alertedUnmanaged.has(dedupKey)) continue;
            syncTradeStatus._alertedUnmanaged.add(dedupKey);

            // AUTO-INSERT: every position must be in DB — no exceptions
            const lev       = SYMBOL_LEVERAGE[sym] || parseInt(p.leverage) || 100;
            const isLong    = dir === 'LONG';
            const slPct     = SL_PCT / lev;
            const recoverySl = parseFloat((isLong
              ? entry * (1 - slPct)
              : entry * (1 + slPct)
            ).toFixed(8));

            try {
              // Double-check DB before inserting (repairExchangeOnly may have just run)
              const alreadyInserted = await db.query(
                `SELECT id FROM trades WHERE api_key_id = $1 AND symbol = $2 AND direction = $3 AND status = 'OPEN' LIMIT 1`,
                [key.id, sym, dir]
              );
              if (alreadyInserted.length > 0) continue;

              await db.query(
                `INSERT INTO trades
                   (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price,
                    quantity, leverage, status, trailing_sl_price, trailing_sl_last_step,
                    bitunix_position_id, setup)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10, 0, $11, 'V4-SMC-RECOVERY')`,
                [key.id, key.user_id, sym, dir, entry, recoverySl, 0,
                 qty, lev, recoverySl, posId || null]
              );
              bLog.trade(`SYNC-REPAIR: Inserted missing DB record for ${sym} ${dir} x${lev} entry=$${entry}`);
              await notify(
                `🔧 *Sync Repair: DB Record Created*\n` +
                `${sym} *${dir}* x${lev} (${key.email})\n` +
                `Entry: \`$${entry}\`  Qty: ${qty}\n` +
                `Recovery SL: \`$${recoverySl}\`\n` +
                `Position found on exchange with no DB record — now tracked.`
              );
            } catch (repairErr) {
              bLog.error(`SYNC-REPAIR INSERT FAILED ${sym} ${dir}: ${repairErr.message}`);
            }
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
              // Only carry TP for hard-TP setups — SMC/V4 trails freely, no ceiling
              const reconfirmHardTp = trade.setup === 'RANGE_BOUNCE' || trade.setup === 'SCENARIO_A';
              const reconfirmTp = reconfirmHardTp ? (parseFloat(trade.tp_price) || undefined) : undefined;
              const ok = await updateStopLoss(userClient, trade.symbol, slPrice, null, 'bitunix', slPrec, reconfirmTp);
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
              // Use stored leverage; fall back to strategy config, then 100 (not 20).
              // Defaulting to 20 when DB value is missing causes 100x positions to
              // calculate capitalPct at 1/5 the real value — tiers never fire.
              const tradeLev = parseFloat(trade.leverage) || SYMBOL_LEVERAGE[trade.symbol] || 100;

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

              // ── Profit calculation (used by TP1/TP2 and trail below) ──
              const profitPct = isLong
                ? (curPrice - entryPrice) / entryPrice
                : (entryPrice - curPrice) / entryPrice;
              const capitalPct = profitPct * tradeLev;
              const lastStep   = parseFloat(trade.trailing_sl_last_step) || 0;

              bLog.trade(`Bitunix trailing: ${trade.symbol} entry=$${entryPrice} cur=$${curPrice} pricePct=${(profitPct*100).toFixed(3)}% capitalPct=${(capitalPct*100).toFixed(2)}% lev=${tradeLev}x lastStep=${(lastStep*100).toFixed(1)}%`);

              // ── SMC TP1: +60% capital → close 50%, lock SL at +59% capital ──
              // ── SMC TP2: +100% capital → close remaining 50% ──
              // Capital-% based so the trigger scales correctly with leverage.
              // At 125x: TP1 = +0.48% price (+60% cap), TP2 = +0.80% price (+100% cap).
              // At  75x: TP1 = +0.80% price (+60% cap), TP2 = +1.33% price (+100% cap).
              const TP1_CAPITAL = 0.60; // +60% capital
              const TP2_CAPITAL = 1.00; // +100% capital
              const SL_AT_TP1   = 0.45; // lock SL at +45% capital after TP1 hit

              const tp1AlreadyHit = trade.smc_tp1_hit === true || trade.smc_tp1_hit === 't';

              if (!tp1AlreadyHit && capitalPct >= TP1_CAPITAL) {
                bLog.trade(`[SMC-TP1] ${trade.symbol} TP1 hit @ $${curPrice} (capital=+${(capitalPct*100).toFixed(1)}%) — closing 50%, locking SL at +${SL_AT_TP1*100}% capital`);
                const bxSlPrecTp   = inferPricePrec(trade.sl_price);
                const closeSideTp  = isLong ? 'SELL' : 'BUY';
                const closeQtyTp   = Math.floor(Math.abs(exchangePos.amt) * 0.5 * 1e8) / 1e8;
                const slCapPricePct = SL_AT_TP1 / tradeLev;
                const slAtTp1Price  = isLong
                  ? entryPrice * (1 + slCapPricePct)
                  : entryPrice * (1 - slCapPricePct);
                const slTp1Fmt = parseFloat(slAtTp1Price.toFixed(bxSlPrecTp));

                // 1. Close 50%
                try {
                  if (closeQtyTp > 0) {
                    await userClient.placeOrder({
                      symbol: trade.symbol,
                      side: closeSideTp,
                      qty: String(closeQtyTp),
                      orderType: 'MARKET',
                      tradeSide: 'CLOSE',
                    });
                    bLog.trade(`[SMC-TP1] ${trade.symbol} 50% closed (qty=${closeQtyTp})`);
                  }
                } catch (tp1CloseErr) {
                  bLog.error(`[SMC-TP1] ${trade.symbol} 50% close failed: ${tp1CloseErr.message}`);
                }

                // 2. Lock SL at +59% capital
                try {
                  await updateStopLoss(userClient, trade.symbol, slTp1Fmt, null, 'bitunix', bxSlPrecTp);
                  bLog.trade(`[SMC-TP1] ${trade.symbol} SL locked at +${SL_AT_TP1*100}%cap = $${slTp1Fmt}`);
                } catch (tp1SlErr) {
                  bLog.error(`[SMC-TP1] ${trade.symbol} SL lock failed: ${tp1SlErr.message}`);
                }

                // 3. Update DB: flag hit, advance last_step to 59% so trail ratchet knows the floor
                try {
                  await db.query(
                    `UPDATE trades SET smc_tp1_hit = true, trailing_sl_price = $1, sl_price = $1,
                     trailing_sl_last_step = $2 WHERE id = $3`,
                    [slTp1Fmt, SL_AT_TP1, trade.id]
                  );
                } catch (tp1DbErr) {
                  bLog.error(`[SMC-TP1] ${trade.symbol} DB update failed: ${tp1DbErr.message}`);
                }

                await notify(
                  `✅ *SMC TP1 Hit!* — *${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                  `Closed 50% @ \`$${fmtPrice(curPrice)}\` (+${(capitalPct*100).toFixed(1)}% capital)\n` +
                  `SL locked at +${SL_AT_TP1*100}%cap \`$${fmtPrice(slTp1Fmt)}\` — zero-risk runner\n` +
                  `Riding 50% → TP2 at +${TP2_CAPITAL*100}% capital`
                );
                continue; // skip regular trailing SL this cycle — SL already updated
              }

              if (tp1AlreadyHit && capitalPct >= TP2_CAPITAL) {
                bLog.trade(`[SMC-TP2] ${trade.symbol} TP2 hit @ $${curPrice} (capital=+${(capitalPct*100).toFixed(1)}%) — closing remaining`);
                const closeSideTp2 = isLong ? 'SELL' : 'BUY';
                try {
                  await userClient.placeOrder({
                    symbol: trade.symbol,
                    side: closeSideTp2,
                    qty: String(Math.abs(exchangePos.amt)),
                    orderType: 'MARKET',
                    tradeSide: 'CLOSE',
                  });
                  await db.query(
                    `UPDATE trades SET status = 'WIN', exit_reason = 'smc_tp2',
                     exit_price = $1, closed_at = NOW() WHERE id = $2`,
                    [parseFloat(curPrice.toFixed(4)), trade.id]
                  );
                  await notify(
                    `🎯 *SMC TP2 Hit!* — *${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                    `Full position closed @ \`$${fmtPrice(curPrice)}\` (+${(capitalPct*100).toFixed(1)}% capital)\n` +
                    `TP2 at +${TP2_CAPITAL*100}% capital reached — trade complete`
                  );
                } catch (tp2Err) {
                  bLog.error(`[SMC-TP2] ${trade.symbol} close failed: ${tp2Err.message}`);
                }
                continue;
              }

              // ── Step lock: +35% capital → SL moves to +20% capital ──────
              // One move only. No tier table. SL stays at +20% until TP1.
              const STEP_TRIGGER = 0.35;
              const STEP_LOCK    = 0.20;
              if (!tp1AlreadyHit && lastStep < STEP_LOCK && capitalPct >= STEP_TRIGGER) {
                const bxSlPrecStep  = inferPricePrec(trade.sl_price);
                const stepSlPricePct = STEP_LOCK / tradeLev;
                const stepSlPrice    = isLong
                  ? entryPrice * (1 + stepSlPricePct)
                  : entryPrice * (1 - stepSlPricePct);
                const stepSlFmt = parseFloat(stepSlPrice.toFixed(bxSlPrecStep));

                try {
                  await updateStopLoss(userClient, trade.symbol, stepSlFmt, null, 'bitunix', bxSlPrecStep);
                  bLog.trade(`[STEP-LOCK] ${trade.symbol} +35% capital → SL locked at +20% capital = $${stepSlFmt}`);
                } catch (stepErr) {
                  bLog.error(`[STEP-LOCK] ${trade.symbol} SL update failed: ${stepErr.message}`);
                }
                try {
                  await db.query(
                    `UPDATE trades SET trailing_sl_price = $1, sl_price = $1, trailing_sl_last_step = $2 WHERE id = $3`,
                    [stepSlFmt, STEP_LOCK, trade.id]
                  );
                } catch (stepDbErr) {
                  bLog.error(`[STEP-LOCK] ${trade.symbol} DB update failed: ${stepDbErr.message}`);
                }
                await notify(
                  `🔒 *Step Lock* — *${trade.symbol}* ${isLong ? 'LONG' : 'SHORT'}\n` +
                  `+${(capitalPct*100).toFixed(1)}% capital reached\n` +
                  `SL locked at +${STEP_LOCK*100}% capital \`$${fmtPrice(stepSlFmt)}\``
                );
                continue;
              }

              // SL stays fixed — waiting for TP1
              bLog.trade(`Bitunix: ${trade.symbol} waiting for TP1 (${(capitalPct*100).toFixed(1)}%/${TP1_CAPITAL*100}% capital) — SL fixed`);
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
                const positions = await bxClient.getHistoryPositions({ symbol: trade.symbol, pageSize: 50, all: true });
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
                  tradingFee  = Math.abs(parseFloat(p.fee || p.tradingFee || p.tradeFee || p.trade_fee || p.closeFee || p.close_fee || p.commission || p.openFee || p.open_fee || 0));
                  fundingFee  = Math.abs(parseFloat(p.funding || p.fundingFee || p.fund_fee || p.fundFee || 0));
                  const pnlRaw = p.realizedPNL ?? p.realizedPnl ?? p.realPNL ?? p.realPnl ?? p.pnl ?? p.profit ?? p.netPnl ?? p.net_pnl ?? null;
                  realizedPnl = pnlRaw != null ? parseFloat(pnlRaw) : null;

                  if (cp > 0) {
                    // Position history gave a non-zero closePrice — store it as a candidate.
                    // We still run Method 2 (order history) below when positionId is stored,
                    // because Bitunix sometimes returns a wrong non-zero closePrice here.
                    // Order fill avgPrice is ground truth; positionId match overrides this value.
                    exitPrice = cp;
                    found = true;
                    foundPnl = (realizedPnl !== null);
                    bLog.system(`[SYNC] MATCH trade#${trade.id} ${trade.symbol}: entry=${ep} exit=${cp} pnl=${realizedPnl} fee=${tradingFee} funding=${fundingFee}`);
                  } else if (realizedPnl !== null && qty > 0) {
                    // Bitunix closePrice=0 — position history realizedPnl can be unreliable
                    // (Bitunix API bug: returns wrong PnL sign/magnitude for some positions).
                    // Deriving exitPrice from wrong Pnl produces wrong WIN/LOSS status.
                    // Reset and fall through to Method 2 (order history + positionId match),
                    // which returns the actual fill avgPrice and order-level PnL.
                    bLog.system(`[SYNC] MATCH(cp=0) trade#${trade.id} ${trade.symbol}: entry=${ep} pnl=${realizedPnl} fee=${tradingFee} — deferring to order history (posId=${storedPosId})`);
                    realizedPnl = null;
                    tradingFee  = 0;
                    fundingFee  = 0;
                    // found/foundPnl intentionally left false → Method 2 will run
                  } else {
                    // Position matched but no PnL data either — Method 2 must find both
                    foundPnl = false;
                    bLog.system(`[SYNC] MATCH(no price/pnl) trade#${trade.id} ${trade.symbol}: entry=${ep} — seeking exit from orders`);
                  }
                } else {
                  bLog.system(`[SYNC] NO MATCH trade#${trade.id} ${trade.symbol} entry=${tradeEntry} — ${positions.length} positions checked`);
                }
              } catch (e) { bLog.error(`[SYNC] Bitunix posHistory error: ${e.message}`); }

              // Method 2: Order history — definitive exit price via positionId.
              // Runs when: (a) Method 1 found nothing (need any exit data), OR
              //            (b) positionId stored + Method 1 found a price (posId exact match
              //                overrides wrong closePrice from position history).
              // Without positionId + Method 1 already found a price: skip — timeMatch is too
              // loose and picks up close orders from OTHER positions on the same symbol/day.
              const needsOrderCheck = !found || (storedPosId && found);
              if (needsOrderCheck) {
                try {
                  const orderList = await bxClient.getHistoryOrders({ symbol: trade.symbol, pageSize: 50, all: true });
                  for (const o of orderList) {
                    const oPrice = parseFloat(o.avgPrice || o.price || 0);
                    const isClose = o.reduceOnly || o.tradeSide === 'CLOSE' || (o.effect || '').toUpperCase() === 'CLOSE';
                    // Only accept FILLED orders — cancelled/rejected SL orders appear in history
                    // with a trigger price but were never executed. Accepting them causes false closures.
                    const oStatus = (o.status || o.orderStatus || o.state || '').toUpperCase();
                    const isFilled = !oStatus || oStatus === 'FILLED' || oStatus === 'FULL_FILLED'
                      || oStatus === 'PARTIALLY_FILLED' || oStatus === '2' || oStatus === 'COMPLETE';
                    const oMs = parseInt(o.ctime || o.mtime || 0);
                    const posIdMatch = storedPosId && String(o.positionId || '') === String(storedPosId);
                    // NOTE: If positionId is stored, ONLY accept orders with exact posId match.
                    // Never fall back to timeMatch when posId is known — timeMatch is too loose
                    // and picks up close orders from OTHER positions on the same symbol/day.
                    const timeMatch = !storedPosId && (!tradeOpenTime || !oMs || oMs > tradeOpenTime);
                    const shouldAccept = storedPosId ? posIdMatch : timeMatch;

                    if (isClose && isFilled && oPrice > 0 && shouldAccept) {
                      // Order fill avgPrice is authoritative — override position history closePrice.
                      if (found && exitPrice !== oPrice) {
                        bLog.system(`[SYNC] posId override trade#${trade.id} ${trade.symbol}: exit ${exitPrice}→${oPrice} (order history wins over posHistory)`);
                        // Reset PnL/fee so Method 2 values take precedence
                        realizedPnl = null;
                        tradingFee  = 0;
                        fundingFee  = 0;
                        foundPnl    = false;
                      }
                      exitPrice = oPrice;
                      bLog.system(`[SYNC] Bitunix orderHistory: ${trade.symbol} | ${JSON.stringify({
                        avgPrice: o.avgPrice, price: o.price, realizedPNL: o.realizedPNL,
                        profit: o.profit, pnl: o.pnl, fee: o.fee, tradeSide: o.tradeSide,
                        reduceOnly: o.reduceOnly, positionId: o.positionId, qty: o.qty,
                        status: o.status || o.orderStatus || o.state
                      })}`);
                      // Only pull PnL and fee from order if Method 1 didn't already set them
                      if (!foundPnl) {
                        const profit = o.profit    != null ? parseFloat(o.profit)       : null;
                        const pnl    = o.pnl       != null ? parseFloat(o.pnl)          : null;
                        const rpnl   = o.realizedPNL != null ? parseFloat(o.realizedPNL) : null;
                        if      (profit != null && profit !== 0) realizedPnl = profit;
                        else if (pnl    != null && pnl    !== 0) realizedPnl = pnl;
                        else if (rpnl   != null && rpnl   !== 0) realizedPnl = rpnl;
                        // Also pick up the close-side fee from the order when available.
                        // This is the exit-side fee only; the total round-trip fee will be
                        // approximated in the fallback calc below if realizedPnl is still null.
                        const oFee = Math.abs(parseFloat(o.fee || 0));
                        if (oFee > 0) tradingFee = oFee;
                      }
                      found = true;
                      bLog.system(`[SYNC] orderHistory RESULT: ${trade.symbol} exit=${exitPrice} net=${realizedPnl} fee=${tradingFee}`);
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
              // Derive exit price from PnL when Bitunix API returned closePrice=0.
              // Formula: grossPnl = (entry - exit) × qty for SHORT, (exit - entry) × qty for LONG
              if (exitPrice === entryPrice && grossPnl !== 0 && qty > 0) {
                const derivedExit = isLong
                  ? entryPrice + grossPnl / qty
                  : entryPrice - grossPnl / qty;
                if (derivedExit > 0) {
                  bLog.trade(`[SYNC] Derived exit price from PnL: ${trade.symbol} ${isLong ? 'LONG' : 'SHORT'} entry=${entryPrice} gross=${grossPnl} qty=${qty} → exit=${derivedExit.toFixed(2)}`);
                  exitPrice = derivedExit;
                }
              }
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

            // Auto-sync: immediately re-fetch real PnL from Bitunix if we used estimated values.
            // realizedPnl null = we used market price fallback (price×qty estimate). Schedule
            // an immediate accountant sync so the wrong estimated PnL gets corrected fast.
            if (realizedPnl === null) {
              setImmediate(() => {
                backfillFeesFromBitunix().catch(e => bLog.error(`[AUTO-SYNC] post-close backfill: ${e.message}`));
              });
            }

            // ── On LOSS: per-symbol 4h cooldown + signal-type block ──────
            try {
              const keyId  = trade.api_key_id;
              const sym    = trade.symbol;
              const dir    = trade.direction;
              const pivot  = trade.setup || 'unknown'; // e.g. "HL+HL" or "LH+LH"
              const now    = Date.now();

              if (status === 'WIN') {
                // Reset consecutive-loss streak on win
                _consecLosses.set(keyId, { count: 0, lastLossAt: 0 });
              } else {
                // ── 1. Per-symbol 4h cooldown (new — was 2h any-close) ──
                // Block this symbol from trading for 4 hours after a LOSS.
                const cdKey     = `${trade.user_id}:${sym}`;
                const cdExpires = now + 4 * 3600 * 1000;
                _symbolLossCooldown.set(cdKey, cdExpires);
                const cdStr = new Date(cdExpires).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
                bLog.trade(`[LOSS-CD] ${sym} blocked 4h for user ${trade.user_id} — resumes ${cdStr}`);
                await notify(
                  `🔴 *${sym} Loss — 4h Cooldown*\n` +
                  `Direction: ${dir} | PnL: \`$${pnlUsdt.toFixed(2)}\`\n` +
                  `${sym} will NOT trade again until ${cdStr}`
                );

                // ── 2. Signal-type tracker: block after 2 losses of same type ──
                const sigKey = `${sym}:${dir}:${pivot}`;
                const prev   = _signalLossTracker.get(sigKey) || { count: 0, blockUntil: 0 };
                const sameSync = (now - (prev.lastLossAt || 0)) < 60_000;
                const newCount = sameSync ? prev.count : prev.count + 1;
                if (newCount >= 2) {
                  const blockUntil = now + 24 * 3600 * 1000;
                  _signalLossTracker.set(sigKey, { count: 0, blockUntil, lastLossAt: now });
                  const blkStr = new Date(blockUntil).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
                  bLog.trade(`[SIG-BLOCK] ${sym} ${dir} [${pivot}] lost ${newCount}x — blocked 24h until ${blkStr}`);
                  await notify(
                    `🚫 *Signal Blocked — 2 Losses Same Type*\n` +
                    `${sym} ${dir} pivot type: \`${pivot}\`\n` +
                    `Blocked for 24h until ${blkStr}`
                  );
                } else {
                  _signalLossTracker.set(sigKey, { count: newCount, blockUntil: prev.blockUntil, lastLossAt: now });
                  bLog.trade(`[SIG-TRACK] ${sym} ${dir} [${pivot}] loss count=${newCount}/2`);
                }

                // ── 3. Consecutive-loss pause (whole key after 2 across any symbol) ──
                const prevCons  = _consecLosses.get(keyId) || { count: 0, lastLossAt: 0 };
                const sameSyncC = (now - prevCons.lastLossAt) < 60_000;
                const streak    = sameSyncC ? prevCons.count : prevCons.count + 1;
                _consecLosses.set(keyId, { count: streak, lastLossAt: now });
                bLog.trade(`[CONSEC-LOSS] Key #${keyId} streak=${streak}${sameSyncC ? ' (same-cycle)' : ''} after LOSS on ${sym}`);
                if (streak >= 2) {
                  const cooldownUntil = new Date(now + 4 * 3600 * 1000);
                  await db.query(
                    `UPDATE api_keys SET paused_by_admin = true, loss_cooldown_until = $2 WHERE id = $1`,
                    [keyId, cooldownUntil]
                  );
                  _consecLosses.set(keyId, { count: 0, lastLossAt: 0 });
                  const untilStr = cooldownUntil.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
                  bLog.trade(`[CONSEC-LOSS] Key #${keyId} PAUSED 4h — 2 consecutive losses. Resumes: ${untilStr}`);
                  await notify(
                    `⏸️ *Trading Paused — 2 Consecutive Losses*\n` +
                    `Key #${keyId}\n` +
                    `Last loss: *${sym}* net=$${pnlUsdt.toFixed(2)}\n` +
                    `Cooldown until: \`${untilStr}\`\n` +
                    `Trading resumes automatically after 4 hours.`
                  );
                }
              }
            } catch (e) {
              bLog.error(`[LOSS-TRACK] Tracking error: ${e.message}`);
            }

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
              ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform,
              u.email
       FROM trades t
       JOIN api_keys ak ON ak.id = t.api_key_id
       JOIN users    u  ON u.id  = t.user_id
       WHERE t.status IN ('WIN','LOSS','CLOSED')
         AND ak.platform = 'bitunix'
       ORDER BY t.closed_at DESC
       LIMIT 2000`
    );

    if (!trades.length) {
      bLog.system('[FEE-BACKFILL] No recent closed Bitunix trades — nothing to do');
      return;
    }
    bLog.system(`[FEE-BACKFILL] Re-syncing ${trades.length} recent closed Bitunix trade(s) across all users`);

    // Group by api_key_id to minimise API calls
    const byKey = {};
    for (const t of trades) {
      if (!byKey[t.api_key_id]) {
        byKey[t.api_key_id] = {
          apiKeyEnc: t.api_key_enc, iv: t.iv, authTag: t.auth_tag,
          apiSecretEnc: t.api_secret_enc, secretIv: t.secret_iv, secretAuthTag: t.secret_auth_tag,
          trades: [],
        };
      }
      byKey[t.api_key_id].trades.push(t);
    }

    let updated = 0;
    for (const [keyId, { apiKeyEnc, iv, authTag, apiSecretEnc, secretIv, secretAuthTag, trades: keyTrades }] of Object.entries(byKey)) {
      let decryptedKey, decryptedSecret;
      try {
        decryptedKey    = cryptoUtils.decrypt(apiKeyEnc, iv, authTag);
        decryptedSecret = cryptoUtils.decrypt(apiSecretEnc, secretIv, secretAuthTag);
      } catch (e) {
        bLog.error(`[FEE-BACKFILL] key#${keyId} decrypt failed: ${e.message}`);
        continue;
      }

      const bxClient = new BitunixClient({ apiKey: decryptedKey, apiSecret: decryptedSecret });

      // Fetch up to 200 history positions per unique symbol for this key
      const symbolsDone = new Set();
      const posCache = {};  // symbol → positions[]

      for (const trade of keyTrades) {
        if (!posCache[trade.symbol] && !symbolsDone.has(trade.symbol)) {
          try {
            posCache[trade.symbol] = await bxClient.getHistoryPositions({ symbol: trade.symbol, pageSize: 200, all: true });
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

        // Log raw fields on first match per symbol so we can diagnose field name mismatches
        if (!posCache[`${trade.symbol}_logged`]) {
          posCache[`${trade.symbol}_logged`] = true;
          bLog.system(`[FEE-BACKFILL] raw fields for ${trade.symbol}: ${JSON.stringify(Object.keys(bestMatch))} | sample: ${JSON.stringify(bestMatch).substring(0, 400)}`);
        }

        const tradingFee = Math.abs(parseFloat(bestMatch.fee || bestMatch.tradingFee || bestMatch.tradeFee || bestMatch.trade_fee || bestMatch.closeFee || bestMatch.close_fee || bestMatch.commission || bestMatch.openFee || bestMatch.open_fee || 0));
        const fundingFee = Math.abs(parseFloat(bestMatch.funding || bestMatch.fundingFee || bestMatch.fund_fee || bestMatch.fundFee || 0));
        const pnlRaw = bestMatch.realizedPNL ?? bestMatch.realizedPnl ?? bestMatch.realPNL ?? bestMatch.realPnl ?? bestMatch.pnl ?? bestMatch.profit ?? bestMatch.netPnl ?? bestMatch.net_pnl ?? null;
        const netPnl = pnlRaw != null ? parseFloat(pnlRaw) : null;

        if (netPnl === null) {
          bLog.system(`[FEE-BACKFILL] trade#${trade.id} ${trade.symbol}: match found but no PnL data — skipping`);
          continue;
        }

        // Bitunix: netPnl in API is NET (already after fees).
        // grossPnl = net + fee + funding.
        const grossPnl = netPnl != null
          ? parseFloat((netPnl + tradingFee + fundingFee).toFixed(4))
          : (trade.gross_pnl != null ? parseFloat(trade.gross_pnl) : null);
        const pnlUsdt = netPnl != null
          ? parseFloat(netPnl.toFixed(4))
          : (grossPnl != null ? parseFloat((grossPnl - tradingFee - fundingFee).toFixed(4)) : null);
        const status = pnlUsdt != null ? (pnlUsdt > 0 ? 'WIN' : 'LOSS') : null;

        // Extract close price from Bitunix history position so exit_price is correct
        const closePrice = parseFloat(
          bestMatch.closePrice || bestMatch.avgClosePrice || bestMatch.closedPrice ||
          bestMatch.close_price || bestMatch.exitPrice || bestMatch.avg_close_price || 0
        ) || null;

        // Guard: if the API gave us nothing useful, skip rather than overwrite good data with NULL.
        if (grossPnl === null && pnlUsdt === null) {
          bLog.system(`[FEE-BACKFILL] trade#${trade.id} ${trade.symbol}: match found but no PnL data — skipping to preserve existing values`);
          continue;
        }

        // Derive exit price from grossPnl when Bitunix closePrice field is absent.
        // Formula reversal: grossPnl = (entry−exit)×qty (SHORT) → exit = entry − grossPnl/qty
        let derivedClosePrice = closePrice;
        if (!derivedClosePrice && grossPnl != null && grossPnl !== 0) {
          const ep  = parseFloat(trade.entry_price);
          const qty = parseFloat(trade.quantity);
          const isL = trade.direction !== 'SHORT';
          if (ep > 0 && qty > 0) {
            const dp = isL ? ep + grossPnl / qty : ep - grossPnl / qty;
            if (dp > 0) {
              derivedClosePrice = parseFloat(dp.toFixed(2));
              bLog.system(`[FEE-BACKFILL] trade#${trade.id} ${trade.symbol}: exit price derived from PnL → ${derivedClosePrice}`);
            }
          }
        }

        // Force-overwrite all fee/pnl fields — do NOT use COALESCE.
        // Previous syncTradeStatus may have stored wrong values (e.g. live P&L
        // snapshot instead of realized, or entry_price as exit_price on API timeout).
        await db.query(
          `UPDATE trades SET
             trading_fee = $1,
             funding_fee = $2,
             gross_pnl   = $3,
             pnl_usdt    = $4,
             status      = COALESCE($5, status),
             exit_price  = COALESCE($6, exit_price),
             closed_at   = COALESCE(closed_at, NOW())
           WHERE id = $7`,
          [
            parseFloat(tradingFee.toFixed(4)),
            parseFloat(fundingFee.toFixed(4)),
            grossPnl,
            pnlUsdt,
            status,
            derivedClosePrice,
            trade.id,
          ]
        );
        updated++;
        bLog.system(`[FEE-BACKFILL] trade#${trade.id} ${trade.email} ${trade.symbol}: gross=$${grossPnl ?? '?'} fee=$${tradingFee.toFixed(4)} net=$${pnlUsdt ?? '?'} exit=$${closePrice ?? '?'} status=${status ?? 'unchanged'}`);
      }
    }

    bLog.system(`[FEE-BACKFILL] Done — updated ${updated}/${trades.length} trades with real Bitunix fees`);

    // ── Corrective pass A: WIN/LOSS trades where pnl_usdt ≠ gross - fee ──
    // gross_pnl IS NOT NULL guaranteed for real wins/losses.
    const correctedWL = await db.query(`
      UPDATE trades
      SET pnl_usdt  = ROUND((gross_pnl - trading_fee - COALESCE(funding_fee, 0))::numeric, 4),
          status    = CASE
                        WHEN (gross_pnl - trading_fee - COALESCE(funding_fee, 0)) > 0 THEN 'WIN'
                        ELSE 'LOSS'
                      END,
          closed_at = COALESCE(closed_at, NOW())
      WHERE status IN ('WIN', 'LOSS', 'CLOSED')
        AND gross_pnl   IS NOT NULL
        AND trading_fee IS NOT NULL
        AND ABS(COALESCE(pnl_usdt, 0) - (gross_pnl - trading_fee - COALESCE(funding_fee, 0))) > 0.005
      RETURNING id
    `);
    const fixedWL = Array.isArray(correctedWL) ? correctedWL.length : (correctedWL.rowCount ?? 0);
    if (fixedWL > 0) bLog.system(`[FEE-BACKFILL] Corrected WIN/LOSS pnl_usdt on ${fixedWL} trade(s)`);

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

// ── TRADER MODE — detect manually opened positions and mirror to followers ────
// key: keyId (integer) → value: Map<positionId, { symbol, direction, tradeDbId }>
const _traderModePositions = new Map();

async function processTraderModeKeys() {
  let db, cryptoUtils, BitunixClient;
  try {
    db = require('./db');
    cryptoUtils = require('./crypto-utils');
    BitunixClient = require('./bitunix-client').BitunixClient;
  } catch (e) {
    bLog.error(`[TraderMode] deps not available: ${e.message}`);
    return;
  }

  let traderKeys;
  try {
    traderKeys = await db.query(
      `SELECT ak.*, u.email, u.id AS user_id_val
         FROM api_keys ak
         JOIN users u ON u.id = ak.user_id
        WHERE ak.enabled = true
          AND ak.trader_mode = true
          AND ak.platform = 'bitunix'`
    );
  } catch (e) {
    bLog.error(`[TraderMode] Failed to fetch trader-mode keys: ${e.message}`);
    return;
  }

  if (!traderKeys.length) return;

  for (const key of traderKeys) {
    let apiKey, apiSecret;
    try {
      apiKey    = cryptoUtils.decrypt(key.api_key_enc,    key.iv,        key.auth_tag);
      apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
    } catch (e) {
      bLog.error(`[TraderMode] Decrypt failed for key #${key.id}: ${e.message}`);
      continue;
    }

    let livePositions = [];
    try {
      const client = new BitunixClient({ apiKey, apiSecret });
      const raw = await client.getOpenPositions();
      livePositions = Array.isArray(raw) ? raw : [];
    } catch (e) {
      bLog.error(`[TraderMode] getOpenPositions failed for key #${key.id}: ${e.message}`);
      continue;
    }

    // Build set of currently live position IDs for stale-entry cleanup
    const livePosIds = new Set(livePositions.map(p => String(p.positionId || p.id || '')).filter(Boolean));

    // Get or create per-key tracking map
    if (!_traderModePositions.has(key.id)) {
      _traderModePositions.set(key.id, new Map());
    }
    const knownPositions = _traderModePositions.get(key.id);

    // Prune positions that no longer exist on the exchange
    for (const [posId] of knownPositions) {
      if (!livePosIds.has(posId)) {
        knownPositions.delete(posId);
      }
    }

    // Detect new positions and trigger copy trades
    for (const pos of livePositions) {
      const posId     = String(pos.positionId || pos.id || '');
      const symbol    = (pos.symbol || '').toUpperCase();
      const qty       = parseFloat(pos.qty || pos.positionAmt || 0);
      const leverage  = parseFloat(pos.leverage || 20);
      const entry     = parseFloat(pos.avgOpenPrice || pos.entryPrice || pos.openPrice || 0);
      const side      = (pos.side || '').toUpperCase();
      const direction = (side === 'BUY' || side === 'LONG') ? 'LONG' : 'SHORT';

      if (!symbol || !entry || !qty || !posId) continue;
      if (knownPositions.has(posId)) continue; // already tracked this cycle

      // Check if this position already has an OPEN trade in DB (may have been inserted by reconcile)
      const existing = await db.query(
        `SELECT id FROM trades WHERE api_key_id = $1 AND symbol = $2 AND status = 'OPEN' LIMIT 1`,
        [key.id, symbol]
      ).catch(() => []);

      let tradeDbId = existing[0]?.id || null;

      if (!tradeDbId) {
        // Insert new trade record for this manual position
        const slGuess = direction === 'LONG'
          ? entry * (1 - 0.30 / leverage)
          : entry * (1 + 0.30 / leverage);

        try {
          const inserted = await db.query(
            `INSERT INTO trades
               (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price,
                quantity, leverage, status, trailing_sl_price, trailing_sl_last_step,
                market_structure, setup, bitunix_position_id)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 'OPEN', $6, 0, 'TRADER_MODE', 'MANUAL', $9)
             RETURNING id`,
            [key.id, key.user_id, symbol, direction, entry,
             parseFloat(slGuess.toFixed(8)), qty, leverage, posId]
          );
          tradeDbId = inserted[0]?.id || null;
          bLog.trade(`[TraderMode] Detected new manual position: ${symbol} ${direction} ${leverage}x @${entry} (key #${key.id} ${key.email})`);
          await notify(
            `👤 *Trader Mode — Position Detected*\n` +
            `${symbol} ${direction} ${leverage}x\n` +
            `Entry: $${entry} | Qty: ${qty}\n` +
            `_Mirroring to followers..._`
          ).catch(() => {});
        } catch (e) {
          bLog.error(`[TraderMode] DB insert failed for ${symbol}: ${e.message}`);
          continue;
        }
      }

      // Track so we don't double-fire
      knownPositions.set(posId, { symbol, direction, tradeDbId });

      // Trigger copy trades for all followers of this user
      try {
        const { triggerCopyTrades } = require('./copy-trade-engine');
        await triggerCopyTrades(
          {
            id: tradeDbId,
            symbol,
            direction,
            entry_price: entry,
            sl_price: direction === 'LONG' ? entry * (1 - 0.30 / leverage) : entry * (1 + 0.30 / leverage),
            tp_price: 0,
            quantity: qty,
            leverage,
            setup: 'MANUAL',
            is_ai_trade: false,
          },
          key,
          { id: key.user_id, email: key.email }
        );
        bLog.trade(`[TraderMode] triggerCopyTrades fired for ${symbol} ${direction} (trader: ${key.email})`);
      } catch (e) {
        bLog.error(`[TraderMode] triggerCopyTrades failed for ${symbol}: ${e.message}`);
      }
    }
  }
}

// ── CLOSE POSITION FOR ALL USERS (reversal / manual) ─────────
// Market-closes an open position across all active API keys for a given symbol.
// Called by TraderAgent when an opposite-direction signal fires while a trade is open.
// After close, the new signal is opened immediately (no post-close cooldown applied).
//
// Returns true if at least one position was closed successfully.
async function closePositionForAllUsers(symbol, reason = 'reversal_signal') {
  const sym = symbol.toUpperCase();
  let db, cryptoUtils, BitunixClient;
  try {
    db           = require('./db');
    cryptoUtils  = require('./crypto-utils');
    BitunixClient = require('./bitunix-client').BitunixClient;
  } catch (e) {
    bLog.error(`[CLOSE-REVERSAL] Module load failed: ${e.message}`);
    return false;
  }

  bLog.trade(`[CLOSE-REVERSAL] Closing ${sym} — reason: ${reason}`);
  let anyClosed = false;

  const keys = await db.query(`
    SELECT ak.id, ak.platform, ak.user_id,
           ak.api_key_enc, ak.iv, ak.auth_tag,
           ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
           u.email
    FROM api_keys ak
    JOIN users u ON u.id = ak.user_id
    WHERE ak.enabled = true AND (ak.paused IS NULL OR ak.paused = false)
  `).catch(() => []);

  for (const key of keys) {
    try {
      const apiKey    = cryptoUtils.decrypt(key.api_key_enc,    key.iv,        key.auth_tag);
      const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
      if (!apiKey || !apiSecret) continue;

      if (key.platform === 'bitunix') {
        const client = new BitunixClient({ apiKey, apiSecret });
        const posRaw = await client.getOpenPositions(sym).catch(() => []);
        const posArr = Array.isArray(posRaw) ? posRaw
          : (posRaw?.positionList || posRaw?.list || []);
        const pos = posArr.find(p => (p.symbol || '').toUpperCase() === sym);
        if (!pos) continue;

        const qty   = parseFloat(pos.qty || pos.size || pos.positionAmt || 0);
        if (qty === 0) continue;

        const isLong = (pos.side || '').toUpperCase() === 'BUY'
                    || (pos.side || '').toUpperCase() === 'LONG';
        const posId  = pos.positionId || pos.id;

        // Use flashClose (single-call full close) — falls back to closePosition
        let closed = false;
        if (posId) {
          try {
            await client.flashClose({ positionId: posId });
            closed = true;
          } catch (_) {}
        }
        if (!closed) {
          await client.closePosition({ symbol: sym, side: isLong ? 'BUY' : 'SELL', qty, positionId: posId });
          closed = true;
        }

        // Mark DB trade closed — syncTradeStatus will fill in exit price and PnL
        await db.query(
          `UPDATE trades SET status = 'CLOSED', exit_reason = $1, closed_at = NOW()
           WHERE symbol = $2 AND status = 'OPEN' AND api_key_id = $3`,
          [reason, sym, key.id]
        ).catch(() => {});

        const livePrice = await getLivePrice(sym).catch(() => null);
        const dir       = isLong ? 'LONG' : 'SHORT';
        bLog.trade(`[CLOSE-REVERSAL] ✓ ${sym} ${dir} closed for ${key.email} @ ~$${livePrice ?? '?'}`);
        await notify(
          `🔄 *Reversal Exit*\n` +
          `*${sym}* ${dir} closed\n` +
          `Reason: opposite signal fired\n` +
          `Exit: ~\`$${livePrice ? livePrice.toFixed(2) : '?'}\``
        );
        anyClosed = true;

      } else if (key.platform === 'binance') {
        const { USDMClient } = require('binance');
        const bnClient = new USDMClient(
          { api_key: apiKey, api_secret: apiSecret },
          getBinanceRequestOptions()
        );
        const positions = await bnClient.getPositions({ symbol: sym }).catch(() => []);
        const openPos   = (Array.isArray(positions) ? positions : [])
          .find(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
        if (!openPos) continue;

        const amt       = parseFloat(openPos.positionAmt || 0);
        const isLong    = amt > 0;
        const closeSide = isLong ? 'SELL' : 'BUY';

        try { await bnClient.cancelAllOpenOrders({ symbol: sym }); } catch (_) {}
        await bnClient.submitNewOrder({
          symbol, side: closeSide, type: 'MARKET',
          quantity: Math.abs(amt), reduceOnly: 'true',
        });

        await db.query(
          `UPDATE trades SET status = 'CLOSED', exit_reason = $1, closed_at = NOW()
           WHERE symbol = $2 AND status = 'OPEN' AND api_key_id = $3`,
          [reason, sym, key.id]
        ).catch(() => {});

        bLog.trade(`[CLOSE-REVERSAL] ✓ ${sym} Binance ${isLong ? 'LONG' : 'SHORT'} closed for ${key.email}`);
        anyClosed = true;
      }
    } catch (keyErr) {
      bLog.error(`[CLOSE-REVERSAL] Key ${key.id} (${key.email || '?'}): ${keyErr.message}`);
    }
  }

  return anyClosed;
}

async function run() {
  log(`AI Smart Trader v4 | Telegram: ${!!TELEGRAM_TOKEN} | Chats: ${PRIVATE_CHATS.join(', ') || 'NONE'}`);
  // Hard sync on startup: reconcile all Bitunix positions with DB,
  // insert missing records, and mark ghost trades.
  await hardSyncExchangeDB();
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
  closePositionForAllUsers,
  openTrade,
  checkTrailingStop,
  syncTradeStatus,
  hardSyncExchangeDB,
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
  injectTVSignal,
  processTraderModeKeys,
  backfillFeesFromBitunix,
};
