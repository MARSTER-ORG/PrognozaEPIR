/* PrognozaEPIR — global UTC UI/runtime guard.
 * Project invariant: every user-facing clock is UTC and every visible clock
 * value is explicitly marked with "UTC". Raw aviation telegram syntax is
 * intentionally left untouched (e.g. 101200Z, 1012/1024, FM101300).
 */
(() => {
  'use strict';

  if (window.__PROGNOZA_EPIR_UTC_GUARD_V2__) return;
  window.__PROGNOZA_EPIR_UTC_GUARD_V2__ = true;

  // Radar-only OPERA transport guard. It is installed in <head>, before any
  // GeoTIFF/radar module. Both the original CloudFerro object URL and the old
  // central-ingestor proxy URL are rewritten to the dedicated Railway proxy.
  // This also makes stale cached versions of later radar bridges harmless.
  try {
    if (/\/radar\.html$/i.test(location.pathname) && !window.__PROGNOZA_EPIR_OPERA_EARLY_PROXY__) {
      const nativeFetch = window.fetch.bind(window);
      const LIVE_PROXY = 'https://opera-cmax-live-production.up.railway.app/opera/dbzh/';
      const OLD_PROXY = 'https://central-ingestor-production.up.railway.app/opera/dbzh/';
      const S3_PREFIX = 'https://s3.waw3-1.cloudferro.com/openradar-24h/';
      const operaToken = value => {
        const url = String(value || '');
        let m = url.match(/OPERA@(20\d{6})T(\d{4})@0@DBZH\.tiff(?:[?#].*)?$/i);
        if (m && url.startsWith(S3_PREFIX)) return m[1] + m[2];
        m = url.match(/\/opera\/dbzh\/(20\d{10})\.tiff(?:[?#].*)?$/i);
        if (m && (url.startsWith(OLD_PROXY) || url.startsWith(LIVE_PROXY))) return m[1];
        return null;
      };
      window.fetch = function prognozaOperaFetch(input, init) {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
        const token = operaToken(rawUrl);
        if (!token) return nativeFetch(input, init);
        const proxyUrl = `${LIVE_PROXY}${token}.tiff`;
        if (typeof Request !== 'undefined' && input instanceof Request) {
          const headers = new Headers(input.headers);
          if (init?.headers) new Headers(init.headers).forEach((v,k) => headers.set(k,v));
          return nativeFetch(proxyUrl, {
            method: input.method || 'GET',
            headers,
            mode: 'cors',
            credentials: 'omit',
            cache: init?.cache || input.cache,
            redirect: input.redirect,
            referrerPolicy: input.referrerPolicy,
            signal: init?.signal || input.signal
          });
        }
        return nativeFetch(proxyUrl, init);
      };
      window.__PROGNOZA_EPIR_OPERA_EARLY_PROXY__ = true;
    }
  } catch (_) { }

  const CLOCK_RE = /\b((?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?!\s*(?:UTC|Z)\b)/g;
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','TEXTAREA','PRE','CODE']);
  const WATCHED_ATTRS = ['title','aria-label','data-tooltip','data-title'];

  function markUtc(text) {
    if (typeof text !== 'string' || !text.includes(':')) return text;
    return text.replace(CLOCK_RE, '$1 UTC');
  }

  function shouldSkip(node) {
    let el = node && node.parentElement;
    while (el) {
      if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('data-no-utc-ui')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function patchTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || shouldSkip(node)) return;
    const before = node.nodeValue || '';
    const after = markUtc(before);
    if (after !== before) node.nodeValue = after;
  }

  function patchAttributes(el) {
    if (!(el instanceof Element) || el.hasAttribute('data-no-utc-ui')) return;
    for (const attr of WATCHED_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const before = el.getAttribute(attr) || '';
      const after = markUtc(before);
      if (after !== before) el.setAttribute(attr, after);
    }
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      patchTextNode(root);
      return;
    }
    if (!(root instanceof Element || root instanceof Document || root instanceof DocumentFragment)) return;
    if (root instanceof Element) patchAttributes(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldSkip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) patchTextNode(node);

    if (root.querySelectorAll) {
      const selector = WATCHED_ATTRS.map(attr => `[${attr}]`).join(',');
      root.querySelectorAll(selector).forEach(patchAttributes);
    }
  }

  function scanAll() {
    try {
      scan(document.body || document.documentElement);
    } catch (_) { }
  }

  // Install the DOM protection first. Optional runtime monkey-patches below
  // must never be able to disable visible UTC labelling.
  function installObserver() {
    try {
      const root = document.documentElement;
      if (!root || typeof MutationObserver !== 'function') return;
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'characterData') {
            patchTextNode(record.target);
          } else if (record.type === 'attributes') {
            patchAttributes(record.target);
          } else {
            record.addedNodes.forEach(scan);
          }
        }
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: WATCHED_ATTRS
      });
      window.__PROGNOZA_EPIR_UTC_OBSERVER__ = observer;
    } catch (_) { }
  }

  installObserver();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanAll, { once:true });
  } else {
    scanAll();
  }

  // Fallback for modules that replace large DOM fragments or are rendered by
  // code paths that bypass MutationObserver timing. This is deliberately cheap.
  [50,250,750,1500,3000,6000,12000].forEach(ms => setTimeout(scanAll, ms));
  setInterval(scanAll, 30000);

  // Locale Date methods default to UTC. Failure of any single patch is ignored
  // so the visible UI guard above always remains active.
  for (const name of ['toLocaleString','toLocaleDateString','toLocaleTimeString']) {
    try {
      const original = Date.prototype[name];
      if (typeof original !== 'function') continue;
      Object.defineProperty(Date.prototype, name, {
        configurable:true,
        writable:true,
        value:function prognozaUtcLocale(locales, options) {
          return original.call(this, locales, { ...(options || {}), timeZone: 'UTC' });
        }
      });
    } catch (_) { }
  }

  // Direct Intl.DateTimeFormat users are also forced to UTC, but this patch is
  // optional because some browsers expose Intl constructors differently.
  try {
    if (window.Intl && typeof Intl.DateTimeFormat === 'function') {
      const NativeDateTimeFormat = Intl.DateTimeFormat;
      function UtcDateTimeFormat(locales, options) {
        return new NativeDateTimeFormat(locales, { ...(options || {}), timeZone: 'UTC' });
      }
      UtcDateTimeFormat.prototype = NativeDateTimeFormat.prototype;
      try { Object.setPrototypeOf(UtcDateTimeFormat, NativeDateTimeFormat); } catch (_) { }
      Intl.DateTimeFormat = UtcDateTimeFormat;
    }
  } catch (_) { }

  // Canvas clocks (meteogram/chart axes and labels) are not DOM text.
  try {
    const CanvasProto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
    if (CanvasProto && !CanvasProto.__prognozaUtcUiPatched) {
      Object.defineProperty(CanvasProto,'__prognozaUtcUiPatched',{value:true});
      for (const method of ['fillText','strokeText']) {
        const original = CanvasProto[method];
        if (typeof original !== 'function') continue;
        CanvasProto[method] = function prognozaUtcCanvas(text, ...args) {
          return original.call(this, markUtc(String(text)), ...args);
        };
      }
    }
  } catch (_) { }

  window.PrognozaUtcUI = Object.freeze({ markUtc, scan, scanAll });
})();