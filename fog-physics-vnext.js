'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRFogPhysicsVNext=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='0.1.0-shadow';
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const mean=a=>{const q=a.filter(finite);return q.length?q.reduce((s,v)=>s+v,0)/q.length:null;};
  const smoothstep=(x,a,b)=>{
    if(!finite(x))return null;
    if(a===b)return x>=b?1:0;
    const t=clamp((x-a)/(b-a));
    return t*t*(3-2*t);
  };
  function weightedAvailable(items){
    let s=0,w=0,full=0;
    for(const p of items||[]){const ww=Math.max(0,num(p?.w)||0);full+=ww;if(finite(p?.v)&&ww>0){s+=p.v*ww;w+=ww;}}
    return {value:w?s/w:null,coverage:full?clamp(w/full):0,usedWeight:w,totalWeight:full};
  }
  function geometricAvailable(values){
    const a=(values||[]).filter(v=>finite(v)).map(v=>clamp(v,0.001,1));
    if(!a.length)return null;
    return Math.exp(a.reduce((s,v)=>s+Math.log(v),0)/a.length);
  }
  function precipMoistureProxy(p12){
    if(!finite(p12))return null;
    if(p12>=2)return 1;
    const pts=[[0,.35],[.2,.65],[1,.85],[2,1]];
    if(p12<=0)return .35;
    for(let i=1;i<pts.length;i++)if(p12<=pts[i][0]){
      const [x0,y0]=pts[i-1],[x1,y1]=pts[i],q=(p12-x0)/(x1-x0);
      return y0+(y1-y0)*q;
    }
    return 1;
  }

  // Broad physical prior only. Calibration must be learned locally from forecast->truth cases.
  // It deliberately avoids a single hard threshold: values are mapped continuously.
  function soilVolumetricSignal(v){
    if(!finite(v))return null;
    return smoothstep(v,.07,.43);
  }
  function soilMoisture(input={}){
    const iconVals=[num(input.icon01),num(input.icon13)].filter(finite);
    if(iconVals.length){
      const raw=mean(iconVals);
      return {value:soilVolumetricSignal(raw),raw,source:'ICON-D2',fallback:false};
    }
    const ecmwf=num(input.ecmwf07);
    if(finite(ecmwf))return {value:soilVolumetricSignal(ecmwf),raw:ecmwf,source:'ECMWF',fallback:false};
    const proxy=precipMoistureProxy(num(input.precip12));
    if(finite(proxy))return {value:proxy,raw:num(input.precip12),source:'precip proxy',fallback:true};
    return {value:null,raw:null,source:'brak',fallback:false};
  }

  function pblSignal(input={}){
    const pbl=num(input.pbl),d1=num(input.delta1),d3=num(input.delta3),isDay=num(input.isDay);
    const low=finite(pbl)?1-smoothstep(pbl,120,950):null;
    const falling1=finite(d1)?smoothstep(-d1,0,180):null;
    const falling3=finite(d3)?smoothstep(-d3,0,420):null;
    const night=isDay===0?1:isDay===1?.35:1;
    const trend=weightedAvailable([{v:falling1,w:.42},{v:falling3,w:.58}]).value;
    const out=weightedAvailable([
      {v:low,w:.62},
      {v:finite(trend)?trend*night:null,w:.38}
    ]);
    return {value:out.value,coverage:out.coverage,low,falling1,falling3,pbl,delta1:d1,delta3:d3};
  }

  function surfaceCoolingSignal(input={}){
    const t2=num(input.t2),ts=num(input.tsurface),dSc1=num(input.deltaSurfaceCooling1),dSc3=num(input.deltaSurfaceCooling3),dTs3=num(input.deltaTsurface3);
    const diff=finite(t2)&&finite(ts)?t2-ts:null;
    const diffSig=finite(diff)?smoothstep(diff,-.3,2.8):null;
    const trendSig=weightedAvailable([
      {v:finite(dSc1)?smoothstep(dSc1,-.15,.9):null,w:.35},
      {v:finite(dSc3)?smoothstep(dSc3,-.2,1.8):null,w:.65}
    ]).value;
    const groundCooling=finite(dTs3)?smoothstep(-dTs3,-.1,3.2):null;
    const out=weightedAvailable([
      {v:diffSig,w:.50},
      {v:trendSig,w:.18},
      {v:groundCooling,w:.32}
    ]);
    return {value:out.value,coverage:out.coverage,surfaceCooling:diff,diffSig,trendSig,groundCooling,deltaSurfaceCooling1:dSc1,deltaSurfaceCooling3:dSc3,deltaTsurface3:dTs3};
  }

  function saturationFamily(input={}){
    const t=num(input.t),td=num(input.td),rh=num(input.rh),dSpread3=num(input.deltaSpread3),dRh3=num(input.deltaRh3);
    const spread=finite(t)&&finite(td)?t-td:num(input.spread);
    const spreadSig=finite(spread)?1-smoothstep(spread,.2,4.2):null;
    const rhSig=finite(rh)?smoothstep(rh,80,99):null;
    // T-Td and RH are correlated: combine them as one state, not two independent votes.
    const state=weightedAvailable([{v:spreadSig,w:.62},{v:rhSig,w:.38}]).value;
    const trend=weightedAvailable([
      {v:finite(dSpread3)?smoothstep(-dSpread3,-.1,1.8):null,w:.58},
      {v:finite(dRh3)?smoothstep(dRh3,-1,10):null,w:.42}
    ]).value;
    const out=weightedAvailable([{v:state,w:.80},{v:trend,w:.20}]);
    return {value:out.value,coverage:out.coverage,spread,spreadSig,rhSig,trend};
  }

  function windRadSignal(ws,phase='pre-onset'){
    ws=num(ws);if(!finite(ws))return null;
    if(phase==='mature' || phase==='onset'){
      if(ws<=.2)return .55;
      if(ws<=1)return .82+(.18*(ws-.2)/.8);
      if(ws<=3.5)return 1;
      if(ws<=6)return 1-.65*(ws-3.5)/2.5;
      return Math.max(.08,.35-.04*(ws-6));
    }
    if(ws<=.2)return .42;
    if(ws<=.5)return .42+.38*(ws-.2)/.3;
    if(ws<=2)return .8+.2*(ws-.5)/1.5;
    if(ws<=3)return 1-.18*(ws-2);
    if(ws<=5)return .82-.67*(ws-3)/2;
    if(ws<=7)return .15-.06*(ws-5)/2;
    return .06;
  }
  function windAdvSignal(ws){
    ws=num(ws);if(!finite(ws))return null;
    if(ws<.3)return .18;
    if(ws<1)return .18+.52*(ws-.3)/.7;
    if(ws<=6)return .70+.30*Math.min(1,(ws-1)/2);
    if(ws<=10)return 1-.35*(ws-6)/4;
    if(ws<=14)return .65-.35*(ws-10)/4;
    return .25;
  }
  function inversionSignal(inv){
    inv=num(inv);if(!finite(inv))return null;
    return smoothstep(inv,-.4,2.2);
  }
  function mixingFamily(input={}){
    const pbl=input.spbl;
    const wind=windRadSignal(input.ws,input.phase||'pre-onset');
    const inv=inversionSignal(input.inversion);
    const shear=num(input.shear);
    const shearSuppression=finite(shear)?1-smoothstep(shear,1.5,8):null;
    const out=weightedAvailable([
      {v:pbl,w:.42},{v:wind,w:.33},{v:inv,w:.17},{v:shearSuppression,w:.08}
    ]);
    return {value:out.value,coverage:out.coverage,wind,inv,shearSuppression};
  }
  function skyCoolingSupport(input={}){
    const low=num(input.lowCloud),total=num(input.cloudCover),sw=num(input.shortwave),isDay=num(input.isDay);
    const cloud=mean([
      finite(low)?1-clamp(low/100):null,
      finite(total)?1-clamp(total/100):null
    ]);
    const radiation=finite(sw)?1-smoothstep(sw,0,160):null;
    const night=isDay===0?1:isDay===1?0:null;
    return weightedAvailable([{v:cloud,w:.55},{v:radiation,w:.30},{v:night,w:.15}]).value;
  }

  function cloudLoweringFamily(input={}){
    const cbh=num(input.cbh),drop3=num(input.cbhDrop3),low=num(input.lowCloud),fog2=num(input.cloud2m),spbl=num(input.spbl),sat=num(input.saturation);
    const lowBase=finite(cbh)?1-smoothstep(cbh,70,900):null;
    const lowering=finite(drop3)?smoothstep(drop3,0,450):null;
    const lowCloud=finite(low)?smoothstep(low,35,95):null;
    const nearSurface=finite(fog2)?clamp(fog2/100):null;
    const out=weightedAvailable([
      {v:lowBase,w:.24},{v:lowering,w:.25},{v:lowCloud,w:.18},{v:nearSurface,w:.17},{v:spbl,w:.08},{v:sat,w:.08}
    ]);
    return {value:out.value,coverage:out.coverage,lowBase,lowering,lowCloud,nearSurface};
  }

  function advFamily(input={}){
    const sat=num(input.saturation),wind=windAdvSignal(input.ws),moistAdvection=num(input.moistAdvection),surfaceContrast=num(input.surfaceContrast),verticalRh=num(input.verticalRh);
    const out=weightedAvailable([
      {v:sat,w:.30},{v:wind,w:.24},{v:moistAdvection,w:.20},{v:surfaceContrast,w:.16},{v:verticalRh,w:.10}
    ]);
    return {value:out.value,coverage:out.coverage,wind};
  }
  function pcpFamily(input={}){
    const rr=num(input.precip),sat=num(input.saturation),spreadTrend=num(input.deltaSpread3),rhTrend=num(input.deltaRh3),low=num(input.lowCloud);
    const precip=finite(rr)?smoothstep(rr,.02,1.2):null;
    const evap=weightedAvailable([
      {v:finite(spreadTrend)?smoothstep(-spreadTrend,0,1.5):null,w:.55},
      {v:finite(rhTrend)?smoothstep(rhTrend,0,10):null,w:.45}
    ]).value;
    const lowCloud=finite(low)?smoothstep(low,35,95):null;
    const out=weightedAvailable([{v:precip,w:.35},{v:evap,w:.25},{v:sat,w:.25},{v:lowCloud,w:.15}]);
    return {value:out.value,coverage:out.coverage,precip,evap};
  }

  function inferPhase(input={}){
    const explicit=String(input.phase||'').toLowerCase();
    if(['pre-onset','onset','mature','dissipation'].includes(explicit))return explicit;
    if(input.observedFog===true)return num(input.visibility)<500?'mature':'onset';
    const score=num(input.legacyScore);
    if(finite(score)&&score>=75)return 'mature';
    if(finite(score)&&score>=55)return 'onset';
    return 'pre-onset';
  }

  function dissipationSignal(input={}){
    const dTs3=num(input.deltaTsurface3),dPbl3=num(input.deltaPbl3),dSpread3=num(input.deltaSpread3),dRh3=num(input.deltaRh3),cbhRise3=num(input.cbhRise3),windChange3=num(input.windChange3),sw=num(input.shortwave);
    const out=weightedAvailable([
      {v:finite(dTs3)?smoothstep(dTs3,0,3):null,w:.20},
      {v:finite(dPbl3)?smoothstep(dPbl3,0,500):null,w:.20},
      {v:finite(dSpread3)?smoothstep(dSpread3,0,2):null,w:.18},
      {v:finite(dRh3)?smoothstep(-dRh3,0,12):null,w:.14},
      {v:finite(cbhRise3)?smoothstep(cbhRise3,0,500):null,w:.12},
      {v:finite(windChange3)?smoothstep(windChange3,0,4):null,w:.08},
      {v:finite(sw)?smoothstep(sw,20,300):null,w:.08}
    ]);
    return {value:out.value,coverage:out.coverage};
  }

  function evaluateHour(input={}){
    const phase=inferPhase(input);
    const soil=soilMoisture({icon01:num(input.soilIcon01),icon13:num(input.soilIcon13),ecmwf07:num(input.soilEcmwf07),precip12:num(input.precip12)});
    const spbl=pblSignal({pbl:num(input.pbl),delta1:num(input.deltaPbl1),delta3:num(input.deltaPbl3),isDay:num(input.isDay)});
    const sfc=surfaceCoolingSignal({
      t2:num(input.t),tsurface:num(input.tsurface),deltaSurfaceCooling1:num(input.deltaSurfaceCooling1),
      deltaSurfaceCooling3:num(input.deltaSurfaceCooling3),deltaTsurface3:num(input.deltaTsurface3)
    });
    const sat=saturationFamily(input);
    const mix=mixingFamily({ws:num(input.ws),phase,spbl:spbl.value,inversion:num(input.inversion),shear:num(input.shear)});
    const sky=skyCoolingSupport(input);

    // Core RAD signal is interaction-led. Missing families are omitted and coverage is exposed.
    const coreVals=[sat.value,sfc.value,mix.value].filter(finite);
    const core=coreVals.length>=2?geometricAvailable(coreVals):null;
    const support=weightedAvailable([{v:soil.value,w:.45},{v:sky,w:.35},{v:inversionSignal(input.inversion),w:.20}]).value;
    let rad=weightedAvailable([{v:core,w:.78},{v:support,w:.22}]).value;
    // Land moisture is a modulator, never a standalone trigger.
    if(finite(rad)&&finite(soil.value))rad=clamp(rad*(.88+.18*soil.value));
    // Preserve saturation gate: low PBL/cold ground alone cannot create FG-like RAD.
    if(finite(rad)&&finite(sat.value)&&sat.value<.28)rad=Math.min(rad,.34);

    const cbl=cloudLoweringFamily({cbh:num(input.cbh),cbhDrop3:num(input.cbhDrop3),lowCloud:num(input.lowCloud),cloud2m:num(input.cloud2m),spbl:spbl.value,saturation:sat.value});
    const adv=advFamily({saturation:sat.value,ws:num(input.ws),moistAdvection:num(input.moistAdvection),surfaceContrast:num(input.surfaceContrast),verticalRh:num(input.verticalRh)});
    const pcp=pcpFamily({precip:num(input.precip),saturation:sat.value,deltaSpread3:num(input.deltaSpread3),deltaRh3:num(input.deltaRh3),lowCloud:num(input.lowCloud)});
    const diss=dissipationSignal({...input,deltaPbl3:num(input.deltaPbl3)});

    const familyCoverage=mean([sat.coverage,sfc.coverage,spbl.coverage,mix.coverage]);
    const missing=[];
    if(!finite(soil.value))missing.push('soil moisture');
    if(!finite(spbl.value))missing.push('PBL');
    if(!finite(sfc.value))missing.push('surface cooling');
    const fallbacks=[];if(soil.fallback)fallbacks.push('soil moisture: precip proxy');

    return {
      version:VERSION,phase,
      SSOIL:soil.value,soilMoistureRaw:soil.raw,soilMoistureSource:soil.source,
      SPBL:spbl.value,PBL:spbl.pbl,deltaPbl1:spbl.delta1,deltaPbl3:spbl.delta3,
      SSFC_COOL:sfc.value,surfaceCooling:sfc.surfaceCooling,deltaSurfaceCooling1:sfc.deltaSurfaceCooling1,deltaSurfaceCooling3:sfc.deltaSurfaceCooling3,deltaTsurface3:sfc.deltaTsurface3,
      SATURATION:sat.value,MIXING:mix.value,SKY_COOLING:sky,
      RAD:rad,ADV:adv.value,CBL:cbl.value,PCP:pcp.value,
      dissipationRisk:diss.value,
      dataQuality:finite(familyCoverage)?familyCoverage:0,
      missing,fallbacks,
      diagnostics:{soil,spbl,sfc,saturation:sat,mixing:mix,cbl,adv,pcp,dissipation:diss}
    };
  }

  function enhanceLegacyHour(legacy={},input={}){
    const v=evaluateHour({...input,legacyScore:num(legacy.score)});
    const legacyScore=num(legacy.score),legacyRad=num(legacy.RAD);
    const hasNew=finite(v.SSOIL)||finite(v.SPBL)||finite(v.SSFC_COOL);
    let shadowScore=legacyScore;
    if(hasNew&&finite(legacyScore)&&finite(v.RAD)){
      const target=v.RAD*100;
      const reference=finite(legacyRad)?legacyRad:legacyScore;
      // Shadow-only conservative blend. Operational score is intentionally untouched.
      shadowScore=clamp(legacyScore+.22*(target-reference),0,100);
    }
    return {
      ...legacy,
      vnext:v,
      SSOIL:finite(v.SSOIL)?v.SSOIL*100:null,
      SPBL:finite(v.SPBL)?v.SPBL*100:null,
      SSFC_COOL:finite(v.SSFC_COOL)?v.SSFC_COOL*100:null,
      RAD_vNextShadow:finite(v.RAD)?v.RAD*100:null,
      ADV_vNextShadow:finite(v.ADV)?v.ADV*100:null,
      CBL_vNextShadow:finite(v.CBL)?v.CBL*100:null,
      PCP_vNextShadow:finite(v.PCP)?v.PCP*100:null,
      fogScoreVNextShadow:shadowScore,
      vnextShadowActive:hasNew,
      // Explicit contract: no operational mutation before forecast-vs-truth calibration.
      score:legacy.score
    };
  }

  return Object.freeze({
    VERSION,weightedAvailable,soilVolumetricSignal,soilMoisture,pblSignal,surfaceCoolingSignal,
    saturationFamily,windRadSignal,windAdvSignal,mixingFamily,cloudLoweringFamily,advFamily,pcpFamily,
    inferPhase,dissipationSignal,evaluateHour,enhanceLegacyHour,precipMoistureProxy
  });
});
