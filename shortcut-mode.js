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
  const DEW_DARK = '#627dff';
  const WIND_DARK = '#4f7cff';
  const DEW_LIGHT = '#25278f';
  const WIND_LIGHT = '#152f9a';

  const isDark = () => typeof activeTheme === 'function' ? activeTheme() === 'dark' : true;
  const dewColor = () => isDark() ? DEW_DARK : DEW_LIGHT;
  const windColor = () => isDark() ? WIND_DARK : WIND_LIGHT;

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
      const byWidth = frameW / s.w;
      const byHeight = frameH / s.h;

      zoom = clamp(Math.min(byWidth, byHeight), ZOOM_MIN, ZOOM_MAX);
      panX = 0;
      panY = 0;
      fitMode = true;
      applyTransform();

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

    const btn = old.cloneNode(true);
    btn.dataset.fullFit = '1';
    btn.textContent = 'Dopasuj';
    btn.title = 'Dopasuj cały meteogram do ramki bez przycinania';
    old.replaceWith(btn);
    btn.addEventListener('click', () => {
      requestAnimationFrame(() => requestAnimationFrame(fitWholeMeteogram));
    });

    for (const id of ['zoomOut','zoomIn','zoomReset']) {
      document.getElementById(id)?.addEventListener('click', () => { fitMode = false; }, {capture:true});
    }

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

    syncRiskCell(values,'[data-fog-risk="1"]','fogRisk','Prawdopodobieństwo mgły · FOG ENGINE',fog);
    syncRiskCell(values,'[data-mifg-risk="1"]','mifgRisk','Prawdopodobieństwo niskiej mgły <2 m · MIFG',mifg);
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

  // Nie twórz ponownie dolnego pasa kierunku. Ostateczny renderer wiatru
  // z meteogram-visfog-cleanup.js odpowiada za skalę 0..max i strzałki pośrodku.
  function normalizeWindPanels() {
    if (typeof PANELS === 'undefined' || !Array.isArray(PANELS)) return;
    const wind = PANELS.find(p => p?.id === 'wind');
    const dir = PANELS.find(p => p?.id === 'dir');
    if (wind) {
      wind.h = 84;
      wind.label = 'wiatr';
      wind.unit = '(m/s)';
    }
    if (dir) {
      dir.h = 0;
      dir.label = '';
      dir.unit = '';
    }
  }

  function installLegendContrast() {
    if (window.__epirLegendContrastWrapped || typeof legendSample !== 'function') return;
    const baseLegendSample = legendSample;
    legendSample = function(x,y,color,label,dash=[]) {
      if (label === 'Punkt rosy') color = dewColor();
      if (label === 'Wiatr 10 m') color = windColor();
      return baseLegendSample.call(this,x,y,color,label,dash);
    };
    window.__epirLegendContrastWrapped = true;
  }

  function drawContrastSeries() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined' || typeof niceRange !== 'function') return;
    const m = cv._meta;
    if (!m || !Array.isArray(m.data) || !m.data.length || !Array.isArray(m.panelYs)) return;

    const temp = m.panelYs.find(p => p?.id === 'temp');
    const wind = m.panelYs.find(p => p?.id === 'wind');
    const x = t => m.x0 + (t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);

    function strokeSeries(panel,key,color,width,yFor,dash=[]) {
      if (!panel || panel.h <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(m.x0,panel.y,m.x1-m.x0,panel.h);
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let started = false;
      for (const z of m.data) {
        const v = z?.[key];
        if (!Number.isFinite(z?.t) || !Number.isFinite(v)) { started = false; continue; }
        const xx = x(z.t);
        const yy = yFor(v);
        if (!Number.isFinite(yy)) { started = false; continue; }
        if (!started) { ctx.moveTo(xx,yy); started = true; }
        else ctx.lineTo(xx,yy);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (temp) {
      const range = niceRange(m.data.flatMap(z => [z.T,z.Td]),1,5);
      const pad = Math.min(9,Math.max(7,temp.h*.09));
      const usable = Math.max(1,temp.h-2*pad);
      const yTemp = v => temp.y + temp.h - pad - (v-range[0])/(range[1]-range[0])*usable;
      strokeSeries(temp,'Td',dewColor(),1.8,yTemp,[3,3]);
    }

    if (wind) {
      const maxW = Math.max(10,...m.data.flatMap(z => [Number(z.WS)||0,Number(z.G)||0]));
      const windMax = Math.ceil(maxW/5)*5;
      const yWind = v => wind.y + wind.h - Math.max(0,Math.min(windMax,Number(v))) / windMax * wind.h;
      strokeSeries(wind,'WS',windColor(),2.0,yWind);
    }
  }

  function installContrastSeries() {
    if (window.__epirContrastSeriesWrapped || typeof draw !== 'function') return;
    const baseDraw = draw;
    draw = function() {
      normalizeWindPanels();
      const out = baseDraw.apply(this,arguments);
      drawContrastSeries();
      return out;
    };
    window.__epirContrastSeriesWrapped = true;
  }

  function install() {
    document.getElementById('desktopZoomControls')?.remove();
    document.getElementById('desktopZoomControlsStyle')?.remove();
    installSingleFitControl();
    normalizeWindPanels();
    installLegendContrast();
    installContrastSeries();
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
