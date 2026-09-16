'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__PROGNOZA_EPIR_METEOGRAM_TAP_DETAILS__) return;

  const canvas = document.getElementById('meteo');
  if (!canvas) return;
  window.__PROGNOZA_EPIR_METEOGRAM_TAP_DETAILS__ = true;

  const TAP_MAX_MS = 700;
  const TAP_MOVE_PX = 12;
  const finite = Number.isFinite;
  let down = null;
  let selection = null;

  function valueCell(label, value) {
    if (typeof infoValue === 'function') return infoValue(label, value);
    return '<div class="section-value"><small>' + label + '</small><strong>' + value + '</strong></div>';
  }

  function formatHour(t) {
    if (typeof fmt === 'function') {
      return fmt(t, {weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    }
    try { return new Date(t).toISOString().slice(0,16).replace('T',' ') + ' UTC'; }
    catch (_) { return '—'; }
  }

  // The deployed meteogram combines rain and thunderstorm probability into one panel.
  // Handle it explicitly so a tap always returns useful hourly values.
  if (typeof showSectionInfo === 'function' && !window.__epirTapInfoWrapped) {
    const baseInfo = showSectionInfo;
    showSectionInfo = function(z, panelId) {
      if (panelId !== 'probstorm') return baseInfo(z, panelId);
      const box = document.getElementById('sectionInfo');
      if (!box || !z) return;
      box.classList.remove('empty');
      const vals = [
        valueCell('Szansa opadu', finite(z.wet) ? Math.round(z.wet) + '%' : '—'),
        valueCell('Szansa burzy', finite(z.storm) ? Math.round(z.storm) + '%' : '—'),
        valueCell('Opad konsensusu', finite(z.RR) ? Number(z.RR).toFixed(2) + ' mm/h' : '—'),
        valueCell('Liczba modeli', z.count == null ? '—' : String(z.count))
      ];
      box.innerHTML = '<div class="section-head"><b>Szansa opadu / burzy</b><span>' + formatHour(z.t) + '</span></div>' +
        '<div class="section-values">' + vals.join('') + '</div>' +
        '<div class="section-help">Wartości dotyczą wybranej godziny UTC. Szansa opadu i burzy jest konsensusem dostępnych modeli.</div>';
    };
    window.__epirTapInfoWrapped = true;
  }

  function hitAt(clientX, clientY) {
    const m = canvas._meta;
    if (!m || !Array.isArray(m.data) || !m.data.length || !Array.isArray(m.panelYs)) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const sx = (clientX - rect.left) / rect.width * m.W;
    const sy = (clientY - rect.top) / rect.height * m.H;
    if (sx < m.x0 || sx > m.x1) return null;
    const panel = m.panelYs.find(p => p && p.h > 0 && sy >= p.y && sy <= p.y + p.h);
    if (!panel) return null;
    const t = m.t0 + (sx - m.x0) / (m.x1 - m.x0) * (m.t1 - m.t0);
    let row = m.data[0];
    for (const candidate of m.data) {
      if (Math.abs(candidate.t - t) < Math.abs(row.t - t)) row = candidate;
    }
    return {row, panel};
  }

  function drawSelectionMarker() {
    const s = selection || window.PrognozaEPIRMeteogramSelection;
    const m = canvas._meta;
    if (!s || !m || !Array.isArray(m.panelYs) || !finite(s.t) || !finite(m.t0) || !finite(m.t1) || m.t1 <= m.t0) return;
    if (s.t < m.t0 || s.t > m.t1) return;
    const panel = m.panelYs.find(p => p && p.id === s.panelId && p.h > 0);
    if (!panel) return;
    const x = m.x0 + (s.t - m.t0) / (m.t1 - m.t0) * (m.x1 - m.x0);
    if (!finite(x)) return;
    const dark = typeof activeTheme === 'function' && activeTheme() === 'dark';
    const stroke = dark ? 'rgba(235,242,255,.92)' : 'rgba(31,42,117,.88)';
    const fill = dark ? '#e7e9ed' : '#1f2a75';
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.x0, panel.y, m.x1 - m.x0, panel.h);
    ctx.clip();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4,3]);
    ctx.beginPath();
    ctx.moveTo(x, panel.y + 1);
    ctx.lineTo(x, panel.y + panel.h - 1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, panel.y + 6, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (typeof draw === 'function' && !window.__epirTapDrawWrapped) {
    const baseDraw = draw;
    draw = function() {
      const out = baseDraw.apply(this, arguments);
      drawSelectionMarker();
      return out;
    };
    window.__epirTapDrawWrapped = true;
  }

  function selectAt(clientX, clientY) {
    const hit = hitAt(clientX, clientY);
    if (!hit) return false;
    selection = {t:hit.row.t, panelId:hit.panel.id};
    window.PrognozaEPIRMeteogramSelection = {...selection};
    if (typeof showSectionInfo === 'function') showSectionInfo(hit.row, hit.panel.id);
    // Full redraw removes the previous marker and redraws only the current selection.
    if (typeof draw === 'function') draw();
    else drawSelectionMarker();
    return true;
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.isPrimary === false) return;
    down = {id:e.pointerId, x:e.clientX, y:e.clientY, at:performance.now()};
  }, {passive:true});

  canvas.addEventListener('pointercancel', e => {
    if (down && down.id === e.pointerId) down = null;
  }, {passive:true});

  canvas.addEventListener('pointerup', e => {
    if (!down || down.id !== e.pointerId) return;
    const start = down;
    down = null;
    const dt = performance.now() - start.at;
    const move = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (dt > TAP_MAX_MS || move > TAP_MOVE_PX) return;
    selectAt(e.clientX, e.clientY);
  }, {passive:true});
})();
