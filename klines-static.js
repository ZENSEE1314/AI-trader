// Loader for real historical Binance klines from the community `static-klines`
// dataset (finom/static-klines) via raw.githubusercontent.com — an egress-
// ALLOWED host, so this works in the web sandbox where exchange APIs are blocked.
//
// Data is a daily-refreshed cache of Binance Spot REST klines, committed under
// .klines-cache/{SYMBOL}/{interval}/{window}.json as raw Binance kline arrays:
//   [openTime, open, high, low, close, volume, closeTime, ...]
// Windows: 15m = 1 ISO week (Mon), 1h = 1 month (1st), 4h = 1 quarter (1st).
//
//   ⚠ Experimental community cache — fine for backtests/exploration, not
//   audit-grade (Binance restatements aren't reflected). See the repo's README.
//
// Returns smc-engine-shaped candles: { t,o,h,l,c,v, body,range,bullish }.

const fetch = require('node-fetch');

const RAW = 'https://raw.githubusercontent.com/finom/static-klines/main/.klines-cache';

let _agent;
function agent() {
  if (_agent !== undefined) return _agent;
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  try { _agent = p ? new (require('https-proxy-agent').HttpsProxyAgent)(p) : null; }
  catch { _agent = null; }
  return _agent;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Interval code (as passed to smc.fetchCandles) → static-klines dir + window gen.
function windowsFor(code, count, now = new Date()) {
  const out = [];
  if (code === '15' || code === '15m') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = d.getUTCDay();                        // 0=Sun..6=Sat
    d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));   // this week's Monday
    for (let i = 0; i < count; i++) { out.push(ymd(d)); d.setUTCDate(d.getUTCDate() - 7); }
    return { dir: '15m', dates: out.reverse() };
  }
  if (code === '60' || code === '1h') {
    let y = now.getUTCFullYear(), m = now.getUTCMonth();
    for (let i = 0; i < count; i++) { out.push(`${y}-${pad(m + 1)}-01`); if (--m < 0) { m = 11; y--; } }
    return { dir: '1h', dates: out.reverse() };
  }
  if (code === '240' || code === '4h') {
    let y = now.getUTCFullYear(), q = Math.floor(now.getUTCMonth() / 3);
    for (let i = 0; i < count; i++) { out.push(`${y}-${pad(q * 3 + 1)}-01`); if (--q < 0) { q = 3; y--; } }
    return { dir: '4h', dates: out.reverse() };
  }
  // 1d — 2-year windows anchored on even years (Jan 1)
  let y = now.getUTCFullYear(); if (y % 2 !== 0) y--;
  for (let i = 0; i < count; i++) { out.push(`${y}-01-01`); y -= 2; }
  return { dir: '1d', dates: out.reverse() };
}

function normalize(r) {
  const o = parseFloat(r[1]), h = parseFloat(r[2]), l = parseFloat(r[3]), c = parseFloat(r[4]);
  return { t: parseInt(r[0]), o, h, l, c, v: parseFloat(r[5]),
           body: Math.abs(c - o), range: h - l, bullish: c >= o };
}

async function fetchWindow(symbol, dir, date) {
  const url = `${RAW}/${symbol}/${dir}/${date}.json`;
  try {
    const res = await fetch(url, { agent: agent(), timeout: 20_000 });
    if (!res.ok) return [];
    const raw = await res.json();
    return Array.isArray(raw) ? raw.map(normalize) : [];
  } catch { return []; }
}

// Load ~`windows` recent windows of `code` for `symbol`, ascending + deduped.
async function loadStatic(symbol, code, windows) {
  const { dir, dates } = windowsFor(code, windows);
  const parts = [];
  for (let i = 0; i < dates.length; i += 4)                     // small batches
    parts.push(...await Promise.all(dates.slice(i, i + 4).map(d => fetchWindow(symbol, dir, d))));
  const seen = new Set(), all = [];
  for (const c of parts.flat()) { if (!seen.has(c.t)) { seen.add(c.t); all.push(c); } }
  all.sort((a, b) => a.t - b.t);
  return all;
}

module.exports = { loadStatic, windowsFor, RAW };
