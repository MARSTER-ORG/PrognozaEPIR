'use strict';

// PrognozaEPIR POLRAD stability bridge r10 (2026-09-20)
// - removes stale POLRAD image overlays after every successful frame swap,
// - makes POLRAD ImageOverlay frames CORS-readable for echo-analysis.js,
// - exposes the canonical POLRAD pane to the existing analysis selector,
// - freezes animation while a spatial echo analysis is running.
(() => {
  if (window.__EPIR_RADAR_STABILITY_R10__) return;
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  window.__EPIR_RADAR_STABILITY_R10__ = true;

  const $ = id => document.getElementById(id);
  const PANE = 'polradImagePane';
  const normalize = value => String(value || '')
    .replace(/^http:\/\//i, 'https://')
    .replace(/[?&]_epir=\d+/g, '')
    .replace(/[?&]$/, '');

  // Leaflet only sets the HTMLImageElement crossOrigin attribute when the
  // ImageOverlay option is present before _initImage(). The POLRAD renderer did
  // not set it, so echo-analysis.js could either not find the image (custom
  // pane) or get a tainted canvas. Patch only the POLRAD pane.
  const proto = L.ImageOverlay?.prototype;
  if (proto && !proto.__epirPolradCorsR10) {
    proto.__epirPolradCorsR10 = true;
    const originalInitImage = proto._initImage;
    proto._initImage = function() {
      if (this?.options?.pane === PANE) this.options.crossOrigin = 'anonymous';
      return originalInitImage.call(this);
    };
  }

  function preparePane() {
    const pane = map.getPane(PANE);
    if (!pane) return null;
    // echo-analysis.js historically looked only inside .leaflet-overlay-pane.
    // Keep the dedicated z-index/pointer policy, but make this pane discoverable
    // by that selector as well.
    pane.classList.add('leaflet-overlay-pane');
    pane.style.zIndex = '470';
    pane.style.pointerEvents = 'none';
    return pane;
  }

  function isPolradLayer(layer) {
    if (!(layer instanceof L.ImageOverlay)) return false;
    const pane = String(layer?.options?.pane || '');
    const attribution = String(layer?.options?.attribution || '').toLowerCase();
    const url = normalize(layer?._url).toLowerCase();
    if (pane === PANE) return true;
    if (attribution.includes('polrad') || attribution.includes('imgw-pib / polrad')) return true;
    return /imgw|polrad/.test(url) && /cmax|cappi|sri|pac|eht|hail|grad/.test(url);
  }

  function findCurrentLayer(currentUrl) {
    const wanted = normalize(currentUrl);
    let exact = null;
    let newest = null;
    map.eachLayer(layer => {
      if (!isPolradLayer(layer)) return;
      if (normalize(layer?._url) === wanted) exact = layer;
      if (!newest || (layer?._leaflet_id || 0) > (newest?._leaflet_id || 0)) newest = layer;
    });
    return exact || newest;
  }

  function sweep(currentUrl) {
    preparePane();
    const keeper = findCurrentLayer(currentUrl);
    const stale = [];
    map.eachLayer(layer => {
      if (isPolradLayer(layer) && layer !== keeper) stale.push(layer);
    });
    for (const layer of stale) {
      try { map.removeLayer(layer); } catch (_) {}
    }

    const pane = map.getPane(PANE);
    if (pane && keeper?._image) {
      // A successful animation frame must correspond to exactly one visible
      // image in the POLRAD pane. This removes detached/legacy DOM ghosts too.
      for (const img of [...pane.querySelectorAll('img.leaflet-image-layer')]) {
        if (img !== keeper._image) {
          try { img.remove(); } catch (_) {}
        }
      }
    }
    return {keeper, removed: stale.length};
  }

  let corsRefreshDone = false;
  let corsRefreshPending = false;
  function ensureCorsCurrent(detail) {
    if (corsRefreshDone || corsRefreshPending) return;
    const layer = findCurrentLayer(detail?.url);
    const img = layer?._image;
    const hasCorsAttribute = !!img?.hasAttribute?.('crossorigin');
    const cors = String(img?.crossOrigin || '').toLowerCase();
    if (hasCorsAttribute && (cors === 'anonymous' || cors === '')) {
      corsRefreshDone = true;
      return;
    }
    const product = String(detail?.product || '').toLowerCase();
    if (!product || !window.PrognozaEPIRRadarLayers?.select) return;
    if (!$('polrad_' + product)?.classList.contains('active')) return;
    corsRefreshPending = true;
    setTimeout(async () => {
      try {
        await window.PrognozaEPIRRadarLayers.select(product);
        const refreshed = findCurrentLayer(window.PrognozaEPIRPolradState?.url || detail?.url)?._image;
        corsRefreshDone = !!refreshed?.hasAttribute?.('crossorigin');
      } catch (_) {
        corsRefreshDone = false;
      } finally {
        corsRefreshPending = false;
      }
    }, 60);
  }

  function onFrame(detail) {
    const state = detail || window.PrognozaEPIRPolradState || {};
    // The canonical renderer dispatches this event only after the new frame has
    // loaded. It is therefore safe to remove every older POLRAD overlay here.
    sweep(state.url);
    ensureCorsCurrent(state);
  }

  window.addEventListener('prognozaepir:polrad-frame-changed', e => onFrame(e.detail));

  // If the patch loads after a frame is already visible, clean the pane now.
  preparePane();
  if (window.PrognozaEPIRPolradState) {
    setTimeout(() => onFrame(window.PrognozaEPIRPolradState), 0);
  }

  // Stop the animation before echo-analysis zooms/fits the map and samples
  // pixels. Otherwise a frame swap can occur halfway through the scan.
  document.addEventListener('click', e => {
    const target = e.target?.closest?.('#echoAnalyze,#echoPresets button');
    if (!target) return;
    try { window.PrognozaEPIRRadarLayers?.stop?.(); } catch (_) {}
    setTimeout(() => {
      const state = window.PrognozaEPIRPolradState;
      if (state?.url) sweep(state.url);
    }, 0);
  }, true);

  // Re-assert the pane contract after map mode switches or late scripts.
  const observer = new MutationObserver(() => preparePane());
  const mapContainer = map.getContainer();
  observer.observe(mapContainer, {childList:true, subtree:true});

  window.PrognozaEPIRRadarStability = {
    sweep: () => sweep(window.PrognozaEPIRPolradState?.url),
    state: () => {
      const current = window.PrognozaEPIRPolradState || null;
      let count = 0;
      map.eachLayer(layer => { if (isPolradLayer(layer)) count++; });
      return {current, polradImageLayers:count, corsRefreshDone};
    }
  };
})();
