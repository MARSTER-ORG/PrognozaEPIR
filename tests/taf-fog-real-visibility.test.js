'use strict';
// Instruction TAF SZ RP, ed. A (11.2023), secs. 3.6, 3.7, 3.11.
// Regression: conditional VVVV and evidence-backed PROB30 FG/BR periods.
const assert=require('assert');
const Kernel=require('../taf-engine-v2.js');
const Operational=require('../taf-engine-v243.js');
const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,9,11,18),end=start+12*H,issue=start-H;
const member=(vis,w=1)=>({vis,w,code:0,ws:6/KT,wd:210,g:6/KT,ceil:null});
function row(i,o={}){
  const vis=o.vis??12000;
  return {t:start+i*H,T:8,Td:7,RH:92,RR:0,VIS:vis,WS:6/KT,WD:210,G:6/KT,
    wet:0,storm:0,dirSpread:10,profile:[{agl:200,cc:0},{agl:2500,cc:0}],
    ceiling:null,lowH:null,midH:null,highH:null,oktaL:0,oktaM:0,oktaH:0,
    mv:o.mv||[member(vis),member(vis),member(vis)],
    fogOperationalScore:o.fogOperationalScore??null,
    fgOperationalScore:o.fgOperationalScore??null,
    brOperationalScore:o.brOperationalScore??null,
    fogEngineAvailable:o.fogEngineAvailable??true,
    fogEngineScore:o.fogEngineScore??null,
    fogEngineVisM:o.fogEngineVisM??null,
    fogAltVisM:o.fogAltVisM??null,
    brAltVisM:o.brAltVisM??null};
}
const gen=(engine,rows)=>engine.createEngine().generate({station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true});
const blank=()=>Array.from({length:12},(_,i)=>row(i));
function fogRows(vis,first,count){
  const rows=blank();
  for(let i=first;i<first+count;i++)rows[i]=row(i,{
    fogOperationalScore:70,fgOperationalScore:70,
    fogEngineVisM:vis,fogAltVisM:vis});
  return rows;
}
for(const engine of [Kernel,Operational]){
  for(const [vis,coded] of [[240,'0200'],[760,'0750'],[930,'0900']]){
    const q=gen(engine,fogRows(vis,4,3));
    assert.match(q.taf,new RegExp('PROB30 1122/1201 '+coded+' FG'),q.taf);
    assert.equal(q.checks.ok,true,q.taf);
  }
  const two=gen(engine,fogRows(650,4,2));
  assert.match(two.taf,/PROB30 1122\/1124 0650 FG/,two.taf);
  const single=gen(engine,fogRows(420,4,1));
  assert.match(single.taf,/PROB30 1122\/1123 0400 FG/,single.taf);
  // FG risk without a real VIS value cannot be converted to fake 0800m.
  const missing=blank();
  missing[4]=row(4,{fgOperationalScore:70,fogOperationalScore:70,
    fogEngineScore:70,mv:[member(12000),member(12000),member(12000)]});
  const noVis=gen(engine,missing);
  assert.doesNotMatch(noVis.taf,/\bPROB30[^\n]*\b(?:FG|FZFG)\b/,noVis.taf);
  // NWP conditional visibility is valid when Fog Engine point is missing.
  const modelAlt=blank();
  modelAlt[4]=row(4,{vis:9000,fgOperationalScore:0,fogOperationalScore:0,
    mv:[member(470,.4),member(9000,.6)]});
  const modeled=gen(engine,modelAlt);
  assert.match(modeled.taf,/PROB30[^\n]*0450 FG/,modeled.taf);
  // BR uses 2600m rather than a generic low-visibility FG placeholder.
  const br=blank();
  for(let i=4;i<8;i++)br[i]=row(i,{fogEngineVisM:2600,brOperationalScore:70,
    fogOperationalScore:0,fgOperationalScore:0});
  const brResult=gen(engine,br);
  assert.match(brResult.taf,/PROB30 1122\/1202 2600 BR/,brResult.taf);
  assert.doesNotMatch(brResult.taf,/\b0800 FG\b/,brResult.taf);
}
console.log('TAF actual FG/BR visibility and duration: OK');
