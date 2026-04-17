'use strict';

// ============================================================
// COMBINED 7-DAY BACKTEST — SMC + Spike-HL + Triple MA A/B
//
// Matching exactly what the live bot does:
//   SMC + Spike-HL  → 1m candles, during sessions
//   Triple MA A/B   → 5m candles, outside sessions  ← KEY FIX
//
// Triple-A was broken in the old sim because it used 1m bars
// for MA20 (= 20min window). Live bot uses 5m (= 100min window).
// The convergence of MA20 toward entry happens over ~25-35 bars
// on 5m = 2-3 hours, not on 1m = 20 minutes.
//
// Capital: $1000, 10% per trade, shared pool across all strategies.
// ============================================================

// ─── Symbols ─────────────────────────────────────────────────

const SMC_SYM = [
  { name: 'BTCUSDT', lev: 100, vol: 0.0040 },
  { name: 'ETHUSDT', lev: 100, vol: 0.0050 },
  { name: 'SOLUSDT', lev: 20,  vol: 0.0070 },
  { name: 'BNBUSDT', lev: 20,  vol: 0.0040 },
];

const TRI_SYM = [
  { name: 'ETHUSDT', lev: 50,  vol5: 0.0055 },
  { name: 'SOLUSDT', lev: 20,  vol5: 0.0075 },
  { name: 'BNBUSDT', lev: 20,  vol5: 0.0045 },
];

// ─── Time config ─────────────────────────────────────────────
const DAYS      = 7;
const N_1M      = DAYS * 1440;   // 10080 bars
const N_5M      = DAYS * 288;    // 2016 bars
const CAPITAL   = 1000;
const SIZE_PCT  = 0.10;

// ─── Strategy params ─────────────────────────────────────────
// SMC
const SMC_TP    = 0.020;
const SMC_SL    = 0.010;
const SMC_PROX  = 0.006;
const SWING_LB  = 5;
const EMA200P   = 200;

// Spike-HL
const SPIKE_MIN = 0.0015;
const SPIKE_MAX = 0.015;
const WICK_RAT  = 1.2;
const SPIKE_BUF = 0.001;

// Triple MA
const MA_FAST   = 5;
const MA_MED    = 10;
const MA_SLOW   = 20;
const A_SL      = 0.010;
const A_TOL     = 0.005;   // price within 0.5% of MA level
const ATR_MAX   = 0.008;   // 0.8% ATR-to-price = sideways
const RSI_P     = 14;
const RSI_LIM   = 45;
const BB_P      = 20;
const BB_STD    = 2.0;

const B_TIERS = [
  { trigger: 0.050, lockTo: 0.025 },
  { trigger: 0.100, lockTo: 0.075 },
  { trigger: 0.150, lockTo: 0.125 },
  { trigger: 0.200, lockTo: 0.175 },
  { trigger: 0.250, lockTo: 0.225 },
];

const MAX_HOLD_1M  = 240;  // 4h in 1m bars
const MAX_HOLD_5M  = 72;   // 6h in 5m bars (36 bars × 5min = 3h, 72 = 6h)

// Sessions (UTC hours)
const SESSIONS  = [[23, 2], [7, 10], [12, 16]];
const AVOID_MIN = new Set([0, 15, 30, 45]);

// ─── Candle Generators ───────────────────────────────────────

