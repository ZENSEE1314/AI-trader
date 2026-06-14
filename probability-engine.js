// ─────────────────────────────────────────────────────────────────────────────
// probability-engine.js
// Faithful JS port of the SMC Pro Suite [Probability Engine] Pine, including the
// sticky-event "confluence memory" fix. Computes probLong / probShort per bar on
// the chart (bias) timeframe — same numbers the dashboard would show.
//
// Each of 5 components scores 0-4 (capped), + zone boost up to 4, /24 → 0-100%.
// ─────────────────────────────────────────────────────────────────────────────

// ── small indicator helpers ──────────────────────────────────────────────────
function emaArr(src, len) {
  const k = 2 / (len + 1), out = new Array(src.length);
  let e = src[0];
  for (let i = 0; i < src.length; i++) { e = i === 0 ? src[0] : src[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function smaArr(src, len) {
  const out = new Array(src.length); let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i]; if (i >= len) sum -= src[i - len];
    out[i] = i >= len - 1 ? sum / len : src[i];
  }
  return out;
}
function atrArr(c, len) {
  const tr = c.map((x, i) => i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
  return emaArr(tr, len); // RMA≈EMA approximation, fine for scoring
}
function rollSum(src, len, i) { let s = 0; for (let j = Math.max(0, i - len + 1); j <= i; j++) s += src[j]; return s; }
function rollStd(src, len, i) {
  const a = Math.max(0, i - len + 1); let n = 0, m = 0, m2 = 0;
  for (let j = a; j <= i; j++) { n++; const d = src[j] - m; m += d / n; m2 += d * (src[j] - m); }
  return n > 1 ? Math.sqrt(m2 / n) : 0;
}
function highest(src, len, i) { let h = -Infinity; for (let j = Math.max(0, i - len + 1); j <= i; j++) h = Math.max(h, src[j]); return h; }
function lowest(src, len, i) { let l = Infinity; for (let j = Math.max(0, i - len + 1); j <= i; j++) l = Math.min(l, src[j]); return l; }

// Wilder ADX (for the trend gate)
function adxArr(c, len) {
  const n = c.length, plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  const rma = (src) => { const o = new Array(n); let r = src[0]; for (let i = 0; i < n; i++) { r = i === 0 ? src[0] : (r * (len - 1) + src[i]) / len; o[i] = r; } return o; };
  const trR = rma(tr), pR = rma(plusDM), mR = rma(minusDM), dx = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const pdi = trR[i] ? 100 * pR[i] / trR[i] : 0, mdi = trR[i] ? 100 * mR[i] / trR[i] : 0;
    dx[i] = (pdi + mdi) ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  return rma(dx);
}

// ── main: compute per-bar probabilities ──────────────────────────────────────
function computeProbability(c, opts = {}) {
  const pivLen = opts.pivLen ?? 5;
  const confWin = opts.confWin ?? 8;     // matches the Pine "Confluence memory (bars)"
  const liqTol = opts.liqTol ?? 0.1;
  const cdLen = opts.cdLen ?? 20;
  const obStrength = opts.obStrength ?? 3;
  const n = c.length;
  const close = c.map(x => x.close), high = c.map(x => x.high), low = c.map(x => x.low), open = c.map(x => x.open);
  const vol = c.map(x => x.volume || 0), hlc3 = c.map(x => (x.high + x.low + x.close) / 3);

  const atr14 = atrArr(c, 14), emaF = emaArr(close, 20), emaS = emaArr(close, 50), ema200 = emaArr(close, 200);
  const adx14 = adxArr(c, 14);

  // VWAP (daily anchored, UTC)
  const aboveVwap = new Array(n).fill(false);
  let tpv = 0, vv = 0, curDay = -1;
  for (let i = 0; i < n; i++) {
    const day = Math.floor(c[i].time / 86_400_000);
    if (day !== curDay) { tpv = 0; vv = 0; curDay = day; }
    tpv += hlc3[i] * vol[i]; vv += vol[i];
    const vwap = vv > 0 ? tpv / vv : NaN;
    aboveVwap[i] = !isNaN(vwap) && close[i] > vwap;
  }

  // Volume delta series
  const barDelta = c.map(x => { const r = x.high - x.low; const bv = r > 0 ? (x.close - x.low) / r * (x.volume || 0) : (x.volume || 0) * 0.5; const sv = r > 0 ? (x.high - x.close) / r * (x.volume || 0) : (x.volume || 0) * 0.5; return bv - sv; });
  const cumDelta = new Array(n); for (let i = 0; i < n; i++) cumDelta[i] = rollSum(barDelta, cdLen, i);

  // WaveTrend (LazyBear)
  const esa = emaArr(hlc3, 10);
  const dAbs = emaArr(hlc3.map((v, i) => Math.abs(v - esa[i])), 10);
  const ci = hlc3.map((v, i) => dAbs[i] !== 0 ? (v - esa[i]) / (0.015 * dAbs[i]) : 0);
  const wt1 = emaArr(ci, 21), wt2 = smaArr(wt1, 4);

  // sticky-event memory: returns true if event fired within confWin bars
  const lastFire = {};
  const recent = (key, cond, i) => { if (cond) lastFire[key] = i; return lastFire[key] !== undefined && (i - lastFire[key]) <= confWin; };

  // pivot / structure running state
  let lastPH = 0, lastPL = 0, lblH = '', lblL = '';
  // liquidity 3-slot EQH/EQL state
  let eqh = [], eql = []; // each: {price, swept}
  const pivH = [], pivL = [];
  // OB state
  let bullTop = 0, bullBot = 0, bullBroken = false, bearTop = 0, bearBot = 0, bearBroken = false;

  const probLong = new Array(n).fill(0), probShort = new Array(n).fill(0);
  const trendGateLong = new Array(n).fill(true), trendGateShort = new Array(n).fill(true);
  const time = c.map(x => x.time);

  const isPivotHigh = (i) => { const p = i - pivLen; if (p < pivLen || i >= n) return false; for (let k = 1; k <= pivLen; k++) if (!(high[p] > high[p - k] && high[p] > high[p + k])) return false; return true; };
  const isPivotLow = (i) => { const p = i - pivLen; if (p < pivLen || i >= n) return false; for (let k = 1; k <= pivLen; k++) if (!(low[p] < low[p - k] && low[p] < low[p + k])) return false; return true; };
  const near = (a, b) => Math.abs(a - b) / b * 100 <= liqTol;

  for (let i = 0; i < n; i++) {
    // ---- pivots ----
    let newPH = false, newPL = false, phVal = 0, plVal = 0;
    if (i >= 2 * pivLen) {
      if (isPivotHigh(i)) { newPH = true; phVal = high[i - pivLen]; const prev = lastPH; lastPH = phVal; lblH = (prev === 0 || phVal > prev) ? 'HH' : 'LH'; pivH.push(phVal); if (pivH.length > 50) pivH.shift(); }
      if (isPivotLow(i)) { newPL = true; plVal = low[i - pivLen]; const prev = lastPL; lastPL = plVal; lblL = (prev === 0 || plVal > prev) ? 'HL' : 'LL'; pivL.push(plVal); if (pivL.length > 50) pivL.shift(); }
    }

    // ---- BOS / CHoCH (crossover of close vs last pivot) ----
    const crossUp = i > 0 && lastPH > 0 && close[i] > lastPH && close[i - 1] <= lastPH;
    const crossDn = i > 0 && lastPL > 0 && close[i] < lastPL && close[i - 1] >= lastPL;
    const anyBosLong = (lblH === 'HH' && crossUp) || (lblH === 'LH' && crossUp);
    const anyBosShort = (lblL === 'LL' && crossDn) || (lblL === 'HL' && crossDn);

    // ---- structure score ----
    const mid = lastPL > 0 ? lastPL + (lastPH - lastPL) * 0.5 : close[i];
    const smcLong = (recent('bosL', anyBosLong, i) ? 2 : 0) + (lblL === 'HL' ? 1 : 0) + (close[i] < mid ? 1 : 0);
    const smcShort = (recent('bosS', anyBosShort, i) ? 2 : 0) + (lblH === 'LH' ? 1 : 0) + (close[i] > mid ? 1 : 0);

    // ---- liquidity: EQH/EQL + sweeps ----
    if (newPH && pivH.length >= 2) {
      const h1 = pivH[pivH.length - 1]; let found = false;
      for (let j = 0; j < pivH.length - 1; j++) if (near(h1, pivH[j])) { found = true; break; }
      const known = eqh.some(e => near(e.price, h1));
      if (found && !known) { eqh.unshift({ price: h1, swept: false }); if (eqh.length > 3) eqh.pop(); }
    }
    if (newPL && pivL.length >= 2) {
      const l1 = pivL[pivL.length - 1]; let found = false;
      for (let j = 0; j < pivL.length - 1; j++) if (near(l1, pivL[j])) { found = true; break; }
      const known = eql.some(e => near(e.price, l1));
      if (found && !known) { eql.unshift({ price: l1, swept: false }); if (eql.length > 3) eql.pop(); }
    }
    let bslSweep = false, sslSweep = false;
    for (const e of eqh) if (!e.swept && high[i] > e.price && close[i] < e.price) { e.swept = true; bslSweep = true; }
    for (const e of eql) if (!e.swept && low[i] < e.price && close[i] > e.price) { e.swept = true; sslSweep = true; }
    const nearBSL = eqh.some(e => !e.swept && Math.abs(high[i] - e.price) / e.price * 100 <= liqTol * 3);
    const nearSSL = eql.some(e => !e.swept && Math.abs(low[i] - e.price) / e.price * 100 <= liqTol * 3);
    const bslLevel = eqh.length ? eqh[0].price : 0, sslLevel = eql.length ? eql[0].price : 0;
    const bslSwept = eqh.length ? eqh[0].swept : false, sslSwept = eql.length ? eql[0].swept : false;
    const priceAboveBSL = bslLevel > 0 && close[i] > bslLevel, priceBelowSSL = sslLevel > 0 && close[i] < sslLevel;
    const liqLong = (recent('sslSw', sslSweep, i) ? 2 : 0) + (priceBelowSSL ? 0 : (sslSwept ? 1 : 0)) + (nearSSL ? 1 : 0);
    const liqShort = (recent('bslSw', bslSweep, i) ? 2 : 0) + (priceAboveBSL ? 0 : (bslSwept ? 1 : 0)) + (nearBSL ? 1 : 0);

    // ---- volume delta score ----
    const dStd = rollStd(barDelta, cdLen, i);
    const impBull = barDelta[i] > dStd * 1.5, impBear = barDelta[i] < -dStd * 1.5;
    const pNewHigh = high[i] === highest(high, pivLen, i), pNewLow = low[i] === lowest(low, pivLen, i);
    const divBear = pNewHigh && i >= pivLen && cumDelta[i] < cumDelta[i - pivLen];
    const divBull = pNewLow && i >= pivLen && cumDelta[i] > cumDelta[i - pivLen];
    const volLong = (cumDelta[i] > 0 ? 1 : 0) + (recent('impB', impBull, i) ? 1 : 0) + (recent('divB', divBull, i) ? 2 : 0);
    const volShort = (cumDelta[i] < 0 ? 1 : 0) + (recent('impS', impBear, i) ? 1 : 0) + (recent('divS', divBear, i) ? 2 : 0);

    // ---- order block score ----
    const bullImp = close[i] > open[i] && (close[i] - open[i]) > atr14[i] * 0.6;
    const bearImp = close[i] < open[i] && (open[i] - close[i]) > atr14[i] * 0.6;
    if (bullImp) for (let k = 1; k <= obStrength + 2; k++) { if (i - k >= 0 && close[i - k] < open[i - k]) { bullTop = Math.max(open[i - k], close[i - k]); bullBot = Math.min(open[i - k], close[i - k]); bullBroken = false; break; } }
    if (bearImp) for (let k = 1; k <= obStrength + 2; k++) { if (i - k >= 0 && close[i - k] > open[i - k]) { bearTop = Math.max(open[i - k], close[i - k]); bearBot = Math.min(open[i - k], close[i - k]); bearBroken = false; break; } }
    if (!bullBroken && bullBot > 0 && close[i] < bullBot) bullBroken = true;
    if (!bearBroken && bearTop > 0 && close[i] > bearTop) bearBroken = true;
    const inBullOB = !bullBroken && bullTop > 0 && close[i] >= bullBot && close[i] <= bullTop;
    const inBearOB = !bearBroken && bearTop > 0 && close[i] >= bearBot && close[i] <= bearTop;
    const atBullBrk = bullBroken && bullTop > 0 && close[i] >= bullBot && close[i] <= bullTop;
    const atBearBrk = bearBroken && bearTop > 0 && close[i] >= bearBot && close[i] <= bearTop;
    const obLong = (inBullOB ? 2 : 0) + (atBearBrk ? 2 : 0);
    const obShort = (inBearOB ? 2 : 0) + (atBullBrk ? 2 : 0);

    // ---- wavetrend score ----
    const crossWtUp = i > 0 && wt1[i] > wt2[i] && wt1[i - 1] <= wt2[i - 1];
    const crossWtDn = i > 0 && wt1[i] < wt2[i] && wt1[i - 1] >= wt2[i - 1];
    const wtOB = wt1[i] >= 53, wtOS = wt1[i] <= -53, wtOBx = wt1[i] >= 60, wtOSx = wt1[i] <= -60;
    const wtDivBull = wt1[i] < -53 && i > 0 && wt1[i] > wt1[i - 1] && close[i] < close[i - 1];
    const wtDivBear = wt1[i] > 53 && i > 0 && wt1[i] < wt1[i - 1] && close[i] > close[i - 1];
    const wtLong = (recent('wtX', crossWtUp, i) ? 1 : 0) + (wtOS ? 1 : 0) + (wtOSx ? 1 : 0) + (recent('wtDB', wtDivBull, i) ? 1 : 0);
    const wtShort = (recent('wtXd', crossWtDn, i) ? 1 : 0) + (wtOB ? 1 : 0) + (wtOBx ? 1 : 0) + (recent('wtDBe', wtDivBear, i) ? 1 : 0);

    // ---- zone boost + final probability ----
    const cap4 = v => Math.min(4, Math.max(0, v));
    const zoneL = (wtOSx && inBullOB) ? 4 : (wtOSx && aboveVwap[i]) ? 2 : (wtOS && inBullOB) ? 2 : 0;
    const zoneS = (wtOBx && inBearOB) ? 4 : (wtOBx && !aboveVwap[i]) ? 2 : (wtOB && inBearOB) ? 2 : 0;
    const rawL = cap4(smcLong) + cap4(liqLong) + cap4(volLong) + cap4(obLong) + cap4(wtLong) + zoneL;
    const rawS = cap4(smcShort) + cap4(liqShort) + cap4(volShort) + cap4(obShort) + cap4(wtShort) + zoneS;
    probLong[i] = Math.round(rawL / 24 * 100);
    probShort[i] = Math.round(rawS / 24 * 100);
    trendGateLong[i] = !(emaF[i] < ema200[i] && emaS[i] < ema200[i] && adx14[i] > 30);
    trendGateShort[i] = !(emaF[i] > ema200[i] && emaS[i] > ema200[i] && adx14[i] > 30);
  }

  // lookup: probability of the bias bar at-or-before a given time, by direction
  function probAt(t, side) {
    // binary search last bar with time <= t
    let lo = 0, hi = n - 1, idx = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (time[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
    return side === 'long' ? probLong[idx] : probShort[idx];
  }

  return { time, probLong, probShort, trendGateLong, trendGateShort, probAt };
}

module.exports = { computeProbability };
