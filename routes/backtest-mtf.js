'use strict';
// ============================================================
// MTF backtest route — top-down 1h→15m→1m + curved-band + VSA,
// reusing the site's own chart engine (routes/chart.js `lib`).
// Mounted at /api/backtest-mtf.
//   GET /api/backtest-mtf/run?symbol=SOLUSDT&days=14&lev=20&...  → JSON
//   GET /api/backtest-mtf/                                       → UI page
// ============================================================
const express = require('express');
const router = express.Router();

const { runMtfBacktest, summarize } = require('../backtest-mtf-engine');
const { fetchArr } = require('../backtest-mtf-fetch');
const { lib } = require('./chart');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

router.get('/run', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'SOLUSDT').toUpperCase();
    const days = clamp(Number(req.query.days) || 14, 1, 45);
    const opts = {
      lev:         clamp(Number(req.query.lev) || 20, 1, 125),
      slMargin:    clamp(Number(req.query.sl) || 0.50, 0.05, 2),
      tpMargin:    clamp(Number(req.query.tp) || 0.75, 0.05, 5),
      bandNear:    clamp(Number(req.query.bandNear) || 0.25, 0.01, 1),
      pivot1m:     clamp(Number(req.query.pivot1m) || 2, 1, 10),
      vsaMult:     clamp(Number(req.query.vsaMult) || 2.0, 1, 10),
      vsaBody:     clamp(Number(req.query.vsaBody) || 0.5, 0, 1),
      eqhGuardPct: clamp(Number(req.query.eqhGuard) || 0, 0, 0.05),
    };
    const [k1h, k15, k1m] = await Promise.all([
      fetchArr(symbol, '1h', days + 3),
      fetchArr(symbol, '15m', days + 1),
      fetchArr(symbol, '1m', days),
    ]);
    if (!k1m.length || !k15.length || !k1h.length) {
      return res.status(502).json({ error: 'kline fetch returned empty (exchange unreachable?)' });
    }
    const r = runMtfBacktest({ k1h, k15, k1m, lib, opts });
    res.json({
      symbol, days, opts: r.opts, counts: r.counts, skips: r.skips,
      summary: summarize(r.trades),
      trades: r.trades.map(t => ({
        side: t.side, entry: +t.entry.toFixed(4),
        entryT: new Date(t.entryT).toISOString(),
        exit: t.exit, exitT: new Date(t.exitT).toISOString(),
        r: +(t.r * 100).toFixed(1),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', (_req, res) => res.type('html').send(PAGE));

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MTF Backtest — 1h→15m→1m</title>
<style>
 body{font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:24px}
 h1{font-size:18px;margin:0 0 4px} .sub{color:#8b949e;margin:0 0 20px}
 .grid{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-bottom:16px}
 label{display:flex;flex-direction:column;font-size:12px;color:#8b949e;gap:4px}
 input,select{background:#161b22;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:6px 8px;width:88px}
 button{background:#238636;border:0;color:#fff;border-radius:6px;padding:9px 18px;font-weight:600;cursor:pointer}
 button:disabled{opacity:.5;cursor:wait}
 table{border-collapse:collapse;width:100%;margin-top:12px;font-variant-numeric:tabular-nums}
 th,td{border:1px solid #30363d;padding:6px 10px;text-align:right} th{background:#161b22;color:#8b949e}
 td:first-child,th:first-child{text-align:left}
 .win{color:#3fb950} .loss{color:#f85149}
 .cards{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 4px}
 .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;min-width:150px}
 .card b{font-size:20px;display:block} .muted{color:#8b949e;font-size:12px}
 #err{color:#f85149;margin-top:10px}
</style></head><body>
<h1>MTF Backtest — 1h→15m→1m · curved band · VSA</h1>
<p class="sub">Uses the MCT chart engine (structure, equal-highs, curved bands). Past data only — not financial advice.</p>
<div class="grid">
 <label>Symbol<input id="symbol" value="SOLUSDT"></label>
 <label>Days<input id="days" type="number" value="14"></label>
 <label>Leverage<input id="lev" type="number" value="20"></label>
 <label>SL margin<input id="sl" type="number" step="0.05" value="0.50"></label>
 <label>TP margin<input id="tp" type="number" step="0.05" value="0.75"></label>
 <label>Band near<input id="bandNear" type="number" step="0.05" value="0.25"></label>
 <label>VSA mult<input id="vsaMult" type="number" step="0.5" value="2"></label>
 <label>EQH guard %<input id="eqhGuard" type="number" step="0.001" value="0"></label>
 <button id="go">Run backtest</button>
</div>
<div id="err"></div>
<div id="out"></div>
<script>
 const $ = id => document.getElementById(id);
 const q = () => ['symbol','days','lev','sl','tp','bandNear','vsaMult','eqhGuard']
   .map(k => k+'='+encodeURIComponent($(k).value)).join('&');
 const row = (n,s)=> s.n? '<tr><td>'+n+'</td><td>'+s.n+'</td><td>'+(s.wr*100).toFixed(0)+'%</td><td class="'+(s.pnl>=0?'win':'loss')+'">'+(s.pnl>=0?'+':'')+(s.pnl*100).toFixed(0)+'%</td><td>'+(s.perTrade*100).toFixed(1)+'%</td><td>'+(s.pf===null?'∞':s.pf.toFixed(2))+'</td></tr>' : '<tr><td>'+n+'</td><td colspan=5 class=muted>no trades</td></tr>';
 $('go').onclick = async () => {
   $('err').textContent=''; $('go').disabled=true; $('go').textContent='Running…'; $('out').innerHTML='';
   try{
     const res = await fetch('/api/backtest-mtf/run?'+q());
     const d = await res.json();
     if(d.error){ $('err').textContent='Error: '+d.error; return; }
     const S=d.summary;
     let h = '<div class=cards>'
       + '<div class=card><span class=muted>Net (all)</span><b class="'+(S.all.pnl>=0?'win':'loss')+'">'+(S.all.pnl>=0?'+':'')+(S.all.pnl*100).toFixed(0)+'% margin</b><span class=muted>'+S.all.n+' trades · WR '+(S.all.wr*100||0).toFixed(0)+'% · PF '+(S.all.pf===null?'∞':S.all.pf.toFixed(2))+'</span></div>'
       + '<div class=card><span class=muted>Data</span><b>'+d.counts.k1m+'</b><span class=muted>1m bars · '+d.counts.lab1h+' 1h labels · '+d.counts.eqh1h+' EQH/EQL</span></div>'
       + '<div class=card><span class=muted>Filtered</span><b>'+(d.skips.no1mPivot+d.skips.band+d.skips.vsa+d.skips.eqh)+'</b><span class=muted>band '+d.skips.band+' · VSA '+d.skips.vsa+' · EQH '+d.skips.eqh+'</span></div>'
       + '</div>';
     h += '<table><tr><th>Bucket</th><th>Trades</th><th>WR</th><th>Net</th><th>/trade</th><th>PF</th></tr>'
       + row('ALL',S.all)+row('LONGS',S.longs)+row('SHORTS',S.shorts)+'</table>';
     if(d.trades.length){
       h += '<table><tr><th>Side</th><th>Entry</th><th>Entry time (UTC)</th><th>Exit</th><th>R %</th></tr>'
         + d.trades.map(t=>'<tr><td>'+t.side+'</td><td>'+t.entry+'</td><td>'+t.entryT.slice(0,16).replace('T',' ')+'</td><td>'+t.exit+'</td><td class="'+(t.r>=0?'win':'loss')+'">'+(t.r>=0?'+':'')+t.r+'%</td></tr>').join('')
         + '</table>';
     }
     $('out').innerHTML = h;
   }catch(e){ $('err').textContent='Request failed: '+e.message; }
   finally{ $('go').disabled=false; $('go').textContent='Run backtest'; }
 };
</script></body></html>`;

module.exports = router;
