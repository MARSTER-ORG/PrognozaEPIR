'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const wrap=require('../taf-fog-visibility-coherence-v1.js');
const meta={issue:Date.UTC(2026,10,11,5),start:Date.UTC(2026,10,11,6),end:Date.UTC(2026,10,11,18)};
function makeHour(i,{vis=300,T=1,Td=.5,RH=97,fogScore=25,lowVisShare=.8}={}){
  return {
    t:meta.start+i*3600000,visM:vis,T,Td,RH,
    tafDisplay:{wind:'17006KT',visibility:'0300',weather:'',clouds:'BKN001'},
    prob:{fg:0.1,br:0.1,precip:0},
    sourceRow:{VIS:vis,fgOperationalScore:fogScore,
      mv:[{vis:lowVisShare>=.5?300:5000,w:lowVisShare},
          {vis:6000,w:1-lowVisShare}]}
  };
}
function sample(hours){
  return {taf:'TAF EPIR 110500Z 1106/1118 17006KT 0300 BKN001\nPROB30 1108/1111 0300 FG BKN002=',
    base:{text:'17006KT 0300 BKN001',state:{visM:300}},
    groups:[{text:'PROB30 1108/1111 0300 FG BKN002',fields:['visibility','weather','clouds']}],
    hourly:hours,checks:{ok:true},diagnostics:{reasons:[]}};
}
const fake={ENGINE_VERSION:'2.4.0',QUALITY_VERSION:'2.4.3',helpers:{},
  createEngine:()=>({
    validate:()=>({ok:true,errors:[],warnings:[]}),
    generate:()=>sample(globalThis.hours)
  })
};
const engine=wrap(fake).createEngine();
globalThis.hours=[makeHour(0),makeHour(1),makeHour(2)];
let result=engine.generate({...meta,observation:{raw:'EPIR 102300Z AUTO 24011KT 2300 VV002 01/01 Q1011'}});
assert.match(result.taf,/17006KT 0300 FG BKN001/,'AUTO missing WX must not veto independent forecast FG support');
assert.equal(result.base.state.inferredFogFromVisibility,true);
assert.equal(result.diagnostics.lowVisibilityWeatherEvidence,'CONFIRMED_FROM_FORECAST');
assert.equal(result.hourly[0].tafDisplay.weather,'FG');
assert.ok(!result.taf.includes('\n'));
globalThis.hours=[makeHour(0,{vis:300,T:18,Td:6,RH:45,lowVisShare:.1}),
  makeHour(1,{vis:300,T:18,Td:6,RH:45,lowVisShare:.1}),
  makeHour(2,{vis:300,T:18,Td:6,RH:45,lowVisShare:.1})];
result=engine.generate(meta);
assert.doesNotMatch(result.taf.split(/\s+PROB30/)[0],/\b0300 FG\b/,'VIS alone must not invent prevailing fog');
assert.equal(result.diagnostics.lowVisibilityWeatherEvidence,'NOT_CONFIRMED');
// Freezing fog is not inferred merely from subzero T: -1C does not prove FZFG.
globalThis.hours=[makeHour(0,{T:-1,Td:-1}),makeHour(1,{T:-1,Td:-1}),makeHour(2,{T:-1,Td:-1})];
result=engine.generate(meta);
assert.match(result.taf,/\b0300 FG\b/);
assert.doesNotMatch(result.taf,/\bFZFG\b/);
// One supported hour is insufficient to claim prevailing fog for 12h.
globalThis.hours=[makeHour(0),makeHour(1,{T:15,Td:5,RH:40}),makeHour(2,{T:15,Td:5,RH:40})];
result=engine.generate(meta);
assert.equal(result.diagnostics.lowVisibilityWeatherEvidence,'NOT_CONFIRMED');
const html=fs.readFileSync(path.join(__dirname,'../taf.html'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../taf-app-v25.js'),'utf8');
assert.match(html,/taf-fog-visibility-coherence-v1\.js/);
assert.match(html,/id="aiMiniStatus"/);
assert.doesNotMatch(html,/id="geminiResult"/);
assert.doesNotMatch(html,/id="gemini"\s/,'No separate Gemini button: Gemini runs per generation');
assert.match(ui,/await analyzeWithGemini\(\)/);
assert.match(ui,/renderArchive\(data\)/);
assert.match(ui,/if\(generating\)return null/);
console.log('TAF AUTO meteorology, VIS/FG coherence and automatic Gemini: PASS');
