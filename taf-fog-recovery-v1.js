'use strict';
(function(root){
  if(!root || root.__PROGNOZA_EPIR_TAF_FOG_RECOVERY_V1__)return;
  const api=root.PrognozaEPIRTAFEngine;
  if(!api?.createEngine)throw new Error('TAF Fog Recovery v1 requires active TAF Engine');

  const HOUR=3600000;
  const VERSION='2026-10-03a';
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const pad=(n,w=2)=>String(Math.max(0,Math.round(n))).padStart(w,'0');
  const code=t=>{const d=new Date(t);return pad(d.getUTCDate())+pad(d.getUTCHours());};
  const period=(s,e)=>`${code(s)}/${code(e)}`;
  const overlap=(a,b)=>a.s<b.e&&b.s<a.e;
  const severity=f=>f==='FG'?2:f==='BR'?1:0;

  function fallbackFogFamily(state){
    const wx=String(state?.tafDisplay?.weather||'').toUpperCase();
    if(/\b(?:FG|FZFG)\b/.test(wx))return'FG';
    if(/\bBR\b/.test(wx))return'BR';
    return'NONE';
  }

  function family(state,helpers){
    try{return helpers?.fogFamily?.(state,.5)||fallbackFogFamily(state);}catch(_){return fallbackFogFamily(state);}
  }

  function visibilityToken(v,helpers){
    try{const x=helpers?.visibilityToken?.(v);if(x)return x;}catch(_){}
    if(!num(v)||+v>=10000)return'9999';
    const n=Math.max(0,+v);
    if(n<800)return pad(Math.max(0,Math.min(750,Math.floor(n/50)*50)),4);
    if(n<5000)return pad(Math.max(800,Math.min(4900,Math.floor(n/100)*100)),4);
    return pad(Math.max(5000,Math.min(9000,Math.floor(n/1000)*1000)),4);
  }

  function baseVisibility(result){
    if(num(result?.base?.state?.visM))return +result.base.state.visM;
    const m=String(result?.base?.text||'').match(/(?:^|\s)(9999|\d{4})(?:\s|$)/);
    return m?(m[1]==='9999'?10000:+m[1]):10000;
  }

  function payloadVisibility(payload){
    const m=String(payload||'').match(/(?:^|\s)(9999|\d{4})(?:\s|$)/);
    return m?(m[1]==='9999'?10000:+m[1]):NaN;
  }

  function recoveryCandidate(result,helpers,input){
    const hourly=Array.isArray(result?.hourly)?result.hourly:[];
    const baseState=result?.base?.state;
    if(!baseState||hourly.length<3)return null;
    const baseFamily=family(baseState,helpers);
    const baseSeverity=severity(baseFamily);
    if(baseSeverity===0)return null;

    for(let i=1;i<hourly.length-1;i++){
      const a=hourly[i],b=hourly[i+1];
      if(!num(a?.t)||!num(b?.t))continue;
      const fa=family(a,helpers),fb=family(b,helpers);
      const sa=severity(fa),sb=severity(fb);
      if(sa>=baseSeverity||sb>=baseSeverity)continue;

      const targetSeverity=Math.max(sa,sb);
      const targetFamily=targetSeverity===1?'BR':'NONE';
      const vals=[a.visM,b.visM].filter(num).map(Number);
      if(!vals.length)continue;
      let visM=Math.min(...vals);
      if(targetFamily==='BR')visM=Math.max(1000,Math.min(5000,visM));
      else if(visM<5000)continue;

      const t=+a.t;
      let s=Math.max(+input.start,t-HOUR),e=Math.min(+input.end,t+HOUR);
      if(e-s<2*HOUR){
        if(s===+input.start)e=Math.min(+input.end,s+2*HOUR);
        else if(e===+input.end)s=Math.max(+input.start,e-2*HOUR);
      }
      if(!(e>s))continue;
      const vis=visibilityToken(visM,helpers);
      const payload=targetFamily==='BR'?`${vis} BR`:`${vis} NSW`;
      return {s,e,t,baseFamily,targetFamily,visM,payload};
    }
    return null;
  }

  function removableImprovementProb30(group,candidate,result){
    if(!group||group.kind!=='PROB30'||!overlap(group,candidate))return false;
    const fields=Array.isArray(group.fields)?group.fields:[];
    if(fields.some(f=>!['visibility','weather'].includes(f)))return false;
    const text=String(group.payload||group.text||'').toUpperCase();
    if(candidate.baseFamily==='FG'&&!/\b(?:FG|FZFG)\b/.test(text))return false;
    if(candidate.baseFamily==='BR'&&!/\bBR\b/.test(text))return false;
    const gv=payloadVisibility(text),bv=baseVisibility(result);
    return !num(gv)||gv>=bv;
  }

  function applyRecovery(result,input,inner){
    const helpers=inner.helpers||api.helpers||{};
    const candidate=recoveryCandidate(result,helpers,input);
    if(!candidate)return result;

    const oldGroups=Array.isArray(result.groups)?result.groups:[];
    const removed=oldGroups.filter(g=>removableImprovementProb30(g,candidate,result));
    let groups=oldGroups.filter(g=>!removed.includes(g)).map(g=>({...g,fields:[...(g.fields||[])]}));

    const conflicts=groups.some(g=>overlap(g,candidate)&&(g.fields||[]).some(f=>f==='visibility'||f==='weather'));
    if(conflicts)return result;
    if(groups.length>=5&&!removed.length)return result;

    const recovery={
      kind:'BECMG',s:candidate.s,e:candidate.e,
      fields:['visibility','weather'],payload:candidate.payload,
      probability:1,
      text:`BECMG ${period(candidate.s,candidate.e)} ${candidate.payload}`,
      fogRecoveryPolicy:true
    };
    groups.push(recovery);
    groups.sort((a,b)=>(+a.s)-(+b.s)||(+a.e)-(+b.e));
    if(groups.length>5)return result;

    const first=String(result.taf||'').replace(/=$/,'').split(/\n+/).filter(Boolean)[0]||'';
    const taf=[first,...groups.map(g=>g.text)].filter(Boolean).join('\n')+'=';
    const checks=inner.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks?.ok)return result;

    const removedTexts=new Set(removed.map(g=>String(g.text||'')).filter(Boolean));
    const reasons=(result?.diagnostics?.reasons||[]).filter(r=>![...removedTexts].some(t=>String(r).includes(t)));
    const utc=`${pad(new Date(candidate.t).getUTCHours())}:00 UTC`;
    reasons.push(`Ustępowanie mgły: część bazowa ${candidate.baseFamily}; od ${utc} co najmniej 2 h trwałej poprawy. ${removed.length?'Usunięto przejściowy PROB30 wewnątrz tego samego reżimu mgły i ':''}zastosowano ${recovery.text}.`);

    return {
      ...result,taf,groups,
      checks:{...result.checks,...checks,noProb40:!taf.includes('PROB40'),noVV:!/\bVV/.test(taf),max5:groups.length<=5,periodHours:12,instructionLocked:true},
      rules:{...(result.rules||{}),fogRecoveryBecmg:true,fogRecoveryPersistenceHours:2},
      diagnostics:{
        ...result.diagnostics,reasons,
        fogRecoveryPolicy:`${VERSION}: prevailing FG/BR recovery uses persistent (>=2 h) local hourly improvement; transient same-regime visibility PROB30 is suppressed when it conflicts with that recovery`,
        fogRecoveryTarget:candidate.targetFamily,
        fogRecoveryStart:candidate.t,
        fogRecoveryRemovedProb30:removed.length
      }
    };
  }

  function createEngine(options={}){
    const inner=api.createEngine(options);
    return Object.freeze({
      ...inner,
      generate(input={}){return applyRecovery(inner.generate(input),input,inner);}
    });
  }

  root.PrognozaEPIRTAFEngine=Object.freeze({...api,createEngine});
  root.__PROGNOZA_EPIR_TAF_FOG_RECOVERY_V1__=true;
})(typeof window!=='undefined'?window:globalThis);
