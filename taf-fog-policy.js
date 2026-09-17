'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFFogPolicy=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const MODE_KEY='prognozaepir-fog-engine-mode';
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));

  function normalizeMode(value){
    const s=String(value||'').toLowerCase();
    return s.includes('vnext')?'vnext':'legacy';
  }

  function selectedMode(win){
    try{
      const explicit=win?.PrognozaEPIRFogSelectedMode;
      if(explicit)return normalizeMode(explicit);
      return normalizeMode(win?.localStorage?.getItem(MODE_KEY));
    }catch(_){return 'legacy';}
  }

  // TAF core historically uses 60/70/80 as the operational fog scale.
  // Legacy Fog Engine uses an operational onset at 50. Translate only the
  // Legacy scale so 50 -> 60, 65 -> 70 and 80 -> 80. vNext is already on the
  // 60/70/80 scale and therefore passes through unchanged.
  function operationalScoreForTaf(score,mode){
    const s=num(score);if(!finite(s))return null;
    const x=clamp(s);
    if(normalizeMode(mode)==='vnext'||x<50||x>=80)return x;
    return 60+(x-50)*(20/30);
  }

  function activeVisibility(f,mode){
    if(!f)return null;
    if(normalizeMode(mode)==='vnext')return num(f?.visGuidance?.point)??num(f?.visProposed)??num(f?.vis);
    return num(f?.vis);
  }

  function thresholdRisk(f,threshold,mode){
    if(!f)return null;
    if(normalizeMode(mode)==='vnext'){
      return num(f?.visGuidance?.['p'+threshold])??num(f?.['visProb'+threshold])??num(f?.['vis'+threshold]);
    }
    return num(f?.['vis'+threshold]);
  }

  function mechanismType(f,mode){
    if(!f)return null;
    if(normalizeMode(mode)==='vnext'){
      const a=f?.vnextProbability?.mechanism1||f?.mechanism1||f?.vnext?.mechanism1||null;
      const b=f?.vnextProbability?.mechanism2||f?.mechanism2||f?.vnext?.mechanism2||null;
      return a?(b?`${a}/${b}`:String(a)):(f?.type?.text||f?.type||null);
    }
    return f?.type?.text||f?.type||null;
  }

  function normalizeFogHour(f,forcedMode){
    if(!f)return null;
    const mode=normalizeMode(forcedMode||f.fogEngineMode||f.fogEngineSource);
    const rawScore=num(f.score)??0;
    const fogScore=operationalScoreForTaf(rawScore,mode)??0;
    const vis1000=thresholdRisk(f,1000,mode),vis1500=thresholdRisk(f,1500,mode),vis500=thresholdRisk(f,500,mode),vis200=thresholdRisk(f,200,mode);
    const vis=activeVisibility(f,mode);
    const fgOperationalScore=Math.max(fogScore,finite(vis1000)?vis1000:0);
    const brOperationalScore=finite(vis)&&vis>=1000&&vis<=5000?Math.max(fogScore,finite(vis1500)?vis1500:0):null;
    const fogAltVisM=finite(vis)&&vis<1000?Math.max(100,Math.min(900,vis)):(rawScore>=40?(finite(vis500)&&vis500>=50?500:(finite(vis1000)&&vis1000>=50?800:900)):null);
    return {
      mode,rawScore,fogScore,fgOperationalScore,brOperationalScore,
      vis,vis1500,vis1000,vis500,vis200,fogAltVisM,
      confidence:mode==='vnext'?(num(f?.visGuidance?.confidence)??num(f?.visConfidence)??num(f?.confidence)):num(f?.confidence),
      type:mechanismType(f,mode),
      source:f.fogEngineSource||f.fogEngineMode||mode,
      fallback:Boolean(f.fogEngineFallback)
    };
  }

  function cloneSeries(series){
    return (Array.isArray(series)?series:[]).map(x=>({...x,models:Array.isArray(x?.models)?x.models.map(m=>({...m})):x?.models}));
  }

  function seriesForMode(win,mode){
    const m=normalizeMode(mode||selectedMode(win));
    if(m==='vnext'){
      const v=win?.PrognozaEPIRFogVNextSeries;
      return Array.isArray(v)&&v.length?cloneSeries(v):[];
    }
    const legacy=win?.PrognozaEPIRFogLegacySeries;
    if(Array.isArray(legacy)&&legacy.length)return cloneSeries(legacy);
    const active=win?.PrognozaEPIRFogSeries;
    if(Array.isArray(active)&&active.length&&!active.some(x=>normalizeMode(x?.fogEngineMode||x?.fogEngineSource)==='vnext'))return cloneSeries(active);
    return [];
  }

  return Object.freeze({MODE_KEY,normalizeMode,selectedMode,operationalScoreForTaf,activeVisibility,thresholdRisk,mechanismType,normalizeFogHour,seriesForMode,cloneSeries});
});
