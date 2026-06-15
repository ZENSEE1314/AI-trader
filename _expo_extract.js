'use strict';
// Extract SMC Expo structure labels (HH/HL/LH/LL) with timestamps, save to JSON.
const fs = require('fs');
const TV = require('@mathieuc/tradingview');
const SESSION = process.env.TV_SESSION, SIGN = process.env.TV_SESSION_SIGN;
const ID = 'PUB;26ae10374a9d4b0591b5b51a41356e57';   // Smart Money Concept (Expo)
const SYMBOLS = (process.env.TV_SYMBOLS || 'BITUNIX:BTCUSDT.P,BITUNIX:ETHUSDT.P,BITUNIX:SOLUSDT.P,BITUNIX:BNBUSDT.P').split(',');
const RANGE = Number(process.argv[2] || 3000);
const OUT = 'data/expo-labels';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function extract(ind, tvSym) {
  return new Promise((resolve) => {
    const client = new TV.Client({ token: SESSION, signature: SIGN });
    const chart = new client.Session.Chart();
    chart.setMarket(tvSym, { timeframe: '15', range: RANGE });
    const study = new chart.Study(ind);
    let done = false;
    const finish = (labels, periods) => {
      if (done) return; done = true;
      // chart.periods is newest-first; label.x = bars-from-newest → time = periods[x].time
      const out = [];
      for (const l of labels) {
        if (l.x == null) continue;
        const t = l.text || '';
        if (!/^(HH|HL|LH|LL)$/.test(t)) continue;
        const bar = periods[l.x];
        if (!bar) continue;
        out.push({ time: bar.time * 1000, type: t, price: l.y });
      }
      out.sort((a, b) => a.time - b.time);
      client.end();
      resolve(out);
    };
    study.onUpdate(() => {
      const g = study.graphic || {};
      const labels = g.labels || [];
      const periods = chart.periods || [];
      if (labels.length && periods.length) setTimeout(() => finish(labels, periods), 1500);
    });
    study.onError((...e) => { console.log(`${tvSym} STUDY ERR: ${e.join(' ')}`); finish([], []); });
    setTimeout(() => finish(study.graphic?.labels || [], chart.periods || []), 22000);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ind = await TV.getIndicator(ID, 'last', SESSION, SIGN);
  for (const tvSym of SYMBOLS) {
    const sym = tvSym.replace(/.*:/, '').replace('.P', '');
    const labels = await extract(ind, tvSym);
    if (!labels.length) { console.log(`${sym}: 0 labels`); continue; }
    const span = (labels[labels.length - 1].time - labels[0].time) / 86400000;
    const counts = labels.reduce((a, l) => (a[l.type] = (a[l.type] || 0) + 1, a), {});
    fs.writeFileSync(`${OUT}/${sym}-15m-expo.json`, JSON.stringify(labels));
    console.log(`${sym}: ${labels.length} labels over ${span.toFixed(1)}d | ${JSON.stringify(counts)} | from ${new Date(labels[0].time).toISOString().slice(0,16)} to ${new Date(labels[labels.length-1].time).toISOString().slice(0,16)}`);
    await sleep(1500);
  }
  process.exit(0);
})();
