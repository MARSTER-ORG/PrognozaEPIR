'use strict';
(() => {
  if (!/\/radar\.html$/i.test(location.pathname)) return;
  if (window.__epirOperaNowcastLoaded) return;
  window.__epirOperaNowcastLoaded = true;

  // OPERA CIRRUS/NIMBUS: the browser reads GeoTIFF only through the merged
  // central-ingestor CORS/Range proxy. CloudFerro remains upstream server-side.
  const OPERA_PROXY_BASE = 'https://central-ingestor-production.up.railway.app/opera/dbzh';
  const PROJ_OPERA = '+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84 +units=m +no_defs';
  const PROJ_3035 = '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs';
  const PROJ_WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
  const GEOTIFF_JS = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';
  const PROJ4_JS = 'https://cdn.jsdelivr.net/npm/proj4@2.22.0/dist/proj4.js';

  const AUTO_MS = 5 * 60 * 1000;
  const MAX_FRAMES = 7;
  const MAX_CANDIDATES = 18;
  const GRID_STEP_KM = 4;
  const GRID_RADIUS_KM = 160;
  const GRID_N = Math.round(GRID_RADIUS_KM * 2 / GRID_STEP_KM) + 1;
  const CENTER = Math.floor(GRID_N / 2);
  const DBZ_THRESHOLD = 27;
  const SEARCH_SHIFT = 6;
  const MAX_FRAME_AGE_MIN = 35;
  const HORIZONS = [15, 30, 45, 60];
  const QIND_MIN = 0.25;

  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const median = a => {
    const b=a.filter(finite).slice().sort((x,y)=>x-y);
    if(!b.length)return NaN;
    const m=Math.floor(b.length/2);
    return b.length%2?b[m]:(b[m-1]+b[m])/2;
  };
  const circularDiff=(a,b)=>{if(!finite(a)||!finite(b))return NaN;let d=Math.abs(a-b)%360;return d>180?360-d:d};
  const bearingFromVector=(east,north)=>(Math.atan2(east,north)*180/Math.PI+360)%360;
  const compass16=deg=>{
    if(!finite(deg))return '—';
    const n=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return n[Math.round((((deg%360)+360)%360)/22.5)%16];
  };
  const fmtUtcMs=ms=>{
    if(!finite(Number(ms)))return '—';
    const d=new Date(Number(ms));
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  };
  const dbzText=v=>finite(Number(v))?`${Math.round(Number(v))} dBZ`:'—';
  const pad2=n=>String(n).padStart(2,'0');

  let running=false,lastRun=0,latestOpera=null,libPromise=null,operaLayer=null,mapEnabled=false,mapButton=null;

  function currentPoint(){
    try{
      if(typeof point!=='undefined'&&finite(Number(point?.lat))&&finite(Number(point?.lon)))return{lat:Number(point.lat),lon:Number(point.lon)};
    }catch(_){}
    const lat=Number(String($('lat')?.value||'').replace(',','.')),lon=Number(String($('lon')?.value||'').replace(',','.'));
    return finite(lat)&&finite(lon)?{lat,lon}:null;
  }

  function addScript(src,test){
    if(test())return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const s=document.createElement('script');s.src=src;s.async=true;s.crossOrigin='anonymous';
      s.onload=()=>test()?resolve():reject(new Error('biblioteka nie udostępniła API'));
      s.onerror=()=>reject(new Error('nie udało się pobrać biblioteki'));
      document.head.appendChild(s);
    });
  }
  function ensureLibraries(){
    if(libPromise)return libPromise;
    libPromise=Promise.all([
      addScript(GEOTIFF_JS,()=>!!window.GeoTIFF?.fromUrl&&!!window.GeoTIFF?.fromArrayBuffer),
      addScript(PROJ4_JS,()=>typeof window.proj4==='function')
    ]);
    return libPromise;
  }

  function ensureMapButton(){
    if(mapButton)return mapButton;
    const mapbar=document.querySelector('.mapbar');if(!mapbar)return null;
    mapButton=$('operaCmaxToggle');
    if(!mapButton){
      mapButton=document.createElement('button');mapButton.id='operaCmaxToggle';mapButton.type='button';
      mapButton.textContent = 'OPERA CMAX';
      mapButton.title='Pokaż/ukryj europejską warstwę OPERA CMAX';
      const before=$('playRadar')||null;before?mapbar.insertBefore(mapButton,before):mapbar.appendChild(mapButton);
    }
    mapButton.addEventListener('click',async()=>{
      mapEnabled=!mapEnabled;mapButton.classList.toggle('active',mapEnabled);
      if(!mapEnabled){try{if(operaLayer&&typeof map!=='undefined'&&map.hasLayer(operaLayer))map.removeLayer(operaLayer)}catch(_){}return}
      if(latestOpera?.latest&&!latestOpera.error)renderMapLayer(latestOpera.latest);else await run(true);
    });
    return mapButton;
  }

  function ensureUi(){
    ensureMapButton();if($('operaNowcastCard'))return;
    const host=$('radarNowcastCard')||$('rnCard')||[...document.querySelectorAll('.card')].find(c=>/Radar Nowcast/i.test(c.textContent||''));
    const card=document.createElement('section');card.id='operaNowcastCard';card.className='card w12';
    card.innerHTML=`
      <div class="op-head"><h2>OPERA CIRRUS</h2><span id="opState" class="op-badge">ŁĄCZENIE…</span><span id="opFrame" class="op-time">—</span></div>
      <div class="op-grid">
        <div><small>Echo</small><strong id="opMax">—</strong><span id="opNearest">—</span></div>
        <div><small>Ruch / trend</small><strong id="opMotion">—</strong><span id="opTrend">—</span></div>
        <div><small>POLRAD</small><strong id="opFusion">—</strong><span id="opConv">—</span></div>
      </div>
      <div id="opSummary" class="op-summary">OPERA jest europejską kontrolą CMAX; POLRAD pozostaje źródłem podstawowym.</div>
      <details class="op-details"><summary>Szczegóły</summary><div class="op-tech"><span id="opFrames">—</span><span id="opQind">—</span><span id="opArea">—</span><span id="opPred">—</span><span id="opFusionSub">—</span></div></details>
      <div id="opStatus" class="op-status">—</div>`;
    host?host.insertAdjacentElement('afterend',card):document.querySelector('.grid')?.appendChild(card);
    const style=document.createElement('style');style.id='operaCompactStyle';style.textContent=`
      #operaNowcastCard{padding-bottom:5px!important}#operaNowcastCard .op-head{display:flex;align-items:center;gap:7px;padding:7px 9px;border-bottom:1px solid var(--line)}
      #operaNowcastCard .op-head h2{margin:0!important;padding:0!important;border:0!important;flex:1;font-size:12px!important}#operaNowcastCard .op-badge{font-size:8px;font-weight:800;border:1px solid var(--line);border-radius:999px;padding:2px 6px}
      #operaNowcastCard .op-badge.ok{color:#35b24a;border-color:#35b24a}#operaNowcastCard .op-badge.bad{color:#f04444;border-color:#f04444}#operaNowcastCard .op-badge.wait{color:#f59f00;border-color:#f59f00}
      #operaNowcastCard .op-time{font-size:8px;color:var(--muted)}#operaNowcastCard .op-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line)}#operaNowcastCard .op-grid>div{background:var(--panel);padding:7px 8px;min-width:0}
      #operaNowcastCard .op-grid small,#operaNowcastCard .op-grid span{display:block;color:var(--muted);font-size:8px;line-height:1.25}#operaNowcastCard .op-grid strong{display:block;font-size:12px;line-height:1.25;margin:2px 0}
      #operaNowcastCard .op-summary{padding:6px 9px;font-size:9px;line-height:1.35}#operaNowcastCard .op-details{margin:0 9px 5px;font-size:8px;color:var(--muted)}#operaNowcastCard .op-tech{display:grid;gap:2px;padding-top:4px}#operaNowcastCard .op-status{padding:0 9px 5px;font-size:7.5px;color:var(--muted)}
      #operaNowcastCard.op-error .op-grid,#operaNowcastCard.op-error .op-details{display:none!important}@media(max-width:640px){#operaNowcastCard .op-grid{grid-template-columns:repeat(2,minmax(0,1fr))}#operaNowcastCard .op-grid>div:last-child{grid-column:1/-1}#operaNowcastCard .op-time{display:none}}`;
    document.head.appendChild(style);
  }
  function setState(text,kind='wait'){ensureUi();const e=$('opState');if(!e)return;e.textContent=text;e.classList.remove('ok','bad','wait');e.classList.add(kind)}
  function setStatus(text){ensureUi();const e=$('opStatus');if(e)e.textContent=text}

  function frameUrl(ms){
    const d=new Date(ms),Y=d.getUTCFullYear(),M=pad2(d.getUTCMonth()+1),D=pad2(d.getUTCDate()),h=pad2(d.getUTCHours()),m=pad2(d.getUTCMinutes());
    return `${OPERA_PROXY_BASE}/${Y}${M}${D}${h}${m}.tiff`;
  }
  function candidateFrames(){
    const step=5*60000,base=Math.floor(Date.now()/step)*step;
    const out=[];
    // Start at the current 5-min slot and probe backwards. Production latency is normally below 10 min.
    for(let i=0;i<MAX_CANDIDATES;i++){const t=base-i*step;out.push({time:t,url:frameUrl(t)})}
    return out;
  }
  async function fetchFrames(){return candidateFrames()}

  async function openTiff(url){
    let rangeError=null;
    try{return await window.GeoTIFF.fromUrl(url,{cache:true})}catch(e){rangeError=e}
    try{
      const c=new AbortController(),timer=setTimeout(()=>c.abort(),20000);
      try{
        const r=await fetch(url,{cache:'no-store',signal:c.signal});if(!r.ok)throw new Error(`HTTP ${r.status}`);
        const buf=await r.arrayBuffer();
        return await window.GeoTIFF.fromArrayBuffer(buf);
      }finally{clearTimeout(timer)}
    }catch(fullError){throw new Error(`GeoTIFF OPERA przez central-ingestor niedostępny (${fullError?.message||rangeError?.message||'CORS'})`)}
  }

  function projectForBbox(p,bbox){
    const[minX,minY,maxX,maxY]=bbox,inside=xy=>Array.isArray(xy)&&finite(xy[0])&&finite(xy[1])&&xy[0]>=minX&&xy[0]<=maxX&&xy[1]>=minY&&xy[1]<=maxY;
    for(const c of [{name:'OPERA-LAEA',proj:PROJ_OPERA},{name:'EPSG:3035',proj:PROJ_3035},{name:'WGS84',proj:PROJ_WGS84}]){
      let xy;try{xy=c.proj===PROJ_WGS84?[p.lon,p.lat]:window.proj4(PROJ_WGS84,c.proj,[p.lon,p.lat])}catch(_){continue}
      if(inside(xy))return{...c,x:xy[0],y:xy[1]};
    }
    throw new Error('nie rozpoznano projekcji GeoTIFF');
  }
  const inversePoint=(proj,x,y)=>proj===PROJ_WGS84?[x,y]:window.proj4(proj,PROJ_WGS84,[x,y]);
  function metadataNumber(meta,names,fallback){
    if(!meta||typeof meta!=='object')return fallback;const entries=Object.entries(meta);
    for(const name of names){const hit=entries.find(([k])=>k.toLowerCase()===name.toLowerCase());if(hit){const n=Number(hit[1]);if(finite(n))return n}}
    return fallback;
  }

  async function readFrame(frame,p){
    const tiff=await openTiff(frame.url),image=await tiff.getImage(),w=image.getWidth(),h=image.getHeight(),bbox=image.getBoundingBox();
    if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(finite))throw new Error('GeoTIFF bez georeferencji');
    const[minX,minY,maxX,maxY]=bbox,pp=projectForBbox(p,bbox),px=(pp.x-minX)/(maxX-minX)*w,py=(maxY-pp.y)/(maxY-minY)*h;
    const scaleX=w/(maxX-minX),scaleY=h/(maxY-minY),rx=GRID_RADIUS_KM*1000*scaleX,ry=GRID_RADIUS_KM*1000*scaleY;
    let x0=clamp(Math.floor(px-rx),0,w-2),x1=clamp(Math.ceil(px+rx),x0+1,w),y0=clamp(Math.floor(py-ry),0,h-2),y1=clamp(Math.ceil(py+ry),y0+1,h);
    const spp=Math.max(1,Number(image.getSamplesPerPixel?.()||1)),samples=spp>=2?[0,1]:[0];
    const rasters=await image.readRasters({window:[x0,y0,x1,y1],samples,width:GRID_N,height:GRID_N,resampleMethod:'nearest'}),raw=rasters[0];
    if(!raw||raw.length!==GRID_N*GRID_N)throw new Error('niepoprawny raster DBZH');
    const qRaw=rasters[1]&&rasters[1].length===raw.length?rasters[1]:null;
    let meta=null,datasetMeta=null;try{meta=await image.getGDALMetadata?.(0)}catch(_){}try{datasetMeta=await image.getGDALMetadata?.(null)}catch(_){}
    const gain=metadataNumber(meta,['scale_factor','scale','gain'],metadataNumber(datasetMeta,['scale_factor','scale','gain'],1));
    const offset=metadataNumber(meta,['add_offset','offset'],metadataNumber(datasetMeta,['add_offset','offset'],0));
    const nodata=typeof image.getGDALNoData==='function'?image.getGDALNoData():null;
    let qUsable=false,qMean=NaN;
    if(qRaw){let qn=0,qs=0,qmax=-Infinity,qmin=Infinity;for(const v of qRaw)if(finite(Number(v))){const n=Number(v);qmin=Math.min(qmin,n);qmax=Math.max(qmax,n);qs+=n;qn++}qUsable=qn>50&&qmin>=0&&qmax<=1.05;qMean=qUsable?qs/qn:NaN}
    const values=new Float32Array(raw.length),mask=new Uint8Array(raw.length),area={ge35:0,ge40:0,ge45:0,ge50:0};let active=0,sum=0,max=-Infinity;
    for(let i=0;i<raw.length;i++){
      const rv=Number(raw[i]);if(!finite(rv)||(nodata!=null&&rv===Number(nodata))){values[i]=NaN;continue}
      const v=rv*gain+offset;if(!finite(v)||v<-100||v>100){values[i]=NaN;continue}values[i]=v;max=Math.max(max,v);
      const qok=!qUsable||Number(qRaw[i])>=QIND_MIN;if(v>=DBZ_THRESHOLD&&qok){mask[i]=1;active++;sum+=v}if(qok&&v>=35)area.ge35++;if(qok&&v>=40)area.ge40++;if(qok&&v>=45)area.ge45++;if(qok&&v>=50)area.ge50++;
    }
    if(!finite(max))max=NaN;
    const wx0=minX+(x0/w)*(maxX-minX),wx1=minX+(x1/w)*(maxX-minX),wyTop=maxY-(y0/h)*(maxY-minY),wyBottom=maxY-(y1/h)*(maxY-minY);
    const corners=[inversePoint(pp.proj,wx0,wyTop),inversePoint(pp.proj,wx1,wyTop),inversePoint(pp.proj,wx0,wyBottom),inversePoint(pp.proj,wx1,wyBottom)].filter(x=>Array.isArray(x)&&x.every(finite));
    const lons=corners.map(x=>x[0]),lats=corners.map(x=>x[1]),geoBounds=corners.length===4?[[Math.min(...lats),Math.min(...lons)],[Math.max(...lats),Math.max(...lons)]]:null;
    return{time:frame.time,url:frame.url,values,mask,active,mean:active?sum/active:NaN,max,area,qMean,qUsable,projection:pp.name,geoBounds};
  }

  function scoreShift(a,b,sx,sy){
    let inter=0,union=0,weighted=0;
    for(let y=SEARCH_SHIFT;y<GRID_N-SEARCH_SHIFT;y++){const by=y+sy;if(by<0||by>=GRID_N)continue;for(let x=SEARCH_SHIFT;x<GRID_N-SEARCH_SHIFT;x++){const bx=x+sx;if(bx<0||bx>=GRID_N)continue;const ia=y*GRID_N+x,ib=by*GRID_N+bx,ma=a.mask[ia],mb=b.mask[ib];if(!ma&&!mb)continue;union++;if(ma&&mb){inter++;const va=a.values[ia],vb=b.values[ib];weighted+=Math.min(va,vb)/Math.max(va,vb,1)}}}
    if(union<8)return-1;return .70*(inter/union)+.30*(inter?weighted/inter:0);
  }
  function estimatePair(a,b){
    const dt=(b.time-a.time)/3600000;if(dt<=0||dt>.4||a.active<8||b.active<8)return null;let best=null;
    for(let sy=-SEARCH_SHIFT;sy<=SEARCH_SHIFT;sy++)for(let sx=-SEARCH_SHIFT;sx<=SEARCH_SHIFT;sx++){const score=scoreShift(a,b,sx,sy);if(score<0)continue;if(!best||score>best.score)best={sx,sy,score}}
    if(!best||best.score<.12)return null;const east=best.sx*GRID_STEP_KM/dt,north=-best.sy*GRID_STEP_KM/dt,speed=Math.hypot(east,north);if(speed>180)return null;
    return{...best,east,north,speed,bearing:bearingFromVector(east,north)};
  }
  function vectorStats(grids){
    const pairs=[];for(let i=0;i+2<grids.length;i++){const p=estimatePair(grids[i],grids[i+2]);if(p)pairs.push(p)}if(pairs.length<2)for(let i=0;i+1<grids.length;i++){const p=estimatePair(grids[i],grids[i+1]);if(p)pairs.push(p)}
    if(!pairs.length)return null;const good=pairs.slice(-6),east=median(good.map(x=>x.east)),north=median(good.map(x=>x.north)),speed=Math.hypot(east,north),bearing=bearingFromVector(east,north),score=median(good.map(x=>x.score)),spread=median(good.map(x=>Math.hypot(x.east-east,x.north-north)))||0;
    return{east,north,speed,bearing,score,consistency:clamp(1-spread/Math.max(25,speed),0,1)};
  }
  function linearRate(grids,getter){
    const rows=grids.map(g=>({t:g.time,y:Number(getter(g))})).filter(r=>finite(r.y));if(rows.length<3)return NaN;const t0=rows[0].t,x=rows.map(r=>(r.t-t0)/3600000),y=rows.map(r=>r.y),xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length;let num=0,den=0;for(let i=0;i<x.length;i++){num+=(x[i]-xm)*(y[i]-ym);den+=(x[i]-xm)**2}return den?num/den:NaN;
  }
  function trendStats(grids){
    const meanRate=linearRate(grids,g=>g.mean),maxRate=linearRate(grids,g=>g.max),area45Rate=linearRate(grids,g=>g.area.ge45);let label='stabilne';if((finite(maxRate)&&maxRate>=5)||(finite(area45Rate)&&area45Rate>=8))label='rośnie';else if((finite(maxRate)&&maxRate<=-5)||(finite(area45Rate)&&area45Rate<=-8))label='słabnie';return{label,meanDbzPerH:meanRate,maxDbzPerH:maxRate,area45CellsPerH:area45Rate};
  }
  function nearestEcho(latest){
    let best=null;for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){const i=gy*GRID_N+gx,v=latest.values[i];if(!finite(v)||v<DBZ_THRESHOLD||!latest.mask[i])continue;const east=(gx-CENTER)*GRID_STEP_KM,north=-(gy-CENTER)*GRID_STEP_KM,d=Math.hypot(east,north);if(!best||d<best.distance||(d===best.distance&&v>best.value))best={east,north,distance:d,value:v,bearing:bearingFromVector(east,north)}}return best;
  }
  function approachEcho(latest,vector){
    if(!vector||vector.speed<4)return null;let best=null,vsq=vector.east**2+vector.north**2;for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){const i=gy*GRID_N+gx,v=latest.values[i];if(!finite(v)||v<DBZ_THRESHOLD||!latest.mask[i])continue;const east=(gx-CENTER)*GRID_STEP_KM,north=-(gy-CENTER)*GRID_STEP_KM,t=-(east*vector.east+north*vector.north)/vsq;if(t<-.05||t>1.5)continue;const tt=Math.max(0,t),cpa=Math.hypot(east+vector.east*tt,north+vector.north*tt);if(cpa>30)continue;const c={east,north,value:v,tHours:tt,cpa,distance:Math.hypot(east,north),bearing:bearingFromVector(east,north)};if(!best||c.tHours<best.tHours-.05||(Math.abs(c.tHours-best.tHours)<.05&&c.cpa<best.cpa))best=c}return best;
  }
  function gridSample(latest,east,north){
    const gx=CENTER+east/GRID_STEP_KM,gy=CENTER-north/GRID_STEP_KM;if(gx<1||gy<1||gx>GRID_N-2||gy>GRID_N-2)return NaN;let best=NaN;for(let y=Math.floor(gy)-1;y<=Math.ceil(gy)+1;y++)for(let x=Math.floor(gx)-1;x<=Math.ceil(gx)+1;x++){const v=latest.values[y*GRID_N+x];if(finite(v)&&(!finite(best)||v>best))best=v}return best;
  }
  function advect(latest,vector,trend){const out={};for(const min of HORIZONS){const h=min/60;let v=gridSample(latest,-vector.east*h,-vector.north*h);if(finite(v)&&finite(trend?.meanDbzPerH))v=clamp(v+clamp(trend.meanDbzPerH,-12,12)*h*.5,-99,80);out[min]=v}return out}
  function confidence(grids,vector){if(!vector)return 0;const newest=grids.at(-1)?.time||0,age=(Date.now()-newest)/60000,fresh=clamp(1-age/MAX_FRAME_AGE_MIN,0,1),frames=clamp(grids.length/MAX_FRAMES,0,1),quality=finite(grids.at(-1)?.qMean)?clamp(grids.at(-1).qMean,0,1):.65;return Math.round(100*(.44*clamp(vector.score,0,1)+.27*vector.consistency+.17*fresh+.08*frames+.04*quality))}

  function polradSignal(polrad){if(!polrad||polrad.error)return false;if(polrad.source==='cmax'){const vals=Object.values(polrad.predictions||{}).map(Number).filter(finite);return vals.some(v=>v>=35)||Number(polrad.approach?.value)>=35||Number(polrad.nearest?.value)>=40}return false}
  function fuse(opera,polrad){
    const pvec=polrad?.vector||null,ovec=opera?.vector||null,dirDiff=pvec&&ovec?circularDiff(Number(pvec.bearingDeg),Number(ovec.bearingDeg)):NaN,ps=Number(pvec?.speedKmh),os=Number(ovec?.speedKmh),speedDiff=finite(ps)&&finite(os)?Math.abs(ps-os):NaN;
    const vectorAgree=finite(dirDiff)&&finite(speedDiff)&&dirDiff<=45&&speedDiff<=Math.max(25,ps*.6),pSignal=polradSignal(polrad),oStrong=Number(opera?.approach?.value)>=35||Number(opera?.nearest?.value)>=40||Object.values(opera?.predictions||{}).some(v=>Number(v)>=35);
    let convLevel='brak sygnału do potwierdzenia';if(pSignal&&oStrong&&vectorAgree)convLevel='potwierdza';else if(pSignal&&oStrong)convLevel='częściowo potwierdza';else if(pSignal&&!oStrong)convLevel='nie potwierdza';
    const level=!pvec||!ovec?'brak porównania':vectorAgree?'zgodne':finite(dirDiff)&&dirDiff<=70?'częściowo zgodne':'rozbieżne';return{updatedAt:new Date().toISOString(),level,vectorAgree,dirDiffDeg:dirDiff,speedDiffKmh:speedDiff,convectiveSupport:convLevel,polradSignal:pSignal,operaSignal:oStrong,primary:'POLRAD',secondary:'OPERA CIRRUS'};
  }

  function colorForDbz(v){if(!finite(v)||v<5)return[0,0,0,0];const p=[[62,245,140,255],[56,255,25,204],[50,230,0,89],[44,255,22,0],[38,255,136,0],[32,255,242,0],[26,255,251,216],[20,184,244,241],[14,27,200,240],[8,0,51,232],[5,0,0,204]];for(const x of p)if(v>=x[0])return[x[1],x[2],x[3],185];return[0,0,170,150]}
  function rasterDataUrl(latest){const c=document.createElement('canvas');c.width=GRID_N;c.height=GRID_N;const ctx=c.getContext('2d');if(!ctx)return null;const im=ctx.createImageData(GRID_N,GRID_N);for(let i=0;i<latest.values.length;i++){const[r,g,b,a]=colorForDbz(Number(latest.values[i])),j=i*4;im.data[j]=r;im.data[j+1]=g;im.data[j+2]=b;im.data[j+3]=a}ctx.putImageData(im,0,0);return c.toDataURL('image/png')}
  function renderMapLayer(latest){ensureMapButton();if(!mapEnabled||!latest?.geoBounds||typeof L==='undefined'||typeof map==='undefined')return;const url=rasterDataUrl(latest);if(!url)return;try{if(operaLayer&&map.hasLayer(operaLayer))map.removeLayer(operaLayer)}catch(_){}operaLayer=L.imageOverlay(url,latest.geoBounds,{opacity:.52,interactive:false,attribution:'EUMETNET OPERA CIRRUS'});operaLayer.addTo(map)}

  function publishOpera(result){latestOpera=result;window.PrognozaEPIROperaNowcast=result;window.dispatchEvent(new CustomEvent('prognozaepir:opera-nowcast-updated',{detail:result}));publishFusion()}
  function publishFusion(){if(!latestOpera)return;const fusion=fuse(latestOpera,window.PrognozaEPIRRadarNowcast||null);window.PrognozaEPIRRadarFusion=fusion;window.dispatchEvent(new CustomEvent('prognozaepir:radar-fusion-updated',{detail:fusion}));renderFusion(fusion)}
  function renderFusion(f){if($('opFusion'))$('opFusion').textContent=f.level;if($('opConv'))$('opConv').textContent=f.convectiveSupport;if($('opFusionSub'))$('opFusionSub').textContent=finite(f.dirDiffDeg)?`różnica kierunku ${Math.round(f.dirDiffDeg)}° · prędkości ${Math.round(f.speedDiffKmh)} km/h`:'wektor jednego źródła niedostępny'}
  function renderResult(r){
    ensureUi();$('operaNowcastCard')?.classList.remove('op-error');const latest=r.latest;setState('DZIAŁA','ok');$('opFrame').textContent=fmtUtcMs(latest.time);$('opFrames').textContent=`Historia: ${r.frames} klatek · ${fmtUtcMs(r.frameStart)}–${fmtUtcMs(r.frameEnd)}`;$('opMax').textContent=dbzText(latest.max);$('opNearest').textContent=r.nearest?`${Math.round(r.nearest.distance)} km ${compass16(r.nearest.bearing)} · ${dbzText(r.nearest.value)}`:'brak ≥27 dBZ do 160 km';$('opMotion').textContent=r.vector?`${compass16(r.vector.bearingDeg)} · ${Math.round(r.vector.speedKmh)} km/h`:'brak stabilnego ruchu';$('opTrend').textContent=`trend: ${r.trend.label}`;$('opQind').textContent=latest.qUsable?`QIND ${Math.round(latest.qMean*100)}/100`:'QIND bez osobnego pasma';$('opArea').textContent=`≥35 ${latest.area.ge35} · ≥40 ${latest.area.ge40} · ≥45 ${latest.area.ge45} · ≥50 ${latest.area.ge50}`;$('opPred').textContent=HORIZONS.map(h=>`+${h} ${dbzText(r.predictions[h])}`).join(' · ');
    const eta=r.approach?Math.round(r.approach.tHours*60):null;$('opSummary').textContent=r.approach?`Podejście ≤30 km za ok. ${eta} min.`:'Brak echa ≥27 dBZ na torze ≤30 km w ciągu 90 min.';setStatus(`klatka ${fmtUtcMs(latest.time)} · central-ingestor · OPERA DBZH GeoTIFF`);renderMapLayer(latest);
  }
  function renderError(msg){ensureUi();$('operaNowcastCard')?.classList.add('op-error');setState('NIEDOSTĘPNA','bad');$('opFrame').textContent='—';$('opSummary').textContent='OPERA niedostępna. POLRAD działa niezależnie.';setStatus(`OPERA: ${msg}`);try{if(operaLayer&&typeof map!=='undefined'&&map.hasLayer(operaLayer))map.removeLayer(operaLayer)}catch(_){}

  async function run(force=false){
    ensureUi();if(running)return;if(!force&&Date.now()-lastRun<AUTO_MS-15000)return;const p=currentPoint();if(!p){renderError('brak poprawnego punktu');return}
    running=true;lastRun=Date.now();setState('POBIERANIE','wait');setStatus('OPERA: szukanie najnowszych klatek przez central-ingestor…');
    try{
      await ensureLibraries();const frames=await fetchFrames(),grids=[];let lastErr='';
      // Probe from newest backwards; stop after 7 real frames. Missing newest slots are normal production latency.
      for(let i=0;i<frames.length&&grids.length<MAX_FRAMES;i++){
        setStatus(`OPERA: sprawdzam ${fmtUtcMs(frames[i].time)} · znaleziono ${grids.length}/${MAX_FRAMES}`);
        try{const g=await readFrame(frames[i],p);grids.push(g)}catch(e){lastErr=String(e?.message||e);console.warn('OPERA candidate skipped',frames[i],e)}
      }
      grids.sort((a,b)=>a.time-b.time);if(grids.length<3)throw new Error(lastErr||'nie znaleziono 3 dostępnych klatek DBZH.tiff');
      const latest=grids.at(-1),age=(Date.now()-latest.time)/60000;if(age>50)throw new Error(`ostatnia klatka ma ${Math.round(age)} min`);
      const vector=vectorStats(grids),trend=trendStats(grids),nearest=nearestEcho(latest),approach=vector?approachEcho(latest,vector):null,predictions=vector?advect(latest,vector,trend):Object.fromEntries(HORIZONS.map(h=>[h,NaN])),conf=confidence(grids,vector);
      const result={updatedAt:new Date().toISOString(),point:p,source:'opera_cirrus_dbzh_central',frames:grids.length,frameStart:grids[0].time,frameEnd:latest.time,latest,vector:vector?{eastKmh:vector.east,northKmh:vector.north,speedKmh:vector.speed,bearingDeg:vector.bearing,score:vector.score,consistency:vector.consistency}:null,confidence:conf,trend,nearest,approach,etaMin:approach?approach.tHours*60:null,predictions,quality:{qindAvailable:latest.qUsable,qindMean:latest.qMean,qindThreshold:QIND_MIN}};
      renderResult(result);publishOpera(result);
    }catch(e){console.error('OPERA Nowcast:',e);const msg=String(e?.message||e);renderError(msg);publishOpera({updatedAt:new Date().toISOString(),point:p,error:msg,source:'opera_cirrus_dbzh_central'})}finally{running=false}
  }

  ensureUi();window.addEventListener('prognozaepir:radar-nowcast-updated',publishFusion);for(const id of ['apply','resetPoint','refresh'])$(id)?.addEventListener('click',()=>setTimeout(()=>run(true),650));document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastRun>AUTO_MS)run(false)});setTimeout(()=>run(false),1200);setInterval(()=>{if(!document.hidden)run(false)},AUTO_MS);
  window.PrognozaEPIROperaNowcastEngine={refresh:()=>run(true),get:()=>window.PrognozaEPIROperaNowcast||null,getFusion:()=>window.PrognozaEPIRRadarFusion||null,toggleMap:()=>mapButton?.click()};
})();