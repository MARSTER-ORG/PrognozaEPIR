'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const api=require('../meteogram-precipitation-evidence.js');
const now=Date.parse('2026-11-21T20:00:00.000Z'),H=3600000,MIN=60000;
const epir={lat:52.828611,lon:18.330278};
const radar={
  point:epir,updatedAt:new Date(now-8*MIN).toISOString(),frameEnd:(now-12*MIN)/1000,
  source:'POLRAD',sourceProduct:'cmax',confidence:80,models:{support:2,total:3},
  predictions:{30:42,60:50,90:20,120:48,180:41}
};
const convection={
  point:epir,updatedAt:new Date(now-20*MIN).toISOString(),rows:[
    {time:now+H,modelCount:3,modelAgreement:80,cbProbability:74,tsProbability:68,tcuProbability:84},
    {time:now+2*H,modelCount:3,modelAgreement:62,cbProbability:56,tsProbability:44},
    {time:now+3*H,modelCount:3,modelAgreement:77,cbProbability:69,tsProbability:53}
  ]
};
const store=(r=radar,c=convection)=>({getItem(k){return JSON.stringify(k===api.KEYS[0]?r:c)}});
const evidence=api.read(store(),now);
assert.ok(evidence.radar&&evidence.convection);
const one=api.evaluate({t:now+H,precipType:{code:'RA'}},evidence,now);
assert.equal(one.marker,'radar');
assert.match(one.description,/Możliwy opad przelotny/);
assert.ok(api.tooltipRows({precipEvidence:one}).some(r=>r[0]==='POLRAD — prognoza ruchu'));
const noRadar=api.evaluate({t:now+H,precipType:{code:'RA'}},api.read(store(null,convection),now),now);
assert.equal(noRadar.marker,'convection');
assert.equal(api.evaluate({t:now+H,precipType:null},evidence,now).marker,'convection');
assert.equal(api.evaluate({t:now+2*H,precipType:{code:'RA'}},evidence,now).marker,null);
assert.equal(api.evaluate({t:now+3*H+15*MIN,precipType:{code:'RA'}},evidence,now).radarForecastEcho,false);
assert.equal(api.evaluate({t:now+13*H,precipType:{code:'RA'}},evidence,now).marker,null);
for(const bad of [
  {...radar,frameEnd:(now-46*MIN)/1000},
  {...radar,updatedAt:new Date(now-46*MIN).toISOString()},
  {...radar,point:{lat:54,lon:18}},
  {...radar,confidence:54},
  {...radar,models:{support:0,total:3}},
  {...radar,updatedAt:new Date(now+MIN).toISOString()},
  {...radar,sourceProduct:'unknown'}
])assert.equal(api.read(store(bad,convection),now).radar,null,'invalid radar must fail closed');
assert.equal(api.read(store(radar,{...convection,updatedAt:new Date(now-3*H).toISOString()}),now).convection,null);
assert.equal(api.read(store(radar,{...convection,point:{lat:50,lon:17}}),now).convection,null);
assert.equal(api.read({getItem(){return '{broken-json'}},now).radar,null);
assert.equal(api.prediction(radar,now+10*H,now),null);

const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
const pages=fs.readFileSync(path.join(root,'scripts/prepare_pages.py'),'utf8');
const hover=fs.readFileSync(path.join(root,'visual-style-fix.js'),'utf8');
const legend=fs.readFileSync(path.join(root,'meteogram-visfog-cleanup.js'),'utf8');
const chart=fs.readFileSync(path.join(root,'meteogram-precipitation-evidence.js'),'utf8');
for(const file of ['meteogram-precipitation-evidence.js','convection-horizon-12h.js'])
  assert.ok(index.includes(file)&&pages.includes(file),'both single page and deployed page must load '+file);
const indexOrder=pages.indexOf('meteogram-precipitation-evidence.js?v=');
assert.ok(indexOrder>pages.indexOf('meteogram-precipitation-types.js?v='));
assert.ok(pages.indexOf('convection-horizon-12h.js?v=')>indexOrder);
assert.match(hover,/PrognozaEPIRPrecipEvidence\?\.tooltipRows\(z\)/);
assert.match(legend,/Radar \+ konwekcja/);
assert.match(chart,/radarSource/);
assert.match(chart,/45\*MINUTE/);
assert.match(chart,/lead<=12\.5/);
assert.match(chart,/3\*HOUR/);

// Run both actual browser wrappers against Canvas without network or DOM frameworks.
const colors=[],rows=[{t:now+H,RR:1,precipType:{code:'RA'}}];
const ctx={save(){},restore(){},beginPath(){},rect(){},clip(){},translate(){},
  moveTo(){},lineTo(){},closePath(){},fill(){colors.push(this.fillStyle)},stroke(){}};
const localStorage=store();
const browser={
  document:{querySelector(){return null}},localStorage,
  addEventListener(){},PrognozaEPIRAdaptiveWeights:null
};
const context={
  window:browser,document:browser.document,Date:{now:()=>now,parse:Date.parse},
  Array,Number,Math,Object,JSON,Set,Map,console,
  ctx,cv:{_meta:{data:rows,x0:10,x1:610,t0:now,t1:now+2*H,panelYs:[{id:'prec',y:30,h:90}]}},
  dataVisible(){return rows;},draw(){},showSectionInfo(){},activeTheme(){return 'dark';}
};
vm.createContext(context);
vm.runInContext(chart,context);
context.dataVisible();context.draw();
assert.equal(rows[0].precipEvidence.marker,'radar');
assert.ok(colors.includes('#0891b2'),'Canvas must paint radar corroboration marker');
assert.equal(typeof browser.PrognozaEPIRPrecipEvidence.evaluate,'function');
console.log('Meteogram POLRAD+12h convection: freshness, 0–3h bound, location, UI and Canvas smoke PASS');
