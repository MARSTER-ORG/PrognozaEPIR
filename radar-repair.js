'use strict';

// Runtime bootstrap. The stable radar repair core runs first because it removes
// obsolete controls. The real MTG LI/LFL module is then restored, and only after
// that the POLRAD stability bridge is installed. This keeps radar analysis and
// lightning ownership independent.
(() => {
  if (window.__EPIR_RADAR_BOOTSTRAP_R9__) return;
  window.__EPIR_RADAR_BOOTSTRAP_R9__ = true;

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

  const loadStability=()=>{
    loadScript('radar-stability-r10.js?v=20260920-r11','epirRadarStabilityR11');
  };

  const loadLfl=()=>{
    ensureLflHost();
    loadScript('lightning-layer.js?v=20260920-lfl-r9','epirLflRuntimeR9',loadStability,loadStability);
  };

  loadScript('radar-repair-core-r6.js?v=20260915-core-r8','epirRadarRepairCoreR6',()=>{
    setTimeout(loadLfl,0);
  },loadLfl);
})();
