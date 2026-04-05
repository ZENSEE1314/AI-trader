/**
 * Quantum-Inspired Optimizer — adapted from TuringQ/deepquantum
 *
 * Searches over ALL parameters simultaneously:
 *   Strategy: swing lengths, HTF mode, key level, volume, indecisive threshold
 *   Risk: SL%, TP%, trail step, leverage, risk%, max positions
 *
 * Algorithms:
 *   1. QAOA Amplitude Sampling — superposition-weighted exploration
 *   2. SPSA Gradient Search — 2 evals per iteration for ALL params
 *   3. Quantum Annealing — tunneling to escape local optima
 */

'use strict';

// ── Full Parameter Space: Strategy + Risk ───────────────────

// Strategy-only params — risk is user-configured, not AI-searched
const PARAM_BOUNDS = {
  swingLen4h:        { min: 5,     max: 20,    step: 2,     integer: true },
  swingLen1h:        { min: 5,     max: 20,    step: 2,     integer: true },
  swingLen15m:       { min: 5,     max: 20,    step: 2,     integer: true },
  swingLen1m:        { min: 3,     max: 10,    step: 1,     integer: true },
  indecisiveThresh:  { min: 0.1,   max: 0.5,   step: 0.05 },
  keyLevelProximity: { min: 0.001, max: 0.015, step: 0.001 },
  maxEntryAge:       { min: 10,    max: 50,    step: 5,     integer: true },
  requireBothHTF:    { min: 0,     max: 1,     step: 1,     integer: true }, // 1=both, 0=either
  requireKeyLevel:   { min: 0,     max: 1,     step: 1,     integer: true },
  require15m:        { min: 0,     max: 1,     step: 1,     integer: true },
  require1m:         { min: 0,     max: 1,     step: 1,     integer: true },
  requireVolSpike:   { min: 0,     max: 1,     step: 1,     integer: true },
  volSpikeMultiplier:{ min: 1.0,   max: 3.0,   step: 0.2 },
};

const PARAM_KEYS = Object.keys(PARAM_BOUNDS);

/**
 * QAOA-Inspired Amplitude Sampling
 */
function qaoaSample(topResults, count) {
  if (!topResults.length) return [];

  const fitnesses = topResults.map(r => {
    const wr = r.winRate || 0;
    const pnl = Math.max(0, r.totalPnl + 100);
    return wr * 2 + pnl * 0.5 + 1;
  });

  const totalFit = fitnesses.reduce((a, b) => a + b, 0);
  const probabilities = fitnesses.map(f => f / totalFit);

  const samples = [];
  for (let i = 0; i < count; i++) {
    const r = Math.random();
    let cumulative = 0;
    let parentIdx = 0;
    for (let j = 0; j < probabilities.length; j++) {
      cumulative += probabilities[j];
      if (r < cumulative) { parentIdx = j; break; }
    }

    const parent = topResults[parentIdx].settings;
    const mixerStrength = 1.0 - (i / count) * 0.7;
    const child = {};

    for (const key of PARAM_KEYS) {
      const bounds = PARAM_BOUNDS[key];
      const base = parent[key] !== undefined ? parent[key] : (bounds.min + bounds.max) / 2;
      const angle = (Math.random() - 0.5) * Math.PI * mixerStrength;
      const range = bounds.max - bounds.min;
      const delta = Math.sin(angle) * range * 0.3;

      let val = base + delta;
      val = Math.max(bounds.min, Math.min(bounds.max, val));
      if (bounds.integer) val = Math.round(val);
      else val = parseFloat(val.toFixed(4));
      child[key] = val;
    }

    samples.push({ parentIdx, config: child });
  }

  return samples;
}

/**
 * SPSA Optimizer — gradient-free, 2 evals per iteration for ALL 20 params
 */
async function spsaOptimize(startConfig, evaluateFn, iterations = 15, yieldFn) {
  const A_COEFF = 10;
  const ALPHA = 0.602;
  const GAMMA = 0.101;
  const A_INIT = 0.5;
  const C_INIT = 0.15;

  function normalize(config) {
    const n = {};
    for (const key of PARAM_KEYS) {
      const b = PARAM_BOUNDS[key];
      n[key] = b.max === b.min ? 0.5 : (config[key] - b.min) / (b.max - b.min);
    }
    return n;
  }

  function denormalize(nConfig) {
    const d = {};
    for (const key of PARAM_KEYS) {
      const b = PARAM_BOUNDS[key];
      let val = nConfig[key] * (b.max - b.min) + b.min;
      val = Math.max(b.min, Math.min(b.max, val));
      if (b.integer) val = Math.round(val);
      else val = parseFloat(val.toFixed(4));
      d[key] = val;
    }
    return d;
  }

  let theta = normalize(startConfig);
  const allEvaluated = [];

  for (let k = 0; k < iterations; k++) {
    const ak = A_INIT / Math.pow(k + 1 + A_COEFF, ALPHA);
    const ck = C_INIT / Math.pow(k + 1, GAMMA);

    const delta = {};
    for (const key of PARAM_KEYS) {
      delta[key] = Math.random() > 0.5 ? 1 : -1;
    }

    const thetaPlus = {}, thetaMinus = {};
    for (const key of PARAM_KEYS) {
      thetaPlus[key] = Math.max(0, Math.min(1, theta[key] + ck * delta[key]));
      thetaMinus[key] = Math.max(0, Math.min(1, theta[key] - ck * delta[key]));
    }

    const cfgPlus = denormalize(thetaPlus);
    const cfgMinus = denormalize(thetaMinus);
    const scorePlus = await evaluateFn(cfgPlus);
    const scoreMinus = await evaluateFn(cfgMinus);

    allEvaluated.push({ config: cfgPlus, ...scorePlus });
    allEvaluated.push({ config: cfgMinus, ...scoreMinus });

    const fPlus = (scorePlus.winRate || 0) * 2 + Math.max(0, scorePlus.totalPnl || 0) * 0.1;
    const fMinus = (scoreMinus.winRate || 0) * 2 + Math.max(0, scoreMinus.totalPnl || 0) * 0.1;

    for (const key of PARAM_KEYS) {
      const gHat = (fPlus - fMinus) / (2 * ck * delta[key]);
      theta[key] = Math.max(0, Math.min(1, theta[key] + ak * gHat));
    }
    if (yieldFn) await yieldFn();
  }

  const finalConfig = denormalize(theta);
  const finalScore = await evaluateFn(finalConfig);
  allEvaluated.push({ config: finalConfig, ...finalScore });

  return allEvaluated;
}

