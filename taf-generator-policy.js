'use strict';

(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFHybridTuning=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const VERSION='2.0.0',KT=1.9438444924406,FT=3.2808398950131,HOUR=3600000;
  const finite=Number.isFinite,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const DEFAULTS=Object.freeze({
    consensusPrimary:true,
    weakRrMmH:.30,
    weakSignalRrMmH:.05,
    temporalProbability:.30,
    strongModelShare:.75,
    minModelsForSpike:4,
    advectionConfirmWeight:.15,
    wetSignalPct:40,
    visibilityThresholds:[800,1500,3000,5000],
    dominantClear:Object.freeze({enabled:true,startHourFrom:18,startHourTo:5,minShare:.75,fewSctMinFt:4000,ordinaryCloudLimitFt:5000})
  });
  const cfgOf=x=>({...DEFAULTS,...(x||{}),dominantClear:{...DEFAULTS.dominantClear,...(x?.dominantClear||{})}});
  const modelId=(m,i)=>String(m?.id||m?.model||m?.name||`model_${i+1}`);
  const circ=(a,b)=>{let d=Math.abs((a||0)-(b||0))%360;return d>180?360-d:d;};
  const visBand=(v,cuts=DEFAULTS.visibilityThresholds)=>{if(!finite(v))return cuts.length;for(let i=0;i<cuts.length;i++)if(v<cuts[i])return i;return cuts.length;};
  const ceilBand=v=>!finite(v)?5:v<200?0:v<300?1:v<500?2:v<1000?3:v<1500?4:5;
  const p2=n=>String(Math.max(0,Math.round(n))).padStart(2,'0');
  const p3=n=>String(Math.max(0,Math.round(n))).padStart(3,'0');
  const p4=n=>String(Math.max(0,Math.round(n))).padStart(4,'0');

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
    if(visBand(+a.VIS)!==visBand(+b.VIS)&&(+a.VIS<5000||+b.VIS<5000))return true;
    const ac=finite(+a.ceiling)?+a.ceiling*FT:null,bc=finite(+b.ceiling)?+b.ceiling*FT:null;
    if(ceilBand(ac)!==ceilBand(bc))return true;
    const aws=finite(+a.WS)?+a.WS*KT:0,bws=finite(+b.WS)?+b.WS*KT:0;
    if(Math.abs(aws-bws)>=10)return true;
    if(finite(+a.WD)&&finite(+b.WD)&&circ(+a.WD,+b.WD)>=60&&(aws>=10||bws>=10))return true;
    const al=finite(+a.lowH)&&+a.lowH*FT<1500&&+a.oktaL>=5,bl=finite(+b.lowH)&&+b.lowH*FT<1500&&+b.oktaL>=5;
    return al!==bl;
  }

  function cloudLayersFromRow(row){
    const out=[];
    for(const [ok,h] of [['oktaL','lowH'],['oktaM','midH'],['oktaH','highH']]){
      const o=+row?.[ok],m=+row?.[h];if(o>0&&finite(m))out.push({okta:o,ft:m*FT});
    }
    return out.sort((a,b)=>a.ft-b.ft);
  }

  function clearCloudCandidate(row,cfg=DEFAULTS){
    const dc=cfg.dominantClear||DEFAULTS.dominantClear,layers=cloudLayersFromRow(row);
    for(const c of layers){
      if(c.okta<=4){if(c.ft<dc.fewSctMinFt)return false;}
      else if(c.ft<dc.ordinaryCloudLimitFt)return false;
    }
    const tsShare=share(row?.mv||[],m=>wmoPrecipInfo(m?.code).ts).share;
    if((finite(+row?.storm)&&+row.storm>=30)||tsShare>=.30)return false;
    return true;
  }

  function dominantClearPlan(rows,start,cfg=DEFAULTS){
    const dc=cfg.dominantClear||DEFAULTS.dominantClear;if(!dc.enabled||!finite(+start))return null;
    const hour=new Date(+start).getUTCHours(),windowOk=hour>=dc.startHourFrom||hour<=dc.startHourTo;if(!windowOk)return null;
    const a=(rows||[]).filter(r=>finite(+r?.t));if(a.length<8)return null;
    const count=a.filter(r=>clearCloudCandidate(r,cfg)).length,ratio=count/a.length;
    return ratio>dc.minShare?{count,total:a.length,share:ratio,startHour:hour}:null;
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
      const confirmed=temporal||strongModels||e.advection||lowVis||otherChange;
      const suppressWeak=weakSignal&&!protectedEvent&&!moderateOrHeavy&&!confirmed;
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

  function ddhh(t){const d=new Date(t);return p2(d.getUTCDate())+p2(d.getUTCHours());}
  function ddhhmm(t){const d=new Date(t);return ddhh(t)+p2(d.getUTCMinutes());}
  function ddhhEnd(t){const d=new Date(t);if(d.getUTCHours()===0&&d.getUTCMinutes()===0){const q=new Date(t-1);return p2(q.getUTCDate())+'24';}return ddhh(t);}
  const ordinaryPayload=s=>/(^|\s)[+-]?(?:RA|DZ|SN|SHRA|SHSN|RASN|SNRA)(?=\s|$)/.test(String(s||''))&&!/(^|\s)(?:TS|FZ)/.test(String(s||''));
  const wxTokenRe=/^(?:NSW|[+-]?(?:MIFG|FZFG|FG|BR|HZ|TSRA|TSGR|TSGS|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ))$/;
  const cloudTokenRe=/^(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)?$/;
  const windTokenRe=/^(?:\d{3}|VRB)\d{2,3}(?:G(?:P99|\d{2,3}))?KT$/;
  const visTokenRe=/^(?:9999|\d{4})$/;
  const groupHours=(r,g)=>(r.hourly||[]).filter(h=>h.t>=g.start&&h.t<g.end);
  const previousHour=(r,g)=>{const a=(r.hourly||[]).filter(h=>h.t<g.start);return a[a.length-1]||r.base?.state||r.hourly?.[0]||null;};
  const targetHour=(r,g)=>{const a=groupHours(r,g);return a[a.length-1]||(r.hourly||[]).find(h=>h.t>=g.end)||null;};
  const hourAllowsWeak=h=>{const e=h?.sourceRow?.__hybridTuning;return !!(e&&(e.lowVis||e.protectedEvent||e.moderateOrHeavy));};
  const lowCeilingImpact=h=>(h?.clouds||[]).some(c=>(c.cover==='BKN'||c.cover==='OVC')&&finite(+c.ft)&&+c.ft<1500);

  function visibilityNeedsGroup(prev,target,cfg=DEFAULTS){
    const a=+prev?.visM,b=+target?.visM;if(!finite(a)||!finite(b))return false;
    if(a>=5000&&b>=5000)return false;
    return visBand(a,cfg.visibilityThresholds)!==visBand(b,cfg.visibilityThresholds);
  }

  function significantWxAtHour(h){
    const e=h?.sourceRow?.__hybridTuning,p=h?.prob||{};
    if((p.ts||0)>=.30||(p.frozen||0)>=.30)return true;
    if(finite(+h?.visM)&&+h.visM<5000&&((p.fog||0)>=.30||(p.precip||0)>=.30))return true;
    return !!(e?.moderateOrHeavy||e?.protectedEvent);
  }

  function projectCavokHour(h,plan){
    return !!(plan&&h&&finite(+h.visM)&&+h.visM>=10000&&!significantWxAtHour(h));
  }

  function tokenizePayload(s){return String(s||'').trim().split(/\s+/).filter(Boolean);}
  function selectiveBecmgPayload(result,g,plan,cfg){
    const prev=previousHour(result,g),target=targetHour(result,g),fields=new Set(Array.isArray(g.fields)?g.fields:[]),tokens=tokenizePayload(g.payload),out=[];
    const wind=tokens.find(t=>windTokenRe.test(t)),vis=tokens.find(t=>visTokenRe.test(t)),wx=tokens.filter(t=>wxTokenRe.test(t)),cloud=tokens.filter(t=>cloudTokenRe.test(t)||t==='NSC');
    const visNeeded=fields.has('visibility')&&visibilityNeedsGroup(prev,target,cfg);
    if(fields.has('wind')&&wind)out.push(wind);
    const aviationFields=fields.has('visibility')||fields.has('weather')||fields.has('ceiling')||fields.has('convective');
    if(aviationFields&&projectCavokHour(target,plan)){out.push('CAVOK');return{payload:out.join(' '),fields:[...fields].filter(f=>f!=='visibility'||visNeeded),visNeeded};}
    if(visNeeded&&vis)out.push(vis);
    if(fields.has('weather')||fields.has('convective'))out.push(...wx);
    if(fields.has('ceiling')||fields.has('convective')){
      if(cloud.length)out.push(...cloud);else out.push('NSC');
    }
    const newFields=[...fields].filter(f=>f!=='visibility'||visNeeded);
    return{payload:[...new Set(out)].join(' '),fields:newFields,visNeeded};
  }

  function strictPrecipImpact(result,g){
    const hs=groupHours(result,g);if(!hs.length)return false;
    if(hs.some(h=>hourAllowsWeak(h)))return true;
    if(hs.some(h=>finite(+h.visM)&&+h.visM<5000))return true;
    if(hs.some(lowCeilingImpact))return true;
    if(Array.isArray(g.fields)&&g.fields.some(x=>x!=='weather'&&x!=='visibility'))return true;
    return false;
  }

  function baseWind(text){return tokenizePayload(text).find(t=>windTokenRe.test(t))||'';}
  function encodedVis(v){if(!finite(+v)||+v>=10000)return'9999';if(+v<800)return p4(clamp(Math.round(+v/50)*50,0,750));if(+v<5000)return p4(clamp(Math.round(+v/100)*100,800,4900));return p4(clamp(Math.round(+v/1000)*1000,5000,9000));}
  function encodedWxForBase(h){
    const p=h?.prob||{},e=h?.sourceRow?.__hybridTuning;
    if((p.ts||0)>=.5)return (h?.RR||0)>=.1?'TSRA':'TS';
    if((p.frozen||0)>=.5)return'FZRA';
    if((p.fog||0)>=.5&&+h.visM<=1000)return'FG';
    if((p.fog||0)>=.3&&+h.visM<5000)return'BR';
    if(e?.moderateOrHeavy&&(p.precip||0)>=.5)return (h?.RR||0)>=.3?'RA':'-RA';
    return'';
  }

  function applyDominantClearBase(result,plan){
    if(!plan||!result?.base?.state)return false;
    const h=result.base.state,wind=baseWind(result.base.text||'')||'00000KT',wx=encodedWxForBase(h);
    if(finite(+h.visM)&&+h.visM>=10000&&!wx){result.base.text=`${wind} CAVOK`;return true;}
    const vis=encodedVis(h.visM),parts=[wind,vis];if(wx)parts.push(wx);parts.push('NSC');result.base.text=parts.join(' ');return true;
  }

  function rebuildTaf(r){let t=`TAF ${r.station} ${ddhhmm(r.issue)}Z ${ddhh(r.start)}/${ddhhEnd(r.end)} ${r.base.text}`;for(const g of r.groups||[])t+=`\n${g.kind} ${ddhh(g.start)}/${ddhhEnd(g.end)} ${g.payload}`;return t+'=';}

  function postprocessResult(result,ctx={}){
    if(!result||!Array.isArray(result.groups))return result;
    const cfg=cfgOf(ctx.config),rows=ctx.rows||result.hourly?.map(h=>h.sourceRow).filter(Boolean)||[],plan=dominantClearPlan(rows,result.start,cfg),before=result.groups.length,kept=[],suppressed=[];
    applyDominantClearBase(result,plan);
    for(const original of result.groups){
      const g={...original,fields:Array.isArray(original.fields)?[...original.fields]:original.fields};
      if(g.kind==='BECMG'){
        const q=selectiveBecmgPayload(result,g,plan,cfg);g.payload=q.payload;g.fields=q.fields;
        if(!g.payload){suppressed.push({...g,reason:'no-significant-fields'});continue;}
      }
      const ordinary=g.event==='precip'||ordinaryPayload(g.payload);
      if(ordinary&&!strictPrecipImpact(result,g)){suppressed.push({...g,reason:'weak-precip-no-impact'});continue;}
      if(g.kind==='PROB30'&&ordinary){
        const hs=groupHours(result,g),lowVis=hs.some(h=>finite(+h.visM)&&+h.visM<5000);
        if(!lowVis)g.payload=tokenizePayload(g.payload).filter(t=>!visTokenRe.test(t)).join(' ');
        if(!g.payload||/^[-+]?RA$/.test(g.payload)||/^[-+]?DZ$/.test(g.payload)){suppressed.push({...g,reason:'standalone-light-precip'});continue;}
      }
      kept.push(g);
    }
    result.groups=kept;
    result.taf=rebuildTaf(result);
    if(result.checks)result.checks.max5=result.groups.length<=5;
    const baseVersion=result.version;result.baseEngineVersion=baseVersion;result.version=`${baseVersion}+H${VERSION}`;
    result.diagnostics=result.diagnostics||{};result.diagnostics.consensusPrimary=true;
    result.diagnostics.dominantClear=plan;
    result.diagnostics.significancePolicy={version:VERSION,suppressedGroups:suppressed.length,suppressed:suppressed.map(x=>({kind:x.kind,reason:x.reason,start:x.start,end:x.end}))};
    if(Array.isArray(result.diagnostics.layers))result.diagnostics.layers.push({id:'S',name:'aviation-significance-and-cavok',status:'ok',suppressedGroups:suppressed.length,dominantClear:!!plan});
    if(Array.isArray(result.diagnostics.reasons)){
      if(plan)result.diagnostics.reasons.push(`Reguła 18–05 UTC: ${plan.count}/${plan.total} h (${Math.round(plan.share*100)}%) spełnia FEW/SCT ≥4000 ft / brak istotnej niskiej warstwy — baza CAVOK/NSC.`);
      if(suppressed.length)result.diagnostics.reasons.push(`Filtr istotności lotniczej: pominięto ${suppressed.length} grupę/grupy bez przekroczenia progu operacyjnego.`);
    }
    result.tuning={version:VERSION,consensusPrimary:true,dominantClear:plan,suppressedGroups:suppressed.length,groupsBefore:before,groupsAfter:kept.length};
    return result;
  }

  function wrapApi(core,options={}){
    if(!core?.createEngine)throw Error('Brak bazowego Hybrid TAF Engine');const cfg=cfgOf(options);
    return Object.freeze({...core,ENGINE_VERSION:`${core.ENGINE_VERSION}+H${VERSION}`,BASE_ENGINE_VERSION:core.ENGINE_VERSION,TUNING_VERSION:VERSION,
      createEngine(engineOptions={}){const inner=core.createEngine(engineOptions);return{
        generate(input){const tuned=tuneRows(input?.rows||[],cfg),r=inner.generate({...input,rows:tuned});return postprocessResult(r,{rows:tuned,config:cfg});},
        learn:o=>inner.learn(o),getLearningState:()=>inner.getLearningState(),getLearningSummary:()=>inner.getLearningSummary(),importLearningState:s=>inner.importLearningState(s),resetLearning:()=>inner.resetLearning()
      };}
    });
  }

  return Object.freeze({VERSION,DEFAULTS,wmoPrecipInfo,rowEvidence,significantConsensusChange,clearCloudCandidate,dominantClearPlan,tuneRows,visibilityNeedsGroup,selectiveBecmgPayload,strictPrecipImpact,postprocessResult,wrapApi});
});

