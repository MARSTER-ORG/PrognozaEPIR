'use strict';

// Convert IMGW TERYT county codes into readable warning areas.
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
    for(const raw of Array.isArray(warning?.teryt)?warning.teryt:[]){const code=String(raw).padStart(4,'0'),prefix=code.slice(0,2);counts.set(prefix,(counts.get(prefix)||0)+1)}
    const parts=[...counts.entries()].map(([prefix,count])=>`${VOIVODESHIPS[prefix]||`woj. ${prefix}`} — ${count} ${countyWord(count)}`);
    return parts.length?parts.join('; '):'obszar nieopisany w odpowiedzi IMGW';
  };
  if(!el('warnReadableStyle')){const style=document.createElement('style');style.id='warnReadableStyle';style.textContent='.warn-area{margin:4px 0 3px;line-height:1.45}.warn-area b,.warn-time b{color:var(--muted)}.warn-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:3px;color:var(--muted)}';document.head.appendChild(style)}
  window.loadWarnings=async function loadWarningsReadable(){
    try{
      const response=await fetch('https://danepubliczne.imgw.pl/api/data/warningsmeteo',{cache:'no-cache'});if(!response.ok)throw new Error('HTTP '+response.status);
      const warnings=await response.json(),dot=el('srcImgw'),box=el('warnings');if(dot)dot.className='dot ok';if(!box)return;
      if(!Array.isArray(warnings)||!warnings.length){box.textContent='Brak aktywnych ostrzeżeń w odpowiedzi API IMGW.';return}
      const nearDefault=typeof point!=='undefined'&&typeof DEFAULT!=='undefined'&&Math.hypot(point.lat-DEFAULT.lat,point.lon-DEFAULT.lon)<.01;
      let list=warnings;
      if(nearDefault){list=warnings.filter(w=>Array.isArray(w?.teryt)&&w.teryt.some(code=>String(code).padStart(4,'0').startsWith('04')));if(!list.length){box.innerHTML='Brak aktywnych ostrzeżeń dla woj. kujawsko-pomorskiego. <span style="color:var(--muted)">API IMGW jest aktywne.</span>';return}}
      list=list.slice().sort((a,b)=>Number(b.stopien||0)-Number(a.stopien||0)).slice(0,6);
      box.innerHTML=list.map(w=>{const event=esc(w.nazwa_zdarzenia||w.zdarzenie||w.event||w.nazwa||'Ostrzeżenie meteorologiczne'),level=esc(w.stopien||w.stopien_zagrozenia||w.level||''),probability=esc(w.prawdopodobienstwo||''),area=esc(areaLabel(w)),from=esc(fmtDate(w.obowiazuje_od||w.od||w.start)),to=esc(fmtDate(w.obowiazuje_do||w.do||w.end));return `<div class="warn"><strong>${event}${level?' · stopień '+level:''}</strong><div class="warn-area"><b>Obszar:</b> ${area}</div><div class="warn-meta">${probability?`<span><b>Prawdopodobieństwo:</b> ${probability}%</span>`:''}<span class="warn-time"><b>Ważne:</b> ${from} → ${to}</span></div></div>`}).join('');
    }catch(_){const dot=el('srcImgw'),box=el('warnings');if(dot)dot.className='dot bad';if(box)box.textContent='Nie udało się pobrać ostrzeżeń IMGW.'}
  };
  window.loadWarnings();
})();

