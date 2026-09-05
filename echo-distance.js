'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $e = id => document.getElementById(id);
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const clampNum = (v,a,b) => Math.max(a, Math.min(b, v));

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.1';

  const style = document.createElement('style');
  style.textContent = `
    .echo-tools{padding:9px 10px}
    .echo-controls{display:flex;flex-wrap:wrap;gap:7px;align-items:end}
    .echo-field{display:flex;flex-direction:column;gap:3px;min-width:105px}
    .echo-field label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
    .echo-field input,.echo-field select,.echo-controls button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:7px;padding:7px 9px;font-size:11px}
    .echo-controls button{background:var(--blue2);color:#fff;border-color:var(--blue2);font-weight:700}
    .echo-presets{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
    .echo-presets button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:6px;padding:5px 7px;font-size:9px}
    .echo-results{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:9px}
    .echo-result{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:58px}
    .echo-result small{display:block;color:var(--muted);font-size:9px;margin-bottom:3px}
    .echo-result strong{display:block;font-size:15px;line-height:1.1}
    .echo-result span{display:block;color:var(--muted);font-size:8.5px;margin-top:3px;overflow-wrap:anywhere}
    .echo-status{margin-top:8px;font-size:9px;color:var(--muted);line-height:1.35}
    .echo-status.error{color:var(--red)}
    @media(max-width:560px){.echo-results{grid-template-columns:repeat(2,minmax(0,1fr))}.echo-field{min-width:92px;flex:1}.echo-controls button{width:100%}}
  `;
  document.head.appendChild(style);

  const rightColumn = document.querySelector('.layout > div:nth-child(2)');
  if (!rightColumn || $e('echoDistanceCard')) return;

  const dataCard = [...rightColumn.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('Dane dla punktu'));
  const card = document.createElement('section');
  card.id = 'echoDistanceCard';
  card.className = 'card';
  card.style.marginTop = '8px';
  card.innerHTML = `
    <h2>Najbliższe echo radarowe · odległość i azymut</h2>
    <div class="echo-tools">
      <div class="echo-controls">
        <div class="echo-field">
          <label for="echoDbzThreshold">Próg odbiciowości</label>
          <input id="echoDbzThreshold" type="number" min="27" max="60" step="1" value="45" inputmode="numeric">
        </div>
        <div class="echo-field">
          <label for="echoRadius">Promień analizy</label>
          <select id="echoRadius">
            <option value="25">25 km</option>
            <option value="50">50 km</option>
            <option value="75">75 km</option>
            <option value="100" selected>100 km</option>
          </select>
        </div>
        <button id="echoAnalyze" type="button">Znajdź najbliższe echo</button>
      </div>
      <div class="echo-presets">
        <button type="button" data-echo-preset="27">Opad ≥27 dBZ</button>
        <button type="button" data-echo-preset="40">Mocniejsze echo ≥40 dBZ</button>
        <button type="button" data-echo-preset="45">Silne echo ≥45 dBZ</button>
        <button type="button" data-echo-preset="50">Konwekcyjne ≥50 dBZ</button>
        <button type="button" data-echo-preset="55">Bardzo silne ≥55 dBZ</button>
      </div>
      <div class="echo-results">
        <div class="echo-result"><small>Odległość</small><strong id="echoDistance">—</strong><span>od zaznaczonego punktu</span></div>
        <div class="echo-result"><small>Azymut</small><strong id="echoBearing">—</strong><span id="echoCompass">—</span></div>
        <div class="echo-result"><small>Odbiciowość echa</small><strong id="echoFoundDbz">—</strong><span id="echoFrameTime">—</span></div>
        <div class="echo-result"><small>Współrzędne echa</small><strong id="echoCoords">—</strong><span>najbliższy spójny obszar ≥ progu</span></div>
        <div class="echo-result"><small>Maksimum w promieniu</small><strong id="echoMaxDbz">—</strong><span id="echoMaxCoords">—</span></div>
        <div class="echo-result"><small>Próg / promień</small><strong id="echoSettings">45 dBZ</strong><span>100 km</span></div>
      </div>
      <div id="echoStatus" class="echo-status">Analiza wykorzystuje najnowszą wybraną klatkę RainViewer. Odbiciowość jest wyznaczana z oficjalnej palety Universal Blue. Funkcja szuka spójnego echa, nie pojedynczego izolowanego piksela.</div>
    </div>`;

  if (dataCard?.nextSibling) rightColumn.insertBefore(card, dataCard.nextSibling);
  else if (dataCard) rightColumn.appendChild(card);
  else rightColumn.prepend(card);

  let echoLine = null;
  let echoMarker = null;
  let maxMarker = null;

  function clearEchoOverlay() {
    if (echoLine) map.removeLayer(echoLine);
    if (echoMarker) map.removeLayer(echoMarker);
    if (maxMarker) map.removeLayer(maxMarker);
    echoLine = echoMarker = maxMarker = null;
  }

  function compass16(deg) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  }

  function haversineKm(a, b) {
    const R = 6371.0088;
    const p1 = toRad(a.lat), p2 = toRad(b.lat);
    const dp = toRad(b.lat - a.lat), dl = toRad(b.lon - a.lon);
    const h = Math.sin(dp/2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function initialBearing(a, b) {
    const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function worldPixel(lat, lon, z) {
    const world = 256 * (2 ** z);
    const sin = Math.sin(toRad(clampNum(lat, -85.05112878, 85.05112878)));
    return {
      x: (lon + 180) / 360 * world,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world
    };
  }

  function worldPixelToLatLon(x, y, z) {
    const world = 256 * (2 ** z);
    const lon = x / world * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / world;
    const lat = toDeg(Math.atan(Math.sinh(n)));
    return {lat, lon};
  }

  function imagePixelLatLon(px, py, center, z, size) {
    const c = worldPixel(center.lat, center.lon, z);
    return worldPixelToLatLon(c.x + (px + 0.5 - size/2), c.y + (py + 0.5 - size/2), z);
  }

  function loadRadarImage(frame, center, z=7, size=256) {
    return new Promise((resolve, reject) => {
      if (typeof radarMeta === 'undefined' || !radarMeta?.host || !frame?.path) {
        reject(new Error('Brak metadanych radaru.'));
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Nie udało się pobrać obrazu radarowego.'));
      img.src = radarMeta.host + frame.path + '/' + size + '/' + z + '/' + center.lat.toFixed(5) + '/' + center.lon.toFixed(5) + '/2/0_0.png';
    });
  }

  function coherent(mask, x, y, w, h) {
    let n = 0;
    for (let yy = Math.max(0,y-1); yy <= Math.min(h-1,y+1); yy++) {
      for (let xx = Math.max(0,x-1); xx <= Math.min(w-1,x+1); xx++) {
        if (xx === x && yy === y) continue;
        if (mask[yy*w + xx]) n++;
      }
    }
    return n >= 2;
  }

  async function analyzeEcho() {
    const status = $e('echoStatus');
    const thresholdInput = $e('echoDbzThreshold');
    const radiusInput = $e('echoRadius');
    const threshold = clampNum(Math.round(Number(thresholdInput?.value) || 45), 27, 60);
    const radius = clampNum(Number(radiusInput?.value) || 100, 5, 100);
    if (thresholdInput) thresholdInput.value = String(threshold);
    $e('echoSettings').textContent = threshold + ' dBZ';
    $e('echoSettings').nextElementSibling.textContent = radius + ' km';

    clearEchoOverlay();
    for (const id of ['echoDistance','echoBearing','echoFoundDbz','echoCoords','echoMaxDbz']) $e(id).textContent = '—';
    $e('echoCompass').textContent = '—';
    $e('echoFrameTime').textContent = '—';
    $e('echoMaxCoords').textContent = '—';
    status.classList.remove('error');
    status.textContent = 'Analizuję najnowszą klatkę radarową…';

    try {
      if (typeof radarFrames === 'undefined' || !radarFrames?.length) throw new Error('Brak załadowanych klatek RainViewer. Najpierw odśwież dane.');
      if (typeof pixelToDbz !== 'function') throw new Error('Brak dekodera palety dBZ.');
      if (typeof point === 'undefined' || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) throw new Error('Brak prawidłowego punktu odniesienia.');

      const frame = radarFrames[(typeof radarIndex === 'number' ? radarIndex : radarFrames.length - 1)] || radarFrames[radarFrames.length - 1];
      const center = {lat:Number(point.lat), lon:Number(point.lon)};
      const z = 7, size = 256;
      const img = await loadRadarImage(frame, center, z, size);
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d', {willReadFrequently:true});
      ctx.drawImage(img, 0, 0, size, size);
      const rgba = ctx.getImageData(0, 0, size, size).data;
      const dbz = new Int16Array(size * size);
      const mask = new Uint8Array(size * size);

      let max = null;
      for (let y=0; y<size; y++) {
        for (let x=0; x<size; x++) {
          const i = y*size+x, p = i*4;
          const v = pixelToDbz(rgba[p], rgba[p+1], rgba[p+2], rgba[p+3]);
          dbz[i] = Number.isFinite(v) ? Math.round(v) : -999;
          if (!Number.isFinite(v)) continue;
          const ll = imagePixelLatLon(x,y,center,z,size);
          const dist = haversineKm(center,ll);
          if (dist <= radius) {
            if (!max || v > max.dbz || (v === max.dbz && dist < max.distance)) max = {dbz:v, distance:dist, ...ll};
            if (v >= threshold) mask[i] = 1;
          }
        }
      }

      let nearest = null;
      for (let y=0; y<size; y++) {
        for (let x=0; x<size; x++) {
          const i = y*size+x;
          if (!mask[i] || !coherent(mask,x,y,size,size)) continue;
          const ll = imagePixelLatLon(x,y,center,z,size);
          const dist = haversineKm(center,ll);
          if (dist > radius) continue;
          if (!nearest || dist < nearest.distance) nearest = {dbz:dbz[i], distance:dist, ...ll};
        }
      }

      if (max) {
        $e('echoMaxDbz').textContent = Math.round(max.dbz) + ' dBZ';
        $e('echoMaxCoords').textContent = max.lat.toFixed(4) + ', ' + max.lon.toFixed(4);
        maxMarker = L.circleMarker([max.lat,max.lon], {radius:5,color:'#7b32a8',weight:2,fillColor:'#fff',fillOpacity:.9}).addTo(map).bindTooltip('Maksimum: ~'+Math.round(max.dbz)+' dBZ');
      } else {
        $e('echoMaxDbz').textContent = 'brak';
        $e('echoMaxCoords').textContent = 'brak echa w promieniu';
      }

      if (!nearest) {
        $e('echoDistance').textContent = 'brak';
        status.textContent = 'Nie znaleziono spójnego echa ≥ ' + threshold + ' dBZ w promieniu ' + radius + ' km od zaznaczonego punktu.';
        if (typeof fmtTime === 'function') $e('echoFrameTime').textContent = fmtTime(frame.time*1000);
        return;
      }

      const bearing = initialBearing(center, nearest);
      const dir = compass16(bearing);
      $e('echoDistance').textContent = nearest.distance < 10 ? nearest.distance.toFixed(1) + ' km' : nearest.distance.toFixed(0) + ' km';
      $e('echoBearing').textContent = Math.round(bearing) + '°';
      $e('echoCompass').textContent = dir + ' · azymut od punktu do echa';
      $e('echoFoundDbz').textContent = '~' + Math.round(nearest.dbz) + ' dBZ';
      $e('echoFrameTime').textContent = (typeof fmtTime === 'function' ? fmtTime(frame.time*1000) : new Date(frame.time*1000).toLocaleString('pl-PL'));
      $e('echoCoords').textContent = nearest.lat.toFixed(4) + ', ' + nearest.lon.toFixed(4);

      echoLine = L.polyline([[center.lat,center.lon],[nearest.lat,nearest.lon]], {color:'#c83d31',weight:2,dashArray:'6 5'}).addTo(map);
      echoMarker = L.circleMarker([nearest.lat,nearest.lon], {radius:7,color:'#c83d31',weight:3,fillColor:'#fff',fillOpacity:1}).addTo(map)
        .bindTooltip('Najbliższe echo ≥ '+threshold+' dBZ<br>'+nearest.distance.toFixed(1)+' km · '+Math.round(bearing)+'° '+dir, {direction:'top'});

      const bounds = L.latLngBounds([[center.lat,center.lon],[nearest.lat,nearest.lon]]).pad(.28);
      map.fitBounds(bounds, {maxZoom:9, animate:true});
      status.textContent = 'Znaleziono najbliższe spójne echo ≥ ' + threshold + ' dBZ. Odległość i azymut są liczone geodezyjnie od aktualnie zaznaczonego punktu.';
    } catch (err) {
      status.classList.add('error');
      status.textContent = 'Analiza echa nie powiodła się: ' + (err?.message || err);
    }
  }

  $e('echoAnalyze')?.addEventListener('click', analyzeEcho);
  $e('echoDbzThreshold')?.addEventListener('keydown', e => { if (e.key === 'Enter') analyzeEcho(); });
  document.querySelectorAll('[data-echo-preset]').forEach(b => b.addEventListener('click', () => {
    $e('echoDbzThreshold').value = b.dataset.echoPreset;
    analyzeEcho();
  }));

  $e('apply')?.addEventListener('click', () => {
    clearEchoOverlay();
    const status = $e('echoStatus');
    if (status) status.textContent = 'Punkt odniesienia zmieniony. Uruchom ponownie analizę najbliższego echa.';
  });
  $e('resetPoint')?.addEventListener('click', () => {
    clearEchoOverlay();
    const status = $e('echoStatus');
    if (status) status.textContent = 'Przywrócono Inowrocław. Uruchom ponownie analizę najbliższego echa.';
  });
})();
