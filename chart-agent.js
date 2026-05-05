'use strict';
// ════════════════════════════════════════════════════════════════
//  chart-agent.js  —  AI "human trader" market analyst
//
//  Reads the market like a professional SMC/ICT trader:
//    - VWAP direction and slope (rising / falling / flat today)
//    - Price vs VWAP (above = uptrend bias, below = downtrend bias)
//    - Equal Highs / Equal Lows (liquidity pools)
//    - Recent H1 structure (HH+HL = uptrend, LL+LH = downtrend)
//
//  Uses Ollama (local LLM, zero API cost) to reason about the
//  combined picture and decide: LONG | SHORT | WAIT
//
//  Falls back to Claude API if ANTHROPIC_API_KEY is set and
//  Ollama is unreachable.
//
//  Self-learning: past signal outcomes are loaded from DB before
//  each analysis so the model improves from its own trade history.
// ════════════════════════════════════════════════════════════════

const fetch      = require('node-fetch');
const { SYMBOL_LEVERAGE } = require('./strategy-3timing');
const memory     = require('./chart-agent-memory');

// ── LLM Config ────────────────────────────────────────────────
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
const TIMEOUT      = 30_000;

const INITIAL_SL_CAP = 0.25;

// ── Fetch H1 klines ───────────────────────────────────────────
async function fetchH1(symbol, limit = 100) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { timeout: TIMEOUT });
      if (res.ok) return res.json();
    } catch (_) {}
    if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

// ── Daily VWAP + 2σ bands ─────────────────────────────────────
function calcVWAP(h1Klines) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const bars = h1Klines.filter(k => parseInt(k[0]) >= todayMs);
  const useBars = bars.length >= 3 ? bars : h1Klines.slice(-8);

  let cumTPV = 0, cumVol = 0, cumTPV2 = 0;
  const vwapSeries = [];

  for (const k of useBars) {
    const tp  = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
    const vol = parseFloat(k[5]) || 1;
    cumTPV  += tp * vol;
    cumVol  += vol;
    cumTPV2 += tp * tp * vol;
    const vwap = cumTPV / cumVol;
    const sd   = Math.sqrt(Math.max(0, cumTPV2 / cumVol - vwap * vwap));
    vwapSeries.push({ vwap, upper: vwap + 2 * sd, lower: vwap - 2 * sd });
  }

  if (!vwapSeries.length) return null;
  const last  = vwapSeries.at(-1);
  const prev  = vwapSeries.length > 3 ? vwapSeries[vwapSeries.length - 4] : vwapSeries[0];
  const slope = last.vwap > prev.vwap ? 'rising' : last.vwap < prev.vwap ? 'falling' : 'flat';
  return { ...last, slope, bars: useBars.length };
}

// ── Equal Highs / Equal Lows detector ────────────────────────
function findEQLevels(h1Klines, window = 48) {
  const slice = h1Klines.slice(-window);
  const swLen = 3;
  const TOL   = 0.0015;

  const swingHighs = [], swingLows = [];
  for (let i = swLen; i < slice.length - swLen; i++) {
    const h = parseFloat(slice[i][2]);
    const l = parseFloat(slice[i][3]);
    let isH = true, isL = true;
    for (let j = i - swLen; j <= i + swLen; j++) {
      if (j === i) continue;
      if (parseFloat(slice[j][2]) >= h) isH = false;
      if (parseFloat(slice[j][3]) <= l) isL = false;
    }
    if (isH) swingHighs.push(h);
    if (isL)  swingLows.push(l);
  }

  return { eqH: groupLevels(swingHighs, TOL), eqL: groupLevels(swingLows, TOL) };
}

function groupLevels(levels, tol) {
  const groups = [];
  for (const lv of levels) {
    const g = groups.find(g => Math.abs(g.price - lv) / g.price <= tol);
    if (g) { g.count++; g.price = (g.price * (g.count - 1) + lv) / g.count; }
    else    groups.push({ price: lv, count: 1 });
  }
  return groups.filter(g => g.count >= 2).sort((a, b) => b.price - a.price);
}

// ── Recent H1 structure summary ───────────────────────────────
function describeStructure(h1Klines, window = 16) {
  const slice = h1Klines.slice(-window).map(k => ({
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));

  const highs = [], lows = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const h = slice[i].high, l = slice[i].low;
    if (h > slice[i-1].high && h > slice[i-2].high && h > slice[i+1].high && h > slice[i+2].high) highs.push(h);
    if (l < slice[i-1].low  && l < slice[i-2].low  && l < slice[i+1].low  && l < slice[i+2].low)  lows.push(l);
  }

  let structLabel = 'sideways/unclear';
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs.at(-1) > highs.at(-2);
    const hl = lows.at(-1)  > lows.at(-2);
    const ll = lows.at(-1)  < lows.at(-2);
    const lh = highs.at(-1) < highs.at(-2);
    if (hh && hl)       structLabel = 'HH+HL (strong uptrend)';
    else if (ll && lh)  structLabel = 'LL+LH (strong downtrend)';
    else if (hh)        structLabel = 'HH forming (bullish momentum)';
    else if (hl)        structLabel = 'HL holding (bullish structure)';
    else if (ll)        structLabel = 'LL forming (bearish momentum)';
    else if (lh)        structLabel = 'LH forming (bearish structure)';
  } else if (highs.length >= 2) {
    structLabel = highs.at(-1) > highs.at(-2) ? 'HH forming (bullish)' : 'LH forming (bearish)';
  } else if (lows.length >= 2) {
    structLabel = lows.at(-1) > lows.at(-2) ? 'HL holding (bullish)' : 'LL forming (bearish)';
  }

  const lastClose  = slice.at(-1).close;
  const firstClose = slice[0].close;
  const changePct  = ((lastClose - firstClose) / firstClose * 100).toFixed(2);

  return { structLabel, changePct, lastClose, highs, lows };
}

