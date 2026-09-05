'use strict';
(() => {
  const canvas = document.getElementById('meteo');
  if (!canvas || typeof ctx === 'undefined' || typeof draw !== 'function') return;

  const VERSION = 'v0.10.11 HTML';
  const RH_COLOR = '#bd4723';
  const RH_AXIS_X_OFFSET = 38;

  function yForRh(value,p) {
    const pad = Math.min(9,Math.max(7,p.h*.09));
    const usable = Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(value/100)*usable;
  }

  function drawRhPercentAxis() {
    const m = canvas._meta;
    if (!m || !Array.isArray(m.panelYs)) return;
    const p = m.panelYs.find(x=>x.id==='prec');
    if (!p) return;

    ctx.save();
    ctx.font = 'bold 9px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = RH_COLOR;
    ctx.globalAlpha = 0.98;

    for (let i=0;i<=4;i++) {
      const rh = i*25;
      const yy = yForRh(rh,p);
      ctx.fillText(rh+'%',m.x0-RH_AXIS_X_OFFSET,yy);
    }

    ctx.restore();
  }

  if (!window.__epirRhAxisWrapped) {
    window.__epirRhAxisWrapped = true;
    const previousDraw = draw;
    draw = function() {
      const out = previousDraw.apply(this,arguments);
      drawRhPercentAxis();
      return out;
    };
  }

  const version = document.querySelector('.brand small');
  if (version) version.textContent = VERSION;

  requestAnimationFrame(()=>{
    if (typeof consensus !== 'undefined' && consensus.length) draw();
  });
})();
