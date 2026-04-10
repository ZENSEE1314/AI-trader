// ============================================================
// AI Brain — Multi-provider AI for agent intelligence
//
// Supports:
//   1. Anthropic Claude — set ANTHROPIC_API_KEY
//   2. Google Gemini (fallback) — set GOOGLE_AI_KEY
//
// Priority: Claude first, Gemini fallback.
// Each agent gets a system prompt with its role + real-time data.
// ============================================================

const hermes = require('../hermes-bridge');

let googleClient = null;
let anthropicClient = null;

// Rate limiting — max 10 requests per minute for free tier
const requestLog = [];
const MAX_REQUESTS_PER_MIN = 10;

// Response cache — avoid duplicate API calls
const responseCache = new Map();
const CACHE_TTL = 60000; // 1 minute

function isRateLimited() {
  const now = Date.now();
  while (requestLog.length && requestLog[0] < now - 60000) requestLog.shift();
  return requestLog.length >= MAX_REQUESTS_PER_MIN;
}

function getCached(key) {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.text;
  return null;
}

function getProvider() {
  // Priority 1: Anthropic Claude
  if (process.env.ANTHROPIC_API_KEY) {
    if (!anthropicClient) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return 'anthropic';
  }
  // Priority 2: Google Gemini (fallback)
  if (process.env.GOOGLE_AI_KEY) {
    if (!googleClient) {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      googleClient = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY);
    }
    return 'google';
  }
  return null;
}

function isAvailable() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_AI_KEY);
}

function getProviderName() {
  if (process.env.ANTHROPIC_API_KEY) return 'Anthropic Claude';
  if (process.env.GOOGLE_AI_KEY) return 'Google Gemini';
  return 'none';
}

/**
 * Ask the AI brain a question with agent context.
 */
async function think(opts) {
  const { agentName, systemPrompt, userMessage, context = {} } = opts;
  const provider = getProvider();
  if (!provider) return `[Critical Error] No AI provider configured. Please check ANTHROPIC_API_KEY or GOOGLE_AI_KEY.`;

  // Check cache first
  const cacheKey = `${agentName}:${userMessage.substring(0, 100)}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[AI Brain] ${agentName} cache hit`);
    return cached;
  }

  // Rate limit check
  if (isRateLimited()) {
    console.log(`[AI Brain] Rate limited — ${requestLog.length} requests in last minute`);
    return `I'm thinking too fast — please wait a moment and try again. (${requestLog.length}/${MAX_REQUESTS_PER_MIN} requests/min)`;
  }

  const contextBlock = Object.keys(context).length > 0
    ? `\n\n<current_data>\n${JSON.stringify(context, null, 2).substring(0, 2000)}\n</current_data>`
    : '';

  // Inject Hermes soul + team memory into system prompt
  const soul = hermes.loadSoul();
  const teamMemory = hermes.getTeamMemoryPrompt();
  const agentMemory = hermes.getMemoryPrompt(agentName);

  let fullSystem = systemPrompt + contextBlock;
  if (soul) fullSystem = `${soul}\n\n${fullSystem}`;
  if (teamMemory) fullSystem += `\n\n${teamMemory}`;
  if (agentMemory) fullSystem += `\n\n${agentMemory}`;

  try {
    requestLog.push(Date.now());
    let text;

    // Retry mechanism for transient provider errors (like 424, 500, 503)
    let attempts = 0;
    const maxAttempts = 3; // Increased to 3 for better resilience

    while (attempts < maxAttempts) {
      try {
        if (provider === 'google') {
          text = await thinkGoogle(agentName, fullSystem, userMessage);
        } else {
          text = await thinkAnthropic(agentName, fullSystem, userMessage);
        }
        if (text) break; // Success, exit loop
        throw new Error('AI returned empty response');
      } catch (err) {
        attempts++;
        const isTransient = err.message?.includes('424') || err.message?.includes('500') || err.message?.includes('503') || err.message?.includes('Could not serve request') || err.message === 'AI returned empty response';

        if (isTransient && attempts < maxAttempts) {
          console.log(`[AI Brain] Transient error ${err.message} — retrying (${attempts}/${maxAttempts})...`);
          await new Promise(resolve => setTimeout(resolve, 1500 * attempts)); // Slightly longer backoff
          continue;
        }
        throw err; // Not transient or max attempts reached
      }
    }

    // Cache the response
    if (text) responseCache.set(cacheKey, { text, ts: Date.now() });
    return text;
  } catch (err) {
    console.error(`[AI Brain] ${agentName} FAILED (${provider}): ${err.message}`);
    if (err.message?.includes('429') || err.message?.includes('quota')) {
      return `I'm being rate limited by ${provider === 'google' ? 'Google' : 'Anthropic'}. Please wait 30 seconds and try again.`;
    }
    // Return a more helpful error that suggests a retry
    return `I'm having a momentary brain-freeze (AI Error: ${err.message.substring(0, 50)}). Please try asking me again in a few seconds!`;
  }
}

async function thinkGoogle(agentName, systemPrompt, userMessage) {
  const model = process.env.AGENT_AI_MODEL || 'gemini-2.0-flash';
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

// ── System prompts per agent role ───────────────────────────

const SYSTEM_PROMPTS = {
  ChartAgent: `You are ChartAgent, a market scanner in an AI crypto trading bot called MCT.

Your job: Scan crypto markets using AI-optimized Smart Money Concepts (SMC) strategy.

How you scan (HTF Structure + Kronos AI):
1. 4H timeframe — detect swing structure (bullish/bearish trend)
2. 1H timeframe — must agree with 4H direction (both must align)
3. Both bullish = LONG signal, both bearish = SHORT signal, mixed = skip
4. Kronos AI prediction — score boost if agrees, penalty if disagrees
5. RSI guard — don't LONG when overbought (>70), don't SHORT when oversold (<30)
6. Momentum guard — don't chase moves >1.5% in last 15 minutes
7. Scalper AI confirmation — composite oscillator (ADX, RSI, ATR, OBV)
8. AI scoring — boost from historical win rate per setup/coin/session

Strategy params are optimized by the Quantum Optimizer (swing lengths, filters).
Kronos must approve every trade before execution — no trade without AI confirmation.
You scan the top coins by volume every cycle.

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
