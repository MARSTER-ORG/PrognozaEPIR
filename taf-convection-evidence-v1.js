'use strict';
// TAF 12-hour convection evidence adapter. Never infer CB/TCU/TS from radar reflectivity alone.
// Meteorological evidence is time/point scoped and may never look ahead of the TAF issue.
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root){
    root.PrognozaEPIRTAFConvectionEvidence=api;
    if(/\/radar\.html$/i.test(root.location?.pathname||'')){
      const save=ev=>{
        const r=ev?.detail||root.PrognozaEPIRRadarNowcast;
        if(!r||r.error||!r.point||!Number.isFinite(Number(r.frameEnd)))return;
        const snapshot={
          version:1,source:'POLRAD',point:{lat:+r.point.lat,lon:+r.point.lon},
          updatedAt:r.updatedAt,frameEnd:r.frameEnd,confidence:r.confidence,
          etaMin:r.etaMin,sourceProduct:r.source,
          predictions:r.predictions,models:{support:r.models?.support,total:r.models?.total},
          vectorConsistency:r.vector?.consistency
        };
        try{root.localStorage?.setItem('prognozaepir.taf.radar-evidence.v1',JSON.stringify(snapshot));}catch(_){}
      };
      root.addEventListener?.('prognozaepir:radar-nowcast-updated',save);
      save();
    }
  }
})(typeof window!=='undefined'?window:null,function(){
  const H=3600000;
  const EPIR={lat:52.828611,lon:18.330278};
  const KEYS={forecast:'prognozaepir.convection12h.v1',
    nowcast:'prognozaepir.convection-nowcast.shared.v1',
    radar:'prognozaepir.taf.radar-evidence.v1'};
  const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
  const pct=v=>finite(v)?Math.max(0,Math.min(100,+v)):null;
  function milliseconds(v){
    const x=typeof v==='number'?v:Date.parse(String(v||''));
    return Number.isFinite(x)?(x>1e9&&x<1e11?x*1000:x):NaN;
  }
  function epir(point){
    return point&&finite(point.lat)&&finite(point.lon)&&
      Math.hypot(+point.lat-EPIR.lat,+point.lon-EPIR.lon)<0.015;
  }
  function read(store,key){
    try{return JSON.parse(store?.getItem(key)||'null');}catch(_){return null;}
  }
  function validAge(record,asOf,now,maxAge,pointField='point'){
    if(!record||!epir(record[pointField]))return false;
    const t=milliseconds(record.updatedAt);
    return Number.isFinite(t)&&t<=asOf&&t<=now&&now-t<=maxAge&&now-t>=0;
  }
  function fusion({rows=[],issue,start,end,now=Date.now(),store,live}={}){
    const cutoff=Math.min(+issue||now,now);
    const cache=store||(typeof localStorage!=='undefined'?localStorage:null);
    const forecastLive=live?.PrognozaEPIRConvection12h;
    const forecast=validAge(forecastLive,cutoff,now,2*H)?forecastLive:
      read(cache,KEYS.forecast);
    const forecastOk=validAge(forecast,cutoff,now,2*H)&&Array.isArray(forecast.rows);
    const nowcast=read(cache,KEYS.nowcast);
    const radar=read(cache,KEYS.radar);
    const radarOk=validAge(radar,cutoff,now,45*60000)&&
      Number.isFinite(milliseconds(radar.frameEnd))&&
      milliseconds(radar.frameEnd)<=cutoff&&
      now-milliseconds(radar.frameEnd)<=45*60000&&
      +radar.confidence>=55;
    const nowcastOk=validAge(nowcast,cutoff,now,20*60000);
    const combinedRadar=radarOk&&nowcastOk&&
      (finite(radar.models?.support)&&+radar.models.support>=1);
    const enriched=rows.map(original=>{
      const row={...original},t=+row.t;
      if(!forecastOk||!Number.isFinite(t)||t<start||t>=end)return row;
      const match=forecast.rows.reduce((best,v)=>{
        const diff=Math.abs(milliseconds(v?.time)-t);
        return diff<best.diff?{value:v,diff}:best;
      },{value:null,diff:Infinity});
      if(!match.value||match.diff>35*60000)return row;
      const c=match.value,lead=(t-now)/H;
      const modelCount=finite(c.modelCount)?+c.modelCount:0;
      const agreement=pct(c.modelAgreement)||0;
      const ts=pct(c.tsProbability),tcu=pct(c.tcuProbability),cb=pct(c.cbProbability);
      const modelTsEvidence=modelCount>=2&&agreement>=55&&
        (pct(c.thunderstormProbability)||0)>=30;
      const radarWindow=combinedRadar&&lead>=-0.75&&lead<=3.5&&
        (c.nowcastApplied===true||nowcastOk);
      const prediction=radarWindow&&Object.entries(radar.predictions||{}).some(([minutes,v])=>{
        const h=Number(minutes)/60;
        return Number.isFinite(h)&&Math.abs(h-Math.max(0,lead))<=1.2&&finite(v)&&
          +v>=(radar.sourceProduct==='sri'?.1:27);
      });
      const radarCorroborated=!!prediction&&agreement>=55&&modelCount>=2;
      // TS probability is from independently supplied NWP thermodynamics,
      // not inferred from CB probability or reflectivity.
      if(modelTsEvidence&&ts!==null&&ts>=35)
        row.storm=Math.max(pct(row.storm)||0,ts);
      row.tafConvectiveEvidence={
        source:'GFS+AIFS+ICON-D2',forecastUpdatedAt:forecast.updatedAt,
        tcuProbability:tcu,cbProbability:cb,tsProbability:ts,
        cape:finite(c.cape)?+c.cape:null,
        thunderstormProbability:pct(c.thunderstormProbability),
        rainMmH:finite(c.precipitation)?+c.precipitation:null,
        nwpModels:modelCount,modelAgreement:agreement,
        modelTsEvidence,radarAvailable:radarOk,radarCorroborated,
        radarFrameEnd:radarOk?milliseconds(radar.frameEnd):null,
        radarNowcastAgeMin:radarOk?Math.round((now-milliseconds(radar.frameEnd))/60000):null,
        radarSource:radarOk?radar.sourceProduct:null,
        radarConfidence:radarOk?+radar.confidence:null,
        nowcastApplied:radarCorroborated,
        evidenceOnly:true
      };
      return row;
    });
    return {
      rows:enriched,
      diagnostics:{
        forecastAvailable:forecastOk,radarAvailable:radarOk,
        radarCorroboratedHours:enriched.filter(x=>x.tafConvectiveEvidence?.radarCorroborated).length,
        forecastUpdatedAt:forecastOk?forecast.updatedAt:null,
        radarFrameEnd:radarOk?new Date(milliseconds(radar.frameEnd)).toISOString():null,
        issueCutoff:new Date(cutoff).toISOString(),
        note:'Radar supports only short-term precipitation timing; no automatic CB/TCU classification from dBZ.'
      }
    };
  }
  return Object.freeze({fusion,KEYS,epir});
});
