// ============================================================
// Crypto Bot — Single Cycle (called by Task Scheduler every 30min)
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');

const API_KEY        = process.env.BINANCE_API_KEY        || '';
const API_SECRET     = process.env.BINANCE_API_SECRET     || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN         || '';
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID       || '';

const CONFIG = {
  LEVERAGE:    20,
  TP_PCT:      0.04,
  SL_PCT:      0.015,
  RISK_PCT:    0.92,
  MIN_BALANCE: 2,
  MIN_VOL_M:   50,
  MIN_SCORE:   10,
  BLACKLIST: [
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT'
  ],
};

function now() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function log(msg) { console.log(`[${now()}] ${msg}`); }

async function notify(msg) {
  log(`>> ${msg.replace(/\*/g,'').replace(/\`/g,'').substring(0,80)}`);
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, parse_mode: 'Markdown' }),
    });
  } catch(e) { log(`Telegram error: ${e.message}`); }
}

function getClient() {
  return new USDMClient({ api_key: API_KEY, api_secret: API_SECRET });
}

async function findBestTrade(client) {
  log('Scanning market...');
  const tickers = await client.get24hrChangeStatistics();

  const candidates = tickers.filter(t =>
    t.symbol.endsWith('USDT') &&
    !CONFIG.BLACKLIST.includes(t.symbol) &&
    parseFloat(t.quoteVolume) > CONFIG.MIN_VOL_M * 1e6 &&
    parseFloat(t.priceChangePercent) > 0
  );

  const top40 = candidates
    .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 40);

  log(`Analyzing ${top40.length} candidates...`);
  const scored = [];

  for (const t of top40) {
    const sym = t.symbol;
    try {
      const brackets = await client.getLeverageBrackets({ symbol: sym });
      if (!brackets?.length) continue;
      const maxLev = brackets[0]?.brackets[0]?.initialLeverage || 20;

      const klines = await client.getKlines({ symbol: sym, interval: '15m', limit: 16 });
      const closes = klines.map(k => parseFloat(k[4]));
      const opens  = klines.map(k => parseFloat(k[1]));
      const vols   = klines.map(k => parseFloat(k[5]));

      let streak = 0;
      for (let i = closes.length-1; i >= 0; i--) {
        if (closes[i] > opens[i]) streak++;
        else break;
      }

      const recentVol = vols.slice(-2).reduce((a,b)=>a+b,0);
      const prevVol   = vols.slice(-4,-2).reduce((a,b)=>a+b,0);
      const volRising = recentVol > prevVol;

      const n = closes.length;
      const mom1h    = (closes[n-1] - closes[n-5]) / closes[n-5] * 100;
      const mom30m   = (closes[n-1] - closes[n-3]) / closes[n-3] * 100;
      const chg24h   = parseFloat(t.priceChangePercent);
      const price    = parseFloat(t.lastPrice);
      const high     = parseFloat(t.highPrice);
      const distHigh = (price - high) / high * 100;

      const funding  = await client.getFundingRate({ symbol: sym, limit: 1 });
      const fundRate = funding.length ? parseFloat(funding[0].fundingRate)*100 : 0;

      let score = 0;
      score += Math.min(chg24h, 20) * 0.3;
      score += mom1h   * 4;
      score += mom30m  * 2;
      score += streak  * 5;
      if (volRising)      score += 6;
      if (distHigh > -2)  score += 8;
      if (distHigh > -0.5) score += 5;
      if (fundRate < 0)   score += 5;
      if (fundRate > 0.03) score -= 12;
      if (chg24h > 50)    score -= 20;

      scored.push({ sym, price, chg24h, mom1h, mom30m, streak,
        distHigh, fundRate, volRising, score,
        leverage: Math.min(CONFIG.LEVERAGE, maxLev) });
    } catch(_) {}
  }

  if (!scored.length) return null;
  scored.sort((a,b) => b.score - a.score);

  log('Top 5:');
  scored.slice(0,5).forEach((s,i) =>
    log(`  ${i+1}. ${s.sym} score=${s.score.toFixed(1)} 24h=${s.chg24h.toFixed(2)}% 1h=${s.mom1h.toFixed(2)}% streak=${s.streak}`)
  );

  return scored[0];
}

