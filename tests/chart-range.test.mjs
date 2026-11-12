import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chartWindow,pickRange,yRange,bucketSize,blockClock,stamp,poolHistory,drawChart,swapText,RANGES} from '../src/charts.mjs';
import {decode} from '../src/history.mjs';
const H=36e5,DAY=24*H,G={createdAtMs:1794193062992,blockTimeMs:2000};
// Heights are hours here: clock(h) = h hours.
const hours=h=>h*H;
const pt=(height,fangReserve,swap=null)=>({height,p:[fangReserve,1000n,1n],vol:swap?swap.fang:0n,id:String(height),method:swap?(swap.buy?'buy':'sell'):'add_liquidity',swap});
const buy={buy:true,fang:10_000_000_000n,blood:21_000_000_000n},sell={buy:false,fang:4_000_000_000n,blood:9_000_000_000n};
// 10 days of history: launch, a big early move, then one small buy 2h ago.
const points=[pt(0,100n),pt(24,400n,buy),pt(100,380n,sell),pt(238,388n,buy)],NOW=240;

test('range toggle offers 24h, 7d and All, defaulting to 24h',()=>{
 assert.deepEqual(RANGES.map(r=>[r.label,r.ms]),[['24H',DAY],['7D',7*DAY],['All',0]]);
});
test('ranges filter by time and carry the prior point in at the left edge',()=>{
 const d=chartWindow(points,hours,NOW,DAY);
 assert.equal(d.t0,hours(NOW)-DAY);assert.equal(d.t1,hours(NOW));
 assert.deepEqual(d.pts.map(p=>[p.t,p.p[0]]),[[d.t0,380n],[hours(238),388n]]);
 assert.equal(d.pts[0].method,'start');assert.equal(d.pts[0].swap,null);assert.equal(d.pts[0].vol,0n);
 const w=chartWindow(points,hours,NOW,7*DAY);
 assert.deepEqual(w.pts.map(p=>[p.t,p.p[0]]),[[hours(NOW)-7*DAY,400n],[hours(100),380n],[hours(238),388n]]);
 const all=chartWindow(points,hours,NOW,0);
 assert.equal(all.t0,0);assert.equal(all.pts.length,4);assert.equal(all.pts[0].method,'add_liquidity');
});
test('a range with fewer than 2 points falls back to All',()=>{
 assert.equal(pickRange(points,hours,NOW,DAY),DAY);
 assert.equal(pickRange(points,hours,NOW,7*DAY),7*DAY);
 const quiet=points.slice(0,3);// last activity 140h ago
 assert.equal(pickRange(quiet,hours,NOW,DAY),0);
 assert.equal(pickRange(quiet,hours,NOW,7*DAY),7*DAY);
 assert.equal(pickRange([],hours,NOW,DAY),0);
 assert.equal(pickRange(points,hours,NOW,0),0);
});
test('y-axis rescales to the visible values with padding',()=>{
 const r=yRange([.380,.388]);
 assert.ok(r.lo<.380&&r.lo>.378);assert.ok(r.hi>.388&&r.hi<.390);
 assert.ok(Math.abs((r.hi-r.lo)-(.008*1.24))<1e-12);
 const flat=yRange([5,5]);assert.ok(flat.lo<5&&flat.hi>5);
 assert.equal(yRange([0,10]).lo,0);
 const zero=yRange([0,0]);assert.ok(zero.hi>zero.lo);
});
test('a small recent trade fills far more of the 24h chart than of All',()=>{
 const price=p=>Number(p[0])/Number(p[1]),step=ms=>{
  const {pts}=chartWindow(points,hours,NOW,ms),vs=pts.map(p=>price(p.p)),r=yRange(vs);
  return (price(points[3].p)-price(points[2].p))/(r.hi-r.lo);
 };
 assert.ok(step(0)<.03);assert.ok(step(DAY)>.75);
});
test('volume buckets fit the visible range',()=>{
 assert.equal(bucketSize(DAY),H);
 assert.equal(bucketSize(7*DAY),4*H);
 assert.equal(bucketSize(2*H),3e5);
 for(const span of [H,DAY,7*DAY,90*DAY,5*365*DAY])assert.ok(span/bucketSize(span)<=48,`span ${span}`);
});

test('stamp reads ms, seconds, numeric strings and ISO dates',()=>{
 assert.equal(stamp({timestamp_ms:1794444271830}),1794444271830);
 assert.equal(stamp({timestamp_ms:'1794444271830'}),1794444271830);
 assert.equal(stamp({timestamp:1794444271}),1794444271000);
 assert.equal(stamp({block_time:'2026-11-12T00:00:00Z'}),Date.parse('2026-11-12T00:00:00Z'));
 assert.equal(stamp({height:5}),null);assert.equal(stamp({timestamp_ms:0}),null);assert.equal(stamp({timestamp_ms:'soon'}),null);assert.equal(stamp(null),null);
});
test('block clock uses real header timestamps, caches per height, and estimates only when needed',async()=>{
 const real={125095:1794444271830,125200:1794444490000},calls=[];
 const fetcher=async url=>{const h=Number(url.split('/').pop());calls.push(h);return real[h]?{ok:true,json:async()=>({height:h,timestamp_ms:real[h]})}:{ok:false,status:404};};
 const clock=blockClock('https://example.invalid',G,fetcher);
 const estimate=G.createdAtMs+125095*2000;
 assert.equal(clock(125095),estimate);assert.equal(clock.exact(125095),false);
 assert.ok(real[125095]-estimate>16*60000);// the drift this replaces
 assert.equal(await clock.load([125095,125095,125200,99]),2);
 assert.equal(clock(125095),real[125095]);assert.equal(clock(125200),real[125200]);assert.equal(clock.exact(125200),true);
 // cached: no refetch of known heights; the failed one backs off instead of hammering the node
 assert.equal(await clock.load([125095,125200,99]),0);
 assert.deepEqual(calls.slice().sort((a,b)=>a-b),[99,125095,125200]);
 // unknown heights: stepped from the nearest known block, interpolated between two, never the drifting genesis estimate
 assert.equal(clock(125300),real[125200]+100*2000);
 assert.equal(clock(125000),real[125095]-95*2000);
 const mid=clock(125150);assert.ok(mid>real[125095]&&mid<real[125200]);
 assert.equal(clock(99),real[125095]-(125095-99)*2000);
 assert.equal(clock.near(126000,900),true);assert.equal(clock.near(130000,900),false);
});
test('block clock survives an unreachable node',async()=>{
 const clock=blockClock('https://example.invalid',G,async()=>{throw Error('offline');});
 assert.equal(await clock.load([10,20]),0);
 assert.equal(clock(10),G.createdAtMs+20000);
 const odd=blockClock('https://example.invalid',G,async()=>({ok:true,json:async()=>({height:10})}));
 assert.equal(await odd.load([10]),0);assert.equal(odd(10),G.createdAtMs+20000);
});

