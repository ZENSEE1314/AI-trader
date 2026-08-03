// Kline collector for the MS-OB-VWAP backtest.
// Runs on YOUR machine (where the VPN reaches Bybit). No npm install needed —
// uses Node 18+'s built-in fetch. Writes msob-klines.json, which you upload
// back so the backtest can be run + interpreted for you.
//
//   node msob-collect.js
//   DAYS=90 SYMBOLS=ETHUSDT,SOLUSDT node msob-collect.js
//
// If `fetch is not defined`, your Node is too old — use Node 18+ (`node -v`).

const fs = require('fs');

const DAYS = Math.max(5, parseInt(process.env.DAYS || '60', 10) || 60);
const SYMS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const OUT = process.env.OUT || 'msob-klines.json';
const TFS = { '15': DAYS * 96 + 220, '60': DAYS * 24 + 160, '240': DAYS * 6 + 160 };

async function page(sym, interval, end) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}&limit=1000&end=${end}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${sym} ${interval}`);
  const j = await r.json();
  const list = j?.result?.list || [];
  // Bybit = newest-first; return oldest-first {t,o,h,l,c,v}
  return list.slice().reverse().map(x => ({
    t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5],
    body: Math.abs(+x[4] - +x[1]), range: +x[2] - +x[3], bullish: +x[4] >= +x[1],
  }));
}

async function collect(sym, interval, targetBars) {
  const map = new Map();
  let end = Date.now(), guard = 0;
  while (map.size < targetBars && guard++ < 80) {
    const batch = await page(sym, interval, end);
    if (!batch.length) break;
    for (const c of batch) map.set(c.t, c);
    end = batch[0].t - 1;
    if (batch.length < 1000) break;
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

(async () => {
  if (typeof fetch !== 'function') { console.error('No global fetch — use Node 18+ (node -v).'); process.exit(1); }
  const out = { params: { days: DAYS, symbols: SYMS, collectedAt: new Date().toISOString() }, data: {} };
  for (const sym of SYMS) {
    out.data[sym] = {};
    for (const [tf, bars] of Object.entries(TFS)) {
      process.stdout.write(`\r${sym} ${tf}m … `);
      try { out.data[sym][tf] = await collect(sym, tf, bars); }
      catch (e) { console.error(`\n${sym} ${tf}: ${e.message}`); out.data[sym][tf] = []; }
      process.stdout.write(`${out.data[sym][tf].length} bars   `);
    }
    console.log('');
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
  console.log(`\n✓ wrote ${OUT} (${mb} MB). Upload this file back to the chat.`);
})().catch(e => { console.error('collect failed:', e.message); process.exit(1); });
