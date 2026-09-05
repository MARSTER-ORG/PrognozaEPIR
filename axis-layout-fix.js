'use strict';
(() => {
  const canvas = document.getElementById('meteo');
  if (!canvas || typeof ctx === 'undefined' || typeof draw !== 'function') return;

  const INNER_PAD = 10;
  const HOUR_MS = 3600e3;
  const THREE_HOUR_MS = 3*HOUR_MS;
  const UTC_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

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

  function axisValue(v,id,min,max) {
    if (!Number.isFinite(v)) return '—';
    const span = Math.abs(max-min);
    if (id === 'press' || id === 'prob' || id === 'storm' || id === 'okta') return String(Math.round(v));
    if (id === 'cloud') return (Math.abs(v-Math.round(v))<0.05 ? Math.round(v) : v.toFixed(1)).toString();
    if (id === 'prec') return (v < 1 && span <= 5 ? v.toFixed(1) : (Math.abs(v-Math.round(v))<0.05 ? Math.round(v) : v.toFixed(1))).toString();
    if (span <= 6) return v.toFixed(1);
    return Math.abs(v-Math.round(v))<0.05 ? String(Math.round(v)) : v.toFixed(1);
  }

  function yFor(value,min,max,p) {
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || min === max) return p.y+p.h/2;
    const pad = Math.min(INNER_PAD,Math.max(7,p.h*0.1));
    return p.y+p.h-pad-(value-min)/(max-min)*Math.max(1,p.h-2*pad);
  }

  function redrawSingleAxis() {
    const m = canvas._meta;
    if (!m || !Array.isArray(m.data) || !Array.isArray(m.panelYs)) return;
    const cp = canvasPalette();
    const gutterLeft = m.x0-57;
    const gutterWidth = 55;

    ctx.save();

    ctx.fillStyle = cp.bg;
    for (const p of m.panelYs) ctx.fillRect(gutterLeft,p.y,gutterWidth,p.h);

    ctx.font = '9px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cp.muted;
    ctx.globalAlpha = 0.95;

    for (const p of m.panelYs) {
      const range = panelRange(p.id,m.data);
      if (!range) continue;
      const [min,max] = range;
      const divisions = p.id === 'cloud' ? 3 : 4;
      for (let i=0;i<=divisions;i++) {
        const value = min+(max-min)*i/divisions;
        const yy = yFor(value,min,max,p);
        ctx.fillText(axisValue(value,p.id,min,max),m.x0-8,yy);
      }
    }

    ctx.strokeStyle = cp.border;
    ctx.globalAlpha = 0.62;
    ctx.lineWidth = 0.85;
    for (const p of m.panelYs) {
      ctx.beginPath();
      ctx.moveTo(m.x0-2,p.y);
      ctx.lineTo(m.x1,p.y);
      ctx.stroke();
    }
    const last = m.panelYs[m.panelYs.length-1];
    if (last) {
      ctx.beginPath();
      ctx.moveTo(m.x0-2,last.y+last.h);
      ctx.lineTo(m.x1,last.y+last.h);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(m.x0,m.top);
    ctx.lineTo(m.x0,m.top+m.totalPanelH);
    ctx.stroke();
    ctx.restore();
  }

  function drawUtcZuluAxis() {
    const m = canvas._meta;
    if (!m || !Number.isFinite(m.t0) || !Number.isFinite(m.t1) || m.t1 <= m.t0) return;
    const cp = canvasPalette();
    const bottom = m.top + m.totalPanelH;
    const available = Math.max(22,(m.H || canvas.height) - bottom);
    const yHour = bottom + Math.min(10,available*0.42);
    const yDate = bottom + Math.min(21,available-3);
    const xFor = t => m.x0 + (t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
    const firstLabel = Math.ceil(m.t0/THREE_HOUR_MS)*THREE_HOUR_MS;

    ctx.save();
    ctx.fillStyle = cp.bg;
    ctx.fillRect(m.x0-58,bottom,Math.max(0,m.x1-(m.x0-58)),available);

    ctx.strokeStyle = cp.border;
    ctx.globalAlpha = 0.72;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(m.x0,bottom);
    ctx.lineTo(m.x1,bottom);
    ctx.stroke();

    ctx.globalAlpha = 0.96;
    ctx.fillStyle = cp.text;
    ctx.font = 'bold 8px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('UTC',m.x0-8,yHour);

    ctx.textAlign = 'center';
    ctx.font = '8px Arial';
    for (let t=firstLabel; t<=m.t1; t+=THREE_HOUR_MS) {
      const d = new Date(t);
      const hh = String(d.getUTCHours()).padStart(2,'0');
      const xx = xFor(t);
      const midnight = d.getUTCHours() === 0;

      ctx.strokeStyle = midnight ? cp.border : cp.grid2;
      ctx.globalAlpha = midnight ? 0.78 : 0.58;
      ctx.lineWidth = midnight ? 1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(xx,bottom);
      ctx.lineTo(xx,bottom+4);
      ctx.stroke();

      ctx.globalAlpha = 0.96;
      ctx.fillStyle = cp.text;
      ctx.font = midnight ? 'bold 8px Arial' : '8px Arial';
      ctx.fillText(hh+'Z',xx,yHour);

      if (midnight) {
        const day = String(d.getUTCDate()).padStart(2,'0');
        const month = UTC_MONTHS[d.getUTCMonth()];
        ctx.fillStyle = cp.muted;
        ctx.font = '7px Arial';
        ctx.fillText(day+' '+month,xx,yDate);
      }
    }

    ctx.restore();
  }

  if (!window.__epirSingleAxisWrapped) {
    window.__epirSingleAxisWrapped = true;
    const previousDraw = draw;
    draw = function() {
      const out = previousDraw.apply(this,arguments);
      redrawSingleAxis();
      drawUtcZuluAxis();
      return out;
    };
  }

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'v0.10.9 HTML';

  requestAnimationFrame(() => {
    if (typeof consensus !== 'undefined' && consensus.length) draw();
  });
})();
