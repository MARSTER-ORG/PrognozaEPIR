'use strict';
(()=>{
  if(typeof window==='undefined'||typeof document==='undefined')return;

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
