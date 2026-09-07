'use strict';

// UI cleanup ---------------------------------------------------------------
(() => {
  const hideUi = () => {
    const sources = document.querySelector('.sources');
    if (sources) {
      const card = sources.closest('.card');
      if (card) { card.style.display = 'none'; card.setAttribute('aria-hidden','true'); }
      else sources.style.display = 'none';
    }
    for (const id of ['polradStatus','lightningStatus']) {
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; el.setAttribute('aria-hidden','true'); }
    }
  };
  hideUi();
  const observer = new MutationObserver(hideUi);
  observer.observe(document.body,{childList:true,subtree:true});
  setTimeout(()=>observer.disconnect(),10000);
})();

// Radar-nowcast model bridge -----------------------------------------------
// The 0-3 h radar nowcast used three additional browser-side Open-Meteo
// requests. When those calls are throttled/rejected the UI incorrectly looked
// as if models disagreed with radar. For the EPIR default point, serve the
// hourly GitHub Actions model snapshot first; live Open-Meteo remains fallback
// and is still used for user-selected coordinates.
(() => {
  if (window.__PrognozaEPIRNowcastModelBridge) return;
  window.__PrognozaEPIRNowcastModelBridge = true;

  const upstreamFetch = window.fetch.bind(window);
  const SNAPSHOT_URL = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/runtime/models-latest.json';
  let snapshotPromise = null;

  const parseMs = t => Date.parse(String(t||'') + (String(t||'').endsWith('Z') ? '' : 'Z'));
  const closeTo = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= 0.03;

  async function snapshot() {
    if (!snapshotPromise) snapshotPromise = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(()=>ctl.abort(),6000);
      try {
        const r = await upstreamFetch(SNAPSHOT_URL + '?_=' + Date.now(), {
          cache:'no-store', signal:ctl.signal, headers:{Accept:'application/json'}
        });
        if (!r.ok) throw new Error('snapshot HTTP ' + r.status);
        const j = await r.json();
        if (j?.schema !== 'prognozaepir-model-snapshot-v1') throw new Error('bad snapshot schema');
        const models = j?.models || {};
        if (!Object.keys(models).length) throw new Error('empty snapshot');
        return j;
      } catch (e) {
        console.warn('Radar model snapshot unavailable; live fallback active',e);
        return null;
      } finally { clearTimeout(timer); }
    })();
    return snapshotPromise;
  }

  function modelIdFor(u,j) {
    if (u.pathname === '/v1/gfs') return 'ncep_gfs_global';
    const id = u.searchParams.get('models') || '';
    if (id === 'icon_seamless') {
      if (j?.models?.icon_d2) return 'icon_d2';
      if (j?.models?.icon_eu) return 'icon_eu';
      return 'icon_global';
    }
    return id;
  }

  function isSupportRequest(u) {
    if (u.hostname !== 'api.open-meteo.com') return false;
    if (u.searchParams.get('forecast_hours') !== '6') return false;
    const vars = String(u.searchParams.get('hourly')||'').split(',').map(x=>x.trim()).filter(Boolean).sort();
    return vars.length === 2 && vars[0] === 'precipitation' && vars[1] === 'weather_code';
  }

  function responseFromSnapshot(u,j) {
    const lat = Number(u.searchParams.get('latitude'));
    const lon = Number(u.searchParams.get('longitude'));
    if (!closeTo(lat,Number(j?.location?.lat)) || !closeTo(lon,Number(j?.location?.lon))) return null;
    const id = modelIdFor(u,j), model = j?.models?.[id], h = model?.hourly || {};
    const times = Array.isArray(h.time) ? h.time : [];
    if (!times.length || !Array.isArray(h.precipitation)) return null;
    const last = parseMs(times.at(-1));
    if (!Number.isFinite(last) || last < Date.now() + 3*3600000) return null;
    const body = {
      latitude:j.location.lat, longitude:j.location.lon, elevation:model.elevation,
      timezone:'UTC', timezone_abbreviation:'UTC', utc_offset_seconds:0,
      hourly_units:{time:'iso8601',precipitation:model.hourly_units?.precipitation || 'mm',weather_code:model.hourly_units?.weather_code || 'wmo code'},
      hourly:{time:times,precipitation:h.precipitation,weather_code:Array.isArray(h.weather_code)?h.weather_code:new Array(times.length).fill(null)}
    };
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-PrognozaEPIR-Source':'model-snapshot'}});
  }

  window.fetch = async function(input,init) {
    let u = null;
    try { u = new URL(typeof input === 'string' ? input : input?.url,location.href); } catch (_) {}
    if (u && isSupportRequest(u)) {
      try {
        const j = await snapshot();
        const local = j ? responseFromSnapshot(u,j) : null;
        if (local) return local;
      } catch (e) { console.warn('Radar model bridge:',e); }
    }
    return upstreamFetch(input,init);
  };

  window.addEventListener('prognozaepir:radar-nowcast-updated',ev => {
    const m = ev?.detail?.models;
    const combined = document.getElementById('rnCombined');
    if (!combined || !m) return;
    if (!m.total) combined.textContent = 'brak danych modeli';
    else if (!m.support) combined.textContent = 'radar aktywny · modele nie potwierdzają';
    else if (m.support === m.total && m.total >= 2) combined.textContent = 'radar + modele zgodne';
    else combined.textContent = 'częściowe wsparcie modeli';
  });
})();

