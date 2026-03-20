// ============================================================
// Bitunix Market Scanner Bot v3 — Render.com (24/7 persistent)
// ⚡ Spike: detects ±5% move in ~3 min using 1m candles
// 🧠 SMC:   BOS/CHoCH + Order Block + FVG + Premium/Discount
// Telegram: /scan /smc /smc SYMBOL /chart SYMBOL /pause /resume /help
// ============================================================

const fetch = require('node-fetch');
const { createCanvas } = require('canvas');
const fs   = require('fs');
const path = require('path');
const FormData = require('form-data');

// ── CONFIG ────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const INTERVAL_MIN   = parseInt(process.env.INTERVAL_MIN || '10');

const BITUNIX_BASE   = 'https://fapi.bitunix.com';

const ALERT_MOVE_PCT  = 5.0;
const SL_PCT          = 0.008;
const TP_PCT          = 0.03;
const POSITION_USDT   = 1000;
const KLINE_LIMIT     = 5;
const REQUEST_TIMEOUT = 10000;

// SMC config
const SMC_TOP_COINS    = 40;
const SMC_INTERVAL_MIN = 30;
const smcCooldown      = new Map(); // sym -> last alert ts
const SMC_COOLDOWN_MS  = 60 * 60 * 1000; // 1 hour cooldown per coin

console.log(`[BOOT] Telegram: ${!!TELEGRAM_TOKEN} | Chat: ${TELEGRAM_CHAT} | Interval: ${INTERVAL_MIN}min`);

// ── STATE ─────────────────────────────────────────────────────
let paused       = false;
let lastUpdateId = 0;

// ── HELPERS ───────────────────────────────────────────────────
function now() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}
function log(msg) { console.log(`[${now()}] ${msg}`); }

function fmtPrice(p) {
  if (p === null || p === undefined || isNaN(p)) return 'N/A';
  if (p >= 1000)  return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.01)  return p.toFixed(6);
  return p.toFixed(8);
}

