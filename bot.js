// ==========================================================
// Crypto Signal Scanner — Render.com (24/7)
// Binance Futures public API — zero credentials needed
// Signals: Strong Buy / Buy / Neutral / Sell / Strong Sell
// ⚡ 5-min spike alert: ±5% in 5 min
// Bitunix trade link per coin (HTML mode for clickable links)
// Telegram: /scan /pause /resume /help
// ==========================================================

const fetch = require('node-fetch');
const { run: runTrader } = require('./cycle');

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHATS  = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const TRADE_INTERVAL_MIN = parseInt(process.env.TRADE_INTERVAL_MIN || '30');
const INTERVAL_MIN    = parseInt(process.env.INTERVAL_MIN || '30');
const TOP_COINS       = 40;
const REQUEST_TIMEOUT = 30000;

console.log(`[BOOT] Telegram:${!!TELEGRAM_TOKEN} Chats:${TELEGRAM_CHATS.join(',')||'NONE'} Interval:${INTERVAL_MIN}min`);

let paused       = false;
let lastUpdateId = 0;
let banUntil     = 0; // epoch ms — no API calls until this time

const spikeCooldown   = new Map();
const SPIKE_COOLDOWN  = 5 * 60 * 1000;  // 5 min cooldown per coin
const SPIKE_PCT       = 3;              // alert threshold: ±3% in 1 min
const SPIKE_INTERVAL  = 2 * 60 * 1000; // check every 2 min (was 1 min — too many calls)

// ── HELPERS ──────────────────────────────────────────────────
function now() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function log(msg) { console.log(`[${now()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtPrice(p) {
  if (!p || isNaN(p)) return 'N/A';
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  return p.toFixed(8);
}

// Escape HTML special chars so prices/symbols don't break formatting
function e(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Bitunix futures trade link
function tradeLink(symbol) {
  return `https://www.bitunix.com/futures-trade/${symbol}`;
}

// ── TECHNICAL INDICATORS ─────────────────────────────────────
function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ── BAN DETECTION ─────────────────────────────────────────────
function parseBanUntil(text) {
  const m = String(text).match(/banned until (\d+)/);
  return m ? parseInt(m[1]) : 0;
}

function isBanned() {
  if (banUntil <= Date.now()) return false;
  const mins = Math.ceil((banUntil - Date.now()) / 60000);
  log(`IP still banned for ${mins} more min — skipping API call`);
  return true;
}

// ── BINANCE PUBLIC API ────────────────────────────────────────
async function fetchWithRetry(url, opts = {}, retries = 3) {
  if (isBanned()) return null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT, ...opts });
      // 418 = IP banned, 429 = rate limited
      if (res.status === 418 || res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const until = parseBanUntil(body.msg || '');
        if (until > Date.now()) {
          banUntil = until;
          const mins = Math.ceil((until - Date.now()) / 60000);
          log(`BANNED until ${new Date(until).toLocaleString()} (${mins} min)`);
          await tgSendPrivate(`🚫 <b>Binance IP Banned</b>\nBot paused for <b>${mins} min</b>.\nResumes automatically at ${new Date(until).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' })}`);
        }
        return null;
      }
      if (res.ok) return res;
      return res;
    } catch (err) {
      const isTimeout = err.message && (
        err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET') ||
        err.message.includes('ECONNREFUSED') || err.message.includes('network timeout')
      );
      if (isTimeout && i < retries - 1) {
        log(`Retry ${i + 1}/${retries - 1} for ${url.substring(0, 60)}...`);
        await sleep(1500 * (i + 1));
        continue;
      }
      log(`Fetch failed (${err.message.substring(0, 60)}): ${url.substring(0, 60)}`);
      return null;
    }
  }
  return null;
}

