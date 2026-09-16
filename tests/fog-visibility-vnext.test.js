'use strict';
const assert=require('assert');
const V=require('../fog-visibility-vnext.js');

const mature={
  phase:'mature',RAD:.90,ADV:.50,CBL:.25,PCP:.12,
  SATURATION:.96,SPBL:.85,SSFC_COOL:.88,SSOIL:.70,
  dissipationRisk:.05,dataQuality:.85
};
const highNwp=V.evaluate({
  vis:10000,obsUsed:false,models:[{VIS:10000},{VIS:15000},{VIS:30000}]
},{physicsProbability:.82,vnext:mature,leadHours:5,phase:'mature'});
const lowNwp=V.evaluate({
  vis:450,obsUsed:false,models:[{VIS:250},{VIS:450},{VIS:800}]
},{physicsProbability:.82,vnext:mature,leadHours:5,phase:'mature'});

assert(Number.isFinite(highNwp.point));
assert(highNwp.point<1000,'strong internal fog must produce reduced VIS even when NWP stays high');
assert.strictEqual(highNwp.point,lowNwp.point,'NWP VIS must not move operational VIS');
assert.strictEqual(highNwp.low,lowNwp.low);
assert.strictEqual(highNwp.high,lowNwp.high);
assert.strictEqual(highNwp.p1000,lowNwp.p1000,'NWP VIS must not move threshold probabilities');
assert.strictEqual(highNwp.confidence,lowNwp.confidence,'model VIS spread must not alter internal confidence');
assert.strictEqual(highNwp.nwpRole,'diagnostic-only');
assert.strictEqual(highNwp.nwpRelation,'NWP nie widzi redukcji VIS');
assert(highNwp.p1500>=highNwp.p1000&&highNwp.p1000>=highNwp.p500&&highNwp.p500>=highNwp.p200);

const weakPhysics={
  phase:'pre-onset',RAD:.20,ADV:.18,CBL:.12,PCP:.08,
  SATURATION:.38,SPBL:.30,SSFC_COOL:.25,SSOIL:.40,
  dissipationRisk:.55,dataQuality:.80
};
const weak=V.evaluate({
  vis:300,obsUsed:false,models:[{VIS:200},{VIS:300},{VIS:500}]
},{physicsProbability:.20,vnext:weakPhysics,leadHours:8,phase:'pre-onset'});
assert(weak.point>=5000,'low NWP VIS alone must not manufacture an internal fog visibility forecast');
assert(weak.p1000<25);

const withObs=V.evaluate({
  vis:12000,obsUsed:true,obsVisM:600,models:[{VIS:10000},{VIS:15000}]
},{physicsProbability:.55,vnext:{...mature,RAD:.65,SATURATION:.82},leadHours:1,phase:'onset'});
const withoutObs=V.evaluate({
  vis:12000,obsUsed:false,models:[{VIS:10000},{VIS:15000}]
},{physicsProbability:.55,vnext:{...mature,RAD:.65,SATURATION:.82},leadHours:1,phase:'onset'});
assert(withObs.point<=withoutObs.point,'fresh real observation may improve nowcast');
assert(withObs.observationWeight>0);

const event=V.eventSummary([
  {t:1,visGuidance:{point:800,low:500,high:1300,p1500:70,p1000:55,p500:20,p200:5,confidence:.7}},
  {t:2,visGuidance:{point:400,low:250,high:800,p1500:90,p1000:80,p500:60,p200:20,confidence:.65}}
]);
assert.strictEqual(event.minimum,400);
assert.strictEqual(event.minimumTime,2);
assert.strictEqual(event.p500,60);
console.log('fog-visibility-vnext: ok');
