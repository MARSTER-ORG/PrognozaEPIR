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
  const POLICY_REVISION='2026-09-19b';
  const NAME='TAF Engine 2.4.3 — Prevailing Wind + Operational Weather/Cloud Priority + Instruction First';
  const GUST_PREVAILING_MIN_FRACTION=.50;
  const ORDINARY_RAIN_VIS_LIMIT_M=5000;
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const WIND_RE=/\b(?:VRB|\d{3})(?:P99|\d{2,3})(?:G(?:P99|\d{2,3}))?KT\b/;
  const ORDINARY_LIQUID_CODES=new Set([51,53,55,61,63,65,80,81,82]);
  const PRECIP_CODES=new Set([51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99]);
  const CLOUD_TOKEN_RE=/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/;

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

  // Project operational policy: ordinary liquid precipitation is carried into
  // TAF only when the precipitation-bearing model member also forecasts VIS <5 km.
  // TS, freezing precipitation and snow remain governed by their own significance rules.
  function prepareOperationalWeatherInput(input={}){
    let suppressedMembers=0,suppressedRows=0;
    const rows=(input.rows||[]).map(src=>{
      const originalMv=Array.isArray(src?.mv)?src.mv:[];
      let rowSuppressed=0;
      const mv=originalMv.map(m=>{
        const c=codeOf(m),vis=memberVisibility(m,src);
        if(ORDINARY_LIQUID_CODES.has(c)&&vis>=ORDINARY_RAIN_VIS_LIMIT_M){
          rowSuppressed++;suppressedMembers++;
          return {...m,taf243OriginalWeatherCode:c,taf243RainSuppressedForVisibility:true,code:0};
        }
        return {...m};
      });
      if(rowSuppressed)suppressedRows++;
      const remainingPrecip=weightedShare(mv,m=>PRECIP_CODES.has(codeOf(m)));
      const rowVis=num(src?.VIS)?+src.VIS:Infinity;
      const keepExplicitWet=rowVis<ORDINARY_RAIN_VIS_LIMIT_M;
      const rawWet=num(src?.wet)?(+src.wet>1?clamp(+src.wet/100,0,1):clamp(+src.wet,0,1)):0;
      const wet=Math.max(remainingPrecip,keepExplicitWet?rawWet:0);
      const RR=(remainingPrecip>0||keepExplicitWet)?src?.RR:0;
      return {
        ...src,mv,wet,RR,
        taf243RawWet:src?.wet??null,
        taf243RawRR:src?.RR??null,
        taf243RainSuppressedMembers:rowSuppressed,
        taf243OrdinaryRainVisLimitM:ORDINARY_RAIN_VIS_LIMIT_M
      };
    });
    return {...input,rows,taf243WeatherPolicy:{suppressedMembers,suppressedRows}};
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

  function applyPrevailingWind(result,input,engine){
    const helpers=engine.helpers||{};
    const reasons=[...(result?.diagnostics?.reasons||[])];
    const rules={...(result?.rules||{}),prevailingWindFullPeriodWhenNoSignificantChange:true,prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION,ordinaryRainRequiresVisibilityBelowM:ORDINARY_RAIN_VIS_LIMIT_M,cloudPriorityBknOvcOverFewSct:true};

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

  function createEngine(options={}){
    const engine=base.createEngine(options);
    return Object.freeze({
      version:VERSION,
      rules:Object.freeze({...base.RULES,prevailingWindFullPeriodWhenNoSignificantChange:true,prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION,ordinaryRainRequiresVisibilityBelowM:ORDINARY_RAIN_VIS_LIMIT_M,cloudPriorityBknOvcOverFewSct:true}),
      generate(input={}){
        const prepared=prepareOperationalWeatherInput(input);
        let result=engine.generate(prepared);
        const wp=prepared.taf243WeatherPolicy||{};
        if((wp.suppressedMembers||0)>0){
          const reasons=[...(result?.diagnostics?.reasons||[])];
          reasons.push(`Opad ciekły: pominięto ${wp.suppressedMembers} sygnałów modelowych w ${wp.suppressedRows} h, ponieważ towarzysząca widzialność była >= ${ORDINARY_RAIN_VIS_LIMIT_M} m. Zwykły RA/DZ/SHRA nie jest wtedy kodowany w TAF.`);
          result={...result,diagnostics:{...result.diagnostics,reasons,ordinaryRainVisibilityPolicy:`ordinary liquid precipitation requires model-member VIS < ${ORDINARY_RAIN_VIS_LIMIT_M} m; TS/freezing/snow remain independently significant`}};
        }
        result=normalizeCloudPresentation(result,prepared,engine);
        return applyPrevailingWind(result,prepared,engine);
      },
      validate:(taf,meta)=>engine.validate(taf,meta),
      helpers:Object.freeze({...engine.helpers,representativeWind,replaceWindToken,prepareOperationalWeatherInput,simplifyCloudTokens,simplifyCloudLayers})
    });
  }

  if(root)root.__PROGNOZA_EPIR_TAF_ENGINE_V243__=true;
  return Object.freeze({
    ENGINE_VERSION:API_VERSION,
    QUALITY_VERSION:VERSION,
    ENGINE_NAME:NAME,
    INSTRUCTION:base.INSTRUCTION,
    RULES:Object.freeze({...base.RULES,prevailingWindFullPeriodWhenNoSignificantChange:true,prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION,ordinaryRainRequiresVisibilityBelowM:ORDINARY_RAIN_VIS_LIMIT_M,cloudPriorityBknOvcOverFewSct:true}),
    FORMAL_KERNEL_VERSION:base.FORMAL_KERNEL_VERSION||base.ENGINE_VERSION,
    createEngine,
    validateTaf:(taf,meta)=>base.validateTaf(taf,meta),
    ready:base.ready,
    setLearningData:base.setLearningData,
    learningStatus:base.learningStatus,
    helpers:Object.freeze({...base.helpers,representativeWind,replaceWindToken,prepareOperationalWeatherInput,simplifyCloudTokens,simplifyCloudLayers})
  });
});
