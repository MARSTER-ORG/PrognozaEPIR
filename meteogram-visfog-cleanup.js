'use strict';
(() => {
  if (typeof showSectionInfo !== 'function' || typeof drawLegend !== 'function') return;

  const LEGEND_RIGHT_GAP = 30;
  const WIND_ARROW = '#ef4444';
  const FOG_TOOLTIP_THRESHOLD = 40;
  const MAX_RISK_MATCH_MS = 70 * 60e3;
  const HOUR = 3600e3;

  function mergeWindPanels() {
    if (typeof PANELS === 'undefined' || !Array.isArray(PANELS)) return;
    const wind = PANELS.find(p => p && p.id === 'wind');
    const dir = PANELS.find(p => p && p.id === 'dir');
    if (wind) wind.h = 84;
    if (dir) dir.h = 0;
  }

  mergeWindPanels();

  function nearestRiskRow(series,t) {
    if (!Array.isArray(series) || !series.length || !finite(t)) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const row of series) {
      if (!row || !finite(row.t) || !finite(row.score)) continue;
      const diff = Math.abs(row.t - t);
      if (diff < bestDiff) {
        best = row;
        bestDiff = diff;
      }
    }
    return bestDiff <= MAX_RISK_MATCH_MS ? best : null;
  }

  function fogAt(t) {
    return nearestRiskRow(window.PrognozaEPIRFogSeries,t);
  }

  function mifgAt(t) {
    try {
      const rows = window.PrognozaEPIRMIFG?.getSeries?.();
      return nearestRiskRow(Array.isArray(rows) ? rows : [],t);
    } catch (_) {
      return null;
    }
  }

  function appendRiskCell(values,label,score,datasetKey) {
    if (!values || !finite(score) || score < FOG_TOOLTIP_THRESHOLD) return;
    const cell = document.createElement('div');
    cell.className = 'section-value';
    cell.dataset[datasetKey] = '1';
    cell.innerHTML = '<small>'+label+'</small><strong>'+Math.round(score)+'/100</strong>';
    values.appendChild(cell);
  }

  function redrawWindPanelForeground() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m = cv._meta;
    if (!m || !Array.isArray(m.panelYs) || !Array.isArray(m.data) || !m.data.length) return;
    const p = m.panelYs.find(row => row && row.id === 'wind');
    if (!p || !finite(p.y) || !finite(p.h) || p.h <= 0) return;

    const x0 = m.x0, x1 = m.x1;
    const plotW = x1 - x0;
    const x = t => clamp(x0 + (t - m.t0) / (m.t1 - m.t0) * plotW, x0, x1);
    const cp = canvasPalette();
    const maxW = Math.max(10,...m.data.flatMap(z=>[Number(z.WS)||0,Number(z.G)||0]));
    const windMax = Math.ceil(maxW/5)*5;
    const y = value => p.y + p.h - clamp(Number(value)||0,0,windMax) / windMax * p.h;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0,p.y,plotW,p.h);
    ctx.clip();

    // Cały panel jest budowany od nowa. Dzięki temu żadne stare strzałki
    // ani pomocniczy techniczny panel kierunku nie mogą pozostać na wykresie.
    ctx.fillStyle = cp.panel;
    ctx.fillRect(x0,p.y,plotW,p.h);

    // Pionowa siatka godzinowa jak w pozostałych sekcjach.
    const firstHour = Math.ceil(m.t0/HOUR)*HOUR;
    for (let t=firstHour;t<=m.t1;t+=HOUR) {
      const xx=x(t), major=(new Date(t).getUTCHours()%3===0);
      ctx.save();
      ctx.strokeStyle=major?cp.grid:cp.grid2;
      ctx.globalAlpha=major?.72:.42;
      ctx.lineWidth=major?1.15:.75;
      ctx.beginPath();ctx.moveTo(xx,p.y);ctx.lineTo(xx,p.y+p.h);ctx.stroke();
      ctx.restore();
    }

    // Skala wiatru bez marginesu wewnętrznego: 0 jest dokładnie dolną
    // krawędzią sekcji, a maksimum dokładnie górną krawędzią.
    for (let i=0;i<=4;i++) {
      const value=windMax*i/4;
      const yy=y(value);
      ctx.save();
      ctx.strokeStyle=cp.grid2;
      ctx.globalAlpha=(i===0||i===4)?.58:.36;
      ctx.lineWidth=.8;
      ctx.beginPath();ctx.moveTo(x0,yy);ctx.lineTo(x1,yy);ctx.stroke();
      ctx.restore();
    }

    function drawSeries(key,color,width,dash=[]) {
      ctx.strokeStyle=color;
      ctx.lineWidth=width;
      ctx.setLineDash(dash);
      ctx.lineJoin='round';
      ctx.lineCap='round';
      ctx.beginPath();
      let started=false;
      for (const z of m.data) {
        if (!finite(z?.t) || !finite(z?.[key])) { started=false; continue; }
        const xx=x(z.t), yy=y(z[key]);
        if (!started) { ctx.moveTo(xx,yy); started=true; }
        else ctx.lineTo(xx,yy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawSeries('WS','#152f9a',1.8);
    drawSeries('G','#c33b2b',1.9,[5,4]);

    // Jeden zestaw strzałek, dokładnie w połowie wysokości sekcji Wiatr,
    // rysowany na końcu na pierwszym planie.
    const cy=p.y+p.h/2;
    const dark=typeof activeTheme==='function' && activeTheme()==='dark';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.font='bold 22px Arial';
    ctx.lineJoin='round';
    ctx.lineCap='round';
    for (let i=0;i<m.data.length;i+=3) {
      const z=m.data[i];
      if (!z || !finite(z.WD) || !finite(z.t)) continue;
      ctx.save();
      ctx.translate(x(z.t),cy);
      ctx.rotate((z.WD+180)*Math.PI/180);
      ctx.strokeStyle=dark?'rgba(10,15,20,.94)':'rgba(255,255,255,.96)';
      ctx.lineWidth=3.4;
      ctx.strokeText('↑',0,0);
      ctx.fillStyle=WIND_ARROW;
      ctx.fillText('↑',0,0);
      ctx.restore();
    }

    ctx.restore();

    // Usuń stare liczby skali z wersji z wewnętrznym paddingiem i narysuj
    // je ponownie dokładnie na tych samych wysokościach co nowe linie.
    ctx.save();
    ctx.fillStyle=cp.bg;
    ctx.fillRect(x0-44,p.y-2,43,p.h+4);
    ctx.fillStyle=cp.muted;
    ctx.font='9px Arial';
    ctx.textAlign='right';
    ctx.textBaseline='middle';
    for (let i=0;i<=4;i++) {
      const value=windMax*i/4;
      const yy=y(value);
      const label=Math.abs(value-Math.round(value))<.05?String(Math.round(value)):value.toFixed(1);
      ctx.fillText(label,x0-8,yy);
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle=cp.border;
    ctx.globalAlpha=.98;
    ctx.lineWidth=1;
    ctx.strokeRect(x0,p.y,plotW,p.h);
    ctx.restore();
  }

  function installFogHoverTooltip() {
    const canvas = document.getElementById('meteo');
    if (!canvas || canvas.dataset.epirFogHoverInstalled === '1') return;
    canvas.dataset.epirFogHoverInstalled = '1';

    function appendHoverRow(tooltip,label,score,attr) {
      if (!tooltip || !finite(score) || score < FOG_TOOLTIP_THRESHOLD) return;
      const row = document.createElement('div');
      row.setAttribute(attr,'1');
      row.style.cssText = 'display:flex;gap:12px;justify-content:space-between;white-space:nowrap';
      const key = document.createElement('span');
      key.style.opacity = '.72';
      key.textContent = label;
      const val = document.createElement('b');
      val.textContent = Math.round(score) + '/100';
      row.append(key,val);
      tooltip.appendChild(row);
    }

    function updateTooltip(clientX,clientY) {
      const tooltip = document.getElementById('epirMeteogramTooltip');
      const m = canvas._meta;
      if (!tooltip || tooltip.style.display === 'none' || !m || !Array.isArray(m.data) || !m.data.length || !Array.isArray(m.panelYs)) return;

      tooltip.querySelectorAll('[data-epir-fog-hover],[data-epir-mifg-hover]').forEach(el => el.remove());

      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const sx = (clientX - rect.left) / rect.width * m.W;
      const sy = (clientY - rect.top) / rect.height * m.H;
      if (sx < m.x0 || sx > m.x1) return;

      const panel = m.panelYs.find(p => p && p.h > 0 && sy >= p.y && sy <= p.y + p.h);
      if (!panel || panel.id !== 'visfog') return;

      const t = m.t0 + (sx - m.x0) / (m.x1 - m.x0) * (m.t1 - m.t0);
      let best = m.data[0];
      for (const z of m.data) {
        if (Math.abs(z.t-t) < Math.abs(best.t-t)) best = z;
      }

      const fog = fogAt(best.t);
      const mifg = mifgAt(best.t);
      if (fog && fog.score >= FOG_TOOLTIP_THRESHOLD) {
        appendHoverRow(tooltip,'Ryzyko mgły · FOG',fog.score,'data-epir-fog-hover');
      }
      if (mifg && mifg.score >= FOG_TOOLTIP_THRESHOLD) {
        appendHoverRow(tooltip,'Niska mgła <2 m · MIFG',mifg.score,'data-epir-mifg-hover');
      }
    }

    canvas.addEventListener('pointermove',e => {
      if (e.pointerType !== 'mouse') return;
      const x = e.clientX;
      const y = e.clientY;
      queueMicrotask(() => updateTooltip(x,y));
    });
  }

  function lowestCloudInBand(profile,min,max) {
    if (!Array.isArray(profile) || !profile.length || typeof interpCC !== 'function' || typeof toOkta !== 'function') return null;
    for (let h=min;h<max;h+=50) {
      const cc = interpCC(profile,h);
      if (!finite(cc)) continue;
      const okta = toOkta(cc);
      if (finite(okta) && okta > 0) return {h,okta};
    }
    return null;
  }

  function cloudAmountText(okta,h) {
    const amount = (okta??'—')+'/8 '+oktaName(okta);
    return amount+(finite(h)?' · ~'+Math.round(h)+' m AGL':' · wys. —');
  }

  function detailedCloudLayerText(okta,mainH,profile,min,max) {
    const main = cloudAmountText(okta,mainH);
    const lowest = lowestCloudInBand(profile,min,max);
    if (!lowest) return main;
    if (finite(mainH) && Math.abs(lowest.h-mainH) < 25 && lowest.okta === okta) return main;
    return main+' (najniższe: '+cloudAmountText(lowest.okta,lowest.h)+')';
  }

  const previousShowSectionInfo = showSectionInfo;
  showSectionInfo = function(z,panelId) {
    if (panelId === 'visfog') {
      previousShowSectionInfo(z,panelId);
      const box = $('sectionInfo');
      const values = box?.querySelector('.section-values');
      if (!values) return;

      values.querySelectorAll('[data-fog-risk],[data-mifg-risk]').forEach(el => el.remove());
      const fog = fogAt(z?.t);
      const mifg = mifgAt(z?.t);
      if (fog && fog.score >= FOG_TOOLTIP_THRESHOLD) {
        appendRiskCell(values,'Ryzyko mgły · FOG ENGINE',fog.score,'fogRisk');
      }
      if (mifg && mifg.score >= FOG_TOOLTIP_THRESHOLD) {
        appendRiskCell(values,'Niska mgła <2 m · MIFG',mifg.score,'mifgRisk');
      }
      return;
    }

    if (panelId !== 'cloud') return previousShowSectionInfo(z,panelId);

    const box = $('sectionInfo');
    box.classList.remove('empty');
    const time = fmt(z.t,{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    const vals = [
      infoValue('Podstawa ≥5/8',finite(z.ceiling)?Math.round(z.ceiling)+' m AGL':'brak ≥5/8'),
      infoValue('Podstawa',finite(z.ceiling)?Math.round(z.ceiling*3.28084)+' ft AGL':'—'),
      infoValue('Niskie',detailedCloudLayerText(z.oktaL,z.lowH,z.profile,0,2000)),
      infoValue('Średnie',detailedCloudLayerText(z.oktaM,z.midH,z.profile,2000,5000)),
      infoValue('Wysokie',detailedCloudLayerText(z.oktaH,z.highH,z.profile,5000,13001))
    ];
    box.innerHTML = '<div class="section-head"><b>Profil chmur</b><span>'+time+'</span></div>'+
      '<div class="section-values">'+vals.join('')+'</div>'+
      '<div class="section-help">Wartość główna pokazuje maksymalne zachmurzenie w danym przedziale i najniższą wysokość, na której jest ono osiągane. W nawiasie podana jest najniższa wykryta chmura w tym samym przedziale wraz z jej zachmurzeniem.</div>';
  };

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
    legendTitle(sx,y,'Widzialność / mgła');y+=14;
    legendSample(sx,y,'#d66c12','Widzialność');y+=13;
    legendSample(sx,y,'#d49a28','FOG ENGINE ≥40/100');y+=18;
    legendTitle(sx,y,'Chmury');y+=14;
    legendSample(sx,y,'#8d4a1a','Podstawa ≥5/8');y+=13;
    legendDot(sx,y,activeTheme()==='dark'?'#fff':'#555','Profil zachmurzenia');y+=18;
    legendTitle(sx,y,'Warstwy chmur');y+=14;
    legendSample(sx,y,'#f59e0b','Niskie 0–2 km');y+=13;
    legendSample(sx,y,'#22c55e','Średnie 2–5 km');y+=13;
    legendSample(sx,y,'#3b82f6','Wysokie 5–13 km');y+=18;
    ctx.fillStyle=cp.muted;ctx.font='8px Arial';ctx.textAlign='left';
    ctx.fillText('Dotknij panelu, aby',sx,y);
    ctx.fillText('zobaczyć parametry godziny.',sx,y+11);
  };

  if (typeof draw === 'function' && !window.__epirMergedWindPanelWrapped) {
    const baseDraw = draw;
    draw = function() {
      mergeWindPanels();

      // Zablokuj wszystkie stare strzałki kierunku podczas bazowego rysowania.
      const nativeFillText = ctx.fillText;
      const nativeStrokeText = ctx.strokeText;
      ctx.fillText = function(text,...args) {
        if (text === 'Kierunek wiatru' || text === '↑') return;
        return nativeFillText.call(this,text,...args);
      };
      ctx.strokeText = function(text,...args) {
        if (text === '↑') return;
        return nativeStrokeText.call(this,text,...args);
      };

      let out;
      try {
        out = baseDraw.apply(this,arguments);
      } finally {
        ctx.fillText = nativeFillText;
        ctx.strokeText = nativeStrokeText;
      }

      redrawWindPanelForeground();
      return out;
    };
    window.__epirMergedWindPanelWrapped = true;
  }

  installFogHoverTooltip();

  requestAnimationFrame(()=>{
    mergeWindPanels();
    if (typeof consensus !== 'undefined' && consensus.length) draw();
  });
})();