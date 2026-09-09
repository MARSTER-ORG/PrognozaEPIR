'use strict';

// MTG LI Lightning Flashes (LFL) -> compact Cb evidence.
// LI AFA is deliberately NOT used. The browser consumes only aggregate
// flash features produced by the Railway collector; no raw flash feed is
// exposed to the page.
(() => {
  const ENDPOINT='https://central-ingestor-production.up.railway.app/data/lightning/latest.json';
  const REFRESH_MS=5*60*1000;
  const MAX_AGE_MS=22*60*1000;
  const $=id=>document.getElementById(id);
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,Number(v)||0));
  let features=null,loading=false,lastFetch=0;

  function ensureTile(){
    const grid=document.querySelector('#convectionNowcastCard .conv-grid');
    if(!grid||$('convLightning'))return;
    const tile=document.createElement('div');
    tile.className='conv-tile cb';
    tile.id='convLightningTile';
    tile.innerHTML='<small>Wyładowania · LI LFL</small><b id="convLightning">—</b><span id="convLightningSub">rzeczywiste błyski, bez AFA</span>';
    grid.appendChild(tile);
  }

  function n(obj,key){const v=Number(obj?.[String(key)]);return Number.isFinite(v)?v:0}
  function freshness(f){
    if(!f||f.status!=='ok')return false;
    const stamp=Date.parse(f.updated_at||f.source?.product_end||'');
    return Number.isFinite(stamp)&&Date.now()-stamp<=MAX_AGE_MS;
  }

  function evidence(detail){
    if(!freshness(features))return {value:0,active:false};
    const r=features.radial_counts_20min||{},w=features.time_counts_80km||{};
    const n20=n(r,20),n40=n(r,40),n80=n(r,80),n150=n(r,150),m5=n(w,5),m10=n(w,10);
    const nearest=Number(features.nearest?.distance_km);
    const dbz=Number(detail?.dbz);
    const eta=Number(window.PrognozaEPIRRadarNowcast?.etaMin);
    let spatial=0;
    if(n20)spatial=.96*(1-Math.exp(-n20/2));
    else if(n40)spatial=.80*(1-Math.exp(-n40/3));
    else if(n80)spatial=.58*(1-Math.exp(-n80/5));
    else if(n150)spatial=.28*(1-Math.exp(-n150/8));
    const recent=Math.max(.62*(1-Math.exp(-m5/3)),.52*(1-Math.exp(-m10/5)));
    let trendBonus=0;
    const tr=features.trend_80km;
    if(Number(tr?.delta)>0)trendBonus=Math.min(.14,Number(tr.delta)*.025);
    let radarSupport=Number.isFinite(dbz)?(dbz>=40?1:dbz>=35?.92:dbz>=30?.78:dbz>=20?.55:.30):.35;
    if(Number.isFinite(nearest)&&nearest<=20)radarSupport=Math.max(radarSupport,.75);
    const etaSupport=Number.isFinite(eta)&&eta>=0&&eta<=90?1:.82;
    const value=clamp((Math.max(spatial,recent)+trendBonus)*radarSupport*etaSupport);
    return {value,active:true,n20,n40,n80,n150,m5,m10,nearest,trend:tr};
  }

  function boosted(base,e,weight=.68){
    const p=clamp(Number(base)/100);
    return clamp(1-(1-p)*(1-clamp(e)*weight))*100;
  }

  function updateTile(ev){
    ensureTile();
    const main=$('convLightning'),sub=$('convLightningSub');
    if(!main||!sub)return;
    if(!features){main.textContent='—';sub.textContent='oczekiwanie na kolektor LFL';return}
    if(features.status==='disabled'){
      main.textContent='nieaktywne';
      sub.textContent='kolektor czeka na klucze EUMETSAT';
      return;
    }
    if(features.status!=='ok'){
      main.textContent=features.status||'błąd';
      sub.textContent='LFL nie wpływa na P(Cb)';
      return;
    }
    if(!freshness(features)){
      main.textContent='nieświeże';
      sub.textContent='LFL pominięte w obliczeniach';
      return;
    }
    main.textContent=`${ev?.m10??n(features.time_counts_80km,10)} / 10 min`;
    const near=Number(features.nearest?.distance_km);
    sub.textContent=`80 km: ${ev?.n80??n(features.radial_counts_20min,80)} / 20 min${Number.isFinite(near)?` · najbliższe ${near.toFixed(0)} km`:''}`;
  }

  function apply(detail){
    if(!detail||typeof detail!=='object')return;
    ensureTile();
    const ev=evidence(detail);
    updateTile(ev);
    if(!ev.active){
      detail.lightning={source:'MTG LI LFL',active:false,status:features?.status||'unavailable'};
      return;
    }

    if(!Number.isFinite(Number(detail.baseCbProbability)))detail.baseCbProbability=Number(detail.cbProbability)||0;
    const base=Number(detail.baseCbProbability)||0;
    const adjusted=boosted(base,ev.value);
    detail.cbProbability=adjusted;
    detail.lightning={source:'MTG LI LFL',active:true,evidence:ev.value,baseCbProbability:base,boostPp:adjusted-base,features};

    if(Array.isArray(detail.horizons)){
      for(const h of detail.horizons){
        if(!Number.isFinite(Number(h.baseCb)))h.baseCb=Number(h.cb)||0;
        const decay=Math.exp(-Math.max(0,Number(h.h)||0)/180);
        h.cb=boosted(h.baseCb,ev.value*decay,.62);
        const el=$(`convH${h.h}`);
        if(el)el.textContent=`TCu ${Math.round(Number(h.tcu)||0)}% · Cb ${Math.round(h.cb)}%`;
      }
    }

    const dbz=Number(detail.dbz),near=Number(ev.nearest);
    let klass=detail.class;
    if(adjusted>=72&&(dbz>=35||(Number.isFinite(near)&&near<=20)))klass='Cb';
    else if(adjusted>=52&&(dbz>=30||(Number.isFinite(near)&&near<=40))&&!['Cb'].includes(klass))klass='Cb?';
    detail.class=klass;
    window.PrognozaEPIRConvectionNowcast=detail;

    if($('convCb'))$('convCb').textContent=`${Math.round(adjusted)}%`;
    if($('convCbSub'))$('convCbSub').textContent='POLRAD + NWP + historia + MTG LI LFL';
    if($('convClass'))$('convClass').textContent=klass;
    if($('convClassSub')&&klass==='Cb')$('convClassSub').textContent='radar + rzeczywiste błyski LFL potwierdzają głęboką konwekcję';

    const summary=$('convSummary');
    if(summary){
      const baseText=summary.dataset.lflBase||summary.textContent.replace(/ MTG LI LFL:.*$/,'');
      summary.dataset.lflBase=baseText;
      const nearText=Number.isFinite(near)?`, najbliższy błysk ~${Math.round(near)} km`:'';
      const trend=ev.trend?.label?`, trend ${ev.trend.label}`:'';
      const boost=adjusted-base;
      summary.textContent=`${baseText} MTG LI LFL: ${ev.m10} błysków/10 min w 80 km${nearText}${trend}; korekta Cb +${boost.toFixed(0)} pp.`;
    }
  }

  async function load(){
    if(loading)return;
    loading=true;
    try{
      const ctrl=new AbortController();
      const timer=setTimeout(()=>ctrl.abort(),9000);
      const r=await fetch(`${ENDPOINT}?t=${Date.now()}`,{cache:'no-store',signal:ctrl.signal});
      clearTimeout(timer);
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const j=await r.json();
      if(j?.schema!=='prognozaepir-lightning-features-v1')throw new Error('unexpected schema');
      features=j;
      lastFetch=Date.now();
      window.PrognozaEPIRLightningFeatures=features;
      updateTile(evidence(window.PrognozaEPIRConvectionNowcast||{}));
      if(window.PrognozaEPIRConvectionNowcast)apply(window.PrognozaEPIRConvectionNowcast);
      window.dispatchEvent(new CustomEvent('prognozaepir:lightning-features-updated',{detail:features}));
    }catch(err){
      features={schema:'prognozaepir-lightning-features-v1',status:'error',updated_at:new Date().toISOString(),reason:String(err)};
      window.PrognozaEPIRLightningFeatures=features;
      updateTile();
    }finally{loading=false}
  }

  window.addEventListener('prognozaepir:convection-nowcast-updated',e=>apply(e.detail));
  window.addEventListener('prognozaepir:radar-nowcast-updated',()=>{if(Date.now()-lastFetch>60000)load()});
  for(const id of ['apply','resetPoint','refresh'])$(id)?.addEventListener('click',()=>setTimeout(load,250));
  setTimeout(()=>{ensureTile();load()},900);
  setInterval(()=>{if(!document.hidden)load()},REFRESH_MS);
})();
