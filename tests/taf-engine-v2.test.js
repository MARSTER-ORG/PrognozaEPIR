'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const E=require('../taf-engine-v2.js');
const H=3600000,KT=1.9438444924406,FT=3.2808398950131;
const start=Date.UTC(2026,8,14,0),end=start+12*H,issue=start-H;
function model({vis=12000,code=0,kt=6,dir=220,g=6,w=1,ceilM=null}={}){return{vis,code,ws:kt/KT,wd:dir,g:g/KT,w,ceil:ceilM===null?null:ceilM};}
function row(i,o={}){
  const profile=o.profile!==undefined?o.profile:[{agl:200,cc:0},{agl:2500,cc:0}];
  const members=o.mv||[model({vis:o.vis??12000,code:o.code??0,kt:o.kt??6,dir:o.dir??220,g:o.gust??o.kt??6}),model({vis:o.vis??12000,code:o.code??0,kt:o.kt??6,dir:o.dir??220,g:o.gust??o.kt??6}),model({vis:o.vis??12000,code:o.code??0,kt:o.kt??6,dir:o.dir??220,g:o.gust??o.kt??6})];
  return{t:start+i*H,T:o.T??10,Td:o.Td??7,RH:o.RH??70,RR:o.RR??0,VIS:o.vis??12000,WS:(o.kt??6)/KT,WD:o.dir??220,G:(o.gust??o.kt??6)/KT,wet:o.wet??0,storm:o.storm??0,dirSpread:o.dirSpread??10,profile,ceiling:o.ceiling??null,lowH:o.lowH??null,midH:o.midH??null,highH:o.highH??null,oktaL:o.oktaL??0,oktaM:o.oktaM??0,oktaH:o.oktaH??0,mv:members,fogRisk:o.fogRisk??0,fgRisk:o.fgRisk??null,brRisk:o.brRisk??null,fogVis1000Risk:o.fogVis1000Risk??null,fogAltVisM:o.fogAltVisM??null,brAltVisM:o.brAltVisM??null,preciseTiming:o.preciseTiming??false};
}
const gen=(rows,opt={})=>E.createEngine().generate({station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true,...opt});
assert.equal(E.ENGINE_VERSION,'2.3.0');
assert.equal(E.RULES.authority,'Instrukcja opracowywania prognoz TAF, Edycja (A), 11.2023');
assert.equal(E.RULES.prob40,false);assert.equal(E.RULES.verticalVisibility,false);assert.equal(E.RULES.maxChangeGroups,5);
assert.throws(()=>E.createEngine().generate({station:'EPIR',issue,start,end:start+10*H,rows:Array.from({length:10},(_,i)=>row(i)),rowsAlreadyAnchored:true}),/12 h/);

// Visibility encoding and wind encoding.
const V=E.helpers.visibilityToken;assert.equal(V(799),'0750');assert.equal(V(1499),'1400');assert.equal(V(4999),'4900');assert.equal(V(5000),'5000');assert.equal(V(9999),'9000');assert.equal(V(10000),'9999');
const W=E.helpers.windToken;assert.equal(W({windKt:.4,windDir:220,gustKt:5,dirSpreadDeg:0}),'00000KT');assert.equal(W({windKt:13,windDir:274,gustKt:23,dirSpreadDeg:0}),'27014G24KT');assert.equal(W({windKt:2,windDir:220,gustKt:2,dirSpreadDeg:10}),'22002KT');assert.equal(W({windKt:2,windDir:220,gustKt:2,dirSpreadDeg:10,forceVrb:true}),'VRB02KT');

// Null/missing cloud values may NEVER become SCT/BKN000.
let noCloud=E.helpers.stateFromRow(row(0,{profile:[],ceiling:null,lowH:null,midH:null,highH:null,oktaL:0,oktaM:0,oktaH:0}));
assert.equal(E.helpers.selectedClouds(noCloud,null).length,0);assert.ok(!E.helpers.encodeFullState(noCloud,null).includes('000'));

