'use strict';

// PrognozaEPIR POLRAD stability bridge r11 (2026-09-20)
// Keeps one canonical POLRAD frame, but leaves the lightning/LFL runtime alone.
// A transparent CORS-enabled mirror in Leaflet's standard overlayPane is used
// only by echo-analysis.js, which historically scans that pane for the raster.
(() => {
  if (window.__EPIR_RADAR_STABILITY_R11__) return;
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  window.__EPIR_RADAR_STABILITY_R11__ = true;

  const $ = id => document.getElementById(id);
  const PANE = 'polradImagePane';
  const BOUNDS = L.latLngBounds([[48.5,13.5],[56.0,25.0]]);
  const normalize = value => String(value || '')
    .replace(/^http:\/\//i, 'https://')
    .replace(/#.*$/, '')
    .replace(/[?&]_epir=\d+/g, '')
    .replace(/[?&]$/, '');

  let mirror = null;
  let mirrorKey = '';
  let mirrorReady = false;

  function isCanonicalPolrad(layer) {
    return layer instanceof L.ImageOverlay && String(layer?.options?.pane || '') === PANE;
  }

  function currentCanonical(url) {
    const wanted = normalize(url);
    let exact = null;
    let newest = null;
    map.eachLayer(layer => {
      if (!isCanonicalPolrad(layer)) return;
      if (normalize(layer?._url) === wanted) exact = layer;
      if (!newest || (layer?._leaflet_id || 0) > (newest?._leaflet_id || 0)) newest = layer;
    });
    return exact || newest;
  }

  function pruneCanonical(url) {
    const keep = currentCanonical(url);
    const stale = [];
    map.eachLayer(layer => {
      if (isCanonicalPolrad(layer) && layer !== keep) stale.push(layer);
    });
    for (const layer of stale) {
      try { map.removeLayer(layer); } catch (_) {}
    }

    const pane = map.getPane(PANE);
    if (pane && keep?._image) {
      for (const img of [...pane.querySelectorAll('img.leaflet-image-layer')]) {
        if (img !== keep._image) {
          try { img.remove(); } catch (_) {}
        }
      }
    }
    return {keep, removed: stale.length};
  }

  function removeMirror() {
    if (mirror) {
      try { if (map.hasLayer(mirror)) map.removeLayer(mirror); } catch (_) {}
    }
    mirror = null;
    mirrorKey = '';
    mirrorReady = false;
  }

  function ensureMirror(detail) {
    const state = detail || window.PrognozaEPIRPolradState || {};
    const product = String(state.product || '').toLowerCase();
    const url = normalize(state.url);
    if (!url || !['cmax','sri','pac'].includes(product)) {
      removeMirror();
      return Promise.resolve(false);
    }
    if (!$('polrad_' + product)?.classList.contains('active')) {
      removeMirror();
      return Promise.resolve(false);
    }

    const key = product + '|' + url;
    if (mirror && mirrorKey === key && map.hasLayer(mirror) && mirrorReady) {
      return Promise.resolve(true);
    }

    removeMirror();
    mirrorKey = key;
    const src = url + '#/_' + product + '.';
    mirror = L.imageOverlay(src, BOUNDS, {
      pane:'overlayPane',
      opacity:0.001,
      interactive:false,
      crossOrigin:true,
      attribution:''
    });
    mirror._epirAnalysisMirror = true;

    return new Promise(resolve => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        mirrorReady = ok;
        if (!ok) removeMirror();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 8000);
      mirror.once('load', () => { clearTimeout(timer); finish(true); });
      mirror.once('error', () => { clearTimeout(timer); finish(false); });
      try { mirror.addTo(map); } catch (_) { clearTimeout(timer); finish(false); }
    });
  }

  function onFrame(detail) {
    const state = detail || window.PrognozaEPIRPolradState || {};
    pruneCanonical(state.url);
    ensureMirror(state).catch(() => {});
  }

  window.addEventListener('prognozaepir:polrad-frame-changed', e => onFrame(e.detail));

  document.addEventListener('click', e => {
    const target = e.target?.closest?.('#echoAnalyze,#echoPresets button');
    if (!target) return;
    try { window.PrognozaEPIRRadarLayers?.stop?.(); } catch (_) {}
    const state = window.PrognozaEPIRPolradState || {};
    pruneCanonical(state.url);
    ensureMirror(state).catch(() => {});
  }, true);

  document.addEventListener('click', e => {
    const button = e.target?.closest?.('.mapbar button');
    if (!button) return;
    setTimeout(() => {
      const state = window.PrognozaEPIRPolradState || {};
      const product = String(state.product || '').toLowerCase();
      if (!product || !$('polrad_' + product)?.classList.contains('active')) removeMirror();
    }, 0);
  });

  if (window.PrognozaEPIRPolradState) {
    setTimeout(() => onFrame(window.PrognozaEPIRPolradState), 0);
  }

  window.PrognozaEPIRRadarStability = {
    refreshAnalysisMirror: () => ensureMirror(window.PrognozaEPIRPolradState),
    prune: () => pruneCanonical(window.PrognozaEPIRPolradState?.url),
    state: () => ({
      current: window.PrognozaEPIRPolradState || null,
      mirrorReady,
      mirrorKey,
      canonicalLayers: (() => {
        let n = 0;
        map.eachLayer(layer => { if (isCanonicalPolrad(layer)) n++; });
        return n;
      })()
    })
  };
})();
