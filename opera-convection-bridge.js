'use strict';
(() => {
  if (!/\/radar\.html$/i.test(location.pathname)) return;
  if (window.__epirOperaConvectionBridgeLoaded) return;
  window.__epirOperaConvectionBridgeLoaded = true;

  // Transport shim: CloudFerro OPERA objects are not reliably readable with
  // browser CORS/Range on all mobile clients.  Rewrite only the strict DBZH
  // GeoTIFF object pattern to our read-only Railway range proxy.
  const OPERA_S3_PREFIX = 'https://s3.waw3-1.cloudferro.com/openradar-24h/';
  const OPERA_PROXY_PREFIX = 'https://central-ingestor-production.up.railway.app/opera/dbzh/';
  if (!window.__epirOperaFetchProxyInstalled) {
    const nativeFetch = window.fetch.bind(window);
    const rewriteOperaUrl = value => {
      const url = String(value || '');
      if (!url.startsWith(OPERA_S3_PREFIX)) return null;
      const m = url.match(/OPERA@(20\d{10})@0@DBZH\.tiff(?:[?#].*)?$/i);
      return m ? `${OPERA_PROXY_PREFIX}${m[1]}.tiff` : null;
    };
    window.fetch = function(input, init) {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const proxyUrl = rewriteOperaUrl(rawUrl);
      if (!proxyUrl) return nativeFetch(input, init);
      if (typeof Request !== 'undefined' && input instanceof Request) {
        const headers = new Headers(input.headers);
        if (init?.headers) new Headers(init.headers).forEach((v,k) => headers.set(k,v));
        return nativeFetch(proxyUrl, {
          method: input.method || 'GET',
          headers,
          mode: 'cors',
          credentials: 'omit',
          cache: init?.cache || input.cache,
          redirect: input.redirect,
          referrerPolicy: input.referrerPolicy,
          signal: init?.signal || input.signal
        });
      }
      return nativeFetch(proxyUrl, init);
    };
    window.__epirOperaFetchProxyInstalled = true;
  }

  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const risk = v => Number(v) >= 75 ? 'wysokie' : Number(v) >= 50 ? 'podwyższone' : 'niskie';

  function fmtUtc(ms) {
    if (!finite(Number(ms))) return '—';
    const d = new Date(Number(ms));
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  }

  function compactConvection() {
    const card = $('convectionNowcastCard');
    if (!card) return null;
    const heading = card.querySelector('h2');
    if (heading) heading.textContent = 'TCu / Cb · zagrożenie dla EPIR 0–3 h';

    const grid = card.querySelector('.conv-grid');
    if (!grid) return card;
    let details = $('convTechDetails');
    if (!details) {
      details = document.createElement('details');
      details.id = 'convTechDetails';
      details.className = 'conv-cal';
      details.innerHTML = '<summary style="cursor:pointer;font-weight:700">Szczegóły techniczne</summary><div id="convTechTiles" class="conv-grid" style="margin-top:6px"></div>';
      const summary = $('convSummary');
      if (summary?.parentElement) summary.insertAdjacentElement('afterend', details);
      else card.appendChild(details);
    }

    const keep = new Set(['Klasa aktualna','TCu','Cb','Czas / ETA']);
    const tech = $('convTechTiles');
    [...grid.querySelectorAll(':scope > .conv-tile')].forEach(tile => {
      const label = String(tile.querySelector('small')?.textContent || '').trim();
      if (!keep.has(label) && tech && tile.parentElement === grid) tech.appendChild(tile);
    });

    for (const selector of ['.conv-h','.conv-scope','#convCalibration','#convThresholds','.conv-foot']) {
      const el = card.querySelector(selector);
      if (el && el.parentElement !== details) details.appendChild(el);
    }

    if (!$('convCompactStyle')) {
      const style = document.createElement('style');
      style.id = 'convCompactStyle';
      style.textContent = `
        #convectionNowcastCard .conv-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important}
        #convectionNowcastCard .conv-tile{min-height:50px!important;padding:6px!important}
        #convectionNowcastCard .conv-tile b{font-size:13px!important}
        #convectionNowcastCard #convTechDetails{margin:6px 0 0!important;padding:6px 7px!important}
        #convectionNowcastCard #convTechDetails>.conv-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}
        #convectionNowcastCard #convTechDetails .conv-h{margin-top:7px!important}
        #convectionNowcastCard #convOperaSupport{font-size:9px!important;padding:6px 7px!important;line-height:1.35!important}
        @media(max-width:700px){#convectionNowcastCard .conv-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}#convectionNowcastCard #convTechDetails>.conv-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
      `;
      document.head.appendChild(style);
    }
    return card;
  }

  function simplifyPrimaryReadout() {
    const conv = window.PrognozaEPIRConvectionNowcast;
    if (!conv) return;
    const tcu = Number(conv.tcuProbability), cb = Number(conv.cbProbability);
    const noSignal = /brak/i.test(String(conv.class || '')) || (finite(tcu) && finite(cb) && Math.max(tcu,cb) < 30);
    const eta = $('convEta'), etaSub = $('convEtaSub');
    if (noSignal && eta) {
      eta.textContent = 'brak';
      if (etaSub) etaSub.textContent = 'brak istotnej komórki na torze do EPIR';
    }
    const tcuSub = $('convTcuSub'), cbSub = $('convCbSub');
    if (tcuSub && finite(tcu)) tcuSub.textContent = `${risk(tcu)} prawdopodobieństwo`;
    if (cbSub && finite(cb)) cbSub.textContent = `${risk(cb)} prawdopodobieństwo`;
  }

  function ensureBox() {
    const card = compactConvection();
    if (!card) return null;
    let box = $('convOperaSupport');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'convOperaSupport';
    box.className = 'conv-cal';
    const summary = $('convSummary');
    if (summary?.parentElement) summary.insertAdjacentElement('afterend', box);
    else card.appendChild(box);
    return box;
  }

  function buildEvidence() {
    const fusion = window.PrognozaEPIRRadarFusion;
    const opera = window.PrognozaEPIROperaNowcast;
    const conv = window.PrognozaEPIRConvectionNowcast;
    if (!fusion || !opera || opera.error || !conv) return null;
    const etaMin = finite(Number(opera.etaMin)) ? Number(opera.etaMin) : null;
    const etaAt = etaMin !== null && finite(Number(opera.frameEnd)) ? Number(opera.frameEnd) + etaMin * 60000 : null;
    const maxDbz = Number(opera?.latest?.max);
    return {
      updatedAt:new Date().toISOString(), source:'OPERA CIRRUS DBZH', primaryRadar:'POLRAD', probabilitiesAdjusted:false,
      supportLevel:fusion.convectiveSupport || 'brak', vectorAgreement:!!fusion.vectorAgree,
      directionDifferenceDeg:finite(Number(fusion.dirDiffDeg))?Number(fusion.dirDiffDeg):null,
      speedDifferenceKmh:finite(Number(fusion.speedDiffKmh))?Number(fusion.speedDiffKmh):null,
      polradSignal:!!fusion.polradSignal, operaSignal:!!fusion.operaSignal,
      operaMaxDbz:finite(maxDbz)?maxDbz:null, etaMin, etaAt, trend:opera?.trend?.label||null,
      predictions:{...(opera.predictions||{})}, baseTcuProbability:Number(conv.tcuProbability), baseCbProbability:Number(conv.cbProbability)
    };
  }

  function render() {
    compactConvection();
    simplifyPrimaryReadout();
    const box = ensureBox();
    if (!box) return;
    const opera = window.PrognozaEPIROperaNowcast;
    if (opera?.error) {
      box.innerHTML = '<b>OPERA:</b> niedostępna · wynik TCu/Cb nadal działa z POLRAD + NWP.';
      return;
    }
    const e = buildEvidence();
    if (!e) {
      box.innerHTML = '<b>OPERA:</b> oczekiwanie na europejskie potwierdzenie CMAX.';
      return;
    }
    window.PrognozaEPIRConvectionRadarEvidence = e;
    window.dispatchEvent(new CustomEvent('prognozaepir:convection-radar-evidence-updated',{detail:e}));

    let lead='brak sygnału do potwierdzenia';
    if(e.polradSignal&&e.operaSignal&&e.vectorAgreement)lead='potwierdza POLRAD';
    else if(e.polradSignal&&e.operaSignal)lead='częściowo potwierdza POLRAD';
    else if(e.polradSignal&&!e.operaSignal)lead='nie potwierdza silnego echa POLRAD';
    const parts=[`<b>OPERA:</b> ${lead}`];
    if(e.operaMaxDbz!==null)parts.push(`maks. ${Math.round(e.operaMaxDbz)} dBZ`);
    if(e.etaMin!==null)parts.push(`ETA ≤30 km: ${Math.round(e.etaMin)} min (${fmtUtc(e.etaAt)})`);
    if(e.trend)parts.push(`trend: ${e.trend}`);
    box.innerHTML=parts.join(' · ')+'.';
  }

  let timer=0;
  function schedule(){clearTimeout(timer);timer=setTimeout(render,30);}
  window.addEventListener('prognozaepir:radar-fusion-updated',schedule);
  window.addEventListener('prognozaepir:convection-nowcast-updated',schedule);
  window.addEventListener('prognozaepir:opera-nowcast-updated',schedule);
  schedule();setTimeout(schedule,800);setTimeout(schedule,2500);

  window.PrognozaEPIROperaConvectionBridge={refresh:render,get:()=>window.PrognozaEPIRConvectionRadarEvidence||null};
})();
