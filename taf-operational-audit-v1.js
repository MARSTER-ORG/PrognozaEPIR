'use strict';
// Operational meteorological audit is separate from the formal TAF instruction gate.
// It never issues an operational forecast and never invents a weather phenomenon.
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFOperationalAudit=api;
})(typeof window!=='undefined'?window:null,function(){
  const H=3600000;
  const finite=Number.isFinite;
  function compact(x){return String(x||'').replace(/\s+/g,' ').trim();}
  function sections(taf){return compact(taf).replace(/=$/,'')
    .replace(/\s+(?=(?:BECMG|TEMPO|PROB30|FM\d{6})\b)/g,'\n').split('\n');}
  function visibility(text){
    const m=String(text||'').match(/(?:^|\s)(9999|\d{4})(?=\s|$)/);
    return m?(m[1]==='9999'?10000:+m[1]):/\bCAVOK\b/.test(text)?10000:null;
  }
  function baseline(taf){
    const first=sections(taf)[0]||'';
    return first.replace(/^TAF(?:\s+(?:AMD|COR))?\s+[A-Z]{4}\s+\d{6}Z\s+\d{4}\/\d{4}\s+/,'');
  }
  function codeTime(code,ref){
    if(!/^\d{4}$/.test(code))return NaN;
    const day=+code.slice(0,2),hour=+code.slice(2);
    if(day<1||day>31||hour>24)return NaN;
    const d=new Date(ref),xs=[];
    for(let offset=-1;offset<=1;offset++){
      const midnight=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset,day);
      if(new Date(midnight).getUTCDate()===day)xs.push(midnight+hour*H);
    }
    return xs.sort((a,b)=>Math.abs(a-ref)-Math.abs(b-ref))[0]??NaN;
  }
  function forecastVis(hour){
    const n=+hour?.visM;
    if(hour?.visM!==null&&hour?.visM!==undefined&&finite(n))return n;
    return visibility(hour?.tafDisplay?.visibility);
  }
  function median(values){
    const v=values.filter(x=>x!==null&&finite(x)).sort((a,b)=>a-b);
    if(!v.length)return null;
    return v[Math.floor((v.length-1)/2)];
  }
  function evaluate({taf,hourly=[],observation=null,history=[],asOf=Date.now(),meta={}}={}){
    const errors=[],warnings=[],information=[],source=Array.isArray(hourly)?hourly:[];
    const first=baseline(taf),baseVis=visibility(first);
    const parsed=observation&&finite(+observation.t)&&finite(+observation.vis)?observation:null;
    const recent=parsed&&asOf>=parsed.t&&asOf-parsed.t<=2*H;
    const local=Array.isArray(history)?history.filter(x=>x&&finite(+x.t)&&finite(+x.vis)
      &&x.t<=asOf&&asOf-x.t<=2*H).sort((a,b)=>b.t-a.t):[];
    const trend=local.length>=2?local[0].vis-local.at(-1).vis:null;
    const clearing=trend!==null&&trend>=1500;
    const firstForecast=median(source.slice(0,3).map(forecastVis));
    if(!parsed)warnings.push('Brak czytelnej kotwicy METAR/SPECI EPIR przed analizą.');
    if(source.length<8)errors.push('Niekompletny szereg godzinowy TAF.');
    if(recent&&parsed.vis<5000&&(parsed.br||parsed.fg||parsed.saturated)&&!clearing){
      if(baseVis!==null&&baseVis>=5000&&firstForecast!==null&&firstForecast<5000)
        errors.push('Część główna ma widzialność >=5000 m, choć pierwsze godziny prognozy i aktualny EPIR wskazują <5000 m.');
      else if(baseVis!==null&&baseVis>=5000)
        warnings.push('METAR EPIR <5000 m bez potwierdzonego trendu poprawy; bazowa widzialność >=5000 m wymaga weryfikacji.');
    }
    if(recent&&parsed.vis<5000&&baseVis!==null&&baseVis>=5000&&
       trend===null)warnings.push('Dostępna tylko jedna świeża obserwacja EPIR; nie wolno uznać zaniku BR/FG za potwierdzony.');
    // BECMG modifies only its explicitly stated parameters. Cloud-only BECMG
    // never cancels inherited FG/BR or previous prevailing visibility.
    const lines=sections(taf);
    let inheritedVis=visibility(first),inheritedWx=/\b(?:FG|FZFG)\b/.test(first)?'FG':/\bBR\b/.test(first)?'BR':'';
    for(const line of lines.slice(1)){
      if(!/^BECMG\b/.test(line))continue;
      const m=line.match(/^BECMG\s+(\d{4})\/(\d{4})\s+(.+)$/);
      if(!m)continue;
      const end=codeTime(m[2],meta.start||asOf),part=m[3],v=visibility(part);
      if(v!==null)inheritedVis=v;
      if(/\b(?:FG|FZFG)\b/.test(part))inheritedWx='FG';
      else if(/\bBR\b/.test(part))inheritedWx='BR';
      else if(/\b(?:NSW|CAVOK)\b/.test(part))inheritedWx='';
      if(inheritedWx==='FG'&&inheritedVis!==null&&inheritedVis<1000&&finite(end)){
        const next=source.filter(h=>finite(+h.t)&&h.t>=end&&h.t<end+3*H).slice(0,2);
        if(next.length===2&&next.every(h=>forecastVis(h)>=3000&&Number(h.prob?.fg||0)<.3))
          warnings.push('Po BECMG '+m[1]+'/'+m[2]+' TAF nadal utrzymuje FG i '+inheritedVis+' m, lecz prognoza godzinowa wskazuje poprawę; sprawdź brakujące NSW/widzialność.');
      }
    }

    // Compare every forecast hour with effective prevailing TAF conditions.
    // PROB/TEMPO do not replace the base; BECMG applies after its end time.
    const transitions=lines.slice(1).map(line=>{
      const b=line.match(/^BECMG\s+(\d{4})\/(\d{4})\s+(.+)$/);
      if(b)return {at:codeTime(b[2],meta.start||asOf),part:b[3],fm:false};
      const fm=line.match(/^FM(\d{4})(\d{2})\s+(.+)$/);
      if(fm)return {at:codeTime(fm[1],meta.start||asOf)+Number(fm[2])*60000,part:fm[3],fm:true};
      return null;
    }).filter(x=>x&&finite(x.at)).sort((a,b)=>a.at-b.at);
    function prevailingAt(t){
      let vis=visibility(first),wx=/\b(?:FG|FZFG)\b/.test(first)?'FG':/\bBR\b/.test(first)?'BR':'NONE';
      for(const g of transitions){
        if(g.at>t)break;
        const next=visibility(g.part);
        if(g.fm){vis=next;wx='NONE';}
        else if(next!==null)vis=next;
        if(/\b(?:FG|FZFG)\b/.test(g.part))wx='FG';
        else if(/\bBR\b/.test(g.part))wx='BR';
        else if(/\b(?:NSW|CAVOK)\b/.test(g.part))wx='NONE';
      }
      return {vis,wx};
    }
    const inconsistency={clearing:[],inheritedFog:[],fogEngine:[],lightRain:[]};
    for(const h of source){
      if(!finite(+h?.t))continue;
      const v=forecastVis(h),p=prevailingAt(+h.t),src=h.sourceRow||{};
      if(v!==null&&v>=8000&&p.vis!==null&&p.vis<3000)inconsistency.clearing.push(+h.t);
      if(p.vis!==null&&p.vis>=5000&&p.wx==='FG')inconsistency.inheritedFog.push(+h.t);
      const e=src.fogEngineVisM===null||src.fogEngineVisM===undefined?null:+src.fogEngineVisM;
      const br=src.brOperationalScore===null||src.brOperationalScore===undefined?null:+src.brOperationalScore;
      const fg=src.fgOperationalScore===null||src.fgOperationalScore===undefined?null:+src.fgOperationalScore;
      if(v!==null&&v>=8000&&e!==null&&finite(e)&&e<5000&&
         ((br!==null&&br>=60)||(fg!==null&&fg>=60)))inconsistency.fogEngine.push(+h.t);
      if(v!==null&&v<1000&&/^(?:-RA|-DZ)$/.test(String(h.tafDisplay?.weather||'')))inconsistency.lightRain.push(+h.t);
    }
    const utc=t=>new Date(t).toISOString().slice(11,16)+' UTC';
    if(inconsistency.inheritedFog.length>=2)
      errors.push('Po poprawie widzialności do >=5000 m TAF nadal dziedziczy FG od '+utc(inconsistency.inheritedFog[0])+'. Brak NSW lub prawidłowej grupy zmiany pogody.');
    else if(inconsistency.inheritedFog.length)
      warnings.push('TAF dziedziczy FG pomimo poprawy widzialności: '+utc(inconsistency.inheritedFog[0])+'. Sprawdź NSW.');
    if(inconsistency.clearing.length>=2)
      warnings.push('TAF pomija utrzymującą się poprawę widzialności godzinowej od '+utc(inconsistency.clearing[0])+'. Zweryfikuj BECMG, Fog Engine i obserwacje.');
    if(inconsistency.fogEngine.length)
      warnings.push('Konflikt Fog Engine z widzialnością godzinową od '+utc(inconsistency.fogEngine[0])+': prognoza >=8000 m, Fog Engine <5000 m z aktywnym FG/BR. Nie zakładaj automatycznie 9999.');
    if(inconsistency.lightRain.length)
      warnings.push('Widzialność <1000 m przy samym -RA/-DZ bez FG od '+utc(inconsistency.lightRain[0])+'. Sprawdź pogodę, wilgotność i dane źródłowe.');
    if(meta.issue>asOf+5*60000)information.push('Cykl TAF jeszcze nie został wydany; wyświetlany jest projekt na przyszłą godzinę.');
    if(parsed&&recent&&trend!==null)information.push('Trend EPIR 2 h: '+Math.round(trend)+' m; dodatni oznacza poprawę.');
    const level=errors.length?'BLOCK':warnings.length?'REVIEW':'PRELIMINARY';
    return Object.freeze({level,errors,warnings,information,
      formalAndMeteorologicalIndependent:true,baseVisibilityM:baseVis,firstHoursMedianVisibilityM:firstForecast,
      localObservedVisibilityM:parsed?.vis??null});
  }
  return Object.freeze({evaluate,baseline,visibility,sections});
});
