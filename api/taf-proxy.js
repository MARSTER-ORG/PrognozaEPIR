'use strict';

// Deprecated compatibility endpoint. Bulletin reads are owned exclusively by
// message-archive-client.js, whose primary source is the Supabase MessageArchive.
// Keep the route only to fail old external callers explicitly instead of serving
// a second, potentially stale local archive.
module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET') return res.status(405).json({ok:false,error:'method_not_allowed'});
  return res.status(410).json({
    ok:false,
    error:'endpoint_retired',
    source:'SUPABASE_PRIMARY_MESSAGE_ARCHIVE',
    detail:'Use the shared PrognozaEPIR MessageArchive client.'
  });
};
