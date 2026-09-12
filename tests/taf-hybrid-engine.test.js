'use strict';
const assert=require('assert');
const H=require('../taf-hybrid-engine.js');
const HOUR=3600000, KT=1.9438444924406;
const start=Date.UTC(2026,8,12,6), end=start+12*HOUR, issue=start-HOUR;
function model(id,kt,dir,vis=12000,ceil=3000,code=0,gust=kt){return{id,w:1,ws:kt/KT,wd:dir,g:gust/KT,vis,ceil:ceil/3.280839895,code}}
function row(i,opt={}){
 const kt=opt.kt??6, dir=opt.dir??220, vis=opt.vis??12000, ceilFt=opt.ceilFt??6000, code=opt.code??0;
 return {t:start+i*HOUR,WS:kt/KT,WD:dir,G:(opt.gust??kt)/KT,VIS:vis,ceiling:ceilFt/3.280839895,
   lowH:(opt.lowFt??6000)/3.280839895,midH:9000/3.280839895,highH:18000/3.280839895,
   oktaL:opt.oktaL??0,oktaM:opt.oktaM??0,oktaH:opt.oktaH??0,RH:opt.RH??60,RR:opt.RR??0,
   fogRisk:opt.fogRisk??0,mifgRisk:opt.mifgRisk??0,storm:opt.storm??0,wet:opt.wet??0,dirSpread:opt.dirSpread??10,
   mv:[model('A',kt,dir,vis,ceilFt,code,opt.gust??kt),model('B',kt+(opt.delta??0),dir+5,vis,ceilFt,code,opt.gust??kt),model('C',kt,dir-5,vis,ceilFt,code,opt.gust??kt)]};
}
function gen(rows,opts={}){return H.createEngine({storage:{get(){return null},set(){}}}).generate({station:'EPIR',issue,start,end,rows,record:false,...opts});}

assert.equal(H.ENGINE_VERSION,'1.0.0');

let r=gen(Array.from({length:12},(_,i)=>row(i)));
assert.match(r.taf,/\bCAVOK\b/);
assert.ok(!r.taf.includes('PROB40'));
assert.ok(!/\bVV\d{3}\b/.test(r.taf));

r=gen(Array.from({length:12},(_,i)=>row(i,{lowFt:3900,oktaL:2})));
assert.ok(!r.base.text.includes('CAVOK'));
assert.match(r.base.text,/FEW039/);

const clouds=Array.from({length:12},(_,i)=>row(i,{lowFt:1200,oktaL:2,ceilFt:2500,oktaM:4,oktaH:6}));
for(const x of clouds){x.midH=2500/3.280839895;x.highH=4200/3.280839895;}
r=gen(clouds);
assert.match(r.base.text,/FEW012/);
assert.match(r.base.text,/SCT025/);
assert.match(r.base.text,/BKN042/);

r=gen(Array.from({length:12},(_,i)=>row(i,{kt:0,dirSpread:180})));
assert.match(r.base.text,/^00000KT\b/);

let vrbRows=Array.from({length:12},(_,i)=>row(i,{kt:i<9?2:8,dir:40+i*20,dirSpread:120}));
r=gen(vrbRows);
assert.match(r.base.text,/^VRB02KT\b/);
assert.equal(r.diagnostics.vrb02.count,9);

vrbRows=Array.from({length:12},(_,i)=>row(i,{kt:i<9?2:(i===9?12:8),dir:40+i*20,dirSpread:120}));
r=gen(vrbRows);
assert.equal(r.diagnostics.vrb02,null);

let rows=Array.from({length:12},(_,i)=>row(i,{vis:i<5?12000:3000,RH:i<5?70:94,fogRisk:i<5?0:75}));
r=gen(rows);
assert.ok(r.groups.some(g=>g.kind==='BECMG'&&g.fields.includes('visibility')));

rows=Array.from({length:12},(_,i)=>row(i,{storm:i===6?35:0}));
r=gen(rows);
assert.ok(r.groups.some(g=>g.kind==='PROB30'&&g.event==='ts'));
assert.ok(!r.taf.includes('PROB40'));

rows=Array.from({length:12},(_,i)=>row(i,{lowFt:5500,oktaL:2}));
r=gen(rows,{msaFt:6000});
assert.ok(!r.base.text.includes('CAVOK'));
assert.match(r.base.text,/FEW055/);

const memStore={v:null,get(){return this.v},set(k,v){this.v=v}};
const engine=H.createEngine({storage:memStore});
rows=Array.from({length:12},(_,i)=>row(i));
for(const x of rows){x.mv=[model('A',6,220),model('B',20,220),model('C',8,220)];}
engine.generate({station:'EPIR',issue,start,end,rows,record:true});
const obs=[];
for(let i=0;i<12;i++)obs.push({obs_time:new Date(start+i*HOUR).toISOString(),wind_speed_ms:6/KT,wind_direction_deg:220,visibility_m:12000,raw:`METAR EPIR 12${String(6+i).padStart(2,'0')}00Z 22006KT CAVOK=`});
const n=engine.learn(obs);assert.ok(n>=8);
const st=engine.getLearningState();
const a=Object.entries(st.cells).find(([k])=>k.startsWith('A|windKt|'))?.[1];
const b=Object.entries(st.cells).find(([k])=>k.startsWith('B|windKt|'))?.[1];
assert.ok(a&&b&&a.mae<b.mae);
assert.ok(engine.getLearningSummary().models.A);

rows=Array.from({length:12},(_,i)=>row(i,{vis:i%2?3000:12000,RH:i%2?95:60,fogRisk:i%2?80:0,kt:i%3===0?20:4}));
r=gen(rows);
assert.ok(r.groups.length<=5);

assert.throws(()=>H.createEngine({storage:{get(){return null},set(){}}}).generate({station:'EPIR',issue,start,end:start+10*HOUR,rows,record:false}),/12 h/);

console.log('taf-hybrid-engine tests: OK', {tests:12, version:H.ENGINE_VERSION});