// ── Build market profile text for LLM ────────────────────────
function buildMarketProfile(symbol, price, vwap, eq, struct) {
  const pVwapPct = ((price - vwap.vwap) / vwap.vwap * 100).toFixed(2);
  const pAbove   = price > vwap.vwap;

  const lines = [
    `Symbol: ${symbol}`,
    `Current price: $${price.toFixed(4)}`,
    ``,
    `── VWAP ──`,
    `Daily VWAP: $${vwap.vwap.toFixed(4)} (slope: ${vwap.slope})`,
    `Price is ${pAbove ? 'ABOVE' : 'BELOW'} VWAP by ${Math.abs(pVwapPct)}% → ${pAbove ? 'BULLISH' : 'BEARISH'} bias`,
    `VWAP upper band: $${vwap.upper.toFixed(4)}`,
    `VWAP lower band: $${vwap.lower.toFixed(4)}`,
    ``,
    `── Market Structure (last 16 H1 bars) ──`,
    `Structure: ${struct.structLabel}`,
    `16h price change: ${struct.changePct}%`,
    struct.highs.length ? `Recent swing highs: ${struct.highs.slice(-3).map(h => '$' + h.toFixed(4)).join(', ')}` : 'No clear swing highs yet',
    struct.lows.length  ? `Recent swing lows:  ${struct.lows.slice(-3).map(l => '$' + l.toFixed(4)).join(', ')}` : 'No clear swing lows yet',
    ``,
    `── Liquidity Levels (EQ) ──`,
    eq.eqH.length
      ? `Equal Highs (EQH — buy stops above): ${eq.eqH.slice(0, 3).map(e => `$${e.price.toFixed(4)} (${e.count}x)`).join(', ')}`
      : 'No Equal Highs detected',
    eq.eqL.length
      ? `Equal Lows (EQL — sell stops below): ${eq.eqL.slice(-3).reverse().map(e => `$${e.price.toFixed(4)} (${e.count}x)`).join(', ')}`
      : 'No Equal Lows detected',
  ];

  return lines.join('\n');
}

// ── Ask Ollama ────────────────────────────────────────────────
async function askOllama(systemPrompt, userMsg) {
  const url = `${OLLAMA_URL}/api/chat`;
  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMsg },
    ],
    options: { temperature: 0.1, num_predict: 150 },
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeout: TIMEOUT,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.message?.content || '';
}

// ── Ask Claude API (fallback) ─────────────────────────────────
async function askClaude(systemPrompt, userMsg) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    }),
    timeout: TIMEOUT,
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── Ask LLM (Ollama first, Claude fallback) ───────────────────
async function askLLM(systemPrompt, userMsg) {
  try {
    return await askOllama(systemPrompt, userMsg);
  } catch (ollamaErr) {
    if (process.env.ANTHROPIC_API_KEY) {
      return await askClaude(systemPrompt, userMsg);
    }
    throw ollamaErr;
  }
}

// ── Rule-based fallback decision (no LLM required) ──────────
// Same logic as the LLM prompt rules — runs when Ollama/Claude unreachable.
function decideWithRules(price, vwap, struct) {
  const aboveVwap = price > vwap.vwap;
  const label     = struct.structLabel.toLowerCase();

  const isBullishStruct = label.includes('hh') || label.includes('hl');
  const isBearishStruct = label.includes('ll') || label.includes('lh') && !label.includes('hl');

  // Strong confluence: VWAP side + structure align
  if (aboveVwap && isBullishStruct && vwap.slope !== 'falling') {
    const conf = (vwap.slope === 'rising' && label.includes('hh') && label.includes('hl')) ? 'high' : 'medium';
    return { action: 'LONG', confidence: conf, reason: `Price above VWAP (${vwap.slope}), structure: ${struct.structLabel}` };
  }
  if (!aboveVwap && isBearishStruct && vwap.slope !== 'rising') {
    const conf = (vwap.slope === 'falling' && label.includes('ll') && label.includes('lh')) ? 'high' : 'medium';
    return { action: 'SHORT', confidence: conf, reason: `Price below VWAP (${vwap.slope}), structure: ${struct.structLabel}` };
  }

  return { action: 'WAIT', confidence: 'low', reason: 'No strong confluence' };
}

