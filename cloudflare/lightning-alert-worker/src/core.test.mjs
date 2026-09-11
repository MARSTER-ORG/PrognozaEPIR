import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_RADIUS_KM, EPIR, analyzeFeed, haversineKm, shouldAlert } from './core.js';

test('EPIR distance to itself is zero', () => {
  assert.ok(haversineKm(EPIR, EPIR) < 0.001);
});

test('50 km radius accepts a strike just inside and rejects one outside', () => {
  const inside = { lat: EPIR.lat + 49.5 / 111.32, lon: EPIR.lon };
  const outside = { lat: EPIR.lat + 51.0 / 111.32, lon: EPIR.lon };
  assert.ok(haversineKm(EPIR, inside) < ALERT_RADIUS_KM);
  assert.ok(haversineKm(EPIR, outside) > ALERT_RADIUS_KM);
});

test('feed analysis returns only new nearby flashes', () => {
  const now = Date.parse('2026-09-11T10:00:00Z');
  const feed = { points: [
    { lat: EPIR.lat, lon: EPIR.lon, time: '2026-09-11T09:59:00Z' },
    { lat: EPIR.lat + 1, lon: EPIR.lon, time: '2026-09-11T09:59:30Z' },
    { lat: EPIR.lat, lon: EPIR.lon, time: '2026-09-11T09:50:00Z' },
  ] };
  const a = analyzeFeed(feed, { nowMs: now, lastSeenMs: Date.parse('2026-09-11T09:58:00Z') });
  assert.equal(a.nearby.length, 2);
  assert.equal(a.newNearby.length, 1);
});

test('anti-flood suppresses repeat inside cooldown but allows closer escalation', () => {
  const now = Date.parse('2026-09-11T10:00:00Z');
  const base = { newNearby: [{}], nowMs: now, lastAlertAtMs: now - 2 * 60_000 };
  assert.equal(shouldAlert({ ...base, nearest: { distanceKm: 42 }, lastAlertDistanceKm: 44 }).send, false);
  assert.equal(shouldAlert({ ...base, nearest: { distanceKm: 28 }, lastAlertDistanceKm: 44 }).send, true);
});
