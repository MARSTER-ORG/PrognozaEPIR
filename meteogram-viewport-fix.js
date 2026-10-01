'use strict';
(() => {
  if (window.__PROGNOZA_EPIR_METEOGRAM_VIEWPORT_FIX__) return;
  window.__PROGNOZA_EPIR_METEOGRAM_VIEWPORT_FIX__ = true;
  if (document.documentElement.dataset.epirPage !== 'index') return;

  const style = document.createElement('style');
  style.id = 'epir-meteogram-viewport-fix-style';
  style.textContent = `
    @media (min-width: 701px) {
      html[data-epir-page="index"] .app {
        width: 100% !important;
        max-width: 1120px !important;
      }
      html[data-epir-page="index"] .canvas-viewport {
        min-height: 0 !important;
      }
    }
  `;
  document.head.appendChild(style);

  const viewport = document.getElementById('canvasViewport');
  const stage = document.getElementById('canvasStage');
  const canvas = document.getElementById('meteo');
  if (!viewport || !stage || !canvas) return;

  let scheduled = 0;
  let busy = false;

  function readTransform() {
    const raw = stage.style.transform || '';
    const full = raw.match(/translate\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))px\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))px\s*\)\s*scale\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\)/i);
    if (full) {
      return {
        x: Number(full[1]) || 0,
        scale: Number(full[3]) > 0 ? Number(full[3]) : 1
      };
    }
    const translate = raw.match(/translate\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))px/i);
    const scale = raw.match(/scale\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i);
    return {
      x: translate ? (Number(translate[1]) || 0) : 0,
      scale: scale && Number(scale[1]) > 0 ? Number(scale[1]) : 1
    };
  }

  function syncDesktopViewport() {
    scheduled = 0;
    if (busy || window.innerWidth <= 700) return;

    const baseHeight = parseFloat(stage.style.height) || parseFloat(canvas.style.height) || 0;
    if (!(baseHeight > 0)) return;

    const transform = readTransform();
    const nextTransform = `translate(${transform.x.toFixed(1)}px,0px) scale(${transform.scale.toFixed(4)})`;
    const nextHeight = Math.max(1, Math.ceil(baseHeight * transform.scale));

    busy = true;
    try {
      if (stage.style.transform !== nextTransform) stage.style.transform = nextTransform;
      if (viewport.style.height !== `${nextHeight}px`) viewport.style.height = `${nextHeight}px`;
    } finally {
      busy = false;
    }
  }

  function scheduleSync() {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(syncDesktopViewport);
  }

  const stageObserver = new MutationObserver(() => {
    if (!busy) scheduleSync();
  });
  stageObserver.observe(stage, { attributes: true, attributeFilter: ['style'] });

  const canvasObserver = new MutationObserver(scheduleSync);
  canvasObserver.observe(canvas, { attributes: true, attributeFilter: ['style', 'width', 'height'] });

  window.addEventListener('resize', scheduleSync, { passive: true });
  document.querySelectorAll('#zoomOut,#zoomIn,#zoomReset,#zoomFit,[data-h],#view,#refresh').forEach(el => {
    el.addEventListener('click', () => requestAnimationFrame(scheduleSync));
    el.addEventListener('change', () => requestAnimationFrame(scheduleSync));
  });

  scheduleSync();
})();
