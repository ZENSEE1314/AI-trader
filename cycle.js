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
// Trade alerts go ONLY to private chats (positive IDs), NOT to public channels
const TELEGRAM_CHATS   = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const PRIVATE_CHATS    = TELEGRAM_CHATS.filter(id => !id.startsWith('-'));

// ── RISK CONFIG ───────────────────────────────────────────────
// Edit these to tune the bot. Never set LEVERAGE above 20.
const CONFIG = {
  LEVERAGE:       20,
  TP_PCT:         0.035,    // 3.5% take profit (3-5% range, grows volume steadily)
  SL_PCT:         0.010,    // 1.0% stop loss (tight)
  TRAIL_PCT:      0.008,    // 0.8% trailing stop activation
  RISK_PCT:       0.40,     // only use 40% of balance per trade
  MAX_LEVERAGE:   20,
  MIN_BALANCE:    5,        // min USDT to trade
  MIN_VOL_M:      100,      // min $100M 24h volume
  MIN_SCORE:      18,       // minimum score to open trade
  RSI_MAX:        68,       // LONG: skip if RSI above (overbought)
  RSI_MIN:        35,       // LONG: skip if RSI below (downtrend)
  RSI_SHORT_MIN:  58,       // SHORT: only short if RSI above this
  RSI_SHORT_MAX:  85,       // SHORT: skip if RSI extremely overbought (might keep pumping)
  TAKER_FEE:      0.0004,   // Binance taker fee: 0.04% per side (standard)
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
  if (!TELEGRAM_TOKEN || !PRIVATE_CHATS.length) return;
  await Promise.all(PRIVATE_CHATS.map(id => sendToChat(id, msg))); // private only — not channel
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
  return { macd: macdLine, positive: macdLine > 0 };
}

// ── MARKET STRUCTURE ──────────────────────────────────────────
// Detects HH/HL/LH/LL, EQL/EQH, BMS and CHoCH
// Rule 1 (from user): LH formed → NO LONG. SHORT bias only.
function detectStructure(klines) {
  const n = klines.length;
  if (n < 20) return { trend: 'ranging', shLabel: '?', slLabel: '?', marketStructure: '?', eql: null, eqh: null, choch: null };

  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));

  // ── Swing points (need 2 bars each side to confirm) ──────
  const swingHighs = []; // { price, idx }
  const swingLows  = [];
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      swingHighs.push({ price: highs[i], idx: i });
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      swingLows.push({ price: lows[i], idx: i });
  }

  if (swingHighs.length < 2 || swingLows.length < 2)
    return { trend: 'ranging', shLabel: '?', slLabel: '?', marketStructure: '?', eql: null, eqh: null, choch: null };

  const sh1 = swingHighs[swingHighs.length - 1].price;
  const sh2 = swingHighs[swingHighs.length - 2].price;
  const sl1 = swingLows[swingLows.length - 1].price;
  const sl2 = swingLows[swingLows.length - 2].price;

  const shLabel = sh1 > sh2 ? 'HH' : 'LH'; // Higher High or Lower High
  const slLabel = sl1 > sl2 ? 'HL' : 'LL'; // Higher Low or Lower Low

  // ── Trend from structure ──────────────────────────────────
  let trend = 'ranging';
  if      (shLabel === 'HH' && slLabel === 'HL') trend = 'uptrend';
  else if (shLabel === 'LH' && slLabel === 'LL') trend = 'downtrend';
  else if (shLabel === 'HH')                     trend = 'bullish';
  else if (shLabel === 'LH')                     trend = 'bearish';

  // ── CHoCH: Change of Character ────────────────────────────
  // Bearish CHoCH: was uptrend, price closes below last HL → trend flipping
  // Bullish CHoCH: was downtrend, price closes above last LH → trend flipping
  const lastClose = closes[closes.length - 1];
  let choch = null;
  if ((trend === 'uptrend' || trend === 'bullish') && lastClose < sl1)
    choch = 'bearish'; // price broke below last HL → CHoCH bearish
  if ((trend === 'downtrend' || trend === 'bearish') && lastClose > sh1)
    choch = 'bullish'; // price broke above last LH → CHoCH bullish

  // ── Equal Lows / Equal Highs (liquidity pools) ───────────
  const EQ_TOL = 0.003; // within 0.3% = equal
  const eql = Math.abs(sl1 - sl2) / sl2 < EQ_TOL ? (sl1 + sl2) / 2 : null; // EQL — SHORT target
  const eqh = Math.abs(sh1 - sh2) / sh2 < EQ_TOL ? (sh1 + sh2) / 2 : null; // EQH — LONG target

  return { trend, shLabel, slLabel, marketStructure: `${shLabel}+${slLabel}`, eql, eqh, sh1, sl1, choch };
}

