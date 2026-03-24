// ============================================================
// Smart Crypto Trader v3 — Binance USDT-M Futures
// Improved: RSI filter, EMA trend, volume confirmation,
//           dynamic sizing, trailing stop, multi-timeframe
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');

const API_KEY        = process.env.BINANCE_API_KEY    || '';
const API_SECRET     = process.env.BINANCE_API_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN     || '';
// Supports multiple chat IDs separated by comma, e.g. "-1001003740693659,123456789"
const TELEGRAM_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

// ── RISK CONFIG ───────────────────────────────────────────────
// Edit these to tune the bot. Never set LEVERAGE above 20.
const CONFIG = {
  LEVERAGE:       20,
  TP_PCT:         0.045,    // 4.5% take profit
  SL_PCT:         0.012,    // 1.2% stop loss (tight)
  TRAIL_PCT:      0.008,    // 0.8% trailing stop activation
  RISK_PCT:       0.40,     // only use 40% of balance per trade (safer)
  MAX_LEVERAGE:   20,
  MIN_BALANCE:    5,        // min USDT to trade
  MIN_VOL_M:      100,      // min $100M 24h volume (higher = more liquid)
  MIN_SCORE:      18,       // minimum score to open trade (higher = stricter)
  RSI_MAX:        68,       // don't buy if RSI above this (overbought)
  RSI_MIN:        35,       // don't buy if RSI below this (downtrend)
  EMA_FAST:       9,
  EMA_SLOW:       21,
  BLACKLIST: [
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT',
    'LEVERUSDT','AGLDUSDT','LOOKSUSDT',
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
      if (!json.ok) {
        log(`Telegram API error chat=${chatId}: ${json.error_code} — ${json.description}`);
      }
      return; // don't retry HTTP errors (bad token/chat ID won't fix on retry)
    } catch (e) {
      const isNet = e.message && (
        e.message.includes('ETIMEDOUT') || e.message.includes('ECONNRESET') ||
        e.message.includes('ECONNREFUSED') || e.message.includes('aborted')
      );
      log(`Telegram ${isNet ? 'timeout' : 'error'} chat=${chatId} (attempt ${i+1}/${retries}): ${e.message.substring(0,80)}`);
      if (i < retries - 1) await sleep(2000 * (i + 1));
    }
  }
}

async function notify(msg) {
  log(`>> ${msg.replace(/\*/g,'').replace(/`/g,'').substring(0, 100)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  await Promise.all(TELEGRAM_CHATS.map(id => sendToChat(id, msg)));
}

