// ============================================================
// Autonomous Crypto Trading Bot — Render.com (24/7 persistent)
// Telegram commands: /status /close /pause /resume /next /bal
// All USDT pairs, 5m timeframe, RSI enabled
// ============================================================

const { USDMClient } = require('binance');
const fetch = require('node-fetch');

const API_KEY        = process.env.BINANCE_API_KEY;
const API_SECRET     = process.env.BINANCE_API_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const INTERVAL_MIN   = parseInt(process.env.INTERVAL_MIN || '10');

console.log(`[BOOT] API_KEY set: ${!!API_KEY} | TELEGRAM set: ${!!TELEGRAM_TOKEN} | CHAT_ID: ${TELEGRAM_CHAT} | Interval: ${INTERVAL_MIN}min`);

const CONFIG = {
  LEVERAGE:      20,
  TP_PCT:        0.04,
  SL_PCT:        0.015,
  RISK_PCT:      0.92,
  MIN_BALANCE:   2,
  MIN_VOL_M:     10,        // Lowered to catch more coins
  MIN_SCORE:     15,        // Slightly higher with RSI
  MAX_POSITIONS: 1,
  RSI_PERIOD:    14,
  RSI_BUY_MAX:   45,        // Buy when RSI < 45 (oversold/near oversold)
  CANDLE_INTERVAL: '5m',    // 5-minute candles (closest to 10min request)
  SCAN_LIMIT:    150,       // Scan top 150 by volume (more coins)
  BLACKLIST: [
    'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT',
    'LYNUSDT','PORT3USDT','RVVUSDT','BSWUSDT',
    'NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT','EPTUSDT'
  ],
};

// ── STATE ────────────────────────────────────────────────────
let paused = false;
let lastUpdateId = 0;

// ── HELPERS ──────────────────────────────────────────────────
function now() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}
function log(msg) { console.log(`[${now()}] ${msg}`); }

// Calculate RSI
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  
  let gains = 0, losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ── GET PUBLIC IP ────────────────────────────────────────────
async function getPublicIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const data = await res.json();
    return data.ip;
  } catch(_) { return 'unknown'; }
}

// ── TELEGRAM SEND ────────────────────────────────────────────
async function notify(msg) {
  log(`NOTIFY: ${msg.replace(/\*/g,'').replace(/`/g,'').substring(0,100)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text: msg,
        parse_mode: 'Markdown',
      }),
    });
  } catch(e) { log(`Telegram error: ${e.message}`); }
}

// ── TELEGRAM POLL COMMANDS ───────────────────────────────────
async function pollCommands(client) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`);
    const data = await res.json();
    const updates = data.result || [];

    for (const u of updates) {
      lastUpdateId = u.update_id;
      const msg  = u.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(TELEGRAM_CHAT)) continue;

      const cmd = msg.text.trim().toLowerCase();
      log(`Command received: ${cmd}`);

      if (cmd === '/status' || cmd === 'status') {
        await sendStatus(client);

      } else if (cmd === '/bal' || cmd === 'bal') {
        const account = await client.getAccountInformation();
        const wallet  = parseFloat(account.totalWalletBalance);
        const avail   = parseFloat(account.availableBalance);
        const upnl    = parseFloat(account.totalUnrealizedProfit);
        await notify(
          `💰 *Balance — ${now()}*\n\n` +
          `Wallet: *$${wallet.toFixed(4)} USDT*\n` +
          `Available: *$${avail.toFixed(4)} USDT*\n` +
          `Unrealized PnL: *${upnl>=0?'+':''}$${upnl.toFixed(4)} USDT*`
        );

      } else if (cmd === '/close' || cmd === 'close') {
        await closeAllPositions(client);

      } else if (cmd === '/pause' || cmd === 'pause') {
        paused = true;
        await notify(`⏸ *Bot Paused*\nNo new trades will be opened.\nSend /resume to restart.`);

      } else if (cmd === '/resume' || cmd === 'resume') {
        paused = false;
        await notify(`▶️ *Bot Resumed*\nBot is active again. Next scan in ${INTERVAL_MIN} minutes.`);

      } else if (cmd === '/next' || cmd === 'next') {
        await notify(`🔍 *Scanning for best trade now...*`);
        await cycle(client, true);

      } else if (cmd === '/help' || cmd === 'help') {
        await notify(
          `🤖 *Bot Commands*\n\n` +
          `/status — Show current position & PnL\n` +
          `/bal — Show wallet balance\n` +
          `/close — Close all open positions\n` +
          `/pause — Pause auto trading\n` +
          `/resume — Resume auto trading\n` +
          `/next — Force scan & trade now\n` +
          `/help — Show this menu`
        );

      } else {
        await notify(`❓ Unknown command: \`${cmd}\`\nSend /help for commands.`);
      }
    }
  } catch(e) {
    log(`Poll error: ${e.message}`);
  }
}

