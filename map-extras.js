'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $ = id => document.getElementById(id);
  const mapEl = $('map');
  const mapbar = document.querySelector('.mapbar');
  if (!mapEl || !mapbar) return;

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.8';

  const style = document.createElement('style');
  style.textContent = `
    #blitzortungWrap{display:none;width:100%;min-height:420px;background:#0b0d12;position:relative;overflow:hidden}
    #blitzortungFrame{display:block;width:100%;height:100%;border:0;background:#0b0d12}
    .echo-result.result-jump{cursor:pointer;transition:filter .12s ease,transform .12s ease;touch-action:manipulation}
    .echo-result.result-jump:active{transform:scale(.985)}
    .echo-result.result-jump::after{content:'↗ mapa';display:block;margin-top:4px;font-size:8px;color:var(--blue2);font-weight:700}
    .result-nav-popup{font-size:11px;line-height:1.35;min-width:160px}
    .result-nav-popup b{font-size:13px}
  `;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'blitzortungWrap';
  wrap.setAttribute('aria-label','Blitzortung LIVE');
  const frame = document.createElement('iframe');
  frame.id = 'blitzortungFrame';
  frame.title = 'Blitzortung LIVE — aktualne wyładowania';
  frame.loading = 'lazy';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  wrap.appendChild(frame);
  mapEl.insertAdjacentElement('afterend', wrap);

  const btn = document.createElement('button');
  btn.id = 'blitzortungLive';
  btn.type = 'button';
  btn.textContent = '⚡ Blitzortung LIVE';
  btn.title = 'Osadzona mapa LIVE Blitzortung/LiMaps';
  const lightningBtn = $('lightningToggle') || $('mtgLiToggle') || [...mapbar.querySelectorAll('button')].find(b => /wyładowania|lightning/i.test(b.textContent));
  if (lightningBtn) lightningBtn.insertAdjacentElement('afterend',btn); else mapbar.appendChild(btn);

  let lastMapHeight = Math.max(420, Math.round(mapEl.getBoundingClientRect().height || 560));
  let resultMarker = null;

  function selectedPoint(){
    if (typeof point !== 'undefined' && Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon))) {
      return {lat:Number(point.lat),lon:Number(point.lon)};
    }
    const lat = Number(String($('lat')?.value || '').replace(',','.'));
    const lon = Number(String($('lon')?.value || '').replace(',','.'));
    return {lat:Number.isFinite(lat)?lat:52.7989,lon:Number.isFinite(lon)?lon:18.2639};
  }

  function blitzUrl(){
    const p = selectedPoint();
    const zoom = 8;
    const qs = [
      'MapInteractive=1','NavigationControl=0','NavigationControlCompass=0',
      'FullScreenControl=0','GeolocateControl=0','ScaleControl=1',
      'Cookies=0','InfoDiv=0','MenuDiv=0','MapScrollZoom=1',
      'MapDragRotate=0','MapTouchRotate=0','MapProjection=mercator','MapLanguage=en'
    ].join('&');
    return 'https://maps.blitzortung.org/?'+qs+'#'+zoom+'/'+p.lat.toFixed(4)+'/'+p.lon.toFixed(4);
  }

  function refreshBlitzCenter(force=false){
    if (!force && !btn.classList.contains('active')) return;
    const url = blitzUrl();
    if (frame.dataset.current !== url) {
      frame.dataset.current = url;
      frame.src = url;
    }
  }

  function showBlitzortung(){
    const h = mapEl.getBoundingClientRect().height;
    if (h > 200) lastMapHeight = Math.round(h);
    wrap.style.height = Math.max(420,lastMapHeight)+'px';
    refreshBlitzCenter(true);
    mapEl.style.display = 'none';
    wrap.style.display = 'block';
    btn.classList.add('active');
    btn.setAttribute('aria-pressed','true');
  }

  function showRadarMap(){
    if (!btn.classList.contains('active') && mapEl.style.display !== 'none') return;
    wrap.style.display = 'none';
    mapEl.style.display = '';
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed','false');
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 40);
  }

  btn.setAttribute('aria-pressed','false');
  btn.addEventListener('click',() => btn.classList.contains('active') ? showRadarMap() : showBlitzortung());

  // Any normal layer selection returns to the native Leaflet/POLRAD map.
  mapbar.addEventListener('click',e => {
    const other = e.target.closest('button');
    if (other && other !== btn && btn.classList.contains('active')) showRadarMap();
  },true);

  for (const id of ['apply','resetPoint']) {
    $(id)?.addEventListener('click',() => setTimeout(() => refreshBlitzCenter(),350));
  }

  function parseCoords(text){
    const m = String(text || '').match(/(-?\d{1,2}(?:[.,]\d+)?)\s*,\s*(-?\d{1,3}(?:[.,]\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1].replace(',','.'));
    const lon = Number(m[2].replace(',','.'));
    return Number.isFinite(lat) && Number.isFinite(lon) ? {lat,lon} : null;
  }

  function resultCoords(kind){
    return parseCoords($(kind === 'max' ? 'echoMaxCoords' : 'echoCoords')?.textContent);
  }

  function popupText(kind){
    const heading = $('echoHeading')?.textContent || 'Analiza POLRAD';
    if (kind === 'max') {
      return '<div class="result-nav-popup"><b>Maksimum w promieniu</b><br>'+($('echoMaxValue')?.textContent || '—')+'<br><small>'+heading+'</small></div>';
    }
    return '<div class="result-nav-popup"><b>Najbliższy obszar</b><br>'+($('echoFoundValue')?.textContent || '—')+' · '+($('echoDistance')?.textContent || '')+' · '+($('echoBearing')?.textContent || '')+'<br><small>'+heading+'</small></div>';
  }

  function jumpToResult(kind){
    const c = resultCoords(kind);
    if (!c) return;
    showRadarMap();
    const mapCard = mapEl.closest('.card');
    mapCard?.scrollIntoView({behavior:'smooth',block:'start'});
    setTimeout(() => {
      try {
        map.invalidateSize();
        map.setView([c.lat,c.lon],Math.max(10,map.getZoom()),{animate:true});
        if (resultMarker && map.hasLayer(resultMarker)) map.removeLayer(resultMarker);
        resultMarker = L.circleMarker([c.lat,c.lon],{radius:8,weight:3,fillOpacity:.9}).addTo(map);
        resultMarker.bindPopup(popupText(kind),{autoPan:true}).openPopup();
      } catch (_) {}
    },260);
  }

  function makeJumpTile(el,kind,label){
    const tile = el?.closest('.echo-result');
    if (!tile || tile.dataset.jumpReady) return;
    tile.dataset.jumpReady = '1';
    tile.dataset.jumpKind = kind;
    tile.classList.add('result-jump');
    tile.setAttribute('role','button');
    tile.setAttribute('tabindex','0');
    tile.setAttribute('title',label);
    const go = () => jumpToResult(kind);
    tile.addEventListener('click',go);
    tile.addEventListener('keydown',e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }

  function bindResultTiles(){
    for (const id of ['echoDistance','echoBearing','echoFoundValue','echoCoords']) makeJumpTile($(id),'nearest','Pokaż najbliższy obszar na mapie');
    makeJumpTile($('echoMaxValue'),'max','Pokaż maksimum w promieniu na mapie');
  }

  bindResultTiles();
  const obs = new MutationObserver(bindResultTiles);
  obs.observe(document.body,{childList:true,subtree:true});
  setTimeout(() => obs.disconnect(),8000);

  window.PrognozaEPIRMapExtras = {showRadarMap,showBlitzortung,refreshBlitzCenter,jumpToResult};
})();
