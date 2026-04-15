// ============================================================
// AI Brain — Ollama (Gemma 4) integration for trading decisions
//
// Connects to Ollama service for AI-powered market analysis.
// Priority: Ollama (self-hosted) → Google Gemini (free fallback)
//
// Set OLLAMA_URL env var to your Ollama endpoint.
// Railway internal: http://ollama.railway.internal:11434
// External: https://your-ollama-server.com
// ============================================================

const fetch = require('node-fetch');
const { log: bLog } = require('./bot-logger');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama.railway.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
const GOOGLE_AI_KEY = process.env.GOOGLE_AI_KEY || '';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// Rate limiter — prevent flooding the AI
let _lastCallTime = 0;
const MIN_CALL_GAP_MS = 2000;

// Response cache — avoid duplicate AI calls for same data
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  _cache.set(key, { value, time: Date.now() });
  // Evict old entries
  if (_cache.size > 200) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].time - b[1].time);
    for (let i = 0; i < 50; i++) _cache.delete(oldest[i][0]);
  }
}

// Check if Ollama is reachable
let _ollamaHealthy = null;
let _lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 60000;

async function isOllamaHealthy() {
  if (Date.now() - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS && _ollamaHealthy !== null) {
    return _ollamaHealthy;
  }
  _lastHealthCheck = Date.now();

  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    if (r.ok) {
      const data = await r.json();
      const models = (data.models || []).map(m => m.name);
      bLog.ai(`Ollama healthy — models: ${models.join(', ') || 'none loaded'}`);
      _ollamaHealthy = true;
      return true;
    }
  } catch {
    // Ollama not reachable
  }

  _ollamaHealthy = false;
  return false;
}

// Call Ollama /api/chat
async function callOllama(systemPrompt, userMessage, model = OLLAMA_MODEL) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 500,
    },
  };

  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);

  const data = await r.json();
  return data.message?.content || '';
}

// Call Google Gemini (free fallback)
async function callGemini(systemPrompt, userMessage) {
  if (!GOOGLE_AI_KEY) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${GOOGLE_AI_KEY}`;
  const body = {
    contents: [
      { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 500,
    },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);

  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Main think function — used by agents
async function think(systemPrompt, userMessage) {
  // Rate limit
  const elapsed = Date.now() - _lastCallTime;
  if (elapsed < MIN_CALL_GAP_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_GAP_MS - elapsed));
  }
  _lastCallTime = Date.now();

  // Cache check
  const cacheKey = `${systemPrompt.slice(0, 50)}:${userMessage.slice(0, 100)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let lastErr = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Try Ollama first
    if (await isOllamaHealthy()) {
      try {
        const result = await callOllama(systemPrompt, userMessage);
        if (result) {
          setCache(cacheKey, result);
          return result;
        }
      } catch (err) {
        lastErr = err;
        bLog.error(`Ollama attempt ${attempt + 1} failed: ${err.message}`);
        _ollamaHealthy = false;
      }
    }

    // Fall back to Google Gemini
    if (GOOGLE_AI_KEY) {
      try {
        const result = await callGemini(systemPrompt, userMessage);
        if (result) {
          setCache(cacheKey, result);
          return result;
        }
      } catch (err) {
        lastErr = err;
        bLog.error(`Gemini attempt ${attempt + 1} failed: ${err.message}`);
      }
    }
  }

  bLog.error(`AI Brain: all providers failed — ${lastErr?.message || 'no providers available'}`);
  return null;
}

// ── Trading-specific AI functions ────────────────────────────

const TRADE_SYSTEM_PROMPT = `You are a crypto futures trading AI. You analyze market data and give concise trading decisions.
RULES:
- You CANNOT change SL, TP, trailing SL, leverage, or position sizing. Those are locked.
- You CAN only decide: trade direction (LONG/SHORT/SKIP) and entry quality.
- Respond in STRICT JSON format only. No markdown, no explanation outside JSON.
- Be conservative. When unsure, respond SKIP.`;

// Analyze a potential trade signal with AI
async function analyzeSignal(symbol, direction, marketData) {
  const cacheKey = `signal:${symbol}:${direction}:${Date.now() >> 16}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const userMsg = `Analyze this trade signal:
Symbol: ${symbol}
Proposed Direction: ${direction}
Current Price: ${marketData.price}
RSI(14): ${marketData.rsi || 'N/A'}
EMA9 vs EMA21 (15m): ${marketData.trend15m || 'N/A'}
1h Trend: ${marketData.trend1h || 'N/A'}
Volume vs Average: ${marketData.volRatio || 'N/A'}x
BTC Trend: ${marketData.btcTrend || 'N/A'}
Strategy: ${marketData.strategy || 'N/A'}
Score: ${marketData.score || 'N/A'}

Respond ONLY with JSON:
{"action":"LONG"|"SHORT"|"SKIP","confidence":"high"|"medium"|"low","reason":"one line"}`;

  const response = await think(TRADE_SYSTEM_PROMPT, userMsg);
  if (!response) return { action: 'SKIP', confidence: 'low', reason: 'AI unavailable' };

  try {
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: 'SKIP', confidence: 'low', reason: 'AI parse error' };
    const parsed = JSON.parse(jsonMatch[0]);
    const result = {
      action: ['LONG', 'SHORT', 'SKIP'].includes(parsed.action) ? parsed.action : 'SKIP',
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      reason: String(parsed.reason || '').slice(0, 200),
    };
    setCache(cacheKey, result);
    return result;
  } catch {
    return { action: 'SKIP', confidence: 'low', reason: 'AI response parse error' };
  }
}

// Analyze market conditions for a token
async function analyzeMarket(symbol, candleData) {
  const cacheKey = `market:${symbol}:${Date.now() >> 17}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const userMsg = `Quick market analysis for ${symbol}:
Last 5 candles (15m): ${JSON.stringify(candleData.slice(-5).map(c => ({
    o: c.open?.toFixed(2), h: c.high?.toFixed(2), l: c.low?.toFixed(2), c: c.close?.toFixed(2)
  })))}

Respond ONLY with JSON:
{"bias":"LONG"|"SHORT"|"NEUTRAL","strength":1-10,"keyLevel":number,"note":"one line"}`;

  const response = await think(TRADE_SYSTEM_PROMPT, userMsg);
  if (!response) return { bias: 'NEUTRAL', strength: 5, keyLevel: 0, note: 'AI unavailable' };

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { bias: 'NEUTRAL', strength: 5, keyLevel: 0, note: 'parse error' };
    const parsed = JSON.parse(jsonMatch[0]);
    const result = {
      bias: ['LONG', 'SHORT', 'NEUTRAL'].includes(parsed.bias) ? parsed.bias : 'NEUTRAL',
      strength: Math.min(10, Math.max(1, parseInt(parsed.strength) || 5)),
      keyLevel: parseFloat(parsed.keyLevel) || 0,
      note: String(parsed.note || '').slice(0, 200),
    };
    setCache(cacheKey, result);
    return result;
  } catch {
    return { bias: 'NEUTRAL', strength: 5, keyLevel: 0, note: 'parse error' };
  }
}

module.exports = {
  think,
  analyzeSignal,
  analyzeMarket,
  isOllamaHealthy,
  OLLAMA_URL,
  OLLAMA_MODEL,
};
