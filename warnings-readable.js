'use strict';

// Convert IMGW TERYT county codes into readable warning areas.
(() => {
  const VOIVODESHIPS = {
    '02':'dolnośląskie','04':'kujawsko-pomorskie','06':'lubelskie','08':'lubuskie',
    '10':'łódzkie','12':'małopolskie','14':'mazowieckie','16':'opolskie',
    '18':'podkarpackie','20':'podlaskie','22':'pomorskie','24':'śląskie',
    '26':'świętokrzyskie','28':'warmińsko-mazurskie','30':'wielkopolskie','32':'zachodniopomorskie'
  };

  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
  const countyWord = n => n === 1 ? 'powiat' : (
    n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'powiaty' : 'powiatów'
  );
  const fmtDate = value => {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : String(value || '—');
  };
  const areaLabel = warning => {
    const codes = Array.isArray(warning?.teryt) ? warning.teryt : [];
    const counts = new Map();
    for (const raw of codes) {
      const code = String(raw).padStart(4, '0');
      const prefix = code.slice(0, 2);
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
    const parts = [...counts.entries()].map(([prefix, count]) => {
      const name = VOIVODESHIPS[prefix] || `woj. ${prefix}`;
      return `${name} — ${count} ${countyWord(count)}`;
    });
    return parts.length ? parts.join('; ') : 'obszar nieopisany w odpowiedzi IMGW';
  };

  if (!el('warnReadableStyle')) {
    const style = document.createElement('style');
    style.id = 'warnReadableStyle';
    style.textContent = [
      '.warn-area{margin:4px 0 3px;line-height:1.45}',
      '.warn-area b,.warn-time b{color:var(--muted)}',
      '.warn-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:3px;color:var(--muted)}'
    ].join('');
    document.head.appendChild(style);
  }

  window.loadWarnings = async function loadWarningsReadable() {
    try {
      const response = await fetch('https://danepubliczne.imgw.pl/api/data/warningsmeteo', {cache:'no-cache'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const warnings = await response.json();
      const dot = el('srcImgw');
      if (dot) dot.className = 'dot ok';
      const box = el('warnings');
      if (!box) return;

      if (!Array.isArray(warnings) || !warnings.length) {
        box.textContent = 'Brak aktywnych ostrzeżeń w odpowiedzi API IMGW.';
        return;
      }

      const nearDefault = typeof point !== 'undefined' && typeof DEFAULT !== 'undefined' &&
        Math.hypot(point.lat - DEFAULT.lat, point.lon - DEFAULT.lon) < .01;
      let list = warnings;

      // Inowrocław/default point belongs to woj. kujawsko-pomorskie (TERYT prefix 04).
      if (nearDefault) {
        list = warnings.filter(w => Array.isArray(w?.teryt) &&
          w.teryt.some(code => String(code).padStart(4, '0').startsWith('04')));
        if (!list.length) {
          box.innerHTML = 'Brak aktywnych ostrzeżeń dla woj. kujawsko-pomorskiego. <span style="color:var(--muted)">API IMGW jest aktywne.</span>';
          return;
        }
      }

      list = list.slice().sort((a, b) => Number(b.stopien || 0) - Number(a.stopien || 0)).slice(0, 6);
      box.innerHTML = list.map(w => {
        const event = esc(w.nazwa_zdarzenia || w.zdarzenie || w.event || w.nazwa || 'Ostrzeżenie meteorologiczne');
        const level = esc(w.stopien || w.stopien_zagrozenia || w.level || '');
        const probability = esc(w.prawdopodobienstwo || '');
        const area = esc(areaLabel(w));
        const from = esc(fmtDate(w.obowiazuje_od || w.od || w.start));
        const to = esc(fmtDate(w.obowiazuje_do || w.do || w.end));
        return `<div class="warn"><strong>${event}${level ? ' · stopień ' + level : ''}</strong>` +
          `<div class="warn-area"><b>Obszar:</b> ${area}</div>` +
          `<div class="warn-meta">${probability ? `<span><b>Prawdopodobieństwo:</b> ${probability}%</span>` : ''}` +
          `<span class="warn-time"><b>Ważne:</b> ${from} → ${to}</span></div></div>`;
      }).join('');
    } catch (_) {
      const dot = el('srcImgw');
      if (dot) dot.className = 'dot bad';
      const box = el('warnings');
      if (box) box.textContent = 'Nie udało się pobrać ostrzeżeń IMGW.';
    }
  };

  // Re-render immediately because radar.html starts its first refresh before this extension loads.
  window.loadWarnings();
})();


// TCu / Cb convection nowcast ------------------------------------------------
// Uses the existing POLRAD motion nowcast, current NWP diagnostics and MTG LI.
// Historical calibration is loaded from data/learning/cloud-skill.json.
(() => {
  const $c = id => document.getElementById(id);
  const clampC = (v, a=0, b=1) => Math.max(a, Math.min(b, Number(v) || 0));
  const asNumber = id => {
    const el = $c(id);
    if (!el) return null;
    const m = String(el.textContent || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const fmtPct = v => `${Math.round(clampC(v, 0, 99))}%`;
  const HORIZONS = [30, 60, 90, 120, 180];
  const DEFAULT_PRIORS = {cu_signal:20,tcu_watch:30,tcu_likely:35,cb_likely:40,cb_strong:50};

  let skill = null;
  let lastLightning = {count:0, updatedAt:0, available:false};
  let runningLightning = false;
  let renderTimer = null;

  const style = document.createElement('style');
  style.id = 'convectionNowcastStyle';
  style.textContent = `
    .conv-wrap{padding:9px 10px;font-size:10px;line-height:1.4}
    .conv-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
    .conv-tile{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:62px}
    .conv-tile small{display:block;color:var(--muted);font-size:8.5px;margin-bottom:3px}
    .conv-tile b{display:block;font-size:15px;line-height:1.15}.conv-tile span{display:block;color:var(--muted);font-size:8px;margin-top:3px}
    .conv-tile.tcu{border-left-color:var(--orange)}.conv-tile.cb{border-left-color:var(--violet)}
    .conv-h{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;margin:7px 0}
    .conv-h > div{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px;text-align:center}
    .conv-h span{display:block;color:var(--muted);font-size:8px}.conv-h b{display:block;font-size:10px}
    .conv-summary,.conv-cal{border:1px solid var(--line);background:var(--panel2);border-radius:7px;padding:7px;margin-top:6px}
    .conv-thresholds{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.conv-thresholds span{border:1px solid var(--line);border-radius:999px;padding:3px 6px;font-size:8px}
    .conv-foot{color:var(--muted);font-size:8.5px;margin-top:6px}
    @media(max-width:700px){.conv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.conv-h{grid-template-columns:repeat(5,minmax(70px,1fr));overflow:auto}}
  `;
  if (!$c(style.id)) document.head.appendChild(style);

  function ensureCard() {
    let card = $c('convectionNowcastCard');
    if (card) return card;
    const left = document.querySelector('.layout > div:first-child');
    if (!left) return null;
    card = document.createElement('section');
    card.id = 'convectionNowcastCard';
    card.className = 'card';
    card.style.marginTop = '8px';
    card.innerHTML = `<h2>Konwekcja TCu / Cb · nowcast 0–3 h</h2>
      <div class="conv-wrap">
        <div class="conv-grid">
          <div class="conv-tile" id="convClassTile"><small>Klasa aktualna</small><b id="convClass">—</b><span id="convClassSub">radar + środowisko</span></div>
          <div class="conv-tile tcu"><small>TCu</small><b id="convTcu">—</b><span id="convTcuSub">prawdopodobieństwo</span></div>
          <div class="conv-tile cb"><small>Cb</small><b id="convCb">—</b><span id="convCbSub">prawdopodobieństwo</span></div>
          <div class="conv-tile"><small>Czas / ETA</small><b id="convEta">—</b><span id="convEtaSub">pierwszy istotny sygnał</span></div>
          <div class="conv-tile"><small>CMAX / punkt</small><b id="convDbz">—</b><span id="convDbzSub">odbiciowość nie identyfikuje chmury samodzielnie</span></div>
          <div class="conv-tile"><small>Trend rozwoju</small><b id="convTrend">—</b><span id="convTrendSub">zmiana dBZ / h</span></div>
          <div class="conv-tile"><small>Środowisko</small><b id="convEnv">—</b><span id="convEnvSub">CAPE / LI / CIN / GFS</span></div>
          <div class="conv-tile"><small>Wyładowania MTG LI</small><b id="convLightning">—</b><span id="convLightningSub">promień 80 km</span></div>
        </div>
        <div class="conv-h" id="convHorizons">${HORIZONS.map(h=>`<div><span>+${h} min</span><b id="convH${h}">—</b></div>`).join('')}</div>
        <div class="conv-summary" id="convSummary">Oczekiwanie na wynik POLRAD…</div>
        <div class="conv-cal" id="convCalibration">Kalibracja historyczna: ładowanie…</div>
        <div class="conv-thresholds" id="convThresholds"></div>
        <div class="conv-foot">TCu może pojawić się przed wyraźnym echem radarowym. CMAX pokazuje maksimum odbiciowości w słupie i nie jest samodzielnym rozpoznaniem rodzaju chmury.</div>
      </div>`;
    const rn = $c('radarNowcastCard');
    if (rn && rn.parentElement === left) rn.insertAdjacentElement('afterend', card);
    else {
      const ai = [...left.querySelectorAll('.card')].find(x => /Prognoza AI|Nowcast AI/.test(x.querySelector('h2')?.textContent || ''));
      if (ai) left.insertBefore(card, ai); else left.appendChild(card);
    }
    return card;
  }

  function priors() {
    return {...DEFAULT_PRIORS, ...(skill?.reflectivity_priors_dbz || {})};
  }

  function historicalBin(score) {
    const bins = skill?.calibration?.environment_score_bins;
    if (!Array.isArray(bins)) return null;
    return bins.find(b => score >= Number(b.min) && (score < Number(b.max) || Number(b.max) >= 1)) || bins.at(-1) || null;
  }

  function environment() {
    const cape = asNumber('cape');
    const li = asNumber('li');
    const cin = asNumber('cin');
    const tp = asNumber('gfsStorm');
    const rain = asNumber('rain');
    const gust = asNumber('gust');
    const capeN = clampC((cape || 0) / 1800);
    const liN = li == null ? 0 : clampC((-li - 0.5) / 5.5);
    const cinAbs = cin == null ? 120 : Math.abs(cin);
    const cinRelease = clampC((140 - cinAbs) / 140);
    const tpN = clampC((tp || 0) / 100);
    const rainN = clampC((rain || 0) / 4);
    const gustN = clampC(((gust || 0) - 7) / 14);
    const score = clampC(.30*capeN + .18*liN + .14*cinRelease + .25*tpN + .08*rainN + .05*gustN);
    return {score,cape,li,cin,tp,rain,gust};
  }

  function radarEvidence(dbz, type, p) {
    if (!Number.isFinite(dbz)) return 0;
    if (type === 'tcu') {
      if (dbz < p.cu_signal) return 0;
      if (dbz < p.tcu_watch) return .18 + .22*(dbz-p.cu_signal)/(p.tcu_watch-p.cu_signal);
      if (dbz < p.tcu_likely) return .48 + .18*(dbz-p.tcu_watch)/(p.tcu_likely-p.tcu_watch);
      if (dbz < p.cb_likely) return .72 + .13*(dbz-p.tcu_likely)/(p.cb_likely-p.tcu_likely);
      return .94;
    }
    if (dbz < p.tcu_watch) return 0;
    if (dbz < p.tcu_likely) return .06 + .08*(dbz-p.tcu_watch)/(p.tcu_likely-p.tcu_watch);
    if (dbz < p.cb_likely) return .18 + .15*(dbz-p.tcu_likely)/(p.cb_likely-p.tcu_likely);
    if (dbz < p.cb_strong) return .58 + .22*(dbz-p.cb_likely)/(p.cb_strong-p.cb_likely);
    return .94;
  }

  function archivePriors(envScore) {
    const bin = historicalBin(envScore);
    const training = skill?.training || {};
    const enoughExplicit = (Number(training.explicit_tcu)||0) + (Number(training.explicit_cb)||0) >=
      Number(skill?.calibration?.minimum_explicit_labels_for_direct_use || 10);
    const deep = Number(bin?.deep_rate ?? skill?.calibration?.global_deep_rate);
    let tcu = Number(bin?.tcu_or_cb_rate ?? skill?.calibration?.global_tcu_or_cb_rate);
    let cb = Number(bin?.cb_rate ?? skill?.calibration?.global_cb_rate);
    if (!Number.isFinite(tcu) || (!enoughExplicit && tcu <= 0)) tcu = Number.isFinite(deep) ? deep * .70 : .06;
    if (!Number.isFinite(cb) || (!enoughExplicit && cb <= 0)) cb = Number.isFinite(deep) ? deep * .55 : .03;
    return {tcu:clampC(tcu), cb:clampC(cb), deep:Number.isFinite(deep)?clampC(deep):null, enoughExplicit, bin};
  }

  function probabilities(dbz, env, trendRate, lightningCount, source='cmax', horizon=0) {
    const p = priors();
    const hist = archivePriors(env.score);
    const sourceFactor = source === 'cmax' ? 1 : .55;
    const radarT = radarEvidence(dbz, 'tcu', p) * sourceFactor;
    const radarC = radarEvidence(dbz, 'cb', p) * sourceFactor;
    const trend = Number.isFinite(trendRate) ? clampC(trendRate / 20, -.18, .22) : 0;
    const lightning = lightningCount > 0 ? clampC(.38 + Math.log1p(lightningCount)*.10, 0, .72) : 0;
    const horizonDecay = Math.exp(-Math.max(0,horizon)/300);
    const envT = clampC(.08 + env.score*.58 + hist.tcu*.42);
    const envC = clampC(.03 + env.score*.46 + hist.cb*.44 + (hist.deep || 0)*.16);

    let tcu = 1 - (1-envT*.72) * (1-radarT*.82*horizonDecay);
    let cb = 1 - (1-envC*.62) * (1-radarC*.88*horizonDecay) * (1-lightning*.78*horizonDecay);
    tcu = clampC(tcu + trend*.30);
    cb = clampC(cb + trend*.22);

    if (source === 'cmax' && Number.isFinite(dbz)) {
      if (dbz >= p.tcu_likely) tcu = Math.max(tcu, .64);
      if (dbz >= p.cb_likely) cb = Math.max(cb, .54);
      if (dbz >= p.cb_strong) cb = Math.max(cb, .84);
    }
    if (lightningCount > 0) cb = Math.max(cb, .66);
    return {tcu:clampC(tcu)*100, cb:clampC(cb)*100, hist};
  }

  function pointDbz(nowcast) {
    const dom = asNumber('dbz');
    if (Number.isFinite(dom)) return dom;
    if (nowcast?.source === 'cmax' && Number.isFinite(Number(nowcast?.predictions?.[30]))) return Number(nowcast.predictions[30]);
    return null;
  }

  function futureDbz(nowcast, h, current) {
    if (nowcast?.source === 'cmax') {
      const x = Number(nowcast?.predictions?.[h]);
      if (Number.isFinite(x)) return x;
    }
    return Number.isFinite(current) ? current : null;
  }

  function classify(dbz, probs, lightningCount, source) {
    const p = priors();
    if (lightningCount > 0 || probs.cb >= 70 || (source === 'cmax' && Number.isFinite(dbz) && dbz >= p.cb_strong)) return 'Cb';
    if (probs.cb >= 50 && source === 'cmax' && Number.isFinite(dbz) && dbz >= p.cb_likely) return 'Cb?';
    if (probs.tcu >= 62 || (source === 'cmax' && Number.isFinite(dbz) && dbz >= p.tcu_likely)) return 'TCu';
    if (probs.tcu >= 38 || (source === 'cmax' && Number.isFinite(dbz) && dbz >= p.cu_signal)) return 'Cu → TCu?';
    return 'brak sygnału';
  }

  function etaText(nowcast, horizonResults) {
    const direct = Number(nowcast?.etaMin);
    if (Number.isFinite(direct) && direct >= 0 && direct <= 180) {
      return direct < 8 ? {main:'teraz', sub:'echo w bezpośrednim podejściu'} :
        {main:`~${Math.round(direct)} min`, sub:'ETA najbliższego echa POLRAD'};
    }
    const cb = horizonResults.find(x => x.cb >= 55);
    if (cb) return {main:`~${cb.h} min`, sub:'pierwszy horyzont z sygnałem Cb ≥55%'};
    const tcu = horizonResults.find(x => x.tcu >= 55);
    if (tcu) return {main:`~${tcu.h} min`, sub:'pierwszy horyzont z sygnałem TCu ≥55%'};
    return {main:'>3 h / brak', sub:'brak istotnego sygnału w 0–3 h'};
  }

  function calibrationText() {
    const t = skill?.training;
    if (!t) return 'Kalibracja historyczna: brak sekcji convection — używane są konserwatywne priory radarowe i bieżące NWP.';
    const from = t.from ? String(t.from).slice(0,10) : '—';
    const to = t.to ? String(t.to).slice(0,10) : '—';
    return `Kalibracja historyczna EPIR: ${Number(t.matched_samples||0).toLocaleString('pl-PL')} dopasowań model–METAR, ` +
      `TCU ${t.explicit_tcu||0}, CB ${t.explicit_cb||0}, TS ${t.ts||0}; ${from} → ${to}. ` +
      `Jakość etykiet: ${t.label_quality||'—'}. TS jest tylko etykietą pomocniczą głębokiej konwekcji, nie jest automatycznie zamieniane na CB.`;
  }

  async function refreshLightning() {
    if (runningLightning || !window.PrognozaEPIRLightning?.getPointsAround) return;
    const p = (typeof point !== 'undefined' && point) ? point : null;
    if (!p || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) return;
    runningLightning = true;
    try {
      const v = await window.PrognozaEPIRLightning.getPointsAround({lat:Number(p.lat),lon:Number(p.lon)}, 80);
      lastLightning = {count:Array.isArray(v?.points)?v.points.length:0,updatedAt:Number(v?.updatedAt)||Date.now(),available:true};
    } catch (_) {
      lastLightning = {...lastLightning, available:false};
    } finally {
      runningLightning = false;
      scheduleRender(20);
    }
  }

  function render(nowcast = window.PrognozaEPIRRadarNowcast || null) {
    if (!ensureCard()) return;
    const env = environment();
    const dbz = pointDbz(nowcast);
    const trendRate = Number(nowcast?.trend?.rate);
    const source = nowcast?.source || 'cmax';
    const lightningCount = lastLightning.available ? lastLightning.count : 0;
    const nowP = probabilities(dbz, env, trendRate, lightningCount, source, 0);
    const klass = classify(dbz, nowP, lightningCount, source);
    const horizons = HORIZONS.map(h => {
      const z = futureDbz(nowcast, h, dbz);
      const p = probabilities(z, env, trendRate, lightningCount, source, h);
      return {h,dbz:z,...p};
    });
    const eta = etaText(nowcast, horizons);

    $c('convClass').textContent = klass;
    $c('convClassSub').textContent = klass === 'Cb' ? 'silny sygnał głębokiej konwekcji' : klass.includes('TCu') ? 'rozwój pionowy prawdopodobny' : 'klasyfikacja probabilistyczna';
    $c('convTcu').textContent = fmtPct(nowP.tcu);
    $c('convCb').textContent = fmtPct(nowP.cb);
    $c('convTcuSub').textContent = 'radar + NWP + historia';
    $c('convCbSub').textContent = lastLightning.available ? 'radar + NWP + historia + MTG LI' : 'radar + NWP + historia';
    $c('convEta').textContent = eta.main;
    $c('convEtaSub').textContent = eta.sub;
    $c('convDbz').textContent = Number.isFinite(dbz) ? `~${Math.round(dbz)} dBZ` : (source === 'sri' ? 'SRI' : 'brak');
    $c('convDbzSub').textContent = source === 'cmax' ? 'CMAX/punkt + adwekcja POLRAD' : 'fallback SRI — mniejsza pewność klasy';
    $c('convTrend').textContent = Number.isFinite(trendRate) ? `${trendRate>=0?'+':''}${trendRate.toFixed(1)} dBZ/h` : (nowcast?.trend?.label || '—');
    $c('convTrendSub').textContent = nowcast?.trend?.label || 'historia ostatnich klatek';
    $c('convEnv').textContent = fmtPct(env.score*100);
    $c('convEnvSub').textContent = `CAPE ${env.cape??'—'} · LI ${env.li??'—'} · CIN ${env.cin??'—'} · GFS TS ${env.tp??'—'}%`;
    $c('convLightning').textContent = lastLightning.available ? String(lightningCount) : '—';
    $c('convLightningSub').textContent = lastLightning.available ? (lightningCount ? 'aktywny sygnał LI w 80 km' : 'brak sygnału LI w 80 km') : 'źródło chwilowo niedostępne';

    for (const x of horizons) {
      const e = $c(`convH${x.h}`);
      if (e) e.textContent = `TCu ${Math.round(x.tcu)}% · Cb ${Math.round(x.cb)}%`;
    }

    const p = priors();
    const strong = source === 'cmax' && Number.isFinite(dbz) && dbz >= p.cb_likely;
    const trendSentence = Number.isFinite(trendRate) ? (trendRate > 4 ? 'Echo wyraźnie się nasila.' : trendRate < -4 ? 'Echo słabnie.' : 'Intensywność echa jest względnie stabilna.') : 'Trend radarowy jest niepełny.';
    const lightningSentence = lastLightning.available ? (lightningCount ? `MTG LI wykrywa ${lightningCount} obszarów aktywności w promieniu 80 km.` : 'MTG LI nie wykrywa obecnie aktywności w promieniu 80 km.') : 'Brak świeżej analizy MTG LI.';
    $c('convSummary').textContent =
      `Aktualna ocena: ${klass}; TCu ${Math.round(nowP.tcu)}%, Cb ${Math.round(nowP.cb)}%. ` +
      `${strong ? 'CMAX przekracza próg operacyjny dla prawdopodobnego Cb. ' : ''}${trendSentence} ${lightningSentence} ` +
      `${eta.main !== '>3 h / brak' ? `Najbliższy istotny sygnał: ${eta.main}.` : 'W horyzoncie 0–3 h brak wyraźnego wejścia silnej komórki nad punkt.'}`;

    $c('convCalibration').textContent = calibrationText();
    $c('convThresholds').innerHTML = [
      `<span>20–29 dBZ: Cu/TCu watch</span>`,
      `<span>30–34 dBZ: TCu możliwe</span>`,
      `<span>35–39 dBZ: TCu prawdopodobne</span>`,
      `<span>40–49 dBZ: Cb prawdopodobne</span>`,
      `<span>≥50 dBZ: silny Cb</span>`
    ].join('');
    window.PrognozaEPIRConvectionNowcast = {
      updatedAt:new Date().toISOString(),class:klass,tcuProbability:nowP.tcu,cbProbability:nowP.cb,
      dbz,source,trendRate,environmentScore:env.score,lightning:lastLightning,eta,horizons,calibration:skill?.training||null
    };
    window.dispatchEvent(new CustomEvent('prognozaepir:convection-nowcast-updated',{detail:window.PrognozaEPIRConvectionNowcast}));
  }

  function scheduleRender(ms=100) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => render(), ms);
  }

  async function loadSkill() {
    try {
      const r = await fetch('data/learning/cloud-skill.json', {cache:'no-cache'});
      if (!r.ok) throw new Error('HTTP '+r.status);
      const j = await r.json();
      skill = j?.convection || null;
    } catch (_) {
      skill = null;
    }
    scheduleRender(20);
  }

  ensureCard();
  loadSkill();
  setTimeout(() => { refreshLightning(); scheduleRender(50); }, 2200);
  window.addEventListener('prognozaepir:radar-nowcast-updated', e => {
    render(e.detail);
    refreshLightning();
  });
  window.addEventListener('prognozaepir:lightning-analysis', e => {
    const d=e.detail;
    lastLightning={count:Array.isArray(d?.points)?d.points.length:0,updatedAt:Number(d?.updatedAt)||Date.now(),available:true};
    scheduleRender(20);
  });
  for (const id of ['apply','resetPoint','refresh']) $c(id)?.addEventListener('click', () => {
    lastLightning={count:0,updatedAt:0,available:false};
    setTimeout(() => { refreshLightning(); scheduleRender(50); }, 900);
  });
  setInterval(() => { if (!document.hidden) { refreshLightning(); scheduleRender(20); } }, 5*60*1000);
})();
