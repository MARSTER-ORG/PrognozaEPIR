'use strict';
const assert=require('assert');
const C=require('../taf-convection-integration.js');
const H=3600000;

// Neighbor TAF is positive-only corroboration and understands TCU/CB in change groups.
const taf='TAF EPBY 201700Z 2018/2106 24008KT 9999 FEW020TCU BECMG 2020/2022 SCT030CB TEMPO 2022/2101 TSRA SCT025CB=';
const seg=C.neighborSegments(taf);
assert(seg.some(s=>s.type==='TCU'),'base TCU should be parsed');
assert(seg.some(s=>s.type==='CB'),'CB change groups should be parsed');
assert.strictEqual(C.boost(0,.6),0,'neighbor TAF must never create a local signal');
assert(C.boost(.35,.6)>.35,'neighbor TAF should increase an existing local signal');

// Dedicated nowcast horizons remain separate from NWP thunder probability.
const now=Date.now();
const snap={updatedAt:new Date(now).toISOString(),tcuProbability:42,cbProbability:18,horizons:[{h:60,tcu:48,cb:25},{h:120,tcu:55,cb:38},{h:180,tcu:62,cb:51}]};
const sm=C.sampleNowcast(snap,now+H);
assert(sm&&Math.abs(sm.tcu-.48)<1e-9,'+60 min TCU horizon should be selected');

// 30-49% TCU can create a PROB30 TEMPO convective-cloud group, but cannot invent TS.
const input={issue:now,start:now+H,end:now+13*H};
const fake={taf:'TAF EPIR 202000Z 2021/2109 24008KT 9999 NSC=',groups:[],checks:{},hourly:[],diagnostics:{reasons:[]}};
const rows=[{t:now+2*H,tcuRisk:.38,cbRisk:.10,storm:0,wet:.4,RR:.2,profile:[{agl:700,cc:30}]}];
const out=C.convectiveSupplement(fake,rows,input,()=>({ok:true,warnings:[]}));
assert(/PROB30 TEMPO/.test(out.taf),'probabilistic TCU should use PROB30 TEMPO');
assert(/TCU/.test(out.taf),'TCU should remain TCU');
assert(/SHRA/.test(out.taf),'precipitation support may add SHRA');
assert(!/\bTS(?:RA)?\b/.test(out.taf),'TCU/CB module alone must not create TS');

console.log('taf-convection-integration: OK');
