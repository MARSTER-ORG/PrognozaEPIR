'use strict';
(() => {
  const FRAME_ID='epirFogCanonicalRuntime';
  const MODE_KEY='prognozaepir-fog-engine-mode';
  const VERSION='2026-09-23-mode-visible-2';
  const SECTION_FIX='fog-section-info-fix.js';
  const ACTIVE=60,HOUR=3600e3;
  const finite=Number.isFinite;
  let frame=null,lastSync=0,lastCounts={legacy:0,vnext:0,br:0,mifg:0},fgMarkerWrapped=false;

  function selectedMode(){
    try{return localStorage.getItem(MODE_KEY)==='vnext'?'vnext':'legacy';}
    catch(_){return 'legacy';}
  }
  function copyRows(rows){
    if(!Array.isArray(rows))return [];
    return rows.map(row=>{
      if(!row||typeof row!=='object')return row;
      const out={...row};
      if(Array.isArray(row.models))out.models=row.models.map(m=>m&&typeof m==='object'?{...m,components:m.components&&typeof m.components==='object'?{...m.components}:m.components}:m);
      if(row.vnext&&typeof row.vnext==='object')out.vnext={...row.vnext};
      if(row.vnextProbability&&typeof row.vnextProbability==='object')out.vnextProbability={...row.vnextProbability};
      if(row.visGuidance&&typeof row.visGuidance==='object')out.visGuidance={...row.visGuidance};
      return out;
    });
  }
  function activeRows(rows){
    return copyRows(rows).filter(row=>finite(Number(row?.score))&&Number(row.score)>=ACTIVE);
  }
  function canonicalWindow(){
    try{return frame?.contentWindow||null;}catch(_){return null;}
  }
  function emit(name,detail){
    try{window.dispatchEvent(new CustomEvent(name,{detail}));}catch(_){}
  }
  function updateModeBadge(){
    const legend=document.querySelector('.legend');
    if(!legend)return;
    let badge=document.getElementById('fogActiveEngineBadge');
    if(!badge){
      badge=document.createElement('div');
      badge.id='fogActiveEngineBadge';
      badge.style.cssText='margin-top:5px;padding-top:5px;border-top:1px solid var(--border);font-size:9px;font-weight:700;color:var(--blueText);';
      legend.appendChild(badge);
    }
    const mode=selectedMode();
    badge.textContent=mode==='vnext'?'FOG ENGINE: NEXT 2.4.4':'FOG ENGINE: LEGACY';
    badge.dataset.mode=mode;
  }
  function drawFgEpisodeMarkers(){
    try{
      if(typeof cv==='undefined'||typeof ctx==='undefined')return;
      const api=window.PrognozaEPIRFogMeteogramOverlay,m=cv?._meta;
      if(!api?.fogRows||!m||!Array.isArray(m.panelYs)||!finite(Number(m.t0))||!finite(Number(m.t1)))return;
      const p=m.panelYs.find(x=>x?.id==='visfog')||m.panelYs.find(x=>x?.id==='cloud');
      if(!p)return;
      const rows=api.fogRows().filter(r=>r&&finite(Number(r.t))&&finite(Number(r.score))&&Number(r.score)>=ACTIVE&&Number(r.t)>=m.t0&&Number(r.t)<=m.t1).sort((a,b)=>Number(a.t)-Number(b.t));
      if(!rows.length)return;
      const groups=[];let group=[];
      for(const row of rows){const prev=group.at(-1);if(!prev||Number(row.t)-Number(prev.t)<=1.6*HOUR)group.push(row);else{groups.push(group);group=[row];}}
      if(group.length)groups.push(group);
      const x0=m.x0,x1=m.x1,plotW=x1-x0,x=t=>Math.max(x0,Math.min(x1,x0+(t-m.t0)/(m.t1-m.t0)*plotW));
      const yFor=score=>{const q=Math.max(0,Math.min(1,(Number(score)-ACTIVE)/(100-ACTIVE)));return p.y+p.h-8-q*Math.max(16,p.h-22);};
      ctx.save();ctx.beginPath();ctx.rect(x0,p.y,plotW,p.h);ctx.clip();ctx.lineWidth=1.4;ctx.font='bold 7.5px Arial';ctx.textAlign='center';ctx.textBaseline='bottom';
      for(const row of rows){const xx=x(Number(row.t)),yy=yFor(Number(row.score));ctx.strokeStyle='rgba(255,157,70,.98)';ctx.beginPath();ctx.moveTo(xx-3.5,yy);ctx.lineTo(xx+3.5,yy);ctx.stroke();}
      for(const g of groups){const peak=g.reduce((a,b)=>!a||Number(b.score)>Number(a.score)?b:a,null);if(!peak)continue;const xx=x(Number(peak.t)),yy=yFor(Number(peak.score));ctx.fillStyle=typeof canvasPalette==='function'?(canvasPalette().text||'#fff'):'#fff';ctx.fillText('FG '+Math.round(Number(peak.score)),xx,Math.max(p.y+10,yy-3));}
      ctx.restore();
    }catch(_){}
  }
  function installFgEpisodeMarkers(){
    if(fgMarkerWrapped)return true;
    try{
      if(typeof draw!=='function'||!window.__epirFogMeteogramDrawWrapped||!window.PrognozaEPIRFogMeteogramOverlay)return false;
      const base=draw;
      draw=function(){base();drawFgEpisodeMarkers();};
      fgMarkerWrapped=true;
      return true;
    }catch(_){return false;}
  }
  function computeSelectedBR(cw,mode,legacy,vnext){
    try{
      const engine=cw?.PrognozaEPIRBREngine;
      const src=mode==='vnext'&&vnext.length?vnext:legacy;
      if(!engine?.scoreRow||!src.length)return [];
      const now=Date.now();
      return activeRows(src.map(row=>engine.scoreRow(row,mode,now)).filter(r=>r&&finite(Number(r.t))&&finite(Number(r.score))));
    }catch(_){return [];}
  }
  function sync(){
    const cw=canonicalWindow();
    if(!cw)return false;
    let legacy=[],vnext=[],mifg=[];
    try{
      legacy=copyRows(cw.PrognozaEPIRFogLegacySeries);
      vnext=copyRows(cw.PrognozaEPIRFogVNextSeries);
      const m=cw.PrognozaEPIRMIFG?.getSeries?.();
      mifg=activeRows(m);
    }catch(_){return false;}
    if(!legacy.length&&!vnext.length)return false;

    const mode=selectedMode();
    const selected=mode==='vnext'&&vnext.length?vnext:legacy;
    const br=computeSelectedBR(cw,mode,legacy,vnext);

    window.PrognozaEPIRFogLegacySeries=legacy;
    window.PrognozaEPIRFogVNextSeries=vnext;
    window.PrognozaEPIRFogSeries=copyRows(selected);
    window.PrognozaEPIRFogSelectedMode=mode;
    window.PrognozaEPIRFogEngineMode=mode==='vnext'?'vnext-production':'legacy';
    window.PrognozaEPIRFogRenderThreshold=ACTIVE;
    window.PrognozaEPIRMIFGSeries=mifg;
    window.PrognozaEPIRMIFG=Object.freeze({
      VERSION:'canonical-fog-page-bridge',
      getSeries:()=>copyRows(window.PrognozaEPIRMIFGSeries)
    });
    window.PrognozaEPIRBRSeries=br;

    updateModeBadge();
    installFgEpisodeMarkers();
    lastSync=Date.now();
    lastCounts={legacy:legacy.length,vnext:vnext.length,br:br.length,mifg:mifg.length};
    const detail={source:'fog.html',mode,version:VERSION,...lastCounts};
    emit('prognozaepir:fog-series-updated',detail);
    if(vnext.length)emit('prognozaepir:fog-vnext-updated',detail);
    emit('prognozaepir:mifg-series-updated',detail);
    emit('prognozaepir:br-series-updated',detail);
    emit('prognozaepir:fog-engine-mode-applied',{...detail,threshold:window.PrognozaEPIRFogRenderThreshold});
    return true;
  }
  function bindCanonicalEvents(cw){
    for(const ev of ['prognozaepir:fog-series-updated','prognozaepir:fog-vnext-updated','prognozaepir:mifg-series-updated','prognozaepir:br-series-updated','prognozaepir:fog-engine-mode-applied']){
      try{cw.addEventListener(ev,()=>setTimeout(sync,0));}catch(_){}
    }
  }
  function loadSectionFix(){
    if(document.querySelector('script[data-epir-fog-section-fix="1"]'))return;
    const s=document.createElement('script');
    s.src=SECTION_FIX+'?v='+encodeURIComponent(VERSION);
    s.dataset.epirFogSectionFix='1';
    s.async=false;
    (document.body||document.head||document.documentElement).appendChild(s);
  }
  function loadFrame(){
    if(frame?.isConnected)return frame;
    frame=document.createElement('iframe');
    frame.id=FRAME_ID;
    frame.title='Kanoniczny runtime EPIR FOG';
    frame.tabIndex=-1;
    frame.setAttribute('aria-hidden','true');
    frame.style.cssText='position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    frame.src='fog.html?runtime-provider=1&v='+encodeURIComponent(VERSION);
    frame.addEventListener('load',()=>{
      const cw=canonicalWindow();
      if(cw)bindCanonicalEvents(cw);
      setTimeout(sync,100);
      setTimeout(sync,700);
      setTimeout(sync,2200);
      setTimeout(sync,6000);
    });
    document.body.appendChild(frame);
    return frame;
  }
  function reloadCanonical(){
    try{
      if(frame?.contentWindow)frame.contentWindow.location.reload();
      else loadFrame();
    }catch(_){loadFrame();}
  }
  function start(){
    loadSectionFix();
    updateModeBadge();
    loadFrame();
    let markerTries=0;const markerTimer=setInterval(()=>{if(installFgEpisodeMarkers()||++markerTries>80)clearInterval(markerTimer);},250);
    window.addEventListener('storage',ev=>{if(ev.key===MODE_KEY){updateModeBadge();reloadCanonical();}});
    window.addEventListener('prognozaepir:fog-engine-mode-changed',updateModeBadge);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(sync,0);});
    setInterval(sync,60000);
  }

  window.PrognozaEPIRFogIndexBridge=Object.freeze({
    version:VERSION,
    sync,
    selectedMode,
    status:()=>({lastSync,...lastCounts,frameReady:Boolean(canonicalWindow()),fgMarkerWrapped})
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();