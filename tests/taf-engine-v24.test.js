'use strict';
const assert=require('assert');
const Core=require('../taf-engine-v2.js');
const E=require('../taf-engine-v24.js');
const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,8,14,0),end=start+12*H,issue=start-H;

function member(id,{vis=12000,code=0,kt=6,dir=220,g=6,w=1}={}){
  return{id,model:id,vis,code,ws:kt/KT,wd:dir,g:g/KT,w,ceil:null};
}
function row(i,o={}){
  const mv=o.mv||[
    member('m1',{vis:o.vis??12000,code:o.code??0}),
    member('m2',{vis:o.vis??12000,code:o.code??0}),
    member('m3',{vis:o.vis??12000,code:o.code??0})
  ];
  return{t:start+i*H,T:o.T??10,Td:o.Td??7,RH:70,RR:0,VIS:o.vis??12000,WS:(o.kt??6)/KT,WD:o.dir??220,G:(o.gust??o.kt??6)/KT,wet:o.wet??0,storm:o.storm??0,dirSpread:10,profile:[{agl:200,cc:0},{agl:2500,cc:0}],ceiling:null,lowH:null,midH:null,highH:null,oktaL:0,oktaM:0,oktaH:0,mv,fogRisk:o.fogRisk??0,fgRisk:o.fgRisk??null,brRisk:o.brRisk??null,fogOperationalScore:o.fogOperationalScore??null,fgOperationalScore:o.fgOperationalScore??null,brOperationalScore:o.brOperationalScore??null,fogAltVisM:o.fogAltVisM??null};
}
const baseRows=()=>Array.from({length:12},(_,i)=>row(i));
const generate=(engine,rows=baseRows(),extra={})=>engine.createEngine().generate({station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true,...extra});

assert.equal(E.ENGINE_VERSION,'2.4.0');
assert.equal(E.FORMAL_KERNEL_VERSION,'2.3.0');
assert.strictEqual(E.RULES,Core.RULES);
assert.equal(E.INSTRUCTION,'Instrukcja opracowywania prognoz TAF, Edycja (A), 11.2023');

// Neutral learning must not alter the TAF text when no midnight DD24 canonicalization is needed.
E.setLearningData({adaptive:null,fog:null,verification:null});
const coreNeutral=generate(Core);
const v24Neutral=generate(E);
assert.equal(v24Neutral.taf,coreNeutral.taf);
assert.equal(v24Neutral.version,'2.4.0');
assert.equal(v24Neutral.diagnostics.formalKernelVersion,'2.3.0');
assert.equal(v24Neutral.diagnostics.postGenerationMutation,false);
assert.equal(v24Neutral.checks.ok,true);

// Per-model/per-lead adaptive weights from verified EPIR history are applied
// before the formal kernel sees ensemble members.
E.setLearningData({adaptive:{schema:'prognozaepir-adaptive-weights-v1',generated_at:'2026-09-14T00:00:00Z',models:{
  m1:{lead_buckets:{'0-3h':{weight_factor:1.20,components:{visibility:{weight_factor:1.30},precipitation:{weight_factor:1.10}}}}},
  m2:{lead_buckets:{'0-3h':{weight_factor:0.80,components:{visibility:{weight_factor:0.75},precipitation:{weight_factor:0.90}}}}},
  m3:{lead_buckets:{'0-3h':{weight_factor:1.00,components:{visibility:{weight_factor:1.00},precipitation:{weight_factor:1.00}}}}}
}},fog:null,verification:null});
let prepared=E.helpers.prepareRows({issue,rows:[row(0)]});
assert.equal(prepared[0].taf24LeadBucket,'0-3h');
assert.equal(Number(prepared[0].mv[0].w.toFixed(2)),1.20);
assert.equal(Number(prepared[0].mv[1].w.toFixed(2)),0.80);

