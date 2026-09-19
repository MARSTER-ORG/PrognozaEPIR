'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  let params;
  try { params = new URLSearchParams(window.location.search || ''); }
  catch (_) { return; }
  if (params.get('fog_archive') !== '1') return;

  const HOUR = 3600e3;
  const finite = Number.isFinite;
  const num = v => v !== null && v !== undefined && v !== '' && finite(Number(v)) ? Number(v) : null;
  const mean = values => {
    const a = (values || []).map(num).filter(finite);
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  };
  const round = (v, n = 2) => finite(num(v)) ? Number(Number(v).toFixed(n)) : null;
  const iso = t => finite(num(t)) ? new Date(Number(t)).toISOString() : null;

  function ensureOutput() {
    let el = document.getElementById('fogLegacyArchivePayload');
    if (el) return el;
    el = document.createElement('pre');
    el.id = 'fogLegacyArchivePayload';
    el.setAttribute('data-ready', '0');
    el.style.cssText = 'display:none!important';
    document.body.appendChild(el);
    return el;
  }

  function legacySeries() {
    try {
      const p = window.PrognozaEPIRTAFFogPolicy;
      if (p?.seriesForMode) {
        const s = p.seriesForMode(window, 'legacy');
        if (Array.isArray(s) && s.length) return s;
      }
    } catch (_) {}
    if (Array.isArray(window.PrognozaEPIRFogLegacySeries) && window.PrognozaEPIRFogLegacySeries.length)
      return window.PrognozaEPIRFogLegacySeries.slice();
    if (Array.isArray(window.PrognozaEPIRFogSeries))
      return window.PrognozaEPIRFogSeries.map(x => finite(num(x?.fogScoreLegacy)) ? {...x, score:num(x.fogScoreLegacy)} : x);
    return [];
  }

  function mifgSeries() {
    try {
      const s = window.PrognozaEPIRMIFG?.getSeries?.();
      return Array.isArray(s) ? s : [];
    } catch (_) { return []; }
  }

  function nearest(rows, t, maxDelta = 50 * 60e3) {
    let best = null, delta = Infinity;
    for (const r of rows || []) {
      const rt = num(r?.t);
      if (!finite(rt)) continue;
      const d = Math.abs(rt - t);
      if (d < delta) { best = r; delta = d; }
    }
    return delta <= maxDelta ? best : null;
  }

  function brFor(row, now) {
    try { return window.PrognozaEPIRBREngine?.scoreRow?.(row, 'legacy', now) || null; }
    catch (_) { return null; }
  }

  function compactComponents(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const x = num(v);
      if (finite(x)) out[k] = round(x, 4);
    }
    return out;
  }

  function compactHour(row, runMs, mifgRows) {
    const t = num(row?.t);
    if (!finite(t)) return null;
    const models = Array.isArray(row?.models) ? row.models : [];
    const br = brFor(row, runMs);
    const mifg = nearest(mifgRows, t);
    const tv = row?.type?.values || {};
    const modelIds = [...new Set(models.map(m => String(m?.id || '')).filter(Boolean))].sort();
    return {
      valid_time: iso(t),
      lead_hours: round((t - runMs) / HOUR, 3),
      score: round(num(row?.fogScoreLegacy) ?? num(row?.score), 3),
      phys_score: round(row?.PHYS, 3),
      nwp_score: round(row?.NWP, 3),
      predicted_visibility_m: round(row?.vis, 1),
      vis1500_score: round(row?.vis1500, 3),
      vis1000_score: round(row?.vis1000, 3),
      vis500_score: round(row?.vis500, 3),
      vis200_score: round(row?.vis200, 3),
      saturation_score: round(row?.sat, 3),
      agreement: round(row?.agreement, 4),
      data_coverage: round(row?.data, 4),
      confidence: round(row?.confidence, 4),
      temperature_c: round(row?.T, 2),
      freezing_fog_flag: row?.fzfg ?? null,
      dmi_fog_2m_pct: round(row?.dmiFog, 2),
      fsi_kt: round(row?.FSI, 2),
      mechanism: row?.type?.text || row?.type || null,
      mechanism_primary: row?.type?.primary || null,
      mechanism_secondary: row?.type?.secondary || null,
      mechanisms: {
        RAD: round(tv?.RAD, 3),
        ADV: round(tv?.ADV, 3),
        CBL: round(tv?.CBL, 3),
        PCP: round(tv?.PCP, 3)
      },
      observation_assimilated: Boolean(row?.obsUsed),
      observation_phenomenon: row?.obsPhenomenon ?? null,
      observation_visibility_m: round(row?.obsVisM, 1),
      observation_source: row?.obsSource ?? null,
      model_count: models.length,
      model_ids: modelIds,
      model_mean: {
        temperature_c: round(mean(models.map(m => m?.T)), 2),
        dew_point_c: round(mean(models.map(m => m?.Td)), 2),
        relative_humidity_pct: round(mean(models.map(m => m?.RH)), 2),
        wind_speed_ms: round(mean(models.map(m => m?.WS)), 3),
        visibility_m: round(mean(models.map(m => m?.VIS)), 1)
      },
      br: br ? {
        score: round(br.score, 3),
        saturation: round(br.saturation, 4),
        fog_potential: round(br.fogPotential, 4),
        visibility_m: round(br.visibility, 1),
        visibility_evidence: round(br.visibilityEvidence, 4),
        transition_evidence: round(br.transitionEvidence, 4),
        observed_br: Boolean(br.observedBR)
      } : null,
      mifg: mifg ? {
        score: round(mifg.score, 3),
        source: mifg.source || null,
        components: compactComponents(mifg.components)
      } : null
    };
  }

  function publish() {
    const out = ensureOutput();
    const runMs = Date.now();
    const legacy = legacySeries();
    if (!legacy.length) return false;
    const mifg = mifgSeries();
    const hours = legacy
      .map(r => compactHour(r, runMs, mifg))
      .filter(Boolean)
      .filter(r => {
        const t = Date.parse(r.valid_time);
        return finite(t) && t >= runMs - HOUR && t <= runMs + 49 * HOUR;
      })
      .sort((a, b) => Date.parse(a.valid_time) - Date.parse(b.valid_time));
    if (!hours.length) return false;

    const ids = [...new Set(hours.flatMap(r => r.model_ids || []))].sort();
    let mifgStatus = null;
    try { mifgStatus = window.PrognozaEPIRMIFG?.getStatus?.() || null; } catch (_) {}
    const payload = {
      schema: 'prognozaepir-fog-legacy-browser-snapshot-v1',
      captured_at: new Date(runMs).toISOString(),
      engine_mode: 'legacy',
      source: 'canonical-browser-runtime',
      location: {
        name: String(window.PLACE?.name || 'EPIR'),
        lat: num(window.PLACE?.lat),
        lon: num(window.PLACE?.lon),
        tz: String(window.PLACE?.tz || 'UTC')
      },
      model_ids: ids,
      readiness: {
        legacy_hours: hours.length,
        br_hours: hours.filter(x => finite(num(x?.br?.score))).length,
        mifg_hours: hours.filter(x => finite(num(x?.mifg?.score))).length,
        dedicated_legacy_series: Array.isArray(window.PrognozaEPIRFogLegacySeries) && window.PrognozaEPIRFogLegacySeries.length > 0,
        mifg_source: mifgStatus?.source || null,
        mifg_error: mifgStatus?.error || null
      },
      hours
    };
    out.textContent = JSON.stringify(payload);
    out.setAttribute('data-ready', hours.length >= 12 ? '1' : '0');
    out.setAttribute('data-captured-at', payload.captured_at);
    return true;
  }

  ensureOutput();
  for (const ev of [
    'prognozaepir:fog-series-updated',
    'prognozaepir:fog-vnext-updated',
    'prognozaepir:br-series-updated',
    'prognozaepir:mifg-series-updated'
  ]) window.addEventListener(ev, () => setTimeout(publish, 0));

  let attempts = 0;
  const timer = setInterval(() => {
    const ok = publish();
    attempts += 1;
    if (ok && attempts >= 12) clearInterval(timer);
    if (attempts >= 60) clearInterval(timer);
  }, 500);
  setTimeout(publish, 1000);
  setTimeout(publish, 5000);
  setTimeout(publish, 12000);
  setTimeout(publish, 25000);
})();