async function fetchTickers() {
  const res = await fetchWithRetry('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (!res) throw new Error('Ticker fetch failed after retries');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchKlines(symbol, interval = '1h', limit = 30) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetchWithRetry(url);
  if (!res || !res.ok) return null;
  return res.json();
}

// ── SIGNAL ANALYSIS ──────────────────────────────────────────
async function analyzeSymbol(ticker) {
  try {
    const symbol = ticker.symbol;
    const chg24h = parseFloat(ticker.priceChangePercent);
    const klines = await fetchKlines(symbol, '1h', 30);
    if (!klines || klines.length < 15) return null;

    const closes = klines.map(k => parseFloat(k[4]));
    const rsi    = calcRSI(closes);
    const ema9   = calcEMA(closes, 9);
    const ema21  = calcEMA(closes, 21);
    const last   = closes[closes.length - 1];
    const prev   = closes[closes.length - 2];
    const chg1h  = ((last - prev) / prev) * 100;

    let score = 0;
    if      (rsi < 30) score += 3;
    else if (rsi < 40) score += 2;
    else if (rsi < 50) score += 1;
    else if (rsi > 70) score -= 3;
    else if (rsi > 60) score -= 2;
    else if (rsi > 50) score -= 1;

    score += ema9 > ema21 ? 2 : -2;

    if      (chg1h >  1.5) score += 2;
    else if (chg1h >  0.5) score += 1;
    else if (chg1h < -1.5) score -= 2;
    else if (chg1h < -0.5) score -= 1;

    if      (chg24h >  5) score += 1;
    else if (chg24h < -5) score -= 1;

    return { symbol, lastPrice: last, rsi: rsi.toFixed(0), score,
             chg1h: chg1h.toFixed(2), chg24h: chg24h.toFixed(2) };
  } catch(_) { return null; }
}

// ── TELEGRAM (HTML mode) ──────────────────────────────────────
async function tgSendTo(chatId, html) {
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:                  chatId,
        text:                     html,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      }),
      timeout: REQUEST_TIMEOUT,
    });
    const json = await res.json();
    if (!json.ok) {
      log(`tgSend error chat=${chatId}: ${json.error_code} — ${json.description}`);
      return { ok: false, error: `${json.error_code}: ${json.description}` };
    }
    return { ok: true };
  } catch(err) {
    log(`tgSend err chat=${chatId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function testChats(replyTo) {
  let report = `🔍 <b>Chat Test — ${now()}</b>\n\n`;
  report += `Token set: <b>${TELEGRAM_TOKEN ? '✅' : '❌ MISSING'}</b>\n`;
  report += `Chats configured: <b>${TELEGRAM_CHATS.length ? TELEGRAM_CHATS.join(', ') : '❌ NONE'}</b>\n\n`;
  for (const id of TELEGRAM_CHATS) {
    const r = await tgSendTo(id, `🧪 Test from bot — ${now()}`);
    report += `Chat <code>${id}</code>: ${r.ok ? '✅ Delivered' : `❌ ${e(r.error)}`}\n`;
  }
  await tgSendTo(replyTo, report);
}

// ── MESSAGE RATE LIMITER — 30s between sends ──────────────────
let lastMsgAt = 0;
const MSG_INTERVAL = 3 * 1000; // 3 seconds

async function tgSend(html) {
  log(`TG: ${html.replace(/<[^>]+>/g, '').substring(0, 80)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;

  const wait = MSG_INTERVAL - (Date.now() - lastMsgAt);
  if (wait > 0) {
    log(`Rate limit: waiting ${(wait / 1000).toFixed(0)}s before next message`);
    await sleep(wait);
  }
  lastMsgAt = Date.now();
  await Promise.all(TELEGRAM_CHATS.map(id => tgSendTo(id, html)));
}

// Send only to private chats (not channels) — for internal bot alerts
async function tgSendPrivate(html) {
  log(`TG(private): ${html.replace(/<[^>]+>/g, '').substring(0, 80)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  const privateChats = TELEGRAM_CHATS.filter(id => !id.startsWith('-'));
  await Promise.all(privateChats.map(id => tgSendTo(id, html)));
}

// ── SHARED REPLY MESSAGES ─────────────────────────────────────
const MSG_SIGNUP =
  `🚀 <b>Join Bitunix — Trade &amp; Earn Together!</b>\n\n` +
  `👉 <a href="https://www.bitunix.com/register?vipCode=Signalme">Sign up here (my referral link)</a>\n\n` +
  `<b>How to sign up:</b>\n` +
  `1. Tap the link above\n` +
  `2. Enter your <b>email</b> and set a <b>password</b>\n` +
  `3. Verify your email (check spam if not in inbox)\n` +
  `4. Done — you're in! No KYC required to start.\n\n` +
  `✅ After signing up, <b>send me your UID</b> — I'll set you as my partner.\n` +
  `💰 You earn <b>3% rebate on all your own trades</b>.\n` +
  `🤝 Share your own referral link to friends and earn from <b>their trades too</b>!\n\n` +
  `<i>Any questions? Just ask here. Let's grow together 🚀</i>`;

const MSG_TUT =
  `📖 <b>Bitunix — How to Top Up &amp; Start Trading</b>\n\n` +
  `<b>Step 1 — Deposit USDT</b>\n` +
  `1. Log in → tap <b>Assets</b> → <b>Deposit</b>\n` +
  `2. Select coin: <b>USDT</b>\n` +
  `3. Choose network: <b>TRC20</b> (cheapest) or <b>BEP20</b>\n` +
  `4. Copy your deposit address\n` +
  `5. Send USDT from your exchange/wallet to that address\n` +
  `6. Wait ~1–5 min — funds will appear in your spot wallet\n\n` +
  `<b>Step 2 — Transfer to Futures Wallet</b>\n` +
  `1. Go to <b>Assets → Transfer</b>\n` +
  `2. From: <b>Spot</b> → To: <b>Futures</b>\n` +
  `3. Enter amount → confirm\n\n` +
  `<b>Step 3 — Open a Futures Trade</b>\n` +
  `1. Tap <b>Trade → Futures → USDT-M Perpetual</b>\n` +
  `2. Pick a coin (e.g. BTC/USDT)\n` +
  `3. Set your <b>leverage</b> (start with 5x–10x if you're new)\n` +
  `4. Choose <b>Long</b> (price going up) or <b>Short</b> (price going down)\n` +
  `5. Enter your position size → tap <b>Open Long / Open Short</b>\n` +
  `6. ⚠️ Always set a <b>Stop Loss</b> to protect your funds!\n\n` +
  `💡 <b>Tips:</b>\n` +
  `• Follow this channel's signals for entry, TP &amp; SL levels\n` +
  `• Never risk more than you can afford to lose\n` +
  `• Start small and scale up as you learn\n\n` +
  `<i>Need help? Ask in the group anytime 🙌</i>`;

// ── COMMAND HANDLER ──────────────────────────────────────────
async function handleCommand(text, fromChatId) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  if (cmd === '/testchat' || cmd === 'testchat') {
    await testChats(fromChatId);
  } else if (cmd === '/help' || cmd === 'help') {
    await tgSendTo(fromChatId,
      `🤖 <b>AI Signal Bot — Commands</b>\n\n` +
      `📈 <b>Signals</b>\n` +
      `/scan — Force full signal scan now\n` +
      `/smc — SMC structure scan (top 10 coins, 4H)\n` +
      `/trader — Multi-indicator trader signals\n\n` +
      `🎓 <b>Getting Started</b>\n` +
      `/signup — How to sign up on Bitunix + my referral link\n` +
      `/tut — How to top up USDT &amp; start futures trading\n\n` +
      `⚙️ <b>Bot Control</b>\n` +
      `/pause — Pause auto scan\n` +
      `/resume — Resume auto scan\n` +
      `/testchat — Test all configured chat IDs\n` +
      `/help — Show this menu\n\n` +
      `<i>Auto scan every ${INTERVAL_MIN} min</i>`
    );
  } else if (cmd === '/signup' || cmd === 'signup') {
    await tgSendTo(fromChatId, MSG_SIGNUP);
  } else if (cmd === '/tut' || cmd === 'tut' || cmd === '/tutorial' || cmd === 'tutorial') {
    await tgSendTo(fromChatId, MSG_TUT);
  } else if (cmd === '/pause' || cmd === 'pause') {
    paused = true;
    await tgSend(`⏸ <b>Bot Paused</b>\nSend /resume to restart.`);
  } else if (cmd === '/resume' || cmd === 'resume') {
    paused = false;
    await tgSend(`▶️ <b>Bot Resumed</b>\nNext scan in ≤${INTERVAL_MIN} min.`);
  } else if (cmd === '/smc' || cmd === 'smc') {
    await tgSend(`🎯 <b>SMC Scan — Top 10 coins (4H structure)...</b>`);
    await runSMCScan(true);
  } else if (cmd === '/trader' || cmd === 'trader') {
    await tgSend(`🧠 <b>Trader Scan — Top 30 coins, multi-indicator confluence...</b>`);
    await runTraderScan(true);
  } else if (cmd === '/scan' || cmd === 'scan') {
    await tgSend(`🔍 <b>Scanning top ${TOP_COINS} coins...</b>`);
    await runScan(true);
  } else {
    await tgSendTo(fromChatId, `❓ Unknown command: <code>${e(cmd)}</code>\nSend /help for all commands.`);
  }
}

// ── LAST SIGNALS CACHE (for welcome message) ─────────────────
let lastSignalSummary = null; // set each time a trader signal is posted

// ── WELCOME NEW CHANNEL MEMBER ───────────────────────────────
async function welcomeMember(channelId, user) {
  const name = user.first_name || user.username || 'there';
  let msg =
    `👋 <b>Welcome, ${e(name)}!</b>\n\n` +
    `You've joined <b>AI Signal</b> — a 24/7 automated crypto signal bot.\n\n` +
    `📊 <b>What you'll get:</b>\n` +
    `• Live BUY/SELL signals with Entry, TP1/TP2/TP3 &amp; SL\n` +
    `• 🎯 Target Hit alerts with chart screenshot\n` +
    `• ⚡ Spike alerts when coins move ±3% fast\n` +
    `• Signals based on RSI, EMA, MACD, Bollinger Bands &amp; SMC structure\n\n`;

  if (lastSignalSummary) {
    msg += `📌 <b>Latest Signal:</b>\n${lastSignalSummary}\n\n`;
  }

  msg +=
    `━━━━━━━━━━━━━━━━━━\n` +
    `💼 <b>Want to trade &amp; earn together with your friends?</b>\n\n` +
    `Join me on <b>Bitunix</b> — the platform I use for futures trading.\n` +
    `👉 <a href="https://www.bitunix.com/register?vipCode=Signalme">Sign up here (my referral link)</a>\n\n` +
    `✅ After signing up, send me your <b>UID</b> — I'll set you as my partner.\n` +
    `💰 Earn <b>3% rebate on your own trades</b>.\n` +
    `🤝 Share your link with friends and earn from <b>their trades too</b>!\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>Useful commands:</b>\n` +
    `/signup — Sign up guide + referral link\n` +
    `/tut — How to top up USDT &amp; start futures trading\n` +
    `/help — All bot commands\n\n` +
    `<i>Questions? Just ask. Good luck and trade safe! 🚀</i>`;

  await tgSendTo(channelId, msg);
}

// ── TELEGRAM POLL ────────────────────────────────────────────
async function pollCommands() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  try {
    const res  = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1&allowed_updates=["message","chat_member"]`,
      { timeout: 8000 }
    );
    const data = await res.json();
    for (const u of (data.result || [])) {
      lastUpdateId = u.update_id;

      // ── New member joined a channel the bot is in ──────
      if (u.chat_member) {
        const cm = u.chat_member;
        const isJoin = cm.new_chat_member?.status === 'member' &&
                       (cm.old_chat_member?.status === 'left' || cm.old_chat_member?.status === 'kicked');
        if (isJoin) {
          log(`New member: ${cm.new_chat_member.user.username || cm.new_chat_member.user.id} joined ${cm.chat.id}`);
          await welcomeMember(String(cm.chat.id), cm.new_chat_member.user);
        }
        continue;
      }

      // ── Regular command message ────────────────────────
      const msg = u.message;
      if (!msg?.text) continue;
      if (!msg.text.startsWith('/')) continue; // only handle slash commands
      log(`CMD [${msg.chat.id}]: ${msg.text}`);
      await handleCommand(msg.text, String(msg.chat.id));
    }
  } catch(err) { log(`poll err: ${err.message}`); }
}

// ── 1-MIN SPIKE ALERT (±3%) ──────────────────────────────────
async function checkSpikes() {
  if (paused) return;
  try {
    const tickers = await fetchTickers();
    const top = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 30); // was 60 — halved to cut API calls

    const now_ts = Date.now();
    const alerts = [];

    const BATCH = 5;
    for (let i = 0; i < top.length; i += BATCH) {
      await Promise.all(top.slice(i, i + BATCH).map(async t => {
        try {
          // Use 1m klines: last 2 bars = last 1 min movement
          const klines = await fetchKlines(t.symbol, '1m', 3);
          if (!klines || klines.length < 2) return;
          const open  = parseFloat(klines[klines.length - 2][1]); // prev bar open
          const close = parseFloat(klines[klines.length - 1][4]); // latest close
          if (!open || open === 0) return;
          const pct = ((close - open) / open) * 100;
          if (Math.abs(pct) < SPIKE_PCT) return;
          if (now_ts - (spikeCooldown.get(t.symbol) || 0) < SPIKE_COOLDOWN) return;
          spikeCooldown.set(t.symbol, now_ts);

          // Quick RSI + EMA for signal quality
          const klines30 = await fetchKlines(t.symbol, '1h', 30);
          let rsi = 50; let ema9 = close; let ema21 = close;
          if (klines30 && klines30.length >= 15) {
            const closes = klines30.map(k => parseFloat(k[4]));
            rsi   = calcRSI(closes);
            ema9  = calcEMA(closes, 9);
            ema21 = calcEMA(closes, 21);
          }

          // ATR-based SL/TP
          const atr = Math.abs(close * 0.015); // fallback 1.5% ATR
          let entry, sl, tp1, tp2;
          if (pct > 0) { // PUMP → consider BUY
            entry = close;
            sl    = close - atr * 1.5;
            tp1   = close + atr * 2;
            tp2   = close + atr * 3.5;
          } else { // DUMP → consider SELL/SHORT
            entry = close;
            sl    = close + atr * 1.5;
            tp1   = close - atr * 2;
            tp2   = close - atr * 3.5;
          }

          alerts.push({
            symbol: t.symbol, pct, price: close, rsi: rsi.toFixed(0),
            ema9Above: ema9 > ema21, entry, sl, tp1, tp2,
          });
        } catch(_) {}
      }));
      await sleep(150);
    }

    alerts.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    for (const a of alerts.slice(0, 5)) {
      const coin    = a.symbol.replace('USDT', '');
      const isPump  = a.pct > 0;
      const dir     = isPump ? '🚀 PUMP' : '📉 DUMP';
      const signal  = isPump ? '🟢 BUY' : '🔴 SELL/SHORT';
      const sign    = isPump ? '+' : '';
      const slDir   = isPump ? '-' : '+';
      const tp1Dir  = isPump ? '+' : '-';
      const emaStr  = a.ema9Above ? '✅ EMA9 > EMA21' : '⚠️ EMA9 < EMA21';
      const rsiInt  = parseInt(a.rsi);
      const rsiStr  = rsiInt < 35 ? '🟢 Oversold' : rsiInt > 65 ? '🔴 Overbought' : '⚪ Neutral';
      const slPct   = (Math.abs(a.sl - a.entry) / a.entry * 100).toFixed(2);
      const tp1Pct  = (Math.abs(a.tp1 - a.entry) / a.entry * 100).toFixed(2);
      const tp2Pct  = (Math.abs(a.tp2 - a.entry) / a.entry * 100).toFixed(2);

      // TradingView public chart link (uses BINANCE:XXXUSDT)
      const tvUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${a.symbol}`;

      await tgSend(
        `⚡ <b>1-Min Spike Alert — ${now()}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${dir}: <b>${coin}/USDT</b>\n` +
        `Move: <b>${sign}${a.pct.toFixed(2)}%</b> in 1 min\n` +
        `Signal: <b>${signal}</b>\n\n` +
        `💰 <b>Entry:</b> <code>$${fmtPrice(a.entry)}</code>\n` +
        `🛑 <b>SL:</b> <code>$${fmtPrice(a.sl)}</code> (${slDir}${slPct}%)\n` +
        `🎯 <b>TP1:</b> <code>$${fmtPrice(a.tp1)}</code> (${tp1Dir}${tp1Pct}%)\n` +
        `🎯 <b>TP2:</b> <code>$${fmtPrice(a.tp2)}</code> (${tp1Dir}${tp2Pct}%)\n\n` +
        `📈 RSI: <b>${a.rsi}</b> ${rsiStr}\n` +
        `${emaStr}\n\n` +
        `📊 <a href="${tvUrl}">TradingView Chart</a>  |  ` +
        `🔗 <a href="${tradeLink(a.symbol)}">Trade Bitunix</a>`
      );
      await sleep(300);
    }
    if (alerts.length) log(`1-min spike alerts: ${alerts.length}`);
  } catch(err) { log(`spike err (silent): ${err.message}`); }
}

// ── MAIN SCAN ────────────────────────────────────────────────
async function runScan(forced = false) {
  log(`── Scan start${forced ? ' (forced)' : ''} ──`);
  if (paused && !forced) { log('Paused.'); return; }

  try {
    const tickers = await fetchTickers();
    const top = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, TOP_COINS);

    log(`Analyzing ${top.length} coins...`);

    const results = [];
    const BATCH   = 5;
    for (let i = 0; i < top.length; i += BATCH) {
      const analyzed = await Promise.all(top.slice(i, i + BATCH).map(t => analyzeSymbol(t)));
      results.push(...analyzed.filter(Boolean));
      if (i + BATCH < top.length) await sleep(300);
    }

    const strongBuy  = results.filter(r => r.score >= 5).sort((a, b) => b.score - a.score);
    const buy        = results.filter(r => r.score >= 2 && r.score < 5).sort((a, b) => b.score - a.score);
    const neutral    = results.filter(r => r.score > -2 && r.score < 2).sort((a, b) => b.score - a.score);
    const sell       = results.filter(r => r.score <= -2 && r.score > -5).sort((a, b) => a.score - b.score);
    const strongSell = results.filter(r => r.score <= -5).sort((a, b) => a.score - b.score);

    log(`SB:${strongBuy.length} B:${buy.length} N:${neutral.length} S:${sell.length} SS:${strongSell.length}`);

    // Format a signal group (full row per coin)
    const formatGroup = (label, emoji, coins) => {
      if (!coins.length) return '';
      let s = `${emoji} <b>${label}</b> (${coins.length})\n`;
      for (const c of coins) {
        const coin    = c.symbol.replace('USDT', '');
        const chgSign = parseFloat(c.chg24h) >= 0 ? '+' : '';
        s += `• <a href="${tradeLink(c.symbol)}">${coin}/USDT</a>  <code>$${fmtPrice(c.lastPrice)}</code>  RSI:${c.rsi}  ${chgSign}${e(c.chg24h)}%\n`;
      }
      return s + '\n';
    };

    // Neutral group — compact (name + price only)
    const formatNeutral = (coins) => {
      if (!coins.length) return '';
      let s = `⚪ <b>NEUTRAL</b> (${coins.length})\n`;
      for (const c of coins) {
        const coin = c.symbol.replace('USDT', '');
        s += `• <a href="${tradeLink(c.symbol)}">${coin}/USDT</a>  <code>$${fmtPrice(c.lastPrice)}</code>\n`;
      }
      return s + '\n';
    };

    const header = `📊 <b>Signal Summary — ${now()}</b>\n<i>Top ${TOP_COINS} coins · RSI + EMA · tap coin to trade on Bitunix</i>\n\n`;
    const footer = `<i>Next scan in ${INTERVAL_MIN} min · /scan to refresh</i>`;

    const part1 = header +
      formatGroup('STRONG BUY',  '🟢🟢', strongBuy) +
      formatGroup('BUY',          '🟢',   buy);

    const part2 =
      formatNeutral(neutral) +
      formatGroup('SELL',         '🔴',   sell) +
      formatGroup('STRONG SELL', '🔴🔴', strongSell) +
      footer;

    if ((part1 + part2).length <= 3900) {
      await tgSend(part1 + part2);
    } else {
      await tgSend(part1);
      await sleep(500);
      await tgSend(part2);
    }

  } catch(err) { log(`scan err (silent): ${err.message}`); }
  log('── Scan end ──\n');
}

