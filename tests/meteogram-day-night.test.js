'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const calls = [];
let theme = 'dark';
const ctx = {save(){},restore(){},fillRect(...rect){calls.push({rect,color:this.fillStyle});}};
const browser = {ctx,draw(){},PANELS:[],PLACE:{lat:52.828611,lon:18.330278},activeTheme:()=>theme};
browser.window = browser;
vm.runInNewContext(fs.readFileSync(path.join(root,'day-night-fix.js'),'utf8'),browser);
const t0 = Date.UTC(2026,10,17), t1 = t0 + 48*3600e3;
for (const mode of ['dark','light']) {
  theme = mode;
  calls.length = 0;
  // Actual merged wind height, then all lower panels, including cloud layers.
  let y = 55;
  const heights = [96,90,84,78,112,96,164,142,108];
  const groups = [];
  for (const h of heights) {
    const start = calls.length;
    browser.PrognozaEPIRShadePanel({t0,t1,x0:100,x1:900,y,h});
    const group = calls.slice(start);
    assert.ok(group.length > 0, `${mode}: shading missing at y=${y}`);
    for (const {rect} of group) {
      assert.equal(rect[1],y);
      assert.equal(rect[3],h);
      assert.ok(rect[0]>=100 && rect[0]+rect[2]<=900.000001);
    }
    groups.push(group.map(({rect})=>[rect[0],rect[2]]));
    y+=h;
  }
  groups.forEach(group=>assert.deepEqual(group,groups[0], 'solar boundaries align in every panel'));
  const start = calls.length;
  browser.PrognozaEPIRShadePanel({t0,t1,x0:100,x1:900,y:403,h:112});
  assert.deepEqual(calls.slice(start).map(({rect})=>[rect[0],rect[2]]),groups[0], 'late wind repaint restores shading');
}
for (const name of ['meteogram-visfog-split.js','meteogram-visfog-cleanup.js']) {
  const source = fs.readFileSync(path.join(root,name),'utf8');
  assert.match(source,/ctx\.fillRect\(x0,(?:p\.)?y,plotW,p\.h\);\s*window\.PrognozaEPIRShadePanel\?\./, `${name}: shading follows background, before foreground`);
}
console.log('Day/night shading: aligned across all panels and late wind redraw, dark/light OK');
