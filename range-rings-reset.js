'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $ = id => document.getElementById(id);
  const RADII_KM = [10,25,50,75,100];
  let ownedRings = [];
  let rebuildTimer = null;

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.12.2';

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
    // Remove every old distance/analysis circle. The selected-point marker is a CircleMarker,
    // so it is deliberately not included here.
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
        // Result-navigation markers are CircleMarkers; keep only the real selected-point marker.
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

  function zoomToAnalysisRadius(radiusKm=selectedAnalysisRadius(), {scroll=true}={}){
    const p = currentPoint();
    if (!p) return;
    const radius = RADII_KM.includes(Number(radiusKm)) ? Number(radiusKm) : 100;

    // Reconcile rings if an older module has replaced/removed any of them.
    const validOwned = ownedRings.length === RADII_KM.length && ownedRings.every(r => {
      try { return map.hasLayer(r); } catch (_) { return false; }
    });
    if (!validOwned) {
      rebuild({resetResults:false,activeRadiusKm:radius});
    } else {
      highlightAnalysisRing(radius);
    }

    const target = ownedRings[RADII_KM.indexOf(radius)] || L.circle([p.lat,p.lon],{radius:radius*1000});
    try {
      map.invalidateSize(false);
      map.fitBounds(target.getBounds(),{
        paddingTopLeft:[18,18],
        paddingBottomRight:[18,18],
        animate:true,
        duration:.35,
        maxZoom:13
      });
    } catch (_) {
      map.setView([p.lat,p.lon], radius<=10?10:radius<=25?9:radius<=50?8:radius<=75?7:6);
    }

    if (scroll) {
      const mapEl = $('map');
      setTimeout(() => {
        try { mapEl?.scrollIntoView({behavior:'smooth',block:'center'}); } catch (_) { mapEl?.scrollIntoView(); }
      }, 80);
    }
  }

  // Run last in the addon chain. Earlier modules may move or recreate their own ring objects;
  // this wrapper removes those stale objects and makes one authoritative five-ring set.
  if (typeof updatePointUI === 'function' && !window.__epirRangeResetWrapped) {
    window.__epirRangeResetWrapped = true;
    const previousUpdatePointUI = updatePointUI;
    updatePointUI = function(){
      const out = previousUpdatePointUI.apply(this, arguments);
      scheduleRebuild(0, true);
      return out;
    };
  }

  // Fallbacks also cover changes initiated by the 3-second hold (which clicks Apply).
  $('apply')?.addEventListener('click', () => scheduleRebuild(120, true));
  $('resetPoint')?.addEventListener('click', () => scheduleRebuild(120, true));

  // Analysis radius controls the map viewport. The map is fitted immediately on click,
  // regardless of whether a qualifying echo is later found.
  function bindAnalysisZoom(){
    const btn = $('echoAnalyze');
    if (!btn || btn.dataset.radiusZoomBound === '1') return;
    btn.dataset.radiusZoomBound = '1';
    btn.addEventListener('click', () => {
      const radius = selectedAnalysisRadius();
      zoomToAnalysisRadius(radius,{scroll:true});
      // Re-apply once after other synchronous listeners have finished manipulating layers.
      setTimeout(() => zoomToAnalysisRadius(radius,{scroll:false}), 120);
    }, {capture:true});
  }

  bindAnalysisZoom();
  setTimeout(bindAnalysisZoom,700);
  setInterval(bindAnalysisZoom,1500);

  // Initial reconciliation removes duplicate legacy rings left by earlier modules.
  setTimeout(() => rebuild({resetResults:false}), 1200);

  window.PrognozaEPIRRangeReset = {
    rebuild,
    clearOldPointGraphics,
    zoomToAnalysisRadius,
    radiiKm:RADII_KM.slice()
  };
})();