// ── SMC MODULE ───────────────────────────────────────────────
// SMC concepts: CHoCH, BMS, SMS, Premium/Discount zones
// Entry, SL, TP prediction based on structure + ATR

function calcATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high  = parseFloat(klines[i][2]);
    const low   = parseFloat(klines[i][3]);
    const pClose= parseFloat(klines[i - 1][4]);
    trs.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function detectSMC(klines) {
  const n = klines.length;
  if (n < 20) return null;

  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));

  // ── Swing Pivot Detection (3-bar confirmation) ────────────────
  const swingHighs = [];
  const swingLows  = [];
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      swingHighs.push({ idx: i, val: highs[i] });
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      swingLows.push({ idx: i, val: lows[i] });
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  const lastClose = closes[n - 1];
  const prevClose = closes[n - 2];

  const sh1 = swingHighs[swingHighs.length - 1];
  const sh2 = swingHighs[swingHighs.length - 2];
  const sl1 = swingLows[swingLows.length - 1];
  const sl2 = swingLows[swingLows.length - 2];

  // ── Market Structure: HH / HL / LH / LL ─────────────────────
  // HH = new swing high > previous swing high (bullish)
  // HL = new swing low  > previous swing low  (bullish)
  // LH = new swing high < previous swing high (bearish)
  // LL = new swing low  < previous swing low  (bearish)
  const shLabel = sh1.val > sh2.val ? 'HH' : 'LH'; // latest high structure
  const slLabel = sl1.val > sl2.val ? 'HL' : 'LL'; // latest low structure

  let trend = 'ranging';
  if (shLabel === 'HH' && slLabel === 'HL') trend = 'uptrend';
  else if (shLabel === 'LH' && slLabel === 'LL') trend = 'downtrend';
  else if (shLabel === 'HH') trend = 'bullish';
  else if (shLabel === 'LH' && slLabel === 'HL') trend = 'weakening';
  else if (shLabel === 'LH') trend = 'bearish';

  // ── EQL / EQH — Equal Lows / Equal Highs (liquidity zones) ──
  // Two swing lows/highs within 0.3% = equal level = liquidity pool
  const EQ_TOL = 0.003;
  let eql = null; // Equal Lows price
  let eqh = null; // Equal Highs price

  if (Math.abs(sl1.val - sl2.val) / sl2.val < EQ_TOL)
    eql = (sl1.val + sl2.val) / 2;
  if (Math.abs(sh1.val - sh2.val) / sh2.val < EQ_TOL)
    eqh = (sh1.val + sh2.val) / 2;

  // ── Premium / Discount Zones ──────────────────────────────────
  const rangeHigh   = sh1.val;
  const rangeLow    = sl1.val;
  const rangeSize   = rangeHigh - rangeLow;
  const premiumBot  = rangeHigh - rangeSize * 0.25;
  const discountTop = rangeLow  + rangeSize * 0.25;
  const equilibrium = rangeLow  + rangeSize * 0.5;

  let zone = 'equilibrium';
  if (lastClose >= premiumBot) zone = 'premium';
  else if (lastClose <= discountTop) zone = 'discount';

  // ── Signal Detection ──────────────────────────────────────────
  let signal = null, structure = null, structureLabel = '';

  // CHoCH BUY: downtrend/bearish structure → price breaks above last LH
  // Only valid when trend was bearish — this is the reversal signal
  if ((trend === 'downtrend' || trend === 'bearish') && lastClose > sh1.val && prevClose <= sh1.val) {
    signal = 'BUY'; structure = 'CHoCH';
    structureLabel = `${shLabel}+${slLabel} → Bullish Reversal`;
  }
  // CHoCH SELL: uptrend/bullish structure → price breaks below last HL
  else if ((trend === 'uptrend' || trend === 'bullish') && lastClose < sl1.val && prevClose >= sl1.val) {
    signal = 'SELL'; structure = 'CHoCH';
    structureLabel = `${shLabel}+${slLabel} → Bearish Reversal`;
  }
  // BMS BUY: uptrend continuation — HH+HL, break above last HH
  else if (trend === 'uptrend' && lastClose > sh1.val) {
    signal = 'BUY'; structure = 'BMS';
    structureLabel = 'HH+HL Continuation';
  }
  // BMS SELL: downtrend continuation — LH+LL, break below last LL
  else if (trend === 'downtrend' && lastClose < sl1.val) {
    signal = 'SELL'; structure = 'BMS';
    structureLabel = 'LH+LL Continuation';
  }
  // EQL Sweep BUY: price sweeps equal lows (liquidity grab) then closes above
  else if (eql && lows[n-1] < eql && lastClose > eql) {
    signal = 'BUY'; structure = 'EQL Sweep';
    structureLabel = `Equal Lows $${fmtPrice(eql)} swept`;
  }
  // EQH Sweep SELL: price sweeps equal highs (liquidity grab) then closes below
  else if (eqh && highs[n-1] > eqh && lastClose < eqh) {
    signal = 'SELL'; structure = 'EQH Sweep';
    structureLabel = `Equal Highs $${fmtPrice(eqh)} swept`;
  }

  if (!signal) return null;

  const atr = calcATR(klines, 14) || rangeSize * 0.02;

  let entry, sl, tp1, tp2;
  if (signal === 'BUY') {
    entry = zone === 'discount' ? lastClose : discountTop;
    sl    = sl1.val - atr * 0.5;
    tp1   = entry + (entry - sl) * 1.5;
    tp2   = entry + (entry - sl) * 2.5;
  } else {
    entry = zone === 'premium' ? lastClose : premiumBot;
    sl    = sh1.val + atr * 0.5;
    tp1   = entry - (sl - entry) * 1.5;
    tp2   = entry - (sl - entry) * 2.5;
  }

  const slPct  = ((Math.abs(entry - sl)  / entry) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1 - entry) / entry) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2 - entry) / entry) * 100).toFixed(2);

  return {
    signal, structure, structureLabel, zone, trend,
    marketStructure: `${shLabel}+${slLabel}`,
    entry, sl, tp1, tp2,
    slPct, tp1Pct, tp2Pct,
    swingHigh: sh1.val, swingLow: sl1.val,
    eql, eqh, premiumBot, discountTop, equilibrium,
  };
}

