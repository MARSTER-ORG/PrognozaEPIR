'use strict';
(() => {
  const SKILL_URL='data/learning/cloud-skill.json';
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
  }

  function factor(modelId,targetMs){
    if(!skill?.models?.[modelId])return 1;
    const leadH=Math.max(0,(targetMs-Date.now())/3600000);
    const b=bucketForLead(leadH);
    const row=b?skill.models[modelId]?.lead_buckets?.[b]:null;
    const f=Number(row?.weight_factor);
    return Number.isFinite(f)?Math.max(.55,Math.min(1.8,f)):1;
  }

  function info(modelId,targetMs){
    const leadH=Math.max(0,(targetMs-Date.now())/3600000);
    const b=bucketForLead(leadH);
    const row=b?skill?.models?.[modelId]?.lead_buckets?.[b]:null;
    return {bucket:b,factor:factor(modelId,targetMs),n:Number(row?.n)||0,mae:Number(row?.mae_okta)};
  }

  window.PrognozaEPIRCloudLearning={loadSkill,factor,info,getSkill:()=>skill};
})();