/**
 * Quantum Annealing — tunneling + Metropolis acceptance
 */
async function quantumAnneal(topResults, evaluateFn, iterations = 20, yieldFn) {
  if (!topResults.length) return [];

  const T_INITIAL = 2.0;
  const T_FINAL = 0.01;
  const TUNNEL_PROB = 0.3;

  let current = { ...topResults[0].settings };
  let currentFitness = (topResults[0].winRate || 0) * 2 +
    Math.max(0, topResults[0].totalPnl || 0) * 0.1;
  const allEvaluated = [];

  for (let step = 0; step < iterations; step++) {
    const progress = step / iterations;
    const temperature = T_INITIAL * Math.pow(T_FINAL / T_INITIAL, progress);
    const neighbor = {};
    const isQuantumTunnel = Math.random() < TUNNEL_PROB * (1 - progress);

    for (const key of PARAM_KEYS) {
      const b = PARAM_BOUNDS[key];
      const range = b.max - b.min;

      let delta;
      if (isQuantumTunnel) {
        const randTop = topResults[Math.floor(Math.random() * topResults.length)];
        const base = randTop.settings[key] !== undefined ? randTop.settings[key] : current[key];
        delta = (base - current[key]) * (0.5 + Math.random() * 0.5);
      } else {
        delta = (Math.random() - 0.5) * range * temperature * 0.5;
      }

      let val = current[key] + delta;
      val = Math.max(b.min, Math.min(b.max, val));
      if (b.integer) val = Math.round(val);
      else val = parseFloat(val.toFixed(4));
      neighbor[key] = val;
    }

    const score = await evaluateFn(neighbor);
    const neighborFitness = (score.winRate || 0) * 2 +
      Math.max(0, score.totalPnl || 0) * 0.1;

    allEvaluated.push({ config: neighbor, ...score });

    const deltaE = neighborFitness - currentFitness;
    const acceptProb = deltaE > 0 ? 1.0 : Math.exp(deltaE / Math.max(temperature, 0.001));

    if (Math.random() < acceptProb) {
      current = { ...neighbor };
      currentFitness = neighborFitness;
    }
    if (yieldFn) await yieldFn();
  }

  return allEvaluated;
}

/**
 * Full Quantum Pipeline — unified strategy+risk search
 *
 * @param {Object[]} topResults - Top results from Round 1
 * @param {Function} evaluateFn - (fullConfig) => { trades, winRate, totalPnl, ... }
 * @returns {Object} { results, stats }
 */
function quantumOptimize(topResults, evaluateFn) {
  const allQuantumResults = [];
  const topN = topResults.filter(r => r.trades > 0).slice(0, 10);
  if (!topN.length) return { results: [], stats: { qaoaCount: 0, spsaCount: 0, annealCount: 0 } };

  // ═══ PHASE 1: QAOA Amplitude Sampling — 30 samples ═══
  const qaoaSamples = qaoaSample(topN, 30);
  let qaoaCount = 0;
  for (const sample of qaoaSamples) {
    const score = evaluateFn(sample.config);
    if (score.trades > 0) {
      allQuantumResults.push({
        risk: `QAOA-${qaoaCount + 1}`, riskId: `qaoa${qaoaCount}`,
        settings: sample.config, ...score,
      });
      qaoaCount++;
    }
  }

  // ═══ PHASE 2: SPSA Gradient Search — 20 iterations from best ═══
  let spsaCount = 0;
  const spsaResults = spsaOptimize(topN[0].settings, evaluateFn, 20);
  for (const sr of spsaResults) {
    if (sr.trades > 0) {
      allQuantumResults.push({
        risk: `SPSA-${spsaCount + 1}`, riskId: `spsa${spsaCount}`,
        settings: sr.config, ...sr,
      });
      spsaCount++;
    }
  }

  // ═══ PHASE 3: Quantum Annealing — 25 steps ═══
  let annealCount = 0;
  const combinedTop = [...topN];
  if (allQuantumResults.length) {
    const sorted = [...allQuantumResults].sort((a, b) => b.winRate - a.winRate || b.totalPnl - a.totalPnl);
    combinedTop.push(...sorted.slice(0, 5));
  }
  const annealResults = quantumAnneal(combinedTop.slice(0, 10), evaluateFn, 25);
  for (const ar of annealResults) {
    if (ar.trades > 0) {
      allQuantumResults.push({
        risk: `QAnneal-${annealCount + 1}`, riskId: `anneal${annealCount}`,
        settings: ar.config, ...ar,
      });
      annealCount++;
    }
  }

  return {
    results: allQuantumResults,
    stats: { qaoaCount, spsaCount, annealCount },
  };
}

module.exports = { quantumOptimize, qaoaSample, spsaOptimize, quantumAnneal, PARAM_BOUNDS, PARAM_KEYS };
