import { buildPushPayload } from '@block65/webcrypto-web-push';
import {
  ALERT_COOLDOWN_MIN,
  ALERT_RADIUS_KM,
  EPIR,
  MAX_POINT_AGE_MIN,
  analyzeFeed,
  feedTimestampMs,
  notificationFor,
  shouldAlert,
} from './core.js';

const DEFAULT_FEED = 'https://central-ingestor-production.up.railway.app/data/lightning/latest.json';
const DEFAULT_APP_URL = 'https://marster-org.github.io/PrognozaEPIR/radar.html';
const DEFAULT_APP_ORIGIN = 'https://marster-org.github.io';
const STORE_NAME = 'epir-lightning-50km';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = env.APP_ORIGIN || DEFAULT_APP_ORIGIN;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  return {
    'access-control-allow-origin': origin === allowed || local ? origin : allowed,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function store(env) {
  const id = env.ALERT_STORE.idFromName(STORE_NAME);
  return env.ALERT_STORE.get(id);
}

function cleanApiUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

async function sha256Key(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function parseJson(request) {
  try { return await request.json(); } catch { return null; }
}

function validSubscription(sub) {
  return Boolean(
    cleanApiUrl(sub?.endpoint) &&
    typeof sub?.keys?.p256dh === 'string' && sub.keys.p256dh.length > 20 &&
    typeof sub?.keys?.auth === 'string' && sub.keys.auth.length > 8
  );
}

export class LightningAlertStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/subscribe') return this.subscribe(request);
    if (request.method === 'POST' && url.pathname === '/unsubscribe') return this.unsubscribe(request);
    if (request.method === 'POST' && url.pathname === '/run') return this.runCheck();
    if (request.method === 'GET' && url.pathname === '/status') return this.status();
    return json({ error: 'not_found' }, 404);
  }

  async subscribe(request) {
    const sub = await parseJson(request);
    if (!validSubscription(sub)) return json({ error: 'invalid_subscription' }, 400);
    const key = `sub:${await sha256Key(sub.endpoint)}`;
    await this.ctx.storage.put(key, {
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime ?? null,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      createdAt: new Date().toISOString(),
    });
    const subscriptions = await this.ctx.storage.list({ prefix: 'sub:' });
    return json({ ok: true, subscriptions: subscriptions.size });
  }

  async unsubscribe(request) {
    const body = await parseJson(request);
    const endpoint = cleanApiUrl(body?.endpoint);
    if (!endpoint) return json({ error: 'invalid_endpoint' }, 400);
    await this.ctx.storage.delete(`sub:${await sha256Key(endpoint)}`);
    const subscriptions = await this.ctx.storage.list({ prefix: 'sub:' });
    return json({ ok: true, subscriptions: subscriptions.size });
  }

  async status() {
    const subscriptions = await this.ctx.storage.list({ prefix: 'sub:' });
    const state = await this.ctx.storage.get(['lastRunAt','lastFeedUpdatedAt','lastSeenMs','lastAlertAtMs','lastAlertDistanceKm','lastResult']);
    return json({
      ok: true,
      subscriptions: subscriptions.size,
      point: EPIR,
      radiusKm: ALERT_RADIUS_KM,
      cooldownMin: ALERT_COOLDOWN_MIN,
      ...Object.fromEntries(state),
    });
  }

  async runCheck() {
    const started = Date.now();
    const feedUrl = this.env.LIGHTNING_FEED_URL || DEFAULT_FEED;
    const oldState = await this.ctx.storage.get(['lastSeenMs','lastAlertAtMs','lastAlertDistanceKm','lastFeedUpdatedAt','feedEtag']);
    const headers = { accept: 'application/json' };
    if (oldState.get('feedEtag')) headers['if-none-match'] = oldState.get('feedEtag');

    let response;
    try {
      response = await fetch(feedUrl, { cache: 'no-store', headers });
    } catch (error) {
      const result = { ok: false, reason: 'feed_fetch_failed', error: String(error?.message || error), at: new Date().toISOString() };
      await this.ctx.storage.put({ lastRunAt: result.at, lastResult: result });
      return json(result, 502);
    }

    if (response.status === 304) {
      const result = { ok: true, reason: 'feed_not_modified', at: new Date().toISOString() };
      await this.ctx.storage.put({ lastRunAt: result.at, lastResult: result });
      return json(result);
    }
    if (!response.ok) {
      const result = { ok: false, reason: 'feed_http_error', status: response.status, at: new Date().toISOString() };
      await this.ctx.storage.put({ lastRunAt: result.at, lastResult: result });
      return json(result, 502);
    }

    const etag = response.headers.get('etag');
    let feed;
    try { feed = await response.json(); }
    catch {
      const result = { ok: false, reason: 'feed_invalid_json', at: new Date().toISOString() };
      await this.ctx.storage.put({ lastRunAt: result.at, lastResult: result });
      return json(result, 502);
    }

    if (feed?.status !== 'ok') {
      const result = { ok: false, reason: `feed_status_${feed?.status || 'unknown'}`, at: new Date().toISOString() };
      await this.ctx.storage.put({ lastRunAt: result.at, lastResult: result });
      return json(result, 503);
    }

    const feedMs = feedTimestampMs(feed);
    if (Number.isFinite(feedMs) && Date.now() - feedMs > 25 * 60_000) {
      const result = { ok: false, reason: 'feed_stale', feedUpdatedAt: new Date(feedMs).toISOString(), at: new Date().toISOString() };
      await this.ctx.storage.put({ lastRunAt: result.at, lastResult: result });
      return json(result, 503);
    }

    const lastSeenMs = Number(oldState.get('lastSeenMs')) || 0;
    const firstRun = lastSeenMs === 0;
    const analysis = analyzeFeed(feed, { lastSeenMs, maxAgeMin: MAX_POINT_AGE_MIN });
    const candidateNew = firstRun
      ? analysis.nearby.filter((p) => Date.now() - p.timeMs <= 5 * 60_000)
      : analysis.newNearby;
    const nearestNew = candidateNew.slice().sort((a,b) => a.distanceKm - b.distanceKm)[0] || null;
    const decision = shouldAlert({
      newNearby: candidateNew,
      nearest: nearestNew,
      firstRun: firstRun && Boolean(nearestNew),
      lastAlertAtMs: Number(oldState.get('lastAlertAtMs')) || 0,
      lastAlertDistanceKm: Number(oldState.get('lastAlertDistanceKm')),
    });

    const updates = {
      lastRunAt: new Date().toISOString(),
      lastFeedUpdatedAt: Number.isFinite(feedMs) ? new Date(feedMs).toISOString() : String(feed?.updated_at || ''),
      lastSeenMs: analysis.latestMs,
    };
    if (etag) updates.feedEtag = etag;

    let delivery = { attempted: 0, sent: 0, removed: 0, failed: 0 };
    if (decision.send && nearestNew) {
      const notification = notificationFor({
        nearest: nearestNew,
        newCount: candidateNew.length,
        appUrl: this.env.APP_URL || DEFAULT_APP_URL,
      });
      delivery = await this.broadcast(notification);
      updates.lastAlertAtMs = Date.now();
      updates.lastAlertDistanceKm = nearestNew.distanceKm;
    }

    const result = {
      ok: true,
      at: updates.lastRunAt,
      elapsedMs: Date.now() - started,
      radiusKm: ALERT_RADIUS_KM,
      recentPoints: analysis.recent.length,
      nearbyPoints: analysis.nearby.length,
      newNearbyPoints: candidateNew.length,
      nearestNewKm: nearestNew ? Number(nearestNew.distanceKm.toFixed(1)) : null,
      alert: decision.send,
      alertReason: decision.reason,
      delivery,
    };
    updates.lastResult = result;
    await this.ctx.storage.put(updates);
    return json(result);
  }

  async broadcast(notification) {
    const subscriptions = await this.ctx.storage.list({ prefix: 'sub:' });
    const vapid = {
      subject: this.env.VAPID_SUBJECT,
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
    };
    const stats = { attempted: subscriptions.size, sent: 0, removed: 0, failed: 0 };
    if (!vapid.subject || !vapid.publicKey || !vapid.privateKey) {
      stats.failed = subscriptions.size;
      return stats;
    }
    const body = JSON.stringify(notification);
    for (const [key, subscription] of subscriptions) {
      try {
        const payload = await buildPushPayload({ data: body, options: { ttl: 300 } }, subscription, vapid);
        const response = await fetch(subscription.endpoint, payload);
        if (response.ok) stats.sent++;
        else if (response.status === 404 || response.status === 410) {
          await this.ctx.storage.delete(key);
          stats.removed++;
        } else stats.failed++;
      } catch (error) {
        console.error('Web Push failed', error);
        stats.failed++;
      }
    }
    return stats;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'epir-lightning-alerts', radiusKm: ALERT_RADIUS_KM, point: EPIR }, 200, cors);
    }
    if (request.method === 'GET' && url.pathname === '/config') {
      if (!env.VAPID_PUBLIC_KEY) return json({ error: 'vapid_not_configured' }, 503, cors);
      return json({
        ok: true,
        point: EPIR,
        radiusKm: ALERT_RADIUS_KM,
        maxPointAgeMin: MAX_POINT_AGE_MIN,
        cooldownMin: ALERT_COOLDOWN_MIN,
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
      }, 200, cors);
    }
    if (request.method === 'POST' && (url.pathname === '/subscribe' || url.pathname === '/unsubscribe')) {
      const response = await store(env).fetch(`https://store${url.pathname}`, { method: 'POST', body: await request.text(), headers: { 'content-type': 'application/json' } });
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      const response = await store(env).fetch('https://store/status');
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
    }
    if (request.method === 'POST' && url.pathname === '/admin/run') {
      const expected = env.ADMIN_TOKEN || '';
      const auth = request.headers.get('authorization') || '';
      if (!expected || auth !== `Bearer ${expected}`) return json({ error: 'unauthorized' }, 401, cors);
      const response = await store(env).fetch('https://store/run', { method: 'POST' });
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
    }
    return json({ error: 'not_found' }, 404, cors);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(store(env).fetch('https://store/run', { method: 'POST' }));
  },
};
