'use strict';
// ============================================================
// WIN-RATE OPTIMIZER — tests 6 filter configs, finds the best
//
// The five most likely causes of losses:
//   1. Counter-VWAP trades (shorting while above mid, longing below mid)
//   2. Single structure confirmation (one HL is noise — need two)
//   3. SL placed by ATR instead of actual structure (gets faked out)
//   4. Stale 1m pivot (confirmed 30 bars ago = 30 min ago, price moved)
//   5. Low-liquidity Asia session (00:00–06:00 UTC = chop)
//
// Config matrix: each config toggles one or more of these fixes.
//
// Run on Railway:
//   node backtest-wr.js ALL 7
//   node backtest-wr.js BTCUSDT 7
// ============================================================

const fetch = require('node-fetch');

const PROXY   = process.env.PROXY_URL || '';
const ARG1    = process.argv[2] || 'ALL';
const DAYS    = parseInt(process.argv[3] || '7', 10);
const SYMBOLS = ARG1 === 'ALL' ? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'] : [ARG1];

// ── Config matrix to test ────────────────────────────────────
// vwapStrict:  above_mid→LONG only, below_mid→SHORT only (not just extremes)
// require2HL:  need 2 consecutive HLs (not just 1) for LONG; 2 LHs for SHORT
// structSL:    SL at the actual HL/LH structure point, not ATR×1.2
// freshPivot:  only count 1m pivots from last N bars (not 30)
// sessionOnly: skip 00:00–06:30 UTC (Asia low-liquidity)
// minStructPct: min % move to count as a genuine HL/LH (filter micro-noise)

const CONFIGS = [
  {
    name: '1_BASELINE',
    desc: 'Current live logic (no extra filters)',
    vwapStrict: false, require2HL: false, structSL: false,
    freshPivot: 30, sessionOnly: false, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '2_VWAP_STRICT',
    desc: 'Trade WITH VWAP direction (above mid=LONG, below mid=SHORT)',
    vwapStrict: true, require2HL: false, structSL: false,
    freshPivot: 30, sessionOnly: false, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '3_SESSION_FILTER',
    desc: 'VWAP strict + skip Asia session',
    vwapStrict: true, require2HL: false, structSL: false,
    freshPivot: 30, sessionOnly: true, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '4_STRUCT_2HL',
    desc: 'VWAP + session + require 2 consecutive HLs/LHs',
    vwapStrict: true, require2HL: true, structSL: false,
    freshPivot: 30, sessionOnly: true, minStructPct: 0,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.2,
  },
  {
    name: '5_STRUCT_SL',
    desc: 'VWAP + session + 2HL + SL at structure point (not ATR)',
    vwapStrict: true, require2HL: true, structSL: true,
    freshPivot: 15, sessionOnly: true, minStructPct: 0.001,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.5,
  },
  {
    name: '6_FULL_STRICT',
    desc: 'All filters + fresh 1m pivot + minimum structure size',
    vwapStrict: true, require2HL: true, structSL: true,
    freshPivot: 10, sessionOnly: true, minStructPct: 0.0015,
    atrSL: 1.2, atrTP: 2.0, minRR: 1.5,
  },
];

const VWAP_MULT = 1.0;
const MAX_HOLD  = 96; // 96 × 15m = 24h timeout

// ── HTTP ─────────────────────────────────────────────────────

function apiBase() {
  return PROXY ? `${PROXY}/fapi/v1` : 'https://fapi.binance.com/fapi/v1';
}

async function fetchJSON(url, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { timeout: 30000 });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status === 418) {
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        continue;
      }
    } catch (e) {
      if (i < retries - 1) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
      throw e;
    }
  }
  return null;
}

