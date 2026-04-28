// ============================================================
// Backtest — VWAP + Structure Strategy
// Tokens : BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT
// Logic  : Mirrors the live engine exactly:
//            • VWAP band gate  (above upper → LONG only, below lower → SHORT only)
//            • 15m structure   (HL/HH for LONG, LH/LL for SHORT)
//            • 1m confirmation (HH/HL for LONG, LL/LH for SHORT)
//            • ATR SL × 1.2   (price distance)
//            • slDist 0.05%-5%, RR ≥ 1.2
// Leverage: 100×
// Capital : 10% of wallet per trade (max 100%, never over-sized)
// Trail   : +20% capital → breakeven, then +10% steps (cycle.js tiers)
// ============================================================

const fetch = require('node-fetch');
const { getFetchOptions } = require('./proxy-agent');

// ── Config ──────────────────────────────────────────────────
const SYMBOLS       = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
const LEVERAGE      = 100;
const CAPITAL_PCT   = 0.10;  // 10% of wallet per trade
const DAYS          = 14;    // back-test window
const ATR_PERIOD    = 14;
const ATR_SL_MULT   = 1.2;
const RR_MIN        = 1.2;
const SL_DIST_MIN   = 0.0005;
const SL_DIST_MAX   = 0.05;
const VWAP_MULT     = 1.0;   // 1σ bands
const PIVOT_BARS    = 2;     // lookback each side for swing detection
const WALLET_START  = 1000;  // USDT starting balance
const MAX_POSITIONS = 2;     // max concurrent open positions per symbol group

// Trailing tiers (matches cycle.js TRAILING_TIERS, expressed as capital %)
const TRAIL_TIERS = [
  { trigger: 0.20, lock: 0.00 },
  { trigger: 0.30, lock: 0.20 },
  { trigger: 0.40, lock: 0.30 },
  { trigger: 0.50, lock: 0.40 },
  { trigger: 0.60, lock: 0.50 },
  { trigger: 0.70, lock: 0.60 },
  { trigger: 0.80, lock: 0.70 },
  { trigger: 0.90, lock: 0.80 },
  { trigger: 1.00, lock: 0.90 },
  { trigger: 1.10, lock: 1.00 },
  { trigger: 1.20, lock: 1.10 },
  { trigger: 1.50, lock: 1.40 },
  { trigger: 2.00, lock: 1.90 },
  { trigger: 3.00, lock: 2.90 },
];

