'use strict';

// Compatibility endpoint only. Acquisition belongs to scripts/central_ingestor.py.
// This handler never contacts bulletin providers; it exposes the already-built
// authoritative archive for legacy API callers.
const fs = require('fs');
const path = require('path');

function readJson(name){
  const file = path.join(process.cwd(), 'data', 'messages', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET') return res.status(405).json({ok:false,error:'method_not_allowed'});

  try {
    const latest = readJson('latest.json');
    const station = String(req.query?.station || '').toUpperCase();
    const stations = latest.taf_by_station || {};
    const selected = station ? stations[station] || null : null;
    return res.status(200).json({
      ok: true,
      source: 'CENTRAL_MESSAGE_ARCHIVE',
      archive: 'data/messages/latest.json',
      updated_at: latest.updated_at || null,
      station: station || null,
      taf: selected || latest.taf || null,
      taf_by_station: station ? undefined : stations,
      aviation: latest.aviation || latest.metar || null,
      synop: latest.synop || null
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      source: 'CENTRAL_MESSAGE_ARCHIVE',
      error: 'archive_unavailable',
      detail: String(error?.message || error)
    });
  }
};
