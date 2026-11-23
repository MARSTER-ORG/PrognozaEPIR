'use strict';
/* Conservative cloud-physics precipitation character assistant.
 * WMO Cloud Atlas priors are qualitative, never calibrated probabilities.
 * No precipitation event or freezing/snow/rain phase is invented.
 */
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(!root||!root.document)return;
  root.PrognozaEPIRPrecipIntelligence=api;
  if(root.__epirPrecipIntelligenceInstalled||typeof dataVisible!=='function')return;
  root.__epirPrecipIntelligenceInstalled=true;
  const previous=dataVisible;
  dataVisible=function(){
    const rows=previous.apply(this,arguments);
    if(Array.isArray(rows)&&typeof selected!=='undefined'&&selected==='consensus')
      api.refine(rows,root.PrognozaEPIRPrecipitation,Date.now());
    return rows;
  };
  if(typeof showSectionInfo==='function'){
    const previousInfo=showSectionInfo;
    showSectionInfo=function(z,panelId){
      const result=previousInfo.apply(this,arguments);
      if(!z||!['prec','probstorm','storm'].includes(panelId))return result;
      const holder=root.document.querySelector('#sectionInfo .section-values');
      if(!holder)return result;
      for(const [key,value] of api.tooltipRows(z)){
        const cell=root.document.createElement('div');
        const label=root.document.createElement('small'),val=root.document.createElement('strong');
        cell.className='section-value';label.textContent=key;val.textContent=value;
        cell.append(label,val);holder.appendChild(cell);
      }
      return result;
    };
  }
})(typeof globalThis!=='undefined'?globalThis:null,function(){
  const H=3600000;
  const n=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
  const pct=(v)=>n(v)!==null&&v>=0&&v<=100?v:null;
  const HAZARD=new Set(['FZRA','FZDZ','PL','RASN','SHRASN','SHGR','SHGS',
    'TS','TSRA','TSSN','TSGR','VAR']);
  function deepConvection(z){
    const e=z?.precipEvidence;
    return e?.deepConvectiveNwp===true||e?.convectiveNwp===true||
      e?.tcuModelSignal===true||e?.radarForecastEcho===true||
      ['convection','tcu','radar','cu','mismatch'].includes(e?.marker)||
      (n(z?.storm)!==null&&z.storm>=30);
  }
  function cloudRegime(z){
    if(!z||!z.precipType||n(z.RR)===null||z.RR<=0)
      return {id:'none',label:'Brak podstaw do diagnozy rodzaju opadu'};
    if(deepConvection(z))
      return {id:'convective_signal',label:'Sygnał konwekcji — Cu/TCu/Cb możliwe',
        note:'Nie dowodzi wystąpienia TCu/Cb, a kod SH nie wynika wyłącznie z CAPE'};
    const low=pct(z.low),mid=pct(z.mid),rh=pct(z.RH),base=n(z.lowH);
    const temp=n(z.T),dew=n(z.Td);
    const profile=Array.isArray(z.profile)?z.profile:[];
    const levels=profile.filter(p=>n(p?.agl)!==null&&p.agl>=0&&p.agl<=13000&&pct(p?.cc)!==null);
    const coverage=new Set(levels.map(p=>p.agl)).size;
    const lowLevels=levels.filter(p=>p.agl<2000),midLevels=levels.filter(p=>p.agl>=2000&&p.agl<6000);
    // A model-derived cloud-vertical-structure proxy cannot identify genus St/Ns.
    // Fail closed if low/mid profile, humidity or base are not available.
    if(coverage<3||!lowLevels.length||!midLevels.length||low===null||mid===null||rh===null||base===null||base<0||
       temp===null||dew===null)
      return {id:'insufficient',label:'Profil chmur niepełny — brak identyfikacji rodzaju'};
    const nearSaturated=temp-dew>=-0.5&&temp-dew<=2.5;
    if(low>=80&&mid<=48&&base<=1050&&rh>=89&&nearSaturated&&
       lowLevels.some(p=>p.cc>=80)&&midLevels.every(p=>p.cc<=48)&&
       z.RR<=.45&&n(z.storm)!==null&&z.storm<22)
      return {id:'shallow_stratiform',
        label:'Płytki, wilgotny układ warstwowy — warunki sprzyjające St/Sc',
        note:'Przy dodatniej temperaturze słabe opady mogą mieć charakter mżawki; brak bezpośredniej diagnozy Stratus'};
    if(low>=77&&mid>=70&&rh>=86&&nearSaturated&&z.RR>=.45&&
       lowLevels.some(p=>p.cc>=77)&&midLevels.some(p=>p.cc>=70)&&
       n(z.storm)!==null&&z.storm<25)
      return {id:'deep_stratiform',
        label:'Rozległa, głębsza warstwa — układ zbliżony do As/Ns',
        note:'Wspiera opad ciągły (deszcz lub śnieg), bez rozstrzygania fazy na podstawie chmur'};
    return {id:'undetermined',label:'Zachmurzenie nie określa jednoznacznie rodzaju opadu'};
  }
  function aligned(a,b){return n(a?.t)!==null&&n(b?.t)!==null&&
    Math.abs(Math.abs(b.t-a.t)-H)<=.12*H;}
  function share(z,code){
    const x=z?.precipType?.codeSharesPct?.[code];
    return pct(x)??0;
  }
  function modelCount(z,code){return n(z?.precipType?.codeModelCounts?.[code])??0;}
  function drizzleEvidence(z){
    const wx=z?.precipType;
    return wx&&wx.phaseFamily==='rain'&&wx.wetModelCount>=4&&
      pct(wx.phaseAgreementPct)!==null&&wx.phaseAgreementPct>=76&&
      share(z,'DZ')>=28&&modelCount(z,'DZ')>=2&&
      share(z,'RA')<=55&&share(z,'SHRA')<18&&share(z,'TSRA')<10;
  }
  function canRefine(p,c,q,now){
    const wx=c?.precipType;
    if(!wx||!['RA','DZ'].includes(wx.code)||HAZARD.has(wx.code))return null;
    // Beyond 48 hours stratiform cloud profiles are less dependable as subtype cues.
    if(n(now)!==null&&c.t>now+48*H)return null;
    if(!aligned(p,c)||!aligned(c,q))return null;
    if(![p,c,q].every(z=>z?.precipType&&
       ['RA','DZ'].includes(z.precipType.code)))return null;
    if([p,c,q].some(z=>[...HAZARD].some(code=>share(z,code)>0)))return null;
    if(n(c.T)===null||c.T<=2.5)return null; // no fake freezing drizzle/snow grains
    if([p,c,q].some(deepConvection))return null;
    if(n(c.RR)===null||[p,q].some(z=>n(z.RR)===null))return null;
    const wet=wx.wetModelCount>=4&&pct(wx.phaseAgreementPct)!==null&&
      wx.phaseAgreementPct>=76;
    if(!wet)return null;
    if(wx.code==='RA'){
      if(![p,c,q].every(z=>cloudRegime(z).id==='shallow_stratiform'))return null;
      if(!drizzleEvidence(c)||c.RR>.32)return null;
      const peak=Math.max(.1,p.RR,q.RR);
      if(c.RR>1.7*peak)return null;
      // At least one neighbour must already have DZ or independently support it.
      const neigh=[p,q].filter(z=>z.precipType.code==='DZ'||
        (share(z,'DZ')>=24&&modelCount(z,'DZ')>=2)).length;
      if(neigh<1)return null;
      const rawDz=share(c,'DZ'),rawRa=share(c,'RA');
      // Do not override a clear rain majority merely because St-like clouds exist.
      if(rawDz<.7*rawRa)return null;
      return {from:'RA',to:'DZ',regime:'shallow_stratiform',
        supportingType:'DZ',supportPct:rawDz,
        explanation:'Przewaga płytkiej, wilgotnej warstwy niskich chmur przez 3 h, słaby opad i mżawka w co najmniej dwóch modelach. Wskazanie DZ jest hipotezą wspartą kodami modeli, nie obserwacją Stratus.'};
    }
    // Opposite oscillation: a single DZ amid a coherent broad, deep
    // As/Ns-like wet cloud deck, moderate rain rates and independently
    // corroborated RA codes should not dominate the whole three-hour spell.
    if(![p,c,q].every(z=>cloudRegime(z).id==='deep_stratiform'))return null;
    if(p.precipType.code!=='RA'||q.precipType.code!=='RA')return null;
    if(c.RR<.6||p.RR<.4||q.RR<.4)return null;
    const rawRa=share(c,'RA'),rawDz=share(c,'DZ');
    if(modelCount(c,'RA')<2||rawRa<27||rawDz>56||
       rawRa<.65*rawDz||share(c,'SHRA')>=18||share(c,'TSRA')>=10)return null;
    return {from:'DZ',to:'RA',regime:'deep_stratiform',
      supportingType:'RA',supportPct:rawRa,
      explanation:'Trzygodzinny, głębszy pokład chmur podobny do As/Ns i umiarkowany opad, wraz z kodem RA co najmniej dwóch modeli. Korekta charakteru na deszcz ciągły jest sugestią, nie rozpoznaniem Nimbostratus.'};
  }
  function refine(rows,types,now){
    if(!Array.isArray(rows)||!types?.TYPES)return rows;
    // Reversible and idempotent: the previous raw aggregate must win whenever
    // the model ensemble or independent convective evidence changes.
    for(const z of rows){
      if(!z)continue;
      if(z.precipType?.intelligenceOriginalType)
        z.precipType=z.precipType.intelligenceOriginalType;
      z.precipIntelligence=null;
      z.precipCloudContext=null;
    }
    const seq=rows.filter(z=>n(z?.t)!==null).slice().sort((a,b)=>a.t-b.t);
    const proposals=[];
    for(let i=1;i<seq.length-1;i++){
      const hint=canRefine(seq[i-1],seq[i],seq[i+1],now);
      if(hint)proposals.push({row:seq[i],hint});
    }
    for(const {row,hint} of proposals){
      const old=row.precipType;
      const next=types.TYPES[hint.to];
      if(!next)continue;
      row.precipIntelligence={...hint,corrected:true};
      row.precipType={...old,...next,
        label:hint.to==='DZ'?'Mżawka (sugerowana z profilu chmur i modeli)':
          'Deszcz (sugerowany z profilu chmur i modeli)',
        source:'korekta kontekstowa; pierwotnie '+hint.from,
        intelligenceAdjusted:true,intelligenceOriginalType:old,
        intelligenceOriginalCode:hint.from};
    }
    // Derived diagnostics exist for every wet hour, even where no correction
    // is justified; they are qualitative, not "confidence percentages".
    for(const z of rows){
      if(!z||!z.precipType)continue;
      const regime=cloudRegime(z);
      const changed=z.precipIntelligence?.corrected===true;
      z.precipCloudContext={
        regime:regime.id,description:regime.label,
        note:regime.note||null,changed,
        confidence:changed?'reguła spełniona; wymaga walidacji historycznej':
          'nie zmieniono kodu modelowego',
        drizzleModelPct:share(z,'DZ'),
        drizzleModelCount:modelCount(z,'DZ')};
    }
    return rows;
  }
  function tooltipRows(z){
    const info=z?.precipCloudContext;
    if(!info)return [];
    const rows=[['Układ chmur — interpretacja',info.description]];
    if(info.note)rows.push(['Uwaga o chmurach',info.note]);
    if(info.changed){
      const h=z.precipIntelligence;
      rows.push(['Korekta rodzaju opadu',h.from+' → '+h.to+'* (sugestia modelowo-fizyczna)'],
        ['Poparcie '+h.supportingType+' wśród modeli z opadem',
          h.supportPct.toFixed(1)+'% wag, co najmniej 2 modele'],
        ['Dlaczego',h.explanation]);
    }
    rows.push(['Zasada bezpieczeństwa','Nie zmieniono sumy opadu, fazy, surowych kodów WMO ani prognozy TAF']);
    return rows;
  }
  return Object.freeze({cloudRegime,drizzleEvidence,canRefine,refine,tooltipRows});
});
