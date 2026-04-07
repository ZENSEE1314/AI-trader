// ============================================================
// AI Brain — Multi-provider AI for agent intelligence
//
// Supports:
//   1. Google Gemini (FREE) — set GOOGLE_AI_KEY
//   2. Anthropic Claude — set ANTHROPIC_API_KEY
//
// Priority: Google first (free), Anthropic fallback.
// Each agent gets a system prompt with its role + real-time data.
// ============================================================

let googleClient = null;
let anthropicClient = null;

function getProvider() {
  // Priority 1: Google Gemini (free tier)
  if (process.env.GOOGLE_AI_KEY) {
    if (!googleClient) {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      googleClient = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY);
    }
    return 'google';
  }
  // Priority 2: Anthropic Claude
  if (process.env.ANTHROPIC_API_KEY) {
    if (!anthropicClient) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return 'anthropic';
  }
  return null;
}

function isAvailable() {
  return !!(process.env.GOOGLE_AI_KEY || process.env.ANTHROPIC_API_KEY);
}

function getProviderName() {
  if (process.env.GOOGLE_AI_KEY) return 'Google Gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'Anthropic Claude';
  return 'none';
}

/**
 * Ask the AI brain a question with agent context.
 */
async function think(opts) {
  const { agentName, systemPrompt, userMessage, context = {} } = opts;
  const provider = getProvider();
  if (!provider) return null;

  const contextBlock = Object.keys(context).length > 0
    ? `\n\n<current_data>\n${JSON.stringify(context, null, 2).substring(0, 3000)}\n</current_data>`
    : '';

  const fullSystem = systemPrompt + contextBlock;

  try {
    if (provider === 'google') {
      return await thinkGoogle(agentName, fullSystem, userMessage);
    } else {
      return await thinkAnthropic(agentName, fullSystem, userMessage);
    }
  } catch (err) {
    console.error(`[AI Brain] ${agentName} FAILED (${provider}): ${err.message}`);
    return `[AI Error: ${err.message}]`;
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
  const model = process.env.AGENT_AI_MODEL || 'claude-haiku-4-5-20251001';
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

Your job: Scan crypto markets using Smart Money Concepts (SMC) strategy.

How you scan (Triple HL/LH Confirmation):
1. Check 15M timeframe for HL (Higher Low) for LONG or LH (Lower High) for SHORT
2. Check 3M timeframe — must confirm same structure as 15M
3. Check 1M timeframe — must confirm same structure, trigger on next candle
4. Volume confirmation — buying volume >50% for LONG, selling >50% for SHORT
5. Volume must be alive — recent volume >80% of average (no dead periods)
6. Scalper AI confirmation — composite oscillator (ADX, RSI, ATR, OBV)
7. AI scoring — boost from historical win rate per setup/coin/session

All 3 timeframes must agree: HL+HL+HL = LONG, LH+LH+LH = SHORT.
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
