'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const gate=require('../taf-ai-compose-guard-v1.js');
const day=Date.UTC(2026,10,11),H=3600000;
const meta={issue:day+5*H,start:day+6*H,end:day+18*H};
const base='TAF EPIR 110500Z 1106/1118 17006KT 9999 SCT020 BECMG 1110/1112 2000 BR BKN006=';
const expected='TAF EPIR 110500Z 1106/1118 17006KT 9999 SCT020 BECMG 1109/1111 2000 BR BKN006=';
const hours=Array.from({length:12},(_,i)=>{
  const t=meta.start+i*H,persistent=i>=5,alt=(i>=1&&i<=3);
  return {t,visM:persistent?2000:10000,tafDisplay:{
    wind:'17006KT',visibility:persistent?'2000':'9999',
    weather:persistent?'BR':'',clouds:persistent?'BKN006':'SCT020'},
    prob:{br:persistent?.72:.05,fg:alt?.38:.08,lowVis:alt?.38:.08,
      alt:{fgM:alt?500:null},lowCeiling:persistent?.7:.1},
    sourceRow:{fogAltVisM:alt?500:null}
  };
});
const validate=taf=>({ok:!taf.includes('PROB40'),errors:[]});
function evaluate(candidate,h=hours,v=validate){
  return gate.evaluate({baseTaf:base,candidateTaf:candidate,hourly:h,meta,validate:v});
}
let r=evaluate(expected);
assert.equal(r.accepted,true,'Grounded BECMG window adjustment should be adopted');
assert.equal(r.groups[0].kind,'BECMG');
assert.equal(r.checks.ok,true);
assert.equal(evaluate(base).reason,'unchanged');
assert.equal(evaluate(expected.replace('9999 SCT020','0300 FG SCT020')).reason,'base_or_header_changed');
assert.equal(evaluate(expected.replace('2000 BR BKN006','0200 FG BKN001')).reason,'unsubstantiated_forecast');
assert.equal(evaluate(expected.replace('BECMG 1109/1111','BECMG 1109/1115')).reason,'becmg_exceeds_preferred_window');
assert.equal(evaluate(expected,[],validate).accepted,false);
assert.equal(evaluate(expected,hours,()=>({ok:false,errors:['invalid']})).reason,'instruction_rejected');
const more='TAF EPIR 110500Z 1106/1118 17006KT 9999 SCT020 PROB30 1107/1109 0500 FG BECMG 1110/1112 2000 BR BKN006=';
r=evaluate(more);
assert.equal(r.accepted,true,'Grounded alternative PROB30 with 38% FG may be added');
assert.equal(evaluate(more.replace('0500 FG','0500 FZFG')).accepted,false);
assert.equal(evaluate(more.replace('PROB30 1107/1109','TEMPO 1107/1109')).reason,'tempo_without_subhourly_evidence');
assert.equal(evaluate(more.replace('PROB30 1107/1109','PROB30 1113/1115')).accepted,false);
assert.equal(evaluate('TAF EPIR 110500Z 1106/1118 17006KT 9999 SCT020=',hours).reason,'prevailing_transition_removed');
assert.equal(evaluate('TAF EPIR 110500Z 1106/1118 17006KT 9999 SCT020\nBECMG 1109/1111 2000 BR BKN006=').reason,'syntax');
const app=fs.readFileSync(path.join(__dirname,'../taf-app-v25.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../taf.html'),'utf8');
const srv=fs.readFileSync(path.join(__dirname,'../supabase/functions/taf-gemini/index.ts'),'utf8');
const ins=fs.readFileSync(path.join(__dirname,'../supabase/functions/taf-gemini/instruction.ts'),'utf8');
assert.ok(html.includes('taf-ai-compose-guard-v1.js'));
assert.ok(app.includes('gate.evaluate('));
assert.ok(app.includes('acceptedIntoDraft:adopted'));
assert.ok(app.includes("window.PrognozaEPIRTAFCurrentGenerated=verdict.taf"));
assert.ok(srv.includes("import { TAF_COMPOSITION_INSTRUCTION } from './instruction.ts'"));
assert.ok(ins.includes('BECMG')&&ins.includes('PROB30')&&ins.includes('TEMPO')&&ins.includes('800/1500/3000/5000'));
console.log('Gemini co-author grounding, TAF instruction, automatic integration: PASS');
