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
const CONFIG = {
  // Leverage: BTC/ETH = 100x (tight SL so risk is controlled), alts = 20x
  LEVERAGE_HIGH:   100,
  LEVERAGE_LOW:    20,       // 20x for alts
  HIGH_LEV_COINS:  ['BTCUSDT', 'ETHUSDT'],

  // SL placed 0.1% beyond the 15m swing point (user rule)
  SL_BUFFER:       0.001,   // 0.1% buffer past swing point

  // TP: initial = 3× SL distance (1:3 RR). Bot also monitors for 15m swing exit.
  TP_RR:           3,       // risk:reward ratio for initial TP order

  // Trailing stop: once price moves in our favour by TRAIL_PCT, tighten SL
  TRAIL_PCT:       0.008,   // 0.8% activation

  // Position sizing: risk 3% of wallet per trade (sized by SL distance)
  // $10 wallet → $0.30 max loss per trade (≈ 30% of $1 margin)
  WALLET_RISK_PCT: 0.03,

  MIN_BALANCE:     5,
  MIN_VOL_M:       100,     // min $100M 24h volume
  MIN_SCORE:       8,       // structure + 1m confirmation does the heavy filtering

  RSI_MAX:         68,
  RSI_MIN:         32,
  RSI_SHORT_MIN:   48,
  RSI_SHORT_MAX:   85,
  TAKER_FEE:       0.0004,
  EMA_FAST:        9,
  EMA_SLOW:        21,

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

// ── VWAP + BANDS ──────────────────────────────────────────────
// Volume Weighted Average Price calculated from provided klines
// Upper band = VWAP + 1.5σ, Lower band = VWAP - 1.5σ
function calcVWAP(klines) {
  if (!klines || klines.length < 5) return null;
  let sumPV = 0, sumVol = 0;
  const typicals = [];
  for (const k of klines) {
    const typical = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
    const vol     = parseFloat(k[5]);
    sumPV   += typical * vol;
    sumVol  += vol;
    typicals.push(typical);
  }
  if (sumVol === 0) return null;
  const vwap = sumPV / sumVol;
  const variance = typicals.reduce((s, p) => s + Math.pow(p - vwap, 2), 0) / typicals.length;
  const std = Math.sqrt(variance);
  return { vwap, upper: vwap + 1.5 * std, lower: vwap - 1.5 * std };
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

// ── 1-MIN ENTRY CONFIRMATION ──────────────────────────────────
// SHORT sequence (user rule):
//   15m LH confirmed → drop to 1m → wait for 1m LL to form → then wait for 1m LH → SHORT entry
// LONG sequence (mirror):
//   15m HL confirmed → drop to 1m → wait for 1m HH to form → then wait for 1m HL → LONG entry
function detect1mEntry(klines1m, targetLevel, direction) {
  if (!klines1m || klines1m.length < 10) return { valid: false, reason: 'not enough 1m data' };

  const struct1m = detectStructure(klines1m);
  const closes1m = klines1m.map(k => parseFloat(k[4]));
  const price    = closes1m[closes1m.length - 1];

  // Price must be within 2% of the 15m swing level we're waiting at
  const nearTarget = Math.abs(price - targetLevel) / targetLevel < 0.02;
  if (!nearTarget) return { valid: false, reason: `not near target $${fmtPrice(targetLevel)}` };

  if (direction === 'SHORT') {
    // 15m shows LH (bearish) → on 1m:
    //   • LL forms (momentum pushes down) — confirmed by slLabel === 'LL'
    //   • Then LH forms on 1m (price pulls back = SHORT entry point)
    // Accept if BOTH LL+LH present, OR if bearish CHoCH on 1m (structure flipped down)
    const llFormed1m = struct1m.slLabel === 'LL';
    const lhFormed1m = struct1m.shLabel === 'LH';
    const valid = (llFormed1m && lhFormed1m) || struct1m.choch === 'bearish';
    return {
      valid,
      reason: valid
        ? `1m ${llFormed1m && lhFormed1m ? 'LL+LH' : 'CHoCH bearish'} — short entry`
        : `1m not ready: need LL+LH or CHoCH, got (SH:${struct1m.shLabel} SL:${struct1m.slLabel})`,
      struct: struct1m,
    };
  } else {
    // 15m shows HL (bullish) → on 1m:
    //   • HH forms (momentum pushes up)
    //   • Then HL forms on 1m (pullback = LONG entry point)
    // Accept if BOTH HH+HL present, OR if bullish CHoCH on 1m
    const hhFormed1m = struct1m.shLabel === 'HH';
    const hlFormed1m = struct1m.slLabel === 'HL';
    const valid = (hhFormed1m && hlFormed1m) || struct1m.choch === 'bullish';
    return {
      valid,
      reason: valid
        ? `1m ${hhFormed1m && hlFormed1m ? 'HH+HL' : 'CHoCH bullish'} — long entry`
        : `1m not ready: need HH+HL or CHoCH, got (SH:${struct1m.shLabel} SL:${struct1m.slLabel})`,
      struct: struct1m,
    };
  }
}

// ── SHOULD EXIT — 15m next swing formed + liquidity swept ─────
// Exit when: the NEXT swing point on 15m has formed beyond our entry, AND
//            price has swept through an equal high/low (liquidity taken)
function shouldExit15m(struct15, entryPrice, direction) {
  if (direction === 'LONG') {
    const newSwingAboveEntry = struct15.sh1 && struct15.sh1 > entryPrice * 1.005;
    const liqSwept = struct15.eqh && struct15.eqh > 0; // EQH exists = longs already swept
    return newSwingAboveEntry && liqSwept;
  } else {
    const newSwingBelowEntry = struct15.sl1 && struct15.sl1 < entryPrice * 0.995;
    const liqSwept = struct15.eql && struct15.eql > 0;
    return newSwingBelowEntry && liqSwept;
  }
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

    // ── Filter extreme 24h movers early (pumps/dumps = unreliable signals) ─
    const chg24hRaw = parseFloat(ticker.priceChangePercent);
    if (Math.abs(chg24hRaw) > 50) return null;

    // ── 1h trend: must align with trade direction ────────────
    // LONG only when 1h is bullish (EMA9 > EMA21), SHORT only when 1h is bearish.
    // This stops trading counter-trend bounces on 15m against the bigger move.
    let trend1h = 'neutral';
    try {
      const klines1h  = await client.getKlines({ symbol: sym, interval: '1h', limit: 30 });
      const closes1h  = klines1h.map(k => parseFloat(k[4]));
      const ema9_1h   = calcEMA(closes1h, 9);
      const ema21_1h  = calcEMA(closes1h, 21);
      if (ema9_1h && ema21_1h) trend1h = ema9_1h > ema21_1h ? 'bullish' : 'bearish';
    } catch (_) {}

    // ── 1-min klines (250 bars for 200 EMA + VWAP) ─────────
    let klines1m = null;
    try { klines1m = await client.getKlines({ symbol: sym, interval: '1m', limit: 250 }); } catch (_) {}

    // ── Daily klines for PDL, PDH, session opening price ───
    let dailyLevels = null;
    try {
      const klines1d = await client.getKlines({ symbol: sym, interval: '1d', limit: 3 });
      if (klines1d.length >= 2) {
        dailyLevels = {
          todayOpen: parseFloat(klines1d[klines1d.length - 1][1]), // session opening price
          pdl:       parseFloat(klines1d[klines1d.length - 2][3]), // prev day low
          pdh:       parseFloat(klines1d[klines1d.length - 2][2]), // prev day high
        };
      }
    } catch (_) {}

    // ── VWAP + 200 EMA on 1m ───────────────────────────────
    const vwap1m    = calcVWAP(klines1m);
    const closes1m  = klines1m ? klines1m.map(k => parseFloat(k[4])) : [];
    const ema200_1m = closes1m.length >= 200 ? calcEMA(closes1m, 200) : null;

    // ── Rule 3: SHORT confluence check ─────────────────────
    // "Rejection at OP + upper VWAP + 200 EMA — 2 of 3 must align at LH"
    const CONF_TOL = 0.003; // within 0.3% counts as "at the level"
    const nearUpperVWAP  = vwap1m   && Math.abs(price - vwap1m.upper)       / price < CONF_TOL;
    const near200EMA     = ema200_1m && Math.abs(price - ema200_1m)          / price < CONF_TOL;
    const nearSessionOpen= dailyLevels && Math.abs(price - dailyLevels.todayOpen) / price < CONF_TOL;
    const confluenceCount = [nearUpperVWAP, near200EMA, nearSessionOpen].filter(Boolean).length;
    const rule3Confluence = confluenceCount >= 2; // strong short confluence

    // For LONG: lower VWAP band / 200 EMA as dynamic support
    const nearLowerVWAP  = vwap1m   && Math.abs(price - vwap1m.lower)       / price < CONF_TOL;
    const longConfluence = [nearLowerVWAP, near200EMA, nearSessionOpen].filter(Boolean).length >= 2;

    // TP target: PDL for shorts, PDH for longs (if reachable within 10%)
    const tpPDL = dailyLevels && dailyLevels.pdl < price * 0.99 && dailyLevels.pdl > price * 0.90
      ? dailyLevels.pdl : null;
    const tpPDH = dailyLevels && dailyLevels.pdh > price * 1.01 && dailyLevels.pdh < price * 1.10
      ? dailyLevels.pdh : null;

    // ── 1m entry confirmation ──────────────────────────────
    const entry1mLong  = detect1mEntry(klines1m, struct.sl1 || price, 'LONG');
    const entry1mShort = detect1mEntry(klines1m, struct.sh1 || price, 'SHORT');

    const macd     = calcMACD(closes);
    const bb       = calcBollingerBands(closes);
    const bbPos    = bb ? (price - bb.lower) / (bb.upper - bb.lower) : 0.5;
    const atr      = calcATR(klines15);
    const atrPct   = atr ? (atr / price) * 100 : 0;
    if (atrPct > 8) return null; // only reject extreme volatility

    const recentVol = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const prevVol   = vols.slice(-8, -3).reduce((a, b) => a + b, 0) / 5;
    const volRatio  = prevVol > 0 ? recentVol / prevVol : 1;
    // volume scored but not a hard filter — don't block setups in quiet markets

    const chg24h  = parseFloat(ticker.priceChangePercent);
    const fundRate= fundRates[sym] || 0;


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
    // 1m entry confirmation: price must be near the 15m swing level + 1m structure aligned
    const isLongTrend  = (rule2Long || (!lhFormed && (struct.trend === 'uptrend' || struct.trend === 'bullish' || eqlSweep || chochBullish)))
                         && entry1mLong.valid;  // 1m must confirm entry at HL
    const isShortTrend = (!rule2Long && (lhFormed || struct.trend === 'downtrend' || struct.trend === 'bearish' || eqhSweep || chochBearish))
                         && entry1mShort.valid; // 1m must confirm entry at LH

    if (!isLongTrend && !isShortTrend) return null;

    // ── LONG filters ───────────────────────────────────────
    if (isLongTrend) {
      // 1h must be bullish — don't buy into a downtrend
      if (trend1h === 'bearish' && !rule2Long) return null;
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
      // Rule 3 LONG: lower VWAP band / 200 EMA / session open = dynamic support confluence
      if (longConfluence) score += 10;
      else if (nearLowerVWAP || near200EMA) score += 5;

      let confidence = 'LOW';
      if (score >= 25) confidence = 'HIGH';
      else if (score >= 20) confidence = 'MEDIUM';

      const slPrice  = struct.sl1 ? struct.sl1 * (1 - CONFIG.SL_BUFFER) : price * 0.988;
      const leverage = CONFIG.HIGH_LEV_COINS.includes(sym) ? CONFIG.LEVERAGE_HIGH : CONFIG.LEVERAGE_LOW;

      return {
        sym, price, score, confidence, direction: 'LONG',
        chg24h, mom1h, mom30m, streak,
        rsi, macdBullish: macd?.positive, bbPosition: bbPos, volRatio, atrPct,
        distHigh, fundRate, leverage,
        marketStructure: struct.marketStructure, trend: struct.trend,
        eql: struct.eql, eqh: struct.eqh,
        rule2Long, obZone: ob, reversalType: reversal.type,
        slPrice, entry1m: entry1mLong, swingRef: struct.sl1,
        // Rule 3
        confluenceCount: longConfluence ? 2 : 0,
        nearVWAP: nearLowerVWAP, near200EMA, nearSessionOpen,
        vwap: vwap1m?.vwap, ema200: ema200_1m,
        tpLevel: tpPDH || null, // PDH as TP for longs
        pdl: dailyLevels?.pdl, pdh: dailyLevels?.pdh,
        sessionOpen: dailyLevels?.todayOpen,
      };
    }

    // ── SHORT filters ──────────────────────────────────────
    if (isShortTrend) {
      // 1h must be bearish — don't short into an uptrend
      if (trend1h === 'bullish') return null;
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
      if (fundRate > 0.05) score += 6;
      if (fundRate < -0.02) score -= 10;
      if (chg24h < -40) score -= 15;
      // Rule 3 SHORT: rejection at upper VWAP + 200 EMA + session open = strong confluence
      if (rule3Confluence) score += 12;              // 2+ levels rejecting = very strong
      else if (nearUpperVWAP || near200EMA) score += 5;

      let confidence = 'LOW';
      if (score >= 25) confidence = 'HIGH';
      else if (score >= 20) confidence = 'MEDIUM';

      const slPrice = struct.sh1 ? struct.sh1 * (1 + CONFIG.SL_BUFFER) : price * 1.012;
      const leverage = CONFIG.HIGH_LEV_COINS.includes(sym) ? CONFIG.LEVERAGE_HIGH : CONFIG.LEVERAGE_LOW;

      return {
        sym, price, score, confidence, direction: 'SHORT',
        chg24h, mom1h, mom30m, streak,
        rsi, macdBullish: macd?.positive, bbPosition: bbPos, volRatio, atrPct,
        distHigh, fundRate, leverage,
        marketStructure: struct.marketStructure, trend: struct.trend,
        eql: struct.eql, eqh: struct.eqh,
        slPrice, entry1m: entry1mShort, swingRef: struct.sh1,
        // Rule 3
        rule3Confluence, confluenceCount,
        nearVWAP: nearUpperVWAP, near200EMA, nearSessionOpen,
        vwap: vwap1m?.vwap, ema200: ema200_1m,
        tpLevel: tpPDL || null,  // PDL as TP for shorts
        pdl: dailyLevels?.pdl, pdh: dailyLevels?.pdh,
        sessionOpen: dailyLevels?.todayOpen,
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
    !t.symbol.includes('_') &&
    !CONFIG.BLACKLIST.includes(t.symbol) &&
    !CONFIG.HIGH_LEV_COINS.includes(t.symbol) && // alts only — skip BTC & ETH (too expensive per qty)
    parseFloat(t.quoteVolume) > CONFIG.MIN_VOL_M * 1e6 &&
    Math.abs(parseFloat(t.priceChangePercent)) < 40
  );

  // Top 40 by volume — sorted by 24h volume to match TradingView ranking
  const top40 = candidates
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 40);

  // Batch-fetch ALL funding rates in ONE call instead of per-symbol
  const fundRates = {};
  try {
    const allFunding = await client.getFundingRate({});
    for (const f of allFunding) fundRates[f.symbol] = parseFloat(f.fundingRate) * 100;
  } catch (_) {}

  log(`Analyzing ${top40.length} candidates (1 funding call total)...`);

  const scored = [];
  const BATCH = 3;
  for (let i = 0; i < top40.length; i += BATCH) {
    const batch = top40.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(t => analyzeSymbol(client, t, fundRates)));
    results.forEach(r => { if (r && r.score >= CONFIG.MIN_SCORE) scored.push(r); });
    await sleep(600);
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  log('Top picks:');
  scored.slice(0, 5).forEach((s, i) =>
    log(`  ${i+1}. ${s.sym} score=${s.score.toFixed(1)} RSI=${s.rsi?.toFixed(1)} conf=${s.confidence} 1h=${s.mom1h.toFixed(2)}%`)
  );

  return scored[0];
}

// ── SIGNAL QUEUE (injected from bot.js signal scanner) ────────
// When bot.js posts a validated signal, it calls queueSignal()
// cycle.js processes this queue first before doing its own scan
const signalQueue = [];

function queueSignal(sig) {
  // sig = { symbol, direction:'LONG'|'SHORT', slPrice, tpLevel, smcBadges }
  const exists = signalQueue.find(s => s.symbol === sig.symbol);
  if (!exists) {
    signalQueue.push({ ...sig, queuedAt: Date.now() });
    log(`Signal queued for trade: ${sig.symbol} ${sig.direction}`);
  }
}

// ── TRADE STATE (multi-TP management) ─────────────────────────
// Persists TP levels + which TPs have been hit across cycles
const tradeState = new Map();
// sym → { entry, tp1, tp2, tp3, sl, qty, isLong, tpHit1, tpHit2, pricePrec, qtyPrec }

// ── OPEN TRADE (LONG or SHORT) ────────────────────────────────
async function openTrade(client, pick, wallet) {
  const { sym, price, leverage, confidence, direction, slPrice } = pick;
  const isLong = direction !== 'SHORT';

  await client.setLeverage({ symbol: sym, leverage });
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch (e) { if (!e.message?.includes('No need')) throw e; }

  const info      = await client.getExchangeInfo();
  const sinfo     = info.symbols.find(s => s.symbol === sym);
  const qtyPrec   = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;

  const floorQ = (q) => Math.floor(q * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
  const fmtP   = (p) => parseFloat(p.toFixed(pricePrec));

  // ── SL from 15m swing point (0.1% buffer) ──────────────
  const sl     = fmtP(slPrice);
  const slDist = Math.abs(price - sl) / price;

  // ── Position size: 1% of wallet at risk ────────────────
  // Sized from actual wallet so it scales automatically as balance grows/shrinks
  const MIN_NOTIONAL = 5.5; // Binance minimum is $5 — use $5.5 for safety margin
  const riskUsdt = wallet * CONFIG.WALLET_RISK_PCT;
  const rawQty   = riskUsdt / (slDist * price);
  let   qty      = floorQ(rawQty);

  // Bump qty up to meet $5 minimum notional if needed
  if (qty * price < MIN_NOTIONAL) {
    qty = Math.ceil(MIN_NOTIONAL / price * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);
    log(`Qty bumped to ${qty} to meet $${MIN_NOTIONAL} min notional for ${sym}`);
  }
  if (qty <= 0) {
    log(`Qty too small for ${sym} even after bump — skipping`);
    return null;
  }

  // ── Three TP levels ─────────────────────────────────────
  // Full distance: PDL/PDH if available, else 3× RR
  // Divide into thirds: TP1 = 1/3, TP2 = 2/3, TP3 = full
  const tpFullDist = pick.tpLevel
    ? Math.abs(pick.tpLevel - price) / price
    : slDist * CONFIG.TP_RR;
  const tp1 = fmtP(isLong ? price * (1 + tpFullDist / 3)     : price * (1 - tpFullDist / 3));
  const tp2 = fmtP(isLong ? price * (1 + tpFullDist * 2 / 3) : price * (1 - tpFullDist * 2 / 3));
  const tp3 = fmtP(isLong ? price * (1 + tpFullDist)         : price * (1 - tpFullDist));

  // ── Fee check against TP1 (worst case — smallest profit) ─
  const notional  = qty * price;
  const totalFees = notional * CONFIG.TAKER_FEE * 2;
  const tp1Profit = notional * (tpFullDist / 3) * 0.5; // 50% qty at TP1
  log(`Fee check: notional=$${notional.toFixed(2)} fees=$${totalFees.toFixed(4)} TP1 profit=$${tp1Profit.toFixed(4)} SL%=${(slDist*100).toFixed(3)}%`);
  if (tp1Profit < totalFees * 1.5) throw new Error(`Trade rejected: TP1 profit $${tp1Profit.toFixed(4)} < 1.5× fees $${totalFees.toFixed(4)}`);

  const entrySide = isLong ? 'BUY'  : 'SELL';
  const closeSide = isLong ? 'SELL' : 'BUY';

  // Market entry
  const order = await client.submitNewOrder({ symbol: sym, side: entrySide, type: 'MARKET', quantity: qty });

  // TP3 — full-position safety net (Binance manages this one)
  try {
    await client.submitNewOrder({
      symbol: sym, side: closeSide, type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp3, closePosition: 'true',
      workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { log(`TP3 order warn: ${e.message}`); }

  // SL — protect full position initially
  try {
    await client.submitNewOrder({
      symbol: sym, side: closeSide, type: 'STOP_MARKET',
      stopPrice: sl, closePosition: 'true',
      workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { log(`SL order warn: ${e.message}`); }

  // TP1 & TP2 are managed by price monitoring in checkTrailingStop
  // using market orders — more reliable than Binance quantity-based conditional orders
  tradeState.set(sym, { entry: price, tp1, tp2, tp3, sl, qty, isLong, tpHit1: false, tpHit2: false, pricePrec, qtyPrec });

  return { sym, qty, entry: price, leverage, tp1, tp2, tp3, sl, slDist, tpFullDist, confidence, direction, orderId: order.orderId };
}

// ── CHECK MULTI-TP + EXIT RULES ────────────────────────────────
async function checkTrailingStop(client) {
  try {
    const account   = await client.getAccountInformation({ omitZeroBalances: false });
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    // Clean up state for any positions that are now fully closed
    for (const sym of tradeState.keys()) {
      if (!positions.find(p => p.symbol === sym)) {
        log(`${sym} fully closed — clearing trade state`);
        tradeState.delete(sym);
      }
    }

    for (const p of positions) {
      const sym       = p.symbol;
      const entry     = parseFloat(p.entryPrice);
      const amt       = parseFloat(p.positionAmt);
      const isLong    = amt > 0;
      const ticker    = await client.getSymbolPriceTicker({ symbol: sym });
      const cur       = parseFloat(ticker.price);
      const closeSide = isLong ? 'SELL' : 'BUY';
      const gain      = isLong ? (cur - entry) / entry : (entry - cur) / entry;

      // ── 15m swing exit: next swing formed + liquidity swept ─
      try {
        const klines15 = await client.getKlines({ symbol: sym, interval: '15m', limit: 50 });
        const struct15 = detectStructure(klines15);
        if (shouldExit15m(struct15, entry, isLong ? 'LONG' : 'SHORT')) {
          log(`Exit [${isLong?'LONG':'SHORT'}] ${sym}: 15m swing + liquidity swept`);
          await client.cancelAllOpenOrders({ symbol: sym });
          await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', closePosition: 'true' });
          tradeState.delete(sym);
          await notify(
            `✅ *Exit: 15m Swing + Liquidity Swept*\n` +
            `*${sym}* ${isLong ? '🟢 LONG' : '🔴 SHORT'}\n` +
            `Entry: \`$${fmtPrice(entry)}\` → Exit: \`$${fmtPrice(cur)}\`\n` +
            `Gain: *${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(2)}%*`
          );
          continue;
        }
      } catch (_) {}

      const state = tradeState.get(sym);
      if (!state) continue;

      const fmtP  = (p) => parseFloat(p.toFixed(state.pricePrec));
      const floorQ = (q) => Math.floor(q * Math.pow(10, state.qtyPrec)) / Math.pow(10, state.qtyPrec);
      const origQty = Math.abs(state.qty);

      // ── TP1 hit: price crossed TP1 → market close 50%, SL to BE ─
      if (!state.tpHit1) {
        const tp1Hit = isLong ? cur >= state.tp1 : cur <= state.tp1;
        if (tp1Hit) {
          state.tpHit1 = true;
          const closeQty = floorQ(origQty * 0.5);
          const newSl    = fmtP(state.entry);
          log(`TP1 hit ${sym} @ $${fmtPrice(cur)}: closing 50% (${closeQty}), SL → break even $${fmtPrice(newSl)}`);
          try {
            await client.cancelAllOpenOrders({ symbol: sym });
            // Market close 50%
            if (closeQty > 0) {
              await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: closeQty, reduceOnly: 'true' });
            }
            // SL at break even
            await client.submitNewOrder({
              symbol: sym, side: closeSide, type: 'STOP_MARKET',
              stopPrice: newSl, closePosition: 'true',
              workingType: 'MARK_PRICE', priceProtect: 'TRUE',
            });
            // TP3 safety net back on
            await client.submitNewOrder({
              symbol: sym, side: closeSide, type: 'TAKE_PROFIT_MARKET',
              stopPrice: state.tp3, closePosition: 'true',
              workingType: 'MARK_PRICE', priceProtect: 'TRUE',
            });
          } catch (e) { log(`TP1 exec warn: ${e.message}`); state.tpHit1 = false; }
          await notify(
            `🎯 *TP1 Hit!* — *${sym}* ${isLong ? '🟢 LONG' : '🔴 SHORT'}\n` +
            `50% closed @ \`$${fmtPrice(cur)}\`\n` +
            `SL → break even: \`$${fmtPrice(newSl)}\` ✅ no-loss zone\n` +
            `TP2: \`$${fmtPrice(state.tp2)}\`  |  TP3: \`$${fmtPrice(state.tp3)}\``
          );
          continue;
        }
      }

      // ── TP2 hit: price crossed TP2 → market close 25%, SL to TP1 ─
      if (state.tpHit1 && !state.tpHit2) {
        const tp2Hit = isLong ? cur >= state.tp2 : cur <= state.tp2;
        if (tp2Hit) {
          state.tpHit2 = true;
          const closeQty = floorQ(origQty * 0.25);
          const newSl    = fmtP(state.tp1);
          log(`TP2 hit ${sym} @ $${fmtPrice(cur)}: closing 25% (${closeQty}), SL → TP1 $${fmtPrice(newSl)}`);
          try {
            await client.cancelAllOpenOrders({ symbol: sym });
            // Market close 25%
            if (closeQty > 0) {
              await client.submitNewOrder({ symbol: sym, side: closeSide, type: 'MARKET', quantity: closeQty, reduceOnly: 'true' });
            }
            // SL locked at TP1 (guaranteed profit)
            await client.submitNewOrder({
              symbol: sym, side: closeSide, type: 'STOP_MARKET',
              stopPrice: newSl, closePosition: 'true',
              workingType: 'MARK_PRICE', priceProtect: 'TRUE',
            });
            // TP3 final target
            await client.submitNewOrder({
              symbol: sym, side: closeSide, type: 'TAKE_PROFIT_MARKET',
              stopPrice: state.tp3, closePosition: 'true',
              workingType: 'MARK_PRICE', priceProtect: 'TRUE',
            });
          } catch (e) { log(`TP2 exec warn: ${e.message}`); state.tpHit2 = false; }
          await notify(
            `🎯 *TP2 Hit!* — *${sym}* ${isLong ? '🟢 LONG' : '🔴 SHORT'}\n` +
            `25% closed @ \`$${fmtPrice(cur)}\`\n` +
            `SL → TP1: \`$${fmtPrice(newSl)}\` ✅ profit locked\n` +
            `Riding last 25% → TP3: \`$${fmtPrice(state.tp3)}\``
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
    const account   = await client.getAccountInformation({ omitZeroBalances: false });
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
        const pct    = (isLong ? (cur - entry) : (entry - cur)) / entry * 100 * lev;
        const side   = isLong ? '🟢 LONG' : '🔴 SHORT';
        const state  = tradeState.get(sym);
        const tp1Str = state ? `TP1: \`$${fmtPrice(state.tp1)}\`  TP2: \`$${fmtPrice(state.tp2)}\`  TP3: \`$${fmtPrice(state.tp3)}\`` : '(TP managed by orders)';
        const slStr  = state ? `\`$${fmtPrice(state.sl)}\`` : '(managed)';
        const tpHits = state ? ` [${state.tpHit1 ? 'TP1✅' : 'TP1⏳'}${state.tpHit2 ? ' TP2✅' : ' TP2⏳'}]` : '';

        await notify(
          `📊 *Position Update — ${now()}*\n\n` +
          `*${sym}* ${side} x${lev}${tpHits}\n` +
          `Entry: \`$${fmtPrice(entry)}\` → Now: \`$${fmtPrice(cur)}\`\n` +
          `PnL: ${pnl >= 0 ? '🟢' : '🔴'} *${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}* (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)\n` +
          `🎯 ${tp1Str}\n` +
          `🛑 SL: ${slStr}\n` +
          `💰 Wallet: *$${wallet.toFixed(4)} USDT*`
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

    // ── Check signal queue first (from bot.js validated signals) ─
    // Expire signals older than 45 min — stale entries shouldn't trade
    const now_ms = Date.now();
    while (signalQueue.length && now_ms - signalQueue[0].queuedAt > 45 * 60 * 1000) {
      const expired = signalQueue.shift();
      log(`Signal expired (>45m): ${expired.symbol} ${expired.direction}`);
    }

    let pick = null;

    if (signalQueue.length > 0) {
      const sig = signalQueue.shift();
      log(`Trading queued signal: ${sig.symbol} ${sig.direction}`);
      // Get current price and build a minimal pick object from the signal
      try {
        const ticker = await client.getSymbolPriceTicker({ symbol: sig.symbol });
        const price  = parseFloat(ticker.price);
        const leverage = CONFIG.HIGH_LEV_COINS.includes(sig.symbol) ? CONFIG.LEVERAGE_HIGH : CONFIG.LEVERAGE_LOW;
        // SL from signal's slPrice, or fallback 0.5% from price
        const slPrice = sig.slPrice || (sig.direction === 'LONG' ? price * 0.995 : price * 1.005);
        pick = {
          sym: sig.symbol, price, leverage,
          direction: sig.direction,
          slPrice,
          tpLevel: sig.tpLevel || null,
          confidence: 'SIGNAL',
          score: 99,
          marketStructure: sig.smcBadges?.join(', ') || 'Signal Bot',
          trend: sig.direction === 'LONG' ? 'bullish' : 'bearish',
          entry1m: { reason: 'queued from signal bot' },
          swingRef: slPrice,
          rule2Long: false, rsi: null, macdBullish: true,
          volRatio: 1, streak: 0, mom1h: 0, mom30m: 0,
          chg24h: 0, fundRate: 0, atrPct: 0, distHigh: 0,
          bbPosition: 0.5, eql: null, eqh: null,
          confluenceCount: 0, nearVWAP: false, near200EMA: false,
          nearSessionOpen: false, vwap: null, ema200: null,
          pdl: null, pdh: null, sessionOpen: null,
        };
      } catch (e) {
        log(`Queued signal error ${sig.symbol}: ${e.message} — falling back to scan`);
      }
    }

    // Only trade from signal queue — no random scanning
    if (!pick) {
      log('No queued signal — waiting for bot.js signal.');
      return;
    }

    const result = await openTrade(client, pick, wallet);
    if (!result) {
      log(`openTrade returned null for ${pick.sym} — skipping cycle`);
      return;
    }
    const riskUsdt  = (wallet * CONFIG.WALLET_RISK_PCT).toFixed(2);
    const isLongT   = result.direction !== 'SHORT';
    const dirEmoji  = isLongT ? '🟢' : '🔴';
    const tp1Pct    = (Math.abs(result.tp1 - result.entry) / result.entry * 100).toFixed(2);
    const tp2Pct    = (Math.abs(result.tp2 - result.entry) / result.entry * 100).toFixed(2);
    const tp3Pct    = (Math.abs(result.tp3 - result.entry) / result.entry * 100).toFixed(2);
    const slPct     = (result.slDist * 100).toFixed(3);
    const notional  = result.qty * result.entry;
    const totalFees = notional * CONFIG.TAKER_FEE * 2;
    const netProfit = notional * result.tpFullDist - totalFees;
    const streakLabel = pick.streak > 0 ? `${pick.streak} 🟢` : `${Math.abs(pick.streak)} 🔴`;

    await notify(
      `🚀 *NEW TRADE — ${now()}*\n\n` +
      `*${result.sym}* ${dirEmoji} *${result.direction} x${result.leverage}*\n` +
      (pick.rule2Long ? `🏦 *Rule 2 — OB Reversal* (${pick.reversalType})\n` : '') +
      `Confidence: *${result.confidence}* ⭐\n` +
      `Entry: \`$${fmtPrice(result.entry)}\` | Qty: \`${result.qty}\`\n` +
      `🎯 TP1 (50%): \`$${fmtPrice(result.tp1)}\` (+${tp1Pct}%) → SL to break even\n` +
      `🎯 TP2 (25%): \`$${fmtPrice(result.tp2)}\` (+${tp2Pct}%) → SL to TP1\n` +
      `🎯 TP3 (25%): \`$${fmtPrice(result.tp3)}\` (+${tp3Pct}%) → full close\n` +
      `🛑 SL: \`$${fmtPrice(result.sl)}\` (-${slPct}% · swing point)\n` +
      `💸 Fees: \`$${totalFees.toFixed(4)}\` | Net@TP3: \`$${netProfit.toFixed(4)}\`\n\n` +
      `📊 *Structure:*\n` +
      `• 15m: \`${pick.marketStructure}\` (${pick.trend})\n` +
      `• 1m: \`${pick.entry1m?.reason || 'confirmed'}\`\n` +
      `• Swing ref: \`$${fmtPrice(pick.swingRef)}\`\n` +
      (pick.rule2Long && pick.obZone ? `• OB: \`$${fmtPrice(pick.obZone.low)}\`–\`$${fmtPrice(pick.obZone.high)}\`\n` : '') +
      (pick.eql ? `• EQL: \`$${fmtPrice(pick.eql)}\`\n` : '') +
      (pick.eqh ? `• EQH: \`$${fmtPrice(pick.eqh)}\`\n` : '') +
      (pick.rule3Confluence ? `• 🎯 *Rule 3 Confluence* (${pick.confluenceCount}/3 levels)\n` : '') +
      (pick.nearVWAP    ? `  └ Upper VWAP: \`$${fmtPrice(pick.vwap)}\` ✅\n` : '') +
      (pick.near200EMA  ? `  └ 200 EMA: \`$${fmtPrice(pick.ema200)}\` ✅\n` : '') +
      (pick.nearSessionOpen ? `  └ Session Open: \`$${fmtPrice(pick.sessionOpen)}\` ✅\n` : '') +
      (pick.tpLevel     ? `• TP = ${isLongT ? 'PDH' : 'PDL'}: \`$${fmtPrice(pick.tpLevel)}\`\n` : '') +
      (pick.pdl         ? `• PDL: \`$${fmtPrice(pick.pdl)}\` | PDH: \`$${fmtPrice(pick.pdh)}\`\n` : '') +
      `• RSI: \`${pick.rsi?.toFixed(1)}\` | MACD: ${pick.macdBullish ? '✅' : '❌'} | Vol: \`${pick.volRatio.toFixed(1)}x\`\n` +
      `• Streak: ${streakLabel} | Score: \`${pick.score.toFixed(1)}\`\n\n` +
      `💰 Risk: *$${riskUsdt} USDT* | Wallet: *$${avail.toFixed(4)}*`
    );

    // Execute for all registered users
    await executeForAllUsers(pick);

  } catch (err) {
    if (checkBanError(err)) return;
    const msg = String(err?.message || err);
    // Binance account hasn't signed Futures/Perps agreement — user action required
    if (msg.toLowerCase().includes('tradfi') || msg.toLowerCase().includes('perps') || msg.toLowerCase().includes('agreement')) {
      log(`Binance agreement required: ${msg}`);
      await notify(
        `⚠️ *Action Required — Binance Futures Agreement*\n\n` +
        `Your Binance account has not signed the USDT-M Perpetual Futures agreement.\n\n` +
        `*Fix:*\n` +
        `1. Open Binance app or website\n` +
        `2. Go to *Derivatives → USDT-M Futures*\n` +
        `3. Accept the agreement / terms popup\n` +
        `4. Bot will resume trading automatically\n\n` +
        `_This is a one-time account activation on Binance._`
      );
      return;
    }
    log(`ERROR: ${msg}`);
    await notify(`❌ *Bot Error — ${now()}*\n\`${msg.substring(0, 200)}\``);
  }

  log('=== Cycle End ===');
}

function getClient() {
  return new USDMClient({ api_key: API_KEY, api_secret: API_SECRET });
}

// ── MULTI-USER TRADE EXECUTION ──────────────────────────────
// When a signal fires, execute for all enabled user API keys
async function executeForAllUsers(pick) {
  let db, cryptoUtils;
  try {
    db = require('./db');
    cryptoUtils = require('./crypto-utils');
  } catch (e) {
    log(`Multi-user deps not available: ${e.message}`);
    return;
  }

  try {
    const keys = await db.query(
      `SELECT ak.*, u.email FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.enabled = true AND ak.platform = 'binance'`
    );

    if (!keys.length) {
      log('No enabled user API keys — skipping multi-user execution');
      return;
    }

    log(`Executing signal ${pick.sym} ${pick.direction} for ${keys.length} user keys`);

    const results = await Promise.allSettled(keys.map(async (key) => {
      try {
        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        const userClient = new USDMClient({ api_key: apiKey, api_secret: apiSecret });

        const account = await userClient.getAccountInformation({ omitZeroBalances: false });
        const wallet = parseFloat(account.totalWalletBalance);
        const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

        if (positions.length > 0) {
          log(`User ${key.email} already has ${positions.length} open positions — skip`);
          return;
        }

        if (wallet < CONFIG.MIN_BALANCE) {
          log(`User ${key.email} wallet $${wallet.toFixed(2)} < min $${CONFIG.MIN_BALANCE} — skip`);
          return;
        }

        // Apply user's custom settings
        const userPick = { ...pick };
        const userLev = parseInt(key.leverage) || CONFIG.LEVERAGE_LOW;
        userPick.leverage = userLev;

        const userRiskPct = parseFloat(key.risk_pct) || CONFIG.WALLET_RISK_PCT;
        const userMaxLoss = parseFloat(key.max_loss_usdt) || 999;

        // Override CONFIG temporarily for this user's trade
        const origRisk = CONFIG.WALLET_RISK_PCT;
        CONFIG.WALLET_RISK_PCT = userRiskPct;

        let result;
        try {
          result = await openTrade(userClient, userPick, wallet);
        } finally {
          CONFIG.WALLET_RISK_PCT = origRisk;
        }

        if (!result) {
          log(`User ${key.email} openTrade returned null — skip`);
          return;
        }

        // Cap loss at user's max_loss_usdt
        const actualRisk = wallet * userRiskPct;
        if (actualRisk > userMaxLoss) {
          log(`User ${key.email} risk $${actualRisk.toFixed(2)} > max $${userMaxLoss} — trade opened but oversized`);
        }

        // Log to trades table
        await db.query(
          `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, sl_price, tp_price, quantity, leverage, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')`,
          [key.id, key.user_id, result.sym, result.direction, result.entry, result.sl, result.tp3, result.qty, result.leverage]
        );

        log(`Trade executed for ${key.email}: ${result.sym} ${result.direction} x${result.leverage} qty=${result.qty}`);
      } catch (err) {
        log(`User ${key.email} trade error: ${err.message}`);
        try {
          await db.query(
            `INSERT INTO trades (api_key_id, user_id, symbol, direction, status, error_msg)
             VALUES ($1, $2, $3, $4, 'ERROR', $5)`,
            [key.id, key.user_id, pick.sym, pick.direction || 'LONG', err.message.substring(0, 500)]
          );
        } catch (_) {}
      }
    }));

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    log(`Multi-user execution done: ${ok} ok, ${fail} failed`);
  } catch (err) {
    log(`Multi-user execution error: ${err.message}`);
  }
}

async function run() {
  log(`Token set: ${!!TELEGRAM_TOKEN} | Chats: ${TELEGRAM_CHATS.join(', ') || 'NONE'}`);
  await main();
}

module.exports = { run, queueSignal };
