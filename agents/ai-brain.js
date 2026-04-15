// ============================================================
// AI Brain — Multi-provider AI for agent intelligence
//
// Supports:
//   1. Ollama (Local) — set OLLAMA_URL
//      - OLLAMA_MODEL for normal tasks (default: gemma3:4b)
//      - OLLAMA_MODEL_HIGH for complex tasks (default: gemma4:31b-cloud)
//   2. Google Gemini (fallback) — set GOOGLE_AI_KEY
//   3. Anthropic Claude (premium) — set ANTHROPIC_API_KEY
//
// Priority: Ollama (Local) -> Google Gemini (Free) -> Anthropic Claude (Premium)
// All agents run on Ollama by default. Complex tasks use the high model.
// No API keys required — Ollama handles everything locally.
// ============================================================

const hermes = require('../hermes-bridge');

let googleClient = null;
let anthropicClient = null;

// Startup diagnostics — log which AI provider is configured
console.log(`[AI Brain] OLLAMA_URL=${process.env.OLLAMA_URL || 'NOT SET'}`);
console.log(`[AI Brain] OLLAMA_MODEL=${process.env.OLLAMA_MODEL || 'NOT SET'}`);
console.log(`[AI Brain] GOOGLE_AI_KEY=${process.env.GOOGLE_AI_KEY ? 'SET' : 'NOT SET'}`);
console.log(`[AI Brain] Provider priority: ${process.env.OLLAMA_URL ? 'Ollama → ' : ''}${process.env.GOOGLE_AI_KEY ? 'Google → ' : ''}${process.env.ANTHROPIC_API_KEY ? 'Anthropic' : ''}`);

// Rate limiting — Ollama (local) virtually unlimited; cloud APIs get generous limit
const requestLog = [];
const MAX_REQUESTS_PER_MIN = process.env.OLLAMA_URL ? 999 : 120;

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

function getProvider(complexity = 'low') {
  // Priority 1: Ollama (Local/Tunnel) — handles ALL complexity levels
  if (process.env.OLLAMA_URL && ollamaHealthy) {
    return 'ollama';
  }

  // Re-check Ollama health periodically (maybe PC came back online)
  if (process.env.OLLAMA_URL && !ollamaHealthy && Date.now() - ollamaLastCheck > OLLAMA_HEALTH_RECHECK_MS) {
    ollamaHealthy = true; // Optimistic — will be set false again on next failure
    return 'ollama';
  }

  // Priority 2: Google Gemini (Free fallback)
  if (process.env.GOOGLE_AI_KEY) {
    if (!googleClient) {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      googleClient = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY);
    }
    return 'google';
  }

  // Priority 3: Anthropic Claude (Premium)
  if (process.env.ANTHROPIC_API_KEY) {
    if (!anthropicClient) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return 'anthropic';
  }

  return null;
}

function markOllamaDown() {
  ollamaHealthy = false;
  ollamaLastCheck = Date.now();
  console.log('[AI Brain] Ollama marked DOWN — falling back to cloud provider');
}

function markOllamaUp() {
  if (!ollamaHealthy) {
    ollamaHealthy = true;
    console.log('[AI Brain] Ollama is back UP — using local AI');
  }
}

function isAvailable() {
  return !!(process.env.OLLAMA_URL || process.env.GOOGLE_AI_KEY || process.env.ANTHROPIC_API_KEY);
}

function getProviderName() {
  if (process.env.OLLAMA_URL) {
    const model = process.env.OLLAMA_MODEL || 'gemma3:4b';
    const modelHigh = process.env.OLLAMA_MODEL_HIGH || 'gemma4:31b-cloud';
    const status = ollamaHealthy ? 'UP' : 'DOWN→fallback';
    return `Ollama [${status}] (${model} / ${modelHigh})`;
  }
  if (process.env.GOOGLE_AI_KEY) return 'Google Gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'Anthropic Claude';
  return 'none';
}

/**
 * Ask the AI brain a question with agent context.
 */
