'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const byId = id => document.getElementById(id);
  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.3';

  const mapbar = document.querySelector('.mapbar');
  if (!mapbar) return;

  // Hide the older experimental MTG LI control if it exists. This module owns
  // the lightning layer so there is only one clear control on mobile.
  const oldLi = byId('mtgLiToggle');
  if (oldLi) oldLi.style.display = 'none';

  if (!map.getPane('lightningPane')) {
    map.createPane('lightningPane');
    const pane = map.getPane('lightningPane');
    pane.style.zIndex = '650';
    pane.style.pointerEvents = 'none';
  }

  const wmsUrl = 'https://view.eumetsat.int/geoserver/wms';
  const lightningLayer = L.tileLayer.wms(wmsUrl, {
    layers: 'mtg_fd:li_afa',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.96,
    pane: 'lightningPane',
    attribution: 'EUMETSAT MTG Lightning Imager'
  });

  let button = byId('lightningToggle');
  if (!button) {
    button = document.createElement('button');
    button.id = 'lightningToggle';
    button.type = 'button';
    button.textContent = '⚡ Wyładowania';
    button.title = 'EUMETSAT MTG Lightning Imager — najnowsza 5-minutowa akumulacja wyładowań';
    const before = byId('hazardsToggle') || byId('playRadar') || null;
    before ? mapbar.insertBefore(button, before) : mapbar.appendChild(button);
  }

  let status = byId('lightningStatus');
  if (!status) {
    status = document.createElement('div');
    status.id = 'lightningStatus';
    status.className = 'polrad-note';
    status.style.display = 'none';
    const polradStatus = byId('polradStatus');
    if (polradStatus) polradStatus.insertAdjacentElement('afterend', status);
    else mapbar.insertAdjacentElement('afterend', status);
  }

  const setStatus = (text, show = true) => {
    if (!status) return;
    status.textContent = text;
    status.style.display = show ? 'block' : 'none';
  };

  const fmtNow = () => new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());

  lightningLayer.on('loading', () => {
    if (map.hasLayer(lightningLayer)) setStatus('Wyładowania: pobieranie najnowszej warstwy EUMETSAT MTG LI…');
  });
  lightningLayer.on('load', () => {
    if (map.hasLayer(lightningLayer)) {
      setStatus('Wyładowania: EUMETSAT MTG LI AFA · najnowsza dostępna akumulacja 5 min · odświeżono ' + fmtNow() + '.');
    }
  });
  lightningLayer.on('tileerror', () => {
    if (map.hasLayer(lightningLayer)) setStatus('Wyładowania: chwilowy błąd pobierania warstwy EUMETSAT MTG LI.');
  });

  button.addEventListener('click', () => {
    const active = !map.hasLayer(lightningLayer);
    button.classList.toggle('active', active);
    if (active) {
      lightningLayer.addTo(map);
      setStatus('Wyładowania: pobieranie najnowszej 5-minutowej akumulacji MTG Lightning Imager…');
    } else {
      map.removeLayer(lightningLayer);
      setStatus('', false);
    }
  });

  // Re-request the latest WMS tiles periodically while the layer is visible.
  // EUMETView serves the most recent available image when TIME is omitted.
  setInterval(() => {
    if (map.hasLayer(lightningLayer)) lightningLayer.redraw();
  }, 60000);

  const sources = document.querySelector('.sources');
  if (sources && !byId('srcLightningLive')) {
    const row = document.createElement('div');
    row.innerHTML = '<span id="srcLightningLive" class="dot ok"></span>Wyładowania: EUMETSAT MTG Lightning Imager (LI AFA, akumulacja 5 min)';
    sources.prepend(row);
  }
})();
