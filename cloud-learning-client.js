'use strict';

// Live METAR bridge ---------------------------------------------------------
// The page must not depend on GitHub Actions to display the current EPIR METAR.
// IMGW's aviation frontend itself uses aviation-api.imgw.pl, so we query the
// same API from the browser and merge the newest EPIR report over the static
// GitHub Pages cache. If the live call fails, the original repository cache is
// returned unchanged.
(() => {
  const IMGW_API='https://aviation-api.imgw.pl/data/last?params=metar,taf&format=json&count=4';
  const nativeFetch=window.fetch.bind(window);
  let livePromise=null;
  let livePromiseAt=0;
  let lastLive=null;

  const finite=Number.isFinite;
  const n=v=>finite(Number(v))?Number(v):null;

  function rh(T,Td){
    T=n(T);Td=n(Td);if(T===null||Td===null)return null;
    const a=17.625,b=243.04;
    const x=Math.exp((a*Td)/(b+Td)-(a*T)/(b+T))*100;
    return Math.max(0,Math.min(100,Math.round(x*10)/10));
  }

  function wxFlags(raw){
    const s=` ${String(raw||'').toUpperCase().replace(/=/g,' ')} `;
    const has=c=>new RegExp(`\\s${c}(?=\\s|$)`).test(s);
    const weather=['MIFG','FZFG','BCFG','PRFG','FG','BR','TSRA','TS','SHRA','RA','SN','DZ','HZ']
      .filter(has);
    return {
      weather:weather.join(' ')||null,
      fog:has('FG')||has('BCFG')||has('PRFG'),
      mist:has('BR'),
      freezing_fog:has('FZFG')
    };
  }

  function reportType(message){
    return /^\\s*SPECI\\b/i.test(String(message||''))?'SPECI':'METAR';
  }

  function decodeRecord(rec){
    const message=String(rec?.message||'').replace(/\\s+/g,' ').trim();
    if(!/\\bEPIR\\s+\\d{6}Z\\b/i.test(message))return null;
    const obs=Date.parse(rec?.date||'');
    if(!finite(obs))return null;

    const visToken=(message.match(/\\b(CAVOK|9999|\\d{4})\\b/i)||[])[1]||null;
    const lower=Boolean(visToken&&/^(?:CAVOK|9999)$/i.test(visToken));
    let vis=null;
    if(lower)vis=10000;
    else if(/^\\d{4}$/.test(visToken||''))vis=Number(visToken);
    else {
      const vv=n(rec?.visibility?.value);
      const unit=String(rec?.visibility?.unit||'').toLowerCase();
      if(vv!==null)vis=unit.includes('km')?vv*1000:vv;
    }
    if(vis===null||vis<0)return null;

    const clouds=(Array.isArray(rec?.cloud)?rec.cloud:[]).map(c=>{
      const ft=n(c?.height),cover=String(c?.quantity||'').toUpperCase()||null;
      return {
        cover,
        base_ft_agl:ft,
        base_m_agl:ft===null?null:Math.round(ft*0.3048)
      };
    });
    const ceiling=clouds
      .filter(c=>['BKN','OVC','VV'].includes(c.cover)&&finite(c.base_m_agl))
      .map(c=>c.base_m_agl)
      .sort((a,b)=>a-b)[0]??null;

    const T=n(rec?.temperature),Td=n(rec?.dewPoint);
    const windKt=n(rec?.wind?.speed),gustKt=n(rec?.wind?.gust);
    const flags=wxFlags(message);
    const raw=message.replace(/^\\s*(?:METAR|SPECI)\\s+/i,'').replace(/\\s*=\\s*$/,'').trim();
    return {
      station:'EPIR',
      obs_time:new Date(obs).toISOString().replace('.000Z','Z'),
      report_type:reportType(message),
      source:'IMGW_AVIATION_LIVE',
      raw,
      temperature_c:T,
      dew_point_c:Td,
      relative_humidity_pct:rh(T,Td),
      visibility_m:vis,
      visibility_lower_bound:lower,
      visibility_upper_bound:false,
      visibility_report:visToken||String(rec?.visibility?.mainVisibiity||rec?.visibility?.mainVisibility||'').trim()||null,
      wind_direction_deg:n(rec?.wind?.directionDegrees),
      wind_speed_ms:windKt===null?null:Math.round(windKt*0.514444*100)/100,
      wind_gust_ms:gustKt===null?null:Math.round(gustKt*0.514444*100)/100,
      pressure_hpa:n(rec?.altimeter),
      weather:flags.weather,
      fog:flags.fog,
      mist:flags.mist,
      freezing_fog:flags.freezing_fog,
      ceiling_m_agl:ceiling,
      clouds,
      imgw_api:'aviation-api.imgw.pl',
      imgw_api_date:rec?.date||null,
      imgw_api_file:rec?.file||null,
      imgw_api_message_type:rec?.messageType||null
    };
  }

  function walkRecords(v,out=[]){
    if(Array.isArray(v)){for(const x of v)walkRecords(x,out);return out;}
    if(v&&typeof v==='object'){
      if(typeof v.message==='string')out.push(v);
      for(const x of Object.values(v))walkRecords(x,out);
    }
    return out;
  }

  async function pullLive(){
    const now=Date.now();
    if(livePromise&&now-livePromiseAt<60*1000)return livePromise;
    livePromiseAt=now;
    livePromise=(async()=>{
      const ctl=new AbortController();
      const timer=setTimeout(()=>ctl.abort(),5500);
      try{
        const r=await nativeFetch(`${IMGW_API}&_=${Date.now()}`,{
          cache:'no-store',mode:'cors',signal:ctl.signal,
          headers:{Accept:'application/json'}
        });
        if(!r.ok)throw new Error(`IMGW HTTP ${r.status}`);
        const j=await r.json();
        const metars=j?.EPIR?.metars;
        const rows=walkRecords(metars).map(decodeRecord).filter(Boolean)
          .sort((a,b)=>Date.parse(b.obs_time)-Date.parse(a.obs_time));
        const fresh=rows.find(x=>{
          const age=Date.now()-Date.parse(x.obs_time);
          return age>=-10*60e3&&age<=90*60e3;
        })||rows[0]||null;
        if(fresh){
          lastLive=fresh;
          window.PrognozaEPIRLiveMetar={metar:fresh,reports:rows,updated_at:new Date().toISOString()};
        }
        return {metar:fresh,reports:rows};
      }catch(e){
        console.warn('EPIR live METAR: direct IMGW unavailable; using repository cache',e);
        return {metar:lastLive,reports:lastLive?[lastLive]:[]};
      }finally{clearTimeout(timer);}
    })();
    return livePromise;
  }

  function fusedFromMetar(m){
    if(!m)return null;
    const src=m.source||'IMGW_AVIATION_LIVE';
    return {
      obs_time:m.obs_time,
      metar_obs_time:m.obs_time,
      synop_obs_time:null,
      temperature_c:m.temperature_c,
      dew_point_c:m.dew_point_c,
      relative_humidity_pct:m.relative_humidity_pct,
      visibility_m:m.visibility_m,
      visibility_lower_bound:Boolean(m.visibility_lower_bound),
      visibility_upper_bound:Boolean(m.visibility_upper_bound),
      visibility_source:src,
      wind_direction_deg:m.wind_direction_deg,
      wind_speed_ms:m.wind_speed_ms,
      pressure_hpa:m.pressure_hpa,
      cloud_base_m_agl:m.ceiling_m_agl,
      fog:Boolean(m.fog),
      mist:Boolean(m.mist),
      freezing_fog:Boolean(m.freezing_fog),
      sources:{
        temperature:src,dew_point:src,rh:src,visibility:src,
        wind_direction:src,wind_speed:src,pressure:src,
        cloud_base:m.ceiling_m_agl==null?null:src
      }
    };
  }

  function mergeLatest(cache,live){
    if(!live)return cache;
    const old=cache?.metar||null;
    const lt=Date.parse(live.obs_time||''),ot=Date.parse(old?.obs_time||'');
    if(finite(ot)&&finite(lt)&&ot>lt)return cache;
    const out=cache&&typeof cache==='object'?JSON.parse(JSON.stringify(cache)):{};
    out.schema=out.schema||'epir-observation-latest-v2';
    out.station=out.station||{icao:'EPIR',synop:'12342',wigos:'0-20000-0-12342',lat:52.83,lon:18.33};
    out.metar=live;
    out.fused=fusedFromMetar(live);
    out.updated_at=live.obs_time;
    out.collected_at=new Date().toISOString();
    const age=Math.max(0,(Date.now()-lt)/60000);
    const prev=out.metar_freshness||{};
    out.metar_freshness={
      ...prev,
      status:age<=60?'ok':'stale',
      age_min:Math.round(age*10)/10,
      fresh_limit_min:60,
      live_direct:true,
      live_source:'aviation-api.imgw.pl',
      missing_routine_slots:Array.isArray(prev.missing_routine_slots)
        ?prev.missing_routine_slots.filter(x=>x!==live.obs_time):[]
    };
    return out;
  }

  function mergeRecent(cache,live){
    if(!live||!cache||typeof cache!=='object')return cache;
    const out=JSON.parse(JSON.stringify(cache));
    out.metar=Array.isArray(out.metar)?out.metar:[];
    const key=`${live.obs_time}|${live.raw}`;
    const seen=new Set(out.metar.map(x=>`${x?.obs_time}|${x?.raw}`));
    if(!seen.has(key))out.metar.push(live);
    out.metar.sort((a,b)=>Date.parse(a?.obs_time||0)-Date.parse(b?.obs_time||0));
    out.metar=out.metar.slice(-80);

    const f=fusedFromMetar(live);
    out.observations=Array.isArray(out.observations)?out.observations:[];
    const idx=out.observations.findIndex(x=>x?.obs_time===f.obs_time);
    if(idx>=0)out.observations[idx]=f;else out.observations.push(f);
    out.observations.sort((a,b)=>Date.parse(a?.obs_time||0)-Date.parse(b?.obs_time||0));
    out.observations=out.observations.slice(-80);
    return out;
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
      const [base,bundle]=await Promise.all([
        nativeFetch(input,{...(init||{}),cache:'no-store'}),
        pullLive()
      ]);
      if(!base.ok)return base;
      const cache=await base.json();
      const body=kind==='latest'?mergeLatest(cache,bundle?.metar):mergeRecent(cache,bundle?.metar);
      return new Response(JSON.stringify(body),{
        status:200,
        headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, max-age=0'}
      });
    }catch(e){
      console.warn('EPIR live METAR bridge:',e);
      return nativeFetch(input,init);
    }
  };

  // Warm the direct source once. Observation Engine will reuse the result when
  // it requests latest.json/recent.json during bootstrap.
  pullLive().catch(()=>{});
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
