(()=>{
'use strict';
const ROUTES=[
  ['index.html','METEOGRAM'],
  ['radar.html','RADAR / SAT / AI'],
  ['taf.html','TAF'],
  ['sat-fog.html','SAT / FOG'],
  ['arch.html','ARCH'],
  ['lightning-alerts.html','WYŁADOWANIA']
];
const current=(location.pathname.split('/').pop()||'index.html').toLowerCase();
function applyTheme(mode){
  if(mode==='dark'||mode==='light')document.documentElement.dataset.theme=mode;
  else document.documentElement.removeAttribute('data-theme');
  try{localStorage.setItem('prognozaepir-theme',mode)}catch(_e){}
}
function init(){
  if(document.querySelector('.pe-nav'))return;
  try{const saved=localStorage.getItem('prognozaepir-theme');if(saved)applyTheme(saved)}catch(_e){}
  const nav=document.createElement('nav');nav.className='pe-nav';nav.setAttribute('aria-label','PrognozaEPIR — nawigacja główna');
  for(const [href,label] of ROUTES){const a=document.createElement('a');a.href=href;a.textContent=label;if(current===href)a.setAttribute('aria-current','page');nav.appendChild(a)}
  const spacer=document.createElement('span');spacer.className='pe-spacer';nav.appendChild(spacer);
  const runtime=document.createElement('span');runtime.className='pe-runtime';runtime.textContent='CANONICAL UI · UTC';nav.appendChild(runtime);
  const theme=document.createElement('button');theme.type='button';theme.textContent='Motyw';theme.title='Przełącz jasny / ciemny';theme.addEventListener('click',()=>{const dark=document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);applyTheme(dark?'light':'dark')});nav.appendChild(theme);
  document.body.insertBefore(nav,document.body.firstChild);
  // Remove obsolete duplicate route buttons/links from historical toolbars. Brand/home links remain usable.
  for(const a of document.querySelectorAll('.controls a[href],.toolbar a[href]')){
    const href=(a.getAttribute('href')||'').split('?')[0].toLowerCase();
    if(ROUTES.some(([r])=>r===href)&&href!==current)a.remove();
  }
  window.PrognozaEPIRCanonicalUI={version:'1.0.0',routes:ROUTES.map(([href,label])=>({href,label}))};
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
