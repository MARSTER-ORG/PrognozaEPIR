'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const wind=require('../meteogram-wind-zero.js');

const expected=[
  [0,'#2689d6'],[5,'#2689d6'],[5.001,'#29a65a'],
  [10,'#29a65a'],[10.001,'#dfbc24'],
  [15,'#dfbc24'],[15.001,'#ec8526'],
  [25,'#ec8526'],[25.001,'#d93a3a'],[50,'#d93a3a']
];
for(const [speed,color] of expected)
  assert.equal(wind.band(speed)?.color,color,'bad colour for '+speed+' m/s');
for(const value of [null,undefined,-1,NaN,Infinity])
  assert.equal(wind.band(value),null,'bad speed should not become a colour');

const spans=wind.segments(3,29);
assert.deepEqual(spans.map(s=>s.band.max),[5,10,15,25,Infinity]);
assert.deepEqual(spans.map(s=>s.to),[5,10,15,25,29]);
assert.equal(spans[0].start,0);
assert.equal(spans[spans.length-1].end,1);
for(let i=1;i<spans.length;i++)assert.equal(spans[i].start,spans[i-1].end);
assert.deepEqual(wind.segments(29,3).map(s=>s.band.max),[Infinity,25,15,10,5]);
assert.equal(wind.segments(20,20).length,1);
assert.deepEqual(wind.segments(5,NaN),[]);
assert.deepEqual(wind.segments(-1,5),[]);

const src=fs.readFileSync(path.join(__dirname,'..','meteogram-visfog-split.js'),'utf8');
const layout=fs.readFileSync(path.join(__dirname,'..','meteogram-layout-v2.js'),'utf8');
const page=fs.readFileSync(path.join(__dirname,'..','scripts/prepare_pages.py'),'utf8');
assert.match(src,/Math\.min\(min,0\)/,'active temperature axis must include zero');
assert.match(src,/Math\.max\(max,0\)/,'active temperature axis must include zero');
assert.match(layout,/>25/,'legend must show red threshold');
assert.match(layout,/0°C — granica/,'legend must show zero crossing');
assert.match(page,/meteogram-wind-zero\.js/,'Pages must include the final accent layer');
console.log('Meteogram wind bands and 0°C: 21 boundary and wiring checks OK');
