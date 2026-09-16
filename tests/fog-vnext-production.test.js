'use strict';
const assert=require('assert');
const P=require('../fog-vnext-probability-layer.js');

const mechanisms={RAD:.82,ADV:.42,CBL:.34,PCP:.12};
const night={...mechanisms,SATURATION:.92,SPBL:.85,SSFC_COOL:.78,dissipationRisk:.08};
const day={...mechanisms,SATURATION:.22,SPBL:.12,SSFC_COOL:.10,dissipationRisk:.82};

const nightHighVis=P.evaluate(
  {visibility:12000,cloud2m:0,cbh:1400,weatherFog:null,leadHours:2},night
);
const nightLowVis=P.evaluate(
  {visibility:350,cloud2m:90,cbh:120,weatherFog:null,leadHours:2},night
);
const dayHighVis=P.evaluate(
  {visibility:12000,cloud2m:0,cbh:1400,weatherFog:null,leadHours:9},day
);

assert(Number.isFinite(nightHighVis.P_model_final));
assert(nightHighVis.P_physics>.60,'strong nocturnal fog-ready state should remain operational');
assert(dayHighVis.P_physics<.30,'dry/dispersing daytime state must collapse the long FG tail');
assert(dayHighVis.P_physics<nightHighVis.P_physics*.55,'dissipation/state gate must materially shorten the event');
assert(nightHighVis.P_model_final>=nightHighVis.P_physics-1e-12,'high NWP VIS must not suppress internal physics');
assert(nightLowVis.P_model_final>=nightHighVis.P_model_final,'low NWP VIS may corroborate fog');
assert.strictEqual(nightHighVis.directRole,'confirm-only');
assert.strictEqual(nightHighVis.calibrationStatus,'physics-state-gated-production-2026-09-16');
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
