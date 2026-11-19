'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Test real production fallback routing, selection and export, not a duplicate
// algorithm. The meterology/ensemble kernel has separate regression coverage.
const fog = fs.readFileSync(path.join(__dirname,'..','fog-engine.js'),'utf8');
const bridge = fs.readFileSync(path.join(__dirname,'..','fog-index-bridge.js'),'utf8');
const pick = (src,begin,end) => {
  const a=src.indexOf(begin), b=src.indexOf(end,a+begin.length);
  assert(a>=0&&b>a, 'Missing source boundary: '+begin);
  return src.slice(a,b);
};
const pieces = [
  pick(fog,'  function normalizeConsensusForecast(rows) {','  function historyInput('),
  pick(fog,'  function modelDefinitions(){','  function leadBucketName('),
  pick(fog,'  function rebuildEngine(){','  function onsetAndDissipation('),
];
assert(bridge.includes('publishRealConsensus(cw);'));
assert(bridge.includes('consensus.map(r=>'));
assert(bridge.includes('modelCount:numeric(r?.modelCount)'));

const script = `
  const HOUR=3600e3,finite=Number.isFinite;
  const CONSENSUS_FALLBACK_MODEL='prognozaepir_consensus_actual_nwp';
  const DMI_MODEL='dmi_harmonie_arome_europe',KNMI_MODEL='knmi_harmonie_arome_europe';
  const MODELS=[],datasets=new Map();
  let dmiRows=[],knmiRows=[],consensusFallbackRows=[],fogSeries=[];
  let engineError='',recoveryTimer=null,recoveryAttempt=0;
  const window={};
  window.dispatchEvent=()=>{};
  const n=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);
  const nearest=(arr,t,max)=>arr.reduce((best,row)=>{
    const d=Math.abs(row.t-t);
    return d<=max&&(!best||d<Math.abs(best.t-t))?row:best;
  },null);
  const dmiSurface=t=>dmiRows.length?{id:DMI_MODEL,t,T:6,Td:5,RH:90,WS:2,VIS:8000}:null;
  const knmiSurface=()=>null;
  const rawSurface=()=>null;
  const renderFog=()=>{};
  const clearTimeout=()=>{};
  class CustomEvent{constructor(name){this.type=name}}
  const ensembleAt=t=>{
    const inputs=modelDefinitions().map(m=>modelInput(m,t)).filter(Boolean);
    return inputs.length?{t,score:15,models:inputs}:null;
  };
  ${pieces.join('\n')}
  globalThis.__test = {window, modelDefinitions, rebuildEngine,
    setDmi:rows=>{dmiRows=rows;}, getFog:()=>fogSeries};
`;
const ctx={Date,Number,Math,Array,Map,console};
vm.runInNewContext(script,ctx,{timeout:3000});
const api=ctx.__test;
assert.equal(api.window.PrognozaEPIRFogLegacyFallback.ingest([]),false);
assert.equal(api.window.PrognozaEPIRFogLegacySeries,undefined,
  'never invent a series when no real forecast is present');
const hour=3600e3,base=Math.floor(Date.now()/hour)*hour;
const rows=Array.from({length:61},(_,i)=>({
  t:base-3*hour+i*hour,modelCount:5,T:5,Td:4.2,RH:93,WS:2.3,WD:240,
  VIS:6500,RR:0,low:37,mid:20,high:30,ceiling:900
}));
assert.equal(api.window.PrognozaEPIRFogLegacyFallback.ingest(rows),true);
assert.equal(api.window.PrognozaEPIRFogLegacySeries.length,49);
assert.equal(api.window.PrognozaEPIRFogLegacySeries[0].fogEngineSource,
  'legacy-consensus-nwp-fallback');
assert.equal(api.window.PrognozaEPIRFogLegacySeries[0].fogEngineFallback,true);
assert.equal(api.window.PrognozaEPIRFogLegacySeries[0].models[0].T,5);
assert.equal(api.window.PrognozaEPIRFogLegacySeries[0].models[0].VIS,6500);
assert.equal(api.window.PrognozaEPIRFogLegacySourceStatus.ready,true);
assert.equal(api.window.PrognozaEPIRFogLegacySourceStatus.consensusRows,61);

// Reject absent source provenance, invalid meteorological fields, stale data.
assert.equal(api.window.PrognozaEPIRFogLegacyFallback.ingest(
  rows.map(r=>({...r,modelCount:0}))),false);
assert.equal(api.window.PrognozaEPIRFogLegacyFallback.ingest(
  rows.map(r=>({...r,T:null}))),false);
assert.equal(api.window.PrognozaEPIRFogLegacyFallback.ingest(
  rows.map(r=>({...r,t:r.t-200*hour}))),false);
assert.equal(api.window.PrognozaEPIRFogLegacySeries.length,49,
  'invalid input must not replace previously verified data');

// Once a specialist provider returns, remove fallback from the active model.
api.setDmi([{t:base}]);api.rebuildEngine();
assert.equal(api.window.PrognozaEPIRFogLegacySeries[0].fogEngineSource,'legacy');
assert.equal(api.window.PrognozaEPIRFogLegacySeries[0].fogEngineFallback,false);
assert.equal(api.modelDefinitions().some(m=>m.id==='prognozaepir_consensus_actual_nwp'),false);
console.log('Fog LEGACY actual-NWP consensus bridge regression: OK');
