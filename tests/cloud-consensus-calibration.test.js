'use strict';
const assert=require('node:assert/strict');
const calibration=require('../cloud-consensus-calibration.js');
const H=3600000;
const now=Date.UTC(2026,10,6,0,0,0);

let v=calibration.apply({totalPct:77,midPct:20,targetMs:now+H,nowMs:now});
assert.equal(v.total.raw_pct,77);
assert.equal(v.total.corrected_pct,77,'missing calibration cannot invent a correction');
assert.equal(v.total.applied,false);
assert.equal(v.mid.applied,false);
assert.equal(calibration.apply({totalPct:null,targetMs:now+H,nowMs:now}).total.okta,null);

calibration.setCalibrationForTest({
 schema:'prognozaepir-consensus-cloud-calibration-v1',
 station:'EPIR',generated_at:'2026-11-06T00:00:00Z',
 lead_buckets:{'0-3h':{
   total:{
     night:{active:true,shift_okta:-1},
     day:{active:false,shift_okta:2},
     all:{active:true,shift_okta:-.5}
   },
   mid:{all:{active:true,shift_okta:1.5}}
 }}
});
v=calibration.apply({totalPct:75,midPct:25,targetMs:now+H,nowMs:now});
assert.equal(v.total.okta,5);
assert.equal(v.total.corrected_pct,62.5);
assert.equal(v.mid.okta,4);
assert.equal(v.mid.corrected_pct,50);
assert.equal(v.total.applied,true);
assert.equal(v.mid.applied,true);
assert.equal(v.phase,'night');
assert.equal(v.bucket,'0-3h');
v=calibration.apply({totalPct:75,midPct:25,targetMs:now+11*H,nowMs:now});
assert.equal(v.total.applied,false,'missing 6-12h coefficient preserves raw forecast');
assert.equal(v.total.corrected_pct,75);
v=calibration.apply({totalPct:0,midPct:100,targetMs:now+H,nowMs:now});
assert.equal(v.total.corrected_pct,0,'do not go below zero cloud');
assert.equal(v.mid.corrected_pct,100,'do not exceed full cloud');

const afternoon=Date.UTC(2026,10,6,12,0,0);
v=calibration.apply({totalPct:75,midPct:25,targetMs:afternoon+H,nowMs:afternoon});
assert.equal(v.phase,'day');
assert.equal(v.total.shift_okta,-.5,'validated all-day fallback when day-only correction is inactive');
console.log('consensus cloud calibrated surface, safeguards, missing cases: OK');
