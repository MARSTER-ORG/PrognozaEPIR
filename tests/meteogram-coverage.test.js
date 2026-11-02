'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const begin = html.indexOf('function meteogramCoverage(');
const finish = html.indexOf('\nfunction render()', begin);
assert.ok(begin >= 0 && finish > begin, 'coverage must be defined before render');
const coverage = new Function(html.slice(begin, finish) + '\nreturn meteogramCoverage;')();
const row = t => ({
  t, T: 10, Td: 8, RH: 82, P: 1018, WS: 4, VIS: 8000,
  profile: [{agl:100,cc:20},{agl:450,cc:40}], modelCount: 3
});
const H = 3600e3;
for (const hours of [48,72,120]) {
  const records = Array.from({length: hours},(_,i)=>row(i*H));
  assert.equal(coverage(records,hours,true).complete,true, hours+' hour coverage');
  assert.equal(coverage(records.slice(0,hours-1),hours,true).complete,false,
    'truncated '+hours+'h forecast cannot be FULL');
}
const full = Array.from({length:48},(_,i)=>row(i*H));
assert.equal(coverage(full.map((r,i)=>i>=24?{...r,VIS:null}:r),48,true).complete,false);
assert.ok(coverage(full.map((r,i)=>i>=24?{...r,VIS:null}:r),48,true)
  .missing.includes('widzialność: 24/48 h'));
assert.equal(coverage(full.map(r=>({...r,VIS:0})),48,true).complete,true,
  'real zero visibility is not a missing value');
assert.equal(coverage(full.map(r=>({...r,modelCount:1})),48,true).complete,false,
  'consensus with one model is degraded');
assert.equal(coverage(full.map(r=>({...r,modelCount:1})),48,false).complete,true,
  'a single selected model may be complete');
assert.equal(coverage(full.map((r,i)=>i===4?{...r,profile:[]}:r),48,true).complete,false);
for (const file of ['index.html','meteogram-layout-v2.js','meteogram-visfog-split.js']) {
  const text=fs.readFileSync(path.join(root,file),'utf8');
  assert.equal(text.includes('(z.VIS||0)'),false,'false zero VIS: '+file);
  assert.ok(/t1=t0\+horizon\*(?:HOUR|3600e3)/.test(text),
    'axis must span requested period rather than stretching last data: '+file);
}
console.log('Meteogram: coverage 48/72/120 h, null VIS, model counts and UTC axis PASS');
