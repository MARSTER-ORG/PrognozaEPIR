'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRFogVNextProbabilityLayer=api;
  if(root&&root.document){
    const installUiAuthority=()=>{
      const d=root.document;
      if(!d.getElementById('fogVNextUiAuthority')){
        const style=d.createElement('style');
        style.id='fogVNextUiAuthority';
        style.textContent='#fogSummaryStructured,#fogAuxStructured{display:none!important}#fogSummary{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}@media(max-width:700px){#fogSummary{grid-template-columns:repeat(2,minmax(0,1fr))}}';
        d.head?.appendChild(style);
      }
      const summary=d.getElementById('fogSummary');
      if(summary){summary.removeAttribute('aria-hidden');summary.style.removeProperty('display');}
    };
    const redraw=()=>{
      installUiAuthority();
      root.queueMicrotask?.(()=>{try{if(typeof root.draw==='function')root.draw();}catch(_){}});
    };
    root.addEventListener?.('prognozaepir:fog-vnext-updated',redraw);
    setTimeout(installUiAuthority,0);
    setTimeout(redraw,500);
  }
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='1.2.0-state-gated';
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const smoothstep=(x,a,b)=>{
    if(!finite(x))return null;
    if(a===b)return x>=b?1:0;
    const t=clamp((x-a)/(b-a));
    return t*t*(3-2*t);
  };
  function weightedAvailable(items){
    let s=0,w=0,full=0;
    for(const p of items||[]){
      const ww=Math.max(0,num(p?.w)||0);full+=ww;
      if(finite(p?.v)&&ww>0){s+=p.v*ww;w+=ww;}
    }
    return {value:w?s/w:null,coverage:full?clamp(w/full):0};
  }

  function mechanismPotential(v={}){
    const ranked=[v.RAD,v.ADV,v.CBL,v.PCP]
      .map(num).filter(finite).map(x=>clamp(x)).sort((a,b)=>b-a);
    if(!ranked.length)return {value:null,coverage:0,primary:null,secondary:null};
    const names=[['RAD',num(v.RAD)],['ADV',num(v.ADV)],['CBL',num(v.CBL)],['PCP',num(v.PCP)]]
      .filter(x=>finite(x[1])).sort((a,b)=>b[1]-a[1]);
    const value=ranked.length===1?ranked[0]:.80*ranked[0]+.20*ranked[1];
    return {value:clamp(value),coverage:ranked.length/4,primary:names[0]?.[0]||null,secondary:names[1]?.[0]||null};
  }

  function stateReadiness(v={}){
    const sat=num(v.SATURATION),pbl=num(v.SPBL),sfc=num(v.SSFC_COOL),diss=num(v.dissipationRisk);
    const inverseDiss=finite(diss)?1-clamp(diss):null;
    const out=weightedAvailable([
      {v:finite(sat)?clamp(sat):null,w:.60},
      {v:finite(pbl)?clamp(pbl):null,w:.18},
      {v:finite(sfc)?clamp(sfc):null,w:.12},
      {v:inverseDiss,w:.10},
    ]);
    return {value:out.value,coverage:out.coverage,saturation:sat,pbl,surfaceCooling:sfc,dissipation:diss,inverseDiss};
  }

  // Mechanism strength says that a fog-forming process exists. Operational FG
  // additionally requires a near-surface thermodynamic state capable of sustaining it.
  // This shortens false daytime tails without asking NWP visibility to veto the engine.
  function physicsSignal(v={}){
    const potential=mechanismPotential(v);
    if(!finite(potential.value))return {...potential,potential:null,readiness:null,readinessCoverage:0,dissipationPenalty:0};
    const ready=stateReadiness(v);
    let value=potential.value;
    let dissipationPenalty=0;
    if(finite(ready.value)){
      const readinessFactor=.30+.70*clamp(ready.value);
      value*=readinessFactor;
      if(finite(ready.dissipation)){
        dissipationPenalty=.55*clamp(ready.dissipation);
        value*=1-dissipationPenalty;
      }
      // Strongly unsaturated/dispersing boundary layers cannot remain operational FG
      // solely because a mechanism score (e.g. ADV/CBL) is still elevated.
      if(finite(ready.saturation)&&ready.saturation<.20)value=Math.min(value,.36);
      else if(finite(ready.saturation)&&ready.saturation<.32&&finite(ready.dissipation)&&ready.dissipation>.35)value=Math.min(value,.46);
    }
    return {
      value:clamp(value),coverage:potential.coverage,
      primary:potential.primary,secondary:potential.secondary,
      potential:potential.value,readiness:ready.value,readinessCoverage:ready.coverage,
      dissipationPenalty,diagnostics:{state:ready}
    };
  }

  // NWP direct guidance is corroborative only. High model VIS must never veto
  // a strong fog signal produced by the state-gated internal physics layer.
  function directGuidanceSignal(input={}){
    const vis=num(input.visibility);
    const cloud2m=num(input.cloud2m);
    const cbh=num(input.cbh);
    const weatherFog=input.weatherFog===true?1:(input.weatherFog===false?0:null);
    const visSignal=finite(vis)?1-smoothstep(vis,700,8000):null;
    const cloud2mSignal=finite(cloud2m)?smoothstep(cloud2m,25,95):null;
    const cbhSignal=finite(cbh)?1-smoothstep(cbh,60,900):null;
    const out=weightedAvailable([
      {v:visSignal,w:.62},
      {v:cloud2mSignal,w:.18},
      {v:cbhSignal,w:.12},
      {v:weatherFog,w:.08},
    ]);
    return {value:out.value,coverage:out.coverage,visibility:visSignal,cloud2m:cloud2mSignal,cloudBase:cbhSignal,weatherFog};
  }

  function leadWeights(leadHours){
    const h=num(leadHours);
    if(!finite(h))return {physics:1,direct:.20,directConfirm:.20,bucket:'unknown'};
    if(h<=3)return {physics:1,direct:.28,directConfirm:.28,bucket:'0-3h'};
    if(h<=12)return {physics:1,direct:.20,directConfirm:.20,bucket:'3-12h'};
    if(h<=24)return {physics:1,direct:.16,directConfirm:.16,bucket:'12-24h'};
    return {physics:1,direct:.12,directConfirm:.12,bucket:'24h+'};
  }

  function combineShadow(physics,direct,leadHours){
    const p=num(physics),d=num(direct),w=leadWeights(leadHours);
    if(finite(p)){
      const positiveGap=finite(d)?Math.max(0,d-p):0;
      return {value:clamp(p+positiveGap*w.directConfirm),coverage:finite(d)?1:.75,weights:w,directRole:'confirm-only',usedDirectFallback:false,directContribution:positiveGap*w.directConfirm};
    }
    return {value:finite(d)?clamp(d):null,coverage:finite(d)?.45:0,weights:w,directRole:'fallback-no-physics',usedDirectFallback:finite(d),directContribution:finite(d)?d:null};
  }

  function evaluate(input={},physicsOutput={}){
    const p=physicsSignal(physicsOutput);
    const d=directGuidanceSignal(input);
    const combined=combineShadow(p.value,d.value,input.leadHours);
    return {
      version:VERSION,calibrated:false,calibrationStatus:'physics-state-gated-production-2026-09-16',
      P_potential:p.potential,P_physics:p.value,P_direct:d.value,
      P_model_final:combined.value,P_model_final_shadow:combined.value,
      stateReadiness:p.readiness,stateReadinessCoverage:p.readinessCoverage,dissipationPenalty:p.dissipationPenalty,
      physicsCoverage:p.coverage,directCoverage:d.coverage,mechanism1:p.primary,mechanism2:p.secondary,
      leadBucket:combined.weights.bucket,blendWeights:{physics:1,direct:combined.weights.directConfirm,directConfirm:combined.weights.directConfirm},
      directRole:combined.directRole,usedDirectFallback:combined.usedDirectFallback,directContribution:combined.directContribution,
      diagnostics:{direct:d,state:p.diagnostics?.state||null},
    };
  }

  function operationalScore(legacyScore,evaluated={}){
    const legacy=num(legacyScore);
    const p=num(evaluated.P_model_final??evaluated.P_model_final_shadow);
    if(finite(p))return {score:clamp(p)*100,source:'vnext-production',fallback:false};
    return {score:finite(legacy)?clamp(legacy,0,100):null,source:'legacy-fallback',fallback:true};
  }

  return Object.freeze({VERSION,weightedAvailable,mechanismPotential,stateReadiness,physicsSignal,directGuidanceSignal,leadWeights,combineShadow,evaluate,operationalScore});
});
