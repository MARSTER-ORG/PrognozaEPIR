'use strict';
(() => {
  if (!/\/radar\.html$/i.test(location.pathname)) return;
  if (window.__epirOperaConvectionBridgeLoaded) return;
  window.__epirOperaConvectionBridgeLoaded = true;

  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;

  function fmtUtc(ms) {
    if (!finite(Number(ms))) return '—';
    const d = new Date(Number(ms));
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  }

  function ensureBox() {
    const card = $('convectionNowcastCard');
    if (!card) return null;
    let box = $('convOperaSupport');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'convOperaSupport';
    box.className = 'conv-cal';
    box.style.marginTop = '6px';
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
    const etaAt = etaMin !== null && finite(Number(opera.frameEnd))
      ? Number(opera.frameEnd) + etaMin * 60000
      : null;
    const maxDbz = Number(opera?.latest?.max);

    return {
      updatedAt: new Date().toISOString(),
      source: 'OPERA CIRRUS DBZH',
      primaryRadar: 'POLRAD',
      probabilitiesAdjusted: false,
      reason: 'OPERA jest niezależnym potwierdzeniem radarowym; bez kalibracji historycznej nie zmienia procentów TCu/Cb.',
      supportLevel: fusion.convectiveSupport || 'brak',
      vectorAgreement: !!fusion.vectorAgree,
      directionDifferenceDeg: finite(Number(fusion.dirDiffDeg)) ? Number(fusion.dirDiffDeg) : null,
      speedDifferenceKmh: finite(Number(fusion.speedDiffKmh)) ? Number(fusion.speedDiffKmh) : null,
      polradSignal: !!fusion.polradSignal,
      operaSignal: !!fusion.operaSignal,
      operaMaxDbz: finite(maxDbz) ? maxDbz : null,
      etaMin,
      etaAt,
      trend: opera?.trend?.label || null,
      predictions: {...(opera.predictions || {})},
      baseTcuProbability: Number(conv.tcuProbability),
      baseCbProbability: Number(conv.cbProbability)
    };
  }

  function render() {
    const box = ensureBox();
    if (!box) return;

    const opera = window.PrognozaEPIROperaNowcast;
    if (opera?.error) {
      box.innerHTML = '<b>OPERA CIRRUS:</b> chwilowo niedostępna — klasyfikacja TCu/Cb pozostaje oparta na POLRAD + NWP.';
      return;
    }

    const e = buildEvidence();
    if (!e) {
      box.innerHTML = '<b>OPERA CIRRUS:</b> oczekiwanie na niezależną weryfikację sygnału POLRAD.';
      return;
    }

    window.PrognozaEPIRConvectionRadarEvidence = e;
    window.dispatchEvent(new CustomEvent('prognozaepir:convection-radar-evidence-updated', {detail:e}));

    let lead;
    if (!e.polradSignal) {
      lead = 'brak istotnego sygnału POLRAD wymagającego potwierdzenia';
    } else if (e.operaSignal && e.vectorAgreement) {
      lead = 'potwierdza sygnał POLRAD oraz kierunek/prędkość przemieszczania';
    } else if (e.operaSignal) {
      lead = 'potwierdza echo, ale wektory ruchu nie są jeszcze dostatecznie zgodne';
    } else {
      lead = 'nie potwierdza obecnie silnego echa z POLRAD';
    }

    const parts = [`<b>OPERA CIRRUS:</b> ${lead}.`];
    if (e.operaMaxDbz !== null) parts.push(`Maks. ${Math.round(e.operaMaxDbz)} dBZ.`);
    if (e.etaMin !== null) parts.push(`ETA ≤30 km: ok. ${Math.round(e.etaMin)} min (${fmtUtc(e.etaAt)}).`);
    if (e.trend) parts.push(`Trend: ${e.trend}.`);
    parts.push('Procenty TCu/Cb nie są tu podbijane — OPERA pozostaje niezależnym dowodem weryfikacyjnym do czasu kalibracji historycznej.');
    box.innerHTML = parts.join(' ');
  }

  let timer = 0;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 30);
  }

  window.addEventListener('prognozaepir:radar-fusion-updated', schedule);
  window.addEventListener('prognozaepir:convection-nowcast-updated', schedule);
  window.addEventListener('prognozaepir:opera-nowcast-updated', schedule);

  schedule();
  setTimeout(schedule, 1200);
  setTimeout(schedule, 3500);

  window.PrognozaEPIROperaConvectionBridge = {
    refresh: render,
    get: () => window.PrognozaEPIRConvectionRadarEvidence || null
  };
})();
