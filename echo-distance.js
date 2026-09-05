'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $e = id => document.getElementById(id);
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.4';

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
    .dbz-click-popup{font-size:11px;line-height:1.35;min-width:155px}
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
        <div class="echo-field"><label for="echoDbzThreshold">Próg odbiciowości</label><input id="echoDbzThreshold" type="number" min="5" max="62" step="1" value="40" inputmode="numeric"></div>
        <div class="echo-field"><label for="echoRadius">Promień analizy</label><select id="echoRadius"><option value="25">25 km</option><option value="50">50 km</option><option value="75">75 km</option><option value="100" selected>100 km</option></select></div>
        <button id="echoAnalyze" type="button">Znajdź najbliższe echo</button>
      </div>
      <div class="echo-presets">
        <button type="button" data-echo-preset="20">Echo ≥20 dBZ</button>
        <button type="button" data-echo-preset="30">Opad ≥30 dBZ</button>
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
        <div class="echo-result"><small>Próg / promień</small><strong id="echoSettings">40 dBZ</strong><span>100 km</span></div>
      </div>
      <div id="echoStatus" class="echo-status">Analiza korzysta bezpośrednio z obrazu POLRAD CMAX aktualnie wyświetlanego przez Leaflet. Po uruchomieniu mapa dopasuje się do wybranego promienia; obszar poza okręgiem zostanie przyciemniony.</div>
    </div>`;
  if (dataCard?.nextSibling) rightColumn.insertBefore(card, dataCard.nextSibling); else rightColumn.appendChild(card);

  if (!map.getPane('analysisMaskPane')) {
    map.createPane('analysisMaskPane');
    map.getPane('analysisMaskPane').style.zIndex = '460';
    map.getPane('analysisMaskPane').style.pointerEvents = 'none';
  }
  if (!map.getPane('analysisResultPane')) {
    map.createPane('analysisResultPane');
    map.getPane('analysisResultPane').style.zIndex = '640';
  }

  let echoLine=null, echoMarker=null, maxMarker=null, analysisCircle=null, analysisMask=null;
  let rasterCache=null, shortPress=null, updateTimer=null;

  function clearResultOverlays(keepFocus=false) {
    for (const layer of [echoLine,echoMarker,maxMarker]) if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    echoLine=echoMarker=maxMarker=null;
    if (!keepFocus) {
      for (const layer of [analysisCircle,analysisMask]) if (layer && map.hasLayer(layer)) map.removeLayer(layer);
      analysisCircle=analysisMask=null;
    }
  }

  function compass16(deg) {
    const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round((((deg%360)+360)%360)/22.5)%16];
  }
  function haversineKm(a,b) {
    const R=6371.0088,p1=toRad(a.lat),p2=toRad(b.lat),dp=toRad(b.lat-a.lat),dl=toRad(b.lon-a.lon);
    const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  function initialBearing(a,b) {
    const p1=toRad(a.lat),p2=toRad(b.lat),dl=toRad(b.lon-a.lon);
    const y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    return (toDeg(Math.atan2(y,x))+360)%360;
  }
  function offsetLatLon(center,dxKm,dyKm) {
    return {lat:center.lat+dyKm/111.32,lon:center.lon+dxKm/(111.32*Math.max(.15,Math.cos(toRad(center.lat))))};
  }

  const POLRAD_PALETTE=[
    [5,0,0,115],[8,0,0,210],[11,0,80,255],[14,0,170,255],[17,95,210,255],[20,175,238,242],
    [23,211,246,202],[28,255,255,183],[31,255,246,86],[33,255,220,0],[34,255,157,0],[37,255,70,0],
    [40,255,0,0],[44,205,0,0],[47,165,0,0],[50,140,0,42],[53,205,0,100],[56,230,0,160],[59,245,55,190],[62,255,120,210]
  ];
  function rgbToHsv(r,g,b) {
    r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;
    if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4)}
    if(h<0)h+=360;return {h,s:max?d/max:0,v:max};
  }
  function polradPixelToDbz(r,g,b,a) {
    if(a<24) return null;
    let best=null,dist=Infinity;
    for(const p of POLRAD_PALETTE){const d=(r-p[1])**2+(g-p[2])**2+(b-p[3])**2;if(d<dist){dist=d;best=p[0]}}
    if(dist<6500) return best;
    const hsv=rgbToHsv(r,g,b); if(hsv.s<.30||hsv.v<.18) return null;
    const h=hsv.h,v=hsv.v;
    if(h>=215&&h<270)return v>.80?14:(v>.58?11:8);
    if(h>=190&&h<215)return 17;
    if(h>=165&&h<190)return 20;
    if(h>=95&&h<165)return 23;
    if(h>=52&&h<95)return v>.92?31:28;
    if(h>=38&&h<52)return 34;
    if(h>=20&&h<38)return 37;
    if(h<20||h>=348)return v>.90?40:(v>.72?44:47);
    if(h>=325&&h<348)return 50;
    if(h>=300&&h<325)return v<.78?53:(v<.92?56:59);
    if(h>=270&&h<300)return 62;
    return null;
  }

  function visibleCmaxImage() {
    const imgs=[...map.getContainer().querySelectorAll('.leaflet-overlay-pane img.leaflet-image-layer')];
    return imgs.find(img => img.complete && img.naturalWidth>0 && /\/cmax\//i.test(img.currentSrc||img.src) && getComputedStyle(img).display!=='none');
  }
  async function ensureCmaxImage() {
    const btn=$e('polrad_cmax');
    if(btn && !btn.classList.contains('active')) { btn.click(); rasterCache=null; await sleep(250); }
    for(let i=0;i<40;i++){const img=visibleCmaxImage();if(img)return img;await sleep(100)}
    throw new Error('Nie znaleziono aktualnie wyświetlanego obrazu POLRAD CMAX. Włącz CMAX i spróbuj ponownie.');
  }
  function frameLabel(img) {
    const text=$e('radarTime')?.textContent?.trim();
    if(text) return text.replace(/^CMAX:\s*/i,'');
    const m=(img?.src||'').match(/(20\d{10,12})\.png/); return m?m[1]:'aktualna klatka';
  }
  function imageGeometry(img) {
    const ir=img.getBoundingClientRect(), mr=map.getContainer().getBoundingClientRect();
    if(ir.width<2||ir.height<2) throw new Error('Warstwa CMAX nie ma prawidłowej geometrii na mapie.');
    return {ir,mr,nw:img.naturalWidth,nh:img.naturalHeight};
  }
  async function rasterFromDisplayedImage() {
    const img=await ensureCmaxImage();
    const key=(img.currentSrc||img.src)+'|'+img.naturalWidth+'x'+img.naturalHeight;
    if(rasterCache?.key===key){rasterCache.geo=imageGeometry(img);return rasterCache}
    const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);
    let rgba;try{rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data}catch(_){throw new Error('Przeglądarka zablokowała odczyt pikseli CMAX (CORS).')}
    rasterCache={key,img,rgba,width:canvas.width,height:canvas.height,geo:imageGeometry(img),label:frameLabel(img)};return rasterCache;
  }
  function naturalPixelForLatLng(r,ll) {
    const cp=map.latLngToContainerPoint([ll.lat,ll.lon??ll.lng]);
    const clientX=r.geo.mr.left+cp.x, clientY=r.geo.mr.top+cp.y;
    return {x:(clientX-r.geo.ir.left)/r.geo.ir.width*r.width,y:(clientY-r.geo.ir.top)/r.geo.ir.height*r.height};
  }
  function valueAtPixel(r,x,y) {
    x=Math.round(x);y=Math.round(y);if(x<0||y<0||x>=r.width||y>=r.height)return null;
    const p=(y*r.width+x)*4;return polradPixelToDbz(r.rgba[p],r.rgba[p+1],r.rgba[p+2],r.rgba[p+3]);
  }
  function dbzAtLatLng(r,ll) {
    const p=naturalPixelForLatLng(r,ll); if(p.x<0||p.y<0||p.x>=r.width||p.y>=r.height)return null;
    const vals=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const v=valueAtPixel(r,p.x+dx,p.y+dy);if(Number.isFinite(v))vals.push(v)}
    if(!vals.length)return null;vals.sort((a,b)=>a-b);return vals[Math.floor(vals.length/2)];
  }

  function circleRing(center,radiusKm,count=96) {
    const ring=[];for(let i=0;i<count;i++){const a=2*Math.PI*i/count;ring.push([center.lat+(radiusKm*Math.cos(a))/111.32,center.lon+(radiusKm*Math.sin(a))/(111.32*Math.max(.15,Math.cos(toRad(center.lat))))])}return ring;
  }
  function focusAnalysis(center,radiusKm) {
    for(const layer of [analysisCircle,analysisMask]) if(layer&&map.hasLayer(layer))map.removeLayer(layer);
    const ring=circleRing(center,radiusKm);
    const outer=[[-85,-180],[-85,180],[85,180],[85,-180]];
    analysisMask=L.polygon([outer,ring.slice().reverse()],{pane:'analysisMaskPane',stroke:false,fillColor:'#05070a',fillOpacity:.38,interactive:false}).addTo(map);
    analysisCircle=L.circle([center.lat,center.lon],{pane:'analysisResultPane',radius:radiusKm*1000,color:'#8fa2ff',weight:2,fill:false,dashArray:'6 5',interactive:false}).addTo(map);
    map.fitBounds(analysisCircle.getBounds(),{padding:[28,28]});
  }
  async function waitForMapSettle() {
    await new Promise(resolve=>{let done=false;const f=()=>{if(done)return;done=true;map.off('moveend',f);resolve()};map.once('moveend',f);setTimeout(f,500)});
    await sleep(80);
  }

  async function updateMainPointDbz() {
    try {
      if(typeof point==='undefined')return;const r=await rasterFromDisplayedImage();
      const v=dbzAtLatLng(r,{lat:Number(point.lat),lon:Number(point.lon)}),dbz=$e('dbz'),note=$e('dbzNote');
      if(dbz)dbz.textContent=Number.isFinite(v)?('~'+Math.round(v)+' dBZ'):'brak echa';
      if(note)note.textContent='IMGW/POLRAD CMAX · '+r.label;
    } catch(_) {}
  }

  async function analyzeEcho() {
    const status=$e('echoStatus'),threshold=clamp(Math.round(Number($e('echoDbzThreshold')?.value)||40),5,62),radius=clamp(Number($e('echoRadius')?.value)||100,5,100);
    $e('echoDbzThreshold').value=String(threshold);$e('echoSettings').textContent=threshold+' dBZ';$e('echoSettings').nextElementSibling.textContent=radius+' km';
    clearResultOverlays();
    for(const id of ['echoDistance','echoBearing','echoFoundDbz','echoCoords','echoMaxDbz'])$e(id).textContent='—';$e('echoCompass').textContent='—';$e('echoFrameTime').textContent='—';$e('echoMaxCoords').textContent='—';
    status.classList.remove('error');status.textContent='Dopasowuję mapę do promienia '+radius+' km i analizuję widoczny POLRAD CMAX…';
    try {
      if(typeof point==='undefined'||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lon)))throw new Error('Brak prawidłowego punktu odniesienia.');
      const center={lat:Number(point.lat),lon:Number(point.lon)};focusAnalysis(center,radius);await waitForMapSettle();rasterCache=null;
      const r=await rasterFromDisplayedImage();await updateMainPointDbz();
      const step=radius<=25?.5:radius<=50?.75:radius<=75?1:1.25;
      const samples=[],mask=new Set();let max=null,row=0;
      for(let dy=-radius;dy<=radius;dy+=step){
        for(let dx=-radius;dx<=radius;dx+=step){
          const dist=Math.hypot(dx,dy);if(dist>radius)continue;
          const ll=offsetLatLon(center,dx,dy),v=dbzAtLatLng(r,ll);if(!Number.isFinite(v))continue;
          const ix=Math.round(dx/step),iy=Math.round(dy/step),s={ix,iy,dx,dy,dist,ll,dbz:v};samples.push(s);
          if(v>=threshold)mask.add(ix+','+iy);if(!max||v>max.dbz||(v===max.dbz&&dist<max.dist))max=s;
        }
        if((++row%16)===0)await sleep(0);
      }
      const coherent=s=>{let n=0;for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){if(!xx&&!yy)continue;if(mask.has((s.ix+xx)+','+(s.iy+yy)))n++}return n>=2};
      let nearest=null;for(const s of samples){if(s.dbz<threshold||!coherent(s))continue;if(!nearest||s.dist<nearest.dist)nearest=s}
      $e('echoFrameTime').textContent=r.label;
      if(max){$e('echoMaxDbz').textContent='~'+Math.round(max.dbz)+' dBZ';$e('echoMaxCoords').textContent=max.ll.lat.toFixed(4)+', '+max.ll.lon.toFixed(4);maxMarker=L.circleMarker([max.ll.lat,max.ll.lon],{pane:'analysisResultPane',radius:4,color:'#7b32a8',weight:2,fillColor:'#fff',fillOpacity:.95,interactive:false}).addTo(map)}else{$e('echoMaxDbz').textContent='brak';$e('echoMaxCoords').textContent='brak rozpoznanego echa'}
      if(!nearest){$e('echoDistance').textContent='brak';status.textContent='POLRAD CMAX: w okręgu '+radius+' km nie znaleziono spójnego echa ≥ '+threshold+' dBZ. Maksimum rozpoznane w tym samym okręgu: '+(max?'~'+Math.round(max.dbz)+' dBZ':'brak')+'.';return}
      const target={lat:nearest.ll.lat,lon:nearest.ll.lon},bearing=initialBearing(center,target),dir=compass16(bearing),distance=haversineKm(center,target);
      $e('echoDistance').textContent=distance<10?distance.toFixed(1)+' km':distance.toFixed(0)+' km';$e('echoBearing').textContent=Math.round(bearing)+'°';$e('echoCompass').textContent=dir+' · azymut od punktu do echa';$e('echoFoundDbz').textContent='~'+Math.round(nearest.dbz)+' dBZ';$e('echoCoords').textContent=target.lat.toFixed(4)+', '+target.lon.toFixed(4);
      echoLine=L.polyline([[center.lat,center.lon],[target.lat,target.lon]],{pane:'analysisResultPane',color:'#ff5b52',weight:2,dashArray:'7 5',interactive:false}).addTo(map);
      echoMarker=L.circleMarker([target.lat,target.lon],{pane:'analysisResultPane',radius:6,color:'#ff5b52',weight:2,fillColor:'#fff',fillOpacity:1,interactive:false}).addTo(map);
      status.textContent='Znaleziono najbliższe spójne echo ≥ '+threshold+' dBZ wyłącznie wewnątrz zaznaczonego okręgu '+radius+' km. Źródło: aktualnie widoczny IMGW/POLRAD CMAX ('+r.label+').';
    } catch(e){status.classList.add('error');status.textContent='Analiza CMAX nie powiodła się: '+(e?.message||e)}
  }

  async function showClickedDbz(ll) {
    try{const r=await rasterFromDisplayedImage(),v=dbzAtLatLng(r,{lat:ll.lat,lon:ll.lng}),value=Number.isFinite(v)?('~'+Math.round(v)+' dBZ'):'brak echa';
      L.popup({closeButton:true,autoPan:true}).setLatLng(ll).setContent('<div class="dbz-click-popup"><b>'+value+'</b><br>POLRAD CMAX · '+r.label+'<br><small>'+ll.lat.toFixed(4)+', '+ll.lng.toFixed(4)+'</small></div>').openOn(map)}
    catch(e){L.popup().setLatLng(ll).setContent('<div class="dbz-click-popup">Nie udało się odczytać CMAX.<br><small>'+(e?.message||e)+'</small></div>').openOn(map)}
  }

  const mapEl=$e('map');
  if(mapEl){
    mapEl.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;shortPress={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now()}},{capture:true,passive:true});
    mapEl.addEventListener('pointermove',e=>{if(!shortPress||shortPress.id!==e.pointerId)return;if(Math.hypot(e.clientX-shortPress.x,e.clientY-shortPress.y)>12)shortPress=null},{capture:true,passive:true});
    mapEl.addEventListener('pointerup',e=>{if(!shortPress||shortPress.id!==e.pointerId)return;const s=shortPress;shortPress=null;if(performance.now()-s.t>650)return;const r=mapEl.getBoundingClientRect(),ll=map.containerPointToLatLng(L.point(e.clientX-r.left,e.clientY-r.top));showClickedDbz(ll)},{capture:true,passive:true});
    mapEl.addEventListener('pointercancel',()=>{shortPress=null},{capture:true,passive:true});
  }

  $e('echoAnalyze')?.addEventListener('click',analyzeEcho);
  $e('echoDbzThreshold')?.addEventListener('keydown',e=>{if(e.key==='Enter')analyzeEcho()});
  document.querySelectorAll('[data-echo-preset]').forEach(b=>b.addEventListener('click',()=>{$e('echoDbzThreshold').value=b.dataset.echoPreset;analyzeEcho()}));
  const reset=()=>{clearResultOverlays();rasterCache=null;const s=$e('echoStatus');if(s)s.textContent='Punkt lub klatka zmieniona. Uruchom analizę ponownie.';clearTimeout(updateTimer);updateTimer=setTimeout(updateMainPointDbz,450)};
  $e('apply')?.addEventListener('click',reset);$e('resetPoint')?.addEventListener('click',reset);$e('radarFrame')?.addEventListener('input',()=>{rasterCache=null;clearTimeout(updateTimer);updateTimer=setTimeout(updateMainPointDbz,300)});$e('polrad_cmax')?.addEventListener('click',()=>{rasterCache=null;clearTimeout(updateTimer);updateTimer=setTimeout(updateMainPointDbz,600)});
  map.on('layeradd',()=>{clearTimeout(updateTimer);updateTimer=setTimeout(updateMainPointDbz,350)});
  setTimeout(updateMainPointDbz,1200);
})();