function normSymbol(sym) {
  if (!sym) return 'UNKNOWN';
  const s = sym.toUpperCase().replace(/-/g,'').replace(/_/g,'');
  if (s.endsWith('USDT')) return s.slice(0, -4) + '/USDT';
  return s;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── BITUNIX API ───────────────────────────────────────────────
async function fetchAllSymbols() {
  const url = `${BITUNIX_BASE}/fapi/v1/ticker/price`;
  const res  = await fetch(url, { timeout: REQUEST_TIMEOUT });
  if (!res.ok) throw new Error(`fetchAllSymbols HTTP ${res.status}`);
  const data = await res.json();
  let items = Array.isArray(data) ? data : (data.data || data.result || []);
  return items
    .map(i => i.symbol || i.s || i.contract)
    .filter(s => s && s.toUpperCase().endsWith('USDT'));
}

async function fetch1mKlines(symbol, limit) {
  const url = `${BITUNIX_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${limit || KLINE_LIMIT}`;
  const res  = await fetch(url, { timeout: REQUEST_TIMEOUT });
  if (!res.ok) return null;
  const data = await res.json();
  let kl = Array.isArray(data) ? data
    : Array.isArray(data.data)  ? data.data
    : Array.isArray(data.result)? data.result
    : null;
  if (!kl || kl.length < 4) return null;
  return kl;
}

async function fetch1hKlines(symbol, limit) {
  const url = `${BITUNIX_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit || 60}`;
  const res  = await fetch(url, { timeout: REQUEST_TIMEOUT });
  if (!res.ok) throw new Error(`fetch1hKlines HTTP ${res.status}`);
  const data = await res.json();
  let kl = Array.isArray(data) ? data
    : Array.isArray(data.data)  ? data.data
    : Array.isArray(data.result)? data.result
    : null;
  if (!kl || kl.length < 2) throw new Error('Not enough 1H candles');
  return kl;
}

// Generic klines fetch (any interval)
async function fetchKlines(symbol, interval, limit) {
  const url = `${BITUNIX_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { timeout: REQUEST_TIMEOUT });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data
    : Array.isArray(data.data)   ? data.data
    : Array.isArray(data.result) ? data.result
    : null;
}

// Get top N symbols sorted by 24h volume (fallback: all symbols)
async function getTopSymbols(n) {
  try {
    const res  = await fetch(`${BITUNIX_BASE}/fapi/v1/ticker/24hr`, { timeout: REQUEST_TIMEOUT });
    if (res.ok) {
      const data  = await res.json();
      const items = Array.isArray(data) ? data : (data.data || data.result || []);
      if (items.length) {
        return items
          .filter(t => (t.symbol || t.s || '').toUpperCase().endsWith('USDT'))
          .sort((a, b) => parseFloat(b.quoteVolume || b.vol || 0) - parseFloat(a.quoteVolume || a.vol || 0))
          .slice(0, n)
          .map(t => t.symbol || t.s);
      }
    }
  } catch(_) {}
  const syms = await fetchAllSymbols();
  return syms.slice(0, n);
}

function getOpen(k)  { return parseFloat(Array.isArray(k) ? k[1] : (k.open  || k.o || k[1])); }
function getHigh(k)  { return parseFloat(Array.isArray(k) ? k[2] : (k.high  || k.h || k[2])); }
function getLow(k)   { return parseFloat(Array.isArray(k) ? k[3] : (k.low   || k.l || k[3])); }
function getClose(k) { return parseFloat(Array.isArray(k) ? k[4] : (k.close || k.c || k[4])); }
function getTime(k)  { return parseInt(Array.isArray(k)   ? k[0] : (k.openTime || k.t || k[0])); }

function compute3MinMove(klines) {
  const c0 = getClose(klines[0]);
  const cN = getClose(klines[klines.length - 1]);
  if (!c0 || !cN || isNaN(c0) || isNaN(cN) || c0 <= 0) return { movePct: null, lastPrice: null };
  return { movePct: (cN / c0 - 1) * 100, lastPrice: cN };
}

function tradeLevels(side, entry) {
  return side === 'LONG'
    ? { sl: entry * (1 - SL_PCT), tp: entry * (1 + TP_PCT) }
    : { sl: entry * (1 + SL_PCT), tp: entry * (1 - TP_PCT) };
}

// ── SMC ANALYSIS ─────────────────────────────────────────────
// Find swing highs & lows (needs `left` candles on each side to confirm)
function findSwings(klines, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < klines.length - right; i++) {
    const h = getHigh(klines[i]);
    const l = getLow(klines[i]);
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (getHigh(klines[j]) >= h) isH = false;
      if (getLow(klines[j])  <= l) isL = false;
    }
    if (isH) highs.push({ idx: i, price: h });
    if (isL) lows.push({ idx: i, price: l });
  }
  return { highs, lows };
}

// Detect market structure: trend + BOS or CHoCH signal
function detectStructure(klines) {
  const { highs, lows } = findSwings(klines, 3, 3);
  if (highs.length < 2 || lows.length < 2) return null;

  const sh1 = highs[highs.length - 2], sh2 = highs[highs.length - 1];
  const sl1 = lows[lows.length - 2],   sl2 = lows[lows.length - 1];

  // Determine prior trend from HH/HL or LH/LL pattern
  let trend = 'ranging';
  if (sh2.price > sh1.price && sl2.price > sl1.price) trend = 'bullish';
  else if (sh2.price < sh1.price && sl2.price < sl1.price) trend = 'bearish';

  // Look for a break of structure in the last 5 candles
  let signal = null, signalLevel = null, signalType = null;
  const from = Math.max(1, klines.length - 5);
  for (let i = from; i < klines.length && !signal; i++) {
    const c  = getClose(klines[i]);
    const pC = getClose(klines[i - 1]);
    if (c > sh2.price && pC <= sh2.price) {
      signal = 'bullish'; signalLevel = sh2.price;
      signalType = trend === 'bearish' ? 'CHoCH' : 'BOS';
    } else if (c < sl2.price && pC >= sl2.price) {
      signal = 'bearish'; signalLevel = sl2.price;
      signalType = trend === 'bullish' ? 'CHoCH' : 'BOS';
    }
  }
  return { trend, signal, signalLevel, signalType, sh2, sl2 };
}

// Order Blocks — last opposite candle before an impulsive move
function detectOrderBlocks(klines) {
  const obs = [], n = klines.length;
  for (let i = 1; i < n - 3; i++) {
    const o = getOpen(klines[i]), c = getClose(klines[i]);
    if (c < o) { // bearish candle → potential bullish OB
      const upMove = (getClose(klines[Math.min(i + 3, n - 1)]) - c) / c * 100;
      if (upMove > 0.5) obs.push({ type: 'bullish', top: o, bottom: c, idx: i });
    }
    if (c > o) { // bullish candle → potential bearish OB
      const downMove = (c - getClose(klines[Math.min(i + 3, n - 1)])) / c * 100;
      if (downMove > 0.5) obs.push({ type: 'bearish', top: c, bottom: o, idx: i });
    }
  }
  return obs.slice(-6);
}

// Fair Value Gaps — imbalance between 3 consecutive candles
function detectFVG(klines) {
  const fvgs = [];
  for (let i = 2; i < klines.length; i++) {
    const h0 = getHigh(klines[i - 2]), l0 = getLow(klines[i - 2]);
    const h2 = getHigh(klines[i]),     l2 = getLow(klines[i]);
    if (l2 > h0) fvgs.push({ type: 'bullish', top: l2, bottom: h0, idx: i });
    if (h2 < l0) fvgs.push({ type: 'bearish', top: l0, bottom: h2, idx: i });
  }
  return fvgs.slice(-8);
}

// Check if price is near or inside a zone
function nearZone(price, top, bottom, tolPct = 0.5) {
  const tol = price * tolPct / 100;
  return price >= bottom - tol && price <= top + tol;
}

// Full SMC analysis for one symbol (1H structure + 15m FVG)
async function analyzeSMC(symbol) {
  try {
    const klines1h  = await fetchKlines(symbol, '1h',  60);
    const klines15m = await fetchKlines(symbol, '15m', 60);
    if (!klines1h || klines1h.length < 20) return null;
    if (!klines15m || klines15m.length < 20) return null;

    const lastPrice = getClose(klines1h[klines1h.length - 1]);
    if (!lastPrice || isNaN(lastPrice) || lastPrice <= 0) return null;

    const struct = detectStructure(klines1h);
    if (!struct || !struct.signal) return null;

    const obs1h   = detectOrderBlocks(klines1h);
    const fvgs15m = detectFVG(klines15m);

    // Premium / Discount zone (last 20 candles range)
    const recent     = klines1h.slice(-20);
    const rangeHigh  = Math.max(...recent.map(k => getHigh(k)));
    const rangeLow   = Math.min(...recent.map(k => getLow(k)));
    const rangeEQ    = (rangeHigh + rangeLow) / 2;
    const premiumPct = ((lastPrice - rangeLow) / (rangeHigh - rangeLow) * 100);
    const inDiscount = lastPrice <= rangeEQ;
    const inPremium  = lastPrice > rangeEQ;

    // Confluence scoring
    let score = 0;
    const confluence = [];
    let direction = null;

    if (struct.signal === 'bullish') {
      direction = 'LONG';
      score += struct.signalType === 'CHoCH' ? 3 : 1;
      confluence.push(`${struct.signalType} Bullish (1H)`);
      const bOBs  = obs1h.filter(ob  => ob.type === 'bullish' && nearZone(lastPrice, ob.top, ob.bottom));
      const bFVGs = fvgs15m.filter(fvg => fvg.type === 'bullish' && nearZone(lastPrice, fvg.top, fvg.bottom, 1));
      if (bOBs.length)  { score += 2; confluence.push(`Bullish OB (1H)`); }
      if (bFVGs.length) { score += 1; confluence.push(`Bullish FVG (15m)`); }
      if (inDiscount)   { score += 1; confluence.push(`Discount Zone ${premiumPct.toFixed(0)}%`); }
      else              { confluence.push(`⚠️ Premium Zone — wait for pullback`); }
    } else {
      direction = 'SHORT';
      score += struct.signalType === 'CHoCH' ? 3 : 1;
      confluence.push(`${struct.signalType} Bearish (1H)`);
      const bearOBs  = obs1h.filter(ob  => ob.type === 'bearish' && nearZone(lastPrice, ob.top, ob.bottom));
      const bearFVGs = fvgs15m.filter(fvg => fvg.type === 'bearish' && nearZone(lastPrice, fvg.top, fvg.bottom, 1));
      if (bearOBs.length)  { score += 2; confluence.push(`Bearish OB (1H)`); }
      if (bearFVGs.length) { score += 1; confluence.push(`Bearish FVG (15m)`); }
      if (inPremium)       { score += 1; confluence.push(`Premium Zone ${premiumPct.toFixed(0)}%`); }
      else                 { confluence.push(`⚠️ Discount Zone — wait for rally`); }
    }

    // Minimum score: 3 = CHoCH alone, 3 = BOS + OB, 4 = BOS + OB + zone
    if (score < 3) return null;

    // SL/TP from structure swing levels
    let sl, tp;
    if (direction === 'LONG') {
      sl = struct.sl2.price * 0.998;
      tp = struct.sh2.price * 1.002;
      if (sl >= lastPrice) sl = lastPrice * (1 - SL_PCT);
      if (tp <= lastPrice) tp = lastPrice * (1 + TP_PCT);
    } else {
      sl = struct.sh2.price * 1.002;
      tp = struct.sl2.price * 0.998;
      if (sl <= lastPrice) sl = lastPrice * (1 + SL_PCT);
      if (tp >= lastPrice) tp = lastPrice * (1 - TP_PCT);
    }

    return { symbol, direction, lastPrice, trend: struct.trend, signalType: struct.signalType, confluence, score, sl, tp };
  } catch(_) { return null; }
}

// Run SMC scan over top N coins
async function runSMCScan(forced = false) {
  log(`── SMC Scan start${forced ? ' (forced)' : ''} ──`);
  if (paused && !forced) { log('Paused.'); return; }
  try {
    const symbols = await getTopSymbols(SMC_TOP_COINS);
    log(`SMC scanning ${symbols.length} coins...`);

    const now_ts = Date.now();
    const signals = [];
    const BATCH   = 5;
    for (let i = 0; i < symbols.length; i += BATCH) {
      const results = await Promise.all(symbols.slice(i, i + BATCH).map(s => analyzeSMC(s)));
      for (const r of results) {
        if (!r) continue;
        if (now_ts - (smcCooldown.get(r.symbol) || 0) < SMC_COOLDOWN_MS) continue;
        signals.push(r);
      }
      await sleep(500);
    }

    log(`SMC signals: ${signals.length}`);
    if (!signals.length) {
      if (forced) await tgSend(
        `🧠 *SMC Scan — ${now()}*\n\nNo high-confluence setups in top ${SMC_TOP_COINS} coins.\n_Next scan in ${SMC_INTERVAL_MIN} min_`
      );
      return;
    }

    // CHoCH first, then by score
    signals.sort((a, b) => {
      const c = (s) => s.signalType === 'CHoCH' ? 1 : 0;
      return (c(b) - c(a)) || (b.score - a.score);
    });

    for (const s of signals.slice(0, 5)) {
      smcCooldown.set(s.symbol, now_ts);
      const dEmj = s.direction === 'LONG' ? '🟢' : '🔴';
      const tEmj = s.trend === 'bullish' ? '📈' : s.trend === 'bearish' ? '📉' : '➡️';
      await tgSend(
        `🧠 *SMC Signal — ${now()}*\n\n` +
        `${dEmj} *${normSymbol(s.symbol)} ${s.direction}*\n` +
        `Price: \`$${fmtPrice(s.lastPrice)}\`\n` +
        `Trend: ${tEmj} ${s.trend.toUpperCase()} | *${s.signalType}*  ⭐${s.score}\n\n` +
        `📋 *Confluence:*\n${s.confluence.map(c => `• ${c}`).join('\n')}\n\n` +
        `🛑 SL: \`$${fmtPrice(s.sl)}\`\n` +
        `🎯 TP: \`$${fmtPrice(s.tp)}\`\n\n` +
        `_/chart ${s.symbol} — see 1H candle_`
      );
    }
  } catch(e) {
    log(`SMC scan err: ${e.message}`);
    if (forced) await tgSend(`❌ *SMC Scan Error — ${now()}*\n\`${e.message}\``);
  }
  log('── SMC Scan end ──\n');
}

