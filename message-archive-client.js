'use strict';
(() => {
  // Frontend boundary: this client reads the central archive only. It must never
  // contact IMGW, AWC, PilotHub or any other bulletin provider directly.
  // Railway is the authoritative acquisition engine; GitHub is the durable
  // published archive consumed by browser modules.
  const GITHUB_ROOT = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages';
  const STATIC_ROOT = 'data/messages';
  const RAILWAY_ROOT = 'https://central-ingestor-production.up.railway.app/data/messages';
  const PRIMARY_ROOT = String(window.PROGNOZAEPIR_ARCHIVE_ROOT || GITHUB_ROOT).replace(/\/+$/,'');
  const TTL_MS = 30_000;
  const cache = new Map();
  const norm = value => String(value || '').toUpperCase();

  async function fetchFrom(root, name, now){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${root}/${name}?v=${now}`, {
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

  async function fetchJson(name, force=false){
    const now = Date.now();
    const hit = cache.get(name);
    if(!force && hit && now - hit.at < TTL_MS) return hit.value;

    // GitHub is authoritative for browser reads. If it is temporarily
    // unavailable, prefer the fresh Railway copy before the deployed Pages
    // snapshot, which may lag a commit.
    const roots = [...new Set([PRIMARY_ROOT, RAILWAY_ROOT, STATIC_ROOT].filter(Boolean))];
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
    const error = new Error(`MessageArchive ${name}: GitHub/Railway/static archive unavailable`);
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
    const now = Date.now();
    try {
      return await fetchFrom(RAILWAY_ROOT, 'status.json', now);
    } catch (_) {
      return fetchJson('status.json', force);
    }
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
    fallbackRoot: RAILWAY_ROOT,
    staticFallbackRoot: STATIC_ROOT,
    latest,
    recent,
    status,
    async getLatest(type, station='', force=false){
      return strictLatest(await latest(force), type, station);
    },
    async getRecent(type, station='', limit=0, force=false){
      return strictRecent(await recent(force), type, station, limit);
    },
    clear(){ cache.clear(); }
  });

  window.PrognozaEPIRMessageArchive = api;
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