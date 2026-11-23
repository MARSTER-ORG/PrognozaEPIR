'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const wx=require('../meteogram-precipitation-types.js');

const cases=[
  [{weather_code:51,precipitation:.1},'DZ'],
  [{weather_code:57,precipitation:.1},'FZDZ'],
  [{weather_code:61,precipitation:.4},'RA'],
  [{weather_code:67,precipitation:.2},'FZRA'],
  [{weather_code:73,precipitation:.5},'SN'],
  [{weather_code:77,precipitation:.2},'SG'],
  [{weather_code:79,precipitation:.2},'PL'],
  [{weather_code:80,precipitation:.3},'SHRA'],
  [{weather_code:83,precipitation:.3},'SHRASN'],
  [{weather_code:84,precipitation:.3},'SHRASN'],
  [{weather_code:86,precipitation:.3},'SHSN'],
  [{weather_code:87,precipitation:.3},'SHGS'],
  [{weather_code:90,precipitation:.3},'SHGR'],
  [{weather_code:95,precipitation:.3},'TS'],
  [{weather_code:95,rain:.3,precipitation:.4},'TSRA'],
  [{weather_code:95,snowfall:.3,precipitation:.4},'TSSN'],
  [{weather_code:96,precipitation:.4},'TSGR'],
  [{weather_code:99,precipitation:.4},'TSGR'],
  [{weather_code:68,precipitation:.4},'RASN'],
  [{weather_code:61,rain:.2,snowfall:.1,precipitation:.5},'RASN'],
  [{weather_code:80,rain:.2,snowfall:.1,precipitation:.5},'SHRASN'],
  [{weather_code:0,rain:.2,showers:.4,precipitation:.6},'SHRA'],
  [{weather_code:0,snowfall:.4,precipitation:.6},'SN'],
  [{weather_code:0,precipitation:.2},'PCP']
];
for(const [row,code] of cases){
  assert.equal(wx.classify(row)?.code,code,JSON.stringify(row));
}
for(const row of [null,{}, {weather_code:0,precipitation:0}, {weather_code:3,precipitation:null}, {weather_code:NaN,precipitation:NaN}, {weather_code:79.6}]){
  assert.equal(wx.classify(row),null,'no invented precipitation');
}
const disagreement=wx.aggregate([
  {weather_code:61,precipitation:1,w:.5},
  {weather_code:71,precipitation:1,w:.5}
]);
assert.equal(disagreement.code,'VAR');
assert.match(disagreement.label,/modele niezgodne/);
assert.notEqual(disagreement.code,'RASN','a split ensemble is not simultaneous mixed rain/snow');
assert.equal(disagreement.agreementPct,50);
const winner=wx.aggregate([
  {weather_code:80,precipitation:2,w:.7},
  {weather_code:61,precipitation:1,w:.2},
  {weather_code:0,precipitation:0,w:.1}
]);
assert.equal(winner.code,'SHRA');
assert.equal(winner.agreementPct,78);
assert.equal(winner.supportPct,90);
assert.equal(wx.aggregate([{weather_code:0,precipitation:0,w:1}]),null);
const samePhase=wx.aggregate([
  {weather_code:61,precipitation:1,w:.40},
  {weather_code:80,precipitation:1,w:.35},
  {weather_code:71,precipitation:1,w:.25}
]);
assert.equal(samePhase.code,'RA','rain and rain showers share liquid phase');
assert.equal(samePhase.phaseAgreementPct,75);
assert.match(samePhase.label,/charakter niepewny/,'shower character must remain uncertain');
assert.equal(samePhase.character,'niepewny');
const strongerSnow=wx.aggregate([
  {weather_code:61,precipitation:1,w:.25},
  {weather_code:71,precipitation:1,w:.75}
]);
assert.equal(strongerSnow.code,'SN','stronger model phase votes snow');
assert.equal(strongerSnow.phaseAgreementPct,75);
const genuineMixed=wx.aggregate([
  {weather_code:68,precipitation:1,w:.6},
  {weather_code:69,precipitation:1,w:.2},
  {weather_code:61,precipitation:1,w:.2}
]);
assert.equal(genuineMixed.code,'RASN','explicit mixed weather is distinct from model disagreement');
assert.equal(genuineMixed.phaseAgreementPct,80);
const rareUncorroborated=wx.aggregate([
  {weather_code:96,precipitation:1,w:.8},
  {weather_code:61,precipitation:1,w:.2}
]);
assert.equal(rareUncorroborated.code,'VAR','single hail model must not create decisive hail claim');
assert.equal(wx.aggregate([{weather_code:0,precipitation:.3,w:1}]).code,'PCP');

