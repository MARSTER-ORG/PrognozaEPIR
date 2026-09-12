'use strict';
(() => {
  // Bulletin consumers read only the durable GitHub archive.
  // Railway is ingestion-only and mirrors new records into this repository.
  const GITHUB_ROOT = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages';
  const STATIC_ROOT = 'data/messages';
  const PRIMARY_ROOT = GITHUB_ROOT;
  const TTL_MS = 30_000;
  const cache = new Map();
  const nativeFetch = window.fetch.bind(window);
  const norm = value => String(value || '').toUpperCase();

  async function fetchFrom(root, name, now){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await nativeFetch(`${root}/${name}?v=${now}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers: {'Accept':'application/json'}
      });
      if(!response.ok) throw new Error(`MessageArchive ${name}: HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }


  async function fetchTextFrom(root, name, now){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await nativeFetch(`${root}/${name}?v=${now}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers: {'Accept':'application/x-ndjson,text/plain,*/*'}
      });
      if(!response.ok){
        const error = new Error(`MessageArchive ${name}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

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
      try {
        const value = await fetchTextFrom(root, clean, now);
        cache.set(key, {at: now, value, source: root});
        return value;
      } catch(error){
        if(error?.status !== 404) allNotFound = false;
        errors.push({root, error});
      }
    }
    const error = new Error(`MessageArchive ${clean}: GitHub archive unavailable`);
    error.status = allNotFound ? 404 : 0;
    error.cause = errors;
    throw error;
  }

  function readRoots(){
    return [GITHUB_ROOT, STATIC_ROOT];
  }

  async function fetchJson(name, force=false){
    const now = Date.now();
    const hit = cache.get(name);
    if(!force && hit && now - hit.at < TTL_MS) return hit.value;

    const roots = readRoots();
    const errors = [];
    for(const root of roots){
      try {
        const value = await fetchFrom(root, name, now);
        cache.set(name, {at: now, value, source: root});
        return value;
      } catch(error){
        errors.push({root, error});
      }
    }
    const error = new Error(`MessageArchive ${name}: GitHub archive unavailable`);
    error.cause = errors;
    throw error;
  }

  async function latest(force=false){
    return fetchJson('latest.json', force);
  }

  async function recent(force=false){
    return fetchJson('recent.json', force);
  }

  async function status(force=false){
    return fetchJson('status.json', force);
  }

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

  const api = Object.freeze({
    root: PRIMARY_ROOT,
    liveRoot: GITHUB_ROOT,
    githubRoot: GITHUB_ROOT,
    fallbackRoot: STATIC_ROOT,
    staticFallbackRoot: STATIC_ROOT,
    latest,
    recent,
    status,
    fetchText: fetchArchiveText,
    sourceFor(name){ return cache.get(name)?.source || cache.get(`text:${name}`)?.source || null; },
    async getLatest(type, station='', force=false){
      return strictLatest(await latest(force), type, station);
    },
    async getRecent(type, station='', limit=0, force=false){
      return strictRecent(await recent(force), type, station, limit);
    },
    clear(){ cache.clear(); }
  });

  window.PrognozaEPIRMessageArchive = api;

  // Compatibility bridge for older modules that still fetch the deployed
  // Pages snapshot directly. Keep these callers on the same GitHub-first
  // archive without coupling bulletin freshness to a Pages redeployment.
  const legacyArchiveName = input => {
    try {
      const raw = typeof input === 'string' ? input : input?.url;
      const u = new URL(raw, location.href);
      if(u.origin !== location.origin) return null;
      const m = u.pathname.match(/\/data\/messages\/(latest|recent|status)\.json$/i);
      return m ? `${m[1].toLowerCase()}.json` : null;
    } catch(_){
      return null;
    }
  };

  window.fetch = async function(input, init){
    const name = legacyArchiveName(input);
    if(!name) return nativeFetch(input, init);
    try {
      const body = await fetchJson(name, true);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-PrognozaEPIR-Source': cache.get(name)?.source || GITHUB_ROOT
        }
      });
    } catch(error){
      console.warn(`MessageArchive legacy bridge ${name}:`, error);
      return nativeFetch(input, init);
    }
  };

  window.dispatchEvent(new CustomEvent('prognozaepir:message-archive-ready'));

  // Generator TAF ma jednego właściciela końcowego tekstu depeszy.
  // Wcześniejsze niezależne obserwatory cloud/weather/sanitizer oraz późne
  // automatyczne ponowne generowanie po radarze potrafiły nadpisywać się
  // wzajemnie i powodować widoczne przełączanie CAVOK <-> NSC. Rdzeń taf.html
  // nadal wylicza chmury, pogodę i grupy zmian; poniższy guard wykonuje jeden,
  // deterministyczny etap zgodności z Instrukcją TAF Edycja (A) 11.2023.
  if (/\/taf\.html$/i.test(location.pathname)) {
    const RAW = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/';

    const attachScript = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        s.remove();
        reject(new Error(`Nie udało się załadować ${src}`));
      };
      document.head.appendChild(s);
    });

    const attachRawAsBlob = async (name, version) => {
      const rawUrl = `${RAW}${name}?v=${version}`;
      const response = await fetch(rawUrl, {cache:'no-store'});
      if (!response.ok) throw new Error(`TAF policy ${name}: HTTP ${response.status}`);
      const code = await response.text();
      const blobUrl = URL.createObjectURL(new Blob([code], {type:'text/javascript'}));
      try {
        await attachScript(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    };

    const loadPolicy = async (name, version) => {
      try {
        await attachScript(`${name}?v=${version}`);
      } catch (localError) {
        try {
          await attachRawAsBlob(name, version);
        } catch (rawError) {
          const error = new Error(`Nie udało się załadować ${name}`);
          error.cause = {localError, rawError};
          throw error;
        }
      }
    };

    (async () => {
      try {
        await loadPolicy('taf-instruction-guard.js', '20260909-7');
        await loadPolicy('taf-verification-explain.js', '20260910-1');
      } catch (error) {
        console.warn('TAF policy loader:', error);
      }
    })();
  }
})();