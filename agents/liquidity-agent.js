'use strict';

// ============================================================
// LiquidityAgent
//
// Reads chart-derived EQH/EQL pools and gates trades by likely
// draw-on-liquidity. It is a risk/quality filter, not an oracle.
//
// Optional external liquidation bias can be injected by setting
// LIQUIDITY_EXTERNAL_URL to a JSON endpoint that returns either:
//   { "BTCUSDT": { "bias": "SHORT", "confidence": 0.7 } }
// or { "symbol":"BTCUSDT", "bias":"LONG", "confidence":0.6 }
// ============================================================

const { BaseAgent } = require('./base-agent');
const { log: bLog } = require('../bot-logger');
const {
  fetchCandles,
  detectPivots,
  detectLiquidityPools,
} = require('../smc-engine');

const DEFAULTS = {
  enabled: process.env.LIQUIDITY_AGENT !== '0',
  minScore: parseFloat(process.env.LIQUIDITY_AGENT_MIN_SCORE || '62'),
  minTargetPct: parseFloat(process.env.LIQUIDITY_MIN_TARGET_PCT || '0.18'),
  maxTargetPct: parseFloat(process.env.LIQUIDITY_MAX_TARGET_PCT || '3.00'),
  oppositeNearPct: parseFloat(process.env.LIQUIDITY_OPPOSITE_NEAR_PCT || '0.35'),
  latePoolPct: parseFloat(process.env.LIQUIDITY_LATE_POOL_PCT || '0.12'),
  sweepLookback: parseInt(process.env.LIQUIDITY_SWEEP_LOOKBACK || '18', 10),
  externalUrl: process.env.LIQUIDITY_EXTERNAL_URL || '',
  externalEnabled: process.env.LIQUIDITY_EXTERNAL_ENABLED === '1',
  externalTimeoutMs: parseInt(process.env.LIQUIDITY_EXTERNAL_TIMEOUT_MS || '2500', 10),
};

class LiquidityAgent extends BaseAgent {
  constructor(options = {}) {
    super('LiquidityAgent', options);
    this.enabled = DEFAULTS.enabled;
    this.minScore = DEFAULTS.minScore;
    this.minTargetPct = DEFAULTS.minTargetPct;
    this.maxTargetPct = DEFAULTS.maxTargetPct;
    this.oppositeNearPct = DEFAULTS.oppositeNearPct;
    this.latePoolPct = DEFAULTS.latePoolPct;
    this.sweepLookback = DEFAULTS.sweepLookback;
    this.externalUrl = DEFAULTS.externalUrl;
    this.externalEnabled = DEFAULTS.externalEnabled;
    this.externalTimeoutMs = DEFAULTS.externalTimeoutMs;
    this.decisions = 0;
    this.approved = 0;
    this.rejected = 0;
    this.lastReport = null;

    this._profile = {
      description: 'EQH/EQL liquidity map gate. Checks whether price is drawing toward buy-side or sell-side liquidity before trade execution.',
      role: 'Liquidity Mapper',
      icon: 'liquidity',
      skills: [
        { id: 'eqh_eql_map', name: 'EQH/EQL Map', description: 'Finds buy-side and sell-side liquidity pools from pivots', enabled: true },
        { id: 'sweep_rejection', name: 'Sweep Rejection', description: 'Detects wick sweep and close-back reversal behavior', enabled: true },
        { id: 'external_liquidity', name: 'External Liquidity Bias', description: 'Optionally consumes liquidation bias from a configured JSON endpoint', enabled: this.externalEnabled },
      ],
      config: [
        { key: 'enabled', label: 'Enabled', type: 'boolean', value: this.enabled },
        { key: 'minScore', label: 'Minimum Liquidity Score', type: 'number', value: this.minScore, min: 0, max: 100 },
        { key: 'minTargetPct', label: 'Minimum Target Distance %', type: 'number', value: this.minTargetPct, min: 0.01, max: 2 },
        { key: 'maxTargetPct', label: 'Maximum Target Distance %', type: 'number', value: this.maxTargetPct, min: 0.5, max: 10 },
      ],
    };
  }

