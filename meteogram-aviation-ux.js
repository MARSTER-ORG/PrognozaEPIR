'use strict';
/* Aviation-focused presentation only. Do not alter forecast, Fog Engine or TAF values. */
(() => {
  if (window.__EPIR_AVIATION_METEOGRAM_UX__) return;
  if (typeof PANELS === 'undefined' || !Array.isArray(PANELS) ||
      typeof draw !== 'function' || typeof ctx === 'undefined' || typeof cv === 'undefined') return;
  window.__EPIR_AVIATION_METEOGRAM_UX__ = true;

  const HOUR = 3600e3;
  const VIS_MAX_KM = 15;
  const CEIL_MAX_M = 3000;
  const colors = {
    vis:'#edb62d', bkn:'#ef665a', few:'#f5bc4d',
    vfr:'#228a62', mvfr:'#397bc7', ifr:'#c64c58', lifr:'#9865c1'
  };
  const ok = value => Number.isFinite(value);
  const byId = id => PANELS.find(p => p && p.id === id);
  const old = new Map(PANELS.map(p => [p.id,p]));
  const sizeFor = (id,h,label,unit) => ({...(old.get(id)||{}),id,h,label,unit});

  // The direction arrows are deliberately part of the wind section.
  // Keep the legacy zero-height 'dir' record for renderers that reference it.
  PANELS.splice(0,PANELS.length,
    sizeFor('temp',96,'temperatura','(°C)'),
    sizeFor('prec',90,'opad / wilgotność','(mm/h / %)'),
    sizeFor('probstorm',84,'szansa opadu / burzy','(%)'),
    sizeFor('wind',84,'wiatr','(m/s)'),
    sizeFor('dir',0,'',''),
    sizeFor('visfog',112,'widzialność / mgła','(km)'),
    sizeFor('ceil',98,'podstawy niskich chmur','(m AGL)'),
    sizeFor('cloud',138,'profil chmur','(km)'),
    sizeFor('okta',90,'warstwy chmur','(oktanty)'),
    sizeFor('press',70,'ciśnienie','(hPa)'),
    sizeFor('flight',26,'warunki orientacyjne','')
  );

  function panel(meta,id) {
    return meta && Array.isArray(meta.panelYs) ? meta.panelYs.find(p=>p.id===id&&p.h>0) : null;
  }
  function xOf(meta,t) {
    return meta.x0+(t-meta.t0)/(meta.t1-meta.t0)*(meta.x1-meta.x0);
  }
  function paddedY(panel,value,max) {
    const pad=Math.min(9,Math.max(7,panel.h*.09));
    return panel.y+panel.h-pad-Math.max(0,Math.min(max,value))/max*(panel.h-2*pad);
  }
  function lineSeries(meta,p,select,yFor,color,width=2.2,dash=[]) {
    ctx.save();
    ctx.beginPath();ctx.rect(meta.x0,p.y,meta.x1-meta.x0,p.h);ctx.clip();
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=width;
    ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash(dash);
    let begun=false;
    for(const z of meta.data) {
      const value=select(z);
      if(!ok(z.t)||!ok(value)) {begun=false;continue;}
      const px=xOf(meta,z.t),py=yFor(value);
      if(!ok(px)||!ok(py)) {begun=false;continue;}
      if(!begun){ctx.moveTo(px,py);begun=true;}else ctx.lineTo(px,py);
    }
    ctx.stroke();ctx.restore();
  }
  function highlightSaturation(meta) {
    const p=panel(meta,'temp');
    if(!p)return;
    const span=Math.max(2,(meta.x1-meta.x0)/Math.max(1,meta.data.length-1));
    ctx.save();ctx.beginPath();ctx.rect(meta.x0,p.y,meta.x1-meta.x0,p.h);ctx.clip();
    ctx.fillStyle='rgba(224,94,122,.10)';
    for(const z of meta.data) {
      if(ok(z.T)&&ok(z.Td)&&z.T-z.Td<=2) {
        ctx.fillRect(xOf(meta,z.t)-span/2,p.y,span+.5,p.h);
      }
    }
    ctx.restore();
  }
  function drawVisibility(meta) {
    const p=panel(meta,'visfog');
    if(!p)return;
    const yForKm=v=>paddedY(p,v,VIS_MAX_KM);
    ctx.save();ctx.beginPath();ctx.rect(meta.x0,p.y,meta.x1-meta.x0,p.h);ctx.clip();
    const dark=typeof activeTheme==='function'&&activeTheme()==='dark';
    // The 0.6 / 1 / 1.5 / 3 / 5 km guides remain subordinate to the forecast curve.
    for(const [km,label] of [[.6,'600 m'],[1,'1 km'],[1.5,'1,5 km'],[3,'3 km'],[5,'5 km']]) {
      const yy=yForKm(km);
      ctx.strokeStyle=km<=1?'rgba(235,86,89,.58)':km<=1.5?'rgba(238,146,78,.5)':'rgba(206,201,174,.34)';
      ctx.lineWidth=.75;ctx.setLineDash([4,5]);
      ctx.beginPath();ctx.moveTo(meta.x0,yy);ctx.lineTo(meta.x1,yy);ctx.stroke();
      ctx.setLineDash([]);
      // Right-aligned small labels stay away from the left vertical axis.
      ctx.font='8px Arial';ctx.fillStyle=dark?'#cbd2da':'#434b57';
      ctx.textAlign='right';ctx.fillText(label,meta.x1-5,yy-3);
    }
    ctx.restore();
    // Repaint VIS last: it must not be hidden by Fog Engine's risk bars.
    // Missing values are breaks in the curve, never 0 m.
    lineSeries(meta,p,z=>ok(z.VIS)?z.VIS/1000:null,yForKm,colors.vis,2.6);
  }
  function drawCeil(meta) {
    const p=panel(meta,'ceil');
    if(!p)return;
    const cp=canvasPalette();
    const yFor=v=>paddedY(p,v,CEIL_MAX_M);
    const dark=typeof activeTheme==='function'&&activeTheme()==='dark';
    ctx.save();
    ctx.beginPath();ctx.rect(meta.x0,p.y,meta.x1-meta.x0,p.h);ctx.clip();
    for(const height of [0,300,600,1000,1500,3000]) {
      const yy=yFor(height);
      ctx.strokeStyle=(height===300||height===600)?'rgba(238,154,99,.44)':cp.grid2;
      ctx.globalAlpha=height===0||height===3000?.65:.40;
      ctx.lineWidth=.8;ctx.setLineDash(height===300||height===600?[4,4]:[]);
      ctx.beginPath();ctx.moveTo(meta.x0,yy);ctx.lineTo(meta.x1,yy);ctx.stroke();
    }
    ctx.restore();
    ctx.save();ctx.fillStyle=cp.muted;ctx.font='8.5px Arial';
    ctx.textAlign='right';ctx.textBaseline='middle';
    for(const height of [0,300,600,1000,1500,3000]) {
      ctx.fillText(height===3000?'3000+':String(height),meta.x0-8,yFor(height));
    }
    ctx.fillStyle=dark?'#c5d1df':'#3d4857';ctx.textAlign='right';
    ctx.fillText('m AGL',meta.x1-8,p.y+12);
    ctx.restore();
    // Lower scattered clouds, when available, are secondary to BKN/OVC ceiling.
    lineSeries(meta,p,z=>(ok(z.lowH)&&ok(z.oktaL)&&z.oktaL>0&&z.oktaL<5)?z.lowH:null,yFor,colors.few,1.8,[5,4]);
    lineSeries(meta,p,z=>ok(z.ceiling)?z.ceiling:null,yFor,colors.bkn,2.7);
    ctx.save();
    ctx.fillStyle=cp.bg;ctx.fillRect(meta.x0-111,p.y,66,p.h);
    ctx.translate(meta.x0-72,p.y+p.h/2);ctx.rotate(-Math.PI/2);
    ctx.fillStyle=cp.muted;ctx.font='8px Arial';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText('Podstawy chmur',0,0);
    ctx.restore();
  }
  // Indicative US flight categories; NOT aerodrome minima or an operational assessment.
  function flightCategory(z) {
    const vis=ok(z.VIS)?z.VIS:null,ceil=ok(z.ceiling)?z.ceiling:null;
    if(vis===null&&ceil===null)return null;
    if((vis!==null&&vis<1609.344)||(ceil!==null&&ceil<152.4))return 'LIFR';
    if((vis!==null&&vis<4828.032)||(ceil!==null&&ceil<304.8))return 'IFR';
    if((vis!==null&&vis<8046.72)||(ceil!==null&&ceil<=914.4))return 'MVFR';
    return 'VFR';
  }
  function drawFlight(meta) {
    const p=panel(meta,'flight');
    if(!p)return;
    const cp=canvasPalette(),dw=(meta.x1-meta.x0)/Math.max(1,meta.data.length-1);
    ctx.save();ctx.beginPath();ctx.rect(meta.x0,p.y,meta.x1-meta.x0,p.h);ctx.clip();
    const y=p.y+3,h=Math.max(8,p.h-6);
    ctx.fillStyle=cp.panel;ctx.fillRect(meta.x0,y,meta.x1-meta.x0,h);
    let previous=null,groupStart=0;
    const groups=[];
    for(let i=0;i<meta.data.length;i++){
      const z=meta.data[i],category=flightCategory(z),left=Math.max(meta.x0,xOf(meta,z.t)-dw/2);
      const right=Math.min(meta.x1,xOf(meta,z.t)+dw/2);
      ctx.fillStyle=category?colors[category.toLowerCase()]:'rgba(120,128,140,.45)';
      ctx.fillRect(left,y,Math.max(1,right-left+.5),h);
      if(category!==previous) {
        if(i>0)groups.push({kind:previous,start:groupStart,end:i});
        groupStart=i;previous=category;
      }
    }
    groups.push({kind:previous,start:groupStart,end:meta.data.length});
    ctx.font='bold 9px Arial';ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';
    for(const g of groups) {
      if(!g.kind)continue;
      const a=Math.max(meta.x0,xOf(meta,meta.data[g.start].t)-dw/2);
      const b=Math.min(meta.x1,xOf(meta,meta.data[g.end-1].t)+dw/2);
      if(b-a>=39)ctx.fillText(g.kind,(a+b)/2,y+h/2);
    }
    ctx.restore();
    ctx.save();ctx.fillStyle=cp.bg;ctx.fillRect(meta.x0-111,p.y,110,p.h);
    ctx.fillStyle=cp.muted;ctx.font='bold 9px Arial';ctx.textAlign='right';ctx.textBaseline='middle';
    ctx.fillText('LOTNICZO*',meta.x0-8,p.y+p.h/2);
    ctx.restore();
  }
  function flightDescription(category) {
    return category ? category+' (kategoria poglądowa wg progów USA)' : 'Brak wystarczających danych';
  }
  const oldInfo=showSectionInfo;
  showSectionInfo=function(z,id) {
    if(id!=='ceil'&&id!=='flight')return oldInfo.apply(this,arguments);
    const box=document.getElementById('sectionInfo');
    if(!box)return;
    const when=typeof fmt==='function'?fmt(z.t,{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):new Date(z.t).toISOString();
    if(id==='ceil') {
      const c=ok(z.ceiling)?Math.round(z.ceiling)+' m AGL':'Brak BKN/OVC',
            feet=ok(z.ceiling)?Math.round(z.ceiling*3.28084)+' ft AGL':'—';
      box.innerHTML='<div class="section-head"><b>Podstawy chmur</b><span>'+when+'</span></div>'+
        '<div class="section-values">'+
          infoValue('Podstawa BKN/OVC',c)+infoValue('W stopach',feet)+
          infoValue('Niskie',cloudLayerText(z.oktaL,z.lowH))+
        '</div><div class="section-help">Czerwona linia: najniższa podstawa ≥5/8. Linia przerywana: niższa warstwa FEW/SCT, jeśli występuje. Wysokości AGL.</div>';
    } else {
      const cat=flightCategory(z);
      box.innerHTML='<div class="section-head"><b>Orientacyjna kategoria warunków</b><span>'+when+'</span></div>'+
        '<div class="section-values">'+infoValue('Kategoria',flightDescription(cat))+
        infoValue('Widzialność',ok(z.VIS)?Math.round(z.VIS)+' m':'Brak danych')+
        infoValue('Ceiling',ok(z.ceiling)?Math.round(z.ceiling)+' m AGL':'Brak warstwy ≥5/8')+
        '</div><div class="section-help">Progi VFR/MVFR/IFR/LIFR (USA) służą wyłącznie do orientacji. Nie są minimami operacyjnymi EPIR, nie zastępują METAR/TAF ani procedur lotniczych.</div>';
    }
    box.classList.remove('empty');
  };
  const baseDraw=draw;
  draw=function() {
    const result=baseDraw.apply(this,arguments);
    const meta=cv._meta;
    if(!meta||!Array.isArray(meta.data)||meta.data.length<2)return result;
    highlightSaturation(meta);
    drawVisibility(meta);
    drawCeil(meta);
    drawFlight(meta);
    return result;
  };
  const help=document.querySelector('.legend');
  if(help&&!document.getElementById('aviationMeteogramNote')){
    const note=document.createElement('span');
    note.id='aviationMeteogramNote';
    note.textContent='* VFR/MVFR/IFR/LIFR: klasyfikacja poglądowa (progi USA), nie minima EPIR. Paski T−Td ≤2°C wskazują bliskość nasycenia, nie pewną mgłę.';
    help.appendChild(note);
  }
  requestAnimationFrame(()=>{
    if(typeof consensus!=='undefined'&&Array.isArray(consensus)&&consensus.length)draw();
  });
})();