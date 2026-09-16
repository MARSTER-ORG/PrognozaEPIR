'use strict';
(function(root,factory){
  let base=null;
  if(typeof module!=='undefined'&&module.exports){
    base=require('./taf-engine-v241.js');
    module.exports=factory(base,null);
  }else{
    base=root&&root.PrognozaEPIRTAFEngine;
    if(!base)throw new Error('TAF Engine 2.4.2 requires taf-engine-v241.js');
    root.PrognozaEPIRTAFEngine=factory(base,root);
  }
})(typeof window!=='undefined'?window:globalThis,function(base,root){
  'use strict';

  // Keep the public API compatibility expected by taf-app-v2.js.
  const API_VERSION='2.4.0';
  const VERSION='2.4.2';
  const NAME='TAF Engine 2.4.2 — Low Cloud/Fog Coherence + Instruction First';
  const HOUR=3600000,FT=3.2808398950131;
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const pad=(n,w=2)=>String(Math.max(0,Math.round(n))).padStart(w,'0');

  function normalizeSub100CloudCodes(text){
    return String(text||'').replace(/\b(FEW|SCT|BKN|OVC)000(CB|TCU)?\b/g,(_,cover,type)=>`${cover}001${type||''}`);
  }

  function profileLowCloud(row,maxM=300){
    const p=(Array.isArray(row?.profile)?row.profile:[])
      .filter(q=>num(q?.agl)&&num(q?.cc)&&+q.agl>=0&&+q.agl<=maxM)
      .map(q=>({m:+q.agl,cc:+q.cc})).sort((a,b)=>a.m-b.m);
    if(!p.length)return {maxCc:null,bknBaseM:null,sctBaseM:null};
    const maxCc=Math.max(...p.map(q=>q.cc));
    const bkn=p.find(q=>q.cc>=50),sct=p.find(q=>q.cc>=25);
    return {maxCc,bknBaseM:bkn?.m??null,sctBaseM:sct?.m??null};
  }

  function lowStratusEvidence(row){
    const p=profileLowCloud(row,300);
    const cands=[];
    let support=0,cover='BKN';
    if(num(row?.ceiling)&&+row.ceiling>=0&&+row.ceiling<=300){cands.push(+row.ceiling);support=Math.max(support,.90);}
    if(num(row?.lowH)&&+row.lowH>=0&&+row.lowH<=300&&num(row?.oktaL)&&+row.oktaL>=5){
      cands.push(+row.lowH);support=Math.max(support,+row.oktaL>=8?.92:.84);if(+row.oktaL>=8)cover='OVC';
    }
    if(num(p.bknBaseM)){
      cands.push(+p.bknBaseM);support=Math.max(support,(p.maxCc??0)>=87.5?.90:(p.maxCc??0)>=62.5?.80:.68);if((p.maxCc??0)>=87.5)cover='OVC';
    }
    const type=String(row?.fogEngineType||'').toUpperCase();
    if(/\bCBL\b/.test(type)&&num(p.sctBaseM)){
      cands.push(+p.sctBaseM);
      // CBL is the stratus/fog pathway in Fog Engine. SCT-like near-surface
      // cloud with this mechanism is enough for an alternative BKN stratus layer,
      // but not for prevailing BKN by itself.
      support=Math.max(support,(p.maxCc??0)>=35?.58:.52);
    }
    if(!cands.length)return {support:0,baseM:null,cover,maxCc:p.maxCc};
    return {support,baseM:clamp(Math.min(...cands),30,300),cover,maxCc:p.maxCc};
  }

  function aggregateStratusEvidence(rows,s,e){
    const relevant=(rows||[]).filter(r=>num(r?.t)&&+r.t>=s-HOUR&&+r.t<e+2*HOUR);
    const ev=relevant.map(lowStratusEvidence).filter(x=>x.support>0&&num(x.baseM));
    if(!ev.length)return {support:0,baseM:null,cover:'BKN',samples:0};
    ev.sort((a,b)=>b.support-a.support);
    const persistent=ev.filter(x=>x.support>=.55).length>=2;
    const support=clamp(ev[0].support+(persistent?.07:0),0,1);
    const bases=ev.filter(x=>x.support>=.50).map(x=>x.baseM).sort((a,b)=>a-b);
    const baseM=bases.length?bases[Math.floor((bases.length-1)/2)]:ev[0].baseM;
    const cover=ev.some(x=>x.cover==='OVC'&&x.support>=.75)?'OVC':'BKN';
    return {support,baseM:clamp(baseM,30,300),cover,samples:ev.length};
  }

  function cloudToken(cover,baseM){
    // Operational low-cloud thresholds are 30/60/150/300 m ~= 100/200/500/1000 ft.
    // For forecast coding use the nearest 100-ft step and never emit a 000 cloud layer.
    const hundreds=clamp(Math.max(1,Math.round((+baseM*FT)/100)),1,999);
    return `${cover}${pad(hundreds,3)}`;
  }

  function cloudHeight(token){const m=String(token||'').match(/^(FEW|SCT|BKN|OVC)(\d{3})(?:CB|TCU)?$/);return m?+m[2]:null;}
  function mergeLowCloudToken(payload,token){
    const h=cloudHeight(token),parts=String(payload||'').trim().split(/\s+/).filter(Boolean);
    if(h===null)return normalizeSub100CloudCodes(payload);
    const filtered=parts.filter(t=>{
      const th=cloudHeight(t);if(th===null)return true;
      // Replace a weaker/duplicate layer at essentially the same very-low level.
      return !(Math.abs(th-h)<=1&&/^(?:FEW|SCT|BKN|OVC)/.test(t));
    });
    filtered.push(token);
    return normalizeSub100CloudCodes([...new Set(filtered)].join(' '));
  }

  function hasLowBknOvc(text,maxHundreds=15){
    for(const m of String(text||'').matchAll(/\b(BKN|OVC)(\d{3})(?:CB|TCU)?\b/g))if(+m[2]<=maxHundreds)return true;
    return false;
  }

  function normalizeGroupCloudCodes(groups){
    return (groups||[]).map(g=>{
      const oldPayload=String(g.payload||''),payload=normalizeSub100CloudCodes(oldPayload);
      let text=String(g.text||'');
      if(oldPayload&&payload!==oldPayload)text=text.replace(oldPayload,payload);
      text=normalizeSub100CloudCodes(text);
      return {...g,payload,text};
    });
  }

  function addFogStratusAlternatives(groups,rows,reasons){
    return groups.map(g=>{
      const payload=String(g.payload||'');
      if(!/^PROB30/.test(String(g.kind||''))||!/(?:^|\s)(?:FG|FZFG)(?:\s|$)/.test(payload)||hasLowBknOvc(payload))return g;
      const ev=aggregateStratusEvidence(rows,+g.s,+g.e);
      if(ev.support<.55||!num(ev.baseM))return g;
      const token=cloudToken(ev.cover,ev.baseM),nextPayload=mergeLowCloudToken(payload,token);
      const nextText=String(g.text||'').replace(payload,nextPayload);
      reasons.push(`${nextText}: dodano ${token} — spójny sygnał niskiego Stratus/fog-transition (${Math.round(ev.support*100)}%, ${ev.samples} prób godzinowych).`);
      return {...g,payload:nextPayload,text:nextText,fields:[...new Set([...(g.fields||[]),'clouds'])],taf242StratusEvidence:ev};
    });
  }

  function improvePrevailingBase(baseText,rows,start,reasons){
    let text=normalizeSub100CloudCodes(baseText);
    const first=(rows||[]).filter(r=>num(r?.t)&&+r.t>=start&&+r.t<start+3*HOUR);
    const ev=aggregateStratusEvidence(first,start,start+3*HOUR);
    // Prevailing BKN/OVC requires stronger/persistent evidence than a PROB30 alternative.
    if(ev.support<.75||!num(ev.baseM)||hasLowBknOvc(text))return text;
    const token=cloudToken(ev.cover,ev.baseM);
    if(/\bCAVOK\b/.test(text))text=text.replace(/\bCAVOK\b/,'9999 '+token);
    else if(/\bNSC\b/.test(text))text=text.replace(/\bNSC\b/,token);
    else text=mergeLowCloudToken(text,token);
    reasons.push(`Część bazowa: dodano ${token} — trwały sygnał niskiej warstwy BKN/OVC w pierwszych 3 h (${Math.round(ev.support*100)}%).`);
    return normalizeSub100CloudCodes(text);
  }

  function rebuildTaf(result,baseText,groups){
    const lines=String(result?.taf||'').replace(/=$/,'').split(/\n+/).filter(Boolean);
    let first=normalizeSub100CloudCodes(lines[0]||'');
    const oldBase=String(result?.base?.text||'');
    if(oldBase&&first.includes(oldBase))first=first.replace(oldBase,baseText);
    else if(oldBase&&normalizeSub100CloudCodes(oldBase)!==baseText)first=first.replace(normalizeSub100CloudCodes(oldBase),baseText);
    return [first,...groups.sort((a,b)=>(+a.s)-(+b.s)||(+a.e)-(+b.e)).map(g=>normalizeSub100CloudCodes(g.text))].filter(Boolean).join('\n')+'=';
  }

  function applyCloudFogCoherence(result,input,engine){
    const reasons=[...(result?.diagnostics?.reasons||[])];
    let groups=normalizeGroupCloudCodes((result?.groups||[]).map(g=>({...g,fields:[...(g.fields||[])]})));
    const baseText=improvePrevailingBase(result?.base?.text||'',input.rows||[],+input.start,reasons);
    groups=addFogStratusAlternatives(groups,input.rows||[],reasons);
    const taf=rebuildTaf(result,baseText,groups);
    if(/\b(?:FEW|SCT|BKN|OVC)000(?:CB|TCU)?\b/.test(taf))throw Error('TAF 2.4.2: warstwa chmur 000 przeszła kontrolę jakości.');
    const checks=engine.validate(taf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!checks.ok){const e=Error('TAF 2.4.2 odrzucony przez końcową kontrolę instrukcji: '+checks.errors.join(' | '));e.validation=checks;throw e;}
    return {
      ...result,taf,groups,base:{...(result.base||{}),text:baseText},checks:{...result.checks,...checks},version:VERSION,name:NAME,
      diagnostics:{...result.diagnostics,reasons,semanticQualityLayer:VERSION,lowCloudFogCoherence:true,
        lowCloudCodingPolicy:'forecast cloud groups below 100 ft are coded at minimum 001; 30 m maps to 001',
        fogStratusPolicy:'PROB30 FG/FZFG gains BKN/OVC low stratus only with independent low-cloud or CBL transition evidence; prevailing base requires stronger evidence'}
    };
  }

  function createEngine(options={}){
    const engine=base.createEngine(options);
    return Object.freeze({
      version:VERSION,rules:base.RULES,
      generate(input={}){const result=engine.generate(input);return applyCloudFogCoherence(result,input,engine);},
      validate:(taf,meta)=>engine.validate(taf,meta),
      helpers:Object.freeze({...engine.helpers,normalizeSub100CloudCodes,lowStratusEvidence,aggregateStratusEvidence,cloudToken})
    });
  }

  if(root){root.__PROGNOZA_EPIR_TAF_ENGINE_V242__=true;}
  return Object.freeze({ENGINE_VERSION:API_VERSION,QUALITY_VERSION:VERSION,ENGINE_NAME:NAME,INSTRUCTION:base.INSTRUCTION,RULES:base.RULES,FORMAL_KERNEL_VERSION:base.FORMAL_KERNEL_VERSION||base.ENGINE_VERSION,createEngine,validateTaf:(taf,meta)=>base.validateTaf(taf,meta),ready:base.ready,setLearningData:base.setLearningData,learningStatus:base.learningStatus,helpers:Object.freeze({...base.helpers,normalizeSub100CloudCodes,lowStratusEvidence,aggregateStratusEvidence,cloudToken})});
});
