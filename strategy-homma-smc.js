'use strict';

// ═══════════════════════════════════════════════════════════════
//  strategy-homma-smc.js — Homma Candlestick + VWAP Scanner
//
//  Entry: VWAP extreme zone + bullish/bearish Homma pattern
//  (engulfing, hammer, shooting star, morning/evening star,
//   3 soldiers / 3 crows, etc.) with volume confirmation.
//  Exit: handled by cycle.js via shouldExitRev (5m pivot reversal).
//
//  Symbols: BNBUSDT, SOLUSDT.
//  Leverage: 100x  |  SL: 0.20% price  = 20% capital risk.
// ═══════════════════════════════════════════════════════════════

const { fetchBitgetKlines } = require('./bitget-fetcher');
const { getHommaSignal } = require('./homma-patterns');

const ACTIVE_SYMBOLS  = ['BNBUSDT', 'SOLUSDT'];
const SYMBOL_LEVERAGE = { BNBUSDT: 100, SOLUSDT: 100 };
const SYMBOL_SL_PCT   = { BNBUSDT: 0.0020, SOLUSDT: 0.0020 };

const VWAP_BAND_MULT = 1.0;
const LBL_5M  = 5,  LBR_5M  = 1;
const LBL_15M = 10, LBR_15M = 1;
const LBL_4H  = 5,  LBR_4H  = 5;
const MIN_DIST_SIGMA = 0.75;
const VOLUME_SPIKE_MIN = 1.0;
const WARMUP_5M  = 50;
const WARMUP_15M = 50;
const WARMUP_4H  = 100;
const DELTA_5M   = 10;
const DELTA_15M  = 5;
const DELTA_4H   = 3;

function getMaxChasePct(s) {
  return s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.15 : 0.25;
}
function getMaxShortDropPct(s) {
  return s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.20 : 0.30;
}

function getWeekStartMs(asOfMs) {
  const d = new Date(asOfMs);
  const diff = ((d.getUTCDay() * 24 + d.getUTCHours()) * 60 + d.getUTCMinutes()) * 60 * 1000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
  return asOfMs - diff;
}

function calcWeeklyVwap(candles15m, asOfMs) {
  const weekStart = getWeekStartMs(asOfMs);
  const bars = candles15m.filter(c => c.openTime >= weekStart && c.openTime < asOfMs);
  if (bars.length < 2) return null;
  let t = 0, t2 = 0, v = 0;
  for (const c of bars) {
    const tp = (c.high + c.low + c.close) / 3;
    t += tp * c.volume;
    t2 += tp * tp * c.volume;
    v += c.volume;
  }
  if (v === 0) return null;
  const vw = t / v;
  const stddev = Math.sqrt(Math.max(0, t2 / v - vw * vw));
  return { vwap: vw, upper: vw + VWAP_BAND_MULT * stddev, lower: vw - VWAP_BAND_MULT * stddev, stddev };
}

function getZone(p, { vwap, upper, lower }) {
  if (p > upper) return 'ABOVE_UPPER';
  if (p > vwap)  return 'UPPER_MID';
  if (p >= lower) return 'LOWER_MID';
  return 'BELOW_LOWER';
}

function checkPivot(candles, lbL, lbR) {
  const len = candles.length;
  if (len < lbL + lbR + 1) return null;
  const i = len - 1 - lbR;
  if (i < lbL) return null;
  const bar = candles[i];
  let isHigh = true, isLow = true;
  for (let k = -lbL; k <= lbR; k++) {
    if (k === 0) continue;
    if (bar.high <= candles[i + k].high) isHigh = false;
    if (bar.low  >= candles[i + k].low)  isLow  = false;
  }
  if (isHigh && isLow) {
    const hd = bar.high - Math.max(candles[i - 1].high, candles[i + 1].high);
    const ld = Math.min(candles[i - 1].low, candles[i + 1].low) - bar.low;
    if (hd > ld) isLow = false; else isHigh = false;
  }
  if (isHigh) return { isHigh: true, isLow: false, bar };
  if (isLow)  return { isHigh: false, isLow: true,  bar };
  return null;
}

