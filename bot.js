// ============================================================
// Autonomous Crypto Trading Bot — Render.com (24/7 persistent)
// Scans market every 30 min, auto buys/sells on Binance Futures
// Sends Telegram alerts for every action
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');

// ── ENV VARS ─────────────────────────────────────────────────
const API_KEY        = process.env.BINANCE_API_KEY;
const API_SECRET     = process.env.BINANCE_API_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const INTERVAL_MIN   = parseInt(process.env.INTERVAL_MIN || '30');

// Startup check
console.log(`[BOOT] API_KEY set: ${!!API_KEY} | TELEGRAM set: ${!!TELEGRAM_TOKEN} | CHAT_ID: ${TELEGRAM_CHAT} | Interval: ${INTERVAL_MIN}min`);

// ── STRATEGY CONFIG ──────────────────────────────────────────
const CONFIG = {
  LEVERAGE:     20,
  TP_PCT:       0.04,    // 4% take profit
  SL_PCT:       0.015,   // 1.5% stop loss
  RISK_PCT:     0.92,    // use 92% of available balance per trade
  MIN_BALANCE:  2,       // minimum USDT to open a trade
  MIN_VOL_M:    50,      // minimum 24h volume in millions
  MIN_SCORE:    10,      // minimum signal score to trade
  MAX_POSITIONS: 1,      // max open positions at once
  BLACKLIST: [
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT','NEIROETHUSDT',
    'COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT'
  ],
};

// ── HELPERS ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function now() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

