/* PrognozaEPIR — global UTC UI/runtime guard.
 * Project invariant: every user-facing clock is UTC and every visible clock
 * value is explicitly marked with "UTC". Raw aviation telegram syntax is
 * intentionally left untouched (e.g. 101200Z, 1012/1024, FM101300).
 */
(() => {
  'use strict';

  if (window.__PROGNOZA_EPIR_UTC_GUARD_V2__) return;
  window.__PROGNOZA_EPIR_UTC_GUARD_V2__ = true;

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