function tvLink(symbol) {
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}`;
}

// ── TRADER-STYLE SIGNAL ENGINE ───────────────────────────────
// Mimics the logic of top Telegram trader groups + AI platforms:
// CryptoNinjas  — high accuracy, futures focus, confluence-based
// Bitcoin Bullets — quality > quantity, high-conviction only
// Evening Trader — spot + futures, volume + momentum
// LuxAlgo        — kNN-style momentum + structure
// AltFINS        — smart money accumulation / breakout
// Dash2Trade     — sentiment + volume spike detection

function calcBBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const sd    = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: mean + mult * sd, mid: mean, lower: mean - mult * sd, sd };
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast   = calcEMA(closes.slice(-fast - 10), fast);
  const emaSlow   = calcEMA(closes.slice(-slow - 10), slow);
  const macdLine  = emaFast - emaSlow;
  // signal line: EMA of last `signal` MACD values (approximate)
  const macdVals  = [];
  for (let i = signal; i >= 1; i--) {
    const sf = calcEMA(closes.slice(-(fast + i + 5)), fast);
    const ss = calcEMA(closes.slice(-(slow + i + 5)), slow);
    macdVals.push(sf - ss);
  }
  macdVals.push(macdLine);
  const signalLine = calcEMA(macdVals, signal);
  return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
}

function calcStoch(klines, period = 14) {
  if (!klines || klines.length < period) return null;
  const slice = klines.slice(-period);
  const highMax = Math.max(...slice.map(k => parseFloat(k[2])));
  const lowMin  = Math.min(...slice.map(k => parseFloat(k[3])));
  const lastClose = parseFloat(klines[klines.length - 1][4]);
  if (highMax === lowMin) return null;
  const k = ((lastClose - lowMin) / (highMax - lowMin)) * 100;
  return k;
}

function calcVolumeRatio(klines, period = 10) {
  if (!klines || klines.length < period + 1) return 1;
  const vols   = klines.map(k => parseFloat(k[5]));
  const avgVol = vols.slice(-(period + 1), -1).reduce((a, b) => a + b, 0) / period;
  const lastVol = vols[vols.length - 1];
  return avgVol > 0 ? lastVol / avgVol : 1;
}

// Score-based system: each "trader style" adds weight to BUY or SELL
// Returns full indicator breakdown for display
function traderScore(closes, klines) {
  let buyScore  = 0;
  let sellScore = 0;
  const rows = []; // { name, verdict, buy, sell, source }

  const last  = closes[closes.length - 1];
  const rsi   = calcRSI(closes, 14);
  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const bb    = calcBBands(closes, 20, 2);
  const macd  = calcMACD(closes);
  const stoch = calcStoch(klines, 14);
  const volR  = calcVolumeRatio(klines, 10);

  // ── RSI (CryptoNinjas, Evening Trader) ──
  {
    let v, b = 0, s = 0;
    if      (rsi < 30) { v = `🟢 Oversold (${rsi.toFixed(0)})`;  b = 3; }
    else if (rsi < 40) { v = `🟢 Low (${rsi.toFixed(0)})`;        b = 2; }
    else if (rsi < 50) { v = `🟡 Mild Low (${rsi.toFixed(0)})`;   b = 1; }
    else if (rsi > 70) { v = `🔴 Overbought (${rsi.toFixed(0)})`; s = 3; }
    else if (rsi > 60) { v = `🔴 High (${rsi.toFixed(0)})`;       s = 2; }
    else if (rsi > 50) { v = `🟡 Mild High (${rsi.toFixed(0)})`;  s = 1; }
    else               { v = `⚪ Neutral (${rsi.toFixed(0)})`;            }
    buyScore += b; sellScore += s;
    rows.push({ name: 'RSI(14)', verdict: v, source: 'CryptoNinjas · EveningTrader' });
  }

  // ── EMA Stack (LuxAlgo, Evening Trader) ──
  {
    let v, b = 0, s = 0;
    if      (ema9 > ema21 && ema21 > ema50) { v = '🟢 Bullish Stack 9&gt;21&gt;50'; b = 3; }
    else if (ema9 > ema21)                  { v = '🟢 EMA9 &gt; EMA21';             b = 2; }
    else if (ema9 < ema21 && ema21 < ema50) { v = '🔴 Bearish Stack 9&lt;21&lt;50'; s = 3; }
    else if (ema9 < ema21)                  { v = '🔴 EMA9 &lt; EMA21';             s = 2; }
    else                                    { v = '⚪ Equal';                               }
    buyScore += b; sellScore += s;
    rows.push({ name: 'EMA 9/21/50', verdict: v, source: 'LuxAlgo · EveningTrader' });
  }

  // ── Bollinger Bands (AltFINS) ──
  if (bb) {
    let v, b = 0, s = 0;
    const pct = ((last - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(0);
    if      (last < bb.lower)             { v = `🟢 Below Lower BB (${pct}%)`;  b = 3; }
    else if (last > bb.upper)             { v = `🔴 Above Upper BB (${pct}%)`;  s = 3; }
    else if (last < bb.mid)               { v = `🟡 Below Mid BB (${pct}%)`;    b = 1; }
    else                                  { v = `🟡 Above Mid BB (${pct}%)`;    s = 1; }
    buyScore += b; sellScore += s;
    rows.push({ name: 'Bollinger Bands', verdict: v, source: 'AltFINS' });
  }

  // ── MACD (Bitcoin Bullets, CryptoNinjas) ──
  if (macd) {
    let v, b = 0, s = 0;
    const histSign = macd.hist > 0 ? '+' : '';
    if      (macd.hist > 0 && macd.macd > macd.signal) { v = `🟢 Bullish (hist ${histSign}${macd.hist.toFixed(4)})`;  b = 2; }
    else if (macd.hist < 0 && macd.macd < macd.signal) { v = `🔴 Bearish (hist ${histSign}${macd.hist.toFixed(4)})`; s = 2; }
    else                                                { v = `⚪ Mixed (hist ${histSign}${macd.hist.toFixed(4)})`; }
    buyScore += b; sellScore += s;
    rows.push({ name: 'MACD(12,26,9)', verdict: v, source: 'BitcoinBullets · CryptoNinjas' });
  }

  // ── Stochastic (Evening Trader, Dash2Trade) ──
  if (stoch !== null) {
    let v, b = 0, s = 0;
    if      (stoch < 20) { v = `🟢 Oversold (${stoch.toFixed(0)})`;  b = 2; }
    else if (stoch < 40) { v = `🟡 Low (${stoch.toFixed(0)})`;        b = 1; }
    else if (stoch > 80) { v = `🔴 Overbought (${stoch.toFixed(0)})`; s = 2; }
    else if (stoch > 60) { v = `🟡 High (${stoch.toFixed(0)})`;       s = 1; }
    else                 { v = `⚪ Neutral (${stoch.toFixed(0)})`;            }
    buyScore += b; sellScore += s;
    rows.push({ name: 'Stochastic(14)', verdict: v, source: 'EveningTrader · Dash2Trade' });
  }

  // ── Volume Ratio (Dash2Trade, AltFINS Smart Money) ──
  {
    let v, b = 0, s = 0;
    if      (volR > 3)   { v = `🔥 Huge Spike x${volR.toFixed(1)}`;  b = 2; s = 2; } // spike boosts whichever side is winning
    else if (volR > 2)   { v = `🔥 Big Spike x${volR.toFixed(1)}`;   b = 1; s = 1; }
    else if (volR > 1.3) { v = `🟡 Above Avg x${volR.toFixed(1)}`;                 }
    else if (volR < 0.7) { v = `⚪ Low Volume x${volR.toFixed(1)}`;                }
    else                 { v = `⚪ Normal x${volR.toFixed(1)}`;                     }
    // Volume amplifies the leading direction only
    if (b > 0) { if (buyScore > sellScore) buyScore += b; else sellScore += s; }
    rows.push({ name: 'Volume Ratio', verdict: v, source: 'Dash2Trade · AltFINS' });
  }

  return { buyScore, sellScore, rows, rsi, ema9, ema21, ema50, bb, macd, stoch, volR };
}

// Categorise a coin — Bitcoin Bullets style (high conviction only)
// Returns null if not high conviction
async function analyzeTrader(ticker, timeframe = '4h') {
  try {
    const klines = await fetchKlines(ticker.symbol, timeframe, 80);
    if (!klines || klines.length < 30) return null;

    const closes = klines.map(k => parseFloat(k[4]));
    const atr    = calcATR(klines, 14) || parseFloat(ticker.lastPrice) * 0.02;
    const smc    = detectSMC(klines);

    const scored = traderScore(closes, klines);
    let { buyScore, sellScore, rows, rsi, ema9, ema21, volR } = scored;

    // SMC bonus row — includes HH/HL/LH/LL, EQL/EQH, trend, zone
    if (smc) {
      const eqInfo = [
        smc.eql ? `EQL $${fmtPrice(smc.eql)}` : null,
        smc.eqh ? `EQH $${fmtPrice(smc.eqh)}` : null,
      ].filter(Boolean).join(' | ');
      const structLine = `${smc.structure} | ${smc.marketStructure} | ${smc.trend} | zone:${smc.zone}` +
        (eqInfo ? ` | ${eqInfo}` : '');
      if (smc.signal === 'BUY') {
        buyScore += 3;
        rows.unshift({ name: 'SMC Structure', verdict: `🟢 ${structLine}\n  <i>${e(smc.structureLabel)}</i>`, source: 'Smart Money Concepts' });
      } else {
        sellScore += 3;
        rows.unshift({ name: 'SMC Structure', verdict: `🔴 ${structLine}\n  <i>${e(smc.structureLabel)}</i>`, source: 'Smart Money Concepts' });
      }
    } else {
      rows.unshift({ name: 'SMC Structure', verdict: '⚪ No structure break / trend unclear', source: 'Smart Money Concepts' });
    }

    const net      = buyScore - sellScore;
    const last     = parseFloat(ticker.lastPrice);
    const chg24h   = parseFloat(ticker.priceChangePercent);

    // Fire all signals — no minimum threshold
    if (net === 0) return null; // skip only if completely neutral

    const isBuy = net > 0;

    // Entry / SL / TP
    let entry, sl, tp1, tp2, tp3;
    if (isBuy) {
      entry = last;
      sl    = entry - atr * 1.5;
      tp1   = entry + atr * 2;
      tp2   = entry + atr * 3.5;
      tp3   = entry + atr * 5.5;
    } else {
      entry = last;
      sl    = entry + atr * 1.5;
      tp1   = entry - atr * 2;
      tp2   = entry - atr * 3.5;
      tp3   = entry - atr * 5.5;
    }

    const slPct  = (Math.abs(sl  - entry) / entry * 100).toFixed(2);
    const tp1Pct = (Math.abs(tp1 - entry) / entry * 100).toFixed(2);
    const tp2Pct = (Math.abs(tp2 - entry) / entry * 100).toFixed(2);
    const tp3Pct = (Math.abs(tp3 - entry) / entry * 100).toFixed(2);

    return {
      symbol: ticker.symbol, lastPrice: last, chg24h,
      signal: isBuy ? 'BUY' : 'SELL',
      conviction: Math.abs(net),
      buyScore, sellScore, rows,
      rsi: rsi.toFixed(0), ema9Above: ema9 > ema21,
      volR: volR.toFixed(1),
      entry, sl, tp1, tp2, tp3,
      slPct, tp1Pct, tp2Pct, tp3Pct,
      timeframe,
    };
  } catch (_) { return null; }
}

// ── SIGNAL TRACKER — monitors TP/SL after posting ────────────
// Map: symbol → { signal, entry, tp1, tp2, tp3, sl, timeframe, tpHit, slHit }
const signalTracker  = new Map();
const traderCooldown = new Map();
const TRADER_COOLDOWN = 60 * 60 * 1000; // 1 hour per coin

// Generate a chart image via QuickChart.io (free, no API key needed)
// Returns a URL pointing to a PNG of the price line + entry/TP/SL levels
async function generateChartUrl(symbol, interval, entry, tp, sl, hitType) {
  try {
    const klines = await fetchKlines(symbol, interval, 60);
    if (!klines || klines.length < 10) return null;

    const closes = klines.map(k => parseFloat(k[4]));
    const labels  = closes.map((_, i) => i + 1);

    const chart = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: symbol,
            data: closes,
            borderColor: '#00e5ff',
            borderWidth: 2,
            fill: false,
            pointRadius: 0,
          },
          {
            label: hitType === 'TP' ? '🎯 TP HIT' : 'TP',
            data: labels.map(() => tp),
            borderColor: '#00e676',
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'Entry',
            data: labels.map(() => entry),
            borderColor: '#ffd740',
            borderWidth: 1.5,
            borderDash: [3, 3],
            pointRadius: 0,
            fill: false,
          },
          {
            label: hitType === 'SL' ? '🛑 SL HIT' : 'SL',
            data: labels.map(() => sl),
            borderColor: '#ff1744',
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        plugins: {
          title: {
            display: true,
            text: `${symbol} ${interval.toUpperCase()} — ${hitType === 'TP' ? '🎯 TARGET HIT' : '🛑 STOP LOSS HIT'}`,
            color: '#ffffff',
          },
          legend: { labels: { color: '#ffffff' } },
        },
        scales: {
          x: { ticks: { color: '#888' } },
          y: { ticks: { color: '#888' } },
        },
      },
    };

    const res = await fetch('https://quickchart.io/chart/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart, width: 800, height: 420, format: 'png', backgroundColor: '#1a1a2e' }),
      timeout: 15000,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.url || null;
  } catch (e) {
    log(`generateChartUrl err: ${e.message}`);
    return null;
  }
}

// Send a photo to all chats
async function tgSendPhotoTo(chatId, photoUrl, caption) {
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML', disable_web_page_preview: true }),
      timeout: REQUEST_TIMEOUT,
    });
    const json = await res.json();
    if (!json.ok) log(`tgSendPhoto error chat=${chatId}: ${json.description}`);
  } catch (e) { log(`tgSendPhoto err: ${e.message}`); }
}

async function tgSendPhoto(photoUrl, caption) {
  log(`TG Photo: ${caption.replace(/<[^>]+>/g, '').substring(0, 80)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length || !photoUrl) {
    if (!photoUrl) await tgSend(caption); // fallback: text only
    return;
  }
  const wait = MSG_INTERVAL - (Date.now() - lastMsgAt);
  if (wait > 0) await sleep(wait);
  lastMsgAt = Date.now();
  await Promise.all(TELEGRAM_CHATS.map(id => tgSendPhotoTo(id, photoUrl, caption)));
}

