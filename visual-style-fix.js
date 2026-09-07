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

    // --- Desktop hover tooltip: skrót danych dla wskazanej sekcji i godziny. ---
    const tooltip = document.createElement('div');
    tooltip.id = 'epirMeteogramTooltip';
    Object.assign(tooltip.style, {
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      zIndex: '10000',
      minWidth: '150px',
      maxWidth: '280px',
      padding: '8px 10px',
      borderRadius: '7px',
      font: '12px/1.35 Arial, sans-serif',
      boxShadow: '0 5px 18px rgba(0,0,0,.34)',
      backdropFilter: 'blur(3px)'
    });
    document.body.appendChild(tooltip);

    const hideTooltip = () => { tooltip.style.display = 'none'; };
    const finiteNum = v => Number.isFinite(Number(v));
    const n = (v,d=0) => finiteNum(v) ? Number(v).toFixed(d) : '—';
    const kt = v => finiteNum(v) ? Math.round(Number(v)*1.94384) : null;
    const DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    const dir = deg => finiteNum(deg) ? DIRS[Math.round(Number(deg)/22.5)%16] : '—';
    const h = v => finiteNum(v) ? Math.round(Number(v))+' m' : '—';
    const layer = (okta,height) => {
      if (!finiteNum(okta)) return '—';
      const o = Math.round(Number(okta));
      return o+'/8'+(finiteNum(height)?' · ~'+Math.round(Number(height))+' m':'');
    };
    const utcLabel = t => {
      const d = new Date(t);
      return String(d.getUTCDate()).padStart(2,'0')+'.'+String(d.getUTCMonth()+1).padStart(2,'0')+' · '+String(d.getUTCHours()).padStart(2,'0')+'Z';
    };

    const tooltipData = (z,id) => {
      if (id === 'temp') return {
        title:'Temperatura',
        rows:[['T',n(z.T,1)+' °C'],['Td',n(z.Td,1)+' °C'],['RH',n(z.RH,0)+'%']]
      };
      if (id === 'prec') return {
        title:'Opad / wilgotność',
        rows:[['Opad',n(z.RR,2)+' mm/h'],['RH',n(z.RH,0)+'%']]
      };
      if (id === 'probstorm' || id === 'prob' || id === 'storm') return {
        title:'Prawdopodobieństwo',
        rows:[['Opad',n(z.wet,0)+'%'],['Burza',n(z.storm,0)+'%']]
      };
      if (id === 'press') return {
        title:'Ciśnienie',
        rows:[['QNH / MSLP',n(z.P,0)+' hPa']]
      };
      if (id === 'wind') return {
        title:'Wiatr',
        rows:[
          ['Wiatr',finiteNum(z.WS)?n(z.WS,1)+' m/s · '+kt(z.WS)+' kt':'—'],
          ['Porywy',finiteNum(z.G)?n(z.G,1)+' m/s · '+kt(z.G)+' kt':'—'],
          ['Kierunek',finiteNum(z.WD)?Math.round(Number(z.WD))+'° '+dir(z.WD):'—']
        ]
      };
      if (id === 'dir') return {
        title:'Kierunek wiatru',
        rows:[
          ['Kierunek',finiteNum(z.WD)?Math.round(Number(z.WD))+'° '+dir(z.WD):'—'],
          ['Wiatr',finiteNum(z.WS)?kt(z.WS)+' kt':'—']
        ]
      };
      if (id === 'visfog') return {
        title:'Widzialność / mgła',
        rows:[['Widzialność',finiteNum(z.VIS)?n(Number(z.VIS)/1000,1)+' km':'—']]
      };
      if (id === 'cloud') return {
        title:'Profil chmur',
        rows:[
          ['Podstawa ≥5/8',finiteNum(z.ceiling)?h(z.ceiling):'brak'],
          ['Niskie',layer(z.oktaL,z.lowH)],
          ['Średnie',layer(z.oktaM,z.midH)],
          ['Wysokie',layer(z.oktaH,z.highH)]
        ]
      };
      if (id === 'okta') return {
        title:'Warstwy chmur',
        rows:[
          ['Niskie',layer(z.oktaL,z.lowH)],
          ['Średnie',layer(z.oktaM,z.midH)],
          ['Wysokie',layer(z.oktaH,z.highH)]
        ]
      };
      return null;
    };

    const showTooltip = (e,z,panelId) => {
      const data = tooltipData(z,panelId);
      if (!data) { hideTooltip(); return; }
      const dark = typeof activeTheme === 'function' ? activeTheme()==='dark' : true;
      tooltip.style.background = dark ? 'rgba(20,24,29,.96)' : 'rgba(255,255,255,.97)';
      tooltip.style.color = dark ? '#eef1f5' : '#222';
      tooltip.style.border = dark ? '1px solid #66707b' : '1px solid #858585';

      const rows = data.rows.map(([k,v]) =>
        '<div style="display:flex;gap:12px;justify-content:space-between;white-space:nowrap">'+
        '<span style="opacity:.72">'+k+'</span><b>'+v+'</b></div>'
      ).join('');
      tooltip.innerHTML =
        '<div style="display:flex;gap:14px;justify-content:space-between;margin-bottom:5px">'+
        '<b>'+data.title+'</b><span style="opacity:.72;white-space:nowrap">'+utcLabel(z.t)+'</span></div>'+rows;
      tooltip.style.display = 'block';

      const gap = 14;
      const box = tooltip.getBoundingClientRect();
      let left = e.clientX + gap;
      let top = e.clientY + gap;
      if (left + box.width > window.innerWidth - 8) left = e.clientX - box.width - gap;
      if (top + box.height > window.innerHeight - 8) top = e.clientY - box.height - gap;
      tooltip.style.left = Math.max(6,left)+'px';
      tooltip.style.top = Math.max(6,top)+'px';
    };

    canvas.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' || mouseDrag) { hideTooltip(); return; }
      const m = canvas._meta;
      if (!m || !Array.isArray(m.data) || !m.data.length || !Array.isArray(m.panelYs)) { hideTooltip(); return; }
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) { hideTooltip(); return; }
      const sx = (e.clientX-rect.left)/rect.width*m.W;
      const sy = (e.clientY-rect.top)/rect.height*m.H;
      if (sx < m.x0 || sx > m.x1) { hideTooltip(); return; }
      const panel = m.panelYs.find(p => sy >= p.y && sy <= p.y+p.h);
      if (!panel) { hideTooltip(); return; }
      const t = m.t0 + (sx-m.x0)/(m.x1-m.x0)*(m.t1-m.t0);
      let best = m.data[0];
      for (const z of m.data) if (Math.abs(z.t-t) < Math.abs(best.t-t)) best = z;
      showTooltip(e,best,panel.id);
    });
    canvas.addEventListener('pointerleave', hideTooltip);

    viewport.addEventListener('pointerdown', e => {
      hideTooltip();
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
    viewport.addEventListener('pointerleave', hideTooltip);

    viewport.addEventListener('click', e => {
      if (Date.now() < suppressMouseClickUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    window.addEventListener('resize', () => { hideTooltip(); updateMouseCursor(); });
    window.addEventListener('scroll', hideTooltip, {passive:true});
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
