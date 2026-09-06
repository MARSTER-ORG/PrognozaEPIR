'use strict';
(() => {
  let verification = null;
  const HOUR = 3600e3;

  const finiteNum = Number.isFinite;
  const clamp01 = v => Math.max(0,Math.min(1,v));

  function circularDiff(a,b) {
    if (!finiteNum(a) || !finiteNum(b)) return null;
    const d=Math.abs((a-b)%360);
    return Math.min(d,360-d);
  }

  function linearAgreement(error,bad) {
    if (!finiteNum(error)) return null;
    return 100*clamp01(1-error/bad);
  }

  function visibilityAgreement(a,b) {
    if (!finiteNum(a) || !finiteNum(b)) return null;
    const aa=Math.max(500,a),bb=Math.max(500,b);
    const ratio=Math.abs(Math.log(aa/bb));
    return 100*clamp01(1-ratio/Math.log(5));
  }

  function agreementForPair(a,b) {
    const parts=[];
    const push=v=>{if(finiteNum(v))parts.push(v)};
    push(linearAgreement(Math.abs((a.T??NaN)-(b.T??NaN)),6));
    push(linearAgreement(Math.abs((a.Td??NaN)-(b.Td??NaN)),6));
    push(linearAgreement(Math.abs((a.P??NaN)-(b.P??NaN)),10));
    push(linearAgreement(Math.abs((a.WS??NaN)-(b.WS??NaN)),6));
    if ((a.WS??0)>=1.5 && (b.WS??0)>=1.5) push(linearAgreement(circularDiff(a.WD,b.WD),90));
    push(visibilityAgreement(a.VIS,b.VIS));
    push(linearAgreement(Math.abs((a.oktaL??NaN)-(b.oktaL??NaN)),5));
    push(linearAgreement(Math.abs((a.oktaM??NaN)-(b.oktaM??NaN)),5));
    push(linearAgreement(Math.abs((a.oktaH??NaN)-(b.oktaH??NaN)),5));
    return parts.length?parts.reduce((s,v)=>s+v,0)/parts.length:null;
  }

  function currentModelAgreement() {
    try {
      if (typeof consensus==='undefined' || !Array.isArray(consensus) || !consensus.length ||
          typeof MODELS==='undefined' || typeof datasets==='undefined' || typeof modelSeries!=='function') return null;
      const end=Date.now()+Math.min(Number(horizon)||48,48)*HOUR;
      const base=consensus.filter(z=>z.t<=end);
      if (!base.length) return null;
      const baseMap=new Map(base.map(z=>[z.t,z]));
      const scores=[];
      for (const m of MODELS) {
        if (!datasets.has(m.id)) continue;
        const series=modelSeries(m.id);
        for (const z of series) {
          const c=baseMap.get(z.t);
          if (!c) continue;
          const s=agreementForPair(z,c);
          if (finiteNum(s)) scores.push(s);
        }
      }
      return scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null;
    } catch (_) {
      return null;
    }
  }

  function selectedVerification() {
    const key=(typeof selected!=='undefined' && selected)?selected:'consensus';
    const row=verification?.models?.[key];
    return finiteNum(row?.score_pct)?Math.round(row.score_pct):null;
  }

  function updateBox() {
    const box=document.getElementById('models');
    if (!box) return;
    const agreement=currentModelAgreement();
    const verified=selectedVerification();
    box.innerHTML=
      '<div><b>Zgodność modeli:</b> '+(agreement===null?'—':agreement+'%')+'</div>'+
      '<div><b>Sprawdzalność z realnymi danymi:</b> '+(verified===null?'—':verified+'%')+'</div>';
  }

  async function loadVerification() {
    try {
      const r=await fetch('data/learning/model-verification.json?ts='+Date.now(),{cache:'no-cache'});
      if (r.ok) verification=await r.json();
    } catch (_) { }
    updateBox();
  }

  function install() {
    if (typeof render==='function' && !window.__epirModelVerificationRenderWrapped) {
      const baseRender=render;
      render=function() {
        const out=baseRender.apply(this,arguments);
        updateBox();
        return out;
      };
      window.__epirModelVerificationRenderWrapped=true;
    }
    const view=document.getElementById('view');
    if (view && !view.dataset.verificationHook) {
      view.dataset.verificationHook='1';
      view.addEventListener('change',()=>setTimeout(updateBox,0));
    }
    document.querySelectorAll('button[data-h]').forEach(b=>{
      if (b.dataset.verificationHook) return;
      b.dataset.verificationHook='1';
      b.addEventListener('click',()=>setTimeout(updateBox,0));
    });
    updateBox();
    loadVerification();
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