// ── 1H CHART RENDERER ─────────────────────────────────────────
function renderCandleChart(symbol, klines) {
  const W = 900, H = 500;
  const PAD = { top: 50, right: 85, bottom: 60, left: 15 };
  const CW  = W - PAD.left - PAD.right;
  const CH  = H - PAD.top  - PAD.bottom;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#131722';
  ctx.fillRect(0, 0, W, H);

  const candles   = klines.slice(-60);
  const allPrices = candles.flatMap(k => [getHigh(k), getLow(k)]);
  const minP      = Math.min(...allPrices);
  const maxP      = Math.max(...allPrices);
  const priceRng  = maxP - minP || 1;

  const xScale = i  => PAD.left + (i / (candles.length - 1)) * CW;
  const yScale = p  => PAD.top  + CH - ((p - minP) / priceRng) * CH;

  // Horizontal grid
  for (let i = 0; i <= 5; i++) {
    const y = PAD.top + (i / 5) * CH;
    ctx.strokeStyle = '#2a2e39';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    const price = maxP - (i / 5) * priceRng;
    ctx.fillStyle = '#787b86';
    ctx.font      = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(price), W - PAD.right + 5, y + 4);
  }

  // Vertical grid & time labels
  for (let i = 0; i < candles.length; i += 10) {
    const x = xScale(i);
    ctx.strokeStyle = '#2a2e39';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + CH); ctx.stroke();
    const d = new Date(getTime(candles[i]));
    ctx.fillStyle = '#787b86';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      `${d.getUTCHours().toString().padStart(2,'0')}:00`,
      x, PAD.top + CH + 18
    );
  }

  // Candle bodies & wicks
  const candleW = Math.max(3, Math.floor(CW / candles.length) - 2);
  candles.forEach((k, i) => {
    const o = getOpen(k), h = getHigh(k), l = getLow(k), c = getClose(k);
    const x   = xScale(i);
    const col = c >= o ? '#26a69a' : '#ef5350';

    ctx.strokeStyle = col;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, yScale(h));
    ctx.lineTo(x, yScale(l));
    ctx.stroke();

    const bodyTop = yScale(Math.max(o, c));
    const bodyBot = yScale(Math.min(o, c));
    const bodyH   = Math.max(1, bodyBot - bodyTop);
    ctx.fillStyle = col;
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
  });

  // Current price dashed line
  const lastClose = getClose(candles[candles.length - 1]);
  const priceY    = yScale(lastClose);
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#f0b90b';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(PAD.left, priceY); ctx.lineTo(W - PAD.right, priceY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle  = '#f0b90b';
  ctx.font       = 'bold 11px monospace';
  ctx.textAlign  = 'left';
  ctx.fillText(`► ${fmtPrice(lastClose)}`, W - PAD.right + 5, priceY + 4);

  // Title
  ctx.fillStyle = '#d1d4dc';
  ctx.font      = 'bold 16px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${normSymbol(symbol)}  1H Candle`, PAD.left + 4, 32);
  ctx.fillStyle = '#787b86';
  ctx.font      = '11px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${now()} WIB`, W - PAD.right, 32);

  const outPath = path.join('/tmp', `chart_${symbol}_${Date.now()}.png`);
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

