'use strict';
// TAF Instruction (A) 11.2023 §§3.10–3.13 + EPIR 3h preferred PROB30
// onset window. Explicitly distinguish onset uncertainty from intermittent
// occurrences; PROB30 is NOT an unconditional prevailing-state change.
const assert=require('assert');
const engines=[require('../taf-engine-v2.js'),require('../taf-engine-v243.js')];
const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,9,11,18),end=start+12*H,issue=start-H;
function member(vis=12000,code=0,w=1){return {vis,code,w,ws:8/KT,wd:210,g:8/KT,ceil:null};}
function row(i,extra={}){
 const vis=extra.vis??12000;
 return {t:start+i*H,T:8,Td:6,RH:78,RR:0,VIS:vis,WS:8/KT,WD:210,G:8/KT,
  wet:0,storm:0,dirSpread:10,profile:[{agl:300,cc:0},{agl:2500,cc:0}],
  ceiling:null,lowH:null,midH:null,highH:null,oktaL:0,oktaM:0,oktaH:0,
  mv:[member(vis),member(vis),member(vis)],fogEngineAvailable:true,
  fogOperationalScore:0,fgOperationalScore:0,brOperationalScore:0,
  fogEngineScore:0,fogEngineVisM:null,fogAltVisM:null,brAltVisM:null,
  ...extra};
}
const baseline=()=>Array.from({length:12},(_,i)=>row(i));
const generate=(engine,rows)=>engine.createEngine().generate({
 station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true
});
for(const engine of engines){
 // User case: risk of BR each hour from 20Z until 06Z. The TAF group
 // focuses on uncertain onset 20–23Z; the ten-hour model risk is recorded
 // separately and must NOT auto-convert into the prevailing forecast.
 const extended=baseline();
 for(let i=2;i<12;i++)extended[i]=row(i,{
  fogEngineVisM:2500,brAltVisM:2500,brOperationalScore:70});
 const q=generate(engine,extended);
 assert.match(q.taf,/PROB30 1120\/1123 2500 BR/,q.taf);
 assert.doesNotMatch(q.taf,/PROB30 1120\/1206/,q.taf);
 const alternative=q.groups.find(g=>g.kind==='PROB30'&&g.payload.includes('BR'));
 assert.ok(alternative,JSON.stringify(q.groups));
 assert.equal(alternative.scenario.type,'uncertain-fog-onset');
 assert.equal(alternative.scenario.onsetStart,start+2*H);
 assert.equal(alternative.scenario.onsetEnd,start+5*H);
 assert.equal(alternative.scenario.modelRiskUntil,end);
 assert.equal(alternative.scenario.persistentConditionsNotGuaranteed,true);
 assert.equal(q.checks.ok,true,q.taf);

 // BECMG: the transition is 2 hours, but its resulting prevailing
 // conditions last beyond the transition until the next FM/BECMG or end.
 const sustained=baseline();
 for(let i=4;i<12;i++)sustained[i]=row(i,{
  fogEngineVisM:2500,brAltVisM:2500,brOperationalScore:80});
 const b=generate(engine,sustained);
 const lasting=b.groups.find(g=>g.kind==='BECMG'&&g.payload.includes('BR'));
 assert.ok(lasting,b.taf);
 assert.ok(lasting.e-lasting.s<=2*H,b.taf);
 assert.equal(lasting.scenario.type,'prevailing-transition');
 assert.equal(lasting.scenario.prevailingUntil,end);

 // PROB30 TEMPO covers recurring intermittent convective risk, not merely
 // the initial hour, and does not replace the prevailing baseline.
 const intermittent=baseline();
 for(let i=2;i<5;i++)intermittent[i]=row(i,{
  mv:[member(9000,80,.4),member(12000,0,.6)]});
 const t=generate(engine,intermittent);
 const temp=t.groups.find(g=>g.kind==='PROB30 TEMPO');
 assert.ok(temp,t.taf);
 assert.equal(temp.s,start+2*H,t.taf);
 assert.equal(temp.e,start+5*H,t.taf);
 assert.equal(temp.scenario.type,'intermittent');

 // A long PROB30 is a review warning, NOT a formal invalidity: the
 // military instruction does not impose a fixed legal 3h limit.
 const long='TAF EPIR 111700Z 1118/1206 21008KT CAVOK PROB30 1120/1206 2500 BR=';
 const check=engine.validateTaf(long,{issue,start,end});
 assert.equal(check.ok,true,JSON.stringify(check.errors));
 assert.ok(check.warnings.some(w=>/PROB30 FG\/BR trwa >3 h/.test(w)));
}
console.log('TAF onset-versus-persistence and TEMPO semantics: OK');