// ── INDICATORS ────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = parseFloat(klines[i][2]);
    const l = parseFloat(klines[i][3]);
    const pc = parseFloat(klines[i-1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBollingerBands(closes, period = 20, stdMult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + stdMult * std, middle: mean, lower: mean - stdMult * std };
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  if (!emaFast || !emaSlow) return null;
  const macdLine = emaFast - emaSlow;
  // simplified signal: EMA of last macd values
  return { macd: macdLine, positive: macdLine > 0 };
}

// ── SCORING SYSTEM ────────────────────────────────────────────
async function analyzeSymbol(client, ticker) {
  const sym = ticker.symbol;
  try {
    // Get 15m klines (for main analysis)
    const klines15 = await client.getKlines({ symbol: sym, interval: '15m', limit: 50 });
    if (klines15.length < 30) return null;

    const closes = klines15.map(k => parseFloat(k[4]));
    const opens  = klines15.map(k => parseFloat(k[1]));
    const vols   = klines15.map(k => parseFloat(k[5]));

    const price = closes[closes.length - 1];

    // RSI filter — skip overbought/oversold
    const rsi = calcRSI(closes, 14);
    if (rsi === null) return null;
    if (rsi > CONFIG.RSI_MAX || rsi < CONFIG.RSI_MIN) return null;

    // EMA trend filter — only trade when fast EMA above slow EMA (uptrend)
    const emaFast = calcEMA(closes, CONFIG.EMA_FAST);
    const emaSlow = calcEMA(closes, CONFIG.EMA_SLOW);
    if (!emaFast || !emaSlow) return null;
    const inUptrend = emaFast > emaSlow;
    if (!inUptrend) return null; // only trade with trend

    // MACD
    const macd = calcMACD(closes);
    const macdBullish = macd?.positive;

    // Bollinger Bands — price near lower band = good entry, near upper = skip
    const bb = calcBollingerBands(closes);
    const bbPosition = bb ? (price - bb.lower) / (bb.upper - bb.lower) : 0.5;
    if (bbPosition > 0.80) return null; // too close to upper band

    // ATR for volatility
    const atr = calcATR(klines15);
    const atrPct = atr ? (atr / price) * 100 : 0;
    if (atrPct > 3) return null; // too volatile, skip

    // Volume confirmation
    const recentVol = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const prevVol   = vols.slice(-8, -3).reduce((a, b) => a + b, 0) / 5;
    const volRatio  = prevVol > 0 ? recentVol / prevVol : 1;
    if (volRatio < 1.2) return null; // need volume confirmation

    // Green candle streak
    let streak = 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] > opens[i]) streak++;
      else break;
    }

    // Momentum
    const mom1h  = closes.length >= 5  ? (price - closes[closes.length - 5])  / closes[closes.length - 5]  * 100 : 0;
    const mom30m = closes.length >= 3  ? (price - closes[closes.length - 3])  / closes[closes.length - 3]  * 100 : 0;

    // 24h stats
    const chg24h   = parseFloat(ticker.priceChangePercent);
    const high24h  = parseFloat(ticker.highPrice);
    const distHigh = (price - high24h) / high24h * 100;

    // Funding rate
    let fundRate = 0;
    try {
      const funding = await client.getFundingRate({ symbol: sym, limit: 1 });
      fundRate = funding.length ? parseFloat(funding[0].fundingRate) * 100 : 0;
    } catch (_) {}

    // Max leverage
    let maxLev = CONFIG.MAX_LEVERAGE;
    try {
      const brackets = await client.getLeverageBrackets({ symbol: sym });
      maxLev = brackets[0]?.brackets[0]?.initialLeverage || CONFIG.MAX_LEVERAGE;
    } catch (_) {}

    // ── SCORE ──────────────────────────────────────────────
    let score = 0;

    // Trend strength
    score += Math.min(chg24h, 15) * 0.4;         // 24h change (max 6pts)
    score += mom1h  * 3;                           // 1h momentum
    score += mom30m * 2;                           // 30m momentum
    score += streak * 4;                           // green streak (max ~20)

    // Indicators
    if (macdBullish) score += 6;                   // MACD bullish
    if (rsi >= 45 && rsi <= 62) score += 5;        // RSI in ideal zone
    if (bbPosition < 0.35) score += 8;             // near lower BB = good entry
    if (volRatio >= 1.5) score += 6;               // strong volume
    if (atrPct >= 0.5 && atrPct <= 1.8) score += 4; // healthy volatility

    // Position in range
    if (distHigh > -3  && distHigh <= 0) score += 5;  // near day high = strength
    if (distHigh > -8  && distHigh <= -3) score += 2;

    // Funding
    if (fundRate < 0)     score += 4;   // longs get paid = bullish
    if (fundRate > 0.05)  score -= 15;  // too expensive to hold long

    // Penalties
    if (chg24h > 40)   score -= 15;    // already pumped too much
    if (streak > 6)    score -= 10;    // over-extended streak

    const leverage = Math.min(CONFIG.MAX_LEVERAGE, maxLev);

    // Confidence tier
    let confidence = 'LOW';
    if (score >= 25) confidence = 'HIGH';
    else if (score >= 20) confidence = 'MEDIUM';

    return {
      sym, price, score, confidence,
      chg24h, mom1h, mom30m, streak,
      rsi, macdBullish, bbPosition, volRatio, atrPct,
      distHigh, fundRate, leverage,
    };

  } catch (_) { return null; }
}

