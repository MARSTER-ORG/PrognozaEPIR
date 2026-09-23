'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'fog.html'), 'utf8');

const requiredNav = ['index.html','fog.html','radar.html','sat-fog.html','taf.html','arch.html'];
for (const href of requiredNav) assert(html.includes(`href="${href}"`), `missing top navigation link ${href}`);

assert(html.includes('id="fogStandaloneMount"'), 'missing native Fog mount');
assert(html.includes('window.__PROGNOZA_EPIR_FOG_STANDALONE__=true'), 'missing standalone runtime flag');
assert(html.includes('const MODELS=[];'), 'standalone page should not boot meteogram model registry');
assert(html.includes('const datasets=new Map();'), 'standalone Fog dataset registry missing');

const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/gi)].map(m => m[1].split('?')[0]);
const expectedScripts = [
  'utc-ui-guard.js',
  'theme.js',
  'message-archive-client.js',
  'fog-engine-v244.js',
  'fog-engine-v244-context.js',
  'fog-engine.js',
  'fog-mode-switch.js'
];
assert.deepStrictEqual(scripts, expectedScripts, 'fog.html must load MessageArchive before the integrated 2.4.4 standalone runtime and explicit Legacy/NEXT selector');
assert(html.includes('fog-mode-switch.js?v=20260923-mode2'), 'Fog selector cache key must be bumped after panel visibility repair');

const v244 = fs.readFileSync(path.join(ROOT, 'fog-engine-v244.js'), 'utf8');
assert(v244.includes("const V='2.4.4',H=3600e3,ACTIVE=60"), 'Fog 2.4.4 must use the unified 60/100 activation threshold');
assert(v244.includes("archive.latest(true)"), 'Fog 2.4.4 observations must use MessageArchive.latest');
assert(v244.includes('PrognozaEPIRBRSeries=br'), 'Fog 2.4.4 must publish BR');
assert(v244.includes('PrognozaEPIRMIFG={'), 'Fog 2.4.4 must publish MIFG');

const modeSwitch = fs.readFileSync(path.join(ROOT, 'fog-mode-switch.js'), 'utf8');
assert(modeSwitch.includes("const KEY = 'prognozaepir-fog-engine-mode'"), 'Fog selector must use the shared engine-mode key');
assert(modeSwitch.includes("MODE_LEGACY = 'legacy'"), 'Fog selector must expose Legacy mode');
assert(modeSwitch.includes("MODE_VNEXT = 'vnext'"), 'Fog selector must expose NEXT mode');
assert(modeSwitch.includes('AKTYWNY: LEGACY'), 'Fog selector must show active Legacy state');
assert(modeSwitch.includes('AKTYWNY: NEXT 2.4.4'), 'Fog selector must show active NEXT state');
assert(modeSwitch.includes("legacyPanel.style.setProperty('display', mode === MODE_LEGACY ? 'block' : 'none', 'important')"), 'Legacy panel must be explicitly hidden when NEXT is active');
assert(modeSwitch.includes("nextPanel.style.setProperty('display', mode === MODE_VNEXT ? 'block' : 'none', 'important')"), 'NEXT panel must be explicitly hidden when Legacy is active');
assert(modeSwitch.includes("heading.textContent = 'EPIR FOG ENGINE LEGACY'"), 'previous Fog engine must be visibly labelled LEGACY');

const bridge = fs.readFileSync(path.join(ROOT, 'fog-index-bridge.js'), 'utf8');
assert(bridge.includes('FOG ENGINE: NEXT 2.4.4'), 'meteogram must identify NEXT Fog mode');
assert(bridge.includes('FOG ENGINE: LEGACY'), 'meteogram must identify Legacy Fog mode');

const forbidden = [
  '<iframe','index.html?fogpanel=','fogRuntime','runtime-wrap','<canvas','canvasViewport',
  'MutationObserver','ResizeObserver','observation-engine.js','fog-meteogram-overlay.js',
  'shortcut-mode.js','epir-pages-compat-'
];
for (const marker of forbidden) assert(!html.includes(marker), `forbidden meteogram/dead runtime marker: ${marker}`);

console.log('native Fog page contract: OK');
