// ============================================================
// TokenAgent — Dedicated agent watching ONE token 24/7
//
// Uses the SAME strategy as smc-engine.js (AI-optimized):
//   - 4H + 1H HTF structure alignment
//   - AI-configured filters (daily bias, KL, 15m, 1m, vol)
//   - Kronos AI prediction check
//   - RSI + momentum safety guards
//   - Scalper AI confirmation
// ============================================================

const { BaseAgent } = require('./base-agent');
const { analyzeLHHL, SWING_LENGTHS } = require('../smc-engine');
const { log: bLog } = require('../bot-logger');

class TokenAgent extends BaseAgent {
  constructor(symbol, options = {}) {
    super(`${symbol.replace('USDT', '')}Agent`, options);
    this.symbol = symbol;
    this.coin = symbol.replace('USDT', '');
    this.lastSignal = null;
    this.signalCount = 0;
    this.lastPrice = 0;

    this._profile = {
      description: `Dedicated agent watching ${symbol} 24/7 using AI-optimized HTF strategy + Kronos.`,
      role: `${this.coin} Specialist`,
      icon: 'token',
      skills: [
        { id: 'htf_watch', name: `${this.coin} HTF Watch`, description: `Monitor ${symbol} 4H/1H structure for direction`, enabled: true },
        { id: 'kronos_check', name: 'Kronos AI', description: 'Kronos prediction score boost/penalty', enabled: true },
        { id: 'scalper_confirm', name: 'Scalper Confirmation', description: 'Composite oscillator entry filter', enabled: true },
        { id: 'memory', name: 'Memory', description: `Remember ${this.coin} patterns and history`, enabled: true },
        { id: 'self_learn', name: 'Self-Learning', description: `Learn ${this.coin} best setups`, enabled: true },
      ],
      config: [],
    };
  }

  async execute(context = {}) {
    this.currentTask = { description: `Scanning ${this.symbol}`, startedAt: Date.now() };
    bLog.scan(`[HEARTBEAT] ${this.name} starting execution...`);

    const aiLearner = require('../ai-learner');
    const aiParams = await aiLearner.getOptimalParams();

    // Build a ticker-like object for analyzeLHHL
    const fetch = require('node-fetch');
    let tickerPrice;
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${this.symbol}`, { timeout: 8000 });
      if (!res.ok) { this.currentTask = null; return null; }
      const data = await res.json();
      tickerPrice = parseFloat(data.price);
    } catch {
      this.currentTask = null;
      return null;
    }

    this.lastPrice = tickerPrice;

    const ticker = {
      symbol: this.symbol,
      lastPrice: String(tickerPrice),
    };

    // Use Kronos cached predictions if available from the coordinator
    const kronosPredictions = context.kronosPredictions || null;

    // Run the SAME analysis as smc-engine (4H+1H HTF, AI-configured filters, Kronos scoring)
    const signal = await analyzeLHHL(ticker, aiParams, context.dailyBiasCache || new Map(), kronosPredictions);

    if (!signal || !signal.direction) {
      this.currentTask = null;
      return { symbol: this.symbol, direction: null, status: 'no_signal' };
    }

    this.lastSignal = signal;
    this.signalCount++;
    this.addActivity('success', `SIGNAL: ${this.symbol} ${signal.direction} score=${signal.score} @ $${signal.price}`);
    bLog.scan(`[${this.name}] SIGNAL: ${this.symbol} ${signal.direction} score=${signal.score} 4h=${signal.structure?.tf4h} 1h=${signal.structure?.tf1h} 15m=${signal.structure?.tf15}`);

    // Memory: remember this signal (DB + Hermes file)
    if (this.isSkillEnabled('memory')) {
      await this.remember('last_signal', { direction: signal.direction, score: signal.score, price: signal.price, ts: Date.now() }, 'signals');
      const count = (await this.recall('total_signals')) || 0;
      await this.remember('total_signals', count + 1, 'stats');

      // Hermes persistent memory — survives across deployments
      const ts = new Date().toISOString().slice(0, 16);
      this.hermesRemember(
        `[${ts}] ${this.symbol} ${signal.direction} score=${signal.score} ` +
        `4h=${signal.structure?.tf4h || '?'} 1h=${signal.structure?.tf1h || '?'} ` +
        `price=$${signal.price}`
      );
    }

    this.currentTask = null;
    return signal;
  }

  getHealth() {
    return {
      ...super.getHealth(),
      symbol: this.symbol,
      lastPrice: this.lastPrice,
      signalCount: this.signalCount,
      lastSignal: this.lastSignal ? {
        direction: this.lastSignal.direction,
        score: this.lastSignal.score,
        ts: this.lastSignal.ts,
      } : null,
      tokenAgent: true,
      profile: this._profile,
    };
  }
}

module.exports = { TokenAgent };
