'use strict';

(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFHybridTuning=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const VERSION='1.1.0',KT=1.9438444924406,FT=3.2808398950131;
  const finite=Number.isFinite,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const DEFAULTS=Object.freeze({consensusPrimary:true,weakRrMmH:.30,weakSignalRrMmH:.05,temporalProbability:.30,strongModelShare:.75,minModelsForSpike:4,advectionConfirmWeight:.15,wetSignalPct:40});
  const cfgOf=x=>({...DEFAULTS,...(x||{})});
  const modelId=(m,i)=>String(m?.id||m?.model||m?.name||`model_${i+1}`);
  const circ=(a,b)=>{let d=Math.abs((a||0)-(b||0))%360;return d>180?360-d:d;};
  const visBand=v=>!finite(v)?4:v<800?0:v<1500?1:v<3000?2:v<5000?3:4;
  const ceilBand=v=>!finite(v)?5:v<200?0:v<300?1:v<500?2:v<1000?3:v<1500?4:5;

  function wmoPrecipInfo(code){
    const c=+code,ts=[95,96,99].includes(c),frozen=[56,57,66,67].includes(c),snow=[71,73,75,77,85,86].includes(c);
    const precip=[51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(c);
    let intensity='none';
    if([51,56,61,66,71,80,85].includes(c))intensity='weak';
    else if([53,57,63,73,81].includes(c))intensity='moderate';
    else if([55,65,67,75,82,86].includes(c))intensity='heavy';
    else if(precip)intensity='moderate';
    return{precip,ts,frozen,snow,intensity,ordinary:precip&&!ts&&!frozen};
  }

  function share(members,pred){
    let yes=0,all=0,count=0;
    for(const m of members||[]){const w=finite(+m?.w)&&+m.w>0?+m.w:1;all+=w;if(pred(m)){yes+=w;count++;}}
    return{share:all?yes/all:0,count,total:(members||[]).length};
  }

  function rowEvidence(row,cfg=DEFAULTS){
    const mv=Array.isArray(row?.mv)?row.mv:[];
    const ordinary=share(mv,m=>wmoPrecipInfo(m?.code).ordinary);
    const moderate=share(mv,m=>{const q=wmoPrecipInfo(m?.code);return q.ordinary&&(q.intensity==='moderate'||q.intensity==='heavy');});
    const frozen=share(mv,m=>wmoPrecipInfo(m?.code).frozen),ts=share(mv,m=>wmoPrecipInfo(m?.code).ts);
    const rr=finite(+row?.RR)?Math.max(0,+row.RR):0,wet=finite(+row?.wet)?clamp(+row.wet,0,100):0;
    const advection=(row?.upstream||[]).some(q=>{
      const w=finite(+q?.score)?+q.score:0,wx=String(q?.state?.wx||q?.same?.state?.wx||q?.same?.wx||'').toUpperCase();
      return w>=cfg.advectionConfirmWeight&&/\b(?:RA|DZ|SN|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|TSRA|TS)\b/.test(wx);
    });
    return{ordinaryShare:ordinary.share,ordinaryCount:ordinary.count,modelCount:ordinary.total,moderateShare:moderate.share,frozenShare:frozen.share,tsShare:ts.share,rr,wet,advection};
  }

  function significantConsensusChange(a,b){
    if(!a||!b)return false;
    if(visBand(+a.VIS)!==visBand(+b.VIS))return true;
    const ac=finite(+a.ceiling)?+a.ceiling*FT:null,bc=finite(+b.ceiling)?+b.ceiling*FT:null;
    if(ceilBand(ac)!==ceilBand(bc))return true;
    const aws=finite(+a.WS)?+a.WS*KT:0,bws=finite(+b.WS)?+b.WS*KT:0;
    if(Math.abs(aws-bws)>=10)return true;
    if(finite(+a.WD)&&finite(+b.WD)&&circ(+a.WD,+b.WD)>=60&&(aws>=10||bws>=10))return true;
    const al=finite(+a.lowH)&&+a.lowH*FT<1500&&+a.oktaL>=5,bl=finite(+b.lowH)&&+b.lowH*FT<1500&&+b.oktaL>=5;
    return al!==bl;
  }

  function tuneRows(rows,extra){
    const cfg=cfgOf(extra),out=(rows||[]).map(r=>({...r,mv:Array.isArray(r?.mv)?r.mv.map(m=>({...m})):[]})),ev=out.map(r=>rowEvidence(r,cfg));
    for(let i=0;i<out.length;i++){
      const row=out[i],e=ev[i],p=ev[i-1],n=ev[i+1];
      const temporal=!!((p&&(p.ordinaryShare>=cfg.temporalProbability||p.rr>=cfg.weakSignalRrMmH||p.wet>=cfg.wetSignalPct))||(n&&(n.ordinaryShare>=cfg.temporalProbability||n.rr>=cfg.weakSignalRrMmH||n.wet>=cfg.wetSignalPct)));
      const strongModels=e.ordinaryShare>=cfg.strongModelShare&&e.ordinaryCount>=cfg.minModelsForSpike;
      const otherChange=significantConsensusChange(row,out[i-1])||significantConsensusChange(row,out[i+1]);
      const lowVis=finite(+row.VIS)&&+row.VIS<5000,protectedEvent=e.frozenShare>=cfg.temporalProbability||e.tsShare>=cfg.temporalProbability;
      const moderateOrHeavy=e.rr>=cfg.weakRrMmH||e.moderateShare>=cfg.temporalProbability;
      const weakSignal=e.ordinaryShare>=cfg.temporalProbability||e.rr>=cfg.weakSignalRrMmH||e.wet>=cfg.wetSignalPct;
      const confirmed=temporal||strongModels||e.advection||lowVis||otherChange,suppressWeak=weakSignal&&!protectedEvent&&!moderateOrHeavy&&!confirmed;
      row.__hybridTuning={...e,temporal,strongModels,otherChange,lowVis,protectedEvent,moderateOrHeavy,weakSignal,confirmed,suppressWeak,allowWeakOrdinary:!suppressWeak};
      if(suppressWeak)row.wet=0;else if(moderateOrHeavy&&e.rr>=cfg.weakRrMmH)row.wet=Math.max(finite(+row.wet)?+row.wet:0,70);
      row.mv=row.mv.map((m,j)=>{
        const q=wmoPrecipInfo(m?.code),x={...m},src=modelId(m,j);x.sourceModelId=src;x.id=`CONSENSUS::${src}`;x.model=x.id;
        if(cfg.consensusPrimary){if(finite(+row.WS))x.ws=+row.WS;if(finite(+row.WD))x.wd=+row.WD;if(finite(+row.G))x.g=+row.G;else if(finite(+row.WS))x.g=+row.WS;if(finite(+row.VIS))x.vis=+row.VIS;if(finite(+row.ceiling))x.ceil=+row.ceiling;}
        if(suppressWeak&&q.ordinary&&q.intensity==='weak')x.code=0;
        return x;
      });
    }
    return out;
  }

  const p2=n=>String(n).padStart(2,'0');
  function ddhh(t){const d=new Date(t);return p2(d.getUTCDate())+p2(d.getUTCHours());}
  function ddhhmm(t){const d=new Date(t);return ddhh(t)+p2(d.getUTCMinutes());}
  function ddhhEnd(t){const d=new Date(t);if(d.getUTCHours()===0&&d.getUTCMinutes()===0){const q=new Date(t-1);return p2(q.getUTCDate())+'24';}return ddhh(t);}
  const ordinaryPayload=s=>/(^|\s)[+-]?(?:RA|DZ|SN|SHRA|SHSN|RASN|SNRA)(?=\s|$)/.test(String(s||''))&&!/(^|\s)(?:TS|FZ)/.test(String(s||''));
  const groupHours=(r,g)=>(r.hourly||[]).filter(h=>h.t>=g.start&&h.t<g.end);
  const hourAllows=h=>{const e=h?.sourceRow?.__hybridTuning;return !e||e.allowWeakOrdinary||e.protectedEvent||e.moderateOrHeavy;};
  function rebuildTaf(r){let t=`TAF ${r.station} ${ddhhmm(r.issue)}Z ${ddhh(r.start)}/${ddhhEnd(r.end)} ${r.base.text}`;for(const g of r.groups||[])t+=`\n${g.kind} ${ddhh(g.start)}/${ddhhEnd(g.end)} ${g.payload}`;return t+'=';}

  function postprocessResult(result){
    if(!result||!Array.isArray(result.groups))return result;
    const before=result.groups.length,kept=[],suppressed=[];
    for(const g of result.groups){
      const weak=g.event==='precip'||ordinaryPayload(g.payload);if(!weak){kept.push(g);continue;}
      const allowed=groupHours(result,g).some(hourAllows),piggyback=Array.isArray(g.fields)&&g.fields.some(x=>x!=='weather');
      if(allowed||piggyback)kept.push(g);else suppressed.push(g);
    }
    result.groups=kept;if(suppressed.length){result.taf=rebuildTaf(result);if(result.checks)result.checks.max5=result.groups.length<=5;}
    const baseVersion=result.version;result.baseEngineVersion=baseVersion;result.version=`${baseVersion}+CP${VERSION}`;
    result.diagnostics=result.diagnostics||{};result.diagnostics.consensusPrimary=true;
    result.diagnostics.precipitationFilter={version:VERSION,suppressedGroups:suppressed.length,suppressedWeakHours:(result.hourly||[]).filter(h=>h?.sourceRow?.__hybridTuning?.suppressWeak).length};
    if(Array.isArray(result.diagnostics.layers))result.diagnostics.layers.push({id:'P',name:'consensus-primary-precip-significance',status:'ok',suppressedGroups:suppressed.length});
    if(suppressed.length&&Array.isArray(result.diagnostics.reasons))result.diagnostics.reasons.push(`Filtr istotności opadu: pominięto ${suppressed.length} grupę/grupy słabego, niepotwierdzonego opadu.`);
    result.tuning={version:VERSION,consensusPrimary:true,suppressedGroups:suppressed.length,groupsBefore:before,groupsAfter:kept.length};return result;
  }

  function wrapApi(core,options={}){
    if(!core?.createEngine)throw Error('Brak bazowego Hybrid TAF Engine');const cfg=cfgOf(options);
    return Object.freeze({...core,ENGINE_VERSION:`${core.ENGINE_VERSION}+CP${VERSION}`,BASE_ENGINE_VERSION:core.ENGINE_VERSION,TUNING_VERSION:VERSION,
      createEngine(engineOptions={}){const inner=core.createEngine(engineOptions);return{
        generate(input){return postprocessResult(inner.generate({...input,rows:tuneRows(input?.rows||[],cfg)}));},
        learn:o=>inner.learn(o),getLearningState:()=>inner.getLearningState(),getLearningSummary:()=>inner.getLearningSummary(),importLearningState:s=>inner.importLearningState(s),resetLearning:()=>inner.resetLearning()
      };}
    });
  }
  return Object.freeze({VERSION,DEFAULTS,wmoPrecipInfo,rowEvidence,significantConsensusChange,tuneRows,postprocessResult,wrapApi});
});

