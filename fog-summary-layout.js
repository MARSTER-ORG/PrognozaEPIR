'use strict';
(() => {
  if(typeof window==='undefined'||typeof document==='undefined')return;
  if(window.__PROGNOZA_EPIR_FOG_VNEXT_BRIDGE__)return;
  window.__PROGNOZA_EPIR_FOG_VNEXT_BRIDGE__=true;

  const HOUR=3600e3;
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const mean=a=>{const q=(a||[]).filter(finite);return q.length?q.reduce((s,v)=>s+v,0)/q.length:null;};
  const fmt=(v,d=1)=>finite(v)?Number(v).toFixed(d):'—';
  const fmt0=v=>finite(v)?String(Math.round(v)):'—';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
  const parseUtc=s=>Date.parse(String(s||'').endsWith('Z')?s:String(s||'')+'Z');
  let iconRows=[],ecmwfRows=[],loading=null,lastAppliedSignature='';

  function loadPhysics(){
    if(window.PrognozaEPIRFogPhysicsVNext)return Promise.resolve(window.PrognozaEPIRFogPhysicsVNext);
    return new Promise((resolve,reject)=>{
      const old=document.querySelector('script[data-fog-physics-vnext="1"]');
      if(old){old.addEventListener('load',()=>resolve(window.PrognozaEPIRFogPhysicsVNext),{once:true});setTimeout(()=>window.PrognozaEPIRFogPhysicsVNext&&resolve(window.PrognozaEPIRFogPhysicsVNext),50);return;}
      const s=document.createElement('script');s.src='fog-physics-vnext.js?v=20260915-1';s.dataset.fogPhysicsVnext='1';
      s.onload=()=>window.PrognozaEPIRFogPhysicsVNext?resolve(window.PrognozaEPIRFogPhysicsVNext):reject(new Error('Fog physics vNext API missing'));
      s.onerror=()=>reject(new Error('fog-physics-vnext.js unavailable'));document.head.appendChild(s);
    });
  }
  async function fetchJson(url){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
    try{const r=await fetch(url,{cache:'no-store',signal:ctl.signal});const j=await r.json().catch(()=>null);if(!r.ok||!j)throw new Error(j?.reason||j?.message||('HTTP '+r.status));return j;}finally{clearTimeout(timer);}
  }
  function apiUrl(model,vars){
    const p=window.PLACE||{lat:52.7989,lon:18.2639};
    const q=new URLSearchParams({latitude:String(p.lat),longitude:String(p.lon),hourly:vars.join(','),models:model,timezone:'UTC',forecast_hours:'60',past_hours:'6',wind_speed_unit:'ms'});
    return 'https://api.open-meteo.com/v1/forecast?'+q;
  }
  function rowsFrom(j,kind){
    const h=j?.hourly;if(!Array.isArray(h?.time))return[];
    return h.time.map((s,i)=>{
      const row={t:parseUtc(s)};
      if(kind==='icon'){
        row.soil01=num(h.soil_moisture_0_to_1cm?.[i]);row.soil13=num(h.soil_moisture_1_to_3cm?.[i]);
        row.soilT0=num(h.soil_temperature_0cm?.[i]);row.soilT6=num(h.soil_temperature_6cm?.[i]);row.Ts=num(h.surface_temperature?.[i]);
      }else{
        row.pbl=num(h.boundary_layer_height?.[i]);row.soil07=num(h.soil_moisture_0_to_7cm?.[i]);
        row.soilT07=num(h.soil_temperature_0_7cm?.[i]??h.soil_temperature_0_to_7cm?.[i]);row.Ts=num(h.surface_temperature?.[i]);row.T2=num(h.temperature_2m?.[i]);row.isDay=num(h.is_day?.[i]);
      }
      return row;
    }).filter(x=>finite(x.t)).sort((a,b)=>a.t-b.t);
  }
  async function fetchIcon(){
    const full=['soil_moisture_0_to_1cm','soil_moisture_1_to_3cm','soil_temperature_0cm','soil_temperature_6cm','surface_temperature'];
    try{return rowsFrom(await fetchJson(apiUrl('icon_d2',full)),'icon');}
    catch(_){return rowsFrom(await fetchJson(apiUrl('icon_d2',['soil_moisture_0_to_1cm','soil_moisture_1_to_3cm'])),'icon');}
  }
  async function fetchEcmwf(){
    const full=['boundary_layer_height','soil_moisture_0_to_7cm','soil_temperature_0_7cm','surface_temperature','temperature_2m','is_day'];
    try{return rowsFrom(await fetchJson(apiUrl('ecmwf_ifs',full)),'ecmwf');}
    catch(_){return rowsFrom(await fetchJson(apiUrl('ecmwf_ifs',['boundary_layer_height','surface_temperature','temperature_2m','is_day'])),'ecmwf');}
  }
  async function ensurePhysicalData(){
    if(loading)return loading;
    loading=(async()=>{
      const [a,b]=await Promise.allSettled([fetchIcon(),fetchEcmwf()]);
      iconRows=a.status==='fulfilled'?a.value:[];ecmwfRows=b.status==='fulfilled'?b.value:[];
      window.PrognozaEPIRFogVNextSources={icon:iconRows.length>0,ecmwf:ecmwfRows.length>0,updated:Date.now(),iconError:a.status==='rejected'?String(a.reason?.message||a.reason):null,ecmwfError:b.status==='rejected'?String(b.reason?.message||b.reason):null};
      return window.PrognozaEPIRFogVNextSources;
    })().finally(()=>{loading=null;});
    return loading;
  }
  function nearest(rows,t,max=50*60e3){let best=null,bd=Infinity;for(const r of rows||[]){const d=Math.abs(r.t-t);if(d<bd){bd=d;best=r;}}return bd<=max?best:null;}
  function modelMean(hour,key){return mean((hour?.models||[]).map(m=>num(m?.[key])));}
  function modelComponentMean(hour,key){return mean((hour?.models||[]).map(m=>num(m?.components?.[key])));}
  function legacyAt(series,t){return nearest(series,t,40*60e3);}
  function surfaceAt(t,hour){const e=nearest(ecmwfRows,t),i=nearest(iconRows,t);return num(e?.Ts)??modelMean(hour,'Tskin')??num(i?.Ts);}
  function diff(a,b){return finite(a)&&finite(b)?a-b:null;}
  function inputFor(series,hour){
    const t=hour.t,e=nearest(ecmwfRows,t),i=nearest(iconRows,t),e1=nearest(ecmwfRows,t-HOUR),e3=nearest(ecmwfRows,t-3*HOUR);
    const h1=legacyAt(series,t-HOUR),h3=legacyAt(series,t-3*HOUR);
    const T=modelMean(hour,'T')??num(hour.T),Td=modelMean(hour,'Td'),RH=modelMean(hour,'RH'),WS=modelMean(hour,'WS');
    const T1=h1?(modelMean(h1,'T')??num(h1.T)):null,T3=h3?(modelMean(h3,'T')??num(h3.T)):null,Td3=h3?modelMean(h3,'Td'):null,RH3=h3?modelMean(h3,'RH'):null;
    const Ts=surfaceAt(t,hour),Ts1=h1?surfaceAt(t-HOUR,h1):null,Ts3=h3?surfaceAt(t-3*HOUR,h3):null;
    const sc=diff(T,Ts),sc1=diff(T1,Ts1),sc3=diff(T3,Ts3),cbh=modelMean(hour,'CBH'),cbh3=h3?modelMean(h3,'CBH'):null;
    const dmi=(hour.models||[]).find(m=>m?.id==='dmi_harmonie_arome_europe');
    return {
      t:T,td:Td,rh:RH,ws:WS,visibility:num(hour.vis),observedFog:/^(FG|FZFG)$/i.test(String(hour.obsPhenomenon||'')),
      soilIcon01:num(i?.soil01),soilIcon13:num(i?.soil13),soilEcmwf07:num(e?.soil07),precip12:modelMean(hour,'p12'),
      pbl:num(e?.pbl),deltaPbl1:diff(num(e?.pbl),num(e1?.pbl)),deltaPbl3:diff(num(e?.pbl),num(e3?.pbl)),
      tsurface:Ts,deltaSurfaceCooling1:diff(sc,sc1),deltaSurfaceCooling3:diff(sc,sc3),deltaTsurface3:diff(Ts,Ts3),
      deltaSpread3:finite(T)&&finite(Td)&&finite(T3)&&finite(Td3)?(T-Td)-(T3-Td3):null,deltaRh3:diff(RH,RH3),
      inversion:modelMean(hour,'inv200'),shear:null,isDay:num(e?.isDay),shortwave:modelMean(hour,'SW'),cloudCover:modelMean(hour,'TCC'),lowCloud:modelMean(hour,'LOW'),
      cloud2m:num(dmi?.directFog),cbh,cbhDrop3:finite(cbh)&&finite(cbh3)?cbh3-cbh:null,precip:modelMean(hour,'RR'),verticalRh:modelMean(hour,'rhLow'),
      moistAdvection:modelComponentMean(hour,'SMADV'),surfaceContrast:modelComponentMean(hour,'SCOLD'),soilTemperature0:num(i?.soilT0),soilTemperature6:num(i?.soilT6),soilTemperatureEcmwf07:num(e?.soilT07)
    };
  }
  function enrichSeries(Physics){
    const series=window.PrognozaEPIRFogSeries;if(!Array.isArray(series)||!series.length)return false;
    const sig=`${series.length}:${series[0]?.t}:${series.at(-1)?.t}:${iconRows.length}:${ecmwfRows.length}`;
    if(sig===lastAppliedSignature&&series.every(x=>x?.vnext))return true;
    for(const h of series){if(!finite(h?.t))continue;const input=inputFor(series,h),enhanced=Physics.enhanceLegacyHour(h,input);Object.assign(h,enhanced,{vnextInput:{soilTemperature0:input.soilTemperature0,soilTemperature6:input.soilTemperature6,soilTemperatureEcmwf07:input.soilTemperatureEcmwf07}});}
    lastAppliedSignature=sig;window.PrognozaEPIRFogVNextSeries=series;window.dispatchEvent(new CustomEvent('prognozaepir:fog-vnext-updated'));renderDiagnostics();return true;
  }
  function cell(k,v,sub=''){return `<div class="fog-diag-cell"><small>${esc(k)}</small><b>${esc(v)}</b>${sub?`<small>${esc(sub)}</small>`:''}</div>`;}
  function currentHour(){const s=window.PrognozaEPIRFogSeries||[];if(!s.length)return null;const now=Date.now();let best=s[0],bd=Infinity;for(const x of s){const d=Math.abs(x.t-now);if(d<bd){bd=d;best=x;}}return best;}
  function renderDiagnostics(){
    const h=currentHour(),v=h?.vnext;if(!h||!v)return;const base=document.getElementById('fogDiag')?.closest('details');if(!base)return;
    let details=document.getElementById('fogVNextDiagnostics');if(!details){details=document.createElement('details');details.id='fogVNextDiagnostics';details.className='fog-diag';base.insertAdjacentElement('afterend',details);}
    const soilRaw=finite(v.soilMoistureRaw)?(v.soilMoistureSource==='precip proxy'?`${fmt(v.soilMoistureRaw,2)} mm/12h`:`${fmt(v.soilMoistureRaw,3)} m³/m³`):'—',temps=h.vnextInput||{};
    details.innerHTML=`<summary>Fog Engine vNext — fizyka (SHADOW, nie steruje TAF)</summary><div class="fog-data-note"><b>Tryb:</b> shadow. Wynik operacyjny legacy pozostaje bez zmian do forecast→truth backtestu nowych pól.</div><div class="fog-diag-grid">
      ${cell('Soil moisture',soilRaw,`źródło: ${v.soilMoistureSource}`)}${cell('SSOIL',fmt0(h.SSOIL)+'/100')}${cell('PBL',finite(v.PBL)?fmt0(v.PBL)+' m':'—')}${cell('ΔPBL 1 h',finite(v.deltaPbl1)?(v.deltaPbl1>=0?'+':'')+fmt0(v.deltaPbl1)+' m':'—')}${cell('ΔPBL 3 h',finite(v.deltaPbl3)?(v.deltaPbl3>=0?'+':'')+fmt0(v.deltaPbl3)+' m':'—')}${cell('SPBL',fmt0(h.SPBL)+'/100')}
      ${cell('T2m − Tsurface',finite(v.surfaceCooling)?fmt(v.surfaceCooling,1)+' °C':'—')}${cell('Trend Tsurface 3 h',finite(v.deltaTsurface3)?(v.deltaTsurface3>=0?'+':'')+fmt(v.deltaTsurface3,1)+' °C':'—')}${cell('SSFC_COOL',fmt0(h.SSFC_COOL)+'/100')}${cell('Soil T 0 cm',finite(temps.soilTemperature0)?fmt(temps.soilTemperature0,1)+' °C':'—')}${cell('Soil T 6 cm',finite(temps.soilTemperature6)?fmt(temps.soilTemperature6,1)+' °C':'—')}
      ${cell('Saturation family',finite(v.SATURATION)?fmt0(v.SATURATION*100)+'/100':'—')}${cell('Mixing/stability',finite(v.MIXING)?fmt0(v.MIXING*100)+'/100':'—')}${cell('RAD vNext',finite(h.RAD_vNextShadow)?fmt0(h.RAD_vNextShadow)+'/100':'—')}${cell('ADV vNext',finite(h.ADV_vNextShadow)?fmt0(h.ADV_vNextShadow)+'/100':'—')}${cell('CBL vNext',finite(h.CBL_vNextShadow)?fmt0(h.CBL_vNextShadow)+'/100':'—')}${cell('PCP vNext',finite(h.PCP_vNextShadow)?fmt0(h.PCP_vNextShadow)+'/100':'—')}
      ${cell('Faza',v.phase||'—')}${cell('Dissipation',finite(v.dissipationRisk)?fmt0(v.dissipationRisk*100)+'/100':'—')}${cell('Fog score legacy',finite(h.score)?fmt0(h.score)+'/100':'—')}${cell('Fog score vNext shadow',finite(h.fogScoreVNextShadow)?fmt0(h.fogScoreVNextShadow)+'/100':'—')}${cell('Data quality vNext',fmt0((v.dataQuality||0)*100)+'%')}${cell('Braki',v.missing?.length?v.missing.join(', '):'brak')}${cell('Fallbacki',v.fallbacks?.length?v.fallbacks.join(', '):'brak')}
    </div>`;
  }
  async function refresh(){try{const Physics=await loadPhysics();await ensurePhysicalData();enrichSeries(Physics);}catch(e){window.PrognozaEPIRFogVNextError=String(e?.message||e);}}
  window.addEventListener('prognozaepir:fog-series-updated',refresh);window.addEventListener('prognozaepir:fog-vnext-updated',renderDiagnostics);setTimeout(refresh,200);
  setInterval(()=>{ensurePhysicalData().then(()=>loadPhysics()).then(enrichSeries).catch(()=>{});},30*60*1000);
})();