// Check all tracked signals — if TP or SL hit, send chart + alert
async function checkSignalTargets() {
  if (!signalTracker.size || isBanned()) return;
  const toRemove = [];

  for (const [sym, sig] of signalTracker) {
    try {
      // Expire signals older than 48h
      if (Date.now() - sig.postedAt > 48 * 60 * 60 * 1000) { toRemove.push(sym); continue; }

      const res = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
      if (!res) continue;
      const { price: ps } = await res.json();
      const cur    = parseFloat(ps);
      const isBuy  = sig.signal === 'BUY';
      const coin   = sym.replace('USDT', '');

      // ── SL hit ──────────────────────────────────────────
      const slHit = isBuy ? cur <= sig.sl : cur >= sig.sl;
      if (slHit) {
        log(`Signal tracker: SL hit ${sym} @ $${cur}`);
        const chartUrl = await generateChartUrl(sym, sig.timeframe, sig.entry, sig.tp1, sig.sl, 'SL');
        const loss = (Math.abs(sig.sl - sig.entry) / sig.entry * 100).toFixed(2);
        const caption =
          `🛑 <b>Stop Loss Hit — ${coin}/USDT</b>\n` +
          `Entry: <code>$${fmtPrice(sig.entry)}</code>\n` +
          `SL triggered at: <code>$${fmtPrice(cur)}</code> (-${loss}%)\n` +
          `<i>Signal closed · ${now()}</i>`;
        await tgSendPhoto(chartUrl, caption);
        toRemove.push(sym);
        continue;
      }

      // ── TP hit (check TP1 → TP2 → TP3 in order) ────────
      const tps = [sig.tp1, sig.tp2, sig.tp3];
      for (let i = sig.tpHit; i < tps.length; i++) {
        const tpHit = isBuy ? cur >= tps[i] : cur <= tps[i];
        if (tpHit) {
          log(`Signal tracker: TP${i+1} hit ${sym} @ $${cur}`);
          const chartUrl = await generateChartUrl(sym, sig.timeframe, sig.entry, tps[i], sig.sl, 'TP');
          const gain = (Math.abs(tps[i] - sig.entry) / sig.entry * 100).toFixed(2);
          const hasNext = i < tps.length - 1;
          const caption =
            `🎯 <b>Target ${i+1} Hit — ${coin}/USDT</b>\n` +
            `Entry: <code>$${fmtPrice(sig.entry)}</code>\n` +
            `TP${i+1} reached: <code>$${fmtPrice(cur)}</code> (+${gain}%)\n` +
            (hasNext
              ? `⏭ Next target TP${i+2}: <code>$${fmtPrice(tps[i+1])}</code>\n`
              : `✅ <b>All targets hit!</b>\n`) +
            `<i>${now()}</i>`;
          await tgSendPhoto(chartUrl, caption);
          sig.tpHit = i + 1;
          if (!hasNext) toRemove.push(sym);
          break;
        }
      }
    } catch (e) { log(`checkSignalTargets ${sym}: ${e.message}`); }
    await sleep(300);
  }

  toRemove.forEach(s => signalTracker.delete(s));
  if (toRemove.length) log(`Signal tracker: closed ${toRemove.join(', ')}`);
}

