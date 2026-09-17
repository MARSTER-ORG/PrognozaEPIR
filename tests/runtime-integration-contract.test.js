'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const Policy = require('../taf-fog-policy.js');

function fakeStorage(mode) {
  return { getItem: key => key === Policy.MODE_KEY ? mode : null };
}

(function testLegacySeriesWinsOverEnrichedVnext() {
  const win = {
    localStorage: fakeStorage('legacy'),
    PrognozaEPIRFogLegacySeries: [{ t: 1, score: 55, vis: 900, fogEngineMode: 'legacy' }],
    PrognozaEPIRFogSeries: [{ t: 1, score: 82, fogScoreLegacy: 55, vis: 900, fogEngineMode: 'vnext-production' }],
    PrognozaEPIRFogVNextSeries: [{ t: 1, score: 82, fogScoreLegacy: 55, vis: 900, fogEngineMode: 'vnext-production' }]
  };
  const rows = Policy.seriesForMode(win, 'legacy');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 55);
  assert.equal(Policy.normalizeMode(rows[0].fogEngineMode), 'legacy');
})();

(function testLegacyRecoveryFromEnrichedSeries() {
  const win = {
    localStorage: fakeStorage('legacy'),
    PrognozaEPIRFogSeries: [{ t: 1, score: 84, fogScoreLegacy: 52, vis: 1200, fogEngineMode: 'vnext-production' }]
  };
  const rows = Policy.seriesForMode(win, 'legacy');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 52);
  assert.equal(rows[0].fogEngineMode, 'legacy');
})();

(function testVnextSeriesStillSelected() {
  const win = {
    localStorage: fakeStorage('vnext'),
    PrognozaEPIRFogVNextSeries: [{ t: 1, score: 77, fogEngineMode: 'vnext-production' }]
  };
  const rows = Policy.seriesForMode(win, 'vnext');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 77);
})();

(function testFogPageIsolationContract() {
  const html = read('fog.html');
  assert(html.includes('id="fogRuntime"'));
  assert(html.includes('index.html?fogpanel=1&v='));
  assert(html.includes("mount.id = 'fogStandaloneMount'"));
  assert(html.includes("const ids = ['fogEngineModeSwitch', 'fogEngine', 'brEngine', 'mifgEngineStandalone']"));
  assert(html.includes('body>.wrap,body>.app'));
  assert(html.includes('#fogStandaloneMount{display:block!important'));
})();

(function testBuildExportsDedicatedLegacySeries() {
  const wire = read('scripts/wire_fog_mifg_utc_runtime.py');
  assert(wire.includes('PrognozaEPIRFogLegacySeries'));
  assert(wire.includes('index\\.html\\?fogpanel=1&v='));
  assert(wire.includes('fog-page-layout.js'));
  assert(wire.includes('fog-visibility-cells.js'));
})();

(function testTafRuntimeContract() {
  const html = read('taf.html');
  const app = read('taf-app-v25.js');
  assert(html.includes('id="engine"'));
  assert(html.includes('taf-engine-v242.js?v=2.4.2-cloud-fog'));
  assert(html.includes('taf-runtime-bootstrap.js?v=20260917-2'));
  assert(app.includes('waitForFogSeries'));
  assert(app.includes("mode==='vnext'"));
  assert(app.includes('Fog Engine LEGACY'));
})();

require('./site-asset-integrity.test.js');
console.log('runtime integration contract: OK');
