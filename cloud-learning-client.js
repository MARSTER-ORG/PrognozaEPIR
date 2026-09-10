'use strict';

// Central observation bridge ------------------------------------------------
// Legacy callers of data/observations/latest.json and recent.json are mapped
// to the shared central MessageArchive. No bulletin provider is queried here.
(() => {
  const nativeFetch=window.fetch.bind(window);
  let archiveClientPromise=null;

  function archiveClient(){
    if(window.PrognozaEPIRMessageArchive)return Promise.resolve(window.PrognozaEPIRMessageArchive);
    if(archiveClientPromise)return archiveClientPromise;
    archiveClientPromise=new Promise((resolve,reject)=>{
      const ready=()=>window.PrognozaEPIRMessageArchive?resolve(window.PrognozaEPIRMessageArchive):reject(new Error('MessageArchive niedostępne'));
      const existing=document.querySelector('script[data-prognozaepir-message-archive="1"]');
      if(existing){
        window.addEventListener('prognozaepir:message-archive-ready',ready,{once:true});
        setTimeout(ready,2500);
        return;
      }
      const script=document.createElement('script');
      script.src='message-archive-client.js';
      script.dataset.prognozaepirMessageArchive='1';
      script.onload=ready;
      script.onerror=()=>reject(new Error('Nie można załadować message-archive-client.js'));
      document.head.appendChild(script);
    });
    return archiveClientPromise;
  }

  function obsKind(input){
    try{
      const raw=typeof input==='string'?input:(input?.url||'');
      const u=new URL(raw,location.href);
      if(u.pathname.endsWith('/data/observations/latest.json'))return 'latest';
      if(u.pathname.endsWith('/data/observations/recent.json'))return 'recent';
    }catch(_){ }
    return null;
  }

  window.fetch=async function(input,init){
    const kind=obsKind(input);
    if(!kind)return nativeFetch(input,init);
    try{
      const archive=await archiveClient();
      const body=kind==='latest'?await archive.latest(true):await archive.recent(true);
      return new Response(JSON.stringify(body),{
        status:200,
        headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, max-age=0','X-PrognozaEPIR-Source':'central-message-archive'}
      });
    }catch(e){
      console.warn('EPIR central MessageArchive bridge:',e);
      return nativeFetch(input,init);
    }
  };
})();

