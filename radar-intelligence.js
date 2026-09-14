'use strict';

// PrognozaEPIR v0.11.9
// Runtime-verified POLRAD layers, reliable double-buffer animation and IMGW warnings.
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $ = id => document.getElementById(id);
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const POLRAD_BOUNDS = L.latLngBounds([[48.5,13.5],[56.0,25.0]]);
  const POLRAD_PANE = 'polradImagePane';
  const FRAME_WINDOW = 18;
  const FRAME_DELAY_MS = 850;
  const LOAD_TIMEOUT_MS = 9000;

  // These are the official products we are willing to expose. A button is kept
  // only after the list endpoint AND real image frames pass the runtime audit.
  const PRODUCTS = {
    cmax:  {label:'POLRAD CMAX', short:'CMAX', keys:['cmax'], comparableToOpera:true},
    cappi: {label:'POLRAD CAPPI 1 km', short:'CAPPI', keys:['cappi','cappi1','cappi_1km'], comparableToOpera:true},
    eht:   {label:'POLRAD EHT', short:'EHT', keys:['eht','etop','echo_top'], comparableToOpera:false},
    sri:   {label:'POLRAD SRI', short:'SRI', keys:['sri'], comparableToOpera:false},
    pac:   {label:'POLRAD PAC 1 h', short:'PAC', keys:['pac'], comparableToOpera:false},
    hail:  {label:'POLRAD grad', short:'GRAD', keys:['hail','hails','hailprob','hail_prob','grad'], comparableToOpera:false}
  };

  let product = 'cmax';
  let frames = [];
  let index = 0;
  let layer = null;
  let animationTimer = null;
  let animationToken = 0;
  let renderToken = 0;
  let playing = false;
  let warningsLayer = null;
  let warningsGeo = null;
  let warningRows = [];
  let warningIndex = new Map();
  const cache = new Map();

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.9';

  const mapbar = document.querySelector('.mapbar');
  if (!mapbar) return;

  const style = document.createElement('style');
  style.textContent = `
    .polrad-note{font-size:9px;color:var(--muted);padding:4px 8px;border-top:1px solid var(--line)}
    .hazard-legend{background:rgba(255,255,255,.93);color:#222;padding:6px 7px;border-radius:5px;font-size:9px;line-height:1.35;box-shadow:0 1px 5px rgba(0,0,0,.2)}
    .hazard-legend i{display:inline-block;width:11px;height:8px;margin-right:4px;vertical-align:middle;border:1px solid rgba(0,0,0,.25)}
  `;
  document.head.appendChild(style);

  // Remove legacy experiments which had no dependable browser-side source.
  // This also cleans a cached/older DOM if a previous revision injected them.
  const obsoleteIds = ['lightningToggle','blitzortungLive','mtgLiToggle','mtgIrToggle','mtgIr105Toggle','mtgGeoToggle'];
  obsoleteIds.forEach(id => $(id)?.remove());
  ['blitzortungWrap','mtgIrWrap','mtgGeoWrap'].forEach(id => $(id)?.remove());
  [...mapbar.querySelectorAll('button')].forEach(b => {
    if (/Wyładowania LFL|Blitzortung LIVE|MTG IR10\.5|MTG Geo/i.test(b.textContent || '')) b.remove();
  });

  let status = $('polradStatus');
  if (!status) {
    status = document.createElement('div');
    status.id = 'polradStatus';
    status.className = 'polrad-note';
    mapbar.insertAdjacentElement('afterend',status);
  }
  const setStatus = text => { if (status) status.textContent = text; };
  const fmtUtc = sec => new Intl.DateTimeFormat('pl-PL',{
    timeZone:'UTC',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'
  }).format(new Date(Number(sec)*1000));
  const normalizeUrl = url => String(url || '').replace(/^http:\/\//i,'https://');

  function ensurePane(){
    let pane = map.getPane(POLRAD_PANE);
    if (!pane) pane = map.createPane(POLRAD_PANE);
    pane.style.zIndex = '470';
    pane.style.pointerEvents = 'none';
    return pane;
  }
  ensurePane();

  function makeButton(id,text,before){
    let b=$(id);
    if (b) return b;
    b=document.createElement('button');b.id=id;b.type='button';b.textContent=text;
    before ? mapbar.insertBefore(b,before) : mapbar.appendChild(b);
    return b;
  }

  const rainButton = $('radarToggle');
  if (rainButton) {
    rainButton.textContent='RainViewer';
    rainButton.classList.remove('active');
  }

  const productButtons = {};
  const first = rainButton || mapbar.firstChild;
  for (const [key,meta] of Object.entries(PRODUCTS)) {
    const b=makeButton('polrad_'+key,meta.label,first);
    productButtons[key]=b;
    b.disabled=true;
    b.title='Test źródła…';
    b.addEventListener('click',() => {
      if (b.disabled) return;
      if (product===key && b.classList.contains('active')) {
        stopAnimation();
        b.classList.remove('active');
        removePolradLayer();
        return;
      }
      selectProduct(key);
    });
  }

  const hazardButton = makeButton('hazardsToggle','Zagrożenia IMGW',$('playRadar'));
  hazardButton?.addEventListener('click',toggleHazards);

  // Own the history controls. Cloning drops the old RainViewer timer listeners,
  // preventing two animation engines from fighting over the same map.
  let range=$('radarFrame');
  if (range) {
    const r=range.cloneNode(true);range.replaceWith(r);range=r;
    range.min='0';range.max='0';range.value='0';
    range.addEventListener('input',() => {
      stopAnimation();
      if (activeMode()==='rainviewer') showRainviewerFrame(Number(range.value));
      else showPolradFrame(Number(range.value));
    });
  }
  let play=$('playRadar');
  if (play) {
    const p=play.cloneNode(true);play.replaceWith(p);play=p;
    play.textContent='▶ Animacja';
    play.addEventListener('click',toggleAnimation);
  }

  function activeMode(){
    if (rainButton?.classList.contains('active')) return 'rainviewer';
    if (productButtons[product]?.classList.contains('active')) return 'polrad';
    return 'none';
  }

  function imageProbe(url,timeout=LOAD_TIMEOUT_MS){
    return new Promise(resolve => {
      if (!url) { resolve(false); return; }
      const img=new Image();
      let done=false;
      const finish=ok=>{if(done)return;done=true;clearTimeout(timer);img.onload=null;img.onerror=null;resolve(ok);};
      const timer=setTimeout(()=>finish(false),timeout);
      img.onload=()=>finish(img.naturalWidth>20&&img.naturalHeight>20);
      img.onerror=()=>finish(false);
      img.decoding='async';
      img.src=normalizeUrl(url)+(String(url).includes('?')?'&':'?')+'_epir='+Date.now();
    });
  }

  async function fetchProductFrames(key,{force=false}={}){
    if (!force && cache.has(key)) return cache.get(key);
    const meta=PRODUCTS[key];
    let lastError=null;
    for (const apiKey of meta.keys) {
      const ctl=new AbortController();
      const timer=setTimeout(()=>ctl.abort(),9000);
      try {
        const r=await fetch(`https://meteo.imgw.pl/api/radars/v1/list/${encodeURIComponent(apiKey)}`,{cache:'no-store',signal:ctl.signal});
        if(!r.ok) throw new Error('HTTP '+r.status);
        const j=await r.json();
        const list=j?.[apiKey]?.list || j?.[key]?.list || Object.values(j||{}).find(v=>Array.isArray(v?.list))?.list;
        if(!Array.isArray(list)||list.length<2) throw new Error('mniej niż 2 klatki');
        const out=list.filter(f=>f?.url&&Number.isFinite(Number(f?.date))).sort((a,b)=>Number(a.date)-Number(b.date));
        if(out.length<2) throw new Error('brak poprawnej historii');
        // Test two real images, not just JSON. This is what decides whether the
        // visualization exists in the UI.
        const newest=out.at(-1),older=out.at(Math.max(0,out.length-4));
        const [a,b]=await Promise.all([imageProbe(newest.url),imageProbe(older.url)]);
        if(!a||!b) throw new Error('obraz produktu nie ładuje się');
        const value={frames:out,apiKey,checkedAt:Date.now()};
        cache.set(key,value);meta.resolvedKey=apiKey;return value;
      } catch(e){lastError=e;} finally{clearTimeout(timer);}
    }
    throw lastError || new Error('źródło niedostępne');
  }

  async function auditProducts(){
    setStatus('Testuję wszystkie zobrazowania POLRAD…');
    const results=[];
    for (const key of Object.keys(PRODUCTS)) {
      const b=productButtons[key];
      if(!b) continue;
      try {
        const data=await fetchProductFrames(key,{force:true});
        b.disabled=false;b.dataset.available='1';
        b.title=`${PRODUCTS[key].short}: ${data.frames.length} klatek · test JSON + 2 obrazy OK`;
        results.push(key);
      } catch(e) {
        b.remove();delete productButtons[key];
        results.push(null);
      }
    }
    const ok=results.filter(Boolean);
    setStatus(`Test zobrazowań zakończony: ${ok.length}/${Object.keys(PRODUCTS).length} produktów POLRAD działa. Niedziałające zostały usunięte.`);
    return ok;
  }

  function removePolradLayer(){
    renderToken++;
    try{if(layer&&map.hasLayer(layer))map.removeLayer(layer);}catch(_){}
    layer=null;
  }

  function publishFrame(frame){
    const meta=PRODUCTS[product]||{};
    const detail={product,short:meta.short||product,timeSec:Number(frame.date),timeMs:Number(frame.date)*1000,
      comparableToOpera:!!meta.comparableToOpera,index,count:frames.length,url:normalizeUrl(frame.url)};
    window.PrognozaEPIRPolradState=detail;
    window.dispatchEvent(new CustomEvent('prognozaepir:polrad-frame-changed',{detail}));
  }

  function preloadNext(i){
    if(!frames.length)return;
    const f=frames[clamp(i,0,frames.length-1)];
    if(f?.url) imageProbe(f.url,6000).catch(()=>{});
  }

  function showPolradFrame(i){
    if(!frames.length)return Promise.resolve(false);
    const myToken=++renderToken;
    index=clamp(Math.round(Number(i)||0),0,frames.length-1);
    if(range)range.value=String(index);
    const frame=frames[index],url=normalizeUrl(frame.url);
    const active=productButtons[product]?.classList.contains('active');
    if(!active)return Promise.resolve(false);

    return new Promise(resolve=>{
      const next=L.imageOverlay(url,POLRAD_BOUNDS,{pane:POLRAD_PANE,opacity:0,interactive:false,attribution:'IMGW-PIB / POLRAD'});
      let done=false;
      const finish=(ok)=>{
        if(done)return;done=true;clearTimeout(timer);
        if(myToken!==renderToken){try{if(map.hasLayer(next))map.removeLayer(next);}catch(_){}resolve(false);return;}
        if(!ok){try{if(map.hasLayer(next))map.removeLayer(next);}catch(_){}setStatus(`POLRAD ${PRODUCTS[product]?.short||product}: pominięto uszkodzoną klatkę.`);resolve(false);return;}
        const old=layer;layer=next;next.setOpacity(.70);
        if(old&&old!==next)try{if(map.hasLayer(old))map.removeLayer(old);}catch(_){}
        const timeEl=$('radarTime');if(timeEl)timeEl.textContent=`${PRODUCTS[product]?.short||product}: ${fmtUtc(frame.date)} UTC`;
        setStatus(`Mapa: IMGW/POLRAD ${PRODUCTS[product]?.short||product} · ${fmtUtc(frame.date)} UTC.`);
        publishFrame(frame);preloadNext(index+1<frames.length?index+1:Math.max(0,frames.length-FRAME_WINDOW));
        resolve(true);
      };
      const timer=setTimeout(()=>finish(false),LOAD_TIMEOUT_MS);
      next.once('load',()=>finish(true));next.once('error',()=>finish(false));next.addTo(map);
    });
  }

  async function showRainviewerFrame(i){
    try {
      if(typeof radarFrames==='undefined'||typeof radarMeta==='undefined'||!radarMeta||!Array.isArray(radarFrames)||!radarFrames.length)return false;
      const myToken=++renderToken;
      const ri=clamp(Math.round(Number(i)||0),0,radarFrames.length-1),fr=radarFrames[ri];
      if(range)range.value=String(ri);
      const url=radarMeta.host+fr.path+'/256/{z}/{x}/{y}/2/0_0.png';
      const next=L.tileLayer(url,{tileSize:256,opacity:0,maxNativeZoom:7,maxZoom:12,attribution:'Radar © RainViewer'});
      const ok=await new Promise(resolve=>{
        let done=false;const finish=v=>{if(done)return;done=true;clearTimeout(timer);resolve(v)};
        const timer=setTimeout(()=>finish(false),LOAD_TIMEOUT_MS);next.once('load',()=>finish(true));next.once('tileerror',()=>finish(false));next.addTo(map);
      });
      if(myToken!==renderToken||!rainButton?.classList.contains('active')){try{map.removeLayer(next)}catch(_){}return false;}
      if(!ok){try{map.removeLayer(next)}catch(_){}return false;}
      const old=typeof radarLayer!=='undefined'?radarLayer:null;
      next.setOpacity(.68);
      try{if(old&&old!==next&&map.hasLayer(old))map.removeLayer(old);}catch(_){}
      try{radarLayer=next;radarIndex=ri;}catch(_){}
      const timeEl=$('radarTime');if(timeEl)timeEl.textContent='Radar: '+fmtUtc(fr.time)+' UTC';
      setStatus(`Mapa: RainViewer · ${fmtUtc(fr.time)} UTC.`);return true;
    } catch(_){return false;}
  }

  async function selectProduct(key){
    stopAnimation();
    if(!productButtons[key])return;
    product=key;
    Object.entries(productButtons).forEach(([k,b])=>b.classList.toggle('active',k===key));
    if(rainButton){rainButton.classList.remove('active');try{if(typeof radarLayer!=='undefined'&&radarLayer&&map.hasLayer(radarLayer))map.removeLayer(radarLayer)}catch(_){}}
    setStatus(`POLRAD ${PRODUCTS[key].short}: odświeżam i sprawdzam źródło…`);
    try {
      const data=await fetchProductFrames(key,{force:true});frames=data.frames;index=frames.length-1;
      if(range){range.min='0';range.max=String(frames.length-1);range.value=String(index);range.disabled=frames.length<2;}
      if(play)play.disabled=frames.length<2;
      await showPolradFrame(index);
    } catch(e) {
      productButtons[key]?.remove();delete productButtons[key];removePolradLayer();
      setStatus(`POLRAD ${PRODUCTS[key]?.short||key} usunięty: źródło nie przeszło testu (${e?.message||'błąd'}).`);
      const fallback=Object.keys(productButtons)[0];if(fallback)selectProduct(fallback);
    }
  }

  if(rainButton){
    rainButton.addEventListener('click',()=>{
      if(!rainButton.classList.contains('active'))return;
      stopAnimation();removePolradLayer();Object.values(productButtons).forEach(b=>b.classList.remove('active'));
      try{
        if(typeof radarFrames!=='undefined'&&Array.isArray(radarFrames)&&radarFrames.length){
          if(range){range.min='0';range.max=String(radarFrames.length-1);range.value=String(radarFrames.length-1);range.disabled=radarFrames.length<2;}
          if(play)play.disabled=radarFrames.length<2;
          showRainviewerFrame(radarFrames.length-1);
        } else {
          rainButton.remove();setStatus('RainViewer usunięty: brak działających klatek.');
        }
      }catch(_){rainButton.remove();}
    });
  }

  function stopAnimation(){
    animationToken++;
    if(animationTimer)clearTimeout(animationTimer);animationTimer=null;playing=false;
    if(play)play.textContent='▶ Animacja';
  }

  async function animationStep(token,start,end,current,mode){
    if(token!==animationToken||!playing)return;
    let ok=false;
    if(mode==='rainviewer')ok=await showRainviewerFrame(current);else ok=await showPolradFrame(current);
    if(token!==animationToken||!playing)return;
    const next=current>=end?start:current+1;
    // Schedule only after the current frame actually loaded. Slow networks no
    // longer cause a pile-up of pending swaps or a blank/frozen map.
    animationTimer=setTimeout(()=>animationStep(token,start,end,next,mode),ok?FRAME_DELAY_MS:180);
  }

  function toggleAnimation(){
    if(playing){stopAnimation();return;}
    const mode=activeMode();if(mode==='none')return;
    let count=0,end=0;
    if(mode==='rainviewer'){
      try{count=Array.isArray(radarFrames)?radarFrames.length:0;}catch(_){count=0;}
    } else count=frames.length;
    if(count<2){if(play)play.disabled=true;return;}
    const start=Math.max(0,count-FRAME_WINDOW);end=count-1;
    playing=true;const token=++animationToken;if(play)play.textContent='■ Stop';
    animationStep(token,start,end,start,mode);
  }

  // ---------- official IMGW warnings ----------
  function terytList(w){const raw=w?.teryt;if(Array.isArray(raw))return raw.map(String);if(typeof raw==='string')return raw.split(/[;,\s]+/).filter(Boolean);return[];}
  function warningLevel(w){return clamp(Number(w?.stopien??w?.stopien_zagrozenia??w?.level??0)||0,0,3);}
  async function fetchWarnings(){const r=await fetch('https://danepubliczne.imgw.pl/api/data/warningsmeteo',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);warningRows=await r.json();if(!Array.isArray(warningRows))warningRows=[];warningIndex=new Map();for(const w of warningRows)for(const raw of terytList(w)){const code=String(raw).padStart(4,'0').slice(0,4),rows=warningIndex.get(code)||[];rows.push(w);warningIndex.set(code,rows);}return warningRows;}
  async function fetchWarningGeo(){if(warningsGeo)return warningsGeo;const r=await fetch('https://raw.githubusercontent.com/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy/main/powiaty.json',{cache:'force-cache'});if(!r.ok)throw new Error('granice HTTP '+r.status);warningsGeo=await r.json();return warningsGeo;}
  const hazardColor=l=>l>=3?'#c62828':l===2?'#ef6c00':'#f9a825';
  let hazardLegend=null;
  function drawWarnings(geo){if(warningsLayer)try{map.removeLayer(warningsLayer)}catch(_){}warningsLayer=L.geoJSON(geo,{style:f=>{const code=String(f?.properties?.JPT_KOD_JE||'').padStart(4,'0').slice(0,4),rows=warningIndex.get(code)||[],level=rows.reduce((m,w)=>Math.max(m,warningLevel(w)),0);return level?{color:hazardColor(level),weight:1.2,fillColor:hazardColor(level),fillOpacity:level===3?.40:level===2?.32:.24}:{color:'transparent',weight:0,fillOpacity:0};},onEachFeature:(f,l)=>{const code=String(f?.properties?.JPT_KOD_JE||'').padStart(4,'0').slice(0,4),rows=warningIndex.get(code)||[];if(!rows.length)return;const name=f?.properties?.JPT_NAZWA_||('powiat '+code);l.bindTooltip('<b>'+name+'</b><br>'+rows.slice(0,3).map(w=>(w.nazwa_zdarzenia||w.zdarzenie||w.event||'Ostrzeżenie')+' · st. '+warningLevel(w)).join('<br>'),{sticky:true});}}).addTo(map);}
  function legend(show){if(show&&!hazardLegend){hazardLegend=L.control({position:'topright'});hazardLegend.onAdd=()=>{const d=L.DomUtil.create('div','hazard-legend');d.innerHTML='<b>Zagrożenia IMGW</b><br><i style="background:#f9a825"></i>stopień 1<br><i style="background:#ef6c00"></i>stopień 2<br><i style="background:#c62828"></i>stopień 3';return d};hazardLegend.addTo(map);}else if(!show&&hazardLegend){map.removeControl(hazardLegend);hazardLegend=null;}}
  async function toggleHazards(){if(!hazardButton)return;if(hazardButton.classList.contains('active')){hazardButton.classList.remove('active');if(warningsLayer&&map.hasLayer(warningsLayer))map.removeLayer(warningsLayer);legend(false);return;}hazardButton.textContent='Zagrożenia…';try{const [,geo]=await Promise.all([fetchWarnings(),fetchWarningGeo()]);drawWarnings(geo);legend(true);hazardButton.classList.add('active');hazardButton.textContent='Zagrożenia IMGW';}catch(e){hazardButton.classList.remove('active');hazardButton.textContent='Zagrożenia IMGW';hazardButton.remove();legend(false);setStatus('Zagrożenia IMGW usunięte: warstwa nie przeszła testu źródła.');}}

  $('refresh')?.addEventListener('click',()=>{
    cache.clear();
    if(activeMode()==='polrad')selectProduct(product);
    if(hazardButton?.classList.contains('active'))Promise.all([fetchWarnings(),fetchWarningGeo()]).then(([,g])=>drawWarnings(g)).catch(()=>{});
  });

  // First audit all products, remove failures, then activate the best available.
  (async()=>{
    const ok=await auditProducts();
    const firstOk=ok.includes('cmax')?'cmax':ok[0];
    if(firstOk)await selectProduct(firstOk);
    else if(rainButton){
      try{if(typeof radarFrames!=='undefined'&&radarFrames.length&&!rainButton.classList.contains('active'))rainButton.click();else rainButton.remove();}catch(_){rainButton.remove();}
    }
  })().catch(()=>{});

  window.PrognozaEPIRRadarLayers={
    audit:auditProducts,
    select:selectProduct,
    stop:stopAnimation,
    state:()=>({product,frames:frames.length,index,playing})
  };
})();
