'use strict';
(() => {
  if (typeof PANELS === 'undefined' || typeof draw !== 'function' || typeof ctx === 'undefined' || typeof cv === 'undefined') return;

  const VERSION = 'v0.10.10 HTML';
  const HOUR = 3600e3;
  const THREE_HOURS = 3 * HOUR;
  const UTC_MONTHS_ML = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const CLOUD_LOW = '#f59e0b';
  const CLOUD_MID = '#22c55e';
  const CLOUD_HIGH = '#3b82f6';
  const WIND_ARROW = '#ef4444';
  const PROB_RAIN = '#0b9f2b';
  const PROB_STORM = '#8b3db8';
  const INNER_PAD = 9;

  const mergedPanels = [
    {id:'temp',h:96,label:'temperatura',unit:'(°C)'},
    {id:'prec',h:90,label:'opad / wilgotność',unit:'(mm/h / %)'},
    {id:'probstorm',h:84,label:'szansa opadu / burzy',unit:'(%)'},
    {id:'press',h:78,label:'ciśnienie',unit:'(hPa)'},
    {id:'wind',h:84,label:'wiatr',unit:'(m/s)'},
    {id:'dir',h:54,label:'kier. wiatru',unit:''},
    {id:'cloud',h:142,label:'profil chmur / widzialność',unit:'(km)'},
    {id:'okta',h:94,label:'warstwy chmur',unit:'(oktanty)'}
  ];
  PANELS.splice(0, PANELS.length, ...mergedPanels);

  const sectionNames = {
    temp:'Temperatura',
    prec:'Opad / RH',
    probstorm:'Szansa opadu / burzy',
    press:'Ciśnienie',
    wind:'Wiatr',
    dir:'Kierunek wiatru',
    cloud:'Chmury / widzialność',
    okta:'Warstwy chmur'
  };

  const oldShowSectionInfo = showSectionInfo;
  showSectionInfo = function(z,panelId) {
    if (panelId !== 'probstorm') return oldShowSectionInfo(z,panelId);
    const box = $('sectionInfo');
    box.classList.remove('empty');
    const time = fmt(z.t,{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    const stormModels = finite(z.storm) ? Math.round((z.storm/100)*(z.stormCount||0))+' / '+(z.stormCount||0) : '—';
    const vals = [
      infoValue('Szansa opadu',f(z.wet,0)+'%'),
      infoValue('Szansa burzy',f(z.storm,0)+'%'),
      infoValue('Opad konsensusu',f(z.RR,2)+' mm/h'),
      infoValue('Modele z kodem burzy',stormModels)
    ];
    box.innerHTML = '<div class="section-head"><b>Prawdopodobieństwo opadu / burzy</b><span>'+time+'</span></div>'+
      '<div class="section-values">'+vals.join('')+'</div>'+
      '<div class="section-help">Opad: udział modeli wskazujących ≥0.1 mm/h. Burza: udział ważony modeli z kodem WMO 95, 96 lub 99; nie jest to oficjalna prognoza probabilistyczna IMGW.</div>';
  };

  drawLegend = function(top,totalH) {
    const x=8,w=LEGEND_W-18,cp=canvasPalette();
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
    legendSample(sx,y,PROB_RAIN,'Szansa opadu');y+=13;
    legendSample(sx,y,PROB_STORM,'Szansa burzy');y+=18;
    legendTitle(sx,y,'Ciśnienie');y+=14;
    legendSample(sx,y,activeTheme()==='dark'?'#e7e9ed':'#222','QNH / MSLP');y+=18;
    legendTitle(sx,y,'Wiatr');y+=14;
    legendSample(sx,y,'#152f9a','Wiatr 10 m');y+=13;
    legendSample(sx,y,'#c33b2b','Porywy',[5,4]);y+=13;
    legendSample(sx,y,WIND_ARROW,'Kierunek');y+=18;
    legendTitle(sx,y,'Chmury');y+=14;
    legendSample(sx,y,'#8d4a1a','Podstawa ≥5/8');y+=13;
    legendSample(sx,y,'#d66c12','Widzialność');y+=13;
    legendDot(sx,y,activeTheme()==='dark'?'#fff':'#555','Profil zachmurzenia');y+=18;
    legendTitle(sx,y,'Warstwy chmur');y+=14;
    legendSample(sx,y,CLOUD_LOW,'Niskie 0–2 km');y+=13;
    legendSample(sx,y,CLOUD_MID,'Średnie 2–5 km');y+=13;
    legendSample(sx,y,CLOUD_HIGH,'Wysokie 5–13 km');y+=18;
    ctx.fillStyle=cp.muted;ctx.font='8px Arial';ctx.textAlign='left';
    ctx.fillText('Dotknij panelu, aby',sx,y);
    ctx.fillText('zobaczyć parametry godziny.',sx,y+11);
  };

  function panelScale(v,a,b,y,h) {
    if (!finite(v) || !finite(a) || !finite(b) || a===b) return NaN;
    const pad=Math.min(INNER_PAD,Math.max(7,h*.09));
    const usable=Math.max(1,h-2*pad);
    return y+h-pad-(v-a)/(b-a)*usable;
  }

  function axisText(v,id,min,max) {
    if (!finite(v)) return '—';
    const span=Math.abs(max-min);
    if (['press','probstorm','okta'].includes(id)) return String(Math.round(v));
    if (id==='cloud') return Math.abs(v-Math.round(v))<.05 ? String(Math.round(v)) : v.toFixed(1);
    if (id==='prec') return v<1&&span<=5 ? v.toFixed(1) : (Math.abs(v-Math.round(v))<.05?String(Math.round(v)):v.toFixed(1));
    if (span<=6) return v.toFixed(1);
    return Math.abs(v-Math.round(v))<.05?String(Math.round(v)):v.toFixed(1);
  }

  function drawSeries(points,color,width=1.8,dash=[]) {
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.lineJoin='round';ctx.lineCap='round';
    ctx.beginPath();let started=false;
    for(const p of points){
      if(!finite(p.x)||!finite(p.y)){started=false;continue;}
      if(!started){ctx.moveTo(p.x,p.y);started=true;}else ctx.lineTo(p.x,p.y);
    }
    ctx.stroke();ctx.setLineDash([]);
  }

  function withClip(x0,x1,p,fn) {
    ctx.save();ctx.beginPath();ctx.rect(x0,p.y,x1-x0,p.h);ctx.clip();fn();ctx.restore();
  }

  function rangeForPanel(id,d,maxRR,windMax) {
    if(id==='temp') return niceRange(d.flatMap(z=>[z.T,z.Td]),1,5);
    if(id==='prec') return [0,maxRR];
    if(id==='probstorm') return [0,100];
    if(id==='press') return niceRange(d.map(z=>z.P),1,8);
    if(id==='wind') return [0,windMax];
    if(id==='cloud') return [0,15];
    if(id==='okta') return [0,8];
    return null;
  }

  draw = function() {
    const d=dataVisible();
    if(d.length<2)return;
    const {W,H}=sizeCanvas();
    const L=LEGEND_W+AXIS_W,R=RIGHT_W,top=HEADER_H,x0=L,x1=W-R,plotW=x1-x0;
    const t0=d[0].t,t1=d[d.length-1].t;
    const xRaw=t=>x0+(t-t0)/(t1-t0)*plotW;
    const x=t=>clamp(xRaw(t),x0,x1);
    const cp=canvasPalette();

    ctx.clearRect(0,0,W,H);ctx.fillStyle=cp.bg;ctx.fillRect(0,0,W,H);

    ctx.fillStyle=cp.title;ctx.font='11px Arial';ctx.textAlign='left';
    ctx.fillText('Inowrocław (52.80, 18.26)',x0,14);
    ctx.textAlign='right';
    ctx.fillText((selected==='consensus'?'PrognozaEPIR CONSENSUS':MODELS.find(m=>m.id===selected)?.name||selected)+'  '+horizon+'h',x1,14);

    ctx.textAlign='center';ctx.fillStyle=cp.text;ctx.font='10px Arial';
    const first3=Math.ceil(t0/THREE_HOURS)*THREE_HOURS;
    for(let t=first3;t<=t1;t+=THREE_HOURS)ctx.fillText(fmt(t,{hour:'2-digit'}),x(t),31);
    let lastDay='';
    for(let t=first3;t<=t1;t+=6*HOUR){
      const day=fmt(t,{weekday:'short',day:'2-digit',month:'2-digit'});
      if(day!==lastDay){ctx.fillStyle=cp.muted;ctx.fillText(day,clamp(x(t)+22,x0+25,x1-25),40);lastDay=day;}
    }

    const totalPanelH=PANELS.reduce((s,p)=>s+p.h,0);
    drawLegend(top,totalPanelH);

    const panelMeta=[];let y=top;
    for(const p of PANELS){
      panelMeta.push({id:p.id,y,h:p.h});
      ctx.fillStyle=cp.panel;ctx.fillRect(x0,y,plotW,p.h);
      ctx.strokeStyle=cp.border;ctx.globalAlpha=.95;ctx.lineWidth=1;ctx.strokeRect(x0,y,plotW,p.h);
      y+=p.h;
    }
    ctx.globalAlpha=1;

    const maxRR=Math.max(2,...d.map(z=>Number(z.RR)||0));
    const maxW=Math.max(10,...d.flatMap(z=>[Number(z.WS)||0,Number(z.G)||0]));
    const windMax=Math.ceil(maxW/5)*5;

    // Stronger hourly and horizontal helper grid.
    const firstHour=Math.ceil(t0/HOUR)*HOUR;
    for(let t=firstHour;t<=t1;t+=HOUR){
      const xx=x(t),major=(new Date(t).getUTCHours()%3===0);
      ctx.save();ctx.strokeStyle=major?cp.grid:cp.grid2;ctx.globalAlpha=major?.72:.42;ctx.lineWidth=major?1.15:.75;
      ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,top+totalPanelH);ctx.stroke();ctx.restore();
    }

    ctx.font='9px Arial';ctx.textAlign='right';ctx.textBaseline='middle';
    for(const p of panelMeta){
      const range=rangeForPanel(p.id,d,maxRR,windMax);
      if(!range)continue;
      const [min,max]=range,divisions=p.id==='cloud'?3:4;
      for(let i=0;i<=divisions;i++){
        const value=min+(max-min)*i/divisions;
        const yy=panelScale(value,min,max,p.y,p.h);
        ctx.save();ctx.strokeStyle=cp.grid2;ctx.globalAlpha=(i===0||i===divisions)?.52:.34;ctx.lineWidth=.8;
        ctx.beginPath();ctx.moveTo(x0,yy);ctx.lineTo(x1,yy);ctx.stroke();ctx.restore();
        ctx.fillStyle=cp.muted;ctx.globalAlpha=.98;ctx.fillText(axisText(value,p.id,min,max),x0-8,yy);ctx.globalAlpha=1;
      }
    }

    // Vertical section labels.
    ctx.fillStyle=cp.muted;ctx.font='8px Arial';ctx.textAlign='center';ctx.textBaseline='middle';
    for(const p of panelMeta){
      ctx.save();ctx.translate(x0-72,p.y+p.h/2);ctx.rotate(-Math.PI/2);ctx.globalAlpha=.94;
      ctx.fillText(sectionNames[p.id]||p.id,0,0);ctx.restore();
    }

    const byId=id=>panelMeta.find(p=>p.id===id);
    let p=byId('temp');
    let r=niceRange(d.flatMap(z=>[z.T,z.Td]),1,5);
    withClip(x0,x1,p,()=>{
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.T,r[0],r[1],p.y,p.h)})),'#d43d31',2.1);
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.Td,r[0],r[1],p.y,p.h)})),'#25278f',1.5,[3,3]);
    });

    p=byId('prec');
    withClip(x0,x1,p,()=>{
      const barW=Math.max(2,plotW/(d.length-1)*.62);
      for(const z of d)if(finite(z.RR)&&z.RR>0){
        const by=panelScale(z.RR,0,maxRR,p.y,p.h),base=panelScale(0,0,maxRR,p.y,p.h);
        ctx.fillStyle='#039c29';ctx.fillRect(x(z.t)-barW/2,by,barW,Math.max(1,base-by));
      }
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.RH,0,100,p.y,p.h)})),'#bd4723',2);
    });

    p=byId('probstorm');
    withClip(x0,x1,p,()=>{
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.wet,0,100,p.y,p.h)})),PROB_RAIN,2.6);
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.storm,0,100,p.y,p.h)})),PROB_STORM,2.6,[6,4]);
    });

    p=byId('press');r=niceRange(d.map(z=>z.P),1,8);
    withClip(x0,x1,p,()=>drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.P,r[0],r[1],p.y,p.h)})),cp.press,1.5));

    p=byId('wind');
    withClip(x0,x1,p,()=>{
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.WS,0,windMax,p.y,p.h)})),'#152f9a',1.8);
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.G,0,windMax,p.y,p.h)})),'#c33b2b',1.9,[5,4]);
    });

    p=byId('dir');
    withClip(x0,x1,p,()=>{
      ctx.fillStyle=WIND_ARROW;ctx.strokeStyle=WIND_ARROW;ctx.lineWidth=1.2;ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.font='bold 22px Arial';
      for(let i=0;i<d.length;i+=3){const z=d[i];if(!finite(z.WD))continue;ctx.save();ctx.translate(x(z.t),p.y+p.h/2);ctx.rotate((z.WD+180)*Math.PI/180);ctx.strokeText('↑',0,7);ctx.fillText('↑',0,7);ctx.restore();}
    });

    p=byId('cloud');
    withClip(x0,x1,p,()=>{
      const colW=Math.max(2,plotW/(d.length-1)),bands=60;
      for(const z of d){
        const xx=x(z.t);
        for(let b=0;b<bands;b++){
          const hkm=(b+.5)/bands*15,cc=interpCC(z.profile,hkm*1000);if(!finite(cc)||cc<8)continue;
          ctx.fillStyle=activeTheme()==='dark'?'rgba(255,255,255,'+(0.10+0.82*cc/100)+')':'rgba(55,65,70,'+(0.08+0.82*cc/100)+')';
          const y1=panelScale(hkm,0,15,p.y,p.h),y2=panelScale((b+1)/bands*15,0,15,p.y,p.h);
          ctx.fillRect(xx-colW/2,y2,colW+1,Math.max(1,y1-y2));
        }
      }
      drawSeries(d.map(z=>({x:x(z.t),y:finite(z.ceiling)?panelScale(z.ceiling/1000,0,15,p.y,p.h):NaN})),'#8d4a1a',2.4);
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(clamp((z.VIS||0)/1000,0,30),0,30,p.y,p.h)})),'#d66c12',2);
    });

    p=byId('okta');
    withClip(x0,x1,p,()=>{
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.oktaL,0,8,p.y,p.h)})),CLOUD_LOW,3.0);
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.oktaM,0,8,p.y,p.h)})),CLOUD_MID,3.0);
      drawSeries(d.map(z=>({x:x(z.t),y:panelScale(z.oktaH,0,8,p.y,p.h)})),CLOUD_HIGH,3.1);
    });

    // Repaint panel borders over clipped data for a clean right edge.
    ctx.strokeStyle=cp.border;ctx.globalAlpha=.98;ctx.lineWidth=1;
    for(const p2 of panelMeta)ctx.strokeRect(x0,p2.y,plotW,p2.h);
    ctx.globalAlpha=1;

    // Aviation UTC/Zulu axis every three hours.
    const bottom=top+totalPanelH;
    const available=Math.max(22,H-bottom);
    ctx.fillStyle=cp.bg;ctx.fillRect(x0-58,bottom,W-(x0-58),available);
    ctx.strokeStyle=cp.border;ctx.lineWidth=.9;ctx.beginPath();ctx.moveTo(x0,bottom);ctx.lineTo(x1,bottom);ctx.stroke();
    const yHour=bottom+10,yDate=bottom+21;
    ctx.fillStyle=cp.text;ctx.font='bold 8px Arial';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText('UTC',x0-8,yHour);
    ctx.textAlign='center';
    const firstUtc=Math.ceil(t0/THREE_HOURS)*THREE_HOURS;
    for(let t=firstUtc;t<=t1;t+=THREE_HOURS){
      const dt=new Date(t),xx=x(t),hh=String(dt.getUTCHours()).padStart(2,'0'),midnight=dt.getUTCHours()===0;
      ctx.strokeStyle=midnight?cp.border:cp.grid;ctx.globalAlpha=midnight?.9:.7;ctx.lineWidth=midnight?1.1:.8;
      ctx.beginPath();ctx.moveTo(xx,bottom);ctx.lineTo(xx,bottom+4);ctx.stroke();
      ctx.globalAlpha=1;ctx.fillStyle=cp.text;ctx.font=midnight?'bold 8px Arial':'8px Arial';ctx.fillText(hh+'Z',xx,yHour);
      if(midnight){ctx.fillStyle=cp.muted;ctx.font='7px Arial';ctx.fillText(String(dt.getUTCDate()).padStart(2,'0')+' '+UTC_MONTHS_ML[dt.getUTCMonth()],xx,yDate);}
    }
    ctx.globalAlpha=1;

    cv._meta={data:d,x0,x1,t0,t1,panelYs:panelMeta,H,W,top,totalPanelH};
    if(!zoomInitialized){zoomInitialized=true;requestAnimationFrame(fitWidth);}else requestAnimationFrame(applyTransform);
  };

  const version=document.querySelector('.brand small');
  if(version)version.textContent=VERSION;

  requestAnimationFrame(()=>{
    if(typeof consensus!=='undefined'&&consensus.length)draw();
  });
})();
