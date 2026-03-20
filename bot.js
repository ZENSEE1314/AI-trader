// ============================================================
// Bitunix Market Scanner Bot v2 — Render.com (24/7 persistent)
// Scans all USDT-M Perps on Bitunix every 10 min
// Detects >5% move in ~3 minutes using 1m candles
// Telegram commands: /scan /chart SYMBOL /pause /resume /help
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
      `🤖 *Bitunix Scanner Bot*\n\n` +
      `/scan — Force scan right now\n` +
      `/chart BTCUSDT — 1H candle chart\n` +
      `/pause — Pause auto scanning\n` +
      `/resume — Resume auto scanning\n` +
      `/help — Show this menu\n\n` +
      `_Scans every ${INTERVAL_MIN} min | Trigger: ±${ALERT_MOVE_PCT}% in ~3m_`
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
    return { symbol, movePct, lastPrice, side, sl, tp };
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
      return (
        `${emj} *${normSymbol(m.symbol)}*\n` +
        `Price: \`$${fmtPrice(m.lastPrice)}\`  3m: \`${m.movePct >= 0?'+':''}${m.movePct.toFixed(2)}%\`\n` +
        `Side: ${dir}\n` +
        `🛑 SL \`$${fmtPrice(m.sl)}\`  🎯 TP \`$${fmtPrice(m.tp)}\``
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
    `🤖 *Bitunix Scanner Bot Online — ${now()}*\n\n` +
    `Scanning all USDT-M Perps every *${INTERVAL_MIN} min*\n` +
    `Trigger: ±${ALERT_MOVE_PCT}% move in ~3 minutes (1m candles)\n` +
    `Strategy: 100x | $${POSITION_USDT.toLocaleString()} | SL 0.8% | TP 3%\n\n` +
    `*Commands:*\n` +
    `/scan — force scan now\n` +
    `/chart BTCUSDT — show 1H candle chart\n` +
    `/pause — pause scanning\n` +
    `/resume — resume scanning\n` +
    `/help — all commands\n\n` +
    `Running 24/7 on Render ✅`
  );

  await runScan();

  setInterval(pollCommands, 5000);
  setInterval(() => runScan(), INTERVAL_MIN * 60 * 1000);
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
