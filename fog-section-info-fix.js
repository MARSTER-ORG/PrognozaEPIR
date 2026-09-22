'use strict';
(() => {
  const VERSION='2026-09-22-section-threshold60-br-1';
  const ACTIVE=60;
  const MAX_MATCH_MS=70*60e3;
  const finite=Number.isFinite;

  function nearest(rows,t){
    if(!Array.isArray(rows)||!rows.length||!finite(Number(t)))return null;
    let best=null,bestDiff=Infinity;
    for(const row of rows){
      const rt=Number(row?.t),score=Number(row?.score);
      if(!finite(rt)||!finite(score))continue;
      const d=Math.abs(rt-Number(t));
      if(d<bestDiff){best=row;bestDiff=d;}
    }
    return bestDiff<=MAX_MATCH_MS?best:null;
  }

  function series(){
    const overlay=window.PrognozaEPIRFogMeteogramOverlay;
    let fog=[],br=[],mifg=[];
    try{fog=Array.isArray(overlay?.fogRows?.())?overlay.fogRows():[];}catch(_){}
    try{br=Array.isArray(overlay?.brSeries?.())?overlay.brSeries():[];}catch(_){}
    try{const rows=window.PrognozaEPIRMIFG?.getSeries?.();mifg=Array.isArray(rows)?rows:[];}catch(_){}
    return {fog,br,mifg};
  }

  function addOrReplace(values,key,label,row,threshold=ACTIVE){
    let cell=values.querySelector(`[data-${key}-risk="1"]`);
    const score=Number(row?.score);
    if(!finite(score)||score<threshold){
      if(cell)cell.remove();
      return;
    }
    if(!cell){
      cell=document.createElement('div');
      cell.className='section-value';
      cell.dataset[`${key}Risk`]='1';
      values.appendChild(cell);
    }
    cell.innerHTML=`<small>${label}</small><strong>${Math.round(score)}/100</strong><small>próg aktywny ≥${threshold}/100</small>`;
  }

  function removeFogCells(box){
    for(const selector of ['[data-fog-risk="1"]','[data-mifg-risk="1"]','[data-br-risk="1"]'])
      box.querySelectorAll(selector).forEach(el=>el.remove());
  }

  function correctSection(z,panelId){
    const box=document.getElementById('sectionInfo');
    if(!box)return;
    if(panelId!=='visfog'){
      removeFogCells(box);
      const help=box.querySelector('.section-help');
      if(panelId==='cloud'&&help&&/Pomarańczowa linia pokazuje widzialność/i.test(help.textContent||''))
        help.textContent='Profil chmur dla wybranej godziny. FOG, BR i MIFG są pokazane w sekcji „Widzialność / mgła”.';
      return;
    }

    const values=box.querySelector('.section-values');
    if(!values)return;
    const rows=series(),t=Number(z?.t);
    const fog=nearest(rows.fog,t),br=nearest(rows.br,t),mifg=nearest(rows.mifg,t);
    const fogThreshold=finite(Number(window.PrognozaEPIRFogRenderThreshold))?Number(window.PrognozaEPIRFogRenderThreshold):ACTIVE;
    addOrReplace(values,'fog','Ryzyko mgły · FOG ENGINE',fog,fogThreshold);
    addOrReplace(values,'br','Zamglenie · BR',br,ACTIVE);
    addOrReplace(values,'mifg','Niska mgła <2 m · MIFG',mifg,ACTIVE);
    const help=box.querySelector('.section-help');
    if(help)help.textContent=`Pomarańczowa linia pokazuje widzialność konsensusu. FOG, BR i MIFG są oznaczane dopiero od ${ACTIVE}/100.`;
  }

  function install(){
    if(window.__epirFogSectionInfoFixWrapped)return true;
    if(!window.__epirFogMeteogramInfoWrapped||typeof showSectionInfo!=='function')return false;
    const base=showSectionInfo;
    showSectionInfo=function(z,panelId){
      base(z,panelId);
      try{correctSection(z,panelId);}catch(e){console.warn('EPIR Fog section info fix:',e);}
    };
    window.__epirFogSectionInfoFixWrapped=true;
    window.__EPIR_FOG_SECTION_INFO_FIX_VERSION__=VERSION;
    return true;
  }

  let tries=0;
  const timer=setInterval(()=>{if(install()||++tries>80)clearInterval(timer);},100);
  if(document.readyState!=='loading')setTimeout(install,0);
})();