assert.equal(wx.colorFor({precipType:wx.classify({weather_code:86})}),wx.TYPES.SHSN.color);
assert.equal(wx.tooltipRows({precipType:winner})[0][1],winner.label);

const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const pages=fs.readFileSync(path.join(root,'scripts/prepare_pages.py'),'utf8');
const layout=fs.readFileSync(path.join(root,'meteogram-layout-v2.js'),'utf8');
const split=fs.readFileSync(path.join(root,'meteogram-visfog-split.js'),'utf8');
const hover=fs.readFileSync(path.join(root,'visual-style-fix.js'),'utf8');
const legend=fs.readFileSync(path.join(root,'meteogram-visfog-cleanup.js'),'utf8');
assert.match(html,/'rain','showers','snowfall'/);
assert.match(html,/k==='weather_code'\?\(q<\.5\?/,'WMO is categorical, not linear');
assert.match(html,/meteogram-precipitation-types\.js/);
assert.match(pages,/meteogram-precipitation-types\.js/);
assert.ok(pages.indexOf('f\'<script src="meteogram-precipitation-types.js?v=')
  >pages.indexOf('f\'<script src="meteogram-tap-details.js?v='),'install after latest tooltip overlays');
for(const [source,name] of [[html,'inline'],[layout,'layout'],[split,'production split']])
  assert.match(source,/PrognozaEPIRPrecipitation\?\.colorFor\?\.\(z\)/,name+' must color precipitation bars');
assert.match(hover,/PrognozaEPIRPrecipCompactInfo\?\.rows\(z\)/,'mouse hover uses user-selected precipitation fields');
assert.match(legend,/TS \/ GR — konwekcja/,'rain, snow, convection symbols in legend');

// Runtime smoke test in a small Canvas environment: no network, no browser dependencies.
const src=fs.readFileSync(path.join(root,'meteogram-precipitation-types.js'),'utf8');
const fills=[];
const ctx={save(){},restore(){},beginPath(){},rect(){},clip(){},fillRect(...args){fills.push(args);},
  measureText(v){return{width:v.length*6}},fillText(){}};
const sandbox={
  document:{querySelector(){return null}},
  ctx,cv:{_meta:null},series:[{t:0,RR:1}],selected:'consensus',
  MODELS:[{id:'rain',w:.25},{id:'snow',w:.75}],
  datasets:new Map([
    ['rain',{rows:[{weather_code:61,precipitation:1}]}],
    ['snow',{rows:[{weather_code:71,precipitation:1}]}]
  ]),
  sample(ds){return ds.rows[0];}
};
vm.runInNewContext('function dataVisible(){return series;}\n'+
  'function draw(){cv._meta={data:dataVisible(),x0:10,x1:610,t0:0,t1:3600000,panelYs:[{id:"prec",y:30,h:90}]};}\n'+
  'function showSectionInfo(){}\n'+src+'\ndraw();',sandbox);
assert.equal(sandbox.cv._meta.data[0].precipType.code,'SN','stronger model must choose snowfall');
assert.ok(fills.length>=1,'Canvas marker visible');
assert.equal(typeof sandbox.PrognozaEPIRPrecipitation.tooltipRows,'function');
console.log('Precipitation types: '+cases.length+' WMO/model samples, missing-data guards, voting, wiring and Canvas smoke OK');