(()=>{
  if(typeof window==='undefined'||typeof location==='undefined')return;
  if(!/\/taf\.html$/i.test(location.pathname)||window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__)return;window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__=true;
  const loadScript=src=>new Promise((resolve,reject)=>{const key=src.split('?')[0],e=[...document.scripts].find(s=>s.src&&s.src.includes(key));if(e){if(e.dataset.loaded==='1'||(key.includes('taf-hybrid-engine')&&window.PrognozaEPIRTAFHybridEngine))return resolve();e.addEventListener('load',resolve,{once:true});e.addEventListener('error',()=>reject(Error('Nie udało się załadować '+src)),{once:true});return;}const s=document.createElement('script');s.src=src;s.async=false;s.dataset.tafHybrid='1';s.onload=()=>{s.dataset.loaded='1';resolve();};s.onerror=()=>reject(Error('Nie udało się załadować '+src));(document.head||document.documentElement).appendChild(s);});
  (async()=>{try{
    if(!window.PrognozaEPIRTAFHybridEngine)await loadScript('taf-hybrid-engine.js?v=20260912-hybrid-v2');
    window.PrognozaEPIRTAFHybridEngine=window.PrognozaEPIRTAFHybridTuning.wrapApi(window.PrognozaEPIRTAFHybridEngine);
    await loadScript('taf-hybrid-adapter.js?v=20260912-hybrid-v2');
    window.PrognozaEPIRTAFGeneratorPolicy=Object.freeze({mode:'hybrid-consensus-primary',version:window.PrognozaEPIRTAFHybridEngine?.ENGINE_VERSION||null,tuning:window.PrognozaEPIRTAFHybridTuning.VERSION});
  }catch(e){console.error('[TAF Hybrid bootstrap]',e);const b=document.getElementById('badge'),st=document.getElementById('st');if(b){b.textContent='BŁĄD HYBRID';b.className='badge bad';}if(st)st.textContent=e.message;}})();
})();