// ── SMC RULE VALIDATOR ────────────────────────────────────────
// Applies all 3 rules before a signal is posted.
// Returns { pass, reason, badges } — only pass:true signals get posted.
async function smcValidate(symbol, signalDir) {
  try {
    // 15m structure
    const klines15 = await fetchKlines(symbol, '15m', 50);
    if (!klines15 || klines15.length < 20) return { pass: true, reason: 'no 15m data', badges: [] };
    const smc = detectSMC(klines15);
    if (!smc) return { pass: true, reason: 'no structure', badges: [] };

    const lhFormed = smc.shLabel === 'LH';
    const llFormed = smc.slLabel === 'LL';
    const hhFormed = smc.shLabel === 'HH';
    const hlFormed = smc.slLabel === 'HL';
    const badges   = [];

    // ── Rule 1: LH formed → block BUY ──────────────────────
    if (lhFormed && signalDir === 'BUY') {
      // Rule 2 exception: LL at OB + reversal allows BUY
      const closes = klines15.map(k => parseFloat(k[4]));
      const opens  = klines15.map(k => parseFloat(k[1]));
      const highs  = klines15.map(k => parseFloat(k[2]));
      const lows   = klines15.map(k => parseFloat(k[3]));
      const price  = closes[closes.length - 1];
      const rsi    = calcRSI(closes);

      // Detect OB: last bearish candle before strongest bullish impulse
      let atOB = false;
      for (let i = 5; i < Math.min(klines15.length - 3, 40); i++) {
        const impulse = (closes[i] - closes[i - 3]) / closes[i - 3] * 100;
        if (impulse < 2.5) continue;
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (closes[j] < opens[j]) {
            const obLow  = Math.min(opens[j], closes[j]) * 0.998;
            const obHigh = Math.max(opens[j], closes[j]) * 1.002;
            atOB = price >= obLow && price <= obHigh;
            break;
          }
        }
        if (atOB) break;
      }

      // Reversal sign
      const lastI    = closes.length - 1;
      const body     = Math.abs(closes[lastI] - opens[lastI]);
      const fullR    = highs[lastI] - lows[lastI];
      const lwk      = Math.min(opens[lastI], closes[lastI]) - lows[lastI];
      const prevBear = closes[lastI-1] < opens[lastI-1];
      const curBull  = closes[lastI] > opens[lastI];
      const hammer   = lwk > body * 2 && fullR > 0;
      const engulf   = curBull && prevBear && closes[lastI] > opens[lastI-1];
      const reversal = hammer || engulf;

      if (llFormed && atOB && reversal && rsi < 45) {
        badges.push('🏦 Rule 2 — OB Reversal');
        return { pass: true, reason: 'Rule 2 OB exception', badges };
      }
      return { pass: false, reason: `Rule 1: LH formed — BUY blocked (${smc.marketStructure})`, badges };
    }

    // ── Rule 1: HH+HL only uptrend → block SELL ────────────
    if (hhFormed && hlFormed && signalDir === 'SELL') {
      return { pass: false, reason: `Rule 1: HH+HL uptrend — SELL blocked (${smc.marketStructure})`, badges };
    }

    // ── Rule 3: SELL confluence check ──────────────────────
    if (signalDir === 'SELL') {
      badges.push(`📐 ${smc.marketStructure}`);

      const klines1m = await fetchKlines(symbol, '1m', 250);
      const closes1m = klines1m ? klines1m.map(k => parseFloat(k[4])) : [];
      const price    = parseFloat(klines15[klines15.length - 1][4]);
      const TOLS     = 0.003;

      // VWAP upper band
      let vwapUpper = null;
      if (klines1m && klines1m.length >= 5) {
        let sumPV = 0, sumV = 0;
        const typs = [];
        for (const k of klines1m) {
          const tp = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
          const v  = parseFloat(k[5]);
          sumPV += tp * v; sumV += v; typs.push(tp);
        }
        if (sumV > 0) {
          const vwap = sumPV / sumV;
          const std  = Math.sqrt(typs.reduce((s, p) => s + Math.pow(p - vwap, 2), 0) / typs.length);
          vwapUpper = vwap + 1.5 * std;
        }
      }

      // 200 EMA on 1m
      let ema200 = null;
      if (closes1m.length >= 200) {
        const k = 2 / 201;
        let v = closes1m.slice(0, 200).reduce((a, b) => a + b, 0) / 200;
        for (let i = 200; i < closes1m.length; i++) v = closes1m[i] * k + v * (1 - k);
        ema200 = v;
      }

      // Daily session open
      let sessionOpen = null;
      try {
        const d = await fetchKlines(symbol, '1d', 2);
        if (d && d.length >= 1) sessionOpen = parseFloat(d[d.length - 1][1]);
      } catch (_) {}

      const nearVWAP    = vwapUpper  && Math.abs(price - vwapUpper)  / price < TOLS;
      const nearEMA200  = ema200     && Math.abs(price - ema200)      / price < TOLS;
      const nearSessOp  = sessionOpen && Math.abs(price - sessionOpen) / price < TOLS;
      const confCount   = [nearVWAP, nearEMA200, nearSessOp].filter(Boolean).length;

      if (confCount >= 2) badges.push(`🎯 Rule 3 Confluence (${confCount}/3)`);
      if (nearVWAP)   badges.push('  └ Upper VWAP ✅');
      if (nearEMA200) badges.push('  └ 200 EMA ✅');
      if (nearSessOp) badges.push('  └ Session Open ✅');

      if (lhFormed && llFormed) badges.push('📉 LH+LL Downtrend');
      else if (lhFormed)        badges.push('📉 LH Bearish');
    }

    // ── Rule 3: BUY confluence check ───────────────────────
    if (signalDir === 'BUY' && (hhFormed || hlFormed)) {
      badges.push(`📐 ${smc.marketStructure}`);
      if (hhFormed && hlFormed) badges.push('📈 HH+HL Uptrend');
      else if (hhFormed)        badges.push('📈 HH Bullish');
    }

    return { pass: true, reason: 'ok', badges };
  } catch (e) {
    log(`smcValidate err ${symbol}: ${e.message}`);
    return { pass: true, reason: 'error — allow', badges: [] };
  }
}

