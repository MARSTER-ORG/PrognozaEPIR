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
const LEGACY_ROUTE_MAP=new Map([
  ['data/messages/lightning-alerts.html','lightning-alerts.html'],
  ['./data/messages/lightning-alerts.html','lightning-alerts.html'],
  ['/data/messages/lightning-alerts.html','lightning-alerts.html']
]);
const current=(location.pathname.split('/').pop()||'index.html').toLowerCase();
function applyTheme(mode){
  if(mode==='dark'||mode==='light')document.documentElement.dataset.theme=mode;
  else document.documentElement.removeAttribute('data-theme');
  try{localStorage.setItem('prognozaepir-theme',mode)}catch(_e){}
}
function canonicalHref(raw){
  const clean=String(raw||'').split('#')[0].split('?')[0].toLowerCase();
  return LEGACY_ROUTE_MAP.get(clean)||clean;
}
function sanitizeLegacyLinks(root=document){
  for(const a of root.querySelectorAll?.('a[href]')||[]){
    const raw=a.getAttribute('href')||'';
    const canonical=canonicalHref(raw);
    if(LEGACY_ROUTE_MAP.has(String(raw).split('#')[0].split('?')[0].toLowerCase()))a.setAttribute('href',canonical);
  }
}
function init(){
  if(document.querySelector('.pe-nav'))return;
  try{const saved=localStorage.getItem('prognozaepir-theme');if(saved)applyTheme(saved)}catch(_e){}
  sanitizeLegacyLinks();
  const nav=document.createElement('nav');nav.className='pe-nav';nav.setAttribute('aria-label','PrognozaEPIR — nawigacja główna');
  for(const [href,label] of ROUTES){const a=document.createElement('a');a.href=href;a.textContent=label;if(current===href)a.setAttribute('aria-current','page');nav.appendChild(a)}
  const spacer=document.createElement('span');spacer.className='pe-spacer';nav.appendChild(spacer);
  const runtime=document.createElement('span');runtime.className='pe-runtime';runtime.textContent='CANONICAL UI · UTC';nav.appendChild(runtime);
  const theme=document.createElement('button');theme.type='button';theme.textContent='Motyw';theme.title='Przełącz jasny / ciemny';theme.addEventListener('click',()=>{const dark=document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);applyTheme(dark?'light':'dark')});nav.appendChild(theme);
  document.body.insertBefore(nav,document.body.firstChild);
  // Shared navigation is authoritative. Remove historical duplicates from local toolbars.
  for(const a of document.querySelectorAll('.controls a[href],.toolbar a[href]')){
    const href=canonicalHref(a.getAttribute('href'));
    if(ROUTES.some(([r])=>r===href)&&href!==current)a.remove();
  }
  const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)sanitizeLegacyLinks(node)});
  observer.observe(document.documentElement,{childList:true,subtree:true});
  window.PrognozaEPIRCanonicalUI={version:'1.1.0',routes:ROUTES.map(([href,label])=>({href,label})),sanitizeLegacyLinks};
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
