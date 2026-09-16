'use strict';
(function(root,factory){
  let base=null;
  if(typeof module!=='undefined'&&module.exports){
    base=require('./taf-engine-v24.js');
    module.exports=factory(base,null);
  }else{
    base=root&&root.PrognozaEPIRTAFEngine;
    if(!base)throw new Error('TAF Engine 2.4.1 requires taf-engine-v24.js');
    root.PrognozaEPIRTAFEngine=factory(base,root);
  }
})(typeof window!=='undefined'?window:globalThis,function(base,root){
  'use strict';

  // API_VERSION remains 2.4.0 for the existing UI compatibility check.
  // Every generated result carries the actual semantic layer version 2.4.1.
  const API_VERSION='2.4.0';
  const VERSION='2.4.1';
  const NAME='TAF Engine 2.4.1 — EPIR Semantic Quality + Instruction First';
  const HOUR=3600000, FT=3.2808398950131;
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const pad=(n,w=2)=>String(Math.max(0,Math.round(n))).padStart(w,'0');

  function codeInfo(code){
    const c=Math.round(+code);
    return {
      ts:[95,96,99].includes(c),
      precip:[51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(c),
      light:[51,56,61,66,71,77,80,85].includes(c),
      moderate:[53,63,73,81].includes(c),
      heavy:[55,57,65,67,75,82,86].includes(c),
      snow:[71,73,75,77,85,86].includes(c)
    };
  }
  function memberWeight(m){return num(m?.w)&&+m.w>0?+m.w:1;}
  function weightedShare(members,pred){
    let n=0,d=0;for(const m of members||[]){const w=memberWeight(m);d+=w;if(pred(m))n+=w;}return d?n/d:0;
  }

  // The formal kernel uses a legacy RR scale to choose -, no sign, or +.
  // Convert physical/model evidence to that internal categorical scale here.
  // Rain reference thresholds: light <2.5 mm/h, moderate 2.5-10, heavy >=10.
  function precipitationProxy(row){
    const members=Array.isArray(row?.mv)?row.mv:[];
    if(members.length){
      let all=0,prec=0,light=0,moderate=0,heavy=0;
      for(const m of members){
        const w=memberWeight(m),i=codeInfo(m?.code);all+=w;
        if(i.precip&&!i.ts){prec+=w;if(i.light)light+=w;if(i.moderate)moderate+=w;if(i.heavy)heavy+=w;}
      }
      if(prec>0){
        const pr=prec/(all||1),hr=heavy/prec,mr=moderate/prec;
        if(pr>=.30){if(hr>=.45)return .80;if(hr+mr>=.45)return .30;return .05;}
      }
    }
    const rr=num(row?.RR)?Math.max(0,+row.RR):0;
    if(rr>=10)return .80;
    if(rr>=2.5)return .30;
    if(rr>0)return .05;
    return 0;
  }

  function scoreToProbability(score){
    if(!num(score))return 0;
    const s=clamp(+score,0,100);
    if(s>=80)return .50;
    if(s>=60)return .30+(s-60)*.01;
    if(s>=50)return .18+(s-50)*.012;
    return 0;
  }
  function probabilityToOperationalScore(p){
    if(!num(p)||+p<.30)return null;
    if(+p>=.50)return 80;
    return clamp(60+(+p-.30)*100,60,79.9);
  }

  function rawFogAvailable(r){
    if(r?.fogEngineAvailable===true)return true;
    return ['fogEngineScore','fogEngineVisM','fogEngineConfidence','fogVis1500Risk','fogVis1000Risk','fogVis500Risk','fogVis200Risk']
      .some(k=>num(r?.[k]));
  }

  function normalizeFogEvidence(row){
    const x={...row};
    const available=rawFogAvailable(x);
    if(!available){
      // Legacy app used 0 for missing data. Missing is not evidence of no fog.
      if((x.fogOperationalScore===0||x.fogOperationalScore===null)&&!num(x.fogEngineConfidence)&&!num(x.fogEngineVisM))x.fogOperationalScore=null;
      if((x.fgOperationalScore===0||x.fgOperationalScore===null)&&!num(x.fogVis1000Risk))x.fgOperationalScore=null;
      if(x.brOperationalScore===0)x.brOperationalScore=null;
      x.fogEngineAvailable=false;
      return x;
    }

    x.fogEngineAvailable=true;
    const score=num(x.fogEngineScore)?+x.fogEngineScore:(num(x.fogOperationalScore)?+x.fogOperationalScore:null);
    const vis1000=num(x.fogVis1000Risk)?+x.fogVis1000Risk:null;
    const engineProb=Math.max(scoreToProbability(score),scoreToProbability(vis1000));
    const modelFg=weightedShare(x.mv,m=>num(m?.vis)&&+m.vis<1000);
    const conf=num(x.fogEngineConfidence)?clamp(+x.fogEngineConfidence,0,1):.60;

    // Evidence fusion rather than a veto: strong Fog Engine evidence is retained,
    // while a weak engine signal may not erase a coherent multimodel fog signal.
    const blended=Math.max(engineProb,engineProb*(.55+.20*conf)+modelFg*(.45-.20*conf));
    const fused=Math.max(blended,modelFg*(engineProb>=.30?.85:1));
    const op=probabilityToOperationalScore(fused);
    if(op!==null){x.fogOperationalScore=op;x.fgOperationalScore=op;}
    else {
      x.fogOperationalScore=null;x.fgOperationalScore=null;
      if(modelFg>0)x.fgRisk=Math.max(num(x.fgRisk)?(+x.fgRisk>1?+x.fgRisk/100:+x.fgRisk):0,modelFg);
    }

    if(num(x.fogEngineVisM)&&+x.fogEngineVisM>=1000&&+x.fogEngineVisM<=5000){
      const brp=Math.max(scoreToProbability(score),scoreToProbability(x.fogVis1500Risk));
      x.brOperationalScore=probabilityToOperationalScore(brp);
    }
    x.taf241Fog={engineScore:score,engineProbabilityProxy:engineProb,modelFg,fusedProbability:fused,confidence:conf};
    return x;
  }

  function observationTime(o,ref){
    if(!o)return NaN;
    for(const k of ['obs_time','message_time','issue_time','time','timestamp']){const t=Date.parse(o[k]||'');if(finite(t))return t;}
    const raw=String(o.raw||o.canonical_raw||'');const m=raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);if(!m)return NaN;
    const R=new Date(ref||Date.now()),a=[];
    for(let dm=-1;dm<=1;dm++)a.push(Date.UTC(R.getUTCFullYear(),R.getUTCMonth()+dm,+m[1],+m[2],+m[3]));
    return a.sort((a,b)=>Math.abs(a-(ref||Date.now()))-Math.abs(b-(ref||Date.now())))[0];
  }
  function observedConvective(o,issue){
    const t=observationTime(o,issue);if(!finite(t)||t>issue)return null;
    const raw=String(o?.raw||o?.canonical_raw||'').toUpperCase();
    const layers=[...raw.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)\b/g)].map(m=>({cover:m[1],ft:+m[2]*100,type:m[3]}));
    if(!layers.length)return null;
    return {t,layers};
  }
  function convectiveInitialSupport(cover){return ({FEW:.40,SCT:.58,BKN:.78,OVC:.88})[cover]||.40;}

  function addObservedConvectiveEvidence(rows,input){
    const obs=observedConvective(input?.observation,+input.issue);if(!obs)return rows;
    return rows.map(src=>{
      const x={...src},lead=Math.max(0,(+x.t-obs.t)/HOUR);
      let best=null;
      for(const l of obs.layers){const p=convectiveInitialSupport(l.cover)*Math.exp(-lead/6);if(!best||p>best.p)best={...l,p};}
      if(!best||best.p<.10)return x;
      x.observedConvectiveSupport=best.p;x.observedConvectiveLayer={cover:best.cover,ft:best.ft,type:best.type};
      // Only >=50% support becomes prevailing cloud evidence. Lower support stays
      // an alternative and is handled by the structured quality gate below.
      if(best.p>=.50){
        const clouds=Array.isArray(x.clouds)?x.clouds.map(c=>({...c})):[];
        if(!clouds.some(c=>String(c.type||'').toUpperCase()===best.type&&Math.abs((num(c.ft)?+c.ft:(+c.m||0)*FT)-best.ft)<150))
          clouds.push({cover:best.cover,ft:best.ft,m:best.ft/FT,type:best.type});
        x.clouds=clouds;
      }
      return x;
    });
  }

  function prepareInput(input={}){
    let rows=(input.rows||[]).map(src=>normalizeFogEvidence({...src,mv:Array.isArray(src.mv)?src.mv.map(m=>({...m})):src.mv}));
    rows=addObservedConvectiveEvidence(rows,input).map(r=>({...r,RR:precipitationProxy(r),taf241PrecipProxy:true}));
    return {...input,rows};
  }

  function payloadTokens(s){return String(s||'').trim().split(/\s+/).filter(Boolean);}
  function isNoOpProbabilityGroup(g,baseText){
    if(!/^PROB30/.test(String(g?.kind||'')))return false;
    const p=payloadTokens(g.payload),b=new Set(payloadTokens(baseText));
    return p.length>0&&p.every(t=>b.has(t));
  }
  function groupOverlap(a,b){return a.s<b.e&&b.s<a.e;}
  function periodCode(t){const d=new Date(+t);return pad(d.getUTCDate())+pad(d.getUTCHours());}
  function windowText(kind,s,e,payload){return `${kind} ${periodCode(s)}/${periodCode(e)} ${payload}`;}

  function addObservedCbAlternative(groups,rows,input,reasons){
    if(groups.some(g=>/\b(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)\b/.test(String(g.payload||''))))return groups;
    const baseHasConv=rows.some((r,i)=>i<3&&+r.observedConvectiveSupport>=.50);
    if(baseHasConv)return groups;
    const candidates=rows.filter(r=>+r.observedConvectiveSupport>=.30&&r.observedConvectiveLayer);
    if(!candidates.length)return groups;

    const first=candidates[0];let last=first;
    for(const r of candidates.slice(1)){if(+r.t-(+last.t)<=1.5*HOUR)last=r;else break;}
    let s=Math.max(+input.start,+first.t),e=Math.min(+input.end,+last.t+HOUR);
    if(e-s<2*HOUR)e=Math.min(+input.end,s+2*HOUR);
    if(e-s>4*HOUR)e=s+4*HOUR;
    const l=first.observedConvectiveLayer,payload=`${l.cover}${pad(Math.floor(l.ft/100),3)}${l.type}`;
    const probability=Math.max(...candidates.filter(r=>+r.t>=s&&+r.t<e).map(r=>+r.observedConvectiveSupport));

    const existing=groups.find(g=>g.kind==='PROB30 TEMPO'&&groupOverlap(g,{s,e}));
    if(existing){
      if(!String(existing.payload||'').includes(payload)){
        existing.payload=[...new Set([...payloadTokens(existing.payload),payload])].join(' ');
        existing.fields=[...new Set([...(existing.fields||[]),'clouds'])];
        existing.probability=Math.max(existing.probability||0,probability);
        existing.text=windowText(existing.kind,existing.s,existing.e,existing.payload);
        reasons.push(`${existing.text}: dołączono obserwacyjny sygnał ${l.type} z METAR/SPECI do istniejącej alternatywy konwekcyjnej.`);
      }
      return groups;
    }
    if(groups.some(g=>g.kind==='PROB30 TEMPO')||groups.length>=5){
      reasons.push(`${periodCode(s)} UTC: sygnał ${l.type} ${Math.round(probability*100)}% zachowano diagnostycznie — limit grup PROB30 TEMPO.`);return groups;
    }
    const g={kind:'PROB30 TEMPO',s,e,fields:['clouds'],payload,probability,text:windowText('PROB30 TEMPO',s,e,payload),source:'observed-convective-memory'};
    groups.push(g);reasons.push(`${g.text}: pamięć obserwowanego ${l.type}; wsparcie po zaniku czasowym ${Math.round(probability*100)}%.`);
    return groups;
  }

  function rebuildTaf(result,groups){
    const first=String(result.taf||'').split(/\n+/)[0].replace(/=$/,'').trim();
    return [first,...groups.sort((a,b)=>a.s-b.s||a.e-b.e).map(g=>g.text)].filter(Boolean).join('\n')+'=';
  }

  function qualityGate(result,input,engine){
    const reasons=[...(result?.diagnostics?.reasons||[])];
    let groups=(result.groups||[]).map(g=>({...g,fields:[...(g.fields||[])]}));
    const removed=groups.filter(g=>isNoOpProbabilityGroup(g,result?.base?.text));
    if(removed.length){
      groups=groups.filter(g=>!removed.includes(g));
      for(const g of removed)reasons.push(`${g.text}: usunięto grupę bez nowej informacji — warunki już występują w części bazowej.`);
    }
    groups=addObservedCbAlternative(groups,input.rows||[],input,reasons);
    const taf=rebuildTaf(result,groups);
    const checks=engine.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){const e=Error('TAF 2.4.1 odrzucony przez końcową kontrolę instrukcji: '+checks.errors.join(' | '));e.validation=checks;throw e;}
    const fogRows=(input.rows||[]).filter(r=>r.fogEngineAvailable===true);
    return {
      ...result,taf,groups,checks:{...result.checks,...checks},version:VERSION,name:NAME,
      diagnostics:{...result.diagnostics,reasons,semanticQualityLayer:VERSION,structuredFinalization:true,
        precipitationPolicy:'model WMO weather-code intensity first; RR fallback: rain <2.5 light, 2.5-10 moderate, >=10 mm/h heavy',
        fogFusionPolicy:'Fog Engine is evidence, not a hard veto; missing!=0; weak engine signal cannot erase coherent multimodel FG',
        convectiveCloudPolicy:'issue-time-safe METAR/SPECI CB/TCU memory with 6 h decay; >=50% prevailing, 30-49% structured PROB30 TEMPO alternative',
        noOpGroupPolicy:'probability groups identical to prevailing base conditions are removed before final validation',
        fogEvidence:{availableHours:fogRows.length,totalHours:(input.rows||[]).length}}
    };
  }

  function createEngine(options={}){
    const engine=base.createEngine(options);
    return Object.freeze({
      version:VERSION,rules:base.RULES,
      generate(input={}){const prepared=prepareInput(input),result=engine.generate(prepared);return qualityGate(result,prepared,engine);},
      validate:(taf,meta)=>engine.validate(taf,meta),
      helpers:Object.freeze({...engine.helpers,prepareInput,precipitationProxy,normalizeFogEvidence,observedConvective})
    });
  }

  if(root){root.__PROGNOZA_EPIR_TAF_ENGINE_V241__=true;}
  return Object.freeze({ENGINE_VERSION:API_VERSION,QUALITY_VERSION:VERSION,ENGINE_NAME:NAME,INSTRUCTION:base.INSTRUCTION,RULES:base.RULES,FORMAL_KERNEL_VERSION:base.FORMAL_KERNEL_VERSION||base.ENGINE_VERSION,createEngine,validateTaf:(taf,meta)=>base.validateTaf(taf,meta),ready:base.ready,setLearningData:base.setLearningData,learningStatus:base.learningStatus,helpers:Object.freeze({...base.helpers,prepareInput,precipitationProxy,normalizeFogEvidence,observedConvective})});
});