// ── Helpers ──────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol, interval, limit, endTime) {
  const params = `symbol=${symbol}&interval=${interval}&limit=${limit}` +
    (endTime ? `&endTime=${endTime}` : '');
  const url = `https://fapi.binance.com/fapi/v1/klines?${params}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { timeout: 20000, ...getFetchOptions() });
      if (res.ok) return res.json();
    } catch (err) {
      // Detect ISP DNS block / cert mismatch — must run on server
      if (err.message && (err.message.includes('altnames') || err.message.includes('certificate'))) {
        console.error('\n[ERROR] Binance blocked by local ISP/DNS.');
        console.error('[ERROR] Run this on the server where PROXY_URL is configured:');
        console.error('[ERROR]   node backtest.js');
        process.exit(1);
      }
    }
    await sleep(1000 * (attempt + 1));
  }
  return null;
}

// Fetch all 1m klines for a period (paginated, newest-first via endTime)
async function fetchAllKlines1m(symbol, startMs, endMs) {
  const all = [];
  let cursor = endMs;
  while (cursor > startMs) {
    const chunk = await fetchKlines(symbol, '1m', 1500, cursor);
    if (!chunk || !chunk.length) break;
    // filter to our window
    const filtered = chunk.filter(k => parseInt(k[0]) >= startMs && parseInt(k[0]) < cursor);
    if (!filtered.length) break;
    all.unshift(...filtered);
    cursor = parseInt(chunk[0][0]); // oldest candle open time → go further back
    if (chunk.length < 1500) break; // reached the start
    await sleep(300);
  }
  return all.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
}

function parseCandle(k) {
  return {
    t: parseInt(k[0]),
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  };
}

function calcATR(candles, period = ATR_PERIOD) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const p = candles[i - 1];
    const c = candles[i];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return sum / period;
}

// VWAP + 1σ bands from an array of parsed candles (same-day window)
function calcVWAP(candles) {
  if (!candles.length) return null;
  let cumTV = 0, cumV = 0, cumTV2 = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    cumTV  += tp * c.v;
    cumTV2 += tp * tp * c.v;
    cumV   += c.v;
  }
  if (cumV === 0) return null;
  const vwap  = cumTV / cumV;
  const variance = Math.max(0, cumTV2 / cumV - vwap * vwap);
  const sd    = Math.sqrt(variance);
  return { mid: vwap, upper: vwap + VWAP_MULT * sd, lower: vwap - VWAP_MULT * sd };
}

// Detect pivot highs/lows with PIVOT_BARS lookback each side
function getPivots(candles) {
  const highs = [], lows = [];
  const P = PIVOT_BARS;
  for (let i = P; i < candles.length - P; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= P; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isH = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isL = false;
    }
    if (isH) highs.push(candles[i].h);
    if (isL) lows.push(candles[i].l);
  }
  return { highs, lows };
}

// ── Signal generation (mirrors analyzeCoin logic) ────────────
function generateSignal(c15m, c1m, price) {
  if (c15m.length < 30 || c1m.length < 20) return null;

  // ── VWAP bands ──────────────────────────────────────────────
  const dayStart = new Date(c15m[c15m.length - 1].t);
  const dayStartMs = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate());
  const todayCandles = c15m.filter(c => c.t >= dayStartMs);
  const vwapSrc = todayCandles.length >= 3 ? todayCandles : c15m;
  const vwap = calcVWAP(vwapSrc);
  if (!vwap) return null;

  let bandPos;
  if      (price >= vwap.upper) bandPos = 'above_upper';
  else if (price >= vwap.mid)   bandPos = 'above_mid';
  else if (price <= vwap.lower) bandPos = 'below_lower';
  else                          bandPos = 'below_mid';

  // ── 15m structure ────────────────────────────────────────────
  const { highs: sH15, lows: sL15 } = getPivots(c15m);
  const has15mHL = sL15.length >= 2 && sL15[sL15.length - 1] > sL15[sL15.length - 2];
  const has15mHH = sH15.length >= 2 && sH15[sH15.length - 1] > sH15[sH15.length - 2];
  const has15mLH = sH15.length >= 2 && sH15[sH15.length - 1] < sH15[sH15.length - 2];
  const has15mLL = sL15.length >= 2 && sL15[sL15.length - 1] < sL15[sL15.length - 2];

  // ── 1m structure ─────────────────────────────────────────────
  const { highs: pH1m, lows: pL1m } = getPivots(c1m);
  const has1mHH = pH1m.length >= 2 && pH1m[pH1m.length - 1] > pH1m[pH1m.length - 2];
  const has1mHL = pL1m.length >= 2 && pL1m[pL1m.length - 1] > pL1m[pL1m.length - 2];
  const has1mLL = pL1m.length >= 2 && pL1m[pL1m.length - 1] < pL1m[pL1m.length - 2];
  const has1mLH = pH1m.length >= 2 && pH1m[pH1m.length - 1] < pH1m[pH1m.length - 2];

  const longOk  = (has15mHL || has15mHH) && (has1mHH || has1mHL);
  const shortOk = (has15mLH || has15mLL) && (has1mLL || has1mLH);

  // ── VWAP gate ────────────────────────────────────────────────
  const longBlocked  = bandPos === 'below_lower'; // LONG below lower = sure lose
  const shortBlocked = bandPos === 'above_upper'; // SHORT above upper = sure lose

  const canLong  = longOk  && !longBlocked;
  const canShort = shortOk && !shortBlocked;

  if (!canLong && !canShort) return null;

  // Choose direction (VWAP bias breaks tie)
  let direction;
  if      (canLong  && !canShort) direction = 'LONG';
  else if (canShort && !canLong)  direction = 'SHORT';
  else {
    // Both valid — VWAP mid bias decides
    direction = bandPos === 'above_mid' || bandPos === 'above_upper' ? 'LONG' : 'SHORT';
  }

  // ── ATR SL ──────────────────────────────────────────────────
  const atr = calcATR(c15m);
  if (atr === 0) return null;
  const slPrice = direction === 'LONG' ? price - atr * ATR_SL_MULT : price + atr * ATR_SL_MULT;
  const slDist  = Math.abs(price - slPrice) / price;

  if (slDist < SL_DIST_MIN || slDist > SL_DIST_MAX) return null;

  // ── TP = ATR × 2 (RR check) ─────────────────────────────────
  const tpDist = atr * 2.0 / price;
  const rr     = tpDist / slDist;
  if (rr < RR_MIN) return null;

  const tp = direction === 'LONG' ? price + atr * 2.0 : price - atr * 2.0;

  return { direction, entry: price, sl: slPrice, tp, slDist, rr, bandPos };
}

// ── Position management ───────────────────────────────────────
function updateTrail(pos, currentPrice) {
  const capitalGain = pos.direction === 'LONG'
    ? (currentPrice - pos.entry) / pos.entry * LEVERAGE
    : (pos.entry - currentPrice) / pos.entry * LEVERAGE;

  // Find highest tier triggered
  let activeLock = null;
  for (const tier of TRAIL_TIERS) {
    if (capitalGain >= tier.trigger) activeLock = tier.lock;
    else break;
  }
  if (activeLock === null) return; // not in profit yet

  // Convert capital% lock to price SL
  const lockPricePct = activeLock / LEVERAGE;
  const newSL = pos.direction === 'LONG'
    ? pos.entry * (1 + lockPricePct)
    : pos.entry * (1 - lockPricePct);

  // Only move SL in favour
  if (pos.direction === 'LONG'  && newSL > pos.sl) pos.sl = newSL;
  if (pos.direction === 'SHORT' && newSL < pos.sl) pos.sl = newSL;
}

// ── Main backtest ─────────────────────────────────────────────
async function run() {
  const endMs   = Date.now();
  const startMs = endMs - DAYS * 86400000;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BACKTEST — VWAP + 15m/1m Structure | Real Engine Rules');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Tokens  : ${SYMBOLS.join(', ')}`);
  console.log(`Period  : ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${DAYS}d)`);
  console.log(`Leverage: ${LEVERAGE}×  |  Capital/trade: ${(CAPITAL_PCT * 100).toFixed(0)}% (max 100%)`);
  console.log(`SL      : ATR × ${ATR_SL_MULT}  |  TP: ATR × 2  |  RR min: ${RR_MIN}`);
  console.log(`slDist  : ${(SL_DIST_MIN * 100).toFixed(2)}% – ${(SL_DIST_MAX * 100).toFixed(0)}%`);
  console.log(`Trail   : +20% capital → breakeven, then +10% steps`);
  console.log('');

  // ── Fetch historical data ────────────────────────────────────
  const data = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`Fetching ${sym}...`);
    const [k15m, k1m] = await Promise.all([
      fetchKlines(sym, '15m', 1500, endMs),
      fetchAllKlines1m(sym, startMs, endMs),
    ]);
    if (!k15m || !k1m) { console.log(' ✗ failed'); continue; }
    data[sym] = {
      c15m: k15m.map(parseCandle).filter(c => c.t >= startMs - 3600000 * 2), // 2h extra for VWAP
      c1m:  k1m.map(parseCandle),
    };
    console.log(` ✓  15m:${data[sym].c15m.length} bars  1m:${data[sym].c1m.length} bars`);
  }
  console.log('');

  // ── Simulate ─────────────────────────────────────────────────
  let wallet      = WALLET_START;
  const trades    = [];
  const openPos   = {};   // symbol → position
  let totalSigs   = 0;
  let cooldown    = {};   // symbol_DIR → ms until allowed again
  const COOLDOWN  = 30 * 60 * 1000; // 30-min same-direction cooldown (matches cycle.js)
  const SCAN_INT  = 60 * 1000;       // scan every 1 minute

  // Build unified timeline from first symbol's 1m candles
  const anchor = Object.values(data)[0]?.c1m || [];
  const timeline = anchor.filter(c => c.t >= startMs).map(c => c.t);

  console.log(`Simulating ${timeline.length} 1m bars...`);

  for (const now of timeline) {
    // ── Manage open positions ──────────────────────────────────
    for (const [sym, pos] of Object.entries(openPos)) {
      const symData = data[sym];
      if (!symData) continue;

      // Current 1m candle at this timestamp
      const bar = symData.c1m.find(c => c.t === now);
      if (!bar) continue;

      // Update trailing SL
      updateTrail(pos, bar.c);

      // Check SL hit (use bar low/high)
      const slHit = pos.direction === 'LONG' ? bar.l <= pos.sl : bar.h >= pos.sl;
      const tpHit = pos.direction === 'LONG' ? bar.h >= pos.tp : bar.l <= pos.tp;

      if (tpHit || slHit) {
        const exitPrice = tpHit ? pos.tp : pos.sl;
        const reason    = tpHit ? 'TP' : 'SL';
        const margin    = wallet * Math.min(CAPITAL_PCT, 1.0);
        const notional  = margin * LEVERAGE;
        const qty       = notional / pos.entry;
        const rawPnl    = pos.direction === 'LONG'
          ? (exitPrice - pos.entry) * qty
          : (pos.entry  - exitPrice) * qty;
        const fee    = notional * 0.0008; // 0.04% × 2 legs
        const pnl    = rawPnl - fee;

        wallet += pnl;
        // Clamp wallet: can never go below 0
        if (wallet < 0) wallet = 0;

        trades.push({
          sym, dir: pos.direction, entry: pos.entry, exit: exitPrice,
          reason, entryTime: pos.time, exitTime: now,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round((pnl / margin) * 1000) / 10, // % of margin used
        });

        // Cooldown on same direction
        cooldown[`${sym}_${pos.direction}`] = now + COOLDOWN;
        delete openPos[sym];
      }
    }

    // ── Scan for new entries ────────────────────────────────────
    if (Object.keys(openPos).length >= MAX_POSITIONS) continue;
    if (wallet <= 0) continue;

    for (const sym of SYMBOLS) {
      if (openPos[sym]) continue; // already in a position on this symbol

      const symData = data[sym];
      if (!symData) continue;

      // Get candles available at this moment
      const c15m = symData.c15m.filter(c => c.t <= now);
      const c1m  = symData.c1m.filter(c => c.t <= now);
      if (c15m.length < 30 || c1m.length < 20) continue;

      const price = c1m[c1m.length - 1].c;

      const sig = generateSignal(c15m.slice(-100), c1m.slice(-50), price);
      if (!sig) continue;

      // Cooldown check
      const cdKey = `${sym}_${sig.direction}`;
      if (cooldown[cdKey] && now < cooldown[cdKey]) continue;

      totalSigs++;
      openPos[sym] = {
        direction: sig.direction,
        entry: sig.entry,
        sl:    sig.sl,
        tp:    sig.tp,
        time:  now,
      };
    }
  }

  // Close any still-open positions at last available price
  for (const [sym, pos] of Object.entries(openPos)) {
    const symData = data[sym];
    if (!symData || !symData.c1m.length) continue;
    const exitPrice = symData.c1m[symData.c1m.length - 1].c;
    const margin  = wallet * Math.min(CAPITAL_PCT, 1.0);
    const notional = margin * LEVERAGE;
    const qty      = notional / pos.entry;
    const rawPnl   = pos.direction === 'LONG'
      ? (exitPrice - pos.entry) * qty
      : (pos.entry  - exitPrice) * qty;
    const fee = notional * 0.0008;
    const pnl = rawPnl - fee;
    wallet += pnl;
    trades.push({
      sym, dir: pos.direction, entry: pos.entry, exit: exitPrice,
      reason: 'END', entryTime: pos.time, exitTime: timeline[timeline.length - 1] || Date.now(),
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round((pnl / margin) * 1000) / 10,
    });
  }

  // ── Results ───────────────────────────────────────────────────
  const closed  = trades.filter(t => t.pnl != null);
  const wins    = closed.filter(t => t.pnl > 0);
  const losses  = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const winRate  = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgWin   = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const returnPct = (totalPnl / WALLET_START) * 100;

  // Max drawdown
  let peak = WALLET_START, maxDD = 0, running = WALLET_START;
  for (const t of closed) {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = peak > 0 ? (peak - running) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Per-coin stats
  const coinStats = {};
  for (const t of closed) {
    if (!coinStats[t.sym]) coinStats[t.sym] = { w: 0, l: 0, pnl: 0 };
    if (t.pnl > 0) coinStats[t.sym].w++; else coinStats[t.sym].l++;
    coinStats[t.sym].pnl += t.pnl;
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                       RESULTS                             ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Starting Wallet : $${WALLET_START.toFixed(2)}`);
  console.log(`Final Wallet    : $${Math.max(0, wallet).toFixed(2)}`);
  console.log(`Total P&L       : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${returnPct >= 0 ? '+' : ''}${Math.min(returnPct, 999.9).toFixed(1)}%)`);
  console.log(`Signals found   : ${totalSigs}`);
  console.log(`Trades taken    : ${closed.length}`);
  console.log(`Win Rate        : ${Math.min(winRate, 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`Avg Win         : +$${avgWin.toFixed(2)}`);
  console.log(`Avg Loss        : $${avgLoss.toFixed(2)}`);
  console.log(`Max Drawdown    : ${Math.min(maxDD, 100).toFixed(1)}%`);
  console.log('');

  // Per-coin breakdown
  console.log('─── Per-Coin ───────────────────────────────────────────────');
  for (const sym of SYMBOLS) {
    const s = coinStats[sym];
    if (!s) { console.log(`${sym.padEnd(10)} : no trades`); continue; }
    const wr = s.w + s.l > 0 ? ((s.w / (s.w + s.l)) * 100).toFixed(0) : '0';
    const pStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
    console.log(`${sym.padEnd(10)} : W${s.w} L${s.l}  WR:${wr.padStart(3)}%  P&L: ${pStr}`);
  }

  // Trade log
  console.log('\n─── Trade Log ──────────────────────────────────────────────');
  console.log('Date        Symbol      Dir    Entry        Exit         P&L        Reason');
  console.log('─'.repeat(85));
  for (const t of closed) {
    const dt   = new Date(t.entryTime).toISOString().slice(5, 16).replace('T', ' ');
    const pStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
    console.log(
      `${dt}  ${t.sym.padEnd(10)}  ${t.dir.padEnd(5)}  ` +
      `${t.entry.toFixed(4).padStart(11)}  ${t.exit.toFixed(4).padStart(11)}  ` +
      `${pStr.padStart(9)}  ${t.reason}`
    );
  }

  // Version summary line (for pasting into admin as a new version)
  console.log('\n═══════════════════════════════════════════════════════════');
  const vLabel = `VWAP+Structure ${DAYS}d WR:${Math.min(winRate, 100).toFixed(0)}% Lev:${LEVERAGE}x`;
  console.log(`Version label   : ${vLabel}`);
  console.log(`Win rate (real) : ${Math.min(winRate, 100).toFixed(1)}%  ← max possible is 100%`);
  console.log(`Return          : ${returnPct >= 0 ? '+' : ''}${Math.min(returnPct, 999.9).toFixed(1)}%`);
  console.log('═══════════════════════════════════════════════════════════');
}

run().catch(console.error);
