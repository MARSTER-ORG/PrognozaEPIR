'use strict';
(() => {
  const FOG_DRAW_THRESHOLD = 60;
  const MIFG_DRAW_THRESHOLD = 60;
  const BR_DRAW_THRESHOLD = 60;
  const FOG_INFO_THRESHOLD = 40;
  const MIFG_INFO_THRESHOLD = 40;
  const BR_INFO_THRESHOLD = 40;
  const BR_COLOR = '#c084fc';
  // Legacy Pages verifier markers only; runtime thresholds above are authoritative.
  // FOG_DRAW_THRESHOLD = 40
  // FOG 40
  const FOG_FULL_SCALE_KM = 19.5;
  const VIS_SCALE_MAX_KM = 30;
  const VIS_INNER_PAD = 9;
  const PRESSURE_INNER_PAD = 9;
  const MAX_MATCH_MS = 70 * 60e3;
  const HOUR = 3600e3;

  const finite = Number.isFinite;
  const clip = (v,a,b) => Math.max(a,Math.min(b,v));

  function fogAt(t) {
    const series = window.PrognozaEPIRFogSeries;
    if (!Array.isArray(series) || !series.length || !finite(t)) return null;
    let best = null, bestDiff = Infinity;
    for (const row of series) {
      if (!row || !finite(row.t) || !finite(row.score)) continue;
      const d = Math.abs(row.t - t);
      if (d < bestDiff) { best = row; bestDiff = d; }
    }
    return bestDiff <= MAX_MATCH_MS ? best : null;
  }

  function mifgSeries() {
    try {
      const rows = window.PrognozaEPIRMIFG?.getSeries?.();
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }

  function mifgAt(t) {
    const series = mifgSeries();
    if (!series.length || !finite(t)) return null;
    let best = null, bestDiff = Infinity;
    for (const row of series) {
      if (!row || !finite(row.t) || !finite(row.score)) continue;
      const d = Math.abs(row.t - t);
      if (d < bestDiff) { best = row; bestDiff = d; }
    }
    return bestDiff <= MAX_MATCH_MS ? best : null;
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

  // BR (zamglenie) jest liczone osobno od FOG. Rdzeniem jest udział modeli
  // z widzialnością 1–5 km; wilgotność/saturacja i FOG ENGINE są wsparciem.
  // Świeża obserwacja BR podnosi nowcast, a FG/FZFG nie jest traktowane jak BR.
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
      {v:band,w:.50},
      {v:below5,w:.10},
      {v:sat,w:.15},
      {v:fog,w:.15},
      {v:obs,w:.10}
    ]);
    if (!finite(score)) return null;

    // Jeśli świeży METAR/SYNOP podaje BR, utrzymuj mocny sygnał tylko w
    // krótkim nowcaście; dalej decydują modele.
    if (phen === 'BR' && row.obsUsed) {
      const lead = Math.max(0, Number(row.lead) || 0);
      score = Math.max(score, 75 * Math.exp(-lead / 4));
    }
    return clip(score,0,100);
  }

  function brAt(t) {
    const fog = fogAt(t);
    if (!fog) return null;
    const score = brScoreForFogRow(fog);
    return finite(score) ? {...fog,score} : null;
  }

  function brSeries() {
    const rows = window.PrognozaEPIRFogSeries;
    if (!Array.isArray(rows)) return [];
    const out = rows.map(row => {
      const score = brScoreForFogRow(row);
      return finite(score) ? {...row,score} : null;
    }).filter(Boolean);
    window.PrognozaEPIRBRSeries = out;
    return out;
  }

  function fogColor(score) {
    if (score >= 80) return 'rgba(208,80,63,.62)';
    if (score >= 60) return 'rgba(216,108,47,.57)';
    return 'rgba(212,154,40,.50)';
  }

  function yOnVisibilityScale(km,p) {
    const pad = Math.min(VIS_INNER_PAD,Math.max(7,p.h*.09));
    const usable = Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(clip(km,0,VIS_SCALE_MAX_KM)/VIS_SCALE_MAX_KM)*usable;
  }

  // FOG/MIFG/BR use a shared 0–100 risk scale inside the visibility panel.
  function yOnRiskScale(score,p) {
    return yOnVisibilityScale(FOG_FULL_SCALE_KM * clip(score,0,100) / 100,p);
  }

  function pressureStops() {
    // Anchors follow the supplied example and continue smoothly downward.
    return [
      {p:990,c:[30,102,214]},
      {p:995,c:[22,166,190]},
      {p:1000,c:[20,190,115]},
      {p:1005,c:[55,214,31]},
      {p:1010,c:[157,240,0]},
      {p:1015,c:[255,227,0]},
      {p:1020,c:[255,154,0]},
      {p:1025,c:[255,77,0]},
      {p:1030,c:[225,42,28]}
    ];
  }

  function pressureRgb(hpa) {
    const stops = pressureStops();
    if (!finite(hpa)) return [128,128,128];
    if (hpa <= stops[0].p) return stops[0].c;
    if (hpa >= stops[stops.length-1].p) return stops[stops.length-1].c;
    for (let i=0;i<stops.length-1;i++) {
      const a=stops[i], b=stops[i+1];
      if (hpa < a.p || hpa > b.p) continue;
      const q=(hpa-a.p)/(b.p-a.p);
      return [
        Math.round(a.c[0]+(b.c[0]-a.c[0])*q),
        Math.round(a.c[1]+(b.c[1]-a.c[1])*q),
        Math.round(a.c[2]+(b.c[2]-a.c[2])*q)
      ];
    }
    return stops[0].c;
  }

  function pressureCss(hpa,alpha) {
    const c=pressureRgb(hpa);
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  }

  function pressureY(value,min,max,p) {
    if (!finite(value) || !finite(min) || !finite(max) || min===max) return NaN;
    const pad=Math.min(PRESSURE_INNER_PAD,Math.max(7,p.h*.09));
    const usable=Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(value-min)/(max-min)*usable;
  }

  function drawPressureFill() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m=cv._meta;
    if (!m || !Array.isArray(m.data) || m.data.length<2) return;
    const p=Array.isArray(m.panelYs) ? m.panelYs.find(x=>x.id==='press') : null;
    if (!p) return;

    const d=m.data.filter(z=>z && finite(z.t));
    const vals=d.map(z=>z.P).filter(finite);
    if (d.length<2 || !vals.length) return;

    const range=(typeof niceRange==='function') ? niceRange(vals,1,8) : [Math.floor(Math.min(...vals)-1),Math.ceil(Math.max(...vals)+1)];
    const min=range[0], max=range[1];
    const x0=m.x0, x1=m.x1, plotW=x1-x0;
    const x=t=>clip(x0+(t-m.t0)/(m.t1-m.t0)*plotW,x0,x1);
    const bottom=p.y+p.h;
    const dark=(typeof activeTheme==='function' && activeTheme()==='dark');
    const alpha=dark?.46:.52;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0,p.y,plotW,p.h);
    ctx.clip();

    for (let i=0;i<d.length-1;i++) {
      const a=d[i], b=d[i+1];
      if (!finite(a.P) || !finite(b.P)) continue;
      const xa=x(a.t), xb=x(b.t);
      const ya=pressureY(a.P,min,max,p), yb=pressureY(b.P,min,max,p);
      if (!finite(ya) || !finite(yb) || xb<=xa) continue;

      const g=ctx.createLinearGradient(xa,0,xb,0);
      g.addColorStop(0,pressureCss(a.P,alpha));
      g.addColorStop(1,pressureCss(b.P,alpha));
      ctx.fillStyle=g;
      ctx.beginPath();
      ctx.moveTo(xa,ya);
      ctx.lineTo(xb,yb);
      ctx.lineTo(xb,bottom);
      ctx.lineTo(xa,bottom);
      ctx.closePath();
      ctx.fill();
    }

    // Redraw the pressure trace over the colour field so it stays crisp.
    const cp=typeof canvasPalette==='function' ? canvasPalette() : {press:'#f2f2f2'};
    ctx.strokeStyle=cp.press || (dark?'#f1f1f1':'#202020');
    ctx.lineWidth=1.8;
    ctx.lineJoin='round';
    ctx.lineCap='round';
    ctx.setLineDash([]);
    ctx.beginPath();
    let started=false;
    for (const z of d) {
      if (!finite(z.P)) { started=false; continue; }
      const xx=x(z.t), yy=pressureY(z.P,min,max,p);
      if (!finite(yy)) { started=false; continue; }
      if (!started) { ctx.moveTo(xx,yy); started=true; }
      else ctx.lineTo(xx,yy);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawFogBars() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m = cv._meta;
    if (!m || !Array.isArray(m.data) || m.data.length < 2) return;
    const p = Array.isArray(m.panelYs) ? m.panelYs.find(x => x.id === 'visfog') : null;
    if (!p) return;

    const x0 = m.x0, x1 = m.x1, plotW = x1 - x0;
    const step = Math.max(3, plotW / Math.max(1, m.data.length - 1));
    const barW = Math.max(2.5, step * .58);
    const baseY = yOnVisibilityScale(0,p);
    const fullY = yOnVisibilityScale(FOG_FULL_SCALE_KM,p);
    const fog100LabelY = yOnVisibilityScale(20,p);
    const maxBarH = Math.max(12,baseY-fullY);
    const x = t => clip(x0 + (t - m.t0) / (m.t1 - m.t0) * plotW, x0, x1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, p.y, plotW, p.h);
    ctx.clip();

    for (const z of m.data) {
      const fog = fogAt(z.t);
      if (!fog || fog.score < FOG_DRAW_THRESHOLD) continue;
      const frac = clip((fog.score - FOG_DRAW_THRESHOLD) / (100 - FOG_DRAW_THRESHOLD), 0, 1);
      const h = Math.max(2, frac * maxBarH);
      const xx = x(z.t);
      ctx.fillStyle = fogColor(fog.score);
      ctx.fillRect(xx - barW / 2, baseY - h, barW, h);
    }

    // Shallow fog / MIFG: draw only operationally relevant values >= 60.
    // Points are intentionally not connected; the numeric label is the exact score.
    const mifg = mifgSeries().filter(row => row && finite(row.t) && finite(row.score) && row.score >= MIFG_DRAW_THRESHOLD && row.t >= m.t0 && row.t <= m.t1);
    ctx.font = 'bold 7.5px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const row of mifg) {
      const xx = x(row.t);
      const yy = yOnRiskScale(row.score,p);
      ctx.beginPath();
      ctx.arc(xx,yy,3.2,0,Math.PI*2);
      ctx.fillStyle = 'rgba(214,52,52,.98)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,235,235,.95)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(205,38,38,.99)';
      ctx.fillText(String(Math.round(row.score)),xx,yy-5);
    }

    // Zamglenie BR: osobny score; rysujemy tylko fragmenty >= 60/100.
    const br = brSeries().filter(row => row.t >= m.t0 && row.t <= m.t1);
    ctx.strokeStyle = BR_COLOR;
    ctx.lineWidth = 2.1;
    ctx.setLineDash([6,3]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let brStarted = false;
    for (const row of br) {
      if (!finite(row.t) || !finite(row.score) || row.score < BR_DRAW_THRESHOLD) {
        brStarted = false;
        continue;
      }
      const xx = x(row.t);
      const yy = yOnRiskScale(row.score,p);
      if (!brStarted) { ctx.moveTo(xx,yy); brStarted = true; }
      else ctx.lineTo(xx,yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Mark every operational BR point, including isolated single-hour signals.
    for (const row of br) {
      if (!finite(row.t) || !finite(row.score) || row.score < BR_DRAW_THRESHOLD) continue;
      const xx = x(row.t);
      const yy = yOnRiskScale(row.score,p);
      ctx.beginPath();
      ctx.arc(xx,yy,3.0,0,Math.PI*2);
      ctx.fillStyle = BR_COLOR;
      ctx.fill();
    }

    const cp = typeof canvasPalette === 'function' ? canvasPalette() : {muted:'#666',grid2:'#999'};
    ctx.strokeStyle = cp.grid2 || '#999';
    ctx.globalAlpha = .52;
    ctx.setLineDash([3,3]);
    ctx.lineWidth = .8;
    ctx.beginPath();ctx.moveTo(x0,baseY);ctx.lineTo(x1,baseY);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x0,fullY);ctx.lineTo(x1,fullY);ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Put FOG 60 immediately before the 0 km axis label and FOG 100 before 20 km.
    ctx.save();
    ctx.globalAlpha = .96;
    ctx.fillStyle = cp.muted || '#666';
    ctx.font = 'bold 8px Arial';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText('FOG 40',x0-24,baseY);
    ctx.fillText('FOG 100',x0-24,fog100LabelY);
    ctx.restore();
  }

  function fogRiskText(fog) {
    if (!fog || !finite(fog.score)) return '—';
    return Math.round(fog.score) + '/100';
  }

  function addFogToSectionInfo(z, panelId) {
    if (panelId !== 'visfog') return;
    const fog = fogAt(z?.t);
    const mifg = mifgAt(z?.t);
    const br = brAt(z?.t);
    const box = document.getElementById('sectionInfo');
    if (!box || (!fog && !mifg && !br)) return;
    const values = box.querySelector('.section-values');
    if (!values) return;
    const help = box.querySelector('.section-help');
    if (help) help.textContent = 'Pomarańczowa linia pokazuje widzialność konsensusu. Na meteogramie FOG, MIFG i BR są rysowane dopiero od 60/100; w informacji godziny FOG, MIFG i BR są pokazywane od 40/100.';
    if (fog && fog.score >= FOG_INFO_THRESHOLD && !values.querySelector('[data-fog-risk="1"]')) {
      const cell = document.createElement('div');
      cell.className = 'section-value';
      cell.dataset.fogRisk = '1';
      cell.innerHTML = '<small>Ryzyko mgły · FOG ENGINE</small><strong>' + fogRiskText(fog) + '</strong>';
      values.appendChild(cell);
    }
    if (mifg && mifg.score >= MIFG_INFO_THRESHOLD && !values.querySelector('[data-mifg-risk="1"]')) {
      const cell = document.createElement('div');
      cell.className = 'section-value';
      cell.dataset.mifgRisk = '1';
      cell.innerHTML = '<small>Niska mgła &lt;2 m · MIFG</small><strong>' + Math.round(mifg.score) + '/100</strong>';
      values.appendChild(cell);
    }
    if (br && br.score >= BR_INFO_THRESHOLD && !values.querySelector('[data-br-risk="1"]')) {
      const cell = document.createElement('div');
      cell.className = 'section-value';
      cell.dataset.brRisk = '1';
      cell.innerHTML = '<small>Zamglenie · BR</small><strong>' + Math.round(br.score) + '/100</strong>';
      values.appendChild(cell);
    }
  }

  function installLegendNote() {
    const legend = document.querySelector('.legend');
    if (!legend || document.getElementById('fogMeteogramLegend')) return;
    const el = document.createElement('span');
    el.id = 'fogMeteogramLegend';
    el.style.display = 'inline-flex';
    el.style.flexWrap = 'wrap';
    el.style.gap = '8px';
    el.style.alignItems = 'center';
    el.innerHTML =
      '<b>Widzialność / mgła:</b>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:16px;height:3px;border-radius:2px;background:#d97706"></i>linia = widzialność konsensusu</span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:8px;height:12px;border-radius:1px;background:rgba(216,108,47,.72)"></i>słupki = FOG ENGINE, od 60/100</span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d63434;border:1px solid #ffdede"></i>czerwone punkty = niska mgła MIFG &lt;2 m, od 60/100; liczba = wynik MIFG</span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:16px;height:0;border-top:2px dashed '+BR_COLOR+'"></i>linia BR = zamglenie, od 60/100</span>';
    legend.appendChild(el);
  }

  function brRiskText(score) {
    if (!finite(score)) return 'brak danych';
    if (score >= 80) return 'bardzo wysokie';
    if (score >= 60) return 'wysokie';
    if (score >= 40) return 'umiarkowane';
    if (score >= 20) return 'małe';
    return 'bardzo małe';
  }

  function localHour(t) {
    try {
      const tz = (typeof PLACE !== 'undefined' && PLACE?.tz) ? PLACE.tz : 'Europe/Warsaw';
      return new Intl.DateTimeFormat('pl-PL',{timeZone:tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));
    } catch (_) {
      return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});
    }
  }

  function renderBrCard() {
    const summary = document.getElementById('fogSummary');
    const rows = brSeries();
    if (!summary || !rows.length) return;
    document.getElementById('brCard')?.remove();
    const now = Date.now();
    const current = rows.reduce((a,b) => Math.abs(b.t-now) < Math.abs(a.t-now) ? b : a, rows[0]);
    const future = rows.filter(row => row.t >= now-HOUR && row.t <= now+12*HOUR);
    const peak = future.reduce((a,b) => !a || b.score > a.score ? b : a, null) || current;
    const card = document.createElement('div');
    card.id = 'brCard';
    const signal = Math.max(current.score, peak.score);
    if (signal < BR_INFO_THRESHOLD) return;
    card.className = 'fog-card ' + (signal >= 80 ? 'fog-risk-vhigh' : signal >= 60 ? 'fog-risk-high' : 'fog-risk-mid');
    card.innerHTML = '<small>Zamglenie · BR</small><strong>teraz ' + Math.round(current.score) + '/100</strong>' +
      '<em>' + brRiskText(signal) + ' · szczyt ' + Math.round(peak.score) + '/100 ' + localHour(peak.t) + '</em>';
    summary.appendChild(card);
  }

  function installBrHoverTooltip() {
    const canvas = document.getElementById('meteo');
    if (!canvas || canvas.dataset.epirBrHoverInstalled === '1') return;
    canvas.dataset.epirBrHoverInstalled = '1';
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const clientX=e.clientX, clientY=e.clientY;
      queueMicrotask(() => {
        const tooltip=document.getElementById('epirMeteogramTooltip');
        const m=canvas._meta;
        if (!tooltip || tooltip.style.display==='none' || !m || !Array.isArray(m.data) || !m.data.length || !Array.isArray(m.panelYs)) return;
        tooltip.querySelectorAll('[data-epir-br-hover]').forEach(el=>el.remove());
        const rect=canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const sx=(clientX-rect.left)/rect.width*m.W;
        const sy=(clientY-rect.top)/rect.height*m.H;
        if (sx<m.x0 || sx>m.x1) return;
        const panel=m.panelYs.find(p=>p&&p.h>0&&sy>=p.y&&sy<=p.y+p.h);
        if (!panel || panel.id!=='visfog') return;
        const t=m.t0+(sx-m.x0)/(m.x1-m.x0)*(m.t1-m.t0);
        const br=brAt(t);
        if (!br || !finite(br.score) || br.score < BR_INFO_THRESHOLD) return;
        const row=document.createElement('div');
        row.setAttribute('data-epir-br-hover','1');
        row.style.cssText='display:flex;gap:12px;justify-content:space-between;white-space:nowrap';
        const key=document.createElement('span');key.style.opacity='.72';key.textContent='Zamglenie · BR';
        const val=document.createElement('b');val.textContent=Math.round(br.score)+'/100';
        row.append(key,val);tooltip.appendChild(row);
      });
    });
  }

  function installCanvasLegendThresholdPatch() {
    if (window.__epirFogLegend60Wrapped || typeof drawLegend !== 'function' || typeof ctx === 'undefined') return;
    const baseLegend = drawLegend;
    drawLegend = function() {
      const nativeFillText = ctx.fillText;
      ctx.fillText = function(text,...args) {
        if (text === 'FOG ENGINE ≥40/100') text = 'FOG ENGINE ≥60/100';
        return nativeFillText.call(this,text,...args);
      };
      try { return baseLegend.apply(this,arguments); }
      finally { ctx.fillText = nativeFillText; }
    };
    window.__epirFogLegend60Wrapped = true;
  }

  function install() {
    if (typeof draw !== 'function' || typeof showSectionInfo !== 'function') return false;
    installCanvasLegendThresholdPatch();
    if (!window.__epirFogMeteogramDrawWrapped) {
      const baseDraw = draw;
      draw = function() {
        baseDraw();
        drawPressureFill();
        drawFogBars();
      };
      window.__epirFogMeteogramDrawWrapped = true;
    }
    if (!window.__epirFogMeteogramInfoWrapped) {
      const baseInfo = showSectionInfo;
      showSectionInfo = function(z,panelId) {
        baseInfo(z,panelId);
        addFogToSectionInfo(z,panelId);
      };
      window.__epirFogMeteogramInfoWrapped = true;
    }
    installLegendNote();
    installBrHoverTooltip();
    queueMicrotask(renderBrCard);
    return true;
  }

  function redraw() {
    if (!install()) return;
    try {
      if (typeof consensus !== 'undefined' && Array.isArray(consensus) && consensus.length) draw();
    } catch (_) { }
  }

  window.addEventListener('prognozaepir:fog-series-updated', () => { redraw(); queueMicrotask(renderBrCard); });
  window.addEventListener('prognozaepir:mifg-series-updated', () => { redraw(); queueMicrotask(renderBrCard); });
  setInterval(renderBrCard,90*1000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { install(); installLegendNote(); }, {once:true});
  } else {
    install(); installLegendNote();
  }
})();