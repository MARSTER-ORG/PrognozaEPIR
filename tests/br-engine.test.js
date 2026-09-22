'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(ROOT, 'br-engine.js'), 'utf8');
const integrated = fs.readFileSync(path.join(ROOT, 'fog-engine-v244.js'), 'utf8');

assert(bridge.includes("VERSION:'2.4.4-integrated-bridge'"), 'BR compatibility bridge version missing');
assert(bridge.includes('window.PrognozaEPIRFog244?.getBRSeries?.()'), 'BR bridge must consume the integrated 2.4.4 BR series');
assert(bridge.includes('window.PrognozaEPIRBREngine=api'), 'BR bridge must publish the compatibility API');
assert(integrated.includes('br:{score:F(bs)?100*C(bs):null}'), 'integrated Fog engine must calculate BR score');
assert(integrated.includes('PrognozaEPIRBRSeries=br'), 'integrated Fog engine must publish BR series');
assert(integrated.includes("const V='2.4.4',H=3600e3,ACTIVE=60"), 'integrated BR/Fog runtime must use activation threshold 60');

console.log('br-engine integrated 2.4.4 bridge: ok');
