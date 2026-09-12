'use strict';

(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFHybridTuning=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const VERSION='1.1.0';
  const KT=1.9438444924406, FT=3.2808398950131;
  const finite=Number.isFinite;
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const DEFAULTS=Object.freeze({
    consensusPrimary:true,
    weakRrMmH:0.30,
    weakSignalRrMmH:0.05,
    temporalProbability:0.30,
    strongModelShare:0.75,
    minModelsForSpike:4,
    advectionConfirmWeight:0.15,
    wetSignalPct:40
  });

  function mergeConfig(extra){return{...DEFAULTS,...(extra||{})};}
  function modelId(m,i){return String(m?.id||m?.model||m?.name||`model_${i+1}`);}
  function circularDiff(a,b){let d=Math.abs((a||0)-(b||0))%360;return d>180?360-d:d;}
  function visBand(v){return !finite(v)?4:v<800?0:v<1500?1:v<3000?2:v<5000?3:4;}
  function ceilBandFt(v){return !finite(v)?5:v<200?0:v<300?1:v<500?2:v<1000?3:v<1500?4:5;}

  function wmoPrecipInfo(code){
    const c=+code;
    const ts=c===95||c===96||c===99;
    const frozen=c===56||c===57||c===66||c===67;
    const snow=c===71||c===73||c===75||c===77||c===85||c===86;
    const precip=[51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(c);
    let intensity='none';
    if([51,56,61,66,71,80,85].includes(c))intensity='weak';
    else if([53,57,63,73,81].includes(c))intensity='moderate';
    else if([55,65,67,75,82,86].includes(c))intensity='heavy';
    else if(precip)intensity='moderate';
    return{precip,ts,frozen,snow,intensity,ordinary:precip&&!ts&&!frozen};
  }

  function weightedShare(members,pred){
    let yes=0,all=0,count=0;
    for(const m of members||[]){
      const w=finite(+m?.w)&&+m.w>0?+m.w:1;all+=w;
      if(pred(m)){yes+=w;count++;}
    }
    return{share:all?yes/all:0,count,total:(members||[]).length};
  }

  function rowEvidence(row){
    const mv=Array.isArray(row?.mv)?row.mv:[];
    const ordinary=weightedShare(mv,m=>wmoPrecipInfo(m?.code).ordinary);
    const moderate=weightedShare(mv,m=>{const q=wmoPrecipInfo(m?.code);return q.ordinary&&(q.intensity==='moderate'||q.intensity==='heavy');});
    const frozen=weightedShare(mv,m=>wmoPrecipInfo(m?.code).frozen);
    const ts=weightedShare(mv,m=>wmoPrecipInfo(m?.code).ts);
    const rr=finite(+row?.RR)?Math.max(0,+row.RR):0,wet=finite(+row?.wet)?clamp(+row.wet,0,100):0;
    const adv=(row?.upstream||[]).some(q=>{
      const w=finite(+q?.score)?+q.score:0,wx=String(q?.state?.wx||q?.same?.state?.wx||q?.same?.wx||'').toUpperCase();
      return w>=DEFAULTS.advectionConfirmWeight&&/\b(?:RA|DZ|SN|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|TSRA|TS)\b/.test(wx);
    });
    return{ordinaryShare:ordinary.share,ordinaryCount:ordinary.count,modelCount:ordinary.total,moderateShare:moderate.share,frozenShare:frozen.share,tsShare:ts.share,rr,wet,advection:adv};
  }

  function significantConsensusChange(a,b){
    if(!a||!b)return false;
    if(visBand(+a.VIS)!==visBand(+b.VIS))return true;
    const ac=finite(+a.ceiling)?+a.ceiling*FT:null,bc=finite(+b.ceiling)?+b.ceiling*FT:null;
    if(ceilBandFt(ac)!==ceilBandFt(bc))return true;
    const aws=finite(+a.WS)?+a.WS*KT:0,bws=finite(+b.WS)?+b.WS*KT:0;
    if(Math.abs(aws-bws)>=10)return true;
    if(finite(+a.WD)&&finite(+b.WD)&&circularDiff(+a.WD,+b.WD)>=60&&(aws>=10||bws>=10))return true;
    const aLow=finite(+a.lowH)&&+a.lowH*FT<1500&&+a.oktaL>=5,bLow=finite(+b.lowH)&&+b.lowH*FT<1500&&+b.oktaL>=5;
    return aLow!==bLow;
  }

  function tuneRows(rows,extra){
    const cfg=mergeConfig(extra),base=(rows||[]).map(r=>({...r,mv:Array.isArray(r?.mv)?r.mv.map(m=>({...m})):[]}));
    const ev=base.map(rowEvidence);
    for(let i=0;i<base.length;i++){
      const row=base[i],e=ev[i],prev=ev[i-1],next=ev[i+1];
      const temporal=!!((prev&&(prev.ordinaryShare>=cfg.temporalProbability||prev.rr>=cfg.weakSignalRrMmH||prev.wet>=cfg.wetSignalPct))||(next&&(next.ordinaryShare>=cfg.temporalProbability||next.rr>=cfg.weakSignalRrMmH||next.wet>=cfg.wetSignalPct)));
      const strongModels=e.ordinaryShare>=cfg.strongModelShare&&e.ordinaryCount>=cfg.minModelsForSpike;
      const otherChange=significantConsensusChange(row,base[i-1])||significantConsensusChange(row,base[i+1]);
      const lowVis=finite(+row.VIS)&&+row.VIS<5000;
      const protectedEvent=e.frozenShare>=cfg.temporalProbability||e.tsShare>=cfg.temporalProbability;
      const moderateOrHeavy=e.rr>=cfg.weakRrMmH||e.moderateShare>=cfg.temporalProbability;
      const weakSignal=e.ordinaryShare>=cfg.temporalProbability||e.rr>=cfg.weakSignalRrMmH||e.wet>=cfg.wetSignalPct;
      const confirmed=temporal||strongModels||e.advection||lowVis||otherChange;
      const suppressWeak=weakSignal&&!protectedEvent&&!moderateOrHeavy&&!confirmed;
      const allowWeakOrdinary=!suppressWeak;
      row.__hybridTuning={...e,temporal,strongModels,otherChange,lowVis,protectedEvent,moderateOrHeavy,weakSignal,confirmed,suppressWeak,allowWeakOrdinary};

      if(suppressWeak)row.wet=0;
      else if(moderateOrHeavy&&e.rr>=cfg.weakRrMmH)row.wet=Math.max(finite(+row.wet)?+row.wet:0,70);

      row.mv=row.mv.map((m,j)=>{
        const q=wmoPrecipInfo(m?.code),out={...m};
        out.sourceModelId=modelId(m,j);
        out.id=`CONSENSUS::${out.sourceModelId}`;
        out.model=out.id;
        if(cfg.consensusPrimary){
          if(finite(+row.WS))out.ws=+row.WS;
          if(finite(+row.WD))out.wd=+row.WD;
          if(finite(+row.G))out.g=+row.G;else if(finite(+row.WS))out.g=+row.WS;
          if(finite(+row.VIS))out.vis=+row.VIS;
          if(finite(+row.ceiling))out.ceil=+row.ceiling;
        }
        if(suppressWeak&&q.ordinary&&q.intensity==='weak')out.code=0;
        return out;
      });
    }
    return base;
  }

  function ddhh(t){const d=new Date(t),p=n=>String(n).padStart(2,'0');return p(d.getUTCDate())+p(d.getUTCHours());}
  function ddhhmm(t){const d=new Date(t),p=n=>String(n).padStart(2,'0');return ddhh(t)+p(d.getUTCMinutes());}
  function ddhhEnd(t){const d=new Date(t);if(d.getUTCHours()===0&&d.getUTCMinutes()===0){const q=new Date(t-1),p=n=>String(n).padStart(2,'0');return p(q.getUTCDate())+'24';}return ddhh(t);}
  function ordinaryPrecipPayload(s){return /(^|\s)[+-]?(?:RA|DZ|SN|SHRA|SHSN|RASN|SNRA)(?=\s|$)/.test(String(s||''))&&!/(^|\s)(?:TS|FZ)/.test(String(s||''));}
  function groupHours(result,g){return(result.hourly||[]).filter(h=>h.t>=g.start&&h.t<g.end);}
  function hourAllowsWeak(h){const e=h?.sourceRow?.__hybridTuning;return !e||e.allowWeakOrdinary||e.protectedEvent||e.moderateOrHeavy;}

  function rebuildTaf(result){
    let taf=`TAF ${result.station} ${ddhhmm(result.issue)}Z ${ddhh(result.start)}/${ddhhEnd(result.end)} ${result.base.text}`;
    for(const g of result.groups||[])taf+=`\n${g.kind} ${ddhh(g.start)}/${ddhhEnd(g.end)} ${g.payload}`;
    return taf+'=';
  }

  function postprocessResult(result){
    if(!result||!Array.isArray(result.groups))return result;
    const before=result.groups.length,kept=[],suppressed=[];
    for(const g of result.groups){
      const hs=groupHours(result,g),weakOrdinary=(g.event==='precip'||ordinaryPrecipPayload(g.payload));
      if(!weakOrdinary){kept.push(g);continue;}
      const allowed=hs.some(hourAllowsWeak),otherFields=Array.isArray(g.fields)&&g.fields.some(x=>x!=='weather');
      if(allowed||otherFields){kept.push(g);continue;}
      suppressed.push(g);
    }
    result.groups=kept;
    if(suppressed.length){result.taf=rebuildTaf(result);if(result.checks)result.checks.max5=result.groups.length<=5;}
    result.baseEngineVersion=result.version;
    result.version=`${result.version}+CP${VERSION}`;
    result.diagnostics=result.diagnostics||{};
    result.diagnostics.consensusPrimary=true;
    result.diagnostics.precipitationFilter={version:VERSION,suppressedGroups:suppressed.length,suppressedWeakHours:(result.hourly||[]).filter(h=>h?.sourceRow?.__hybridTuning?.suppressWeak).length};
    if(Array.isArray(result.diagnostics.layers))result.diagnostics.layers.push({id:'P',name:'consensus-primary-precip-significance',status:'ok',suppressedGroups:suppressed.length});
    if(suppressed.length&&Array.isArray(result.diagnostics.reasons))result.diagnostics.reasons.push(`Filtr istotności opadu: pominięto ${suppressed.length} grupę/grupy słabego, niepotwierdzonego opadu.`);
    result.tuning={version:VERSION,consensusPrimary:true,suppressedGroups:suppressed.length,groupsBefore:before,groupsAfter:result.groups.length};
    return result;
  }

  function wrapApi(core,options={}){
    if(!core?.createEngine)throw Error('Brak bazowego Hybrid TAF Engine');
    const cfg=mergeConfig(options);
    return Object.freeze({...core,
      ENGINE_VERSION:`${core.ENGINE_VERSION}+CP${VERSION}`,
      BASE_ENGINE_VERSION:core.ENGINE_VERSION,
      TUNING_VERSION:VERSION,
      createEngine(engineOptions={}){
        const inner=core.createEngine(engineOptions);
        return{
          generate(input){const tuned={...input,rows:tuneRows(input?.rows||[],cfg)};return postprocessResult(inner.generate(tuned));},
          learn(observations){return inner.learn(observations);},
          getLearningState(){return inner.getLearningState();},
          getLearningSummary(){return inner.getLearningSummary();},
          importLearningState(state){return inner.importLearningState(state);},
          resetLearning(){return inner.resetLearning();}
        };
      }
    });
  }

  return Object.freeze({VERSION,DEFAULTS,wmoPrecipInfo,rowEvidence,significantConsensusChange,tuneRows,postprocessResult,wrapApi});
});

