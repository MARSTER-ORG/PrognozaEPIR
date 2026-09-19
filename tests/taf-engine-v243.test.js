'use strict';
const assert=require('assert');
const E=require('../taf-engine-v243.js');

const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,8,19,12),end=start+12*H,issue=start-H;

function model({vis=12000,code=0,kt=8,dir=200,g=kt,w=1}={}){
  return {vis,code,ws:kt/KT,wd:dir,g:g/KT,w,ceil:null};
}

function row(i,{kt=8,dir=200,gust=kt,vis=12000,code=0,RR=0,wet=0,profile=null,ceiling=null,lowH=null,oktaL=0,mv=null}={}){
  const members=mv||[
    model({vis,code,kt,dir,g:gust}),
    model({vis,code,kt,dir,g:gust}),
    model({vis,code,kt,dir,g:gust})
  ];
  return {
    t:start+i*H,T:18,Td:9,RH:55,RR,VIS:vis,
    WS:kt/KT,WD:dir,G:gust/KT,wet,storm:0,dirSpread:10,
    profile:profile===null?[{agl:200,cc:0},{agl:2500,cc:0}]:profile,
    ceiling,lowH,midH:null,highH:null,oktaL,oktaM:0,oktaH:0,
    mv:members,
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
assert.equal(E.RULES.ordinaryRainRequiresVisibilityBelowM,5000);
assert.equal(E.RULES.cloudPriorityBknOvcOverFewSct,true);

// Helper-level weather gate: ordinary liquid precipitation with VIS >=5 km is
// removed before the probability/change-group engine sees it.
{
  const input={rows:[row(0,{vis:9000,code:61,RR:1,wet:1})]};
  const q=E.helpers.prepareOperationalWeatherInput(input);
  assert.equal(q.rows[0].mv.every(m=>m.code===0),true);
  assert.equal(q.rows[0].wet,0);
  assert.equal(q.rows[0].RR,0);
  assert.equal(q.taf243WeatherPolicy.suppressedMembers,3);
}

// Helper-level cloud hierarchy: FEW/SCT are removed only when ordinary BKN/OVC
// exists in the same state; CB/TCU are independent.
assert.equal(E.helpers.simplifyCloudTokens('9999 FEW025 SCT028 BKN030'),'9999 BKN030');
assert.equal(E.helpers.simplifyCloudTokens('9999 SCT025'),'9999 SCT025');
assert.equal(E.helpers.simplifyCloudTokens('9999 FEW020CB SCT025 BKN030'),'9999 FEW020CB BKN030');

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

// Ordinary rain which does not lower visibility below 5 km must not be coded.
// With no significant weather/cloud below CAVOK limits, CAVOK is allowed.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:10000,code:61,RR:.4,wet:1}));
  const q=gen(rows);
  assert.ok(!/\b(?:\+|-)?RA\b/.test(q.taf),q.taf);
  assert.match(q.base.text,/\bCAVOK\b/,q.base.text);
  assert.equal(q.groups.some(g=>/\b(?:\+|-)?RA\b/.test(g.payload||'')),false,q.taf);
  assert.equal(q.checks.ok,true);
}

// Rain remains when precipitation-bearing members forecast VIS below 5 km.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:4000,code:61,RR:.4,wet:1}));
  const q=gen(rows);
  assert.match(q.base.text,/\b(?:-RA|RA|\+RA)\b/,q.base.text);
  assert.ok(!/\bCAVOK\b/.test(q.base.text),q.base.text);
  assert.equal(q.checks.ok,true);
}

// When BKN/OVC is present, weaker ordinary FEW/SCT layers are omitted from TAF
// and the hourly TAF presentation. The ceiling layer is the operational cloud.
{
  const profile=[{agl:750,cc:35},{agl:900,cc:65},{agl:1400,cc:75}];
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:9999,profile,ceiling:900}));
  const q=gen(rows);
  assert.match(q.base.text,/\bBKN\d{3}\b/,q.base.text);
  assert.ok(!/\b(?:FEW|SCT)\d{3}\b/.test(q.base.text),q.base.text);
  assert.equal(q.hourly[0].tafDisplay.cloudLayers.some(c=>c.cover==='BKN'||c.cover==='OVC'),true);
  assert.equal(q.hourly[0].tafDisplay.cloudLayers.some(c=>(c.cover==='FEW'||c.cover==='SCT')&&!c.type),false);
  assert.equal(q.checks.ok,true);
}

// FEW/SCT is still valid when there is no BKN/OVC — e.g. SCT around 750 m.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:9999,profile:[],lowH:750,oktaL:4}));
  const q=gen(rows);
  assert.match(q.base.text,/\bSCT\d{3}\b/,q.base.text);
  assert.ok(!/\b(?:BKN|OVC)\d{3}\b/.test(q.base.text),q.base.text);
  assert.equal(q.checks.ok,true);
}

console.log('TAF Engine 2.4.3 prevailing wind + weather/cloud priority tests: OK');
