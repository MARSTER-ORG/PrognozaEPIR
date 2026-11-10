'use strict';
// Military TAF instruction (A) 11.2023: semantic post-processor. Runs after fog recovery.
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory;
  if(root?.PrognozaEPIRTAFEngine&&!root.__PROGNOZA_EPIR_TAF_STRICT_GUARD__){
    root.PrognozaEPIRTAFEngine=factory(root.PrognozaEPIRTAFEngine);
    root.__PROGNOZA_EPIR_TAF_STRICT_GUARD__=true;
  }
})(typeof window!=='undefined'?window:null,function wrapTafInstruction(base){
  const visCuts=[800,1500,3000,5000],cloudCuts=[200,500,1000,1500];
  const compact=s=>String(s||'').replace(/=/g,' ').replace(/\s+/g,' ').trim();
  const fragments=s=>compact(s).replace(/\s+(?=(?:BECMG|TEMPO|PROB30|FM\d{6})\b)/g,'\n').split('\n').filter(Boolean);
  const isChange=s=>/^(?:BECMG|TEMPO|PROB30|FM\d{6})\b/.test(s);
  const noHeader=(s,i)=>i===0?s.replace(/^TAF(?:\s+(?:AMD|COR))?\s+[A-Z]{4}\s+\d{6}Z\s+\d{4}\/\d{4}\s+/,''):s.replace(/^(?:(?:PROB30\s+TEMPO|PROB30|BECMG|TEMPO)\s+\d{4}\/\d{4}|FM\d{6})\s+/,'');
  function state(s,i){
    const t=noHeader(s,i),v=t.match(/(?:^|\s)(9999|\d{4})(?=\s|$)/),cl=[...t.matchAll(/\b(BKN|OVC)(\d{3})(?:CB|TCU)?\b/g)].map(m=>+m[2]*100);
    const wind=t.match(/\b(?:VRB|\d{3})(?:\d{2}|P99)(?:G(?:\d{2}|P99))?KT\b/);
    const fog=/\b(?:FG|FZFG)\b/.test(t)?'FG':/\bBR\b/.test(t)?'BR':'NONE';
    const wx=[...t.matchAll(/(?:^|\s)([-+]?(?:RA|DZ|SN|SHRA|SHSN|TSRA|TS|FZRA|FZDZ|BR|FG|FZFG|HZ|FU|DU|SA|BLSN|SQ|FC|NSW))(?=\s|$)/g)].map(m=>m[1]);
    return {vis:v?(v[1]==='9999'?10000:+v[1]):null,cloud:cl.length?Math.min(...cl):null,wind:wind?.[0]||null,fog,wx,hasCloud:/\b(?:NSC|FEW|SCT|BKN|OVC)\d{0,3}/.test(t),text:t};
  }
  const band=(v,cuts)=>cuts.filter(n=>v>=n).length;
  function worsening(current,alternative){
    if(current.vis!==null&&alternative.vis!==null&&band(alternative.vis,visCuts)<band(current.vis,visCuts))return true;
    const risk={NONE:0,BR:1,FG:2};
    if(risk[alternative.fog]>risk[current.fog])return true;
    if(current.cloud!==null&&alternative.cloud!==null&&
      band(alternative.cloud,cloudCuts)<band(current.cloud,cloudCuts))return true;
    if(current.cloud===null&&alternative.cloud!==null&&alternative.cloud<1500)return true;
    const important=wx=>/^(?:[-+]?TS|[-+]?SH|FZ|[+]?(?:RA|SN|DZ)|SQ|FC|BL)/.test(wx);
    if(alternative.wx.some(wx=>important(wx)&&!current.wx.includes(wx)))return true;
    if(current.wind&&alternative.wind&&current.wind!==alternative.wind){
      const speed=w=>{const m=w.match(/^(?:VRB|\d{3})(\d{2})(?:G(\d{2}))?KT$/);return m?{mean:+m[1],gust:+(m[2]||m[1])}:null;};
      const a=speed(current.wind),b=speed(alternative.wind);
      if(a&&b&&(b.mean-a.mean>=10||b.gust-a.gust>=10))return true;
    }
    return false;
  }
  function hasRelevantWx(s){
    return s.wx.some(x=>x!=='NSW'&&x!=='BR'&&x!=='FG'&&x!=='FZFG');
  }
  function semanticErrors(taf){
    const lines=fragments(taf),errors=[];
    if(/\r|\n/.test(String(taf)))errors.push('TAF zawiera znak nowego wiersza.');
    if(!lines.length)return ['TAF jest pusty.'];
    let prevailing=state(lines[0],0);
    for(let i=0;i<lines.length;i++){
      const line=lines[i],s=state(line,i);
      const baseOrFm=i===0||/^FM\d{6}\b/.test(line);
      const resolvedVis=s.vis!==null?s.vis:prevailing.vis;
      const resolvedFog=s.fog!=='NONE'?s.fog:baseOrFm?'NONE':prevailing.fog;
      if(resolvedVis!==null&&resolvedVis<1000&&resolvedFog!=='FG'&&!hasRelevantWx(s)){
        errors.push('Widzialność poniżej 1000 m bez udokumentowanego FG/FZFG lub innego istotnego zjawiska: '+line);
      }
      if(s.vis!==null&&s.vis>=1000&&s.fog==='FG')
        errors.push('FG przy widzialności >=1000 m: '+line);
      if(s.vis!==null&&s.vis>5000&&s.fog==='BR')errors.push('BR przy widzialności >5000 m: '+line);
      if(s.vis!==null&&s.vis<1000&&s.fog==='BR')
        errors.push('BR przy widzialności <1000 m: '+line);
      if(/^PROB30\b/.test(line)&&!worsening(prevailing,{...prevailing,...s,vis:s.vis??prevailing.vis,cloud:s.cloud??prevailing.cloud,wind:s.wind??prevailing.wind,wx:s.wx.length?s.wx:prevailing.wx})){
        errors.push('PROB30 nie wprowadza istotnego pogorszenia względem warunków przeważających: '+line);
      }
      if(baseOrFm)prevailing=s;
      else if(/^BECMG\b/.test(line)){
        prevailing={...prevailing,vis:s.vis??prevailing.vis,cloud:s.cloud??prevailing.cloud,wind:s.wind??prevailing.wind,fog:s.fog==='NONE'?prevailing.fog:s.fog,wx:s.wx.length?s.wx:prevailing.wx};
      }
    }
    return errors;
  }
  function validate(taf,meta){
    const checks=base.validateTaf?base.validateTaf(compact(taf).replace(/=$/,'')+'=',meta):base.createEngine().validate(taf,meta);
    const errors=[...(checks.errors||[]),...semanticErrors(taf)];
    return {...checks,ok:errors.length===0,errors};
  }
  function generate(inner,input){
    const result=inner.generate(input),all=fragments(result.taf);
    if(!all.length)throw Error('Pusty projekt TAF');
    // PROB30 describes alternative worsening, never identical or merely better conditions.
    const keep=[],removed=[];let prevailing=state(all[0],0);
    for(let i=1;i<all.length;i++){
      const line=all[i],s=state(line,i);
      const alt={...prevailing,...s,vis:s.vis??prevailing.vis,cloud:s.cloud??prevailing.cloud,wind:s.wind??prevailing.wind,wx:s.wx.length?s.wx:prevailing.wx};
      if(/^PROB30\b/.test(line)&&!worsening(prevailing,alt)){removed.push(line);continue;}
      keep.push(line);
      if(/^FM\d{6}\b/.test(line))prevailing=s;
      else if(/^BECMG\b/.test(line))prevailing=alt;
    }
    const taf=[all[0],...keep].join(' ')+'=';
    const checks=validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){
      const e=Error('TAF odrzucony: '+checks.errors.join(' | '));e.validation=checks;e.draftResult={...result,taf,groups:(result.groups||[]).filter(g=>!removed.includes(compact(g.text))),checks};throw e;
    }
    const groups=(result.groups||[]).filter(g=>!removed.includes(compact(g.text)));
    const reasons=[...(result.diagnostics?.reasons||[])];
    for(const s of removed)reasons.push('Odrzucono nieistotną/niekorzystną dla interpretacji grupę PROB30: '+s);
    return {...result,taf,groups,checks:{...result.checks,...checks,instructionLocked:true},diagnostics:{...result.diagnostics,reasons,strictGuard:'Instrukcja TAF (A) 11.2023 / semantic gate / single line'}};
  }
  return Object.freeze({...base,validateTaf:validate,
    createEngine(options={}){
      const inner=base.createEngine(options);
      return Object.freeze({...inner,validate,generate(input={}){return generate(inner,input);}});
    },helpers:Object.freeze({...base.helpers,strictSemanticErrors:semanticErrors,strictCompactTaf:compact})
  });
});