// ── FIND BEST TRADE ───────────────────────────────────────────
async function findBestTrade(client) {
  const tickers = await client.get24hrChangeStatistics();

  const candidates = tickers.filter(t =>
    t.symbol.endsWith('USDT') &&
    !CONFIG.BLACKLIST.includes(t.symbol) &&
    parseFloat(t.quoteVolume) > CONFIG.MIN_VOL_M * 1e6 &&
    parseFloat(t.priceChangePercent) >= 1 &&    // at least 1% up today
    parseFloat(t.priceChangePercent) < 40        // not already pumped 40%+
  );

  // Sort by 24h volume — most liquid first
  const top50 = candidates
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 50);

  log(`Analyzing ${top50.length} candidates with full indicator suite...`);

  const scored = [];
  const BATCH = 5; // small batches to avoid rate limit
  for (let i = 0; i < top50.length; i += BATCH) {
    const batch = top50.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(t => analyzeSymbol(client, t)));
    results.forEach(r => { if (r && r.score >= CONFIG.MIN_SCORE) scored.push(r); });
    await sleep(300);
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  log('Top picks:');
  scored.slice(0, 5).forEach((s, i) =>
    log(`  ${i+1}. ${s.sym} score=${s.score.toFixed(1)} RSI=${s.rsi?.toFixed(1)} conf=${s.confidence} 1h=${s.mom1h.toFixed(2)}%`)
  );

  return scored[0];
}

