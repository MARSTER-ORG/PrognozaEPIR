#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_required(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"patch marker missing: {label}")
    return text.replace(old, new, 1)


RUNTIME = r'''// Model snapshot + adaptive weights runtime -------------------------------
(() => {
  if (window.__PrognozaEPIRModelRuntimeInstalled) return;
  window.__PrognozaEPIRModelRuntimeInstalled = true;

  const previousFetch = window.fetch.bind(window);
  const RAW_ROOT = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/';
  const MODEL_SNAPSHOT_RAW = RAW_ROOT + 'data/runtime/models-latest.json';
  const ADAPTIVE_WEIGHTS_RAW = RAW_ROOT + 'data/learning/adaptive-weights.json';
  const HOUR = 3600000;
  let snapshot = null;
  let adaptive = null;
  let snapshotPromise = null;
  let adaptivePromise = null;

  async function jsonWithTimeout(url, timeoutMs=5000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const sep = url.includes('?') ? '&' : '?';
      const r = await previousFetch(url + sep + '_=' + Date.now(), {
        cache: 'no-store', signal: ctl.signal, headers: {Accept:'application/json'}
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function loadSnapshot() {
    if (!snapshotPromise) snapshotPromise = jsonWithTimeout(MODEL_SNAPSHOT_RAW, 5500)
      .then(j => {
        if (j?.schema !== 'prognozaepir-model-snapshot-v1') throw new Error('bad model snapshot schema');
        snapshot = j;
        window.PrognozaEPIRModelSnapshotState = {ok:true, generated_at:j.generated_at, models:Object.keys(j.models||{})};
        return j;
      })
      .catch(e => {
        console.warn('PrognozaEPIR model snapshot unavailable; live Open-Meteo fallback remains active', e);
        window.PrognozaEPIRModelSnapshotState = {ok:false, error:String(e?.message||e)};
        return null;
      });
    return snapshotPromise;
  }

  function loadAdaptive() {
    if (!adaptivePromise) adaptivePromise = jsonWithTimeout(ADAPTIVE_WEIGHTS_RAW, 5500)
      .then(j => {
        if (j?.schema !== 'prognozaepir-adaptive-weights-v1') throw new Error('bad adaptive weight schema');
        adaptive = j;
        return j;
      })
      .catch(e => {
        console.warn('PrognozaEPIR adaptive weights unavailable; base weights remain active', e);
        return null;
      });
    return adaptivePromise;
  }

  function bucketForLead(h) {
    if (!Number.isFinite(h) || h < 0) return null;
    if (h < 3) return '0-3h';
    if (h < 6) return '3-6h';
    if (h < 12) return '6-12h';
    if (h < 24) return '12-24h';
    if (h < 48) return '24-48h';
    return '48-120h';
  }

  function componentForKey(key) {
    if (key === 'temperature_2m') return 'temperature';
    if (key === 'dew_point_2m') return 'dew_point';
    if (key === 'pressure_msl') return 'pressure';
    if (key === 'visibility') return 'visibility';
    if (key === 'wind_speed_10m' || key === 'wind_direction_10m' || key === 'wind_gusts_10m') return 'wind';
    if (key === 'precipitation' || key === 'weather_code') return 'precipitation';
    if (String(key||'').startsWith('cloud_cover')) return 'cloud';
    return null;
  }

  function rowFor(modelId, targetMs) {
    const leadH = Math.max(0, (Number(targetMs) - Date.now()) / HOUR);
    const bucket = bucketForLead(leadH);
    return bucket ? adaptive?.models?.[modelId]?.lead_buckets?.[bucket] || null : null;
  }

  function factor(modelId, targetMs, key=null) {
    const row = rowFor(modelId, targetMs);
    if (!row) return 1;
    const comp = componentForKey(key);
    const v = comp ? Number(row?.components?.[comp]?.weight_factor) : Number(row?.weight_factor);
    return Number.isFinite(v) ? Math.max(.70, Math.min(1.30, v)) : 1;
  }

  function relativeFactor(modelId, targetMs, key) {
    const overall = factor(modelId, targetMs, null);
    const specific = factor(modelId, targetMs, key);
    if (!Number.isFinite(overall) || overall <= 0) return 1;
    return Math.max(.70/.30, Math.min(1.30/.70, specific / overall));
  }

  function snapshotResponse(url) {
    if (!snapshot?.models) return null;
    const modelId = url.searchParams.get('models');
    if (!modelId) return null;
    const model = snapshot.models[modelId];
    const sourceHourly = model?.hourly || {};
    const times = sourceHourly.time || [];
    if (!Array.isArray(times) || !times.length) return null;

    // Do not serve a snapshot that no longer reaches into the future.
    const last = Date.parse(String(times[times.length-1]||'') + (String(times[times.length-1]||'').endsWith('Z')?'':'Z'));
    if (!Number.isFinite(last) || last < Date.now() + 6*HOUR) return null;

    const vars = String(url.searchParams.get('hourly')||'').split(',').map(x=>x.trim()).filter(Boolean);
    const hourly = {time: times};
    const units = {};
    for (const v of vars) {
      if (Array.isArray(sourceHourly[v])) hourly[v] = sourceHourly[v];
      if (model?.hourly_units && Object.prototype.hasOwnProperty.call(model.hourly_units, v)) units[v] = model.hourly_units[v];
    }
    const body = {
      latitude: snapshot.location?.lat,
      longitude: snapshot.location?.lon,
      generationtime_ms: 0,
      utc_offset_seconds: 0,
      timezone: 'UTC',
      timezone_abbreviation: 'UTC',
      elevation: model.elevation,
      hourly_units: units,
      hourly
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-PrognozaEPIR-Model-Source':'repository-snapshot'}
    });
  }

  window.fetch = async function(input, init) {
    let u = null;
    try { u = new URL(typeof input === 'string' ? input : input?.url, location.href); } catch (_) { }
    if (u && u.hostname === 'api.open-meteo.com' && u.pathname === '/v1/forecast') {
      try {
        await loadSnapshot();
        const local = snapshotResponse(u);
        if (local) return local;
      } catch (e) {
        console.warn('model snapshot bridge:', e);
      }
    }
    return previousFetch(input, init);
  };

  window.PrognozaEPIRAdaptiveWeights = {
    load: loadAdaptive,
    factor,
    relativeFactor,
    componentForKey,
    get data(){ return adaptive; }
  };

  loadSnapshot().catch(()=>{});
  loadAdaptive().catch(()=>{});

  // Cloud Learning already has its own cloud-specific factor. Multiply it by
  // the historical all-parameter cloud factor relative to the overall weight,
  // so the same archive affects both the general consensus and cloud profile.
  setTimeout(() => {
    const c = window.PrognozaEPIRCloudLearning;
    if (!c?.factor || c.__adaptiveWrapped) return;
    const base = c.factor.bind(c);
    c.factor = (modelId,targetMs) => base(modelId,targetMs) * relativeFactor(modelId,targetMs,'cloud_cover');
    c.__adaptiveWrapped = true;
  }, 0);
})();
'''


