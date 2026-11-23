'use strict';
(() => {
  if (typeof showSectionInfo !== 'function' || typeof drawLegend !== 'function') return;

  const LEGEND_RIGHT_GAP = 30;
  const WIND_ARROW = '#ef4444';
  const FOG_TOOLTIP_THRESHOLD = 60;
  const MAX_RISK_MATCH_MS = 70 * 60e3;
  const HOUR = 3600e3;

  function mergeWindPanels() {
    if (typeof PANELS === 'undefined' || !Array.isArray(PANELS)) return;
    const wind = PANELS.find(p => p && p.id === 'wind');
    const dir = PANELS.find(p => p && p.id === 'dir');
    if (wind) wind.h = 112;
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

  // Check against the same VIS that the user sees on the meteogram.
  function brAt(t,visibleVis) {
    if (!finite(visibleVis) || visibleVis < 1000 || visibleVis > 5000) return null;
    try {
      const row = nearestRiskRow(Array.isArray(window.PrognozaEPIRBRSeries) ? window.PrognozaEPIRBRSeries : [],t);
      if (row && finite(row.visibility) && (row.visibility < 1000 || row.visibility > 5000)) return null;
      return row;
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
    const windVisual = window.PrognozaEPIRWindVisual;
    // Axis covers the largest forecast sustained speed or gust, rounded up
    // to a 5 m/s increment. Its minimum is 0–5 m/s, not a fixed 0–15 range.
    const validSpeeds = m.data.flatMap(z=>[z?.WS,z?.G]).filter(v=>finite(v)&&v>=0);
    const windMax = windVisual?.axisMax?.(m.data) || Math.ceil(Math.max(5,...validSpeeds)/5)*5;
    const windTicks = windVisual?.axisTicks?.(windMax) || [0,5,10,15,25,windMax].filter((v,i,all)=>v<=windMax&&all.indexOf(v)===i);
    const y = value => p.y + p.h - clamp(Number(value)||0,0,windMax) / windMax * p.h;
    const darkMode = () => typeof activeTheme==='function' && activeTheme()==='dark';

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0,p.y,plotW,p.h);
    ctx.clip();

    // Cały panel jest budowany od nowa. Dzięki temu żadne stare strzałki
    // ani pomocniczy techniczny panel kierunku nie mogą pozostać na wykresie.
    ctx.fillStyle = cp.panel;
    ctx.fillRect(x0,p.y,plotW,p.h);
    window.PrognozaEPIRShadePanel?.({t0:m.t0,t1:m.t1,x0,x1,y:p.y,h:p.h});

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

    // Threshold markers are drawn ABOVE the coloured fill below.
    // Unlike the generic four-step grid, these are exact wind-speed limits.

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

    // Reference styling: wind-speed area filled with discrete blue/green/
    // yellow/orange/red bands. Do not repaint over it with an old blue line.
    if (windVisual?.segments) {
      const baseline = y(0);
      for (let i=1;i<m.data.length;i++) {
        const a=m.data[i-1],b=m.data[i];
        if (!finite(a?.t) || !finite(b?.t) ||
            !finite(a?.WS) || !finite(b?.WS) || a.WS<0 || b.WS<0) continue;
        const left=x(a.t),right=x(b.t);
        if (!(right>left)) continue;
        for(const part of windVisual.segments(a.WS,b.WS)) {
          const xA=left+(right-left)*part.start,xB=left+(right-left)*part.end;
          const yA=y(part.from),yB=y(part.to);
          ctx.save();
          ctx.fillStyle=part.band.color;
          ctx.globalAlpha=darkMode()?0.56:0.38;
          ctx.beginPath();
          ctx.moveTo(xA,baseline);ctx.lineTo(xA,yA);
          ctx.lineTo(xB,yB);ctx.lineTo(xB,baseline);
          ctx.closePath();ctx.fill();
          ctx.restore();
          ctx.strokeStyle=part.band.color;
          ctx.lineWidth=2.8;
          ctx.setLineDash([]);
          ctx.beginPath();ctx.moveTo(xA,yA);ctx.lineTo(xB,yB);ctx.stroke();
        }
      }
    } else {
      drawSeries('WS','#2689d6',2.5);
    }

    // Exact thresholds remain readable regardless of the wind curve colour.
    for(const value of windTicks) {
      const yy=y(value),isThreshold=[5,10,15,25].includes(value);
      ctx.save();
      ctx.setLineDash(isThreshold?[5,4]:[]);
      ctx.strokeStyle=isThreshold
        ? (darkMode()?'rgba(226,234,240,.64)':'rgba(48,60,72,.58)')
        : cp.grid2;
      ctx.lineWidth=isThreshold?1.1:0.75;
      ctx.beginPath();ctx.moveTo(x0,yy);ctx.lineTo(x1,yy);ctx.stroke();
      ctx.restore();
    }
    // Gusts never determine the fill colour and stay a red dashed trace.
    drawSeries('G',darkMode()?'#ff7670':'#c33b2b',2.0,[6,4]);

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

    // Repaint the wind axis in m/s only. The right gutter is explicitly
    // cleared so no legacy km/h values survive from an earlier renderer.
    ctx.save();
    ctx.fillStyle=cp.bg;
    ctx.fillRect(x0-48,p.y-2,47,p.h+4);
    ctx.fillRect(x1+1,p.y-2,RIGHT_W-2,p.h+4);
    ctx.font='bold 9px Arial';
    ctx.textBaseline='middle';
    for(const value of windTicks) {
      const yy=y(value),label=String(value);
      // Keep the endpoint labels inside the panel without altering the exact
      // threshold grid positions (0 bottom, scale maximum at the top).
      const textY=Math.max(p.y+7,Math.min(p.y+p.h-7,yy));
      ctx.textAlign='right';
      ctx.fillStyle=[5,10,15,25].includes(value)?cp.text:cp.muted;
      ctx.fillText(label,x0-8,textY);

    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle=cp.border;
    ctx.globalAlpha=.98;
    ctx.lineWidth=1;
    ctx.strokeRect(x0,p.y,plotW,p.h);
    ctx.restore();
  }

  window.PrognozaEPIRRedrawWindForeground = redrawWindPanelForeground;

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

      tooltip.querySelectorAll('[data-epir-fog-hover],[data-epir-mifg-hover],[data-epir-br-hover]').forEach(el => el.remove());

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
      const br = brAt(best.t,best.VIS);
      if (fog && fog.score >= FOG_TOOLTIP_THRESHOLD) {
        appendHoverRow(tooltip,'Ryzyko mgły · FOG',fog.score,'data-epir-fog-hover');
      }
      if (br && br.score >= FOG_TOOLTIP_THRESHOLD) {
        appendHoverRow(tooltip,'Zamglenie · BR',br.score,'data-epir-br-hover');
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

      values.querySelectorAll('[data-fog-risk],[data-mifg-risk],[data-br-risk]').forEach(el => el.remove());
      const fog = fogAt(z?.t);
      const mifg = mifgAt(z?.t);
      const br = brAt(z?.t,z?.VIS);
      if (fog && fog.score >= FOG_TOOLTIP_THRESHOLD) {
        appendRiskCell(values,'Ryzyko mgły · FOG ENGINE',fog.score,'fogRisk');
      }
      if (br && br.score >= FOG_TOOLTIP_THRESHOLD) {
        appendRiskCell(values,'Zamglenie · BR',br.score,'brRisk');
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
    const cloud=window.PrognozaEPIRCloudBands?.fromProfile(z.profile);
    const cover=cloud?.coverage||{};
    const asOkta=v=>finite(v)?v+'/8 '+oktaName(v):'brak danych';
    const lowLevel=cloud&&finite(cloud.lowestLevelM)?Math.round(cloud.lowestLevelM)+' m AGL':'brak danych';
    const vals = [
      infoValue('Podstawa BKN/OVC (≥5/8)',finite(z.ceiling)?Math.round(z.ceiling)+' m AGL':'brak'),
      infoValue('Podstawa (ft)',finite(z.ceiling)?Math.round(window.PrognozaEPIRUnits.mToFt(z.ceiling))+' ft AGL':'—'),
      infoValue('Bardzo niskie 0–450 m',asOkta(cover.veryLow)),
      infoValue('Niskie 450–2000 m',asOkta(cover.low)),
      infoValue('Średnie 2–6 km',asOkta(cover.mid)),
      infoValue('Wysokie 6–13 km',asOkta(cover.high)),
      infoValue('Najniższy poziom profilu',lowLevel)
    ];
    box.innerHTML = '<div class="section-head"><b>Profil chmur</b><span>'+time+'</span></div>'+
      '<div class="section-values">'+vals.join('')+'</div>'+
      '<div class="section-help">Wszystkie warstwy korzystają z tej samej diagnozy modelowego pokrycia chmur co panel oktantów. Brak danych pionowych nie oznacza 0/8. Podstawa ≥5/8 jest szacunkiem interpolowanym; nie jest pomiarem.</div>';
  };

  drawLegend = function(top,totalH) {
    const x=8;
    const w=Math.max(136,LEGEND_W-LEGEND_RIGHT_GAP-6);
    const cp=canvasPalette();
    ctx.fillStyle=cp.legend;ctx.fillRect(x,top,w,totalH);
    ctx.strokeStyle=cp.border;ctx.lineWidth=.9;ctx.strokeRect(x,top,w,totalH);
    let y=top+14,sx=x+9;
    function title(name){ legendTitle(sx,y,name);y+=14; }
    function sample(name,color,dash=[]){ legendSample(sx,y,color,name,dash);y+=13; }
    function dot(name,color){ legendDot(sx,y,color,name);y+=13; }
    function symbol(name,color,kind) {
      ctx.save();
      ctx.fillStyle=color;
      ctx.strokeStyle=color;
      if(kind==='bar'){ ctx.fillRect(sx+4,y-6,9,10); }
      else if(kind==='diamond'){
        ctx.translate(sx+9,y-1);ctx.rotate(Math.PI/4);
        ctx.fillRect(-4,-4,8,8);
      } else if(kind==='arrow'){
        ctx.font='bold 14px Arial';ctx.textAlign='center';ctx.fillText('↑',sx+9,y+4);
      }
      ctx.restore();
      ctx.fillStyle=cp.text;ctx.textAlign='left';ctx.font='9px Arial';
      ctx.fillText(name,sx+24,y+3);
      y+=13;
    }
    title('Temperatura');
    sample('Temp. powietrza','#d43d31');
    sample('Punkt rosy',activeTheme()==='dark'?'#627dff':'#25278f',[2,2]);
    sample('Granica 0°C','#94a3b8');
    y+=6;
    title('Opad / wilgotność');
    sample('Opad: kolor = rodzaj','#039c29');
    sample('RA / DZ — ciekły','#16a34a');
    sample('SN — śnieg','#3b82f6');
    sample('RASN — mieszany','#a78bfa');
    sample('SH — przelotny','#f59e0b');
    sample('TS / GR — konwekcja','#ef4444');
    sample('FZ — marznący','#9333ea');
    sample('Nieznany / rozbieżny','#64748b');
    sample('RA* / SN* — filtr 3 h','#64748b');
    sample('DZ* — sugestia St/Sc','#52b69a');
    dot('Radar + konwekcja','#0891b2');
    dot('Konwekcja modelowa','#ea580c');
    dot('TCu / Cb NWP ≥30%','#d97706');
    dot('SH z Cu? / rozbieżność','#64748b');
    sample('Wilgotność RH (%)','#bd4723');
    y+=6;
    title('Udział modeli (%)');
    sample('Modele z opadem','#0b9f2b');
    sample('Modele z burzą','#8b3db8',[6,4]);
    y+=6;
    title('Ciśnienie');
    sample('MSLP / QNH (hPa)',activeTheme()==='dark'?'#e7e9ed':'#222');
    y+=6;
    title('Wiatr 10 m (m/s)');
    sample('0–5','#2689d6');
    sample('>5–10','#29a65a');
    sample('>10–15','#dfbc24');
    sample('>15–25','#ec8526');
    sample('>25','#d93a3a');
    sample('Porywy (przerywane)','#c33b2b',[5,4]);
    symbol('Kierunek wiatru','#ef4444','arrow');
    y+=6;
    title('Widzialność / mgła');
    sample('VIS FOG ENGINE (km)','#d66c12');
    sample('NWP VIS (km)','#2d91d0',[5,4]);
    symbol('FOG (słupki ≥60)','#d86c2f','bar');
    symbol('BR (romby ≥60)','#c084fc','diamond');
    dot('MIFG (pkt ≥60)','#d63434');
    y+=6;
    title('Profil chmur');
    sample('Podstawa ≥5/8','#8d4a1a');
    dot('Zachmurzenie',activeTheme()==='dark'?'#fff':'#555');
    y+=6;
    title('Podstawy chmur AGL');
    dot('BKN/OVC (≥5/8)','#ef4444');
    dot('SCT (3–4/8)','#facc15');
    dot('FEW (1–2/8)','#22c55e');
    y+=6;
    title('Warstwy chmur');
    sample('B. niskie 0–450 m','#b678f0');
    sample('Niskie 450–2000 m','#f59e0b');
    sample('Średnie 2–6 km','#22c55e');
    sample('Wysokie 6–13 km','#3b82f6');
    y+=8;
    ctx.fillStyle=cp.muted;ctx.font='8px Arial';ctx.textAlign='left';
    ctx.fillText('Czas: UTC · chmury AGL',sx,y);
    ctx.fillText('FOG/BR/MIFG: skala 0–100',sx,y+11);
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