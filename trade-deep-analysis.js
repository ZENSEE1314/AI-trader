// Deep per-trade analyzer — reconstructs the multi-timeframe SMC context AT the
// time of a trade and judges whether entry/exit followed structure. Reuses the
// bot's OWN engines (smc-engine) so the read matches what the bot "sees":
//   - EMA trend      → classifyTrend (4H, EMA20/50/200 stack)
//   - structure/bias → analyzeStructure (15m HH/HL/LH/LL)
//   - EQH / EQL      → detectLiquidityPools
//   - timing         → getActiveKillzone (ICT session)
//   - buying power   → last-candle volume vs 20-avg
//
// NEEDS network + node-fetch (production). It fetches klines ending at the trade
// time via Bybit v5 (supports &end=), which the bot's fetchCandles doesn't do.
//
// READ-ONLY: never touches trading logic. Untested against live data from the
// dev sandbox (exchange APIs are blocked there) — validate the first prod run.

const fetch = require('node-fetch');
const smc = require('./smc-engine');

const BYBIT_KLINE = 'https://api.bybit.com/v5/market/kline';
const TF_BYBIT = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Klines ending at `endMs` (oldest-first), matching smc-engine's candle shape.
async function fetchCandlesUpTo(symbol, tf, limit, endMs) {
  try {
    const interval = TF_BYBIT[tf] || tf;
    const url = `${BYBIT_KLINE}?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`
      + (endMs ? `&end=${Math.floor(endMs)}` : '');
    const res = await fetch(url, { timeout: 12_000 });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.result?.list || [];
    if (!raw.length) return null;
    return raw.reverse().map(r => ({
      t: parseInt(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]),
      l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]),
    }));
  } catch { return null; }
}

// HH/HL/LH/LL of the most recent swings from analyzeStructure output.
function lastLabels(struct) {
  const H = struct.lastHighs || [], L = struct.lastLows || [];
  return {
    high: H.length >= 2 ? (H[H.length - 1].price > H[H.length - 2].price ? 'HH' : 'LH') : null,
    low:  L.length >= 2 ? (L[L.length - 1].price > L[L.length - 2].price ? 'HL' : 'LL') : null,
  };
}

function buyingPower(candles) {
  if (!candles || candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const avg20 = mean(candles.slice(-21, -1).map(c => c.v));
  return {
    last_vol: last.v, avg20_vol: avg20 ? Number(avg20.toFixed(2)) : null,
    vol_ratio: avg20 ? Number((last.v / avg20).toFixed(2)) : null,
    candle: last.c >= last.o ? 'bullish' : 'bearish',
  };
}

// Full MTF context at a point in time.
async function contextAt(symbol, atMs) {
  const [c4h, c1h, c15] = await Promise.all([
    fetchCandlesUpTo(symbol, '4h', 200, atMs),
    fetchCandlesUpTo(symbol, '1h', 200, atMs),
    fetchCandlesUpTo(symbol, '15m', 200, atMs),
  ]);
  const ctx = { at: new Date(atMs).toISOString(), trend_4h: null, bias_15m: null,
    hl_lh: null, eqh_eql: [], killzone: null, buying_power: null, price: null };
  try { if (c4h) ctx.trend_4h = smc.classifyTrend(c4h); } catch {}
  try {
    if (c15 && c15.length > 30) {
      const st = smc.analyzeStructure(c15, 10, 3);
      ctx.bias_15m = st.bias;
      ctx.hl_lh = lastLabels(st);
      ctx.eqh_eql = smc.detectLiquidityPools(c15, st.pivots)
        .map(p => ({ label: p.label, level: Number(p.level.toFixed(4)), count: p.count }));
      ctx.price = c15[c15.length - 1].c;
    }
  } catch {}
  try { const kz = smc.getActiveKillzone(atMs); ctx.killzone = kz ? kz.name || `${kz.start}-${kz.end}UTC` : 'none'; } catch {}
  try { ctx.buying_power = buyingPower(c15 || c1h); } catch {}
  return ctx;
}

// Direction vs a trend/bias string.
function alignsUpDown(dir, state) {
  if (!state) return null;
  const d = String(dir).toUpperCase();
  const up = /UP|BULL/i.test(state), down = /DOWN|BEAR/i.test(state);
  if (d === 'LONG'  && up)   return true;
  if (d === 'SHORT' && down) return true;
  if ((d === 'LONG' && down) || (d === 'SHORT' && up)) return false;
  return null; // NEUTRAL / RANGING
}

async function deepAnalyzeTrade(t) {
  const entryMs = +new Date(t.created_at);
  const exitMs  = t.closed_at ? +new Date(t.closed_at) : Date.now();
  const [entry, exit] = await Promise.all([contextAt(t.symbol, entryMs), contextAt(t.symbol, exitMs)]);

  const entryAlignedTrend = alignsUpDown(t.direction, entry.trend_4h);
  const entryAlignedBias  = alignsUpDown(t.direction, entry.bias_15m);
  // Exit is "premature vs structure" if, at exit, the 15m bias was STILL in the
  // trade's favour (structure hadn't reversed) yet the trade was closed.
  const structureStillFavored = alignsUpDown(t.direction, exit.bias_15m);
  const exitPremature = t.status !== 'OPEN' && structureStillFavored === true;

  const notes = [];
  if (entryAlignedTrend === false) notes.push('entry was COUNTER-TREND vs 4H EMA trend');
  if (entryAlignedTrend === true)  notes.push('entry aligned with 4H trend');
  if (entryAlignedBias === false)  notes.push('entry fought 15m structure');
  if (exitPremature)               notes.push('EXIT PREMATURE — 15m structure still favored the trade at close');
  if (entry.buying_power?.vol_ratio >= 1.5) notes.push(`strong entry-candle volume (${entry.buying_power.vol_ratio}× avg)`);

  return {
    id: t.id, symbol: t.symbol, direction: t.direction, status: t.status,
    pnl_usdt: t.pnl_usdt == null ? null : Number(t.pnl_usdt),
    exit_reason: t.exit_reason || null,
    entry_context: entry, exit_context: exit,
    verdict: {
      entry_aligned_trend_4h: entryAlignedTrend,
      entry_aligned_bias_15m: entryAlignedBias,
      exit_premature_vs_structure: exitPremature,
    },
    notes,
  };
}

// Analyze a set of trades (already fetched by trade-forensics). Capped — each
// trade costs ~6 kline fetches. `concurrency` keeps Bybit happy.
async function deepAnalyzeTrades(trades, { limit = 8, concurrency = 3 } = {}) {
  const pick = trades.slice(0, Math.max(1, Math.min(20, limit)));
  const out = [];
  for (let i = 0; i < pick.length; i += concurrency) {
    const batch = pick.slice(i, i + concurrency);
    out.push(...await Promise.all(batch.map(t => deepAnalyzeTrade(t).catch(e => ({
      id: t.id, symbol: t.symbol, error: e.message,
    })))));
  }
  return out;
}

module.exports = { deepAnalyzeTrade, deepAnalyzeTrades, contextAt, fetchCandlesUpTo };
