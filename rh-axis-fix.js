'use strict';
(() => {
  const canvas = document.getElementById('meteo');
  if (!canvas || typeof ctx === 'undefined' || typeof draw !== 'function') return;

  const VERSION = 'v0.10.13 HTML';
  const RH_COLOR = '#bd4723';
  const RH_AXIS_X_OFFSET = 38; // legacy compatibility marker for deployment check
  const MM_AXIS_RIGHT_OFFSET = 8;
  const RH_MM_GAP_PX = 3;
  const LEGEND_RIGHT_GAP = 30;

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

    // One fixed RH column: every percent sign ends at exactly the same X.
    // Reserve space for the widest precipitation label so the two scales never overlap.
    let widestMm = 0;
    for (let i=0;i<=4;i++) {
      const mm = maxRR*i/4;
      widestMm = Math.max(widestMm,ctx.measureText(mmText(mm,maxRR)).width);
    }
    const rhRight = m.x0-MM_AXIS_RIGHT_OFFSET-widestMm-RH_MM_GAP_PX;

    for (let i=0;i<=4;i++) {
      const rh = i*25;
      const yy = yForRh(rh,p);
      ctx.fillText(rh+'%',rhRight,yy);
    }

    ctx.restore();
  }

  // Narrower legend frame: its right border no longer crosses vertical section labels.
  if (typeof drawLegend === 'function' && typeof LEGEND_W !== 'undefined') {
    drawLegend = function(top,totalH) {
      const x=8;
      const w=Math.max(120,LEGEND_W-LEGEND_RIGHT_GAP-18);
      const cp=canvasPalette();
      ctx.fillStyle=cp.legend;ctx.fillRect(x,top,w,totalH);
      ctx.strokeStyle=cp.border;ctx.lineWidth=.9;ctx.strokeRect(x,top,w,totalH);
      let y=top+14,sx=x+9;
      legendTitle(sx,y,'Temperatury');y+=14;
      legendSample(sx,y,'#d43d31','Temp. powietrza');y+=13;
      legendSample(sx,y,'#25278f','Punkt rosy',[2,2]);y+=18;
      legendTitle(sx,y,'Opady / wilgotność');y+=14;
      legendSample(sx,y,'#039c29','Opad');y+=13;
      legendSample(sx,y,'#bd4723','Wilgotność');y+=18;
      legendTitle(sx,y,'Prawdopodobieństwo');y+=14;
      legendSample(sx,y,'#0b9f2b','Szansa opadu');y+=13;
      legendSample(sx,y,'#8b3db8','Szansa burzy');y+=18;
      legendTitle(sx,y,'Ciśnienie');y+=14;
      legendSample(sx,y,activeTheme()==='dark'?'#e7e9ed':'#222','QNH / MSLP');y+=18;
      legendTitle(sx,y,'Wiatr');y+=14;
      legendSample(sx,y,'#152f9a','Wiatr 10 m');y+=13;
      legendSample(sx,y,'#c33b2b','Porywy',[5,4]);y+=13;
      legendSample(sx,y,'#ef4444','Kierunek');y+=18;
      legendTitle(sx,y,'Chmury');y+=14;
      legendSample(sx,y,'#8d4a1a','Podstawa ≥5/8');y+=13;
      legendSample(sx,y,'#d66c12','Widzialność');y+=13;
      legendDot(sx,y,activeTheme()==='dark'?'#fff':'#555','Profil zachmurzenia');y+=18;
      legendTitle(sx,y,'Warstwy chmur');y+=14;
      legendSample(sx,y,'#f59e0b','Niskie 0–2 km');y+=13;
      legendSample(sx,y,'#22c55e','Średnie 2–5 km');y+=13;
      legendSample(sx,y,'#3b82f6','Wysokie 5–13 km');y+=18;
      ctx.fillStyle=cp.muted;ctx.font='8px Arial';ctx.textAlign='left';
      ctx.fillText('Dotknij panelu, aby',sx,y);
      ctx.fillText('zobaczyć parametry godziny.',sx,y+11);
    };
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
