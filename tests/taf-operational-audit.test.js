'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const fusion=require('../taf-observation-fusion-v1.js');
const audit=require('../taf-operational-audit-v1.js');
const H=3600000;
const t=Date.UTC(2026,10,11,21,30),now=Date.UTC(2026,10,11,21,56);
const issue=Date.UTC(2026,10,11,23),start=Date.UTC(2026,10,12,0);
const obs=(h,minute,vis,wx='BR')=>({
  station:'EPIR',obs_time:new Date(Date.UTC(2026,10,11,h,minute)).toISOString(),
  raw:'EPIR 11'+String(h).padStart(2,'0')+String(minute).padStart(2,'0')+
    'Z AUTO 06006KT '+String(vis).padStart(4,'0')+' '+wx+' NSC M00/M01 Q1004'
});
const o=obs(21,30,4200);
const rawRows=Array.from({length:12},(_,i)=>({
  t:start+i*H,VIS:9630,WS:3,WD:130,T:0,Td:-1,
  mv:[],fogOperationalScore:40,brOperationalScore:0
}));
function run(observation=o,observations=[observation],at=now){
  return fusion.adjust(rawRows,{rawRows,observation,observations,
    issue,start,now:at,neighbors:{}});
}
const rows=run();
assert.ok(rows[0].VIS>=4200&&rows[0].VIS<5000,
  '4200 m BR recent METAR must not jump to 8000 m in first hour');
assert.ok(rows[1].VIS<5000,'first two forecast hours should track observed BR');
assert.ok(rows[2].VIS>rows[1].VIS&&rows[2].VIS<7500,
  'clearing must be smoothed, not an abrupt >3000 m hourly jump');
assert.ok(rows[0].brOperationalScore>=80,
  'recent reported BR must reach the operational score used by TAF');
assert.equal(rows[0].tafVisNowcast.observationVisM,4200);
assert.equal(rows[0].tafVisNowcast.modelVisM,9630);
assert.equal(rows[0].tafVisNowcast.unsupportedClearing,true);
assert.equal(rows[11].VIS,9630,'no freezing of METAR over the 12h forecast');
const hours=rows.map(r=>({t:r.t,visM:r.VIS,prob:{fg:.1},
  tafDisplay:{visibility:String(Math.round(r.VIS))}}));
const taf='TAF EPIR 112300Z 1200/1212 13006KT 8000 BKN004 PROB30 1200/1203 1800 BR BECMG 1207/1209 0700 FG BKN003 OVC009 BECMG 1209/1211 BKN005 OVC009=';
const result=audit.evaluate({taf,hourly:hours,observation:fusion.parseMetar(o),
  history:[fusion.parseMetar(o)],asOf:now,meta:{issue,start,end:start+12*H}});
assert.equal(result.level,'BLOCK','original user screenshot TAF must not be labelled ZGODNY');
assert.ok(result.errors.some(x=>x.includes('widzialność >=5000 m')));
assert.ok(result.warnings.some(x=>x.includes('nadal utrzymuje FG')),
  'cloud-only BECMG must not silently cancel inherited 0700 FG');
const corrected=audit.evaluate({taf:taf.replace('8000 BKN004','4000 BR BKN004'),
  hourly:hours,observation:fusion.parseMetar(o),history:[fusion.parseMetar(o)],
  asOf:now,meta:{issue,start,end:start+12*H}});
assert.notEqual(corrected.level,'BLOCK');
const clearing=run(obs(21,30,9000,''),[obs(20,30,3500),obs(21,30,9000)]);
assert.ok(clearing[0].VIS>5000,
  'observed rapid improvement must remain possible');
const stale=run(obs(16,0,4200),[obs(16,0,4200)]);
assert.equal(stale[0].VIS,9630,'stale observation must not cap visibility');
const app=fs.readFileSync(path.join(__dirname,'../taf-app-v25.js'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../supabase/functions/taf-gemini/index.ts'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../taf.html'),'utf8');
assert.ok(app.includes('deterministicAudit:activeResult.audit'));
assert.ok(app.includes('nwpMembers:'));
assert.ok(server.includes('thinkingLevel:\'high\''));
assert.ok(server.includes('meteorologicalFlags'));
assert.ok(server.includes('systemInstruction:'));
assert.ok(!server.includes('JSON.stringify({baselineTaf:taf,hours:hourData'));
assert.ok(html.includes('taf-operational-audit-v1.js'));
console.log('TAF EPIR 4200 BR vs NWP 9630, continuity, inherited FG and Gemini structured audit: PASS');