// TCu / Cb convection nowcast: POLRAD + NWP + historical EPIR calibration.
(() => {
  const $c=id=>document.getElementById(id);
  const clampC=(v,a=0,b=1)=>Math.max(a,Math.min(b,Number(v)||0));
  const asNumber=id=>{const e=$c(id);if(!e)return null;const m=String(e.textContent||'').replace(',','.').match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null};
  const fmtPct=v=>`${Math.round(clampC(v,0,99))}%`;
  const HORIZONS=[30,60,90,120,180];
  const DEFAULT_PRIORS={cu_signal:20,tcu_watch:30,tcu_likely:35,cb_likely:40,cb_strong:50};
  let skill=null,renderTimer=null;

  if(!$c('convectionNowcastStyle')){const style=document.createElement('style');style.id='convectionNowcastStyle';style.textContent=`.conv-wrap{padding:9px 10px;font-size:10px;line-height:1.4}.conv-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.conv-tile{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:62px}.conv-tile small{display:block;color:var(--muted);font-size:8.5px;margin-bottom:3px}.conv-tile b{display:block;font-size:15px;line-height:1.15}.conv-tile span{display:block;color:var(--muted);font-size:8px;margin-top:3px}.conv-tile.tcu{border-left-color:var(--orange)}.conv-tile.cb{border-left-color:var(--violet)}.conv-h{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;margin:7px 0}.conv-h>div{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px;text-align:center}.conv-h span{display:block;color:var(--muted);font-size:8px}.conv-h b{display:block;font-size:10px}.conv-summary,.conv-cal{border:1px solid var(--line);background:var(--panel2);border-radius:7px;padding:7px;margin-top:6px}.conv-thresholds{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.conv-thresholds span{border:1px solid var(--line);border-radius:999px;padding:3px 6px;font-size:8px}.conv-foot{color:var(--muted);font-size:8.5px;margin-top:6px}@media(max-width:700px){.conv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.conv-h{grid-template-columns:repeat(5,minmax(70px,1fr));overflow:auto}}`;document.head.appendChild(style)}

  function ensureCard(){
    let card=$c('convectionNowcastCard');if(card)return card;const left=document.querySelector('.layout > div:first-child');if(!left)return null;
    card=document.createElement('section');card.id='convectionNowcastCard';card.className='card';card.style.marginTop='8px';
    card.innerHTML=`<h2>Konwekcja TCu / Cb · nowcast 0–3 h</h2><div class="conv-wrap"><div class="conv-grid">
      <div class="conv-tile"><small>Klasa aktualna</small><b id="convClass">—</b><span id="convClassSub">POLRAD + środowisko</span></div>
      <div class="conv-tile tcu"><small>TCu</small><b id="convTcu">—</b><span id="convTcuSub">prawdopodobieństwo</span></div>
      <div class="conv-tile cb"><small>Cb</small><b id="convCb">—</b><span id="convCbSub">prawdopodobieństwo</span></div>
      <div class="conv-tile"><small>Czas / ETA</small><b id="convEta">—</b><span id="convEtaSub">pierwszy istotny sygnał</span></div>
      <div class="conv-tile"><small>CMAX / punkt</small><b id="convDbz">—</b><span id="convDbzSub">POLRAD</span></div>
      <div class="conv-tile"><small>Trend rozwoju</small><b id="convTrend">—</b><span id="convTrendSub">zmiana dBZ / h</span></div>
      <div class="conv-tile"><small>Środowisko</small><b id="convEnv">—</b><span id="convEnvSub">CAPE / LI / CIN / GFS</span></div>
      <div class="conv-tile"><small>Źródła klasyfikacji</small><b>POLRAD + NWP</b><span>bez LI AFA</span></div>
    </div><div class="conv-h">${HORIZONS.map(h=>`<div><span>+${h} min</span><b id="convH${h}">—</b></div>`).join('')}</div><div class="conv-summary" id="convSummary">Oczekiwanie na wynik POLRAD…</div><div class="conv-cal" id="convCalibration">Kalibracja historyczna: ładowanie…</div><div class="conv-thresholds" id="convThresholds"></div><div class="conv-foot">TCu może pojawić się przed wyraźnym echem radarowym. CMAX jest tylko jednym z sygnałów i nie identyfikuje rodzaju chmury samodzielnie.</div></div>`;
    const rn=$c('radarNowcastCard');if(rn&&rn.parentElement===left)rn.insertAdjacentElement('afterend',card);else left.appendChild(card);return card;
  }

  const priors=()=>({...DEFAULT_PRIORS,...(skill?.reflectivity_priors_dbz||{})});
  function historicalBin(score){const bins=skill?.calibration?.environment_score_bins;if(!Array.isArray(bins))return null;return bins.find(b=>score>=Number(b.min)&&(score<Number(b.max)||Number(b.max)>=1))||bins.at(-1)||null}
  function environment(){
    const cape=asNumber('cape'),li=asNumber('li'),cin=asNumber('cin'),tp=asNumber('gfsStorm'),rain=asNumber('rain'),gust=asNumber('gust');
    const capeN=clampC((cape||0)/1800),liN=li==null?0:clampC((-li-.5)/5.5),cinAbs=cin==null?120:Math.abs(cin),cinRelease=clampC((140-cinAbs)/140),tpN=clampC((tp||0)/100),rainN=clampC((rain||0)/4),gustN=clampC(((gust||0)-7)/14);
    return{score:clampC(.30*capeN+.18*liN+.14*cinRelease+.25*tpN+.08*rainN+.05*gustN),cape,li,cin,tp,rain,gust};
  }
  function radarEvidence(dbz,type,p){
    if(!Number.isFinite(dbz))return 0;
    if(type==='tcu'){if(dbz<p.cu_signal)return 0;if(dbz<p.tcu_watch)return .18+.22*(dbz-p.cu_signal)/(p.tcu_watch-p.cu_signal);if(dbz<p.tcu_likely)return .48+.18*(dbz-p.tcu_watch)/(p.tcu_likely-p.tcu_watch);if(dbz<p.cb_likely)return .72+.13*(dbz-p.tcu_likely)/(p.cb_likely-p.tcu_likely);return .94}
    if(dbz<p.tcu_watch)return 0;if(dbz<p.tcu_likely)return .06+.08*(dbz-p.tcu_watch)/(p.tcu_likely-p.tcu_watch);if(dbz<p.cb_likely)return .18+.15*(dbz-p.tcu_likely)/(p.cb_likely-p.tcu_likely);if(dbz<p.cb_strong)return .58+.22*(dbz-p.cb_likely)/(p.cb_strong-p.cb_likely);return .94;
  }
  function archivePriors(envScore){
    const bin=historicalBin(envScore),training=skill?.training||{},enoughExplicit=(Number(training.explicit_tcu)||0)+(Number(training.explicit_cb)||0)>=Number(skill?.calibration?.minimum_explicit_labels_for_direct_use||10),deep=Number(bin?.deep_rate??skill?.calibration?.global_deep_rate);
    let tcu=Number(bin?.tcu_or_cb_rate??skill?.calibration?.global_tcu_or_cb_rate),cb=Number(bin?.cb_rate??skill?.calibration?.global_cb_rate);
    if(!Number.isFinite(tcu)||(!enoughExplicit&&tcu<=0))tcu=Number.isFinite(deep)?deep*.70:.06;if(!Number.isFinite(cb)||(!enoughExplicit&&cb<=0))cb=Number.isFinite(deep)?deep*.55:.03;
    return{tcu:clampC(tcu),cb:clampC(cb),deep:Number.isFinite(deep)?clampC(deep):null};
  }
  function probabilities(dbz,env,trendRate,source='cmax',horizon=0){
    const p=priors(),hist=archivePriors(env.score),sourceFactor=source==='cmax'?1:.55,radarT=radarEvidence(dbz,'tcu',p)*sourceFactor,radarC=radarEvidence(dbz,'cb',p)*sourceFactor,trend=Number.isFinite(trendRate)?clampC(trendRate/20,-.18,.22):0,horizonDecay=Math.exp(-Math.max(0,horizon)/300),envT=clampC(.08+env.score*.58+hist.tcu*.42),envC=clampC(.03+env.score*.46+hist.cb*.44+(hist.deep||0)*.16);
    let tcu=1-(1-envT*.72)*(1-radarT*.82*horizonDecay),cb=1-(1-envC*.62)*(1-radarC*.88*horizonDecay);tcu=clampC(tcu+trend*.30);cb=clampC(cb+trend*.22);
    if(source==='cmax'&&Number.isFinite(dbz)){if(dbz>=p.tcu_likely)tcu=Math.max(tcu,.64);if(dbz>=p.cb_likely)cb=Math.max(cb,.54);if(dbz>=p.cb_strong)cb=Math.max(cb,.84)}
    return{tcu:clampC(tcu)*100,cb:clampC(cb)*100};
  }
  function pointDbz(nowcast){const dom=asNumber('dbz');if(Number.isFinite(dom))return dom;if(nowcast?.source==='cmax'&&Number.isFinite(Number(nowcast?.predictions?.[30])))return Number(nowcast.predictions[30]);return null}
  function futureDbz(nowcast,h,current){if(nowcast?.source==='cmax'){const x=Number(nowcast?.predictions?.[h]);if(Number.isFinite(x))return x}return Number.isFinite(current)?current:null}
  function classify(dbz,probs,source){const p=priors();if(probs.cb>=70||(source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cb_strong))return'Cb';if(probs.cb>=50&&source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cb_likely)return'Cb?';if(probs.tcu>=62||(source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.tcu_likely))return'TCu';if(probs.tcu>=38||(source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cu_signal))return'Cu → TCu?';return'brak sygnału'}
  function etaText(nowcast,horizons){const direct=Number(nowcast?.etaMin);if(Number.isFinite(direct)&&direct>=0&&direct<=180)return direct<8?{main:'teraz',sub:'echo w bezpośrednim podejściu'}:{main:`~${Math.round(direct)} min`,sub:'ETA najbliższego echa POLRAD'};const cb=horizons.find(x=>x.cb>=55);if(cb)return{main:`~${cb.h} min`,sub:'pierwszy horyzont z sygnałem Cb ≥55%'};const tcu=horizons.find(x=>x.tcu>=55);if(tcu)return{main:`~${tcu.h} min`,sub:'pierwszy horyzont z sygnałem TCu ≥55%'};return{main:'>3 h / brak',sub:'brak istotnego sygnału w 0–3 h'}}
  function calibrationText(){const t=skill?.training;if(!t)return'Kalibracja historyczna: brak sekcji convection — używane są konserwatywne priory radarowe i bieżące NWP.';return`Kalibracja historyczna EPIR: ${Number(t.matched_samples||0).toLocaleString('pl-PL')} dopasowań model–METAR, TCU ${t.explicit_tcu||0}, CB ${t.explicit_cb||0}, TS ${t.ts||0}; ${t.from?String(t.from).slice(0,10):'—'} → ${t.to?String(t.to).slice(0,10):'—'}. Jakość etykiet: ${t.label_quality||'—'}.`}

  function render(nowcast=window.PrognozaEPIRRadarNowcast||null){
    if(!ensureCard())return;const env=environment(),dbz=pointDbz(nowcast),trendRate=Number(nowcast?.trend?.rate),source=nowcast?.source||'cmax',nowP=probabilities(dbz,env,trendRate,source,0),klass=classify(dbz,nowP,source),horizons=HORIZONS.map(h=>{const z=futureDbz(nowcast,h,dbz),p=probabilities(z,env,trendRate,source,h);return{h,dbz:z,...p}}),eta=etaText(nowcast,horizons);
    $c('convClass').textContent=klass;$c('convClassSub').textContent=klass==='Cb'?'silny sygnał głębokiej konwekcji':klass.includes('TCu')?'rozwój pionowy prawdopodobny':'klasyfikacja probabilistyczna';$c('convTcu').textContent=fmtPct(nowP.tcu);$c('convCb').textContent=fmtPct(nowP.cb);$c('convTcuSub').textContent='POLRAD + NWP + historia';$c('convCbSub').textContent='POLRAD + NWP + historia';$c('convEta').textContent=eta.main;$c('convEtaSub').textContent=eta.sub;$c('convDbz').textContent=Number.isFinite(dbz)?`~${Math.round(dbz)} dBZ`:(source==='sri'?'SRI':'brak');$c('convDbzSub').textContent=source==='cmax'?'CMAX/punkt + adwekcja POLRAD':'fallback SRI — mniejsza pewność klasy';$c('convTrend').textContent=Number.isFinite(trendRate)?`${trendRate>=0?'+':''}${trendRate.toFixed(1)} dBZ/h`:(nowcast?.trend?.label||'—');$c('convTrendSub').textContent=nowcast?.trend?.label||'historia ostatnich klatek';$c('convEnv').textContent=fmtPct(env.score*100);$c('convEnvSub').textContent=`CAPE ${env.cape??'—'} · LI ${env.li??'—'} · CIN ${env.cin??'—'} · GFS TS ${env.tp??'—'}%`;
    for(const x of horizons){const e=$c(`convH${x.h}`);if(e)e.textContent=`TCu ${Math.round(x.tcu)}% · Cb ${Math.round(x.cb)}%`}
    const p=priors(),strong=source==='cmax'&&Number.isFinite(dbz)&&dbz>=p.cb_likely,trendSentence=Number.isFinite(trendRate)?(trendRate>4?'Echo wyraźnie się nasila.':trendRate<-4?'Echo słabnie.':'Intensywność echa jest względnie stabilna.'):'Trend radarowy jest niepełny.';
    $c('convSummary').textContent=`Aktualna ocena: ${klass}; TCu ${Math.round(nowP.tcu)}%, Cb ${Math.round(nowP.cb)}%. ${strong?'CMAX przekracza próg operacyjny dla prawdopodobnego Cb. ':''}${trendSentence} ${eta.main!=='>3 h / brak'?`Najbliższy istotny sygnał: ${eta.main}.`:'W horyzoncie 0–3 h brak wyraźnego wejścia silnej komórki nad punkt.'}`;
    $c('convCalibration').textContent=calibrationText();$c('convThresholds').innerHTML='<span>20–29 dBZ: Cu/TCu watch</span><span>30–34 dBZ: TCu możliwe</span><span>35–39 dBZ: TCu prawdopodobne</span><span>40–49 dBZ: Cb prawdopodobne</span><span>≥50 dBZ: silny Cb</span>';
    window.PrognozaEPIRConvectionNowcast={updatedAt:new Date().toISOString(),class:klass,tcuProbability:nowP.tcu,cbProbability:nowP.cb,dbz,source,trendRate,environmentScore:env.score,eta,horizons,calibration:skill?.training||null};window.dispatchEvent(new CustomEvent('prognozaepir:convection-nowcast-updated',{detail:window.PrognozaEPIRConvectionNowcast}));
  }
  const scheduleRender=(ms=100)=>{clearTimeout(renderTimer);renderTimer=setTimeout(()=>render(),ms)};
  async function loadSkill(){try{const r=await fetch('data/learning/cloud-skill.json',{cache:'no-cache'});if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();skill=j?.convection||null}catch(_){skill=null}scheduleRender(20)}
  ensureCard();loadSkill();setTimeout(()=>scheduleRender(50),1800);window.addEventListener('prognozaepir:radar-nowcast-updated',e=>render(e.detail));for(const id of ['apply','resetPoint','refresh'])$c(id)?.addEventListener('click',()=>setTimeout(()=>scheduleRender(20),900));setInterval(()=>{if(!document.hidden)scheduleRender(20)},5*60*1000);
})();
