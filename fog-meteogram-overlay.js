'use strict';
(() => {
  const FOG_DRAW_THRESHOLD = 40;
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

  function drawFogBars() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m = cv._meta;
    if (!m || !Array.isArray(m.data) || m.data.length < 2) return;
    const p = Array.isArray(m.panelYs) ? m.panelYs.find(x => x.id === 'visfog') : null;
    if (!p) return;

    const x0 = m.x0, x1 = m.x1, plotW = x1 - x0;
    const step = Math.max(3, plotW / Math.max(1, m.data.length - 1));
    const barW = Math.max(2.5, step * .58);
    const topPad = 13;
    const bottomPad = 8;
    const maxBarH = Math.max(12, p.h - topPad - bottomPad);
    const baseY = p.y + p.h - bottomPad;
    const x = t => clip(x0 + (t - m.t0) / (m.t1 - m.t0) * plotW, x0, x1);

    let drawn = 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, p.y, plotW, p.h);
    ctx.clip();

    for (const z of m.data) {
      const fog = fogAt(z.t);
      if (!fog || fog.score < FOG_DRAW_THRESHOLD) continue;
      const frac = clip((fog.score - FOG_DRAW_THRESHOLD) / (100 - FOG_DRAW_THRESHOLD), 0, 1);
      const h = Math.max(3, frac * maxBarH);
      const xx = x(z.t);
      ctx.fillStyle = fogColor(fog.score);
      ctx.fillRect(xx - barW / 2, baseY - h, barW, h);
      drawn++;
    }

    const cp = typeof canvasPalette === 'function' ? canvasPalette() : {muted:'#666',grid2:'#999'};
    ctx.strokeStyle = cp.grid2 || '#999';
    ctx.globalAlpha = .48;
    ctx.setLineDash([3,3]);
    ctx.lineWidth = .8;
    ctx.beginPath();ctx.moveTo(x0,baseY);ctx.lineTo(x1,baseY);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x0,p.y+topPad);ctx.lineTo(x1,p.y+topPad);ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = .95;
    ctx.fillStyle = cp.muted || '#666';
    ctx.font = 'bold 8px Arial';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';ctx.fillText('FOG 100',x0+5,p.y+2);
    ctx.textAlign = 'right';ctx.fillText('FOG ≥40',x1-5,baseY-11);
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
    if (!box.querySelector('[data-fog-help="1"]')) {
      const help = document.createElement('div');
      help.className = 'section-help';
      help.dataset.fogHelp = '1';
      help.textContent = 'Słupki FOG są rysowane wyłącznie w tym panelu od 40/100. Wysokość przedstawia wynik EPIR FOG ENGINE w zakresie 40–100; pomarańczowa linia jest niezależną prognozą widzialności.';
      box.appendChild(help);
    }
  }

  function installLegendNote() {
    const legend = document.querySelector('.legend');
    if (!legend || document.getElementById('fogMeteogramLegend')) return;
    const el = document.createElement('span');
    el.id = 'fogMeteogramLegend';
    el.innerHTML = '<b>Widzialność / FOG:</b> osobny panel nad chmurami; słupki EPIR FOG ENGINE od 40/100.';
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