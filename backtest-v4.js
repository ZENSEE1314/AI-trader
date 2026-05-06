'use strict';
const fetch = require('node-fetch');
const https = require('https');
const AGENT = new https.Agent({ rejectUnauthorized: false });
const SW1=100,SW15=100,RISK=0.25;
const SYMS=['BTCUSDT','ETHUSDT','BNBUSDT','ADAUSDT','SOLUSDT'];
const LEV={BTCUSDT:100,ETHUSDT:100,BNBUSDT:100,ADAUSDT:75,SOLUSDT:75};
// Try CDN endpoint first; fallback list for ISP blocks
const BYBIT_ENDPOINTS=[
  'https://api.bytick.com/v5/market/kline',
  'https://api.bybit.nl/v5/market/kline',
  'https://api.bybit.com/v5/market/kline',
];
let BYBIT=BYBIT_ENDPOINTS[0];

// ── FILTERS (must match strategy-v4-smc.js) ────────────────────
const MIN_DIST_SIGMA = 0.5; // price must be ≥ 0.5σ above lower band
const MAX_GAP_1M_PCT = 0.5; // 1m HL/LL gap must be ≤ 0.5%

function goodDist(price,lo,std){ return std>0 && (price-lo)/std >= MIN_DIST_SIGMA; }
function goodGap(a,b){ if(a===null||b===null) return false; return Math.abs(a-b)/b*100 <= MAX_GAP_1M_PCT; }

async function get(sym,iv,lim,end){
  const p={category:'linear',symbol:sym,interval:String(iv),limit:String(Math.min(lim,1000))};
  if(end) p.end=String(end);
  const qs=new URLSearchParams(p);
  let lastErr;
  for(const ep of BYBIT_ENDPOINTS){
    try{
      const r=await fetch(`${ep}?${qs}`,{agent:AGENT});
      const text=await r.text();
      const j=JSON.parse(text);
      if(j.retCode!==0) throw new Error(j.retMsg);
      if(ep!==BYBIT){ BYBIT=ep; console.log(` [DNS] switched to ${ep}`); }
      return j.result.list.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).sort((a,b)=>a.t-b.t);
    }catch(e){ lastErr=e; }
  }
  throw lastErr;
}

async function getMany(sym,iv,tot){
  let all=[],end=null;
  for(let p=0;p<Math.ceil(tot/1000);p++){
    const b=await get(sym,iv,1000,end);
    if(!b.length) break;
    end=b[0].t-1; all=[...b,...all];
    await new Promise(r=>setTimeout(r,350));
  }
  const s=new Set();
  return all.filter(b=>s.has(b.t)?false:s.add(b.t)).sort((a,b)=>a.t-b.t);
}

function calcVwap(c15,ms){
  const ds=new Date(ms); ds.setUTCHours(0,0,0,0);
  const bars=c15.filter(c=>c.t>=ds.getTime()&&c.t<ms);
  if(bars.length<2) return null;
  let tv=0,tv2=0,vol=0;
  for(const c of bars){const tp=(c.h+c.l+c.c)/3;tv+=tp*c.v;tv2+=tp*tp*c.v;vol+=c.v;}
  if(!vol) return null;
  const vw=tv/vol,std=Math.sqrt(Math.max(0,tv2/vol-vw*vw));
  return {vw,up:vw+2*std,lo:vw-2*std,std};
}

function getZone(price,v){
  if(price>v.up) return 'ABOVE';
  if(price>v.vw) return 'UPPER';
  if(price>=v.lo) return 'LOWER';
  return 'BELOW';
}

function pivot(arr,sw){
  const n=arr.length;
  if(n<2*sw+1) return null;
  const i=n-1-sw,b=arr[i];
  let H=true,L=true;
  for(let j=1;j<=sw;j++){
    if(b.h<=arr[i-j].h||b.h<=arr[i+j].h) H=false;
    if(b.l>=arr[i-j].l||b.l>=arr[i+j].l) L=false;
  }
  return {H,L,b};
}

