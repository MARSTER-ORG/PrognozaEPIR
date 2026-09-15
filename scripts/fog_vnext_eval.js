'use strict';
const fs=require('fs');
const F=require('../fog-physics-vnext.js');

function main(){
  const raw=fs.readFileSync(0,'utf8').trim();
  const rows=raw?JSON.parse(raw):[];
  const out=rows.map(input=>{
    const v=F.evaluateHour(input||{});
    const ranked=[['RAD',v.RAD],['ADV',v.ADV],['CBL',v.CBL],['PCP',v.PCP]]
      .filter(x=>Number.isFinite(x[1])).sort((a,b)=>b[1]-a[1]);
    const physics=ranked.length?100*(.8*ranked[0][1]+.2*(ranked[1]?.[1]??ranked[0][1])):null;
    return {
      RAD:Number.isFinite(v.RAD)?v.RAD*100:null,
      ADV:Number.isFinite(v.ADV)?v.ADV*100:null,
      CBL:Number.isFinite(v.CBL)?v.CBL*100:null,
      PCP:Number.isFinite(v.PCP)?v.PCP*100:null,
      physics_score:Number.isFinite(physics)?physics:null,
      mechanism1:ranked[0]?.[0]||null,
      mechanism2:ranked[1]?.[0]||null,
      SSOIL:Number.isFinite(v.SSOIL)?v.SSOIL*100:null,
      SPBL:Number.isFinite(v.SPBL)?v.SPBL*100:null,
      SSFC_COOL:Number.isFinite(v.SSFC_COOL)?v.SSFC_COOL*100:null,
      dissipation:Number.isFinite(v.dissipationRisk)?v.dissipationRisk*100:null,
      phase:v.phase,
      data_quality:v.dataQuality,
      soil_source:v.soilMoistureSource,
      missing:v.missing,
      fallbacks:v.fallbacks,
    };
  });
  process.stdout.write(JSON.stringify(out));
}
main();