// MOS correction uses only verified continuous biases that are safe for TAF.
// Visibility is intentionally left untouched because METAR 9999 is censored;
// wind direction is not double-corrected on top of the canonical EPIR sector rule.
E.setLearningData({adaptive:null,fog:null,verification:{schema:'prognozaepir-model-verification-v1',models:{consensus:{diagnostics:{by_lead_bucket:{'0-3h':{
  continuous:{temperature:{bias:2},dew_point:{bias:-1},visibility_exact:{bias:9000}},
  wind:{wind_speed:{bias_ms:1.5},wind_direction:{circular_bias_deg:35}}
}}}}}}});
prepared=E.helpers.prepareRows({issue,rows:[row(0,{T:10,Td:7,vis:6000,kt:10,dir:220})]});
assert.equal(prepared[0].T,8);
assert.equal(prepared[0].Td,8);
assert.ok(Math.abs(prepared[0].WS-(10/KT-1.5))<1e-9);
assert.equal(prepared[0].VIS,6000);
assert.equal(prepared[0].WD,220);
assert.equal(prepared[0].taf24Mos.visibilityBiasApplied,false);
assert.equal(prepared[0].taf24Mos.windDirectionBiasApplied,false);

// Event probability calibration uses model skill when there is no dedicated
// operational FOG score.
E.setLearningData({adaptive:{schema:'prognozaepir-adaptive-weights-v1',models:{
  m1:{lead_buckets:{'0-3h':{weight_factor:1,components:{visibility:{weight_factor:1.3}}}}},
  m2:{lead_buckets:{'0-3h':{weight_factor:1,components:{visibility:{weight_factor:.7}}}}},
  m3:{lead_buckets:{'0-3h':{weight_factor:1,components:{visibility:{weight_factor:1}}}}}
}},fog:{schema:'prognozaepir-fog-event-skill-v1',models:{
  m1:{lead_buckets:{'0-3h':{weight_factor:1.2}}},m2:{lead_buckets:{'0-3h':{weight_factor:.8}}},m3:{lead_buckets:{'0-3h':{weight_factor:1}}}
}},verification:null});
prepared=E.helpers.prepareRows({issue,rows:[row(0,{vis:5000,mv:[member('m1',{vis:700,code:45}),member('m2',{vis:7000}),member('m3',{vis:7000})]})]});
assert.ok(prepared[0].fgRisk>1/3,prepared[0].fgRisk);
assert.equal(prepared[0].taf24Calibration.operationalFogGate,'model-skill-weighted');

// Dedicated FOG engine remains authoritative: model calibration cannot bypass
// its 60/100 operational threshold for a TAF FG probability group.
const gated=baseRows();
gated[5]=row(5,{vis:7000,fogOperationalScore:49,fgOperationalScore:49,fogAltVisM:700,mv:[member('m1',{vis:700,code:45,w:.8}),member('m2',{vis:7000,w:.1}),member('m3',{vis:7000,w:.1})]});
const gatedResult=generate(E,gated);
assert.equal((gatedResult.taf.match(/PROB30/g)||[]).length,0,gatedResult.taf);
assert.ok(!/\b(?:FG|FZFG)\b/.test(gatedResult.taf),gatedResult.taf);
assert.equal(gatedResult.checks.ok,true);
assert.equal(gatedResult.learning.ruleMutation,false);

// EPIR 11Z issue: 12-24Z validity must be encoded as 1512/1524, not 1512/1600.
{
  const s=Date.UTC(2026,8,15,12),e=s+12*H,iss=s-H;
  const rows=baseRows().map((r,i)=>({...r,t:s+i*H}));
  const q=E.createEngine().generate({station:'EPIR',issue:iss,start:s,end:e,rows,rowsAlreadyAnchored:true});
  assert.match(q.taf,/^TAF EPIR 151100Z 1512\/1524\s/);
  assert.ok(!q.taf.includes('1512/1600'),q.taf);
  assert.equal(E.validateTaf(q.taf,{issue:iss,start:s,end:e}).ok,true);
}

// The formal validator remains the single Instruction 11/2023 gate.
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 22004KT CAVOK=',{issue,start,end}).ok,true);
assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 22004KT CAVOK PROB40 1404/1406 0800 FG=',{issue,start,end}).ok,false);

console.log('TAF Engine 2.4 probabilistic facade: OK');
