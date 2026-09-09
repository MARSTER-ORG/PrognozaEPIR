'use strict';

// Convert IMGW TERYT county codes into readable warning areas ----------------
(() => {
  const VOIVODESHIPS = {
    '02':'dolnośląskie','04':'kujawsko-pomorskie','06':'lubelskie','08':'lubuskie',
    '10':'łódzkie','12':'małopolskie','14':'mazowieckie','16':'opolskie',
    '18':'podkarpackie','20':'podlaskie','22':'pomorskie','24':'śląskie',
    '26':'świętokrzyskie','28':'warmińsko-mazurskie','30':'wielkopolskie','32':'zachodniopomorskie'
  };
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const countyWord=n=>n===1?'powiat':(n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'powiaty':'powiatów');
  const fmtDate=value=>{const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);return m?`${m[3]}.${m[2]} ${m[4]}:${m[5]}`:String(value||'—')};
  const areaLabel=warning=>{
    const counts=new Map();
    for(const raw of Array.isArray(warning?.teryt)?warning.teryt:[]){
      const code=String(raw).padStart(4,'0'),prefix=code.slice(0,2);
      counts.set(prefix,(counts.get(prefix)||0)+1);
    }
    const parts=[...counts.entries()].map(([prefix,count])=>`${VOIVODESHIPS[prefix]||`woj. ${prefix}`} — ${count} ${countyWord(count)}`);
    return parts.length?parts.join('; '):'obszar nieopisany w odpowiedzi IMGW';
  };
  if(!el('warnReadableStyle')){
    const style=document.createElement('style');style.id='warnReadableStyle';
    style.textContent='.warn-area{margin:4px 0 3px;line-height:1.45}.warn-area b,.warn-time b{color:var(--muted)}.warn-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:3px;color:var(--muted)}';
    document.head.appendChild(style);
  }
  window.loadWarnings=async function loadWarningsReadable(){
    try{
      const response=await fetch('https://danepubliczne.imgw.pl/api/data/warningsmeteo',{cache:'no-cache'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const warnings=await response.json(),dot=el('srcImgw'),box=el('warnings');
      if(dot)dot.className='dot ok';if(!box)return;
      if(!Array.isArray(warnings)||!warnings.length){box.textContent='Brak aktywnych ostrzeżeń w odpowiedzi API IMGW.';return}
      const nearDefault=typeof point!=='undefined'&&typeof DEFAULT!=='undefined'&&Math.hypot(point.lat-DEFAULT.lat,point.lon-DEFAULT.lon)<.01;
      let list=warnings;
      if(nearDefault){
        list=warnings.filter(w=>Array.isArray(w?.teryt)&&w.teryt.some(code=>String(code).padStart(4,'0').startsWith('04')));
        if(!list.length){box.innerHTML='Brak aktywnych ostrzeżeń dla woj. kujawsko-pomorskiego. <span style="color:var(--muted)">API IMGW jest aktywne.</span>';return}
      }
      list=list.slice().sort((a,b)=>Number(b.stopien||0)-Number(a.stopien||0)).slice(0,6);
      box.innerHTML=list.map(w=>{
        const event=esc(w.nazwa_zdarzenia||w.zdarzenie||w.event||w.nazwa||'Ostrzeżenie meteorologiczne');
        const level=esc(w.stopien||w.stopien_zagrozenia||w.level||''),probability=esc(w.prawdopodobienstwo||'');
        const area=esc(areaLabel(w)),from=esc(fmtDate(w.obowiazuje_od||w.od||w.start)),to=esc(fmtDate(w.obowiazuje_do||w.do||w.end));
        return `<div class="warn"><strong>${event}${level?' · stopień '+level:''}</strong><div class="warn-area"><b>Obszar:</b> ${area}</div><div class="warn-meta">${probability?`<span><b>Prawdopodobieństwo:</b> ${probability}%</span>`:''}<span class="warn-time"><b>Ważne:</b> ${from} → ${to}</span></div></div>`;
      }).join('');
    }catch(_){
      const dot=el('srcImgw'),box=el('warnings');if(dot)dot.className='dot bad';if(box)box.textContent='Nie udało się pobrać ostrzeżeń IMGW.';
    }
  };
  window.loadWarnings();
})();

// TCu / Cb convection nowcast ------------------------------------------------
// POLRAD + NWP + historical EPIR calibration. LFL is added later by
// lightning-layer.js as positive evidence only. CAPPI/IR are diagnostic
// indicators until enough history is collected to calibrate their weights.
(() => {
  if(window.__PrognozaEPIRConvectionV2)return;
  window.__PrognozaEPIRConvectionV2=true;

  const $=id=>document.getElementById(id);
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,Number(v)||0));
  const HORIZONS=[30,60,90,120,180];
  const DEFAULT_PRIORS={cu_signal:20,tcu_watch:30,tcu_likely:35,cb_likely:40,cb_strong:50};
  const POLRAD_SCOPE_KM=160, POLRAD_STEP_KM=4, POLRAD_FRAMES=12;
  const POLRAD_BOUNDS={south:48.5,west:13.5,north:56.0,east:25.0};
  const CAPPI_API='https://meteo.imgw.pl/api/radars/v1/list/cappi';
  const EUMET_WMS='https://view.eumetsat.int/geoserver/wms';
  let skill=null,renderTimer=0,diagBusy=false,diagLast=0;
  const diagnostics={cappi:null,ir:null};

  const DBZ_PALETTE=[
    [62,'#f58cff'],[59,'#f344f4'],[56,'#ff19cc'],[53,'#f00094'],[50,'#e60059'],
    [47,'#d80000'],[44,'#ff1600'],[41,'#ff4800'],[38,'#ff8800'],[35,'#ffbf00'],
    [32,'#fff200'],[29,'#fff69b'],[26,'#fffbd8'],[23,'#f3ffff'],[20,'#b8f4f1'],
    [17,'#53e8ef'],[14,'#1bc8f0'],[11,'#007ae5'],[8,'#0033e8'],[5,'#0000cc'],[0,'#0000aa']
  ].map(([z,h])=>[z,parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]);

  function currentPoint(){
    if(typeof point!=='undefined'&&Number.isFinite(Number(point?.lat))&&Number.isFinite(Number(point?.lon)))return{lat:Number(point.lat),lon:Number(point.lon)};
    const lat=Number(String($('lat')?.value||'').replace(',','.')),lon=Number(String($('lon')?.value||'').replace(',','.'));
    return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:{lat:52.8275,lon:18.3175};
  }
  function asNumber(id){
    const e=$(id);if(!e)return null;const m=String(e.textContent||'').replace(',','.').match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null;
  }
  function fmtPct(v){return `${Math.round(clamp(v,0,100))}%`;}
  function riskName(v){const n=Number(v);return n>=75?'high':n>=50?'mid':'low';}
  function riskLabel(v){const r=riskName(v);return r==='high'?'wysokie':r==='mid'?'podwyższone':'niskie';}
  function fmtLocal(sec){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit'}).format(new Date(Number(sec)*1000));}catch(_){return'—';}
  }

  function ensureStyle(){
    if($('convectionNowcastStyle'))return;
    const style=document.createElement('style');style.id='convectionNowcastStyle';style.textContent=`
      .conv-wrap{padding:9px 10px;font-size:10px;line-height:1.4}.conv-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
      .conv-tile{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:62px;transition:border-color .15s,box-shadow .15s}
      .conv-tile small{display:block;color:var(--muted);font-size:8.5px;margin-bottom:3px}.conv-tile b{display:block;font-size:15px;line-height:1.15}.conv-tile span{display:block;color:var(--muted);font-size:8px;margin-top:3px}
      .conv-h{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;margin:7px 0}.conv-h>div{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px;text-align:center;transition:border-color .15s,box-shadow .15s}.conv-h span{display:block;color:var(--muted);font-size:8px}.conv-h b{display:block;font-size:10px;white-space:nowrap}
      .conv-prob{display:inline!important;font-weight:800!important;font-size:10px!important}.conv-sep{display:inline!important;color:var(--muted)!important;font-size:9px!important}
      .conv-risk-low{border-color:#27a844!important;box-shadow:inset 0 0 0 1px rgba(39,168,68,.18)}.conv-risk-mid{border-color:#f59f00!important;box-shadow:inset 0 0 0 1px rgba(245,159,0,.20)}.conv-risk-high{border-color:#e03131!important;box-shadow:inset 0 0 0 1px rgba(224,49,49,.22)}
      .conv-prob.low{color:#35b24a!important}.conv-prob.mid{color:#f59f00!important}.conv-prob.high{color:#f04444!important}
      .conv-scope,.conv-summary,.conv-cal{border:1px solid var(--line);background:var(--panel2);border-radius:7px;padding:7px;margin-top:6px}.conv-scope b{display:block;margin-bottom:3px}.conv-scope-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 10px;color:var(--muted);font-size:8.5px}.conv-scope-grid strong{color:var(--ink)}
      .conv-thresholds{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.conv-thresholds span{border:1px solid var(--line);border-radius:999px;padding:3px 6px;font-size:8px}.conv-foot{color:var(--muted);font-size:8.5px;margin-top:6px}
      @media(max-width:700px){.conv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.conv-h{grid-template-columns:repeat(5,minmax(78px,1fr));overflow:auto}.conv-scope-grid{grid-template-columns:1fr}}
    `;document.head.appendChild(style);
  }

  function ensureCard(){
    ensureStyle();
    let card=$('convectionNowcastCard');if(card)return card;
    const left=document.querySelector('.layout > div:first-child');if(!left)return null;
    card=document.createElement('section');card.id='convectionNowcastCard';card.className='card';card.style.marginTop='8px';
    card.innerHTML=`<h2>Konwekcja TCu / Cb · nowcast 0–3 h</h2><div class="conv-wrap"><div class="conv-grid">
      <div class="conv-tile"><small>Klasa aktualna</small><b id="convClass">—</b><span id="convClassSub">POLRAD + środowisko</span></div>
      <div class="conv-tile"><small>TCu</small><b id="convTcu">—</b><span id="convTcuSub">prawdopodobieństwo</span></div>
      <div class="conv-tile"><small>Cb</small><b id="convCb">—</b><span id="convCbSub">prawdopodobieństwo</span></div>
      <div class="conv-tile"><small>Czas / ETA</small><b id="convEta">—</b><span id="convEtaSub">pierwszy istotny sygnał</span></div>
      <div class="conv-tile"><small>CMAX / punkt</small><b id="convDbz">—</b><span id="convDbzSub">POLRAD</span></div>
      <div class="conv-tile"><small>Trend rozwoju</small><b id="convTrend">—</b><span id="convTrendSub">zmiana dBZ / h</span></div>
      <div class="conv-tile"><small>Środowisko</small><b id="convEnv">—</b><span id="convEnvSub">CAPE / LI / CIN / GFS</span></div>
      <div class="conv-tile"><small>CAPPI 1 km / punkt</small><b id="convCappi">—</b><span id="convCappiSub">pionowa struktura POLRAD · diagnostycznie</span></div>
      <div class="conv-tile"><small>MTG IR10.5 / wierzchołek</small><b id="convIr">—</b><span id="convIrSub">temperatura i chłodzenie · diagnostycznie</span></div>
      <div class="conv-tile"><small>Źródła klasyfikacji</small><b>POLRAD + NWP</b><span>historia EPIR + LFL; bez AFA</span></div>
    </div>
    <div class="conv-scope" id="convScope"><b>Obręb analizy</b><div class="conv-scope-grid" id="convScopeGrid"></div></div>
    <div class="conv-h">${HORIZONS.map(h=>`<div id="convHCard${h}"><span>+${h} min</span><b id="convH${h}">—</b></div>`).join('')}</div>
    <div class="conv-summary" id="convSummary">Oczekiwanie na wynik POLRAD…</div><div class="conv-cal" id="convCalibration">Kalibracja historyczna: ładowanie…</div><div class="conv-thresholds" id="convThresholds"></div>
    <div class="conv-foot">Kolory prawdopodobieństwa: 0–49% zielony · 50–74% pomarańczowy · 75–100% czerwony. CAPPI i IR10.5 są na razie wskaźnikami diagnostycznymi, bez osobnej wyuczonej wagi.</div></div>`;
    const rn=$('radarNowcastCard');if(rn&&rn.parentElement===left)rn.insertAdjacentElement('afterend',card);else left.appendChild(card);
    installProbabilityObserver(card);
    return card;
  }

  function setRiskClass(el,value){
    const host=el?.closest('.conv-tile')||el;if(!host)return;
    host.classList.remove('conv-risk-low','conv-risk-mid','conv-risk-high');
    host.classList.add('conv-risk-'+riskName(value));
  }
  function paintProbabilityUi(){
    for(const id of['convTcu','convCb']){
      const el=$(id);if(!el)continue;const m=String(el.textContent||'').match(/(\d{1,3})\s*%/);if(m)setRiskClass(el,Number(m[1]));
    }
    for(const h of HORIZONS){
      const el=$(`convH${h}`),card=$(`convHCard${h}`);if(!el||!card)continue;
      const text=String(el.textContent||'').replace(/\s+/g,' ').trim();
      const mt=text.match(/TCu\s*(\d{1,3})%/i),mc=text.match(/Cb\s*(\d{1,3})%/i);
      if(!mt||!mc)continue;
      const t=clamp(Number(mt[1]),0,100),c=clamp(Number(mc[1]),0,100),max=Math.max(t,c);
      card.classList.remove('conv-risk-low','conv-risk-mid','conv-risk-high');card.classList.add('conv-risk-'+riskName(max));
      if(!el.querySelector('.conv-prob'))el.innerHTML=`<span class="conv-prob ${riskName(t)}">TCu ${Math.round(t)}%</span><span class="conv-sep"> · </span><span class="conv-prob ${riskName(c)}">Cb ${Math.round(c)}%</span>`;
    }
  }
  function installProbabilityObserver(card){
    if(card.dataset.probObserver==='1')return;card.dataset.probObserver='1';
    const obs=new MutationObserver(()=>requestAnimationFrame(paintProbabilityUi));obs.observe(card,{subtree:true,childList:true,characterData:true});
  }

  function renderScope(){
    const grid=$('convScopeGrid');if(!grid)return;const p=currentPoint();
    const lfl=window.PrognozaEPIRLightningFeatures;
    const lflStatus=lfl?.status==='ok'?'aktywne':'brak/nieświeże';
    grid.innerHTML=`
      <div><strong>CMAX / CAPPI:</strong> dokładnie wybrany punkt ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
      <div><strong>Ruch i trend POLRAD:</strong> promień ${POLRAD_SCOPE_KM} km, siatka ${POLRAD_STEP_KM} km, do ${POLRAD_FRAMES} klatek</div>
      <div><strong>NWP:</strong> wartości dla wybranego punktu (CAPE, LI, CIN, TS, opad, porywy)</div>
      <div><strong>LFL → korekta Cb:</strong> EPIR 20 / 40 / 80 / 150 km (${lflStatus}); mapa punktów: Europa</div>`;
  }

  const priors=()=>({...DEFAULT_PRIORS,...(skill?.reflectivity_priors_dbz||{})});
  function historicalBin(score){
    const bins=skill?.calibration?.environment_score_bins;if(!Array.isArray(bins))return null;
    return bins.find(b=>score>=Number(b.min)&&(score<Number(b.max)||Number(b.max)>=1))||bins.at(-1)||null;
  }
  function environment(){
    const cape=asNumber('cape'),li=asNumber('li'),cin=asNumber('cin'),tp=asNumber('gfsStorm'),rain=asNumber('rain'),gust=asNumber('gust');
    const capeN=clamp((cape||0)/1800),liN=li==null?0:clamp((-li-.5)/5.5),cinAbs=cin==null?120:Math.abs(cin),cinRelease=clamp((140-cinAbs)/140),tpN=clamp((tp||0)/100),rainN=clamp((rain||0)/4),gustN=clamp(((gust||0)-7)/14);
    return{score:clamp(.30*capeN+.18*liN+.14*cinRelease+.25*tpN+.08*rainN+.05*gustN),cape,li,cin,tp,rain,gust};
  }
  function radarEvidence(dbz,type,p){
    if(!Number.isFinite(dbz))return 0;
    if(type==='tcu'){
      if(dbz<p.cu_signal)return 0;if(dbz<p.tcu_watch)return .18+.22*(dbz-p.cu_signal)/(p.tcu_watch-p.cu_signal);
      if(dbz<p.tcu_likely)return .48+.18*(dbz-p.tcu_watch)/(p.tcu_likely-p.tcu_watch);
      if(dbz<p.cb_likely)return .72+.13*(dbz-p.tcu_likely)/(p.cb_likely-p.tcu_likely);return .94;
    }
    if(dbz<p.tcu_watch)return 0;if(dbz<p.tcu_likely)return .06+.08*(dbz-p.tcu_watch)/(p.tcu_likely-p.tcu_watch);
    if(dbz<p.cb_likely)return .18+.15*(dbz-p.tcu_likely)/(p.cb_likely-p.tcu_likely);
    if(dbz<p.cb_strong)return .58+.22*(dbz-p.cb_likely)/(p.cb_strong-p.cb_likely);return .94;
  }
  function archivePriors(envScore){
    const bin=historicalBin(envScore),training=skill?.training||{},min=Number(skill?.calibration?.minimum_explicit_labels_for_direct_use||10);
    const enough=(Number(training.explicit_tcu)||0)+(Number(training.explicit_cb)||0)>=min,deep=Number(bin?.deep_rate??skill?.calibration?.global_deep_rate);
    let tcu=Number(bin?.tcu_or_cb_rate??skill?.calibration?.global_tcu_or_cb_rate),cb=Number(bin?.cb_rate??skill?.calibration?.global_cb_rate);
    if(!Number.isFinite(tcu)||(!enough&&tcu<=0))tcu=Number.isFinite(deep)?deep*.70:.06;
    if(!Number.isFinite(cb)||(!enough&&cb<=0))cb=Number.isFinite(deep)?deep*.55:.03;
    return{tcu:clamp(tcu),cb:clamp(cb),deep:Number.isFinite(deep)?clamp(deep):null};
  }
  function probabilities(dbz,env,trendRate,source='cmax',horizon=0){
    const p=priors(),hist=archivePriors(env.score),sourceFactor=source==='cmax'?1:.55;
    const radarT=radarEvidence(dbz,'tcu',p)*sourceFactor,radarC=radarEvidence(dbz,'cb',p)*sourceFactor;
    const trend=Number.isFinite(trendRate)?clamp(trendRate/20,-.18,.22):0,horizonDecay=Math.exp(-Math.max(0,horizon)/300);
    const envT=clamp(.08+env.score*.58+hist.tcu*.42),envC=clamp(.03+env.score*.46+hist.cb*.44+(hist.deep||0)*.16);
    let tcu=1-(1-envT*.72)*(1-radarT*.82*horizonDecay),cb=1-(1-envC*.62)*(1-radarC*.88*horizonDecay);
    tcu=clamp(tcu+trend*.30);cb=clamp(cb+trend*.22);
    if(source==='cmax'&&Number.isFinite(dbz)){
      if(dbz>=p.tcu_likely)tcu=Math.max(tcu,.64);if(dbz>=p.cb_likely)cb=Math.max(cb,.54);if(dbz>=p.cb_strong)cb=Math.max(cb,.84);
    }
    return{tcu:clamp(tcu)*100,cb:clamp(cb)*100};
  }
  function pointDbz(nowcast){
    const dom=asNumber('dbz');if(Number.isFinite(dom))return dom;
    if(nowcast?.source==='cmax'&&Number.isFinite(Number(nowcast?.predictions?.[30])))return Number(nowcast.predictions[30]);
    return null;
  }
  function futureDbz(nowcast,h,current){
    if(nowcast?.source==='cmax'){const x=Number(nowcast?.predictions?.[h]);if(Number.isFinite(x))return x;}
    return Number.isFinite(current)?current:null;
  }
  function classify(dbz,probs,source){
    const p=priors();if(probs.cb>=75||(source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cb_strong))return'Cb';
    if(probs.cb>=50&&source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cb_likely)return'Cb?';
    if(probs.tcu>=62||(source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.tcu_likely))return'TCu';
    if(probs.tcu>=38||(source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cu_signal))return'Cu → TCu?';return'brak sygnału';
  }
  function etaText(nowcast,horizons){
    const direct=Number(nowcast?.etaMin);if(Number.isFinite(direct)&&direct>=0&&direct<=180)return direct<8?{main:'teraz',sub:'echo w bezpośrednim podejściu'}:{main:`~${Math.round(direct)} min`,sub:'ETA najbliższego echa POLRAD'};
    const cb=horizons.find(x=>x.cb>=55);if(cb)return{main:`~${cb.h} min`,sub:'pierwszy horyzont z Cb ≥55%'};
    const tcu=horizons.find(x=>x.tcu>=55);if(tcu)return{main:`~${tcu.h} min`,sub:'pierwszy horyzont z TCu ≥55%'};
    return{main:'>3 h / brak',sub:'brak istotnego sygnału w 0–3 h'};
  }
  function calibrationText(){
    const t=skill?.training;if(!t)return'Kalibracja historyczna: brak sekcji convection — używane są konserwatywne priory radarowe i bieżące NWP.';
    return`Kalibracja historyczna EPIR: ${Number(t.matched_samples||0).toLocaleString('pl-PL')} dopasowań model–METAR, TCU ${t.explicit_tcu||0}, CB ${t.explicit_cb||0}, TS ${t.ts||0}; ${t.from?String(t.from).slice(0,10):'—'} → ${t.to?String(t.to).slice(0,10):'—'}.`;
  }

  function render(nowcast=window.PrognozaEPIRRadarNowcast||null){
    if(!ensureCard())return;renderScope();
    const env=environment(),dbz=pointDbz(nowcast),trendRate=Number(nowcast?.trend?.rate),source=nowcast?.source||'cmax';
    const nowP=probabilities(dbz,env,trendRate,source,0),klass=classify(dbz,nowP,source);
    const horizons=HORIZONS.map(h=>{const z=futureDbz(nowcast,h,dbz),p=probabilities(z,env,trendRate,source,h);return{h,dbz:z,...p};}),eta=etaText(nowcast,horizons);
    $('convClass').textContent=klass;$('convClassSub').textContent=klass==='Cb'?'silny sygnał głębokiej konwekcji':klass.includes('TCu')?'rozwój pionowy prawdopodobny':'klasyfikacja probabilistyczna';
    $('convTcu').textContent=fmtPct(nowP.tcu);$('convCb').textContent=fmtPct(nowP.cb);$('convTcuSub').textContent='POLRAD + NWP + historia';$('convCbSub').textContent='POLRAD + NWP + historia';
    $('convEta').textContent=eta.main;$('convEtaSub').textContent=eta.sub;
    $('convDbz').textContent=Number.isFinite(dbz)?`~${Math.round(dbz)} dBZ`:(source==='sri'?'SRI':'brak');$('convDbzSub').textContent=source==='cmax'?'CMAX w punkcie + adwekcja z 160 km':'fallback SRI — mniejsza pewność klasy';
    $('convTrend').textContent=Number.isFinite(trendRate)?`${trendRate>=0?'+':''}${trendRate.toFixed(1)} dBZ/h`:(nowcast?.trend?.label||'—');$('convTrendSub').textContent=`${nowcast?.trend?.label||'historia klatek'} · analizowany obszar 160 km`;
    $('convEnv').textContent=fmtPct(env.score*100);$('convEnvSub').textContent=`CAPE ${env.cape??'—'} · LI ${env.li??'—'} · CIN ${env.cin??'—'} · GFS TS ${env.tp??'—'}%`;
    for(const x of horizons){const e=$(`convH${x.h}`);if(e)e.textContent=`TCu ${Math.round(x.tcu)}% · Cb ${Math.round(x.cb)}%`;}
    const p=priors(),strong=source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cb_likely;
    const trendSentence=Number.isFinite(trendRate)?(trendRate>4?'Echo wyraźnie się nasila.':trendRate<-4?'Echo słabnie.':'Intensywność echa jest względnie stabilna.'):'Trend radarowy jest niepełny.';
    $('convSummary').textContent=`Aktualna ocena: ${klass}; TCu ${Math.round(nowP.tcu)}%, Cb ${Math.round(nowP.cb)}% (${riskLabel(Math.max(nowP.tcu,nowP.cb))}). ${strong?'CMAX przekracza próg operacyjny dla prawdopodobnego Cb. ':''}${trendSentence} ${eta.main!=='>3 h / brak'?`Najbliższy istotny sygnał: ${eta.main}.`:'W horyzoncie 0–3 h brak wyraźnego wejścia silnej komórki nad punkt.'}`;
    $('convCalibration').textContent=calibrationText();
    $('convThresholds').innerHTML='<span>20–29 dBZ: Cu/TCu watch</span><span>30–34 dBZ: TCu możliwe</span><span>35–39 dBZ: TCu prawdopodobne</span><span>40–49 dBZ: Cb prawdopodobne</span><span>≥50 dBZ: silny Cb</span>';
    const detail={updatedAt:new Date().toISOString(),class:klass,tcuProbability:nowP.tcu,cbProbability:nowP.cb,baseCbProbability:nowP.cb,dbz,source,trendRate,environmentScore:env.score,eta,horizons,calibration:skill?.training||null,scope:{polradRadiusKm:POLRAD_SCOPE_KM,gridStepKm:POLRAD_STEP_KM,frames:POLRAD_FRAMES,lflRadiiKm:[20,40,80,150]},diagnostics:{...diagnostics}};
    window.PrognozaEPIRConvectionNowcast=detail;paintProbabilityUi();window.dispatchEvent(new CustomEvent('prognozaepir:convection-nowcast-updated',{detail}));
  }

  function normalizeRadarUrl(u){
    const s=String(u||'').trim();if(!s)return null;if(/^https?:\/\//i.test(s))return s.replace(/^http:\/\//i,'https://');
    try{return new URL(s,'https://meteo.imgw.pl/').href;}catch(_){return null;}
  }
  function mercY(lat){const p=Math.max(-85,Math.min(85,lat))*Math.PI/180;return Math.log(Math.tan(Math.PI/4+p/2));}
  const MY_N=mercY(POLRAD_BOUNDS.north),MY_S=mercY(POLRAD_BOUNDS.south);
  function pixelFor(r,p){
    return{x:(p.lon-POLRAD_BOUNDS.west)/(POLRAD_BOUNDS.east-POLRAD_BOUNDS.west)*r.width,y:(MY_N-mercY(p.lat))/(MY_N-MY_S)*r.height};
  }
  function nearestPaletteDbz(r,g,b,a){
    if(a<50)return null;let best=null,bestD=Infinity;
    for(const [z,pr,pg,pb] of DBZ_PALETTE){const d=(r-pr)**2+(g-pg)**2+(b-pb)**2;if(d<bestD){bestD=d;best=z;}}
    return bestD<=5200?best:null;
  }
  function loadRaster(url){
    return new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';const timer=setTimeout(()=>{img.src='';reject(new Error('timeout obrazu'));},8500);img.onload=()=>{clearTimeout(timer);try{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);resolve({width:c.width,height:c.height,rgba:ctx.getImageData(0,0,c.width,c.height).data});}catch(e){reject(e);}};img.onerror=()=>{clearTimeout(timer);reject(new Error('błąd obrazu'));};img.src=url+(url.includes('?')?'&':'?')+'_conv='+Date.now();});
  }
  function sampleDbz(r,p){
    const q=pixelFor(r,p),cx=Math.round(q.x),cy=Math.round(q.y),vals=[];
    for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){const px=cx+x,py=cy+y;if(px<0||py<0||px>=r.width||py>=r.height)continue;const i=(py*r.width+px)*4,v=nearestPaletteDbz(r.rgba[i],r.rgba[i+1],r.rgba[i+2],r.rgba[i+3]);if(Number.isFinite(v))vals.push(v);}
    return vals.length?Math.max(...vals):null;
  }
  async function loadCappi(){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),9000);
    try{
      const r=await fetch(CAPPI_API,{cache:'no-cache',signal:ctl.signal});if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();
      const rows=j?.cappi?.list;if(!Array.isArray(rows)||!rows.length)throw new Error('brak klatek CAPPI');
      const frame=rows.filter(x=>x?.url&&Number.isFinite(Number(x?.date))).sort((a,b)=>Number(a.date)-Number(b.date)).at(-1);if(!frame)throw new Error('brak aktualnej CAPPI');
      const url=normalizeRadarUrl(frame.url);if(!url)throw new Error('brak URL CAPPI');const raster=await loadRaster(url),p=currentPoint(),value=sampleDbz(raster,p);
      diagnostics.cappi={ok:true,valueDbz:value,time:Number(frame.date),point:p};
      const main=$('convCappi'),sub=$('convCappiSub'),cmax=asNumber('convDbz');if(main)main.textContent=Number.isFinite(value)?`~${Math.round(value)} dBZ`:'brak echa';
      let relation='CAPPI 1 km · punkt';if(Number.isFinite(value)&&Number.isFinite(cmax)){const d=cmax-value;relation+=` · CMAX−CAPPI ${d>=0?'+':''}${Math.round(d)} dB`;}
      if(sub)sub.textContent=`${relation} · ${fmtLocal(frame.date)} · diagnostycznie`;
    }finally{clearTimeout(timer);}
  }

  function irUrl(p,time=null){
    const d=.05,params=new URLSearchParams({service:'WMS',version:'1.1.1',request:'GetFeatureInfo',layers:'mtg_fd:ir105_hrfi',query_layers:'mtg_fd:ir105_hrfi',styles:'',srs:'EPSG:4326',bbox:`${(p.lon-d).toFixed(4)},${(p.lat-d).toFixed(4)},${(p.lon+d).toFixed(4)},${(p.lat+d).toFixed(4)}`,width:'101',height:'101',x:'50',y:'50',info_format:'application/json'});
    if(time)params.set('time',time);return EUMET_WMS+'?'+params.toString();
  }
  function extractIrTemp(j){
    const props=j?.features?.[0]?.properties;if(!props||typeof props!=='object')return null;
    const vals=[];for(const [k,v] of Object.entries(props)){const n=Number(v);if(Number.isFinite(n))vals.push([k,n]);}
    const preferred=vals.sort((a,b)=>/temp|bright|value|gray|band/i.test(a[0])?-1:/temp|bright|value|gray|band/i.test(b[0])?1:0);
    for(const [,n] of preferred){if(n>=150&&n<=350)return n-273.15;if(n>=-120&&n<=80)return n;}
    return null;
  }
  async function fetchIrAt(p,time=null){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),7000);try{const r=await fetch(irUrl(p,time),{cache:'no-store',signal:ctl.signal});if(!r.ok)throw new Error('HTTP '+r.status);return extractIrTemp(await r.json());}finally{clearTimeout(timer);}
  }
  function isoRounded10(minutesAgo=0){
    const d=new Date(Date.now()-minutesAgo*60000);d.setUTCSeconds(0,0);d.setUTCMinutes(Math.floor(d.getUTCMinutes()/10)*10);return d.toISOString();
  }
  async function loadIr(){
    const p=currentPoint();let current=null,previous=null,previousAge=10;
    try{current=await fetchIrAt(p,null);}catch(_){}
    for(const age of[10,20]){try{const v=await fetchIrAt(p,isoRounded10(age));if(Number.isFinite(v)){previous=v;previousAge=age;break;}}catch(_){} }
    const main=$('convIr'),sub=$('convIrSub');
    if(!Number.isFinite(current)){
      diagnostics.ir={ok:false,reason:'brak wartości fizycznej GetFeatureInfo'};if(main)main.textContent='brak danych';if(sub)sub.textContent='MTG IR10.5 GetFeatureInfo niedostępne · diagnostycznie';return;
    }
    const rate=Number.isFinite(previous)?(current-previous)*(10/previousAge):null;diagnostics.ir={ok:true,tempC:current,previousC:previous,coolingCPer10Min:rate,point:p};
    if(main)main.textContent=`${current.toFixed(0)}°C`;
    if(sub)sub.textContent=Number.isFinite(rate)?`zmiana ${rate>=0?'+':''}${rate.toFixed(1)}°C / 10 min ${rate<=-3?'· szybkie chłodzenie':''} · diagnostycznie`:'temperatura wierzchołka · trend chwilowo niedostępny';
  }
  async function refreshDiagnostics(force=false){
    if(diagBusy||(!force&&Date.now()-diagLast<4*60*1000))return;diagBusy=true;diagLast=Date.now();
    try{await Promise.allSettled([loadCappi(),loadIr()]);window.PrognozaEPIRConvectionDiagnostics={...diagnostics};renderScope();}finally{diagBusy=false;}
  }

  async function loadSkill(){
    try{
      const r=await fetch('data/learning/cloud-skill.json?conv='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();skill=j?.convection||null;
    }catch(e){console.warn('Convection skill:',e?.message||e);skill=null;}
    render();
  }
  function scheduleRender(delay=50){clearTimeout(renderTimer);renderTimer=setTimeout(()=>render(),delay);}

  ensureCard();loadSkill();setTimeout(()=>{render();refreshDiagnostics(true);},1000);
  window.addEventListener('prognozaepir:radar-nowcast-updated',e=>{render(e.detail);refreshDiagnostics(false);});
  window.addEventListener('prognozaepir:lightning-features-updated',()=>{renderScope();setTimeout(paintProbabilityUi,50);});
  for(const id of['apply','resetPoint'])$(id)?.addEventListener('click',()=>setTimeout(()=>{scheduleRender(50);refreshDiagnostics(true);},450));
  $('refresh')?.addEventListener('click',()=>setTimeout(()=>{scheduleRender(50);refreshDiagnostics(true);},350));
  setInterval(()=>{if(!document.hidden){render();refreshDiagnostics(false);}},5*60*1000);
})();