// Profile is authoritative for table+TAF; do not extrapolate clouds down to 0 m.
let profileRow=row(0,{profile:[{agl:120,cc:35},{agl:250,cc:65},{agl:900,cc:80}],ceiling:250});
let state=E.helpers.stateFromRow(profileRow),clouds=E.helpers.selectedClouds(state,null);
assert.equal(clouds[0].cover,'SCT');assert.ok(clouds[0].m>=100,'cloud base must stay near first real profile level');
assert.ok(clouds.some(c=>c.cover==='BKN'&&c.m>=180&&c.m<=300),JSON.stringify(clouds));
assert.ok(Math.abs(state.ceilingFt/FT-250)<80);

// TEMPO may fluctuate FG/BR already prevailing, but may not introduce them.
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 27004KT 7000 NSC TEMPO 1404/1406 2600 BR=',{issue,start,end}).ok,false);
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 27004KT 9999 NSC TEMPO 1404/1406 0800 FG=',{issue,start,end}).ok,false);
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 27004KT 3000 BR NSC TEMPO 1404/1406 2000 BR=',{issue,start,end}).ok,true);
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 27004KT 0800 FG OVC004 TEMPO 1404/1406 0400 FG OVC002=',{issue,start,end}).ok,true);

// PROB30: if FG is more probable than BR, encode FG alternative, not mean-vis BR.
let rows=Array.from({length:12},(_,i)=>row(i,{vis:7000}));
rows[5]=row(5,{vis:2600,fgRisk:42,brRisk:35,fogRisk:60,fogAltVisM:700,mv:[model({vis:700,code:45,w:.42}),model({vis:3000,w:.35}),model({vis:9000,w:.23})]});
let r=gen(rows);assert.match(r.taf,/PROB30\s+1404\/1406\s+0\d{3}\s+(?:FZ)?FG/);assert.ok(!/TEMPO\s+1405/.test(r.taf));

// FOG ENGINE >=50% is independent prevailing FG evidence even when deterministic VIS stays high.
rows=Array.from({length:12},(_,i)=>row(i,{vis:8000,fogRisk:i>=4?65:0,fgRisk:i>=4?65:0,fogVis1000Risk:i>=4?55:0,fogAltVisM:800}));
r=gen(rows);assert.ok(r.taf.includes('BECMG'),r.taf);assert.match(r.taf,/BECMG[^\n]*0\d{3} (?:FZ)?FG/,r.taf);

// FOG ENGINE 30-49% must create PROB30 even with no deterministic threshold crossing.
rows=Array.from({length:12},(_,i)=>row(i,{vis:8000,fogRisk:i===5?40:0,fgRisk:i===5?40:0,fogVis1000Risk:i===5?35:0,fogAltVisM:900}));
r=gen(rows);assert.match(r.taf,/PROB30\s+1404\/1406\s+0900\s+(?:FZ)?FG/,r.taf);

// PROB30 BR: one 2h probability window, never duplicate TEMPO/BECMG for the same event.
rows=Array.from({length:12},(_,i)=>row(i,{vis:7000}));
rows[5]=row(5,{vis:2800,fgRisk:10,brRisk:40,fogRisk:45,brAltVisM:2800,mv:[model({vis:2800,w:.4}),model({vis:7000,w:.6})]});
r=gen(rows);assert.match(r.taf,/PROB30\s+1404\/1406\s+2800\s+BR/);assert.equal((r.taf.match(/PROB30/g)||[]).length,1,r.taf);assert.ok(!r.taf.includes('TEMPO'),r.taf);assert.ok(!r.taf.includes('BECMG'),r.taf);

// An isolated last-hour deterioration cannot be promoted to lasting BECMG.
rows=Array.from({length:12},(_,i)=>row(i,{vis:i===11?2800:7000,brRisk:i===11?70:0,fogRisk:i===11?70:0}));
r=gen(rows);assert.ok(!r.taf.includes('BECMG'),r.taf);

// Persistent new BR >=50% may be BECMG and must contain BR when visibility remains <=5000.
rows=Array.from({length:12},(_,i)=>row(i,{vis:i<5?7000:2800,brRisk:i<5?0:70,fogRisk:i<5?0:70,brAltVisM:2800}));
r=gen(rows);assert.ok(r.taf.includes('BECMG'),r.taf);assert.match(r.taf,/BECMG[^\n]*2800 BR/);

