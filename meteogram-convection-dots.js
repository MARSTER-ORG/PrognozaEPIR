'use strict';
(function(){
  if(window.__EPIR_METEOGRAM_CONVECTION_DOTS__)return;
  window.__EPIR_METEOGRAM_CONVECTION_DOTS__=true;
  var TCU='#f59e0b',CB='#e53935',MIN=30,lastSignature='';
  var canvas=document.getElementById('meteo');
  if(!canvas)return;

  function finite(v){return Number.isFinite(Number(v));}
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function forecastFor(ms){
    var rows=window.PrognozaEPIRConvection12h&&window.PrognozaEPIRConvection12h.rows;
    if(!Array.isArray(rows)||!rows.length)return null;
    var best=null,dist=Infinity;
    rows.forEach(function(r){var d=Math.abs(Number(r.time)-Number(ms));if(d<dist){dist=d;best=r;}});
    return dist<=70*60000?best:null;
  }
  function probability(z){
    var r=forecastFor(z.t);if(!r)return null;
    var storm=finite(z.storm)?clamp(Number(z.storm),0,100):null;
    var ts=storm===null?Number(r.tsProbability):clamp(0.70*Number(r.tsProbability)+0.30*storm,0,100);
    var cb=clamp(Math.max(Number(r.cbProbability),0.78*ts),0,97);
    var tcu=clamp(Math.max(Number(r.tcuProbability),cb+3),0,99);
    return{tcu:Math.round(tcu),cb:Math.round(cb)};
  }
  function drawPoint(ctx,x,y,color){
    ctx.beginPath();ctx.arc(x,y,4.2,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    ctx.lineWidth=1.4;ctx.strokeStyle=document.documentElement.dataset.theme==='dark'?'#f5f7fb':'#ffffff';ctx.stroke();
  }
  function overlay(){
    if(document.getElementById('view')&&document.getElementById('view').value!=='consensus')return;
    var m=canvas._meta;if(!m||!Array.isArray(m.data)||!Array.isArray(m.panelYs))return;
    var p=m.panelYs.find(function(x){return x.id==='probstorm';})||m.panelYs.find(function(x){return x.id==='storm';});
    if(!p||!finite(m.x0)||!finite(m.x1)||!finite(m.t0)||!finite(m.t1)||m.t1<=m.t0)return;
    var pack=window.PrognozaEPIRConvection12h;if(!pack||!Array.isArray(pack.rows)||!pack.rows.length)return;
    var signature=[pack.updatedAt,m.t0,m.t1,p.y,p.h,document.documentElement.dataset.theme].join('|');
    if(signature===lastSignature)return;lastSignature=signature;
    var ctx=canvas.getContext('2d'),span=m.t1-m.t0;
    var x=function(t){return m.x0+(t-m.t0)/span*(m.x1-m.x0);};
    var y=function(v){return p.y+p.h-(clamp(v,0,100)/100)*p.h;};
    ctx.save();ctx.beginPath();ctx.rect(m.x0,p.y,m.x1-m.x0,p.h);ctx.clip();
    m.data.forEach(function(z){
      var pr=probability(z);if(!pr)return;
      var xx=x(z.t),xt=xx,xc=xx,yt=y(pr.tcu),yc=y(pr.cb);
      if(Math.abs(yt-yc)<8){xt-=3.2;xc+=3.2;}
      if(pr.tcu>=MIN)drawPoint(ctx,xt,yt,TCU);
      if(pr.cb>=MIN)drawPoint(ctx,xc,yc,CB);
    });
    ctx.restore();
  }
  function addLegend(){
    var legend=document.querySelector('.legend');if(!legend||document.getElementById('convDotLegend'))return;
    var s=document.createElement('span');s.id='convDotLegend';
    s.textContent='TCu: pomarańczowa kropka · Cb: czerwona kropka · próg 30% · wysokość kropki odpowiada skali 0–100%.';
    legend.appendChild(s);
  }
  function invalidate(){lastSignature='';setTimeout(overlay,30);}
  addLegend();
  window.addEventListener('prognozaepir:convection-12h-updated',invalidate);
  window.addEventListener('prognozaepir:themechange',invalidate);
  document.getElementById('view')&&document.getElementById('view').addEventListener('change',invalidate);
  document.querySelectorAll('[data-h]').forEach(function(b){b.addEventListener('click',invalidate);});
  setInterval(overlay,350);
  setTimeout(overlay,100);
})();
