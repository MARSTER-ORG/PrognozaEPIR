'use strict';
(function(){
if(window.__EPIR_METEOGRAM_CONVECTION_DOTS_V2__)return;window.__EPIR_METEOGRAM_CONVECTION_DOTS_V2__=true;
var cv=document.getElementById('meteo'),base=window.draw;if(!cv||typeof base!=='function')return;
var ORANGE='#f59e0b',RED='#e53935';
function ok(v){return v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));}
function lim(v){return Math.max(0,Math.min(100,Number(v)));}
function rowAt(t){var a=window.PrognozaEPIRConvection12h&&window.PrognozaEPIRConvection12h.rows;if(!Array.isArray(a))return null;var b=null,d=Infinity;a.forEach(function(r){var x=Math.abs(Number(r.time)-t);if(x<d){d=x;b=r;}});return d<=4200000?b:null;}
function values(z){var r=rowAt(z.t);if(!r)return null;var ts=ok(z.storm)?0.7*Number(r.tsProbability)+0.3*Number(z.storm):Number(r.tsProbability);var cb=Math.min(97,Math.max(Number(r.cbProbability),0.78*lim(ts)));var tcu=Math.min(99,Math.max(Number(r.tcuProbability),cb+3));return{tcu:Math.round(tcu),cb:Math.round(cb),mode:r.mode||'NWP',confidence:r.confidence};}
function dot(c,x,y,color){c.beginPath();c.arc(x,y,4.8,0,Math.PI*2);c.fillStyle=color;c.fill();c.lineWidth=1.5;c.strokeStyle=document.documentElement.dataset.theme==='dark'?'#f5f7fb':'#fff';c.stroke();}
function overlay(){
 if(document.getElementById('view')&&document.getElementById('view').value!=='consensus')return;
 var m=cv._meta;if(!m||!m.data||!m.panelYs)return;var p=m.panelYs.find(function(q){return q.id==='probstorm';})||m.panelYs.find(function(q){return q.id==='storm';});if(!p)return;
 var c=cv.getContext('2d'),span=m.t1-m.t0,x=function(t){return m.x0+(t-m.t0)/span*(m.x1-m.x0);},y=function(v){var pad=Math.min(9,Math.max(7,p.h*.09)),usable=Math.max(1,p.h-2*pad);return p.y+p.h-pad-lim(v)/100*usable;};
 c.save();c.beginPath();c.rect(m.x0,p.y,m.x1-m.x0,p.h);c.clip();m.data.forEach(function(z){var v=values(z);if(!v)return;var a=x(z.t),b=a,yt=y(v.tcu),yb=y(v.cb);if(Math.abs(yt-yb)<9){a-=3.6;b+=3.6;}if(v.tcu>=30)dot(c,a,yt,ORANGE);if(v.cb>=30)dot(c,b,yb,RED);});c.restore();
}
window.draw=function(){var r=base.apply(this,arguments);overlay();return r;};

if(typeof window.showSectionInfo==='function'){
 var baseInfo=window.showSectionInfo;
 window.showSectionInfo=function(z,panelId){
  baseInfo.apply(this,arguments);
  if(panelId!=='probstorm')return;
  var v=values(z);if(!v)return;
  var box=document.getElementById('sectionInfo');if(!box)return;
  var vals=box.querySelector('.section-values');
  if(vals){
   var t=document.createElement('div');t.className='section-value';t.innerHTML='<small>TCu</small><strong style="color:'+ORANGE+'">'+v.tcu+'%</strong>';
   var c=document.createElement('div');c.className='section-value';c.innerHTML='<small>Cb</small><strong style="color:'+RED+'">'+v.cb+'%</strong>';
   vals.appendChild(t);vals.appendChild(c);
  }
  var help=box.querySelector('.section-help');
  if(help)help.textContent+=' TCu/Cb: prognoza dla wybranej godziny; wartości są pokazywane niezależnie od progu rysowania 30%.';
 };
}

var legend=document.querySelector('.legend');if(legend&&!document.getElementById('convDotLegend')){var s=document.createElement('span');s.id='convDotLegend';s.textContent='TCu: pomarańczowa kropka · Cb: czerwona kropka · od 30% · wysokość = prawdopodobieństwo.';legend.appendChild(s);}
window.addEventListener('prognozaepir:convection-12h-updated',function(){window.draw();});
if(window.PrognozaEPIRConvection12h)window.draw();
})();
