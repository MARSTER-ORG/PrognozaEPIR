'use strict';
(()=>{
  if(typeof window==='undefined'||window.__EPIR_FOG_RUNTIME_MODE_SYNC__)return;
  window.__EPIR_FOG_RUNTIME_MODE_SYNC__=true;

  const KEY='prognozaepir-fog-engine-mode';
  const LEGACY='legacy',VNEXT='vnext';

  function mode(){
    try{return localStorage.getItem(KEY)===VNEXT?VNEXT:LEGACY}catch(_){return LEGACY}
  }
  function clone(rows){
    return Array.isArray(rows)?rows.map(row=>{
      if(!row||typeof row!=='object')return row;
      const out={...row};
      if(Array.isArray(row.models))out.models=row.models.map(m=>m&&typeof m==='object'?{...m,components:m.components&&typeof m.components==='object'?{...m.components}:m.components}:m);
      if(row.vnext&&typeof row.vnext==='object')out.vnext={...row.vnext};
      if(row.vnextProbability&&typeof row.vnextProbability==='object')out.vnextProbability={...row.vnextProbability};
      if(row.visGuidance&&typeof row.visGuidance==='object')out.visGuidance={...row.visGuidance};
      return out;
    }):[];
  }
  function installApi(){
    const api=Object.freeze({
      key:KEY,
      get:mode,
      set(value){
        const next=value===VNEXT?VNEXT:LEGACY;
        try{localStorage.setItem(KEY,next)}catch(_){}
        apply('set');
        try{dispatchEvent(new CustomEvent('prognozaepir:fog-engine-mode-changed',{detail:{mode:next}}))}catch(_){}
      },
      LEGACY,VNEXT
    });
    try{window.PrognozaEPIRFogMode=api}catch(_){}
  }
  function apply(reason='sync'){
    const selectedMode=mode();
    const legacy=clone(window.PrognozaEPIRFogLegacySeries);
    const vnext=clone(window.PrognozaEPIRFogVNextSeries);
    const selected=selectedMode===VNEXT?vnext:legacy;
    // Never silently fall back to the other engine. If the selected engine is
    // still computing, publish an empty active series until that engine is ready.
    window.PrognozaEPIRFogSeries=selected;
    window.PrognozaEPIRFogRenderSeries=clone(selected);
    window.PrognozaEPIRFogSelectedMode=selectedMode;
    window.PrognozaEPIRFogEngineMode=selectedMode===VNEXT?'vnext-production-2.4.4':'legacy';
    installApi();
    try{dispatchEvent(new CustomEvent('prognozaepir:fog-engine-mode-applied',{detail:{mode:selectedMode,reason,count:selected.length}}))}catch(_){}
  }

  for(const eventName of ['prognozaepir:fog-series-updated','prognozaepir:fog-vnext-updated','prognozaepir:br-series-updated','prognozaepir:mifg-series-updated']){
    window.addEventListener(eventName,()=>setTimeout(()=>apply(eventName),0));
  }
  window.addEventListener('storage',event=>{if(event.key===KEY)apply('storage')});
  apply('startup');
})();
