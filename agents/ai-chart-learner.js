// ============================================================
// AIChartLearner — 24/7 Ollama-powered chart learning agent
//
// Runs continuously to:
//   1. Analyze live candle patterns for each token via Ollama
//   2. Review every closed trade (win/loss) — extract lessons
//   3. Build symbol+pattern intelligence scores
//   4. Surface blockers/boosters to SMCPatternAgent in real time
//
// Ollama failover chain (ordered by capability):
//   gpt-oss:120b-cloud → gemma3:27b-cloud → gemma3:4b → hermes3:3b
//   If all fail → continue without AI gate (never halts trading)
//
// Env var OLLAMA_URL — defaults to http://localhost:11434
// ============================================================

'use strict';

const fetch         = require('node-fetch');
const { BaseAgent } = require('./base-agent');
const { log: bLog } = require('../bot-logger');
const { query }     = require('../db');
const {
  fetchCandles,
  TRADING_CONFIG,
} = require('../smc-engine');

// ── Config ───────────────────────────────────────────────────
const OLLAMA_URL   = process.env.OLLAMA_URL || 'http://localhost:11434';
const AGENT_NAME   = 'AIChartLearner';

// Model failover chain — tries each in order, skips unavailable ones
const MODEL_CHAIN  = [
  'gpt-oss:120b-cloud',
  'gemma3:27b-cloud',
  'gemma3:4b',
  'hermes3:3b',
];

const CHART_SCAN_INTERVAL_MS    = 15 * 60_000;  // analyze charts every 15 min
const RETRO_SCAN_INTERVAL_MS    = 60 * 60_000;  // retrospective every 1 hour
const OLD_CHART_SCAN_INTERVAL_MS = 4 * 60 * 60_000; // deep history scan every 4 hours
const OLLAMA_TIMEOUT_MS          = 90_000;       // 90s per Ollama call

// Min AI confidence to influence pattern blocking (0–100)
const AI_CONFIDENCE_THRESHOLD = 55;

const SYMBOLS = Object.keys(TRADING_CONFIG);

// ── Ollama client with failover ───────────────────────────────

let _availableModels = null; // cached after first probe

async function probeModels() {
  try {
    const res  = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 10_000 });
    const data = await res.json();
    const installed = (data.models || []).map(m => m.name);
    _availableModels = MODEL_CHAIN.filter(m => installed.includes(m));
    bLog.scan(`[AI-LEARN] Ollama models available: ${_availableModels.join(', ') || 'none'}`);
    return _availableModels;
  } catch (err) {
    bLog.error(`[AI-LEARN] Ollama probe failed: ${err.message}`);
    _availableModels = [];
    return [];
  }
}

async function ollamaChat(prompt, opts = {}) {
  const models = _availableModels ?? await probeModels();
  if (!models.length) throw new Error('No Ollama models available');

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: 0.1, num_predict: 300, ...opts },
          messages: [
            { role: 'system', content: 'You are a crypto market structure analyst. Reply ONLY valid JSON, no markdown, no explanation outside the JSON.' },
            { role: 'user',   content: prompt },
          ],
        }),
      });

      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = data.message?.content?.trim() ?? '';
      return { text, model };
    } catch (err) {
      bLog.error(`[AI-LEARN] model ${model} failed: ${err.message} — trying next`);
    }
  }
  throw new Error('All Ollama models failed');
}