(() => {
  if(typeof window==='undefined'||typeof location==='undefined')return;
  if(!/\/taf\.html$/i.test(location.pathname)||window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__)return;
  window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__=true;

  const loadScript=src=>new Promise((resolve,reject)=>{
    const key=src.split('?')[0],existing=[...document.scripts].find(s=>s.src&&s.src.includes(key));
    if(existing){
      if(existing.dataset.loaded==='1'||(key.includes('taf-hybrid-engine')&&window.PrognozaEPIRTAFHybridEngine))return resolve();
      existing.addEventListener('load',resolve,{once:true});existing.addEventListener('error',()=>reject(Error('Nie udało się załadować '+src)),{once:true});return;
    }
    const s=document.createElement('script');s.src=src;s.async=false;s.dataset.tafHybrid='1';s.onload=()=>{s.dataset.loaded='1';resolve();};s.onerror=()=>reject(Error('Nie udało się załadować '+src));(document.head||document.documentElement).appendChild(s);
  });

  (async()=>{
    try{
      if(!window.PrognozaEPIRTAFHybridEngine)await loadScript('taf-hybrid-engine.js?v=20260912-hybrid-v2');
      window.PrognozaEPIRTAFHybridEngine=window.PrognozaEPIRTAFHybridTuning.wrapApi(window.PrognozaEPIRTAFHybridEngine);
      await loadScript('taf-hybrid-adapter.js?v=20260912-hybrid-v2');
      window.PrognozaEPIRTAFGeneratorPolicy=Object.freeze({mode:'hybrid-consensus-primary',version:window.PrognozaEPIRTAFHybridEngine?.ENGINE_VERSION||null,tuning:VERSION});
    }catch(e){
      console.error('[TAF Hybrid bootstrap]',e);
      const b=document.getElementById('badge'),st=document.getElementById('st');if(b){b.textContent='BŁĄD HYBRID';b.className='badge bad';}if(st)st.textContent=e.message;
    }
  })();
})();