'use strict';
(() => {
  if (window.__EPIR_CONVECTION_12H__) return;
  window.__EPIR_CONVECTION_12H__ = true;

  const HOUR = 3600000;
  const VERSION = '20260920-conv12h1';
  const STORAGE_KEY = 'prognozaepir.convection12h.v1';
  const DEFAULT_POINT = {lat:52.828611, lon:18.330278, name:'EPIR'};
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const num = (v,fallback=0) => finite(v) ? Number(v) : fallback;
  const page = document.documentElement.dataset.epirPage || (location.pathname.split('/').pop()||'index.html').replace(/\.html?$/i,'') || 'index';
  let baseRows = [];
  let lastPointKey = '';
  let lastFetchAt = 0;
  let refreshTimer = 0;

  function currentPoint() {
    if (page === 'radar') {
      const lat = Number(String(document.getElementById('lat')?.value || '').replace(',','.'));
      const lon = Number(String(document.getElementById('lon')?.value || '').replace(',','.'));
      if (finite(lat) && finite(lon)) return {lat,lon,name:'punkt radarowy'};
    }
    return {...DEFAULT_POINT};
  }

  function pointKey(p) { return `${Number(p.lat).toFixed(4)},${Number(p.lon).toFixed(4)}`; }
  function samePoint(a,b) { return a && b && Math.hypot(Number(a.lat)-Number(b.lat),Number(a.lon)-Number(b.lon)) < 0.01; }
  function parseUtc(s) { return Date.parse(String(s).endsWith('Z') ? String(s) : String(s)+'Z'); }
  function isTsCode(v) { return [95,96,99].includes(Math.round(Number(v))); }
  function isShowery(v) { const c=Math.round(Number(v)); return c>=80 || isTsCode(c); }

  async function fetchJson(url, timeout=9000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url,{cache:'no-store',signal:ctl.signal});
      if (!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function modelUrl(endpoint,p,vars,models='') {
    const q = new URLSearchParams({
      latitude:String(p.lat), longitude:String(p.lon), hourly:vars.join(','),
      timezone:'UTC', forecast_hours:'15', wind_speed_unit:'ms'
    });
    if (models) q.set('models',models);
    return endpoint+'?'+q.toString();
  }

  function nearestIndex(hourly, ms) {
    const times = hourly?.time || [];
    let best=-1, dist=Infinity;
    for (let i=0;i<times.length;i++) {
      const d=Math.abs(parseUtc(times[i])-ms);
      if (d<dist) { dist=d; best=i; }
    }
    return dist <= 70*60000 ? best : -1;
  }

  function valueAt(j, key, ms) {
    const h=j?.hourly, i=nearestIndex(h,ms);
    if (i<0) return null;
    const v=h?.[key]?.[i];
    return finite(v) ? Number(v) : null;
  }

  function modelProbability(g,a,i,ms) {
    const cape=Math.max(0,num(valueAt(g,'cape',ms),0));
    const li=valueAt(g,'lifted_index',ms);
    const cin=valueAt(g,'convective_inhibition',ms);
    const tp=clamp(num(valueAt(g,'thunderstorm_probability',ms),0),0,100);
    const rr=Math.max(0,num(valueAt(g,'precipitation',ms),0));
    const gust=Math.max(0,num(valueAt(g,'wind_gusts_10m',ms),0));
    const codes=[valueAt(g,'weather_code',ms),valueAt(a,'weather_code',ms),valueAt(i,'weather_code',ms)].filter(finite);
    const stormSupport=codes.length?codes.filter(isTsCode).length/codes.length:0;
    const showerSupport=codes.length?codes.filter(isShowery).length/codes.length:0;

    const capeT=clamp(cape/1000,0,1);
    const capeCb=clamp((cape-250)/1400,0,1);
    const liScore=li===null ? 0.25 : clamp((0.5-Number(li))/6,0,1);
    const cinMag=cin===null ? 90 : Math.abs(Number(cin));
    const cinScore=1-clamp((cinMag-25)/190,0,1);
    const tpScore=tp/100;
    const rainScore=clamp(rr/3,0,1);
    const gustScore=clamp((gust-8)/18,0,1);

    let tcu=100*(0.30*capeT+0.16*liScore+0.13*cinScore+0.18*tpScore+0.09*rainScore+0.08*showerSupport+0.06*stormSupport);
    let cb=100*(0.25*capeCb+0.15*liScore+0.12*cinScore+0.29*tpScore+0.08*rainScore+0.05*gustScore+0.06*stormSupport);
    const ts=clamp(0.85*tp+15*stormSupport,0,100);

    if (stormSupport>0) cb=Math.max(cb,45+30*stormSupport);
    if (tp>=30) cb=Math.max(cb,0.78*tp);
    if (cape<100 && tp<10 && stormSupport===0 && showerSupport===0 && rr<0.1) { tcu*=0.35; cb*=0.20; }
    cb=clamp(cb,0,97);
    tcu=clamp(Math.max(tcu,cb+4),0,99);

    const agreement=codes.length ? 1-Math.min(1,Math.abs(stormSupport-(tp>=30?1:0))*0.45) : 0.55;
    return {
      tcuProbability:Math.round(tcu), cbProbability:Math.round(cb), tsProbability:Math.round(ts),
      cape:Math.round(cape), liftedIndex:li, cin, thunderstormProbability:Math.round(tp),
      precipitation:rr, gust, modelStormSupport:stormSupport, modelCount:codes.length,
      modelAgreement:Math.round(agreement*100)
    };
  }

  function currentNowcast() {
    const c=window.PrognozaEPIRConvectionNowcast;
    if (!c || !finite(c.tcuProbability) || !finite(c.cbProbability)) return null;
    return {tcu:clamp(Number(c.tcuProbability),0,100),cb:clamp(Number(c.cbProbability),0,100)};
  }

  function blendWithNowcast(rows) {
    const nowcast=currentNowcast();
    const now=Date.now();
    return rows.map(row => {
      const lead=(row.time-now)/HOUR;
      let tcu=row.tcuProbability, cb=row.cbProbability;
      if (nowcast && lead>=-0.75 && lead<=3.5) {
        const w=clamp(0.82-lead*0.19,0.18,0.82);
        tcu=Math.round(tcu*(1-w)+nowcast.tcu*w);
        cb=Math.round(cb*(1-w)+nowcast.cb*w);
      }
      cb=clamp(cb,0,97); tcu=clamp(Math.max(tcu,cb+3),0,99);
      const mode=lead<=3.25?'NOWCAST + NWP':lead<=6.25?'HYBRYDA':'NWP';
      const confidence=Math.round(clamp(88-lead*2.2,58,88));
      return {...row,tcuProbability:tcu,cbProbability:cb,leadHours:lead,mode,confidence};
    });
  }

  function publish(point, rows, source='live') {
    const result={version:VERSION,updatedAt:new Date().toISOString(),point,source,horizonHours:12,rows:blendWithNowcast(rows)};
    window.PrognozaEPIRConvection12h=result;
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(result)); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('prognozaepir:convection-12h-updated',{detail:result})); } catch (_) {}
    renderRadar(result);
    try { if (typeof window.draw==='function') requestAnimationFrame(()=>window.draw()); } catch (_) {}
    return result;
  }

  function fallback(point) {
    try {
      const j=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
      const age=Date.now()-Date.parse(j?.updatedAt||0);
      if (j?.rows?.length && samePoint(j.point,point) && age>=0 && age<2*HOUR) {
        baseRows=j.rows.map(r=>({...r}));
        return publish(point,baseRows,'cache');
      }
    } catch (_) {}
    return null;
  }

  async function refresh(force=false) {
    const point=currentPoint(), key=pointKey(point);
    if (!force && key===lastPointKey && Date.now()-lastFetchAt<2*60*1000 && baseRows.length) {
      return publish(point,baseRows,'memory');
    }
    lastPointKey=key; lastFetchAt=Date.now();
    const rich=['temperature_2m','precipitation','weather_code','wind_gusts_10m','cape','lifted_index','convective_inhibition','thunderstorm_probability'];
    const basic=['precipitation','weather_code','wind_gusts_10m'];
    const settled=await Promise.allSettled([
      fetchJson(modelUrl('https://api.open-meteo.com/v1/gfs',point,rich)),
      fetchJson(modelUrl('https://api.open-meteo.com/v1/forecast',point,basic,'ecmwf_aifs025_single')),
      fetchJson(modelUrl('https://api.open-meteo.com/v1/forecast',point,basic,'icon_d2'))
    ]);
    const g=settled[0].status==='fulfilled'?settled[0].value:null;
    const a=settled[1].status==='fulfilled'?settled[1].value:null;
    const i=settled[2].status==='fulfilled'?settled[2].value:null;
    if (!g?.hourly?.time?.length) return fallback(point);

    const now=Date.now();
    const rows=[];
    for (const s of g.hourly.time) {
      const ms=parseUtc(s), lead=(ms-now)/HOUR;
      if (!finite(ms) || lead < -1.1 || lead > 12.6) continue;
      rows.push({time:ms,...modelProbability(g,a,i,ms)});
    }
    if (!rows.length) return fallback(point);
    baseRows=rows;
    return publish(point,rows,'GFS+AIFS+ICON-D2');
  }

  function ensureRadarStyle() {
    if (document.getElementById('conv12hStyle')) return;
    const s=document.createElement('style'); s.id='conv12hStyle';
    s.textContent=`
      #conv12hForecast{margin-top:7px;padding:7px;border:1px solid var(--line);border-radius:7px;background:var(--panel2)}
      #conv12hForecast .c12-head{display:flex;gap:8px;justify-content:space-between;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
      #conv12hForecast .c12-head b{font-size:10px}#conv12hForecast .c12-head span{font-size:8px;color:var(--muted)}
      #conv12hForecast .c12-grid{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(76px,1fr);gap:5px;overflow-x:auto;padding-bottom:2px}
      #conv12hForecast .c12-cell{border:1px solid var(--line);border-radius:6px;padding:5px;text-align:center;white-space:nowrap;background:var(--panel)}
      #conv12hForecast .c12-cell small{display:block;color:var(--muted);font-size:7.5px;margin-bottom:2px}
      #conv12hForecast .c12-cell b{display:block;font-size:9px;line-height:1.35}
      #conv12hForecast .tcu{color:#d97706}#conv12hForecast .cb{color:#d32f2f}
    `;
    document.head.appendChild(s);
  }

  function renderRadar(result) {
    if (page!=='radar') return;
    ensureRadarStyle();
    const card=document.getElementById('convectionNowcastCard');
    if (!card) return;
    const h=card.querySelector('h2');
    if (h) h.textContent='TCu / Cb · zagrożenie dla EPIR 0–12 h';
    let box=document.getElementById('conv12hForecast');
    if (!box) {
      box=document.createElement('div'); box.id='conv12hForecast';
      const summary=document.getElementById('convSummary');
      if (summary) summary.insertAdjacentElement('afterend',box); else card.appendChild(box);
    }
    const rows=(result?.rows||[]).filter(r=>r.leadHours>=-0.6&&r.leadHours<=12.6).slice(0,13);
    const hh=ms=>String(new Date(ms).getUTCHours()).padStart(2,'0')+' UTC';
    box.innerHTML=`<div class="c12-head"><b>Prognoza konwekcji 0–12 h</b><span>0–3 h nowcast + NWP · 3–6 h hybryda · 6–12 h NWP</span></div><div class="c12-grid">${rows.map(r=>{
      const lead=Math.max(0,Math.round(r.leadHours));
      return `<div class="c12-cell"><small>+${lead} h · ${hh(r.time)}</small><b class="tcu">TCu ${Math.round(r.tcuProbability)}%</b><b class="cb">Cb ${Math.round(r.cbProbability)}%</b></div>`;
    }).join('')}</div>`;
  }

  function reblend() { if (baseRows.length) publish(currentPoint(),baseRows,'reblend'); }
  function schedule(force=true) { clearTimeout(refreshTimer); refreshTimer=setTimeout(()=>refresh(force).catch(()=>fallback(currentPoint())),450); }

  window.addEventListener('prognozaepir:convection-nowcast-updated',()=>setTimeout(reblend,0));
  window.addEventListener('prognozaepir:radar-nowcast-updated',()=>setTimeout(reblend,0));
  for (const id of ['apply','resetPoint','refresh']) document.getElementById(id)?.addEventListener('click',()=>schedule(true));
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden && Date.now()-lastFetchAt>10*60*1000) schedule(false); });
  window.PrognozaEPIRConvection12hEngine={refresh:()=>refresh(true),get:()=>window.PrognozaEPIRConvection12h||null};

  setTimeout(()=>refresh(true).catch(()=>fallback(currentPoint())),250);
  if (page==='radar') [1200,3000,6000].forEach(ms=>setTimeout(()=>{reblend();renderRadar(window.PrognozaEPIRConvection12h);},ms));
})();
