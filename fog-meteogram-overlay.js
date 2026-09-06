'use strict';
(() => {
  const FOG_DRAW_THRESHOLD = 40;
  const FOG_FULL_SCALE_KM = 19.5;
  const VIS_SCALE_MAX_KM = 30;
  const VIS_INNER_PAD = 9;
  const MAX_MATCH_MS = 70 * 60e3;

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

  function fogColor(score) {
    if (score >= 75) return 'rgba(208,80,63,.62)';
    if (score >= 60) return 'rgba(216,108,47,.57)';
    return 'rgba(212,154,40,.50)';
  }

  function yOnVisibilityScale(km,p) {
    const pad = Math.min(VIS_INNER_PAD,Math.max(7,p.h*.09));
    const usable = Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(clip(km,0,VIS_SCALE_MAX_KM)/VIS_SCALE_MAX_KM)*usable;
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

    const cp = typeof canvasPalette === 'function' ? canvasPalette() : {muted:'#666',grid2:'#999'};
    ctx.strokeStyle = cp.grid2 || '#999';
    ctx.globalAlpha = .52;
    ctx.setLineDash([3,3]);
    ctx.lineWidth = .8;
    ctx.beginPath();ctx.moveTo(x0,baseY);ctx.lineTo(x1,baseY);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x0,fullY);ctx.lineTo(x1,fullY);ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = .96;
    ctx.fillStyle = cp.muted || '#666';
    ctx.font = 'bold 8px Arial';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    ctx.fillText('FOG ≥40',x1-5,baseY-2);
    ctx.restore();

    // Put FOG 100 immediately before the 20 km axis label.
    ctx.save();
    ctx.globalAlpha = .96;
    ctx.fillStyle = cp.muted || '#666';
    ctx.font = 'bold 8px Arial';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
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
    const box = document.getElementById('sectionInfo');
    if (!box || !fog) return;
    const values = box.querySelector('.section-values');
    if (values && !values.querySelector('[data-fog-risk="1"]')) {
      const cell = document.createElement('div');
      cell.className = 'section-value';
      cell.dataset.fogRisk = '1';
      cell.innerHTML = '<small>Ryzyko mgły · FOG ENGINE</small><strong>' + fogRiskText(fog) + '</strong>';
      values.appendChild(cell);
    }
  }

  function installLegendNote() {
    const legend = document.querySelector('.legend');
    if (!legend || document.getElementById('fogMeteogramLegend')) return;
    const el = document.createElement('span');
    el.id = 'fogMeteogramLegend';
    el.innerHTML = '<b>Widzialność / FOG:</b> słupki EPIR FOG ENGINE od 40/100; FOG 100 = poziom 19,5 km.';
    legend.appendChild(el);
  }

  function install() {
    if (typeof draw !== 'function' || typeof showSectionInfo !== 'function') return false;
    if (!window.__epirFogMeteogramDrawWrapped) {
      const baseDraw = draw;
      draw = function() {
        baseDraw();
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
    return true;
  }

  function redraw() {
    if (!install()) return;
    try {
      if (typeof consensus !== 'undefined' && Array.isArray(consensus) && consensus.length) draw();
    } catch (_) { }
  }

  window.addEventListener('prognozaepir:fog-series-updated', redraw);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { install(); installLegendNote(); }, {once:true});
  } else {
    install(); installLegendNote();
  }
})();