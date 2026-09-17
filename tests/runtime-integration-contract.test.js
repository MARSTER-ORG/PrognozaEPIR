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
  assert.equal(Policy.selectedMode(win), 'legacy');
  const rows = Policy.seriesForMode(win, Policy.selectedMode(win));
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
  assert.equal(Policy.selectedMode(win), 'vnext');
  const rows = Policy.seriesForMode(win, Policy.selectedMode(win));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 77);
})();

(function testFogPageIsNativeAndMeteogramFree() {
  const html = read('fog.html');
  assert(html.includes('id="epirGlobalNav"'));
  assert(html.includes('id="fogStandaloneMount"'));
  assert(html.includes('window.__PROGNOZA_EPIR_FOG_STANDALONE__=true'));
  for (const asset of [
    'fog-mode-switch.js', 'fog-engine.js', 'mifg-engine.js', 'fog-summary-layout.js',
    'br-engine.js', 'fog-page-layout.js', 'fog-visibility-cells.js'
  ]) assert(html.includes(asset), `missing ${asset}`);
  for (const forbidden of [
    '<iframe', 'fogRuntime', 'index.html?fogpanel=', '<canvas', 'canvasViewport',
    'MutationObserver', 'ResizeObserver', 'epir-pages-compat-', 'observation-engine.js',
    'fog-meteogram-overlay.js', 'shortcut-mode.js'
  ]) assert(!html.includes(forbidden), `fog.html contains dead/meteogram marker: ${forbidden}`);
})();

(function testVisibilityCellsStayPresentWhenInactive() {
  const js = read('fog-visibility-cells.js');
  assert(js.includes('FG · szacowana VIS'));
  assert(js.includes('BR · szacowana VIS'));
  assert(js.includes('MIFG · VIS standardowa'));
  assert(js.includes('brak aktywnego FG w 48 h'));
  assert(js.includes('brak aktywnego BR w 24 h'));
  assert(js.includes('brak aktywnego MIFG w 48 h'));
})();

(function testBuildExportsDedicatedLegacySeries() {
  const wire = read('scripts/wire_fog_mifg_utc_runtime.py');
  assert(wire.includes('PrognozaEPIRFogLegacySeries'));
  assert(wire.includes("'<iframe'"));
  assert(wire.includes("'index.html?fogpanel='"));
  assert(wire.includes('FOG_PAGE_ASSETS'));
})();

(function testTafUsesExactlySelectedFogMode() {
  const html = read('taf.html');
  const app = read('taf-app-v25.js');
  assert(html.includes('id="engine"'));
  assert(html.includes('taf-engine-v242.js?v=2.4.2-cloud-fog'));
  assert(html.includes('taf-runtime-bootstrap.js?v=20260917-2'));
  assert(app.includes('const mode=Policy.selectedMode(w)'));
  assert(app.includes('Policy.seriesForMode(w,mode)'));
  assert(app.includes("if(mode==='vnext')throw Error"));
  assert(app.includes("throw Error('Fog Engine LEGACY nie udostępnił kompletnej serii.')"));
  assert(!app.includes("mode==='legacy'?'vnext'"));
})();

require('./site-asset-integrity.test.js');
console.log('runtime integration contract: OK');
