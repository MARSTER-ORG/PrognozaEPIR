#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(s, old, new, label):
    if new in s:
        return s
    if old not in s:
        raise SystemExit(f'missing patch marker: {label}')
    return s.replace(old, new, 1)


def patch_runtime_text(s):
    s = replace_once(s,
        "  const ADAPTIVE_WEIGHTS_RAW = RAW_ROOT + 'data/learning/adaptive-weights.json';\n  const HOUR = 3600000;",
        "  const ADAPTIVE_WEIGHTS_RAW = RAW_ROOT + 'data/learning/adaptive-weights.json';\n  const SYNOPTIC_SKILL_RAW = RAW_ROOT + 'data/learning/synoptic-regime-skill.json';\n  const HOUR = 3600000;",
        'synoptic skill URL')
    s = replace_once(s,
        "  let adaptive = null;\n  let snapshotPromise = null;\n  let adaptivePromise = null;",
        "  let adaptive = null;\n  let synopticSkill = null;\n  let snapshotPromise = null;\n  let adaptivePromise = null;\n  let synopticPromise = null;",
        'synoptic state')
    anchor = "\n  function bucketForLead(h) {"
    loader = r'''

  function loadSynopticSkill() {
    if (!synopticPromise) synopticPromise = jsonWithTimeout(SYNOPTIC_SKILL_RAW, 5500)
      .then(j => {
        if (j?.schema !== 'prognozaepir-synoptic-regime-learning-v1') throw new Error('bad synoptic skill schema');
        synopticSkill = j;
        return j;
      })
      .catch(e => {
        console.warn('PrognozaEPIR synoptic-regime skill unavailable; contextual factor stays neutral', e);
        synopticSkill = null;
        return null;
      });
    return synopticPromise;
  }
'''
    if 'function loadSynopticSkill()' not in s:
        if anchor not in s:
            raise SystemExit('missing patch marker: synoptic loader anchor')
        s = s.replace(anchor, loader + anchor, 1)

    anchor2 = "\n  function rowFor(modelId, targetMs) {"
    context = r'''

  const SYNOPTIC_DIMENSION_WEIGHTS = {
    season:.25, daypart:.10, inflow_850:.25, stability_925:.20, moisture_low:.15, pressure_regime:.05
  };

  function clampNumber(v,a,b){ return Math.max(a,Math.min(b,v)); }

  function weightedContextMean(items,key) {
    let s=0,w=0;
    for (const i of items||[]) {
      const v=Number(i?.row?.[key]), ww=Number(i?.model?.w);
      if (Number.isFinite(v) && Number.isFinite(ww) && ww>0) { s+=v*ww; w+=ww; }
    }
    return w ? s/w : null;
  }

  function weightedContextDirection(items,key) {
    let sx=0,cy=0,w=0;
    for (const i of items||[]) {
      const d=Number(i?.row?.[key]), ww=Number(i?.model?.w);
      if (!Number.isFinite(d) || !Number.isFinite(ww) || ww<=0) continue;
      const r=d*Math.PI/180;
      sx+=Math.sin(r)*ww; cy+=Math.cos(r)*ww; w+=ww;
    }
    if (!w || Math.hypot(sx,cy)<1e-9) return null;
    return (Math.atan2(sx/w,cy/w)*180/Math.PI+360)%360;
  }

  function directionSector(deg) {
    if (!Number.isFinite(deg)) return null;
    const labels=['N','NE','E','SE','S','SW','W','NW'];
    return labels[Math.floor((((deg%360)+360)%360+22.5)/45)%8];
  }

  function localMonthHour(targetMs) {
    try {
      const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',month:'numeric',hour:'numeric',hourCycle:'h23'}).formatToParts(new Date(targetMs));
      const get=t=>Number(parts.find(p=>p.type===t)?.value);
      return {month:get('month'),hour:get('hour')};
    } catch (_) {
      const d=new Date(targetMs); return {month:d.getUTCMonth()+1,hour:d.getUTCHours()};
    }
  }

  function contextForItems(items,targetMs) {
    const {month,hour}=localMonthHour(targetMs);
    const season=([12,1,2].includes(month)?'winter':([3,4,5].includes(month)?'spring':([6,7,8].includes(month)?'summer':'autumn')));
    const daypart=hour<6?'night':(hour<12?'morning':(hour<18?'afternoon':'evening'));
    const wd850=weightedContextDirection(items,'wind_direction_850hPa');
    const t2=weightedContextMean(items,'temperature_2m');
    const t925=weightedContextMean(items,'temperature_925hPa');
    const z925=weightedContextMean(items,'geopotential_height_925hPa');
    const terrain=weightedContextMean((items||[]).map(i=>({model:i.model,row:{terrain:Number(i.elevation)}})),'terrain');
    let stability_925=null;
    if (Number.isFinite(t2) && Number.isFinite(t925)) {
      if (Number.isFinite(z925) && Number.isFinite(terrain) && z925>terrain+150) {
        const lapse=(t2-t925)/(z925-terrain)*1000;
        stability_925=lapse<0?'inversion':(lapse<4?'stable':(lapse<=8?'mixed_neutral':'unstable'));
      } else {
        const delta=t925-t2;
        stability_925=delta>=0?'inversion':(delta>=-3?'stable':(delta>=-7?'mixed_neutral':'unstable'));
      }
    }
    const rhs=[weightedContextMean(items,'relative_humidity_925hPa'),weightedContextMean(items,'relative_humidity_850hPa')].filter(Number.isFinite);
    let moisture_low=null;
    if (rhs.length) {
      const rh=rhs.reduce((a,b)=>a+b,0)/rhs.length;
      moisture_low=rh>=85?'very_moist_lower_troposphere':(rh>=70?'moist_lower_troposphere':(rh>=50?'moderate_lower_troposphere':'dry_lower_troposphere'));
    }
    const p=weightedContextMean(items,'pressure_msl');
    const pressure_regime=!Number.isFinite(p)?null:(p>=1022?'high_pressure_environment':(p<=1005?'low_pressure_environment':'intermediate_pressure'));
    return {season,daypart,inflow_850:directionSector(wd850),stability_925,moisture_low,pressure_regime};
  }

  function contextFactor(modelId,targetMs,key,ctx) {
    if (!ctx || !synopticSkill) return 1;
    const comp=componentForKey(key);
    const bucket=bucketForLead(Math.max(0,(Number(targetMs)-Date.now())/HOUR));
    const dims=bucket&&comp?synopticSkill?.models?.[modelId]?.lead_buckets?.[bucket]?.components?.[comp]?.dimensions:null;
    if (!dims) return 1;
    const weights=synopticSkill?.dimension_weights||SYNOPTIC_DIMENSION_WEIGHTS;
    let logSum=0,totalWeight=0;
    for (const [dim,defaultWeight] of Object.entries(SYNOPTIC_DIMENSION_WEIGHTS)) {
      const dw=Number(weights?.[dim]);
      const w=Number.isFinite(dw)&&dw>0?dw:defaultWeight;
      totalWeight+=w;
      const label=ctx?.[dim];
      const f=Number(label?dims?.[dim]?.[label]?.factor:null);
      if (Number.isFinite(f) && f>0) logSum+=Math.log(f)*w;
    }
    if (!totalWeight) return 1;
    return clampNumber(Math.exp(logSum/totalWeight),.85,1.15);
  }
'''
    if 'function contextForItems(items,targetMs)' not in s:
        if anchor2 not in s:
            raise SystemExit('missing patch marker: context classifier anchor')
        s = s.replace(anchor2, context + anchor2, 1)

    old_rel = "  function relativeFactor(modelId, targetMs, key) {\n    const overall = factor(modelId, targetMs, null);\n    const specific = factor(modelId, targetMs, key);\n    if (!Number.isFinite(overall) || overall <= 0) return 1;\n    return Math.max(.70/.30, Math.min(1.30/.70, specific / overall));\n  }"
    new_rel = "  function relativeFactor(modelId, targetMs, key, ctx=null) {\n    const overall = factor(modelId, targetMs, null);\n    const specific = factor(modelId, targetMs, key);\n    if (!Number.isFinite(overall) || overall <= 0) return 1;\n    const contextual = contextFactor(modelId,targetMs,key,ctx);\n    return Math.max(.70/1.30, Math.min(1.30/.70, (specific / overall) * contextual));\n  }"
    s = replace_once(s, old_rel, new_rel, 'relative factor + bound fix')

    old_api = "  window.PrognozaEPIRAdaptiveWeights = {\n    load: loadAdaptive,\n    factor,\n    relativeFactor,\n    componentForKey,\n    get data(){ return adaptive; }\n  };"
    new_api = "  window.PrognozaEPIRAdaptiveWeights = {\n    load: loadAdaptive,\n    loadSynoptic: loadSynopticSkill,\n    factor,\n    relativeFactor,\n    contextFactor,\n    contextForItems,\n    componentForKey,\n    get data(){ return adaptive; },\n    get synopticData(){ return synopticSkill; }\n  };"
    s = replace_once(s, old_api, new_api, 'runtime API')
    s = replace_once(s,
        "  loadSnapshot().catch(()=>{});\n  loadAdaptive().catch(()=>{});",
        "  loadSnapshot().catch(()=>{});\n  loadAdaptive().catch(()=>{});\n  loadSynopticSkill().catch(()=>{});",
        'synoptic preload')
    return s


