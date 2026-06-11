// ============================================================
// Swarm Simulation Engine — MiroFish-inspired Consensus Model
//
// This engine replaces linear predictions with a "society of agents"
// simulations. It spawns diverse personas to analyze seed data
// and derive a high-confidence consensus on market direction.
// ============================================================

const aiBrain = require('./ai-brain');
const hermes = require('../hermes-bridge');
const { TradeConsensus } = require('../ruflo-bridge');
const { getSwarmSeed } = require('../polymarket-btc-signal');

// Singleton consensus engine for swarm decisions
const swarmConsensus = new TradeConsensus({ threshold: 0.5, timeoutMs: 10000 });

// ── Swarm Persona Configurations ──────────────────────────────
// MiroFish-inspired: each persona is an "AI agent" with a distinct
// personality and memory, simulating how different market participants
// would respond to the same data. The consensus is the emergent prediction.

const PERSONAS = {
  BULL_MOMENTUMIST: {
    name: 'Bullish Momentumist',
    prompt: `You are a momentum trader. You believe trends persist.
    Focus on volume spikes, bullish EMA alignment, and strong MACD histograms.
    Ignore minor pullbacks; look for the "big move" continuation.`,
    weight: 1.0
  },
  BEAR_CONTRARIAN: {
    name: 'Bearish Contrarian',
    prompt: `You are a mean-reversion and contrarian trader.
    Look for overbought RSI, Bollinger Band upper touches, and "fake-outs".
    Your goal is to find where the crowd is wrong and where the reversal starts.`,
    weight: 1.2
  },
  SMC_PURIST: {
    name: 'SMC Purist',
    prompt: `You are a Smart Money Concepts specialist.
    Focus on Liquidity sweeps, Order Blocks, and Market Structure Breaks (MSB).
    Only predict based on institutional footprints, not retail indicators.`,
    weight: 1.5
  },
  SCAUPER_RISK_AVERSIVE: {
    name: 'Risk-Averse Scalper',
    prompt: `You are a high-frequency scalper.
    Focus on volatility (ATR) and tight ranges.
    You prefer low-risk, high-probability micro-moves over long-term trends.`,
    weight: 0.8
  },
  POLYMARKET_ORACLE: {
    name: 'Polymarket Oracle',
    prompt: `You are a prediction-market analyst. You read crowd wisdom from
    Polymarket — the world's largest prediction market — to forecast direction.
    You treat the probability trend of BTC YES tokens as a leading indicator:
    rising probability = informed money betting on BTC going up = LONG bias.
    falling probability = informed money hedging downside = SHORT bias.
    You weight this heavily because prediction markets aggregate thousands of
    informed participants and are historically more accurate than retail indicators.
    Your edge: you see what the crowd ACTUALLY bets, not what they say.`,
    weight: 1.8   // highest weight — prediction markets are strong leading signals
  },
};

// Expert mappings: specific personas that excel at specific symbols
const EXPERT_MAPPING = {
  'BTCUSDT': { SMC_PURIST: 1.5, BULL_MOMENTUMIST: 1.2, POLYMARKET_ORACLE: 2.0 },
  'ETHUSDT': { SMC_PURIST: 1.5, BEAR_CONTRARIAN: 1.3, POLYMARKET_ORACLE: 1.5 },
  'SOLUSDT': { BULL_MOMENTUMIST: 1.8, SCAUPER_RISK_AVERSIVE: 1.2, POLYMARKET_ORACLE: 1.3 },
};

// ── Polymarket seed cache (refreshed per swarm run, shared across personas) ──
let _polymarketSeedCache = null;
let _polymarketSeedAt   = 0;
const POLY_SEED_TTL_MS  = 5 * 60 * 1000; // refresh every 5 min

async function _getPolymarketSeed() {
  if (_polymarketSeedCache && Date.now() - _polymarketSeedAt < POLY_SEED_TTL_MS) {
    return _polymarketSeedCache;
  }
  try {
    _polymarketSeedCache = await getSwarmSeed();
    _polymarketSeedAt    = Date.now();
  } catch {
    _polymarketSeedCache = { polymarketProb: '50.0', polymarketTrend: 'NEUTRAL', polymarketConf: 0 };
  }
  return _polymarketSeedCache;
}