def patch_client():
    p = ROOT / 'cloud-learning-client.js'
    s = p.read_text(encoding='utf-8')
    marker = '// Cloud/model learning client ---------------------------------------------'
    if 'MODEL_SNAPSHOT_RAW' not in s:
        if marker not in s:
            raise SystemExit('cloud client insertion marker missing')
        s = s.replace(marker, RUNTIME + '\n\n' + marker, 1)
    p.write_text(s, encoding='utf-8')


def patch_index():
    p = ROOT / 'index.html'
    s = p.read_text(encoding='utf-8')
    s = replace_required(
        s,
        "function wavg(items,key){let s=0,w=0;for(const i of items){const v=i.row[key];if(finite(v)){s+=v*i.w;w+=i.w}}return w?s/w:null}",
        "function wavg(items,key){let s=0,w=0;for(const i of items){const v=i.row[key];if(finite(v)){const af=window.PrognozaEPIRAdaptiveWeights?.relativeFactor?.(i.model.id,i.t,key)||1,ww=i.w*af;s+=v*ww;w+=ww}}return w?s/w:null}",
        'adaptive wavg')
    s = replace_required(
        s,
        "function wind(items){let u=0,v=0,w=0;for(const i of items){const s=i.row.wind_speed_10m,d=i.row.wind_direction_10m;if(finite(s)&&finite(d)){const z=uv(s,d);u+=z.u*i.w;v+=z.v*i.w;w+=i.w}}return w?sd(u/w,v/w):{speed:null,dir:null}}",
        "function wind(items){let u=0,v=0,w=0;for(const i of items){const s=i.row.wind_speed_10m,d=i.row.wind_direction_10m;if(finite(s)&&finite(d)){const af=window.PrognozaEPIRAdaptiveWeights?.relativeFactor?.(i.model.id,i.t,'wind_speed_10m')||1,ww=i.w*af,z=uv(s,d);u+=z.u*ww;v+=z.v*ww;w+=ww}}return w?sd(u/w,v/w):{speed:null,dir:null}}",
        'adaptive wind')
    s = replace_required(
        s,
        "if(row)items.push({model:m,row,w:m.w,elevation:ds.elevation})",
        "if(row){const aw=window.PrognozaEPIRAdaptiveWeights?.factor?.(m.id,t)||1;items.push({model:m,row,w:m.w*aw,elevation:ds.elevation,t})}",
        'adaptive base weight')
    s = s.replace(
        "const wetItems=items.filter(i=>finite(i.row.precipitation)),wetW=wetItems.reduce((a,i)=>a+i.w,0)",
        "const wetItems=items.filter(i=>finite(i.row.precipitation)).map(i=>({...i,w:i.w*(window.PrognozaEPIRAdaptiveWeights?.relativeFactor?.(i.model.id,t,'precipitation')||1)})),wetW=wetItems.reduce((a,i)=>a+i.w,0)")
    s = s.replace(
        "const stormItems=items.filter(i=>finite(i.row.weather_code)),stormW=stormItems.reduce((a,i)=>a+i.w,0)",
        "const stormItems=items.filter(i=>finite(i.row.weather_code)).map(i=>({...i,w:i.w*(window.PrognozaEPIRAdaptiveWeights?.relativeFactor?.(i.model.id,t,'weather_code')||1)})),stormW=stormItems.reduce((a,i)=>a+i.w,0)")
    s = s.replace('band(pr,2000,5000)', 'band(pr,2000,6000)')
    s = s.replace('band(pr,5000,13001)', 'band(pr,6000,13001)')
    s = s.replace('bandHeightForAmount(pr,2000,5000,', 'bandHeightForAmount(pr,2000,6000,')
    s = s.replace('bandHeightForAmount(pr,5000,13001,', 'bandHeightForAmount(pr,6000,13001,')
    s = s.replace('średnie 2–5 km', 'średnie 2–6 km').replace('wysokie 5–13 km', 'wysokie 6–13 km')
    s = s.replace('Średnie 2–5 km', 'Średnie 2–6 km').replace('Wysokie 5–13 km', 'Wysokie 6–13 km')
    s = s.replace('pobiera dostępne modele bezpośrednio z Open-Meteo.', 'korzysta z serwerowego snapshotu modeli; Open-Meteo pozostaje źródłem i awaryjnym fallbackiem.')
    p.write_text(s, encoding='utf-8')


