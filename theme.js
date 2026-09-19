"use strict";
(()=>{
  if(window.__PROGNOZA_EPIR_SHARED_UI__)return;
  window.__PROGNOZA_EPIR_SHARED_UI__=true;

  const KEY="prognozaepir.theme.preference";
  const LEGACY_KEYS=["prognozaepir-theme","epir-theme"];
  const allowed=new Set(["system","light","dark"]);
  const file=(location.pathname.split("/").pop()||"index.html").replace(/\.html?$/i,"")||"index";
  const page=file==="index"?"index":file;
  document.documentElement.dataset.epirPage=page;

  const media=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;
  const read=()=>{
    try{
      const current=localStorage.getItem(KEY);
      if(allowed.has(current))return current;
      for(const legacyKey of LEGACY_KEYS){
        const legacy=localStorage.getItem(legacyKey);
        if(legacy==="light"||legacy==="dark")return legacy;
      }
    }catch(_){}
    return"system";
  };
  let pref=read();

  const resolved=()=>pref==="light"||pref==="dark"?pref:(media&&media.matches?"dark":"light");
  const syncLegacy=theme=>{
    try{for(const key of LEGACY_KEYS)localStorage.setItem(key,theme)}catch(_){}
  };
  const apply=()=>{
    const theme=resolved();
    document.documentElement.dataset.theme=theme;
    document.documentElement.dataset.themePreference=pref;
    document.documentElement.style.colorScheme=theme;
    syncLegacy(theme);
    const meta=document.querySelector('meta[name="color-scheme"]');
    if(meta)meta.setAttribute("content",theme);
    const select=document.getElementById("prognozaepir-theme-select");
    if(select&&select.value!==pref)select.value=pref;
    return theme;
  };
  const announce=theme=>{
    try{window.dispatchEvent(new CustomEvent("prognozaepir:themechange",{detail:{preference:pref,theme}}))}catch(_){}
    if(typeof window.requestAnimationFrame==="function"){
      window.requestAnimationFrame(()=>{
        try{if(typeof window.draw==="function")window.draw()}catch(_){}
      });
    }
  };
  const setPref=value=>{
    pref=allowed.has(value)?value:"system";
    try{localStorage.setItem(KEY,pref)}catch(_){}
    const theme=apply();
    announce(theme);
  };

  apply();
  if(media){
    const onChange=()=>{if(pref==="system"){const theme=apply();announce(theme)}};
    if(media.addEventListener)media.addEventListener("change",onChange);
    else if(media.addListener)media.addListener(onChange);
  }

  const NAV=[
    ["index.html","METEOGRAM","index"],
    ["fog.html","EPIR FOG","fog"],
    ["radar.html","RADAR","radar"],
    ["sat-fog.html","MGŁA SAT","sat-fog"],
    ["lightning-alerts.html","WYŁADOWANIA","lightning-alerts"],
    ["taf.html","TAF GENERATOR","taf"],
    ["arch.html","ARCHIWUM","arch"]
  ];
  const mount=()=>{
    if(new URLSearchParams(location.search).has("taf-engine"))return;
    let nav=document.getElementById("epirGlobalNav");
    if(!nav){
      nav=document.createElement("nav");
      nav.id="epirGlobalNav";
      const root=document.querySelector(".app,.wrap,main")||document.body;
      root.insertBefore(nav,root.firstChild);
    }
    nav.classList.add("epir-global-nav");
    nav.setAttribute("aria-label","Główna nawigacja PrognozaEPIR");
    nav.innerHTML=NAV.map(([href,label,id])=>`<a href="${href}"${id===page?' class="active" aria-current="page"':''}>${label}</a>`).join("")+
      '<label class="epir-theme-slot" for="prognozaepir-theme-select">Motyw <select id="prognozaepir-theme-select" aria-label="Motyw strony"><option value="system">Systemowy</option><option value="light">Jasny</option><option value="dark">Ciemny</option></select></label>';
    const select=nav.querySelector("#prognozaepir-theme-select");
    select.value=pref;
    select.addEventListener("change",()=>setPref(select.value));
    const old=document.getElementById("themeToggle");
    if(old){old.setAttribute("aria-hidden","true");old.tabIndex=-1}
  };

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});
  else mount();

  window.PrognozaEPIRTheme=Object.freeze({getPreference:()=>pref,getResolved:resolved,setPreference:setPref});
})();
