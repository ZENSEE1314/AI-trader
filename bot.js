// ==========================================================
// AI Self-Learning Crypto Trading Bot v4
// SMC Strategy + AI Adaptation + Market Sentiment
// Binance Futures + Bitunix Futures
// ==========================================================

const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const { run: runTrader } = require('./cycle');
const aiLearner = require('./ai-learner');
const { getSentimentSummary } = require('./sentiment-scraper');
const { log: bLog } = require('./bot-logger');
const { getCoordinator } = require('./agents');

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHATS  = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const TRADE_INTERVAL_MIN = parseInt(process.env.TRADE_INTERVAL_MIN || '5');
const INTERVAL_MIN    = parseInt(process.env.INTERVAL_MIN || '1');
const REQUEST_TIMEOUT = 30000;

const { isProxyEnabled, getFetchOptions } = require('./proxy-agent');
console.log(`[BOOT] AI Trader v4 | Telegram:${!!TELEGRAM_TOKEN} Chats:${TELEGRAM_CHATS.join(',')||'NONE'} Interval:${INTERVAL_MIN}min Proxy:${isProxyEnabled() ? 'YES' : 'NO'}`);

let paused       = false;
let lastUpdateId = 0;
let banUntil     = 0;

const spikeCooldown   = new Map();
const SPIKE_COOLDOWN  = 5 * 60 * 1000;
const SPIKE_PCT       = 3;
const SPIKE_INTERVAL  = 2 * 60 * 1000;

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

function e(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── BAN DETECTION ─────────────────────────────────────────────
function parseBanUntil(text) {
  const m = String(text).match(/banned until (\d+)/);
  return m ? parseInt(m[1]) : 0;
}

function isBanned() {
  if (banUntil <= Date.now()) return false;
  const mins = Math.ceil((banUntil - Date.now()) / 60000);
  log(`IP banned for ${mins} more min — skipping`);
  return true;
}

// ── BINANCE PUBLIC API ────────────────────────────────────────
async function fetchWithRetry(url, opts = {}, retries = 3) {
  if (isBanned()) return null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { timeout: REQUEST_TIMEOUT, ...getFetchOptions(), ...opts });
      if (res.status === 418 || res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const until = parseBanUntil(body.msg || '');
        if (until > Date.now()) {
          banUntil = until;
          log(`BANNED until ${new Date(until).toLocaleString()}`);
          await tgSendPrivate(`<b>Binance IP Banned</b> — paused ${Math.ceil((until - Date.now()) / 60000)} min`);
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
        await sleep(1500 * (i + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function fetchTickers() {
  const res = await fetchWithRetry('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (!res) throw new Error('Ticker fetch failed');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchKlines(symbol, interval = '1h', limit = 30) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  if (!res || !res.ok) return null;
  return res.json();
}

// ── INDICATORS (for spike detection) ─────────────────────────
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
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / (losses / period)));
}

// ── TELEGRAM (HTML mode) ──────────────────────────────────────
async function tgSendTo(chatId, html) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      timeout: REQUEST_TIMEOUT,
    });
    const json = await res.json();
    if (!json.ok) log(`tgSend error chat=${chatId}: ${json.error_code}`);
    return { ok: json.ok };
  } catch (err) {
    log(`tgSend err: ${err.message}`);
    return { ok: false };
  }
}

/**
 * Send a voice message to Telegram using Hermes TTS (edge-tts).
 * Falls back silently if TTS unavailable.
 */
async function tgSendVoice(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  try {
    const hermes = require('./hermes-bridge');
    const result = await hermes.generateTTS(text);
    if (!result.success || !result.filePath) return;

    const voiceData = fs.readFileSync(result.filePath);
    const boundary = `----HermesTTS${Date.now()}`;

    for (const chatId of TELEGRAM_CHATS) {
      const parts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ];
      const head = Buffer.from(parts.join(''));
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, voiceData, tail]);

      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendVoice`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        timeout: REQUEST_TIMEOUT,
      });
    }

    // Clean up temp file
    try { fs.unlinkSync(result.filePath); } catch {}
  } catch (err) {
    log(`TTS voice error (non-fatal): ${err.message}`);
  }
}

let lastMsgAt = 0;
const MSG_INTERVAL = 3 * 1000;

async function tgSend(html) {
  log(`TG: ${html.replace(/<[^>]+>/g, '').substring(0, 80)}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  const wait = MSG_INTERVAL - (Date.now() - lastMsgAt);
  if (wait > 0) await sleep(wait);
  lastMsgAt = Date.now();
  await Promise.all(TELEGRAM_CHATS.map(id => tgSendTo(id, html)));
}

