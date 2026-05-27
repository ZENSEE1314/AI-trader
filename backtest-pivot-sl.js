// Compare: entry-based SL vs pivot-anchored SL
// Current:  SL = entry × (1 ± slPct)
// New:      SL = pivot1m × (1 ± slPct)  → always below/above the actual HL/LH

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','LINKUSDT','LTCUSDT'];
const BASE_SL = { BTCUSDT:0.0025, ETHUSDT:0.002, SOLUSDT:0.002, BNBUSDT:0.003, ADAUSDT:0.002, DOTUSDT:0.002, LINKUSDT:0.003, LTCUSDT:0.0025 };
const TP1_PCT=0.003, TP2_PCT=0.010, LOCK_PCT=0.0025, RISK=20, BARS_15M=2000;
const BASE_TS = new Date('2026-01-05T07:00:00Z').getTime();

function genBars(n, p0, drift=0.0001, vol=0.008) {
  const bars=[]; let p=p0;
  for(let i=0;i<n;i++){
    const ts=BASE_TS-(n-1-i)*15*60_000;
    const r=drift+vol*(Math.random()+Math.random()+Math.random()+Math.random()-2)/2;
    const o=p,c=p*(1+r),hi=Math.max(o,c)*(1+Math.random()*vol*0.5),lo=Math.min(o,c)*(1-Math.random()*vol*0.5);
    bars.push({t:ts,o,h:hi,l:lo,c}); p=c;
  }
  return bars;
}
function expand1m(bars15m) {
  const out=[];
  for(const b of bars15m){
    const step=(b.c-b.o)/4;
    for(let j=0;j<4;j++){
      const o2=b.o+step*j,c2=b.o+step*(j+1);
      out.push({t:b.t+j*60_000,o:o2,h:Math.max(o2,c2)*(1+Math.random()*0.001),l:Math.min(o2,c2)*(1-Math.random()*0.001),c:c2});
    }
  }
  return out;
}
function getPH(bars){const p=[];for(let i=2;i<bars.length-2;i++){if(bars[i].h>bars[i-1].h&&bars[i].h>bars[i-2].h&&bars[i].h>bars[i+1].h&&bars[i].h>bars[i+2].h)p.push({idx:i,price:bars[i].h,barTs:bars[i].t});}return p;}
function getPL(bars){const p=[];for(let i=2;i<bars.length-2;i++){if(bars[i].l<bars[i-1].l&&bars[i].l<bars[i-2].l&&bars[i].l<bars[i+1].l&&bars[i].l<bars[i+2].l)p.push({idx:i,price:bars[i].l,barTs:bars[i].t});}return p;}
function inKZ(ts){const d=new Date(ts),h=d.getUTCHours()+d.getUTCMinutes()/60;return(h>=7&&h<10)||(h>=12&&h<16);}
function get4H(bars,upTo){
  const sl=bars.slice(0,upTo+1);if(sl.length<16)return'NEUTRAL';
  const ph=getPH(sl),pl=getPL(sl);if(ph.length<2||pl.length<2)return'NEUTRAL';
  const lH=ph[ph.length-1],pH=ph[ph.length-2],lL=pl[pl.length-1],pL=pl[pl.length-2];
  if(lH.price>pH.price&&lL.price>pL.price)return'UP';
  if(lL.price<pL.price&&lH.price<pH.price)return'DOWN';
  return'NEUTRAL';
}

function simulate(dir, entry, sl, bars, fromIdx) {
  const tp1 = dir==='LONG' ? entry*(1+TP1_PCT)  : entry*(1-TP1_PCT);
  const tp2 = dir==='LONG' ? entry*(1+TP2_PCT)  : entry*(1-TP2_PCT);
  const lock= dir==='LONG' ? entry*(1+LOCK_PCT) : entry*(1-LOCK_PCT);
  let tp1Hit=false,lockedIn=false,mfe=0,mae=0;
  for(let i=fromIdx;i<Math.min(fromIdx+96,bars.length);i++){
    const b=bars[i];
    if(dir==='LONG'){
      mfe=Math.max(mfe,(b.h-entry)/entry); mae=Math.max(mae,(entry-b.l)/entry);
      if(!tp1Hit&&b.h>=tp1)tp1Hit=true;
      if(tp1Hit&&b.h>=lock)lockedIn=true;
      if(tp1Hit&&b.h>=tp2)return{r:+3,mfe,mae,outcome:'TP2'};
      if(lockedIn&&b.l<=lock)return{r:+1,mfe,mae,outcome:'BE'};
      if(b.l<=sl)return tp1Hit?{r:+1,mfe,mae,outcome:'BE'}:{r:-1,mfe,mae,outcome:'LOSS'};
    }else{
      mfe=Math.max(mfe,(entry-b.l)/entry); mae=Math.max(mae,(b.h-entry)/entry);
      if(!tp1Hit&&b.l<=tp1)tp1Hit=true;
      if(tp1Hit&&b.l<=lock)lockedIn=true;
      if(tp1Hit&&b.l<=tp2)return{r:+3,mfe,mae,outcome:'TP2'};
      if(lockedIn&&b.h>=lock)return{r:+1,mfe,mae,outcome:'BE'};
      if(b.h>=sl)return tp1Hit?{r:+1,mfe,mae,outcome:'BE'}:{r:-1,mfe,mae,outcome:'LOSS'};
    }
  }
  return{r:tp1Hit?+1:-1,mfe,mae,outcome:'TO'};
}

