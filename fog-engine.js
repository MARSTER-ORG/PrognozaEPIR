'use strict';
(() => {
  if (typeof PLACE === 'undefined') return;

  const VERSION = 'v0.10.17 HTML';
  const HOUR = 3600e3;
  const DMI_MODEL = 'dmi_harmonie_arome_europe';
  const OBS_KEY = 'prognozaepir-fog-observations-v1';
  const MAX_OBS = 30;
  const DMI_VARS = [
    'temperature_2m','relative_humidity_2m','dew_point_2m','visibility',
    'cloud_cover_2m','cloud_cover_low','wind_speed_10m','wind_gusts_10m',
    'precipitation','shortwave_radiation','is_day'
  ];

  let dmiRows = [];
  let dmiError = '';
  let fogSeries = [];
  let busy = false;

  const clip = (v,a,b) => Math.max(a,Math.min(b,v));
  const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
  const pct = v => Number.isFinite(v) ? Math.round(clip(v,0,100)) : null;

  function lerp(a,b,q){ return a+(b-a)*q; }
  function ramp(v,a,b,outA=0,outB=100){
    if (!Number.isFinite(v)) return 0;
    if (v<=a) return outA;
    if (v>=b) return outB;
    return lerp(outA,outB,(v-a)/(b-a));
  }

  function parseUtc(s){ return Date.parse(String(s).endsWith('Z') ? s : s+'Z'); }
  function localHour(t){
    try { return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t)); }
    catch (_) { return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'}); }
  }
  function localDateTime(t){
    try { return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t)); }
    catch (_) { return new Date(t).toLocaleString('pl-PL'); }
  }

  function addStyles(){
    if (document.getElementById('fogEngineStyle')) return;
    const s=document.createElement('style');s.id='fogEngineStyle';
    s.textContent=`
      .fog-engine{margin-top:6px;border:1px solid var(--border);background:var(--surface);border-radius:4px;padding:9px 10px;font-size:10px;line-height:1.35}
      .fog-head{display:flex;justify-content:space-between;gap:8px;align-items:center;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:7px}
      .fog-head b{color:var(--blueText);font-size:12px}.fog-head span{color:var(--muted);font-size:9px;text-align:right}
      .fog-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin-bottom:7px}
      .fog-card{background:var(--soft);border-left:3px solid var(--blueText);padding:6px 7px;min-width:0}
      .fog-card small{display:block;color:var(--muted);font-size:8px}.fog-card strong{display:block;font-size:12px;margin-top:1px}.fog-card em{display:block;color:var(--muted);font-style:normal;font-size:8px;margin-top:1px}
      .fog-strip{overflow-x:auto;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:6px 0;padding:5px 0}
      .fog-hours{display:flex;min-width:max-content;gap:4px}.fog-hour{width:74px;background:var(--soft);border:1px solid var(--border);border-radius:4px;padding:4px;text-align:center}
      .fog-hour b{display:block;font-size:9px}.fog-hour .p{font-size:11px;font-weight:700;margin:2px 0}.fog-hour small{display:block;color:var(--muted);font-size:8px}
      .fog-risk-low{border-left:3px solid #6f8b95}.fog-risk-mid{border-left:3px solid #d49a28}.fog-risk-high{border-left:3px solid #d0503f}
      .fog-observe{margin-top:7px}.fog-observe summary{cursor:pointer;color:var(--blueText);font-weight:700}.fog-form{display:grid;grid-template-columns:1.4fr repeat(3,1fr) auto;gap:5px;margin-top:6px;align-items:end}
      .fog-form label{color:var(--muted);font-size:8px}.fog-form input{width:100%;margin-top:2px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:4px;padding:5px;font-size:10px}.fog-form button{border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:5px;padding:6px 8px;font-size:9px}
      .fog-note{color:var(--muted);font-size:8px;margin-top:5px}.fog-obs-list{color:var(--muted);font-size:8px;margin-top:4px}.fog-error{color:var(--errorText);font-size:9px}
      @media(max-width:700px){.fog-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.fog-form{grid-template-columns:repeat(2,minmax(0,1fr))}.fog-form button{min-height:31px}.fog-engine{padding:7px}.fog-hour{width:68px}}
    `;
    document.head.appendChild(s);
  }

  function ensurePanel(){
    addStyles();
    let el=document.getElementById('fogEngine');
    if (el) return el;
    el=document.createElement('section');el.id='fogEngine';el.className='fog-engine';
    el.innerHTML=`
      <div class="fog-head"><b>FOG / VIS — mgła i widzialność</b><span id="fogSource">DMI HARMONIE-AROME 2 km + konsensus</span></div>
      <div id="fogSummary" class="fog-summary"><div class="fog-card"><small>Status</small><strong>Ładowanie…</strong></div></div>
      <div id="fogStrip" class="fog-strip" hidden><div id="fogHours" class="fog-hours"></div></div>
      <details class="fog-observe"><summary>Dodaj rzeczywistą obserwację do lokalnej korekty</summary>
        <div class="fog-form">
          <label>Godzina<input id="fogObsTime" type="datetime-local"></label>
          <label>Temperatura °C<input id="fogObsT" type="number" step="0.1" inputmode="decimal"></label>
          <label>Wilgotność %<input id="fogObsRH" type="number" min="0" max="100" step="1" inputmode="numeric"></label>
          <label>Widzialność km<input id="fogObsVis" type="number" min="0.05" max="50" step="0.1" inputmode="decimal"></label>
          <button id="fogObsSave" type="button">Zapisz</button>
        </div>
        <div id="fogObsList" class="fog-obs-list"></div>
        <div class="fog-note">Obserwacje są zapisywane tylko w tej przeglądarce. Korekta lokalna wygasa stopniowo w ciągu 12 h. Moduł jest eksperymentalny i nie zastępuje METAR/TAF ani obserwacji terenowej.</div>
      </details>`;
    const ref=document.getElementById('sectionInfo');
    if (ref && ref.parentNode) ref.parentNode.insertBefore(el,ref.nextSibling); else document.querySelector('.app')?.appendChild(el);
    document.getElementById('fogObsSave')?.addEventListener('click',saveObservation);
    setDefaultObsTime();
    renderObservationList();
    return el;
  }

  function localInputValue(ms){
    const d=new Date(ms),parts=new Intl.DateTimeFormat('sv-SE',{timeZone:PLACE.tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d);
    const o={};for(const p of parts)o[p.type]=p.value;
    return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
  }
  function parseLocalInput(value){
    if (!value) return NaN;
    const direct=Date.parse(value);
    if (Number.isFinite(direct)) return direct;
    return NaN;
  }
  function setDefaultObsTime(){
    const x=document.getElementById('fogObsTime');if(x&&!x.value)x.value=localInputValue(Date.now());
  }

  function getObservations(){
    try { const a=JSON.parse(localStorage.getItem(OBS_KEY)||'[]'); return Array.isArray(a)?a.filter(o=>Number.isFinite(o.t)).slice(-MAX_OBS):[]; }
    catch(_){ return []; }
  }
  function putObservations(a){
    try { localStorage.setItem(OBS_KEY,JSON.stringify(a.slice(-MAX_OBS))); } catch(_) {}
  }
  function latestObservation(){
    const now=Date.now()+10*60e3;
    return getObservations().filter(o=>o.t<=now).sort((a,b)=>b.t-a.t)[0]||null;
  }
  function saveObservation(){
    const t=parseLocalInput(document.getElementById('fogObsTime')?.value);
    const T=num(document.getElementById('fogObsT')?.value);
    const RH=num(document.getElementById('fogObsRH')?.value);
    const visKm=num(document.getElementById('fogObsVis')?.value);
    if (!Number.isFinite(t) || RH===null || visKm===null || RH<0 || RH>100 || visKm<=0){
      alert('Podaj godzinę, wilgotność 0–100% i widzialność większą od 0 km. Temperatura może pozostać pusta.');return;
    }
    const a=getObservations();a.push({t,T,RH,visKm,created:Date.now()});putObservations(a);
    renderObservationList();buildFogSeries();renderFog();
  }
  function renderObservationList(){
    const el=document.getElementById('fogObsList');if(!el)return;
    const a=getObservations();
    if(!a.length){el.textContent='Brak zapisanych obserwacji.';return;}
    const o=a[a.length-1];el.innerHTML=`Ostatnia: <b>${localDateTime(o.t)}</b> · ${o.T===null?'T —':'T '+o.T.toFixed(1)+'°C'} · RH ${Math.round(o.RH)}% · VIS ${o.visKm.toFixed(1)} km <button id="fogObsClear" type="button" style="margin-left:5px">Wyczyść</button>`;
    document.getElementById('fogObsClear')?.addEventListener('click',()=>{putObservations([]);renderObservationList();buildFogSeries();renderFog();});
  }

  async function fetchDmi(){
    if(busy)return;busy=true;dmiError='';ensurePanel();
    const q=new URLSearchParams({
      latitude:String(PLACE.lat),longitude:String(PLACE.lon),hourly:DMI_VARS.join(','),
      models:DMI_MODEL,timezone:'UTC',forecast_hours:'60',past_hours:'3',wind_speed_unit:'ms'
    });
    try{
      const r=await fetch('https://api.open-meteo.com/v1/forecast?'+q,{cache:'no-store'});
      const j=await r.json().catch(()=>null);
      if(!r.ok||!j?.hourly?.time)throw new Error(j?.reason||j?.message||('HTTP '+r.status));
      const h=j.hourly,times=h.time||[];
      dmiRows=times.map((s,i)=>({
        t:parseUtc(s),T:num(h.temperature_2m?.[i]),RH:num(h.relative_humidity_2m?.[i]),Td:num(h.dew_point_2m?.[i]),
        VIS:num(h.visibility?.[i]),fog2m:num(h.cloud_cover_2m?.[i]),low:num(h.cloud_cover_low?.[i]),
        WS:num(h.wind_speed_10m?.[i]),G:num(h.wind_gusts_10m?.[i]),RR:num(h.precipitation?.[i]),
        SW:num(h.shortwave_radiation?.[i]),isDay:num(h.is_day?.[i])
      })).filter(x=>Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);
    }catch(e){dmiRows=[];dmiError=e?.message||String(e);}finally{busy=false;buildFogSeries();renderFog();}
  }

  function nearest(arr,t,maxDiff=75*60e3){
    if(!arr?.length)return null;let best=null,bd=Infinity;
    for(const x of arr){const d=Math.abs(x.t-t);if(d<bd){best=x;bd=d;}}
    return bd<=maxDiff?best:null;
  }
  function consensusAt(t){
    try { return nearest(typeof consensus!=='undefined'?consensus:[],t); } catch(_){ return null; }
  }

  function visibilitySignal(visM){
    if(!Number.isFinite(visM))return 0;
    if(visM<=500)return 100;if(visM<=1000)return ramp(visM,500,1000,100,88);
    if(visM<=3000)return ramp(visM,1000,3000,88,58);
    if(visM<=5000)return ramp(visM,3000,5000,58,34);
    if(visM<=10000)return ramp(visM,5000,10000,34,10);
    if(visM<=20000)return ramp(visM,10000,20000,10,0);return 0;
  }
  function mistSignal(visM){
    if(!Number.isFinite(visM))return 0;
    if(visM<700)return 25;
    if(visM<1000)return ramp(visM,700,1000,25,70);
    if(visM<=2500)return ramp(visM,1000,2500,78,100);
    if(visM<=5000)return ramp(visM,2500,5000,100,48);
    if(visM<=8000)return ramp(visM,5000,8000,48,0);return 0;
  }
  function saturationScore(RH,T,Td){
    const rh=Number.isFinite(RH)?ramp(RH,82,99,0,100):0;
    const dep=Number.isFinite(T)&&Number.isFinite(Td)?T-Td:null;
    let ds=0;if(Number.isFinite(dep)){if(dep<=0.3)ds=100;else if(dep<=1)ds=ramp(dep,.3,1,100,88);else if(dep<=3.5)ds=ramp(dep,1,3.5,88,20);else if(dep<=6)ds=ramp(dep,3.5,6,20,0);}
    return .62*rh+.38*ds;
  }
  function windScore(ws){
    if(!Number.isFinite(ws))return 45;if(ws<.3)return 55;if(ws<=2.5)return ramp(ws,.3,1.2,75,100);if(ws<=4)return ramp(ws,2.5,4,100,68);if(ws<=6)return ramp(ws,4,6,68,28);if(ws<=9)return ramp(ws,6,9,28,5);return 2;
  }
  function wetScore(t){
    let sum=0,n=0;for(const r of dmiRows){if(r.t<t-4*HOUR||r.t>t)continue;if(Number.isFinite(r.RR)){sum+=Math.max(0,r.RR);n++;}}
    if(!n)return 25;if(sum>=2)return 100;if(sum>=.5)return 80;if(sum>=.1)return 55;return 20;
  }

  function rawFog(r,cons){
    const fog2=Number.isFinite(r.fog2m)?clip(r.fog2m,0,100):0;
    const visD=visibilitySignal(r.VIS);
    const sat=saturationScore(r.RH,r.T,r.Td);
    const wind=windScore(r.WS);
    const low=Number.isFinite(r.low)?clip(r.low,0,100):35;
    const night=(r.isDay===0||(Number.isFinite(r.SW)&&r.SW<10))?100:20;
    const wet=wetScore(r.t);
    const cVis=visibilitySignal(cons?.VIS);
    const cSat=saturationScore(cons?.RH,cons?.T,cons?.Td);
    const cScore=(cVis||cSat)?(.58*cVis+.42*cSat):40;
    return clip(.35*fog2+.18*visD+.17*sat+.08*wind+.07*low+.06*night+.04*wet+.05*cScore,0,100);
  }

  function correctionFor(t,r,cons,rawP){
    const o=latestObservation();
    if(!o||t<o.t-30*60e3||t>o.t+12*HOUR)return {p:rawP,RH:r.RH,T:r.T,VIS:r.VIS,active:false};
    const at=nearest(dmiRows,o.t,2*HOUR),ca=consensusAt(o.t);
    if(!at)return {p:rawP,RH:r.RH,T:r.T,VIS:r.VIS,active:false};
    const ahead=Math.max(0,(t-o.t)/HOUR),decay=Math.exp(-ahead/5.5);
    const baseRH=Number.isFinite(at.RH)?at.RH:ca?.RH;
    const baseT=Number.isFinite(at.T)?at.T:ca?.T;
    const baseVis=Number.isFinite(at.VIS)?at.VIS:ca?.VIS;
    const RH=Number.isFinite(r.RH)&&Number.isFinite(baseRH)?clip(r.RH+(o.RH-baseRH)*decay,0,100):r.RH;
    const T=Number.isFinite(r.T)&&o.T!==null&&Number.isFinite(baseT)?r.T+(o.T-baseT)*decay:r.T;
    let VIS=r.VIS;
    if(Number.isFinite(baseVis)&&baseVis>50&&Number.isFinite(VIS)&&o.visKm>0){const ratio=clip(o.visKm*1000/baseVis,.22,4.0);VIS=clip(VIS*Math.pow(ratio,decay),50,50000);}
    const obsTarget=o.visKm<1?100:(o.visKm<5?58:5);
    const obsRaw=rawFog(at,ca);
    const p=clip(rawP+(obsTarget-obsRaw)*decay*.62,0,100);
    return {p,RH,T,VIS,active:true};
  }

  function buildFogSeries(){
    fogSeries=[];
    for(const r of dmiRows){
      const cons=consensusAt(r.t),rawP=rawFog(r,cons),corr=correctionFor(r.t,r,cons,rawP);
      const visBase=Number.isFinite(corr.VIS)?corr.VIS:(Number.isFinite(cons?.VIS)?cons.VIS:null);
      const fogP=clip(corr.p,0,100);
      const mistP=clip(.48*mistSignal(visBase)+.24*saturationScore(corr.RH,corr.T,r.Td)+.18*(Number.isFinite(r.fog2m)?r.fog2m:0)+.10*visibilitySignal(cons?.VIS),0,100);
      let vis=visBase;
      if(Number.isFinite(cons?.VIS)&&Number.isFinite(visBase))vis=.7*visBase+.3*cons.VIS;
      fogSeries.push({t:r.t,fogP,mistP,vis,RH:corr.RH,T:corr.T,dmiFog:r.fog2m,dmiVis:r.VIS,consVis:cons?.VIS,calibrated:corr.active});
    }
  }

  function confidence(rows){
    if(!rows.length)return 'brak';let n=0,agree=0;
    for(const x of rows.slice(0,12)){if(Number.isFinite(x.dmiVis)&&Number.isFinite(x.consVis)&&x.dmiVis>0&&x.consVis>0){n++;const ratio=Math.max(x.dmiVis,x.consVis)/Math.min(x.dmiVis,x.consVis);if(ratio<2.2)agree++;}}
    if(rows.some(x=>x.calibrated)&&n>=4&&agree/n>.65)return 'wysoka';if(n>=4&&agree/n>.5)return 'średnia';return 'ograniczona';
  }
  function riskWindow(rows){
    if(!rows.length)return {text:'—',max:null};const mx=Math.max(...rows.map(x=>x.fogP)),thr=Math.max(45,mx-15);const sel=rows.filter(x=>x.fogP>=thr);
    if(!sel.length)return {text:'brak istotnego',max:mx};const a=sel[0],b=sel[sel.length-1];return {text:localHour(a.t)+(b.t!==a.t?'–'+localHour(b.t):''),max:mx};
  }
  function riskClass(p){return p>=65?'fog-risk-high':p>=35?'fog-risk-mid':'fog-risk-low';}

  function renderFog(){
    ensurePanel();const sum=document.getElementById('fogSummary'),strip=document.getElementById('fogStrip'),hours=document.getElementById('fogHours'),source=document.getElementById('fogSource');
    if(dmiError){sum.innerHTML=`<div class="fog-card"><small>DMI HARMONIE</small><strong>Brak danych</strong><em class="fog-error">${String(dmiError).replace(/[<>]/g,'')}</em></div>`;strip.hidden=true;return;}
    if(!fogSeries.length){sum.innerHTML='<div class="fog-card"><small>Status</small><strong>Ładowanie…</strong></div>';strip.hidden=true;return;}
    const now=Date.now(),future=fogSeries.filter(x=>x.t>=now-HOUR&&x.t<=now+18*HOUR),first=future[0]||fogSeries[0],rw=riskWindow(future),conf=confidence(future);
    const visKm=Number.isFinite(first.vis)?first.vis/1000:null;
    const cal=future.some(x=>x.calibrated);
    source.textContent='DMI HARMONIE-AROME 2 km + konsensus'+(cal?' + korekta lokalna':'');
    sum.innerHTML=`
      <div class="fog-card ${riskClass(first.fogP)}"><small>Mgła FG · VIS &lt;1 km</small><strong>${pct(first.fogP)}%</strong><em>${localDateTime(first.t)}</em></div>
      <div class="fog-card ${riskClass(first.mistP)}"><small>BR · VIS 1–5 km</small><strong>${pct(first.mistP)}%</strong><em>ryzyko zamglenia</em></div>
      <div class="fog-card"><small>Prognozowana widzialność</small><strong>${visKm===null?'—':(visKm<10?visKm.toFixed(1):Math.round(visKm))+' km'}</strong><em>DMI + konsensus${cal?' + korekta':''}</em></div>
      <div class="fog-card ${riskClass(rw.max||0)}"><small>Największe ryzyko 0–18 h</small><strong>${rw.max===null?'—':Math.round(rw.max)+'%'}</strong><em>${rw.text} · pewność ${conf}</em></div>`;
    const rows=fogSeries.filter(x=>x.t>=now-HOUR&&x.t<=now+12*HOUR);
    hours.innerHTML=rows.map(x=>`<div class="fog-hour ${riskClass(x.fogP)}"><b>${localHour(x.t)}</b><div class="p">FG ${Math.round(x.fogP)}%</div><small>BR ${Math.round(x.mistP)}%</small><small>VIS ${Number.isFinite(x.vis)?(x.vis/1000<10?(x.vis/1000).toFixed(1):Math.round(x.vis/1000)):'—'} km</small><small>RH ${Number.isFinite(x.RH)?Math.round(x.RH):'—'}%</small></div>`).join('');
    strip.hidden=false;
  }

  // Keep the fog card synchronized whenever the base meteogram finishes a refresh.
  if (typeof render === 'function') {
    const baseRender=render;
    render=function(){const out=baseRender();setTimeout(()=>{buildFogSeries();renderFog();},0);return out;};
  }
  document.getElementById('refresh')?.addEventListener('click',()=>setTimeout(fetchDmi,120));

  const version=document.querySelector('.brand small');if(version)version.textContent=VERSION;
  ensurePanel();fetchDmi();
  window.PrognozaEPIRFog={reload:fetchDmi,series:()=>fogSeries.slice(),observations:getObservations};
})();
