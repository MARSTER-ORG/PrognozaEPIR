'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $ = id => document.getElementById(id);
  const RADII_KM = [10,25,50,75,100];
  let ownedRings = [];
  let rebuildTimer = null;

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.12.1';

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

  function buildFiveRings(){
    const p = currentPoint();
    if (!p) return;
    ownedRings = RADII_KM.map(radiusKm => L.circle([p.lat,p.lon],{
      radius:radiusKm*1000,
      color:'#1f2a75',
      weight:1,
      fill:false,
      dashArray:'4 4',
      interactive:false,
      className:'epir-range-ring'
    }).addTo(map));
    window.PrognozaEPIRRangeRings = {
      center:{...p},
      radiiKm:RADII_KM.slice(),
      layers:ownedRings.slice()
    };
  }

  function rebuild({resetResults=true}={}){
    clearOldPointGraphics();
    buildFiveRings();
    if (resetResults) resetAnalysisReadout();
  }

  function scheduleRebuild(delay=80, resetResults=true){
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuild({resetResults}), delay);
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

  // Initial reconciliation removes duplicate legacy rings left by earlier modules.
  setTimeout(() => rebuild({resetResults:false}), 1200);

  window.PrognozaEPIRRangeReset = {rebuild, clearOldPointGraphics, radiiKm:RADII_KM.slice()};
})();
