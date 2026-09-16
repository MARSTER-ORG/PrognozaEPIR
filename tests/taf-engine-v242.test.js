'use strict';
const assert=require('assert');
const E=require('../taf-engine-v242.js');
const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,8,14,0),end=start+12*H,issue=start-H;

function member({vis=12000,code=0,kt=6,dir=220,g=6,w=1}={}){return{vis,code,ws:kt/KT,wd:dir,g:g/KT,w,ceil:null};}
function row(i,o={}){
  const mv=o.mv||[member({vis:o.vis??12000,code:o.code??0}),member({vis:o.vis??12000,code:o.code??0}),member({vis:o.vis??12000,code:o.code??0})];
  return {t:start+i*H,T:o.T??10,Td:o.Td??7,RH:o.RH??70,RR:o.RR??0,VIS:o.vis??12000,WS:(o.kt??6)/KT,WD:o.dir??220,G:(o.gust??o.kt??6)/KT,wet:o.wet??0,storm:o.storm??0,dirSpread:10,
    profile:o.profile!==undefined?o.profile:[{agl:200,cc:0},{agl:2500,cc:0}],ceiling:o.ceiling??null,lowH:o.lowH??null,midH:null,highH:null,oktaL:o.oktaL??0,oktaM:0,oktaH:0,mv,
    fogOperationalScore:o.fogOperationalScore??null,fgOperationalScore:o.fgOperationalScore??null,brOperationalScore:o.brOperationalScore??null,
    fogEngineAvailable:o.fogEngineAvailable??false,fogEngineScore:o.fogEngineScore??null,fogEngineVisM:o.fogEngineVisM??null,fogEngineConfidence:o.fogEngineConfidence??null,
    fogVis1500Risk:o.fogVis1500Risk??null,fogVis1000Risk:o.fogVis1000Risk??null,fogVis500Risk:o.fogVis500Risk??null,fogVis200Risk:o.fogVis200Risk??null,fogAltVisM:o.fogAltVisM??null,
    fogEngineType:o.fogEngineType??null};
}
function gen(rows,extra={}){return E.createEngine().generate({station:'EPIR',issue,start,end,rows,rowsAlreadyAnchored:true,...extra});}

assert.equal(E.ENGINE_VERSION,'2.4.0');
assert.equal(E.QUALITY_VERSION,'2.4.2');
assert.equal(E.helpers.normalizeSub100CloudCodes('24006KT 9999 FEW000'),'24006KT 9999 FEW001');
assert.equal(E.helpers.cloudToken('BKN',30),'BKN001');
assert.equal(E.helpers.cloudToken('BKN',60),'BKN002');
assert.equal(E.helpers.cloudToken('BKN',150),'BKN005');

// A forecast layer below 100 ft must never leak into the TAF as FEW/SCT/BKN/OVC000.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{profile:[{agl:0,cc:35},{agl:200,cc:35}]}));
  const q=gen(rows);
  assert.ok(!/\b(?:FEW|SCT|BKN|OVC)000(?:CB|TCU)?\b/.test(q.taf),q.taf);
  assert.match(q.taf,/\bSCT001\b|\bFEW001\b/,q.taf);
  assert.equal(q.checks.ok,true,q.taf);
}

// Strong low BKN evidence around 30 m is represented at 001, not 000.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{profile:[{agl:30,cc:70},{agl:300,cc:70}],ceiling:30,lowH:30,oktaL:6}));
  const q=gen(rows);
  assert.match(q.taf,/\bBKN001\b/,q.taf);
  assert.ok(!q.taf.includes('BKN000'),q.taf);
}

// Fog alternative + CBL/near-surface SCT signal = coherent fog-to-Stratus alternative.
// The generator may add BKN001 to PROB30 FG, but only because there is independent
// low-cloud/transition evidence; FG alone is not enough to invent Stratus.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:7000}));
  rows[5]=row(5,{vis:7000,fogEngineType:'CBL',profile:[{agl:20,cc:35},{agl:100,cc:35},{agl:900,cc:0}],mv:[member({vis:700,code:45,w:.4}),member({vis:7000,w:.6})],fogOperationalScore:0,fgOperationalScore:0,fogEngineAvailable:false,fogAltVisM:900});
  const q=gen(rows);
  assert.match(q.taf,/PROB30[^\n]*0900\s+(?:FZ)?FG[^\n]*BKN001/,q.taf);
  assert.ok(q.diagnostics.reasons.some(x=>/Stratus\/fog-transition/.test(x)),JSON.stringify(q.diagnostics.reasons));
  assert.equal(q.checks.ok,true,q.taf);
}

// With no low-cloud or CBL signal, a PROB30 FG group stays a fog-only alternative.
{
  const rows=Array.from({length:12},(_,i)=>row(i,{vis:7000}));
  rows[5]=row(5,{vis:7000,mv:[member({vis:700,code:45,w:.4}),member({vis:7000,w:.6})],fogOperationalScore:0,fgOperationalScore:0,fogEngineAvailable:false,fogAltVisM:900});
  const q=gen(rows);
  const fg=(q.taf.match(/PROB30[^\n]*(?:FZ)?FG[^\n]*/)||[])[0]||'';
  assert.ok(fg, q.taf);
  assert.ok(!/\b(?:BKN|OVC)00[1-3]\b/.test(fg),q.taf);
}

console.log('TAF Engine 2.4.2 low-cloud/fog coherence regressions: OK');
