'use strict';
(() => {
  const FOG_DRAW_THRESHOLD = 50;
  const MIFG_DRAW_THRESHOLD = 50;
  const BR_DRAW_THRESHOLD = 50;
  const FOG_INFO_THRESHOLD = 50;
  const MIFG_INFO_THRESHOLD = 50;
  const BR_INFO_THRESHOLD = 50;
  const BR_COLOR = '#c084fc';
  const FOG_FULL_SCALE_KM = 19.5;
  const VIS_SCALE_MAX_KM = 30;
  const VIS_INNER_PAD = 9;
  const PRESSURE_INNER_PAD = 9;
  const MAX_MATCH_MS = 70 * 60e3;
  const HOUR = 3600e3;

  const finite = Number.isFinite;
  const clip = (v,a,b) => Math.max(a,Math.min(b,v));

  // index.html currently calls the visibility/cloud-profile panel "cloud".
  // Older meteogram builds used "visfog". Support both so the overlay cannot
  // silently disappear when the base meteogram changes its panel id.
  function visibilityPanel(meta) {
    const panels = Array.isArray(meta?.panelYs) ? meta.panelYs : [];
    return panels.find(p => p?.id === 'visfog') || panels.find(p => p?.id === 'cloud') || null;
  }
  const isVisibilityPanelId = id => id === 'visfog' || id === 'cloud';

  function nearestAt(rows,t) {
    if (!Array.isArray(rows) || !rows.length || !finite(t)) return null;
    let best = null, bestDiff = Infinity;
    for (const row of rows) {
      const rt = Number(row?.t), score = Number(row?.score);
      if (!finite(rt) || !finite(score)) continue;
      const d = Math.abs(rt - t);
      if (d < bestDiff) { best = row; bestDiff = d; }
    }
    return bestDiff <= MAX_MATCH_MS ? best : null;
  }

  function fogSeries() {
    return Array.isArray(window.PrognozaEPIRFogSeries) ? window.PrognozaEPIRFogSeries : [];
  }
  function fogAt(t) { return nearestAt(fogSeries(),t); }

  function mifgSeries() {
    try {
      const rows = window.PrognozaEPIRMIFG?.getSeries?.();
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }
  function mifgAt(t) { return nearestAt(mifgSeries(),t); }

  function weightedScore(parts) {
    let sum = 0, weight = 0;
    for (const part of parts) {
      if (!part || !finite(part.v) || !finite(part.w) || part.w <= 0) continue;
      sum += part.v * part.w;
      weight += part.w;
    }
    return weight ? sum / weight : null;
  }

  // Fallback BR only until br-engine.js publishes the authoritative series.
  function brScoreForFogRow(row) {
    if (!row) return null;
    const visModels = Array.isArray(row.models)
      ? row.models.map(m => Number(m?.VIS)).filter(finite)
      : [];
    const band = visModels.length
      ? 100 * visModels.filter(v => v >= 1000 && v < 5000).length / visModels.length
      : null;
    const below5 = visModels.length
      ? 100 * visModels.filter(v => v < 5000).length / visModels.length
      : null;
    const sat = finite(Number(row.sat)) ? Number(row.sat) : null;
    const fog = finite(Number(row.score)) ? Number(row.score) : null;
    const phen = String(row.obsPhenomenon || '').toUpperCase();
    let obs = null;
    if (row.obsUsed) {
      if (phen === 'BR') obs = 100;
      else if (phen === 'FG' || phen === 'FZFG') obs = 20;
      else if (phen.includes('BEZ FG/BR')) obs = 0;
    }
    let score = weightedScore([
      {v:band,w:.50},{v:below5,w:.10},{v:sat,w:.15},{v:fog,w:.15},{v:obs,w:.10}
    ]);
    if (!finite(score)) return null;
    if (phen === 'BR' && row.obsUsed) {
      const lead = Math.max(0, Number(row.lead) || 0);
      score = Math.max(score, 75 * Math.exp(-lead / 4));
    }
    const modelVis = Number(row.vis);
    if (phen !== 'BR' && (!finite(modelVis) || modelVis >= 5000) && (band ?? 0) < 30 && (sat ?? 0) < 70)
      score = Math.min(score,49);
    if (row.obsUsed && phen.includes('BEZ FG/BR') && Number(row.lead||0) <= 3 && finite(Number(row.obsVisM)) && Number(row.obsVisM) >= 5000 && (band ?? 0) < 50)
      score = Math.min(score,49);
    return clip(score,0,100);
  }

  function brSeries() {
    // Meteogram BR is derived directly with the same authoritative scorer as
    // the BR panel. This avoids startup races and stale global BR series.
    try {
      const engine = window.PrognozaEPIRBREngine;
      const src = fogSeries();
      if (engine?.scoreRow && Array.isArray(src) && src.length) {
        const now = Date.now();
        const direct = src
          .map(row => engine.scoreRow(row, 'legacy', now))
          .filter(row => row && finite(Number(row.t)) && finite(Number(row.score)))
          .sort((a,b) => Number(a.t)-Number(b.t));
        if (direct.length) return direct;
      }
    } catch (_) { }

    const published = window.PrognozaEPIRBRSeries;
    if (Array.isArray(published) && published.length) {
      return published
        .filter(row => row && finite(Number(row.t)) && finite(Number(row.score)))
        .slice().sort((a,b) => Number(a.t)-Number(b.t));
    }
    return fogSeries().map(row => {
      const score = brScoreForFogRow(row);
      return finite(score) ? {...row,score} : null;
    }).filter(Boolean);
  }
  function brAt(t) { return nearestAt(brSeries(),t); }

  function fogColor(score) {
    if (score >= 80) return 'rgba(208,80,63,.62)';
    if (score >= 60) return 'rgba(216,108,47,.57)';
    return 'rgba(212,154,40,.50)';
  }

  function yOnVisibilityScale(km,p) {
    const pad = Math.min(VIS_INNER_PAD,Math.max(7,p.h*.09));
    const usable = Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(clip(km,0,VIS_SCALE_MAX_KM)/VIS_SCALE_MAX_KM)*usable;
  }
  function yOnRiskScale(score,p) {
    return yOnVisibilityScale(FOG_FULL_SCALE_KM * clip(score,0,100) / 100,p);
  }

  function pressureStops() {
    return [
      {p:990,c:[30,102,214]},{p:995,c:[22,166,190]},{p:1000,c:[20,190,115]},
      {p:1005,c:[55,214,31]},{p:1010,c:[157,240,0]},{p:1015,c:[255,227,0]},
      {p:1020,c:[255,154,0]},{p:1025,c:[255,77,0]},{p:1030,c:[225,42,28]}
    ];
  }
  function pressureRgb(hpa) {
    const stops = pressureStops();
    if (!finite(hpa)) return [128,128,128];
    if (hpa <= stops[0].p) return stops[0].c;
    if (hpa >= stops[stops.length-1].p) return stops[stops.length-1].c;
    for (let i=0;i<stops.length-1;i++) {
      const a=stops[i], b=stops[i+1];
      if (hpa < a.p || hpa > b.p) continue;
      const q=(hpa-a.p)/(b.p-a.p);
      return [
        Math.round(a.c[0]+(b.c[0]-a.c[0])*q),
        Math.round(a.c[1]+(b.c[1]-a.c[1])*q),
        Math.round(a.c[2]+(b.c[2]-a.c[2])*q)
      ];
    }
    return stops[0].c;
  }
  function pressureCss(hpa,alpha) {
    const c=pressureRgb(hpa);
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  }
  function pressureY(value,min,max,p) {
    if (!finite(value) || !finite(min) || !finite(max) || min===max) return NaN;
    const pad=Math.min(PRESSURE_INNER_PAD,Math.max(7,p.h*.09));
    const usable=Math.max(1,p.h-2*pad);
    return p.y+p.h-pad-(value-min)/(max-min)*usable;
  }

  function drawPressureFill() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m=cv._meta;
    if (!m || !Array.isArray(m.data) || m.data.length<2) return;
    const p=Array.isArray(m.panelYs) ? m.panelYs.find(x=>x.id==='press') : null;
    if (!p) return;
    const d=m.data.filter(z=>z && finite(z.t));
    const vals=d.map(z=>z.P).filter(finite);
    if (d.length<2 || !vals.length) return;
    const range=(typeof niceRange==='function') ? niceRange(vals,1,8) : [Math.floor(Math.min(...vals)-1),Math.ceil(Math.max(...vals)+1)];
    const min=range[0], max=range[1], x0=m.x0, x1=m.x1, plotW=x1-x0;
    const x=t=>clip(x0+(t-m.t0)/(m.t1-m.t0)*plotW,x0,x1);
    const bottom=p.y+p.h;
    const dark=(typeof activeTheme==='function' && activeTheme()==='dark');
    const alpha=dark?.46:.52;
    ctx.save();
    ctx.beginPath();ctx.rect(x0,p.y,plotW,p.h);ctx.clip();
    for (let i=0;i<d.length-1;i++) {
      const a=d[i],b=d[i+1];
      if(!finite(a.P)||!finite(b.P))continue;
      const xa=x(a.t),xb=x(b.t),ya=pressureY(a.P,min,max,p),yb=pressureY(b.P,min,max,p);
      if(!finite(ya)||!finite(yb)||xb<=xa)continue;
      const g=ctx.createLinearGradient(xa,0,xb,0);
      g.addColorStop(0,pressureCss(a.P,alpha));g.addColorStop(1,pressureCss(b.P,alpha));
      ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(xa,ya);ctx.lineTo(xb,yb);ctx.lineTo(xb,bottom);ctx.lineTo(xa,bottom);ctx.closePath();ctx.fill();
    }
    const cp=typeof canvasPalette==='function'?canvasPalette():{press:'#f2f2f2'};
    ctx.strokeStyle=cp.press||(dark?'#f1f1f1':'#202020');ctx.lineWidth=1.8;ctx.lineJoin='round';ctx.lineCap='round';ctx.setLineDash([]);ctx.beginPath();
    let started=false;
    for(const z of d){
      if(!finite(z.P)){started=false;continue;}
      const xx=x(z.t),yy=pressureY(z.P,min,max,p);if(!finite(yy)){started=false;continue;}
      if(!started){ctx.moveTo(xx,yy);started=true;}else ctx.lineTo(xx,yy);
    }
    ctx.stroke();ctx.restore();
  }

  function drawFogBars() {
    if (typeof cv === 'undefined' || typeof ctx === 'undefined') return;
    const m=cv._meta;
    if (!m || !Array.isArray(m.data) || m.data.length<2) return;
    const p=visibilityPanel(m);
    if(!p)return;
    const x0=m.x0,x1=m.x1,plotW=x1-x0;
    const step=Math.max(3,plotW/Math.max(1,m.data.length-1));
    const barW=Math.max(2.5,step*.58);
    const baseY=yOnVisibilityScale(0,p),fullY=yOnVisibilityScale(FOG_FULL_SCALE_KM,p),fog100LabelY=yOnVisibilityScale(20,p);
    const maxBarH=Math.max(12,baseY-fullY);
    const x=t=>clip(x0+(t-m.t0)/(m.t1-m.t0)*plotW,x0,x1);

    ctx.save();ctx.beginPath();ctx.rect(x0,p.y,plotW,p.h);ctx.clip();

    // FG/FOG: bars from 50/100.
    for(const z of m.data){
      const fog=fogAt(z.t);if(!fog||Number(fog.score)<FOG_DRAW_THRESHOLD)continue;
      const score=Number(fog.score),frac=clip((score-FOG_DRAW_THRESHOLD)/(100-FOG_DRAW_THRESHOLD),0,1),h=Math.max(2,frac*maxBarH),xx=x(z.t);
      ctx.fillStyle=fogColor(score);ctx.fillRect(xx-barW/2,baseY-h,barW,h);
    }

    // MIFG: red points; the engine already trims weak temporal shoulders.
    const mifg=mifgSeries().filter(row=>row&&finite(Number(row.t))&&finite(Number(row.score))&&Number(row.score)>=MIFG_DRAW_THRESHOLD&&Number(row.t)>=m.t0&&Number(row.t)<=m.t1);
    ctx.font='bold 7.5px Arial';ctx.textAlign='center';ctx.textBaseline='bottom';
    for(const row of mifg){
      const score=Number(row.score),xx=x(Number(row.t)),yy=yOnRiskScale(score,p);
      ctx.beginPath();ctx.arc(xx,yy,3.2,0,Math.PI*2);ctx.fillStyle='rgba(214,52,52,.98)';ctx.fill();ctx.lineWidth=1;ctx.strokeStyle='rgba(255,235,235,.95)';ctx.stroke();ctx.fillStyle='rgba(205,38,38,.99)';ctx.fillText(String(Math.round(score)),xx,yy-5);
    }

    // BR: authoritative series from br-engine.js; dashed purple line from 50/100.
    const br=brSeries().filter(row=>finite(Number(row.t))&&finite(Number(row.score))&&Number(row.score)>=BR_DRAW_THRESHOLD&&Number(row.t)>=m.t0&&Number(row.t)<=m.t1);
    ctx.strokeStyle=BR_COLOR;ctx.lineWidth=2.1;ctx.setLineDash([6,3]);ctx.lineJoin='round';ctx.lineCap='round';
    const groups=[];let group=[];
    for(const row of br){
      const prev=group.length?group[group.length-1]:null;
      if(!prev||Number(row.t)-Number(prev.t)<=1.6*HOUR)group.push(row);else{groups.push(group);group=[row];}
    }
    if(group.length)groups.push(group);
    for(const g of groups){
      ctx.beginPath();
      if(g.length===1){
        const row=g[0],xx=x(Number(row.t)),yy=yOnRiskScale(Number(row.score),p),half=Math.max(5,Math.min(step*.45,14));ctx.moveTo(xx-half,yy);ctx.lineTo(xx+half,yy);
      }else{
        g.forEach((row,i)=>{const xx=x(Number(row.t)),yy=yOnRiskScale(Number(row.score),p);if(i===0)ctx.moveTo(xx,yy);else ctx.lineTo(xx,yy);});
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Make BR explicit on small/mobile meteograms: purple diamonds + score.
    ctx.font='bold 7.5px Arial';ctx.textAlign='center';ctx.textBaseline='bottom';
    for(const row of br){
      const score=Number(row.score),xx=x(Number(row.t)),yy=yOnRiskScale(score,p),r=4.1;
      ctx.save();ctx.translate(xx,yy);ctx.rotate(Math.PI/4);ctx.fillStyle='rgba(192,132,252,.96)';ctx.strokeStyle='rgba(248,240,255,.98)';ctx.lineWidth=1;ctx.fillRect(-r,-r,2*r,2*r);ctx.strokeRect(-r,-r,2*r,2*r);ctx.restore();
      ctx.fillStyle='rgba(218,180,255,.99)';ctx.fillText('BR '+String(Math.round(score)),xx,yy-7);
    }

    const cp=typeof canvasPalette==='function'?canvasPalette():{muted:'#666',grid2:'#999'};
    ctx.strokeStyle=cp.grid2||'#999';ctx.globalAlpha=.52;ctx.setLineDash([3,3]);ctx.lineWidth=.8;
    ctx.beginPath();ctx.moveTo(x0,baseY);ctx.lineTo(x1,baseY);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x0,fullY);ctx.lineTo(x1,fullY);ctx.stroke();ctx.setLineDash([]);ctx.restore();

    ctx.save();ctx.globalAlpha=.96;ctx.fillStyle=cp.muted||'#666';ctx.font='bold 8px Arial';ctx.textBaseline='middle';ctx.textAlign='right';ctx.fillText('FOG 50',x0-24,baseY);ctx.fillText('FOG 100',x0-24,fog100LabelY);ctx.restore();
  }

  function addFogToSectionInfo(z,panelId){
    if(!isVisibilityPanelId(panelId))return;
    const fog=fogAt(z?.t),mifg=mifgAt(z?.t),br=brAt(z?.t);
    const box=document.getElementById('sectionInfo');if(!box||(!fog&&!mifg&&!br))return;
    const values=box.querySelector('.section-values');if(!values)return;
    const help=box.querySelector('.section-help');
    if(help)help.textContent='Pomarańczowa linia pokazuje widzialność konsensusu. FOG, MIFG i BR są rysowane od 50/100.';
    if(fog&&Number(fog.score)>=FOG_INFO_THRESHOLD&&!values.querySelector('[data-fog-risk="1"]')){
      const cell=document.createElement('div');cell.className='section-value';cell.dataset.fogRisk='1';cell.innerHTML='<small>Ryzyko mgły · FOG ENGINE</small><strong>'+Math.round(Number(fog.score))+'/100</strong>';values.appendChild(cell);
    }
    if(mifg&&Number(mifg.score)>=MIFG_INFO_THRESHOLD&&!values.querySelector('[data-mifg-risk="1"]')){
      const cell=document.createElement('div');cell.className='section-value';cell.dataset.mifgRisk='1';cell.innerHTML='<small>Niska mgła &lt;2 m · MIFG</small><strong>'+Math.round(Number(mifg.score))+'/100</strong>';values.appendChild(cell);
    }
    if(br&&Number(br.score)>=BR_INFO_THRESHOLD&&!values.querySelector('[data-br-risk="1"]')){
      const cell=document.createElement('div');cell.className='section-value';cell.dataset.brRisk='1';cell.innerHTML='<small>Zamglenie · BR</small><strong>'+Math.round(Number(br.score))+'/100</strong>';values.appendChild(cell);
    }
  }

  function installLegendNote(){
    const legend=document.querySelector('.legend');
    if(!legend||document.getElementById('fogMeteogramLegend'))return;
    const el=document.createElement('span');el.id='fogMeteogramLegend';el.style.display='inline-flex';el.style.flexWrap='wrap';el.style.gap='8px';el.style.alignItems='center';
    el.innerHTML='<b>Widzialność / mgła:</b>'+ 
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:16px;height:3px;border-radius:2px;background:#d97706"></i>linia = widzialność konsensusu</span>'+ 
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:8px;height:12px;border-radius:1px;background:rgba(216,108,47,.72)"></i>słupki = FOG ENGINE, od 50/100</span>'+ 
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d63434;border:1px solid #ffdede"></i>czerwone punkty = MIFG &lt;2 m, od 50/100</span>'+ 
      '<span style="display:inline-flex;align-items:center;gap:4px"><i aria-hidden="true" style="display:inline-block;width:16px;height:0;border-top:2px dashed '+BR_COLOR+'"></i>linia BR = zamglenie, od 50/100</span>';
    legend.appendChild(el);
  }

  function install(){
    if(typeof draw!=='function'||typeof showSectionInfo!=='function')return false;
    if(!window.__epirFogMeteogramDrawWrapped){
      const baseDraw=draw;
      draw=function(){
        baseDraw();
        drawPressureFill();
        drawFogBars();
        try{if(typeof window.PrognozaEPIRRedrawWindForeground==='function')window.PrognozaEPIRRedrawWindForeground();}catch(_){}
      };
      window.__epirFogMeteogramDrawWrapped=true;
    }
    if(!window.__epirFogMeteogramInfoWrapped){
      const baseInfo=showSectionInfo;
      showSectionInfo=function(z,panelId){baseInfo(z,panelId);addFogToSectionInfo(z,panelId);};
      window.__epirFogMeteogramInfoWrapped=true;
    }
    installLegendNote();
    window.__EPIR_FOG_METEOGRAM_OVERLAY_VERSION__='2026-09-18-panel-sync3';
    return true;
  }

  function redraw(){
    if(!install())return;
    try{if(typeof consensus!=='undefined'&&Array.isArray(consensus)&&consensus.length)draw();}catch(_){}
  }

  window.addEventListener('prognozaepir:fog-series-updated',redraw);
  window.addEventListener('prognozaepir:mifg-series-updated',redraw);
  window.addEventListener('prognozaepir:br-series-updated',redraw);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{install();setTimeout(redraw,0);},{once:true});
  else{install();setTimeout(redraw,0);}
})();