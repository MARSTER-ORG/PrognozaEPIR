'use strict';
(()=>{
  if(typeof window==='undefined'||window.__EPIR_BR_244_BRIDGE__)return;
  window.__EPIR_BR_244_BRIDGE__=true;
  const finite=Number.isFinite,num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const api={
    VERSION:'2.4.4-integrated-bridge',
    scoreRow:row=>{
      const t=num(row?.t),a=window.PrognozaEPIRFog244?.getBRSeries?.()||[];
      let best=null,bd=Infinity;
      for(const r of a){const rt=num(r?.t),d=finite(rt)&&finite(t)?Math.abs(rt-t):Infinity;if(d<bd){bd=d;best=r;}}
      return bd<=75*60e3?best:null;
    },
    expectedVis:r=>finite(num(r?.visibility))?Math.round(num(r.visibility))+' m':'—',
    render:()=>true,
    start:()=>{}
  };
  window.PrognozaEPIRBREngine=api;
})();
