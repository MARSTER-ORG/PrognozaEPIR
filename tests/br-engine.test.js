'use strict';
const assert = require('assert');
const BR = require('../br-engine.js');

const now = Date.now();

const legacy = BR.scoreRow({t:now, sat:92, score:62, vis:2600, obsPhenomenon:null}, 'legacy', now);
assert(legacy && legacy.score >= 60, `legacy BR should activate in saturated 1-5 km regime, got ${legacy?.score}`);
assert.strictEqual(BR.classify(legacy.score) === 'PRAWDOPODOBNE' || BR.classify(legacy.score) === 'BARDZO PRAWDOPODOBNE', true);

// Production vNext enrichment mutates the active Fog series in place and keeps
// the original LEGACY score in fogScoreLegacy. BR in LEGACY mode must consume
// that preserved score, never the enriched active score.
const enrichedLegacy = BR.scoreRow({
  t:now,
  sat:92,
  score:91,
  fogScoreLegacy:38,
  vis:2600,
  obsPhenomenon:null
}, 'legacy', now);
assert(enrichedLegacy, 'legacy BR should score an enriched Fog row');
assert(Math.abs(enrichedLegacy.fogPotential - 0.38) < 1e-12,
  `legacy BR must use fogScoreLegacy after vNext enrichment, got ${enrichedLegacy?.fogPotential}`);

const vnext = BR.scoreRow({
  t:now,
  vnext:{SATURATION:.93},
  vnextProbability:{P_physics:.62},
  visProposed:2200
}, 'vnext', now);
assert(vnext && vnext.score >= 60, `vNext BR should activate from internal physics, got ${vnext?.score}`);

const fogTerritory = BR.scoreRow({
  t:now,
  vnext:{SATURATION:.96},
  vnextProbability:{P_physics:.82},
  visProposed:650
}, 'vnext', now);
assert(fogTerritory && fogTerritory.score <= 49, `VIS <1000 m with operational FG must not be duplicated as BR, got ${fogTerritory?.score}`);

const weakSaturation = BR.scoreRow({t:now, sat:30, score:55, vis:2400}, 'legacy', now);
assert(weakSaturation && weakSaturation.score <= 39, `weak saturation must gate BR, got ${weakSaturation?.score}`);

const observed = BR.scoreRow({t:now, sat:75, score:35, vis:4000, obsPhenomenon:'BR'}, 'legacy', now);
assert(observed && observed.score > 50, `fresh BR observation should positively anchor near-term BR, got ${observed?.score}`);

assert.strictEqual(BR.VERSION, '1.0.0-br-target');
console.log('br-engine: ok');
