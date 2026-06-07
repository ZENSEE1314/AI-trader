// ============================================================
// SmartVisionAgent — 24/7 AI-driven trading agent
//
// Pipeline every 60 seconds:
//   1. TradingView TA  — multi-TF technical scores (1m/5m/15m/1h/4h)
//   2. SMC engine      — 15m+1m structure: BOS/CHoCH/HL/LH
//   3. Liquidity check — goodcrypto.app per token
//   4. AI decision     — Ollama nemotron-3-ultra:cloud analyses all data
//   5. Execute         — TraderAgent places the order
//
// No killzone restriction — runs 24/7.
// Trend: 1H EMA50 fast-flip (catches CHoCH moves the 4H misses).
// ============================================================

'use strict';

const https  = require('https');
const http   = require('http');
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
const SYMBOLS = Object.keys(TRADING_CONFIG);                   // BTC ETH SOL BNB
const TV_EXCHANGE = { BTCUSDT:'BINANCE:BTCUSDT', ETHUSDT:'BINANCE:ETHUSDT', SOLUSDT:'BINANCE:SOLUSDT', BNBUSDT:'BINANCE:BNBUSDT' };
const SCAN_INTERVAL_MS = 60_000;   // scan every 60 seconds
const OLLAMA_URL       = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL     = process.env.SMART_VISION_MODEL || 'nemotron-3-ultra:cloud';
const MIN_AI_SCORE     = parseFloat(process.env.SMART_VISION_MIN_SCORE || '65'); // 0-100

// ── TradingView TA fetcher ────────────────────────────────────
// Returns { '1':score, '5':score, '15':score, '60':score, '240':score }
// Score: positive = bullish, negative = bearish, magnitude = strength
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
  } catch (e) {
    return null;
  }
}