function findLastPivot(pivots, type) {
  for (let i = pivots.length - 1; i >= 0; i--) if (pivots[i].type === type) return pivots[i];
  return null;
}

function isSidewaysMarket(state) {
  const p = state.pivots15m;
  if (p.length < 4) return false;
  for (const x of p.slice(-4)) if (x.label === 'HH' || x.label === 'LL') return false;
  return true;
}

function get4hStructure(state, cp) {
  const p = state.pivots4h;
  if (p.length < 4) return 'UNKNOWN';
  const h = findLastPivot(p, 'H');
  const l = findLastPivot(p, 'L');
  if (!h || !l) return 'UNKNOWN';
  const bl = cp !== undefined && cp < l.price;
  const bh = cp !== undefined && cp > h.price;
  if (h.label === 'LH' && (l.label === 'LL' || bl)) return 'BEARISH';
  if (h.label === 'HH' && (l.label === 'HL' || bh)) return 'BULLISH';
  return 'MIXED';
}

function getMacroStructure(state, cp, sideways) {
  const p = sideways ? state.pivots3m : state.pivots15m;
  if (p.length < 4) return 'UNKNOWN';
  const h = findLastPivot(p, 'H');
  const l = findLastPivot(p, 'L');
  if (!h || !l) return 'UNKNOWN';
  const bl = cp !== undefined && cp < l.price;
  const bh = cp !== undefined && cp > h.price;
  if (h.label === 'LH' && (l.label === 'LL' || bl)) return 'BEARISH';
  if (h.label === 'HH' && (l.label === 'HL' || bh)) return 'BULLISH';
  return 'MIXED';
}

function update15m(st) {
  const p = checkPivot(st.candles15m, LBL_15M, LBR_15M);
  if (!p || p.bar.openTime === st.last15mPivotTime) return;
  st.last15mPivotTime = p.bar.openTime;
  if (p.isHigh) {
    const last = findLastPivot(st.pivots15m, 'H');
    const label = (!last || p.bar.high > last.price) ? 'HH' : 'LH';
    st.sh15_2 = st.sh15_1; st.sh15_1 = p.bar.high;
    st.pivots15m.push({ type: 'H', price: p.bar.high, time: p.bar.openTime, label });
    st.last15mPivotType = label; st.last15mPivotPrice = p.bar.high;
  }
  if (p.isLow) {
    const last = findLastPivot(st.pivots15m, 'L');
    const label = (!last || p.bar.low > last.price) ? 'HL' : 'LL';
    st.sl15_2 = st.sl15_1; st.sl15_1 = p.bar.low;
    st.pivots15m.push({ type: 'L', price: p.bar.low, time: p.bar.openTime, label });
    st.last15mPivotType = label; st.last15mPivotPrice = p.bar.low;
  }
  if (st.pivots15m.length > 50) st.pivots15m = st.pivots15m.slice(-50);
}

function update4h(st) {
  const p = checkPivot(st.candles4h, LBL_4H, LBR_4H);
  if (!p || p.bar.openTime === st.last4hPivotTime) return;
  st.last4hPivotTime = p.bar.openTime;
  if (p.isHigh) {
    const last = findLastPivot(st.pivots4h, 'H');
    const label = (!last || p.bar.high > last.price) ? 'HH' : 'LH';
    st.sh4h_2 = st.sh4h_1; st.sh4h_1 = p.bar.high;
    st.pivots4h.push({ type: 'H', price: p.bar.high, time: p.bar.openTime, label });
    st.last4hPivotType = label; st.last4hPivotPrice = p.bar.high;
  }
  if (p.isLow) {
    const last = findLastPivot(st.pivots4h, 'L');
    const label = (!last || p.bar.low > last.price) ? 'HL' : 'LL';
    st.sl4h_2 = st.sl4h_1; st.sl4h_1 = p.bar.low;
    st.pivots4h.push({ type: 'L', price: p.bar.low, time: p.bar.openTime, label });
    st.last4hPivotType = label; st.last4hPivotPrice = p.bar.low;
  }
  if (st.pivots4h.length > 50) st.pivots4h = st.pivots4h.slice(-50);
}

