'use strict';
const assert=require('node:assert/strict');
const core=require('../taf-engine-v2.js');
const strict=require('../taf-semantic-gate-v1.js')(core);
const audit=require('../taf-operational-audit-v1.js');
const fs=require('node:fs'),path=require('node:path');
const H=3600000,KT=1.9438444924406;
const start=Date.UTC(2026,10,12,12),issue=start-H,end=start+12*H;
function row(i){
  const vis=[100,200,200,250,200,200,400,11000,11000,11000,11000,11000][i];
  const cloud=[240,260,220,220,90,230,90,90,90,240,160,280][i];
  const fog=i<4||i===6,rain=i===4||i===5;
  return {t:start+i*H,T:4,Td:3,RH:96,VIS:vis,WS:6/KT,WD:210,G:6/KT,RR:rain?.2:0,wet:rain?1:0,
    storm:0,profile:[{agl:cloud,cc:75},{agl:cloud+300,cc:80}],ceiling:cloud,oktaL:6,lowH:cloud,
    mv:[1,2,3].map(k=>({id:'m'+k,vis,code:rain?61:0,ws:6/KT,wd:210,g:6/KT,ceil:cloud,w:1})),
    fogOperationalScore:fog?80:0,fgOperationalScore:fog?80:0,brOperationalScore:0,
    fogEngineVisM:vis,fogAltVisM:fog?vis:null};
}
const q=strict.createEngine().generate({station:'EPIR',issue,start,end,rows:Array.from({length:12},(_,i)=>row(i)),rowsAlreadyAnchored:true});
assert.match(q.taf,/BECMG\s+1218\/1220\s+9999\s+NSW/);
assert.equal(q.checks.ok,true,q.taf);
assert.deepEqual(strict.helpers.strictSemanticErrors(q.taf),[]);
const m={issue,start,end};
const bad='TAF EPIR 121100Z 1212/1224 21006KT 0150 FG BKN007 BECMG 1218/1220 9999 BKN002=';
const flags=audit.evaluate({taf:bad,hourly:q.hourly,meta:m,asOf:issue});
assert.ok(flags.errors.some(x=>x.includes('Brak NSW')),JSON.stringify(flags));
const good=audit.evaluate({taf:bad.replace('9999 BKN002','9999 NSW BKN002'),hourly:q.hourly,meta:m,asOf:issue});
assert.ok(!good.errors.some(x=>x.includes('Brak NSW')),JSON.stringify(good));
const noChange=audit.evaluate({taf:'TAF EPIR 121100Z 1212/1224 21006KT 0150 FG BKN007=',hourly:q.hourly,meta:m,asOf:issue});
assert.ok(noChange.warnings.some(x=>x.includes('pomija utrzymującą się poprawę')),JSON.stringify(noChange));
const conflictHours=q.hourly.map((h,i)=>i<7?h:{...h,sourceRow:{...h.sourceRow,fogEngineVisM:1700,brOperationalScore:86}});
const mismatch=audit.evaluate({taf:q.taf,hourly:conflictHours,meta:m,asOf:issue});
assert.ok(mismatch.warnings.some(x=>x.includes('Konflikt Fog Engine')),JSON.stringify(mismatch));
const lowRainHours=q.hourly.map((h,i)=>i===4?{...h,visM:200,tafDisplay:{...h.tafDisplay,weather:'-RA'}}:h);
const rainAudit=audit.evaluate({taf:bad.replace('9999 BKN002','9999 NSW BKN002'),hourly:lowRainHours,meta:m,asOf:issue});
assert.ok(rainAudit.warnings.some(x=>x.includes('-RA/-DZ')),JSON.stringify(rainAudit));
const app=fs.readFileSync(path.join(__dirname,'../taf-app-v25.js'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../supabase/functions/taf-gemini/index.ts'),'utf8');
const instr=fs.readFileSync(path.join(__dirname,'../supabase/functions/taf-gemini/instruction.ts'),'utf8');
for(const field of ['fogEngineVisibilityM','fogEngineBrScore','fogEngineFgScore']){
  assert.ok(app.includes(field),'TAF UI missing Gemini '+field);
  assert.ok(server.includes(field),'Gemini server missing '+field);
}
assert.ok(instr.includes('Każdą z 12 godzin'));
console.log('TAF 19 UTC fog recovery, NSW, Fog Engine mismatch, Gemini 12h: PASS');