async function tgSendPrivate(html) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  const privateChats = TELEGRAM_CHATS.filter(id => !id.startsWith('-'));
  await Promise.all(privateChats.map(id => tgSendTo(id, html)));
}

// ── COMMAND HANDLER ──────────────────────────────────────────
async function handleCommand(text, fromChatId) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');

  if (cmd === '/help' || cmd === 'help') {
    await tgSendTo(fromChatId,
      `<b>AI Trading Bot v4 — Commands</b>\n\n` +
      `<b>Trading</b>\n` +
      `/scan — Force SMC scan now\n` +
      `/stats — AI learning stats &amp; performance\n` +
      `/sentiment — Current market sentiment\n` +
      `/agents — Agent framework health\n\n` +
      `<b>Control</b>\n` +
      `/pause — Pause auto trading\n` +
      `/resume — Resume auto trading\n` +
      `/voice — Voice status update (TTS)\n` +
      `/hermes — Hermes AI integration status\n` +
      `/help — Show this menu\n\n` +
      `<i>Auto scan every ${INTERVAL_MIN} min | AI adapts after each trade</i>`
    );
  } else if (cmd === '/pause' || cmd === 'pause') {
    paused = true;
    await tgSend(`<b>Bot Paused</b> — send /resume to restart.`);
  } else if (cmd === '/resume' || cmd === 'resume') {
    paused = false;
    await tgSend(`<b>Bot Resumed</b> — next scan in ${INTERVAL_MIN} min.`);
  } else if (cmd === '/scan' || cmd === 'scan') {
    await tgSend(`<b>Running AI SMC scan...</b>`);
    await runTradingCycle(true);
  } else if (cmd === '/stats' || cmd === 'stats') {
    await sendAIStats(fromChatId);
  } else if (cmd === '/sentiment' || cmd === 'sentiment') {
    await sendSentiment(fromChatId);
  } else if (cmd === '/agents' || cmd === 'agents') {
    await sendAgentHealth(fromChatId);
  } else if (cmd === '/voice') {
    await sendVoiceStatus(fromChatId);
  } else if (cmd === '/hermes') {
    await sendHermesStatus(fromChatId);
  } else {
    await tgSendTo(fromChatId, `Unknown command: <code>${e(cmd)}</code>\nSend /help for all commands.`);
  }
}

// ── /stats — AI Learning Statistics ──────────────────────────
async function sendAIStats(chatId) {
  try {
    const stats = await aiLearner.getStats();
    const o = stats.overall;

    if (!o || parseInt(o.total) === 0) {
      await tgSendTo(chatId, `<b>AI Stats</b>\n\nNo trades recorded yet. The AI will start learning after the first trade.`);
      return;
    }

    const total = parseInt(o.total);
    const wins = parseInt(o.wins);
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(0) : '0';
    const avgPnl = o.avg_pnl ? parseFloat(o.avg_pnl).toFixed(3) : '0';

    let msg =
      `<b>AI Learning Stats</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Total Trades: <b>${total}</b>\n` +
      `Win Rate: <b>${winRate}%</b> (${wins}W / ${total - wins}L)\n` +
      `Avg PnL: <b>${avgPnl}%</b>\n` +
      `Total PnL: <b>${o.total_pnl ? parseFloat(o.total_pnl).toFixed(2) : '0'}%</b>\n` +
      `Best: <b>${o.best_trade ? '+' + parseFloat(o.best_trade).toFixed(2) : '0'}%</b>\n` +
      `Worst: <b>${o.worst_trade ? parseFloat(o.worst_trade).toFixed(2) : '0'}%</b>\n\n`;

    if (stats.bySetup.length) {
      msg += `<b>By Setup:</b>\n`;
      for (const s of stats.bySetup) {
        const wr = parseInt(s.total) > 0 ? ((parseInt(s.wins) / parseInt(s.total)) * 100).toFixed(0) : '0';
        msg += `  ${s.setup}: ${s.total} trades, ${wr}% WR, avg ${parseFloat(s.avg_pnl).toFixed(3)}%\n`;
      }
      msg += '\n';
    }

    if (stats.bySession.length) {
      msg += `<b>By Session:</b>\n`;
      for (const s of stats.bySession) {
        const wr = parseInt(s.total) > 0 ? ((parseInt(s.wins) / parseInt(s.total)) * 100).toFixed(0) : '0';
        msg += `  ${s.session}: ${s.total} trades, ${wr}% WR\n`;
      }
      msg += '\n';
    }

    if (stats.paramChanges.length) {
      msg += `<b>Recent AI Adjustments:</b>\n`;
      for (const p of stats.paramChanges) {
        msg += `  ${p.param_name}: ${p.old_value} → ${p.new_value} (${p.reason})\n`;
      }
      msg += '\n';
    }

    // Current AI parameters
    const params = await aiLearner.getOptimalParams();
    msg += `<b>Current AI Params:</b>\n`;
    msg += `  TP Margin: ${(params.TP_MARGIN_PCT * 100).toFixed(1)}%\n`;
    msg += `  SL Margin: ${(params.SL_MARGIN_PCT * 100).toFixed(1)}%\n`;
    msg += `  Min Score: ${params.MIN_SCORE}\n`;
    msg += `  Risk/Trade: ${(params.WALLET_SIZE_PCT * 100).toFixed(1)}%\n`;

    await tgSendTo(chatId, msg);
  } catch (err) {
    await tgSendTo(chatId, `<b>Stats Error</b>\n<code>${e(err.message)}</code>`);
  }
}

