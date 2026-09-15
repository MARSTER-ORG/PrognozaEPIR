'use strict';
const assert=require('assert');
const F=require('../fog-physics-vnext.js');
const finiteDeep=o=>{
  if(o===null||o===undefined)return true;
  if(typeof o==='number')return Number.isFinite(o);
  if(Array.isArray(o))return o.every(finiteDeep);
  if(typeof o==='object')return Object.values(o).every(finiteDeep);
  return true;
};
const base={t:8,td:7.5,rh:96,ws:1.2,isDay:0,inversion:1.4,lowCloud:8,cloudCover:12,shortwave:0,deltaSpread3:-.8,deltaRh3:5,precip:0,cbh:900,cbhDrop3:0};

// 1. Clear night + weak wind + wet soil + falling PBL + cold surface => strong RAD.
const favorable=F.evaluateHour({...base,soilIcon01:.38,soilIcon13:.36,pbl:170,deltaPbl1:-90,deltaPbl3:-260,tsurface:5.8,deltaSurfaceCooling1:.5,deltaSurfaceCooling3:1.3,deltaTsurface3:-2.1});
assert(favorable.RAD>0.65,favorable);

// 2. Same night, very dry soil => lower RAD, but soil alone is only a modulator.
const dry=F.evaluateHour({...base,soilIcon01:.08,soilIcon13:.09,pbl:170,deltaPbl1:-90,deltaPbl3:-260,tsurface:5.8,deltaSurfaceCooling1:.5,deltaSurfaceCooling3:1.3,deltaTsurface3:-2.1});
assert(dry.RAD<favorable.RAD,{dry:dry.RAD,wet:favorable.RAD});

// 3. High RH but strong wind and high PBL must not over-alert RAD.
const mixed=F.evaluateHour({...base,ws:8,pbl:1300,deltaPbl1:80,deltaPbl3:180,soilIcon01:.35,tsurface:7.8,deltaTsurface3:0});
assert(mixed.RAD<0.5,mixed);

// 4. Low PBL but large T-Td must not create false FG-like RAD.
const unsat=F.evaluateHour({...base,t:12,td:5,rh:55,pbl:120,deltaPbl1:-100,deltaPbl3:-300,soilIcon01:.40,tsurface:8,deltaTsurface3:-2});
assert(unsat.RAD<=0.34,unsat);

// 5. Missing real soil moisture after precipitation => precip proxy fallback.
const proxy=F.soilMoisture({precip12:2.4});
assert.equal(proxy.source,'precip proxy');assert.equal(proxy.fallback,true);assert(proxy.value>.9);

// 6. Missing ECMWF PBL: engine still works and returns finite available signals.
const noPbl=F.evaluateHour({...base,soilIcon01:.3,tsurface:6.5,deltaTsurface3:-1});
assert.equal(noPbl.SPBL,null);assert(Number.isFinite(noPbl.RAD));

// 7. Missing ICON soil moisture: use ECMWF before precip proxy.
const ecmwf=F.soilMoisture({ecmwf07:.31,precip12:3});
assert.equal(ecmwf.source,'ECMWF');assert.equal(ecmwf.fallback,false);

// 8. No new parameters => legacy operational score remains exactly unchanged.
const legacy={score:63,RAD:61,type:{text:'radiacyjna'}};
const preserved=F.enhanceLegacyHour(legacy,{...base,precip12:null,tsurface:null,pbl:null,soilIcon01:null,soilIcon13:null,soilEcmwf07:null});
assert.equal(preserved.score,63);assert.equal(preserved.fogScoreVNextShadow,63);assert.equal(preserved.vnextShadowActive,false);

// 9. Full data -> correct coverage and missing-data renormalization.
assert(favorable.dataQuality>0.7,favorable.dataQuality);assert(Number.isFinite(favorable.SSOIL)&&Number.isFinite(favorable.SPBL)&&Number.isFinite(favorable.SSFC_COOL));
const weightedFull=F.weightedAvailable([{v:.2,w:.2},{v:.8,w:.8}]);
const weightedMissing=F.weightedAvailable([{v:null,w:.2},{v:.8,w:.8}]);
assert(Math.abs(weightedFull.value-.68)<1e-12,weightedFull);
assert(Math.abs(weightedMissing.value-.8)<1e-12,weightedMissing);
assert(Math.abs(weightedMissing.coverage-.8)<1e-12,weightedMissing);

// 10. No NaN/Infinity anywhere in populated output.
assert(finiteDeep(favorable));assert(finiteDeep(mixed));

// 11. Lowering Stratus should raise CBL even without classic RAD setup.
const cbl=F.evaluateHour({t:8,td:7.3,rh:95,ws:3.2,isDay:1,pbl:260,deltaPbl3:-80,cbh:90,cbhDrop3:520,lowCloud:98,cloud2m:82,tsurface:8.2});
assert(cbl.CBL>0.75,cbl);

// 12. Stronger wind must not automatically zero ADV.
assert(F.windAdvSignal(6)>0.8,F.windAdvSignal(6));assert(F.windAdvSignal(6)>F.windRadSignal(6,'pre-onset'));

// 13. Mature fog uses a different turbulence/wind response than pre-onset.
assert(F.windRadSignal(4,'mature')>F.windRadSignal(4,'pre-onset'));

// Wet-bulb, soil temperature and T5cm are diagnostic inputs, not independent fog votes.
const extraDiagnostics=F.evaluateHour({...base,soilIcon01:.32,pbl:220,tsurface:6.2,deltaTsurface3:-1.5,wetBulb:0,soilTemperature0:-20,soilTemperature6:30,t5cmObs:-15});
const withoutExtraDiagnostics=F.evaluateHour({...base,soilIcon01:.32,pbl:220,tsurface:6.2,deltaTsurface3:-1.5});
for(const k of ['RAD','ADV','CBL','PCP'])assert.equal(extraDiagnostics[k],withoutExtraDiagnostics[k],k);

// Separate dissipation engine: warming + PBL rise + drying must produce a signal.
const diss=F.dissipationSignal({deltaTsurface3:2.5,deltaPbl3:420,deltaSpread3:1.5,deltaRh3:-10,cbhRise3:400,windChange3:2,shortwave:220});
assert(diss.value>0.65,diss);

console.log('fog physics vNext tests: OK');
