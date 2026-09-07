'use strict';
(() => {
  const VERSION='TAF Archive Source v1.0.0';
  const IDS=['EPIR','EPBY','EPPW','EPKS'];
  const IMGW_URL='https://awiacja.imgw.pl/metar-i-taf';
  const AWC_URL='https://aviationweather.gov/api/data/taf';
  const PROXY_FRAGMENT='/api/taf-proxy';
  const LEGACY_LATEST='data/observations/latest.json';
  const LEGACY_RECENT='data/observations/recent.json';
  const LEGACY_TAF='data/taf/neighbors.json';
  const nativeFetch=window.fetch.bind(window);
  let lastBundle=null;

  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const archive=()=>window.PrognozaEPIRMessageArchive;
  const normRaw=s=>{let x=String(s||'').replace(/\s+/g,' ').trim();return x&& !x.endsWith('=')?x+'=':x};

  function resolve(code,ref=Date.now(),minutes=false){
    if(!/^\d{4,6}$/.test(code))return null;
    const day=+code.slice(0,2),hour=+code.slice(2,4),minute=minutes?+code.slice(4,6):0,r=new Date(ref);let best=null,bd=Infinity;
    for(let dm=-1;dm<=1;dm++){const t=Date.UTC(r.getUTCFullYear(),r.getUTCMonth()+dm,day,hour,minute),d=Math.abs(t-ref);if(d<bd){bd=d;best=t}}
    return best;
  }
  function info(row){
    const raw=normRaw(row?.raw||row?.canonical_raw);if(!raw)return null;
    const sm=raw.match(/\bTAF(?:\s+(?:AMD|COR))?\s+([A-Z]{4})\b/i),im=raw.match(/\b(\d{6})Z\b/),vm=raw.match(/\b(\d{4})\/(\d{4})\b/);
    if(!sm||!im)return null;
    const issue=Date.parse(row?.issue_time||row?.message_time||'')||resolve(im[1],Date.now(),true);let vs=Date.parse(row?.valid_from||row?.valid_start||'')||null,ve=Date.parse(row?.valid_to||row?.valid_end||'')||null;
    if(!vs&&vm)vs=resolve(vm[1],issue,false);if(!ve&&vm){ve=resolve(vm[2],(vs||issue)+6*3600e3,false);if(vs&&ve<=vs)ve=resolve(vm[2],vs+18*3600e3,false)}
    const nil=/\bNIL\b/i.test(raw),age=(Date.now()-issue)/3600e3;
    return {id:sm[1].toUpperCase(),raw,issue,vs,ve,nil,current:age>=-1.5&&age<=10&&(nil||ve==null||ve>Date.now()-3600e3),source:`ARCHIWUM · ${row?.source||row?.sources?.[0]?.name||'repo'}`,url:'data/messages',archive_id:row?.message_id||null};
  }
  function select(rows,id){return rows.map(info).filter(x=>x&&x.id===id).sort((a,b)=>a.current!==b.current?(a.current?-1:1):b.issue-a.issue)[0]||null}

  async function collect(force=false){
    const [l,r]=await Promise.all([archive().latest(force),archive().recent(force)]),stations={};
    const tafRows=Array.isArray(r?.taf)?r.taf:[];
    for(const id of IDS){
      const preferred=l?.taf_by_station?.[id];
      stations[id]=preferred?info(preferred):select(tafRows,id);
    }
    const m=l?.aviation||l?.metar||null;
    const metar=m?.raw?{raw:normRaw(m.raw),source:`ARCHIWUM · ${m.source||m.sources?.[0]?.name||'repo'}`,t:Date.parse(m.obs_time||m.message_time||0)||0}:null;
    lastBundle={stations,metar,attempts:['central archive'],updated:Date.now()};
    renderSources(lastBundle);return lastBundle;
  }

  function synthetic(bundle){
    const lines=[];
    if(bundle.metar?.raw){const mr=bundle.metar.raw;lines.push(/^(?:METAR|SPECI)\b/i.test(mr)?mr:'METAR '+mr)}
    for(const id of IDS){const x=bundle.stations[id];if(!x)continue;if(id!=='EPIR'&&x.nil)continue;lines.push(x.raw)}
    return '<!doctype html><html><body><pre>'+esc(lines.join('\n'))+'</pre></body></html>';
  }
  function responseJson(value){return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}

  async function legacyNeighbors(force=false){
    const b=await collect(force),stations={};
    for(const id of IDS){const x=b.stations[id];if(x)stations[id]={raw:x.raw,source:x.source,updated_at:new Date(x.issue||Date.now()).toISOString(),source_url:'data/messages'};}
    return {schema:'prognozaepir-taf-neighbors-archive-v1',updated_at:new Date().toISOString(),stations};
  }

  async function intercepted(input,init){
    const url=typeof input==='string'?input:input?.url||'';
    try{
      if(url.includes(LEGACY_LATEST)) return responseJson(await archive().latest());
      if(url.includes(LEGACY_RECENT)) return responseJson(await archive().recent());
      if(url.includes(LEGACY_TAF)) return responseJson(await legacyNeighbors());
      if(url.startsWith(IMGW_URL)||url.startsWith(AWC_URL)||url.includes(PROXY_FRAGMENT)){
        const b=await collect();
        return new Response(synthetic(b),{status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
      }
    }catch(e){console.warn('TAF central archive bridge:',e)}
    return nativeFetch(input,init);
  }

  function renderSources(bundle){
    const body=document.getElementById('tafArchiveRows'),meta=document.getElementById('tafArchiveMeta');if(!body||!meta)return;
    body.innerHTML=IDS.map(id=>{const x=bundle.stations[id];return `<tr><td><b>${id}</b></td><td class="${x?.current?'ok':x?'warn':'bad'}">${x?.current?'AKTUALNY':x?'STARY CYKL':'BRAK'}</td><td>${esc(x?.source||'—')}</td><td>${esc(x?.raw||'brak')}</td></tr>`}).join('');
    meta.textContent=`${VERSION} · wyłącznie data/messages`;
  }
  function inject(){
    const grid=document.querySelector('.grid');if(!grid||document.getElementById('tafArchivePanel'))return;
    const project=[...grid.querySelectorAll('.card')].find(x=>x.querySelector('#taf'));
    const sec=document.createElement('section');sec.id='tafArchivePanel';sec.className='card w12';sec.innerHTML=`<h2>Centralne archiwum depesz</h2><div class="note">Generator nie pobiera TAF/METAR z internetu. Czyta wyłącznie wspólne archiwum <b>data/messages</b>. Import automatyczny i ręczny odbywa się poza podstroną, przez centralny importer.</div><div class="scroll" style="margin-top:8px"><table style="min-width:900px"><thead><tr><th>Stacja</th><th>Status</th><th>Źródło zapisu</th><th>TAF</th></tr></thead><tbody id="tafArchiveRows"><tr><td colspan="4">Ładowanie archiwum…</td></tr></tbody></table></div><div id="tafArchiveMeta" class="note" style="margin-top:5px">${VERSION}</div>`;
    project?.insertAdjacentElement('afterend',sec)||grid.prepend(sec);
    const old=document.getElementById('neighborSummary');if(old)old.textContent='TAF EPBY / EPPW / EPKS są odczytywane z centralnego archiwum.';
    collect().catch(e=>{const m=document.getElementById('tafArchiveMeta');if(m)m.textContent='Błąd archiwum: '+e.message});
  }

  window.fetch=intercepted;
  window.PrognozaEPIRTAFSources={version:VERSION,collect,get last(){return lastBundle}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',inject,{once:true});else inject();
})();
