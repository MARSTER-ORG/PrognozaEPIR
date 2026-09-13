/* PrognozaEPIR — compatibility bridge for legacy archive fetch consumers.
 * Only same-origin data/messages/latest.json and recent.json are intercepted.
 * MessageArchive remains the owner of source priority: live Railway first,
 * GitHub/static mirrors only as fallback.
 */
(() => {
  'use strict';
  if (window.__PROGNOZA_EPIR_MESSAGE_ARCHIVE_FETCH_BRIDGE__) return;
  window.__PROGNOZA_EPIR_MESSAGE_ARCHIVE_FETCH_BRIDGE__ = true;

  const nativeFetch = window.fetch.bind(window);

  function target(input) {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (!raw) return null;
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return null;
      if (/\/data\/messages\/latest\.json$/i.test(url.pathname)) return 'latest';
      if (/\/data\/messages\/recent\.json$/i.test(url.pathname)) return 'recent';
    } catch (_) { }
    return null;
  }

  window.fetch = async function prognozaArchiveFetch(input, init) {
    const kind = target(input);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (!kind || (method !== 'GET' && method !== 'HEAD')) return nativeFetch(input, init);

    const archive = window.PrognozaEPIRMessageArchive;
    const loader = kind === 'latest' ? archive?.latest : archive?.recent;
    if (typeof loader !== 'function') return nativeFetch(input, init);

    try {
      const payload = await loader.call(archive, true);
      const body = method === 'HEAD' ? null : JSON.stringify(payload ?? {});
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-PrognozaEPIR-Archive': 'MessageArchive-live-first'
        }
      });
    } catch (error) {
      console.warn(`MessageArchive bridge ${kind}:`, error);
      return nativeFetch(input, init);
    }
  };
})();
