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
  'fog-mode-switch.js',
  'fog-engine.js',
  'mifg-engine.js',
  'fog-summary-layout.js',
  'br-engine.js',
  'fog-page-layout.js',
  'fog-visibility-cells.js'
];
assert.deepStrictEqual(scripts, expectedScripts, 'fog.html must load only the approved standalone runtime scripts');

const forbidden = [
  '<iframe','index.html?fogpanel=','fogRuntime','runtime-wrap','<canvas','canvasViewport',
  'MutationObserver','ResizeObserver','observation-engine.js','fog-meteogram-overlay.js',
  'shortcut-mode.js','message-archive-client.js','epir-pages-compat-'
];
for (const marker of forbidden) assert(!html.includes(marker), `forbidden meteogram/dead runtime marker: ${marker}`);

console.log('native Fog page contract: OK');
