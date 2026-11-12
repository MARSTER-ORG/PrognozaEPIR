'use strict';
const assert=require('assert');
const E=require('../taf-engine-v2.js');
const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,8,14),issue=start-H,end=start+12*H;
const model=(vis,kt)=>({vis,ws:kt/KT,wd:220,g:kt/KT,code:0,w:1});
const row=(i,{kt=6,vis=10000,fgScore=0,fgAlt=null}={})=>({
  t:start+i*H,T:10,Td:7,RH:70,RR:0,VIS:vis,WS:kt/KT,WD:220,G:kt/KT,
  wet:0,storm:0,dirSpread:10,profile:[{agl:200,cc:0},{agl:2500,cc:0}],
  mv:[model(vis,kt),model(vis,kt),model(vis,kt)],
  fogOperationalScore:fgScore,fgOperationalScore:fgScore,fogAltVisM:fgAlt
});
const gen=rows=>E.createEngine().generate({station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true});
{
  const q=gen(Array.from({length:12},(_,i)=>row(i,{kt:i>=3?22:6,fgScore:i>=3?60:0,fgAlt:i>=3?900:null})));
  const wind=q.groups.find(g=>g.kind==='BECMG'&&g.fields.includes('wind'));
  const fog=q.groups.find(g=>g.kind==='PROB30'&&g.fields.includes('visibility'));
  assert.ok(wind,q.taf);assert.ok(fog,q.taf);
  assert.ok(!fog.fields.includes('wind'),q.taf);
  assert.equal(q.groups[0].kind,'BECMG');
  assert.equal(q.checks.ok,true);
}
{
  const q=gen(Array.from({length:12},(_,i)=>row(i,{vis:8000,fgScore:i>=4?80:0,fgAlt:i>=4?800:null})));
  assert.ok(q.groups.some(g=>g.kind==='BECMG'),q.taf);
  assert.ok(!q.groups.some(g=>g.kind==='PROB30'),q.taf);
}
{
  const q=gen(Array.from({length:12},(_,i)=>row(i,{vis:8000,fgScore:i>=4?60:0,fgAlt:i>=4?900:null})));
  assert.ok(q.groups.some(g=>g.kind==='PROB30'),q.taf);
  assert.ok(!q.groups.some(g=>g.kind==='BECMG'),q.taf);
}
{
  const q=gen(Array.from({length:12},(_,i)=>row(i,{kt:i>=3?22:6})));
  assert.ok(q.groups.some(g=>g.kind==='BECMG'&&g.fields.includes('wind')),q.taf);
  assert.ok(!q.groups.some(g=>g.kind==='PROB30'),q.taf);
}
console.log('TAF group classification priority and grounded confidence: OK');
