'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $ = id => document.getElementById(id);
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.5';

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
    .echo-info{margin-top:8px;font-size:9px;color:var(--muted);line-height:1.35}
    .echo-info.error{color:var(--red)}
    .dbz-click-popup{font-size:11px;line-height:1.35;min-width:150px}
    .dbz-click-popup b{font-size:14px;color:#1f2a75}
    @media(max-width:560px){.echo-results{grid-template-columns:repeat(2,minmax(0,1fr))}.echo-field{min-width:92px;flex:1}.echo-controls button{width:100%}}
  `;
  document.head.appendChild(style);

  const rightColumn = document.querySelector('.layout > div:nth-child(2)');
  if (!rightColumn) return;
  document.getElementById('echoDistanceCard')?.remove();
  const dataCard = [...rightColumn.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('Dane dla punktu'));

  const card = document.createElement('section');
  card.id = 'echoDistanceCard';
  card.className = 'card';
  card.style.marginTop = '8px';
  card.innerHTML = `
    <h2>Najbliższe echo radarowe · POLRAD CMAX</h2>
    <div class="echo-tools">
      <div class="echo-controls">
        <div class="echo-field"><label for="echoDbzThreshold">Próg odbiciowości</label><input id="echoDbzThreshold" type="number" min="15" max="60" step="1" value="40" inputmode="numeric"></div>
        <div class="echo-field"><label for="echoRadius">Promień analizy</label><select id="echoRadius"><option value="25">25 km</option><option value="50">50 km</option><option value="75">75 km</option><option value="100" selected>100 km</option></select></div>
        <button id="echoAnalyze" type="button">Znajdź najbliższe echo</button>
      </div>
      <div class="echo-presets">
        <button type="button" data-echo-preset="27">Echo ≥27 dBZ</button>
        <button type="button" data-echo-preset="35">Opad ≥35 dBZ</button>
        <button type="button" data-echo-preset="40">Mocniejsze echo ≥40 dBZ</button>
        <button type="button" data-echo-preset="45">Silne echo ≥45 dBZ</button>
        <button type="button" data-echo-preset="50">Konwekcyjne ≥50 dBZ</button>
        <button type="button" data-echo-preset="55">Bardzo silne ≥55 dBZ</button>
      </div>
      <div class="echo-results">
        <div class="echo-result"><small>Odległość</small><strong id="echoDistance">—</strong><span>od zaznaczonego punktu</span></div>
        <div class="echo-result"><small>Azymut</small><strong id="echoBearing">—</strong><span id="echoCompass">—</span></div>
        <div class="echo-result"><small>Odbiciowość echa</small><strong id="echoFoundDbz">—</strong><span id="echoFrameTime">—</span></div>
        <div class="echo-result"><small>Współrzędne echa</small><strong id="echoCoords">—</strong><span>najbliższy spójny obszar ≥ progu</span></div>
        <div class="echo-result"><small>Maksimum w promieniu</small><strong id="echoMaxDbz">—</strong><span id="echoMaxCoords">—</span></div>
        <div class="echo-result"><small>Próg / promień</small><strong id="echoSettings">40 dBZ</strong><span>100 km</span></div>
      </div>
      <div id="echoInfo" class="echo-info">Odczyt CMAX jest klasyfikowany zgodnie z legendą obrazu: 27–34, 35–44, 45–49, 50–54 i ≥55 dBZ. Wynik jest zakresem klasy, a nie sztucznie wyliczoną wartością pojedynczego piksela.</div>
    </div>`;
  if (dataCard?.nextSibling) rightColumn.insertBefore(card, dataCard.nextSibling); else rightColumn.appendChild(card);

  if (!map.getPane('analysisMaskPane')) {
    map.createPane('analysisMaskPane');
    map.getPane('analysisMaskPane').style.zIndex = '460';
    map.getPane('analysisMaskPane').style.pointerEvents = 'none';
  }
  if (!map.getPane('analysisResultPane')) {
    map.createPane('analysisResultPane');
    map.getPane('analysisResultPane').style.zIndex = '645';
    map.getPane('analysisResultPane').style.pointerEvents = 'none';
  }

  let analysisCircle = null;
  let analysisMask = null;
  let resultLine = null;
  let resultMarker = null;
  let shortPress = null;
  let rasterCache = null;
  const hiddenBaseRings = [];

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
  function compass16(deg) {
    const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round((((deg%360)+360)%360)/22.5)%16];
  }
  function destination(center,bearingDeg,dKm) {
    const R=6371.0088,br=toRad(bearingDeg),p1=toRad(center.lat),l1=toRad(center.lon),dr=dKm/R;
    const p2=Math.asin(Math.sin(p1)*Math.cos(dr)+Math.cos(p1)*Math.sin(dr)*Math.cos(br));
    const l2=l1+Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(p1),Math.cos(dr)-Math.sin(p1)*Math.sin(p2));
    return {lat:toDeg(p2),lon:((toDeg(l2)+540)%360)-180};
  }

  function rgbToHsv(r,g,b) {
    r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;
    if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4)}
    if(h<0)h+=360;return {h,s:max?d/max:0,v:max};
  }

  // IMGW CMAX 900-watermark uses five visible reflectivity classes in the
  // embedded legend. Decode classes, not invented 5/8/11 dBZ steps.
  function classifyCmax(r,g,b,a) {
    if (a < 24) return null;
    const {h,s,v}=rgbToHsv(r,g,b);
    if (s < 0.28 || v < 0.18) return null;
    // blue / violet-blue: ~27–34 dBZ
    if (h >= 205 && h < 280) return {lo:27,hi:34,rep:31,label:'27–34 dBZ'};
    // cyan / turquoise / green-cyan: ~35–44 dBZ
    if (h >= 80 && h < 205) return {lo:35,hi:44,rep:40,label:'35–44 dBZ'};
    // yellow / orange: ~45–49 dBZ
    if (h >= 18 && h < 80) return {lo:45,hi:49,rep:47,label:'45–49 dBZ'};
    // red: ~50–54 dBZ
    if (h < 18 || h >= 348) return {lo:50,hi:54,rep:52,label:'50–54 dBZ'};
    // magenta / pink / purple-red: >=55 dBZ
    if (h >= 280 && h < 348) return {lo:55,hi:65,rep:58,label:'≥55 dBZ'};
    return null;
  }
  const meets = (cls,threshold) => cls && cls.hi >= threshold;

  function visibleCmaxImage() {
    const imgs=[...map.getContainer().querySelectorAll('.leaflet-overlay-pane img.leaflet-image-layer')];
    return imgs.find(img => img.complete && img.naturalWidth>0 && /\/cmax\//i.test(img.currentSrc||img.src) && getComputedStyle(img).display!=='none');
  }
  function cmaxEnabled() {
    return !!$('polrad_cmax')?.classList.contains('active') && !!visibleCmaxImage();
  }
  function frameLabel() {
    return ($('radarTime')?.textContent||'').replace(/^CMAX:\s*/i,'').trim() || 'aktualna klatka';
  }
  function imageGeometry(img) {
    const ir=img.getBoundingClientRect(),mr=map.getContainer().getBoundingClientRect();
    if(ir.width<2||ir.height<2) throw new Error('Warstwa CMAX nie ma prawidłowej geometrii.');
    return {ir,mr};
  }
  async function getRaster() {
    if(!cmaxEnabled()) throw new Error('Włącz warstwę POLRAD CMAX, aby analizować dokładnie to, co jest widoczne na mapie.');
    const img=visibleCmaxImage();
    const key=(img.currentSrc||img.src)+'|'+img.naturalWidth+'x'+img.naturalHeight;
    if(rasterCache?.key===key){rasterCache.geo=imageGeometry(img);return rasterCache;}
    const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);
    let rgba;try{rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;}catch(_){throw new Error('Przeglądarka zablokowała odczyt pikseli POLRAD CMAX (CORS).');}
    rasterCache={key,width:canvas.width,height:canvas.height,rgba,geo:imageGeometry(img),label:frameLabel()};
    return rasterCache;
  }
  function classAtPixel(r,x,y) {
    x=Math.round(x);y=Math.round(y);if(x<0||y<0||x>=r.width||y>=r.height)return null;
    const p=(y*r.width+x)*4;return classifyCmax(r.rgba[p],r.rgba[p+1],r.rgba[p+2],r.rgba[p+3]);
  }
  function naturalToContainer(r,x,y) {
    const clientX=r.geo.ir.left+((x+.5)/r.width)*r.geo.ir.width;
    const clientY=r.geo.ir.top+((y+.5)/r.height)*r.geo.ir.height;
    return L.point(clientX-r.geo.mr.left,clientY-r.geo.mr.top);
  }
  function containerToNatural(r,cp) {
    const clientX=r.geo.mr.left+cp.x,clientY=r.geo.mr.top+cp.y;
    return {x:(clientX-r.geo.ir.left)/r.geo.ir.width*r.width,y:(clientY-r.geo.ir.top)/r.geo.ir.height*r.height};
  }
  function classAtLatLng(r,ll) {
    const cp=map.latLngToContainerPoint([ll.lat,ll.lon??ll.lng]);
    const p=containerToNatural(r,cp);const classes=[];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const c=classAtPixel(r,p.x+dx,p.y+dy);if(c)classes.push(c);}
    if(!classes.length)return null;classes.sort((a,b)=>a.rep-b.rep);return classes[Math.floor(classes.length/2)];
  }

  function hideBaseRings() {
    hiddenBaseRings.length=0;
    map.eachLayer(layer=>{
      if(layer instanceof L.Circle && !(layer instanceof L.CircleMarker) && layer!==analysisCircle && layer.options?.pane!=='analysisResultPane'){
        if(String(layer.options?.dashArray||'').includes('4')){
          hiddenBaseRings.push({layer,opacity:layer.options.opacity,fillOpacity:layer.options.fillOpacity});
          layer.setStyle({opacity:0,fillOpacity:0});
        }
      }
    });
  }
  function restoreBaseRings() {
    for(const x of hiddenBaseRings){try{x.layer.setStyle({opacity:x.opacity??1,fillOpacity:x.fillOpacity??0});}catch(_){}}
    hiddenBaseRings.length=0;
  }
  function clearAnalysis(restore=true) {
    for(const layer of [analysisCircle,analysisMask,resultLine,resultMarker]) if(layer&&map.hasLayer(layer))map.removeLayer(layer);
    analysisCircle=analysisMask=resultLine=resultMarker=null;
    if(restore)restoreBaseRings();
  }
  function ring(center,radiusKm,count=96) {
    const out=[];for(let i=0;i<count;i++){const p=destination(center,i*360/count,radiusKm);out.push([p.lat,p.lon]);}return out;
  }
  function focusCircle(center,radiusKm) {
    clearAnalysis(false);restoreBaseRings();hideBaseRings();
    const inner=ring(center,radiusKm),outer=[[-85,-180],[-85,180],[85,180],[85,-180]];
    analysisMask=L.polygon([outer,inner.slice().reverse()],{pane:'analysisMaskPane',stroke:false,fillColor:'#05070a',fillOpacity:.46,interactive:false}).addTo(map);
    analysisCircle=L.circle([center.lat,center.lon],{pane:'analysisResultPane',radius:radiusKm*1000,color:'#8fa2ff',weight:2,fill:false,dashArray:'6 5',interactive:false}).addTo(map);
    map.fitBounds(analysisCircle.getBounds(),{padding:[24,24]});
  }
  async function settle(){await new Promise(resolve=>{let done=false;const f=()=>{if(done)return;done=true;map.off('moveend',f);resolve();};map.once('moveend',f);setTimeout(f,650);});await sleep(80);}

  function resetFields(threshold,radius){
    $('echoSettings').textContent=threshold+' dBZ';$('echoSettings').nextElementSibling.textContent=radius+' km';
    for(const id of ['echoDistance','echoBearing','echoFoundDbz','echoCoords','echoMaxDbz'])$(id).textContent='—';
    $('echoCompass').textContent='—';$('echoFrameTime').textContent='—';$('echoMaxCoords').textContent='—';
  }

  async function analyze() {
    const info=$('echoInfo'),threshold=clamp(Math.round(Number($('echoDbzThreshold')?.value)||40),15,60),radius=clamp(Number($('echoRadius')?.value)||100,5,100);
    $('echoDbzThreshold').value=String(threshold);resetFields(threshold,radius);info.classList.remove('error');
    try{
      if(typeof point==='undefined'||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lon)))throw new Error('Brak prawidłowego punktu odniesienia.');
      if(!cmaxEnabled())throw new Error('POLRAD CMAX jest wyłączony. Włącz CMAX i ponownie uruchom analizę.');
      const center={lat:Number(point.lat),lon:Number(point.lon)};
      info.textContent='Dopasowuję mapę do '+radius+' km i analizuję piksele CMAX wyłącznie wewnątrz okręgu…';
      focusCircle(center,radius);await settle();rasterCache=null;
      const r=await getRaster();
      const centerCp=map.latLngToContainerPoint([center.lat,center.lon]);
      const dirs=[0,90,180,270].map(b=>map.latLngToContainerPoint(Object.values(destination(center,b,radius))));
      const radiusPx=dirs.reduce((s,p)=>s+centerCp.distanceTo(p),0)/dirs.length;
      const minCp=L.point(centerCp.x-radiusPx,centerCp.y-radiusPx),maxCp=L.point(centerCp.x+radiusPx,centerCp.y+radiusPx);
      const np1=containerToNatural(r,minCp),np2=containerToNatural(r,maxCp);
      const x0=clamp(Math.floor(Math.min(np1.x,np2.x))-2,0,r.width-1),x1=clamp(Math.ceil(Math.max(np1.x,np2.x))+2,0,r.width-1);
      const y0=clamp(Math.floor(Math.min(np1.y,np2.y))-2,0,r.height-1),y1=clamp(Math.ceil(Math.max(np1.y,np2.y))+2,0,r.height-1);
      const area=(x1-x0+1)*(y1-y0+1),step=area>260000?2:1;
      const hits=[],hitSet=new Set();let max=null,row=0;
      for(let y=y0;y<=y1;y+=step){
        for(let x=x0;x<=x1;x+=step){
          const cls=classAtPixel(r,x,y);if(!cls)continue;
          const cp=naturalToContainer(r,x,y);if(centerCp.distanceTo(cp)>radiusPx*1.015)continue;
          const ll=map.containerPointToLatLng(cp);const dist=haversineKm(center,{lat:ll.lat,lon:ll.lng});if(dist>radius+.35)continue;
          const rec={x,y,cls,ll:{lat:ll.lat,lon:ll.lng},dist};
          if(!max||cls.rep>max.cls.rep||(cls.rep===max.cls.rep&&dist<max.dist))max=rec;
          if(meets(cls,threshold)){hits.push(rec);hitSet.add(x+','+y);}
        }
        if((++row%24)===0)await sleep(0);
      }
      const coherent=h=>{
        let n=0;for(let dy=-2*step;dy<=2*step;dy+=step)for(let dx=-2*step;dx<=2*step;dx+=step){if(!dx&&!dy)continue;if(hitSet.has((h.x+dx)+','+(h.y+dy)))n++;}
        return n>=2;
      };
      let nearest=null;for(const h of hits){if(!coherent(h))continue;if(!nearest||h.dist<nearest.dist)nearest=h;}
      $('echoFrameTime').textContent=r.label;
      if(max){$('echoMaxDbz').textContent=max.cls.label;$('echoMaxCoords').textContent=max.ll.lat.toFixed(4)+', '+max.ll.lon.toFixed(4);}else{$('echoMaxDbz').textContent='brak';$('echoMaxCoords').textContent='brak rozpoznanego echa';}
      if(!nearest){$('echoDistance').textContent='brak';info.textContent='W okręgu '+radius+' km nie znaleziono spójnego echa spełniającego próg '+threshold+' dBZ. Maksymalna rozpoznana klasa: '+(max?max.cls.label:'brak')+'.';return;}
      const bearing=initialBearing(center,nearest.ll),dir=compass16(bearing),distance=haversineKm(center,nearest.ll);
      $('echoDistance').textContent=distance<10?distance.toFixed(1)+' km':distance.toFixed(0)+' km';$('echoBearing').textContent=Math.round(bearing)+'°';$('echoCompass').textContent=dir+' · azymut od punktu do echa';$('echoFoundDbz').textContent=nearest.cls.label;$('echoCoords').textContent=nearest.ll.lat.toFixed(4)+', '+nearest.ll.lon.toFixed(4);
      resultLine=L.polyline([[center.lat,center.lon],[nearest.ll.lat,nearest.ll.lon]],{pane:'analysisResultPane',color:'#ff5b52',weight:2,dashArray:'7 5',interactive:false}).addTo(map);
      resultMarker=L.circleMarker([nearest.ll.lat,nearest.ll.lon],{pane:'analysisResultPane',radius:6,color:'#ff5b52',weight:2,fillColor:'#fff',fillOpacity:1,interactive:false}).addTo(map);
      info.textContent='Najbliższe echo spełniające próg znaleziono wewnątrz wybranego okręgu. Odbiciowość podawana jest jako zakres klasy legendy CMAX.';
    }catch(e){info.classList.add('error');info.textContent=e?.message||String(e);}
  }

  async function showPointDbz(ll) {
    if(!cmaxEnabled())return;
    try{
      const r=await getRaster(),cls=classAtLatLng(r,{lat:ll.lat,lon:ll.lng});
      const value=cls?cls.label:'brak echa ≥27 dBZ';
      L.popup({closeButton:true,autoPan:true}).setLatLng(ll).setContent('<div class="dbz-click-popup"><b>'+value+'</b><br>POLRAD CMAX · '+r.label+'<br><small>'+ll.lat.toFixed(4)+', '+ll.lng.toFixed(4)+'</small></div>').openOn(map);
    }catch(_){}
  }

  $('echoAnalyze')?.addEventListener('click',analyze);
  $('echoDbzThreshold')?.addEventListener('keydown',e=>{if(e.key==='Enter')analyze();});
  document.querySelectorAll('[data-echo-preset]').forEach(b=>b.addEventListener('click',()=>{$('echoDbzThreshold').value=b.dataset.echoPreset;analyze();}));

  const mapEl=$('map');
  if(mapEl){
    mapEl.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;shortPress={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now()};},{capture:true,passive:true});
    mapEl.addEventListener('pointermove',e=>{if(!shortPress||shortPress.id!==e.pointerId)return;if(Math.hypot(e.clientX-shortPress.x,e.clientY-shortPress.y)>12)shortPress=null;},{capture:true,passive:true});
    mapEl.addEventListener('pointerup',e=>{if(!shortPress||shortPress.id!==e.pointerId)return;const s=shortPress;shortPress=null;if(performance.now()-s.t>600)return;const rr=mapEl.getBoundingClientRect(),ll=map.containerPointToLatLng(L.point(e.clientX-rr.left,e.clientY-rr.top));showPointDbz(ll);},{capture:true,passive:true});
    mapEl.addEventListener('pointercancel',()=>{shortPress=null;},{capture:true,passive:true});
  }

  const reset=()=>{clearAnalysis();rasterCache=null;const info=$('echoInfo');if(info){info.classList.remove('error');info.textContent='Punkt lub klatka zmieniona. Uruchom analizę ponownie.';}};
  $('apply')?.addEventListener('click',reset);$('resetPoint')?.addEventListener('click',reset);$('radarFrame')?.addEventListener('input',()=>{rasterCache=null;});

  // Do not allow background/synthetic code to switch CMAX back on after the
  // user has explicitly disabled it. Human clicks still pass to POLRAD logic.
  const cmaxBtn=$('polrad_cmax');
  cmaxBtn?.addEventListener('click',e=>{
    if(!e.isTrusted && !cmaxBtn.classList.contains('active')){e.preventDefault();e.stopImmediatePropagation();}
    rasterCache=null;
  },true);
})();
