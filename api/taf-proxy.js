'use strict';

const STATIONS = ['EPIR', 'EPBY', 'EPPW', 'EPKS'];
const SOURCE_PRIORITY = { IMGW: 30, PILOTHUB: 20, AWC: 10 };
const UA = 'Mozilla/5.0 (compatible; PrognozaEPIR-TAF-Proxy/0.3; +https://github.com/MARSTER-ORG/PrognozaEPIR)';

const PILOTHUB = {
  EPIR: [
    'https://pilothub.pl/lotniska/inowroclaw-szpital',
    'https://pilothub.pl/lotniska/epwt',
    'https://pilothub.pl/lotniska/epwk'
  ],
  EPBY: [
    'https://pilothub.pl/lotniska/epby',
    'https://pilothub.pl/lotniska/bydgoszcz-aeroklub-biedaszkowo-lotnisko-niekontrolowane'
  ],
  EPPW: [
    'https://pilothub.pl/lotniska/eppw',
    'https://pilothub.pl/lotniska/epom'
  ],
  EPKS: [
    'https://pilothub.pl/lotniska/epks',
    'https://pilothub.pl/lotniska/epze',
    'https://pilothub.pl/lotniska/eppb'
  ]
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#61;/gi, '=');
}

function plainText(input) {
  return decodeEntities(String(input || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeReport(raw) {
  let s = plainText(raw).replace(/\s*=\s*$/, '=').trim();
  if (s && !s.endsWith('=')) s += '=';
  return s;
}

function resolveDayTime(code, refMs, withMinutes) {
  if (!/^\d{4,6}$/.test(code)) return null;
  const day = Number(code.slice(0, 2));
  const hour = Number(code.slice(2, 4));
  const minute = withMinutes ? Number(code.slice(4, 6)) : 0;
  const ref = new Date(refMs);
  let best = null;
  let bestDelta = Infinity;
  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + monthOffset, day, hour, minute));
    const delta = Math.abs(d.getTime() - refMs);
    if (delta < bestDelta) {
      best = d.getTime();
      bestDelta = delta;
    }
  }
  return best;
}

function tafMeta(raw, now = Date.now()) {
  const s = normalizeReport(raw);
  const issueMatch = s.match(/\b(\d{6})Z\b/);
  if (!issueMatch) return null;
  const issue = resolveDayTime(issueMatch[1], now, true);
  const validity = s.match(/\b(\d{4})\/(\d{4})\b/);
  let validStart = null;
  let validEnd = null;
  if (validity) {
    validStart = resolveDayTime(validity[1], issue, false);
    validEnd = resolveDayTime(validity[2], validStart + 6 * 3600e3, false);
    if (validEnd <= validStart) validEnd = resolveDayTime(validity[2], validStart + 18 * 3600e3, false);
  }
  const nil = /\bNIL\b/.test(s);
  const ageHours = (now - issue) / 3600e3;
  const current = ageHours >= -1.5 && ageHours <= 8.5 && (nil || validEnd == null || validEnd > now - 3600e3);
  return {
    raw: s,
    issue,
    issue_iso: new Date(issue).toISOString(),
    valid_start: validStart == null ? null : new Date(validStart).toISOString(),
    valid_end: validEnd == null ? null : new Date(validEnd).toISOString(),
    age_hours: Math.round(ageHours * 100) / 100,
    current,
    nil
  };
}

function metarMeta(raw, now = Date.now()) {
  const s = normalizeReport(raw).replace(/^TAF\s+/i, '');
  const tm = s.match(/\b(\d{6})Z\b/);
  if (!tm) return null;
  const issue = resolveDayTime(tm[1], now, true);
  return {
    raw: s,
    obs_time: new Date(issue).toISOString(),
    age_hours: Math.round(((now - issue) / 3600e3) * 100) / 100,
    current: now - issue <= 2.5 * 3600e3 && issue - now <= 0.5 * 3600e3
  };
}

