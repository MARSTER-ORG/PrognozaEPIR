'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const calibration=JSON.parse(fs.readFileSync(path.join(root,'data/learning/visibility-nwp-calibration.json'),'utf8'));
const frozenTime=Date.parse(calibration.generated_at)+3600e3;

class FixedDate extends Date {
  constructor(...args){super(...(args.length?args:[frozenTime]));}
  static now(){return frozenTime;}
}
(async()=>{
  const win={};
  const context={
    window:win,Date:FixedDate,Number,Math,Promise,
    fetch:async()=>({ok:true,json:async()=>calibration}),
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'visibility-nwp-calibration.js'),'utf8'),context);
  const api=win.PrognozaEPIRVisibilityNwpCalibration;
  assert.equal(await api.load(),true,'calibration artifact loaded');
  assert.equal(api.status().pairs,calibration.pairs,'issued forecast verification cases');
  const night=Date.parse('2026-10-29T02:00:00Z');
  const day=Date.parse('2026-10-29T12:00:00Z');
  const raw=12000;
  if (calibration.groups.night_clear.n >= 40 && calibration.groups.night_clear.factor < 1)
    assert.ok(api.correct(raw,night,8000)<raw,'clear night NWP should be adjusted down');
  if (calibration.groups.day_clear.n >= 40 && calibration.groups.day_clear.factor < 1)
    assert.ok(api.correct(raw,day,8000)<raw,'clear daytime NWP should be adjusted down');
  assert.equal(api.correct(raw,night,4800),raw,'no override of a forecast fog/BR risk');
  assert.equal(api.correct(4800,day,8000),4800,'low NWP visibility untouched');
  assert.equal(api.correct(null,day,8000),null,'missing NWP untouched');

  const canvas={
    getContext:()=>null,
    _meta:null,
  };
  const document={
    getElementById:id=>id==='meteo'?canvas:null,
    querySelector:()=>null,
    addEventListener:()=>{},
  };
  const visWindow={document};
  const browser={
    window:visWindow,document,Number,Math,Date:FixedDate,Map,
    draw:()=>{},console,fetch:async()=>({ok:false,status:503}),
    setInterval:()=>0
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'meteogram-vis-comparison.js'),'utf8'),browser);
  const m=visWindow.PrognozaEPIRMeteogramVisComparison;
  assert.ok(m,'comparison module installed');
  const actual=m.normalize({
    metar_only:[
      {station:'EPIR',obs_time:'2026-10-28T19:00:00Z',visibility_m:8000,raw:'EPIR 281900Z 8000'},
      {station:'EPIR',obs_time:'2026-10-28T19:30:00Z',visibility_m:10000,raw:'EPIR 281930Z 9999'},
      {station:'EPKS',obs_time:'2026-10-28T19:00:00Z',visibility_m:100,raw:'EPKS 281900Z FG'},
    ],
    speci:[{station:'EPIR',obs_time:'2026-10-28T19:30:00Z',visibility_m:5000,
            raw:'EPIR 281930Z 5000 BR',report_type:'SPECI'}]
  });
  assert.equal(actual.length,2,'other stations and duplicate observation timestamps excluded');
  assert.equal(actual[0].vis,8000);
  assert.equal(actual[1].vis,5000,'SPECI has priority at equal time');
  assert.equal(actual[1].bounded,false,'5000 BR is exact');
  assert.equal(m.normalize({metar_only:[{station:'EPIR',obs_time:'2026-10-28T18:00:00Z',
    visibility_m:10000,visibility_lower_bound:true}]} )[0].bounded,true,'9999 is a lower bound');
  console.log('visibility calibration and METAR comparison regression tests: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