def patch_client():
    p=ROOT/'cloud-learning-client.js'
    p.write_text(patch_runtime_text(p.read_text(encoding='utf-8')),encoding='utf-8')


def patch_adaptive_source():
    p=ROOT/'scripts'/'apply_adaptive_runtime_patch.py'
    s=patch_runtime_text(p.read_text(encoding='utf-8'))
    s=s.replace("relativeFactor?.(i.model.id,i.t,key)||1", "relativeFactor?.(i.model.id,i.t,key,i.context)||1")
    s=s.replace("relativeFactor?.(i.model.id,i.t,'wind_speed_10m')||1", "relativeFactor?.(i.model.id,i.t,'wind_speed_10m',i.context)||1")
    p.write_text(s,encoding='utf-8')


def patch_index():
    p=ROOT/'index.html'
    s=p.read_text(encoding='utf-8')
    s=replace_once(s,
        "const profileVarsFor=m=>(m.levels||LEVELS).flatMap(p=>['cloud_cover_'+p+'hPa','relative_humidity_'+p+'hPa','geopotential_height_'+p+'hPa']);",
        "const REGIME_LEVELS=[925,850,700,500];\nconst profileVarsFor=m=>{const levels=m.levels||LEVELS,base=levels.flatMap(p=>['cloud_cover_'+p+'hPa','relative_humidity_'+p+'hPa','geopotential_height_'+p+'hPa']),regime=REGIME_LEVELS.filter(p=>levels.includes(p)).flatMap(p=>['temperature_'+p+'hPa','wind_speed_'+p+'hPa','wind_direction_'+p+'hPa']);return[...new Set([...base,...regime])]};",
        'index regime profile variables')
    s=s.replace("relativeFactor?.(i.model.id,i.t,key)||1", "relativeFactor?.(i.model.id,i.t,key,i.context)||1")
    s=s.replace("relativeFactor?.(i.model.id,i.t,'wind_speed_10m')||1", "relativeFactor?.(i.model.id,i.t,'wind_speed_10m',i.context)||1")
    s=replace_once(s,
        "}}const sw=items.reduce((a,b)=>a+b.w,0);",
        "}}const synopticContext=window.PrognozaEPIRAdaptiveWeights?.contextForItems?.(items,t)||null;items=items.map(i=>({...i,context:synopticContext}));const sw=items.reduce((a,b)=>a+b.w,0);",
        'index context attachment')
    s=s.replace("relativeFactor?.(i.model.id,t,'precipitation')||1", "relativeFactor?.(i.model.id,t,'precipitation',i.context)||1")
    s=s.replace("relativeFactor?.(i.model.id,t,'weather_code')||1", "relativeFactor?.(i.model.id,t,'weather_code',i.context)||1")
    p.write_text(s,encoding='utf-8')


