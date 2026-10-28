'use strict';
// Regression for operational BR: never show mist when the displayed VIS is
// outside 1000–5000 m, independently of risk score and selected fog engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function load(relative, marker, expose, extra={}) {
  const original = fs.readFileSync(path.join(root,relative),'utf8');
  assert(original.includes(marker), relative+' test injection point missing');
  const source = original.replace(marker, expose+'\n'+marker);
  const window = { addEventListener(){} };
  const sandbox = {
    window, document:{readyState:'loading',addEventListener(){}},
    localStorage:{getItem(){return 'legacy';}},
    setInterval(){return 1;},setTimeout(){return 1;},
    addEventListener(){},dispatchEvent(){},CustomEvent:function(){},
    console,Date,Math,Number,Intl,URLSearchParams,AbortController,
    ...extra
  };
  vm.runInNewContext(source,sandbox,{filename:relative,timeout:1500});
  return window;
}

const engine=load('fog-engine-v244.js',
  '  function trim(a){',
  '  window.__testBr={eligible:brVisibilityEligible,calc};');
for(const [vis,ok] of [
  [null,false],[undefined,false],['',false],[-1,false],[0,false],
  [999,false],[1000,true],[1200,true],[4999,true],[5000,true],
  [5001,false],[9000,false],[30000,false]
]) assert.equal(engine.__testBr.eligible(vis),ok,'engine eligibility at '+vis);

// Exercise the actual integrated scorer on varied atmospheric states.
// The raw diagnostic score may remain high, but the emitted BR score must be
// zero whenever its own predicted visibility is outside the BR interval.
let outside=0,inside=0;
for(const rh of [45,70,88,99]){
  for(const ws of [0.5,1.3,3,7]){
    for(const pbl of [60,250,1000]){
      const T=10,Td=T-(100-rh)/8;
      const z=engine.__testBr.calc({
        T,Td,RH:rh,WS:ws,LOW:90,pbl,Ts:T-0.4,
        inv:0.6,lead:4,RR:0,VIS:12000,CBH:400,s1:0.25,s3:0.24
      });
      const valid=z.vis.point>=1000&&z.vis.point<=5000;
      if(valid){inside++;assert.equal(z.br.score,z.br.rawScore);}
      else{outside++;assert.equal(z.br.score,0);}
      assert.equal(z.br.visibilityEligible,valid);
    }
  }
}
assert(outside>0,'test must cover out-of-range visibility');
assert(inside>0,'test must cover valid BR visibility');

const bridge=load('fog-index-bridge.js',
  '  function sync(){',
  '  window.__testComputeBR=computeSelectedBR;');
const now=Date.now(),source={
  PrognozaEPIRBREngine:{scoreRow:r=>({t:r.t,score:86,visibility:2200})}
};
const row=vis=>({t:now,vis,score:87});
for(const mode of ['legacy','vnext']){
  for(const [vis,expected] of [[999,0],[1000,1],[5000,1],[5001,0],[10000,0],[null,0]]){
    const result=bridge.__testComputeBR(source,mode,[row(vis)],[row(vis)]);
    assert.equal(result.length,expected,mode+' mode at '+vis);
    if(expected)assert.equal(result[0].visibility,vis);
  }
}

const overlay=load('fog-meteogram-overlay.js',
  '  function installVisibilityProvider(){',
  '  window.__testBrVisibility={eligible:brVisibilityEligible,valid:brValidAt};');
const base={t:now,score:90,visibility:2500};
for(const [vis,expected] of [[999,false],[1000,true],[3500,true],[5000,true],[5001,false],[25000,false],[null,false]]){
  assert.equal(overlay.__testBrVisibility.valid(base,[{t:now,VIS:vis}]),expected,'meteogram VIS '+vis);
}
assert.equal(overlay.__testBrVisibility.valid({...base,visibility:9000},[{t:now,VIS:2500}]),false);
assert.equal(overlay.__testBrVisibility.valid(base,[{t:now+3*3600e3,VIS:2500}]),false,'stale hour must not qualify');
console.log('br-visibility-gate: all boundary, engine, Legacy/Next and display tests passed');
