'use strict';
// Forecast-only fog/visibility coherence repair, before the strict instruction gate.
// An AUTO observation with no reported phenomenon is NOT evidence of "no fog".
// Do not turn visibility alone into FG: require independent saturation and fog evidence.
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory;
  if(root?.PrognozaEPIRTAFEngine&&!root.__PROGNOZA_EPIR_TAF_VIS_FOG_COHERENCE__){
    root.PrognozaEPIRTAFEngine=factory(root.PrognozaEPIRTAFEngine);
    root.__PROGNOZA_EPIR_TAF_VIS_FOG_COHERENCE__=true;
  }
})(typeof window!=='undefined'?window:null,function wrapFogVisibilityCoherence(base){
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(+v)?+v:null;
  const compact=s=>String(s||'').replace(/\s+/g,' ').trim().replace(/=$/,'');
  const fogCode=/\b(?:FG|FZFG|BR)\b/;
  const weather=/^(?:[-+]?(?:RA|DZ|SN|SG|SHRA|SHSN|TSRA|FZRA|FZDZ|HZ|FU|DU|SA)|NSW)$/;
  function modelLowVisibilityShare(row){
    const members=(Array.isArray(row?.mv)?row.mv:[]).filter(x=>num(x?.vis)!==null&&num(x?.w)!==0);
    if(!members.length)return null;
    const weights=members.map(x=>num(x?.w)===null?1:Math.max(0,+x.w));
    const total=weights.reduce((s,x)=>s+x,0);
    if(!total)return null;
    return members.reduce((sum,m,i)=>sum+(+m.vis<1000?weights[i]:0),0)/total;
  }
  function fogSupport(hour){
    const row=hour?.sourceRow||{},vis=num(hour?.visM),temp=num(hour?.T),dew=num(hour?.Td),rh=num(hour?.RH);
    if(vis===null||vis>=1000)return {supported:false,reason:'visibility_not_below_1000'};
    const saturated=(temp!==null&&dew!==null&&Math.abs(temp-dew)<=1.6)
      ||(rh!==null&&rh>=95);
    const vote=modelLowVisibilityShare(row),score=num(row.fgOperationalScore)??num(row.fogOperationalScore);
    const independent=(vote!==null&&vote>=.50)||(score!==null&&score>=60);
    return {supported:saturated&&independent,reason:!saturated?'insufficient_saturation':
      !independent?'insufficient_fog_evidence':'forecast_saturation_and_fog_evidence',
      saturation:saturated,nwpLowVisShare:vote,fogOperationalScore:score};
  }
  function insertFg(text){
    const tokens=String(text||'').trim().split(/\s+/);
    if(tokens.length<3||fogCode.test(text))return null;
    if(!/^(?:VRB|\d{3})\d{2,3}(?:G\d{2,3})?KT$/.test(tokens[0]))return null;
    if(!/^(?:9999|\d{4})$/.test(tokens[1])||(+tokens[1])>=1000)return null;
    // If some other weather is already present, do not silently replace it.
    if(tokens.slice(2).some(t=>weather.test(t)))return null;
    return [tokens[0],tokens[1],'FG',...tokens.slice(2)].join(' ');
  }
  function reconcile(result,input,inner){
    const baseText=result?.base?.text;
    if(!baseText||fogCode.test(baseText))return result;
    const vis=num(result?.base?.state?.visM);
    if(vis===null||vis>=1000)return result;
    const hours=(result?.hourly||[]).slice(0,3);
    const evidence=hours.map(fogSupport);
    if(evidence.filter(x=>x.supported).length<2)return {
      ...result,diagnostics:{...result.diagnostics,
        lowVisibilityWeatherEvidence:'NOT_CONFIRMED',
        lowVisibilityWeatherReason:'Forecast visibility <1000 m without two corroborated saturated low-vis hours. Do not invent FG.'}
    };
    const updatedBase=insertFg(baseText);
    if(!updatedBase)return result;
    const parts=compact(result.taf).split(/\s+(?=(?:BECMG|TEMPO|PROB30|FM\d{6})\b)/);
    if(!parts[0]||!parts[0].endsWith(baseText))return result;
    parts[0]=parts[0].slice(0,-baseText.length)+updatedBase;
    const taf=parts.join(' ')+'=';
    const checks=inner.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks?.ok)return result;
    const hourly=(result.hourly||[]).map((hour,i)=>i<3&&evidence[i]?.supported?{
      ...hour,tafDisplay:{...hour.tafDisplay,weather:String(hour.tafDisplay?.weather||'').trim()||'FG'},
      visibilityFogEvidence:'inferred_from_saturation_and_fog_guidance'
    }:hour);
    return {
      ...result,taf,hourly,
      base:{...result.base,text:updatedBase,state:{...result.base.state,
        inferredFogFromVisibility:true}},
      checks:{...result.checks,...checks},
      diagnostics:{...result.diagnostics,
        lowVisibilityWeatherEvidence:'CONFIRMED_FROM_FORECAST',
        fogVisibilityCoherence:'FG inferred from two or more forecast hours with low visibility, saturation and independent NWP/Fog Engine guidance; missing AUTO weather is not negative evidence',
        reasons:[...(result.diagnostics?.reasons||[]),
          'FG w części podstawowej: dwa lub więcej godzinnych stanów prognozy potwierdza VIS <1000 m, nasycenie powietrza oraz niezależny sygnał NWP/Fog Engine. Brak zjawiska w AUTO nie oznacza braku mgły.']}
    };
  }
  return Object.freeze({...base,
    createEngine(options={}){
      const inner=base.createEngine(options);
      return Object.freeze({...inner,
        generate(input={}){return reconcile(inner.generate(input),input,inner);}
      });
    },
    helpers:Object.freeze({...base.helpers,modelLowVisibilityShare,fogSupport})
  });
});
