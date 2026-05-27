// Diagnostic backtest — same logic as v3, but tracks MFE/MAE per trade
// MFE = Max Favorable Excursion (how far price moved IN your direction before outcome)
// MAE = Max Adverse Excursion (how far price moved AGAINST you before outcome)

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','LINKUSDT','LTCUSDT'];
const SL_PCT = { BTCUSDT:0.0025, ETHUSDT:0.002, SOLUSDT:0.002, BNBUSDT:0.003, ADAUSDT:0.002, DOTUSDT:0.002, LINKUSDT:0.003, LTCUSDT:0.0025 };
const TP1_PCT=0.005, TP2_PCT=0.010, LOCK_PCT=0.0025, RISK=20, BARS_15M=2000;
const BASE_TS = new Date('2026-01-05T07:00:00Z').getTime();

function genBars(n, startPrice, drift=0.0001, vol=0.008) {
  const bars=[]; let price=startPrice;
  for(let i=0;i<n;i++){
    const ts=BASE_TS-(n-1-i)*15*60_000;
    const r=drift+vol*(Math.random()+Math.random()+Math.random()+Math.random()-2)/2;
    const open=price, close=price*(1+r);
    const hi=Math.max(open,close)*(1+Math.random()*vol*0.5);
    const lo=Math.min(open,close)*(1-Math.random()*vol*0.5);
    bars.push({t:ts,o:open,h:hi,l:lo,c:close}); price=close;
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

function simulateDetailed(dir, entry, slPct, bars, fromIdx) {
  const sl  = dir==='LONG' ? entry*(1-slPct)     : entry*(1+slPct);
  const tp1 = dir==='LONG' ? entry*(1+TP1_PCT)   : entry*(1-TP1_PCT);
  const tp2 = dir==='LONG' ? entry*(1+TP2_PCT)   : entry*(1-TP2_PCT);
  const lock= dir==='LONG' ? entry*(1+LOCK_PCT)  : entry*(1-LOCK_PCT);
  let tp1Hit=false, lockedIn=false, mfe=0, mae=0, barsHeld=0;

  for(let i=fromIdx; i<Math.min(fromIdx+96,bars.length); i++){
    const b=bars[i]; barsHeld++;
    if(dir==='LONG'){
      mfe=Math.max(mfe,(b.h-entry)/entry);
      mae=Math.max(mae,(entry-b.l)/entry);
      if(!tp1Hit&&b.h>=tp1)tp1Hit=true;
      if(tp1Hit&&b.h>=lock)lockedIn=true;
      if(tp1Hit&&b.h>=tp2)return{outcome:'TP2',r:+3,mfe,mae,barsHeld};
      if(lockedIn&&b.l<=lock)return{outcome:'BE',r:+1,mfe,mae,barsHeld};
      if(b.l<=sl)return tp1Hit?{outcome:'BE',r:+1,mfe,mae,barsHeld}:{outcome:'LOSS',r:-1,mfe,mae,barsHeld};
    }else{
      mfe=Math.max(mfe,(entry-b.l)/entry);
      mae=Math.max(mae,(b.h-entry)/entry);
      if(!tp1Hit&&b.l<=tp1)tp1Hit=true;
      if(tp1Hit&&b.l<=lock)lockedIn=true;
      if(tp1Hit&&b.l<=tp2)return{outcome:'TP2',r:+3,mfe,mae,barsHeld};
      if(lockedIn&&b.h>=lock)return{outcome:'BE',r:+1,mfe,mae,barsHeld};
      if(b.h>=sl)return tp1Hit?{outcome:'BE',r:+1,mfe,mae,barsHeld}:{outcome:'LOSS',r:-1,mfe,mae,barsHeld};
    }
  }
  return{outcome:'TO',r:tp1Hit?+1:-1,mfe,mae,barsHeld};
}

const START_PRICES={BTCUSDT:95000,ETHUSDT:3500,SOLUSDT:200,BNBUSDT:600,ADAUSDT:0.55,DOTUSDT:7,LINKUSDT:18,LTCUSDT:110};
const allTrades=[];

for(const sym of SYMBOLS){
  const slPct=SL_PCT[sym];
  const bars=genBars(BARS_15M,START_PRICES[sym]);
  const seenPivots=new Set();

  for(let i=10;i<bars.length-5;i++){
    if(!inKZ(bars[i].t))continue;
    const sl=bars.slice(0,i+1);
    const ph=getPH(sl),pl=getPL(sl);
    if(ph.length<2||pl.length<2)continue;
    const lH=ph[ph.length-1],pH=ph[ph.length-2],lL=pl[pl.length-1],pL=pl[pl.length-2];
    const trend=get4H(bars,i);
    let dir=null,label='';

    if(lH.price>pH.price&&lL.price>pL.price&&lL.barTs>lH.barTs&&trend!=='DOWN'){dir='LONG';label='HH→HL';}
    else if(lL.price<pL.price&&lH.price<pH.price&&lH.barTs>lL.barTs&&trend!=='UP'){dir='SHORT';label='LL→LH';}
    if(!dir)continue;
    const pivKey=`${sym}-${dir==='LONG'?lL.idx:lH.idx}`;
    if(seenPivots.has(pivKey))continue;
    seenPivots.add(pivKey);

    const entry=bars[i+1].o;
    const res=simulateDetailed(dir,entry,slPct,bars,i+1);
    allTrades.push({sym,dir,label,entry,slPct,outcome:res.outcome,r:res.r,mfe:res.mfe,mae:res.mae,barsHeld:res.barsHeld});
  }
}

const wins  = allTrades.filter(t=>t.r>0);
const losses= allTrades.filter(t=>t.r<0);
const longs = allTrades.filter(t=>t.dir==='LONG');
const shorts= allTrades.filter(t=>t.dir==='SHORT');

const avg = (arr,fn) => arr.length ? arr.reduce((s,t)=>s+fn(t),0)/arr.length : 0;
const pct  = v => (v*100).toFixed(2)+'%';

console.log('\n══ LOSS DIAGNOSIS ══════════════════════════════════════════\n');
console.log(`Total trades : ${allTrades.length}`);
console.log(`Win rate     : ${Math.round(wins.length/allTrades.length*100)}%`);
console.log(`Loss rate    : ${Math.round(losses.length/allTrades.length*100)}%`);

console.log('\n── MFE on LOSING trades (how far price went your way before SL) ──');
console.log(`  Avg MFE before loss : ${pct(avg(losses,t=>t.mfe))}  (vs SL = avg ${pct(avg(losses,t=>t.slPct))})`);
console.log(`  >50% of SL moved    : ${losses.filter(t=>t.mfe>t.slPct*0.5).length}/${losses.length} (price touched your direction before SL)`);
console.log(`  >100% of SL moved   : ${losses.filter(t=>t.mfe>=t.slPct).length}/${losses.length} (price nearly reached TP1 before reversing)`);
console.log(`  Never moved >0.1%   : ${losses.filter(t=>t.mfe<0.001).length}/${losses.length} (straight through, bad entry)`);

console.log('\n── MAE on WINNING trades (how close to SL before recovery) ──');
console.log(`  Avg MAE before win  : ${pct(avg(wins,t=>t.mae))}  (vs SL = avg ${pct(avg(wins,t=>t.slPct))})`);
console.log(`  Hit >75% of SL      : ${wins.filter(t=>t.mae>t.slPct*0.75).length}/${wins.length} (near-stop winners)`);

console.log('\n── Time held (15m bars) ──');
console.log(`  Losses avg bars held : ${avg(losses,t=>t.barsHeld).toFixed(1)} bars (${(avg(losses,t=>t.barsHeld)*15/60).toFixed(1)}h)`);
console.log(`  Wins   avg bars held : ${avg(wins,t=>t.barsHeld).toFixed(1)} bars (${(avg(wins,t=>t.barsHeld)*15/60).toFixed(1)}h)`);

console.log('\n── Direction breakdown ──');
const lW=longs.filter(t=>t.r>0).length, sW=shorts.filter(t=>t.r>0).length;
console.log(`  LONG  ${longs.length} trades  win=${Math.round(lW/longs.length*100)}%  avg MFE loss=${pct(avg(longs.filter(t=>t.r<0),t=>t.mfe))}  avg MAE loss=${pct(avg(longs.filter(t=>t.r<0),t=>t.mae))}`);
console.log(`  SHORT ${shorts.length} trades  win=${Math.round(sW/shorts.length*100)}%  avg MFE loss=${pct(avg(shorts.filter(t=>t.r<0),t=>t.mfe))}  avg MAE loss=${pct(avg(shorts.filter(t=>t.r<0),t=>t.mae))}`);

console.log('\n── SL size vs TP1 distance ──');
const avgSL = avg(allTrades,t=>t.slPct);
console.log(`  Avg SL  : ${pct(avgSL)}`);
console.log(`  TP1     : ${pct(TP1_PCT)}  (ratio TP1/SL = ${(TP1_PCT/avgSL).toFixed(2)}x)`);
console.log(`  TP2     : ${pct(TP2_PCT)}  (ratio TP2/SL = ${(TP2_PCT/avgSL).toFixed(2)}x)`);

console.log('\n── Root cause analysis ──');
const straightLoss = losses.filter(t=>t.mfe<0.001).length;
const almostTP1    = losses.filter(t=>t.mfe>=TP1_PCT*0.8&&t.mfe<TP1_PCT).length;
const normalLoss   = losses.length - straightLoss - almostTP1;
console.log(`  1. Bad entry (price never moved your way > 0.1%)    : ${straightLoss} trades (${Math.round(straightLoss/losses.length*100)}% of losses)`);
console.log(`  2. Reached near TP1 (${pct(TP1_PCT*0.8)}-${pct(TP1_PCT)}) then reversed : ${almostTP1} trades (${Math.round(almostTP1/losses.length*100)}% of losses)`);
console.log(`  3. Moved some but reversed before TP1               : ${normalLoss} trades (${Math.round(normalLoss/losses.length*100)}% of losses)`);

console.log('\n── What would fix it ──');
const fixedByWiderSL = losses.filter(t=>t.mfe>=TP1_PCT).length;
console.log(`  If SL were 2× wider: ${fixedByWiderSL} more winners (but doubles risk $)`);
const fixedByTrailing= wins.filter(t=>t.mae>t.slPct*0.5).length;
console.log(`  If SL trailed tighter after TP1: ${fixedByTrailing} fewer BE/late-TP losses`);
