'use strict';

// Radar Nowcast 0-3 h -------------------------------------------------------
// Motion nowcast from the latest IMGW/POLRAD image sequence. This is a
// deterministic advection estimate, not a calibrated probability forecast.
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $n = id => document.getElementById(id);
  const API = 'https://meteo.imgw.pl/api/radars/v1/list/';
  const BOUNDS = {south:48.5, west:13.5, north:56.0, east:25.0};
  const FRAME_COUNT = 12;
  const GRID_STEP_KM = 4;
  const GRID_RADIUS_KM = 160;
  const GRID_N = Math.round((GRID_RADIUS_KM * 2) / GRID_STEP_KM) + 1;
  const CENTER_I = Math.floor(GRID_N / 2);
  const SEARCH_SHIFT = 6;
  const HORIZONS_MIN = [30,60,90,120,180];
  const ECHO_THRESHOLD = {cmax:27, sri:0.1};
  const MAX_FRAME_AGE_MIN = 25;
  const autoEveryMs = 10 * 60 * 1000;
  let running = false;
  let lastRun = 0;
  let overlayLayers = [];

  const css = document.createElement('style');
  css.textContent = `
    .radar-nowcast{padding:9px 10px;font-size:10px;line-height:1.4}
    .rn-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:7px}
    .rn-tile{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:58px}
    .rn-tile small{display:block;color:var(--muted);font-size:8.5px;margin-bottom:3px}
    .rn-tile b{display:block;font-size:14px;line-height:1.12}.rn-tile span{display:block;color:var(--muted);font-size:8px;margin-top:3px}
    .rn-horizons{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;margin:7px 0}
    .rn-h{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px;text-align:center}
    .rn-h b{display:block;font-size:11px}.rn-h span{font-size:8px;color:var(--muted)}
    .rn-summary{border:1px solid var(--line);background:var(--panel2);border-radius:7px;padding:7px;margin-top:7px}
    .rn-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:7px}.rn-actions button{border:1px solid var(--line);background:var(--blue2);color:#fff;border-radius:6px;padding:6px 8px;font-size:9px;font-weight:700}.rn-actions span{color:var(--muted);font-size:8.5px}
    .rn-model{margin-top:6px;color:var(--muted);font-size:9px}.rn-model b{color:var(--ink)}
    @media(max-width:700px){.rn-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.rn-horizons{grid-template-columns:repeat(5,minmax(62px,1fr));overflow:auto}}
  `;
  document.head.appendChild(css);

  function currentPointN(){
    if (typeof point !== 'undefined' && Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon))) return {lat:Number(point.lat),lon:Number(point.lon)};
    const lat=Number(String($n('lat')?.value||'').replace(',','.'));
    const lon=Number(String($n('lon')?.value||'').replace(',','.'));
    return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
  }

  function ensureUi(){
    let card=$n('radarNowcastCard');
    if(card)return card;
    const left=document.querySelector('.layout > div:first-child');
    if(!left)return null;
    card=document.createElement('section');
    card.id='radarNowcastCard';card.className='card';card.style.marginTop='8px';
    card.innerHTML=`<h2>Radar Nowcast 0–3 h · POLRAD</h2><div class="radar-nowcast">
      <div class="rn-grid">
        <div class="rn-tile"><small>Ruch echa</small><b id="rnMotion">—</b><span id="rnMotionSub">ostatnie klatki POLRAD</span></div>
        <div class="rn-tile"><small>Echo nadchodzi z</small><b id="rnFrom">—</b><span id="rnFromSub">kierunek źródłowy</span></div>
        <div class="rn-tile"><small>ETA / najbliższe podejście</small><b id="rnEta">—</b><span id="rnCpa">—</span></div>
        <div class="rn-tile"><small>Pewność wektora</small><b id="rnConfidence">—</b><span id="rnFrames">—</span></div>
        <div class="rn-tile"><small>Trend intensywności</small><b id="rnTrend">—</b><span id="rnTrendSub">—</span></div>
        <div class="rn-tile"><small>Najbliższe echo</small><b id="rnNearest">—</b><span id="rnNearestSub">—</span></div>
        <div class="rn-tile"><small>Modele 0–3 h</small><b id="rnModels">—</b><span id="rnModelsSub">AIFS / GFS / ICON</span></div>
        <div class="rn-tile"><small>Ocena łączna</small><b id="rnCombined">—</b><span>radar + modele</span></div>
      </div>
      <div class="rn-horizons" id="rnHorizons">${HORIZONS_MIN.map(h=>`<div class="rn-h"><span>+${h} min</span><b id="rnH${h}">—</b></div>`).join('')}</div>
      <div class="rn-summary" id="rnSummary">Oczekiwanie na analizę historii POLRAD…</div>
      <div class="rn-model" id="rnModelDetail"></div>
      <div class="rn-actions"><button id="rnRefresh" type="button">Odśwież nowcast</button><span id="rnStatus">—</span></div>
    </div>`;
    const aiCard=[...left.querySelectorAll('.card')].find(x=>x.querySelector('h2')?.textContent.includes('Nowcast AI')||x.querySelector('h2')?.textContent.includes('Prognoza AI'));
    if(aiCard)left.insertBefore(card,aiCard);else left.appendChild(card);
    $n('rnRefresh')?.addEventListener('click',()=>runNowcast(true));
    return card;
  }

  function setStatus(s){const e=$n('rnStatus');if(e)e.textContent=s;}
  function fmtLocal(sec){try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit'}).format(new Date(sec*1000));}catch(_){return new Date(sec*1000).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}}
  function compass16(deg){const d=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];return d[Math.round((((deg%360)+360)%360)/22.5)%16];}
  function bearingFromVector(east,north){return (Math.atan2(east,north)*180/Math.PI+360)%360;}
  function median(a){if(!a.length)return null;const b=a.slice().sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2;}
  function clampN(v,a,b){return Math.max(a,Math.min(b,v));}
  function normalizeUrl(u){return String(u||'').replace(/^http:\/\//i,'https://');}

  function hsvN(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;return{h,s:mx?d/mx:0,v:mx};}
  function cmaxN(r,g,b,a){if(a<45)return null;const{h,s,v}=hsvN(r,g,b);if(s<.28||v<.15)return null;if(h>=225&&h<285){if(v<.34)return 8;if(v<.50)return 14;if(v<.68)return 20;return 27;}if(h>=195&&h<225)return 30;if(h>=165&&h<195)return 34;if(h>=90&&h<165)return 38;if(h>=55&&h<90)return 41;if(h>=35&&h<55)return 44;if(h>=18&&h<35)return 47;if(h<18||h>=350)return 52;if(h>=285&&h<350)return 58;return null;}
  function sriN(r,g,b,a){if(a<45)return null;const{h,s,v}=hsvN(r,g,b);if(v<.16||s<.18)return null;if(h>=225&&h<285)return v<.5?.1:v<.72?.2:.3;if(h>=190&&h<225)return .6;if(h>=90&&h<190)return 1;if(h>=55&&h<90)return 1.7;if(h>=40&&h<55)return 3.1;if(h>=25&&h<40)return 5.4;if(h<25||h>=350)return v<.68?17:9.6;if(h>=285&&h<350)return 30;return null;}
  function pixelValueN(product,r,g,b,a){return product==='cmax'?cmaxN(r,g,b,a):sriN(r,g,b,a);}

  function mercY(lat){const p=clampN(lat,-85,85)*Math.PI/180;return Math.log(Math.tan(Math.PI/4+p/2));}
  const MY_N=mercY(BOUNDS.north),MY_S=mercY(BOUNDS.south);
  function pixelForLatLon(r,lat,lon){const x=(lon-BOUNDS.west)/(BOUNDS.east-BOUNDS.west)*r.width;const y=(MY_N-mercY(lat))/(MY_N-MY_S)*r.height;return{x,y};}
  function valueAtLatLon(r,lat,lon){const p=pixelForLatLon(r,lat,lon),x=Math.round(p.x),y=Math.round(p.y);if(x<0||y<0||x>=r.width||y>=r.height)return null;let best=null;for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){const px=x+xx,py=y+yy;if(px<0||py<0||px>=r.width||py>=r.height)continue;const i=(py*r.width+px)*4,v=pixelValueN(r.product,r.rgba[i],r.rgba[i+1],r.rgba[i+2],r.rgba[i+3]);if(Number.isFinite(v)&&(best===null||v>best))best=v;}return best;}

  async function fetchFramesN(product){const c=new AbortController(),timer=setTimeout(()=>c.abort(),10000);try{const r=await fetch(API+product,{cache:'no-cache',signal:c.signal});if(!r.ok)throw new Error('IMGW '+r.status);const j=await r.json(),rows=j?.[product]?.list;if(!Array.isArray(rows)||!rows.length)throw new Error('brak klatek '+product.toUpperCase());const uniq=new Map();for(const f of rows){const t=Number(f?.date);if(Number.isFinite(t)&&f?.url)uniq.set(t,{date:t,url:normalizeUrl(f.url)});}return [...uniq.values()].sort((a,b)=>a.date-b.date).slice(-FRAME_COUNT);}finally{clearTimeout(timer);}}

  function loadRasterN(frame,product){return new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';const timer=setTimeout(()=>{img.src='';reject(new Error('timeout obrazu '+product.toUpperCase()));},8500);img.onload=()=>{clearTimeout(timer);try{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);const rgba=ctx.getImageData(0,0,c.width,c.height).data;resolve({product,time:frame.date,width:c.width,height:c.height,rgba});}catch(e){reject(new Error('CORS obrazu '+product.toUpperCase()));}};img.onerror=()=>{clearTimeout(timer);reject(new Error('błąd obrazu '+product.toUpperCase()));};img.src=frame.url+(frame.url.includes('?')?'&':'?')+'_rn='+frame.date;});}

  function gridForRaster(r,p){const values=new Float32Array(GRID_N*GRID_N),mask=new Uint8Array(GRID_N*GRID_N);const cos=Math.max(.2,Math.cos(p.lat*Math.PI/180));let active=0,max=0,sum=0;for(let gy=0;gy<GRID_N;gy++){const dy=(gy-CENTER_I)*GRID_STEP_KM,lat=p.lat+dy/111.32;for(let gx=0;gx<GRID_N;gx++){const dx=(gx-CENTER_I)*GRID_STEP_KM,lon=p.lon+dx/(111.32*cos),v=valueAtLatLon(r,lat,lon),i=gy*GRID_N+gx;if(Number.isFinite(v)){values[i]=v;max=Math.max(max,v);if(v>=ECHO_THRESHOLD[r.product]){mask[i]=1;active++;sum+=v;}}}}return{time:r.time,product:r.product,values,mask,active,max,mean:active?sum/active:null};}

  function scoreShift(a,b,sx,sy){let inter=0,union=0,weighted=0;for(let y=SEARCH_SHIFT;y<GRID_N-SEARCH_SHIFT;y++){const by=y+sy;if(by<0||by>=GRID_N)continue;for(let x=SEARCH_SHIFT;x<GRID_N-SEARCH_SHIFT;x++){const bx=x+sx;if(bx<0||bx>=GRID_N)continue;const ia=y*GRID_N+x,ib=by*GRID_N+bx,ma=a.mask[ia],mb=b.mask[ib];if(!ma&&!mb)continue;union++;if(ma&&mb){inter++;const va=a.values[ia],vb=b.values[ib];weighted+=Math.min(va,vb)/Math.max(va,vb,1);}}}if(union<10)return -1;return .70*(inter/union)+.30*(inter?weighted/inter:0);}

  function estimatePair(a,b){const dt=(b.time-a.time)/3600;if(dt<=0||dt>.35||a.active<10||b.active<10)return null;let best=null;for(let sy=-SEARCH_SHIFT;sy<=SEARCH_SHIFT;sy++)for(let sx=-SEARCH_SHIFT;sx<=SEARCH_SHIFT;sx++){const score=scoreShift(a,b,sx,sy);if(score<0)continue;if(!best||score>best.score)best={sx,sy,score};}if(!best||best.score<.12)return null;const east=best.sx*GRID_STEP_KM/dt,north=best.sy*GRID_STEP_KM/dt,speed=Math.hypot(east,north);if(speed>160)return null;return{...best,dt,east,north,speed,bearing:bearingFromVector(east,north)};}

  function vectorStats(grids){const pairs=[];for(let i=0;i+2<grids.length;i++){const p=estimatePair(grids[i],grids[i+2]);if(p)pairs.push(p);}if(pairs.length<2){for(let i=0;i+1<grids.length;i++){const p=estimatePair(grids[i],grids[i+1]);if(p)pairs.push(p);}}if(!pairs.length)return null;const good=pairs.slice(-6),east=median(good.map(x=>x.east)),north=median(good.map(x=>x.north)),speed=Math.hypot(east,north),bearing=bearingFromVector(east,north),score=median(good.map(x=>x.score));const residual=good.map(x=>Math.hypot(x.east-east,x.north-north)),spread=median(residual)||0,consistency=clampN(1-spread/Math.max(25,speed),0,1);return{east,north,speed,bearing,score,consistency,pairs:good};}

  function regressionTrend(grids){const rows=grids.filter(g=>Number.isFinite(g.mean)&&g.active>=5);if(rows.length<3)return{rate:null,label:'brak danych'};const t0=rows[0].time,x=rows.map(g=>(g.time-t0)/3600),y=rows.map(g=>g.mean),xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length;let num=0,den=0;for(let i=0;i<x.length;i++){num+=(x[i]-xm)*(y[i]-ym);den+=(x[i]-xm)**2;}const rate=den?num/den:0,label=rate>3?'nasila się':rate<-3?'słabnie':'stabilne';return{rate,label};}

  function nearestEcho(latest){let best=null;for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){const i=gy*GRID_N+gx,v=latest.values[i];if(v<ECHO_THRESHOLD[latest.product])continue;const east=(gx-CENTER_I)*GRID_STEP_KM,north=(gy-CENTER_I)*GRID_STEP_KM,d=Math.hypot(east,north);if(!best||d<best.distance||(d===best.distance&&v>best.value))best={east,north,distance:d,value:v,bearing:bearingFromVector(east,north)};}return best;}

  function approachEcho(latest,vector){if(!vector||vector.speed<4)return null;let best=null,vsq=vector.east**2+vector.north**2;for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){const i=gy*GRID_N+gx,v=latest.values[i];if(v<ECHO_THRESHOLD[latest.product])continue;const east=(gx-CENTER_I)*GRID_STEP_KM,north=(gy-CENTER_I)*GRID_STEP_KM,t=-(east*vector.east+north*vector.north)/vsq;if(t<-.05||t>3.5)continue;const ce=east+vector.east*Math.max(0,t),cn=north+vector.north*Math.max(0,t),cpa=Math.hypot(ce,cn);if(cpa>28)continue;const candidate={east,north,value:v,tHours:Math.max(0,t),cpa,distance:Math.hypot(east,north),bearing:bearingFromVector(east,north)};if(!best||candidate.tHours<best.tHours-.08||(Math.abs(candidate.tHours-best.tHours)<.08&&candidate.cpa<best.cpa)||(Math.abs(candidate.tHours-best.tHours)<.08&&Math.abs(candidate.cpa-best.cpa)<3&&candidate.value>best.value))best=candidate;}return best;}

  function gridSample(latest,east,north){const gx=CENTER_I+east/GRID_STEP_KM,gy=CENTER_I+north/GRID_STEP_KM;if(gx<1||gy<1||gx>GRID_N-2||gy>GRID_N-2)return null;let best=null;for(let y=Math.floor(gy)-1;y<=Math.ceil(gy)+1;y++)for(let x=Math.floor(gx)-1;x<=Math.ceil(gx)+1;x++){const v=latest.values[y*GRID_N+x];if(Number.isFinite(v)&&v>0&&(best===null||v>best))best=v;}return best;}

  function advect(latest,vector,trend){const out={};for(const min of HORIZONS_MIN){const h=min/60,e=-vector.east*h,n=-vector.north*h;let v=gridSample(latest,e,n);if(Number.isFinite(v)&&Number.isFinite(trend?.rate)){v+=clampN(trend.rate,-10,10)*h*.65;v=Math.max(0,v);}out[min]=v;}return out;}

  function confidenceN(grids,vector){if(!vector)return 0;const newest=grids.at(-1)?.time||0,age=(Date.now()/1000-newest)/60,fresh=clampN(1-age/MAX_FRAME_AGE_MIN,0,1),frames=clampN(grids.length/10,0,1),coverage=clampN((grids.at(-1)?.active||0)/90,0,1);return Math.round(100*(.42*clampN(vector.score,0,1)+.28*vector.consistency+.18*fresh+.12*Math.max(frames,coverage)));}

  function valueText(v,product){if(!Number.isFinite(v)||v<ECHO_THRESHOLD[product])return'bez echa';if(product==='sri')return(v<1?v.toFixed(1):v.toFixed(0)).replace('.',',')+' mm/h';return'~'+Math.round(v)+' dBZ';}
  function trendText(t,product){if(!Number.isFinite(t?.rate))return'—';const u=product==='cmax'?'dBZ/h':'mm/h/h';return`${t.label} · ${t.rate>=0?'+':''}${t.rate.toFixed(1).replace('.',',')} ${u}`;}

  async function loadModelSupport(p,etaMin,preds,source){const hourly='precipitation,weather_code',base={latitude:p.lat,longitude:p.lon,hourly,timezone:'UTC',forecast_hours:'6'},qs=o=>new URLSearchParams({...base,...o}).toString();const urls={GFS:'https://api.open-meteo.com/v1/gfs?'+qs({}),AIFS:'https://api.open-meteo.com/v1/forecast?'+qs({models:'ecmwf_aifs025_single'}),ICON:'https://api.open-meteo.com/v1/forecast?'+qs({models:'icon_seamless'})};const settled=await Promise.allSettled(Object.entries(urls).map(async([name,url])=>{const c=new AbortController(),timer=setTimeout(()=>c.abort(),7000);try{const r=await fetch(url,{cache:'no-cache',signal:c.signal});if(!r.ok)throw new Error(name+' '+r.status);return[name,await r.json()];}finally{clearTimeout(timer);}}));const models={};for(const s of settled)if(s.status==='fulfilled')models[s.value[0]]=s.value[1];const target=Date.now()+(Number.isFinite(etaMin)?etaMin:60)*60000,rows=[];for(const[name,j]of Object.entries(models)){const h=j?.hourly||{},times=h.time||[];let best=-1,bd=Infinity;for(let i=0;i<times.length;i++){const ms=Date.parse(times[i]+'Z'),d=Math.abs(ms-target);if(d<bd){bd=d;best=i;}}if(best>=0){const rr=Number(h.precipitation?.[best]);rows.push({name,rain:Number.isFinite(rr)?rr:0,time:times[best],supports:Number.isFinite(rr)&&rr>=.1});}}const support=rows.filter(x=>x.supports).length,total=rows.length,radarWet=Object.values(preds).some(v=>Number.isFinite(v)&&v>=ECHO_THRESHOLD[source]);let label='brak danych';if(total){if(support===total&&total>=2)label='potwierdzają';else if(support>=Math.ceil(total/2))label='częściowo potwierdzają';else label=radarWet?'nie potwierdzają':'zgodne z brakiem opadu';}return{rows,support,total,label};}

  function combinedLabel(conf,models,approach,preds,source){const radarSignal=Object.values(preds).some(v=>Number.isFinite(v)&&v>=ECHO_THRESHOLD[source])||!!approach;if(conf>=65&&radarSignal&&models.total&&models.support>=Math.ceil(models.total/2))return'wysoka zgodność';if(conf>=45&&radarSignal)return models.support?'umiarkowana zgodność':'radar bez wsparcia modeli';if(!radarSignal&&models.total&&models.support===0)return'brak sygnału';return'niepewne';}

  function clearOverlayN(){for(const l of overlayLayers){try{if(map.hasLayer(l))map.removeLayer(l);}catch(_){}}overlayLayers=[];}
  function drawMotionN(p,approach,vector){clearOverlayN();if(!approach||!vector||vector.speed<4)return;const cos=Math.max(.2,Math.cos(p.lat*Math.PI/180)),start=[p.lat+approach.north/111.32,p.lon+approach.east/(111.32*cos)],minutes=Math.min(90,Math.max(30,approach.tHours*60)),endEast=approach.east+vector.east*minutes/60,endNorth=approach.north+vector.north*minutes/60,end=[p.lat+endNorth/111.32,p.lon+endEast/(111.32*cos)];if(!map.getPane('radarNowcastPane')){map.createPane('radarNowcastPane');map.getPane('radarNowcastPane').style.zIndex='642';map.getPane('radarNowcastPane').style.pointerEvents='none';}overlayLayers.push(L.polyline([start,end],{pane:'radarNowcastPane',color:'#ff8c00',weight:3,dashArray:'8 5',interactive:false}).addTo(map));overlayLayers.push(L.circleMarker(start,{pane:'radarNowcastPane',radius:5,color:'#ff8c00',weight:2,fillColor:'#fff',fillOpacity:1,interactive:false}).addTo(map));}

  function publishN(result){window.PrognozaEPIRRadarNowcast=result;window.dispatchEvent(new CustomEvent('prognozaepir:radar-nowcast-updated',{detail:result}));}

  async function runProduct(product,p){const frames=await fetchFramesN(product);if(frames.length<4)throw new Error('za mało klatek '+product.toUpperCase());const rasters=[];for(let i=0;i<frames.length;i++){setStatus(`POLRAD ${product.toUpperCase()}: klatka ${i+1}/${frames.length}`);try{rasters.push(await loadRasterN(frames[i],product));}catch(e){console.warn('Radar Nowcast frame skipped',frames[i],e);}}if(rasters.length<4)throw new Error('nie można odczytać historii '+product.toUpperCase());const all=rasters.map(r=>gridForRaster(r,p));const grids=all.filter((g,i)=>g.active>=2||i===all.length-1);return{grids};}

  async function runNowcast(force=false){
    ensureUi();if(running)return;if(!force&&Date.now()-lastRun<2*60*1000)return;const p=currentPointN();if(!p){setStatus('brak punktu');return;}running=true;lastRun=Date.now();setStatus('pobieranie historii POLRAD…');
    try{
      let source='cmax',pack;try{pack=await runProduct('cmax',p);}catch(e){console.warn('CMAX nowcast failed, trying SRI',e);source='sri';pack=await runProduct('sri',p);}
      const grids=pack.grids;if(grids.length<4)throw new Error('za mało użytecznych klatek');const latest=grids.at(-1),ageMin=(Date.now()/1000-latest.time)/60;if(ageMin>45)throw new Error('ostatnia klatka POLRAD ma '+Math.round(ageMin)+' min');const vector=vectorStats(grids),trend=regressionTrend(grids),nearest=nearestEcho(latest);if(!vector)throw new Error('brak stabilnego wektora ruchu echa');const approach=approachEcho(latest,vector),preds=advect(latest,vector,trend),conf=confidenceN(grids,vector),eta=approach?Math.max(0,approach.tHours*60):null,models=await loadModelSupport(p,eta,preds,source),combined=combinedLabel(conf,models,approach,preds,source);
      $n('rnMotion').textContent=vector.speed<4?'prawie stacjonarne':`${compass16(vector.bearing)} · ${Math.round(vector.speed)} km/h`;
      $n('rnMotionSub').textContent=`ruch na ${Math.round(vector.bearing)}° · korelacja ${Math.round(vector.score*100)}/100`;
      $n('rnFrom').textContent=approach?compass16(approach.bearing):compass16((vector.bearing+180)%360);
      $n('rnFromSub').textContent=approach?`echo obecnie ${Math.round(approach.distance)} km od punktu`:'kierunek przeciwny do wektora ruchu';
      $n('rnEta').textContent=approach?(eta<5?'nad punktem / <5 min':`${Math.round(eta)} min`):'nie celuje w punkt';
      $n('rnCpa').textContent=approach?`CPA ~${Math.round(approach.cpa)} km · ${valueText(approach.value,source)}`:'brak echa z CPA ≤28 km w 0–3,5 h';
      $n('rnConfidence').textContent=`${conf}/100`;$n('rnFrames').textContent=`${grids.length} klatek · ${fmtLocal(grids[0].time)}–${fmtLocal(latest.time)} · ${source.toUpperCase()}`;
      $n('rnTrend').textContent=trend.label;$n('rnTrendSub').textContent=trendText(trend,source);
      $n('rnNearest').textContent=nearest?`${Math.round(nearest.distance)} km ${compass16(nearest.bearing)}`:'brak ≥ progu';$n('rnNearestSub').textContent=nearest?valueText(nearest.value,source):`próg ${source==='cmax'?'27 dBZ':'0,1 mm/h'}`;
      $n('rnModels').textContent=models.total?`${models.support}/${models.total} ${models.label}`:'brak danych';$n('rnModelsSub').textContent=models.rows.map(x=>`${x.name} ${x.rain.toFixed(1)} mm/1h`).join(' · ')||'AIFS / GFS / ICON';$n('rnCombined').textContent=combined;
      for(const h of HORIZONS_MIN){const el=$n('rnH'+h);if(el)el.textContent=valueText(preds[h],source);}const wet=HORIZONS_MIN.filter(h=>Number.isFinite(preds[h])&&preds[h]>=ECHO_THRESHOLD[source]);let summary;
      if(approach)summary=`POLRAD wskazuje przemieszczanie echa z ${compass16(approach.bearing)} w kierunku ${compass16(vector.bearing)} z prędkością około ${Math.round(vector.speed)} km/h. Najbliższe podejście do punktu za około ${Math.round(eta)} min, w odległości ~${Math.round(approach.cpa)} km.`;
      else if(wet.length)summary=`Wektor ruchu ${compass16(vector.bearing)} ~${Math.round(vector.speed)} km/h. Adwekcja daje sygnał nad punktem w horyzontach ${wet.map(x=>'+'+x).join(', ')} min, ale nie znaleziono pojedynczego echa z wyraźną trajektorią przez punkt.`;
      else summary=`Echo w analizowanym obszarze porusza się na ${compass16(vector.bearing)} z prędkością ~${Math.round(vector.speed)} km/h, ale obecna trajektoria nie wskazuje przejścia nad punktem w ciągu 0–3 h.`;
      summary+=` Trend intensywności: ${trend.label}. Modele ${models.label}.`;$n('rnSummary').textContent=summary;
      $n('rnModelDetail').innerHTML='<b>Interpretacja:</b> wynik /100 jest pewnością wyznaczenia wektora z kolejnych obrazów, a nie prawdopodobieństwem opadu. Prognoza +30…+180 min zakłada utrzymanie obecnego ruchu i częściowo trendu intensywności; rozwój lub zanik komórek może szybko zmienić wynik.';
      setStatus(`aktualizacja ${new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'})} · klatka ${fmtLocal(latest.time)}`);drawMotionN(p,approach,vector);
      publishN({updatedAt:new Date().toISOString(),point:p,source,frames:grids.length,frameStart:grids[0].time,frameEnd:latest.time,vector:{eastKmh:vector.east,northKmh:vector.north,speedKmh:vector.speed,bearingDeg:vector.bearing,score:vector.score,consistency:vector.consistency},confidence:conf,trend,nearest,approach,etaMin:eta,predictions:preds,models,combined});
    }catch(e){console.error('Radar Nowcast:',e);setStatus('błąd: '+(e?.message||e));$n('rnSummary').textContent='Nie udało się wykonać nowcastu radarowego: '+(e?.message||e)+'. Moduł spróbuje ponownie automatycznie.';publishN({updatedAt:new Date().toISOString(),error:String(e?.message||e),point:p});}
    finally{running=false;}
  }

  ensureUi();setTimeout(()=>runNowcast(true),1800);setInterval(()=>{if(!document.hidden)runNowcast(false);},autoEveryMs);
  for(const id of ['apply','resetPoint','refresh'])$n(id)?.addEventListener('click',()=>setTimeout(()=>runNowcast(true),650));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastRun>autoEveryMs)runNowcast(true);});
  window.PrognozaEPIRRadarNowcastEngine={refresh:()=>runNowcast(true),get:()=>window.PrognozaEPIRRadarNowcast||null};
})();
