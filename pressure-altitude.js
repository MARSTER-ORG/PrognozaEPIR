'use strict';
(function(root){
  const ISA=Object.freeze({
    seaLevelPressureHpa:1013.25,
    seaLevelTemperatureK:288.15,
    lapseRateKPerM:0.0065,
    gravityMs2:9.80665,
    dryAirGasConstantJkgK:287.05287,
    metersToFeet:3.280839895013123
  });
  const DEFAULT_EPIR=Object.freeze({icao:'EPIR',elevationM:84.1248,elevationFt:276});
  const STORAGE_KEY='prognozaepir.pressureAltitude.qnhHpa';

  function finiteNumber(v){
    const n=typeof v==='string'?Number(v.trim().replace(',','.')):Number(v);
    return Number.isFinite(n)?n:null;
  }

  function pressureAltitudeMeters(qnhHpa,elevationM=DEFAULT_EPIR.elevationM){
    const qnh=finiteNumber(qnhHpa),elev=finiteNumber(elevationM);
    if(qnh===null||qnh<=0)throw new RangeError('QNH musi być dodatnią liczbą w hPa.');
    if(elev===null)throw new RangeError('Wysokość lotniska musi być liczbą w metrach.');
    const {seaLevelPressureHpa:p0,seaLevelTemperatureK:t0,lapseRateKPerM:lapse,gravityMs2:g,dryAirGasConstantJkgK:r}=ISA;
    const exponent=g/(r*lapse);
    const base=1-(lapse*elev/t0);
    if(base<=0)throw new RangeError('Wysokość lotniska wykracza poza zakres równania ISA troposfery.');
    const stationPressureHpa=qnh*Math.pow(base,exponent);
    const ratio=stationPressureHpa/p0;
    if(ratio<=0)throw new RangeError('Nieprawidłowe ciśnienie stacyjne.');
    return (t0/lapse)*(1-Math.pow(ratio,1/exponent));
  }

  function calculate(qnhHpa,elevationM=DEFAULT_EPIR.elevationM){
    const qnh=finiteNumber(qnhHpa),elev=finiteNumber(elevationM);
    const pressureAltitudeM=pressureAltitudeMeters(qnh,elev);
    return Object.freeze({
      qnhHpa:qnh,
      elevationM:elev,
      elevationFt:elev*ISA.metersToFeet,
      pressureAltitudeM,
      pressureAltitudeFt:pressureAltitudeM*ISA.metersToFeet
    });
  }

  const api=Object.freeze({ISA,DEFAULT_EPIR,calculate,pressureAltitudeMeters});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRPressureAltitude=api;
  if(typeof document==='undefined')return;

  function isIndexPage(){
    const p=document.documentElement?.dataset?.epirPage;
    if(p)return p==='index';
    const f=(location.pathname.split('/').pop()||'index.html').toLowerCase();
    return f===''||f==='index'||f==='index.html';
  }
  if(!isIndexPage())return;

  function addStyle(){
    if(document.getElementById('pressureAltitudeStyle'))return;
    const s=document.createElement('style');
    s.id='pressureAltitudeStyle';
    s.textContent=`
      .pressure-altitude{width:100%;box-sizing:border-box;margin:8px 0 0;border:1px solid var(--border,#777);background:var(--surface,#fff);border-radius:6px;padding:10px 12px;color:var(--ink,inherit)}
      .pressure-altitude__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
      .pressure-altitude__head b{font-size:13px;color:var(--blueText,#1f2a75)}
      .pressure-altitude__head span{font-size:9px;color:var(--muted,#666);text-align:right}
      .pressure-altitude__grid{display:grid;grid-template-columns:minmax(180px,.7fr) minmax(280px,1.3fr);gap:10px;align-items:stretch}
      .pressure-altitude__input,.pressure-altitude__result{box-sizing:border-box;border:1px solid var(--border,#aaa);background:var(--soft,#f3f3f3);border-radius:5px;padding:8px 10px;min-width:0}
      .pressure-altitude__input label{display:block;font-size:9px;color:var(--muted,#666);margin-bottom:4px}
      .pressure-altitude__input-row{display:flex;align-items:center;gap:6px}
      .pressure-altitude__input input{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--border,#888);background:var(--surface2,var(--surface,#fff));color:var(--ink,inherit);border-radius:4px;padding:7px 8px;font:600 15px/1.2 Arial,sans-serif}
      .pressure-altitude__unit{font-size:11px;color:var(--muted,#666);white-space:nowrap}
      .pressure-altitude__result small{display:block;font-size:9px;color:var(--muted,#666)}
      .pressure-altitude__result strong{display:block;font-size:22px;line-height:1.1;margin:2px 0;color:var(--ink,inherit)}
      .pressure-altitude__result em{display:block;font-size:10px;font-style:normal;color:var(--muted,#666)}
      .pressure-altitude__meta{margin-top:7px;font-size:9px;color:var(--muted,#666);line-height:1.35}
      .pressure-altitude__error{display:none;margin-top:5px;font-size:9px;color:#b42318}
      .pressure-altitude.invalid .pressure-altitude__error{display:block}
      @media(max-width:700px){.pressure-altitude__head{display:block}.pressure-altitude__head span{display:block;text-align:left;margin-top:2px}.pressure-altitude__grid{grid-template-columns:1fr}.pressure-altitude__result strong{font-size:20px}}
    `;
    document.head.appendChild(s);
  }

  function fmtNumber(v,d){
    return Number(v).toLocaleString('pl-PL',{minimumFractionDigits:d,maximumFractionDigits:d});
  }

  async function stationMeta(){
    try{
      const r=await fetch('station-metadata.json',{cache:'no-cache'});
      if(!r.ok)throw new Error('HTTP '+r.status);
      const j=await r.json(),e=j?.EPIR||{};
      const elevationM=finiteNumber(e.elevation_m_amsl),elevationFt=finiteNumber(e.elevation_ft_amsl);
      if(elevationM!==null&&elevationFt!==null)return {icao:e.icao||'EPIR',elevationM,elevationFt,source:'station-metadata.json'};
    }catch(e){console.warn('PrognozaEPIR pressure altitude metadata',e);}
    return {...DEFAULT_EPIR,source:'fallback'};
  }

  function storedQnh(){
    try{const v=finiteNumber(localStorage.getItem(STORAGE_KEY));if(v!==null&&v>=800&&v<=1100)return v;}catch(_){}
    return ISA.seaLevelPressureHpa;
  }

  async function mount(){
    if(document.getElementById('pressureAltitude'))return;
    const anchor=document.getElementById('sectionInfo')||document.querySelector('.wrap');
    if(!anchor)return;
    addStyle();
    const station=await stationMeta();
    const section=document.createElement('section');
    section.id='pressureAltitude';
    section.className='pressure-altitude';
    section.setAttribute('aria-labelledby','pressureAltitudeTitle');
    section.innerHTML=`
      <div class="pressure-altitude__head">
        <b id="pressureAltitudeTitle">Wysokość ciśnieniowa EPIR</b>
        <span>ISA · poziom standardowy 1013,25 hPa</span>
      </div>
      <div class="pressure-altitude__grid">
        <div class="pressure-altitude__input">
          <label for="pressureAltitudeQnh">QNH</label>
          <div class="pressure-altitude__input-row"><input id="pressureAltitudeQnh" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-describedby="pressureAltitudeError"><span class="pressure-altitude__unit">hPa</span></div>
          <div id="pressureAltitudeError" class="pressure-altitude__error">Wpisz QNH od 800 do 1100 hPa.</div>
        </div>
        <div class="pressure-altitude__result" aria-live="polite">
          <small>Wysokość ciśnieniowa</small>
          <strong id="pressureAltitudeFt">— ft</strong>
          <em id="pressureAltitudeM">— m</em>
        </div>
      </div>
      <div class="pressure-altitude__meta">Wysokość lotniska ${station.icao}: <b>${Math.round(station.elevationFt)} ft (${fmtNumber(station.elevationM,4)} m) AMSL</b>. Obliczenie wykorzystuje pełne równanie atmosfery standardowej ISA, bez przybliżenia ft/hPa.</div>`;
    anchor.insertAdjacentElement('afterend',section);
    const input=section.querySelector('#pressureAltitudeQnh'),outFt=section.querySelector('#pressureAltitudeFt'),outM=section.querySelector('#pressureAltitudeM');
    const update=()=>{
      const qnh=finiteNumber(input.value);
      if(qnh===null||qnh<800||qnh>1100){section.classList.add('invalid');outFt.textContent='— ft';outM.textContent='— m';return;}
      section.classList.remove('invalid');
      try{
        const z=calculate(qnh,station.elevationM);
        outFt.textContent=`${Math.round(z.pressureAltitudeFt).toLocaleString('pl-PL')} ft`;
        outM.textContent=`${fmtNumber(z.pressureAltitudeM,1)} m`;
        try{localStorage.setItem(STORAGE_KEY,String(qnh));}catch(_){}
      }catch(e){section.classList.add('invalid');outFt.textContent='— ft';outM.textContent='— m';}
    };
    input.value=String(storedQnh()).replace('.',',');
    input.addEventListener('input',update);
    input.addEventListener('change',update);
    update();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>mount().catch(e=>console.error('PrognozaEPIR pressure altitude',e)),{once:true});
  else mount().catch(e=>console.error('PrognozaEPIR pressure altitude',e));
})(typeof globalThis!=='undefined'?globalThis:this);
