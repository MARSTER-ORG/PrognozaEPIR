'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const fusion=require('../taf-convection-evidence-v1.js');
const guard=require('../taf-ai-compose-guard-v1.js');
const H=3600000,now=Date.UTC(2026,10,18,19),issue=now+H,start=issue+H,end=start+12*H;
const point={lat:52.828611,lon:18.330278};
const store={items:{},getItem(k){return this.items[k]||null;},setItem(k,x){this.items[k]=x;}};
const rows=Array.from({length:12},(_,i)=>({t:start+i*H,storm:10}));
const forecast={updatedAt:new Date(now-300000).toISOString(),point,rows:rows.map(r=>({
  time:r.t,tsProbability:65,tcuProbability:80,cbProbability:70,
  thunderstormProbability:48,cape:820,precipitation:.7,modelCount:3,modelAgreement:83
}))};
const radar={updatedAt:new Date(now-180000).toISOString(),point,frameEnd:(now-240000)/1000,
  confidence:85,sourceProduct:'cmax',predictions:{60:38,120:34},models:{support:2,total:3}};
store.setItem(fusion.KEYS.forecast,JSON.stringify(forecast));
store.setItem(fusion.KEYS.radar,JSON.stringify(radar));
let result=fusion.fusion({rows,issue,start,end,now,store});
assert.equal(result.diagnostics.forecastAvailable,true);
assert.equal(result.diagnostics.radarAvailable,true);
assert.equal(result.rows[0].storm,65,'NWP thunderstorm signal passed to TAF');
assert.equal(result.rows[0].tafConvectiveEvidence.radarCorroborated,true,'Fresh POLRAD + model signal');
assert.equal(result.rows.at(-1).tafConvectiveEvidence.radarCorroborated,false,'Never extend radar to 12h');
assert.equal(result.diagnostics.radarCorroboratedHours>0,true);
result=fusion.fusion({rows,issue:now-5*H,start,end,now,store});
assert.equal(result.diagnostics.forecastAvailable,false,'No future source for past issue');
assert.equal(result.diagnostics.radarAvailable,false,'No radar lookahead');
store.setItem(fusion.KEYS.forecast,JSON.stringify({...forecast,point:{lat:51,lon:21}}));
result=fusion.fusion({rows,issue,start,end,now,store});
assert.equal(result.diagnostics.forecastAvailable,false,'Only EPIR');
store.setItem(fusion.KEYS.forecast,JSON.stringify(forecast));
store.setItem(fusion.KEYS.radar,JSON.stringify({...radar,updatedAt:new Date(now-3600000).toISOString()}));
result=fusion.fusion({rows,issue,start,end,now,store});
assert.equal(result.diagnostics.radarAvailable,false,'Reject old radar data');

const m={start:Date.UTC(2026,10,19),end:Date.UTC(2026,10,19,12),issue:Date.UTC(2026,10,18,23)};
const base='TAF EPIR 182300Z 1900/1912 19012KT 9999 BKN020=';
const candidate='TAF EPIR 182300Z 1900/1912 19012KT 9999 BKN020 TEMPO 1901/1903 4000 SHRA BKN015CB=';
const hours=radarSupport=>Array.from({length:12},(_,i)=>({
  t:m.start+i*H,visM:i>=1&&i<3?4000:10000,
  tafDisplay:{wind:'19012KT',visibility:i>=1&&i<3?'4000':'9999',
    weather:i>=1&&i<3?'-RA':'',clouds:i>=1&&i<3?'BKN015':'BKN020'},
  sourceRow:{tafConvectiveEvidence:{
    radarCorroborated:radarSupport&&i>=1&&i<3,modelTsEvidence:true,
    nwpModels:3,modelAgreement:85,tcuProbability:75,cbProbability:73,
    tsProbability:58,rainMmH:.5}}
}));
const evaluate=(support)=>guard.evaluate({baseTaf:base,candidateTaf:candidate,
  hourly:hours(support),meta:m,validate:()=>({ok:true})});
assert.equal(evaluate(true).accepted,true,'Radar/model backed convective TEMPO');
assert.equal(evaluate(false).reason,'tempo_without_subhourly_evidence');

const page=fs.readFileSync(path.join(__dirname,'../taf.html'),'utf8');
const radarPage=fs.readFileSync(path.join(__dirname,'../radar.html'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../taf-app-v25.js'),'utf8');
const edge=fs.readFileSync(path.join(__dirname,'../supabase/functions/taf-gemini/index.ts'),'utf8');
assert.ok(page.includes('taf-convection-evidence-v1.js'));
assert.ok(page.includes('convection-horizon-12h.js'));
assert.ok(radarPage.includes('taf-convection-evidence-v1.js'));
assert.ok(app.includes('convectionAvailability:'));
assert.ok(edge.includes('convectiveEvidence:'));
console.log('TAF convection NWP/POLRAD fusion + issue-time hard gates: PASS');
