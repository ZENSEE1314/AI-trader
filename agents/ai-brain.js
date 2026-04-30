// ============================================================
// AI Brain — Ollama-only AI for agent intelligence
//
// Single provider:
//   Ollama (Local/Tunnel) — set OLLAMA_URL
//     - OLLAMA_MODEL      (default: gemma4:31b-cloud)
//     - OLLAMA_MODEL_HIGH (default: gemma4:31b-cloud)
//
// Anthropic and Google providers were removed — Anthropic credits
// were exhausted and Google free-tier quota was permanently capped,
// both spamming the logs without producing usable signals.  If
// Ollama is unreachable, AI Brain returns null and callers (which
// treat AI as optional) skip cleanly.
// ============================================================

const hermes = require('../hermes-bridge');

// Startup diagnostics — only Ollama is supported
console.log(`[AI Brain] OLLAMA_URL=${process.env.OLLAMA_URL || 'NOT SET'}`);
console.log(`[AI Brain] OLLAMA_MODEL=${process.env.OLLAMA_MODEL || 'gemma4:31b-cloud (default)'}`);
console.log(`[AI Brain] Provider: Ollama only (Anthropic/Google removed)`);

// Rate limiting — Ollama (local) virtually unlimited
const requestLog = [];
const MAX_REQUESTS_PER_MIN = 999;

// Response cache — avoid duplicate API calls
const responseCache = new Map();
const CACHE_TTL = 60000; // 1 minute

function isRateLimited(priority = 'normal') {
  const now = Date.now();
  while (requestLog.length && requestLog[0] < now - 60000) requestLog.shift();
  // Chat/high-priority requests get reserved slots — never blocked by background agents
  if (priority === 'chat') return false;
  // Background agents are blocked if they'd eat into chat-reserved slots
  return requestLog.length >= MAX_REQUESTS_PER_MIN;
}

function getCached(key) {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.text;
  return null;
}

// Track Ollama health — if it fails, temporarily fall back to cloud
let ollamaHealthy = true;
let ollamaLastCheck = 0;
const OLLAMA_HEALTH_RECHECK_MS = 60000; // Re-check every 60s after failure

function getProvider(/* complexity unused — Ollama-only */) {
  if (!process.env.OLLAMA_URL) return null;
  if (ollamaHealthy) return 'ollama';

  // Re-check Ollama health periodically — maybe the tunnel came back
  if (Date.now() - ollamaLastCheck > OLLAMA_HEALTH_RECHECK_MS) {
    ollamaHealthy = true; // Optimistic — will be set false on next failure
    return 'ollama';
  }
  return null;
}

function markOllamaDown() {
  ollamaHealthy = false;
  ollamaLastCheck = Date.now();
  console.log('[AI Brain] Ollama marked DOWN — AI optional, callers will skip');
}

function markOllamaUp() {
  if (!ollamaHealthy) {
    ollamaHealthy = true;
    console.log('[AI Brain] Ollama is back UP — using local AI');
  }
}

function isAvailable() {
  return !!process.env.OLLAMA_URL && ollamaHealthy;
}

function getProviderName() {
  if (!process.env.OLLAMA_URL) return 'none';
  const model = process.env.OLLAMA_MODEL || 'gemma4:31b-cloud';
  const status = ollamaHealthy ? 'UP' : 'DOWN';
  return `Ollama [${status}] (${model})`;
}

/**
 * Ask the AI brain a question with agent context.
 */
