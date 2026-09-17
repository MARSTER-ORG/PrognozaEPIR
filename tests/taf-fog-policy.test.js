'use strict';
const assert=require('assert');
const P=require('../taf-fog-policy.js');

assert.equal(P.normalizeMode('legacy'),'legacy');
assert.equal(P.normalizeMode('vnext'),'vnext');
assert.equal(P.normalizeMode('vnext-production'),'vnext');
assert.equal(P.operationalScoreForTaf(49,'legacy'),49);
assert.equal(P.operationalScoreForTaf(50,'legacy'),60);
assert.equal(Math.round(P.operationalScoreForTaf(65,'legacy')),70);
assert.equal(P.operationalScoreForTaf(80,'legacy'),80);
assert.equal(P.operationalScoreForTaf(60,'vnext'),60);

const legacy={score:55,vis:900,vis1000:62,vis500:30,vis1500:70,confidence:.7,type:{text:'radiacyjna'},fogEngineMode:'legacy'};
const lp=P.normalizeFogHour(legacy,'legacy');
assert.equal(lp.mode,'legacy');
assert.ok(lp.fogScore>60&&lp.fogScore<70);
assert.equal(lp.vis,900);
assert.equal(lp.vis1000,62);
assert.equal(lp.type,'radiacyjna');

const vnext={
  score:68,vis:7000,vis1000:5,fogEngineMode:'vnext-production',
  visGuidance:{point:650,p1000:72,p1500:85,p500:41,p200:9,confidence:.82},
  vnextProbability:{mechanism1:'CBL',mechanism2:'RAD'}
};
const vp=P.normalizeFogHour(vnext,'vnext');
assert.equal(vp.mode,'vnext');
assert.equal(vp.fogScore,68);
assert.equal(vp.vis,650);
assert.equal(vp.vis1000,72);
assert.equal(vp.type,'CBL/RAD');
assert.equal(vp.confidence,.82);

const wLegacy={PrognozaEPIRFogLegacySeries:[legacy],PrognozaEPIRFogSeries:[vnext]};
assert.equal(P.seriesForMode(wLegacy,'legacy')[0].score,55);
const wNext={PrognozaEPIRFogVNextSeries:[vnext]};
assert.equal(P.seriesForMode(wNext,'vnext')[0].score,68);

console.log('TAF fog engine mode policy regressions: OK');
