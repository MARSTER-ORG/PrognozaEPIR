'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__PROGNOZA_EPIR_FOG_VISIBILITY_CELLS__) return;
  window.__PROGNOZA_EPIR_FOG_VISIBILITY_CELLS__ = true;

  const HOUR = 3600e3;
  const finite = Number.isFinite;
  const num = v => v !== null && v !== undefined && v !== '' && finite(Number(v)) ? Number(v) : null;
  let timer = null;

  function mode() {
    try {
      if (window.PrognozaEPIRFogMode?.get) return window.PrognozaEPIRFogMode.get() === 'vnext' ? 'vnext' : 'legacy';
      return localStorage.getItem('prognozaepir-fog-engine-mode') === 'vnext' ? 'vnext' : 'legacy';
    } catch (_) { return 'legacy'; }
  }

  function fogSeries() {
    const m = mode();
    if (m === 'vnext' && Array.isArray(window.PrognozaEPIRFogVNextSeries) && window.PrognozaEPIRFogVNextSeries.length)
      return window.PrognozaEPIRFogVNextSeries;
    if (m === 'legacy' && Array.isArray(window.PrognozaEPIRFogLegacySeries) && window.PrognozaEPIRFogLegacySeries.length)
      return window.PrognozaEPIRFogLegacySeries;
    return Array.isArray(window.PrognozaEPIRFogSeries) ? window.PrognozaEPIRFogSeries : [];
  }

  function brSeries() {
    return Array.isArray(window.PrognozaEPIRBRSeries) ? window.PrognozaEPIRBRSeries : [];
  }

  function mifgSeries() {
    try {
      const rows = window.PrognozaEPIRMIFG?.getSeries?.();
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }

  function nearest(rows, t, maxDiff = 75 * 60e3) {
    let best = null, bd = Infinity;
    for (const r of rows || []) {
      const rt = num(r?.t);
      if (!finite(rt)) continue;
      const d = Math.abs(rt - t);
      if (d < bd) { bd = d; best = r; }
    }
    return bd <= maxDiff ? best : null;
  }

  function fogVisibility(row) {
    if (!row) return null;
    if (mode() === 'vnext') return num(row?.visGuidance?.point) ?? num(row?.visProposed) ?? num(row?.vis);
    return num(row?.vis);
  }

  function fmtVis(v) {
    if (!finite(v)) return '—';
    const x = Math.max(0, Math.round(v));
    return x >= 10000 ? `${(x / 1000).toFixed(1)} km` : `${x} m`;
  }

  function fmtUtcDate(t) {
    if (!finite(t)) return '—';
    try {
      return new Intl.DateTimeFormat('pl-PL', {timeZone:'UTC', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(t)) + ' UTC';
    } catch (_) {
      const d=new Date(t); return d.toISOString().slice(8,10)+'.'+d.toISOString().slice(5,7)+' '+d.toISOString().slice(11,16)+' UTC';
    }
  }

  function ensureCard(host, id, className) {
    if (!host) return null;
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = className;
      host.appendChild(el);
    }
    el.hidden = false;
    return el;
  }

  function updateFg() {
    const host = document.getElementById('fogSummary');
    if (!host) return;
    const now = Date.now();
    const rows = fogSeries().filter(r => {
      const t = num(r?.t), s = num(r?.score), v = fogVisibility(r);
      return finite(t) && t >= now - HOUR && t <= now + 48 * HOUR && finite(s) && s >= 50 && finite(v) && v < 1000;
    });
    const card = ensureCard(host, 'fgEstimatedVisCard', 'fog-card');
    if (!card) return;
    if (!rows.length) {
      card.innerHTML = `<small>FG · szacowana VIS</small><strong>—</strong><em>brak aktywnego FG w 48 h · ${mode() === 'vnext' ? 'vNEXT' : 'LEGACY'}</em>`;
      return;
    }
    const min = rows.reduce((a, b) => fogVisibility(b) < fogVisibility(a) ? b : a, rows[0]);
    card.innerHTML = `<small>FG · szacowana VIS</small><strong>${fmtVis(fogVisibility(min))}</strong><em>minimum przy aktywnym FG · ${fmtUtcDate(num(min.t))} · ${mode() === 'vnext' ? 'vNEXT' : 'LEGACY'}</em>`;
  }

  function updateBr() {
    const host = document.getElementById('brSummary');
    if (!host) return;
    for (const old of host.children) {
      const label = old.querySelector?.('small')?.textContent || '';
      if (/^\s*Oczekiwana VIS przy BR\s*$/i.test(label)) old.style.display = 'none';
    }
    const now = Date.now();
    const active = brSeries().filter(r => finite(num(r?.t)) && num(r.t) >= now - HOUR && num(r.t) <= now + 24 * HOUR && finite(num(r?.score)) && num(r.score) >= 50);
    const card = ensureCard(host, 'brEstimatedVisCard', 'br-card');
    if (!card) return;
    if (!active.length) {
      card.innerHTML = '<small>BR · szacowana VIS</small><strong>—</strong><em>brak aktywnego BR w 24 h</em>';
      return;
    }

    const withBandVis = active.filter(r => finite(num(r?.visibility)) && num(r.visibility) >= 1000 && num(r.visibility) <= 5000);
    const ref = withBandVis.length
      ? withBandVis.reduce((a,b) => num(b.visibility) < num(a.visibility) ? b : a, withBandVis[0])
      : active.reduce((a,b) => num(b.score) > num(a.score) ? b : a, active[0]);
    const actual = num(ref?.visibility);
    const estimate = finite(actual) && actual >= 1000 && actual <= 5000
      ? fmtVis(actual)
      : (window.PrognozaEPIRBREngine?.expectedVis?.(ref) || '—');
    card.innerHTML = `<small>BR · szacowana VIS</small><strong>${estimate}</strong><em>${fmtUtcDate(num(ref.t))} · zakres BR 1000–5000 m</em>`;
  }

  function updateMifg() {
    const host = document.getElementById('mifgStandaloneSummary');
    if (!host) return;
    const now = Date.now();
    const active = mifgSeries().filter(r => finite(num(r?.t)) && num(r.t) >= now - HOUR && num(r.t) <= now + 48 * HOUR && finite(num(r?.score)) && num(r.score) >= 50);
    const card = ensureCard(host, 'mifgVisibilityContextCard', 'mifg-card');
    if (!card) return;
    if (!active.length) {
      card.innerHTML = '<small>MIFG · VIS standardowa</small><strong>—</strong><em>brak aktywnego MIFG w 48 h</em>';
      return;
    }

    const peak = active.reduce((a,b) => num(b.score) > num(a.score) ? b : a, active[0]);
    const fog = nearest(fogSeries(), num(peak.t));
    const stdVis = fogVisibility(fog);
    card.innerHTML = `<small>MIFG · VIS standardowa</small><strong>${fmtVis(stdVis)}</strong><em>${fmtUtcDate(num(peak.t))} · nie jest to VIS warstwy &lt;2 m</em>`;
  }

  function render() {
    updateFg();
    updateBr();
    updateMifg();
  }

  function schedule(delay = 80) {
    clearTimeout(timer);
    timer = setTimeout(render, delay);
  }

  for (const ev of ['prognozaepir:fog-series-updated','prognozaepir:fog-vnext-updated','prognozaepir:br-series-updated','prognozaepir:mifg-series-updated','prognozaepir:fog-engine-mode-applied']) {
    window.addEventListener(ev, () => schedule());
  }

  const start = () => {
    schedule(250);
    setTimeout(render, 1200);
    setTimeout(render, 3500);
    setInterval(render, 60000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