const START_PRICES={BTCUSDT:95000,ETHUSDT:3500,SOLUSDT:200,BNBUSDT:600,ADAUSDT:0.55,DOTUSDT:7,LINKUSDT:18,LTCUSDT:110};
const WINDOW_MS=2*3600*1000;

const setups=[];
for(const sym of SYMBOLS){
  const baseSL=BASE_SL[sym];
  const bars15=genBars(BARS_15M,START_PRICES[sym]);
  const bars1m=expand1m(bars15);
  const seen=new Set();

  for(let i=10;i<bars15.length-5;i++){
    if(!inKZ(bars15[i].t))continue;
    const sl15=bars15.slice(0,i+1);
    const ph=getPH(sl15),pl=getPL(sl15);
    if(ph.length<2||pl.length<2)continue;
    const lH=ph[ph.length-1],pH=ph[ph.length-2],lL=pl[pl.length-1],pL=pl[pl.length-2];
    const t4h=get4H(bars15,i);
    let dir=null,pivot15price=0;
    if(lH.price>pH.price&&lL.price>pL.price&&lL.barTs>lH.barTs&&t4h!=='DOWN'){dir='LONG';pivot15price=lL.price;}
    else if(lL.price<pL.price&&lH.price<pH.price&&lH.barTs>lL.barTs&&t4h!=='UP'){dir='SHORT';pivot15price=lH.price;}
    if(!dir)continue;
    const pk=`${sym}-${dir==='LONG'?lL.idx:lH.idx}`;
    if(seen.has(pk))continue; seen.add(pk);

    const nowTs=bars15[i].t, pivotBarTs=dir==='LONG'?lL.barTs:lH.barTs;
    const sl1m=bars1m.filter(b=>b.t<=nowTs);
    const ph1=getPH(sl1m),pl1=getPL(sl1m);
    let pivot1m=null;
    if(dir==='SHORT'){
      for(let j=ph1.length-1;j>=0;j--){
        const diff=ph1[j].barTs-pivotBarTs; if(diff<0)break; if(diff>WINDOW_MS)continue;
        const ld=Math.abs(ph1[j].price-pivot15price)/pivot15price; if(ld>baseSL*2)continue;
        if(!pivot1m||ph1[j].price>pivot1m.price)pivot1m=ph1[j];
      }
    }else{
      for(let j=pl1.length-1;j>=0;j--){
        const diff=pl1[j].barTs-pivotBarTs; if(diff<0)break; if(diff>WINDOW_MS)continue;
        const ld=Math.abs(pl1[j].price-pivot15price)/pivot15price; if(ld>baseSL*2)continue;
        if(!pivot1m||pl1[j].price<pivot1m.price)pivot1m=pl1[j];
      }
    }
    if(!pivot1m)continue;
    const nowIdx1m=sl1m.length-1, age1m=nowIdx1m-pivot1m.idx;
    if(age1m>30)continue;

    const entry=bars15[i+1].o;
    const entryDrift=dir==='LONG'?(entry-pivot1m.price)/pivot1m.price:(pivot1m.price-entry)/pivot1m.price;

    // Actual $ risk per trade — pivot-SL means risk is entry−sl (not fixed slPct)
    const slEntry  = dir==='LONG' ? entry*(1-baseSL)        : entry*(1+baseSL);
    const slPivot  = dir==='LONG' ? pivot1m.price*(1-baseSL): pivot1m.price*(1+baseSL);

    setups.push({sym,dir,baseSL,entry,pivot1mPrice:pivot1m.price,entryDrift,slEntry,slPivot,barIdx15:i+1,bars:bars15});
  }
}

const pct=v=>(v*100).toFixed(2)+'%';
const avg=(arr,fn)=>arr.length?arr.reduce((s,t)=>s+fn(t),0)/arr.length:0;

console.log('\n══ ENTRY-SL vs PIVOT-SL COMPARISON (TP1=0.30%) ═══════════════\n');

// --- Entry-based SL (current) ---
const entryResults = setups.map(s=>({...simulate(s.dir,s.entry,s.slEntry,s.bars,s.barIdx15), slDist:(s.dir==='LONG'?s.entry-s.slEntry:s.slEntry-s.entry)/s.entry}));
const eWins=entryResults.filter(r=>r.r>0), eLoss=entryResults.filter(r=>r.r<0);
const eTP2=entryResults.filter(r=>r.outcome==='TP2'), eBE=entryResults.filter(r=>r.outcome==='BE');
const eTotalR=entryResults.reduce((s,r)=>s+r.r,0);