// ── /agents — Agent Framework Health ─────────────────────────
async function sendAgentHealth(chatId) {
  try {
    const coordinator = getCoordinator();
    const health = coordinator.getHealth();
    let msg = `<b>Agent Framework</b>\n━━━━━━━━━━━━━━━━━━\n`;
    msg += `Coordinator: <b>${health.state}</b> | Runs: ${health.runCount}\n`;
    msg += `Cycle running: ${health.cycleRunning ? 'Yes' : 'No'}\n\n`;

    for (const [name, agentHealth] of Object.entries(health.agents || {})) {
      msg += `<b>${agentHealth.name}</b>\n`;
      msg += `  State: ${agentHealth.state} | Runs: ${agentHealth.runCount}\n`;
      if (agentHealth.lastRunAt) {
        const ago = Math.round((Date.now() - agentHealth.lastRunAt) / 60000);
        msg += `  Last run: ${ago}m ago\n`;
      }
      if (agentHealth.lastError) {
        const errAgo = Math.round((Date.now() - agentHealth.lastError.at) / 60000);
        msg += `  Last error: ${agentHealth.lastError.message.substring(0, 60)} (${errAgo}m ago)\n`;
      }
      // ChartAgent extras
      if (agentHealth.lastSignalCount !== undefined) {
        msg += `  Signals: ${agentHealth.lastSignalCount} | Scans: ${agentHealth.totalScans}\n`;
      }
      // TraderAgent extras
      if (agentHealth.cycleCount !== undefined) {
        msg += `  Cycles: ${agentHealth.cycleCount}\n`;
      }
      msg += '\n';
    }
    await tgSendTo(chatId, msg);
  } catch (err) {
    await tgSendTo(chatId, `<b>Agent Health Error</b>\n<code>${e(err.message)}</code>`);
  }
}

// ── /voice — Voice Status Update via TTS ─────────────────────
async function sendVoiceStatus(chatId) {
  try {
    const coordinator = getCoordinator();
    const health = coordinator.getHealth();
    const mood = coordinator.sentimentAgent?.getMood() || 'neutral';

    let openCount = 0;
    try {
      const { query } = require('./db');
      const rows = await query("SELECT COUNT(*) as cnt FROM trades WHERE status = 'OPEN'");
      openCount = parseInt(rows[0]?.cnt) || 0;
    } catch {}

    const text = `Trading bot status update. ` +
      `Market mood is ${mood}. ` +
      `We have ${openCount} open positions. ` +
      `${health.runCount} cycles completed. ` +
      `All agents are ${health.state === 'idle' || health.state === 'running' ? 'operational' : health.state}.`;

    await tgSendVoice(text);
    await tgSendTo(chatId, `<i>Voice status sent.</i>`);
  } catch (err) {
    await tgSendTo(chatId, `<b>Voice Error</b>\n<code>${e(err.message)}</code>\nMake sure edge-tts is installed: <code>pip install edge-tts</code>`);
  }
}

