'use strict';
// Observation-led short-range visibility correction for EPIR TAF.
// Local METAR/SPECI has priority. Neighbor METAR/SPECI and *valid* neighbor
// TAFs support regional persistence assessment but are never copied to EPIR.
// No look-ahead: observations and TAF issue times must be <= min(cycle issue, now).
(function(root,factory){
  const api=factory(root);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFObservationFusion=api;
})(typeof window!=='undefined'?window:null,function(root){
  const H=3600000,STATIONS=['EPBY','EPPW','EPKS'];
  const finite=Number.isFinite,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const number=v=>v===null||v===undefined||v===''?null:finite(+v)?+v:null;
  const rawOf=x=>typeof x==='string'?x:String(x?.raw||x?.canonical_raw||x?.raw_text||'');
  function stationOf(x){
    const raw=rawOf(x).toUpperCase();
    return String(x?.station||x?.station_code||(raw.match(/\b(?:EPIR|EPBY|EPPW|EPKS)\b/)||[])[0]||'').toUpperCase();
  }
  function itemTime(x){
    for(const key of ['obs_time','observed_at','message_time','archive_time','issue_time','issued_at','time','timestamp']){
      const t=Date.parse(x?.[key]||'');
      if(finite(t))return t;
    }
    return NaN;
  }
  function parseMetar(x){
    if(!x)return null;
    const raw=rawOf(x).toUpperCase().replace(/\s+/g,' ');
    const station=stationOf(x),t=itemTime(x);
    if(!finite(t)||!['EPIR',...STATIONS].includes(station))return null;
    const explicit=number(x?.visibility_m);
    const match=raw.match(/\b(?:VRB|\d{3})(?:\d{2}|P99)(?:G(?:\d{2}|P99))?KT(?:\s+\d{3}V\d{3})?\s+(9999|\d{4})\b/);
    const vis=explicit??(match?(match[1]==='9999'?10000:+match[1]):/\bCAVOK\b/.test(raw)?10000:null);
    if(vis===null||vis<0||vis>10000)return null;
    const temps=raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    const de=s=>s?.startsWith('M')?-Number(s.slice(1)):Number(s);
    const tt=number(x?.temperature_c)??(temps?de(temps[1]):null);
    const td=number(x?.dew_point_c)??number(x?.dewpoint_c)??(temps?de(temps[2]):null);
    return {station,t,vis,raw,br:/\bBR\b/.test(raw),fg:/\b(?:FG|FZFG)\b/.test(raw),
      auto:/\bAUTO\b/.test(raw),T:tt,Td:td,
      saturated:tt!==null&&td!==null&&tt-td<=1.5};
  }
  function uniqueObservations(items,station,cutoff,maxAgeH=4){
    const seen=new Set(),out=[];
    for(const x of items||[]){
      const v=parseMetar(x);
      if(!v||v.station!==station||v.t>cutoff||cutoff-v.t>maxAgeH*H)continue;
      const key=v.t+'|'+v.raw;
      if(seen.has(key))continue;seen.add(key);out.push(v);
    }
    return out.sort((a,b)=>b.t-a.t);
  }
  function median(a){const v=a.filter(finite).sort((x,y)=>x-y);return v.length?v[Math.floor((v.length-1)/2)]:null;}
  function lowRiskContext(local){
    const recent=local.filter(x=>local[0].t-x.t<=2*H);
    const low=recent.filter(o=>o.vis<5000),mist=low.filter(o=>o.br||o.fg||o.saturated);
    return {n:recent.length,low:low.length,persistent:low.length>=2&&low.length/recent.length>=.6,
      wet:mist.length>=2,median:median(recent.map(o=>o.vis)),
      improving:recent.length>=2&&local[0].vis-recent.at(-1).vis>=1500};
  }
  function parseTaf(item,forecast,cutoff,validity){
    if(!item||!validity?.validity)return null;
    const info=validity.validity(item,cutoff);
    if(!info||!STATIONS.includes(info.station)||info.issue>cutoff||forecast<info.start||forecast>=info.end)return null;
    const content=info.raw.replace(/=$/,'').replace(/\s+(?=(?:BECMG|TEMPO|PROB30|FM\d{6})\b)/g,'\n').split('\n');
    const body=content[0].replace(/^TAF\s+(?:AMD\s+|COR\s+)?[A-Z]{4}\s+\d{6}Z\s+\d{4}\/\d{4}\s+/,'');
    const visOf=s=>{const m=s.match(/(?:^|\s)(9999|\d{4})(?=\s|$)/);return m?(m[1]==='9999'?10000:+m[1]):/\bCAVOK\b/.test(s)?10000:null;};
    let vis=visOf(body),probLow=false;
    const codeTime=s=>{
      if(!/^\d{4}$/.test(s))return NaN;
      const day=+s.slice(0,2),hour=+s.slice(2);if(day<1||day>31||hour>24)return NaN;
      const d=new Date(info.start),cand=[];
      for(let m=-1;m<=1;m++){
        const base=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+m,day);
        if(new Date(base).getUTCDate()!==day)continue;
        cand.push(base+hour*H);
      }
      return cand.sort((a,b)=>Math.abs(a-info.start)-Math.abs(b-info.start))[0]??NaN;
    };
    for(const g of content.slice(1)){
      const x=g.match(/^(BECMG|PROB30(?: TEMPO)?|TEMPO)\s+(\d{4})\/(\d{4})\s+(.*)$/);
      if(x){
        const start=codeTime(x[2]),end=codeTime(x[3]),v=visOf(x[4]);
        if(!finite(start)||!finite(end))continue;
        if(x[1]==='BECMG'&&end<=forecast&&v!==null)vis=v;
        else if(/^PROB30/.test(x[1])&&forecast>=start&&forecast<end&&v!==null&&v<5000)probLow=true;
      }else if(/^FM\d{6}\b/.test(g)){
        const stamp=g.slice(2,6),minute=+g.slice(6,8);
        const t=codeTime(stamp)+minute*60000;
        if(t<=forecast){const v=visOf(g.slice(8));if(v!==null)vis=v;}
      }
    }
    return {station:info.station,vis,probLow,issue:info.issue,end:info.end};
  }
  function adjust(anchored,{rawRows=[],observations=[],observation=null,neighbors={},issue,start,
    now=Date.now(),tafValidity=null}={}){
    const cutoff=Math.min(+issue,now);
    if(!finite(cutoff))return anchored.map(x=>({...x}));
    const local=uniqueObservations([observation,...observations],'EPIR',cutoff,4);
    const ctx=local.length?lowRiskContext(local):null;
    const neighborData={};
    for(const station of STATIONS){
      const n=neighbors?.[station]||{};
      neighborData[station]=uniqueObservations(n.observations||[],station,cutoff,3);
    }
    const latest=local[0]||null;
    const rows=anchored.map((x,i)=>{
      const z={...x},forecast=+x.t,rawVis=number(rawRows[i]?.VIS)??number(x.VIS);
      if(!finite(forecast)||rawVis===null)return z;
      const regional=STATIONS.map(st=>{
        const n=neighborData[st]?.[0],obsLow=n&&cutoff-n.t<=1.75*H&&n.vis<5000;
        const tafList=(neighbors?.[st]?.tafs||[]).map(t=>parseTaf(t,forecast,cutoff,tafValidity))
          .filter(Boolean).sort((a,b)=>b.issue-a.issue);
        const guidance=tafList[0]||null;
        return {station:st,obsLow:!!obsLow,tafLow:!!(guidance&&guidance.vis!==null&&guidance.vis<5000),
          tafProbLow:!!guidance?.probLow};
      });
      const lowNeighbors=regional.filter(n=>n.obsLow||n.tafLow).length;
      z.tafNeighborEvidence={lowStations:lowNeighbors,stations:regional,
        validTafCount:regional.filter(n=>n.tafLow||n.tafProbLow).length};
      if(!latest)return z;
      const lead=(forecast-latest.t)/H;
      if(lead<0||lead>6)return z;
      const anchorVis=clamp(.8*latest.vis+.2*(ctx?.median??latest.vis),0,10000);
      const persistent=Boolean(ctx?.persistent);
      // Lead-time decay; never freeze a past METAR as a 12-hour forecast.
      const strength=(persistent ? .88 : ((latest.br||latest.fg) ? .78 : .64))*Math.exp(-lead/5);
      const weight=clamp(strength,0,.84);
      let corrected=rawVis*(1-weight)+anchorVis*weight;
      // Recent EPIR observations constrain an unsupported jump to 9-10 km.
      // No permanent 12h anchoring: this constraint lasts at most 3.5h.
      const currentLow=cutoff-latest.t<=2*H&&latest.vis<5000&&
        (latest.br||latest.fg||latest.saturated||persistent);
      const unsupportedClearing=currentLow&&!ctx.improving&&lead<=3.5&&
        rawVis-latest.vis>=1800;
      const visCap=unsupportedClearing?
        clamp(latest.vis+Math.max(0,lead)*240,latest.vis,4900):null;
      if(visCap!==null)corrected=Math.min(corrected,visCap);
      if(latest.vis<5000&&persistent&&!ctx.improving&&lowNeighbors>=2&&lead<=3.25)
        corrected=Math.min(corrected,4900);
      corrected=clamp(corrected,0,10000);
            z.VIS=Math.round(corrected);
      // Observed BR/FG can support near-term nowcasting but not invent a new
      // 12-hour event. AUTO without reported WX is unknown, not negative.
      const wet=latest.saturated||ctx?.wet;
      if(wet&&lead<=3.5&&cutoff-latest.t<=2*H){
        const support=Math.max(0,(persistent ? .78 : .68)*Math.exp(-lead/10));
        if(z.VIS>=1000&&z.VIS<5000&&(latest.br||(!latest.fg&&latest.auto&&latest.vis<5000&&persistent))){
          z.brRisk=Math.max(number(z.brRisk)??0,support);
          // TAF consumes operational scores when available, even if they are 0.
          if(latest.br&&support>=.5){
            z.brOperationalScore=Math.max(number(z.brOperationalScore)??0,80);
            z.brAltVisM=Math.max(1000,Math.min(4900,z.VIS));
          }
        }
        if(z.VIS<1000&&latest.fg&&persistent)
          z.fgRisk=Math.max(number(z.fgRisk)??0,support);
      }
            z.tafVisNowcast={localStation:'EPIR',observationTime:latest.t,observationVisM:latest.vis,
        modelVisM:rawVis,correctedVisM:z.VIS,weight:Number(weight.toFixed(3)),
        persistentLowVisibility:persistent,regionalLowVisibilityStations:lowNeighbors,
        observationCount:ctx?.n??0,leadHours:Number(lead.toFixed(2)),
        unsupportedClearing,visibilityCapM:visCap,observedClearing:!!ctx?.improving,
        forecastBased:true,derivedWeather:latest.br?'BR':latest.fg?'FG':'UNREPORTED'};
      return z;
    });
    rows.tafVisibilityAssimilation={
      localObservations:ctx?.n??0,latestVisibilityM:latest?.vis??null,
      localPersistentLowVisibility:ctx?.persistent||false,
      neighborStations:STATIONS,
      issueTimeCutoff:cutoff,method:'short-range EPIR METAR/SPECI trend + regional TAF/METAR corroboration'
    };
    return rows;
  }
  return Object.freeze({adjust,parseMetar,parseTaf,uniqueObservations,lowRiskContext});
});
