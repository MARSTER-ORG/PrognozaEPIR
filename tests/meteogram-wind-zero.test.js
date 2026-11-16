'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const wind=require('../meteogram-wind-zero.js');

const expected=[
  [0,'#2689d6'],[5,'#2689d6'],[5.001,'#29a65a'],
  [10,'#29a65a'],[10.001,'#dfbc24'],
  [15,'#dfbc24'],[15.001,'#ec8526'],
  [25,'#ec8526'],[25.001,'#d93a3a'],[50,'#d93a3a']
];
for(const [speed,color] of expected)
  assert.equal(wind.band(speed)?.color,color,'bad colour for '+speed+' m/s');
for(const value of [null,undefined,-1,NaN,Infinity])
  assert.equal(wind.band(value),null,'bad speed should not become a colour');

const spans=wind.segments(3,29);
assert.deepEqual(spans.map(s=>s.band.max),[5,10,15,25,Infinity]);
assert.deepEqual(spans.map(s=>s.to),[5,10,15,25,29]);
assert.equal(spans[0].start,0);
assert.equal(spans[spans.length-1].end,1);
for(let i=1;i<spans.length;i++)assert.equal(spans[i].start,spans[i-1].end);
assert.deepEqual(wind.segments(29,3).map(s=>s.band.max),[Infinity,25,15,10,5]);
assert.equal(wind.segments(20,20).length,1);
assert.deepEqual(wind.segments(5,NaN),[]);
assert.deepEqual(wind.segments(-1,5),[]);

const src=fs.readFileSync(path.join(__dirname,'..','meteogram-visfog-split.js'),'utf8');
const layout=fs.readFileSync(path.join(__dirname,'..','meteogram-layout-v2.js'),'utf8');
const page=fs.readFileSync(path.join(__dirname,'..','scripts/prepare_pages.py'),'utf8');
assert.match(src,/Math\.min\(min,0\)/,'active temperature axis must include zero');
assert.match(src,/Math\.max\(max,0\)/,'active temperature axis must include zero');
assert.match(layout,/>25/,'legend must show red threshold');
assert.match(layout,/0°C — granica/,'legend must show zero crossing');
assert.match(page,/meteogram-wind-zero\.js/,'Pages must include the final accent layer');
console.log('Meteogram wind bands and 0°C: 21 boundary and wiring checks OK');


assert.equal(wind.axisMax([{WS:3,G:7}]),10,'7 m/s gusts should scale to 10 m/s');
assert.equal(wind.axisMax([{WS:1.2,G:3.6}]),5,'weak wind should scale to 5 m/s');
assert.equal(wind.axisMax([{WS:12.4,G:14.9}]),15,'14.9 m/s should scale to 15 m/s');
assert.equal(wind.axisMax([{WS:18.2,G:17}]),20,'18.2 m/s should scale to 20 m/s');
assert.equal(wind.axisMax([{WS:25,G:25.1}]),30,'a 25.1 m/s gust should scale to 30 m/s');
assert.equal(wind.axisMax([{WS:NaN,G:-2}]),5,'invalid readings do not raise the scale');
assert.equal(wind.axisMax([{WS:24,G:30}]),30,'strong wind extends the scale');
assert.deepEqual(wind.axisTicks(5),[0,5]);
assert.deepEqual(wind.axisTicks(10),[0,5,10]);
assert.deepEqual(wind.axisTicks(15),[0,5,10,15]);
assert.deepEqual(wind.axisTicks(20),[0,5,10,15,20]);
assert.deepEqual(wind.axisTicks(30),[0,5,10,15,25,30]);