function gen1m(n, vol, seed) {
  const bars = [];
  let price = 1000;
  const PHASES  = [250, 80, 250, 80];
  const DRIFTS  = [+0.00018, 0.00001, -0.00018, -0.00001];
  const SWEEP_IV = 28;
  let ph = seed % 4, phBar = seed % 30;

  for (let i = 0; i < n; i++) {
    if (phBar >= PHASES[ph % 4]) { ph++; phBar = 0; }
    phBar++;
    const isUp   = (ph % 4) === 0;
    const isDn   = (ph % 4) === 2;
    const drift  = DRIFTS[ph % 4];
    const noise  = vol * (Math.random() * 2 - 1);
    const open   = price;
    const close  = Math.max(open * (1 + drift + noise), 0.001);
    const body   = Math.abs(close - open);
    // Sweep spikes: down-wick in uptrend, up-wick in downtrend
    const sweep  = (isUp && phBar % SWEEP_IV === 0 && phBar > 8) ||
                   (isDn && phBar % SWEEP_IV === 0 && phBar > 8);
    let high, low;
    if (sweep && isUp) {
      const d = 0.003 + Math.random() * 0.009;
      low  = open * (1 - d);
      high = Math.max(open, close) * (1 + Math.random() * 0.001);
    } else if (sweep && isDn) {
      const d = 0.003 + Math.random() * 0.009;
      high = open * (1 + d);
      low  = Math.min(open, close) - body * 0.2;
    } else {
      high = Math.max(open, close) + body * (0.1 + Math.random() * 0.55);
      low  = Math.min(open, close) - body * (0.1 + Math.random() * 0.55);
    }
    bars.push({ ts: Date.now() - (n - i) * 60_000, open, high, low, close });
    price = close;
  }
  return bars;
}

// 5m candles: properly scaled vol, with dip pullbacks for Triple-B
function gen5m(n, vol5, seed) {
  const bars = [];
  let price = 1000;
  const PHASES  = [50, 16, 50, 16];  // 5m equivalents of 1m phases
  const DRIFTS  = [+0.0009, 0.00005, -0.0009, -0.00005];
  const DIP_IV  = 12; // dip every ~12 bars in uptrend for Triple-B
  let ph = seed % 4, phBar = seed % 10;

  for (let i = 0; i < n; i++) {
    if (phBar >= PHASES[ph % 4]) { ph++; phBar = 0; }
    phBar++;
    const isUp  = (ph % 4) === 0;
    const drift = DRIFTS[ph % 4];
    const noise = vol5 * (Math.random() * 2 - 1);
    const open  = price;
    const close = Math.max(open * (1 + drift + noise), 0.001);
    const body  = Math.abs(close - open);

    // Dip candles in uptrend: sharp 0.3-0.7% pullback (creates RSI<45 + BB-lower touch)
    const isDip = isUp && phBar % DIP_IV === 0 && phBar > 5;
    let high, low;
    if (isDip) {
      const d = 0.003 + Math.random() * 0.004;
      const dipClose = open * (1 - d);
      high = open + body * 0.1;
      low  = dipClose - body * 0.1;
      bars.push({ ts: Date.now() - (n - i) * 300_000, open, high, low, close: dipClose });
      price = dipClose;
      phBar++; // consume one extra bar for the dip
      continue;
    }

    high = Math.max(open, close) + body * (0.1 + Math.random() * 0.5);
    low  = Math.min(open, close) - body * (0.1 + Math.random() * 0.5);
    bars.push({ ts: Date.now() - (n - i) * 300_000, open, high, low, close });
    price = close;
    phBar++;
  }
  return bars;
}

// ─── Indicators ──────────────────────────────────────────────

