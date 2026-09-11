'use strict';

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch {
    try { data = { body: event.data?.text() || '' }; } catch { data = {}; }
  }
  const title = data.title || 'PrognozaEPIR · wyładowania';
  const options = {
    body: data.body || 'Nowe wyładowanie w pobliżu EPIR.',
    icon: 'epir-icon-192.png',
    badge: 'epir-icon-192.png',
    tag: data.tag || 'epir-lightning-50km',
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || 'radar.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL('radar.html', self.location.href);
    try {
      const requested = new URL(event.notification?.data?.url || 'radar.html', self.location.href);
      if (requested.origin === self.location.origin) target = requested;
    } catch {}
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === target.origin) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target.href);
        return;
      }
    }
    await clients.openWindow(target.href);
  })());
});
