import assert from 'node:assert/strict';
import {normalize} from '../supabase/functions/icm-vision-probe/core.mjs';
const response={timeBasis:'LOCAL',modelLabel:'UM4 60h',rows:['08','11','14','17'].map((label,i)=>({
 axisLabel:label,timestampUtc:null,temperatureC:2+i,dewPointC:1+i,humidityPct:90,
 cloudCoverPct:0.8,cloudBaseM:null,windSpeedMs:6,windDirectionDeg:null,
 precipitationMmH:0,visibilityM:null,confidence:'high',
 evidence:'Reading from first column of charts at '+label+' label'
}))};
const o=normalize(response);
assert.equal(o.consensusEnabled,false);
assert.equal(o.tafEnabled,false);
assert.equal(o.rows.length,4);
assert.ok(o.rows.every(r=>r.timestampUtc===null));
assert.ok(o.rows.every(r=>r.cloudCoverPct===null));
assert.ok(o.rows.every(r=>r.windSpeedMs===null));
assert.ok(o.rows.every(r=>r.confidence==='low'));
assert.ok(o.flags.includes('non_hourly_axis_step:1'));
assert.ok(o.flags.includes('cloud_cover_unit_not_pct:0'));
assert.ok(o.flags.includes('wind_series_not_identified:0'));
console.log('ICM real-chart quality gate: 10/10 checks PASS');
