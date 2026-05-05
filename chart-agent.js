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
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'kimi-k2.6:cloud';
const TIMEOUT      = 30_000;

const INITIAL_SL_CAP = 0.25;

// ── Fetch klines (15m for structure — 4x faster CHoCH detection than H1) ────
async function fetchKlines(symbol, interval = '15m', limit = 200) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
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
function buildMarketProfile(symbol, price, vwap, eq, struct, vwapExtPct = 0) {
  const pVwapPct = Math.abs(vwapExtPct).toFixed(2);
  const pAbove   = price > vwap.vwap;

  // Warn if price is extended far from VWAP — chasing is bad entry
  const extWarning = Math.abs(vwapExtPct) > 0.8
    ? `⚠️ Price is ${pAbove ? 'EXTENDED ABOVE' : 'EXTENDED BELOW'} VWAP by ${pVwapPct}% — prefer waiting for pullback to VWAP`
    : `Price is near VWAP (${pVwapPct}% away) — good entry zone`;

  const lines = [
    `Symbol: ${symbol}`,
    `Current price: $${price.toFixed(4)}`,
    ``,
    `── VWAP ──`,
    `Daily VWAP: $${vwap.vwap.toFixed(4)} (slope: ${vwap.slope})`,
    `Price is ${pAbove ? 'ABOVE' : 'BELOW'} VWAP by ${pVwapPct}% → ${pAbove ? 'BULLISH' : 'BEARISH'} bias`,
    extWarning,
    `VWAP upper band: $${vwap.upper.toFixed(4)}`,
    `VWAP lower band: $${vwap.lower.toFixed(4)}`,
    ``,
    `── Market Structure (last 8h, 15m bars) ──`,
    `Structure: ${struct.structLabel}`,
    `8h price change: ${struct.changePct}%`,
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
// Covers both trend-following AND reversal (CHoCH) entries.
function decideWithRules(price, vwap, struct, vwapExtPct = 0) {
  const aboveVwap = price > vwap.vwap;
  const label     = struct.structLabel.toLowerCase();
  const extAbs    = Math.abs(vwapExtPct);

  const isBullishStruct = label.includes('hh') || label.includes('hl');
  const isBearishStruct = label.includes('ll') || (label.includes('lh') && !label.includes('hl'));

  // ── 1. CHoCH entry (reversal at the HL/LH — best entries happen here) ────
  // Price is still on the wrong side of VWAP but structure has already turned.
  // This catches the HL entry before price crosses VWAP.
  // Guard: not too far from VWAP (< 1.5%) — avoids buying deep below into free-fall.
  if (!aboveVwap && isBullishStruct && vwap.slope !== 'falling' && extAbs < 1.5) {
    return {
      action: 'LONG', confidence: 'medium',
      reason: `CHoCH — structure turned bullish (${struct.structLabel}), price approaching VWAP from below`,
    };
  }
  if (aboveVwap && isBearishStruct && vwap.slope !== 'rising' && extAbs < 1.5) {
    return {
      action: 'SHORT', confidence: 'medium',
      reason: `CHoCH — structure turned bearish (${struct.structLabel}), price approaching VWAP from above`,
    };
  }

  // ── 2. Trend-following (price already crossed VWAP, structure aligned) ────
  if (aboveVwap && isBullishStruct && vwap.slope !== 'falling') {
    // Overextended from VWAP — lower confidence, wait for pullback
    if (extAbs > 0.8) {
      return { action: 'LONG', confidence: 'low', reason: `Extended ${extAbs.toFixed(1)}% above VWAP — late entry, structure bullish` };
    }
    const conf = (vwap.slope === 'rising' && label.includes('hh') && label.includes('hl')) ? 'high' : 'medium';
    return { action: 'LONG', confidence: conf, reason: `Price above VWAP (${vwap.slope}), structure: ${struct.structLabel}` };
  }
  if (!aboveVwap && isBearishStruct && vwap.slope !== 'rising') {
    if (extAbs > 0.8) {
      return { action: 'SHORT', confidence: 'low', reason: `Extended ${extAbs.toFixed(1)}% below VWAP — late entry, structure bearish` };
    }
    const conf = (vwap.slope === 'falling' && label.includes('ll') && label.includes('lh')) ? 'high' : 'medium';
    return { action: 'SHORT', confidence: conf, reason: `Price below VWAP (${vwap.slope}), structure: ${struct.structLabel}` };
  }

  return { action: 'WAIT', confidence: 'low', reason: 'No strong confluence' };
}

// ── Build system prompt with injected memory ─────────────────
function buildSystemPrompt(lessons) {
  const base = `You are an expert crypto futures trader with 10 years experience.
You analyze market structure, VWAP, and liquidity the same way a professional SMC/ICT trader would.

Entry rules (priority order):
1. CHoCH (Change of Character) entry — BEST entries, catch reversals early:
   - Structure was bearish (LL+LH) then shows first HL forming → LONG even if price still below VWAP
   - Structure was bullish (HH+HL) then shows first LH forming → SHORT even if price still above VWAP
   - These catch the move at the bottom/top, before price crosses VWAP
   - Only valid if price is within 1.5% of VWAP (not in free-fall)
2. Trend-following entry — price already above/below VWAP with aligned structure:
   - Price ABOVE VWAP + HH+HL or HL → LONG (but if >0.8% above VWAP, it's a late/extended entry)
   - Price BELOW VWAP + LL+LH or LH → SHORT (but if >0.8% below VWAP, it's a late/extended entry)
3. Liquidity context:
   - EQH above = buy stops — price sweeps them then may reverse or continue up
   - EQL below = sell stops — price sweeps them then may reverse or continue down

When the market profile says price is EXTENDED from VWAP (>0.8%), prefer WAIT or low confidence.
WAIT when structure is completely unclear (sideways) or price is mid-range with no bias.

Respond ONLY with valid JSON, no explanation outside it:
{"action":"LONG","confidence":"high","reason":"one sentence max"}`;

  if (!lessons) return base;
  return `${base}\n${lessons}`;
}

// ── Analyze one symbol ────────────────────────────────────────
async function analyzeSymbol(symbol, log) {
  // 15m klines: 200 bars = ~50h of data. Structure detects CHoCH 4× faster than H1.
  const klines = await fetchKlines(symbol, '15m', 200);
  if (!klines || klines.length < 20) {
    log(`chart-agent: ${symbol} — fetch failed`);
    return null;
  }

  const price  = parseFloat(klines.at(-1)[4]);
  const vwap   = calcVWAP(klines);
  if (!vwap) return null;

  // 15m windows: EQ = 96 bars (24h), structure = 32 bars (8h)
  const eq      = findEQLevels(klines, 96);
  const struct  = describeStructure(klines, 32);

  // How far price has extended from VWAP — used to prefer near-VWAP entries
  const vwapExtPct = ((price - vwap.vwap) / vwap.vwap) * 100; // positive = above
  const profile = buildMarketProfile(symbol, price, vwap, eq, struct, vwapExtPct);

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
    decision = decideWithRules(price, vwap, struct, vwapExtPct);
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
