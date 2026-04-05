/**
 * Quantum-Inspired Optimizer — adapted from TuringQ/deepquantum
 *
 * Implements three quantum optimization algorithms in pure JavaScript:
 *   1. QAOA-Inspired Amplitude Search — superposition-weighted exploration
 *   2. SPSA (Simultaneous Perturbation Stochastic Approximation) — gradient-free
 *   3. Quantum Annealing Schedule — temperature-based exploration→exploitation
 *
 * These are classical simulations of quantum algorithms optimized for
 * combinatorial parameter search (strategy × risk configurations).
 */

'use strict';

// ── Quantum State Simulation (lightweight, up to 10 qubits) ─────────

const PARAM_BOUNDS = {
  slPct:        { min: 0.005, max: 0.08,  step: 0.003 },
  tpPct:        { min: 0,     max: 0.06,  step: 0.004 },
  trailStep:    { min: 0.004, max: 0.035, step: 0.002 },
  leverage:     { min: 5,     max: 50,    step: 3,     integer: true },
  riskPct:      { min: 0.02,  max: 0.25,  step: 0.015 },
  maxPos:       { min: 1,     max: 10,    step: 1,     integer: true },
  maxConsecLoss:{ min: 0,     max: 5,     step: 1,     integer: true },
};

const PARAM_KEYS = Object.keys(PARAM_BOUNDS);

/**
 * QAOA-Inspired Amplitude Sampling
 *
 * Maps each top-performing config to a "basis state" with amplitude
 * proportional to its fitness score. Samples new configs by measuring
 * the superposition — higher-fitness regions get explored more.
 *
 * Inspired by deepquantum's QAOA: Hadamard → Problem(gamma) → Mixer(beta)
 * Here we simulate the output distribution directly from fitness scores.
 */
