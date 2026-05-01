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
const { analyzeSymbol } = require('../trade-engine');
const { analyzeV3 } = require('../strategy-v3');
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

    // Fetch current price
    const fetch = require('node-fetch');
    let price;
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${this.symbol}`, { timeout: 8000 });
      if (!res.ok) { this.currentTask = null; return null; }
      const data = await res.json();
      price = parseFloat(data.price);
    } catch {
      this.currentTask = null;
      return null;
    }

    this.lastPrice = price;

    // ── Scan with strategy-v3 (analyzeV3) ─────────────────────────
    // analyzeV3 runs MSTF / VWAPTrend / LiqGrab / BreakRetest /
    // MomentumBreakout and applies the full gate stack we've been
    // tuning per-PR (counter-trend filter, 10-bar range pos, pause
    // gate with extreme-zone skip, 15m-only-blocks-when-confirmed).
    // The older trade-engine analyzeSymbol path only ran the rare
    // TEN_CANDLE_EXTREME setup which almost never fired — that's
    // why TokenAgents missed every recent reversal.
    let signal = null;
    try {
      signal = await analyzeV3({ symbol: this.symbol, lastPrice: String(price) });
    } catch (e) {
      bLog.error(`[${this.name}] analyzeV3 failed: ${e.message} — falling back to analyzeSymbol`);
    }

    // Fallback: if v3 produced nothing, try the legacy trade-engine
    // (TEN_CANDLE_EXTREME) so we don't lose what little signal it gives.
    if (!signal || !signal.direction) {
      signal = await analyzeSymbol(this.symbol, price, context.kronosPredictions || null);
    }

    if (!signal || !signal.direction) {
      this.currentTask = null;
      return { symbol: this.symbol, direction: null, status: 'no_signal' };
    }

    this.lastSignal = signal;
    this.signalCount++;
    this.addActivity('success', `SIGNAL: ${this.symbol} ${signal.direction} [${signal.setupName}] score=${signal.score} @ $${price}`);
    bLog.scan(`[${this.name}] SIGNAL: ${this.symbol} ${signal.direction} [${signal.setupName}] score=${signal.score}`);

    // Memory
    if (this.isSkillEnabled('memory')) {
      await this.remember('last_signal', { direction: signal.direction, score: signal.score, price, ts: Date.now() }, 'signals');
      const count = (await this.recall('total_signals')) || 0;
      await this.remember('total_signals', count + 1, 'stats');
      const ts = new Date().toISOString().slice(0, 16);
      this.hermesRemember(`[${ts}] ${this.symbol} ${signal.direction} [${signal.setupName}] score=${signal.score} price=$${price}`);
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
