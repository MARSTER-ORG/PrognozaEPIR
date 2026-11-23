'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const api=require('../meteogram-precipitation-intelligence.js');
const types=require('../meteogram-precipitation-types.js');
const H=3600000,T=Date.UTC(2026,10,23,12);
const profile=[{agl:100,cc:94},{agl:550,cc:88},{agl:1600,cc:15},{agl:3000,cc:10}];
const base={
  RR:.14,RH:96,T:8,Td:7,storm:4,
  low:92,mid:22,lowH:180,profile,modelCount:8
};
function wx(code,extras={}){
  return {...types.TYPES[code],phaseFamily:code==='SN'?'snow':'rain',
    phaseAgreementPct:88,characterAgreementPct:74,wetModelCount:6,modelCount:8,
    codeSharesPct:{DZ:43,RA:45,SHRA:6},codeModelCounts:{DZ:3,RA:4,SHRA:1},...extras};
}
function row(i,code='RA',extras={}){
  return {...base,t:T+i*H,precipType:wx(code),...extras};
}
function trio(){return [row(0,'DZ'),row(1,'RA'),row(2,'DZ')];}
const wet=trio();
assert.equal(api.cloudRegime(wet[1]).id,'shallow_stratiform');
assert.equal(api.drizzleEvidence(wet[1]),true);
assert.equal(api.canRefine(...wet,T-2*H)?.to,'DZ');
const rawValues=wet.map(z=>({RR:z.RR,RH:z.RH,storm:z.storm,original:z.precipType.code}));
assert.strictEqual(api.refine(wet,types,T-2*H),wet);
assert.equal(wet[1].precipType.code,'DZ');
assert.equal(wet[1].precipType.intelligenceAdjusted,true);
assert.equal(wet[1].precipType.intelligenceOriginalCode,'RA');
assert.equal(wet[1].precipIntelligence.supportPct,43);
assert.equal(wet[1].precipCloudContext.regime,'shallow_stratiform');
assert.equal(wet[1].precipCloudContext.changed,true);
assert.ok(api.tooltipRows(wet[1]).some(k=>k[1].includes('RA → DZ*')));
assert.deepEqual(wet.map(z=>({RR:z.RR,RH:z.RH,storm:z.storm,original:z.precipType.intelligenceOriginalCode||z.precipType.code})),rawValues);
api.refine(wet,types,T-2*H);
assert.equal(wet[1].precipType.code,'DZ','repeat runs must be idempotent');
const cases=[
  ['two degrees above freezing is not enough', {T:1.5}],
  ['cold rain may require refreezing risk study', {T:-1,Td:-2}],
  ['strong model rain majority', {precipType:wx('RA',{codeSharesPct:{DZ:20,RA:72,SHRA:3}})}],
  ['only one drizzle model', {precipType:wx('RA',{codeModelCounts:{DZ:1,RA:5}})}],
  ['low drizzle vote', {precipType:wx('RA',{codeSharesPct:{DZ:15,RA:65,SHRA:10}})}],
  ['not enough rain models', {precipType:wx('RA',{wetModelCount:3})}],
  ['convective weather cannot become drizzle', {precipType:wx('SHRA')}],
  ['no cloud base', {lowH:null}],
  ['no mid-level cloud cover', {mid:null}],
  ['missing vertical profile', {profile:[]}],
  ['weak low cloud cover', {low:55}],
  ['high mid level cover', {mid:80}],
  ['incomplete humidity', {RH:null}],
  ['dry air below cloud', {Td:2}],
  ['elevated storm signal', {storm:60}],
  ['TCu model evidence', {precipEvidence:{tcuModelSignal:true}}],
  ['modelled Cu shower support', {precipEvidence:{marker:'cu'}}],
  ['fresh radar confirmation', {precipEvidence:{radarForecastEcho:true}}],
  ['stronger current precipitation', {RR:.8}],
  ['no current precipitation', {RR:0}],
  ['rain/snow phase disagreement', {precipType:wx('VAR')}],
  ['freezing rain', {precipType:wx('FZRA')}],
  ['ice pellets', {precipType:wx('PL')}],
  ['snow grains', {precipType:wx('SG')}]
];
for(const [name,change] of cases){
  const r=trio();r[1]={...r[1],...change};
  assert.equal(api.canRefine(...r,T-2*H),null,name);
  const before=r[1].precipType.code;
  api.refine(r,types,T-2*H);
  assert.equal(r[1].precipType.code,before,name);
}
const empty=trio();empty[0].t-=2*H;
assert.equal(api.canRefine(...empty,T-2*H),null,'hourly gap');
const neighbour=trio();neighbour[0].precipType=wx('RA',{codeSharesPct:{DZ:0,RA:93},codeModelCounts:{DZ:0}});neighbour[2].precipType=wx('RA',{codeSharesPct:{DZ:0,RA:92},codeModelCounts:{DZ:0}});
assert.equal(api.canRefine(...neighbour,T-2*H),null,'no temporal corroboration from DZ');
const peak=trio();peak[1].RR=.32;peak[0].RR=.05;peak[2].RR=.08;
assert.equal(api.canRefine(...peak,T-2*H),null,'intensity spike');
assert.equal(api.canRefine(...trio(),T-49*H),null,'no tentative weather type correction beyond 48h');
const changed=trio();api.refine(changed,types,T-2*H);changed[1].precipEvidence={convectiveNwp:true};
api.refine(changed,types,T-2*H);
assert.equal(changed[1].precipType.code,'RA','new convection evidence must restore original code');
assert.equal(changed[1].precipIntelligence,null);
const deep=row(1,'RA',{RR:1.1,low:95,mid:82,RH:94});
const deepTrio=[row(0,'RA',{RR:.9,low:94,mid:82,RH:94}),
  row(1,'DZ',{RR:.95,low:94,mid:82,RH:94,
    precipType:wx('DZ',{codeSharesPct:{DZ:43,RA:38,SHRA:5},
      codeModelCounts:{DZ:3,RA:3}})}),
  row(2,'RA',{RR:.85,low:94,mid:82,RH:94})];
