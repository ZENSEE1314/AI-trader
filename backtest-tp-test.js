// Test TP1 variants + deep-dive on "almost TP1" losses

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','LINKUSDT','LTCUSDT'];
const SL_PCT = { BTCUSDT:0.0025, ETHUSDT:0.002, SOLUSDT:0.002, BNBUSDT:0.003, ADAUSDT:0.002, DOTUSDT:0.002, LINKUSDT:0.003, LTCUSDT:0.0025 };
const TP2_PCT=0.010, LOCK_PCT=0.0025, RISK=20, BARS_15M=2000;
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

// Simulate with configurable TP1, also track tick-by-tick MAE for deep analysis
function simulate(dir, entry, slPct, tp1Pct, bars, fromIdx, trackDeep=false) {
  const sl  = dir==='LONG' ? entry*(1-slPct)    : entry*(1+slPct);
  const tp1 = dir==='LONG' ? entry*(1+tp1Pct)   : entry*(1-tp1Pct);
  const tp2 = dir==='LONG' ? entry*(1+TP2_PCT)  : entry*(1-TP2_PCT);
  const lock= dir==='LONG' ? entry*(1+LOCK_PCT) : entry*(1-LOCK_PCT);
  let tp1Hit=false, lockedIn=false, mfe=0, mae=0;
  // Track: after going adversely past SL, did price RECOVER to green before expiry?
  let wentPastSL=false, recoveredAfterSLBreach=false, deepestAdverse=0;

  for(let i=fromIdx; i<Math.min(fromIdx+96,bars.length); i++){
    const b=bars[i];
    if(dir==='LONG'){
      mfe=Math.max(mfe,(b.h-entry)/entry);
      mae=Math.max(mae,(entry-b.l)/entry);
      if(mae>=slPct){ wentPastSL=true; deepestAdverse=Math.max(deepestAdverse,mae); }
      if(wentPastSL && b.h>entry) recoveredAfterSLBreach=true;
      if(!tp1Hit&&b.h>=tp1)tp1Hit=true;
      if(tp1Hit&&b.h>=lock)lockedIn=true;
      if(tp1Hit&&b.h>=tp2)return{outcome:'TP2',r:+3,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse};
      if(lockedIn&&b.l<=lock)return{outcome:'BE',r:+1,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse};
      if(b.l<=sl)return tp1Hit?{outcome:'BE',r:+1,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse}:{outcome:'LOSS',r:-1,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse};
    } else {
      mfe=Math.max(mfe,(entry-b.l)/entry);
      mae=Math.max(mae,(b.h-entry)/entry);
      if(mae>=slPct){ wentPastSL=true; deepestAdverse=Math.max(deepestAdverse,mae); }
      if(wentPastSL && b.l<entry) recoveredAfterSLBreach=true;
      if(!tp1Hit&&b.l<=tp1)tp1Hit=true;
      if(tp1Hit&&b.l<=lock)lockedIn=true;
      if(tp1Hit&&b.l<=tp2)return{outcome:'TP2',r:+3,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse};
      if(lockedIn&&b.h>=lock)return{outcome:'BE',r:+1,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse};
      if(b.h>=sl)return tp1Hit?{outcome:'BE',r:+1,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse}:{outcome:'LOSS',r:-1,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse};
    }
  }
  return{outcome:'TO',r:tp1Hit?+1:-1,mfe,mae,wentPastSL,recoveredAfterSLBreach,deepestAdverse};
}

const START_PRICES={BTCUSDT:95000,ETHUSDT:3500,SOLUSDT:200,BNBUSDT:600,ADAUSDT:0.55,DOTUSDT:7,LINKUSDT:18,LTCUSDT:110};

// Build shared trade setups (same entries for all TP1 variants)
const setups=[];
for(const sym of SYMBOLS){
  const slPct=SL_PCT[sym];
  const bars=genBars(BARS_15M,START_PRICES[sym]);
  const seen=new Set();
  for(let i=10;i<bars.length-5;i++){
    if(!inKZ(bars[i].t))continue;
    const sl=bars.slice(0,i+1);
    const ph=getPH(sl),pl=getPL(sl);
    if(ph.length<2||pl.length<2)continue;
    const lH=ph[ph.length-1],pH=ph[ph.length-2],lL=pl[pl.length-1],pL=pl[pl.length-2];
    const t4h=get4H(bars,i);
    let dir=null;
    if(lH.price>pH.price&&lL.price>pL.price&&lL.barTs>lH.barTs&&t4h!=='DOWN')dir='LONG';
    else if(lL.price<pL.price&&lH.price<pH.price&&lH.barTs>lL.barTs&&t4h!=='UP')dir='SHORT';
    if(!dir)continue;
    const pk=`${sym}-${dir==='LONG'?lL.idx:lH.idx}`;
    if(seen.has(pk))continue; seen.add(pk);
    setups.push({sym,dir,slPct,entry:bars[i+1].o,barIdx:i+1,bars});
  }
}

