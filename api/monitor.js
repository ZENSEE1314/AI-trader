// ============================================================
// Autonomous Crypto Trading Bot — Vercel Serverless Function
// Runs every X minutes via Vercel Cron
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');

const API_KEY    = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  LEVERAGE: 20,
  TP_PCT: 0.04,          // 4% take profit
  SL_PCT: 0.015,         // 1.5% stop loss
  RISK_PCT: 0.92,        // use 92% of available balance
  MIN_BALANCE: 2,        // min USDT to trade
  MIN_VOLUME_M: 50,      // min $50M 24h volume
  MIN_SCORE: 10,         // min score to open trade
  BLACKLIST: [
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT'
  ],
};

// ── TELEGRAM NOTIFY ─────────────────────────────────────────
async function notify(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[NOTIFY]', msg);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.error('Telegram notify failed:', e.message);
  }
}

// ── BINANCE CLIENT ───────────────────────────────────────────
function getClient() {
  return new USDMClient({
    api_key: API_KEY,
    api_secret: API_SECRET,
    baseUrl: 'https://fapi.binance.com',
  });
}

// ── SCAN MARKET: Find best LONG setup ───────────────────────
async function findBestTrade(client) {
  const tickers = await client.get24hrChangeStatistics();
  const usdtPairs = tickers.filter(t =>
    t.symbol.endsWith('USDT') &&
    !CONFIG.BLACKLIST.includes(t.symbol) &&
    parseFloat(t.quoteVolume) > CONFIG.MIN_VOLUME_M * 1e6 &&
    parseFloat(t.priceChangePercent) > 0
  );

  // Sort by volume for top candidates
  const top40 = usdtPairs
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 40);

  const candidates = [];

  for (const t of top40) {
    const sym = t.symbol;
    try {
      // Check symbol active + get max leverage
      const brackets = await client.getLeverageBrackets({ symbol: sym });
      const maxLev = brackets[0]?.brackets[0]?.initialLeverage || 20;

      // 15m candles for momentum
      const klines = await client.getKlines({ symbol: sym, interval: '15m', limit: 12 });
      const closes = klines.map(k => parseFloat(k[4]));
      const opens  = klines.map(k => parseFloat(k[1]));

      // Consecutive green candles
      let streak = 0;
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] > opens[i]) streak++;
        else break;
      }

      const mom1h  = (closes[closes.length-1] - closes[closes.length-5]) / closes[closes.length-5] * 100;
      const mom30m = (closes[closes.length-1] - closes[closes.length-3]) / closes[closes.length-3] * 100;
      const chg24h = parseFloat(t.priceChangePercent);
      const high   = parseFloat(t.highPrice);
      const price  = parseFloat(t.lastPrice);
      const distHigh = (price - high) / high * 100;

      // Funding rate
      const funding = await client.getFundingRate({ symbol: sym, limit: 1 });
      const fundRate = funding.length ? parseFloat(funding[0].fundingRate) * 100 : 0;

      // Score
      let score = 0;
      score += chg24h * 0.2;
      score += mom1h * 3;
      score += streak * 4;
      if (distHigh > -3) score += 8;   // near day high = strength
      if (fundRate < 0)  score += 5;   // longs get paid
      if (fundRate > 0.03) score -= 10; // too expensive to hold long

      candidates.push({
        sym, price, chg24h, mom1h, mom30m, streak,
        distHigh, fundRate, score,
        leverage: Math.min(20, maxLev),
      });
    } catch (_) {
      // symbol unavailable / halted
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// ── OPEN TRADE ───────────────────────────────────────────────
async function openTrade(client, pick, availableUsdt) {
  const { sym, price, leverage } = pick;

  // Set leverage
  await client.setLeverage({ symbol: sym, leverage });

  // Set isolated margin
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch (e) {
    if (!e.message?.includes('No need')) throw e;
  }

  // Get symbol precision
  const info = await client.getExchangeInfo();
  const sinfo = info.symbols.find(s => s.symbol === sym);
  const qtyPrec = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;

  // Calculate qty
  const usdtToUse = availableUsdt * CONFIG.RISK_PCT;
  const notional  = usdtToUse * leverage;
  const qtyRaw    = notional / price;
  const qty       = Math.floor(qtyRaw * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

  // Market order
  const order = await client.submitNewOrder({
    symbol: sym,
    side: 'BUY',
    type: 'MARKET',
    quantity: qty,
  });

  // TP & SL
  const tp = parseFloat((price * (1 + CONFIG.TP_PCT)).toFixed(pricePrec));
  const sl = parseFloat((price * (1 - CONFIG.SL_PCT)).toFixed(pricePrec));

  try {
    await client.submitNewOrder({
      symbol: sym, side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp, closePosition: 'true',
      workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { console.warn('TP warn:', e.message); }

  try {
    await client.submitNewOrder({
      symbol: sym, side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: sl, closePosition: 'true',
      workingType: 'MARK_PRICE', priceProtect: 'TRUE',
    });
  } catch (e) { console.warn('SL warn:', e.message); }

  return { sym, qty, entry: price, leverage, tp, sl, orderId: order.orderId };
}

// ── MAIN HANDLER ─────────────────────────────────────────────
async function run() {
  const client = getClient();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' });

  try {
    // Account state
    const account  = await client.getAccountInformation();
    const wallet    = parseFloat(account.totalWalletBalance);
    const avail     = parseFloat(account.availableBalance);
    const upnl      = parseFloat(account.totalUnrealizedProfit);
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    console.log(`[${now}] Wallet=$${wallet.toFixed(4)} | Available=$${avail.toFixed(4)} | uPnL=$${upnl.toFixed(4)} | Positions=${positions.length}`);

    // ── CASE 1: Has open position → report status ──
    if (positions.length > 0) {
      for (const p of positions) {
        const sym    = p.symbol;
        const amt    = parseFloat(p.positionAmt);
        const entry  = parseFloat(p.entryPrice);
        const pnl    = parseFloat(p.unrealizedProfit);
        const lev    = parseInt(p.leverage);
        const ticker = await client.getSymbolPriceTicker({ symbol: sym });
        const cur    = parseFloat(ticker.price);
        const pct    = ((cur - entry) / entry) * 100 * lev;
        const side   = amt > 0 ? 'LONG' : 'SHORT';

        const msg =
          `📊 *Bot Update — ${now}*\n\n` +
          `Position: *${sym} ${side} x${lev}*\n` +
          `Entry: \`$${entry}\`  →  Now: \`$${cur}\`\n` +
          `PnL: *${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}* (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)\n` +
          `Wallet: $${wallet.toFixed(4)} USDT\n\n` +
          `_Holding... TP/SL active_`;

        await notify(msg);
        console.log(msg);
      }
      return { status: 'holding', positions: positions.length };
    }

    // ── CASE 2: No position → scan & trade ──
    if (avail < CONFIG.MIN_BALANCE) {
      const msg = `⚠️ *Bot — ${now}*\nBalance too low: $${avail.toFixed(4)} USDT. Cannot trade.`;
      await notify(msg);
      return { status: 'low_balance', avail };
    }

    console.log('No open positions. Scanning market...');
    const pick = await findBestTrade(client);

    if (!pick || pick.score < CONFIG.MIN_SCORE) {
      const msg = `🔍 *Bot — ${now}*\nNo strong setup found. Waiting for better entry.\nBest candidate: ${pick?.sym || 'none'} (score: ${pick?.score?.toFixed(1) || 0})`;
      await notify(msg);
      return { status: 'no_setup' };
    }

    // Open the trade
    const result = await openTrade(client, pick, avail);

    const msg =
      `🚀 *NEW TRADE OPENED — ${now}*\n\n` +
      `Coin: *${result.sym}*\n` +
      `Direction: *LONG x${result.leverage}*\n` +
      `Entry: \`$${result.entry}\`\n` +
      `Qty: ${result.qty}\n` +
      `🎯 Take Profit: \`$${result.tp}\` (+4%)\n` +
      `🛑 Stop Loss:   \`$${result.sl}\` (-1.5%)\n\n` +
      `_Signal: 24h=${pick.chg24h.toFixed(2)}% | 1h mom=${pick.mom1h.toFixed(2)}% | streak=${pick.streak} green candles_\n` +
      `Wallet: $${avail.toFixed(4)} USDT`;

    await notify(msg);
    console.log(msg);
    return { status: 'trade_opened', result };

  } catch (err) {
    const msg = `❌ *Bot Error — ${now}*\n\`${err.message}\``;
    await notify(msg);
    console.error(msg);
    return { status: 'error', error: err.message };
  }
}

// ── VERCEL SERVERLESS EXPORT ─────────────────────────────────
module.exports = async (req, res) => {
  const result = await run();
  res.status(200).json(result);
};

// ── LOCAL RUN ────────────────────────────────────────────────
if (require.main === module) {
  run().then(r => console.log('\nResult:', JSON.stringify(r, null, 2)));
}
