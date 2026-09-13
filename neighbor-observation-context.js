/* PrognozaEPIR neighbor observation context.
 * Reads only the GitHub MessageArchive context snapshot and applies a bounded,
 * short-range upwind observation anchor to the multimodel consensus.
 */
'use strict';
(() => {
  const EPIR={lat:52.7989,lon:18.2639};
  const FALLBACK_META={
    EPBY:{name:'Bydgoszcz',lat:53.0968,lon:17.9777},
    EPPW:{name:'Powidz',lat:52.3792,lon:17.8539},
    EPKS:{name:'Krzesiny',lat:52.3317,lon:16.9664}
  };
  const MAX_AGE_H=3.0, MAX_WEIGHT=.35;
  // Fixed local EPIR correction for the persistent clockwise bias of the
  // multimodel wind-direction blend in the SSW-SW sector. Direction only;
  // speed/gust are left untouched. Do not correct weak/unstable flow.
  const HARD_WIND_DIR={from:190,to:235,offset:-25,minSpeedMs:1.5};
  let snapshot=null,lastLoaded=0;
  const finite=Number.isFinite,rad=x=>x*Math.PI/180,deg=x=>(x*180/Math.PI+360)%360;
  function circular(a,b){let x=Math.abs((a||0)-(b||0))%360;return x>180?360-x:x}
  function geo(a,b){
    const p1=rad(a.lat),p2=rad(b.lat),dl=rad(b.lon-a.lon),dp=rad(b.lat-a.lat);
    const q=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    const km=6371*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));
    const y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    return{km,bearing:deg(Math.atan2(y,x))};
  }
  function uv(s,d){const r=rad(d||0);return{u:-(s||0)*Math.sin(r),v:-(s||0)*Math.cos(r)}}
  function sd(u,v){return{speed:Math.hypot(u,v),dir:deg(Math.atan2(-u,-v))}}
  function blend(a,b,w){return finite(a)&&finite(b)?a*(1-w)+b*w:(finite(a)?a:b)}
  function coverOkta(c){return c==='FEW'?2:c==='SCT'?4:c==='BKN'?6:(c==='OVC'||c==='VV')?8:null}
  function timeOf(row){const t=Date.parse(row?.message_time||row?.obs_time||'');return finite(t)?t:NaN}
  function metaFor(id){return snapshot?.stations_meta?.[id]||FALLBACK_META[id]||null}
  function normDir(value){const d=Number(value);return finite(d)?((d%360)+360)%360:NaN}
  function applyHardWindDirection(z){
    if(!z||!finite(Number(z.WS)))return z;
    const speed=Number(z.WS),raw=normDir(z.WD);
    if(!finite(raw)||speed<HARD_WIND_DIR.minSpeedMs||raw<HARD_WIND_DIR.from||raw>HARD_WIND_DIR.to)return z;
    return{
      ...z,
      WD:normDir(raw+HARD_WIND_DIR.offset),
      windDirRawDeg:Number(raw.toFixed(1)),
      windDirSectorCorrectionDeg:HARD_WIND_DIR.offset,
      windDirSectorCorrectionRule:`${HARD_WIND_DIR.from}-${HARD_WIND_DIR.to}:${HARD_WIND_DIR.offset}`
    };
  }
  async function refresh(force=false){
    if(!force&&snapshot&&Date.now()-lastLoaded<60e3)return snapshot;
    const A=window.PrognozaEPIRMessageArchive;
    if(!A?.fetchText)throw new Error('MessageArchive nie udostępnia archiwum kontekstowego');
    const text=await A.fetchText('neighbors/latest.json',force);
    const value=JSON.parse(text);
    if(value?.schema!=='prognozaepir-neighbor-observations-latest-v1')throw new Error('Nieprawidłowy snapshot METAR/SPECI sąsiadów');
    snapshot=value;lastLoaded=Date.now();
    return snapshot;
  }
  function candidate(row,z,now){
    const id=row?.station,meta=metaFor(id),ot=timeOf(row);
    if(!meta||!finite(meta.lat)||!finite(meta.lon)||!finite(ot)||!finite(z?.WD)||!finite(z?.WS))return null;
    const ageH=Math.max(0,(now-ot)/36e5);
    if(ageH>MAX_AGE_H||ot>now+30*6e4)return null;
    const g=geo(EPIR,meta),angle=circular(z.WD,g.bearing);
    if(angle>=95)return null;
    let directional=Math.max(0,Math.cos(rad(angle)));directional*=directional;
    const speedKmh=Math.max(12,z.WS*3.6),lag=Math.max(.5,Math.min(8,g.km/speedKmh));
    const lead=Math.max(0,(z.t-now)/36e5),timeMatch=Math.exp(-Math.abs(lead-lag)/2.0);
    const freshness=Math.exp(-ageH/2.7),distance=Math.exp(-g.km/190),calm=z.WS<2?.35:1;
    const score=directional*timeMatch*freshness*distance*calm;
    if(score<.12)return null;
    return{id,row,meta,km:g.km,bearing:g.bearing,angle,lag,ageH,score,weight:Math.min(MAX_WEIGHT,score*.45)};
  }
  function applyOne(z,c){
    const o={...z},r=c.row,w=c.weight;
    for(const [key,src] of [['T','temperature_c'],['Td','dew_point_c'],['RH','relative_humidity_pct']]){
      if(finite(r[src])&&finite(o[key]))o[key]=blend(o[key],r[src],w);
    }
    // METAR 9999/CAVOK is right-censored at >=10 km: never use it to force visibility upward.
    if(finite(r.visibility_m)&&r.visibility_m<10000&&finite(o.VIS))o.VIS=blend(o.VIS,r.visibility_m,w);
    if(finite(r.pressure_hpa)&&finite(o.P))o.P=blend(o.P,r.pressure_hpa,w*.35);
    if(finite(r.wind_speed_ms)&&finite(r.wind_direction_deg)&&finite(o.WS)&&finite(o.WD)){
      const a=uv(o.WS,o.WD),b=uv(r.wind_speed_ms,r.wind_direction_deg),ww=w*.18,q=sd(a.u*(1-ww)+b.u*ww,a.v*(1-ww)+b.v*ww);
      o.WS=q.speed;o.WD=q.dir;
      if(finite(o.G)&&finite(r.wind_gust_ms))o.G=blend(o.G,r.wind_gust_ms,ww);
    }
    const ceilCloud=(r.clouds||[]).find(x=>['BKN','OVC','VV'].includes(x.cover)&&finite(x.base_m_agl));
    if(ceilCloud&&ceilCloud.base_m_agl<2500){
      const cw=w*.85;
      if(finite(o.ceiling))o.ceiling=blend(o.ceiling,ceilCloud.base_m_agl,cw);
      else if(w>=.18)o.ceiling=ceilCloud.base_m_agl;
      if(finite(o.lowH))o.lowH=blend(o.lowH,ceilCloud.base_m_agl,cw);
      else if(w>=.18)o.lowH=ceilCloud.base_m_agl;
      const target=coverOkta(ceilCloud.cover);
      if(finite(target))o.oktaL=finite(o.oktaL)?Math.max(0,Math.min(8,Math.round(blend(o.oktaL,target,cw)))):target;
    }
    o.neighborObsStation=c.id;
    o.neighborObsScore=Math.round(c.score*100);
    o.neighborObsWeightPct=Math.round(w*100);
    o.neighborObsLagH=Number(c.lag.toFixed(1));
    o.neighborObsAgeMin=Math.round(c.ageH*60);
    o.neighborObsWeather=r.weather||null;
    o.neighborObsRaw=r.canonical_raw||r.raw||null;
    return o;
  }
  function applySeries(series){
    if(!Array.isArray(series)||!series.length)return series;
    const now=Date.now(),records=snapshot?.stations?Object.values(snapshot.stations).filter(Boolean):[];
    return series.map(z=>{
      const base=applyHardWindDirection(z);
      if(!records.length)return base;
      const candidates=records.map(r=>candidate(r,base,now)).filter(Boolean).sort((a,b)=>b.score-a.score);
      return candidates.length?applyOne(base,candidates[0]):base;
    });
  }
  function latest(){return snapshot}
  function contextFor(z){
    if(!snapshot?.stations)return[];
    const now=Date.now();
    return Object.values(snapshot.stations).map(r=>candidate(r,z,now)).filter(Boolean).sort((a,b)=>b.score-a.score);
  }
  window.PrognozaEPIRNeighborObservations={refresh,applySeries,latest,contextFor,applyHardWindDirection,hardWindDirectionRule:{...HARD_WIND_DIR},version:'1.1.0'};
})();
