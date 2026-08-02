// Strategy: "Market-Structure + Order-Block + VWAP-band short" (owner spec).
//
// Rules (as specified):
//   1. HTF context — a strong HH or LH swing high on 1H or 4H (we're at a high).
//   2. LTF timing  — 15m and 1m confirm the down move (not bullish).
//   3. Entry       — SHORT when price is near the VWAP UPPER band (premium).
//   4. Target (TP) — the NEAREST GREEN (bullish/demand) order block BELOW entry.
//   5. Skip guard  — if a RED (bearish/supply) order block is NEARER than the
//                    green one (price would run up to it first), DO NOT trade;
//                    wait for the next signal.
//
// Pure evaluator — pass candles in (webhook/scan fetches them). Reuses
// smc-engine: analyzeStructure, detectOrderBlocks. Candle shape = smc-engine's
// { t,o,h,l,c,v,body,bullish }.

const smc = require('./smc-engine');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const cfg = () => ({
  vwapK:      num(process.env.MSOB_VWAP_K, 2),           // upper band = VWAP + K·σ
  nearProx:   num(process.env.MSOB_VWAP_PROX_PCT, 0.15) / 100, // "near" the band
  minRR:      num(process.env.MSOB_MIN_RR, 1.2),         // min reward:risk
  slBufPct:   num(process.env.MSOB_SL_BUF_PCT, 0.1) / 100,
  htfLookbackHighs: 4,
});

// Session VWAP + std-dev bands over the current UTC day.
function vwapBands(candles, k) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const d = new Date(last.t); d.setUTCHours(0, 0, 0, 0);
  const dayStart = d.getTime();
  let cumPV = 0, cumV = 0; const tps = [], vols = [];
  for (const c of candles) {
    if (c.t < dayStart) continue;
    const tp = (c.h + c.l + c.c) / 3;
    cumPV += tp * c.v; cumV += c.v; tps.push(tp); vols.push(c.v);
  }
  if (cumV <= 0 || tps.length < 3) return null;
  const vwap = cumPV / cumV;
  let varNum = 0;
  for (let i = 0; i < tps.length; i++) varNum += vols[i] * Math.pow(tps[i] - vwap, 2);
  const sd = Math.sqrt(varNum / cumV);
  return { vwap, upper: vwap + k * sd, lower: vwap - k * sd, sd };
}

// Most-recent swing-high label (HH/LH) from analyzeStructure pivots.
function lastHighLabel(struct) {
  const H = (struct.lastHighs || []);
  if (H.length < 2) return H.length === 1 ? 'H' : null;
  return H[H.length - 1].price > H[H.length - 2].price ? 'HH' : 'LH';
}

function orderBlocks(candles) {
  try {
    const st = smc.analyzeStructure(candles, 10, 3);
    return smc.detectOrderBlocks(candles, st.pivots) || [];
  } catch { return []; }
}
const isGreen = ob => /BULLISH/.test(ob.type) || ob.bbDirection === 'BULLISH';
const isRed   = ob => /BEARISH/.test(ob.type) && ob.bbDirection !== 'BULLISH';

// candles: { c1h, c4h, c15, c1m }. Returns a decision object.
function evaluate({ symbol, c1h, c4h, c15, c1m } = {}) {
  const C = cfg();
  const reject = reason => ({ signal: null, symbol, take: false, reason });
  if (!c15 || c15.length < 30) return reject('insufficient 15m data');

  const price = c15[c15.length - 1].c;

  // ── 3. VWAP upper-band proximity (entry zone) ──
  const vb = vwapBands(c15, C.vwapK);
  if (!vb) return reject('VWAP unavailable');
  const nearUpper = price >= vb.upper * (1 - C.nearProx) && price <= vb.upper * (1 + C.nearProx);
  if (!nearUpper) return reject(`price ${price} not near VWAP upper band ${vb.upper.toFixed(4)}`);

  // ── 1. HTF context: a recent swing high (HH/LH) on 1H or 4H ──
  const htf = [];
  if (c1h && c1h.length > 40) { const s = smc.analyzeStructure(c1h, 10, 3); htf.push(['1H', lastHighLabel(s), s]); }
  if (c4h && c4h.length > 40) { const s = smc.analyzeStructure(c4h, 10, 3); htf.push(['4H', lastHighLabel(s), s]); }
  const htfHigh = htf.find(([, lbl]) => lbl === 'HH' || lbl === 'LH');
  if (!htfHigh) return reject('no strong HH/LH swing high on 1H or 4H');

  // ── 2. LTF confirmation: 15m + 1m not bullish (down move forming) ──
  const st15 = smc.analyzeStructure(c15, 10, 3);
  if (st15.bias === 'BULLISH') return reject('15m structure still bullish — no short confirmation');
  if (c1m && c1m.length > 20) {
    const l1 = c1m[c1m.length - 1];
    if (l1.c > l1.o && lastHighLabel(smc.analyzeStructure(c1m, 8, 2)) === 'HH')
      return reject('1m still printing HH — wait for lower high');
  }

  // ── 4 + 5. Order blocks: nearest green below (target) vs nearest red above (skip) ──
  const obs = [...orderBlocks(c15), ...(c1h && c1h.length > 40 ? orderBlocks(c1h) : [])];
  const greenBelow = obs.filter(o => isGreen(o) && o.mid < price).sort((a, b) => b.mid - a.mid)[0]; // closest below
  const redAbove   = obs.filter(o => isRed(o)   && o.mid > price).sort((a, b) => a.mid - b.mid)[0]; // closest above
  if (!greenBelow) return reject('no green order block below to target');

  const target = greenBelow.mid;
  const distGreen = price - target;                 // downside to target (reward)
  if (redAbove) {
    const distRed = redAbove.mid - price;           // upside to red
    if (distRed < distGreen)
      return reject(`red OB @ ${redAbove.mid.toFixed(4)} nearer than green target — price likely runs up first; wait`);
  }

  // ── SL above the invalidation: the structure swing high / VWAP upper band.
  // (A *near* red OB above would already have triggered the skip guard; a far
  // red OB must not widen the stop.) ──
  const swingHigh = htfHigh[2].swingHigh ? htfHigh[2].swingHigh.price : null;
  const slBase = Math.max(swingHigh || 0, vb.upper, price);
  const sl = slBase * (1 + C.slBufPct);
  const risk = sl - price, reward = distGreen;
  if (!(reward > 0) || !(risk > 0)) return reject('non-positive risk or reward');
  const rr = reward / risk;
  if (rr < C.minRR) return reject(`RR ${rr.toFixed(2)} < min ${C.minRR}`);

  return {
    signal: 'SHORT', symbol, take: true,
    entry: price, tp: target, sl,
    rr: Number(rr.toFixed(2)),
    reason: `SHORT @ VWAP upper ${vb.upper.toFixed(4)} | HTF ${htfHigh[0]} ${htfHigh[1]} | 15m ${st15.bias}`
      + ` | target green OB ${target.toFixed(4)}${redAbove ? ` (red @ ${redAbove.mid.toFixed(4)} is farther)` : ''} | RR ${rr.toFixed(2)}`,
    meta: { vwap: vb.vwap, upper: vb.upper, greenOB: greenBelow.mid, redOB: redAbove?.mid ?? null },
  };
}

module.exports = { evaluate, vwapBands, lastHighLabel };
