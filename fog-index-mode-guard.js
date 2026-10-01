'use strict';
(()=>{
  if(typeof window==='undefined'||window.__EPIR_FOG_INDEX_MODE_GUARD__)return;
  window.__EPIR_FOG_INDEX_MODE_GUARD__=true;

  const KEY='prognozaepir-fog-engine-mode',LEGACY='legacy',VNEXT='vnext';
  const HOUR=3600e3;
  const VIS_EXACT_TOL=5*60e3,VIS_EDGE_TOL=45*60e3,VIS_INTERP_MAX_GAP=3*HOUR;
  const VIS_SPIKE_RATIO=1.8,VIS_NEIGHBOR_RATIO=2.0,VIS_FOG_SCORE=60;
  const finite=Number.isFinite;
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

  // Display-only VIS continuity layer. It is installed after fog-meteogram-overlay
  // has wrapped dataVisible(), so the Fog Engine remains authoritative while the
  // meteogram no longer shows single-hour 20–30 km teeth caused by source/model
  // switching. Raw Fog Engine values remain untouched for TAF and engine logic.
  function fogVisibility(row){
    if(!row)return null;
    for(const value of [row?.visGuidance?.point,row?.visProposed,row?.vis]){
      if(value===null||value===undefined||value==='')continue;
      const v=Number(value);if(finite(v)&&v>0)return v;
    }
    return null;
  }
  function activeVisibilitySeries(){
    const rows=Array.isArray(window.PrognozaEPIRFogSeries)?window.PrognozaEPIRFogSeries:[];
    const out=rows.map(row=>({t:Number(row?.t),vis:fogVisibility(row),score:Number(row?.score)}))
      .filter(row=>finite(row.t)&&finite(row.vis)&&row.vis>0)
      .sort((a,b)=>a.t-b.t);
    if(out.length<3)return out;

    // Two conservative passes remove only isolated one-hour spikes/dips.
    // Sustained visibility changes and low-VIS points supported by FOG >=60 stay intact.
    let clean=out.map(row=>({...row,rawVis:row.vis,filtered:false}));
    for(let pass=0;pass<2;pass++){
      const next=clean.map(row=>({...row}));
      for(let i=1;i<clean.length-1;i++){
        const a=clean[i-1],b=clean[i],c=clean[i+1];
        if(b.t-a.t>1.6*HOUR||c.t-b.t>1.6*HOUR)continue;
        const neighborRatio=Math.max(a.vis,c.vis)/Math.max(1,Math.min(a.vis,c.vis));
        if(neighborRatio>VIS_NEIGHBOR_RATIO)continue;
        const baseline=Math.sqrt(Math.max(1,a.vis)*Math.max(1,c.vis));
        const upward=b.vis>baseline*VIS_SPIKE_RATIO&&baseline<15000;
        const downward=b.vis<baseline/VIS_SPIKE_RATIO&&(!finite(b.score)||b.score<VIS_FOG_SCORE);
        if(!upward&&!downward)continue;
        next[i].vis=baseline;
        next[i].filtered=true;
      }
      clean=next;
    }
    return clean;
  }
  function displayVisibilityAt(t,series=activeVisibilitySeries()){
    const target=Number(t);if(!finite(target)||!series.length)return null;
    let nearest=null,nearestDiff=Infinity,prev=null,next=null;
    for(const row of series){
      const diff=Math.abs(row.t-target);
      if(diff<nearestDiff){nearest=row;nearestDiff=diff;}
      if(row.t<=target)prev=row;
      if(row.t>=target){next=row;break;}
    }
    if(nearest&&nearestDiff<=VIS_EXACT_TOL){
      return {vis:nearest.vis,rawVis:nearest.rawVis??nearest.vis,filtered:nearest.filtered===true,interpolated:false};
    }
    if(prev&&next&&next.t>prev.t){
      const gap=next.t-prev.t;
      if(gap<=VIS_INTERP_MAX_GAP&&target>=prev.t&&target<=next.t){
        const q=(target-prev.t)/gap;
        return {
          vis:prev.vis+(next.vis-prev.vis)*q,
          rawVis:null,
          filtered:prev.filtered===true||next.filtered===true,
          interpolated:true
        };
      }
    }
    if(nearest&&nearestDiff<=VIS_EDGE_TOL){
      return {vis:nearest.vis,rawVis:nearest.rawVis??nearest.vis,filtered:nearest.filtered===true,interpolated:false};
    }
    return null;
  }
  function visText(v){
    v=Number(v);if(!finite(v))return '—';
    return v>=1000?(v/1000).toFixed(1)+' km':Math.round(v)+' m';
  }
  function syncSectionVisibility(z,panelId){
    if((panelId!=='visfog'&&panelId!=='cloud')||!z||!finite(Number(z.VIS)))return;
    const values=document.querySelector('#sectionInfo .section-values');if(!values)return;
    const cells=[...values.querySelectorAll('.section-value')].filter(cell=>String(cell.querySelector('small')?.textContent||'').trim().toLowerCase().startsWith('widzialność'));
    let cell=cells[0];
    if(!cell){cell=document.createElement('div');cell.className='section-value';values.prepend(cell);}
    const suffix=z.VIS_DISPLAY_FILTERED?' · wygładzona':(z.VIS_INTERPOLATED?' · interp.':'');
    cell.innerHTML='<small>Widzialność · FOG ENGINE'+suffix+'</small><strong>'+visText(z.VIS)+'</strong>';
    for(let i=1;i<cells.length;i++)cells[i].remove();
  }
  function installVisibilityContinuity(){
    if(window.__EPIR_FOG_VIS_CONTINUITY__==='2026-10-01-display-continuity3')return true;
    if(!window.__epirFogVisibilityDataWrapped||typeof dataVisible!=='function')return false;
    const baseDataVisible=dataVisible;
    dataVisible=function(){
      const rows=baseDataVisible.apply(this,arguments);
      if(!Array.isArray(rows)||!rows.length)return rows;
      let useEngine=true;try{if(typeof selected!=='undefined'&&selected!=='consensus')useEngine=false;}catch(_){}
      if(!useEngine)return rows;
      const series=activeVisibilitySeries();if(!series.length)return rows;
      return rows.map(row=>{
        const sample=displayVisibilityAt(row?.t,series);if(!sample||!finite(sample.vis))return row;
        return {
          ...row,
          VIS:sample.vis,
          VIS_ENGINE_RAW:finite(sample.rawVis)?sample.rawVis:(finite(Number(row?.VIS))?Number(row.VIS):null),
          VIS_SOURCE:'fog-engine-display',
          VIS_DISPLAY_FILTERED:sample.filtered===true,
          VIS_INTERPOLATED:sample.interpolated===true
        };
      });
    };
    if(typeof showSectionInfo==='function'){
      const baseInfo=showSectionInfo;
      showSectionInfo=function(z,panelId){const out=baseInfo.apply(this,arguments);syncSectionVisibility(z,panelId);return out;};
    }
    window.__EPIR_FOG_VIS_CONTINUITY__='2026-10-01-display-continuity3';
    window.PrognozaEPIRFogVisibilityContinuity=Object.freeze({
      version:window.__EPIR_FOG_VIS_CONTINUITY__,
      displayVisibilityAt:t=>displayVisibilityAt(t),
      maxInterpolationGapMs:VIS_INTERP_MAX_GAP
    });
    try{if(typeof draw==='function')requestAnimationFrame(()=>draw());}catch(_){}
    return true;
  }
  let attempts=0;
  const continuityTimer=setInterval(()=>{
    attempts++;
    if(installVisibilityContinuity()||attempts>=100)clearInterval(continuityTimer);
  },50);
})();
