'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'fog-engine-v244.js'), 'utf8');
const marker = '  function trim(a){';
assert(script.includes(marker), 'Fog 2.4.4 scoring hook unavailable');
const source = script.replace(marker,
  '  window.__fogRegression={calc,mifgProtectedScore};\n'+marker);
const window = {addEventListener(){}};
const sandbox = {
  window, document:{getElementById(){return null;}},
  setTimeout(){return 1;}, setInterval(){return 1;},
  addEventListener(){}, dispatchEvent(){}, CustomEvent:function(){},
  console, Date, Math, Number, Intl, URLSearchParams, AbortController
};
vm.runInNewContext(source, sandbox, {filename:'fog-engine-v244.js',timeout:3000});
const {calc,mifgProtectedScore} = window.__fogRegression;

const dense = {
  t:0, T:0, Td:0, RH:100, WS:1, LOW:20,
  pbl:40, Ts:-3, inv:3, lead:2, RR:0, CBH:100,
  s1:0.4, s3:0.41, legacy:90, day:0, sw:0,
  adv:0.9, cold:0.8, direct:95
};
const lowNwp = calc({...dense,VIS:500});
const highNwp = calc({...dense,VIS:30000});
assert(highNwp.fg.score>=60, 'synthetic scenario is not dense FG');
assert(highNwp.phys.SATURATION>=.82, 'synthetic scenario lacks saturation');
assert(highNwp.vis.point<1500, 'strong physics must retain low VIS even with 30 km NWP');
assert.equal(highNwp.vis.point,lowNwp.vis.point,
  'NWP VIS should not dilute physics first in dense fog');
assert.equal(highNwp.vis.modelMedian,30000,
  'raw NWP visibility must remain in diagnostics');
assert(highNwp.vis.p1500>=highNwp.vis.p1000);
assert(highNwp.vis.p1000>=highNwp.vis.p500);
assert(highNwp.vis.p500>=highNwp.vis.p200);

const shallow = {t:3600000,T:-2,Td:-2.5,Ts:-3.5,WS:1.5};
assert.equal(mifgProtectedScore(shallow,85,40,3500),85,
  'plausible shallow-layer MIFG must remain detectable');
assert.equal(mifgProtectedScore({...shallow,Ts:null},85,40,3500),59,
  'missing surface-temperature evidence must not produce high-confidence MIFG');
assert.equal(mifgProtectedScore({...shallow,WS:5},85,40,3500),59,
  'strong wind must inhibit unobserved shallow fog');
assert.equal(mifgProtectedScore(shallow,85,75,650),59,
  'low prevailing visibility is full fog rather than MIFG');
assert.equal(mifgProtectedScore({
  ...shallow,obs:{t:3600000,fg:true,mifg:false}
},85,40,3500),59,
'fresh FG must not also generate a high-confidence MIFG alarm');
assert.equal(mifgProtectedScore({
  ...shallow,obs:{t:3600000,fg:false,mifg:true}
},35,40,3500),80,
'explicit fresh MIFG must remain visible');
assert.equal(mifgProtectedScore(shallow,null,40,3500),null,
'missing raw evidence must stay missing instead of becoming zero');
console.log('fog physical VIS + shallow MIFG evidence regression: OK');
