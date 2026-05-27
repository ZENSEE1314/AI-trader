// SL sweep + entry proximity analysis
// Tests SL at 0.5x / 0.75x / 1x / 1.25x / 1.5x / 2x of base SL
// Also measures: how far is entry price from the actual 1m pivot level?

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','LINKUSDT','LTCUSDT'];
const BASE_SL = { BTCUSDT:0.0025, ETHUSDT:0.002, SOLUSDT:0.002, BNBUSDT:0.003, ADAUSDT:0.002, DOTUSDT:0.002, LINKUSDT:0.003, LTCUSDT:0.0025 };
const TP1_PCT=0.003, TP2_PCT=0.010, LOCK_PCT=0.0025, RISK=20, BARS_15M=2000;
const BASE_TS = new Date('2026-01-05T07:00:00Z').getTime();

function genBars(n, p0, drift=0.0001, vol=0.008) {
  const bars=[]; let p=p0;
  for(let i=0;i<n;i++){
    const ts=BASE_TS-(n-1-i)*15*60_000;
    const r=drift+vol*(Math.random()+Math.random()+Math.random()+Math.random()-2)/2;
    const o=p, c=p*(1+r), hi=Math.max(o,c)*(1+Math.random()*vol*0.5), lo=Math.min(o,c)*(1-Math.random()*vol*0.5);
    bars.push({t:ts,o,h:hi,l:lo,c}); p=c;
  }
  return bars;
}
// Expand 15m to 1m (4 sub-bars)
function expand1m(bars15m) {
  const out=[];
  for(const b of bars15m){
    const step=(b.c-b.o)/4;
    for(let j=0;j<4;j++){
      const o2=b.o+step*j, c2=b.o+step*(j+1);
      const hi=Math.max(o2,c2)*(1+Math.random()*0.001);
      const lo=Math.min(o2,c2)*(1-Math.random()*0.001);
      out.push({t:b.t+j*60_000,o:o2,h:hi,l:lo,c:c2});
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

function simulate(dir, entry, slPct, bars, fromIdx) {
  const sl  = dir==='LONG' ? entry*(1-slPct)    : entry*(1+slPct);
  const tp1 = dir==='LONG' ? entry*(1+TP1_PCT)  : entry*(1-TP1_PCT);
  const tp2 = dir==='LONG' ? entry*(1+TP2_PCT)  : entry*(1-TP2_PCT);
  const lock= dir==='LONG' ? entry*(1+LOCK_PCT) : entry*(1-LOCK_PCT);
  let tp1Hit=false, lockedIn=false;
  for(let i=fromIdx;i<Math.min(fromIdx+96,bars.length);i++){
    const b=bars[i];
    if(dir==='LONG'){
      if(!tp1Hit&&b.h>=tp1)tp1Hit=true;
      if(tp1Hit&&b.h>=lock)lockedIn=true;
      if(tp1Hit&&b.h>=tp2)return+3;
      if(lockedIn&&b.l<=lock)return+1;
      if(b.l<=sl)return tp1Hit?+1:-1;
    }else{
      if(!tp1Hit&&b.l<=tp1)tp1Hit=true;
      if(tp1Hit&&b.l<=lock)lockedIn=true;
      if(tp1Hit&&b.l<=tp2)return+3;
      if(lockedIn&&b.h>=lock)return+1;
      if(b.h>=sl)return tp1Hit?+1:-1;
    }
  }
  return tp1Hit?+1:-1;
}

const START_PRICES={BTCUSDT:95000,ETHUSDT:3500,SOLUSDT:200,BNBUSDT:600,ADAUSDT:0.55,DOTUSDT:7,LINKUSDT:18,LTCUSDT:110};
const WINDOW_MS=2*3600*1000;

// Build setups with 1m pivot matching (like production bot)
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
    let dir=null, pivot15price=0;

    if(lH.price>pH.price&&lL.price>pL.price&&lL.barTs>lH.barTs&&t4h!=='DOWN'){
      dir='LONG'; pivot15price=lL.price; // HL pivot
    } else if(lL.price<pL.price&&lH.price<pH.price&&lH.barTs>lL.barTs&&t4h!=='UP'){
      dir='SHORT'; pivot15price=lH.price; // LH pivot
    }
    if(!dir)continue;
    const pk=`${sym}-${dir==='LONG'?lL.idx:lH.idx}`;
    if(seen.has(pk))continue; seen.add(pk);

    // Find best 1m pivot near the 15m pivot level (like production)
    const nowTs=bars15[i].t;
    const pivotBarTs=dir==='LONG'?lL.barTs:lH.barTs;
    const sl1m=bars1m.filter(b=>b.t<=nowTs);
    const ph1=getPH(sl1m), pl1=getPL(sl1m);
    let pivot1m=null;

    if(dir==='SHORT'){
      for(let j=ph1.length-1;j>=0;j--){
        const diff=ph1[j].barTs-pivotBarTs;
        if(diff<0)break;
        if(diff>WINDOW_MS)continue;
        const lvlDiff=Math.abs(ph1[j].price-pivot15price)/pivot15price;
        if(lvlDiff>baseSL*2)continue;
        if(!pivot1m||ph1[j].price>pivot1m.price)pivot1m=ph1[j];
      }
    } else {
      for(let j=pl1.length-1;j>=0;j--){
        const diff=pl1[j].barTs-pivotBarTs;
        if(diff<0)break;
        if(diff>WINDOW_MS)continue;
        const lvlDiff=Math.abs(pl1[j].price-pivot15price)/pivot15price;
        if(lvlDiff>baseSL*2)continue;
        if(!pivot1m||pl1[j].price<pivot1m.price)pivot1m=pl1[j];
      }
    }
    if(!pivot1m)continue;

    // Check 1m freshness (≤30 bars old)
    const nowIdx1m=sl1m.length-1;
    const age1m=nowIdx1m-pivot1m.idx;
    if(age1m>30)continue;

    const entry=bars15[i+1].o;
    // Entry proximity: how far is entry from the 1m pivot?
    const entryDrift=(dir==='LONG')
      ? (entry-pivot1m.price)/pivot1m.price   // positive = entered above HL (chased)
      : (pivot1m.price-entry)/pivot1m.price;  // positive = entered below LH (chased)

    setups.push({sym,dir,baseSL,entry,pivot15price,pivot1mPrice:pivot1m.price,entryDrift,barIdx15:i+1,bars:bars15});
  }
}

console.log('\n══ SL MULTIPLIER SWEEP (TP1=0.30%) ════════════════════════════\n');
const mults=[0.5,0.75,1.0,1.25,1.5,2.0];
for(const m of mults){
  let totalR=0, wins=0, n=setups.length;
  for(const s of setups){
    const slPct=s.baseSL*m;
    const r=simulate(s.dir,s.entry,slPct,s.bars,s.barIdx15);
    if(r>0)wins++;
    totalR+=r;
  }
  const pnl=totalR*RISK;
  const avgR=(totalR/n).toFixed(3);
  const winPct=Math.round(wins/n*100);
  console.log(`SL ×${m.toFixed(2)} (avg ${(0.0022*m*100).toFixed(3)}%)  win=${winPct}%  avgR=${avgR}R  pnl=${pnl>=0?'+':''}$${pnl.toFixed(0)}  capital=$${(1000+pnl).toFixed(0)}`);
}

console.log('\n══ ENTRY PROXIMITY — how far from HL/LH pivot does bot enter? ══\n');
const drifts=setups.map(s=>s.entryDrift*100);
const avgDrift=drifts.reduce((a,b)=>a+b,0)/drifts.length;
const medianDrift=[...drifts].sort((a,b)=>a-b)[Math.floor(drifts.length/2)];

console.log(`Total trades with 1m pivot match: ${setups.length}`);
console.log(`Avg entry drift from pivot  : ${avgDrift.toFixed(3)}%  (positive = chasing above/below pivot)`);
console.log(`Median entry drift          : ${medianDrift.toFixed(3)}%`);
console.log('');
const buckets=[
  {label:'Entry AT pivot  (within 0.05%)',  fn:d=>Math.abs(d)<=0.05},
  {label:'Entry 0.05–0.10% past pivot    ',  fn:d=>d>0.05&&d<=0.10},
  {label:'Entry 0.10–0.20% past pivot    ',  fn:d=>d>0.10&&d<=0.20},
  {label:'Entry 0.20–0.50% past pivot    ',  fn:d=>d>0.20&&d<=0.50},
  {label:'Entry >0.50% past pivot (late) ',  fn:d=>d>0.50},
  {label:'Entry BEFORE pivot (early)     ',  fn:d=>d<-0.05},
];
for(const b of buckets){
  const n=setups.filter(s=>b.fn(s.entryDrift*100)).length;
  const pct=Math.round(n/setups.length*100);
  const bar='█'.repeat(Math.round(pct/2));
  console.log(`  ${b.label}: ${String(n).padStart(3)} (${String(pct).padStart(2)}%)  ${bar}`);
}

console.log('\n── Win rate by entry proximity ──');
for(const b of buckets){
  const grp=setups.filter(s=>b.fn(s.entryDrift*100));
  if(grp.length===0)continue;
  const wins=grp.filter(s=>{
    const r=simulate(s.dir,s.entry,s.baseSL,s.bars,s.barIdx15);
    return r>0;
  }).length;
  console.log(`  ${b.label}: win=${Math.round(wins/grp.length*100)}%  (n=${grp.length})`);
}

console.log('\n── What causes reversals after entry ──');
const longs=setups.filter(s=>s.dir==='LONG');
const shorts=setups.filter(s=>s.dir==='SHORT');
const avgSLprice=(s)=>s.dir==='LONG'?s.entry*(1-s.baseSL):s.entry*(1+s.baseSL);
// How far is HL/LH pivot from entry's SL?
const pivotToSL=setups.map(s=>{
  const sl=avgSLprice(s);
  return s.dir==='LONG'
    ? (s.pivot1mPrice-sl)/sl*100   // pivot above SL? should be
    : (sl-s.pivot1mPrice)/sl*100;  // pivot below SL? should be
});
const avgPivotToSL=pivotToSL.reduce((a,b)=>a+b,0)/pivotToSL.length;
console.log(`Avg distance: 1m pivot → SL = ${avgPivotToSL.toFixed(3)}%`);
console.log(`  (negative = SL is ABOVE the HL pivot → SL placed on wrong side of pivot!)`);
const wrongSide=pivotToSL.filter(d=>d<0).length;
console.log(`  SL on wrong side of pivot: ${wrongSide}/${setups.length} trades (${Math.round(wrongSide/setups.length*100)}%)`);
