'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRFogVisibilityVNext=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='0.1.0-operational';
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const mean=a=>{const q=(a||[]).filter(finite);return q.length?q.reduce((s,v)=>s+v,0)/q.length:null;};

  function weightedAvailable(items){
    let s=0,w=0;
    for(const p of items||[]){
      const v=num(p?.v),ww=Math.max(0,num(p?.w)||0);
      if(finite(v)&&ww>0){s+=v*ww;w+=ww;}
    }
    return w?s/w:null;
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
  function geoBlend(a,b,w){
    a=num(a);b=num(b);w=clamp(num(w)??0);
    if(!finite(a))return b;if(!finite(b))return a;
    a=Math.max(25,a);b=Math.max(25,b);
    return Math.exp((1-w)*Math.log(a)+w*Math.log(b));
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
  function empiricalProbability(values,threshold){
    const a=(values||[]).filter(finite);if(!a.length)return null;
    return 100*a.filter(v=>v<threshold).length/a.length;
  }
  function fogTarget(score){
    score=num(score);if(!finite(score)||score<35)return null;
    const pts=[[35,4000],[45,2300],[50,1600],[60,1000],[70,700],[80,450],[90,300],[100,180]];
    for(let i=1;i<pts.length;i++)if(score<=pts[i][0])return interp(score,pts[i-1][0],pts[i][0],pts[i-1][1],pts[i][1]);
    return pts.at(-1)[1];
  }
  function severityBand(score){
    score=num(score);if(!finite(score)||score<35)return null;
    const lows=[[35,2200],[45,1200],[50,900],[60,550],[70,300],[80,180],[90,100],[100,50]];
    const highs=[[35,8000],[45,4000],[50,2600],[60,1600],[70,1000],[80,650],[90,420],[100,280]];
    const sample=pts=>{
      for(let i=1;i<pts.length;i++)if(score<=pts[i][0])return interp(score,pts[i-1][0],pts[i][0],pts[i-1][1],pts[i][1]);
      return pts.at(-1)[1];
    };
    return {low:sample(lows),high:sample(highs)};
  }
  function scoreProbability(score,threshold){
    const ranges={1500:[34,68],1000:[44,78],500:[57,90],200:[72,98]};
    const r=ranges[threshold];return r?smoothstep(score,r[0],r[1])*100:null;
  }
  function thresholdProbability(hour,values,score,sat,threshold){
    const key='vis'+threshold;
    const empirical=empiricalProbability(values,threshold);
    const legacy=num(hour?.[key]);
    const scoreP=scoreProbability(score,threshold);
    const satP=finite(sat)?clamp((sat-55)/45)*100:null;
    const weights=threshold<=200
      ?[{v:empirical,w:.55},{v:legacy,w:.28},{v:scoreP,w:.12},{v:satP,w:.05}]
      :threshold<=500
        ?[{v:empirical,w:.50},{v:legacy,w:.28},{v:scoreP,w:.17},{v:satP,w:.05}]
        :[{v:empirical,w:.45},{v:legacy,w:.30},{v:scoreP,w:.20},{v:satP,w:.05}];
    const p=weightedAvailable(weights);return finite(p)?clamp(p,0,100):null;
  }
  function confidenceLabel(c){
    c=num(c);if(!finite(c))return 'brak danych';
    if(c>=.80)return 'bardzo wysoka';if(c>=.65)return 'wysoka';if(c>=.45)return 'średnia';if(c>=.25)return 'niska';return 'bardzo niska';
  }

  function evaluate(hour={},context={}){
    const values=modelValues(hour);
    const legacyCenter=num(hour.vis);
    const q25=quantile(values,.25),q50=quantile(values,.50),q75=quantile(values,.75);
    const base=legacyCenter??q50;
    const score=num(context.score)??num(hour.score);
    const sat=num(context.saturation)??num(hour.sat);
    const direct=num(context.directFog)??num(hour.dmiFog);
    const lead=num(context.leadHours)??num(hour.lead)??0;

    let p1500=thresholdProbability(hour,values,score,sat,1500);
    let p1000=thresholdProbability(hour,values,score,sat,1000);
    let p500=thresholdProbability(hour,values,score,sat,500);
    let p200=thresholdProbability(hour,values,score,sat,200);
    if(finite(p1500)&&finite(p1000))p1000=Math.min(p1000,p1500);
    if(finite(p1000)&&finite(p500))p500=Math.min(p500,p1000);
    if(finite(p500)&&finite(p200))p200=Math.min(p200,p500);

    const support=weightedAvailable([
      {v:finite(p1500)?p1500/100:null,w:.25},{v:finite(p1000)?p1000/100:null,w:.35},
      {v:finite(sat)?sat/100:null,w:.20},{v:finite(direct)?direct/100:null,w:.20}
    ])??0;
    const target=fogTarget(score),band=severityBand(score);
    let alpha=0;
    if(finite(score)&&score>=35&&finite(target))alpha=clamp(((score-35)/65)*(.28+.52*support),0,.78);
    if(finite(score)&&score<50&&finite(p1500)&&p1500<40)alpha*=.45;

    let point=finite(base)?base:target;
    if(finite(base)&&finite(target))point=geoBlend(base,target,alpha);

    let low=q25??(finite(base)?base/1.65:null),high=q75??(finite(base)?base*1.65:null);
    if(band){
      low=geoBlend(low,band.low,alpha);
      high=geoBlend(high,band.high,alpha);
    }
    if(!finite(low)&&finite(point))low=point/1.7;
    if(!finite(high)&&finite(point))high=point*1.7;
    if(finite(point)&&finite(low))low=Math.min(low,point);
    if(finite(point)&&finite(high))high=Math.max(high,point);
    low=roundVis(low);point=roundVis(point);high=roundVis(high);
    if(finite(low)&&finite(point)&&low>point)low=point;
    if(finite(high)&&finite(point)&&high<point)high=point;

    const n=values.length;
    const coverage=n?clamp(n/5):finite(base)?.30:0;
    const spreadRatio=finite(q25)&&finite(q75)&&q25>0?Math.max(1,q75/q25):null;
    const agreement=finite(spreadRatio)?1-clamp(Math.log(spreadRatio)/Math.log(8)):n===1?.35:null;
    const legacyConf=num(hour.confidence);
    const coherence=finite(base)&&finite(point)&&base>0&&point>0?1-clamp(Math.abs(Math.log(point/base))/Math.log(8)):.35;
    let confidence=weightedAvailable([{v:coverage,w:.32},{v:agreement,w:.38},{v:legacyConf,w:.20},{v:coherence,w:.10}]);
    if(finite(confidence))confidence*=1-.22*clamp((lead-12)/36);
    confidence=finite(confidence)?clamp(confidence):null;

    const phase=String(context.phase||hour?.vnext?.phase||'').toLowerCase()||null;
    const modelMedian=roundVis(q50);
    return {
      version:VERSION,point,low,high,p1500,p1000,p500,p200,confidence,
      confidenceLabel:confidenceLabel(confidence),modelCount:n,modelMedian,rawLegacy:roundVis(legacyCenter),
      phase,source:'vnext-visibility-guidance',support:clamp(support),adjustment:alpha,
      diagnostics:{q25:roundVis(q25),q50:modelMedian,q75:roundVis(q75),target:roundVis(target),base:roundVis(base),spreadRatio,coverage,agreement,coherence}
    };
  }

  function eventSummary(rows=[]){
    const a=(rows||[]).filter(r=>r?.visGuidance&&finite(r.t));
    if(!a.length)return null;
    const points=a.filter(r=>finite(r.visGuidance.point));
    const minRow=points.reduce((best,r)=>!best||r.visGuidance.point<best.visGuidance.point?r:best,null);
    const lows=a.map(r=>r.visGuidance.low).filter(finite),highs=a.map(r=>r.visGuidance.high).filter(finite);
    const confs=a.map(r=>r.visGuidance.confidence).filter(finite);
    const peakProb=(key)=>{const q=a.map(r=>r.visGuidance[key]).filter(finite);return q.length?Math.max(...q):null;};
    return {
      low:lows.length?Math.min(...lows):null,high:highs.length?Math.max(...highs):null,
      minimum:minRow?.visGuidance?.point??null,minimumTime:minRow?.t??null,
      p1500:peakProb('p1500'),p1000:peakProb('p1000'),p500:peakProb('p500'),p200:peakProb('p200'),
      confidence:confs.length?mean(confs):null,confidenceLabel:confidenceLabel(confs.length?mean(confs):null),hours:a.length
    };
  }

  return {VERSION,evaluate,eventSummary,confidenceLabel,roundVis};
});
