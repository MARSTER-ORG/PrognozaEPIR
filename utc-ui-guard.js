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
  // GeoTIFF/radar module. Direct CloudFerro and legacy Railway proxy URLs are
  // normalized to the merged central-ingestor endpoint.
  try {
    if (/\/radar\.html$/i.test(location.pathname) && !window.__PROGNOZA_EPIR_OPERA_EARLY_PROXY__) {
      const nativeFetch = window.fetch.bind(window);
      const LIVE_PROXY = 'https://central-ingestor-production.up.railway.app/opera/dbzh/';
      const LEGACY_PROXY = 'https://opera-cmax-live-production.up.railway.app/opera/dbzh/';
      const S3_PREFIX = 'https://s3.waw3-1.cloudferro.com/openradar-24h/';
      const operaToken = value => {
        const url = String(value || '');
        let m = url.match(/OPERA@(20\d{6})T(\d{4})@0@DBZH\.tiff(?:[?#].*)?$/i);
        if (m && url.startsWith(S3_PREFIX)) return m[1] + m[2];
        m = url.match(/\/opera\/dbzh\/(20\d{10})\.tiff(?:[?#].*)?$/i);
        if (m && (url.startsWith(LIVE_PROXY) || url.startsWith(LEGACY_PROXY))) return m[1];
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

  [50,250,750,1500,3000,6000,12000].forEach(ms => setTimeout(scanAll, ms));
  setInterval(scanAll, 30000);

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

  try {
    const CanvasProto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
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

  function installGlobalNavigation() {
    try {
      if (window.top !== window.self) return;
    } catch (_) { return; }

    const install = () => {
      if (!document.body || document.getElementById('epirGlobalNav')) return;
      const path = location.pathname.toLowerCase();
      const pages = [
        {label:'METEOGRAM', href:'index.html', active: /\/(?:index\.html)?$/.test(path)},
        {label:'RADAR', href:'radar.html', active: /\/radar\.html$/.test(path)},
        {label:'MGŁA SAT', href:'sat-fog.html', active: /\/sat-fog\.html$/.test(path)},
        {label:'TAF GENERATOR', href:'taf.html', active: /\/taf\.html$/.test(path)},
        {label:'ARCHIWUM', href:'arch.html', active: /\/arch\.html$/.test(path)}
      ];
      const allowed = pages.some(x => x.active);
      if (!allowed) return;

      if (!document.getElementById('epirGlobalNavStyle')) {
        const style = document.createElement('style');
        style.id = 'epirGlobalNavStyle';
        style.textContent = `
          #epirGlobalNav{width:100%;border-bottom:1px solid var(--epir-border,var(--border,var(--line,var(--b,#777))));background:var(--epir-surface,var(--surface,var(--panel,var(--s,var(--bg,#fff)))));box-shadow:0 1px 5px rgba(0,0,0,.08)}
          #epirGlobalNav .epir-global-nav-inner{max-width:1320px;margin:0 auto;padding:7px 8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
          #epirGlobalNav a{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:7px 11px;border:1px solid var(--epir-border,var(--border,var(--line,var(--b,#888))));border-radius:8px;background:var(--epir-surface2,var(--surface2,var(--panel2,var(--s2,var(--surface,#f7f7f7)))));color:var(--epir-text,var(--ink,var(--text,var(--fg,#222))));font:700 11px/1 Arial,Helvetica,sans-serif;text-decoration:none;white-space:nowrap}
          #epirGlobalNav a:hover{filter:brightness(.97)}
          #epirGlobalNav a.active{background:var(--epir-accent,var(--blueText,var(--blue2,var(--blue,var(--accent,#1f2a75)))));border-color:var(--epir-accent,var(--blueText,var(--blue2,var(--blue,var(--accent,#1f2a75)))));color:#fff}
          @media(max-width:620px){#epirGlobalNav .epir-global-nav-inner{padding:5px 4px;gap:4px}#epirGlobalNav a{flex:1 1 calc(33.333% - 4px);min-width:96px;min-height:30px;padding:6px 7px;font-size:9.5px}}
        `;
        document.head.appendChild(style);
      }

      const nav = document.createElement('nav');
      nav.id = 'epirGlobalNav';
      nav.setAttribute('aria-label','Główna nawigacja PrognozaEPIR');
      nav.innerHTML = '<div class="epir-global-nav-inner">' + pages.map(p =>
        `<a href="${p.href}"${p.active?' class="active" aria-current="page"':''}>${p.label}</a>`
      ).join('') + '</div>';
      document.body.insertBefore(nav, document.body.firstChild);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
    else install();
  }
  installGlobalNavigation();

  function installUnifiedVisualStyle() {
    try {
      if (window.top !== window.self) return;
    } catch (_) { return; }

    const path = location.pathname.toLowerCase();
    const allowed = /\/(?:index\.html|radar\.html|sat-fog\.html|taf\.html|arch\.html)?$/.test(path);
    if (!allowed) return;

    const install = () => {
      if (!document.documentElement || document.getElementById('epirUnifiedVisualStyle')) return;
      document.documentElement.classList.add('epir-unified-ui');
      const style = document.createElement('style');
      style.id = 'epirUnifiedVisualStyle';
      style.textContent = `
        :root.epir-unified-ui{
          --epir-bg:#f4f4f2;--epir-text:#232323;--epir-muted:#6e6e6e;--epir-border:#b5b5b5;
          --epir-surface:#ffffff;--epir-surface2:#f7f7f7;--epir-accent:#1f2a75;--epir-shadow:0 2px 10px rgba(0,0,0,.08);
          --bg:var(--epir-bg)!important;--ink:var(--epir-text)!important;--fg:var(--epir-text)!important;--text:var(--epir-text)!important;
          --muted:var(--epir-muted)!important;--mut:var(--epir-muted)!important;
          --border:var(--epir-border)!important;--line:var(--epir-border)!important;--b:var(--epir-border)!important;
          --surface:var(--epir-surface)!important;--panel:var(--epir-surface)!important;--s:var(--epir-surface)!important;
          --surface2:var(--epir-surface2)!important;--panel2:var(--epir-surface2)!important;--s2:var(--epir-surface2)!important;
          --blueText:var(--epir-accent)!important;--blue2:var(--epir-accent)!important;--blue:var(--epir-accent)!important;--accent:var(--epir-accent)!important;
        }
        :root.epir-unified-ui[data-theme="dark"]{
          --epir-bg:#111418;--epir-text:#e7e9ed;--epir-muted:#a6acb5;--epir-border:#4e5660;
          --epir-surface:#181c21;--epir-surface2:#20252b;--epir-accent:#9aabff;--epir-shadow:none;
        }
        @media(prefers-color-scheme:dark){:root.epir-unified-ui:not([data-theme]){
          --epir-bg:#111418;--epir-text:#e7e9ed;--epir-muted:#a6acb5;--epir-border:#4e5660;
          --epir-surface:#181c21;--epir-surface2:#20252b;--epir-accent:#9aabff;--epir-shadow:none;
        }}
        html.epir-unified-ui,html.epir-unified-ui body{background:var(--epir-bg)!important;color:var(--epir-text)!important;font-family:Arial,Helvetica,sans-serif!important}
        html.epir-unified-ui .app{max-width:1320px!important;margin:0 auto!important;padding:8px 8px 24px!important}
        html.epir-unified-ui .top{display:flex!important;justify-content:space-between!important;gap:12px!important;align-items:flex-start!important;padding:8px 4px 7px!important;margin:0!important}
        html.epir-unified-ui .brand{font-size:17px!important;font-weight:700!important;line-height:1.2!important}
        html.epir-unified-ui .brand small,html.epir-unified-ui .sub{font-weight:400!important;color:var(--epir-muted)!important}
        html.epir-unified-ui .place{font-size:12px!important;color:var(--epir-accent)!important;margin-top:3px!important}
        html.epir-unified-ui .status{font-size:10px!important;color:var(--epir-muted)!important;text-align:right!important}
        html.epir-unified-ui .badge,html.epir-unified-ui .pill{border:1px solid var(--epir-border)!important;background:var(--epir-surface)!important;border-radius:999px!important;padding:4px 8px!important}
        html.epir-unified-ui .controls,html.epir-unified-ui .ctrl,html.epir-unified-ui .toolbar{
          display:flex!important;flex-wrap:wrap!important;gap:6px!important;align-items:center!important;
          border:1px solid var(--epir-border)!important;background:var(--epir-surface)!important;
          padding:8px!important;border-radius:8px!important;box-shadow:var(--epir-shadow)!important;margin:0 0 8px!important;
        }
        html.epir-unified-ui .toolbar{align-items:end!important}
        html.epir-unified-ui button,html.epir-unified-ui select,html.epir-unified-ui input,
        html.epir-unified-ui .link,html.epir-unified-ui .control-link,html.epir-unified-ui .home{
          border-color:var(--epir-border)!important;border-radius:7px!important;
        }
        html.epir-unified-ui .controls button,html.epir-unified-ui .controls select,
        html.epir-unified-ui .ctrl button,html.epir-unified-ui .ctrl select,html.epir-unified-ui .ctrl .link,
        html.epir-unified-ui .toolbar button,html.epir-unified-ui .toolbar select,html.epir-unified-ui .toolbar input,html.epir-unified-ui .toolbar a,
        html.epir-unified-ui .home,html.epir-unified-ui .control-link{
          min-height:32px!important;background:var(--epir-surface2)!important;color:var(--epir-text)!important;
          border:1px solid var(--epir-border)!important;padding:7px 9px!important;font-size:11px!important;text-decoration:none!important;
        }
        html.epir-unified-ui button.primary,html.epir-unified-ui .primary,
        html.epir-unified-ui .controls button.active,html.epir-unified-ui .toolbar button.active,html.epir-unified-ui .types button.active{
          background:var(--epir-accent)!important;color:#fff!important;border-color:var(--epir-accent)!important;
        }
        html.epir-unified-ui .card,html.epir-unified-ui .panel,html.epir-unified-ui .wrap,html.epir-unified-ui .mapwrap{
          border:1px solid var(--epir-border)!important;border-radius:8px!important;background:var(--epir-surface)!important;box-shadow:var(--epir-shadow)!important;
        }
        html.epir-unified-ui .card h2{color:var(--epir-accent)!important;border-color:var(--epir-border)!important}
        html.epir-unified-ui .panel h3,html.epir-unified-ui .panel h4{color:var(--epir-accent)}
        html.epir-unified-ui .section-info,html.epir-unified-ui .interpret,html.epir-unified-ui .beam,html.epir-unified-ui .metric,
        html.epir-unified-ui .section-value,html.epir-unified-ui .empty{
          background:var(--epir-surface2)!important;border-color:var(--epir-border)!important;
        }
        html.epir-unified-ui table{background:var(--epir-surface)!important;color:var(--epir-text)!important}
        html.epir-unified-ui th{background:var(--epir-surface2)!important;color:var(--epir-accent)!important}
        html.epir-unified-ui td,html.epir-unified-ui th{border-color:var(--epir-border)!important}
        html.epir-unified-ui .legend-row{border-color:var(--epir-border)!important;background:var(--epir-surface2)!important}
        html.epir-unified-ui #epirGlobalNav{background:var(--epir-surface)!important;border-color:var(--epir-border)!important}
        html.epir-unified-ui #epirGlobalNav a{background:var(--epir-surface2)!important;border-color:var(--epir-border)!important;color:var(--epir-text)!important}
        html.epir-unified-ui #epirGlobalNav a.active{background:var(--epir-accent)!important;border-color:var(--epir-accent)!important;color:#fff!important}
        @media(max-width:700px){
          html.epir-unified-ui .app{padding:5px 4px 18px!important}
          html.epir-unified-ui .top{padding:6px 2px!important}
          html.epir-unified-ui .brand{font-size:15px!important}
          html.epir-unified-ui .place{font-size:11px!important}
          html.epir-unified-ui .controls,html.epir-unified-ui .ctrl,html.epir-unified-ui .toolbar{padding:6px!important;gap:4px!important}
        }
      `;
      document.head.appendChild(style);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
    else install();
  }
  installUnifiedVisualStyle();

  function removeRedundantLocalNavigation() {
    try {
      if (window.top !== window.self) return;
    } catch (_) { return; }

    const install = () => {
      const path = location.pathname.toLowerCase();
      let selectors = [];
      if (/\/(?:index\.html)?$/.test(path)) {
        selectors = [
          '.controls a[href="arch.html"]',
          '.controls a[href="radar.html"]',
          '.controls a[href="taf.html"]',
          '.controls a[href="sat-fog.html"]'
        ];
      } else if (/\/taf\.html$/.test(path)) {
        selectors = ['.ctrl a[href="index.html"]','.ctrl a[href="radar.html"]'];
      } else if (/\/radar\.html$/.test(path)) {
        selectors = ['.toolbar a[href="index.html"]'];
      } else if (/\/arch\.html$/.test(path)) {
        selectors = ['.top a.home[href="index.html"]'];
      }
      selectors.forEach(selector => document.querySelectorAll(selector).forEach(el => el.remove()));
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
    else install();
  }
  removeRedundantLocalNavigation();

  function loadTafGeneratorPolicy() {
    if (!/\/taf\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_TAF_POLICY_LOADER__) return;
    window.__PROGNOZA_EPIR_TAF_POLICY_LOADER__ = true;
    const load = () => {
      if (document.querySelector('script[data-taf-generator-policy]')) return;
      const s = document.createElement('script');
      s.src = 'taf-generator-policy.js?v=20260912-fewsct12h-live-v10';
      s.async = false;
      s.dataset.tafGeneratorPolicy = '1';
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, {once:true});
    else load();
  }
  loadTafGeneratorPolicy();

  function loadRadarRiskPolicy() {
    if (!/\/radar\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_RADAR_RISK_POLICY_LOADER__) return;
    window.__PROGNOZA_EPIR_RADAR_RISK_POLICY_LOADER__ = true;
    const load = () => {
      if (document.querySelector('script[data-radar-risk-policy]')) return;
      const s = document.createElement('script');
      s.src = 'radar-risk-policy.js?v=20260911-hail-v2';
      s.async = false;
      s.dataset.radarRiskPolicy = '1';
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, {once:true});
    else load();
  }
  loadRadarRiskPolicy();

  function installRadarLightningAlertButton() {
    if (!/\/radar\.html$/i.test(location.pathname)) return;
    const install = () => {
      const toolbar = document.querySelector('.toolbar');
      if (!toolbar || document.getElementById('lightningAlertsSettings')) return;
      const link = document.createElement('a');
      link.id = 'lightningAlertsSettings';
      link.href = 'data/messages/lightning-alerts.html';
      link.textContent = '⚡ Alarm wyładowań';
      link.title = 'Ustawienia powiadomień o wyładowaniach do 50 km od EPIR';
      link.setAttribute('aria-label','Ustawienia alarmu wyładowań');
      const spacer = toolbar.querySelector('.spacer');
      if (spacer) spacer.insertAdjacentElement('afterend', link);
      else toolbar.appendChild(link);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
    else install();
  }
  installRadarLightningAlertButton();

  window.PrognozaUtcUI = Object.freeze({ markUtc, scan, scanAll });
})();