function update5m(st) {
  const p = checkPivot(st.candles5m, LBL_5M, LBR_5M);
  if (!p || p.bar.openTime === st.last5mPivotTime) return 0;
  st.last5mPivotTime = p.bar.openTime;
  let ptH = null, ptL = null;
  if (p.isHigh) {
    ptH = (st.sh5m_1 === null || p.bar.high > st.sh5m_1) ? 'HH' : 'LH';
    st.sh5m_2 = st.sh5m_1; st.sh5m_1 = p.bar.high;
    st.last5mPivotType = ptH; st.last5mPivotPrice = p.bar.high;
  }
  if (p.isLow) {
    ptL = (st.sl5m_1 === null || p.bar.low > st.sl5m_1) ? 'HL' : 'LL';
    st.sl5m_2 = st.sl5m_1; st.sl5m_1 = p.bar.low;
    st.last5mPivotType = ptL; st.last5mPivotPrice = p.bar.low;
  }
  return { time: p.bar.openTime, ptH, ptL };
}

function isChasing(price, sl5m_1, symbol) {
  if (sl5m_1 === null) return false;
  return ((price - sl5m_1) / sl5m_1 * 100) > getMaxChasePct(symbol);
}
function isShortTooLate(price, sh15_1, symbol) {
  if (sh15_1 === null) return false;
  return ((sh15_1 - price) / sh15_1 * 100) > getMaxShortDropPct(symbol);
}
function isShort5mTooLate(price, sh5m_1, symbol) {
  if (sh5m_1 === null) return false;
  return ((sh5m_1 - price) / sh5m_1 * 100) > getMaxShortDropPct(symbol);
}
function checkVolumeSpike(candles, minRatio = VOLUME_SPIKE_MIN) {
  if (!candles || candles.length < 21) return true;
  const cur = candles[candles.length - 1];
  const prev = candles.slice(-21, -1);
  if (!prev.length) return true;
  const avg = prev.reduce((s, c) => s + (c.volume || 0), 0) / prev.length;
  if (avg <= 0) return true;
  return (cur.volume || 0) / avg >= minRatio;
}

function resolveSignal(st, zone, price, vwap) {
  const homma = getHommaSignal(st.candles5m);
  const p5m = st.last5mPivotType;
  const sideways = isSidewaysMarket(st);

  // Guard: ignore low-confidence Homma reads
  if (homma.score < 2) return null;

  // LONG at discount zones when Homma is bullish
  if ((zone === 'LOWER_MID' || zone === 'BELOW_LOWER') && homma.bias === 'BULLISH') {
    if (!isChasing(price, st.sl5m_1, st.symbol)) {
      if (vwap && vwap.stddev > 0) {
        if ((price - vwap.upper) / vwap.stddev > MIN_DIST_SIGMA * 2) return null;
      }
      return { direction: 'LONG', type: `Homma:${homma.patterns.join('+')}`, regime: sideways ? 'SIDEWAYS' : 'TRENDING' };
    }
  }

  // SHORT at premium zones when Homma is bearish
  if ((zone === 'UPPER_MID' || zone === 'ABOVE_UPPER') && homma.bias === 'BEARISH') {
    if (!isShort5mTooLate(price, st.sh5m_1, st.symbol)) {
      if (vwap && vwap.stddev > 0) {
        if ((vwap.lower - price) / vwap.stddev > MIN_DIST_SIGMA * 2) return null;
      }
      return { direction: 'SHORT', type: `Homma:${homma.patterns.join('+')}`, regime: sideways ? 'SIDEWAYS' : 'TRENDING' };
    }
  }

  return null;
}

