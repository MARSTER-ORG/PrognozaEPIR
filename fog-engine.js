'use strict';
(() => {
  if (typeof PLACE === 'undefined') return;

  const APP_VERSION = 'v0.10.19 HTML';
  const ENGINE_VERSION = 'EPIR FOG ENGINE v1.0';
  const HOUR = 3600e3;
  const OBS_KEY = 'prognozaepir-fog-observations-v2';
  const MAX_OBS = 60;
  const DMI_MODEL = 'dmi_harmonie_arome_europe';
  const CORE_SUPPLEMENT_MODELS = new Set([
    'ecmwf_ifs','ecmwf_aifs025_single','ncep_gfs_global',
    'icon_d2','icon_eu','icon_global','chmi_aladin_central_europe_2km',
    'meteofrance_arpege_europe'
  ]);
  const DMI_VARS = [
    'temperature_2m','relative_humidity_2m','dew_point_2m','visibility',
    'cloud_cover_2m','cloud_cover','cloud_cover_low','cloud_cover_mid','cloud_cover_high',
    'cloud_base','wind_speed_10m','wind_direction_10m','wind_gusts_10m',
    'precipitation','shortwave_radiation','is_day','surface_temperature',
    'temperature_50m','temperature_100m','temperature_150m','temperature_250m',
    'wind_speed_100m','wind_speed_250m'
  ];
  const SUPPLEMENT_VARS = [
    'temperature_1000hPa','temperature_925hPa','temperature_850hPa','wind_speed_850hPa'
  ];

  let dmiRows = [];
  let supplements = new Map();
  let fogSeries = [];
  let engineError = '';
  let lastCoreSize = -1;
  let fetchBusy = false;

  const clip = (v,a,b) => Math.max(a,Math.min(b,v));
  const finite = Number.isFinite;
  const n = v => finite(Number(v)) ? Number(v) : null;
  const mean = a => { const x=a.filter(finite); return x.length?x.reduce((s,v)=>s+v,0)/x.length:null; };
  const sum = a => a.filter(finite).reduce((s,v)=>s+v,0);
  const fmt0 = v => finite(v)?String(Math.round(v)):'—';
  const fmt1 = v => finite(v)?Number(v).toFixed(1):'—';
  const fmtM = v => finite(v)?Math.max(0,Math.round(v))+' m':'—';

  function interp(x,a,b,ya,yb){
    if(!finite(x)) return null;
    if(x<=a) return ya;
    if(x>=b) return yb;
    return ya+(yb-ya)*(x-a)/(b-a);
  }
  function pw(v, pts, below=null, above=null){
    if(!finite(v)) return null;
    if(v<=pts[0][0]) return below===null?pts[0][1]:below;
    for(let i=1;i<pts.length;i++){
      if(v<=pts[i][0]) return interp(v,pts[i-1][0],pts[i][0],pts[i-1][1],pts[i][1]);
    }
    return above===null?pts[pts.length-1][1]:above;
  }
  function weightedAvailable(items){
    let s=0,w=0,full=0;
    for(const x of items){ full+=x.w||0; if(finite(x.v)){s+=x.v*x.w;w+=x.w;} }
    return {v:w?s/w:null, coverage:full?clip(w/full,0,1):0, used:w};
  }
  function stddev(values){
    const a=values.filter(finite); if(a.length<2)return null;
    const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length);
  }
  function parseUtc(s){ return Date.parse(String(s).endsWith('Z')?s:s+'Z'); }
  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }
  function localDateTime(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleString('pl-PL');}
  }
  function rhFromTempDew(T,Td){
    if(!finite(T)||!finite(Td))return null;
    const a=17.625,b=243.04;
    return clip(100*Math.exp((a*Td)/(b+Td)-(a*T)/(b+T)),0,100);
  }
  function scoreClass(s){
    if(!finite(s))return 'brak danych';
    if(s>=90)return 'skrajnie wysokie';
    if(s>=75)return 'bardzo wysokie';
    if(s>=60)return 'wysokie';
    if(s>=40)return 'umiarkowane';
    if(s>=20)return 'małe';
    return 'bardzo małe';
  }
  function confidenceLabel(c){
    if(!finite(c))return 'brak danych';
    if(c>=.80)return 'bardzo wysoka';
    if(c>=.65)return 'wysoka';
    if(c>=.45)return 'średnia';
    if(c>=.25)return 'niska';
    return 'bardzo niska';
  }
  function riskCss(s){
    return s>=75?'fog-risk-vhigh':s>=60?'fog-risk-high':s>=40?'fog-risk-mid':'fog-risk-low';
  }
  function mechanismName(k){
    return ({RAD:'radiacyjna',ADV:'adwekcyjna',CBL:'obniżanie podstawy Stratusa',PCP:'opadowa'})[k]||'—';
  }

  // --- Normalizacje EPIR v1.0 ---
  function SD(D){
    if(!finite(D))return null;
    if(D<=.3)return 1;
    if(D>3)return 0;
    return pw(D,[[.3,1],[.7,.90],[1.2,.75],[2,.50],[3,.20]]);
  }
  function SRH(RH){
    if(!finite(RH))return null;
    if(RH>=98)return 1;
    if(RH<85)return 0;
    return pw(RH,[[85,.15],[90,.40],[93,.70],[96,.90],[98,1]],0,1);
  }
  function SFSI(fsi){
    return finite(fsi)?clip((55-fsi)/24,0,1):null;
  }
  function SW_RAD(u){
    if(!finite(u))return null;
    if(u<.3)return .45;
    if(u>6)return 0;
    return pw(u,[[.3,.80],[1,1],[3,1],[4,.70],[5,.30],[6,.10]],.45,0);
  }
  function SCOOL(dt3){
    if(!finite(dt3))return null;
    if(dt3<=-1.5)return 1;
    if(dt3>=0)return 0;
    return pw(dt3,[[-1.5,1],[-.8,.80],[-.3,.50],[0,.20]],1,0);
  }
  function SSAT_TREND(dd){
    if(!finite(dd))return null;
    if(dd<=-2)return 1;
    if(dd>=0)return 0;
    return pw(dd,[[-2,1],[-1,.80],[-.5,.55],[0,.25]],1,0);
  }
  function SINV(inv){
    if(!finite(inv))return null;
    if(inv>=2)return 1;
    if(inv<0)return 0;
    return pw(inv,[[0,.30],[.5,.60],[1,.85],[2,1]],0,1);
  }
  function SVERT_RH(rh){
    if(!finite(rh))return null;
    if(rh>=97)return 1;
    if(rh<88)return 0;
    return pw(rh,[[88,.30],[92,.60],[95,.85],[97,1]],0,1);
  }
  function SMOIST_FROM_PRECIP(p12){
    if(!finite(p12))return null;
    if(p12>=2)return 1;
    return pw(p12,[[0,.35],[.2,.65],[1,.85],[2,1]],.35,1);
  }
  function SW_ADV(u){
    if(!finite(u))return null;
    if(u<.5)return .20;
    if(u>12)return .15;
    return pw(u,[[.5,.60],[2,1],[6,1],[9,.75],[12,.40]],.20,.15);
  }
  function SCOLD(v){
    if(!finite(v))return null;
    if(v>=1)return 1;
    if(v<-1)return 0;
    return pw(v,[[-1,.30],[0,.60],[.5,.85],[1,1]],0,1);
  }
  function SMADV(dtd3){
    if(!finite(dtd3))return null;
    if(dtd3>=2)return 1;
    if(dtd3<0)return 0;
    return pw(dtd3,[[0,.30],[.5,.55],[1,.80],[2,1]],0,1);
  }
  function SCBH_TREND(drop5eq){
    if(!finite(drop5eq)||drop5eq<=0)return 0;
    if(drop5eq>=600)return 1;
    return pw(drop5eq,[[50,.25],[200,.55],[400,.80],[600,1]],0,1);
  }
  function SCBH_LOW(cbh){
    if(!finite(cbh))return null;
    if(cbh<=50)return 1;
    if(cbh>800)return 0;
    return pw(cbh,[[50,1],[100,.90],[200,.70],[400,.40],[800,.15]],1,0);
  }
  function SPRECIP(rr){
    if(!finite(rr))return null;
    if(rr<=0)return 0;
    if(rr<.1)return .20;
    if(rr<=.5)return interp(rr,.1,.5,.70,1);
    if(rr<=2)return 1;
    return .80;
  }
  function SVIS(vis){
    if(!finite(vis))return null;
    if(vis>5000)return 0;
    if(vis<200)return 1;
    if(vis<=500)return interp(vis,200,500,1,.95);
    if(vis<=1000)return interp(vis,500,1000,.95,.80);
    if(vis<=1500)return interp(vis,1000,1500,.80,.55);
    if(vis<=3000)return interp(vis,1500,3000,.55,.35);
    return interp(vis,3000,5000,.35,.15);
  }

  function addStyles(){
    if(document.getElementById('fogEngineStyle'))return;
    const s=document.createElement('style');s.id='fogEngineStyle';
    s.textContent=`
      .fog-engine{margin-top:6px;border:1px solid var(--border);background:var(--surface);border-radius:4px;padding:9px 10px;font-size:10px;line-height:1.35}
      .fog-head{display:flex;justify-content:space-between;gap:8px;align-items:center;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:7px}
      .fog-head b{color:var(--blueText);font-size:12px}.fog-head span{color:var(--muted);font-size:9px;text-align:right}
      .fog-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin-bottom:7px}
      .fog-card{background:var(--soft);border-left:3px solid var(--blueText);padding:6px 7px;min-width:0}
      .fog-card small{display:block;color:var(--muted);font-size:8px}.fog-card strong{display:block;font-size:12px;margin-top:1px}.fog-card em{display:block;color:var(--muted);font-style:normal;font-size:8px;margin-top:1px}
      .fog-risk-low{border-left-color:#6f8b95}.fog-risk-mid{border-left-color:#d49a28}.fog-risk-high{border-left-color:#d86c2f}.fog-risk-vhigh{border-left-color:#d0503f}
      .fog-strip{overflow-x:auto;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:6px 0;padding:5px 0}
      .fog-hours{display:flex;min-width:max-content;gap:4px}.fog-hour{width:96px;background:var(--soft);border:1px solid var(--border);border-radius:4px;padding:4px;text-align:center}
      .fog-hour b{display:block;font-size:9px}.fog-hour .p{font-size:11px;font-weight:700;margin:2px 0}.fog-hour small{display:block;color:var(--muted);font-size:8px}
      .fog-thresholds,.fog-data-note{margin:6px 0;padding:5px 7px;background:var(--soft);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:8.5px}
      .fog-thresholds b,.fog-data-note b{color:var(--ink)}
      .fog-diag{margin-top:7px}.fog-diag summary,.fog-observe summary{cursor:pointer;color:var(--blueText);font-weight:700}
      .fog-diag-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-top:5px}.fog-diag-cell{background:var(--soft);padding:4px 5px;border-radius:3px}.fog-diag-cell small{display:block;color:var(--muted);font-size:8px}.fog-diag-cell b{font-size:10px}
      .fog-observe{margin-top:7px}.fog-form{display:grid;grid-template-columns:1.4fr repeat(3,1fr) auto;gap:5px;margin-top:6px;align-items:end}
      .fog-form label{color:var(--muted);font-size:8px}.fog-form input{width:100%;margin-top:2px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:4px;padding:5px;font-size:10px}
      .fog-form button{border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:5px;padding:6px 8px;font-size:9px}
      .fog-note,.fog-obs-list{color:var(--muted);font-size:8px;margin-top:5px}.fog-error{color:var(--errorText);font-size:9px}
      @media(max-width:700px){.fog-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.fog-diag-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fog-form{grid-template-columns:repeat(2,minmax(0,1fr))}.fog-hour{width:88px}.fog-engine{padding:7px}}
    `;
    document.head.appendChild(s);
  }

  function ensurePanel(){
    addStyles();
    let el=document.getElementById('fogEngine');
    if(el)return el;
    el=document.createElement('section');el.id='fogEngine';el.className='fog-engine';
    el.innerHTML=`
      <div class="fog-head"><b>${ENGINE_VERSION}</b><span id="fogSource">physics + NWP ensemble + obserwacje</span></div>
      <div id="fogSummary" class="fog-summary"><div class="fog-card"><small>Status</small><strong>Ładowanie…</strong></div></div>
      <div class="fog-thresholds"><b>Skala ryzyka v1:</b> 0–19 bardzo małe · 20–39 małe · 40–59 umiarkowane · 60–74 wysokie · 75–89 bardzo wysokie · 90–100 skrajnie wysokie. <b>Wynik /100 jest score ryzyka, nie skalibrowanym procentem P(FG).</b></div>
      <div id="fogDataNote" class="fog-data-note">Brak danych nie jest traktowany jako zero — składniki niedostępne są usuwane, a wagi renormalizowane.</div>
      <div id="fogStrip" class="fog-strip" hidden><div id="fogHours" class="fog-hours"></div></div>
      <details class="fog-diag"><summary>Diagnostyka EPIR v1</summary><div id="fogDiag" class="fog-diag-grid"></div></details>
      <details class="fog-observe"><summary>Dodaj rzeczywistą obserwację</summary>
        <div class="fog-form">
          <label>Godzina<input id="fogObsTime" type="datetime-local"></label>
          <label>Temperatura °C<input id="fogObsT" type="number" step="0.1" inputmode="decimal"></label>
          <label>Punkt rosy °C<input id="fogObsTd" type="number" step="0.1" inputmode="decimal"></label>
          <label>Widzialność m<input id="fogObsVis" type="number" min="20" max="50000" step="50" inputmode="numeric"></label>
          <button id="fogObsSave" type="button">Zapisz</button>
        </div>
        <div id="fogObsList" class="fog-obs-list"></div>
        <div class="fog-note">Obserwacja zasila SOBS i nowcast 0–6 h. Temperatura i punkt rosy służą też do obliczenia RH oraz depresji T−Td. Dane są przechowywane lokalnie w tej przeglądarce.</div>
      </details>`;
    const ref=document.getElementById('sectionInfo');
    if(ref?.parentNode)ref.parentNode.insertBefore(el,ref.nextSibling);else document.querySelector('.app')?.appendChild(el);
    document.getElementById('fogObsSave')?.addEventListener('click',saveObservation);
    setDefaultObsTime();renderObservationList();
    return el;
  }

  function localInputValue(ms){
    const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:PLACE.tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(ms));
    const o={};for(const p of parts)o[p.type]=p.value;
    return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
  }
  function parseLocalInput(v){return v?Date.parse(v):NaN;}
  function setDefaultObsTime(){const x=document.getElementById('fogObsTime');if(x&&!x.value)x.value=localInputValue(Date.now());}
  function getObservations(){
    try{const a=JSON.parse(localStorage.getItem(OBS_KEY)||'[]');return Array.isArray(a)?a.filter(o=>finite(o.t)).slice(-MAX_OBS):[];}catch(_){return[];}
  }
  function putObservations(a){try{localStorage.setItem(OBS_KEY,JSON.stringify(a.slice(-MAX_OBS)));}catch(_) {}}
  function saveObservation(){
    const t=parseLocalInput(document.getElementById('fogObsTime')?.value);
    const T=n(document.getElementById('fogObsT')?.value),Td=n(document.getElementById('fogObsTd')?.value),visM=n(document.getElementById('fogObsVis')?.value);
    if(!finite(t)||T===null||Td===null||visM===null||visM<=0||Td>T+1){alert('Podaj godzinę, temperaturę, punkt rosy oraz widzialność w metrach.');return;}
    const a=getObservations();a.push({t,T,Td,visM,created:Date.now()});putObservations(a);renderObservationList();rebuildEngine();
  }
  function renderObservationList(){
    const el=document.getElementById('fogObsList');if(!el)return;
    const a=getObservations();
    if(!a.length){el.textContent='Brak zapisanych obserwacji.';return;}
    const o=a[a.length-1],rh=rhFromTempDew(o.T,o.Td);
    el.innerHTML=`Ostatnia: <b>${localDateTime(o.t)}</b> · T ${fmt1(o.T)}°C · Td ${fmt1(o.Td)}°C · RH≈${fmt0(rh)}% · VIS ${fmtM(o.visM)} <button id="fogObsClear" type="button">Wyczyść</button>`;
    document.getElementById('fogObsClear')?.addEventListener('click',()=>{putObservations([]);renderObservationList();rebuildEngine();});
  }

  function nearest(arr,t,maxDiff=75*60e3){
    if(!arr?.length)return null;let best=null,bd=Infinity;
    for(const x of arr){const d=Math.abs(x.t-t);if(d<bd){bd=d;best=x;}}
    return bd<=maxDiff?best:null;
  }
  function interpHeight(points,h,key){
    const p=points.filter(x=>finite(x.h)&&finite(x[key])).sort((a,b)=>a.h-b.h);
    if(!p.length)return null;
    if(h<=p[0].h)return p[0][key];
    for(let i=1;i<p.length;i++){
      if(h<=p[i].h){
        const a=p[i-1],b=p[i],q=(h-a.h)/(b.h-a.h||1);
        return a[key]+(b[key]-a[key])*q;
      }
    }
    return p[p.length-1][key];
  }

  async function fetchDmi(){
    const q=new URLSearchParams({
      latitude:String(PLACE.lat),longitude:String(PLACE.lon),hourly:DMI_VARS.join(','),
      models:DMI_MODEL,timezone:'UTC',forecast_hours:'60',past_hours:'6',wind_speed_unit:'ms'
    });
    const r=await fetch('https://api.open-meteo.com/v1/forecast?'+q,{cache:'no-store'});
    const j=await r.json().catch(()=>null);
    if(!r.ok||!j?.hourly?.time)throw new Error(j?.reason||j?.message||('DMI HTTP '+r.status));
    const h=j.hourly;
    dmiRows=(h.time||[]).map((s,i)=>({
      t:parseUtc(s),T:n(h.temperature_2m?.[i]),Td:n(h.dew_point_2m?.[i]),RH:n(h.relative_humidity_2m?.[i]),VIS:n(h.visibility?.[i]),
      fog2m:n(h.cloud_cover_2m?.[i]),TCC:n(h.cloud_cover?.[i]),LOW:n(h.cloud_cover_low?.[i]),MID:n(h.cloud_cover_mid?.[i]),HIGH:n(h.cloud_cover_high?.[i]),
      CBH:n(h.cloud_base?.[i]),WS:n(h.wind_speed_10m?.[i]),WD:n(h.wind_direction_10m?.[i]),G:n(h.wind_gusts_10m?.[i]),RR:n(h.precipitation?.[i]),
      SW:n(h.shortwave_radiation?.[i]),isDay:n(h.is_day?.[i]),Tskin:n(h.surface_temperature?.[i]),
      T50:n(h.temperature_50m?.[i]),T100:n(h.temperature_100m?.[i]),T150:n(h.temperature_150m?.[i]),T250:n(h.temperature_250m?.[i]),
      U100:n(h.wind_speed_100m?.[i]),U250:n(h.wind_speed_250m?.[i])
    })).filter(x=>finite(x.t)).sort((a,b)=>a.t-b.t);
  }

  async function fetchSupplement(modelId){
    if(!CORE_SUPPLEMENT_MODELS.has(modelId))return;
    const q=new URLSearchParams({
      latitude:String(PLACE.lat),longitude:String(PLACE.lon),hourly:SUPPLEMENT_VARS.join(','),
      models:modelId,timezone:'UTC',forecast_hours:'60',past_hours:'6',wind_speed_unit:'ms'
    });
    try{
      const r=await fetch('https://api.open-meteo.com/v1/forecast?'+q,{cache:'no-store'});
      const j=await r.json().catch(()=>null);
      if(!r.ok||!j?.hourly?.time)throw new Error(j?.reason||('HTTP '+r.status));
      const h=j.hourly;
      supplements.set(modelId,(h.time||[]).map((s,i)=>({
        t:parseUtc(s),T1000:n(h.temperature_1000hPa?.[i]),T925:n(h.temperature_925hPa?.[i]),
        T850:n(h.temperature_850hPa?.[i]),U850:n(h.wind_speed_850hPa?.[i])
      })).filter(x=>finite(x.t)));
    }catch(_){supplements.delete(modelId);}
  }

  async function refreshExternal(){
    if(fetchBusy)return;fetchBusy=true;engineError='';
    try{
      await fetchDmi();
      const ids=(typeof MODELS!=='undefined'?MODELS:[]).map(m=>m.id).filter(id=>CORE_SUPPLEMENT_MODELS.has(id));
      await Promise.all(ids.map(fetchSupplement));
    }catch(e){engineError=e?.message||String(e);}
    finally{fetchBusy=false;rebuildEngine();}
  }

  function rawSurface(model,t){
    try{
      const ds=datasets.get(model.id);if(!ds)return null;
      const r=sample(ds,t);if(!r)return null;
      const terrain=finite(ds.elevation)?ds.elevation:90;
      let pr=[];
      try{pr=profile([{row:r,w:1,elevation:terrain}],terrain);}catch(_){}
      const cbh=typeof ceiling==='function'?ceiling(pr):null;
      const low=typeof band==='function'?band(pr,0,2000):null;
      const mid=typeof band==='function'?band(pr,2000,5000):null;
      const high=typeof band==='function'?band(pr,5000,13001):null;
      const p=[];
      p.push({h:2,T:r.temperature_2m,RH:r.relative_humidity_2m});
      const levels=(model.levels||((typeof LEVELS!=='undefined')?LEVELS:[]));
      for(const lev of levels){
        const gh=r['geopotential_height_'+lev+'hPa'],rh=r['relative_humidity_'+lev+'hPa'];
        if(finite(gh))p.push({h:gh-terrain,RH:rh});
      }
      const sup=nearest(supplements.get(model.id)||[],t);
      if(sup){
        const h1000=r['geopotential_height_1000hPa'],h925=r['geopotential_height_925hPa'];
        if(finite(h1000)&&finite(sup.T1000))p.push({h:h1000-terrain,T:sup.T1000});
        if(finite(h925)&&finite(sup.T925))p.push({h:h925-terrain,T:sup.T925});
      }
      const T100=interpHeight(p,100,'T'),T200=interpHeight(p,200,'T'),T300=interpHeight(p,300,'T');
      const RH100=interpHeight(p,100,'RH'),RH200=interpHeight(p,200,'RH'),RH300=interpHeight(p,300,'RH');
      return {
        id:model.id,name:model.name,t,T:r.temperature_2m,Td:r.dew_point_2m,RH:r.relative_humidity_2m,WS:r.wind_speed_10m,WD:r.wind_direction_10m,G:r.wind_gusts_10m,
        RR:r.precipitation,VIS:r.visibility,P:r.pressure_msl,Tskin:null,LOW:low,MID:mid,HIGH:high,TCC:null,CBH:cbh,
        T100,T200,T300,RH100,RH200,RH300,T850:sup?.T850??null,U850:sup?.U850??null,
        directFog:null
      };
    }catch(_){return null;}
  }
  function dmiSurface(t){
    const r=nearest(dmiRows,t);if(!r)return null;
    const pts=[{h:2,T:r.T},{h:50,T:r.T50},{h:100,T:r.T100},{h:150,T:r.T150},{h:250,T:r.T250}];
    return {
      id:DMI_MODEL,name:'DMI HARMONIE-AROME 2 km',t:r.t,T:r.T,Td:r.Td,RH:r.RH,WS:r.WS,WD:r.WD,G:r.G,RR:r.RR,VIS:r.VIS,P:null,Tskin:r.Tskin,
      LOW:r.LOW,MID:r.MID,HIGH:r.HIGH,TCC:r.TCC,CBH:r.CBH,
      T100:r.T100,T200:interpHeight(pts,200,'T'),T300:interpHeight(pts,300,'T'),RH100:null,RH200:null,RH300:null,
      T850:null,U850:null,directFog:r.fog2m
    };
  }
  function modelInput(model,t){return model.id===DMI_MODEL?dmiSurface(t):rawSurface(model,t);}

  function historyInput(model,t,backHours){return modelInput(model,t-backHours*HOUR);}
  function precipSum(model,t,hours){
    let total=0,count=0;
    for(let k=0;k<hours;k++){
      const x=modelInput(model,t-k*HOUR);if(finite(x?.RR)){total+=Math.max(0,x.RR);count++;}
    }
    return count?total:null;
  }

  function calcMechanisms(model,t){
    const x=modelInput(model,t);if(!x)return null;
    const x3=historyInput(model,t,3),x5=historyInput(model,t,5);
    const D=finite(x.T)&&finite(x.Td)?x.T-x.Td:null;
    const D3=finite(x3?.T)&&finite(x3?.Td)?x3.T-x3.Td:null;
    const dt3=finite(x.T)&&finite(x3?.T)?x.T-x3.T:null;
    const dd3=finite(D)&&finite(D3)?D-D3:null;
    const dtd3=finite(x.Td)&&finite(x3?.Td)?x.Td-x3.Td:null;
    const inv200=finite(x.T200)&&finite(x.T)?x.T200-x.T:null;
    const rhLow=mean([x.RH,x.RH100,x.RH200,x.RH300]);
    const rhGrad=finite(x.RH)&&finite(x.RH300)?x.RH-x.RH300:null;
    const cloudShield=(finite(x.MID)?0.6*x.MID/100:0)+(finite(x.HIGH)?0.4*x.HIGH/100:0);
    const sky=(finite(x.MID)||finite(x.HIGH))?clip(1-cloudShield,0,1):null;
    const p12=precipSum(model,t,12);
    const smoist=finite(p12)?SMOIST_FROM_PRECIP(p12):.5;
    const fsi=finite(D)&&finite(x.T850)&&finite(x.U850)?2*D+2*(x.T-x.T850)+x.U850*1.94384:null;
    const drop3=finite(x3?.CBH)&&finite(x.CBH)?x3.CBH-x.CBH:null;
    const drop5=finite(x5?.CBH)&&finite(x.CBH)?x5.CBH-x.CBH:null;
    const drop5eq=finite(drop5)?drop5:(finite(drop3)?drop3*5/3:null);

    const c={
      SD:SD(D),SRH:SRH(x.RH),SFSI:SFSI(fsi),SW_RAD:SW_RAD(x.WS),SCOOL:SCOOL(dt3),SSAT:SSAT_TREND(dd3),
      SINV:SINV(inv200),SVRH:SVERT_RH(rhLow),SSKY:sky,SMOIST:smoist,
      SW_ADV:SW_ADV(x.WS),SCOLD:finite(x.Td)&&finite(x.Tskin)?SCOLD(x.Td-x.Tskin):null,SMADV:SMADV(dtd3),
      SCBH_TREND:SCBH_TREND(drop5eq),SCBH_LOW:SCBH_LOW(x.CBH),LOWC:finite(x.LOW)?clip(x.LOW/100,0,1):null,
      SPRECIP:SPRECIP(x.RR)
    };
    const rad=weightedAvailable([
      {v:c.SD,w:.18},{v:c.SRH,w:.14},{v:c.SW_RAD,w:.12},{v:c.SCOOL,w:.12},{v:c.SSAT,w:.12},
      {v:c.SINV,w:.10},{v:c.SSKY,w:.08},{v:c.SMOIST,w:.07},{v:c.SFSI,w:.07}
    ]);
    const adv=weightedAvailable([
      {v:c.SD,w:.20},{v:c.SRH,w:.16},{v:c.SCOLD,w:.18},{v:c.SMADV,w:.16},{v:c.SW_ADV,w:.12},{v:c.SVRH,w:.10},{v:c.LOWC,w:.08}
    ]);
    const cbl=weightedAvailable([
      {v:c.SCBH_TREND,w:.23},{v:c.SCBH_LOW,w:.18},{v:c.LOWC,w:.17},{v:c.SVRH,w:.15},{v:c.SD,w:.12},{v:c.SRH,w:.08},{v:c.SINV,w:.07}
    ]);
    const pcp=weightedAvailable([
      {v:c.SPRECIP,w:.24},{v:c.SRH,w:.18},{v:c.SD,w:.15},{v:c.SCBH_LOW,w:.14},{v:c.SVRH,w:.12},{v:c.SINV,w:.10},{v:c.LOWC,w:.07}
    ]);
    const mechs=[['RAD',rad.v],['ADV',adv.v],['CBL',cbl.v],['PCP',pcp.v]].filter(z=>finite(z[1])).sort((a,b)=>b[1]-a[1]);
    const phys=mechs.length?(.8*mechs[0][1]+.2*(mechs[1]?.[1]??mechs[0][1])):null;
    const sv=SVIS(x.VIS);
    const modelScore=weightedAvailable([{v:phys,w:.65},{v:sv,w:.35}]).v;
    const coverage=mean([rad.coverage,adv.coverage,cbl.coverage,pcp.coverage,finite(sv)?1:0]);
    return {
      ...x,D,D3,dt3,dd3,dtd3,inv200,rhLow,rhGrad,p12,fsi,
      RAD:finite(rad.v)?rad.v*100:null,ADV:finite(adv.v)?adv.v*100:null,CBL:finite(cbl.v)?cbl.v*100:null,PCP:finite(pcp.v)?pcp.v*100:null,
      PHYS:finite(phys)?phys*100:null,SVIS:finite(sv)?sv*100:null,MODEL:finite(modelScore)?modelScore*100:null,
      mechanism1:mechs[0]?.[0]||null,mechanism2:mechs[1]?.[0]||null,coverage:coverage??0,components:c
    };
  }

  function obsScore(o){
    if(!o)return null;
    const RH=rhFromTempDew(o.T,o.Td),D=o.T-o.Td;
    let s=0;
    if(o.visM<1000)s=.95;
    else if(o.visM<1500)s=.80;
    else if(o.visM<3000)s=.55;
    else if(o.visM<5000)s=.35;
    if(finite(RH)&&RH>=97&&D<=.5)s=Math.max(s,.40);
    return s*100;
  }
  function recentObservation(){
    const now=Date.now()+10*60e3;
    return getObservations().filter(o=>o.t<=now&&now-o.t<=6*HOUR).sort((a,b)=>b.t-a.t)[0]||null;
  }
  function observationTrend(){
    const a=getObservations().filter(o=>Date.now()-o.t<=8*HOUR).sort((x,y)=>x.t-y.t);
    if(a.length<2)return null;
    const p=a[a.length-2],q=a[a.length-1];
    const dp=(q.T-q.Td)-(p.T-p.Td),dv=q.visM-p.visM;
    let s=50;
    if(dp<0)s+=clip(-dp*18,0,30);else s-=clip(dp*12,0,20);
    if(dv<0)s+=clip((-dv/1000)*15,0,25);else s-=clip((dv/1000)*10,0,20);
    return clip(s,0,100);
  }
  function obsForLead(t){
    const o=recentObservation();if(!o)return null;
    const lead=Math.max(0,t-Date.now())/HOUR;
    if(lead>6)return null;
    const freshness=Math.exp(-Math.max(0,Date.now()-o.t)/(3*HOUR));
    return {score:obsScore(o)*freshness,raw:obsScore(o),obs:o,trend:observationTrend()};
  }

  function modelDefinitions(){
    const base=(typeof MODELS!=='undefined'?MODELS:[]).map(m=>({id:m.id,name:m.name}));
    return [{id:DMI_MODEL,name:'DMI HARMONIE-AROME 2 km'},...base];
  }
  function typeFromMechanisms(models){
    const keys=['RAD','ADV','CBL','PCP'],v={};
    for(const k of keys)v[k]=mean(models.map(m=>m[k]));
    const ranked=keys.map(k=>[k,v[k]]).filter(x=>finite(x[1])).sort((a,b)=>b[1]-a[1]);
    if(!ranked.length)return {text:'—',primary:null,secondary:null,values:v};
    const [a,b]=ranked;
    const mixed=b&&a[1]-b[1]<15;
    return {text:mixed?`mieszana ${a[0]}/${b[0]}`:mechanismName(a[0]),primary:a[0],secondary:b?.[0]||null,values:v};
  }

  function ensembleAt(t){
    const defs=modelDefinitions(),models=defs.map(m=>calcMechanisms(m,t)).filter(Boolean);
    if(!models.length)return null;
    const phys=mean(models.map(m=>m.PHYS)),nwp=mean(models.map(m=>m.MODEL));
    const scores=models.map(m=>m.MODEL).filter(finite),sdm=stddev(scores);
    const agree=finite(sdm)?1-clip(sdm/35,0,1):(scores.length===1?.35:null);
    const obs=obsForLead(t),lead=Math.max(0,(t-Date.now())/HOUR);
    const obsTrend=obs?.trend??null;
    let final;
    if(lead<=3)final=weightedAvailable([{v:obs?.score??null,w:.30},{v:null,w:.25},{v:phys,w:.25},{v:nwp,w:.20}]);
    else if(lead<=6)final=weightedAvailable([{v:obsTrend,w:.15},{v:null,w:.15},{v:phys,w:.35},{v:nwp,w:.35}]);
    else if(lead<=12)final=weightedAvailable([{v:phys,w:.45},{v:nwp,w:.45},{v:obsTrend,w:.10}]);
    else final=weightedAvailable([{v:phys,w:.50},{v:nwp,w:.50}]);

    const sat=mean(models.map(m=>mean([m.components.SD,m.components.SRH])));
    const data=clip(mean(models.map(m=>m.coverage))??0,0,1);
    let obsConsistency=null;
    if(obs&&finite(nwp)&&finite(obs.raw))obsConsistency=1-clip(Math.abs(obs.raw-nwp)/100,0,1);
    const conf=weightedAvailable([{v:data,w:.35},{v:agree,w:.40},{v:obsConsistency,w:.25}]).v;

    const visModels=models.filter(m=>finite(m.VIS));
    const modelProb = thr => visModels.length?100*visModels.filter(m=>m.VIS<thr).length/visModels.length:null;
    const obsVisRisk = thr => obs?.obs? (obs.obs.visM<thr?100:0):null;
    const visRisk = thr => {
      const lower=thr<=500;
      const parts=lower
        ?[{v:modelProb(thr),w:.65},{v:final.v,w:.18},{v:obsVisRisk(thr),w:.12},{v:finite(sat)?sat*100:null,w:.05}]
        :[{v:modelProb(thr),w:.55},{v:final.v,w:.25},{v:obsVisRisk(thr),w:.10},{v:finite(sat)?sat*100:null,w:.10}];
      return weightedAvailable(parts).v;
    };
    const visVals=visModels.map(m=>m.VIS).filter(finite).sort((a,b)=>a-b);
    let vis=visVals.length?visVals[Math.floor((visVals.length-1)/2)]:null;
    if(obs?.obs&&finite(vis)){
      const ageLead=Math.max(0,t-obs.obs.t);
      const decay=Math.exp(-ageLead/(6*HOUR));
      const dmiNow=nearest(dmiRows,obs.obs.t,90*60e3);
      if(finite(dmiNow?.VIS)&&dmiNow.VIS>0)vis=clip(vis*Math.pow(clip(obs.obs.visM/dmiNow.VIS,.25,4),decay),50,50000);
    }
    const type=typeFromMechanisms(models);
    const T=mean(models.map(m=>m.T));
    const fzfg=finite(final.v)&&final.v>=60&&finite(T)?(T<=0?'TAK':T<=1?'RYZYKO':'NIE'):'NIE';
    return {
      t,lead,score:final.v,PHYS:phys,NWP:nwp,agreement:agree,data,confidence:conf,type,models,
      vis,vis1500:visRisk(1500),vis1000:visRisk(1000),vis500:visRisk(500),vis200:visRisk(200),
      T,fzfg,obsScore:obs?.raw??null,obsUsed:Boolean(obs),sat:finite(sat)?sat*100:null,
      dmiFog:models.find(m=>m.id===DMI_MODEL)?.directFog??null,
      FSI:mean(models.map(m=>m.fsi).filter(finite))
    };
  }

  function rebuildEngine(){
    if(typeof datasets==='undefined')return;
    const start=Math.floor(Date.now()/HOUR)*HOUR;
    const out=[];
    for(let h=0;h<=48;h++){
      const z=ensembleAt(start+h*HOUR);if(z)out.push(z);
    }
    fogSeries=out;renderFog();
  }

  function onsetAndDissipation(series){
    let onset=null;
    for(let i=0;i<series.length;i++){
      const s=series[i];
      if(s.score>=65 && series[i+1]?.score>=65){onset=s.t;break;}
      if(s.score>=80 && s.obsUsed){onset=s.t;break;}
    }
    let end=null;
    if(onset){
      const idx=series.findIndex(x=>x.t>=onset);
      for(let i=idx+1;i<series.length-1;i++){
        if(series[i].score<40&&series[i+1].score<40){end=series[i].t;break;}
      }
    }
    const peak=series.reduce((a,b)=>!a||b.score>a.score?b:a,null);
    let peakFrom=null,peakTo=null;
    if(peak){
      const thr=.85*peak.score,pi=series.indexOf(peak);let a=pi,b=pi;
      while(a>0&&series[a-1].score>=thr)a--;
      while(b<series.length-1&&series[b+1].score>=thr)b++;
      peakFrom=series[a].t;peakTo=series[b].t;
    }
    return {onset,end,peak,peakFrom,peakTo};
  }

  function diagCell(k,v){return `<div class="fog-diag-cell"><small>${k}</small><b>${v}</b></div>`;}
  function renderFog(){
    ensurePanel();
    const summary=document.getElementById('fogSummary'),hours=document.getElementById('fogHours'),strip=document.getElementById('fogStrip'),diag=document.getElementById('fogDiag'),note=document.getElementById('fogDataNote'),source=document.getElementById('fogSource');
    if(engineError&&!fogSeries.length){
      summary.innerHTML=`<div class="fog-card"><small>Status</small><strong>Brak danych</strong><em>${String(engineError).replace(/[<>]/g,'')}</em></div>`;if(strip)strip.hidden=true;return;
    }
    const now=Date.now(),future=fogSeries.filter(x=>x.t>=now-HOUR&&x.t<=now+48*HOUR);
    if(!future.length){summary.innerHTML='<div class="fog-card"><small>Status</small><strong>Oczekiwanie na modele…</strong></div>';if(strip)strip.hidden=true;return;}
    const current=future.reduce((a,b)=>Math.abs(b.t-now)<Math.abs(a.t-now)?b:a,future[0]);
    const ev=onsetAndDissipation(future);
    const peak=ev.peak||current;
    const type=peak.type?.text||current.type?.text||'—';
    const freeze=peak.fzfg;
    summary.innerHTML=`
      <div class="fog-card ${riskCss(current.score)}"><small>MGŁA — EPIR score</small><strong>${fmt0(current.score)}/100</strong><em>${scoreClass(current.score)}</em></div>
      <div class="fog-card"><small>Typ procesu</small><strong>${type}</strong><em>${peak.type?.secondary?'wtórny: '+mechanismName(peak.type.secondary):'dominujący mechanizm'}</em></div>
      <div class="fog-card"><small>Początek / zanik</small><strong>${ev.onset?localHour(ev.onset):'brak sygnału'} → ${ev.end?localHour(ev.end):'—'}</strong><em>histereza 65/40</em></div>
      <div class="fog-card ${riskCss(peak.score)}"><small>Największe ryzyko</small><strong>${fmt0(peak.score)}/100</strong><em>${ev.peakFrom?localHour(ev.peakFrom)+'–'+localHour(ev.peakTo):localHour(peak.t)}</em></div>
      <div class="fog-card"><small>VIS &lt;1000 / &lt;500 m</small><strong>${fmt0(current.vis1000)}/100 · ${fmt0(current.vis500)}/100</strong><em>VIS EPIR ${fmtM(current.vis)}</em></div>
      <div class="fog-card"><small>VIS &lt;1500 / &lt;200 m</small><strong>${fmt0(current.vis1500)}/100 · ${fmt0(current.vis200)}/100</strong><em>osobne zagrożenia</em></div>
      <div class="fog-card"><small>Mgła marznąca</small><strong>${freeze}</strong><em>T przy maksimum ${fmt1(peak.T)}°C</em></div>
      <div class="fog-card"><small>Pewność prognozy</small><strong>${confidenceLabel(current.confidence)}</strong><em>${fmt0((current.confidence??0)*100)}% wskaźnika CONF</em></div>`;
    if(source)source.textContent=`${ENGINE_VERSION} · ${current.models.length} modeli${current.obsUsed?' · OBS aktywne':''}`;
    if(note)note.innerHTML=`<b>Dostępność danych:</b> ${fmt0(current.data*100)}% · zgodność modeli ${fmt0((current.agreement??0)*100)}% · MTG FCI: brak automatycznego pola (waga usunięta i zrenormalizowana) · obserwacje: ${current.obsUsed?'użyte w nowcaście':'brak świeżej obserwacji'}. DMI 2 m fog: ${finite(current.dmiFog)?fmt0(current.dmiFog)+'%':'—'}.`;
    if(hours){
      hours.innerHTML=future.slice(0,13).map(x=>`<div class="fog-hour ${riskCss(x.score)}"><b>${localHour(x.t)}</b><div class="p">${fmt0(x.score)}/100</div><small>${scoreClass(x.score)}</small><small>${x.type?.text||'—'}</small><small>VIS ${fmtM(x.vis)}</small><small>&lt;1km ${fmt0(x.vis1000)}/100</small></div>`).join('');
    }
    if(strip)strip.hidden=false;
    if(diag){
      const tv=current.type?.values||{};
      diag.innerHTML=[
        diagCell('RAD',fmt0(tv.RAD)+'/100'),diagCell('ADV',fmt0(tv.ADV)+'/100'),diagCell('CBL',fmt0(tv.CBL)+'/100'),diagCell('PCP',fmt0(tv.PCP)+'/100'),
        diagCell('PHYS',fmt0(current.PHYS)+'/100'),diagCell('NWP ensemble',fmt0(current.NWP)+'/100'),diagCell('FSI_KT średni',fmt1(current.FSI)),diagCell('DMI fog 2 m',finite(current.dmiFog)?fmt0(current.dmiFog)+'%':'—'),
        diagCell('Agreement',fmt0((current.agreement??0)*100)+'%'),diagCell('Data',fmt0(current.data*100)+'%'),diagCell('Saturation',fmt0(current.sat)+'/100'),diagCell('OBS',finite(current.obsScore)?fmt0(current.obsScore)+'/100':'—')
      ].join('');
    }
  }

  function setVersion(){const v=document.querySelector('.brand small');if(v)v.textContent=APP_VERSION;}
  function syncCore(){
    try{
      const size=typeof datasets!=='undefined'?datasets.size:0;
      if(size!==lastCoreSize){lastCoreSize=size;rebuildEngine();}
    }catch(_){}
  }
  function init(){
    ensurePanel();setVersion();refreshExternal();
    setTimeout(()=>{syncCore();rebuildEngine();},3500);
    setInterval(syncCore,90*1000);
    setInterval(refreshExternal,30*60e3);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();