async function run(sym){
  const lev=LEV[sym]||100,slPct=RISK/lev;
  console.log('\n'+'='.repeat(62));
  console.log(` ${sym} | ${lev}x | Filters: dist+gap`);
  console.log('='.repeat(62));
  console.log(' Fetching 7d data...');

  const r1=await getMany(sym,1,12000);
  const r15=await getMany(sym,15,700);
  console.log(` 1m:${r1.length} (${(r1.length/1440).toFixed(1)}d)  15m:${r15.length}`);
  if(r1.length<2*SW1+10){console.log(' Not enough data');return null;}

  const c15=r15.slice(0,-1),c1=r1.slice(0,-1);

  let sh2=null,sh1=null,sl2=null,sl1=null,lt15=0;
  for(let i=SW15;i<c15.length-SW15;i++){
    const p=pivot(c15.slice(0,i+SW15+1),SW15);
    if(p&&p.b.t!==lt15){lt15=p.b.t;if(p.H){sh2=sh1;sh1=p.b.h;}if(p.L){sl2=sl1;sl1=p.b.l;}}
  }

  const trades=[];
  let skippedDist=0,skippedGap=0;
  let sh1m2=null,sh1m1=null,sl1m2=null,sl1m1=null,lt1=0,nextIdx=0;

  for(let idx=SW1;idx<c1.length-1;idx++){
    if(idx<nextIdx) continue;
    const bar=c1[idx];
    const slice=c1.slice(Math.max(0,idx-SW1*2),idx+1);
    const p=pivot(slice,SW1);
    if(p&&p.b.t!==lt1){
      lt1=p.b.t;
      if(p.H){sh1m2=sh1m1;sh1m1=p.b.h;}
      if(p.L){sl1m2=sl1m1;sl1m1=p.b.l;}
    }
    if(!p) continue;

    const v=calcVwap(c15,bar.t);
    if(!v) continue;
    const z=getZone(bar.c,v);

    const hl15=sl1!==null&&sl2!==null&&sl1>sl2;
    const ll15=sl1!==null&&sl2!==null&&sl1<sl2;
    const hl1m=sl1m1!==null&&sl1m2!==null&&sl1m1>sl1m2;
    const ll1m=sl1m1!==null&&sl1m2!==null&&sl1m1<sl1m2;

    let type=null;
    if(z==='LOWER'&&hl15&&hl1m) type='HL+HL';
    if(z==='BELOW'&&ll15&&ll1m) type='LL+LL';
    if(!type) continue;

    // ── Apply 2 filters ──────────────────────────────────────
    // Dist filter only for LOWER_MID — BELOW_LOWER price is already below band by design
    if(z==='LOWER' && !goodDist(bar.c, v.lo, v.std)) { skippedDist++; continue; }
    if(!goodGap(sl1m1,sl1m2))             { skippedGap++;  continue; }

    // Enter next candle open
    const nextBar=c1[idx+1];
    const entry=nextBar.o;
    const slP=entry*(1-slPct);
    const tpP=entry*(1+slPct*2);
    nextIdx=idx+SW1;

    let out='OPEN',barsToClose=null;
    for(let f=idx+1;f<Math.min(idx+700,c1.length);f++){
      const fb=c1[f];
      if(fb.l<=slP){out='LOSS';barsToClose=f-idx;break;}
      if(fb.h>=tpP){out='WIN';barsToClose=f-idx;break;}
    }

    const pnl=out==='WIN'?slPct*2*lev*100:out==='LOSS'?-slPct*lev*100:0;
    const ts=new Date(bar.t).toISOString().slice(0,16).replace('T',' ');
    const hourUTC=new Date(bar.t).getUTCHours();
    const dist=((bar.c-v.lo)/v.std).toFixed(2);
    const gap=sl1m1&&sl1m2?(Math.abs(sl1m1-sl1m2)/sl1m2*100).toFixed(3):'n/a';
    trades.push({ts,z,type,entry,slP,tpP,out,pnl,hourUTC,dist,gap,barsToClose});
  }

  const closed=trades.filter(t=>t.out!=='OPEN');
  const wins=closed.filter(t=>t.out==='WIN').length;
  const losses=closed.filter(t=>t.out==='LOSS').length;
  const wr=closed.length?wins/closed.length*100:0;
  const total=closed.reduce((s,t)=>s+t.pnl,0);

  console.log(` Signals AFTER filters: ${trades.length}  (skipped: dist=${skippedDist} gap=${skippedGap})`);
  console.log(` Wins:${wins}  Losses:${losses}  WR:${wr.toFixed(1)}%  PnL:${total.toFixed(0)}%`);

  console.log('\n TIME(UTC)           TYPE     ENTRY        DIST_σ  GAP1m%   HOUR  RESULT');
  console.log(' '+'-'.repeat(74));
  for(const t of trades){
    const r=t.out==='WIN'?`WIN  +${t.pnl.toFixed(0)}%`:t.out==='LOSS'?`LOSS -${Math.abs(t.pnl).toFixed(0)}%`:'OPEN';
    console.log(` ${t.ts.padEnd(21)} ${t.type.padEnd(9)} ${t.entry.toFixed(5).padEnd(13)} ${String(t.dist).padEnd(8)} ${String(t.gap).padEnd(9)} ${String(t.hourUTC).padEnd(6)} ${r}`);
  }

  return{sym,t:trades.length,w:wins,l:losses,wr,pnl:total,skippedDist,skippedGap};
}

