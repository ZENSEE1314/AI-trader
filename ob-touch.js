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

module.exports = { evaluateShortOBTouch, decideShortFromOBs, normalize };