// ── Liquidity checker via goodcrypto.app ─────────────────────
// Returns { hasLiquidity, note } — uses the public API endpoint
async function checkLiquidity(symbol) {
  return new Promise(resolve => {
    const token = symbol.replace('USDT', '');
    // goodcrypto.app doesn't have a JSON API; we use a heuristic:
    // CMC/CoinGecko volume for the token as a proxy for liquidity.
    // If 24h volume > $50M it's liquid enough to trade safely.
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgId(token)}&vs_currencies=usd&include_24hr_vol=true`;
    https.get(url, { timeout: 6000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const id = cgId(token);
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
// Sends full market snapshot to nemotron-3-ultra:cloud.
// Returns { score:0-100, action:'LONG'|'SHORT'|'WAIT', reason, confidence }
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

    const isHttps = OLLAMA_URL.startsWith('https');
    const parsedUrl = new URL(OLLAMA_URL + '/api/generate');
    const reqOpts = {
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
          const raw = JSON.parse(d).response || '';
          const match = raw.match(/\{[\s\S]*?\}/);
          if (match) {
            const result = JSON.parse(match[0]);
            resolve(result);
          } else {
            resolve({ action: 'WAIT', score: 0, reason: 'invalid AI response', confidence: 'LOW' });
          }
        } catch { resolve({ action: 'WAIT', score: 0, reason: 'parse error', confidence: 'LOW' }); }
      });
    });
    req.on('error', e => resolve({ action: 'WAIT', score: 0, reason: `ollama error: ${e.message}`, confidence: 'LOW' }));
    req.on('timeout', () => { req.destroy(); resolve({ action: 'WAIT', score: 0, reason: 'ollama timeout', confidence: 'LOW' }); });
    req.write(body);
    req.end();
  });
}

// ── SmartVisionAgent ──────────────────────────────────────────
class SmartVisionAgent extends BaseAgent {
  constructor(options = {}) {
    super('SmartVision', options);
    this._cooldowns  = new Map();  // shared cooldown map
    this._lastSignals = [];
    this._tradeCount  = 0;
    this._ticker = null;
  }

  async start() {
    await super.start();
    bLog.info('[SmartVision] 🚀 Starting 24/7 AI trading agent');
    bLog.info(`[SmartVision] Model: ${OLLAMA_MODEL} | MinScore: ${MIN_AI_SCORE}`);
    bLog.info(`[SmartVision] Symbols: ${SYMBOLS.join(', ')} | Scan: every ${SCAN_INTERVAL_MS/1000}s`);
    this._tick();
    this._ticker = setInterval(() => this._tick(), SCAN_INTERVAL_MS);
  }

  async stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    await super.stop();
  }

  async _tick() {
    const now     = Date.now();
    const timeUTC = new Date(now).toISOString().replace('T',' ').slice(0,16) + ' UTC';
    bLog.scan(`[SmartVision] ── scan ${timeUTC} ──`);

    // Scan all 4 tokens in parallel
    const results = await Promise.all(SYMBOLS.map(sym => this._scanSymbol(sym, now, timeUTC)));

    // Collect valid signals
    const signals = results.filter(Boolean);
    this._lastSignals = signals;

    if (signals.length === 0) {
      bLog.scan('[SmartVision] No signals this tick');
      return;
    }

    // Execute via TraderAgent if coordinator is available
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

      // ── 3. RSI / ADX filters ──────────────────────────────
      const rsi = calcRSI(bars15m, 14);
      const adx = calcADX(bars4h,  14);

      // ── 4. SMC 15m+1m signal ──────────────────────────────
      const smcSignal = await scanKeyLevelSignal(sym, bars15m, bars1m, bars4h, this._cooldowns, bLog.scan);

      // ── 5. Liquidity gate ─────────────────────────────────
      if (!liquidity.hasLiquidity) {
        bLog.scan(`[SmartVision] ${sym} SKIP — low liquidity: ${liquidity.note}`);
        return null;
      }

      // ── 6. TradingView confluence check ───────────────────
      const tv15  = tvScores?.['15m']?.All ?? 0;
      const tv1h  = tvScores?.['1h']?.All  ?? 0;
      const tv4h  = tvScores?.['4h']?.All  ?? 0;
      const tvDir = (tv15 > 0 && tv1h > 0) ? 'LONG' : (tv15 < 0 && tv1h < 0) ? 'SHORT' : 'CONFLICT';

      // Build context for AI
      const context = {
        symbol: sym, price, timeUTC,
        tv: tvScores,
        trend4h, trendEffective, above1hEma,
        rsi, adx,
        smcSignal,
        liquidity,
      };

      bLog.scan(`[SmartVision] ${sym} price=${price.toFixed(2)} trend=${trendEffective} TV15m=${tv15.toFixed(2)} TV1h=${tv1h.toFixed(2)} SMC=${smcSignal?.dir||'none'}`);

      // ── 7. Ask Ollama nemotron ────────────────────────────
      const ai = await askOllama(context);
      bLog.scan(`[SmartVision] ${sym} AI → action=${ai.action} score=${ai.score} conf=${ai.confidence} | ${ai.reason}`);

      this.addActivity('info', `${sym} AI:${ai.action} score=${ai.score} ${ai.reason?.slice(0,60)}`);

      if (ai.action === 'WAIT' || ai.score < MIN_AI_SCORE) return null;

      // ── 8. Build trade signal ─────────────────────────────
      // Use SMC signal levels if available, otherwise derive from price
      const dir    = ai.action; // 'LONG' | 'SHORT'
      const slPct  = cfg.slPct;
      const entry  = smcSignal?.price  || price;
      const sl     = smcSignal?.sl     || (dir === 'LONG' ? entry * (1 - slPct) : entry * (1 + slPct));
      const tp1    = smcSignal?.tp1    || (dir === 'LONG' ? entry * (1 + slPct) : entry * (1 - slPct));
      const tp2    = smcSignal?.tp2    || (dir === 'LONG' ? entry * (1 + slPct * 2) : entry * (1 - slPct * 2));

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
        rr:        tp2 && sl ? Math.abs(tp2 - entry) / Math.abs(sl - entry) : 2,
        ts:        now,
        signal:    `SmartVision ${dir} ${sym} score=${ai.score} | ${ai.reason}`,
      };

      bLog.trade(`[SmartVision] ✅ SIGNAL: ${sym} ${dir} entry=${entry.toFixed(2)} sl=${sl.toFixed(2)} tp2=${tp2.toFixed(2)} score=${ai.score}`);
      this.addActivity('success', `${sym} ${dir} score=${ai.score} entry=${entry.toFixed(2)}`);
      return signal;

    } catch (err) {
      bLog.error(`[SmartVision] ${sym} error: ${err.message}`);
      this.addActivity('error', `${sym}: ${err.message}`);
      return null;
    }
  }

  getStatus() {
    return {
      ...super.getStatus(),
      model:       OLLAMA_MODEL,
      symbols:     SYMBOLS,
      lastSignals: this._lastSignals.length,
      tradeCount:  this._tradeCount,
      minScore:    MIN_AI_SCORE,
    };
  }
}

module.exports = { SmartVisionAgent };
