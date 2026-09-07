'use strict';
(() => {
  const VERSION='TAF Archive Compatibility v2.0.0';
  const IDS=['EPIR','EPBY','EPPW','EPKS'];
  let lastBundle=null;

  const archive=()=>window.PrognozaEPIRMessageArchive;
  const normRaw=s=>{let x=String(s||'').replace(/\s+/g,' ').trim();return x&&!x.endsWith('=')?x+'=':x};

  function info(row){
    if(!row?.raw)return null;
    return {
      id:String(row.station||'').toUpperCase(),
      raw:normRaw(row.raw),
      issue:Date.parse(row.issue_time||row.message_time||0)||0,
      current:!row.stale,
      source:`ARCHIWUM · ${row.source||row.sources?.[0]?.name||'repo'}`,
      url:'data/messages',
      archive_id:row.message_id||null,
      snapshot_only:Boolean(row.snapshot_only)
    };
  }

  async function collect(force=false){
    const A=archive();
    if(!A)throw new Error('MessageArchive niedostępne');
    const latest=await A.latest(force),stations={};
    for(const id of IDS)stations[id]=info(latest?.taf_by_station?.[id]);
    const m=latest?.aviation||latest?.metar||null;
    const metar=m?.raw?{
      raw:normRaw(m.raw),
      source:`ARCHIWUM · ${m.source||m.sources?.[0]?.name||'repo'}`,
      t:Date.parse(m.obs_time||m.message_time||0)||0
    }:null;
    lastBundle={stations,metar,attempts:['MessageArchive'],updated:Date.now()};
    return lastBundle;
  }

  // Compatibility API only. It does not replace window.fetch and performs no
  // network acquisition. New generator code calls MessageArchive directly.
  window.PrognozaEPIRTAFSources={version:VERSION,collect,get last(){return lastBundle}};
})();
