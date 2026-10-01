'use strict';
(()=>{
  if(typeof window==='undefined'||typeof document==='undefined')return;

  const ACTIVE_FOG_BRIDGE_VERSION='2026-10-01-active-fog-bars1';

  function loadOnce(src,selector,mark,onload){
    const existing=document.querySelector(selector);
    if(existing){if(onload)setTimeout(onload,0);return existing;}
    const s=document.createElement('script');
    s.src=src;s.async=false;
    if(mark)s.dataset[mark]='1';
    if(onload)s.onload=onload;
    s.onerror=()=>console.error('PrognozaEPIR: nie udało się załadować '+src);
    (document.head||document.documentElement).appendChild(s);
    return s;
  }

  const validSeries=rows=>Array.isArray(rows)&&rows.length?rows:null;

  function selectedFogMode(){
    try{
      if(window.PrognozaEPIRFogMode?.get)return window.PrognozaEPIRFogMode.get()==='vnext'?'vnext':'legacy';
      return localStorage.getItem('prognozaepir-fog-engine-mode')==='vnext'?'vnext':'legacy';
    }catch(_){return 'legacy';}
  }

  function activeFogSeries(){
    // To samo źródło, z którego korzysta tooltip meteogramu.
    // Dzięki temu wartość FOG w danej godzinie i wysokość słupka nie mogą się rozjechać.
    const active=validSeries(window.PrognozaEPIRFogSeries);
    if(active)return active;

    const legacy=validSeries(window.PrognozaEPIRFogLegacySeries);
    if(selectedFogMode()==='legacy'&&legacy)return legacy;

    const vnext=validSeries(window.PrognozaEPIRFogVNextSeries);
    if(selectedFogMode()==='vnext'&&vnext)return vnext;

    return legacy||vnext||null;
  }

  function withActiveFogSeries(fn){
    const active=activeFogSeries();
    if(!active)return fn();

    const restore=[];
    const replaceMethod=(obj,key)=>{
      if(!obj||typeof obj[key]!=='function')return;
      const old=obj[key];
      try{
        obj[key]=()=>active;
        if(obj[key]!==old)restore.push(()=>{try{obj[key]=old;}catch(_){}});
      }catch(_){}
    };

    // fog-meteogram-overlay.js wcześniej wymuszał serię 2.4.4 przed aktywną
    // PrognozaEPIRFogSeries. Na czas rysowania kierujemy wszystkie jego wejścia
    // do dokładnie tej samej aktywnej serii co tooltip.
    replaceMethod(window.PrognozaEPIRFog244Context,'getSeries');
    replaceMethod(window.PrognozaEPIRFog244,'getAdjustedSeries');
    replaceMethod(window.PrognozaEPIRFog244,'getSeries');

    const oldVNext=window.PrognozaEPIRFogVNextSeries;
    let vnextReplaced=false;
    try{
      window.PrognozaEPIRFogVNextSeries=active;
      vnextReplaced=true;
    }catch(_){}

    window.__EPIR_ACTIVE_FOG_METEOGRAM_SOURCE__={
      version:ACTIVE_FOG_BRIDGE_VERSION,
      mode:selectedFogMode(),
      rows:active.length,
      firstTime:Number(active[0]?.t)||null,
      lastTime:Number(active[active.length-1]?.t)||null
    };

    try{return fn();}
    finally{
      if(vnextReplaced){try{window.PrognozaEPIRFogVNextSeries=oldVNext;}catch(_){}}
      for(let i=restore.length-1;i>=0;i--)restore[i]();
    }
  }

  function installActiveFogMeteogramBridge(){
    if(window.__EPIR_ACTIVE_FOG_METEOGRAM_BRIDGE__===ACTIVE_FOG_BRIDGE_VERSION)return true;
    if(typeof draw!=='function'||typeof showSectionInfo!=='function')return false;

    const baseDraw=draw;
    draw=function(){return withActiveFogSeries(()=>baseDraw());};

    const baseInfo=showSectionInfo;
    showSectionInfo=function(z,panelId){return withActiveFogSeries(()=>baseInfo(z,panelId));};

    window.__EPIR_ACTIVE_FOG_METEOGRAM_BRIDGE__=ACTIVE_FOG_BRIDGE_VERSION;
    return true;
  }

  if(!installActiveFogMeteogramBridge()){
    let attempts=0;
    const timer=setInterval(()=>{
      attempts++;
      if(installActiveFogMeteogramBridge()||attempts>=30)clearInterval(timer);
    },100);
  }

  if(!window.__EPIR_METEOGRAM_PRESSURE_UNITS_LOADER__){
    window.__EPIR_METEOGRAM_PRESSURE_UNITS_LOADER__=true;
    loadOnce('meteogram-pressure-units.js?v=20260922-mmHg2','script[data-epir-pressure-units="1"]','epirPressureUnits');
  }

  const loadModeSync=()=>{
    if(window.__EPIR_FOG_RUNTIME_MODE_SYNC__)return;
    loadOnce('fog-runtime-mode-sync.js?v=20260924-legacy-sync1','script[data-epir-fog-mode-sync="1"]','epirFogModeSync');
  };
  const loadContext=()=>{
    loadModeSync();
    if(window.__EPIR_FOG_244_CONTEXT__)return;
    loadOnce('fog-engine-v244-context.js?v=20260922-fog244-context2','script[data-epir-fog244-context="1"]','epirFog244Context');
  };

  // The meteogram keeps the lightweight legacy fog series as the default.
  // vNext remains calculated in the background for an explicit user choice,
  // but it is no longer allowed to commandeer the global active mode.
  loadModeSync();
  if(window.__EPIR_FOG_244__){loadContext();return;}
  if(window.__EPIR_FOG_244_LOADER__)return;
  window.__EPIR_FOG_244_LOADER__=true;
  const s=document.createElement('script');
  s.src='fog-engine-v244.js?v=20260922-fog244-threshold60-1';
  s.async=false;s.dataset.epirFog244='1';
  s.onload=loadContext;
  s.onerror=()=>{window.__EPIR_FOG_244_LOADER__=false;console.error('EPIR FOG 2.4.4: nie udało się załadować fog-engine-v244.js');};
  (document.head||document.documentElement).appendChild(s);
})();
