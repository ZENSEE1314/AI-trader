// ============================================================
// TokenAgent — Dedicated agent watching ONE token 24/7
//
// Each instance monitors a single token's 15m/3m/1m structure.
// When triple HL/LH aligns, fires signal immediately.
// Never misses a move because it's laser-focused on one coin.
// ============================================================

const { BaseAgent } = require('./base-agent');
const fetch = require('node-fetch');
const { detectSwings, SWING_LENGTHS } = require('../smc-engine');
const { confirmSignal } = require('../scalper-ai');
const { log: bLog } = require('../bot-logger');

function getStructure(klines, len) {
  const swings = detectSwings(klines, len);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');
  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    highLabels.push({ ...swingHighs[i], label: swingHighs[i].price > swingHighs[i-1].price ? 'HH' : 'LH' });
  }
  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    lowLabels.push({ ...swingLows[i], label: swingLows[i].price > swingLows[i-1].price ? 'HL' : 'LL' });
  }
  const lastHigh = highLabels.length ? highLabels[highLabels.length-1] : null;
  const lastLow = lowLabels.length ? lowLabels[lowLabels.length-1] : null;
  return {
    hasHL: !!lowLabels.find(l => l.label === 'HL'),
    hasLH: !!highLabels.find(l => l.label === 'LH'),
    lastHigh, lastLow,
    label: `${lastHigh?.label || '?'}/${lastLow?.label || '?'}`,
  };
}

async function fetchKlines(symbol, interval, limit = 100) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { timeout: 10000 });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// Capital-based risk: 10% SL, 20% TP (divided by leverage at trade time)
const CAPITAL_SL = 0.10;
const CAPITAL_TP = 0.20;

class TokenAgent extends BaseAgent {
  constructor(symbol, options = {}) {
    super(`${symbol.replace('USDT', '')}Agent`, options);
    this.symbol = symbol;
    this.coin = symbol.replace('USDT', '');
    this.lastSignal = null;
    this.signalCount = 0;
    this.missedCount = 0;
    this.lastPrice = 0;
    this.struct15m = null;
    this.struct3m = null;
    this.struct1m = null;

    this._profile = {
      description: `Dedicated agent watching ${symbol} 24/7 for SMC triple HL/LH signals.`,
      role: `${this.coin} Specialist`,
      icon: 'token',
      skills: [
        { id: 'smc_watch', name: `${this.coin} SMC Watch`, description: `Monitor ${symbol} 15m/3m/1m structure continuously`, enabled: true },
        { id: 'volume_check', name: 'Volume Confirmation', description: 'Verify directional volume before signaling', enabled: true },
        { id: 'pullback_check', name: 'Pullback Filter', description: 'Only LONG at bottom, SHORT at top of range', enabled: true },
        { id: 'memory', name: 'Memory', description: `Remember ${this.coin} patterns and win/loss history`, enabled: true },
        { id: 'self_learn', name: 'Self-Learning', description: `Learn ${this.coin} best entry times and setups`, enabled: true },
      ],
      config: [],
    };
  }

