'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRFogVisibilityVNext=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='0.2.0-physics-first';
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const mean=a=>{const q=(a||[]).filter(finite);return q.length?q.reduce((s,v)=>s+v,0)/q.length:null;};

  function weightedAvailable(items){
    let s=0,w=0,full=0;
    for(const p of items||[]){
      const v=num(p?.v),ww=Math.max(0,num(p?.w)||0);full+=ww;
      if(finite(v)&&ww>0){s+=v*ww;w+=ww;}
    }
    return {value:w?s/w:null,coverage:full?w/full:0};
  }
  function smoothstep(x,a,b){
    x=num(x);if(!finite(x))return null;
    if(a===b)return x>=b?1:0;
    const t=clamp((x-a)/(b-a));return t*t*(3-2*t);
  }
  function interp(x,a,b,ya,yb){
    if(!finite(x))return null;
    if(x<=a)return ya;if(x>=b)return yb;
    return ya+(yb-ya)*(x-a)/(b-a);
  }
  function quantile(values,q){
    const a=(values||[]).filter(finite).sort((x,y)=>x-y);
    if(!a.length)return null;if(a.length===1)return a[0];
    const p=clamp(q)*(a.length-1),lo=Math.floor(p),hi=Math.ceil(p),f=p-lo;
    return a[lo]+(a[hi]-a[lo])*f;
  }
  function roundVis(v){
    v=num(v);if(!finite(v))return null;
    v=clamp(v,50,50000);
    const step=v<1000?50:v<5000?100:v<10000?500:1000;
    return Math.round(v/step)*step;
  }
  function modelValues(hour){
    return (hour?.models||[]).map(m=>num(m?.VIS)).filter(v=>finite(v)&&v>=25&&v<=100000);
  }
  function mechanismSignal(v={}){
    const a=[num(v.RAD),num(v.ADV),num(v.CBL),num(v.PCP)].filter(finite).map(x=>clamp(x)).sort((x,y)=>y-x);
    if(!a.length)return null;
    return a.length===1?a[0]:.8*a[0]+.2*a[1];
  }
  function visibilityFromSeverity(s){
    s=num(s);if(!finite(s))return null;
    const pts=[[0,15000],[.20,9000],[.35,5000],[.45,3000],[.55,1800],[.62,1250],[.70,900],[.78,700],[.86,500],[.93,350],[1,200]];
    for(let i=1;i<pts.length;i++)if(s<=pts[i][0])return interp(s,pts[i-1][0],pts[i][0],pts[i-1][1],pts[i][1]);
    return pts.at(-1)[1];
  }
  function phaseAdjustment(phase){
    switch(String(phase||'').toLowerCase()){
      case 'mature': return .04;
      case 'onset': return .02;
      case 'dissipation': return -.10;
      case 'pre-onset': return -.06;
      default: return 0;
    }
  }
  function asFraction(v){
    v=num(v);if(!finite(v))return null;
    return clamp(v>1?v/100:v);
  }
  function internalSeverity(context={}){
    const v=context.vnext||{};
    const p=asFraction(context.physicsProbability)??asFraction(context.score);
    const mech=mechanismSignal(v);
    const sat=asFraction(v.SATURATION)??asFraction(context.saturation);
    const pbl=asFraction(v.SPBL),sfc=asFraction(v.SSFC_COOL),soil=asFraction(v.SSOIL),diss=asFraction(v.dissipationRisk);
    const out=weightedAvailable([
      {v:p,w:.34},{v:sat,w:.24},{v:pbl,w:.13},{v:sfc,w:.11},{v:mech,w:.12},{v:soil,w:.06}
    ]);
    let s=out.value;
    if(!finite(s))return {severity:null,coverage:out.coverage,mechanism:mech,physicsProbability:p};
    s+=phaseAdjustment(context.phase||v.phase);
    if(finite(diss))s-=.12*clamp(diss);
    return {severity:clamp(s),coverage:out.coverage,mechanism:mech,physicsProbability:p};
  }
  function confidenceLabel(c){
    c=num(c);if(!finite(c))return 'brak danych';
    if(c>=.80)return 'bardzo wysoka';if(c>=.65)return 'wysoka';if(c>=.45)return 'średnia';if(c>=.25)return 'niska';return 'bardzo niska';
  }
  function thresholdProbabilities(severity,physicsProbability){
    const s=num(severity),p=asFraction(physicsProbability);
    if(!finite(s))return {p1500:null,p1000:null,p500:null,p200:null};
    let p1500=100*smoothstep(s,.40,.68);
    let p1000=100*smoothstep(s,.50,.77);
    let p500=100*smoothstep(s,.66,.93);
    let p200=100*smoothstep(s,.84,.995);
    if(finite(p))p1000=Math.min(p1000,100*p);
    p500=Math.min(p500,p1000);
    p200=Math.min(p200,p500);
    p1500=Math.max(p1000,p1500);
    return {p1500,p1000,p500,p200};
  }
  function applyObservation(point,probs,hour,lead){
    const obs=num(hour?.obsVisM);
    if(!hour?.obsUsed||!finite(obs)||lead>3)return {point,probs,obsWeight:0};
    const w=.50*Math.exp(-Math.max(0,lead)/2.2);
    const blended=finite(point)?Math.exp((1-w)*Math.log(Math.max(50,point))+w*Math.log(Math.max(50,obs))):obs;
    const out={...probs};
    for(const thr of [1500,1000,500,200]){
      const k='p'+thr,hit=obs<thr?100:0;
      if(finite(out[k]))out[k]=(1-w)*out[k]+w*hit;
    }
    if(finite(out.p1500)&&finite(out.p1000))out.p1000=Math.min(out.p1000,out.p1500);
    if(finite(out.p1000)&&finite(out.p500))out.p500=Math.min(out.p500,out.p1000);
    if(finite(out.p500)&&finite(out.p200))out.p200=Math.min(out.p200,out.p500);
    return {point:blended,probs:out,obsWeight:w};
  }

  function evaluate(hour={},context={}){
    const v=context.vnext||hour?.vnext||{};
    const lead=Math.max(0,num(context.leadHours)??num(hour.lead)??0);
    const phase=String(context.phase||v.phase||'').toLowerCase()||null;
    const internal=internalSeverity({...context,vnext:v,phase});
    const physicsProbability=internal.physicsProbability;
    const severity=internal.severity;
    let point=visibilityFromSeverity(severity);
    let probs=thresholdProbabilities(severity,physicsProbability);
    const obsApplied=applyObservation(point,probs,hour,lead);
    point=obsApplied.point;probs=obsApplied.probs;

    const dataQuality=asFraction(v.dataQuality);
    const signalCoverage=internal.coverage;
    const leadQuality=1-.35*clamp((lead-12)/36);
    const obsBonus=obsApplied.obsWeight>0?Math.min(.15,obsApplied.obsWeight*.3):0;
    let confidence=weightedAvailable([
      {v:dataQuality,w:.50},{v:signalCoverage,w:.30},{v:leadQuality,w:.20}
    ]).value;
    if(finite(confidence))confidence=clamp(confidence+obsBonus);

    let low=null,high=null;
    if(finite(point)){
      const factor=Math.exp(.35+(1-(confidence??.35))*.85);
      low=point/factor;high=point*factor;
      if(phase==='mature'&&finite(severity)&&severity>=.72)high=Math.min(high,1800);
      if(phase==='pre-onset'&&finite(severity)&&severity<.45)low=Math.max(low,1500);
    }
    low=roundVis(low);point=roundVis(point);high=roundVis(high);
    if(finite(low)&&finite(point))low=Math.min(low,point);
    if(finite(high)&&finite(point))high=Math.max(high,point);

    // NWP visibility is diagnostic only; none of these values feeds point/range/probabilities.
    const values=modelValues(hour),q25=quantile(values,.25),q50=quantile(values,.50),q75=quantile(values,.75);
    const legacyCenter=num(hour.vis);
    let nwpRelation='brak danych NWP VIS';
    if(finite(point)&&finite(q50)){
      if(point<1500&&q50>=5000)nwpRelation='NWP nie widzi redukcji VIS';
      else if(point<1500&&q50<2000)nwpRelation='NWP potwierdza niską VIS';
      else if(point>=5000&&q50<1500)nwpRelation='NWP niższa niż sygnał fizyczny';
      else nwpRelation='NWP zgodne kierunkowo';
    }

    return {
      version:VERSION,point,low,high,...probs,confidence,confidenceLabel:confidenceLabel(confidence),
      phase,severity:finite(severity)?severity:null,physicsProbability:finite(physicsProbability)?physicsProbability:null,
      source:'vnext-physics-visibility',modelCount:values.length,modelMedian:roundVis(q50),rawLegacy:roundVis(legacyCenter),
      observationWeight:obsApplied.obsWeight,nwpRole:'diagnostic-only',nwpRelation,
      diagnostics:{q25:roundVis(q25),q50:roundVis(q50),q75:roundVis(q75),internalCoverage:signalCoverage,dataQuality,mechanism:internal.mechanism,legacyVis:roundVis(legacyCenter)}
    };
  }

  function eventSummary(rows=[]){
    const a=(rows||[]).filter(r=>r?.visGuidance&&finite(r.t));
    if(!a.length)return null;
    const points=a.filter(r=>finite(r.visGuidance.point));
    const minRow=points.reduce((best,r)=>!best||r.visGuidance.point<best.visGuidance.point?r:best,null);
    const lows=a.map(r=>r.visGuidance.low).filter(finite),highs=a.map(r=>r.visGuidance.high).filter(finite);
    const confs=a.map(r=>r.visGuidance.confidence).filter(finite);
    const peakProb=key=>{const q=a.map(r=>r.visGuidance[key]).filter(finite);return q.length?Math.max(...q):null;};
    return {
      low:lows.length?Math.min(...lows):null,high:highs.length?Math.max(...highs):null,
      minimum:minRow?.visGuidance?.point??null,minimumTime:minRow?.t??null,
      p1500:peakProb('p1500'),p1000:peakProb('p1000'),p500:peakProb('p500'),p200:peakProb('p200'),
      confidence:confs.length?mean(confs):null,confidenceLabel:confidenceLabel(confs.length?mean(confs):null),hours:a.length
    };
  }

  return {VERSION,evaluate,eventSummary,confidenceLabel,roundVis,internalSeverity,visibilityFromSeverity};
});
