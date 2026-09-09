'use strict';
(() => {
  function normalizeTafTerminator(text) {
    const lines = String(text || '')
      .split(/\n+/)
      .map(line => line.replace(/=/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return lines.length ? lines.join('\n') + '=' : '';
  }

  const api = Object.freeze({ normalizeTafTerminator });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.PrognozaEPIRTAFOutputSanitizer = api;
  if (!/\/taf\.html$/i.test(location.pathname)) return;

  let applying = false;
  let queued = false;

  function apply() {
    if (applying) return;
    const el = document.getElementById('taf');
    if (!el) return;
    const current = String(el.textContent || '');
    if (!/^\s*TAF\s+(?:AMD\s+|COR\s+)?EPIR\b/.test(current)) return;
    const clean = normalizeTafTerminator(current);
    if (!clean || clean === current) return;
    applying = true;
    el.textContent = clean;
    applying = false;
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      apply();
    });
  }

  function install() {
    const el = document.getElementById('taf');
    if (!el) return;
    new MutationObserver(schedule).observe(el, {childList:true, characterData:true, subtree:true});
    schedule();
    // Dodatkowe zabezpieczenie przed późnymi, asynchronicznymi modyfikacjami
    // innych polityk TAF. Sanitizer jest idempotentny, więc kontrola jest tania.
    setInterval(apply, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();