assert.equal(api.canRefine(...deepTrio,T-2*H)?.to,'RA','deep cloud layer supports steady rain');
api.refine(deepTrio,types,T-2*H);
assert.equal(deepTrio[1].precipType.code,'RA');
assert.equal(deepTrio[1].precipType.intelligenceOriginalCode,'DZ');
assert.equal(deepTrio[1].precipIntelligence.supportingType,'RA');
assert.equal(deepTrio[1].precipIntelligence.supportPct,38);
assert.match(deepTrio[1].precipType.label,/Deszcz/);
const deepWeak=[...deepTrio];
deepWeak[1]={...row(1,'DZ',{RR:.9,low:94,mid:82,RH:94}),
  precipType:wx('DZ',{codeSharesPct:{DZ:70,RA:18},
    codeModelCounts:{DZ:5,RA:1}})};
assert.equal(api.canRefine(...deepWeak,T-2*H),null,
  'strong independent model DZ majority is not overruled by cloud proxy');
assert.equal(api.cloudRegime(deep).id,'deep_stratiform');
assert.equal(api.cloudRegime(deep).label.includes('As/Ns'),true);
assert.equal(api.cloudRegime(row(1,'RA',{profile:[]})).id,'insufficient');
assert.equal(api.cloudRegime(row(1,'RA',{RR:0})).id,'none');
const outOfOrder=[row(2,'DZ'),row(0,'DZ'),row(1,'RA')];
api.refine(outOfOrder,types,T-2*H);
assert.equal(outOfOrder[2].precipType.code,'DZ','temporal order determined by UTC');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const pages=fs.readFileSync(path.join(root,'scripts/prepare_pages.py'),'utf8');
const hover=fs.readFileSync(path.join(root,'visual-style-fix.js'),'utf8');
const legend=fs.readFileSync(path.join(root,'meteogram-visfog-cleanup.js'),'utf8');
const typ=fs.readFileSync(path.join(root,'meteogram-precipitation-types.js'),'utf8');
for(const s of [html,pages]){
  const pos=s.indexOf('meteogram-precipitation-intelligence.js');
  assert.ok(pos>=0);
  assert.ok(pos>s.indexOf('meteogram-precipitation-evidence.js'),
    'physically informed refinement must follow independent convection evidence');
  assert.ok(pos<s.indexOf('meteogram-precipitation-continuity.js'),
    'character continuity runs after subtype inference');
}
assert.match(legend,/DZ\* — sugestia St\/Sc/);
assert.match(typ,/wx.intelligenceAdjusted/);
assert.match(hover,/PrognozaEPIRPrecipIntelligence\?\.tooltipRows/);
const src=fs.readFileSync(path.join(root,'meteogram-precipitation-intelligence.js'),'utf8');
const browser={document:{querySelector(){return null}},rows:trio(),
  PrognozaEPIRPrecipitation:types,selected:'consensus'};
const context={...browser,Date:{now:()=>T-2*H,parse:Date.parse}};
vm.runInNewContext('function dataVisible(){return rows;}\nfunction showSectionInfo(){}\n'+src+'\ndataVisible();',context);
assert.equal(context.rows[1].precipType.code,'DZ','browser wrapper applies only in consensus');
context.selected='icon_eu';context.rows=trio();context.dataVisible();
assert.equal(context.rows[1].precipType.code,'RA','single model forecast not modified');
assert.equal(context.PrognozaEPIRPrecipIntelligence?.tooltipRows(context.rows[1]).length,0);
const vote=types.aggregate([{weather_code:51,precipitation:.1,w:.4},
  {weather_code:61,precipitation:.1,w:.5},{weather_code:0,precipitation:0,w:.1}]);
assert.equal(vote.codeSharesPct.DZ,44.4);
assert.equal(vote.codeModelCounts.DZ,1);
assert.equal(vote.codeSharesPct.RA,55.6);
console.log('Cloud-physics rainfall: St/Sc/Ns qualitative proxy, evidence-supported DZ, gaps, ice/convective safety, UTC and UI smoke PASS');
