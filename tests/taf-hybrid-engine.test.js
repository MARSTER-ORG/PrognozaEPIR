'use strict';
const assert=require('assert');
const H=require('../taf-hybrid-engine.js');
const P=require('../taf-generator-policy.js');
const HOUR=3600000, KT=1.9438444924406, FT=3.2808398950131;
const start=Date.UTC(2026,8,12,6), end=start+12*HOUR, issue=start-HOUR;

function model(id,kt,dir,vis=12000,ceil=3000,code=0,gust=kt){
  return{id,w:1,ws:kt/KT,wd:dir,g:gust/KT,vis,ceil:ceil/FT,code};
}
function row(i,opt={}){
  const kt=opt.kt??6, dir=opt.dir??220, vis=opt.vis??12000, ceilFt=opt.ceilFt??6000, code=opt.code??0;
  const r={
    t:start+i*HOUR,WS:kt/KT,WD:dir,G:(opt.gust??kt)/KT,VIS:vis,ceiling:ceilFt/FT,
    lowH:(opt.lowFt??6000)/FT,midH:(opt.midFt??9000)/FT,highH:(opt.highFt??18000)/FT,
    oktaL:opt.oktaL??0,oktaM:opt.oktaM??0,oktaH:opt.oktaH??0,RH:opt.RH??60,RR:opt.RR??0,
    fogRisk:opt.fogRisk??0,mifgRisk:opt.mifgRisk??0,storm:opt.storm??0,wet:opt.wet??0,dirSpread:opt.dirSpread??10,
    mv:[model('A',kt,dir,vis,ceilFt,code,opt.gust??kt),model('B',kt+(opt.delta??0),dir+5,vis,ceilFt,code,opt.gust??kt),model('C',kt,dir-5,vis,ceilFt,code,opt.gust??kt)]
  };
  if(opt.clouds)r.clouds=opt.clouds;
  return r;
}
function engine(){return H.createEngine({storage:{get(){return null},set(){}}});}
function gen(rows,opts={}){return engine().generate({station:'EPIR',issue,start,end,rows,record:false,...opts});}
function genTuned(rows,opts={}){return P.wrapApi(H).createEngine({storage:{get(){return null},set(){}}}).generate({station:'EPIR',issue,start,end,rows,record:false,...opts});}

assert.equal(H.ENGINE_VERSION,'1.0.0');
assert.equal(P.VERSION,'3.1.0');

// Basic syntax/instruction invariants.
let r=genTuned(Array.from({length:12},(_,i)=>row(i)));
assert.match(r.taf,/\bCAVOK\b/);
assert.ok(!r.taf.includes('PROB40'));
assert.ok(!/\bVV\d{3}\b/.test(r.taf));
assert.ok(r.groups.length<=5);
assert.equal(r.tuning.instructionLocked,true);

// 3.6.a: visibility change only after crossing 800/1500/3000/5000 m.
assert.equal(P.visibilityNeedsGroup({visM:10000},{visM:5000}),false,'9999 -> 5000 is same >=5000 band');
assert.equal(P.visibilityNeedsGroup({visM:10000},{visM:6000}),false,'9999 -> 6000 is same >=5000 band');
assert.equal(P.visibilityNeedsGroup({visM:5000},{visM:10000}),false,'5000 -> 9999 is same >=5000 band');
assert.equal(P.visibilityNeedsGroup({visM:10000},{visM:4900}),true,'9999 -> 4900 crosses 5000 m threshold');
assert.equal(P.visibilityNeedsGroup({visM:3000},{visM:5000}),true);
assert.equal(P.visibilityNeedsGroup({visM:1500},{visM:2900}),false);
assert.equal(P.visibilityNeedsGroup({visM:1500},{visM:3000}),true);

// The >=5000 m band must not create a standalone change group.
let rows=Array.from({length:12},(_,i)=>row(i,{vis:i<5?12000:5000}));
r=genTuned(rows);
assert.ok(!r.groups.some(g=>(g.fields||[]).length===1&&g.fields[0]==='visibility'));

// Crossing below 5000 m is significant.
rows=Array.from({length:12},(_,i)=>row(i,{vis:i<5?12000:4900,RH:70}));
r=genTuned(rows);
assert.ok(r.groups.some(g=>(g.fields||[]).includes('visibility')));

// 3.8.10: persistent FEW040 cannot be erased only because a heuristic likes clear weather.
rows=Array.from({length:12},(_,i)=>row(i,{lowFt:4000,oktaL:2}));
r=genTuned(rows);
assert.ok(!r.base.text.includes('CAVOK'));
assert.match(r.base.text,/FEW040/);
assert.ok(r.diagnostics.dominantClear==null||r.diagnostics.dominantClear.advisoryOnly===true);
assert.equal(r.diagnostics.shortHorizonBase.active,false);

// Short-horizon reconciliation: a one-hour/weak 4-5 kft cloud signal must not dominate
// the base when the first 4 h are otherwise CAVOK-compatible and recent METARs confirm clear conditions.
rows=Array.from({length:12},(_,i)=>i===0?row(i,{lowFt:4800,oktaL:4}):i===1?row(i,{lowFt:4100,oktaL:2}):i===2?row(i,{lowFt:4600,oktaL:2}):i===3?row(i,{lowFt:4100,oktaL:2}):row(i,{lowFt:5900,oktaL:2}));
const clearObs=[2,3,4,5].map(h=>({obs_time:new Date(start-(6-h)*HOUR).toISOString(),visibility_m:10000,raw:`METAR EPIR 12${String(h).padStart(2,'0')}00Z 20005KT CAVOK=`}));
r=genTuned(rows,{observations:clearObs,observation:clearObs[clearObs.length-1]});
assert.equal(r.diagnostics.shortHorizonBase.active,true);
assert.match(r.base.text,/\bCAVOK\b/);
assert.ok(r.base.state.windKt>5&&r.base.state.windKt<7,'base wind is blended over short horizon, not copied from one hour');

