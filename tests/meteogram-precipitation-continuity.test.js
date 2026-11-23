'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const types=require('../meteogram-precipitation-types.js');
const api=require('../meteogram-precipitation-continuity.js');
const H=3600000,START=1700000000000;
function row(i,code,other={}){
  const phase=['SN','SHSN'].includes(code)?'snow':'rain';
  return {t:START+i*H,RR:.3,T:8,storm:5,
    precipType:{...types.TYPES[code],phaseFamily:phase,
      phaseAgreementPct:85,characterAgreementPct:73,supportPct:81,
      wetModelCount:5,modelCount:8},
    ...other};
}
function trio(a='RA',b='SHRA',c='RA',overrides={}){
  return [row(0,a,overrides.a),row(1,b,overrides.b),row(2,c,overrides.c)];
}
const initial=trio();
const original=initial.map(z=>({RR:z.RR,T:z.T,storm:z.storm,code:z.precipType.code}));
assert.equal(api.decide(...initial)?.after,'RA','single weakly corroborated SHRA should be stable RA');
assert.strictEqual(api.stabilize(initial,types),initial);
assert.equal(initial[1].precipType.code,'RA');
assert.equal(initial[1].precipTemporal?.before,'SHRA');
assert.equal(initial[1].precipType?.temporalOriginalCode,'SHRA');
assert.equal(initial[1].precipType.temporalAdjusted,true);
assert.equal(initial[1].precipType.character,'charakter niepewny');
assert.deepEqual(initial.map(z=>({RR:z.RR,T:z.T,storm:z.storm,code:z.precipType.temporalOriginalCode||z.precipType.code})),original);
assert.ok(api.tooltipRows(initial[1]).some(x=>x[1].includes('korekta prezentacji')));
api.stabilize(initial,types);
assert.equal(initial[1].precipType.code,'RA','repeated calls must not accumulate smoothing');
assert.equal(initial[1].precipType.temporalOriginalCode,'SHRA');
const negative=[
 ['radar corroboration',trio('RA','SHRA','RA',{b:{precipEvidence:{radarForecastEcho:true}}})],
 ['convective NWP',trio('RA','SHRA','RA',{b:{precipEvidence:{convectiveNwp:true}}})],
 ['radar at adjacent hour',trio('RA','SHRA','RA',{a:{precipEvidence:{marker:'radar'}}})],
 ['independent high-character vote',trio('RA','SHRA','RA',{b:{precipType:{...row(1,'SHRA').precipType,characterAgreementPct:90}}})],
 ['low phase agreement',trio('RA','SHRA','RA',{b:{precipType:{...row(1,'SHRA').precipType,phaseAgreementPct:60}}})],
 ['low wet probability',trio('RA','SHRA','RA',{b:{precipType:{...row(1,'SHRA').precipType,supportPct:35}}})],
 ['too few wet models',trio('RA','SHRA','RA',{b:{precipType:{...row(1,'SHRA').precipType,wetModelCount:2}}})],
 ['precipitation burst',trio('RA','SHRA','RA',{b:{RR:2.5}})],
 ['thunderstorm signal',trio('RA','SHRA','RA',{b:{storm:60}})],
 ['freezing boundary',trio('RA','SHRA','RA',{b:{T:.5}})],
 ['incomplete intensity',trio('RA','SHRA','RA',{b:{RR:null}})],
 ['true separated shower',trio('RA','SHRA','RA',{b:{t:START+3*H}})],
 ['different phase',trio('RA','SHSN','RA')],
 ['rare hail',trio('RA','SHGR','RA')],
 ['thunder',trio('RA','TSRA','RA')],
 ['true no precipitation',trio('RA','SHRA','RA',{b:{RR:0}})],
 ['do not fabricate convection',trio('SHRA','RA','SHRA')]
];
for(const [desc,series] of negative){
  assert.equal(api.decide(...series),null,desc);
  const before=series[1].precipType.code;
  api.stabilize(series,types);
  assert.equal(series[1].precipType.code,before,desc);
  assert.equal(series[1].precipTemporal,null,desc);
}
const snow=trio('SN','SHSN','SN');
snow.forEach(z=>z.T=-5);
assert.equal(api.decide(...snow)?.after,'SN');
api.stabilize(snow,types);
assert.equal(snow[1].precipType.code,'SN');
const complex=[row(3,'RA'),row(0,'RA'),row(2,'RA'),row(1,'SHRA')];
api.stabilize(complex,types);
assert.equal(complex[3].precipType.code,'RA','out-of-order input must be chronological');
const leak=trio();
api.stabilize(leak,types);
leak[1].precipEvidence={convectiveNwp:true};
api.stabilize(leak,types);
assert.equal(leak[1].precipType.code,'SHRA','old adjusted code must be restored when fresh evidence arrives');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const pages=fs.readFileSync(path.join(root,'scripts/prepare_pages.py'),'utf8');
const hover=fs.readFileSync(path.join(root,'visual-style-fix.js'),'utf8');
const legend=fs.readFileSync(path.join(root,'meteogram-visfog-cleanup.js'),'utf8');
const typ=fs.readFileSync(path.join(root,'meteogram-precipitation-types.js'),'utf8');
for(const page of [html,pages]){
  assert.match(page,/meteogram-precipitation-continuity\.js/);
  assert.ok(page.indexOf('meteogram-precipitation-continuity.js')>page.indexOf('meteogram-precipitation-evidence.js'),
    'temporal filter must run AFTER independent radar and convection evidence');
}
assert.match(hover,/PrognozaEPIRPrecipContinuity\?\.tooltipRows\(z\)/,'hover must expose original WMO code');
assert.match(legend,/RA\* \/ SN\* — filtr 3 h/);
assert.match(typ,/wx\.temporalAdjusted\|\|wx\.intelligenceAdjusted/,'type marker covers both temporal smoothing and physical cloud subtype');
const src=fs.readFileSync(path.join(root,'meteogram-precipitation-continuity.js'),'utf8');
const browser={document:{querySelector(){return null}},selected:'consensus',
  rows:trio(),PrognozaEPIRPrecipitation:types};
vm.runInNewContext('function dataVisible(){return rows;}\nfunction showSectionInfo(){}\n'+src+'\ndataVisible();',browser);
assert.equal(browser.rows[1].precipType.code,'RA','browser dataVisible wrapper must apply to consensus');
assert.equal(browser.PrognozaEPIRPrecipContinuity?.tooltipRows(browser.rows[1]).length,3);
browser.selected='icon_eu';
browser.rows=trio();
browser.dataVisible();
assert.equal(browser.rows[1].precipType.code,'SHRA','single model is displayed without consensus correction');
console.log('Meteogram precipitation continuity: 18 isolated negative cases, snow/rain, reversibility, integration and tooltip PASS');
