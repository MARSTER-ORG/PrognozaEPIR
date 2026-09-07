'use strict';

// Final UI cleanup ----------------------------------------------------------
(() => {
  const hideUi = () => {
    const sources = document.querySelector('.sources');
    if (sources) {
      const card = sources.closest('.card');
      if (card) {
        card.style.display = 'none';
        card.setAttribute('aria-hidden', 'true');
      } else {
        sources.style.display = 'none';
      }
    }
    for (const id of ['polradStatus', 'lightningStatus']) {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    }
  };

  hideUi();
  const observer = new MutationObserver(hideUi);
  observer.observe(document.body, {childList: true, subtree: true});
  setTimeout(() => observer.disconnect(), 10000);
})();

// Browser-independent GFS/AIFS/ICON bridge --------------------------------
(() => {
  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.12.4';

  if (window.__PrognozaEPIRBrowserIndependentModelsV2) return;
  window.__PrognozaEPIRBrowserIndependentModelsV2 = true;

  const upstreamFetch = window.fetch.bind(window);
  // Correct EPIR point currently used by the radar page.
  const EPIR = {lat: 52.8275, lon: 18.3175};
  const RAW = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/runtime/models-latest.json';
  const API = 'https://api.github.com/repos/MARSTER-ORG/PrognozaEPIR/contents/data/runtime/models-latest.json?ref=main';
  const SAME_ORIGIN = new URL('data/runtime/models-latest.json', location.href).href;
  let snapshotPromise = null;

  const $id = id => document.getElementById(id);
  const isNum = v => v !== null && v !== '' && Number.isFinite(Number(v));
  const num = (v, d = 0) => isNum(v) ? Number(v) : d;
  const fmt = (v, d = 1) => isNum(v) ? Number(v).toFixed(d) : '—';
  const parseMs = t => Date.parse(String(t || '') + (String(t || '').endsWith('Z') ? '' : 'Z'));
  const closeTo = (a, b, tol = 0.03) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tol;
  const isEpirPoint = p => closeTo(p?.lat, EPIR.lat) && closeTo(p?.lon, EPIR.lon);

  async function fetchWithTimeout(url, opts = {}, timeout = 5000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      return await upstreamFetch(url, {...opts, cache: 'no-store', signal: ctl.signal});
    } finally {
      clearTimeout(timer);
    }
  }

  function decodeGithubContent(j) {
    if (!j?.content) return null;
    const raw = atob(String(j.content).replace(/\s/g, ''));
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  }

  function validSnapshot(j) {
    if (j?.schema !== 'prognozaepir-model-snapshot-v1') return false;
    const models = j?.models || {};
    if (!Object.keys(models).length) return false;
    const any = Object.values(models).find(m => Array.isArray(m?.hourly?.time) && m.hourly.time.length);
    if (!any) return false;
    const last = parseMs(any.hourly.time.at(-1));
    return Number.isFinite(last) && last > Date.now() + 2 * 3600000;
  }

  async function loadSnapshot() {
    if (snapshotPromise) return snapshotPromise;
    snapshotPromise = (async () => {
      const attempts = [
        async () => {
          const r = await fetchWithTimeout(SAME_ORIGIN + '?_=' + Date.now(), {headers: {Accept: 'application/json'}}, 3500);
          if (!r.ok) throw new Error('Pages ' + r.status);
          return await r.json();
        },
        async () => {
          const r = await fetchWithTimeout(API + '&_=' + Date.now(), {headers: {Accept: 'application/vnd.github+json'}}, 5000);
          if (!r.ok) throw new Error('GitHub API ' + r.status);
          return decodeGithubContent(await r.json());
        },
        async () => {
          const r = await fetchWithTimeout(RAW + '?_=' + Date.now(), {headers: {Accept: 'application/json'}}, 5000);
          if (!r.ok) throw new Error('raw ' + r.status);
          return await r.json();
        }
      ];

      for (const attempt of attempts) {
        try {
          const j = await attempt();
          if (validSnapshot(j)) {
            window.PrognozaEPIRModelSnapshotState = {
              ok: true,
              generated_at: j.generated_at,
              location: j.location,
              models: Object.keys(j.models || {})
            };
            return j;
          }
        } catch (e) {
          console.warn('Model snapshot source failed:', e?.message || e);
        }
      }
      window.PrognozaEPIRModelSnapshotState = {ok: false, error: 'all snapshot sources failed'};
      return null;
    })();
    return snapshotPromise;
  }

  function modelIdForUrl(u, snapshot) {
    if (u.pathname === '/v1/gfs') return 'ncep_gfs_global';
    const id = u.searchParams.get('models') || '';
    if (id === 'icon_seamless') {
      if (snapshot?.models?.icon_d2) return 'icon_d2';
      if (snapshot?.models?.icon_eu) return 'icon_eu';
      return 'icon_global';
    }
    return id;
  }

  function payloadFromSnapshot(snapshot, modelId, vars = null, requestPoint = null) {
    const model = snapshot?.models?.[modelId];
    const h = model?.hourly || {};
    const times = Array.isArray(h.time) ? h.time : [];
    if (!times.length) return null;

    const wanted = vars?.length ? vars : Object.keys(h).filter(k => k !== 'time');
    const hourly = {time: times};
    const units = {time: 'iso8601'};
    let found = 0;
    for (const v of wanted) {
      if (Array.isArray(h[v])) {
        hourly[v] = h[v];
        found++;
      }
      if (model?.hourly_units?.[v] != null) units[v] = model.hourly_units[v];
    }
    if (wanted.length && found === 0) return null;

    return {
      latitude: requestPoint?.lat ?? snapshot.location?.lat,
      longitude: requestPoint?.lon ?? snapshot.location?.lon,
      elevation: model.elevation,
      timezone: 'UTC',
      timezone_abbreviation: 'UTC',
      utc_offset_seconds: 0,
      hourly_units: units,
      hourly
    };
  }

  function responseFromSnapshot(u, snapshot) {
    const req = {
      lat: Number(u.searchParams.get('latitude')),
      lon: Number(u.searchParams.get('longitude'))
    };
    const nearSnapshot = closeTo(req.lat, snapshot?.location?.lat) && closeTo(req.lon, snapshot?.location?.lon);
    // During migration from the previous EPIR coordinates, the latest snapshot
    // may still carry the old point for up to one refresh cycle. The operational
    // EPIR point is allowed to use it temporarily; the server-side snapshot job
    // is also updated to the new coordinates.
    if (!isEpirPoint(req) && !nearSnapshot) return null;

    const vars = String(u.searchParams.get('hourly') || '').split(',').map(x => x.trim()).filter(Boolean);
    const payload = payloadFromSnapshot(snapshot, modelIdForUrl(u, snapshot), vars, req);
    if (!payload) return null;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-PrognozaEPIR-Source': 'repository-snapshot'
      }
    });
  }

  function isNowcastSupportRequest(u) {
    if (u.hostname !== 'api.open-meteo.com' || u.searchParams.get('forecast_hours') !== '6') return false;
    const vars = String(u.searchParams.get('hourly') || '').split(',').map(x => x.trim()).filter(Boolean).sort();
    return vars.length === 2 && vars[0] === 'precipitation' && vars[1] === 'weather_code';
  }

  // Keep the nowcast model support working even when desktop privacy/CORS rules
  // reject direct Open-Meteo requests.
  window.fetch = async function(input, init) {
    let u = null;
    try {
      u = new URL(typeof input === 'string' ? input : input?.url, location.href);
    } catch (_) {}

    if (u && isNowcastSupportRequest(u)) {
      try {
        const snapshot = await loadSnapshot();
        const local = snapshot ? responseFromSnapshot(u, snapshot) : null;
        if (local) return local;
      } catch (e) {
        console.warn('Nowcast model bridge:', e?.message || e);
      }
    }
    return upstreamFetch(input, init);
  };

  window.addEventListener('prognozaepir:radar-nowcast-updated', ev => {
    const m = ev?.detail?.models;
    const combined = $id('rnCombined');
    if (!combined || !m) return;
    if (!m.total) combined.textContent = 'brak danych modeli';
    else if (!m.support) combined.textContent = 'radar aktywny · modele nie potwierdzają';
    else if (m.support === m.total && m.total >= 2) combined.textContent = 'radar + modele zgodne';
    else combined.textContent = 'częściowe wsparcie modeli';
  });

  if (typeof loadModels !== 'function' || typeof json !== 'function') return;

  function stormIndex(row) {
    const code = Math.round(num(row?.weather_code, -1));
    if (code === 99) return 98;
    if (code === 96) return 94;
    if (code === 95) return 88;

    const cape = Math.max(0, num(row?.cape));
    const li = isNum(row?.lifted_index) ? Number(row.lifted_index) : null;
    const cin = Math.abs(num(row?.convective_inhibition));
    const rain = Math.max(0, num(row?.precipitation));
    const gust = Math.max(0, num(row?.wind_gusts_10m));

    let score = Math.min(42, cape / 30);
    if (li !== null) score += li <= -6 ? 28 : li <= -4 ? 20 : li <= -2 ? 12 : li < 0 ? 5 : 0;
    score += rain >= 5 ? 12 : rain >= 1 ? 6 : rain >= .2 ? 2 : 0;
    score += gust >= 20 ? 8 : gust >= 15 ? 4 : 0;
    score -= cin >= 200 ? 18 : cin >= 100 ? 10 : cin >= 50 ? 5 : 0;
    return Math.max(0, Math.min(90, Math.round(score)));
  }

  function merge(base, extra) {
    if (!base) return extra || null;
    if (!extra) return base;
    const out = {...base, hourly: {...(base.hourly || {})}, hourly_units: {...(base.hourly_units || {})}};
    const bt = out.hourly.time || [];
    const et = extra.hourly?.time || [];
    for (const [key, arr] of Object.entries(extra.hourly || {})) {
      if (key === 'time' || !Array.isArray(arr)) continue;
      if (bt.length === et.length && bt.every((t, i) => t === et[i])) {
        out.hourly[key] = arr.slice();
      } else {
        const byTime = new Map(et.map((t, i) => [t, arr[i]]));
        out.hourly[key] = bt.map(t => byTime.has(t) ? byTime.get(t) : null);
      }
    }
    Object.assign(out.hourly_units, extra.hourly_units || {});
    return out;
  }

  function addIndex(g) {
    if (!g?.hourly?.time?.length) return g;
    const h = g.hourly;
    h.thunderstorm_probability = h.time.map((_, i) => stormIndex({
      weather_code: h.weather_code?.[i],
      cape: h.cape?.[i],
      lifted_index: h.lifted_index?.[i],
      convective_inhibition: h.convective_inhibition?.[i],
      precipitation: h.precipitation?.[i],
      wind_gusts_10m: h.wind_gusts_10m?.[i]
    }));
    return g;
  }

  function nearest(j) {
    return typeof nearestHourly === 'function' ? nearestHourly(j) : null;
  }

  function renderTable(g, a) {
    const tb = $id('forecastRows');
    if (!tb) return;
    tb.innerHTML = '';
    const head = tb.closest('table')?.querySelector('thead tr');
    if (head?.children?.[4]) head.children[4].textContent = 'Indeks GFS';

    const gh = g.hourly || {};
    const ah = a?.hourly || {};
    const now = Date.now();
    let shown = 0;
    for (let i = 0; i < (gh.time || []).length && shown < 7; i++) {
      const ms = parseMs(gh.time[i]);
      if (ms < now - 30 * 60000) continue;
      let ai = '—';
      if (ah.time?.length) {
        let j = 0;
        let best = Infinity;
        ah.time.forEach((t, k) => {
          const d = Math.abs(parseMs(t) - ms);
          if (d < best) {
            best = d;
            j = k;
          }
        });
        ai = (isNum(ah.precipitation?.[j]) ? fmt(ah.precipitation[j], 1) + ' mm/h · ' : '') + weatherName(ah.weather_code?.[j]);
      }
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + fmtTime(ms) + '</td>' +
        '<td>' + fmt(gh.temperature_2m?.[i], 1) + '°C</td>' +
        '<td>' + fmt(gh.precipitation?.[i], 1) + '</td>' +
        '<td>' + fmt(gh.cape?.[i], 0) + '</td>' +
        '<td>' + fmt(gh.thunderstorm_probability?.[i], 0) + '/100</td>' +
        '<td>' + fmt(gh.wind_gusts_10m?.[i], 1) + '</td>' +
        '<td>' + ai + '</td>';
      tb.appendChild(tr);
      shown++;
    }
  }

  function renderAi(g, a, r) {
    const out = ['<b>Ocena AI/AIFS dla najbliższych godzin:</b>'];
    if (r.dbz >= 50) out.push('Nad punktem występuje bardzo silne echo radarowe (~' + Math.round(r.dbz) + ' dBZ).');
    else if (r.dbz >= 40) out.push('Radar wykrywa silniejszy opad w punkcie (~' + Math.round(r.dbz) + ' dBZ).');
    else if (r.dbz >= 27) out.push('Radar wykrywa echo opadowe w punkcie (~' + Math.round(r.dbz) + ' dBZ).');
    else out.push('W punkcie nie widać obecnie silnego echa radarowego.');

    out.push('GFS: CAPE ' + fmt(g.cape, 0) + ' J/kg, indeks burzowy ' + fmt(g.thunderstorm_probability, 0) + '/100, porywy ' + fmt(g.wind_gusts_10m, 1) + ' m/s.');
    if (a) out.push('ECMWF AIFS: ' + weatherName(a.weather_code) + ', opad ' + fmt(a.precipitation, 1) + ' mm/h.');
    out.push('Łączna ocena modułu: burza <b>' + Math.round(r.storm) + '%</b>, grad <b>' + Math.round(r.hail) + '%</b>, silny opad <b>' + Math.round(r.rain) + '%</b>, silne porywy <b>' + Math.round(r.wind) + '%</b>.');
    out.push('<span style="color:var(--muted)">Indeks GFS jest diagnostycznym wskaźnikiem PrognozaEPIR z CAPE/LI/CIN/WMO, nie natywnym prawdopodobieństwem GFS.</span>');
    if ($id('aiText')) $id('aiText').innerHTML = out.join(' ');
  }

  async function live(url) {
    try {
      return await json(url);
    } catch (_) {
      return null;
    }
  }

  loadModels = async function repairedLoadModelsV2() {
    const p = {lat: Number(point?.lat), lon: Number(point?.lon)};
    const common = {latitude: p.lat, longitude: p.lon, timezone: 'UTC', forecast_hours: '12', wind_speed_unit: 'ms'};
    const surface = ['temperature_2m', 'precipitation', 'weather_code', 'wind_gusts_10m'];
    const conv = ['cape', 'lifted_index', 'convective_inhibition', 'freezing_level_height'];
    const sq = new URLSearchParams({...common, hourly: surface.join(',')});
    const cq = new URLSearchParams({...common, hourly: conv.join(',')});
    const aq = new URLSearchParams({...common, hourly: surface.join(','), models: 'ecmwf_aifs025_single'});

    let surfaceG = null;
    let convG = null;
    let aifs = null;

    if (isEpirPoint(p)) {
      const snapshot = await loadSnapshot();
      if (snapshot) {
        surfaceG = payloadFromSnapshot(snapshot, 'ncep_gfs_global', surface, p);
        convG = payloadFromSnapshot(snapshot, 'ncep_gfs_global', conv, p);
        aifs = payloadFromSnapshot(snapshot, 'ecmwf_aifs025_single', surface, p);
      }
    }

    const [sg, cg, aa] = await Promise.all([
      surfaceG ? Promise.resolve(surfaceG) : live('https://api.open-meteo.com/v1/gfs?' + sq),
      convG ? Promise.resolve(convG) : live('https://api.open-meteo.com/v1/gfs?' + cq),
      aifs ? Promise.resolve(aifs) : live('https://api.open-meteo.com/v1/forecast?' + aq)
    ]);

    const g = addIndex(merge(sg, cg));
    const a = aa;
    if (typeof setDot === 'function') {
      setDot('srcGfs', !!g);
      setDot('srcAifs', !!a);
    }
    if (!g) throw new Error('Brak danych GFS/Open-Meteo');

    const cur = nearest(g);
    const an = a ? nearest(a) : null;
    if (!cur) throw new Error('Brak godzinowych danych GFS');

    if ($id('temp')) $id('temp').textContent = fmt(cur.temperature_2m, 1) + ' °C';
    if ($id('rain')) $id('rain').textContent = fmt(cur.precipitation, 1) + ' mm/h';
    if ($id('cape')) $id('cape').textContent = isNum(cur.cape) ? fmt(cur.cape, 0) + ' J/kg' : '—';
    if ($id('li')) $id('li').textContent = isNum(cur.lifted_index) ? fmt(cur.lifted_index, 1) : '—';
    if ($id('cin')) $id('cin').textContent = isNum(cur.convective_inhibition) ? fmt(cur.convective_inhibition, 0) + ' J/kg' : '—';
    if ($id('freezing')) $id('freezing').textContent = isNum(cur.freezing_level_height) ? (Number(cur.freezing_level_height) / 1000).toFixed(1) + ' km' : '—';
    if ($id('gfsStorm')) $id('gfsStorm').textContent = fmt(cur.thunderstorm_probability, 0) + '/100';
    if ($id('gust')) $id('gust').textContent = fmt(cur.wind_gusts_10m, 1) + ' m/s';
    if ($id('aifsRain')) $id('aifsRain').textContent = an ? fmt(an.precipitation, 1) + ' mm/h' : '—';
    if ($id('aifsCode')) $id('aifsCode').textContent = an ? weatherName(an.weather_code) : '—';

    const metric = $id('gfsStorm')?.closest('.metric');
    if (metric) {
      const title = metric.querySelector('small');
      const note = metric.querySelector('span');
      if (title) title.textContent = 'Burza — indeks GFS';
      if (note) note.textContent = '0–100 · CAPE / LI / CIN / WMO';
    }

    const dbz = (typeof radarSamples !== 'undefined' && Array.isArray(radarSamples)) ? (radarSamples.filter(x => Number.isFinite(x.dbz)).at(-1)?.dbz || 0) : 0;
    const cape = Math.max(0, num(cur.cape));
    const idx = num(cur.thunderstorm_probability);
    const li = num(cur.lifted_index);
    const rr = Math.max(0, num(cur.precipitation));
    const gust = Math.max(0, num(cur.wind_gusts_10m));
    const fz = Math.max(0, num(cur.freezing_level_height));
    const clampFn = typeof clamp === 'function' ? clamp : (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const radarStorm = dbz >= 50 ? 45 : dbz >= 45 ? 30 : dbz >= 35 ? 14 : dbz >= 27 ? 6 : 0;
    const capeStorm = clampFn(cape / 40, 0, 35);
    const liStorm = li <= -5 ? 18 : li <= -3 ? 12 : li <= -1 ? 6 : 0;
    const storm = clampFn(idx * .62 + radarStorm + capeStorm + liStorm, 0, 99);
    const hailRadar = dbz >= 55 ? 42 : dbz >= 50 ? 30 : dbz >= 45 ? 16 : 0;
    const hailCape = clampFn((cape - 600) / 45, 0, 28);
    const hailFz = fz >= 1800 && fz <= 3600 ? 12 : (fz > 0 ? 5 : 0);
    const hail = clampFn(storm * .28 + hailRadar + hailCape + hailFz, 0, 95);
    const rainRisk = clampFn(rr * 12 + (dbz >= 50 ? 45 : dbz >= 40 ? 30 : dbz >= 30 ? 15 : 0) + storm * .18, 0, 99);
    const windRisk = clampFn((gust - 10) * 5 + storm * .22, 0, 99);

    if (typeof riskSet === 'function') {
      riskSet('storm', storm);
      riskSet('hail', hail);
      riskSet('rain', rainRisk);
      riskSet('wind', windRisk);
    }
    renderTable(g, a);
    renderAi(cur, an, {storm, hail, rain: rainRisk, wind: windRisk, dbz});

    const box = $id('error');
    if (box?.textContent?.includes('GFS/Open-Meteo') && typeof err === 'function') err('');
  };

  setTimeout(async () => {
    try {
      await loadModels();
    } catch (e) {
      console.warn('PrognozaEPIR model recovery:', e?.message || e);
    }
  }, 0);
})();