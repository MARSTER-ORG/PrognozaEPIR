'use strict';
(() => {
  if (!/\/taf\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__) return;
  window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__ = true;

  const loadScript = src => new Promise((resolve,reject) => {
    const existing=[...document.scripts].find(s=>s.src&&s.src.includes(src.split('?')[0]));
    if(existing){if(existing.dataset.loaded==='1'||(src.includes('taf-hybrid-engine')&&window.PrognozaEPIRTAFHybridEngine))return resolve();existing.addEventListener('load',resolve,{once:true});existing.addEventListener('error',()=>reject(Error('Nie udało się załadować '+src)),{once:true});return;}
    const s=document.createElement('script');s.src=src;s.async=false;s.dataset.tafHybrid='1';s.onload=()=>{s.dataset.loaded='1';resolve();};s.onerror=()=>reject(Error('Nie udało się załadować '+src));(document.head||document.documentElement).appendChild(s);
  });

  (async()=>{
    try{
      if(!window.PrognozaEPIRTAFHybridEngine)await loadScript('taf-hybrid-engine.js?v=20260912-hybrid-v1');
      await loadScript('taf-hybrid-adapter.js?v=20260912-hybrid-v1');
      window.PrognozaEPIRTAFGeneratorPolicy=Object.freeze({mode:'hybrid',version:window.PrognozaEPIRTAFHybridEngine?.ENGINE_VERSION||null});
    }catch(e){
      console.error('[TAF Hybrid bootstrap]',e);
      const b=document.getElementById('badge'),st=document.getElementById('st');if(b){b.textContent='BŁĄD HYBRID';b.className='badge bad';}if(st)st.textContent=e.message;
    }
  })();
})();
