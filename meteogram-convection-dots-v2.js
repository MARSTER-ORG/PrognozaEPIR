'use strict';
(function(){
if(window.__EPIR_METEOGRAM_CONVECTION_DOTS_V3__)return;window.__EPIR_METEOGRAM_CONVECTION_DOTS_V3__=true;
var cv=document.getElementById('meteo'),base=window.draw;if(!cv||typeof base!=='function')return;
var ORANGE='#f59e0b',RED='#e53935',HOUR=3600000,MIN=30,INNER_PAD=9;
function ok(v){return v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));}
function lim(v){return Math.max(0,Math.min(100,Number(v)));}
function panelScale(v,y,h){var pad=Math.min(INNER_PAD,Math.max(7,h*.09)),usable=Math.max(1,h-2*pad);return y+h-pad-lim(v)/100*usable;}
function rowAt(t){var a=window.PrognozaEPIRConvection12h&&window.PrognozaEPIRConvection12h.rows;if(!Array.isArray(a)||!a.length)return null;var b=null,d=Infinity;a.forEach(function(r){var x=Math.abs(Number(r.time)-Number(t));if(x<d){d=x;b=r;}});return d<=70*60000?b:null;}
function values(z){var r=rowAt(z.t);if(!r)return null;var ts=ok(z.storm)?0.70*Number(r.tsProbability)+0.30*Number(z.storm):Number(r.tsProbability);var cb=Math.min(97,Math.max(Number(r.cbProbability),0.78*lim(ts)));var tcu=Math.min(99,Math.max(Number(r.tcuProbability),cb+3));return{tcu:Math.round(tcu),cb:Math.round(cb),source:r.mode||'NWP'};}
function dot(c,x,y,color){c.beginPath();c.arc(x,y,4.8,0,Math.PI*2);c.fillStyle=color;c.fill();c.lineWidth=1.5;c.strokeStyle=document.documentElement.dataset.theme==='dark'?'#f5f7fb':'#fff';c.stroke();}
function overlay(){
 if(document.getElementById('view')&&document.getElementById('view').value!=='consensus')return 0;
 var m=cv._meta;if(!m||!Array.isArray(m.data)||!Array.isArray(m.panelYs)||!ok(m.t0)||!ok(m.t1)||Number(m.t1)<=Number(m.t0))return 0;
 var p=m.panelYs.find(function(q){return q.id==='probstorm';})||m.panelYs.find(function(q){return q.id==='storm';});if(!p)return 0;
 var pack=window.PrognozaEPIRConvection12h;if(!pack||!Array.isArray(pack.rows)||!pack.rows.length)return 0;
 var c=cv.getContext('2d'),span=m.t1-m.t0,x=function(t){return m.x0+(Number(t)-m.t0)/span*(m.x1-m.x0);},count=0;
 c.save();c.beginPath();c.rect(m.x0,p.y,m.x1-m.x0,p.h);c.clip();
 m.data.forEach(function(z){var v=values(z);if(!v)return;var a=x(z.t),b=a,yt=panelScale(v.tcu,p.y,p.h),yb=panelScale(v.cb,p.y,p.h);if(Math.abs(yt-yb)<9){a-=3.5;b+=3.5;}if(v.tcu>=MIN){dot(c,a,yt,ORANGE);count++;}if(v.cb>=MIN){dot(c,b,yb,RED);count++;}});
 c.restore();cv.dataset.convectionDots=String(count);cv.dataset.convectionDotsUpdated=new Date().toISOString();return count;
}
window.draw=function(){var r=base.apply(this,arguments);try{overlay();}catch(e){console.warn('TCu/Cb meteogram dots',e);}return r;};
var legend=document.querySelector('.legend');if(legend&&!document.getElementById('convDotLegend')){var s=document.createElement('span');s.id='convDotLegend';s.textContent='TCu: pomarańczowa kropka · Cb: czerwona kropka · od 30% · wysokość = prawdopodobieństwo na skali 0–100%.';legend.appendChild(s);}
window.addEventListener('prognozaepir:convection-12h-updated',function(){try{window.draw();}catch(_e){}});
window.addEventListener('prognozaepir:themechange',function(){try{window.draw();}catch(_e){}});
setTimeout(function(){try{if(window.PrognozaEPIRConvection12h)window.draw();}catch(_e){}},100);
})();
