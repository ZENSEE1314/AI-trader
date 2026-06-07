// ============================================================
// SmartVisionAgent — 24/7 AI-driven trading agent
//
// Pipeline every 60 seconds:
//   1. TradingView TA  — multi-TF technical scores (1m/5m/15m/1h/4h)
//   2. SMC engine      — 15m+1m structure: BOS/CHoCH/HL/LH
//   3. Liquidity check — CoinGecko 24h volume
//   4. AI decision     — Ollama nemotron-3-ultra:cloud
//   5. Winner gate     — must match ≥1 winner tag, must NOT match any loser tag
//   6. Execute         — TraderAgent places the order
//
// Self-learning:
//   - analyze-winners.js runs on startup + every 6h
//   - Builds sv-winner-profile.json from ALL closed DB trades
//   - Trades only when current indicator fingerprint matches
//     winning patterns from history
//   - Skips trades that match historically losing patterns
//
// No killzone restriction — runs 24/7.
// ============================================================

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { execFile } = require('child_process');
const { BaseAgent } = require('./base-agent');
const { log: bLog } = require('../bot-logger');
const { getTA } = require('@mathieuc/tradingview');
const {
  scanKeyLevelSignal,
  fetchCandles,
  classifyTrend,
  calcEMASeries,
  calcRSI,
  calcADX,
  TRADING_CONFIG,
} = require('../smc-engine');

// ── Config ────────────────────────────────────────────────────
const SYMBOLS          = Object.keys(TRADING_CONFIG);
const TV_EXCHANGE      = { BTCUSDT:'BINANCE:BTCUSDT', ETHUSDT:'BINANCE:ETHUSDT', SOLUSDT:'BINANCE:SOLUSDT', BNBUSDT:'BINANCE:BNBUSDT' };
const SCAN_INTERVAL_MS = 60_000;
const PROFILE_REFRESH  = 6 * 60 * 60 * 1000;   // rebuild winner profile every 6h
const OLLAMA_URL       = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL     = process.env.SMART_VISION_MODEL || 'nemotron-3-ultra:cloud';
const MIN_AI_SCORE     = parseFloat(process.env.SMART_VISION_MIN_SCORE || '65');
const PROFILE_FILE     = path.join(__dirname, '../data/sv-winner-profile.json');
const ANALYZE_SCRIPT   = path.join(__dirname, '../scripts/analyze-winners.js');

