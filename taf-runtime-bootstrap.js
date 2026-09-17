'use strict';
(() => {
  if (window.__PROGNOZA_EPIR_TAF_RUNTIME_BOOTSTRAP__) return;
  window.__PROGNOZA_EPIR_TAF_RUNTIME_BOOTSTRAP__ = true;

  const BUILD = '20260917-2';
  const HOUR = 3600000;
  const ISSUE_HOURS = [5, 11, 17, 23];
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const pad = (n, w = 2) => String(Math.max(0, Math.round(n))).padStart(w, '0');

  function fmtUtc(ms, withDate = true) {
    if (!finite(ms)) return '—';
    const d = new Date(ms);
    const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
    return withDate ? `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${hm}` : hm;
  }

  function cycles(now = Date.now()) {
    const base = new Date(now - 18 * HOUR);
    base.setUTCMinutes(0, 0, 0);
    const out = [];
    for (let i = 0; i < 72; i++) {
      const issue = base.getTime() + i * HOUR;
      if (!ISSUE_HOURS.includes(new Date(issue).getUTCHours())) continue;
      const start = issue + HOUR;
      const end = start + 12 * HOUR;
      if (issue >= now - 8 * HOUR && issue <= now + 30 * HOUR) out.push({ issue, start, end });
    }
    return out;
  }

  function primeCycleSelect() {
    const select = $('cycle');
    if (!select) return false;
    const now = Date.now();
    const list = cycles(now);
    if (!list.length) {
      select.innerHTML = '<option value="">Brak dostępnych cykli</option>';
      return false;
    }
    let best = 0;
    let bestScore = Infinity;
    select.innerHTML = list.map((c, i) => {
      let score = c.issue >= now ? c.issue - now : (now - c.issue) + 12 * HOUR;
      if (now >= c.issue - 20 * 60000 && now <= c.issue + 5 * 60000) score = 0;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
      return `<option value="${i}">${fmtUtc(c.issue)} → ${fmtUtc(c.start, false)}–${fmtUtc(c.end, false)}</option>`;
    }).join('');
    select.value = String(best);
    select.dataset.cycles = JSON.stringify(list);
    return true;
  }

  function setStatus(text, bad = false) {
    const st = $('st');
    const badge = $('badge');
    if (st) st.textContent = text;
    if (badge) {
      badge.textContent = bad ? 'TAF ENGINE 2.4.2 · BŁĄD STARTU' : 'TAF ENGINE 2.4.2 · START';
      badge.className = bad ? 'badge bad' : 'badge';
    }
  }

  function loadScript(src, id) {
    const existing = document.getElementById(id);
    if (existing) {
      if (existing.dataset.loaded === '1') return Promise.resolve();
      return new Promise((resolve, reject) => {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error(`Nie udało się załadować ${src}`)), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.id = id;
      s.src = src;
      s.async = false;
      s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
      s.addEventListener('error', () => reject(new Error(`Nie udało się załadować ${src}`)), { once: true });
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function waitForPolicy(ms = 2500) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (window.PrognozaEPIRTAFFogPolicy) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return Boolean(window.PrognozaEPIRTAFFogPolicy);
  }

  async function boot() {
    primeCycleSelect();
    setStatus('inicjalizacja interfejsu TAF');

    if (!(await waitForPolicy())) {
      await loadScript(`taf-fog-policy.js?v=${BUILD}`, 'taf-fog-policy-recovery');
    }
    if (!window.PrognozaEPIRTAFFogPolicy) throw new Error('TAF Fog Policy nie został załadowany');

    window.__PROGNOZA_EPIR_TAF_APP_V25__ = false;
    await loadScript(`taf-app-v25.js?v=${BUILD}`, 'taf-app-v25-runtime');

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !window.__PROGNOZA_EPIR_TAF_APP_V25__) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!window.__PROGNOZA_EPIR_TAF_APP_V25__) {
      throw new Error('Interfejs generatora TAF nie uruchomił się');
    }
  }

  function start() {
    primeCycleSelect();
    boot().catch(err => {
      console.error('[TAF bootstrap]', err);
      setStatus(err && err.message ? err.message : 'Błąd uruchamiania generatora', true);
      const taf = $('taf');
      if (taf) taf.textContent = 'Generator TAF nie wystartował. Odśwież stronę po wdrożeniu poprawki.';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
