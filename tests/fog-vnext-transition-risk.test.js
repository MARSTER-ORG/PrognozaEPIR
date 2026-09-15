'use strict';
const assert=require('assert');
const T=require('../fog-vnext-transition-risk.js');

const priors={
  rates:{onset_next_1h_global:.0032,fog_exit_next_1h_global:.235},
  onset_priors:[
    {dimension:'hour',value:4,from_state:'BR',total:80,shrunk_rate:.06},
    {dimension:'month',value:10,from_state:'BR',total:120,shrunk_rate:.045},
    {dimension:'hour',value:4,from_state:'MIFG',total:35,shrunk_rate:.10},
    {dimension:'month',value:10,from_state:'MIFG',total:50,shrunk_rate:.08},
  ],
  exit_priors:[
    {dimension:'hour',value:4,from_state:'FG',total:65,shrunk_rate:.18},
    {dimension:'month',value:10,from_state:'FG',total:90,shrunk_rate:.22},
  ],
};
const when='2026-10-10T04:00:00Z';

assert.equal(T.normalizeState('FZFG'),'FG');
assert.equal(T.normalizeState('MIFG'),'MIFG');
assert.equal(T.observedState({obsUsed:true,obsVisM:null}),'UNKNOWN');
assert.equal(T.observedState({obsUsed:true,obsVisM:9000}),'CLEAR');
// Low visibility alone is deliberately not promoted to FG without precip truth.
assert.equal(T.observedState({obsUsed:true,obsVisM:400}),'UNKNOWN');

const br=T.evaluate({time:when,state:'BR'},{dataQuality:.9,dissipationRisk:.1},{P_physics:.85},priors);
const brWeak=T.evaluate({time:when,state:'BR'},{dataQuality:.9,dissipationRisk:.1},{P_physics:.15},priors);
assert(br.onsetHistoricalPrior>0.0032,br);
assert(br.onsetRiskShadow>brWeak.onsetRiskShadow,{strong:br.onsetRiskShadow,weak:brWeak.onsetRiskShadow});
assert.equal(br.dissipationRiskShadow,null);
assert.equal(br.calibrated,false);

const mifg=T.evaluate({time:when,state:'MIFG'},{dataQuality:.9},{P_physics:.85},priors);
assert(mifg.onsetHistoricalPrior>br.onsetHistoricalPrior,{mifg:mifg.onsetHistoricalPrior,br:br.onsetHistoricalPrior});

const fg=T.evaluate({time:when,state:'FG'},{dataQuality:.9,dissipationRisk:.8},{P_physics:.9},priors);
const fgStable=T.evaluate({time:when,state:'FG'},{dataQuality:.9,dissipationRisk:.1},{P_physics:.9},priors);
assert.equal(fg.onsetRiskShadow,null);
assert(fg.dissipationRiskShadow>fgStable.dissipationRiskShadow,{exit:fg.dissipationRiskShadow,stable:fgStable.dissipationRiskShadow});
assert.equal(fg.dissipationWindow,'0-1h');

const unknown=T.evaluate({time:when,state:'UNKNOWN'},{dataQuality:.9},{P_physics:.9},priors);
assert.equal(unknown.onsetHistoricalPrior,.0032);
assert(unknown.onsetConfidence<br.onsetConfidence,{unknown:unknown.onsetConfidence,br:br.onsetConfidence});
assert(unknown.notes.length>0);

console.log('fog vNext transition risk tests: OK');
