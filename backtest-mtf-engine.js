'use strict';
/**
 * MTF backtest ENGINE (pure, no network) — shared by the CLI runner
 * (backtest-mtf-1h-15m-1m.js) and the website route (routes/backtest-mtf.js).
 *
 * It reuses the SITE'S OWN chart engine (routes/chart.js `lib`): detectSwings,
 * getStructureLabels, detectEQHEQL, calcCurvedBands — so the backtest measures
 * the exact structure / equal-highs / curved bands the MCT chart draws.
 *
 * Strategy (owner spec):
 *   1h structure (HL=long / LH=short)  →  15m must confirm same label
 *   →  1m must print the matching light pivot (HL long / LH short)
 *   →  price must be AT/NEAR the correct CURVED band (short=upper, long=lower)
 *   →  VSA: a big-volume wide-spread buy bar blocks a short (wait next 1m pivot);
 *          a big sell bar blocks a long.
 *   Optional EQH/EQL safety: block a short if resting equal-highs sit just above
 *   (sweep risk), block a long if equal-lows sit just below.
 *
 * Klines are Binance-style arrays: [openTime(ms), open, high, low, close, volume, …].
 * HTF structure labels are made available only AFTER their confirmation lag
 * (pivot bar + swing-length bars) so there is no lookahead.
 */

const DEFAULTS = {
  lev: 20,
  slMargin: 0.50,      // -50% of margin  (matches live SOL)
  tpMargin: 0.75,      // +75% of margin
  feeSide: 0.0005,     // 0.05% per side incl. slippage
  bandNear: 0.25,      // "near a band" = within this fraction of channel width
  pivot1m: 2,          // light 1m swing strength (bars each side) for entry timing
  vsaLen: 20,          // volume SMA lookback (1m bars)
  vsaMult: 2.0,        // volume >= mult*avg = "big"
  vsaBody: 0.5,        // |body|/range >= this = wide-spread directional bar
  h1FreshBars: 0,      // 0 = persistent 1h direction (holds until structure flips); >0 expires it
  h15FreshBars: 0,     // 0 = persistent 15m direction; >0 = only trade this many bars after a 15m label
  eqhGuardPct: 0,      // 0 = off; else block entry if EQ level within this % (e.g. 0.003)
  len1h: null,         // null -> lib.SWING_LENGTHS['1h']
  len15: null,         // null -> lib.SWING_LENGTHS['15m']
};

const TF_MS = { h1: 3_600_000, m15: 900_000, m1: 60_000 };

// ── helpers ──────────────────────────────────────────────────────────────────
const H = k => +k[2], L = k => +k[3], C = k => +k[4], V = k => +k[5], T = k => +k[0];

// Attach an availableAt (ms) to each structure label: pivot time + lenBars lag.
function withAvailability(labels, lenBars, tfMs) {
  return labels.map(l => ({ ...l, availAt: l.time * 1000 + lenBars * tfMs }));
}

// Persistent directional context: the most-recent HL/LH label confirmed at/before
// t sets the bias and holds until structure flips it (HH/LL = continuation, no flip).
// freshMs > 0 optionally expires the bias that long after confirmation; freshMs <= 0
// (the default) = persistent, matching a 1h/15m "trend" that holds until it changes.
function biasAsOf(labels, t, freshMs) {
  for (let j = labels.length - 1; j >= 0; j--) {
    const l = labels[j];
    if (l.availAt > t) continue;
    if (l.label === 'HL' || l.label === 'LH') {
      if (freshMs > 0 && t - l.availAt > freshMs) return { dir: null };
      return { dir: l.label === 'HL' ? 'long' : 'short', at: l.availAt };
    }
  }
  return { dir: null };
}

// Light 1m pivots (strength s) → HL/LH/HH/LL, each available s bars later.
function lightPivots(k, s) {
  const highs = [], lows = [], out = [];
  for (let i = s; i < k.length - s; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= s; j++) {
      if (!(H(k[i]) > H(k[i - j]) && H(k[i]) > H(k[i + j]))) isH = false;
      if (!(L(k[i]) < L(k[i - j]) && L(k[i]) < L(k[i + j]))) isL = false;
    }
    const availIdx = i + s;                    // confirmed only s bars later
    if (isH) {
      const kind = highs.length ? (H(k[i]) < highs[highs.length - 1] ? 'LH' : 'HH') : null;
      if (kind) out.push({ availIdx, kind, price: H(k[i]) });
      highs.push(H(k[i]));
    }
    if (isL) {
      const kind = lows.length ? (L(k[i]) > lows[lows.length - 1] ? 'HL' : 'LL') : null;
      if (kind) out.push({ availIdx, kind, price: L(k[i]) });
      lows.push(L(k[i]));
    }
  }
  return out;
}

function vsaBig(k, i, side, o) {
  if (i < o.vsaLen) return false;
  let avg = 0;
  for (let j = 1; j <= o.vsaLen; j++) avg += V(k[i - j]);
  avg /= o.vsaLen;
  const range = (H(k[i]) - L(k[i])) || 1e-9;
  const body = Math.abs(C(k[i]) - k[i][1]) / range;
  const bigVol = V(k[i]) >= o.vsaMult * avg && body >= o.vsaBody;
  return side === 'buy' ? (bigVol && C(k[i]) > +k[i][1]) : (bigVol && C(k[i]) < +k[i][1]);
}