// ── TELEGRAM ──────────────────────────────────────────────────
async function tgSend(text) {
  log(`TG: ${text.replace(/\*/g,'').replace(/`/g,'').substring(0, 100)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'Markdown' }),
      timeout: REQUEST_TIMEOUT,
    });
  } catch(e) { log(`tgSend err: ${e.message}`); }
}

async function tgSendPhoto(imgPath, caption) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT);
    form.append('caption', caption || '');
    form.append('parse_mode', 'Markdown');
    form.append('photo', fs.createReadStream(imgPath), {
      filename:    path.basename(imgPath),
      contentType: 'image/png',
    });
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
      method:  'POST',
      body:    form,
      headers: form.getHeaders(),
      timeout: 20000,
    });
    try { fs.unlinkSync(imgPath); } catch(_) {}
  } catch(e) { log(`tgSendPhoto err: ${e.message}`); }
}

// ── COMMAND HANDLER ───────────────────────────────────────────
async function handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  if (cmd === '/help' || cmd === 'help') {
    await tgSend(
      `🤖 *Bitunix Scanner Bot v3*\n\n` +
      `/scan — Force 3-min spike scan now\n` +
      `/smc — SMC scan top ${SMC_TOP_COINS} coins\n` +
      `/smc BTCUSDT — SMC analysis for one coin\n` +
      `/chart BTCUSDT — 1H candle chart\n` +
      `/pause — Pause auto scanning\n` +
      `/resume — Resume auto scanning\n` +
      `/help — Show this menu\n\n` +
      `_Spike: every ${INTERVAL_MIN} min | SMC: every ${SMC_INTERVAL_MIN} min_`
    );

  } else if (cmd === '/pause' || cmd === 'pause') {
    paused = true;
    await tgSend(`⏸ *Bot Paused*\nSend /resume to restart scanning.`);

  } else if (cmd === '/resume' || cmd === 'resume') {
    paused = false;
    await tgSend(`▶️ *Bot Resumed*\nNext scan ≤ ${INTERVAL_MIN} min.`);

  } else if (cmd === '/scan' || cmd === 'scan') {
    await tgSend(`🔍 *Forcing scan now...*`);
    await runScan(true);

  } else if (cmd === '/smc') {
    const sym = parts[1]?.toUpperCase().replace('/', '');
    if (sym) {
      await tgSend(`🧠 Analyzing SMC for *${normSymbol(sym)}*...`);
      try {
        const result = await analyzeSMC(sym);
        if (!result) {
          await tgSend(
            `🧠 *SMC — ${normSymbol(sym)}*\n\n` +
            `No valid BOS/CHoCH signal right now.\n` +
            `_Try: /chart ${sym}_`
          );
        } else {
          const dEmj = result.direction === 'LONG' ? '🟢' : '🔴';
          const tEmj = result.trend === 'bullish' ? '📈' : result.trend === 'bearish' ? '📉' : '➡️';
          await tgSend(
            `🧠 *SMC — ${normSymbol(sym)} — ${now()}*\n\n` +
            `${dEmj} *${result.direction}*\n` +
            `Price: \`$${fmtPrice(result.lastPrice)}\`\n` +
            `Trend: ${tEmj} ${result.trend.toUpperCase()} | *${result.signalType}*  ⭐${result.score}\n\n` +
            `📋 *Confluence:*\n${result.confluence.map(c => `• ${c}`).join('\n')}\n\n` +
            `🛑 SL: \`$${fmtPrice(result.sl)}\`\n` +
            `🎯 TP: \`$${fmtPrice(result.tp)}\`\n\n` +
            `_/chart ${sym} — see 1H candle_`
          );
        }
      } catch(e) { await tgSend(`❌ SMC error for *${sym}*:\n\`${e.message}\``); }
    } else {
      await tgSend(`🧠 *Scanning top ${SMC_TOP_COINS} coins for SMC setups...*`);
      await runSMCScan(true);
    }

  } else if (cmd === '/chart') {
    const symbol = (parts[1] || 'BTCUSDT').toUpperCase().replace('/', '');
    await tgSend(`📊 Fetching 1H chart for *${normSymbol(symbol)}*...`);
    try {
      const klines   = await fetch1hKlines(symbol, 60);
      const imgPath  = renderCandleChart(symbol, klines);
      const last     = getClose(klines[klines.length - 1]);
      const open1h   = getOpen(klines[klines.length - 1]);
      const pct1h    = (last / open1h - 1) * 100;
      const high1h   = getHigh(klines[klines.length - 1]);
      const low1h    = getLow(klines[klines.length - 1]);

      await tgSendPhoto(imgPath,
        `📊 *${normSymbol(symbol)} — 1H Chart*\n` +
        `Price: \`$${fmtPrice(last)}\`\n` +
        `1H Change: \`${pct1h >= 0 ? '+' : ''}${pct1h.toFixed(2)}%\`\n` +
        `H: \`$${fmtPrice(high1h)}\`  L: \`$${fmtPrice(low1h)}\`\n` +
        `_${now()} WIB_`
      );
    } catch(e) {
      await tgSend(`❌ Chart error for *${symbol}*:\n\`${e.message}\``);
    }

  } else {
    await tgSend(`❓ Unknown: \`${text}\`\nSend /help for commands.`);
  }
}

