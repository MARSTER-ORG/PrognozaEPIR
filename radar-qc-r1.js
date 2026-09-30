'use strict';

// PrognozaEPIR POLRAD CMAX display QC r1 (2026-09-30)
// Visual-only quality-control layer. The canonical raw POLRAD frame and all
// analytical consumers keep using the original IMGW image/state.
(() => {
  if (window.__EPIR_POLRAD_QC_R1__) return;
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  window.__EPIR_POLRAD_QC_R1__ = true;

  const $ = id => document.getElementById(id);
  const PANE_RAW = 'polradImagePane';
  const PANE_QC = 'polradQcPane';
  const BOUNDS = L.latLngBounds([[48.5,13.5],[56.0,25.0]]);
  const RAW_OPACITY = 0.70;
  const QC_OPACITY = 0.72;
  const TEMPORAL_LIMIT_MS = 20 * 60 * 1000;
  const colorCache = new Map();

  let mode = 'qc'; // operational default on every page load
  let qcLayer = null;
  let qcBlobUrl = '';
  let renderToken = 0;
  let previousMask = null;
  let previousWidth = 0;
  let previousHeight = 0;
  let previousTimeMs = NaN;

  function ensurePane() {
    let pane = map.getPane(PANE_QC);
    if (!pane) pane = map.createPane(PANE_QC);
    pane.style.zIndex = '471';
    pane.style.pointerEvents = 'none';
  }
  ensurePane();

  const style = document.createElement('style');
  style.id = 'epirPolradQcStyle';
  style.textContent = `
    .polrad-qc-mode{font-weight:700}
    .polrad-qc-mode[hidden]{display:none!important}
    .polrad-qc-note{font-size:9px;color:var(--muted)}
  `;
  document.head.appendChild(style);

  function normalize(url) {
    return String(url || '').replace(/^http:\/\//i,'https://').replace(/#.*$/,'').replace(/[?&]_epir=\d+/g,'').replace(/[?&]$/,'');
  }

  function canonicalLayer(url) {
    const wanted = normalize(url);
    let exact = null;
    let newest = null;
    map.eachLayer(layer => {
      if (!(layer instanceof L.ImageOverlay)) return;
      if (String(layer?.options?.pane || '') !== PANE_RAW) return;
      if (normalize(layer?._url) === wanted) exact = layer;
      if (!newest || (layer?._leaflet_id || 0) > (newest?._leaflet_id || 0)) newest = layer;
    });
    return exact || newest;
  }

  function setRawOpacity(value, url) {
    const layer = canonicalLayer(url || window.PrognozaEPIRPolradState?.url);
    try { layer?.setOpacity?.(value); } catch (_) {}
  }

  function dropDisplayedQc() {
    if (qcLayer) {
      try { if (map.hasLayer(qcLayer)) map.removeLayer(qcLayer); } catch (_) {}
    }
    qcLayer = null;
    if (qcBlobUrl) {
      try { URL.revokeObjectURL(qcBlobUrl); } catch (_) {}
      qcBlobUrl = '';
    }
  }

  function removeQcLayer() {
    renderToken++;
    dropDisplayedQc();
  }

  function setStatusSuffix(text) {
    const el = $('polradQcStatus');
    if (el) el.textContent = text;
  }

  function createControls() {
    const mapbar = document.querySelector('.mapbar');
    if (!mapbar || $('polradQcMode')) return;

    const qc = document.createElement('button');
    qc.id = 'polradQcMode';
    qc.type = 'button';
    qc.className = 'polrad-qc-mode active';
    qc.textContent = 'CMAX QC';
    qc.title = 'Widok operacyjny: filtruje słabe, izolowane echa; zachowuje spójne pola i echo trwałe w kolejnych klatkach.';

    const raw = document.createElement('button');
    raw.id = 'polradRawMode';
    raw.type = 'button';
    raw.className = 'polrad-qc-mode';
    raw.textContent = 'CMAX RAW';
    raw.title = 'Surowy obraz CMAX IMGW/POLRAD bez filtracji wizualnej.';

    const anchor = $('polrad_cmax');
    if (anchor?.parentNode === mapbar) {
      anchor.insertAdjacentElement('afterend', raw);
      anchor.insertAdjacentElement('afterend', qc);
    } else {
      mapbar.prepend(raw);
      mapbar.prepend(qc);
    }

    const note = document.createElement('span');
    note.id = 'polradQcStatus';
    note.className = 'polrad-qc-note';
    note.textContent = 'QC: oczekiwanie na CMAX';
    raw.insertAdjacentElement('afterend', note);

    qc.addEventListener('click', () => setMode('qc'));
    raw.addEventListener('click', () => setMode('raw'));
    syncControls();
  }

  function cmaxIsActive() {
    return !!$('polrad_cmax')?.classList.contains('active');
  }

  function syncControls() {
    const visible = cmaxIsActive();
    const qc = $('polradQcMode');
    const raw = $('polradRawMode');
    const note = $('polradQcStatus');
    if (qc) { qc.hidden = !visible; qc.classList.toggle('active', visible && mode === 'qc'); }
    if (raw) { raw.hidden = !visible; raw.classList.toggle('active', visible && mode === 'raw'); }
    if (note) note.hidden = !visible;
  }

  function classifyRgb(r,g,b,a) {
    if (a < 45) return -1;
    const key = (r << 16) | (g << 8) | b;
    const cached = colorCache.get(key);
    if (cached !== undefined) return cached;

    const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn;
    if (mx < 38 || d * 100 < mx * 28) { colorCache.set(key,-1); return -1; }

    let h = 0;
    if (d) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    const v = mx / 255;
    let dbz = -1;
    if (h >= 225 && h < 285) dbz = v < .30 ? 5 : v < .42 ? 8 : v < .54 ? 11 : v < .66 ? 14 : v < .80 ? 17 : 20;
    else if (h >= 195 && h < 225) dbz = v < .62 ? 20 : v < .82 ? 23 : 26;
    else if (h >= 165 && h < 195) dbz = v < .72 ? 26 : 29;
    else if (h >= 105 && h < 165) dbz = v < .66 ? 29 : v < .84 ? 32 : 35;
    else if (h >= 70 && h < 105) dbz = v < .76 ? 35 : 38;
    else if (h >= 48 && h < 70) dbz = 38;
    else if (h >= 35 && h < 48) dbz = 41;
    else if (h >= 20 && h < 35) dbz = 44;
    else if (h < 20 || h >= 350) dbz = 47;
    else if (h >= 285 && h < 350) dbz = 50;
    colorCache.set(key,dbz);
    if (colorCache.size > 4096) colorCache.clear();
    return dbz;
  }

  function integral(mask,w,h) {
    const stride = w + 1;
    const out = new Uint32Array((w + 1) * (h + 1));
    for (let y=0;y<h;y++) {
      let row = 0;
      const src = y*w;
      const dst = (y+1)*stride;
      const prev = y*stride;
      for (let x=0;x<w;x++) {
        row += mask[src+x];
        out[dst+x+1] = out[prev+x+1] + row;
      }
    }
    return out;
  }

  function boxSum(ii,w,h,x,y,r) {
    const stride = w + 1;
    const x0 = Math.max(0,x-r), y0 = Math.max(0,y-r);
    const x1 = Math.min(w-1,x+r), y1 = Math.min(h-1,y+r);
    const a = y0*stride+x0;
    const b = y0*stride+x1+1;
    const c = (y1+1)*stride+x0;
    const d = (y1+1)*stride+x1+1;
    return ii[d]-ii[b]-ii[c]+ii[a];
  }

  function loadImage(url) {
    return new Promise((resolve,reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      let done = false;
      const finish = (ok,val) => { if (done) return; done = true; clearTimeout(timer); ok ? resolve(val) : reject(val); };
      const timer = setTimeout(() => finish(false,new Error('timeout obrazu CMAX')),9000);
      img.onload = () => finish(true,img);
      img.onerror = () => finish(false,new Error('CMAX/CORS niedostępny'));
      img.src = normalize(url) + (String(url).includes('?') ? '&' : '?') + '_epir_qc=' + Date.now();
    });
  }

  async function makeQcBlob(state) {
    const img = await loadImage(state.url);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('pusty obraz CMAX');

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(img,0,0);
    const image = ctx.getImageData(0,0,w,h);
    const data = image.data;
    const n = w*h;
    const values = new Int8Array(n);
    values.fill(-1);
    const mask = new Uint8Array(n);

    for (let i=0,p=0;i<n;i++,p+=4) {
      const dbz = classifyRgb(data[p],data[p+1],data[p+2],data[p+3]);
      values[i] = dbz;
      if (dbz >= 0) mask[i] = 1;
    }

    const ii = integral(mask,w,h);
    const temporalOk = previousMask && previousWidth === w && previousHeight === h && Number.isFinite(previousTimeMs) && Math.abs(Number(state.timeMs)-previousTimeMs) <= TEMPORAL_LIMIT_MS;
    const prevIi = temporalOk ? integral(previousMask,w,h) : null;
    let weak = 0, suppressed = 0, faded = 0, preserved = 0;

    for (let y=0;y<h;y++) {
      for (let x=0;x<w;x++) {
        const i = y*w+x;
        const dbz = values[i];
        if (dbz < 0 || dbz >= 23) continue;
        weak++;
        const local5 = boxSum(ii,w,h,x,y,2);
        const local9 = boxSum(ii,w,h,x,y,4);
        const persistent = prevIi ? boxSum(prevIi,w,h,x,y,3) > 0 : false;
        const coherent = local5 >= 5 || local9 >= 14 || persistent;
        const marginal = local5 >= 3 || local9 >= 7;
        let factor;
        if (coherent) {
          factor = dbz <= 11 ? .50 : .72;
          preserved++;
        } else if (marginal) {
          factor = dbz <= 11 ? .18 : .35;
          faded++;
        } else {
          factor = dbz <= 14 ? 0 : .10;
          suppressed++;
        }
        const a = i*4+3;
        data[a] = Math.round(data[a] * factor);
      }
    }

    ctx.putImageData(image,0,0);
    const blob = await new Promise((resolve,reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('nie można utworzyć obrazu QC')),'image/png'));
    return {blob,mask,w,h,stats:{weak,suppressed,faded,preserved,temporal:!!prevIi}};
  }

  async function renderQc(state) {
    if (mode !== 'qc' || String(state?.product || '').toLowerCase() !== 'cmax' || !cmaxIsActive()) return;
    const token = ++renderToken;
    const raw = canonicalLayer(state.url);
    try { raw?.setOpacity?.(0); } catch (_) {}
    setStatusSuffix('QC: filtruję klatkę…');

    try {
      const result = await makeQcBlob(state);
      if (token !== renderToken || mode !== 'qc' || !cmaxIsActive()) return;
      const blobUrl = URL.createObjectURL(result.blob);
      const next = L.imageOverlay(blobUrl,BOUNDS,{pane:PANE_QC,opacity:QC_OPACITY,interactive:false,attribution:'IMGW-PIB / POLRAD · QC PrognozaEPIR'});
      const loaded = await new Promise(resolve => {
        let done = false;
        const finish = ok => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
        const timer = setTimeout(() => finish(false),5000);
        next.once('load',()=>finish(true));
        next.once('error',()=>finish(false));
        next.addTo(map);
      });
      if (!loaded || token !== renderToken || mode !== 'qc' || !cmaxIsActive()) {
        try { if (map.hasLayer(next)) map.removeLayer(next); } catch (_) {}
        URL.revokeObjectURL(blobUrl);
        if (token === renderToken) {
          dropDisplayedQc();
          setRawOpacity(RAW_OPACITY,state.url);
          setStatusSuffix('QC niedostępne — pokazuję RAW');
        }
        return;
      }

      const old = qcLayer, oldUrl = qcBlobUrl;
      qcLayer = next; qcBlobUrl = blobUrl;
      if (old && old !== next) { try { if (map.hasLayer(old)) map.removeLayer(old); } catch (_) {} }
      if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch (_) {} }
      previousMask = result.mask;
      previousWidth = result.w; previousHeight = result.h; previousTimeMs = Number(state.timeMs);
      const s = result.stats;
      const removedPct = s.weak ? Math.round(100*s.suppressed/s.weak) : 0;
      setStatusSuffix(`QC aktywne · słabe echa: ${removedPct}% izolowanych wygaszono${s.temporal?' · kontrola trwałości klatka↔klatka':''}`);
    } catch (err) {
      if (token !== renderToken) return;
      dropDisplayedQc();
      setRawOpacity(RAW_OPACITY,state.url);
      setStatusSuffix('QC niedostępne — pokazuję RAW');
      console.warn('PrognozaEPIR POLRAD QC:',err);
    }
  }

  function setMode(nextMode) {
    mode = nextMode === 'raw' ? 'raw' : 'qc';
    syncControls();
    const state = window.PrognozaEPIRPolradState || {};
    if (mode === 'raw') {
      removeQcLayer();
      setRawOpacity(RAW_OPACITY,state.url);
      setStatusSuffix('RAW · bez filtracji');
      return;
    }
    if (String(state.product || '').toLowerCase() === 'cmax' && cmaxIsActive()) renderQc(state);
  }

  function onFrame(state) {
    createControls();
    syncControls();
    const product = String(state?.product || '').toLowerCase();
    if (product !== 'cmax' || !cmaxIsActive()) {
      removeQcLayer();
      setRawOpacity(RAW_OPACITY,state?.url);
      return;
    }
    if (mode === 'qc') renderQc(state);
    else { removeQcLayer(); setRawOpacity(RAW_OPACITY,state.url); setStatusSuffix('RAW · bez filtracji'); }
  }

  window.addEventListener('prognozaepir:polrad-frame-changed',e => onFrame(e.detail || window.PrognozaEPIRPolradState || {}));
  document.addEventListener('click',e => {
    if (!e.target?.closest?.('.mapbar button')) return;
    setTimeout(() => {
      createControls();
      syncControls();
      const state = window.PrognozaEPIRPolradState || {};
      if (!cmaxIsActive()) {
        removeQcLayer();
        setRawOpacity(RAW_OPACITY,state.url);
      }
    },50);
  });

  createControls();
  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.12.0';
  if (window.PrognozaEPIRPolradState) setTimeout(() => onFrame(window.PrognozaEPIRPolradState),0);

  window.PrognozaEPIRPolradQc = {
    setMode,
    getMode: () => mode,
    refresh: () => renderQc(window.PrognozaEPIRPolradState || {}),
    state: () => ({mode,hasLayer:!!qcLayer,previousTimeMs})
  };
})();