(()=>{
  if(typeof window==='undefined'||typeof location==='undefined')return;
  if(!/\/taf\.html$/i.test(location.pathname)||window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__)return;window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__=true;
  const loadScript=src=>new Promise((resolve,reject)=>{const key=src.split('?')[0],e=[...document.scripts].find(s=>s.src&&s.src.includes(key));if(e){if(e.dataset.loaded==='1'||(key.includes('taf-hybrid-engine')&&window.PrognozaEPIRTAFHybridEngine))return resolve();e.addEventListener('load',resolve,{once:true});e.addEventListener('error',()=>reject(Error('Nie udało się załadować '+src)),{once:true});return;}const s=document.createElement('script');s.src=src;s.async=false;s.dataset.tafHybrid='1';s.onload=()=>{s.dataset.loaded='1';resolve();};s.onerror=()=>reject(Error('Nie udało się załadować '+src));(document.head||document.documentElement).appendChild(s);});
  (async()=>{try{
    if(!window.PrognozaEPIRTAFHybridEngine)await loadScript('taf-hybrid-engine.js?v=20260913-hybrid-v3');
    window.PrognozaEPIRTAFHybridEngine=window.PrognozaEPIRTAFHybridTuning.wrapApi(window.PrognozaEPIRTAFHybridEngine);
    await loadScript('taf-hybrid-adapter.js?v=20260913-hybrid-v3');
    window.PrognozaEPIRTAFGeneratorPolicy=Object.freeze({mode:'hybrid-significance-first',version:window.PrognozaEPIRTAFHybridEngine?.ENGINE_VERSION||null,tuning:window.PrognozaEPIRTAFHybridTuning.VERSION});
  }catch(e){console.error('[TAF Hybrid bootstrap]',e);const b=document.getElementById('badge'),st=document.getElementById('st');if(b){b.textContent='BŁĄD HYBRID';b.className='badge bad';}if(st)st.textContent=e.message;}})();
})();
