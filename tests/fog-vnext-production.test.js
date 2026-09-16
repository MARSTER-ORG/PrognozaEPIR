'use strict';
const assert=require('assert');
const P=require('../fog-vnext-probability-layer.js');

const evaluated=P.evaluate(
  {visibility:1800,cloud2m:80,cbh:180,weatherFog:null,leadHours:6},
  {RAD:.72,ADV:.34,CBL:.51,PCP:.12}
);
assert(Number.isFinite(evaluated.P_model_final));
assert(evaluated.P_model_final>=0&&evaluated.P_model_final<=1);
assert.strictEqual(evaluated.P_model_final,evaluated.P_model_final_shadow);
assert.strictEqual(evaluated.calibrated,false);
assert.strictEqual(evaluated.calibrationStatus,'validated-production-2026-09-15');

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
