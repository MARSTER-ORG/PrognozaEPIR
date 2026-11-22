'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const api=require('../meteogram-precipitation-evidence.js');

const H=3600000,now=Date.UTC(2026,10,22,14),point={lat:52.828611,lon:18.330278};
function cloud(patch={}){
  return {time:now+H,tcuProbability:22,cbProbability:13,tsProbability:4,
    modelCount:3,modelAgreement:75,thermodynamicInputs:3,
    modelShowerCount:2,modelShowerSupport:67,...patch};
}
function row(code='SHRA',t=now+H){return {t,RR:0.4,precipType:{code}};}
function snapshot(c=cloud(),at=now){
  return {radar:null,convection:{updatedAt:new Date(at).toISOString(),point,source:'GFS+AIFS+ICON-D2',rows:[c]}};
}
function check(expected,r,c=cloud()){
  assert.equal(api.showerCloud(r,c).status,expected);
}
check('cu_possible',row());
check('compatible',row(),cloud({tcuProbability:50}));
check('compatible',row(),cloud({cbProbability:64}));
check('divergent',row(),cloud({modelShowerCount:0,modelShowerSupport:0}));
check('divergent',row('TSRA'),cloud({modelShowerCount:1,modelShowerSupport:33}));
check('compatible',row('TSRA'),cloud({cbProbability:63}));
check('insufficient',row(),cloud({modelCount:1,modelAgreement:100}));
check('insufficient',row(),cloud({thermodynamicInputs:0}));
check('insufficient',row(),cloud({modelAgreement:40}));
check('no_forecast',row(),null);
check('not_applicable',row('RA'));
check('cu_possible',row('SHSN'),cloud({modelShowerCount:1,modelShowerSupport:33}));
for(const r of [row('SHRA'),row('SHSN'),row('SHRASN')]){
  const ev=api.evaluate(r,snapshot(),now);
  assert.equal(ev.showerCloudStatus,'cu_possible');
  assert.equal(ev.marker,'cu');
  assert.equal(ev.tcu,22,'SH is NOT used to inflate TCu probability');
  assert.equal(ev.cb,13,'SH is NOT used to inflate Cb probability');
  assert.equal(ev.convectiveNwp,false,'shallow Cu is not high-TCu or Cb verification');
  assert.ok(api.tooltipRows({precipEvidence:ev}).some(x=>x[0]==='Spójność SH z TCu/Cb'));
  assert.ok(api.tooltipRows({precipEvidence:ev}).some(x=>x[0]==='TCu / Cb (wskaźnik NWP)'));
}
const mismatch=api.evaluate(row(),snapshot(cloud({modelShowerCount:0,modelShowerSupport:0})),now);
assert.equal(mismatch.marker,'mismatch');
assert.equal(mismatch.showerCloudStatus,'divergent');
const advanced=api.evaluate(row(),snapshot(cloud({tcuProbability:65,cbProbability:15})),now);
assert.equal(advanced.marker,'tcu','TCu must be visible without requiring Cb >=60 or TS>=55');
assert.equal(advanced.convectiveNwp,true);
assert.equal(advanced.deepConvectiveNwp,false);
assert.equal(advanced.tcuModelSignal,true);
const deep=api.evaluate(row(),snapshot(cloud({tcuProbability:72,cbProbability:67})),now);
assert.equal(deep.marker,'convection');
const insufficient=api.evaluate(row(),snapshot(cloud({thermodynamicInputs:0})),now);
assert.equal(insufficient.showerCloudStatus,'insufficient');
assert.equal(insufficient.cloudReliable,false);
assert.equal(insufficient.marker,null);
const far=api.evaluate(row('SHRA',now+13*H),snapshot(),now);
assert.equal(far.showerCloudStatus,'no_forecast');
assert.equal(far.marker,null);
assert.equal(far.tcu,null);
assert.match(far.showerCloudExplanation,/12 godzin/);
for(const bad of [
  {...snapshot().convection,point:{lat:54,lon:19}},
  {...snapshot().convection,updatedAt:new Date(now-3*H).toISOString()}
]){
  assert.equal(api.evaluate(row(),api.read({getItem(k){
    return k===api.KEYS[1]?JSON.stringify(bad):'null';}},now),now).showerCloudStatus,'no_forecast');
}
const legend=fs.readFileSync(path.join(root,'meteogram-visfog-cleanup.js'),'utf8');
const conv=fs.readFileSync(path.join(root,'convection-horizon-12h.js'),'utf8');
const continuity=fs.readFileSync(path.join(root,'meteogram-precipitation-continuity.js'),'utf8');
assert.match(legend,/TCu \/ Cb NWP/);
assert.match(conv,/thermodynamicInputs/);
assert.match(conv,/modelShowerSupport/);
assert.match(conv,/modelShowerCount/);
assert.match(continuity,/e.marker==='cu'/);
const src=fs.readFileSync(path.join(root,'meteogram-precipitation-evidence.js'),'utf8');
const dots=[];
const ctx={save(){},restore(){},beginPath(){},rect(){},clip(){},translate(){},
  moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},arc(...args){dots.push(args)}};
const r=row();
const fakeStore={getItem(k){return k===api.KEYS[1]?JSON.stringify(snapshot().convection):'null'}};
const browser={document:{querySelector(){return null}},localStorage:fakeStore,addEventListener(){}};
const context={window:browser,document:browser.document,ctx,cv:{_meta:{data:[r],
  x0:10,x1:610,t0:now,t1:now+2*H,panelYs:[{id:'prec',y:30,h:90},{id:'storm',y:120,h:70}]}},
  Date:{now:()=>now,parse:Date.parse},Array,Number,Math,Object,JSON,Set,Map,console,
  dataVisible(){return [r];},draw(){},showSectionInfo(){},activeTheme(){return 'dark';}};
vm.createContext(context);
vm.runInContext(src,context);
context.dataVisible();
assert.equal(r.precipEvidence.marker,'cu');
context.draw();
assert.equal(dots.length,0,'below-threshold TCu/Cb must not produce dots');
fakeStore.getItem=k=>k===api.KEYS[1]?JSON.stringify(snapshot(cloud({tcuProbability:48,cbProbability:36})).convection):'null';
context.dataVisible();context.draw();
assert.equal(dots.length,2,'TCu/Cb distinct dots must render in storm panel from independent NWP, not inferred from SH');
console.log('Meteogram SH vs Cu/TCu/Cb: model support, data gaps, NWP quality, radar protection and storm panel dots PASS');
