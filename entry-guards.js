// Entry guards — block the two entry patterns that bled the 30-day book:
//   1. counter-trend entries (LONG in a 4H downtrend / SHORT in a 4H uptrend)
//   2. entries INTO resting liquidity (LONG just below an EQH resistance, SHORT
//      just above an EQL support) — price sweeps that liquidity and reverses.
// Reuses the bot's own smc-engine so the read matches the rest of the system.
//
// SAFETY: OFF by default (ENTRY_GUARDS_ENABLED != '1'). When disabled the guard
// is never even called by cycle.js. On any internal error it FAILS OPEN
// (allow:true) so a guard bug can never block a legitimate trade. Backtest
// before enabling on a live book.
//
// Env:
//   ENTRY_GUARDS_ENABLED=1        master switch (default off)
//   ENTRY_GUARD_TREND=0           disable just the trend rule
//   ENTRY_GUARD_LIQUIDITY=0       disable just the liquidity rule
//   ENTRY_GUARD_LIQ_PROX_PCT=0.4  "into liquidity" proximity band, percent

const smc = require('./smc-engine');

const enabled  = () => process.env.ENTRY_GUARDS_ENABLED === '1';
const trendOn  = () => process.env.ENTRY_GUARD_TREND !== '0';
const liqOn    = () => process.env.ENTRY_GUARD_LIQUIDITY !== '0';
const liqProx  = () => (Number(process.env.ENTRY_GUARD_LIQ_PROX_PCT || 0.4) || 0.4) / 100;

// Optional injection of candles (used by tests); otherwise fetched live.
async function evaluateEntry({ symbol, direction, candles4h = null, candles15m = null } = {}) {
  if (!enabled()) return { allow: true, checked: false, reasons: ['guards disabled'] };
  const dir = String(direction || '').toUpperCase();
  if (dir !== 'LONG' && dir !== 'SHORT') return { allow: true, checked: false, reasons: ['unknown direction'] };

  let c4h = candles4h, c15 = candles15m;
  try {
    if (!c4h) c4h = await smc.fetchCandles(symbol, '240', 120);
    if (!c15) c15 = await smc.fetchCandles(symbol, '15', 120);
  } catch (e) {
    return { allow: true, checked: false, reasons: [`kline fetch failed — fail-open: ${e.message}`] };
  }

  const reasons = [];
  const block = r => ({ allow: false, checked: true, reason: r, reasons: [...reasons, r] });

  // ── Rule 1: trend alignment (4H EMA 20/50/200 stack) ──
  if (trendOn() && Array.isArray(c4h) && c4h.length > 60) {
    let trend = 'NEUTRAL';
    try { trend = smc.classifyTrend(c4h); } catch {}
    if (dir === 'LONG'  && trend === 'DOWN') return block('counter-trend LONG into a 4H downtrend');
    if (dir === 'SHORT' && trend === 'UP')   return block('counter-trend SHORT into a 4H uptrend');
    reasons.push(`4H trend ${trend}: ok`);
  }

  // ── Rule 2: don't enter INTO resting liquidity ──
  if (liqOn() && Array.isArray(c15) && c15.length > 40) {
    const price = c15[c15.length - 1].c;
    let pools = [];
    try {
      const st = smc.analyzeStructure(c15, 10, 3);
      pools = smc.detectLiquidityPools(c15, st.pivots) || [];
    } catch {}
    const prox = liqProx();
    for (const p of pools) {
      if (dir === 'LONG' && p.label === 'EQH') {
        const above = (p.level - price) / price;               // EQH sits above price
        if (above > 0 && above <= prox)
          return block(`LONG into EQH resistance @ ${p.level.toFixed(4)} (${(above * 100).toFixed(2)}% above) — wait for the sweep`);
      }
      if (dir === 'SHORT' && p.label === 'EQL') {
        const below = (price - p.level) / price;               // EQL sits below price
        if (below > 0 && below <= prox)
          return block(`SHORT into EQL support @ ${p.level.toFixed(4)} (${(below * 100).toFixed(2)}% below) — wait for the sweep`);
      }
    }
    reasons.push('clear of near-side liquidity');
  }

  return { allow: true, checked: true, reasons };
}

module.exports = { evaluateEntry };