async function getKlines(symbol, interval, limit, startTime) {
  let url = `${apiBase()}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  return fetchJSON(url);
}

// ── Candle ───────────────────────────────────────────────────

function pc(k) {
  return {
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5], openTime: +k[0], closeTime: +k[6],
  };
}

function atr(candles, n = 14) {
  if (candles.length < n + 1) return candles.length > 1
    ? Math.abs(candles.at(-1).close - candles.at(-2).close) * 1.5 : 0;
  let s = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const p = candles[i-1], c = candles[i];
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return s / n;
}

function avgVol(candles, n = 20) {
  const sl = candles.slice(-n - 1, -1);
  return sl.length ? sl.reduce((s, c) => s + c.volume, 0) / sl.length : 0;
}

// ── VWAP ─────────────────────────────────────────────────────

function vwap(c1m) {
  if (!c1m || c1m.length < 5) return null;
  let tv = 0, v = 0;
  const tp = c1m.map(c => { const t = (c.high + c.low + c.close) / 3; tv += t * c.volume; v += c.volume; return t; });
  const mid = v > 0 ? tv / v : null;
  if (!mid) return null;
  let vv = 0;
  for (let i = 0; i < c1m.length; i++) vv += c1m[i].volume * (tp[i] - mid) ** 2;
  const sd = Math.sqrt(v > 0 ? vv / v : 0);
  return { mid, upper: mid + VWAP_MULT * sd, lower: mid - VWAP_MULT * sd };
}

function vwapZone(price, v) {
  if (!v) return 'unknown';
  if (price >= v.upper) return 'above_upper';
  if (price <= v.lower) return 'below_lower';
  if (price >= v.mid)   return 'above_mid';
  return 'below_mid';
}

// ── Pivots ───────────────────────────────────────────────────

function findPivots(candles, B = 2) {
  const H = [], L = [];
  for (let i = B; i < candles.length - B; i++) {
    let h = true, l = true;
    for (let j = 1; j <= B; j++) {
      if (candles[i].high <= candles[i-j].high || candles[i].high <= candles[i+j].high) h = false;
      if (candles[i].low  >= candles[i-j].low  || candles[i].low  >= candles[i+j].low)  l = false;
    }
    if (h) H.push({ price: candles[i].high, idx: i });
    if (l) L.push({ price: candles[i].low,  idx: i });
  }
  return { H, L };
}

// ── Signal detection with config ─────────────────────────────

function detectSignal(c15Slice, c1mToday, cfg) {
  // VWAP — no fallback to 15m
  if (!c1mToday || c1mToday.length < 5) return null;
  const v = vwap(c1mToday);
  if (!v) return null;

  const price = c15Slice.at(-1).close;
  const zone  = vwapZone(price, v);
  if (zone === 'unknown') return null;

  // Session filter: skip 00:00–06:30 UTC
  if (cfg.sessionOnly) {
    const h = new Date(c15Slice.at(-1).openTime).getUTCHours();
    const m = new Date(c15Slice.at(-1).openTime).getUTCMinutes();
    const utcMin = h * 60 + m;
    if (utcMin < 390 || utcMin > 1200) return null; // 06:30–20:00 UTC only
  }

  // 15m candles
  const c4 = c15Slice.slice(-5);
  if (c4.length < 4) return null;
  const last  = c4.at(-1);
  const prev  = c4.at(-2);
  const prev2 = c4.at(-3);

  // Direct candle comparison (immediate, no pivot wait)
  const has15mHL = last.low  > prev.low;
  const has15mHH = last.high > prev.high;
  const has15mLH = last.high < prev.high;
  const has15mLL = last.low  < prev.low;
  const lastBull = last.close > last.open;
  const lastBear = last.close < last.open;

  // Minimum structure quality (filter micro-noise)
  const structQualLong  = (last.low - prev.low)   / prev.low  >= cfg.minStructPct;
  const structQualShort = (prev.high - last.high)  / prev.high >= cfg.minStructPct;

  // 2-HL confirmation (need previous bar to also confirm direction)
  const prev15mHL = prev.low  > prev2.low;
  const prev15mLH = prev.high < prev2.high;

  // 1m pivots
  const P = cfg.freshPivot;
  const scan1m = c1mToday.slice(-P);
  const pv = findPivots(scan1m, 2);

  // Must be "fresh" — last pivot index >= scan1m.length - freshPivot/2
  const freshThresh = Math.floor(scan1m.length * 0.5);
  const freshH = pv.H.length && pv.H.at(-1).idx >= freshThresh;
  const freshL = pv.L.length && pv.L.at(-1).idx >= freshThresh;

  const has1mHH = pv.H.length >= 2 && pv.H.at(-1).price > pv.H.at(-2).price;
  const has1mHL = pv.L.length >= 2 && pv.L.at(-1).price > pv.L.at(-2).price;
  const has1mLL = pv.L.length >= 2 && pv.L.at(-1).price < pv.L.at(-2).price;
  const has1mLH = pv.H.length >= 2 && pv.H.at(-1).price < pv.H.at(-2).price;

  const atrVal = atr(c15Slice);

  // ── Try LONG ────────────────────────────────────────────────
  // Block LONG below VWAP lower (hard rule)
  // Block LONG below mid if vwapStrict
  const longVwapOk = zone !== 'below_lower' &&
    (!cfg.vwapStrict || zone === 'above_mid' || zone === 'above_upper');

  if (longVwapOk) {
    const longStruct15 = (has15mHL && structQualLong) || has15mHH || (has15mLL && lastBull);
    const longConsec   = !cfg.require2HL || (has15mHL && prev15mHL) || has15mHH;
    const long1m       = (has1mHH || has1mHL) && (!cfg.freshPivot || freshL || freshH);

    if (longStruct15 && longConsec && long1m) {
      // SL: either at structure (HL low) or ATR-based
      let sl;
      if (cfg.structSL && pv.L.length) {
        // SL below the most recent 15m swing low area
        const swingLow = Math.min(last.low, prev.low);
        sl = swingLow * (1 - 0.0005); // 0.05% below swing low
      } else {
        sl = price - atrVal * cfg.atrSL;
      }
      const slDist = (price - sl) / price;
      const tp = price + Math.max(atrVal * cfg.atrTP, slDist * price * cfg.minRR);
      const rr = slDist > 0 ? (tp - price) / (price - sl) : 0;
      if (rr >= cfg.minRR && slDist > 0.001 && slDist < 0.05) {
        const why = has15mHL ? '15HL' : has15mHH ? '15HH' : '15LL+bull';
        return { direction: 'LONG', price, sl, tp, slDist, rr, why, zone };
      }
    }
  }

  // ── Try SHORT ───────────────────────────────────────────────
  const shortVwapOk = zone !== 'above_upper' &&
    (!cfg.vwapStrict || zone === 'below_mid' || zone === 'below_lower');

  if (shortVwapOk) {
    const shortStruct15 = (has15mLH && structQualShort) || has15mLL || (has15mHH && lastBear);
    const shortConsec   = !cfg.require2HL || (has15mLH && prev15mLH) || has15mLL;
    const short1m       = (has1mLL || has1mLH) && (!cfg.freshPivot || freshH || freshL);

    if (shortStruct15 && shortConsec && short1m) {
      let sl;
      if (cfg.structSL && pv.H.length) {
        const swingHigh = Math.max(last.high, prev.high);
        sl = swingHigh * (1 + 0.0005);
      } else {
        sl = price + atrVal * cfg.atrSL;
      }
      const slDist = (sl - price) / price;
      const tp = price - Math.max(atrVal * cfg.atrTP, slDist * price * cfg.minRR);
      const rr = slDist > 0 ? (price - tp) / (sl - price) : 0;
      if (rr >= cfg.minRR && slDist > 0.001 && slDist < 0.05) {
        const why = has15mLH ? '15LH' : has15mLL ? '15LL' : '15HH+bear';
        return { direction: 'SHORT', price, sl, tp, slDist, rr, why, zone };
      }
    }
  }

  return null;
}

// ── Trade outcome: walk 1m bars forward ──────────────────────

function simulate(sig, futureC1m) {
  for (const bar of futureC1m) {
    if (sig.direction === 'LONG') {
      if (bar.low  <= sig.sl) return 'LOSS';
      if (bar.high >= sig.tp) return 'WIN';
    } else {
      if (bar.high >= sig.sl) return 'LOSS';
      if (bar.low  <= sig.tp) return 'WIN';
    }
  }
  return 'TIMEOUT';
}

// ── Fetch 1m candles paginated ────────────────────────────────

async function fetchAll1m(symbol, fromMs, toMs) {
  const all = [];
  let start = fromMs;
  let pages = 0;
  while (start < toMs && pages < 20) {
    const raw = await getKlines(symbol, '1m', 1000, start);
    if (!raw || !raw.length) break;
    const parsed = raw.map(pc);
    all.push(...parsed);
    const last = parsed.at(-1);
    if (last.closeTime >= toMs) break;
    start = last.openTime + 60000;
    pages++;
    await new Promise(r => setTimeout(r, 180));
  }
  return all.filter(c => c.openTime >= fromMs && c.closeTime <= toMs);
}

// ── Run one symbol against one config ────────────────────────

function runConfig(c15all, c1mall, cfg) {
  const trades = [];
  let lastTradeEndMs = 0;

  for (let i = 20; i < c15all.length - 2; i++) {
    const bar = c15all[i];

    // Cooldown: 1 bar after trade closes (15 min)
    if (bar.openTime <= lastTradeEndMs + 15 * 60000) continue;

    const dayStart = new Date(bar.openTime);
    const dayMs = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate());
    const c1mToday = c1mall.filter(c => c.openTime >= dayMs && c.closeTime <= bar.closeTime);

    const sig = detectSignal(c15all.slice(0, i + 1), c1mToday, cfg);
    if (!sig) continue;

    // Simulate outcome using future 1m bars
    const maxFutMs = bar.closeTime + MAX_HOLD * 15 * 60000;
    const futureC1m = c1mall.filter(c => c.openTime > bar.closeTime && c.closeTime <= maxFutMs);
    if (futureC1m.length < 5) continue;

    const outcome = simulate(sig, futureC1m);
    const pnlR = outcome === 'WIN' ? sig.rr : outcome === 'LOSS' ? -1.0 : -0.3;

    trades.push({
      time: new Date(bar.openTime).toISOString().slice(0, 16),
      direction: sig.direction, price: sig.price, sl: sig.sl, tp: sig.tp,
      rr: Math.round(sig.rr * 10) / 10, outcome, pnlR,
      why: sig.why, zone: sig.zone,
    });

    // Next entry only after this trade closes
    if (outcome !== 'TIMEOUT') {
      const closingBar = futureC1m.find(c =>
        (sig.direction === 'LONG'  && (c.low <= sig.sl || c.high >= sig.tp)) ||
        (sig.direction === 'SHORT' && (c.high >= sig.sl || c.low <= sig.tp))
      );
      if (closingBar) lastTradeEndMs = closingBar.closeTime;
    } else {
      lastTradeEndMs = maxFutMs;
    }
  }

  return trades;
}

// ── Stats for a trade list ────────────────────────────────────

function stats(trades) {
  if (!trades.length) return { total: 0, wr: 0, avgRR: 0, pf: 0, netR: 0 };
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const wr     = Math.round(wins.length / trades.length * 100);
  const avgRR  = wins.length ? wins.reduce((s, t) => s + t.rr, 0) / wins.length : 0;
  const gw     = wins.reduce((s, t) => s + t.pnlR, 0);
  const gl     = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const pf     = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
  const netR   = trades.reduce((s, t) => s + t.pnlR, 0);
  return { total: trades.length, wins: wins.length, losses: losses.length, wr, avgRR, pf, netR };
}

// ── Backtest one symbol ───────────────────────────────────────

async function backtestSymbol(symbol) {
  const nowMs  = Date.now();
  const fromMs = nowMs - DAYS * 86400000;

  process.stdout.write(`  [${symbol}] Fetching 15m… `);
  const n15  = Math.min(DAYS * 96 + 20, 999);
  const raw15 = await getKlines(symbol, '15m', n15);
  if (!raw15 || raw15.length < 30) { console.log('skip (no data)'); return {}; }
  const c15all = raw15.map(pc).filter(c => c.openTime >= fromMs);

  process.stdout.write(`${c15all.length} bars | Fetching 1m (paginated)… `);
  const c1mall = await fetchAll1m(symbol, fromMs, nowMs);
  console.log(`${c1mall.length} bars`);

  if (c1mall.length < 200) { console.log(`  [${symbol}] Not enough 1m data — skip`); return {}; }

  const results = {};
  for (const cfg of CONFIGS) {
    const trades = runConfig(c15all, c1mall, cfg);
    results[cfg.name] = { trades, ...stats(trades) };
  }
  return results;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` WIN-RATE OPTIMIZER  |  ${ARG1}  |  ${DAYS} days`);
  console.log(`${'═'.repeat(70)}\n`);

  // Aggregate results across all symbols
  const aggByConfig = {};
  for (const cfg of CONFIGS) aggByConfig[cfg.name] = [];

  for (const symbol of SYMBOLS) {
    console.log(`\n── ${symbol} ──────────────────────`);
    try {
      const res = await backtestSymbol(symbol);
      for (const [name, data] of Object.entries(res)) {
        aggByConfig[name].push(...(data.trades || []));
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }

  // ── Summary table ─────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(` RESULTS SUMMARY  (all symbols combined)`);
  console.log('═'.repeat(70));
  console.log(` ${'Config'.padEnd(20)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(6)} ${'AvgRR'.padEnd(7)} ${'PF'.padEnd(6)} ${'NetR'.padEnd(8)}`);
  console.log('─'.repeat(70));

  let bestCfg = null, bestScore = -99;
  for (const cfg of CONFIGS) {
    const trades = aggByConfig[cfg.name];
    const s = stats(trades);
    const score = s.wr * 0.5 + s.pf * 20 + s.netR;  // composite score
    if (score > bestScore && s.total >= 5) { bestScore = score; bestCfg = cfg; }

    const flag = s.wr >= 80 ? ' ✅' : s.wr >= 65 ? ' 🔶' : ' ❌';
    console.log(
      ` ${cfg.name.padEnd(20)} ${String(s.total).padEnd(8)} ${String(s.wr+'%').padEnd(6)} ` +
      `${(s.avgRR).toFixed(2).padEnd(7)} ${(s.pf).toFixed(2).padEnd(6)} ${(s.netR).toFixed(1).padEnd(8)}${flag}`
    );
  }
  console.log('═'.repeat(70));

  if (bestCfg) {
    console.log(`\n ★ BEST CONFIG: ${bestCfg.name}`);
    console.log(`   ${bestCfg.desc}`);
  }

  // ── Detailed trades for the BEST config ───────────────────
  if (bestCfg) {
    const bestTrades = aggByConfig[bestCfg.name];
    const s = stats(bestTrades);
    console.log(`\n── Detailed trades (${bestCfg.name}) ─────────────────────────────`);
    for (const t of bestTrades) {
      const icon = t.outcome === 'WIN' ? '✅' : t.outcome === 'LOSS' ? '❌' : '⏱️';
      console.log(
        `  ${icon} ${t.time}  ${t.direction.padEnd(5)} @${t.price.toFixed(2).padEnd(10)} ` +
        `RR=${t.rr}x  ${t.outcome.padEnd(7)} why=${t.why} zone=${t.zone}`
      );
    }

    // Per-day WR
    console.log(`\n── Per-day breakdown (${bestCfg.name}) ─────────────`);
    const byDay = {};
    for (const t of bestTrades) {
      const d = t.time.slice(0, 10);
      if (!byDay[d]) byDay[d] = { w: 0, l: 0, r: 0 };
      if (t.outcome === 'WIN')  byDay[d].w++;
      if (t.outcome === 'LOSS') byDay[d].l++;
      byDay[d].r += t.pnlR;
    }
    for (const [day, d] of Object.entries(byDay)) {
      const wr = d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : '-';
      console.log(`  ${day}  ${d.w}W/${d.l}L  WR=${wr}%  R=${d.r.toFixed(1)}`);
    }

    // Zone breakdown for losses
    console.log(`\n── Loss analysis (${bestCfg.name}) ──────────────────`);
    const lostTrades = bestTrades.filter(t => t.outcome === 'LOSS');
    const zoneL = {}, whyL = {}, dirL = {};
    for (const t of lostTrades) {
      zoneL[t.zone]  = (zoneL[t.zone]  || 0) + 1;
      whyL[t.why]    = (whyL[t.why]    || 0) + 1;
      dirL[t.direction] = (dirL[t.direction] || 0) + 1;
    }
    console.log(`  By VWAP zone: ${Object.entries(zoneL).map(([k,v]) => `${k}=${v}`).join(' | ')}`);
    console.log(`  By structure: ${Object.entries(whyL).map(([k,v]) => `${k}=${v}`).join(' | ')}`);
    console.log(`  By direction: ${Object.entries(dirL).map(([k,v]) => `${k}=${v}`).join(' | ')}`);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(` BEST WR: ${s.wr}%  Profit Factor: ${s.pf.toFixed(2)}  Net R: ${s.netR.toFixed(1)}  Trades: ${s.total}`);
    console.log('═'.repeat(70));
  }

  // ── Recommendation ────────────────────────────────────────
  console.log(`\n RECOMMENDED LIVE CHANGES:`);
  console.log(` Run "node apply-best-config.js ${bestCfg?.name || 'MANUAL'}" to update the engine`);
  console.log(` Or share these results and I will apply the winning config.\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
