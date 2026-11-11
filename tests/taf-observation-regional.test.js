'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const fusion=require('../taf-observation-fusion-v1.js');
const validity=require('../taf-validity-v1.js');
const utc=(h,m=0)=>Date.UTC(2026,10,11,h,m);
const obs=(id,h,m,vis,wx='BR',temperature='02/02')=>({
  station:id,obs_time:new Date(utc(h,m)).toISOString(),
  raw:id+' '+String(11).padStart(2,'0')+String(h).padStart(2,'0')+String(m).padStart(2,'0')+
    'Z AUTO 20008KT '+String(vis).padStart(4,'0')+' '+(wx?wx+' ':'')+'VV002 '+temperature+' Q1009',
  visibility_m:vis
});
const local=[
  obs('EPIR',9,0,3700),
  obs('EPIR',10,0,1200),
  obs('EPIR',10,30,1800),
  obs('EPIR',11,0,1800),
  obs('EPIR',12,0,5000),
];
const neighbors={
  EPBY:{observations:[obs('EPBY',9,0,2700),obs('EPBY',11,0,3500)],
    tafs:[{issue_time:new Date(utc(10,21)).toISOString(),raw:
      'TAF AMD EPBY 111021Z 1110/1206 21008KT 3000 BR BKN002 TEMPO 1122/1206 1000 BR OVC001='}]},
  EPPW:{observations:[obs('EPPW',9,0,500,'FG'),obs('EPPW',11,0,8000,'')],
    tafs:[{issue_time:new Date(utc(11,2)).toISOString(),raw:
      'TAF EPPW 111102Z 1112/1124 16008KT 6000 BKN007 BECMG 1120/1122 3000 BR BKN005='},
      {issue_time:new Date(utc(5)).toISOString(),raw:
      'TAF EPPW 110500Z 1106/1118 21008KT 0600 FG OVC002 BECMG 1108/1111 6000 BKN013='}]},
  EPKS:{observations:[obs('EPKS',9,0,500,'FG'),obs('EPKS',11,0,5000,'BR')],
    tafs:[{issue_time:new Date(utc(11)).toISOString(),raw:
      'TAF EPKS 111100Z 1112/1124 11005KT 6000 BKN007 BECMG 1118/1120 2000 BR BKN003 BECMG 1120/1122 0600 FG OVC001='}]}
};
const snapshot=(issue=utc(11),now=utc(11,30),forecastStart=utc(12),observations=local,neighborsData=neighbors)=>{
  const rawRows=Array.from({length:12},(_,i)=>({t:forecastStart+i*3600000,VIS:10000,
    T:2,Td:2,WS:4,WD:200,mv:[],fogOperationalScore:20}));
  const rows=fusion.adjust(rawRows,{rawRows,observations,neighbors:neighborsData,issue,
    start:forecastStart,now,tafValidity:validity});
  return {rows,rawRows};
};
const parsed=fusion.parseMetar(obs('EPIR',11,0,1800));
assert.equal(parsed.vis,1800);
assert.equal(parsed.br,true);
assert.equal(parsed.saturated,true);
let {rows,rawRows}=snapshot();
assert.ok(rows[0].VIS>=2000&&rows[0].VIS<5000,
  'METAR EPIR 1800 BR at 11 UTC must prevent unsupported 9999 at 12 UTC');
assert.ok(rows[0].brRisk>=.5,'recent confirmed BR and saturation require short-range BR consideration');
assert.equal(rows[0].tafVisNowcast.observationVisM,1800);
assert.equal(rows[0].tafNeighborEvidence.stations.find(x=>x.station==='EPBY').tafLow,true);
assert.equal(rows[0].tafNeighborEvidence.stations.find(x=>x.station==='EPPW').tafLow,false,
  '11:02 TAF must be excluded for the 11:00 TAF issue');
assert.ok(rows[9].VIS>=rows[0].VIS,'METAR observation must decay rather than freeze 12h visibility');
assert.equal(rows.at(-1).VIS,10000,'no interpolation of stale observations across the entire 12h TAF');
const proposed=fusion.parseTaf(neighbors.EPKS.tafs[0],utc(21),utc(11),validity);
assert.equal(proposed.vis,2000,'persistent 18-20 BECMG should hold at 21 before second transition');
const after=fusion.parseTaf(neighbors.EPKS.tafs[0],utc(23),utc(11),validity);
assert.equal(after.vis,600);
assert.equal(fusion.parseTaf(neighbors.EPPW.tafs[0],utc(12),utc(11),validity),null);
assert.equal(fusion.parseTaf(neighbors.EPPW.tafs[1],utc(19),utc(11),validity),null,
  'expired 05:00 TAF must not influence evening');
const past=snapshot(utc(9),utc(9,24),utc(12));
assert.ok(past.rows[0].VIS<=4900,'regional low visibility + persistent local BR should constrain early unfounded improvement');
assert.equal(past.rows[0].tafVisNowcast.observationVisM,3700,
  'must not leak observations measured after the snapshot');
const none=snapshot(utc(11),utc(11,30),utc(12),[obs('EPIR',3,0,1200)],{});
assert.equal(none.rows[0].VIS,10000,'old observation must not indefinitely suppress modeled improvement');
assert.equal(none.rows[0].brRisk,undefined);
const recentClear=snapshot(utc(11),utc(11,30),utc(12),[obs('EPIR',10,0,3500),obs('EPIR',11,0,9000)],{});
assert.ok(recentClear.rows[0].VIS>5000,'rapid locally observed improvement must not be forcibly clamped to 4900');
const src=fs.readFileSync(path.join(__dirname,'../taf-engine-v2.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../taf-app-v25.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../taf.html'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../supabase/functions/taf-gemini/index.ts'),'utf8');
assert.ok(src.includes('fusion.adjust(basicAnchored'));
assert.ok(app.includes("A.getRecent?.('TAF',id,12,true)"));
assert.ok(app.includes('neighborEvidence:data.neighborEvidence'));
assert.ok(app.includes('const asOf=Math.min(period.issue,Date.now())'));
assert.ok(app.includes('epirRecent,neighborTafs,neighborObservations'));
assert.ok(html.includes('taf-observation-fusion-v1.js'));
assert.ok(server.includes('neighborTafs:regional.neighborTafs'));
console.log('EPIR/EPBY/EPPW/EPKS METAR trend, no-lookahead and valid TAF regional fusion: PASS');
