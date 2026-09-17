'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__PROGNOZA_EPIR_FOG_PAGE_LAYOUT__) return;
  window.__PROGNOZA_EPIR_FOG_PAGE_LAYOUT__ = true;

  const HOUR = 3600e3;
  const finite = Number.isFinite;
  const num = v => v !== null && v !== undefined && v !== '' && finite(Number(v)) ? Number(v) : null;
  let scheduled = false;

  function fmtUtc(t) {
    if (!finite(t)) return '—';
    try {
      return new Intl.DateTimeFormat('pl-PL', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).format(new Date(t)) + ' UTC';
    } catch (_) {
      return new Date(t).toISOString().slice(11, 16) + ' UTC';
    }
  }

  function fmtUtcDate(t) {
    if (!finite(t)) return '—';
    try {
      return new Intl.DateTimeFormat('pl-PL', {
        timeZone:'UTC', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
      }).format(new Date(t)) + ' UTC';
    } catch (_) {
      const d=new Date(t); return d.toISOString().slice(8,10)+'.'+d.toISOString().slice(5,7)+' '+d.toISOString().slice(11,16)+' UTC';
    }
  }

  function classify(score) {
    if (!finite(score)) return 'BRAK DANYCH';
    if (score < 50) return 'NIE';
    if (score < 60) return 'MOŻLIWE';
    if (score < 80) return 'PRAWDOPODOBNE';
    return 'BARDZO PRAWDOPODOBNE';
  }

  function riskClass(score) {
    if (!finite(score) || score < 50) return '';
    if (score >= 80) return 'mifg-vhigh';
    if (score >= 60) return 'mifg-high';
    return 'mifg-mid';
  }

  function ensureStyle() {
    if (document.getElementById('fogPageLayoutStyle')) return;
    const style = document.createElement('style');
    style.id = 'fogPageLayoutStyle';
    style.textContent = `
      #epirGlobalNav.epir-global-nav{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px;margin:0 0 8px;padding:6px;border:1px solid var(--border);border-radius:9px;background:var(--surface);position:relative;z-index:2}
      #epirGlobalNav.epir-global-nav a{display:flex;align-items:center;justify-content:center;min-height:34px;padding:7px 8px;border:1px solid var(--border);border-radius:7px;background:var(--surface2);color:var(--ink);font-size:10px;font-weight:700;text-decoration:none;text-align:center}
      #epirGlobalNav.epir-global-nav a.active,#epirGlobalNav.epir-global-nav a[aria-current="page"]{background:var(--blueText);border-color:var(--blueText);color:#fff}
      #fogSummary #mifgCard,#mifgNote{display:none!important}
      .mifg-engine-standalone{margin-top:8px;border:1px solid var(--border);background:var(--surface);border-radius:4px;padding:9px 10px;font-size:10px;line-height:1.35}
      .mifg-head{display:flex;justify-content:space-between;gap:8px;align-items:center;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:7px}
      .mifg-head b{color:var(--blueText);font-size:12px}.mifg-head span{color:var(--muted);font-size:9px;text-align:right}
      .mifg-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.mifg-card{background:var(--soft);border-left:3px solid var(--blueText);padding:6px 7px;min-width:0}
      .mifg-card small{display:block;color:var(--muted);font-size:8px}.mifg-card strong{display:block;font-size:12px;margin-top:1px}.mifg-card em{display:block;color:var(--muted);font-style:normal;font-size:8px;margin-top:1px}
      .mifg-mid{border-left-color:#d49a28}.mifg-high{border-left-color:#d86c2f}.mifg-vhigh{border-left-color:#d0503f}
      .mifg-hours{display:flex;gap:4px;overflow-x:auto;margin-top:7px;padding:5px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
      .mifg-hour{flex:0 0 92px;background:var(--soft);border:1px solid var(--border);border-radius:4px;padding:5px;text-align:center}.mifg-hour b{display:block;font-size:9px}.mifg-hour strong{display:block;font-size:10px;margin:2px 0}.mifg-hour small{display:block;color:var(--muted);font-size:8px}
      .mifg-note{margin-top:7px;padding:5px 7px;background:var(--soft);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:8.5px}.mifg-note b{color:var(--ink)}
      @media(max-width:700px){#epirGlobalNav.epir-global-nav{grid-template-columns:repeat(3,minmax(0,1fr));padding:5px}#epirGlobalNav.epir-global-nav a{font-size:9px;min-height:32px;padding:6px 4px}.mifg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.mifg-engine-standalone{padding:8px}.mifg-head b{font-size:11px}}
    `;
    document.head.appendChild(style);
  }

  function ensureGlobalNav() {
    const app = document.querySelector('.app') || document.body;
    let nav = document.getElementById('epirGlobalNav');
    if (!nav) {
      nav = document.createElement('nav');
      nav.id = 'epirGlobalNav';
      nav.setAttribute('aria-label', 'Główna nawigacja PrognozaEPIR');
      nav.innerHTML = `
        <a href="index.html">METEOGRAM</a>
        <a href="fog.html" class="active" aria-current="page">EPIR FOG</a>
        <a href="radar.html">RADAR</a>
        <a href="sat-fog.html">MGŁA SAT</a>
        <a href="taf.html">TAF GENERATOR</a>
        <a href="arch.html">ARCHIWUM</a>`;
      app.insertBefore(nav, app.firstChild);
    }
    nav.classList.add('epir-global-nav');
    for (const a of nav.querySelectorAll('a')) {
      const target = (a.getAttribute('href') || '').split('?')[0];
      const current = target === 'fog.html';
      a.classList.toggle('active', current);
      if (current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (app.firstElementChild !== nav) app.insertBefore(nav, app.firstChild);
    return nav;
  }

  function cleanEmbeddedMifg() {
    document.getElementById('mifgCard')?.remove();
    document.getElementById('mifgNote')?.remove();
    const summary = document.getElementById('fogSummary');
    if (!summary) return;
    for (const card of [...summary.children]) {
      const title = card.querySelector?.('small')?.textContent || '';
      if (/^\s*MIFG\s*$/i.test(title)) card.remove();
    }
  }

  function ensureMifgPanel() {
    let panel = document.getElementById('mifgEngineStandalone');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'mifgEngineStandalone';
      panel.className = 'mifg-engine-standalone';
      panel.innerHTML = `
        <div class="mifg-head"><b>MGŁA PRZYZIEMNA (MIFG)</b><span>oddzielny target · warstwa &lt;2 m</span></div>
        <div id="mifgStandaloneSummary" class="mifg-grid"><div class="mifg-card"><small>Status</small><strong>Ładowanie…</strong></div></div>
        <div id="mifgStandaloneHours" class="mifg-hours" hidden></div>
        <div id="mifgStandaloneNote" class="mifg-note"><b>MIFG:</b> oczekiwanie na serię godzinową.</div>`;
    }
    return panel;
  }

  function positionModules() {
    const fog = document.getElementById('fogEngine');
    const br = document.getElementById('brEngine');
    const mifg = ensureMifgPanel();

    // Kolejność operacyjna podstrony: FG -> BR -> MIFG.
    if (fog && br && fog.nextElementSibling !== br) fog.insertAdjacentElement('afterend', br);
    const anchor = br || fog || document.getElementById('fogStandaloneMount');
    if (anchor && anchor.nextElementSibling !== mifg) anchor.insertAdjacentElement('afterend', mifg);
    else if (!mifg.isConnected) (document.getElementById('fogStandaloneMount') || document.querySelector('.app') || document.body).appendChild(mifg);
  }

  function mifgSeries() {
    try {
      const rows = window.PrognozaEPIRMIFG?.getSeries?.();
      return Array.isArray(rows) ? rows.filter(r => finite(num(r?.t))).sort((a,b) => num(a.t)-num(b.t)) : [];
    } catch (_) {
      return [];
    }
  }

  function mifgStatus() {
    try { return window.PrognozaEPIRMIFG?.getStatus?.() || {}; }
    catch (_) { return {}; }
  }

  function nearest(rows, t) {
    let best = null, bd = Infinity;
    for (const row of rows) {
      const rt = num(row?.t), d = finite(rt) ? Math.abs(rt - t) : Infinity;
      if (d < bd) { bd = d; best = row; }
    }
    return best;
  }

  function firstActiveWindow(rows) {
    const first = rows.findIndex(r => finite(num(r?.score)) && num(r.score) >= 50);
    if (first < 0) return null;
    let last = first;
    while (last + 1 < rows.length) {
      const prevT = num(rows[last]?.t), nextT = num(rows[last + 1]?.t), nextS = num(rows[last + 1]?.score);
      if (!finite(nextS) || nextS < 50 || !finite(prevT) || !finite(nextT) || nextT - prevT > 90 * 60e3) break;
      last++;
    }
    return {from:num(rows[first].t), to:num(rows[last + 1]?.t) ?? (num(rows[last].t) + HOUR)};
  }

  function renderMifg() {
    ensureStyle();
    ensureGlobalNav();
    cleanEmbeddedMifg();
    positionModules();

    const summary = document.getElementById('mifgStandaloneSummary');
    const hours = document.getElementById('mifgStandaloneHours');
    const note = document.getElementById('mifgStandaloneNote');
    if (!summary || !hours || !note) return false;

    const rows = mifgSeries();
    const status = mifgStatus();
    const now = Date.now();
    const horizon = rows.filter(r => {
      const t = num(r?.t);
      return finite(t) && t >= now - HOUR && t <= now + 48 * HOUR;
    });

    if (!horizon.length) {
      summary.innerHTML = `<div class="mifg-card"><small>Status</small><strong>Ładowanie…</strong><em>${status.error ? String(status.error) : 'oczekiwanie na dane MIFG'}</em></div>`;
      hours.hidden = true;
      note.innerHTML = '<b>MIFG:</b> brak gotowej serii godzinowej.';
      return false;
    }

    const current = nearest(horizon, now) || horizon[0];
    const peak = horizon.reduce((a,b) => !a || (num(b?.score) ?? -1) > (num(a?.score) ?? -1) ? b : a, null) || current;
    const win = firstActiveWindow(horizon);
    const cs = num(current?.score), ps = num(peak?.score);
    const source = String(status.source || current?.source || '—');

    summary.innerHTML = `
      <div class="mifg-card ${riskClass(cs)}"><small>MIFG teraz / najbliższa godzina</small><strong>${classify(cs)}</strong><em>${finite(cs) ? Math.round(cs) + '/100 · ' + fmtUtc(num(current.t)) : '—'}</em></div>
      <div class="mifg-card ${riskClass(ps)}"><small>Maksimum MIFG w 48 h</small><strong>${classify(ps)}</strong><em>${finite(ps) ? Math.round(ps) + '/100 · ' + fmtUtcDate(num(peak.t)) : '—'}</em></div>
      <div class="mifg-card"><small>Okno MIFG ≥50/100</small><strong>${win ? `${fmtUtcDate(win.from)}–${fmtUtcDate(win.to)}` : 'brak w 48 h'}</strong><em>ten sam próg co na meteogramie</em></div>
      <div class="mifg-card"><small>Źródło</small><strong>${source}</strong><em>${status.error ? 'fallback / błąd źródła głównego' : 'seria operacyjna'}</em></div>`;

    const display = horizon.filter(r => num(r?.t) >= now - HOUR).slice(0, 30);
    hours.hidden = !display.length;
    hours.innerHTML = display.map(r => {
      const s = num(r?.score);
      return `<div class="mifg-hour ${riskClass(s)}"><b>${fmtUtc(num(r.t))}</b><strong>${classify(s)}</strong><small>${finite(s) ? Math.round(s) + '/100' : '—'}</small></div>`;
    }).join('');

    note.innerHTML = `<b>Jak czytać MIFG:</b> kafel „teraz” dotyczy najbliższej godziny, natomiast meteogram pokazuje score dla godziny wskazanej kursorem. Maksimum powyżej jest liczone z pełnych 48 h i korzysta z dokładnie tej samej serii MIFG co meteogram. Dlatego przyszła godzina może mieć np. 60+/100, gdy bieżąca godzina nadal ma status NIE.`;
    return true;
  }

  function scheduleRender(delay = 0) {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      renderMifg();
    }, delay);
  }

  window.addEventListener('prognozaepir:mifg-series-updated', () => scheduleRender(0));
  window.addEventListener('prognozaepir:fog-series-updated', () => scheduleRender(0));
  window.addEventListener('prognozaepir:fog-vnext-updated', () => scheduleRender(0));
  window.addEventListener('prognozaepir:fog-engine-mode-applied', () => scheduleRender(0));

  const start = () => {
    ensureStyle();
    ensureGlobalNav();
    scheduleRender(0);
    setTimeout(() => scheduleRender(0), 800);
    setTimeout(() => scheduleRender(0), 2500);
    setInterval(() => scheduleRender(0), 60 * 1000);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
