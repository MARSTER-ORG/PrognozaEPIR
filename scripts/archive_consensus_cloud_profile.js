#!/usr/bin/env node
'use strict';
/* Future-only EPIR consensus cloud evidence from each server-side model snapshot.
 * This captures pressure-level profile + 0–450 m and cloud-base diagnostics.
 * Reconstructed with archived model weights; not a historical browser replay.
 */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const cloudBands=require('../meteogram-cloud-bands.js');
const cloudCalibration=require('../cloud-consensus-calibration.js');
function read(p){try{return JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));}catch(_){return null;}}
const snapshot=read('data/runtime/models-latest.json');
if(snapshot?.schema!=='prognozaepir-model-snapshot-v1')throw Error('missing valid model snapshot');
const adapted=read('data/learning/adaptive-weights.json');
const skill=read('data/learning/cloud-skill.json');
const cal=read('data/learning/consensus-cloud-calibration.json');
if(cal?.schema==='prognozaepir-consensus-cloud-calibration-v1')cloudCalibration.setCalibrationForTest(cal);
const issued=Date.parse(snapshot.generated_at);
if(!Number.isFinite(issued))throw Error('invalid snapshot run timestamp');
const HOUR=3600000;
function finite(v){return typeof v==='number'&&Number.isFinite(v);}
function weight(v,fallback=1){return finite(v)&&v>0?v:fallback;}
function toDate(s){return Date.parse(s.endsWith('Z')?s:s+'Z');}
function bucket(h){return h<3?'0-3h':h<6?'3-6h':h<12?'6-12h':h<24?'12-24h':h<48?'24-48h':'48-120h';}
function sample(hourly,i,key){const v=hourly[key]?.[i];return finite(v)?v:null;}
function avg(items,key,wKey){
 let sum=0,weightSum=0;
 for(const i of items){
   const v=sample(i.hourly,i.index,key);
   const w=i[wKey];
   if(finite(v)&&finite(w)&&w>0){sum+=v*w;weightSum+=w;}
 }
 return weightSum?sum/weightSum:null;
}
const modelMap=[];
for(const [modelId,model] of Object.entries(snapshot.models||{})){
 const hourly=model.hourly||{};
 if(!Array.isArray(hourly.time))continue;
 const times=new Map();
 hourly.time.forEach((s,i)=>{const t=toDate(s);if(Number.isFinite(t))times.set(t,i)});
 modelMap.push({modelId,model,hourly,times});
}
const validTimes=[...new Set(modelMap.flatMap(m=>[...m.times.keys()]))].sort((a,b)=>a-b)
 .filter(t=>{
   const lead=(t-issued)/HOUR;
   return lead>0&&lead<=120&&(lead<=12||lead<=48&&Math.abs(t%(3*HOUR))<1000||Math.abs(t%(6*HOUR))<1000);
 });
if(!modelMap.length||!validTimes.length)throw Error('no eligible future hours in snapshot');
const rows=[];
for(const t of validTimes){
 const lead=(t-issued)/HOUR,b=bucket(lead),items=[];
 for(const m of modelMap){
   const index=m.times.get(t);
   if(index===undefined)continue;
   const weightBase=weight(m.model.base_weight,0);
   if(!weightBase)continue;
   const a=adapted?.models?.[m.modelId]?.lead_buckets?.[b];
   const aFactor=Math.max(.70,Math.min(1.30,weight(a?.weight_factor)));
   const cloudComponent=weight(a?.components?.cloud?.weight_factor,aFactor);
   const cloudSkill=weight(skill?.models?.[m.modelId]?.lead_buckets?.[b]?.weight_factor);
   const overall=weightBase*aFactor;
   const cloudWeight=overall*cloudSkill*Math.max(.70/1.30,Math.min(1.30/.70,cloudComponent/aFactor));
   items.push({...m,index,w:overall,cw:cloudWeight});
 }
 if(items.length<2)continue;
 const terrain=items.reduce((a,i)=>a+(finite(i.model.elevation)?i.model.elevation*i.w:0),0)/
   (items.reduce((a,i)=>a+(finite(i.model.elevation)?i.w:0),0)||1);
 const levels=new Set();
 for(const i of items)for(const k of Object.keys(i.hourly))
   if(/^cloud_cover_\d+hPa$/.test(k))levels.add(Number(k.slice(12,-3)));
 const profile=[];
 for(const p of [...levels].sort((a,b)=>b-a)){
   const cc=avg(items,'cloud_cover_'+p+'hPa','cw');
   const geop=avg(items,'geopotential_height_'+p+'hPa','cw');
   if(!finite(cc)||!finite(geop))continue;
   const agl=geop-terrain;
   if(agl>=0&&agl<=16000)profile.push({agl:Math.round(agl),cc:+cc.toFixed(2)});
 }
 const diagnostics=cloudBands.fromProfile(profile);
 const rawTotal=avg(items,'cloud_cover','cw');
 const rawMid=avg(items,'cloud_cover_mid','cw');
 const calibrated=cloudCalibration.apply({totalPct:rawTotal,midPct:rawMid,targetMs:t,nowMs:issued});
 const quality=diagnostics.veryLowQuality;
 rows.push({
   schema:'prognozaepir-archived-cloud-consensus-v1',
   run_time:new Date(issued).toISOString(),valid_time:new Date(t).toISOString(),
   lead_hours:+lead.toFixed(2),lead_bucket:b,station:'EPIR',
   models:items.length,source:'GitHub Actions model-snapshot; approximate runtime cloud weights',
   total_cloud_pct:rawTotal===null?null:+rawTotal.toFixed(2),
   mid_cloud_pct:rawMid===null?null:+rawMid.toFixed(2),
   total_okta_calibrated:calibrated.total.applied?calibrated.total.okta:null,
   mid_okta_calibrated:calibrated.mid.applied?calibrated.mid.okta:null,
   calibration_generated_at:calibrated.generated_at,
   profile_coverage_okta:diagnostics.coverage,
   very_low_quality:quality,
   lowest_profile_m_agl:diagnostics.lowestLevelM,
   first_bkn_base_m_agl:quality==='unknown'?null:diagnostics.bases.bkn,
   first_sct_base_m_agl:quality==='unknown'?null:diagnostics.bases.sct,
   first_few_base_m_agl:quality==='unknown'?null:diagnostics.bases.few,
   // Profile points allow subsequent recalibration without fabricated lower layers.
   profile
 });
}
const date=new Date(issued).toISOString().slice(0,10);
const dir=path.join(root,'data/learning/consensus-cloud-forecasts');
fs.mkdirSync(dir,{recursive:true});
const out=path.join(dir,date+'.jsonl');
const old=fs.existsSync(out)?fs.readFileSync(out,'utf8').split('\n').filter(Boolean):[];
const known=new Set(old.flatMap(x=>{try{const j=JSON.parse(x);return [j.run_time+'|'+j.valid_time];}catch{return [];}}));
const extra=rows.filter(x=>!known.has(x.run_time+'|'+x.valid_time)).map(x=>JSON.stringify(x));
if(extra.length)fs.appendFileSync(out,extra.join('\n')+'\n');
console.log(JSON.stringify({file:path.relative(root,out),new_rows:extra.length,models:modelMap.length,valid_hours:validTimes.length,
  observed_very_low_supported:rows.filter(r=>r.very_low_quality==='supported').length,
  observed_very_low_partial:rows.filter(r=>r.very_low_quality==='partial').length}));