// ── ORDER BLOCK DETECTION ─────────────────────────────────────
// An Order Block is the last bearish candle before a strong bullish impulse.
// Rule 2: price returns to OB + LL formed there + reversal sign = LONG allowed
function detectOrderBlock(klines) {
  const n = klines.length;
  if (n < 20) return null;

  const opens  = klines.map(k => parseFloat(k[1]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));

  // Find the strongest bullish impulse in the last 40 candles (min 2.5% in 3 bars)
  let obZone = null;
  for (let i = 5; i < Math.min(n - 3, 40); i++) {
    const impulse = (closes[i] - closes[i - 3]) / closes[i - 3] * 100;
    if (impulse < 2.5) continue; // not a strong enough move

    // Walk back to find the last bearish candle before this impulse
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (closes[j] < opens[j]) { // bearish candle = the OB
        obZone = {
          high: Math.max(opens[j], closes[j]), // OB top
          low:  Math.min(opens[j], closes[j]), // OB bottom (entry zone)
          full_high: highs[j],
          full_low:  lows[j],
        };
        break;
      }
    }
    if (obZone) break; // use the most recent impulse
  }

  return obZone;
}

// Detect bullish reversal candle patterns at current price
function detectReversalSign(klines) {
  const n = klines.length;
  if (n < 3) return { found: false, type: null };

  const opens  = klines.map(k => parseFloat(k[1]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));

  const i = n - 1; // latest candle
  const body     = Math.abs(closes[i] - opens[i]);
  const fullRange= highs[i] - lows[i];
  const lowerWick= Math.min(opens[i], closes[i]) - lows[i];
  const upperWick= highs[i] - Math.max(opens[i], closes[i]);

  // ── Hammer / Pin Bar: long lower wick rejection ──────────
  const isHammer = lowerWick > body * 2 && upperWick < body * 0.5 && fullRange > 0;

  // ── Bullish Engulfing: current green candle engulfs prev red ─
  const prevBody  = Math.abs(closes[i-1] - opens[i-1]);
  const prevBear  = closes[i-1] < opens[i-1];
  const curBull   = closes[i] > opens[i];
  const isEngulfing = curBull && prevBear && closes[i] > opens[i-1] && opens[i] < closes[i-1] && body > prevBody;

  // ── Wick Rejection (strong lower wick even if not full hammer) ─
  const isWickRejection = lowerWick > fullRange * 0.55 && closes[i] > opens[i];

  if (isHammer)        return { found: true, type: 'Hammer/Pin Bar' };
  if (isEngulfing)     return { found: true, type: 'Bullish Engulfing' };
  if (isWickRejection) return { found: true, type: 'Wick Rejection' };

  return { found: false, type: null };
}