function ema200last(bars) {
  // Returns EMA200 array, one value per bar
  const k = 2 / (EMA200P + 1);
  const out = new Array(bars.length).fill(null);
  let v = bars[0].close;
  for (let i = 0; i < bars.length; i++) {
    v = bars[i].close * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function sma(closes, p) {
  if (closes.length < p) return null;
  return closes.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function calcRsi(closes) {
  if (closes.length < RSI_P + 1) return null;
  let g = 0, l = 0;
  const slice = closes.slice(-RSI_P - 1);
  for (let i = 1; i <= RSI_P; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return 100 - 100 / (1 + (g / RSI_P) / ((l / RSI_P) || 0.00001));
}

function calcBb(closes) {
  if (closes.length < BB_P) return null;
  const slice = closes.slice(-BB_P);
  const mean  = slice.reduce((a, b) => a + b, 0) / BB_P;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / BB_P);
  return { upper: mean + BB_STD * std, lower: mean - BB_STD * std };
}

function calcAtr(bars) {
  if (bars.length < ATR_MAX + 1) return null;
  const slice = bars.slice(-15);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    sum += Math.max(slice[i].high, slice[i-1].close) - Math.min(slice[i].low, slice[i-1].close);
  }
  return sum / (slice.length - 1);
}

// ─── Session ─────────────────────────────────────────────────

function inSess(ts) {
  const d = new Date(ts), h = d.getUTCHours(), m = d.getUTCMinutes();
  if (AVOID_MIN.has(m)) return false;
  for (const [s, e] of SESSIONS) {
    if (e < s) { if (h >= s || h < e) return true; }
    else        { if (h >= s && h < e) return true; }
  }
  return false;
}

// ─── Swing Helpers (for SMC) ─────────────────────────────────

function detectSwings(bars) {
  const n = bars.length;
  const sH = new Array(n).fill(null), sL = new Array(n).fill(null);
  for (let i = SWING_LB; i < n - SWING_LB; i++) {
    let iH = true, iL = true;
    for (let j = i - SWING_LB; j <= i + SWING_LB; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) iH = false;
      if (bars[j].low  <= bars[i].low)  iL = false;
    }
    if (iH) sH[i] = bars[i].high;
    if (iL) sL[i] = bars[i].low;
  }
  return { sH, sL };
}

function labelSw(sH, sL, upTo) {
  const H = [], L = [];
  for (let i = 0; i <= upTo; i++) {
    if (sH[i]) { const p = H[H.length-1]; H.push({ price: sH[i], label: !p?'HH':sH[i]>p.price?'HH':'LH' }); }
    if (sL[i]) { const p = L[L.length-1]; L.push({ price: sL[i], label: !p?'HL':sL[i]>p.price?'HL':'LL' }); }
  }
  return { H, L };
}

function bias3m(sH, sL, upTo) {
  const { H, L } = labelSw(sH, sL, upTo);
  if (H.length < 2 || L.length < 2) return null;
  if (H[H.length-1].label==='HH' && L[L.length-1].label==='HL') return 'bull';
  if (H[H.length-1].label==='LH' && L[L.length-1].label==='LL') return 'bear';
  return null;
}

function make3m(b1) {
  const out = [];
  for (let i = 0; i + 2 < b1.length; i += 3) {
    const s = b1.slice(i, i+3);
    out.push({ ts: s[0].ts, open: s[0].open,
      high: Math.max(...s.map(b=>b.high)), low: Math.min(...s.map(b=>b.low)), close: s[2].close });
  }
  return out;
}

function f3m(b3, ts) {
  let lo = 0, hi = b3.length-1, best = -1;
  while (lo<=hi) { const m=(lo+hi)>>1; if(b3[m].ts<=ts){best=m;lo=m+1;}else hi=m-1; }
  return best;
}

// ─── Spike Detectors ─────────────────────────────────────────

function spikeLong(bars) {
  const spike = bars[bars.length-1];
  let prevHL = null;
  for (let b = 2; b <= 6 && bars.length - b >= 1; b++) {
    const idx = bars.length - b;
    if (bars[idx].low > bars[idx-1].low) { prevHL = bars[idx].low; break; }
  }
  if (!prevHL || spike.low >= prevHL) return null;
  const d = (prevHL - spike.low) / prevHL;
  if (d < SPIKE_MIN || d > SPIKE_MAX) return null;
  if (spike.close <= prevHL) return null;
  const body = Math.abs(spike.close - spike.open);
  const wick = Math.min(spike.open, spike.close) - spike.low;
  if (body < 1e-6 || wick < WICK_RAT * body) return null;
  return { entry: spike.close, sl: spike.low * (1 - SPIKE_BUF), depth: d };
}

function spikeShort(bars) {
  const spike = bars[bars.length-1];
  let prevLH = null;
  for (let b = 2; b <= 6 && bars.length - b >= 1; b++) {
    const idx = bars.length - b;
    if (bars[idx].high < bars[idx-1].high) { prevLH = bars[idx].high; break; }
  }
  if (!prevLH || spike.high <= prevLH) return null;
  const d = (spike.high - prevLH) / prevLH;
  if (d < SPIKE_MIN || d > SPIKE_MAX) return null;
  if (spike.close >= prevLH) return null;
  const body = Math.abs(spike.close - spike.open);
  const wick = spike.high - Math.max(spike.open, spike.close);
  if (body < 1e-6 || wick < WICK_RAT * body) return null;
  return { entry: spike.close, sl: spike.high * (1 + SPIKE_BUF), depth: d };
}

// ─── Trade Simulator ─────────────────────────────────────────

function simFixed(bars, i, dir, entry, sl, tp, maxHold) {
  for (let j = i+1; j < Math.min(i+maxHold, bars.length); j++) {
    const b = bars[j];
    if (dir==='LONG') {
      if (b.low  <= sl)  return { pnl: (sl-entry)/entry,      exit:'sl',   bars:j-i };
      if (b.high >= tp)  return { pnl: tp-entry>0?(tp-entry)/entry:SMC_TP, exit:'tp', bars:j-i };
    } else {
      if (b.high >= sl)  return { pnl: (entry-sl)/entry,      exit:'sl',   bars:j-i };
      if (b.low  <= tp)  return { pnl: entry-tp>0?(entry-tp)/entry:SMC_TP, exit:'tp', bars:j-i };
    }
  }
  const ep = bars[Math.min(i+maxHold, bars.length-1)].close;
  return { pnl: dir==='LONG'?(ep-entry)/entry:(entry-ep)/entry, exit:'timeout', bars:maxHold };
}

function simSpikeTrail(bars, i, dir, entry, sl, maxHold) {
  let curSl = sl;
  for (let j = i+1; j < Math.min(i+maxHold, bars.length); j++) {
    const b = bars[j];
    if (j > i+1) {
      const prev = bars[j-1];
      if (dir==='LONG'  && b.low  > prev.low  && b.low  > entry && b.low  > curSl) curSl = b.low  * (1-SPIKE_BUF);
      if (dir==='SHORT' && b.high < prev.high && b.high < entry && b.high < curSl) curSl = b.high * (1+SPIKE_BUF);
    }
    if (dir==='LONG'  && b.low  <= curSl) return { pnl:(curSl-entry)/entry, exit:curSl>=entry?'trail_win':'sl', bars:j-i };
    if (dir==='SHORT' && b.high >= curSl) return { pnl:(entry-curSl)/entry, exit:curSl<=entry?'trail_win':'sl', bars:j-i };
  }
  const ep = bars[Math.min(i+maxHold, bars.length-1)].close;
  return { pnl: dir==='LONG'?(ep-entry)/entry:(entry-ep)/entry, exit:'timeout', bars:maxHold };
}

// Triple-A: MA20-touch exit on 5m bars
// Key fix: uses the 20-bar SMA of the RUNNING window, not static.
// After minimum 5 bars hold, check if SMA20 of last 20 bars converged to entry.
function simTripleA(bars5m, i, dir, entry, sl, maxHold) {
  for (let j = i+1; j < Math.min(i+maxHold, bars5m.length); j++) {
    const b = bars5m[j];
    const heldBars = j - i;

    // Hard SL check
    if (dir==='LONG'  && b.low  <= sl) return { pnl:(sl-entry)/entry,    exit:'sl',        bars:heldBars };
    if (dir==='SHORT' && b.high >= sl) return { pnl:(entry-sl)/entry,    exit:'sl',        bars:heldBars };

    // MA20-touch exit (minimum 5 bars = 25 minutes)
    if (heldBars >= 5) {
      const closes = bars5m.slice(Math.max(0, j-19), j+1).map(b=>b.close);
      const ma20   = sma(closes, Math.min(MA_SLOW, closes.length));
      if (ma20) {
        const touched = dir==='LONG' ? ma20 <= entry : ma20 >= entry;
        if (touched) {
          const pnl = dir==='LONG' ? (b.close-entry)/entry : (entry-b.close)/entry;
          return { pnl, exit:'ma20', bars:heldBars };
        }
      }
    }
  }
  const ep = bars5m[Math.min(i+maxHold, bars5m.length-1)].close;
  return { pnl: dir==='LONG'?(ep-entry)/entry:(entry-ep)/entry, exit:'timeout', bars:maxHold };
}

// Triple-B: trailing SL every +5% gain
function simTripleB(bars5m, i, entry, sl, maxHold) {
  let curSl = sl, lastLock = 0;
  for (let j = i+1; j < Math.min(i+maxHold, bars5m.length); j++) {
    const b = bars5m[j];
    // Advance trailing SL tiers
    const pct = (b.close - entry) / entry;
    for (const t of B_TIERS) {
      if (pct >= t.trigger && t.lockTo > lastLock) {
        lastLock = t.lockTo;
        curSl = entry * (1 + t.lockTo);
      }
    }
    if (b.low <= curSl) {
      return { pnl:(curSl-entry)/entry, exit:curSl>=entry?'trail_win':'sl', bars:j-i };
    }
  }
  const ep = bars5m[Math.min(i+maxHold, bars5m.length-1)].close;
  return { pnl:(ep-entry)/entry, exit:'timeout', bars:maxHold };
}

// ─── Combined Simulation ─────────────────────────────────────

function runSim(runId) {
  let capital = CAPITAL;
  const log   = [];
  const openSym = new Set();
  const dayLimits = {}; // day → { smc, spike, triple }

  function getDay(ts) { return new Date(ts).toISOString().slice(0,10); }
  function dayLim(ts) {
    const d = getDay(ts);
    if (!dayLimits[d]) dayLimits[d] = { smc:0, spike:0, triple:0 };
    return dayLimits[d];
  }

  // ── Precompute SMC data ──────────────────────────────────────
  const smcBars  = SMC_SYM.map((s,i) => gen1m(N_1M, s.vol, runId*10+i));
  const smcE200  = smcBars.map(b => ema200last(b));
  const smcSw1   = smcBars.map(b => detectSwings(b));
  const smcB3    = smcBars.map(b => make3m(b));
  const smcSw3   = smcB3.map(b => detectSwings(b));

  // ── Precompute Triple MA data (5m) ──────────────────────────
  const triBars  = TRI_SYM.map((s,i) => gen5m(N_5M, s.vol5, runId*10+i+5));

  // ── Active trade tracking ────────────────────────────────────
  // { endBarIdx, sym, strategy, dir, pnl, lev, usedCap, barTs, barIdxType }
  const active = [];

  // ── SMC / Spike-HL loop (1m bars) ───────────────────────────
  // We simulate each 1m bar, then at each 5m boundary also check Triple MA
  let tri5mCursor = Array(TRI_SYM.length).fill(0);
  let lastTriCheck = -1;

  for (let i = EMA200P + SWING_LB * 2 + 5; i < N_1M - MAX_HOLD_1M - 1; i++) {
    const ts    = smcBars[0][i].ts;
    const day   = getDay(ts);
    const dl    = dayLim(ts);
    const sess  = inSess(ts);

    // Settle closed trades
    for (let ti = active.length - 1; ti >= 0; ti--) {
      const t = active[ti];
      if (i >= t.endBar) {
        openSym.delete(t.sym);
        const gained = t.usedCap * t.result.pnl * t.lev;
        capital += t.usedCap + gained;
        capital  = Math.max(capital, 0);
        log.push({
          day,
          strategy:   t.strategy,
          sym:        t.sym,
          dir:        t.dir,
          pnl_lev:    parseFloat((t.result.pnl * t.lev * 100).toFixed(2)),
          dollar_pnl: parseFloat(gained.toFixed(2)),
          exit:       t.result.exit,
          bars:       t.result.bars,
          capital:    parseFloat(capital.toFixed(2)),
        });
        active.splice(ti, 1);
      }
    }

    if (capital < CAPITAL * 0.05) continue; // stop if nearly bust

    // ── SMC ──────────────────────────────────────────────────
    if (sess && dl.smc < 2) {
      for (let si = 0; si < SMC_SYM.length; si++) {
        const s   = SMC_SYM[si];
        if (openSym.has(s.name)) continue;
        const bar = smcBars[si][i];
        const e200= smcE200[si][i];
        const i3  = f3m(smcB3[si], bar.ts);
        if (i3 < SWING_LB*2) continue;
        const b   = bias3m(smcSw3[si].sH, smcSw3[si].sL, i3);
        if (!b) continue;
        if (b==='bull' && bar.close < e200) continue;
        if (b==='bear' && bar.close > e200) continue;
        const { H, L } = labelSw(smcSw1[si].sH, smcSw1[si].sL, i);
        let dir=null, swp=null;
        if (b==='bull') { if (!L.length||L[L.length-1].label!=='HL') continue; swp=L[L.length-1].price; dir='LONG'; }
        else             { if (!H.length||H[H.length-1].label!=='LH') continue; swp=H[H.length-1].price; dir='SHORT'; }
        if (Math.abs(bar.close-swp)/swp > SMC_PROX) continue;
        const entry = bar.close;
        const sl    = dir==='LONG'?entry*(1-SMC_SL):entry*(1+SMC_SL);
        const tp    = dir==='LONG'?entry*(1+SMC_TP):entry*(1-SMC_TP);
        const res   = simFixed(smcBars[si], i, dir, entry, sl, tp, MAX_HOLD_1M);
        const used  = capital * SIZE_PCT;
        capital    -= used;
        openSym.add(s.name);
        dl.smc++;
        active.push({ endBar:i+res.bars, sym:s.name, strategy:'SMC', dir, result:res, lev:s.lev, usedCap:used });
        break;
      }
    }

    // ── Spike-HL ─────────────────────────────────────────────
    if (sess && dl.spike < 2) {
      for (let si = 0; si < SMC_SYM.length; si++) {
        const s = SMC_SYM[si];
        if (openSym.has(s.name)) continue;
        const e200  = smcE200[si][i];
        const price = smcBars[si][i].close;
        const rec   = smcBars[si].slice(Math.max(0,i-9),i+1);
        const bull  = price > e200;
        let sig=null, dir=null;
        if (bull) { sig=spikeLong(rec);  dir='LONG';  }
        else       { sig=spikeShort(rec); dir='SHORT'; }
        if (!sig) continue;
        if (dir==='LONG'  && sig.sl>=sig.entry) continue;
        if (dir==='SHORT' && sig.sl<=sig.entry) continue;
        const res  = simSpikeTrail(smcBars[si], i, dir, sig.entry, sig.sl, MAX_HOLD_1M);
        const used = capital * SIZE_PCT;
        capital   -= used;
        openSym.add(s.name);
        dl.spike++;
        active.push({ endBar:i+res.bars, sym:s.name, strategy:'Spike-HL', dir, result:res, lev:s.lev, usedCap:used });
        break;
      }
    }

    // ── Triple MA (every 5 bars = once per 5m candle) ─────────
    if (!sess && i % 5 === 0 && dl.triple < 2) {
      const bar5mIdx = Math.floor(i / 5);
      if (bar5mIdx !== lastTriCheck && bar5mIdx >= BB_P + RSI_P + 5) {
        lastTriCheck = bar5mIdx;

        for (let si = 0; si < TRI_SYM.length; si++) {
          const s = TRI_SYM[si];
          if (openSym.has(s.name)) continue;
          const bars5m = triBars[si];
          if (bar5mIdx >= bars5m.length) continue;

          const closes = bars5m.slice(0, bar5mIdx+1).map(b=>b.close);
          const price  = closes[closes.length-1];

          const ma5  = sma(closes, MA_FAST);
          const ma10 = sma(closes, MA_MED);
          const ma20 = sma(closes, MA_SLOW);
          if (!ma5||!ma10||!ma20) continue;

          // ATR using proper true range on 5m bars
          const atrSlice = bars5m.slice(Math.max(0, bar5mIdx-14), bar5mIdx+1);
          let atrSum = 0;
          for (let k=1; k<atrSlice.length; k++) {
            atrSum += Math.max(atrSlice[k].high, atrSlice[k-1].close) - Math.min(atrSlice[k].low, atrSlice[k-1].close);
          }
          const atrVal = atrSlice.length > 1 ? atrSum / (atrSlice.length-1) : 0;
          const atrPct = atrVal / price;
          const sideways = atrPct < ATR_MAX;

          // ── Scenario A LONG ───────────────────────────────────
          if (ma20 > ma5 && ma20 > ma10 && sideways) {
            const loMA = Math.min(ma5, ma10);
            const dist = (price - loMA) / loMA;
            if (dist >= -0.002 && dist <= A_TOL) {  // price at or just above lowest MA
              const entry = price;
              const sl    = entry * (1 - A_SL);
              const res   = simTripleA(bars5m, bar5mIdx, 'LONG', entry, sl, MAX_HOLD_5M);
              // Map 5m bars back to 1m bar count for endBar tracking
              const used  = capital * SIZE_PCT;
              capital    -= used;
              openSym.add(s.name);
              dl.triple++;
              active.push({ endBar: i + res.bars*5, sym:s.name, strategy:'Triple-A', dir:'LONG', result:res, lev:s.lev, usedCap:used });
              break;
            }
          }
          // ── Scenario A SHORT ──────────────────────────────────
          else if (ma20 < ma5 && ma20 < ma10 && sideways) {
            const hiMA = Math.max(ma5, ma10);
            const dist = (hiMA - price) / hiMA;
            if (dist >= -0.002 && dist <= A_TOL) {
              const entry = price;
              const sl    = entry * (1 + A_SL);
              const res   = simTripleA(bars5m, bar5mIdx, 'SHORT', entry, sl, MAX_HOLD_5M);
              const used  = capital * SIZE_PCT;
              capital    -= used;
              openSym.add(s.name);
              dl.triple++;
              active.push({ endBar: i + res.bars*5, sym:s.name, strategy:'Triple-A', dir:'SHORT', result:res, lev:s.lev, usedCap:used });
              break;
            }
          }
          // ── Scenario B: RSI dip-buy in bullish uptrend ────────
          else if (ma20 < ma5 && ma20 < ma10 && !sideways) {
            const rsiVal = calcRsi(closes);
            const bb     = calcBb(closes);
            if (rsiVal && bb && rsiVal < RSI_LIM && closes[closes.length-1] <= bb.lower * 1.005) {
              const entry = price;
              const sl    = entry * (1 - A_SL); // 1% initial SL
              const res   = simTripleB(bars5m, bar5mIdx, entry, sl, MAX_HOLD_5M);
              const used  = capital * SIZE_PCT;
              capital    -= used;
              openSym.add(s.name);
              dl.triple++;
              active.push({ endBar: i + res.bars*5, sym:s.name, strategy:'Triple-B', dir:'LONG', result:res, lev:s.lev, usedCap:used });
              break;
            }
          }
        }
      }
    }
  }

  return log;
}

// ─── Stats & Reporting ───────────────────────────────────────

function stats(trades) {
  if (!trades.length) return null;
  const W = trades.filter(t=>t.pnl_lev>0);
  const L = trades.filter(t=>t.pnl_lev<=0);
  const gW = W.reduce((s,t)=>s+t.pnl_lev,0);
  const gL = L.reduce((s,t)=>s+Math.abs(t.pnl_lev),0);
  return {
    n:    trades.length,
    wins: W.length,
    wr:   (W.length/trades.length*100).toFixed(1),
    net:  trades.reduce((s,t)=>s+t.pnl_lev,0).toFixed(1),
    pf:   gL>0?(gW/gL).toFixed(2):'∞',
    avgW: W.length?(gW/W.length).toFixed(1):'0',
    avgL: L.length?(gL/L.length).toFixed(1):'0',
    maxW: W.length?Math.max(...W.map(t=>t.pnl_lev)).toFixed(1):'0',
    exits: trades.reduce((o,t)=>{o[t.exit]=(o[t.exit]||0)+1;return o;},{}),
  };
}

function printStats(label, trades) {
  const s = stats(trades);
  if (!s) { console.log(`  ${label}: no trades`); return; }
  const mark = parseFloat(s.wr)>=50?'✓':'✗';
  console.log(`  ${label.padEnd(12)} ${mark} ${String(s.n).padStart(3)} trades | WR=${s.wr.padStart(5)}% | Net=${parseFloat(s.net)>=0?'+':''}${s.net}% | PF=${s.pf} | AvgW=+${s.avgW}% AvgL=-${s.avgL}% | MaxW=+${s.maxW}%`);
  const exitStr = Object.entries(s.exits).map(([k,v])=>`${k}:${v}`).join(' ');
  console.log(`  ${''.padEnd(12)}   exits → ${exitStr}`);
}

// ─── Main ────────────────────────────────────────────────────

function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  COMBINED 7-DAY BACKTEST v2  (SMC + Spike-HL + Triple MA A/B)           ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
  console.log('  SMC + Spike-HL : 1m candles | During sessions  | BTC/ETH/SOL/BNB');
  console.log('  Triple MA A/B  : 5m candles | Outside sessions | ETH/SOL/BNB');
  console.log('  Capital $1,000 | 10% per trade | Shared pool | No double-entry per symbol');
  console.log('');

  const RUNS = 4;
  const allLogs = [];
  for (let r = 0; r < RUNS; r++) allLogs.push(runSim(r));
  const all = allLogs.flat();

  // ── Per-strategy ──────────────────────────────────────────
  console.log('PER-STRATEGY RESULTS (across all runs):');
  console.log('─'.repeat(85));
  for (const strat of ['SMC','Spike-HL','Triple-A','Triple-B']) {
    printStats(strat, all.filter(t=>t.strategy===strat));
  }

  // ── Overall ──────────────────────────────────────────────
  console.log('');
  console.log('═'.repeat(85));
  printStats('OVERALL', all);

  // ── Day-by-day (run 1) ───────────────────────────────────
  const run1 = allLogs[0];
  if (run1.length) {
    console.log('');
    console.log('DAY-BY-DAY (run 1):');
    console.log('─'.repeat(65));
    const days = {};
    run1.forEach(t => {
      if (!days[t.day]) days[t.day] = { n:0, dollar:0, cap:0 };
      days[t.day].n++;
      days[t.day].dollar += t.dollar_pnl;
      days[t.day].cap     = t.capital;
    });
    console.log('  Date        Trades  $P&L         EndCap      Result');
    for (const [day, d] of Object.entries(days).sort()) {
      const tag  = d.dollar >= 0 ? '✓ GREEN' : '✗ RED  ';
      const sign = d.dollar >= 0 ? '+' : '';
      console.log(`  ${day}  ${String(d.n).padStart(6)}  ${(sign+'$'+d.dollar.toFixed(2)).padStart(11)}  $${d.cap.toFixed(2).padStart(9)}  ${tag}`);
    }
    const start = CAPITAL, end = run1[run1.length-1]?.capital ?? CAPITAL;
    console.log(`\n  Start: $${start}  →  End: $${end.toFixed(2)}  |  Total P&L: $${(end-start).toFixed(2)} (${((end-start)/start*100).toFixed(1)}% on capital)`);
  }

  // ── Per-symbol ────────────────────────────────────────────
  console.log('');
  console.log('PER-SYMBOL (all runs combined):');
  console.log('─'.repeat(65));
  const syms = [...new Set(all.map(t=>t.sym))].sort();
  for (const sym of syms) {
    const t = all.filter(x=>x.sym===sym);
    const s = stats(t);
    if (!s) continue;
    const mark = parseFloat(s.wr)>=50?'✓':'✗';
    console.log(`  ${sym.padEnd(10)} ${mark}  trades=${String(s.n).padStart(3)}  WR=${s.wr.padStart(5)}%  net=${parseFloat(s.net)>=0?'+':''}${s.net}%  PF=${s.pf}`);
  }
  console.log('');
}

main();
