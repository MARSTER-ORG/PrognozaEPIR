'use strict';
(() => {
  const canvas = document.getElementById('meteo');
  if (!canvas || typeof ctx === 'undefined' || typeof draw !== 'function') return;

  const CLOUD_COLORS = {
    low: '#f59e0b',   // niskie — pomarańczowy
    mid: '#22c55e',   // średnie — zielony
    high:'#3b82f6'    // wysokie — niebieski
  };
  const WIND_ARROW_COLOR = '#ef4444';
  const WIND_ARROW_FONT = 'bold 22px Arial';

  // Desktop: po powiększeniu meteogram można przesuwać trzymając lewy przycisk myszy.
  const viewport = document.getElementById('canvasViewport');
  if (viewport && typeof stageSize === 'function' && typeof applyTransform === 'function') {
    let mouseDrag = null;
    let suppressMouseClickUntil = 0;

    const canMousePan = () => {
      const s = stageSize();
      return s.w * zoom > viewport.clientWidth + 2 || s.h * zoom > viewport.clientHeight + 2;
    };

    const updateMouseCursor = () => {
      if (mouseDrag) viewport.style.cursor = 'grabbing';
      else viewport.style.cursor = canMousePan() ? 'grab' : 'default';
    };

    viewport.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !canMousePan()) return;
      mouseDrag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        panX,
        panY,
        moved: false
      };
      try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
      viewport.style.cursor = 'grabbing';
      e.preventDefault();
    });

    viewport.addEventListener('pointermove', e => {
      if (!mouseDrag || e.pointerId !== mouseDrag.id) return;
      const dx = e.clientX - mouseDrag.x;
      const dy = e.clientY - mouseDrag.y;
      if (Math.hypot(dx,dy) >= 3) mouseDrag.moved = true;
      panX = mouseDrag.panX + dx;
      panY = mouseDrag.panY + dy;
      applyTransform();
      e.preventDefault();
    });

    const endMouseDrag = e => {
      if (!mouseDrag || (e.pointerId != null && e.pointerId !== mouseDrag.id)) return;
      const moved = mouseDrag.moved;
      const pointerId = mouseDrag.id;
      mouseDrag = null;
      if (moved) suppressMouseClickUntil = Date.now() + 450;
      try { viewport.releasePointerCapture(pointerId); } catch (_) {}
      updateMouseCursor();
    };

    viewport.addEventListener('pointerup', endMouseDrag);
    viewport.addEventListener('pointercancel', endMouseDrag);
    viewport.addEventListener('lostpointercapture', endMouseDrag);
    viewport.addEventListener('pointerenter', updateMouseCursor);

    viewport.addEventListener('click', e => {
      if (Date.now() < suppressMouseClickUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    window.addEventListener('resize', updateMouseCursor);
    document.getElementById('zoomOut')?.addEventListener('click', () => requestAnimationFrame(updateMouseCursor));
    document.getElementById('zoomIn')?.addEventListener('click', () => requestAnimationFrame(updateMouseCursor));
    document.getElementById('zoomReset')?.addEventListener('click', () => requestAnimationFrame(updateMouseCursor));
    document.getElementById('zoomFit')?.addEventListener('click', () => requestAnimationFrame(updateMouseCursor));
    requestAnimationFrame(updateMouseCursor);
  }

  function xFor(t,m) {
    return m.x0 + (t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
  }

  function oktaY(v,p) {
    if (!Number.isFinite(v)) return NaN;
    const pad = Math.min(8,Math.max(5,p.h*0.075));
    const usable = Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(v/8)*usable;
  }

  function drawSeries(data,m,p,key,color,width) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.x0,p.y,m.x1-m.x0,p.h);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    let started = false;
    for (const z of data) {
      const y = oktaY(z[key],p);
      if (!Number.isFinite(y)) { started=false; continue; }
      const x = xFor(z.t,m);
      if (!started) { ctx.moveTo(x,y); started=true; }
      else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawCloudLines(m) {
    const p = (m.panelYs||[]).find(x=>x.id==='okta');
    if (!p || !Array.isArray(m.data)) return;
    drawSeries(m.data,m,p,'oktaL',CLOUD_COLORS.low,2.9);
    drawSeries(m.data,m,p,'oktaM',CLOUD_COLORS.mid,2.9);
    drawSeries(m.data,m,p,'oktaH',CLOUD_COLORS.high,3.0);
  }

  function drawWindDirection(m) {
    const p = (m.panelYs||[]).find(x=>x.id==='dir');
    if (!p || !Array.isArray(m.data)) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.x0,p.y,m.x1-m.x0,p.h);
    ctx.clip();
    ctx.fillStyle = WIND_ARROW_COLOR;
    ctx.strokeStyle = WIND_ARROW_COLOR;
    ctx.lineWidth = 1.2;
    ctx.font = WIND_ARROW_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i=0;i<m.data.length;i+=3) {
      const z=m.data[i];
      if (!Number.isFinite(z.WD)) continue;
      ctx.save();
      ctx.translate(xFor(z.t,m),p.y+p.h/2);
      ctx.rotate((z.WD+180)*Math.PI/180);
      ctx.strokeText('↑',0,7);
      ctx.fillText('↑',0,7);
      ctx.restore();
    }
    ctx.restore();
  }

  function redrawVisuals() {
    const m=canvas._meta;
    if (!m) return;
    drawCloudLines(m);
    drawWindDirection(m);
  }

  if (!window.__epirVisualStyleWrapped) {
    window.__epirVisualStyleWrapped=true;
    const previousDraw=draw;
    draw=function() {
      const out=previousDraw.apply(this,arguments);
      redrawVisuals();
      return out;
    };
  }

  const version=document.querySelector('.brand small');
  if (version) version.textContent='v0.10.9 HTML';

  requestAnimationFrame(()=>{
    if (typeof consensus!=='undefined' && consensus.length) draw();
  });
})();
