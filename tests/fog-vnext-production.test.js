'use strict';
const assert=require('assert');
const P=require('../fog-vnext-probability-layer.js');

const physics={RAD:.82,ADV:.42,CBL:.34,PCP:.12};
const highVis=P.evaluate(
  {visibility:12000,cloud2m:0,cbh:1400,weatherFog:null,leadHours:2},
  physics
);
const lowVis=P.evaluate(
  {visibility:350,cloud2m:90,cbh:120,weatherFog:null,leadHours:2},
  physics
);
assert(Number.isFinite(highVis.P_model_final));
assert(highVis.P_model_final>=highVis.P_physics-1e-12,'high NWP VIS must not suppress internal physics');
assert(lowVis.P_model_final>=highVis.P_model_final,'low NWP VIS may corroborate fog');
assert.strictEqual(highVis.directRole,'confirm-only');
assert.strictEqual(highVis.calibrationStatus,'physics-first-production-2026-09-16');
assert.strictEqual(highVis.P_model_final,highVis.P_model_final_shadow);

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