// ── OPEN TRADE ────────────────────────────────────────────────
async function openTrade(client, pick, availUsdt) {
  const { sym, price, leverage, confidence } = pick;

  await client.setLeverage({ symbol: sym, leverage });
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch (e) { if (!e.message?.includes('No need')) throw e; }

  const info      = await client.getExchangeInfo();
  const sinfo     = info.symbols.find(s => s.symbol === sym);
  const qtyPrec   = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;

  // Dynamic sizing: use more for HIGH confidence, less for MEDIUM
  const riskMultiplier = confidence === 'HIGH' ? CONFIG.RISK_PCT : CONFIG.RISK_PCT * 0.6;
  const qty = Math.floor((availUsdt * riskMultiplier * leverage / price) * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

  const order = await client.submitNewOrder({ symbol: sym, side: 'BUY', type: 'MARKET', quantity: qty });

  const tp = parseFloat((price * (1 + CONFIG.TP_PCT)).toFixed(pricePrec));
  const sl = parseFloat((price * (1 - CONFIG.SL_PCT)).toFixed(pricePrec));

  try {
    await client.submitNewOrder({
      symbol: sym, side: 'SELL', type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { log(`TP warn: ${e.message}`); }

  try {
    await client.submitNewOrder({
      symbol: sym, side: 'SELL', type: 'STOP_MARKET',
      stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { log(`SL warn: ${e.message}`); }

  return { sym, qty, entry: price, leverage, tp, sl, confidence, orderId: order.orderId };
}

// ── CHECK TRAILING STOP ───────────────────────────────────────
async function checkTrailingStop(client) {
  try {
    const account   = await client.getAccountInformation();
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) > 0);

    for (const p of positions) {
      const sym    = p.symbol;
      const entry  = parseFloat(p.entryPrice);
      const ticker = await client.getSymbolPriceTicker({ symbol: sym });
      const cur    = parseFloat(ticker.price);
      const gain   = (cur - entry) / entry;

      // If price moved up TRAIL_PCT, tighten stop loss
      if (gain >= CONFIG.TRAIL_PCT) {
        const newSl = parseFloat((cur * (1 - CONFIG.SL_PCT * 0.5)).toFixed(6));
        log(`Trailing stop for ${sym}: moved SL to $${newSl} (gain: ${(gain*100).toFixed(2)}%)`);
        // Cancel existing SL and set new one
        try {
          await client.cancelAllOpenOrders({ symbol: sym });
          const tp  = parseFloat((entry * (1 + CONFIG.TP_PCT)).toFixed(6));
          await client.submitNewOrder({
            symbol: sym, side: 'SELL', type: 'TAKE_PROFIT_MARKET',
            stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
          });
          await client.submitNewOrder({
            symbol: sym, side: 'SELL', type: 'STOP_MARKET',
            stopPrice: newSl, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
          });
        } catch (e) { log(`Trailing update warn: ${e.message}`); }
      }
    }
  } catch (e) { log(`checkTrailingStop err: ${e.message}`); }
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  log('=== Smart Trader v3 Cycle Start ===');
  const client = getClient();

  try {
    const account   = await client.getAccountInformation();
    const wallet    = parseFloat(account.totalWalletBalance);
    const avail     = parseFloat(account.availableBalance);
    const upnl      = parseFloat(account.totalUnrealizedProfit);
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    log(`Wallet=$${wallet.toFixed(4)} | Avail=$${avail.toFixed(4)} | uPnL=$${upnl.toFixed(4)} | Pos=${positions.length}`);

    // ── HAS OPEN POSITION ──────────────────────────────────
    if (positions.length > 0) {
      await checkTrailingStop(client);

      for (const p of positions) {
        const sym   = p.symbol;
        const amt   = parseFloat(p.positionAmt);
        const entry = parseFloat(p.entryPrice);
        const pnl   = parseFloat(p.unrealizedProfit);
        const lev   = parseInt(p.leverage);
        const ticker = await client.getSymbolPriceTicker({ symbol: sym });
        const cur   = parseFloat(ticker.price);
        const pct   = ((cur - entry) / entry) * 100 * lev;
        const side  = amt > 0 ? '🟢 LONG' : '🔴 SHORT';
        const tp    = parseFloat((entry * (1 + CONFIG.TP_PCT)).toFixed(6));
        const sl    = parseFloat((entry * (1 - CONFIG.SL_PCT)).toFixed(6));

        await notify(
          `📊 *Position Update — ${now()}*\n\n` +
          `*${sym}* ${side} x${lev}\n` +
          `Entry: \`$${fmtPrice(entry)}\` → Now: \`$${fmtPrice(cur)}\`\n` +
          `PnL: ${pnl >= 0 ? '🟢' : '🔴'} *${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}* (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)\n` +
          `🎯 TP: \`$${fmtPrice(tp)}\`  🛑 SL: \`$${fmtPrice(sl)}\`\n` +
          `💰 Wallet: *$${wallet.toFixed(4)} USDT*\n` +
          `_Trailing stop active ✅_`
        );
      }
      log('=== Cycle End (holding) ===');
      return;
    }

    // ── NO POSITION → SCAN & TRADE ────────────────────────
    if (avail < CONFIG.MIN_BALANCE) {
      log(`Balance too low: $${avail.toFixed(4)}`);
      await notify(`⚠️ *Bot — ${now()}*\nBalance too low: \`$${avail.toFixed(4)}\` USDT`);
      return;
    }

    const pick = await findBestTrade(client);

    if (!pick) {
      await notify(
        `🔍 *Smart Scan — ${now()}*\n` +
        `No setup passed all filters.\n` +
        `(RSI, EMA trend, volume, BB position all checked)\n` +
        `💰 Wallet: *$${wallet.toFixed(4)} USDT* — waiting for better entry.`
      );
      return;
    }

    const result = await openTrade(client, pick, avail);
    const riskUsdt = (avail * CONFIG.RISK_PCT).toFixed(2);

    await notify(
      `🚀 *NEW TRADE — ${now()}*\n\n` +
      `Coin: *${result.sym}*\n` +
      `Direction: *LONG x${result.leverage}*\n` +
      `Confidence: *${result.confidence}* ⭐\n` +
      `Entry: \`$${fmtPrice(result.entry)}\`\n` +
      `Qty: \`${result.qty}\`\n` +
      `🎯 TP: \`$${fmtPrice(result.tp)}\` (+4.5%)\n` +
      `🛑 SL: \`$${fmtPrice(result.sl)}\` (-1.2%)\n\n` +
      `📊 *Signals:*\n` +
      `• RSI: \`${pick.rsi?.toFixed(1)}\` | MACD: ${pick.macdBullish ? '✅ Bullish' : '⚠️'}\n` +
      `• 1H: \`${pick.mom1h.toFixed(2)}%\` | Streak: \`${pick.streak}\` green\n` +
      `• Volume surge: \`${pick.volRatio.toFixed(1)}x\`\n` +
      `• BB position: \`${(pick.bbPosition * 100).toFixed(0)}%\` (lower=better)\n` +
      `• Score: \`${pick.score.toFixed(1)}\`\n\n` +
      `💰 Risk: *$${riskUsdt} USDT* | Wallet: *$${avail.toFixed(4)}*`
    );

  } catch (err) {
    log(`ERROR: ${err.message}`);
    await notify(`❌ *Bot Error — ${now()}*\n\`${err.message}\``);
  }

  log('=== Cycle End ===');
}

function getClient() {
  return new USDMClient({ api_key: API_KEY, api_secret: API_SECRET });
}

async function run() {
  log(`Token set: ${!!TELEGRAM_TOKEN} | Chats: ${TELEGRAM_CHATS.join(', ') || 'NONE'}`);
  await main();
}

module.exports = { run };
