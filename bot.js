// ==========================================================
// Crypto Signal Scanner — Render.com (24/7)
// Binance Futures public API — zero credentials needed
// Signals: Strong Buy / Buy / Neutral / Sell / Strong Sell
// ⚡ 5-min spike alert: ±5% in 5 min
// Bitunix trade link per coin (HTML mode for clickable links)
// Telegram: /scan /pause /resume /help
// ==========================================================

const fetch = require('node-fetch');

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;
const INTERVAL_MIN    = parseInt(process.env.INTERVAL_MIN || '30');
const TOP_COINS       = 40;
const REQUEST_TIMEOUT = 30000;

console.log(`[BOOT] Telegram:${!!TELEGRAM_TOKEN} Chat:${TELEGRAM_CHAT} Interval:${INTERVAL_MIN}min`);

let paused       = false;
let lastUpdateId = 0;

const spikeCooldown   = new Map();
const SPIKE_COOLDOWN  = 10 * 60 * 1000; // 10 min per coin

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

// ── BINANCE PUBLIC API ────────────────────────────────────────
async function fetchTickers() {
  const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: REQUEST_TIMEOUT });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchKlines(symbol, interval = '1h', limit = 30) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { timeout: REQUEST_TIMEOUT });
  if (!res.ok) return null;
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
async function tgSend(html) {
  log(`TG: ${html.replace(/<[^>]+>/g, '').substring(0, 80)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:                  TELEGRAM_CHAT,
        text:                     html,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      }),
      timeout: REQUEST_TIMEOUT,
    });
  } catch(err) { log(`tgSend err: ${err.message}`); }
}

// ── COMMAND HANDLER ──────────────────────────────────────────
async function handleCommand(text) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  if (cmd === '/help' || cmd === 'help') {
    await tgSend(
      `🤖 <b>Crypto Signal Bot</b>\n\n` +
      `/scan — Force signal scan now\n` +
      `/pause — Pause auto scan\n` +
      `/resume — Resume auto scan\n` +
      `/help — Show this menu\n\n` +
      `<i>Auto scan every ${INTERVAL_MIN} min</i>`
    );
  } else if (cmd === '/pause' || cmd === 'pause') {
    paused = true;
    await tgSend(`⏸ <b>Bot Paused</b>\nSend /resume to restart.`);
  } else if (cmd === '/resume' || cmd === 'resume') {
    paused = false;
    await tgSend(`▶️ <b>Bot Resumed</b>\nNext scan in ≤${INTERVAL_MIN} min.`);
  } else if (cmd === '/scan' || cmd === 'scan') {
    await tgSend(`🔍 <b>Scanning top ${TOP_COINS} coins...</b>`);
    await runScan(true);
  } else {
    await tgSend(`❓ Unknown: <code>${e(text)}</code>\nSend /help for commands.`);
  }
}

// ── TELEGRAM POLL ────────────────────────────────────────────
async function pollCommands() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const res  = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`,
      { timeout: 8000 }
    );
    const data = await res.json();
    for (const u of (data.result || [])) {
      lastUpdateId = u.update_id;
      const msg = u.message;
      if (!msg?.text) continue;
      if (String(msg.chat.id) !== String(TELEGRAM_CHAT)) continue;
      log(`CMD: ${msg.text}`);
      await handleCommand(msg.text);
    }
  } catch(err) { log(`poll err: ${err.message}`); }
}

// ── 5-MIN SPIKE ALERT ────────────────────────────────────────
async function checkSpikes() {
  if (paused) return;
  try {
    const tickers = await fetchTickers();
    const top = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 60);

    const now_ts = Date.now();
    const alerts = [];

    const BATCH = 8;
    for (let i = 0; i < top.length; i += BATCH) {
      await Promise.all(top.slice(i, i + BATCH).map(async t => {
        try {
          const klines = await fetchKlines(t.symbol, '5m', 3);
          if (!klines || klines.length < 2) return;
          const open  = parseFloat(klines[0][1]);
          const close = parseFloat(klines[klines.length - 1][4]);
          if (!open || open === 0) return;
          const pct = ((close - open) / open) * 100;
          if (Math.abs(pct) < 5) return;
          if (now_ts - (spikeCooldown.get(t.symbol) || 0) < SPIKE_COOLDOWN) return;
          spikeCooldown.set(t.symbol, now_ts);
          alerts.push({ symbol: t.symbol, pct, price: close });
        } catch(_) {}
      }));
      await sleep(150);
    }

    alerts.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    for (const a of alerts.slice(0, 5)) {
      const coin = a.symbol.replace('USDT', '');
      const dir  = a.pct > 0 ? '🚀 PUMP' : '📉 DUMP';
      const sign = a.pct > 0 ? '+' : '';
      await tgSend(
        `⚡ <b>5-Min Spike — ${now()}</b>\n\n` +
        `${dir}: <a href="${tradeLink(a.symbol)}">${coin}/USDT</a>\n` +
        `Move: <b>${sign}${a.pct.toFixed(2)}%</b> in 5 min\n` +
        `Price: <code>$${fmtPrice(a.price)}</code>`
      );
    }
    if (alerts.length) log(`Spike alerts: ${alerts.length}`);
  } catch(err) { log(`spike err: ${err.message}`); }
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

  } catch(err) { log(`scan err: ${err.message}`); }
  log('── Scan end ──\n');
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
    `⚡ Spike alert: ±5% in 5 min (checked every 5 min)\n` +
    `Signals: 🟢🟢 Strong Buy · 🟢 Buy · ⚪ Neutral · 🔴 Sell · 🔴🔴 Strong Sell\n` +
    `Tap any coin name to open Bitunix and trade\n\n` +
    `<b>Commands:</b>\n` +
    `/scan — scan now\n` +
    `/pause — pause all\n` +
    `/resume — resume\n` +
    `/help — all commands\n\n` +
    `Running 24/7 on Render ✅`
  );

  await runScan();

  setInterval(pollCommands, 5000);
  setInterval(() => runScan(), INTERVAL_MIN * 60 * 1000);
  setInterval(() => checkSpikes(), 5 * 60 * 1000);
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