// Model snapshot + adaptive weights runtime -------------------------------
(() => {
  if (window.__PrognozaEPIRModelRuntimeInstalled) return;
  window.__PrognozaEPIRModelRuntimeInstalled = true;

  const previousFetch = window.fetch.bind(window);
  const RAW_ROOT = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/';
  const MODEL_SNAPSHOT_RAW = RAW_ROOT + 'data/runtime/models-latest.json';
  const ADAPTIVE_WEIGHTS_RAW = RAW_ROOT + 'data/learning/adaptive-weights.json';
  const SYNOPTIC_SKILL_RAW = RAW_ROOT + 'data/learning/synoptic-regime-skill.json';
  const HOUR = 3600000;
  let snapshot = null;
  let adaptive = null;
  let synopticSkill = null;
  let snapshotPromise = null;
  let adaptivePromise = null;
  let synopticPromise = null;

  async function jsonWithTimeout(url, timeoutMs=5000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const sep = url.includes('?') ? '&' : '?';
      const r = await previousFetch(url + sep + '_=' + Date.now(), {
        cache: 'no-store', signal: ctl.signal, headers: {Accept:'application/json'}
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function loadSnapshot() {
    if (!snapshotPromise) snapshotPromise = jsonWithTimeout(MODEL_SNAPSHOT_RAW, 5500)
      .then(j => {
        if (j?.schema !== 'prognozaepir-model-snapshot-v1') throw new Error('bad model snapshot schema');
        snapshot = j;
        window.PrognozaEPIRModelSnapshotState = {ok:true, generated_at:j.generated_at, models:Object.keys(j.models||{})};
        return j;
      })
      .catch(e => {
        console.warn('PrognozaEPIR model snapshot unavailable; live Open-Meteo fallback remains active', e);
        window.PrognozaEPIRModelSnapshotState = {ok:false, error:String(e?.message||e)};
        return null;
      });
    return snapshotPromise;
  }

  function loadAdaptive() {
    if (!adaptivePromise) adaptivePromise = jsonWithTimeout(ADAPTIVE_WEIGHTS_RAW, 5500)
      .then(j => {
        if (j?.schema !== 'prognozaepir-adaptive-weights-v1') throw new Error('bad adaptive weight schema');
        adaptive = j;
        return j;
      })
      .catch(e => {
        console.warn('PrognozaEPIR adaptive weights unavailable; base weights remain active', e);
        return null;
      });
    return adaptivePromise;
  }


  function loadSynopticSkill() {
    if (!synopticPromise) synopticPromise = jsonWithTimeout(SYNOPTIC_SKILL_RAW, 5500)
      .then(j => {
        if (j?.schema !== 'prognozaepir-synoptic-regime-learning-v1') throw new Error('bad synoptic skill schema');
        synopticSkill = j;
        return j;
      })
      .catch(e => {
        console.warn('PrognozaEPIR synoptic-regime skill unavailable; contextual factor stays neutral', e);
        synopticSkill = null;
        return null;
      });
    return synopticPromise;
  }

  function bucketForLead(h) {
    if (!Number.isFinite(h) || h < 0) return null;
    if (h < 3) return '0-3h';
    if (h < 6) return '3-6h';
    if (h < 12) return '6-12h';
    if (h < 24) return '12-24h';
    if (h < 48) return '24-48h';
    return '48-120h';
  }

  function componentForKey(key) {
    if (key === 'temperature_2m') return 'temperature';
    if (key === 'dew_point_2m') return 'dew_point';
    if (key === 'pressure_msl') return 'pressure';
    if (key === 'visibility') return 'visibility';
    if (key === 'wind_speed_10m' || key === 'wind_direction_10m' || key === 'wind_gusts_10m') return 'wind';
    if (key === 'precipitation' || key === 'weather_code') return 'precipitation';
    if (String(key||'').startsWith('cloud_cover')) return 'cloud';
    return null;
  }


  const SYNOPTIC_DIMENSION_WEIGHTS = {
    season:.25, daypart:.10, inflow_850:.25, stability_925:.20, moisture_low:.15, pressure_regime:.05
  };

  function clampNumber(v,a,b){ return Math.max(a,Math.min(b,v)); }

  function weightedContextMean(items,key) {
    let s=0,w=0;
    for (const i of items||[]) {
      const v=Number(i?.row?.[key]), ww=Number(i?.model?.w);
      if (Number.isFinite(v) && Number.isFinite(ww) && ww>0) { s+=v*ww; w+=ww; }
    }
    return w ? s/w : null;
  }

  function weightedContextDirection(items,key) {
    let sx=0,cy=0,w=0;
    for (const i of items||[]) {
      const d=Number(i?.row?.[key]), ww=Number(i?.model?.w);
      if (!Number.isFinite(d) || !Number.isFinite(ww) || ww<=0) continue;
      const r=d*Math.PI/180;
      sx+=Math.sin(r)*ww; cy+=Math.cos(r)*ww; w+=ww;
    }
    if (!w || Math.hypot(sx,cy)<1e-9) return null;
    return (Math.atan2(sx/w,cy/w)*180/Math.PI+360)%360;
  }

  function directionSector(deg) {
    if (!Number.isFinite(deg)) return null;
    const labels=['N','NE','E','SE','S','SW','W','NW'];
    return labels[Math.floor((((deg%360)+360)%360+22.5)/45)%8];
  }

  function localMonthHour(targetMs) {
    try {
      const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',month:'numeric',hour:'numeric',hourCycle:'h23'}).formatToParts(new Date(targetMs));
      const get=t=>Number(parts.find(p=>p.type===t)?.value);
      return {month:get('month'),hour:get('hour')};
    } catch (_) {
      const d=new Date(targetMs); return {month:d.getUTCMonth()+1,hour:d.getUTCHours()};
    }
  }

  function contextForItems(items,targetMs) {
    const {month,hour}=localMonthHour(targetMs);
    const season=([12,1,2].includes(month)?'winter':([3,4,5].includes(month)?'spring':([6,7,8].includes(month)?'summer':'autumn')));
    const daypart=hour<6?'night':(hour<12?'morning':(hour<18?'afternoon':'evening'));
    const wd850=weightedContextDirection(items,'wind_direction_850hPa');
    const t2=weightedContextMean(items,'temperature_2m');
    const t925=weightedContextMean(items,'temperature_925hPa');
    const z925=weightedContextMean(items,'geopotential_height_925hPa');
    const terrain=weightedContextMean((items||[]).map(i=>({model:i.model,row:{terrain:Number(i.elevation)}})),'terrain');
    let stability_925=null;
    if (Number.isFinite(t2) && Number.isFinite(t925)) {
      if (Number.isFinite(z925) && Number.isFinite(terrain) && z925>terrain+150) {
        const lapse=(t2-t925)/(z925-terrain)*1000;
        stability_925=lapse<0?'inversion':(lapse<4?'stable':(lapse<=8?'mixed_neutral':'unstable'));
      } else {
        const delta=t925-t2;
        stability_925=delta>=0?'inversion':(delta>=-3?'stable':(delta>=-7?'mixed_neutral':'unstable'));
      }
    }
    const rhs=[weightedContextMean(items,'relative_humidity_925hPa'),weightedContextMean(items,'relative_humidity_850hPa')].filter(Number.isFinite);
    let moisture_low=null;
    if (rhs.length) {
      const rh=rhs.reduce((a,b)=>a+b,0)/rhs.length;
      moisture_low=rh>=85?'very_moist_lower_troposphere':(rh>=70?'moist_lower_troposphere':(rh>=50?'moderate_lower_troposphere':'dry_lower_troposphere'));
    }
    const p=weightedContextMean(items,'pressure_msl');
    const pressure_regime=!Number.isFinite(p)?null:(p>=1022?'high_pressure_environment':(p<=1005?'low_pressure_environment':'intermediate_pressure'));
    return {season,daypart,inflow_850:directionSector(wd850),stability_925,moisture_low,pressure_regime};
  }

  function contextFactor(modelId,targetMs,key,ctx) {
    if (!ctx || !synopticSkill) return 1;
    const comp=componentForKey(key);
    const bucket=bucketForLead(Math.max(0,(Number(targetMs)-Date.now())/HOUR));
    const dims=bucket&&comp?synopticSkill?.models?.[modelId]?.lead_buckets?.[bucket]?.components?.[comp]?.dimensions:null;
    if (!dims) return 1;
    const weights=synopticSkill?.dimension_weights||SYNOPTIC_DIMENSION_WEIGHTS;
    let logSum=0,totalWeight=0;
    for (const [dim,defaultWeight] of Object.entries(SYNOPTIC_DIMENSION_WEIGHTS)) {
      const dw=Number(weights?.[dim]);
      const w=Number.isFinite(dw)&&dw>0?dw:defaultWeight;
      totalWeight+=w;
      const label=ctx?.[dim];
      const f=Number(label?dims?.[dim]?.[label]?.factor:null);
      if (Number.isFinite(f) && f>0) logSum+=Math.log(f)*w;
    }
    if (!totalWeight) return 1;
    return clampNumber(Math.exp(logSum/totalWeight),.85,1.15);
  }

  function rowFor(modelId, targetMs) {
    const leadH = Math.max(0, (Number(targetMs) - Date.now()) / HOUR);
    const bucket = bucketForLead(leadH);
    return bucket ? adaptive?.models?.[modelId]?.lead_buckets?.[bucket] || null : null;
  }

  function factor(modelId, targetMs, key=null) {
    const row = rowFor(modelId, targetMs);
    if (!row) return 1;
    const comp = componentForKey(key);
    const v = comp ? Number(row?.components?.[comp]?.weight_factor) : Number(row?.weight_factor);
    return Number.isFinite(v) ? Math.max(.70, Math.min(1.30, v)) : 1;
  }

  function relativeFactor(modelId, targetMs, key, ctx=null) {
    const overall = factor(modelId, targetMs, null);
    const specific = factor(modelId, targetMs, key);
    if (!Number.isFinite(overall) || overall <= 0) return 1;
    const contextual = contextFactor(modelId,targetMs,key,ctx);
    return Math.max(.70/1.30, Math.min(1.30/.70, (specific / overall) * contextual));
  }

  function snapshotResponse(url) {
    if (!snapshot?.models) return null;
    const modelId = url.searchParams.get('models');
    if (!modelId) return null;
    const model = snapshot.models[modelId];
    const sourceHourly = model?.hourly || {};
    const times = sourceHourly.time || [];
    if (!Array.isArray(times) || !times.length) return null;

    // Do not serve a snapshot that no longer reaches into the future.
    const last = Date.parse(String(times[times.length-1]||'') + (String(times[times.length-1]||'').endsWith('Z')?'':'Z'));
    if (!Number.isFinite(last) || last < Date.now() + 6*HOUR) return null;

    const vars = String(url.searchParams.get('hourly')||'').split(',').map(x=>x.trim()).filter(Boolean);
    const hourly = {time: times};
    const units = {};
    for (const v of vars) {
      if (Array.isArray(sourceHourly[v])) hourly[v] = sourceHourly[v];
      if (model?.hourly_units && Object.prototype.hasOwnProperty.call(model.hourly_units, v)) units[v] = model.hourly_units[v];
    }
    const body = {
      latitude: snapshot.location?.lat,
      longitude: snapshot.location?.lon,
      generationtime_ms: 0,
      utc_offset_seconds: 0,
      timezone: 'UTC',
      timezone_abbreviation: 'UTC',
      elevation: model.elevation,
      hourly_units: units,
      hourly
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-PrognozaEPIR-Model-Source':'repository-snapshot'}
    });
  }

  window.fetch = async function(input, init) {
    let u = null;
    try { u = new URL(typeof input === 'string' ? input : input?.url, location.href); } catch (_) { }
    if (u && u.hostname === 'api.open-meteo.com' && u.pathname === '/v1/forecast') {
      try {
        await loadSnapshot();
        const local = snapshotResponse(u);
        if (local) return local;
      } catch (e) {
        console.warn('model snapshot bridge:', e);
      }
    }
    return previousFetch(input, init);
  };

  window.PrognozaEPIRAdaptiveWeights = {
    load: loadAdaptive,
    loadSynoptic: loadSynopticSkill,
    factor,
    relativeFactor,
    contextFactor,
    contextForItems,
    componentForKey,
    get data(){ return adaptive; },
    get synopticData(){ return synopticSkill; }
  };

  loadSnapshot().catch(()=>{});
  loadAdaptive().catch(()=>{});
  loadSynopticSkill().catch(()=>{});

  // Cloud Learning already has its own cloud-specific factor. Multiply it by
  // the historical all-parameter cloud factor relative to the overall weight,
  // so the same archive affects both the general consensus and cloud profile.
  setTimeout(() => {
    const c = window.PrognozaEPIRCloudLearning;
    if (!c?.factor || c.__adaptiveWrapped) return;
    const base = c.factor.bind(c);
    c.factor = (modelId,targetMs) => base(modelId,targetMs) * relativeFactor(modelId,targetMs,'cloud_cover');
    c.__adaptiveWrapped = true;
  }, 0);
})();


// Cloud/model learning client ---------------------------------------------
(() => {
  const SKILL_URL='data/learning/cloud-skill.json';
  const HOUR=3600000;
  let skill=null;
  let hooksInstalled=false;

  function bucketForLead(h){
    if(h<0)return null;
    if(h<3)return '0-3h';
    if(h<6)return '3-6h';
    if(h<12)return '6-12h';
    if(h<24)return '12-24h';
    if(h<48)return '24-48h';
    return '48-120h';
  }

  async function loadSkill(){
    try{
      const r=await fetch(`${SKILL_URL}?v=${Date.now()}`,{cache:'no-store'});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const j=await r.json();
      if(j?.schema==='prognozaepir-cloud-learning-v1')skill=j;
    }catch(e){
      console.warn('Cloud Learning: skill unavailable',e);
      skill=null;
    }
    setTimeout(renderMetrics,0);
  }

  function factor(modelId,targetMs){
    if(!skill?.models?.[modelId])return 1;
    const leadH=Math.max(0,(targetMs-Date.now())/HOUR);
    const b=bucketForLead(leadH);
    const row=b?skill.models[modelId]?.lead_buckets?.[b]:null;
    const f=Number(row?.weight_factor);
    return Number.isFinite(f)?Math.max(.55,Math.min(1.8,f)):1;
  }

  function info(modelId,targetMs){
    const leadH=Math.max(0,(targetMs-Date.now())/HOUR);
    const b=bucketForLead(leadH);
    const row=b?skill?.models?.[modelId]?.lead_buckets?.[b]:null;
    return {bucket:b,factor:factor(modelId,targetMs),n:Number(row?.n)||0,mae:Number(row?.mae_okta)};
  }

  const finite=Number.isFinite;
  function numericOrNull(v){
    if(v===null||v===undefined||v==='')return null;
    const x=Number(v);
    return finite(x)?x:null;
  }

  function selectedModelKey(){
    try{
      return (typeof selected==='string'&&selected)?selected:'consensus';
    }catch(_){
      return 'consensus';
    }
  }

  function verification(){
    const key=selectedModelKey();
    const row=skill?.model_verification?.models?.[key]||null;
    if(!row)return {key,row:null,score:null,cloud:null,visibility:null};
    const comp=row.components||{};
    const overall=numericOrNull(row.score_pct);
    const cloudN=Number(comp.cloud?.n)||0;
    const visN=Number(comp.visibility?.n)||0;
    const cloud=numericOrNull(comp.cloud?.score_pct);
    const visibility=numericOrNull(comp.visibility?.score_pct);
    return {
      key,
      row,
      score:overall,
      cloud:cloudN>0?cloud:null,
      visibility:visN>0?visibility:null,
      samples:Number(row.forecast_samples)||0,
      cloudSamples:cloudN,
      visibilitySamples:visN
    };
  }

  function currentFogRow(){
    try{
      const a=window.PrognozaEPIRFogSeries;
      if(!Array.isArray(a)||!a.length)return null;
      const now=Date.now();
      let best=null,dist=Infinity;
      for(const r of a){
        if(!r||!finite(Number(r.t)))continue;
        const d=Math.abs(Number(r.t)-now);
        if(d<dist){dist=d;best=r;}
      }
      return best;
    }catch(_){return null;}
  }

  function pct(v){
    const x=numericOrNull(v);
    return x===null?'—':Math.round(x)+'%';
  }

  function hideLegacyMetrics(){
    const box=document.getElementById('models');
    if(!box)return;
    box.innerHTML='';
    box.hidden=true;
  }

  function renderFogMetrics(){
    const box=document.getElementById('fogDataNote');
    if(!box)return false;
    const fog=currentFogRow();
    const v=verification();
    const fogData=numericOrNull(fog?.data);
    const fogAgreement=numericOrNull(fog?.agreement);
    const availability=fogData===null?null:fogData*100;
    const agreement=fogAgreement===null?null:fogAgreement*100;
    box.innerHTML=
      '<div><b>Dostępność danych:</b> '+pct(availability)+'.</div>'+
      '<div><b>Zgodność modeli:</b> '+pct(agreement)+'.</div>'+
      '<div><b>Sprawdzalność modelu z realnymi danymi:</b> '+pct(v.score)+'.</div>'+
      '<div><b>Sprawdzalność sekcji Chmury:</b> '+pct(v.cloud)+'.</div>'+
      '<div><b>Sprawdzalność sekcji Widzialność:</b> '+pct(v.visibility)+'.</div>';
    box.dataset.verificationModel=v.key;
    box.dataset.verificationSamples=String(v.samples||0);
    box.dataset.cloudVerificationSamples=String(v.cloudSamples||0);
    box.dataset.visibilityVerificationSamples=String(v.visibilitySamples||0);
    return true;
  }

  function renderMetrics(){
    hideLegacyMetrics();
    renderFogMetrics();
  }

  function scheduleRender(){setTimeout(renderMetrics,0);}

  function installMetrics(){
    try{
      hideLegacyMetrics();
      if(typeof render==='function'&&!window.__epirModelMetricsWrapped){
        const baseRender=render;
        render=function(){
          const out=baseRender.apply(this,arguments);
          scheduleRender();
          return out;
        };
        window.__epirModelMetricsWrapped=true;
      }
      const view=document.getElementById('view');
      if(view&&!view.dataset.modelMetricsHook){
        view.dataset.modelMetricsHook='1';
        view.addEventListener('change',scheduleRender);
      }
      document.querySelectorAll('button[data-h]').forEach(b=>{
        if(b.dataset.modelMetricsHook)return;
        b.dataset.modelMetricsHook='1';
        b.addEventListener('click',scheduleRender);
      });
      if(!hooksInstalled){
        window.addEventListener('prognozaepir:fog-series-updated',scheduleRender);
        hooksInstalled=true;
      }
      renderMetrics();
      setTimeout(renderMetrics,1200);
      setTimeout(renderMetrics,4500);
    }catch(_){ }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(installMetrics,0),{once:true});
  else setTimeout(installMetrics,0);

  window.PrognozaEPIRCloudLearning={loadSkill,factor,info,getSkill:()=>skill,verification,renderMetrics};
})();
