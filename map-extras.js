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

// CAPPI diagnostic view + detailed POLRAD dBZ legend -----------------------
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  if (window.__PrognozaEPIRCappiInstalled) return;
  window.__PrognozaEPIRCappiInstalled = true;

  const $ = id => document.getElementById(id);
  const mapEl = $('map');
  const mapbar = document.querySelector('.mapbar');
  if (!mapEl || !mapbar) return;

  const style = document.createElement('style');
  style.textContent = `
    #cappiWrap{display:none;width:100%;min-height:420px;background:#0b0d12;position:relative;overflow:hidden}
    #cappiImage{display:block;width:100%;height:100%;object-fit:contain;background:#0b0d12}
    #cappiStatus{position:absolute;left:8px;top:8px;z-index:2;background:rgba(10,12,16,.82);color:#fff;padding:6px 8px;border-radius:6px;font-size:9px;line-height:1.3;max-width:72%}
    .legend-dbz{max-height:none!important;overflow:visible!important;line-height:1.05!important;font-size:7.5px!important;padding:5px!important}
    .legend-dbz .dbz-row{display:flex;align-items:center;gap:3px;white-space:nowrap;margin:1px 0}
    .legend-dbz .sw{width:13px!important;height:5px!important;margin-right:0!important;flex:0 0 13px}
    @media(max-width:560px){#cappiWrap{min-height:360px}.legend-dbz{font-size:7px!important;padding:4px!important}.legend-dbz .dbz-row{margin:0}}
  `;
  document.head.appendChild(style);

  const DBZ = [
    [62,'#f58cff','≥62'],[59,'#f344f4','59'],[56,'#ff19cc','56'],[53,'#f00094','53'],[50,'#e60059','50'],
    [47,'#d80000','47'],[44,'#ff1600','44'],[41,'#ff4800','41'],[38,'#ff8800','38'],[35,'#ffbf00','35'],
    [32,'#fff200','32'],[29,'#fff69b','29'],[26,'#fffbd8','26'],[23,'#f3ffff','23'],[20,'#b8f4f1','20'],
    [17,'#53e8ef','17'],[14,'#1bc8f0','14'],[11,'#007ae5','11'],[8,'#0033e8','8'],[5,'#0000cc','5'],[0,'#0000aa','0']
  ];

  function upgradeLegend(){
    const legend = document.querySelector('.legend-dbz');
    if (!legend || legend.dataset.fullScale === '1') return;
    legend.dataset.fullScale = '1';
    legend.innerHTML = '<b>POLRAD dBZ</b>' + DBZ.map(([,color,label]) =>
      '<div class="dbz-row"><span class="sw" style="background:'+color+'"></span><span>'+label+' dBZ</span></div>'
    ).join('');
  }
  upgradeLegend();
  setTimeout(upgradeLegend,500);
  setTimeout(upgradeLegend,1500);

  const wrap = document.createElement('div');
  wrap.id = 'cappiWrap';
  wrap.setAttribute('aria-label','POLRAD CAPPI 1 km');
  const status = document.createElement('div');
  status.id = 'cappiStatus';
  status.textContent = 'CAPPI 1 km · IMGW/POLRAD';
  const image = document.createElement('img');
  image.id = 'cappiImage';
  image.alt = 'IMGW/POLRAD CAPPI 1 km';
  wrap.append(status,image);
  mapEl.insertAdjacentElement('afterend',wrap);

  const cappiBtn = document.createElement('button');
  cappiBtn.id = 'polrad_cappi';
  cappiBtn.type = 'button';
  cappiBtn.textContent = 'POLRAD CAPPI 1 km';
  cappiBtn.title = 'CAPPI: odbiciowość radarowa na wysokości około 1 km n.p.m. — warstwa diagnostyczna';
  const cmaxBtn = $('polrad_cmax');
  const sriBtn = $('polrad_sri');
  if (cmaxBtn) cmaxBtn.insertAdjacentElement('afterend',cappiBtn);
  else if (sriBtn) mapbar.insertBefore(cappiBtn,sriBtn);
  else mapbar.prepend(cappiBtn);

  const BOUNDS = L.latLngBounds([[48.5,13.5],[56.0,25.0]]);
  let cappiLayer = null;
  let savedActiveId = null;
  let controlsState = null;
  let active = false;

  const radarButtons = () => ['polrad_cmax','polrad_sri','polrad_pac','radarToggle'].map($).filter(Boolean);
  function saveAndDisableCurrentRadar(){
    const current = radarButtons().find(b => b.classList.contains('active'));
    savedActiveId = current?.id || null;
    if (current) current.click();
  }

  function setHistoryDisabled(disabled){
    const range = $('radarFrame'), play = $('playRadar');
    if (disabled) {
      controlsState = {rangeDisabled:range?.disabled || false,playDisabled:play?.disabled || false};
      if (range) range.disabled = true;
      if (play) play.disabled = true;
    } else if (controlsState) {
      if (range) range.disabled = controlsState.rangeDisabled;
      if (play) play.disabled = controlsState.playDisabled;
      controlsState = null;
    }
  }

  function fmtTime(sec){
    try {
      return new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(Number(sec)*1000));
    } catch (_) { return 'aktualna'; }
  }

  async function fetchListFrame(){
    const ctl = new AbortController();
    const timer = setTimeout(()=>ctl.abort(),8000);
    try {
      const r = await fetch('https://meteo.imgw.pl/api/radars/v1/list/cappi',{cache:'no-cache',signal:ctl.signal});
      if (!r.ok) throw new Error('HTTP '+r.status);
      const j = await r.json();
      const rows = j?.cappi?.list;
      if (!Array.isArray(rows) || !rows.length) throw new Error('brak listy CAPPI');
      return rows.filter(x=>x?.url&&Number.isFinite(Number(x?.date))).sort((a,b)=>Number(a.date)-Number(b.date)).at(-1) || null;
    } finally { clearTimeout(timer); }
  }

  function absoluteCandidate(s){
    s = String(s || '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i,'https://');
    if (s.startsWith('/')) return 'https://danepubliczne.imgw.pl'+s;
    if (/^(?:pl\/)?datastore\/getfiledown\//i.test(s)) return 'https://danepubliczne.imgw.pl/'+s;
    if (/^Oper\/Polrad\//i.test(s)) return 'https://danepubliczne.imgw.pl/pl/datastore/getfiledown/'+s;
    return null;
  }

  function collectStrings(value,out=[]){
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(v=>collectStrings(v,out));
    else if (value && typeof value === 'object') Object.values(value).forEach(v=>collectStrings(v,out));
    return out;
  }

  async function fetchRenderedCappiUrl(){
    const ctl = new AbortController();
    const timer = setTimeout(()=>ctl.abort(),9000);
    try {
      const r = await fetch('https://danepubliczne.imgw.pl/api/data/product/id/COMPO_CAPPI.comp.cappi',{cache:'no-cache',signal:ctl.signal});
      if (!r.ok) throw new Error('HTTP '+r.status);
      const j = await r.json();
      const candidates = collectStrings(j).map(absoluteCandidate).filter(Boolean).filter(u=>/cappi/i.test(u));
      const images = candidates.filter(u=>/\.(?:tmb|png|jpe?g|webp)(?:$|\?)/i.test(u));
      const list = images.length ? images : candidates;
      if (!list.length) throw new Error('brak adresu obrazu CAPPI');
      const stamp = u => {
        const m = String(u).match(/(20\d{12})/g);
        return m?.length ? Number(m.at(-1)) : 0;
      };
      list.sort((a,b)=>stamp(a)-stamp(b));
      return list.at(-1);
    } finally { clearTimeout(timer); }
  }

  function hideRendered(){
    wrap.style.display = 'none';
    image.removeAttribute('src');
    mapEl.style.display = '';
    setTimeout(()=>{ try { map.invalidateSize(); } catch (_) {} },40);
  }

  async function showCappi(){
    if (active) return;
    active = true;
    cappiBtn.classList.add('active');
    cappiBtn.setAttribute('aria-pressed','true');
    saveAndDisableCurrentRadar();
    setHistoryDisabled(true);
    status.textContent = 'CAPPI 1 km · IMGW/POLRAD · ładowanie…';
    const timeEl = $('radarTime');
    const info = $('echoInfo');
    if (info) info.textContent = 'CAPPI jest warstwą diagnostyczną 1 km. Analiza punktowa pozostaje dostępna dla CMAX, SRI i PAC 1 h.';

    try {
      const frame = await fetchListFrame();
      if (!frame) throw new Error('brak CAPPI');
      cappiLayer = L.imageOverlay(String(frame.url).replace(/^http:\/\//i,'https://'),BOUNDS,{opacity:.72,interactive:false,crossOrigin:true,attribution:'IMGW-PIB / POLRAD CAPPI'}).addTo(map);
      if (timeEl) timeEl.textContent = 'CAPPI: '+fmtTime(frame.date);
      status.textContent = 'CAPPI 1 km · IMGW/POLRAD · '+fmtTime(frame.date);
      hideRendered();
    } catch (listError) {
      try {
        const url = await fetchRenderedCappiUrl();
        if (!url) throw new Error('brak obrazu');
        if (cappiLayer && map.hasLayer(cappiLayer)) map.removeLayer(cappiLayer);
        cappiLayer = null;
        const h = Math.max(420,Math.round(mapEl.getBoundingClientRect().height || 560));
        wrap.style.height = h+'px';
        mapEl.style.display = 'none';
        wrap.style.display = 'block';
        image.src = url;
        status.textContent = 'CAPPI 1 km · oficjalny obraz IMGW/POLRAD';
        if (timeEl) timeEl.textContent = 'CAPPI: aktualny produkt';
      } catch (renderError) {
        status.textContent = 'CAPPI chwilowo niedostępne: '+(renderError?.message || listError?.message || 'błąd źródła');
        wrap.style.height = Math.max(420,Math.round(mapEl.getBoundingClientRect().height || 560))+'px';
        mapEl.style.display = 'none';
        wrap.style.display = 'block';
      }
    }
  }

  function hideCappi({restore=false}={}){
    if (!active) return;
    active = false;
    cappiBtn.classList.remove('active');
    cappiBtn.setAttribute('aria-pressed','false');
    if (cappiLayer && map.hasLayer(cappiLayer)) map.removeLayer(cappiLayer);
    cappiLayer = null;
    hideRendered();
    setHistoryDisabled(false);
    const restoreId = savedActiveId;
    savedActiveId = null;
    if (restore && restoreId) {
      const b = $(restoreId);
      if (b && !b.classList.contains('active')) setTimeout(()=>b.click(),30);
    }
  }

  cappiBtn.setAttribute('aria-pressed','false');
  cappiBtn.addEventListener('click',()=> active ? hideCappi({restore:true}) : showCappi());

  mapbar.addEventListener('click',e=>{
    const other = e.target.closest('button');
    if (active && other && other !== cappiBtn) hideCappi({restore:false});
  },true);

  for (const id of ['apply','resetPoint']) $(id)?.addEventListener('click',()=>{
    if (active) hideCappi({restore:true});
  },{capture:true});

  window.PrognozaEPIRCappi = {show:showCappi,hide:hideCappi,upgradeLegend};
})();

// Load the compact 11-step POLRAD legend after all legacy legend renderers.
(() => {
  if (document.getElementById('epirLegend11Loader')) return;
  const s = document.createElement('script');
  s.id = 'epirLegend11Loader';
  s.src = 'legend-11.js';
  s.defer = true;
  document.head.appendChild(s);
})();
