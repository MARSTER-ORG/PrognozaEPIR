'use strict';
(()=>{
  if(typeof window==='undefined'||typeof document==='undefined')return;
  if(window.__EPIR_METEOGRAM_PRESSURE_UNITS__)return;
  window.__EPIR_METEOGRAM_PRESSURE_UNITS__=true;

  const HPA_TO_MMHG=0.750061683;
  const finite=Number.isFinite;
  const canvas=document.getElementById('meteo');
  const cursor=document.getElementById('cursor');
  if(!canvas||!cursor)return;

  const pressureMmHg=hpa=>finite(Number(hpa))?Number(hpa)*HPA_TO_MMHG:null;
  const fmtPressure=hpa=>{
    const p=Number(hpa),mm=pressureMmHg(p);
    return finite(p)&&finite(mm)?`${p.toFixed(0)} hPa / ${mm.toFixed(1)} mmHg`:'—';
  };
  const fmtTime=t=>{
    try{
      if(typeof fmt==='function')return fmt(t,{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
      return new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC';
    }catch(_){return '—';}
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

  Object.assign(cursor.style,{
    position:'fixed',
    zIndex:'10000',
    display:'none',
    pointerEvents:'none',
    minWidth:'156px',
    maxWidth:'230px',
    padding:'7px 9px',
    border:'1px solid var(--border)',
    borderRadius:'7px',
    background:'var(--surface)',
    color:'var(--ink)',
    boxShadow:'0 3px 12px rgba(0,0,0,.18)',
    font:'11px/1.35 Arial,Helvetica,sans-serif',
    whiteSpace:'nowrap'
  });

  function hide(){cursor.style.display='none';}
  function nearestPressureHit(clientX,clientY){
    const m=canvas._meta;
    if(!m||!Array.isArray(m.data)||!m.data.length||!Array.isArray(m.panelYs))return null;
    const p=m.panelYs.find(x=>x?.id==='press');
    if(!p)return null;
    const rect=canvas.getBoundingClientRect();
    if(!rect.width||!rect.height)return null;
    const sx=(clientX-rect.left)/rect.width*m.W;
    const sy=(clientY-rect.top)/rect.height*m.H;
    if(sx<m.x0||sx>m.x1||sy<p.y||sy>p.y+p.h)return null;
    const t=m.t0+(sx-m.x0)/(m.x1-m.x0)*(m.t1-m.t0);
    let row=m.data[0];
    for(const candidate of m.data){
      if(Math.abs(candidate.t-t)<Math.abs(row.t-t))row=candidate;
    }
    return finite(Number(row?.P))?row:null;
  }

  canvas.addEventListener('pointermove',e=>{
    if(e.pointerType==='touch')return hide();
    const row=nearestPressureHit(e.clientX,e.clientY);
    if(!row)return hide();
    cursor.innerHTML=`<b>Ciśnienie QNH / MSLP</b><br>${fmtPressure(row.P)}<br><span style="opacity:.72">${fmtTime(row.t)}</span>`;
    cursor.style.display='block';
    const gap=12,pad=8;
    const w=cursor.offsetWidth,h=cursor.offsetHeight;
    let left=e.clientX+gap,top=e.clientY+gap;
    if(left+w>window.innerWidth-pad)left=e.clientX-w-gap;
    if(top+h>window.innerHeight-pad)top=e.clientY-h-gap;
    cursor.style.left=Math.max(pad,left)+'px';
    cursor.style.top=Math.max(pad,top)+'px';
  },{passive:true});
  canvas.addEventListener('pointerleave',hide,{passive:true});
  canvas.addEventListener('pointercancel',hide,{passive:true});

  window.PrognozaEPIRPressureUnits={HPA_TO_MMHG,pressureMmHg,fmtPressure};
})();
