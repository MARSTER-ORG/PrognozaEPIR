'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const H=3600000,T=Date.UTC(2026,10,23,12);
// Use the real runtime's class/bucket gate, with no network, not a reimplementation.
const runtime=fs.readFileSync('cloud-learning-client.js','utf8');
const from=runtime.indexOf('  function precipitationPhase(');
const to=runtime.indexOf('  function componentForKey(');
const ctx={window:{},Date:{now:()=>T},HOUR:H,precipitationLearning:null,loadPrecipitationLearning(){}};
vm.createContext(ctx);vm.runInContext(runtime.slice(from,to),ctx);
const bucket={active:true,shadow_qualified:true,phase_learning:{
 drizzle:{active:true,shadow_qualified:true,candidate_factors:{test:1.1}},
 rain:{active:true,shadow_qualified:true,candidate_factors:{test:.9}}}};
ctx.precipitationLearning={mode:'shadow_only',active:false,learned_buckets:{'3-6h':bucket}};
assert.equal(ctx.historicalPrecipFactor('test',T+4*H,{code:'DZ'}),1);
ctx.precipitationLearning.mode='production';ctx.precipitationLearning.active=true;
assert.equal(ctx.historicalPrecipFactor('test',T+4*H,{code:'DZ'}),1.1);
assert.equal(ctx.historicalPrecipFactor('test',T+4*H,{code:'RA'}),.9);
bucket.phase_learning.drizzle.shadow_qualified=false;
assert.equal(ctx.historicalPrecipFactor('test',T+4*H,{code:'DZ'}),1);

// Exercise the whole convection engine's real cache fallback across time.
(async()=>{
 let clock=T,stored,events={};
 const point={lat:52.828611,lon:18.330278};
 const cached={point,updatedAt:new Date(T-90*60000).toISOString(),rows:[{
 time:T+H,tcuProbability:20,cbProbability:10,nowcastApplied:false}],baseRows:[{
 time:T+H,tcuProbability:20,cbProbability:10}]};
 stored=JSON.stringify(cached);
 const localStorage={getItem:k=>k==='prognozaepir.convection12h.v1'?stored:null,
 setItem:(k,v)=>{if(k==='prognozaepir.convection12h.v1')stored=v;}};
 const document={documentElement:{dataset:{epirPage:'index'}},getElementById(){return null;},addEventListener(){}};
 const window={addEventListener(k,v){events[k]=v;},dispatchEvent(){}};
 const sandbox={window,document,localStorage,location:{pathname:'/index.html'},
 Date:class extends Date{static now(){return clock;}},URLSearchParams,AbortController,
 setTimeout(){return 1;},clearTimeout(){},fetch:async()=>{throw Error('offline');},CustomEvent:class{},console};
 vm.runInNewContext(fs.readFileSync('convection-horizon-12h.js','utf8'),sandbox);
 const first=await window.PrognozaEPIRConvection12hEngine.refresh();
 assert.equal(first.updatedAt,cached.updatedAt,'fallback retains actual NWP age');
 assert.equal(first.baseRows[0].tcuProbability,20,'unblended cache persists');
 clock=T+31*60000;
 assert.equal(await window.PrognozaEPIRConvection12hEngine.refresh(),null,'cache expires despite repeated publish');
 assert.equal(JSON.parse(stored).updatedAt,cached.updatedAt);
 console.log('Precipitation qualification: class activation gates and NWP cache expiry PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
