'use strict';
(() => {
  if (typeof showSectionInfo !== 'function' || typeof drawLegend !== 'function') return;

  const LEGEND_RIGHT_GAP = 30;
  const WIND_ARROW = '#ef4444';

  function mergeWindPanels() {
    if (typeof PANELS === 'undefined' || !Array.isArray(PANELS)) return;
    const wind = PANELS.find(p => p && p.id === 'wind');
    const dir = PANELS.find(p => p && p.id === 'dir');
    if (!wind || !dir) return;

    const dirH = Number(dir.h) || 0;
    if (dirH > 0) {
      wind.h = (Number(wind.h) || 84) + dirH;
      dir.h = 0;
    }
  }

  // Kierunek wiatru ma należeć do tej samej sekcji co prędkość/porywy.
  // Zachowujemy łączną wysokość dawnych dwóch paneli, dzięki czemu skala
  // i poziome linie pomocnicze znów obejmują całą sekcję Wiatr.
  mergeWindPanels();

  function drawWindDirectionForeground() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m = cv._meta;
    if (!m || !Array.isArray(m.panelYs) || !Array.isArray(m.data)) return;
    const p = m.panelYs.find(row => row && row.id === 'wind');
    if (!p || !finite(p.y) || !finite(p.h) || p.h <= 0) return;

    const x0 = m.x0, x1 = m.x1;
    const plotW = x1 - x0;
    const x = t => clamp(x0 + (t - m.t0) / (m.t1 - m.t0) * plotW, x0, x1);
    const cy = p.y + p.h / 2;
    const dark = typeof activeTheme === 'function' && activeTheme() === 'dark';

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0,p.y,plotW,p.h);
    ctx.clip();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px Arial';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let i=0;i<m.data.length;i+=3) {
      const z = m.data[i];
      if (!z || !finite(z.WD) || !finite(z.t)) continue;
      ctx.save();
      ctx.translate(x(z.t),cy);
      ctx.rotate((z.WD+180)*Math.PI/180);

      // Kontrastowy obrys utrzymuje strzałki na pierwszym planie także wtedy,
      // gdy w środku sekcji przebiega linia prędkości, porywu lub siatki.
      ctx.strokeStyle = dark ? 'rgba(10,15,20,.94)' : 'rgba(255,255,255,.96)';
      ctx.lineWidth = 3.4;
      ctx.strokeText('↑',0,0);
      ctx.fillStyle = WIND_ARROW;
      ctx.fillText('↑',0,0);
      ctx.restore();
    }
    ctx.restore();
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

      // Stary panel kierunku ma wysokość 0, więc nie rysujemy jego dawnej
      // pionowej etykiety na granicy między Wiatrem i Widzialnością.
      const nativeFillText = ctx.fillText;
      ctx.fillText = function(text,...args) {
        if (text === 'Kierunek wiatru') return;
        return nativeFillText.call(this,text,...args);
      };

      try {
        const out = baseDraw.apply(this,arguments);
        drawWindDirectionForeground();
        return out;
      } finally {
        ctx.fillText = nativeFillText;
      }
    };
    window.__epirMergedWindPanelWrapped = true;
  }

  requestAnimationFrame(()=>{
    mergeWindPanels();
    if (typeof consensus !== 'undefined' && consensus.length) draw();
  });
})();