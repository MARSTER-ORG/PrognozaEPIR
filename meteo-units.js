'use strict';
(() => {
  if(window.PrognozaEPIRUnits)return;
  const MPS_TO_KT=1.9438444924406;
  const KT_TO_MPS=0.5144444444444445;
  const M_TO_FT=3.2808398950131;
  const FT_TO_M=0.3048;
  const finite=v=>Number.isFinite(Number(v));
  const cv=(v,k)=>finite(v)?Number(v)*k:null;
  window.PrognozaEPIRUnits=Object.freeze({
    MPS_TO_KT,KT_TO_MPS,M_TO_FT,FT_TO_M,
    mpsToKt:v=>cv(v,MPS_TO_KT),
    ktToMps:v=>cv(v,KT_TO_MPS),
    mToFt:v=>cv(v,M_TO_FT),
    ftToM:v=>cv(v,FT_TO_M)
  });
})();
