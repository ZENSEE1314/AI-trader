// OB-touch SHORT gate — "the OB on top should get hit first."
//
// The V5 SMC strategy shorts any confirmed lower-high in the VWAP premium half.
// That fires shorts in the MIDDLE of a range when unmitigated supply (a bearish
// order block) still sits overhead. This gate narrows shorts to lower-highs that
// occur AT that supply: price must retrace UP and TAG a bearish order block, then
// reject from its top. Fewer, higher-quality fills; skips the mid-range shorts.
//
// It reuses the bot's own smc-engine order-block detector so the read matches the
// rest of the system (same detectOrderBlocks used by smc-engine's MTF analysis).
//
// SAFETY: OFF by default (OB_TOUCH_SHORTS_ENABLED != '1'). When disabled the gate
// is never called by cycle.js. LONGs are NEVER touched. On any internal error it
// FAILS OPEN (allow:true) so a gate bug can never block a legitimate trade.
// Backtest (backtest-ob-touch.js) before enabling on a live book.
//
// Env:
//   OB_TOUCH_SHORTS_ENABLED=1     master switch (default off)
//   OB_TOUCH_MAX_DIST_PCT=0.5     band, in %, around the OB top the entry must sit in
//   OB_TOUCH_TAG_WINDOW=12        # of recent 15m bars a wick must have tagged the OB
//   OB_TOUCH_SYMBOLS=SOLUSDT      restrict to these symbols (default: all)

// smc-engine is required lazily inside evaluateShortOBTouch so the pure
// decideShortFromOBs helper (and its self-test) carries no heavy deps.