  async execute(context = {}) {
    const { signals = [] } = context;
    if (!signals.length) return { approved: [], rejected: [], report: this._buildReport([], []) };

    const approved = [];
    const rejected = [];

    for (const signal of signals) {
      const decision = await this._evaluateSignal(signal);
      this.decisions++;

      if (decision.pass || !this.enabled) {
        const sizeMod = this._sizeMod(signal, decision);
        approved.push({
          ...signal,
          liquidityDecision: decision,
          sizeMod: Math.max(0.1, Math.min(2, (signal.sizeMod || 1) * sizeMod.mod)),
          sizeReason: [signal.sizeReason, sizeMod.reason].filter(Boolean).join(' | '),
          score: Math.max(signal.score || 0, decision.score),
        });
        this.approved++;
        this.addActivity('success', `Approved ${signal.symbol} ${signal.direction}: ${decision.summary}`);
      } else {
        rejected.push({ signal, reasons: decision.reasons, decision });
        this.rejected++;
        this.addActivity('skip', `Rejected ${signal.symbol} ${signal.direction}: ${decision.reasons[0]}`);
      }
    }

    this.lastReport = this._buildReport(approved, rejected);
    bLog.scan(`[LIQ] approved=${approved.length}/${signals.length} rejected=${rejected.length}`);
    return { approved, rejected, report: this.lastReport };
  }

  async _evaluateSignal(signal) {
    const symbol = signal.symbol || signal.sym;
    const dir = signal.direction;
    const reasons = [];
    let score = signal.score || 0;

    const map = await this._buildLiquidityMap(symbol);
    const current = map.current;
    if (!current) {
      return {
        pass: true,
        score,
        reasons: [],
        summary: `liquidity map unavailable - allowing ${dir} with existing risk gates`,
        liquidity: map,
        unavailable: true,
      };
    }

    const targetType = dir === 'SHORT' ? 'SSL' : 'BSL';
    const dangerType = dir === 'SHORT' ? 'BSL' : 'SSL';
    const target = this._nearestPool(map.pools, targetType, current);
    const danger = this._nearestPool(map.pools, dangerType, current);
    const sweep = this._recentSweep(map.candles15m, [...map.pools15m, ...map.pools1h], dir);
    const external = await this._externalBias(symbol);

    if (!target) {
      reasons.push(dir === 'SHORT' ? 'no EQL/SSL target below price' : 'no EQH/BSL target above price');
      score -= 12;
    } else {
      score += Math.min(15, 4 + target.count * 2);
      if (target.distancePct < this.minTargetPct) {
        reasons.push(`${target.label} target is too close (${target.distancePct.toFixed(2)}%)`);
        score -= 10;
      }
      if (target.distancePct > this.maxTargetPct) {
        reasons.push(`${target.label} target too far (${target.distancePct.toFixed(2)}%)`);
        score -= 8;
      }
      if (target.distancePct <= this.latePoolPct && !sweep.aligned) {
        reasons.push(`late entry near ${target.label} without sweep rejection`);
        score -= 15;
      }
    }

    if (danger && target && danger.distancePct < target.distancePct && danger.distancePct <= this.oppositeNearPct) {
      reasons.push(`${danger.label} opposite liquidity is closer (${danger.distancePct.toFixed(2)}%)`);
      score -= 14;
    }

    if (sweep.aligned) score += 14;
    if (sweep.conflict) {
      reasons.push(sweep.reason);
      score -= 14;
    }

    if (external.bias) {
      if (external.bias === dir) score += Math.round(8 * external.confidence);
      if (external.bias !== dir && external.confidence >= 0.6) {
        reasons.push(`external liquidation bias ${external.bias} conflicts`);
        score -= Math.round(10 * external.confidence);
      }
    }

    const pass = reasons.length === 0 && score >= this.minScore;
    if (reasons.length === 0 && score < this.minScore) {
      reasons.push(`liquidity score ${score.toFixed(0)} < ${this.minScore}`);
    }

    return {
      pass,
      score,
      reasons,
      summary: this._summary(dir, score, target, danger, sweep, external),
      liquidity: {
        current,
        target,
        danger,
        sweep,
        external,
        pools: map.pools.slice(0, 8),
      },
    };
  }

  async _buildLiquidityMap(symbol) {
    try {
      const [candles15m, candles1h] = await Promise.all([
        fetchCandles(symbol, '15', 220),
        fetchCandles(symbol, '60', 220),
      ]);
      const pivots15m = detectPivots(candles15m, 2, 2);
      const pivots1h = detectPivots(candles1h, 2, 2);
      const pools15m = this._tagPools(detectLiquidityPools(candles15m, pivots15m, 0.0018), '15m');
      const pools1h = this._tagPools(detectLiquidityPools(candles1h, pivots1h, 0.0022), '1h');
      const current = candles15m[candles15m.length - 1]?.c || candles1h[candles1h.length - 1]?.c || null;
      const pools = [...pools15m, ...pools1h]
        .map(p => this._withDistance(p, current))
        .filter(p => Number.isFinite(p.distancePct))
        .sort((a, b) => b.count - a.count || a.distancePct - b.distancePct);

      return { current, candles15m, candles1h, pools15m, pools1h, pools };
    } catch (err) {
      return { current: null, candles15m: [], candles1h: [], pools15m: [], pools1h: [], pools: [], error: err.message };
    }
  }

  _tagPools(pools, timeframe) {
    return (pools || []).map(p => ({ ...p, timeframe }));
  }

