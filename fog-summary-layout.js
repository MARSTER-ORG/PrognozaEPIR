'use strict';
(()=>{
  if(typeof window==='undefined'||typeof document==='undefined')return;

  const ACTIVE_FOG_BRIDGE_VERSION='2026-10-01-engine-vis-continuity2';
  const HOUR=3600e3, VIS_INTERP_MAX_GAP=3*HOUR, VIS_EXACT_TOL=5*60e3, VIS_EDGE_TOL=45*60e3;
  const finite=Number.isFinite;

  function loadOnce(src,selector,mark,onload){
    const existing=document.querySelector(selector);
    if(existing){if(onload)setTimeout(onload,0);return existing;}
    const s=document.createElement('script');
    s.src=src;s.async=false;
    if(mark)s.dataset[mark]='1';
    if(onload)s.onload=onload;
    s.onerror=()=>console.error('PrognozaEPIR: nie udało się załadować '+src);
    (document.head||document.documentElement).appendChild(s);
    return s;
  }

  const validSeries=rows=>Array.isArray(rows)&&rows.length?rows:null;

  function selectedFogMode(){
    try{
      if(window.PrognozaEPIRFogMode?.get)return window.PrognozaEPIRFogMode.get()==='vnext'?'vnext':'legacy';
      return localStorage.getItem('prognozaepir-fog-engine-mode')==='vnext'?'vnext':'legacy';
    }catch(_){return 'legacy';}
  }

  function activeFogSeries(){
    // To samo źródło, z którego korzysta tooltip meteogramu.
    // Dzięki temu wartość FOG w danej godzinie i wysokość słupka nie mogą się rozjechać.
    const active=validSeries(window.PrognozaEPIRFogSeries);
    if(active)return active;

    const legacy=validSeries(window.PrognozaEPIRFogLegacySeries);
    if(selectedFogMode()==='legacy'&&legacy)return legacy;

    const vnext=validSeries(window.PrognozaEPIRFogVNextSeries);
    if(selectedFogMode()==='vnext'&&vnext)return vnext;

    return legacy||vnext||null;
  }

  function fogVisibility(row){
    if(!row)return null;
    for(const value of [row?.visGuidance?.point,row?.visProposed,row?.vis]){
      if(value===null||value===undefined||value==='')continue;
      const v=Number(value);
      if(finite(v))return v;
    }
    return null;
  }

  function visibilitySeries(){
    const rows=activeFogSeries();
    if(!Array.isArray(rows)||!rows.length)return [];
    return rows.map(row=>({t:Number(row?.t),vis:fogVisibility(row)}))
      .filter(row=>finite(row.t)&&finite(row.vis))
      .sort((a,b)=>a.t-b.t);
  }

  // VIS silnika ma pierwszeństwo w całym jego rzeczywistym horyzoncie. Krótkie
  // luki (1–2 brakujące godziny, czyli maks. 3 h między sąsiednimi punktami)
  // uzupełniamy liniowo między dwoma punktami silnika. Nie przełączamy wtedy
  // pojedynczej godziny na konsensus modeli, bo tworzyło to sztuczne zęby 20–30 km.
  function engineVisibilityAt(t,series=visibilitySeries()){
    const target=Number(t);
    if(!finite(target)||!series.length)return null;

    let nearest=null,nearestDiff=Infinity,prev=null,next=null;
    for(const row of series){
      const diff=Math.abs(row.t-target);
      if(diff<nearestDiff){nearest=row;nearestDiff=diff;}
      if(row.t<=target)prev=row;
      if(row.t>=target){next=row;break;}
    }

    // Dokładny (lub praktycznie dokładny) punkt silnika zawsze wygrywa.
    if(nearest&&nearestDiff<=VIS_EXACT_TOL)return {vis:nearest.vis,source:'fog-engine',interpolated:false};

    // Wewnątrz krótkiej luki używamy interpolacji silnika zamiast wartości modelowej.
    if(prev&&next&&next.t>prev.t){
      const gap=next.t-prev.t;
      if(gap<=VIS_INTERP_MAX_GAP&&target>=prev.t&&target<=next.t){
        const q=(target-prev.t)/gap;
        return {vis:prev.vis+(next.vis-prev.vis)*q,source:'fog-engine-interpolated',interpolated:true};
      }
    }

    // Na samym brzegu szeregu dopuszczamy tylko niewielkie przesunięcie znacznika czasu.
    if(nearest&&nearestDiff<=VIS_EDGE_TOL)return {vis:nearest.vis,source:'fog-engine',interpolated:false};
    return null;
  }

  function installVisibilityContinuityBridge(){
    if(window.__EPIR_FOG_VIS_CONTINUITY__===ACTIVE_FOG_BRIDGE_VERSION)return true;
    if(typeof dataVisible!=='function')return false;

    const baseDataVisible=dataVisible;
    dataVisible=function(){
      const rows=baseDataVisible.apply(this,arguments);
      if(!Array.isArray(rows)||!rows.length)return rows;

      let useEngine=true;
      try{if(typeof selected!=='undefined'&&selected!=='consensus')useEngine=false;}catch(_){}
      if(!useEngine)return rows;

      const visSeries=visibilitySeries();
      if(!visSeries.length)return rows;

      return rows.map(row=>{
        const sample=engineVisibilityAt(row?.t,visSeries);
        if(!sample||!finite(sample.vis))return row;
        const modelVis=finite(Number(row?.VIS_MODEL))?Number(row.VIS_MODEL):Number(row?.VIS);
        return {
          ...row,
          VIS:sample.vis,
          VIS_MODEL:finite(modelVis)?modelVis:null,
          VIS_SOURCE:sample.source,
          VIS_INTERPOLATED:sample.interpolated===true
        };
      });
    };

    window.__EPIR_FOG_VIS_CONTINUITY__=ACTIVE_FOG_BRIDGE_VERSION;
    window.PrognozaEPIRFogVisibilityContinuity=Object.freeze({
      version:ACTIVE_FOG_BRIDGE_VERSION,
      maxInterpolationGapMs:VIS_INTERP_MAX_GAP,
      engineVisibilityAt:t=>engineVisibilityAt(t)
    });
    return true;
  }

  function visText(v){
    v=Number(v);
    if(!finite(v))return '—';
    return v>=1000?(v/1000).toFixed(1)+' km':Math.round(v)+' m';
  }

  // Ostatnia korekta dolnej karty. fog-meteogram-overlay może pokazać surowy
  // punkt FOG, natomiast karta ma odpowiadać dokładnie temu VIS, który został
  // narysowany po interpolacji na pomarańczowej linii.
  function syncSectionVisibility(z,panelId){
    if((panelId!=='visfog'&&panelId!=='cloud')||!z||!finite(Number(z.VIS)))return;
    const values=document.querySelector('#sectionInfo .section-values');
    if(!values)return;
    const cells=[...values.querySelectorAll('.section-value')].filter(cell=>
      String(cell.querySelector('small')?.textContent||'').trim().toLowerCase().startsWith('widzialność')
    );
    let cell=cells[0];
    if(!cell){cell=document.createElement('div');cell.className='section-value';values.prepend(cell);}
    const source=String(z.VIS_SOURCE||'');
    const label=source==='fog-engine-interpolated'?'Widzialność · FOG ENGINE (interp.)':
      source==='fog-engine'?'Widzialność · FOG ENGINE':'Widzialność · konsensus modeli';
    cell.innerHTML='<small>'+label+'</small><strong>'+visText(z.VIS)+'</strong>';
    for(let i=1;i<cells.length;i++)cells[i].remove();
  }

  function withActiveFogSeries(fn){
    const active=activeFogSeries();
    if(!active)return fn();

    const restore=[];
    const replaceMethod=(obj,key)=>{
      if(!obj||typeof obj[key]!=='function')return;
      const old=obj[key];
      try{
        obj[key]=()=>active;
        if(obj[key]!==old)restore.push(()=>{try{obj[key]=old;}catch(_){}});
      }catch(_){}
    };

    // fog-meteogram-overlay.js wcześniej wymuszał serię 2.4.4 przed aktywną
    // PrognozaEPIRFogSeries. Na czas rysowania kierujemy wszystkie jego wejścia
    // do dokładnie tej samej aktywnej serii co tooltip.
    replaceMethod(window.PrognozaEPIRFog244Context,'getSeries');
    replaceMethod(window.PrognozaEPIRFog244,'getAdjustedSeries');
    replaceMethod(window.PrognozaEPIRFog244,'getSeries');

    const oldVNext=window.PrognozaEPIRFogVNextSeries;
    let vnextReplaced=false;
    try{
      window.PrognozaEPIRFogVNextSeries=active;
      vnextReplaced=true;
    }catch(_){}

    window.__EPIR_ACTIVE_FOG_METEOGRAM_SOURCE__={
      version:ACTIVE_FOG_BRIDGE_VERSION,
      mode:selectedFogMode(),
      rows:active.length,
      firstTime:Number(active[0]?.t)||null,
      lastTime:Number(active[active.length-1]?.t)||null
    };

    try{return fn();}
    finally{
      if(vnextReplaced){try{window.PrognozaEPIRFogVNextSeries=oldVNext;}catch(_){}}
      for(let i=restore.length-1;i>=0;i--)restore[i]();
    }
  }

  function installActiveFogMeteogramBridge(){
    if(window.__EPIR_ACTIVE_FOG_METEOGRAM_BRIDGE__===ACTIVE_FOG_BRIDGE_VERSION)return true;
    if(typeof draw!=='function'||typeof showSectionInfo!=='function')return false;
    if(!installVisibilityContinuityBridge())return false;

    const baseDraw=draw;
    draw=function(){return withActiveFogSeries(()=>baseDraw());};

    const baseInfo=showSectionInfo;
    showSectionInfo=function(z,panelId){
      const out=withActiveFogSeries(()=>baseInfo(z,panelId));
      syncSectionVisibility(z,panelId);
      return out;
    };

    window.__EPIR_ACTIVE_FOG_METEOGRAM_BRIDGE__=ACTIVE_FOG_BRIDGE_VERSION;
    return true;
  }

  if(!installActiveFogMeteogramBridge()){
    let attempts=0;
    const timer=setInterval(()=>{
      attempts++;
      if(installActiveFogMeteogramBridge()||attempts>=30)clearInterval(timer);
    },100);
  }

  if(!window.__EPIR_METEOGRAM_PRESSURE_UNITS_LOADER__){
    window.__EPIR_METEOGRAM_PRESSURE_UNITS_LOADER__=true;
    loadOnce('meteogram-pressure-units.js?v=20260922-mmHg2','script[data-epir-pressure-units="1"]','epirPressureUnits');
  }

  const loadModeSync=()=>{
    if(window.__EPIR_FOG_RUNTIME_MODE_SYNC__)return;
    loadOnce('fog-runtime-mode-sync.js?v=20260924-legacy-sync1','script[data-epir-fog-mode-sync="1"]','epirFogModeSync');
  };
  const loadContext=()=>{
    loadModeSync();
    if(window.__EPIR_FOG_244_CONTEXT__)return;
    loadOnce('fog-engine-v244-context.js?v=20260922-fog244-context2','script[data-epir-fog244-context="1"]','epirFog244Context');
  };

  // The meteogram keeps the lightweight legacy fog series as the default.
  // vNext remains calculated in the background for an explicit user choice,
  // but it is no longer allowed to commandeer the global active mode.
  loadModeSync();
  if(window.__EPIR_FOG_244__){loadContext();return;}
  if(window.__EPIR_FOG_244_LOADER__)return;
  window.__EPIR_FOG_244_LOADER__=true;
  const s=document.createElement('script');
  s.src='fog-engine-v244.js?v=20260922-fog244-threshold60-1';
  s.async=false;s.dataset.epirFog244='1';
  s.onload=loadContext;
  s.onerror=()=>{window.__EPIR_FOG_244_LOADER__=false;console.error('EPIR FOG 2.4.4: nie udało się załadować fog-engine-v244.js');};
  (document.head||document.documentElement).appendChild(s);
})();