async function runTraderScan(forced = false) {
  log(`── Trader Scan start${forced ? ' (forced)' : ''} ──`);
  if (paused && !forced) { log('Paused.'); return; }

  try {
    const tickers = await fetchTickers();
    // Top 30 coins by volume
    const top30 = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 30);

    const results = [];
    const now_ts  = Date.now();

    for (const ticker of top30) {
      if (!forced && now_ts - (traderCooldown.get(ticker.symbol) || 0) < TRADER_COOLDOWN) continue;
      const r = await analyzeTrader(ticker, '4h');
      if (!r) { await sleep(120); continue; }

      // ── Apply SMC Rules before posting ──────────────────
      const smc = await smcValidate(ticker.symbol, r.signal);
      if (!smc.pass) {
        log(`Signal filtered [${ticker.symbol} ${r.signal}]: ${smc.reason}`);
        await sleep(120);
        continue;
      }
      r.smcBadges = smc.badges;
      results.push(r);
      traderCooldown.set(ticker.symbol, now_ts);
      await sleep(120);
    }

    if (!results.length) {
      if (forced) await tgSend(`🧠 <b>Trader Scan</b> — No high-conviction signals right now.\n<i>Bot requires 6+ indicator confluence to fire.</i>`);
      log('Trader: no signals');
      return;
    }

    // Sort by conviction score desc
    results.sort((a, b) => b.conviction - a.conviction);

    for (const r of results.slice(0, 6)) {
      const coin      = r.symbol.replace('USDT', '');
      const isBuy     = r.signal === 'BUY';
      const sEmoji    = isBuy ? '🟢' : '🔴';
      const chgSign   = r.chg24h >= 0 ? '+' : '';
      const slDir     = isBuy ? '-' : '+';
      const tpDir     = isBuy ? '+' : '-';

      // Score summary
      const convLabel = `🟢 BUY ${r.buyScore}pt  vs  🔴 SELL ${r.sellScore}pt`;

      // All indicator rows
      const indicatorList = r.rows.map(row =>
        `<b>${row.name}</b>: ${row.verdict}\n  <i>${row.source}</i>`
      ).join('\n');

      const msg =
        `🧠 <b>Trader Signal — ${coin}/USDT</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${sEmoji} <b>Overall: ${r.signal}</b>  |  ${convLabel}\n` +
        `Timeframe: <b>${r.timeframe.toUpperCase()}</b>  |  24h: <b>${chgSign}${r.chg24h.toFixed(2)}%</b>\n\n` +
        `💰 <b>Entry:</b> <code>$${fmtPrice(r.entry)}</code>\n` +
        `🛑 <b>SL:</b>    <code>$${fmtPrice(r.sl)}</code>    (${slDir}${r.slPct}%)\n` +
        `🎯 <b>TP1:</b>   <code>$${fmtPrice(r.tp1)}</code>   (${tpDir}${r.tp1Pct}%)\n` +
        `🎯 <b>TP2:</b>   <code>$${fmtPrice(r.tp2)}</code>   (${tpDir}${r.tp2Pct}%)\n` +
        `🎯 <b>TP3:</b>   <code>$${fmtPrice(r.tp3)}</code>   (${tpDir}${r.tp3Pct}%)\n\n` +
        (r.smcBadges?.length ? `🏛 <b>SMC Rules:</b>\n${r.smcBadges.map(b => e(b)).join('\n')}\n\n` : '') +
        `📊 <b>All Indicators:</b>\n${indicatorList}\n\n` +
        `<a href="${tvLink(r.symbol)}">📈 TradingView Chart</a>  |  ` +
        `<a href="${tradeLink(r.symbol)}">🔗 Trade Bitunix</a>\n` +
        `<i>${now()}</i>`;

      await tgSend(msg);

      // Cache latest signal for welcome message
      lastSignalSummary =
        `${isBuy ? '🟢' : '🔴'} <b>${r.signal} ${coin}/USDT</b> @ <code>$${fmtPrice(r.entry)}</code>\n` +
        `🎯 TP1: <code>$${fmtPrice(r.tp1)}</code>  🛑 SL: <code>$${fmtPrice(r.sl)}</code>\n` +
        `<i>${now()}</i>`;

      // Track this signal for TP/SL monitoring
      signalTracker.set(r.symbol, {
        signal:    r.signal,
        entry:     r.entry,
        tp1: r.tp1, tp2: r.tp2, tp3: r.tp3,
        sl:        r.sl,
        timeframe: r.timeframe,
        postedAt:  Date.now(),
        tpHit:     0,
        slHit:     false,
      });
    }

    log(`Trader: sent ${Math.min(results.length, 6)} signals · tracking ${signalTracker.size} active`);
  } catch (err) { log(`trader scan err (silent): ${err.message}`); }
  log('── Trader Scan end ──\n');
}

