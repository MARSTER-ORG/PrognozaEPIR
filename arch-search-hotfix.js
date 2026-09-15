'use strict';
(() => {
  const base=window.PrognozaEPIRMessageArchive;
  if(!base)return;
  const ADVANCED_KEYS=['text','visibility_min','visibility_max','ceiling_min_ft','ceiling_max_ft','wind_speed_min_kt','wind_speed_max_kt','gust_min_kt','gust_max_kt','wind_dir_from','wind_dir_to','temp_min_c','temp_max_c','qnh_min','qnh_max','flags'];
  const allowed=new Set(['METAR','SPECI','TAF','SYNOP']);
  const norm=v=>String(v||'').toUpperCase();
  const onArch=()=>/\/arch\.html$/i.test(location.pathname);
  const typesOf=f=>(Array.isArray(f?.types)?f.types:String(f?.type||'').split(',')).map(norm).filter(t=>allowed.has(t));
  const rowTime=r=>{for(const k of ['archive_time','message_time','obs_time','issue_time','time','timestamp']){const t=Date.parse(r?.[k]||'');if(Number.isFinite(t))return t}return-Infinity};
  function prepare(filters={}){
    const f={...filters};
    if(Array.isArray(f.types))f.types=f.types.map(norm).filter(t=>allowed.has(t));
    if(f.type)f.type=norm(f.type);
    if(f.station)f.station=norm(f.station);
    if(onArch()&&document.getElementById('advanced')?.hidden){
      for(const key of ADVANCED_KEYS)delete f[key];
    }
    const types=typesOf(f);
    if(types.length===1&&types[0]==='SYNOP')f.station='12342';
    return f;
  }
  function mergeResults(parts,f){
    const seen=new Set(),rows=[];
    for(const part of parts){for(const r of part?.rows||[]){const key=String(r?.message_id||`${norm(r?.type||r?.report_type)}|${norm(r?.station)}|${r?.canonical_raw||r?.raw||''}`);if(seen.has(key))continue;seen.add(key);rows.push(r)}}
    const asc=String(f.sort||'desc').toLowerCase()==='asc';rows.sort((a,b)=>(asc?1:-1)*(rowTime(a)-rowTime(b)));
    const offset=Math.max(0,Number(f.offset)||0),limit=Math.max(1,Math.min(5000,Number(f.limit)||500));
    return{ok:true,schema:'prognozaepir-message-archive-search-ui-v4',rows:rows.slice(offset,offset+limit),count:rows.length,offset,limit,fallback:parts.some(x=>x?.fallback)};
  }
  async function search(filters={},force=false){
    const f=prepare(filters),types=typesOf(f),station=norm(f.station);
    if(onArch()&&station&&types.includes('SYNOP')&&types.some(t=>t!=='SYNOP')){
      const common={...f,offset:0,limit:5000};
      const aviationTypes=types.filter(t=>t!=='SYNOP');
      const [aviation,synop]=await Promise.all([
        base.search({...common,types:aviationTypes,station},force),
        base.search({...common,types:['SYNOP'],station:'12342'},force)
      ]);
      return mergeResults([aviation,synop],f);
    }
    return base.search(f,force);
  }
  const synopStation=(type,station)=>norm(type)==='SYNOP'?'12342':station;
  const api=Object.freeze({...base,
    search,
    getRange:(type,station='',from='',to='',limit=5000,force=false)=>base.getRange(type,synopStation(type,station),from,to,limit,force),
    getLatest:(type,station='',force=false)=>base.getLatest(type,synopStation(type,station),force),
    getRecent:(type,station='',limit=0,force=false)=>base.getRecent(type,synopStation(type,station),limit,force)
  });
  window.PrognozaEPIRMessageArchive=api;
  window.dispatchEvent(new CustomEvent('prognozaepir:archive-search-hotfix-ready'));
})();