// ── SCORING SYSTEM (LONG + SHORT) ─────────────────────────────
async function analyzeSymbol(client, ticker, fundRates = {}) {
  const sym = ticker.symbol;
  try {
    const klines15 = await client.getKlines({ symbol: sym, interval: '15m', limit: 50 });
    if (klines15.length < 30) return null;

    const closes  = klines15.map(k => parseFloat(k[4]));
    const opens   = klines15.map(k => parseFloat(k[1]));
    const vols    = klines15.map(k => parseFloat(k[5]));
    const price   = closes[closes.length - 1];
    const lastLow = parseFloat(klines15[klines15.length - 1][3]);
    const lastHigh= parseFloat(klines15[klines15.length - 1][2]);

    const rsi      = calcRSI(closes, 14);
    if (rsi === null) return null;

    const struct   = detectStructure(klines15);
    const emaFast  = calcEMA(closes, CONFIG.EMA_FAST);
    const emaSlow  = calcEMA(closes, CONFIG.EMA_SLOW);
    if (!emaFast || !emaSlow) return null;

    const macd     = calcMACD(closes);
    const bb       = calcBollingerBands(closes);
    const bbPos    = bb ? (price - bb.lower) / (bb.upper - bb.lower) : 0.5;
    const atr      = calcATR(klines15);
    const atrPct   = atr ? (atr / price) * 100 : 0;
    if (atrPct > 3) return null;

    const recentVol = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const prevVol   = vols.slice(-8, -3).reduce((a, b) => a + b, 0) / 5;
    const volRatio  = prevVol > 0 ? recentVol / prevVol : 1;
    if (volRatio < 1.2) return null;

    const chg24h  = parseFloat(ticker.priceChangePercent);
    const fundRate= fundRates[sym] || 0;
    const leverage= CONFIG.MAX_LEVERAGE;

    // Candle streak (positive = green, negative = red)
    let streak = 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] > opens[i]) { if (streak >= 0) streak++; else break; }
      else                      { if (streak <= 0) streak--; else break; }
    }

    const mom1h  = closes.length >= 5 ? (price - closes[closes.length - 5]) / closes[closes.length - 5] * 100 : 0;
    const mom30m = closes.length >= 3 ? (price - closes[closes.length - 3]) / closes[closes.length - 3] * 100 : 0;
    const high24h = parseFloat(ticker.highPrice);
    const distHigh = (price - high24h) / high24h * 100;

    // ── Rule 1: LH = NO LONG (unless Rule 2 exception applies) ─
    const lhFormed = struct.shLabel === 'LH';
    const llFormed = struct.slLabel === 'LL'; // LH+LL = confirmed downtrend

    // ── Rule 2: LL at Order Block + reversal sign = LONG allowed ─
    // Even in bearish structure (LH), if price reaches a strong OB zone,
    // forms a LL there, and shows a reversal candle → institutional reversal setup
    const ob       = detectOrderBlock(klines15);
    const reversal = detectReversalSign(klines15);
    const atOB     = ob && price >= ob.full_low * 0.998 && price <= ob.high * 1.002; // within 0.2%
    const rule2Long = lhFormed && llFormed && atOB && reversal.found && rsi < 45;    // all 4 conditions

    // EQH sweep: wick above equal highs + close below = SHORT confirmation
    const eqhSweep = struct.eqh && lastHigh > struct.eqh && price < struct.eqh;

    // EQL sweep: wick below equal lows + close above = LONG signal
    // Only valid when NOT in LH structure (unless Rule 2 unlocks it)
    const eqlSweep = struct.eql && lastLow < struct.eql && price > struct.eql && (!lhFormed || rule2Long);

    // CHoCH bearish/bullish
    const chochBearish = struct.choch === 'bearish';
    const chochBullish = struct.choch === 'bullish';

    // Rule 2 can unlock LONG even in LH structure (OB reversal exception)
    const isLongTrend  = rule2Long ||
                         (!lhFormed && (struct.trend === 'uptrend' || struct.trend === 'bullish' || eqlSweep || chochBullish));
    const isShortTrend = !rule2Long &&
                         (lhFormed || struct.trend === 'downtrend' || struct.trend === 'bearish' || eqhSweep || chochBearish);

    if (!isLongTrend && !isShortTrend) return null;

    // ── LONG filters ───────────────────────────────────────
    if (isLongTrend) {
      // Rule 2 OB reversal: use relaxed RSI (oversold OK), EMA can be bearish
      if (!rule2Long) {
        if (rsi > CONFIG.RSI_MAX || rsi < CONFIG.RSI_MIN) return null;
        if (emaFast < emaSlow) return null;
      }
      if (bbPos > 0.80) return null;

      let score = 0;
      // Rule 2 bonus: institutional OB reversal
      if (rule2Long) {
        score += 15;                                  // strong base score for OB reversal
        if (reversal.type === 'Bullish Engulfing') score += 8;
        else if (reversal.type === 'Hammer/Pin Bar') score += 6;
        else if (reversal.type === 'Wick Rejection') score += 4;
      }
      score += Math.min(chg24h, 15) * 0.4;
      score += mom1h * 3;
      score += mom30m * 2;
      score += Math.max(streak, 0) * 4;
      if (macd?.positive) score += 6;
      if (rsi >= 45 && rsi <= 62) score += 5;
      if (bbPos < 0.35) score += 8;
      if (volRatio >= 1.5) score += 6;
      if (atrPct >= 0.5 && atrPct <= 1.8) score += 4;
      if (distHigh > -3 && distHigh <= 0) score += 5;
      if (fundRate < 0) score += 4;
      if (fundRate > 0.05) score -= 15;
      if (chg24h > 40) score -= 15;
      if (streak > 6 && !rule2Long) score -= 10;

      let confidence = 'LOW';
      if (score >= 25) confidence = 'HIGH';
      else if (score >= 20) confidence = 'MEDIUM';

      return {
        sym, price, score, confidence, direction: 'LONG',
        chg24h, mom1h, mom30m, streak,
        rsi, macdBullish: macd?.positive, bbPosition: bbPos, volRatio, atrPct,
        distHigh, fundRate, leverage,
        marketStructure: struct.marketStructure, trend: struct.trend,
        eql: struct.eql, eqh: struct.eqh,
        rule2Long, obZone: ob, reversalType: reversal.type,
      };
    }

    // ── SHORT filters ──────────────────────────────────────
    if (isShortTrend) {
      if (rsi < CONFIG.RSI_SHORT_MIN || rsi > CONFIG.RSI_SHORT_MAX) return null;
      if (emaFast > emaSlow) return null;   // EMA still bullish — skip short
      if (bbPos < 0.20) return null;        // near lower BB — bad short entry

      let score = 0;
      if (lhFormed && llFormed) score += 10;         // Rule 1: confirmed LH+LL downtrend = strong short bias
      else if (lhFormed)        score += 6;          // LH alone = short bias
      if (chochBearish)         score += 8;          // CHoCH bearish = structure just flipped
      if (eqhSweep)             score += 7;          // swept EQH liquidity = shorts entering
      score += Math.abs(Math.min(chg24h, 0)) * 0.4;
      score += Math.abs(Math.min(mom1h, 0)) * 3;
      score += Math.abs(Math.min(mom30m, 0)) * 2;
      score += Math.abs(Math.min(streak, 0)) * 4;   // red candle streak
      if (macd && !macd.positive) score += 6;
      if (rsi >= 55 && rsi <= 75) score += 5;        // RSI in bearish pullback zone
      if (bbPos > 0.65) score += 8;                  // near upper BB = good short entry
      if (volRatio >= 1.5) score += 6;
      if (atrPct >= 0.5 && atrPct <= 1.8) score += 4;
      if (fundRate > 0.05) score += 6;               // expensive funding → longs will close
      if (fundRate < -0.02) score -= 10;
      if (chg24h < -40) score -= 15;

      let confidence = 'LOW';
      if (score >= 25) confidence = 'HIGH';
      else if (score >= 20) confidence = 'MEDIUM';

      return {
        sym, price, score, confidence, direction: 'SHORT',
        chg24h, mom1h, mom30m, streak,
        rsi, macdBullish: macd?.positive, bbPosition: bbPos, volRatio, atrPct,
        distHigh, fundRate, leverage,
        marketStructure: struct.marketStructure, trend: struct.trend,
        eql: struct.eql, eqh: struct.eqh,
      };
    }

    return null;
  } catch (_) { return null; }
}