// ── POLL TELEGRAM ─────────────────────────────────────────────
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
      log(`CMD received: ${msg.text}`);
      await handleCommand(msg.text);
    }
  } catch(e) { log(`pollCommands err: ${e.message}`); }
}

// ── SCAN ONE SYMBOL ───────────────────────────────────────────
async function scanOneSymbol(symbol) {
  try {
    const klines = await fetch1mKlines(symbol, KLINE_LIMIT);
    if (!klines) return null;
    const { movePct, lastPrice } = compute3MinMove(klines);
    if (movePct === null || isNaN(movePct)) return null;
    if (Math.abs(movePct) < ALERT_MOVE_PCT) return null;
    const side = movePct >= 0 ? 'LONG' : 'SHORT';
    const { sl, tp } = tradeLevels(side, lastPrice);
    // Check SMC confluence for this spiking coin
    const smc = await analyzeSMC(symbol).catch(() => null);
    return { symbol, movePct, lastPrice, side, sl, tp, smc };
  } catch(_) { return null; }
}

// ── MAIN SCAN ─────────────────────────────────────────────────
async function runScan(forced) {
  log(`── Scan start${forced ? ' (forced)' : ''} ──`);
  if (paused && !forced) { log('Paused.'); return; }

  try {
    const symbols = await fetchAllSymbols();
    log(`Symbols: ${symbols.length}`);

    const matches = [];
    const BATCH   = 20;
    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch   = symbols.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(s => scanOneSymbol(s)));
      results.forEach(r => { if (r) matches.push(r); });
      if (i + BATCH < symbols.length) await sleep(250);
    }

    matches.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
    log(`Matches: ${matches.length}`);

    if (!matches.length) {
      await tgSend(
        `🔍 *Bitunix Scanner — ${now()}*\n\n` +
        `No coins moved ±${ALERT_MOVE_PCT}% in the last ~3 min.\n` +
        `_Next scan in ${INTERVAL_MIN} min_`
      );
      return;
    }

    const top = matches.slice(0, 15);
    const header =
      `📡 *Bitunix 3-Min Spike Alert — ${now()}*\n` +
      `*${matches.length} coin(s)* hit ±${ALERT_MOVE_PCT}% trigger\n` +
      `100x plan | $${POSITION_USDT.toLocaleString()} pos | SL 0.8% | TP 3%\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n`;

    const lines = top.map(m => {
      const emj = m.movePct >= 0 ? '🚀' : '💥';
      const dir = m.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      let smcLine = '';
      if (m.smc) {
        const agree = m.smc.direction === m.side;
        smcLine = `\n${agree ? '✅ SMC' : '⚠️ SMC Counter'}: *${m.smc.signalType}* ${m.smc.confluence.slice(0,2).join(' | ')} ⭐${m.smc.score}`;
      }
      return (
        `${emj} *${normSymbol(m.symbol)}*\n` +
        `Price: \`$${fmtPrice(m.lastPrice)}\`  3m: \`${m.movePct >= 0?'+':''}${m.movePct.toFixed(2)}%\`\n` +
        `Side: ${dir}\n` +
        `🛑 SL \`$${fmtPrice(m.sl)}\`  🎯 TP \`$${fmtPrice(m.tp)}\`` +
        smcLine
      );
    });

    const footer =
      `\n━━━━━━━━━━━━━━━━━━━━━\n` +
      `⚠️ *Entry Tips:*\n` +
      `• Skip if spread > 0.1%\n` +
      `• Wait for 1st pullback after spike\n` +
      `• /chart SYMBOL → see 1H candle first\n` +
      `_Next scan in ${INTERVAL_MIN} min_`;

    await tgSend(header + lines.join('\n──────────────────────\n') + footer);

  } catch(e) {
    log(`Scan err: ${e.message}`);
    await tgSend(`❌ *Scanner Error — ${now()}*\n\`${e.message}\``);
  }

  log('── Scan end ──\n');
}

