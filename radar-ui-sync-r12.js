'use strict';

// PrognozaEPIR radar UI synchronizer r12 (2026-09-20)
// Repairs the late-start race between radar-intelligence.js and echo-analysis.js.
// echo-analysis initializes before the asynchronous POLRAD source audit finishes,
// so it can remain permanently disabled even though CMAX/SRI/PAC is active.
(() => {
  if (window.__EPIR_RADAR_UI_SYNC_R12__) return;
  window.__EPIR_RADAR_UI_SYNC_R12__ = true;

  const $ = id => document.getElementById(id);
  const PRODUCTS = {
    cmax: {
      title:'Analiza POLRAD · CMAX', thresholdLabel:'Próg odbiciowości', valueName:'Odbiciowość', maxLabel:'Maksimum odbiciowości w promieniu',
      min:27,max:60,step:1,def:40,unit:'dBZ',
      presets:[[27,'Echo ≥27 dBZ'],[35,'Opad ≥35 dBZ'],[40,'Mocniejsze ≥40 dBZ'],[45,'Silne ≥45 dBZ'],[50,'Konwekcyjne ≥50 dBZ'],[55,'Bardzo silne ≥55 dBZ']],
      info:'Analizowana jest aktualnie widoczna klatka CMAX. Odbiciowość jest raportowana jako klasa legendy obrazu.'
    },
    sri: {
      title:'Analiza POLRAD · SRI — natężenie opadu', thresholdLabel:'Próg natężenia opadu', valueName:'Natężenie opadu', maxLabel:'Maksimum natężenia opadu w promieniu',
      min:.1,max:30,step:.1,def:1,unit:'mm/h',
      presets:[[.1,'≥0,1 mm/h'],[.6,'≥0,6 mm/h'],[1.7,'≥1,7 mm/h'],[5.4,'≥5,4 mm/h'],[17,'≥17 mm/h'],[30,'≥30 mm/h']],
      info:'Analizowana jest aktualnie widoczna klatka SRI. Skala produktu: natężenie opadu w mm/h.'
    },
    pac: {
      title:'Analiza POLRAD · PAC 1 h — suma opadu', thresholdLabel:'Próg sumy opadu', valueName:'Suma opadu 1 h', maxLabel:'Maksimum sumy opadu w promieniu',
      min:.1,max:30,step:.1,def:1,unit:'mm',
      presets:[[.1,'≥0,1 mm'],[.6,'≥0,6 mm'],[1.7,'≥1,7 mm'],[5.4,'≥5,4 mm'],[17,'≥17 mm'],[30,'≥30 mm']],
      info:'Analizowana jest aktualnie widoczna klatka PAC 1 h. Skala produktu: suma opadu z 1 godziny w mm.'
    }
  };

  let activeProduct = null;
  let lightningRetryAt = 0;

  function detectProduct(detail) {
    for (const p of Object.keys(PRODUCTS)) {
      if ($('polrad_' + p)?.classList.contains('active')) return p;
    }
    const p = String(detail?.product || window.PrognozaEPIRPolradState?.product || '').toLowerCase();
    if (PRODUCTS[p] && $('polrad_' + p)) return p;
    return null;
  }

  function fmt(v,p) {
    const n=Number(v);
    if(!Number.isFinite(n))return '—';
    if(p==='cmax')return Math.round(n)+' dBZ';
    return (n<1?n.toFixed(1):Math.abs(n-Math.round(n))<.05?Math.round(n):n.toFixed(1)).toString().replace('.',',')+' '+PRODUCTS[p].unit;
  }

  function bindPreset(button,p,input) {
    if (button.dataset.r12Bound === '1') return;
    button.dataset.r12Bound='1';
    button.addEventListener('click',() => {
      input.value=button.dataset.v;
      const settings=$('echoSettings');if(settings)settings.textContent=fmt(Number(button.dataset.v),p);
      $('echoAnalyze')?.click();
    });
  }

  function syncAnalysis(detail) {
    const card=$('echoDistanceCard');
    if(!card)return false;
    const p=detectProduct(detail);
    if(!p)return false;
    const pr=PRODUCTS[p];
    activeProduct=p;

    const heading=$('echoHeading'),label=$('echoThresholdLabel'),input=$('echoThreshold'),analyze=$('echoAnalyze');
    if(heading)heading.textContent=pr.title;
    if(label)label.textContent=pr.thresholdLabel;
    if($('echoValueLabel'))$('echoValueLabel').textContent=pr.valueName;
    if($('echoMaxLabel'))$('echoMaxLabel').textContent=pr.maxLabel;
    if(analyze)analyze.disabled=false;

    if(input){
      input.min=String(pr.min);input.max=String(pr.max);input.step=String(pr.step);
      const current=Number(input.value);
      if(activeProduct!==p || !Number.isFinite(current) || current<pr.min || current>pr.max)input.value=String(pr.def);
      if(!Number.isFinite(Number(input.value)) || Number(input.value)<pr.min || Number(input.value)>pr.max)input.value=String(pr.def);
    }

    const presets=$('echoPresets');
    if(presets && presets.dataset.r12Product!==p){
      presets.dataset.r12Product=p;
      presets.innerHTML=pr.presets.map(([v,text])=>`<button type="button" data-v="${v}">${text}</button>`).join('');
    }
    if(presets&&input)presets.querySelectorAll('button[data-v]').forEach(b=>bindPreset(b,p,input));

    const value=Number(input?.value);
    if($('echoSettings'))$('echoSettings').textContent=fmt(Number.isFinite(value)?value:pr.def,p);
    if($('echoInfo')){
      $('echoInfo').classList.remove('error');
      if(/^Wybierz aktywną warstwę POLRAD/i.test($('echoInfo').textContent||'') || !$('echoInfo').textContent.trim()) $('echoInfo').textContent=pr.info;
    }
    return true;
  }

  function resetIfNoProduct() {
    if (detectProduct()) return;
    activeProduct=null;
    const analyze=$('echoAnalyze');if(analyze)analyze.disabled=true;
  }

  function ensureLightning() {
    const main=$('lflStormMain');
    if(!main)return;
    const text=String(main.textContent||'');
    if(!/Ładowanie|Oczekiwanie/i.test(text))return;
    if(Date.now()-lightningRetryAt<15000)return;
    if(typeof window.PrognozaEPIRLightning?.refresh!=='function')return;
    lightningRetryAt=Date.now();
    window.PrognozaEPIRLightning.refresh().catch(()=>{});
  }

  window.addEventListener('prognozaepir:polrad-frame-changed',e=>{
    // The canonical POLRAD event is dispatched only after a frame has loaded.
    // This is the authoritative moment to arm the analysis UI.
    setTimeout(()=>syncAnalysis(e.detail),0);
    setTimeout(()=>window.PrognozaEPIRRadarStability?.refreshAnalysisMirror?.(),30);
  });

  window.addEventListener('prognozaepir:lightning-features-updated',()=>setTimeout(ensureLightning,0));

  const mapbar=document.querySelector('.mapbar');
  if(mapbar){
    mapbar.addEventListener('click',()=>setTimeout(()=>{syncAnalysis();resetIfNoProduct();},80),true);
    const obs=new MutationObserver(()=>setTimeout(()=>{syncAnalysis();resetIfNoProduct();},0));
    obs.observe(mapbar,{subtree:true,attributes:true,attributeFilter:['class'],childList:true});
  }

  $('refresh')?.addEventListener('click',()=>setTimeout(()=>{syncAnalysis();ensureLightning();},700));

  [0,500,1200,2500,5000].forEach(ms=>setTimeout(()=>{syncAnalysis();ensureLightning();},ms));
})();
