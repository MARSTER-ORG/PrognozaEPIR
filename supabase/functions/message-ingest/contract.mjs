export const MAX_BATCH_SIZE = 500;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MESSAGE_TYPES = new Set(['METAR', 'SPECI', 'TAF', 'SYNOP']);
const STATION_RE = /^[A-Z0-9]{4,5}$/;
const MESSAGE_ID_RE = /^[0-9a-f]{64}$/;

export class ContractError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ContractError';
    this.status = status;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, field, maxLength = 32768) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ContractError(`${field} is required`);
  if (text.length > maxLength) throw new ContractError(`${field} is too long`);
  return text;
}

function optionalText(value, maxLength = 4096) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new ContractError('text field is too long');
  return text;
}

function isoTime(value, field, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ContractError(`${field} is required`);
    return null;
  }
  const millis = Date.parse(String(value));
  if (!Number.isFinite(millis)) throw new ContractError(`${field} must be an ISO timestamp`);
  return new Date(millis).toISOString();
}

function finiteNumber(value, field, { integer = false, min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) {
    throw new ContractError(`${field} must be a finite${integer ? ' integer' : ''} number`);
  }
  if (min !== null && number < min) throw new ContractError(`${field} is below its minimum`);
  if (max !== null && number > max) throw new ContractError(`${field} is above its maximum`);
  return number;
}

function firstFinite(message, fields, options = {}) {
  for (const field of fields) {
    const value = finiteNumber(message[field], field, options);
    if (value !== null) return value;
  }
  return null;
}

