'use strict';
(() => {
  if(!window.PrognozaEPIRUnits){
    const MPS_TO_KT=1.9438444924406;
    const KT_TO_MPS=0.5144444444444445;
    const M_TO_FT=3.2808398950131;
    const FT_TO_M=0.3048;
    const finite=v=>Number.isFinite(Number(v));
    const cv=(v,k)=>finite(v)?Number(v)*k:null;
    window.PrognozaEPIRUnits=Object.freeze({
      MPS_TO_KT,KT_TO_MPS,M_TO_FT,FT_TO_M,
      mpsToKt:v=>cv(v,MPS_TO_KT),
      ktToMps:v=>cv(v,KT_TO_MPS),
      mToFt:v=>cv(v,M_TO_FT),
      ftToM:v=>cv(v,FT_TO_M)
    });
  }

  // SAT/FOG initializes Leaflet before the shared responsive stylesheet can
  // widen the map on desktop. Keep Leaflet's cached viewport synchronized with
  // the real #map element so OSM and EUMETSAT tiles always fill the full panel.
  function installSatFogMapResizeGuard(){
    const file=(location.pathname.split('/').pop()||'').toLowerCase();
    if(file!=='sat-fog.html'&&document.documentElement.dataset.epirPage!=='sat-fog')return;
    if(window.__PROGNOZA_EPIR_SAT_MAP_RESIZE_GUARD__)return;
    window.__PROGNOZA_EPIR_SAT_MAP_RESIZE_GUARD__=true;

    const install=()=>{
      const el=document.getElementById('map');
      if(!el)return;
      let lastW=0,lastH=0,queued=false;
      const notify=(force=false)=>{
        const r=el.getBoundingClientRect();
        const w=Math.round(r.width),h=Math.round(r.height);
        if(!w||!h)return;
        if(!force&&w===lastW&&h===lastH)return;
        lastW=w;lastH=h;
        if(queued)return;
        queued=true;
        requestAnimationFrame(()=>{
          queued=false;
          try{window.dispatchEvent(new Event('resize'));}catch(_){}
        });
      };

      if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>notify(false)).observe(el);
      window.addEventListener('orientationchange',()=>setTimeout(()=>notify(true),80),{passive:true});
      window.addEventListener('load',()=>notify(true),{once:true});
      [0,80,250,700,1500].forEach(ms=>setTimeout(()=>notify(true),ms));
    };

    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
    else install();
  }

  installSatFogMapResizeGuard();
})();