def patch_rh_axis():
    p = ROOT / 'rh-axis-fix.js'
    s = p.read_text(encoding='utf-8')
    s = s.replace('z.profile,2000,5000', 'z.profile,2000,6000')
    s = s.replace('z.profile,5000,13001', 'z.profile,6000,13001')
    s = s.replace("'Średnie 2–5 km'", "'Średnie 2–6 km'")
    s = s.replace("'Wysokie 5–13 km'", "'Wysokie 6–13 km'")
    s = s.replace("'Średnie',detailedCloudLayerText(z.oktaM,z.midH,z.profile,2000,5000)", "'Średnie',detailedCloudLayerText(z.oktaM,z.midH,z.profile,2000,6000)")
    s = s.replace("'Wysokie',detailedCloudLayerText(z.oktaH,z.highH,z.profile,5000,13001)", "'Wysokie',detailedCloudLayerText(z.oktaH,z.highH,z.profile,6000,13001)")
    p.write_text(s, encoding='utf-8')


def patch_cloud_learning():
    p = ROOT / 'scripts' / 'cloud_learning.py'
    s = p.read_text(encoding='utf-8')
    s = s.replace('band = "low" if h < 2000 else ("mid" if h < 5000 else "high")', 'band = "low" if h < 2000 else ("mid" if h < 6000 else "high")')
    s = s.replace('if lowest >= 5000 and observed["mid"] is None:', 'if lowest >= 6000 and observed["mid"] is None:')
    p.write_text(s, encoding='utf-8')


def patch_pages_checks():
    p = ROOT / '.github' / 'workflows' / 'pages.yml'
    s = p.read_text(encoding='utf-8')
    old = "          grep -F 'if(row)items.push({model:m,row,w:m.w,elevation:ds.elevation})' _site/index.html"
    new = "          grep -F 'PrognozaEPIRAdaptiveWeights?.factor' _site/index.html\n          grep -F 'MODEL_SNAPSHOT_RAW' _site/cloud-learning-client.js"
    if old in s:
        s = s.replace(old, new, 1)
    elif "grep -F 'MODEL_SNAPSHOT_RAW' _site/cloud-learning-client.js" not in s:
        raise SystemExit('pages adaptive verification marker missing')
    p.write_text(s, encoding='utf-8')


def main():
    patch_client()
    patch_index()
    patch_rh_axis()
    patch_cloud_learning()
    patch_pages_checks()
    print('adaptive runtime patch applied')


if __name__ == '__main__':
    main()