// ── State ──────────────────────────────────────────────────────
const _state = {};
function getState(symbol) {
  if (!_state[symbol]) {
    _state[symbol] = {
      symbol,
      candles5m: [], candles15m: [], candles4h: [],
      pivots15m: [], pivots4h: [], pivots3m: [],
      sh15_1: null, sh15_2: null, sl15_1: null, sl15_2: null,
      sh4h_1: null, sh4h_2: null, sl4h_1: null, sl4h_2: null,
      sh5m_1: null, sh5m_2: null, sl5m_1: null, sl5m_2: null,
      last15mPivotType: null, last15mPivotPrice: null, last15mPivotTime: 0,
      last4hPivotType: null, last4hPivotPrice: null, last4hPivotTime: 0,
      last5mPivotType: null, last5mPivotPrice: null, last5mPivotTime: 0,
      lastSignalTime: 0,
      prevZone: null, prevZoneExact: null, zoneTraded: false,
      pendingSignal: null,
      ready: false,
    };
  }
  return _state[symbol];
}

// ── Incremental fetch ──────────────────────────────────────────
async function fetchAndUpdate(symbol, log) {
  const st = getState(symbol);

  if (!st.ready) {
    log(`[Homma] ${symbol} warming up…`);
    const [c5m, c15m, c4h] = await Promise.all([
      fetchBitgetKlines(symbol, '5m',  WARMUP_5M),
      fetchBitgetKlines(symbol, '15m', WARMUP_15M),
      fetchBitgetKlines(symbol, '4h',  WARMUP_4H),
    ]);

    st.candles15m = c15m.slice(0, -1).map(r => ({ openTime: Number(r[0]), open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5]) }));
    st.candles5m  = c5m.slice(0, -1).map(r => ({ openTime: Number(r[0]), open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5]) }));
    st.candles4h  = c4h.slice(0, -1).map(r => ({ openTime: Number(r[0]), open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5]) }));

    for (let i = LBL_15M; i < st.candles15m.length - LBR_15M; i++) update15m(st);
    for (let i = LBL_4H;  i < st.candles4h.length  - LBR_4H;  i++) update4h(st);
    for (let i = LBL_5M;   i < st.candles5m.length   - LBR_5M;   i++) update5m(st);

    st.ready = true;
    log(`[Homma] ${symbol} ready | 15m=${st.last15mPivotType||'none'} 5m=${st.last5mPivotType||'none'} 4H=${get4hStructure(st, null)}`);
    return;
  }

  const [fresh5m, fresh15m, fresh4h] = await Promise.all([
    fetchBitgetKlines(symbol, '5m',  DELTA_5M),
    fetchBitgetKlines(symbol, '15m', DELTA_15M),
    fetchBitgetKlines(symbol, '4h',  DELTA_4H),
  ]);

  function mergeFresh(existing, fresh, tfMs) {
    const lastTime = existing.length ? existing[existing.length - 1].openTime : 0;
    const nowMs = Date.now();
    for (const row of fresh) {
      const c = { openTime: Number(row[0]), open: parseFloat(row[1]), high: parseFloat(row[2]), low: parseFloat(row[3]), close: parseFloat(row[4]), volume: parseFloat(row[5]) };
      if (c.openTime <= lastTime) continue;
      if (c.openTime + tfMs > nowMs) continue;
      existing.push(c);
    }
    while (existing.length > 200) existing.shift();
  }

  mergeFresh(st.candles5m,  fresh5m,  5 * 60 * 1000);
  mergeFresh(st.candles15m, fresh15m, 15 * 60 * 1000);
  mergeFresh(st.candles4h,  fresh4h, 4 * 60 * 60 * 1000);
}