// ── engine ───────────────────────────────────────────────────────────────────
function runMtfBacktest({ k1h, k15, k1m, lib, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const len1h = o.len1h || lib.SWING_LENGTHS['1h'] || 10;
  const len15 = o.len15 || lib.SWING_LENGTHS['15m'] || 20;

  const sw1h = lib.detectSwings(k1h, len1h);
  const sw15 = lib.detectSwings(k15, len15);
  const lab1h = withAvailability(lib.getStructureLabels(sw1h), len1h, TF_MS.h1);
  const lab15 = withAvailability(lib.getStructureLabels(sw15), len15, TF_MS.m15);
  const eqh1h = lib.detectEQHEQL(sw1h);                 // {type:'EQH'|'EQL', price, time}
  const curved = lib.calcCurvedBands(k1m);              // {upper:[], lower:[]}
  const piv = lightPivots(k1m, o.pivot1m);

  // index light pivots by the 1m candle index at which they become available
  const pivByIdx = new Map();
  for (const p of piv) {
    if (!pivByIdx.has(p.availIdx)) pivByIdx.set(p.availIdx, []);
    pivByIdx.get(p.availIdx).push(p);
  }

  const slPx = o.slMargin / o.lev, tpPx = o.tpMargin / o.lev;
  const rtFee = 2 * o.feeSide * o.lev;
  const h1Fresh = o.h1FreshBars * TF_MS.h1, h15Fresh = o.h15FreshBars * TF_MS.m15;

  const trades = [];
  const skips = { align1h: 0, align15: 0, no1mPivot: 0, band: 0, vsa: 0, eqh: 0 };
  let pos = null, lastWindow = null;

  for (let i = 1; i < k1m.length; i++) {
    const k = k1m[i], t = T(k);

    if (pos) {                                          // manage open trade (assume adverse first)
      const hitSL = pos.side === 'long' ? L(k) <= pos.sl : H(k) >= pos.sl;
      const hitTP = pos.side === 'long' ? H(k) >= pos.tp : L(k) <= pos.tp;
      if (hitSL)      { trades.push({ ...pos, r: -o.slMargin - rtFee, exitT: t, exit: 'SL' }); pos = null; }
      else if (hitTP) { trades.push({ ...pos, r:  o.tpMargin - rtFee, exitT: t, exit: 'TP' }); pos = null; }
      else continue;
    }

    const b1h = biasAsOf(lab1h, t, h1Fresh);
    if (!b1h.dir) { skips.align1h++; continue; }
    const b15 = biasAsOf(lab15, t, h15Fresh);
    if (b15.dir !== b1h.dir) { skips.align15++; continue; }

    const windowKey = `${b15.dir}:${b15.at}`;
    if (windowKey === lastWindow) continue;             // one trade per 15m window

    const want = b15.dir === 'long' ? 'HL' : 'LH';
    if (!(pivByIdx.get(i) || []).some(p => p.kind === want)) { skips.no1mPivot++; continue; }

    const up = curved.upper[i], lo = curved.lower[i], price = C(k);
    if (up == null || lo == null) continue;
    const width = (up - lo) || 1e-9;
    const bandOk = b15.dir === 'short'
      ? price >= up - o.bandNear * width            // near/inside upper band
      : price <= lo + o.bandNear * width;           // near/inside lower band
    if (!bandOk) { skips.band++; continue; }

    if (b15.dir === 'short' && vsaBig(k1m, i, 'buy', o))  { skips.vsa++; continue; }
    if (b15.dir === 'long'  && vsaBig(k1m, i, 'sell', o)) { skips.vsa++; continue; }

    if (o.eqhGuardPct > 0) {                            // liquidity-sweep safety
      const guard = o.eqhGuardPct;
      const blocked = b15.dir === 'short'
        ? eqh1h.some(e => e.type === 'EQH' && e.time * 1000 <= t && e.price > price && (e.price - price) / price <= guard)
        : eqh1h.some(e => e.type === 'EQL' && e.time * 1000 <= t && e.price < price && (price - e.price) / price <= guard);
      if (blocked) { skips.eqh++; continue; }
    }

    pos = {
      side: b15.dir, entry: price, entryT: t,
      sl: b15.dir === 'long' ? price * (1 - slPx) : price * (1 + slPx),
      tp: b15.dir === 'long' ? price * (1 + tpPx) : price * (1 - tpPx),
    };
    lastWindow = windowKey;
  }

  return { trades, skips, opts: o, counts: { k1h: k1h.length, k15: k15.length, k1m: k1m.length,
    lab1h: lab1h.length, lab15: lab15.length, eqh1h: eqh1h.length, piv1m: piv.length } };
}

function summarize(trades) {
  const g = ts => {
    if (!ts.length) return { n: 0 };
    const wins = ts.filter(t => t.r > 0);
    const pnl = ts.reduce((a, t) => a + t.r, 0);
    const gW = wins.reduce((a, t) => a + t.r, 0);
    const gL = ts.filter(t => t.r <= 0).reduce((a, t) => a + t.r, 0);
    return {
      n: ts.length, wins: wins.length, wr: wins.length / ts.length,
      pnl, perTrade: pnl / ts.length, pf: gL !== 0 ? gW / -gL : Infinity,
    };
  };
  return {
    all: g(trades),
    longs: g(trades.filter(t => t.side === 'long')),
    shorts: g(trades.filter(t => t.side === 'short')),
  };
}

module.exports = { runMtfBacktest, summarize, DEFAULTS };