async function main(){
  const arg=process.argv[2]?.toUpperCase();
  const syms=arg&&SYMS.includes(arg)?[arg]:SYMS;
  console.log('\n'+'#'.repeat(62));
  console.log(' V4-SMC | 2 FILTERS ACTIVE | 7 DAYS | LONG ONLY | 2:1 RR');
  console.log(' Filter 1: Price >= 0.5σ above VWAP lower band');
  console.log(' Filter 2: 1m HL/LL gap <= 0.5%');
  console.log('#'.repeat(62));
  const res=[];
  for(const s of syms){
    try{const r=await run(s);if(r)res.push(r);}catch(e){console.log(` ${s} ERR:${e.message}`);}
  }
  console.log('\n'+'='.repeat(62)+'\n SUMMARY — WITH FILTERS vs WITHOUT\n'+'='.repeat(62));
  const noFilter={BTCUSDT:{t:40,w:20,l:17,wr:54.1,pnl:575},ETHUSDT:{t:7,w:4,l:3,wr:57.1,pnl:125},BNBUSDT:{t:48,w:21,l:25,wr:45.7,pnl:425},ADAUSDT:{t:39,w:16,l:23,wr:41.0,pnl:225},SOLUSDT:{t:56,w:34,l:21,wr:61.8,pnl:1175}};
  let tT=0,tW=0,tL=0,tP=0;
  for(const s of res){
    const n=noFilter[s.sym]||{};
    const wrDiff=(s.wr-(n.wr||0)).toFixed(1);
    const pnlDiff=(s.pnl-(n.pnl||0)).toFixed(0);
    console.log(` ${s.sym.padEnd(10)} ${String(s.t).padEnd(4)} signals | WR: ${s.wr.toFixed(1)}% (${wrDiff>=0?'+':''}${wrDiff}%) | PnL: ${s.pnl.toFixed(0)}% (${pnlDiff>=0?'+':''}${pnlDiff}%) | skipped: D=${s.skippedDist} G=${s.skippedGap}`);
    tT+=s.t;tW+=s.w;tL+=s.l;tP+=s.pnl;
  }
  const oWR=tW+tL?tW/(tW+tL)*100:0;
  console.log(` ${'-'.repeat(60)}`);
  console.log(` ALL  ${tT} signals | WR: ${oWR.toFixed(1)}% | PnL: ${tP.toFixed(0)}%`);
  console.log(` Before filters: 190 signals | WR: 51.6% | PnL: +2525%`);
}
main().catch(console.error);
