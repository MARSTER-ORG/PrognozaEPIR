'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('function meteogramCoverage(');
const end = html.indexOf('\nfunction render()', start);
assert.ok(start >= 0 && end > start, 'coverage function must exist in index.html');
const coverage = new Function(html.slice(start, end) + '\nreturn meteogramCoverage;')();
const makeRow = (h, overrides = {}) => ({
  t: h * 3600_000, T: 8, RH: 80, P: 1013, WS: 4, VIS: 10000,
  profile: [{agl: 120, cc: 50}, {agl: 500, cc: 30}],
  modelCount: 3, ...overrides
});
const full = Array.from({length: 48}, (_, h) => makeRow(h));
assert.equal(coverage(full, 48, true).complete, true);
const missingVis = full.map((z, i) => i >= 24 ? {...z, VIS: null} : z);
assert.equal(coverage(missingVis, 48, true).complete, false);
assert.ok(coverage(missingVis, 48, true).missing.some(x => x.includes('widzialność: 24/48')));
assert.equal(coverage(full.map(z => ({...z, VIS: 0})), 48, true).complete, true,
  'actual zero visibility is data, not a missing value');
assert.equal(coverage(full.map(z => ({...z, modelCount: 1})), 48, true).complete, false,
  'one model must not be represented as a complete consensus');
assert.equal(coverage(full.map(z => ({...z, modelCount: 1})), 48, false).complete, true,
  'an individually selected model may have full coverage');
assert.equal(coverage(full, 120, true).complete, false);
assert.ok(coverage(full.map((z, i) => i === 2 ? {...z, profile: []} : z), 48, true)
  .missing.some(x => x.includes('profil chmur')));

for(const asset of ['index.html','meteogram-layout-v2.js','meteogram-visfog-split.js']){
  const content = fs.readFileSync(path.join(root, asset), 'utf8');
  assert.ok(!content.includes('(z.VIS||0)'), asset + ': missing visibility must not be drawn as zero');
}
console.log('Meteogram coverage/gap regression tests: PASS');
