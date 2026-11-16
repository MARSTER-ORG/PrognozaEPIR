'use strict';
/* Operational meteogram accents: 0°C boundary + discrete wind-speed bands.
 * The source series, gust values and model weighting are never modified.
 */
(function(root) {
  const LEVELS = Object.freeze([
    {max:5,  color:'#2689d6',label:'0–5 m/s'},
    {max:10, color:'#29a65a',label:'>5–10 m/s'},
    {max:15, color:'#dfbc24',label:'>10–15 m/s'},
    {max:25, color:'#ec8526',label:'>15–25 m/s'},
    {max:Infinity,color:'#d93a3a',label:'>25 m/s'}
  ]);
  const THRESHOLDS = [5, 10, 15, 25];
  const finite = Number.isFinite;
  function band(speed) {
    if (!finite(speed) || speed < 0) return null;
    return LEVELS.find(b => speed <= b.max) || null;
  }
  function segments(a, b) {
    if (![a,b].every(finite) || a < 0 || b < 0) return [];
    const breaks = [0,1];
    if (a !== b) for (const threshold of THRESHOLDS) {
      const f = (threshold-a)/(b-a);
      if (f > 0 && f < 1) breaks.push(f);
    }
    breaks.sort((l,r)=>l-r);
    return breaks.slice(1).map((end,i)=>{
      const start=breaks[i], from=a+(b-a)*start, to=a+(b-a)*end;
      return {start,end,from,to,band:band((from+to)/2)};
    });
  }
  function axisMax(rows) {
    let maximum=15;
    for(const row of rows||[]) {
      for(const speed of [row?.WS,row?.G]) {
        if(finite(speed)&&speed>=0) maximum=Math.max(maximum,speed);
      }
    }
    return Math.ceil(maximum/5)*5;
  }
  function axisTicks(maximum) {
    if(!finite(maximum)||maximum<=0) return [0,5,10,15];
    const values=[0,...THRESHOLDS.filter(t=>t<=maximum),maximum];
    return [...new Set(values)].sort((a,b)=>a-b);
  }
  const api = Object.freeze({levels:LEVELS,band,segments,axisMax,axisTicks,thresholds:THRESHOLDS});
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  if (!root || !root.document) return;
  root.PrognozaEPIRWindVisual=api;

  const canvas=root.document.getElementById('meteo');
  if (!canvas || typeof draw !== 'function' || typeof ctx === 'undefined') return;
  if (root.__EPIR_WIND_ZERO_ACCENTS__) return;
  root.__EPIR_WIND_ZERO_ACCENTS__=true;

  function plotY(value, min, max, p) {
    const pad=Math.min(9,Math.max(7,p.h*.09));
    return p.y+p.h-pad-(value-min)/(max-min)*Math.max(1,p.h-2*pad);
  }
  function xFor(t,m) {
    return m.x0+(t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
  }
  function drawZero(m) {
    const p=m.panelYs.find(p=>p.id==='temp');
    if (!p) return;
    // Keep the exact scale of the production renderer including the zero anchor.
    const temps=m.data.flatMap(z=>[z.T,z.Td]).filter(finite);
    if (!temps.length) return;
    const range=niceRange(temps,1,5);
    const min=Math.min(0,range[0]),max=Math.max(0,range[1]);
    if (!(max>min)) return;
    const yy=plotY(0,min,max,p);
    if (yy<=p.y || yy>=p.y+p.h) return;
    const dark=typeof activeTheme==='function'&&activeTheme()==='dark';
    ctx.save();ctx.beginPath();ctx.rect(m.x0,p.y,m.x1-m.x0,p.h);ctx.clip();
    ctx.fillStyle=dark?'rgba(70,154,219,.095)':'rgba(64,137,211,.07)';
    ctx.fillRect(m.x0,yy,m.x1-m.x0,p.y+p.h-yy);
    ctx.strokeStyle=dark?'#f6f8fa':'#394b5e';
    ctx.lineWidth=2.2;ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(m.x0,yy);ctx.lineTo(m.x1,yy);ctx.stroke();
    ctx.restore();
    // The axis was rendered earlier, so explicitly label the real 0°C position.
    ctx.save();ctx.textAlign='right';ctx.textBaseline='middle';ctx.font='bold 11px Arial';
    ctx.fillStyle=typeof canvasPalette==='function'?canvasPalette().bg:'#fff';
    ctx.fillRect(m.x0-57,yy-8,53,16);
    ctx.fillStyle=dark?'#f6f8fa':'#243648';
    ctx.fillText('0°C',m.x0-8,yy);
    ctx.restore();
  }
  const previousDraw=draw;
  draw=function() {
    const result=previousDraw.apply(this,arguments),m=canvas._meta;
    if(m&&Array.isArray(m.data)&&Array.isArray(m.panelYs)&&m.data.length>1){
      drawZero(m);
    }
    return result;
  };
})(typeof globalThis!=='undefined'?globalThis:null);
