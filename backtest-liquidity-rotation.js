// Liquidity-rotation backtest — the "up then down, follow the liquidity" model.
//
// The idea (owner): price swings between resting liquidity pools — buy-side (EQH,
// swing highs) above, sell-side (EQL, swing lows) below. Go long from a bullish
// structure shift (CHoCH up) toward the liquidity ABOVE; when structure breaks
// down (CHoCH down) flip short toward the liquidity BELOW. Trades naturally
// alternate in a range and ride each leg to where the stops sit.
//
// Rules per trade:
//   • Entry: a CHoCH (close beyond the last opposing swing) — long if up, short if down.
//   • Target (TP): the NEAREST liquidity in the trade's direction (EQH/EQL pool or
//     swing extreme), within MAX_TP_DIST.
//   • Stop (SL): the last opposing swing (structure). risk = |entry − SL|.
//   • Exit: TP hit, SL hit, or an opposite CHoCH (which also opens the next, flipped
//     trade). One position at a time.
//   • R = realized move / initial risk.  Skips setups with no target or RR < MIN_RR.
//
// Data: static-klines via raw.githubusercontent.com (sandbox-safe), Bybit fallback.
//   SYMBOL=SOLUSDT WEEKS_15M=30 node backtest-liquidity-rotation.js
//   node backtest-liquidity-rotation.js --selftest

const SYMBOL   = (process.env.SYMBOL || 'SOLUSDT').toUpperCase();
const WEEKS    = Math.max(4, parseInt(process.env.WEEKS_15M || '30', 10) || 30);
const LBL = 10, LBR = 1;
const MAX_TP_DIST = (Number(process.env.ROT_MAX_TP_PCT || 6) || 6) / 100;   // ignore targets > 6% away
const MIN_RR      = Number(process.env.ROT_MIN_RR || 0.3) || 0.3;           // skip poor reward:risk
const rS = n => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2) + 'R';

// Walk future bars for the outcome, in R. dir: +1 long, -1 short.
function outcome(dir, entry, sl, tp, future) {
  const risk = Math.abs(entry - sl);
  for (const b of future) {
    if (dir > 0) {
      if (b.l <= sl) return -1;
      if (b.h >= tp) return (tp - entry) / risk;
    } else {
      if (b.h >= sl) return -1;
      if (b.l <= tp) return (entry - tp) / risk;
    }
  }
  const last = future.length ? future[future.length - 1].c : entry;
  return (dir > 0 ? last - entry : entry - last) / risk;
}