function round2(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function tokensFrom(message, canonicalRaw) {
  const supplied = Array.isArray(message.weather_codes)
    ? message.weather_codes.map((value) => String(value).toUpperCase()).filter(Boolean)
    : [];
  const text = `${canonicalRaw} ${message.weather || ''}`.toUpperCase();
  const detected = [];
  if (/\bFG\b/.test(text)) detected.push('FG');
  if (/\bBR\b/.test(text)) detected.push('BR');
  if (/\bMIFG\b/.test(text)) detected.push('MIFG');
  if (/\bTS(?:RA|GR|GS|SN)?\b/.test(text)) detected.push('TS');
  if (/\b(?:SH|FZ|TS)?RA(?:DZ|SN|GR|GS)?\b/.test(text)) detected.push('RA');
  if (/\b(?:SH|TS)?SN\b/.test(text)) detected.push('SN');
  if (/\bCB\b/.test(text)) detected.push('CB');
  if (/\bTCU\b/.test(text)) detected.push('TCU');
  if (/\bVV\d{3}\b/.test(text)) detected.push('VV');
  return [...new Set([...supplied, ...detected])];
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function normalizeMessage(message) {
  if (!plainObject(message)) throw new ContractError('each message must be an object');

  const messageType = requiredText(message.type, 'type', 16).toUpperCase();
  if (!MESSAGE_TYPES.has(messageType)) throw new ContractError('type is not supported');
  const stationCode = requiredText(message.station, 'station', 16).toUpperCase();
  if (!STATION_RE.test(stationCode)) throw new ContractError('station has an invalid format');

  const rawText = requiredText(message.raw, 'raw');
  const normalizedText = requiredText(message.canonical_raw, 'canonical_raw');
  const messageTime = isoTime(message.message_time, 'message_time', true);
  const observedAt = messageType === 'TAF'
    ? null
    : isoTime(message.obs_time || messageTime, 'obs_time', true);
  const issuedAt = messageType === 'TAF'
    ? isoTime(message.issue_time || messageTime, 'issue_time', true)
    : null;
  const validFrom = isoTime(message.valid_from || message.valid_start, 'valid_from');
  const validTo = isoTime(message.valid_to || message.valid_end, 'valid_to');
  if (validFrom && validTo && Date.parse(validTo) < Date.parse(validFrom)) {
    throw new ContractError('valid_to must not precede valid_from');
  }

  const suppliedId = requiredText(message.message_id, 'message_id', 64).toLowerCase();
  if (!MESSAGE_ID_RE.test(suppliedId)) throw new ContractError('message_id must be a lowercase SHA-256 value');
  const expectedId = await sha256(`${messageType}\n${stationCode}\n${normalizedText}`);
  if (suppliedId !== expectedId) throw new ContractError('message_id does not match the canonical identity', 409);

  const contentHash = await sha256(normalizedText);
  const weatherCodes = tokensFrom(message, normalizedText);
  const windSpeedKtDirect = firstFinite(message, ['wind_speed_kt'], { min: 0 });
  const windSpeedMs = firstFinite(message, ['wind_speed_ms'], { min: 0 });
  const gustKtDirect = firstFinite(message, ['wind_gust_kt', 'gust_kt'], { min: 0 });
  const gustMs = firstFinite(message, ['wind_gust_ms'], { min: 0 });
  const ceilingFtDirect = firstFinite(message, ['ceiling_ft_agl', 'ceiling_ft'], { integer: true, min: 0 });
  const ceilingM = firstFinite(message, ['ceiling_m_agl', 'cloud_base_m_agl'], { min: 0 });

  return {
    content_hash: contentHash,
    message_type: messageType,
    station_code: stationCode,
    observed_at: observedAt,
    issued_at: issuedAt,
    valid_from: validFrom,
    valid_to: validTo,
    raw_text: rawText,
    normalized_text: normalizedText,
    source_ref: optionalText(
      message.source_ref || message.source_url || message.archive_source_file || message.source_file,
    ),
    payload: message,
    archive_time: messageTime,
    visibility_m: firstFinite(message, ['visibility_m'], { integer: true, min: 0 }),
    wind_direction_deg: firstFinite(message, ['wind_direction_deg'], { integer: true, min: 0, max: 360 }),
    wind_speed_kt: round2(windSpeedKtDirect ?? (windSpeedMs === null ? null : windSpeedMs * 1.9438444924406)),
    gust_kt: round2(gustKtDirect ?? (gustMs === null ? null : gustMs * 1.9438444924406)),
    temperature_c: firstFinite(message, ['temperature_c']),
    qnh_hpa: firstFinite(message, ['pressure_hpa', 'qnh_hpa'], { min: 0 }),
    ceiling_ft: ceilingFtDirect ?? (ceilingM === null ? null : Math.round(ceilingM * 3.2808398950131)),
    weather_codes: weatherCodes,
    has_fg: Boolean(message.fog) || weatherCodes.includes('FG'),
    has_br: Boolean(message.mist) || weatherCodes.includes('BR'),
    has_mifg: weatherCodes.includes('MIFG'),
    has_ts: weatherCodes.includes('TS'),
    has_ra: weatherCodes.includes('RA'),
    has_sn: weatherCodes.includes('SN'),
    has_cb: weatherCodes.includes('CB'),
    has_tcu: weatherCodes.includes('TCU'),
    has_vv: weatherCodes.includes('VV'),
  };
}

export async function normalizeBatch(payload) {
  if (!plainObject(payload) || !Array.isArray(payload.messages)) {
    throw new ContractError('body must be an object with a messages array');
  }
  if (payload.messages.length < 1 || payload.messages.length > MAX_BATCH_SIZE) {
    throw new ContractError(`messages batch size must be between 1 and ${MAX_BATCH_SIZE}`);
  }

  const rows = [];
  const byHash = new Map();
  let repeated = 0;
  for (const message of payload.messages) {
    const row = await normalizeMessage(message);
    const prior = byHash.get(row.content_hash);
    if (prior) {
      if (
        prior.message_type !== row.message_type
        || prior.station_code !== row.station_code
        || prior.normalized_text !== row.normalized_text
      ) {
        throw new ContractError('batch contains a content hash identity conflict', 409);
      }
      repeated += 1;
      continue;
    }
    byHash.set(row.content_hash, row);
    rows.push(row);
  }
  return { rows, repeated };
}
