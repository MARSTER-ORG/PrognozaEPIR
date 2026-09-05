'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  const byId = id => document.getElementById(id);

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.10.2';

  // --- Map point selection: 3 second hold ---
  const mapEl = byId('map');
  if (mapEl) {
    mapEl.style.position = 'relative';
    const hint = document.createElement('div');
    hint.className = 'map-hint';
    hint.innerHTML = '<b>Wybór punktu:</b> przytrzymaj wybrane miejsce na mapie przez 3 sekundy. Współrzędne i wszystkie dane zmienią się automatycznie.';
    mapEl.parentNode.insertBefore(hint, mapEl);
    const bubble = document.createElement('div');
    bubble.id = 'holdProgress';
    bubble.className = 'hold-progress';
    bubble.textContent = 'Przytrzymaj… 0 s';
    mapEl.appendChild(bubble);
  }

  const style = document.createElement('style');
  style.textContent = `
    .map-hint{padding:6px 8px;font-size:10px;color:var(--muted);border-bottom:1px solid var(--line);background:var(--panel2)}
    .map-hint b{color:var(--blue2)}
    .hold-progress{position:absolute;z-index:1000;pointer-events:none;background:rgba(0,0,0,.76);color:#fff;padding:5px 8px;border-radius:999px;font-size:10px;transform:translate(-50%,-120%);display:none}
    .products{padding:8px}.product-row{display:grid;grid-template-columns:105px 1fr auto;gap:7px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);font-size:10px}.product-row:last-child{border-bottom:0}.product-row a{color:var(--blue2);text-decoration:none}
    @media(max-width:560px){.product-row{grid-template-columns:80px 1fr auto;font-size:9px}}
  `;
  document.head.appendChild(style);

  let holdTimer = null, holdTick = null, holdLatLng = null, holdStart = 0, holdPoint = null;
  const bubble = byId('holdProgress');
  const holdUi = (show, text, ll) => {
    if (!bubble) return;
    bubble.style.display = show ? 'block' : 'none';
    if (text) bubble.textContent = text;
    if (show && ll) {
      const q = map.latLngToContainerPoint(ll);
      bubble.style.left = q.x + 'px';
      bubble.style.top = q.y + 'px';
    }
  };
  const cancelHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    if (holdTick) clearInterval(holdTick);
    holdTimer = holdTick = null;
    holdLatLng = null;
    holdPoint = null;
    holdUi(false);
  };
  const startHold = e => {
    cancelHold();
    holdLatLng = e.latlng;
    holdPoint = map.latLngToContainerPoint(e.latlng);
    holdStart = Date.now();
    holdUi(true, 'Przytrzymaj… 0.0 s', holdLatLng);
    holdTick = setInterval(() => {
      const sec = Math.min(3, (Date.now() - holdStart) / 1000);
      holdUi(true, 'Przytrzymaj… ' + sec.toFixed(1) + ' s', holdLatLng);
    }, 100);
    holdTimer = setTimeout(async () => {
      const ll = holdLatLng;
      cancelHold();
      if (!ll) return;
      point = {lat: ll.lat, lon: ll.lng, name: 'Punkt z mapy'};
      updatePointUI();
      map.setView([point.lat, point.lon], Math.max(map.getZoom(), 8));
      try { await refreshAll(); } catch (_) {}
      loadPolradProducts();
    }, 3000);
  };
  const cancelIfMoved = e => {
    if (!holdPoint || !e.latlng) return;
    const q = map.latLngToContainerPoint(e.latlng);
    if (Math.hypot(q.x - holdPoint.x, q.y - holdPoint.y) > 14) cancelHold();
  };
  map.on('mousedown touchstart', startHold);
  map.on('mousemove touchmove', cancelIfMoved);
  map.on('mouseup touchend dragstart zoomstart', cancelHold);
  map.getContainer().addEventListener('contextmenu', e => e.preventDefault());

  // Replace old fixed rings with rings that follow the selected point.
  const stale = [];
  map.eachLayer(layer => {
    if (layer instanceof L.Circle && !(layer instanceof L.CircleMarker)) stale.push(layer);
  });
  stale.forEach(layer => map.removeLayer(layer));
  const rings = [10000,25000,50000,100000].map(radius => L.circle([point.lat,point.lon],{
    radius,color:'#1f2a75',weight:1,fill:false,dashArray:'4 4'
  }).addTo(map));
  const originalUpdatePointUI = updatePointUI;
  updatePointUI = function() {
    originalUpdatePointUI();
    rings.forEach(r => r.setLatLng([point.lat,point.lon]));
  };

  // --- Official EUMETSAT MTG layers ---
  const wms = 'https://view.eumetsat.int/geoserver/wms';
  const mtgLayers = {
    geo: L.tileLayer.wms(wms,{layers:'mtg_fd:rgb_geocolour',format:'image/png',transparent:true,opacity:.72,attribution:'EUMETSAT MTG/FCI'}),
    ir:  L.tileLayer.wms(wms,{layers:'mtg_fd:ir105_hrfi',format:'image/png',transparent:true,opacity:.72,attribution:'EUMETSAT MTG/FCI IR10.5'}),
    li:  L.tileLayer.wms(wms,{layers:'mtg_fd:li_afa',format:'image/png',transparent:true,opacity:.88,attribution:'EUMETSAT MTG/LI'})
  };
  const mapbar = document.querySelector('.mapbar');
  const addLayerButton = (id, label, layer) => {
    if (!mapbar || byId(id)) return;
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.textContent = label;
    const anchor = byId('satToggle');
    anchor ? anchor.insertAdjacentElement('afterend', b) : mapbar.prepend(b);
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      if (b.classList.contains('active')) layer.addTo(map); else map.removeLayer(layer);
    });
  };
  addLayerButton('mtgGeoToggle','MTG Geo',mtgLayers.geo);
  addLayerButton('mtgIrToggle','MTG IR10.5',mtgLayers.ir);
  addLayerButton('mtgLiToggle','MTG LI',mtgLayers.li);

  // --- Official IMGW / POLRAD product API ---
  const warningCard = [...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('Ostrzeżenia IMGW'));
  const polradCard = document.createElement('section');
  polradCard.className = 'card';
  polradCard.style.marginTop = '8px';
  polradCard.innerHTML = `<h2>IMGW / POLRAD — oficjalne produkty</h2><div class="products">
    <div class="product-row"><b>CMAX</b><span id="imgwCmax">Ładowanie…</span><a href="https://danepubliczne.imgw.pl/api/data/product/id/COMPO_CMAX_250.comp.cmax" target="_blank" rel="noopener">API ↗</a></div>
    <div class="product-row"><b>CAPPI</b><span id="imgwCappi">Ładowanie…</span><a href="https://danepubliczne.imgw.pl/api/data/product/id/COMPO_CAPPI.comp.cappi_h5" target="_blank" rel="noopener">API ↗</a></div>
    <div class="product-row"><b>Echo Top</b><span id="imgwEht">Ładowanie…</span><a href="https://danepubliczne.imgw.pl/api/data/product/id/COMPO_EHT.comp.eht" target="_blank" rel="noopener">API ↗</a></div>
    <div class="product-row"><b>PAC 1 h</b><span id="imgwPac">Ładowanie…</span><a href="https://danepubliczne.imgw.pl/api/data/product/id/COMPO_PAC.comp.pac" target="_blank" rel="noopener">API ↗</a></div>
    <div class="product-row"><b>SRI</b><span id="imgwSri">Ładowanie…</span><a href="https://danepubliczne.imgw.pl/api/data/product/id/COMPO_SRI.comp.sri_h5" target="_blank" rel="noopener">API ↗</a></div>
    <small>Produkty są pobierane bezpośrednio z publicznego API IMGW/POLRAD. Punktowe dBZ pozostaje na razie z kompozytu RainViewer — surowa siatka POLRAD/HDF5 wymaga osobnego dekodera.</small>
  </div>`;
  if (warningCard?.parentNode) warningCard.parentNode.insertBefore(polradCard, warningCard);

  const PRODUCTS = [
    ['imgwCmax','COMPO_CMAX_250.comp.cmax'],['imgwCappi','COMPO_CAPPI.comp.cappi_h5'],
    ['imgwEht','COMPO_EHT.comp.eht'],['imgwPac','COMPO_PAC.comp.pac'],['imgwSri','COMPO_SRI.comp.sri_h5']
  ];
  const metaText = v => {
    if (v == null) return 'brak odpowiedzi';
    const vals = [];
    const walk = (x,d=0) => {
      if (d > 3 || x == null) return;
      if (typeof x === 'string' || typeof x === 'number') {
        const t = String(x);
        if (/202\d[-_/]|\.h5|\.cmax|\.cappi|\.eht|\.pac|\.sri|https?:/i.test(t)) vals.push(t);
      } else if (Array.isArray(x)) x.slice(-4).forEach(y => walk(y,d+1));
      else if (typeof x === 'object') for (const [k,y] of Object.entries(x)) if (/date|time|data|plik|file|url|name|nazwa/i.test(k)) walk(y,d+1);
    };
    walk(v);
    const unique = [...new Set(vals)].slice(-2);
    return unique.length ? unique.map(x => String(x).slice(0,90)).join(' · ') : 'produkt dostępny';
  };
  async function loadPolradProducts() {
    let ok = 0;
    await Promise.all(PRODUCTS.map(async ([id,prod]) => {
      const el = byId(id); if (!el) return;
      try {
        const r = await fetch('https://danepubliczne.imgw.pl/api/data/product/id/' + encodeURIComponent(prod), {cache:'no-cache'});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        el.textContent = metaText(j); ok++;
      } catch (_) { el.textContent = 'API niedostępne / CORS'; }
    }));
    const sources = document.querySelector('.sources');
    if (sources && !byId('srcPolrad')) {
      const row = document.createElement('div');
      row.innerHTML = '<span id="srcPolrad" class="dot"></span>Radar oficjalny: IMGW/POLRAD — CMAX, CAPPI, EHT, PAC, SRI';
      sources.prepend(row);
    }
    const dot = byId('srcPolrad');
    if (dot) dot.className = 'dot ' + (ok ? 'ok' : 'bad');
  }
  loadPolradProducts();
  byId('refresh')?.addEventListener('click', loadPolradProducts);

  const sources = document.querySelector('.sources');
  if (sources && !byId('srcMtg')) {
    const row = document.createElement('div');
    row.innerHTML = '<span id="srcMtg" class="dot ok"></span>Satelita oficjalny: EUMETSAT MTG — GeoColour, IR10.5, Lightning Imager';
    sources.prepend(row);
  }
})();
