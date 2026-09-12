'use strict';
const assert=require('assert');
const H=require('../taf-hybrid-engine.js');
const P=require('../taf-generator-policy.js');
const HOUR=3600000,KT=1.9438444924406;

function row(t,opt={}){
  const kt=opt.kt??6,dir=opt.dir??210,vis=opt.vis??12000,lowFt=opt.lowFt??4100,oktaL=opt.oktaL??2,midFt=opt.midFt??7000,oktaM=opt.oktaM??3,rr=opt.rr??0,code=opt.code??0;
  const model=(id,c=code)=>({id,w:1,ws:kt/KT,wd:dir,g:kt/KT,vis,ceil:9000/3.280839895,code:c});
  return {t,WS:kt/KT,WD:dir,G:kt/KT,VIS:vis,ceiling:9000/3.280839895,lowH:lowFt/3.280839895,midH:midFt/3.280839895,highH:18000/3.280839895,oktaL,oktaM,oktaH:0,RH:70,RR:rr,wet:0,storm:0,dirSpread:5,mv:[model('A'),model('B'),model('C'),model('D')]};
}

assert.equal(P.VERSION,'2.0.0');

// Project rule: TAF starting 18-05 UTC, >75% of 12h with FEW/SCT >=4000ft
// (ordinary BKN/OVC >=5000ft is also operationally insignificant) -> CAVOK/NSC base.
{
  const start=Date.UTC(2026,8,13,0),end=start+12*HOUR,issue=start-HOUR;
  const rows=Array.from({length:12},(_,i)=>row(start+i*HOUR,{lowFt:i<10?4100:3500,oktaL:2}));
  const api=P.wrapApi(H),eng=api.createEngine({storage:{get(){return null},set(){}}});
  const r=eng.generate({station:'EPIR',issue,start,end,rows,record:false});
  assert.ok(r.tuning.dominantClear);
  assert.equal(r.tuning.dominantClear.count,10);
  assert.match(r.base.text,/\bCAVOK\b/);
  assert.match(r.taf,/\bCAVOK\b/);
}

// Exactly 75% is not enough: the project rule says above 75%.
{
  const start=Date.UTC(2026,8,13,0),rows=Array.from({length:12},(_,i)=>row(start+i*HOUR,{lowFt:i<9?4100:3500,oktaL:2}));
  assert.equal(P.dominantClearPlan(rows,start),null);
}

// A visibility change entirely above 5000 m must not create/change VIS in a change group.
{
  const prev={visM:10000},target={visM:8000};
  assert.equal(P.visibilityNeedsGroup(prev,target),false);
}

// Crossing below 5000 m is significant.
{
  const prev={visM:10000},target={visM:4000};
  assert.equal(P.visibilityNeedsGroup(prev,target),true);
}

// Standalone weak ordinary precipitation at 9999 is not a PROB30-worthy impact.
{
  const t=Date.UTC(2026,8,13,0),h={t,visM:10000,clouds:[],sourceRow:{__hybridTuning:{lowVis:false,protectedEvent:false,moderateOrHeavy:false}}};
  const r={station:'EPIR',issue:t-HOUR,start:t,end:t+12*HOUR,version:'1.0.0',base:{text:'21006KT CAVOK',state:h},hourly:[h],groups:[{kind:'PROB30',start:t,end:t+HOUR,payload:'9999 -RA',event:'precip'}],checks:{max5:true},diagnostics:{layers:[],reasons:[]}};
  P.postprocessResult(r,{rows:[h.sourceRow]});
  assert.equal(r.groups.length,0);
  assert.ok(!r.taf.includes('-RA'));
}

// BECMG with only a spurious 9999->8000 visibility change is removed completely.
{
  const t=Date.UTC(2026,8,13,6),a={t,visM:10000,clouds:[],sourceRow:{}},b={t:t+HOUR,visM:8000,clouds:[],sourceRow:{}};
  const r={station:'EPIR',issue:t-HOUR,start:t,end:t+12*HOUR,version:'1.0.0',base:{text:'21006KT CAVOK',state:a},hourly:[a,b],groups:[{kind:'BECMG',start:t+HOUR,end:t+2*HOUR,payload:'21006KT 8000 NSC',fields:['visibility']}],checks:{max5:true},diagnostics:{layers:[],reasons:[]}};
  P.postprocessResult(r,{rows:[a.sourceRow,b.sourceRow]});
  assert.equal(r.groups.length,0);
}

console.log('taf-hybrid-policy tests: OK', {version:P.VERSION});
