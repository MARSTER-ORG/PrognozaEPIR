'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'epir-cloud-profile-'));
try {
 const issue='2026-11-06T09:15:00Z';
 const times=['2026-11-06T08:00','2026-11-06T10:00','2026-11-06T11:00','2026-11-06T12:00'];
 const hourly={time:times,cloud_cover:[10,75,80,70],cloud_cover_mid:[10,30,40,50]};
 for(const [p,z,cc] of [[1000,150,80],[950,430,85],[925,750,40],[850,1600,25],[700,3100,30],[500,5900,15],[300,10000,0]]){
  hourly['cloud_cover_'+p+'hPa']=[cc,cc,cc,cc];
  hourly['geopotential_height_'+p+'hPa']=[z,z,z,z];
 }
 const obj={schema:'prognozaepir-model-snapshot-v1',generated_at:issue,
  models:{m1:{base_weight:.6,elevation:100,hourly},m2:{base_weight:.4,elevation:100,hourly}}};
 const target=path.join(tmp,'data','runtime','models-latest.json');
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(obj));
 const runner=path.join(__dirname,'..','scripts','archive_consensus_cloud_profile.js');
 const run=()=>cp.spawnSync(process.execPath,[runner],{encoding:'utf8',env:{...process.env,EPIR_CLOUD_ARCHIVE_ROOT:tmp}});
 const one=run();
 assert.equal(one.status,0,one.stderr);
 const out=path.join(tmp,'data','learning','consensus-cloud-forecasts','2026-11-06.jsonl');
 const rows=fs.readFileSync(out,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,3,'ignore pre-issue forecast validity');
 assert.equal(rows[0].models,2);
 assert.equal(rows[0].very_low_quality,'supported');
 assert.ok(rows[0].profile_coverage_okta.veryLow>=5);
 assert.ok(rows[0].first_bkn_base_m_agl!==null);
 assert.equal(rows[0].total_cloud_pct,75);
 assert.equal(rows[0].total_okta_calibrated,null,'without validated calibration use raw and mark null');
 const twice=run();
 assert.equal(twice.status,0,twice.stderr);
 assert.equal(fs.readFileSync(out,'utf8').trim().split('\n').length,3,'idempotent snapshot refresh');
 console.log('server snapshot cloud archival and 0–450 m diagnostics: OK');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
