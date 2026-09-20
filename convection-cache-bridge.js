'use strict';
(() => {
  if(window.__EPIR_CONVECTION_CACHE_BRIDGE__)return;
  window.__EPIR_CONVECTION_CACHE_BRIDGE__=true;
  const KEY='prognozaepir.convection.nowcast.v1';
  const save=detail=>{
    if(!detail||(!Number.isFinite(Number(detail.tcuProbability))&&!Number.isFinite(Number(detail.cbProbability))))return;
    try{localStorage.setItem(KEY,JSON.stringify(detail));}catch(_){}
  };
  save(window.PrognozaEPIRConvectionNowcast);
  window.addEventListener('prognozaepir:convection-nowcast-updated',e=>save(e.detail));
})();
