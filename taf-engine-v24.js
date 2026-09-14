'use strict';
(function(root,factory){
  let core=null;
  if(typeof module!=='undefined'&&module.exports){
    core=require('./taf-engine-v2.js');
    module.exports=factory(core,null);
  }else{
    core=root&&root.PrognozaEPIRTAFEngine;
    if(!core)throw new Error('TAF Engine 2.4 requires taf-engine-v2.js formal kernel');
    root.PrognozaEPIRTAFEngine=factory(core,root);
  }
})(typeof window!=='undefined'?window:globalThis,function(core,root){
  'use strict';

  const VERSION='2.4.0';
  const NAME='TAF Engine 2.4 — EPIR Calibrated Probabilistic + Instruction First';
  const HOUR=3600000;
  const RULES=core.RULES;
  const AUTH=core.INSTRUCTION;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const prob=v=>!num(v)?0:(+v>1?clamp(+v/100,0,1):clamp(+v,0,1));

  const learning={adaptive:null,fog:null,verification:null,loaded:false,error:null,startedAt:null,finishedAt:null};
  let learningPromise=null;

  function leadBucket(hours){
    if(!finite(hours)||hours<0)return null;
    if(hours<3)return'0-3h';
    if(hours<6)return'3-6h';
    if(hours<12)return'6-12h';
    if(hours<24)return'12-24h';
    if(hours<48)return'24-48h';
    return'48-120h';
  }

  function modelId(m){return String(m?.id||m?.model||'').trim();}
  function weatherCodeInfo(code){
    const c=Math.round(+code);
    return{
      fog:c===45||c===48,
      ts:[95,96,99].includes(c),
      precip:[51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(c)
    };
  }

  function injectedAdaptive(){
    if(learning.adaptive)return learning.adaptive;
    try{
      const w=root?.document?.getElementById('engine')?.contentWindow;
      return w?.PrognozaEPIRAdaptiveWeights?.data||null;
    }catch(_){return null;}
  }

  function frameAdaptiveApi(){
    try{return root?.document?.getElementById('engine')?.contentWindow?.PrognozaEPIRAdaptiveWeights||null;}catch(_){return null;}
  }

  function adaptiveFactor(model,targetMs,component,bucket=null){
    const id=modelId(model);if(!id)return 1;
    const api=frameAdaptiveApi();
    try{
      const key=component==='wind'?'wind_speed_10m':component==='visibility'?'visibility':component==='precipitation'?'weather_code':component==='cloud'?'cloud_cover_925hPa':component==='temperature'?'temperature_2m':component==='dew_point'?'dew_point_2m':null;
      if(api?.factor&&api.data){const f=Number(api.factor(id,targetMs,key));if(finite(f)&&f>0)return clamp(f,.70,1.30);}
    }catch(_){}
    const data=injectedAdaptive();
    const b=bucket||leadBucket(Math.max(0,(+targetMs-Date.now())/HOUR));
    const row=b?data?.models?.[id]?.lead_buckets?.[b]:null;
    const f=component?Number(row?.components?.[component]?.weight_factor):Number(row?.weight_factor);
    return finite(f)&&f>0?clamp(f,.70,1.30):1;
  }

  function adaptiveRelativeFactor(model,targetMs,component,bucket=null){
    const id=modelId(model);if(!id||!component)return 1;
    const api=frameAdaptiveApi();
    try{
      if(api?.relativeFactor&&api.data){const f=Number(api.relativeFactor(id,targetMs,component==='wind'?'wind_speed_10m':component==='visibility'?'visibility':component==='precipitation'?'weather_code':component==='cloud'?'cloud_cover_925hPa':component==='temperature'?'temperature_2m':component==='dew_point'?'dew_point_2m':null));if(finite(f)&&f>0)return clamp(f,.70/1.30,1.30/.70);}
    }catch(_){}
    const overall=adaptiveFactor(model,targetMs,null,bucket),specific=adaptiveFactor(model,targetMs,component,bucket);
    return overall>0?clamp(specific/overall,.70/1.30,1.30/.70):1;
  }

  function fogSkillFactor(model,bucket){
    const id=modelId(model),row=bucket?learning.fog?.models?.[id]?.lead_buckets?.[bucket]:null;
    const f=Number(row?.weight_factor);
    return finite(f)&&f>0?clamp(f,.70,1.30):1;
  }

  function weightedShare(members,predicate,weightFn){
    let n=0,d=0;
    for(const m of members||[]){
      let w=num(m?.w)&&+m.w>0?+m.w:1;
      const f=Number(weightFn?weightFn(m):1);if(finite(f)&&f>0)w*=f;
      d+=w;if(predicate(m))n+=w;
    }
    return d?n/d:0;
  }

  function verificationBucket(bucket){return bucket?learning.verification?.models?.consensus?.diagnostics?.by_lead_bucket?.[bucket]||null:null;}
  function applyMos(row,bucket,diag){
    const out={...row};if(!diag)return out;
    const c=diag.continuous||{};
    if(num(out.T)&&num(c.temperature?.bias))out.T=clamp(+out.T-+c.temperature.bias,-60,60);
    if(num(out.Td)&&num(c.dew_point?.bias))out.Td=clamp(+out.Td-+c.dew_point.bias,-70,50);
    const wb=diag.wind?.wind_speed?.bias_ms;
    if(num(out.WS)&&num(wb))out.WS=clamp(+out.WS-+wb,0,80);
    if(num(out.G)&&num(wb))out.G=Math.max(out.WS,clamp(+out.G-+wb,0,100));
    // Visibility bias is deliberately not applied: METAR 9999 is right-censored.
    // Direction bias is diagnostic only because the canonical consensus already has an EPIR sector correction.
    out.taf24Mos={bucket,temperatureBias:num(c.temperature?.bias)?+c.temperature.bias:null,dewPointBias:num(c.dew_point?.bias)?+c.dew_point.bias:null,windSpeedBiasMs:num(wb)?+wb:null,visibilityBiasApplied:false,windDirectionBiasApplied:false};
    return out;
  }

  function calibrateEvents(row,bucket){
    const out={...row},members=Array.isArray(row?.mv)?row.mv.map(m=>({...m})):[];
    if(!members.length){out.mv=members;return out;}
    for(const m of members){
      const overall=adaptiveFactor(m,+row.t,null,bucket);
      const base=num(m.w)&&+m.w>0?+m.w:1;
      m.w=base*overall;
      m.taf24WeightFactor=overall;
    }
    out.mv=members;
    const precip=weightedShare(members,m=>weatherCodeInfo(m.code).precip,m=>adaptiveRelativeFactor(m,+row.t,'precipitation',bucket));
    const ts=weightedShare(members,m=>weatherCodeInfo(m.code).ts,m=>adaptiveRelativeFactor(m,+row.t,'precipitation',bucket));
    out.wet=Math.max(prob(out.wet),precip);
    out.storm=Math.max(prob(out.storm),ts);

    const hasOperational=num(out.fgOperationalScore)||num(out.fogOperationalScore);
    if(!hasOperational){
      const eventWeight=m=>adaptiveRelativeFactor(m,+row.t,'visibility',bucket)*fogSkillFactor(m,bucket);
      const fg=weightedShare(members,m=>num(m.vis)&&+m.vis<1000,eventWeight);
      const br=weightedShare(members,m=>num(m.vis)&&+m.vis>=1000&&+m.vis<=5000,eventWeight);
      const fog=weightedShare(members,m=>weatherCodeInfo(m.code).fog,eventWeight);
      out.fgRisk=Math.max(prob(out.fgRisk),fg);
      out.brRisk=Math.max(prob(out.brRisk),br);
      out.fogRisk=Math.max(prob(out.fogRisk),fog,fg);
    }
    out.taf24Calibration={bucket,precip,ts,operationalFogGate:hasOperational?'preserved':'model-skill-weighted'};
    return out;
  }

  function prepareRows(input={}){
    const issue=+input.issue;
    return (input.rows||[]).map(src=>{
      const t=+src.t,lead=finite(t)&&finite(issue)?Math.max(0,(t-issue)/HOUR):NaN,bucket=leadBucket(lead);
      let row=applyMos({...src,mv:Array.isArray(src.mv)?src.mv.map(m=>({...m})):src.mv},bucket,verificationBucket(bucket));
      row=calibrateEvents(row,bucket);
      row.taf24LeadHours=finite(lead)?lead:null;
      row.taf24LeadBucket=bucket;
      return row;
    });
  }

  function setLearningData(data={}){
    if(Object.prototype.hasOwnProperty.call(data,'adaptive'))learning.adaptive=data.adaptive;
    if(Object.prototype.hasOwnProperty.call(data,'fog'))learning.fog=data.fog;
    if(Object.prototype.hasOwnProperty.call(data,'verification'))learning.verification=data.verification;
    learning.loaded=!!(learning.adaptive||learning.fog||learning.verification);learning.error=null;learning.finishedAt=new Date().toISOString();
    return learningStatus();
  }

  function learningStatus(){
    return{
      loaded:learning.loaded,
      adaptive:!!(learning.adaptive||injectedAdaptive()),fog:!!learning.fog,verification:!!learning.verification,
      error:learning.error,startedAt:learning.startedAt,finishedAt:learning.finishedAt,
      generatedAt:{adaptive:learning.adaptive?.generated_at||injectedAdaptive()?.generated_at||null,fog:learning.fog?.generated_at||null,verification:learning.verification?.generated_at||null}
    };
  }

  function loadLearning(){
    if(learningPromise)return learningPromise;
    if(!root?.fetch){learning.loaded=!!injectedAdaptive();return Promise.resolve(learningStatus());}
    learning.startedAt=new Date().toISOString();
    const get=async(path,schema)=>{const r=await root.fetch(path+'?taf24='+Date.now(),{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw Error(path+': HTTP '+r.status);const j=await r.json();if(j?.schema!==schema)throw Error(path+': nieprawidłowy schema');return j;};
    learningPromise=Promise.allSettled([
      get('data/learning/adaptive-weights.json','prognozaepir-adaptive-weights-v1'),
      get('data/learning/fog-event-skill.json','prognozaepir-fog-event-skill-v1'),
      get('data/learning/model-verification.json','prognozaepir-model-verification-v1')
    ]).then(([a,f,v])=>{
      if(a.status==='fulfilled')learning.adaptive=a.value;
      if(f.status==='fulfilled')learning.fog=f.value;
      if(v.status==='fulfilled')learning.verification=v.value;
      learning.loaded=!!(learning.adaptive||learning.fog||learning.verification||injectedAdaptive());
      const errs=[a,f,v].filter(x=>x.status==='rejected').map(x=>String(x.reason?.message||x.reason));learning.error=errs.length?errs.join(' | '):null;learning.finishedAt=new Date().toISOString();
      return learningStatus();
    });
    return learningPromise;
  }

  function createEngine(options={}){
    const kernel=core.createEngine(options);
    return Object.freeze({
      version:VERSION,rules:RULES,
      generate(input={}){
        const prepared=prepareRows(input);
        const result=kernel.generate({...input,rows:prepared});
        const status=learningStatus();
        return{
          ...result,version:VERSION,name:NAME,
          diagnostics:{...result.diagnostics,probabilisticLayer:'EPIR adaptive per-model/per-lead skill + verified MOS bias correction before Instruction kernel',mosPolicy:'T/Td/wind-speed bias only; no raw visibility correction because METAR 9999 is censored; direction bias diagnostic only',nowcastPolicy:'existing issue-time-safe METAR/SPECI anchor + neighbor observation context; no second observation anchor in v2.4',formalKernelVersion:core.ENGINE_VERSION,postGenerationMutation:false},
          learning:{...result.learning,active:status.loaded,sources:status,ruleMutation:false,note:'Uczenie i kalibracja modyfikują wyłącznie materiał meteorologiczny przed generacją. Instrukcja 11.2023 i końcowa walidacja pozostają w jednym formalnym kernelu.'}
        };
      },
      validate:(taf,meta)=>kernel.validate(taf,meta),
      helpers:Object.freeze({...kernel.helpers,leadBucket,prepareRows,adaptiveFactor,adaptiveRelativeFactor,fogSkillFactor})
    });
  }

  if(root){root.__PROGNOZA_EPIR_TAF_ENGINE_V24__=true;loadLearning().catch(()=>{});}

  return Object.freeze({ENGINE_VERSION:VERSION,ENGINE_NAME:NAME,INSTRUCTION:AUTH,RULES,FORMAL_KERNEL_VERSION:core.ENGINE_VERSION,createEngine,validateTaf:(taf,meta)=>core.validateTaf(taf,meta),ready:loadLearning,setLearningData,learningStatus,helpers:Object.freeze({leadBucket,prepareRows,adaptiveFactor,adaptiveRelativeFactor,fogSkillFactor})});
});
