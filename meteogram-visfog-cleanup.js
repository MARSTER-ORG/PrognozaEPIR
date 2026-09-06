'use strict';
(() => {
  if (typeof showSectionInfo !== 'function' || typeof drawLegend !== 'function') return;

  const LEGEND_RIGHT_GAP = 30;

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

  requestAnimationFrame(()=>{
    if (typeof consensus !== 'undefined' && consensus.length) draw();
  });
})();