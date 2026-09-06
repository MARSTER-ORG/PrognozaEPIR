'use strict';
(() => {
  if (typeof PLACE === 'undefined') return;

  const VERSION = 'v0.10.18 HTML';
  const HOUR = 3600e3;
  const DMI_MODEL = 'dmi_harmonie_arome_europe';
  const OBS_KEY = 'prognozaepir-fog-observations-v2';
  const LEGACY_OBS_KEY = 'prognozaepir-fog-observations-v1';
  const MAX_OBS = 40;
  const PROBABLE = 50;
  const VERY_PROBABLE = 75;
  const DMI_VARS = [
    'temperature_2m','relative_humidity_2m','dew_point_2m','visibility',
    'cloud_cover_2m','cloud_cover_low','wind_speed_10m','wind_gusts_10m',
    'precipitation','shortwave_radiation','is_day'
  ];

  let dmiRows = [];
  let fogSeries = [];
  let dmiError = '';
  let busy = false;

  const clip = (v,a,b) => Math.max(a,Math.min(b,v));
  const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
  const pct = v => Number.isFinite(v) ? Math.round(clip(v,0,100)) : null;
  const fmtM = v => Number.isFinite(v) ? Math.max(0,Math.round(v)) + ' m' : '—';

  function lerp(a,b,q){ return a+(b-a)*q; }
  function ramp(v,a,b,outA=0,outB=100){
    if (!Number.isFinite(v)) return 0;
    if (v <= a) return outA;
    if (v >= b) return outB;
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
  function rhFromTempDew(T,Td){
    if(!Number.isFinite(T)||!Number.isFinite(Td)) return null;
    const a=17.625,b=243.04;
    const e=Math.exp((a*Td)/(b+Td));
    const es=Math.exp((a*T)/(b+T));
    return clip(100*e/es,0,100);
  }
  function riskLabel(p){
    if(!Number.isFinite(p)) return 'brak danych';
    if(p >= 90) return 'skrajnie wysokie';
    if(p >= VERY_PROBABLE) return 'bardzo prawdopodobna';
    if(p >= PROBABLE) return 'prawdopodobna';
    if(p >= 30) return 'możliwa';
    if(p >= 15) return 'mało prawdopodobna';
    return 'bardzo mało prawdopodobna';
  }
  function riskClass(p){ return p>=VERY_PROBABLE?'fog-risk-high':(p>=PROBABLE?'fog-risk-mid':'fog-risk-low'); }

  function addStyles(){
    if(document.getElementById('fogEngineStyle')) return;
    const s=document.createElement('style'); s.id='fogEngineStyle';
    s.textContent=`
      .fog-engine{margin-top:6px;border:1px solid var(--border);background:var(--surface);border-radius:4px;padding:9px 10px;font-size:10px;line-height:1.35}
      .fog-head{display:flex;justify-content:space-between;gap:8px;align-items:center;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:7px}
      .fog-head b{color:var(--blueText);font-size:12px}.fog-head span{color:var(--muted);font-size:9px;text-align:right}
      .fog-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;margin-bottom:7px}
      .fog-card{background:var(--soft);border-left:3px solid var(--blueText);padding:6px 7px;min-width:0}
      .fog-card small{display:block;color:var(--muted);font-size:8px}.fog-card strong{display:block;font-size:12px;margin-top:1px}.fog-card em{display:block;color:var(--muted);font-style:normal;font-size:8px;margin-top:1px}
      .fog-strip{overflow-x:auto;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:6px 0;padding:5px 0}
      .fog-hours{display:flex;min-width:max-content;gap:4px}.fog-hour{width:82px;background:var(--soft);border:1px solid var(--border);border-radius:4px;padding:4px;text-align:center}
      .fog-hour b{display:block;font-size:9px}.fog-hour .p{font-size:11px;font-weight:700;margin:2px 0}.fog-hour small{display:block;color:var(--muted);font-size:8px}
      .fog-risk-low{border-left-color:#6f8b95}.fog-risk-mid{border-left-color:#d49a28}.fog-risk-high{border-left-color:#d0503f}
      .fog-thresholds{margin:6px 0;padding:5px 7px;background:var(--soft);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:8.5px}
      .fog-thresholds b{color:var(--ink)}
      .fog-observe{margin-top:7px}.fog-observe summary{cursor:pointer;color:var(--blueText);font-weight:700}
      .fog-form{display:grid;grid-template-columns:1.4fr repeat(3,1fr) auto;gap:5px;margin-top:6px;align-items:end}
      .fog-form label{color:var(--muted);font-size:8px}.fog-form input{width:100%;margin-top:2px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:4px;padding:5px;font-size:10px}.fog-form button{border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:5px;padding:6px 8px;font-size:9px}
      .fog-note{color:var(--muted);font-size:8px;margin-top:5px}.fog-obs-list{color:var(--muted);font-size:8px;margin-top:4px}.fog-error{color:var(--errorText);font-size:9px}
      @media(max-width:700px){.fog-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.fog-form{grid-template-columns:repeat(2,minmax(0,1fr))}.fog-form button{min-height:31px}.fog-engine{padding:7px}.fog-hour{width:76px}}
    `;
    document.head.appendChild(s);
  }

  function ensurePanel(){
    addStyles();
    let el=document.getElementById('fogEngine');
    if(el) return el;
    el=document.createElement('section'); el.id='fogEngine'; el.className='fog-engine';
    el.innerHTML=`
      <div class="fog-head"><b>FOG / VIS — mgła i widzialność</b><span id="fogSource">DMI HARMONIE-AROME 2 km + konsensus</span></div>
      <div id="fogSummary" class="fog-summary"><div class="fog-card"><small>Status</small><strong>Ładowanie…</strong></div></div>
      <div class="fog-thresholds"><b>Skala PrognozaEPIR:</b> od ${PROBABLE}% mgła = <b>prawdopodobna</b>, od ${VERY_PROBABLE}% = <b>bardzo prawdopodobna</b>. WMO definiuje mgłę przez widzialność &lt;1000 m; procent poniżej jest naszym indeksem prognostycznym, nie oficjalną probabilistyką DMI.</div>
      <div id="fogStrip" class="fog-strip" hidden><div id="fogHours" class="fog-hours"></div></div>
      <details class="fog-observe"><summary>Dodaj rzeczywistą obserwację do lokalnej korekty</summary>
        <div class="fog-form">
          <label>Godzina<input id="fogObsTime" type="datetime-local"></label>
          <label>Temperatura °C<input id="fogObsT" type="number" step="0.1" inputmode="decimal"></label>
          <label>Punkt rosy °C<input id="fogObsTd" type="number" step="0.1" inputmode="decimal"></label>
          <label>Widzialność m<input id="fogObsVis" type="number" min="20" max="50000" step="50" inputmode="numeric"></label>
          <button id="fogObsSave" type="button">Zapisz</button>
        </div>
        <div id="fogObsList" class="fog-obs-list"></div>
        <div class="fog-note">Temperatura i punkt rosy pozwalają wyliczyć lokalną wilgotność oraz depresję T−Td. Widzialność wpisuj w metrach. Korekta obserwacyjna wygasa stopniowo w ciągu 12 h.</div>
      </details>`;
    const ref=document.getElementById('sectionInfo');
    if(ref?.parentNode) ref.parentNode.insertBefore(el,ref.nextSibling); else document.querySelector('.app')?.appendChild(el);
    document.getElementById('fogObsSave')?.addEventListener('click',saveObservation);
    setDefaultObsTime(); renderObservationList();
    return el;
  }

  function localInputValue(ms){
    const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:PLACE.tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(ms));
    const o={}; for(const p of parts)o[p.type]=p.value;
    return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
  }
  function parseLocalInput(value){
    if(!value) return NaN;
    return Date.parse(value);
  }
  function setDefaultObsTime(){ const x=document.getElementById('fogObsTime'); if(x&&!x.value)x.value=localInputValue(Date.now()); }

  function getObservations(){
    try{const a=JSON.parse(localStorage.getItem(OBS_KEY)||'[]');return Array.isArray(a)?a.filter(o=>Number.isFinite(o.t)).slice(-MAX_OBS):[];}catch(_){return[];}
  }
  function putObservations(a){ try{localStorage.setItem(OBS_KEY,JSON.stringify(a.slice(-MAX_OBS)));}catch(_){} }
  function latestObservation(){
    const now=Date.now()+10*60e3;
    return getObservations().filter(o=>o.t<=now).sort((a,b)=>b.t-a.t)[0]||null;
  }
  function saveObservation(){
    const t=parseLocalInput(document.getElementById('fogObsTime')?.value);
    const T=num(document.getElementById('fogObsT')?.value);
    const Td=num(document.getElementById('fogObsTd')?.value);
    const visM=num(document.getElementById('fogObsVis')?.value);
    if(!Number.isFinite(t)||T===null||Td===null||visM===null||visM<=0||Td>T+1){
      alert('Podaj godzinę, temperaturę, temperaturę punktu rosy oraz widzialność w metrach. Punkt rosy nie powinien być wyższy od temperatury o więcej niż około 1°C.');return;
    }
    const a=getObservations(); a.push({t,T,Td,visM,created:Date.now()}); putObservations(a);
    renderObservationList(); buildFogSeries(); renderFog();
  }
  function renderObservationList(){
    const el=document.getElementById('fogObsList'); if(!el)return;
    const a=getObservations();
    if(!a.length){el.textContent='Brak zapisanych obserwacji.';return;}
    const o=a[a.length-1],rh=rhFromTempDew(o.T,o.Td);
    el.innerHTML=`Ostatnia: <b>${localDateTime(o.t)}</b> · T ${o.T.toFixed(1)}°C · Td ${o.Td.toFixed(1)}°C · RH≈${rh===null?'—':Math.round(rh)+'%'} · VIS ${Math.round(o.visM)} m <button id="fogObsClear" type="button" style="margin-left:5px">Wyczyść</button>`;
    document.getElementById('fogObsClear')?.addEventListener('click',()=>{putObservations([]);renderObservationList();buildFogSeries();renderFog();});
  }

  async function fetchDmi(){
    if(busy)return;busy=true;dmiError='';ensurePanel();
    const q=new URLSearchParams({latitude:String(PLACE.lat),longitude:String(PLACE.lon),hourly:DMI_VARS.join(','),models:DMI_MODEL,timezone:'UTC',forecast_hours:'60',past_hours:'3',wind_speed_unit:'ms'});
    try{
      const r=await fetch('https://api.open-meteo.com/v1/forecast?'+q,{cache:'no-store'});
      const j=await r.json().catch(()=>null);
      if(!r.ok||!j?.hourly?.time)throw new Error(j?.reason||j?.message||('HTTP '+r.status));
      const h=j.hourly;
      dmiRows=(h.time||[]).map((s,i)=>({
        t:parseUtc(s),T:num(h.temperature_2m?.[i]),RH:num(h.relative_humidity_2m?.[i]),Td:num(h.dew_point_2m?.[i]),VIS:num(h.visibility?.[i]),
        fog2m:num(h.cloud_cover_2m?.[i]),low:num(h.cloud_cover_low?.[i]),WS:num(h.wind_speed_10m?.[i]),G:num(h.wind_gusts_10m?.[i]),
        RR:num(h.precipitation?.[i]),SW:num(h.shortwave_radiation?.[i]),isDay:num(h.is_day?.[i])
      })).filter(x=>Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);
    }catch(e){dmiRows=[];dmiError=e?.message||String(e);}finally{busy=false;buildFogSeries();renderFog();}
  }

  function nearest(arr,t,maxDiff=75*60e3){
    if(!arr?.length)return null;let best=null,bd=Infinity;
    for(const x of arr){const d=Math.abs(x.t-t);if(d<bd){best=x;bd=d;}}
    return bd<=maxDiff?best:null;
  }
  function consensusAt(t){ try{return nearest(typeof consensus!=='undefined'?consensus:[],t);}catch(_){return null;} }

  function visibilityFogScore(vis){
    if(!Number.isFinite(vis))return 0;
    if(vis<=300)return 100;if(vis<=600)return ramp(vis,300,600,100,95);if(vis<=1000)return ramp(vis,600,1000,95,82);
    if(vis<=2000)return ramp(vis,1000,2000,82,48);if(vis<=5000)return ramp(vis,2000,5000,48,16);if(vis<=10000)return ramp(vis,5000,10000,16,3);return 0;
  }
  function visibilityMistScore(vis){
    if(!Number.isFinite(vis))return 0;
    if(vis<700)return 25;if(vis<1000)return ramp(vis,700,1000,25,70);if(vis<=1800)return ramp(vis,1000,1800,78,100);
    if(vis<=3500)return 100;if(vis<=5000)return ramp(vis,3500,5000,100,55);if(vis<=8000)return ramp(vis,5000,8000,55,0);return 0;
  }
  function saturationScore(RH,T,Td){
    const dep=Number.isFinite(T)&&Number.isFinite(Td)?Math.max(-0.5,T-Td):null;
    const rh=Number.isFinite(RH)?ramp(RH,82,99,0,100):(Number.isFinite(dep)?ramp(dep,5,.2,0,100):0);
    const ds=!Number.isFinite(dep)?0:(dep<=.3?100:dep<=1?ramp(dep,.3,1,100,88):dep<=3?ramp(dep,1,3,88,25):dep<=5?ramp(dep,3,5,25,0):0);
    return .55*rh+.45*ds;
  }
  function windScore(ws){
    if(!Number.isFinite(ws))return 45;
    if(ws<.2)return 50;if(ws<=1.2)return ramp(ws,.2,1.2,72,100);if(ws<=3)return 100;if(ws<=5)return ramp(ws,3,5,100,55);if(ws<=7)return ramp(ws,5,7,55,15);return 3;
  }
  function wetScore(t){
    let sum=0,n=0;for(const r of dmiRows){if(r.t<t-4*HOUR||r.t>t)continue;if(Number.isFinite(r.RR)){sum+=Math.max(0,r.RR);n++;}}
    if(!n)return 25;if(sum>=2)return 100;if(sum>=.5)return 82;if(sum>=.1)return 58;return 18;
  }
  function nightScore(r){
    if(r?.isDay===0)return 100;
    if(Number.isFinite(r?.SW)&&r.SW<20)return 80;
    if(Number.isFinite(r?.SW)&&r.SW<80)return 45;
    return 10;
  }

  function rawFog(r,cons){
    const direct=Number.isFinite(r.fog2m)?clip(r.fog2m,0,100):0;
    const visDmi=visibilityFogScore(r.VIS);
    const visCons=visibilityFogScore(cons?.VIS);
    const sat=saturationScore(r.RH,r.T,r.Td);
    const wind=windScore(r.WS);
    const low=Number.isFinite(r.low)?clip(r.low,0,100):0;
    const wet=wetScore(r.t),night=nightScore(r);
    let score=.42*direct+.17*visDmi+.10*visCons+.14*sat+.06*wind+.04*low+.04*wet+.03*night;
    const dep=Number.isFinite(r.T)&&Number.isFinite(r.Td)?r.T-r.Td:null;
    if(direct<5 && sat>88 && wind>65 && night>70) score=Math.max(score,32+0.28*(sat-88));
    if(Number.isFinite(dep)&&dep<.8&&Number.isFinite(r.RH)&&r.RH>=96&&r.WS<=3.5) score=Math.max(score,45);
    if(Number.isFinite(r.VIS)&&r.VIS<1000) score=Math.max(score,78);
    if(Number.isFinite(cons?.VIS)&&cons.VIS<1000) score=Math.max(score,65);
    if(Number.isFinite(r.RH)&&r.RH<82) score*=.55;
    if(Number.isFinite(dep)&&dep>4) score*=.55;
    if(Number.isFinite(r.WS)&&r.WS>7) score*=.5;
    return clip(score,0,100);
  }

  function rawMist(r,cons,fog){
    const vd=visibilityMistScore(r.VIS),vc=visibilityMistScore(cons?.VIS),sat=saturationScore(r.RH,r.T,r.Td),low=Number.isFinite(r.low)?r.low:0;
    let score=.32*vd+.16*vc+.24*sat+.12*windScore(r.WS)+.08*low+.08*nightScore(r);
    if(fog>=75) score*=.55;
    return clip(score,0,100);
  }

  function predictedVisibility(r,cons,fog,mist){
    const vals=[];
    if(Number.isFinite(r.VIS))vals.push([r.VIS,.62]);
    if(Number.isFinite(cons?.VIS))vals.push([cons.VIS,.38]);
    let vis=vals.length?vals.reduce((s,x)=>s+x[0]*x[1],0)/vals.reduce((s,x)=>s+x[1],0):null;
    if(!Number.isFinite(vis))vis=fog>=75?700:fog>=50?1400:mist>=50?3500:12000;
    if(fog>=85)vis=Math.min(vis,800); else if(fog>=75)vis=Math.min(vis,1200); else if(fog>=50)vis=Math.min(vis,2500);
    return clip(vis,50,50000);
  }

  function localCorrection(t,base){
    const o=latestObservation(); if(!o)return base;
    const age=Math.max(0,t-o.t); if(age>12*HOUR)return base;
    const model=nearest(dmiRows,o.t,90*60e3),cons=consensusAt(o.t); if(!model)return base;
    const decay=Math.exp(-age/(6*HOUR));
    const rhObs=rhFromTempDew(o.T,o.Td),depObs=o.T-o.Td;
    const depModel=Number.isFinite(model.T)&&Number.isFinite(model.Td)?model.T-model.Td:null;
    let delta=0;
    if(Number.isFinite(rhObs)&&Number.isFinite(model.RH))delta+=clip((rhObs-model.RH)*1.0,-15,15);
    if(Number.isFinite(depModel))delta+=clip((depModel-depObs)*8,-18,18);
    const modelVis=Number.isFinite(model.VIS)?model.VIS:cons?.VIS;
    if(Number.isFinite(modelVis)&&o.visM>0){const ratio=modelVis/o.visM;delta+=clip(Math.log(Math.max(.1,ratio))*14,-22,22);}
    const fog=clip(base.fog+delta*decay,0,100);
    const mist=clip(base.mist+delta*.65*decay,0,100);
    let vis=base.vis;
    if(Number.isFinite(modelVis)&&o.visM>0&&Number.isFinite(vis)){
      const ratio=clip(o.visM/modelVis,.2,5);vis=clip(vis*Math.pow(ratio,decay),50,50000);
    }
    return {...base,fog,mist,vis,obsDecay:decay};
  }

  function buildFogSeries(){
    fogSeries=[];
    for(const r of dmiRows){
      const cons=consensusAt(r.t);
      let fog=rawFog(r,cons),mist=rawMist(r,cons,fog),vis=predictedVisibility(r,cons,fog,mist);
      const corrected=localCorrection(r.t,{fog,mist,vis}); fog=corrected.fog;mist=corrected.mist;vis=corrected.vis;
      const confidence=clip(45+(Number.isFinite(r.fog2m)?22:0)+(Number.isFinite(r.VIS)?13:0)+(Number.isFinite(cons?.VIS)?10:0)+(corrected.obsDecay?10*corrected.obsDecay:0),0,100);
      fogSeries.push({t:r.t,fog,mist,vis,confidence,dmiFog:r.fog2m,dmiVis:r.VIS,RH:r.RH,T:r.T,Td:r.Td,WS:r.WS,consVis:cons?.VIS,corrected:Boolean(corrected.obsDecay)});
    }
  }

  function renderFog(){
    ensurePanel();
    const summary=document.getElementById('fogSummary'),strip=document.getElementById('fogStrip'),hours=document.getElementById('fogHours'),source=document.getElementById('fogSource');
    if(dmiError){summary.innerHTML=`<div class="fog-card"><small>DMI</small><strong>Brak danych</strong><em>${String(dmiError).replace(/[<>]/g,'')}</em></div>`;if(strip)strip.hidden=true;return;}
    const now=Date.now(),future=fogSeries.filter(x=>x.t>=now-HOUR&&x.t<=now+18*HOUR);
    if(!future.length){summary.innerHTML='<div class="fog-card"><small>Status</small><strong>Brak danych FOG/VIS</strong></div>';if(strip)strip.hidden=true;return;}
    const current=future.reduce((a,b)=>Math.abs(b.t-now)<Math.abs(a.t-now)?b:a,future[0]);
    const peak=future.reduce((a,b)=>b.fog>a.fog?b:a,future[0]);
    const minVis=future.reduce((a,b)=>b.vis<a.vis?b:a,future[0]);
    const obs=latestObservation();
    summary.innerHTML=`
      <div class="fog-card ${riskClass(current.fog)}"><small>Mgła FG &lt;1000 m</small><strong>${pct(current.fog)}%</strong><em>${riskLabel(current.fog)}</em></div>
      <div class="fog-card ${riskClass(current.mist)}"><small>Zamglenie BR 1–5 km</small><strong>${pct(current.mist)}%</strong><em>${riskLabel(current.mist)}</em></div>
      <div class="fog-card"><small>Prognozowana VIS</small><strong>${fmtM(current.vis)}</strong><em>DMI ${fmtM(current.dmiVis)}</em></div>
      <div class="fog-card"><small>DMI mgła 2 m</small><strong>${pct(current.dmiFog)===null?'—':pct(current.dmiFog)+'%'}</strong><em>natywna frakcja mgły</em></div>
      <div class="fog-card"><small>Maks. FG / min VIS 18 h</small><strong>${pct(peak.fog)}% · ${localHour(peak.t)}</strong><em>min VIS ${fmtM(minVis.vis)} · ${localHour(minVis.t)}</em></div>`;
    if(source)source.textContent=`DMI HARMONIE-AROME 2 km + konsensus${obs?' + korekta obserwacyjna':''}`;
    if(hours){
      hours.innerHTML=future.slice(0,13).map(x=>`<div class="fog-hour ${riskClass(x.fog)}"><b>${localHour(x.t)}</b><div class="p">FG ${pct(x.fog)}%</div><small>${riskLabel(x.fog)}</small><small>BR ${pct(x.mist)}%</small><small>VIS ${fmtM(x.vis)}</small><small>DMI2m ${pct(x.dmiFog)===null?'—':pct(x.dmiFog)+'%'}</small></div>`).join('');
    }
    if(strip)strip.hidden=false;
  }

  function setVersion(){const v=document.querySelector('.brand small');if(v)v.textContent=VERSION;}
  function init(){ensurePanel();setVersion();fetchDmi();setInterval(fetchDmi,30*60e3);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
