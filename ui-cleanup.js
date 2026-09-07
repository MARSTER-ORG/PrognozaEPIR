'use strict';
(() => {
  const hideUi = () => {
    // Do not remove these nodes: the legacy data loaders still update the
    // hidden source indicators after asynchronous GFS/AIFS/IMGW requests.
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

    // Technical strips stay in DOM for older modules, but are not shown.
    for (const id of ['polradStatus','lightningStatus']) {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    }
  };

  hideUi();
  const observer = new MutationObserver(hideUi);
  observer.observe(document.body, {childList:true, subtree:true});
  setTimeout(() => observer.disconnect(), 10000);
})();

// GFS model loader repair ----------------------------------------------------
// Open-Meteo exposes thunderstorm_probability only for NBM (CONUS). Asking
// for it from /v1/gfs outside that domain rejects the whole request. Keep GFS
// surface/convective fields live and derive a clearly labelled 0-100 storm
// index from GFS diagnostics instead of treating it as a native probability.
(() => {
  if (typeof loadModels !== 'function' || typeof json !== 'function' || typeof $ !== 'function') return;
  if (window.__PrognozaEPIRGfsLoaderRepair) return;
  window.__PrognozaEPIRGfsLoaderRepair = true;

  const isNum = v => Number.isFinite(Number(v));
  const val = (v, fallback = 0) => isNum(v) ? Number(v) : fallback;

  function stormIndex(row) {
    const code = Math.round(val(row?.weather_code, -1));
    if (code === 99) return 98;
    if (code === 96) return 94;
    if (code === 95) return 88;

    const cape = Math.max(0, val(row?.cape));
    const li = isNum(row?.lifted_index) ? Number(row.lifted_index) : null;
    const cin = Math.abs(val(row?.convective_inhibition));
    const rain = Math.max(0, val(row?.precipitation));
    const gust = Math.max(0, val(row?.wind_gusts_10m));

    let score = Math.min(42, cape / 30);
    if (li !== null) score += li <= -6 ? 28 : li <= -4 ? 20 : li <= -2 ? 12 : li < 0 ? 5 : 0;
    score += rain >= 5 ? 12 : rain >= 1 ? 6 : rain >= 0.2 ? 2 : 0;
    score += gust >= 20 ? 8 : gust >= 15 ? 4 : 0;
    score -= cin >= 200 ? 18 : cin >= 100 ? 10 : cin >= 50 ? 5 : 0;
    return Math.max(0, Math.min(90, Math.round(score)));
  }

  function mergeHourly(base, extra) {
    if (!base) return extra || null;
    if (!extra) return base;
    const out = {...base, hourly:{...(base.hourly || {})}, hourly_units:{...(base.hourly_units || {})}};
    const bt = out.hourly.time || [];
    const et = extra.hourly?.time || [];
    for (const [key, arr] of Object.entries(extra.hourly || {})) {
      if (key === 'time' || !Array.isArray(arr)) continue;
      if (bt.length === et.length && bt.every((t, i) => t === et[i])) {
        out.hourly[key] = arr.slice();
      } else if (bt.length && et.length) {
        const byTime = new Map(et.map((t, i) => [t, arr[i]]));
        out.hourly[key] = bt.map(t => byTime.has(t) ? byTime.get(t) : null);
      }
    }
    Object.assign(out.hourly_units, extra.hourly_units || {});
    return out;
  }

  function addStormIndex(g) {
    if (!g?.hourly?.time?.length) return g;
    const h = g.hourly;
    h.thunderstorm_probability = h.time.map((_, i) => stormIndex({
      weather_code:h.weather_code?.[i],
      cape:h.cape?.[i],
      lifted_index:h.lifted_index?.[i],
      convective_inhibition:h.convective_inhibition?.[i],
      precipitation:h.precipitation?.[i],
      wind_gusts_10m:h.wind_gusts_10m?.[i]
    }));
    return g;
  }

  function renderForecastFixed(g, a) {
    const tb = $('forecastRows');
    if (!tb) return;
    tb.innerHTML = '';
    const head = tb.closest('table')?.querySelector('thead tr');
    if (head?.children?.[4]) head.children[4].textContent = 'Indeks GFS';
    const now = Date.now(), gh = g.hourly || {}, ah = a?.hourly || {};
    let shown = 0;
    for (let i = 0; i < (gh.time || []).length && shown < 7; i++) {
      const ms = Date.parse(gh.time[i] + (String(gh.time[i]).endsWith('Z') ? '' : 'Z'));
      if (ms < now - 30 * 60000) continue;
      let ai = '—';
      if (ah.time?.length) {
        let j = 0, bd = 1e30;
        ah.time.forEach((t, k) => {
          const d = Math.abs(Date.parse(t + (String(t).endsWith('Z') ? '' : 'Z')) - ms);
          if (d < bd) { bd = d; j = k; }
        });
        ai = (isNum(ah.precipitation?.[j]) ? Number(ah.precipitation[j]).toFixed(1) + ' mm/h · ' : '') + weatherName(ah.weather_code?.[j]);
      }
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + fmtTime(ms) + '</td>' +
        '<td>' + (isNum(gh.temperature_2m?.[i]) ? Number(gh.temperature_2m[i]).toFixed(1) + '°C' : '—') + '</td>' +
        '<td>' + (isNum(gh.precipitation?.[i]) ? Number(gh.precipitation[i]).toFixed(1) : '—') + '</td>' +
        '<td>' + (isNum(gh.cape?.[i]) ? Number(gh.cape[i]).toFixed(0) : '—') + '</td>' +
        '<td>' + (isNum(gh.thunderstorm_probability?.[i]) ? Math.round(Number(gh.thunderstorm_probability[i])) + '/100' : '—') + '</td>' +
        '<td>' + (isNum(gh.wind_gusts_10m?.[i]) ? Number(gh.wind_gusts_10m[i]).toFixed(1) : '—') + '</td>' +
        '<td>' + ai + '</td>';
      tb.appendChild(tr);
      shown++;
    }
  }

  function renderAiFixed(g, a, r) {
    const out = [];
    out.push('<b>Ocena AI/AIFS dla najbliższych godzin:</b>');
    if (r.dbz >= 50) out.push('Nad punktem występuje bardzo silne echo radarowe (~' + Math.round(r.dbz) + ' dBZ).');
    else if (r.dbz >= 40) out.push('Radar wykrywa silniejszy opad w punkcie (~' + Math.round(r.dbz) + ' dBZ).');
    else if (r.dbz >= 27) out.push('Radar wykrywa echo opadowe w punkcie (~' + Math.round(r.dbz) + ' dBZ).');
    else out.push('W punkcie nie widać obecnie silnego echa radarowego.');
    out.push('GFS: CAPE ' + (isNum(g.cape) ? Math.round(Number(g.cape)) : '—') + ' J/kg, indeks burzowy ' + (isNum(g.thunderstorm_probability) ? Math.round(Number(g.thunderstorm_probability)) + '/100' : '—') + ', porywy ' + (isNum(g.wind_gusts_10m) ? Number(g.wind_gusts_10m).toFixed(1) : '—') + ' m/s.');
    if (a) out.push('ECMWF AIFS (model AI): ' + weatherName(a.weather_code) + ', opad ' + (isNum(a.precipitation) ? Number(a.precipitation).toFixed(1) : '—') + ' mm/h.');
    out.push('Łączna ocena modułu: burza <b>' + Math.round(r.storm) + '%</b>, grad <b>' + Math.round(r.hail) + '%</b>, silny opad <b>' + Math.round(r.rain) + '%</b>, silne porywy <b>' + Math.round(r.wind) + '%</b>.');
    out.push('<span style="color:var(--muted)">Indeks GFS jest wskaźnikiem diagnostycznym PrognozaEPIR z CAPE/LI/CIN/WMO, nie natywnym prawdopodobieństwem GFS. Oficjalne ostrzeżenia IMGW są pokazane osobno.</span>');
    if ($('aiText')) $('aiText').innerHTML = out.join(' ');
  }

  loadModels = async function repairedLoadModels() {
    const common = {latitude:point.lat, longitude:point.lon, timezone:'UTC', forecast_hours:'12', wind_speed_unit:'ms'};
    const surfaceVars = ['temperature_2m','precipitation','weather_code','wind_gusts_10m'];
    const convVars = ['cape','lifted_index','convective_inhibition','freezing_level_height'];
    const sq = new URLSearchParams({...common, hourly:surfaceVars.join(',')});
    const cq = new URLSearchParams({...common, hourly:convVars.join(',')});
    const aq = new URLSearchParams({...common, hourly:surfaceVars.join(','), models:'ecmwf_aifs025_single'});

    const [sr, cr, ar] = await Promise.allSettled([
      json('https://api.open-meteo.com/v1/gfs?' + sq),
      json('https://api.open-meteo.com/v1/gfs?' + cq),
      json('https://api.open-meteo.com/v1/forecast?' + aq)
    ]);

    const surface = sr.status === 'fulfilled' ? sr.value : null;
    const conv = cr.status === 'fulfilled' ? cr.value : null;
    const a = ar.status === 'fulfilled' ? ar.value : null;
    const g = addStormIndex(mergeHourly(surface, conv));
    setDot('srcGfs', !!g);
    setDot('srcAifs', !!a);
    if (!g) throw new Error('Brak danych GFS/Open-Meteo');

    const n = nearestHourly(g), an = a ? nearestHourly(a) : null;
    if (!n) throw new Error('Brak godzinowych danych GFS');

    if ($('temp')) $('temp').textContent = isNum(n.temperature_2m) ? Number(n.temperature_2m).toFixed(1) + ' °C' : '—';
    if ($('rain')) $('rain').textContent = isNum(n.precipitation) ? Number(n.precipitation).toFixed(1) + ' mm/h' : '—';
    if ($('cape')) $('cape').textContent = isNum(n.cape) ? Math.round(Number(n.cape)) + ' J/kg' : '—';
    if ($('li')) $('li').textContent = isNum(n.lifted_index) ? Number(n.lifted_index).toFixed(1) : '—';
    if ($('cin')) $('cin').textContent = isNum(n.convective_inhibition) ? Math.round(Number(n.convective_inhibition)) + ' J/kg' : '—';
    if ($('freezing')) $('freezing').textContent = isNum(n.freezing_level_height) ? (Number(n.freezing_level_height) / 1000).toFixed(1) + ' km' : '—';
    if ($('gfsStorm')) $('gfsStorm').textContent = isNum(n.thunderstorm_probability) ? Math.round(Number(n.thunderstorm_probability)) + '/100' : '—';
    if ($('gust')) $('gust').textContent = isNum(n.wind_gusts_10m) ? Number(n.wind_gusts_10m).toFixed(1) + ' m/s' : '—';
    if ($('aifsRain')) $('aifsRain').textContent = an && isNum(an.precipitation) ? Number(an.precipitation).toFixed(1) + ' mm/h' : '—';
    if ($('aifsCode')) $('aifsCode').textContent = an ? weatherName(an.weather_code) : '—';

    const stormMetric = $('gfsStorm')?.closest('.metric');
    if (stormMetric) {
      const title = stormMetric.querySelector('small');
      const note = stormMetric.querySelector('span');
      if (title) title.textContent = 'Burza — indeks GFS';
      if (note) note.textContent = '0–100 · CAPE / LI / CIN / WMO';
    }

    const latestDbz = radarSamples.filter(x => Number.isFinite(x.dbz)).at(-1)?.dbz || 0;
    const cape = Math.max(0, val(n.cape));
    const tp = val(n.thunderstorm_probability);
    const li = val(n.lifted_index);
    const rr = Math.max(0, val(n.precipitation));
    const gust = Math.max(0, val(n.wind_gusts_10m));
    const fz = Math.max(0, val(n.freezing_level_height));
    const radarStorm = latestDbz >= 50 ? 45 : latestDbz >= 45 ? 30 : latestDbz >= 35 ? 14 : latestDbz >= 27 ? 6 : 0;
    const capeStorm = clamp(cape / 40, 0, 35), liStorm = li <= -5 ? 18 : li <= -3 ? 12 : li <= -1 ? 6 : 0;
    const storm = clamp(tp * .62 + radarStorm + capeStorm + liStorm, 0, 99);
    const hailRadar = latestDbz >= 55 ? 42 : latestDbz >= 50 ? 30 : latestDbz >= 45 ? 16 : 0;
    const hailCape = clamp((cape - 600) / 45, 0, 28), hailFz = fz >= 1800 && fz <= 3600 ? 12 : (fz > 0 ? 5 : 0);
    const hail = clamp(storm * .28 + hailRadar + hailCape + hailFz, 0, 95);
    const rainRisk = clamp(rr * 12 + (latestDbz >= 50 ? 45 : latestDbz >= 40 ? 30 : latestDbz >= 30 ? 15 : 0) + storm * .18, 0, 99);
    const windRisk = clamp((gust - 10) * 5 + storm * .22, 0, 99);
    riskSet('storm', storm); riskSet('hail', hail); riskSet('rain', rainRisk); riskSet('wind', windRisk);
    renderForecastFixed(g, a);
    renderAiFixed(n, an, {storm, hail, rain:rainRisk, wind:windRisk, dbz:latestDbz});
  };

  // If an earlier version of loadModels already failed before this addon was
  // evaluated, recover the cards immediately and remove only that stale banner.
  setTimeout(async () => {
    try {
      await loadModels();
      const box = $('error');
      if (box?.textContent?.includes('GFS/Open-Meteo')) err('');
    } catch (e) {
      console.warn('PrognozaEPIR GFS repair:', e);
    }
  }, 0);
})();
