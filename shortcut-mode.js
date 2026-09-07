'use strict';
(() => {
  // PrognozaEPIR działa jako zwykła strona / skrót. Usuń pozostałości po wcześniejszym PWA/WebAPK.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => Promise.all(regs.map(reg => {
        const scope = reg.scope || '';
        return scope.includes('/PrognozaEPIR/') ? reg.unregister() : false;
      })))
      .catch(() => undefined);
  }
  if ('caches' in window) {
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('prognozaepir-pwa-')).map(k => caches.delete(k))))
      .catch(() => undefined);
  }

  let fitMode = false;
  let resizeTimer = 0;

  function fitWholeMeteogram() {
    try {
      if (typeof stageSize !== 'function' || typeof applyTransform !== 'function' || typeof viewport === 'undefined') return;
      const s = stageSize();
      if (!s || !Number.isFinite(s.w) || !Number.isFinite(s.h) || s.w <= 0 || s.h <= 0) return;

      const vr = viewport.getBoundingClientRect();
      const frameW = Math.max(1, vr.width || viewport.clientWidth || 1);
      const top = Math.max(0, vr.top);
      const availableScreenH = Math.max(360, window.innerHeight - top - 12);
      const frameH = Math.min(860, availableScreenH);

      // Dopasuj cały meteogram, nie tylko jego szerokość. Jeżeli wysokość jest
      // ograniczeniem, wykres zostaje odpowiednio pomniejszony, aby dół nie był ucięty.
      const byWidth = frameW / s.w;
      const byHeight = frameH / s.h;
      zoom = clamp(Math.min(byWidth, byHeight), ZOOM_MIN, ZOOM_MAX);
      panX = 0;
      panY = 0;
      fitMode = true;
      applyTransform();

      // Dla wartości po transformacji ustaw dokładnie pełną wysokość zawartości.
      const fullH = Math.ceil(s.h * zoom);
      viewport.style.height = fullH + 'px';
      panY = 0;
      clampPan();
      stage.style.transform = 'translate(' + panX.toFixed(1) + 'px,' + panY.toFixed(1) + 'px) scale(' + zoom.toFixed(4) + ')';
      const z = document.getElementById('zoomReset');
      if (z) z.textContent = Math.round(zoom * 100) + '%';
    } catch (_) { }
  }

  function installSingleFitControl() {
    const old = document.getElementById('zoomFit');
    if (!old || old.dataset.fullFit === '1') return;

    // Klon usuwa stary listener fitWidth, który dopasowywał tylko szerokość.
    const btn = old.cloneNode(true);
    btn.dataset.fullFit = '1';
    btn.textContent = 'Dopasuj';
    btn.title = 'Dopasuj cały meteogram do ramki bez przycinania';
    old.replaceWith(btn);
    btn.addEventListener('click', () => {
      requestAnimationFrame(() => requestAnimationFrame(fitWholeMeteogram));
    });

    // Pozostałe przyciski wyłączają tryb automatycznego dopasowania.
    for (const id of ['zoomOut','zoomIn','zoomReset']) {
      document.getElementById(id)?.addEventListener('click', () => { fitMode = false; }, {capture:true});
    }

    // Kod meteogramu wywołuje fitWidth po zmianie horyzontu. Podmień funkcję
    // globalną, aby także wtedy dopasowywany był cały wykres.
    try { fitWidth = fitWholeMeteogram; } catch (_) { }
  }

  function install() {
    // Usuń ewentualny dodatkowy pasek z poprzedniej wersji bez przeładowania cache.
    document.getElementById('desktopZoomControls')?.remove();
    document.getElementById('desktopZoomControlsStyle')?.remove();
    installSingleFitControl();

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (fitMode) fitWholeMeteogram();
      }, 160);
    }, {passive:true});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, {once:true});
  } else {
    install();
  }
})();