async function run() {
  const smc = require('./smc-engine');
  const { normalize } = require('./ob-touch');
  let cs;
  try {
    if (process.env.KLINES_SOURCE === 'static') throw new Error('forced static');
    cs = (await smc.fetchCandles(SYMBOL, '15', 1000)).map(normalize);
  } catch {
    const { loadStatic } = require('./klines-static');
    cs = (await loadStatic(SYMBOL, '15m', WEEKS)).map(normalize);
  }
  if (!cs || cs.length < 200) { console.error('Not enough data.'); process.exitCode = 1; return; }
  const spanDays = (cs[cs.length - 1].t - cs[0].t) / 864e5;

  // Confirmed pivots (each confirms LBR bars after its index).
  const pivots = smc.detectPivots(cs, LBL, LBR);
  const byConfirm = pivots.map(p => ({ ...p, confirm: p.idx + LBR })).sort((a, b) => a.confirm - b.confirm);

  const trades = [];
  let lastHigh = null, lastLow = null;   // most-recent confirmed swing as of the bar
  let pi = 0;
  let pos = null;                        // { dir, entry, sl, tp, iEntry }

  const targetAbove = (i, price) => {
    const upto = pivots.filter(p => p.idx <= i);
    const pools = smc.detectLiquidityPools(cs.slice(0, i + 1), upto) || [];
    const cands = [
      ...pools.filter(p => p.label === 'EQH' && p.level > price).map(p => p.level),
      ...upto.filter(p => p.type === 'HIGH' && p.price > price).map(p => p.price),
    ];
    const t = cands.length ? Math.min(...cands) : null;
    return t && (t - price) / price <= MAX_TP_DIST ? t : null;
  };
  const targetBelow = (i, price) => {
    const upto = pivots.filter(p => p.idx <= i);
    const pools = smc.detectLiquidityPools(cs.slice(0, i + 1), upto) || [];
    const cands = [
      ...pools.filter(p => p.label === 'EQL' && p.level < price).map(p => p.level),
      ...upto.filter(p => p.type === 'LOW' && p.price < price).map(p => p.price),
    ];
    const t = cands.length ? Math.max(...cands) : null;
    return t && (price - t) / price <= MAX_TP_DIST ? t : null;
  };

  const open = (dir, i) => {
    const e = cs[i].c;
    const sl = dir > 0 ? (lastLow && lastLow.price) : (lastHigh && lastHigh.price);
    if (sl == null) return null;
    const tp = dir > 0 ? targetAbove(i, e) : targetBelow(i, e);
    if (tp == null) return null;
    const risk = Math.abs(e - sl), reward = Math.abs(tp - e);
    if (risk <= 0 || reward <= 0 || reward / risk < MIN_RR) return null;
    return { dir, entry: e, sl, tp, iEntry: i };
  };

  for (let i = LBL + LBR; i < cs.length; i++) {
    while (pi < byConfirm.length && byConfirm[pi].confirm <= i) {
      const p = byConfirm[pi++];
      if (p.type === 'HIGH') lastHigh = p; else lastLow = p;
    }
    const c = cs[i];

    if (pos) {
      // resolve SL/TP intrabar first (SL conservative on ties)
      if (pos.dir > 0) {
        if (c.l <= pos.sl) { trades.push({ dir: pos.dir, r: -1 }); pos = null; }
        else if (c.h >= pos.tp) { trades.push({ dir: pos.dir, r: (pos.tp - pos.entry) / (pos.entry - pos.sl) }); pos = null; }
      } else {
        if (c.h >= pos.sl) { trades.push({ dir: pos.dir, r: -1 }); pos = null; }
        else if (c.l <= pos.tp) { trades.push({ dir: pos.dir, r: (pos.entry - pos.tp) / (pos.sl - pos.entry) }); pos = null; }
      }
    }

    // CHoCH flip: close above last swing high = bullish; below last swing low = bearish.
    const bull = lastHigh && c.c > lastHigh.price;
    const bear = lastLow && c.c < lastLow.price;

    if (pos && pos.dir > 0 && bear) {                         // long → flip short
      trades.push({ dir: pos.dir, r: (c.c - pos.entry) / (pos.entry - pos.sl) }); pos = null;
    } else if (pos && pos.dir < 0 && bull) {                  // short → flip long
      trades.push({ dir: pos.dir, r: (pos.entry - c.c) / (pos.sl - pos.entry) }); pos = null;
    }

    if (!pos) {
      if (bear) pos = open(-1, i);
      else if (bull) pos = open(1, i);
    }
  }

  // stats
  const n = trades.length;
  const wins = trades.filter(t => t.r > 0).length;
  const net = trades.reduce((s, t) => s + t.r, 0);
  let alt = 0;
  for (let i = 1; i < trades.length; i++) if (trades[i].dir !== trades[i - 1].dir) alt++;

  console.log(`══════════ Liquidity rotation — ${SYMBOL} ══════════`);
  console.log(`Window: ~${spanDays.toFixed(0)} days, ${cs.length}×15m bars`);
  console.log(`Trades: ${n}  (${(n / spanDays).toFixed(2)}/day)  | WR ${(wins / n * 100).toFixed(1)}%  | avg ${rS(net / n)}  | net ${rS(net)}`);
  console.log(`Alternation (next trade opposite the last): ${n > 1 ? (alt / (n - 1) * 100).toFixed(0) : 0}%`);
  console.log(`Longs ${trades.filter(t => t.dir > 0).length} / Shorts ${trades.filter(t => t.dir < 0).length}`);
  console.log('\nModel: enter on CHoCH toward the nearest EQH/EQL liquidity, SL at the opposing');
  console.log('swing, flip on an opposite CHoCH. Directional (static-klines, community cache).');
}

function selftest() {
  let pass = 0, fail = 0;
  const chk = (n, got, want) => { const ok = Math.abs(got - want) < 1e-9; console.log(`  ${ok ? '✓' : '✗'} ${n}: ${got.toFixed(3)} (want ${want})`); ok ? pass++ : fail++; };
  // long, entry 100, sl 98 (risk 2), tp 104 (reward 4 = 2R). TP hit → +2R.
  chk('long TP +2R', outcome(1, 100, 98, 104, [{ h: 104, l: 99, c: 104 }]), 2);
  // long, SL hit → -1R.
  chk('long SL -1R', outcome(1, 100, 98, 104, [{ h: 101, l: 97, c: 97 }]), -1);
  // short, entry 100, sl 102 (risk 2), tp 96 (reward 4). TP hit → +2R.
  chk('short TP +2R', outcome(-1, 100, 102, 96, [{ h: 101, l: 96, c: 96 }]), 2);
  console.log(`\nself-test: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
}

if (process.argv.includes('--selftest')) selftest();
else run().catch(e => { console.error(`failed: ${e.message}`); process.exitCode = 1; });
