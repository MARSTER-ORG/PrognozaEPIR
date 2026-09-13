'use strict';
(() => {
  if (!/\/taf\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_TAF_APP_V2__) return;
  window.__PROGNOZA_EPIR_TAF_APP_V2__ = true;

  const HOUR=3600000;
  const ISSUE_HOURS=[5,11,17,23];
  const NEIGHBORS=['EPBY','EPPW','EPKS'];
  const $=id=>document.getElementById(id);
  const finite=Number.isFinite;
  const pad=(n,w=2)=>String(Math.max(0,Math.round(n))).padStart(w,'0');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let activeResult=null;

  function fmtUtc(ms,withDate=true){
    if(!finite(ms))return'—';
    const d=new Date(ms);
    const hm=`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
    return withDate?`${pad(d.getUTCDate())}.${pad(d.getUTCMonth()+1)}.${d.getUTCFullYear()} ${hm}`:hm;
  }
  function rawOf(x){return String(x?.raw||x?.canonical_raw||'').trim();}
  function itemTime(x,ref=Date.now()){
    if(!x)return NaN;
    for(const k of ['obs_time','message_time','issue_time','time','timestamp']){const t=Date.parse(x[k]||'');if(finite(t))return t;}
    const m=rawOf(x).match(/\b(\d{6})Z\b/);if(!m)return NaN;
    const day=+m[1].slice(0,2),h=+m[1].slice(2,4),min=+m[1].slice(4,6),R=new Date(ref),c=[];
    for(let dm=-1;dm<=1;dm++)c.push(Date.UTC(R.getUTCFullYear(),R.getUTCMonth()+dm,day,h,min));
    return c.sort((a,b)=>Math.abs(a-ref)-Math.abs(b-ref))[0];
  }
  function newest(a){return a.filter(Boolean).sort((x,y)=>(itemTime(y)||0)-(itemTime(x)||0))[0]||null;}
  function observationRows(recent){
    const out=[];
    for(const k of ['metar','speci','aviation'])if(Array.isArray(recent?.[k]))out.push(...recent[k]);
    const seen=new Set();
    return out.filter(x=>/\bEPIR\b/.test(rawOf(x))).filter(x=>{const key=x?.message_id||`${itemTime(x)}|${rawOf(x)}`;if(seen.has(key))return false;seen.add(key);return true;});
  }

  function cycles(now=Date.now()){
    const base=new Date(now-18*HOUR);base.setUTCMinutes(0,0,0);
    const out=[];
    for(let i=0;i<72;i++){
      const issue=base.getTime()+i*HOUR;
      if(!ISSUE_HOURS.includes(new Date(issue).getUTCHours()))continue;
      const start=issue+HOUR,end=start+12*HOUR;
      if(issue>=now-8*HOUR&&issue<=now+30*HOUR)out.push({issue,start,end});
    }
    return out;
  }
  function fillCycles(){
    const select=$('cycle');if(!select)return;
    const now=Date.now(),list=cycles(now);
    let best=0,dist=Infinity;
    select.innerHTML=list.map((c,i)=>{
      const d=Math.abs(c.issue-now);if(d<dist){dist=d;best=i;}
      return `<option value="${i}">${fmtUtc(c.issue)} → ${fmtUtc(c.start,false)}–${fmtUtc(c.end,false)}</option>`;
    }).join('');
    select.value=String(best);
    select.dataset.cycles=JSON.stringify(list);
  }
  function selectedCycle(){
    const select=$('cycle');if(!select)return null;
    let list=[];try{list=JSON.parse(select.dataset.cycles||'[]');}catch(_){ }
    return list[+select.value]||null;
  }

  async function settle(p){try{return await p}catch(_){return null}}
  async function loadArchive(){
    const A=window.PrognozaEPIRMessageArchive;
    if(!A)throw Error('MessageArchive niedostępne');
    const [latest,recent,aviation,...neighbor]=await Promise.all([
      settle(A.latest(true)),settle(A.recent(true)),settle(A.getLatest?.('AVIATION','EPIR',true)),
      ...NEIGHBORS.map(id=>settle(A.getLatest?.('TAF',id,true)))
    ]);
    const history=observationRows(recent),observation=newest([aviation,latest?.aviation,latest?.metar,...history]);
    const neighborTafs={};NEIGHBORS.forEach((id,i)=>{neighborTafs[id]=neighbor[i]||latest?.taf_by_station?.[id]||null;});
    return {latest:latest||{},recent,history,observation,currentTaf:latest?.taf_by_station?.EPIR||latest?.taf||null,neighborTafs};
  }

  async function waitForConsensus(){
    const frame=$('engine'),w=frame?.contentWindow;if(!w)throw Error('Brak silnika modeli');
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      try{const n=w.eval('typeof consensus!=="undefined"?consensus.length:0');if(n>10)return w;}catch(_){ }
      await new Promise(r=>setTimeout(r,300));
    }
    throw Error('Silnik modeli nie udostępnił konsensusu w czasie 30 s');
  }
  async function modelRows(period){
    const w=await waitForConsensus();
    let data;
    try{
      data=w.eval(`consensus.map(z=>({t:z.t,T:z.T,Td:z.Td,RH:z.RH,RR:z.RR,VIS:z.VIS,WS:z.WS,WD:z.WD,G:z.G,ceiling:z.ceiling,lowH:z.lowH,midH:z.midH,highH:z.highH,oktaL:z.oktaL,oktaM:z.oktaM,oktaH:z.oktaH,wet:z.wet,storm:z.storm,count:z.count,dirSpread:z.dirSpread,mv:MODELS.map((m,i)=>{const ds=datasets.get(m.id),r=ds?sample(ds,z.t):null;if(!r)return null;const p=profile([{row:r,w:1,elevation:ds.elevation}],Number.isFinite(ds.elevation)?ds.elevation:90);return{id:m.id||m.name||('model_'+(i+1)),model:m.id||m.name||('model_'+(i+1)),w:m.w,vis:r.visibility,ceil:ceiling(p),code:r.weather_code,ws:r.wind_speed_10m,wd:r.wind_direction_10m,g:r.wind_gusts_10m}}).filter(Boolean)}))`);
    }catch(e){throw Error('Nie można odczytać danych modeli: '+e.message);}
    let fog=[],mifg=[];
    try{fog=w.PrognozaEPIRFogSeries||[];}catch(_){ }
    try{
      if(w.PrognozaEPIRMIFG?.refresh)await w.PrognozaEPIRMIFG.refresh();
      const until=Date.now()+4000;
      do{mifg=w.PrognozaEPIRMIFG?.getSeries?.()||[];if(mifg.length)break;await new Promise(r=>setTimeout(r,200));}while(Date.now()<until);
    }catch(_){ }
    const rows=(Array.isArray(data)?data:[]).filter(z=>finite(+z.t)&&+z.t>=period.start&&+z.t<period.end).map(z=>{
      const f=fog.find(x=>Math.abs((+x.t||+x.time||0)-z.t)<1800000),m=mifg.find(x=>Math.abs((+x.t||+x.time||0)-z.t)<1800000);
      return {...z,fogRisk:Math.max(0,+f?.risk||+f?.probability||0),mifgRisk:finite(+m?.score)?+m.score:null};
    });
    return rows;
  }

  function msaFt(){
    const g=+window.PrognozaEPIRTAFConfig?.msaFt;if(finite(g)&&g>0)return g;
    try{const v=+localStorage.getItem('prognozaepir.taf.msaFt');if(finite(v)&&v>0)return v;}catch(_){ }
    return null;
  }

  function renderNeighbors(data){
    const host=$('neighborTafs');if(!host)return;
    host.innerHTML=NEIGHBORS.map(id=>`<tr><td><b>${id}</b></td><td><pre>${esc(rawOf(data.neighborTafs[id])||'brak danych')}</pre></td></tr>`).join('');
  }
  function renderChecks(result){
    const host=$('checks');if(!host)return;
    const c=result.checks;
    const items=[
      ['Instrukcja nadrzędna',c.instructionLocked],['Okres 12 h',c.periodHours===12],['PROB40 zabronione',c.noProb40],['VV zabronione',c.noVV],['Maks. 5 grup zmian',c.max5],['Walidacja końcowa',c.ok]
    ];
    host.innerHTML=items.map(([n,ok])=>`<li class="${ok?'ok':'bad'}"><b>${esc(n)}</b>: ${ok?'OK':'BŁĄD'}</li>`).join('')+(c.warnings?.length?c.warnings.map(x=>`<li class="warn">${esc(x)}</li>`).join(''):'');
  }
  function renderHours(result){
    const host=$('hours');if(!host)return;
    host.innerHTML=result.hourly.map(h=>{
      const d=h.tafDisplay||{};
      const ceil=finite(h.ceilingFt)?Math.round(h.ceilingFt)+' ft':'—';
      const p=h.prob||{};
      return `<tr><td>${fmtUtc(h.t,false)}</td><td>${esc(d.wind||'—')}</td><td>${esc(d.visibility||'—')}</td><td>${esc(d.weather||'—')||'—'}</td><td>${esc(d.clouds||'—')}</td><td>${ceil}</td><td>${Math.round((p.precip||0)*100)}% / TS ${Math.round((p.ts||0)*100)}%</td><td>FG ${Math.round((p.fog||0)*100)}% · VIS&lt;5 km ${Math.round((p.lowVis||0)*100)}%</td></tr>`;
    }).join('');
  }
  function render(result,data,rows){
    activeResult=result;window.PrognozaEPIRTAFCurrentGenerated=result.taf;window.PrognozaEPIRTAFResultV2=result;
    $('taf').textContent=result.taf;
    $('officialTaf').textContent=rawOf(data.currentTaf)||'Brak aktualnego TAF w archiwum';
    $('metar').textContent=rawOf(data.observation)||'Brak METAR/SPECI';
    $('metarMeta').textContent=data.observation?`Archiwum · ${fmtUtc(itemTime(data.observation))}`:'Brak obserwacji do zakotwiczenia';
    $('reasons').innerHTML=result.diagnostics.reasons.length?'<ul>'+result.diagnostics.reasons.map(x=>`<li>${esc(x)}</li>`).join('')+'</ul>':'Brak progów wymagających grup zmian.';
    renderChecks(result);renderHours(result);renderNeighbors(data);
    const modelCount=Math.max(0,...result.hourly.map(h=>h.sourceRow?.mv?.length||0));
    $('sources').innerHTML=`<span class="pill ${data.observation?'ok':'warn'}">METAR/SPECI ${data.observation?'✓':'—'}</span><span class="pill ok">${esc(result.name)} v${esc(result.version)}</span><span class="pill ok">Instrukcja 11.2023 — HARD GATE</span><span class="pill ok">multimodel ${modelCount}</span><span class="pill warn">SYNOP wyłączony</span>`;
    $('conf').textContent=`Pewność ${result.confidence}%. Reguły kodowania i doboru grup zmian są wewnątrz jednego silnika. Zewnętrzne skrypty nie modyfikują wygenerowanej depeszy. MSA: ${result.diagnostics.msaMode==='explicit'?Math.round(result.diagnostics.msaFt)+' ft':'fallback 5000 ft'}.`;
    $('badge').textContent='TAF ENGINE 2 · ZGODNY';$('badge').className='badge ok';
    $('st').textContent=`${fmtUtc(Date.now(),false)} · ${rows.length} h danych`;
  }

  async function generate(){
    const period=selectedCycle();if(!period)throw Error('Nie wybrano cyklu TAF');
    $('badge').textContent='TAF ENGINE 2 · LICZENIE';$('badge').className='badge';$('st').textContent='archiwum + modele';
    $('taf').textContent='Pobieranie danych i generowanie TAF…';
    const [data,rows]=await Promise.all([loadArchive(),modelRows(period)]);
    if(rows.length<8)throw Error(`Niepełny okres modeli: ${rows.length} h`);
    const api=window.PrognozaEPIRTAFEngine;if(!api?.createEngine)throw Error('taf-engine-v2.js nie został załadowany');
    const engine=api.createEngine({config:{station:'EPIR'}});
    const result=engine.generate({station:'EPIR',issue:period.issue,start:period.start,end:period.end,rows,observation:data.observation,observations:data.history,msaFt:msaFt(),rowsAlreadyAnchored:false});
    render(result,data,rows);return result;
  }
  async function guardedGenerate(){
    try{return await generate();}
    catch(e){console.error('[TAF Engine 2]',e);$('badge').textContent='TAF ENGINE 2 · BŁĄD';$('badge').className='badge bad';$('st').textContent=e.message;$('taf').textContent='TAF NIE ZOSTAŁ ZAAKCEPTOWANY: '+e.message;renderChecks({checks:e.validation||{ok:false,instructionLocked:true,periodHours:null,noProb40:true,noVV:true,max5:true,warnings:[]}});return null;}
  }
  async function copyTaf(){
    const text=activeResult?.taf||'';if(!text)return;
    try{await navigator.clipboard.writeText(text);$('copy').textContent='Skopiowano';setTimeout(()=>$('copy').textContent='Kopiuj TAF',1200);}catch(_){ }
  }
  function install(){
    fillCycles();
    $('gen').addEventListener('click',guardedGenerate);
    $('copy').addEventListener('click',copyTaf);
    $('cycle').addEventListener('change',()=>{$('st').textContent='wybrano inny cykl — generuj ponownie';});
    $('badge').textContent='TAF ENGINE 2 · GOTOWY';$('badge').className='badge';
    $('st').textContent='kliknij „Odśwież i generuj”';
    setTimeout(()=>{if(new URLSearchParams(location.search).get('autogen')==='1')guardedGenerate();},500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
