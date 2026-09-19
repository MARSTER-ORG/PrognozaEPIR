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

  // Public API version stays 2.4.0 for taf-app-v25.js compatibility.
  const API_VERSION='2.4.0';
  const VERSION='2.4.3';
  const NAME='TAF Engine 2.4.3 — Prevailing Wind + Instruction First';
  const GUST_PREVAILING_MIN_FRACTION=.50;
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const WIND_RE=/\b(?:VRB|\d{3})(?:P99|\d{2,3})(?:G(?:P99|\d{2,3}))?KT\b/;

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
    const rules={...(result?.rules||{}),prevailingWindFullPeriodWhenNoSignificantChange:true,prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION};

    if(hasSignificantWindRegime(result,helpers)){
      return {
        ...result,version:VERSION,name:NAME,rules,
        diagnostics:{...result.diagnostics,reasons,prevailingWindPolicy:'kept regime-based base wind because a significant wind change/group or dominant VRB regime exists',prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION}
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
        prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION
      }
    };
  }

  function createEngine(options={}){
    const engine=base.createEngine(options);
    return Object.freeze({
      version:VERSION,
      rules:Object.freeze({...base.RULES,prevailingWindFullPeriodWhenNoSignificantChange:true,prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION}),
      generate(input={}){return applyPrevailingWind(engine.generate(input),input,engine);},
      validate:(taf,meta)=>engine.validate(taf,meta),
      helpers:Object.freeze({...engine.helpers,representativeWind,replaceWindToken})
    });
  }

  if(root)root.__PROGNOZA_EPIR_TAF_ENGINE_V243__=true;
  return Object.freeze({
    ENGINE_VERSION:API_VERSION,
    QUALITY_VERSION:VERSION,
    ENGINE_NAME:NAME,
    INSTRUCTION:base.INSTRUCTION,
    RULES:Object.freeze({...base.RULES,prevailingWindFullPeriodWhenNoSignificantChange:true,prevailingGustMinFraction:GUST_PREVAILING_MIN_FRACTION}),
    FORMAL_KERNEL_VERSION:base.FORMAL_KERNEL_VERSION||base.ENGINE_VERSION,
    createEngine,
    validateTaf:(taf,meta)=>base.validateTaf(taf,meta),
    ready:base.ready,
    setLearningData:base.setLearningData,
    learningStatus:base.learningStatus,
    helpers:Object.freeze({...base.helpers,representativeWind,replaceWindToken})
  });
});
