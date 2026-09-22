'use strict';
(() => {
  const FRAME_ID='epirFogCanonicalRuntime';
  const MODE_KEY='prognozaepir-fog-engine-mode';
  const VERSION='2026-09-22-threshold60-hoverbr-1';
  const SECTION_FIX='fog-section-info-fix.js';
  const ACTIVE=60;
  const finite=Number.isFinite;
  let frame=null,lastSync=0,lastCounts={legacy:0,vnext:0,br:0,mifg:0};

  function selectedMode(){
    try{return localStorage.getItem(MODE_KEY)==='vnext'?'vnext':'legacy';}
    catch(_){return 'legacy';}
  }
  function copyRows(rows){
    if(!Array.isArray(rows))return [];
    return rows.map(row=>{
      if(!row||typeof row!=='object')return row;
      const out={...row};
      if(Array.isArray(row.models))out.models=row.models.map(m=>m&&typeof m==='object'?{...m,components:m.components&&typeof m.components==='object'?{...m.components}:m.components}:m);
      if(row.vnext&&typeof row.vnext==='object')out.vnext={...row.vnext};
      if(row.vnextProbability&&typeof row.vnextProbability==='object')out.vnextProbability={...row.vnextProbability};
      if(row.visGuidance&&typeof row.visGuidance==='object')out.visGuidance={...row.visGuidance};
      return out;
    });
  }
  function activeRows(rows){
    return copyRows(rows).filter(row=>finite(Number(row?.score))&&Number(row.score)>=ACTIVE);
  }
  function canonicalWindow(){
    try{return frame?.contentWindow||null;}catch(_){return null;}
  }
  function emit(name,detail){
    try{window.dispatchEvent(new CustomEvent(name,{detail}));}catch(_){}
  }
  function computeSelectedBR(cw,mode,legacy,vnext){
    try{
      const engine=cw?.PrognozaEPIRBREngine;
      const src=mode==='vnext'&&vnext.length?vnext:legacy;
      if(!engine?.scoreRow||!src.length)return [];
      const now=Date.now();
      return activeRows(src.map(row=>engine.scoreRow(row,mode,now)).filter(r=>r&&finite(Number(r.t))&&finite(Number(r.score))));
    }catch(_){return [];}
  }
  function sync(){
    const cw=canonicalWindow();
    if(!cw)return false;
    let legacy=[],vnext=[],mifg=[];
    try{
      legacy=copyRows(cw.PrognozaEPIRFogLegacySeries);
      vnext=copyRows(cw.PrognozaEPIRFogVNextSeries);
      const m=cw.PrognozaEPIRMIFG?.getSeries?.();
      mifg=activeRows(m);
    }catch(_){return false;}
    if(!legacy.length&&!vnext.length)return false;

    const mode=selectedMode();
    const selected=mode==='vnext'&&vnext.length?vnext:legacy;
    const br=computeSelectedBR(cw,mode,legacy,vnext);

    window.PrognozaEPIRFogLegacySeries=legacy;
    window.PrognozaEPIRFogVNextSeries=vnext;
    window.PrognozaEPIRFogSeries=copyRows(selected);
    window.PrognozaEPIRFogSelectedMode=mode;
    window.PrognozaEPIRFogEngineMode=mode==='vnext'?'vnext-production':'legacy';
    window.PrognozaEPIRFogRenderThreshold=ACTIVE;
    window.PrognozaEPIRMIFGSeries=mifg;
    window.PrognozaEPIRMIFG=Object.freeze({
      VERSION:'canonical-fog-page-bridge',
      getSeries:()=>copyRows(window.PrognozaEPIRMIFGSeries)
    });
    window.PrognozaEPIRBRSeries=br;

    lastSync=Date.now();
    lastCounts={legacy:legacy.length,vnext:vnext.length,br:br.length,mifg:mifg.length};
    const detail={source:'fog.html',mode,version:VERSION,...lastCounts};
    emit('prognozaepir:fog-series-updated',detail);
    if(vnext.length)emit('prognozaepir:fog-vnext-updated',detail);
    emit('prognozaepir:mifg-series-updated',detail);
    emit('prognozaepir:br-series-updated',detail);
    emit('prognozaepir:fog-engine-mode-applied',{...detail,threshold:window.PrognozaEPIRFogRenderThreshold});
    return true;
  }
  function bindCanonicalEvents(cw){
    for(const ev of ['prognozaepir:fog-series-updated','prognozaepir:fog-vnext-updated','prognozaepir:mifg-series-updated','prognozaepir:br-series-updated','prognozaepir:fog-engine-mode-applied']){
      try{cw.addEventListener(ev,()=>setTimeout(sync,0));}catch(_){}
    }
  }
  function loadSectionFix(){
    if(document.querySelector('script[data-epir-fog-section-fix="1"]'))return;
    const s=document.createElement('script');
    s.src=SECTION_FIX+'?v='+encodeURIComponent(VERSION);
    s.dataset.epirFogSectionFix='1';
    s.async=false;
    (document.body||document.head||document.documentElement).appendChild(s);
  }
  function loadFrame(){
    if(frame?.isConnected)return frame;
    frame=document.createElement('iframe');
    frame.id=FRAME_ID;
    frame.title='Kanoniczny runtime EPIR FOG';
    frame.tabIndex=-1;
    frame.setAttribute('aria-hidden','true');
    frame.style.cssText='position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    frame.src='fog.html?runtime-provider=1&v='+encodeURIComponent(VERSION);
    frame.addEventListener('load',()=>{
      const cw=canonicalWindow();
      if(cw)bindCanonicalEvents(cw);
      setTimeout(sync,100);
      setTimeout(sync,700);
      setTimeout(sync,2200);
      setTimeout(sync,6000);
    });
    document.body.appendChild(frame);
    return frame;
  }
  function reloadCanonical(){
    try{
      if(frame?.contentWindow)frame.contentWindow.location.reload();
      else loadFrame();
    }catch(_){loadFrame();}
  }
  function start(){
    loadSectionFix();
    loadFrame();
    window.addEventListener('storage',ev=>{if(ev.key===MODE_KEY)reloadCanonical();});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(sync,0);});
    setInterval(sync,60000);
  }

  window.PrognozaEPIRFogIndexBridge=Object.freeze({
    version:VERSION,
    sync,
    selectedMode,
    status:()=>({lastSync,...lastCounts,frameReady:Boolean(canonicalWindow())})
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