// ── /hermes — Hermes Integration Status ──────────────────────
async function sendHermesStatus(chatId) {
  try {
    const hermes = require('./hermes-bridge');
    const status = hermes.getHermesStatus();
    const teamMem = hermes.readTeamMemory();

    let msg = `<b>Hermes AI Integration</b>\n━━━━━━━━━━━━━━━━━━\n`;
    msg += `Installed: ${status.installed ? '✅' : '❌'}\n`;
    msg += `Skills: ${status.skillCount}\n`;
    msg += `Soul: ${status.hasSoul ? '✅ Loaded' : '❌ Not found'}\n`;
    msg += `Team memory: ${teamMem.length} entries\n`;
    msg += `Home: <code>${status.hermesHome}</code>\n`;

    if (teamMem.length > 0) {
      msg += `\n<b>Recent Team Memory:</b>\n`;
      for (const entry of teamMem.slice(-3)) {
        msg += `• ${e(entry.substring(0, 80))}\n`;
      }
    }

    await tgSendTo(chatId, msg);
  } catch (err) {
    await tgSendTo(chatId, `<b>Hermes Status Error</b>\n<code>${e(err.message)}</code>`);
  }
}

// ── /sentiment — Market Sentiment Report ─────────────────────
async function sendSentiment(chatId) {
  try {
    const summary = await getSentimentSummary();
    // Convert markdown to HTML
    const html = summary
      .replace(/\*([^*]+)\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    await tgSendTo(chatId, html);
  } catch (err) {
    await tgSendTo(chatId, `<b>Sentiment Error</b>\n<code>${e(err.message)}</code>`);
  }
}

// ── TELEGRAM POLL ────────────────────────────────────────────
async function pollCommands() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHATS.length) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1&allowed_updates=["message"]`,
      { timeout: 8000 }
    );
    const data = await res.json();
    for (const u of (data.result || [])) {
      lastUpdateId = u.update_id;
      const msg = u.message;
      if (!msg?.text) continue;
      if (!msg.text.startsWith('/')) continue;
      log(`CMD [${msg.chat.id}]: ${msg.text}`);
      await handleCommand(msg.text, String(msg.chat.id));
    }
  } catch (err) { log(`poll err: ${err.message}`); }
}

// ── SPIKE ALERT (kept for volatility awareness) ──────────────
async function checkSpikes() {
  if (paused || isBanned()) return;
  try {
    const tickers = await fetchTickers();
    const top = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 20);

    const now_ts = Date.now();
    const alerts = [];

    for (let i = 0; i < top.length; i += 5) {
      await Promise.all(top.slice(i, i + 5).map(async t => {
        try {
          const klines = await fetchKlines(t.symbol, '1m', 3);
          if (!klines || klines.length < 2) return;
          const open  = parseFloat(klines[klines.length - 2][1]);
          const close = parseFloat(klines[klines.length - 1][4]);
          if (!open || open === 0) return;
          const pct = ((close - open) / open) * 100;
          if (Math.abs(pct) < SPIKE_PCT) return;
          if (now_ts - (spikeCooldown.get(t.symbol) || 0) < SPIKE_COOLDOWN) return;
          spikeCooldown.set(t.symbol, now_ts);

          alerts.push({ symbol: t.symbol, pct, price: close });
        } catch (_) {}
      }));
      await sleep(150);
    }

    for (const a of alerts.slice(0, 3)) {
      const coin = a.symbol.replace('USDT', '');
      const dir = a.pct > 0 ? 'PUMP' : 'DUMP';
      const sign = a.pct > 0 ? '+' : '';
      await tgSend(
        `<b>Spike Alert</b> — ${dir}: <b>${coin}/USDT</b>\n` +
        `Move: <b>${sign}${a.pct.toFixed(2)}%</b> in 1 min\n` +
        `Price: <code>$${fmtPrice(a.price)}</code>`
      );
    }
  } catch (err) { log(`spike err: ${err.message}`); }
}

// ── MAIN TRADING CYCLE (via Agent Coordinator) ──────────────
async function runTradingCycle(forced = false) {
  if (paused && !forced) { log('Paused.'); bLog.system('Bot is paused'); return; }
  if (isBanned()) { bLog.system('Binance IP banned — skipping cycle'); return; }

  bLog.system('Trading cycle started' + (forced ? ' (manual)' : ''));
  try {
    const coordinator = getCoordinator();
    const result = await coordinator.run({ forced });
    if (result) {
      bLog.system(`Cycle done in ${result.elapsed}s`);
    }
  } catch (err) {
    bLog.error(`Trading cycle error: ${err.message}`);
    log(`Trading cycle error: ${err.message}`);
  }
  bLog.system('Trading cycle completed');
}

// ── BOOT ─────────────────────────────────────────────────────
async function main() {
  log('=== AI Self-Learning Crypto Bot v4 Starting ===');

  // Start Express server (skip if already started by entry.js)
  if (!process.env.SKIP_SERVER) {
    try {
      const server = require('./server');
      const PORT = process.env.PORT || 3000;
      server.listen(PORT, () => log(`Server on :${PORT}`));
    } catch (err) {
      log(`Server not started: ${err.message}`);
    }
  }

  bLog.system('AI Self-Learning Crypto Bot v4 starting...');

  // Create all required tables before anything else
  const { initAllTables } = require('./db');
  try {
    await initAllTables();
    log('DB tables initialized');
  } catch (err) {
    log(`DB init error: ${err.message}`);
  }

  // Initialize agent framework
  try {
    const coordinator = getCoordinator();
    await coordinator.init();
    log('Agent framework initialized');
  } catch (err) {
    log(`Agent init error (non-fatal): ${err.message}`);
  }

  // Log AI state on startup (non-critical — don't block boot)
  try {
    const stats = await aiLearner.getStats();
    if (stats.overall && parseInt(stats.overall.total) > 0) {
      const total = parseInt(stats.overall.total);
      const wins = parseInt(stats.overall.wins);
      const wr = total > 0 ? ((wins / total) * 100).toFixed(0) : '0';
      const msg = `AI State: ${total} trades, ${wr}% win rate, avg PnL ${(parseFloat(stats.overall.avg_pnl) || 0).toFixed(3)}%`;
      log(msg);
      bLog.ai(msg);
    } else {
      log('AI State: No previous trades — starting fresh');
      bLog.ai('No previous trades — AI starting fresh, will learn after first trade');
    }

    const bestSetups = await aiLearner.getBestSetups();
    if (bestSetups.length) {
      const msg = 'Best setups: ' + bestSetups.map(s => `${s.setup}(${s.win_rate}%)`).join(', ');
      log(msg);
      bLog.ai(msg);
    }

    const aiVersion = await aiLearner.getCurrentVersion();
    bLog.ai(`Current AI version: ${aiVersion}`);
  } catch (err) {
    log(`AI state load error (non-fatal): ${err.message}`);
  }

  try {
    await tgSendPrivate(
      `<b>AI Trading Bot v4 Online</b>\n` +
      `SMC (LiqSweep+SLHunt+MomScalp) + BRR-Fib + Quantum AI\n` +
      `Target: 1% per trade\n` +
      `Scan every ${INTERVAL_MIN} min\n` +
      `Commands: /scan /stats /sentiment /pause /resume /help`
    );
  } catch (err) {
    log(`Telegram notify error (non-fatal): ${err.message}`);
  }

  // Initial scan
  try {
    await runTradingCycle();
  } catch (err) {
    log(`Initial scan error (non-fatal): ${err.message}`);
  }

  // Main loop — command polling + spike checks
  // NOTE: Trading cycles are now managed by the Coordinator's CEO always-on loop
  // (30s micro-cycles + 60s full pipeline scans + staggered token scanning)
  log('Starting main loop: CEO always-on mode (30s micro-cycles)');

  setInterval(async () => {
    try { await pollCommands(); } catch (err) { log(`Poll error: ${err.message}`); }
  }, 5000);

  setInterval(async () => {
    try { await checkSpikes(); } catch (err) { log(`Spike check error: ${err.message}`); }
  }, SPIKE_INTERVAL);

  log('Bot loop is running — CEO commanding all agents');

  // ── Trail SL Watchdog ─────────────────────────────────────
  // Runs as a child process every 15s — moves SL as profit grows.
  // Must be started here (not in loop.js) because loop.js is never launched in production.
  let trailProc = null;
  function startTrailWatchdog() {
    if (trailProc) return;
    trailProc = spawn('node', [path.join(__dirname, 'trail-watchdog.js')], {
      cwd: __dirname,
      stdio: 'inherit',
    });
    trailProc.on('close', (code) => {
      log(`Trail watchdog exited (code ${code}) — restarting in 5s`);
      trailProc = null;
      setTimeout(startTrailWatchdog, 5000);
    });
    trailProc.on('error', (err) => {
      log(`Trail watchdog error: ${err.message} — restarting in 5s`);
      trailProc = null;
      setTimeout(startTrailWatchdog, 5000);
    });
    log('Trail watchdog started (15s interval)');
  }
  startTrailWatchdog();
}

main().catch(err => {
  console.error('FATAL bot error (not exiting — server stays up):', err);
});