// ── Single-symbol analysis ─────────────────────────────────────
async function analyzeHomma(symbol, log = console.log) {
  const st = getState(symbol);
  await fetchAndUpdate(symbol, log);
  if (!st.ready || st.candles5m.length < LBL_5M + LBR_5M + 2) return null;

  const lastIdx = st.candles5m.length - 1;
  const bar = st.candles5m[lastIdx];

  // ── Step 1: resolve any pending deferred entry ─────────────
  let signal = null;
  if (st.pendingSignal) {
    const entryPrice = bar.open;
    const vwapNext = calcWeeklyVwap(st.candles15m, bar.openTime);
    if (vwapNext) {
      const zoneNext = getZone(entryPrice, vwapNext);
      const resolved = resolveSignal(st, zoneNext, entryPrice, vwapNext);
      const frozenRef = st.pendingSignal.direction === 'SHORT' ? st.pendingSignal.sh5m_1 : st.pendingSignal.sl5m_1;
      const frozenOk = st.pendingSignal.direction === 'SHORT'
        ? !isShort5mTooLate(entryPrice, frozenRef, symbol)
        : !isChasing(entryPrice, frozenRef, symbol);
      if (resolved && resolved.direction === st.pendingSignal.direction && frozenOk) {
        signal = { ...st.pendingSignal, price: entryPrice, zone: zoneNext };
        log(`[Homma] ✓ ${symbol} ${signal.direction} entry=$${entryPrice.toFixed(4)} zone=${zoneNext} type=${signal.type}`);
      } else {
        log(`[Homma] pending ${symbol} ${st.pendingSignal.direction} CANCELLED`);
      }
    }
    st.pendingSignal = null;
  }

  // ── Step 2: check for new 5m pivot ─────────────────────────
  const pivotResult = update5m(st);

  if (pivotResult && pivotResult.time !== st.lastSignalTime) {
    const vwap = calcWeeklyVwap(st.candles15m, bar.openTime);
    if (vwap) {
      const zone = getZone(bar.close, vwap);
      const zoneGroup = (zone === 'ABOVE_UPPER' || zone === 'UPPER_MID') ? 'PREMIUM' : 'DISCOUNT';
      if (zoneGroup !== st.prevZone) {
        st.prevZone = zoneGroup; st.prevZoneExact = zone; st.zoneTraded = false;
      } else if (zone !== st.prevZoneExact) {
        const escalated = (zone === 'ABOVE_UPPER' && st.prevZoneExact === 'UPPER_MID') || (zone === 'BELOW_LOWER' && st.prevZoneExact === 'LOWER_MID');
        if (escalated) st.zoneTraded = false;
        st.prevZoneExact = zone;
      }
      const sig = resolveSignal(st, zone, bar.close, vwap);
      if (sig && !st.zoneTraded) {
        st.lastSignalTime = pivotResult.time;
        st.zoneTraded = true;
        st.pendingSignal = { ...sig, zone, sl5m_1: st.sl5m_1, sh5m_1: st.sh5m_1 };
        log(`[Homma] pivot → pending ${symbol} ${sig.direction} zone=${zone} type=${sig.type} — next candle open`);
      }
    }
  }

  if (!signal) return null;

  const leverage = SYMBOL_LEVERAGE[symbol] ?? 100;
  const slPct    = SYMBOL_SL_PCT[symbol] ?? 0.0020;
  const riskPct  = slPct * leverage;
  const sl = signal.direction === 'SHORT'
    ? signal.price * (1 + slPct)
    : signal.price * (1 - slPct);
  const tp = signal.direction === 'SHORT'
    ? signal.price * (1 - slPct * 2)
    : signal.price * (1 + slPct * 2);

  return {
    symbol,
    direction:  signal.direction,
    side:       signal.direction,
    signal:     signal.direction === 'SHORT' ? 'SELL' : 'BUY',
    lastPrice:  signal.price,
    entry:      signal.price,
    sl,
    tp,
    slPct:      (slPct * 100).toFixed(3),
    tpPct:      (slPct * 200).toFixed(3),
    riskPct:    (riskPct * 100).toFixed(1),
    leverage,
    setupName:  signal.type,
    score:      5,
    zone:       signal.zone,
    signalType: signal.type,
    timeframe:  '4H+15m+5m',
    version:    'homma',
    exitMode:   'REV',
    tp1: tp, tp2: null, tp3: null,
  };
}

// ── Multi-symbol scan ──────────────────────────────────────────
async function scanHommaSMC(log = console.log) {
  const results = [];
  for (const sym of ACTIVE_SYMBOLS) {
    try {
      const sig = await analyzeHomma(sym, log);
      if (sig) results.push(sig);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      log(`[Homma] ${sym} error: ${e.message}`);
    }
  }
  log(`[Homma] scan done — ${results.length} signal(s)`);
  return results;
}

module.exports = {
  scanHommaSMC,
  analyzeHomma,
  ACTIVE_SYMBOLS,
  SYMBOL_LEVERAGE,
  SYMBOL_SL_PCT,
};
