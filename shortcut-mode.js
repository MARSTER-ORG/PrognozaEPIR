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

  const FOG_INFO_THRESHOLD = 40;
  const FOG_MATCH_MS = 70 * 60e3;

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

  function nearestScoreRow(series,t) {
    if (!Array.isArray(series) || !series.length || !Number.isFinite(t)) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const row of series) {
      if (!row || !Number.isFinite(row.t) || !Number.isFinite(row.score)) continue;
      const diff = Math.abs(row.t - t);
      if (diff < bestDiff) {
        best = row;
        bestDiff = diff;
      }
    }
    return bestDiff <= FOG_MATCH_MS ? best : null;
  }

  function currentFogRow(t) {
    return nearestScoreRow(window.PrognozaEPIRFogSeries,t);
  }

  function currentMifgRow(t) {
    try {
      return nearestScoreRow(window.PrognozaEPIRMIFG?.getSeries?.(),t);
    } catch (_) {
      return null;
    }
  }

  function syncRiskCell(values,selector,dataName,label,row) {
    let cell = values.querySelector(selector);
    if (!row || !Number.isFinite(row.score) || row.score < FOG_INFO_THRESHOLD) {
      cell?.remove();
      return;
    }
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'section-value';
      cell.dataset[dataName] = '1';
      cell.innerHTML = '<small></small><strong></strong>';
      values.appendChild(cell);
    }
    const small = cell.querySelector('small');
    const strong = cell.querySelector('strong');
    if (small) small.textContent = label;
    if (strong) strong.textContent = Math.round(row.score) + '/100';
  }

  function refineVisibilityInfo(z,panelId) {
    if (panelId !== 'visfog') return;
    const box = document.getElementById('sectionInfo');
    const values = box?.querySelector('.section-values');
    if (!values) return;

    const fog = currentFogRow(z?.t);
    const mifg = currentMifgRow(z?.t);

    syncRiskCell(
      values,
      '[data-fog-risk="1"]',
      'fogRisk',
      'Prawdopodobieństwo mgły · FOG ENGINE',
      fog
    );
    syncRiskCell(
      values,
      '[data-mifg-risk="1"]',
      'mifgRisk',
      'Prawdopodobieństwo niskiej mgły <2 m · MIFG',
      mifg
    );
  }

  function installVisibilityInfoFilter() {
    if (window.__epirVisibilityInfoThresholdWrapped || typeof showSectionInfo !== 'function') return;
    const baseInfo = showSectionInfo;
    showSectionInfo = function(z,panelId) {
      const out = baseInfo.apply(this,arguments);
      refineVisibilityInfo(z,panelId);
      return out;
    };
    window.__epirVisibilityInfoThresholdWrapped = true;
  }

  function mergeWindPanels() {
    if (window.__epirWindPanelMerged || typeof PANELS === 'undefined' || !Array.isArray(PANELS)) return;
    const wind = PANELS.find(p => p?.id === 'wind');
    const dir = PANELS.find(p => p?.id === 'dir');
    if (!wind || !dir) return;

    // Zachowujemy łączną wysokość obu dotychczasowych sekcji, ale kierunek
    // staje się częścią sekcji Wiatr zamiast osobnym panelem.
    wind.h = Math.max(84,Number(wind.h) || 84) + Math.max(0,Number(dir.h) || 0);
    wind.label = 'wiatr / kierunek';
    dir.h = 0;
    dir.label = '';
    dir.unit = '';
    window.__epirWindPanelMerged = true;
  }

  function xForTime(t,m) {
    return m.x0 + (t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
  }

  function drawWindDirectionInsideWind() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m = cv._meta;
    if (!m || !Array.isArray(m.data) || !Array.isArray(m.panelYs)) return;
    const wind = m.panelYs.find(p => p.id === 'wind');
    const dir = m.panelYs.find(p => p.id === 'dir');
    if (!wind) return;

    const cp = typeof canvasPalette === 'function'
      ? canvasPalette()
      : {panel:'#20252b',grid2:'#59616b',muted:'#a6acb5',bg:'#111418'};

    // Osobny wiersz strzałek wewnątrz sekcji Wiatr.
    const rowH = Math.min(38,Math.max(30,wind.h*.27));
    const rowTop = wind.y + wind.h - rowH;
    const arrowY = rowTop + rowH*.62;

    ctx.save();
    ctx.beginPath();
    ctx.rect(m.x0,wind.y,m.x1-m.x0,wind.h);
    ctx.clip();

    // Lekko wydzielamy dolny wiersz kierunku, ale nadal pozostaje on częścią
    // jednej sekcji Wiatr.
    ctx.fillStyle = cp.panel;
    ctx.globalAlpha = .90;
    ctx.fillRect(m.x0,rowTop,m.x1-m.x0,rowH);
    ctx.globalAlpha = .72;
    ctx.strokeStyle = cp.grid2;
    ctx.lineWidth = .8;
    ctx.beginPath();
    ctx.moveTo(m.x0,rowTop);
    ctx.lineTo(m.x1,rowTop);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ef4444';
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1;
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i=0;i<m.data.length;i+=3) {
      const z = m.data[i];
      if (!Number.isFinite(z?.WD)) continue;
      const xx = xForTime(z.t,m);
      ctx.save();
      ctx.translate(xx,arrowY);
      ctx.rotate((z.WD+180)*Math.PI/180);
      ctx.strokeText('↑',0,6);
      ctx.fillText('↑',0,6);
      ctx.restore();
    }
    ctx.restore();

    // Stary panel kierunku ma wysokość 0, ale jego pionowy podpis mógłby zostać
    // narysowany na granicy paneli. Czyścimy wyłącznie pas podpisu, bez osi liczb.
    if (dir) {
      ctx.save();
      ctx.fillStyle = cp.bg;
      ctx.fillRect(m.x0-88,dir.y-42,28,84);
      ctx.restore();
    }
  }

  function installWindPanelMerge() {
    mergeWindPanels();
    if (window.__epirWindMergedDrawWrapped || typeof draw !== 'function') return;
    const baseDraw = draw;
    draw = function() {
      const out = baseDraw.apply(this,arguments);
      drawWindDirectionInsideWind();
      return out;
    };
    window.__epirWindMergedDrawWrapped = true;
  }

  function install() {
    // Usuń ewentualny dodatkowy pasek z poprzedniej wersji bez przeładowania cache.
    document.getElementById('desktopZoomControls')?.remove();
    document.getElementById('desktopZoomControlsStyle')?.remove();
    installSingleFitControl();
    installWindPanelMerge();
    installVisibilityInfoFilter();

    const hint = document.querySelector('.gesture-hint');
    if (hint) hint.innerHTML = '<b>Telefon:</b> jeden palec przewija stronę, dwa palce przesuwają i powiększają meteogram. <b>Komputer:</b> po powiększeniu przytrzymaj lewy przycisk myszy i przeciągnij wykres. − / + zmienia skalę, a <b>Dopasuj</b> mieści cały meteogram.';

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (fitMode) fitWholeMeteogram();
      }, 160);
    }, {passive:true});

    requestAnimationFrame(() => {
      try {
        if (typeof consensus !== 'undefined' && Array.isArray(consensus) && consensus.length && typeof draw === 'function') draw();
      } catch (_) { }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, {once:true});
  } else {
    install();
  }
})();
