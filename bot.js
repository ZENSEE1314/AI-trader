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
const SPIKE_COOLDOWN  = 2 * 60 * 1000;  // 2 min cooldown per coin (was 10 min)
const SPIKE_PCT       = 3;              // alert threshold: ±3% in 1 min
const SPIKE_INTERVAL  = 60 * 1000;     // check every 1 min

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
      `/smc — SMC signal scan (top 10 coins, 4H)\n` +
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
  } else if (cmd === '/smc' || cmd === 'smc') {
    await tgSend(`🎯 <b>SMC Scan — Top 10 coins (4H structure)...</b>`);
    await runSMCScan(true);
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

// ── 1-MIN SPIKE ALERT (±3%) ──────────────────────────────────
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
  } catch (err) { log(`SMC scan err: ${err.message}`); }
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
    `🎯 /smc — SMC signal scan (CHoCH, BMS, SMS + Entry/SL/TP)\n\n` +
    `Running 24/7 on Render ✅`
  );

  await runScan();
  await sleep(3000);
  await runSMCScan(); // initial SMC scan alongside regular scan

  setInterval(pollCommands, 5000);
  setInterval(() => runScan(), INTERVAL_MIN * 60 * 1000);
  setInterval(() => runSMCScan(), INTERVAL_MIN * 60 * 1000); // SMC runs same interval
  setInterval(() => checkSpikes(), SPIKE_INTERVAL); // every 1 min
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
