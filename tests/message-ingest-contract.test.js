const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260923171744_create_message_archive_contract.sql');
const CONTRACT = path.join(ROOT, 'supabase', 'functions', 'message-ingest', 'contract.mjs');

function hash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

(async () => {
  const { ContractError, normalizeBatch } = await import(pathToFileURL(CONTRACT));
  const canonical = 'METAR EPIR 231200Z 24008KT 9999 BKN025 18/12 Q1018=';
  const message = {
    schema: 'prognozaepir-message-v1',
    type: 'METAR',
    station: 'EPIR',
    message_time: '2026-09-23T12:00:00Z',
    obs_time: '2026-09-23T12:00:00Z',
    raw: 'EPIR 231200Z 24008KT 9999 BKN025 18/12 Q1018=',
    canonical_raw: canonical,
    message_id: hash(`METAR\nEPIR\n${canonical}`),
    visibility_m: 10000,
    wind_direction_deg: 240,
    wind_speed_ms: 4.12,
    temperature_c: 18,
    pressure_hpa: 1018,
    ceiling_m_agl: 762,
    source: 'CONTRACT_TEST',
  };

  const normalized = await normalizeBatch({ messages: [message, { ...message }] });
  assert.equal(normalized.rows.length, 1);
  assert.equal(normalized.repeated, 1);
  assert.equal(normalized.rows[0].content_hash, hash(canonical));
  assert.equal(normalized.rows[0].message_type, 'METAR');
  assert.equal(normalized.rows[0].station_code, 'EPIR');
  assert.equal(normalized.rows[0].observed_at, '2026-09-23T12:00:00.000Z');
  assert.equal(normalized.rows[0].issued_at, null);
  assert.equal(normalized.rows[0].wind_speed_kt, 8.01);
  assert.equal(normalized.rows[0].ceiling_ft, 2500);

  const archiveSamples = ['metar', 'speci', 'taf', 'synop'];
  for (const kind of archiveSamples) {
    const samplePath = path.join(ROOT, 'data', 'messages', kind, '2026', '09', '01.jsonl');
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8').split(/\r?\n/).find(Boolean));
    const projected = await normalizeBatch({ messages: [sample] });
    assert.equal(projected.rows.length, 1, `${kind} archive sample must satisfy the ingest contract`);
  }
  const neighborSnapshot = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'messages', 'taf-neighbors.json'), 'utf8'),
  );
  for (const [station, sample] of Object.entries(neighborSnapshot.stations || {})) {
    const projected = await normalizeBatch({ messages: [sample] });
    assert.equal(projected.rows[0].station_code, station, `${station} snapshot must satisfy the ingest contract`);
  }

  await assert.rejects(
    normalizeBatch({ messages: [{ ...message, message_id: '0'.repeat(64) }] }),
    (error) => error instanceof ContractError && error.status === 409,
  );

  const migration = fs.readFileSync(MIGRATION, 'utf8');
  const reader = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'message-archive', 'index.ts'), 'utf8');
  const ingest = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'message-ingest', 'index.ts'), 'utf8');
  const mirror = fs.readFileSync(path.join(ROOT, 'scripts', 'supabase_message_mirror.py'), 'utf8');
  const requiredColumns = [
    'message_type', 'station_code', 'observed_at', 'issued_at', 'valid_from', 'valid_to',
    'archive_time', 'raw_text', 'normalized_text', 'source_ref', 'payload', 'ingested_at',
    'visibility_m', 'wind_direction_deg', 'wind_speed_kt', 'gust_kt', 'temperature_c',
    'qnh_hpa', 'ceiling_ft', 'weather_codes', 'has_fg', 'has_br', 'has_mifg', 'has_ts',
    'has_ra', 'has_sn', 'has_cb', 'has_tcu', 'has_vv',
  ];
  for (const column of requiredColumns) {
    assert.match(migration, new RegExp(`\\b${column}\\b`), `migration must define ${column}`);
    assert.match(reader, new RegExp(`\\b${column}\\b`), `message-archive must read ${column}`);
  }
  assert.match(migration, /create or replace function public\.ingest_message_batch/);
  assert.match(ingest, /database\.rpc\('ingest_message_batch'/);
  assert.match(mirror, /json\.dumps\(\{"messages": messages\}/);
  assert.match(mirror, /functions\/v1\/message-ingest/);
  console.log('Message ingest contract tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