async function openTrade(client, pick, availUsdt) {
  const { sym, price, leverage } = pick;
  await client.setLeverage({ symbol: sym, leverage });
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch(e) { if (!e.message?.includes('No need')) throw e; }

  const info    = await client.getExchangeInfo();
  const sinfo   = info.symbols.find(s => s.symbol === sym);
  const qtyPrec = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;

  const qty = Math.floor((availUsdt * CONFIG.RISK_PCT * leverage / price) * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

  const order = await client.submitNewOrder({ symbol: sym, side: 'BUY', type: 'MARKET', quantity: qty });

  const tp = parseFloat((price * (1+CONFIG.TP_PCT)).toFixed(pricePrec));
  const sl = parseFloat((price * (1-CONFIG.SL_PCT)).toFixed(pricePrec));

  try {
    await client.submitNewOrder({ symbol: sym, side: 'SELL', type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE' });
  } catch(e) { log(`TP warn: ${e.message}`); }

  try {
    await client.submitNewOrder({ symbol: sym, side: 'SELL', type: 'STOP_MARKET',
      stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE' });
  } catch(e) { log(`SL warn: ${e.message}`); }

  return { sym, qty, entry: price, leverage, tp, sl, orderId: order.orderId };
}

async function main() {
  log('=== Bot Cycle Start ===');
  const client = getClient();

  try {
    const account   = await client.getAccountInformation();
    const wallet    = parseFloat(account.totalWalletBalance);
    const avail     = parseFloat(account.availableBalance);
    const upnl      = parseFloat(account.totalUnrealizedProfit);
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    log(`Wallet=$${wallet.toFixed(4)} | Avail=$${avail.toFixed(4)} | uPnL=$${upnl.toFixed(4)} | Positions=${positions.length}`);

    // ── HAS OPEN POSITION ──────────────────────────────────
    if (positions.length > 0) {
      for (const p of positions) {
        const sym   = p.symbol;
        const amt   = parseFloat(p.positionAmt);
        const entry = parseFloat(p.entryPrice);
        const pnl   = parseFloat(p.unrealizedProfit);
        const lev   = parseInt(p.leverage);
        const side  = amt > 0 ? 'LONG' : 'SHORT';
        const ticker = await client.getSymbolPriceTicker({ symbol: sym });
        const cur   = parseFloat(ticker.price);
        const pct   = ((cur - entry) / entry) * 100 * lev;
        const tp    = parseFloat((entry*(1+CONFIG.TP_PCT)).toFixed(6));
        const sl    = parseFloat((entry*(1-CONFIG.SL_PCT)).toFixed(6));

        await notify(
          `📊 *Bot Update — ${now()}*\n\n` +
          `*${sym} ${side} x${lev}*\n` +
          `Entry: \`$${entry}\` → Now: \`$${cur}\`\n` +
          `PnL: ${pnl>=0?'🟢':'🔴'} *${pnl>=0?'+':''}$${pnl.toFixed(4)}* (${pct>=0?'+':''}${pct.toFixed(2)}%)\n` +
          `🎯 TP: \`$${tp}\` | 🛑 SL: \`$${sl}\`\n` +
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

    const pick = await findBestTrade(client);

    if (!pick || pick.score < CONFIG.MIN_SCORE) {
      log(`No strong setup found. Best: ${pick?.sym} score=${pick?.score?.toFixed(1)}`);
      await notify(
        `🔍 *Bot — ${now()}*\n` +
        `No strong setup found. Waiting for better entry.\n` +
        `Best candidate: *${pick?.sym||'none'}* (score: ${pick?.score?.toFixed(1)||'0'})\n` +
        `💰 Wallet: *$${wallet.toFixed(4)} USDT*`
      );
      return;
    }

    const result = await openTrade(client, pick, avail);

    await notify(
      `🚀 *NEW TRADE — ${now()}*\n\n` +
      `Coin: *${result.sym}*\n` +
      `Direction: *LONG x${result.leverage}*\n` +
      `Entry: \`$${result.entry}\`\n` +
      `Qty: \`${result.qty}\`\n` +
      `🎯 TP: \`$${result.tp}\` (+4%)\n` +
      `🛑 SL: \`$${result.sl}\` (-1.5%)\n\n` +
      `Signal: 24h=*${pick.chg24h.toFixed(2)}%* | 1h=*${pick.mom1h.toFixed(2)}%* | streak=*${pick.streak}* green candles\n` +
      `💰 Wallet: *$${avail.toFixed(4)} USDT*`
    );

  } catch(err) {
    log(`ERROR: ${err.message}`);
    await notify(`❌ *Bot Error — ${now()}*\n\`${err.message}\``);
  }

  log('=== Cycle End ===');
}

main();