  _withDistance(pool, current) {
    const distancePct = current ? Math.abs(pool.level - current) / current * 100 : NaN;
    const side = pool.level >= current ? 'above' : 'below';
    return { ...pool, distancePct, side };
  }

  _nearestPool(pools, type, current) {
    const side = type === 'BSL' ? 'above' : 'below';
    return (pools || [])
      .filter(p => p.type === type && p.side === side)
      .map(p => this._withDistance(p, current))
      .sort((a, b) => a.distancePct - b.distancePct || b.count - a.count)[0] || null;
  }

  _recentSweep(candles, pools, dir) {
    const recent = (candles || []).slice(-this.sweepLookback);
    if (!recent.length || !pools?.length) return { aligned: false, conflict: false, label: 'none' };

    const sweptBSL = this._sweptPool(recent, pools.filter(p => p.type === 'BSL'));
    const sweptSSL = this._sweptPool(recent, pools.filter(p => p.type === 'SSL'));

    if (dir === 'SHORT' && sweptBSL) return { aligned: true, conflict: false, label: 'EQH sweep rejection', level: sweptBSL.level };
    if (dir === 'LONG' && sweptSSL) return { aligned: true, conflict: false, label: 'EQL sweep rejection', level: sweptSSL.level };
    if (dir === 'SHORT' && sweptSSL) return { aligned: false, conflict: true, label: 'EQL swept', reason: 'sell-side liquidity already swept; short is late', level: sweptSSL.level };
    if (dir === 'LONG' && sweptBSL) return { aligned: false, conflict: true, label: 'EQH swept', reason: 'buy-side liquidity already swept; long is late', level: sweptBSL.level };
    return { aligned: false, conflict: false, label: 'none' };
  }

  _sweptPool(candles, pools) {
    for (const pool of pools || []) {
      const swept = candles.some(c => {
        if (pool.type === 'BSL') return c.h > pool.level && c.c < pool.level;
        return c.l < pool.level && c.c > pool.level;
      });
      if (swept) return pool;
    }
    return null;
  }

  async _externalBias(symbol) {
    if (!this.externalEnabled || !this.externalUrl) return { bias: null, confidence: 0, source: 'disabled' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.externalTimeoutMs);
    try {
      const sep = this.externalUrl.includes('?') ? '&' : '?';
      const res = await fetch(`${this.externalUrl}${sep}symbol=${encodeURIComponent(symbol)}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`external ${res.status}`);
      const data = await res.json();
      const row = data?.[symbol] || data;
      const bias = String(row?.bias || row?.direction || '').toUpperCase();
      const confidence = Math.max(0, Math.min(1, parseFloat(row?.confidence ?? row?.score ?? 0)));
      return ['LONG', 'SHORT'].includes(bias)
        ? { bias, confidence, source: this.externalUrl }
        : { bias: null, confidence: 0, source: this.externalUrl };
    } catch (err) {
      return { bias: null, confidence: 0, source: this.externalUrl, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  _sizeMod(signal, decision) {
    if (decision.score >= 90 && decision.liquidity?.sweep?.aligned) {
      return { mod: 1.2, reason: `liquidity aligned score=${decision.score.toFixed(0)} sweep=${decision.liquidity.sweep.label}` };
    }
    if (decision.score >= 78) {
      return { mod: 1.0, reason: `liquidity aligned score=${decision.score.toFixed(0)}` };
    }
    return { mod: 0.75, reason: `liquidity cautious score=${decision.score.toFixed(0)}` };
  }

  _summary(dir, score, target, danger, sweep, external) {
    const targetTxt = target ? `${target.label}/${target.timeframe} ${target.distancePct.toFixed(2)}% ${target.side}` : 'no target';
    const dangerTxt = danger ? `${danger.label}/${danger.timeframe} ${danger.distancePct.toFixed(2)}% ${danger.side}` : 'no opposite';
    const extTxt = external?.bias ? ` external=${external.bias}@${external.confidence.toFixed(2)}` : '';
    return `${dir} score=${score.toFixed(0)} target=${targetTxt} opposite=${dangerTxt} sweep=${sweep.label}${extTxt}`;
  }

  _buildReport(approved, rejected) {
    return {
      ts: Date.now(),
      enabled: this.enabled,
      approved: approved.length,
      rejected: rejected.length,
      rejectedReasons: rejected.map(r => ({
        symbol: r.signal.symbol,
        direction: r.signal.direction,
        reasons: r.reasons,
      })),
      totalDecisions: this.decisions,
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      enabled: this.enabled,
      decisions: this.decisions,
      approved: this.approved,
      rejected: this.rejected,
      lastReport: this.lastReport,
    };
  }
}

module.exports = { LiquidityAgent };
