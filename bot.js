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
          await tgSend(`🚫 <b>Binance IP Banned</b>\nBot paused for <b>${mins} min</b>.\nResumes automatically at ${new Date(until).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' })}`);
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

async function tgSend(html) {
  log(`TG: ${html.replace(/<[^>]+>/g, '').substring(0, 80)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  await Promise.all(TELEGRAM_CHATS.map(id => tgSendTo(id, html)));
}

// ── COMMAND HANDLER ──────────────────────────────────────────
async function handleCommand(text, fromChatId) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  if (cmd === '/testchat' || cmd === 'testchat') {
    await testChats(fromChatId);
  } else if (cmd === '/help' || cmd === 'help') {
    await tgSend(
      `🤖 <b>Crypto Signal Bot</b>\n\n` +
      `/scan — Force signal scan now\n` +
      `/smc — SMC signal scan (top 10 coins, 4H)\n` +
      `/trader — Trader-style signals (CryptoNinjas/LuxAlgo/AltFINS)\n` +
      `/pause — Pause auto scan\n` +
      `/resume — Resume auto scan\n` +
      `/testchat — Test all configured chat IDs\n` +
      `/help — Show this menu\n\n` +
      `<i>Auto scan every ${INTERVAL_MIN} min</i>`
    );
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
    await tgSend(`❓ Unknown: <code>${e(text)}</code>\nSend /help for commands.`);
  }
}

// ── TELEGRAM POLL ────────────────────────────────────────────
async function pollCommands() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
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
      if (!TELEGRAM_CHATS.includes(String(msg.chat.id))) continue;
      log(`CMD: ${msg.text}`);
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
  // We use the last 30 bars to detect structure
  // Swing highs/lows based on 5-bar pivot
  const n = klines.length;
  if (n < 15) return null;

  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));

  // Find swing highs/lows (simple 3-bar pivot)
  const swingHighs = [];
  const swingLows  = [];
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      swingHighs.push({ idx: i, val: highs[i] });
    }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      swingLows.push({ idx: i, val: lows[i] });
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  const lastClose = closes[n - 1];
  const prevClose = closes[n - 2];

  // Last 2 swing highs and lows
  const sh1 = swingHighs[swingHighs.length - 1]; // most recent swing high
  const sh2 = swingHighs[swingHighs.length - 2]; // previous swing high
  const sl1 = swingLows[swingLows.length - 1];   // most recent swing low
  const sl2 = swingLows[swingLows.length - 2];   // previous swing low

  // Structure range (current)
  const rangeHigh = sh1.val;
  const rangeLow  = sl1.val;
  const rangeSize = rangeHigh - rangeLow;

  // Premium/Discount zones (top/bottom 25% of range)
  const premiumTop    = rangeHigh;
  const premiumBot    = rangeHigh - rangeSize * 0.25;
  const discountTop   = rangeLow  + rangeSize * 0.25;
  const discountBot   = rangeLow;
  const equilibrium   = rangeLow  + rangeSize * 0.5;

  // Zone classification
  let zone = 'equilibrium';
  if (lastClose >= premiumBot) zone = 'premium';
  else if (lastClose <= discountTop) zone = 'discount';

  // CHoCH: price breaks ABOVE previous swing high (bullish reversal)
  //         or BELOW previous swing low (bearish reversal)
  let signal    = null;
  let structure = null;

  // Bullish CHoCH: last close breaks above sh2 (older high) after being bearish
  if (lastClose > sh2.val && prevClose <= sh2.val) {
    signal    = 'BUY';
    structure = 'CHoCH';
  }
  // Bearish CHoCH: last close breaks below sl2 (older low) after being bullish
  else if (lastClose < sl2.val && prevClose >= sl2.val) {
    signal    = 'SELL';
    structure = 'CHoCH';
  }
  // BMS (Break of Market Structure) — continuation
  else if (lastClose > sh1.val && sh1.val > sh2.val) {
    signal    = 'BUY';
    structure = 'BMS';
  }
  else if (lastClose < sl1.val && sl1.val < sl2.val) {
    signal    = 'SELL';
    structure = 'BMS';
  }
  // SMS (Shift of Market Structure) — first break
  else if (lastClose > sh1.val && sh1.val <= sh2.val) {
    signal    = 'BUY';
    structure = 'SMS';
  }
  else if (lastClose < sl1.val && sl1.val >= sl2.val) {
    signal    = 'SELL';
    structure = 'SMS';
  }

  if (!signal) return null;

  const atr = calcATR(klines, 14) || rangeSize * 0.02;

  // Entry, SL, TP calculation
  let entry, sl, tp1, tp2;
  if (signal === 'BUY') {
    entry = zone === 'discount' ? lastClose : discountTop; // ideal entry in discount
    sl    = sl1.val - atr * 0.5;                           // below last swing low + buffer
    tp1   = entry + (entry - sl) * 1.5;                   // 1.5R
    tp2   = entry + (entry - sl) * 2.5;                   // 2.5R
  } else {
    entry = zone === 'premium' ? lastClose : premiumBot;   // ideal entry in premium
    sl    = sh1.val + atr * 0.5;                           // above last swing high + buffer
    tp1   = entry - (sl - entry) * 1.5;                   // 1.5R
    tp2   = entry - (sl - entry) * 2.5;                   // 2.5R
  }

  const slPct  = ((Math.abs(entry - sl)  / entry) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1 - entry) / entry) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2 - entry) / entry) * 100).toFixed(2);

  return {
    signal, structure, zone,
    entry, sl, tp1, tp2,
    slPct, tp1Pct, tp2Pct,
    swingHigh: sh1.val, swingLow: sl1.val,
    premiumTop, premiumBot, discountTop, discountBot, equilibrium,
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

    // SMC bonus row
    if (smc) {
      if (smc.signal === 'BUY')  { buyScore  += 3; rows.unshift({ name: 'SMC Structure', verdict: `🟢 ${smc.structure} → BUY (zone: ${smc.zone})`, source: 'Smart Money Concepts' }); }
      if (smc.signal === 'SELL') { sellScore += 3; rows.unshift({ name: 'SMC Structure', verdict: `🔴 ${smc.structure} → SELL (zone: ${smc.zone})`, source: 'Smart Money Concepts' }); }
    } else {
      rows.unshift({ name: 'SMC Structure', verdict: '⚪ No clear structure break', source: 'Smart Money Concepts' });
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

const traderCooldown = new Map();
const TRADER_COOLDOWN = 60 * 60 * 1000; // 1 hour per coin

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
      if (r) {
        results.push(r);
        traderCooldown.set(ticker.symbol, now_ts);
      }
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
        `📊 <b>All Indicators:</b>\n${indicatorList}\n\n` +
        `<a href="${tvLink(r.symbol)}">📈 TradingView Chart</a>  |  ` +
        `<a href="${tradeLink(r.symbol)}">🔗 Trade Bitunix</a>\n` +
        `<i>${now()}</i>`;

      await tgSend(msg);
      await sleep(400);
    }

    log(`Trader: sent ${Math.min(results.length, 6)} signals`);
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
  setInterval(() => runScan(),        INTERVAL_MIN * 60 * 1000);
  setInterval(() => runSMCScan(),     INTERVAL_MIN * 60 * 1000);
  setInterval(() => runTraderScan(),  INTERVAL_MIN * 60 * 1000);
  setInterval(() => checkSpikes(),    SPIKE_INTERVAL);

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
