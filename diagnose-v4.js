'use strict';
const fetch = require('node-fetch');
const https = require('https');
const AGENT = new https.Agent({ rejectUnauthorized: false });
const SW1=100,SW15=100,RISK=0.25;
const SYMS=['BTCUSDT','ETHUSDT','BNBUSDT','ADAUSDT','SOLUSDT'];
const LEV={BTCUSDT:100,ETHUSDT:100,BNBUSDT:100,ADAUSDT:75,SOLUSDT:75};
const BYBIT='https://api.bybit.com/v5/market/kline';
const MIN_DIST_SIGMA=0.5;
const MAX_GAP_1M_PCT=0.5;

function goodDist(price,lo,std){ return std>0 && (price-lo)/std >= MIN_DIST_SIGMA; }
function goodGap(a,b){ if(a===null||b===null) return false; return Math.abs(a-b)/b*100 <= MAX_GAP_1M_PCT; }

async function get(sym,iv,lim,end){
  const p={category:'linear',symbol:sym,interval:String(iv),limit:String(Math.min(lim,1000))};
  if(end) p.end=String(end);
  const r=await fetch(`${BYBIT}?${new URLSearchParams(p)}`,{agent:AGENT});
  const j=await r.json();
  if(j.retCode!==0) throw new Error(j.retMsg);
  return j.result.list.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).sort((a,b)=>a.t-b.t);
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

// ── Section 1: ETH raw signals (before any filter) ────────────
async function diagETH(){
  console.log('\n'+'#'.repeat(62));
  console.log(' ETH DIAGNOSIS — raw signals before dist filter');
  console.log('#'.repeat(62));

  const r1=await getMany('ETHUSDT',1,12000);
  const r15=await getMany('ETHUSDT',15,700);
  const c15=r15.slice(0,-1),c1=r1.slice(0,-1);
  console.log(` 1m:${c1.length}  15m:${c15.length}`);

  let sh2=null,sh1=null,sl2=null,sl1=null,lt15=0;
  for(let i=SW15;i<c15.length-SW15;i++){
    const p=pivot(c15.slice(0,i+SW15+1),SW15);
    if(p&&p.b.t!==lt15){lt15=p.b.t;if(p.H){sh2=sh1;sh1=p.b.h;}if(p.L){sl2=sl1;sl1=p.b.l;}}
  }

  let sh1m2=null,sh1m1=null,sl1m2=null,sl1m1=null,lt1=0,nextIdx=0;
  const raw=[];

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

    const dist=(bar.c-v.lo)/v.std;
    const gap=sl1m1&&sl1m2?Math.abs(sl1m1-sl1m2)/sl1m2*100:null;
    const gapOk=goodGap(sl1m1,sl1m2);
    const distOk=goodDist(bar.c,v.lo,v.std);
    const ts=new Date(bar.t).toISOString().slice(0,16).replace('T',' ');
    raw.push({ts,type,dist:dist.toFixed(3),distOk,gap:gap?.toFixed(3)||'n/a',gapOk,std:v.std.toFixed(4),lo:v.lo.toFixed(2),price:bar.c.toFixed(2)});
    if(!distOk||!gapOk) nextIdx=idx+SW1; // still skip to avoid double count
    else nextIdx=idx+SW1;
  }

  // Distribution of dist values
  const dists=raw.map(r=>parseFloat(r.dist)).sort((a,b)=>a-b);
  console.log(`\n Total raw signals (pre-filter): ${raw.length}`);
  if(dists.length){
    const pct=(v,arr)=>arr.filter(x=>x>=v).length;
    console.log(` Dist distribution (σ above lower band):`);
    console.log(`   min=${dists[0].toFixed(3)}  max=${dists[dists.length-1].toFixed(3)}  median=${dists[Math.floor(dists.length/2)].toFixed(3)}`);
    for(const threshold of [0.1,0.2,0.3,0.4,0.5,0.7,1.0]){
      console.log(`   >= ${threshold}σ : ${pct(threshold,dists)} signals (${(pct(threshold,dists)/dists.length*100).toFixed(0)}%)`);
    }
  }

  console.log(`\n TIME(UTC)           TYPE     PRICE     LO_BAND   STD      DIST_σ  DIST_OK  GAP%    GAP_OK`);
  console.log(' '+'-'.repeat(88));
  for(const r of raw){
    console.log(` ${r.ts.padEnd(21)} ${r.type.padEnd(9)} ${r.price.padEnd(10)} ${r.lo.padEnd(10)} ${r.std.padEnd(9)} ${r.dist.padEnd(8)} ${String(r.distOk).padEnd(9)} ${r.gap.padEnd(8)} ${r.gapOk}`);
  }
}

