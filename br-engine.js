'use strict';
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.PrognozaEPIRBREngine = api;
    if (root.document) api.start();
  }
})(typeof window !== 'undefined' ? window : null, () => {
  const HOUR = 3600e3;
  const finite = Number.isFinite;
  const num = v => v !== null && v !== undefined && v !== '' && finite(Number(v)) ? Number(v) : null;
  const clip = (v, a, b) => Math.max(a, Math.min(b, v));
  const mean = values => {
    const a = (values || []).filter(finite);
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  };
  const interp = (x, a, b, ya, yb) => x <= a ? ya : x >= b ? yb : ya + (yb - ya) * (x - a) / (b - a);
  const pw = (v, pts, below = null, above = null) => {
    if (!finite(v)) return null;
    if (v <= pts[0][0]) return below === null ? pts[0][1] : below;
    for (let i = 1; i < pts.length; i++) if (v <= pts[i][0]) return interp(v, pts[i - 1][0], pts[i][0], pts[i - 1][1], pts[i][1]);
    return above === null ? pts[pts.length - 1][1] : above;
  };
  const asFraction = v => {
    const x = num(v);
    if (!finite(x)) return null;
    return clip(x > 1 ? x / 100 : x, 0, 1);
  };

  function rhSaturation(rh) {
    return pw(num(rh), [[80, 0], [86, .12], [90, .35], [93, .58], [95, .74], [97, .90], [99, .98], [100, 1]], 0, 1);
  }

  function spreadSaturation(t, td) {
    const T = num(t), Td = num(td);
    if (!finite(T) || !finite(Td)) return null;
    const d = T - Td;
    return pw(d, [[.2, 1], [.5, .95], [.8, .86], [1.2, .72], [2, .45], [3, .18], [4, .04]], 1, 0);
  }

  function brVisibilityEvidence(vis) {
    const v = num(vis);
    if (!finite(v)) return null;
    // BR is an aviation target for mist: typically visibility 1–5 km.
    // Below 1 km the target should transition toward FG, not stronger BR.
    return pw(v, [[400, .02], [700, .12], [1000, .62], [1500, .92], [2500, 1], [4000, .90], [5000, .48], [7000, .12], [10000, 0]], .02, 0);
  }

  function transitionEvidence(fog) {
    const p = asFraction(fog);
    if (!finite(p)) return null;
    // BR is often the shoulder state before/after FG. Maximum support is at
    // moderate-to-high fog potential, while a near-certain FG signal does not
    // automatically mean BR.
    return pw(p, [[0, .10], [.2, .30], [.4, .62], [.6, .94], [.72, 1], [.86, .68], [1, .35]], .10, .35);
  }

  function operationalVisibility(row, mode) {
    if (mode === 'vnext') return num(row?.visProposed) ?? num(row?.visGuidance?.point) ?? null;
    return num(row?.vis);
  }

  function saturationEvidence(row, mode) {
    const vn = asFraction(row?.vnext?.SATURATION);
    if (mode === 'vnext' && finite(vn)) return vn;
    const legacySat = asFraction(row?.sat);
    if (finite(legacySat)) return legacySat;
    const rh = num(row?.RH) ?? mean((row?.models || []).map(m => num(m?.RH)));
    const t = num(row?.T) ?? mean((row?.models || []).map(m => num(m?.T)));
    const td = num(row?.Td) ?? mean((row?.models || []).map(m => num(m?.Td)));
    return mean([rhSaturation(rh), spreadSaturation(t, td)]);
  }

  function fogEvidence(row, mode) {
    if (mode === 'vnext') {
      const p = asFraction(row?.vnextProbability?.P_physics);
      if (finite(p)) return p;
      const f = asFraction(row?.fogProbabilityVNext);
      if (finite(f)) return f;
    }
    return asFraction(row?.score);
  }

  function weighted(parts) {
    let s = 0, w = 0;
    for (const p of parts) if (finite(p.v)) { s += p.v * p.w; w += p.w; }
    return w ? s / w : null;
  }

  function scoreRow(row, mode = 'legacy', now = Date.now()) {
    if (!row) return null;
    const sat = saturationEvidence(row, mode);
    const fog = fogEvidence(row, mode);
    const vis = operationalVisibility(row, mode);
    const visBr = brVisibilityEvidence(vis);
    const transition = transitionEvidence(fog);
    let score = weighted([
      {v:sat, w:.58},
      {v:transition, w:.24},
      {v:visBr, w:.18}
    ]);
    if (!finite(score)) return null;
    score *= 100;

    // A weakly saturated boundary layer cannot produce operational BR merely
    // because a model visibility value is low.
    if (finite(sat) && sat < .45) score = Math.min(score, 39);

    // If the selected engine expects visibility below 1 km and its FG signal is
    // already operational, classify this as FG territory rather than inflating BR.
    if (finite(vis) && vis < 1000 && finite(fog) && fog >= .50) score = Math.min(score, 49);

    // Conversely, very good visibility needs strong saturation before BR may be
    // carried as a forecast target.
    if (finite(vis) && vis > 5000 && (!finite(sat) || sat < .78)) score = Math.min(score, 49);

    const obsBr = String(row?.obsPhenomenon || '').toUpperCase() === 'BR';
    const t = num(row?.t);
    const lead = finite(t) ? Math.max(0, (t - now) / HOUR) : Infinity;
    if (obsBr && lead <= 2.5) {
      const weight = .55 * Math.exp(-lead / 1.8);
      score = (1 - weight) * score + weight * 100;
    }

    score = clip(score, 0, 100);
    return {
      t,
      score,
      saturation:sat,
      fogPotential:fog,
      visibility:vis,
      visibilityEvidence:visBr,
      transitionEvidence:transition,
      observedBR:obsBr,
      mode
    };
  }

  function classify(score) {
    if (!finite(score)) return 'BRAK DANYCH';
    if (score < 50) return 'NIE';
    if (score < 60) return 'MOŻLIWE';
    if (score < 80) return 'PRAWDOPODOBNE';
    return 'BARDZO PRAWDOPODOBNE';
  }

  function expectedVis(result) {
    if (!result || !finite(result.score) || result.score < 50) return '—';
    if (finite(result.visibility) && result.visibility >= 1000 && result.visibility <= 5000) return `${Math.round(result.visibility)} m`;
    if (result.score >= 80) return '1000–3000 m';
    if (result.score >= 60) return '1500–4000 m';
    return '3000–5000 m';
  }

  function selectMode() {
    try {
      if (typeof window !== 'undefined' && window.PrognozaEPIRFogMode?.get) return window.PrognozaEPIRFogMode.get();
      if (typeof localStorage !== 'undefined') return localStorage.getItem('prognozaepir-fog-engine-mode') === 'vnext' ? 'vnext' : 'legacy';
    } catch (_) { }
    return 'legacy';
  }

  function selectedSeries(mode) {
    if (typeof window === 'undefined') return [];
    if (mode === 'vnext' && Array.isArray(window.PrognozaEPIRFogVNextSeries) && window.PrognozaEPIRFogVNextSeries.length) return window.PrognozaEPIRFogVNextSeries;
    return Array.isArray(window.PrognozaEPIRFogSeries) ? window.PrognozaEPIRFogSeries : [];
  }

  function localHour(t) {
    try { return new Intl.DateTimeFormat('pl-PL', {timeZone:'UTC', hour:'2-digit', minute:'2-digit'}).format(new Date(t)) + ' UTC'; }
    catch (_) { return new Date(t).toISOString().slice(11, 16) + ' UTC'; }
  }

  function localDateTime(t) {
    try { return new Intl.DateTimeFormat('pl-PL', {timeZone:'UTC', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}).format(new Date(t)) + ' UTC'; }
    catch (_) { const d=new Date(t); return d.toISOString().slice(8,10)+'.'+d.toISOString().slice(5,7)+' '+d.toISOString().slice(11,16)+' UTC'; }
  }

  function firstWindow(rows) {
    const active = rows.map((r, i) => [r, i]).filter(([r]) => finite(r?.score) && r.score >= 50);
    if (!active.length) return null;
    const first = active[0][1];
    let last = first;
    while (last + 1 < rows.length && finite(rows[last + 1]?.score) && rows[last + 1].score >= 50) last++;
    return {from:rows[first].t, to:rows[last + 1]?.t ?? rows[last].t + HOUR};
  }

  function ensureStyle() {
    if (typeof document === 'undefined' || document.getElementById('brEngineStyle')) return;
    const s = document.createElement('style');
    s.id = 'brEngineStyle';
    s.textContent = `
      .br-engine{margin-top:8px;border:1px solid var(--border);background:var(--surface);border-radius:4px;padding:9px 10px;font-size:10px;line-height:1.35}
      .br-head{display:flex;justify-content:space-between;gap:8px;align-items:center;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:7px}.br-head b{color:var(--blueText);font-size:12px}.br-head span{color:var(--muted);font-size:9px;text-align:right}
      .br-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.br-card{background:var(--soft);border-left:3px solid var(--blueText);padding:6px 7px;min-width:0}.br-card small{display:block;color:var(--muted);font-size:8px}.br-card strong{display:block;font-size:12px;margin-top:1px}.br-card em{display:block;color:var(--muted);font-style:normal;font-size:8px;margin-top:1px}.br-mid{border-left-color:#d49a28}.br-high{border-left-color:#d86c2f}.br-vhigh{border-left-color:#d0503f}
      .br-hours{display:flex;gap:4px;overflow-x:auto;margin-top:7px;padding:5px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}.br-hour{flex:0 0 95px;background:var(--soft);border:1px solid var(--border);border-radius:4px;padding:5px;text-align:center}.br-hour b{display:block;font-size:9px}.br-hour strong{display:block;font-size:10px;margin:2px 0}.br-hour small{display:block;color:var(--muted);font-size:8px}
      .br-note{margin-top:7px;padding:5px 7px;background:var(--soft);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:8.5px}.br-note b{color:var(--ink)}
      @media(max-width:700px){.br-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.br-engine{padding:8px}.br-head b{font-size:11px}}
    `;
    document.head.appendChild(s);
  }

  function ensurePanel() {
    if (typeof document === 'undefined') return null;
    ensureStyle();
    let el = document.getElementById('brEngine');
    if (el) return el;
    el = document.createElement('section');
    el.id = 'brEngine';
    el.className = 'br-engine';
    el.innerHTML = '<div class="br-head"><b>ZAMGLENIE (BR)</b><span>oddzielny target · 1000–5000 m</span></div><div id="brSummary" class="br-grid"><div class="br-card"><small>Status</small><strong>Ładowanie…</strong></div></div><div id="brHours" class="br-hours" hidden></div><div id="brNote" class="br-note"><b>BR nie jest mechanizmem mgły.</b> Moduł ocenia zamglenie jako osobny stan na podstawie nasycenia, fazy przejściowej FG i widzialności operacyjnej wybranego silnika.</div>';
    const mount = document.getElementById('fogStandaloneMount');
    const engine = document.getElementById('fogEngine');
    if (engine?.parentNode) engine.insertAdjacentElement('afterend', el);
    else if (mount) mount.appendChild(el);
    else document.body.appendChild(el);
    return el;
  }

  function riskClass(score) {
    return score >= 80 ? 'br-vhigh' : score >= 60 ? 'br-high' : score >= 50 ? 'br-mid' : '';
  }

  function render() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    ensurePanel();
    const mode = selectMode();
    const src = selectedSeries(mode);
    const now = Date.now();
    const rows = src.map(r => scoreRow(r, mode, now)).filter(Boolean).filter(r => !finite(r.t) || (r.t >= now - HOUR && r.t <= now + 24 * HOUR));
    const summary = document.getElementById('brSummary');
    const hours = document.getElementById('brHours');
    const note = document.getElementById('brNote');
    if (!summary) return false;
    if (!rows.length) {
      summary.innerHTML = `<div class="br-card"><small>Status</small><strong>Ładowanie…</strong><em>oczekiwanie na serię ${mode === 'vnext' ? 'vNEXT' : 'LEGACY'}</em></div>`;
      if (hours) hours.hidden = true;
      return false;
    }
    const current = rows.reduce((a, b) => Math.abs((b.t ?? now) - now) < Math.abs((a.t ?? now) - now) ? b : a, rows[0]);
    const peak = rows.reduce((a, b) => !a || b.score > a.score ? b : a, null) || current;
    const win = firstWindow(rows);
    const obs = current.observedBR ? ' · BR OBS' : '';
    summary.innerHTML = `
      <div class="br-card ${riskClass(current.score)}"><small>BR teraz / najbliższa godzina</small><strong>${classify(current.score)}</strong><em>${Math.round(current.score)}/100${obs}</em></div>
      <div class="br-card ${riskClass(peak.score)}"><small>Maksimum BR w 24 h</small><strong>${classify(peak.score)}</strong><em>${Math.round(peak.score)}/100 · ${localDateTime(peak.t)}</em></div>
      <div class="br-card"><small>Oczekiwana VIS przy BR</small><strong>${expectedVis(current)}</strong><em>kod BR: zasadniczo 1000–5000 m</em></div>
      <div class="br-card"><small>Okno zamglenia</small><strong>${win ? `${localDateTime(win.from)}–${localDateTime(win.to)}` : 'BRAK'}</strong><em>${mode === 'vnext' ? 'źródło: vNEXT' : 'źródło: LEGACY'}</em></div>`;
    if (hours) {
      hours.hidden = false;
      hours.innerHTML = rows.slice(0, 13).map(r => `<div class="br-hour ${riskClass(r.score)}"><b>${localHour(r.t)}</b><strong>${classify(r.score)}</strong><small>${Math.round(r.score)}/100</small><small>VIS ${expectedVis(r)}</small></div>`).join('');
    }
    if (note) note.innerHTML = `<b>BR jest osobnym targetem, nie mechanizmem FG.</b> Aktywny silnik: ${mode === 'vnext' ? 'vNEXT' : 'LEGACY'}. Wynik /100 jest wskaźnikiem operacyjnym BR, nie skalibrowanym procentem prawdopodobieństwa. Gdy wybrany silnik wskazuje VIS &lt;1000 m i operacyjną FG, moduł ogranicza BR zamiast dublować mgłę.`;
    window.PrognozaEPIRBRSeries = rows;
    window.dispatchEvent(new CustomEvent('prognozaepir:br-series-updated', {detail:{mode,count:rows.length}}));
    return true;
  }

  function start() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const boot = () => {
      ensurePanel();
      render();
      window.addEventListener('prognozaepir:fog-series-updated', () => setTimeout(render, 0));
      window.addEventListener('prognozaepir:fog-vnext-updated', () => setTimeout(render, 0));
      window.addEventListener('prognozaepir:fog-engine-mode-changed', () => setTimeout(render, 0));
      setTimeout(render, 800);
      setTimeout(render, 3000);
      setInterval(render, 120000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
    else boot();
  }

  return Object.freeze({
    VERSION:'1.0.0-br-target',
    scoreRow,
    classify,
    expectedVis,
    brVisibilityEvidence,
    transitionEvidence,
    saturationEvidence,
    render,
    start
  });
});
