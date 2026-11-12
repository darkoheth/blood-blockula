// Pool history rebuilt from the program's finalized transactions, using the contract's exact integer math.
const FEE_BPS=100n,LOCK=1000n;
const le=(hex,o=0)=>{let n=0n;for(let i=7;i>=0;i--)n=(n<<8n)|BigInt(parseInt(hex.substr((o+i)*2,2),16));return n;};
const fee=n=>n*FEE_BPS/10000n;
const ceildiv=(a,b,d)=>(a*b+d-1n)/d;
const min=(a,b)=>a<b?a:b;
function isqrt(n){if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
// Decode successful calls to the pool into ops. Token transfers/approvals do not touch reserves and are skipped.
export function decode(tx,program){
 if(tx.status!=='finalized'||tx.program?.outcome?.ok!==true)return [];
 const events=(tx.program.claims?.events||[]).filter(e=>e.program===program);let at=0;
 const take=name=>{let tax=null;for(;at<events.length;at++){const e=events[at];if(e.untrusted_name==='protocol_fee')tax=le(e.data);if(e.untrusted_name===name){at++;return {data:e.data,tax};}}throw Error(`Missing ${name} event in ${tx.id}`);};
 const delta=BigInt(tx.program.facts?.balance_changes?.find(b=>b.account===program)?.change??0);
 const ops=[];
 for(const c of tx.action?.calls||[]){
  if(c.program!==program)continue;const base={id:tx.id,height:tx.height,method:c.method,value:BigInt(c.value||0),input:c.input||'',delta};
  if(c.method==='buy'||c.method==='sell'){const e=take('swap');ops.push({...base,buy:e.data.substr(64,2)==='01',n:le(e.data,33),out:le(e.data,41),tax:e.tax??0n});}
  else if(c.method==='add_liquidity')ops.push({...base,shares:le(take('liquidity_added').data)});
  else if(c.method==='remove_liquidity')ops.push({...base,shares:le(take('liquidity_removed').data)});
 }
 return ops;
}
// Apply one op to [FANG,BLOOD,LP] exactly as bk_buy/bk_sell/bk_add_liquidity/bk_remove_liquidity do; throws if the event disagrees.
export function apply(p,op){
 let [f,b,l]=p;const bad=w=>{throw Error(`Reconstruction mismatch (${w}) at ${op.id}`);};
 if(op.method==='buy'){const n=op.value,net=n-fee(n);if(!f||!b)bad('empty pool');const out=net*b/(f+net);if(!op.buy||n!==op.n||out!==op.out)bad('buy');return [f+net,b-out,l];}
 if(op.method==='sell'){const n=le(op.input,0);if(!f||!b)bad('empty pool');const gross=n*f/(b+n),out=gross-fee(gross);if(op.buy||n!==op.n||out!==op.out||op.tax!==fee(gross))bad('sell');return [f-gross,b+n,l];}
 if(op.method==='add_liquidity'){
  const n=op.value,max=le(op.input,0);let token,shares,refund=0n;
  if(l===0n){const root=isqrt(n*max);if(root<=LOCK)bad('initial add');l=LOCK;token=max;shares=root-LOCK;}
  else{token=ceildiv(n,b,f);if(token<=max)shares=min(n*l/f,token*l/b);else{const used=ceildiv(max,f,b);if(used>n)bad('add rounding');token=max;shares=min(used*l/f,max*l/b);refund=n-used;}}
  if(shares!==op.shares)bad('add shares');return [f+n-refund,b+token,l+shares];
 }
 if(op.method==='remove_liquidity'){const s=le(op.input,0);if(s!==op.shares||!l)bad('remove');return [f-s*f/l,b-s*b/l,l-s];}
 return p;
}
// Undo one op given the state after it (only needed once the node has pruned the pool's first deposit).
// Every candidate pre-state is checked by re-applying the forward contract math.
export function undo(p,op){
 const [f,b,l]=p;const ok=pre=>{try{const q=apply(pre,op);return q[0]===f&&q[1]===b&&q[2]===l;}catch{return false;}};
 const pick=list=>{const hit=list.find(ok);if(!hit)throw Error(`Cannot rewind ${op.method} at ${op.id}`);return hit;};
 const near=est=>Array.from({length:7},(_,i)=>est-3n+BigInt(i)).filter(t=>t>=0n);
 if(op.method==='buy')return pick([[f-(op.n-fee(op.n)),b+op.out,l]]);
 if(op.method==='sell')return pick([[f+op.out+op.tax,b-op.n,l]]);
 if(op.method==='add_liquidity'){const pre0=f-op.delta,pre2=l-op.shares;return pick([le(op.input,0),...near(f?op.delta*b/f:0n)].map(t=>[pre0,b-t,pre2]));}
 if(op.method==='remove_liquidity'){const pre0=f-op.delta,pre2=l+op.shares;return pick(near(l?op.shares*b/l:0n).map(t=>[pre0,b+t,pre2]));}
 return p;
}
// Ops oldest first -> points [{height,id,method,p,vol}]. Forward from zero when the first deposit is retained, else rewind from live.
export function rebuild(ops,live,liveHeight){
 const pts=[];let mode='complete';
 if(ops.length&&ops[0].method==='add_liquidity'&&(()=>{try{return apply([0n,0n,0n],ops[0])[2]>0n;}catch{return false;}})()){
  let p=[0n,0n,0n];for(const op of ops){p=apply(p,op);pts.push(point(op,p));}
  if(p.some((x,i)=>x!==live[i]))throw Error(`History does not match live reserves (rebuilt ${p.join('/')}, live ${live.join('/')}).`);
 }else{
  mode='rewound';let p=live;for(let i=ops.length-1;i>=0;i--){pts.unshift(point(ops[i],p));p=undo(p,ops[i]);}
  pts.unshift({height:ops.length?ops[0].height:liveHeight,id:null,method:'start',p,vol:0n});
 }
 return {mode,points:pts};
}
// `swap` carries what the trader paid/received (FANG and BLOOD base units) for chart markers.
export const point=(op,p)=>({height:op.height,id:op.id,method:op.method,p,vol:op.method==='buy'?op.n:op.method==='sell'?op.out+op.tax:0n,swap:op.method==='buy'?{buy:true,fang:op.n,blood:op.out}:op.method==='sell'?{buy:false,fang:op.out,blood:op.n}:null});