// ── FIND BEST TRADE ───────────────────────────────────────────
async function findBestTrade(client) {
  const tickers = await client.get24hrChangeStatistics();

  const candidates = tickers.filter(t =>
    t.symbol.endsWith('USDT') &&
    !CONFIG.BLACKLIST.includes(t.symbol) &&
    parseFloat(t.quoteVolume) > CONFIG.MIN_VOL_M * 1e6 &&
    parseFloat(t.priceChangePercent) >= 1 &&
    parseFloat(t.priceChangePercent) < 40
  );

  // Top 20 by volume — fewer calls = safer on rate limits
  const top20 = candidates
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 20);

  // Batch-fetch ALL funding rates in ONE call instead of per-symbol
  const fundRates = {};
  try {
    const allFunding = await client.getFundingRate({});
    for (const f of allFunding) fundRates[f.symbol] = parseFloat(f.fundingRate) * 100;
  } catch (_) {}

  log(`Analyzing ${top20.length} candidates (1 funding call total)...`);

  const scored = [];
  const BATCH = 3; // smaller batches, more spacing
  for (let i = 0; i < top20.length; i += BATCH) {
    const batch = top20.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(t => analyzeSymbol(client, t, fundRates)));
    results.forEach(r => { if (r && r.score >= CONFIG.MIN_SCORE) scored.push(r); });
    await sleep(600); // 600ms between batches
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  log('Top picks:');
  scored.slice(0, 5).forEach((s, i) =>
    log(`  ${i+1}. ${s.sym} score=${s.score.toFixed(1)} RSI=${s.rsi?.toFixed(1)} conf=${s.confidence} 1h=${s.mom1h.toFixed(2)}%`)
  );

  return scored[0];
}

