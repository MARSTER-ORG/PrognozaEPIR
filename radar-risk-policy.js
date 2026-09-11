/* PrognozaEPIR — radar risk display policy.
 * The four radar/model risk values are heuristic scores, not calibrated
 * probabilities. To avoid visually amplifying weak/noisy signals, the colored
 * risk bar is drawn only from 40/100 upward. The underlying calculations and
 * numeric values are left unchanged.
 */
(() => {
  'use strict';

  if (!/\/radar\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_RADAR_RISK_POLICY__) return;
  window.__PROGNOZA_EPIR_RADAR_RISK_POLICY__ = true;

  const MIN_BAR_SCORE = 40;
  const RISK_IDS = ['storm', 'hail', 'rain', 'wind'];
  const observers = [];

  function scoreFrom(el) {
    const match = String(el?.textContent || '').match(/-?\d+(?:[.,]\d+)?/);
    if (!match) return NaN;
    return Number(match[0].replace(',', '.'));
  }

  function applyRiskBar(id) {
    const valueEl = document.getElementById(id + 'Risk');
    const barEl = document.getElementById(id + 'Bar');
    if (!valueEl || !barEl) return;

    const score = scoreFrom(valueEl);
    if (!Number.isFinite(score)) return;

    const draw = score >= MIN_BAR_SCORE;
    barEl.style.width = draw ? Math.max(0, Math.min(99, Math.round(score))) + '%' : '0%';
    barEl.dataset.drawn = draw ? '1' : '0';
    barEl.dataset.minScore = String(MIN_BAR_SCORE);
  }

  function applyAll() {
    RISK_IDS.forEach(applyRiskBar);
  }

  function install() {
    applyAll();
    if (typeof MutationObserver !== 'function') return;

    for (const id of RISK_IDS) {
      const valueEl = document.getElementById(id + 'Risk');
      if (!valueEl) continue;
      const observer = new MutationObserver(() => {
        // riskSet() writes the label and the width synchronously. Running in the
        // observer microtask guarantees this policy is the final visual step.
        applyRiskBar(id);
      });
      observer.observe(valueEl, { childList:true, characterData:true, subtree:true });
      observers.push(observer);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once:true });
  } else {
    install();
  }

  window.PrognozaRadarRiskPolicy = Object.freeze({
    minBarScore: MIN_BAR_SCORE,
    refresh: applyAll
  });
})();
