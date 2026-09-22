'use strict';
(()=>{
  if(typeof window==='undefined'||typeof document==='undefined')return;
  if(window.__EPIR_METEOGRAM_PRESSURE_UNITS__)return;
  window.__EPIR_METEOGRAM_PRESSURE_UNITS__=true;

  const HPA_TO_MMHG=0.750061683;
  const finite=Number.isFinite;
  const pressureMmHg=hpa=>finite(Number(hpa))?Number(hpa)*HPA_TO_MMHG:null;
  const fmtPressure=hpa=>{
    const p=Number(hpa),mm=pressureMmHg(p);
    return finite(p)&&finite(mm)?`${p.toFixed(0)} hPa / ${mm.toFixed(1)} mmHg`:'—';
  };

  function ensureClickMmHg(z,panelId){
    if(panelId!=='press'||!z)return;
    const box=document.getElementById('sectionInfo');
    const values=box?.querySelector('.section-values');
    if(!values)return;
    const mm=pressureMmHg(z.P);
    let mmCell=[...values.querySelectorAll('.section-value')].find(cell=>cell.querySelector('small')?.textContent.trim().toLowerCase()==='mmhg');
    if(!mmCell){
      mmCell=document.createElement('div');
      mmCell.className='section-value';
      mmCell.innerHTML='<small>mmHg</small><strong>—</strong>';
      values.appendChild(mmCell);
    }
    const strong=mmCell.querySelector('strong');
    if(strong)strong.textContent=finite(mm)?`${mm.toFixed(1)} mmHg`:'—';
  }

  const baseShow=(typeof showSectionInfo==='function')?showSectionInfo:null;
  if(baseShow&&!window.__EPIR_PRESSURE_INFO_WRAPPED__){
    const wrapped=function(z,panelId){
      const out=baseShow.apply(this,arguments);
      ensureClickMmHg(z,panelId);
      return out;
    };
    try{showSectionInfo=wrapped;}catch(_){}
    window.showSectionInfo=wrapped;
    window.__EPIR_PRESSURE_INFO_WRAPPED__=true;
  }

  function patchPressureText(root){
    if(!(root instanceof Element))return false;
    if(root.id==='sectionInfo'||root.closest?.('#sectionInfo'))return false;
    const text=root.textContent||'';
    if(!text.includes('QNH / MSLP')||!/(?:^|\s)\d+(?:[.,]\d+)?\s*hPa\b/.test(text)||text.includes('mmHg'))return false;

    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let node;
    while((node=walker.nextNode())){
      const value=node.nodeValue||'';
      const match=value.match(/(\d+(?:[.,]\d+)?)\s*hPa\b/);
      if(!match)continue;
      const hpa=Number(match[1].replace(',','.'));
      const mm=pressureMmHg(hpa);
      if(!finite(mm))continue;
      node.nodeValue=value.replace(match[0],`${match[0]} / ${mm.toFixed(1)} mmHg`);
      return true;
    }
    return false;
  }

  const cursor=document.getElementById('cursor');
  let patching=false;
  function patchActualTooltip(){
    if(patching)return;
    patching=true;
    try{
      if(cursor&&patchPressureText(cursor))return;
      const candidates=[...document.querySelectorAll('body *')].filter(el=>{
        if(el===document.body||el.id==='sectionInfo'||el.closest?.('#sectionInfo'))return false;
        const text=el.textContent||'';
        return text.includes('QNH / MSLP')&&/\bhPa\b/.test(text)&&!text.includes('mmHg');
      });
      candidates.sort((a,b)=>a.childElementCount-b.childElementCount);
      for(const el of candidates)if(patchPressureText(el))break;
    }finally{patching=false;}
  }

  let scheduled=false;
  function schedulePatch(){
    if(scheduled)return;
    scheduled=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      scheduled=false;
      patchActualTooltip();
    }));
  }

  if(cursor){
    const cursorObserver=new MutationObserver(schedulePatch);
    cursorObserver.observe(cursor,{subtree:true,childList:true,characterData:true});
  }
  const bodyObserver=new MutationObserver(schedulePatch);
  bodyObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
  document.addEventListener('pointermove',schedulePatch,true);
  document.addEventListener('mousemove',schedulePatch,true);
  schedulePatch();

  window.PrognozaEPIRPressureUnits={HPA_TO_MMHG,pressureMmHg,fmtPressure,patchActualTooltip};
})();