// ── CLOSE ALL POSITIONS ──────────────────────────────────────
async function closeAllPositions(client) {
  const account   = await client.getAccountInformation();
  const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

  if (!positions.length) {
    await notify(`ℹ️ No open positions to close.`);
    return;
  }

  for (const p of positions) {
    const sym = p.symbol;
    const amt = parseFloat(p.positionAmt);
    const side = amt > 0 ? 'SELL' : 'BUY';
    const qty  = Math.abs(amt);

    try { await client.cancelAllOpenOrders({ symbol: sym }); } catch(_) {}

    await client.submitNewOrder({ symbol: sym, side, type: 'MARKET', quantity: qty, reduceOnly: 'true' });
    log(`Closed ${sym} ${qty}`);
    await notify(`✅ *Position Closed*\n${sym} | qty=${qty}\nClosed at market price.`);
  }
}

// ── STATUS ───────────────────────────────────────────────────
async function sendStatus(client) {
  const account   = await client.getAccountInformation();
  const wallet    = parseFloat(account.totalWalletBalance);
  const avail     = parseFloat(account.availableBalance);
  const upnl      = parseFloat(account.totalUnrealizedProfit);
  const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

  if (!positions.length) {
    await notify(
      `📊 *Status — ${now()}*\n\n` +
      `No open positions.\n` +
      `💰 Wallet: *$${wallet.toFixed(4)} USDT*\n` +
      `Available: *$${avail.toFixed(4)} USDT*\n` +
      `Bot: ${paused ? '⏸ Paused' : '▶️ Active'}`
    );
    return;
  }

  for (const p of positions) {
    const sym    = p.symbol;
    const amt    = parseFloat(p.positionAmt);
    const entry  = parseFloat(p.entryPrice);
    const pnl    = parseFloat(p.unrealizedProfit);
    const lev    = parseInt(p.leverage);
    const side   = amt > 0 ? 'LONG' : 'SHORT';
    const ticker = await client.getSymbolPriceTicker({ symbol: sym });
    const cur    = parseFloat(ticker.price);
    const pct    = ((cur - entry) / entry) * 100 * lev;
    const tp     = parseFloat((entry*(1+CONFIG.TP_PCT)).toFixed(6));
    const sl     = parseFloat((entry*(1-CONFIG.SL_PCT)).toFixed(6));

    await notify(
      `📊 *Status — ${now()}*\n\n` +
      `*${sym} ${side} x${lev}*\n` +
      `Entry: \`$${entry}\` → Now: \`$${cur}\`\n` +
      `PnL: ${pnl>=0?'🟢':'🔴'} *${pnl>=0?'+':''}$${pnl.toFixed(4)}* (${pct>=0?'+':''}${pct.toFixed(2)}%)\n` +
      `🎯 TP: \`$${tp}\` | 🛑 SL: \`$${sl}\`\n` +
      `💰 Wallet: *$${wallet.toFixed(4)} USDT*\n` +
      `Bot: ${paused ? '⏸ Paused' : '▶️ Active'}`
    );
  }
}