// ── START ─────────────────────────────────────────────────────
async function start() {
  log('====================================');
  log('  Bitunix Scanner Bot v2 Starting');
  log(`  Interval: ${INTERVAL_MIN}min | Trigger: ±${ALERT_MOVE_PCT}%`);
  log(`  SL: ${SL_PCT*100}% | TP: ${TP_PCT*100}%`);
  log('====================================');

  await tgSend(
    `🤖 *Bitunix Scanner Bot v3 Online — ${now()}*\n\n` +
    `⚡ Spike: ±${ALERT_MOVE_PCT}% in ~3 min — every *${INTERVAL_MIN} min*\n` +
    `🧠 SMC: BOS/CHoCH + OB + FVG — every *${SMC_INTERVAL_MIN} min*\n` +
    `Strategy: 100x | $${POSITION_USDT.toLocaleString()} | SL 0.8% | TP 3%\n\n` +
    `*Commands:*\n` +
    `/scan — force spike scan\n` +
    `/smc — SMC scan top ${SMC_TOP_COINS} coins\n` +
    `/smc BTCUSDT — SMC for one coin\n` +
    `/chart BTCUSDT — 1H candle chart\n` +
    `/pause /resume /help\n\n` +
    `Running 24/7 on Render ✅`
  );

  await runScan();

  setInterval(pollCommands, 5000);
  setInterval(() => runScan(), INTERVAL_MIN * 60 * 1000);

  // SMC scan every SMC_INTERVAL_MIN (first run after 90s to not overload startup)
  setInterval(() => runSMCScan(), SMC_INTERVAL_MIN * 60 * 1000);
  setTimeout(() => runSMCScan(), 90 * 1000);
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
