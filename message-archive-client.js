'use strict';
(() => {
  // Frontend boundary: this client reads the central archive only. It must never
  // contact IMGW, AWC, PilotHub or any other bulletin provider directly.
  const ROOT = String(window.PROGNOZAEPIR_ARCHIVE_ROOT || 'data/messages').replace(/\/+$/,'');
  const TTL_MS = 30_000;
  const cache = new Map();
  const norm = value => String(value || '').toUpperCase();

  async function fetchJson(name, force=false){
    const now = Date.now();
    const hit = cache.get(name);
    if(!force && hit && now - hit.at < TTL_MS) return hit.value;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${ROOT}/${name}?v=${now}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers: {'Accept':'application/json'}
      });
      if(!response.ok) throw new Error(`MessageArchive ${name}: HTTP ${response.status}`);
      const value = await response.json();
      cache.set(name, {at: now, value});
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  async function latest(force=false){
    return fetchJson('latest.json', force);
  }

  async function recent(force=false){
    return fetchJson('recent.json', force);
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
    root: ROOT,
    latest,
    recent,
    status: (force=false) => fetchJson('status.json', force),
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
})();
