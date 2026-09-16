'use strict';
const assert=require('assert');
const P=require('../fog-vnext-probability-layer.js');

const mechanisms={RAD:.82,ADV:.42,CBL:.34,PCP:.12};
const night={...mechanisms,SATURATION:.92,SPBL:.85,SSFC_COOL:.78,dissipationRisk:.08};
const day={...mechanisms,SATURATION:.22,SPBL:.12,SSFC_COOL:.10,dissipationRisk:.82};
const marginalDay={RAD:.72,ADV:.48,CBL:.30,PCP:.08,SATURATION:.42,SPBL:.42,SSFC_COOL:.28,dissipationRisk:.38};

const nightHighVis=P.evaluate(
  {visibility:12000,cloud2m:0,cbh:1400,weatherFog:null,leadHours:2,isDay:0},night
);
const nightLowVis=P.evaluate(
  {visibility:350,cloud2m:90,cbh:120,weatherFog:null,leadHours:2,isDay:0},night
);
const dayHighVis=P.evaluate(
  {visibility:12000,cloud2m:0,cbh:1400,weatherFog:null,leadHours:9,isDay:1},day
);
const marginalHighVis=P.evaluate(
  {visibility:30000,cloud2m:0,cbh:1500,weatherFog:null,leadHours:18,isDay:1},marginalDay
);
const marginalLowVis=P.evaluate(
  {visibility:900,cloud2m:70,cbh:180,weatherFog:null,leadHours:18,isDay:1},marginalDay
);

assert(Number.isFinite(nightHighVis.P_model_final));
assert(nightHighVis.P_physics>.60,'strong nocturnal fog-ready state should remain operational');
assert(dayHighVis.P_physics<.30,'dry/dispersing daytime state must collapse the long FG tail');
assert(dayHighVis.P_physics<nightHighVis.P_physics*.55,'dissipation/state gate must materially shorten the event');
assert.strictEqual(nightHighVis.visibilityContradiction,0,'strong saturated state must not be vetoed by high NWP VIS');
assert(nightHighVis.P_model_final>=nightHighVis.P_physics-1e-12,'high NWP VIS must not suppress strong internal physics');
assert(nightLowVis.P_model_final>=nightHighVis.P_model_final,'low NWP VIS may corroborate fog');
assert(marginalHighVis.visibilityContradiction>0,'high VIS must be recognized as contradiction for marginal/weak FG');
assert(marginalHighVis.P_model_final<marginalLowVis.P_model_final,'marginal high-VIS daytime FG must be reduced relative to low-VIS corroboration');
assert(marginalHighVis.P_model_final<.50,'30 km daytime marginal FG should not remain an operational fog bar');
assert.strictEqual(nightHighVis.directRole,'confirm-only');
assert.strictEqual(nightHighVis.calibrationStatus,'physics-state-gated-authoritative-render-2026-09-16');
assert.strictEqual(nightHighVis.P_model_final,nightHighVis.P_model_final_shadow);
assert(Number.isFinite(nightHighVis.P_potential));
assert(Number.isFinite(nightHighVis.stateReadiness));
assert(dayHighVis.dissipationPenalty>nightHighVis.dissipationPenalty);

// Backward compatibility for callers without new state fields.
const mechanismOnly=P.evaluate({visibility:12000,leadHours:6},mechanisms);
assert(Math.abs(mechanismOnly.P_physics-mechanismOnly.P_potential)<1e-12);

const prod=P.operationalScore(42,{P_model_final:.73});
assert.strictEqual(prod.score,73);
assert.strictEqual(prod.source,'vnext-production');
assert.strictEqual(prod.fallback,false);
const fallback=P.operationalScore(42,{});
assert.strictEqual(fallback.score,42);
assert.strictEqual(fallback.source,'legacy-fallback');
assert.strictEqual(fallback.fallback,true);
const missing=P.operationalScore(null,{});
assert.strictEqual(missing.score,null);
assert.strictEqual(missing.fallback,true);
console.log('fog-vnext-production: ok');
