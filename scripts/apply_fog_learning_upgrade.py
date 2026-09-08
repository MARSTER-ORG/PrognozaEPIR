#!/usr/bin/env python3
"""Upgrade fog-engine.js with adaptive model weighting and KNMI HARMONIE.

Idempotent source patch used by CI so the large browser file does not need to
be rewritten manually. DMI HARMONIE keeps its native 2 m fog field; KNMI
HARMONIE Europe adds an independent regional visibility/low-cloud signal.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / "fog-engine.js"


def replace_once(s, old, new, label):
    if new in s:
        return s
    if old not in s:
        raise SystemExit(f"fog patch marker missing: {label}")
    return s.replace(old, new, 1)


def main():
    s = P.read_text(encoding="utf-8")

    s = s.replace("const ENGINE_VERSION = 'EPIR FOG ENGINE v1.1';", "const ENGINE_VERSION = 'EPIR FOG ENGINE v1.2';")

    s = replace_once(
        s,
        "  const DMI_MODEL = 'dmi_harmonie_arome_europe';\n  const CORE_SUPPLEMENT_MODELS = new Set([",
        "  const DMI_MODEL = 'dmi_harmonie_arome_europe';\n  const KNMI_MODEL = 'knmi_harmonie_arome_europe';\n  const ADAPTIVE_WEIGHTS_URL = 'data/learning/adaptive-weights.json';\n  const CORE_SUPPLEMENT_MODELS = new Set([",
        "constants",
    )

    dmi_tail = """    'wind_speed_100m','wind_speed_250m'\n  ];\n  const SUPPLEMENT_VARS = ["""
    knmi_block = """    'wind_speed_100m','wind_speed_250m'\n  ];\n  const KNMI_VARS = [\n    'temperature_2m','relative_humidity_2m','dew_point_2m','visibility',\n    'cloud_cover','cloud_cover_low','cloud_cover_mid','cloud_cover_high',\n    'wind_speed_10m','wind_direction_10m','wind_gusts_10m','precipitation',\n    'shortwave_radiation','is_day','surface_temperature',\n    'temperature_100m','temperature_200m','temperature_300m'\n  ];\n  const SUPPLEMENT_VARS = ["""
    s = replace_once(s, dmi_tail, knmi_block, "KNMI variables")

    s = replace_once(
        s,
        "  let dmiRows = [];\n  let supplements = new Map();",
        "  let dmiRows = [];\n  let knmiRows = [];\n  let adaptiveWeights = null;\n  let supplements = new Map();",
        "state",
    )

    fetch_marker = """  async function fetchSupplement(modelId){"""
    fetch_extra = r'''  async function fetchKnmi(){
    const q=new URLSearchParams({
      latitude:String(PLACE.lat),longitude:String(PLACE.lon),hourly:KNMI_VARS.join(','),
      models:KNMI_MODEL,timezone:'UTC',forecast_hours:'60',past_hours:'6',wind_speed_unit:'ms'
    });
    const r=await fetch('https://api.open-meteo.com/v1/forecast?'+q,{cache:'no-store'});
    const j=await r.json().catch(()=>null);
    if(!r.ok||!j?.hourly?.time)throw new Error(j?.reason||j?.message||('KNMI HTTP '+r.status));
    const h=j.hourly;
    knmiRows=(h.time||[]).map((z,i)=>({
      t:parseUtc(z),T:n(h.temperature_2m?.[i]),Td:n(h.dew_point_2m?.[i]),RH:n(h.relative_humidity_2m?.[i]),VIS:n(h.visibility?.[i]),
      TCC:n(h.cloud_cover?.[i]),LOW:n(h.cloud_cover_low?.[i]),MID:n(h.cloud_cover_mid?.[i]),HIGH:n(h.cloud_cover_high?.[i]),
      WS:n(h.wind_speed_10m?.[i]),WD:n(h.wind_direction_10m?.[i]),G:n(h.wind_gusts_10m?.[i]),RR:n(h.precipitation?.[i]),
      SW:n(h.shortwave_radiation?.[i]),isDay:n(h.is_day?.[i]),Tskin:n(h.surface_temperature?.[i]),
      T100:n(h.temperature_100m?.[i]),T200:n(h.temperature_200m?.[i]),T300:n(h.temperature_300m?.[i])
    })).filter(x=>finite(x.t)).sort((a,b)=>a.t-b.t);
  }

  async function fetchAdaptiveWeights(){
    const sep=ADAPTIVE_WEIGHTS_URL.includes('?')?'&':'?';
    const r=await fetch(ADAPTIVE_WEIGHTS_URL+sep+'_='+Date.now(),{cache:'no-store'});
    const j=await r.json().catch(()=>null);
    if(!r.ok||j?.schema!=='prognozaepir-adaptive-weights-v1')throw new Error('adaptive weights unavailable');
    adaptiveWeights=j;
  }

'''
    if "async function fetchKnmi()" not in s:
        if fetch_marker not in s:
            raise SystemExit("fog patch marker missing: fetch supplement")
        s = s.replace(fetch_marker, fetch_extra + fetch_marker, 1)

    old_refresh = r'''      await fetchDmi();
      const ids=(typeof MODELS!=='undefined'?MODELS:[]).map(m=>m.id).filter(id=>CORE_SUPPLEMENT_MODELS.has(id));
      await Promise.all(ids.map(fetchSupplement));'''
    new_refresh = r'''      await fetchDmi();
      const ids=(typeof MODELS!=='undefined'?MODELS:[]).map(m=>m.id).filter(id=>CORE_SUPPLEMENT_MODELS.has(id));
      await Promise.all([
        ...ids.map(fetchSupplement),
        fetchKnmi().catch(e=>{knmiRows=[];console.warn('KNMI fog supplement:',e)}),
        fetchAdaptiveWeights().catch(e=>{adaptiveWeights=null;console.warn('fog adaptive weights:',e)})
      ]);'''
    s = replace_once(s, old_refresh, new_refresh, "refresh external")

    dmi_surface_tail = r'''  function modelInput(model,t){return model.id===DMI_MODEL?dmiSurface(t):rawSurface(model,t);}'''
    knmi_surface_tail = r'''  function knmiSurface(t){
    const r=nearest(knmiRows,t);if(!r)return null;
    return {
      id:KNMI_MODEL,name:'KNMI HARMONIE-AROME Europe 5.5 km',t:r.t,T:r.T,Td:r.Td,RH:r.RH,WS:r.WS,WD:r.WD,G:r.G,RR:r.RR,VIS:r.VIS,P:null,Tskin:r.Tskin,
      LOW:r.LOW,MID:r.MID,HIGH:r.HIGH,TCC:r.TCC,CBH:null,
      T100:r.T100,T200:r.T200,T300:r.T300,RH100:null,RH200:null,RH300:null,
      T850:null,U850:null,directFog:null
    };
  }
  function modelInput(model,t){
    if(model.id===DMI_MODEL)return dmiSurface(t);
    if(model.id===KNMI_MODEL)return knmiSurface(t);
    return rawSurface(model,t);
  }'''
    s = replace_once(s, dmi_surface_tail, knmi_surface_tail, "KNMI surface")

    s = replace_once(
        s,
        "    return [{id:DMI_MODEL,name:'DMI HARMONIE-AROME 2 km'},...base];",
        "    return [{id:DMI_MODEL,name:'DMI HARMONIE-AROME 2 km'},{id:KNMI_MODEL,name:'KNMI HARMONIE-AROME Europe 5.5 km'},...base];",
        "model definitions",
    )

    old_type = r'''  function typeFromMechanisms(models){
    const keys=['RAD','ADV','CBL','PCP'],v={};
    for(const k of keys)v[k]=mean(models.map(m=>m[k]));'''
    new_type = r'''  function leadBucketName(h){
    if(!finite(h)||h<0)return null;
    if(h<3)return '0-3h';if(h<6)return '3-6h';if(h<12)return '6-12h';
    if(h<24)return '12-24h';if(h<48)return '24-48h';return '48-120h';
  }
  function fogModelWeight(modelId,lead){
    if(modelId===DMI_MODEL)return lead<=12?.16:.10;
    if(modelId===KNMI_MODEL)return lead<=12?.11:.07;
    const bucket=leadBucketName(lead),m=adaptiveWeights?.models?.[modelId],row=bucket?m?.lead_buckets?.[bucket]:null;
    let base=n(m?.base_weight);
    if(!finite(base)){
      const d=(typeof MODELS!=='undefined'?MODELS:[]).find(x=>x.id===modelId);base=n(d?.w)??.06;
    }
    const prefs=[['visibility',.35],['dew_point',.20],['cloud',.20],['wind',.15],['temperature',.10]];
    const parts=prefs.map(([k,w])=>({v:n(row?.components?.[k]?.weight_factor),w}));
    const factor=weightedAvailable(parts).v??n(row?.weight_factor)??1;
    return clip(base*factor,.015,.25);
  }
  function weightedModelMean(models,key,lead){
    let sw=0,s=0;for(const m of models){const v=n(m?.[key]),w=fogModelWeight(m.id,lead);if(finite(v)&&finite(w)&&w>0){s+=v*w;sw+=w}}
    return sw?s/sw:null;
  }
  function weightedModelMedian(models,key,lead){
    const a=models.map(m=>({v:n(m?.[key]),w:fogModelWeight(m.id,lead)})).filter(x=>finite(x.v)&&finite(x.w)&&x.w>0).sort((a,b)=>a.v-b.v);
    const total=a.reduce((q,x)=>q+x.w,0);if(!total)return null;let c=0;for(const x of a){c+=x.w;if(c>=total/2)return x.v}return a[a.length-1]?.v??null;
  }
  function typeFromMechanisms(models,lead){
    const keys=['RAD','ADV','CBL','PCP'],v={};
    for(const k of keys)v[k]=weightedModelMean(models,k,lead);'''
    s = replace_once(s, old_type, new_type, "adaptive fog helpers")

    old_ensemble_head = r'''    const phys=mean(models.map(m=>m.PHYS)),nwp=mean(models.map(m=>m.MODEL));
    const scores=models.map(m=>m.MODEL).filter(finite),sdm=stddev(scores);
    const agree=finite(sdm)?1-clip(sdm/35,0,1):(scores.length===1?.35:null);
    const obs=obsForLead(t),lead=Math.max(0,(t-Date.now())/HOUR);
    const obsTrend=obs?.trend??null;
    let final;
    if(lead<=3)final=weightedAvailable([{v:obs?.score??null,w:.30},{v:null,w:.25},{v:phys,w:.25},{v:nwp,w:.20}]);
    else if(lead<=6)final=weightedAvailable([{v:obsTrend,w:.15},{v:null,w:.15},{v:phys,w:.35},{v:nwp,w:.35}]);
    else if(lead<=12)final=weightedAvailable([{v:phys,w:.45},{v:nwp,w:.45},{v:obsTrend,w:.10}]);
    else final=weightedAvailable([{v:phys,w:.50},{v:nwp,w:.50}]);'''
    new_ensemble_head = r'''    const obs=obsForLead(t),lead=Math.max(0,(t-Date.now())/HOUR);
    const phys=weightedModelMean(models,'PHYS',lead),nwp=weightedModelMean(models,'MODEL',lead);
    const scores=models.map(m=>m.MODEL).filter(finite),sdm=stddev(scores);
    const agree=finite(sdm)?1-clip(sdm/35,0,1):(scores.length===1?.35:null);
    const obsTrend=obs?.trend??null;
    const directFog=weightedModelMean(models.filter(m=>finite(m.directFog)),'directFog',lead);
    let final;
    if(lead<=3)final=weightedAvailable([{v:obs?.score??null,w:.25},{v:directFog,w:.20},{v:phys,w:.30},{v:nwp,w:.25}]);
    else if(lead<=6)final=weightedAvailable([{v:obsTrend,w:.12},{v:directFog,w:.18},{v:phys,w:.35},{v:nwp,w:.35}]);
    else if(lead<=12)final=weightedAvailable([{v:directFog,w:.12},{v:phys,w:.39},{v:nwp,w:.39},{v:obsTrend,w:.10}]);
    else final=weightedAvailable([{v:directFog,w:.06},{v:phys,w:.47},{v:nwp,w:.47}]);'''
    s = replace_once(s, old_ensemble_head, new_ensemble_head, "weighted ensemble head")

    s = replace_once(
        s,
        "    const sat=mean(models.map(m=>mean([m.components.SD,m.components.SRH])));",
        "    const sat=weightedAvailable(models.map(m=>({v:mean([m.components.SD,m.components.SRH]),w:fogModelWeight(m.id,lead)}))).v;",
        "weighted saturation",
    )

    old_prob = r'''    const modelProb = thr => visModels.length?100*visModels.filter(m=>m.VIS<thr).length/visModels.length:null;'''
    new_prob = r'''    const modelProb = thr => {
      let hit=0,total=0;for(const m of visModels){const w=fogModelWeight(m.id,lead);total+=w;if(m.VIS<thr)hit+=w}
      return total?100*hit/total:null;
    };'''
    s = replace_once(s, old_prob, new_prob, "weighted visibility probability")

    s = replace_once(
        s,
        "    const visVals=visModels.map(m=>m.VIS).filter(finite).sort((a,b)=>a-b);\n    let vis=visVals.length?visVals[Math.floor((visVals.length-1)/2)]:null;",
        "    let vis=weightedModelMedian(visModels,'VIS',lead);",
        "weighted visibility median",
    )
    s = replace_once(s, "    const type=typeFromMechanisms(models);", "    const type=typeFromMechanisms(models,lead);", "weighted mechanism type")
    s = replace_once(s, "    const T=mean(models.map(m=>m.T));", "    const T=weightedModelMean(models,'T',lead);", "weighted temperature")

    s = s.replace(
        "MTG FCI: brak automatycznego pola (waga usunięta i zrenormalizowana)",
        "DMI fog 2 m aktywne · KNMI HARMONIE aktywne gdy dostępne",
    )

    P.write_text(s, encoding="utf-8")
    print("fog learning upgrade applied")


if __name__ == "__main__":
    main()
