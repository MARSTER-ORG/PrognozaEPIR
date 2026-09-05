'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $e = id => document.getElementById(id);
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const clampNum = (v,a,b) => Math.max(a, Math.min(b, v));
  const POLRAD_BOUNDS = {south:48.5, west:13.5, north:56.0, east:25.0};
  const CMAX_API = 'https://meteo.imgw.pl/api/radars/v1/list/cmax';

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.2';

  const style = document.createElement('style');
  style.textContent = `
    .echo-tools{padding:9px 10px}
    .echo-controls{display:flex;flex-wrap:wrap;gap:7px;align-items:end}
    .echo-field{display:flex;flex-direction:column;gap:3px;min-width:105px}
    .echo-field label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
    .echo-field input,.echo-field select,.echo-controls button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:7px;padding:7px 9px;font-size:11px}
    .echo-controls button{background:var(--blue2);color:#fff;border-color:var(--blue2);font-weight:700}
    .echo-presets{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
    .echo-presets button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:6px;padding:5px 7px;font-size:9px}
    .echo-results{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:9px}
    .echo-result{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:58px}
    .echo-result small{display:block;color:var(--muted);font-size:9px;margin-bottom:3px}
    .echo-result strong{display:block;font-size:15px;line-height:1.1}
    .echo-result span{display:block;color:var(--muted);font-size:8.5px;margin-top:3px;overflow-wrap:anywhere}
    .echo-status{margin-top:8px;font-size:9px;color:var(--muted);line-height:1.35}
    .echo-status.error{color:var(--red)}
    .dbz-click-popup{font-size:11px;line-height:1.35;min-width:150px}
    .dbz-click-popup b{font-size:14px;color:#1f2a75}
    @media(max-width:560px){.echo-results{grid-template-columns:repeat(2,minmax(0,1fr))}.echo-field{min-width:92px;flex:1}.echo-controls button{width:100%}}
  `;
  document.head.appendChild(style);

  const rightColumn = document.querySelector('.layout > div:nth-child(2)');
  if (!rightColumn || $e('echoDistanceCard')) return;

  const dataCard = [...rightColumn.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('Dane dla punktu'));
  const card = document.createElement('section');
  card.id = 'echoDistanceCard';
  card.className = 'card';
  card.style.marginTop = '8px';
  card.innerHTML = `
    <h2>Najbliższe echo radarowe · POLRAD CMAX</h2>
    <div class="echo-tools">
      <div class="echo-controls">
        <div class="echo-field">
          <label for="echoDbzThreshold">Próg odbiciowości</label>
          <input id="echoDbzThreshold" type="number" min="5" max="62" step="1" value="45" inputmode="numeric">
        </div>
        <div class="echo-field">
          <label for="echoRadius">Promień analizy</label>
          <select id="echoRadius">
            <option value="25">25 km</option>
            <option value="50">50 km</option>
            <option value="75">75 km</option>
            <option value="100" selected>100 km</option>
          </select>
        </div>
        <button id="echoAnalyze" type="button">Znajdź najbliższe echo</button>
      </div>
      <div class="echo-presets">
        <button type="button" data-echo-preset="20">Echo ≥20 dBZ</button>
        <button type="button" data-echo-preset="35">Opad ≥35 dBZ</button>
        <button type="button" data-echo-preset="40">Mocniejsze echo ≥40 dBZ</button>
        <button type="button" data-echo-preset="45">Silne echo ≥45 dBZ</button>
        <button type="button" data-echo-preset="50">Konwekcyjne ≥50 dBZ</button>
      </div>
      <div class="echo-results">
        <div class="echo-result"><small>Odległość</small><strong id="echoDistance">—</strong><span>od zaznaczonego punktu</span></div>
        <div class="echo-result"><small>Azymut</small><strong id="echoBearing">—</strong><span id="echoCompass">—</span></div>
        <div class="echo-result"><small>Odbiciowość echa</small><strong id="echoFoundDbz">—</strong><span id="echoFrameTime">—</span></div>
        <div class="echo-result"><small>Współrzędne echa</small><strong id="echoCoords">—</strong><span>najbliższy spójny obszar ≥ progu</span></div>
        <div class="echo-result"><small>Maksimum w promieniu</small><strong id="echoMaxDbz">—</strong><span id="echoMaxCoords">—</span></div>
        <div class="echo-result"><small>Próg / promień</small><strong id="echoSettings">45 dBZ</strong><span>100 km</span></div>
      </div>
      <div id="echoStatus" class="echo-status">Źródło analizy: oficjalny IMGW/POLRAD CMAX. Krótkie dotknięcie mapy pokazuje odbiciowość CMAX dokładnie dla dotkniętego miejsca. Przytrzymanie 3 s nadal zmienia punkt prognozy.</div>
    </div>`;

  if (dataCard?.nextSibling) rightColumn.insertBefore(card, dataCard.nextSibling);
  else if (dataCard) rightColumn.appendChild(card);
  else rightColumn.prepend(card);

  let echoLine = null;
  let echoMarker = null;
  let maxMarker = null;
  let cmaxFramesCache = null;
  let cmaxCacheTime = 0;
  let rasterCache = null;
  let shortPress = null;

  function clearEchoOverlay() {
    if (echoLine) map.removeLayer(echoLine);
    if (echoMarker) map.removeLayer(echoMarker);
    if (maxMarker) map.removeLayer(maxMarker);
    echoLine = echoMarker = maxMarker = null;
  }

  function fmtFrame(sec) {
    return new Intl.DateTimeFormat('pl-PL', {
      timeZone:'Europe/Warsaw', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
    }).format(new Date(Number(sec) * 1000));
  }

  function compass16(deg) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  }

  function haversineKm(a, b) {
    const R = 6371.0088;
    const p1 = toRad(a.lat), p2 = toRad(b.lat);
    const dp = toRad(b.lat - a.lat), dl = toRad(b.lon - a.lon);
    const h = Math.sin(dp/2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function initialBearing(a, b) {
    const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function projectedCorners() {
    const nw = map.project(L.latLng(POLRAD_BOUNDS.north, POLRAD_BOUNDS.west), 0);
    const se = map.project(L.latLng(POLRAD_BOUNDS.south, POLRAD_BOUNDS.east), 0);
    return {nw,se};
  }

  function latLngToImagePixel(ll, width, height) {
    const {nw,se} = projectedCorners();
    const p = map.project(L.latLng(ll.lat,ll.lon ?? ll.lng), 0);
    return {
      x:(p.x-nw.x)/(se.x-nw.x)*width,
      y:(p.y-nw.y)/(se.y-nw.y)*height
    };
  }

  function imagePixelToLatLng(x, y, width, height) {
    const {nw,se} = projectedCorners();
    const px = nw.x + ((x + 0.5) / width) * (se.x - nw.x);
    const py = nw.y + ((y + 0.5) / height) * (se.y - nw.y);
    const ll = map.unproject(L.point(px,py), 0);
    return {lat:ll.lat, lon:ll.lng};
  }

  const POLRAD_PALETTE = [
    [5,0,0,115],[8,0,0,210],[11,0,80,255],[14,0,170,255],[17,95,210,255],
    [20,175,238,242],[23,211,246,202],[28,255,255,183],[31,255,246,86],
    [33,255,220,0],[34,255,157,0],[37,255,70,0],[40,255,0,0],[44,205,0,0],
    [47,165,0,0],[50,140,0,42],[53,205,0,100],[56,230,0,160],[59,245,55,190],[62,255,120,210]
  ];

  function rgbToHsv(r,g,b) {
    r/=255; g/=255; b/=255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
    let h=0;
    if (d) {
      if (max===r) h=60*(((g-b)/d)%6);
      else if (max===g) h=60*((b-r)/d+2);
      else h=60*((r-g)/d+4);
    }
    if (h<0) h+=360;
    return {h,s:max?d/max:0,v:max};
  }

  function polradPixelToDbz(r,g,b,a) {
    if (a < 35) return null;
    let best=null, dist=Infinity;
    for (const p of POLRAD_PALETTE) {
      const d=(r-p[1])**2+(g-p[2])**2+(b-p[3])**2;
      if (d<dist) {dist=d; best=p[0];}
    }
    if (dist <= 9000) return best;

    const hsv=rgbToHsv(r,g,b);
    if (hsv.s < 0.38 || hsv.v < 0.20) return null;
    const h=hsv.h, v=hsv.v;
    if (h>=215 && h<=265) return v<0.62?5:(v<0.82?8:11);
    if (h>=185 && h<215) return v<0.78?14:17;
    if (h>=155 && h<185) return 20;
    if (h>=85 && h<155) return 23;
    if (h>=48 && h<85) return v>0.90?31:28;
    if (h>=30 && h<48) return 34;
    if (h>=12 && h<30) return 37;
    if (h<12 || h>=350) return v>0.88?40:(v>0.68?44:47);
    if (h>=325 && h<350) return 50;
    if (h>=300 && h<325) return v<0.78?53:(v<0.92?56:59);
    if (h>=280 && h<300) return 62;
    return null;
  }

  function normalizeImgwUrl(url) {
    return String(url || '').replace(/^http:\/\//i,'https://');
  }

  async function getCmaxFrames(force=false) {
    if (!force && cmaxFramesCache && Date.now()-cmaxCacheTime < 60000) return cmaxFramesCache;
    const ctl=new AbortController();
    const timer=setTimeout(()=>ctl.abort(),12000);
    try {
      const r=await fetch(CMAX_API,{cache:'no-cache',signal:ctl.signal});
      if (!r.ok) throw new Error('CMAX HTTP '+r.status);
      const j=await r.json();
      const list=j?.cmax?.list;
      if (!Array.isArray(list)||!list.length) throw new Error('brak klatek CMAX');
      cmaxFramesCache=list.filter(f=>f?.url&&Number.isFinite(Number(f.date))).sort((a,b)=>Number(a.date)-Number(b.date));
      cmaxCacheTime=Date.now();
      return cmaxFramesCache;
    } finally {clearTimeout(timer);}
  }

  async function currentCmaxFrame() {
    const frames=await getCmaxFrames();
    const slider=$e('radarFrame');
    const cmaxActive=$e('polrad_cmax')?.classList.contains('active');
    if (cmaxActive && slider) {
      const i=clampNum(Math.round(Number(slider.value)||0),0,frames.length-1);
      return frames[i] || frames.at(-1);
    }
    const targetText=$e('radarTime')?.textContent || '';
    const m=targetText.match(/(\d{1,2}):(\d{2})/);
    if (m) {
      const hh=Number(m[1]), mm=Number(m[2]);
      let best=frames.at(-1), delta=Infinity;
      for (const f of frames) {
        const d=new Date(Number(f.date)*1000);
        const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d);
        const H=Number(parts.find(p=>p.type==='hour')?.value), M=Number(parts.find(p=>p.type==='minute')?.value);
        const x=Math.abs((H*60+M)-(hh*60+mm));
        if (x<delta){delta=x;best=f;}
      }
      return best;
    }
    return frames.at(-1);
  }

  function loadImage(url) {
    return new Promise((resolve,reject)=>{
      const img=new Image();
      img.crossOrigin='anonymous';
      img.onload=()=>resolve(img);
      img.onerror=()=>reject(new Error('Nie udało się pobrać obrazu POLRAD CMAX.'));
      img.src=normalizeImgwUrl(url);
    });
  }

  async function getCurrentRaster() {
    const frame=await currentCmaxFrame();
    if (rasterCache && rasterCache.frameDate===Number(frame.date)) return rasterCache;
    const img=await loadImage(frame.url);
    const canvas=document.createElement('canvas');
    canvas.width=img.naturalWidth||img.width;
    canvas.height=img.naturalHeight||img.height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    let rgba;
    try {rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;}
    catch(e){throw new Error('Przeglądarka zablokowała odczyt pikseli obrazu POLRAD (CORS).');}
    rasterCache={frameDate:Number(frame.date),frame,width:canvas.width,height:canvas.height,rgba};
    return rasterCache;
  }

  function pixelValue(raster,x,y) {
    x=Math.round(x); y=Math.round(y);
    if (x<0||y<0||x>=raster.width||y>=raster.height) return null;
    const p=(y*raster.width+x)*4;
    return polradPixelToDbz(raster.rgba[p],raster.rgba[p+1],raster.rgba[p+2],raster.rgba[p+3]);
  }

  function pointDbzFromRaster(raster,ll) {
    const p=latLngToImagePixel(ll,raster.width,raster.height);
    if (p.x<0||p.y<0||p.x>=raster.width||p.y>=raster.height) return null;
    const center=pixelValue(raster,p.x,p.y);
    if (Number.isFinite(center)) return center;
    const vals=[];
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      if(!dx&&!dy) continue;
      const v=pixelValue(raster,p.x+dx,p.y+dy);
      if(Number.isFinite(v)) vals.push(v);
    }
    if (!vals.length) return null;
    vals.sort((a,b)=>a-b);
    return vals[Math.floor(vals.length/2)];
  }

  function updateMainPointDbz(raster) {
    if (typeof point==='undefined') return;
    const v=pointDbzFromRaster(raster,{lat:Number(point.lat),lon:Number(point.lon)});
    const dbz=$e('dbz'), note=$e('dbzNote');
    if (dbz) dbz.textContent=Number.isFinite(v)?('~'+Math.round(v)+' dBZ'):'brak echa';
    if (note) note.textContent='IMGW/POLRAD CMAX · '+fmtFrame(raster.frame.date);
  }

  function coherent(mask,x,y,w,h) {
    let n=0;
    for(let yy=Math.max(0,y-1);yy<=Math.min(h-1,y+1);yy++) {
      for(let xx=Math.max(0,x-1);xx<=Math.min(w-1,x+1);xx++) {
        if(xx===x&&yy===y) continue;
        if(mask[yy*w+xx]) n++;
      }
    }
    return n>=3;
  }

  async function analyzeEcho() {
    const status=$e('echoStatus');
    const thresholdInput=$e('echoDbzThreshold');
    const radiusInput=$e('echoRadius');
    const threshold=clampNum(Math.round(Number(thresholdInput?.value)||45),5,62);
    const radius=clampNum(Number(radiusInput?.value)||100,5,100);
    if(thresholdInput) thresholdInput.value=String(threshold);
    $e('echoSettings').textContent=threshold+' dBZ';
    $e('echoSettings').nextElementSibling.textContent=radius+' km';

    clearEchoOverlay();
    for(const id of ['echoDistance','echoBearing','echoFoundDbz','echoCoords','echoMaxDbz']) $e(id).textContent='—';
    $e('echoCompass').textContent='—';
    $e('echoFrameTime').textContent='—';
    $e('echoMaxCoords').textContent='—';
    status.classList.remove('error');
    status.textContent='Analizuję dokładnie tę samą siatkę POLRAD CMAX…';

    try {
      if(typeof point==='undefined'||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lon))) throw new Error('Brak prawidłowego punktu odniesienia.');
      const center={lat:Number(point.lat),lon:Number(point.lon)};
      const raster=await getCurrentRaster();
      updateMainPointDbz(raster);
      const w=raster.width,h=raster.height;
      const dbz=new Int16Array(w*h); dbz.fill(-999);
      const mask=new Uint8Array(w*h);
      const valid=new Uint8Array(w*h);
      let max=null;

      const latPad=radius/111.2;
      const lonPad=radius/(111.2*Math.max(.2,Math.cos(toRad(center.lat))));
      const p1=latLngToImagePixel({lat:center.lat+latPad,lon:center.lon-lonPad},w,h);
      const p2=latLngToImagePixel({lat:center.lat-latPad,lon:center.lon+lonPad},w,h);
      const x0=clampNum(Math.floor(Math.min(p1.x,p2.x))-2,0,w-1);
      const x1=clampNum(Math.ceil(Math.max(p1.x,p2.x))+2,0,w-1);
      const y0=clampNum(Math.floor(Math.min(p1.y,p2.y))-2,0,h-1);
      const y1=clampNum(Math.ceil(Math.max(p1.y,p2.y))+2,0,h-1);

      for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) {
        const i=y*w+x,p=i*4;
        const v=polradPixelToDbz(raster.rgba[p],raster.rgba[p+1],raster.rgba[p+2],raster.rgba[p+3]);
        if(!Number.isFinite(v)) continue;
        const ll=imagePixelToLatLng(x,y,w,h);
        const dist=haversineKm(center,ll);
        if(dist>radius) continue;
        dbz[i]=Math.round(v); valid[i]=1;
        if(v>=threshold) mask[i]=1;
      }

      let nearest=null;
      for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) {
        const i=y*w+x;
        if(valid[i]&&coherent(valid,x,y,w,h)) {
          const ll=imagePixelToLatLng(x,y,w,h);
          const dist=haversineKm(center,ll);
          if(dist<=radius && (!max||dbz[i]>max.dbz||(dbz[i]===max.dbz&&dist<max.distance))) max={dbz:dbz[i],distance:dist,...ll};
        }
        if(!mask[i]||!coherent(mask,x,y,w,h)) continue;
        const ll=imagePixelToLatLng(x,y,w,h);
        const dist=haversineKm(center,ll);
        if(dist>radius) continue;
        if(!nearest||dist<nearest.distance) nearest={dbz:dbz[i],distance:dist,...ll};
      }

      if(max) {
        $e('echoMaxDbz').textContent='~'+Math.round(max.dbz)+' dBZ';
        $e('echoMaxCoords').textContent=max.lat.toFixed(4)+', '+max.lon.toFixed(4);
        maxMarker=L.circleMarker([max.lat,max.lon],{radius:5,color:'#7b32a8',weight:2,fillColor:'#fff',fillOpacity:.9}).addTo(map).bindTooltip('CMAX maksimum: ~'+Math.round(max.dbz)+' dBZ');
      } else {
        $e('echoMaxDbz').textContent='brak';
        $e('echoMaxCoords').textContent='brak rozpoznanego echa';
      }

      $e('echoFrameTime').textContent=fmtFrame(raster.frame.date);
      if(!nearest) {
        $e('echoDistance').textContent='brak';
        status.textContent='POLRAD CMAX: nie znaleziono spójnego echa ≥ '+threshold+' dBZ w promieniu '+radius+' km. Klatka '+fmtFrame(raster.frame.date)+'.';
        return;
      }

      const bearing=initialBearing(center,nearest),dir=compass16(bearing);
      $e('echoDistance').textContent=nearest.distance<10?nearest.distance.toFixed(1)+' km':nearest.distance.toFixed(0)+' km';
      $e('echoBearing').textContent=Math.round(bearing)+'°';
      $e('echoCompass').textContent=dir+' · azymut od punktu do echa';
      $e('echoFoundDbz').textContent='~'+Math.round(nearest.dbz)+' dBZ';
      $e('echoCoords').textContent=nearest.lat.toFixed(4)+', '+nearest.lon.toFixed(4);
      echoLine=L.polyline([[center.lat,center.lon],[nearest.lat,nearest.lon]],{color:'#d43d31',weight:2,dashArray:'7 5'}).addTo(map);
      echoMarker=L.circleMarker([nearest.lat,nearest.lon],{radius:6,color:'#d43d31',weight:2,fillColor:'#fff',fillOpacity:1}).addTo(map).bindTooltip('Najbliższe CMAX ≥'+threshold+' dBZ · '+(nearest.distance<10?nearest.distance.toFixed(1):nearest.distance.toFixed(0))+' km · '+Math.round(bearing)+'°');
      status.textContent='Źródło: IMGW/POLRAD CMAX · '+fmtFrame(raster.frame.date)+'. Wynik jest liczony z tej samej klatki i tego samego położenia obrazu, które wykorzystuje warstwa CMAX na mapie.';
    } catch(e) {
      status.classList.add('error');
      status.textContent='Nie udało się wykonać analizy POLRAD CMAX: '+(e?.message||e);
    }
  }

  async function showClickedDbz(ll) {
    try {
      const raster=await getCurrentRaster();
      const v=pointDbzFromRaster(raster,{lat:ll.lat,lon:ll.lng});
      const value=Number.isFinite(v)?('~'+Math.round(v)+' dBZ'):'brak echa ≥5 dBZ';
      const html='<div class="dbz-click-popup"><b>'+value+'</b><br>POLRAD CMAX · '+fmtFrame(raster.frame.date)+'<br><small>'+ll.lat.toFixed(4)+', '+ll.lng.toFixed(4)+'</small></div>';
      L.popup({closeButton:true,autoPan:true}).setLatLng(ll).setContent(html).openOn(map);
    } catch(e) {
      L.popup().setLatLng(ll).setContent('<div class="dbz-click-popup">Nie udało się odczytać CMAX.<br><small>'+(e?.message||e)+'</small></div>').openOn(map);
    }
  }

  const mapEl=$e('map');
  if(mapEl) {
    mapEl.addEventListener('pointerdown',e=>{
      if(e.pointerType==='mouse'&&e.button!==0) return;
      shortPress={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now()};
    },{capture:true,passive:true});
    mapEl.addEventListener('pointermove',e=>{
      if(!shortPress||shortPress.id!==e.pointerId) return;
      if(Math.hypot(e.clientX-shortPress.x,e.clientY-shortPress.y)>12) shortPress=null;
    },{capture:true,passive:true});
    mapEl.addEventListener('pointerup',e=>{
      if(!shortPress||shortPress.id!==e.pointerId) return;
      const s=shortPress; shortPress=null;
      if(performance.now()-s.t>650) return;
      const r=mapEl.getBoundingClientRect();
      const ll=map.containerPointToLatLng(L.point(e.clientX-r.left,e.clientY-r.top));
      showClickedDbz(ll);
    },{capture:true,passive:true});
    mapEl.addEventListener('pointercancel',()=>{shortPress=null;},{capture:true,passive:true});
  }

  $e('echoAnalyze')?.addEventListener('click',analyzeEcho);
  $e('echoDbzThreshold')?.addEventListener('keydown',e=>{if(e.key==='Enter') analyzeEcho();});
  document.querySelectorAll('[data-echo-preset]').forEach(b=>b.addEventListener('click',()=>{
    $e('echoDbzThreshold').value=b.dataset.echoPreset;
    analyzeEcho();
  }));

  const resetAnalysis=()=>{
    clearEchoOverlay(); rasterCache=null;
    const status=$e('echoStatus');
    if(status) status.textContent='Punkt lub klatka zmieniona. Analiza będzie wykonana ponownie z POLRAD CMAX.';
    setTimeout(async()=>{try{const r=await getCurrentRaster();updateMainPointDbz(r);}catch(_){}},250);
  };
  $e('apply')?.addEventListener('click',resetAnalysis);
  $e('resetPoint')?.addEventListener('click',resetAnalysis);
  $e('radarFrame')?.addEventListener('input',()=>{rasterCache=null;});
  $e('polrad_cmax')?.addEventListener('click',()=>{rasterCache=null;});

  setTimeout(async()=>{try{const r=await getCurrentRaster();updateMainPointDbz(r);}catch(_){}},1200);
})();
