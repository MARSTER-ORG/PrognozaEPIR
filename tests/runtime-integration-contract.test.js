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

(function testFogPageUsesIntegrated244Runtime() {
  const html = read('fog.html');
  assert(html.includes('id="epirGlobalNav"'));
  assert(html.includes('id="fogStandaloneMount"'));
  assert(html.includes('window.__PROGNOZA_EPIR_FOG_STANDALONE__=true'));
  assert(html.includes('fog-engine-v244.js?v='));
  assert(html.includes('fog-engine.js?v='));
  for (const forbidden of [
    '<iframe', 'fogRuntime', 'index.html?fogpanel=', '<canvas', 'canvasViewport',
    'MutationObserver', 'ResizeObserver', 'epir-pages-compat-', 'observation-engine.js',
    'fog-meteogram-overlay.js', 'shortcut-mode.js'
  ]) assert(!html.includes(forbidden), `fog.html contains dead/meteogram marker: ${forbidden}`);
})();

(function testIntegrated244UsesUnifiedThreshold60() {
  const engine = read('fog-engine-v244.js');
  assert(engine.includes("const V='2.4.4',H=3600e3,ACTIVE=60"));
  assert(engine.includes('PrognozaEPIRFogRenderThreshold=ACTIVE'));
  assert(engine.includes('PrognozaEPIRBRSeries=br'));
  assert(engine.includes('PrognozaEPIRMIFG={'));
})();

(function testMeteogramUsesThreshold60ForAllFogPhenomena() {
  const overlay = read('fog-meteogram-overlay.js');
  assert(overlay.includes('function selectedMode()'));
  assert(overlay.includes('PrognozaEPIRFogLegacySeries'));
  assert(overlay.includes('PrognozaEPIRFogVNextSeries'));
  assert(overlay.includes('fogScoreLegacy'));
  assert(/FOG_DRAW_THRESHOLD\s*=\s*60/.test(overlay));
  assert(/BR_DRAW_THRESHOLD\s*=\s*60/.test(overlay));
  assert(/MIFG_DRAW_THRESHOLD\s*=\s*60/.test(overlay));
  assert(/FOG_INFO_THRESHOLD\s*=\s*60/.test(overlay));
  assert(/BR_INFO_THRESHOLD\s*=\s*60/.test(overlay));
  assert(/MIFG_INFO_THRESHOLD\s*=\s*60/.test(overlay));
})();

(function testCanonicalBridgeHardGatesBrAndMifgAt60() {
  const bridge = read('fog-index-bridge.js');
  assert(bridge.includes('const ACTIVE=60'));
  assert(bridge.includes('function activeRows(rows)'));
  assert(bridge.includes('mifg=activeRows(m)'));
  assert(bridge.includes('return activeRows(src.map(row=>engine.scoreRow'));
  assert(bridge.includes('PrognozaEPIRFogRenderThreshold=ACTIVE'));
})();

(function testQuickPreviewShowsBrAndSuppressesSub60Rows() {
  const cleanup = read('meteogram-visfog-cleanup.js');
  assert(cleanup.includes('const FOG_TOOLTIP_THRESHOLD = 60'));
  assert(cleanup.includes('function brAt(t)'));
  assert(cleanup.includes("appendHoverRow(tooltip,'Zamglenie · BR'"));
  assert(cleanup.includes('data-epir-br-hover'));
  assert(cleanup.includes('FOG / BR / MIFG ≥60/100'));
})();

(function testSectionInfoUsesSameThreshold60() {
  const section = read('fog-section-info-fix.js');
  assert(section.includes('const ACTIVE=60'));
  assert(section.includes("addOrReplace(values,'br','Zamglenie · BR',br,ACTIVE)"));
  assert(section.includes("addOrReplace(values,'mifg','Niska mgła <2 m · MIFG',mifg,ACTIVE)"));
})();

(function testPagesWiringTargetsIntegrated244Provider() {
  const wire = read('scripts/wire_fog_mifg_utc_runtime.py');
  assert(wire.includes('fog-engine-v244.js'));
  assert(wire.includes('PrognozaEPIRFogLegacySeries'));
  assert(wire.includes('FOG_TOOLTIP_THRESHOLD = 60'));
  assert(wire.includes('FOG_DRAW_THRESHOLD=60'));
})();

(function testTafUsesExactlySelectedFogMode() {
  const html = read('taf.html');
  const app = read('taf-app-v25.js');
  const bootstrap = read('taf-runtime-bootstrap.js');
  assert(html.includes('id="engine"'));
  assert(html.includes('taf-engine-v242.js?v=2.4.2-cloud-fog'));
  assert(html.includes('taf-runtime-bootstrap.js?v=20260919-1'));
  assert(bootstrap.includes('taf-engine-v243.js?v=${BUILD}'));
  assert(bootstrap.includes("QUALITY_VERSION !== ENGINE_LABEL"));
  assert(app.includes('const mode=Policy.selectedMode(w)'));
  assert(app.includes('Policy.seriesForMode(w,mode)'));
  assert(app.includes("if(mode==='vnext')throw Error"));
  assert(app.includes("throw Error('Fog Engine LEGACY nie udostępnił kompletnej serii.')"));
  assert(!app.includes("mode==='legacy'?'vnext'"));
})();

require('./taf-fog-policy.test.js');
require('./fog-native-page-contract.test.js');
require('./site-asset-integrity.test.js');
console.log('runtime integration contract: OK');