async function think(opts) {
  const { agentName, systemPrompt, userMessage, context = {}, complexity = 'low', priority = 'normal' } = opts;
  const provider = getProvider(complexity);
  if (!provider) return `[Critical Error] No AI provider configured. Please check OLLAMA_URL, GOOGLE_AI_KEY, or ANTHROPIC_API_KEY.`;

  // Check cache first
  const cacheKey = `${agentName}:${userMessage.substring(0, 100)}`;
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

  // Inject Hermes soul + team memory into system prompt (capped to avoid huge payloads)
  const soul = hermes.loadSoul();
  const teamMemory = hermes.getTeamMemoryPrompt();
  const agentMemory = hermes.getMemoryPrompt(agentName);

  let fullSystem = systemPrompt + contextBlock;
  if (soul) fullSystem = `${soul.substring(0, 500)}\n\n${fullSystem}`;
  if (teamMemory) fullSystem += `\n\n${teamMemory.substring(0, 500)}`;
  if (agentMemory) fullSystem += `\n\n${agentMemory}`;

  try {
    requestLog.push(Date.now());
    let text;
    let currentProvider = provider;

    // Retry mechanism with automatic fallback (Ollama → Google → Anthropic)
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        if (currentProvider === 'google') {
          text = await thinkGoogle(agentName, fullSystem, userMessage);
        } else if (currentProvider === 'ollama') {
          text = await thinkOllama(agentName, fullSystem, userMessage, complexity);
          markOllamaUp(); // Success — Ollama is healthy
        } else {
          text = await thinkAnthropic(agentName, fullSystem, userMessage);
        }
        if (text) break;
        throw new Error('AI returned empty response');
      } catch (err) {
        attempts++;

        // If Ollama failed, mark it down and try cloud fallback immediately
        if (currentProvider === 'ollama') {
          markOllamaDown();
          const fallback = getProvider(complexity);
          if (fallback && fallback !== 'ollama') {
            console.log(`[AI Brain] Ollama failed — falling back to ${fallback}`);
            currentProvider = fallback;
            attempts--; // Don't count the fallback switch as an attempt
            continue;
          }
        }

        // Google 429 quota — cascade to Anthropic immediately, don't retry Google
        if ((err.message?.includes('429') || err.message?.includes('quota')) && currentProvider === 'google') {
          if (process.env.ANTHROPIC_API_KEY) {
            console.log(`[AI Brain] Google quota exhausted — switching to Anthropic`);
            if (!anthropicClient) {
              const Anthropic = require('@anthropic-ai/sdk');
              anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            }
            currentProvider = 'anthropic';
            attempts--;
            continue;
          }
        }

        const isTransient = err.message?.includes('424') || err.message?.includes('500') || err.message?.includes('503') || err.message?.includes('Could not serve request') || err.message?.includes('Error fetching') || err.message?.includes('fetch failed') || err.message?.includes('ECONNRESET') || err.message?.includes('ETIMEDOUT') || err.message === 'AI returned empty response';

        if (isTransient && attempts < maxAttempts) {
          console.log(`[AI Brain] Transient error ${err.message} — retrying (${attempts}/${maxAttempts})...`);
          await new Promise(resolve => setTimeout(resolve, 1500 * attempts));
          continue;
        }
        throw err;
      }
    }

    // Cache the response
    if (text) responseCache.set(cacheKey, { text, ts: Date.now() });
    return text;
  } catch (err) {
    console.error(`[AI Brain] ${agentName} FAILED (${provider}): ${err.message}`);
    if (err.message?.includes('400')) {
      console.error(`[AI Brain] Malformed Request (400) detected. Payload preview: ${JSON.stringify(opts).substring(0, 500)}...`);
    }
    if (err.message?.includes('429') || err.message?.includes('quota')) {
      return `I'm being rate limited by ${provider === 'google' ? 'Google' : 'Anthropic'}. Please wait 30 seconds and try again.`;
    }
    return `I'm having a momentary brain-freeze (AI Error: ${err.message.substring(0, 50)}). Please try asking me again in a few seconds!`;
  }
}

async function thinkGoogle(agentName, systemPrompt, userMessage) {
  let model = process.env.AGENT_AI_MODEL || 'gemini-2.0-flash';
  // Guard: if env var contains an Ollama model name, fall back to Gemini default
  if (model.includes(':') || model.startsWith('gemma') || model.startsWith('llama') || model.startsWith('mistral')) {
    model = 'gemini-2.0-flash';
  }
  console.log(`[AI Brain] ${agentName} thinking with Google ${model}...`);

  const genModel = googleClient.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
  });

  const result = await genModel.generateContent(userMessage);
  const text = result.response.text();
  console.log(`[AI Brain] ${agentName} responded: ${text ? text.substring(0, 80) + '...' : 'EMPTY'}`);
  return text || null;
}

async function thinkAnthropic(agentName, systemPrompt, userMessage) {
  const model = process.env.AGENT_AI_MODEL || 'claude-sonnet-4-6';
  console.log(`[AI Brain] ${agentName} thinking with Anthropic ${model}...`);

  const response = await anthropicClient.messages.create({
    model,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = response.content[0]?.text || null;
  console.log(`[AI Brain] ${agentName} responded: ${text ? text.substring(0, 80) + '...' : 'EMPTY'}`);
  return text;
}

async function thinkOllama(agentName, systemPrompt, userMessage, complexity = 'low') {
  // Dual-model: use high model for complex tasks, normal model for everything else
  const modelNormal = process.env.OLLAMA_MODEL || 'gemma3:4b';
  const modelHigh = process.env.OLLAMA_MODEL_HIGH || 'gemma4:31b-cloud';
  const model = complexity === 'high' ? modelHigh : modelNormal;

  // Use /api/chat endpoint for proper system/user message separation
  const baseUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/api\/(generate|chat)\/?$/, '');
  const url = `${baseUrl}/api/chat`;
  console.log(`[AI Brain] ${agentName} thinking with Ollama ${model} (${complexity})...`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout for cloud-routed models via tunnel
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

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.message?.content || null;
    console.log(`[AI Brain] ${agentName} responded: ${text ? text.substring(0, 80) + '...' : 'EMPTY'}`);
    return text;
  } catch (err) {
    console.error(`[AI Brain] Ollama Error: ${err.message}`);
    throw err;
  }
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
