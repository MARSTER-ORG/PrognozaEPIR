'use strict';
(() => {
  // RADAR UI only: compact 11-step CMAX legend. The underlying CMAX decoder
  // keeps the full POLRAD palette so point values remain as accurate as before.
  const LEGEND_11 = [
    ['≥59', '#f58cff'],
    ['53–58', '#ff19cc'],
    ['47–52', '#e60059'],
    ['41–46', '#ff1600'],
    ['35–40', '#ff8800'],
    ['29–34', '#fff200'],
    ['23–28', '#fffbd8'],
    ['17–22', '#b8f4f1'],
    ['11–16', '#1bc8f0'],
    ['5–10', '#0033e8'],
    ['0–4', '#0000aa']
  ];

  const style = document.createElement('style');
  style.id = 'epirLegend11Style';
  style.textContent = `
    .legend-dbz{display:inline-block!important;width:max-content!important;min-width:0!important;max-width:calc(100vw - 24px)!important;box-sizing:border-box!important;font-size:7px!important;line-height:1.05!important;padding:4px 5px!important;max-height:none!important;overflow:visible!important}
    .legend-dbz>b{display:block;width:max-content!important;font-size:8px!important;margin-bottom:3px!important}
    .legend-dbz .dbz-grid{display:inline-grid!important;width:max-content!important;grid-template-columns:max-content!important;gap:1px!important}
    .legend-dbz .dbz-row{display:flex!important;width:max-content!important;align-items:center!important;gap:3px!important;white-space:nowrap!important;margin:0!important}
    .legend-dbz .sw{width:11px!important;height:6px!important;flex:0 0 11px!important;margin:0!important}
    @media(max-width:560px){.legend-dbz{font-size:6.5px!important;padding:3px 4px!important;min-width:0!important}.legend-dbz>b{font-size:7px!important}}
  `;
  document.head.appendChild(style);

  function renderLegend11(){
    const legend = document.querySelector('.legend-dbz');
    if (!legend) return;
    legend.dataset.fullScale = '1';
    legend.dataset.steps = '11';
    legend.innerHTML = '<b>POLRAD dBZ</b><div class="dbz-grid">' + LEGEND_11.map(([label,color]) =>
      '<div class="dbz-row"><span class="sw" style="background:'+color+'"></span><span>'+label+'</span></div>'
    ).join('') + '</div>';
  }

  renderLegend11();
  setTimeout(renderLegend11,250);
  setTimeout(renderLegend11,800);
  setTimeout(renderLegend11,1600);
  window.PrognozaEPIRLegend11 = {render:renderLegend11,steps:LEGEND_11.slice()};
})();

// Optional country-border reference layer -----------------------------------
(() => {
  if (window.__epirCountryBordersInstalled) return;
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const mapbar = document.querySelector('.mapbar');
  if (!mapbar) return;
  window.__epirCountryBordersInstalled = true;

  const STORAGE_KEY = 'prognozaepir-country-borders';
  const PANE = 'countryBordersPane';
  const TILE_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

  if (!map.getPane(PANE)) {
    map.createPane(PANE);
    const pane = map.getPane(PANE);
    pane.style.zIndex = '650';
    pane.style.pointerEvents = 'none';
  }

  const layer = L.tileLayer(TILE_URL, {
    pane: PANE,
    opacity: 0.86,
    maxZoom: 19,
    keepBuffer: 3,
    updateWhenIdle: true,
    attribution: 'Granice: Esri, HERE, Garmin, © OpenStreetMap contributors, GIS community'
  });

  const btn = document.createElement('button');
  btn.id = 'countryBordersToggle';
  btn.type = 'button';
  btn.textContent = 'Granice państw';
  btn.title = 'Włącz lub wyłącz warstwę granic państw';
  btn.setAttribute('aria-pressed','false');

  const anchor = document.getElementById('satToggle') || document.getElementById('radarToggle');
  if (anchor) anchor.insertAdjacentElement('afterend',btn);
  else mapbar.prepend(btn);

  function store(enabled){
    try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (_) {}
  }

  function setEnabled(enabled,{persist=true}={}){
    const on = !!enabled;
    try {
      if (on) {
        if (!map.hasLayer(layer)) layer.addTo(map);
      } else if (map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
    } catch (_) {}
    btn.classList.toggle('active',on);
    btn.setAttribute('aria-pressed',on?'true':'false');
    if (persist) store(on);
  }

  btn.addEventListener('click',()=>setEnabled(!btn.classList.contains('active')));

  let initial = false;
  try { initial = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}
  setEnabled(initial,{persist:false});

  window.PrognozaEPIRCountryBorders = Object.freeze({
    layer,
    enable:()=>setEnabled(true),
    disable:()=>setEnabled(false),
    toggle:()=>setEnabled(!btn.classList.contains('active')),
    isEnabled:()=>btn.classList.contains('active')
  });
})();
