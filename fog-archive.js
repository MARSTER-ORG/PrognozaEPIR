'use strict';
(() => {
  const REPO = 'MARSTER-ORG/PrognozaEPIR';
  const APP_VERSION = 'v0.10.20 HTML';
  const ENGINE_VERSION = 'EPIR FOG ENGINE v1.0';
  const ISSUE_BASE = `https://github.com/${REPO}/issues/new`;

  const finite = Number.isFinite;
  const num = v => {
    const m = String(v ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));

  function rhFromTempDew(T,Td){
    if(!finite(T)||!finite(Td)) return null;
    const a=17.625,b=243.04;
    return clamp(100*Math.exp((a*Td)/(b+Td)-(a*T)/(b+T)),0,100);
  }

  function setVersion(){
    const v=document.querySelector('.brand small');
    if(v) v.textContent=APP_VERSION;
  }

  function summaryCard(label){
    return [...document.querySelectorAll('#fogSummary .fog-card')].find(c =>
      (c.querySelector('small')?.textContent||'').trim().startsWith(label));
  }
  function diagValue(label){
    const c=[...document.querySelectorAll('#fogDiag .fog-diag-cell')].find(x =>
      (x.querySelector('small')?.textContent||'').trim()===label);
    return c ? num(c.querySelector('b')?.textContent) : null;
  }
  function summaryNumber(label){
    const c=summaryCard(label);
    return c ? num(c.querySelector('strong')?.textContent) : null;
  }
  function summaryText(label){
    const c=summaryCard(label);
    return c ? (c.querySelector('strong')?.textContent||'').trim() : null;
  }
  function confidenceText(){
    return summaryText('Pewność prognozy');
  }

  function snapshot(){
    return {
      epir_score: summaryNumber('MGŁA — EPIR score'),
      mechanism: summaryText('Typ procesu'),
      phys_score: diagValue('PHYS'),
      nwp_score: diagValue('NWP ensemble'),
      rad_score: diagValue('RAD'),
      adv_score: diagValue('ADV'),
      cbl_score: diagValue('CBL'),
      pcp_score: diagValue('PCP'),
      fsi_kt: diagValue('FSI_KT średni'),
      dmi_fog_2m_pct: diagValue('DMI fog 2 m'),
      agreement_pct: diagValue('Agreement'),
      data_coverage_pct: diagValue('Data'),
      saturation_score: diagValue('Saturation'),
      predicted_visibility_m: (()=>{
        const c=summaryCard('VIS <1000 / <500 m');
        return c ? num(c.querySelector('em')?.textContent) : null;
      })(),
      confidence_label: confidenceText(),
      captured_before_observation_assimilation: true
    };
  }

  function makePayload(){
    const time=document.getElementById('fogObsTime')?.value;
    const T=Number(String(document.getElementById('fogObsT')?.value||'').replace(',','.'));
    const Td=Number(String(document.getElementById('fogObsTd')?.value||'').replace(',','.'));
    const visM=Number(document.getElementById('fogObsVis')?.value);
    const t=time ? Date.parse(time) : NaN;
    if(!finite(t)||!finite(T)||!finite(Td)||!finite(visM)||visM<=0||Td>T+1) return null;
    const place=typeof PLACE!=='undefined'?PLACE:{lat:52.7989,lon:18.2639,tz:'Europe/Warsaw'};
    return {
      schema:'epir-fog-observation-v1',
      observed_at:new Date(t).toISOString(),
      recorded_at:new Date().toISOString(),
      location:{name:'Inowrocław',lat:place.lat,lon:place.lon,tz:place.tz},
      observation:{
        temperature_c:T,
        dew_point_c:Td,
        relative_humidity_pct:Math.round(rhFromTempDew(T,Td)*10)/10,
        visibility_m:Math.round(visM)
      },
      forecast_snapshot:snapshot(),
      app_version:APP_VERSION,
      engine_version:ENGINE_VERSION,
      source:'manual_web_observation'
    };
  }

  function issueUrl(payload){
    const title=`[FOG OBS] ${payload.observed_at}`;
    const body=[
      'EPIR_FOG_OBSERVATION_V1',
      '',
      '```json',
      JSON.stringify(payload,null,2),
      '```',
      '',
      '_Wygenerowane przez PrognozaEPIR. Po wysłaniu GitHub Actions zapisze rekord do archiwum i zamknie to zgłoszenie._'
    ].join('\n');
    return `${ISSUE_BASE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }

  function addArchiveHint(){
    const save=document.getElementById('fogObsSave');
    if(!save||save.dataset.archiveReady==='1') return;
    save.dataset.archiveReady='1';
    save.textContent='Zapisz + archiwizuj';
    save.title='Zapisz lokalnie i przygotuj archiwizację w repozytorium GitHub';

    const note=document.querySelector('.fog-observe .fog-note');
    if(note && !document.getElementById('fogArchiveNote')){
      const n=document.createElement('div');
      n.id='fogArchiveNote';n.className='fog-note';
      n.innerHTML='<b>Archiwum GitHub:</b> po kliknięciu otworzy się gotowe zgłoszenie. Naciśnij tam <b>Submit new issue</b>. GitHub Actions dopisze obserwację i snapshot EPIR do <code>data/fog-observations.jsonl</code>, a następnie zamknie zgłoszenie.';
      note.insertAdjacentElement('afterend',n);
    }

    // Capture phase: snapshot is taken before fog-engine.js assimilates the new observation.
    save.addEventListener('click',()=>{
      const payload=makePayload();
      if(!payload) return;
      const w=window.open(issueUrl(payload),'_blank','noopener');
      if(!w){
        const box=document.getElementById('fogArchiveNote');
        if(box) box.innerHTML='<b>Archiwum GitHub:</b> przeglądarka zablokowała nowe okno. Zezwól PrognozaEPIR na otwieranie nowych kart i spróbuj ponownie.';
      }
    },true);
  }

  function init(){
    setVersion();
    let tries=0;
    const timer=setInterval(()=>{
      setVersion();addArchiveHint();
      if(document.getElementById('fogObsSave')||++tries>40) clearInterval(timer);
    },250);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
