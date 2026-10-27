'use strict';
const assert=require('node:assert/strict');
const bands=require('../meteogram-cloud-bands.js');

(function missingDataIsNotZeroCloud(){
  const empty=bands.fromProfile([]);
  assert.equal(empty.coverage.veryLow,null);
  assert.equal(empty.veryLowQuality,'unknown');
  assert.equal(empty.bases.bkn,null);

  const unavailable=bands.fromProfile([
    {agl:700,cc:95},{agl:1200,cc:75},{agl:2500,cc:20},{agl:6500,cc:0}
  ]);
  assert.equal(unavailable.coverage.veryLow,null,'must not extrapolate clouds below 700 m');
  assert.equal(unavailable.coverage.low,null,'low band lacks observations at its 450 m boundary');
  assert.equal(unavailable.veryLowQuality,'unknown');
})();

(function supportedVeryLowLayerAndNonOverlappingBands(){
  const result=bands.fromProfile([
    {agl:0,cc:10},{agl:150,cc:82},{agl:450,cc:61},{agl:2000,cc:18},
    {agl:6000,cc:37},{agl:13000,cc:1}
  ]);
  assert.equal(result.veryLowQuality,'supported');
  assert.ok(result.coverage.veryLow>=5,'dense cloud in 0-450 m must appear');
  assert.ok(result.coverage.low>=1);
  assert.equal(result.coverage.high>=0,true);
  assert.equal(result.coverage.mid>=0,true);
  assert.ok(result.bases.bkn!==null&&result.bases.bkn<450);
  assert.ok(result.bases.few!==null);
})();

(function partialLowestLevelIsExplicitAndNoFalseClearSky(){
  const result=bands.fromProfile([
    {agl:250,cc:70},{agl:500,cc:65},{agl:2000,cc:20},
    {agl:6000,cc:0},{agl:13000,cc:0}
  ]);
  assert.equal(result.veryLowQuality,'partial');
  assert.ok(result.coverage.veryLow>=5);
  assert.ok(result.coverage.low>=1);
  assert.ok(result.bases.few>450,'a higher FEW layer may coexist with low BKN');
  assert.ok(result.bases.bkn>=250);
})();

(function coverageOutsideVerticalRangeRemainsUnknown(){
  const result=bands.fromProfile([
    {agl:90,cc:30},{agl:300,cc:25},{agl:450,cc:18},
    {agl:900,cc:6},{agl:1900,cc:0}
  ]);
  assert.ok(result.coverage.veryLow!==null);
  assert.equal(result.coverage.low,null,'no extrapolation to 2000 m');
  assert.equal(result.coverage.mid,null);
  assert.equal(result.coverage.high,null);
})();

(function pressureProfileInputNotMutated(){
  const profile=[{agl:460,cc:40},{agl:100,cc:80},{agl:460,cc:25},{agl:2000,cc:0},{agl:13000,cc:0}];
  const saved=JSON.stringify(profile);
  const first=bands.fromProfile(profile);
  assert.equal(JSON.stringify(profile),saved);
  assert.equal(first.veryLowQuality,'supported');
  assert.equal(first.coverage.veryLow,6);
})();

console.log('meteogram cloud bands 0-450m: OK');