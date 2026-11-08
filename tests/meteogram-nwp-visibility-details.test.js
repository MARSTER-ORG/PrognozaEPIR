'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

class Element {
  constructor(type='div'){
    this.tagName=type.toUpperCase();this.children=[];this.attributes={};
    this.style={};this.className='';this.textContent='';
  }
  setAttribute(k,v){this.attributes[k]=v;}
  append(...nodes){this.children.push(...nodes);}
  appendChild(node){this.children.push(node);}
  querySelector(selector){
    if(selector==='[data-epir-nwp-vis]')
      return this.children.find(x=>x.attributes['data-epir-nwp-vis']==='1')||null;
    if(selector==='strong')
      return this.children.find(x=>x.tagName==='STRONG')||null;
    return null;
  }
}
const values=new Element();
const start=Date.parse('2026-11-08T20:00:00Z');
const hour=3600e3;
const rows=[
  {t:start,VIS:260,VIS_MODEL:9500},
  {t:start+hour,VIS:400,VIS_MODEL:23500},
  {t:start+2*hour,VIS:18000,VIS_MODEL:null}
];
const canvas={_meta:{data:rows},getContext:()=>null};
const document={
  getElementById:id=>id==='meteo'?canvas:null,
  querySelector:sel=>sel==='#sectionInfo .section-values'?values:null,
  createElement:type=>new Element(type),
  addEventListener(){}
};
const browser={
  window:{document,PrognozaEPIRMessageArchive:{recent:async()=>({metar_only:[],speci:[]})}},
  document,Date,Number,Math,Map,Promise,console,
  setInterval:()=>1,
  draw:()=>{},
  showSectionInfo:()=>{},
};
vm.runInNewContext(fs.readFileSync(path.join(root,'meteogram-vis-comparison.js'),'utf8'),browser);
const api=browser.window.PrognozaEPIRMeteogramVisComparison;
assert(api,'VIS comparison API exported');
assert.equal(api.modelVisibilityAt(start),9500);
assert.equal(api.modelVisibilityAt(start+hour),23500);
assert.equal(api.modelVisibilityAt(start+hour+20*60000),23500,
  'within interpolation window use the same plotted model hour');
assert.equal(api.modelVisibilityAt(start+hour+40*60000),null,
  'missing model sample at nearer hour must not fall back to Fog Engine VIS');
assert.equal(api.modelVisibilityAt(start+3*hour),null);
assert.equal(api.modelVisibilityAt(start+3*hour,null),null,'null cannot become 0');
assert.equal(api.formatModelVis(23500),'23.5 km',
  'a 15-km plot limit must not truncate tooltip/card value');
assert.equal(api.formatModelVis(260),'260 m');
assert.equal(api.formatModelVis(null),'—');
browser.showSectionInfo(rows[0],'visfog');
assert.equal(values.children.length,1,'one NWP card should be added');
assert.equal(values.children[0].children[0].textContent,'NWP · widzialność modeli (linia niebieska)');
assert.equal(values.children[0].children[1].textContent,'9.5 km');
browser.showSectionInfo(rows[1],'visfog');
assert.equal(values.children.length,1,'NWP card must not duplicate');
assert.equal(values.children[0].children[1].textContent,'23.5 km',
  'NWP card must show the complete model value');
browser.showSectionInfo(rows[2],'visfog');
assert.equal(values.children[0].children[1].textContent,'—',
  'a missing VIS_MODEL must never display orange Fog VIS');
const legend=fs.readFileSync(path.join(root,'meteogram-visfog-cleanup.js'),'utf8');
const hover=fs.readFileSync(path.join(root,'visual-style-fix.js'),'utf8');
const help=fs.readFileSync(path.join(root,'fog-section-info-fix.js'),'utf8');
assert(legend.includes("sample('NWP VIS (km)','#2d91d0',[5,4])"),
  'canvas legend must visibly match the blue dashed series');
assert(legend.includes("sample('VIS FOG ENGINE (km)','#d66c12')"),
  'orange Fog Engine visibility must be distinguished');
assert(hover.includes("['NWP · widzialność modeli',finiteNum(z.VIS_MODEL)"),
  'hover tooltip must read VIS_MODEL, not VIS');
assert(help.includes('Niebieska przerywana: surowa widzialność konsensusu NWP'),
  'section help must explain the line');
console.log('NWP visibility legend, hover and selection card regression: OK');