// ── MARKET SCANNER ───────────────────────────────────────────
async function findBestTrade(client) {
  log('Scanning market...');
  const tickers = await client.get24hrChangeStatistics();

  // Get all USDT pairs with volume > MIN_VOL_M, sorted by volume
  const candidates = tickers
    .filter(t =>
      t.symbol.endsWith('USDT') &&
      !CONFIG.BLACKLIST.includes(t.symbol) &&
      parseFloat(t.quoteVolume) > CONFIG.MIN_VOL_M * 1e6 &&
      parseFloat(t.priceChangePercent) > -5  // Allow small dips too
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, CONFIG.SCAN_LIMIT);

  log(`Analyzing ${candidates.length} candidates...`);
  const scored = [];

  for (const t of candidates) {
    const sym = t.symbol;
    try {
      const brackets = await client.getLeverageBrackets({ symbol: sym });
      if (!brackets?.length) continue;
      const maxLev = brackets[0]?.brackets[0]?.initialLeverage || 20;

      // Use 5m candles for faster signals
      const klines = await client.getKlines({ 
        symbol: sym, 
        interval: CONFIG.CANDLE_INTERVAL, 
        limit: 20 
      });
      
      const closes = klines.map(k => parseFloat(k[4]));
      const opens  = klines.map(k => parseFloat(k[1]));
      const highs  = klines.map(k => parseFloat(k[2]));
      const lows   = klines.map(k => parseFloat(k[3]));
      const vols   = klines.map(k => parseFloat(k[5]));

      // Calculate RSI
      const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);

      // Green candle streak
      let streak = 0;
      for (let i = closes.length-1; i >= 0; i--) {
        if (closes[i] > opens[i]) streak++;
        else break;
      }

      // Volume trend
      const recentVol = vols.slice(-3).reduce((a,b)=>a+b,0) / 3;
      const prevVol   = vols.slice(-6,-3).reduce((a,b)=>a+b,0) / 3;
      const volRising = recentVol > prevVol * 1.1;

      // Price action
      const n         = closes.length;
      const mom1h     = (closes[n-1] - closes[n-12]) / closes[n-12] * 100;  // ~1h momentum
      const mom30m    = (closes[n-1] - closes[n-6]) / closes[n-6] * 100;    // ~30m momentum
      const chg24h    = parseFloat(t.priceChangePercent);
      const price     = parseFloat(t.lastPrice);
      const high24    = parseFloat(t.highPrice);
      const distHigh  = (price - high24) / high24 * 100;

      // Funding rate
      const funding   = await client.getFundingRate({ symbol: sym, limit: 1 });
      const fundRate  = funding.length ? parseFloat(funding[0].fundingRate)*100 : 0;

      // SCORING SYSTEM
      let score = 0;
      
      // RSI scoring (buy when oversold/near oversold)
      if (rsi < 30) score += 25;           // Deep oversold - strong buy
      else if (rsi < 40) score += 15;      // Oversold - good buy
      else if (rsi < CONFIG.RSI_BUY_MAX) score += 8;  // Near oversold
      else if (rsi > 70) score -= 20;      // Overbought - avoid
      
      score += Math.min(chg24h, 20) * 0.4;
      score += mom1h * 3;
      score += mom30m * 2;
      score += streak * 4;
      if (volRising)       score += 8;
      if (distHigh > -2)   score += 6;
      if (distHigh > -0.5) score += 4;
      if (fundRate < 0)    score += 4;
      if (fundRate > 0.05) score -= 10;
      if (chg24h > 50)     score -= 15;

      // Skip if RSI too high (already pumped)
      if (rsi > CONFIG.RSI_BUY_MAX + 10) {
        score -= 30;
      }

      scored.push({ 
        sym, price, chg24h, mom1h, mom30m, streak,
        distHigh, fundRate, volRising, score, rsi,
        leverage: Math.min(CONFIG.LEVERAGE, maxLev) 
      });
    } catch(_) {}
  }

  if (!scored.length) return null;
  scored.sort((a,b) => b.score - a.score);

  log('Top 10:');
  scored.slice(0,10).forEach((s,i) =>
    log(`  ${i+1}. ${s.sym} score=${s.score.toFixed(1)} RSI=${s.rsi.toFixed(1)} 24h=${s.chg24h.toFixed(2)}%`)
  );
  
  // Return best if score >= MIN_SCORE
  if (scored[0].score >= CONFIG.MIN_SCORE) {
    return scored[0];
  }
  
  // Return null but log the best
  log(`Best candidate ${scored[0].sym} score=${scored[0].score.toFixed(1)} (below threshold ${CONFIG.MIN_SCORE})`);
  return null;
}

