'use strict';
(()=>{
  if(typeof window==='undefined'||window.__EPIR_TAF_FOG_MODE_SYNC__)return;
  window.__EPIR_TAF_FOG_MODE_SYNC__=true;

  const KEY='prognozaepir-fog-engine-mode',LEGACY='legacy',VNEXT='vnext';
  const mode=()=>{try{return localStorage.getItem(KEY)===VNEXT?VNEXT:LEGACY}catch(_){return LEGACY}};
  const clone=rows=>Array.isArray(rows)?rows.map(x=>x&&typeof x==='object'?{...x,models:Array.isArray(x.models)?x.models.map(m=>m&&typeof m==='object'?{...m,components:m.components&&typeof m.components==='object'?{...m.components}:m.components}:m):x.models}:x):[];

  function patchPolicy(){
    const base=window.PrognozaEPIRTAFFogPolicy;
    if(!base||base.__modeSyncPatched)return false;
    const vnextSeries=typeof base.seriesForTaf==='function'?base.seriesForTaf.bind(base):()=>[];
    const recover=typeof base.recoverLegacySeries==='function'?base.recoverLegacySeries.bind(base):clone;
    function seriesForSelected(win){
      if(mode()===VNEXT)return vnextSeries(win);
      const direct=clone(win?.PrognozaEPIRFogLegacySeries);
      if(direct.length)return direct;
      const active=clone(win?.PrognozaEPIRFogSeries);
      return active.length?recover(active):[];
    }
    const patched={...base,__modeSyncPatched:true,selectedMode:mode,seriesForTaf:seriesForSelected,seriesForMode:seriesForSelected};
    Object.defineProperty(patched,'TAF_FOG_MODE',{enumerable:true,get:mode});
    window.PrognozaEPIRTAFFogPolicy=Object.freeze(patched);
    return true;
  }

  function replaceText(el,from,to){
    if(!el)return;
    const before=el.textContent||'',after=before.replace(from,to);
    if(after!==before)el.textContent=after;
  }
  function syncUi(){
    const m=mode(),legacy=m===LEGACY,label=legacy?'LEGACY':'NEXT 2.4.4';
    window.PrognozaEPIRFogSelectedMode=m;
    const box=document.getElementById('tafFogSource');
    const wantedState=`AKTYWNY: ${label}`;
    if(box&&(box.dataset.syncedFogMode!==m||!(box.textContent||'').includes(wantedState))){
      box.dataset.syncedFogMode=m;
      box.innerHTML=`<div class="fog-mode-copy"><b>Fog source: ${label}</b><span>Generator TAF używa serii FG wybranego silnika. Domyślny tryb to LEGACY; NEXT 2.4.4 jest używany tylko po świadomym przełączeniu.</span></div><div class="fog-mode-state">${wantedState}</div>`;
    }
    if(legacy){
      const conf=document.getElementById('conf');
      if(conf&&/vNext/i.test(conf.textContent||'')){
        const next=(conf.textContent||'').replace(/vNext/gi,'LEGACY').replace(/score, progów VIS i prognozy VIS z LEGACY/gi,'score i widzialności z LEGACY');
        if(next!==conf.textContent)conf.textContent=next;
      }
      const sources=document.getElementById('sources');
      if(sources&&/vNext/i.test(sources.innerHTML||'')){
        const next=sources.innerHTML.replace(/FG\s+vNext/gi,'FG LEGACY').replace(/Fog source:\s*vNext/gi,'Fog source: LEGACY');
        if(next!==sources.innerHTML)sources.innerHTML=next;
      }
    }
    const summary=document.getElementById('fog244Summary');
    if(summary){
      const h=summary.querySelector('h2'),wanted=legacy?'EPIR FOG 2.4.4 — diagnostyka porównawcza (generator używa LEGACY)':'EPIR FOG 2.4.4 — osobne maksimum FG / BR / MIFG';
      if(h&&h.textContent!==wanted)h.textContent=wanted;
      if(summary.dataset.generatorFogMode!==m)summary.dataset.generatorFogMode=m;
    }
  }

  function install(){
    if(!patchPolicy())return false;
    syncUi();
    let queued=false;
    const observer=new MutationObserver(()=>{
      if(queued)return;queued=true;
      setTimeout(()=>{queued=false;syncUi()},0);
    });
    observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
    window.addEventListener('storage',e=>{if(e.key===KEY)syncUi()});
    window.addEventListener('prognozaepir:fog-engine-mode-changed',syncUi);
    window.addEventListener('DOMContentLoaded',()=>setTimeout(syncUi,0),{once:true});
    setInterval(syncUi,2000);
    return true;
  }

  if(!install()){
    let tries=0;
    const timer=setInterval(()=>{if(install()||++tries>80)clearInterval(timer)},50);
  }
})();
