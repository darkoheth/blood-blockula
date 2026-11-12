// Price, liquidity and volume charts drawn as plain SVG from verified pool history.
import {decode,rebuild} from './history.mjs';
const W=512,TOP=14,BOT=172,NS='http://www.w3.org/2000/svg',DAY=86400000;
export const RANGES=[{ms:DAY,label:'24H'},{ms:7*DAY,label:'7D'},{ms:0,label:'All'}];
const num=(v,d=4)=>v.toLocaleString('en-US',{maximumSignificantDigits:d});
const fang=n=>Number(n)/1e9;
export const when=(ms,full=true)=>new Date(ms).toLocaleString('en-US',full?{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}:{hour:'numeric',minute:'2-digit'});
// A timestamp carried by a tx or block (ms; tolerates seconds, numeric strings and ISO dates), or null.
export function stamp(o){
 for(const k of ['timestamp_ms','block_timestamp_ms','block_time_ms','time_ms','timestamp','block_time']){
  let v=o?.[k];if(v==null||v==='')continue;
  if(typeof v==='string')v=/^\d+(\.\d+)?$/.test(v)?Number(v):Date.parse(v);
  if(Number.isFinite(v)&&v>0)return Math.round(v<1e11?v*1000:v);
 }
 return null;
}
// height -> real time (ms). Known block timestamps are exact; other heights are interpolated between the nearest
// known blocks (or stepped from the nearest one at the nominal block time). With nothing known it is the old
// genesis + height × blockTime estimate, which drifts because real blocks are not exactly blockTimeMs apart.
export function blockClock(rpc,genesis,fetcher=(...a)=>fetch(...a)){
 const known=new Map(),retry=new Map(),step=genesis.blockTimeMs;let sorted=null;
 const clock=h=>{
  if(known.has(h))return known.get(h);
  if(!known.size)return genesis.createdAtMs+h*step;
  sorted??=[...known.keys()].sort((a,b)=>a-b);
  let lo=0,hi=sorted.length;while(lo<hi){const m=(lo+hi)>>1;if(sorted[m]<=h)lo=m+1;else hi=m;}
  const a=sorted[lo-1],b=sorted[lo];
  if(a===undefined)return known.get(b)-(b-h)*step;
  if(b===undefined)return known.get(a)+(h-a)*step;
  return Math.round(known.get(a)+(h-a)/(b-a)*(known.get(b)-known.get(a)));
 };
 clock.exact=h=>known.has(h);
 clock.set=(h,ms)=>{if(!Number.isInteger(h)||!Number.isFinite(ms)||ms<=0)return false;known.set(h,ms);sorted=null;return true;};
 // True when a known block lies within `blocks` of h, so the estimate for h is tight.
 clock.near=(h,blocks)=>{for(const k of known.keys())if(Math.abs(k-h)<=blocks)return true;return false;};
 // Fetch missing block headers (each height at most once; failures back off and keep the estimate). Never throws.
 clock.load=async heights=>{
  const now=Date.now(),todo=[...new Set(heights)].filter(h=>Number.isInteger(h)&&h>=0&&!known.has(h)&&(retry.get(h)||0)<=now);let got=0;
  const worker=async()=>{for(let h;(h=todo.pop())!==undefined;){
   try{const r=await fetcher(`${rpc}/api/block/${h}`,{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error(r.status);if(!clock.set(h,stamp(await r.json())))throw Error('no timestamp');retry.delete(h);got++;}
   catch{retry.set(h,Date.now()+60000);}
  }};
  await Promise.all(Array.from({length:Math.min(6,todo.length)},worker));return got;
 };
 return clock;
}
// Fetches the pool's transaction history once, then only newer pages; rebuilds and checks against live reserves each sync.
// With a blockClock, each op's block gets its real timestamp (from the tx if present, else the block header).
export function poolHistory(rpc,program,clock=null){
 let ops=[],ids=new Set(),scanned=null,running=false,retryAt=0;const h={result:null,error:null};
 h.sync=async(live,height)=>{
  if(running||Date.now()<retryAt||(scanned!==null&&height<=scanned&&h.result))return;running=true;
  try{
   const fresh=[];let before='',done=false;
   for(let i=0;i<200&&!done;i++){
    const r=await fetch(`${rpc}/api/account/${program}/txs?limit=100${before?'&before='+before:''}`,{cache:'no-store'});if(!r.ok)throw Error(`Pool history unavailable (${r.status}).`);const page=await r.json();
    for(const tx of page.txs){if(scanned!==null&&tx.height<=scanned){done=true;break;}fresh.push(tx);}
    if(!page.next)done=true;else before=page.next;
   }
   if(!done)throw Error('Pool history exceeds this reader’s pagination limit.');
   const added=fresh.filter(t=>t.height<=height&&!ids.has(t.id)).reverse();added.forEach(t=>ids.add(t.id));
   ops=ops.concat(added.flatMap(t=>decode(t,program)));
   if(clock){
    for(const t of added){const ms=stamp(t);if(ms)clock.set(t.height,ms);}
    await clock.load([...ops.map(o=>o.height),...(clock.near(height,900)?[]:[height])]);
   }
   h.result=rebuild(ops,live,height);h.result.height=height;scanned=height;h.error=null;
  }catch(e){h.error=e.message;h.result=null;ops=[];ids=new Set();scanned=null;retryAt=Date.now()+20000;}
  finally{running=false;}
 };
 return h;
}
// Keep the state immediately before a time window as its baseline, not the launch-day price.
export function chartWindow(points,clock,liveHeight,windowMs=DAY){
 const all=points.map(p=>({...p,t:clock(p.height)}));
 if(!all.length)return {pts:[],t0:clock(liveHeight),t1:clock(liveHeight)+1};
 const t1=Math.max(clock(liveHeight),all.at(-1).t+1),t0=windowMs?Math.max(all[0].t,t1-windowMs):all[0].t;
 const before=all.filter(p=>p.t<t0).at(-1),pts=all.filter(p=>p.t>=t0);
 if(before)pts.unshift({...before,t:t0,vol:0n,method:'start',id:null,swap:null});
 return {pts,t0,t1};
}
// The range actually shown: the requested one, or All (0) when it would hold fewer than 2 points (carried-in start included).
export const pickRange=(points,clock,liveHeight,windowMs)=>windowMs&&chartWindow(points,clock,liveHeight,windowMs).pts.length<2?0:windowMs;
// Y-axis bounds for the visible values: padded so the line never touches the frame, floored at zero, never zero-height.
export function yRange(values,padding=.12){
 let lo=Math.min(...values),hi=Math.max(...values);
 if(hi===lo){const pad=Math.max(Math.abs(lo)*.05,1e-12);lo-=pad;hi+=pad;}
 const pad=(hi-lo)*padding;return {lo:Math.max(0,lo-pad),hi:hi+pad};
}
// Volume bar width for a visible span: the finest step that keeps the chart to 48 bars or fewer.
export const bucketSize=span=>[3e5,9e5,36e5,72e5,144e5,432e5,DAY,7*DAY].find(s=>span/s<=48)||Math.ceil(span/48/(7*DAY))*7*DAY;
export const swapText=s=>`${when(s.t)} · ${s.swap.buy?`Buy · ${num(fang(s.swap.fang),6)} FANG → ${num(fang(s.swap.blood),6)} BLOOD`:`Sell · ${num(fang(s.swap.blood),6)} BLOOD → ${num(fang(s.swap.fang),6)} FANG`}`;
const el=(tag,attrs,text)=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e;};
// Draw `view` ('price'|'liquidity'|'volume'); returns hover handler data.
export function drawChart(svg,view,history,clock,live,liveHeight,windowMs=DAY){
 svg.replaceChildren(el('defs',{}),el('path',{class:'grid',d:'M0 30H512M0 80H512M0 130H512M0 180H512'}));
 svg.firstChild.innerHTML='<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#f04455" stop-opacity=".2"/><stop offset="1" stop-color="#f04455" stop-opacity="0"/></linearGradient>';
 const res=history.result;
 if(!res||!live){svg.append(el('text',{x:256,y:100,class:'chart-empty'},history.error?'Pool history unavailable · retrying':'Loading pool history…'));return null;}
 if(!res.points.length){svg.append(el('text',{x:256,y:100,class:'chart-empty'},'No pool activity yet'));return null;}
 const {pts,t0,t1}=chartWindow(res.points,clock,liveHeight,windowMs),x=t=>(t-t0)/(t1-t0)*W;
 if(view==='volume'){
  const span=t1-t0,size=bucketSize(span),n=Math.ceil(span/size),bars=Array.from({length:n},(_,i)=>({t:t0+i*size,end:Math.min(t1,t0+(i+1)*size),v:0n,swaps:0}));
  for(const p of pts)if(p.vol){const b=bars[Math.min(n-1,Math.floor((p.t-t0)/size))];b.v+=p.vol;b.swaps++;}
  const max=bars.reduce((m,b)=>b.v>m?b.v:m,0n),y=v=>BOT-(max?fang(v)/fang(max):0)*(BOT-TOP-6),bw=W/n;
  for(const b of bars)if(b.v)svg.append(el('rect',{x:x(b.t)+bw*.15,y:y(b.v),width:Math.max(1.5,bw*.7),height:BOT-y(b.v),rx:1.5,class:'chart-bar'}));
  svg.append(el('path',{d:`M0 ${BOT}H${W}`,class:'chart-base'}));
  if(max)svg.append(el('text',{x:522,y:TOP+8,class:'chart-axis'},num(fang(max),3)));svg.append(el('text',{x:522,y:BOT,class:'chart-axis'},'0'));
  return {x,t0,t1,at:t=>{const b=bars[Math.min(n-1,Math.max(0,Math.floor((t-t0)/size)))];return {x:x(b.t)+bw/2,y:y(b.v),text:`${when(b.t)}–${when(b.end,false)} · ${num(fang(b.v),6)} FANG · ${b.swaps} swap${b.swaps===1?'':'s'}`};}};
 }
 const val=p=>view==='price'?Number(p[0])/Number(p[1]):fang(2n*p[0]);
 const series=[...pts.map(p=>({t:p.t,v:val(p.p),p:p.p,method:p.method,swap:p.swap})),{t:t1,v:val(live),p:live,method:'now'}];
 const vs=series.map(s=>s.v),lo=Math.min(...vs),hi=Math.max(...vs),r=yRange(vs),y=v=>BOT-(v-r.lo)/(r.hi-r.lo)*(BOT-TOP),swaps=series.filter(s=>s.swap);
 let d=`M${x(series[0].t)} ${y(series[0].v)}`;for(const s of series.slice(1))d+=`H${x(s.t)}V${y(s.v)}`;
 svg.append(el('path',{d:`${d}V${BOT+13}H0Z`,fill:'url(#fade)'}),el('path',{d,class:'chart-line'}),...swaps.map(s=>{const c=el('circle',{cx:x(s.t),cy:y(s.v),r:2.8,class:`chart-swap ${s.swap.buy?'buy':'sell'}`});c.append(el('title',{},swapText(s)));return c;}),el('circle',{cx:W,cy:y(series.at(-1).v),r:5,class:'chart-dot'}));
 svg.append(el('text',{x:522,y:y(hi)+3,class:'chart-axis'},num(hi)),el('text',{x:522,y:y(lo)+3,class:'chart-axis'},num(lo)));
 const unit=view==='price'?'FANG / BLOOD':'FANG TVL';
 // Hovering within 6px of a swap marker snaps to it and describes the trade.
 return {x,t0,t1,at:t=>{
  const px=x(Math.max(t0,Math.min(t,t1)));let hit=null,best=6;for(const c of swaps){const d=Math.abs(x(c.t)-px);if(d<=best){best=d;hit=c;}}
  if(hit)return {x:x(hit.t),y:y(hit.v),text:swapText(hit)};
  let s=series[0];for(const c of series)if(c.t<=t)s=c;const extra=view==='liquidity'?` · ${num(fang(s.p[0]),6)} FANG + ${num(fang(s.p[1]),6)} BLOOD`:'';return {x:px,y:y(s.v),text:`${when(t)} · ${num(s.v,view==='price'?6:7)} ${unit}${extra}`};
 }};
}
