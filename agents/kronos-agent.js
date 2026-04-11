// ============================================================
// KronosAgent — Dedicated Kronos AI prediction runner
//
// Runs Swarm Simulation predictions on its own schedule, persists to DB,
// and shares consolidated insights with other agents via messaging.
// ============================================================

const { BaseAgent } = require('./base-agent');
const swarmEngine = require('./swarm-engine');

class KronosAgent extends BaseAgent {
  constructor(options = {}) {
    super('KronosAgent', options);
    this._profile = {
      description: 'Runs MiroFish-style Swarm AI simulations and shares forecasts with the team.',
      role: 'AI Oracle',
      icon: 'kronos',
      skills: [
        { id: 'predict', name: 'Predict', description: 'Run Swarm simulations on all tokens', enabled: true },
        { id: 'share', name: 'Share Insights', description: 'Broadcast consolidated predictions to other agents', enabled: true },
      ],
      config: [
        { key: 'interval', label: 'Candle Interval', type: 'string', value: '15m' },
        { key: 'predLen', label: 'Prediction Length', type: 'number', value: 20, min: 5, max: 50 },
        { key: 'concurrency', label: 'Parallel Predictions', type: 'number', value: 3, min: 1, max: 6 },
      ],
    };
    this.lastPredictions = new Map();
    this.scanCount = 0;
    this.totalPredictions = 0;
    this.highConfCount = 0;
  }

  async execute(context = {}) {
    const symbols = context.symbols || [];
    if (!symbols.length) {
      this.addActivity('skip', 'No symbols to predict');
      return { predictions: 0 };
    }

    const interval = this.getConfig().interval || '15m';
    const predLen = this.getConfig().predLen || 20;
    const concurrency = this.getConfig().concurrency || 3;

    this.currentTask = { description: `Simulating ${symbols.length} tokens...`, startedAt: Date.now() };
    this.addActivity('info', `Running Swarm Simulations for ${symbols.length} tokens...`);

    const kronos = require('../kronos');
    const startTime = Date.now();

    let predictions = new Map();
    try {
      // 1. Get Seeds for all tokens
      const seedResults = await kronos.scanAllTokens(symbols, interval, predLen, concurrency);

      // 2. Run Swarm Simulation for each seed
      const swarmResults = [];
      for (const [symbol, seeds] of seedResults.entries()) {
        const result = await swarmEngine.runSwarm(symbol, seeds);
        if (result) {
          predictions.set(symbol, result);
          swarmResults.push(result);
        }
      }
    } catch (err) {
      this.addActivity('error', `Swarm scan failed: ${err.message}`);
      return { predictions: 0, error: err.message };
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.scanCount++;
    this.totalPredictions += predictions.size;

    // Analyze results
    const results = Array.from(predictions.values());
    const longs = results.filter(r => r.direction === 'LONG');
    const shorts = results.filter(r => r.direction === 'SHORT');
    const highConf = results.filter(r => r.confidence >= 70); // Swarm confidence threshold
    this.highConfCount += highConf.length;

    this.lastPredictions = predictions;

    // Share insights with other agents via messaging
    if (context.coordinator) {
      const coord = context.coordinator;

      // Tell RiskAgent about high-confidence swarm predictions
      if (highConf.length > 0 && coord.riskAgent) {
        coord.riskAgent.receive({
          from: 'KronosAgent', type: 'kronos-predictions',
          payload: {
            highConf: highConf.map(p => ({
              symbol: p.symbol,
              direction: p.direction,
              confidence: p.confidence,
              target: p.target_price,
              logic: p.swarm_logic
            }))
          },
          ts: Date.now(),
        });
      }

      // Tell TraderAgent about strong consolidated signals
      if (coord.traderAgent) {
        const strong = results.filter(r => r.confidence >= 80);
        if (strong.length > 0) {
          coord.traderAgent.receive({
            from: 'KronosAgent', type: 'kronos-signals',
            payload: {
              signals: strong.map(p => ({
                symbol: p.symbol,
                direction: p.direction,
                confidence: p.confidence,
                target: p.target_price
              }))
            },
            ts: Date.now(),
          });
          this.addActivity('info', `Shared ${strong.length} high-conf swarm signals with TraderAgent`);
        }
      }

      // Tell SentimentAgent about market bias
      if (coord.sentimentAgent) {
        const bias = longs.length > shorts.length * 1.5 ? 'bullish' : shorts.length > longs.length * 1.5 ? 'bearish' : 'mixed';
        coord.sentimentAgent.receive({
          from: 'KronosAgent', type: 'kronos-bias',
          payload: { bias, longs: longs.length, shorts: shorts.length, total: results.length },
          ts: Date.now(),
        });
      }

      // Share team memory summary
      this.shareWithTeam(`Swarm Scan #${this.scanCount}: ${results.length} simulations in ${elapsed}s — ${longs.length} LONG, ${shorts.length} SHORT, ${highConf.length} high-conf`);
    }

    // Learn from high-confidence predictions
    if (highConf.length > 0) {
      const topPred = highConf[0];
      this.learn('prediction', { symbol: topPred.symbol, direction: topPred.direction }, { target: topPred.target_price }, `Swarm confidence ${topPred.confidence}% ${topPred.direction} on ${topPred.symbol}`, topPred.confidence).catch(() => {});
    }

    const summary = `${results.length} simulations in ${elapsed}s — ${longs.length} LONG, ${shorts.length} SHORT, ${highConf.length} high-conf`;
    this.addActivity('success', summary);
    this.currentTask = null;

    return {
      predictions: results.length,
      longs: longs.length,
      shorts: shorts.length,
      highConf: highConf.length,
      elapsed: parseFloat(elapsed),
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      scanCount: this.scanCount,
      totalPredictions: this.totalPredictions,
      highConfCount: this.highConfCount,
      lastPredictionCount: this.lastPredictions.size,
    };
  }
}

module.exports = { KronosAgent };
