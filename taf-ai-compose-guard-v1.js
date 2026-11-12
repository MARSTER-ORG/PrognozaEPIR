'use strict';
// Independent grounding gate for Gemini TAF co-authored change groups.
// The deterministic forecast and instruction validator remain authoritative.
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFCoauthorGate=api;
})(typeof window!=='undefined'?window:null,function(){
  const H=3600000;
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const visBand=v=>[800,1500,3000,5000].filter(t=>v>=t).length;
  const cloudBand=v=>[200,300,500,1000,1500].filter(t=>v>=t).length;
  function parts(text){
    const original=String(text||'');
    if(/\r|\n/.test(original))return null;
    if((original.match(/=/g)||[]).length!==1||!original.trim().endsWith('='))return null;
    const items=normalize(original.slice(0,original.lastIndexOf('=')))
      .replace(/\s+(?=(?:BECMG|TEMPO|PROB30|FM\d{6})\b)/g,'\n').split('\n');
    if(!/^TAF\s+EPIR\s+\d{6}Z\s+\d{4}\/\d{4}\s+/.test(items[0]))return null;
    return {base:items[0],groups:items.slice(1)};
  }
  function resolve(code,ref){
    if(!/^\d{4}$/.test(code))return NaN;
    const day=+code.slice(0,2),hour=+code.slice(2);
    if(day<1||day>31||hour>24)return NaN;
    const d=new Date(ref),arr=[];
    for(let m=-1;m<=1;m++){
      const month=d.getUTCMonth()+m,year=d.getUTCFullYear();
      const day0=Date.UTC(year,month,day,0);
      const check=new Date(day0);
      if(check.getUTCDate()!==day)continue;
      arr.push(day0+hour*H);
    }
    return arr.sort((a,b)=>Math.abs(a-ref)-Math.abs(b-ref))[0]??NaN;
  }
  function parseGroup(text,meta){
    const s=normalize(text),m=s.match(/^(PROB30 TEMPO|PROB30|BECMG|TEMPO)\s+(\d{4})\/(\d{4})\s+(.+)$/);
    if(!m)return null; // Do not allow Gemini to introduce an unprovable FM or new syntax.
    const [,kind,a,b,payload]=m;
    const start=resolve(a,meta.start),end=resolve(b,start+H);
    if(!Number.isFinite(start)||!Number.isFinite(end))return null;
    return {kind,start,end,payload,text:s,fields:fields(payload)};
  }
  function fields(payload){
    const w=/\b(?:VRB|\d{3})(?:\d{2}|P99)(?:G(?:\d{2}|P99))?KT\b/.test(payload);
    const vis=/\b(?:9999|\d{4})\b/.test(payload)||/\bCAVOK\b/.test(payload);
    const wx=/\b(?:FG|FZFG|BR|NSW|RA|SN|DZ|TS|FZRA|FZDZ|TSRA|SHRA|SHSN)\b/.test(payload);
    const cloud=/\b(?:NSC|FEW\d{3}|SCT\d{3}|BKN\d{3}|OVC\d{3}|CAVOK)\b/.test(payload);
    return [...(w?['wind']:[]),...(vis?['visibility']:[]),...(wx?['weather']:[]),...(cloud?['clouds']:[])];
  }
  function rowVis(h){
    const x=String(h?.tafDisplay?.visibility||'');
    if(x==='9999')return 10000;
    if(/^\d{4}$/.test(x))return +x;
    return Number.isFinite(+h?.visM)?+h.visM:null;
  }
  function fogRisk(h,kind){
    const p=h?.prob||{},key=kind==='FG'?'fg':'br',value=Number(p[key]);
    return Number.isFinite(value)?value:0;
  }
  function payloadInfo(payload){
    const v=payload.match(/\b(9999|\d{4})\b/);
    const vis=v?(v[1]==='9999'?10000:+v[1]):/\bCAVOK\b/.test(payload)?10000:null;
    const cloud=(payload.match(/\b(BKN|OVC)(\d{3})\b/)||[]);
    return {vis,cloud:cloud.length?{kind:cloud[1],ft:+cloud[2]*100}:null,
      fog:/\b(?:FG|FZFG)\b/.test(payload)?'FG':/\bBR\b/.test(payload)?'BR':'',
      frozen:/\bFZFG\b/.test(payload),wind:(payload.match(/\b(?:VRB|\d{3})(?:\d{2}|P99)(?:G(?:\d{2}|P99))?KT\b/)||[])[0]||null
    };
  }
  function hasSupportedForecast(group,rows,meta){
    const info=payloadInfo(group.payload);
    const onset=rows.filter(h=>Number.isFinite(h?.t)&&h.t>=group.start-H&&h.t<=group.end+H);
    const after=rows.filter(h=>Number.isFinite(h?.t)&&h.t>=group.end&&h.t<Math.min(meta.end,group.end+4*H));
    if(!onset.length)return false;
    const all=group.kind==='BECMG'?after:onset;
    if(group.kind==='BECMG'&&after.length<2)return false;
    if(!all.length)return false;
    const enough=group.kind==='BECMG'?Math.max(2,Math.ceil(all.length*.6)):1;
    const matches=h=>{
      if(info.vis!==null){
        const fv=rowVis(h);
        const alt=Number(h?.prob?.alt?.fgM??h?.sourceRow?.fogAltVisM);
        const altSupported=group.kind==='PROB30'&&info.fog==='FG'&&Number.isFinite(alt)&&
          alt>=0&&alt<1000&&visBand(alt)===visBand(info.vis);
        if((fv===null||visBand(fv)!==visBand(info.vis))&&!altSupported)return false;
      }
      if(info.cloud){
        const c=String(h?.tafDisplay?.clouds||'');
        const re=new RegExp('\\b'+info.cloud.kind+'(\\d{3})\\b'),m=c.match(re);
        const ft=m?+m[1]*100:null;
        if(ft===null||cloudBand(ft)!==cloudBand(info.cloud.ft))return false;
      }
      if(info.fog){
        if(info.vis!==null&&(info.fog==='FG'&&info.vis>=1000||info.fog==='BR'&&(info.vis<1000||info.vis>5000)))return false;
        const risk=fogRisk(h,info.fog);
        if(group.kind==='PROB30'&&!(risk>=.30&&risk<.50))return false;
        if(group.kind==='BECMG'&&risk<.50)return false;
        if(info.frozen)return false; // no independent freezing-fog evidence is supplied in 12h package
      }
      if(/\b(?:RA|DZ|SN|SHRA|SHSN|TS|TSRA|FZRA|FZDZ)\b/.test(group.payload)){
        const wx=String(h?.tafDisplay?.weather||'');
        if(!/\b(?:RA|DZ|SN|SHRA|SHSN|TS|TSRA|FZRA|FZDZ)\b/.test(wx))return false;
      }
      if(info.wind){
        if(String(h?.tafDisplay?.wind||'')!==info.wind)return false;
      }
      return true;
    };
    return all.filter(matches).length>=enough;
  }
  function evaluate({baseTaf,candidateTaf,hourly,meta,validate}){
    const fail=(reason)=>({accepted:false,reason,taf:baseTaf});
    const original=parts(baseTaf),proposed=parts(candidateTaf);
    if(!original||!proposed)return fail('syntax');
    // Gemini must not restore ordinary FEW. FEW CB/TCU is an essential
    // convective-cloud exception and remains valid at its observed amount.
    if(/\bFEW\d{3}\b/.test(candidateTaf))return fail('ordinary_few_not_proposed');
    if(original.base!==proposed.base)return fail('base_or_header_changed');
    if(normalize(baseTaf)===normalize(candidateTaf))return fail('unchanged');
    if(proposed.groups.length>5||proposed.groups.length>original.groups.length+1)return fail('too_many_changes');
    if(typeof validate!=='function')return fail('validator_missing');
    const checks=validate(candidateTaf,meta);
    if(checks?.ok!==true)return fail('instruction_rejected');
    const baseGroups=original.groups.map(g=>parseGroup(g,meta));
    const groups=proposed.groups.map(g=>parseGroup(g,meta));
    if(groups.some(g=>!g)||baseGroups.some(g=>!g))return fail('unsupported_group');
    const unique=new Set(groups.map(g=>g.text));
    if(unique.size!==groups.length)return fail('duplicate_groups');
    for(const g of groups){
      if(g.start<meta.start||g.end>meta.end||g.start>=g.end)return fail('time_outside_cycle');
      const duration=(g.end-g.start)/H;
      if(g.kind==='BECMG'&&duration>2)return fail('becmg_exceeds_preferred_window');
      if(g.kind==='PROB30'&&duration>3&&/\b(?:FG|BR)\b/.test(g.payload))
        return fail('prob30_fog_onset_window_too_long');
      // For hourly input, there is no sub-hourly evidence for newly invented TEMPO.
      if((g.kind==='TEMPO'||g.kind==='PROB30 TEMPO')&&!baseGroups.some(b=>b.text===g.text))
        return fail('tempo_without_subhourly_evidence');
      if(!g.fields.length)return fail('empty_group');
      const unchanged=baseGroups.some(b=>b.text===g.text);
      if(!unchanged&&!hasSupportedForecast(g,hourly||[],meta))
        return fail('unsubstantiated_forecast');
    }
    // Do not silently drop a deterministic prevailing transition: the model can
    // move it or revise its payload, but removing it requires a human forecaster.
    for(const b of baseGroups.filter(x=>x.kind==='BECMG')){
      if(!groups.some(g=>g.kind==='BECMG'&&g.fields.some(f=>b.fields.includes(f))))
        return fail('prevailing_transition_removed');
    }
    for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){
      const a=groups[i],b=groups[j];
      if(a.start<b.end&&b.start<a.end&&a.fields.some(x=>b.fields.includes(x)))
        return fail('overlapping_parameter_groups');
    }
    return {accepted:true,reason:'grounded_and_instruction_valid',taf:normalize(candidateTaf),
      checks,groups:groups.map(g=>({kind:g.kind,s:g.start,e:g.end,text:g.text,fields:g.fields,payload:g.payload}))};
  }
  return Object.freeze({evaluate,parts,parseGroup,visBand});
});