async function think(opts) {
  const { agentName, systemPrompt, userMessage, context = {}, complexity = 'low', priority = 'normal' } = opts;
  const provider = getProvider(complexity);
  if (!provider) return null; // Caller treats AI as optional — null = skip cleanly

  // Cache key includes systemPrompt snippet to prevent different prompts sharing cached replies
  const cacheKey = `${agentName}:${systemPrompt.substring(0, 40)}:${userMessage.substring(0, 100)}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[AI Brain] ${agentName} cache hit`);
    return cached;
  }

  // Rate limit check — chat requests always pass through
  if (isRateLimited(priority)) {
    console.log(`[AI Brain] Rate limited — ${requestLog.length} requests in last minute`);
    return `I'm thinking too fast — please wait a moment and try again. (${requestLog.length}/${MAX_REQUESTS_PER_MIN} requests/min)`;
  }

  // Safe context pruning to avoid malformed JSON and 400 errors
  const pruneContext = (ctx) => {
    if (!ctx) return {};
    const pruned = {};
    for (const [key, value] of Object.entries(ctx)) {
      if (Array.isArray(value)) {
        // Limit arrays to 10 items to keep prompt size manageable
        pruned[key] = value.slice(0, 10);
      } else if (typeof value === 'object' && value !== null) {
        // Recurse for nested objects
        pruned[key] = pruneContext(value);
      } else {
        pruned[key] = value;
      }
    }
    return pruned;
  };

  const prunedContext = pruneContext(context);
  const contextBlock = Object.keys(prunedContext).length > 0
    ? `\n\n<current_data>\n${JSON.stringify(prunedContext, null, 2)}\n</current_data>`
    : '';

  // Inject Hermes soul + team memory + agent memory + skills into every AI call
  const soul = hermes.loadSoul();
  const teamMemory = hermes.getTeamMemoryPrompt();
  const agentMemory = hermes.getMemoryPrompt(agentName);
  const skillsPrompt = hermes.getSkillsPrompt();

  let fullSystem = systemPrompt + contextBlock;
  // Soul first — sets the fundamental personality and values
  if (soul) fullSystem = `${soul.substring(0, 600)}\n\n${fullSystem}`;
  // Team memory — shared learnings from all agents (larger cap = smarter decisions)
  if (teamMemory) fullSystem += `\n\n${teamMemory.substring(0, 800)}`;
  // Agent-specific memory — this agent's personal experience (capped to keep prompt clean)
  if (agentMemory) fullSystem += `\n\n${agentMemory.substring(0, 600)}`;
  // Available skills — agent knows what tools are available
  if (skillsPrompt) fullSystem += `\n\n${skillsPrompt.substring(0, 400)}`;
  // Hard cap — Google Gemini rejects system instructions > ~4000 chars with a 400 error.
  // Use Array.from to count by Unicode code points (not UTF-16 units) so we never
  // split a surrogate pair, which causes Anthropic to return 400 invalid_request_error.
  const MAX_SYSTEM_CHARS = 3800;
  if (fullSystem.length > MAX_SYSTEM_CHARS) {
    const codePoints = Array.from(fullSystem);
    fullSystem = codePoints.slice(0, MAX_SYSTEM_CHARS).join('');
  }

  try {
    requestLog.push(Date.now());
    let text;
    let attempts = 0;
    const maxAttempts = 2; // Ollama-only — one retry for transient hiccups

    while (attempts < maxAttempts) {
      try {
        text = await thinkOllama(agentName, fullSystem, userMessage, complexity);
        markOllamaUp();
        if (text) break;
        throw new Error('AI returned empty response');
      } catch (err) {
        attempts++;
        const msg = err.message || '';
        const isTransient = /(424|500|503|fetch failed|ECONNRESET|ETIMEDOUT|empty response|Could not serve)/i.test(msg);
        if (isTransient && attempts < maxAttempts) {
          console.log(`[AI Brain] Transient Ollama error (${msg.substring(0, 80)}) — retrying ${attempts}/${maxAttempts}`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        markOllamaDown();
        throw err;
      }
    }

    if (text) responseCache.set(cacheKey, { text, ts: Date.now() });
    return text;
  } catch (err) {
    console.error(`[AI Brain] ${agentName} FAILED (ollama): ${err.message}`);
    return null; // Caller treats AI as optional — null = skip cleanly
  }
}


// One-time fetch of /api/tags so the next 404 lists which models are
// actually loaded.  Cached so we don't spam the discovery call.
let _availableModels = null;
async function fetchOllamaTags(baseUrl) {
  if (_availableModels) return _availableModels;
  try {
    const r = await fetch(`${baseUrl}/api/tags`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    _availableModels = (j.models || []).map(m => m.name || m.model).filter(Boolean);
    return _availableModels;
  } catch (_) { return null; }
}

// Default chain when OLLAMA_MODEL 404s — tries known-good Ollama Cloud
// model names in order.  `gemma4:31b-cloud` doesn't exist; `gemma3:27b-cloud`
// is the latest official Gemma cloud model.
const FALLBACK_MODELS = [
  'gemma3:27b-cloud',
  'gpt-oss:20b-cloud',
  'qwen3-coder:480b-cloud',
];
let _resolvedModel = null;  // sticky once we find one that works

async function thinkOllama(agentName, systemPrompt, userMessage, complexity = 'low') {
  const modelNormal = process.env.OLLAMA_MODEL || 'gemma3:27b-cloud';
  const modelHigh = process.env.OLLAMA_MODEL_HIGH || modelNormal;
  const baseUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/api\/(generate|chat)\/?$/, '');
  const url = `${baseUrl}/api/chat`;

  // If a previous call discovered the configured model is missing and
  // a fallback worked, stick with that fallback for subsequent calls.
  const configured = complexity === 'high' ? modelHigh : modelNormal;
  const tryOrder = _resolvedModel
    ? [_resolvedModel]
    : [configured, ...FALLBACK_MODELS.filter(m => m !== configured)];

  let lastErr = null;
  for (const model of tryOrder) {
    console.log(`[AI Brain] ${agentName} thinking with Ollama ${model} (${complexity})...`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 404) {
        // Model not loaded.  Discover what IS loaded (once) and log it.
        const tags = await fetchOllamaTags(baseUrl);
        console.warn(`[AI Brain] Ollama 404 for model "${model}". Available models: ${tags ? tags.join(', ') || '(none)' : '(tags fetch failed)'}`);
        lastErr = new Error(`Ollama 404: model ${model} not loaded`);
        continue;  // try next fallback
      }
      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const text = data.message?.content || null;
      console.log(`[AI Brain] ${agentName} responded: ${text ? text.substring(0, 80) + '...' : 'EMPTY'}`);
      // Stickiness: remember the model that actually worked
      if (text && model !== configured && !_resolvedModel) {
        _resolvedModel = model;
        console.log(`[AI Brain] Sticky model resolved → ${model} (configured "${configured}" was 404)`);
      }
      return text;
    } catch (err) {
      lastErr = err;
      console.error(`[AI Brain] Ollama Error (${model}): ${err.message}`);
      // For non-404 transport errors, don't churn through every fallback —
      // the network is the same for all of them.
      if (!String(err.message).includes('404')) break;
    }
  }
  throw lastErr || new Error('Ollama: no working model');
}

