'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__PROGNOZA_EPIR_FOG_VNEXT_BRIDGE__) return;
  window.__PROGNOZA_EPIR_FOG_VNEXT_BRIDGE__ = true;

  const HOUR = 3600e3;
  const finite = Number.isFinite;
  const num = v => v !== null && v !== undefined && v !== '' && finite(Number(v)) ? Number(v) : null;
  const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
  const mean = a => { const q = (a || []).filter(finite); return q.length ? q.reduce((s, v) => s + v, 0) / q.length : null; };
  const fmt = (v, d = 1) => finite(v) ? Number(v).toFixed(d) : '—';
  const fmt0 = v => finite(v) ? String(Math.round(v)) : '—';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const parseUtc = s => Date.parse(String(s || '').endsWith('Z') ? s : String(s || '') + 'Z');
  let iconRows = [], ecmwfRows = [], loading = null, lastAppliedSignature = '';

  function loadScript(globalName, src, dataKey) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const selector = `script[data-${dataKey}="1"]`;
      const old = document.querySelector(selector);
      if (old) {
        old.addEventListener('load', () => window[globalName] && resolve(window[globalName]), {once:true});
        setTimeout(() => window[globalName] && resolve(window[globalName]), 50);
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.setAttribute(`data-${dataKey}`, '1');
      s.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error(`${globalName} API missing`));
      s.onerror = () => reject(new Error(`${src} unavailable`));
      document.head.appendChild(s);
    });
  }
  const loadPhysics = () => loadScript('PrognozaEPIRFogPhysicsVNext', 'fog-physics-vnext.js?v=20260916-prod1', 'fog-physics-vnext');
  const loadProbability = () => loadScript('PrognozaEPIRFogVNextProbabilityLayer', 'fog-vnext-probability-layer.js?v=20260916-prod1', 'fog-probability-vnext');

  async function fetchJson(url) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(url, {cache:'no-store', signal:ctl.signal});
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.reason || j?.message || ('HTTP ' + r.status));
      return j;
    } finally { clearTimeout(timer); }
  }
  function apiUrl(model, vars) {
    const p = window.PLACE || {lat:52.7989, lon:18.2639};
    const q = new URLSearchParams({latitude:String(p.lat), longitude:String(p.lon), hourly:vars.join(','), models:model, timezone:'UTC', forecast_hours:'60', past_hours:'6', wind_speed_unit:'ms'});
    return 'https://api.open-meteo.com/v1/forecast?' + q;
  }
  function rowsFrom(j, kind) {
    const h = j?.hourly; if (!Array.isArray(h?.time)) return [];
    return h.time.map((s, i) => {
      const row = {t:parseUtc(s)};
      if (kind === 'icon') {
        row.soil01 = num(h.soil_moisture_0_to_1cm?.[i]); row.soil13 = num(h.soil_moisture_1_to_3cm?.[i]);
        row.soilT0 = num(h.soil_temperature_0cm?.[i]); row.soilT6 = num(h.soil_temperature_6cm?.[i]); row.Ts = num(h.surface_temperature?.[i]);
      } else {
        row.pbl = num(h.boundary_layer_height?.[i]); row.soil07 = num(h.soil_moisture_0_to_7cm?.[i]);
        row.soilT07 = num(h.soil_temperature_0_7cm?.[i] ?? h.soil_temperature_0_to_7cm?.[i]); row.Ts = num(h.surface_temperature?.[i]);
        row.T2 = num(h.temperature_2m?.[i]); row.isDay = num(h.is_day?.[i]); row.sw = num(h.shortwave_radiation?.[i]);
      }
      return row;
    }).filter(x => finite(x.t)).sort((a, b) => a.t - b.t);
  }
  async function fetchIcon() {
    const tiers = [
      ['soil_moisture_0_to_1cm','soil_moisture_1_to_3cm','soil_temperature_0cm','soil_temperature_6cm','surface_temperature'],
      ['soil_moisture_0_to_1cm','soil_moisture_1_to_3cm','soil_temperature_0cm','soil_temperature_6cm'],
      ['soil_moisture_0_to_1cm','soil_moisture_1_to_3cm']
    ];
    let err = null; for (const vars of tiers) try { return rowsFrom(await fetchJson(apiUrl('icon_d2', vars)), 'icon'); } catch (e) { err = e; }
    throw err || new Error('ICON-D2 vNext unavailable');
  }
  async function fetchEcmwf() {
    const tiers = [
      ['boundary_layer_height','soil_moisture_0_to_7cm','soil_temperature_0_7cm','surface_temperature','temperature_2m','shortwave_radiation','is_day'],
      ['boundary_layer_height','soil_moisture_0_to_7cm','surface_temperature','temperature_2m','shortwave_radiation','is_day'],
      ['boundary_layer_height','surface_temperature','temperature_2m','shortwave_radiation','is_day']
    ];
    let err = null; for (const vars of tiers) try { return rowsFrom(await fetchJson(apiUrl('ecmwf_ifs', vars)), 'ecmwf'); } catch (e) { err = e; }
    throw err || new Error('ECMWF vNext unavailable');
  }
  async function ensurePhysicalData() {
    if (loading) return loading;
    loading = (async () => {
      const [a, b] = await Promise.allSettled([fetchIcon(), fetchEcmwf()]);
      iconRows = a.status === 'fulfilled' ? a.value : []; ecmwfRows = b.status === 'fulfilled' ? b.value : [];
      window.PrognozaEPIRFogVNextSources = {icon:iconRows.length > 0, ecmwf:ecmwfRows.length > 0, updated:Date.now(), iconError:a.status === 'rejected' ? String(a.reason?.message || a.reason) : null, ecmwfError:b.status === 'rejected' ? String(b.reason?.message || b.reason) : null};
      return window.PrognozaEPIRFogVNextSources;
    })().finally(() => { loading = null; });
    return loading;
  }

  function nearest(rows, t, max = 50 * 60e3) { let best = null, bd = Infinity; for (const r of rows || []) { const d = Math.abs(r.t - t); if (d < bd) { bd = d; best = r; } } return bd <= max ? best : null; }
  function modelMean(hour, key) { return mean((hour?.models || []).map(m => num(m?.[key]))); }
  function modelComponentMean(hour, key) { return mean((hour?.models || []).map(m => num(m?.components?.[key]))); }
  function legacyAt(series, t) { return nearest(series, t, 40 * 60e3); }
  function surfaceAt(t, hour) { const e = nearest(ecmwfRows, t), i = nearest(iconRows, t); return num(e?.Ts) ?? modelMean(hour, 'Tskin') ?? num(i?.Ts); }
  function diff(a, b) { return finite(a) && finite(b) ? a - b : null; }
  function t5cmObservation(t) {
    const rows = Array.isArray(window.PrognozaEPIRT5cmObservations) ? window.PrognozaEPIRT5cmObservations : [];
    const one = window.PrognozaEPIRT5cmObs, candidates = one ? [...rows, one] : rows;
    let best = null, bd = Infinity;
    for (const r of candidates) {
      const rt = Date.parse(r?.obs_time || r?.time || r?.timestamp || ''), v = num(r?.temperature_c ?? r?.T5cm_obs);
      if (!finite(rt) || !finite(v)) continue;
      const d = Math.abs(rt - t); if (d < bd) { bd = d; best = {temperature_c:v, obs_time:new Date(rt).toISOString(), source:r?.source || 'T5cm_obs', ageHours:Math.abs(Date.now() - rt) / HOUR}; }
    }
    return bd <= 3 * HOUR ? best : null;
  }
  function inputFor(series, hour) {
    const t = hour.t, e = nearest(ecmwfRows, t), i = nearest(iconRows, t), e1 = nearest(ecmwfRows, t - HOUR), e3 = nearest(ecmwfRows, t - 3 * HOUR);
    const h1 = legacyAt(series, t - HOUR), h3 = legacyAt(series, t - 3 * HOUR);
    const T = modelMean(hour, 'T') ?? num(hour.T), Td = modelMean(hour, 'Td'), RH = modelMean(hour, 'RH'), WS = modelMean(hour, 'WS');
    const T1 = h1 ? (modelMean(h1, 'T') ?? num(h1.T)) : null, T3 = h3 ? (modelMean(h3, 'T') ?? num(h3.T)) : null, Td3 = h3 ? modelMean(h3, 'Td') : null, RH3 = h3 ? modelMean(h3, 'RH') : null;
    const Ts = surfaceAt(t, hour), Ts1 = h1 ? surfaceAt(t - HOUR, h1) : null, Ts3 = h3 ? surfaceAt(t - 3 * HOUR, h3) : null;
    const sc = diff(T, Ts), sc1 = diff(T1, Ts1), sc3 = diff(T3, Ts3), cbh = modelMean(hour, 'CBH'), cbh3 = h3 ? modelMean(h3, 'CBH') : null;
    const dmi = (hour.models || []).find(m => m?.id === 'dmi_harmonie_arome_europe'), t5 = t5cmObservation(t);
    const observedFog = /^(FG|FZFG)$/i.test(String(hour.obsPhenomenon || ''));
    return {
      t:T, td:Td, rh:RH, ws:WS, visibility:num(hour.vis), observedFog, weatherFog:null,
      leadHours:Math.max(0, (t - Date.now()) / HOUR),
      soilIcon01:num(i?.soil01), soilIcon13:num(i?.soil13), soilEcmwf07:num(e?.soil07), precip12:modelMean(hour, 'p12'),
      pbl:num(e?.pbl), deltaPbl1:diff(num(e?.pbl), num(e1?.pbl)), deltaPbl3:diff(num(e?.pbl), num(e3?.pbl)),
      tsurface:Ts, deltaSurfaceCooling1:diff(sc, sc1), deltaSurfaceCooling3:diff(sc, sc3), deltaTsurface3:diff(Ts, Ts3),
      deltaSpread3:finite(T) && finite(Td) && finite(T3) && finite(Td3) ? (T - Td) - (T3 - Td3) : null, deltaRh3:diff(RH, RH3),
      inversion:modelMean(hour, 'inv200'), shear:null, isDay:num(e?.isDay), shortwave:num(e?.sw) ?? modelMean(hour, 'SW'), cloudCover:modelMean(hour, 'TCC'), lowCloud:modelMean(hour, 'LOW'),
      cloud2m:num(dmi?.directFog), cbh, cbhDrop3:finite(cbh) && finite(cbh3) ? cbh3 - cbh : null, precip:modelMean(hour, 'RR'), verticalRh:modelMean(hour, 'rhLow'),
      moistAdvection:modelComponentMean(hour, 'SMADV'), surfaceContrast:modelComponentMean(hour, 'SCOLD'), soilTemperature0:num(i?.soilT0), soilTemperature6:num(i?.soilT6), soilTemperatureEcmwf07:num(e?.soilT07),
      t5cmObs:num(t5?.temperature_c), t5cmObsTime:t5?.obs_time || null, t5cmObsSource:t5?.source || null, t5cmObsAgeHours:num(t5?.ageHours)
    };
  }

  function scoreClass(s) { if (!finite(s)) return 'BRAK DANYCH'; if (s < 50) return 'NIE'; if (s < 60) return 'MOŻLIWA'; if (s < 80) return 'PRAWDOPODOBNA'; return 'BARDZO PRAWDOPODOBNA'; }
  function riskCss(s) { if (!finite(s) || s < 50) return ''; return s >= 80 ? 'fog-risk-vhigh' : s >= 60 ? 'fog-risk-high' : 'fog-risk-mid'; }
  function localHour(t) { try { return new Intl.DateTimeFormat('pl-PL', {timeZone:window.PLACE?.tz || 'UTC', hour:'2-digit', minute:'2-digit'}).format(new Date(t)); } catch (_) { return new Date(t).toISOString().slice(11, 16); } }
  function onsetAndDissipation(series) {
    const idx = series.findIndex(x => finite(x?.score) && x.score >= 50), onset = idx >= 0 ? series[idx].t : null;
    let end = null;
    if (idx >= 0) { let last = idx; while (last + 1 < series.length && finite(series[last + 1]?.score) && series[last + 1].score >= 50) last++; end = series[last + 1]?.t ?? null; }
    const peak = series.reduce((a, b) => !a || (finite(b.score) && (!finite(a.score) || b.score > a.score)) ? b : a, null);
    return {onset, end, peak};
  }
  function renderOperationalSummary() {
    const series = window.PrognozaEPIRFogSeries || [], now = Date.now();
    const future = series.filter(x => x.t >= now - HOUR && x.t <= now + 48 * HOUR);
    if (!future.length) return;
    const summary = document.getElementById('fogSummary'), hours = document.getElementById('fogHours'), source = document.getElementById('fogSource');
    if (!summary) return;
    const current = future.reduce((a, b) => Math.abs(b.t - now) < Math.abs(a.t - now) ? b : a, future[0]);
    const ev = onsetAndDissipation(future), peak = ev.peak || current, type = peak.type?.text || current.type?.text || peak.mechanism1 || current.mechanism1 || '—';
    summary.innerHTML = `
      <div class="fog-card ${riskCss(current.score)}"><small>MGŁA W CIĄGU NAJBLIŻSZEJ GODZINY</small><strong>${scoreClass(current.score)}</strong><em>${finite(current.score) ? fmt0(current.score) + '/100' : 'brak danych'}</em></div>
      <div class="fog-card"><small>Silnik</small><strong>vNext PRODUKCJA</strong><em>${current.fogEngineFallback ? 'fallback legacy dla tej godziny' : 'P_model_final'}</em></div>
      <div class="fog-card"><small>Typ procesu</small><strong>${esc(type)}</strong><em>${esc(current.mechanism2 || current.type?.secondary || 'dominujący mechanizm')}</em></div>
      <div class="fog-card"><small>Kiedy mgła?</small><strong>${ev.onset ? localHour(ev.onset) + ' → ' + (ev.end ? localHour(ev.end) : 'dalej') : 'brak sygnału ≥50 w 48 h'}</strong><em>próg operacyjny 50/100</em></div>
      <div class="fog-card ${riskCss(peak.score)}"><small>Maksimum w 48 h</small><strong>${finite(peak.score) ? scoreClass(peak.score) : 'BRAK DANYCH'}</strong><em>${finite(peak.score) ? fmt0(peak.score) + '/100' : '—'}</em></div>
      <div class="fog-card"><small>Legacy / vNext</small><strong>${fmt0(current.fogScoreLegacy)}/100 → ${fmt0(current.score)}/100</strong><em>legacy zachowany jako fallback</em></div>
      <div class="fog-card"><small>VIS EPIR</small><strong>${finite(current.vis) ? Math.max(0, Math.round(current.vis)) + ' m' : '—'}</strong><em>bez zmiany danych VIS</em></div>
      <div class="fog-card"><small>Pewność legacy</small><strong>${fmt0((current.confidence ?? 0) * 100)}%</strong><em>diagnostyka zgodności modeli</em></div>`;
    if (hours) {
      hours.innerHTML = future.slice(0, 13).map(x => `<div class="fog-hour ${riskCss(x.score)}"><b>${localHour(x.t)}</b><div class="p">${scoreClass(x.score)}</div><small>${finite(x.score) ? fmt0(x.score) + '/100' : '—'}</small><small>${x.fogEngineFallback ? 'legacy fallback' : 'vNext'}</small><small>VIS ${finite(x.vis) ? Math.round(x.vis) + ' m' : '—'}</small></div>`).join('');
    }
    if (source) source.textContent = `EPIR FOG ENGINE vNext PRODUCTION · ${current.models?.length ?? 0} modeli · ${current.fogEngineFallback ? 'fallback legacy' : 'P_model_final'}`;
  }

  function cell(k, v, sub = '') { return `<div class="fog-diag-cell"><small>${esc(k)}</small><b>${esc(v)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`; }
  function currentHour() { const s = window.PrognozaEPIRFogSeries || []; if (!s.length) return null; const now = Date.now(); let best = s[0], bd = Infinity; for (const x of s) { const d = Math.abs(x.t - now); if (d < bd) { bd = d; best = x; } } return best; }
  function renderDiagnostics() {
    const h = currentHour(), v = h?.vnext; if (!h || !v) return;
    const base = document.getElementById('fogDiag')?.closest('details'); if (!base) return;
    let details = document.getElementById('fogVNextDiagnostics');
    if (!details) { details = document.createElement('details'); details.id = 'fogVNextDiagnostics'; details.className = 'fog-diag'; base.insertAdjacentElement('afterend', details); }
    const vi = h.vnextInput || {}, p = h.vnextProbability || {};
    details.innerHTML = `<summary>Fog Engine vNext — PRODUKCJA</summary><div class="fog-data-note"><b>Tryb:</b> operational. Wynik główny pochodzi z walidowanego P_model_final (physics + direct guidance). Legacy jest używany tylko jako awaryjny fallback, gdy vNext nie zwróci poprawnego wyniku.</div><div class="fog-diag-grid">
      ${cell('Fog score vNext', finite(h.score) ? fmt0(h.score) + '/100' : '—', h.fogEngineFallback ? 'LEGACY FALLBACK' : 'PRODUCTION')}
      ${cell('Fog score legacy', finite(h.fogScoreLegacy) ? fmt0(h.fogScoreLegacy) + '/100' : '—')}
      ${cell('P_physics', finite(p.P_physics) ? fmt(p.P_physics, 3) : '—')}${cell('P_direct', finite(p.P_direct) ? fmt(p.P_direct, 3) : '—')}
      ${cell('P_model_final', finite(p.P_model_final) ? fmt(p.P_model_final, 3) : '—')}${cell('Lead bucket', p.leadBucket || '—')}
      ${cell('SSOIL', fmt0(h.SSOIL) + '/100')}${cell('SPBL', fmt0(h.SPBL) + '/100')}${cell('SSFC_COOL', fmt0(h.SSFC_COOL) + '/100')}
      ${cell('Tsurface', finite(vi.tsurface) ? fmt(vi.tsurface, 1) + ' °C' : '—')}${cell('T5 cm OBS', finite(vi.t5cmObs) ? fmt(vi.t5cmObs, 1) + ' °C' : '—')}
      ${cell('RAD', finite(h.RAD_vNextShadow) ? fmt0(h.RAD_vNextShadow) + '/100' : '—')}${cell('ADV', finite(h.ADV_vNextShadow) ? fmt0(h.ADV_vNextShadow) + '/100' : '—')}${cell('CBL', finite(h.CBL_vNextShadow) ? fmt0(h.CBL_vNextShadow) + '/100' : '—')}${cell('PCP', finite(h.PCP_vNextShadow) ? fmt0(h.PCP_vNextShadow) + '/100' : '—')}
      ${cell('Data quality', fmt0((v.dataQuality || 0) * 100) + '%')}${cell('Braki', v.missing?.length ? v.missing.join(', ') : 'brak')}${cell('Fallbacki fizyki', v.fallbacks?.length ? v.fallbacks.join(', ') : 'brak')}
    </div>`;
  }

  function enrichSeries(Physics, Probability) {
    const series = window.PrognozaEPIRFogSeries; if (!Array.isArray(series) || !series.length) return false;
    const sig = `${series.length}:${series[0]?.t}:${series.at(-1)?.t}:${iconRows.length}:${ecmwfRows.length}`;
    if (sig === lastAppliedSignature && series.every(x => x?.fogEngineMode === 'vnext-production')) { renderOperationalSummary(); renderDiagnostics(); return true; }
    for (const h of series) {
      if (!finite(h?.t)) continue;
      const legacyScore = num(h.fogScoreLegacy) ?? num(h.score);
      const input = inputFor(series, h);
      const enhanced = Physics.enhanceLegacyHour({...h, score:legacyScore}, input);
      const probability = Probability.evaluate(input, enhanced.vnext || {});
      const op = Probability.operationalScore(legacyScore, probability);
      Object.assign(h, enhanced, {
        score:op.score,
        fogScoreLegacy:legacyScore,
        fogEngineMode:'vnext-production',
        fogEngineFallback:op.fallback,
        fogEngineSource:op.source,
        fogProbabilityVNext:finite(probability.P_model_final) ? probability.P_model_final : null,
        vnextProbability:probability,
        vnextInput:{tsurface:input.tsurface, soilTemperature0:input.soilTemperature0, soilTemperature6:input.soilTemperature6, soilTemperatureEcmwf07:input.soilTemperatureEcmwf07, t5cmObs:input.t5cmObs, t5cmObsTime:input.t5cmObsTime, t5cmObsSource:input.t5cmObsSource, t5cmObsAgeHours:input.t5cmObsAgeHours}
      });
    }
    lastAppliedSignature = sig;
    window.PrognozaEPIRFogVNextSeries = series;
    window.PrognozaEPIRFogEngineMode = 'vnext-production';
    renderOperationalSummary();
    window.dispatchEvent(new CustomEvent('prognozaepir:fog-vnext-updated'));
    renderDiagnostics();
    return true;
  }

  async function refresh() {
    try {
      const [Physics, Probability] = await Promise.all([loadPhysics(), loadProbability()]);
      await ensurePhysicalData();
      enrichSeries(Physics, Probability);
    } catch (e) { window.PrognozaEPIRFogVNextError = String(e?.message || e); }
  }
  window.addEventListener('prognozaepir:fog-series-updated', refresh);
  window.addEventListener('prognozaepir:fog-vnext-updated', renderDiagnostics);
  window.addEventListener('prognozaepir:t5cm-updated', () => { lastAppliedSignature = ''; refresh(); });
  setTimeout(refresh, 200);
  setInterval(refresh, 30 * 60 * 1000);
})();
