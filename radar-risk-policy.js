/* PrognozaEPIR — radar risk policy v2.
 * Hail risk requires an actual convective signal. The freezing level is only
 * a modifier of an existing hail signal and can never create hail risk alone.
 * Colored risk bars are drawn only from 40/100 upward.
 */
(() => {
  'use strict';

  if (!/\/radar\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_RADAR_RISK_POLICY_V2__) return;
  window.__PROGNOZA_EPIR_RADAR_RISK_POLICY_V2__ = true;

  const MIN_BAR_SCORE = 40;
  const RISK_IDS = ['storm', 'hail', 'rain', 'wind'];
  const WATCH_IDS = ['dbz', 'cape', 'li', 'gfsStorm', 'rain', 'freezing', 'hailRisk', 'aiText'];
  const observers = [];
  let timer = null;
  let applying = false;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function firstNumber(value) {
    const match = String(value ?? '').match(/-?\d+(?:[.,]\d+)?/);
    return match ? Number(match[0].replace(',', '.')) : NaN;
  }

  function read(id, fallback = NaN) {
    const value = firstNumber(document.getElementById(id)?.textContent);
    return Number.isFinite(value) ? value : fallback;
  }

  function correctedHailScore() {
    const dbz = Math.max(0, read('dbz', 0));
    const cape = Math.max(0, read('cape', 0));
    const li = read('li', 0);
    const thunder = Math.max(0, read('gfsStorm', 0));
    const rain = Math.max(0, read('rain', 0));
    const freezing = read('freezing', NaN);

    // A favourable freezing level alone is not evidence of hail.
    // Require either a sufficiently strong radar echo or coherent model
    // evidence of active/developing convection first.
    const radarTrigger = dbz >= 40;
    const modelTrigger =
      (thunder >= 15 && cape >= 250) ||
      (cape >= 700 && li <= -1) ||
      (rain >= 0.5 && cape >= 400);

    if (!radarTrigger && !modelTrigger) return 0;

    let score = 0;

    // Radar is the strongest near-term hail signal available on this page.
    score += dbz >= 55 ? 45 : dbz >= 50 ? 32 : dbz >= 45 ? 18 : dbz >= 40 ? 7 : 0;

    // Thermodynamic/model support. These terms only operate after the gate.
    score += clamp((cape - 400) / 40, 0, 25);
    score += li <= -5 ? 12 : li <= -3 ? 8 : li <= -1 ? 4 : 0;
    score += clamp((thunder - 15) * 0.25, 0, 15);
    score += rain >= 2 ? 8 : rain >= 0.5 ? 4 : 0;

    // Freezing level changes hail favourability but never adds a standalone
    // score. Unknown freezing level leaves the score unchanged.
    if (Number.isFinite(freezing) && freezing > 0) {
      if (freezing >= 1800 && freezing <= 3600) score *= 1.15;
      else if (freezing >= 1200 && freezing <= 4500) score *= 1.05;
      else score *= 0.90;
    }

    return clamp(Math.round(score), 0, 95);
  }

  function scoreFrom(el) {
    const value = firstNumber(el?.textContent);
    return Number.isFinite(value) ? value : NaN;
  }

  function applyRiskBar(id) {
    const valueEl = document.getElementById(id + 'Risk');
    const barEl = document.getElementById(id + 'Bar');
    if (!valueEl || !barEl) return;

    const score = scoreFrom(valueEl);
    if (!Number.isFinite(score)) return;

    const draw = score >= MIN_BAR_SCORE;
    barEl.style.width = draw ? clamp(Math.round(score), 0, 99) + '%' : '0%';
    barEl.dataset.drawn = draw ? '1' : '0';
    barEl.dataset.minScore = String(MIN_BAR_SCORE);
  }

  function patchAiHail(score) {
    const ai = document.getElementById('aiText');
    if (!ai) return;
    const before = ai.innerHTML;
    const after = before.replace(
      /(grad\s*<b>)(\d+)(%<\/b>)/i,
      (_match, prefix, _oldScore, suffix) => `${prefix}${score}${suffix}`
    );
    if (after !== before) ai.innerHTML = after;
  }

  function applyAll() {
    if (applying) return;
    applying = true;
    try {
      const hail = correctedHailScore();
      const hailValue = document.getElementById('hailRisk');
      if (hailValue && hailValue.textContent !== hail + '%') hailValue.textContent = hail + '%';

      patchAiHail(hail);
      RISK_IDS.forEach(applyRiskBar);

      const hailBar = document.getElementById('hailBar');
      if (hailBar) {
        hailBar.dataset.algorithm = 'hail-v2-gated';
        hailBar.title = hail === 0
          ? 'Brak wystarczającego sygnału konwekcyjnego; poziom 0°C sam nie tworzy ryzyka gradu.'
          : 'Grad: echo radarowe + CAPE/LI + indeks burzowy/opad; poziom 0°C tylko modyfikuje wynik.';
      }
    } finally {
      applying = false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(applyAll, 30);
  }

  function install() {
    applyAll();
    if (typeof MutationObserver !== 'function') return;

    for (const id of WATCH_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const observer = new MutationObserver(schedule);
      observer.observe(el, { childList: true, characterData: true, subtree: true });
      observers.push(observer);
    }

    for (const id of RISK_IDS) {
      const el = document.getElementById(id + 'Risk');
      if (!el || WATCH_IDS.includes(id + 'Risk')) continue;
      const observer = new MutationObserver(schedule);
      observer.observe(el, { childList: true, characterData: true, subtree: true });
      observers.push(observer);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }

  window.PrognozaRadarRiskPolicy = Object.freeze({
    version: 'hail-v2-gated',
    minBarScore: MIN_BAR_SCORE,
    hailScore: correctedHailScore,
    refresh: applyAll
  });
})();
