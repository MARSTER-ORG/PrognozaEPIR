'use strict';
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