// Main GFS/AIFS cards repair ------------------------------------------------
// thunderstorm_probability is not a GFS field for this location. Load valid
// GFS surface and convective diagnostics separately and derive a clearly
// labelled 0-100 diagnostic storm index.
(() => {
  if (typeof loadModels !== 'function' || typeof json !== 'function' || typeof $ !== 'function') return;
  if (window.__PrognozaEPIRGfsLoaderRepair) return;
  window.__PrognozaEPIRGfsLoaderRepair = true;

  const num = v => Number.isFinite(Number(v));
  const nval = (v,d=0) => num(v) ? Number(v) : d;
  const fmt = (v,d=1) => num(v) ? Number(v).toFixed(d) : '—';
  const timeMs = t => Date.parse(String(t||'') + (String(t||'').endsWith('Z') ? '' : 'Z'));

  function stormIndex(row) {
    const code = Math.round(nval(row?.weather_code,-1));
    if (code === 99) return 98; if (code === 96) return 94; if (code === 95) return 88;
    const cape=Math.max(0,nval(row?.cape)), li=num(row?.lifted_index)?Number(row.lifted_index):null;
    const cin=Math.abs(nval(row?.convective_inhibition)), rain=Math.max(0,nval(row?.precipitation)), gust=Math.max(0,nval(row?.wind_gusts_10m));
    let s=Math.min(42,cape/30);
    if (li!==null) s += li<=-6?28:li<=-4?20:li<=-2?12:li<0?5:0;
    s += rain>=5?12:rain>=1?6:rain>=.2?2:0;
    s += gust>=20?8:gust>=15?4:0;
    s -= cin>=200?18:cin>=100?10:cin>=50?5:0;
    return Math.max(0,Math.min(90,Math.round(s)));
  }

  function merge(base,extra) {
    if (!base) return extra || null; if (!extra) return base;
    const out={...base,hourly:{...(base.hourly||{})},hourly_units:{...(base.hourly_units||{})}};
    const bt=out.hourly.time||[], et=extra.hourly?.time||[];
    for (const [k,a] of Object.entries(extra.hourly||{})) {
      if (k==='time'||!Array.isArray(a)) continue;
      if (bt.length===et.length && bt.every((t,i)=>t===et[i])) out.hourly[k]=a.slice();
      else { const by=new Map(et.map((t,i)=>[t,a[i]])); out.hourly[k]=bt.map(t=>by.has(t)?by.get(t):null); }
    }
    Object.assign(out.hourly_units,extra.hourly_units||{}); return out;
  }

  function addIndex(g) {
    if (!g?.hourly?.time?.length) return g; const h=g.hourly;
    h.thunderstorm_probability=h.time.map((_,i)=>stormIndex({weather_code:h.weather_code?.[i],cape:h.cape?.[i],lifted_index:h.lifted_index?.[i],convective_inhibition:h.convective_inhibition?.[i],precipitation:h.precipitation?.[i],wind_gusts_10m:h.wind_gusts_10m?.[i]}));
    return g;
  }

  function renderTable(g,a) {
    const tb=$('forecastRows'); if (!tb) return; tb.innerHTML='';
    const head=tb.closest('table')?.querySelector('thead tr'); if (head?.children?.[4]) head.children[4].textContent='Indeks GFS';
    const gh=g.hourly||{}, ah=a?.hourly||{}, now=Date.now(); let shown=0;
    for (let i=0;i<(gh.time||[]).length && shown<7;i++) {
      const ms=timeMs(gh.time[i]); if (ms<now-30*60000) continue;
      let ai='—';
      if (ah.time?.length) { let j=0,bd=Infinity; ah.time.forEach((t,k)=>{const d=Math.abs(timeMs(t)-ms);if(d<bd){bd=d;j=k;}}); ai=(num(ah.precipitation?.[j])?fmt(ah.precipitation[j],1)+' mm/h · ':'')+weatherName(ah.weather_code?.[j]); }
      const tr=document.createElement('tr');
      tr.innerHTML='<td>'+fmtTime(ms)+'</td><td>'+fmt(gh.temperature_2m?.[i],1)+'°C</td><td>'+fmt(gh.precipitation?.[i],1)+'</td><td>'+fmt(gh.cape?.[i],0)+'</td><td>'+fmt(gh.thunderstorm_probability?.[i],0)+'/100</td><td>'+fmt(gh.wind_gusts_10m?.[i],1)+'</td><td>'+ai+'</td>';
      tb.appendChild(tr); shown++;
    }
  }

  function renderAi(g,a,r) {
    const t=['<b>Ocena AI/AIFS dla najbliższych godzin:</b>'];
    if(r.dbz>=50)t.push('Nad punktem występuje bardzo silne echo radarowe (~'+Math.round(r.dbz)+' dBZ).');
    else if(r.dbz>=40)t.push('Radar wykrywa silniejszy opad w punkcie (~'+Math.round(r.dbz)+' dBZ).');
    else if(r.dbz>=27)t.push('Radar wykrywa echo opadowe w punkcie (~'+Math.round(r.dbz)+' dBZ).');
    else t.push('W punkcie nie widać obecnie silnego echa radarowego.');
    t.push('GFS: CAPE '+fmt(g.cape,0)+' J/kg, indeks burzowy '+fmt(g.thunderstorm_probability,0)+'/100, porywy '+fmt(g.wind_gusts_10m,1)+' m/s.');
    if(a)t.push('ECMWF AIFS: '+weatherName(a.weather_code)+', opad '+fmt(a.precipitation,1)+' mm/h.');
    t.push('Łączna ocena modułu: burza <b>'+Math.round(r.storm)+'%</b>, grad <b>'+Math.round(r.hail)+'%</b>, silny opad <b>'+Math.round(r.rain)+'%</b>, silne porywy <b>'+Math.round(r.wind)+'%</b>.');
    t.push('<span style="color:var(--muted)">Indeks GFS jest diagnostycznym wskaźnikiem PrognozaEPIR z CAPE/LI/CIN/WMO, nie natywnym prawdopodobieństwem GFS.</span>');
    if($('aiText')) $('aiText').innerHTML=t.join(' ');
  }

  loadModels = async function repairedLoadModels() {
    const common={latitude:point.lat,longitude:point.lon,timezone:'UTC',forecast_hours:'12',wind_speed_unit:'ms'};
    const surface=['temperature_2m','precipitation','weather_code','wind_gusts_10m'];
    const conv=['cape','lifted_index','convective_inhibition','freezing_level_height'];
    const sq=new URLSearchParams({...common,hourly:surface.join(',')}), cq=new URLSearchParams({...common,hourly:conv.join(',')}), aq=new URLSearchParams({...common,hourly:surface.join(','),models:'ecmwf_aifs025_single'});
    const [sr,cr,ar]=await Promise.allSettled([json('https://api.open-meteo.com/v1/gfs?'+sq),json('https://api.open-meteo.com/v1/gfs?'+cq),json('https://api.open-meteo.com/v1/forecast?'+aq)]);
    const g=addIndex(merge(sr.status==='fulfilled'?sr.value:null,cr.status==='fulfilled'?cr.value:null));
    const a=ar.status==='fulfilled'?ar.value:null; setDot('srcGfs',!!g); setDot('srcAifs',!!a);
    if(!g) throw new Error('Brak danych GFS/Open-Meteo');
    const n=nearestHourly(g), an=a?nearestHourly(a):null; if(!n) throw new Error('Brak godzinowych danych GFS');
    if($('temp'))$('temp').textContent=fmt(n.temperature_2m,1)+' °C';
    if($('rain'))$('rain').textContent=fmt(n.precipitation,1)+' mm/h';
    if($('cape'))$('cape').textContent=fmt(n.cape,0)+' J/kg';
    if($('li'))$('li').textContent=fmt(n.lifted_index,1);
    if($('cin'))$('cin').textContent=fmt(n.convective_inhibition,0)+' J/kg';
    if($('freezing'))$('freezing').textContent=num(n.freezing_level_height)?(Number(n.freezing_level_height)/1000).toFixed(1)+' km':'—';
    if($('gfsStorm'))$('gfsStorm').textContent=fmt(n.thunderstorm_probability,0)+'/100';
    if($('gust'))$('gust').textContent=fmt(n.wind_gusts_10m,1)+' m/s';
    if($('aifsRain'))$('aifsRain').textContent=an?fmt(an.precipitation,1)+' mm/h':'—';
    if($('aifsCode'))$('aifsCode').textContent=an?weatherName(an.weather_code):'—';
    const metric=$('gfsStorm')?.closest('.metric'); if(metric){const title=metric.querySelector('small'),note=metric.querySelector('span');if(title)title.textContent='Burza — indeks GFS';if(note)note.textContent='0–100 · CAPE / LI / CIN / WMO';}
    const dbz=radarSamples.filter(x=>Number.isFinite(x.dbz)).at(-1)?.dbz||0,cape=Math.max(0,nval(n.cape)),idx=nval(n.thunderstorm_probability),li=nval(n.lifted_index),rr=Math.max(0,nval(n.precipitation)),gust=Math.max(0,nval(n.wind_gusts_10m)),fz=Math.max(0,nval(n.freezing_level_height));
    const radarStorm=dbz>=50?45:dbz>=45?30:dbz>=35?14:dbz>=27?6:0,capeStorm=clamp(cape/40,0,35),liStorm=li<=-5?18:li<=-3?12:li<=-1?6:0,storm=clamp(idx*.62+radarStorm+capeStorm+liStorm,0,99);
    const hailRadar=dbz>=55?42:dbz>=50?30:dbz>=45?16:0,hailCape=clamp((cape-600)/45,0,28),hailFz=fz>=1800&&fz<=3600?12:(fz>0?5:0),hail=clamp(storm*.28+hailRadar+hailCape+hailFz,0,95),rainRisk=clamp(rr*12+(dbz>=50?45:dbz>=40?30:dbz>=30?15:0)+storm*.18,0,99),windRisk=clamp((gust-10)*5+storm*.22,0,99);
    riskSet('storm',storm);riskSet('hail',hail);riskSet('rain',rainRisk);riskSet('wind',windRisk);renderTable(g,a);renderAi(n,an,{storm,hail,rain:rainRisk,wind:windRisk,dbz});
  };

  setTimeout(async()=>{try{await loadModels();const box=$('error');if(box?.textContent?.includes('GFS/Open-Meteo'))err('');}catch(e){console.warn('PrognozaEPIR GFS repair:',e);}},0);
})();
