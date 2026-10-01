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

/* Desktop viewport guard: the details card belongs immediately under the actual
   scaled meteogram. Vertical panning on desktop could previously move the canvas
   up inside a fixed-height viewport and leave a large empty block below it. */
(function installViewportGuard(){
 var viewport=document.getElementById('canvasViewport'),stage=document.getElementById('canvasStage');
 if(!viewport||!stage)return;
 var style=document.createElement('style');style.id='epir-meteogram-viewport-guard';
 style.textContent='@media (min-width:701px){html[data-epir-page="index"] .app{width:100%!important;max-width:1120px!important}html[data-epir-page="index"] .canvas-viewport{min-height:0!important}}';
 document.head.appendChild(style);
 var raf=0,busy=false;
 function parts(){var raw=stage.style.transform||'',m=raw.match(/translate\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))px\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))px\s*\)\s*scale\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\)/i);if(m)return{x:Number(m[1])||0,scale:Number(m[3])>0?Number(m[3]):1};var tx=raw.match(/translate\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))px/i),sc=raw.match(/scale\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i);return{x:tx?(Number(tx[1])||0):0,scale:sc&&Number(sc[1])>0?Number(sc[1]):1};}
 function sync(){raf=0;if(busy||innerWidth<=700)return;var h=parseFloat(stage.style.height)||parseFloat(cv.style.height)||0;if(!(h>0))return;var p=parts(),tr='translate('+p.x.toFixed(1)+'px,0px) scale('+p.scale.toFixed(4)+')',vh=Math.max(1,Math.ceil(h*p.scale));busy=true;try{if(stage.style.transform!==tr)stage.style.transform=tr;if(viewport.style.height!==vh+'px')viewport.style.height=vh+'px';}finally{busy=false;}}
 function schedule(){if(raf)cancelAnimationFrame(raf);raf=requestAnimationFrame(sync);}
 new MutationObserver(function(){if(!busy)schedule();}).observe(stage,{attributes:true,attributeFilter:['style']});
 new MutationObserver(schedule).observe(cv,{attributes:true,attributeFilter:['style','width','height']});
 addEventListener('resize',schedule,{passive:true});
 document.querySelectorAll('#zoomOut,#zoomIn,#zoomReset,#zoomFit,[data-h],#view,#refresh').forEach(function(el){el.addEventListener('click',function(){requestAnimationFrame(schedule);});el.addEventListener('change',function(){requestAnimationFrame(schedule);});});
 schedule();
})();

var legend=document.querySelector('.legend');if(legend&&!document.getElementById('convDotLegend')){var s=document.createElement('span');s.id='convDotLegend';s.textContent='TCu: pomarańczowa kropka · Cb: czerwona kropka · od 30% · wysokość = prawdopodobieństwo.';legend.appendChild(s);}
window.addEventListener('prognozaepir:convection-12h-updated',function(){window.draw();});
if(window.PrognozaEPIRConvection12h)window.draw();
})();
