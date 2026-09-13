'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFEngine=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='2.3.0';
  const NAME='TAF Engine 2.3 — Instruction First + EPIR Operational Policy';
  const AUTH='Instrukcja opracowywania prognoz TAF, Edycja (A), 11.2023';
  const HOUR=3600000, KT=1.9438444924406, FT=3.2808398950131;
  const VIS_THRESH=[800,1500,3000,5000];
  const CEIL_THRESH=[200,300,500,1000,1500];
  const MAX_GROUPS=5;
  const NSC_FT=5000;
  const CAVOK_FT=1500/0.3048; // 1500 m in ft

  const RULES=Object.freeze({
    authority:AUTH,
    validityHours:12,
    issueLeadHours:1,
    maxChangeGroups:5,
    prob30:{min:.30,maxExclusive:.50},
    prob40:false,
    verticalVisibility:false,
    visibilityThresholds:VIS_THRESH,
    ceilingThresholdsFt:CEIL_THRESH,
    becmgPreferredMaxHours:2,
    becmgAbsoluteMaxHours:4,
    tempoSingleEpisodeMaxHours:1,
    tempoTotalFractionMax:.5,
    tempoCannotIntroduceFogMist:true,
    tempoCannotIntroduceOrdinaryLowCloud:true,
    windDirectionChangeDeg:60,
    windDirectionMinKt:10,
    windSpeedChangeKt:10,
    gustGapKt:10,
    gustChangeMeanMinKt:15,
    ordinaryCloudOperationalLimitFt:5000,
    cloudAmountChangeLimitFt:1500,
    weakCloudObservationGateMin:.25,
    weakCloudObservationToleranceLowFt:700,
    weakCloudObservationToleranceFt:900,
    lowWindWholePeriodMinFraction:.75,
    lowWindRunMinHours:3,
    lowWindMaxOtherKt:10,
    baseFirstHoursEqualWeight:true
  });

  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const pad=(n,w=2)=>String(Math.max(0,Math.round(n))).padStart(w,'0');
  const even=n=>{n=Math.max(0,Math.round(n||0));return n%2?n+1:n;};
  const circ=(a,b)=>{if(!finite(a)||!finite(b))return 180;let d=Math.abs(a-b)%360;return d>180?360-d:d;};
  const prob=v=>!num(v)?0:(+v>1?clamp(+v/100,0,1):clamp(+v,0,1));
  const band=(v,cuts,missingTop=false)=>{if(!finite(v))return missingTop?cuts.length:null;for(let i=0;i<cuts.length;i++)if(v<cuts[i])return i;return cuts.length;};
  const mean=a=>{const q=a.filter(finite);return q.length?q.reduce((s,v)=>s+v,0)/q.length:NaN;};
  const quantile=(a,p)=>{const q=a.filter(finite).sort((x,y)=>x-y);if(!q.length)return NaN;if(q.length===1)return q[0];const x=(q.length-1)*p,l=Math.floor(x),h=Math.ceil(x);return q[l]+(q[h]-q[l])*(x-l);};
  const code=(t,minutes=false)=>{const d=new Date(t);return pad(d.getUTCDate())+pad(d.getUTCHours())+(minutes?pad(d.getUTCMinutes()):'');};
  const period=(s,e)=>code(s)+'/'+code(e);

  function amountFromOkta(o){o=clamp(Math.round(+o||0),0,8);return o<=0?null:o<=2?'FEW':o<=4?'SCT':o<=7?'BKN':'OVC';}
  function oktaFromPct(cc){if(!finite(cc)||cc<6.25)return 0;return clamp(Math.round(cc/12.5),1,8);}
  function amountRank(c){return({FEW:1,SCT:2,BKN:3,OVC:4})[String(c||'').toUpperCase()]||0;}
  function layerKey(c){return `${c.cover}:${Math.round(c.ft/100)}:${c.type||''}`;}

  function parseObservation(o){
    if(!o)return null;
    const raw=String(o.raw||o.canonical_raw||'').toUpperCase();
    const wm=raw.match(/\b(VRB|\d{3})(\d{2,3})(?:G(P99|\d{2,3}))?KT\b/);
    const vm=raw.match(/\b(9999|\d{4})\b/);
    const tm=raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    const clouds=[...raw.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map(m=>({cover:m[1],ft:+m[2]*100,type:m[3]||'',okta:({FEW:2,SCT:4,BKN:6,OVC:8})[m[1]]}));
    const val=s=>s&&s[0]==='M'?-Number(s.slice(1)):Number(s);
    let t=Date.parse(o.obs_time||o.message_time||o.issue_time||o.time||o.timestamp||'');if(!finite(t))t=Date.now();
    return {
      t,
      windDir:num(o.wind_direction_deg)?+o.wind_direction_deg:(wm&&wm[1]!=='VRB'?+wm[1]:null),
      windKt:num(o.wind_speed_ms)?+o.wind_speed_ms*KT:(wm?+wm[2]:null),
      gustKt:num(o.wind_gust_ms)?+o.wind_gust_ms*KT:(wm&&wm[3]?(wm[3]==='P99'?100:+wm[3]):null),
      visM:num(o.visibility_m)?+o.visibility_m:(/\bCAVOK\b/.test(raw)?10000:(vm?(vm[1]==='9999'?10000:+vm[1]):null)),
      T:num(o.temperature_c)?+o.temperature_c:(tm?val(tm[1]):null),
      Td:num(o.dew_point_c)?+o.dew_point_c:num(o.dewpoint_c)?+o.dewpoint_c:(tm?val(tm[2]):null),
      clouds,cavok:/\bCAVOK\b/.test(raw),nsc:/\b(?:NSC|NCD)\b/.test(raw)
    };
  }

  function anchorRows(rows,observation,start){
    const o=parseObservation(observation);if(!o)return rows.map(r=>({...r}));
    const age=Math.max(0,(start-o.t)/HOUR);if(age>6)return rows.map(r=>({...r}));
    const fresh=Math.exp(-age/3);
    return rows.map(r=>{
      const z={...r};const lead=Math.max(0,(+z.t-o.t)/HOUR),a=.78*Math.exp(-lead/4.5)*fresh;
      z.observationClouds=(o.clouds||[]).map(c=>({...c}));
      z.observationCavok=!!o.cavok;z.observationNsc=!!o.nsc;
      z.observationCloudWeight=Math.exp(-lead/6);
      if(a<.02)return z;
      if(finite(o.visM)&&num(z.VIS))z.VIS=(1-a)*+z.VIS+a*o.visM;
      if(finite(o.T)&&num(z.T))z.T=(1-a)*+z.T+a*o.T;
      if(finite(o.Td)&&num(z.Td))z.Td=(1-a)*+z.Td+a*o.Td;
      if(finite(o.windKt)&&num(z.WS))z.WS=((1-a)*(+z.WS*KT)+a*o.windKt)/KT;
      if(finite(o.gustKt)&&num(z.G))z.G=((1-a)*(+z.G*KT)+a*o.gustKt)/KT;
      z.observationAnchorPct=Math.round(a*100);
      return z;
    });
  }

  function weightedShare(row,predicate){
    const a=Array.isArray(row?.mv)?row.mv:[];if(!a.length)return NaN;
    let n=0,d=0;for(const m of a){const w=num(m.w)&&+m.w>0?+m.w:1;d+=w;if(predicate(m))n+=w;}return d?n/d:NaN;
  }

  function weatherCodeInfo(code){
    const c=Math.round(+code);
    return {
      fog:c===45||c===48,
      ts:[95,96,99].includes(c),
      frozen:[56,57,66,67].includes(c),
      snow:[71,73,75,77,85,86].includes(c),
      shower:[80,81,82,85,86].includes(c),
      precip:[51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(c),
      moderateHeavy:[53,55,57,63,65,67,73,75,81,82,86,95,96,99].includes(c)
    };
  }

  function visibilityAlternatives(row){
    const members=Array.isArray(row?.mv)?row.mv:[];
    const fgVis=members.filter(m=>num(m.vis)).map(m=>+m.vis).filter(v=>v<1000);
    const brVis=members.filter(m=>num(m.vis)).map(m=>+m.vis).filter(v=>v>=1000&&v<=5000);
    return {
      fgM:num(row?.fogAltVisM)?+row.fogAltVisM:(fgVis.length?clamp(Math.floor(quantile(fgVis,.35)/50)*50,100,900):800),
      brM:num(row?.brAltVisM)?+row.brAltVisM:(brVis.length?clamp(Math.floor(quantile(brVis,.35)/100)*100,1000,5000):clamp(+row?.VIS||4000,1000,5000))
    };
  }

  function probabilities(row){
    const modelFog=weightedShare(row,m=>weatherCodeInfo(m.code).fog);
    const modelFg=weightedShare(row,m=>num(m.vis)&&+m.vis<1000);
    const modelBr=weightedShare(row,m=>num(m.vis)&&+m.vis>=1000&&+m.vis<=5000);
    const p={
      ts:weightedShare(row,m=>weatherCodeInfo(m.code).ts),
      precip:weightedShare(row,m=>weatherCodeInfo(m.code).precip),
      moderateHeavyPrecip:weightedShare(row,m=>weatherCodeInfo(m.code).moderateHeavy),
      snow:weightedShare(row,m=>weatherCodeInfo(m.code).snow),
      frozen:weightedShare(row,m=>weatherCodeInfo(m.code).frozen),
      fg:modelFg,
      br:modelBr,
      fog:modelFog,
      lowVis:weightedShare(row,m=>num(m.vis)&&+m.vis<5000),
      lowCeiling:weightedShare(row,m=>num(m.ceil)&&+m.ceil*FT<1500)
    };
    for(const k of Object.keys(p))if(!finite(p[k]))p[k]=0;
    p.ts=Math.max(p.ts,prob(row?.storm));
    p.precip=Math.max(p.precip,prob(row?.wet));
    const fogEngine=prob(row?.fogRisk),explicitFg=prob(row?.fgRisk);
    p.fog=Math.max(p.fog,fogEngine);
    // Explicit FG evidence wins. The generic FOG score is a fallback only when no explicit FG probability was supplied.
    p.fg=Math.max(p.fg,explicitFg,prob(row?.fogVis1000Risk),explicitFg>0?0:fogEngine);
    p.br=Math.max(p.br,prob(row?.brRisk));
    // General fog score may support BR, but must never suppress a stronger FG signal.
    if(p.fog>=.30&&p.br<.30&&p.fg<.30&&num(row?.VIS)&&+row.VIS>=1000&&+row.VIS<=5000)p.br=Math.max(p.br,p.fog);
    if(num(row?.VIS)&&+row.VIS<5000)p.lowVis=Math.max(p.lowVis,.50);
    const alt=visibilityAlternatives(row);
    return {...p,alt};
  }

  function interpolateProfile(profile,step=25,max=6000){
    const src=(Array.isArray(profile)?profile:[]).filter(p=>num(p?.agl)&&num(p?.cc)).map(p=>({m:+p.agl,cc:+p.cc})).filter(p=>p.m>=0).sort((a,b)=>a.m-b.m);
    if(!src.length)return[];
    const bottom=Math.max(0,src[0].m),top=Math.min(max,Math.max(...src.map(p=>p.m)));
    const ccAt=h=>{
      if(h<=src[0].m)return src[0].cc;
      for(let i=1;i<src.length;i++)if(h<=src[i].m){const a=src[i-1],b=src[i],q=(h-a.m)/(b.m-a.m||1);return a.cc+(b.cc-a.cc)*q;}
      return src[src.length-1].cc;
    };
    const out=[];for(let h=bottom;h<=top;h+=step)out.push({m:h,cc:ccAt(h)});if(out.length&&out.at(-1).m<top)out.push({m:top,cc:ccAt(top)});return out;
  }

  function firstCrossing(profile,threshold){
    if(!profile.length)return NaN;
    if(profile[0].cc>=threshold)return profile[0].m;
    for(let i=1;i<profile.length;i++){
      const a=profile[i-1],b=profile[i];if(a.cc<threshold&&b.cc>=threshold){const q=(threshold-a.cc)/(b.cc-a.cc||1);return a.m+(b.m-a.m)*clamp(q,0,1);}
    }
    return NaN;
  }

  function profileCloudCandidates(row){
    const p=interpolateProfile(row?.profile,25,6000);if(!p.length)return[];
    const thresholds=[{cc:6.25,cover:'FEW',okta:1},{cc:31.25,cover:'SCT',okta:3},{cc:62.5,cover:'BKN',okta:5},{cc:93.75,cover:'OVC',okta:8}];
    const out=[];
    for(const t of thresholds){
      const m=firstCrossing(p,t.cc);if(!finite(m))continue;
      const near=out.findIndex(x=>Math.abs(x.m-m)<35);
      const candidate={cover:t.cover,okta:t.okta,m,ft:m*FT,type:'',source:'profile'};
      if(near>=0){if(amountRank(candidate.cover)>amountRank(out[near].cover))out[near]=candidate;continue;}
      out.push(candidate);
    }
    return out.sort((a,b)=>a.ft-b.ft||amountRank(a.cover)-amountRank(b.cover));
  }

  function fallbackCloudCandidates(row){
    if(Array.isArray(row?.clouds)&&row.clouds.length){
      return row.clouds.map(c=>({
        cover:String(c.cover||amountFromOkta(c.okta)||'').toUpperCase(),
        okta:num(c.okta)?+c.okta:({FEW:2,SCT:4,BKN:6,OVC:8}[String(c.cover||'').toUpperCase()]||0),
        m:num(c.m)?+c.m:(num(c.ft)?+c.ft/FT:NaN),
        ft:num(c.ft)?+c.ft:(num(c.m)?+c.m*FT:NaN),
        type:String(c.type||'').toUpperCase(),source:'row'
      })).filter(c=>c.cover&&finite(c.ft));
    }
    return [
      {okta:num(row?.oktaL)?+row.oktaL:0,m:num(row?.lowH)?+row.lowH:NaN,type:String(row?.lowType||'').toUpperCase()},
      {okta:num(row?.oktaM)?+row.oktaM:0,m:num(row?.midH)?+row.midH:NaN,type:String(row?.midType||'').toUpperCase()},
      {okta:num(row?.oktaH)?+row.oktaH:0,m:num(row?.highH)?+row.highH:NaN,type:String(row?.highType||'').toUpperCase()}
    ].map(c=>({cover:amountFromOkta(c.okta),okta:c.okta,m:c.m,ft:finite(c.m)?c.m*FT:NaN,type:c.type,source:'bands'})).filter(c=>c.cover&&finite(c.ft));
  }

  function cloudCandidateCredible(row,c){
    if(!c||c.type==='CB'||c.type==='TCU')return true;
    if(c.cover!=='FEW'&&c.cover!=='SCT')return true;
    const w=+row?.observationCloudWeight||0;
    if(w<RULES.weakCloudObservationGateMin)return true;
    const obs=Array.isArray(row?.observationClouds)?row.observationClouds:[];
    if(!obs.length&&!row?.observationCavok&&!row?.observationNsc)return true;
    const tol=c.ft<1500?RULES.weakCloudObservationToleranceLowFt:RULES.weakCloudObservationToleranceFt;
    return obs.some(o=>finite(+o.ft)&&Math.abs(+o.ft-c.ft)<=tol&&amountRank(o.cover)>=amountRank(c.cover));
  }

  function cloudCandidates(row,p){
    let a=profileCloudCandidates(row);
    if(!a.length)a=fallbackCloudCandidates(row);
    // Preserve explicit CB/TCU regardless of height/amount.
    if(Array.isArray(row?.clouds))for(const c of row.clouds){
      const type=String(c.type||'').toUpperCase();if(type!=='CB'&&type!=='TCU')continue;
      const ft=num(c.ft)?+c.ft:(num(c.m)?+c.m*FT:NaN);if(!finite(ft))continue;
      const cover=String(c.cover||amountFromOkta(c.okta)||'FEW').toUpperCase();a.push({cover,okta:num(c.okta)?+c.okta:Math.max(1,amountRank(cover)*2),ft,m:ft/FT,type,source:'explicit-convective'});
    }
    // Recent METAR/SPECI is a credibility gate for weak model-only FEW/SCT. Its influence decays with lead time.
    a=a.filter(c=>cloudCandidateCredible(row,c));
    // Ceiling is authoritative for the lowest BKN/OVC. Ensure clouds and ceiling cannot contradict each other.
    const ceilFt=num(row?.ceiling)?+row.ceiling*FT:NaN;
    if(finite(ceilFt)){
      const existing=a.filter(c=>(c.cover==='BKN'||c.cover==='OVC')&&!c.type).sort((x,y)=>x.ft-y.ft)[0];
      if(!existing||Math.abs(existing.ft-ceilFt)>120){a.push({cover:'BKN',okta:5,ft:ceilFt,m:ceilFt/FT,type:'',source:'ceiling-authority'});}
    }
    // Convective probability can add an inferred CB layer; it never replaces ordinary cloud layers.
    if(p?.ts>=.30&&!a.some(c=>c.type==='CB')){
      const ft=num(row?.convectiveBaseFt)?+row.convectiveBaseFt:(num(row?.lowH)&&+row.lowH>0?+row.lowH*FT:2000);
      a.push({cover:p.ts>=.50?'BKN':'FEW',okta:p.ts>=.50?5:2,ft,m:ft/FT,type:'CB',source:'convective-prob'});
    }
    const seen=new Set();
    return a.filter(c=>c.cover&&finite(c.ft)&&c.ft>=0).sort((x,y)=>x.ft-y.ft||amountRank(x.cover)-amountRank(y.cover)).filter(c=>{const k=layerKey(c);if(seen.has(k))return false;seen.add(k);return true;});
  }

  function selectClouds(state,msaFt=null){
    const lim=Math.max(NSC_FT,num(msaFt)?+msaFt:0);
    const ordinary=(state.clouds||[]).filter(c=>!c.type&&c.ft<lim).sort((a,b)=>a.ft-b.ft||amountRank(a.cover)-amountRank(b.cover));
    const convective=(state.clouds||[]).filter(c=>c.type==='CB'||c.type==='TCU').sort((a,b)=>a.ft-b.ft);
    const out=[];
    if(ordinary.length){
      out.push(ordinary[0]);
      const second=ordinary.find(c=>c.ft>out[0].ft+30&&amountRank(c.cover)>=2);
      if(second)out.push(second);
      const third=ordinary.find(c=>!out.includes(c)&&c.ft>(out.at(-1)?.ft||0)+30&&amountRank(c.cover)>=3);
      if(third)out.push(third);
    }
    // If there is an operational ceiling but selection accidentally omitted it, include it as BKN/OVC layer.
    if(finite(state.ceilingFt)&&state.ceilingFt<lim&&!out.some(c=>(c.cover==='BKN'||c.cover==='OVC')&&Math.abs(c.ft-state.ceilingFt)<=150)){
      const c=(state.clouds||[]).filter(x=>(x.cover==='BKN'||x.cover==='OVC')&&!x.type).sort((x,y)=>Math.abs(x.ft-state.ceilingFt)-Math.abs(y.ft-state.ceilingFt))[0]||{cover:'BKN',okta:5,ft:state.ceilingFt,m:state.ceilingFt/FT,type:'',source:'ceiling-repair'};
      out.push(c);out.sort((a,b)=>a.ft-b.ft);
      while(out.filter(x=>!x.type).length>3){const idx=out.findIndex((x,i)=>!x.type&&i>0&&amountRank(x.cover)<3);if(idx>=0)out.splice(idx,1);else break;}
    }
    for(const c of convective){if(!out.some(x=>x.type===c.type&&Math.abs(x.ft-c.ft)<100))out.push(c);}
    return out.sort((a,b)=>a.ft-b.ft).slice(0,4);
  }

  function stateFromRow(row){
    const p=probabilities(row),cs=cloudCandidates(row,p);
    const ceiling=cs.filter(c=>!c.type&&(c.cover==='BKN'||c.cover==='OVC')).sort((a,b)=>a.ft-b.ft)[0]?.ft??(num(row?.ceiling)?+row.ceiling*FT:NaN);
    const ws=num(row?.WS)?+row.WS*KT:0,g=num(row?.G)?+row.G*KT:ws;
    let visM=num(row.VIS)?+row.VIS:10000;
    // A prevailing >=50% FG/BR forecast cannot coexist with a contradictory prevailing visibility.
    if(p.fg>=.50&&p.fg>=p.br)visM=Math.min(visM,clamp(p.alt?.fgM||800,100,900));
    else if(p.br>=.50&&p.br>p.fg)visM=Math.min(visM,clamp(p.alt?.brM||4000,1000,5000));
    return {
      t:+row.t,windKt:ws,windDir:num(row.WD)?(+row.WD+360)%360:null,gustKt:g,dirSpreadDeg:num(row.dirSpread)?+row.dirSpread:0,
      visM,T:num(row.T)?+row.T:null,Td:num(row.Td)?+row.Td:null,RH:num(row.RH)?+row.RH:null,RR:num(row.RR)?+row.RR:0,
      clouds:cs,ceilingFt:ceiling,prob:p,sourceRow:row
    };
  }

  function prevailingFogCode(s,threshold=.50){
    const p=s.prob||{};
    if(p.fg>=threshold&&p.fg>=p.br)return s.T!==null&&s.T<=0?'FZFG':'FG';
    if(p.br>=threshold)return'BR';
    // When actual prevailing visibility is already in the fog/mist range, use physical consistency as fallback.
    if(s.visM<1000&&p.fog>=threshold)return s.T!==null&&s.T<=0?'FZFG':'FG';
    if(s.visM>=1000&&s.visM<=5000&&p.fog>=threshold)return'BR';
    return'';
  }

  function weatherToken(s,threshold=.50){
    const p=s.prob||{},rr=s.RR||0;
    if(p.ts>=threshold)return p.precip>=.30||rr>=.05?'TSRA':'TS';
    if(p.frozen>=threshold)return'FZRA';
    const fog=prevailingFogCode(s,threshold);if(fog)return fog;
    if(p.precip>=threshold){if(p.snow>=threshold)return rr>=.7?'+SN':rr>=.15?'SN':'-SN';return rr>=.7?'+RA':rr>=.15?'RA':'-RA';}
    return'';
  }

  const allowedWx=new Set(['DZ','RA','SN','SG','PL','DS','SS','FZDZ','FZRA','SHGR','SHGS','SHRA','SHSN','TSGR','TSGS','TSRA','TSSN','FG','BR','SA','DU','HZ','FU','VA','SQ','PO','FC','TS','BLDU','BLSA','BLSN','DRDU','DRSA','DRSN','FZFG']);
  function cleanWx(x){if(!x)return'';x=String(x).toUpperCase().trim();const sign=/^[+-]/.test(x)?x[0]:'',c=x.replace(/^[+-]/,'');if(/^(?:MI|BC|PR)FG$/.test(c)||!allowedWx.has(c))return'';return['FG','BR','HZ','FU','DU','SA','FZFG','TS','SQ','FC','PO','VA'].includes(c)?c:sign+c;}
  function wxFamily(x){x=cleanWx(x);const c=x.replace(/^[+-]/,'');if(!c)return'NONE';if(c==='FG'||c==='FZFG')return'FG';if(c==='BR')return'BR';if(/^FZ(?:RA|DZ)$/.test(c))return'FZPRECIP';if(/^TS/.test(c))return'TS';if(/^\+?(?:RA|DZ|SN|SG|PL|SHRA|SHSN|SHGR|SHGS)$/.test(x)&&!x.startsWith('-'))return'MODHEAVYPRECIP';if(/^DR/.test(c))return'DRIFT';if(/^BL/.test(c))return'BLOW';if(c==='SQ'||c==='FC')return c;if(/^-?(?:RA|DZ|SN|SHRA|SHSN)$/.test(x))return'WEAKPRECIP';return c;}

  function cavokEligible(s,msaFt=null){
    if(!finite(s.visM)||s.visM<10000||cleanWx(weatherToken(s,.5)))return false;
    const lim=Math.max(CAVOK_FT,num(msaFt)?+msaFt:0);
    return !(s.clouds||[]).some(c=>c.type==='CB'||c.type==='TCU'||(!c.type&&c.ft<lim));
  }

  function visibilityToken(v){
    if(!num(v)||+v>=10000)return'9999';v=Math.max(0,+v);
    if(v<800)return pad(clamp(Math.floor(v/50)*50,0,750),4);
    if(v<5000)return pad(clamp(Math.floor(v/100)*100,800,4900),4);
    return pad(clamp(Math.floor(v/1000)*1000,5000,9000),4);
  }

  function applyWindPolicy(states){
    const out=(states||[]).map(s=>({...s}));
    if(!out.length)return out;
    const raw=s=>Math.max(0,+s.windKt||0),coded=s=>even(raw(s));
    const light=s=>raw(s)>=1&&coded(s)<=2;
    const dominant=out.filter(s=>coded(s)<=2).length>=Math.ceil(out.length*RULES.lowWindWholePeriodMinFraction)
      &&Math.max(...out.map(coded))<=RULES.lowWindMaxOtherKt;
    for(let i=0;i<out.length;){
      if(!light(out[i])){i++;continue;}
      let j=i+1;while(j<out.length&&light(out[j]))j++;
      if(j-i>=RULES.lowWindRunMinHours)for(let k=i;k<j;k++)out[k].forceVrb=true;
      i=j;
    }
    for(const s of out){s.periodVrbDominant=dominant;if(dominant&&light(s))s.forceVrb=true;}
    return out;
  }

  function windToken(s){
    const raw=Math.max(0,+s.windKt||0);if(raw<1)return'00000KT';
    const sp=even(raw),vrb=s.forceVrb===true||!finite(s.windDir)||(sp<3&&(+s.dirSpreadDeg||0)>=60),dir=vrb?'VRB':pad((((Math.round(+s.windDir/10)*10)%360)||360),3);
    let out=dir+(sp>=100?'P99':pad(sp,2)),g=even(Math.max(0,+s.gustKt||0));
    if(g-sp>=10)out+='G'+(g>=100?'P99':pad(g,2));
    return out+'KT';
  }

  const cloudToken=c=>`${c.cover}${pad(clamp(Math.floor(c.ft/100),0,999),3)}${c.type||''}`;
  function cloudText(s,msaFt=null){const a=selectClouds(s,msaFt);return a.length?a.map(cloudToken).join(' '):'NSC';}
  function encodeFullState(s,msaFt=null){const w=windToken(s);if(cavokEligible(s,msaFt))return`${w} CAVOK`;return[w,visibilityToken(s.visM),cleanWx(weatherToken(s,.5)),cloudText(s,msaFt)].filter(Boolean).join(' ');}

  function windChange(a,b){
    const details=[],as=+a.windKt||0,bs=+b.windKt||0;
    if(Math.abs(bs-as)>=10)details.push('wind-speed');
    if(finite(a.windDir)&&finite(b.windDir)&&circ(a.windDir,b.windDir)>=60&&(as>=10||bs>=10))details.push('wind-direction');
    const ag=num(a.gustKt)&&+a.gustKt-as>=10,bg=num(b.gustKt)&&+b.gustKt-bs>=10;
    if((ag!==bg||Math.abs((+b.gustKt||bs)-(+a.gustKt||as))>=10)&&(as>=15||bs>=15))details.push('wind-gust');
    return details;
  }

  function cloudCategory(s){const c=finite(s.ceilingFt)?s.ceilingFt:Infinity;return band(c,CEIL_THRESH,true);}
  function lowOperationalBkn(s){return (s.clouds||[]).some(c=>!c.type&&(c.cover==='BKN'||c.cover==='OVC')&&c.ft<1500);}
  function convectiveSignature(s){return (s.clouds||[]).filter(c=>c.type==='CB'||c.type==='TCU').sort((a,b)=>a.ft-b.ft).map(c=>`${c.type}:${band(c.ft,CEIL,true)}:${c.cover}`).join('|');}
  function weatherSignificantChange(a,b){
    const A=wxFamily(weatherToken(a,.5)),B=wxFamily(weatherToken(b,.5));if(A===B)return false;
    const sig=new Set(['FZPRECIP','MODHEAVYPRECIP','TS','DRIFT','BLOW','SQ','FC']);
    return sig.has(A)||sig.has(B);
  }

  function significantFields(a,b){
    const fields=[],details={wind:windChange(a,b),clouds:[]};
    if(details.wind.length)fields.push('wind');
    if(band(a.visM,VIS_THRESH)!==band(b.visM,VIS_THRESH))fields.push('visibility');
    if(cloudCategory(a)!==cloudCategory(b))details.clouds.push('cloud-ceiling');
    if(lowOperationalBkn(a)!==lowOperationalBkn(b))details.clouds.push('cloud-amount');
    if(convectiveSignature(a)!==convectiveSignature(b))details.clouds.push('cloud-convective');
    if(details.clouds.length)fields.push('clouds');
    if(weatherSignificantChange(a,b))fields.push('weather');
    return{fields,details};
  }

  function sameOperationalState(a,b){return significantFields(a,b).fields.length===0&&wxFamily(weatherToken(a,.5))===wxFamily(weatherToken(b,.5));}
  function fogFamily(s,threshold=.5){const f=wxFamily(weatherToken(s,threshold));return f==='FG'||f==='BR'?f:'NONE';}

  function baseState(states){
    const z=states.slice(0,Math.min(3,states.length)),s={...z[0]};
    const ww=z.map(()=>1);
    s.windKt=mean(z.map((x,i)=>x.windKt*ww[i]))/mean(ww);
    let u=0,v=0,d=0;for(let i=0;i<z.length;i++)if(finite(z[i].windDir)){const r=z[i].windDir*Math.PI/180,k=Math.max(1,z[i].windKt)*ww[i];u+=Math.sin(r)*k;v+=Math.cos(r)*k;d+=k;}
    s.windDir=d?(Math.atan2(u,v)*180/Math.PI+360)%360:z[0].windDir;
    s.gustKt=quantile(z.map(x=>x.gustKt),.6);
    s.dirSpreadDeg=Math.max(...z.map(x=>finite(x.windDir)?circ(x.windDir,s.windDir):0));
    s.visM=quantile(z.map(x=>x.visM),.45);
    s.prob={...z[0].prob};for(const k of Object.keys(s.prob))if(k!=='alt')s.prob[k]=mean(z.map(x=>x.prob?.[k]).filter(finite));
    s.prob.alt={fgM:Math.round(mean(z.map(x=>x.prob?.alt?.fgM).filter(finite))||800),brM:Math.round(mean(z.map(x=>x.prob?.alt?.brM).filter(finite))||4000)};
    s.RR=mean(z.map(x=>x.RR).filter(finite));
    // Do not average cloud geometry: use the first representative state so ceiling/layers remain internally coherent.
    s.clouds=z[0].clouds;s.ceilingFt=z[0].ceilingFt;
    if(states.some(x=>x.periodVrbDominant)){
      const allCalm=states.every(x=>(+x.windKt||0)<1);
      s.windKt=allCalm?0:2;s.windDir=null;s.gustKt=s.windKt;s.dirSpreadDeg=180;s.forceVrb=!allCalm;s.periodVrbDominant=true;
    }
    return s;
  }

  function changeConfidence(target,fields){
    const p=target.prob||{};
    let c=.65;
    if(fields.includes('visibility'))c=Math.max(p.lowVis||0,p.fg||0,p.br||0);
    if(fields.includes('weather'))c=Math.max(c,p.ts||0,p.moderateHeavyPrecip||0,p.frozen||0,p.fg||0,p.br||0);
    if(fields.includes('clouds'))c=Math.max(c,p.lowCeiling||0,(convectiveSignature(target)?p.ts||0:0));
    if(fields.includes('wind')){
      const x=weightedShare(target.sourceRow,m=>num(m.ws)&&Math.abs(+m.ws*KT-(target.windKt||0))<5);if(finite(x))c=Math.max(c,x);
    }
    return clamp(c,0,1);
  }

  function mergePrevailing(prev,target,fields){
    const x={...prev,prob:{...(prev.prob||{})}};
    if(fields.includes('wind'))Object.assign(x,{windKt:target.windKt,windDir:target.windDir,gustKt:target.gustKt,dirSpreadDeg:target.dirSpreadDeg});
    if(fields.includes('visibility'))x.visM=target.visM;
    if(fields.includes('clouds'))Object.assign(x,{clouds:target.clouds,ceilingFt:target.ceilingFt});
    if(fields.includes('weather'))Object.assign(x,{prob:target.prob,RR:target.RR,T:target.T,visM:target.visM});
    return x;
  }

  function payload(prev,target,fields,kind,msaFt){
    if(kind==='FM')return encodeFullState(target,msaFt);
    const out=[];
    if(fields.includes('wind'))out.push(windToken(target));
    if(fields.includes('visibility'))out.push(visibilityToken(target.visM));
    const oldWx=cleanWx(weatherToken(prev,.5)),newWx=cleanWx(weatherToken(target,.5));
    if(fields.includes('weather')){
      if(newWx)out.push(newWx);
      else if(oldWx)out.push('NSW');
    } else if((fields.includes('visibility')||kind.startsWith('PROB30'))&&newWx)out.push(newWx);
    if(fields.includes('clouds')){
      const cs=selectClouds(target,msaFt);if(cs.length)out.push(...cs.map(cloudToken));else if(!cavokEligible(target,msaFt))out.push('NSC');
    } else if(fields.includes('weather')&&!selectClouds(target,msaFt).length&&!cavokEligible(target,msaFt))out.push('NSC');
    if(kind==='BECMG'&&cavokEligible(target,msaFt)&&(fields.includes('visibility')||fields.includes('weather')||fields.includes('clouds')))return[fields.includes('wind')?windToken(target):'','CAVOK'].filter(Boolean).join(' ');
    return[...new Set(out.filter(Boolean))].join(' ');
  }

  function alternativeFogState(prev,target){
    const p=target.prob||{},x={...target,prob:{...p}};
    if(p.fg>=.30&&p.fg>=p.br){x.visM=clamp(p.alt?.fgM||800,100,900);x.prob.fg=Math.max(.5,p.fg);x.prob.br=0;x.prob.fog=Math.max(x.prob.fog||0,x.prob.fg);return x;}
    if(p.br>=.30){x.visM=clamp(p.alt?.brM||4000,1000,5000);x.prob.br=Math.max(.5,p.br);x.prob.fg=0;x.prob.fog=Math.max(x.prob.fog||0,x.prob.br);return x;}
    return target;
  }

  function twoHourWindow(t,start,end){
    let s=Math.max(start,t-HOUR),e=Math.min(end,t+HOUR);
    if(e-s<2*HOUR){if(s===start)e=Math.min(end,s+2*HOUR);else if(e===end)s=Math.max(start,e-2*HOUR);}
    return{s,e};
  }

  function persistenceFrom(states,i,target){
    let n=1;for(let j=i+1;j<states.length;j++){if(!sameOperationalState(states[j],target))break;n++;}return n;
  }

  function returnsTo(states,i,prev){
    for(let j=i+1;j<=Math.min(states.length-1,i+2);j++)if(sameOperationalState(states[j],prev))return j-i;
    return 0;
  }

  function tempoAllowed(prev,target,fields){
    const pf=fogFamily(prev,.5),tf=fogFamily(target,.5);
    if((tf==='FG'||tf==='BR')&&tf!==pf)return false; // 3.11.6b: fluctuation only, not onset.
    if(fields.includes('clouds')){
      const conv=convectiveSignature(target)!==convectiveSignature(prev);
      if(!conv&&lowOperationalBkn(prev)!==lowOperationalBkn(target))return false; // 3.11.6c: no onset of ordinary Stratus layer via TEMPO.
    }
    return true;
  }

  function overlaps(a,b){return a.s<b.e&&b.s<a.e;}
  function sameFields(a,b){return a.length===b.length&&a.every(x=>b.includes(x));}
  function conflicts(groups,g){return groups.some(x=>overlaps(x,g)&&x.fields.some(f=>g.fields.includes(f)));}

  function buildChangeGroups(states,base,start,end,msaFt){
    const groups=[],reasons=[],skipped=[];let prevailing=base;
    for(let i=1;i<states.length&&groups.length<MAX_GROUPS;i++){
      let target=states[i],sig=significantFields(prevailing,target),fields=sig.fields;
      const prevFog=fogFamily(prevailing,.5),targetFog=fogFamily(target,.5);
      const fogAltProb=Math.max(target.prob?.fg||0,target.prob?.br||0);
      const altFogFamily=(target.prob?.fg||0)>=.30&&(target.prob?.fg||0)>=(target.prob?.br||0)?'FG':(target.prob?.br||0)>=.30?'BR':'NONE';
      const newFog=targetFog!=='NONE'&&targetFog!==prevFog;
      const newFogAlternative=altFogFamily!=='NONE'&&altFogFamily!==prevFog;

      // FOG is an independent input. Do not discard a 30–49% FG/BR signal merely because the deterministic VIS/cloud/wind state did not cross a threshold first.
      if(newFogAlternative&&fogAltProb>=.30&&fogAltProb<.50){
        target=alternativeFogState(prevailing,target);fields=[...new Set([...fields,'visibility'])];
        const w=twoHourWindow(target.t,start,end),g={kind:'PROB30',s:w.s,e:w.e,fields,payload:payload(prevailing,target,fields,'PROB30',msaFt),probability:fogAltProb};
        if(g.payload&&!conflicts(groups,g)){g.text=`PROB30 ${period(g.s,g.e)} ${g.payload}`;groups.push(g);reasons.push(`${g.text}: alternatywne FG/BR ${Math.round(fogAltProb*100)}%; TEMPO nie może służyć do prognozowania pojawienia się mgły/zamglenia.`);}continue;
      }

      if(!fields.length)continue;
      let confidence=changeConfidence(target,fields),persist=persistenceFrom(states,i,target),returnH=returnsTo(states,i,prevailing);
      if(confidence<.30){skipped.push(`${code(target.t)} UTC: zmiana <30% (${Math.round(confidence*100)}%).`);continue;}
      let kind=null,s=null,e=null;
      const precise=target.sourceRow?.preciseTiming===true||target.sourceRow?.preciseFm===true;

      if(confidence<.50){
        kind='PROB30';const w=twoHourWindow(target.t,start,end);s=w.s;e=w.e;
      }else if(newFog){
        // Ordinary FG/BR onset/cessation must not be introduced by TEMPO.
        if(precise){kind='FM';s=target.t;e=target.t;}
        else if(persist>=2){kind='BECMG';s=Math.max(start,target.t-HOUR);e=Math.min(end,s+2*HOUR);}
        else {skipped.push(`${code(target.t)} UTC: krótkie nowe ${targetFog} >=50% pominięto — TEMPO nie może prognozować jego wystąpienia, a brak podstaw do BECMG/FM.`);continue;}
      }else if(returnH){
        if(!tempoAllowed(prevailing,target,fields)){skipped.push(`${code(target.t)} UTC: zmiana chwilowa odrzucona przez ograniczenia TEMPO z instrukcji.`);continue;}
        kind='TEMPO';s=target.t;e=Math.min(end,target.t+Math.max(2*HOUR,returnH*HOUR));
      }else if(persist>=2){
        kind=precise?'FM':'BECMG';
        if(kind==='FM'){s=target.t;e=target.t;}else{s=Math.max(start,target.t-HOUR);e=Math.min(end,s+2*HOUR);}
      }else{
        // No persistence evidence: do not invent a lasting BECMG from the last isolated hour.
        skipped.push(`${code(target.t)} UTC: brak potwierdzenia trwałości zmiany — nie utworzono BECMG.`);continue;
      }

      const g={kind,s,e,fields,payload:payload(prevailing,target,fields,kind,msaFt),probability:confidence};
      if(!g.payload)continue;
      if(kind==='FM')g.text=`FM${code(s,true)} ${g.payload}`;else g.text=`${kind} ${period(s,e)} ${g.payload}`;
      if(conflicts(groups,g)){skipped.push(`${code(target.t)} UTC: pominięto nakładającą się grupę dla tego samego parametru.`);continue;}
      groups.push(g);reasons.push(`${g.text}: ${fields.join(', ')}; pewność ${Math.round(confidence*100)}%.`);
      if(kind==='BECMG'||kind==='FM')prevailing=mergePrevailing(prevailing,target,fields);
    }

    // Merge adjacent identical PROB30 windows and identical TEMPO windows without creating duplicate parameter groups.
    groups.sort((a,b)=>a.s-b.s||a.e-b.e);
    const merged=[];
    for(const g of groups){const last=merged.at(-1);if(last&&last.kind===g.kind&&last.payload===g.payload&&sameFields(last.fields,g.fields)&&g.kind!=='FM'&&g.s<=last.e){last.e=Math.max(last.e,g.e);last.text=`${last.kind} ${period(last.s,last.e)} ${last.payload}`;last.probability=Math.max(last.probability,g.probability);}else merged.push({...g});}
    return{groups:merged.slice(0,MAX_GROUPS),reasons:[...reasons,...skipped]};
  }

  function normalize(lines){return lines.map(x=>String(x||'').replace(/=/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean).join('\n')+'=';}

  function resolvePeriod(text,ref){
    const m=String(text).match(/\b(\d{4})\/(\d{4})\b/);if(!m)return null;
    const resolve=c=>{const d=+c.slice(0,2),h=+c.slice(2,4),R=new Date(ref),a=[];for(let dm=-1;dm<=1;dm++)a.push(Date.UTC(R.getUTCFullYear(),R.getUTCMonth()+dm,d,h));return a.sort((x,y)=>Math.abs(x-ref)-Math.abs(y-ref))[0];};
    const s=resolve(m[1]);let e=resolve(m[2]);if(e<=s)e+=24*HOUR;return{s,e};
  }

  function validateTaf(taf,{issue,start,end,msaFt=null}={}){
    const errors=[],warnings=[],raw=String(taf||'').trim(),text=raw.replace(/\s+/g,' ');
    if(!/^TAF(?:\s+(?:AMD|COR))?\s+[A-Z]{4}\s+\d{6}Z\s+\d{4}\/\d{4}\b/.test(text))errors.push('Nieprawidłowy nagłówek/okres TAF.');
    if(/\bPROB40\b/.test(text))errors.push('PROB40 jest zabronione w SZ RP.');
    if(/\bVV(?:\d{3}|\/{3})\b/.test(text))errors.push('VV nie jest prognozowane w TAF SZ RP.');
    if(/\b(?:MI|BC|PR)FG\b/.test(text))errors.push('MI/BC/PR FG nie są prognozowane w TAF SZ RP.');
    if(finite(start)&&finite(end)&&Math.abs((end-start)/HOUR-12)>1e-6)errors.push('Okres ważności nie wynosi 12 h.');
    if(finite(issue)&&finite(start)&&Math.abs((start-issue)/HOUR-1)>1/60)errors.push('Regularny TAF musi być wydany 1 h przed początkiem ważności.');
    const count=(text.match(/\b(?:BECMG|TEMPO|FM\d{6}|PROB30(?:\s+TEMPO)?)\b/g)||[]).length;if(count>MAX_GROUPS)errors.push(`Liczba grup zmian ${count} > ${MAX_GROUPS}.`);
    const lines=raw.replace(/\s+(?=(?:BECMG|TEMPO|PROB30(?:\s+TEMPO)?|FM\d{6})\b)/g,'\n').split(/\n+/).map(x=>x.trim().replace(/=$/,''));
    let prevailingFog='NONE';
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(/^BECMG\b/.test(line)){const p=resolvePeriod(line,issue||start||Date.now());if(p){const h=(p.e-p.s)/HOUR;if(h>4)errors.push(`BECMG ${h} h > 4 h.`);else if(h>2)warnings.push(`BECMG ${h} h > zalecane 2 h.`);}}
      if(/^TEMPO\b/.test(line)){
        const wx=(line.match(/\b(?:FZFG|FG|BR)\b/)||[])[0]||'NONE';
        if((wx==='FG'||wx==='FZFG')&&prevailingFog!=='FG')errors.push(`TEMPO nie może prognozować pojawienia się FG: ${line}`);
        if(wx==='BR'&&prevailingFog!=='BR')errors.push(`TEMPO nie może prognozować pojawienia się BR: ${line}`);
      }
      if(/^FM\d{6}\b/.test(line)){
        const b=line.replace(/^FM\d{6}\s+/,'');const w=/\b(?:VRB|\d{3})(?:P99|\d{2,3})(?:G(?:P99|\d{2,3}))?KT\b/.test(b),c=/\bCAVOK\b/.test(b),v=/\b(?:9999|\d{4})\b/.test(b),cl=/\b(?:NSC|(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)?)\b/.test(b);if(!w||(!c&&(!v||!cl)))errors.push(`FM musi zawierać pełny opis: ${line}`);
      }
      if(/\bCAVOK\b/.test(line)){
        const b=line.replace(/^TAF(?:\s+(?:AMD|COR))?\s+[A-Z]{4}\s+\d{6}Z\s+\d{4}\/\d{4}\s+/,'').replace(/^(?:BECMG|TEMPO|PROB30(?:\s+TEMPO)?)\s+\d{4}\/\d{4}\s+/,'').replace(/^FM\d{6}\s+/,'').replace(/\bCAVOK\b/,'');
        if(/\b(?:9999|(?:FEW|SCT|BKN|OVC)\d{3}|NSC|FG|BR|HZ|RA|DZ|SN|FZRA|FZDZ|TS|TSRA|SHRA|SHSN)\b/.test(b))errors.push(`CAVOK współistnieje z VVVV/WX/chmurami: ${line}`);
      }
      for(const m of line.matchAll(/\b(?:VRB|\d{3})(\d{2,3})(?:G(P99|\d{2,3}))?KT\b/g))if(m[2]&&m[2]!=='P99'&&(+m[2]-+m[1])<10)errors.push(`Poryw ${m[0]} ma różnicę <10 KT.`);
      // update prevailing fog only from main/FM/BECMG, not TEMPO/PROB30
      if(i===0||/^FM/.test(line)||/^BECMG/.test(line)){
        if(/\b(?:FG|FZFG)\b/.test(line))prevailingFog='FG';else if(/\bBR\b/.test(line))prevailingFog='BR';else if(/\bNSW\b|\bCAVOK\b/.test(line))prevailingFog='NONE';
      }
    }
    // One parameter should not be described twice in overlapping change groups.
    const parsed=[];for(const line of lines.slice(1)){if(/^FM/.test(line))continue;const p=resolvePeriod(line,issue||start||Date.now());if(!p)continue;const fields=[];if(/\b(?:VRB|\d{3})\d{2,3}/.test(line))fields.push('wind');if(/\b(?:9999|\d{4})\b/.test(line))fields.push('visibility');if(/\b(?:FG|FZFG|BR|RA|DZ|SN|TS|SHRA|FZRA|NSW)\b/.test(line))fields.push('weather');if(/\b(?:NSC|FEW|SCT|BKN|OVC)\d{0,3}/.test(line))fields.push('clouds');parsed.push({line,...p,fields});}
    for(let i=0;i<parsed.length;i++)for(let j=i+1;j<parsed.length;j++)if(parsed[i].s<parsed[j].e&&parsed[j].s<parsed[i].e&&parsed[i].fields.some(f=>parsed[j].fields.includes(f)))warnings.push(`Nakładające się grupy opisują ten sam parametr: ${parsed[i].line} / ${parsed[j].line}`);
    const eq=(raw.match(/=/g)||[]).length;if(eq!==1||!raw.endsWith('='))errors.push('TAF musi mieć dokładnie jeden = na końcu.');
    return{ok:!errors.length,errors,warnings,changeGroups:count,authority:AUTH,msaFt:num(msaFt)?+msaFt:null};
  }

  function createEngine(options={}){
    const config={station:'EPIR',...(options.config||{})};
    return Object.freeze({
      version:VERSION,rules:RULES,
      generate(input={}){
        const station=String(input.station||config.station||'EPIR').toUpperCase(),issue=+input.issue,start=+input.start,end=+input.end;
        if(!finite(issue)||!finite(start)||!finite(end)||Math.abs((end-start)/HOUR-12)>1e-6)throw Error('Instrukcja TAF: okres ważności musi wynosić 12 h');
        const raw=(input.rows||[]).filter(r=>num(r?.t)&&+r.t>=start&&+r.t<end).sort((a,b)=>+a.t-+b.t);if(raw.length<8)throw Error(`Za mało danych godzinowych: ${raw.length}`);
        const anchored=input.rowsAlreadyAnchored?raw.map(r=>({...r})):anchorRows(raw,input.observation,start);
        const msa=num(input.msaFt)&&+input.msaFt>0?+input.msaFt:null;
        let states=anchored.map(stateFromRow);states=applyWindPolicy(states);
        const base=baseState(states),cg=buildChangeGroups(states,base,start,end,msa);
        const taf=normalize([`TAF ${station} ${code(issue,true)}Z ${period(start,end)} ${encodeFullState(base,msa)}`,...cg.groups.map(g=>g.text)]);
        const checks=validateTaf(taf,{issue,start,end,msaFt:msa});
        if(!checks.ok){const e=Error('TAF odrzucony przez nadrzędną kontrolę instrukcji: '+checks.errors.join(' | '));e.validation=checks;throw e;}
        const hourly=states.map(s=>{
          const selected=selectClouds(s,msa),cav=cavokEligible(s,msa);
          return {...s,tafDisplay:{wind:windToken(s),visibility:visibilityToken(s.visM),weather:cleanWx(weatherToken(s,.5)),clouds:cav?'CAVOK':(selected.length?selected.map(cloudToken).join(' '):'NSC'),cloudLayers:selected.map(c=>({cover:c.cover,type:c.type||'',m:Math.round(c.ft/FT/10)*10,ft:Math.floor(c.ft/100)*100})),ceilingM:finite(s.ceilingFt)?Math.round((s.ceilingFt/FT)/10)*10:null,cavok:cav}};
        });
        const maxModels=Math.max(0,...states.map(s=>s.sourceRow?.mv?.length||0));
        return {
          version:VERSION,name:NAME,authority:AUTH,taf,
          base:{state:base,text:encodeFullState(base,msa)},groups:cg.groups,hourly,
          checks:{...checks,noProb40:!taf.includes('PROB40'),noVV:!/\bVV/.test(taf),max5:cg.groups.length<=5,periodHours:12,instructionLocked:true},
          confidence:clamp(Math.round(70+Math.min(20,maxModels*2)+(checks.ok?10:0)),0,100),
          diagnostics:{instructionLocked:true,authority:AUTH,reasons:cg.reasons,msaMode:msa?'explicit':'fallback',msaFt:msa||NSC_FT,cloudPipeline:'profile→METAR credibility gate→instruction layer order→ceiling→TAF/table',windPolicy:'VRB02: 75%/12h dominant or sustained >=3h hourly; weak-direction change alone never creates BECMG',legacyMutators:false},
          learning:{cells:0,note:'Uczenie może zmieniać estymację meteorologiczną, nigdy reguły instrukcji.'}
        };
      },
      validate:(taf,meta)=>validateTaf(taf,meta),
      helpers:Object.freeze({windToken,visibilityToken,weatherToken,cleanWxToken:cleanWx,selectedClouds:selectClouds,cavokEligible,significantFields,encodeFullState,stateFromRow,cloudCandidates,profileCloudCandidates,cloudCandidateCredible,applyWindPolicy,tempoAllowed,fogFamily})
    });
  }

  return Object.freeze({ENGINE_VERSION:VERSION,ENGINE_NAME:NAME,INSTRUCTION:AUTH,RULES,createEngine,validateTaf,helpers:Object.freeze({windToken,visibilityToken,weatherToken,cleanWxToken:cleanWx,selectedClouds:selectClouds,cavokEligible,significantFields,encodeFullState,stateFromRow,cloudCandidates,profileCloudCandidates,cloudCandidateCredible,applyWindPolicy,tempoAllowed,fogFamily})});
});
