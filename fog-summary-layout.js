'use strict';
(()=>{
  if(typeof window==='undefined'||typeof document==='undefined')return;

  if(!window.__EPIR_METEOGRAM_PRESSURE_UNITS_LOADER__){
    window.__EPIR_METEOGRAM_PRESSURE_UNITS_LOADER__=true;
    const p=document.createElement('script');
    p.src='meteogram-pressure-units.js?v=20260922-mmHg1';
    p.async=false;
    p.dataset.epirPressureUnits='1';
    p.onerror=()=>{window.__EPIR_METEOGRAM_PRESSURE_UNITS_LOADER__=false;console.error('EPIR meteogram: nie udało się załadować meteogram-pressure-units.js');};
    (document.head||document.documentElement).appendChild(p);
  }

  if(window.__EPIR_FOG_244__||window.__EPIR_FOG_244_LOADER__)return;
  window.__EPIR_FOG_244_LOADER__=true;
  const s=document.createElement('script');
  s.src='fog-engine-v244.js?v=20260922-fog244-threshold60-1';
  s.async=false;
  s.dataset.epirFog244='1';
  s.onerror=()=>{window.__EPIR_FOG_244_LOADER__=false;console.error('EPIR FOG 2.4.4: nie udało się załadować fog-engine-v244.js');};
  (document.head||document.documentElement).appendChild(s);
})();