// ── OPEN TRADE (LONG or SHORT) ────────────────────────────────
async function openTrade(client, pick, availUsdt) {
  const { sym, price, leverage, confidence, direction } = pick;
  const isLong = direction !== 'SHORT';

  await client.setLeverage({ symbol: sym, leverage });
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch (e) { if (!e.message?.includes('No need')) throw e; }

  const info      = await client.getExchangeInfo();
  const sinfo     = info.symbols.find(s => s.symbol === sym);
  const qtyPrec   = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;

  const riskMultiplier = confidence === 'HIGH' ? CONFIG.RISK_PCT : CONFIG.RISK_PCT * 0.6;
  const qty = Math.floor((availUsdt * riskMultiplier * leverage / price) * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

  // ── Fee validation ─────────────────────────────────────
  // Total fees = notional × taker_fee × 2 sides
  const notional     = qty * price;
  const totalFees    = notional * CONFIG.TAKER_FEE * 2;
  const expectedProfit = notional * CONFIG.TP_PCT;
  const feeRatioPct  = (totalFees / notional * 100).toFixed(4);
  log(`Fee check: notional=$${notional.toFixed(2)} fees=$${totalFees.toFixed(4)} (${feeRatioPct}%) profit@TP=$${expectedProfit.toFixed(4)}`);
  if (expectedProfit < totalFees * 2) {
    // TP profit is less than 2× fees — not worth it
    throw new Error(`Trade rejected: TP profit $${expectedProfit.toFixed(4)} < 2× fees $${totalFees.toFixed(4)}`);
  }

  const entrySide = isLong ? 'BUY' : 'SELL';
  const closeSide = isLong ? 'SELL' : 'BUY';

  const order = await client.submitNewOrder({ symbol: sym, side: entrySide, type: 'MARKET', quantity: qty });

  const tp = parseFloat((isLong
    ? price * (1 + CONFIG.TP_PCT)
    : price * (1 - CONFIG.TP_PCT)
  ).toFixed(pricePrec));

  const sl = parseFloat((isLong
    ? price * (1 - CONFIG.SL_PCT)
    : price * (1 + CONFIG.SL_PCT)
  ).toFixed(pricePrec));

  try {
    await client.submitNewOrder({
      symbol: sym, side: closeSide, type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { log(`TP warn: ${e.message}`); }

  try {
    await client.submitNewOrder({
      symbol: sym, side: closeSide, type: 'STOP_MARKET',
      stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { log(`SL warn: ${e.message}`); }

  return { sym, qty, entry: price, leverage, tp, sl, confidence, direction, orderId: order.orderId };
}

// ── CHECK TRAILING STOP (LONG + SHORT) ────────────────────────
async function checkTrailingStop(client) {
  try {
    const account   = await client.getAccountInformation();
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    for (const p of positions) {
      const sym    = p.symbol;
      const entry  = parseFloat(p.entryPrice);
      const amt    = parseFloat(p.positionAmt);
      const isLong = amt > 0;
      const ticker = await client.getSymbolPriceTicker({ symbol: sym });
      const cur    = parseFloat(ticker.price);

      // Gain direction depends on trade direction
      const gain = isLong
        ? (cur - entry) / entry
        : (entry - cur) / entry;

      if (gain >= CONFIG.TRAIL_PCT) {
        // Tighten SL to lock in profit
        const newSl = isLong
          ? parseFloat((cur * (1 - CONFIG.SL_PCT * 0.5)).toFixed(6))
          : parseFloat((cur * (1 + CONFIG.SL_PCT * 0.5)).toFixed(6));

        const tp = isLong
          ? parseFloat((entry * (1 + CONFIG.TP_PCT)).toFixed(6))
          : parseFloat((entry * (1 - CONFIG.TP_PCT)).toFixed(6));

        const closeSide = isLong ? 'SELL' : 'BUY';
        const label     = isLong ? 'LONG' : 'SHORT';
        log(`Trailing stop [${label}] ${sym}: SL → $${newSl} (gain: ${(gain*100).toFixed(2)}%)`);

        try {
          await client.cancelAllOpenOrders({ symbol: sym });
          await client.submitNewOrder({
            symbol: sym, side: closeSide, type: 'TAKE_PROFIT_MARKET',
            stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
          });
          await client.submitNewOrder({
            symbol: sym, side: closeSide, type: 'STOP_MARKET',
            stopPrice: newSl, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
          });
        } catch (e) { log(`Trailing update warn: ${e.message}`); }
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
  log(`IP BANNED — pausing trader for ${mins} min`);
  notify(`🚫 *Binance IP Banned*\nTrader paused *${mins} min*. Resumes automatically.`);
  return true;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  if (banUntil > Date.now()) {
    const mins = Math.ceil((banUntil - Date.now()) / 60000);
    log(`Still banned for ${mins} min — skipping cycle`);
    return;
  }

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
        const isLong = amt > 0;
        const pct   = (isLong ? (cur - entry) : (entry - cur)) / entry * 100 * lev;
        const side  = isLong ? '🟢 LONG' : '🔴 SHORT';
        const tp    = parseFloat((isLong ? entry * (1 + CONFIG.TP_PCT) : entry * (1 - CONFIG.TP_PCT)).toFixed(6));
        const sl    = parseFloat((isLong ? entry * (1 - CONFIG.SL_PCT) : entry * (1 + CONFIG.SL_PCT)).toFixed(6));

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

    const isLongTrade  = result.direction !== 'SHORT';
    const dirEmoji     = isLongTrade ? '🟢' : '🔴';
    const tpSign       = isLongTrade ? '+' : '-';
    const slSign       = isLongTrade ? '-' : '+';
    const streakLabel  = pick.streak > 0 ? `${pick.streak} 🟢 green` : `${Math.abs(pick.streak)} 🔴 red`;
    // Fee info for transparency
    const notional     = result.qty * result.entry;
    const totalFees    = notional * CONFIG.TAKER_FEE * 2;
    const netProfit    = notional * CONFIG.TP_PCT - totalFees;

    await notify(
      `🚀 *NEW TRADE — ${now()}*\n\n` +
      `Coin: *${result.sym}*\n` +
      `Direction: ${dirEmoji} *${result.direction} x${result.leverage}*\n` +
      (pick.rule2Long ? `🏦 *Rule 2 — OB Reversal* (${pick.reversalType})\n` : '') +
      `Confidence: *${result.confidence}* ⭐\n` +
      `Entry: \`$${fmtPrice(result.entry)}\`\n` +
      `Qty: \`${result.qty}\`\n` +
      `🎯 TP: \`$${fmtPrice(result.tp)}\` (${tpSign}3.5%)\n` +
      `🛑 SL: \`$${fmtPrice(result.sl)}\` (${slSign}1.0%)\n` +
      `💸 Fees: \`$${totalFees.toFixed(4)}\` | Net: \`$${netProfit.toFixed(4)}\`\n\n` +
      `📊 *Signals:*\n` +
      `• Structure: \`${pick.marketStructure}\` (${pick.trend})\n` +
      (pick.rule2Long && pick.obZone ? `• OB zone: \`$${fmtPrice(pick.obZone.low)}\`–\`$${fmtPrice(pick.obZone.high)}\`\n` : '') +
      (pick.eql ? `• EQL: \`$${fmtPrice(pick.eql)}\` (liq. below)\n` : '') +
      (pick.eqh ? `• EQH: \`$${fmtPrice(pick.eqh)}\` (liq. above)\n` : '') +
      `• RSI: \`${pick.rsi?.toFixed(1)}\` | MACD: ${pick.macdBullish ? '✅' : '❌'}\n` +
      `• Streak: ${streakLabel} | 1H: \`${pick.mom1h.toFixed(2)}%\`\n` +
      `• Volume: \`${pick.volRatio.toFixed(1)}x\` | BB: \`${(pick.bbPosition * 100).toFixed(0)}%\`\n` +
      `• Score: \`${pick.score.toFixed(1)}\`\n\n` +
      `💰 Risk: *$${riskUsdt} USDT* | Wallet: *$${avail.toFixed(4)}*`
    );

  } catch (err) {
    if (checkBanError(err)) return; // IP ban — already notified, skip generic error
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
