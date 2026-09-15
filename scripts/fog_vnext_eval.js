'use strict';
const fs=require('fs');
const path=require('path');
const F=require('../fog-physics-vnext.js');
const P=require('../fog-vnext-probability-layer.js');
const T=require('../fog-vnext-transition-risk.js');

function readPriors(){
  const p=path.join(__dirname,'..','data','learning','fog-transition-priors-vnext.json');
  try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(_){return null;}
}

function main(){
  const raw=fs.readFileSync(0,'utf8').trim();
  const rows=raw?JSON.parse(raw):[];
  const priors=readPriors();
  const out=rows.map(input=>{
    const v=F.evaluateHour(input||{});
    const p=P.evaluate(input||{},v);
    const tr=T.evaluate(input||{},v,p,priors);
    return {
      RAD:Number.isFinite(v.RAD)?v.RAD*100:null,
      ADV:Number.isFinite(v.ADV)?v.ADV*100:null,
      CBL:Number.isFinite(v.CBL)?v.CBL*100:null,
      PCP:Number.isFinite(v.PCP)?v.PCP*100:null,
      physics_score:Number.isFinite(p.P_physics)?p.P_physics*100:null,
      direct_score:Number.isFinite(p.P_direct)?p.P_direct*100:null,
      model_final_shadow:Number.isFinite(p.P_model_final_shadow)?p.P_model_final_shadow*100:null,
      P_physics:p.P_physics,
      P_direct:p.P_direct,
      P_model_final_shadow:p.P_model_final_shadow,
      probability_calibrated:p.calibrated,
      probability_calibration_status:p.calibrationStatus,
      mechanism1:p.mechanism1,
      mechanism2:p.mechanism2,
      blend_weights:p.blendWeights,
      lead_bucket_shadow:p.leadBucket,
      SSOIL:Number.isFinite(v.SSOIL)?v.SSOIL*100:null,
      SPBL:Number.isFinite(v.SPBL)?v.SPBL*100:null,
      SSFC_COOL:Number.isFinite(v.SSFC_COOL)?v.SSFC_COOL*100:null,
      dissipation:Number.isFinite(v.dissipationRisk)?v.dissipationRisk*100:null,
      observed_state_shadow:tr.state,
      onset_risk_shadow:Number.isFinite(tr.onsetRiskShadow)?tr.onsetRiskShadow*100:null,
      onset_historical_prior:Number.isFinite(tr.onsetHistoricalPrior)?tr.onsetHistoricalPrior*100:null,
      onset_confidence:Number.isFinite(tr.onsetConfidence)?tr.onsetConfidence:null,
      onset_window_shadow:tr.onsetWindow,
      dissipation_risk_shadow:Number.isFinite(tr.dissipationRiskShadow)?tr.dissipationRiskShadow*100:null,
      dissipation_historical_prior:Number.isFinite(tr.dissipationHistoricalPrior)?tr.dissipationHistoricalPrior*100:null,
      dissipation_confidence:Number.isFinite(tr.dissipationConfidence)?tr.dissipationConfidence:null,
      dissipation_window_shadow:tr.dissipationWindow,
      transition_prior_source:tr.priorSource,
      transition_prior_samples:tr.priorSamples,
      transition_calibrated:tr.calibrated,
      phase:v.phase,
      data_quality:v.dataQuality,
      physics_coverage:p.physicsCoverage,
      direct_coverage:p.directCoverage,
      soil_source:v.soilMoistureSource,
      missing:v.missing,
      fallbacks:v.fallbacks,
    };
  });
  process.stdout.write(JSON.stringify(out));
}
main();
