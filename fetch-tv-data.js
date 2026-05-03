/**
 * fetch-tv-data.js
 * Fetches 30 days of OHLCV from TradingView WebSocket for all backtest symbols.
 *
 * All 15 symbols are fetched in parallel for speed.
 * 15m and 1h arrive in the initial push (no pagination needed).
 * 1m and 3m need pagination (fetchMore) to reach 30 days — runs ~8 min total.
 *
 * Usage:  node fetch-tv-data.js
 * Then:   DAYS=30 node backtest-sl-compare.js
 */

'use strict';

const { Client } = require('@mathieuc/tradingview');
const fs   = require('fs');
const path = require('path');

const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','ADAUSDT','LTCUSDT',
  'DOTUSDT','TRXUSDT','SOLUSDT','XRPUSDT','DOGEUSDT',
  'LINKUSDT','AVAXUSDT','ATOMUSDT','NEARUSDT','MATICUSDT',
];

const DAYS       = 32; // fetch a bit more than 30 for buffer
const CUTOFF_MS  = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const CHUNK      = 2000;
const CACHE_DIR  = path.join(__dirname, 'data', 'tv-cache');
const CACHE_AGE  = 2 * 60 * 60 * 1000; // 2 h before re-fetching

const INTERVALS = [
  { res: '1',  key: '1m',  paginate: true  },
  { res: '3',  key: '3m',  paginate: true  },
  { res: '15', key: '15m', paginate: false },
  { res: '60', key: '1h',  paginate: false },
];

function tvSym(sym) {
  return `BINANCE:${sym.replace('USDT', '')}USDT.P`;
}

const toKline = p => [
  p.time * 1000,
  String(p.open), String(p.max), String(p.min), String(p.close),
  String(p.volume ?? 0),
];

// ── Fetch one symbol+interval ────────────────────────────────────
function fetchOne(sym, iv) {
  return new Promise(resolve => {
    let done      = false;
    let lastCount = 0;
    let waiting   = false;

    const client = new Client();
    const chart  = new client.Session.Chart();

    function finish(note) {
      if (done) return;
      done = true;
      const p = chart.periods || [];
      const sorted = p.slice().sort((a, b) => a.time - b.time);
      resolve({ klines: sorted.map(toKline), note });
      try { client.end(); } catch (_) {}
    }

    chart.setMarket(tvSym(sym), { timeframe: iv.res, range: CHUNK });

    chart.onUpdate(() => {
      if (done) return;
      const p = chart.periods;
      if (!p || p.length < 50) return;

      const oldestTs = p[p.length - 1].time * 1000;

      // Done when oldest bar is old enough
      if (oldestTs <= CUTOFF_MS) { finish('ok'); return; }

      // Non-paginated intervals: stop after the initial push settles
      if (!iv.paginate) {
        setTimeout(() => finish('initial'), 600);
        return;
      }

      // Paginated: wait for fetchMore response to arrive (>10 new bars = fetchMore, not live tick)
      if (waiting) {
        if (p.length <= lastCount + 10) return;
        waiting = false;
      }

      // Stop if TV has no more history
      if (p.length <= lastCount && lastCount > 0) { finish('no-more-history'); return; }

      lastCount = p.length;
      waiting   = true;
      chart.fetchMore(CHUNK);
    });

    chart.onError((...e) => finish(`err:${e[0]}`));
    client.onError((...e) => finish(`err:${e[0]}`));

    // Hard timeout — take whatever we have
    const timeout = iv.paginate ? 180_000 : 20_000;
    setTimeout(() => finish('timeout'), timeout);
  });
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`\n═══ TradingView 30-day cache fetch — ${new Date().toISOString().slice(0,16)} ═══`);
  console.log(`Cutoff: ${new Date(CUTOFF_MS).toISOString().slice(0,10)}\n`);

  for (const iv of INTERVALS) {
    const label = iv.paginate ? `(paginating ~${iv.key === '1m' ? '8' : '3'} min)` : '(initial push)';
    console.log(`── ${iv.key} ${label}`);

    // Run symbols sequentially to avoid TradingView rate limits
    const tasks = SYMBOLS.map(sym => async () => {
      const file = path.join(CACHE_DIR, `${sym}-${iv.key}.json`);

      // Skip if cache is fresh
      if (fs.existsSync(file)) {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age < CACHE_AGE) {
          const d = JSON.parse(fs.readFileSync(file));
          const oldest = d.length ? new Date(d[0][0]).toISOString().slice(0,10) : '?';
          const isCovered = !d.length || d[0][0] <= CUTOFF_MS + 2 * 86400 * 1000;
          if (isCovered) {
            process.stdout.write(`  ${sym.padEnd(10)} cached ${d.length}b oldest=${oldest}\n`);
            return;
          }
        }
      }

      const t0 = Date.now();
      const { klines, note } = await fetchOne(sym, iv);
      // Never overwrite a good file with an empty/error result
      if (klines.length === 0) {
        process.stdout.write(`  ${sym.padEnd(10)} SKIP — fetch returned 0 bars [${note}]\n`);
        return;
      }
      fs.writeFileSync(file, JSON.stringify(klines));
      const oldest = klines.length ? new Date(klines[0][0]).toISOString().slice(0,10) : 'empty';
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(`  ${sym.padEnd(10)} ${klines.length}b oldest=${oldest} [${note}] ${elapsed}s\n`);
    });

    for (const task of tasks) await task();
    console.log();
  }

  console.log('✓ Done — run: DAYS=30 node backtest-sl-compare.js\n');
}

main().catch(console.error);
