'use strict';

// Runtime bootstrap. The stable radar repair core runs first because it removes
// obsolete controls. The real MTG LI/LFL module is then restored, followed by
// the POLRAD stability bridge, CMAX display QC and the final late-start UI synchronizer.
(() => {
  if (window.__EPIR_RADAR_BOOTSTRAP_R12__) return;
  window.__EPIR_RADAR_BOOTSTRAP_R12__ = true;

  // responsive.css is attached by theme.js after the initial document layout.
  // On wide screens this can expand the radar card after Leaflet has already
  // measured #map. Leaflet then keeps its old internal size and leaves an empty
  // strip on the right. Observe the real container size and invalidate Leaflet
  // whenever that geometry changes.
  const installMapResizeGuard=()=>{
    const host=document.getElementById('map');
    if(!host||host.dataset.epirLeafletResizeGuard==='1')return;
    host.dataset.epirLeafletResizeGuard='1';
    let raf=0;
    const sync=()=>{
      if(raf)cancelAnimationFrame(raf);
      raf=requestAnimationFrame(()=>{
        raf=0;
        try{
          if(typeof map!=='undefined'&&map&&typeof map.invalidateSize==='function'){
            map.invalidateSize({pan:false,debounceMoveend:true});
          }
        }catch(_){}
      });
    };
    if(typeof ResizeObserver==='function'){
      const observer=new ResizeObserver(sync);
      observer.observe(host);
      window.__EPIR_RADAR_MAP_RESIZE_OBSERVER__=observer;
    }
    window.addEventListener('resize',sync,{passive:true});
    window.addEventListener('orientationchange',sync,{passive:true});
    try{document.fonts?.ready?.then(sync).catch(()=>{});}catch(_){}
    // Cover the initial async responsive stylesheet application as well as a
    // late map-layer bootstrap on slower devices.
    for(const delay of [0,80,250,700,1600])setTimeout(sync,delay);
  };

  const loadScript=(src,id,onload,onerror)=>{
    if(document.getElementById(id)){onload?.();return;}
    const s=document.createElement('script');
    s.id=id;s.src=src;s.async=false;
    if(onload)s.onload=onload;
    s.onerror=()=>{console.error('PrognozaEPIR: failed to load',src);onerror?.();};
    document.head.appendChild(s);
  };

  const ensureLflHost=()=>{
    if(document.getElementById('stormHobbyCard'))return;
    const mapCard=document.getElementById('map')?.closest('.card');
    if(!mapCard)return;
    const card=document.createElement('section');
    card.id='stormHobbyCard';card.className='card';card.style.marginTop='8px';
    mapCard.insertAdjacentElement('afterend',card);

    if(!document.getElementById('epirLflHostStyle')){
      const st=document.createElement('style');st.id='epirLflHostStyle';
      st.textContent=`
        #stormHobbyCard .storm-hobby{padding:8px;font-size:10px;line-height:1.35}
        #stormHobbyCard .storm-main{font-size:15px;font-weight:700;margin-bottom:4px}
        #stormHobbyCard .storm-details{color:var(--muted);margin-bottom:7px}
        #stormHobbyCard .storm-radii{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px}
        #stormHobbyCard .storm-radii>div{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:5px;text-align:center}
        #stormHobbyCard .storm-radii b,#stormHobbyCard .storm-radii span{display:block}
        #stormHobbyCard .storm-radii span{font-size:9px;color:var(--muted);margin-top:2px}
        #stormHobbyCard .storm-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
        #stormHobbyCard .storm-actions button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:6px;padding:5px 7px;font-size:10px}
        #stormHobbyCard .storm-actions button.primary{background:var(--blue2);color:white;border-color:var(--blue2)}
        @media(max-width:650px){#stormHobbyCard .storm-radii{grid-template-columns:repeat(5,minmax(72px,1fr));overflow-x:auto}}
      `;
      document.head.appendChild(st);
    }
  };

  const loadUiSync=()=>{
    loadScript('radar-ui-sync-r12.js?v=20260920-r12','epirRadarUiSyncR12');
  };

  const loadQc=()=>{
    loadScript('radar-qc-r1.js?v=20260930-r2','epirPolradQcR2',loadUiSync,loadUiSync);
  };

  const loadStability=()=>{
    loadScript('radar-stability-r10.js?v=20260920-r11','epirRadarStabilityR11',loadQc,loadQc);
  };

  const loadLfl=()=>{
    ensureLflHost();
    loadScript('lightning-layer.js?v=20260920-lfl-r9','epirLflRuntimeR9',loadStability,loadStability);
  };

  installMapResizeGuard();
  loadScript('radar-repair-core-r6.js?v=20260915-core-r8','epirRadarRepairCoreR6',()=>{
    setTimeout(loadLfl,0);
  },loadLfl);
})();