function qaoaSample(topResults, count) {
  if (!topResults.length) return [];

  // Assign amplitudes proportional to sqrt(fitness)
  const fitnesses = topResults.map(r => {
    const wr = r.winRate || 0;
    const pnl = Math.max(0, r.totalPnl + 100); // shift positive
    return wr * 2 + pnl * 0.5 + 1; // weighted fitness, always positive
  });

  const totalFit = fitnesses.reduce((a, b) => a + b, 0);
  // Amplitude = sqrt(probability), probability = fitness / total
  const probabilities = fitnesses.map(f => f / totalFit);

  const samples = [];
  for (let i = 0; i < count; i++) {
    // "Measure" the quantum state — collapse to a basis state
    const r = Math.random();
    let cumulative = 0;
    let parentIdx = 0;
    for (let j = 0; j < probabilities.length; j++) {
      cumulative += probabilities[j];
      if (r < cumulative) { parentIdx = j; break; }
    }

    const parent = topResults[parentIdx].settings;

    // Apply quantum "mixer" — rotate parameters by random angle
    // Mixer strength decays with iteration (annealing)
    const mixerStrength = 1.0 - (i / count) * 0.7; // 1.0 → 0.3
    const child = {};

    for (const key of PARAM_KEYS) {
      const bounds = PARAM_BOUNDS[key];
      const base = parent[key] !== undefined ? parent[key] : (bounds.min + bounds.max) / 2;

      // Quantum rotation: angle determines exploration range
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
 * SPSA Optimizer — from deepquantum's OptimizerSPSA
 *
 * Estimates gradient of ALL parameters simultaneously using only
 * 2 function evaluations per iteration. Extremely efficient for
 * noisy objective functions (like trading backtest results).
 *
 * Algorithm:
 *   1. Generate random ±1 perturbation vector Δ
 *   2. Evaluate f(θ + cΔ) and f(θ - cΔ)
 *   3. Gradient estimate: g = (f+ - f-) / (2cΔ)
 *   4. Update: θ = θ - a * g
 *
 * @param {Object} startConfig - Starting parameter config
 * @param {Function} evaluateFn - (config) => { winRate, totalPnl }
 * @param {number} iterations - Number of SPSA iterations
 * @returns {Object[]} All evaluated configs with scores
 */
function spsaOptimize(startConfig, evaluateFn, iterations = 15) {
  const A_COEFF = 10; // stability constant
  const ALPHA = 0.602; // learning rate decay
  const GAMMA = 0.101; // perturbation decay
  const A_INIT = 0.5;  // initial learning rate
  const C_INIT = 0.15; // initial perturbation size

  // Normalize params to [0, 1] range for uniform step sizes
  function normalize(config) {
    const n = {};
    for (const key of PARAM_KEYS) {
      const b = PARAM_BOUNDS[key];
      n[key] = (config[key] - b.min) / (b.max - b.min);
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

    // Random Bernoulli ±1 perturbation (like deepquantum SPSA)
    const delta = {};
    for (const key of PARAM_KEYS) {
      delta[key] = Math.random() > 0.5 ? 1 : -1;
    }

    // θ+ and θ-
    const thetaPlus = {}, thetaMinus = {};
    for (const key of PARAM_KEYS) {
      thetaPlus[key] = Math.max(0, Math.min(1, theta[key] + ck * delta[key]));
      thetaMinus[key] = Math.max(0, Math.min(1, theta[key] - ck * delta[key]));
    }

    // Evaluate both
    const cfgPlus = denormalize(thetaPlus);
    const cfgMinus = denormalize(thetaMinus);
    const scorePlus = evaluateFn(cfgPlus);
    const scoreMinus = evaluateFn(cfgMinus);

    allEvaluated.push({ config: cfgPlus, ...scorePlus });
    allEvaluated.push({ config: cfgMinus, ...scoreMinus });

    // Fitness: higher = better (we maximize)
    const fPlus = (scorePlus.winRate || 0) * 2 + Math.max(0, scorePlus.totalPnl || 0) * 0.1;
    const fMinus = (scoreMinus.winRate || 0) * 2 + Math.max(0, scoreMinus.totalPnl || 0) * 0.1;

    // Gradient estimate & update (gradient ASCENT since we maximize)
    for (const key of PARAM_KEYS) {
      const gHat = (fPlus - fMinus) / (2 * ck * delta[key]);
      theta[key] = Math.max(0, Math.min(1, theta[key] + ak * gHat));
    }
  }

  // Final evaluation at converged point
  const finalConfig = denormalize(theta);
  const finalScore = evaluateFn(finalConfig);
  allEvaluated.push({ config: finalConfig, ...finalScore });

  return allEvaluated;
}

/**
 * Quantum Annealing Schedule
 *
 * Simulates quantum tunneling — at high "temperature" (early iterations),
 * accepts worse solutions to escape local optima. Temperature decreases
 * exponentially, converging to best found solution.
 *
 * Based on transverse-field Ising model from deepquantum's photonic optimizer.
 *
 * @param {Object[]} topResults - Top configs to anneal from
 * @param {Function} evaluateFn - (config) => { winRate, totalPnl }
 * @param {number} iterations - Annealing steps
 * @returns {Object[]} All evaluated configs
 */
function quantumAnneal(topResults, evaluateFn, iterations = 20) {
  if (!topResults.length) return [];

  const T_INITIAL = 2.0;  // starting temperature
  const T_FINAL = 0.01;   // ending temperature
  const TUNNEL_PROB = 0.3; // quantum tunneling probability

  // Start from the best known config
  let current = { ...topResults[0].settings };
  let currentFitness = (topResults[0].winRate || 0) * 2 +
    Math.max(0, topResults[0].totalPnl || 0) * 0.1;
  let bestConfig = { ...current };
  let bestFitness = currentFitness;
  const allEvaluated = [];

  for (let step = 0; step < iterations; step++) {
    // Exponential temperature decay
    const progress = step / iterations;
    const temperature = T_INITIAL * Math.pow(T_FINAL / T_INITIAL, progress);

    // Generate neighbor — perturbation size scales with temperature
    const neighbor = {};
    const isQuantumTunnel = Math.random() < TUNNEL_PROB * (1 - progress);

    for (const key of PARAM_KEYS) {
      const b = PARAM_BOUNDS[key];
      const range = b.max - b.min;

      let delta;
      if (isQuantumTunnel) {
        // Quantum tunnel: jump to a random region near another top result
        const randTop = topResults[Math.floor(Math.random() * topResults.length)];
        const base = randTop.settings[key] !== undefined ? randTop.settings[key] : current[key];
        delta = (base - current[key]) * (0.5 + Math.random() * 0.5);
      } else {
        // Normal thermal perturbation
        delta = (Math.random() - 0.5) * range * temperature * 0.5;
      }

      let val = current[key] + delta;
      val = Math.max(b.min, Math.min(b.max, val));
      if (b.integer) val = Math.round(val);
      else val = parseFloat(val.toFixed(4));
      neighbor[key] = val;
    }

    // Evaluate neighbor
    const score = evaluateFn(neighbor);
    const neighborFitness = (score.winRate || 0) * 2 +
      Math.max(0, score.totalPnl || 0) * 0.1;

    allEvaluated.push({ config: neighbor, ...score });

    // Metropolis acceptance criterion
    const deltaE = neighborFitness - currentFitness;
    const acceptProb = deltaE > 0 ? 1.0 : Math.exp(deltaE / Math.max(temperature, 0.001));

    if (Math.random() < acceptProb) {
      current = { ...neighbor };
      currentFitness = neighborFitness;

      if (neighborFitness > bestFitness) {
        bestConfig = { ...neighbor };
        bestFitness = neighborFitness;
      }
    }
  }

  return allEvaluated;
}

/**
 * Full Quantum-Inspired Optimization Pipeline
 *
 * Combines all three quantum algorithms:
 *   Phase 1: QAOA amplitude sampling (explore high-fitness regions)
 *   Phase 2: SPSA gradient estimation (fine-tune top candidates)
 *   Phase 3: Quantum annealing (escape local optima)
 *
 * @param {Object[]} topResults - Top results from Rounds 1+2 (preset + genetic)
 *   Each: { strategy, strategyId, settings: { slPct, tpPct, ... }, winRate, totalPnl, ... }
 * @param {Object} signalCache - { strategyId: signals[] }
 * @param {Function} replayFn - (signals, riskConfig) => { trades, wallet }
 * @param {Function} scoreFn - (replayResult) => { trades, wins, losses, winRate, totalPnl, ... }
 * @param {string[]} strategyNames - [{ id, name }]
 * @returns {Object} { results: [], stats: { qaoaCount, spsaCount, annealCount } }
 */
function quantumOptimize(topResults, signalCache, replayFn, scoreFn, strategies) {
  const allQuantumResults = [];
  const topN = topResults.filter(r => r.trades > 0).slice(0, 8);
  if (!topN.length) return { results: [], stats: { qaoaCount: 0, spsaCount: 0, annealCount: 0 } };

  // Group top results by strategy to run SPSA per strategy
  const byStrategy = {};
  for (const r of topN) {
    if (!byStrategy[r.strategyId]) byStrategy[r.strategyId] = [];
    byStrategy[r.strategyId].push(r);
  }

  // Helper: evaluate a config for a given strategy
  function makeEvaluator(strategyId) {
    const signals = signalCache[strategyId];
    if (!signals) return null;
    return (config) => {
      const r = replayFn(signals, config);
      return scoreFn(r);
    };
  }

  // ═══ PHASE 1: QAOA Amplitude Sampling — 25 samples ═══
  const qaoaSamples = qaoaSample(topN, 25);
  let qaoaCount = 0;
  for (const sample of qaoaSamples) {
    const parent = topN[sample.parentIdx];
    const evaluate = makeEvaluator(parent.strategyId);
    if (!evaluate) continue;

    const score = evaluate(sample.config);
    if (score.trades > 0) {
      const stratName = strategies.find(s => s.id === parent.strategyId)?.name || parent.strategyId;
      allQuantumResults.push({
        strategy: stratName, strategyId: parent.strategyId,
        risk: `QAOA-${qaoaCount + 1}`, riskId: `qaoa${qaoaCount}`,
        combo: `${stratName} + QAOA-${qaoaCount + 1}`,
        settings: sample.config, ...score,
      });
      qaoaCount++;
    }
  }

  // ═══ PHASE 2: SPSA Gradient Search — 15 iterations per top strategy ═══
  let spsaCount = 0;
  for (const stratId of Object.keys(byStrategy)) {
    const evaluate = makeEvaluator(stratId);
    if (!evaluate) continue;

    const bestForStrat = byStrategy[stratId][0];
    const spsaResults = spsaOptimize(bestForStrat.settings, evaluate, 15);

    for (const sr of spsaResults) {
      if (sr.trades > 0) {
        const stratName = strategies.find(s => s.id === stratId)?.name || stratId;
        allQuantumResults.push({
          strategy: stratName, strategyId: stratId,
          risk: `SPSA-${spsaCount + 1}`, riskId: `spsa${spsaCount}`,
          combo: `${stratName} + SPSA-${spsaCount + 1}`,
          settings: sr.config, ...sr,
        });
        spsaCount++;
      }
    }
  }

  // ═══ PHASE 3: Quantum Annealing — 20 steps from best overall ═══
  let annealCount = 0;
  // Anneal from the combined best (preset + genetic + QAOA + SPSA)
  const combinedTop = [...topN];
  if (allQuantumResults.length) {
    const sorted = [...allQuantumResults].sort((a, b) => b.winRate - a.winRate || b.totalPnl - a.totalPnl);
    combinedTop.push(...sorted.slice(0, 5));
  }

  const bestOverall = combinedTop[0];
  if (bestOverall) {
    const evaluate = makeEvaluator(bestOverall.strategyId);
    if (evaluate) {
      const annealResults = quantumAnneal(combinedTop.slice(0, 8), evaluate, 20);
      for (const ar of annealResults) {
        if (ar.trades > 0) {
          const stratName = strategies.find(s => s.id === bestOverall.strategyId)?.name || bestOverall.strategyId;
          allQuantumResults.push({
            strategy: stratName, strategyId: bestOverall.strategyId,
            risk: `QAnneal-${annealCount + 1}`, riskId: `anneal${annealCount}`,
            combo: `${stratName} + QAnneal-${annealCount + 1}`,
            settings: ar.config, ...ar,
          });
          annealCount++;
        }
      }
    }
  }

  return {
    results: allQuantumResults,
    stats: { qaoaCount, spsaCount, annealCount },
  };
}

module.exports = { quantumOptimize, qaoaSample, spsaOptimize, quantumAnneal };