// Significant ceiling transition uses all target cloud groups and table carries metres.
rows=Array.from({length:12},(_,i)=>row(i,{vis:9999,profile:i<4?[{agl:100,cc:35},{agl:900,cc:65},{agl:1600,cc:80}]:[{agl:120,cc:35},{agl:250,cc:65},{agl:900,cc:80}],ceiling:i<4?900:250}));
r=gen(rows);const cloudG=r.groups.find(g=>g.fields.includes('clouds'));assert.ok(cloudG,r.taf);assert.match(cloudG.payload,/(?:FEW|SCT)\d{3}/);assert.match(cloudG.payload,/(?:BKN|OVC)\d{3}/);assert.ok(r.hourly[4].tafDisplay.ceilingM>=150&&r.hourly[4].tafDisplay.ceilingM<=300);assert.ok(r.hourly[4].tafDisplay.cloudLayers.every(c=>Number.isFinite(c.m)));

// Recent METAR/SPECI must reject unsupported model-only thin cloud layers while retaining a supported ceiling.
rows=Array.from({length:12},(_,i)=>row(i,{vis:9999,kt:6,dir:200,profile:[{agl:61,cc:6.25},{agl:457,cc:31.25},{agl:1067,cc:62.5},{agl:1500,cc:70}],ceiling:1067}));
const obs={raw:'EPIR 132100Z AUTO 17008KT 9999 FEW028 BKN035 BKN042 18/14 Q1017',obs_time:new Date(start-3*H).toISOString()};
r=gen(rows,{observation:obs,rowsAlreadyAnchored:false});
assert.match(r.base.text,/\bBKN035\b/,r.base.text);assert.ok(!/\bFEW\d{3}\b/.test(r.base.text),r.base.text);assert.ok(!/\bSCT\d{3}\b/.test(r.base.text),r.base.text);

// Sustained light-wind hours are displayed as VRB02KT, but weak wind changes alone must not invent BECMG.
rows=Array.from({length:12},(_,i)=>row(i,{kt:i<7?6:2,dir:[200,200,200,200,200,200,200,210,240,280,320,20][i]}));
r=gen(rows);for(let i=7;i<12;i++)assert.equal(r.hourly[i].tafDisplay.wind,'VRB02KT');assert.ok(!r.taf.includes('BECMG'),r.taf);

// Existing project rule: >=75% of the 12 h at <=02KT, with no remaining hour >10KT, makes the prevailing base VRB02KT.
rows=Array.from({length:12},(_,i)=>row(i,{kt:i<9?2:6,dir:(180+i*20)%360}));
r=gen(rows);assert.match(r.base.text,/^VRB02KT\b/,r.base.text);

// Hard gate basics.
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 22008KT CAVOK PROB40 1404/1406 3000 BR=',{issue,start,end}).ok,false);
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 22008KT 0500 FG VV002=',{issue,start,end}).ok,false);
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 22008KT 0500 MIFG NSC=',{issue,start,end}).ok,false);

// HTML/app must use only Engine 2.1, profile data and metre cloud display; no post-mutator stack.
const html=fs.readFileSync(path.join(__dirname,'..','taf.html'),'utf8'),app=fs.readFileSync(path.join(__dirname,'..','taf-app-v2.js'),'utf8');
for(const legacy of ['taf-generator-policy.js','taf-cloud-policy.js','taf-weather-policy.js','taf-gust-policy.js','taf-cavok-nsc-policy.js','taf-instruction-guard.js','taf-output-sanitizer.js','taf-hybrid-adapter.js'])assert.ok(!html.includes(legacy),'legacy mutator loaded: '+legacy);
assert.ok(html.includes('taf-engine-v2.js?v=2.3.0'));assert.ok(html.includes('taf-app-v2.js?v=2.3.0'));assert.ok(html.includes('Chmury (m AGL)'));assert.ok(html.includes('Pułap BKN/OVC (m AGL)'));
assert.ok(app.includes('profile:Array.isArray(z.profile)'),'app must transfer vertical cloud profile into TAF engine');assert.ok(app.includes('cloudLayers'),'table must render engine cloud layers');assert.ok(app.includes('const fgRisk=Math.max(fogScore'),'FOG score must feed FG probability directly');
console.log('TAF Engine 2.3 tests: OK');
