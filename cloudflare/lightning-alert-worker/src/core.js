export const EPIR = Object.freeze({ lat: 52.8275, lon: 18.3175, name: 'EPIR' });
export const ALERT_RADIUS_KM = 50;
export const MAX_POINT_AGE_MIN = 15;
export const ALERT_COOLDOWN_MIN = 10;
export const ESCALATION_STEP_KM = 10;

const toRad = (deg) => deg * Math.PI / 180;
const toDeg = (rad) => rad * 180 / Math.PI;

export function haversineKm(a, b) {
  const lat1 = Number(a?.lat), lon1 = Number(a?.lon ?? a?.lng);
  const lat2 = Number(b?.lat), lon2 = Number(b?.lon ?? b?.lng);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371.0088;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const lat1 = toRad(Number(a.lat)), lat2 = toRad(Number(b.lat));
  const dl = toRad(Number(b.lon ?? b.lng) - Number(a.lon ?? a.lng));
  const y = Math.sin(dl) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function compass16(deg) {
  const names = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return names[Math.round((((Number(deg) % 360) + 360) % 360) / 22.5) % 16];
}

export function pointTimeMs(point) {
  const value = Date.parse(point?.time || '');
  return Number.isFinite(value) ? value : NaN;
}

export function feedTimestampMs(feed) {
  const value = Date.parse(feed?.source?.product_end || feed?.updated_at || '');
  return Number.isFinite(value) ? value : NaN;
}

export function normalizePoints(feed) {
  if (!Array.isArray(feed?.points)) return [];
  return feed.points
    .map((p) => ({ ...p, lat: Number(p?.lat), lon: Number(p?.lon), timeMs: pointTimeMs(p) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timeMs));
}

export function analyzeFeed(feed, {
  nowMs = Date.now(),
  lastSeenMs = 0,
  center = EPIR,
  radiusKm = ALERT_RADIUS_KM,
  maxAgeMin = MAX_POINT_AGE_MIN,
} = {}) {
  const points = normalizePoints(feed);
  const maxAgeMs = maxAgeMin * 60_000;
  const recent = points.filter((p) => nowMs - p.timeMs >= -120_000 && nowMs - p.timeMs <= maxAgeMs);
  const latestMs = points.reduce((max, p) => Math.max(max, p.timeMs), Number(lastSeenMs) || 0);
  const nearby = recent
    .map((p) => ({ ...p, distanceKm: haversineKm(center, p), bearingDeg: bearingDeg(center, p) }))
    .filter((p) => p.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const newNearby = nearby.filter((p) => !lastSeenMs || p.timeMs > lastSeenMs);
  return { points, recent, nearby, newNearby, latestMs, nearest: nearby[0] || null };
}

export function shouldAlert({
  newNearby,
  nearest,
  nowMs = Date.now(),
  lastAlertAtMs = 0,
  lastAlertDistanceKm = Infinity,
  cooldownMin = ALERT_COOLDOWN_MIN,
  escalationStepKm = ESCALATION_STEP_KM,
  firstRun = false,
}) {
  if (!nearest) return { send: false, reason: 'no-nearby' };
  const hasNew = firstRun ? true : Array.isArray(newNearby) && newNearby.length > 0;
  if (!hasNew) return { send: false, reason: 'no-new-strikes' };
  if (!lastAlertAtMs) return { send: true, reason: 'first-alert' };
  if (nowMs - lastAlertAtMs >= cooldownMin * 60_000) return { send: true, reason: 'cooldown' };
  if (Number.isFinite(lastAlertDistanceKm) && nearest.distanceKm <= lastAlertDistanceKm - escalationStepKm) {
    return { send: true, reason: 'closer' };
  }
  const previousBand = distanceBand(lastAlertDistanceKm);
  const currentBand = distanceBand(nearest.distanceKm);
  if (currentBand < previousBand) return { send: true, reason: 'band-crossing' };
  return { send: false, reason: 'suppressed' };
}

export function distanceBand(distanceKm) {
  const d = Number(distanceKm);
  if (!Number.isFinite(d)) return 99;
  if (d <= 10) return 0;
  if (d <= 15) return 1;
  if (d <= 30) return 2;
  if (d <= 50) return 3;
  return 4;
}

export function formatUtcHHMM(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '— UTC';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function notificationFor({ nearest, newCount, appUrl }) {
  const dist = nearest.distanceKm < 10 ? nearest.distanceKm.toFixed(1) : Math.round(nearest.distanceKm).toString();
  const dir = compass16(nearest.bearingDeg);
  const time = formatUtcHHMM(nearest.timeMs);
  return {
    title: '⚡ Wyładowania do 50 km od EPIR',
    body: `${Math.max(1, Number(newCount) || 1)} nowych błysków. Najbliższy: ${dist} km ${dir} od EPIR · ${time}.`,
    tag: 'epir-lightning-50km',
    url: appUrl,
    radiusKm: ALERT_RADIUS_KM,
    nearestKm: Number(nearest.distanceKm.toFixed(1)),
    timeUtc: new Date(nearest.timeMs).toISOString(),
  };
}
