'use strict';

// EUMETSAT MTG Lightning Imager L2 Lightning Flashes (LFL).
// Uses actual flash positions/times from the central Railway collector.
// LI AFA is deliberately not used.
(() => {
  if (window.__PrognozaEPIRLightningLFLInstalled) return;
  window.__PrognozaEPIRLightningLFLInstalled = true;

  const ENDPOINT = 'https://central-ingestor-production.up.railway.app/data/lightning/latest.json';
  const REFRESH_MS = 5 * 60 * 1000;
  const MAX_AGE_MS = 22 * 60 * 1000;
  const MAP_WINDOW_MIN = 20;
  const PANEL_RADII = [10, 25, 50, 75, 100];
  const $ = id => document.getElementById(id);
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number(v) || 0));
  const toRad = d => d * Math.PI / 180;

  let features = null;
  let loading = false;
  let lastFetch = 0;
  let overlayActive = false;
  let overlayLayer = null;
  let legendControl = null;

  function hav(a, b) {
    const R = 6371.0088;
    const p1 = toRad(Number(a.lat)), p2 = toRad(Number(b.lat));
    const dp = toRad(Number(b.lat) - Number(a.lat));
    const dl = toRad(Number(b.lon ?? b.lng) - Number(a.lon ?? a.lng));
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function selectedPoint() {
    if (typeof point !== 'undefined' && Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon))) {
      return {lat: Number(point.lat), lon: Number(point.lon)};
    }
    const lat = Number(String($('lat')?.value || '').replace(',', '.'));
    const lon = Number(String($('lon')?.value || '').replace(',', '.'));
    return {lat: Number.isFinite(lat) ? lat : 52.8275, lon: Number.isFinite(lon) ? lon : 18.3175};
  }

  function ageMinutes(p) {
    const t = Date.parse(p?.time || '');
    if (Number.isFinite(t)) return Math.max(0, (Date.now() - t) / 60000);
    const a = Number(p?.age_min);
    return Number.isFinite(a) ? Math.max(0, a) : Infinity;
  }

  function points() {
    return Array.isArray(features?.points)
      ? features.points.filter(p => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lon)))
      : [];
  }
  function recentPoints(maxAgeMin = MAP_WINDOW_MIN) { return points().filter(p => ageMinutes(p) <= maxAgeMin + .5); }
  function n(obj, key) { const v = Number(obj?.[String(key)]); return Number.isFinite(v) ? v : 0; }
  function freshness(f = features) {
    if (!f || f.status !== 'ok') return false;
    const stamp = Date.parse(f.source?.product_end || f.updated_at || '');
    return Number.isFinite(stamp) && Date.now() - stamp <= MAX_AGE_MS;
  }
  function formatUtc(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '—';
    return new Intl.DateTimeFormat('pl-PL', {timeZone:'UTC',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(d) + ' UTC';
  }

  function ensureStyle() {
    if ($('lflLightningStyle')) return;
    const style = document.createElement('style');
    style.id = 'lflLightningStyle';
    style.textContent = `
      .lfl-legend{background:rgba(12,17,24,.88);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:7px;padding:6px 8px;font:9px/1.35 system-ui,sans-serif;box-shadow:0 1px 5px rgba(0,0,0,.28)}
      .lfl-legend b{display:block;margin-bottom:3px}.lfl-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 3px 0 6px;vertical-align:-1px}.lfl-dot:first-of-type{margin-left:0}.lfl-d0{background:#fff;border:1px solid #ff2b2b}.lfl-d1{background:#ffd43b}.lfl-d2{background:#74c0fc}
      #lightningToggle.active,#stormMapLfl.active{box-shadow:inset 0 0 0 1px currentColor}
      .storm-lfl-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin-top:7px}.storm-lfl-meta>div{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:5px;text-align:center}.storm-lfl-meta b{display:block;font-size:10px}.storm-lfl-meta span{display:block;font-size:8px;color:var(--muted);margin-top:2px}.storm-source{margin-top:7px;font-size:8px;color:var(--muted);line-height:1.35}
      @media(max-width:650px){.storm-lfl-meta{grid-template-columns:repeat(3,minmax(78px,1fr));overflow-x:auto}}
    `;
    document.head.appendChild(style);
  }

  function ensureMapLayer() {
    if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return false;
    if (!overlayLayer) overlayLayer = L.layerGroup();
    return true;
  }
  function markerStyle(age) {
    if (age <= 5) return {radius:6,color:'#ff2b2b',weight:2,fillColor:'#ffffff',fillOpacity:.98};
    if (age <= 10) return {radius:5,color:'#ff922b',weight:1.5,fillColor:'#ffd43b',fillOpacity:.92};
    return {radius:4,color:'#1971c2',weight:1.2,fillColor:'#74c0fc',fillOpacity:.78};
  }
  function renderOverlay() {
    if (!ensureMapLayer()) return;
    overlayLayer.clearLayers();
    for (const p of recentPoints(MAP_WINDOW_MIN)) {
      const lat = Number(p.lat), lon = Number(p.lon), age = ageMinutes(p);
      const marker = L.circleMarker([lat, lon], markerStyle(age));
      const dist = Number(p.distance_km), quality = Number(p.filter_confidence);
      marker.bindPopup(`<b>Wyładowanie MTG LI LFL</b><br>${formatUtc(p.time)} · ${age.toFixed(1)} min temu${Number.isFinite(dist)?`<br>Odległość od EPIR: ${dist.toFixed(1)} km`:''}${Number.isFinite(quality)?`<br>Confidence: ${quality.toFixed(2)}`:''}<br><small>Źródło: EUMETSAT MTG Lightning Imager LFL</small>`);
      marker.addTo(overlayLayer);
    }
    if (overlayActive && !map.hasLayer(overlayLayer)) overlayLayer.addTo(map);
  }
  function ensureLegend() {
    if (!ensureMapLayer()) return;
    if (!legendControl) {
      legendControl = L.control({position:'bottomleft'});
      legendControl.onAdd = () => {
        const div = L.DomUtil.create('div','lfl-legend');
        div.innerHTML = '<b>MTG LI LFL · wyładowania</b><span class="lfl-dot lfl-d0"></span>0–5 min <span class="lfl-dot lfl-d1"></span>5–10 min <span class="lfl-dot lfl-d2"></span>10–20 min';
        L.DomEvent.disableClickPropagation(div); return div;
      };
    }
    try { legendControl.addTo(map); } catch (_) {}
  }
  function removeLegend() { if (legendControl && typeof map !== 'undefined' && map) try { legendControl.remove(); } catch (_) {} }
  function setOverlay(active) {
    if (!ensureMapLayer()) return false;
    overlayActive = Boolean(active);
    for (const b of [$('lightningToggle'), $('stormMapLfl')]) {
      if (!b) continue;
      b.classList.toggle('active', overlayActive);
      b.setAttribute('aria-pressed', overlayActive ? 'true' : 'false');
    }
    if ($('stormMapLfl')) $('stormMapLfl').textContent = overlayActive ? '⚡ Ukryj wyładowania na mapie' : '⚡ Pokaż wyładowania na mapie';
    if (overlayActive) { renderOverlay(); if (!map.hasLayer(overlayLayer)) overlayLayer.addTo(map); ensureLegend(); }
    else { try { if (map.hasLayer(overlayLayer)) map.removeLayer(overlayLayer); } catch (_) {} removeLegend(); }
    return overlayActive;
  }
  function toggleOverlay() { return setOverlay(!overlayActive); }
  function ensureMapButton() {
    if ($('lightningToggle')) return;
    const mapbar = document.querySelector('.mapbar'); if (!mapbar) return;
    const btn = document.createElement('button');
    btn.id='lightningToggle'; btn.type='button'; btn.textContent='⚡ Wyładowania LFL';
    btn.title='Pokaż rzeczywiste wyładowania EUMETSAT MTG LI LFL z ostatnich 20 minut'; btn.setAttribute('aria-pressed','false');
    btn.addEventListener('click',toggleOverlay);
    const cmax=$('polrad_cmax'); if(cmax)cmax.insertAdjacentElement('afterend',btn);else mapbar.appendChild(btn);
  }

  function countAround(center,radiusKm,maxAgeMin=20){return recentPoints(maxAgeMin).reduce((s,p)=>s+(hav(center,{lat:Number(p.lat),lon:Number(p.lon)})<=radiusKm?1:0),0);}
  function nearestAround(center,radiusKm=Infinity,maxAgeMin=20){let out=null;for(const p of recentPoints(maxAgeMin)){const d=hav(center,{lat:Number(p.lat),lon:Number(p.lon)});if(d>radiusKm)continue;if(!out||d<out.distanceKm)out={...p,distanceKm:d,ageMin:ageMinutes(p)};}return out;}

  function ensurePanel() {
    const card=$('stormHobbyCard'); if(!card||card.dataset.lflV2==='1')return Boolean(card);
    card.dataset.lflV2='1';
    card.innerHTML=`<h2>Aktywność wyładowań · MTG LI LFL</h2><div class="storm-hobby"><div id="lflStormMain" class="storm-main">Ładowanie danych LFL…</div><div id="lflStormDetails" class="storm-details">Rzeczywiste błyski MTG Lightning Imager. LI AFA nie jest używane.</div><div id="lflStormRadii" class="storm-radii">${PANEL_RADII.map(r=>`<div><b>${r} km</b><span>—</span></div>`).join('')}</div><div class="storm-lfl-meta"><div><b id="lfl5">—</b><span>80 km / 5 min</span></div><div><b id="lfl10">—</b><span>80 km / 10 min</span></div><div><b id="lfl20">—</b><span>80 km / 20 min</span></div></div><div class="storm-actions"><button id="stormRefreshLfl" class="primary" type="button">Odśwież LFL</button><button id="stormMapLfl" type="button" aria-pressed="false">⚡ Pokaż wyładowania na mapie</button><button id="stormBlitzLfl" type="button">Sprawdź Blitzortung LIVE</button></div><div id="lflStormSource" class="storm-source">Źródło: EUMETSAT MTG Lightning Imager L2 Lightning Flashes (LFL). Ocena hobbystyczna; nie jest ostrzeżeniem IMGW.</div></div>`;
    $('stormRefreshLfl')?.addEventListener('click',()=>load(true)); $('stormMapLfl')?.addEventListener('click',toggleOverlay); $('stormBlitzLfl')?.addEventListener('click',()=>window.PrognozaEPIRMapExtras?.showBlitzortung?.());
    setOverlay(overlayActive); renderPanel(); return true;
  }
  function panelLevel(nearest,total100){if(!total100)return'Brak wyładowań ≤100 km / 20 min';if(!nearest)return`${total100} wyładowań ≤100 km / 20 min`;if(nearest.distanceKm<=10)return'Wyładowania bardzo blisko';if(nearest.distanceKm<=25)return'Wyładowania blisko';if(nearest.distanceKm<=50)return'Aktywność burzowa w pobliżu';if(nearest.distanceKm<=75)return'Aktywność burzowa w regionie';return'Wyładowania w promieniu 100 km';}
  function renderPanel() {
    if(!ensurePanel())return;const main=$('lflStormMain'),details=$('lflStormDetails'),source=$('lflStormSource');if(!main||!details)return;
    const cells=$('lflStormRadii')?.children;
    if(!features){main.textContent='Ładowanie danych MTG LI LFL…';details.textContent='Oczekiwanie na centralny kolektor wyładowań.';return;}
    if(features.status==='disabled'){main.textContent='Kolektor LFL nieaktywny';details.textContent=features.reason||'Brak konfiguracji kolektora.';return;}
    if(features.status!=='ok'){main.textContent=features.status==='stale'?'Dane MTG LI LFL są nieświeże':'Dane MTG LI LFL chwilowo niedostępne';details.textContent=`${features.reason||'Kolektor nie zwrócił aktualnych danych.'} Dane nie wpływają na ocenę Cb.`;return;}
    const center=selectedPoint(),counts=PANEL_RADII.map(r=>countAround(center,r,20)),nearest=nearestAround(center,100,20);
    counts.forEach((v,i)=>{if(cells?.[i])cells[i].querySelector('span').textContent=`${v} bł.`;}); main.textContent=panelLevel(nearest,counts.at(-1)||0);
    const base=features.point||{lat:52.8275,lon:18.3175},isEpir=hav(center,{lat:Number(base.lat),lon:Number(base.lon)})<2,tc=features.time_counts_80km||{};
    if($('lfl5'))$('lfl5').textContent=isEpir?String(n(tc,5)):'—';if($('lfl10'))$('lfl10').textContent=isEpir?String(n(tc,10)):'—';if($('lfl20'))$('lfl20').textContent=isEpir?String(n(tc,20)):'—';
    const nearText=nearest?`Najbliższy błysk: ${nearest.distanceKm<10?nearest.distanceKm.toFixed(1):nearest.distanceKm.toFixed(0)} km · ${nearest.ageMin.toFixed(1)} min temu.`:'W ostatnich 20 minutach nie zarejestrowano błysków w promieniu 100 km.';
    const tr=features.trend_80km,trendText=isEpir&&tr?` Trend 80 km: ${tr.label||'—'} (${Number(tr.current_10min)||0} vs ${Number(tr.previous_10min)||0}).`:'';details.textContent=`${nearText}${trendText} Odczyt kolektora: ${formatUtc(features.updated_at)}.`;
    if(source)source.textContent=`Źródło: EUMETSAT MTG Lightning Imager L2 Lightning Flashes (LFL) · ${recentPoints(20).length} punktów ≤20 min w buforze lokalnym · bez LI AFA. Ocena hobbystyczna; nie jest ostrzeżeniem IMGW.`;
  }
  function ensurePanelObserver(){ensurePanel();const obs=new MutationObserver(()=>ensurePanel());obs.observe(document.body,{childList:true,subtree:true});setTimeout(()=>obs.disconnect(),12000);}

  function evidence(detail){if(!freshness(features))return{value:0,active:false};const r=features.radial_counts_20min||{},w=features.time_counts_80km||{},n20=n(r,20),n40=n(r,40),n80=n(r,80),n150=n(r,150),m5=n(w,5),m10=n(w,10),nearest=Number(features.nearest?.distance_km),dbz=Number(detail?.dbz),eta=Number(window.PrognozaEPIRRadarNowcast?.etaMin);let spatial=0;if(n20)spatial=.96*(1-Math.exp(-n20/2));else if(n40)spatial=.80*(1-Math.exp(-n40/3));else if(n80)spatial=.58*(1-Math.exp(-n80/5));else if(n150)spatial=.28*(1-Math.exp(-n150/8));const recent=Math.max(.62*(1-Math.exp(-m5/3)),.52*(1-Math.exp(-m10/5)));let trendBonus=0,tr=features.trend_80km;if(Number(tr?.delta)>0)trendBonus=Math.min(.14,Number(tr.delta)*.025);let radarSupport=Number.isFinite(dbz)?(dbz>=40?1:dbz>=35?.92:dbz>=30?.78:dbz>=20?.55:.30):.35;if(Number.isFinite(nearest)&&nearest<=20)radarSupport=Math.max(radarSupport,.75);const etaSupport=Number.isFinite(eta)&&eta>=0&&eta<=90?1:.82,value=clamp((Math.max(spatial,recent)+trendBonus)*radarSupport*etaSupport);return{value,active:true,n20,n40,n80,n150,m5,m10,nearest,trend:tr};}
  function boosted(base,e,weight=.68){const p=clamp(Number(base)/100);return clamp(1-(1-p)*(1-clamp(e)*weight))*100;}
  function ensureConvectionTile(){const grid=document.querySelector('#convectionNowcastCard .conv-grid');if(!grid||$('convLightning'))return;const tile=document.createElement('div');tile.className='conv-tile cb';tile.id='convLightningTile';tile.innerHTML='<small>Wyładowania · LI LFL</small><b id="convLightning">—</b><span id="convLightningSub">rzeczywiste błyski, bez AFA</span>';grid.appendChild(tile);}
  function updateConvectionTile(ev){ensureConvectionTile();const main=$('convLightning'),sub=$('convLightningSub');if(!main||!sub)return;if(!features){main.textContent='—';sub.textContent='oczekiwanie na kolektor LFL';return;}if(features.status!=='ok'||!freshness(features)){main.textContent=features.status==='ok'?'nieświeże':(features.status||'błąd');sub.textContent='LFL nie wpływa na P(Cb)';return;}main.textContent=`${ev?.m10??n(features.time_counts_80km,10)} / 10 min`;const near=Number(features.nearest?.distance_km);sub.textContent=`80 km: ${ev?.n80??n(features.radial_counts_20min,80)} / 20 min${Number.isFinite(near)?` · najbliższe ${near.toFixed(0)} km`:''}`;}
  function applyToConvection(detail){if(!detail||typeof detail!=='object')return;ensureConvectionTile();const ev=evidence(detail);updateConvectionTile(ev);if(!ev.active){detail.lightning={source:'MTG LI LFL',active:false,status:features?.status||'unavailable'};return;}if(!Number.isFinite(Number(detail.baseCbProbability)))detail.baseCbProbability=Number(detail.cbProbability)||0;const base=Number(detail.baseCbProbability)||0,adjusted=boosted(base,ev.value);detail.cbProbability=adjusted;detail.lightning={source:'MTG LI LFL',active:true,evidence:ev.value,baseCbProbability:base,boostPp:adjusted-base,features};if(Array.isArray(detail.horizons)){for(const h of detail.horizons){if(!Number.isFinite(Number(h.baseCb)))h.baseCb=Number(h.cb)||0;const decay=Math.exp(-Math.max(0,Number(h.h)||0)/180);h.cb=boosted(h.baseCb,ev.value*decay,.62);const el=$(`convH${h.h}`);if(el)el.textContent=`TCu ${Math.round(Number(h.tcu)||0)}% · Cb ${Math.round(h.cb)}%`;}}const dbz=Number(detail.dbz),near=Number(ev.nearest);let klass=detail.class;if(adjusted>=72&&(dbz>=35||(Number.isFinite(near)&&near<=20)))klass='Cb';else if(adjusted>=52&&(dbz>=30||(Number.isFinite(near)&&near<=40))&&klass!=='Cb')klass='Cb?';detail.class=klass;window.PrognozaEPIRConvectionNowcast=detail;if($('convCb'))$('convCb').textContent=`${Math.round(adjusted)}%`;if($('convCbSub'))$('convCbSub').textContent='POLRAD + NWP + historia + MTG LI LFL';if($('convClass'))$('convClass').textContent=klass;if($('convClassSub')&&klass==='Cb')$('convClassSub').textContent='radar + rzeczywiste błyski LFL potwierdzają głęboką konwekcję';const summary=$('convSummary');if(summary){const baseText=summary.dataset.lflBase||summary.textContent.replace(/ MTG LI LFL:.*$/,'');summary.dataset.lflBase=baseText;const nearText=Number.isFinite(near)?`, najbliższy błysk ~${Math.round(near)} km`:'',trend=ev.trend?.label?`, trend ${ev.trend.label}`:'',boost=adjusted-base;summary.textContent=`${baseText} MTG LI LFL: ${ev.m10} błysków/10 min w 80 km${nearText}${trend}; korekta Cb +${boost.toFixed(0)} pp.`;}}

  async function load(force=false){if(loading)return features;if(!force&&Date.now()-lastFetch<30000&&features)return features;loading=true;try{const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),10000),r=await fetch(`${ENDPOINT}?t=${Date.now()}`,{cache:'no-store',signal:ctrl.signal});clearTimeout(timer);if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(j?.schema!=='prognozaepir-lightning-features-v1')throw new Error('unexpected schema');features=j;lastFetch=Date.now();window.PrognozaEPIRLightningFeatures=features;renderOverlay();renderPanel();updateConvectionTile(evidence(window.PrognozaEPIRConvectionNowcast||{}));if(window.PrognozaEPIRConvectionNowcast)applyToConvection(window.PrognozaEPIRConvectionNowcast);window.dispatchEvent(new CustomEvent('prognozaepir:lightning-features-updated',{detail:features}));window.dispatchEvent(new CustomEvent('prognozaepir:lightning',{detail:features}));return features;}catch(err){features={schema:'prognozaepir-lightning-features-v1',status:'error',updated_at:new Date().toISOString(),reason:String(err)};window.PrognozaEPIRLightningFeatures=features;renderPanel();updateConvectionTile();return features;}finally{loading=false;}}
  function getPointsAround(center,radiusKm=100){const c=center&&Number.isFinite(Number(center.lat))&&Number.isFinite(Number(center.lon??center.lng))?{lat:Number(center.lat),lon:Number(center.lon??center.lng)}:selectedPoint(),list=recentPoints(MAP_WINDOW_MIN).map(p=>{const d=hav(c,{lat:Number(p.lat),lon:Number(p.lon)});return{lat:Number(p.lat),lon:Number(p.lon),lng:Number(p.lon),time:p.time,ageMin:ageMinutes(p),distanceKm:d,size:1};}).filter(p=>p.distanceKm<=Number(radiusKm));return Promise.resolve({points:list,updatedAt:Date.parse(features?.updated_at||'')||Date.now(),status:features?.status||'unavailable',source:'MTG LI LFL'});}

  window.PrognozaEPIRLightning={refresh:()=>load(true),toggle:toggleOverlay,setActive:setOverlay,isActive:()=>overlayActive,getLatest:()=>features,getPoints:()=>recentPoints(MAP_WINDOW_MIN).slice(),getPointsAround};
  ensureStyle();ensureMapButton();ensurePanelObserver();setTimeout(()=>{ensureMapButton();ensurePanel();ensureConvectionTile();load(true);},700);setTimeout(()=>{ensureMapButton();ensurePanel();},1800);
  window.addEventListener('prognozaepir:convection-nowcast-updated',e=>applyToConvection(e.detail));window.addEventListener('prognozaepir:radar-nowcast-updated',()=>{if(Date.now()-lastFetch>60000)load();});for(const id of['apply','resetPoint','refresh'])$(id)?.addEventListener('click',()=>setTimeout(()=>{renderPanel();renderOverlay();load();},300));setInterval(()=>{if(!document.hidden)load(true);},REFRESH_MS);setInterval(()=>{if(!document.hidden){renderPanel();if(overlayActive)renderOverlay();}},60000);
})();