// ── TELEGRAM ─────────────────────────────────────────────────
async function notify(msg, emoji = '') {
  const full = emoji ? `${emoji} ${msg}` : msg;
  log(`NOTIFY: ${full}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text: full,
        parse_mode: 'Markdown',
      }),
    });
  } catch (e) {
    log(`Telegram error: ${e.message}`);
  }
}

// ── BINANCE CLIENT ───────────────────────────────────────────
function getClient() {
  return new USDMClient({
    api_key: API_KEY,
    api_secret: API_SECRET,
    // Use global endpoint — Render is not geo-blocked
  });
}

// ── MARKET SCANNER ───────────────────────────────────────────
async function findBestTrade(client) {
  log('Scanning market...');
  const tickers = await client.get24hrChangeStatistics();

  // Filter: USDT pairs, not blacklisted, positive, enough volume
  const candidates = tickers.filter(t =>
    t.symbol.endsWith('USDT') &&
    !CONFIG.BLACKLIST.includes(t.symbol) &&
    parseFloat(t.quoteVolume) > CONFIG.MIN_VOL_M * 1e6 &&
    parseFloat(t.priceChangePercent) > 0
  );

  // Sort by volume, take top 40
  const top40 = candidates
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 40);

  log(`Analyzing ${top40.length} candidates...`);

  const scored = [];

  for (const t of top40) {
    const sym = t.symbol;
    try {
      // Check symbol is tradeable
      const brackets = await client.getLeverageBrackets({ symbol: sym });
      if (!brackets?.length) continue;
      const maxLev = brackets[0]?.brackets[0]?.initialLeverage || 20;

      // 15m candles — momentum
      const klines = await client.getKlines({ symbol: sym, interval: '15m', limit: 16 });
      const closes = klines.map(k => parseFloat(k[4]));
      const opens  = klines.map(k => parseFloat(k[1]));
      const vols   = klines.map(k => parseFloat(k[5]));

      // Consecutive green candles from latest
      let streak = 0;
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] > opens[i]) streak++;
        else break;
      }

      // Volume increasing? (last 2 candles vs prev 2)
      const recentVol = vols.slice(-2).reduce((a,b) => a+b, 0);
      const prevVol   = vols.slice(-4,-2).reduce((a,b) => a+b, 0);
      const volRising = recentVol > prevVol;

      const n = closes.length;
      const mom1h  = (closes[n-1] - closes[n-5]) / closes[n-5] * 100;
      const mom30m = (closes[n-1] - closes[n-3]) / closes[n-3] * 100;
      const chg24h = parseFloat(t.priceChangePercent);
      const price  = parseFloat(t.lastPrice);
      const high   = parseFloat(t.highPrice);
      const low    = parseFloat(t.lowPrice);
      const distHigh = (price - high) / high * 100;  // 0% = at day high

      // Funding rate
      const funding = await client.getFundingRate({ symbol: sym, limit: 1 });
      const fundRate = funding.length ? parseFloat(funding[0].fundingRate) * 100 : 0;

      // ── SCORING ──────────────────────────────────────────
      let score = 0;
      score += Math.min(chg24h, 20) * 0.3;   // 24h change (cap at 20% to avoid pumps)
      score += mom1h  * 4;                    // 1h momentum is key
      score += mom30m * 2;                    // 30m momentum
      score += streak * 5;                    // green candle streak
      if (volRising)    score += 6;           // volume confirming move
      if (distHigh > -2) score += 8;          // within 2% of day high = strong
      if (distHigh > -0.5) score += 5;        // at day high = very strong
      if (fundRate < 0)  score += 5;          // longs get paid = bullish
      if (fundRate > 0.03) score -= 12;       // expensive to hold long
      if (chg24h > 50)  score -= 20;          // extreme pump = avoid

      scored.push({
        sym, price, chg24h, mom1h, mom30m, streak,
        distHigh, fundRate, volRising, score,
        leverage: Math.min(CONFIG.LEVERAGE, maxLev),
        high, low,
      });
    } catch (e) {
      // Symbol halted or unavailable — skip silently
    }
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  log(`Top 5 picks:`);
  scored.slice(0, 5).forEach((s, i) => {
    log(`  ${i+1}. ${s.sym} | score=${s.score.toFixed(1)} | 24h=${s.chg24h.toFixed(2)}% | 1h=${s.mom1h.toFixed(2)}% | streak=${s.streak} | funding=${s.fundRate.toFixed(4)}%`);
  });

  return scored[0];
}

// ── OPEN TRADE ───────────────────────────────────────────────
async function openTrade(client, pick, availUsdt) {
  const { sym, price, leverage } = pick;
  log(`Opening LONG on ${sym} | x${leverage} | available=$${availUsdt.toFixed(4)}`);

  // Set leverage
  await client.setLeverage({ symbol: sym, leverage });

  // Set isolated margin
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch (e) {
    if (!e.message?.includes('No need')) throw e;
  }

  // Get precision info
  const info  = await client.getExchangeInfo();
  const sinfo = info.symbols.find(s => s.symbol === sym);
  const qtyPrec   = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;

  // Qty calculation
  const usdtToUse = availUsdt * CONFIG.RISK_PCT;
  const notional  = usdtToUse * leverage;
  const qtyRaw    = notional / price;
  const qty       = Math.floor(qtyRaw * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

  // Market BUY
  const order = await client.submitNewOrder({
    symbol: sym,
    side:   'BUY',
    type:   'MARKET',
    quantity: qty,
  });

  // Set TP & SL
  const tp = parseFloat((price * (1 + CONFIG.TP_PCT)).toFixed(pricePrec));
  const sl = parseFloat((price * (1 - CONFIG.SL_PCT)).toFixed(pricePrec));

  try {
    await client.submitNewOrder({
      symbol: sym, side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp, closePosition: 'true',
      workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
    log(`TP set at $${tp}`);
  } catch (e) { log(`TP warn: ${e.message}`); }

  try {
    await client.submitNewOrder({
      symbol: sym, side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: sl, closePosition: 'true',
      workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
    log(`SL set at $${sl}`);
  } catch (e) { log(`SL warn: ${e.message}`); }

  return { sym, qty, entry: price, leverage, tp, sl, orderId: order.orderId };
}

// ── MAIN LOOP CYCLE ──────────────────────────────────────────
async function cycle() {
  log('── Cycle start ──────────────────────────────');
  const client = getClient();

  try {
    const account   = await client.getAccountInformation();
    const wallet    = parseFloat(account.totalWalletBalance);
    const avail     = parseFloat(account.availableBalance);
    const upnl      = parseFloat(account.totalUnrealizedProfit);
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    log(`Wallet=$${wallet.toFixed(4)} | Available=$${avail.toFixed(4)} | uPnL=$${upnl.toFixed(4)} | Positions=${positions.length}`);

    // ── HAS OPEN POSITION ─────────────────────────────────
    if (positions.length >= CONFIG.MAX_POSITIONS) {
      for (const p of positions) {
        const sym   = p.symbol;
        const amt   = parseFloat(p.positionAmt);
        const entry = parseFloat(p.entryPrice);
        const pnl   = parseFloat(p.unrealizedProfit);
        const lev   = parseInt(p.leverage);
        const side  = amt > 0 ? 'LONG' : 'SHORT';

        const ticker = await client.getSymbolPriceTicker({ symbol: sym });
        const cur    = parseFloat(ticker.price);
        const pct    = ((cur - entry) / entry) * 100 * lev;
        const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';

        await notify(
          `*Bot Update — ${now()}*\n\n` +
          `Position: *${sym} ${side} x${lev}*\n` +
          `Entry: \`$${entry}\`  →  Now: \`$${cur}\`\n` +
          `PnL: ${pnlEmoji} *${pnl >= 0?'+':''}$${pnl.toFixed(4)}* (${pct>=0?'+':''}${pct.toFixed(2)}%)\n` +
          `TP: \`$${parseFloat((entry*(1+CONFIG.TP_PCT)).toFixed(6))}\` | SL: \`$${parseFloat((entry*(1-CONFIG.SL_PCT)).toFixed(6))}\`\n` +
          `Wallet: *$${wallet.toFixed(4)} USDT*\n` +
          `_Holding... TP/SL active_`
        );
      }
      return;
    }

    // ── NO POSITION → SCAN & TRADE ────────────────────────
    if (avail < CONFIG.MIN_BALANCE) {
      log(`Balance too low: $${avail.toFixed(4)}`);
      await notify(`*Bot — ${now()}*\n⚠️ Balance too low: \`$${avail.toFixed(4)}\` USDT\nCannot open trade.`);
      return;
    }

    const pick = await findBestTrade(client);

    if (!pick || pick.score < CONFIG.MIN_SCORE) {
      log(`No strong setup. Best: ${pick?.sym} score=${pick?.score?.toFixed(1)}`);
      await notify(
        `*Bot — ${now()}*\n` +
        `🔍 No strong setup found. Waiting...\n` +
        `Best candidate: *${pick?.sym || 'none'}* (score: ${pick?.score?.toFixed(1) || '0'})\n` +
        `Wallet: *$${wallet.toFixed(4)} USDT*`
      );
      return;
    }

    // Open trade
    const result = await openTrade(client, pick, avail);

    await notify(
      `*🚀 NEW TRADE — ${now()}*\n\n` +
      `Coin: *${result.sym}*\n` +
      `Direction: *LONG x${result.leverage}*\n` +
      `Entry: \`$${result.entry}\`\n` +
      `Qty: \`${result.qty}\`\n` +
      `🎯 TP: \`$${result.tp}\` (+4%)\n` +
      `🛑 SL: \`$${result.sl}\` (-1.5%)\n\n` +
      `Signal: 24h=*${pick.chg24h.toFixed(2)}%* | 1h=*${pick.mom1h.toFixed(2)}%* | streak=*${pick.streak}* candles\n` +
      `Wallet: *$${avail.toFixed(4)} USDT*`
    );

  } catch (err) {
    log(`ERROR: ${err.message}`);
    await notify(`*❌ Bot Error — ${now()}*\n\`${err.message}\``);
  }

  log('── Cycle end ────────────────────────────────\n');
}

// ── START ────────────────────────────────────────────────────
async function start() {
  log(`====================================`);
  log(`  Crypto Bot Starting`);
  log(`  Interval: every ${INTERVAL_MIN} minutes`);
  log(`  Leverage: ${CONFIG.LEVERAGE}x | TP: +${CONFIG.TP_PCT*100}% | SL: -${CONFIG.SL_PCT*100}%`);
  log(`====================================`);

  await notify(
    `*🤖 Crypto Bot Online — ${now()}*\n\n` +
    `Strategy: LONG x${CONFIG.LEVERAGE} | TP +${CONFIG.TP_PCT*100}% | SL -${CONFIG.SL_PCT*100}%\n` +
    `Scanning every *${INTERVAL_MIN} minutes*\n` +
    `Bot is running 24/7 on Render ✅`
  );

  // Run immediately on start
  await cycle();

  // Then repeat every INTERVAL_MIN minutes
  setInterval(cycle, INTERVAL_MIN * 60 * 1000);
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