// ── Winner profile loader ─────────────────────────────────────
// Loads the JSON built by analyze-winners.js.
// Returns null if file doesn't exist yet.
function loadProfile() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return null;
    const raw = fs.readFileSync(PROFILE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// ── Run analyze-winners.js in background ─────────────────────
function runAnalysis() {
  return new Promise(resolve => {
    bLog.info('[SmartVision] Running winner analysis from trade history…');
    execFile(process.execPath, [ANALYZE_SCRIPT], { timeout: 120_000 }, (err, stdout) => {
      if (err) { bLog.error(`[SmartVision] Analysis error: ${err.message}`); }
      else      { bLog.info('[SmartVision] Analysis complete — winner profile updated'); }
      if (stdout) bLog.info(stdout.slice(0, 800));
      resolve();
    });
  });
}

// ── Indicator fingerprint extractor ──────────────────────────
// Converts live market snapshot → same tag format as analyze-winners.js
function fingerprint({ sym, dir, rsi, adx, smcSignal, trendEffective, tvScores, now }) {
  const tags = [];

  tags.push(`dir:${dir}`);
  tags.push(`sym:${sym.replace('USDT','')}`);

  // Setup tag
  if (smcSignal) {
    const p = (smcSignal.pattern || '').toLowerCase();
    if (p.includes('hl'))    tags.push('setup:hl');
    else if (p.includes('lh')) tags.push('setup:lh');
    else if (p.includes('bos'))   tags.push('setup:bos');
    else if (p.includes('choch')) tags.push('setup:choch');
    else tags.push('setup:smc');
  } else {
    tags.push('setup:vision');
  }

  // RSI zone
  const rsiVal = parseFloat(rsi ?? NaN);
  tags.push(`rsi:${!isNaN(rsiVal) ? (rsiVal < 35 ? 'low' : rsiVal < 65 ? 'mid' : 'high') : 'uk'}`);

  // ADX zone
  const adxVal = parseFloat(adx ?? NaN);
  tags.push(`adx:${!isNaN(adxVal) ? (adxVal < 20 ? 'weak' : adxVal < 40 ? 'mod' : 'str') : 'uk'}`);

  // Trend
  if (trendEffective === 'UP' || trendEffective === 'DOWN' || trendEffective === 'NEUTRAL') {
    tags.push(`trend:${trendEffective}`);
  }

  // TV alignment: which of 15m/1h/4h agree with direction
  const sign  = dir === 'LONG' ? 1 : -1;
  const tv15  = (tvScores?.['15m']?.All ?? 0) * sign;
  const tv1h  = (tvScores?.['1h']?.All  ?? 0) * sign;
  const tv4h  = (tvScores?.['4h']?.All  ?? 0) * sign;
  const a15   = tv15 > 0.2;
  const a1h   = tv1h > 0.2;
  const a4h   = tv4h > 0.2;
  const tvKey = a15 && a1h && a4h ? 'all3'
              : a15 && a1h        ? '15_1h'
              : a1h && a4h        ? '1h_4h'
              : a15 && a4h        ? '15_4h'
              : a1h               ? '1h'
              : a4h               ? '4h'
              : a15               ? '15'
              : 'none';
  tags.push(`tv:${tvKey}`);

  // Session
  const h = new Date(now).getUTCHours();
  const sess = h >= 2 && h < 6   ? 'asian'
             : h >= 7 && h < 10  ? 'london'
             : h >= 12 && h < 15 ? 'ny_am'
             : h >= 18 && h < 21 ? 'ny_pm'
             : 'off_hours';
  tags.push(`session:${sess}`);

  return tags;
}

// ── Gate check ────────────────────────────────────────────────
// Returns { allow: bool, reason: string }
function checkWinnerGate(tags, profile) {
  if (!profile || !profile.winnerTags || profile.winnerTags.length === 0) {
    return { allow: true, reason: 'no profile yet — allowing all' };
  }

  const winnerSet = new Set(profile.winnerTags.map(t => t.tag));
  const loserSet  = new Set(profile.loserTags.map(t => t.tag));

  // Block if ANY tag matches a loser pattern with WR < 40%
  const loserHits = tags.filter(t => loserSet.has(t));
  if (loserHits.length > 0) {
    return { allow: false, reason: `loser tag match: ${loserHits.join(', ')}` };
  }

  // Allow only if ≥1 tag matches a winner pattern with WR ≥ 55%
  const winnerHits = tags.filter(t => winnerSet.has(t));
  if (winnerHits.length === 0) {
    return { allow: false, reason: 'no winner tag matched — skipping' };
  }

  return { allow: true, reason: `winner tags: ${winnerHits.join(', ')}` };
}

// ── TradingView TA fetcher ────────────────────────────────────
async function fetchTVScores(tvSymbol) {
  try {
    const data = await getTA(tvSymbol, '15');
    if (!data || typeof data !== 'object') return null;
    return {
      '1m':  data['1']   || null,
      '5m':  data['5']   || null,
      '15m': data['15']  || null,
      '1h':  data['60']  || null,
      '4h':  data['240'] || null,
      '1D':  data['1D']  || null,
    };
  } catch (_) { return null; }
}

// ── Liquidity checker ─────────────────────────────────────────
async function checkLiquidity(symbol) {
  return new Promise(resolve => {
    const token = symbol.replace('USDT', '');
    const url   = `https://api.coingecko.com/api/v3/simple/price?ids=${cgId(token)}&vs_currencies=usd&include_24hr_vol=true`;
    https.get(url, { timeout: 6000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j   = JSON.parse(d);
          const id  = cgId(token);
          const vol = j[id]?.usd_24h_vol || 0;
          resolve({
            hasLiquidity: vol > 50_000_000,
            volume24h: vol,
            note: vol > 50_000_000 ? `✅ $${(vol/1e9).toFixed(1)}B 24h vol` : `⚠️ low vol $${(vol/1e6).toFixed(0)}M`,
          });
        } catch { resolve({ hasLiquidity: true, note: 'unknown' }); }
      });
    }).on('error', () => resolve({ hasLiquidity: true, note: 'check failed' }));
  });
}
function cgId(token) {
  const map = { BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin' };
  return map[token] || token.toLowerCase();
}

// ── Ollama AI decision ────────────────────────────────────────
async function askOllama(context) {
  return new Promise(resolve => {
    const prompt = `You are a professional crypto futures trader using Smart Money Concepts (SMC).
Analyze this market snapshot and decide: LONG, SHORT, or WAIT.

SYMBOL: ${context.symbol}
PRICE: ${context.price}
TIME (UTC): ${context.timeUTC}

TRADINGVIEW TECHNICAL SCORES (positive=bullish, negative=bearish, ±2 = strong):
  1m:  ${context.tv?.['1m']?.All?.toFixed(3)  || 'n/a'}  MA: ${context.tv?.['1m']?.MA?.toFixed(2)  || 'n/a'}
  5m:  ${context.tv?.['5m']?.All?.toFixed(3)  || 'n/a'}  MA: ${context.tv?.['5m']?.MA?.toFixed(2)  || 'n/a'}
  15m: ${context.tv?.['15m']?.All?.toFixed(3) || 'n/a'}  MA: ${context.tv?.['15m']?.MA?.toFixed(2) || 'n/a'}
  1h:  ${context.tv?.['1h']?.All?.toFixed(3)  || 'n/a'}  MA: ${context.tv?.['1h']?.MA?.toFixed(2)  || 'n/a'}
  4h:  ${context.tv?.['4h']?.All?.toFixed(3)  || 'n/a'}  MA: ${context.tv?.['4h']?.MA?.toFixed(2)  || 'n/a'}
  1D:  ${context.tv?.['1D']?.All?.toFixed(3)  || 'n/a'}  MA: ${context.tv?.['1D']?.MA?.toFixed(2)  || 'n/a'}

SMC STRUCTURE (15m+1m):
  4H trend:        ${context.trend4h}
  1H EMA50 flip:   ${context.trendEffective}  (price ${context.above1hEma ? 'ABOVE' : 'BELOW'} 1H EMA50)
  RSI (15m):       ${context.rsi?.toFixed(1) || 'n/a'}
  ADX (4H):        ${context.adx?.toFixed(1) || 'n/a'}
  SMC signal:      ${context.smcSignal ? `${context.smcSignal.dir} pattern=${context.smcSignal.pattern} entry=${context.smcSignal.price?.toFixed(2)} sl=${context.smcSignal.sl?.toFixed(2)}` : 'none'}
  Pattern label:   ${context.smcSignal?.pattern15 || context.smcSignal?.pattern || 'n/a'}

LIQUIDITY:
  ${context.liquidity?.note || 'n/a'}

HISTORICAL WIN TAGS (from past winning trades — favour these):
  ${context.winnerTags?.slice(0,8).map(t=>`${t.tag}(WR=${t.wr}%)`).join(' ') || 'loading…'}

RULES:
- Only trade with momentum (multiple TF alignment)
- 1h and 4h must agree on direction
- RSI 30-70 safe zone (avoid extremes)
- ADX > 20 for trending market
- SMC signal = strong confirmation
- WAIT if signals conflict or weak

Respond in this exact JSON format (nothing else):
{"action":"LONG","score":78,"reason":"15m/1h/4h all bullish, HL confirmed, ADX=63 trending","confidence":"HIGH"}`;

    const body = JSON.stringify({
      model:  OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 120 },
    });

    const isHttps  = OLLAMA_URL.startsWith('https');
    const parsedUrl = new URL(OLLAMA_URL + '/api/generate');
    const reqOpts  = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (isHttps ? 443 : 11434),
      path:     parsedUrl.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  30_000,
    };

    const req = (isHttps ? https : http).request(reqOpts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const raw   = JSON.parse(d).response || '';
          const match = raw.match(/\{[\s\S]*?\}/);
          if (match) resolve(JSON.parse(match[0]));
          else resolve({ action: 'WAIT', score: 0, reason: 'invalid AI response', confidence: 'LOW' });
        } catch { resolve({ action: 'WAIT', score: 0, reason: 'parse error', confidence: 'LOW' }); }
      });
    });
    req.on('error', e  => resolve({ action: 'WAIT', score: 0, reason: `ollama error: ${e.message}`, confidence: 'LOW' }));
    req.on('timeout', () => { req.destroy(); resolve({ action: 'WAIT', score: 0, reason: 'ollama timeout', confidence: 'LOW' }); });
    req.write(body);
    req.end();
  });
}

