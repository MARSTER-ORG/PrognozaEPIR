'use strict';
(function(root,factory){
  let base=null;
  if(typeof module!=='undefined'&&module.exports){
    base=require('./taf-engine-v242.js');
    module.exports=factory(base,null);
  }else{
    base=root&&root.PrognozaEPIRTAFEngine;
    if(!base)throw new Error('TAF Engine 2.4.3 requires taf-engine-v242.js');
    root.PrognozaEPIRTAFEngine=factory(base,root);
  }
})(typeof window!=='undefined'?window:globalThis,function(base,root){
  'use strict';

  // Public/API version remains unchanged because taf.html and taf-app-v25.js
  // intentionally pin the 2.4.3 runtime marker. This file carries the
  // 2026-09-19 operational weather/cloud policy revision.
  const API_VERSION='2.4.0';
  const VERSION='2.4.3';
  const POLICY_REVISION='2026-09-19d';
  const NAME='TAF Engine 2.4.3 — Prevailing Wind + Operational Weather/Cloud Priority + Instruction First';
  const GUST_PREVAILING_MIN_FRACTION=.50;
  const WEAK_PRECIP_VIS_LIMIT_M=5000;
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const WIND_RE=/\b(?:VRB|\d{3})(?:P99|\d{2,3})(?:G(?:P99|\d{2,3}))?KT\b/;
  const CLOUD_TOKEN_RE=/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/;
  const CONVECTIVE_CLOUD_RE=/\b(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)\b/;
  const SHRA_TOKEN_RE=/^(?:\+|-)?SHRA$/;
  const WEAK_ORDINARY_PRECIP_RE=/^-(?:(?:DZ|RA|SN|SG|PL)){1,3}$/;

  function circ(a,b){
    if(!finite(a)||!finite(b))return 180;
    let d=Math.abs(a-b)%360;
    return d>180?360-d:d;
  }

  function quantile(values,p){
    const a=(values||[]).filter(finite).sort((x,y)=>x-y);
    if(!a.length)return NaN;
    if(a.length===1)return a[0];
    const x=(a.length-1)*clamp(p,0,1),lo=Math.floor(x),hi=Math.ceil(x);
    return a[lo]+(a[hi]-a[lo])*(x-lo);
  }

  // Instruction 3.7.9/3.7.11a: the main/initial TAF section may contain
  // precipitation of any intensity even when visibility remains >=5 km.
  // Therefore v2.4.3 must not pre-filter RA/DZ/SN from model input. Change-
  // group significance is handled after the formal kernel builds its groups.
  function prepareOperationalWeatherInput(input={}){
    const rows=(input.rows||[]).map(src=>({
      ...src,
      mv:Array.isArray(src?.mv)?src.mv.map(m=>({...m})):[]
    }));
    return {
      ...input,rows,
      taf243WeatherPolicy:{
        basePrecipitationVisibilityIndependent:true,
        weakOrdinaryStandaloneChangeVisLimitM:WEAK_PRECIP_VIS_LIMIT_M
      }
    };
  }

  function parseCloudToken(token){
    const m=String(token||'').match(CLOUD_TOKEN_RE);
    return m?{cover:m[1],height:+m[2],type:m[3]||''}:null;
  }

  // If a prevailing ordinary BKN/OVC layer exists in the same forecast state,
  // weaker ordinary FEW/SCT layers are omitted. FEW/SCT are retained when there
  // is no BKN/OVC, and CB/TCU are always retained.
  function simplifyCloudTokens(text){
    const tokens=String(text||'').trim().split(/\s+/).filter(Boolean);
    const parsed=tokens.map(t=>({token:t,cloud:parseCloudToken(t)}));
    const hasOrdinaryCeiling=parsed.some(x=>x.cloud&&!x.cloud.type&&(x.cloud.cover==='BKN'||x.cloud.cover==='OVC'));
    if(!hasOrdinaryCeiling)return String(text||'').trim();
    return parsed.filter(x=>!(x.cloud&&!x.cloud.type&&(x.cloud.cover==='FEW'||x.cloud.cover==='SCT'))).map(x=>x.token).join(' ');
  }

  function simplifyCloudLayers(layers){
    const a=Array.isArray(layers)?layers.map(x=>({...x})):[];
    const hasOrdinaryCeiling=a.some(c=>!String(c?.type||'')&&(c?.cover==='BKN'||c?.cover==='OVC'));
    if(!hasOrdinaryCeiling)return a;
    return a.filter(c=>String(c?.type||'')||!(c?.cover==='FEW'||c?.cover==='SCT'));
  }

  function normalizeCloudPresentation(result,input,engine){
    const reasons=[...(result?.diagnostics?.reasons||[])];
    const oldBase=String(result?.base?.text||'');
    const baseText=simplifyCloudTokens(oldBase);
    let simplified=baseText!==oldBase;
    const groups=(result?.groups||[]).map(g=>{
      const oldPayload=String(g?.payload||'');
      const payload=simplifyCloudTokens(oldPayload);
      let text=String(g?.text||'');
      if(oldPayload&&payload!==oldPayload){text=text.replace(oldPayload,payload);simplified=true;}
      else {
        const next=simplifyCloudTokens(text);
        if(next!==text){text=next;simplified=true;}
      }
      return {...g,payload,text};
    });
    const hourly=(result?.hourly||[]).map(h=>{
      const d=h?.tafDisplay?{...h.tafDisplay}:null;
      if(d&&Array.isArray(d.cloudLayers)){
        const old=d.cloudLayers;
        d.cloudLayers=simplifyCloudLayers(old);
        if(d.cloudLayers.length!==old.length)simplified=true;
      }
      return d?{...h,tafDisplay:d}:{...h};
    });

    const firstLines=String(result?.taf||'').replace(/=$/,'').split(/\n+/).filter(Boolean);
    let first=firstLines[0]||'';
    if(oldBase&&baseText!==oldBase&&first.includes(oldBase))first=first.replace(oldBase,baseText);
    const taf=[first,...groups.sort((a,b)=>(+a.s)-(+b.s)||(+a.e)-(+b.e)).map(g=>g.text)].filter(Boolean).join('\n')+'=';
    const checks=engine.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){
      const e=Error('TAF 2.4.3 odrzucony po priorytetyzacji zachmurzenia: '+checks.errors.join(' | '));
      e.validation=checks;throw e;
    }
    if(simplified)reasons.push('Zachmurzenie: przy obecnej warstwie BKN/OVC pominięto słabsze zwykłe FEW/SCT; FEW/SCT pozostają dozwolone, gdy brak BKN/OVC. CB/TCU pozostają niezależne.');
    return {
      ...result,taf,groups,hourly,
      base:{...(result.base||{}),text:baseText},
      checks:{...result.checks,...checks},
      diagnostics:{...result.diagnostics,reasons,cloudPriorityPolicy:'ordinary BKN/OVC suppresses ordinary FEW/SCT in the same state; FEW/SCT remains when no BKN/OVC; CB/TCU always retained'}
    };
  }

  function payloadTokens(payload){
    return String(payload||'').trim().split(/\s+/).filter(Boolean);
  }

  function weakOrdinaryPrecipTokens(payload){
    return payloadTokens(payload).filter(t=>WEAK_ORDINARY_PRECIP_RE.test(t));
  }

  function groupEffectiveVisibilityM(g,hourly){
    const explicit=payloadTokens(g?.payload).find(t=>/^(?:9999|\d{4})$/.test(t));
    if(explicit)return explicit==='9999'?10000:+explicit;
    const vals=(hourly||[])
      .filter(h=>num(h?.t)&&+h.t>=+g.s&&+h.t<+g.e&&num(h?.visM))
      .map(h=>+h.visM);
    return vals.length?quantile(vals,.50):Infinity;
  }

  // Instruction 3.7.9/3.7.10/3.7.11:
  // - all precipitation intensities are allowed in the main TAF section;
  // - moderate/heavy precipitation is itself a change criterion;
  // - freezing precipitation and thunderstorm precipitation are always kept;
  // - weak ordinary precipitation should not create a standalone change group
  //   at VIS >=5 km. It may still be carried when another significant change is
  //   being described (3.7.11b). Convective SHRA/TSRA are handled separately.
  function applyInstructionPrecipitationPolicy(result,input,engine){
    const reasons=[...(result?.diagnostics?.reasons||[])];
    let removed=0;
    const groups=[];
    for(const g0 of result?.groups||[]){
      const g={...g0};
      const weak=weakOrdinaryPrecipTokens(g.payload);
      if(!weak.length){groups.push(g);continue;}
      const otherFields=(g.fields||[]).filter(f=>f!=='weather');
      const vis=groupEffectiveVisibilityM(g,result?.hourly||[]);
      const standaloneWeather=otherFields.length===0;
      if(standaloneWeather&&vis>=WEAK_PRECIP_VIS_LIMIT_M){
        removed++;
        continue;
      }
      groups.push(g);
    }
    if(!removed)return {
      ...result,
      diagnostics:{
        ...result.diagnostics,reasons,
        precipitationPlacementPolicy:'main section: precipitation independent of VIS; change groups: moderate/heavy, freezing and thunderstorm precipitation remain significant; standalone weak ordinary precipitation requires VIS <5 km, while 3.7.11b allows it alongside another significant change'
      }
    };

    const first=String(result?.taf||'').replace(/=$/,'').split(/\n+/).filter(Boolean)[0]||'';
    const taf=[first,...groups.sort((a,b)=>(+a.s)-(+b.s)||(+a.e)-(+b.e)).map(g=>g.text)].filter(Boolean).join('\n')+'=';
    const checks=engine.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){
      const e=Error('TAF 2.4.3 odrzucony po zastosowaniu zasad opadów w grupach zmian: '+checks.errors.join(' | '));
      e.validation=checks;throw e;
    }
    reasons.push(`Opady: usunięto ${removed} samodzielne grupy zmian ze słabym zwykłym opadem przy VIS >= ${WEAK_PRECIP_VIS_LIMIT_M} m. Opad w części głównej pozostaje niezależny od VIS; opady umiarkowane/silne, marznące i burzowe zachowują własne kryteria istotności.`);
    return {
      ...result,taf,groups,
      checks:{...result.checks,...checks},
      diagnostics:{
        ...result.diagnostics,reasons,
        precipitationPlacementPolicy:'main section: precipitation independent of VIS; change groups: moderate/heavy, freezing and thunderstorm precipitation remain significant; standalone weak ordinary precipitation requires VIS <5 km, while 3.7.11b allows it alongside another significant change'
      }
    };
  }

  function showerTokenFromHour(h){
    const tokens=String(h?.tafDisplay?.weather||'').trim().split(/\s+/).filter(Boolean);
    return tokens.find(t=>SHRA_TOKEN_RE.test(t))||'';
  }

  function groupHasConvectiveCloud(g){
    return CONVECTIVE_CLOUD_RE.test(String(g?.payload||g?.text||''));
  }

  function representativeShowerForGroup(g,hourly){
    if(!g||g.kind==='FM')return'';
    const states=(hourly||[]).filter(h=>num(h?.t)&&+h.t>=+g.s&&+h.t<+g.e);
    const tokens=states.map(showerTokenFromHour).filter(Boolean);
    if(!tokens.length)return'';
    const counts=new Map();
    for(const t of tokens)counts.set(t,(counts.get(t)||0)+1);
    const rank=t=>t==='+SHRA'?3:t==='SHRA'?2:1;
    return [...counts.keys()].sort((a,b)=>(counts.get(b)-counts.get(a))||(rank(a)-rank(b)))[0]||'';
  }

  function insertWeatherBeforeCloud(payload,wx){
    const tokens=String(payload||'').trim().split(/\s+/).filter(Boolean);
    if(!wx||tokens.some(t=>SHRA_TOKEN_RE.test(t)||/^(?:\+|-)?TSRA$/.test(t)))return tokens.join(' ');
    const idx=tokens.findIndex(t=>CLOUD_TOKEN_RE.test(t));
    if(idx<0)tokens.push(wx);else tokens.splice(idx,0,wx);
    return tokens.join(' ');
  }

  // Instruction 3.7.11b + 3.11.6a: weak precipitation may be signalled in a
  // change group when another significant change is present; isolated CB/TCU
  // and associated convective showers belong in TEMPO. Therefore -SHRA/SHRA
  // may be present with CB/TCU without repeating a visibility group when VIS
  // itself has not changed significantly.
  function applyConvectiveShowerPolicy(result,input,engine){
    let changed=0;
    const reasons=[...(result?.diagnostics?.reasons||[])];
    const groups=(result?.groups||[]).map(g=>{
      if(!groupHasConvectiveCloud(g))return {...g};
      const wx=representativeShowerForGroup(g,result?.hourly||[]);
      if(!wx)return {...g};
      const oldPayload=String(g?.payload||'');
      const payload=insertWeatherBeforeCloud(oldPayload,wx);
      if(payload===oldPayload)return {...g};
      changed++;
      const text=String(g?.text||'').replace(oldPayload,payload);
      return {...g,payload,text,fields:[...new Set([...(g?.fields||[]),'weather'])]};
    });
    if(!changed)return {
      ...result,
      diagnostics:{...result.diagnostics,reasons,convectiveShowerPolicy:'SHRA is visibility-independent when tied to CB/TCU in a change group; visibility is repeated only when it is itself a significant change'}
    };

    const first=String(result?.taf||'').replace(/=$/,'').split(/\n+/).filter(Boolean)[0]||'';
    const taf=[first,...groups.sort((a,b)=>(+a.s)-(+b.s)||(+a.e)-(+b.e)).map(g=>g.text)].filter(Boolean).join('\n')+'=';
    const checks=engine.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){
      const e=Error('TAF 2.4.3 odrzucony po zastosowaniu reguły SHRA/CB-TCU: '+checks.errors.join(' | '));
      e.validation=checks;throw e;
    }
    reasons.push(`Konwekcja: w ${changed} grupach zmian z CB/TCU zachowano prognozowany SHRA bez uzależniania go od progu VIS ${WEAK_PRECIP_VIS_LIMIT_M} m; widzialności nie powtarzano, jeśli sama nie spełniała kryterium zmiany.`);
    return {
      ...result,taf,groups,checks:{...result.checks,...checks},
      diagnostics:{...result.diagnostics,reasons,convectiveShowerPolicy:'SHRA is visibility-independent when tied to CB/TCU in a change group; visibility is repeated only when it is itself a significant change'}
    };
  }

  function replaceWindToken(text,wind){
    const src=String(text||'');
    return WIND_RE.test(src)?src.replace(WIND_RE,wind):src;
  }

  function representativeWind(hourly,helpers,baseState){
    const states=(hourly||[]).filter(h=>num(h?.windKt));
    if(!states.length)return null;

    const windKt=states.reduce((sum,h)=>sum+Math.max(0,+h.windKt),0)/states.length;
    let u=0,v=0,weight=0;
    for(const h of states){
      if(!finite(+h.windDir))continue;
      const w=Math.max(1,+h.windKt||0),r=(+h.windDir)*Math.PI/180;
      u+=Math.sin(r)*w;
      v+=Math.cos(r)*w;
      weight+=w;
    }
    const windDir=weight?(Math.atan2(u,v)*180/Math.PI+360)%360:(finite(+baseState?.windDir)?+baseState.windDir:null);
    const dirSpreadDeg=finite(windDir)?Math.max(0,...states.map(h=>finite(+h.windDir)?circ(+h.windDir,windDir):0)):(+baseState?.dirSpreadDeg||0);

    const gustStates=states.filter(h=>{
      const token=String(h?.tafDisplay?.wind||helpers.windToken(h)||'');
      return /G(?:P99|\d{2,3})KT\b/.test(token);
    });
    const gustFraction=gustStates.length/states.length;
    const gustPrevailing=gustFraction>=GUST_PREVAILING_MIN_FRACTION;
    const gustKt=gustPrevailing
      ? quantile(gustStates.map(h=>Math.max(+h.gustKt||0,+h.windKt||0)),.60)
      : windKt;

    return {
      state:{...baseState,windKt,windDir,gustKt,dirSpreadDeg},
      sampleHours:states.length,
      gustHours:gustStates.length,
      gustFraction,
      gustPrevailing
    };
  }

  function hasSignificantWindRegime(result,helpers){
    const baseState=result?.base?.state;
    const hourly=Array.isArray(result?.hourly)?result.hourly:[];
    if(!baseState||!hourly.length)return true;
    if(baseState.periodVrbDominant||hourly.some(h=>h?.periodVrbDominant))return true;
    if((result.groups||[]).some(g=>(g?.fields||[]).includes('wind')))return true;
    return hourly.some(h=>{
      try{return (helpers.significantFields(baseState,h)?.fields||[]).includes('wind');}
      catch(_){return true;}
    });
  }

  function policyRules(source={}){
    return {
      ...source,
      prevailingWindFullPeriodWhenNoSignificantChange:true,
      prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION,
      basePrecipitationIndependentOfVisibility:true,
      weakOrdinaryPrecipStandaloneChangeRequiresVisibilityBelowM:WEAK_PRECIP_VIS_LIMIT_M,
      weakOrdinaryPrecipMayAccompanyOtherSignificantChange:true,
      moderateHeavyPrecipChangeIndependentOfVisibility:true,
      freezingThunderstormPrecipChangeIndependentOfVisibility:true,
      convectiveShowerWithCbTcuMayOmitVisibility:true,
      cloudPriorityBknOvcOverFewSct:true
    };
  }

  function applyPrevailingWind(result,input,engine){
    const helpers=engine.helpers||{};
    const reasons=[...(result?.diagnostics?.reasons||[])];
    const rules=policyRules(result?.rules||{});

    if(hasSignificantWindRegime(result,helpers)){
      return {
        ...result,version:VERSION,name:NAME,rules,
        diagnostics:{...result.diagnostics,reasons,prevailingWindPolicy:'kept regime-based base wind because a significant wind change/group or dominant VRB regime exists',prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION,operationalPolicyRevision:POLICY_REVISION}
      };
    }

    const rep=representativeWind(result.hourly,helpers,result?.base?.state);
    if(!rep)return {...result,version:VERSION,name:NAME,rules};
    const oldWind=String(result?.base?.text||'').match(WIND_RE)?.[0]||'';
    const newWind=helpers.windToken(rep.state);
    if(!newWind)return {...result,version:VERSION,name:NAME,rules};

    const baseText=replaceWindToken(result?.base?.text,newWind);
    const lines=String(result?.taf||'').split(/\n/);
    if(lines.length)lines[0]=replaceWindToken(lines[0],newWind);
    const taf=lines.join('\n');
    const checks=engine.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){
      const e=Error('TAF 2.4.3 odrzucony po wyborze przeważającego wiatru: '+checks.errors.join(' | '));
      e.validation=checks;
      throw e;
    }

    if(oldWind!==newWind){
      const pct=Math.round(rep.gustFraction*100);
      reasons.push(rep.gustPrevailing
        ? `Część bazowa: wiatr ustawiono jako przeważający z ${rep.sampleHours} h: ${newWind}; porywy występują w ${rep.gustHours}/${rep.sampleHours} h (${pct}%) i pozostają w grupie bazowej.`
        : `Część bazowa: wiatr ustawiono jako przeważający z ${rep.sampleHours} h: ${newWind}; porywy występują tylko w ${rep.gustHours}/${rep.sampleHours} h (${pct}%) i nie są warunkiem przeważającym.`);
    }

    return {
      ...result,taf,version:VERSION,name:NAME,rules,
      base:{...(result.base||{}),state:rep.state,text:baseText},
      checks:{...result.checks,...checks},
      diagnostics:{
        ...result.diagnostics,reasons,
        prevailingWindPolicy:'when no instruction-significant wind regime change exists, base direction/speed use the full validity period; speed remains encoded by the kernel to even KT values; gust is retained only when gust-coded hours cover at least half of the period',
        prevailingWindHours:rep.sampleHours,
        prevailingGustHours:rep.gustHours,
        prevailingGustFraction:rep.gustFraction,
        prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION,
        operationalPolicyRevision:POLICY_REVISION
      }
    };
  }

  function ruleSet(extra={}){
    return Object.freeze(policyRules({...base.RULES,...extra}));
  }

  function createEngine(options={}){
    const engine=base.createEngine(options);
    return Object.freeze({
      version:VERSION,
      rules:ruleSet(),
      generate(input={}){
        const prepared=prepareOperationalWeatherInput(input);
        let result=engine.generate(prepared);
        result={
          ...result,
          diagnostics:{
            ...result.diagnostics,
            basePrecipitationPolicy:'Instruction 3.7.9/3.7.11a: precipitation in the initial/main TAF section is not suppressed solely because VIS is >=5 km'
          }
        };
        result=normalizeCloudPresentation(result,prepared,engine);
        result=applyInstructionPrecipitationPolicy(result,prepared,engine);
        result=applyConvectiveShowerPolicy(result,prepared,engine);
        return applyPrevailingWind(result,prepared,engine);
      },
      validate:(taf,meta)=>engine.validate(taf,meta),
      helpers:Object.freeze({...engine.helpers,representativeWind,replaceWindToken,prepareOperationalWeatherInput,simplifyCloudTokens,simplifyCloudLayers,applyInstructionPrecipitationPolicy,applyConvectiveShowerPolicy,representativeShowerForGroup,insertWeatherBeforeCloud,groupEffectiveVisibilityM,weakOrdinaryPrecipTokens})
    });
  }

  if(root)root.__PROGNOZA_EPIR_TAF_ENGINE_V243__=true;
  return Object.freeze({
    ENGINE_VERSION:API_VERSION,
    QUALITY_VERSION:VERSION,
    ENGINE_NAME:NAME,
    INSTRUCTION:base.INSTRUCTION,
    RULES:ruleSet(),
    FORMAL_KERNEL_VERSION:base.FORMAL_KERNEL_VERSION||base.ENGINE_VERSION,
    createEngine,
    validateTaf:(taf,meta)=>base.validateTaf(taf,meta),
    ready:base.ready,
    setLearningData:base.setLearningData,
    learningStatus:base.learningStatus,
    helpers:Object.freeze({...base.helpers,representativeWind,replaceWindToken,prepareOperationalWeatherInput,simplifyCloudTokens,simplifyCloudLayers,applyInstructionPrecipitationPolicy,applyConvectiveShowerPolicy,representativeShowerForGroup,insertWeatherBeforeCloud,groupEffectiveVisibilityM,weakOrdinaryPrecipTokens})
  });
});
