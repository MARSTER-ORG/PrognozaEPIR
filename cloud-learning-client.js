'use strict';
(() => {
  const SKILL_URL='data/learning/cloud-skill.json';
  const HOUR=3600000;
  let skill=null;

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
    setTimeout(installMetrics,0);
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
  const clip01=v=>Math.max(0,Math.min(1,v));

  function circularDiff(a,b){
    if(!finite(a)||!finite(b))return null;
    const d=Math.abs((a-b)%360);
    return Math.min(d,360-d);
  }

  function scoreLinear(err,bad){
    return finite(err)?100*clip01(1-err/bad):null;
  }

  function scoreVisibility(a,b){
    if(!finite(a)||!finite(b))return null;
    const aa=Math.max(500,a),bb=Math.max(500,b);
    return 100*clip01(1-Math.abs(Math.log(aa/bb))/Math.log(5));
  }

  function pairAgreement(a,b){
    const p=[];
    const add=v=>{if(finite(v))p.push(v)};
    add(scoreLinear(Math.abs((a.T??NaN)-(b.T??NaN)),6));
    add(scoreLinear(Math.abs((a.Td??NaN)-(b.Td??NaN)),6));
    add(scoreLinear(Math.abs((a.P??NaN)-(b.P??NaN)),10));
    add(scoreLinear(Math.abs((a.WS??NaN)-(b.WS??NaN)),6));
    if((a.WS??0)>=1.5&&(b.WS??0)>=1.5)add(scoreLinear(circularDiff(a.WD,b.WD),90));
    add(scoreVisibility(a.VIS,b.VIS));
    add(scoreLinear(Math.abs((a.oktaL??NaN)-(b.oktaL??NaN)),5));
    add(scoreLinear(Math.abs((a.oktaM??NaN)-(b.oktaM??NaN)),5));
    add(scoreLinear(Math.abs((a.oktaH??NaN)-(b.oktaH??NaN)),5));
    return p.length?p.reduce((s,v)=>s+v,0)/p.length:null;
  }

  function currentAgreement(){
    try{
      if(!Array.isArray(consensus)||!consensus.length||!Array.isArray(MODELS)||typeof modelSeries!=='function')return null;
      const end=Date.now()+Math.min(Number(horizon)||48,48)*HOUR;
      const base=consensus.filter(z=>z.t<=end);
      const byTime=new Map(base.map(z=>[z.t,z]));
      const scores=[];
      for(const m of MODELS){
        if(!datasets?.has?.(m.id))continue;
        for(const z of modelSeries(m.id)){
          const c=byTime.get(z.t);
          if(!c)continue;
          const s=pairAgreement(z,c);
          if(finite(s))scores.push(s);
        }
      }
      return scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null;
    }catch(_){return null;}
  }

  function verifiedScore(){
    try{
      const key=(typeof selected==='string'&&selected)?selected:'consensus';
      const v=skill?.model_verification?.models?.[key]?.score_pct;
      return finite(Number(v))?Math.round(Number(v)):null;
    }catch(_){return null;}
  }

  function renderMetrics(){
    const box=document.getElementById('models');
    if(!box)return;
    const agreement=currentAgreement();
    const verified=verifiedScore();
    box.innerHTML=
      '<div>Dostępność danych: <b>'+(agreement===null?'—':agreement+'%')+'</b> – zgodność modeli</div>'+
      '<div><b>'+(verified===null?'—':verified+'%')+'</b> – sprawdzalność modelu z realnymi danymi</div>';
  }

  function installMetrics(){
    try{
      if(typeof render==='function'&&!window.__epirModelMetricsWrapped){
        const baseRender=render;
        render=function(){
          const out=baseRender.apply(this,arguments);
          renderMetrics();
          return out;
        };
        window.__epirModelMetricsWrapped=true;
      }
      const view=document.getElementById('view');
      if(view&&!view.dataset.modelMetricsHook){
        view.dataset.modelMetricsHook='1';
        view.addEventListener('change',()=>setTimeout(renderMetrics,0));
      }
      document.querySelectorAll('button[data-h]').forEach(b=>{
        if(b.dataset.modelMetricsHook)return;
        b.dataset.modelMetricsHook='1';
        b.addEventListener('click',()=>setTimeout(renderMetrics,0));
      });
      renderMetrics();
    }catch(_){ }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(installMetrics,0),{once:true});
  else setTimeout(installMetrics,0);

  window.PrognozaEPIRCloudLearning={loadSkill,factor,info,getSkill:()=>skill,renderMetrics};
})();