console.log(`CURRENT (SL below entry):`);
console.log(`  Trades: ${setups.length}  Win: ${Math.round(eWins.length/setups.length*100)}%  TP2: ${Math.round(eTP2.length/setups.length*100)}%  BE: ${Math.round(eBE.length/setups.length*100)}%  Loss: ${Math.round(eLoss.length/setups.length*100)}%`);
console.log(`  AvgR: ${(eTotalR/setups.length).toFixed(3)}R   NetPnL: ${eTotalR>=0?'+':''}$${(eTotalR*RISK).toFixed(0)}   Capital: $${(1000+eTotalR*RISK).toFixed(0)}`);
console.log(`  Avg SL distance from entry: ${pct(avg(entryResults,r=>r.slDist))}`);

// --- Pivot-based SL (new) ---
// Note: $ risk per trade changes because SL is further from entry
// We keep fixed $ risk by sizing position to the wider SL
const pivotResults = setups.map(s=>{
  const res=simulate(s.dir,s.entry,s.slPivot,s.bars,s.barIdx15);
  const slDist=(s.dir==='LONG'?s.entry-s.slPivot:s.slPivot-s.entry)/s.entry;
  // $ risk stays $20 — position size shrinks proportionally with wider SL
  const rScale = s.baseSL / Math.max(slDist, s.baseSL); // scale R to keep $20 risk
  return {...res, slDist, rScaled: res.r * rScale};
});
const pWins=pivotResults.filter(r=>r.r>0), pLoss=pivotResults.filter(r=>r.r<0);
const pTP2=pivotResults.filter(r=>r.outcome==='TP2'), pBE=pivotResults.filter(r=>r.outcome==='BE');
const pTotalR=pivotResults.reduce((s,r)=>s+r.r,0);
const pTotalRscaled=pivotResults.reduce((s,r)=>s+r.rScaled,0);

console.log(`\nNEW (SL below pivot1m):`);
console.log(`  Trades: ${setups.length}  Win: ${Math.round(pWins.length/setups.length*100)}%  TP2: ${Math.round(pTP2.length/setups.length*100)}%  BE: ${Math.round(pBE.length/setups.length*100)}%  Loss: ${Math.round(pLoss.length/setups.length*100)}%`);
console.log(`  AvgR (raw):    ${(pTotalR/setups.length).toFixed(3)}R   NetPnL: ${pTotalR>=0?'+':''}$${(pTotalR*RISK).toFixed(0)}   Capital: $${(1000+pTotalR*RISK).toFixed(0)}`);
console.log(`  AvgR (scaled $20 risk): ${(pTotalRscaled/setups.length).toFixed(3)}R   NetPnL: ${pTotalRscaled>=0?'+':''}$${(pTotalRscaled*RISK).toFixed(0)}   Capital: $${(1000+pTotalRscaled*RISK).toFixed(0)}`);
console.log(`  Avg SL distance from entry: ${pct(avg(pivotResults,r=>r.slDist))}`);

console.log('\n── Per-symbol breakdown ──────────────────────────────────────');
console.log(`${'Symbol'.padEnd(10)} ${'Entry-SL win%'.padEnd(15)} ${'Pivot-SL win%'.padEnd(15)} ${'Entry-SL pnl'.padEnd(14)} Pivot-SL pnl`);
for(const sym of SYMBOLS){
  const idx=setups.map((s,i)=>s.sym===sym?i:-1).filter(i=>i>=0);
  if(!idx.length)continue;
  const eW=idx.filter(i=>entryResults[i].r>0).length;
  const pW=idx.filter(i=>pivotResults[i].r>0).length;
  const eP=idx.reduce((s,i)=>s+entryResults[i].r,0)*RISK;
  const pP=idx.reduce((s,i)=>s+pivotResults[i].rScaled,0)*RISK;
  console.log(`${sym.padEnd(10)} ${(Math.round(eW/idx.length*100)+'%').padEnd(15)} ${(Math.round(pW/idx.length*100)+'%').padEnd(15)} ${(eP>=0?'+':'')+eP.toFixed(0).padEnd(13)} ${(pP>=0?'+':'-')}$${Math.abs(pP).toFixed(0)}`);
}

console.log('\n── Why reversals happen: entry drift distribution ─────────────');
console.log(`Avg entry drift past pivot: ${pct(avg(setups,s=>s.entryDrift))}`);
const dBuckets=[
  ['≤0.10% drift (good entry)' ,s=>s.entryDrift<=0.001],
  ['0.10–0.25% drift           ',s=>s.entryDrift>0.001&&s.entryDrift<=0.0025],
  ['0.25–0.50% drift           ',s=>s.entryDrift>0.0025&&s.entryDrift<=0.005],
  ['>0.50% drift (very late)   ',s=>s.entryDrift>0.005],
];
for(const [lbl,fn] of dBuckets){
  const grp=setups.filter(fn); if(!grp.length)continue;
  const gi=grp.map(s=>setups.indexOf(s));
  const eW=gi.filter(i=>entryResults[i].r>0).length;
  const pW=gi.filter(i=>pivotResults[i].r>0).length;
  console.log(`  ${lbl}: n=${grp.length}  entry-SL win=${Math.round(eW/grp.length*100)}%  pivot-SL win=${Math.round(pW/grp.length*100)}%`);
}
