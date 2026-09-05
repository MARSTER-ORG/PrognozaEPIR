'use strict';

// PrognozaEPIR v0.11.0
// Official POLRAD map layers + IMGW warning overlay + multi-model AIFS/ICON/GFS nowcast.
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const byId = id => document.getElementById(id);
  const clamp01 = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (v, d = 1) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));

  // CMAX composite geographic extent used by IMGW national products.
  // Source images are published in EPSG:3857; Leaflet projects these corner bounds.
  const POLRAD_BOUNDS = L.latLngBounds([[48.5, 13.5], [56.0, 25.0]]);
  const POLRAD_PRODUCTS = {
    cmax: {label:'POLRAD CMAX', short:'CMAX'},
    sri:  {label:'POLRAD SRI', short:'SRI'},
    pac:  {label:'POLRAD PAC 1h', short:'PAC'}
  };

  let polradProduct = 'cmax';
  let polradFrames = [];
  let polradIndex = 0;
  let polradLayer = null;
  let polradTimer = null;
  let polradAvailable = false;
  let warningsLayer = null;
  let warningRows = [];
  let warningByCounty = new Map();
  let powiatGeoJson = null;
  let enhancedTimer = null;

  // Version badge.
  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.0';
  const aiHeading = [...document.querySelectorAll('.card h2')].find(h => h.textContent.includes('Prognoza AI'));
  if (aiHeading) aiHeading.textContent = 'Nowcast AI / ensemble 0–6 h';

  const style = document.createElement('style');
  style.textContent = `
    .polrad-note{font-size:9px;color:var(--muted);padding:4px 8px;border-top:1px solid var(--line)}
    .ai-ensemble{line-height:1.5}.ai-ensemble .lead{display:block;margin-bottom:4px}
    .ai-horizon{margin:4px 0;padding:5px 7px;background:var(--panel2);border-left:3px solid var(--blue2)}
    .ai-conf{font-weight:700}.ai-low{color:var(--orange)}.ai-high{color:var(--green)}
    .hazard-legend{background:rgba(255,255,255,.93);color:#222;padding:6px 7px;border-radius:5px;font-size:9px;line-height:1.35;box-shadow:0 1px 5px rgba(0,0,0,.2)}
    .hazard-legend i{display:inline-block;width:11px;height:8px;margin-right:4px;vertical-align:middle;border:1px solid rgba(0,0,0,.25)}
  `;
  document.head.appendChild(style);

  // Add a concise status line under the map controls.
  const mapbar = document.querySelector('.mapbar');
  let polradStatus = byId('polradStatus');
  if (mapbar && !polradStatus) {
    polradStatus = document.createElement('div');
    polradStatus.id = 'polradStatus';
    polradStatus.className = 'polrad-note';
    polradStatus.textContent = 'POLRAD: łączenie z IMGW…';
    mapbar.insertAdjacentElement('afterend', polradStatus);
  }

  const setPolradStatus = text => { if (polradStatus) polradStatus.textContent = text; };
  const fmtRadarTime = sec => new Intl.DateTimeFormat('pl-PL', {
    timeZone:'Europe/Warsaw', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
  }).format(new Date(Number(sec) * 1000));

  // Existing "Radar" remains as a point-dBZ/fallback source, but is no longer the default map layer.
  const rainButton = byId('radarToggle');
  if (rainButton) {
    rainButton.textContent = 'RainViewer';
    rainButton.classList.remove('active');
    try { if (typeof radarLayer !== 'undefined' && radarLayer && map.hasLayer(radarLayer)) map.removeLayer(radarLayer); } catch (_) {}
  }

  function makeMapButton(id, text, before) {
    let b = byId(id);
    if (b || !mapbar) return b;
    b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.textContent = text;
    before ? mapbar.insertBefore(b, before) : mapbar.appendChild(b);
    return b;
  }

  const polradButtons = {};
  const first = rainButton || mapbar?.firstChild || null;
  for (const [product, meta] of Object.entries(POLRAD_PRODUCTS)) {
    const b = makeMapButton('polrad_' + product, meta.label, first);
    if (!b) continue;
    polradButtons[product] = b;
    b.addEventListener('click', async () => {
      if (polradProduct === product && b.classList.contains('active')) {
        b.classList.remove('active');
        if (polradLayer && map.hasLayer(polradLayer)) map.removeLayer(polradLayer);
        return;
      }
      await selectPolrad(product);
    });
  }

  const hazardButton = makeMapButton('hazardsToggle', 'Zagrożenia IMGW', byId('playRadar'));
  if (hazardButton) hazardButton.addEventListener('click', toggleHazards);

  // Remove old RainViewer-only history/animation listeners by cloning those controls.
  let historyRange = byId('radarFrame');
  if (historyRange) {
    const replacement = historyRange.cloneNode(true);
    historyRange.replaceWith(replacement);
    historyRange = replacement;
    historyRange.min = 0;
    historyRange.max = 0;
    historyRange.value = 0;
    historyRange.addEventListener('input', e => setPolradFrame(Number(e.target.value)));
  }
  let playButton = byId('playRadar');
  if (playButton) {
    const replacement = playButton.cloneNode(true);
    playButton.replaceWith(replacement);
    playButton = replacement;
    playButton.addEventListener('click', togglePolradAnimation);
  }

  if (rainButton) {
    // This runs after the original RainViewer handler. If RainViewer is enabled,
    // hide POLRAD to keep the map readable; switching back to POLRAD is one tap.
    rainButton.addEventListener('click', () => {
      if (!rainButton.classList.contains('active')) return;
      Object.values(polradButtons).forEach(b => b.classList.remove('active'));
      if (polradLayer && map.hasLayer(polradLayer)) map.removeLayer(polradLayer);
      stopPolradAnimation();
      setPolradStatus('Mapa: RainViewer (fallback). Oficjalne produkty POLRAD pozostają dostępne przyciskami CMAX/SRI/PAC.');
    });
  }

  function normalizeImgwUrl(url) {
    // IMGW list API can still return http:// URLs. GitHub Pages is HTTPS,
    // so upgrade the same IMGW resource to HTTPS to avoid mixed-content blocking.
    return String(url || '').replace(/^http:\/\//i, 'https://');
  }

  async function fetchPolradFrames(product) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(`https://meteo.imgw.pl/api/radars/v1/list/${encodeURIComponent(product)}`, {
        cache:'no-cache', signal:controller.signal
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const frames = data?.[product]?.list;
      if (!Array.isArray(frames) || !frames.length) throw new Error('brak klatek');
      return frames
        .filter(f => f && f.url && Number.isFinite(Number(f.date)))
        .sort((a, b) => Number(a.date) - Number(b.date));
    } finally {
      clearTimeout(timeout);
    }
  }

  function removePolradLayer() {
    if (polradLayer && map.hasLayer(polradLayer)) map.removeLayer(polradLayer);
    polradLayer = null;
  }

  function setPolradFrame(index) {
    if (!polradFrames.length) return;
    polradIndex = clamp01(Math.round(Number(index) || 0), 0, polradFrames.length - 1);
    if (historyRange) historyRange.value = polradIndex;
    const frame = polradFrames[polradIndex];
    removePolradLayer();
    polradLayer = L.imageOverlay(normalizeImgwUrl(frame.url), POLRAD_BOUNDS, {
      opacity:0.70, interactive:false, crossOrigin:true,
      attribution:'IMGW-PIB / POLRAD'
    });
    polradLayer.on('error', () => {
      polradAvailable = false;
      setPolradStatus('POLRAD: obraz IMGW nie załadował się. Możesz chwilowo użyć RainViewer.');
    });
    if (polradButtons[polradProduct]?.classList.contains('active')) polradLayer.addTo(map);
    const timeEl = byId('radarTime');
    if (timeEl) timeEl.textContent = `${POLRAD_PRODUCTS[polradProduct]?.short || polradProduct}: ${fmtRadarTime(frame.date)}`;
    setPolradStatus(`Mapa: IMGW/POLRAD ${POLRAD_PRODUCTS[polradProduct]?.short || polradProduct} · ${fmtRadarTime(frame.date)} · klatki co ok. 5 min.`);
  }

  async function selectPolrad(product) {
    stopPolradAnimation();
    polradProduct = product;
    Object.entries(polradButtons).forEach(([p, b]) => b.classList.toggle('active', p === product));
    if (rainButton) {
      rainButton.classList.remove('active');
      try { if (typeof radarLayer !== 'undefined' && radarLayer && map.hasLayer(radarLayer)) map.removeLayer(radarLayer); } catch (_) {}
    }
    setPolradStatus(`POLRAD ${POLRAD_PRODUCTS[product]?.short || product}: pobieranie listy klatek z IMGW…`);
    try {
      polradFrames = await fetchPolradFrames(product);
      polradAvailable = true;
      polradIndex = polradFrames.length - 1;
      if (historyRange) {
        historyRange.min = 0;
        historyRange.max = Math.max(0, polradFrames.length - 1);
        historyRange.value = polradIndex;
      }
      setPolradFrame(polradIndex);
    } catch (e) {
      polradAvailable = false;
      Object.values(polradButtons).forEach(b => b.classList.remove('active'));
      removePolradLayer();
      setPolradStatus(`POLRAD chwilowo niedostępny (${e?.message || 'błąd/CORS'}). Automatyczny fallback: RainViewer.`);
      if (rainButton && !rainButton.classList.contains('active')) rainButton.click();
    }
  }

  function stopPolradAnimation() {
    if (polradTimer) clearInterval(polradTimer);
    polradTimer = null;
    if (playButton) playButton.textContent = '▶ Animacja';
  }

  function togglePolradAnimation() {
    if (polradTimer) { stopPolradAnimation(); return; }
    if (!polradAvailable || !polradFrames.length) return;
    if (playButton) playButton.textContent = '■ Stop';
    // Animate the latest 18 frames (~90 min) rather than the entire list.
    const start = Math.max(0, polradFrames.length - 18);
    let i = start;
    polradTimer = setInterval(() => {
      setPolradFrame(i);
      i++;
      if (i >= polradFrames.length) i = start;
    }, 650);
  }

  // ---------- Official IMGW warning overlay (powiat boundaries) ----------
  function terytList(warning) {
    const raw = warning?.teryt;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') return raw.split(/[;,\s]+/).filter(Boolean);
    return [];
  }

  function warningLevel(w) {
    return clamp01(Number(w?.stopien ?? w?.stopien_zagrozenia ?? w?.level ?? 0) || 0, 0, 3);
  }

  function rebuildWarningIndex() {
    warningByCounty = new Map();
    for (const w of warningRows) {
      for (const raw of terytList(w)) {
        const code = String(raw).padStart(4, '0').slice(0, 4);
        const old = warningByCounty.get(code) || [];
        old.push(w);
        warningByCounty.set(code, old);
      }
    }
  }

  async function fetchWarnings() {
    const r = await fetch('https://danepubliczne.imgw.pl/api/data/warningsmeteo', {cache:'no-cache'});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    warningRows = Array.isArray(data) ? data : [];
    rebuildWarningIndex();
    return warningRows;
  }

  async function fetchPowiatGeoJson() {
    if (powiatGeoJson) return powiatGeoJson;
    const url = 'https://raw.githubusercontent.com/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy/main/powiaty.json';
    const r = await fetch(url, {cache:'force-cache'});
    if (!r.ok) throw new Error('granice powiatów HTTP ' + r.status);
    powiatGeoJson = await r.json();
    return powiatGeoJson;
  }

  const hazardColor = level => level >= 3 ? '#c62828' : level === 2 ? '#ef6c00' : '#f9a825';

  function renderWarningLayer(geo) {
    if (warningsLayer) map.removeLayer(warningsLayer);
    warningsLayer = L.geoJSON(geo, {
      style: feature => {
        const code = String(feature?.properties?.JPT_KOD_JE || '').padStart(4, '0').slice(0, 4);
        const rows = warningByCounty.get(code) || [];
        const level = rows.reduce((m, w) => Math.max(m, warningLevel(w)), 0);
        return level ? {
          color:hazardColor(level), weight:1.2, opacity:.9,
          fillColor:hazardColor(level), fillOpacity:level >= 3 ? .40 : level === 2 ? .32 : .24
        } : {color:'transparent', weight:0, fillColor:'transparent', fillOpacity:0};
      },
      onEachFeature: (feature, layer) => {
        const code = String(feature?.properties?.JPT_KOD_JE || '').padStart(4, '0').slice(0, 4);
        const rows = warningByCounty.get(code) || [];
        if (!rows.length) return;
        const name = feature?.properties?.JPT_NAZWA_ || ('powiat ' + code);
        const items = rows.slice(0, 4).map(w => {
          const event = esc(w.nazwa_zdarzenia || w.zdarzenie || w.event || w.nazwa || 'Ostrzeżenie');
          const level = warningLevel(w);
          const until = esc(w.obowiazuje_do || w.do || w.end || '');
          return `${event} · st. ${level}${until ? '<br><small>do ' + until + '</small>' : ''}`;
        }).join('<hr style="border:0;border-top:1px solid #bbb">');
        layer.bindTooltip(`<b>${esc(name)}</b><br>${items}`, {sticky:true});
      }
    });
    warningsLayer.addTo(map);
  }

  let hazardLegend = null;
  function setHazardLegend(show) {
    if (show && !hazardLegend) {
      hazardLegend = L.control({position:'topright'});
      hazardLegend.onAdd = () => {
        const d = L.DomUtil.create('div', 'hazard-legend');
        d.innerHTML = '<b>Zagrożenia IMGW</b><br><i style="background:#f9a825"></i>stopień 1<br><i style="background:#ef6c00"></i>stopień 2<br><i style="background:#c62828"></i>stopień 3';
        return d;
      };
      hazardLegend.addTo(map);
    } else if (!show && hazardLegend) {
      map.removeControl(hazardLegend);
      hazardLegend = null;
    }
  }

  async function toggleHazards() {
    if (!hazardButton) return;
    if (hazardButton.classList.contains('active')) {
      hazardButton.classList.remove('active');
      if (warningsLayer && map.hasLayer(warningsLayer)) map.removeLayer(warningsLayer);
      setHazardLegend(false);
      return;
    }
    hazardButton.classList.add('active');
    hazardButton.textContent = 'Zagrożenia…';
    try {
      const [_, geo] = await Promise.all([fetchWarnings(), fetchPowiatGeoJson()]);
      renderWarningLayer(geo);
      setHazardLegend(true);
      hazardButton.textContent = 'Zagrożenia IMGW';
    } catch (e) {
      hazardButton.classList.remove('active');
      hazardButton.textContent = 'Zagrożenia IMGW';
      setHazardLegend(false);
      if (typeof err === 'function') err('Nie udało się wczytać warstwy zagrożeń IMGW: ' + (e?.message || 'błąd'));
    }
  }

  // ---------- Multi-model AIFS + ICON + GFS nowcast ----------
  function modelParams(extra = {}) {
    return new URLSearchParams({
      latitude:point.lat,
      longitude:point.lon,
      hourly:'temperature_2m,precipitation,weather_code,wind_gusts_10m',
      timezone:'UTC', forecast_hours:'9', wind_speed_unit:'ms', ...extra
    });
  }

  async function loadModelJson(url) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    try {
      const r = await fetch(url, {cache:'no-cache', signal:c.signal});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  function nearestAt(data, targetMs) {
    const h = data?.hourly;
    if (!h?.time?.length) return null;
    let best = 0, dist = Infinity;
    h.time.forEach((s, i) => {
      const ms = Date.parse(s + (String(s).endsWith('Z') ? '' : 'Z'));
      const d = Math.abs(ms - targetMs);
      if (d < dist) { dist = d; best = i; }
    });
    return {
      temp:Number(h.temperature_2m?.[best]), rain:Number(h.precipitation?.[best]),
      gust:Number(h.wind_gusts_10m?.[best]), code:Number(h.weather_code?.[best]),
      time:h.time[best]
    };
  }

  function mean(values) {
    const a = values.filter(Number.isFinite);
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
  }
  function spread(values) {
    const a = values.filter(Number.isFinite);
    return a.length > 1 ? Math.max(...a) - Math.min(...a) : 0;
  }
  function agreementLabel(conf) {
    return conf >= 80 ? ['wysoka','ai-high'] : conf >= 60 ? ['średnia',''] : ['niska','ai-low'];
  }
  function describeHour(rain, gust, storm) {
    const parts = [];
    if (rain >= 8) parts.push('silny opad');
    else if (rain >= 3) parts.push('umiarkowany opad');
    else if (rain >= .2) parts.push('słaby/przelotny opad');
    else parts.push('bez istotnego opadu');
    if (storm >= 60) parts.push('wysokie ryzyko burzy');
    else if (storm >= 30) parts.push('możliwa burza');
    if (gust >= 20) parts.push('bardzo silne porywy');
    else if (gust >= 14) parts.push('silniejsze porywy');
    return parts.join(', ');
  }

  async function loadEnhancedNowcast() {
    const aiBox = byId('aiText');
    if (!aiBox || typeof point === 'undefined') return;
    const gfsQ = new URLSearchParams({
      latitude:point.lat, longitude:point.lon,
      hourly:'temperature_2m,precipitation,weather_code,wind_gusts_10m,cape,lifted_index,convective_inhibition,freezing_level_height,thunderstorm_probability',
      timezone:'UTC', forecast_hours:'9', wind_speed_unit:'ms'
    });
    const urls = {
      GFS:'https://api.open-meteo.com/v1/gfs?' + gfsQ,
      AIFS:'https://api.open-meteo.com/v1/forecast?' + modelParams({models:'ecmwf_aifs025_single'}),
      ICON:'https://api.open-meteo.com/v1/forecast?' + modelParams({models:'icon_seamless'})
    };

    const entries = await Promise.allSettled(Object.entries(urls).map(async ([name, url]) => [name, await loadModelJson(url)]));
    const models = {};
    entries.forEach(r => { if (r.status === 'fulfilled') models[r.value[0]] = r.value[1]; });
    const names = Object.keys(models);
    if (names.length < 2) return; // keep the base nowcast if ensemble cannot be built

    const horizons = [0, 1, 3, 6];
    const now = Date.now();
    const rows = horizons.map(hour => {
      const vals = names.map(name => ({name, data:nearestAt(models[name], now + hour * 3600e3)})).filter(x => x.data);
      const rainVals = vals.map(x => x.data.rain);
      const gustVals = vals.map(x => x.data.gust);
      const tempVals = vals.map(x => x.data.temp);
      const rain = mean(rainVals), gust = mean(gustVals), temp = mean(tempVals);
      const g = vals.find(x => x.name === 'GFS')?.data;
      // GFS thunderstorm probability is read separately below because nearestAt intentionally stays model-common.
      const gh = models.GFS?.hourly;
      let storm = 0;
      if (gh?.time?.length) {
        let bi = 0, bd = Infinity;
        gh.time.forEach((s, i) => {
          const d = Math.abs(Date.parse(s + (String(s).endsWith('Z') ? '' : 'Z')) - (now + hour * 3600e3));
          if (d < bd) { bd = d; bi = i; }
        });
        storm = Number(gh.thunderstorm_probability?.[bi]) || 0;
        const cape = Number(gh.cape?.[bi]) || 0;
        const li = Number(gh.lifted_index?.[bi]);
        storm = clamp01(storm * .72 + Math.min(22, cape / 70) + (Number.isFinite(li) && li <= -3 ? 8 : 0), 0, 99);
      }
      const rs = spread(rainVals), gs = spread(gustVals), ts = spread(tempVals);
      const countPenalty = Math.max(0, 3 - vals.length) * 10;
      const confidence = Math.round(clamp01(94 - rs * 10 - gs * 2.3 - ts * 2 - countPenalty, 35, 95));
      return {hour, rain, gust, temp, storm, confidence, count:vals.length};
    });

    // Observation boost from the point dBZ sampler. It is still labeled as fallback until
    // official POLRAD pixel decoding is added; the visible map itself is POLRAD.
    const dbzText = byId('dbz')?.textContent || '';
    const dbzMatch = dbzText.match(/(\d+(?:\.\d+)?)/);
    const pointDbz = dbzMatch ? Number(dbzMatch[1]) : NaN;
    if (Number.isFinite(pointDbz) && rows[0]) {
      if (pointDbz >= 45) rows[0].storm = Math.max(rows[0].storm, 60);
      else if (pointDbz >= 35) rows[0].storm = Math.max(rows[0].storm, 35);
    }

    const headline = rows[0];
    const [agree, cls] = agreementLabel(Math.round(mean(rows.map(r => r.confidence))));
    const detail = rows.map(r => {
      const when = r.hour === 0 ? 'teraz / ~1 h' : `+${r.hour} h`;
      return `<div class="ai-horizon"><b>${when}:</b> ${esc(describeHour(r.rain, r.gust, r.storm))} · opad ${fmt(r.rain,1)} mm/h · porywy ${fmt(r.gust,1)} m/s · <span class="ai-conf">zgodność ${r.confidence}%</span></div>`;
    }).join('');

    aiBox.innerHTML = `<div class="ai-ensemble"><span class="lead"><b>Nowcast wielomodelowy:</b> ${names.join(' + ')}. Zgodność modeli: <span class="ai-conf ${cls}">${agree}</span>.</span>${detail}` +
      `<small style="color:var(--muted)">Warstwa mapy: ${polradAvailable ? 'oficjalny IMGW/POLRAD ' + (POLRAD_PRODUCTS[polradProduct]?.short || '') : 'RainViewer fallback'}. AIFS jest modelem AI ECMWF; pozostałe wyniki są łączone jako ensemble. „Zgodność” mierzy rozrzut modeli i nie jest oficjalnym prawdopodobieństwem IMGW.</small></div>`;
  }

  function scheduleEnhanced(delay = 900) {
    if (enhancedTimer) clearTimeout(enhancedTimer);
    enhancedTimer = setTimeout(() => loadEnhancedNowcast().catch(() => {}), delay);
  }

  // Re-run enhanced nowcast after every normal user refresh / point change.
  byId('apply')?.addEventListener('click', () => scheduleEnhanced(1000));
  byId('refresh')?.addEventListener('click', () => {
    if (polradButtons[polradProduct]?.classList.contains('active')) selectPolrad(polradProduct).catch(() => {});
    if (hazardButton?.classList.contains('active')) {
      fetchWarnings().then(() => powiatGeoJson && renderWarningLayer(powiatGeoJson)).catch(() => {});
    }
    scheduleEnhanced(1000);
  });
  byId('resetPoint')?.addEventListener('click', () => scheduleEnhanced(1000));

  // Initial official layer and ensemble. Direct POLRAD is preferred; RainViewer is fallback only.
  selectPolrad('cmax').catch(() => {});
  scheduleEnhanced(1400);
})();
