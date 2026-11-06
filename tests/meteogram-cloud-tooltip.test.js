'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cloudBands = require('../meteogram-cloud-bands.js');

const script = fs.readFileSync(path.join(__dirname, '..', 'visual-style-fix.js'), 'utf8');
const t = Date.UTC(2026, 10, 6, 12);

function hover(profile, panelId, ceiling = null) {
  const listeners = {};
  const tooltip = {
    style: {},
    innerHTML: '',
    getBoundingClientRect: () => ({width: 280, height: 180})
  };
  const row = {
    t, profile, ceiling,
    // Legacy low-band values must NOT be used for the four canonical ranges.
    oktaL: 8, lowH: null, oktaM: 8, midH: null, oktaH: 8, highH: null
  };
  const canvas = {
    _meta: {
      data: [row], x0: 0, x1: 100, t0: t, t1: t + 3600000,
      W: 100, H: 200, panelYs: [
        {id: 'okta', y: 0, h: 100}, {id: 'cloud', y: 100, h: 100}
      ]
    },
    getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 200}),
    addEventListener: (name, callback) => {listeners[name] = callback;}
  };
  const viewport = {
    clientWidth: 500,
    clientHeight: 500,
    addEventListener: () => {}
  };
  const document = {
    getElementById: id => id === 'meteo' ? canvas : id === 'canvasViewport' ? viewport : null,
    createElement: () => tooltip,
    querySelector: () => null,
    body: {appendChild: () => {}}
  };
  const window = {
    innerWidth: 1024, innerHeight: 768, addEventListener: () => {},
    PrognozaEPIRCloudBands: cloudBands
  };
  vm.runInNewContext(script, {
    window, document, ctx: {}, draw: () => {}, stageSize: () => ({w: 100, h: 200}),
    applyTransform: () => {}, zoom: 1, panX: 0, panY: 0,
    activeTheme: () => 'dark', consensus: [], requestAnimationFrame: () => {}
  }, {filename: 'visual-style-fix.js'});
  assert.equal(typeof listeners.pointermove, 'function', 'hover listener is registered');
  listeners.pointermove({
    pointerType: 'mouse', clientX: 50, clientY: panelId === 'okta' ? 50 : 150
  });
  return tooltip.innerHTML;
}

const profile = [
  {agl: 0, cc: 10}, {agl: 150, cc: 82}, {agl: 450, cc: 61},
  {agl: 2000, cc: 18}, {agl: 6000, cc: 37}, {agl: 13000, cc: 1}
];
const expected = cloudBands.fromProfile(profile).coverage;
for (const panel of ['okta', 'cloud']) {
  const html = hover(profile, panel);
  for (const [label, key] of [
    ['Bardzo niskie 0–450 m', 'veryLow'],
    ['Niskie 450–2000 m', 'low'],
    ['Średnie 2–6 km', 'mid'],
    ['Wysokie 6–13 km', 'high']
  ]) {
    assert.ok(html.includes(label), panel + ': missing band ' + label);
    assert.ok(html.includes('<b>' + expected[key] + '/8</b>'),
      panel + ': missing actual computed band value ' + key);
  }
  assert.ok(!html.includes('~0 m'), 'never invent cloud base from missing legacy height');
}

for (const panel of ['okta', 'cloud']) {
  const html = hover([], panel);
  assert.equal((html.match(/<b>brak danych<\/b>/g) || []).length, 4,
    'missing vertical profile is not equivalent to 0/8');
  assert.ok(!html.includes('<b>0/8</b>'));
}

const clear = hover([
  {agl: 0, cc: 0}, {agl: 150, cc: 0}, {agl: 450, cc: 0},
  {agl: 2000, cc: 0}, {agl: 6000, cc: 0}, {agl: 13000, cc: 0}
], 'okta');
assert.equal((clear.match(/<b>0\/8<\/b>/g) || []).length, 4,
  'true clear sky must still display as 0/8');

console.log('meteogram hover: four cloud bands and missing data: OK');
