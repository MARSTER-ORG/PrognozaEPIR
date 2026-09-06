'use strict';
(() => {
  const APP_VERSION = 'v0.10.23 HTML';
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

  function metarPhenomena(m){
    const wx=`${m?.weather||''} ${m?.raw||''}`.toUpperCase();
    const has = code => new RegExp(`(^|\\s)${code}(?=\\s|$|=)`).test(wx);
    return {
      shallowFog:has('MIFG'),
      freezingFog:has('FZFG'),
      fogPatches:has('BCFG'),
      partialFog:has('PRFG'),
      plainFog:has('FG'),
      mist:has('BR')
    };
  }

  function toLocalObservation(o,m=null){
    if(!o) return null;
    const t=Date.parse(o.obs_time||'');
    const T=num(o.temperature_c), Td=num(o.dew_point_c), visM=num(o.visibility_m);
    if(!finite(t)||T===null||Td===null||visM===null||visM<=0) return null;
    const p=metarPhenomena(m);
    const hasMetar=Boolean(m);
    const fullFog=hasMetar
      ?Boolean(p.plainFog||p.freezingFog||p.fogPatches||p.partialFog)
      :Boolean(o.fog&&!o.shallow_fog);
    return {
      t,T,Td,visM,
      created:t,
      automatic:true,
      source:'EPIR_METAR_SYNOP',
      metarObsTime:o.metar_obs_time||null,
      synopObsTime:o.synop_obs_time||null,
      visibilitySource:o.visibility_source||null,
      fog:fullFog,
      mist:hasMetar?p.mist:Boolean(o.mist),
      freezingFog:hasMetar?p.freezingFog:Boolean(o.freezing_fog),
      shallowFog:Boolean(p.shallowFog||o.shallow_fog),
      fogPatches:Boolean(p.fogPatches||o.fog_patches),
      partialFog:Boolean(p.partialFog||o.partial_fog)
    };
  }

  function storeAutomaticObservations(data){
    const byMetarTime=new Map((data?.metar||[]).filter(m=>m?.obs_time).map(m=>[m.obs_time,m]));
    const rows=(data?.observations||[])
      .map(o=>toLocalObservation(o,byMetarTime.get(o?.metar_obs_time)||null))
      .filter(Boolean).sort((a,b)=>a.t-b.t).slice(-MAX_OBS);
    try{
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

  function boolText(v){
    return v===true?'TAK':v===false?'NIE':'—';
  }

  function cell(label,value,sub=''){
    return `<div class="fog-diag-cell"><small>${esc(label)}</small><b>${esc(value)}</b>${sub?`<small>${esc(sub)}</small>`:''}</div>`;
  }

  function cloudText(m){
    const c=Array.isArray(m?.clouds)?m.clouds:[];
    if(!c.length)return 'brak warstw / NSC';
    return c.map(x=>`${x.cover||'—'} ${finite(num(x.base_ft_agl))?Math.round(num(x.base_ft_agl))+' ft':'—'} / ${finite(num(x.base_m_agl))?Math.round(num(x.base_m_agl))+' m':'—'}`).join(' · ');
  }

  function metarWeatherText(m){
    if(!m)return '—';
    const p=metarPhenomena(m);
    const a=[
      p.shallowFog?'MIFG':null,
      p.freezingFog?'FZFG':null,
      p.fogPatches?'BCFG':null,
      p.partialFog?'PRFG':null,
      p.plainFog?'FG':null,
      p.mist?'BR':null,
      m.weather||null
    ].filter(Boolean);
    return [...new Set(a)].join(' / ')||'brak zjawiska';
  }

  function rawNote(title,raw){
    return `<div class="fog-data-note"><b>${esc(title)}:</b> <span style="font-family:monospace;word-break:break-word">${esc(raw||'—')}</span></div>`;
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

  function metarGridHtml(m){
    if(!m)return '<div class="fog-data-note"><b>METAR EPIR:</b> brak aktualnej depeszy.</div>';
    const gust=num(m.wind_gust_ms);
    const visFlags=`raport ${m.visibility_report||'—'}${m.visibility_lower_bound?' · dolna granica':''}${m.visibility_upper_bound?' · górna granica':''}`;
    return `
      <div class="fog-data-note"><b>METAR EPIR — wszystkie dostępne parametry</b></div>
      <div class="fog-diag-grid">
        ${cell('Stacja',m.station||'EPIR',m.source||'—')}
        ${cell('Czas obserwacji',localTime(m.obs_time),`wiek ${ageText(m.obs_time)}`)}
        ${cell('Temperatura',`${fmt(num(m.temperature_c))} °C`)}
        ${cell('Punkt rosy',`${fmt(num(m.dew_point_c))} °C`)}
        ${cell('Wilgotność RH',`${fmt(num(m.relative_humidity_pct),0)}%`)}
        ${cell('Widzialność',metarVisText(m),visFlags)}
        ${cell('Kierunek wiatru',finite(num(m.wind_direction_deg))?`${fmt(num(m.wind_direction_deg),0)}°`:'VRB / —')}
        ${cell('Prędkość wiatru',`${fmt(num(m.wind_speed_ms),2)} m/s`)}
        ${cell('Porywy',gust===null?'—':`${fmt(gust,2)} m/s`)}
        ${cell('QNH',`${fmt(num(m.pressure_hpa),0)} hPa`)}
        ${cell('Zjawiska',metarWeatherText(m))}
        ${cell('Mgła FG',boolText(m.fog))}
        ${cell('Zamglenie BR',boolText(m.mist))}
        ${cell('Mgła marznąca FZFG',boolText(m.freezing_fog))}
        ${cell('Ceiling BKN/OVC/VV',fmtM(num(m.ceiling_m_agl)))}
        ${cell('Warstwy chmur',cloudText(m))}
      </div>
      ${rawNote('Surowy METAR',m.raw)}`;
  }

  function synopGridHtml(s){
    if(!s)return '<div class="fog-data-note"><b>SYNOP 12342:</b> brak aktualnej depeszy.</div>';
    const vis=num(s.visibility_m);
    const visText=vis===null?'—':`${s.visibility_lower_bound?'≥':''}${s.visibility_upper_bound?'≤':''}${Math.round(vis)} m`;
    const visSub=`VV ${s.visibility_code_vv||'—'} · ${s.visibility_report||'—'}`;
    return `
      <div class="fog-data-note"><b>SYNOP 12342 — wszystkie dostępne parametry</b></div>
      <div class="fog-diag-grid">
        ${cell('Stacja WMO',s.station||'12342',s.source||'—')}
        ${cell('WIGOS',s.wigos||'—')}
        ${cell('Czas obserwacji',localTime(s.obs_time),`wiek ${ageText(s.obs_time)}`)}
        ${cell('Temperatura',`${fmt(num(s.temperature_c))} °C`)}
        ${cell('Punkt rosy',`${fmt(num(s.dew_point_c))} °C`)}
        ${cell('Wilgotność RH',`${fmt(num(s.relative_humidity_pct),0)}%`)}
        ${cell('Widzialność',visText,visSub)}
        ${cell('Dolna granica VIS',boolText(s.visibility_lower_bound))}
        ${cell('Górna granica VIS',boolText(s.visibility_upper_bound))}
        ${cell('Kierunek wiatru',finite(num(s.wind_direction_deg))?`${fmt(num(s.wind_direction_deg),0)}°`:'—')}
        ${cell('Prędkość wiatru',`${fmt(num(s.wind_speed_ms),2)} m/s`)}
        ${cell('Ciśnienie MSLP',`${fmt(num(s.pressure_hpa),1)} hPa`)}
        ${cell('Ciśnienie stacyjne',`${fmt(num(s.station_pressure_hpa),1)} hPa`)}
        ${cell('Pogoda bieżąca ww',s.present_weather_code==null?'—':String(s.present_weather_code),s.present_weather||'—')}
        ${cell('Mgła',boolText(s.fog))}
        ${cell('Zamglenie',boolText(s.mist))}
        ${cell('Mgła marznąca',boolText(s.freezing_fog))}
        ${cell('Podstawa chmur',fmtM(num(s.cloud_base_m_agl)))}
        ${cell('Zachmurzenie ogólne',s.total_cloud_oktas==null?'—':`${s.total_cloud_oktas}/8`)}
      </div>
      ${rawNote('Surowy SYNOP',s.raw)}`;
  }

  function observationPanelHtml(){
    const m=latestData?.metar||null, s=latestData?.synop||null, f=latestData?.fused||null;
    return `<details id="epirObservationPanel" class="fog-diag" open>
      <summary>Obserwacje automatyczne EPIR — METAR + SYNOP 12342</summary>
      ${metarGridHtml(m)}
      ${synopGridHtml(s)}
      <div class="fog-data-note"><b>Dane scalone dla Fog Engine:</b> VIS ${esc(fmtM(num(f?.visibility_m)))} · źródło ${esc(f?.visibility_source||'—')} · T ${fmt(num(f?.temperature_c))}°C · Td ${fmt(num(f?.dew_point_c))}°C · RH ${fmt(num(f?.relative_humidity_pct),0)}% · wiatr ${fmt(num(f?.wind_speed_ms),2)} m/s / ${fmt(num(f?.wind_direction_deg),0)}° · ciśnienie ${fmt(num(f?.pressure_hpa),1)} hPa. SYNOP ma pierwszeństwo dla dokładnej widzialności; METAR 9999/CAVOK jest traktowany jako wartość graniczna ≥10 km.</div>
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
