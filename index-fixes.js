'use strict';
(() => {
  const vp = document.getElementById('canvasViewport');
  const st = document.getElementById('canvasStage');
  const canvas = document.getElementById('meteo');
  if (!vp || !st || !canvas || typeof stageSize !== 'function') return;

  let viewportBaseH = 0;
  let suppressClickUntil = 0;

  vp.style.touchAction = 'pan-y';
  vp.style.overscrollBehavior = 'contain';
  vp.style.userSelect = 'none';
  vp.style.webkitUserSelect = 'none';
  canvas.style.touchAction = 'pan-y';

  const calcViewportH = () => {
    const s = stageSize();
    const vw = Math.max(1, vp.clientWidth - 2);
    const fit = clamp(vw / s.w, ZOOM_MIN, ZOOM_MAX);
    const fitH = s.h * fit;
    const mobile = window.innerWidth <= 700;
    const cap = mobile
      ? Math.max(380, Math.min(650, window.innerHeight * 0.66))
      : Math.max(440, Math.min(860, window.innerHeight * 0.78));
    return Math.max(360, Math.min(fitH, cap));
  };

  setViewportHeight = function(force = false) {
    if (force || !viewportBaseH) viewportBaseH = calcViewportH();
    vp.style.height = Math.round(viewportBaseH) + 'px';
  };

  applyTransform = function() {
    setViewportHeight(false);
    clampPan();
    st.style.transform = `translate(${panX.toFixed(1)}px,${panY.toFixed(1)}px) scale(${zoom.toFixed(4)})`;
    const z = document.getElementById('zoomReset');
    if (z) z.textContent = Math.round(zoom * 100) + '%';
  };

  fitWidth = function() {
    const s = stageSize();
    zoom = clamp((vp.clientWidth - 2) / s.w, ZOOM_MIN, ZOOM_MAX);
    panX = 0;
    panY = 0;
    setViewportHeight(true);
    applyTransform();
  };

  updateGesture = function(e) {
    if (!gesture || e.touches.length < 2) return;
    const a = e.touches[0], b = e.touches[1];
    const mid = touchMid(a, b), vr = vp.getBoundingClientRect();
    const ratio = touchDist(a, b) / gesture.dist;
    const next = clamp(gesture.zoom * ratio, ZOOM_MIN, ZOOM_MAX);
    panX = (mid.x - vr.left) - gesture.contentX * next;
    panY = (mid.y - vr.top) - gesture.contentY * next;
    zoom = next;
    applyTransform();
  };

  vp.addEventListener('touchstart', e => {
    if (e.touches.length >= 2) {
      e.preventDefault();
      beginGesture(e);
    }
  }, {passive:false});

  vp.addEventListener('touchmove', e => {
    if (e.touches.length >= 2) {
      e.preventDefault();
      if (!gesture) beginGesture(e);
      updateGesture(e);
    }
  }, {passive:false});

  vp.addEventListener('touchend', e => {
    if (gesture && e.touches.length < 2) {
      gesture = null;
      lastGestureEnd = Date.now();
      suppressClickUntil = Date.now() + 550;
      applyTransform();
    }
  }, {passive:true});

  vp.addEventListener('touchcancel', () => {
    gesture = null;
    lastGestureEnd = Date.now();
    suppressClickUntil = Date.now() + 550;
    applyTransform();
  }, {passive:true});

  for (const ev of ['gesturestart','gesturechange','gestureend']) {
    vp.addEventListener(ev, e => e.preventDefault(), {passive:false,capture:true});
  }

  vp.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener('resize', () => { viewportBaseH = 0; });

  const hint = document.querySelector('.gesture-hint');
  if (hint) hint.innerHTML = '<b>Telefon:</b> jeden palec przewija stronę. <b>Dwa palce na meteogramie</b> przesuwają i powiększają wyłącznie wykres. − / + zmienia skalę, 100% przywraca 1:1, a <b>Dopasuj</b> mieści wykres na szerokość.';

  // --- Meteogram helper grid: left-side values + vertical hourly lines ---
  function panelRange(id, data) {
    if (!Array.isArray(data) || !data.length) return null;
    if (id === 'temp') return niceRange(data.flatMap(z => [z.T,z.Td]),1,5);
    if (id === 'prec') return [0,Math.max(2,...data.map(z => Number(z.RR)||0))];
    if (id === 'prob' || id === 'storm') return [0,100];
    if (id === 'press') return niceRange(data.map(z => z.P),1,8);
    if (id === 'wind') {
      const maxW = Math.max(10,...data.flatMap(z => [Number(z.WS)||0,Number(z.G)||0]));
      return [0,Math.ceil(maxW/5)*5];
    }
    if (id === 'cloud') return [0,15];
    if (id === 'okta') return [0,8];
    return null;
  }

  function axisValue(v, id, min, max) {
    if (!Number.isFinite(v)) return '—';
    const span = Math.abs(max-min);
    if (id === 'press' || id === 'prob' || id === 'storm' || id === 'okta') return String(Math.round(v));
    if (id === 'cloud') return (Math.abs(v-Math.round(v))<0.05 ? Math.round(v) : v.toFixed(1)).toString();
    if (id === 'prec') return (v < 1 && span <= 5 ? v.toFixed(1) : (Math.abs(v-Math.round(v))<0.05 ? Math.round(v) : v.toFixed(1))).toString();
    if (span <= 6) return v.toFixed(1);
    return Math.abs(v-Math.round(v))<0.05 ? String(Math.round(v)) : v.toFixed(1);
  }

  function drawMeteogramGrid() {
    const m = canvas._meta;
    if (!m || !Array.isArray(m.data) || m.data.length < 2 || typeof ctx === 'undefined') return;
    const cp = canvasPalette();
    const hourMs = 3600e3;
    const startHour = Math.ceil(m.t0/hourMs)*hourMs;
    const plotH = m.totalPanelH;

    ctx.save();

    // Vertical grid every hour; every third hour is a little stronger.
    for (let t=startHour, n=0; t<=m.t1; t+=hourMs, n++) {
      const xx = m.x0 + (t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
      const major = n % 3 === 0;
      ctx.globalAlpha = major ? 0.34 : 0.17;
      ctx.strokeStyle = major ? cp.grid : cp.grid2;
      ctx.lineWidth = major ? 0.8 : 0.55;
      ctx.setLineDash(major ? [] : [2,3]);
      ctx.beginPath();
      ctx.moveTo(xx,m.top);
      ctx.lineTo(xx,m.top+plotH);
      ctx.stroke();
    }

    // Horizontal value grid and numeric labels in the reserved left axis area.
    ctx.setLineDash([]);
    ctx.font = '9px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const p of m.panelYs || []) {
      const range = panelRange(p.id,m.data);
      if (!range) continue; // direction panel has no vertical numeric scale
      const [min,max] = range;
      const divisions = p.id === 'cloud' ? 3 : 4;
      for (let i=0;i<=divisions;i++) {
        const value = min + (max-min)*i/divisions;
        const yy = p.y + p.h - (value-min)/(max-min)*p.h;
        ctx.globalAlpha = (i===0 || i===divisions) ? 0.32 : 0.22;
        ctx.strokeStyle = cp.grid2;
        ctx.lineWidth = 0.65;
        ctx.beginPath();
        ctx.moveTo(m.x0,yy);
        ctx.lineTo(m.x1,yy);
        ctx.stroke();

        ctx.globalAlpha = 0.92;
        ctx.fillStyle = cp.muted;
        // At a shared panel boundary the lower panel's maximum (e.g. 100)
        // is shifted farther left, leaving the upper panel's minimum (e.g. 0)
        // clearly visible at its normal axis position.
        const boundaryLabelX = m.x0 - (i===divisions ? 31 : 7);
        ctx.fillText(axisValue(value,p.id,min,max),boundaryLabelX,yy);
      }
    }

    // Clear visual separation between value axis and plot.
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = cp.border;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(m.x0,m.top);
    ctx.lineTo(m.x0,m.top+plotH);
    ctx.stroke();
    ctx.restore();
  }

  if (typeof draw === 'function' && !window.__epirMeteogramGridWrapped) {
    window.__epirMeteogramGridWrapped = true;
    const baseDraw = draw;
    draw = function() {
      const out = baseDraw.apply(this,arguments);
      drawMeteogramGrid();
      return out;
    };
  }

  const meteoVersion = document.querySelector('.brand small');
  if (meteoVersion) meteoVersion.textContent = 'v0.10.4 HTML';

  requestAnimationFrame(() => {
    viewportBaseH = 0;
    if (typeof draw === 'function' && typeof consensus !== 'undefined' && consensus.length) draw();
    requestAnimationFrame(fitWidth);
  });
})();
