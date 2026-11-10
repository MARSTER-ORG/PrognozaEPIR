'use strict';
const assert=require('node:assert/strict');
const wrap=require('../taf-semantic-gate-v1.js');
const issue=Date.UTC(2026,10,11,5),start=issue+3600000,end=start+12*3600000;
const meta={issue,start,end};
let sample=null;
const original={
  ENGINE_VERSION:'2.4.0',QUALITY_VERSION:'2.4.3',helpers:{},
  validateTaf:(x)=>({ok:/=$/.test(x),errors:/=$/.test(x)?[]:['missing ='],warnings:[]}),
  createEngine:()=>({
    validate:()=>({ok:true,errors:[],warnings:[]}),
    generate:()=>({taf:sample,groups:[{kind:'PROB30',text:'PROB30 1108/1111 0550 FG BKN002'}],
      base:{state:{visM:550},text:'17006KT 0550 BKN001'},checks:{ok:true},
      diagnostics:{reasons:[]},hourly:[]})
  })
};
const engine=wrap(original).createEngine();
const bad='TAF EPIR 110500Z 1106/1118 17006KT 0550 BKN001 PROB30 1108/1111 0550 FG BKN002=';
assert.ok(wrap(original).validateTaf(bad,meta).errors.some(x=>x.includes('bez udokumentowanego')));
sample='TAF EPIR 110500Z 1106/1118 17006KT 0550 FG BKN001\nPROB30 1108/1111 0550 FG BKN002=';
let result=engine.generate(meta);
assert.equal(result.taf,'TAF EPIR 110500Z 1106/1118 17006KT 0550 FG BKN001=');
assert.equal(result.groups.length,0);
assert.equal(result.checks.ok,true);
assert.ok(!/\n/.test(result.taf));
sample='TAF EPIR 110500Z 1106/1118 17006KT 3000 BR BKN010 PROB30 1108/1111 0550 FG BKN002=';
result=engine.generate(meta);
assert.match(result.taf,/PROB30 1108\/1111 0550 FG BKN002/);
assert.equal(result.groups.length,1);
assert.equal(result.checks.ok,true);
sample=bad;
assert.throws(()=>engine.generate(meta),/bez udokumentowanego/);
assert.ok(!wrap(original).validateTaf('TAF EPIR 110500Z 1106/1118 17006KT 5500 FG BKN002=',meta).ok);
assert.ok(!wrap(original).validateTaf('TAF EPIR 110500Z 1106/1118 17006KT 0800 BR BKN002=',meta).ok);
console.log('TAF semantic strict gate: PASS');
