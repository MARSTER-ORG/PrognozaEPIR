'use strict';
/* EPIR meteogram: conservative temporal continuity for precipitation *presentation*.
 * Do not smooth accumulation, precipitation probability, real showers or radar evidence.
 */
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(!root||!root.document)return;
  root.PrognozaEPIRPrecipContinuity=api;
  if(root.__epirPrecipContinuityInstalled||typeof dataVisible!=='function')return;
  root.__epirPrecipContinuityInstalled=true;
  const previous=dataVisible;
  dataVisible=function(){
    const rows=previous.apply(this,arguments);
    if(Array.isArray(rows)&&typeof selected!=='undefined'&&selected==='consensus')
      api.stabilize(rows,root.PrognozaEPIRPrecipitation);
    return rows;
  };
  if(typeof showSectionInfo==='function'){
    const previousInfo=showSectionInfo;
    showSectionInfo=function(z,panelId){
      const result=previousInfo.apply(this,arguments);
      if(!z||!['prec','probstorm'].includes(panelId))return result;
      const holder=root.document.querySelector('#sectionInfo .section-values');
      if(!holder)return result;
      for(const [key,val] of api.tooltipRows(z)){
        const item=root.document.createElement('div');
        const small=root.document.createElement('small');
        const strong=root.document.createElement('strong');
        item.className='section-value';small.textContent=key;strong.textContent=val;
        item.append(small,strong);holder.appendChild(item);
      }
      return result;
    };
  }
})(typeof globalThis!=='undefined'?globalThis:null,function(){
  const HOUR=3600000;
  const BASE_CODE=Object.freeze({SHRA:'RA',SHSN:'SN'});
  const PHASE=Object.freeze({RA:'rain',SHRA:'rain',SN:'snow',SHSN:'snow'});
  const num=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
  function protectedEvidence(z){
    const e=z?.precipEvidence||{};
    return e.convectiveNwp===true||e.radarForecastEcho===true||
      e.marker==='radar'||e.marker==='convection';
  }
  function aligned(p,c,n){
    return [p,c,n].every(z=>num(z?.t)!==null)&&
      Math.abs((c.t-p.t)-HOUR)<=.12*HOUR&&
      Math.abs((n.t-c.t)-HOUR)<=.12*HOUR;
  }
  function decide(p,c,n){
    const w=c?.precipType,prev=p?.precipType,next=n?.precipType;
    const code=w?.code,target=BASE_CODE[code];
    if(!target||prev?.code!==target||next?.code!==target)return null;
    if(!aligned(p,c,n))return null;
    // One isolated hourly shower code can be visually normalized only if the
    // surrounding non-showery hydrometeor PHASE is strongly and consistently
    // supported. An RA/SN disagreement is never re-labelled as RASN.
    if(PHASE[code]!==PHASE[prev.code]||PHASE[code]!==PHASE[next.code])return null;
    if(w.phaseFamily!==PHASE[code]||prev.phaseFamily!==PHASE[code]||
       next.phaseFamily!==PHASE[code])return null;
    if(num(w.phaseAgreementPct)<70||num(prev.phaseAgreementPct)<75||
       num(next.phaseAgreementPct)<75)return null;
    if(num(w.characterAgreementPct)===null||w.characterAgreementPct<65||
       w.characterAgreementPct>=80)return null;
    if(num(prev.characterAgreementPct)<70||num(next.characterAgreementPct)<70)return null;
    if(num(w.supportPct)<60||num(prev.supportPct)<65||num(next.supportPct)<65)return null;
    if([p,c,n].some(z=>num(z.precipType?.wetModelCount)<3))return null;
    if([p,c,n].some(protectedEvidence))return null;
    // No change near the phase boundary, or during an abrupt hour-scale change.
    if([p,c,n].some(z=>num(z.T)===null||Math.abs(z.T)<=1.5))return null;
    if([p,c,n].some(z=>num(z.storm)!==null&&z.storm>=35))return null;
    const amounts=[p,c,n].map(z=>num(z.RR));
    if(amounts.every(x=>x!==null)){
      const [a,b,d]=amounts;
      if(b>=.5&&b>1.8*Math.max(.1,a,d))return null;
      if(b===0)return null;
    }else return null; // Absent amounts are not evidence of temporal continuity.
    return {before:code,after:target,phase:PHASE[code],support:'three_hour_consensus',
      reason:'Izolowany sygnał opadu przelotnego o umiarkowanej zgodności modeli; sąsiednie godziny wskazują ten sam rodzaj opadu. Brak silnego potwierdzenia konwekcji lub lokalnego maksimum intensywności.'};
  }
  function stabilize(rows,types){
    if(!Array.isArray(rows)||!types?.TYPES)return rows;
    // Repeated draw/dataVisible calls must be idempotent. Never make a previously
    // corrected label the evidence for the next correction.
    for(const z of rows){
      if(!z)continue;
      if(z.precipType?.temporalOriginalType)
        z.precipType=z.precipType.temporalOriginalType;
      z.precipTemporal=null;
    }
    const sorted=rows.filter(z=>z&&num(z.t)!==null)
      .slice().sort((a,b)=>a.t-b.t);
    const proposals=[];
    for(let i=1;i<sorted.length-1;i++){
      const before=sorted[i-1],center=sorted[i],after=sorted[i+1];
      const change=decide(before,center,after);
      if(change)proposals.push({center,change});
    }
    for(const {center,change} of proposals){
      const original=center.precipType;
      const to=types.TYPES[change.after];
      if(!to)continue;
      center.precipTemporal=change;
      center.precipType={...original,...to,
        label:to.label+' — charakter przejściowo niepewny',
        source:'filtr ciągłości 3 godzin; oryginalny '+change.before,
        temporalAdjusted:true,temporalOriginalType:original,
        temporalOriginalCode:change.before,
        character:'charakter niepewny'};
    }
    return rows;
  }
  function tooltipRows(z){
    const t=z?.precipTemporal;
    if(!t)return [];
    return [
      ['Ciągłość opadu',t.before+' → '+t.after+' (korekta prezentacji)'],
      ['Uzasadnienie',t.reason],
      ['Dane liczbowe','Ilość, prawdopodobieństwo i prognozy modeli niezmienione']
    ];
  }
  return Object.freeze({BASE_CODE,aligned,decide,stabilize,tooltipRows});
});