// ── OPEN TRADE ───────────────────────────────────────────────
async function openTrade(client, pick, availUsdt) {
  const { sym, price, leverage } = pick;
  await client.setLeverage({ symbol: sym, leverage });
  try {
    await client.setMarginType({ symbol: sym, marginType: 'ISOLATED' });
  } catch(e) { if (!e.message?.includes('No need')) throw e; }

  const info      = await client.getExchangeInfo();
  const sinfo     = info.symbols.find(s => s.symbol === sym);
  const qtyPrec   = sinfo.quantityPrecision;
  const pricePrec = sinfo.pricePrecision;
  const qty       = Math.floor((availUsdt * CONFIG.RISK_PCT * leverage / price) * Math.pow(10, qtyPrec)) / Math.pow(10, qtyPrec);

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

// ── MAIN CYCLE ───────────────────────────────────────────────
async function cycle(client, forced = false) {
  log(`── Cycle start${forced?' (forced)':''} ──`);

  try {
    const account   = await client.getAccountInformation();
    const wallet    = parseFloat(account.totalWalletBalance);
    const avail     = parseFloat(account.availableBalance);
    const upnl      = parseFloat(account.totalUnrealizedProfit);
    const positions = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);

    log(`Wallet=$${wallet.toFixed(4)} | Avail=$${avail.toFixed(4)} | uPnL=$${upnl.toFixed(4)} | Pos=${positions.length} | Paused=${paused}`);

    if (positions.length >= CONFIG.MAX_POSITIONS) {
      for (const p of positions) {
        const sym    = p.symbol;
        const amt    = parseFloat(p.positionAmt);
        const entry  = parseFloat(p.entryPrice);
        const pnl    = parseFloat(p.unrealizedProfit);
        const lev    = parseInt(p.leverage);
        const side   = amt > 0 ? 'LONG' : 'SHORT';
        const ticker = await client.getSymbolPriceTicker({ symbol: sym });
        const cur    = parseFloat(ticker.price);
        const pct    = ((cur - entry) / entry) * 100 * lev;
        const tp     = parseFloat((entry*(1+CONFIG.TP_PCT)).toFixed(6));
        const sl     = parseFloat((entry*(1-CONFIG.SL_PCT)).toFixed(6));

        await notify(
          `📊 *Bot Update — ${now()}*\n\n` +
          `*${sym} ${side} x${lev}*\n` +
          `Entry: \`$${entry}\` → Now: \`$${cur}\`\n` +
          `PnL: ${pnl>=0?'🟢':'🔴'} *${pnl>=0?'+':''}$${pnl.toFixed(4)}* (${pct>=0?'+':''}${pct.toFixed(2)}%)\n` +
          `🎯 TP: \`$${tp}\` | 🛑 SL: \`$${sl}\`\n` +
          `💰 Wallet: *$${wallet.toFixed(4)} USDT*\n\n` +
          `_Commands: /status /close /pause /help_`
        );
      }
      return;
    }

    if (paused && !forced) {
      log('Bot paused, skipping trade scan.');
      return;
    }

    if (avail < CONFIG.MIN_BALANCE) {
      await notify(`⚠️ *Bot — ${now()}*\nBalance too low: \`$${avail.toFixed(4)}\` USDT`);
      return;
    }

    const pick = await findBestTrade(client);

    if (!pick) {
      await notify(
        `🔍 *Bot — ${now()}*\n` +
        `No strong setup found. Waiting...\n` +
        `Scanned ${CONFIG.SCAN_LIMIT}+ coins, none met criteria\n` +
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
      `Signal: RSI=*${pick.rsi.toFixed(1)}* | 24h=*${pick.chg24h.toFixed(2)}%* | 1h=*${pick.mom1h.toFixed(2)}%*\n` +
      `💰 Wallet: *$${avail.toFixed(4)} USDT*\n\n` +
      `_Commands: /status /close /pause /help_`
    );

  } catch(err) {
    log(`ERROR: ${err.message}`);
    if (err.message?.includes('IP') || err.message?.includes('api-key') || err.message?.includes('Invalid API')) {
      const ip = await getPublicIP();
      await notify(
        `🚨 *Bot IP Blocked — ${now()}*\n\n` +
        `New server IP: \`${ip}\`\n\n` +
        `Add to Binance API whitelist:\n` +
        `Binance → API Management → Edit → Add IP: \`${ip}\`\n\n` +
        `_Bot resumes automatically after you save_`
      );
    } else {
      await notify(`❌ *Bot Error — ${now()}*\n\`${err.message}\``);
    }
  }
  log('── Cycle end ──\n');
}

// ── START ────────────────────────────────────────────────────
async function start() {
  const ip = await getPublicIP();
  log(`====================================`);
  log(`  CryptoBot Starting`);
  log(`  Interval: ${INTERVAL_MIN} min | Timeframe: ${CONFIG.CANDLE_INTERVAL}`);
  log(`  Leverage: ${CONFIG.LEVERAGE}x | RSI Buy < ${CONFIG.RSI_BUY_MAX}`);
  log(`  TP: +${CONFIG.TP_PCT*100}% | SL: -${CONFIG.SL_PCT*100}%`);
  log(`  Scanning: ${CONFIG.SCAN_LIMIT} coins | Min Vol: $${CONFIG.MIN_VOL_M}M`);
  log(`  Server IP: ${ip}`);
  log(`====================================`);

  const client = getClient();

  await notify(
    `🤖 *CryptoBot Online — ${now()}*\n\n` +
    `Strategy: LONG x${CONFIG.LEVERAGE} | TP +${CONFIG.TP_PCT*100}% | SL -${CONFIG.SL_PCT*100}%\n` +
    `Timeframe: *${CONFIG.CANDLE_INTERVAL}* | RSI Buy < *${CONFIG.RSI_BUY_MAX}*\n` +
    `Scanning *${CONFIG.SCAN_LIMIT}+* coins every *${INTERVAL_MIN} min*\n` +
    `🌐 Server IP: \`${ip}\`\n\n` +
    `*Commands:*\n` +
    `/status — position & PnL\n` +
    `/bal — wallet balance\n` +
    `/close — close position\n` +
    `/pause — pause trading\n` +
    `/resume — resume trading\n` +
    `/next — trade now\n` +
    `/help — all commands\n\n` +
    `Running 24/7 on Render ✅`
  );

  await cycle(client);

  // Poll commands every 5 seconds
  setInterval(() => pollCommands(client), 5000);

  // Trade cycle every INTERVAL_MIN
  setInterval(() => cycle(client), INTERVAL_MIN * 60 * 1000);
}

function getClient() {
  return new USDMClient({ api_key: API_KEY, api_secret: API_SECRET });
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