// ── SmartVisionAgent ──────────────────────────────────────────
class SmartVisionAgent extends BaseAgent {
  constructor(options = {}) {
    super('SmartVision', options);
    this._cooldowns   = new Map();
    this._lastSignals = [];
    this._tradeCount  = 0;
    this._ticker      = null;
    this._profileTimer = null;
    this._profile     = null;       // winner profile loaded from analyze-winners.js
    this._lastAnalysis = 0;
  }

  async start() {
    await super.start();
    bLog.info('[SmartVision] 🚀 Starting 24/7 AI trading agent');
    bLog.info(`[SmartVision] Model: ${OLLAMA_MODEL} | MinScore: ${MIN_AI_SCORE}`);
    bLog.info(`[SmartVision] Symbols: ${SYMBOLS.join(', ')} | Scan: every ${SCAN_INTERVAL_MS/1000}s`);

    // Load existing winner profile (from previous run)
    this._profile = loadProfile();
    if (this._profile) {
      bLog.info(`[SmartVision] Loaded winner profile: ${this._profile.totalTrades} trades, WR=${this._profile.overallWR}%, ${this._profile.winnerTags?.length||0} winner tags`);
    } else {
      bLog.info('[SmartVision] No winner profile yet — running initial analysis…');
    }

    // Run analysis immediately at boot, then every 6h
    this._refreshProfile();
    this._profileTimer = setInterval(() => this._refreshProfile(), PROFILE_REFRESH);

    // Start 60s scan loop
    this._tick();
    this._ticker = setInterval(() => this._tick(), SCAN_INTERVAL_MS);
  }

