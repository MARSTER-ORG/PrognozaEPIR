/* PrognozaEPIR — global UTC UI/runtime guard.
 * Project invariant: every user-facing clock is UTC and every visible clock
 * value is explicitly marked with "UTC". Raw aviation telegram syntax is
 * intentionally left untouched (e.g. 101200Z, 1012/1024, FM101300).
 */
(() => {
  'use strict';

  if (window.__PROGNOZA_EPIR_UTC_GUARD__) return;
  window.__PROGNOZA_EPIR_UTC_GUARD__ = true;

  const CLOCK_RE = /\b((?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?!\s*(?:UTC|Z)\b)/g;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'PRE', 'CODE']);
  const WATCHED_ATTRS = ['title', 'aria-label', 'data-tooltip', 'data-title'];

  function markUtc(text) {
    if (typeof text !== 'string' || !text.includes(':')) return text;
    return text.replace(CLOCK_RE, '$1 UTC');
  }

  // All locale-based Date formatting defaults to UTC, regardless of the
  // browser/device timezone. Existing callers therefore cannot silently fall
  // back to local time.
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const original = Date.prototype[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(Date.prototype, name, {
      configurable: true,
      writable: true,
      value: function prognozaUtcLocale(locales, options) {
        return original.call(this, locales, { ...(options || {}), timeZone: 'UTC' });
      }
    });
  }

  // The same rule for direct Intl.DateTimeFormat users.
  if (window.Intl && typeof Intl.DateTimeFormat === 'function') {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    function UtcDateTimeFormat(locales, options) {
      return new NativeDateTimeFormat(locales, { ...(options || {}), timeZone: 'UTC' });
    }
    UtcDateTimeFormat.prototype = NativeDateTimeFormat.prototype;
    Object.setPrototypeOf(UtcDateTimeFormat, NativeDateTimeFormat);
    Intl.DateTimeFormat = UtcDateTimeFormat;
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
    const before = node.nodeValue;
    const after = markUtc(before);
    if (after !== before) node.nodeValue = after;
  }

  function patchAttributes(el) {
    if (!(el instanceof Element) || el.hasAttribute('data-no-utc-ui')) return;
    for (const attr of WATCHED_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const before = el.getAttribute(attr);
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

  // Dynamic modules, Leaflet popups/tooltips, generated tables and status
  // labels are normalized immediately after insertion/update.
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
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRS
  });

  // Canvas clocks (meteogram/chart axes and labels) are not DOM text, so they
  // need the same visible-clock rule at drawing time.
  const CanvasProto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if (CanvasProto && !CanvasProto.__prognozaUtcUiPatched) {
    Object.defineProperty(CanvasProto, '__prognozaUtcUiPatched', { value: true });
    for (const method of ['fillText', 'strokeText']) {
      const original = CanvasProto[method];
      if (typeof original !== 'function') continue;
      CanvasProto[method] = function prognozaUtcCanvas(text, ...args) {
        return original.call(this, markUtc(String(text)), ...args);
      };
    }
  }

  const initialScan = () => document.body && scan(document.body);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialScan, { once: true });
  } else {
    initialScan();
  }

  window.PrognozaUtcUI = Object.freeze({ markUtc, scan });
})();