function extractTafs(input) {
  const text = plainText(input);
  const re = /\bTAF(?:\s+(?:AMD|COR))?\s+(EPIR|EPBY|EPPW|EPKS)\b[\s\S]*?(?==|(?=\bTAF(?:\s+(?:AMD|COR))?\s+(?:EPIR|EPBY|EPPW|EPKS)\b)|$)/gi;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const raw = normalizeReport(m[0]);
    const meta = tafMeta(raw);
    if (meta) out.push({ station: m[1].toUpperCase(), ...meta });
  }
  return out;
}

function extractMetarEpir(input) {
  const text = plainText(input);
  const re = /\b(?:METAR|SPECI)?\s*EPIR\s+\d{6}Z\b[\s\S]*?(?==|(?=\b(?:METAR|SPECI|TAF)\b)|$)/gi;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const raw = normalizeReport(m[0]);
    const meta = metarMeta(raw);
    if (meta) out.push(meta);
  }
  return out;
}

async function fetchText(url, accept = 'text/plain,text/html,*/*;q=0.8', timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept, 'Cache-Control': 'no-cache' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function addCandidate(store, station, item, source, sourceUrl) {
  if (!item || !STATIONS.includes(station)) return;
  store[station] ||= [];
  store[station].push({
    ...item,
    source,
    source_url: sourceUrl,
    priority: SOURCE_PRIORITY[source] || 0
  });
}

function selectStation(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const byRaw = new Map();
  for (const c of candidates) {
    const key = c.raw.replace(/\s+/g, ' ').trim();
    const prev = byRaw.get(key);
    if (!prev) byRaw.set(key, { ...c, confirmed_by: [c.source] });
    else {
      prev.confirmed_by = [...new Set([...(prev.confirmed_by || []), c.source])];
      if ((c.priority || 0) > (prev.priority || 0)) {
        const keep = prev.confirmed_by;
        byRaw.set(key, { ...c, confirmed_by: keep });
      }
    }
  }
  const list = [...byRaw.values()].sort((a, b) => {
    if (Boolean(a.current) !== Boolean(b.current)) return a.current ? -1 : 1;
    if ((b.issue || 0) !== (a.issue || 0)) return (b.issue || 0) - (a.issue || 0);
    return (b.priority || 0) - (a.priority || 0);
  });
  return { selected: list[0], candidates: list };
}

async function collect() {
  const started = Date.now();
  const candidates = Object.fromEntries(STATIONS.map(s => [s, []]));
  const metarCandidates = [];
  const attempts = [];
  const tasks = [];

  const imgwUrl = `https://awiacja.imgw.pl/metar-i-taf?_=${Date.now()}`;
  tasks.push((async () => {
    const rec = { source: 'IMGW', url: imgwUrl, ok: false };
    try {
      const txt = await fetchText(imgwUrl, 'text/html,*/*;q=0.8', 10000);
      const tafs = extractTafs(txt);
      for (const t of tafs) addCandidate(candidates, t.station, t, 'IMGW', 'https://awiacja.imgw.pl/metar-i-taf');
      for (const m of extractMetarEpir(txt)) metarCandidates.push({ ...m, source: 'IMGW', source_url: 'https://awiacja.imgw.pl/metar-i-taf', priority: 30 });
      rec.ok = tafs.length > 0 || metarCandidates.length > 0;
      rec.tafs = tafs.length;
    } catch (e) {
      rec.error = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e);
    }
    attempts.push(rec);
  })());

  const awcTafUrl = 'https://aviationweather.gov/api/data/taf?ids=' + encodeURIComponent(STATIONS.join(',')) + '&format=raw';
  tasks.push((async () => {
    const rec = { source: 'AWC', url: awcTafUrl, ok: false };
    try {
      const txt = await fetchText(awcTafUrl, 'text/plain,*/*;q=0.8', 8000);
      const tafs = extractTafs(txt);
      for (const t of tafs) addCandidate(candidates, t.station, t, 'AWC', 'https://aviationweather.gov/api/data/taf');
      rec.ok = tafs.length > 0;
      rec.tafs = tafs.length;
    } catch (e) {
      rec.error = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e);
    }
    attempts.push(rec);
  })());

  const awcMetarUrl = 'https://aviationweather.gov/api/data/metar?ids=EPIR&format=raw';
  tasks.push((async () => {
    const rec = { source: 'AWC-METAR', url: awcMetarUrl, ok: false };
    try {
      const txt = await fetchText(awcMetarUrl, 'text/plain,*/*;q=0.8', 8000);
      const list = extractMetarEpir(txt);
      for (const m of list) metarCandidates.push({ ...m, source: 'AWC', source_url: 'https://aviationweather.gov/api/data/metar', priority: 10 });
      rec.ok = list.length > 0;
      rec.metars = list.length;
    } catch (e) {
      rec.error = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e);
    }
    attempts.push(rec);
  })());

  for (const station of STATIONS) {
    for (const url of PILOTHUB[station] || []) {
      tasks.push((async () => {
        const rec = { source: `PILOTHUB-${station}`, url, ok: false };
        try {
          const txt = await fetchText(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, 'text/html,*/*;q=0.8', 8000);
          const tafs = extractTafs(txt).filter(t => t.station === station);
          for (const t of tafs) addCandidate(candidates, station, t, 'PILOTHUB', url);
          if (station === 'EPIR') {
            for (const m of extractMetarEpir(txt)) metarCandidates.push({ ...m, source: 'PILOTHUB', source_url: url, priority: 20 });
          }
          rec.ok = tafs.length > 0;
          rec.tafs = tafs.length;
        } catch (e) {
          rec.error = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e);
        }
        attempts.push(rec);
      })());
    }
  }

  await Promise.allSettled(tasks);

  const stations = {};
  for (const station of STATIONS) {
    const result = selectStation(candidates[station]);
    stations[station] = result ? {
      available: Boolean(result.selected?.raw),
      current: Boolean(result.selected?.current),
      stale: !result.selected?.current,
      nil: Boolean(result.selected?.nil),
      raw: result.selected?.raw || null,
      issue_iso: result.selected?.issue_iso || null,
      valid_start: result.selected?.valid_start || null,
      valid_end: result.selected?.valid_end || null,
      source: result.selected?.source || null,
      source_url: result.selected?.source_url || null,
      confirmed_by: result.selected?.confirmed_by || [],
      candidates: result.candidates.map(c => ({
        raw: c.raw,
        source: c.source,
        source_url: c.source_url,
        issue_iso: c.issue_iso,
        valid_start: c.valid_start,
        valid_end: c.valid_end,
        current: c.current,
        nil: c.nil,
        confirmed_by: c.confirmed_by || [c.source]
      }))
    } : {
      available: false, current: false, stale: false, nil: false, raw: null,
      issue_iso: null, valid_start: null, valid_end: null, source: null,
      source_url: null, confirmed_by: [], candidates: []
    };
  }

  metarCandidates.sort((a, b) => {
    if (Boolean(a.current) !== Boolean(b.current)) return a.current ? -1 : 1;
    const at = Date.parse(a.obs_time || 0), bt = Date.parse(b.obs_time || 0);
    if (bt !== at) return bt - at;
    return (b.priority || 0) - (a.priority || 0);
  });

  return {
    schema: 'prognozaepir-taf-proxy-v1',
    fetched_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    stations,
    metar_epir: metarCandidates[0] || null,
    attempts: attempts.sort((a, b) => a.source.localeCompare(b.source))
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const data = await collect();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({
      schema: 'prognozaepir-taf-proxy-v1',
      fetched_at: new Date().toISOString(),
      error: String(e?.message || e)
    });
  }
};
