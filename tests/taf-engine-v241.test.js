'use strict';
const assert=require('assert');
const E=require('../taf-engine-v241.js');
const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,8,14,0),end=start+12*H,issue=start-H;

function member({vis=12000,code=0,kt=6,dir=220,g=6,w=1}={}){return{vis,code,ws:kt/KT,wd:dir,g:g/KT,w,ceil:null};}
function row(i,o={}){
  const mv=o.mv||[member({vis:o.vis??12000,code:o.code??0}),member({vis:o.vis??12000,code:o.code??0}),member({vis:o.vis??12000,code:o.code??0})];
  return {t:start+i*H,T:o.T??10,Td:o.Td??7,RH:o.RH??70,RR:o.RR??0,VIS:o.vis??12000,WS:(o.kt??6)/KT,WD:o.dir??220,G:(o.gust??o.kt??6)/KT,wet:o.wet??0,storm:o.storm??0,dirSpread:10,profile:[{agl:200,cc:0},{agl:2500,cc:0}],ceiling:null,lowH:null,midH:null,highH:null,oktaL:0,oktaM:0,oktaH:0,mv,
    fogOperationalScore:o.fogOperationalScore??null,fgOperationalScore:o.fgOperationalScore??null,brOperationalScore:o.brOperationalScore??null,
    fogEngineAvailable:o.fogEngineAvailable??false,fogEngineScore:o.fogEngineScore??null,fogEngineVisM:o.fogEngineVisM??null,fogEngineConfidence:o.fogEngineConfidence??null,
    fogVis1500Risk:o.fogVis1500Risk??null,fogVis1000Risk:o.fogVis1000Risk??null,fogVis500Risk:o.fogVis500Risk??null,fogVis200Risk:o.fogVis200Risk??null,fogAltVisM:o.fogAltVisM??null};
}
function gen(rows,extra={}){return E.createEngine().generate({station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true,...extra});}

assert.equal(E.ENGINE_VERSION,'2.4.0');
assert.equal(E.QUALITY_VERSION,'2.4.1');

// 1) Regression: 0.7-1.0 mm/h is not heavy rain. Model WMO light-rain code
// must win over the obsolete RR>=0.7 => +RA shortcut in the formal kernel.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{RR:1,code:61,vis:12000}));
  const q=gen(rows);
  assert.match(q.taf,/\b-RA\b/,q.taf);
  assert.ok(!q.taf.includes('+RA'),q.taf);
}

// Heavy model code remains heavy even with 9999 visibility; visibility and
// precipitation intensity are independent TAF elements.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{RR:1,code:65,vis:12000}));
  const q=gen(rows);
  assert.match(q.taf,/\b9999\s+\+RA\b/,q.taf);
}

// 2) Regression from screenshot: do not emit PROB30 with exactly the same
// +RA already prevailing in the main group.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{RR:12,code:65,vis:12000}));
  rows[5]=row(5,{RR:12,vis:12000,mv:[member({code:65,w:.4}),member({code:0,w:.6})]});
  const q=gen(rows);
  assert.match(q.taf,/\b\+RA\b/,q.taf);
  assert.ok(!/PROB30(?: TEMPO)?[^\n]*\+RA/.test(q.taf),q.taf);
  assert.ok(q.diagnostics.reasons.some(x=>/bez nowej informacji/.test(x)),JSON.stringify(q.diagnostics.reasons));
}

// 3) Missing Fog Engine data is NOT zero. Legacy zero placeholders may not
// veto a 40% multimodel <1000 m signal.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:7000}));
  rows[5]=row(5,{vis:7000,mv:[member({vis:700,code:45,w:.4}),member({vis:7000,w:.6})],fogOperationalScore:0,fgOperationalScore:0,fogEngineAvailable:false});
  const q=gen(rows);
  assert.match(q.taf,/PROB30[^\n]*0\d{3}\s+(?:FZ)?FG/,q.taf);
}

// 4) A weak Fog Engine score does not hard-veto coherent model fog evidence.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:7000}));
  rows[5]=row(5,{vis:7000,mv:[member({vis:700,code:45,w:.4}),member({vis:7000,w:.6})],fogEngineAvailable:true,fogEngineScore:30,fogEngineConfidence:.8,fogVis1000Risk:25});
  const q=gen(rows);
  assert.match(q.taf,/PROB30[^\n]*0\d{3}\s+(?:FZ)?FG/,q.taf);
}

// Strong Fog Engine evidence remains capable of producing a fog alternative
// even when raw NWP visibility members do not cross 1000 m.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:7000}));
  rows[5]=row(5,{vis:7000,fogEngineAvailable:true,fogEngineScore:70,fogEngineConfidence:.8,fogVis1000Risk:65,fogEngineVisM:800,fogAltVisM:800});
  const q=gen(rows);
  assert.match(q.taf,/PROB30[^\n]*0800\s+(?:FZ)?FG/,q.taf);
}

// 5) Regression from screenshot: an issue-time-safe observed SCT035CB is
// remembered for the next few hours and must not disappear into NSC/CAVOK.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:12000}));
  const observation={raw:'EPIR 132130Z 23006KT 5000 SHRA SCT035CB 19/16 Q1010='};
  const q=gen(rows,{observation,rowsAlreadyAnchored:false});
  assert.match(q.taf,/PROB30 TEMPO\s+1400\/1402\s+SCT035CB/,q.taf);
  assert.equal(q.checks.ok,true,q.taf);
}

// Observation after issue time may never leak into an older TAF cycle.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:12000}));
  const observation={raw:'EPIR 140030Z 23006KT 5000 SHRA SCT035CB 19/16 Q1010='};
  const q=gen(rows,{observation,rowsAlreadyAnchored:false});
  assert.ok(!/CB|TCU/.test(q.taf),q.taf);
}

console.log('TAF Engine 2.4.1 semantic audit regressions: OK');
