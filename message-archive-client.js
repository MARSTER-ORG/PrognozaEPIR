'use strict';
(() => {
  const ROOT = 'data/messages';
  const TTL_MS = 30_000;
  const cache = new Map();

  async function fetchJson(name, force=false){
    const now=Date.now(), hit=cache.get(name);
    if(!force && hit && now-hit.at < TTL_MS) return hit.value;
    const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),5000);
    try{
      const url=`${ROOT}/${name}?v=${now}`;
      const r=await fetch(url,{cache:'no-store',signal:ctl.signal});
      if(!r.ok) throw new Error(`Archive ${name}: HTTP ${r.status}`);
      const value=await r.json();
      cache.set(name,{at:now,value});
      return value;
    } finally { clearTimeout(timer); }
  }

  const norm = v => String(v||'').toUpperCase();

  function strictLatest(payload,type,station){
    const t=norm(type), s=norm(station);
    if(t==='METAR'){
      const r=payload?.metar_only||null;
      return !s||norm(r?.station)===s?r:null;
    }
    if(t==='SPECI'){
      const r=payload?.speci||null;
      return !s||norm(r?.station)===s?r:null;
    }
    if(t==='SYNOP'){
      const r=payload?.synop||null;
      return !s||norm(r?.station)===s?r:null;
    }
    if(t==='TAF'){
      if(s) return payload?.taf_by_station?.[s]||null;
      return payload?.taf||null;
    }
    if(t==='AVIATION'){
      const r=payload?.aviation||payload?.metar||null;
      return !s||norm(r?.station)===s?r:null;
    }
    return null;
  }

  function strictRecent(payload,type,station,limit){
    const t=norm(type), s=norm(station);
    let rows=[];
    if(t==='METAR') rows=payload?.metar_only||[];
    else if(t==='SPECI') rows=payload?.speci||[];
    else if(t==='SYNOP') rows=payload?.synop||[];
    else if(t==='TAF') rows=payload?.taf||[];
    else if(t==='AVIATION') rows=payload?.aviation||payload?.metar||[];
    if(s) rows=rows.filter(r=>norm(r?.station)===s);
    if(Number.isFinite(Number(limit))&&Number(limit)>0) rows=rows.slice(-Number(limit));
    return rows;
  }

  const api={
    root:ROOT,
    latest:(force=false)=>fetchJson('latest.json',force),
    recent:(force=false)=>fetchJson('recent.json',force),
    status:(force=false)=>fetchJson('status.json',force),
    async getLatest(type,station='',force=false){return strictLatest(await fetchJson('latest.json',force),type,station)},
    async getRecent(type,station='',limit=0,force=false){return strictRecent(await fetchJson('recent.json',force),type,station,limit)},
    clear(){cache.clear();}
  };
  window.PrognozaEPIRMessageArchive=api;
  window.dispatchEvent(new CustomEvent('prognozaepir:message-archive-ready'));
})();