const P='boo1d9r5ph0e7k2vezt0tp2ns3wqvs2psyhcrmelzjfl4990xtuj8qvs96nq80';
const fx=JSON.parse(readFileSync(new URL('./fixtures/pool-txs.json',import.meta.url)));
test('pool history stamps points from the tx when present, else from the block header',async t=>{
 const heights=[...new Set(fx.txs.flatMap(tx=>decode(tx,P)).map(o=>o.height))].sort((a,b)=>a-b),stamped=heights.at(-1);
 const headerTime=h=>G.createdAtMs+h*2000+1000000+h,txTime=1794444000000;
 const txs=fx.txs.map(tx=>tx.height===stamped?{...tx,timestamp_ms:txTime}:tx),blocks=[];
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async url=>{
  const m=/\/api\/block\/(\d+)$/.exec(url);
  if(m){blocks.push(Number(m[1]));return {ok:true,json:async()=>({height:Number(m[1]),timestamp_ms:headerTime(Number(m[1]))})};}
  return {ok:true,json:async()=>({txs,next:null})};
 };
 const clock=blockClock('https://example.invalid',G),h=poolHistory('https://example.invalid',P,clock);
 await h.sync(fx.live.map(BigInt),108029);assert.equal(h.error,null);
 assert.equal(clock(stamped),txTime);assert.ok(!blocks.includes(stamped));
 for(const p of h.result.points)assert.ok(clock.exact(p.height));
 const other=heights[0];assert.equal(clock(other),headerTime(other));
 // one header fetch per unstamped height, plus the live height as an anchor for "now" (it is >900 blocks past the last trade)
 assert.deepEqual(blocks.slice().sort((a,b)=>a-b),[...heights.filter(x=>x!==stamped),108029]);
 assert.equal(clock(108031),headerTime(108029)+4000);
 await h.sync(fx.live.map(BigInt),108040);assert.equal(blocks.length,heights.length);// later syncs refetch nothing
 const swaps=h.result.points.filter(p=>p.swap);assert.equal(swaps.length,10);assert.equal(swaps.filter(p=>p.swap.buy).length,6);
 const s=swaps.find(p=>!p.swap.buy);assert.equal(s.swap.blood,100000000000n);assert.equal(s.swap.fang,101886905n-1018869n);
});

// Minimal SVG stand-in so drawChart can run under node.
const node=tag=>({tag,attrs:{},children:[],textContent:'',setAttribute(k,v){this.attrs[k]=String(v);},append(...c){this.children.push(...c);},replaceChildren(...c){this.children=c;},get firstChild(){return this.children[0];}});
test('price and liquidity lines mark each visible swap, keeping the latest-price dot',t=>{
 globalThis.document={createElementNS:(_,tag)=>node(tag)};t.after(()=>{delete globalThis.document;});
 const live=[388n,1000n,1n],history={result:{points},error:null};
 for(const view of ['price','liquidity']){
  const svg=node('svg'),chart=drawChart(svg,view,history,hours,live,NOW,DAY);
  const dots=svg.children.filter(c=>c.tag==='circle'&&c.attrs.class.startsWith('chart-swap'));
  assert.equal(dots.length,1,view);assert.equal(dots[0].attrs.class,'chart-swap buy');
  assert.ok(Math.abs(Number(dots[0].attrs.cx)-22/24*512)<1e-6);
  const title=dots[0].children[0];assert.equal(title.tag,'title');assert.match(title.textContent,/ · Buy · 10 FANG → 21 BLOOD$/);
  assert.equal(svg.children.filter(c=>c.attrs.class==='chart-dot').length,1);
  // hovering near the marker describes the trade; elsewhere it reads the line
  assert.match(chart.at(hours(238)+60000).text,/Buy · 10 FANG/);
  assert.doesNotMatch(chart.at(hours(225)).text,/Buy|Sell/);
  const all=node('svg');drawChart(all,view,history,hours,live,NOW,0);
  assert.deepEqual(all.children.filter(c=>c.tag==='circle'&&c.attrs.class.startsWith('chart-swap')).map(c=>c.attrs.class),['chart-swap buy','chart-swap sell','chart-swap buy']);
 }
 const vol=node('svg');drawChart(vol,'volume',history,hours,live,NOW,DAY);
 assert.equal(vol.children.filter(c=>c.tag==='circle').length,0);assert.equal(vol.children.filter(c=>c.tag==='rect').length,1);
 assert.match(swapText({t:0,swap:sell}),/Sell · 9 BLOOD → 4 FANG$/);
});
