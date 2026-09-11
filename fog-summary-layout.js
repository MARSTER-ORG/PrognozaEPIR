'use strict';
(() => {
  const HOUR = 3600e3;
  const THRESHOLD = 50;
  const finite = Number.isFinite;
  const clip = (v,a,b) => Math.max(a,Math.min(b,v));
  const fmt0 = v => finite(Number(v)) ? String(Math.round(Number(v))) : '—';
  const fmtM = v => finite(Number(v)) ? Math.max(0,Math.round(Number(v))) + ' m' : '—';

  function localHour(t) {
    try {
      return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(t));
    } catch (_) {
      const d = new Date(t);
      return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
    }
  }

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
  }

  function riskCss(score) {
    if (!finite(score) || score < 50) return '';
    if (score >= 80) return 'fog-risk-vhigh';
    if (score >= 60) return 'fog-risk-high';
    return 'fog-risk-mid';
  }

  function classText(score, kind) {
    if (!finite(score)) return 'BRAK DANYCH';
    if (score < 50) return 'NIE';
    if (kind === 'FG') {
      if (score < 60) return 'MOŻLIWA';
      if (score < 80) return 'PRAWDOPODOBNA';
      return 'BARDZO PRAWDOPODOBNA';
    }
    if (score < 60) return 'MOŻLIWE';
    if (score < 80) return 'PRAWDOPODOBNE';
    return 'BARDZO PRAWDOPODOBNE';
  }

  function normaliseRows(rows) {
    return (Array.isArray(rows) ? rows : [])
      .filter(x => x && finite(Number(x.t)) && finite(Number(x.score)))
      .map(x => ({...x,t:Number(x.t),score:Number(x.score)}))
      .sort((a,b) => a.t-b.t);
  }

  function eventInfo(rows) {
    const now = Date.now();
    const future = normaliseRows(rows).filter(x => x.t >= now-HOUR && x.t <= now+48*HOUR);
    if (!future.length) return null;
    const current = future.reduce((a,b) => Math.abs(b.t-now) < Math.abs(a.t-now) ? b : a, future[0]);
    const peak = future.reduce((a,b) => b.score > a.score ? b : a, future[0]);
    const pi = future.indexOf(peak);

    let onset = null, end = null, peakFrom = null, peakTo = null;
    if (peak.score >= THRESHOLD) {
      let a = pi, b = pi;
      while (a > 0 && future[a-1].score >= THRESHOLD) a--;
      while (b < future.length-1 && future[b+1].score >= THRESHOLD) b++;
      onset = future[a].t;
      end = future[b+1]?.t ?? null;

      const peakThreshold = Math.max(THRESHOLD, peak.score * 0.85);
      let pa = pi, pb = pi;
      while (pa > 0 && future[pa-1].score >= peakThreshold) pa--;
      while (pb < future.length-1 && future[pb+1].score >= peakThreshold) pb++;
      peakFrom = future[pa].t;
      peakTo = future[pb].t;
    }
    return {future,current,peak,onset,end,peakFrom,peakTo};
  }

  function currentDetail(score) {
    return score >= THRESHOLD ? fmt0(score) + '/100' : 'wynik <50/100 pominięty';
  }

  function peakDetail(ev) {
    if (!ev || ev.peak.score < THRESHOLD) return 'brak sygnału ≥50/100 w 48 h';
    const range = ev.peakFrom === null
      ? localHour(ev.peak.t)
      : localHour(ev.peakFrom) + '–' + localHour(ev.peakTo);
    return fmt0(ev.peak.score) + '/100 · ' + range + ' UTC';
  }

  function whenDetail(ev) {
    if (!ev || ev.peak.score < THRESHOLD || ev.onset === null) return 'brak sygnału ≥50 w 48 h';
    return localHour(ev.onset) + ' → ' + (ev.end === null ? 'dalej' : localHour(ev.end)) + ' UTC';
  }

  function card(label,value,detail,score=null) {
    return '<div class="fog-card '+riskCss(score)+'"><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong><em>'+esc(detail)+'</em></div>';
  }

  function weightedScore(parts) {
    let sum = 0, weight = 0;
    for (const part of parts) {
      if (!part || !finite(part.v) || !finite(part.w) || part.w <= 0) continue;
      sum += part.v * part.w;
      weight += part.w;
    }
    return weight ? sum / weight : null;
  }

  function brScoreForFogRow(row) {
    if (!row) return null;
    const visModels = Array.isArray(row.models)
      ? row.models.map(m => Number(m?.VIS)).filter(finite)
      : [];
    const band = visModels.length
      ? 100 * visModels.filter(v => v >= 1000 && v < 5000).length / visModels.length
      : null;
    const below5 = visModels.length
      ? 100 * visModels.filter(v => v < 5000).length / visModels.length
      : null;
    const sat = finite(row.sat) ? row.sat : null;
    const fog = finite(row.score) ? row.score : null;
    const phen = String(row.obsPhenomenon || '').toUpperCase();
    let obs = null;
    if (row.obsUsed) {
      if (phen === 'BR') obs = 100;
      else if (phen === 'FG' || phen === 'FZFG') obs = 20;
      else if (phen.includes('BEZ FG/BR')) obs = 0;
    }
    let score = weightedScore([
      {v:band,w:.50}, {v:below5,w:.10}, {v:sat,w:.15}, {v:fog,w:.15}, {v:obs,w:.10}
    ]);
    if (!finite(score)) return null;
    if (phen === 'BR' && row.obsUsed) {
      const lead = Math.max(0, Number(row.lead) || 0);
      score = Math.max(score, 75 * Math.exp(-lead / 4));
    }
    return clip(score,0,100);
  }

  function fogRows() {
    return normaliseRows(window.PrognozaEPIRFogSeries);
  }

  function brRows() {
    const out = fogRows().map(row => {
      const score = brScoreForFogRow(row);
      return finite(score) ? {...row,score} : null;
    }).filter(Boolean);
    window.PrognozaEPIRBRSeries = out;
    return out;
  }

  function mifgRows() {
    try {
      return normaliseRows(window.PrognozaEPIRMIFG?.getSeries?.());
    } catch (_) {
      return [];
    }
  }

  function brDiagnostic(row) {
    const vis = Array.isArray(row?.models) ? row.models.map(m => Number(m?.VIS)).filter(finite) : [];
    if (!vis.length) return {value:'VIS 1–5 km',detail:'score BR liczony niezależnie od FG'};
    const pct = 100 * vis.filter(v => v >= 1000 && v < 5000).length / vis.length;
    return {value:'VIS 1–5 km',detail:fmt0(pct)+'% modeli w paśmie BR'};
  }

  function mifgDiagnostic(row) {
    const c = row?.components || {};
    const parts = [];
    if (finite(c.surfaceSat)) parts.push('nasycenie '+fmt0(c.surfaceSat*100)+'%');
    if (finite(c.inv)) parts.push('inwersja '+fmt0(c.inv*100)+'%');
    if (finite(c.wind)) parts.push('wiatr '+fmt0(c.wind*100)+'%');
    return {value:'płytka mgła <2 m',detail:parts.length ? parts.slice(0,2).join(' · ') : 'sygnał warstwy przygruntowej'};
  }

  function ensureStyle() {
    if (document.getElementById('fogSummaryStructuredStyle')) return;
    const style = document.createElement('style');
    style.id = 'fogSummaryStructuredStyle';
    style.textContent = `
      .fog-summary-structured{display:flex;flex-direction:column;gap:7px;margin-bottom:7px}
      .fog-phen-row{min-width:0}
      .fog-phen-title{font-size:8.5px;font-weight:700;color:var(--blueText);letter-spacing:.02em;margin:0 0 3px 1px}
      .fog-phen-grid,.fog-aux-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
      .fog-aux-structured{margin:1px 0 7px}
      .fog-aux-title{font-size:8px;color:var(--muted);margin:0 0 3px 1px}
      @media(max-width:700px){.fog-phen-grid,.fog-aux-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    const legacy = document.getElementById('fogSummary');
    if (!legacy) return null;
    ensureStyle();
    legacy.style.display = 'none';
    legacy.setAttribute('aria-hidden','true');

    let panel = document.getElementById('fogSummaryStructured');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'fogSummaryStructured';
      panel.className = 'fog-summary-structured';
      legacy.parentNode.insertBefore(panel, legacy);
    }
    let aux = document.getElementById('fogAuxStructured');
    if (!aux) {
      aux = document.createElement('div');
      aux.id = 'fogAuxStructured';
      aux.className = 'fog-aux-structured';
      legacy.parentNode.insertBefore(aux, legacy.nextSibling);
    }
    return {panel,aux};
  }

  function renderPhenomenon(title,kind,ev,diagnostic) {
    if (!ev) {
      return '<section class="fog-phen-row"><div class="fog-phen-title">'+esc(title)+'</div><div class="fog-phen-grid">'+
        card((kind==='FG'?'MGŁA':kind)+' W CIĄGU NAJBLIŻSZEJ GODZINY','BRAK DANYCH','oczekiwanie na dane')+
        card('MAKSIMUM W 48 H','BRAK DANYCH','oczekiwanie na dane')+
        card('KIEDY '+kind+'?','BRAK DANYCH','oczekiwanie na dane')+
        card('DIAGNOSTYKA','BRAK DANYCH','oczekiwanie na dane')+
      '</div></section>';
    }
    const diag = diagnostic(ev.current,ev.peak);
    return '<section class="fog-phen-row"><div class="fog-phen-title">'+esc(title)+'</div><div class="fog-phen-grid">'+
      card((kind==='FG'?'MGŁA':kind)+' W CIĄGU NAJBLIŻSZEJ GODZINY',classText(ev.current.score,kind),currentDetail(ev.current.score),ev.current.score)+
      card('MAKSIMUM W 48 H',classText(ev.peak.score,kind),peakDetail(ev),ev.peak.score)+
      card('KIEDY '+kind+'?',whenDetail(ev),'próg operacyjny 50/100',ev.peak.score)+
      card(diag.label,diag.value,diag.detail,diag.score ?? null)+
    '</div></section>';
  }

  function render() {
    const target = ensurePanel();
    if (!target) return;

    const fg = eventInfo(fogRows());
    const br = eventInfo(brRows());
    const mi = eventInfo(mifgRows());

    const fgHtml = renderPhenomenon('MGŁA (FG)','FG',fg,(current,peak) => ({
      label:'TYP PROCESU',
      value:peak?.type?.text || current?.type?.text || '—',
      detail:peak?.type?.secondary ? 'wtórny: '+(({RAD:'radiacyjna',ADV:'adwekcyjna',CBL:'obniżanie Stratusa',PCP:'opadowa'})[peak.type.secondary] || peak.type.secondary) : 'dominujący mechanizm'
    }));

    const brHtml = renderPhenomenon('BR — ZAMGLENIE','BR',br,(current) => {
      const d = brDiagnostic(current);
      return {label:'DIAGNOSTYKA BR',value:d.value,detail:d.detail};
    });

    const miHtml = renderPhenomenon('MIFG — NISKA MGŁA','MIFG',mi,(current) => {
      const d = mifgDiagnostic(current);
      return {label:'DIAGNOSTYKA MIFG',value:d.value,detail:d.detail};
    });

    target.panel.innerHTML = fgHtml + brHtml + miHtml;

    if (fg) {
      const current = fg.current, peak = fg.peak;
      const confidence = finite(current.confidence)
        ? (current.confidence>=.80?'bardzo wysoka':current.confidence>=.65?'wysoka':current.confidence>=.45?'średnia':current.confidence>=.25?'niska':'bardzo niska')
        : 'brak danych';
      target.aux.innerHTML = '<div class="fog-aux-title">PARAMETRY DODATKOWE FG</div><div class="fog-aux-grid">'+
        card('VIS <1000 / <500 m',fmt0(current.vis1000)+'/100 · '+fmt0(current.vis500)+'/100','VIS EPIR '+fmtM(current.vis))+
        card('VIS <1500 / <200 m',fmt0(current.vis1500)+'/100 · '+fmt0(current.vis200)+'/100','osobne zagrożenia')+
        card('MGŁA MARZNĄCA',peak.fzfg || '—','T przy maksimum '+(finite(peak.T)?Number(peak.T).toFixed(1):'—')+'°C')+
        card('PEWNOŚĆ PROGNOZY',confidence,fmt0((current.confidence??0)*100)+'% wskaźnika CONF')+
      '</div>';
    } else {
      target.aux.innerHTML = '';
    }

    const thresholds = document.querySelector('#fogEngine .fog-thresholds');
    if (thresholds) thresholds.innerHTML = '<b>Interpretacja operacyjna FG / BR / MIFG:</b> &lt;50 = NIE (wynik pomijany) · 50–59 = MOŻLIWE · 60–79 = PRAWDOPODOBNE · 80–100 = BARDZO PRAWDOPODOBNE. <b>Wynik /100 jest score ryzyka, nie skalibrowanym procentem prawdopodobieństwa.</b>';
  }

  function scheduleRender() {
    queueMicrotask(render);
    setTimeout(render,60);
    setTimeout(render,350);
  }

  window.addEventListener('prognozaepir:fog-series-updated',scheduleRender);
  window.addEventListener('prognozaepir:mifg-series-updated',scheduleRender);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',scheduleRender,{once:true});
  else scheduleRender();
  setTimeout(render,1500);
  setTimeout(render,4500);
  setInterval(render,90*1000);
})();