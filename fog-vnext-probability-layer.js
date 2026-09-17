'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRFogVNextProbabilityLayer=api;

  if(root&&root.document){
    const d=root.document;
    const MODE_KEY='prognozaepir-fog-engine-mode';
    const VNEXT_THRESHOLD=60;
    const LEGACY_THRESHOLD=50;
    const path=String(root.location?.pathname||'').toLowerCase();
    const mainMeteogram=/\/(?:index\.html)?$/.test(path);
    let guardedDraw=null;
    let guardedBase=null;

    const selectedMode=()=>{
      try{return root.localStorage?.getItem(MODE_KEY)==='vnext'?'vnext':'legacy';}
      catch(_){return 'legacy';}
    };

    const copyRows=rows=>(rows||[]).map(row=>({
      ...row,
      models:Array.isArray(row?.models)?row.models.slice():row?.models
    }));

    const legacyRowsFrom=rows=>(rows||[]).map(row=>{
      const legacy=Number(row?.fogScoreLegacy);
      const raw=Number(row?.score);
      return {
        ...row,
        score:Number.isFinite(legacy)?legacy:(Number.isFinite(raw)?raw:row?.score),
        fogEngineMode:'legacy',
        fogEngineSource:'legacy',
        fogEngineFallback:false,
        models:Array.isArray(row?.models)?row.models.slice():row?.models
      };
    });

    const installFogNavLink=()=>{
      const nav=d.querySelector('#epirGlobalNav .epir-global-nav-inner');
      if(!nav||d.getElementById('epirFogEngineNav'))return;
      const a=d.createElement('a');
      a.id='epirFogEngineNav';
      a.href='fog.html';
      a.textContent='EPIR FOG';
      const meteo=nav.querySelector('a[href="index.html"]');
      if(meteo)meteo.insertAdjacentElement('afterend',a);else nav.appendChild(a);
    };

    const currentThreshold=()=>selectedMode()==='vnext'?VNEXT_THRESHOLD:LEGACY_THRESHOLD;

    const patchMeteogramLegend=()=>{
      const legend=d.getElementById('fogMeteogramLegend');
      if(!legend)return;
      const thr=currentThreshold();
      legend.innerHTML=legend.innerHTML.replace(/od (?:50|60)\/100/g,`od ${thr}/100`);
    };

    const patchCanvasFogLabel=()=>{
      const proto=root.CanvasRenderingContext2D?.prototype;
      if(!proto||proto.__epirFogModeLabelPatched||typeof proto.fillText!=='function')return;
      const native=proto.fillText;
      proto.fillText=function(text,...args){
        if(text==='FOG 50'||text==='FOG 60')text=`FOG ${currentThreshold()}`;
        return native.call(this,text,...args);
      };
      try{Object.defineProperty(proto,'__epirFogModeLabelPatched',{value:true});}catch(_){proto.__epirFogModeLabelPatched=true;}
    };

    const installUiAuthority=()=>{
      if(!d.getElementById('fogVNextUiAuthority')){
        const style=d.createElement('style');
        style.id='fogVNextUiAuthority';
        style.textContent=(mainMeteogram?'#fogEngine,#fogVNextDiagnostics,#fogSummaryStructured,#fogAuxStructured{display:none!important}':'')+
          (!mainMeteogram?'#fogSummaryStructured,#fogAuxStructured{display:none!important}#fogSummary{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}@media(max-width:700px){#fogSummary{grid-template-columns:repeat(2,minmax(0,1fr))}}':'');
        d.head?.appendChild(style);
      }
      if(!mainMeteogram){
        const summary=d.getElementById('fogSummary');
        if(summary){summary.removeAttribute('aria-hidden');summary.style.removeProperty('display');}
      }
      installFogNavLink();
      patchMeteogramLegend();
      patchCanvasFogLabel();
    };

    const cloneRenderSeries=(rows,threshold)=>Object.freeze((rows||[]).map(row=>{
      const operationalScore=Number(row?.score);
      const displayScore=Number.isFinite(operationalScore)&&operationalScore<threshold
        ? Math.min(49,operationalScore)
        : operationalScore;
      return Object.freeze({
        ...row,
        fogScoreOperational:Number.isFinite(operationalScore)?operationalScore:null,
        score:Number.isFinite(displayScore)?displayScore:row?.score,
        models:Array.isArray(row?.models)?row.models.slice():row?.models
      });
    }));

    const installDrawGuard=()=>{
      if(typeof root.draw!=='function')return false;
      if(root.draw===guardedDraw)return true;
      guardedBase=root.draw;
      guardedDraw=function(...args){
        const live=root.PrognozaEPIRFogSeries;
        const stable=root.PrognozaEPIRFogRenderSeries;
        root.PrognozaEPIRFogSeries=Array.isArray(stable)?stable:[];
        try{return guardedBase.apply(this,args);}
        finally{root.PrognozaEPIRFogSeries=live;}
      };
      root.draw=guardedDraw;
      return true;
    };

    const redrawStable=()=>{
      installUiAuthority();
      installDrawGuard();
      patchMeteogramLegend();
      root.queueMicrotask?.(()=>{try{if(typeof root.draw==='function')root.draw();}catch(_){}});
    };

    const publishSelected=(rows,mode,threshold)=>{
      const selected=copyRows(rows);
      root.PrognozaEPIRFogSeries=selected;
      root.PrognozaEPIRFogRenderSeries=selected.length?cloneRenderSeries(selected,threshold):Object.freeze([]);
      root.PrognozaEPIRFogRenderRevision=(root.PrognozaEPIRFogRenderRevision||0)+1;
      root.PrognozaEPIRFogRenderThreshold=threshold;
      root.PrognozaEPIRFogSelectedMode=mode;
      root.PrognozaEPIRFogEngineMode=mode==='vnext'?'vnext-production':'legacy';
      redrawStable();
      try{root.dispatchEvent(new CustomEvent('prognozaepir:fog-engine-mode-applied',{detail:{mode,threshold}}));}catch(_){ }
    };

    const captureLegacyAndRender=()=>{
      const rows=root.PrognozaEPIRFogSeries;
      if(Array.isArray(rows)&&rows.length)root.PrognozaEPIRFogLegacySeries=legacyRowsFrom(rows);
      if(selectedMode()==='legacy'&&Array.isArray(root.PrognozaEPIRFogLegacySeries)&&root.PrognozaEPIRFogLegacySeries.length){
        publishSelected(root.PrognozaEPIRFogLegacySeries,'legacy',LEGACY_THRESHOLD);
      }else{
        root.PrognozaEPIRFogRenderSeries=Object.freeze([]);
        root.PrognozaEPIRFogRenderThreshold=VNEXT_THRESHOLD;
        redrawStable();
      }
    };

    const commitVNextSnapshot=()=>{
      const rows=root.PrognozaEPIRFogSeries;
      if(Array.isArray(rows)&&rows.length){
        root.PrognozaEPIRFogVNextSeries=copyRows(rows);
        if(!Array.isArray(root.PrognozaEPIRFogLegacySeries)||!root.PrognozaEPIRFogLegacySeries.length)
          root.PrognozaEPIRFogLegacySeries=legacyRowsFrom(rows);
      }
      if(selectedMode()==='legacy'){
        publishSelected(root.PrognozaEPIRFogLegacySeries||[],'legacy',LEGACY_THRESHOLD);
      }else{
        publishSelected(root.PrognozaEPIRFogVNextSeries||rows||[],'vnext',VNEXT_THRESHOLD);
      }
    };

    const applyStoredMode=()=>{
      const mode=selectedMode();
      if(mode==='legacy'&&Array.isArray(root.PrognozaEPIRFogLegacySeries)&&root.PrognozaEPIRFogLegacySeries.length)
        publishSelected(root.PrognozaEPIRFogLegacySeries,'legacy',LEGACY_THRESHOLD);
      else if(mode==='vnext'&&Array.isArray(root.PrognozaEPIRFogVNextSeries)&&root.PrognozaEPIRFogVNextSeries.length)
        publishSelected(root.PrognozaEPIRFogVNextSeries,'vnext',VNEXT_THRESHOLD);
      else redrawStable();
    };

    root.addEventListener?.('prognozaepir:fog-series-updated',captureLegacyAndRender,true);
    root.addEventListener?.('prognozaepir:fog-vnext-updated',commitVNextSnapshot);
    root.addEventListener?.('prognozaepir:fog-engine-mode-changed',()=>setTimeout(applyStoredMode,0));

    root.PrognozaEPIRFogRenderSeries=Object.freeze([]);
    setTimeout(redrawStable,0);
    setTimeout(()=>{installUiAuthority();installFogNavLink();patchMeteogramLegend();applyStoredMode();},600);
  }
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='1.5.0-state-gated-engine-switch';
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
    const ranked=[v.RAD,v.ADV,v.CBL,v.PCP].map(num).filter(finite).map(x=>clamp(x)).sort((a,b)=>b-a);
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
      {v:inverseDiss,w:.10}
    ]);
    return {value:out.value,coverage:out.coverage,saturation:sat,pbl,surfaceCooling:sfc,dissipation:diss,inverseDiss};
  }

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

  function visibilityContradiction(input={},physicsOutput={},physics={}){
    const vis=num(input.visibility);
    const sat=num(physicsOutput.SATURATION);
    const readiness=num(physics.readiness);
    const p=num(physics.value);
    if(input.observedFog===true||!finite(vis)||vis<7000||!finite(p))return {value:0,visibility:vis,saturation:sat,readiness,reason:'inactive'};
    if((finite(sat)&&sat>=.70)&&(finite(readiness)&&readiness>=.65))return {value:0,visibility:vis,saturation:sat,readiness,reason:'strong-state'};
    const highVis=smoothstep(vis,7000,18000);
    const marginal=1-smoothstep(p,.52,.74);
    const unsat=finite(sat)?1-smoothstep(sat,.35,.78):.45;
    const weakState=finite(readiness)?1-smoothstep(readiness,.42,.72):.45;
    const dayFactor=num(input.isDay)===1?1:.65;
    const value=clamp((highVis||0)*(marginal||0)*(.58*(unsat||0)+.42*(weakState||0))*dayFactor);
    return {value,visibility:vis,saturation:sat,readiness,highVis,marginal,unsat,weakState,reason:value>0?'marginal-high-vis':'inactive'};
  }

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
      {v:weatherFog,w:.08}
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
    const contradiction=visibilityContradiction(input,physicsOutput,p);
    let final=combined.value;
    let contradictionPenalty=0;
    if(finite(final)&&contradiction.value>0){
      contradictionPenalty=.45*contradiction.value;
      final=clamp(final*(1-contradictionPenalty));
    }
    const sat=num(physicsOutput.SATURATION),vis=num(input.visibility),isDay=num(input.isDay);
    if(finite(final)&&isDay===1&&finite(vis)&&vis>=12000&&finite(sat)&&sat<.45&&finite(p.value)&&p.value<.65)
      final=Math.min(final,.49);

    return {
      version:VERSION,calibrated:false,calibrationStatus:'physics-state-gated-authoritative-render-2026-09-16',
      P_potential:p.potential,P_physics:p.value,P_direct:d.value,
      P_model_final:final,P_model_final_shadow:final,
      stateReadiness:p.readiness,stateReadinessCoverage:p.readinessCoverage,dissipationPenalty:p.dissipationPenalty,
      contradictionPenalty,visibilityContradiction:contradiction.value,
      physicsCoverage:p.coverage,directCoverage:d.coverage,mechanism1:p.primary,mechanism2:p.secondary,
      leadBucket:combined.weights.bucket,blendWeights:{physics:1,direct:combined.weights.directConfirm,directConfirm:combined.weights.directConfirm},
      directRole:combined.directRole,usedDirectFallback:combined.usedDirectFallback,directContribution:combined.directContribution,
      diagnostics:{direct:d,state:p.diagnostics?.state||null,contradiction}
    };
  }

  function operationalScore(legacyScore,evaluated={}){
    const legacy=num(legacyScore);
    const p=num(evaluated.P_model_final??evaluated.P_model_final_shadow);
    if(finite(p))return {score:clamp(p)*100,source:'vnext-production',fallback:false};
    return {score:finite(legacy)?clamp(legacy,0,100):null,source:'legacy-fallback',fallback:true};
  }

  return Object.freeze({VERSION,weightedAvailable,mechanismPotential,stateReadiness,physicsSignal,visibilityContradiction,directGuidanceSignal,leadWeights,combineShadow,evaluate,operationalScore});
});