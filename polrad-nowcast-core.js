'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRPolradNowcastCore=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const VERSION='2026.09.20-1';
  const BOUNDS=Object.freeze({south:48.5,west:13.5,north:56.0,east:25.0});
  const GRID_STEP_KM=4;
  const GRID_RADIUS_KM=160;
  const GRID_N=Math.floor(GRID_RADIUS_KM*2/GRID_STEP_KM)+1;
  const CENTER_I=Math.floor(GRID_N/2);
  const SEARCH_SHIFT=6;
  const HORIZONS_MIN=Object.freeze([30,60,90,120,180]);
  const MAX_FRAME_AGE_MIN=25;
  const ECHO_THRESHOLD_DBZ=27;
  const CONVECTIVE_THRESHOLD_DBZ=40;

  const finite=Number.isFinite;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const prob=v=>!finite(Number(v))?0:(Number(v)>1?clamp(Number(v)/100,0,1):clamp(Number(v),0,1));

  function hsv(r,g,b){
    r/=255;g/=255;b/=255;
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
    let h=0;
    if(d){
      if(mx===r)h=60*(((g-b)/d)%6);
      else if(mx===g)h=60*((b-r)/d+2);
      else h=60*((r-g)/d+4);
    }
    if(h<0)h+=360;
    return {h,s:mx?d/mx:0,v:mx};
  }

  // Decoder intentionally uses broad POLRAD CMAX colour bins. The result is
  // suitable for thresholding/tracking, not for claiming instrument precision.
  function decodeCmax(r,g,b,a=255){
    if(a<45)return null;
    const q=hsv(r,g,b),h=q.h,s=q.s,v=q.v;
    if(s<.28||v<.15)return null;
    if(h>=225&&h<285){if(v<.34)return 8;if(v<.50)return 14;if(v<.68)return 20;return 27;}
    if(h>=195&&h<225)return 30;
    if(h>=165&&h<195)return 34;
    if(h>=90&&h<165)return 38;
    if(h>=55&&h<90)return 41;
    if(h>=35&&h<55)return 44;
    if(h>=18&&h<35)return 47;
    if(h<18||h>=350)return 52;
    if(h>=285&&h<350)return 58;
    return null;
  }

  function mercY(lat){
    const p=clamp(Number(lat),-85,85)*Math.PI/180;
    return Math.log(Math.tan(Math.PI/4+p/2));
  }
  const MY_N=mercY(BOUNDS.north),MY_S=mercY(BOUNDS.south);

  function pixelForLatLon(raster,lat,lon){
    return {
      x:(Number(lon)-BOUNDS.west)/(BOUNDS.east-BOUNDS.west)*(raster.width-1),
      y:(MY_N-mercY(Number(lat)))/(MY_N-MY_S)*(raster.height-1)
    };
  }

  function valueAtLatLon(raster,lat,lon){
    if(!raster?.rgba||!finite(Number(raster.width))||!finite(Number(raster.height)))return null;
    const p=pixelForLatLon(raster,lat,lon),cx=Math.round(p.x),cy=Math.round(p.y);
    if(cx<0||cy<0||cx>=raster.width||cy>=raster.height)return null;
    let best=null;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const x=cx+dx,y=cy+dy;
      if(x<0||y<0||x>=raster.width||y>=raster.height)continue;
      const i=(y*raster.width+x)*4;
      const v=decodeCmax(raster.rgba[i],raster.rgba[i+1],raster.rgba[i+2],raster.rgba[i+3]);
      if(finite(v)&&(best===null||v>best))best=v;
    }
    return best;
  }

  function bearingFromVector(east,north){return (Math.atan2(east,north)*180/Math.PI+360)%360;}
  function compass16(deg){
    const d=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return d[Math.round((((Number(deg)||0)%360)+360)%360/22.5)%16];
  }
  function offsetLatLon(point,eastKm,northKm){
    const lat=Number(point.lat)+northKm/111.32;
    const cos=Math.max(.2,Math.cos(Number(point.lat)*Math.PI/180));
    const lon=Number(point.lon)+eastKm/(111.32*cos);
    return {lat,lon};
  }
  function median(values){
    const a=(values||[]).filter(finite).sort((x,y)=>x-y);
    if(!a.length)return null;
    const m=Math.floor(a.length/2);
    return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }

  function gridForRaster(raster,point){
    const values=new Float32Array(GRID_N*GRID_N),mask=new Uint8Array(GRID_N*GRID_N);
    let active=0,max=0,sum=0;
    for(let gy=0;gy<GRID_N;gy++){
      const north=(gy-CENTER_I)*GRID_STEP_KM;
      for(let gx=0;gx<GRID_N;gx++){
        const east=(gx-CENTER_I)*GRID_STEP_KM,ll=offsetLatLon(point,east,north);
        const v=valueAtLatLon(raster,ll.lat,ll.lon),i=gy*GRID_N+gx;
        if(finite(v)){
          values[i]=v;max=Math.max(max,v);
          if(v>=ECHO_THRESHOLD_DBZ){mask[i]=1;active++;sum+=v;}
        }
      }
    }
    return {time:Number(raster.time),values,mask,active,max,mean:active?sum/active:null};
  }

  function scoreShift(a,b,sx,sy){
    let inter=0,union=0,weighted=0;
    for(let y=SEARCH_SHIFT;y<GRID_N-SEARCH_SHIFT;y++){
      const by=y+sy;if(by<0||by>=GRID_N)continue;
      for(let x=SEARCH_SHIFT;x<GRID_N-SEARCH_SHIFT;x++){
        const bx=x+sx;if(bx<0||bx>=GRID_N)continue;
        const ia=y*GRID_N+x,ib=by*GRID_N+bx,ma=a.mask[ia],mb=b.mask[ib];
        if(!ma&&!mb)continue;
        union++;
        if(ma&&mb){inter++;const va=a.values[ia],vb=b.values[ib];weighted+=Math.min(va,vb)/Math.max(va,vb,1);}
      }
    }
    if(union<10)return -1;
    return .70*(inter/union)+.30*(inter?weighted/inter:0);
  }

  function estimatePair(a,b){
    const dt=(b.time-a.time)/3600;
    if(dt<=0||dt>.40||a.active<10||b.active<10)return null;
    let best=null;
    for(let sy=-SEARCH_SHIFT;sy<=SEARCH_SHIFT;sy++)for(let sx=-SEARCH_SHIFT;sx<=SEARCH_SHIFT;sx++){
      const score=scoreShift(a,b,sx,sy);
      if(score<0)continue;
      if(!best||score>best.score)best={sx,sy,score};
    }
    if(!best||best.score<.12)return null;
    const east=best.sx*GRID_STEP_KM/dt,north=best.sy*GRID_STEP_KM/dt,speed=Math.hypot(east,north);
    if(speed>160)return null;
    return {...best,dt,east,north,speed,bearing:bearingFromVector(east,north)};
  }

  function vectorStats(grids){
    const pairs=[];
    for(let i=0;i+2<grids.length;i++){const p=estimatePair(grids[i],grids[i+2]);if(p)pairs.push(p);}
    if(pairs.length<2)for(let i=0;i+1<grids.length;i++){const p=estimatePair(grids[i],grids[i+1]);if(p)pairs.push(p);}
    if(!pairs.length)return null;
    const good=pairs.slice(-6),east=median(good.map(x=>x.east)),north=median(good.map(x=>x.north));
    const speed=Math.hypot(east,north),bearing=bearingFromVector(east,north),score=median(good.map(x=>x.score));
    const spread=median(good.map(x=>Math.hypot(x.east-east,x.north-north)))||0;
    const consistency=clamp(1-spread/Math.max(25,speed),0,1);
    return {east,north,speed,bearing,score,consistency,pairs:good};
  }

  function regressionTrend(grids){
    const rows=grids.filter(g=>finite(g.mean)&&g.active>=5);
    if(rows.length<3)return {rate:null,label:'brak danych'};
    const t0=rows[0].time,x=rows.map(g=>(g.time-t0)/3600),y=rows.map(g=>g.mean);
    const xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length;
    let num=0,den=0;
    for(let i=0;i<x.length;i++){num+=(x[i]-xm)*(y[i]-ym);den+=(x[i]-xm)**2;}
    const rate=den?num/den:0;
    return {rate,label:rate>3?'nasila się':rate<-3?'słabnie':'stabilne'};
  }

  function nearestEcho(latest,threshold=ECHO_THRESHOLD_DBZ,radiusKm=GRID_RADIUS_KM){
    let best=null;
    for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){
      const i=gy*GRID_N+gx,v=latest.values[i];if(v<threshold)continue;
      const east=(gx-CENTER_I)*GRID_STEP_KM,north=(gy-CENTER_I)*GRID_STEP_KM,d=Math.hypot(east,north);
      if(d>radiusKm)continue;
      if(!best||d<best.distance||(Math.abs(d-best.distance)<1&&v>best.value))best={east,north,distance:d,value:v,bearing:bearingFromVector(east,north)};
    }
    return best;
  }

  function maximumEcho(latest,radiusKm=GRID_RADIUS_KM){
    let best=null;
    for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){
      const i=gy*GRID_N+gx,v=latest.values[i];if(!finite(v)||v<=0)continue;
      const east=(gx-CENTER_I)*GRID_STEP_KM,north=(gy-CENTER_I)*GRID_STEP_KM,d=Math.hypot(east,north);
      if(d>radiusKm)continue;
      if(!best||v>best.value||(v===best.value&&d<best.distance))best={east,north,distance:d,value:v,bearing:bearingFromVector(east,north)};
    }
    return best;
  }

  function approachEcho(latest,vector,threshold=CONVECTIVE_THRESHOLD_DBZ){
    if(!vector||vector.speed<4)return null;
    let best=null;const vsq=vector.east**2+vector.north**2;
    for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){
      const i=gy*GRID_N+gx,v=latest.values[i];if(v<threshold)continue;
      const east=(gx-CENTER_I)*GRID_STEP_KM,north=(gy-CENTER_I)*GRID_STEP_KM;
      const t=-(east*vector.east+north*vector.north)/vsq;
      if(t<-.05||t>3.5)continue;
      const tt=Math.max(0,t),ce=east+vector.east*tt,cn=north+vector.north*tt,cpa=Math.hypot(ce,cn);
      if(cpa>30)continue;
      const candidate={east,north,value:v,tHours:tt,cpa,distance:Math.hypot(east,north),bearing:bearingFromVector(east,north)};
      if(!best||candidate.tHours<best.tHours-.08||(Math.abs(candidate.tHours-best.tHours)<.08&&candidate.cpa<best.cpa)||(Math.abs(candidate.tHours-best.tHours)<.08&&Math.abs(candidate.cpa-best.cpa)<3&&candidate.value>best.value))best=candidate;
    }
    return best;
  }

  function gridSample(latest,east,north){
    const gx=CENTER_I+east/GRID_STEP_KM,gy=CENTER_I+north/GRID_STEP_KM;
    if(gx<1||gy<1||gx>GRID_N-2||gy>GRID_N-2)return null;
    let best=null;
    for(let y=Math.floor(gy)-1;y<=Math.ceil(gy)+1;y++)for(let x=Math.floor(gx)-1;x<=Math.ceil(gx)+1;x++){
      const v=latest.values[y*GRID_N+x];if(finite(v)&&v>0&&(best===null||v>best))best=v;
    }
    return best;
  }

  function advect(latest,vector,trend){
    const out={};
    if(!vector)return out;
    for(const min of HORIZONS_MIN){
      const h=min/60,e=-vector.east*h,n=-vector.north*h;
      let v=gridSample(latest,e,n);
      if(finite(v)&&finite(trend?.rate))v=Math.max(0,v+clamp(trend.rate,-10,10)*h*.65);
      out[min]=finite(v)?v:null;
    }
    return out;
  }

  function confidence(grids,vector,nowMs=Date.now()){
    if(!vector)return 0;
    const newest=grids.at(-1)?.time||0,age=(nowMs/1000-newest)/60;
    const fresh=clamp(1-age/MAX_FRAME_AGE_MIN,0,1),frames=clamp(grids.length/10,0,1),coverage=clamp((grids.at(-1)?.active||0)/90,0,1);
    return Math.round(100*(.42*clamp(vector.score||0,0,1)+.23*clamp(vector.consistency||0,0,1)+.20*fresh+.15*coverage)*frames);
  }

  function analyzeHistory(rasters,point,nowMs=Date.now()){
    const valid=(rasters||[]).filter(r=>r?.rgba&&finite(Number(r.time))).sort((a,b)=>a.time-b.time);
    if(!valid.length)return {error:'brak rastra POLRAD',point};
    const grids=valid.map(r=>gridForRaster(r,point)),latest=grids.at(-1),vector=vectorStats(grids),trend=regressionTrend(grids);
    const nearest=nearestEcho(latest),nearestConvective=nearestEcho(latest,CONVECTIVE_THRESHOLD_DBZ),maximum=maximumEcho(latest),approach=approachEcho(latest,vector),predictions=advect(latest,vector,trend),conf=confidence(grids,vector,nowMs);
    const ageMin=Math.max(0,(nowMs/1000-latest.time)/60);
    return {
      version:VERSION,updatedAt:new Date(nowMs).toISOString(),point:{lat:Number(point.lat),lon:Number(point.lon)},
      frames:grids.length,frameStart:grids[0].time,frameEnd:latest.time,ageMin,
      vector:vector?{eastKmh:vector.east,northKmh:vector.north,speedKmh:vector.speed,bearingDeg:vector.bearing,score:vector.score,consistency:vector.consistency}:null,
      confidence:conf,trend,nearest,nearestConvective,maximum,approach,
      etaMin:approach?Math.round(approach.tHours*60):null,predictions,
      stale:ageMin>MAX_FRAME_AGE_MIN
    };
  }

  function profileSingleRaster(raster,point,{thresholdDbz=CONVECTIVE_THRESHOLD_DBZ,maxRadiusKm=100,stepKm=2,radii=[10,25,50,75,100]}={}){
    const radius=clamp(Number(maxRadiusKm)||100,5,160),step=clamp(Number(stepKm)||2,1,5),threshold=clamp(Number(thresholdDbz)||40,5,70);
    let nearest=null,maximum=null;
    const profiles=(radii||[]).map(r=>({radiusKm:Number(r),nearest:null,maximum:null,count:0}));
    for(let north=-radius;north<=radius;north+=step)for(let east=-radius;east<=radius;east+=step){
      const d=Math.hypot(east,north);if(d>radius)continue;
      const ll=offsetLatLon(point,east,north),v=valueAtLatLon(raster,ll.lat,ll.lon);if(!finite(v))continue;
      const candidate={distance:d,bearing:bearingFromVector(east,north),value:v,lat:ll.lat,lon:ll.lon,east,north};
      if(!maximum||v>maximum.value||(v===maximum.value&&d<maximum.distance))maximum=candidate;
      if(v>=threshold&&(!nearest||d<nearest.distance||(Math.abs(d-nearest.distance)<step&&v>nearest.value)))nearest=candidate;
      for(const p of profiles){
        if(d>p.radiusKm)continue;
        if(v>=threshold)p.count++;
        if(!p.maximum||v>p.maximum.value||(v===p.maximum.value&&d<p.maximum.distance))p.maximum=candidate;
        if(v>=threshold&&(!p.nearest||d<p.nearest.distance||(Math.abs(d-p.nearest.distance)<step&&v>p.nearest.value)))p.nearest=candidate;
      }
    }
    return {thresholdDbz:threshold,radiusKm:radius,nearest,maximum,profiles};
  }

  function interpolatedPrediction(nowcast,leadMin){
    const p=nowcast?.predictions||{},lead=Math.max(0,Number(leadMin)||0),keys=HORIZONS_MIN;
    if(lead<=keys[0])return finite(Number(p[keys[0]]))?Number(p[keys[0]]):null;
    if(lead>=keys.at(-1))return finite(Number(p[keys.at(-1)]))?Number(p[keys.at(-1)]):null;
    for(let i=1;i<keys.length;i++)if(lead<=keys[i]){
      const a=keys[i-1],b=keys[i],va=Number(p[a]),vb=Number(p[b]);
      if(finite(va)&&finite(vb))return va+(vb-va)*(lead-a)/(b-a);
      if(finite(va))return va;if(finite(vb))return vb;return null;
    }
    return null;
  }

  // Radar supplies near-term convective evidence, not a categorical thunderstorm
  // diagnosis. Radar-only support is capped below 50%; NWP/other evidence may
  // raise the combined probability above that threshold.
  function radarStormSupport(nowcast,leadMin){
    if(!nowcast||nowcast.error||nowcast.stale||Number(nowcast.ageMin)>MAX_FRAME_AGE_MIN)return 0;
    const lead=Number(leadMin);if(!finite(lead)||lead<0||lead>180)return 0;
    let dbz=interpolatedPrediction(nowcast,lead);
    const conf=clamp(Number(nowcast.confidence)||0,0,100);
    const nearest=nowcast.nearestConvective;
    if(!finite(dbz)&&nearest&&nearest.distance<=25&&lead<=60)dbz=nearest.value;
    if(!finite(dbz))return 0;
    let support=dbz>=55?.49:dbz>=50?.46:dbz>=45?.40:dbz>=40?.30:dbz>=35?.12:0;
    if(!support)return 0;
    const q=clamp(.55+conf/180,.55,1);
    support*=q;
    const eta=Number(nowcast.etaMin),cpa=Number(nowcast?.approach?.cpa);
    if(finite(eta)&&finite(cpa)&&cpa<=20&&Math.abs(lead-eta)<=45)support=Math.max(support,dbz>=50?.46:dbz>=45?.40:.30)*q;
    return clamp(support,0,.49);
  }

  function enhanceInput(input,nowcast){
    const frameMs=finite(Number(nowcast?.frameEnd))?Number(nowcast.frameEnd)*1000:Date.now();
    let changed=0,maxRadar=0;
    const rows=(input?.rows||[]).map(src=>{
      const t=Number(src?.t),leadMin=finite(t)?(t-frameMs)/60000:NaN,radar=radarStormSupport(nowcast,leadMin),base=prob(src?.storm);
      if(radar<=0)return {...src};
      const combined=clamp(1-(1-base)*(1-radar),0,.95);
      if(combined>base+.005)changed++;
      maxRadar=Math.max(maxRadar,radar);
      return {...src,storm:Math.max(base,combined),polradNowcast:{leadMin,baseStorm:base,radarSupport:radar,combinedStorm:Math.max(base,combined),frameEnd:nowcast.frameEnd,confidence:nowcast.confidence,etaMin:nowcast.etaMin,maxDbz:nowcast.maximum?.value??null,approachDbz:nowcast.approach?.value??null}};
    });
    return {...input,rows,polradNowcastMeta:{version:VERSION,changedRows:changed,maxRadarSupport:maxRadar,frameEnd:nowcast?.frameEnd??null,ageMin:nowcast?.ageMin??null,confidence:nowcast?.confidence??0,etaMin:nowcast?.etaMin??null,stale:!!nowcast?.stale,error:nowcast?.error||null}};
  }

  return Object.freeze({
    VERSION,BOUNDS,GRID_STEP_KM,GRID_RADIUS_KM,HORIZONS_MIN,MAX_FRAME_AGE_MIN,ECHO_THRESHOLD_DBZ,CONVECTIVE_THRESHOLD_DBZ,
    decodeCmax,pixelForLatLon,valueAtLatLon,offsetLatLon,bearingFromVector,compass16,gridForRaster,analyzeHistory,profileSingleRaster,radarStormSupport,enhanceInput
  });
});