/**
 * Runs a swarm simulation for a specific token.
 * @param {string} symbol - Token symbol (e.g. 'BTCUSDT')
 * @param {Object} seeds - Market data (indicators, prices, etc.)
 * @returns {Promise<Object>} The consolidated Swarm Result
 */
async function runSwarm(symbol, seeds) {
  const simulations = [];

  // Inject shared team memory so every persona benefits from agent learnings
  const teamMemory = hermes.getTeamMemoryPrompt() || '';
  const teamContext = teamMemory ? `\n\n${teamMemory.substring(0, 400)}` : '';

  // Fetch Polymarket crowd-wisdom seed (shared across all personas, cached 5 min)
  // MiroFish concept: seed the simulation world with real external event data
  const polySeed = await _getPolymarketSeed();
  const polyContext = `\n- Polymarket BTC Crowd Probability: ${polySeed.polymarketProb}% ` +
    `(15m trend: ${polySeed.polymarketTrend}, confidence: ${polySeed.polymarketConf}%, ` +
    `delta: ${polySeed.polymarketDelta}%)`;

  // 1. Simulation Phase: Poll each persona
  const personaKeys = Object.keys(PERSONAS);

  // Run personas sequentially with delay to avoid overwhelming cloud APIs
  const results = [];
  let consecutiveFailures = 0;
  let personaIdx = 0;
  for (const key of personaKeys) {
    if (personaIdx > 0) await new Promise(r => setTimeout(r, 2000)); // 2s gap between calls
    personaIdx++;
    const persona = PERSONAS[key];

    let weight = persona.weight;
    if (EXPERT_MAPPING[symbol] && EXPERT_MAPPING[symbol][key]) {
      weight = EXPERT_MAPPING[symbol][key];
    }

    // POLYMARKET_ORACLE gets a richer prompt with full Polymarket context
    const polyOracleExtra = key === 'POLYMARKET_ORACLE'
      ? `\n\nYour primary input is the Polymarket crowd data above. ` +
        `The probability is ${polySeed.polymarketProb}% (YES = BTC bullish). ` +
        `The 15-min trend is ${polySeed.polymarketTrend} with delta ${polySeed.polymarketDelta}%. ` +
        `If the trend is LONG and probability > 52%, be strongly bullish. ` +
        `If SHORT and probability < 48%, be strongly bearish. ` +
        `Ignore all other indicators — prediction markets are your only signal.`
      : '';

    const userMessage = `Simulate the next 20 candles for ${symbol}.
Seed Data:
- Current Price: ${seeds.current}
- Indicators: ${JSON.stringify(seeds.indicators)}
- Predicted Range: ${seeds.pred_high} to ${seeds.pred_low}
- Trend: ${seeds.trend}${polyContext}

Predict the direction (LONG/SHORT/NEUTRAL), a target price, and your reasoning.
Return ONLY a JSON object: {"direction": "...", "target": 0.0, "confidence": 0-100, "reasoning": "..."}${polyOracleExtra}`;

    try {
      const response = await aiBrain.think({
        agentName: persona.name,
        systemPrompt: persona.prompt + teamContext,
        userMessage: userMessage,
        context: { symbol, seeds },
        complexity: 'high',
      });

      // Detect provider-exhausted error strings before attempting JSON parse.
      // ai-brain returns plain error strings when all providers fail — they may
      // contain embedded JSON (e.g. Anthropic error body) that tricks the regex.
      const isProviderError = !response
        || response.includes('credit balance')
        || response.includes('quota')
        || response.includes('brain-freeze')
        || response.includes('rate limit');
      if (isProviderError) {
        console.warn(`[Swarm] ${persona.name} skipped — AI providers unavailable`);
        consecutiveFailures++;
        // If every provider is down, abort remaining personas — don't waste time
        if (consecutiveFailures >= 2) {
          console.warn(`[Swarm] All providers exhausted — aborting swarm for ${symbol}`);
          break;
        }
        continue;
      }
      consecutiveFailures = 0;

      // Extract direction/confidence/target directly via regex — avoids JSON parse errors
      // from unescaped quotes in reasoning text
      const dirMatch = response.match(/"direction"\s*:\s*"(LONG|SHORT|NEUTRAL)"/i);
      const confMatch = response.match(/"confidence"\s*:\s*(\d+)/);
      const targetMatch = response.match(/"target"\s*:\s*([\d.]+)/);
      const reasonMatch = response.match(/"reasoning"\s*:\s*"([^"]{0,200})/);

      if (!dirMatch) throw new Error(`No valid signal JSON from ${persona.name}`);

      const result = {
        direction: dirMatch[1].toUpperCase(),
        confidence: confMatch ? parseInt(confMatch[1]) : 50,
        target: targetMatch ? parseFloat(targetMatch[1]) : seeds.current,
        reasoning: reasonMatch ? reasonMatch[1] : '',
      };
      if (!result.direction) throw new Error(`Missing direction field from ${persona.name}`);

      results.push({
        persona: persona.name,
        ...result,
        weight: weight
      });
    } catch (err) {
      console.error(`[Swarm] ${persona.name} simulation failed: ${err.message}`);
    }

    // Small delay between calls to avoid API throttling
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (results.length === 0) {
    return { symbol, direction: 'NEUTRAL', confidence: 0, consensus: 'Simulation failed' };
  }

  // 2. Consensus Phase: Ruflo Gossip-backed voting (replaces simple weighted average)
  // Register personas as voters if not already registered
  for (const res of results) {
    if (!swarmConsensus.voters.has(res.persona)) {
      swarmConsensus.registerVoter(res.persona, { weight: res.weight });
    }
  }

  // Build votes for consensus engine
  const consensusVotes = results.map(res => ({
    voterId: res.persona,
    vote: {
      approve: res.direction !== 'NEUTRAL',
      direction: res.direction,
      confidence: (res.confidence || 50) / 100,
      reasoning: res.reasoning || '',
    },
  }));

  const consensusResult = swarmConsensus.runRound(symbol, { seeds }, consensusVotes);

  const winningDirection = consensusResult.direction;
  const confidence = Math.round(consensusResult.directionConfidence * 100);

  // Legacy vote tracking for compatibility
  const votes = consensusResult.directionSplit;

  let targets = results.filter(r => r.direction !== 'NEUTRAL').map(r => r.target);
  const avgTarget = targets.length > 0
    ? targets.reduce((a, b) => a + b, 0) / targets.length
    : seeds.current;

  const swarmLogic = results.map(r => `[${r.persona}] ${r.reasoning}`).join(' | ');

  const finalResult = {
    symbol,
    direction: winningDirection,
    confidence: confidence,
    target_price: Math.round(avgTarget * 100) / 100,
    swarm_logic: swarmLogic,
    persona_split: votes,
    timestamp: new Date().toISOString()
  };

  // Log prediction for later verification (Accuracy Loop)
  try {
    const { query } = require('../db');
    await query(
      `INSERT INTO swarm_predictions (symbol, direction, target_price, confidence)
       VALUES ($1, $2, $3, $4)`,
      [symbol, winningDirection, finalResult.target_price, confidence]
    ).catch(err => console.error(`[Swarm] Failed to log prediction: ${err.message}`));
  } catch (err) {
    console.error(`[Swarm] DB error during logging: ${err.message}`);
  }

  // Share high-confidence consensus with the whole team via Hermes
  if (confidence >= 70) {
    const voteStr = Object.entries(votes || {}).map(([d, v]) => `${d}:${v}`).join(' ');
    hermes.addTeamMemory(
      `[SwarmEngine] ${symbol} → ${winningDirection} ${confidence}% confidence (${voteStr}) target=${finalResult.target_price}`
    ).catch(() => {});
  }

  return finalResult;
}

function getSwarmConsensusStats() {
  return swarmConsensus.getStats();
}

module.exports = {
  runSwarm,
  PERSONAS,
  getSwarmConsensusStats,
};
