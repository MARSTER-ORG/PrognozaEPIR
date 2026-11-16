'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname,'..');
const source = fs.readFileSync(path.join(root,'meteogram-visfog-split.js'),'utf8');
const legend = fs.readFileSync(path.join(root,'meteogram-visfog-cleanup.js'),'utf8');

const start = source.indexOf('  function drawHourlyBaseDots(');
const end = source.indexOf('  const CLOUD_BANDS_CACHE=',start);
assert.ok(start>0 && end>start,'hourly dots helper must exist in the deployed renderer');
const cloudbaseStart = source.indexOf("    p=byId('cloudbase');");
const cloudbaseEnd = source.indexOf("    p=byId('cloud');",cloudbaseStart);
const panel = source.slice(cloudbaseStart,cloudbaseEnd);
assert.ok(panel.includes('drawHourlyBaseDots(d,p,x)'), 'cloudbase panel must use point-only renderer');
assert.ok(!panel.includes('drawSeries('), 'no connecting FEW/SCT/BKN lines should survive');
assert.ok(panel.includes('h===450'), '450 m reference line must remain');
for(const [name,color] of [['BKN/OVC (≥5/8)','#e65d5d'],['SCT (3–4/8)','#f29d38'],['FEW (1–2/8)','#e5bf35']])
  assert.ok(legend.includes("dot('"+name+"','"+color+"')"), name+' must be a dot in the active legend');

const circles = [],strokes = [],lines = [];
const ctx = {
  fillStyle:'',strokeStyle:'',lineWidth:1,
  save(){},restore(){},setLineDash(){},beginPath(){},
  arc(x,y,r,start,end){circles.push({x,y,r,start,end,color:this.fillStyle});},
  fill(){},stroke(){strokes.push(this.strokeStyle);},
  moveTo(){lines.push('moveTo');},lineTo(){lines.push('lineTo');}
};
const rows = [
  {t:0,bases:{few:200,sct:600,bkn:1100},ceiling:1150},
  {t:3600000,bases:{few:null,sct:450,bkn:null}},
  {t:7200000,bases:{few:2000,sct:700,bkn:900},ceiling:1900},
  {t:10800000,bases:{}},
  {t:14400000,bases:{few:0,sct:-10,bkn:1500}}
];
vm.runInNewContext(source.slice(start,end) + '\ndrawHourlyBaseDots(rows,{y:10,h:100},t=>t/3600000*10);',{
  rows,ctx,bands:z=>({bases:z.bases}),cloudBaseY:(h,p)=>Number.isFinite(h)&&h>=0&&h<=1500?p.y+p.h-(h/1500)*p.h:NaN,
  finite:Number.isFinite,activeTheme:()=> 'dark',Math
});
assert.equal(circles.length,7,'only valid hourly bases must receive a point');
assert.deepEqual(circles.map(c=>c.color),[
  '#e5bf35','#e5bf35',
  '#f29d38','#f29d38','#f29d38',
  '#e65d5d','#e65d5d'
]);
assert.deepEqual(circles.filter(c=>c.color==='#e65d5d').map(c=>Math.round(c.y*10)/10),
  [Math.round((110-1150/1500*100)*10)/10,10]);
assert.deepEqual(circles.map(c=>c.x),[0,40,0,10,20,0,40],
  'each point must stay at the source hour without interpolation');
assert.equal(lines.length,0,'hourly base renderer must not connect different hours');
assert.ok(circles.every(c=>c.r>=3 && c.r<=4),'point markers remain readable');
console.log('Cloud-base FEW/SCT/BKN hourly dots: 7 valid dots, 0 connecting segments, 450 m line retained');
