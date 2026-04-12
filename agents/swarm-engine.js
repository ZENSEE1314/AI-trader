// ============================================================
// Swarm Simulation Engine — MiroFish-inspired Consensus Model
//
// This engine replaces linear predictions with a "society of agents"
// simulations. It spawns diverse personas to analyze seed data
// and derive a high-confidence consensus on market direction.
// ============================================================

const aiBrain = require('./ai-brain');

// ── Swarm Persona Configurations ──────────────────────────────

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
  }
};

// Expert mappings: specific personas that excel at specific symbols
const EXPERT_MAPPING = {
  'BTCUSDT': { SMC_PURIST: 1.5, BULL_MOMENTUMIST: 1.2 },
  'ETHUSDT': { SMC_PURIST: 1.5, BEAR_CONTRARIAN: 1.3 },
  'SOLUSDT': { BULL_MOMENTUMIST: 1.8, SCAUPER_RISK_AVERSIVE: 1.2 },
};

/**
 * Runs a swarm simulation for a specific token.
 * @param {string} symbol - Token symbol (e.g. 'BTCUSDT')
 * @param {Object} seeds - Market data (indicators, prices, etc.)
 * @returns {Promise<Object>} The consolidated Swarm Result
 */
async function runSwarm(symbol, seeds) {
  const simulations = [];

  // 1. Simulation Phase: Poll each persona
  const personaKeys = Object.keys(PERSONAS);

  const simulationPromises = personaKeys.map(async (key) => {
    const persona = PERSONAS[key];

    // Calculate dynamic weight based on expertise
    let weight = persona.weight;
    if (EXPERT_MAPPING[symbol] && EXPERT_MAPPING[symbol][key]) {
      weight = EXPERT_MAPPING[symbol][key];
    }

    const userMessage = `Simulate the next 20 candles for ${symbol}.
Seed Data:
- Current Price: ${seeds.current}
- Indicators: ${JSON.stringify(seeds.indicators)}
- Predicted Range: ${seeds.pred_high} to ${seeds.pred_low}
- Trend: ${seeds.trend}

Predict the direction (LONG/SHORT/NEUTRAL), a target price, and your reasoning.
Return ONLY a JSON object: {"direction": "...", "target": 0.0, "confidence": 0-100, "reasoning": "..."}`;

    try {
      const response = await aiBrain.think({
        agentName: persona.name,
        systemPrompt: persona.prompt,
        userMessage: userMessage,
        context: { symbol, seeds },
        complexity: 'medium',
      });

      // Extract JSON from response
      const jsonMatch = response.match(/\{.*\}/s);
      if (!jsonMatch) throw new Error(`Invalid JSON from ${persona.name}`);

      const result = JSON.parse(jsonMatch[0]);
      return {
        persona: persona.name,
        ...result,
        weight: weight
      };
    } catch (err) {
      console.error(`[Swarm] ${persona.name} simulation failed: ${err.message}`);
      return null;
    }
  });

  const results = (await Promise.all(simulationPromises)).filter(r => r !== null);

  if (results.length === 0) {
    return { symbol, direction: 'NEUTRAL', confidence: 0, consensus: 'Simulation failed' };
  }

  // 2. Consensus Phase: Aggregate results
  const votes = { LONG: 0, SHORT: 0, NEUTRAL: 0 };
  let weightedSum = 0;
  let totalWeight = 0;
  let targets = [];

  results.forEach(res => {
    votes[res.direction] += res.weight;
    totalWeight += res.weight;
    if (res.direction !== 'NEUTRAL') {
      targets.push(res.target);
    }
  });

  const winningDirection = Object.keys(votes).reduce((a, b) => votes[a] > votes[b] ? a : b);
  const confidence = Math.round((votes[winningDirection] / totalWeight) * 100);

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

  return finalResult;
}

module.exports = {
  runSwarm,
  PERSONAS
};
