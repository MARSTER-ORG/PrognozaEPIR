'use strict';
(() => {
  const canvas = document.getElementById('meteo');
  if (!canvas || typeof ctx === 'undefined' || typeof draw !== 'function') return;

  const VERSION = 'v0.10.11 HTML';
  const RH_COLOR = '#bd4723';
  const RH_AXIS_X_OFFSET = 38; // legacy compatibility marker for deployment check
  const MM_AXIS_RIGHT_OFFSET = 8;
  const RH_MM_GAP_PX = 3;

  function yForRh(value,p) {
    const pad = Math.min(9,Math.max(7,p.h*.09));
    const usable = Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(value/100)*usable;
  }

  function mmText(value,maxRR) {
    if (!Number.isFinite(value)) return '—';
    if (value < 1 && maxRR <= 5) return value.toFixed(1);
    return Math.abs(value-Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
  }

  function drawRhPercentAxis() {
    const m = canvas._meta;
    if (!m || !Array.isArray(m.panelYs) || !Array.isArray(m.data)) return;
    const p = m.panelYs.find(x=>x.id==='prec');
    if (!p) return;

    const maxRR = Math.max(2,...m.data.map(z=>Number(z.RR)||0));

    ctx.save();
    ctx.font = 'bold 9px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = RH_COLOR;
    ctx.globalAlpha = 0.98;

    for (let i=0;i<=4;i++) {
      const rh = i*25;
      const mm = maxRR*i/4;
      const yy = yForRh(rh,p);
      const mmLabel = mmText(mm,maxRR);
      const mmWidth = ctx.measureText(mmLabel).width;
      const mmLeft = m.x0-MM_AXIS_RIGHT_OFFSET-mmWidth;
      const rhRight = mmLeft-RH_MM_GAP_PX;
      ctx.fillText(rh+'%',rhRight,yy);
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