  async stop() {
    if (this._ticker)       { clearInterval(this._ticker);       this._ticker       = null; }
    if (this._profileTimer) { clearInterval(this._profileTimer); this._profileTimer = null; }
    await super.stop();
  }

  // ── Rebuild winner profile from trade history ─────────────
  async _refreshProfile() {
    try {
      await runAnalysis();
      this._profile     = loadProfile();
      this._lastAnalysis = Date.now();
      if (this._profile) {
        bLog.info(`[SmartVision] ✅ Profile refreshed: ${this._profile.totalTrades} trades WR=${this._profile.overallWR}% | ${this._profile.winnerTags?.length||0} winner tags | ${this._profile.loserTags?.length||0} loser tags`);
        this.addActivity('info', `Winner profile: ${this._profile.totalTrades} trades WR=${this._profile.overallWR}%`);
      }
    } catch (err) {
      bLog.error(`[SmartVision] Profile refresh error: ${err.message}`);
    }
  }

  async _tick() {
    const now     = Date.now();
    const timeUTC = new Date(now).toISOString().replace('T',' ').slice(0,16) + ' UTC';
    bLog.scan(`[SmartVision] ── scan ${timeUTC} ──`);

    const results = await Promise.all(SYMBOLS.map(sym => this._scanSymbol(sym, now, timeUTC)));
    const signals = results.filter(Boolean);
    this._lastSignals = signals;

    if (signals.length === 0) {
      bLog.scan('[SmartVision] No signals this tick');
      return;
    }

    for (const sig of signals) {
      try {
        const trader = this._options?.coordinator?.traderAgent;
        if (trader && typeof trader.executeSMCSignal === 'function') {
          await trader.executeSMCSignal(sig, 'SmartVision');
          this._tradeCount++;
        } else {
          bLog.trade(`[SmartVision] SIGNAL (no trader): ${sig.symbol} ${sig.direction} entry=${sig.entry?.toFixed(2)} sl=${sig.sl?.toFixed(2)}`);
        }
      } catch (e) {
        bLog.error(`[SmartVision] execute error ${sig.symbol}: ${e.message}`);
      }
    }
  }

