'use strict';

// ============================================================
// fetch-futures-klines.js — Download Binance USDT-M futures 15m
// klines from the public data bucket (data.binance.vision) into
// the JSON cache that backtest-live-rules.js reads.
//
//   DAYS=30 node scripts/fetch-futures-klines.js
//   SYMBOLS=BTCUSDT,ETHUSDT DAYS=90 node scripts/fetch-futures-klines.js
//
// Writes: data/backtest-cache/<SYM>-15m.json  (array of Binance
// kline-shaped arrays, so any taker-flow backtest can read field 9).
// Source files: monthly zips for past months, daily zips for the
// current month (today excluded — the daily file lands next day).
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DAYS = parseInt(process.env.DAYS || '30', 10);
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const INTERVAL = process.env.INTERVAL || '15m';
const OUT_DIR = path.join(__dirname, '..', 'data', 'backtest-cache');
const ZIP_CACHE = path.join(os.tmpdir(), 'ai-trader-klines-zips');

const ymd = d => d.toISOString().slice(0, 10);
const ym = d => d.toISOString().slice(0, 7);

function dayList(days) {
  // Complete UTC days: yesterday back to N days ago (today excluded)
  const out = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  for (let i = 0; i < days; i++) {
    out.unshift(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return true;
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return true;
}

function unzip(zipPath, destDir) {
  if (fs.existsSync(destDir) && fs.readdirSync(destDir).some(f => f.endsWith('.csv'))) return;
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'ignore' });
}

function parseCsv(csv) {
  return csv.trim().split(/\r?\n/)
    .filter(l => l && !l.startsWith('open_time'))
    .map(l => l.split(','))
    .filter(r => Number.isFinite(+r[0]) && Number.isFinite(+r[4]));
}

async function fetchSymbol(sym, days) {
  const days_ = dayList(days);
  const first = days_[0], last = days_[days_.length - 1];
  const rowsByTime = new Map();

  const addFile = async (label, url, file) => {
    const ok = await download(url, file);
    if (!ok) { process.stdout.write(`   [miss] ${label}\n`); return 0; }
    const dir = file.replace(/\.zip$/, '');
    unzip(file, dir);
    const csvFile = fs.readdirSync(dir).find(f => f.endsWith('.csv'));
    if (!csvFile) return 0;
    const rows = parseCsv(fs.readFileSync(path.join(dir, csvFile), 'utf8'));
    let n = 0;
    for (const r of rows) { if (!rowsByTime.has(+r[0])) { rowsByTime.set(+r[0], r); n++; } }
    return n;
  };

  // Monthly files for whole past months inside the range
  const curMonth = ym(last);
  let m = new Date(Date.UTC(+ym(first).slice(0, 4), +ym(first).slice(5) - 1, 1));
  while (ym(m) < curMonth) {
    const tag = ym(m);
    const url = `https://data.binance.vision/data/futures/um/monthly/klines/${sym}/${INTERVAL}/${sym}-${INTERVAL}-${tag}.zip`;
    await addFile(`month ${tag}`, url, path.join(ZIP_CACHE, sym, `${sym}-${INTERVAL}-${tag}.zip`));
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  }

  // Daily files for the current month portion
  for (const d of days_) {
    if (ym(d) !== curMonth) continue;
    const tag = ymd(d);
    const url = `https://data.binance.vision/data/futures/um/daily/klines/${sym}/${INTERVAL}/${sym}-${INTERVAL}-${tag}.zip`;
    await addFile(tag, url, path.join(ZIP_CACHE, sym, `${sym}-${INTERVAL}-${tag}.zip`));
  }

  const rows = [...rowsByTime.values()].sort((a, b) => +a[0] - +b[0]);
  const typed = rows.map(r => [+r[0], r[1], r[2], r[3], r[4], r[5], +r[6], r[7], +r[8], r[9], r[10], r[11] || '0']);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${sym}-15m.json`);
  fs.writeFileSync(out, JSON.stringify(typed));

  const spanDays = typed.length ? (typed[typed.length - 1][0] - typed[0][0]) / 86400000 : 0;
  console.log(`   ${sym}: ${typed.length} bars (${spanDays.toFixed(1)}d span) → ${path.relative(process.cwd(), out)}`);
  return typed.length;
}

(async () => {
  console.log(`Fetching Binance futures ${INTERVAL} klines — ${DAYS}d — ${SYMBOLS.join(', ')}`);
  let ok = 0;
  for (const sym of SYMBOLS) {
    try { if (await fetchSymbol(sym, DAYS) > 0) ok++; }
    catch (e) { console.error(`   ${sym}: FAILED — ${e.message}`); }
  }
  console.log(ok === SYMBOLS.length ? 'All symbols cached.' : `Done (${ok}/${SYMBOLS.length} symbols).`);
  process.exit(ok ? 0 : 1);
})();