async function runSMCScan(forced = false) {
  log(`── SMC Scan start${forced ? ' (forced)' : ''} ──`);
  if (paused && !forced) { log('Paused.'); return; }

  try {
    const tickers = await fetchTickers();
    // Top 10 by volume
    const top10 = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 10);

    const smcResults = [];
    for (const ticker of top10) {
      try {
        // Use 4h klines for SMC (more reliable structure)
        const klines = await fetchKlines(ticker.symbol, '4h', 50);
        if (!klines || klines.length < 15) continue;

        const closes = klines.map(k => parseFloat(k[4]));
        const rsi    = calcRSI(closes);
        const ema9   = calcEMA(closes, 9);
        const ema21  = calcEMA(closes, 21);
        const lastPrice = parseFloat(ticker.lastPrice);

        const smc = detectSMC(klines);
        if (!smc) continue;

        smcResults.push({
          symbol: ticker.symbol,
          lastPrice,
          rsi: rsi.toFixed(0),
          ema9Above: ema9 > ema21,
          chg24h: parseFloat(ticker.priceChangePercent).toFixed(2),
          ...smc,
        });

        await sleep(100);
      } catch (_) {}
    }

    if (!smcResults.length) {
      if (forced) await tgSend(`🎯 <b>SMC Scan</b> — No clear SMC signals found in top 10 coins right now.`);
      log('SMC: no signals');
      return;
    }

    // Send one message per signal (more readable)
    for (const r of smcResults) {
      const coin     = r.symbol.replace('USDT', '');
      const signalEmoji = r.signal === 'BUY' ? '🟢' : '🔴';
      const zoneEmoji   = r.zone === 'discount' ? '💚 Discount (Good entry)' : r.zone === 'premium' ? '❤️ Premium (Caution)' : '🟡 Equilibrium';
      const emaStatus   = r.ema9Above ? '✅ EMA9 > EMA21' : '⚠️ EMA9 < EMA21';
      const rsiStatus   = parseInt(r.rsi) < 35 ? '🟢 Oversold' : parseInt(r.rsi) > 65 ? '🔴 Overbought' : '⚪ Neutral';
      const chgSign     = parseFloat(r.chg24h) >= 0 ? '+' : '';

      const msg =
        `🎯 <b>SMC Signal — ${coin}/USDT</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${signalEmoji} <b>Signal: ${r.structure} → ${r.signal}</b>\n` +
        `Zone: ${zoneEmoji}\n\n` +
        `💰 <b>Entry:</b> <code>$${fmtPrice(r.entry)}</code>\n` +
        `🛑 <b>SL:</b> <code>$${fmtPrice(r.sl)}</code> (-${r.slPct}%)\n` +
        `🎯 <b>TP1:</b> <code>$${fmtPrice(r.tp1)}</code> (+${r.tp1Pct}%)\n` +
        `🎯 <b>TP2:</b> <code>$${fmtPrice(r.tp2)}</code> (+${r.tp2Pct}%)\n\n` +
        `📈 <b>Indicators:</b>\n` +
        `• RSI(14): <b>${r.rsi}</b> ${rsiStatus}\n` +
        `• ${emaStatus}\n` +
        `• 24h Change: <b>${chgSign}${r.chg24h}%</b>\n` +
        `• Swing High: <code>$${fmtPrice(r.swingHigh)}</code>\n` +
        `• Swing Low: <code>$${fmtPrice(r.swingLow)}</code>\n\n` +
        `📊 <a href="${tvLink(r.symbol)}">TradingView Chart</a>  |  ` +
        `🔗 <a href="${tradeLink(r.symbol)}">Trade on Bitunix</a>\n` +
        `<i>Price: $${fmtPrice(r.lastPrice)} · Scan: ${now()}</i>`;

      await tgSend(msg);
      await sleep(500);
    }

    log(`SMC: sent ${smcResults.length} signals`);
  } catch (err) { log(`SMC scan err (silent): ${err.message}`); }
  log('── SMC Scan end ──\n');
}

// ── START ────────────────────────────────────────────────────
async function start() {
  log('===================================');
  log('  Crypto Signal Scanner Starting');
  log(`  Interval: ${INTERVAL_MIN} min | Top ${TOP_COINS} coins`);
  log('===================================');

  await tgSend(
    `🤖 <b>Crypto Signal Bot Online — ${now()}</b>\n\n` +
    `📊 Signal scan: top <b>${TOP_COINS}</b> coins every <b>${INTERVAL_MIN} min</b>\n` +
    `⚡ Spike alert: ±3% in 1 min (checked every 1 min)\n` +
    `Signals: 🟢🟢 Strong Buy · 🟢 Buy · ⚪ Neutral · 🔴 Sell · 🔴🔴 Strong Sell\n` +
    `Tap any coin name to open Bitunix and trade\n\n` +
    `<b>Commands:</b>\n` +
    `/scan — scan now\n` +
    `/pause — pause all\n` +
    `/resume — resume\n` +
    `/help — all commands\n\n` +
    `🎯 /smc — SMC signals (CHoCH, BMS, SMS + Entry/SL/TP)\n` +
    `🧠 /trader — Trader signals (CryptoNinjas/LuxAlgo/AltFINS style)\n\n` +
    `Running 24/7 on Render ✅`
  );

  await runScan();
  await sleep(3000);
  await runSMCScan();    // initial SMC scan alongside regular scan
  await sleep(3000);
  await runTraderScan(); // initial trader scan

  setInterval(pollCommands, 5000);
  setInterval(() => runScan(),              INTERVAL_MIN * 60 * 1000);
  setInterval(() => runSMCScan(),           INTERVAL_MIN * 60 * 1000);
  setInterval(() => runTraderScan(),        INTERVAL_MIN * 60 * 1000);
  setInterval(() => checkSpikes(),          SPIKE_INTERVAL);
  setInterval(() => checkSignalTargets(),   3 * 60 * 1000); // check TP/SL every 3 min

  // ── AUTO TRADER (cycle.js) ──────────────────────────────────
  log(`Auto trader: first run in 60s, then every ${TRADE_INTERVAL_MIN} min`);
  setTimeout(async () => {
    await runTrader().catch(e => log(`Trader cycle error: ${e.message}`));
    setInterval(() => runTrader().catch(e => log(`Trader cycle error: ${e.message}`)),
      TRADE_INTERVAL_MIN * 60 * 1000);
  }, 60 * 1000); // wait 60s after startup before first trade cycle
}

start().catch(err => {
  console.error('Fatal (no TG alert):', err.message);
  process.exit(1);
});
