import assert from 'node:assert/strict';
import {imageMetadata,normalize} from './core.mjs';
const b=new Uint8Array(150);b.set([137,80,78,71,13,10,26,10]);
assert.equal(imageMetadata(b,'image/png').byteLength,150);
assert.throws(()=>imageMetadata(b,'image/jpeg'),/signature/);
const result=normalize({timeBasis:'UTC',rows:[
 {axisLabel:'12',timestampUtc:'2026-11-12T12:00:00Z',temperatureC:4,dewPointC:3,humidityPct:90,confidence:'medium'},
 {axisLabel:'13',timestampUtc:'2026-11-12T13:00:00Z',temperatureC:5,humidityPct:150,windSpeedMs:2},
 {axisLabel:'14',timestampUtc:'2026-11-12T12:00:00Z',temperatureC:6}]});
assert.equal(result.rows.length,2);assert.equal(result.rows[1].humidityPct,null);
assert.ok(result.flags.includes('duplicate_utc:2'));
assert.equal(result.consensusEnabled,false);assert.equal(result.tafEnabled,false);
const local=normalize({timeBasis:'LOCAL',rows:[{axisLabel:'12',timestampUtc:'2026-11-12T12:00:00Z',windSpeedMs:2}]});
assert.equal(local.rows[0].timestampUtc,null);
assert.throws(()=>normalize({rows:Array(97).fill({})}),/invalid_gemini_output/);
console.log('ICM Vision offline checks PASS');