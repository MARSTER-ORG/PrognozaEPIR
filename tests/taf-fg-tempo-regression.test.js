'use strict';

const assert = require('assert');
const E = require('../taf-engine-v2.js');

const H = 3600000;
const KT = 1.9438444924406;
const start = Date.UTC(2026, 8, 24, 0);
const end = start + 12 * H;
const issue = start - H;

function model({ vis = 12000, code = 0, kt = 6, dir = 220, g = 6, w = 1 } = {}) {
  return { vis, code, ws: kt / KT, wd: dir, g: g / KT, w, ceil: null };
}

function row(i, overrides = {}) {
  const vis = overrides.vis ?? 12000;
  const members = overrides.mv || [
    model({ vis, code: overrides.code ?? 0 }),
    model({ vis, code: overrides.code ?? 0 }),
    model({ vis, code: overrides.code ?? 0 }),
  ];
  return {
    t: start + i * H,
    T: overrides.T ?? 10,
    Td: overrides.Td ?? 7,
    RH: overrides.RH ?? 70,
    RR: overrides.RR ?? 0,
    VIS: vis,
    WS: 6 / KT,
    WD: 220,
    G: 6 / KT,
    wet: overrides.wet ?? 0,
    storm: 0,
    dirSpread: 10,
    profile: [{ agl: 200, cc: 0 }, { agl: 2500, cc: 0 }],
    ceiling: null,
    lowH: null,
    midH: null,
    highH: null,
    oktaL: 0,
    oktaM: 0,
    oktaH: 0,
    mv: members,
    fogRisk: 0,
    fgRisk: null,
    brRisk: null,
    fogOperationalScore: overrides.fogOperationalScore ?? null,
    fgOperationalScore: overrides.fgOperationalScore ?? null,
    brOperationalScore: null,
    fogVis1000Risk: null,
    fogAltVisM: overrides.fogAltVisM ?? null,
    brAltVisM: null,
    preciseTiming: false,
  };
}

const rows = Array.from({ length: 12 }, (_, i) => row(i));
rows[5] = row(5, {
  vis: 800,
  fogOperationalScore: 80,
  fgOperationalScore: 80,
  fogAltVisM: 800,
  mv: [
    model({ vis: 800, code: 61 }),
    model({ vis: 800, code: 61 }),
    model({ vis: 800, code: 61 }),
  ],
});

const mixed = E.helpers.stateFromRow(rows[5]);
assert.equal(E.helpers.weatherToken(mixed, 0.5), '-RA', 'rain remains the first emitted weather token');
assert.equal(E.helpers.fogFamily(mixed, 0.5), 'FG', 'fog family must inspect all emitted weather tokens');

const result = E.createEngine().generate({
  station: 'EPIR',
  issue,
  start,
  end,
  rows,
  rowsAlreadyAnchored: true,
});

assert.equal(result.checks.ok, true, result.taf);
assert.doesNotMatch(
  result.taf,
  /\bTEMPO\b[^\n=]*\b(?:FG|FZFG)\b/,
  `FG onset leaked into TEMPO:\n${result.taf}`,
);
assert.doesNotMatch(
  result.taf,
  /\bTEMPO\b[^\n=]*\bBR\b/,
  `BR onset leaked into TEMPO:\n${result.taf}`,
);

console.log('TAF FG+precip TEMPO regression: OK');
