'use strict';
(() => {
  const APP_VERSION = 'v0.10.21 HTML';
  const OBS_KEY = 'prognozaepir-fog-observations-v2';
  const LATEST_URL = 'data/observations/latest.json';
  const RECENT_URL = 'data/observations/recent.json';
  const MAX_OBS = 60;
  let latestData = null;
  let recentData = null;

  const finite = Number.isFinite;
  const num = v => finite(Number(v)) ? Number(v) : null;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (v,d=1) => finite(v) ? Number(v).toFixed(d) : '—';
  const fmtM = v => finite(v) ? `${Math.round(v)} m` : '—';

  function setVersion(){
    const v=document.querySelector('.brand small');
    if(v) v.textContent=APP_VERSION;
  }

  async function fetchJson(url){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),3500);
    try{
      const r=await fetch(`${url}?v=${Date.now()}`,{cache:'no-store',signal:ctrl.signal});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function toLocalObservation(o){
    if(!o) return null;
    const t=Date.parse(o.obs_time||'');
    const T=num(o.temperature_c), Td=num(o.dew_point_c), visM=num(o.visibility_m);
    if(!finite(t)||T===null||Td===null||visM===null||visM<=0) return null;
    return {
      t,T,Td,visM,
      created:t,
      automatic:true,
      source:'EPIR_METAR_SYNOP',
      metarObsTime:o.metar_obs_time||null,
      synopObsTime:o.synop_obs_time||null,
      visibilitySource:o.visibility_source||null,
      fog:Boolean(o.fog),mist:Boolean(o.mist),freezingFog:Boolean(o.freezing_fog)
    };
  }

  function storeAutomaticObservations(data){
    const rows=(data?.observations||[]).map(toLocalObservation).filter(Boolean).sort((a,b)=>a.t-b.t).slice(-MAX_OBS);
    try{
      // Manual observations are intentionally replaced by the server-side EPIR observation stream.
      localStorage.setItem(OBS_KEY,JSON.stringify(rows));
      localStorage.setItem('prognozaepir-observation-mode','automatic-epir-metar-synop');
    }catch(_){ }
    return rows;
  }

  function loadFogEngine(){
    return new Promise((resolve,reject)=>{
      if(document.querySelector('script[data-epir-fog-loaded="1"]')) return resolve();
      const s=document.createElement('script');
      s.src='fog-engine.js';s.dataset.epirFogLoaded='1';
      s.onload=resolve;s.onerror=reject;
      document.body.appendChild(s);
    });
  }

  function localTime(v){
    const t=Date.parse(v||''); if(!finite(t)) return '—';
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleString('pl-PL');}
  }

  function ageText(v){
    const t=Date.parse(v||''); if(!finite(t)) return '—';
    const m=Math.max(0,Math.round((Date.now()-t)/60000));
    if(m<60)return `${m} min`;
    return `${Math.floor(m/60)} h ${m%60} min`;
  }

  function metarVisText(m){
    if(!m||!finite(num(m.visibility_m))) return '—';
    return `${m.visibility_lower_bound?'≥':''}${Math.round(m.visibility_m)} m`;
  }

  function nearestConsensus(t,maxDiff=75*60e3){
    try{
      if(typeof consensus==='undefined'||!Array.isArray(consensus)||!consensus.length)return null;
      let best=null,bd=Infinity;
      for(const z of consensus){
        const d=Math.abs((z.t??0)-t);if(d<bd){bd=d;best=z;}
      }
      return bd<=maxDiff?best:null;
    }catch(_){return null;}
  }

  function deltaText(model,obs,unit,digits=1){
    if(!finite(model)||!finite(obs))return '—';
    const d=model-obs;
    return `${d>=0?'+':''}${d.toFixed(digits)} ${unit}`;
  }

  function verificationHtml(){
    const fused=latestData?.fused;
    if(!fused)return '<div class="fog-data-note">Brak aktualnej obserwacji do weryfikacji modelu.</div>';
    const t=Date.parse(fused.obs_time||'');
    const z=nearestConsensus(t);
    if(!z)return '<div class="fog-data-note"><b>Weryfikacja modelu:</b> oczekiwanie na konsensus dla godziny obserwacji.</div>';
    const visObs=num(fused.visibility_m), visModel=num(z.VIS);
    const T=num(fused.temperature_c), Td=num(fused.dew_point_c), RH=num(fused.relative_humidity_pct);
    return `<div class="fog-data-note"><b>Bieżąca kontrola konsensusu:</b> błąd model−OBS · `+
      `T ${deltaText(num(z.T),T,'°C')} · Td ${deltaText(num(z.Td),Td,'°C')} · RH ${deltaText(num(z.RH),RH,'pp',0)} · `+
      `VIS ${deltaText(visModel,visObs,'m',0)}. Te różnice są używane jako lokalna informacja korekcyjna dla najbliższych godzin.</div>`;
  }

  function observationPanelHtml(){
    const m=latestData?.metar||null, s=latestData?.synop||null, f=latestData?.fused||null;
    const synVis=s&&finite(num(s.visibility_m))?fmtM(num(s.visibility_m)):'—';
    const weather=[m?.fog?'FG':null,m?.mist?'BR':null,m?.freezing_fog?'FZFG':null,s?.present_weather||null].filter(Boolean).join(' / ')||'brak zjawiska';
    return `<details id="epirObservationPanel" class="fog-diag" open>
      <summary>Obserwacje automatyczne EPIR — METAR + SYNOP 12342</summary>
      <div class="fog-diag-grid">
        <div class="fog-diag-cell"><small>METAR EPIR</small><b>${esc(localTime(m?.obs_time))}</b><small>wiek ${esc(ageText(m?.obs_time))}</small></div>
        <div class="fog-diag-cell"><small>VIS METAR</small><b>${esc(metarVisText(m))}</b><small>${m?.visibility_lower_bound?'wartość graniczna ≥':'wartość raportowana'}</small></div>
        <div class="fog-diag-cell"><small>SYNOP 12342</small><b>${esc(localTime(s?.obs_time))}</b><small>wiek ${esc(ageText(s?.obs_time))}</small></div>
        <div class="fog-diag-cell"><small>VIS SYNOP</small><b>${esc(synVis)}</b><small>${s?.source==='IMGW_WIS2_SYNOP'?'dokładna widzialność WIS2':'brak pełnego WIS2'}</small></div>
        <div class="fog-diag-cell"><small>T / Td</small><b>${fmt(num(f?.temperature_c))} / ${fmt(num(f?.dew_point_c))} °C</b></div>
        <div class="fog-diag-cell"><small>RH</small><b>${fmt(num(f?.relative_humidity_pct),0)}%</b></div>
        <div class="fog-diag-cell"><small>Wiatr</small><b>${fmt(num(f?.wind_speed_ms))} m/s · ${fmt(num(f?.wind_direction_deg),0)}°</b></div>
        <div class="fog-diag-cell"><small>Zjawiska</small><b>${esc(weather)}</b></div>
      </div>
      <div class="fog-data-note"><b>Źródło VIS dla Fog Engine:</b> ${esc(f?.visibility_source||'—')} · ${esc(fmtM(num(f?.visibility_m)))}. SYNOP ma pierwszeństwo dla widzialności, ponieważ METAR przy dobrej widzialności raportuje wartość graniczną 9999/CAVOK zamiast dokładnej wartości powyżej około 10 km.</div>
      <div id="epirModelVerification">${verificationHtml()}</div>
    </details>`;
  }

  function installPanel(){
    const fog=document.getElementById('fogEngine');if(!fog)return false;
    fog.querySelector('.fog-observe')?.remove();
    document.getElementById('epirObservationPanel')?.remove();
    const diag=fog.querySelector('.fog-diag');
    if(diag)diag.insertAdjacentHTML('afterend',observationPanelHtml());
    else fog.insertAdjacentHTML('beforeend',observationPanelHtml());
    return true;
  }

  function refreshVerification(){
    const el=document.getElementById('epirModelVerification');
    if(el)el.innerHTML=verificationHtml();
  }

  async function bootstrap(){
    setVersion();
    try{
      [latestData,recentData]=await Promise.all([fetchJson(LATEST_URL),fetchJson(RECENT_URL)]);
      storeAutomaticObservations(recentData);
    }catch(e){
      console.warn('EPIR automatic observations:',e);
      try{localStorage.removeItem(OBS_KEY);}catch(_){ }
    }
    try{await loadFogEngine();}catch(e){console.error('EPIR Fog Engine load:',e);return;}
    setVersion();
    let tries=0;
    const t=setInterval(()=>{
      setVersion();
      if(installPanel()||++tries>40){clearInterval(t);refreshVerification();}
    },250);
    setInterval(refreshVerification,30*1000);
    setInterval(async()=>{
      try{
        const [l,r]=await Promise.all([fetchJson(LATEST_URL),fetchJson(RECENT_URL)]);
        const old=latestData?.updated_at;
        latestData=l;recentData=r;storeAutomaticObservations(r);
        if(l?.updated_at!==old) location.reload();
      }catch(_){ }
    },5*60*1000);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootstrap,{once:true});else bootstrap();
})();