// ── Build system prompt with injected memory ─────────────────
function buildSystemPrompt(lessons) {
  const base = `You are an expert crypto futures trader with 10 years experience.
You analyze market structure, VWAP, and liquidity the same way a professional SMC/ICT trader would.

Rules:
- Price ABOVE VWAP with rising slope = uptrend = prefer LONG
- Price BELOW VWAP with falling slope = downtrend = prefer SHORT
- Equal Highs (EQH) = liquidity above — price likely sweeps them before reversing or continuing
- Equal Lows (EQL) = liquidity below — price likely sweeps them before reversing or continuing
- HH+HL structure = strong uptrend, buy pullbacks (HL entries)
- LL+LH structure = strong downtrend, sell rallies (LH entries)
- WAIT when structure is unclear, VWAP is flat, or price is between EQ levels with no clear bias

Respond ONLY with valid JSON, no explanation outside it:
{"action":"LONG","confidence":"high","reason":"one sentence max"}`;

  if (!lessons) return base;
  return `${base}\n${lessons}`;
}

// ── Analyze one symbol ────────────────────────────────────────
async function analyzeSymbol(symbol, log) {
  const h1Klines = await fetchH1(symbol, 100);
  if (!h1Klines || h1Klines.length < 20) {
    log(`chart-agent: ${symbol} — fetch failed`);
    return null;
  }

  const price  = parseFloat(h1Klines.at(-1)[4]);
  const vwap   = calcVWAP(h1Klines);
  if (!vwap) return null;

  const eq      = findEQLevels(h1Klines, 48);
  const struct  = describeStructure(h1Klines, 16);
  const profile = buildMarketProfile(symbol, price, vwap, eq, struct);

  // Load past performance lessons for this symbol
  const lessons     = await memory.getLessons(symbol);
  const systemPrompt = buildSystemPrompt(lessons);
  const userMsg     = `Analyze this market and tell me what a skilled trader would do right now:\n\n${profile}`;

  log(`chart-agent: ${symbol} — asking LLM... (price=$${price.toFixed(2)} vwap=$${vwap.vwap.toFixed(2)} slope=${vwap.slope} struct="${struct.structLabel}")`);

  let decision;
  let usedRules = false;

  let text = '';
  try {
    text = await askLLM(systemPrompt, userMsg);
  } catch (e) {
    log(`chart-agent: ${symbol} — LLM unavailable (${e.message}), using rule-based decision`);
    usedRules = true;
  }

  if (!usedRules) {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) {
      log(`chart-agent: ${symbol} — no JSON in LLM response, using rule-based fallback`);
      usedRules = true;
    } else {
      try { decision = JSON.parse(m[0]); } catch { usedRules = true; }
    }
  }

  if (usedRules) {
    decision = decideWithRules(price, vwap, struct);
    log(`chart-agent: ${symbol} — rules → ${decision.action} [${decision.confidence}] — ${decision.reason}`);
  } else {
    log(`chart-agent: ${symbol} — LLM → ${decision.action} [${decision.confidence}] — ${decision.reason}`);
  }

  if (decision.action === 'WAIT' || !['LONG', 'SHORT'].includes(decision.action)) return null;
  // NOTE: 'low' confidence still trades — score is lower so it loses dedup vs a high/medium signal
  // on the same symbol, but we don't block it entirely (missing trades is worse than a weak signal).

  const side   = decision.action;
  const lev    = SYMBOL_LEVERAGE[symbol] || 50;
  const slPct  = INITIAL_SL_CAP / lev;
  const sl     = side === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);

  // Persist signal for self-learning
  const signalId = await memory.saveSignal({
    symbol,
    side,
    confidence:   decision.confidence,
    reason:       decision.reason,
    marketProfile: profile,
    vwapSlope:    vwap.slope,
    structure:    struct.structLabel,
    entryPrice:   price,
  });

  return {
    symbol,
    lastPrice:  price,
    signal:     side === 'LONG' ? 'BUY' : 'SELL',
    side,
    direction:  side,
    entry:      price,
    sl,
    slPct:      (INITIAL_SL_CAP * 100).toFixed(2),
    setupName:  usedRules ? `ChartRules(${decision.confidence})` : `ChartAI(${decision.confidence})`,
    score:      decision.confidence === 'high' ? 3 : decision.confidence === 'medium' ? 2 : 1,
    reason:     decision.reason,
    vwap:       vwap.vwap,
    vwapSlope:  vwap.slope,
    structure:  struct.structLabel,
    signalId,
    tp1: null, tp2: null, tp3: null,
    version: 'chart-agent-v2',
  };
}

// ── Main scan ─────────────────────────────────────────────────
async function scanChartAgent(symbols, log = console.log) {
  // Run daily review once per day (no-op if already ran today)
  memory.runDailyReview(
    prompt => askLLM('You are a trading analyst. Return only valid JSON.', prompt),
    log
  ).catch(() => {});

  const results = [];
  for (const symbol of symbols) {
    try {
      const sig = await analyzeSymbol(symbol, log);
      if (sig) results.push(sig);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      log(`chart-agent: ${symbol} — error: ${e.message}`);
    }
  }
  log(`chart-agent: done — ${results.length} signal(s)`);
  return results;
}

module.exports = { scanChartAgent };