// ── Part 1: TP1 comparison ─────────────────────────────────────────────────
console.log('\n══ TP1 VARIANT COMPARISON ══════════════════════════════════════\n');
const tp1Variants=[0.003, 0.0035, 0.004, 0.005];
const labels     =['0.30% (1.25×SL)','0.35% (1.46×SL)','0.40% (1.67×SL)','0.50% (2.10×SL) ← current'];
for(let v=0;v<tp1Variants.length;v++){
  const tp1=tp1Variants[v];
  const results=setups.map(s=>simulate(s.dir,s.entry,s.slPct,tp1,s.bars,s.barIdx));
  const n=results.length, wins=results.filter(r=>r.r>0).length;
  const totalR=results.reduce((s,r)=>s+r.r,0);
  const pnl=totalR*RISK;
  const avgR=(totalR/n).toFixed(3);
  console.log(`TP1=${labels[v]}`);
  console.log(`  trades=${n}  win=${Math.round(wins/n*100)}%  avgR=${avgR}R  netPnl=${pnl>=0?'+':''}$${pnl.toFixed(0)}  capital=$${(1000+pnl).toFixed(0)}`);
  console.log('');
}

// ── Part 2: SL depth analysis on the "175 near-TP1" losses ────────────────
console.log('══ SL DEPTH — the 175 losses that almost reached TP1 ══════════\n');
const current_tp1=0.005;
const detailed=setups.map(s=>({...s,...simulate(s.dir,s.entry,s.slPct,current_tp1,s.bars,s.barIdx,true)}));
const nearTP1losses=detailed.filter(t=>t.r<0&&t.mfe>=t.slPct);

console.log(`Near-TP1 losses (MFE >= SL but didn't win): ${nearTP1losses.length} trades\n`);

// How deep past SL did they go?
const buckets=[
  { label:'SL to SL+0.05%  (just tickled SL)', fn: t=>t.deepestAdverse>=t.slPct&&t.deepestAdverse<t.slPct+0.0005 },
  { label:'SL+0.05% to SL+0.10%               ', fn: t=>t.deepestAdverse>=t.slPct+0.0005&&t.deepestAdverse<t.slPct+0.001 },
  { label:'SL+0.10% to SL+0.20%               ', fn: t=>t.deepestAdverse>=t.slPct+0.001&&t.deepestAdverse<t.slPct+0.002 },
  { label:'SL+0.20% to SL+0.50%               ', fn: t=>t.deepestAdverse>=t.slPct+0.002&&t.deepestAdverse<t.slPct+0.005 },
  { label:'SL+0.50%+  (blown way through)      ', fn: t=>t.deepestAdverse>=t.slPct+0.005 },
  { label:'Never hit SL at all (MFE>=SL but MAE<SL) — TP never reached', fn: t=>t.deepestAdverse<t.slPct },
];
for(const b of buckets){
  const n=nearTP1losses.filter(b.fn).length;
  const bar='█'.repeat(Math.round(n/nearTP1losses.length*30));
  console.log(`  ${b.label}: ${String(n).padStart(3)} (${String(Math.round(n/nearTP1losses.length*100)).padStart(2)}%)  ${bar}`);
}

const recovered=nearTP1losses.filter(t=>t.recoveredAfterSLBreach).length;
console.log(`\n  Of those that went past SL: ${recovered}/${nearTP1losses.filter(t=>t.wentPastSL).length} recovered back to green before expiry`);
console.log(`  → If SL had 10% more room (avg +${(0.24*0.1).toFixed(3)}%), extra saves: ${nearTP1losses.filter(t=>t.deepestAdverse>=t.slPct&&t.deepestAdverse<t.slPct*1.1).length}`);
console.log(`  → If SL had 25% more room (avg +${(0.24*0.25).toFixed(3)}%), extra saves: ${nearTP1losses.filter(t=>t.deepestAdverse>=t.slPct&&t.deepestAdverse<t.slPct*1.25).length}`);
console.log(`  → If SL had 50% more room (avg +${(0.24*0.5).toFixed(3)}%), extra saves: ${nearTP1losses.filter(t=>t.deepestAdverse>=t.slPct&&t.deepestAdverse<t.slPct*1.5).length}`);