// ── Section 2: All losses across all symbols ──────────────────
async function diagLosses(){
  console.log('\n\n'+'#'.repeat(62));
  console.log(' ALL LOSSES — pattern analysis');
  console.log('#'.repeat(62));

  const allLosses=[];

  for(const sym of SYMS){
    const lev=LEV[sym]||100,slPct=RISK/lev;
    console.log(`\n Fetching ${sym}...`);
    const r1=await getMany(sym,1,12000);
    const r15=await getMany(sym,15,700);
    const c15=r15.slice(0,-1),c1=r1.slice(0,-1);

    let sh2=null,sh1=null,sl2=null,sl1=null,lt15=0;
    for(let i=SW15;i<c15.length-SW15;i++){
      const p=pivot(c15.slice(0,i+SW15+1),SW15);
      if(p&&p.b.t!==lt15){lt15=p.b.t;if(p.H){sh2=sh1;sh1=p.b.h;}if(p.L){sl2=sl1;sl1=p.b.l;}}
    }

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

      if(!goodDist(bar.c,v.lo,v.std)) continue;
      if(!goodGap(sl1m1,sl1m2)) continue;

      const nextBar=c1[idx+1];
      const entry=nextBar.o;
      const slP=entry*(1-slPct);
      const tpP=entry*(1+slPct*2);
      nextIdx=idx+SW1;

      let out='OPEN',barsHeld=null;
      for(let f=idx+1;f<Math.min(idx+700,c1.length);f++){
        const fb=c1[f];
        if(fb.l<=slP){out='LOSS';barsHeld=f-idx;break;}
        if(fb.h>=tpP){out='WIN';barsHeld=f-idx;break;}
      }
      if(out!=='LOSS') continue;

      const dist=((bar.c-v.lo)/v.std).toFixed(2);
      const gap=sl1m1&&sl1m2?(Math.abs(sl1m1-sl1m2)/sl1m2*100).toFixed(3):'n/a';
      const ts=new Date(bar.t).toISOString().slice(0,16).replace('T',' ');
      const hour=new Date(bar.t).getUTCHours();

      // What happened after entry — check the bars leading to SL hit
      const lossBar=c1[idx+barsHeld];
      const worstDrop=((entry-lossBar.l)/entry*100).toFixed(2);

      // How far price went UP before SL (max favourable excursion)
      let maxUp=0;
      for(let f=idx+1;f<=idx+barsHeld;f++){
        const up=(c1[f].h-entry)/entry*100;
        if(up>maxUp) maxUp=up;
      }

      allLosses.push({sym,ts,hour,type,z,entry:entry.toFixed(5),dist,gap,slPct:(slPct*100).toFixed(3),barsHeld,worstDrop,maxUp:maxUp.toFixed(2)});
    }
  }

  console.log(`\n Total losses: ${allLosses.length}`);
  console.log(`\n LOSS BREAKDOWN:`);
  console.log(` SYM        TIME(UTC)           HOUR  TYPE   ZONE   DIST_σ  GAP%    BARS  MAX_UP%  WORST_DROP%`);
  console.log(' '+'-'.repeat(92));
  for(const L of allLosses){
    console.log(` ${L.sym.padEnd(10)} ${L.ts.padEnd(21)} ${String(L.hour).padEnd(6)} ${L.type.padEnd(7)} ${L.z.padEnd(7)} ${L.dist.padEnd(8)} ${L.gap.padEnd(8)} ${String(L.barsHeld).padEnd(6)} ${L.maxUp.padEnd(9)} ${L.worstDrop}`);
  }

  // Pattern analysis
  const hourBuckets={};
  const distBuckets={low:0,mid:0,high:0};
  const maxUpBuckets={never:0,small:0,medium:0};
  for(const L of allLosses){
    hourBuckets[L.hour]=(hourBuckets[L.hour]||0)+1;
    const d=parseFloat(L.dist);
    if(d<0.7) distBuckets.low++;
    else if(d<1.5) distBuckets.mid++;
    else distBuckets.high++;
    const mu=parseFloat(L.maxUp);
    if(mu<0.05) maxUpBuckets.never++;
    else if(mu<0.1) maxUpBuckets.small++;
    else maxUpBuckets.medium++;
  }

  console.log(`\n PATTERN — Hour of loss:`);
  const hours=Object.entries(hourBuckets).sort((a,b)=>b[1]-a[1]);
  for(const [h,c] of hours) console.log(`   UTC ${String(h).padStart(2,'0')}:00 — ${c} loss(es)`);

  console.log(`\n PATTERN — VWAP dist at time of loss:`);
  console.log(`   0.5–0.7σ (just inside): ${distBuckets.low}`);
  console.log(`   0.7–1.5σ (mid zone):    ${distBuckets.mid}`);
  console.log(`   >1.5σ   (deep zone):    ${distBuckets.high}`);

  console.log(`\n PATTERN — Max favourable move before SL hit:`);
  console.log(`   Never moved up >0.05% (immediate reversal): ${maxUpBuckets.never}`);
  console.log(`   Moved 0.05–0.1% up then reversed:           ${maxUpBuckets.small}`);
  console.log(`   Moved >0.1% up then reversed:               ${maxUpBuckets.medium}`);
}

async function main(){
  await diagETH();
  await diagLosses();
}
main().catch(console.error);
