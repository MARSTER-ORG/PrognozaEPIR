'use strict';
(()=>{
  if(typeof window==='undefined'||window.__EPIR_MIFG_244_BRIDGE__)return;
  window.__EPIR_MIFG_244_BRIDGE__=true;
  const api={
    getSeries:()=>window.PrognozaEPIRFog244?.getMIFGSeries?.()||[],
    getStatus:()=>{
      const s=window.PrognozaEPIRFog244?.getStatus?.()||{};
      return {source:'EPIR FOG 2.4.4 integrated',error:s.error||null,updated:s.updated||null,count:api.getSeries().length};
    },
    refresh:()=>window.PrognozaEPIRFog244?.refresh?.()||Promise.resolve(api.getSeries())
  };
  window.PrognozaEPIRMIFG=api;
})();
