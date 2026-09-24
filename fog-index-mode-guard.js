'use strict';
(()=>{
  if(typeof window==='undefined'||window.__EPIR_FOG_INDEX_MODE_GUARD__)return;
  window.__EPIR_FOG_INDEX_MODE_GUARD__=true;

  const KEY='prognozaepir-fog-engine-mode',LEGACY='legacy',VNEXT='vnext';
  const clone=rows=>Array.isArray(rows)?rows.map(row=>{
    if(!row||typeof row!=='object')return row;
    const out={...row};
    if(Array.isArray(row.models))out.models=row.models.map(m=>m&&typeof m==='object'?{...m,components:m.components&&typeof m.components==='object'?{...m.components}:m.components}:m);
    if(row.vnext&&typeof row.vnext==='object')out.vnext={...row.vnext};
    if(row.vnextProbability&&typeof row.vnextProbability==='object')out.vnextProbability={...row.vnextProbability};
    if(row.visGuidance&&typeof row.visGuidance==='object')out.visGuidance={...row.visGuidance};
    return out;
  }):[];
  function selectedMode(){
    try{return localStorage.getItem(KEY)===VNEXT?VNEXT:LEGACY}catch(_){return LEGACY}
  }
  function apply(){
    const mode=selectedMode();
    const source=mode===VNEXT?window.PrognozaEPIRFogVNextSeries:window.PrognozaEPIRFogLegacySeries;
    const selected=clone(source);
    // Exact mode means exact series: never substitute the other engine.
    window.PrognozaEPIRFogSeries=selected;
    window.PrognozaEPIRFogRenderSeries=clone(selected);
    window.PrognozaEPIRFogSelectedMode=mode;
    window.PrognozaEPIRFogEngineMode=mode===VNEXT?'vnext-production-2.4.4':'legacy';
    return selected;
  }
  function setMode(value){
    const next=value===VNEXT?VNEXT:LEGACY;
    try{localStorage.setItem(KEY,next)}catch(_){}
    try{window.PrognozaEPIRFogIndexBridge?.sync?.()}catch(_){}
    apply();
    try{window.dispatchEvent(new CustomEvent('prognozaepir:fog-engine-mode-changed',{detail:{mode:next}}))}catch(_){}
    try{window.dispatchEvent(new CustomEvent('prognozaepir:fog-engine-mode-applied',{detail:{mode:next,source:'meteogram-mode-guard'}}))}catch(_){}
  }
  window.PrognozaEPIRFogMode=Object.freeze({key:KEY,get:selectedMode,set:setMode,LEGACY,VNEXT});

  // Register before the overlay. The canonical bridge emits these events after
  // it copies both series; the guard then selects the requested series before
  // the overlay schedules its redraw.
  for(const eventName of ['prognozaepir:fog-series-updated','prognozaepir:fog-vnext-updated','prognozaepir:br-series-updated','prognozaepir:mifg-series-updated']){
    window.addEventListener(eventName,apply);
  }
  window.addEventListener('storage',event=>{if(event.key===KEY){try{window.PrognozaEPIRFogIndexBridge?.sync?.()}catch(_){}apply();}});
  apply();
})();
