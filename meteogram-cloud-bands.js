'use strict';
/* Presentation-only cloud diagnostics from existing model pressure-level profile.
   Never infer clear skies by extrapolating below the lowest sampled level. */
(function(root){
  if(root.PrognozaEPIRCloudBands) {
    if(typeof module!=='undefined'&&module.exports)module.exports=root.PrognozaEPIRCloudBands;
    return;
  }
  const CONFIG=[
    {key:'veryLow',from:0,to:450,label:'Bardzo niskie 0–450 m'},
    {key:'low',from:450,to:2000,label:'Niskie 450–2000 m'},
    {key:'mid',from:2000,to:6000,label:'Średnie 2–6 km'},
    {key:'high',from:6000,to:13000,label:'Wysokie 6–13 km'}
  ];
  function finite(v){return Number.isFinite(v);}
  function points(profile){
    if(!Array.isArray(profile))return [];
    const sorted=profile.filter(p=>p&&finite(p.agl)&&finite(p.cc)&&p.agl>=0&&p.agl<=16000)
      .map(p=>({agl:p.agl,cc:Math.max(0,Math.min(100,p.cc))}))
      .sort((a,b)=>a.agl-b.agl);
    return sorted.filter((p,i)=>i===0||p.agl>sorted[i-1].agl);
  }
  function sample(p,h){
    if(p.length<2||h<p[0].agl||h>p[p.length-1].agl)return null;
    for(let i=1;i<p.length;i++) {
      const a=p[i-1],b=p[i];
      if(h>b.agl)continue;
      const q=(h-a.agl)/(b.agl-a.agl);
      return a.cc+(b.cc-a.cc)*q;
    }
    return null;
  }
  function okta(cc) {
    if(!finite(cc))return null;
    let v=Math.max(0,Math.min(8,Math.round(cc/12.5)));
    if(v>=5&&cc<62.5)v=4;
    return v;
  }
  function band(p,from,to) {
    if(p.length<2||p[0].agl>from||p[p.length-1].agl<to-1)return null;
    let peak=null;
    for(let h=from;h<to;h+=25) {
      const v=sample(p,h);
      if(finite(v))peak=peak===null?v:Math.max(peak,v);
    }
    const last=sample(p,to-1);
    if(finite(last))peak=peak===null?last:Math.max(peak,last);
    return okta(peak);
  }
  function veryLow(p) {
    // One supported profile point in the lowest 300 m and coverage up to 450 m
    // are required. A partial lower boundary is flagged for the tooltip.
    if(p.length<2||p[0].agl>300||p[p.length-1].agl<450)return {okta:null,quality:'unknown'};
    const lower=Math.max(0,p[0].agl);
    let peak=null;
    for(let h=lower;h<450;h+=25){
      const v=sample(p,h);
      if(finite(v))peak=peak===null?v:Math.max(peak,v);
    }
    const last=sample(p,449);
    if(finite(last))peak=peak===null?last:Math.max(peak,last);
    return {okta:okta(peak),quality:p[0].agl<=150?'supported':'partial'};
  }
  function bases(p) {
    const out={few:null,sct:null,bkn:null};
    if(p.length<2||p[0].agl>300||p[p.length-1].agl<450)return out;
    const start=Math.max(0,p[0].agl);
    const stop=Math.min(3000,p[p.length-1].agl);
    for(let h=start;h<=stop;h+=25){
      const o=okta(sample(p,h));
      if(o===null)continue;
      const key=o>=5?'bkn':o>=3?'sct':o>=1?'few':null;
      if(key&&out[key]===null)out[key]=Math.round(h/25)*25;
    }
    return out;
  }
  function fromProfile(profile) {
    const p=points(profile),vl=veryLow(p),coverage={};
    for(const c of CONFIG)coverage[c.key]=c.key==='veryLow'?vl.okta:band(p,c.from,c.to);
    return {coverage,bases:bases(p),veryLowQuality:vl.quality,hasProfile:p.length>=2,
      lowestLevelM:p.length?p[0].agl:null};
  }
  const api=Object.freeze({CONFIG,fromProfile,okta});
  root.PrognozaEPIRCloudBands=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);