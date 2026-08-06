// 1-minute entry refinement — the final step of the top-down chain.
//
//   4h/1d OB  = the zone (where)         — backtest-eth-ob-tf.js
//   15m HL/LH = the structural trigger   — backtest-eth-mtf.js (64% WR)
//   1m        = the exact fill + tight stop  ← THIS MODULE
//
// After a 15m HL/LH prints inside a HTF OB, the live bot calls refineEntryOn1m():
// it pulls recent 1m candles and waits for a 1m CHoCH in the trade direction
// (price closes beyond the last 1m swing), then returns the entry price and a
// TIGHT stop at the 1m swing — a much better reward:risk than the 15m stop.
//
// The edge comes from the HTF OB + 15m structure; the 1m only sharpens the fill,
// so this FAILS OPEN: if 1m data isn't available or no trigger forms in time, it
// returns { triggered:false } and the caller falls back to the 15m entry/stop.
//
//   node mtf-entry.js --selftest      # pure 1m-trigger logic (no network)

// ── Lightweight swing detection (dependency-free, so the trigger is unit-testable).
function swings(c, L = 3, R = 1) {
  const hs = [], ls = [];
  for (let i = L; i < c.length - R; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= L; j++) { if (c[i - j].h >= c[i].h) hi = false; if (c[i - j].l <= c[i].l) lo = false; }
    for (let j = 1; j <= R; j++) { if (c[i + j].h > c[i].h) hi = false; if (c[i + j].l < c[i].l) lo = false; }
    if (hi) hs.push({ idx: i, price: c[i].h });
    if (lo) ls.push({ idx: i, price: c[i].l });
  }
  return { hs, ls };
}

// Pure trigger: does the tail of `c1m` show a 1m CHoCH in `direction`?
//   LONG  → latest close breaks the last 1m swing HIGH → entry = close,
//           stop = last 1m swing LOW (tight), minus a small buffer.
//   SHORT → mirror.
// Returns { triggered, entry, stop, reason }.
function find1mTrigger(c1m, direction, buf = 0.0005) {
  const dir = String(direction || '').toUpperCase();
  if (!Array.isArray(c1m) || c1m.length < 8) return { triggered: false, reason: 'too few 1m bars' };
  const { hs, ls } = swings(c1m);
  const last = c1m[c1m.length - 1];

  if (dir === 'LONG') {
    const sh = hs[hs.length - 1], slw = ls[ls.length - 1];
    if (sh && slw && last.c > sh.price) {
      const stop = slw.price * (1 - buf);
      if (stop < last.c) return { triggered: true, entry: last.c, stop, reason: `bullish CHoCH > ${sh.price}` };
    }
    return { triggered: false, reason: 'no 1m bullish CHoCH yet' };
  }
  if (dir === 'SHORT') {
    const slw = ls[ls.length - 1], sh = hs[hs.length - 1];
    if (sh && slw && last.c < slw.price) {
      const stop = sh.price * (1 + buf);
      if (stop > last.c) return { triggered: true, entry: last.c, stop, reason: `bearish CHoCH < ${slw.price}` };
    }
    return { triggered: false, reason: 'no 1m bearish CHoCH yet' };
  }
  return { triggered: false, reason: 'unknown direction' };
}

// Live refinement: fetch recent low-timeframe candles and look for the CHoCH
// trigger. The entry timeframe is a config choice — 1m is tightest but noisy,
// 3m is the usual sweet spot (less whipsaw), 5m calmer still. Async + fail-open.
// `candles` may be injected (tests); otherwise fetched from Bybit (prod — sub-15m
// isn't reachable in the web sandbox).
//   entryTf: Bybit interval code — '1' | '3' | '5' (default from ENTRY_TF, else '3').
async function refineEntry({ symbol, direction, entryTf = null, bars = 60, candles = null, buf = 0.0005 } = {}) {
  const tf = String(entryTf || process.env.ENTRY_TF || '3');
  try {
    let c = candles;
    if (!c) {
      const smc = require('./smc-engine');
      c = await smc.fetchCandles(symbol, tf, bars);      // Bybit low-TF klines
    }
    if (!Array.isArray(c) || c.length < 8)
      return { triggered: false, checked: false, tf, reason: `${tf}m data unavailable — fall back to 15m entry` };
    return { checked: true, tf, ...find1mTrigger(c, direction, buf) };
  } catch (e) {
    return { triggered: false, checked: false, tf, reason: `${tf}m fetch failed — fall back to 15m: ${e.message}` };
  }
}

// Back-compat wrapper: 1-minute entry specifically.
const refineEntryOn1m = (opts = {}) => refineEntry({ ...opts, entryTf: '1', candles: opts.candles1m ?? opts.candles ?? null });

module.exports = { find1mTrigger, findEntryTrigger: find1mTrigger, refineEntry, refineEntryOn1m, swings };

// ── Offline self-test of the pure trigger (no network) ──
function selftest() {
  let pass = 0, fail = 0;
  const chk = (n, got, want) => { const ok = got === want; console.log(`  ${ok ? '✓' : '✗'} ${n}: triggered=${got} (want ${want})`); ok ? pass++ : fail++; };
  // Down-then-up: swing low @101 (bar3), swing high @107 (bar6), then close 108 > 107 → bullish CHoCH.
  const up = [
    { h: 110, l: 109, c: 109 }, { h: 108, l: 107, c: 107 }, { h: 106, l: 105, c: 105 },
    { h: 102, l: 101, c: 101 },                                   // swing low 101
    { h: 103, l: 101.5, c: 103 }, { h: 105, l: 103, c: 105 }, { h: 107, l: 105, c: 107 }, // swing high 107
    { h: 106, l: 104, c: 104 }, { h: 105, l: 104, c: 105 }, { h: 106, l: 104.5, c: 106 },
    { h: 108, l: 106, c: 108 },                                   // close 108 > 107 → bullish CHoCH
  ];
  const r1 = find1mTrigger(up, 'LONG');
  chk('long CHoCH triggers', r1.triggered, true);
  chk('long stop below entry', !!(r1.triggered && r1.stop < r1.entry && r1.stop > 0), true);
  chk('short does not trigger on up-break', find1mTrigger(up, 'SHORT').triggered, false);
  // Up-then-down: swing high @98 (bar4), swing low @91 (bar7), then close 88 < 91 → bearish CHoCH.
  const dn = [
    { h: 90, l: 89, c: 90 }, { h: 92, l: 91, c: 92 }, { h: 94, l: 93, c: 94 }, { h: 96, l: 95, c: 96 },
    { h: 98, l: 97, c: 98 },                                      // swing high 98
    { h: 97, l: 95, c: 95 }, { h: 95, l: 93, c: 93 }, { h: 93, l: 91, c: 91 }, // swing low 91
    { h: 92, l: 91.5, c: 92 }, { h: 94, l: 92, c: 94 }, { h: 93, l: 91.5, c: 92 },
    { h: 90, l: 88, c: 88 },                                      // close 88 < 91 → bearish CHoCH
  ];
  const r2 = find1mTrigger(dn, 'SHORT');
  chk('short CHoCH triggers', r2.triggered, true);
  chk('short stop above entry', !!(r2.triggered && r2.stop > r2.entry), true);
  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

if (require.main === module && process.argv.includes('--selftest')) selftest();
