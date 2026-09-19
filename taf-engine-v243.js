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

  const API_VERSION='2.4.0';
  const VERSION='2.4.3';
  const POLICY_REVISION='2026-09-19e';
  const NAME='TAF Engine 2.4.3 — Prevailing Wind + Operational Weather/Cloud Priority + Instruction First';
  const GUST_PREVAILING_MIN_FRACTION=.50;
  const WEAK_PRECIP_VIS_LIMIT_M=5000;
  const MODERATE_RR_MIN=.15;
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const prob=v=>!num(v)?0:(+v>1?clamp(+v/100,0,1):clamp(+v,0,1));
  const WIND_RE=/\b(?:VRB|\d{3})(?:P99|\d{2,3})(?:G(?:P99|\d{2,3}))?KT\b/;
  const CLOUD_TOKEN_RE=/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/;
  const CONVECTIVE_CLOUD_RE=/\b(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)\b/;
  const SHRA_TOKEN_RE=/^(?:\+|-)?SHRA$/;
  const ORDINARY_PRECIP_CODES=new Set([51,53,55,61,63,65,71,73,75,77]);
  const PRECIP_CODES=new Set([51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99]);
  const EXEMPT_CHANGE_CODES=new Set([56,57,66,67,80,81,82,85,86,95,96,99]);

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

  function memberWeight(m){return num(m?.w)&&+m.w>0?+m.w:1;}
  function weightedShare(members,pred){
    let n=0,d=0;
    for(const m of members||[]){const w=memberWeight(m);d+=w;if(pred(m))n+=w;}
    return d?n/d:0;
  }
  function codeOf(m){return num(m?.code)?Math.round(+m.code):0;}
  function memberVisibility(m,row){
    if(num(m?.vis))return +m.vis;
    if(num(row?.VIS))return +row.VIS;
    return Infinity;
  }

  // 3.7.9 and 3.7.11a: do not remove precipitation from the data used for the
  // main/initial TAF section solely because visibility is >=5 km.
  function prepareOperationalWeatherInput(input={}){
    const rows=(input.rows||[]).map(src=>({
      ...src,
      mv:Array.isArray(src?.mv)?src.mv.map(m=>({...m})):[]
    }));
    return {
      ...input,rows,
      taf243WeatherPolicy:{basePrecipitationVisibilityIndependent:true}
    };
  }

  // Separate input used ONLY to select change groups. Weak ordinary
  // precipitation at good visibility is suppressed here so it cannot create a
  // standalone PROB30/TEMPO/BECMG or consume the limited PROB30 slot. Moderate
  // and heavy precipitation remains untouched; freezing precipitation,
  // showers and thunderstorms are exempt. This intentionally omits the optional
  // 3.7.11b weak-precipitation add-on at VIS >5 km to keep change groups minimal.
  function prepareChangeGroupWeatherInput(input={}){
    let suppressedMembers=0,suppressedRows=0;
    const rows=(input.rows||[]).map(src=>{
      const originalMv=Array.isArray(src?.mv)?src.mv:[];
      const rr=num(src?.RR)?+src.RR:0;
      const weakIntensity=rr<MODERATE_RR_MIN;
      let rowSuppressed=0;
      const mv=originalMv.map(m=>{
        const c=codeOf(m),vis=memberVisibility(m,src);
        if(weakIntensity&&ORDINARY_PRECIP_CODES.has(c)&&vis>=WEAK_PRECIP_VIS_LIMIT_M){
          rowSuppressed++;suppressedMembers++;
          return {...m,taf243OriginalWeatherCode:c,taf243WeakOrdinaryChangeSuppressed:true,code:0};
        }
        return {...m};
      });
      if(rowSuppressed)suppressedRows++;
      if(!rowSuppressed)return {...src,mv};

      const remainingPrecip=weightedShare(mv,m=>PRECIP_CODES.has(codeOf(m)));
      const rowVis=num(src?.VIS)?+src.VIS:Infinity;
      const rawWet=prob(src?.wet);
      const exemptSignal=prob(src?.storm)>=.30||originalMv.some(m=>EXEMPT_CHANGE_CODES.has(codeOf(m)));
      const keepGenericWet=rowVis<WEAK_PRECIP_VIS_LIMIT_M||exemptSignal;
      const wet=Math.max(remainingPrecip,keepGenericWet?rawWet:0);
      const RR=(remainingPrecip>0||keepGenericWet)?src?.RR:0;
      return {
        ...src,mv,wet,RR,
        taf243RawWet:src?.wet??null,
        taf243RawRR:src?.RR??null,
        taf243WeakOrdinaryChangeSuppressedMembers:rowSuppressed
      };
    });
    return {
      ...input,rows,
      taf243ChangeWeatherPolicy:{suppressedMembers,suppressedRows,visLimitM:WEAK_PRECIP_VIS_LIMIT_M}
    };
  }

  function parseCloudToken(token){
    const m=String(token||'').match(CLOUD_TOKEN_RE);
    return m?{cover:m[1],height:+m[2],type:m[3]||''}:null;
  }

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

  function rebuildTaf(first,groups){
    return [first,...(groups||[]).slice().sort((a,b)=>(+a.s)-(+b.s)||(+a.e)-(+b.e)).map(g=>g.text)].filter(Boolean).join('\n')+'=';
  }

  function mergeBaseWithChangeSelection(fullResult,changeResult,input,engine){
    const first=String(fullResult?.taf||'').replace(/=$/,'').split(/\n+/).filter(Boolean)[0]||'';
    const groups=(changeResult?.groups||[]).map(g=>({...g,fields:[...(g.fields||[])]}));
    const taf=rebuildTaf(first,groups);
    const checks=engine.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){
      const e=Error('TAF 2.4.3 odrzucony po rozdzieleniu części głównej i grup zmian: '+checks.errors.join(' | '));
      e.validation=checks;throw e;
    }
    const cp=input?.taf243ChangeWeatherPolicy||{};
    const reasons=[...(changeResult?.diagnostics?.reasons||[])];
    if((cp.suppressedMembers||0)>0)reasons.push(`Grupy zmian: pominięto ${cp.suppressedMembers} sygnałów słabego zwykłego opadu w ${cp.suppressedRows} h przy VIS >= ${WEAK_PRECIP_VIS_LIMIT_M} m. Nie wpływa to na część główną TAF. Opady umiarkowane/silne oraz konwekcyjne i marznące zachowują własne kryteria.`);
    return {
      ...fullResult,taf,groups,
      checks:{...fullResult.checks,...changeResult.checks,...checks},
      diagnostics:{
        ...fullResult.diagnostics,
        ...changeResult.diagnostics,
        reasons,
        basePrecipitationPolicy:'3.7.9/3.7.11a: precipitation in the main TAF section is independent of the 5 km visibility threshold',
        changePrecipitationPolicy:'weak ordinary precipitation is omitted from change-group selection at VIS >=5 km; moderate/heavy ordinary precipitation remains significant; freezing, showers and thunderstorm precipitation are exempt; optional 3.7.11b weak add-on above 5 km is intentionally omitted'
      }
    };
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
    const taf=rebuildTaf(first,groups);
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

  // 3.11.6a: isolated CB/TCU and associated convective showers belong in a
  // temporary group. SHRA can therefore be present without a significant VIS
  // reduction; VIS is repeated only when visibility itself changes significantly.
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
    const taf=rebuildTaf(first,groups);
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
      weakOrdinaryPrecipChangeRequiresVisibilityBelowM:WEAK_PRECIP_VIS_LIMIT_M,
      optionalWeakPrecipAbove5kmWithOtherChange:false,
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
        const fullResult=engine.generate(prepared);
        const changePrepared=prepareChangeGroupWeatherInput(prepared);
        const changeResult=engine.generate(changePrepared);
        let result=mergeBaseWithChangeSelection(fullResult,changeResult,changePrepared,engine);
        result=normalizeCloudPresentation(result,prepared,engine);
        result=applyConvectiveShowerPolicy(result,prepared,engine);
        return applyPrevailingWind(result,prepared,engine);
      },
      validate:(taf,meta)=>engine.validate(taf,meta),
      helpers:Object.freeze({...engine.helpers,representativeWind,replaceWindToken,prepareOperationalWeatherInput,prepareChangeGroupWeatherInput,simplifyCloudTokens,simplifyCloudLayers,applyConvectiveShowerPolicy,representativeShowerForGroup,insertWeatherBeforeCloud})
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
    helpers:Object.freeze({...base.helpers,representativeWind,replaceWindToken,prepareOperationalWeatherInput,prepareChangeGroupWeatherInput,simplifyCloudTokens,simplifyCloudLayers,applyConvectiveShowerPolicy,representativeShowerForGroup,insertWeatherBeforeCloud})
  });
});