// ── System prompts per agent role ───────────────────────────

const SYSTEM_PROMPTS = {
  ChartAgent: `You are ChartAgent, a market scanner in an AI crypto trading bot called MCT.

Your job: Scan crypto markets using a simple 2-gate SMC (Smart Money Concepts) strategy.

How you scan:
1. Gate 1: 3m timeframe — detect swing structure (HL = LONG, LH = SHORT)
2. Gate 2: 1m timeframe — must confirm same direction (HL for LONG, LH for SHORT)
3. Next candle entry — swing age must be 0-1 candles (fresh confirmation only)
4. Kronos AI prediction — score boost if agrees, penalty if disagrees

Only 2 gates — fast and focused. Top 10 coins by volume.
Score: base 10 + trend bonus + freshness bonus + Kronos + AI learning.

Answer naturally like a real team member. Reference your actual data.
If the CEO asks you to improve, suggest specific changes to the strategy.`,

  TraderAgent: `You are TraderAgent, the trade executor in an AI crypto trading bot called MCT.

Your job: Execute approved trades on Binance & Bitunix for all users, manage positions.

How you execute:
1. Sync trade status with exchanges every cycle
2. Receive approved signals from ChartAgent (filtered by RiskAgent)
3. Execute MARKET orders for all registered user API keys in parallel
4. Set SL at 5% price distance, TP at 10% price distance (RR 1:2)
5. Manage trailing stop-loss with tiered steps (+30%, +50%, +75%...)
6. Monitor 15M structure breaks for early exit
7. Record results to AI learner for self-improvement

You handle multi-user execution, position sync, and USDT top-up detection.
Answer naturally. If a trade lost, analyze why and suggest what to improve.`,

  RiskAgent: `You are RiskAgent, the risk manager in an AI crypto trading bot called MCT.

Your job: Filter signals through risk rules before execution. Protect capital.

Your rules:
1. Max open positions (configurable, default 5)
2. Duplicate prevention — won't re-enter a coin already open
3. Correlated pair blocking — BTC+ETH, DOGE+SHIB+PEPE, SOL+AVAX+NEAR
4. Score gate — reject below AI minimum threshold
5. Drawdown protection — reduce size after 3+ consecutive losses

Answer naturally. If asked about losses, explain what risk rules could prevent them.`,

  SentimentAgent: `You are SentimentAgent, the market analyst in an AI crypto trading bot called MCT.

Your sources: CoinGecko trending, CryptoPanic news, Binance momentum, X/Twitter.
You classify mood as: risk-on (bullish), risk-off (bearish), or neutral.
You enrich trading signals with sentiment modifiers.

Answer naturally about market conditions and how sentiment affects trades.`,

  AccountantAgent: `You are AccountantAgent, the trade auditor in an AI crypto trading bot called MCT.

Your job: Audit trade history, fix PnL records, recover missing fees, ensure commissions are correct.
You run automatically every 10 cycles to keep records clean.
You check: missing exit prices, wrong PnL calculations, missing fees, status mismatches.

Answer naturally about trade records, PnL, fees, and financial health.`,

  Coordinator: `You are the CEO/Coordinator of MCT (Millionaire Crypto Traders), an AI crypto trading platform.

Your team of AI agents:
- ChartAgent (Market Scanner) — scans using 15m→3m→1m triple HL/LH confirmation
- TraderAgent (Trade Executor) — executes trades on Binance & Bitunix
- RiskAgent (Risk Manager) — filters signals, protects capital
- SentimentAgent (Market Analyst) — tracks market mood from multiple sources
- AccountantAgent (Trade Auditor) — audits PnL, fixes records, ensures correct commissions

You can:
- Command any agent to do something
- Explain the trading system to the CEO
- Analyze performance and suggest improvements
- Create new watcher agents for monitoring specific coins

The CEO is talking to you. Be helpful, proactive, and speak naturally like a real team leader.
If they want something done, either do it or explain what needs to change in the code.
Always reference actual data from your agents' context.`,

  StrategyAgent: `You are StrategyAgent, the autonomous strategy researcher in MCT.

Your job: Discover, generate, evolve, and test novel crypto trading strategies 24/7.
You never stop learning. You search online, ask AI, and breed winning strategies.

How you work:
1. Generate strategies from 16+ recipe templates (EMA cross, RSI bounce, MACD momentum, BB squeeze, swing structure, multi-score, etc.)
2. Search the web for new trading ideas and convert them into testable strategies
3. Use AI brain to invent novel indicator combinations
4. Backtest everything against live market data
5. Evolve winners (mutation + crossover genetics)
6. Kill losers — survival of the fittest
7. Share winning strategies with ChartAgent, OptimizerAgent, and the team
8. Request CoderAgent to add new capabilities when you're stagnating

You have a population of strategies competing for survival. Only the best live.
Think like a hedge fund quant researcher — always hunting for alpha.
Answer naturally about your discoveries, experiments, and current best strategies.`,

  CustomerBot: `You are the customer support chatbot for MCT (Millionaire Crypto Traders).

MCT is an AI-powered crypto auto-trading platform:
- AI bot trades crypto futures 24/7 on user's exchange account (Binance, Bitunix)
- Users connect API keys (trading only, never withdrawal)
- Strategy: Smart Money Concepts with multi-timeframe confirmation
- Profit split: 60% user / 40% platform. No monthly fees.
- Bot manages trailing stop-loss, take-profit, and position sizing

How to start: Sign up → Create API keys on exchange → Add to dashboard → Bot trades automatically.

Be friendly, helpful, and concise. Don't give financial advice. Remind users crypto has risk.`,
};

function getSystemPrompt(agentName) {
  return SYSTEM_PROMPTS[agentName] || SYSTEM_PROMPTS.Coordinator;
}

module.exports = { think, isAvailable, getProviderName, getSystemPrompt, SYSTEM_PROMPTS };