function parseJSON(text) {
  // Strip markdown fences if model wrapped in them
  const cleaned = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting the first {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// Compact candle summary for prompt (OHLCV, last N bars)
function candleSummary(bars, n = 20) {
  const slice = bars.slice(-n);
  return slice.map(b =>
    `${new Date(b.t).toISOString().slice(11,16)} O=${b.o.toFixed(2)} H=${b.h.toFixed(2)} L=${b.l.toFixed(2)} C=${b.c.toFixed(2)}`
  ).join('\n');
}

// Simple pivot detection (1L/2R) — same as smc-engine
function lastPivots(bars) {
  if (!bars || bars.length < 6) return { lh: null, hl: null };
  const ph = [], pl = [];
  for (let i = 1; i < bars.length - 2; i++) {
    if (bars[i].h > bars[i-1].h && bars[i].h > bars[i+1].h && bars[i].h > bars[i+2].h)
      ph.push({ idx: i, price: bars[i].h });
    if (bars[i].l < bars[i-1].l && bars[i].l < bars[i+1].l && bars[i].l < bars[i+2].l)
      pl.push({ idx: i, price: bars[i].l });
  }
  const lastH = ph[ph.length - 1], prevH = ph[ph.length - 2];
  const lastL = pl[pl.length - 1], prevL = pl[pl.length - 2];
  const lh = (lastH && prevH && lastH.price < prevH.price) ? lastH : null;
  const hl = (lastL && prevL && lastL.price > prevL.price) ? lastL : null;
  return { lh, hl };
}

// ── Agent ─────────────────────────────────────────────────────

class AIChartLearner extends BaseAgent {
  constructor(options = {}) {
    super(AGENT_NAME, options);

    this._lastChartScan  = 0;
    this._lastRetroScan  = 0;
    this._lastOldScan    = 0;
    this._totalAnalyzed  = 0;
    this._totalLessons   = 0;

    // AI insight cache: 'BTCUSDT_LH' → { confidence, direction, reason, ts }
    // Shared with SMCPatternAgent via module-level export
    this._insights = new Map();
  }

  async init() {
    await super.init();
    await probeModels();
    bLog.scan(`[AI-LEARN] Agent ready. Ollama: ${OLLAMA_URL}`);
    this.addActivity('info', `AI Chart Learner ready — Ollama at ${OLLAMA_URL}`);
  }

  async execute(context = {}) {
    const now = Date.now();

    // Chart scan every 15 min
    if (now - this._lastChartScan >= CHART_SCAN_INTERVAL_MS) {
      this._lastChartScan = now;
      await this._runChartScan();
    }

    // Retrospective every 1 hour
    if (now - this._lastRetroScan >= RETRO_SCAN_INTERVAL_MS) {
      this._lastRetroScan = now;
      await this._runRetrospective();
    }

    // Deep old-chart scan every 4 hours
    if (now - this._lastOldScan >= OLD_CHART_SCAN_INTERVAL_MS) {
      this._lastOldScan = now;
      await this._runOldChartScan();
    }

    return {
      analyzed:     this._totalAnalyzed,
      lessons:      this._totalLessons,
      insightCount: this._insights.size,
    };
  }

  // ── Chart scan — analyze live 15m + 1m for each token ──────

  async _runChartScan() {
    bLog.scan('[AI-LEARN] Starting chart scan...');
    this.addActivity('info', 'AI chart scan — analyzing all tokens');

    for (const sym of SYMBOLS) {
      try {
        const [bars15m, bars1m] = await Promise.all([
          fetchCandles(sym, '15', 60),
          fetchCandles(sym, '1',  30),
        ]);
        if (!bars15m?.length || !bars1m?.length) continue;

        const p15 = lastPivots(bars15m);
        const p1  = lastPivots(bars1m);
        const cur = bars15m[bars15m.length - 1];

        // Build a compact prompt
        const prompt = `
Analyze this ${sym} 15min chart (UTC, last 20 bars):
${candleSummary(bars15m, 20)}

Current price: ${cur.c.toFixed(4)}
15min pivots detected: ${p15.lh ? `LH at ${p15.lh.price.toFixed(4)}` : 'no LH'}, ${p15.hl ? `HL at ${p15.hl.price.toFixed(4)}` : 'no HL'}
1min pivots detected:  ${p1.lh  ? `LH at ${p1.lh.price.toFixed(4)}`  : 'no LH'}, ${p1.hl  ? `HL at ${p1.hl.price.toFixed(4)}`  : 'no HL'}

Identify the most significant pivot structure. Reply ONLY this JSON:
{"pivot":"HL"|"LH"|"none","direction":"LONG"|"SHORT"|"none","confidence":0-100,"reason":"max 20 words"}`.trim();

        const { text, model } = await ollamaChat(prompt);
        const parsed = parseJSON(text);
        if (!parsed) {
          bLog.error(`[AI-LEARN] ${sym} parse fail: ${text.slice(0, 80)}`);
          continue;
        }

        const key = `${sym}_${parsed.pivot}`;
        this._insights.set(key, {
          symbol:     sym,
          pattern:    parsed.pivot,
          direction:  parsed.direction,
          confidence: parseInt(parsed.confidence, 10) || 0,
          reason:     parsed.reason || '',
          model,
          ts:         Date.now(),
        });

        bLog.scan(`[AI-LEARN] ${sym} → pivot=${parsed.pivot} dir=${parsed.direction} conf=${parsed.confidence}% (${model})`);
        this._totalAnalyzed++;

        // Persist insight to DB
        await query(`
          INSERT INTO ai_chart_insights (symbol, pattern, direction, ai_pivot, ai_confidence, ai_reason, source, model_used)
          VALUES ($1, $2, $3, $4, $5, $6, 'chart_scan', $7)
        `, [sym, parsed.pivot, parsed.direction, parsed.pivot, parsed.confidence, parsed.reason, model])
          .catch(e => bLog.error(`[AI-LEARN] DB insert: ${e.message}`));

      } catch (err) {
        bLog.error(`[AI-LEARN] chart scan ${sym}: ${err.message}`);
      }
    }

    bLog.scan(`[AI-LEARN] Chart scan complete. Total analyzed: ${this._totalAnalyzed}`);
  }

  // ── Retrospective — review recent closed trade outcomes ──────

  async _runRetrospective() {
    bLog.scan('[AI-LEARN] Starting retrospective review...');

    try {
      // Pull last 50 entries from smc_pattern_memory with enough trades
      const rows = await query(`
        SELECT symbol, pattern, wins, losses, win_rate, last_outcome
        FROM smc_pattern_memory
        WHERE wins + losses >= 3
        ORDER BY updated_at DESC
        LIMIT 50
      `);
      if (!rows.rows.length) return;

      for (const row of rows.rows) {
        const { symbol, pattern, wins, losses, win_rate, last_outcome } = row;
        const winRate = parseFloat(win_rate);
        const total   = parseInt(wins) + parseInt(losses);

        // Ask Ollama why this pattern wins/loses on this symbol
        const prompt = `
You are analyzing trade history for ${symbol} ${pattern} pivot trades.
Stats: ${wins} wins, ${losses} losses out of ${total} trades. Win rate: ${(winRate*100).toFixed(0)}%.
Last outcome: ${last_outcome}.
Pattern: ${pattern === 'HL' ? 'Higher Low → LONG' : 'Lower High → SHORT'}

Given this ${winRate >= 0.5 ? 'profitable' : 'losing'} track record, what market conditions make this pattern ${winRate >= 0.5 ? 'work' : 'fail'} on ${symbol}?
Reply ONLY this JSON:
{"outcome":"${winRate>=0.5?'PROFITABLE':'LOSING'}","lesson":"max 30 words","conditions":"max 20 words","avoid":${winRate < 0.40 ? 'true' : 'false'}}`.trim();

        try {
          const { text, model } = await ollamaChat(prompt);
          const parsed = parseJSON(text);
          if (!parsed) continue;

          bLog.trade(`[AI-LEARN] Retro ${symbol}_${pattern}: ${parsed.lesson}`);
          this._totalLessons++;

          await query(`
            INSERT INTO ai_retrospective (symbol, pattern, outcome, lesson, conditions, model_used)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [symbol, pattern, parsed.outcome ?? last_outcome, parsed.lesson ?? '', parsed.conditions ?? '', model])
            .catch(e => bLog.error(`[AI-LEARN] Retro DB: ${e.message}`));

          // Update the insight cache
          const key = `${symbol}_${pattern}`;
          const existing = this._insights.get(key) ?? {};
          this._insights.set(key, {
            ...existing,
            symbol,
            pattern,
            retroLesson: parsed.lesson,
            retroAvoid:  parsed.avoid === true,
            ts: Date.now(),
          });

          this.addActivity(
            winRate >= 0.5 ? 'info' : 'warning',
            `${symbol} ${pattern}: ${parsed.lesson}`
          );
        } catch (err) {
          bLog.error(`[AI-LEARN] Retro ${symbol}_${pattern}: ${err.message}`);
        }
      }
    } catch (err) {
      bLog.error(`[AI-LEARN] Retrospective query: ${err.message}`);
    }

    bLog.scan(`[AI-LEARN] Retrospective done. Total lessons: ${this._totalLessons}`);
  }

  // ── Old chart scan — feed historical candle data to Ollama ──

  async _runOldChartScan() {
    bLog.scan('[AI-LEARN] Starting historical chart scan...');
    this.addActivity('info', 'AI deep history scan — learning from old charts');

    for (const sym of SYMBOLS) {
      try {
        // Pull 200 bars of 1H data for long-term pattern study
        const bars1h = await fetchCandles(sym, '60', 200);
        if (!bars1h?.length) continue;

        const p = lastPivots(bars1h);
        const cur = bars1h[bars1h.length - 1];

        const prompt = `
Analyze this ${sym} 1-hour chart — last 30 bars (long-term context):
${candleSummary(bars1h, 30)}

Current price: ${cur.c.toFixed(4)}
1H pivots: ${p.lh ? `LH at ${p.lh.price.toFixed(4)}` : 'no LH'}, ${p.hl ? `HL at ${p.hl.price.toFixed(4)}` : 'no HL'}

From this 1H perspective, what is the dominant market structure and most likely next move?
Reply ONLY this JSON:
{"structure":"BULLISH"|"BEARISH"|"RANGING","bias":"LONG"|"SHORT"|"none","confidence":0-100,"key_level":price_number_or_null,"reason":"max 25 words"}`.trim();

        const { text, model } = await ollamaChat(prompt);
        const parsed = parseJSON(text);
        if (!parsed) continue;

        bLog.scan(`[AI-LEARN] ${sym} 1H → struct=${parsed.structure} bias=${parsed.bias} conf=${parsed.confidence}% (${model})`);
        this._totalAnalyzed++;

        // Store 1H bias insight — keyed differently from 15m insights
        this._insights.set(`${sym}_1H`, {
          symbol:    sym,
          pattern:   '1H',
          direction: parsed.bias,
          confidence: parseInt(parsed.confidence, 10) || 0,
          reason:    parsed.reason || '',
          structure: parsed.structure,
          keyLevel:  parsed.key_level,
          model,
          ts:        Date.now(),
        });

        await query(`
          INSERT INTO ai_chart_insights (symbol, pattern, direction, ai_pivot, ai_confidence, ai_reason, source, model_used)
          VALUES ($1, '1H', $2, $3, $4, $5, 'history_scan', $6)
        `, [sym, parsed.bias, parsed.structure, parsed.confidence, parsed.reason, model])
          .catch(e => bLog.error(`[AI-LEARN] DB 1H: ${e.message}`));

      } catch (err) {
        bLog.error(`[AI-LEARN] Old chart ${sym}: ${err.message}`);
      }
    }

    bLog.scan('[AI-LEARN] Historical scan done');
  }

  // ── Public API used by SMCPatternAgent ──────────────────────

  // Returns the current AI insight for a symbol+pattern.
  // { confidence, direction, reason, retroAvoid, structure }
  getInsight(symbol, pattern) {
    return this._insights.get(`${symbol}_${pattern}`) ?? null;
  }

  // Returns the 1H structural bias for a symbol.
  get1HBias(symbol) {
    return this._insights.get(`${symbol}_1H`) ?? null;
  }

  // Returns true if AI says this symbol+pattern should currently be avoided.
  isAIBlocked(symbol, pattern) {
    const ins = this.getInsight(symbol, pattern);
    if (!ins) return false;
    // Stale insight (> 2H old) → don't block
    if (Date.now() - ins.ts > 2 * 60 * 60_000) return false;
    // Block if retro says avoid AND confidence is high enough
    return ins.retroAvoid === true && (ins.confidence ?? 0) >= AI_CONFIDENCE_THRESHOLD;
  }

  getStatus() {
    return {
      totalAnalyzed: this._totalAnalyzed,
      totalLessons:  this._totalLessons,
      insightCount:  this._insights.size,
      ollamaUrl:     OLLAMA_URL,
      modelsAvail:   _availableModels ?? [],
      nextChartScan: Math.max(0, Math.round((this._lastChartScan + CHART_SCAN_INTERVAL_MS - Date.now()) / 1000)) + 's',
      nextRetro:     Math.max(0, Math.round((this._lastRetroScan + RETRO_SCAN_INTERVAL_MS - Date.now()) / 1000)) + 's',
    };
  }
}

// ── Singleton export — one learner shared across the process ──
let _instance = null;

function getAIChartLearner(options = {}) {
  if (!_instance) _instance = new AIChartLearner(options);
  return _instance;
}

module.exports = { AIChartLearner, getAIChartLearner };