const enabled   = () => process.env.OB_TOUCH_SHORTS_ENABLED === '1';
const maxDist    = () => (Number(process.env.OB_TOUCH_MAX_DIST_PCT || 0.5) || 0.5) / 100;
const tagWindow  = () => Math.max(1, parseInt(process.env.OB_TOUCH_TAG_WINDOW || '12', 10) || 12);
const symFilter  = () => (process.env.OB_TOUCH_SYMBOLS || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// detectOrderBlocks needs bullish/body/range; fetchCandlesUpTo (backtest) omits them.
function normalize(c) {
  if (c.bullish !== undefined && c.body !== undefined) return c;
  return { ...c, body: Math.abs(c.c - c.o), range: c.h - c.l, bullish: c.c >= c.o };
}

// ── Pure decision: given detected OBs + the entry price + the recent tag high,
// decide whether this short sits at a tagged bearish order block. No I/O — unit
// testable in isolation (see backtest-ob-touch.js --selftest).
//
//   price      — entry price of the short
//   recentHigh — highest high of the recent tag window (did a wick reach the OB?)
//   tol        — band, as a fraction, around the OB top the entry must sit in
function decideShortFromOBs(obs, price, { recentHigh = null, tol = 0.005 } = {}) {
  const px = Number(price);
  if (!Number.isFinite(px)) return { allow: false, reason: 'bad price' };
  const rh = recentHigh != null ? Number(recentHigh) : px;

  const cands = (obs || []).filter(o =>
    o && o.type === 'BEARISH_OB' && o.bbDirection !== 'BULLISH'
    && Number.isFinite(o.top) && Number.isFinite(o.bottom) && o.top >= o.bottom);

  let best = null;
  for (const o of cands) {
    const mid = (o.top + o.bottom) / 2;
    // 1) Entry must sit AT the OB top: within ±tol of the top, or in the upper
    //    half of the block. Not near the bottom — that's mid-range again.
    const topProx    = (o.top - px) / px;             // >= 0 → entry below the top
    const nearTop    = topProx >= -tol && topProx <= tol;
    const inUpperHalf = px <= o.top && px >= mid;
    if (!(nearTop || inUpperHalf)) continue;
    // 2) Price must actually have reached the OB — a recent wick tagged the zone.
    if (rh < o.bottom) continue;
    // Nearest overhead supply wins (lowest top at/above the entry).
    if (!best || o.top < best.top) best = o;
  }

  if (best) {
    const dist = ((best.top - px) / px) * 100;
    return {
      allow: true,
      ob: best,
      reason: `short at bearish OB ${best.bottom.toFixed(4)}–${best.top.toFixed(4)} `
        + `(tagged; entry ${dist.toFixed(2)}% below top)`,
    };
  }
  return { allow: false, reason: `no bearish OB tag — entry ${px.toFixed(4)} not at unmitigated supply` };
}

// ── Live/backtest entry point. Fetches 15m candles if not injected, detects OBs
// with the shared smc-engine, and applies decideShortFromOBs. Async + fail-open,
// mirroring entry-guards.evaluateEntry.
async function evaluateShortOBTouch({ symbol, direction, price = null, candles15m = null } = {}) {
  if (!enabled()) return { allow: true, checked: false, reasons: ['ob-touch disabled'] };
  const dir = String(direction || '').toUpperCase();
  if (dir !== 'SHORT') return { allow: true, checked: false, reasons: ['gate is SHORT-only'] };

  const syms = symFilter();
  if (syms.length && !syms.includes(String(symbol || '').toUpperCase()))
    return { allow: true, checked: false, reasons: ['symbol not in OB_TOUCH_SYMBOLS'] };

  try {
    const smc = require('./smc-engine');
    let c15 = candles15m;
    if (!c15) c15 = await smc.fetchCandles(symbol, '15', 150);
    if (!Array.isArray(c15) || c15.length < 40)
      return { allow: true, checked: false, reasons: ['too few 15m candles — fail-open'] };

    const cs = c15.map(normalize);
    const px = price != null ? Number(price) : cs[cs.length - 1].c;
    const st = smc.analyzeStructure(cs, 10, 3);
    const obs = smc.detectOrderBlocks(cs, st.pivots) || [];
    const recentHigh = Math.max(...cs.slice(-tagWindow()).map(c => c.h));

    const d = decideShortFromOBs(obs, px, { recentHigh, tol: maxDist() });
    if (d.allow) return { allow: true, checked: true, ob: d.ob, reasons: [d.reason] };
    return { allow: false, checked: true, reason: d.reason, reasons: [d.reason] };
  } catch (e) {
    return { allow: true, checked: false, reasons: [`ob-touch error — fail-open: ${e.message}`] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-timeframe nearest-OB decision — the "test all, pick the best" modes.
//
// Scan OBs across several timeframes, find the one NEAREST to price, and apply
// one of three competing rules. backtest-ob-touch-sim.js runs all of them on the
// same signal set so the data picks the winner.
//
//   'align'   — trade ONLY the direction the nearest OB implies, and only after
//               price has tagged it. Bearish OB → short after tag; bullish OB →
//               long after tag. Blocks everything else.
//   'barrier' — block trades heading INTO an untagged OB on the target side
//               (no short with an OB below in the path; no long with an OB above).
//   'magnet'  — block trades AWAY from the nearest OB: OB above & untagged →
//               no short (price likely to rise to it first); OB below → no long.
// ═══════════════════════════════════════════════════════════════════════════

// Normalize smc-engine detectOrderBlocks output into a uniform list, dropping
// broken/flipped blocks (a broken bearish OB now acts bullish, and vice versa).
function classifyOBs(rawObs, tf = null) {
  const out = [];
  for (const o of rawObs || []) {
    if (!o || !Number.isFinite(o.top) || !Number.isFinite(o.bottom) || o.top < o.bottom) continue;
    const t = String(o.type || '');
    let kind = null;
    if (t.includes('BEARISH') && o.bbDirection !== 'BULLISH') kind = 'BEARISH';
    else if (t.includes('BULLISH') && o.bbDirection !== 'BEARISH') kind = 'BULLISH';
    if (!kind) continue;                                  // skip breakers / flipped
    out.push({ top: o.top, bottom: o.bottom, mid: (o.top + o.bottom) / 2, kind, tf,
               mitigated: o.mitigated === true });
  }
  return out;
}

function _side(ob, price) {
  if (ob.bottom > price) return 'above';
  if (ob.top < price)    return 'below';
  return 'inside';
}
function _dist(ob, price) {
  if (price < ob.bottom) return ob.bottom - price;
  if (price > ob.top)    return price - ob.top;
  return 0;
}
function _tagged(ob, price, recentHigh, recentLow) {
  const s = _side(ob, price);
  if (s === 'inside') return true;
  if (s === 'above')  return recentHigh != null && recentHigh >= ob.bottom;
  return recentLow != null && recentLow <= ob.top;       // below
}

// Nearest OB to price within maxRangePct (as a fraction). Optional side filter.
function nearestOB(obs, price, { maxRangePct = 0.03, side = null } = {}) {
  let best = null, bestD = Infinity;
  for (const ob of obs || []) {
    if (side && _side(ob, price) !== side) continue;
    const d = _dist(ob, price);
    if (d / price > maxRangePct) continue;
    if (d < bestD) { bestD = d; best = ob; }
  }
  return best ? { ...best, side: _side(best, price), dist: bestD } : null;
}

// Pure decision for one mode. obs = uniform multi-TF list (from classifyOBs).
function decideByMode(mode, { direction, price, obs, recentHigh = null, recentLow = null,
                             maxRangePct = 0.03 } = {}) {
  const dir = String(direction || '').toUpperCase();
  const px = Number(price);
  const near = nearestOB(obs, px, { maxRangePct });
  const label = near ? `${near.kind} OB ${near.bottom.toFixed(4)}–${near.top.toFixed(4)}${near.tf ? '@' + near.tf : ''} (${near.side})` : 'no OB in range';

  if (mode === 'magnet') {
    if (!near) return { allow: true, reason: 'magnet: no OB in range' };
    const tagged = _tagged(near, px, recentHigh, recentLow);
    if (dir === 'SHORT' && near.side === 'above' && !tagged) return { allow: false, reason: `magnet: nearest ${label} untagged — price likely to rise into it first`, near };
    if (dir === 'LONG'  && near.side === 'below' && !tagged) return { allow: false, reason: `magnet: nearest ${label} untagged — price likely to drop into it first`, near };
    return { allow: true, reason: `magnet ok (${label})`, near };
  }

  if (mode === 'barrier') {
    const targetSide = dir === 'SHORT' ? 'below' : 'above';
    const path = nearestOB(obs, px, { maxRangePct, side: targetSide });
    if (path && !_tagged(path, px, recentHigh, recentLow))
      return { allow: false, reason: `barrier: ${dir} runs into ${path.kind} OB ${path.bottom.toFixed(4)}–${path.top.toFixed(4)}${path.tf ? '@' + path.tf : ''} in the path`, near: path };
    return { allow: true, reason: 'barrier: path clear', near: path || near };
  }

  // 'align'
  if (!near) return { allow: false, reason: 'align: no OB to align to' };
  const tagged = _tagged(near, px, recentHigh, recentLow);
  const impliedShort = near.kind === 'BEARISH';
  if (dir === 'SHORT') return { allow: impliedShort && tagged, reason: impliedShort && tagged ? `align: short the tagged ${label}` : `align: nearest is ${label}, no aligned+tagged short`, near };
  return { allow: !impliedShort && tagged, reason: !impliedShort && tagged ? `align: long the tagged ${label}` : `align: nearest is ${label}, no aligned+tagged long`, near };
}

// ── Live evaluator for a chosen mode (both directions). Fetches the timeframes
// it needs and applies decideByMode. Async + fail-open, like evaluateShortOBTouch.
// mode: 'touch' | 'magnet' | 'barrier' | 'align' (default from OB_PATH_MODE).
async function evaluateOBMode({ symbol, direction, price = null, mode = null, candlesByTf = null } = {}) {
  const m = String(mode || process.env.OB_PATH_MODE || '').toLowerCase();
  if (!['touch', 'magnet', 'barrier', 'align'].includes(m))
    return { allow: true, checked: false, reasons: ['ob-path mode off/unknown'] };
  const dir = String(direction || '').toUpperCase();
  if (dir !== 'LONG' && dir !== 'SHORT') return { allow: true, checked: false, reasons: ['unknown direction'] };
  const syms = symFilter();
  if (syms.length && !syms.includes(String(symbol || '').toUpperCase()))
    return { allow: true, checked: false, reasons: ['symbol not in OB_TOUCH_SYMBOLS'] };

  try {
    const smc = require('./smc-engine');
    const tfs = m === 'touch' ? [['15', 150]] : [['15', 150], ['60', 300], ['240', 300]];
    const arrs = {};
    for (const [tf, lim] of tfs) arrs[tf] = (candlesByTf && candlesByTf[tf]) || await smc.fetchCandles(symbol, tf, lim);

    const c15 = (arrs['15'] || []).map(normalize);
    if (c15.length < 40) return { allow: true, checked: false, reasons: ['too few 15m candles — fail-open'] };
    const px = price != null ? Number(price) : c15[c15.length - 1].c;
    const win = c15.slice(-tagWindow());
    const recentHigh = Math.max(...win.map(c => c.h));
    const recentLow  = Math.min(...win.map(c => c.l));

    if (m === 'touch') {
      if (dir !== 'SHORT') return { allow: true, checked: false, reasons: ['touch mode is SHORT-only'] };
      const st = smc.analyzeStructure(c15, 10, 3);
      const d = decideShortFromOBs(smc.detectOrderBlocks(c15, st.pivots) || [], px, { recentHigh, tol: maxDist() });
      return d.allow ? { allow: true, checked: true, reasons: [d.reason] }
                     : { allow: false, checked: true, reason: d.reason, reasons: [d.reason] };
    }

    let merged = [];
    for (const [tf] of tfs) {
      const arr = (arrs[tf] || []).map(normalize);
      if (arr.length < 30) continue;
      const st = smc.analyzeStructure(arr, 10, 3);
      merged = merged.concat(classifyOBs(smc.detectOrderBlocks(arr, st.pivots), tf));
    }
    const maxRangePct = (Number(process.env.OB_PATH_MAX_RANGE_PCT || 3) || 3) / 100;
    const d = decideByMode(m, { direction: dir, price: px, obs: merged, recentHigh, recentLow, maxRangePct });
    return d.allow ? { allow: true, checked: true, reasons: [d.reason] }
                   : { allow: false, checked: true, reason: d.reason, reasons: [d.reason] };
  } catch (e) {
    return { allow: true, checked: false, reasons: [`ob-path error — fail-open: ${e.message}`] };
  }
}

module.exports = {
  evaluateShortOBTouch, decideShortFromOBs, normalize,
  classifyOBs, nearestOB, decideByMode, evaluateOBMode,
};