// Clear observations may not erase a genuinely significant low BKN layer.
rows=Array.from({length:12},(_,i)=>i<4?row(i,{lowFt:4500,oktaL:6,ceilFt:4500}):row(i,{lowFt:5900,oktaL:2}));
r=genTuned(rows,{observations:clearObs,observation:clearObs[clearObs.length-1]});
assert.equal(r.diagnostics.shortHorizonBase.active,false);
assert.ok(!r.base.text.includes('CAVOK'));

// Cloud at/above the 1500 m fallback does not block CAVOK when all other criteria are met.
const cleanHigh={windKt:6,windDir:220,gustKt:6,dirSpreadDeg:10,visM:12000,prob:{},RH:60,RR:0,clouds:[{cover:'FEW',okta:2,ft:5000,type:''}],sourceRow:{}};
assert.equal(P.strictCavokEligible(cleanHigh,null),true);
assert.match(P.encodeStateStrict(cleanHigh,null),/CAVOK/);

// Explicit MSA raises the CAVOK/NSC cloud threshold.
assert.equal(P.strictCavokEligible({...cleanHigh,clouds:[{cover:'FEW',okta:2,ft:5500,type:''}]},6000),false);
assert.match(P.encodeStateStrict({...cleanHigh,clouds:[{cover:'FEW',okta:2,ft:5500,type:''}]},6000),/FEW055/);

// 3.5.3: no project-wide forced VRB02 when a prevailing direction can be forecast.
rows=Array.from({length:12},(_,i)=>row(i,{kt:2,dir:220,dirSpread:10}));
r=genTuned(rows);
assert.match(r.base.text,/^22002KT\b/);
assert.ok(!/^VRB02KT\b/.test(r.base.text));

// Calm remains 00000KT.
rows=Array.from({length:12},(_,i)=>row(i,{kt:0,dirSpread:180}));
r=genTuned(rows);
assert.match(r.base.text,/^00000KT\b/);

// Weak ordinary one-hour rain at good visibility cannot create a standalone change group.
rows=Array.from({length:12},(_,i)=>row(i));
rows[6].RR=.10;rows[6].wet=60;for(const m of rows[6].mv)m.code=61;
r=genTuned(rows);
assert.ok(!r.groups.some(g=>g.event==='precip'&&/^PROB30/.test(g.kind)));

// Moderate precipitation is a significant weather change and is retained.
rows=Array.from({length:12},(_,i)=>row(i));
rows[6].RR=.40;rows[6].wet=90;for(const m of rows[6].mv)m.code=63;
r=genTuned(rows);
assert.ok(r.groups.some(g=>/\bRA\b/.test(g.payload)));

// A convective/shower group may carry 5000-9000 m visibility although that visibility is not itself the trigger.
const prev={windKt:8,windDir:240,gustKt:8,dirSpreadDeg:10,visM:12000,prob:{ts:0,precip:0,frozen:0,fog:0},RR:0,RH:60,clouds:[],sourceRow:{__hybridTuning:{}}};
const shower={windKt:8,windDir:240,gustKt:8,dirSpreadDeg:10,visM:6000,prob:{ts:0,precip:1,frozen:0,fog:0},RR:.10,RH:75,clouds:[{cover:'SCT',okta:4,ft:2000,type:'CB'}],sourceRow:{__hybridTuning:{showerShare:1,protectedEvent:false,moderateOrHeavy:false}}};
assert.equal(P.visibilityNeedsGroup(prev,shower),false);
assert.ok(P.significantFields(prev,shower).includes('convective'));

// Cloud selection: ordinary amounts are encoded cumulatively; CB/TCU remain independent.
const cloudState={visM:6000,prob:{},clouds:[
  {cover:'FEW',okta:2,ft:1000,type:''},
  {cover:'FEW',okta:2,ft:2000,type:''},
  {cover:'SCT',okta:4,ft:3000,type:''},
  {cover:'FEW',okta:2,ft:2500,type:'CB'}
],sourceRow:{}};
const selected=P.selectedClouds(cloudState,null);
assert.ok(selected[0].ft===1000&&selected[0].cover==='FEW');
assert.ok(selected.some(c=>c.type==='CB'));

// Core validation still requires 12 h.
assert.throws(()=>engine().generate({station:'EPIR',issue,start,end:start+10*HOUR,rows:Array.from({length:10},(_,i)=>row(i)),record:false}),/12 h/);

// Learning remains bounded and functional.
const memStore={v:null,get(){return this.v},set(k,v){this.v=v}};
const learnEngine=H.createEngine({storage:memStore});
rows=Array.from({length:12},(_,i)=>row(i));
for(const x of rows)x.mv=[model('A',6,220),model('B',20,220),model('C',8,220)];
learnEngine.generate({station:'EPIR',issue,start,end,rows,record:true});
const obs=[];for(let i=0;i<12;i++)obs.push({obs_time:new Date(start+i*HOUR).toISOString(),wind_speed_ms:6/KT,wind_direction_deg:220,visibility_m:12000,raw:`METAR EPIR 12${String(6+i).padStart(2,'0')}00Z 22006KT CAVOK=`});
assert.ok(learnEngine.learn(obs)>=8);
assert.ok(learnEngine.getLearningSummary().models.A);

console.log('taf-hybrid-engine tests: OK',{version:H.ENGINE_VERSION,tuning:P.VERSION});