const cleaned=fs.readFileSync(path.join(__dirname,'..','meteogram-visfog-cleanup.js'),'utf8');
assert.match(cleaned,/windVisual\.segments\(a\.WS,b\.WS\)/,'the last wind painter must use the colour bands');
assert.match(cleaned,/const windTicks = windVisual\?\.axisTicks/,'actual thresholds must drive the wind-axis ticks');
assert.doesNotMatch(cleaned,/value\*3\.6/,'wind panel must not render a km/h axis');
assert.match(cleaned,/sample\('>25','#d93a3a'\)/,'last legend must show red threshold');
assert.match(cleaned,/sample\('Granica 0°C'/,'last legend must include 0°C');
assert.doesNotMatch(cleaned,/drawSeries\('WS','#152f9a'/,'obsolete blue stroke must not cover the colour line');

const addonStart=page.indexOf('f\'<script src="meteogram-wind-zero.js?v=');
const foregroundStart=page.indexOf('f\'<script src="meteogram-visfog-cleanup.js?v=');
assert.ok(addonStart>=0 && addonStart<foregroundStart,'colour palette must load before the final wind painter');
assert.equal((page.match(/f'<script src="meteogram-wind-zero.js\?v=/g)||[]).length,1);

// Execute the actual production wind renderer against a recording Canvas stub.
// This detects a plausible-looking legend with a still-monochrome plot.
const begin=cleaned.indexOf('  function redrawWindPanelForeground() {');
const end=cleaned.indexOf('  window.PrognozaEPIRRedrawWindForeground =',begin);
assert.ok(begin>=0 && end>begin);
const colors=[],labels=[],dashes=[];
const stack=[],ctx={
  fillStyle:'',strokeStyle:'',globalAlpha:1,
  save(){stack.push({fillStyle:this.fillStyle,strokeStyle:this.strokeStyle,globalAlpha:this.globalAlpha});},
  restore(){Object.assign(this,stack.pop());},
  beginPath(){},rect(){},clip(){},fillRect(){},strokeRect(){},
  moveTo(){},lineTo(){},closePath(){},translate(){},rotate(){},
  strokeText(){},
  fill(){colors.push(this.fillStyle);},
  stroke(){},
  fillText(label,x,y){labels.push({label:String(label),x,y});},
  setLineDash(d){dashes.push(d.slice());}
};
const h=3600e3;
const rows=[
  {t:0,WS:3,G:6,WD:0},
  {t:h,WS:7,G:11,WD:30},
  {t:2*h,WS:12,G:16,WD:60},
  {t:3*h,WS:20,G:26,WD:90},
  {t:4*h,WS:28,G:32,WD:120}
];
vm.runInNewContext(cleaned.slice(begin,end)+'\nredrawWindPanelForeground();',{
  ctx,cv:{_meta:{x0:100,x1:700,t0:0,t1:4*h,panelYs:[{id:'wind',y:0,h:112}],data:rows}},
  window:{PrognozaEPIRWindVisual:wind},
  canvasPalette:()=>({panel:'#222',grid:'#666',grid2:'#777',border:'#999',bg:'#101010',muted:'#aaa',text:'#eee'}),
  finite:Number.isFinite,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
  activeTheme:()=> 'dark',WIND_ARROW:'#ef4444',HOUR:h,RIGHT_W:48
});
for(const [,color] of expected.filter((_,i)=>[0,2,4,6,8].includes(i)))
  assert.ok(colors.includes(color),'production panel never paints colour '+color);
for(const threshold of ['5','10','15','25'])
  assert.ok(labels.some(item=>item.label===threshold && item.x===92),
    'missing m/s axis threshold '+threshold);
assert.ok(labels.every(item=>item.x!==707),
  'wind renderer must never paint a right-hand km/h tick');
assert.ok(dashes.some(d=>d.length===2 && d[0]===6 && d[1]===4),
  'gust line should remain dashed');

console.log('Visible threshold lines and coloured Canvas fills, without km/h labels, OK');


// A 14.9 m/s maximum must display the 0–15 m/s axis and BOTH endpoints.
labels.length=0;
vm.runInNewContext(cleaned.slice(begin,end)+'\nredrawWindPanelForeground();',{
  ctx,cv:{_meta:{x0:100,x1:700,t0:0,t1:h,panelYs:[{id:'wind',y:0,h:112}],data:[
    {t:0,WS:3,G:7,WD:0},{t:h,WS:6,G:14.9,WD:30}
  ]}},
  window:{PrognozaEPIRWindVisual:wind},
  canvasPalette:()=>({panel:'#222',grid:'#666',grid2:'#777',border:'#999',bg:'#101010',muted:'#aaa',text:'#eee'}),
  finite:Number.isFinite,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
  activeTheme:()=> 'dark',WIND_ARROW:'#ef4444',HOUR:h,RIGHT_W:48
});
for(const tick of ['0','5','10','15'])
  assert.ok(labels.some(item=>item.label===tick && item.x===92),
    '0–15 m/s chart must show axis tick '+tick);
console.log('Both wind-axis endpoint labels remain visible');

// Dynamic 0–10 m/s scale; 15/25 m/s must not appear on the axis.
labels.length=0;
vm.runInNewContext(cleaned.slice(begin,end)+'\nredrawWindPanelForeground();',{
  ctx,cv:{_meta:{x0:100,x1:700,t0:0,t1:h,panelYs:[{id:'wind',y:0,h:112}],data:[
    {t:0,WS:2,G:5,WD:0},{t:h,WS:4,G:6.8,WD:30}
  ]}},
  window:{PrognozaEPIRWindVisual:wind},
  canvasPalette:()=>({panel:'#222',grid:'#666',grid2:'#777',border:'#999',bg:'#101010',muted:'#aaa',text:'#eee'}),
  finite:Number.isFinite,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
  activeTheme:()=> 'dark',WIND_ARROW:'#ef4444',HOUR:h,RIGHT_W:48
});
for(const tick of ['0','5','10'])
  assert.ok(labels.some(item=>item.label===tick && item.x===92),
    'dynamic 0–10 m/s chart must show tick '+tick);
for(const tick of ['15','25'])
  assert.ok(!labels.some(item=>item.label===tick && item.x===92),
    'dynamic 0–10 m/s chart must hide out-of-range tick '+tick);
assert.ok(labels.every(item=>item.x!==707),'right axis values must stay hidden');
console.log('Dynamic wind scale and left-only axis verified');
