'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRFogVNextTransitionRisk=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='0.1.0-shadow';
  const finite=Number.isFinite;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;

  function normalizeState(value){
    const s=String(value||'').trim().toUpperCase();
    if(['FG','FZFG','BCFG','PRFG'].includes(s))return 'FG';
    if(s==='MIFG')return 'MIFG';
    if(s==='BR')return 'BR';
    if(['CLEAR','CAVOK','NSC'].includes(s))return 'CLEAR';
    return 'UNKNOWN';
  }

  function observedState(input={}){
    const explicit=normalizeState(input.obsPhenomenon??input.state);
    if(explicit!=='UNKNOWN')return explicit;
    if(input.obsUsed===true){
      const vis=num(input.obsVisM);
      // Never infer fog from low visibility here because precipitation truth is
      // not guaranteed to be present on the runtime hour. High visibility can
      // safely support CLEAR; missing visibility stays UNKNOWN.
      if(finite(vis)&&vis>5000)return 'CLEAR';
    }
    return 'UNKNOWN';
  }

  function lookupCell(rows,dimension,value,state){
    return (rows||[]).find(r=>r?.dimension===dimension&&Number(r?.value)===Number(value)&&String(r?.from_state||'').toUpperCase()===state)||null;
  }

  function weighted(values){
    let s=0,w=0;
    for(const x of values||[]){
      if(finite(x?.v)&&finite(x?.w)&&x.w>0){s+=x.v*x.w;w+=x.w;}
    }
    return w?s/w:null;
  }

  function priorFor(priors,kind,state,when){
    if(!priors||typeof priors!=='object')return {value:null,source:'missing',samples:0,state};
    const date=when instanceof Date?when:new Date(when);
    if(!finite(date.getTime()))return {value:null,source:'invalid-time',samples:0,state};
    const globalKey=kind==='exit'?'fog_exit_next_1h_global':'onset_next_1h_global';
    const global=num(priors?.rates?.[globalKey]);
    if(kind==='exit'&&state!=='FG')return {value:null,source:'not-fg',samples:0,state};
    if(kind==='onset'&&state==='FG')return {value:null,source:'already-fg',samples:0,state};

    const rows=kind==='exit'?priors.exit_priors:priors.onset_priors;
    const lookupState=kind==='exit'?'FG':state;
    const hour=lookupState!=='UNKNOWN'?lookupCell(rows,'hour',date.getUTCHours(),lookupState):null;
    const month=lookupState!=='UNKNOWN'?lookupCell(rows,'month',date.getUTCMonth()+1,lookupState):null;
    const parts=[];
    if(finite(global))parts.push({v:global,w:1});
    if(hour&&finite(num(hour.shrunk_rate))){
      const n=Math.max(0,num(hour.total)||0);parts.push({v:num(hour.shrunk_rate),w:Math.min(3,.25+n/20)});
    }
    if(month&&finite(num(month.shrunk_rate))){
      const n=Math.max(0,num(month.total)||0);parts.push({v:num(month.shrunk_rate),w:Math.min(3,.25+n/40)});
    }
    return {
      value:weighted(parts),
      source:hour||month?'historical-hour-month':'historical-global',
      samples:(num(hour?.total)||0)+(num(month?.total)||0),
      hourSamples:num(hour?.total)||0,
      monthSamples:num(month?.total)||0,
      state,
      global,
    };
  }

  function logit(p){const x=clamp(p,1e-5,1-1e-5);return Math.log(x/(1-x));}
  function logistic(x){return 1/(1+Math.exp(-x));}
  function evidenceAdjusted(prior,evidence,strength=1.25){
    const p=num(prior),e=num(evidence);
    if(!finite(p))return null;
    if(!finite(e))return p;
    // Evidence is deliberately an uncalibrated shadow support signal. Adjust
    // prior odds rather than replacing the historical base rate with a score.
    return clamp(logistic(logit(p)+strength*(2*clamp(e)-1)));
  }

  function confidence(priorInfo,dataQuality,state){
    const n=Math.max(0,num(priorInfo?.samples)||0);
    const sampleSupport=1-Math.exp(-n/80);
    const dq=finite(num(dataQuality))?clamp(num(dataQuality)):0.35;
    const stateSupport=state==='UNKNOWN'?.35:1;
    return clamp(.15+.40*sampleSupport+.30*dq+.15*stateSupport);
  }

  function evaluate(input={},physics={},probability={},priors=null){
    const when=input.time??input.t??Date.now();
    const state=observedState(input);
    const pPhysics=num(probability.P_physics);
    const dissipation=num(physics.dissipationRisk);
    const onsetPrior=priorFor(priors,'onset',state,when);
    const exitPrior=priorFor(priors,'exit',state,when);
    const onset=state==='FG'?null:evidenceAdjusted(onsetPrior.value,pPhysics,1.35);
    const exit=state==='FG'?evidenceAdjusted(exitPrior.value,dissipation,1.35):null;
    return {
      version:VERSION,
      calibrated:false,
      mode:'shadow',
      state,
      onsetRiskShadow:onset,
      onsetHistoricalPrior:onsetPrior.value,
      onsetPhysicsSupport:pPhysics,
      onsetConfidence:state==='FG'?null:confidence(onsetPrior,physics.dataQuality,state),
      onsetWindow:onset===null?null:'0-1h',
      dissipationRiskShadow:exit,
      dissipationHistoricalPrior:exitPrior.value,
      dissipationPhysicsSupport:dissipation,
      dissipationConfidence:state==='FG'?confidence(exitPrior,physics.dataQuality,state):null,
      dissipationWindow:exit===null?null:'0-1h',
      priorSource:state==='FG'?exitPrior.source:onsetPrior.source,
      priorSamples:state==='FG'?exitPrior.samples:onsetPrior.samples,
      notes:state==='UNKNOWN'?['observed state unknown; global onset prior only, confidence reduced']:[],
    };
  }

  return Object.freeze({VERSION,normalizeState,observedState,priorFor,evidenceAdjusted,evaluate});
});
