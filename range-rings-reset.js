'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $ = id => document.getElementById(id);
  const RADII_KM = [10,25,50,75,100];
  let ownedRings = [];
  let rebuildTimer = null;

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.12.3';

  function currentPoint(){
    if (typeof point !== 'undefined' && Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon))) {
      return {lat:Number(point.lat), lon:Number(point.lon)};
    }
    const lat = Number(String($('lat')?.value || '').replace(',','.'));
    const lon = Number(String($('lon')?.value || '').replace(',','.'));
    return Number.isFinite(lat) && Number.isFinite(lon) ? {lat,lon} : null;
  }

  function removeLayerSafe(layer){
    try { if (layer && map.hasLayer(layer)) map.removeLayer(layer); } catch (_) {}
  }

  function clearOldPointGraphics(){
    const remove = [];
    map.eachLayer(layer => {
      try {
        if (layer instanceof L.Circle && !(layer instanceof L.CircleMarker)) {
          remove.push(layer);
          return;
        }
        const pane = layer?.options?.pane;
        if (pane === 'analysisResultPane' || pane === 'analysisMaskPane') {
          remove.push(layer);
          return;
        }
        if (layer instanceof L.CircleMarker && (typeof marker === 'undefined' || layer !== marker)) {
          remove.push(layer);
        }
      } catch (_) {}
    });
    remove.forEach(removeLayerSafe);
    ownedRings = [];
    try { map.closePopup(); } catch (_) {}
  }

  function resetAnalysisReadout(){
    for (const id of ['echoDistance','echoBearing','echoFoundValue','echoCoords','echoMaxValue']) {
      const el = $(id); if (el) el.textContent = '—';
    }
    for (const id of ['echoCompass','echoFrameTime','echoMaxCoords']) {
      const el = $(id); if (el) el.textContent = '—';
    }
    const info = $('echoInfo');
    if (info) {
      info.classList.remove('error');
      info.textContent = 'Punkt zmieniony — uruchom analizę ponownie dla nowej lokalizacji.';
    }
  }

  function ringStyle(radiusKm, activeRadiusKm=null){
    const active = Number(radiusKm) === Number(activeRadiusKm);
    return {
      radius:radiusKm*1000,
      color:active ? '#5268ff' : '#1f2a75',
      weight:active ? 2.5 : 1,
      opacity:active ? 1 : .9,
      fill:false,
      dashArray:active ? '7 4' : '4 4',
      interactive:false,
      className:'epir-range-ring' + (active ? ' epir-analysis-ring-active' : '')
    };
  }

  function buildFiveRings(activeRadiusKm=null){
    const p = currentPoint();
    if (!p) return;
    ownedRings = RADII_KM.map(radiusKm => L.circle([p.lat,p.lon],ringStyle(radiusKm,activeRadiusKm)).addTo(map));
    window.PrognozaEPIRRangeRings = {
      center:{...p},
      radiiKm:RADII_KM.slice(),
      activeRadiusKm:Number.isFinite(Number(activeRadiusKm)) ? Number(activeRadiusKm) : null,
      layers:ownedRings.slice()
    };
  }

  function rebuild({resetResults=true,activeRadiusKm=null}={}){
    clearOldPointGraphics();
    buildFiveRings(activeRadiusKm);
    if (resetResults) resetAnalysisReadout();
  }

  function scheduleRebuild(delay=80, resetResults=true){
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuild({resetResults}), delay);
  }

  function selectedAnalysisRadius(){
    const r = Number($('echoRadius')?.value);
    return RADII_KM.includes(r) ? r : 100;
  }

  function highlightAnalysisRing(radiusKm){
    ownedRings.forEach((ring,i) => {
      const r = RADII_KM[i];
      if (!ring) return;
      const active = r === radiusKm;
      ring.setStyle({
        color:active ? '#5268ff' : '#1f2a75',
        weight:active ? 2.5 : 1,
        opacity:active ? 1 : .9,
        dashArray:active ? '7 4' : '4 4'
      });
    });
    if (window.PrognozaEPIRRangeRings) window.PrognozaEPIRRangeRings.activeRadiusKm = radiusKm;
  }

  function ensureRings(radius){
    const validOwned = ownedRings.length === RADII_KM.length && ownedRings.every(r => {
      try { return map.hasLayer(r); } catch (_) { return false; }
    });
    if (!validOwned) rebuild({resetResults:false,activeRadiusKm:radius});
    else highlightAnalysisRing(radius);
  }

  function fitAnalysisRadius(radiusKm=selectedAnalysisRadius()){
    const p = currentPoint();
    if (!p) return;
    const radius = RADII_KM.includes(Number(radiusKm)) ? Number(radiusKm) : 100;
    ensureRings(radius);
    const target = ownedRings[RADII_KM.indexOf(radius)] || L.circle([p.lat,p.lon],{radius:radius*1000});
    try {
      map.stop();
      map.invalidateSize(false);
      map.fitBounds(target.getBounds(),{
        paddingTopLeft:[16,16],
        paddingBottomRight:[16,16],
        animate:false,
        maxZoom:13
      });
    } catch (_) {
      map.setView([p.lat,p.lon], radius<=10?10:radius<=25?9:radius<=50?8:radius<=75?7:6, {animate:false});
    }
  }

  function scrollMapIntoView(behavior='smooth'){
    const mapEl = $('map');
    if (!mapEl) return;
    try {
      const rect = mapEl.getBoundingClientRect();
      const top = Math.max(0, window.scrollY + rect.top - 6);
      window.scrollTo({top,behavior});
    } catch (_) {
      try { mapEl.scrollIntoView({behavior,block:'start'}); } catch (_) { mapEl.scrollIntoView(); }
    }
  }

  function goToAnalysisMap(radiusKm=selectedAnalysisRadius()){
    const radius = RADII_KM.includes(Number(radiusKm)) ? Number(radiusKm) : 100;

    // The user's click means: leave the analysis card and show the map now.
    scrollMapIntoView('smooth');
    fitAnalysisRadius(radius);

    // Mobile browsers can shift the page while analysis results are being written.
    // Re-assert both scroll position and radius after layout settles.
    requestAnimationFrame(() => fitAnalysisRadius(radius));
    setTimeout(() => {
      scrollMapIntoView('auto');
      fitAnalysisRadius(radius);
    }, 220);
    setTimeout(() => {
      scrollMapIntoView('auto');
      fitAnalysisRadius(radius);
    }, 650);
  }

  function zoomToAnalysisRadius(radiusKm=selectedAnalysisRadius(), {scroll=true}={}){
    const radius = RADII_KM.includes(Number(radiusKm)) ? Number(radiusKm) : 100;
    if (scroll) goToAnalysisMap(radius);
    else fitAnalysisRadius(radius);
  }

  if (typeof updatePointUI === 'function' && !window.__epirRangeResetWrapped) {
    window.__epirRangeResetWrapped = true;
    const previousUpdatePointUI = updatePointUI;
    updatePointUI = function(){
      const out = previousUpdatePointUI.apply(this, arguments);
      scheduleRebuild(0, true);
      return out;
    };
  }

  $('apply')?.addEventListener('click', () => scheduleRebuild(120, true));
  $('resetPoint')?.addEventListener('click', () => scheduleRebuild(120, true));

  function bindAnalysisZoom(){
    const btn = $('echoAnalyze');
    if (!btn || btn.dataset.radiusJumpBound === '1') return;
    btn.dataset.radiusJumpBound = '1';
    btn.addEventListener('click', () => {
      goToAnalysisMap(selectedAnalysisRadius());
    }, {capture:true});
  }

  bindAnalysisZoom();
  setTimeout(bindAnalysisZoom,300);
  setTimeout(bindAnalysisZoom,900);
  setInterval(bindAnalysisZoom,1500);

  setTimeout(() => rebuild({resetResults:false}), 1200);

  // Keep the POLRAD legend intentionally compact. A legacy CAPPI helper still
  // contains the full 21-colour scale, so the final renderer must run after it.
  const LEGEND_11 = [
    ['≥59','#f58cff'],
    ['53–58','#ff19cc'],
    ['47–52','#e60059'],
    ['41–46','#ff1600'],
    ['35–40','#ff8800'],
    ['29–34','#fff200'],
    ['23–28','#fffbd8'],
    ['17–22','#b8f4f1'],
    ['11–16','#1bc8f0'],
    ['5–10','#0033e8'],
    ['0–4','#0000aa']
  ];

  function renderLegend11(){
    const legend = document.querySelector('.legend-dbz');
    if (!legend) return;
    legend.dataset.fullScale = '1';
    legend.dataset.steps = '11';
    legend.innerHTML = '<b>POLRAD dBZ</b><div class="dbz-grid">' + LEGEND_11.map(([label,color]) =>
      '<div class="dbz-row"><span class="sw" style="background:'+color+'"></span><span>'+label+'</span></div>'
    ).join('') + '</div>';
  }

  const legendStyle = document.createElement('style');
  legendStyle.id = 'epirFinalLegend11Style';
  legendStyle.textContent = `
    .legend-dbz{font-size:7px!important;line-height:1.05!important;padding:4px 5px!important;min-width:82px!important;max-height:none!important;overflow:visible!important}
    .legend-dbz>b{display:block;font-size:8px!important;margin-bottom:3px!important}
    .legend-dbz .dbz-grid{display:grid!important;grid-template-columns:1fr!important;gap:1px!important}
    .legend-dbz .dbz-row{display:flex!important;align-items:center!important;gap:3px!important;white-space:nowrap!important;margin:0!important}
    .legend-dbz .sw{width:11px!important;height:6px!important;flex:0 0 11px!important;margin:0!important}
  `;
  document.head.appendChild(legendStyle);
  renderLegend11();
  setTimeout(renderLegend11,250);
  setTimeout(renderLegend11,900);
  setTimeout(renderLegend11,1800);

  const legendHost = document.querySelector('.leaflet-control-container') || document.body;
  const legendObserver = new MutationObserver(() => {
    const legend = document.querySelector('.legend-dbz');
    if (legend && legend.dataset.steps !== '11') renderLegend11();
  });
  legendObserver.observe(legendHost,{childList:true,subtree:true});

  // Layer hygiene: if no radar product button is active, no POLRAD/RainViewer
  // imagery may remain on the Leaflet map. This also catches a late async CAPPI
  // response that arrives after CAPPI has already been switched off.
  const radarButtonIds = ['polrad_cmax','polrad_cappi','polrad_sri','polrad_pac','radarToggle'];
  function anyRadarActive(){
    return radarButtonIds.some(id => $(id)?.classList.contains('active'));
  }

  function isRadarDataLayer(layer){
    try {
      const attr = String(layer?.options?.attribution || '');
      const url = String(layer?._url || layer?._image?.currentSrc || layer?._image?.src || '');
      const text = (attr + ' ' + url).toLowerCase();
      return /polrad|rainviewer|meteo\.imgw\.pl\/.*radar/.test(text);
    } catch (_) { return false; }
  }

  function purgeInactiveRadarLayers(){
    if (anyRadarActive()) return;
    const remove = [];
    map.eachLayer(layer => { if (isRadarDataLayer(layer)) remove.push(layer); });
    remove.forEach(removeLayerSafe);

    // CAPPI has a fallback rendered outside Leaflet. Hide that as well if a
    // delayed request completes after the user has already disabled the layer.
    const cappiWrap = $('cappiWrap');
    const cappiImage = $('cappiImage');
    const mapEl = $('map');
    if (cappiWrap && cappiWrap.style.display !== 'none') cappiWrap.style.display = 'none';
    if (cappiImage?.getAttribute('src')) cappiImage.removeAttribute('src');
    if (mapEl && mapEl.style.display === 'none' && !document.getElementById('blitzortungLive')?.classList.contains('active')) {
      mapEl.style.display = '';
      setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 30);
    }
  }

  map.on('layeradd', e => {
    if (!anyRadarActive() && isRadarDataLayer(e.layer)) {
      setTimeout(() => {
        if (!anyRadarActive() && map.hasLayer(e.layer)) removeLayerSafe(e.layer);
      }, 0);
    }
  });

  const mapbar = document.querySelector('.mapbar');
  mapbar?.addEventListener('click', () => {
    setTimeout(purgeInactiveRadarLayers,0);
    setTimeout(purgeInactiveRadarLayers,120);
    setTimeout(purgeInactiveRadarLayers,700);
  });

  const cappiWrap = $('cappiWrap');
  const cappiImage = $('cappiImage');
  if (cappiWrap) {
    const cappiObserver = new MutationObserver(() => {
      if (!anyRadarActive()) setTimeout(purgeInactiveRadarLayers,0);
    });
    cappiObserver.observe(cappiWrap,{attributes:true,subtree:true,attributeFilter:['style','src']});
    if (cappiImage) cappiObserver.observe(cappiImage,{attributes:true,attributeFilter:['src']});
  }

  setTimeout(purgeInactiveRadarLayers,2200);

  window.PrognozaEPIRRangeReset = {
    rebuild,
    clearOldPointGraphics,
    fitAnalysisRadius,
    goToAnalysisMap,
    zoomToAnalysisRadius,
    renderLegend11,
    purgeInactiveRadarLayers,
    radiiKm:RADII_KM.slice()
  };
})();
