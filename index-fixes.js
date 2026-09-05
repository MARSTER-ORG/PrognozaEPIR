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

  requestAnimationFrame(() => {
    viewportBaseH = 0;
    if (typeof draw === 'function' && typeof consensus !== 'undefined' && consensus.length) draw();
    requestAnimationFrame(fitWidth);
  });
})();
