'use strict';
(() => {
  if (!/\/radar\.html$/i.test(location.pathname)) return;
  if (window.__epirOperaConvectionBridgeLoaded) return;
  window.__epirOperaConvectionBridgeLoaded = true;

  // Transport shim: CloudFerro OPERA objects are not reliably readable with
  // browser CORS/Range on all mobile clients. Rewrite only the strict DBZH
  // GeoTIFF object pattern to the merged central Railway proxy.
  const OPERA_S3_PREFIX = 'https://s3.waw3-1.cloudferro.com/openradar-24h/';
  const OPERA_PROXY_PREFIX = 'https://central-ingestor-production.up.railway.app/opera/dbzh/';
  if (!window.__epirOperaFetchProxyInstalled) {
    const nativeFetch = window.fetch.bind(window);
    const rewriteOperaUrl = value => {
      const url = String(value || '');
      if (!url.startsWith(OPERA_S3_PREFIX)) return null;
      const m = url.match(/OPERA@(20\d{6})T(\d{4})@0@DBZH\.tiff(?:[?#].*)?$/i);
      return m ? `${OPERA_PROXY_PREFIX}${m[1]}${m[2]}.tiff` : null;
    };
    window.fetch = function(input, init) {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const proxyUrl = rewriteOperaUrl(rawUrl);
      if (!proxyUrl) return nativeFetch(input, init);
      if (typeof Request !== 'undefined' && input instanceof Request) {
        const headers = new Headers(input.headers);
        if (init?.headers) new Headers(init.headers).forEach((v,k) => headers.set(k,v));
        return nativeFetch(proxyUrl, {
          method: input.method || 'GET',
          headers,
          mode: 'cors',
          credentials: 'omit',
          cache: init?.cache || input.cache,
          redirect: input.redirect,
          referrerPolicy: input.referrerPolicy,
          signal: init?.signal || input.signal
        });
      }
      return nativeFetch(proxyUrl, init);
    };
    window.__epirOperaFetchProxyInstalled = true;
  }

  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const risk = v => Number(v) >= 75 ? 'wysokie' : Number(v) >= 50 ? 'podwyższone' : 'niskie';

  function fmtUtc(ms) {
    if (!finite(Number(ms))) return '—';
    const d = new Date(Number(ms));
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  }

  function compactConvection() {
    const card = $('convectionNowcastCard');
    if (!card) return null;
    const heading = card.querySelector('h2');
    if (heading) heading.textContent = 'TCu / Cb · zagrożenie dla EPIR 0–3 h';

    const grid = card.querySelector('.conv-grid');
    if (!grid) return card;
    let details = $('convTechDetails');
    if (!details) {
      details = document.createElement('details');
      details.id = 'convTechDetails';
      details.className = 'conv-cal';
      details.innerHTML = '<summary style="cursor:pointer;font-weight:700">Szczegóły techniczne</summary><div id="convTechTiles" class="conv-grid" style="margin-top:6px"></div>';
      const summary = $('convSummary');
      if (summary?.parentElement) summary.insertAdjacentElement('afterend', details);
      else card.appendChild(details);
    }

    const keep = new Set(['Klasa aktualna','TCu','Cb','Czas / ETA']);
    const tech = $('convTechTiles');
    [...grid.querySelectorAll(':scope > .conv-tile')].forEach(tile => {
      const label = String(tile.querySelector('small')?.textContent || '').trim();
      if (!keep.has(label) && tech && tile.parentElement === grid) tech.appendChild(tile);
    });

    for (const selector of ['.conv-h','.conv-scope','#convCalibration','#convThresholds','.conv-foot']) {
      const el = card.querySelector(selector);
      if (el && el.parentElement !== details) details.appendChild(el);
    }

    if (!$('convCompactStyle')) {
      const style = document.createElement('style');
      style.id = 'convCompactStyle';
      style.textContent = `
        #convectionNowcastCard .conv-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important}
        #convectionNowcastCard .conv-tile{min-height:50px!important;padding:6px!important}
        #convectionNowcastCard .conv-tile b{font-size:13px!important}
        #convectionNowcastCard #convTechDetails{margin:6px 0 0!important;padding:6px 7px!important}
        #convectionNowcastCard #convTechDetails>.conv-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}
        #convectionNowcastCard #convTechDetails .conv-h{margin-top:7px!important}
        #convectionNowcastCard #convOperaSupport{font-size:9px!important;padding:6px 7px!important;line-height:1.35!important}
        @media(max-width:700px){#convectionNowcastCard .conv-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}#convectionNowcastCard #convTechDetails>.conv-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
      `;
      document.head.appendChild(style);
    }
    return card;
  }

  function simplifyPrimaryReadout() {
    const conv = window.PrognozaEPIRConvectionNowcast;
    if (!conv) return;
    const tcu = Number(conv.tcuProbability), cb = Number(conv.cbProbability);
    const noSignal = /brak/i.test(String(conv.class || '')) || (finite(tcu) && finite(cb) && Math.max(tcu,cb) < 30);
    const eta = $('convEta'), etaSub = $('convEtaSub');
    if (noSignal && eta) {
      eta.textContent = 'brak';
      if (etaSub) etaSub.textContent = 'brak istotnej komórki na torze do EPIR';
    }
    const tcuSub = $('convTcuSub'), cbSub = $('convCbSub');
    if (tcuSub && finite(tcu)) tcuSub.textContent = `${risk(tcu)} prawdopodobieństwo`;
    if (cbSub && finite(cb)) cbSub.textContent = `${risk(cb)} prawdopodobieństwo`;
  }

  function ensureBox() {
    const card = compactConvection();
    if (!card) return null;
    let box = $('convOperaSupport');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'convOperaSupport';
    box.className = 'conv-cal';
    const summary = $('convSummary');
    if (summary?.parentElement) summary.insertAdjacentElement('afterend', box);
    else card.appendChild(box);
    return box;
  }

  function buildEvidence() {
    const fusion = window.PrognozaEPIRRadarFusion;
    const opera = window.PrognozaEPIROperaNowcast;
    const conv = window.PrognozaEPIRConvectionNowcast;
    if (!fusion || !opera || opera.error || !conv) return null;
    const etaMin = finite(Number(opera.etaMin)) ? Number(opera.etaMin) : null;
    const etaAt = etaMin !== null && finite(Number(opera.frameEnd)) ? Number(opera.frameEnd) + etaMin * 60000 : null;
    const maxDbz = Number(opera?.latest?.max);
    return {
      updatedAt:new Date().toISOString(), source:'OPERA CIRRUS DBZH', primaryRadar:'POLRAD', probabilitiesAdjusted:false,
      supportLevel:fusion.convectiveSupport || 'brak', vectorAgreement:!!fusion.vectorAgree,
      directionDifferenceDeg:finite(Number(fusion.dirDiffDeg))?Number(fusion.dirDiffDeg):null,
      speedDifferenceKmh:finite(Number(fusion.speedDiffKmh))?Number(fusion.speedDiffKmh):null,
      polradSignal:!!fusion.polradSignal, operaSignal:!!fusion.operaSignal,
      operaMaxDbz:finite(maxDbz)?maxDbz:null, etaMin, etaAt, trend:opera?.trend?.label||null,
      predictions:{...(opera.predictions||{})}, baseTcuProbability:Number(conv.tcuProbability), baseCbProbability:Number(conv.cbProbability)
    };
  }

  function render() {
    compactConvection();
    simplifyPrimaryReadout();
    const box = ensureBox();
    if (!box) return;
    const opera = window.PrognozaEPIROperaNowcast;
    if (opera?.error) {
      box.innerHTML = '<b>OPERA:</b> niedostępna · wynik TCu/Cb nadal działa z POLRAD + NWP.';
      return;
    }
    const e = buildEvidence();
    if (!e) {
      box.innerHTML = '<b>OPERA:</b> oczekiwanie na europejskie potwierdzenie CMAX.';
      return;
    }
    window.PrognozaEPIRConvectionRadarEvidence = e;
    window.dispatchEvent(new CustomEvent('prognozaepir:convection-radar-evidence-updated',{detail:e}));

    let lead='brak sygnału do potwierdzenia';
    if(e.polradSignal&&e.operaSignal&&e.vectorAgreement)lead='potwierdza POLRAD';
    else if(e.polradSignal&&e.operaSignal)lead='częściowo potwierdza POLRAD';
    else if(e.polradSignal&&!e.operaSignal)lead='nie potwierdza silnego echa POLRAD';
    const parts=[`<b>OPERA:</b> ${lead}`];
    if(e.operaMaxDbz!==null)parts.push(`maks. ${Math.round(e.operaMaxDbz)} dBZ`);
    if(e.etaMin!==null)parts.push(`ETA ≤30 km: ${Math.round(e.etaMin)} min (${fmtUtc(e.etaAt)})`);
    if(e.trend)parts.push(`trend: ${e.trend}`);
    box.innerHTML=parts.join(' · ')+'.';
  }

  let timer=0;
  function schedule(){clearTimeout(timer);timer=setTimeout(render,30);}
  window.addEventListener('prognozaepir:radar-fusion-updated',schedule);
  window.addEventListener('prognozaepir:convection-nowcast-updated',schedule);
  window.addEventListener('prognozaepir:opera-nowcast-updated',schedule);
  schedule();setTimeout(schedule,800);setTimeout(schedule,2500);

  // If an old cached transport managed to fail before this versioned bridge was
  // evaluated, retry once through the merged central proxy.
  setTimeout(() => {
    if (window.PrognozaEPIROperaNowcast?.error) {
      window.PrognozaEPIROperaNowcastEngine?.refresh?.();
    }
  }, 4000);

  window.PrognozaEPIROperaConvectionBridge={refresh:render,get:()=>window.PrognozaEPIRConvectionRadarEvidence||null};
})();

// Robust OPERA CMAX map renderer -------------------------------------------
(() => {
  'use strict';
  if (!/\/radar\.html$/i.test(location.pathname)) return;
  if (window.__epirOperaMapLayerFixV2) return;
  window.__epirOperaMapLayerFixV2 = true;

  const RADIUS_KM = 160;
  const PANE = 'operaCmaxPane';
  const PROJ_WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  let fixedLayer = null;
  let outlineLayer = null;
  let lastOpera = null;
  let lastRaster = null;
  let lastBounds = null;
  let boundButton = null;
  let autoEnabled = false;

  function getMap() {
    try { return typeof map !== 'undefined' && map ? map : null; }
    catch (_) { return null; }
  }

  function fmtUtc(ms) {
    if (!finite(Number(ms))) return '—';
    const d = new Date(Number(ms));
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  }

  function pointFor(opera) {
    const p = opera?.point;
    if (finite(Number(p?.lat)) && finite(Number(p?.lon))) return {lat:Number(p.lat),lon:Number(p.lon)};
    const lat = Number(String($('lat')?.value || '').replace(',','.'));
    const lon = Number(String($('lon')?.value || '').replace(',','.'));
    return finite(lat) && finite(lon) ? {lat,lon} : null;
  }

  function localBounds(p) {
    const latRad = p.lat * Math.PI / 180;
    const dLat = RADIUS_KM / 110.574;
    const dLon = RADIUS_KM / Math.max(20, 111.320 * Math.cos(latRad));
    return [[p.lat-dLat,p.lon-dLon],[p.lat+dLat,p.lon+dLon]];
  }

  // POLRAD CMAX visual scale. The thresholds mirror the CMAX colour decoder
  // used by this page: blue -> cyan -> green -> yellow -> orange -> red -> magenta.
  const POLRAD_CMAX_PALETTE = [
    [58,[255,0,255,255]],
    [52,[255,0,0,248]],
    [47,[255,128,0,242]],
    [44,[255,220,0,236]],
    [41,[160,255,0,230]],
    [38,[0,200,0,220]],
    [34,[0,255,255,210]],
    [30,[0,170,255,195]],
    [27,[0,80,255,180]],
    [20,[0,0,210,145]],
    [14,[0,0,145,105]],
    [8,[0,0,85,65]]
  ];

  function colorForDbz(v) {
    if (!finite(v) || v < 8) return [0,0,0,0];
    for (const [minimum,rgba] of POLRAD_CMAX_PALETTE) {
      if (v >= minimum) return rgba;
    }
    return [0,0,0,0];
  }

  function rasterFor(latest) {
    const display = latest?.display || null;
    const values = display?.values || latest?.values;
    const len = Number(values?.length || 0);
    const n = Number(display?.width || Math.round(Math.sqrt(len)));
    if (!len || n*n !== len) return null;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(n,n);
    let visible = 0, significant = 0, max = -Infinity;
    for (let i=0;i<len;i++) {
      const v = Number(values[i]);
      if (finite(v)) max = Math.max(max,v);
      const [r,g,b,a] = colorForDbz(v);
      if (a) visible++;
      if (finite(v) && v >= 27) significant++;
      const j=i*4;
      image.data[j]=r; image.data[j+1]=g; image.data[j+2]=b; image.data[j+3]=a;
    }
    ctx.putImageData(image,0,0);
    return {url:canvas.toDataURL('image/png'),visible,significant,max,n,values,pixelKm:Number(display?.pixelKm||4),geoBounds:display?.geoBounds||latest?.geoBounds||null,proj:display?.proj||null,projectedBounds:display?.projectedBounds||null};
  }

  function ensurePane(m) {
    let pane = m.getPane(PANE);
    if (!pane) pane = m.createPane(PANE);
    pane.style.zIndex = '480';
    pane.style.pointerEvents = 'auto';
    return pane;
  }

  function removeLayer(m, layer) {
    try { if (layer && m.hasLayer(layer)) m.removeLayer(layer); } catch (_) {}
  }

  function removeLegacyOpera(m) {
    try {
      m.eachLayer(layer => {
        if (layer === fixedLayer || layer === outlineLayer) return;
        const isOpera = !!L.ImageOverlay && layer instanceof L.ImageOverlay && layer?.options?.attribution === 'EUMETNET OPERA CIRRUS';
        if (isOpera) m.removeLayer(layer);
      });
    } catch (_) {}
  }

  function clearFixed(m) {
    removeLayer(m,fixedLayer);
    removeLayer(m,outlineLayer);
    fixedLayer=null;
    outlineLayer=null;
  }

  function publishState(button, state) {
    window.PrognozaEPIROperaMapState = state;
    if (!button) return;
    button.dataset.operaMapRendered = state.rendered ? '1' : '0';
    button.dataset.operaVisiblePixels = String(state.visiblePixels ?? 0);
    button.dataset.operaSignificantPixels = String(state.significantPixels ?? 0);
    button.dataset.operaFrameUtc = state.frameUtc || '';
    button.dataset.operaPalette = state.palette || '';
    button.dataset.operaInteractive = state.interactive ? '1' : '0';
    button.dataset.operaResolutionKm = state.resolutionKm != null ? String(state.resolutionKm) : '';
  }

  function ensureMapStyle() {
    if ($('operaCmaxMapStyle')) return;
    const style=document.createElement('style');
    style.id='operaCmaxMapStyle';
    style.textContent=`.opera-cmax-fixed-overlay{image-rendering:pixelated!important;image-rendering:crisp-edges!important;cursor:crosshair!important}.opera-cmax-popup .leaflet-popup-content{margin:10px 12px;line-height:1.35}.opera-cmax-popup .op-value{font-size:18px;font-weight:800}.opera-cmax-popup .op-meta{font-size:11px;opacity:.78;margin-top:3px}`;
    document.head.appendChild(style);
  }

  function sampleRaster(latlng,raster,bounds) {
    if (!latlng || !raster?.values || !raster.n) return NaN;
    let gx=NaN,gy=NaN;
    const pb=raster.projectedBounds;
    if (pb && raster.proj && typeof window.proj4==='function') {
      try {
        const xy=window.proj4(PROJ_WGS84,raster.proj,[Number(latlng.lng),Number(latlng.lat)]);
        gx=(xy[0]-pb.x0)/(pb.x1-pb.x0)*(raster.n-1);
        gy=(pb.yTop-xy[1])/(pb.yTop-pb.yBottom)*(raster.n-1);
      } catch (_) {}
    }
    if (!finite(gx)||!finite(gy)) {
      const south=Number(bounds?.[0]?.[0]),west=Number(bounds?.[0]?.[1]),north=Number(bounds?.[1]?.[0]),east=Number(bounds?.[1]?.[1]);
      if (![south,west,north,east].every(finite)||east===west||north===south) return NaN;
      gx=(Number(latlng.lng)-west)/(east-west)*(raster.n-1);
      gy=(north-Number(latlng.lat))/(north-south)*(raster.n-1);
    }
    const x=Math.round(gx),y=Math.round(gy);
    if(x<0||y<0||x>=raster.n||y>=raster.n)return NaN;
    const v=Number(raster.values[y*raster.n+x]);
    return finite(v)?v:NaN;
  }

  function echoLabel(v) {
    if(!finite(v))return 'brak danych';
    if(v<8)return 'brak istotnego echa';
    if(v<20)return 'słabe echo';
    if(v<30)return 'umiarkowane echo';
    if(v<40)return 'silne echo';
    if(v<50)return 'bardzo silne echo';
    return 'ekstremalnie silne echo';
  }

  function showPointPopup(m,latlng,raster,bounds,opera) {
    const v=sampleRaster(latlng,raster,bounds),frame=fmtUtc(opera?.frameEnd||opera?.latest?.time);
    const value=finite(v)?`${Math.round(v)} dBZ`:'brak danych';
    const html=`<div><b>OPERA CMAX</b><div class="op-value">${value}</div><div>${echoLabel(v)}</div><div class="op-meta">${Number(latlng.lat).toFixed(4)}°, ${Number(latlng.lng).toFixed(4)}° · ${frame}</div></div>`;
    L.popup({className:'opera-cmax-popup',maxWidth:260,closeButton:true}).setLatLng(latlng).setContent(html).openOn(m);
  }

  function renderMap(opera = lastOpera) {
    const m = getMap();
    const button = $('operaCmaxToggle');
    if (!m || !button || typeof L === 'undefined') return;

    const enabled = button.classList.contains('active');
    if (!enabled) {
      clearFixed(m);
      publishState(button,{enabled:false,rendered:false,visiblePixels:0,significantPixels:0,frameUtc:'',palette:'POLRAD CMAX'});
      return;
    }
    if (!opera || opera.error || !opera.latest) {
      clearFixed(m);
      publishState(button,{enabled:true,rendered:false,visiblePixels:0,significantPixels:0,frameUtc:'',palette:'POLRAD CMAX'});
      return;
    }

    const p = pointFor(opera);
    const raster = rasterFor(opera.latest);
    if (!p || !raster) {
      clearFixed(m);
      publishState(button,{enabled:true,rendered:false,visiblePixels:0,significantPixels:0,frameUtc:fmtUtc(opera.frameEnd),palette:'POLRAD CMAX'});
      return;
    }

    ensurePane(m);
    ensureMapStyle();
    clearFixed(m);
    removeLegacyOpera(m);
    const bounds = raster.geoBounds || localBounds(p);
    lastRaster=raster;lastBounds=bounds;

    fixedLayer = L.imageOverlay(raster.url,bounds,{
      pane:PANE,
      opacity:.88,
      interactive:true,
      className:'opera-cmax-fixed-overlay',
      attribution:'EUMETNET OPERA CIRRUS'
    }).addTo(m);
    fixedLayer.on('click',ev=>{
      try{if(ev?.originalEvent&&L?.DomEvent)L.DomEvent.stopPropagation(ev.originalEvent)}catch(_){}
      showPointPopup(m,ev.latlng,raster,bounds,opera);
    });
    outlineLayer = L.rectangle(bounds,{
      pane:PANE,
      weight:1,
      opacity:.16,
      fill:false,
      dashArray:'4 4',
      interactive:false
    }).addTo(m);

    const frameUtc = fmtUtc(opera.frameEnd || opera.latest.time);
    const rendered = !!fixedLayer || !!outlineLayer;
    button.title = raster.visible > 0
      ? `OPERA CMAX · ${raster.pixelKm} km/piksel · ${frameUtc} · dotknij mapy, aby odczytać dBZ`
      : `OPERA CMAX · ${raster.pixelKm} km/piksel · ${frameUtc} · dotknij mapy, aby sprawdzić punkt`;
    publishState(button,{
      enabled:true,
      rendered,
      visiblePixels:raster.visible,
      significantPixels:raster.significant,
      frameUtc,
      maxDbz:finite(raster.max)?raster.max:null,
      bounds,
      pane:PANE,
      palette:'POLRAD CMAX',
      interactive:true,
      resolutionKm:raster.pixelKm
    });
  }

  function bindButton() {
    const button = $('operaCmaxToggle');
    if (!button || button === boundButton) return !!button;
    boundButton = button;
    button.setAttribute('aria-pressed',button.classList.contains('active')?'true':'false');
    button.addEventListener('click',ev => {
      if (ev.isTrusted) button.dataset.operaUserTouched = '1';
      setTimeout(() => {
        button.setAttribute('aria-pressed',button.classList.contains('active')?'true':'false');
        renderMap(lastOpera);
      },0);
    });
    return true;
  }

  function onOpera(ev) {
    lastOpera = ev?.detail || window.PrognozaEPIROperaNowcast || null;
    bindButton();
    const button = $('operaCmaxToggle');
    if (!button) return;
    if (!autoEnabled && lastOpera?.latest && !lastOpera.error && button.dataset.operaUserTouched !== '1') {
      autoEnabled = true;
      if (!button.classList.contains('active')) button.click();
      else renderMap(lastOpera);
      return;
    }
    renderMap(lastOpera);
  }

  bindButton();
  if (window.PrognozaEPIROperaNowcast) onOpera({detail:window.PrognozaEPIROperaNowcast});
  window.addEventListener('prognozaepir:opera-nowcast-updated',onOpera);
  setTimeout(bindButton,500);
  setTimeout(() => renderMap(window.PrognozaEPIROperaNowcast || lastOpera),3000);

  window.PrognozaEPIROperaMapLayer = {
    refresh:() => renderMap(window.PrognozaEPIROperaNowcast || lastOpera),
    get:() => window.PrognozaEPIROperaMapState || null,
    samplePoint:(lat,lon)=>lastRaster&&lastBounds?sampleRaster({lat:Number(lat),lng:Number(lon)},lastRaster,lastBounds):NaN
  };
})();