  async execute(context = {}) {
    this.currentTask = { description: `Scanning ${this.symbol}`, startedAt: Date.now() };

    // Fetch all timeframes (added 1h for trend filter)
    const [klines1h, klines15m, klines3m, klines1m] = await Promise.all([
      fetchKlines(this.symbol, '1h', 25),
      fetchKlines(this.symbol, '15m', 100),
      fetchKlines(this.symbol, '3m', 100),
      fetchKlines(this.symbol, '1m', 100),
    ]);

    if (!klines1h || !klines15m || !klines3m || !klines1m) {
      this.currentTask = null;
      return null;
    }
    if (klines15m.length < 30 || klines3m.length < 15 || klines1m.length < 15) {
      this.currentTask = null;
      return null;
    }

    this.lastPrice = parseFloat(klines1m[klines1m.length-1][4]);

    // Structure analysis
    this.struct15m = getStructure(klines15m, SWING_LENGTHS['15m']);
    this.struct3m = getStructure(klines3m, SWING_LENGTHS['3m'] || 5);
    this.struct1m = getStructure(klines1m, SWING_LENGTHS['1m']);

    // Triple alignment check
    let direction = null;
    if (this.struct15m.hasHL && this.struct3m.hasHL && this.struct1m.hasHL) direction = 'LONG';
    else if (this.struct15m.hasLH && this.struct3m.hasLH && this.struct1m.hasLH) direction = 'SHORT';

    if (!direction) {
      this.currentTask = null;
      return { symbol: this.symbol, direction: null, status: 'watching' };
    }

    // 1H trend filter — don't LONG in downtrend, don't SHORT in uptrend
    // Price must be on the right side of the 1H 20-period moving average
    if (klines1h.length >= 20) {
      const closes1h = klines1h.slice(-20).map(k => parseFloat(k[4]));
      const ma20 = closes1h.reduce((a, b) => a + b, 0) / closes1h.length;
      if (direction === 'LONG' && this.lastPrice < ma20) {
        this.currentTask = null;
        return { symbol: this.symbol, direction: null, status: 'below_1h_ma' };
      }
      if (direction === 'SHORT' && this.lastPrice > ma20) {
        this.currentTask = null;
        return { symbol: this.symbol, direction: null, status: 'above_1h_ma' };
      }
    }

    // Recency check — 1m swing must be within last 10 candles
    const lastIdx = klines1m.length - 1;
    const entrySwing = direction === 'LONG' ? this.struct1m.lastLow : this.struct1m.lastHigh;
    if (!entrySwing || (lastIdx - entrySwing.index) > 10) {
      this.currentTask = null;
      return { symbol: this.symbol, direction: null, status: 'stale_swing' };
    }

    // Pullback filter — 30min range
    const rangeCandles = klines1m.slice(-30);
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (const k of rangeCandles) {
      const h = parseFloat(k[2]), l = parseFloat(k[3]);
      if (h > rangeHigh) rangeHigh = h;
      if (l < rangeLow) rangeLow = l;
    }
    const rangeSize = rangeHigh - rangeLow;
    if (rangeSize > 0) {
      const pos = (this.lastPrice - rangeLow) / rangeSize;
      if (direction === 'LONG' && pos > 0.60) {
        this.currentTask = null;
        return { symbol: this.symbol, direction: null, status: 'too_high' };
      }
      if (direction === 'SHORT' && pos < 0.40) {
        this.currentTask = null;
        return { symbol: this.symbol, direction: null, status: 'too_low' };
      }
    }

    // Volume confirmation
    const recent15 = klines15m.slice(-10);
    let buyVol = 0, sellVol = 0;
    for (const k of recent15) {
      const o = parseFloat(k[1]), c = parseFloat(k[4]), v = parseFloat(k[5]);
      if (c >= o) buyVol += v; else sellVol += v;
    }
    const total = buyVol + sellVol;
    if (total > 0) {
      if (direction === 'LONG' && buyVol / total < 0.50) {
        this.currentTask = null;
        return { symbol: this.symbol, direction: null, status: 'no_buy_volume' };
      }
      if (direction === 'SHORT' && sellVol / total < 0.50) {
        this.currentTask = null;
        return { symbol: this.symbol, direction: null, status: 'no_sell_volume' };
      }
    }

    // Scalper AI confirmation
    const scalper = confirmSignal(klines15m, direction);
    if (!scalper.confirmed) {
      this.currentTask = null;
      return { symbol: this.symbol, direction: null, status: 'scalper_blocked' };
    }

    // Score
    let score = 15;
    score += scalper.score;

    // Build signal — SL/TP scaled by leverage
    const price = this.lastPrice;
    const leverage = this.symbol === 'BTCUSDT' || this.symbol === 'ETHUSDT' ? 100 : 20;
    const slPct = CAPITAL_SL / leverage;  // 10%/20x = 0.5% price
    const tpPct = CAPITAL_TP / leverage;  // 20%/20x = 1% price
    const sl = direction === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);
    const tp = direction === 'LONG' ? price * (1 + tpPct) : price * (1 - tpPct);

    const signal = {
      symbol: this.symbol,
      direction,
      price,
      lastPrice: price,
      sl, tp1: tp, tp2: tp, tp3: tp,
      slDist: slPct,
      leverage,
      score,
      setup: `TRIPLE_${direction}`,
      setupName: `${direction}-${this.coin}`,
      structure: { tf15: this.struct15m.label, tf3: this.struct3m.label, tf1: this.struct1m.label },
    };

    this.lastSignal = signal;
    this.signalCount++;
    this.addActivity('success', `SIGNAL: ${this.symbol} ${direction} score=${score} @ $${price}`);
    bLog.scan(`[${this.name}] SIGNAL: ${this.symbol} ${direction} score=${score} 15m=${this.struct15m.label} 3m=${this.struct3m.label} 1m=${this.struct1m.label}`);

    // Memory: remember this signal
    if (this.isSkillEnabled('memory')) {
      await this.remember(`last_signal`, { direction, score, price, ts: Date.now() }, 'signals');
      const count = (await this.recall('total_signals')) || 0;
      await this.remember('total_signals', count + 1, 'stats');
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
      structure: {
        tf15m: this.struct15m?.label || '--',
        tf3m: this.struct3m?.label || '--',
        tf1m: this.struct1m?.label || '--',
      },
      tokenAgent: true,
    };
  }
}

module.exports = { TokenAgent };
