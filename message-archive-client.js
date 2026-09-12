'use strict';
(() => {
  const GITHUB_ROOT = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages';
  const STATIC_ROOT = 'data/messages';
  const PRIMARY_ROOT = GITHUB_ROOT;
  const TTL_MS = 30_000;
  const DAY_MS = 86_400_000;
  const cache = new Map();
  const nativeFetch = window.fetch.bind(window);
  const norm = value => String(value || '').toUpperCase();

  async function fetchFrom(root, name, now){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await nativeFetch(`${root}/${name}?v=${now}`, {
        cache: 'no-store', signal: controller.signal, headers: {'Accept':'application/json'}
      });
      if(!response.ok){
        const error = new Error(`MessageArchive ${name}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async function fetchTextFrom(root, name, now){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await nativeFetch(`${root}/${name}?v=${now}`, {
        cache: 'no-store', signal: controller.signal,
        headers: {'Accept':'application/x-ndjson,text/plain,*/*'}
      });
      if(!response.ok){
        const error = new Error(`MessageArchive ${name}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } finally { clearTimeout(timer); }
  }

  function readRoots(){ return [GITHUB_ROOT, STATIC_ROOT]; }

  async function fetchArchiveText(name, force=false){
    const clean = String(name || '').replace(/^\/+/, '');
    if(!clean || clean.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(clean)){
      throw new Error('MessageArchive: invalid archive path');
    }
    const key = `text:${clean}`;
    const now = Date.now();
    const hit = cache.get(key);
    if(!force && hit && now - hit.at < TTL_MS) return hit.value;
    const errors = [];
    let allNotFound = true;
    for(const root of readRoots()){
      try{
        const value = await fetchTextFrom(root, clean, now);
        cache.set(key, {at:now, value, source:root});
        return value;
      }catch(error){
        if(error?.status !== 404) allNotFound = false;
        errors.push({root, error});
      }
    }
    const error = new Error(`MessageArchive ${clean}: GitHub archive unavailable`);
    error.status = allNotFound ? 404 : 0;
    error.cause = errors;
    throw error;
  }

  async function fetchJson(name, force=false){
    const now = Date.now();
    const hit = cache.get(name);
    if(!force && hit && now - hit.at < TTL_MS) return hit.value;
    const errors = [];
    for(const root of readRoots()){
      try{
        const value = await fetchFrom(root, name, now);
        cache.set(name, {at:now, value, source:root});
        return value;
      }catch(error){ errors.push({root,error}); }
    }
    const error = new Error(`MessageArchive ${name}: GitHub archive unavailable`);
    error.cause = errors;
    throw error;
  }

  function rowTime(row){
    if(!row) return -Infinity;
    for(const key of ['message_time','obs_time','issue_time','time','timestamp']){
      const t = Date.parse(row[key] || '');
      if(Number.isFinite(t)) return t;
    }
    return -Infinity;
  }

  function dayPath(type, offset=0){
    const d = new Date(Date.now() - offset * DAY_MS);
    const y = String(d.getUTCFullYear()).padStart(4,'0');
    const m = String(d.getUTCMonth()+1).padStart(2,'0');
    const day = String(d.getUTCDate()).padStart(2,'0');
    return `${String(type).toLowerCase()}/${y}/${m}/${day}.jsonl`;
  }

  function parseJsoll(text, type, station=''){
    const t = norm(type), s = norm(station), rows = [];
    for(const line of String(text || '').split(/\r?\n/)){
      if(!line.trim()) continue;
      try{
        const row = JSON.parse(line);
        const rt = norm(row?.type || row?.report_type);
        if(rt && rt !== t) continue;
        if(s && norm(row?.station) !== s) continue;
        rows.push(row);
      }catch(error){ console.warn('MessageArchive: invalid JSONL row', error); }
    }
    return rows;
  }

  function dedupeSort(rows){
    const seen = new Set(), out = [];
    for(const row of rows || []){
      if(!row) continue;
      const key = String(row.message_id || `${norm(row.type)}|${norm(row.station)}|${row.canonical_raw || row.raw || ''}`);
      if(seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    out.sort((a,b) => rowTime(a) - rowTime(b));
    return out;
  }

  function newest(rows){
    return dedupeSort(rows).slice(-1)[0] || null;
  }

  async function directRows(type, station='', force=false, days=1){
    const t = norm(type), s = norm(station);
    if(!['METAR','SPECI','TAF','SYNOP'].includes(t)) return [];
    if(t === 'TAF' && s && s !== 'EPIR') return [];
    const out = [];
    for(let offset=0; offset<Math.max(1,days); offset++){
      const path = dayPath(t, offset);
      try{ out.push(...parseJsonl(await fetchArchiveText(path, force), t, s)); }
      catch(error){ if(error?.status !== 404) throw error; }
    }
    return dedupeSort(out);
  }

  async function directLatest(type, station='', force=false){
    const t = norm(type), s = norm(station);
    if(t === 'AVIATION'){
      const [m,sp] = await Promise.all([
        directLatest('METAR', s || 'EPIR', force),
        directLatest('SPECI', s || 'EPIR', force)
      ]);
      return newest([m,sp]);
    }
    let rows = await directRows(t, s, force, 1);
    if(rows.length) return rows[rows.length-1];
    rows = await directRows(t, s, force, 2);
    return rows[rows.length-1] || null;
  }

  function mergeRows(...groups){ return dedupeSort(groups.flatMap(x => Array.isArray(x) ? x : [])); }

  function strictLatest(payload, type, station){
    const t = norm(type), s = norm(station);
    let row = null;
    if(t === 'METAR') row = payload?.metar_only || payload?.metar || null;
    else if(t === 'SPECI') row = payload?.speci || null;
    else if(t === 'SYNOP') row = payload?.synop || null;
    else if(t === 'TAF') row = s ? payload?.taf_by_station?.[s] || null : payload?.taf || null;
    else if(t === 'AVIATION') row = payload?.aviation || payload?.metar || null;
    if(!row) return null;
    return !s || norm(row.station) === s ? row : null;
  }

  function strictRecent(payload, type, station, limit){
    const t = norm(type), s = norm(station);
    let rows = [];
    if(t === 'METAR') rows = payload?.metar_only || payload?.metar || [];
    else if(t === 'SPECI') rows = payload?.speci || [];
    else if(t === 'SYNOP') rows = payload?.synop || [];
    else if(t === 'TAF') rows = payload?.taf || [];
    else if(t === 'AVIATION') rows = payload?.aviation || payload?.metar || [];
    if(!Array.isArray(rows)) rows = [];
    if(s) rows = rows.filter(row => norm(row?.station) === s);
    const n = Number(limit);
    if(Number.isFinite(n) && n > 0) rows = rows.slice(-n);
    return rows;
  }

  async function latest(force=false){
    const basePromise = fetchJson('latest.json', force).catch(() => ({}));
    const [base,metar,speci,taf,synop] = await Promise.all([
      basePromise,
      directLatest('METAR','EPIR',force).catch(() => null),
      directLatest('SPECI','EPIR',force).catch(() => null),
      directLatest('TAF','EPIR',force).catch(() => null),
      directLatest('SYNOP','12342',force).catch(() => null)
    ]);
    const out = {...(base || {})};
    if(metar){ out.metar = metar; out.metar_only = metar; }
    if(speci) out.speci = speci;
    const aviation = newest([out.aviation, metar,speci]);
    if(aviation) out.aviation = aviation;
    if(taf){ out.taf = taf; out.taf_by_station = {...(out.taf_by_station || {}), EPIR:taf}; }
    if(synop) out.synop = synop;
    return out;
  }

  async function recent(force=false){
    const basePromise = fetchJson('recent.json', force).catch(() => ({}));
    const [base,metar,speci,taf,synop] = await Promise.all([
      basePromise,
      directRows('METAR','EPIR',force,2).catch(() => []),
      directRows('SPECI','EPIR',force,2).catch() => []),
      directRows('TAF','EPIR',force,2).catch(() => [])
      directRows('SYNOP','12342',force,2).catch(() => [])
    ]);
    const out = {...(base || {})};
    out.metar_only = mergeRows(out.metar_only, metar);
    out.metar = mergeRows(out.metar, metar);
    out.speci = mergeRows(out.speci, speci);
    out.aviation = mergeRows(out.viation, metar, speci);
    out.taf = mergeRows(out.taf, taf);
    out.synop = mergeRows(out.synop, synop);
    return out;
  }

  async function status(force=false){ return fetchJson('status.json', force); }


  async function getLatest(type, station='', force=false){
    const t = norm(type), s = norm(station);
    try{
      const direct = await directLatest(t, s, force);
      if(direct) return direct;
    }catch(error){ console.warn(`MessageArchive direct latest ${t}:`, error); }
    return strictLatest(await fetchJson('latest.json', force), t, s);
  }

  async function getRecent(type, station='', limit=0, force=false){
    const t = norm(type), s = norm(station), n = Number(limit);
    try{
      let rows;
      if(t === 'AVIATION'){
        const [m,sp] = await Promise.all([
          directRows('METAR',s || 'EPIR',force,2), directRows('SPECI',s || 'EPIR',force,2)
        ]);
        rows = mergeRows(m,sp);
      }else{
        rows = await directRows(t,s,force,2);
      }
      if(rows.length){
        if(Number.isFinite(n) && n > 0) return rows.slice(-n);
        return rows;
      }
    }catch(error){ console.warn(`MessageArchive direct recent ${t}:`, error); }
    return strictRecent(await fetchJson('recent.json', force), t, s, limit);
  }

  const api = Object.freeze({
    root:PRIMARY_ROOT, liveRoot:GITHUB_ROOT, githubRoot:GITHUB_ROOT,
    fallbackRoot:STATIC_ROOT, staticFallbackRoot:STATIC_ROOT,
    latest, recent, status, getLatest, getRecent, fetchText:fetchArchiveText,
    sourceFor(name){ return cache.get(name)?.source || cache.get(`text:${name}`)?.source || null; },
    clear(){ cache.clear(); }
  });
  window.PrognozaEPIRMessageArchive = api;

  const legacyArchiveName = input => {
    try{
      const raw = typeof input === 'string' ? input : input?.url;
      const u = new URL(raw, location.href);
      if(u.origin !== location.origin) return null;
      const m = u.pathname.match(/\/data\/messages\/(latest|recent|status)\.json$/i);
      return m ? `${m[1].toLowerCase()}.json` : null;
    }catch(_){ return null; }
  };

  window.fetch = async function(input, init){
    const name = legacyArchiveName(input);
    if(!name) return nativeFetch(input, init);
    try{
      const body = name === 'latest.json' ? await latest(true)
        : name === 'recent.json' ? await recent(true)
        : await status(true);
      return new Response(JSON.stringify(body), {
        status:200,
        headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, max-age=0','X-PrognozaEPIR-Source':'daily-jsonl-first'}
      });
    }catch(error){
      console.warn(`MessageArchive legacy bridge ${name}:`, error);
      return nativeFetch(input, init);
    }
  };

  window.dispatchEvent(new CustomEvent('prognozaepir:message-archive-ready'));

  if (/\/taf\.html$/i.test(location.pathname)) {
    const RAW = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/';
    const attachScript = src => new Promise((resolve,reject) => {
      const s=document.createElement('script'); s.src=src; s.async=true;
      s.onload=()=>resolve(); s.onerror=()=>{s.remove();reject(new Error(`Nie udało się załadować ${src}`));};
      document.head.appendChild(s);
    });
    const attachRawAsBlob = async (name,version) => {
      const response=await fetch(`${RAW}${name}?v=${version}`,{cache:'no-store'});
      if(!response.ok) throw new Error(`TAF policy ${name}: HTTP ${response.status}`);
      const blobUrl=URL.createObjectURL(new Blob([await response.text()],{type:'text/javascript'}));
      try{await attachScript(blobUrl);}finally{URL.revokeObjectURL(blobUrl);}
    };
    const loadPolicy = async (name,version) => {
      try{await attachScript(`${name}?v=${version}`);}
      catch(localError){
        try{await attachRawAsBlob(name,version);}
        catch(rawError){const error=new Error(`Nie udało sięzaładować ${name}`);error.cause={localError,rawError};throw error;}
      }
    };
    (async()=>{
      try{
        await loadPolicy('taf-instruction-guard.js','20260909-7');
        await loadPolicy('taf-verification-explain.js','20260910-1');
      }catch(error){console.warn('TAF policy loader:',error);}
    })();

    const tafArchiveSignature = payload => [
      payload?.aviation?.message_id || payload?.metar?.message_id || '',
      payload?.speci?.message_id || '',
      payload?.taf_by_station?.EPIR?.message_id || payload?.taf?.message_id || '',
      payload?.taf_by_station?.EPBY?.message_id || '',
      payload?.taf_by_station?.EPPW?.message_id || '',
      payload?.taf_by_station?.EPKS?.message_id || ''
    ].join('|');
    let lastTafArchiveSignature = null;
    const triggerTafGenerator = () => {
      if(document.visibilityState==='hidden') return false;
      const button=document.getElementById('gen'), badge=document.getElementById('badge');
      if(!button || typeof button.click!=='function') return false;
      if(String(badge?.textContent||'').toUpperCase().includes('ŁADOWANIE')) return false;
      button.click(); return true;
    };
    const checkTafArchiveFreshness = async (initial=false) => {
      try{
        const payload=await latest(true), signature=tafArchiveSignature(payload);
        if(lastTafArchiveSignature===null){lastTafArchiveSignature=signature;if(initial)triggerTafGenerator();return;}
        if(signature!==lastTafArchiveSignature && triggerTafGenerator()) lastTafArchiveSignature=signature;
      }catch(error){console.warn('TAF archive freshness watcher:',error);}
    };
    window.addEventListener('load',()=>{
      setTimeout(()=>checkTafArchiveFreshness(true),250);
      setInterval(()=>{if(document.visibilityState!=='hidden')checkTafArchiveFreshness(false);},60_000);
    },{once:true});
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState!=='hidden')checkTafArchiveFreshness(false);
    });
  }
})();