  async _scanSymbol(sym, now, timeUTC) {
    try {
      const cfg = TRADING_CONFIG[sym];

      // ── 1. Fetch market data in parallel ──────────────────
      const [bars15m, bars4h, bars1m, bars1h, tvScores, liquidity] = await Promise.all([
        fetchCandles(sym, '15',  100),
        fetchCandles(sym, '240', 220),
        fetchCandles(sym, '1',    60),
        fetchCandles(sym, '60',   60),
        fetchTVScores(TV_EXCHANGE[sym]),
        checkLiquidity(sym),
      ]);

      if (!bars15m?.length || !bars4h?.length || !bars1m?.length) return null;

      const price  = bars1m[bars1m.length - 1].c;
      const trend4h = classifyTrend(bars4h);

      // ── 2. 1H EMA50 fast-flip ─────────────────────────────
      const ema1hSeries = calcEMASeries(bars1h, 50);
      const ema1h       = ema1hSeries[ema1hSeries.length - 1];
      const above1hEma  = ema1h !== null && price > ema1h;
      let trendEffective = trend4h;
      if (trend4h === 'DOWN'    && above1hEma)  trendEffective = 'UP';
      if (trend4h === 'UP'      && !above1hEma) trendEffective = 'DOWN';
      if (trend4h === 'NEUTRAL')                trendEffective = above1hEma ? 'UP' : 'DOWN';

      // ── 3. RSI / ADX ──────────────────────────────────────
      const rsi = calcRSI(bars15m, 14);
      const adx = calcADX(bars4h,  14);

      // ── 4. SMC 15m+1m signal ──────────────────────────────
      const smcSignal = await scanKeyLevelSignal(sym, bars15m, bars1m, bars4h, this._cooldowns, bLog.scan);

      // ── 5. Liquidity gate ─────────────────────────────────
      if (!liquidity.hasLiquidity) {
        bLog.scan(`[SmartVision] ${sym} SKIP — low liquidity: ${liquidity.note}`);
        return null;
      }

      // ── 6. TradingView confluence ─────────────────────────
      const tv15 = tvScores?.['15m']?.All ?? 0;
      const tv1h = tvScores?.['1h']?.All  ?? 0;
      const tvDir = (tv15 > 0 && tv1h > 0) ? 'LONG' : (tv15 < 0 && tv1h < 0) ? 'SHORT' : 'CONFLICT';

      bLog.scan(`[SmartVision] ${sym} price=${price.toFixed(2)} trend=${trendEffective} TV15m=${tv15.toFixed(2)} TV1h=${tv1h.toFixed(2)} SMC=${smcSignal?.dir||'none'}`);

      // ── 7. Ask Ollama ─────────────────────────────────────
      const context = {
        symbol: sym, price, timeUTC,
        tv: tvScores,
        trend4h, trendEffective, above1hEma,
        rsi, adx,
        smcSignal,
        liquidity,
        winnerTags: this._profile?.winnerTags || [],
      };

      const ai = await askOllama(context);
      bLog.scan(`[SmartVision] ${sym} AI → action=${ai.action} score=${ai.score} conf=${ai.confidence} | ${ai.reason}`);
      this.addActivity('info', `${sym} AI:${ai.action} score=${ai.score} ${ai.reason?.slice(0,60)}`);

      if (ai.action === 'WAIT' || ai.score < MIN_AI_SCORE) return null;

      const dir = ai.action; // 'LONG' | 'SHORT'

      // ── 8. Winner gate — check against historical patterns ─
      const tags  = fingerprint({ sym, dir, rsi, adx, smcSignal, trendEffective, tvScores, now });
      const gate  = checkWinnerGate(tags, this._profile);

      bLog.scan(`[SmartVision] ${sym} winner gate → ${gate.allow ? '✅ PASS' : '❌ BLOCK'} | ${gate.reason}`);
      this.addActivity(gate.allow ? 'info' : 'warn', `${sym} gate:${gate.allow?'PASS':'BLOCK'} ${gate.reason}`);

      if (!gate.allow) return null;

      // ── 9. Build trade signal ─────────────────────────────
      const slPct = cfg.slPct;
      const entry = smcSignal?.price  || price;
      const sl    = smcSignal?.sl     || (dir === 'LONG' ? entry * (1 - slPct) : entry * (1 + slPct));
      const tp1   = smcSignal?.tp1    || (dir === 'LONG' ? entry * (1 + slPct) : entry * (1 - slPct));
      const tp2   = smcSignal?.tp2    || (dir === 'LONG' ? entry * (1 + slPct * 2) : entry * (1 - slPct * 2));

      const signal = {
        symbol:    sym,
        direction: dir,
        side:      dir === 'LONG' ? 'BUY' : 'SELL',
        price:     entry,
        entry,
        sl, tp1, tp2,
        lockAt:    tp1,
        slPct:     (slPct * 100).toFixed(3) + '%',
        pattern:   smcSignal?.pattern || 'AI-VISION',
        pattern15: smcSignal?.pattern15 || ai.action,
        pivot15Ts: smcSignal?.pivot15Ts || now,
        score:     ai.score,
        aiReason:  ai.reason,
        source:    'SmartVision',
        tv:        tvScores,
        trend:     trendEffective,
        winnerTags: tags.filter(t => this._profile?.winnerTags?.some(w => w.tag === t)),
        rr:        tp2 && sl ? Math.abs(tp2 - entry) / Math.abs(sl - entry) : 2,
        ts:        now,
        signal:    `SmartVision ${dir} ${sym} score=${ai.score} | ${ai.reason}`,
      };

      bLog.trade(`[SmartVision] ✅ SIGNAL: ${sym} ${dir} entry=${entry.toFixed(2)} sl=${sl.toFixed(2)} tp2=${tp2.toFixed(2)} score=${ai.score} tags=${tags.slice(0,4).join(',')}`);
      this.addActivity('success', `${sym} ${dir} score=${ai.score} entry=${entry.toFixed(2)}`);
      return signal;

    } catch (err) {
      bLog.error(`[SmartVision] ${sym} error: ${err.message}`);
      this.addActivity('error', `${sym}: ${err.message}`);
      return null;
    }
  }

  getStatus() {
    const p = this._profile;
    return {
      ...super.getStatus(),
      model:        OLLAMA_MODEL,
      symbols:      SYMBOLS,
      lastSignals:  this._lastSignals.length,
      tradeCount:   this._tradeCount,
      minScore:     MIN_AI_SCORE,
      profileWR:    p?.overallWR    || null,
      profileTrades: p?.totalTrades || 0,
      winnerTags:   p?.winnerTags?.length || 0,
      loserTags:    p?.loserTags?.length  || 0,
      lastAnalysis: this._lastAnalysis ? new Date(this._lastAnalysis).toISOString() : null,
    };
  }
}

module.exports = { SmartVisionAgent };