def patch_rollout():
    p=ROOT/'.github'/'workflows'/'adaptive-runtime-rollout.yml'
    s=p.read_text(encoding='utf-8')
    s=replace_once(s,
        "      - 'scripts/build_historical_model_skill.py'\n      - 'scripts/cloud_learning_backfill.py'",
        "      - 'scripts/build_historical_model_skill.py'\n      - 'scripts/build_synoptic_regime_learning.py'\n      - 'scripts/enrich_synoptic_context.py'\n      - 'scripts/synoptic_regime.py'\n      - 'scripts/cloud_learning_backfill.py'",
        'rollout paths')
    s=replace_once(s,
        "            scripts/build_historical_model_skill.py \\\n            scripts/cloud_learning_backfill.py \\",
        "            scripts/build_historical_model_skill.py \\\n            scripts/build_synoptic_regime_learning.py \\\n            scripts/enrich_synoptic_context.py \\\n            scripts/synoptic_regime.py \\\n            scripts/cloud_learning_backfill.py \\",
        'rollout pycompile')
    s=replace_once(s,
        "          python3 scripts/build_historical_model_skill.py\n          python3 scripts/build_fog_event_learning.py",
        "          python3 scripts/build_historical_model_skill.py\n          python3 scripts/build_synoptic_regime_learning.py\n          python3 scripts/build_fog_event_learning.py",
        'rollout rebuild')
    s=replace_once(s,
        "          python3 -m json.tool data/learning/historical-model-skill.json >/dev/null\n          python3 -m json.tool data/learning/fog-event-skill.json >/dev/null",
        "          python3 -m json.tool data/learning/historical-model-skill.json >/dev/null\n          python3 -m json.tool data/learning/synoptic-regime-skill.json >/dev/null\n          python3 -m json.tool data/learning/fog-event-skill.json >/dev/null",
        'rollout json validation')
    s=replace_once(s,
        "          hist=json.loads(Path('data/learning/historical-model-skill.json').read_text(encoding='utf-8'))\n          fog=json.loads(Path('data/learning/fog-event-skill.json').read_text(encoding='utf-8'))",
        "          hist=json.loads(Path('data/learning/historical-model-skill.json').read_text(encoding='utf-8'))\n          syn=json.loads(Path('data/learning/synoptic-regime-skill.json').read_text(encoding='utf-8'))\n          fog=json.loads(Path('data/learning/fog-event-skill.json').read_text(encoding='utf-8'))",
        'rollout load synoptic')
    s=replace_once(s,
        "          assert (hist.get('archive') or {}).get('usable_forecast_cases',0) >= 100\n          assert fog.get('schema') == 'prognozaepir-fog-event-skill-v1'",
        "          assert (hist.get('archive') or {}).get('usable_forecast_cases',0) >= 100\n          assert syn.get('schema') == 'prognozaepir-synoptic-regime-learning-v1'\n          assert len(syn.get('models') or {}) >= 8\n          assert syn.get('usable_cases',0) >= 100\n          assert fog.get('schema') == 'prognozaepir-fog-event-skill-v1'",
        'rollout assert synoptic')
    s=replace_once(s,
        "          assert 'repository-snapshot' in client\n          fog=Path('fog-engine.js').read_text(encoding='utf-8')",
        "          assert 'repository-snapshot' in client\n          assert 'SYNOPTIC_SKILL_RAW' in client\n          assert 'contextForItems' in client\n          assert '.70/1.30' in client\n          fog=Path('fog-engine.js').read_text(encoding='utf-8')",
        'frontend synoptic validation')
    p.write_text(s,encoding='utf-8')


def main():
    patch_client()
    patch_adaptive_source()
    patch_index()
    patch_rollout()
    print('synoptic regime runtime upgrade applied')


if __name__=='__main__':
    main()
