'use strict';
const assert=require('assert');
const E=require('../taf-engine-v243.js');

const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,8,19,12),end=start+12*H,issue=start-H;

function model({vis=12000,code=0,kt=8,dir=200,g=kt,w=1}={}){
  return {vis,code,ws:kt/KT,wd:dir,g:g/KT,w,ceil:null};
}

function row(i,{kt=8,dir=200,gust=kt,vis=12000}={}){
  return {
    t:start+i*H,T:18,Td:9,RH:55,RR:0,VIS:vis,
    WS:kt/KT,WD:dir,G:gust/KT,wet:0,storm:0,dirSpread:10,
    profile:[{agl:200,cc:0},{agl:2500,cc:0}],
    ceiling:null,lowH:null,midH:null,highH:null,oktaL:0,oktaM:0,oktaH:0,
    mv:[model({vis,kt,dir,g:gust}),model({vis,kt,dir,g:gust}),model({vis,kt,dir,g:gust})],
    fogRisk:0,fgRisk:null,brRisk:null,fogOperationalScore:null,fgOperationalScore:null,brOperationalScore:null
  };
}

function gen(rows){
  return E.createEngine().generate({station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true});
}

assert.equal(E.ENGINE_VERSION,'2.4.0');
assert.equal(E.QUALITY_VERSION,'2.4.3');
assert.equal(E.RULES.prevailingWindFullPeriodWhenNoSignificantChange,true);
assert.equal(E.RULES.prevailingGustMinFraction,.50);

// 19.09.2026-type case: only the first two hours are gusty. No instruction-significant
// wind regime change exists, so the base wind must represent the full 12 h period.
{
  const spec=[
    [12,210,22],[12,210,22],[12,200,12],[10,200,10],[10,200,10],[8,190,8],
    [8,190,8],[8,190,8],[8,200,8],[8,200,8],[8,190,8],[8,190,8]
  ];
  const q=gen(spec.map((x,i)=>row(i,{kt:x[0],dir:x[1],gust:x[2]})));
  assert.match(q.base.text,/^20010KT\b/,q.base.text);
  assert.ok(!/^\S*G\d+KT\b/.test(q.base.text),q.base.text);
  assert.equal(q.hourly[0].tafDisplay.wind,'21012G22KT');
  assert.equal(q.hourly[1].tafDisplay.wind,'21012G22KT');
  assert.equal(q.hourly[2].tafDisplay.wind,'20012KT');
  assert.equal(q.groups.filter(g=>(g.fields||[]).includes('wind')).length,0,q.taf);
  assert.equal(q.diagnostics.prevailingGustHours,2);
  assert.equal(q.diagnostics.prevailingWindHours,12);
  assert.equal(q.checks.ok,true);
}

// Gusts that prevail for at least half of a stable wind regime remain in the base group.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{kt:12,dir:200,gust:i<8?22:12}));
  const q=gen(rows);
  assert.match(q.base.text,/^20012G22KT\b/,q.base.text);
  assert.equal(q.diagnostics.prevailingGustHours,8);
  assert.equal(q.checks.ok,true);
}

// A real instruction-significant wind regime change must not be averaged away.
{
  const rows=Array.from({length:12},(_,i)=>row(i,i<3?{kt:20,dir:200,gust:30}:{kt:8,dir:200,gust:8}));
  const q=gen(rows);
  assert.match(q.base.text,/^20020G30KT\b/,q.base.text);
  assert.ok(q.groups.some(g=>(g.fields||[]).includes('wind')),q.taf);
  assert.equal(q.checks.ok,true);
}

console.log('TAF Engine 2.4.3 prevailing wind tests: OK');
